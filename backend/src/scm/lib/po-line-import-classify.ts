/* PO line import — the decisions, with no database in them.
 *
 * routes/po-line-import.ts reads the rows this needs and hands them over; every
 * rule about what a row MEANS lives here so it can be tested row by row. The
 * columns and the parsing are the shared module's (po-line-import.ts, mirrored in the frontend). */
import {
  PO_LINE_IMPORT_FIELDS,
  PO_LINE_IMPORT_MAX_LINE_CHANGES,
  PO_LINE_IMPORT_MAX_PO_CHANGES,
  PO_LINE_IMPORT_MAX_ROWS,
  isPoLineImportField,
  parseImportValue,
  poLineImportSpec,
  storedImportValue,
  type PoLineImportApplyBody,
  type PoLineImportCell,
  type PoLineImportChange,
  type PoLineImportConflict,
  type PoLineImportField,
  type PoLineImportLineChange,
  type PoLineImportPoChange,
  type PoLineImportPoRejection,
  type PoLineImportPreview,
  type PoLineImportRejectCode,
  type PoLineImportRow,
  type PoLineImportRowResult,
} from './po-line-import';
import { poLineDescription2 } from './po-line-description2';

/** What the exported file showed for a LINE field: Item Description 2 is the
 *  variant summary, else the stored text (po-line-description2.ts); every other
 *  line field is its stored column. */
const lineFieldNow = (field: PoLineImportField, line: ImportLineRow): string | null =>
  field === 'description2'
    ? storedImportValue(field, poLineDescription2(line.item_group as string | null, line.variants, line.description2 as string | null))
    : storedImportValue(field, line[poLineImportSpec(field).column]);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A purchase_order_items row as the importer reads it. */
export type ImportLineRow = {
  id: string;
  purchase_order_id: string;
  item_code: string | null;
} & Record<string, unknown>;

/** A purchase_orders row as the importer reads it. */
export type ImportPoRow = {
  id: string;
  po_number: string;
  revision: number | null;
  status: string | null;
} & Record<string, unknown>;

export type ImportWorld = {
  /** Lines found IN the active company, by id. */
  lines: Map<string, ImportLineRow>;
  /** Line ids that exist but belong to another company. */
  otherCompanyLineIds: Set<string>;
  pos: Map<string, ImportPoRow>;
  /** The downstream-lock refusal per PO (a live Goods Receipt), or null when open. */
  poLocks: Map<string, string | null>;
  /** Every line of each touched PO: the cascade overwrites all of them. */
  poLines: Map<string, ImportLineRow[]>;
};

/* The number staff see. A revised PO prints as <po_number>_R<revision-1>
   (vendor/scm/lib/po-status.ts poDisplayNumber), and the grid's Doc No column is
   AutoCount's number when the PO is linked (owner 2026-09-15), so an export may
   carry any of the three. */
const docNoMatches = (fileDocNo: string, po: ImportPoRow): boolean => {
  const f = fileDocNo.trim().toUpperCase();
  const ac = String(po.linked_ac_docno ?? '').trim().toUpperCase();
  if (ac !== '' && f === ac) return true;
  const base = String(po.po_number ?? '').trim().toUpperCase();
  if (f === base) return true;
  const rev = Number(po.revision ?? 1);
  return rev > 1 && f === `${base}_R${rev - 1}`;
};

/** Why a PO refuses edits to its lines, in the same order the PO screen decides it. */
export function poEditRefusal(po: ImportPoRow, lock: string | null): { code: PoLineImportRejectCode; reason: string } | null {
  const s = String(po.status ?? '').toUpperCase();
  if (s === 'CANCELLED') return { code: 'po_cancelled', reason: `${po.po_number} is cancelled.` };
  if (s === 'RECEIVED') return { code: 'po_received', reason: `${po.po_number} has status RECEIVED (everything ordered came in); its lines are locked.` };
  if (s !== 'DRAFT' && s !== 'SUBMITTED' && s !== 'PARTIALLY_RECEIVED') {
    return { code: 'po_locked', reason: `${po.po_number} is ${s || 'in an unknown status'}; its lines cannot be edited.` };
  }
  if (lock) return { code: 'po_locked', reason: `${po.po_number}: ${lock}` };
  return null;
}

const headerOf = (f: PoLineImportField): string => poLineImportSpec(f).header;

type PoEntry = { rowNumber: number; itemCode: string | null; value: string | null; current: string | null; invalid: boolean };

