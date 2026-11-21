//! What a DhakaFlix folder or file name says: title, year, quality and tags. The server's names
//! follow a loose house style ("A House of Dynamite (2025) 1080p NF [Dual Audio]",
//! "18 Again (TV Series 2020) 720p [Dual Audio]", "001. The Godfather (1972) 1080p"), so this
//! reads them leniently and never fails: whatever can't be read is left out.

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Parsed {
    pub title: String,
    pub year: Option<i32>,
    pub quality: String,
    pub tags: Vec<String>,
    /// The IMDb rank of "001. The Shawshank Redemption (1994)".
    pub rank: Option<u32>,
    /// The name says "(TV Series …)" or the like.
    pub series: bool,
}

const VIDEO: [&str; 9] = ["mkv", "mp4", "avi", "m4v", "mov", "webm", "ts", "wmv", "mpg"];
const IMAGE: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

fn ext(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

pub fn is_video(name: &str) -> bool {
    VIDEO.contains(&ext(name).as_str())
}

pub fn is_image(name: &str) -> bool {
    IMAGE.contains(&ext(name).as_str())
}

/// The year (19xx or 20xx) inside a "(...)" group: (start of the group, end after its ")", year).
fn find_year(s: &str) -> Option<(usize, usize, i32)> {
    let mut from = 0;
    while let Some(open) = s[from..].find('(').map(|i| i + from) {
        let close = s[open..].find(')').map(|i| i + open + 1)?;
        let inner: Vec<char> = s[open + 1..close - 1].chars().collect();
        let mut i = 0;
        while i + 4 <= inner.len() {
            let four = &inner[i..i + 4];
            let bounded = (i == 0 || !inner[i - 1].is_ascii_digit()) && inner.get(i + 4).map_or(true, |c| !c.is_ascii_digit());
            if bounded && four.iter().all(|c| c.is_ascii_digit()) {
                let year: i32 = four.iter().collect::<String>().parse().unwrap_or(0);
                if (1900..2100).contains(&year) {
                    return Some((open, close, year));
                }
            }
            i += 1;
        }
        from = close;
    }
    None
}

/// "(2025) 1080p", "2001", "(1960-1994)", "(2015 & Before) PPV": a folder that only sorts titles
/// by year. "1917 (2019) 1080p" and "2001-A Space Odyssey (1968)" are titles.
pub fn is_year_folder(name: &str) -> bool {
    let t = name.trim().trim_end_matches('/').trim_start_matches('(');
    let digits: String = t.chars().take(4).collect();
    if digits.len() < 4 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let rest = &t[4..];
    rest.chars().count() <= 30 && find_year(rest).is_none() && !rest.chars().next().map_or(false, |c| c.is_alphabetic())
}

/// A folder that is one movie or series: its name carries a "(year)" or "(TV Series year)".
pub fn is_title_folder(name: &str) -> bool {
    !is_year_folder(name) && find_year(name).is_some()
}

/// (token, label), matched as whole words.
const TAGS: [(&str, &str); 22] = [
    ("hevc", "HEVC"),
    ("x265", "HEVC"),
    ("h265", "HEVC"),
    ("nf", "NF"),
    ("amzn", "AMZN"),
    ("dsnp", "DSNP"),
    ("hmax", "HMAX"),
    ("max", "MAX"),
    ("atvp", "ATVP"),
    ("hulu", "Hulu"),
    ("web-dl", "WEB-DL"),
    ("webrip", "WEBRip"),
    ("bluray", "BluRay"),
    ("hdrip", "HDRip"),
    ("hdtc", "HDTC"),
    ("hdcam", "HDCAM"),
    ("3d", "3D"),
    ("imax", "IMAX"),
    ("hdr", "HDR"),
    ("10bit", "10-bit"),
    ("remux", "Remux"),
    ("rem", "Remastered"),
];

pub fn quality_in(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut best: Option<(usize, &str)> = None;
    for (token, label) in [("2160p", "4K"), ("4k", "4K"), ("1080p", "1080p"), ("720p", "720p"), ("480p", "480p"), ("360p", "360p")] {
        for (at, _) in lower.match_indices(token) {
            let before = lower[..at].chars().last().map_or(true, |c| !c.is_ascii_alphanumeric());
            let after = lower[at + token.len()..].chars().next().map_or(true, |c| !c.is_ascii_alphanumeric());
            if before && after && best.map_or(true, |(b, _)| at < b) {
                best = Some((at, label));
            }
        }
    }
    best.map(|(_, l)| l.to_string()).unwrap_or_default()
}

pub fn tags_in(text: &str) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut push = |t: &str| {
        if !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    };
    if lower.contains("dual audio") || lower.contains("dual-audio") {
        push("Dual Audio");
    }
    for word in lower.split(|c: char| !c.is_ascii_alphanumeric() && c != '-') {
        if let Some((_, label)) = TAGS.iter().find(|(t, _)| *t == word) {
            push(label);
        }
    }
    out
}

