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
//     stock-take-threshold.ts — default 5 units or RM500 per line) need the
//     supervise permission too; the refusal names the SKUs and reverts the
//     status flip exactly like the R3 cost_required path.
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
//   PATCH  /stock-takes/:id/post       — OPEN → POSTED (writes ADJUSTMENT movements)
//   PATCH  /stock-takes/:id/cancel     — OPEN → CANCELLED
//   PATCH  /stock-takes/:id/reverse    — POSTED → CANCELLED (undo: reverses the ADJUSTMENT movements)
//   DELETE /stock-takes/:id            — OPEN only
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { recordEntityAudit, compactChanges, fieldChange, statusChange, assertAuditWritable, auditUnavailableBody, type FieldChange } from '../lib/entity-audit';
import { resolveForcedUnitCostSen, type LotCostRow } from '../shared';
import {
  parseVarianceThresholds, findVarianceBreaches, formatVarianceRefusal,
  type VarianceLine,
} from '../shared/stock-take-threshold';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { resolveCallerStaffId } from '../lib/salesScope';
import { hasHouzsPerm } from '../lib/houzs-perms';

export const stockTakes = new Hono<{ Bindings: Env; Variables: Variables }>();
stockTakes.use('*', supabaseAuth);

/** The supervisor key (services/permissions.ts). Owner + IT Admin pass via "*". */
const SUPERVISE_PERM = 'scm.stock_take.supervise';

const HEADER =
  'id, take_no, status, warehouse_id, scope_type, scope_value, take_date, ' +
  'notes, posted_at, cancelled_at, created_at, created_by, assignee_staff_id, blind';
const LINE =
  'id, stock_take_id, product_code, product_name, variant_key, variant_label, ' +
  'system_qty, counted_qty, variance, notes, created_at, counted_by, counted_at';

const VALID_STATUS = new Set(['OPEN', 'POSTED', 'CANCELLED']);
const VALID_SCOPE  = new Set(['ALL', 'CATEGORY', 'CODE_PREFIX', 'NONZERO']);

/* The caller's REAL scm.staff uuid (mig-0066 bridge), or null when the bridge
   has no row for them. NEVER c.get('user').id — inside /api/scm/* that is the
   pinned system staff row for every caller (see scm/middleware/auth.ts), which
   is exactly how stock movements came to read "Performed by: Unknown user"
   (the roster scopes the system row out, so its uuid resolves to nobody). */
const callerStaffIdOf = async (sb: any, c: any): Promise<string | null> => {
  try {
    return await resolveCallerStaffId(sb, c.get('houzsUser')?.id ?? null);
  } catch {
    return null;
  }
};

/* Runs ONLY on the zero-rows path of a scoped conditional flip, so it cannot
   disturb the happy path or the flip's single-flight role. It separates the two
   reasons that flip can match nothing — the take is not in the expected status
   (409, unchanged) versus it is not this company's at all (404). Without it the
   cross-company refusal would masquerade as a state error. */
async function notOpenOrNotOurs(
  sb: any, id: string, companyId: number, expected: string,
): Promise<{ body: Record<string, unknown>; status: 404 | 409 }> {
  const { data } = await scopeToCompanyId(
    sb.from('stock_takes').select('id').eq('id', id), companyId,
  ).maybeSingle();
  if (!data) return { body: NOT_THIS_COMPANY, status: 404 };
  return { body: { error: expected === 'OPEN' ? 'not_open' : 'not_posted' }, status: 409 };
}

const nextTakeNo = async (sb: any, c: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'stock_takes', 'take_no', `${p}STK-${yymm}`);
};

// ── Resolve in-scope SKUs PER (product_code, variant_key) + current on-hand ──
// Migration 0183 (#15): the count sheet is variant-grained. Scope (ALL /
// CATEGORY / CODE_PREFIX) is resolved against v_inventory_all_skus (which carries
// category + every SKU incl. zero-stock); the per-variant on-hand comes from
// inventory_balances. An attributed SKU (sofa/bedframe/mattress) yields one line
// per real variant bucket; a plain SKU yields a single '' line; a SKU that has
// never moved yields one '' line at qty 0 so it still appears to be counted.
type ScopedSku = {
  product_code: string; product_name: string | null;
  variant_key: string; variant_label: string | null; qty: number;
};

// Humanise a variant_key ("fabriccode=bf-16|gap=16|legheight=2") for display.
const labelFromVariantKey = (vk: string): string | null => {
  if (!vk) return null;
  return vk.split('|').map((p) => p.replace('=', ' ')).join(' · ');
};

