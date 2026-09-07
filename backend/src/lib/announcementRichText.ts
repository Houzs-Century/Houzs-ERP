// ---------------------------------------------------------------------------
// Announcement rich body — the ONE grammar an announcement body may carry.
//
// The composer (frontend/src/components/AnnouncementRichEditor.tsx) lets the
// author bold / italic / underline text, pick one of three extra text sizes,
// write numbered or bulleted lists, and — since 2026-09-05 (Announcements
// redesign, toolbar follow-up) — set two heading levels, highlight a run,
// link to a web or mail address, lay out a small table, and place an
// attached image inline. That is the whole feature: the stored
// `announcements.body_html` column holds nothing but the tags listed in
// CANON below, with exactly three attributes:
//
//   · `data-size` on a span — a point size from RICH_SIZES (10 … 36), or
//     one of the legacy sm / lg / xl tokens that notices written before
//     2026-09-06 carry (kept readable, no longer offered)
//   · `href` on an anchor — http(s) or mailto only, entity-escaped, and every
//     anchor is emitted with the constant `rel="noopener noreferrer"
//     target="_blank"` so the reader's tab can never be hijacked
//   · `data-att` on an image — the R2 key of one of THIS notice's attachments
//     (the exact shape the upload route mints); never a URL, never a src. The
//     renderer resolves it through the authenticated attachment endpoint, so
//     an image can only ever show what the notice's own manifest authorises.
//
// Anything else the browser, a paste, or a hostile client sends is either
// mapped onto that grammar or dropped — never passed through.
//
// This is a CANONICALISER, not a general HTML sanitiser. It is written as a
// strict tokenizer over the raw string (no DOM — it runs inside the Worker on
// every POST/PATCH and again in the browser before every render). A tag only
// survives when it matches the allow-list; unknown tags vanish (their text
// stays), raw-text containers (<script>, <style>, …) vanish WITH their
// contents, every attribute except the three above is discarded, and the
// output is always balanced so the renderer cannot be tricked into leaving
// an element open across the page. The output alphabet stays fixed: the only
// URL that can appear is an `href` that passed the scheme allow-list, and
// there are no event handlers and no style, so an XSS payload cannot be
// expressed in it.
//
// TWIN FILE: backend/src/lib/announcementRichText.ts is a byte-for-byte copy
// (the two packages share no build). Change both together — the frontend test
// pins the same fixtures so a drift shows up as a red test on one side.
// ---------------------------------------------------------------------------

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
/** `-<tag>` marks an element we swallowed on open but whose close tag we must
 *  still eat (a transparent span, a link with a bad href, or a <b> already
 *  inside a <b>). */
type StackEntry = Canon | `-${Canon}`;

// Browser / paste spellings folded onto the canonical grammar. A tag missing
// here is unknown: dropped, content kept (that is how thead / tbody / colgroup
// fall away while the rows inside them stay).
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

// The three block kinds a paragraph-like open must close first.
const PARA_BLOCKS: Canon[] = ["p", "h1", "h2"];
// Inline marks that toggle: a duplicate inside itself is swallowed.
const INLINE_MARKS: Canon[] = ["b", "i", "u", "s", "mark"];

// Elements whose CONTENT is not text to a browser — drop the whole block, not
// just the tag, so a pasted <script> never even shows up as visible text.
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

// Sticky regexes: matched at an explicit index so the walk is linear.
const TAG_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)\s*>/y;
const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[0-9a-fA-F]{1,6});/y;
const SIZE_ATTR_RE = /(?:^|\s)data-size\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const HREF_ATTR_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const ATT_ATTR_RE = /(?:^|\s)data-att\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/** A link target the grammar accepts: web or mail, nothing that can run. */
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
  // Whichever quoting alternative matched; an empty value is still "".
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

/** Attribute-safe encoding of a value we are about to emit inside "…". */
function encodeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The href an anchor may carry, or null when the scheme is not allowed. The
 *  raw attribute is entity-decoded first so `&amp;` in a query string counts
 *  as one `&`, then re-encoded on output. */
