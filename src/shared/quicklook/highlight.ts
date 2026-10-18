/**
 * A small, dependency-free syntax highlighter for Quick Look. It only splits text into classed
 * runs; nothing here produces HTML, so file content can never inject markup.
 */

/** Token classes, styled as `.hl-<cls>` in quicklook.css. */
export type TokenClass = "kw" | "str" | "com" | "num" | "fn" | "type" | "tag" | "attr" | "var" | "";

export interface Token {
  text: string;
  cls: TokenClass;
}

interface Lang {
  keywords: Set<string>;
  /** Line comment openers. */
  line?: string[];
  block?: [string, string];
  /** String delimiters. Strings end at a line break unless the delimiter is a backtick or tripled. */
  quotes: string;
  /** Python-style triple-quoted strings. */
  triple?: boolean;
  /** Rust: `'a` is a lifetime, `'a'` a char. */
  lifetimes?: boolean;
  /** `$name` and `${name}` are variables. */
  dollar?: boolean;
  /** Identifiers may contain dashes (CSS, YAML keys, shell). */
  dashed?: boolean;
  /** Lines starting with `#` are preprocessor directives (C family). */
  preproc?: boolean;
  /** Highlight `word:` at the start of a line or after `{`/`;` as an attribute (CSS, YAML, TOML). */
  keys?: boolean;
  /** Highlight identifiers followed by `(` as functions. */
  calls?: boolean;
  /** Highlight Capitalised identifiers as types. */
  types?: boolean;
  /** Treat `[section]` lines as keywords (TOML, INI). */
  sections?: boolean;
  /** Case-insensitive keywords. */
  nocase?: boolean;
}

const words = (list: string) => new Set(list.split(" "));

const C_LIKE = "if else for while do switch case break continue return default goto sizeof typedef struct enum union static const extern volatile inline register void int char short long float double unsigned signed auto";
const JS = "break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as get set interface type enum implements namespace declare readonly abstract public private protected keyof is infer satisfies true false null undefined NaN Infinity";
const LITERALS = "true false null";

