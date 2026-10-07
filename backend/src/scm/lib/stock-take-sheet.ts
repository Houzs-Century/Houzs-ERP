// stock-take-sheet — reading a counted paper count sheet back into its take
// (owner 2026-10-06: print the sheet, count on paper, photo it, the counts and
// the racks come back). Pure: the model's rows in, proposals out. The route
// (routes/stock-take-sheet-read.ts) does the I/O and writes NOTHING — the page
// shows these proposals and the counter applies them.
//
// Matching never guesses:
//   1. the printed row number (#) names the line, IF that line's item code is
//      the code read on the same row (the # is the print order, which a line
//      added after printing can shift);
//   2. else the item code, IF exactly one line carries it;
//   3. else the row is returned unmatched with the reason.

export type SheetRow = {
  no: number | null;
  itemCode: string | null;
  counted: number | null;
  rack: string | null;
  unclear: boolean;
};

export type SheetLine = { id: string; item_code: string; variant_label: string | null };
export type SheetRack = { id: string; rack: string };

export type SheetProposal = {
  lineId: string;
  no: number | null;
  itemCode: string;
  variantLabel: string | null;
  counted: number | null;
  rackText: string | null;
  rackId: string | null;
  unclear: boolean;
};

export type SheetUnmatched = {
  no: number | null;
  itemCode: string | null;
  counted: number | null;
  rackText: string | null;
  reason: 'not_on_sheet' | 'ambiguous_code' | 'duplicate_row' | 'no_code';
};

/** Item codes as compared: case and whitespace do not count ("AK-HP SL MOB" = "ak-hp  sl mob"). */
export const normCode = (s: string): string => s.toUpperCase().replace(/\s+/g, '');

/** "Rack L5.1", "rack l5.1", "L5.1 " → "L5.1". */
export const normRack = (s: string): string =>
  s.toUpperCase().replace(/^\s*RACK\b/, '').replace(/\s+/g, '');

/** The rack a written label names among THIS warehouse's racks; null when none or several. */
export const resolveRack = (text: string | null, racks: readonly SheetRack[]): string | null => {
  if (!text || !text.trim()) return null;
  const want = normRack(text);
  if (!want) return null;
  const hits = racks.filter((r) => normRack(r.rack) === want);
  return hits.length === 1 ? hits[0]!.id : null;
};

/** The model's JSON → clean rows. Anything malformed is dropped, never coerced into a count. */
export const normalizeSheetRows = (raw: unknown): SheetRow[] => {
  const rows = (raw as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return [];
  const out: SheetRow[] = [];
  for (const item of rows as unknown[]) {
    if (item == null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const noN = Number(r.no);
    const countedN = r.counted == null || r.counted === '' ? null : Number(r.counted);
    const counted = countedN != null && Number.isInteger(countedN) && countedN >= 0 ? countedN : null;
    const rack = typeof r.rack === 'string' && r.rack.trim() ? r.rack.trim() : null;
    const itemCode = typeof r.itemCode === 'string' && r.itemCode.trim() ? r.itemCode.trim() : null;
    if (counted == null && rack == null) continue; // nothing written on this row
    out.push({
      no: Number.isInteger(noN) && noN > 0 ? noN : null,
      itemCode,
      counted,
      rack,
      // A number the model could not read cleanly is flagged, and a count it
      // returned as not-an-integer is no count at all.
      unclear: r.unclear === true || (countedN != null && counted == null),
    });
  }
  return out;
};

/** Rows → proposals against the take's lines, in PRINT order (the order the sheet numbered them). */
export const matchSheetRows = (
  rows: readonly SheetRow[],
  linesInPrintOrder: readonly SheetLine[],
  racks: readonly SheetRack[],
): { proposals: SheetProposal[]; unmatched: SheetUnmatched[] } => {
  const byCode = new Map<string, SheetLine[]>();
  for (const l of linesInPrintOrder) {
    const k = normCode(l.item_code);
    byCode.set(k, [...(byCode.get(k) ?? []), l]);
  }
  const taken = new Set<string>();
  const proposals: SheetProposal[] = [];
  const unmatched: SheetUnmatched[] = [];
  for (const row of rows) {
    const miss = (reason: SheetUnmatched['reason']) =>
      unmatched.push({ no: row.no, itemCode: row.itemCode, counted: row.counted, rackText: row.rack, reason });
    let line: SheetLine;
    const atNo = row.no != null ? linesInPrintOrder[row.no - 1] : undefined;
    if (atNo && (row.itemCode == null || normCode(atNo.item_code) === normCode(row.itemCode))) {
      line = atNo;
    } else if (row.itemCode != null) {
      const same = byCode.get(normCode(row.itemCode)) ?? [];
      if (same.length === 1) line = same[0];
      else { miss(same.length === 0 ? 'not_on_sheet' : 'ambiguous_code'); continue; }
    } else {
      miss('no_code');
      continue;
    }
    if (taken.has(line.id)) { miss('duplicate_row'); continue; }
    taken.add(line.id);
    proposals.push({
      lineId: line.id,
      no: row.no,
      itemCode: line.item_code,
      variantLabel: line.variant_label,
      counted: row.counted,
      rackText: row.rack,
      rackId: resolveRack(row.rack, racks),
      unclear: row.unclear,
    });
  }
  return { proposals, unmatched };
};

export const SHEET_READ_PROMPT = `This is a photo (or scan) of ONE page of a printed STOCK TAKE count sheet.
Its table columns are: #, Item, Description, Variant, System, Counted, Rack, Notes.
The printed parts are typed. The counter has HANDWRITTEN numbers in the Counted column and rack labels (like "L5.1", "R12.2") in the Rack column.

Return ONLY a JSON object, no prose:
{"takeNo": string | null, "rows": [{"no": number, "itemCode": string, "counted": number | null, "rack": string | null, "unclear": boolean}]}

Rules:
- takeNo: the printed "STK No" at the top right (e.g. "HC-STK-2610-002"), or null if this page does not show it.
- Include a row ONLY if something is handwritten in its Counted or Rack cell.
- no: the printed row number in the # column. itemCode: the printed Item text exactly as printed.
- counted: the handwritten whole number. A dash, a tick or "0" written as zero means 0. Blank means null.
- rack: the handwritten rack label exactly as written, or null if blank.
- If a handwritten number or label is hard to read, give your best reading AND set "unclear": true. Never invent a value for an empty cell.`;
