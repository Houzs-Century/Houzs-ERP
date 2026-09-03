// ----------------------------------------------------------------------------
// Shared helpers for jspdf-based document PDFs. Avoids copy-pasting the
// company header / footer across SI / PI / GRN / PR / DR PDFs.
//
// VENDORED from 2990's apps/backend/src/lib/pdf-common.ts (verbatim layout/logic)
// for the Houzs SCM module. ONLY change vs. source: the COMPANY letterhead block
// now carries HOUZS's registered entity (see below), not 2990's.
// ----------------------------------------------------------------------------

import { fmtDate, fmtDateTime, fmtMoneySen } from '@2990s/shared';
import {
  composeCompanyAddress,
  getBrandingCache,
  getBrandingCompanyCode,
  getBrandingLogoCache,
  shortCompanyName,
  HOUZS_COMPANY_CODE,
  type BrandingLogo,
} from '../../../lib/branding';
import { canonicalizeSinglePhone, formatPhone } from '../../shared/phone';

/* HOUZS letterhead — name / reg no / address / phone / email now come from the
   centralised Branding config (one editable record in Settings → Branding),
   NOT from hardcoded literals. The pure (non-React) PDF libs can't use hooks,
   so they read the module-level branding cache (lib/branding.ts), which
   useBranding() primes the moment GET /api/branding resolves. Until then the
   cache holds DEFAULT_BRANDING — VERBATIM the values that were hardcoded here
   before — so a PDF drawn pre-fetch is byte-identical to the old output.

   COMPANY is exposed as live getters (not a frozen literal) so every draw call
   reflects the latest edit without the 9 consumer PDF libs changing a line —
   they all keep reading COMPANY.name / .reg / .addressLines / .portalLabel. */

/** Split the single-line branding address into ≤2 print lines on a comma
 *  boundary, matching the historic two-line letterhead block. */
function splitAddressLines(address: string): string[] {
  const a = (address || '').trim();
  if (!a) return [];
  const parts = a.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [a];
  // Balance the comma-separated chunks across two lines (first line gets the
  // bulk; the tail — typically "postcode City, State." — goes on line two).
  const split = Math.max(1, Math.ceil(parts.length / 2));
  const line1 = parts.slice(0, split).join(', ') + ',';
  const line2 = parts.slice(split).join(', ') + (a.endsWith('.') ? '.' : '');
  return [line1, line2];
}

export const COMPANY = {
  get name(): string {
    return getBrandingCache().companyName;
  },
  get reg(): string {
    return getBrandingCache().registrationNo;
  },
  get addressLines(): string[] {
    // Weave the structured postcode into the free-text address (legacy rows,
    // and rows whose address already embeds the postcode, are unchanged).
    return splitAddressLines(composeCompanyAddress(getBrandingCache()));
  },
  get phone(): string {
    // Printed on every document, so it shows the same canonical shape the rest
    // of the app uses: "+60 3-1234 5678", not "03-1234 5678". canonicalize-
    // SinglePhone refuses anything that is not unambiguously one number (this
    // field has held "03-1234 5678 / 019-876 5432"), and formatPhone returns
    // its input untouched for anything it does not recognise — so a value
    // either renders in the canonical form or exactly as it was stored. It is
    // applied on READ as well as on write because rows saved before the write
    // path canonicalised still hold the local form.
    return formatPhone(canonicalizeSinglePhone(getBrandingCache().phone));
  },
  get email(): string {
    return getBrandingCache().email;
  },
  get website(): string {
    return getBrandingCache().website;
  },
  /* Customer-service desk (owner 2026-08-07) — deliberately NOT `phone` /
     `email` above, which are the company's headline contacts. Blank for a
     company that has not set one, and the document omits the line rather than
     borrowing another company's. Canonicalised on read like `phone`, so a
     number saved before that rule existed still prints in the same shape. */
  get csPhone(): string {
    const raw = getBrandingCache().csPhone;
    return raw ? formatPhone(canonicalizeSinglePhone(raw)) : '';
  },
  get csEmail(): string {
    return getBrandingCache().csEmail;
  },
  // Footer "portal" label. HOUZS keeps the historic literal byte-identical;
  // any other active company renders "<short name> ERP" (e.g. "2990's Home
  // ERP"). Live getter like the fields above, so it flips with the switcher.
  get portalLabel(): string {
    if (getBrandingCompanyCode() === HOUZS_COMPANY_CODE) return 'Houzs ERP';
    return `${shortCompanyName(getBrandingCache().companyName)} ERP`;
  },
};

