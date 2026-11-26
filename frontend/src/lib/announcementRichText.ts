
/** Text sizes an author may pick besides the default. The numbers are px
 *  (owner 2026-09-06: "像 Word 那样选字号数字"); sm / lg / xl are the
 *  2026-09-04 tokens, still valid so stored notices keep rendering. */
export const RICH_SIZES = [
  "10", "11", "12", "14", "16", "18", "20", "24", "28", "36",
  "sm", "lg", "xl",
] as const;
export type RichSize = (typeof RICH_SIZES)[number];

/** Hard cap on the stored HTML. A 20k-char notice is already absurd. */
export const RICH_HTML_MAX = 20_000;

type Canon =
  | "p"
  | "br"
  | "b"
  | "i"
  | "u"
  | "s"
  | "ol"
  | "ul"
  | "li"
  | "span"
  | "h1"
  | "h2"
  | "mark"
  | "a"
  | "table"
  | "tr"
  | "th"
  | "td"
  | "img";
type StackEntry = Canon | `-${Canon}`;

const ALIAS: Record<string, Canon | undefined> = {
  p: "p",
  div: "p",
  h1: "h1",
  h2: "h2",
  h3: "h2",
  h4: "h2",
  h5: "h2",
  h6: "h2",
  blockquote: "p",
  pre: "p",
  br: "br",
  b: "b",
  strong: "b",
  i: "i",
  em: "i",
  u: "u",
  ins: "u",
  s: "s",
  strike: "s",
  del: "s",
  ol: "ol",
  ul: "ul",
  li: "li",
  span: "span",
  font: "span",
  mark: "mark",
  a: "a",
  table: "table",
  tr: "tr",
  th: "th",
  td: "td",
  img: "img",
};

const PARA_BLOCKS: Canon[] = ["p", "h1", "h2"];
const INLINE_MARKS: Canon[] = ["b", "i", "u", "s", "mark"];

const RAW_DROP = new Set([
  "script",
  "style",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "textarea",
  "noscript",
  "head",
  "title",
]);

const TAG_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)\s*>/y;
const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[0-9a-fA-F]{1,6});/y;
const SIZE_ATTR_RE = /(?:^|\s)data-size\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const HREF_ATTR_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const ATT_ATTR_RE = /(?:^|\s)data-att\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

