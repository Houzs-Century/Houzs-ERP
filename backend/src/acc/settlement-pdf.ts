// ----------------------------------------------------------------------------
// acc/settlement-pdf — turning an acquirer's PDF statement into the CSV the
// reader already speaks.
//
// Maybank sends its merchant daily settlement report ONLY as a PDF (owner,
// 2026-08-17), and it is his largest acquirer by a wide margin — RM 251,840 in
// half a month across eight merchant numbers, with the fee deducted before the
// money reaches the bank. Without this the biggest fee stream in the business
// stays invisible, which is the exact disease this module exists to cure.
//
// So the PDF is converted to a table HERE and handed to parseStatement, which
// keeps every rule in one place: the heading search, the date handling, the fee
// methods, the statement-total check. Nothing about Maybank is special-cased in
// the reader.
//
// Three obstacles, all real, all handled:
//
//   1. The file is ENCRYPTED. Maybank's is owner-restricted with an empty user
//      password (RC4-128 or AES-128 depending on the producer), so it opens —
//      but every stream has to be decrypted before it can be inflated. A file
//      that genuinely needs a password is refused by name, not mangled.
//   2. The text is OBFUSCATED. The producer writes each glyph two bytes wide
//      and shifts the character by a constant, so "MAYBANK" leaves the file as
//      20 30 20 24 20 3C … The shift is DETECTED rather than hardcoded: the
//      candidate decoding that yields the most text-like output wins.
//   3. A PDF HAS NO COLUMNS. Each cell is its own positioned string, so cells
//      are grouped into rows by their y coordinate and ordered by x — which is
//      what makes the heading row come out as a heading row.
//
// No dependencies: MD5 and RC4 are ~40 lines here, AES-CBC and inflate come
// from the platform (Web Crypto + DecompressionStream), both available in the
// Worker and in Node.
// ----------------------------------------------------------------------------

export type PdfToCsvResult = { ok: true; csv: string } | { ok: false; reason: string };

/* ── MD5, because Web Crypto does not carry it and the PDF key needs it ────── */