/* ── CJK-safe text ─────────────────────────────────────────────────────
   jspdf paints the built-in helvetica through WinAnsiEncoding (jspdf 2.5.2
   jspdf.node.js:1617). Its Unicode→WinAnsi table (:26984) knows exactly the 27
   codepoints listed below — and nothing else above U+00FF — folding each down
   to one byte. For ANY other codepoint above U+00FF, to8bitStream re-encodes
   the WHOLE STRING to UCS-2BE
   (:3442-3447 → :3465-3480), which WinAnsi then paints one byte per glyph — so
   a single character corrupts its ENTIRE field, the English part included:
   "陈大文 Sdn Bhd" prints as "–HY'e‡" plus a NUL-interleaved tail. This is not
   theoretical for punctuation either — a fullwidth "（" (U+FF08) is what a
   Chinese IME emits, and it reaches live delivery addresses.

   jspdf cannot warn: the throw at :3470 needs a codepoint above 16 bits and
   charCodeAt() never returns one, so the corruption is silent end-to-end.

   Fix: a document that carries such a codepoint embeds a Noto Sans SC subset
   and is drawn through it. A document that carries none fetches nothing and is
   byte-identical to before — which is why the 27 must be excluded rather than
   testing `> 0xFF`: the em dash every "Tax  —" row prints is one of them, so
   the crude test would make EVERY document pay the download. */
const WINANSI_ABOVE_LATIN1 = new Set([
  0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6, 0x02dc,
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021,
  0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

/** Hanzi proper (vs. CJK punctuation) — picks which subset a document needs. */
const isHanzi = (cp: number): boolean =>
  (cp >= 0x3400 && cp <= 0x4dbf) ||   // Unified Ideographs Ext. A
  (cp >= 0x4e00 && cp <= 0x9fff) ||   // Unified Ideographs
  (cp >= 0xf900 && cp <= 0xfaff);     // Compatibility Ideographs

const CJK_FAMILY = 'NotoSansSC';

/* Two subsets, because the two cases cost 20x apart and the cheap one is the
   common one. `punct` (~52 kB/face) carries Latin + the 27 above + CJK
   punctuation — enough for an address that only picked up a stray "（" from an
   IME. `hanzi` (~1.1 MB/face) adds GB2312 level 1 (3755 hanzi, ~99.5% of modern
   text) for documents with real Chinese. Both are fetched only when a document
   needs them, then browser-cached. */
type CjkTier = 'punct' | 'hanzi';
type FontAssetUrl = `/fonts/${string}.ttf`;
const TIER_FACES: Record<CjkTier, Record<'normal' | 'bold', FontAssetUrl>> = {
  punct: { normal: '/fonts/noto-sans-sc-punct-400.ttf', bold: '/fonts/noto-sans-sc-punct-700.ttf' },
  hanzi: { normal: '/fonts/noto-sans-sc-hanzi-400.ttf', bold: '/fonts/noto-sans-sc-hanzi-700.ttf' },
};

/* One plain sentence each — these surface to the user verbatim (every caller
   try/catches the generator and shows e.message). A driver holding a mojibake
   address is the failure we're removing; do not "recover" by drawing anyway. */
const CJK_FETCH_FAILED =
  'This document has Chinese text and the Chinese font could not be loaded — please check your connection and try again.';
/* Not worded as "Chinese": the same guard catches anything helvetica can't
   paint that the subset doesn't carry either — a traditional 陳, a rare given
   name, an emoji someone pasted into a remark. */
const CJK_GLYPH_MISSING =
  'This document has a character we cannot print yet, so the PDF was not created.';

const addCodepoints = (s: string, into: Set<number>): void => {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp != null && cp > 0xff && !WINANSI_ABOVE_LATIN1.has(cp)) into.add(cp);
  }
};

/* Walk the generator's raw payload rather than naming fields: every generator
   passes the API row verbatim, so a column added later is covered for free —
   and a field missed here would print as mojibake, which is the whole bug. */
