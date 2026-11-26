// ----------------------------------------------------------------------------
// /stock-takes — AutoCount-style cycle count (PR — Inv PR5).
//
// OPEN → POSTED. PR-DRAFT-removal (2026-05-27): renamed DRAFT → OPEN
// because cycle counts legitimately need an editable working state
// (commander types counted_qty per line BEFORE posting). "OPEN" makes
// the intent explicit rather than borrowing the deprecated "DRAFT" label.
//
// On create, the API snapshots system_qty for every SKU in the chosen
// scope (ALL / CATEGORY / CODE_PREFIX / NONZERO) at the chosen warehouse.
// The commander types counted_qty per line. On Post, for every line with a
// non-zero variance, an ADJUSTMENT movement is inserted into
// inventory_movements with a SIGNED qty.
//
// ACCOUNTABILITY (phase 1, owner-approved 2026-08-08, migration 0270):
//   • Every take carries an ASSIGNEE (assignee_staff_id, required on create).
//     Posting is allowed only for the assignee or a holder of
//     scm.stock_take.supervise; legacy takes without an assignee keep the old
//     "any area-access caller" behaviour so history stays operable.
//   • Variances beyond the configured threshold (scm/shared/
//     stock-take-threshold.ts — default 5 units or RM500 per line) need a
//     supervisor. Owner 2026-11-20: a non-supervisor's over-threshold post no
//     longer REFUSES — it SUBMITS (OPEN → PENDING_APPROVAL, no stock moved),
//     naming the SKUs, and a supervisor /approve books it (→ POSTED) or /reject
//     returns it (→ OPEN). A supervisor still posts straight through.
//   • Every counted CELL records WHO and WHEN (counted_by / counted_at,
//     stamped from the caller's REAL scm.staff uuid via the mig-0066 bridge).
//   • BLIND counts: with take.blind set, system_qty / variance are stripped
//     server-side from every read while the take is OPEN unless the caller
//     holds scm.stock_take.supervise. The counter counts blind; the
//     supervisor view (and any post-POSTED read) sees everything.
//
// Numbering: STK-YYMM-NNN (month-scoped count + 1), same pattern as ST.
//
// Endpoints:
//   GET    /stock-takes                — list (status, warehouseId, dateFrom, dateTo)
//   GET    /stock-takes/:id            — header + lines + warehouse name
//   POST   /stock-takes                — create OPEN + snapshot scope
//   PATCH  /stock-takes/:id/lines      — bulk update counted_qty (OPEN only)
//   PATCH  /stock-takes/:id/post       — OPEN → POSTED (writes ADJUSTMENT movements),
//                                         or OPEN → PENDING_APPROVAL (over-limit, non-supervisor)
//   PATCH  /stock-takes/:id/approve    — PENDING_APPROVAL → POSTED (supervisor books it)
//   PATCH  /stock-takes/:id/reject     — PENDING_APPROVAL → OPEN (supervisor returns it)
//   PATCH  /stock-takes/:id/cancel     — OPEN → CANCELLED
//   PATCH  /stock-takes/:id/reverse    — POSTED → CANCELLED (undo: reverses the ADJUSTMENT movements)
//   PATCH  /stock-takes/:id/reopen     — CANCELLED → OPEN (re-snapshots the sheet to current stock)
//   DELETE /stock-takes/:id            — OPEN only
// ----------------------------------------------------------------------------

import { yymmFor } from '../../services/documentRefs';
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { mintMonthlyDocNo, insertWithDocNoRetry, docMonthTag } from '../lib/doc-no';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { assertWarehouseInCompany } from '../lib/ref-in-company';
import { recordEntityAudit, compactChanges, fieldChange, statusChange, assertAuditWritable, auditUnavailableBody, type FieldChange } from '../lib/entity-audit';
import { resolveForcedUnitCostSen, type LotCostRow } from '../shared';
import {
  parseVarianceThresholds, findVarianceBreaches, formatVarianceRefusal,
  type VarianceLine,
} from '../shared/stock-take-threshold';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { poNumbersByGrnId } from '../lib/source-po-trace';
import { resolveCallerStaffId } from '../lib/salesScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { pgrestIn } from '../lib/pgrest-in-list';
import { readStockTakeSheetHandler } from './stock-take-sheet-read';
import { applyStockTakeRacks } from '../lib/stock-take-racks';

export const stockTakes = new Hono<{ Bindings: Env; Variables: Variables }>();
stockTakes.use('*', supabaseAuth);

const SUPERVISE_PERM = 'scm.stock_take.supervise';

const HEADER =
  'id, take_no, status, warehouse_id, scope_type, scope_value, take_date, ' +
  'notes, posted_at, cancelled_at, created_at, created_by, assignee_staff_id, blind, ' +
  'assignee_staff_ids, nonzero_only, submitted_at, submitted_by';
const LINE =
  'id, stock_take_id, item_code, product_name, variant_key, variant_label, ' +
  'system_qty, counted_qty, variance, notes, created_at, counted_by, counted_at, added_on_count, rack_id, ' +
  'entered_unit_cost_sen';

const VALID_STATUS = new Set(['OPEN', 'PENDING_APPROVAL', 'POSTED', 'CANCELLED']);
const VALID_SCOPE  = new Set(['ALL', 'CATEGORY', 'CODE_PREFIX', 'NONZERO']);

const callerStaffIdOf = async (sb: any, c: any): Promise<string | null> => {
  try {
    return await resolveCallerStaffId(sb, c.get('houzsUser')?.id ?? null);
  } catch {
    return null;
  }
};

async function notOpenOrNotOurs(
  sb: any, id: string, companyId: number, expected: string,
): Promise<{ body: Record<string, unknown>; status: 404 | 409 }> {
  const { data } = await scopeToCompanyId(
    sb.from('stock_takes').select('id').eq('id', id), companyId,
  ).maybeSingle();
  if (!data) return { body: NOT_THIS_COMPANY, status: 404 };
  const error = expected === 'OPEN' ? 'not_open'
    : expected === 'PENDING_APPROVAL' ? 'not_pending'
    : 'not_posted';
  return { body: { error }, status: 409 };
}

const nextTakeNo = async (sb: any, c: any): Promise<string> => {
  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'stock_takes', 'take_no', `${p}STK-${yymm}`);
};

type ScopedSku = {
  item_code: string; product_name: string | null;
  variant_key: string; variant_label: string | null; qty: number;
};

const labelFromVariantKey = (vk: string): string | null => {
  if (!vk) return null;
  return vk.split('|').map((p) => p.replace('=', ' ')).join(' · ');
};

const fetchScopedSkus = async (
  sb: any,
  warehouseId: string,
  scopeType: 'ALL' | 'CATEGORY' | 'CODE_PREFIX' | 'NONZERO',
  scopeValue: string | null,
  nonzeroOnly: boolean,
  c: any,
): Promise<{ rows: ScopedSku[]; error?: string }> => {
  const dropZero = scopeType === 'NONZERO' || nonzeroOnly;
  const { data: skuData, error: skuErr } = await paginateAll((pFrom, pTo) => {
    let q = scopeToCompany(sb.from('v_inventory_all_skus')
      .select('item_code, product_name, category')
      .eq('warehouse_id', warehouseId), c);
    if (scopeType === 'CATEGORY' && scopeValue) {
      q = q.eq('category', scopeValue);
    } else if (scopeType === 'CODE_PREFIX' && scopeValue) {
      q = q.ilike('item_code', `${scopeValue}%`);
    }
    return q.order('item_code').range(pFrom, pTo);
  });
  if (skuErr) return { rows: [], error: skuErr.message };
  const skus = ((skuData as Array<{ item_code: string; product_name: string | null }>) ?? []);
  if (skus.length === 0) return { rows: [] };
  const nameByCode = new Map(skus.map((s) => [s.item_code, s.product_name] as const));
  const codes = [...nameByCode.keys()];

  const balByCode = new Map<string, Array<{ variant_key: string; product_name: string | null; qty: number }>>();
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    const { data: balData, error: balErr } = await scopeToCompany(
      pgrestIn(sb.from('inventory_balances')
        .select('item_code, variant_key, product_name, qty')
        .eq('warehouse_id', warehouseId), 'item_code', chunk),
      c,
    );
    if (balErr) return { rows: [], error: balErr.message };
    for (const b of (balData as Array<{
      item_code: string; variant_key: string | null; product_name: string | null; qty: number | null;
    }>) ?? []) {
      const list = balByCode.get(b.item_code) ?? [];
      list.push({ variant_key: b.variant_key ?? '', product_name: b.product_name, qty: Number(b.qty ?? 0) });
      balByCode.set(b.item_code, list);
    }
  }

  const rows: ScopedSku[] = [];
  for (const code of codes) {
    const name = nameByCode.get(code) ?? null;
    const buckets = balByCode.get(code);
    if (buckets && buckets.length > 0) {
      for (const b of buckets) {
        if (dropZero && b.qty === 0) continue;
        rows.push({
          item_code: code,
          product_name: b.product_name ?? name,
          variant_key: b.variant_key,
          variant_label: labelFromVariantKey(b.variant_key),
          qty: b.qty,
        });
      }
    } else if (!dropZero) {
      rows.push({ item_code: code, product_name: name, variant_key: '', variant_label: null, qty: 0 });
    }
  }
  rows.sort((a, b) =>
    a.item_code.localeCompare(b.item_code) || a.variant_key.localeCompare(b.variant_key));
  return { rows };
};