const fetchScopedSkus = async (
  sb: any,
  warehouseId: string,
  scopeType: 'ALL' | 'CATEGORY' | 'CODE_PREFIX' | 'NONZERO',
  scopeValue: string | null,
  c: any,
): Promise<{ rows: ScopedSku[]; error?: string }> => {
  // 1) Scope → the set of product_codes (+ names) at this warehouse.
  // NOTE: v_inventory_all_skus intentionally aggregates across companies and has
  // NO company_id column (see inventory.ts) — product codes are per-company, and
  // the balances read below is company-scoped, so the snapshot stays isolated.
  let q = sb.from('v_inventory_all_skus')
    .select('product_code, product_name, category')
    .eq('warehouse_id', warehouseId);
  if (scopeType === 'CATEGORY' && scopeValue) {
    q = q.eq('category', scopeValue);
  } else if (scopeType === 'CODE_PREFIX' && scopeValue) {
    q = q.ilike('product_code', `${scopeValue}%`);
  }
  const { data: skuData, error: skuErr } = await q.order('product_code');
  if (skuErr) return { rows: [], error: skuErr.message };
  const skus = ((skuData as Array<{ product_code: string; product_name: string | null }>) ?? []);
  if (skus.length === 0) return { rows: [] };
  const nameByCode = new Map(skus.map((s) => [s.product_code, s.product_name] as const));
  const codes = [...nameByCode.keys()];

  // 2) Per-variant on-hand for those codes at this warehouse (chunk the .in()).
  const balByCode = new Map<string, Array<{ variant_key: string; product_name: string | null; qty: number }>>();
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    const { data: balData, error: balErr } = await scopeToCompany(
      sb.from('inventory_balances')
        .select('product_code, variant_key, product_name, qty')
        .eq('warehouse_id', warehouseId)
        .in('product_code', chunk),
      c,
    );
    if (balErr) return { rows: [], error: balErr.message };
    for (const b of (balData as Array<{
      product_code: string; variant_key: string | null; product_name: string | null; qty: number | null;
    }>) ?? []) {
      const list = balByCode.get(b.product_code) ?? [];
      list.push({ variant_key: b.variant_key ?? '', product_name: b.product_name, qty: Number(b.qty ?? 0) });
      balByCode.set(b.product_code, list);
    }
  }

  // 3) One line per (code, variant). No balance row at all → a single '' line @0.
  //    NONZERO scope (phase 1): only buckets whose system qty is actually ≠ 0
  //    make the sheet — no synthetic zero lines, no zero buckets. This is what
  //    shrinks a 344-line full-warehouse sheet to the handful that hold stock.
  const rows: ScopedSku[] = [];
  for (const code of codes) {
    const name = nameByCode.get(code) ?? null;
    const buckets = balByCode.get(code);
    if (buckets && buckets.length > 0) {
      for (const b of buckets) {
        if (scopeType === 'NONZERO' && b.qty === 0) continue;
        rows.push({
          product_code: code,
          product_name: b.product_name ?? name,
          variant_key: b.variant_key,
          variant_label: labelFromVariantKey(b.variant_key),
          qty: b.qty,
        });
      }
    } else if (scopeType !== 'NONZERO') {
      rows.push({ product_code: code, product_name: name, variant_key: '', variant_label: null, qty: 0 });
    }
  }
  rows.sort((a, b) =>
    a.product_code.localeCompare(b.product_code) || a.variant_key.localeCompare(b.variant_key));
  return { rows };
};

