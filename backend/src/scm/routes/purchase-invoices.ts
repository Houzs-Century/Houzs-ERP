
import { yymmFor } from '../../services/documentRefs';
import { Hono } from 'hono';
import { PI_STATUS_BUCKETS } from '../lib/pi-status-buckets';
import { PI_HEADER_COLS, PI_LIST_SELECT, piListSelect, filterPiList, orderPiList, readPiListFilters } from '../lib/pi-list-read';
import { attachPiLines } from '../lib/pi-export-rows';
import { HELD_OR_TERM } from '../lib/document-hold'; import { grnNotBillableRefusal } from '../lib/source-document-gates'; import { mountHoldRoute } from './document-hold-routes';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { RECEIPT_PRICES, createDraftPisFromGrnItemsCore, type PiFromGrnItemsContext } from '../lib/pi-from-grn-core';
import { qtyCapRefusal } from '../lib/qty-cap';
import { buildVariantSummary, isServiceLine } from '../shared';
import { allocateLandedCharges, normalizeAllocationMethod } from '../lib/landed-allocation';
import { coerceEmptyDates, dateOrNull } from '../lib/date-coerce';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { postPiAccounting, reversePiAccounting, resyncPiAccounting } from './accounting';
import { piLedgerOutcome } from '../lib/pi-ledger-outcome';
import { recostForPi, recostFromGrn } from '../lib/recost';
import { normalizeCurrency, normalizeExchangeRate, masterRateForCurrency } from '../lib/fx';
import { assertForeignRatePostable, assertForeignRatePatchable } from '../lib/fx-guard';
import { parseLineNumbers, invalidLineNumberBody } from '../shared/line-numbers';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import {
  coveredGrnIds, findUnlinkedPiLines, unlinkedInvoiceResponse, unlinkedCheckFailedResponse,
} from '../lib/return-unlinked-lines';
import { assertSourceLinesInCompany } from '../lib/ref-in-company';
import { isGrnLineOverInvoiced, piGrnSourceRefusal } from '../lib/pi-grn-source-guard';
import { readStatusCounts } from '../lib/status-counts';
import { listStatusCountsSql } from '../lib/list-status-counts-sql';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
  isCrossCompanySource, crossCompanyConversionBlocked } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { recordEntityAudit, diffFields, compactChanges, fieldChange, statusChange } from '../lib/entity-audit';
import { PI_LINE_AUDIT_FIELDS, PI_LINE_AUDIT_SELECT } from '../lib/entity-audit-fields';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { resolvePoSoCoveragePerSkuForPos, resolveDeliveredByCodeForPos, summarizeOrigins, type DeliveredDo } from './po-so-coverage';
import { enqueueConvert, recordParentlessCreate, enqueueCancel, enqueueEdit, retiredLineOf, type AcRetiredLine } from '../lib/autocount-outbox';
import { sourceGrnIdsForPi } from '../lib/convert-parent';
import { refuseMigratedSources, receiptMustMirrorAutoCount } from '../lib/migrated-chain';
import { MIGRATED_RECEIPTS_NOT_INVOICED_IN_AUTOCOUNT } from '../lib/migrated-receipts-not-invoiced.generated';
import { attachGrnLineFacts, withPoPriceSnapshot } from '../lib/pi-po-price'; import { loadOutstandingGrnLines } from '../lib/outstanding-grn-lines';
import { refuseWithoutWriting } from '../lib/no-write-refusal';
import { insertFailed, loadFailed, rollbackPi, committedAnyway } from '../lib/pi-create-refusals';
import { recomputePiTotals, reallocatePiCharges } from '../lib/pi-money-rollups';
import { PI_AUDIT_FIELDS, loadPiAuditMeta, recordPiCreate } from '../lib/pi-audit-trail';
import { attachPiAssignedSos } from '../lib/pi-assigned-sos';
import { getSupabaseService } from '../../db/supabase';
import { notePiScanAccepted } from '../lib/scan-sample-review';
import { duplicateBillRefusal, findDuplicateSupplierBill } from '../lib/duplicate-supplier-bill';

async function queueAcPiEdit(c: any, id: string, retire: AcRetiredLine[] = [], newLineIds: string[] = []): Promise<void> {  // newLineIds: docs/bugs/0588
  await enqueueEdit(c.get('supabase'), {
    companyId: activeCompanyId(c),
    docType: 'PI',
    docId: id,
    retire, newLineIds,
    createdBy: c.get('houzsUser')?.id ?? null,
  });
}

export const purchaseInvoices = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseInvoices.use('*', supabaseAuth);


const HEADER = PI_HEADER_COLS;
const ITEM =
  'id, purchase_invoice_id, grn_item_id, material_kind, item_code, material_name, qty, unit_price_sen, line_total_sen, notes, ' +
  'item_group, description, description2, uom, discount_sen, variants, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen, unit_cost_sen, po_unit_price_sen, created_at';

const uniq = (xs: Array<string | null | undefined>) =>
  [...new Set(xs.filter((x): x is string => !!x))];

const nextNum = async (sb: any, prefix: string, c: any): Promise<string> => {
  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'purchase_invoices', 'invoice_number', `${p}${prefix}-${yymm}`);
};