export function classifyPoLineImport(rows: PoLineImportRow[], world: ImportWorld): PoLineImportPreview {
  const results: PoLineImportRowResult[] = [];
  const lineChanges: PoLineImportLineChange[] = [];
  const seen = new Set<string>();
  /* poId -> field -> what every row of that PO says */
  const agg = new Map<string, Map<PoLineImportField, PoEntry[]>>();
  const pushAgg = (poId: string, field: PoLineImportField, e: PoEntry) => {
    let byField = agg.get(poId);
    if (!byField) agg.set(poId, (byField = new Map()));
    const list = byField.get(field) ?? [];
    list.push(e);
    byField.set(field, list);
  };

  for (const row of rows) {
    const base = { rowNumber: row.rowNumber, docNo: row.docNo, lineId: row.lineId, itemCode: null as string | null };
    const reject = (code: PoLineImportRejectCode, reason: string, itemCode: string | null = null) =>
      results.push({ ...base, itemCode, status: 'rejected', code, reason });

    const lineId = (row.lineId ?? '').trim();
    if (!UUID_RE.test(lineId)) { reject('unknown_line', row.lineId ? `Line ID "${row.lineId}" is not a purchase order line.` : 'Line ID is blank.'); continue; }
    const key = lineId.toLowerCase();
    if (seen.has(key)) { reject('duplicate_line', 'This Line ID appears more than once in the file; only its first row is used.'); continue; }
    seen.add(key);

    const line = world.lines.get(key);
    if (!line) {
      if (world.otherCompanyLineIds.has(key)) reject('other_company', 'This line belongs to another company. Switch to that company to import it.');
      else reject('unknown_line', 'No purchase order line has this Line ID.');
      continue;
    }
    const po = world.pos.get(line.purchase_order_id);
    if (!po) { reject('unknown_line', 'This line has no purchase order in this company.'); continue; }
    const itemCode = line.item_code ?? null;

    if (!row.docNo || !docNoMatches(row.docNo, po)) {
      reject('doc_no_mismatch', row.docNo
        ? `Doc No ${row.docNo} does not match this line's purchase order ${po.po_number}. The row may have been moved; nothing on it is used.`
        : `Doc No is blank; this line belongs to ${po.po_number}.`, itemCode);
      continue;
    }

    const refusal = poEditRefusal(po, world.poLocks.get(po.id) ?? null);
    if (refusal) { reject(refusal.code, refusal.reason, itemCode); continue; }

    const invalid: string[] = [];
    const changes: PoLineImportChange[] = [];
    const poLevel: Array<[PoLineImportField, PoEntry]> = [];
    for (const field of Object.keys(row.values) as PoLineImportField[]) {
      if (!isPoLineImportField(field)) continue;
      const spec = poLineImportSpec(field);
      const parsed = parseImportValue(field, row.values[field] as PoLineImportCell);
      /* An estimate date's cell is exported as the LINE's value, else the PO
         header's (po-line-export-columns.ts poEstimateDeliveryDates); read it back
         the same way, or an untouched file would look edited. */
      const current = spec.level === 'po'
        ? storedImportValue(field, line[spec.column]) ?? storedImportValue(field, po[spec.column])
        : lineFieldNow(field, line);
      if (!parsed.ok) {
        invalid.push(`${spec.header}: ${parsed.reason}`);
        if (spec.level === 'po') poLevel.push([field, { rowNumber: row.rowNumber, itemCode, value: null, current, invalid: true }]);
        continue;
      }
      if (spec.level === 'po') {
        poLevel.push([field, { rowNumber: row.rowNumber, itemCode, value: parsed.value, current, invalid: false }]);
      } else if (parsed.value !== current) {
        changes.push({ field, old: current, new: parsed.value });
      }
    }
    /* A rejected row still speaks for its PO's estimate dates, so a bad date on
       one row cannot let a different date on another row through unchallenged. */
    for (const [field, e] of poLevel) pushAgg(po.id, field, e);

    if (invalid.length > 0) { reject('invalid_value', invalid.join('; '), itemCode); continue; }
    if (changes.length === 0) { results.push({ ...base, itemCode, status: 'unchanged' }); continue; }
    results.push({ ...base, itemCode, status: 'changes', changes });
    for (const ch of changes) lineChanges.push({ lineId: line.id, docNo: po.po_number, ...ch });
  }

  const poChanges: PoLineImportPoChange[] = [];
  const poRejections: PoLineImportPoRejection[] = [];
  for (const [poId, byField] of agg) {
    const po = world.pos.get(poId)!;
    for (const spec of PO_LINE_IMPORT_FIELDS) {
      const entries = byField.get(spec.field);
      if (!entries) continue;
      const valid = entries.filter((e) => !e.invalid);
      const edited = valid.filter((e) => e.value !== e.current);
      if (edited.length === 0) continue;
      const rowNumbers = entries.map((e) => e.rowNumber);
      const bad = entries.filter((e) => e.invalid);
      if (bad.length > 0) {
        poRejections.push({
          docNo: po.po_number, field: spec.field, rowNumbers,
          reason: `${spec.header} is not changed: row ${bad.map((e) => e.rowNumber).join(', ')} of this PO has an invalid date.`,
        });
        continue;
      }
      const distinct = new Set(valid.map((e) => e.value));
      if (distinct.size > 1) {
        poRejections.push({
          docNo: po.po_number, field: spec.field, rowNumbers,
          reason: `${spec.header} belongs to the whole purchase order, but its rows disagree: `
            + valid.map((e) => `row ${e.rowNumber}${e.itemCode ? ` (${e.itemCode})` : ''} ${e.value ?? 'blank'}`).join(', ')
            + '. Give every row of this PO the same date.',
        });
        continue;
      }
      const next = valid[0]!.value;
      const lineValues: Record<string, string | null> = {};
      for (const l of world.poLines.get(poId) ?? []) lineValues[l.id] = storedImportValue(spec.field, l[spec.column]);
      poChanges.push({
        poId, docNo: po.po_number, field: spec.field,
        old: storedImportValue(spec.field, po[spec.column]), new: next, lineValues, rowNumbers,
      });
    }
  }

  const count = (s: PoLineImportRowResult['status']) => results.filter((r) => r.status === s).length;
  return {
    rows: results,
    poChanges,
    poRejections,
    lineChanges,
    counts: {
      rows: results.length,
      changed: count('changes'),
      unchanged: count('unchanged'),
      rejected: count('rejected'),
      poChanges: poChanges.length,
      poRejected: poRejections.length,
    },
  };
}