stockTakes.get('/', async (c) => {
  const sb = c.get('supabase');
  const status      = c.req.query('status');
  const warehouseId = c.req.query('warehouseId');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');

  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb.from('stock_takes')
      .select(`${HEADER}, warehouse:warehouses(id, code, name)`)
      .order('take_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (status && VALID_STATUS.has(status)) q = q.eq('status', status);
    if (c.req.query('submitted') === 'true') q = q.not('submitted_at', 'is', null);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    if (dateFrom)    q = q.gte('take_date', dateFrom);
    if (dateTo)      q = q.lte('take_date', dateTo);
    q = scopeToCompany(q, c);
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = (data as unknown as Array<Record<string, unknown>>) ?? [];
  const ids  = rows.map((r) => r.id as string);
  const countByTake    = new Map<string, number>();
  const varianceByTake = new Map<string, number>();
  if (ids.length > 0) {
    const { data: lineRows } = await chunkIn<{ stock_take_id: string; variance: number | null; counted_qty: number | null }>(ids, (batch, pFrom, pTo) => sb
      .from('stock_take_lines')
      .select('stock_take_id, variance, counted_qty')
      .in('stock_take_id', batch)
      .range(pFrom, pTo));
    const list = (lineRows as unknown as Array<{
      stock_take_id: string; variance: number | null; counted_qty: number | null;
    }>) ?? [];
    for (const l of list) {
      countByTake.set(l.stock_take_id, (countByTake.get(l.stock_take_id) ?? 0) + 1);
      if (l.counted_qty != null && l.variance != null) {
        varianceByTake.set(
          l.stock_take_id,
          (varianceByTake.get(l.stock_take_id) ?? 0) + Number(l.variance),
        );
      }
    }
  }

  const canSupervise = hasHouzsPerm(c, SUPERVISE_PERM);
  const takes = rows.map((r) => {
    const blindActive = r.blind === true && r.status === 'OPEN' && !canSupervise;
    return {
      ...r,
      line_count:     countByTake.get(r.id as string)    ?? 0,
      variance_total: blindActive ? null : (varianceByTake.get(r.id as string) ?? 0),
    };
  });

  return c.json({ takes });
});

const assigneesOf = (t: { assignee_staff_id?: string | null; assignee_staff_ids?: string[] | null }): string[] =>
  t.assignee_staff_ids && t.assignee_staff_ids.length > 0
    ? t.assignee_staff_ids
    : t.assignee_staff_id ? [t.assignee_staff_id] : [];

export const readAssignees = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client / Hono context without generated types; same as every handler in this file
  sb: any, body: Record<string, unknown>,
): Promise<{ ok: true; ids: string[] } | { ok: false; body: Record<string, unknown> }> => {
  const raw: unknown[] = Array.isArray(body.assigneeStaffIds)
    ? body.assigneeStaffIds
    : typeof body.assigneeStaffId === 'string' ? [body.assigneeStaffId] : [];
  const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return { ok: false, body: { error: 'assignee_required', message: 'Pick at least one assignee — who is counting.' } };
  }
  if (ids.length > 10) return { ok: false, body: { error: 'too_many_assignees', message: 'At most 10 assignees.' } };
  const { data, error } = await sb.from('staff').select('id').in('id', ids);
  if (error) return { ok: false, body: { error: 'load_failed', message: 'Could not check the staff list — try again.' } };
  const found = new Set(((data as Array<{ id: string }> | null) ?? []).map((r) => r.id));
  if (ids.some((x) => !found.has(x))) {
    return { ok: false, body: { error: 'invalid_assignee', message: 'One of the assignees does not exist. Pick people from the staff list.' } };
  }
  return { ok: true, ids };
};

/* Best-known unit cost per (item_code, variant_key) at a warehouse — the ladder
   the post itself uses. A read failure leaves every estimate null (shown "—"),
   never 0: an RM0 estimate would read as "this variance costs nothing".
   HC-0158: the same lot read also names the PO(s) behind each bucket's OPEN lots
   (batch_no, else GRN -> PO, as source-po-trace classifies them), so a sofa /
   bedframe count can be traced. A lot with neither (AC opening, adjustment) and
   a negative bucket (no open lot) name no PO. */
type SourcePo = { po: string; qty: number };
type LotFactRow = LotCostRow & {
  item_code: string; variant_key: string | null;
  batch_no: string | null; source_doc_id: string | null;
};
const lineLotFacts = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client / Hono context without generated types; same as every handler in this file
  sb: any, c: any, warehouseId: string,
  lines: Array<{ item_code: string; variant_key: string | null }>,
): Promise<{ costByKey: Map<string, number | null>; posByKey: Map<string, SourcePo[]> }> => {
  const lotsByKey = new Map<string, LotFactRow[]>();
  const codes = [...new Set(lines.map((l) => l.item_code))];
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    const { data: lots, error } = await paginateAll((pFrom, pTo) => scopeToCompany(
      pgrestIn(sb.from('inventory_lots')
        .select('item_code, variant_key, unit_cost_sen, qty_remaining, source_doc_type, source_doc_id, batch_no, received_at')
        .eq('warehouse_id', warehouseId), 'item_code', chunk),
      c,
    ).range(pFrom, pTo));
    if (error) return { costByKey: new Map(), posByKey: new Map() };
    for (const l of (lots as LotFactRow[] | null) ?? []) {
      const key = `${l.item_code} ${l.variant_key ?? ''}`;
      (lotsByKey.get(key) ?? lotsByKey.set(key, []).get(key)!).push(l);
    }
  }
  const openLots = [...lotsByKey.values()].flat().filter((l) => Number(l.qty_remaining ?? 0) > 0);
  const poByGrn = await poNumbersByGrnId(sb, openLots
    .filter((l) => !l.batch_no && (l.source_doc_type ?? '').toUpperCase() === 'GRN' && l.source_doc_id)
    .map((l) => l.source_doc_id as string));
  const costByKey = new Map<string, number | null>();
  const posByKey = new Map<string, SourcePo[]>();
  for (const l of lines) {
    const key = `${l.item_code} ${l.variant_key ?? ''}`;
    if (costByKey.has(key)) continue;
    const bucket = lotsByKey.get(key) ?? [];
    const r = resolveForcedUnitCostSen({ lots: bucket });
    costByKey.set(key, r.ok ? r.unitCostSen : null);
    const qtyByPo = new Map<string, number>();
    for (const lot of bucket) {
      const qty = Number(lot.qty_remaining ?? 0);
      if (qty <= 0) continue;
      const po = lot.batch_no?.trim()
        || ((lot.source_doc_type ?? '').toUpperCase() === 'GRN' && lot.source_doc_id ? poByGrn.get(lot.source_doc_id) : undefined);
      if (po) qtyByPo.set(po, (qtyByPo.get(po) ?? 0) + qty);
    }
    posByKey.set(key, [...qtyByPo].map(([po, qty]) => ({ po, qty })).sort((a, b) => a.po.localeCompare(b.po)));
  }
  return { costByKey, posByKey };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client / Hono context without generated types; same as every handler in this file
export const pendingApprovalCountHandler = async (c: any) => {
  if (!hasHouzsPerm(c, SUPERVISE_PERM)) return c.json({ count: 0 });
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json({ count: 0 });
  const { count, error } = await scopeToCompany(
    c.get('supabase').from('stock_takes').select('id', { count: 'exact', head: true }).eq('status', 'PENDING_APPROVAL'),
    c,
  );
  if (error) return c.json({ count: 0 });
  return c.json({ count: count ?? 0 });
};
stockTakes.get('/pending-count', pendingApprovalCountHandler);