pub fn parse_name(raw: &str) -> Parsed {
    let mut s = raw.trim().trim_end_matches('/').trim();
    let mut rank = None;
    // "001. The Godfather (1972)" (IMDb rank) and "04 - Thor (2011)" (a collection's order).
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    if (1..=3).contains(&digits) {
        let rest = &s[digits..];
        if let Some(r) = rest.strip_prefix(". ") {
            rank = s[..digits].parse().ok();
            s = r.trim_start();
        } else if let Some(r) = rest.strip_prefix(" - ") {
            if find_year(r).is_some() {
                s = r.trim_start();
            }
        }
    }
    let (title_end, tail, year, series) = match find_year(s) {
        Some((open, close, year)) => (open, &s[close..], Some(year), s[open..close].to_ascii_lowercase().contains("series")),
        None => {
            let cut = s.find('[').unwrap_or(s.len());
            (cut, &s[cut..], None, false)
        }
    };
    let title = s[..title_end].trim().trim_end_matches(|c| c == '-' || c == ' ').trim().to_string();
    Parsed {
        title: if title.is_empty() { s.to_string() } else { title },
        year,
        quality: quality_in(tail),
        tags: tags_in(tail),
        rank,
        series,
    }
}

/// The poster of a folder's images ((name, bytes)): a jpg, png or webp, the biggest of them (the
/// vertical one is usually the largest), or None.
pub fn pick_poster(files: &[(String, u64)]) -> Option<usize> {
    let rank = |name: &str| match ext(name).as_str() {
        "jpg" | "jpeg" => 2,
        "png" => 1,
        "webp" => 1,
        _ => 0,
    };
    files
        .iter()
        .enumerate()
        .filter(|(_, (n, _))| is_image(n))
        .max_by_key(|(_, (n, size))| (rank(n), *size))
        .map(|(i, _)| i)
}

/// "S01E03" in an episode's file name: (season, episode).
pub fn season_episode(name: &str) -> Option<(u32, u32)> {
    let lower = name.to_ascii_lowercase();
    let b = lower.as_bytes();
    for (i, _) in lower.match_indices('s') {
        let mut j = i + 1;
        let s0 = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == s0 || j - s0 > 3 || b.get(j) != Some(&b'e') || (i > 0 && b[i - 1].is_ascii_alphanumeric()) {
            continue;
        }
        let e0 = j + 1;
        let mut k = e0;
        while k < b.len() && b[k].is_ascii_digit() {
            k += 1;
        }
        if k > e0 && k - e0 <= 4 {
            return Some((lower[s0..j].parse().ok()?, lower[e0..k].parse().ok()?));
        }
    }
    None
}