/** Shape-check a preview request. The file is parsed in the browser; every value is re-parsed here. */
export function parsePreviewBody(body: unknown): { ok: true; rows: PoLineImportRow[] } | { ok: false; error: string; message: string } {
  const b = (body ?? {}) as { rows?: unknown };
  if (!Array.isArray(b.rows) || b.rows.length === 0) return { ok: false, error: 'no_rows', message: 'The file has no rows to import.' };
  if (b.rows.length > PO_LINE_IMPORT_MAX_ROWS) {
    return { ok: false, error: 'too_many_rows', message: `One import takes up to ${PO_LINE_IMPORT_MAX_ROWS} rows; this file has ${b.rows.length}. Split the file.` };
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);
  const rows: PoLineImportRow[] = [];
  for (const [i, raw] of (b.rows as unknown[]).entries()) {
    const r = (raw ?? {}) as { rowNumber?: unknown; docNo?: unknown; lineId?: unknown; values?: unknown };
    const values: PoLineImportRow['values'] = {};
    /* ONLY the six import fields survive. A qty / price / item column in the file,
       edited or not, never gets past this line. */
    if (r.values && typeof r.values === 'object') {
      for (const [k, v] of Object.entries(r.values as Record<string, unknown>)) {
        if (!isPoLineImportField(k)) continue;
        values[k] = v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
      }
    }
    const rowNumber = Number(r.rowNumber);
    rows.push({ rowNumber: Number.isInteger(rowNumber) && rowNumber > 0 ? rowNumber : i + 2, docNo: str(r.docNo), lineId: str(r.lineId), values });
  }
  return { ok: true, rows };
}