export const getStockTakeDetailHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');

  const [headerRes, linesRes] = await Promise.all([
    scopeToCompany(sb.from('stock_takes')
      .select(`${HEADER}, warehouse:warehouses(id, code, name)`)
      .eq('id', id), c).maybeSingle(),
    sb.from('stock_take_lines').select(LINE).eq('stock_take_id', id)
      .order('item_code').order('variant_key').order('id'),
  ]);

  if (headerRes.error) return c.json({ error: 'load_failed', reason: headerRes.error.message }, 500);
  if (!headerRes.data) return c.json({ error: 'not_found' }, 404);

  const take = headerRes.data as unknown as {
    status: string; blind: boolean | null; assignee_staff_id: string | null;
    assignee_staff_ids: string[] | null; warehouse_id: string;
  };

  const canSupervise = hasHouzsPerm(c, SUPERVISE_PERM);
  const callerStaffId = await callerStaffIdOf(sb, c);
  const blindActive = take.blind === true && take.status === 'OPEN' && !canSupervise;

  const rawLines = (linesRes.data ?? []) as Array<Record<string, unknown>>;
  /* The RM a variance is worth (owner 2026-10-06: shown to everyone). The same
     best-known unit cost the post uses to value a variance and to cost a found
     lot (resolveForcedUnitCostSen over the bucket's lots at this warehouse);
     null when the SKU has no cost basis. Withheld with the variance on a blind
     take — RM x qty would give the hidden variance straight back. The source
     POs go with it: an open lot's qty is the system qty. */
  const facts = blindActive
    ? null
    : await lineLotFacts(sb, c, take.warehouse_id, rawLines as Array<{ item_code: string; variant_key: string | null }>);
  const lines = !facts
    ? rawLines.map((l) => ({ ...l, system_qty: null, variance: null, est_unit_cost_sen: null, source_pos: [] }))
    : rawLines.map((l) => {
        const key = `${String(l.item_code)} ${String(l.variant_key ?? '')}`;
        return { ...l, est_unit_cost_sen: facts.costByKey.get(key) ?? null, source_pos: facts.posByKey.get(key) ?? [] };
      });

  /* Adjustment link (owner 2026-11-20): a POSTED take booked one ADJUSTMENT
     movement per non-zero-variance line. Surface them so the detail can show
     "what this count moved" and link each SKU to its stock card — where the
     same movement links back (StockCard.tsx), a closed loop. Read ONLY when
     POSTED: an OPEN / PENDING take booked nothing, and a CANCELLED (reversed)
     take's forward + reversal rows net to zero, so showing them would mislead. */
  let adjustments: Array<Record<string, unknown>> = [];
  /* The formal Stock Adjustment document this take booked (owner 2026-11-20) —
     the take links to it instead of a stock card. null for a take posted before
     this feature, or until a backfill mints one. */
  let adjustment: { id: string; adjustment_no: string } | null = null;
  if (take.status === 'POSTED') {
    const { data: movs, error: movsErr } = await sb.from('inventory_movements')
      .select('item_code, product_name, variant_key, qty, unit_cost_sen')
      .eq('source_doc_type', 'STOCK_TAKE')
      .eq('source_doc_id', id);
    if (movsErr) {
      // eslint-disable-next-line no-console
      console.error('[stock-takes] adjustments read failed:', (movsErr as { message?: unknown }).message ?? movsErr);
    } else {
      adjustments = ((movs as Array<Record<string, unknown>>) ?? [])
        .filter((m) => Number(m.qty ?? 0) !== 0)
        .sort((a, b) => String(a.item_code).localeCompare(String(b.item_code)));
    }
    const { data: sa, error: saErr } = await scopeToCompany(
      sb.from('stock_adjustments').select('id, adjustment_no').eq('source_stock_take_id', id), c,
    ).maybeSingle();
    if (saErr) {
      // eslint-disable-next-line no-console
      console.error('[stock-takes] linked adjustment read failed:', (saErr as { message?: unknown }).message ?? saErr);
    } else if (sa) {
      adjustment = sa as unknown as { id: string; adjustment_no: string };
    }
  }

  return c.json({
    take: headerRes.data,
    lines,
    adjustments,
    adjustment,
    viewer: {
      isAssignee: callerStaffId != null && assigneesOf(take).includes(callerStaffId),
      canSupervise,
      blindActive,
    },
  });
};
stockTakes.get('/:id', getStockTakeDetailHandler);

export const createStockTakeHandler = async (c: any) => {
  /* company-scope: two by-id statements here, both correct.
       · the ROLLBACK delete targets the header this handler inserted moments
         earlier (insertWithDocNoRetry stamps the active company), so its id is
         not caller-supplied.
       · the scm.staff existence check MUST NOT be company-filtered. Mig 0089
         lists staff under "Deliberately NOT stamped (shared / per-staff
         reference data)", which is exactly why hr_salesperson_profiles is
         UNIQUE(company_id, staff_id): ONE staff row holds one profile PER
         company. Adding a company predicate there would reject a legitimate
         assignee — a "fix" that manufactures a bug.
     Verified 2026-08-13 by reading the handler end to end. */
  const sb = c.get('supabase');
  const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const warehouseId = body.warehouseId as string | undefined;
  if (!warehouseId) return c.json({ error: 'warehouse_required' }, 400);

  const whCo = requireActiveCompanyId(c);
  if (!whCo.ok) return c.json(whCo.refusal, 409);
  const whCheck = await assertWarehouseInCompany(sb, warehouseId, whCo.companyId);
  if (!whCheck.ok) return c.json(whCheck.body, whCheck.status);

  /* Two or three people count together (owner 2026-10-06): a LIST of
     assignees, kept as a record of who counted. assigneeStaffId (one) is still
     accepted from an older client. */
  const assignees = await readAssignees(sb, body);
  if (!assignees.ok) return c.json(assignees.body, 400);

  const scopeType = (body.scopeType as string | undefined) ?? 'ALL';
  if (!VALID_SCOPE.has(scopeType)) return c.json({ error: 'invalid_scope_type' }, 400);

  const scopeValueRaw = (body.scopeValue as string | undefined) ?? null;
  const scopeValue = scopeValueRaw && scopeValueRaw.trim() ? scopeValueRaw.trim() : null;
  if ((scopeType === 'CATEGORY' || scopeType === 'CODE_PREFIX') && !scopeValue) {
    return c.json({ error: 'scope_value_required_for_this_scope_type' }, 400);
  }

  /* "Only SKUs with stock" combines with Category / Prefix (owner 2026-10-06:
     a Category take listed 704 lines, nearly all zero). */
  const nonzeroOnly = body.nonzeroOnly === true || scopeType === 'NONZERO';
  const scoped = await fetchScopedSkus(
    sb, warehouseId,
    scopeType as 'ALL' | 'CATEGORY' | 'CODE_PREFIX' | 'NONZERO',
    scopeValue,
    nonzeroOnly,
    c,
  );
  if (scoped.error) return c.json({ error: 'scope_load_failed', reason: scoped.error }, 500);
  if (scoped.rows.length === 0) {
    return c.json({ error: 'scope_empty', reason: 'No SKUs match the chosen scope.' }, 400);
  }

  const headerInsert: Record<string, unknown> = {
    company_id:   activeCompanyId(c),
    status:       'OPEN',
    warehouse_id: warehouseId,
    scope_type:   scopeType,
    scope_value:  scopeValue,
    notes:        (body.notes as string | undefined) ?? null,
    created_by:   user.id,
    assignee_staff_id: assignees.ids[0],
    assignee_staff_ids: assignees.ids,
    nonzero_only: nonzeroOnly,
    blind:        body.blind === true,
  };
  if (body.takeDate) headerInsert.take_date = body.takeDate;

  const { data: headerData, error: hErr } = await insertWithDocNoRetry<{ id: string; take_no: string }>(
    () => nextTakeNo(sb, c),
    (takeNo) => sb
      .from('stock_takes').insert({ take_no: takeNo, ...headerInsert }).select(HEADER).single(),
  );
  if (hErr) {
    if (hErr.code === '42501') return c.json({ error: 'forbidden', reason: hErr.message }, 403);
    return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  }
  const header = headerData as unknown as { id: string; take_no: string };

  const lineRows = scoped.rows.map((r) => ({
    stock_take_id: header.id,
    item_code:  r.item_code,
    product_name:  r.product_name,
    variant_key:   r.variant_key,
    variant_label: r.variant_label,
    system_qty:    r.qty,
    counted_qty:   null,
  }));
  const { error: lErr } = await sb.from('stock_take_lines').insert(stampCompany(lineRows, c));
  if (lErr) {
    await sb.from('stock_takes').delete().eq('id', header.id);
    return c.json({ error: 'lines_insert_failed', reason: lErr.message }, 500);
  }

  return c.json({
    id:        header.id,
    takeNo:    header.take_no,
    lineCount: lineRows.length,
  }, 201);
};
stockTakes.post('/', createStockTakeHandler);

