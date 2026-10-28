// ---------------------------------------------------------------------------
// rtf-picture — read and write the picture groups inside an RTF string.
//
// WHY THIS EXISTS. AutoCount's line-level `FurtherDescription` is a rich-text
// column, and on 554 sales-order lines and 183 purchase-order lines of the
// cutover book it holds a PHOTOGRAPH. The cutover carved those photographs out
// (`WMF -> DIB -> JPEG`, per import-so-line-photos.mjs) and hung them on the
// ERP line as R2 keys. The write-back sends nothing back into that field, so
// under the owner's rule — what the cutover took out is what must go back — the
// photographs are the one extracted thing with no return path.
//
// This module is BOTH HALVES of that question, and the reading half is the one
// that matters first:
//
//   · parseRtfPictures() — given an RTF string, say what pictures are in it and
//     in WHICH form. Point it at one real `FurtherDescription` dumped from the
//     live book and it answers, from evidence, the question nothing in this
//     repository can answer by reasoning: which RTF picture keyword AutoCount's
//     own editor writes. See docs/autocount-further-description-photos.md §5.
//   · rtfPicture() / furtherDescriptionRtf() — build the RTF that would be
//     written. Lossless and dependency-free for a JPEG; see the BLIP table
//     below for what that does and does not settle.
//
// NOTHING HERE IS WIRED INTO THE WRITE-BACK. It is deliberately a standalone
// pair of pure functions plus a CLI, because whether AutoCount RENDERS what
// rtfPicture() produces has not been observed by anyone, and shipping a
// composer change on an unobserved premise is the thing CLAUDE.md forbids.
//
// NO SHEBANG: backend/tests/rtfPicture.test.mjs imports this module, and a `#!`
// that is no longer at byte 0 after vitest inlines the source is a load-time
// SyntaxError on Windows only (CLAUDE.md, BUG-HISTORY #2062).
// ---------------------------------------------------------------------------

/**
 * The picture forms the RTF specification defines, and what each one costs us.
 *
 * `spec` is the RTF control word. `nArg` says whether the keyword carries a
 * numeric argument that must be preserved when parsing (`\wmetafile8`,
 * `\dibitmap0`).
 *
 * `producible` is the honest half: whether THIS module can produce that form
 * from a JPEG with no dependency and no image decoding.
 *  · jpegblip  — yes. The JPEG bytes go in verbatim; nothing is re-encoded.
 *  · pngblip   — no. Would need a JPEG decode and a PNG encode.
 *  · wmetafile — no. A Windows metafile carries a DIB, and a DIB is raw
 *                pixels, so producing one means decoding the JPEG. (A DIB whose
 *                BITMAPINFOHEADER declares biCompression = BI_JPEG would avoid
 *                the decode, and is RULED OUT: GDI only honours BI_JPEG where
 *                the device driver supports it, which display drivers generally
 *                do not, so it renders blank rather than failing loudly.)
 *  · emfblip   — no, same reason as wmetafile.
 *  · dibitmap  — no, same reason as wmetafile.
 *
 * On a Windows host all five are one `System.Drawing` call away, which is why
 * the findings document puts the conversion question on the host side rather
 * than in the Worker.
 */
export const BLIPS = Object.freeze({
  jpegblip: { spec: '\\jpegblip', nArg: null, producible: true },
  pngblip: { spec: '\\pngblip', nArg: null, producible: false },
  emfblip: { spec: '\\emfblip', nArg: null, producible: false },
  wmetafile: { spec: '\\wmetafile', nArg: 8, producible: false },
  dibitmap: { spec: '\\dibitmap', nArg: 0, producible: false },
});

/** Twips per inch. RTF's `\picwgoal` / `\pichgoal` are in twips. */
const TWIPS_PER_INCH = 1440;

/**
 * SOF markers that carry the frame dimensions. C4 (DHT), C8 (JPG) and CC (DAC)
 * sit inside this range and are NOT frame headers — reading dimensions out of a
 * Huffman table is how a size parser silently returns garbage.
 */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Markers that stand alone — no two-byte length follows them. */
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8]);

