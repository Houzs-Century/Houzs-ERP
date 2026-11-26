
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


function splitAddressLines(address: string): string[] {
  const a = (address || '').trim();
  if (!a) return [];
  const parts = a.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [a];
  const split = Math.max(1, Math.ceil(parts.length / 2));
  const line1 = parts.slice(0, split).join(', ') + ',';
  const line2 = parts.slice(split).join(', ') + (a.endsWith('.') ? '.' : '');
  return [line1, line2];
}

/** Wrap one letterhead line to `maxW`, breaking ONLY after a comma.
 *
 *  splitTextToSize breaks between WORDS, and an address is not prose: it cut
 *  "…KL Gateway, No. 2," into "…No." / "2," on the owner's 2990 voucher
 *  (2026-09-04: 地址整齐一点). A comma-delimited chunk ("No. 2,", "Menara
 *  SUEZCAP 2,") is the unit a reader parses, so chunks pack greedily into
 *  lines and never split — except a single chunk that alone exceeds the
 *  width, which the CALLER word-wraps as the lesser evil. Exported for its
 *  test. `measure` is the current font's text-width fn, so the wrap always
 *  matches what will actually be painted. */
export function wrapAtCommas(line: string, maxW: number, measure: (s: string) => number): string[] {
  const chunks = (line.match(/[^,]+,?/g) ?? [line]).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const chunk of chunks) {
    const candidate = cur ? `${cur} ${chunk}` : chunk;
    if (cur && measure(candidate) > maxW) {
      out.push(cur);
      cur = chunk;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export const COMPANY = {
  get name(): string {
    return getBrandingCache().companyName;
  },
  get reg(): string {
    return getBrandingCache().registrationNo;
  },
  get addressLines(): string[] {
    return splitAddressLines(composeCompanyAddress(getBrandingCache()));
  },
  get phone(): string {
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

const PAPER_FOLDS: ReadonlyArray<[RegExp, string]> = [
  [/→/g, '->'], [/←/g, '<-'], [/−/g, '-'], [/≈/g, '~'],
  [/[ -   　]/g, ' '], [/[​-‏⁠﻿]/g, ''],
];
export const paperText = (s: string): string => PAPER_FOLDS.reduce((acc, [re, to]) => acc.replace(re, to), s);

const isHanzi = (cp: number): boolean =>
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0xf900 && cp <= 0xfaff);

const CJK_FAMILY = 'NotoSansSC';

/* Two subsets, because the two cases cost 20x apart and the cheap one is the
   common one. `punct` (~52 kB/face) carries Latin + the 27 above + CJK
   punctuation — enough for an address that only picked up a stray "（" from an
   IME. `hanzi` (~1.1 MB/face) adds GB2312 level 1 (3755 hanzi, ~99.5% of modern
   text) for documents with real Chinese. Both are fetched only when a document
   needs them, then browser-cached.
   /fonts/* is served immutable for a year, so the name carries the first 8 hex
   of the file's sha256: #4705 regenerated these in place and browsers that had
   printed before kept the old subset and still refused KŌRI (2026-10-20).
   pdf-font-names.test.ts fails if a face's bytes change without a new name. */
type CjkTier = 'punct' | 'hanzi';
type FontAssetUrl = `/fonts/${string}.ttf`;
export const TIER_FACES: Record<CjkTier, Record<'normal' | 'bold', FontAssetUrl>> = {
  punct: { normal: '/fonts/noto-sans-sc-punct-400.620dd6b3.ttf', bold: '/fonts/noto-sans-sc-punct-700.1c0db80c.ttf' },
  hanzi: { normal: '/fonts/noto-sans-sc-hanzi-400.9f7451f3.ttf', bold: '/fonts/noto-sans-sc-hanzi-700.7f9ab99f.ttf' },
};

const CJK_FETCH_FAILED =
  'This document has Chinese text and the Chinese font could not be loaded — please check your connection and try again.';
/* Not worded as "Chinese": the same guard catches anything helvetica can't
   paint that the subset doesn't carry either — a traditional 陳, a rare given
   name, an emoji someone pasted into a remark. */
const glyphMissing = (cps: readonly number[]): string =>
  `This document has a character we cannot print yet (${cps.slice(0, 5).map((cp) => `"${String.fromCodePoint(cp)}" U+${cp.toString(16).toUpperCase()}`).join(', ')}), so the PDF was not created. Remove it from the document and try again.`;

const addCodepoints = (s: string, into: Set<number>): void => {
  for (const ch of paperText(s)) {
    const cp = ch.codePointAt(0);
    if (cp != null && cp > 0xff && !WINANSI_ABOVE_LATIN1.has(cp)) into.add(cp);
  }
};

const collectCodepoints = (value: unknown, into: Set<number>, depth = 0): void => {
  if (value == null || depth > 8) return;
  if (typeof value === 'string') { addCodepoints(value, into); return; }
  if (Array.isArray(value)) { for (const v of value) collectCodepoints(v, into, depth + 1); return; }
  if (value instanceof Map) {
    for (const [k, v] of value) { collectCodepoints(k, into, depth + 1); collectCodepoints(v, into, depth + 1); }
    return;
  }
  if (value instanceof Set) { for (const v of value) collectCodepoints(v, into, depth + 1); return; }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectCodepoints(v, into, depth + 1);
  }
};

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

const docTiers = new WeakMap<object, Set<CjkTier>>();
const docShimmed = new WeakSet<object>();
const docFolded = new WeakSet<object>();

const foldPaperTextOnDoc = (doc: import('jspdf').jsPDF): void => {
  if (docFolded.has(doc)) return;
  const fold = <T>(t: T): T =>
    (typeof t === 'string' ? paperText(t)
      : Array.isArray(t) ? t.map((x) => (typeof x === 'string' ? paperText(x) : x))
        : t) as T;
  const text = doc.text.bind(doc);
  doc.text = ((t: string | string[], ...rest: unknown[]) =>
    (text as (...a: unknown[]) => unknown)(fold(t), ...rest)) as typeof doc.text;
  const split = doc.splitTextToSize.bind(doc);
  doc.splitTextToSize = ((t: string, ...rest: unknown[]) =>
    (split as (...a: unknown[]) => unknown)(fold(t), ...rest)) as typeof doc.splitTextToSize;
  const width = doc.getTextWidth.bind(doc);
  doc.getTextWidth = (t: string) => width(fold(t));
  const unitWidth = doc.getStringUnitWidth.bind(doc);
  doc.getStringUnitWidth = ((t: string, ...rest: unknown[]) =>
    (unitWidth as (...a: unknown[]) => number)(fold(t), ...rest)) as typeof doc.getStringUnitWidth;
  docFolded.add(doc);
};

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
  foldPaperTextOnDoc(doc);
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
  if (missing.length > 0) throw new Error(glyphMissing(missing));

  if (!docShimmed.has(doc)) {
    const inner = doc.setFont.bind(doc);
    doc.setFont = (family: string, style?: string, weight?: string | number) => {
      if (typeof family !== 'string' || family.toLowerCase() !== 'helvetica') {
        return inner(family, style, weight);
      }
      const upright = style === 'italic' ? 'normal' : style === 'bolditalic' ? 'bold' : style;
      return inner(CJK_FAMILY, upright, weight);
    };
    docShimmed.add(doc);
  }
}

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

export const warehousePrintName = (h: { warehouse_name?: string | null; warehouse_code?: string | null }): string | null =>
  (h.warehouse_name ?? '').trim() || (h.warehouse_code ?? '').trim() || null;

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
  lineWidth: { top: 0.4, bottom: 0.4 } as never,
};