const collectCodepoints = (value: unknown, into: Set<number>, depth = 0): void => {
  if (value == null || depth > 8) return;
  if (typeof value === 'string') { addCodepoints(value, into); return; }
  if (Array.isArray(value)) { for (const v of value) collectCodepoints(v, into, depth + 1); return; }
  /* Maps before the plain-object branch: the print-time lookups hand us
     Map<code, description>, and Object.values() of a Map is []. */
  if (value instanceof Map) {
    for (const [k, v] of value) { collectCodepoints(k, into, depth + 1); collectCodepoints(v, into, depth + 1); }
    return;
  }
  if (value instanceof Set) { for (const v of value) collectCodepoints(v, into, depth + 1); return; }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectCodepoints(v, into, depth + 1);
  }
};

/* base64 for addFileToVFS. Chunked because a 1.1 MB face is ~1.1 M arguments —
   one spread of that size blows the call stack. */
const fetchFaceBase64 = async (url: FontAssetUrl): Promise<string> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

/* Memoized per tier and shared across concurrent prints (a batch export renders
   many docs). Dropped on failure so the next print retries — unlike the logo
   memo, a failure here is loud, not a permanent degrade. */
const tierMemo = new Map<CjkTier, Promise<Record<'normal' | 'bold', string>>>();
const loadTier = (tier: CjkTier): Promise<Record<'normal' | 'bold', string>> => {
  let inflight = tierMemo.get(tier);
  if (!inflight) {
    inflight = (async () => {
      const [normal, bold] = await Promise.all([
        fetchFaceBase64(TIER_FACES[tier].normal),
        fetchFaceBase64(TIER_FACES[tier].bold),
      ]);
      return { normal, bold };
    })();
    inflight.catch(() => tierMemo.delete(tier));
    tierMemo.set(tier, inflight);
  }
  return inflight;
};

/* Per-doc state: a combined export calls this once per document on ONE doc, so
   registering must not embed the same face twice or re-wrap setFont. */
const docTiers = new WeakMap<object, Set<CjkTier>>();
const docShimmed = new WeakSet<object>();

/**
 * Make `doc` safe for any non-WinAnsi text in `payload` (plus the branding
 * letterhead, which is owner-editable and read straight from the cache here).
 *
 * No-op — and no fetch — when the document is pure WinAnsi, which is almost all
 * of them. Otherwise embeds the subset the document needs and redirects the
 * generators' 'helvetica' onto it. THROWS rather than draw text it knows will
 * come out corrupted.
 */
export async function ensurePdfCjkFont(
  doc: import('jspdf').jsPDF,
  payload: unknown,
): Promise<void> {
  const needed = new Set<number>();
  for (const s of [COMPANY.name, COMPANY.reg, ...COMPANY.addressLines, COMPANY.phone,
    COMPANY.email, COMPANY.website, COMPANY.portalLabel]) addCodepoints(s, needed);
  collectCodepoints(payload, needed);
  if (needed.size === 0) return;

  const tier: CjkTier = [...needed].some(isHanzi) ? 'hanzi' : 'punct';
  const seen = docTiers.get(doc) ?? new Set<CjkTier>();
  if (!seen.has(tier)) {
    let faces: Record<'normal' | 'bold', string>;
    try {
      faces = await loadTier(tier);
    } catch {
      throw new Error(CJK_FETCH_FAILED);
    }
    /* Both weights, always: jspdf resolves an unregistered style by SILENTLY
       falling back to times (:3661) — a WinAnsi standard font, i.e. straight
       back to mojibake — so a bold-only-Latin letterhead over a CJK body would
       re-corrupt on the very fields we just fixed. */
    for (const style of ['normal', 'bold'] as const) {
      const vfs = `${CJK_FAMILY}-${tier}-${style}.ttf`;
      doc.addFileToVFS(vfs, faces[style]);
      doc.addFont(vfs, CJK_FAMILY, style);
    }
    seen.add(tier);
    docTiers.set(doc, seen);
  }

  /* The subset itself is the source of truth for what we can paint: jspdf parses
     the embedded TTF's cmap, so ask it rather than trusting our charset list. A
     name outside GB2312 level 1 (a traditional 陳, a rare given name) would
     otherwise print as a blank box — silent corruption again, just quieter. */
  doc.setFont(CJK_FAMILY, 'normal');
  const codeMap = doc.getFont().metadata?.cmap?.unicode?.codeMap as
    | Record<number, number>
    | undefined;
  const missing = [...needed].filter((cp) => codeMap?.[cp] === undefined);
  if (missing.length > 0) throw new Error(CJK_GLYPH_MISSING);

  if (!docShimmed.has(doc)) {
    /* The generators ask for 'helvetica' by name in ~50 places, and
       jspdf-autotable resolves every cell to the literal 'helvetica' from its
       own defaults (autotable 3.8.4 jspdf.plugin.autotable.js:376 → :665).
       Redirecting the family here covers both without touching a draw call.
       Whole-document, not per-field: helvetica and Noto measure ~7% apart, and
       text wrapped on one font's metrics but painted in the other overflows its
       column. */
    const inner = doc.setFont.bind(doc);
    doc.setFont = (family: string, style?: string, weight?: string | number) => {
      if (typeof family !== 'string' || family.toLowerCase() !== 'helvetica') {
        return inner(family, style, weight);
      }
      /* Noto Sans SC has no italic — weight is its only axis — so the four
         generators that set 'italic' for a caption fold onto the upright face.
         Registering a duplicate face under 'italic' would embed the entire
         subset a second time in the file; jspdf never reaches a font any other
         way (setFontStyle doesn't exist in 2.5.2 and autotable guards on it),
         so normalising here is enough to keep them off the times fallback. */
      const upright = style === 'italic' ? 'normal' : style === 'bolditalic' ? 'bold' : style;
      return inner(CJK_FAMILY, upright, weight);
    };
    docShimmed.add(doc);
  }
}