const HREF_OK_RE = /^(?:https?:\/\/[^\s<>"'`\\]{1,1990}|mailto:[^\s<>"'`\\]{1,200})$/i;
/** The exact key shape the upload route mints: announcements/<id>/<ms>-<8hex>.<ext>. */
export const ATTACHMENT_KEY_RE =
  /^announcements\/[A-Za-z0-9_-]{1,64}\/\d{10,16}-[0-9a-f]{8}\.(?:jpe?g|png|webp|gif)$/;

function isRichSize(v: string): v is RichSize {
  return (RICH_SIZES as readonly string[]).includes(v);
}

function readAttr(re: RegExp, attrs: string): string | null {
  const m = re.exec(attrs);
  if (!m) return null;
  return (m[1] || m[2] || m[3] || "").trim();
}

function readSizeAttr(attrs: string): RichSize | null {
  const v = (readAttr(SIZE_ATTR_RE, attrs) ?? "").toLowerCase();
  return isRichSize(v) ? v : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (_, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return NAMED_ENTITIES[e] ?? "";
  });
}

function encodeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readHrefAttr(attrs: string): string | null {
  const raw = readAttr(HREF_ATTR_RE, attrs);
  if (!raw) return null;
  const v = decodeEntities(raw).trim();
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  return HREF_OK_RE.test(v) ? v : null;
}

function readAttKey(attrs: string): string | null {
  const raw = readAttr(ATT_ATTR_RE, attrs);
  if (!raw) return null;
  const v = decodeEntities(raw).trim();
  return ATTACHMENT_KEY_RE.test(v) ? v : null;
}

/**
 * Canonicalise an announcement body to the allowed grammar.
 *
 * Total function: any input (including non-strings) yields a string that is
 * safe to hand to `innerHTML`. Idempotent: sanitising the output again returns
 * it unchanged, which is what lets the renderer re-run it on every paint as a
 * belt-and-braces check without the stored value drifting.
 */
export function sanitizeAnnouncementHtml(input: unknown): string {
  if (typeof input !== "string" || !input) return "";
  const src = input.replace(/\r\n?/g, "\n");
  const n = src.length;
  let out = "";
  const stack: StackEntry[] = [];

  const has = (name: Canon) => stack.includes(name);
  const popOne = () => {
    const t = stack.pop();
    if (t && !t.startsWith("-")) out += `</${t}>`;
  };
  const eatMarker = (name: Canon): boolean => {
    const idx = stack.lastIndexOf(`-${name}`);
    if (idx < 0) return false;
    stack.splice(idx, 1);
    return true;
  };
  const closeUntil = (name: Canon) => {
    const idx = stack.lastIndexOf(name);
    if (idx < 0) return;
    while (stack.length > idx) popOne();
  };
  const containerIdx = () =>
    Math.max(stack.lastIndexOf("li"), stack.lastIndexOf("td"), stack.lastIndexOf("th"));
  const openParaIdx = () =>
    Math.max(...PARA_BLOCKS.map((b) => stack.lastIndexOf(b)));
  const closeOpenPara = () => {
    const idx = openParaIdx();
    if (idx > containerIdx()) while (stack.length > idx) popOne();
  };

  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === "<") {
      if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i + 4);
        i = end < 0 ? n : end + 3;
        continue;
      }
      TAG_RE.lastIndex = i;
      const m = TAG_RE.exec(src);
      if (!m) {
        out += "&lt;";
        i += 1;
        continue;
      }
      i += m[0].length;
      const closing = m[1] === "/";
      const name = m[2].toLowerCase();
      const attrs = m[3] || "";
      const selfClosing = m[4] === "/";

      if (RAW_DROP.has(name)) {
        if (closing || selfClosing) continue;
        const closeRe = new RegExp(`</${name}\\s*>`, "ig");
        closeRe.lastIndex = i;
        const cm = closeRe.exec(src);
        i = cm ? cm.index + cm[0].length : n;
        continue;
      }

      const canon = ALIAS[name];
      if (!canon) continue;

      if (closing) {
        if (canon === "br" || canon === "img") continue;
        const realIdx = stack.lastIndexOf(canon);
        const markIdx = stack.lastIndexOf(`-${canon}`);
        if (markIdx > realIdx) {
          eatMarker(canon);
          continue;
        }
        closeUntil(canon);
        continue;
      }

      switch (canon) {
        case "br":
          out += "<br>";
          break;
        case "img": {
          const key = readAttKey(attrs);
          if (key) out += `<img data-att="${encodeAttr(key)}">`;
          break;
        }
        case "p":
        case "h1":
        case "h2":
          closeOpenPara();
          stack.push(canon);
          out += `<${canon}>`;
          break;
        case "li": {
          if (!has("ol") && !has("ul")) {
            closeOpenPara();
            stack.push("p");
            out += "<p>";
            break;
          }
          const listIdx = Math.max(stack.lastIndexOf("ol"), stack.lastIndexOf("ul"));
          const liIdx = stack.lastIndexOf("li");
          if (liIdx > listIdx) while (stack.length > liIdx) popOne();
          stack.push("li");
          out += "<li>";
          break;
        }
        case "ol":
        case "ul":
        case "table":
          closeOpenPara();
          stack.push(canon);
          out += `<${canon}>`;
          break;
        case "tr": {
          if (!has("table")) break;
          const tableIdx = stack.lastIndexOf("table");
          const trIdx = stack.lastIndexOf("tr");
          if (trIdx > tableIdx) while (stack.length > trIdx) popOne();
          stack.push("tr");
          out += "<tr>";
          break;
        }
        case "td":
        case "th": {
          if (!has("tr")) break;
          const trIdx = stack.lastIndexOf("tr");
          const cellIdx = Math.max(stack.lastIndexOf("td"), stack.lastIndexOf("th"));
          if (cellIdx > trIdx) while (stack.length > cellIdx) popOne();
          stack.push(canon);
          out += `<${canon}>`;
          break;
        }
        case "b":
        case "i":
        case "u":
        case "s":
        case "mark":
          if (has(canon)) {
            stack.push(`-${canon}`);
            break;
          }
          stack.push(canon);
          out += `<${canon}>`;
          break;
        case "a": {
          const href = readHrefAttr(attrs);
          if (!href || has("a")) {
            stack.push("-a");
            break;
          }
          stack.push("a");
          out += `<a href="${encodeAttr(href)}" rel="noopener noreferrer" target="_blank">`;
          break;
        }
        case "span": {
          const size = name === "span" ? readSizeAttr(attrs) : null;
          if (!size) {
            stack.push("-span");
            break;
          }
          stack.push("span");
          out += `<span data-size="${size}">`;
          break;
        }
      }
      continue;
    }

    if (ch === "&") {
      ENTITY_RE.lastIndex = i;
      const m = ENTITY_RE.exec(src);
      if (m) {
        out += m[0];
        i += m[0].length;
      } else {
        out += "&amp;";
        i += 1;
      }
      continue;
    }
    if (ch === ">") {
      out += "&gt;";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  while (stack.length) popOne();

  const EMPTY_INLINE = /<(b|i|u|s|mark|span|a)(?: [^>]*)?>(<br>)?<\/\1>/g;
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(EMPTY_INLINE, "$2");
  }

  out = out.replace(/(?:<p>(?:<br>|\s|&nbsp;)*<\/p>|<br>|\s)+$/g, "");
  return out;
}