function asBytes(input, what) {
  if (input instanceof Uint8Array) return input;
  throw new TypeError(`${what} must be a Uint8Array (got ${Object.prototype.toString.call(input)})`);
}

/**
 * The pixel dimensions declared in a JPEG's frame header.
 *
 * THROWS rather than returning a default. `\picw` / `\pich` are what the
 * printed document scales the photograph by; a wrong-but-plausible number there
 * is a silently mis-sized picture on a customer's sales order, which is exactly
 * the failure mode that never gets reported as a defect.
 *
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number, marker: number }}
 */
export function jpegDimensions(bytes) {
  const b = asBytes(bytes, 'jpeg');
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    throw new Error('not a JPEG: missing the SOI marker (FF D8)');
  }
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    // Fill bytes: any run of FF before the marker id is padding.
    let j = i + 1;
    while (j < b.length && b[j] === 0xff) j += 1;
    if (j >= b.length) break;
    const marker = b[j];
    if (marker === 0xd9) break;               // EOI
    if (STANDALONE.has(marker)) { i = j + 1; continue; }
    if (j + 2 >= b.length) break;
    const len = (b[j + 1] << 8) | b[j + 2];
    if (len < 2) throw new Error(`malformed JPEG: segment FF${marker.toString(16)} declares length ${len}`);
    if (SOF_MARKERS.has(marker)) {
      if (j + 7 >= b.length) throw new Error('malformed JPEG: frame header is truncated');
      const height = (b[j + 4] << 8) | b[j + 5];
      const width = (b[j + 6] << 8) | b[j + 7];
      if (!width || !height) throw new Error(`malformed JPEG: frame header declares ${width}x${height}`);
      return { width, height, marker };
    }
    if (marker === 0xda) break;               // SOS — entropy data, no dimensions past here
    i = j + 1 + len;
  }
  throw new Error('not a usable JPEG: no SOF frame header before the scan');
}

/**
 * RTF hex, lowercase, wrapped.
 *
 * Wrapped because RTF readers are historically unhappy with very long lines and
 * because an unwrapped 240x240 photograph is a single 14,000-character line
 * that no human can diff. The line break is inside a control-word-free run, so
 * it is picture DATA whitespace, which the spec says to ignore.
 */