const LANGS: Record<string, Lang> = {
  js: { keywords: words(JS), line: ["//"], block: ["/*", "*/"], quotes: "\"'`", calls: true, types: true },
  rust: {
    keywords: words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while macro_rules"),
    line: ["//"], block: ["/*", "*/"], quotes: "\"'", lifetimes: true, calls: true, types: true,
  },
  python: {
    keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda None nonlocal not or pass raise return try while with yield True False self match case"),
    line: ["#"], quotes: "\"'", triple: true, calls: true, types: true,
  },
  go: {
    keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota"),
    line: ["//"], block: ["/*", "*/"], quotes: "\"'`", calls: true, types: true,
  },
  c: { keywords: words(C_LIKE + " NULL true false bool"), line: ["//"], block: ["/*", "*/"], quotes: "\"'", preproc: true, calls: true, types: true },
  cpp: {
    keywords: words(C_LIKE + " NULL true false bool class public private protected virtual override final new delete this template typename namespace using try catch throw nullptr constexpr noexcept operator friend explicit mutable auto decltype static_cast dynamic_cast reinterpret_cast const_cast"),
    line: ["//"], block: ["/*", "*/"], quotes: "\"'", preproc: true, calls: true, types: true,
  },
  java: {
    keywords: words("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record true false null"),
    line: ["//"], block: ["/*", "*/"], quotes: "\"'", calls: true, types: true,
  },
  json: { keywords: words(LITERALS), quotes: "\"", keys: true },
  yaml: { keywords: words("true false null yes no on off"), line: ["#"], quotes: "\"'", keys: true, dashed: true },
  toml: { keywords: words("true false"), line: ["#"], quotes: "\"'", keys: true, dashed: true, sections: true, triple: true },
  shell: {
    keywords: words("if then else elif fi for while until do done case esac in function select time return exit break continue local export readonly declare unset source alias echo cd set shift trap eval exec test true false"),
    line: ["#"], quotes: "\"'`", dollar: true, dashed: true, calls: false,
  },
  css: {
    keywords: words("important"), block: ["/*", "*/"], quotes: "\"'", keys: true, dashed: true, calls: true,
  },
  sql: {
    keywords: words("select from where insert into values update set delete create table drop alter add index primary key foreign references join left right inner outer on group by order having limit offset as and or not null is in like between distinct union all case when then else end exists default unique view if begin commit rollback"),
    line: ["--"], block: ["/*", "*/"], quotes: "\"'`", calls: true, nocase: true,
  },
  lua: {
    keywords: words("and break do else elseif end false for function goto if in local nil not or repeat return then true until while"),
    line: ["--"], quotes: "\"'", calls: true,
  },
  ruby: {
    keywords: words("alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require include attr_accessor"),
    line: ["#"], quotes: "\"'`", calls: true, types: true,
  },
  php: {
    keywords: words("abstract and array as break case catch class clone const continue declare default do echo else elseif empty extends final finally for foreach function global if implements include interface isset namespace new or print private protected public require return static switch this throw trait try use var while yield true false null"),
    line: ["//", "#"], block: ["/*", "*/"], quotes: "\"'", dollar: true, calls: true, types: true,
  },
  swift: {
    keywords: words("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil rethrows self super throw throws true try async await"),
    line: ["//"], block: ["/*", "*/"], quotes: "\"", calls: true, types: true,
  },
  kotlin: {
    keywords: words("as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where abstract annotation companion const crossinline data enum external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg"),
    line: ["//"], block: ["/*", "*/"], quotes: "\"'", calls: true, types: true,
  },
  csharp: {
    keywords: words("abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await record"),
    line: ["//"], block: ["/*", "*/"], quotes: "\"'", calls: true, types: true,
  },
};

const BY_EXT: Record<string, string> = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js",
  rs: "rust", py: "python", pyw: "python", go: "go",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  java: "java", json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "toml", conf: "toml", cfg: "toml",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", env: "shell",
  css: "css", scss: "css", less: "css", html: "markup", htm: "markup", xml: "markup", svg: "markup", xhtml: "markup",
  sql: "sql", lua: "lua", rb: "ruby", php: "php", swift: "swift", kt: "kotlin", kts: "kotlin", cs: "csharp",
};

const BY_NAME: Record<string, string> = {
  makefile: "shell", dockerfile: "shell", ".bashrc": "shell", ".zshrc": "shell", ".profile": "shell", ".gitignore": "shell",
};

/** The highlighter language for a file name (extension or well-known name), or "" for plain text. */
export function languageFor(name: string, ext: string): string {
  return BY_EXT[ext.toLowerCase()] ?? BY_NAME[name.toLowerCase()] ?? "";
}

const BY_TAG: Record<string, string> = {
  javascript: "js", typescript: "js", node: "js", rust: "rust", python: "python", golang: "go", "c++": "cpp",
  bash: "shell", sh: "shell", shell: "shell", console: "shell", html: "markup", xml: "markup", ruby: "ruby", "c#": "csharp",
};

/** The highlighter language for a Markdown fence tag such as `ts` or `python` ("" when unknown). */
export const languageForTag = (tag: string) => BY_TAG[tag.toLowerCase()] ?? BY_EXT[tag.toLowerCase()] ?? "";

/** Whether Quick Look should render this extension as Markdown. */
export const isMarkdownExt = (ext: string) => ext === "md" || ext === "markdown";

const IDENT_START = /[A-Za-z_$\u00a0-\uffff]/;
const IDENT = /[\w$\u00a0-\uffff]/;
const DIGIT = /[0-9]/;
const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/;

/** Merges neighbouring runs of the same class. */
class Out {
  readonly tokens: Token[] = [];
  push(text: string, cls: TokenClass) {
    if (!text) return;
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.cls === cls) last.text += text;
    else this.tokens.push({ text, cls });
  }
}

