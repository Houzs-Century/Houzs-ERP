// /purchase-invoices — supplier billing us (after GRN).

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { buildVariantSummary, isServiceLine } from '../shared';
import { allocateLandedCharges, normalizeAllocationMethod } from '../lib/landed-allocation';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { postPiAccounting, reversePiAccounting, resyncPiAccounting } from './accounting';
import { recostForPi, recostFromGrn } from '../lib/recost';
import { normalizeCurrency, normalizeExchangeRate, masterRateForCurrency } from '../lib/fx';
import { assertForeignRatePostable, assertForeignRatePatchable } from '../lib/fx-guard';
import { parseLineNumbers, invalidLineNumberBody } from '../shared/line-numbers';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { escapeForOr } from '../lib/postgrest-search';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { recordEntityAudit, diffFields, compactChanges, fieldChange, statusChange } from '../lib/entity-audit';
import { PI_LINE_AUDIT_FIELDS, PI_LINE_AUDIT_SELECT } from '../lib/entity-audit-fields';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { resolvePoSoCoveragePerSkuForPos, resolveDeliveredByCodeForPos, summarizeOrigins, type DeliveredDo } from './po-so-coverage';

export const purchaseInvoices = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseInvoices.use('*', supabaseAuth);

/* ── Audit trail (migration 0139 / lib/entity-audit) ───────────────────────────
   Action vocabulary for this module:
     POST   — DRAFT -> POSTED. The AP liability is booked (Dr Inventory / Cr
              Payables) and the GRN lines are consumed.
     CANCEL — status -> CANCELLED (the document event).
     REVERSE— the AP/GL contra that follows a cancel (the LEDGER event), kept
              apart from the CANCEL for the same reason payment-vouchers keeps
              them apart: a reversal that FAILED must be visible as such.
     UPDATE — header edits and payments.
   No DELETE: this module never hard-deletes an invoice. */
const PI_AUDIT_FIELDS: Array<[string, string]> = [
  ['supplierId', 'supplier_id'], ['supplierInvoiceRef', 'supplier_invoice_ref'],
  ['invoiceDate', 'invoice_date'], ['dueDate', 'due_date'],
  ['currency', 'currency'], ['notes', 'notes'],
  ['exchangeRate', 'exchange_rate'],
];

/* CREATE was added after the post/payment/cancel/header pass, and it is recorded
   LATE for a reason. All three create paths write the header first and DELETE it
   again — on a failed line insert, and again when the post-insert over-invoice
   re-verification finds this PI would over-bill a GRN line. A CREATE row emitted
   at insert time would describe an invoice that never existed, against a GRN
   whose invoiced_qty never moved. recordPiCreate re-reads the persisted row
   rather than echoing the payload, which makes that ordering self-enforcing: a
   rolled-back header reads back as nothing and no row is written.

   The line vocabulary lives in lib/entity-audit-fields (imported above) — the
   camelCase half is what AUDIT_FINANCE_FIELDS gates on and needs a test that can
   import it without dragging Hono along. */

const HEADER =
  'id, invoice_number, supplier_invoice_ref, supplier_id, purchase_order_id, grn_id, invoice_date, due_date, currency, exchange_rate, subtotal_centi, tax_centi, total_centi, paid_centi, status, notes, posted_at, created_at, created_by, updated_at';
const ITEM =
  'id, purchase_invoice_id, grn_item_id, material_kind, material_code, material_name, qty, unit_price_centi, line_total_centi, notes, ' +
  /* PR #42 — variant fields (migration 0057) */
  'item_group, description, description2, uom, discount_centi, variants, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen, unit_cost_centi, created_at';

/* Compact non-null string dedupe (document-flow idiom) — the customer-DO
   resolve below walks id lists hop by hop. */
const uniq = (xs: Array<string | null | undefined>) =>
  [...new Set(xs.filter((x): x is string => !!x))];

/* The PI's identity for an audit row written from a LINE handler, which has the
   line in hand but not the parent. Best-effort by design: the writer is
   fail-open, so an unresolved doc number costs the row its human key and
   nothing else. */
async function loadPiAuditMeta(
  sb: Variables['supabase'],
  piId: string,
): Promise<{ docNo: string | null; companyId: number | null; status: string | null }> {
  try {
    const { data } = await sb.from('purchase_invoices')
      .select('invoice_number, company_id, status').eq('id', piId).maybeSingle();
    const row = (data ?? null) as { invoice_number?: string | null; company_id?: number | null; status?: string | null } | null;
    return { docNo: row?.invoice_number ?? null, companyId: row?.company_id ?? null, status: row?.status ?? null };
  } catch {
    return { docNo: null, companyId: null, status: null };
  }
}

/**
 * Record the CREATE of a PI that has SURVIVED its handler.
 *
 * Reads the row back rather than taking the caller's payload: the doc number is
 * minted server-side, the currency and exchange rate are resolved server-side,
 * the totals come off the lines — and a header a compensating branch already
 * deleted reads back as nothing, so this cannot write a CREATE row for an
 * invoice that was rolled back.
 */
async function recordPiCreate(
  sb: Variables['supabase'],
  actor: Variables['houzsUser'],
  fallbackCompanyId: number | null | undefined,
  piId: string,
  lineCount: number,
  note?: string,
): Promise<void> {
  let row: Record<string, unknown> | null = null;
  try {
    const { data } = await sb.from('purchase_invoices')
      .select('id, invoice_number, status, company_id, supplier_id, supplier_invoice_ref, ' +
        'purchase_order_id, grn_id, invoice_date, due_date, currency, exchange_rate, total_centi')
      .eq('id', piId).maybeSingle();
    row = (data ?? null) as Record<string, unknown> | null;
  } catch { /* best-effort */ }
  if (!row) return; // rolled back (or unreadable): a CREATE row here would be a lie
  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_INVOICE',
    entityId: piId,
    entityDocNo: (row.invoice_number as string | null) ?? null,
    action: 'CREATE',
    actor,
    companyId: (row.company_id as number | null) ?? fallbackCompanyId,
    statusSnapshot: (row.status as string | null) ?? null,
    note,
    fieldChanges: compactChanges([
      fieldChange('status', null, row.status ?? null),
      fieldChange('supplierId', null, row.supplier_id ?? null),
      fieldChange('supplierInvoiceRef', null, row.supplier_invoice_ref ?? null),
      fieldChange('purchaseOrderId', null, row.purchase_order_id ?? null),
      fieldChange('grnId', null, row.grn_id ?? null),
      fieldChange('invoiceDate', null, row.invoice_date ?? null),
      fieldChange('dueDate', null, row.due_date ?? null),
      fieldChange('currency', null, row.currency ?? null),
      fieldChange('exchangeRate', null, row.exchange_rate ?? null),
      /* INTEGER SEN, straight off the column. */
      fieldChange('totalCenti', null, row.total_centi ?? null),
      fieldChange('lineCount', null, lineCount),
    ]),
  });
}

const nextNum = async (sb: any, prefix: string, c: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'purchase_invoices', 'invoice_number', `${p}${prefix}-${yymm}`);
};

/* ── Recompute PI header money rollups (mirror recomputeGrnTotals) ─────────
   Sum line_total_centi across purchase_invoice_items → write subtotal_centi,
   then total_centi = subtotal + tax_centi (PI carries a stored tax that GRN
   does NOT, so we ADD it into total here). paid_centi is untouched — Balance
   (total - paid) is derived in the UI; payment recording stays on /payment.

   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale.
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputePiTotals(sb: any, piId: string) {
  const [itemsRes, headerRes] = await Promise.all([
    sb.from('purchase_invoice_items').select('line_total_centi').eq('purchase_invoice_id', piId),
    sb.from('purchase_invoices').select('tax_centi').eq('id', piId).maybeSingle(),
  ]);
  /* Neither read's error was looked at, and `?? []` / `?? 0` cannot tell a failed
     read from a real empty/zero: a blip on the ITEMS read wrote total_centi ZERO
     on an invoice the supplier is owed for, and a blip on the HEADER read wrote a
     total silently SHORT by the tax. Both are what this AP figure is paid from.
     The ERROR is the signal, never the emptiness: a genuinely line-less PI, and a
     PI that genuinely carries no tax, both resolve error === null and MUST still
     fall through. Neither of these two is more urgent than the other, so both
     abort before any write rather than half-writing from the half we trust. */
  if (itemsRes.error) {
    /* eslint-disable-next-line no-console */
    console.error('[pi-recompute] item read failed — header left unchanged:', piId, itemsRes.error.message);
    return;
  }
  if (headerRes.error) {
    /* eslint-disable-next-line no-console */
    console.error('[pi-recompute] tax read failed — header left unchanged:', piId, headerRes.error.message);
    return;
  }
  const subtotal = (itemsRes.data ?? []).reduce((s: number, r: any) => s + (r.line_total_centi ?? 0), 0);
  const tax = (headerRes.data as { tax_centi?: number } | null)?.tax_centi ?? 0;
  const { error: updErr } = await sb.from('purchase_invoices').update({
    subtotal_centi: subtotal,
    total_centi: subtotal + tax,
    updated_at: new Date().toISOString(),
  }).eq('id', piId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pi-recompute] header update failed — totals left STALE:', piId, updErr.message);
  }
}

/* ── PI-level landed freight ("平摊") — reallocatePiCharges ──────────────────
   Migration 0082 added purchase_invoice_items.allocated_charge_centi and recost.ts
   folds it into the FIFO lot cost — but until now NO write path ever filled it, so
   the column sat at 0 forever and freight billed on the SUPPLIER'S INVOICE (the
   normal shape for RMB / cross-border sourcing, where freight arrives on the PI
   rather than the GRN) raised the PI total and the AP but never reached inventory:
   COGS understated permanently. PurchaseInvoiceNew already ships the picker, sends
   allocationMethod, and its preview names this function as the authoritative
   splitter — this is that function.

   POOL = PI-NATIVE service lines only (grn_item_id IS NULL). A service line COPIED
   DOWN from the GRN by /from-grn keeps its grn_item_id, and that charge was ALREADY
   capitalised into the lot at receive time (grn_items.allocated_charge_centi, which
   recost re-adds separately) — pooling it again here would capitalise the same
   freight twice. This is what "each capitalises EXACTLY ONCE" means in recost.ts.

   Allocated across ALL goods lines, mirroring the GRN allocator. A goods line with
   no grn_item_id owns no lot, so its share simply doesn't capitalise — the goods
   aren't in inventory to carry it.

   Pure-on-empty: no native service line ⇒ pool 0 ⇒ allocation 0 everywhere ⇒ the
   column stays 0 and every existing PI recosts byte-for-byte as before.

   METHOD IS NOT PERSISTED: scm.purchase_invoices has no allocation_method column
   (0082 added one to grns only). The create paths pass the operator's choice; a
   later line edit has nothing to read it back from and re-splits by QTY. The pool
   still sums exactly either way — only the basis degrades. Persisting it needs a
   migration + a column. */