export function drawHeader(
  doc: import('jspdf').jsPDF,
  opts: {
    docTitle: string;
    rightMeta: Array<{ label: string; value: string }>;
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
    const maxW = 40;
    const maxH = 16;
    const scale = Math.min(maxW / logo.width, maxH / logo.height);
    logoBox = { w: logo.width * scale, h: logo.height * scale };
    textX = margin + logoBox.w + 6;
  }

  const leftMaxW = Math.max(40, pageW - margin - textX - rightW - gutter);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  const nameLines = doc.splitTextToSize(COMPANY.name, leftMaxW) as string[];
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  const regLines = doc.splitTextToSize(COMPANY.reg, leftMaxW) as string[];
  const addressLines = COMPANY.addressLines.flatMap((line) =>
    wrapAtCommas(line, leftMaxW, (s) => doc.getTextWidth(s)).flatMap((l) =>
      doc.getTextWidth(l) > leftMaxW ? (doc.splitTextToSize(l, leftMaxW) as string[]) : [l],
    ),
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
      textX = margin;
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
  if (logoBottomY) y = Math.max(y, logoBottomY + 3);
  doc.setDrawColor(180); doc.line(margin, y, pageW - margin, y);
  return y + 4;
}

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

export function drawInfoColumns(
  doc: import('jspdf').jsPDF,
  startY: number,
  left: { title: string; rows: Array<[string, string | null | undefined]> },
  right: { title: string; rows: Array<[string, string | ReadonlyArray<string> | null | undefined]> },
  marginX = 14,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = marginX;
  const midX = pageW / 2 + 2;
  const leftW = midX - margin - 6;
  const gutter = 20;
  const rValX = midX + 33;
  const rValW = pageW - margin - rValX;
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
    if (Array.isArray(value)) {
      const parts = value.map((p) => p.trim()).filter(Boolean);
      if (!parts.length) continue;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(110); doc.text(label, midX, ry); doc.setTextColor(0);
      parts.forEach((p, i) => {
        const wrapped = doc.splitTextToSize(`${i === 0 ? ':' : ' '} ${p}`, rValW) as string[];
        doc.text(wrapped, rValX, ry);
        ry += Math.max(1, wrapped.length) * lh;
      });
      continue;
    }
    const v = (value ?? '').toString().trim();
    if (!v) continue;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110); doc.text(label, midX, ry); doc.setTextColor(0);
    const wrapped = doc.splitTextToSize(`: ${v}`, rValW) as string[];
    doc.text(wrapped, rValX, ry);
    ry += Math.max(1, wrapped.length) * lh;
  }
  return Math.max(ly, ry) + 4;
}

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

// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_FILENAME = /[\x00-\x1f\x7f<>:"/\\|?*]+/g;
export const docPageLabel = (page: number, startPage: number, pageCount: number): string =>
  `Page ${page - startPage + 1} of ${pageCount - startPage + 1}`;

export const safeName = (s: string, maxLen = 32): string => {
  const cleaned = (s || '')
    .replace(ILLEGAL_IN_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
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
//   'print'   → blob → the in-app viewer below, with the browser's print
//               dialog opened on it once the PDF has laid out. The PDF must sit
//               in a VISIBLE iframe: a 0×0 hidden iframe's contentWindow.print()
//               is answered by Chrome's PDF viewer with nothing at all often
//               enough to be useless. Never window.print() on our own pages: the
//               global @media print block (index.css) hides `body *` and shows
//               only `.org-print-area`, so a detail page prints a BLANK sheet.
//   'preview' → blob → the same viewer without the auto-print, i.e. the "View
//               full PDF" escape hatch from the summary card.
//
// Both used to open a NEW TAB. That window.open runs only after the
// generator's jspdf render has been awaited, so the click's user gesture is
// gone and Chrome blocks it as a popup (owner 2026-10-02: "Print 不能在 ERP
// 里面…会跳去新的 window"). The viewer's "New tab" button is a fresh click, so
// that route still exists and is never blocked.
export type PdfAction = 'save' | 'print' | 'preview';

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
  openPdfViewerOverlay(blob, filename, { print: action === 'print' });
}

function openPdfViewerOverlay(blob: Blob, filename: string, opts: { print?: boolean } = {}): void {
  const blobUrl = URL.createObjectURL(blob);
  const title = filename.replace(/\.pdf$/i, '');
  const prevOverflow = document.body.style.overflow;

  const backdrop = document.createElement('div');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', title);
  backdrop.style.cssText =
    'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.6);' +
    'display:flex;align-items:center;justify-content:center;padding:16px';

  const panel = document.createElement('div');
  panel.style.cssText =
    'display:flex;flex-direction:column;width:min(1100px,100%);height:100%;' +
    'background:#3a3a3a;border-radius:10px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.4)';

  const bar = document.createElement('div');
  bar.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1f2937;color:#fff;' +
    'font:600 13px/1.2 system-ui,sans-serif';

  const name = document.createElement('div');
  name.textContent = title;
  name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  bar.appendChild(name);

  const iframe = document.createElement('iframe');
  iframe.title = title;
  iframe.style.cssText = 'flex:1;width:100%;border:0;display:block;background:#525659';

  const button = (label: string, primary: boolean, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText =
      'border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font:600 12px/1 system-ui,sans-serif;' +
      (primary ? 'background:#0f766e;color:#fff' : 'background:rgba(255,255,255,.12);color:#fff');
    b.addEventListener('click', onClick);
    bar.appendChild(b);
    return b;
  };

  const printFrame = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
    }
  };
  button('Print', true, printFrame);
  button('Download', false, () => deliverPdfBlob(blob, filename, 'save'));
  button('New tab', false, () => openPdfPreviewTab(blob, URL.createObjectURL(blob), filename));
  button('Close', false, () => close());

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    document.body.style.overflow = prevOverflow;
    URL.revokeObjectURL(blobUrl);
  }
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);

  /* The browser's own Save takes its name from the address: a blob saves as a
     GUID (owner 2026-11-06), the worker's path saves as the document. An iframe
     with no src fires load too, so print listens only once the real one is set. */
  void (async () => {
    let path: string | null = null;
    try {
      path = await putPrintPreview(blob, filename);
    } catch {
    }
    if (opts.print) iframe.addEventListener('load', () => { window.setTimeout(printFrame, PRINT_SETTLE_MS); }, { once: true });
    iframe.src = path ?? blobUrl;
  })();

  panel.appendChild(bar);
  panel.appendChild(iframe);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';
}