/* ── Amount in words (AutoCount footer convention) ─────────────────────
   "RINGGIT MALAYSIA ONE THOUSAND TWO HUNDRED THIRTY-FOUR AND SEN
    FIFTY-SIX ONLY" — integer ringgit + sen, both spelled out. */
const ONES = [
  'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
  'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
] as const;
const TENS = [
  '', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY',
] as const;

const below1000ToWords = (n: number): string => {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h > 0) parts.push(`${ONES[h]} HUNDRED`);
  if (r >= 20) {
    const t = TENS[Math.floor(r / 10)];
    const o = r % 10;
    parts.push(o > 0 ? `${t}-${ONES[o]}` : (t as string));
  } else if (r > 0) {
    parts.push(ONES[r] as string);
  }
  return parts.join(' ');
};

/** Spell a non-negative integer in English words (caps), up to billions. */
export const intToWords = (n: number): string => {
  const v = Math.max(0, Math.floor(n));
  if (v === 0) return 'ZERO';
  const scales: Array<[number, string]> = [
    [1_000_000_000, 'BILLION'],
    [1_000_000, 'MILLION'],
    [1_000, 'THOUSAND'],
  ];
  const parts: string[] = [];
  let rest = v;
  for (const [div, label] of scales) {
    if (rest >= div) {
      parts.push(`${below1000ToWords(Math.floor(rest / div))} ${label}`);
      rest %= div;
    }
  }
  if (rest > 0) parts.push(below1000ToWords(rest));
  return parts.join(' ');
};

/** Sen amount → "RINGGIT MALAYSIA … AND SEN … ONLY" (AutoCount footer). */
export const amountInWordsMyr = (centi: number | null | undefined): string => {
  const v = Math.max(0, Math.round(centi ?? 0));
  const rm = Math.floor(v / 100);
  const sen = v % 100;
  const senPart = sen > 0 ? ` AND SEN ${intToWords(sen)}` : '';
  return `RINGGIT MALAYSIA ${intToWords(rm)}${senPart} ONLY`;
};

export const fmtRm = (centi: number | null, currency = 'MYR'): string => fmtMoneySen(centi, currency);

/** Document date → "31/05/2026". Null-safe ("—"). Delegates to the shared
 *  {@link fmtDate} so PDFs and the SPA share ONE date format (no 2nd source). */
export const fmtDocDate = (d: string | null | undefined): string => fmtDate(d);

/** Generated-stamp timestamp → "31/05/2026, 11:20 AM". */
export const fmtDocStamp = (d: Date = new Date()): string => fmtDateTime(d);

/* ── Shared line-item table look (owner 2026-08-07) ──────────────────────────
   Printed documents carry NO decorative fills: no near-black header band, no
   zebra striping. Both are ink the reader doesn't need, and both read as
   smudges once a sheet has been photocopied or faxed — which is what happens
   to a Delivery Order. Structure comes from rules instead: a hairline between
   rows, a heavier rule above and below the header.

   Spread these into autoTable rather than copying the values, so the eight
   documents cannot drift apart again:

     theme: 'plain',
     styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
     headStyles: DOC_TABLE_HEAD_STYLES,

   Fills that carry MEANING are not covered by this and must stay — the
   Amendment's red/green added-vs-removed rows are information, not decoration.
*/
export const DOC_TABLE_STYLES = {
  cellPadding: 2,
  valign: 'top' as const,
  lineColor: [120, 120, 120] as [number, number, number],
  lineWidth: 0.1,
};

