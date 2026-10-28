/* PO line import — POST /mfg-purchase-orders/line-import/preview and /apply.
 *
 * Owner ruling 2026-09-15 (option A): edit the exported PO lines in Excel and
 * import the file back. Only Delivery Date, Estimate Delivery Date 1/2/3,
 * Item Description 2 and Remarks can change; qty, price and item never do
 * (lib/po-line-import.ts is the only column list, lib/po-line-import-classify.ts
 * drops every other key before anything is read).
 *
 * Mounted on the /mfg-purchase-orders prefix, so it rides the same area guard as
 * the PO editor: `edit` on scm.procurement.po for both calls (preview is a POST).
 * A separate file because the PO router is at its size ceiling.
 *
 * The writes are the PO editor's own, in one transaction:
 *   · a line field is the same column the line PATCH writes, refused by the same
 *     rule the editor locks on (CANCELLED / RECEIVED / a live Goods Receipt), and
 *     audited as a PURCHASE_ORDER UPDATE row per line, like the PATCH;
 *   · an estimate date goes through lib/po-supplier-date-cascade.ts, the bulk
 *     supplier-date writer (header + every line + audit);
 *   · expected_at is recomputed like the PATCH does;
 *   · the ERP -> AutoCount edit is queued ONCE per purchase order, after all of
 *     that order's writes, and only when something the write-back sends moved:
 *     a line Delivery Date (DeliveryDate) or an estimate date (header UDF
 *     EDate/EDate2/EDate3, sent since #3907). Owner 2026-09-15: an imported Item
 *     Description 2 is NOT pushed to AutoCount, so it alone queues nothing; line
 *     notes are not in PO_ITEM_COLS either. */
import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { requireActiveCompanyId, scopeToCompanyId } from '../lib/companyScope';
import { assertAuditWritable, auditUnavailableBody, recordEntityAudit, type AuditActor } from '../lib/entity-audit';
import { enqueueEdit } from '../lib/autocount-outbox';
import { runScmPgCommand } from '../lib/pg-supabase-transaction';
import { cascadePoSupplierDate } from '../lib/po-supplier-date-cascade';
import { recomputePoExpectedAt } from './mfg-purchase-orders';
import {
  UUID_RE,
  classifyPoLineImport,
  parseApplyBody,
  parsePreviewBody,
  recheckApply,
  type ImportLineRow,
  type ImportPoRow,
  type ImportWorld,
} from '../lib/po-line-import-classify';
import {
  poLineImportSpec,
  type PoLineImportApplyBody,
  type PoLineImportApplyResult,
  type PoLineImportField,
  type PoLineImportLineChange,
  type PoLineImportPreview,
  type PoLineImportRow,
} from '../lib/po-line-import';

export const poLineImport = new Hono<{ Bindings: Env; Variables: Variables }>();
poLineImport.use('*', supabaseAuth);

const LINE_COLS =
  'id, purchase_order_id, item_code, item_group, variants, delivery_date, description2, notes, '
  + 'supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4';
const PO_COLS =
  'id, po_number, linked_ac_docno, revision, status, company_id, '
  + 'supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4';

/* PostgREST puts an `in` list in the URL; 150 uuids stay well under its limit. */
const CHUNK = 150;
const chunks = <T,>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

class ReadFailed extends Error {}

/** The LINE fields whose change queues a write-back (the PO-level estimate dates
    always do). description2 is carried by the write-back too, but the owner ruled
    an imported one is not pushed. */
const AUTOCOUNT_CARRIED: ReadonlySet<PoLineImportField> = new Set(['deliveryDate']);

/* The audit field names the PO's History drawer already labels (the line PATCH's
   PO_LINE_AUDIT_FIELDS spelling; description2 gets its own label). */
const AUDIT_FIELD: Record<PoLineImportField, string> = {
  deliveryDate: 'deliveryDate',
  description2: 'description2',
  remarks: 'notes',
  estimateDeliveryDate1: 'supplierDeliveryDate2',
  estimateDeliveryDate2: 'supplierDeliveryDate3',
  estimateDeliveryDate3: 'supplierDeliveryDate4',
};

