//! Claude reads a statement Zazabor can't (a scan, a photo, an odd layout). Raw HTTPS to the
//! Messages API (there's no official Rust SDK): the statement goes as a PDF document, pictures or
//! its text, the answer comes back as JSON in a fixed shape (structured outputs), streamed so a
//! long statement doesn't time out. A declined request falls back server-side
//! (`fallbacks: "default"`); 429 and 5xx are retried, other errors are reported as they are.
//! The key is read in Rust and never reaches the page.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::build::{check, Row, Statement};
use super::parse;

pub const API: &str = "https://api.anthropic.com";
const VERSION: &str = "2026-10-21";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 64_000;
/// Attempts for a request that failed with 429, 5xx or a dropped connection.
const ATTEMPTS: u32 = 4;
/// The API takes PDFs up to 32 MB per request (base64 makes them a third larger).
const MAX_PDF: usize = 22 * 1024 * 1024;
/// Pictures larger than this, or than `MAX_SIDE`, are scaled down first.
const MAX_IMAGE: usize = 3_500_000;
const MAX_SIDE: u32 = 2400;

/// What Claude is given.
pub enum Input {
    Pdf(Vec<u8>),
    /// (media type, bytes) for each picture, in page order.
    Images(Vec<(String, Vec<u8>)>),
    /// The statement's text, line by line (cheaper than the PDF when it has text).
    Text(String),
}

/// Why reading failed, in words for the page.
#[derive(Debug, PartialEq)]
pub enum AiError {
    /// Worth trying again later (rate limit, overload, a dropped connection).
    Busy(String),
    /// The request itself was refused (bad key, too large, not allowed).
    Request(String),
    /// Claude declined to read it.
    Declined(String),
    /// The answer didn't fit in one reply.
    TooLong,
    /// The file isn't a statement, or couldn't be read.
    Unreadable(String),
    Cancelled,
}

impl AiError {
    pub fn text(&self) -> String {
        match self {
            AiError::Busy(m) => format!("Claude is busy right now ({m}). Try again in a minute."),
            AiError::Request(m) => m.clone(),
            AiError::Declined(m) => format!("Claude declined to read this file{}", if m.is_empty() { ".".into() } else { format!(": {m}") }),
            AiError::TooLong => "This statement is too long to read in one go. Split the PDF (Office → PDF → Organize → Split) and read the parts.".into(),
            AiError::Unreadable(m) => format!("Claude couldn't read a statement in this file{}", if m.is_empty() { ".".into() } else { format!(": {m}") }),
            AiError::Cancelled => "Stopped.".into(),
        }
    }
}

/// Text for a string that may be missing.
fn maybe_string(description: &str) -> Value {
    json!({ "anyOf": [{ "type": "string", "description": description }, { "type": "null" }] })
}

/// The shape of the answer.
pub fn schema() -> Value {
    let amount = "Digits with a decimal point and no thousands separators or currency, exactly as printed, e.g. \"125000.50\"";
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["readable", "notes", "bank", "accountLast4", "currency", "periodFrom", "periodTo", "openingBalance", "closingBalance", "transactions"],
        "properties": {
            "readable": { "type": "boolean", "description": "False when the file isn't a bank or wallet statement, or can't be read." },
            "notes": { "type": "string", "description": "Anything the reader should know: unreadable parts, why it isn't a statement. Empty when nothing." },
            "bank": maybe_string("The bank or wallet, as named on the statement"),
            "accountLast4": maybe_string("Only the last four digits of the account or wallet number"),
            "currency": { "type": "string", "description": "ISO code, e.g. BDT" },
            "periodFrom": maybe_string("First day of the statement period, YYYY-MM-DD"),
            "periodTo": maybe_string("Last day of the statement period, YYYY-MM-DD"),
            "openingBalance": maybe_string(amount),
            "closingBalance": maybe_string(amount),
            "transactions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["date", "description", "reference", "debit", "credit", "balance"],
                    "properties": {
                        "date": { "type": "string", "description": "YYYY-MM-DD" },
                        "description": { "type": "string", "description": "The narration as printed, on one line" },
                        "reference": maybe_string("Cheque, reference or transaction ID"),
                        "debit": maybe_string(amount),
                        "credit": maybe_string(amount),
                        "balance": maybe_string(amount)
                    }
                }
            }
        }
    })
}

