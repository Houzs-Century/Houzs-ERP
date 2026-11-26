// ---------------------------------------------------------------------------
// mcp-xlsx.ts — a minimal .xlsx writer for the AI Connector's export_excel
// (services/mcp-round3.ts). The backend has no spreadsheet library and the
// Worker bundle should not carry one, so this builds the five XML parts of an
// Office Open XML workbook and zips them (deflate-raw via CompressionStream,
// which Workers and Node both have). One sheet, a bold header row, column
// widths from the content, money columns in RM with 2 decimals.
//
// Pure functions except the zip's compression step (async).
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

export type XlsxColumn = { key: string; header: string; money: boolean };
export const MAX_COLUMNS = 60;

/** A money key in the ERP: integer sen (`total_sen`, `amountSen`). */
export const isSenKey = (k: string): boolean => /(_sen|Sen)$/.test(k);

/** "total_sen" → "total (RM)", "amountSen" → "amount (RM)". */
export function moneyHeader(k: string): string {
  return `${k.replace(/(_sen|Sen)$/, "")} (RM)`;
}

/**
 * One flat record per row: scalars as they are, a nested object one level deep
 * as "parent.child" (supplier.name), arrays left out (line items belong in their
 * own export).
 */
export function flattenRow(row: unknown): Obj {
  const out: Obj = {};
  if (!row || typeof row !== "object" || Array.isArray(row)) return out;
  for (const [k, v] of Object.entries(row as Obj)) {
    if (Array.isArray(v)) continue;
    if (v && typeof v === "object") {
      for (const [k2, v2] of Object.entries(v as Obj)) {
        if (v2 === null || v2 === undefined || typeof v2 !== "object") out[`${k}.${k2}`] = v2;
      }
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** The columns: first-seen order over the rows, narrowed to `fields` when given (a field matches a key or a "parent." prefix). */
export function pickColumns(rows: readonly Obj[], fields: readonly string[]): XlsxColumn[] {
  const seen: string[] = [];
  const has = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!has.has(k)) {
        has.add(k);
        seen.push(k);
      }
    }
  }
  const wanted = fields.length ? seen.filter((k) => fields.some((f) => k === f || k.startsWith(`${f}.`) || k.endsWith(`.${f}`))) : seen;
  return wanted.slice(0, MAX_COLUMNS).map((key) => ({ key, header: isSenKey(key) ? moneyHeader(key) : key, money: isSenKey(key) }));
}

// ── XML ─────────────────────────────────────────────────────────────────────

/** Escape for XML text, dropping characters XML 1.0 forbids. */
export function xmlText(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex -- removing the control characters XML 1.0 forbids is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const MAX_CELL_CHARS = 32_000; // Excel's cell limit is 32,767

/** A cell's display value: money sen → RM number; numbers stay numbers; the rest text. */
export function cellValue(col: XlsxColumn, v: unknown): { kind: "n"; n: number } | { kind: "s"; s: string } | null {
  if (v === null || v === undefined || v === "") return null;
  if (col.money) {
    const n = Number(v);
    return Number.isFinite(n) ? { kind: "n", n: Math.round(n) / 100 } : { kind: "s", s: String(v) };
  }
  if (typeof v === "number" && Number.isFinite(v)) return { kind: "n", n: v };
  if (typeof v === "boolean") return { kind: "s", s: v ? "Yes" : "No" };
  return { kind: "s", s: String(v).slice(0, MAX_CELL_CHARS) };
}

/** Column widths in characters, from the header and the first 500 rows, 8..60. */
export function columnWidths(cols: readonly XlsxColumn[], rows: readonly Obj[]): number[] {
  return cols.map((c) => {
    let w = c.header.length;
    for (const r of rows.slice(0, 500)) {
      const v = cellValue(c, r[c.key]);
      const len = !v ? 0 : v.kind === "n" ? (c.money ? v.n.toFixed(2).length + 3 : String(v.n).length) : v.s.length;
      if (len > w) w = len;
    }
    return Math.min(60, Math.max(8, w + 2));
  });
}

export function sheetXml(cols: readonly XlsxColumn[], rows: readonly Obj[]): string {
  const widths = columnWidths(cols, rows);
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  parts.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  if (cols.length) parts.push(`<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`);
  parts.push("<sheetData>");
  parts.push(`<row r="1">${cols.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${xmlText(c.header)}</t></is></c>`).join("")}</row>`);
  rows.forEach((r, ri) => {
    const rn = ri + 2;
    const cells: string[] = [];
    cols.forEach((c, ci) => {
      const v = cellValue(c, r[c.key]);
      if (!v) return;
      const ref = `${colName(ci)}${rn}`;
      if (v.kind === "n") cells.push(`<c r="${ref}"${c.money ? ' s="2"' : ""}><v>${v.n}</v></c>`);
      else cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(v.s)}</t></is></c>`);
    });
    parts.push(`<row r="${rn}">${cells.join("")}</row>`);
  });
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
// Style 0 plain, 1 bold header, 2 money (#,##0.00 = built-in format 4).
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

const workbookXml = (sheetName: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

/** Excel sheet names: at most 31 characters, none of []:*?/\ . */
export const safeSheetName = (s: string): string => s.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet1";

// ── zip ─────────────────────────────────────────────────────────────────────

let CRC_TABLE: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A zip archive of the given files (deflate). Sizes stay well under 4 GB, so no zip64. */
export async function zip(files: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    // eslint-disable-next-line no-await-in-loop -- five small parts, one after another keeps the offsets simple
    const comp = await deflateRaw(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, 8, true); // deflate
    lh.setUint16(10, 0, true);
    lh.setUint16(12, 0x21, true); // 1980-01-01
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 8, true);
    ch.setUint16(12, 0, true);
    ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + comp.length;
  }
  const centralSize = centrals.reduce((n, a) => n + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

/** The workbook: one sheet named `sheetName`, the header row, then the rows. */
export async function buildXlsx(sheetName: string, cols: readonly XlsxColumn[], rows: readonly Obj[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  return zip([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(ROOT_RELS) },
    { name: "xl/workbook.xml", data: enc.encode(workbookXml(safeSheetName(sheetName))) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(WORKBOOK_RELS) },
    { name: "xl/styles.xml", data: enc.encode(STYLES) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheetXml(cols, rows)) },
  ]);
}