export function rtfHex(bytes, { bytesPerLine }) {
  const b = asBytes(bytes, 'picture');
  if (!Number.isInteger(bytesPerLine) || bytesPerLine < 1) {
    throw new TypeError('bytesPerLine must be a positive integer');
  }
  const lines = [];
  for (let i = 0; i < b.length; i += bytesPerLine) {
    let line = '';
    for (let k = i; k < Math.min(i + bytesPerLine, b.length); k += 1) {
      line += b[k].toString(16).padStart(2, '0');
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * One `{\pict ...}` group.
 *
 * EVERY SIZING ARGUMENT IS REQUIRED, deliberately. `dpi` decides the physical
 * size the picture prints at (`\picwgoal` = px * 1440 / dpi), and CLAUDE.md's
 * rule is that a parameter which decides something is required, never optional:
 * a default of 96 would be a decision nobody reviews, made once here and
 * inherited by every call site that says nothing.
 *
 * @param {Uint8Array} bytes         the picture, verbatim
 * @param {object}     opts
 * @param {keyof BLIPS} opts.blip    which picture form to declare
 * @param {number}     opts.widthPx
 * @param {number}     opts.heightPx
 * @param {number}     opts.dpi      pixels per inch the source was authored at
 * @param {number}     opts.bytesPerLine
 * @returns {string}
 */
export function rtfPicture(bytes, { blip, widthPx, heightPx, dpi, bytesPerLine }) {
  const b = asBytes(bytes, 'picture');
  const form = BLIPS[blip];
  if (!form) throw new Error(`unknown picture form ${JSON.stringify(blip)}; expected one of ${Object.keys(BLIPS).join(', ')}`);
  if (!form.producible) {
    throw new Error(
      `${blip} cannot be produced here: it needs the JPEG decoded to pixels. `
      + 'See BLIPS in scripts/lib/rtf-picture.mjs and the findings document.',
    );
  }
  for (const [name, v] of [['widthPx', widthPx], ['heightPx', heightPx], ['dpi', dpi]]) {
    if (!Number.isFinite(v) || v <= 0) throw new TypeError(`${name} must be a positive number (got ${v})`);
  }
  const goal = (px) => Math.round((px * TWIPS_PER_INCH) / dpi);
  const keyword = form.spec + (form.nArg == null ? '' : String(form.nArg));
  const head = `{\\pict${keyword}\\picw${widthPx}\\pich${heightPx}`
    + `\\picwgoal${goal(widthPx)}\\pichgoal${goal(heightPx)}`;
  return `${head}\n${rtfHex(b, { bytesPerLine })}}`;
}

/**
 * A whole `FurtherDescription` value: an RTF document holding `text` (may be
 * empty) followed by the pictures, one per paragraph.
 *
 * `\ansicpg1252` and the ASCII-only escaping below are on purpose. What goes
 * into this field today is a photograph and, at most, a line of Latin text; a
 * non-ASCII character is escaped to `\uN?` so the value survives a reader that
 * ignores the code page. If CJK ever needs to travel this way, that is a
 * separate decision with its own evidence, not a default to inherit.
 */
export function furtherDescriptionRtf({ text, pictures }) {
  if (typeof text !== 'string') throw new TypeError('text must be a string (pass "" for none)');
  if (!Array.isArray(pictures) || pictures.length === 0) {
    throw new TypeError('pictures must be a non-empty array of {\\pict ...} groups');
  }
  for (const p of pictures) {
    if (typeof p !== 'string' || !p.startsWith('{\\pict')) {
      throw new TypeError('each picture must be a string starting with {\\pict — use rtfPicture()');
    }
  }
  const body = [];
  if (text) body.push(escapeRtfText(text));
  body.push(...pictures);
  return '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil Arial;}}\n'
    + '\\viewkind4\\uc1\\pard\\f0\\fs20\n'
    + body.join('\\par\n')
    + '\\par\n}';
}

/** RTF-escape a run of plain text. */
export function escapeRtfText(text) {
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') { out += `\\${ch}`; continue; }
    if (ch === '\n') { out += '\\par\n'; continue; }
    if (ch === '\r') continue;
    if (cp < 0x80) { out += ch; continue; }
    // Signed 16-bit, as the spec requires; astral characters become two units.
    for (let k = 0; k < ch.length; k += 1) {
      const unit = ch.charCodeAt(k);
      out += `\\u${unit > 0x7fff ? unit - 0x10000 : unit}?`;
    }
  }
  return out;
}

const CONTROL_WORD = /\\([a-z]+)(-?\d+)?/gi;

/**
 * Every `{\pict ...}` group in an RTF string, with its declared form, its
 * dimensions and its decoded bytes.
 *
 * THIS IS THE READING HALF, and it is the one that settles the open question.
 * Run it over a `FurtherDescription` dumped from the live AED_HOUZS book and
 * the `blip` it reports is what AutoCount's own editor writes — no guessing
 * about which form the control accepts, because the control produced it.
 *
 * Finds pictures nested inside `{\*\shppict{\pict ...}}` and `{\nonshppict
 * {\pict ...}}` too: the scan is for the `{\pict` token itself, at any depth.
 *
 * @param {string} rtf
 * @returns {Array<{blip: string|null, blipArg: number|null, picw: number|null,
 *   pich: number|null, picwgoal: number|null, pichgoal: number|null,
 *   bytes: Uint8Array, hexChars: number, oddHexDigit: boolean, start: number}>}
 */
export function parseRtfPictures(rtf) {
  const s = String(rtf ?? '');
  const out = [];
  let at = 0;
  for (;;) {
    const start = s.indexOf('{\\pict', at);
    if (start < 0) break;
    const end = matchGroup(s, start);
    if (end < 0) {
      // An unterminated group is a finding, not something to paper over.
      throw new Error(`unterminated {\\pict group starting at offset ${start}`);
    }
    out.push(readPicture(s.slice(start + 1, end), start));
    at = end + 1;
  }
  return out;
}

/**
 * Every balanced `{...}` sub-group removed, the rest of the text kept in place.
 *
 * An UNBALANCED `{` is left alone rather than swallowing the remainder: the
 * picture data is what follows, and losing it silently is the outcome this
 * whole function exists to prevent.
 */
export function stripNestedGroups(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === '\\') { out += c + (inner[i + 1] ?? ''); i += 1; continue; }
    if (c === '{') {
      const close = matchGroup(inner, i);
      if (close < 0) { out += c; continue; }
      i = close;
      continue;
    }
    out += c;
  }
  return out;
}