// ── List ──────────────────────────────────────────────────────────────
stockTakes.get('/', async (c) => {
  const sb = c.get('supabase');
  const status      = c.req.query('status');
  const warehouseId = c.req.query('warehouseId');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');

  // Page through so PostgREST's default 1000-row cap can't silently truncate
  // the stock-take list (filters below only narrow the set).
  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb.from('stock_takes')
      .select(`${HEADER}, warehouse:warehouses(id, code, name)`)
      .order('take_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (status && VALID_STATUS.has(status)) q = q.eq('status', status);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    if (dateFrom)    q = q.gte('take_date', dateFrom);
    if (dateTo)      q = q.lte('take_date', dateTo);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  // line_count + variance_total — cheap follow-up sum at pilot scale.
  const rows = (data as unknown as Array<Record<string, unknown>>) ?? [];
  const ids  = rows.map((r) => r.id as string);
  const countByTake    = new Map<string, number>();
  const varianceByTake = new Map<string, number>();
  if (ids.length > 0) {
    // chunkIn — a full-warehouse stock-take has one line per SKU, so lines
    // across the listed takes can exceed the 1000-row cap (and ids can exceed
    // 1000 too); batch + page so line_count + variance_total aren't understated.
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
      // Only count variance from lines that were actually counted.
      if (l.counted_qty != null && l.variance != null) {
        varianceByTake.set(
          l.stock_take_id,
          (varianceByTake.get(l.stock_take_id) ?? 0) + Number(l.variance),
        );
      }
    }
  }

  /* BLIND takes (phase 1): variance_total = counted − system, so exposing it
     while a blind take is still OPEN would hand the counter the very number
     the blind flag hides. Stripped HERE (server-side) for non-supervisors —
     the standing owner rule is one shared logic layer, so the decision must
     not be a frontend column toggle. */
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

// ── Detail ────────────────────────────────────────────────────────────
/* Exported for the vitest harness (precedent: postStockTakeHandler below —
   the supabaseAuth bridge cannot run there, so tests mount the handler on a
   bare Hono app with a fake PostgREST client). */
export const getStockTakeDetailHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');

  const [headerRes, linesRes] = await Promise.all([
    scopeToCompany(sb.from('stock_takes')
      .select(`${HEADER}, warehouse:warehouses(id, code, name)`)
      .eq('id', id), c).maybeSingle(),
    sb.from('stock_take_lines').select(LINE).eq('stock_take_id', id).order('product_code'),
  ]);

  if (headerRes.error) return c.json({ error: 'load_failed', reason: headerRes.error.message }, 500);
  if (!headerRes.data) return c.json({ error: 'not_found' }, 404);

  const take = headerRes.data as unknown as {
    status: string; blind: boolean | null; assignee_staff_id: string | null;
  };

  /* Viewer facts, decided ONCE here so desktop (and any later mobile surface)
     consume identical booleans instead of re-deriving permissions client-side
     — the divergence the capabilities idiom exists to prevent. */
  const canSupervise = hasHouzsPerm(c, SUPERVISE_PERM);
  const callerStaffId = await callerStaffIdOf(sb, c);
  const blindActive = take.blind === true && take.status === 'OPEN' && !canSupervise;

  /* BLIND: strip system_qty AND variance from the wire, not just the UI. The
     stored variance column equals counted − system, so leaving either field in
     the payload would un-blind the count via devtools. Post-POSTED (or
     CANCELLED) reads reveal everything — the count is settled. */
  const rawLines = (linesRes.data ?? []) as Array<Record<string, unknown>>;
  const lines = blindActive
    ? rawLines.map((l) => ({ ...l, system_qty: null, variance: null }))
    : rawLines;

  return c.json({
    take: headerRes.data,
    lines,
    viewer: {
      isAssignee: callerStaffId != null && callerStaffId === take.assignee_staff_id,
      canSupervise,
      blindActive,
    },
  });
};
stockTakes.get('/:id', getStockTakeDetailHandler);

// ── Create OPEN + snapshot scope ──────────────────────────────────────
// body: { warehouseId, assigneeStaffId, takeDate?, scopeType, scopeValue?,
//         notes?, blind? }
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

  /* Phase 1: a take has a PERSON RESPONSIBLE from the moment it exists.
     Required — an unowned count sheet is exactly the accountability gap this
     phase closes. Validated against scm.staff so a typo'd uuid answers 400
     here rather than an FK 500 at insert. */
  const assigneeRaw = (body.assigneeStaffId as string | undefined) ?? '';
  const assigneeStaffId = assigneeRaw.trim();
  if (!assigneeStaffId) {
    return c.json({
      error: 'assignee_required',
      message: 'Pick an assignee — the person responsible for this count.',
    }, 400);
  }
  const { data: assigneeRow } = await sb.from('staff')
    .select('id').eq('id', assigneeStaffId).maybeSingle();
  if (!assigneeRow) {
    return c.json({
      error: 'invalid_assignee',
      message: 'That assignee does not exist. Pick a person from the staff list.',
    }, 400);
  }

  const scopeType = (body.scopeType as string | undefined) ?? 'ALL';
  if (!VALID_SCOPE.has(scopeType)) return c.json({ error: 'invalid_scope_type' }, 400);

  const scopeValueRaw = (body.scopeValue as string | undefined) ?? null;
  const scopeValue = scopeValueRaw && scopeValueRaw.trim() ? scopeValueRaw.trim() : null;
  if ((scopeType === 'CATEGORY' || scopeType === 'CODE_PREFIX') && !scopeValue) {
    return c.json({ error: 'scope_value_required_for_this_scope_type' }, 400);
  }

  // 1) Snapshot SKUs in scope.
  const scoped = await fetchScopedSkus(
    sb, warehouseId,
    scopeType as 'ALL' | 'CATEGORY' | 'CODE_PREFIX' | 'NONZERO',
    scopeValue,
    c,
  );
  if (scoped.error) return c.json({ error: 'scope_load_failed', reason: scoped.error }, 500);
  if (scoped.rows.length === 0) {
    return c.json({ error: 'scope_empty', reason: 'No SKUs match the chosen scope.' }, 400);
  }

  const headerInsert: Record<string, unknown> = {
    company_id:   activeCompanyId(c), // multi-company: stamp the active company
    status:       'OPEN',
    warehouse_id: warehouseId,
    scope_type:   scopeType,
    scope_value:  scopeValue,
    notes:        (body.notes as string | undefined) ?? null,
    created_by:   user.id,
    assignee_staff_id: assigneeStaffId,
    /* Strict === true: only an explicit request counts blind. */
    blind:        body.blind === true,
  };
  if (body.takeDate) headerInsert.take_date = body.takeDate;

  const { data: headerData, error: hErr } = await insertWithDocNoRetry<{ id: string; take_no: string }>(
    () => nextTakeNo(sb, c),
    (takeNo) => sb
      .from('stock_takes').insert({ take_no: takeNo, ...headerInsert }).select(HEADER).single(),
  );
  if (hErr) {
    /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
       Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
       0061 enabled RLS on every scm table with NO policies, and the SCM client is
       the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
       getSupabaseService), which bypasses RLS by design. No scm function RAISEs
       42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
       permission check and do NOT treat it as scoping: the only boundary is this
       route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
    if (hErr.code === '42501') return c.json({ error: 'forbidden', reason: hErr.message }, 403);
    return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  }
  const header = headerData as unknown as { id: string; take_no: string };

  // 2) Bulk-insert lines with system_qty filled + counted_qty NULL.
  const lineRows = scoped.rows.map((r) => ({
    stock_take_id: header.id,
    product_code:  r.product_code,
    product_name:  r.product_name,
    variant_key:   r.variant_key,
    variant_label: r.variant_label,
    system_qty:    r.qty,
    counted_qty:   null,
  }));
  const { error: lErr } = await sb.from('stock_take_lines').insert(stampCompany(lineRows, c));
  if (lErr) {
    // Best-effort rollback so we don't leak a no-lines header.
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

// ── Update counted_qty per line (bulk) ────────────────────────────────
// body: { lines: [{ id, countedQty (number | null), notes? }] }
/* Exported for the vitest harness (see getStockTakeDetailHandler's note). */
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
    sb.from('stock_takes').select('status, take_no, company_id').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);
  const head = prev as { status: string; take_no: string; company_id: number | null };
  if (head.status !== 'OPEN') return c.json({ error: 'not_open' }, 409);

  const lines = body.lines as Array<{
    id: string; countedQty?: number | null; notes?: string | null;
  }> | undefined;
  if (!Array.isArray(lines) || lines.length === 0) {
    return c.json({ error: 'lines_required' }, 400);
  }

  /* AUDIT PRE-FLIGHT. recordEntityAudit runs after the counts are already
     stored, so it cannot honestly fail there; the sink is asked here instead,
     behind the cheap guards and ahead of the first update, so that the refusal
     below is literally true — nothing has been written yet. Same reasoning at
     every other pre-flight in this file. */
  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'UPDATE', companyId: head.company_id });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  /* BEFORE values for the from->to record. Batched (chunkIn bounds the .in()
     list and pages each chunk, so a 500-line take cannot lose rows to
     PostgREST's 1000-row cap) rather than a read per line — the update loop
     below is already one round-trip per line and does not need doubling. */
  const lineIds = lines.map((l) => l.id).filter((x): x is string => !!x);
  const beforeById = new Map<string, { product_code: string; counted_qty: number | null; notes: string | null }>();
  if (lineIds.length > 0) {
    const { data: beforeLines } = await chunkIn<{
      id: string; product_code: string; counted_qty: number | null; notes: string | null;
    }>(lineIds, (batch, pFrom, pTo) => sb.from('stock_take_lines')
      .select('id, product_code, counted_qty, notes')
      .eq('stock_take_id', id).in('id', batch).range(pFrom, pTo));
    for (const b of beforeLines ?? []) beforeById.set(b.id, b);
  }

  /* WHO/WHEN per counted cell (phase 1, migration 0270). Resolved ONCE per
     request — the caller's REAL staff uuid, never the pinned system row. A
     caller the mig-0066 bridge cannot resolve stamps NULL (renders "—"),
     which is honest; stamping the system row is how "Unknown user" happened. */
  const counterStaffId = await callerStaffIdOf(sb, c);

  // Issue updates one-at-a-time (Supabase JS lacks a true bulk upsert by
  // PK). Pilot scale (<500 lines per take) — fine. If volumes grow we can
  // switch to a single RPC.
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
      /* A cleared count clears its attribution too — "nobody has counted this
         cell" must not keep naming the person whose entry was erased. */
      patch.counted_by = patch.counted_qty == null ? null : counterStaffId;
      patch.counted_at = patch.counted_qty == null ? null : new Date().toISOString();
    }
    if ('notes' in l) patch.notes = l.notes ?? null;
    if (Object.keys(patch).length === 0) continue;

    const { error } = await sb.from('stock_take_lines')
      .update(patch).eq('id', l.id).eq('stock_take_id', id);
    if (error) { errors.push(`${l.id}: ${error.message}`); continue; }

    /* Keyed by PRODUCT CODE, not the line uuid — the History drawer's reader is
       a stock controller asking "who changed the count on this SKU", and a uuid
       cannot answer that. Only lines whose stored update SUCCEEDED reach here. */
    const b = beforeById.get(l.id);
    if ('counted_qty' in patch) {
      countChanges.push(fieldChange(b?.product_code ?? l.id, b?.counted_qty ?? null, patch.counted_qty));
    }
  }

  if (errors.length > 0) {
    return c.json({ error: 'partial_update_failed', errors }, 500);
  }

  const changed = compactChanges(countChanges);
  /* A PATCH that moved no count writes no row. The endpoint is called on every
     keystroke-blur in the counting UI, so logging no-ops would bury the real
     edits in an unreadable history. */
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