export const patchStockTakeLinesHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  // Company scope (owner audit 2026-07-22): the header load was id-only, so
  // a caller in A could patch B's stock-take lines by knowing the UUID. The
  // sibling /cancel /reverse /post already do requireActiveCompanyId; align.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const { data: prev } = await scopeToCompanyId(
    sb.from('stock_takes').select('status, take_no, company_id, warehouse_id').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);
  const head = prev as { status: string; take_no: string; company_id: number | null; warehouse_id: string };
  if (head.status !== 'OPEN') return c.json({ error: 'not_open' }, 409);

  const lines = body.lines as Array<{
    id: string; countedQty?: number | null; notes?: string | null; rackId?: string | null;
    enteredUnitCostSen?: number | null;
  }> | undefined;
  if (!Array.isArray(lines) || lines.length === 0) {
    return c.json({ error: 'lines_required' }, 400);
  }

  const rackIds = [...new Set(lines.map((l) => l.rackId).filter((x): x is string => typeof x === 'string' && x !== ''))];
  if (rackIds.length > 0) {
    const { data: okRacks, error: rkErr } = await scopeToCompanyId(
      sb.from('warehouse_racks').select('id').eq('warehouse_id', head.warehouse_id).in('id', rackIds),
      co.companyId,
    );
    if (rkErr) return c.json({ error: 'load_failed', reason: rkErr.message }, 500);
    const ok = new Set(((okRacks as Array<{ id: string }> | null) ?? []).map((r) => r.id));
    if (rackIds.some((r) => !ok.has(r))) {
      return c.json({ error: 'rack_not_in_warehouse', message: 'A rack picked is not a rack of this warehouse.' }, 400);
    }
  }

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'UPDATE', companyId: head.company_id });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const lineIds = lines.map((l) => l.id).filter((x): x is string => !!x);
  const beforeById = new Map<string, { item_code: string; counted_qty: number | null; notes: string | null }>();
  if (lineIds.length > 0) {
    const { data: beforeLines } = await chunkIn<{
      id: string; item_code: string; counted_qty: number | null; notes: string | null;
    }>(lineIds, (batch, pFrom, pTo) => sb.from('stock_take_lines')
      .select('id, item_code, counted_qty, notes')
      .eq('stock_take_id', id).in('id', batch).range(pFrom, pTo));
    for (const b of beforeLines ?? []) beforeById.set(b.id, b);
  }

  const counterStaffId = await callerStaffIdOf(sb, c);

  const errors: string[] = [];
  const countChanges: Array<FieldChange | null> = [];
  for (const l of lines) {
    if (!l.id) continue;
    const patch: Record<string, unknown> = {};
    if ('countedQty' in l) {
      patch.counted_qty =
        l.countedQty == null || (l.countedQty as unknown) === ''
          ? null
          : Math.max(0, Math.floor(Number(l.countedQty)));
      patch.counted_by = patch.counted_qty == null ? null : counterStaffId;
      patch.counted_at = patch.counted_qty == null ? null : new Date().toISOString();
    }
    if ('notes' in l) patch.notes = l.notes ?? null;
    if ('rackId' in l) patch.rack_id = l.rackId ? l.rackId : null;
    if ('enteredUnitCostSen' in l) {
      const v = l.enteredUnitCostSen;
      patch.entered_unit_cost_sen =
        v == null || (v as unknown) === '' ? null : Math.max(0, Math.round(Number(v)));
    }
    if (Object.keys(patch).length === 0) continue;

    const { error } = await sb.from('stock_take_lines')
      .update(patch).eq('id', l.id).eq('stock_take_id', id);
    if (error) { errors.push(`${l.id}: ${error.message}`); continue; }

    const b = beforeById.get(l.id);
    if ('counted_qty' in patch) {
      countChanges.push(fieldChange(b?.item_code ?? l.id, b?.counted_qty ?? null, patch.counted_qty));
    }
  }

  if (errors.length > 0) {
    return c.json({ error: 'partial_update_failed', errors }, 500);
  }

  const changed = compactChanges(countChanges);
  if (changed.length > 0) {
    await recordEntityAudit(sb, {
      entityType: 'STOCK_TAKE',
      entityId: id,
      entityDocNo: head.take_no,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: head.company_id,
      statusSnapshot: 'OPEN',
      note: `Counted quantity changed on ${changed.length} line(s)`,
      fieldChanges: changed,
    });
  }

  return c.json({ ok: true, updated: lines.length });
};
stockTakes.patch('/:id/lines', patchStockTakeLinesHandler);