export const DOC_TABLE_HEAD_STYLES = {
  fontStyle: 'bold' as const,
  // Per-side widths: a rule above and below the header row, nothing at the
  // sides. autoTable accepts the object form; its published type does not.
  lineWidth: { top: 0.4, bottom: 0.4 } as never,
};

// Draw the company header (top-left brand) + doc title + meta block on the right.
// Returns the y position where the body should continue.
export function drawHeader(
  doc: import('jspdf').jsPDF,
  opts: {
    docTitle: string;       // e.g. "SALES INVOICE"
    rightMeta: Array<{ label: string; value: string }>;
    /** Per-document logo override (owner 2026-07 — brand letterheads): when
     *  set, draws THIS logo (e.g. the SO's resolved brand logo) instead of
     *  the company logo. null/undefined → the company logo memo, then the
     *  historic text-only header — company letterhead stays the fallback. */
    logo?: BrandingLogo | null;
  },
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = margin;

  /* Branding logo (owner 2026-07 — 左上角): when the owner has uploaded a
     logo it renders TOP-LEFT and the company name/address block shifts to
     sit BESIDE it, keeping the exact same line spacing. No logo (or the
     memo not yet warmed) → the historic text-only header, byte-identical.
     The memo is primed by useBranding() at app load and awaited by the SO
     generator, so multi-page / multi-print runs never refetch. */
  /* Measure the right-hand meta column FIRST. The company block on the left
     used to be drawn with no width limit at all, so a long address simply ran
     under the right column — on a 2990 Delivery Order "…Wilayah Persekutuan
     KL" ended up touching "Date: 06/08/2026". Reserving the right column's
     real width (plus a gutter) and wrapping the left block into what remains
     is what keeps the two apart; nothing moves for a letterhead that already
     fitted. */
  const gutter = 8;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  let rightW = doc.getTextWidth(opts.docTitle);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  for (const m of opts.rightMeta) {
    rightW = Math.max(rightW, doc.getTextWidth(`${m.label}: ${m.value}`));
  }

  let textX = margin;
  const logo = opts.logo ?? getBrandingLogoCache();
  let logoBox: { w: number; h: number } | null = null;
  if (logo) {
    const maxW = 40;   // mm — letterhead-scale, never dominates the header
    const maxH = 16;   // mm — fits beside the 4-line text block
    const scale = Math.min(maxW / logo.width, maxH / logo.height);
    logoBox = { w: logo.width * scale, h: logo.height * scale };
    textX = margin + logoBox.w + 6;
  }

  // What the left block may occupy before it would collide with the meta
  // column. Floored so a pathological logo/meta combination still leaves a
  // usable measure rather than a negative one.
  const leftMaxW = Math.max(40, pageW - margin - textX - rightW - gutter);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  const nameLines = doc.splitTextToSize(COMPANY.name, leftMaxW) as string[];
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  const regLines = doc.splitTextToSize(COMPANY.reg, leftMaxW) as string[];
  const addressLines = COMPANY.addressLines.flatMap(
    (line) => doc.splitTextToSize(line, leftMaxW) as string[],
  );

  let logoBottomY = 0;
  if (logo && logoBox) {
    /* Vertical centring (owner 2026-07 — 左上角的中间位置): the company text
       block spans from the name's cap line (margin - 5, the 16pt cap height
       above the baseline at `margin`) down to the last address-line baseline.
       Centre the logo's midline on that block's midline; a logo TALLER than
       the block keeps the historic top alignment so it never floats above the
       page margin. Measured from the WRAPPED lines, so a block that grew a
       line still centres correctly. */
    const blockTop = margin - 5;
    const lastBaseline =
      margin + 6 * (nameLines.length - 1) + 5 * regLines.length + 4 * addressLines.length;
    const blockH = lastBaseline - blockTop;
    const topY = logoBox.h < blockH ? blockTop + (blockH - logoBox.h) / 2 : blockTop;
    try {
      doc.addImage(logo.dataUrl, logo.format, margin, topY, logoBox.w, logoBox.h);
      logoBottomY = topY + logoBox.h;
    } catch {
      textX = margin; // fail-soft: draw the text-only header, full width
    }
  }

  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  nameLines.forEach((line, i) => {
    if (i) y += 6;
    doc.text(line, textX, y);
  });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  for (const line of regLines) {
    y += 5;
    doc.text(line, textX, y);
  }
  for (const line of addressLines) {
    y += 4;
    doc.text(line, textX, y);
  }

  let rightY = margin;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(opts.docTitle, pageW - margin, rightY, { align: 'right' });
  rightY += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  for (const m of opts.rightMeta) {
    doc.text(`${m.label}: ${m.value}`, pageW - margin, rightY, { align: 'right' });
    rightY += 5;
  }

  y = Math.max(y, rightY) + 6;
  if (logoBottomY) y = Math.max(y, logoBottomY + 3); // divider clears the logo
  doc.setDrawColor(180); doc.line(margin, y, pageW - margin, y);
  return y + 4;
}

