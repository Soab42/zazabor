//! Text with the PDF standard fonts (no font file embedded): WinAnsi encoding and widths. Text a
//! standard font can't show (Bangla, Chinese…) is refused, and the page places it as a picture.

use super::fonts_table::{HELVETICA, HELVETICA_BOLD, TIMES, TIMES_BOLD};
use lopdf::{Dictionary, Object};
use serde::Deserialize;

#[derive(Deserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Face {
    #[default]
    Helvetica,
    HelveticaBold,
    Times,
    TimesBold,
    Courier,
}

impl Face {
    pub fn base_font(self) -> &'static str {
        match self {
            Face::Helvetica => "Helvetica",
            Face::HelveticaBold => "Helvetica-Bold",
            Face::Times => "Times-Roman",
            Face::TimesBold => "Times-Bold",
            Face::Courier => "Courier",
        }
    }

    /// The font dictionary for a page's resources.
    pub fn dict(self) -> Object {
        let mut d = Dictionary::new();
        d.set("Type", "Font");
        d.set("Subtype", "Type1");
        d.set("BaseFont", self.base_font());
        d.set("Encoding", "WinAnsiEncoding");
        Object::Dictionary(d)
    }

    fn widths(self) -> Option<&'static [u16; 256]> {
        match self {
            Face::Helvetica => Some(&HELVETICA),
            Face::HelveticaBold => Some(&HELVETICA_BOLD),
            Face::Times => Some(&TIMES),
            Face::TimesBold => Some(&TIMES_BOLD),
            Face::Courier => None,
        }
    }

    /// The width of WinAnsi `bytes` at `size` points.
    pub fn width(self, bytes: &[u8], size: f32) -> f32 {
        let units: u32 = match self.widths() {
            Some(w) => bytes.iter().map(|&b| w[b as usize] as u32).sum(),
            None => 600 * bytes.len() as u32,
        };
        units as f32 * size / 1000.0
    }
}

/// The characters of Windows-1252 between 0x80 and 0x9F.
const CP1252_HIGH: [(char, u8); 27] = [
    ('€', 0x80), ('‚', 0x82), ('ƒ', 0x83), ('„', 0x84), ('…', 0x85), ('†', 0x86), ('‡', 0x87), ('ˆ', 0x88), ('‰', 0x89),
    ('Š', 0x8A), ('‹', 0x8B), ('Œ', 0x8C), ('Ž', 0x8E), ('‘', 0x91), ('’', 0x92), ('“', 0x93), ('”', 0x94), ('•', 0x95),
    ('–', 0x96), ('—', 0x97), ('˜', 0x98), ('™', 0x99), ('š', 0x9A), ('›', 0x9B), ('œ', 0x9C), ('ž', 0x9E), ('Ÿ', 0x9F),
];

/// `text` in WinAnsi (what the standard fonts show), or the first character they can't show.
pub fn win_ansi(text: &str) -> Result<Vec<u8>, char> {
    let mut out = Vec::with_capacity(text.len());
    for c in text.chars() {
        let code = c as u32;
        let byte = match code {
            0x20..=0x7E | 0xA0..=0xFF => code as u8,
            // Tabs show as a space.
            0x09 => b' ',
            _ => match CP1252_HIGH.iter().find(|(ch, _)| *ch == c) {
                Some((_, b)) => *b,
                None => return Err(c),
            },
        };
        out.push(byte);
    }
    Ok(out)
}

/// A PDF hex string of `bytes`, for content streams (no escaping to get wrong).
pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2 + 2);
    s.push('<');
    for b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s.push('>');
    s
}

/// The message for text a standard font can't show.
pub fn unsupported(c: char) -> String {
    format!("“{c}” can't be written with the standard PDF fonts.")
}