async function recomputeGrnInvoiced(sb: any, grnItemIds: Array<string | null | undefined>) {
  const ids = [...new Set(grnItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return;

  try {
    const { data: plines, error: plinesErr } = await sb.from('purchase_invoice_items')
      .select('grn_item_id, qty, purchase_invoice_id')
      .in('grn_item_id', ids);
    if (plinesErr) {
      /* eslint-disable-next-line no-console */
      console.error('[recomputeGrnInvoiced] PI lines read failed — invoiced_qty left unchanged:', plinesErr.message);
      return;
    }
    const rows = (plines ?? []) as Array<{ grn_item_id: string; qty: number; purchase_invoice_id: string }>;
    const piIds = [...new Set(rows.map((r) => r.purchase_invoice_id).filter(Boolean))];
    const excluded = new Set<string>();
    if (piIds.length > 0) {
      const { data: pis, error: pisErr } = await sb.from('purchase_invoices').select('id, status').in('id', piIds);
      if (pisErr) {
        /* eslint-disable-next-line no-console */
        console.error('[recomputeGrnInvoiced] PI status read failed — invoiced_qty left unchanged:', pisErr.message);
        return;
      }
      for (const p of (pis ?? []) as Array<{ id: string; status: string }>) {
        if (p.status === 'CANCELLED' || p.status === 'DRAFT') excluded.add(p.id);
      }
    }
    const invByGrnItem = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of rows) {
      if (excluded.has(r.purchase_invoice_id)) continue;
      invByGrnItem.set(r.grn_item_id, (invByGrnItem.get(r.grn_item_id) ?? 0) + Number(r.qty ?? 0));
    }

    const { data: giRows, error: giErr } = await sb.from('grn_items')
      .select('id, qty_accepted').in('id', ids);
    if (giErr) {
      /* eslint-disable-next-line no-console */
      console.error('[recomputeGrnInvoiced] GRN accepted-qty read failed — invoiced_qty left unchanged:', giErr.message);
      return;
    }
    const acceptedById = new Map<string, number>(
      ((giRows ?? []) as Array<{ id: string; qty_accepted: number }>).map((g) => [g.id, g.qty_accepted ?? 0]),
    );
    await Promise.all([...invByGrnItem.entries()].map(([giId, inv]) => {
      const capped = Math.min(acceptedById.get(giId) ?? inv, Math.max(0, inv));
      return sb.from('grn_items').update({ invoiced_qty: capped }).eq('id', giId);
    }));
  } catch (e) {
    console.error('[recomputeGrnInvoiced] best-effort recount failed', { grnItemIds: ids, error: e });
  }
}

export async function verifyGrnLinesNotOverInvoiced(
  sb: any,
  grnItemIds: Array<string | null | undefined>,
  countDraftPiId?: string | null,
): Promise<{ over: Array<{ grnItemId: string; invoiced: number; cap: number }>; error: string | null }> {
  const ids = [...new Set(grnItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return { over: [], error: null };
  const { data: giRows, error: giErr } = await sb.from('grn_items')
    .select('id, qty_accepted, returned_qty').in('id', ids);
  if (giErr) return { over: [], error: `receipt cap read failed: ${giErr.message}` };
  const capById = new Map<string, number>(
    ((giRows ?? []) as Array<{ id: string; qty_accepted: number; returned_qty: number }>)
      .map((g) => [g.id, (g.qty_accepted ?? 0) - (g.returned_qty ?? 0)]),
  );
  const { data: sib, error: sibErr } = await sb.from('purchase_invoice_items')
    .select('grn_item_id, qty, purchase_invoice_id').in('grn_item_id', ids);
  if (sibErr) return { over: [], error: `invoiced-qty read failed: ${sibErr.message}` };
  const sibRows = (sib ?? []) as Array<{ grn_item_id: string; qty: number; purchase_invoice_id: string }>;
  const piIds = [...new Set(sibRows.map((r) => r.purchase_invoice_id).filter(Boolean))];
  const excluded = new Set<string>();
  if (piIds.length > 0) {
    const { data: pis, error: pisErr } = await sb.from('purchase_invoices').select('id, status').in('id', piIds);
    if (pisErr) return { over: [], error: `sibling-status read failed: ${pisErr.message}` };
    for (const p of (pis ?? []) as Array<{ id: string; status: string }>) {
      if (p.id === countDraftPiId) continue;
      if (p.status === 'CANCELLED' || p.status === 'DRAFT') excluded.add(p.id);
    }
  }
  const liveByGrnItem = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const r of sibRows) {
    if (excluded.has(r.purchase_invoice_id)) continue;
    liveByGrnItem.set(r.grn_item_id, (liveByGrnItem.get(r.grn_item_id) ?? 0) + Number(r.qty ?? 0));
  }
  const over: Array<{ grnItemId: string; invoiced: number; cap: number }> = [];
  for (const id of ids) {
    const invoiced = liveByGrnItem.get(id) ?? 0;
    const cap = capById.get(id) ?? invoiced;
    if (invoiced > cap) over.push({ grnItemId: id, invoiced, cap });
  }
  return { over, error: null };
}

async function piLocked(sb: any, piId: string): Promise<{ error: string; message: string } | null> {
  const { data, error } = await sb.from('purchase_invoices')
    .select('paid_sen, status').eq('id', piId).maybeSingle();
  if (error) {
    return { error: 'pi_lock_check_failed', message: `Could not check whether this invoice is locked, so it is treated as locked — try again (${error.message}).` };
  }
  if (!data) return null;
  const row = data as { paid_sen: number | null; status: string };
  if (row.status === 'CANCELLED') return { error: 'pi_cancelled', message: 'Invoice is cancelled' };
  if ((row.paid_sen ?? 0) > 0) return { error: 'pi_locked', message: 'Invoice has a payment recorded — locked' };
  return null;
}

async function migratedRefusalForGrnItems(
  sb: any,
  grnItemIds: Array<string | null | undefined>,
): Promise<
  | { ok: true; refusal: { error: string; message: string; docNumbers: string[] } | null }
  | { ok: false; reason: string }
> {
  const ids = [...new Set(grnItemIds.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (ids.length === 0) return { ok: true, refusal: null };
  const { data, error } = await sb.from('grn_items')
    .select('id, grn:grns!inner ( grn_number, migrated_no_stock )')
    .in('id', ids);
  if (error) return { ok: false, reason: error.message };
  const rows = (data ?? []) as unknown as Array<{
    grn: { grn_number: string; migrated_no_stock: boolean | null } | null;
  }>;
  return {
    ok: true,
    refusal: refuseMigratedSources(rows.map((r) => {
      const docNo = r.grn?.grn_number ?? '(unknown receipt)';
      return {
        docNo,
        /* A migrated GRN AutoCount never invoiced is billed here like any other
           (docs/bugs/0918); one AutoCount did invoice still mirrors. The list is
           empty until the office measures, so this is INERT today. */
        migrated: receiptMustMirrorAutoCount(
          { docNo, migrated: r.grn?.migrated_no_stock === true },
          MIGRATED_RECEIPTS_NOT_INVOICED_IN_AUTOCOUNT,
        ),
      };
    })),
  };
}



purchaseInvoices.get('/', async (c) => {
  const sb = c.get('supabase');
  const SELECT = PI_LIST_SELECT;

  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  if (!paginate) {
    let q = sb.from('purchase_invoices')
      .select(SELECT)
      .order('invoice_date', { ascending: false })
      .limit(500);
    const status = c.req.query('status'); if (status) q = q.eq('status', status);
    q = scopeToCompany(q, c);
    const { data, error } = await q;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    const purchaseInvoices = await attachPiAssignedSos(sb, c, (data ?? []) as Array<{ id: string; grn_id?: string | null }>, null);
    return c.json({ purchaseInvoices });
  }

  const page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
  const psRaw = Number(c.req.query('pageSize'));
  const pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

  const filters = readPiListFilters((k) => c.req.query(k));
  let q = orderPiList(filterPiList(sb.from('purchase_invoices').select(piListSelect(filters), { count: 'exact' }), filters, c), filters.sort);
  q = q.range(page * pageSize, page * pageSize + pageSize - 1);

  const countBase = () => scopeToCompany(sb.from('purchase_invoices').select('*', { count: 'exact', head: true }), c);
  const countsProm = listStatusCountsSql(c.env, 'pi-counts', 'purchase_invoices', (cq) => scopeToCompany(cq, c), [
    ['all', 'all'], ['draft', PI_STATUS_BUCKETS.draft], ['posted', PI_STATUS_BUCKETS.posted], ['partial', PI_STATUS_BUCKETS.partial],
    ['paid', PI_STATUS_BUCKETS.paid], ['cancelled', PI_STATUS_BUCKETS.cancelled], ['on_hold', 'held'],
  ] as const).then(async (viaSql) => {
    if (viaSql) return viaSql;
    const [allC, draftC, postedC, partialC, paidC, cancelledC, onHoldC] = await Promise.all([
      countBase(),
      countBase().in('status', PI_STATUS_BUCKETS.draft),
      countBase().in('status', PI_STATUS_BUCKETS.posted),
      countBase().in('status', PI_STATUS_BUCKETS.partial),
      countBase().in('status', PI_STATUS_BUCKETS.paid),
      countBase().in('status', PI_STATUS_BUCKETS.cancelled),
      countBase().or(HELD_OR_TERM),
    ]);
    return readStatusCounts({ all: allC, draft: draftC, posted: postedC, partial: partialC, paid: paidC, cancelled: cancelledC, on_hold: onHoldC });
  });
  const [{ data, error, count }, counted] = await Promise.all([q, countsProm]);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const total = count ?? (data?.length ?? 0);
  if (!counted.ok) return c.json({ error: 'status_counts_failed', reason: counted.reason }, 500);
  const statusCounts = counted.counts;

  const purchaseInvoices = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const withLines = await attachPiLines(sb, c, purchaseInvoices as Array<{ id: string } & Record<string, unknown>>);
  if (withLines.error !== null) return c.json({ error: 'lines_read_failed', reason: withLines.error }, 500);
  return c.json({ purchaseInvoices: withLines.rows, total, page, pageSize, statusCounts });
});

purchaseInvoices.get('/outstanding-grn-items', async (c) => {
  const sb = c.get('supabase');
  const loaded = await loadOutstandingGrnLines({ sb, scopeQuery: (q) => scopeToCompany(q, c) });
  if (loaded.error !== null) return c.json({ error: 'load_failed', reason: loaded.error }, 500);

  /* Owner 2026-08-06 — re-resolve each line's SUPPLIER fabric code from the
     live fabric_trackings row, exactly as the GRN / PO / SI details already do
     at READ. Without it this picker echoed the variants SNAPSHOT taken when
     the line was first raised, so a fabric whose supplier code has since been
     corrected showed the STALE code here while the GRN detail showed the
     current one — the same GRN line read two different ways (found on
     2990-GRN-2608-006: detail KN390-1, picker KN390-2). One batched read,
     fail-soft. */
  await enrichLinesWithFabricSupplierCode(sb, c, loaded.items);

  return c.json({ items: loaded.items, truncated: loaded.truncated });
});

purchaseInvoices.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    /* grn embed (owner 2026-07-23: "PI need show Do number") — the source GRN's
       doc no + the supplier's delivery-note ref surface on the PI detail. */
    scopeToCompany(sb.from('purchase_invoices').select(`${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, email2, email3, address), grn:grns(id, grn_number, delivery_note_ref)`).eq('id', id), c).maybeSingle(),
    sb.from('purchase_invoice_items').select(ITEM).eq('purchase_invoice_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  type PiItemRow = Record<string, unknown> & { id: string; item_code: string };
  const items = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      ((i.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; item_code: string }>)
        .map((it): PiItemRow => ({ ...it, item_code: it.item_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );

  /* Two facts a PI line borrows from its GRN line — the supplier's own code and
     the price we ORDERED at (owner 2026-09-12: 「PI 应该要有两个价钱」). Both come
     off the same row, so `lib/pi-po-price.ts` reads them together. Auxiliary: a
     failed hop leaves both null rather than 500ing the whole invoice. */
  try {
    await attachGrnLineFacts(sb as unknown as Parameters<typeof attachGrnLineFacts>[0],
      items as Array<Record<string, unknown> & { id: string; grn_item_id?: string | null }>);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[pi detail] grn-line facts resolve failed', { id, error: e });
  }

  /* Customer DO(s) — owner 2026-07-23 ("要的", following "PI need show Do
     number"): which of OUR deliveries this purchase covers. Chain: PI line →
     grn_item → purchase_order_item → so_item → delivery_order_item →
     delivery_order (the same so_item_id linkage document-flow walks).
     Back-to-back purchases only — a stock-replenishment PO carries no
     so_item_id and resolves to nothing. Auxiliary enrichment: a failed hop
     logs + degrades to [] rather than 500ing the whole detail page. */
  let customerDos: Array<{ id: string; do_number: string }> = [];
  try {
    const grnItemIds = uniq(((i.data ?? []) as Array<{ grn_item_id?: string | null }>).map((r) => r.grn_item_id));
    if (grnItemIds.length) {
      const { data: gis } = await sb.from('grn_items').select('purchase_order_item_id').in('id', grnItemIds);
      const poiIds = uniq(((gis ?? []) as Array<{ purchase_order_item_id: string | null }>).map((r) => r.purchase_order_item_id));
      if (poiIds.length) {
        const { data: pois } = await sb.from('purchase_order_items').select('so_item_id').in('id', poiIds);
        const soItemIds = uniq(((pois ?? []) as Array<{ so_item_id: string | null }>).map((r) => r.so_item_id));
        if (soItemIds.length) {
          const { data: dois } = await sb.from('delivery_order_items').select('delivery_order_id').in('so_item_id', soItemIds);
          const doIds = uniq(((dois ?? []) as Array<{ delivery_order_id: string | null }>).map((r) => r.delivery_order_id));
          if (doIds.length) {
            const { data: dos } = await sb.from('delivery_orders').select('id, do_number').in('id', doIds).order('do_number');
            customerDos = (dos ?? []) as Array<{ id: string; do_number: string }>;
          }
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[pi detail] customer-DO resolve failed', { id, error: e });
  }
  /* Every SOURCE NOTE this PI bills (owner 2026-08-06 multi-GRN) — the header's
     grn_id is only the primary ref, so derive the full set from the LINES
     (grn_item_id → grn). Carries each note's supplier delivery-note ref too:
     one supplier invoice covering three deliveries has three DO refs, and the
     detail page must list them all rather than just the primary's. */
  let sourceGrns: Array<{ id: string; grn_number: string; delivery_note_ref: string | null }> = [];
  try {
    const grnItemIds = uniq(((i.data ?? []) as Array<{ grn_item_id?: string | null }>).map((r) => r.grn_item_id));
    if (grnItemIds.length) {
      const { data: gis } = await sb.from('grn_items').select('grn_id').in('id', grnItemIds);
      const grnIds = uniq(((gis ?? []) as Array<{ grn_id: string | null }>).map((r) => r.grn_id));
      if (grnIds.length) {
        const { data: gs } = await sb.from('grns')
          .select('id, grn_number, delivery_note_ref').in('id', grnIds).order('grn_number');
        sourceGrns = (gs ?? []) as Array<{ id: string; grn_number: string; delivery_note_ref: string | null }>;
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[pi detail] source-GRN resolve failed', { id, error: e });
  }
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ purchaseInvoice: h.data, items, customerDos, sourceGrns });
});

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
// For a PI: its source GRN(s) + parent PO(s). The header FKs are only the
// PRIMARY refs (a PI may bill several notes — owner 2026-08-06), so walk the
// LINES for the full set and keep `grn`/`purchaseOrder` as the primary for
// callers that still expect one.
purchaseInvoices.get('/:id/linked', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data, error } = await scopeToCompany(sb
    .from('purchase_invoices')
    .select(`
      id,
      grn:grns(id, grn_number),
      purchase_order:purchase_orders(id, po_number)
    `)
    .eq('id', id), c)
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const raw = data as unknown as {
    grn?: { id: string; grn_number: string } | Array<{ id: string; grn_number: string }> | null;
    purchase_order?: { id: string; po_number: string } | Array<{ id: string; po_number: string }> | null;
  };
  const headerGrn: { id: string; grn_number: string } | null =
    Array.isArray(raw.grn) ? (raw.grn[0] ?? null) : (raw.grn ?? null);
  const headerPo: { id: string; po_number: string } | null =
    Array.isArray(raw.purchase_order) ? (raw.purchase_order[0] ?? null) : (raw.purchase_order ?? null);

  let grns: Array<{ id: string; grn_number: string }> = headerGrn ? [headerGrn] : [];
  let pos: Array<{ id: string; po_number: string }> = headerPo ? [headerPo] : [];
  try {
    const { data: piLines } = await sb.from('purchase_invoice_items')
      .select('grn_item_id').eq('purchase_invoice_id', id);
    const grnItemIds = uniq(((piLines ?? []) as Array<{ grn_item_id: string | null }>).map((r) => r.grn_item_id));
    if (grnItemIds.length) {
      const { data: gis } = await sb.from('grn_items')
        .select('grn_id, purchase_order_item_id').in('id', grnItemIds);
      const grnIds = uniq(((gis ?? []) as Array<{ grn_id: string | null }>).map((r) => r.grn_id));
      if (grnIds.length) {
        const { data: gs } = await sb.from('grns').select('id, grn_number').in('id', grnIds).order('grn_number');
        if (gs?.length) grns = gs as Array<{ id: string; grn_number: string }>;
      }
      const poiIds = uniq(((gis ?? []) as Array<{ purchase_order_item_id: string | null }>).map((r) => r.purchase_order_item_id));
      if (poiIds.length) {
        const { data: pois } = await sb.from('purchase_order_items').select('purchase_order_id').in('id', poiIds);
        const poIds = uniq(((pois ?? []) as Array<{ purchase_order_id: string | null }>).map((r) => r.purchase_order_id));
        if (poIds.length) {
          const { data: ps } = await sb.from('purchase_orders').select('id, po_number').in('id', poIds).order('po_number');
          if (ps?.length) pos = ps as Array<{ id: string; po_number: string }>;
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[pi linked] line-level fan-out failed', { id, error: e });
  }
  return c.json({
    grn: headerGrn ?? grns[0] ?? null,
    purchaseOrder: headerPo ?? pos[0] ?? null,
    grns,
    purchaseOrders: pos,
  });
});

purchaseInvoices.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return refuseWithoutWriting(c, { error: 'invalid_json' }, 400); }
  if (!body.supplierId) return refuseWithoutWriting(c, { error: 'supplier_required' }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return refuseWithoutWriting(c, { error: 'items_required' }, 400);

  const asDraft = body.asDraft === true;

  const sb = c.get('supabase'); const user = c.get('user');

  /* THE UNLINKED-LINE BACK DOOR, on the sixth and last chain that has it.
     The over-invoice guard below caps only lines that CARRY a grnItemId; a
     hand-added line with no link bills the goods while moving no
     `grn_items.invoiced_qty`, so the GRN line still reads fully outstanding and
     a second PI bills the same receipt — the supplier is paid twice. Refused
     only when the material is already on one of the receipts this invoice
     COVERS, so a freight or service line still passes. Five sibling chains close
     exactly this door; see docs/unlinked-line-duplicate-coe.md and the owner's
     2026-08-04 "包括 GR 那边也是".

     The receipt set is the header ref UNION the receipts behind the body's own
     linked lines, not the header ref alone: this endpoint is how the multi-note
     `?grnId=` draft is saved, and a set of one made an unlinked line billing a
     SECONDARY note's material pass. FAILS CLOSED — a check that could not run
     must not authorise the write. */
  {
    const covered = await coveredGrnIds(sb, {
      headerGrnId: (body.grnId as string | undefined) ?? null,
      grnItemIds: items.map((it) => (it.grnItemId as string | undefined) ?? null),
    });
    if (covered.error) return refuseWithoutWriting(c, unlinkedCheckFailedResponse(covered.error), 500);
    const unlinked = await findUnlinkedPiLines(
      sb,
      covered.ids,
      items.map((it, idx) => ({
        lineRef: String(idx),
        itemCode: String(it.itemCode ?? ''),
        qty: Number(it.qty ?? 0),
        soItemId: (it.grnItemId as string | undefined) ?? null,
      })),
    );
    if (!unlinked.ok) return refuseWithoutWriting(c, unlinkedCheckFailedResponse(unlinked.reason), 500);
    if (unlinked.offenders.length > 0) return refuseWithoutWriting(c, unlinkedInvoiceResponse(unlinked.offenders), 409);
  }

  {
    const wantByGrnItem = new Map<string, number>();
    for (const it of items) {
      const gid = (it.grnItemId as string | undefined) ?? null;
      if (!gid) continue;
      wantByGrnItem.set(gid, (wantByGrnItem.get(gid) ?? 0) + Number(it.qty ?? 0));
    }
    const gids = [...wantByGrnItem.keys()];
    {
      const mig = await migratedRefusalForGrnItems(sb, gids);
      if (!mig.ok) return refuseWithoutWriting(c, loadFailed(mig.reason, 'check whether this receipt was carried over from the account book'), 500);
      if (mig.refusal) return refuseWithoutWriting(c, mig.refusal, 409);
    }
    /* Company + IDENTITY + quantity, over ONE read of the source rows — moved
       to lib/pi-grn-source-guard.ts beside its siblings checkSiOverRemaining
       and qtyCapRefusal. The identity half is docs/bugs/0672 site 15. */
    {
      const bad = await piGrnSourceRefusal(sb, c, wantByGrnItem, items);
      if (bad) return refuseWithoutWriting(c, bad.body, bad.status);
    }
  }

  let subtotal = 0;
  for (const [i, it] of items.entries()) {
    const parsed = parseLineNumbers({
      qty: { value: it.qty },
      unitPriceSen: { value: it.unitPriceSen },
      discountSen: { value: it.discountSen },
    });
    if (!parsed.ok) {
      const b = invalidLineNumberBody(parsed.invalid);
      return refuseWithoutWriting(c, { ...b, reason: `Line ${i + 1}: ${b.reason}` }, 400);
    }
  }
  const itemRows = items.map((it) => {
    const qty = Number(it.qty ?? 0); const unit = Number(it.unitPriceSen ?? 0);
    const discount = Number(it.discountSen ?? 0) || 0;
    const total = Math.max(0, qty * unit - discount); subtotal += total;
    return {
      material_kind: it.materialKind,
      item_code: it.itemCode,
      material_name: it.materialName,
      qty, unit_price_sen: unit, discount_sen: discount, line_total_sen: total,
      grn_item_id: (it.grnItemId as string | undefined) ?? null,
      notes: (it.notes as string | undefined) ?? null,
      item_group: (it.itemGroup as string | null | undefined) ?? null,
      variants: (it.variants as Record<string, unknown> | null | undefined) ?? null,
    };
  });

  const piCurrency = normalizeCurrency(body.currency);
  const piRateRaw = body.exchangeRate !== undefined && body.exchangeRate !== null
    ? body.exchangeRate
    : await masterRateForCurrency(sb, piCurrency);
  const piExchangeRate = normalizeExchangeRate(piRateRaw, piCurrency);
  {
    const rateGuard = await assertForeignRatePostable(sb, { currency: piCurrency, operatorRate: body.exchangeRate, docLabel: 'purchase invoice' });
    if (!rateGuard.ok) return refuseWithoutWriting(c, rateGuard.body, 422);
  }
  {
    const companyId = activeCompanyId(c);
    if (companyId != null) {
      const dup = await findDuplicateSupplierBill(sb, 'purchase_invoices', { companyId, supplierId: String(body.supplierId), ref: body.supplierInvoiceRef, excludeId: null, docKind: null });
      if (!dup.ok) return refuseWithoutWriting(c, { error: 'lookup_failed', reason: dup.reason }, 500);
      if (dup.duplicate) return refuseWithoutWriting(c, duplicateBillRefusal(body.supplierInvoiceRef, dup.duplicate), 409);
    }
  }
  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; invoice_number: string }>(
    () => nextNum(sb, 'PI', c),
    (invoiceNumber) => sb.from('purchase_invoices').insert({
    company_id: activeCompanyId(c),
    invoice_number: invoiceNumber,
    supplier_invoice_ref: (body.supplierInvoiceRef as string) ?? null,
    supplier_id: body.supplierId,
    purchase_order_id: (body.purchaseOrderId as string) ?? null,
    grn_id: (body.grnId as string) ?? null,
    invoice_date: dateOrNull(body.invoiceDate) ?? todayMyt(),
    due_date: dateOrNull(body.dueDate),
    currency: piCurrency,
    exchange_rate: piExchangeRate,
    subtotal_sen: subtotal,
    total_sen: subtotal,
    notes: (body.notes as string) ?? null,
    status: asDraft ? 'DRAFT' : 'POSTED',
    posted_at: asDraft ? null : new Date().toISOString(),
    created_by: user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return refuseWithoutWriting(c, insertFailed(hErr.message), 500);
  const h = header as unknown as { id: string; invoice_number: string };

  const rowsWithId = itemRows.map((r) => ({ ...r, purchase_invoice_id: h.id }));
  const { error: iErr } = await withPoPriceSnapshot(sb, rowsWithId, () => sb.from('purchase_invoice_items').insert(stampCompany(rowsWithId, c)));
  if (iErr) {
    // HC-0004: the DB cap (mig 20261014T1410) refused a line past its GRN line.
    if (isGrnLineOverInvoiced(iErr)) {
      const b = { error: 'qty_exceeds_remaining', message: 'Another purchase invoice already bills this goods received line. Refresh and try again.', reason: iErr.message };
      if (!await rollbackPi(sb, h.id, h.invoice_number)) return c.json(b, 409);
      return refuseWithoutWriting(c, b, 409);
    }
    const b = insertFailed(iErr.message, 'items_insert_failed');
    if (!await rollbackPi(sb, h.id, h.invoice_number)) return c.json(b, 500);
    return refuseWithoutWriting(c, b, 500);
  }

  {
    const verify = await verifyGrnLinesNotOverInvoiced(sb, itemRows.map((r) => r.grn_item_id));
    // eslint-disable-next-line no-console
    if (verify.error) console.error(`[pi over-invoice verify] ${h.invoice_number}: ${verify.error}`);
    const over = verify.over;
    if (over.length > 0) {
      const b = { error: 'qty_exceeds_remaining', lines: over };
      if (!await rollbackPi(sb, h.id, h.invoice_number)) return c.json(b, 409);
      return refuseWithoutWriting(c, b, 409);
    }
  }

  await committedAnyway(h.invoice_number, async () => {
  await recordPiCreate(sb, c.get('houzsUser'), activeCompanyId(c), h.id, itemRows.length);

  /* ERP -> AutoCount. An invoice whose LINES name a receipt is sent as a real
     gr_to_pi; one that names none is still parentless. The purchase-side half
     of the grns.ts fix — lib/convert-parent.ts, docs/bugs/0524. */
  const srcGrnIds = await sourceGrnIdsForPi(sb, h.id);
  const acBase = { companyId: activeCompanyId(c), docType: 'PI' as const, docNo: h.invoice_number, docId: h.id, createdBy: c.get('houzsUser')?.id ?? null };
  if (srcGrnIds.length) {
    await enqueueConvert(sb, { ...acBase, op: 'gr_to_pi',
      from: srcGrnIds.map((id) => ({ table: 'grns' as const, keyCol: 'id' as const, key: id })),
      to: { table: 'purchase_invoices', keyCol: 'id', key: h.id } });
  } else {
    await recordParentlessCreate(sb, { ...acBase, missing: 'no source Goods Received Note to transfer from' });
  }

  await reallocatePiCharges(sb, h.id, normalizeAllocationMethod(body.allocationMethod), activeCompanyId(c));
  if (!asDraft) {
    await recomputeGrnInvoiced(sb, itemRows.map((r) => r.grn_item_id));
    await recostForPi(sb, h.id);
  }
  });
  return c.json({ id: h.id, invoiceNumber: h.invoice_number }, 201);
});

export const postPurchaseInvoiceHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(sb.from('purchase_invoices')
    .select('id, status, invoice_number, company_id, supplier_id, total_sen, currency').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const curRow = cur as {
    id: string; status: string; invoice_number: string;
    company_id?: number | null; supplier_id?: string | null; total_sen?: number | null; currency?: string | null;
  };
  if (curRow.status !== 'DRAFT') {
    if (curRow.status !== 'CANCELLED') {
      const ensure = await postPiAccounting(sb, curRow.invoice_number);
      if (!ensure.ok) {
        // eslint-disable-next-line no-console
        console.error(`[pi-accounting] ensure-post failed for ${curRow.invoice_number}:`, ensure.status, ensure.reason);
      }
      return c.json({ purchaseInvoice: cur, ledger: piLedgerOutcome(ensure) });
    }
    return c.json({ purchaseInvoice: cur });
  }

  const { data: draftLines, error: draftLinesErr } = await sb.from('purchase_invoice_items')
    .select('grn_item_id').eq('purchase_invoice_id', id);
  if (draftLinesErr) {
    return c.json({
      error: 'lookup_failed',
      reason: `Could not read this invoice's lines, so it was NOT confirmed: ${draftLinesErr.message}`,
    }, 500);
  }
  const draftGrnItemIds = ((draftLines ?? []) as Array<{ grn_item_id: string | null }>)
    .map((l) => l.grn_item_id);
  {
    const verify = await verifyGrnLinesNotOverInvoiced(sb, draftGrnItemIds, id);
    if (verify.error) {
      return c.json({
        error: 'over_invoice_check_failed',
        reason: `Could not check this invoice against the receipt's remaining quantity, so it was `
          + `NOT confirmed — the same goods could otherwise be paid for twice (${verify.error}).`,
      }, 500);
    }
    if (verify.over.length > 0) {
      return c.json({
        error: 'qty_exceeds_remaining',
        message: 'Confirming this invoice would bill more than the Goods Receipt received. Another '
          + 'invoice has already billed those lines — reduce the quantities, or cancel this draft.',
        lines: verify.over,
      }, 409);
    }
  }

  const { data, error } = await scopeToCompanyId(sb.from('purchase_invoices').update({
    status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id), co.companyId).eq('status', 'DRAFT').select('id, status').maybeSingle();
  if (isGrnLineOverInvoiced(error)) return c.json({ error: 'qty_exceeds_remaining', message: 'Another purchase invoice already bills a goods received line on this draft. Reduce the quantities, or cancel this draft.', reason: error?.message }, 409);
  if (error) return c.json({ error: 'post_failed', reason: error.message }, 500);
  if (!data) {
    const { data: now } = await scopeToCompanyId(
      sb.from('purchase_invoices').select('id, status').eq('id', id), co.companyId,
    ).maybeSingle();
    return c.json({ purchaseInvoice: now ?? cur });
  }

  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_INVOICE',
    entityId: id,
    entityDocNo: curRow.invoice_number,
    action: 'POST',
    actor: c.get('houzsUser'),
    companyId: curRow.company_id ?? activeCompanyId(c),
    statusSnapshot: 'POSTED',
    fieldChanges: compactChanges([
      ...statusChange('DRAFT', 'POSTED'),
      fieldChange('supplierId', null, curRow.supplier_id ?? null),
      fieldChange('totalSen', null, Number(curRow.total_sen ?? 0)),
      fieldChange('currency', null, curRow.currency ?? null),
    ]),
  });

  {
    const verify = await verifyGrnLinesNotOverInvoiced(sb, draftGrnItemIds);
    if (verify.over.length > 0) {
      await scopeToCompanyId(sb.from('purchase_invoices').update({
        status: 'DRAFT', posted_at: null, updated_at: new Date().toISOString(),
      }).eq('id', id), co.companyId);
      return c.json({
        error: 'qty_exceeds_remaining',
        message: 'Another invoice billed those receipt lines while this one was being confirmed, so '
          + 'it has been left as a draft. Reduce the quantities, or cancel it.',
        lines: verify.over,
      }, 409);
    }
    if (verify.error) {
      // eslint-disable-next-line no-console
      console.error(`[pi over-invoice verify] confirm ${curRow.invoice_number}: ${verify.error}`);
    }
  }

  await recomputeGrnInvoiced(sb, draftGrnItemIds);
  const postRes = await postPiAccounting(sb, curRow.invoice_number);
  if (!postRes.ok) {
    // eslint-disable-next-line no-console
    console.error(`[pi-accounting] confirm post failed for ${curRow.invoice_number}:`, postRes.status, postRes.reason);

    await recordEntityAudit(sb, {
      entityType: 'PURCHASE_INVOICE',
      entityId: id,
      entityDocNo: curRow.invoice_number,
      action: 'POST',
      actor: c.get('houzsUser'),
      companyId: curRow.company_id ?? activeCompanyId(c),
      statusSnapshot: 'POSTED',
      note: `AP/GL post FAILED: ${postRes.status} — ${postRes.reason ?? 'no reason given'}`,
      fieldChanges: compactChanges([fieldChange('apPosted', null, false)]),
    });
  }
  await recostForPi(sb, id);
  try {
    await notePiScanAccepted(getSupabaseService(c.env), { piId: id, invoiceNumber: curRow.invoice_number });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[pi scan learning] note skipped (non-fatal):', curRow.invoice_number, (e as Error).message);
  }
  return c.json({ purchaseInvoice: data, ledger: piLedgerOutcome(postRes) });
};
purchaseInvoices.patch('/:id/post', postPurchaseInvoiceHandler);

/* RETIRED (docs/bugs/0889-supplier-invoice-payments-could-skip-the-payment-voucher-and.md).
   This added a typed amount straight onto paid_sen: no payment voucher, no
   journal entry, no hold check, no approval, and no clamp to what was owed. A
   supplier invoice is paid with an AP Payment voucher, which settles it through
   scm.settle_pi_paid_sen when the voucher posts (routes/payment-vouchers.ts).
   Its only working caller was the phone's Record Payment sheet; the desktop's
   Mark paid sent RM0, which this refused. Kept as a refusal rather than deleted
   so a browser tab still running the old screen gets a sentence, not a 404. */
export const retiredPiPaymentHandler = (c: any) =>
  c.json({
    error: 'payment_voucher_required',
    message: 'Supplier invoices are paid with an AP Payment: Finance, Money out, Payment Vouchers.',
  }, 409);
purchaseInvoices.patch('/:id/payment', retiredPiPaymentHandler);

export const cancelPurchaseInvoiceHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: cur, error: curErr } = await scopeToCompanyId(sb.from('purchase_invoices')
    .select('id, status, paid_sen, invoice_number, company_id, total_sen').eq('id', id), co.companyId).maybeSingle();
  if (curErr) return c.json({ error: 'lookup_failed', reason: curErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const head = cur as {
    id: string; status: string; paid_sen: number | null;
    invoice_number?: string | null; company_id?: number | null; total_sen?: number | null;
  };
  const auditCompanyId = head.company_id ?? activeCompanyId(c);
  if (head.status === 'PAID' || (head.paid_sen ?? 0) > 0) {
    return c.json({ error: 'cannot_cancel', message: 'PI already paid' }, 409);
  }
  if (head.status === 'CANCELLED') return c.json({ purchaseInvoice: { id, status: 'CANCELLED' } });

  if (head.status === 'DRAFT') {
    const { data: d, error: dErr } = await scopeToCompanyId(sb.from('purchase_invoices').update({
      status: 'CANCELLED', updated_at: new Date().toISOString(),
    }).eq('id', id), co.companyId).eq('status', 'DRAFT').select('id, status').maybeSingle();
    if (dErr) return c.json({ error: 'cancel_failed', reason: dErr.message }, 500);

    if (d) {
      await recordEntityAudit(sb, {
        entityType: 'PURCHASE_INVOICE',
        entityId: id,
        entityDocNo: head.invoice_number ?? null,
        action: 'CANCEL',
        actor: c.get('houzsUser'),
        companyId: auditCompanyId,
        statusSnapshot: 'CANCELLED',
        note: 'Draft cancelled — nothing was posted to reverse',
        fieldChanges: statusChange('DRAFT', 'CANCELLED'),
      });
    }

    return c.json({ purchaseInvoice: d ?? { id, status: 'CANCELLED' } });
  }

  const { data, error } = await scopeToCompanyId(sb.from('purchase_invoices').update({
    status: 'CANCELLED', updated_at: new Date().toISOString(),
  }).eq('id', id), co.companyId).neq('status', 'PAID').neq('status', 'CANCELLED').select('id, status, invoice_number').maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data) {
    const { data: now, error: nowErr } = await scopeToCompanyId(
      sb.from('purchase_invoices').select('id, status').eq('id', id), co.companyId,
    ).maybeSingle();
    if (nowErr) return c.json({ error: 'lookup_failed', reason: nowErr.message }, 500);
    if ((now as { status: string } | null)?.status === 'CANCELLED') {
      return c.json({ purchaseInvoice: now });
    }
    return c.json({ error: 'cannot_cancel', message: 'PI already paid' }, 409);
  }
  const cancelled = data as { id: string; status: string; invoice_number: string };

  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_INVOICE',
    entityId: id,
    entityDocNo: cancelled.invoice_number,
    action: 'CANCEL',
    actor: c.get('houzsUser'),
    companyId: auditCompanyId,
    statusSnapshot: 'CANCELLED',
    fieldChanges: compactChanges([
      ...statusChange(head.status, 'CANCELLED'),
      fieldChange('totalSen', null, Number(head.total_sen ?? 0)),
    ]),
  });

  /* Bug #5 — reverse the PI accounting (Dr Inventory / Cr Payables → contra).
     "取消 PI 要追溯回去". Best-effort (audit-DLQ): a reversal failure never
     un-cancels the PI; it's idempotent so a retry / re-cancel converges. */
  const rev = await reversePiAccounting(sb, cancelled.invoice_number);
  if (!rev.ok) {
    // eslint-disable-next-line no-console
    console.error(`[pi-accounting] reversal failed for ${cancelled.invoice_number}:`, rev.status, rev.reason);
  }

  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_INVOICE',
    entityId: id,
    entityDocNo: cancelled.invoice_number,
    action: 'REVERSE',
    actor: c.get('houzsUser'),
    companyId: auditCompanyId,
    statusSnapshot: 'CANCELLED',
    note: rev.ok ? `AP/GL reversal: ${rev.status}` : `AP/GL reversal FAILED: ${rev.status} — ${rev.reason ?? 'no reason given'}`,
    fieldChanges: compactChanges([fieldChange('reversalOk', null, rev.ok)]),
  });

  const { data: lines } = await sb.from('purchase_invoice_items')
    .select('grn_item_id').eq('purchase_invoice_id', id);
  await recomputeGrnInvoiced(sb, (lines ?? []).map((l: { grn_item_id: string | null }) => l.grn_item_id));
  await recostForPi(sb, id);

  await enqueueCancel(sb, {
    companyId: auditCompanyId ?? activeCompanyId(c),
    docType: 'PI',
    docNo: cancelled.invoice_number ?? id,
    docId: id,
    self: { table: 'purchase_invoices', keyCol: 'id', key: id },
    createdBy: c.get('houzsUser')?.id ?? null,
  });
  return c.json({ purchaseInvoice: { id: cancelled.id, status: cancelled.status } });
};
purchaseInvoices.patch('/:id/cancel', cancelPurchaseInvoiceHandler);

mountHoldRoute(purchaseInvoices, 'pi');
export const createPurchaseInvoicesFromGrnItemsHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: the source load, the active-company stamp and the doc-no
     prefix all happen inside createDraftPisFromGrnItemsCore (scoped to this
     company via the wired context); every by-id write below acts only on a draft
     id THAT core just created and returned for this company. */
  const coreRes = await createDraftPisFromGrnItemsCore({
    req: { json: () => c.req.json() },
    get: ((key: 'supabase' | 'user' | 'companyId' | 'allowedCompanyIds' | 'companyCode') =>
      c.get(key as 'supabase')) as unknown as PiFromGrnItemsContext['get'],
  }, RECEIPT_PRICES, 'refuse');
  if (!coreRes.ok) return c.json(coreRes.body, coreRes.status);

  const sb = c.get('supabase');
  const created: Array<{ id: string; invoiceNumber: string; supplierId: string; grnCount: number; lineCount: number }> = [];
  let dbCapRefused = false;

  for (const draft of coreRes.created) {
    const { error: flipErr } = await scopeToCompanyId(sb.from('purchase_invoices').update({
      status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', draft.id), activeCompanyId(c) as number);
    // HC-0004: the DB cap refused the post (a concurrent PI billed the line).
    // Roll this bucket's draft back (the header cascades its lines).
    if (isGrnLineOverInvoiced(flipErr)) {
      await scopeToCompanyId(sb.from('purchase_invoices').delete().eq('id', draft.id), activeCompanyId(c) as number);
      dbCapRefused = true;
      continue;
    }

    await recordPiCreate(
      sb, c.get('houzsUser'), activeCompanyId(c), draft.id, draft.lineCount,
      `Converted from Goods Receipt ${draft.grnNumbers.join(', ')}`,
    );

    const bucketAc = draft.grnIds.length ? await enqueueConvert(sb, {
        companyId: activeCompanyId(c),
        op: 'gr_to_pi',
        from: draft.grnIds.map((id) => ({ table: 'grns' as const, keyCol: 'id', key: id })),
        to: { table: 'purchase_invoices', keyCol: 'id', key: draft.id },
        docType: 'PI',
        docNo: draft.invoiceNumber,
        docId: draft.id,
        createdBy: c.get('houzsUser')?.id ?? null,
    }) : null;
    await recomputeGrnInvoiced(sb, draft.grnItemIds);
    await reallocatePiCharges(sb, draft.id, undefined, activeCompanyId(c));
    for (const grnId of draft.grnIds) await recostFromGrn(sb, grnId);
    created.push({
      id: draft.id, invoiceNumber: draft.invoiceNumber,
      supplierId: draft.supplierId, grnCount: draft.grnIds.length, lineCount: draft.lineCount,
      ...(bucketAc?.problems.length ? { acNotSent: bucketAc.problems } : {}),
    });
  }

  if (dbCapRefused) {
    return c.json({ error: 'qty_exceeds_remaining', message: 'Another purchase invoice already bills these goods received lines. Refresh the picker and try again.', created }, 409);
  }
  return c.json({ created, total: created.length }, 201);
};
purchaseInvoices.post('/from-grn-items', createPurchaseInvoicesFromGrnItemsHandler);

export const createPurchaseInvoiceFromGrnHandler = async (c: any) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { grnId?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const grnId = body.grnId;
  if (!grnId) return c.json({ error: 'grn_id_required' }, 400);

  const { data: grn, error: grnErr } = await scopeToCompany(sb.from('grns')
    .select('id, grn_number, supplier_id, purchase_order_id, status, on_hold, currency, exchange_rate, migrated_no_stock, company_id')
    .eq('id', grnId), c).maybeSingle();
  if (grnErr) return c.json({ error: 'load_failed', reason: grnErr.message }, 500);
  if (!grn) return c.json({ error: 'grn_not_found' }, 404);
  const g = grn as { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string; on_hold?: boolean | null; currency?: string | null; exchange_rate?: string | number | null; migrated_no_stock?: boolean | null; company_id?: number | null };
  { const nb = grnNotBillableRefusal(g); if (nb) return c.json(nb, 409); }
  {
    /* A migrated GRN AutoCount never invoiced is billed here like any other
       (docs/bugs/0918); one AutoCount did invoice still mirrors. The allowlist is
       empty until the office measures, so this is INERT today. */
    const refusal = refuseMigratedSources([{
      docNo: g.grn_number,
      migrated: receiptMustMirrorAutoCount(
        { docNo: g.grn_number, migrated: g.migrated_no_stock === true },
        MIGRATED_RECEIPTS_NOT_INVOICED_IN_AUTOCOUNT,
      ),
    }]);
    if (refusal) return c.json(refusal, 409);
  }

  const { data: items, error: iErr } = await scopeToCompany(sb.from('grn_items')
    .select('id, material_kind, item_code, material_name, item_group, description, description2, uom, qty_accepted, invoiced_qty, returned_qty, unit_price_sen, variants, gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, custom_specials, line_suffix, special_order_price_sen, discount_sen')
    .eq('grn_id', grnId)
    .gt('qty_accepted', 0), c);
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
  type GrnLine = {
    id: string; material_kind: string; item_code: string; material_name: string;
    item_group: string | null; description: string | null; description2: string | null;
    uom: string | null; qty_accepted: number; invoiced_qty: number; returned_qty: number; unit_price_sen: number; variants: unknown;
    gap_inches: number | null; divan_height_inches: number | null; divan_price_sen: number;
    leg_height_inches: number | null; leg_price_sen: number; custom_specials: unknown;
    line_suffix: string | null; special_order_price_sen: number; discount_sen: number;
  };
  const allLines = (items ?? []) as unknown as GrnLine[];
  const lines = allLines
    .map((it) => ({ ...it, _remaining: (it.qty_accepted ?? 0) - (it.invoiced_qty ?? 0) - (it.returned_qty ?? 0) }))
    .filter((it) => it._remaining > 0);
  if (lines.length === 0) return c.json({ error: 'nothing_to_invoice', message: 'No billable lines came back for this GRN. Open it and check its invoiced balance before treating it as billed in full.' }, 400);

  const discFor = (it: GrnLine & { _remaining: number }) =>
    Math.round(Number(it.discount_sen ?? 0) * it._remaining / (Number(it.qty_accepted) || 1));
  const subtotal = lines.reduce((s, it) => s + Math.max(0, it._remaining * it.unit_price_sen - discFor(it)), 0);

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; invoice_number: string }>(
    () => nextNum(sb, 'PI', c),
    (invoiceNumber) => sb.from('purchase_invoices').insert({
    company_id: activeCompanyId(c),
    invoice_number: invoiceNumber,
    supplier_id: g.supplier_id,
    purchase_order_id: g.purchase_order_id,
    grn_id: g.id,
    invoice_date: todayMyt(),
    currency: normalizeCurrency(g.currency),
    exchange_rate: normalizeExchangeRate(g.exchange_rate, normalizeCurrency(g.currency)),
    subtotal_sen: subtotal,
    tax_sen: 0,
    total_sen: subtotal,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    notes: `From ${g.grn_number}`,
    created_by: user.id,
    }).select('id, invoice_number').single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; invoice_number: string };

  const rows = lines.map((it) => ({
    purchase_invoice_id: h.id,
    grn_item_id: it.id,
    material_kind: it.material_kind,
    item_code: it.item_code,
    material_name: it.material_name,
    qty: it._remaining,
    unit_price_sen: it.unit_price_sen,
    line_total_sen: Math.max(0, it._remaining * it.unit_price_sen - discFor(it)),
    item_group: it.item_group,
    description: it.description,
    description2: it.description2,
    uom: it.uom ?? 'UNIT',
    variants: it.variants,
    gap_inches: it.gap_inches,
    divan_height_inches: it.divan_height_inches,
    divan_price_sen: it.divan_price_sen ?? 0,
    leg_height_inches: it.leg_height_inches,
    leg_price_sen: it.leg_price_sen ?? 0,
    custom_specials: it.custom_specials,
    line_suffix: it.line_suffix,
    special_order_price_sen: it.special_order_price_sen ?? 0,
    discount_sen: discFor(it),
  }));
  const { error: insErr } = await withPoPriceSnapshot(sb, rows, () => sb.from('purchase_invoice_items').insert(stampCompany(rows, c)));
  if (insErr) {
    await sb.from('purchase_invoices').delete().eq('id', h.id);
    if (isGrnLineOverInvoiced(insErr)) return c.json({ error: 'qty_exceeds_remaining', message: 'Another purchase invoice already bills these goods received lines. Refresh and try again.', reason: insErr.message }, 409);
    return c.json({ error: 'items_insert_failed', reason: insErr.message }, 500);
  }

  {
    const verify = await verifyGrnLinesNotOverInvoiced(sb, lines.map((it) => it.id));
    // eslint-disable-next-line no-console
    if (verify.error) console.error(`[pi over-invoice verify] ${h.id}: ${verify.error}`);
    const over = verify.over;
    if (over.length > 0) {
      await sb.from('purchase_invoices').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', lines: over }, 409);
    }
  }

  await recomputePiTotals(sb, h.id);

  await recordPiCreate(
    sb, c.get('houzsUser'), activeCompanyId(c), h.id, rows.length,
    `Converted from Goods Receipt ${g.grn_number ?? g.id}`,
  );

  await recomputeGrnInvoiced(sb, lines.map((it) => it.id));

  await reallocatePiCharges(sb, h.id, undefined, activeCompanyId(c));
  await recostFromGrn(sb, g.id);

  const { problems: acNotSent } = await enqueueConvert(sb, {
    companyId: activeCompanyId(c),
    op: 'gr_to_pi',
    from: { table: 'grns', keyCol: 'id', key: g.id },
    to: { table: 'purchase_invoices', keyCol: 'id', key: h.id },
    docType: 'PI',
    docNo: h.invoice_number,
    docId: h.id,
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  return c.json({ id: h.id, invoiceNumber: h.invoice_number, ...(acNotSent.length ? { acNotSent } : {}) }, 201);
};
purchaseInvoices.post('/from-grn', createPurchaseInvoiceFromGrnHandler);


purchaseInvoices.patch('/:id', async (c) => {
  const id = c.req.param('id');
  // company-scope: the header write below keys on the caller's uuid alone.
  const { data: own, error: ownErr } = await scopeToCompany(c.get('supabase').from('purchase_invoices').select('id').eq('id', id), c).maybeSingle();
  if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
  if (!own) return c.json({ error: 'not_found' }, 404);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of PI_AUDIT_FIELDS) {
    if (from === 'exchangeRate') continue;
    if (body[from] !== undefined) updates[to] = body[from];
  }
  if (updates.currency !== undefined) updates.currency = normalizeCurrency(updates.currency);
  const sb = c.get('supabase');
  if (updates.supplier_invoice_ref !== undefined || updates.supplier_id !== undefined) {
    const { data: cur, error: curErr } = await scopeToCompany(sb.from('purchase_invoices').select('supplier_id, supplier_invoice_ref, company_id').eq('id', id), c).maybeSingle();
    if (curErr) return c.json({ error: 'lookup_failed', reason: curErr.message }, 500);
    const row = (cur ?? {}) as { supplier_id?: string | null; supplier_invoice_ref?: string | null; company_id?: number | null };
    const ref = updates.supplier_invoice_ref !== undefined ? updates.supplier_invoice_ref : row.supplier_invoice_ref;
    const supplierId = String((updates.supplier_id !== undefined ? updates.supplier_id : row.supplier_id) ?? '');
    if (row.company_id != null) {
      const dup = await findDuplicateSupplierBill(sb, 'purchase_invoices', { companyId: row.company_id, supplierId, ref, excludeId: id, docKind: null });
      if (!dup.ok) return c.json({ error: 'lookup_failed', reason: dup.reason }, 500);
      if (dup.duplicate) return c.json(duplicateBillRefusal(ref, dup.duplicate), 409);
    }
  }

  const { data: beforeRow } = await sb.from('purchase_invoices')
    .select(`${HEADER}, company_id`).eq('id', id).maybeSingle();
  const before = (beforeRow ?? {}) as unknown as Record<string, unknown>;
  {
    const rateGuard = await assertForeignRatePatchable(sb, {
      fromCurrency: before.currency,
      toCurrency: updates.currency,
      operatorRate: body.exchangeRate,
      docLabel: 'purchase invoice',
    });
    if (!rateGuard.ok) return c.json(rateGuard.body, 422);
  }
  let piRateChanged = false;
  if (body.exchangeRate !== undefined || updates.currency !== undefined) {
    let effectiveCurrency = updates.currency as string | undefined;
    if (effectiveCurrency === undefined) {
      effectiveCurrency = (before.currency as string | undefined) ?? 'MYR';
    }
    if (body.exchangeRate !== undefined) {
      updates.exchange_rate = normalizeExchangeRate(body.exchangeRate, effectiveCurrency);
      piRateChanged = true;
    } else if (String(effectiveCurrency).toUpperCase() === 'MYR') {
      updates.exchange_rate = 1;
      piRateChanged = true;
    }
  }
  const { data, error } = await sb.from('purchase_invoices').update(coerceEmptyDates(updates)).eq('id', id).select(HEADER).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  {
    const auditPatch: Record<string, unknown> = {};
    for (const [camel, snake] of PI_AUDIT_FIELDS) {
      if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
    }
    await recordEntityAudit(sb, {
      entityType: 'PURCHASE_INVOICE',
      entityId: id,
      entityDocNo: (before.invoice_number as string | null) ?? null,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: (before.company_id as number | null) ?? activeCompanyId(c),
      statusSnapshot: (before.status as string | null) ?? null,
      fieldChanges: diffFields(before, auditPatch, PI_AUDIT_FIELDS),
    });
  }

  if (piRateChanged) {
    const inv = (data as { invoice_number?: string } | null)?.invoice_number;
    if (inv) {
      try { await resyncPiAccounting(sb, inv); } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-patch] resync failed:', inv, e); }
    }
    await reallocatePiCharges(sb, id, undefined, activeCompanyId(c));
    try { await recostForPi(sb, id); } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-patch] recost failed:', id, e); }
  }
  await queueAcPiEdit(c, id);
  return c.json({ purchaseInvoice: data });
});

purchaseInvoices.post('/:id/items', async (c) => {
  const piId = c.req.param('id');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);
  if (!it.materialName) return c.json({ error: 'material_name_required' }, 400);

  const sb = c.get('supabase');
  /* company-scope: prove the PARENT invoice first, like the three sibling line
     verbs. `company_id: activeCompanyId(c)` on the inserted LINE is a STAMP, not
     a predicate — it tags the new line as ours while hanging it off the other
     company's invoice. piLocked below returns null on a miss, so it is not a
     load either. */
  const { data: own, error: ownErr } = await scopeToCompany(sb.from('purchase_invoices').select('id, grn_id').eq('id', piId), c).maybeSingle();
  if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
  if (!own) return c.json({ error: 'not_found' }, 404);
  const lock = await piLocked(sb, piId);
  if (lock) return c.json(lock, 409);

  {
    const covered = await coveredGrnIds(sb, {
      headerGrnId: (own as { grn_id?: string | null }).grn_id ?? null,
      piId,
      grnItemIds: [(it.grnItemId as string | undefined) ?? null],
    });
    if (covered.error) return c.json(unlinkedCheckFailedResponse(covered.error), 500);
    const unlinked = await findUnlinkedPiLines(sb, covered.ids, [{
      lineRef: String(it.lineNumber ?? '0'),
      itemCode: String(it.itemCode ?? ''),
      qty: Number(it.qty ?? 1),
      soItemId: (it.grnItemId as string | undefined) ?? null,
    }]);
    if (!unlinked.ok) return c.json(unlinkedCheckFailedResponse(unlinked.reason), 500);
    if (unlinked.offenders.length > 0) return c.json(unlinkedInvoiceResponse(unlinked.offenders), 409);
  }

  const qty = Number(it.qty ?? 1);
  const unitPriceSen = Number(it.unitPriceSen ?? 0);
  const discountSen = Number(it.discountSen ?? 0);
  const lineTotal = Math.max(0, (qty * unitPriceSen) - discountSen);

  const grnItemId = (it.grnItemId as string) ?? null;
  if (grnItemId) {
    const xl = await assertSourceLinesInCompany(sb, c, 'grn_items', [grnItemId], { lines: [it], linkField: 'grnItemId', source: 'Goods Receipt line' });
    if (!xl.ok) return c.json(xl.body, xl.status);
    const mig = await migratedRefusalForGrnItems(sb, [grnItemId]);
    if (!mig.ok) return c.json({ error: 'load_failed', reason: mig.reason }, 500);
    if (mig.refusal) return c.json(mig.refusal, 409);
    const capLock = await qtyCapRefusal(sb, {
      table: 'grn_items', id: grnItemId,
      capColumn: 'qty_accepted', drawnColumns: ['invoiced_qty', 'returned_qty'],
      requested: qty, what: 'GRN line',
    });
    if (capLock) return c.json(capLock, 409);
  }

  const row: Record<string, unknown> = {
    purchase_invoice_id: piId,
    grn_item_id: (it.grnItemId as string) ?? null,
    material_kind: (it.materialKind as string) ?? 'mfg_product',
    item_code: it.itemCode,
    material_name: it.materialName,
    qty,
    unit_price_sen: unitPriceSen,
    discount_sen: discountSen,
    line_total_sen: lineTotal,
    unit_cost_sen: Number(it.unitCostSen ?? 0),
    notes: (it.notes as string) ?? null,
    gap_inches: (it.gapInches as number) ?? null,
    divan_height_inches: (it.divanHeightInches as number) ?? null,
    divan_price_sen: Number(it.divanPriceSen ?? 0),
    leg_height_inches: (it.legHeightInches as number) ?? null,
    leg_price_sen: Number(it.legPriceSen ?? 0),
    custom_specials: (it.customSpecials as unknown) ?? null,
    line_suffix: (it.lineSuffix as string) ?? null,
    special_order_price_sen: Number(it.specialOrderPriceSen ?? 0),
    variants: (it.variants as unknown) ?? null,
    item_group: (it.itemGroup as string) ?? null,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
    uom: (it.uom as string) ?? 'UNIT',
  };
  const { data, error } = await withPoPriceSnapshot(sb, [row], () => sb.from('purchase_invoice_items').insert({ ...row, company_id: activeCompanyId(c) }).select(ITEM).single());
  if (isGrnLineOverInvoiced(error)) return c.json({ error: 'qty_exceeds_remaining', message: 'Add qty exceeds what is left to bill on the goods received line.', reason: error?.message }, 409);
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  if (grnItemId) {
    const inserted = data as unknown as { id: string } | null;
    const { data: gi } = await sb.from('grn_items')
      .select('qty_accepted, returned_qty').eq('id', grnItemId).maybeSingle();
    if (gi) {
      const g = gi as { qty_accepted: number; returned_qty: number };
      const cap = (g.qty_accepted ?? 0) - (g.returned_qty ?? 0);
      const { data: sib } = await sb.from('purchase_invoice_items')
        .select('qty, purchase_invoice_id').eq('grn_item_id', grnItemId);
      const sibRows = (sib ?? []) as Array<{ qty: number; purchase_invoice_id: string }>;
      const piIds = [...new Set(sibRows.map((r) => r.purchase_invoice_id))];
      const cancelled = new Set<string>();
      if (piIds.length > 0) {
        const { data: pis } = await sb.from('purchase_invoices').select('id, status').in('id', piIds);
        for (const p of (pis ?? []) as Array<{ id: string; status: string }>) {
          if (p.status === 'CANCELLED') cancelled.add(p.id);
        }
      }
      const liveInvoiced = sibRows
        .filter((r) => !cancelled.has(r.purchase_invoice_id))
        .reduce((s, r) => s + Number(r.qty ?? 0), 0);
      if (liveInvoiced > cap && inserted?.id) {
        await sb.from('purchase_invoice_items').delete().eq('id', inserted.id);
        return c.json({ error: 'qty_exceeds_remaining', requested: qty, remaining: cap - (liveInvoiced - qty) }, 409);
      }
    }
  }

  {
    const added = (data ?? {}) as unknown as Record<string, unknown>;
    const meta = await loadPiAuditMeta(sb, piId);
    await recordEntityAudit(sb, {
      entityType: 'PURCHASE_INVOICE',
      entityId: piId,
      entityDocNo: meta.docNo,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: meta.companyId ?? activeCompanyId(c),
      statusSnapshot: meta.status,
      note: `Line added: ${String(it.itemCode ?? '')}`,
      fieldChanges: compactChanges(
        PI_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, null, added[snake] ?? null)),
      ),
    });
  }

  if (grnItemId) await recomputeGrnInvoiced(sb, [grnItemId]);
  await recomputePiTotals(sb, piId);
  await reallocatePiCharges(sb, piId, undefined, activeCompanyId(c));
  await recostForPi(sb, piId);
  await queueAcPiEdit(c, piId, [], ((data as { id?: unknown } | null)?.id ? [String((data as { id?: unknown }).id)] : []));
  return c.json({ item: data }, 201);
});

