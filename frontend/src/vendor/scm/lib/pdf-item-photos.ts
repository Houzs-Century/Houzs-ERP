// ----------------------------------------------------------------------------
// pdf-item-photos — line photos on printed documents (SO + PO PDFs).
//
// Owner-approved mockup (2026-08) + his live-print QA (2026-08-28): a table
// row carries NO image — a line that has photos appends " (photo)" to its
// first description line, and ONE "ITEM PHOTOS" block per document maps
// printed row numbers to their reference shots. Each group = a row-number
// chip ("Item 1", or a range "Item 2-4" when consecutive rows share the exact
// same photo set — the sofa-set build photo prints ONCE per set), a small
// item/supplier code, and uniform ~52mm square thumbnails (max 3 per row,
// then wrap). Groups flow left-to-right and wrap; a group NEVER splits across
// pages — when it does not fit, the whole group moves to the next page under
// a continued heading.
//
// EVERY generated string here is deliberately WinAnsi-only. The v1 heading
// carried 「照片对照」 and the marker 「(图)」, and ensurePdfCjkFont's
// whole-document family redirect then swapped EVERY photo-carrying PDF —
// including pure-English ones — off helvetica onto the CJK face. The owner
// caught it on his first live print ("为什么是这样中文字的"). English-only
// generated text keeps documents without Chinese CONTENT on their normal
// face; documents whose own data carries Chinese still switch, as they
// always did.
//
// This module holds the pure logic (grouping, packing, page-fit math) plus the
// fetch/transcode/draw plumbing, so sales-order-pdf.ts and
// purchase-order-pdf.ts share ONE implementation. Everything network- or
// canvas-shaped is injectable or fail-soft: a photo that cannot be fetched,
// decoded, or re-encoded is skipped silently — the PDF never fails because of
// a photo.
//
// FORMAT REALITY (why the canvas transcode exists): jsPDF embeds only
// JPEG/PNG, but the `.thumb` siblings the client pipeline uploads are WebP
// whenever the browser can encode it (imagePipeline.renderScaled prefers
// image/webp). So the bytes are normalised here — decoded via
// createImageBitmap and re-encoded to a small square JPEG — which also gives
// the uniform square tiles the mockup shows without distorting aspect ratio
// (centre-crop). Only `.thumb` objects are ever fetched, never originals:
// embedding phone-camera originals would balloon the PDF.
// ----------------------------------------------------------------------------

/** Appended to a photo-carrying line's first description line. WinAnsi only —
 *  see the header: one CJK char here re-fonts every photo-carrying PDF. */
export const PHOTO_MARKER = ' (photo)';

export const ITEM_PHOTOS_HEADING = 'ITEM PHOTOS';
export const ITEM_PHOTOS_HEADING_CONT = 'ITEM PHOTOS (cont.)';

// Layout constants (mm). Owner live-print QA 2026-08-28: v1's 26mm tiles were
// "太小了 我要大一倍" — 52mm squares now, so a row of THREE fills the 182mm
// A4 measure (3 x 52 + 2 x 2 = 160) the way six 26mm tiles used to.
export const THUMB_MM = 52;
export const THUMB_GAP_MM = 2;
export const MAX_THUMBS_PER_ROW = 3;
/** Chip + code line above a group's thumbnails. */
export const GROUP_HEADER_MM = 5;
/** Block heading line ("ITEM PHOTOS"). */
export const HEADING_MM = 7;
export const GROUP_GAP_X_MM = 6;
export const GROUP_GAP_Y_MM = 4;
/** Narrowest beside-zone worth using: the heading + a one-thumb group. */
export const MIN_SIDE_W_MM = THUMB_MM + 2;

/** Normalise a photo_urls-ish value to the list of non-empty R2 keys. */
export function photoKeysOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((k): k is string => typeof k === 'string' && k.trim() !== '');
}

/** Return `lines` with the photo marker appended to the FIRST line. */
export function appendPhotoMarker(lines: readonly string[]): string[] {
  if (lines.length === 0) return [PHOTO_MARKER.trim()];
  return [`${lines[0]}${PHOTO_MARKER}`, ...lines.slice(1)];
}

export type PhotoGroupInput = {
  /** The small code printed beside the chip (item code / supplier code). */
  code: string;
  /** The line's photo keys, printed order preserved. */
  photoKeys: string[];
};

export type PhotoGroup = {
  /** Printed row-number chip: "Item 3", or "Item 2-4" for a merged run —
   *  the owner's wording ("不要放#1 放item 1"), matching the table's own
   *  row numbers. */
  chip: string;
  code: string;
  photoKeys: string[];
};

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/* Label for a merged range: the codes' common prefix when it is meaningful
   (a sofa set's module lines read "XAMMAR-L(LHF)", "XAMMAR-2A"… → "XAMMAR"),
   else the first line's code. */