// ── Cancel OPEN ───────────────────────────────────────────────────────
stockTakes.patch('/:id/cancel', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');

  /* The flip below is this handler's first statement that touches anything, and
     it is also its not-found / wrong-state check, so the probe sits directly in
     front of it rather than behind a guard. The flip keeps its single-flight
     role untouched. */
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

  /* The .eq('status','OPEN') gate means only the call that actually flipped it
     gets a row back, so this records once. The prior status is OPEN by
     construction — that is what the gate asserts. */
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

// ── Reverse POSTED → CANCELLED (undo a posted count) ──────────────────
// Every other inventory module's cancel reverses its stock; a POSTED stock
// take previously had no such path (cancel only accepted OPEN). This writes
// the OPPOSITE signed ADJUSTMENT for every movement the post wrote, so stock
// returns to exactly its pre-post level, then marks the take CANCELLED and
// locked. To re-count, the commander starts a fresh take (same posture as a
// cancelled DO/GRN/PR — the document is terminal, you make a new one).
//
// Cost note: the reversing ADJUSTMENT is qty-exact. A reversing increase is
// re-valued at the variant's current weighted-average open-lot cost (the same
// basis the forward post used for found stock); a reversing decrease is FIFO-
// consumed at the real layers. For cycle-count-sized variances this is fully
// consistent with how the forward adjustment itself was costed.
//
// Idempotency: status is flipped POSTED → CANCELLED FIRST (single-flight); a
// second call sees a non-POSTED row and returns 409, so reversal rows are
// written at most once.
stockTakes.patch('/:id/reverse', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  const id = c.req.param('id');

  /* Probe before the flip: the flip is the first mutating call and doubles as
     the state check, so there is no earlier guard to sit behind. It remains the
     single-flight lock. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'REVERSE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  // Flip status first so a concurrent reverse can't double-write movements.
  const { data: cancelled, error: cErr } = await scopeToCompanyId(sb.from('stock_takes')
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
    .eq('id', id), co.companyId).eq('status', 'POSTED')
    .select(HEADER).maybeSingle();
  if (cErr)       return c.json({ error: 'reverse_failed', reason: cErr.message }, 500);
  if (!cancelled) { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'POSTED'); return c.json(r.body, r.status); }

  const header = cancelled as unknown as {
    id: string; take_no: string; warehouse_id: string;
  };

  /* Attribution fix (phase 1): the reversal rows used to stamp performed_by
     with the pinned system staff uuid (user.id), which the roster scopes out —
     rendering "Unknown user". Stamp the REAL caller; fall back to the system
     row only when the bridge has no row, so the FK stays satisfied. */
  const reverserStaffId = (await callerStaffIdOf(sb, c)) ?? user.id;

  // Load the forward ADJUSTMENT movements this take wrote. (Reversal can only
  // run once — the status gate above — so there are no prior reversal rows to
  // filter out.)
  /* unit_cost_sen is SELECTED now — it was not, so the reversal below could not
     have carried the original basis even if it wanted to. See the note on the
     reversal row. */
  const { data: movs, error: mLoadErr } = await sb.from('inventory_movements')
    .select('warehouse_id, product_code, product_name, variant_key, batch_no, qty, unit_cost_sen')
    .eq('source_doc_type', 'STOCK_TAKE')
    .eq('source_doc_id', id);
  if (mLoadErr) {
    return c.json({ error: 'reverse_movements_load_failed', reason: mLoadErr.message }, 500);
  }

  const reverseRows: Array<Record<string, unknown>> = [];
  for (const m of (movs as Array<{
    warehouse_id: string; product_code: string; product_name: string | null;
    variant_key: string | null; batch_no: string | null; qty: number;
    unit_cost_sen: number | null;
  }>) ?? []) {
    if (!m.qty) continue; // zero-variance lines wrote nothing; nothing to undo
    reverseRows.push({
      movement_type:   'ADJUSTMENT',
      warehouse_id:    m.warehouse_id,
      product_code:    m.product_code,
      product_name:    m.product_name,
      variant_key:     m.variant_key ?? '',
      batch_no:        m.batch_no ?? null,
      qty:             -m.qty,                          // flip the sign — undo
      /* CARRY THE ORIGINAL BASIS. This was `unit_cost_sen: 0`, commented
         "trigger recomputes cost" — and the trigger cannot. Its IN branch
         (`fn_inventory_movement_fifo`, migration 0195:138-150) averages OPEN
         lots only, with no last-known tier and no consignment exclusion:

             v_unit_cost := COALESCE(NULLIF(NEW.unit_cost_sen, 0), v_avg_cost, 0);

         A write-off is precisely the case that DRAINS the bucket, so on reversal
         the average query matches no rows, v_avg_cost is 0, and the units come
         back as a permanent RM0 lot. Ten units that left at RM100 return worth
         nothing: RM1,000 of COGS vanishes into phantom margin, and
         reconcileUncostedAfterIn does not repair it (it costs prior short OUTs
         from arriving lots, not the arriving lot itself).

         This handler's own POST refuses to do exactly this — it 422s
         `cost_required` rather than open a cost-less lot (:951-963), using the
         4-tier resolveForcedUnitCostSen ladder that never returns 0. The fix
         landed on POST and inventory-adjustments and never on the reverse, whose
         sibling reverseMovements DOES carry the cost
         (lib/inventory-movements.ts:559).

         Carrying the forward row's own unit_cost_sen is exact, not an estimate:
         it is the basis those units left at. `|| 0` only when the forward row
         had none, which is the pre-existing behaviour for a genuinely uncosted
         movement. */
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
    /* Undoing a NEGATIVE variance is a positive ADJUSTMENT — it re-opens a lot,
       so it is a stock IN and gets the same retro-cost as the post path. */
    if (!insErr) await reconcileUncostedAfterIn(sb, reverseRows, reverserStaffId);
  }

  /* POSTED is the prior status by construction — the .eq('status','POSTED')
     gate on the flip above is what let this call proceed. The reversed quantity
     is recorded as a signed total so the history says how much stock moved back,
     not merely that a reversal was attempted. */
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

  /* Stock changed back — re-walk SO stock allocation (mirrors the post path). */
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] reverse-stock-take failed:', e); }

  return c.json({
    take: cancelled,
    movementsReversed: movementErrors.length ? 0 : reverseRows.length,
    movementErrors: movementErrors.length ? movementErrors : undefined,
  });
});

// ── Delete OPEN ───────────────────────────────────────────────────────
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

  /* The one action whose subject no longer exists once it is recorded — the
     stock_takes row is gone, so this audit row is the ONLY remaining evidence
     that the document ever existed. Hence the snapshot of take_no and warehouse
     in field_changes rather than a bare status transition: nothing can be joined
     back to afterwards. entity_id is retained anyway so a later re-created
     document cannot silently inherit this history. */
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

// ── Post OPEN → POSTED ────────────────────────────────────────────────
// For every line where counted_qty IS NOT NULL and variance != 0, insert
// a single ADJUSTMENT movement with SIGNED qty (mirrors what POST
// /inventory/adjustments does — see apps/api/src/routes/inventory.ts).
//
// Lines with counted_qty == NULL are treated as "untouched" (commander
// never got to that SKU) and skipped — no movement, no audit trail beyond
// the line itself.
export const postStockTakeHandler = async (c: any) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  const id = c.req.param('id');

  /* Probe before the flip, for the same reason as /reverse: the flip is both
     the first write and the state check, and it stays the single-flight lock. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  /* ── ACCOUNTABILITY GATE (phase 1) — ahead of the audit pre-flight, with the
     other cheap guards. Posting turns a count sheet into stock movements, so
     it belongs to the take's ASSIGNEE or a supervisor. The load is company-
     scoped like every sibling read; a cross-company id answers the same 404
     the flip's zero-rows path would. Legacy takes (assignee NULL, pre-0270)
     keep the old any-area-access behaviour so history stays operable. */
  const { data: gateRow } = await scopeToCompanyId(
    sb.from('stock_takes').select('assignee_staff_id').eq('id', id), co.companyId,
  ).maybeSingle();
  if (!gateRow) return c.json(NOT_THIS_COMPANY, 404);
  const isSupervisor = hasHouzsPerm(c, SUPERVISE_PERM);
  const callerStaffId = await callerStaffIdOf(sb, c);
  const assignee = (gateRow as { assignee_staff_id: string | null }).assignee_staff_id ?? null;
  if (assignee != null && !isSupervisor && callerStaffId !== assignee) {
    return c.json({
      error: 'not_assignee',
      message: 'Only the assigned counter or a stock-take supervisor can post this stock take.',
    }, 403);
  }

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TAKE', entityId: id, action: 'POST', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  /* Company predicate on the FLIP itself, which is this handler's only gate —
     there is no load to scope. It matters more here than elsewhere because the
     two siblings below were ALREADY company-aware while this was not: the
     inventory_balances read is scopeToCompany'd and the movements insert is
     stampCompany'd. Posting another company's take therefore compared THEIR
     counted qty against OUR on-hand (no rows -> live 0), turning every line
     into a full-quantity phantom movement stamped to us. Scoping the flip is
     what closes that; the two siblings are deliberately left as they are. */
  const { data: posted, error: pErr } = await scopeToCompanyId(sb.from('stock_takes')
    .update({ status: 'POSTED', posted_at: new Date().toISOString() })
    .eq('id', id), co.companyId).eq('status', 'OPEN')
    .select(HEADER).maybeSingle();
  if (pErr)    return c.json({ error: 'post_failed', reason: pErr.message }, 500);
  if (!posted) { const r = await notOpenOrNotOurs(sb, id, co.companyId, 'OPEN'); return c.json(r.body, r.status); }

  const header = posted as unknown as {
    id: string; take_no: string; warehouse_id: string;
  };

  const { data: lines } = await sb.from('stock_take_lines')
    .select('product_code, product_name, variant_key, counted_qty, notes')
    .eq('stock_take_id', id);
  const counted = ((lines as Array<{
    product_code: string; product_name: string | null;
    variant_key: string | null; counted_qty: number | null; notes: string | null;
  }>) ?? []).filter((ln) => ln.counted_qty != null);

  // Audit 2026-06-20 (#15) — re-read LIVE on-hand per (product_code, variant_key)
  // at post time, NOT the frozen create-time snapshot, so:
  //   adjustment = counted − live_on_hand(code, variant)
  // drives the exact bucket the operator counted to exactly the counted qty.
  // This stamps variant_key (an attributed SKU lands in its REAL bucket, not the
  // '' bucket that corrupted on-hand/valuation) AND closes the stale-snapshot gap
  // — stock that moved during the count no longer skews the correction
  // (supersedes branch fix/stock-take-reconcile).
  const liveByKey = new Map<string, number>();
  const codes = [...new Set(counted.map((ln) => ln.product_code))];
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    if (chunk.length === 0) break;
    const { data: bal } = await scopeToCompany(
      sb.from('inventory_balances')
        .select('product_code, variant_key, qty')
        .eq('warehouse_id', header.warehouse_id)
        .in('product_code', chunk),
      c,
    );
    for (const b of (bal as Array<{ product_code: string; variant_key: string | null; qty: number | null }>) ?? []) {
      liveByKey.set(`${b.product_code} ${b.variant_key ?? ''}`, Number(b.qty ?? 0));
    }
  }

  const movementErrors: string[] = [];

  // Every line whose count differs from live on-hand, with its SIGNED variance.
  const pending = counted
    .map((ln) => {
      const variantKey = ln.variant_key ?? '';
      const live = liveByKey.get(`${ln.product_code} ${variantKey}`) ?? 0;
      return { ln, variantKey, adjustment: ln.counted_qty! - live };
    })
    .filter((p) => p.adjustment !== 0);

  // R3 write-path guard: a POSITIVE variance opens a new lot, so it MUST carry a
  // real unit cost — the FIFO trigger otherwise floors a cost-less lot to RM0 that
  // no path ever re-costs (permanent RM0 COGS when it sells). Fetch every
  // (product, variant) bucket's lots ONCE (open + consumed), scoped to company,
  // and resolve each positive line's cost from the SKU's own priced lots. A
  // negative variance is an OUT: the trigger consumes open lots FIFO and stamps
  // the OUT from THEIR cost, so its unit_cost_sen stays 0 (unused).
  //
  // Phase 1 widening: lots are fetched for EVERY pending code, not only the
  // positive ones — the variance THRESHOLD below values negative lines too
  // (best-effort, from the same priced-lot basis), and a per-line estimate
  // costs nothing extra beyond the wider .in() list. The R3 cost_required
  // refusal itself still fires ONLY for positive lines, exactly as before.
  const lotsByKey = new Map<string, LotCostRow[]>();
  const upCodes = [...new Set(pending.map((p) => p.ln.product_code))];
  for (let i = 0; i < upCodes.length; i += 200) {
    const chunk = upCodes.slice(i, i + 200);
    if (chunk.length === 0) break;
    const { data: lots } = await scopeToCompany(
      sb.from('inventory_lots')
        .select('product_code, variant_key, unit_cost_sen, qty_remaining, source_doc_type, received_at')
        .eq('warehouse_id', header.warehouse_id)
        .in('product_code', chunk),
      c,
    );
    for (const l of (lots as Array<{ product_code: string; variant_key: string | null } & LotCostRow>) ?? []) {
      const key = `${l.product_code} ${l.variant_key ?? ''}`;
      (lotsByKey.get(key) ?? lotsByKey.set(key, []).get(key)!).push(l);
    }
  }

  const adjustmentRows: Array<Record<string, unknown>> = [];
  const costlessSkus: string[] = [];
  /* Feed for the variance-threshold fold — every pending line with its
     best-known unit cost (null when no basis; the fold then judges qty only). */
  const thresholdLines: VarianceLine[] = [];
  for (const p of pending) {
    const forced = resolveForcedUnitCostSen({
      lots: lotsByKey.get(`${p.ln.product_code} ${p.variantKey}`) ?? [],
    });
    thresholdLines.push({
      productCode: p.ln.product_code,
      adjustment:  p.adjustment,
      unitCostSen: forced.ok ? forced.unitCostSen : null,
    });
    let unitCostSen = 0;
    if (p.adjustment > 0) {
      if (!forced.ok) { costlessSkus.push(p.ln.product_code); continue; }
      unitCostSen = forced.unitCostSen;
    }
    adjustmentRows.push({
      movement_type:   'ADJUSTMENT',
      warehouse_id:    header.warehouse_id,
      product_code:    p.ln.product_code,
      product_name:    p.ln.product_name,
      variant_key:     p.variantKey,                   // #15 — land in the counted bucket
      qty:             p.adjustment,                   // SIGNED — see /inventory/adjustments
      unit_cost_sen:   unitCostSen,                    // R3 — real cost on the +variance lot
      source_doc_type: 'STOCK_TAKE',
      source_doc_id:   header.id,
      source_doc_no:   header.take_no,
      reason_code:     'COUNT',                          // count correction
      notes:           `Stock take variance${p.ln.notes ? ` · ${p.ln.notes}` : ''}`,
      /* Phase 1 attribution fix: the REAL caller's staff uuid, resolved by the
         assignee gate above — never the pinned system row, which the roster
         scopes out and which therefore rendered "Performed by: Unknown user".
         Fallback keeps the FK satisfied for a bridge-less caller. */
      performed_by:    callerStaffId ?? user.id,
    });
  }

  // R3: a positive variance on a SKU with NO cost basis anywhere (first-ever
  // stock, never priced) cannot be posted at a real cost — writing it at RM0 is
  // the exact defect. Refuse the POST rather than open a permanent cost-less lot,
  // and REVERT the status flip so the take stays editable (nothing was written
  // yet). The operator seeds an initial cost (a costed adjustment or a GRN) for
  // the named SKU(s), then re-posts. Symmetric with the manual-adjustment 422.
  if (costlessSkus.length > 0) {
    const { error: revErr } = await scopeToCompanyId(
      sb.from('stock_takes').update({ status: 'OPEN', posted_at: null }).eq('id', id),
      co.companyId,
    ).eq('status', 'POSTED');
    const skus = [...new Set(costlessSkus)];
    return c.json({
      error: 'cost_required',
      message: `These items have no known cost yet, so they can't be added at RM0: ${skus.join(', ')}. Enter an initial unit cost (a costed stock adjustment or a GRN) for them, then post the count again.`,
      productCodes: skus,
      postReverted: !revErr,
    }, 422);
  }

  /* ── VARIANCE THRESHOLD GATE (phase 1). A variance big enough in units or
     ringgit needs a supervisor's signature to become stock truth. Decided by
     the pure fold in shared/stock-take-threshold.ts against LIVE variances
     (the same `pending` the movements are built from — not the stale sheet
     figure), and enforced HERE, after the flip, with the flip REVERTED on
     refusal — the identical posture to the R3 cost_required block above:
     nothing has been written, the take stays OPEN and editable, and the
     message says exactly why and who can proceed. */
  if (!isSupervisor) {
    const thresholds = parseVarianceThresholds(c.env);
    const breaches = findVarianceBreaches(thresholdLines, thresholds);
    if (breaches.length > 0) {
      const { error: revErr } = await scopeToCompanyId(
        sb.from('stock_takes').update({ status: 'OPEN', posted_at: null }).eq('id', id),
        co.companyId,
      ).eq('status', 'POSTED');
      return c.json({
        error: 'variance_supervisor_required',
        message: formatVarianceRefusal(breaches, thresholds),
        productCodes: breaches,
        postReverted: !revErr,
      }, 403);
    }
  }

  if (adjustmentRows.length > 0) {
    // One bulk insert — the FIFO trigger runs row-by-row anyway, but the
    // round-trip is single. Best-effort: failures listed, post not rolled
    // back (matches the audit-DLQ posture in writeMovements()).
    const { error: mErr } = await sb.from('inventory_movements').insert(stampCompany(adjustmentRows, c));
    if (mErr) movementErrors.push(mErr.message);
    /* Oversell retro-cost (0154) — a POSITIVE variance opens a lot, so a prior
       "ship anyway" DO that went out at RM0 in this warehouse can now be costed
       from it. Wired 2026-07-29; before that only a GRN reconciled, so stock
       found by a count never repaired the earlier shipment (COE §2). Negative
       variances are filtered out by the helper. Best-effort — never fails the
       post, and the shortfall is retried on the next IN. */
    if (!mErr) await reconcileUncostedAfterIn(sb, adjustmentRows, callerStaffId ?? user.id);
  }

  /* The variance that actually hit stock, per SKU — keyed by product code for
     the same reason the line PATCH is. This is the moment a count becomes the
     new truth, so the per-SKU adjustment is the WHAT, not a summary count. */
  await recordEntityAudit(sb, {
    entityType: 'STOCK_TAKE',
    entityId: id,
    entityDocNo: header.take_no,
    action: 'POST',
    actor: c.get('houzsUser'),
    companyId: activeCompanyId(c),
    statusSnapshot: 'POSTED',
    note: movementErrors.length
      ? `Stock adjustment FAILED — ${movementErrors.join('; ')}`
      : `${adjustmentRows.length} SKU(s) adjusted at posting`,
    fieldChanges: compactChanges([
      ...statusChange('OPEN', 'POSTED'),
      fieldChange('warehouseId', null, header.warehouse_id),
      /* from = the on-hand this post overwrote, to = the counted figure that
         replaced it. Recording the PAIR is the whole point: "12" alone does not
         say what it corrected. adjustmentRows holds only non-zero variances (the
         loop above skips the rest), so every entry here is a real movement. */
      ...adjustmentRows.map((r) => {
        const live = liveByKey.get(`${r.product_code} ${r.variant_key ?? ''}`) ?? 0;
        return fieldChange(String(r.product_code), live, live + Number(r.qty));
      }),
    ]),
  });

  /* B2C SO auto-allocation — variance changed stock, re-walk SO lines. */
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-stock-take failed:', e); }

  return c.json({
    take: posted,
    movementsWritten: movementErrors.length ? 0 : adjustmentRows.length,
    movementErrors: movementErrors.length ? movementErrors : undefined,
  });
};
stockTakes.patch('/:id/post', postStockTakeHandler);