async function reallocatePiCharges(
  sb: any,
  piId: string,
  method: ReturnType<typeof normalizeAllocationMethod> = 'QTY',
  companyId?: number | null,
): Promise<void> {
  try {
    const [headRes, itemsRes] = await Promise.all([
      sb.from('purchase_invoices').select('exchange_rate').eq('id', piId).maybeSingle(),
      sb.from('purchase_invoice_items')
        .select('id, grn_item_id, material_code, item_group, qty, unit_price_centi, line_total_centi, allocated_charge_centi')
        .eq('purchase_invoice_id', piId),
    ]);
    /* `?? 1` means "already MYR", so a failed read on an RMB/USD PI allocates the
       freight pool at rate 1 and writes an allocated_charge_centi wrong by the
       whole FX factor onto every goods line — which recost then capitalises into
       the lot. The itemsRes read below fails closed (items = [] returns), but this
       one silently invents an exchange rate. Returning matches this function's own
       contract, stated in the catch: the PI's lines are already committed, a
       hiccup logs + skips and the split re-converges on the next line write. A PI
       that genuinely carries no rate resolves error === null and correctly uses 1. */
    if (headRes.error) {
      /* eslint-disable-next-line no-console */
      console.error('[reallocatePiCharges] PI rate read failed — charge split left unchanged:', piId, headRes.error.message);
      return;
    }
    const piRate = (headRes.data as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;
    const items = (itemsRes.data ?? []) as Array<{
      id: string; grn_item_id: string | null; material_code: string; item_group: string | null;
      qty: number | null; unit_price_centi: number | null; line_total_centi: number | null;
      allocated_charge_centi: number | null;
    }>;
    if (items.length === 0) return;

    /* Drop GRN-copied service lines BEFORE the allocator sees them: it classifies
       by item_group/code alone and would otherwise pool a charge the GRN already
       capitalised. They are not goods either, so removing them leaves the goods
       basis untouched. */
    const visible = items.filter((it) =>
      !(it.grn_item_id && isServiceLine({ itemGroup: it.item_group, itemCode: it.material_code })));

    // CBM basis needs each goods line's product volume; one round trip, default 0
    // (the allocator falls back to QTY when the CBM Σ is 0).
    const m3ByCode = new Map<string, number>();
    const codes = [...new Set(visible.map((it) => it.material_code).filter(Boolean))];
    if (codes.length > 0) {
      // Company-scoped: `code` is shared, and the other company's volume would
      // shift every goods line's share of the landed charge.
      let volQ = sb.from('mfg_products').select('code, unit_m3_milli').in('code', codes);
      if (companyId != null) volQ = volQ.eq('company_id', companyId);
      const { data: prods } = await volQ;
      for (const p of (prods ?? []) as Array<{ code: string; unit_m3_milli: number | null }>) {
        m3ByCode.set(p.code, Number(p.unit_m3_milli ?? 0));
      }
    }

    const alloc = allocateLandedCharges(
      visible.map((it) => ({
        id: it.id,
        itemGroup: it.item_group ?? null,
        materialCode: it.material_code,
        qty: Number(it.qty ?? 0),
        // Pool by the SERVICE line's line total; allocate ONTO the goods lines.
        amountCenti: Number(it.line_total_centi ?? 0),
        unitPriceCenti: Number(it.unit_price_centi ?? 0),
        unitM3Milli: m3ByCode.get(it.material_code) ?? 0,
      })),
      method,
      piRate,
    );

    /* Write the computed value (incl. resetting to 0) so a removed / re-split
       charge is reflected — but only when there's something to reconcile, so a
       plain goods-only PI issues no writes at all. Lines the allocator didn't
       return (the service lines themselves) are forced to 0: recost re-adds the
       charge of ANY line carrying a grn_item_id, so a row that used to be goods and
       was later retyped as freight would otherwise keep injecting a stale charge. */
    const anyToReset = items.some((it) => Number(it.allocated_charge_centi ?? 0) !== 0);
    if (alloc.chargePoolMyr > 0 || anyToReset) {
      const allocById = new Map(alloc.goods.map((g) => [g.id, g.allocatedChargeCenti]));
      await Promise.all(items.map((it) => {
        const next = allocById.get(it.id) ?? 0;
        if (Number(it.allocated_charge_centi ?? 0) === next) return null;
        return sb.from('purchase_invoice_items').update({ allocated_charge_centi: next }).eq('id', it.id);
      }).filter(Boolean));
    }
  } catch (e) {
    // Best-effort (audit-DLQ pattern): the PI's own lines already committed; a
    // freight-split hiccup logs + skips and re-converges on the next line write.
    // eslint-disable-next-line no-console
    console.error('[reallocatePiCharges] failed:', piId, e);
  }
}

/* ── Self-heal GRN invoiced counter (live-count model, mirrors recomputeSoPicked
   / recomputePoReceived) ────────────────────────────────────────────────────
   For each given grn_item, RECOUNT invoiced_qty from scratch as the sum of qty
   across ALL live (non-cancelled) PI lines that point at it. This replaces the
   old delta-based +/- arithmetic so create / edit / delete / cancel all
   converge to the truth and the GRN line auto-releases for re-invoicing the
   moment its PI lines go away. Clamped to [0, qty_accepted]. Best-effort. */
async function recomputeGrnInvoiced(sb: any, grnItemIds: Array<string | null | undefined>) {
  const ids = [...new Set(grnItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return;

  // Best-effort, never throws (Commander 2026-05-30): the primary write already
  // committed. If this secondary recount hiccups we log + skip — the live-count
  // model self-heals on the next operation that touches these GRN lines.
  try {
    // 1. Sum qty from live (non-cancelled) PI lines per GRN item.
    /* The live-count model turns `?? []` into a release: a failed read folds every
       line's recount to 0, the write below stamps invoiced_qty = 0, and the GRN
       line "auto-releases for re-invoicing" exactly as this function's docblock
       promises — except nothing was invoiced away. The supplier's goods can then be
       billed a second time and no error is raised. A GRN line whose PI lines have
       genuinely all gone resolves error === null with data === [] and MUST still
       fall through to 0 — that is the release the model is built on, and it is why
       `rows.length === 0` cannot be the discriminator here. Nothing is written
       above this point. */
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
    /* LEAK GUARD (DRAFT, PI two-state — 2026-06-25 anchoring diff vs 2990) — exclude
       DRAFT as well as CANCELLED PIs from the invoiced_qty recount. A DRAFT PI
       consumes NO GRN qty until it's confirmed (the confirm transition flips it to
       POSTED and re-runs this recount, at which point its lines DO count). Without
       this, a sibling op recounting the same GRN line would silently consume the
       line against a still-draft PI. */
    const excluded = new Set<string>();
    if (piIds.length > 0) {
      /* An empty `excluded` from a failed read does not read as "we don't know" —
         it reads as "no PI here is DRAFT or CANCELLED", which inverts the leak
         guard above: a still-draft PI's qty gets counted as invoiced and consumes
         the GRN line, the precise silent consumption the note forbids. */
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

    // 2. Clamp into [0, qty_accepted] per line, then write.
    /* The clamp is a safety rail on a money-adjacent counter and `?? inv` below
       makes a failed read remove it silently (cap falls back to the uncapped
       value). Nothing is written until the loop after this. */
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

/* ── verifyGrnLinesNotOverInvoiced (post-insert over-invoice race guard) ─────
   The bulk PI create paths (POST /, /from-grn-items, /from-grn) only PRE-check
   each GRN line's remaining before inserting — a read-then-write race: two
   concurrent bulk creates against the same GRN line can each pass the pre-check
   and both insert → the line is over-billed past (qty_accepted - returned_qty).
   After committing THIS PI's lines, re-sum the LIVE invoiced qty (across ALL
   non-cancelled PI lines) per GRN line; if any exceeds its cap, OUR insert broke
   it → delete THIS PI's just-created lines and signal the caller to 409. Mirrors
   the single add-line path (POST /:id/items). Returns the offending lines, or []
   when every GRN line is within cap. */
async function verifyGrnLinesNotOverInvoiced(
  sb: any,
  grnItemIds: Array<string | null | undefined>,
): Promise<Array<{ grnItemId: string; invoiced: number; cap: number }>> {
  const ids = [...new Set(grnItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return [];
  // Cap per GRN line = qty_accepted - returned_qty.
  const { data: giRows } = await sb.from('grn_items')
    .select('id, qty_accepted, returned_qty').in('id', ids);
  const capById = new Map<string, number>(
    ((giRows ?? []) as Array<{ id: string; qty_accepted: number; returned_qty: number }>)
      .map((g) => [g.id, (g.qty_accepted ?? 0) - (g.returned_qty ?? 0)]),
  );
  // Live invoiced per GRN line = sum(qty) across all committed (non-cancelled,
  // non-draft) PI lines.
  const { data: sib } = await sb.from('purchase_invoice_items')
    .select('grn_item_id, qty, purchase_invoice_id').in('grn_item_id', ids);
  const sibRows = (sib ?? []) as Array<{ grn_item_id: string; qty: number; purchase_invoice_id: string }>;
  const piIds = [...new Set(sibRows.map((r) => r.purchase_invoice_id).filter(Boolean))];
  /* LEAK GUARD (DRAFT, PI two-state — 2026-06-25 anchoring diff vs 2990) — exclude
     DRAFT as well as CANCELLED from the over-invoice cap re-sum: a DRAFT PI consumes
     no GRN qty, so it never counts against the qty_accepted-returned cap. The cap is
     re-checked at confirm (recomputeGrnInvoiced clamps to qty_accepted), so a DRAFT
     that would over-bill is caught the moment it's confirmed, not while still a
     draft. */
  const excluded = new Set<string>();
  if (piIds.length > 0) {
    const { data: pis } = await sb.from('purchase_invoices').select('id, status').in('id', piIds);
    for (const p of (pis ?? []) as Array<{ id: string; status: string }>) {
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
  return over;
}

/* PI edit-lock guard: a PI with ANY payment recorded (paid_centi > 0) or that's
   CANCELLED is read-only. Returns the blocking JSON response, or null if the PI
   is editable. */
async function piLocked(sb: any, piId: string): Promise<{ error: string; message: string } | null> {
  const { data } = await sb.from('purchase_invoices')
    .select('paid_centi, status').eq('id', piId).maybeSingle();
  if (!data) return null; // not found — let the handler's own load surface 404
  const row = data as { paid_centi: number | null; status: string };
  if (row.status === 'CANCELLED') return { error: 'pi_cancelled', message: 'Invoice is cancelled' };
  if ((row.paid_centi ?? 0) > 0) return { error: 'pi_locked', message: 'Invoice has a payment recorded — locked' };
  return null;
}

/* Filter-pill bucket → the raw purchase_invoices.status values it covers. Single
   source of truth for BOTH the status-count queries and the list `status`
   filter. All five buckets are 1:1 today, but the FE sends the BUCKET NAME as
   `status`; a raw DB status still works (backward-compatible fallback). */
const PI_STATUS_BUCKETS: Record<string, string[]> = {
  draft: ['DRAFT'],
  posted: ['POSTED'],
  partial: ['PARTIALLY_PAID'],
  paid: ['PAID'],
  cancelled: ['CANCELLED'],
};

/* Collapsed "Assigned SO" column (owner 2026-07-31): a PI inherits its parent
   PO's Assigned SO(s). Resolve the parent PO through the SAME chain the per-line
   drill-down uses (pi.grn_id → grns.purchase_order_id → PO), so the list row and
   its expansion never disagree, then batch the coverage for the whole page in
   ONE pass (computeMrp runs once). Fail-soft: on any error the rows still return,
   just without the column populated. */
async function attachPiAssignedSos(
  sb: any,
  c: any,
  rows: Array<{ id: string; grn_id?: string | null } & Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  try {
    const grnIds = [...new Set(rows.map((r) => r.grn_id).filter((x): x is string => !!x))];
    const poByGrn = new Map<string, string>();
    for (let k = 0; k < grnIds.length; k += 300) {
      const chunk = grnIds.slice(k, k + 300);
      if (chunk.length === 0) continue;
      const { data: grnRows } = await scopeToCompany(
        sb.from('grns').select('id, purchase_order_id'), c,
      ).in('id', chunk);
      for (const g of (grnRows ?? []) as Array<{ id: string; purchase_order_id: string | null }>) {
        if (g.purchase_order_id) poByGrn.set(g.id, g.purchase_order_id);
      }
    }
    const poIds = [...poByGrn.values()];
    /* Each PI's OWN line codes (header ≡ ∪(drill lines), 2026-08-02): the drill
       matches assignments into the PI's lines by material_code, so the header
       cells roll up ONLY those SKUs — a partial-billing PI must not inherit
       its parent PO's whole assignment history. */
    const piIds = rows.map((r) => r.id).filter(Boolean);
    const codesByPi = new Map<string, Set<string>>();
    for (let k = 0; k < piIds.length; k += 300) {
      const chunk = piIds.slice(k, k + 300);
      if (chunk.length === 0) continue;
      const { data: piLines } = await sb.from('purchase_invoice_items')
        .select('purchase_invoice_id, material_code')
        .in('purchase_invoice_id', chunk);
      for (const l of (piLines ?? []) as Array<{ purchase_invoice_id: string; material_code: string | null }>) {
        const code = (l.material_code ?? '').trim();
        if (!code) continue;
        const set = codesByPi.get(l.purchase_invoice_id) ?? new Set<string>();
        set.add(code);
        codesByPi.set(l.purchase_invoice_id, set);
      }
    }
    /* "Delivered" column (owner 2026-07-31): the DO(s) that shipped the goods,
       per CODE via the SAME pi → grn → PO chain, filtered to the PI's codes. */
    const [originsByPo, deliveredByPoCode] = await Promise.all([
      resolvePoSoCoveragePerSkuForPos(sb, c, poIds),
      resolveDeliveredByCodeForPos(sb, c, poIds),
    ]);
    return rows.map((r) => {
      const poId = r.grn_id ? poByGrn.get(r.grn_id) : undefined;
      const piCodes = codesByPi.get(r.id) ?? new Set<string>();
      const origins = (poId ? originsByPo.get(poId) ?? [] : [])
        .filter((o) => piCodes.has(o.itemCode));
      const summary = summarizeOrigins(origins);
      const doAgg = new Map<string, DeliveredDo>();
      if (poId) {
        const byCode = deliveredByPoCode.get(poId);
        if (byCode) {
          for (const code of piCodes) {
            for (const d of byCode.get(code) ?? []) {
              const prev = doAgg.get(d.doNo);
              if (prev) prev.qty += d.qty;
              else doAgg.set(d.doNo, { ...d });
            }
          }
        }
      }
      return {
        ...r,
        assigned_sos: summary.assignedSos,
        assigned_so_linked: summary.sourceLinked,
        /* PR-3 (2026-08-07, additive): the stored-origin "bought for" SO(s) —
           rolled up over the SAME code-filtered origins (header ≡ ∪(lines)). */
        assigned_so_provenance: summary.provenanceSos,
        delivered_dos: [...doAgg.values()].sort((a, b) => a.doNo.localeCompare(b.doNo, undefined, { numeric: true })),
      };
    });
  } catch {
    return rows.map((r) => ({ ...r, assigned_sos: [], assigned_so_linked: false, assigned_so_provenance: [], delivered_dos: [] }));
  }
}

purchaseInvoices.get('/', async (c) => {
  const sb = c.get('supabase');
  // Supplier CONTACT fields ride the list embed — the quick-view drawer's
  // SUPPLIER panel renders off the list row (owner 2026-07-24: all "—").
  const SELECT = `${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, address), purchase_order:purchase_orders(id, po_number), grn:grns(id, grn_number, delivery_note_ref)`;

  /* Opt-in server-side pagination + search + sort + status-counts (mirrors the
     SO list in mfg-sales-orders.ts). The PRESENCE of `page` switches paging on;
     when it is absent/empty the query below is BYTE-IDENTICAL to the historical
     behavior (order invoice_date desc, limit 500, status param, company scope,
     `{ purchaseInvoices }` shape). */
  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  if (!paginate) {
    /* --- LEGACY PATH (unchanged) --- */
    let q = sb.from('purchase_invoices')
      .select(SELECT)
      .order('invoice_date', { ascending: false })
      // Bound the result so PostgREST's default 1000-row cap can't silently
      // truncate the PI list — match the SO/DO/SI list convention.
      .limit(500);
    const status = c.req.query('status'); if (status) q = q.eq('status', status);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    const { data, error } = await q;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    const purchaseInvoices = await attachPiAssignedSos(sb, c, (data ?? []) as Array<{ id: string; grn_id?: string | null }>);
    return c.json({ purchaseInvoices });
  }

  /* --- PAGINATED PATH (opt-in via `page`) --- */
  const page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
  const psRaw = Number(c.req.query('pageSize'));
  const pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

  const SORT_COLS = new Set(['invoice_date', 'invoice_number', 'status', 'total_centi']);
  const [rawCol, rawDir] = (c.req.query('sort') ?? 'invoice_date:desc').split(':');
  const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'invoice_date';
  const sortAsc = rawDir === 'asc';

  let q = sb.from('purchase_invoices').select(SELECT, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
  /* unique tiebreaker so range paging can't skip/repeat rows sharing the sort key */
  if (sortCol !== 'invoice_number') q = q.order('invoice_number', { ascending: sortAsc });
  /* Resolve the incoming `status`: a known bucket key → all its raw statuses;
     'all'/empty → no filter; otherwise treat it as a raw DB status. */
  const status = c.req.query('status');
  if (status && status !== 'all') {
    if (PI_STATUS_BUCKETS[status]) q = q.in('status', PI_STATUS_BUCKETS[status]);
    else q = q.eq('status', status);
  }
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  /* free-text search over the base-table text columns the FE searches
     (PurchaseInvoicesListV2 hay). Supplier name / PO / GRN source are embedded
     resources, not base purchase_invoices columns, so they can't be ilike'd here. */
  const search = c.req.query('q');
  if (search) {
    const s = escapeForOr(search);
    if (s) q = q.or(`invoice_number.ilike.%${s}%,supplier_invoice_ref.ilike.%${s}%,notes.ilike.%${s}%`);
  }
  const from = c.req.query('from'); if (from) q = q.gte('invoice_date', from);
  const to = c.req.query('to'); if (to) q = q.lte('invoice_date', to);
  q = q.range(page * pageSize, page * pageSize + pageSize - 1);
  const { data, error, count } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const total = count ?? (data?.length ?? 0);

  /* Status counts mirror the FE filter-pill buckets (draft / posted / partial /
     paid / cancelled) over the SAME company filter but WITHOUT status / search /
     pagination. */
  const countBase = () => scopeToCompany(sb.from('purchase_invoices').select('*', { count: 'exact', head: true }), c);
  const [allC, draftC, postedC, partialC, paidC, cancelledC] = await Promise.all([
    countBase(),
    countBase().in('status', PI_STATUS_BUCKETS.draft),
    countBase().in('status', PI_STATUS_BUCKETS.posted),
    countBase().in('status', PI_STATUS_BUCKETS.partial),
    countBase().in('status', PI_STATUS_BUCKETS.paid),
    countBase().in('status', PI_STATUS_BUCKETS.cancelled),
  ]);
  const statusCounts = {
    all: allC.count ?? 0,
    draft: draftC.count ?? 0,
    posted: postedC.count ?? 0,
    partial: partialC.count ?? 0,
    paid: paidC.count ?? 0,
    cancelled: cancelledC.count ?? 0,
  };

  const purchaseInvoices = await attachPiAssignedSos(sb, c, (data ?? []) as Array<{ id: string; grn_id?: string | null }>);
  return c.json({ purchaseInvoices, total, page, pageSize, statusCounts });
});

/* ── GET /outstanding-grn-items ─────────────────────────────────────────
   Returns GRN LINES eligible for invoicing. Migration 0106 added
   grn_items.invoiced_qty, so this now tracks PER-LINE remaining (Commander
   2026-05-30 unified consumption model): for each grn_item from a POSTED GRN
   we return remaining = qty_accepted - invoiced_qty and include only lines
   with remaining > 0. A GRN line can be invoiced across MULTIPLE PIs until
   fully consumed (replaces the old header-level all-or-nothing dedupe).

   IMPORTANT (route ordering): this STATIC path MUST be registered before
   the `/:id` param route below — otherwise Hono matches `/:id` first and
   tries to cast "outstanding-grn-items" to a uuid → 500. (Bug fix
   2026-05-28, same class as the PO-from-SO shadowing.) */
purchaseInvoices.get('/outstanding-grn-items', async (c) => {
  const sb = c.get('supabase');
  // Pull every POSTED GRN with its supplier + parent PO so we can group
  // and present in the picker.
  const { data: grnHeaders, error: hErr } = await scopeToCompany(
    sb
      .from('grns')
      .select(`
      id, grn_number, received_at, supplier_id, purchase_order_id, currency, exchange_rate,
      supplier:suppliers ( code, name ),
      purchase_order:purchase_orders ( po_number )
    `),
    c,
  )
    .eq('status', 'POSTED')
    .order('received_at', { ascending: false })
    .limit(500);
  if (hErr) return c.json({ error: 'load_failed', reason: hErr.message }, 500);
  const headers = (grnHeaders ?? []) as unknown as Array<{
    id: string; grn_number: string; received_at: string; supplier_id: string;
    purchase_order_id: string | null;
    currency?: string | null; exchange_rate?: string | number | null;
    supplier: { code: string; name: string } | null;
    purchase_order: { po_number: string } | null;
  }>;
  if (headers.length === 0) return c.json({ items: [] });

  // Load the GRN items for every POSTED GRN. Per-line remaining tracking
  // (migration 0106) replaces the header-level dedupe — a partially-invoiced
  // GRN keeps surfacing its lines that still have remaining > 0.
  const grnIds = headers.map((h) => h.id);
  const { data: items, error: iErr } = await sb
    .from('grn_items')
    .select(`
      id, grn_id, material_kind, material_code, material_name, item_group,
      description, qty_accepted, qty_rejected, invoiced_qty, returned_qty, unit_price_centi, variants
    `)
    .in('grn_id', grnIds);
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);

  const headerById = new Map(headers.map((h) => [h.id, h]));
  const out = ((items ?? []) as Array<{
    id: string; grn_id: string; material_kind: string; material_code: string;
    material_name: string; item_group: string | null; description: string | null;
    qty_accepted: number; qty_rejected: number; invoiced_qty: number; returned_qty: number;
    unit_price_centi: number; variants: unknown;
  }>)
    .map((r) => {
      const invoiced = r.invoiced_qty ?? 0;
      const returned = r.returned_qty ?? 0;
      const remaining = (r.qty_accepted ?? 0) - invoiced - returned;
      return { ...r, _remaining: remaining };
    })
    .filter((r) => r._remaining > 0)
    .map((r) => {
      const h = headerById.get(r.grn_id)!;
      return {
        grnItemId:      r.id,
        grnId:          r.grn_id,
        grnDocNo:       h.grn_number,
        receivedAt:     h.received_at,
        supplierId:     h.supplier_id,
        supplierCode:   h.supplier?.code ?? '',
        supplierName:   h.supplier?.name ?? '',
        purchaseOrderId: h.purchase_order_id,
        poDocNo:        h.purchase_order?.po_number ?? null,
        itemCode:       r.material_code,
        description:    r.description ?? r.material_name,
        itemGroup:      r.item_group ?? '',
        qtyAccepted:    r.qty_accepted,
        invoicedQty:    r.invoiced_qty ?? 0,
        remaining:      r._remaining,
        unitPriceCenti: r.unit_price_centi,
        variants:       r.variants,
        /* Multi-note invoices (owner 2026-08-06) — the picker may combine
           several of a supplier's notes into ONE invoice, but a PI header
           carries ONE currency + rate, so the picker locks on these too. */
        currency:       normalizeCurrency(h.currency),
        exchangeRate:   normalizeExchangeRate(h.exchange_rate, normalizeCurrency(h.currency)),
      };
    });

  /* Owner 2026-08-06 — re-resolve each line's SUPPLIER fabric code from the
     live fabric_trackings row, exactly as the GRN / PO / SI details already do
     at READ. Without it this picker echoed the variants SNAPSHOT taken when
     the line was first raised, so a fabric whose supplier code has since been
     corrected showed the STALE code here while the GRN detail showed the
     current one — the same GRN line read two different ways (found on
     2990-GRN-2608-006: detail KN390-1, picker KN390-2). One batched read,
     fail-soft. */
  await enrichLinesWithFabricSupplierCode(sb, c, out);

  return c.json({ items: out });
});

purchaseInvoices.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    /* grn embed (owner 2026-07-23: "PI need show Do number") — the source GRN's
       doc no + the supplier's delivery-note ref surface on the PI detail. */
    sb.from('purchase_invoices').select(`${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, address), grn:grns(id, grn_number, delivery_note_ref)`).eq('id', id).maybeSingle(),
    sb.from('purchase_invoice_items').select(ITEM).eq('purchase_invoice_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Canonical SKU/build order at READ (sofa modules LHF→NA→RHF, mains→
     accessories→services), mirroring the SO detail GET. The shared helper keys
     on `item_code`; PI lines expose `material_code`, so sort a shimmed view
     that carries the original row back unchanged. `.order('created_at')` above
     stays as the stable tiebreaker — pure ordering, no persistence touched. */
  type PiItemRow = Record<string, unknown> & { id: string; material_code: string; item_code: string };
  const items = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      ((i.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; material_code: string }>)
        .map((it): PiItemRow => ({ ...it, item_code: it.material_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );

  /* Supplier SKU — purchase_invoice_items has no code column of its own, but a
     goods line points at its source GRN line (grn_item_id), which snapshotted
     the supplier's own code at receipt (grn_items.supplier_sku). Surface it so
     the PI shows the supplier's code even when no live supplier↔material binding
     exists; PI-native service lines (grn_item_id NULL) simply carry none. The
     frontend still falls back to the binding when a line has no snapshot. */
  try {
    const grnItemIds = uniq((items as Array<{ grn_item_id?: string | null }>).map((r) => r.grn_item_id));
    if (grnItemIds.length) {
      const { data: gis } = await sb.from('grn_items').select('id, supplier_sku').in('id', grnItemIds);
      const skuByGrnItem = new Map<string, string>();
      for (const g of (gis ?? []) as Array<{ id: string; supplier_sku: string | null }>) {
        if (g.supplier_sku) skuByGrnItem.set(g.id, g.supplier_sku);
      }
      for (const it of items as Array<Record<string, unknown> & { grn_item_id?: string | null }>) {
        it.supplier_sku = it.grn_item_id ? skuByGrnItem.get(it.grn_item_id) ?? null : null;
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[pi detail] supplier-sku resolve failed', { id, error: e });
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
  const { data, error } = await sb
    .from('purchase_invoices')
    .select(`
      id,
      grn:grns(id, grn_number),
      purchase_order:purchase_orders(id, po_number)
    `)
    .eq('id', id)
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  // Supabase typegen returns joined rows as arrays even for to-one FKs.
  const raw = data as unknown as {
    grn?: { id: string; grn_number: string } | Array<{ id: string; grn_number: string }> | null;
    purchase_order?: { id: string; po_number: string } | Array<{ id: string; po_number: string }> | null;
  };
  const headerGrn: { id: string; grn_number: string } | null =
    Array.isArray(raw.grn) ? (raw.grn[0] ?? null) : (raw.grn ?? null);
  const headerPo: { id: string; po_number: string } | null =
    Array.isArray(raw.purchase_order) ? (raw.purchase_order[0] ?? null) : (raw.purchase_order ?? null);

  /* Line-level fan-out: PI line → grn_item → grn (→ purchase_order). Fail-soft;
     on any hiccup the primary FKs alone still answer. */
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
      /* POs via the notes' lines — a note's own purchase_order_id can be null
         (manual receipt) while its lines still point at PO lines. */
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
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.supplierId) return c.json({ error: 'supplier_required' }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: 'items_required' }, 400);

  /* DRAFT lifecycle (re-added per the full 6-doc Draft/Confirmed plan; reverses
     migration 0078's PI DRAFT removal). asDraft is opt-in per request — a normal
     create still defaults to POSTED (the committed state), exactly like SO. A
     DRAFT PI commits NOTHING: no GRN-line consume, no GL post, no recost. Those
     all move to the confirm transition (PATCH /:id/post). */
  const asDraft = body.asDraft === true;

  const sb = c.get('supabase'); const user = c.get('user');

  /* Over-invoice guard (mirrors /from-grn-items line ~432 + /:id/items): any
     line linked to a GRN line is capped at that line's REMAINING
     (qty_accepted - invoiced_qty - returned_qty). Sum requested qty per GRN
     line first, since the same GRN line can appear twice in one PI. Without
     this the ?grnId= draft path could over-bill or double-invoice. */
  {
    const wantByGrnItem = new Map<string, number>();
    for (const it of items) {
      const gid = (it.grnItemId as string | undefined) ?? null;
      if (!gid) continue;
      wantByGrnItem.set(gid, (wantByGrnItem.get(gid) ?? 0) + Number(it.qty ?? 0));
    }
    const gids = [...wantByGrnItem.keys()];
    if (gids.length > 0) {
      const { data: giRows } = await sb.from('grn_items')
        .select('id, qty_accepted, invoiced_qty, returned_qty').in('id', gids);
      const byId = new Map<string, { qty_accepted: number; invoiced_qty: number; returned_qty: number }>(
        ((giRows ?? []) as Array<{ id: string; qty_accepted: number; invoiced_qty: number; returned_qty: number }>)
          .map((g) => [g.id, g]),
      );
      const over: Array<{ grnItemId: string; requested: number; remaining: number }> = [];
      for (const [gid, want] of wantByGrnItem.entries()) {
        const g = byId.get(gid);
        if (!g) return c.json({ error: 'item_not_found', grnItemId: gid }, 400);
        const remaining = (g.qty_accepted ?? 0) - (g.invoiced_qty ?? 0) - (g.returned_qty ?? 0);
        if (want > remaining) over.push({ grnItemId: gid, requested: want, remaining });
      }
      if (over.length > 0) {
        return c.json({ error: 'qty_exceeds_remaining', lines: over }, 409);
      }
    }
  }

  let subtotal = 0;
  /* Reject non-finite line numbers BEFORE the map — the Math.max(0, ...) clamp
     below stops a negative total but NOT a NaN (Math.max(0, NaN) is NaN), so a
     junk qty/price persisted NaN into line_total_centi and the PI subtotal,
     which is what the supplier's AP balance is read from. */
  for (const [i, it] of items.entries()) {
    const parsed = parseLineNumbers({
      qty: { value: it.qty },
      unitPriceCenti: { value: it.unitPriceCenti },
      discountCenti: { value: it.discountCenti },
    });
    if (!parsed.ok) {
      const b = invalidLineNumberBody(parsed.invalid);
      return c.json({ ...b, reason: `Line ${i + 1}: ${b.reason}` }, 400);
    }
  }
  const itemRows = items.map((it) => {
    /* PI discount unification (audit 2026-06-11 M3) — ONE rule on every PI
       line write path: line_total_centi = qty × unit − discount, discount
       stored. This path used to drop the client discount entirely (totals
       overstated whenever the form sent one). */
    const qty = Number(it.qty ?? 0); const unit = Number(it.unitPriceCenti ?? 0);
    const discount = Number(it.discountCenti ?? 0) || 0;
    // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
    const total = Math.max(0, qty * unit - discount); subtotal += total;
    return {
      material_kind: it.materialKind,
      material_code: it.materialCode,
      material_name: it.materialName,
      qty, unit_price_centi: unit, discount_centi: discount, line_total_centi: total,
      grn_item_id: (it.grnItemId as string | undefined) ?? null,
      notes: (it.notes as string | undefined) ?? null,
      // Commander 2026-05-29 — manual PI lines carry their category + variant
      // selections so the PI mirrors WHAT was billed (same as the from-grn-items
      // path). Columns exist on purchase_invoice_items (migration 0057).
      item_group: (it.itemGroup as string | null | undefined) ?? null,
      variants: (it.variants as Record<string, unknown> | null | undefined) ?? null,
    };
  });

  /* PR-DRAFT-removal — PIs are now created as POSTED directly. PI is
     AP-only (no inventory impact — that landed at GRN time), so there's
     no side-effect helper to call after insert. */
  /* Migration 0082 — the PI's currency (MYR default) + its exchange_rate (MYR per
     1 unit of that currency). The rate auto-fills from the currency MASTER unless
     the body sends one; MYR ⇒ rate 1 (a strict no-op — the AP GL post converts at
     this rate). */
  const piCurrency = normalizeCurrency(body.currency);
  const piRateRaw = body.exchangeRate !== undefined && body.exchangeRate !== null
    ? body.exchangeRate
    : await masterRateForCurrency(sb, piCurrency);
  const piExchangeRate = normalizeExchangeRate(piRateRaw, piCurrency);
  /* R2 money-path guard (audit inventory-costing-integrity R2) — refuse a foreign
     PI whose currency has no positive master rate and no operator-entered rate,
     rather than posting the AP GL entry at a 1:1 fallback. Applies to drafts too:
     the create boundary is the only point where an unset-master 1 can still be
     told apart from a deliberately-entered 1. The from-grn / from-grn-items paths
     inherit an exchange_rate already gated at GRN create, so they need no guard. */
  {
    const rateGuard = await assertForeignRatePostable(sb, { currency: piCurrency, operatorRate: body.exchangeRate, docLabel: 'purchase invoice' });
    if (!rateGuard.ok) return c.json(rateGuard.body, 422);
  }
  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; invoice_number: string }>(
    () => nextNum(sb, 'PI', c),
    (invoiceNumber) => sb.from('purchase_invoices').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    invoice_number: invoiceNumber,
    supplier_invoice_ref: (body.supplierInvoiceRef as string) ?? null,
    supplier_id: body.supplierId,
    purchase_order_id: (body.purchaseOrderId as string) ?? null,
    grn_id: (body.grnId as string) ?? null,
    invoice_date: (body.invoiceDate as string) ?? todayMyt(),
    due_date: (body.dueDate as string) ?? null,
    currency: piCurrency,
    exchange_rate: piExchangeRate,
    subtotal_centi: subtotal,
    total_centi: subtotal,
    notes: (body.notes as string) ?? null,
    status: asDraft ? 'DRAFT' : 'POSTED',
    posted_at: asDraft ? null : new Date().toISOString(),
    created_by: user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; invoice_number: string };

  const rowsWithId = itemRows.map((r) => ({ ...r, purchase_invoice_id: h.id }));
  const { error: iErr } = await sb.from('purchase_invoice_items').insert(stampCompany(rowsWithId, c));
  if (iErr) { await sb.from('purchase_invoices').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  /* Post-insert over-invoice verification (race guard) — the pre-check above is
     read-before-write; re-sum live invoiced per GRN line now that OUR lines are
     committed. If any GRN line is over its cap, delete THIS PI (header cascades
     its lines) + 409. Mirrors POST /:id/items. */
  {
    const over = await verifyGrnLinesNotOverInvoiced(sb, itemRows.map((r) => r.grn_item_id));
    if (over.length > 0) {
      await sb.from('purchase_invoices').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', lines: over }, 409);
    }
  }

  /* The invoice has survived both compensating branches (items-insert rollback,
     over-invoice rollback). Everything below is best-effort and never deletes
     the header, so from here every exit is a success and this CREATE row is
     true. Written before the DRAFT-dependent side-effects so both statuses
     record exactly one. */
  await recordPiCreate(sb, c.get('houzsUser'), activeCompanyId(c), h.id, itemRows.length);

  /* LEAK GUARD (DRAFT) — a DRAFT PI commits nothing: it must NOT consume the GRN
     line (recomputeGrnInvoiced) nor re-cost (recostForPi). Both move to the
     confirm transition (PATCH /:id/post). GL/AP posting (postPiAccounting) is ALSO
     skipped for DRAFT — and this path never posts the GL itself even when POSTED.
     PATCH /:id/post is what posts it, for a draft being confirmed AND for a PI
     created straight to POSTED (the New-PI screen calls it right after create);
     POST /post/pi/:invoiceNumber remains the manual re-post. */
  /* Split any PI-native freight across the goods lines. Runs for a DRAFT too: the
     operator's allocation basis is known ONLY here (no column persists it), and the
     column is inert until the PI is confirmed — recost excludes DRAFT PIs from the
     freight aggregate — so capturing it now is what makes the confirm honour the
     basis the operator actually chose. */
  await reallocatePiCharges(sb, h.id, normalizeAllocationMethod(body.allocationMethod), activeCompanyId(c));
  if (!asDraft) {
    // Self-heal the GRN invoiced counter so the just-billed lines drop out of the
    // outstanding picker (mirrors /from-grn-items line ~523 + /:id/items).
    await recomputeGrnInvoiced(sb, itemRows.map((r) => r.grn_item_id));
    // Costing B — a new PI is the authoritative cost: re-cost the GRN's lots →
    // consumptions → movements → DO → SI so a shipped order's margin reflects the
    // billed price (or its later correction) in real time.
    await recostForPi(sb, h.id);
  }
  return c.json({ id: h.id, invoiceNumber: h.invoice_number }, 201);
});

/* ── PATCH /:id/post — CONFIRM transition (DRAFT → POSTED) ───────────────────
   This is where a DRAFT PI commits. It mirrors the SO confirm: an atomic
   DRAFT → POSTED flip, then the side-effects that a DRAFT deliberately skipped
   on create now run exactly once here:
     · recomputeGrnInvoiced  — consume the source GRN lines (drop them out of the
       outstanding picker) — the SAME chokepoint POST/ runs for a non-DRAFT PI.
     · postPiAccounting       — post Dr Inventory 1200 / Cr Payables 2000 (AP/GL).
     · recostForPi            — push the billed price down the lots → DO → SI.
   Idempotent + back-compat: a PI already POSTED (e.g. created non-DRAFT) echoes
   back without re-running the transition, but still ENSURES its AP/GL entry —
   postPiAccounting is itself idempotent (keyed on an active PI JE) and
   recomputeGrnInvoiced is a from-scratch recount, so a stray double-call can't
   double-bill. */
export const postPurchaseInvoiceHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  /* The load is scoped, not just the flip below, because the load ALONE reaches
     a write: the non-DRAFT branch calls postPiAccounting (Dr Inventory / Cr
     Payables) and returns without ever touching the UPDATE. Scoping only the
     flip would have left that ensure-post path posting to another company's
     ledger. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(sb.from('purchase_invoices')
    .select('id, status, invoice_number, company_id, supplier_id, total_centi, currency').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const curRow = cur as {
    id: string; status: string; invoice_number: string;
    company_id?: number | null; supplier_id?: string | null; total_centi?: number | null; currency?: string | null;
  };
  /* Already POSTED (or beyond — PARTIALLY_PAID / PAID) → nothing to CONFIRM, but
     the AP/GL entry may still be missing: a PI created straight to POSTED (the
     default create path) never runs the transition below, and the New-PI screen
     calls this route immediately after such a create and then tells the operator
     "AP liability recorded". It wasn't. Ensure it here so that claim is true.
     postPiAccounting is keyed on an ACTIVE PI JE, so a PI that already posted is
     untouched and a double-click can't double-book. CANCELLED is excluded: its JE
     was reversed at cancel time and must not be resurrected. */
  if (curRow.status !== 'DRAFT') {
    if (curRow.status !== 'CANCELLED') {
      const ensure = await postPiAccounting(sb, curRow.invoice_number);
      if (!ensure.ok) {
        // eslint-disable-next-line no-console
        console.error(`[pi-accounting] ensure-post failed for ${curRow.invoice_number}:`, ensure.status, ensure.reason);
      }
    }
    return c.json({ purchaseInvoice: cur });
  }

  /* Atomic single DRAFT → POSTED transition — the conditional UPDATE only fires
     when the row is still DRAFT, so two concurrent confirms race and exactly ONE
     flips it (the other gets no row → idempotent echo). This guarantees the
     GRN-consume + GL post + recost below run exactly once. */
  const { data, error } = await scopeToCompanyId(sb.from('purchase_invoices').update({
    status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id), co.companyId).eq('status', 'DRAFT').select('id, status').maybeSingle();
  if (error) return c.json({ error: 'post_failed', reason: error.message }, 500);
  if (!data) {
    // Lost the race — a concurrent confirm already flipped it. Echo the live row.
    const { data: now } = await scopeToCompanyId(
      sb.from('purchase_invoices').select('id, status').eq('id', id), co.companyId,
    ).maybeSingle();
    return c.json({ purchaseInvoice: now ?? cur });
  }

  /* Recorded the moment the flip WON, before the GRN consume / GL post / recost
     below. Each of those is a separate awaited step that can throw, and a PI
     that is POSTED in the database with no record of who posted it is exactly
     the hole this log exists to close. The GL outcome is recorded separately
     when it fails. totalCenti is the INTEGER SEN booked to Payables. */
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
      fieldChange('totalCenti', null, Number(curRow.total_centi ?? 0)),
      fieldChange('currency', null, curRow.currency ?? null),
    ]),
  });

  // COMMIT (was skipped at DRAFT create). Consume the GRN lines so the just-billed
  // rows drop out of the outstanding picker.
  const { data: lines } = await sb.from('purchase_invoice_items')
    .select('grn_item_id').eq('purchase_invoice_id', id);
  const grnItemIds = (lines ?? []).map((l: { grn_item_id: string | null }) => l.grn_item_id);
  await recomputeGrnInvoiced(sb, grnItemIds);
  // Post the AP/GL entry (Dr Inventory 1200 / Cr Payables 2000). Best-effort —
  // idempotent + a post failure never un-confirms the PI.
  const postRes = await postPiAccounting(sb, curRow.invoice_number);
  if (!postRes.ok) {
    // eslint-disable-next-line no-console
    console.error(`[pi-accounting] confirm post failed for ${curRow.invoice_number}:`, postRes.status, postRes.reason);

    /* A SECOND row, written only on failure. The POST above is true — the
       invoice IS posted — but the AP entry behind it is not, and a history that
       shows only the success would send someone hunting for a JE that was never
       written. */
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
  // Costing B — the now-confirmed PI is the authoritative cost: re-cost lots/DO/SI.
  await recostForPi(sb, id);
  return c.json({ purchaseInvoice: data });
};
purchaseInvoices.patch('/:id/post', postPurchaseInvoiceHandler);

// Record a payment against the PI. Adds to paid_centi and auto-transitions
// status: paid_centi == total → PAID, paid_centi > 0 && < total → PARTIALLY_PAID.
purchaseInvoices.patch('/:id/payment', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: { amountCenti?: number; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const amount = Number(body.amountCenti ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'invalid_amount' }, 400);

  // Optimistic-concurrency loop (Bug#5, ported from 2990 1355332c). The old code
  // did read-modify-write — two payments hitting the SAME PI at once both read X
  // and both wrote X+amount, silently LOSING one. PI has no payment ledger to
  // re-sum (unlike SI's recomputePaid), and PostgREST can't do `col = col + x`,
  // so we gate the UPDATE on `paid_centi = <the value we just read>`: if a
  // concurrent payment moved it, the update matches 0 rows and we retry with a
  // fresh read.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data: cur } = await sb.from('purchase_invoices')
      .select('paid_centi, total_centi, status, invoice_number, company_id').eq('id', id).maybeSingle();
    if (!cur) return c.json({ error: 'not_found' }, 404);
    const c0 = cur as {
      paid_centi: number; total_centi: number; status: string;
      invoice_number?: string | null; company_id?: number | null;
    };
    // LEAK GUARD (DRAFT) — a DRAFT PI is not yet a real liability; reject payment
    // until it's confirmed. (Re-added with the DRAFT lifecycle — see POST/.)
    if (c0.status === 'DRAFT') return c.json({ error: 'not_payable', message: 'PI is a draft — confirm it before recording payment' }, 409);
    if (c0.status === 'CANCELLED') return c.json({ error: 'not_payable', message: 'PI is cancelled' }, 409);

    const newPaid = c0.paid_centi + amount;
    const newStatus = newPaid >= c0.total_centi ? 'PAID' : 'PARTIALLY_PAID';

    const { data, error } = await sb.from('purchase_invoices').update({
      paid_centi: newPaid, status: newStatus, updated_at: new Date().toISOString(),
    })
      .eq('id', id)
      .eq('paid_centi', c0.paid_centi) // only if nobody else moved it since the read
      .select('id, paid_centi, status');
    if (error) return c.json({ error: 'payment_failed', reason: error.message }, 500);
    if (data && data.length > 0) {
      /* Written only by the attempt whose compare-and-set actually landed, so a
         retry loop cannot produce two rows for one payment. The from-value is
         the paid_centi that guard matched, which makes the pair exact rather
         than approximate. All three figures are INTEGER SEN. */
      await recordEntityAudit(sb, {
        entityType: 'PURCHASE_INVOICE',
        entityId: id,
        entityDocNo: c0.invoice_number ?? null,
        action: 'UPDATE',
        actor: c.get('houzsUser'),
        companyId: c0.company_id ?? activeCompanyId(c),
        statusSnapshot: newStatus,
        note: 'Payment recorded',
        fieldChanges: compactChanges([
          fieldChange('paidCenti', c0.paid_centi, newPaid),
          fieldChange('paymentAmountCenti', null, amount),
          ...statusChange(c0.status, newStatus),
        ]),
      });
      return c.json({ purchaseInvoice: data[0] });
    }
    // 0 rows updated → a concurrent payment changed paid_centi; loop re-reads + retries.
  }
  return c.json({ error: 'payment_conflict', message: 'Another payment was recorded at the same moment — please check the balance and retry.' }, 409);
});

purchaseInvoices.patch('/:id/cancel', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');

  // Read → guard → release → cancel. Keep the existing PAID guard; a PI with
  // any payment can't be cancelled.
  const { data: cur } = await sb.from('purchase_invoices')
    .select('id, status, paid_centi, invoice_number, company_id, total_centi').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const head = cur as {
    id: string; status: string; paid_centi: number | null;
    invoice_number?: string | null; company_id?: number | null; total_centi?: number | null;
  };
  const auditCompanyId = head.company_id ?? activeCompanyId(c);
  if (head.status === 'PAID' || (head.paid_centi ?? 0) > 0) {
    return c.json({ error: 'cannot_cancel', message: 'PI already paid' }, 409);
  }
  // Idempotent — already cancelled, echo back without re-releasing.
  if (head.status === 'CANCELLED') return c.json({ purchaseInvoice: { id, status: 'CANCELLED' } });

  /* LEAK GUARD (DRAFT) — a DRAFT PI never committed anything (no GL post, no
     GRN consume, no recost), so cancelling it is a plain status flip: skip the
     accounting reversal + GRN release + recost entirely (nothing to reverse). */
  if (head.status === 'DRAFT') {
    const { data: d } = await sb.from('purchase_invoices').update({
      status: 'CANCELLED', updated_at: new Date().toISOString(),
    }).eq('id', id).eq('status', 'DRAFT').select('id, status').maybeSingle();

    /* Only the call that actually flipped the row gets one back (the
       .eq('status','DRAFT') gate), so a lost race writes nothing. No REVERSE
       row follows: a DRAFT PI posted nothing, which is why this branch skips
       the accounting reversal entirely. */
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

  /* Bug #3/#11 — ATOMIC single ACTIVE→CANCELLED transition. The conditional
     UPDATE excludes both PAID and CANCELLED, so two concurrent cancels race on
     the same row and only ONE flips it (the other gets no row back → idempotent
     no-op). This guarantees the accounting reversal + GRN release below run
     exactly once, never double-reversing. .maybeSingle() (not .single()) so a
     lost race returns null instead of a PGRST116 throw. */
  const { data, error } = await sb.from('purchase_invoices').update({
    status: 'CANCELLED', updated_at: new Date().toISOString(),
  }).eq('id', id).neq('status', 'PAID').neq('status', 'CANCELLED').select('id, status, invoice_number').maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data) {
    // Lost the race (a concurrent cancel already flipped it) or it became PAID.
    // Re-read to distinguish: a CANCELLED row → idempotent success echo.
    const { data: now } = await sb.from('purchase_invoices').select('id, status').eq('id', id).maybeSingle();
    if ((now as { status: string } | null)?.status === 'CANCELLED') {
      return c.json({ purchaseInvoice: now });
    }
    return c.json({ error: 'cannot_cancel', message: 'PI already paid' }, 409);
  }
  const cancelled = data as { id: string; status: string; invoice_number: string };

  /* Recorded immediately after the atomic flip won the race, so exactly one
     CANCEL row exists per invoice — the losing concurrent call returned above
     and never reaches here. */
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
      fieldChange('totalCenti', null, Number(head.total_centi ?? 0)),
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

  /* A SEPARATE row from the CANCEL above, not a duplicate of it: that was a
     document-status event, this is the AP/GL contra with its own outcome, and a
     cancel whose reversal failed must be distinguishable from one whose
     reversal landed. */
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

  // Release the GRN-line consumption: recount invoiced_qty from live PI lines —
  // this cancelled PI's lines now drop out, auto-releasing the GRN line.
  const { data: lines } = await sb.from('purchase_invoice_items')
    .select('grn_item_id').eq('purchase_invoice_id', id);
  await recomputeGrnInvoiced(sb, (lines ?? []).map((l: { grn_item_id: string | null }) => l.grn_item_id));
  // Costing B — a cancelled PI is no longer the authoritative price; re-cost the
  // GRN so its buckets fall back to the GR price (or Pending), and DOs/SIs follow.
  await recostForPi(sb, id);
  return c.json({ purchaseInvoice: { id: cancelled.id, status: cancelled.status } });
});

/* ── POST /from-grn-items ───────────────────────────────────────────────
   Body: { picks: [{ grnItemId, qty }], supplierInvoiceNumber?, invoiceDate?,
           notes? }.
   Server logic:
     1. Load all selected GRN items with parent GRN (for supplier_id + po_id)
     2. Group by SUPPLIER + currency + FX rate — a supplier who delivers three
        times and bills ONCE gets ONE PI covering all three notes (owner
        2026-08-06). Splitting by currency/rate is not a policy choice: the
        header carries a single currency + exchange_rate, so notes that landed
        under different FX cannot share one document.
     3. Create + auto-post one PI per group.
   MULTI-GRN MODEL (mirrors purchase_returns/from-grns): the header's grn_id is
   the PRIMARY note ref only; the authoritative linkage is per LINE via
   purchase_invoice_items.grn_item_id. Every consumption / costing path already
   reads the line level (recomputeGrnInvoiced, verifyGrnLinesNotOverInvoiced,
   computeGrnFlags, recostForPi), so they are multi-GRN correct unchanged.
   PI does NOT touch inventory (PI is AP-only — inventory landed at GRN time).
   Returns { created: [{ id, invoiceNumber, supplierId, grnCount, lineCount }], total }. */
purchaseInvoices.post('/from-grn-items', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: {
    picks?: Array<{ grnItemId: string; qty: number }>;
    supplierInvoiceNumber?: string;
    invoiceDate?: string;
    dueDate?: string;
    notes?: string;
  };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const picks = body.picks ?? [];
  if (picks.length === 0) return c.json({ error: 'picks_required' }, 400);

  // Load picked GRN items + parent GRN headers.
  const ids = picks.map((p) => p.grnItemId);
  const { data: itemsData, error: itemsErr } = await sb
    .from('grn_items')
    .select(`
      id, grn_id, material_kind, material_code, material_name, item_group,
      description, description2, uom, qty_accepted, invoiced_qty, returned_qty, unit_price_centi,
      variants, gap_inches, divan_height_inches, divan_price_sen,
      leg_height_inches, leg_price_sen, custom_specials, line_suffix,
      special_order_price_sen, discount_centi,
      grn:grns!inner ( id, grn_number, supplier_id, purchase_order_id, status, currency, exchange_rate )
    `)
    .in('id', ids);
  if (itemsErr) return c.json({ error: 'load_failed', reason: itemsErr.message }, 500);

  type ItemRow = {
    id: string; grn_id: string; material_kind: string; material_code: string;
    material_name: string; item_group: string | null; description: string | null;
    description2: string | null; uom: string | null;
    qty_accepted: number; invoiced_qty: number; returned_qty: number; unit_price_centi: number;
    variants: unknown; gap_inches: number | null; divan_height_inches: number | null;
    divan_price_sen: number; leg_height_inches: number | null; leg_price_sen: number;
    custom_specials: unknown; line_suffix: string | null; special_order_price_sen: number;
    discount_centi: number;
    grn: { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string; currency?: string | null; exchange_rate?: string | number | null };
  };

  const itemList = (itemsData ?? []) as unknown as ItemRow[];
  const byId = new Map<string, ItemRow>();
  for (const r of itemList) byId.set(r.id, r);

  for (const p of picks) {
    const row = byId.get(p.grnItemId);
    if (!row) return c.json({ error: 'item_not_found', grnItemId: p.grnItemId }, 400);
    if (p.qty <= 0) return c.json({ error: 'qty_must_be_positive', grnItemId: p.grnItemId }, 400);
    // Cap each pick at the GRN line's REMAINING (qty_accepted - invoiced_qty -
    // returned_qty), not raw qty_accepted — a line can be invoiced across
    // multiple PIs, and returned-to-supplier qty is no longer invoiceable.
    const remaining = (row.qty_accepted ?? 0) - (row.invoiced_qty ?? 0) - (row.returned_qty ?? 0);
    if (p.qty > remaining) {
      return c.json({ error: 'qty_exceeds_remaining', grnItemId: p.grnItemId, requested: p.qty, remaining }, 409);
    }
    if (row.grn.status !== 'POSTED') {
      return c.json({ error: 'grn_not_posted', grnItemId: p.grnItemId, status: row.grn.status }, 409);
    }
  }

  /* Group picks by SUPPLIER + currency + FX rate (owner 2026-08-06). One
     supplier invoice can cover several delivery notes, so notes no longer split
     the document — but currency/rate still must, since the PI header carries a
     single pair. grnIds/grnNumbers keep every note the group touches: the
     FIRST (by note number) becomes the header's primary grn_id, and all of them
     drive the notes text, the recost fan-out and the audit trail. */
  type Bucket = {
    grnIds: string[]; grnNumbers: string[];
    supplierId: string; purchaseOrderId: string | null;
    currency: string; exchangeRate: number;
    lines: Array<{ row: ItemRow; qty: number }>;
  };
  const buckets = new Map<string, Bucket>();
  for (const p of picks) {
    const row = byId.get(p.grnItemId)!;
    // Migration 0082 — the PI inherits its source GRN's currency + exchange_rate
    // (the receipt already fixed the FX). MYR ⇒ rate 1, no-op.
    const grnCur = normalizeCurrency(row.grn.currency);
    const rate = normalizeExchangeRate(row.grn.exchange_rate, grnCur);
    const key = `${row.grn.supplier_id}|${grnCur}|${rate}`;
    const cur = buckets.get(key) ?? {
      grnIds: [], grnNumbers: [],
      supplierId: row.grn.supplier_id,
      /* Header PO ref is the FIRST note's PO — like grn_id it is a convenience
         ref, not the truth: notes in one group may descend from different POs,
         and the per-line grn_item_id → grn → po walk is what readers use. */
      purchaseOrderId: row.grn.purchase_order_id,
      currency: grnCur, exchangeRate: rate,
      lines: [],
    };
    if (!cur.grnIds.includes(row.grn.id)) {
      cur.grnIds.push(row.grn.id);
      cur.grnNumbers.push(row.grn.grn_number);
    }
    cur.lines.push({ row, qty: p.qty });
    buckets.set(key, cur);
  }
  /* Stable primary: lowest note number, so re-running the same picks always
     stamps the same header ref (and the notes text reads in note order). */
  for (const b of buckets.values()) {
    const order = b.grnIds
      .map((id, i) => ({ id, no: b.grnNumbers[i]! }))
      .sort((x, y) => x.no.localeCompare(y.no));
    b.grnIds = order.map((o) => o.id);
    b.grnNumbers = order.map((o) => o.no);
  }

  // Generate PI numbers sequentially within this batch.
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Seed from max(suffix), NOT count — count+1 is non-self-healing (a mid-month
  // delete re-mints a surviving number → UNIQUE collision). Derive the next
  // suffix via nextMonthlyDocNo, then counter starts one below it.
  const cp = companyDocPrefix(c);
  const firstNext = await mintMonthlyDocNo(sb, 'purchase_invoices', 'invoice_number', `${cp}PI-${yymm}`);
  let counter = parseInt(firstNext.slice(`${cp}PI-${yymm}-`.length), 10) - 1;

  const invoiceDate = body.invoiceDate ?? todayMyt();
  const created: Array<{ id: string; invoiceNumber: string; supplierId: string; grnCount: number; lineCount: number }> = [];

  /* PI discount unification (audit 2026-06-11 M3) — ONE rule on every PI line
     write path: line_total_centi = qty × unit − discount, discount stored.
     The GRN line discount is pro-rated by billed qty over qty_accepted so a
     line billed across multiple PIs never subtracts more than the full GRN
     discount in total. (This path used to store the discount but exclude it
     from line_total + subtotal.) */
  const discFor = (row: ItemRow, qty: number) =>
    Math.round(Number(row.discount_centi ?? 0) * qty / (Number(row.qty_accepted) || 1));

  for (const bucket of buckets.values()) {
    counter += 1;
    // Audit (ported from 2990 b30f0bb1) — clamp each line before summing so a
    // discount > qty×price can't drive the PI subtotal negative.
    const subtotal = bucket.lines.reduce((s, { row, qty }) => s + Math.max(0, qty * row.unit_price_centi - discFor(row, qty)), 0);
    const piPayload = {
      company_id: activeCompanyId(c), // multi-company: stamp the active company
      supplier_invoice_ref: body.supplierInvoiceNumber ?? null,
      supplier_id: bucket.supplierId,
      purchase_order_id: bucket.purchaseOrderId,
      // PRIMARY note ref (see the multi-GRN note above) — the line-level
      // grn_item_id is the authoritative linkage.
      grn_id: bucket.grnIds[0]!,
      invoice_date: invoiceDate,
      due_date: body.dueDate ?? null,
      currency: bucket.currency,
      exchange_rate: bucket.exchangeRate,
      subtotal_centi: subtotal,
      tax_centi: 0,
      total_centi: subtotal,
      // Auto-post per Commander preference (matches GRN/PO behaviour).
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      notes: (() => {
        // Every note this PI bills, so the document says what it covers.
        const from = `Multi-pick from ${bucket.grnNumbers.join(', ')}`;
        return body.notes ? `${from} · ${body.notes}` : from;
      })(),
      created_by: user.id,
    };
    /* Audit (ported from 2990 b30f0bb1) — concurrent PI creation can collide on
       invoice_number (UNIQUE); the old `if (hErr) continue` silently dropped the
       PI (GRN left un-billed, no AP posting). Retry on 23505: re-derive the next
       free suffix from a fresh live count + bump. */
    let h: { id: string; invoice_number: string } | null = null;
    for (let attempt = 0; attempt < 8 && !h; attempt += 1) {
      const invoiceNumber = `${cp}PI-${yymm}-${String(counter).padStart(3, '0')}`;
      const { data: header, error: hErr } = await sb.from('purchase_invoices')
        .insert({ invoice_number: invoiceNumber, ...piPayload })
        .select('id, invoice_number').single();
      if (!hErr && header) { h = header as unknown as { id: string; invoice_number: string }; break; }
      if (!hErr || (hErr as { code?: string }).code !== '23505') break;
      const liveNext = await mintMonthlyDocNo(sb, 'purchase_invoices', 'invoice_number', `${cp}PI-${yymm}`);
      counter = parseInt(liveNext.slice(`${cp}PI-${yymm}-`.length), 10);
    }
    if (!h) continue;

    const rows = bucket.lines.map(({ row, qty }) => ({
      purchase_invoice_id: h.id,
      grn_item_id: row.id,
      material_kind: row.material_kind,
      material_code: row.material_code,
      material_name: row.material_name,
      qty,
      unit_price_centi: row.unit_price_centi,
      // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
      line_total_centi: Math.max(0, qty * row.unit_price_centi - discFor(row, qty)),
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
      discount_centi: discFor(row, qty),
    }));
    const { error: iErr } = await sb.from('purchase_invoice_items').insert(stampCompany(rows, c));
    if (iErr) {
      await sb.from('purchase_invoices').delete().eq('id', h.id);
      continue;
    }
    /* Post-insert over-invoice verification (race guard) — the per-pick pre-check
       above is read-before-write; re-sum live invoiced per GRN line now that this
       bucket's lines are committed. On overshoot, delete THIS PI (cascades its
       lines) and skip the bucket rather than over-bill the GRN line. */
    {
      const over = await verifyGrnLinesNotOverInvoiced(sb, bucket.lines.map(({ row }) => row.id));
      if (over.length > 0) {
        await sb.from('purchase_invoices').delete().eq('id', h.id);
        continue;
      }
    }
    /* This bucket's PI cleared both of its own rollbacks (the two `continue`s
       above), so it survives the request even if a LATER bucket is rolled back —
       each bucket is its own document and its own CREATE row. */
    await recordPiCreate(
      sb, c.get('houzsUser'), activeCompanyId(c), h.id, bucket.lines.length,
      `Converted from Goods Receipt ${bucket.grnNumbers.join(', ')}`,
    );
    // Consume the GRN lines: recount invoiced_qty from live PI lines.
    await recomputeGrnInvoiced(sb, bucket.lines.map(({ row }) => row.id));
    // Split any PI-native freight before the recost reads it. This path copies GRN
    // lines only, so a service line among them stays GRN-owned (already in the lot)
    // and the pool is 0 — kept for the invariant, not for an expected charge.
    await reallocatePiCharges(sb, h.id, undefined, activeCompanyId(c));
    // Costing B — push the billed price down to the lots / DO / SI of EVERY note
    // this PI bills (was: the single bucket GRN; a multi-note PI must re-cost
    // them all or the unbilled notes keep their GR price).
    for (const grnId of bucket.grnIds) await recostFromGrn(sb, grnId);
    created.push({
      id: h.id, invoiceNumber: h.invoice_number,
      supplierId: bucket.supplierId, grnCount: bucket.grnIds.length, lineCount: bucket.lines.length,
    });
  }

  return c.json({ created, total: created.length }, 201);
});

/* ── POST /from-grn ─────────────────────────────────────────────────────
   Single-GRN convert (GRN list right-click "Convert to PI"). Copies ALL of
   the GRN's accepted lines (with variants) into a new POSTED PI and returns
   the created PI's { id } so the caller can navigate straight to it. Mirrors
   from-grn-items but scoped to one whole GRN and returns a single id.

   Body: { grnId }  →  201 { id, invoiceNumber }. */
purchaseInvoices.post('/from-grn', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { grnId?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const grnId = body.grnId;
  if (!grnId) return c.json({ error: 'grn_id_required' }, 400);

  const { data: grn, error: grnErr } = await sb.from('grns')
    .select('id, grn_number, supplier_id, purchase_order_id, status, currency, exchange_rate')
    .eq('id', grnId).maybeSingle();
  if (grnErr) return c.json({ error: 'load_failed', reason: grnErr.message }, 500);
  if (!grn) return c.json({ error: 'grn_not_found' }, 404);
  const g = grn as { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string; currency?: string | null; exchange_rate?: string | number | null };
  if (g.status !== 'POSTED') return c.json({ error: 'grn_not_posted', status: g.status }, 409);

  const { data: items, error: iErr } = await sb.from('grn_items')
    .select('id, material_kind, material_code, material_name, item_group, description, description2, uom, qty_accepted, invoiced_qty, returned_qty, unit_price_centi, variants, gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, custom_specials, line_suffix, special_order_price_sen, discount_centi')
    .eq('grn_id', grnId)
    .gt('qty_accepted', 0);
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
  type GrnLine = {
    id: string; material_kind: string; material_code: string; material_name: string;
    item_group: string | null; description: string | null; description2: string | null;
    uom: string | null; qty_accepted: number; invoiced_qty: number; returned_qty: number; unit_price_centi: number; variants: unknown;
    gap_inches: number | null; divan_height_inches: number | null; divan_price_sen: number;
    leg_height_inches: number | null; leg_price_sen: number; custom_specials: unknown;
    line_suffix: string | null; special_order_price_sen: number; discount_centi: number;
  };
  // Only copy lines that still have remaining = qty_accepted - invoiced_qty -
  // returned_qty > 0, and bill the REMAINING qty (a GRN can be invoiced across
  // multiple PIs, 0106; returned-to-supplier qty is no longer invoiceable).
  const allLines = (items ?? []) as unknown as GrnLine[];
  const lines = allLines
    .map((it) => ({ ...it, _remaining: (it.qty_accepted ?? 0) - (it.invoiced_qty ?? 0) - (it.returned_qty ?? 0) }))
    .filter((it) => it._remaining > 0);
  if (lines.length === 0) return c.json({ error: 'nothing_to_invoice', message: 'GRN is fully invoiced' }, 400);

  /* PI discount unification (audit 2026-06-11 M3) — ONE rule on every PI line
     write path: line_total_centi = qty × unit − discount, discount stored.
     The GRN line discount is pro-rated by the billed (remaining) qty over
     qty_accepted so a second /from-grn pass over a partially-billed line
     can't subtract the full discount twice. */
  const discFor = (it: GrnLine & { _remaining: number }) =>
    Math.round(Number(it.discount_centi ?? 0) * it._remaining / (Number(it.qty_accepted) || 1));
  const subtotal = lines.reduce((s, it) => s + (it._remaining * it.unit_price_centi - discFor(it)), 0);

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; invoice_number: string }>(
    () => nextNum(sb, 'PI', c),
    (invoiceNumber) => sb.from('purchase_invoices').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    invoice_number: invoiceNumber,
    supplier_id: g.supplier_id,
    purchase_order_id: g.purchase_order_id,
    grn_id: g.id,
    invoice_date: todayMyt(),
    // Migration 0082 — inherit the source GRN's currency + rate (MYR ⇒ 1, no-op).
    currency: normalizeCurrency(g.currency),
    exchange_rate: normalizeExchangeRate(g.exchange_rate, normalizeCurrency(g.currency)),
    subtotal_centi: subtotal,
    tax_centi: 0,
    total_centi: subtotal,
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
    material_code: it.material_code,
    material_name: it.material_name,
    qty: it._remaining,
    unit_price_centi: it.unit_price_centi,
    // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
    line_total_centi: Math.max(0, it._remaining * it.unit_price_centi - discFor(it)),
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
    discount_centi: discFor(it),
  }));
  const { error: insErr } = await sb.from('purchase_invoice_items').insert(stampCompany(rows, c));
  if (insErr) { await sb.from('purchase_invoices').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: insErr.message }, 500); }

  /* Post-insert over-invoice verification (race guard) — the remaining filter
     above is read-before-write; re-sum live invoiced per GRN line now that this
     PI's lines are committed. On overshoot, delete THIS PI (cascades its lines)
     + 409. */
  {
    const over = await verifyGrnLinesNotOverInvoiced(sb, lines.map((it) => it.id));
    if (over.length > 0) {
      await sb.from('purchase_invoices').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', lines: over }, 409);
    }
  }

  // Refresh header subtotal/total from the inserted lines (parity with GRN/PR).
  await recomputePiTotals(sb, h.id);

  /* Past both compensating branches (items-insert rollback, over-invoice
     rollback) — the invoice is permanent from here. Written after
     recomputePiTotals so totalCenti is the rolled-up figure. */
  await recordPiCreate(
    sb, c.get('houzsUser'), activeCompanyId(c), h.id, rows.length,
    `Converted from Goods Receipt ${g.grn_number ?? g.id}`,
  );

  // Consume each GRN line: recount invoiced_qty from live PI lines.
  await recomputeGrnInvoiced(sb, lines.map((it) => it.id));

  // Split any PI-native freight before the recost reads it. This path copies GRN
  // lines only, so a copied service line stays GRN-owned (already capitalised into
  // the lot) and the pool is 0 — kept for the invariant, not for an expected charge.
  await reallocatePiCharges(sb, h.id, undefined, activeCompanyId(c));
  // Costing B — push the billed price down to the GRN's lots / DO / SI.
  await recostFromGrn(sb, g.id);

  return c.json({ id: h.id, invoiceNumber: h.invoice_number }, 201);
});