const SYSTEM: &str = "You read bank and mobile-wallet statements (Bangladeshi banks, bKash, Nagad, Rocket and others) \
and copy their transactions into structured data for the account holder's own budgeting app. The app checks your copy \
against the statement's running balance and shows the person every row that doesn't follow, so a faithful copy matters \
more than a tidy one: amounts are copied digit for digit as printed, never computed, corrected or rounded.";

const TASK: &str = "Copy every transaction in this statement, in the order printed.\n\
- date: the transaction date as YYYY-MM-DD. Dates on these statements are day-first (05/10/2026 is 5 October) unless the statement clearly writes them otherwise.\n\
- description: the narration as printed, on one line (join wrapped lines).\n\
- reference: a cheque number, reference or transaction ID when the row has one, else null.\n\
- debit: money out of the account; credit: money in. One of them per row, the other null.\n\
- balance: the running balance printed on that row, or null.\n\
Opening balance, closing balance, brought/carried forward and total lines aren't transactions: put the opening and \
closing balances in openingBalance and closingBalance instead. For accountLast4 give only the last four digits of the \
account or wallet number, never the whole number. If this isn't a statement or can't be read, set readable to false \
and say why in notes.";

/// Standard base64, for the file in the request.
fn b64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The request body.
pub fn body(model: &str, input: &Input) -> Value {
    let mut content: Vec<Value> = Vec::new();
    match input {
        Input::Pdf(bytes) => content.push(json!({ "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": b64(bytes) } })),
        Input::Images(images) => {
            for (media, bytes) in images {
                content.push(json!({ "type": "image", "source": { "type": "base64", "media_type": media, "data": b64(bytes) } }));
            }
        }
        Input::Text(text) => content.push(json!({ "type": "text", "text": format!("<statement>\n{text}\n</statement>") })),
    }
    content.push(json!({ "type": "text", "text": TASK }));
    json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "stream": true,
        "fallbacks": "default",
        "system": SYSTEM,
        "output_config": { "effort": "medium", "format": { "type": "json_schema", "schema": schema() } },
        "messages": [{ "role": "user", "content": content }]
    })
}

/// A picture made small enough to send: JPEG under `MAX_SIDE` px a side.
pub fn prepare_image(media: &str, bytes: Vec<u8>) -> Result<(String, Vec<u8>), String> {
    let small = bytes.len() <= MAX_IMAGE && matches!(media, "image/jpeg" | "image/png" | "image/webp" | "image/gif");
    if small {
        if let Ok((w, h)) = image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format().map_err(|e| e.to_string()).and_then(|r| r.into_dimensions().map_err(|e| e.to_string())) {
            if w <= MAX_SIDE && h <= MAX_SIDE {
                return Ok((media.to_string(), bytes));
            }
        }
    }
    let img = image::load_from_memory(&bytes).map_err(|e| format!("Couldn't open the picture: {e}"))?;
    let img = if img.width().max(img.height()) > MAX_SIDE { img.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Lanczos3) } else { img };
    let mut out = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
    image::DynamicImage::ImageRgb8(img.to_rgb8()).write_with_encoder(encoder).map_err(|e| e.to_string())?;
    Ok(("image/jpeg".into(), out))
}

/// What came back, before it's turned into a statement.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub readable: bool,
    #[serde(default)]
    pub notes: String,
    pub bank: Option<String>,
    pub account_last4: Option<String>,
    #[serde(default)]
    pub currency: String,
    pub period_from: Option<String>,
    pub period_to: Option<String>,
    pub opening_balance: Option<String>,
    pub closing_balance: Option<String>,
    #[serde(default)]
    pub transactions: Vec<AnswerRow>,
}