async function loadWorld(sb: any, companyId: number, lineIds: string[], extraPoIds: string[]): Promise<ImportWorld> {
  const lines = new Map<string, ImportLineRow>();
  for (const ids of chunks(lineIds)) {
    const { data, error } = await scopeToCompanyId(sb.from('purchase_order_items').select(LINE_COLS).in('id', ids), companyId);
    if (error) throw new ReadFailed(`purchase_order_items: ${error.message}`);
    for (const r of (data ?? []) as ImportLineRow[]) lines.set(String(r.id).toLowerCase(), r);
  }

  /* Deliberately NOT company-scoped: it reads only the ids of lines the file named
     that the scoped read did not find, so the operator is told "switch company"
     instead of "no such line". No column of the other company's row is read. */
  const otherCompanyLineIds = new Set<string>();
  const missing = lineIds.filter((id) => !lines.has(id));
  for (const ids of chunks(missing)) {
    const { data, error } = await sb.from('purchase_order_items').select('id').in('id', ids);
    if (error) throw new ReadFailed(`purchase_order_items (other company): ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string }>) otherCompanyLineIds.add(String(r.id).toLowerCase());
  }

  const poIds = [...new Set([...[...lines.values()].map((l) => String(l.purchase_order_id)), ...extraPoIds])];
  const pos = new Map<string, ImportPoRow>();
  for (const ids of chunks(poIds)) {
    const { data, error } = await scopeToCompanyId(sb.from('purchase_orders').select(PO_COLS).in('id', ids), companyId);
    if (error) throw new ReadFailed(`purchase_orders: ${error.message}`);
    for (const r of (data ?? []) as ImportPoRow[]) pos.set(String(r.id).toLowerCase(), r);
  }

  /* The downstream lock (lib/downstream-lock.ts poHasDownstream), read for a page
     of POs at once: any non-cancelled Goods Receipt locks the lines. A failed read
     locks, never unlocks. */
  const poLocks = new Map<string, string | null>();
  for (const id of pos.keys()) poLocks.set(id, null);
  for (const ids of chunks([...pos.keys()])) {
    const { data, error } = await sb.from('grns').select('purchase_order_id').in('purchase_order_id', ids).neq('status', 'CANCELLED');
    if (error) {
      for (const id of ids) poLocks.set(id, `Could not check whether this PO has a Goods Receipt, so it is locked for safety — try again (${error.message}).`);
      continue;
    }
    for (const r of (data ?? []) as Array<{ purchase_order_id: string }>) {
      poLocks.set(String(r.purchase_order_id).toLowerCase(), 'PO has a Goods Receipt — delete or cancel it first to edit');
    }
  }

  const poLines = new Map<string, ImportLineRow[]>();
  for (const ids of chunks([...pos.keys()])) {
    const { data, error } = await scopeToCompanyId(
      sb.from('purchase_order_items').select(LINE_COLS).in('purchase_order_id', ids), companyId,
    );
    if (error) throw new ReadFailed(`purchase_order_items (by PO): ${error.message}`);
    for (const r of (data ?? []) as ImportLineRow[]) {
      const k = String(r.purchase_order_id).toLowerCase();
      const row = { ...r, id: String(r.id).toLowerCase(), purchase_order_id: k };
      poLines.set(k, [...(poLines.get(k) ?? []), row]);
    }
  }
  for (const l of lines.values()) { l.id = String(l.id).toLowerCase(); l.purchase_order_id = String(l.purchase_order_id).toLowerCase(); }

  return { lines, otherCompanyLineIds, pos, poLocks, poLines };
}

const readFailedResponse = (c: { json: (body: unknown, status?: number) => Response }, e: unknown): Response => {
  if (e instanceof ReadFailed) {
    return c.json({ error: 'read_failed', message: `Could not read the purchase orders, nothing was changed — try again (${e.message}).` }, 503);
  }
  throw e;
};

/** Preview: classify every row against the current rows. Reads only. */
export async function previewPoLineImport(sb: any, companyId: number, rows: PoLineImportRow[]): Promise<PoLineImportPreview> {
  const ids = [...new Set(rows.map((r) => (r.lineId ?? '').trim().toLowerCase()).filter((id) => UUID_RE.test(id)))];
  return classifyPoLineImport(rows, await loadWorld(sb, companyId, ids, []));
}

/**
 * Apply: re-check the confirmed change set against the CURRENT rows, then write.
 * `sb` is the transaction client from runScmPgCommand; a non-2xx return rolls
 * the whole import back.
 */
export async function applyPoLineImport(
  c: { json: (body: unknown, status?: number) => Response },
  sb: any,
  companyId: number,
  actor: AuditActor | null,
  req: PoLineImportApplyBody,
): Promise<Response> {
  const { lineChanges, poChanges } = req;
  let world: ImportWorld;
  try {
    world = await loadWorld(sb, companyId, [...new Set(lineChanges.map((ch) => ch.lineId))], poChanges.map((ch) => ch.poId));
  } catch (e) {
    return readFailedResponse(c, e);
  }

  const conflicts = recheckApply(req, world);
  if (conflicts.length > 0) {
    return c.json({
      error: 'import_conflict',
      message: 'Some purchase orders changed after the preview, so nothing was imported. Preview the file again.',
      conflicts,
    }, 409);
  }

  /* The change log must be writable BEFORE anything moves (entity-audit.ts). */
  const firstPo = lineChanges.length > 0 ? world.lines.get(lineChanges[0]!.lineId)?.purchase_order_id : poChanges[0]?.poId;
  const pre = await assertAuditWritable(sb, { entityType: 'PURCHASE_ORDER', entityId: firstPo ?? null, action: 'UPDATE', companyId });
  if (!pre.ok) return c.json(auditUnavailableBody(), 409);

  const touchedPos = new Set<string>();
  const autocountPos = new Set<string>();

  const byLine = new Map<string, PoLineImportLineChange[]>();
  for (const ch of lineChanges) byLine.set(ch.lineId, [...(byLine.get(ch.lineId) ?? []), ch]);
  for (const [lineId, chs] of byLine) {
    const line = world.lines.get(lineId)!;
    const po = world.pos.get(line.purchase_order_id)!;
    const updates: Record<string, string | null> = {};
    for (const ch of chs) updates[poLineImportSpec(ch.field).column] = ch.new;
    const { error } = await scopeToCompanyId(sb.from('purchase_order_items').update(updates).eq('id', lineId), companyId);
    if (error) return c.json({ error: 'update_failed', message: `Could not update ${po.po_number}, nothing was imported (${error.message}).` }, 500);
    await recordEntityAudit(sb, {
      entityType: 'PURCHASE_ORDER',
      entityId: po.id,
      entityDocNo: po.po_number,
      action: 'UPDATE',
      actor,
      companyId: (po.company_id as number | null) ?? companyId,
      statusSnapshot: po.status ?? null,
      note: `Line imported from file: ${String(line.item_code ?? lineId)}`,
      fieldChanges: chs.map((ch) => ({ field: AUDIT_FIELD[ch.field], from: ch.old, to: ch.new })),
    });
    touchedPos.add(po.id);
    if (chs.some((ch) => AUTOCOUNT_CARRIED.has(ch.field))) autocountPos.add(po.id);
  }

  for (const ch of poChanges) {
    const po = world.pos.get(ch.poId)!;
    const written = await cascadePoSupplierDate(sb, {
      companyId, poId: po.id, before: po, slot: poLineImportSpec(ch.field).slot!, date: ch.new, applyToLines: true, actor,
      note: 'Imported from file',
    });
    if (!written.ok) return c.json({ error: 'update_failed', message: `Could not update ${po.po_number}, nothing was imported (${written.reason}).` }, 500);
    touchedPos.add(po.id);
    autocountPos.add(po.id);
  }

  for (const poId of touchedPos) await recomputePoExpectedAt(sb, poId);

  /* ONE write-back per purchase order, after all of its writes. */
  let queued = 0;
  for (const poId of autocountPos) {
    if (await enqueueEdit(sb, { companyId, docType: 'PO', docId: poId, createdBy: actor?.id ?? null })) queued += 1;
  }

  const result: PoLineImportApplyResult = {
    ok: true,
    linesUpdated: byLine.size,
    purchaseOrdersUpdated: touchedPos.size,
    poLevelChanges: poChanges.length,
    autocountEditsQueued: queued,
  };
  return c.json(result);
}

poLineImport.post('/line-import/preview', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const parsed = parsePreviewBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error, message: parsed.message }, 400);
  try {
    return c.json(await previewPoLineImport(c.get('supabase'), co.companyId, parsed.rows));
  } catch (e) {
    return readFailedResponse(c, e);
  }
});

poLineImport.post('/line-import/apply', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const parsed = parseApplyBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error, message: parsed.message }, 400);
  const actor = c.get('houzsUser') ?? null;
  return runScmPgCommand(c, (sb) => applyPoLineImport(c, sb, co.companyId, actor, parsed.req));
});