/* ════════════════════════════════════════════════════════════════════════
   PI PO-clone CRUD (PATCH header + line add / edit / delete) — mirrors the
   GRN detail page's confirmed/immediate-save editing (apps/api/src/routes/grns.ts).
   The editable line quantity is qty; line_total_centi =
   qty * unit_price_centi - discount_centi; recomputePiTotals rolls the header
   subtotal/total (PI keeps the stored tax in total, unlike GRN). PI is AP-only
   → line delete needs no inventory release (that landed at GRN time).
   ════════════════════════════════════════════════════════════════════════ */

/* ── PATCH /:id — header update (mirror GRN's PATCH /:id) ── */
purchaseInvoices.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  /* exchangeRate is in PI_AUDIT_FIELDS but NOT written here — it is derived from
     the currency below, so this loop skips it and the derived value is folded
     into the audit patch after. */
  for (const [from, to] of PI_AUDIT_FIELDS) {
    if (from === 'exchangeRate') continue;
    if (body[from] !== undefined) updates[to] = body[from];
  }
  // currency is normalised to upper-case like POST does.
  if (updates.currency !== undefined) updates.currency = normalizeCurrency(updates.currency);
  const sb = c.get('supabase');

  /* The BEFORE half of every from->to pair. Also supplies the invoice number and
     company for the audit row, which the update's RETURNING gives us only after
     the fact. */
  const { data: beforeRow } = await sb.from('purchase_invoices')
    .select(`${HEADER}, company_id`).eq('id', id).maybeSingle();
  const before = (beforeRow ?? {}) as unknown as Record<string, unknown>;
  /* R2 EDIT-PATH GUARD (2026-07-30) — the sibling of the GRN PATCH guard. Flipping
     this invoice to a foreign currency with no rate anywhere leaves exchange_rate at
     the 1 it holds from having been ringgit, and recostFromGrn then folds the raw
     foreign price into every lot this invoice bills. Fires ONLY on a real flip to a
     non-MYR code; an all-MYR invoice and any edit that does not touch the currency
     are unaffected. */
  {
    const rateGuard = await assertForeignRatePatchable(sb, {
      fromCurrency: before.currency,
      toCurrency: updates.currency,
      operatorRate: body.exchangeRate,
      docLabel: 'purchase invoice',
    });
    if (!rateGuard.ok) return c.json(rateGuard.body, 422);
  }
  /* Migration 0082 — keep exchange_rate consistent with the effective currency
     (rate explicitly sent → normalise against it; currency flipped to MYR without
     a rate → reset to 1; else untouched). MYR ⇒ 1, a no-op. */
  let piRateChanged = false;
  if (body.exchangeRate !== undefined || updates.currency !== undefined) {
    let effectiveCurrency = updates.currency as string | undefined;
    if (effectiveCurrency === undefined) {
      /* Taken from the row already read above — the second round-trip this used
         to make read the same column of the same row. */
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
  const { data, error } = await sb.from('purchase_invoices').update(updates).eq('id', id).select(HEADER).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  /* Diff the NORMALISED values actually written, not the raw body: currency is
     upper-cased and exchange_rate is derived from it, so logging what the client
     sent would log a value that was never stored. */
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

  /* A rate change moves the MYR AP amount posted to the GL. If the PI is posted,
     re-align its JE (void stale + re-post at the new MYR total) + recost its lots
     (the PI drives the authoritative MYR lot cost). Best-effort; no-op for MYR. */
  if (piRateChanged) {
    const inv = (data as { invoice_number?: string } | null)?.invoice_number;
    if (inv) {
      try { await resyncPiAccounting(sb, inv); } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-patch] resync failed:', inv, e); }
    }
    // The freight pool is converted at the PI's rate, so a rate change re-splits it.
    await reallocatePiCharges(sb, id, undefined, activeCompanyId(c));
    try { await recostForPi(sb, id); } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-patch] recost failed:', id, e); }
  }
  return c.json({ purchaseInvoice: data });
});

