/* ── Server-callable core: create DRAFT GRN(s) by converting PO line items ──
   The multi-select PO->GRN conversion — supplier bucketing, doc-no minting,
   line mapping, over-receipt rollback, header-total recompute — factored out of
   createGrnsFromPoItemsHandler (routes/grns.ts) so a caller with NO Hono request
   (the OCR scan-queue consumer) can raise the SAME draft the UI raises. Mirrors
   the convertSosToPosCore / createDraftPosFromPicks split (mfg-purchase-orders):
   the HTTP route wires its real context through verbatim, and the headless entry
   below builds a synthetic one from Env.

   Lives in its own module (not grns.ts) purely to keep that already-large route
   file under its size ceiling; the private helpers it reuses (recordGrnCreate /
   resolveGrnFx / verifyGrnOverReceipt / recomputeGrnTotals) are imported back
   from grns.ts, which is a runtime-safe cycle (every use is at call time).

   DRAFT-ONLY, by construction: this never calls postGrnAndRollup, so it moves NO
   stock and rolls up NO PO received_qty. Posting stays in the HTTP handler (the
   UI create is auto-posted), where the zero-cost gate and its rollback also live
   — the CREATE audit row is written there too, AFTER the post clears, so a bucket
   the post rolls back never leaves an orphan CREATE row. Callers of this core
   record their own CREATE at the moment their draft becomes final. */
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, Variables } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { recordGrnCreate, resolveGrnFx, verifyGrnOverReceipt, recomputeGrnTotals } from '../routes/grns';
import { scopeToCompany, activeCompanyId, companyDocPrefix, stampCompany } from './companyScope';
import { isReceivablePo } from './source-document-gates';
import { isDocumentHeld } from './document-hold';
import { assertAuditWritable, auditUnavailableBody } from './entity-audit';
import { mintMonthlyDocNo } from './doc-no';
import { dateOrNull } from './date-coerce';
import { todayMyt } from './my-time';
import { normalizeAllocationMethod } from './landed-allocation';
import { assertForeignRatePostable } from './fx-guard';
import { effectiveDelivery } from '../shared';

export type GrnFromPoItemsContext = {
  req: { json(): Promise<unknown> };
  /* supabase keeps the REAL client type so the query-builder callbacks below
     infer (an `any` turns every `.map((r) => ...)` into an implicit-any). */
  get(key: 'supabase'): Variables['supabase'];
  get(key: 'user'): { id: string };
  /* Multi-company (mig 0061). Undefined pre-migration / cold-start / headless,
     so scoping + stamping no-op exactly as scopeToCompany documents. */
  get(key: 'companyId'): number | undefined;
  get(key: 'allowedCompanyIds'): number[] | undefined;
  /** STRING or undefined, never an object — see companyDocPrefix's doc-prefix scar. */
  get(key: 'companyCode'): string | undefined;
};

/* One created DRAFT GRN. `poIds` / `poNumbers` carry EVERY source PO the bucket
   received against (multi-PO -> one GRN), so the caller can enqueue the
   AutoCount PO->GR transfer naming all of them. */
export type DraftGrnFromPoItems = {
  id: string;
  grnNumber: string;
  companyId: number;
  primaryPoId: string;
  poIds: string[];
  poNumbers: string[];
  lineCount: number;
};

export type CreateDraftGrnsFromPoItemsResult =
  | { ok: true; created: DraftGrnFromPoItems[]; overReceipt: { poItemId: string; requested: number; remaining: number } | null }
  | { ok: false; status: ContentfulStatusCode; body: Record<string, unknown> };