/* Owner 2026-10-06: "上面没有写名字，而且我也不能 save、不能 edit" — who counted
   is often known only after the count, so the list stays editable until the
   take is posted. Warehouse / scope / date are NOT editable: they decide which
   lines the snapshot holds. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client / Hono context without generated types; same as every handler in this file
export const patchStockTakeHeaderHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const { data: prev, error: prevErr } = await scopeToCompanyId(
    sb.from('stock_takes').select('status, take_no, company_id, notes, assignee_staff_id, assignee_staff_ids').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (prevErr) return c.json({ error: 'load_failed', reason: prevErr.message }, 500);
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);
  const head = prev as {
    status: string; take_no: string; company_id: number | null; notes: string | null;
    assignee_staff_id: string | null; assignee_staff_ids: string[] | null;
  };
  if (head.status !== 'OPEN') return c.json({ error: 'not_open', message: 'Only an OPEN stock take can be edited.' }, 409);

  const patch: Record<string, unknown> = {};
  const changes: Array<FieldChange | null> = [];
  if ('assigneeStaffIds' in body) {
    const a = await readAssignees(sb, body);
    if (!a.ok) return c.json(a.body, 400);
    patch.assignee_staff_ids = a.ids;
    patch.assignee_staff_id = a.ids[0];
    changes.push(fieldChange('assignees', assigneesOf(head).join(', '), a.ids.join(', ')));
  }
  if ('notes' in body) {
    const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
    patch.notes = notes;
    changes.push(fieldChange('notes', head.notes, notes));
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing_to_update' }, 400);

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'UPDATE', companyId: head.company_id });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data, error } = await scopeToCompanyId(
    sb.from('stock_takes').update(patch).eq('id', id), co.companyId,
  ).eq('status', 'OPEN').select(HEADER).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'OPEN'); return c.json(r.body, r.status); }

  const changed = compactChanges(changes);
  if (changed.length > 0) {
    await recordEntityAudit(sb, {
      entityType: 'STOCK_TAKE', entityId: id, entityDocNo: head.take_no, action: 'UPDATE',
      actor: c.get('houzsUser'), companyId: head.company_id, statusSnapshot: 'OPEN',
      note: 'Header edited', fieldChanges: changed,
    });
  }
  return c.json({ take: data });
};
stockTakes.patch('/:id', patchStockTakeHeaderHandler);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client / Hono context without generated types; same as every handler in this file
export const stockTakeBucketOptionsHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const itemCode = (c.req.query('itemCode') ?? '').trim();
  if (!itemCode) return c.json({ error: 'item_code_required' }, 400);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: head, error: headErr } = await scopeToCompanyId(
    sb.from('stock_takes').select('warehouse_id').eq('id', id), co.companyId,
  ).maybeSingle();
  if (headErr) return c.json({ error: 'load_failed', reason: headErr.message }, 500);
  if (!head) return c.json(NOT_THIS_COMPANY, 404);
  const warehouseId = (head as { warehouse_id: string }).warehouse_id;

  const { data: bal, error } = await paginateAll((pFrom, pTo) => scopeToCompany(
    sb.from('inventory_balances').select('warehouse_id, variant_key, qty').eq('item_code', itemCode),
    c,
  ).range(pFrom, pTo));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const here = new Map<string, number>();
  const known = new Set<string>();
  for (const b of (bal as Array<{ warehouse_id: string; variant_key: string | null; qty: number | null }> | null) ?? []) {
    const vk = b.variant_key ?? '';
    known.add(vk);
    if (b.warehouse_id === warehouseId) here.set(vk, (here.get(vk) ?? 0) + Number(b.qty ?? 0));
  }
  const options = [...known]
    .map((vk) => ({ variantKey: vk, variantLabel: labelFromVariantKey(vk), qtyHere: here.get(vk) ?? 0 }))
    .sort((a, b) => a.variantKey.localeCompare(b.variantKey));
  return c.json({ options });
};
stockTakes.get('/:id/bucket-options', stockTakeBucketOptionsHandler);

/* Owner 2026-10-06: stock the system does not list but the shelf holds. The
   line's system_qty is the LIVE on-hand of that bucket here (usually 0), so the
   variance is exactly what was found; the post re-reads live on-hand anyway. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client / Hono context without generated types; same as every handler in this file
export const addStockTakeLineHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const itemCode = typeof body.itemCode === 'string' ? body.itemCode.trim() : '';
  if (!itemCode) return c.json({ error: 'item_code_required', message: 'Pick a SKU.' }, 400);
  const variantKey = typeof body.variantKey === 'string' ? body.variantKey : '';
  const countedRaw = Number(body.countedQty);
  if (!Number.isFinite(countedRaw) || countedRaw < 0) {
    return c.json({ error: 'counted_qty_invalid', message: 'Enter the counted quantity (0 or more).' }, 400);
  }
  const countedQty = Math.floor(countedRaw);

  const { data: prev, error: prevErr } = await scopeToCompanyId(
    sb.from('stock_takes').select('status, take_no, company_id, warehouse_id').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (prevErr) return c.json({ error: 'load_failed', reason: prevErr.message }, 500);
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);
  const head = prev as { status: string; take_no: string; company_id: number | null; warehouse_id: string };
  if (head.status !== 'OPEN') return c.json({ error: 'not_open' }, 409);

  const { data: product, error: pErr } = await sb.from('mfg_products')
    .select('code, name, category').eq('code', itemCode).eq('company_id', co.companyId).maybeSingle();
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  if (!product) return c.json({ error: 'unknown_sku', message: `${itemCode} is not a product of this company.` }, 404);
  const prod = product as { code: string; name: string | null; category: string | null };
  const cat = (prod.category ?? '').trim().toLowerCase();
  if (!variantKey && (cat === 'sofa' || cat === 'bedframe')) {
    return c.json({
      error: 'variant_required',
      message: `${itemCode} is a ${cat}: pick its variant (fabric / size). A variant the system has never held goes through Stock Adjustment.`,
    }, 400);
  }

  const { data: dup, error: dupErr } = await scopeToCompanyId(sb.from('stock_take_lines').select('id')
    .eq('stock_take_id', id).eq('item_code', itemCode).eq('variant_key', variantKey), co.companyId).maybeSingle();
  if (dupErr) return c.json({ error: 'load_failed', reason: dupErr.message }, 500);
  if (dup) {
    return c.json({ error: 'line_exists', lineId: (dup as { id: string }).id, message: 'This SKU / variant is already on the sheet — type the count on its line.' }, 409);
  }

  const { data: bal, error: bErr } = await scopeToCompany(
    sb.from('inventory_balances').select('qty')
      .eq('warehouse_id', head.warehouse_id).eq('item_code', itemCode).eq('variant_key', variantKey),
    c,
  );
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  const systemQty = ((bal as Array<{ qty: number | null }> | null) ?? []).reduce((sum, b) => sum + Number(b.qty ?? 0), 0);

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'UPDATE', companyId: head.company_id });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const counterStaffId = await callerStaffIdOf(sb, c);
  const { data: inserted, error: iErr } = await sb.from('stock_take_lines').insert(stampCompany([{
    stock_take_id:  id,
    item_code:      itemCode,
    product_name:   prod.name,
    variant_key:    variantKey,
    variant_label:  labelFromVariantKey(variantKey),
    system_qty:     systemQty,
    counted_qty:    countedQty,
    counted_by:     counterStaffId,
    counted_at:     new Date().toISOString(),
    added_on_count: true,
  }], c)).select(LINE).single();
  if (iErr) return c.json({ error: 'insert_failed', reason: iErr.message }, 500);

  await recordEntityAudit(sb, {
    entityType: 'STOCK_TAKE', entityId: id, entityDocNo: head.take_no, action: 'UPDATE',
    actor: c.get('houzsUser'), companyId: head.company_id, statusSnapshot: 'OPEN',
    note: 'Line added during the count',
    fieldChanges: compactChanges([fieldChange(itemCode, null, countedQty)]),
  });
  return c.json({ line: inserted }, 201);
};
stockTakes.post('/:id/lines', addStockTakeLineHandler);

/* HC-0140: any line can be removed while OPEN (Sim asked for a delete on
   every line, sheet lines too). A deleted line writes no adjustment at Post,
   same as a blank one; the audit row keeps what the sheet expected. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client / Hono context without generated types; same as every handler in this file
export const deleteStockTakeLineHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: prev, error: prevErr } = await scopeToCompanyId(
    sb.from('stock_takes').select('status, take_no, company_id').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (prevErr) return c.json({ error: 'load_failed', reason: prevErr.message }, 500);
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);
  const head = prev as { status: string; take_no: string; company_id: number | null };
  if (head.status !== 'OPEN') return c.json({ error: 'not_open' }, 409);

  const { data: ln, error: lnErr } = await scopeToCompanyId(
    sb.from('stock_take_lines').select('id, item_code, system_qty, counted_qty, added_on_count')
      .eq('id', lineId).eq('stock_take_id', id),
    co.companyId,
  ).maybeSingle();
  if (lnErr) return c.json({ error: 'load_failed', reason: lnErr.message }, 500);
  if (!ln) return c.json({ error: 'line_not_found' }, 404);
  const line = ln as { id: string; item_code: string; system_qty: number | null; counted_qty: number | null; added_on_count: boolean | null };

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'UPDATE', companyId: head.company_id });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { error: dErr } = await scopeToCompanyId(
    sb.from('stock_take_lines').delete().eq('id', lineId).eq('stock_take_id', id),
    co.companyId,
  );
  if (dErr) return c.json({ error: 'delete_failed', reason: dErr.message }, 500);

  await recordEntityAudit(sb, {
    entityType: 'STOCK_TAKE', entityId: id, entityDocNo: head.take_no, action: 'UPDATE',
    actor: c.get('houzsUser'), companyId: head.company_id, statusSnapshot: 'OPEN',
    note: line.added_on_count === true ? 'Added line deleted' : `Sheet line deleted (system qty ${line.system_qty ?? 0})`,
    fieldChanges: compactChanges([fieldChange(line.item_code, line.counted_qty, null)]),
  });
  return c.json({ ok: true });
};
stockTakes.delete('/:id/lines/:lineId', deleteStockTakeLineHandler);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client / Hono context without generated types; same as every handler in this file
export const stockTakeRacksHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: head, error: headErr } = await scopeToCompanyId(
    sb.from('stock_takes').select('warehouse_id').eq('id', id), co.companyId,
  ).maybeSingle();
  if (headErr) return c.json({ error: 'load_failed', reason: headErr.message }, 500);
  if (!head) return c.json(NOT_THIS_COMPANY, 404);
  const { data, error } = await scopeToCompanyId(
    sb.from('warehouse_racks').select('id, rack, zone')
      .eq('warehouse_id', (head as { warehouse_id: string }).warehouse_id).order('rack'),
    co.companyId,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ racks: data ?? [] });
};
stockTakes.get('/:id/racks', stockTakeRacksHandler);

stockTakes.post('/:id/read-sheet', readStockTakeSheetHandler);

stockTakes.patch('/:id/cancel', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'CANCEL', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data, error } = await scopeToCompanyId(sb.from('stock_takes')
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
    .eq('id', id), co.companyId).eq('status', 'OPEN')
    .select('id, status, cancelled_at, take_no, company_id').maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data)  { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'OPEN'); return c.json(r.body, r.status); }

  const cancelledTake = data as unknown as { take_no: string; company_id: number | null };
  await recordEntityAudit(sb, {
    entityType: 'STOCK_TAKE',
    entityId: id,
    entityDocNo: cancelledTake.take_no,
    action: 'CANCEL',
    actor: c.get('houzsUser'),
    companyId: cancelledTake.company_id,
    statusSnapshot: 'CANCELLED',
    fieldChanges: statusChange('OPEN', 'CANCELLED'),
  });

  return c.json({ take: data });
});

// ── Reopen CANCELLED → OPEN (fresh snapshot) ──────────────────────────
// A cancelled take is otherwise terminal (see /reverse — "to count again, start
// a new take"). Reopen (owner 2026-11-23) brings one back to OPEN to count again
// WITHOUT a new document, and RE-SNAPSHOTS every line's system_qty from current
// stock over the take's own scope — so the sheet is never counted against a
// stale, create-time balance (which is why a plain un-cancel would be worse than
// a new take). The previous counts are dropped: a reopen is a fresh count. Works
// from either cancel path (OPEN→CANCELLED, or a reversed POSTED→CANCELLED whose
// stock the reverse already put back).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client / Hono context without generated types; same as every handler in this file
export const reopenStockTakeHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: prev, error: prevErr } = await scopeToCompanyId(
    sb.from('stock_takes')
      .select('status, take_no, company_id, warehouse_id, scope_type, scope_value, nonzero_only')
      .eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (prevErr) return c.json({ error: 'load_failed', reason: prevErr.message }, 500);
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);
  const head = prev as {
    status: string; take_no: string; company_id: number | null; warehouse_id: string;
    scope_type: string; scope_value: string | null; nonzero_only: boolean | null;
  };
  if (head.status !== 'CANCELLED') {
    return c.json({ error: 'not_cancelled', message: 'Only a cancelled stock take can be reopened.' }, 409);
  }

  const whCheck = await assertWarehouseInCompany(sb, head.warehouse_id, co.companyId);
  if (!whCheck.ok) return c.json(whCheck.body, whCheck.status);

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'UPDATE', companyId: head.company_id });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const scoped = await fetchScopedSkus(
    sb, head.warehouse_id,
    head.scope_type as 'ALL' | 'CATEGORY' | 'CODE_PREFIX' | 'NONZERO',
    head.scope_value, head.nonzero_only === true, c,
  );
  if (scoped.error) return c.json({ error: 'scope_load_failed', reason: scoped.error }, 500);
  if (scoped.rows.length === 0) {
    return c.json({ error: 'scope_empty', reason: 'No SKUs match the scope now; nothing to reopen onto.' }, 400);
  }

  const { data: flipped, error: fErr } = await scopeToCompanyId(sb.from('stock_takes')
    .update({ status: 'OPEN', cancelled_at: null, posted_at: null })
    .eq('id', id), co.companyId).eq('status', 'CANCELLED')
    .select('id, take_no, company_id').maybeSingle();
  if (fErr) return c.json({ error: 'reopen_failed', reason: fErr.message }, 500);
  if (!flipped) return c.json({ error: 'not_cancelled', message: 'Only a cancelled stock take can be reopened.' }, 409);

  const { error: delErr } = await sb.from('stock_take_lines').delete().eq('stock_take_id', id);
  if (delErr) {
    await scopeToCompanyId(sb.from('stock_takes').update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() }).eq('id', id), co.companyId);
    return c.json({ error: 'reopen_lines_failed', reason: delErr.message }, 500);
  }
  const lineRows = scoped.rows.map((r) => ({
    stock_take_id: id,
    item_code:  r.item_code,
    product_name:  r.product_name,
    variant_key:   r.variant_key,
    variant_label: r.variant_label,
    system_qty:    r.qty,
    counted_qty:   null,
  }));
  const { error: insErr } = await sb.from('stock_take_lines').insert(stampCompany(lineRows, c));
  if (insErr) {
    await scopeToCompanyId(sb.from('stock_takes').update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() }).eq('id', id), co.companyId);
    return c.json({ error: 'reopen_lines_failed', reason: insErr.message }, 500);
  }

  const reopened = flipped as unknown as { take_no: string; company_id: number | null };
  await recordEntityAudit(sb, {
    entityType: 'STOCK_TAKE', entityId: id, entityDocNo: reopened.take_no, action: 'UPDATE',
    actor: c.get('houzsUser'), companyId: reopened.company_id, statusSnapshot: 'OPEN',
    note: `Reopened — ${lineRows.length} line(s) re-snapshotted to current stock`,
    fieldChanges: statusChange('CANCELLED', 'OPEN'),
  });

  return c.json({ take: flipped, lineCount: lineRows.length });
};
stockTakes.patch('/:id/reopen', reopenStockTakeHandler);

stockTakes.patch('/:id/reverse', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  const id = c.req.param('id');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'REVERSE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data: cancelled, error: cErr } = await scopeToCompanyId(sb.from('stock_takes')
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
    .eq('id', id), co.companyId).eq('status', 'POSTED')
    .select(HEADER).maybeSingle();
  if (cErr)       return c.json({ error: 'reverse_failed', reason: cErr.message }, 500);
  if (!cancelled) { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'POSTED'); return c.json(r.body, r.status); }

  const header = cancelled as unknown as {
    id: string; take_no: string; warehouse_id: string;
  };

  const reverserStaffId = (await callerStaffIdOf(sb, c)) ?? user.id;

  const { data: movs, error: mLoadErr } = await sb.from('inventory_movements')
    .select('warehouse_id, item_code, product_name, variant_key, batch_no, qty, unit_cost_sen')
    .eq('source_doc_type', 'STOCK_TAKE')
    .eq('source_doc_id', id);
  if (mLoadErr) {
    return c.json({ error: 'reverse_movements_load_failed', reason: mLoadErr.message }, 500);
  }

  const reverseRows: Array<Record<string, unknown>> = [];
  for (const m of (movs as Array<{
    warehouse_id: string; item_code: string; product_name: string | null;
    variant_key: string | null; batch_no: string | null; qty: number;
    unit_cost_sen: number | null;
  }>) ?? []) {
    if (!m.qty) continue;
    reverseRows.push({
      movement_type:   'ADJUSTMENT',
      warehouse_id:    m.warehouse_id,
      item_code:    m.item_code,
      product_name:    m.product_name,
      variant_key:     m.variant_key ?? '',
      batch_no:        m.batch_no ?? null,
      qty:             -m.qty,
      unit_cost_sen:   Number(m.unit_cost_sen ?? 0),
      source_doc_type: 'STOCK_TAKE',
      source_doc_id:   header.id,
      source_doc_no:   header.take_no,
      reason_code:     'COUNT',
      notes:           `Reversal of stock take ${header.take_no}`,
      performed_by:    reverserStaffId,
    });
  }

  const movementErrors: string[] = [];
  if (reverseRows.length > 0) {
    const { error: insErr } = await sb.from('inventory_movements').insert(stampCompany(reverseRows, c));
    if (insErr) movementErrors.push(insErr.message);
    if (!insErr) await reconcileUncostedAfterIn(sb, reverseRows, reverserStaffId);
  }

  /* Drop the mirror Stock Adjustment document (owner 2026-11-20): it recorded
     this take's variance, which is now reversed, so it must not keep standing in
     the Stock Adjustments list. It holds no movements of its own, so deleting it
     touches no stock; lines cascade on the header. Best-effort. */
  const { error: saDelErr } = await scopeToCompanyId(
    sb.from('stock_adjustments').delete().eq('source_stock_take_id', id), co.companyId,
  );
  if (saDelErr) {
    // eslint-disable-next-line no-console
    console.error('[stock-takes] mirror adjustment delete on reverse failed:', (saDelErr as { message?: unknown }).message ?? saDelErr);
  }

  await recordEntityAudit(sb, {
    entityType: 'STOCK_TAKE',
    entityId: id,
    entityDocNo: header.take_no,
    action: 'REVERSE',
    actor: c.get('houzsUser'),
    companyId: activeCompanyId(c),
    statusSnapshot: 'CANCELLED',
    note: movementErrors.length
      ? `Stock reversal FAILED — ${movementErrors.join('; ')}`
      : undefined,
    fieldChanges: compactChanges([
      ...statusChange('POSTED', 'CANCELLED'),
      fieldChange('warehouseId', null, header.warehouse_id),
      fieldChange('movementsReversed', null, movementErrors.length ? 0 : reverseRows.length),
      fieldChange('netQtyReversed', null, reverseRows.reduce((s, r) => s + Number(r.qty ?? 0), 0)),
    ]),
  });

  try {
    const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
    await recomputeAllocationAfterSave(sb, 'reverse-stock-take');
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] reverse-stock-take failed:', e); }

  return c.json({
    take: cancelled,
    movementsReversed: movementErrors.length ? 0 : reverseRows.length,
    movementErrors: movementErrors.length ? movementErrors : undefined,
  });
});

