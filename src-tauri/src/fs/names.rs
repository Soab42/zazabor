//! Choosing names for new items: "name 2.ext" (keep both, new folders) and "name copy.ext"
//! (duplicates). Pure functions; the caller says which names are taken.

/// How a free name is derived from a taken one.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Style {
    /// "name 2.ext", "name 3.ext", …
    Numbered,
    /// "name copy.ext", "name copy 2.ext", …
    Copy,
}

/// Splits a name into stem and extension (with its dot). Folders and dotfiles have no extension.
pub fn split_name(name: &str, is_dir: bool) -> (&str, &str) {
    if is_dir {
        return (name, "");
    }
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name.split_at(i),
        _ => (name, ""),
    }
}

/// The first name derived from `name` that `taken` does not claim. `Numbered` returns `name`
/// itself when it is free; `Copy` always derives a new one.
pub fn unique_name(name: &str, is_dir: bool, style: Style, taken: &dyn Fn(&str) -> bool) -> String {
    let (stem, ext) = split_name(name, is_dir);
    if style == Style::Numbered && !taken(name) {
        return name.to_string();
    }
    let mut n = if style == Style::Numbered { 2 } else { 1 };
    loop {
        let candidate = match (style, n) {
            (Style::Copy, 1) => format!("{stem} copy{ext}"),
            (Style::Copy, n) => format!("{stem} copy {n}{ext}"),
            (Style::Numbered, n) => format!("{stem} {n}{ext}"),
        };
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Why a typed name cannot be used, or `None` when it is fine.
pub fn invalid_name(name: &str) -> Option<&'static str> {
    if name.trim().is_empty() {
        Some("The name can’t be empty.")
    } else if name == "." || name == ".." {
        Some("That name isn’t allowed.")
    } else if name.contains('/') || name.contains('\0') {
        Some("The name can’t contain “/”.")
    } else if name.len() > 255 {
        Some("That name is too long.")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn taken_of<'a>(set: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |n| set.contains(&n)
    }

    #[test]
    fn splits_extensions() {
        assert_eq!(split_name("a.txt", false), ("a", ".txt"));
        assert_eq!(split_name("a.tar.gz", false), ("a.tar", ".gz"));
        assert_eq!(split_name(".bashrc", false), (".bashrc", ""));
        assert_eq!(split_name("trailing.", false), ("trailing.", ""));
        assert_eq!(split_name("v1.2", true), ("v1.2", ""));
    }

    #[test]
    fn numbered_names() {
        let taken = taken_of(&["a.txt", "a 2.txt"]);
        assert_eq!(unique_name("a.txt", false, Style::Numbered, &taken), "a 3.txt");
        assert_eq!(unique_name("b.txt", false, Style::Numbered, &taken), "b.txt");
        let folders = taken_of(&["untitled folder", "untitled folder 2"]);
        assert_eq!(unique_name("untitled folder", true, Style::Numbered, &folders), "untitled folder 3");
    }

    #[test]
    fn copy_names() {
        let taken = taken_of(&["a.txt", "a copy.txt"]);
        assert_eq!(unique_name("a.txt", false, Style::Copy, &taken), "a copy 2.txt");
        let free = taken_of(&["d"]);
        assert_eq!(unique_name("d", true, Style::Copy, &free), "d copy");
    }

    #[test]
    fn rejects_bad_names() {
        assert!(invalid_name("").is_some());
        assert!(invalid_name("   ").is_some());
        assert!(invalid_name("a/b").is_some());
        assert!(invalid_name("..").is_some());
        assert!(invalid_name("fine.txt").is_none());
    }
}