// Two-column info block (e.g. "BILL TO" + "DETAILS")
export function drawTwoColInfo(
  doc: import('jspdf').jsPDF,
  startY: number,
  leftTitle: string,
  rightTitle: string,
  leftLines: Array<string | null | undefined>,
  rightLines: Array<string | null | undefined>,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = startY;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text(leftTitle, margin, y);
  doc.text(rightTitle, pageW / 2, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  const lefts = leftLines.filter(Boolean) as string[];
  const rights = rightLines.filter(Boolean) as string[];
  const top = y;
  lefts.forEach((l, i) => doc.text(l, margin, top + i * 4));
  rights.forEach((l, i) => doc.text(l, pageW / 2, top + i * 4));
  return top + Math.max(lefts.length, rights.length, 1) * 4 + 4;
}

/* Unified document info block (Commander 2026-06-19 — Hookka-tidy layout):
   LEFT = "BILL TO" with a label gutter (Company / Address / Tel …); the value
   wraps. RIGHT = a colon-aligned key:value list ("SO No : … / Date : …").
   Blank values are skipped. Returns the Y to continue below the taller column.
   Black-and-white only (no fills) so it prints clean. */
export function drawInfoColumns(
  doc: import('jspdf').jsPDF,
  startY: number,
  left: { title: string; rows: Array<[string, string | null | undefined]> },
  right: { title: string; rows: Array<[string, string | null | undefined]> },
  marginX = 14,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = marginX;
  const midX = pageW / 2 + 2;
  const leftW = midX - margin - 6;
  const gutter = 20;
  const rValX = midX + 33;
  const lh = 4;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text(left.title, margin, startY);
  doc.text(right.title, midX, startY);
  let ly = startY + 4.6;
  let ry = startY + 4.6;

  doc.setFontSize(8.5);
  for (const [label, value] of left.rows) {
    const v = (value ?? '').toString().trim();
    if (!v) continue;
    doc.setFont('helvetica', 'normal');
    if (label) {
      doc.setTextColor(110); doc.text(label, margin, ly); doc.setTextColor(0);
      const wrapped = doc.splitTextToSize(v, leftW - gutter) as string[];
      doc.text(wrapped, margin + gutter, ly);
      ly += Math.max(1, wrapped.length) * lh;
    } else {
      const wrapped = doc.splitTextToSize(v, leftW) as string[];
      doc.text(wrapped, margin, ly);
      ly += Math.max(1, wrapped.length) * lh;
    }
  }
  for (const [label, value] of right.rows) {
    const v = (value ?? '').toString().trim();
    if (!v) continue;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110); doc.text(label, midX, ry); doc.setTextColor(0);
    doc.text(`: ${v}`, rValX, ry);
    ry += lh;
  }
  return Math.max(ly, ry) + 4;
}