stockTakes.delete('/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  // Company scope (owner audit 2026-07-22): id-only load + delete let a
  // caller in A wipe B's OPEN stock-take by knowing the UUID.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: prev } = await scopeToCompanyId(
    sb.from('stock_takes').select('status, take_no, warehouse_id, company_id').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);
  const doomed = prev as {
    status: string; take_no: string; warehouse_id: string | null; company_id: number | null;
  };
  if (doomed.status !== 'OPEN') return c.json({ error: 'not_open' }, 409);

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'DELETE', companyId: doomed.company_id });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { error } = await scopeToCompanyId(
    sb.from('stock_takes').delete().eq('id', id),
    co.companyId,
  );
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  await recordEntityAudit(sb, {
    entityType: 'STOCK_TAKE',
    entityId: id,
    entityDocNo: doomed.take_no,
    action: 'DELETE',
    actor: c.get('houzsUser'),
    companyId: doomed.company_id,
    statusSnapshot: 'OPEN',
    fieldChanges: compactChanges([
      fieldChange('takeNo', doomed.take_no, null),
      fieldChange('warehouseId', doomed.warehouse_id, null),
      fieldChange('status', 'OPEN', null),
    ]),
  });

  return c.json({ ok: true });
});

type PostingHeader = { id: string; take_no: string; warehouse_id: string };
type PostingPlan = {
  liveByKey: Map<string, number>;
  adjustmentRows: Array<Record<string, unknown>>;
  costlessSkus: string[];
  thresholdLines: VarianceLine[];
};