purchaseInvoices.patch('/:id/items/:itemId', async (c) => {
  const piId = c.req.param('id'); const itemId = c.req.param('itemId');
  /* company-scope: prove the PARENT invoice first. The M10 note below scopes the
     LINE to this PI, which proves the pair belongs together, never whose it is —
     both ids come from the caller. */
  const { data: own, error: ownErr } = await scopeToCompany(c.get('supabase').from('purchase_invoices').select('id, grn_id').eq('id', piId), c).maybeSingle();
  if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
  if (!own) return c.json({ error: 'not_found' }, 404);
  const parentGrnId = (own as { grn_id?: string | null }).grn_id ?? null;
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const lock = await piLocked(sb, piId);
  if (lock) return c.json(lock, 409);

  const { data: prevRow } = await scopeToCompanyId(sb.from('purchase_invoice_items')
    .select(PI_LINE_AUDIT_SELECT + ', variants, grn_item_id')
    .eq('id', itemId).eq('purchase_invoice_id', piId), co.companyId).maybeSingle();
  if (!prevRow) return c.json(NOT_THIS_COMPANY, 404);
  const prev = prevRow as unknown as Record<string, unknown>;

  const prevQty = Number(prev.qty);
  const grnItemId = (prev.grn_item_id as string | null) ?? null;
  const qty = it.qty !== undefined ? Number(it.qty) : prevQty;
  const unit = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : Number(prev.unit_price_sen);
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : Number(prev.discount_sen ?? 0);
  const lineTotal = Math.max(0, (qty * unit) - discount);

  const updates: Record<string, unknown> = {
    qty,
    unit_price_sen: unit,
    discount_sen: discount,
    line_total_sen: lineTotal,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['materialName', 'material_name'],
    ['itemGroup', 'item_group'], ['description', 'description'], ['uom', 'uom'],
    ['unitCostSen', 'unit_cost_sen'], ['notes', 'notes'],
    ['gapInches', 'gap_inches'], ['divanHeightInches', 'divan_height_inches'],
    ['divanPriceSen', 'divan_price_sen'], ['legHeightInches', 'leg_height_inches'],
    ['legPriceSen', 'leg_price_sen'], ['customSpecials', 'custom_specials'],
    ['lineSuffix', 'line_suffix'], ['specialOrderPriceSen', 'special_order_price_sen'],
    ['variants', 'variants'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  if (!grnItemId && it.itemCode !== undefined) {
    const covered = await coveredGrnIds(sb, { headerGrnId: parentGrnId, piId });
    if (covered.error) return c.json(unlinkedCheckFailedResponse(covered.error), 500);
    const unlinked = await findUnlinkedPiLines(sb, covered.ids, [{
      lineRef: itemId,
      itemCode: String(it.itemCode ?? prev.item_code ?? ''),
      qty,
      soItemId: null,
    }]);
    if (!unlinked.ok) return c.json(unlinkedCheckFailedResponse(unlinked.reason), 500);
    if (unlinked.offenders.length > 0) return c.json(unlinkedInvoiceResponse(unlinked.offenders), 409);
  }

  const delta = qty - prevQty;
  if (grnItemId && delta !== 0) {
    const capLock = await qtyCapRefusal(sb, {
      table: 'grn_items', id: grnItemId,
      capColumn: 'qty_accepted', drawnColumns: ['invoiced_qty', 'returned_qty'],
      requested: qty, ownPriorDraw: prevQty, what: 'GRN line',
    });
    if (capLock) return c.json(capLock, 409);
  }

  /* THE LINK CAN ALSO DRIFT AFTER THE FACT. docs/bugs/0672's second structural
     observation: four EDIT paths let `item_code` be rewritten UNDER a live link,
     so a line bound correctly at create time can be edited out of identity with
     its source afterwards; only the GRN edit path freezes it
     (grnInheritedFieldChanges). Re-asserted against the code that will actually
     be STORED — the body's when it sends one, the previous value otherwise. */
  if (grnItemId) {
    const xl = await assertSourceLinesInCompany(sb, c, 'grn_items', [grnItemId],
      { lines: [{ grnItemId, itemCode: it.itemCode ?? prev.item_code }], linkField: 'grnItemId', source: 'Goods Receipt line' });
    if (!xl.ok) return c.json(xl.body, xl.status);
  }

  const { error } = await scopeToCompanyId(sb.from('purchase_invoice_items').update(updates).eq('id', itemId), co.companyId);
  if (isGrnLineOverInvoiced(error)) return c.json({ error: 'qty_exceeds_remaining', message: 'New qty exceeds what is left to bill on the goods received line.', reason: error?.message }, 409);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  {
    const auditPatch: Record<string, unknown> = {};
    for (const [camel, snake] of PI_LINE_AUDIT_FIELDS) {
      if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
    }
    const lineChanges = diffFields(prev, auditPatch, PI_LINE_AUDIT_FIELDS);
    if (lineChanges.length > 0) {
      const meta = await loadPiAuditMeta(sb, piId);
      await recordEntityAudit(sb, {
        entityType: 'PURCHASE_INVOICE',
        entityId: piId,
        entityDocNo: meta.docNo,
        action: 'UPDATE',
        actor: c.get('houzsUser'),
        companyId: meta.companyId ?? activeCompanyId(c),
        statusSnapshot: meta.status,
        note: `Line edited: ${String(prev.item_code ?? itemId)}`,
        fieldChanges: lineChanges,
      });
    }
  }

  if (grnItemId) await recomputeGrnInvoiced(sb, [grnItemId]);
  await recomputePiTotals(sb, piId);
  await reallocatePiCharges(sb, piId, undefined, activeCompanyId(c));
  await recostForPi(sb, piId);
  try {
    const { data: h } = await sb.from('purchase_invoices').select('invoice_number').eq('id', piId).maybeSingle();
    if (h) await resyncPiAccounting(sb, (h as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-accounting] post-line-edit resync failed:', e); }
  await queueAcPiEdit(c, piId);
  return c.json({ ok: true });
});

purchaseInvoices.delete('/:id/items/:itemId', async (c) => {
  const piId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: own, error: ownErr } = await scopeToCompanyId(sb.from('purchase_invoices').select('id').eq('id', piId), co.companyId).maybeSingle();
  if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
  if (!own) return c.json(NOT_THIS_COMPANY, 404);
  const lock = await piLocked(sb, piId);
  if (lock) return c.json(lock, 409);

  const { data: lineRow } = await scopeToCompanyId(sb.from('purchase_invoice_items')
    .select(PI_LINE_AUDIT_SELECT + ', grn_item_id').eq('id', itemId).eq('purchase_invoice_id', piId), co.companyId).maybeSingle();
  if (!lineRow) return c.json(NOT_THIS_COMPANY, 404);
  const line = lineRow as unknown as Record<string, unknown>;

  const retire = await retiredLineOf(sb, 'purchase_invoice_items', itemId);

  const { error } = await scopeToCompanyId(sb.from('purchase_invoice_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  {
    const meta = await loadPiAuditMeta(sb, piId);
    await recordEntityAudit(sb, {
      entityType: 'PURCHASE_INVOICE',
      entityId: piId,
      entityDocNo: meta.docNo,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: meta.companyId ?? activeCompanyId(c),
      statusSnapshot: meta.status,
      note: `Line removed: ${String(line.item_code ?? itemId)}`,
      fieldChanges: compactChanges(
        PI_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, line[snake] ?? null, null)),
      ),
    });
  }

  {
    const l = { qty: Number(line.qty), grn_item_id: (line.grn_item_id as string | null) ?? null };
    if (l.grn_item_id) await recomputeGrnInvoiced(sb, [l.grn_item_id]);
    await reallocatePiCharges(sb, piId, undefined, activeCompanyId(c));
    if (l.grn_item_id) {
      const { data: gi } = await sb.from('grn_items').select('grn_id').eq('id', l.grn_item_id).maybeSingle();
      const gid = (gi as { grn_id: string | null } | null)?.grn_id ?? null;
      if (gid) await recostFromGrn(sb, gid);
    }
    await recostForPi(sb, piId);
  }
  await recomputePiTotals(sb, piId);
  try {
    const { data: h } = await sb.from('purchase_invoices').select('invoice_number').eq('id', piId).maybeSingle();
    if (h) await resyncPiAccounting(sb, (h as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-accounting] post-line-delete resync failed:', e); }
  await queueAcPiEdit(c, piId, retire);
  return c.body(null, 204);
});