/* ── POST /:id/items — add one purchase_invoice_item. qty maps to qty. ── */
purchaseInvoices.post('/:id/items', async (c) => {
  const piId = c.req.param('id');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.materialCode) return c.json({ error: 'material_code_required' }, 400);
  if (!it.materialName) return c.json({ error: 'material_name_required' }, 400);

  const sb = c.get('supabase');
  // PI edit-lock: a paid / cancelled PI is read-only.
  const lock = await piLocked(sb, piId);
  if (lock) return c.json(lock, 409);

  const qty = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const discountCenti = Number(it.discountCenti ?? 0);
  // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unitPriceCenti) - discountCenti);

  // GRN-linked line: cap qty at that GRN line's remaining
  // (accepted - invoiced - returned).
  const grnItemId = (it.grnItemId as string) ?? null;
  if (grnItemId) {
    const { data: gi } = await sb.from('grn_items')
      .select('qty_accepted, invoiced_qty, returned_qty').eq('id', grnItemId).maybeSingle();
    if (gi) {
      const g = gi as { qty_accepted: number; invoiced_qty: number; returned_qty: number };
      const remaining = (g.qty_accepted ?? 0) - (g.invoiced_qty ?? 0) - (g.returned_qty ?? 0);
      if (qty > remaining) return c.json({ error: 'qty_exceeds_remaining', requested: qty, remaining }, 409);
    }
  }

  const row: Record<string, unknown> = {
    purchase_invoice_id: piId,
    grn_item_id: (it.grnItemId as string) ?? null,
    material_kind: (it.materialKind as string) ?? 'mfg_product',
    material_code: it.materialCode,
    material_name: it.materialName,
    qty,
    unit_price_centi: unitPriceCenti,
    discount_centi: discountCenti,
    line_total_centi: lineTotal,
    unit_cost_centi: Number(it.unitCostCenti ?? 0),
    notes: (it.notes as string) ?? null,
    /* variant fields (mirror GRN/PO line) */
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
  const { data, error } = await sb.from('purchase_invoice_items').insert({ ...row, company_id: activeCompanyId(c) }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  /* Bug #3/#11 — POST-INSERT over-invoice verification. The pre-check is a
     read-then-write race: two concurrent adds against the same GRN line can each
     read remaining and both insert → over-billed. After committing, re-read the
     GRN line's accepted/returned + the LIVE sum of qty across all non-cancelled
     PI lines for it; if invoiced now exceeds (accepted - returned), OUR insert
     broke the cap → delete it + 409. (Fully DB-atomic needs an RPC — see report.) */
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

  /* UPDATE, not CREATE: the entity is the PURCHASE INVOICE and it already
     existed. Recorded after the over-invoice rollback above, so a line that was
     inserted and then deleted by the race guard leaves no "added" row. */
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
      note: `Line added: ${String(it.materialCode ?? '')}`,
      fieldChanges: compactChanges(
        PI_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, null, added[snake] ?? null)),
      ),
    });
  }

  // Consume the GRN line if this PI line is GRN-linked (manual lines consume
  // nothing). Recount invoiced_qty from live PI lines.
  if (grnItemId) await recomputeGrnInvoiced(sb, [grnItemId]);
  await recomputePiTotals(sb, piId);
  // The goods basis just changed, so the freight split must be re-derived before
  // the recost reads it (QTY — no column persists the create-time basis).
  await reallocatePiCharges(sb, piId, undefined, activeCompanyId(c));
  // Costing B — a newly added PI line bills a GRN line: re-cost its lots / DO / SI.
  await recostForPi(sb, piId);
  return c.json({ item: data }, 201);
});