export function rangeLabel(codes: readonly string[]): string {
  const first = codes[0] ?? '';
  if (codes.length <= 1) return first;
  let prefix = first;
  for (const code of codes.slice(1)) {
    let len = 0;
    while (len < prefix.length && len < code.length && prefix[len] === code[len]) len += 1;
    prefix = prefix.slice(0, len);
    if (prefix === '') break;
  }
  const trimmed = prefix.replace(/[-_\s/]+$/, '');
  return trimmed.length >= 3 ? trimmed : first;
}

/**
 * Build the photo groups for one document. `rows` is EVERY printed line in
 * printed order (row number = index + 1); photo-less rows produce no group.
 * Consecutive rows whose photo lists are deep-equal merge into one range
 * group, so a sofa set's shared build photo prints once per set.
 */
export function buildPhotoGroups(rows: readonly PhotoGroupInput[]): PhotoGroup[] {
  const groups: PhotoGroup[] = [];
  let i = 0;
  while (i < rows.length) {
    const keys = rows[i]!.photoKeys;
    if (keys.length === 0) { i += 1; continue; }
    let j = i;
    while (j + 1 < rows.length && sameKeys(rows[j + 1]!.photoKeys, keys)) j += 1;
    groups.push({
      chip: j > i ? `Item ${i + 1}-${j + 1}` : `Item ${i + 1}`,
      code: rangeLabel(rows.slice(i, j + 1).map((r) => r.code)),
      photoKeys: [...keys],
    });
    i = j + 1;
  }
  return groups;
}

/** First line that lists each key owns its fetch (the proxy authorises a key
 *  against ONE line's photo_urls; shared sofa-set keys appear on several). */
export function photoKeyOwners(
  rows: ReadonlyArray<{ id: string | null | undefined; photoKeys: readonly string[] }>,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const row of rows) {
    const id = (row.id ?? '').trim();
    if (!id) continue;
    for (const key of row.photoKeys) {
      if (!owners.has(key)) owners.set(key, id);
    }
  }
  return owners;
}

/** Thumb grid for `count` photos: up to 6 columns, then wrap. */
export function groupGridSize(count: number): { cols: number; rows: number } {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return { cols: 0, rows: 0 };
  return { cols: Math.min(n, MAX_THUMBS_PER_ROW), rows: Math.ceil(n / MAX_THUMBS_PER_ROW) };
}

/** Outer box (mm) one group occupies: header line + its thumb grid. */
export function groupBoxSize(count: number): { w: number; h: number } {
  const { cols, rows } = groupGridSize(count);
  if (cols === 0) return { w: 0, h: 0 };
  return {
    w: cols * THUMB_MM + (cols - 1) * THUMB_GAP_MM,
    h: GROUP_HEADER_MM + rows * THUMB_MM + (rows - 1) * THUMB_GAP_MM,
  };
}

export type PhotoRegion = { x: number; y: number; w: number; bottom: number };
export type PhotoPlacement = { x: number; y: number; page: number };

/**
 * Pure page-fit math. Flows group boxes left-to-right through `regions` (in
 * order — e.g. the PO's beside-the-sofa zone, then the full-width zone below
 * it), wrapping rows within a region; a box that does not fit moves WHOLE to
 * the next region, and past the last region onto added pages shaped like
 * `pageRegion`. `page` in a placement is 0 for the current page, 1.. for each
 * page the caller must add.
 */
export function layoutPhotoGroups(
  sizes: ReadonlyArray<{ w: number; h: number }>,
  regions: readonly PhotoRegion[],
  pageRegion: PhotoRegion,
): { placements: PhotoPlacement[]; pagesAdded: number; endY: number } {
  const placements: PhotoPlacement[] = [];
  if (regions.length === 0) return { placements, pagesAdded: 0, endY: pageRegion.y };
  let page = 0;
  let regionIdx = 0;
  let region = regions[0]!;
  let curX = 0;
  let rowTop = region.y;
  let rowH = 0;
  for (const s of sizes) {
    let hops = 0;
    for (;;) {
      if (curX > 0 && curX + s.w > region.w) {
        rowTop += rowH + GROUP_GAP_Y_MM;
        curX = 0;
        rowH = 0;
      }
      const fits = curX + s.w <= region.w && rowTop + s.h <= region.bottom;
      /* A group bigger than a whole fresh page can never fit anywhere: place
         it at the top of a fresh page rather than loop forever (needs ~60
         photos on one line — not a real document, but not an infinite loop
         either). */
      const lastResort = hops > regions.length && curX === 0 && rowTop === region.y;
      if (fits || lastResort) {
        placements.push({ x: region.x + curX, y: rowTop, page });
        curX += s.w + GROUP_GAP_X_MM;
        if (s.h > rowH) rowH = s.h;
        break;
      }
      hops += 1;
      if (regionIdx + 1 < regions.length) {
        regionIdx += 1;
        region = regions[regionIdx]!;
      } else {
        page += 1;
        region = pageRegion;
      }
      curX = 0;
      rowTop = region.y;
      rowH = 0;
    }
  }
  return { placements, pagesAdded: page, endY: rowTop + rowH };
}