#[derive(Deserialize, Debug)]
pub struct AnswerRow {
    pub date: String,
    pub description: String,
    pub reference: Option<String>,
    pub debit: Option<String>,
    pub credit: Option<String>,
    pub balance: Option<String>,
}

/// Claude's answer as a checked statement. Amounts are read the same way as a file's; a row whose
/// numbers can't be read is kept and flagged.
pub fn to_statement(answer: Answer, file: &str) -> Statement {
    let currency = {
        let c = answer.currency.trim().to_uppercase();
        if c.len() == 3 && c.chars().all(|ch| ch.is_ascii_alphabetic()) { c } else { "BDT".into() }
    };
    let amount = |v: &Option<String>| -> Option<i64> { v.as_deref().and_then(|t| parse::money(t, &currency)).map(|(m, s)| if s < 0 { -m } else { m }) };
    let unsigned = |v: &Option<String>| -> Option<i64> { v.as_deref().and_then(|t| parse::money(t, &currency)).map(|(m, _)| m).filter(|m| *m != 0) };
    let last4 = answer.account_last4.map(|a| a.chars().filter(|c| c.is_ascii_digit()).collect::<String>()).filter(|d| d.len() >= 4).map(|d| d[d.len() - 4..].to_string());
    let mut st = Statement {
        source: "ai".into(),
        file: file.into(),
        bank: answer.bank.filter(|b| !b.trim().is_empty()),
        account_last4: last4,
        currency: currency.clone(),
        period_from: answer.period_from.and_then(|d| parse::date(&d, "ymd")),
        period_to: answer.period_to.and_then(|d| parse::date(&d, "ymd")),
        opening: amount(&answer.opening_balance),
        closing: amount(&answer.closing_balance),
        ..Default::default()
    };
    for r in answer.transactions {
        let date = parse::date(&r.date, "ymd").unwrap_or_default();
        let mut row = Row {
            date: date.clone(),
            description: r.description.split_whitespace().collect::<Vec<_>>().join(" "),
            reference: r.reference.filter(|x| !x.trim().is_empty()),
            debit: unsigned(&r.debit),
            credit: unsigned(&r.credit),
            balance: amount(&r.balance),
            flag: None,
        };
        if date.is_empty() {
            row.flag = Some(format!("“{}” isn't a date", r.date));
        } else if row.debit.is_none() && row.credit.is_none() {
            row.flag = Some("No amount on this row".into());
        }
        st.rows.push(row);
    }
    if !answer.notes.trim().is_empty() {
        st.warnings.push(format!("Claude: {}", answer.notes.trim()));
    }
    st.confidence = if st.rows.is_empty() { "none".into() } else { "good".into() };
    check(&mut st);
    st
}

/// One request's outcome.
enum Attempt {
    Done(String),
    Retry(AiError, Option<Duration>),
    Fail(AiError),
}

/// Reads the server-sent events of a streamed reply: the text of the answer (what came after the
/// last fallback switch), or why it stopped.
pub struct Events {
    buffer: String,
    text: String,
    stop: Option<String>,
    stop_detail: String,
    error: Option<(String, String)>,
}

impl Events {
    pub fn new() -> Self {
        Events { buffer: String::new(), text: String::new(), stop: None, stop_detail: String::new(), error: None }
    }