/// Compares names the way people count: "Season 2" before "Season 10".
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(p), Some(q)) if p.is_ascii_digit() && q.is_ascii_digit() => {
                let mut n = String::new();
                let mut m = String::new();
                while let Some(c) = x.peek().copied().filter(char::is_ascii_digit) {
                    n.push(c);
                    x.next();
                }
                while let Some(c) = y.peek().copied().filter(char::is_ascii_digit) {
                    m.push(c);
                    y.next();
                }
                let (n, m): (u64, u64) = (n.parse().unwrap_or(0), m.parse().unwrap_or(0));
                if n != m {
                    return n.cmp(&m);
                }
            }
            (Some(p), Some(q)) => {
                if p != q {
                    return p.cmp(&q);
                }
                x.next();
                y.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn movie_folders() {
        let p = parse_name("A House of Dynamite (2025) 1080p NF [Dual Audio]/");
        assert_eq!((p.title.as_str(), p.year, p.quality.as_str()), ("A House of Dynamite", Some(2025), "1080p"));
        assert_eq!(p.tags, vec!["Dual Audio", "NF"]);
        assert!(!p.series);
        let p = parse_name("28 Years Later (2025) 1080p [Dual Audio]");
        assert_eq!((p.title.as_str(), p.year), ("28 Years Later", Some(2025)));
        let p = parse_name("A Big Bold Beautiful Journey (2025) 1080p AMZN [Dual Audio]");
        assert_eq!(p.tags, vec!["Dual Audio", "AMZN"]);
        let p = parse_name("Ajey-The Untold Story of a Yogi (2025) 720p HDTC");
        assert_eq!((p.quality.as_str(), p.tags.clone()), ("720p", vec!["HDTC".to_string()]));
        let p = parse_name("300-Rise of an Empire (2014) 1080p [3D]");
        assert_eq!((p.title.as_str(), p.tags.clone()), ("300-Rise of an Empire", vec!["3D".to_string()]));
        let p = parse_name("Accused (2005) (Denmark)");
        assert_eq!((p.title.as_str(), p.year, p.quality.as_str()), ("Accused", Some(2005), ""));
    }

    #[test]
    fn titles_that_look_like_years() {
        let p = parse_name("1917 (2019) 1080p BluRay");
        assert_eq!((p.title.as_str(), p.year), ("1917", Some(2019)));
        let p = parse_name("2001-A Space Odyssey (1968) 1080p");
        assert_eq!((p.title.as_str(), p.year), ("2001-A Space Odyssey", Some(1968)));
        assert!(is_title_folder("1917 (2019) 1080p"));
        assert!(!is_year_folder("1917 (2019) 1080p"));
        assert!(is_title_folder("2040 (TV Documentary 2019) 1080p"));
    }

    #[test]
    fn series_folders() {
        let p = parse_name("A Discovery of Witches (TV Series 2018–2022) 1080p/");
        assert_eq!((p.title.as_str(), p.year, p.series), ("A Discovery of Witches", Some(2018), true));
        let p = parse_name("A Knight of the Seven Kingdoms (TV Series 2026– ) 1080p [Dual Audio]");
        assert_eq!((p.year, p.series), (Some(2026), true));
        let p = parse_name("2 Weeks (TV Mini Series 2013) 720p");
        assert_eq!((p.title.as_str(), p.year, p.series), ("2 Weeks", Some(2013), true));
        let p = parse_name("13th (TV Documentary 2016) 720p WEBRip");
        assert!(!p.series);
        assert_eq!(p.tags, vec!["WEBRip"]);
    }

    #[test]
    fn rank_and_collection_prefixes() {
        let p = parse_name("001. The Shawshank Redemption (1994) 1080p [Dual Audio]");
        assert_eq!((p.title.as_str(), p.rank, p.year), ("The Shawshank Redemption", Some(1), Some(1994)));
        let p = parse_name("253. Schindler's List (1993) 1080p");
        assert_eq!((p.title.as_str(), p.rank), ("Schindler's List", Some(253)));
        let p = parse_name("04 - Thor (2011) 1080p [Dual Audio]");
        assert_eq!((p.title.as_str(), p.rank), ("Thor", None));
    }

    #[test]
    fn year_and_title_folders() {
        for y in ["(2025) 1080p", "(1995) 1080p & Before", "(2001)", "2001", "2000 & Before", "(1960-1994)", "(2015 & Before) PPV", "(2016) PPV"] {
            assert!(is_year_folder(y), "{y}");
            assert!(!is_title_folder(y), "{y}");
        }
        for t in ["Aachari Baa (2025) 720p", "120 Bahadur (2025) 1080p", "A Fistful of Dollars (1964) 1080p"] {
            assert!(is_title_folder(t), "{t}");
        }
        for c in ["TV Series ♥  A  —  L", "Danish Language", "Season 1", "# AWARDS", "Marvel Cinematic Universe-MCU Collection 1080p [Dual Audio]"] {
            assert!(!is_year_folder(c) && !is_title_folder(c), "{c}");
        }
    }

    #[test]
    fn file_names() {
        let f = "28 Years Later (2025) 1080p BluRay x265 HEVC MSubs [Dual Audio][Hindi 5.1+English 5.1] -mkvC.mkv";
        assert_eq!(quality_in(f), "1080p");
        assert_eq!(tags_in(f), vec!["Dual Audio", "BluRay", "HEVC"]);
        let f = "18 Again S01E01  720p AMZN WEBRip x265 HEVC ESub [Dual Audio][Hindi 2.0+Korean 2.0] -MsMod.mkv";
        assert_eq!(tags_in(f), vec!["Dual Audio", "AMZN", "WEBRip", "HEVC"]);
        assert_eq!(season_episode(f), Some((1, 1)));
        assert_eq!(season_episode("Show.S10E102.mkv"), Some((10, 102)));
        assert_eq!(season_episode("Movie (2020).mkv"), None);
        assert_eq!(quality_in("Movie 2160p WEB-DL"), "4K");
        assert!(is_video("a.MKV") && !is_video("a.jpg") && is_image("a_AL_.jpg"));
    }

    #[test]
    fn poster_pick() {
        let files = vec![("a_AL_.jpg".to_string(), 61015), ("a_VL_.jpg".to_string(), 242862), ("x.mkv".to_string(), 9_000_000_000)];
        assert_eq!(pick_poster(&files), Some(1));
        assert_eq!(pick_poster(&[("x.mkv".to_string(), 5)]), None);
        let mixed = vec![("cover.png".to_string(), 900_000), ("a11.jpg".to_string(), 328_784)];
        assert_eq!(pick_poster(&mixed), Some(1));
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["Season 10", "Season 2", "Season 1"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["Season 1", "Season 2", "Season 10"]);
    }
}