function openPdfPreviewTab(blob: Blob, blobUrl: string, filename: string): void {
  const tab = window.open('', '_blank');
  if (!tab) {
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
    }
    writeNamedPdfTab(tab, blobUrl, filename);
  })();
}

const PRINT_CACHE = 'houzs-print-preview';
const PRINT_PREFIX = '/print-preview/';
const PRINT_KEEP = 5;

async function putPrintPreview(
  blob: Blob,
  filename: string,
): Promise<string | null> {
  if (typeof caches === 'undefined' || !navigator.serviceWorker?.controller) return null;
  const probe = await fetch(`${PRINT_PREFIX}__probe`, { cache: 'no-store' }).catch(() => null);
  if (!probe || probe.headers.get('x-houzs-print-preview') !== '1') return null;

  const cache = await caches.open(PRINT_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - (PRINT_KEEP - 1))).map((k) => cache.delete(k)));

  const path = PRINT_PREFIX + encodeURIComponent(filename);
  await cache.put(
    path,
    new Response(blob, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    }),
  );
  return path;
}

const PRINT_SETTLE_MS = 400;

function writeNamedPdfTab(tab: Window, blobUrl: string, filename: string): void {
  const title = filename.replace(/\.pdf$/i, '');
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  tab.document.write(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${esc(title)}</title>` +
      `<style>html,body{margin:0;height:100%;background:#3a3a3a}` +
      `iframe{border:0;width:100%;height:100%;display:block}` +
      `.bar{position:fixed;right:14px;top:10px;z-index:2;display:flex;gap:8px}` +
      `.bar a,.bar button{font:600 12px/1 system-ui,sans-serif;background:#0f766e;color:#fff;padding:8px 12px;border-radius:6px;text-decoration:none;border:0;cursor:pointer}</style>` +
      `</head><body>` +
      `<div class="bar"><button type="button" data-print>Print</button>` +
      `<a href="${esc(blobUrl)}" download="${esc(filename)}">Download PDF</a></div>` +
      `<iframe src="${esc(blobUrl)}" title="${esc(title)}"></iframe>` +
      `</body></html>`,
  );
  tab.document.close();
  const frame = tab.document.querySelector('iframe');
  const printFrame = () => {
    try {
      frame?.contentWindow?.focus();
      frame?.contentWindow?.print();
    } catch {
    }
  };
  tab.document.querySelector('[data-print]')?.addEventListener('click', printFrame);
}

/** The lines of a multi-line setting: trimmed, blank lines dropped. */
export const settingLines = (text: string | null | undefined): string[] =>
  String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Where to pay (Settings › Branding, per company): a titled block of the
    lines as typed; nothing when blank. Moves to a fresh page when the block
    would not clear the foot. Returns the next y. */
export function drawPaymentDetails(doc: import('jspdf').jsPDF, y: number, text: string | null | undefined, marginX = 14): number {
  const lines = settingLines(text);
  if (lines.length === 0) return y;
  const pageH = doc.internal.pageSize.getHeight();
  const need = 6 + lines.length * 4;
  if (y + need > pageH - 40) { doc.addPage(); y = marginX; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(0);
  doc.text('PAYMENT DETAILS', marginX, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.text(lines, marginX, y + 4);
  return y + 4 + lines.length * 4 + 2;
}

/** Terms & conditions (Settings › Branding): one term per line, numbered and
    wrapped; nothing when blank. Returns the next y. */
export function drawTermsBlock(doc: import('jspdf').jsPDF, y: number, text: string | null | undefined, marginX = 14): number {
  const terms = settingLines(text);
  if (terms.length === 0) return y;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
  const wrapped = terms.map((t, i) => doc.splitTextToSize(`${i + 1}. ${t}`, pageW - marginX * 2) as string[]);
  const need = 6 + wrapped.reduce((sum, w) => sum + w.length * 3.2 + 0.8, 0);
  if (y + need > pageH - 40) { doc.addPage(); y = marginX; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(0);
  doc.text('TERMS & CONDITIONS', marginX, y);
  y += 4;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
  for (const w of wrapped) { doc.text(w, marginX, y); y += w.length * 3.2 + 0.8; }
  doc.setTextColor(0);
  return y + 2;
}