/* ── Image bytes → something jsPDF can embed ─────────────────────────────── */

export type PdfPhotoImage = { dataUrl: string; format: 'JPEG' | 'PNG' };

/** Magic-byte sniff — R2 serves pre-pipeline objects as octet-stream, so the
 *  declared type cannot be trusted. Returns null for anything unrecognised. */
export function sniffImageMime(
  bytes: Uint8Array,
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  return null;
}

/** Rendered pixel size of an embedded thumb (square). 512px across 52mm is
 *  ~250dpi — crisp in print, ~30-70 kB per JPEG in the file. */
export const PDF_THUMB_PX = 512;

/**
 * Decode any browser-displayable image blob and re-encode it as a small
 * square (centre-cropped) JPEG data URL for jsPDF. Returns null on ANY
 * failure — undecodable bytes, no canvas in this environment — and never
 * throws; the caller skips the photo.
 */
export async function blobToSquarePdfImage(blob: Blob): Promise<PdfPhotoImage | null> {
  try {
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const declared = (blob.type || '').toLowerCase();
    const mime = declared.startsWith('image/') ? declared : sniffImageMime(bytes);
    if (!mime) return null;
    const typed = declared === mime ? blob : new Blob([bytes], { type: mime });
    const bitmap = await createImageBitmap(typed);
    try {
      const side = Math.min(bitmap.width, bitmap.height);
      if (side <= 0) return null;
      const canvas = document.createElement('canvas');
      canvas.width = PDF_THUMB_PX;
      canvas.height = PDF_THUMB_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // Flatten any alpha onto white — JPEG has no transparency and black
      // squares read as broken photos on paper.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, PDF_THUMB_PX, PDF_THUMB_PX);
      ctx.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        PDF_THUMB_PX,
        PDF_THUMB_PX,
      );
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      if (dataUrl.startsWith('data:image/jpeg')) return { dataUrl, format: 'JPEG' };
      // canvas.toBlob/toDataURL silently fall back to PNG when JPEG encoding
      // is unavailable — jsPDF takes PNG too, so keep it.
      if (dataUrl.startsWith('data:image/png')) return { dataUrl, format: 'PNG' };
      return null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/**
 * Fetch + transcode the groups' `.thumb` bytes BEFORE any drawing starts.
 * `fetchThumbBlob` receives the BASE photo key (the caller appends the
 * `.thumb` suffix and owns auth/endpoint); `toImage` is injected so tests
 * need no canvas. Concurrency-capped; per-photo best-effort — a key whose
 * fetch or transcode fails is simply absent from the result.
 */
export async function collectPhotoImages(
  groups: readonly PhotoGroup[],
  fetchThumbBlob: (photoKey: string) => Promise<Blob>,
  toImage: (blob: Blob) => Promise<PdfPhotoImage | null>,
  concurrency = 4,
): Promise<Map<string, PdfPhotoImage>> {
  const keys = [...new Set(groups.flatMap((g) => g.photoKeys))];
  const out = new Map<string, PdfPhotoImage>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < keys.length) {
      const key = keys[next]!;
      next += 1;
      try {
        const img = await toImage(await fetchThumbBlob(key));
        if (img) out.set(key, img);
      } catch {
        // Skipped silently — a missing/broken thumb must never fail the PDF.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, keys.length) }, () => worker()),
  );
  return out;
}

/* ── Drawing ─────────────────────────────────────────────────────────────── */

/** The narrow slice of jsPDF the block draws through — structural, so tests
 *  can drive the real layout/paging behaviour with a recording stub. */
export type PdfDocLike = {
  addPage(): unknown;
  setFont(family: string, style?: string): unknown;
  setFontSize(size: number): unknown;
  setTextColor(color: number): unknown;
  setDrawColor(color: number): unknown;
  setLineWidth(width: number): unknown;
  text(text: string, x: number, y: number): unknown;
  rect(x: number, y: number, w: number, h: number): unknown;
  addImage(dataUrl: string, format: string, x: number, y: number, w: number, h: number): unknown;
  getTextWidth(text: string): number;
};

function fitText(doc: PdfDocLike, text: string, maxW: number): string {
  if (doc.getTextWidth(text) <= maxW) return text;
  const ellipsis = '…';
  let t = text;
  while (t.length > 1 && doc.getTextWidth(t + ellipsis) > maxW) t = t.slice(0, -1);
  return t + ellipsis;
}

function drawHeadingText(doc: PdfDocLike, text: string, x: number, y: number): void {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(0);
  doc.text(text, x, y + 4);
}

function drawGroup(
  doc: PdfDocLike,
  group: PhotoGroup,
  images: ReadonlyMap<string, PdfPhotoImage>,
  x: number,
  y: number,
): void {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(0);
  doc.text(group.chip, x, y + 3.2);
  const chipW = doc.getTextWidth(group.chip);
  const { w } = groupBoxSize(group.photoKeys.length);
  const codeMax = w - chipW - 2;
  if (group.code && codeMax > 4) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(110);
    doc.text(fitText(doc, group.code, codeMax), x + chipW + 2, y + 3.2);
    doc.setTextColor(0);
  }
  // Thin ink border only — printed documents carry no decorative fills
  // (pdf-common DOC_TABLE_STYLES rule, owner 2026-08-07).
  doc.setDrawColor(120);
  doc.setLineWidth(0.2);
  group.photoKeys.forEach((key, i) => {
    const img = images.get(key);
    if (!img) return;
    const col = i % MAX_THUMBS_PER_ROW;
    const row = Math.floor(i / MAX_THUMBS_PER_ROW);
    const tx = x + col * (THUMB_MM + THUMB_GAP_MM);
    const ty = y + GROUP_HEADER_MM + row * (THUMB_MM + THUMB_GAP_MM);
    try {
      doc.addImage(img.dataUrl, img.format, tx, ty, THUMB_MM, THUMB_MM);
      doc.rect(tx, ty, THUMB_MM, THUMB_MM);
    } catch {
      // Per-photo best-effort — a bad image skips its tile, never the doc.
    }
  });
}

export type DrawPhotoBlockOpts = {
  margin: number;
  contentW: number;
  /** Top of the full-width zone (below whatever the document drew last). */
  startY: number;
  /** Last usable y on a page before the footer zone. */
  pageBottom: number;
  /** Where a continued page's heading starts. */
  pageTop: number;
  /** Optional beside-zone (the PO lays groups beside the sofa layout);
      null = full-width only. */
  side: PhotoRegion | null;
  /** Called right after each addPage (the PO repaints its page header);
      null = nothing beyond the continued heading. */
  onNewPage: (() => void) | null;
};

/**
 * Draw the ITEM PHOTOS block. Groups are filtered to photos that actually
 * fetched; when nothing is drawable the document is untouched and
 * `drew: false` comes back. `endY` is the block's bottom on the page the doc
 * is left on (the last added page when `pagesAdded > 0`).
 */
export function drawItemPhotosBlock(
  doc: PdfDocLike,
  groups: readonly PhotoGroup[],
  images: ReadonlyMap<string, PdfPhotoImage>,
  opts: DrawPhotoBlockOpts,
): { drew: boolean; endY: number; pagesAdded: number } {
  const drawable = groups
    .map((g) => ({ ...g, photoKeys: g.photoKeys.filter((k) => images.has(k)) }))
    .filter((g) => g.photoKeys.length > 0);
  if (drawable.length === 0) return { drew: false, endY: opts.startY, pagesAdded: 0 };

  const side = opts.side;
  const useSide =
    side !== null &&
    side.w >= MIN_SIDE_W_MM &&
    side.bottom - side.y >= HEADING_MM + GROUP_HEADER_MM + THUMB_MM;
  const regions: PhotoRegion[] = useSide
    ? [
        { x: side.x, y: side.y + HEADING_MM, w: side.w, bottom: side.bottom },
        { x: opts.margin, y: opts.startY, w: opts.contentW, bottom: opts.pageBottom },
      ]
    : [{ x: opts.margin, y: opts.startY + HEADING_MM, w: opts.contentW, bottom: opts.pageBottom }];
  const pageRegion: PhotoRegion = {
    x: opts.margin,
    y: opts.pageTop + HEADING_MM,
    w: opts.contentW,
    bottom: opts.pageBottom,
  };

  const sizes = drawable.map((g) => groupBoxSize(g.photoKeys.length));
  const { placements, pagesAdded, endY } = layoutPhotoGroups(sizes, regions, pageRegion);

  drawHeadingText(
    doc,
    ITEM_PHOTOS_HEADING,
    useSide ? side.x : opts.margin,
    useSide ? side.y : opts.startY,
  );
  let curPage = 0;
  drawable.forEach((group, gi) => {
    const p = placements[gi]!;
    while (curPage < p.page) {
      doc.addPage();
      curPage += 1;
      if (opts.onNewPage) opts.onNewPage();
      drawHeadingText(doc, ITEM_PHOTOS_HEADING_CONT, opts.margin, opts.pageTop);
    }
    drawGroup(doc, group, images, p.x, p.y);
  });
  doc.setTextColor(0);
  return { drew: true, endY, pagesAdded };
}