// Two dashed signature boxes side by side
export function drawSignatureBoxes(
  doc: import('jspdf').jsPDF,
  startY: number,
  leftLabel: string,
  rightLabel: string,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let ty = startY;
  if (ty > 240) { doc.addPage(); ty = margin; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text(leftLabel, margin, ty);
  doc.text(rightLabel, pageW / 2 + 5, ty);
  ty += 2;
  doc.setLineDashPattern([1.5, 1.5], 0);
  doc.setDrawColor(120);
  doc.rect(margin, ty, (pageW - margin * 2) / 2 - 5, 22);
  doc.rect(pageW / 2 + 5, ty, (pageW - margin * 2) / 2 - 5, 22);
  doc.setLineDashPattern([], 0);
  return ty + 28;
}

/* Safe filename fragment.
   This used to keep ONLY `[A-Za-z0-9_-]`, which is fine for a Latin customer and
   destroys everything else: a Chinese debtor name came out as
   `2990-DO-2608-006-______.pdf` — the customer's name replaced by a row of
   underscores, on the file you send that customer (Nico, 2026-08-07).

   Every target that matters handles Unicode filenames: `doc.save()` goes through
   an <a download> (UTF-8 by definition), Windows/macOS/Linux all accept CJK, and
   so does every mail client. What is genuinely illegal is a much smaller set —
   the Windows reserved punctuation, path separators, and control characters — so
   strip THAT and keep the name.

   Also guarded: a trailing dot or space (Windows silently drops them, turning
   "Foo ." into a name that round-trips wrong) and an all-punctuation input
   collapsing to an empty string. */
// Control characters plus the Windows reserved set. Nothing else is removed.
// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_FILENAME = /[\x00-\x1f\x7f<>:"/\\|?*]+/g;
export const safeName = (s: string, maxLen = 32): string => {
  const cleaned = (s || '')
    .replace(ILLEGAL_IN_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    /* Truncation can leave a dangling separator, and Windows silently drops a
       trailing space. A trailing DOT is deliberately kept — every caller
       appends ".pdf", so it never ends the real filename, and stripping it
       would eat the dot in "Sdn. Bhd.", which is most of our supplier list. */
    .replace(/[\s-]+$/, '');
  return cleaned || 'doc';
};

// ── How a finished PDF reaches the operator ───────────────────────────────────
//
// Every document's Print preview offers the same three exits, so the delivery
// step lives here instead of being re-implemented per generator (it was written
// once, for the SO, and every other generator only knew doc.save()):
//
//   'save'    → download it (the historical default; keep it the fallback so an
//               un-migrated caller behaves exactly as before)
//   'print'   → blob → hidden iframe → the browser's print dialog. NOTE this is
//               the ONLY correct way to print a document from this app: the
//               global @media print block (index.css) hides `body *` and shows
//               only `.org-print-area`, so window.print() on a detail page
//               prints a BLANK sheet. The DO preview's "Print now" did exactly
//               that until 2026-08-06.
//   'preview' → blob → new tab, i.e. the "View full PDF" escape hatch from the
//               summary card when the operator wants to see every line first.
export type PdfAction = 'save' | 'print' | 'preview';

/* Mount a blob URL in a hidden iframe and (optionally) trigger print.
   Cleanup is deferred 60 s so the OS print dialog can hold the iframe
   document until the user closes it. */
const renderViaIframe = (blobUrl: string, andPrint: boolean): void => {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.src = blobUrl;
  document.body.appendChild(iframe);
  if (andPrint) {
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        /* Some browsers throw if the PDF viewer hasn't fully hydrated.
           Worst case the user sees the iframe content briefly; we still
           clean up below. */
      }
    };
  }
  window.setTimeout(() => {
    try { document.body.removeChild(iframe); } catch { /* already detached */ }
    URL.revokeObjectURL(blobUrl);
  }, 60_000);
};

/** Deliver a rendered doc by the requested route. Defaults to a download. */
export function deliverPdf(
  doc: import('jspdf').jsPDF,
  filename: string,
  action: PdfAction = 'save',
): void {
  if (action === 'save') {
    doc.save(filename);
    return;
  }
  deliverPdfBlob(doc.output('blob'), filename, action);
}

/** The same three exits for a PDF that exists only as BYTES — a jsPDF page
 *  merged with stored attachments (pdf-attach.ts) is no longer a jsPDF doc,
 *  and re-parsing it into one just to deliver it would be a lossy detour.
 *  'save' mirrors doc.save(): an <a download> click. */
export function deliverPdfBlob(
  blob: Blob,
  filename: string,
  action: PdfAction = 'save',
): void {
  if (action === 'save') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => { URL.revokeObjectURL(url); }, 60_000);
    return;
  }
  const blobUrl = URL.createObjectURL(blob);
  if (action === 'preview') {
    openPdfPreviewTab(blob, blobUrl, filename);
    return;
  }
  renderViaIframe(blobUrl, true);
}