const computeStockTakePosting = async (
  sb: any, c: any, header: PostingHeader, performedBy: string,
): Promise<PostingPlan> => {
  const { data: lines } = await sb.from('stock_take_lines')
    .select('item_code, product_name, variant_key, counted_qty, notes, entered_unit_cost_sen')
    .eq('stock_take_id', header.id);
  const counted = ((lines as Array<{
    item_code: string; product_name: string | null;
    variant_key: string | null; counted_qty: number | null; notes: string | null;
    entered_unit_cost_sen: number | null;
  }>) ?? []).filter((ln) => ln.counted_qty != null);

  const liveByKey = new Map<string, number>();
  const codes = [...new Set(counted.map((ln) => ln.item_code))];
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    if (chunk.length === 0) break;
    const { data: bal, error: balErr } = await scopeToCompany(
      pgrestIn(sb.from('inventory_balances')
        .select('item_code, variant_key, qty')
        .eq('warehouse_id', header.warehouse_id), 'item_code', chunk),
      c,
    );
    if (balErr) {
      // eslint-disable-next-line no-console
      console.error('[stock-takes] live balances read failed:', (balErr as { message?: unknown }).message ?? balErr);
    }
    for (const b of (bal as Array<{ item_code: string; variant_key: string | null; qty: number | null }>) ?? []) {
      liveByKey.set(`${b.item_code} ${b.variant_key ?? ''}`, Number(b.qty ?? 0));
    }
  }

  const pending = counted
    .map((ln) => {
      const variantKey = ln.variant_key ?? '';
      const live = liveByKey.get(`${ln.item_code} ${variantKey}`) ?? 0;
      return { ln, variantKey, adjustment: ln.counted_qty! - live };
    })
    .filter((p) => p.adjustment !== 0);

  const lotsByKey = new Map<string, LotCostRow[]>();
  const upCodes = [...new Set(pending.map((p) => p.ln.item_code))];
  for (let i = 0; i < upCodes.length; i += 200) {
    const chunk = upCodes.slice(i, i + 200);
    if (chunk.length === 0) break;
    const { data: lots, error: lotsErr } = await scopeToCompany(
      pgrestIn(sb.from('inventory_lots')
        .select('item_code, variant_key, unit_cost_sen, qty_remaining, source_doc_type, received_at')
        .eq('warehouse_id', header.warehouse_id), 'item_code', chunk),
      c,
    );
    if (lotsErr) {
      // eslint-disable-next-line no-console
      console.error('[stock-takes] lot cost read failed:', (lotsErr as { message?: unknown }).message ?? lotsErr);
    }
    for (const l of (lots as Array<{ item_code: string; variant_key: string | null } & LotCostRow>) ?? []) {
      const key = `${l.item_code} ${l.variant_key ?? ''}`;
      (lotsByKey.get(key) ?? lotsByKey.set(key, []).get(key)!).push(l);
    }
  }

  const adjustmentRows: Array<Record<string, unknown>> = [];
  const costlessSkus: string[] = [];
  const thresholdLines: VarianceLine[] = [];
  for (const p of pending) {
    const forced = resolveForcedUnitCostSen({
      lots: lotsByKey.get(`${p.ln.item_code} ${p.variantKey}`) ?? [],
    });
    /* Owner 2026-11-23: a +variance SKU with no priced lot can still post if the
       counter typed a unit cost on the sheet (entered_unit_cost_sen) — the same
       basis a costed Stock Adjustment uses, carried on the ADJUSTMENT movement's
       unit_cost_sen the FIFO trigger already reads. Only a positive entry
       counts, and it is a FALLBACK: a real lot cost always wins, so this never
       lets a hand-typed figure override costed stock. A 0 / NULL entry leaves
       the line costless, so it still refuses — RM0 is never booked. */
    const enteredSen = typeof p.ln.entered_unit_cost_sen === 'number' && p.ln.entered_unit_cost_sen > 0
      ? p.ln.entered_unit_cost_sen
      : null;
    const basisSen = forced.ok ? forced.unitCostSen : enteredSen;
    thresholdLines.push({
      itemCode: p.ln.item_code,
      adjustment:  p.adjustment,
      unitCostSen: basisSen,
    });
    let unitCostSen = 0;
    if (p.adjustment > 0) {
      if (basisSen == null) { costlessSkus.push(p.ln.item_code); continue; }
      unitCostSen = basisSen;
    }
    adjustmentRows.push({
      movement_type:   'ADJUSTMENT',
      warehouse_id:    header.warehouse_id,
      item_code:    p.ln.item_code,
      product_name:    p.ln.product_name,
      variant_key:     p.variantKey,
      qty:             p.adjustment,
      unit_cost_sen:   unitCostSen,
      source_doc_type: 'STOCK_TAKE',
      source_doc_id:   header.id,
      source_doc_no:   header.take_no,
      reason_code:     'COUNT',
      notes:           `Stock take variance${p.ln.notes ? ` · ${p.ln.notes}` : ''}`,
      performed_by:    performedBy,
    });
  }

  return { liveByKey, adjustmentRows, costlessSkus, thresholdLines };
};

/* Mirror Stock Adjustment (owner 2026-11-20). A posted take's variance already
   moved stock as ADJUSTMENT movements (source STOCK_TAKE). This ALSO records a
   formal Stock Adjustment DOCUMENT (SA number, scm.stock_adjustments) so the
   correction shows in the Stock Adjustments list and the take links to it
   instead of a stock card. It writes NO movements — stock moves exactly once,
   through the take — so it carries no risk to the ledger. The document is
   read-only (its edit is refused while source_stock_take_id is set, which would
   otherwise double-move) and is deleted when the take is reversed. Best-effort:
   a failure never fails the post (the movements are the truth); a backfill can
   mint a missing one later. */