function readHrefAttr(attrs: string): string | null {
  const raw = readAttr(HREF_ATTR_RE, attrs);
  if (!raw) return null;
  const v = decodeEntities(raw).trim();
  // Control characters (tab / newline tricks) never form a valid target.
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
  // Drop the nearest swallowed marker for `name` without touching anything
  // else — the element never opened, so its close must not close neighbours.
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
  // The nearest container a paragraph-like block may live in: a list item or
  // a table cell. A block opened above it closes the block before it.
  const containerIdx = () =>
    Math.max(stack.lastIndexOf("li"), stack.lastIndexOf("td"), stack.lastIndexOf("th"));
  const openParaIdx = () =>
    Math.max(...PARA_BLOCKS.map((b) => stack.lastIndexOf(b)));
  // Close whichever paragraph-like block is open above the nearest container.
  const closeOpenPara = () => {
    const idx = openParaIdx();
    if (idx > containerIdx()) while (stack.length > idx) popOne();
  };

  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === "<") {
      // Comments vanish whole.
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
        // Skip to (and past) the matching close tag; no close = drop the rest.
        const closeRe = new RegExp(`</${name}\\s*>`, "ig");
        closeRe.lastIndex = i;
        const cm = closeRe.exec(src);
        i = cm ? cm.index + cm[0].length : n;
        continue;
      }

      const canon = ALIAS[name];
      if (!canon) continue; // unknown tag: dropped, text kept

      if (closing) {
        if (canon === "br" || canon === "img") continue;
        // A transparent span / duplicate mark sits on the stack as a marker;
        // whichever of marker-or-real is nearest is the one this close belongs to.
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
          // Void. Only an attachment key survives; a src / URL never does.
          const key = readAttKey(attrs);
          if (key) out += `<img data-att="${encodeAttr(key)}">`;
          break;
        }
        case "p":
        case "h1":
        case "h2":
          // A paragraph-like block closes the one it is opened inside of —
          // unless that block sits below a list item / table cell, in which
          // case this block belongs to the item / cell.
          closeOpenPara();
          stack.push(canon);
          out += `<${canon}>`;
          break;
        case "li": {
          if (!has("ol") && !has("ul")) {
            // A stray <li> outside any list is just a paragraph.
            closeOpenPara();
            stack.push("p");
            out += "<p>";
            break;
          }
          // Close the sibling item (and anything inside it) before opening.
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
          // <p><ul> implies </p> (HTML's own parsing rule); a list or table
          // inside a list item / cell is legitimate nesting and stays.
          closeOpenPara();
          stack.push(canon);
          out += `<${canon}>`;
          break;
        case "tr": {
          // A row lives only in a table; outside one it is an unknown tag.
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
          // A cell lives only in a row; a sibling cell closes first.
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
            stack.push(`-${canon}`); // already inside one — swallow the duplicate
            break;
          }
          stack.push(canon);
          out += `<${canon}>`;
          break;
        case "a": {
          const href = readHrefAttr(attrs);
          if (!href || has("a")) {
            stack.push("-a"); // bad target, or a link inside a link: text only
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

  // An inline element with nothing inside (`<mark></mark>`, `<b><br></b>`) is
  // what the browser leaves when a highlighted / bold line is emptied; it
  // carries no information and paints a stray blot, so unwrap it. Repeated
  // because unwrapping one can empty its parent.
  const EMPTY_INLINE = /<(b|i|u|s|mark|span|a)(?: [^>]*)?>(<br>)?<\/\1>/g;
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(EMPTY_INLINE, "$2");
  }

  // Trailing blank paragraphs are what the editor leaves behind after a
  // Backspace-to-empty; they carry no information, so drop them.
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
  // Block boundary: one newline, never doubled by a nested close.
  const nl = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const re =
    /<(\/?)(p|br|b|i|u|s|ol|ul|li|span|h1|h2|mark|a|table|tr|th|td|img)((?:\s[^>]*)?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    // Alternation 2 (text run) leaves the tag groups empty.
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