/* ── The preview tab ──────────────────────────────────────────────────────────
 *
 * Two routes, in order of how good the address bar looks:
 *
 *   1. `/print-preview/<filename>.pdf`, served by the service worker out of a
 *      cache this function writes. A REAL same-origin path, so the address bar
 *      reads the document — the whole point.
 *   2. A wrapper page whose <title> is the document, with the PDF in an iframe.
 *      Used when the worker is not in control: a first visit, a client still on
 *      an older worker, local dev (the worker deliberately never intercepts), or
 *      a browser with storage blocked. The tab is still NAMED correctly; only
 *      the address bar stays a blob.
 *
 * Route 1 must be PROVEN, not assumed. Without a worker, `/print-preview/x.pdf`
 * hits Pages' SPA catch-all and returns 200 + index.html — the operator would
 * get the ERP app where a document should be, with no error anywhere. So the
 * worker answers a probe with a sentinel header, and only that header switches
 * this on.
 *
 * The tab is opened SYNCHRONOUSLY, before any await: a `window.open` that
 * follows an await has lost the user gesture and is blocked as a popup. */
function openPdfPreviewTab(blob: Blob, blobUrl: string, filename: string): void {
  const tab = window.open('', '_blank');
  if (!tab) {
    // Popup blocked — the raw blob is still better than nothing.
    window.open(blobUrl, '_blank');
    return;
  }
  void (async () => {
    try {
      const path = await putPrintPreview(blob, filename);
      if (path) {
        tab.location.replace(path);
        return;
      }
    } catch {
      // Any storage/worker failure just means route 2.
    }
    writeNamedPdfTab(tab, blobUrl, filename);
  })();
}

const PRINT_CACHE = 'houzs-print-preview';
const PRINT_PREFIX = '/print-preview/';
/** Newest N previews kept; older entries are dropped on each write. */
const PRINT_KEEP = 5;

/* Put the PDF where the service worker can serve it, and return the path — or
   null when the worker is not in control (see openPdfPreviewTab). */
async function putPrintPreview(
  blob: Blob,
  filename: string,
): Promise<string | null> {
  if (typeof caches === 'undefined' || !navigator.serviceWorker?.controller) return null;
  const probe = await fetch(`${PRINT_PREFIX}__probe`, { cache: 'no-store' }).catch(() => null);
  if (!probe || probe.headers.get('x-houzs-print-preview') !== '1') return null;

  const cache = await caches.open(PRINT_CACHE);
  /* Trim first, so a failure below cannot leave the cache growing. cache.keys()
     is insertion-ordered, so the oldest are at the front. */
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - (PRINT_KEEP - 1))).map((k) => cache.delete(k)));

  const path = PRINT_PREFIX + encodeURIComponent(filename);
  await cache.put(
    path,
    new Response(blob, {
      headers: {
        'Content-Type': 'application/pdf',
        /* `inline` so the browser RENDERS it rather than downloading; the
           filename still rides along, so Save from the viewer proposes the
           document's name. RFC 5987 encoding carries the CJK safely. */
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    }),
  );
  return path;
}

/* Route 2 — the fallback tab. A blob URL carries no name, so a bare
   `window.open(blobUrl)` lands the operator on a tab called `8a7f3c2e-1b4d-…`:
   two documents open side by side are indistinguishable and Save proposes the
   GUID. This wrapper cannot fix the address bar (only the service-worker route
   above can) but it does name the tab, the window title and the download. */
function writeNamedPdfTab(tab: Window, blobUrl: string, filename: string): void {
  const title = filename.replace(/\.pdf$/i, '');
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  tab.document.write(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${esc(title)}</title>` +
      `<style>html,body{margin:0;height:100%;background:#3a3a3a}` +
      `iframe{border:0;width:100%;height:100%;display:block}` +
      `a.dl{position:fixed;right:14px;top:10px;z-index:2;font:600 12px/1 system-ui,sans-serif;` +
      `background:#0f766e;color:#fff;padding:8px 12px;border-radius:6px;text-decoration:none}</style>` +
      `</head><body>` +
      `<a class="dl" href="${esc(blobUrl)}" download="${esc(filename)}">Download PDF</a>` +
      `<iframe src="${esc(blobUrl)}" title="${esc(title)}"></iframe>` +
      `</body></html>`,
  );
  tab.document.close();
  /* No revoke timer. The old code revoked after 60 s, which was safe when the
     tab was the blob itself (already loaded) but would quietly break this page's
     Download link the moment the operator took longer than a minute to decide.
     The blob dies with the opener page instead. */
}