    pub fn feed(&mut self, chunk: &str) {
        self.buffer.push_str(&chunk.replace("\r\n", "\n"));
        while let Some(end) = self.buffer.find("\n\n") {
            let block: String = self.buffer.drain(..end + 2).collect();
            let data: String = block.lines().filter_map(|l| l.strip_prefix("data:")).map(|d| d.trim_start()).collect::<Vec<_>>().join("\n");
            if data.is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(&data) else { continue };
            match event["type"].as_str().unwrap_or("") {
                "content_block_start" => {
                    // The model that declined wrote this far; its successor starts over.
                    if event["content_block"]["type"] == "fallback" {
                        self.text.clear();
                    }
                }
                "content_block_delta" => {
                    if event["delta"]["type"] == "text_delta" {
                        self.text.push_str(event["delta"]["text"].as_str().unwrap_or(""));
                    }
                }
                "message_delta" => {
                    if let Some(s) = event["delta"]["stop_reason"].as_str() {
                        self.stop = Some(s.to_string());
                    }
                    let details = &event["delta"]["stop_details"];
                    if !details.is_null() {
                        self.stop_detail = details["explanation"].as_str().or(details["category"].as_str()).unwrap_or("").to_string();
                    }
                }
                "error" => {
                    self.error = Some((event["error"]["type"].as_str().unwrap_or("error").to_string(), event["error"]["message"].as_str().unwrap_or("").to_string()));
                }
                _ => {}
            }
        }
    }

    pub fn chars(&self) -> usize {
        self.text.chars().count()
    }

    /// How the reply ended.
    fn outcome(self) -> Attempt {
        if let Some((kind, message)) = self.error {
            return if matches!(kind.as_str(), "overloaded_error" | "api_error" | "rate_limit_error") { Attempt::Retry(AiError::Busy(kind), None) } else { Attempt::Fail(AiError::Request(format!("Claude stopped with an error: {message}"))) };
        }
        match self.stop.as_deref() {
            Some("refusal") => Attempt::Fail(AiError::Declined(self.stop_detail)),
            Some("max_tokens") => Attempt::Fail(AiError::TooLong),
            Some(_) => Attempt::Done(self.text),
            None => Attempt::Retry(AiError::Busy("the reply was cut off".into()), None),
        }
    }
}

/// The error message in an API error reply.
fn error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"]["message"].as_str().map(str::to_string)).unwrap_or_else(|| body.chars().take(200).collect())
}

async fn attempt(client: &reqwest::Client, base: &str, key: &str, body: &Value, progress: &(dyn Fn(usize) + Sync), cancel: &AtomicBool) -> Attempt {
    let sent = client
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await;
    let mut response = match sent {
        Ok(r) => r,
        Err(e) if e.is_connect() || e.is_timeout() => return Attempt::Retry(AiError::Busy("no connection".into()), None),
        Err(e) => return Attempt::Fail(AiError::Request(format!("Couldn't reach Claude: {e}"))),
    };
    let status = response.status().as_u16();
    if status != 200 {
        let wait = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok()).map(Duration::from_secs);
        let text = response.text().await.unwrap_or_default();
        let message = error_message(&text);
        return match status {
            429 | 500 | 502 | 503 | 504 | 529 => Attempt::Retry(AiError::Busy(format!("HTTP {status}")), wait),
            401 => Attempt::Fail(AiError::Request("The API key was refused. Check it in Settings → AI.".into())),
            403 => Attempt::Fail(AiError::Request(format!("This API key isn't allowed to do that: {message}"))),
            413 => Attempt::Fail(AiError::Request("The file is too large to send to Claude.".into())),
            _ => Attempt::Fail(AiError::Request(format!("Claude refused the request ({status}): {message}"))),
        };
    }
    let mut events = Events::new();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Attempt::Fail(AiError::Cancelled);
        }
        match response.chunk().await {
            Ok(Some(bytes)) => {
                events.feed(&String::from_utf8_lossy(&bytes));
                progress(events.chars());
            }
            Ok(None) => break,
            Err(_) => return Attempt::Retry(AiError::Busy("the connection dropped".into()), None),
        }
    }
    events.outcome()
}