export async function createDraftGrnsFromPoItemsCore(
  c: GrnFromPoItemsContext,
): Promise<CreateDraftGrnsFromPoItemsResult> {
  /* company-scope: the source load is scopeToCompany-filtered below, the header
     is stamped with the active company, and the only by-id write is the ROLLBACK
     of a header this core just inserted — no caller-supplied id is touched. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { picks?: Array<{ poItemId: string; qty: number }>; notes?: string; receivedDate?: string; allocationMethod?: unknown };
  try { body = (await c.req.json()) as typeof body; } catch { return { ok: false, status: 400, body: { error: 'invalid_json' } }; }
  const picks = body.picks ?? [];
  if (picks.length === 0) return { ok: false, status: 400, body: { error: 'picks_required' } };

  /* SOURCE LOAD, SCOPED — the picked PO LINES are where the caller's ids enter,
     so this read is what the conversion can see. Another company's poItemId
     resolves to NO ROW and falls out at the per-pick `item_not_found` below; the
     parent PO rides the `!inner` embed, so it cannot arrive from outside the
     company either. That is also why the firstCrossCompanyPo refusal that used
     to stand below the validation loop can no longer fire.
     THE COST: `item_not_found` rather than "belongs to 2990, switch company" —
     same trade as /:id/convert-from-so. */
  const ids = picks.map((p) => p.poItemId);
  const { data: itemsData, error: itemsErr } = await scopeToCompany(sb
    .from('purchase_order_items')
    .select(`
      id, purchase_order_id, material_kind, item_code, material_name,
      item_group, description, description2, uom, qty, received_qty,
      unit_price_sen, variants, gap_inches, divan_height_inches, divan_price_sen,
      leg_height_inches, leg_price_sen, custom_specials, line_suffix,
      special_order_price_sen, discount_sen, delivery_date,
      supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
      po:purchase_orders!inner ( id, po_number, supplier_id, status, on_hold, purchase_location_id, currency )
    `)
    .in('id', ids), c);
  if (itemsErr) return { ok: false, status: 500, body: { error: 'load_failed', reason: itemsErr.message } };

  type ItemRow = {
    id: string; purchase_order_id: string; material_kind: string; item_code: string;
    material_name: string; item_group: string | null; description: string | null;
    description2: string | null; uom: string | null;
    qty: number; received_qty: number; unit_price_sen: number;
    variants: unknown; gap_inches: number | null; divan_height_inches: number | null;
    divan_price_sen: number; leg_height_inches: number | null; leg_price_sen: number;
    custom_specials: unknown; line_suffix: string | null; special_order_price_sen: number;
    discount_sen: number; delivery_date: string | null;
    // Migration 0180 — per-line revised dates for the effective GRN line date.
    supplier_delivery_date_2: string | null;
    supplier_delivery_date_3: string | null;
    supplier_delivery_date_4: string | null;
    po: { id: string; po_number: string; supplier_id: string; status: string; purchase_location_id: string | null; currency?: string | null };
  };

  const itemList = (itemsData ?? []) as unknown as ItemRow[];
  const byId = new Map<string, ItemRow>();
  for (const r of itemList) byId.set(r.id, r);

  // Validate every pick — qty > 0 and qty ≤ remaining.
  for (const p of picks) {
    const row = byId.get(p.poItemId);
    if (!row) return { ok: false, status: 400, body: { error: 'item_not_found', poItemId: p.poItemId } };
    if (p.qty <= 0) return { ok: false, status: 400, body: { error: 'qty_must_be_positive', poItemId: p.poItemId } };
    const remaining = row.qty - (row.received_qty ?? 0);
    if (p.qty > remaining) {
      return { ok: false, status: 409, body: { error: 'qty_exceeds_remaining', poItemId: p.poItemId, requested: p.qty, remaining } };
    }
    if (!isReceivablePo(row.po)) {
      return { ok: false, status: 409, body: { error: 'po_not_receivable', poItemId: p.poItemId, status: row.po.status, onHold: isDocumentHeld(row.po) } };
    }
  }

  /* One probe for the whole batch, not one per bucket: every bucket below writes
     to the same sink, and a refusal here leaves the entire multi-GRN receive
     untouched rather than half-created. */
  const pf = await assertAuditWritable(sb, { entityType: 'GRN', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return { ok: false, status: 409, body: auditUnavailableBody() as unknown as Record<string, unknown> };

  // Group picks by SUPPLIER → one GRN per supplier (Commander 2026-05-29:
  // "不同 supplier 不能 under 同一张 GRN" + "multi-select → 一张 GRN"). A
  // supplier's lines may span several POs; the GRN header references the first
  // PO (grns.purchase_order_id is single-FK) while each grn_item keeps its own
  // purchase_order_item_id, so received_qty still rolls up to EVERY source PO.
  /* `poIds` alongside `poNumbers` because the AutoCount transfer names its
     sources by ERP ROW, not by printed number: enqueueConvert resolves each
     ref through linked_ac_docno, and `primaryPoId` alone would name one of
     the several purchase orders this bucket actually received. */
  type Bucket = { supplierId: string; primaryPoId: string; poIds: Set<string>; poNumbers: Set<string>; warehouseId: string | null; currency: string | null; lines: Array<{ row: ItemRow; qty: number }> };
  const buckets = new Map<string, Bucket>();
  for (const p of picks) {
    const row = byId.get(p.poItemId)!;
    const key = row.po.supplier_id;
    const cur = buckets.get(key) ?? {
      supplierId: row.po.supplier_id, primaryPoId: row.po.id, poIds: new Set<string>(), poNumbers: new Set<string>(),
      warehouseId: row.po.purchase_location_id, currency: row.po.currency ?? null, lines: [],
    };
    cur.poIds.add(row.po.id);
    cur.poNumbers.add(row.po.po_number);
    cur.lines.push({ row, qty: p.qty });
    buckets.set(key, cur);
  }

  // Generate GRN numbers sequentially within this batch.
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Seed from max(suffix), NOT count — count+1 is non-self-healing (a mid-month
  // delete re-mints a surviving number → UNIQUE collision). Derive the next
  // suffix via mintMonthlyDocNo, then counter starts one below it.
  const cp = companyDocPrefix(c);
  const firstNext = await mintMonthlyDocNo(sb, 'grns', 'grn_number', `${cp}GRN-${yymm}`);
  let counter = parseInt(firstNext.slice(`${cp}GRN-${yymm}-`.length), 10) - 1;

  const receivedAt = dateOrNull(body.receivedDate) ?? todayMyt(); // "" is not undefined: nullish left it for Postgres, and a failed bucket here is dropped silently
  const created: DraftGrnFromPoItems[] = [];
  // Track any bucket rolled back by the post-insert over-receipt verification so
  // the caller can surface a 409 with the same error shape the add-line path uses.
  let overReceipt: { poItemId: string; requested: number; remaining: number } | null = null;

  /* R2 money-path guard — validate EVERY bucket's currency up front, before any
     GRN is inserted, so an un-rated foreign PO can't leave a partially-committed
     batch. Each bucket inherits its primary PO currency with no operator rate. */
  for (const bucket of buckets.values()) {
    const rateGuard = await assertForeignRatePostable(sb, { currency: bucket.currency ?? undefined, operatorRate: undefined, docLabel: 'GRN' });
    if (!rateGuard.ok) return { ok: false, status: 422, body: rateGuard.body as unknown as Record<string, unknown> };
  }

  for (const bucket of buckets.values()) {
    counter += 1;
    /* Migration 0082 — GRN currency = its primary PO's; rate auto-fills from the
       master; allocation_method defaults QTY. MYR ⇒ rate 1, no-op. */
    const bucketFx = await resolveGrnFx(sb, bucket.primaryPoId, bucket.currency ?? undefined, undefined);
    const grnPayload = {
      company_id: activeCompanyId(c), // multi-company: stamp the active company
      purchase_order_id: bucket.primaryPoId,
      supplier_id: bucket.supplierId,
      received_at: receivedAt,
      warehouse_id: bucket.warehouseId,
      currency: bucketFx.currency,
      exchange_rate: bucketFx.exchange_rate,
      allocation_method: normalizeAllocationMethod(body.allocationMethod),
      notes: body.notes
        ? `Received from ${[...bucket.poNumbers].join(', ')} · ${body.notes}`
        : `Received from ${[...bucket.poNumbers].join(', ')}`,
      created_by: user.id,
    };
    /* Audit (ported from 2990 b30f0bb1) — the GRN suffix is an in-memory counter
       off a non-locking COUNT snapshot, so a CONCURRENT multi-GRN receive can
       mint the same grn_number (UNIQUE). A collision previously hit
       `if (hErr) continue` and SILENTLY DROPPED the bucket (its inventory-IN
       lost, caller still got 201). Retry on 23505: re-derive the next free
       suffix from a fresh live count + bump. */
    let h: { id: string; grn_number: string; company_id: number } | null = null;
    for (let attempt = 0; attempt < 8 && !h; attempt += 1) {
      const grnNumber = `${cp}GRN-${yymm}-${String(counter).padStart(3, '0')}`;
      const { data: header, error: hErr } = await sb.from('grns')
        .insert({ grn_number: grnNumber, ...grnPayload })
        .select('id, grn_number, company_id').single();
      if (!hErr && header) { h = header as unknown as { id: string; grn_number: string; company_id: number }; break; }
      if (!hErr || (hErr as { code?: string }).code !== '23505') break;
      const liveNext = await mintMonthlyDocNo(sb, 'grns', 'grn_number', `${cp}GRN-${yymm}`);
      counter = parseInt(liveNext.slice(`${cp}GRN-${yymm}-`.length), 10);
    }
    if (!h) continue;

    const rows = bucket.lines.map(({ row, qty }) => {
      const discountSen = row.discount_sen ?? 0;
      return {
        grn_id: h.id,
        purchase_order_item_id: row.id,
        material_kind: row.material_kind,
        item_code: row.item_code,
        material_name: row.material_name,
        qty_received: qty,
        qty_accepted: qty,
        qty_rejected: 0,
        unit_price_sen: row.unit_price_sen,
        /* Migration 0101 — GRN line money: qty_received * unit - discount. */
        // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
        line_total_sen: Math.max(0, (qty * row.unit_price_sen) - discountSen),
        // PR #44 — preserve variants from PO line
        item_group: row.item_group,
        description: row.description,
        description2: row.description2,
        uom: row.uom ?? 'UNIT',
        variants: row.variants,
        gap_inches: row.gap_inches,
        divan_height_inches: row.divan_height_inches,
        divan_price_sen: row.divan_price_sen ?? 0,
        leg_height_inches: row.leg_height_inches,
        leg_price_sen: row.leg_price_sen ?? 0,
        custom_specials: row.custom_specials,
        line_suffix: row.line_suffix,
        special_order_price_sen: row.special_order_price_sen ?? 0,
        discount_sen: discountSen,
        /* Deliverable 5 — carry the PO line's delivery date into the GRN line.
           Migration 0180 — use the EFFECTIVE (latest revised) line date. */
        delivery_date: effectiveDelivery(
          row.delivery_date,
          row.supplier_delivery_date_2,
          row.supplier_delivery_date_3,
          row.supplier_delivery_date_4,
        ),
      };
    });
    const { error: iErr } = await sb.from('grn_items').insert(stampCompany(rows, c));
    if (iErr) {
      await sb.from('grns').delete().eq('id', h.id);
      continue;
    }
    /* Post-insert over-receipt verification — the per-pick pre-check above is a
       read-then-write race with concurrent receives. Re-sum live received per PO
       line; if THIS bucket's GRN broke a cap, roll it back (delete its lines +
       header) and record the over-receipt so the caller 409s. A DRAFT does not
       yet consume PO headroom, but this GRN's own lines always count against the
       cap, so a single over-receiving pick is still caught here. */
    const over = await verifyGrnOverReceipt(sb, h.id, bucket.lines.map(({ row }) => row.id));
    if (over) {
      await sb.from('grn_items').delete().eq('grn_id', h.id);
      await sb.from('grns').delete().eq('id', h.id);
      overReceipt = over;
      continue;
    }
    // Migration 0101 — populate header money rollups from the inserted lines.
    await recomputeGrnTotals(sb, h.id);
    created.push({
      id: h.id,
      grnNumber: h.grn_number,
      companyId: h.company_id,
      primaryPoId: bucket.primaryPoId,
      poIds: bucket.poIds.size ? [...bucket.poIds] : (bucket.primaryPoId ? [bucket.primaryPoId] : []),
      poNumbers: [...bucket.poNumbers],
      lineCount: bucket.lines.length,
    });
  }

  return { ok: true, created, overReceipt };
}

/* ── createDraftGrnFromPoItems — headless PO->GRN for the OCR scan queue ──────
   Runs the SAME core an operator's click runs (bucketing, doc-no minting, line
   mapping, over-receipt rollback) with NO request: the scan job captures the
   caller's identities at enqueue and replays them here through a synthetic
   context, exactly as createDraftSalesOrder / createDraftPosFromPicks do.

   ALWAYS DRAFT — this raises the receipt for a human to confirm; it never posts
   stock. The CREATE audit row IS written here (draft-safe: nothing to post, so
   no post-time rollback to outlive), so a scanned draft is not anonymous. */
export async function createDraftGrnFromPoItems(
  env: Env,
  opts: {
    /** scm auth-bridge identity, stamped created_by on the GRN header. */
    userId: string;
    /** public users bigint, the audit-row WHO. Undefined → unattributed. */
    houzsUserId?: number | null;
    /** The company the scan was raised under. Undefined → unresolved, and the
     *  stamping / scoping no-op exactly as pre-migration. */
    companyId?: number | null;
    allowedCompanyIds?: number[] | null;
    /** MUST be the company CODE string, never the company row — companyDocPrefix
     *  stringifies whatever it is handed (the "[object Object]-..." scar). */
    companyCode?: string | null;
    picks: Array<{ poItemId: string; qty: number }>;
    notes?: string | null;
    receivedDate?: string | null;
    allocationMethod?: unknown;
  },
): Promise<CreateDraftGrnsFromPoItemsResult> {
  const svc = getSupabaseService(env);
  /* EXPLICIT per key, no fall-through — a fall-through is how the scan job once
     handed a company OBJECT to companyDocPrefix and minted a bad doc number. */
  const syntheticGet = (key: string): unknown => {
    if (key === 'supabase') return svc;
    if (key === 'user') return { id: opts.userId };
    if (key === 'companyId') return opts.companyId ?? undefined;
    if (key === 'allowedCompanyIds') return opts.allowedCompanyIds ?? undefined;
    if (key === 'companyCode') return typeof opts.companyCode === 'string' ? opts.companyCode : undefined;
    return undefined;
  };
  const res = await createDraftGrnsFromPoItemsCore({
    req: { json: async () => ({ picks: opts.picks, notes: opts.notes ?? undefined, receivedDate: opts.receivedDate ?? undefined, allocationMethod: opts.allocationMethod }) },
    get: syntheticGet as unknown as GrnFromPoItemsContext['get'],
  });
  /* Record CREATE per draft, at the moment it becomes final (there is no post
     here, so this is that moment). Uses the houzsUser captured at enqueue as the
     WHO; degrades to an unattributed row when absent, like recordPoCreate. */
  if (res.ok) {
    const actor = opts.houzsUserId != null ? ({ id: opts.houzsUserId } as unknown as Variables['houzsUser']) : undefined;
    for (const draft of res.created) {
      await recordGrnCreate(svc, actor, opts.companyId ?? null, draft.id, draft.lineCount, `Received from ${draft.poNumbers.join(', ')}`);
    }
  }
  return res;
}