function md5(input: Uint8Array): Uint8Array {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const len = input.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(input);
  withPad[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301; let b0 = 0xefcdab89; let c0 = 0x98badcfe; let d0 = 0x10325476;
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

  for (let chunk = 0; chunk < withPad.length; chunk += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i += 1) M[i] = dv.getInt32(chunk + i * 4, true);
    let A = a0; let B = b0; let C = c0; let D = d0;
    for (let i = 0; i < 64; i += 1) {
      let F: number;
      let g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  new DataView(out.buffer).setInt32(0, a0, true);
  new DataView(out.buffer).setInt32(4, b0, true);
  new DataView(out.buffer).setInt32(8, c0, true);
  new DataView(out.buffer).setInt32(12, d0, true);
  return out;
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + S[i] + key[i % key.length]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = new Uint8Array(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 255; j = (j + S[i]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}

const PAD = new Uint8Array([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  /* A one-chunk ReadableStream rather than a Blob: the Worker's type surface
     does not carry BlobPart, and this needs no copy. */
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(data); controller.close(); },
  });
  const stream = source.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ── The PDF itself ───────────────────────────────────────────────────────── */

/** A PDF literal string, with its escapes resolved. */
function readLiteral(s: string, from: number): { text: string; end: number } {
  let out = '';
  let depth = 1;
  let j = from;
  const BS = String.fromCharCode(92);
  while (j < s.length) {
    const ch = s[j];
    if (ch === BS) {
      const n = s[j + 1];
      const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (n === '(' || n === ')' || n === BS) { out += n; j += 2; continue; }
      if (simple[n] !== undefined) { out += simple[n]; j += 2; continue; }
      const oct = /^[0-7]{1,3}/.exec(s.slice(j + 1, j + 4));
      if (oct) { out += String.fromCharCode(parseInt(oct[0], 8)); j += 1 + oct[0].length; continue; }
      out += n; j += 2; continue;
    }
    if (ch === '(') { depth += 1; out += ch; j += 1; continue; }
    if (ch === ')') { depth -= 1; if (depth === 0) return { text: out, end: j }; out += ch; j += 1; continue; }
    out += ch; j += 1;
  }
  return { text: out, end: j };
}

const bytesOf = (latin1: string): Uint8Array => {
  const out = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i += 1) out[i] = latin1.charCodeAt(i) & 255;
  return out;
};

/** How text-like a candidate decoding is — letters, digits and the punctuation
    a statement actually uses. Used to CHOOSE a decoding rather than assume one. */
function textiness(s: string): number {
  if (!s.length) return 0;
  let good = 0;
  for (const ch of s) if (/[A-Za-z0-9 .,:/()%*-]/.test(ch)) good += 1;
  return good / s.length;
}

/** One positioned string, as the PDF itself holds it. */
export type PdfCell = { page: number; x: number; y: number; text: string };
export type PdfCellsResult = { ok: true; cells: PdfCell[] } | { ok: false; reason: string };

/**
 * The decrypted, de-obfuscated, positioned strings — everything below this is
 * a way of arranging them.
 *
 * Exposed because one arrangement does not fit every document. pdfToCsv below
 * groups by y and clusters x into a grid, which is right for a statement whose
 * table fills the page. Public Bank's IBG payment advice does NOT: it prints
 * two tables side by side plus a summary block in the right margin, so grouping
 * by y alone merges two unrelated batches into one row and folds the Grand
 * Total into whichever batch happens to share its line. That reader
 * (acc/pbb-advice) works from these cells directly.
 */
export async function pdfCells(bytes: Uint8Array): Promise<PdfCellsResult> {
  const built = await buildCells(bytes);
  return built;
}

export async function pdfToCsv(bytes: Uint8Array): Promise<PdfToCsvResult> {
  const built = await buildCells(bytes);
  if (!built.ok) return built;
  return { ok: true, csv: cellsToCsv(built.cells) };
}

async function buildCells(bytes: Uint8Array): Promise<PdfCellsResult> {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  if (!s.startsWith('%PDF')) return { ok: false, reason: 'That file is not a PDF.' };

  /* ── the decryption key, for an empty user password ── */
  let decrypt: (num: number, gen: number, data: Uint8Array) => Promise<Uint8Array>;
  if (s.includes('/Encrypt')) {
    const oAt = s.indexOf('/O (');
    const idm = /\/ID\s*\[\s*<([0-9a-fA-F]+)>/.exec(s);
    const pm = /\/P\s+(-?\d+)/.exec(s);
    if (oAt < 0 || !idm || !pm) return { ok: false, reason: 'This PDF is protected in a way this reader cannot open.' };
    const O = bytesOf(readLiteral(s, oAt + 4).text).slice(0, 32);
    const ID = bytesOf(idm[1].replace(/../g, (h) => String.fromCharCode(parseInt(h, 16))));
    const P = Number(pm[1]);
    const R = Number((/\/R\s+(\d+)/.exec(s) || [, '3'])[1]);
    const keyBytes = Number((/\/Length\s+(\d+)/.exec(s) || [, '128'])[1]) / 8 || 16;
    const isAes = s.includes('/AESV2');

    const pbuf = new Uint8Array(4);
    new DataView(pbuf.buffer).setInt32(0, P, true);
    let key = md5(concat(PAD, O, pbuf, ID)).slice(0, keyBytes);
    if (R >= 3) for (let i = 0; i < 50; i += 1) key = md5(key).slice(0, keyBytes);

    /* Verify the empty password really opens it, rather than producing rubbish
       further down: /U is what the file itself says the answer should be. */
    const uAt = s.indexOf('/U (');
    if (uAt >= 0 && R >= 3) {
      const U = bytesOf(readLiteral(s, uAt + 4).text);
      let x = md5(concat(PAD, ID));
      x = rc4(key, x);
      for (let i = 1; i <= 19; i += 1) x = rc4(key.map((b) => b ^ i), x);
      const same = x.every((b, i) => b === U[i]);
      if (!same) {
        return { ok: false, reason: 'This PDF needs a password to open. Save an unlocked copy, or ask the bank for the statement in CSV.' };
      }
    }

    const SALT = new Uint8Array([0x73, 0x41, 0x6C, 0x54]);
    decrypt = async (num, gen, data) => {
      const ext = new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
      const objKey = md5(isAes ? concat(key, ext, SALT) : concat(key, ext)).slice(0, Math.min(key.length + 5, 16));
      if (!isAes) return rc4(objKey, data);
      const ck = await crypto.subtle.importKey('raw', objKey as BufferSource, 'AES-CBC', false, ['decrypt']);
      /* AES-CBC in PDF carries its IV in the first 16 bytes and pads per
         PKCS#7; Web Crypto strips the padding for us. */
      const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: data.slice(0, 16) as BufferSource }, ck, data.slice(16) as BufferSource);
      return new Uint8Array(plain);
    };
  } else {
    decrypt = async (_n, _g, data) => data;
  }

  /* ── every stream, decrypted and inflated ── */
  const streams = new Map<number, string>();
  for (const m of s.matchAll(/(\d+)\s+(\d+)\s+obj/g)) {
    const num = Number(m[1]);
    const gen = Number(m[2]);
    const st = s.indexOf('stream', m.index ?? 0);
    const endObj = s.indexOf('endobj', m.index ?? 0);
    if (st < 0 || (endObj > 0 && st > endObj)) continue;
    const header = s.slice(m.index ?? 0, st);
    if (/DCTDecode|JPXDecode/.test(header)) continue;
    const declared = Number((/\/Length\s+(\d+)/.exec(header) || [, '0'])[1]);
    let d = st + 6;
    while (s[d] === '\r' || s[d] === '\n') d += 1;
    const raw = declared > 0 ? bytes.slice(d, d + declared) : bytes.slice(d, s.indexOf('endstream', d));
    try {
      const plain = await decrypt(num, gen, raw);
      const body = /FlateDecode/.test(header) ? await inflate(plain) : plain;
      let text = '';
      for (let i = 0; i < body.length; i += 8192) {
        text += String.fromCharCode(...body.subarray(i, Math.min(i + 8192, body.length)));
      }
      streams.set(num, text);
    } catch { /* not a stream this reader can use */ }
  }
  if (streams.size === 0) return { ok: false, reason: 'Nothing in this PDF could be read — it may be a scan rather than a statement.' };

  /* ── positioned text ── */
  type Cell = { page: number; x: number; y: number; text: string };
  /* PAGE, not just position. Every content stream is one page, and until this
     was recorded they were all flattened into one coordinate space — so a
     two-page document laid page 2 exactly on top of page 1 and every row came
     out holding two unrelated records at identical x. Public Bank's IBG advice
     is two pages, which is how this surfaced. */
  const rawCells: Array<{ page: number; x: number; y: number; raw: string }> = [];
  let page = 0;
  for (const content of streams.values()) {
    if (!/(Tj|TJ)/.test(content)) continue;
    page += 1;
    let x = 0; let y = 0; let leading = 0;
    const tok = /BT|ET|([-\d.]+)\s+([-\d.]+)\s+Td|([-\d.]+)\s+([-\d.]+)\s+TD|([-\d.]+)\s+TL|T\*|([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm|\(/g;
    let m: RegExpExecArray | null;
    while ((m = tok.exec(content))) {
      const t = m[0];
      if (t === 'BT') { x = 0; y = 0; continue; }
      if (t === 'ET') continue;
      if (t === 'T*') { y -= leading; continue; }
      if (t.endsWith('Tm')) { x = Number(m[10]); y = Number(m[11]); continue; }
      if (t.endsWith('TL')) { leading = Number(m[5]); continue; }
      if (t.endsWith('TD')) { leading = -Number(m[4]); x += Number(m[3]); y += Number(m[4]); continue; }
      if (t.endsWith('Td')) { x += Number(m[1]); y += Number(m[2]); continue; }
      if (t === '(') {
        const lit = readLiteral(content, tok.lastIndex);
        tok.lastIndex = lit.end + 1;
        if (lit.text) rawCells.push({ page, x, y, raw: lit.text });
      }
    }
  }
  if (rawCells.length === 0) return { ok: false, reason: 'This PDF has no readable text — it may be a scan rather than a statement.' };

  /* ── which decoding is the real one ── */
  const asIs = (r: string) => r;
  const twoByteShift = (r: string) => {
    let out = '';
    for (let i = 0; i + 1 < r.length; i += 2) {
      const c = r.charCodeAt(i + 1) + 0x1d;
      out += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
    }
    return out;
  };
  const sample = rawCells.slice(0, 60).map((c) => c.raw).join('');
  const decode = textiness(twoByteShift(sample)) > textiness(asIs(sample)) ? twoByteShift : asIs;
  const cells: Cell[] = rawCells
    .map((c) => ({ page: c.page, x: c.x, y: c.y, text: decode(c.raw).trim() }))
    .filter((c) => c.text !== '');

  return { ok: true, cells };
}

/* ── one arrangement: a grid, for a statement whose table fills the page ──── */

function cellsToCsv(cells: PdfCell[]): string {
  /* ── rows by y ── */
  /* Page first, then y, then x — a two-page document used to interleave its
     pages here, because every page starts its coordinates again from the top. */
  const ordered = [...cells].sort((a, b) => (a.page !== b.page ? a.page - b.page
    : Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));
  const rows: PdfCell[][] = [];
  for (const c of ordered) {
    const last = rows[rows.length - 1];
    if (last && last[0].page === c.page && Math.abs(last[0].y - c.y) <= 2) last.push(c);
    else rows.push([c]);
  }

  /* ── columns by x, NOT by sequence ──────────────────────────────────────────
     A PDF writes nothing at all for an empty cell. Emitting cells in the order
     they appear therefore shifts every value after a blank one LEFT, so on this
     Maybank statement — whose Terminal No is blank — the card type slid into
     the terminal column and everything after it moved with it. Read a mapped
     column that way and you are reading the neighbouring column's number.
     So the x coordinates are clustered into a grid and each cell is placed in
     ITS OWN column, with gaps left empty. */
  const xs = [...ordered.map((c) => c.x)].sort((a, b) => a - b);
  const columns: number[] = [];
  for (const x of xs) {
    if (columns.length === 0 || x - columns[columns.length - 1] > 3) columns.push(x);
  }
  const columnOf = (x: number): number => {
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < columns.length; i += 1) {
      const gap = Math.abs(columns[i] - x);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    return best;
  };

  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = rows.map((row) => {
    const wide: string[] = new Array(columns.length).fill('');
    for (const c of row) {
      const i = columnOf(c.x);
      // Two strings in one column (a wrapped label) join rather than overwrite.
      wide[i] = wide[i] ? `${wide[i]} ${c.text}` : c.text;
    }
    // Trailing empties carry no information; interior ones do.
    let end = wide.length;
    while (end > 0 && wide[end - 1] === '') end -= 1;
    return wide.slice(0, end).map(quote).join(',');
  }).filter((line) => line.trim() !== '').join('\n');
  return csv;
}