/** True when the (sanitised) HTML carries any formatting a plain string cannot. */
export function hasRichFormatting(html: string): boolean {
  return /<(?:b|i|u|s|ol|ul|li|span|h1|h2|mark|a|table|img)\b/.test(html);
}

/** Every attachment key an inline image references, in document order. */
export function inlineImageKeys(html: string): string[] {
  const out: string[] = [];
  const re = /<img data-att="([^"]+)">/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(decodeEntities(m[1]));
  return out;
}

/**
 * Drop inline images whose key is not in `allowed` — the notice's own
 * attachment manifest. The serve route already refuses a key outside the
 * manifest, so this only turns a broken image into no image; it runs on the
 * server at write time so the stored body never references what it cannot
 * show. Operates on CANONICAL html (the exact form the sanitiser emits).
 */
export function stripUnreferencedImages(html: string, allowed: Iterable<string>): string {
  const keep = new Set(allowed);
  return html.replace(/<img data-att="([^"]+)">/g, (tag, key: string) =>
    keep.has(decodeEntities(key)) ? tag : "",
  );
}

/**
 * Derive the plain-text shadow of a rich body. This is what goes into the
 * `body` column next to `body_html`, so every reader that only knows plain
 * text — the bell excerpt, search, the translation fallback, an old mobile
 * build — still sees the notice. Numbered items keep their numbers, bullets
 * become "•", paragraphs, headings, rows and line breaks become newlines,
 * table cells are separated by " | ", a link whose text is not its address
 * gets the address in parentheses, and an image becomes "[image]".
 */
export function richTextToPlain(html: unknown): string {
  const s = sanitizeAnnouncementHtml(html);
  if (!s) return "";
  let out = "";
  const lists: Array<{ type: "ol" | "ul"; n: number }> = [];
  let link: { href: string; start: number } | null = null;
  let cellsInRow = 0;
  const nl = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const re =
    /<(\/?)(p|br|b|i|u|s|ol|ul|li|span|h1|h2|mark|a|table|tr|th|td|img)((?:\s[^>]*)?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const tag = m[2] || "";
    if (!tag) {
      out += decodeEntities(m[4] || "");
      continue;
    }
    const closing = m[1] === "/";
    const attrs = m[3] || "";
    if (tag === "br") out += "\n";
    else if (tag === "img") out += "[image]";
    else if (tag === "p" || tag === "li" || tag === "h1" || tag === "h2") {
      if (closing) nl();
      else if (tag === "li") {
        const top = lists.length ? lists[lists.length - 1] : undefined;
        if (top) {
          top.n += 1;
          out += "  ".repeat(Math.max(0, lists.length - 1));
          out += top.type === "ol" ? `${top.n}. ` : "• ";
        }
      }
    } else if (tag === "ol" || tag === "ul") {
      if (closing) lists.pop();
      else {
        nl();
        lists.push({ type: tag, n: 0 });
      }
    } else if (tag === "table") {
      nl();
    } else if (tag === "tr") {
      if (closing) nl();
      else cellsInRow = 0;
    } else if (tag === "td" || tag === "th") {
      if (!closing) {
        if (cellsInRow > 0) out += " | ";
        cellsInRow += 1;
      }
    } else if (tag === "a") {
      if (!closing) {
        const href = readAttr(HREF_ATTR_RE, attrs);
        link = href ? { href: decodeEntities(href), start: out.length } : null;
      } else if (link) {
        const text = out.slice(link.start).trim();
        if (text && text !== link.href) out += ` (${link.href})`;
        link = null;
      }
    }
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