const createMirrorAdjustment = async (
  sb: any, c: any, header: PostingHeader,
  adjustmentRows: ReadonlyArray<Record<string, unknown>>, performedBy: string,
): Promise<{ id: string; adjustment_no: string } | null> => {
  if (adjustmentRows.length === 0) return null;
  try {
    const prefix = `${companyDocPrefix(c)}SA-${docMonthTag(null)}`;
    const { data, error } = await insertWithDocNoRetry<{ id: string; adjustment_no: string }>(
      () => mintMonthlyDocNo(sb, 'stock_adjustments', 'adjustment_no', prefix),
      (adjustmentNo) => sb.from('stock_adjustments')
        .insert({
          adjustment_no:        adjustmentNo,
          company_id:           activeCompanyId(c),
          warehouse_id:         header.warehouse_id,
          notes:                `Auto-created from stock take ${header.take_no}`,
          created_by:           performedBy,
          source_stock_take_id: header.id,
        })
        .select('id, adjustment_no').single(),
    );
    if (error || !data) {
      // eslint-disable-next-line no-console
      console.error('[stock-takes] mirror adjustment header failed:', (error as { message?: unknown } | null)?.message ?? 'no header');
      return null;
    }
    const sa = data as unknown as { id: string; adjustment_no: string };
    const lines = adjustmentRows.map((r, i) => ({
      stock_adjustment_id: sa.id,
      line_no:       i + 1,
      item_code:     r.item_code,
      product_name:  r.product_name ?? null,
      variant_key:   r.variant_key ?? '',
      qty:           r.qty,
      unit_cost_sen: r.unit_cost_sen ?? null,
      reason_code:   'COUNT',
      notes:         `Stock take ${header.take_no}`,
    }));
    const { error: lErr } = await sb.from('stock_adjustment_lines').insert(stampCompany(lines, c));
    if (lErr) {
      await sb.from('stock_adjustments').delete().eq('id', sa.id);
      // eslint-disable-next-line no-console
      console.error('[stock-takes] mirror adjustment lines failed:', lErr.message);
      return null;
    }
    return sa;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[stock-takes] mirror adjustment failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
};

const writePostingEffects = async (
  sb: any, c: any, co: { companyId: number }, header: PostingHeader, plan: PostingPlan,
  opts: { performedBy: string; fromStatus: 'OPEN' | 'PENDING_APPROVAL'; auditAction: 'POST' | 'APPROVE' },
) => {
  const { adjustmentRows, liveByKey } = plan;
  const movementErrors: string[] = [];

  if (adjustmentRows.length > 0) {
    const { error: mErr } = await sb.from('inventory_movements').insert(stampCompany(adjustmentRows, c));
    if (mErr) movementErrors.push(mErr.message);
    if (!mErr) await reconcileUncostedAfterIn(sb, adjustmentRows, opts.performedBy);
  }

  const mirror = movementErrors.length === 0
    ? await createMirrorAdjustment(sb, c, header, adjustmentRows, opts.performedBy)
    : null;

  await recordEntityAudit(sb, {
    entityType: 'STOCK_TAKE',
    entityId: header.id,
    entityDocNo: header.take_no,
    action: opts.auditAction,
    actor: c.get('houzsUser'),
    companyId: activeCompanyId(c),
    statusSnapshot: 'POSTED',
    note: movementErrors.length
      ? `Stock adjustment FAILED — ${movementErrors.join('; ')}`
      : `${adjustmentRows.length} SKU(s) adjusted ${opts.auditAction === 'APPROVE' ? 'on supervisor approval' : 'at posting'}`,
    fieldChanges: compactChanges([
      ...statusChange(opts.fromStatus, 'POSTED'),
      fieldChange('warehouseId', null, header.warehouse_id),
      ...adjustmentRows.map((r) => {
        const live = liveByKey.get(`${r.item_code} ${r.variant_key ?? ''}`) ?? 0;
        return fieldChange(String(r.item_code), live, live + Number(r.qty));
      }),
    ]),
  });

  /* Round 2 (owner 2026-10-06): the goods go on the racks the counter wrote.
     Placement only (the rack ledger is separate from stock), best-effort —
     reported, never a reason to undo the post. */
  const racks = await applyStockTakeRacks(sb, {
    takeId: header.id, takeNo: header.take_no, warehouseId: header.warehouse_id,
    companyId: co.companyId, performedBy: opts.performedBy,
  });

  try {
    const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
    await recomputeAllocationAfterSave(sb, 'post-stock-take');
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-stock-take failed:', e); }

  return {
    movementsWritten: movementErrors.length ? 0 : adjustmentRows.length,
    movementErrors: movementErrors.length ? movementErrors : undefined,
    racksMoved: racks.moved,
    racksSkipped: racks.skippedCodes.length ? racks.skippedCodes : undefined,
    rackError: racks.error ?? undefined,
    adjustmentId: mirror?.id,
    adjustmentNo: mirror?.adjustment_no,
  };
};

const costRequiredBody = (costlessSkus: string[]) => {
  const skus = [...new Set(costlessSkus)];
  const say = (list: string) => `No cost on record for ${list}. Give them a cost first (a costed stock adjustment or a GRN), then post again.`;
  const more = (n: number) => (n > 0 ? ` and ${n} more` : '');
  let message = say(skus.slice(0, 2).join(', ') + more(Math.max(0, skus.length - 2)));
  if (message.length >= 200) message = say(skus[0] + more(skus.length - 1));
  if (message.length >= 200) message = say(`${skus[0].slice(0, 60)}…${more(skus.length - 1)}`);
  return { error: 'cost_required', message, itemCodes: skus };
};

// ── Post OPEN → POSTED, or OPEN → PENDING_APPROVAL ────────────────────
// A variance over the threshold (shared/stock-take-threshold.ts) used to REFUSE
// a non-supervisor's post. Owner 2026-11-20: it now SUBMITS instead — the take
// goes to PENDING_APPROVAL (no stock moved) and a supervisor approves it into
// POSTED, or rejects it back to OPEN. A supervisor still posts straight through,
// and a within-limit count by anyone books immediately, exactly as before.
export const postStockTakeHandler = async (c: any) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  const id = c.req.param('id');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  /* WHO MAY POST (owner 2026-10-06): the assignees are a RECORD of who
     counted, not a gate — anyone with stock-take access may post. What a
     non-supervisor can no longer do UNILATERALLY is book a variance over the
     threshold; that now goes to a supervisor to approve (below). */
  const isSupervisor = hasHouzsPerm(c, SUPERVISE_PERM);
  const performedBy = (await callerStaffIdOf(sb, c)) ?? user.id;

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'POST', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data: head0, error: h0Err } = await scopeToCompanyId(
    sb.from('stock_takes').select(HEADER).eq('id', id), co.companyId,
  ).eq('status', 'OPEN').maybeSingle();
  if (h0Err)  return c.json({ error: 'post_failed', reason: h0Err.message }, 500);
  if (!head0) { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'OPEN'); return c.json(r.body, r.status); }
  const header = head0 as unknown as PostingHeader;

  const plan = await computeStockTakePosting(sb, c, header, performedBy);
  if (plan.costlessSkus.length > 0) return c.json(costRequiredBody(plan.costlessSkus), 422);

  if (!isSupervisor) {
    const thresholds = parseVarianceThresholds(c.env);
    const breaches = findVarianceBreaches(plan.thresholdLines, thresholds);
    if (breaches.length > 0) {
      const nowIso = new Date().toISOString();
      const { data: pend, error: subErr } = await scopeToCompanyId(sb.from('stock_takes')
        .update({ status: 'PENDING_APPROVAL', submitted_at: nowIso, submitted_by: performedBy })
        .eq('id', id), co.companyId).eq('status', 'OPEN')
        .select(HEADER).maybeSingle();
      if (subErr) return c.json({ error: 'post_failed', reason: subErr.message }, 500);
      if (!pend)  { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'OPEN'); return c.json(r.body, r.status); }
      await recordEntityAudit(sb, {
        entityType: 'STOCK_TAKE', entityId: id, entityDocNo: header.take_no,
        action: 'SUBMIT_FOR_APPROVAL', actor: c.get('houzsUser'), companyId: activeCompanyId(c),
        statusSnapshot: 'PENDING_APPROVAL',
        note: formatVarianceRefusal(breaches, thresholds),
        fieldChanges: statusChange('OPEN', 'PENDING_APPROVAL'),
      });
      return c.json({
        take: pend,
        pendingApproval: true,
        itemCodes: breaches,
        message: formatVarianceRefusal(breaches, thresholds),
      });
    }
  }

  const { data: posted, error: pErr } = await scopeToCompanyId(sb.from('stock_takes')
    .update({ status: 'POSTED', posted_at: new Date().toISOString() })
    .eq('id', id), co.companyId).eq('status', 'OPEN')
    .select(HEADER).maybeSingle();
  if (pErr)    return c.json({ error: 'post_failed', reason: pErr.message }, 500);
  if (!posted) { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'OPEN'); return c.json(r.body, r.status); }

  const effects = await writePostingEffects(sb, c, co, header, plan, {
    performedBy, fromStatus: 'OPEN', auditAction: 'POST',
  });
  return c.json({ take: posted, ...effects });
};
stockTakes.patch('/:id/post', postStockTakeHandler);

export const approveStockTakeHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!hasHouzsPerm(c, SUPERVISE_PERM)) {
    return c.json({ error: 'supervisor_required', message: 'Only a stock-take supervisor can approve this count.' }, 403);
  }
  const performedBy = (await callerStaffIdOf(sb, c)) ?? c.get('user').id;

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'APPROVE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data: head0, error: h0Err } = await scopeToCompanyId(
    sb.from('stock_takes').select(HEADER).eq('id', id), co.companyId,
  ).eq('status', 'PENDING_APPROVAL').maybeSingle();
  if (h0Err)  return c.json({ error: 'approve_failed', reason: h0Err.message }, 500);
  if (!head0) { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'PENDING_APPROVAL'); return c.json(r.body, r.status); }
  const header = head0 as unknown as PostingHeader;
  const submittedBy = (head0 as unknown as { submitted_by?: string | null }).submitted_by;
  if (submittedBy && String(submittedBy) === String(performedBy)) {
    return c.json({ error: 'own_submission', message: 'You submitted this count — another supervisor has to approve it.' }, 403);
  }

  const plan = await computeStockTakePosting(sb, c, header, performedBy);
  if (plan.costlessSkus.length > 0) return c.json(costRequiredBody(plan.costlessSkus), 422);

  const { data: posted, error: pErr } = await scopeToCompanyId(sb.from('stock_takes')
    .update({ status: 'POSTED', posted_at: new Date().toISOString() })
    .eq('id', id), co.companyId).eq('status', 'PENDING_APPROVAL')
    .select(HEADER).maybeSingle();
  if (pErr)    return c.json({ error: 'approve_failed', reason: pErr.message }, 500);
  if (!posted) { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'PENDING_APPROVAL'); return c.json(r.body, r.status); }

  const effects = await writePostingEffects(sb, c, co, header, plan, {
    performedBy, fromStatus: 'PENDING_APPROVAL', auditAction: 'APPROVE',
  });
  return c.json({ take: posted, ...effects });
};
stockTakes.patch('/:id/approve', approveStockTakeHandler);

export const rejectStockTakeHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!hasHouzsPerm(c, SUPERVISE_PERM)) {
    return c.json({ error: 'supervisor_required', message: 'Only a stock-take supervisor can return this count.' }, 403);
  }

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'REJECT', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data, error } = await scopeToCompanyId(sb.from('stock_takes')
    .update({ status: 'OPEN', submitted_at: null, submitted_by: null })
    .eq('id', id), co.companyId).eq('status', 'PENDING_APPROVAL')
    .select(HEADER).maybeSingle();
  if (error) return c.json({ error: 'reject_failed', reason: error.message }, 500);
  if (!data) { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'PENDING_APPROVAL'); return c.json(r.body, r.status); }

  const returned = data as unknown as { take_no: string };
  await recordEntityAudit(sb, {
    entityType: 'STOCK_TAKE', entityId: id, entityDocNo: returned.take_no,
    action: 'REJECT', actor: c.get('houzsUser'), companyId: activeCompanyId(c),
    statusSnapshot: 'OPEN',
    note: 'Returned for recount',
    fieldChanges: statusChange('PENDING_APPROVAL', 'OPEN'),
  });
  return c.json({ take: data });
};
stockTakes.patch('/:id/reject', rejectStockTakeHandler);