/** Index of the `}` closing the group that opens at `open`, or -1. */
function matchGroup(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\') { i += 1; continue; }   // \{ and \} are literals, never delimiters
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

function readPicture(inner, start) {
  const rec = {
    blip: null, blipArg: null,
    picw: null, pich: null, picwgoal: null, pichgoal: null,
    bytes: new Uint8Array(0), hexChars: 0, oddHexDigit: false, start,
  };
  if (/\\bin(?![a-z])/i.test(inner)) throw new Error('this {\\pict} uses \\bin (binary) data, which this reader does not decode');

  /* NESTED GROUPS COME OUT FIRST, and this is not tidiness.
     Word and the Win32 RichEdit both emit `{\*\blipuid <32 hex digits>}` inside
     the picture group, immediately before the data. Those 32 characters are a
     LEGAL HEX RUN. A reader that takes "everything after the last control word"
     from the raw text prepends 16 bytes of somebody's identifier to the
     photograph and hands back a file that is corrupt in a way no length check
     notices — the byte count is merely 16 too big. `{\*\picprop ...}` is the
     same shape. Stripping balanced sub-groups leaves only the picture group's
     own control words and its own data. */
  const flat = stripNestedGroups(inner);

  // Where the control words stop and the hex payload begins: the last control
  // word before the data.
  let dataFrom = 0;
  CONTROL_WORD.lastIndex = 0;
  for (let m = CONTROL_WORD.exec(flat); m; m = CONTROL_WORD.exec(flat)) {
    const [, word, arg] = m;
    const n = arg == null ? null : Number(arg);
    switch (word) {
      case 'picw': rec.picw = n; break;
      case 'pich': rec.pich = n; break;
      case 'picwgoal': rec.picwgoal = n; break;
      case 'pichgoal': rec.pichgoal = n; break;
      default:
        if (Object.prototype.hasOwnProperty.call(BLIPS, word)) { rec.blip = word; rec.blipArg = n; }
    }
    dataFrom = m.index + m[0].length;
    // A control word may be followed by exactly one space, which is a delimiter
    // and not data.
    if (flat[dataFrom] === ' ') dataFrom += 1;
  }
  const hex = flat.slice(dataFrom).replace(/[^0-9a-f]/gi, '');
  rec.hexChars = hex.length;
  rec.oddHexDigit = hex.length % 2 === 1;
  const even = rec.oddHexDigit ? hex.slice(0, -1) : hex;
  const bytes = new Uint8Array(even.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(even.substr(i * 2, 2), 16);
  rec.bytes = bytes;
  return rec;
}

/**
 * What a `FurtherDescription` payload costs on the wire.
 *
 * AcSyncService refuses a request body over `MaxBody = 2 * 1024 * 1024` with
 * HTTP 413 (AcSyncService.cs:149,172). Hex doubles the picture, and the payload
 * carries every line of the document, so the ceiling is a property of the
 * DOCUMENT, not of one photograph. Callers that build an edit payload need this
 * number before they build it, not after AutoCount answers 413.
 */
export function rtfPayloadBytes(pictureByteLengths) {
  if (!Array.isArray(pictureByteLengths)) throw new TypeError('pass an array of picture byte lengths');
  let hex = 0;
  for (const n of pictureByteLengths) {
    if (!Number.isInteger(n) || n < 0) throw new TypeError(`picture length must be a non-negative integer (got ${n})`);
    hex += n * 2;
  }
  return hex;
}

/** AcSyncService's HTTP body ceiling, mirrored here so a caller can check it. */
export const AC_SYNC_MAX_BODY_BYTES = 2 * 1024 * 1024;