/** Shape-check an apply request: only import fields, each at its own level, each value a valid stored shape. */
export function parseApplyBody(body: unknown): { ok: true; req: PoLineImportApplyBody } | { ok: false; error: string; message: string } {
  const b = (body ?? {}) as { lineChanges?: unknown; poChanges?: unknown };
  const lineIn = Array.isArray(b.lineChanges) ? b.lineChanges : [];
  const poIn = Array.isArray(b.poChanges) ? b.poChanges : [];
  if (lineIn.length === 0 && poIn.length === 0) return { ok: false, error: 'no_changes', message: 'There is nothing to import.' };
  if (lineIn.length > PO_LINE_IMPORT_MAX_LINE_CHANGES || poIn.length > PO_LINE_IMPORT_MAX_PO_CHANGES) {
    return {
      ok: false, error: 'too_many_changes',
      message: `One import writes up to ${PO_LINE_IMPORT_MAX_LINE_CHANGES} line changes and ${PO_LINE_IMPORT_MAX_PO_CHANGES} PO date changes. Split the file.`,
    };
  }
  const bad = (message: string) => ({ ok: false as const, error: 'invalid_change', message });
  /* The STORED shape only: null, an ISO day, or trimmed non-blank text. */
  const valueOk = (field: PoLineImportField, v: unknown): v is string | null => {
    if (v === null) return true;
    if (typeof v !== 'string') return false;
    const p = parseImportValue(field, v);
    return p.ok && p.value === v && (poLineImportSpec(field).kind === 'text' || /^\d{4}-\d{2}-\d{2}$/.test(v));
  };
  const lineChanges: PoLineImportLineChange[] = [];
  const seen = new Set<string>();
  for (const raw of lineIn) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const field = r.field;
    if (!isPoLineImportField(field) || poLineImportSpec(field).level !== 'line') return bad(`"${String(field)}" is not a line field an import can change.`);
    if (typeof r.lineId !== 'string' || !UUID_RE.test(r.lineId)) return bad('A change names no valid Line ID.');
    if (!valueOk(field, r.old) || !valueOk(field, r.new)) return bad(`${headerOf(field)} carries an invalid value.`);
    const k = `${r.lineId.toLowerCase()}|${field}`;
    if (seen.has(k)) return bad('The same line field appears twice.');
    seen.add(k);
    lineChanges.push({ lineId: r.lineId.toLowerCase(), docNo: String(r.docNo ?? ''), field, old: r.old, new: r.new });
  }
  const poChanges: PoLineImportApplyBody['poChanges'] = [];
  for (const raw of poIn) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const field = r.field;
    if (!isPoLineImportField(field) || poLineImportSpec(field).level !== 'po') return bad(`"${String(field)}" is not a purchase-order date an import can change.`);
    if (typeof r.poId !== 'string' || !UUID_RE.test(r.poId)) return bad('A PO change names no valid purchase order.');
    if (!valueOk(field, r.old) || !valueOk(field, r.new)) return bad(`${headerOf(field)} carries an invalid value.`);
    const lv = r.lineValues;
    if (!lv || typeof lv !== 'object' || Array.isArray(lv)) return bad('A PO change is missing the line values it was previewed against.');
    const lineValues: Record<string, string | null> = {};
    for (const [id, v] of Object.entries(lv as Record<string, unknown>)) {
      if (!UUID_RE.test(id) || !valueOk(field, v)) return bad('A PO change carries an invalid line value.');
      lineValues[id.toLowerCase()] = v;
    }
    const k = `${r.poId.toLowerCase()}|${field}`;
    if (seen.has(k)) return bad('The same purchase-order date appears twice.');
    seen.add(k);
    poChanges.push({ poId: r.poId.toLowerCase(), docNo: String(r.docNo ?? ''), field, old: r.old, new: r.new, lineValues });
  }
  return { ok: true, req: { lineChanges, poChanges } };
}

/**
 * Re-check a confirmed change set against the CURRENT rows (optimistic lock). Any
 * conflict refuses the whole import: the operator previews again and sees today's
 * values, rather than half a file landing.
 */
export function recheckApply(req: PoLineImportApplyBody, world: ImportWorld): PoLineImportConflict[] {
  const conflicts: PoLineImportConflict[] = [];
  const refusedPos = new Set<string>();
  const refuse = (po: ImportPoRow) => {
    if (refusedPos.has(po.id)) return;
    const r = poEditRefusal(po, world.poLocks.get(po.id) ?? null);
    if (r) { refusedPos.add(po.id); conflicts.push({ docNo: po.po_number, lineId: null, field: null, reason: r.reason }); }
  };
  for (const ch of req.lineChanges) {
    const line = world.lines.get(ch.lineId);
    const po = line ? world.pos.get(line.purchase_order_id) : undefined;
    if (!line || !po) { conflicts.push({ docNo: ch.docNo || null, lineId: ch.lineId, field: ch.field, reason: 'This line is no longer in this company.' }); continue; }
    refuse(po);
    const now = lineFieldNow(ch.field, line);
    if (now !== ch.old) {
      conflicts.push({
        docNo: po.po_number, lineId: ch.lineId, field: ch.field,
        reason: `${headerOf(ch.field)} on ${line.item_code ?? 'this line'} changed since the preview (it is now ${now ?? 'blank'}).`,
      });
    }
  }
  for (const ch of req.poChanges) {
    const po = world.pos.get(ch.poId);
    if (!po) { conflicts.push({ docNo: ch.docNo || null, lineId: null, field: ch.field, reason: 'This purchase order is no longer in this company.' }); continue; }
    refuse(po);
    const col = poLineImportSpec(ch.field).column;
    const now = storedImportValue(ch.field, po[col]);
    const lines = world.poLines.get(po.id) ?? [];
    const sameLineSet = lines.length === Object.keys(ch.lineValues).length && lines.every((l) => l.id in ch.lineValues);
    const linesMoved = !sameLineSet || lines.some((l) => storedImportValue(ch.field, l[col]) !== ch.lineValues[l.id]);
    if (now !== ch.old || linesMoved) {
      conflicts.push({
        docNo: po.po_number, lineId: null, field: ch.field,
        reason: `${headerOf(ch.field)} on ${po.po_number} changed since the preview${sameLineSet ? '' : ' (its lines were added or removed)'}.`,
      });
    }
  }
  return conflicts;
}