/* ── PATCH /:id/items/:itemId — partial line update. ── */
purchaseInvoices.patch('/:id/items/:itemId', async (c) => {
  const piId = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');

  // PI edit-lock: a paid / cancelled PI is read-only.
  const lock = await piLocked(sb, piId);
  if (lock) return c.json(lock, 409);

  /* Audit 2026-06-11 M10 — scope the line to THIS PI: a mismatched itemId
     must 404, not edit another PI's line while the recompute / recost / GL
     resync run against this one. */
  /* The audited columns as well as the ones the money logic reads: this row is
     also the BEFORE half of every from->to pair recorded after the update lands.
     `variants` and `grn_item_id` are business-logic only and deliberately not in
     PI_LINE_AUDIT_FIELDS — variants render into description2, which is
     server-owned and derived, not an operator edit. */
  const { data: prevRow } = await sb.from('purchase_invoice_items')
    .select(PI_LINE_AUDIT_SELECT + ', variants, grn_item_id')
    .eq('id', itemId).eq('purchase_invoice_id', piId).maybeSingle();
  if (!prevRow) return c.json({ error: 'not_found' }, 404);
  /* Cast through `unknown`: a .select() built from a concatenated string infers
     as GenericStringError on the SupabaseClient<any> the scm client is, so the
     row shape only exists after this. Project-wide pattern in these routes. */
  const prev = prevRow as unknown as Record<string, unknown>;

  const prevQty = Number(prev.qty);
  const grnItemId = (prev.grn_item_id as string | null) ?? null;
  const qty = it.qty !== undefined ? Number(it.qty) : prevQty;
  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unit_price_centi);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discount_centi ?? 0);
  /* PI discount unification (audit 2026-06-11 M3) — this IS the canonical rule
     (line_total_centi = qty × unit − discount, discount stored); all four
     create paths now write the same way, so an edit no longer shifts a line's
     total by a stored-but-previously-unapplied discount. */
  // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unit) - discount);

  const updates: Record<string, unknown> = {
    qty,
    unit_price_centi: unit,
    discount_centi: discount,
    line_total_centi: lineTotal,
  };
  for (const [from, to] of [
    ['materialCode', 'material_code'], ['materialName', 'material_name'],
    ['itemGroup', 'item_group'], ['description', 'description'], ['uom', 'uom'],
    ['unitCostCenti', 'unit_cost_centi'], ['notes', 'notes'],
    ['gapInches', 'gap_inches'], ['divanHeightInches', 'divan_height_inches'],
    ['divanPriceSen', 'divan_price_sen'], ['legHeightInches', 'leg_height_inches'],
    ['legPriceSen', 'leg_price_sen'], ['customSpecials', 'custom_specials'],
    ['lineSuffix', 'line_suffix'], ['specialOrderPriceSen', 'special_order_price_sen'],
    ['variants', 'variants'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* description2 is server-owned: recompute from effective itemGroup + variants. */
  {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  // GRN-linked + qty changed: pre-check the delta won't push the GRN line over
  // its accepted (remaining excluding THIS line's existing draw must cover the
  // new qty). delta = qty - prevQty.
  const delta = qty - prevQty;
  if (grnItemId && delta !== 0) {
    const { data: gi } = await sb.from('grn_items')
      .select('qty_accepted, invoiced_qty, returned_qty').eq('id', grnItemId).maybeSingle();
    if (gi) {
      const accepted = (gi as { qty_accepted: number }).qty_accepted ?? 0;
      const invoiced = (gi as { invoiced_qty: number }).invoiced_qty ?? 0;
      const returned = (gi as { returned_qty: number }).returned_qty ?? 0;
      // remaining headroom for THIS line = accepted - returned - (invoiced - prevQty).
      const headroom = accepted - returned - (invoiced - prevQty);
      if (qty > headroom) return c.json({ error: 'qty_exceeds_remaining', requested: qty, remaining: headroom }, 409);
    }
  }

  const { error } = await sb.from('purchase_invoice_items').update(updates).eq('id', itemId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  /* Diff `updates` — the EFFECTIVE values written — against the stored row. qty,
     price, discount and the line total are recomputed above from the body OR the
     prior row, so the body alone would not say what was actually stored. */
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
        note: `Line edited: ${String(prev.material_code ?? itemId)}`,
        fieldChanges: lineChanges,
      });
    }
  }

  // Recount the source GRN line's invoiced_qty from live PI lines (clamps to
  // [0, qty_accepted]).
  if (grnItemId) await recomputeGrnInvoiced(sb, [grnItemId]);
  await recomputePiTotals(sb, piId);
  // The goods basis (or the freight line itself) may have changed — re-derive the
  // split before the recost reads it (QTY; the create-time basis isn't persisted).
  await reallocatePiCharges(sb, piId, undefined, activeCompanyId(c));
  // Costing B — a PI price EDIT (incl. human-error correction) re-costs the
  // GRN's lots and cascades to every shipped DO + Sales Invoice in real time.
  await recostForPi(sb, piId);
  /* If this PI was already posted to the accounts, its total just changed — void
     the stale entry + re-post at the new amount. No-op when never posted (PI
     posts to the GL only on demand). Best-effort. */
  try {
    const { data: h } = await sb.from('purchase_invoices').select('invoice_number').eq('id', piId).maybeSingle();
    if (h) await resyncPiAccounting(sb, (h as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-accounting] post-line-edit resync failed:', e); }
  return c.json({ ok: true });
});

/* ── DELETE /:id/items/:itemId — remove a line + recompute header. ── */
purchaseInvoices.delete('/:id/items/:itemId', async (c) => {
  const piId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  // PI edit-lock: a paid / cancelled PI is read-only.
  const lock = await piLocked(sb, piId);
  if (lock) return c.json(lock, 409);

  // Read the line first so we can release its GRN-line consumption on delete.
  // Audit 2026-06-11 M10 — scoped to THIS PI: a mismatched itemId must 404,
  // not delete another PI's line while the recompute / GL resync run here.
  /* The audited columns too — after the delete the audit row is the only
     remaining evidence of what the supplier billed on this line. */
  const { data: lineRow } = await sb.from('purchase_invoice_items')
    .select(PI_LINE_AUDIT_SELECT + ', grn_item_id').eq('id', itemId).eq('purchase_invoice_id', piId).maybeSingle();
  if (!lineRow) return c.json({ error: 'not_found' }, 404);
  /* Cast through `unknown` — see the note on the line PATCH's `prev`. */
  const line = lineRow as unknown as Record<string, unknown>;

  const { error } = await sb.from('purchase_invoice_items').delete().eq('id', itemId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  /* UPDATE, not DELETE: the entity is the PURCHASE INVOICE and it still exists.
     DELETE on this entity type would tell a reader the whole invoice was
     destroyed — and this module never hard-deletes one. */
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
      note: `Line removed: ${String(line.material_code ?? itemId)}`,
      fieldChanges: compactChanges(
        PI_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, line[snake] ?? null, null)),
      ),
    });
  }

  {
    const l = { qty: Number(line.qty), grn_item_id: (line.grn_item_id as string | null) ?? null };
    // Release: recount invoiced_qty from live PI lines — the deleted line drops out.
    if (l.grn_item_id) await recomputeGrnInvoiced(sb, [l.grn_item_id]);
    // Re-derive the freight split first: the deleted row may BE the freight line,
    // or may have been part of the basis it was spread over.
    await reallocatePiCharges(sb, piId, undefined, activeCompanyId(c));
    // Costing B — removing a PI line drops its authoritative price; re-cost the
    // GRN so the bucket falls back to the GR price (or Pending) and DOs/SIs follow.
    if (l.grn_item_id) {
      const { data: gi } = await sb.from('grn_items').select('grn_id').eq('id', l.grn_item_id).maybeSingle();
      const gid = (gi as { grn_id: string | null } | null)?.grn_id ?? null;
      if (gid) await recostFromGrn(sb, gid);
    }
    /* Deleting a PI-NATIVE freight line carries no grn_item_id, so the branch above
       wouldn't recost anything and the freight it used to fund would stay welded to
       every lot this PI bills. Recost the PI's remaining GRNs too — idempotent, so
       it's a no-op when the line above already settled them. */
    await recostForPi(sb, piId);
  }
  await recomputePiTotals(sb, piId);
  /* Deleting a line lowers the PI total — if it was posted to the accounts, void
     the stale entry + re-post (or void to nothing if it was the last line). No-op
     when never posted. Best-effort. */
  try {
    const { data: h } = await sb.from('purchase_invoices').select('invoice_number').eq('id', piId).maybeSingle();
    if (h) await resyncPiAccounting(sb, (h as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-accounting] post-line-delete resync failed:', e); }
  return c.body(null, 204);
});