/// Sends the statement to Claude and returns its answer as a checked statement. `base` is the
/// API's address (a local stand-in in tests).
pub async fn extract(base: &str, key: &str, model: &str, input: Input, file: &str, progress: &(dyn Fn(usize) + Sync), cancel: &AtomicBool) -> Result<Statement, AiError> {
    if let Input::Pdf(bytes) = &input {
        if bytes.len() > MAX_PDF {
            return Err(AiError::Request("This PDF is larger than Claude takes (about 22 MB). Split it first.".into()));
        }
    }
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).read_timeout(Duration::from_secs(180)).build().map_err(|e| AiError::Request(e.to_string()))?;
    let body = body(model, &input);
    let mut last = AiError::Busy("no reply".into());
    for n in 0..ATTEMPTS {
        match attempt(&client, base, key, &body, progress, cancel).await {
            Attempt::Done(text) => {
                let answer: Answer = serde_json::from_str(text.trim()).map_err(|e| AiError::Unreadable(format!("the answer wasn't in the expected shape ({e})")))?;
                if !answer.readable {
                    return Err(AiError::Unreadable(answer.notes));
                }
                return Ok(to_statement(answer, file));
            }
            Attempt::Fail(e) => return Err(e),
            Attempt::Retry(e, wait) => {
                last = e;
                if n + 1 < ATTEMPTS {
                    let wait = wait.unwrap_or(Duration::from_millis(1500 * 2u64.pow(n))).min(Duration::from_secs(30));
                    tokio::time::sleep(wait).await;
                    if cancel.load(Ordering::SeqCst) {
                        return Err(AiError::Cancelled);
                    }
                }
            }
        }
    }
    Err(last)
}

