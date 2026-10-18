import { formatBytes } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import type { Volume } from "./api";

/** What an entry looks like to the user; decides its icon and "Kind" text. */
export type Category = "folder" | "image" | "video" | "audio" | "code" | "archive" | "document" | "generic";

const set = (list: string) => new Set(list.split(" "));

const IMAGE = set("jpg jpeg png gif webp bmp tif tiff");
// "ts" is TypeScript here; transport-stream video goes by .m2ts / .mts.
const VIDEO = set("mp4 m4v mkv webm mov avi wmv flv mpg mpeg m2ts mts");
const AUDIO = set("mp3 flac ogg oga opus wav m4a aac");
const CODE = set("js ts tsx jsx rs py go java c cpp h hpp cs rb php swift kt json toml yaml yml xml html css scss md sh lua sql");
const ARCHIVE = set("zip tar gz tgz bz2 xz 7z rar zst");
const DOCUMENT = set("pdf doc docx odt rtf txt xls xlsx ods ppt pptx odp csv");

export const isImageExt = (ext: string) => IMAGE.has(ext);
export const isVideoExt = (ext: string) => VIDEO.has(ext);

const GOOGLE_KINDS: Record<string, string> = {
  document: "Google Docs", spreadsheet: "Google Sheets", presentation: "Google Slides", form: "Google Forms",
  drawing: "Google Drawings", map: "Google My Maps", site: "Google Sites", jam: "Jamboard", script: "Apps Script", shortcut: "Shortcut",
};

/** Google's own document types (links to the web app, not files): "Google Docs", …; null for others. */
export function webKind(entry: { mime?: string }): string | null {
  const prefix = "application/vnd.google-apps.";
  if (!entry.mime?.startsWith(prefix)) return null;
  return GOOGLE_KINDS[entry.mime.slice(prefix.length)] ?? "Google Drive File";
}

/** The Size column: a dash for folders and for web documents, which have no file size. */
export const sizeText = (entry: { dir: boolean; size: number; url?: string; mime?: string }) =>
  entry.dir || entry.url || webKind(entry) ? "—" : formatBytes(entry.size);

export function categoryOf(entry: { dir: boolean; ext: string; mime?: string }): Category {
  if (entry.dir) return "folder";
  if (webKind(entry)) return "document";
  const ext = entry.ext;
  if (IMAGE.has(ext)) return "image";
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (CODE.has(ext)) return "code";
  if (ARCHIVE.has(ext)) return "archive";
  if (DOCUMENT.has(ext)) return "document";
  return "generic";
}

const ICONS: Record<Category, IconName> = {
  folder: "folder",
  image: "image",
  video: "video",
  audio: "music",
  code: "fileCode",
  archive: "fileArchive",
  document: "document",
  generic: "file",
};

export const iconNameFor = (category: Category): IconName => ICONS[category];

const SPECIFIC: Record<string, string> = {
  jpg: "JPEG Image", jpeg: "JPEG Image", png: "PNG Image", gif: "GIF Image", webp: "WebP Image",
  bmp: "BMP Image", tif: "TIFF Image", tiff: "TIFF Image",
  mp4: "MPEG-4 Movie", m4v: "MPEG-4 Movie", mkv: "Matroska Video", webm: "WebM Video", mov: "QuickTime Movie",
  avi: "AVI Video", ts: "TypeScript Source",
  mp3: "MP3 Audio", flac: "FLAC Audio", ogg: "Ogg Audio", wav: "WAV Audio", m4a: "AAC Audio",
  pdf: "PDF Document", txt: "Plain Text", md: "Markdown Document", csv: "CSV Document", json: "JSON",
  zip: "ZIP Archive", gz: "GZip Archive", tar: "TAR Archive", "7z": "7-Zip Archive", rar: "RAR Archive",
  html: "HTML Document", css: "Stylesheet", rs: "Rust Source", py: "Python Script", sh: "Shell Script",
};

const GENERIC_LABEL: Record<Category, string> = {
  folder: "Folder", image: "Image", video: "Video", audio: "Audio", code: "Source Code",
  archive: "Archive", document: "Document", generic: "File",
};

/** The text of the Kind column and the preview panels. */
export function kindLabel(entry: { dir: boolean; ext: string; link?: boolean; mime?: string }): string {
  if (entry.dir) return entry.link ? "Folder Alias" : "Folder";
  const web = webKind(entry);
  if (web) return web;
  const category = categoryOf(entry);
  const specific = SPECIFIC[entry.ext];
  if (specific) return specific;
  if (!entry.ext) return category === "generic" ? "Document" : GENERIC_LABEL[category];
  return `${entry.ext.toUpperCase()} ${GENERIC_LABEL[category]}`;
}

/** The sidebar icon for a mounted disk, guessed from its mount point and name. */
export function volumeIcon(volume: Pick<Volume, "name" | "path" | "removable">): IconName {
  const text = `${volume.path} ${volume.name}`.toLowerCase();
  if (/smb|sftp|ftp|nfs|davs?\b|afp|cifs|sshfs|network/.test(text)) return "network";
  if (/mtp|gphoto|phone|android|iphone|ipad/.test(text)) return "phone";
  if (volume.removable) return "usb";
  if (volume.path === "/") return "desktop";
  return "drive";
}

const templates = new Map<string, SVGSVGElement>();

/** A cached SVG icon, cloned: cheap enough to call for every visible row. */
export function iconNode(name: IconName, size = 16): SVGSVGElement {
  const key = `${name}:${size}`;
  let template = templates.get(key);
  if (!template) {
    template = icon(name, size);
    templates.set(key, template);
  }
  return template.cloneNode(true) as SVGSVGElement;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The large folder glyph for the icon, gallery and preview views; coloured by CSS. */
export function folderGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 52");
  svg.setAttribute("class", "folder-glyph");
  svg.innerHTML =
    `<path class="fg-back" d="M3 9a5 5 0 0 1 5-5h14.5a5 5 0 0 1 3.7 1.6L30 10h26a5 5 0 0 1 5 5v28a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z"/>` +
    `<path class="fg-front" d="M3 19a5 5 0 0 1 5-5h48a5 5 0 0 1 5 5v24a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z"/>` +
    `<path class="fg-shine" d="M8.5 14.75h47"/>`;
  return svg;
}
