// ---------------------------------------------------------------------------
// Announcement rich body — the ONE grammar an announcement body may carry.
//
// The composer (frontend/src/components/AnnouncementRichEditor.tsx) lets the
// author bold / italic / underline text, pick one of three extra text sizes,
// and write numbered or bulleted lists. That is the whole feature: the stored
// `announcements.body_html` column holds nothing but the tags listed in
// CANON below, with exactly one attribute (`data-size` on a span, values
// sm/lg/xl). Anything else the browser, a paste, or a hostile client sends is
// either mapped onto that grammar or dropped — never passed through.
//
// This is a CANONICALISER, not a general HTML sanitiser. It is written as a
// strict tokenizer over the raw string (no DOM — it runs inside the Worker on
// every POST/PATCH and again in the browser before every render). A tag only
// survives when it matches the allow-list; unknown tags vanish (their text
// stays), raw-text containers (<script>, <style>, …) vanish WITH their
// contents, every attribute except a valid `data-size` is discarded, and the
// output is always balanced so the renderer cannot be tricked into leaving
// an element open across the page. Because the output alphabet is fixed
// (no URLs, no event handlers, no style), an XSS payload cannot be expressed
// in it at all.
//
// TWIN FILE: frontend/src/lib/announcementRichText.ts is a byte-for-byte copy
// (the two packages share no build). Change both together — the frontend test
// pins the same fixtures so a drift shows up as a red test on one side.
// ---------------------------------------------------------------------------

/** Text sizes an author may pick besides the default. */
export const RICH_SIZES = ["sm", "lg", "xl"] as const;
export type RichSize = (typeof RICH_SIZES)[number];

/** Hard cap on the stored HTML. A 20k-char notice is already absurd. */
export const RICH_HTML_MAX = 20_000;

type Canon = "p" | "br" | "b" | "i" | "u" | "s" | "ol" | "ul" | "li" | "span";
/** `-<tag>` marks an element we swallowed on open but whose close tag we must
 *  still eat (a transparent span, or a <b> already inside a <b>). */
type StackEntry = Canon | `-${Canon}`;

// Browser / paste spellings folded onto the canonical grammar. `null` = the tag
// is transparent (dropped, content kept) — that is what `span` and `font`
// become when they carry no valid data-size.
const ALIAS: Record<string, Canon | undefined> = {
  p: "p",
  div: "p",
  h1: "p",
  h2: "p",
  h3: "p",
  h4: "p",
  h5: "p",
  h6: "p",
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
};

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

function isRichSize(v: string): v is RichSize {
  return (RICH_SIZES as readonly string[]).includes(v);
}

function readSizeAttr(attrs: string): RichSize | null {
  const m = SIZE_ATTR_RE.exec(attrs);
  if (!m) return null;
  const v = (m[1] || m[2] || m[3] || "").trim().toLowerCase();
  return isRichSize(v) ? v : null;
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
        if (canon === "br") continue;
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
        case "p":
          // A paragraph closes the paragraph it is opened inside of — unless
          // that paragraph is a list item's ancestor, in which case this <p>
          // belongs to the item.
          if (stack.lastIndexOf("p") > stack.lastIndexOf("li")) closeUntil("p");
          stack.push("p");
          out += "<p>";
          break;
        case "li": {
          if (!has("ol") && !has("ul")) {
            // A stray <li> outside any list is just a paragraph.
            if (stack.lastIndexOf("p") > stack.lastIndexOf("li")) closeUntil("p");
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
          // <p><ul> implies </p> (HTML's own parsing rule); a list inside a
          // list item is legitimate nesting and stays.
          if (stack.lastIndexOf("p") > stack.lastIndexOf("li")) closeUntil("p");
          stack.push(canon);
          out += `<${canon}>`;
          break;
        case "b":
        case "i":
        case "u":
        case "s":
          if (has(canon)) {
            stack.push(`-${canon}`); // already inside one — swallow the duplicate
            break;
          }
          stack.push(canon);
          out += `<${canon}>`;
          break;
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

  // Trailing blank paragraphs are what the editor leaves behind after a
  // Backspace-to-empty; they carry no information, so drop them.
  out = out.replace(/(?:<p>(?:<br>|\s|&nbsp;)*<\/p>|<br>|\s)+$/g, "");
  return out;
}

/** True when the (sanitised) HTML carries any formatting a plain string cannot. */
export function hasRichFormatting(html: string): boolean {
  return /<(?:b|i|u|s|ol|ul|li|span)\b/.test(html);
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

/**
 * Derive the plain-text shadow of a rich body. This is what goes into the
 * `body` column next to `body_html`, so every reader that only knows plain
 * text — the bell excerpt, search, the translation fallback, an old mobile
 * build — still sees the notice. Numbered items keep their numbers, bullets
 * become "•", paragraphs and line breaks become newlines.
 */
export function richTextToPlain(html: unknown): string {
  const s = sanitizeAnnouncementHtml(html);
  if (!s) return "";
  let out = "";
  const lists: Array<{ type: "ol" | "ul"; n: number }> = [];
  // Block boundary: one newline, never doubled by a nested close.
  const nl = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const re = /<(\/?)(p|br|b|i|u|s|ol|ul|li|span)(?:\s[^>]*)?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    // Alternation 2 (text run) leaves the tag groups empty.
    const tag = m[2] || "";
    if (!tag) {
      out += decodeEntities(m[3] || "");
      continue;
    }
    const closing = m[1] === "/";
    if (tag === "br") out += "\n";
    else if (tag === "p" || tag === "li") {
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
    }
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