/// A small request that shows the key works.
pub async fn ping(base: &str, key: &str, model: &str) -> Result<(), AiError> {
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).read_timeout(Duration::from_secs(120)).build().map_err(|e| AiError::Request(e.to_string()))?;
    let body = json!({
        "model": model,
        "max_tokens": 2048,
        "stream": true,
        "fallbacks": "default",
        "output_config": { "effort": "low" },
        "messages": [{ "role": "user", "content": "Reply with the single word OK." }]
    });
    let never = AtomicBool::new(false);
    for n in 0..2 {
        match attempt(&client, base, key, &body, &|_| {}, &never).await {
            Attempt::Done(_) => return Ok(()),
            Attempt::Fail(e) => return Err(e),
            Attempt::Retry(e, wait) => {
                if n == 1 {
                    return Err(e);
                }
                tokio::time::sleep(wait.unwrap_or(Duration::from_secs(2)).min(Duration::from_secs(10))).await;
            }
        }
    }
    Err(AiError::Busy("no reply".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// A stand-in for the API: answers each request with the next canned reply and keeps what it
    /// was sent.
    fn stand_in(replies: Vec<String>) -> (String, Arc<Mutex<Vec<(String, String)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (stream, reply) in listener.incoming().zip(replies) {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = String::new();
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(v) = line.to_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                    head.push_str(&line);
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                log.lock().unwrap().push((head, String::from_utf8(body).unwrap()));
                stream.write_all(reply.as_bytes()).unwrap();
            }
        });
        (base, seen)
    }

    fn sse(events: &[Value]) -> String {
        let body: String = events.iter().map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), e)).collect();
        format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
    }

    fn answer_json() -> String {
        json!({
            "readable": true, "notes": "", "bank": "The City Bank", "accountLast4": "9012", "currency": "BDT",
            "periodFrom": "2026-10-01", "periodTo": "2026-10-31", "openingBalance": "50000.00", "closingBalance": "134350.00",
            "transactions": [
                { "date": "2026-10-05", "description": "FOODPANDA*BD", "reference": null, "debit": "450.00", "credit": null, "balance": "49550.00" },
                { "date": "2026-10-06", "description": "RICKSHAW", "reference": null, "debit": "200.00", "credit": null, "balance": "49350.00" },
                { "date": "2026-10-25", "description": "SALARY OCT", "reference": "TRF991", "debit": null, "credit": "85000.00", "balance": "134350.00" }
            ]
        })
        .to_string()
    }

    fn streamed_answer() -> String {
        let text = answer_json();
        let (a, b) = text.split_at(text.len() / 2);
        sse(&[
            json!({"type": "message_start", "message": {"id": "msg_1", "model": "claude-opus-5-5"}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": a}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": b}}),
            json!({"type": "content_block_stop", "index": 1}),
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 300}}),
            json!({"type": "message_stop"}),
        ])
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn a_statement_is_read_after_a_rate_limit() {
        let busy = "HTTP/1.1 429 Too Many Requests\r\nretry-after: 0\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}".to_string();
        let (base, seen) = stand_in(vec![busy, streamed_answer()]);
        let never = AtomicBool::new(false);
        let chars = Mutex::new(0usize);
        let st = run(extract(&base, "sk-ant-test", "claude-opus-5-5", Input::Text("05/10/2026 FOODPANDA 450.00".into()), "city.pdf", &|n| *chars.lock().unwrap() = n, &never)).unwrap();
        assert_eq!(st.source, "ai");
        assert_eq!((st.bank.as_deref(), st.account_last4.as_deref()), (Some("The City Bank"), Some("9012")));
        assert_eq!(st.rows.len(), 3);
        assert_eq!(st.rows[2].credit, Some(8_500_000));
        assert_eq!(st.check.status, "ok", "{}", st.check.message);
        assert!(*chars.lock().unwrap() > 100);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "the 429 was retried once");
        let (head, body) = &seen[1];
        let head = head.to_lowercase();
        assert!(head.contains("x-api-key: sk-ant-test"));
        assert!(head.contains("anthropic-version: 2026-10-21"));
        assert!(head.contains("anthropic-beta: server-side-fallback-2026-07-01"));
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["stream"], true);
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert!(body.get("temperature").is_none() && body.get("thinking").is_none());
        assert_eq!(body["messages"][0]["content"][0]["type"], "text");
    }

    #[test]
    fn a_refusal_and_a_bad_request_are_reported_not_retried() {
        let refusal = sse(&[
            json!({"type": "message_start", "message": {"id": "msg_2"}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "refusal", "stop_details": {"type": "refusal", "category": null, "explanation": "policy"}}}),
            json!({"type": "message_stop"}),
        ]);
        let bad = "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: 74\r\nconnection: close\r\n\r\n{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"bad pdf\"}}".to_string();
        let (base, seen) = stand_in(vec![refusal, bad]);
        let never = AtomicBool::new(false);
        let first = run(extract(&base, "k", "claude-opus-5-5", Input::Pdf(b"%PDF-1.7".to_vec()), "x.pdf", &|_| {}, &never)).unwrap_err();
        assert_eq!(first, AiError::Declined("policy".into()));
        let second = run(extract(&base, "k", "claude-opus-5-5", Input::Pdf(b"%PDF-1.7".to_vec()), "x.pdf", &|_| {}, &never)).unwrap_err();
        assert!(matches!(&second, AiError::Request(m) if m.contains("bad pdf")), "{second:?}");
        assert_eq!(seen.lock().unwrap().len(), 2);
        let body: Value = serde_json::from_str(&seen.lock().unwrap()[0].1).unwrap();
        assert_eq!(body["messages"][0]["content"][0]["type"], "document");
        assert_eq!(body["messages"][0]["content"][0]["source"]["media_type"], "application/pdf");
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn text_after_a_fallback_switch_is_the_answer() {
        let mut e = Events::new();
        e.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"{\\\"partial\"}}\n\n");
        e.feed("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"fallback\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"text_delta\",\"text\":\"{}\"}}\n\n");
        e.feed("event: message_delta\r\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\r\n\r\n");
        assert!(matches!(e.outcome(), Attempt::Done(t) if t == "{}"));
        let unread = to_statement(serde_json::from_str::<Answer>(r#"{"readable":true,"notes":"","bank":null,"accountLast4":"01712345678","currency":"bdt","periodFrom":null,"periodTo":null,"openingBalance":null,"closingBalance":null,"transactions":[{"date":"bad","description":"x","reference":null,"debit":"10","credit":null,"balance":null}]}"#).unwrap(), "a.jpg");
        assert_eq!(unread.account_last4.as_deref(), Some("5678"));
        assert_eq!(unread.currency, "BDT");
        assert!(unread.rows[0].flag.as_deref().unwrap().contains("isn't a date"));
    }
}