/** The end index of a string starting at `start` (the opening delimiter included). */
function stringEnd(text: string, start: number, lang: Lang): number {
  const quote = text[start];
  if (lang.triple && text.startsWith(quote.repeat(3), start)) {
    const close = text.indexOf(quote.repeat(3), start + 3);
    return close < 0 ? text.length : close + 3;
  }
  const multiline = quote === "`";
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === quote) return i + 1;
    else if (c === "\n" && !multiline) return i;
    else i++;
  }
  return text.length;
}

function scanCode(text: string, lang: Lang): Token[] {
  const out = new Out();
  const n = text.length;
  let i = 0;
  let lineStart = true;
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      out.push(c, "");
      i++;
      lineStart = true;
      continue;
    }
    const atLineStart = lineStart;
    if (c !== " " && c !== "\t") lineStart = false;

    if (lang.block && text.startsWith(lang.block[0], i)) {
      const close = text.indexOf(lang.block[1], i + lang.block[0].length);
      const end = close < 0 ? n : close + lang.block[1].length;
      out.push(text.slice(i, end), "com");
      i = end;
      continue;
    }
    const opener = lang.line?.find((l) => text.startsWith(l, i));
    if (opener && !(lang.dollar && text[i - 1] === "$")) {
      let end = text.indexOf("\n", i);
      if (end < 0) end = n;
      out.push(text.slice(i, end), "com");
      i = end;
      continue;
    }
    if (lang.preproc && c === "#" && atLineStart) {
      const m = /^#\s*\w+/.exec(text.slice(i, i + 40));
      if (m) {
        out.push(m[0], "kw");
        i += m[0].length;
        continue;
      }
    }
    if (lang.sections && c === "[" && atLineStart) {
      let end = text.indexOf("\n", i);
      if (end < 0) end = n;
      const line = text.slice(i, end);
      if (/^\[[^\]\n]*\]\s*(#.*)?$/.test(line) || /^\[\[[^\]\n]*\]\]\s*$/.test(line)) {
        const close = line.lastIndexOf("]") + 1;
        out.push(line.slice(0, close), "kw");
        out.push(line.slice(close), "");
        i = end;
        continue;
      }
    }
    if (lang.quotes.includes(c)) {
      if (lang.lifetimes && c === "'") {
        const m = /^'(?:\\.[^']*|[^'\\])'/.exec(text.slice(i, i + 12));
        if (m) {
          out.push(m[0], "str");
          i += m[0].length;
        } else {
          let j = i + 1;
          while (j < n && IDENT.test(text[j])) j++;
          out.push(text.slice(i, j), "type");
          i = j;
        }
        continue;
      }
      const end = stringEnd(text, i, lang);
      const str = text.slice(i, end);
      out.push(str, lang.keys && isKeyAt(text, end) ? "attr" : "str");
      i = end;
      continue;
    }
    if (lang.dollar && c === "$") {
      const m = /^\$(?:\{[^}\n]*\}|\(\(|\(|[A-Za-z_]\w*|[0-9@#?!*$-])/.exec(text.slice(i, i + 80));
      if (m) {
        out.push(m[0], "var");
        i += m[0].length;
        continue;
      }
    }
    if (DIGIT.test(c) || (c === "." && DIGIT.test(text[i + 1] ?? "") && !IDENT.test(text[i - 1] ?? " "))) {
      const m = NUMBER.exec(text.slice(i, i + 64)) ?? /^\.\d+/.exec(text.slice(i, i + 64));
      if (m) {
        let len = m[0].length;
        if (lang.keys) {
          // CSS units like 12px or 1.5rem.
          const unit = /^(?:%|[a-zA-Z]+)/.exec(text.slice(i + len, i + len + 8));
          if (unit) len += unit[0].length;
        }
        out.push(text.slice(i, i + len), "num");
        i += len;
        continue;
      }
    }
    if (c === "#" && lang.keys && lang.dashed && lang.block) {
      // CSS colours.
      const m = /^#[\da-fA-F]{3,8}\b/.exec(text.slice(i, i + 10));
      if (m) {
        out.push(m[0], "num");
        i += m[0].length;
        continue;
      }
    }
    if (c === "@" && lang.block && lang.keys) {
      let j = i + 1;
      while (j < n && /[\w-]/.test(text[j])) j++;
      out.push(text.slice(i, j), "kw");
      i = j;
      continue;
    }
    if (IDENT_START.test(c) && !(c === "$" && lang.dollar)) {
      let j = i + 1;
      while (j < n && (IDENT.test(text[j]) || (lang.dashed && text[j] === "-" && IDENT.test(text[j + 1] ?? " ")))) j++;
      const word = text.slice(i, j);
      const key = lang.nocase ? word.toLowerCase() : word;
      let cls: TokenClass = "";
      if (lang.keywords.has(key)) cls = "kw";
      else if (lang.keys && isKeyAt(text, j) && !/^[\w$]+\s*\(/.test(text.slice(i, j + 2))) cls = "attr";
      else if (lang.calls && text[j] === "(") cls = "fn";
      else if (lang.calls && text[j] === "!" && text[j + 1] === "(") cls = "fn";
      else if (lang.types && /^[A-Z]/.test(word) && /[a-z]/.test(word)) cls = "type";
      out.push(word, cls);
      i = j;
      continue;
    }
    out.push(c, "");
    i++;
  }
  return out.tokens;
}

/** Whether a `:` (or `=` in TOML-style files) follows at `end`, making what precedes a key. */
function isKeyAt(text: string, end: number): boolean {
  let j = end;
  while (text[j] === " " || text[j] === "\t") j++;
  return text[j] === ":" && text[j + 1] !== ":" ? true : text[j] === "=" && text[j + 1] !== "=";
}

/** HTML/XML: tags, attributes, strings and comments. */
function scanMarkup(text: string): Token[] {
  const out = new Out();
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      const end = close < 0 ? n : close + 3;
      out.push(text.slice(i, end), "com");
      i = end;
    } else if (text[i] === "<" && /[A-Za-z/!?]/.test(text[i + 1] ?? "")) {
      const open = /^<[/!?]?[\w:.-]*/.exec(text.slice(i, i + 80))!;
      out.push(open[0], "tag");
      i += open[0].length;
      // Attributes up to the closing `>`.
      while (i < n && text[i] !== ">") {
        const c = text[i];
        if (c === "\"" || c === "'") {
          let end = text.indexOf(c, i + 1);
          end = end < 0 ? n : end + 1;
          out.push(text.slice(i, end), "str");
          i = end;
        } else if (/[\w:@.-]/.test(c)) {
          let j = i + 1;
          while (j < n && /[\w:@.-]/.test(text[j])) j++;
          out.push(text.slice(i, j), "attr");
          i = j;
        } else {
          out.push(c, c === "/" || c === "?" ? "tag" : "");
          i++;
        }
      }
      if (i < n) {
        out.push(">", "tag");
        i++;
      }
    } else {
      let j = text.indexOf("<", i + 1);
      if (j < 0) j = n;
      out.push(text.slice(i, j), "");
      i = j;
    }
  }
  return out.tokens;
}

/** Splits `text` into classed runs for a language from `languageFor` ("" gives one plain run). */
export function tokenize(text: string, language: string): Token[] {
  if (language === "markup") return scanMarkup(text);
  const lang = LANGS[language];
  if (!lang) return text ? [{ text, cls: "" }] : [];
  return scanCode(text, lang);
}

/** Splits tokens into lines (without the line breaks), keeping each line's runs. */
export function toLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls: token.cls });
    });
  }
  return lines;
}
