// ----------------------------------------------------------------------------
// SO amendment apply-revision helpers — port of 2990 apps/api/src/lib/so-revision.ts.
//
// company-scope-file: every write in this file addresses rows by `doc_no`, which IS
// mfg_sales_orders' PRIMARY KEY (2990s-full-schema.sql:638) and whose numbering
// is prefix-partitioned per company (companyDocPrefix: HOUZS 'HC-', others
// '<CODE>-'). One doc_no therefore names exactly one company's order, and the
// mfg_sales_order_items rows are reached through that same doc_no. A company
// predicate would be redundant here, not safer. Read 2026-08-13 when the
// library pass of check-company-scope.mjs first surfaced these five statements.
//
// `applySoAmendment` is the Approve-SO gate's engine: it freezes the current SO
// as an immutable `so_revisions` snapshot, applies the amendment's line diffs
// (SPEC / QTY / ADD / REMOVE) to `mfg_sales_order_items`, then RE-RUNS the
// server-side honest-pricing recompute on every surviving line — the SAME pricing
// path POST /mfg-sales-orders uses (never skip / never reinvent the recompute).
//
// Pricing reuse — how this mirrors POST /mfg-sales-orders:
//   • Per line: `recomputeOneLine(sb, item, cachedConfig)` (mfg-pricing-recompute).
//     Loads product + fabric + MaintenanceConfig + sofa module prices + selling
//     tiers + fabric-tier config + per-Model / per-compartment Δ overrides, then
//     calls the pure recompute → computeMfgLinePrice / computeMfgLineCost. Persists
//     the same columns the create path writes (unit/total/cost/margin + divan/leg/
//     special/custom breakdown).
//   • Delivery fee + header totals: `rederiveDeliveryFee(sb, docNo)`
//     (mfg-sales-orders.ts) — re-runs computeSoDeliveryFee over the SO's CURRENT
//     items (rebuilding SVC-DELIVERY* lines) and folds recomputeTotals.
//
// Houzs adaptations vs 2990 (Houzs SCM is a vendored 2990 clone):
//   • The per-line delivery date column on mfg_sales_order_items is
//     `line_delivery_date` in Houzs (2990's column was `delivery_date`). The bound
//     PO line's own delivery date column stays `delivery_date`.
//   • Imports are Houzs-relative ('../shared', './mfg-pricing-recompute', …).
//   • Audit rows route through recordSoAudit (which resolves the NOT-NULL
//     mfg_so_audit_log.company_id from the SO) — never a raw audit insert.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import { buildVariantSummary, receivedFloorViolation } from '../shared';
import { canonicalizeVariants } from '../shared/so-variant-rule';
import {
  loadMaintenanceConfig,
  recomputeOneLine,
  type MfgItemForRecompute,
  type TrustSelling,
} from './mfg-pricing-recompute';
import { recordSoAudit, type FieldChange } from './so-audit';
import { skuCategoryResolver } from './sku-category';
import { retiredLineOf, type AcRetiredLine } from './autocount-outbox';
import { deriveMfgPoUnitCost } from './po-pricing';
import { pickAddLineBinding, readMfgProductBindings } from './supplier-bindings';
import { rederivePoLineFromSoLine, type RevisedSoLine } from './po-line-rederive';
import {
  rederiveDeliveryFee,
  deriveCountryFromState,
  deriveSalesLocationFromState,
  deriveWarehouseIdFromState,
} from '../routes/mfg-sales-orders';
import { activeCompanyId, isMirroredDocNo, houzsOwns2990 } from './companyScope';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { mytDateOf, todayMyt } from './my-time';
import { lineEditCostKind, qtyChangeLineCostSen } from './so-line-cost-edit';
import { amendmentSubmissionKey, closeChangeWindow, isLaterChange, openChangeWindow, type ChangeWindow, type OrderDays } from './so-product-change-record';
import { costChangedSofaSets, sofaModelOf } from './so-set-change-cost';
import { dateOrNull } from './date-coerce';
import { exemptionExpirySeed } from './so-exemption-expiry';
import { soWarehouseIdForDoc } from './so-warehouse';
import { variantsForCompare } from './amendment-noop-lines';
import { inPoLineOrder, nextPoLineNo, sortBySourceSoLine } from './po-line-order';
import {
  LEAD_OVERRIDE_SELECT, LEAD_TIME_SELECT, NO_BUFFERS, loadLeadTimeBase, loadSupplierCategoryOverrides,
  resolveLeadDays, subtractCalendarDays, type LeadBuffers, type LeadOverrides, type LeadTimeBase,
} from './lead-time';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import { soIsMigratedShape } from './so-is-migrated';
import { routingNote, type AmendmentFieldKind } from '../shared/amendment-routing';
import { soAmendableHeaderFields } from '../shared/so-field-policy';
import { canonicaliseSoHeaderChanges, soDateYmd, withProcessingRemovalCascade } from '../shared/so-processing-date';
import { soStatusAfterProcessingDateChange } from './so-proceed-status-change';
import { syncSoDeliveredFromDo } from './so-delivery-sync';
import { restampHeaderBranding } from './derive-line-branding';
import { readSoLineFreeze, soLineWriteRefusal } from './downstream-lock';
import { isPoLineOverReceived } from './qty-cap';
import { SO_IDENTITY_LOCK_COLS } from '../shared/so-identity-lock';

function soAmendmentFieldKinds(
  lines: Array<{ change_type: string; new_item_code: string | null; new_variants: Record<string, unknown> | null; new_qty: number | null; new_unit_price_sen: number | null; old_snapshot: Record<string, unknown> | null }>,
  headerChanges: Record<string, unknown> | null,
): AmendmentFieldKind[] {
  const kinds: AmendmentFieldKind[] = [];
  for (const l of lines) {
    const change = String(l.change_type ?? '').toUpperCase();
    if (change === 'ADD' || change === 'REMOVE') { kinds.push('LINE'); continue; }
    const old = l.old_snapshot ?? {};
    if (l.new_item_code != null && String(l.new_item_code) !== String(old.item_code ?? old.itemCode ?? '')) kinds.push('SPEC');
    if (l.new_variants != null && variantsForCompare(l.new_variants) !== variantsForCompare(old.variants ?? null)) kinds.push('VARIANT');
    if (l.new_qty != null && Number(l.new_qty) !== Number(old.qty ?? NaN)) kinds.push('QTY');
    if (l.new_unit_price_sen != null && Number(l.new_unit_price_sen) !== Number(old.unit_price_sen ?? old.unitPriceSen ?? NaN)) kinds.push('PRICE');
  }
  if (headerChanges) {
    for (const key of Object.keys(headerChanges)) {
      if (key === 'notes') continue;
      kinds.push('DELIVERY');
    }
  }
  return kinds;
}

type Sb = any;

function realActorName(c?: Context<any>): string | null {
  if (!c) return null;
  const houzs = c.get('houzsUser') as { name?: string | null } | undefined;
  if (houzs?.name) return houzs.name;
  const user = c.get('user') as { user_metadata?: { name?: string } } | undefined;
  return user?.user_metadata?.name ?? null;
}

type AmendmentRow = {
  id: string;
  so_doc_no: string;
  status: string;
  amendment_no?: string | null;
  requested_by?: string | null;
  reason?: string | null;
  created_at?: string | null;
  header_changes?: Record<string, string | null> | null;
};

function assertNotMirrored(docNo: string, fn: string, c?: Context<any>): void {
  if (isMirroredDocNo(docNo) && !houzsOwns2990(c?.env)) {
    throw new Error(`${fn}: ${docNo} belongs to 2990 and cannot be revised from Houzs`);
  }
}

/* The frozen header columns an amendment may carry, keyed by the camelCase
   payload name -> column. Sourced from the SAME policy table the create route
   validates against (shared/so-field-policy.ts CONTROLLED rows) — NOT a local
   copy. The previous hand-maintained 4-key copy here claimed to "mirror" the
   create-time list and silently drifted when the two-lane rework made
   city / address1-4 / shipTo / billTo / installTo / replacementDisposal
   CONTROLLED (#1346/#1349): the create route accepted those keys, the apply
   loop's hasOwnProperty check skipped them, and an APPROVED amendment landed
   with only part of its changes (owner-reported 2026-07-29, 2990-SO-2606-049/A1
   — State + Postcode applied, City silently dropped). Deriving from the policy
   table keeps this the LAST gate before the write (unknown keys still skipped)
   while making create-vs-apply drift structurally impossible. */
const AMENDABLE_HEADER_FIELDS: Record<string, string> = soAmendableHeaderFields();

type AmendmentLineRow = {
  id: string;
  sales_order_item_id: string | null;
  change_type: string;
  new_item_code: string | null;
  new_variants: Record<string, unknown> | null;
  new_qty: number | null;
  new_unit_price_sen: number | null;
  /* HC-0095 — the operator TYPED the requested 0. False on every row before the
     column, so a queued seeded 0 cannot zero a priced line on approval. */
  zero_price_intended: boolean | null;
  new_remark: string | null;
  new_discount_sen: number | null;
  old_snapshot: Record<string, unknown> | null;
};

export async function snapshotSo(
  sb: Sb,
  docNo: string,
  amendmentId?: string | null,
  userId?: string | null,
  c?: Context<any>,
): Promise<number> {
  const { data: header, error: hErr } = await sb
    .from('mfg_sales_orders')
    .select('*')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (hErr) throw new Error(`snapshotSo: header load failed: ${hErr.message}`);
  if (!header) throw new Error(`snapshotSo: SO ${docNo} not found`);

  const currentRevision =
    typeof (header as { revision?: unknown }).revision === 'number'
      ? (header as { revision: number }).revision
      : 1;

  const { data: lines, error: lErr } = await sb
    .from('mfg_sales_order_items')
    .select('*')
    .eq('doc_no', docNo)
    .order('line_no', { ascending: true, nullsFirst: true });
  if (lErr) throw new Error(`snapshotSo: lines load failed: ${lErr.message}`);

  const lineIds = ((lines ?? []) as Array<{ id: string }>).map((r) => r.id);
  const poLinks: Record<string, string[]> = {};
  if (lineIds.length > 0) {
    const { data: poLinkRows, error: poLinkErr } = await sb
      .from('purchase_order_items')
      .select('id, so_item_id')
      .in('so_item_id', lineIds);
    if (poLinkErr) throw new Error(`snapshotSo: PO linkage load failed: ${poLinkErr.message}`);
    for (const r of (poLinkRows ?? []) as Array<{ id: string; so_item_id: string | null }>) {
      if (!r.so_item_id) continue;
      (poLinks[r.so_item_id] ??= []).push(r.id);
    }
  }

  const snapshot = {
    header,
    lines: lines ?? [],
    poLinks,
    snapshotAt: new Date().toISOString(),
  };

  const { error: insErr } = await sb
    .from('so_revisions')
    .upsert(
      {
        so_doc_no:    docNo,
        revision:     currentRevision,
        snapshot,
        amendment_id: amendmentId ?? null,
        created_by:   userId ?? null,
        company_id:   c ? activeCompanyId(c) : undefined,
      },
      { onConflict: 'so_doc_no,revision', ignoreDuplicates: true },
    );
  if (insErr) throw new Error(`snapshotSo: revision insert failed: ${insErr.message}`);

  return currentRevision + 1;
}

export type SoAmendmentApproval = {
  approvedByUserId: string;
  approvalPermission: string;
};

export async function applySoAmendment(
  sb: Sb,
  amendmentId: string,
  userId: string | null,
  c: Context<any> | undefined,
  concurrency: { soVersion: number; leaseToken: string } | null,
  approval: SoAmendmentApproval | null,
): Promise<{ soDocNo: string; revision: number; addedLineIds: string[] }> {
  const { data: amdRow, error: amdErr } = await sb
    .from('so_amendments')
    .select('id, so_doc_no, status, header_changes, amendment_no, requested_by, reason, created_at')
    .eq('id', amendmentId)
    .maybeSingle();
  if (amdErr) throw new Error(`applySoAmendment: amendment load failed: ${amdErr.message}`);
  if (!amdRow) throw new Error('applySoAmendment: amendment not found');
  const amendment = amdRow as AmendmentRow;
  const docNo = amendment.so_doc_no;
  assertNotMirrored(docNo, 'applySoAmendment', c);

  const { data: lineRows, error: lineErr } = await sb
    .from('so_amendment_lines')
    .select('id, sales_order_item_id, change_type, new_item_code, new_variants, ' +
      'new_qty, new_unit_price_sen, zero_price_intended, new_remark, new_discount_sen, old_snapshot')
    .eq('amendment_id', amendmentId);
  if (lineErr) throw new Error(`applySoAmendment: amendment lines load failed: ${lineErr.message}`);
  const amendmentLines = (lineRows ?? []) as AmendmentLineRow[];

  /* (1b) FROZEN LINES (owner 2026-09-15, shared/so-line-freeze.ts). A line a live
     Delivery Order / Sales Invoice carries cannot be changed or removed — and a
     delivery order raised between SUBMIT and APPROVE freezes it just the same,
     so the verdict is re-read here, before anything is written. The same read
     keeps the header cascades below off the frozen lines. */
  const freezeRead = await readSoLineFreeze(sb, docNo);
  const frozenRefusal = soLineWriteRefusal(freezeRead, amendmentLines
    .filter((l) => String(l.change_type).toUpperCase() !== 'ADD' && l.sales_order_item_id)
    .map((l) => String(l.sales_order_item_id)));
  if (frozenRefusal) throw new Error(frozenRefusal.message);
  if (freezeRead.ok && freezeRead.freeze.hasLiveDownstream) {
    const lockedCols = Object.keys(canonicaliseSoHeaderChanges(amendment.header_changes ?? null) ?? {})
      .map((k) => AMENDABLE_HEADER_FIELDS[k]).filter((col) => col && SO_IDENTITY_LOCK_COLS.has(col));
    if (lockedCols.length > 0) {
      throw new Error(`This Sales Order now has a Delivery Order / Sales Invoice, so customer, address and contact changes can no longer be applied (${lockedCols.join(', ')}).`);
    }
  }
  const frozenLineFilter: string | null = !freezeRead.ok || freezeRead.freeze.unlinked
    ? null
    : `(${[...freezeRead.freeze.frozenLineIds].map((id) => `"${id}"`).join(',')})`;
  const skipFrozen = <Q extends { not: (col: string, op: string, v: string) => Q }>(q: Q): Q =>
    frozenLineFilter && frozenLineFilter !== '()' ? q.not('id', 'in', frozenLineFilter) : q;

  const nextRevision = await snapshotSo(sb, docNo, amendmentId, userId, c);

  const { data: soHdrCo, error: soHdrCoErr } = await sb.from('mfg_sales_orders')
    .select('company_id, linked_ac_docno, so_date, created_at, status, processing_date, customer_delivery_date, sales_exemption_expiry').eq('doc_no', docNo).maybeSingle();
  if (soHdrCoErr) throw new Error(`applySoAmendment: SO company load failed: ${soHdrCoErr.message}`);
  const soCompanyId = (soHdrCo as { company_id?: number | null } | null)?.company_id ?? null;
  const soAsOf = (soHdrCo as { so_date?: string | null } | null)?.so_date ?? null;
  /* Rule 2 (owner 2026-11-23): approved after the order's opening day, a PRODUCT
     change is costed on the day it is approved (the change day), unchanged lines
     keep the order-date cost, and the change goes on Finance's record. On the
     opening day every line is priced as before. */
  const changeDay = todayMyt();
  const hdrCreatedAt = (soHdrCo as { created_at?: string | null } | null)?.created_at ?? null;
  const hdrDays: OrderDays | null = hdrCreatedAt
    ? {
      openingDay: mytDateOf(hdrCreatedAt),
      orderDay: soAsOf && /^\d{4}-\d{2}-\d{2}/.test(soAsOf) ? soAsOf.slice(0, 10) : mytDateOf(hdrCreatedAt),
      status: String((soHdrCo as { status?: string | null } | null)?.status ?? ''),
    }
    : null;
  const ruleTwo: OrderDays | null = soCompanyId != null && isLaterChange(hdrDays, changeDay) ? hdrDays : null;
  const changeWindow: ChangeWindow | null = ruleTwo && soCompanyId != null && amendmentLines.length > 0
    ? { companyId: soCompanyId, docNo, route: 'AMENDMENT', windowKey: await amendmentSubmissionKey(sb, amendment) }
    : null;
  const changeWindowId = changeWindow ? await openChangeWindow(sb, changeWindow, changeDay) : null;
  const ruleTwoModels = new Set<string>();
  const ruleTwoLineIds: string[] = [];

  /* THE PAIR, through the one home. `linked_ac_docno IS NOT NULL` was the test
     here too, and it is equally wrong here: the write-back stamps that column on
     an order the ERP priced itself, which would then be trusted as "the BOOK's
     negotiated price" and stop being re-priced. docs/bugs/0703. */
  const soIsMigrated = soIsMigratedShape(
    docNo,
    (soHdrCo as { linked_ac_docno?: string | null } | null)?.linked_ac_docno ?? null,
  );

  /* THE AMENDMENT HAS TO BE ABLE TO CARRY THE MONEY (owner, 2026-08-16): "Any
     amount can be edited, unless it is locked. If it has proceeded and a day has
     passed so it locked, then it goes through Sales Amendment."

     Until this line, it could not. The trust above was `false` for every NATIVE
     order, so the recompute's operator-price overwrite never ran and
     `unitToPersistSen` kept the CATALOGUE figure assigned a few lines earlier in
     mfg-pricing-recompute. An operator typed RM 50, an approver holding
     scm.amendment.approve_* signed RM 50, and mfg_products.sell_price_sen landed
     on the order — for every SKU that has a catalogue price. The sanctioned road
     for changing money on a locked SO was the one road that could not.

     WHY THIS IS NOT "widen the trust flag". trustOperatorSelling exists so a
     CLIENT cannot author a price, and that concern is real here: the submit
     route writes new_unit_price_sen straight from the browser, validates nothing,
     and admits any Sales-org user. What has changed is not the payload's
     standing — it is that this apply now knows whether a human with approval
     authority signed it. The trust is read from `approval`, which only the
     approve-so gate constructs and only after checking the lane permission and
     the status transition; with `approval === null` the requested price is not
     even read (see `clientUnit` below) and the catalogue behaviour is unchanged.

     The ceiling is deliberate: an approved amendment now grants exactly the
     authority the operator would have had on the SAME order before it locked —
     the direct SO write path already passes `trustOperatorSelling =
     !(isPosTabletCaller)` (mfg-sales-orders.ts) — and not one unit more.
     Never 'including-zero' on a native order: that flag ALSO suppresses the
     selling surcharges and is a statement about a price AutoCount already
     recorded, which is not what an operator authoring now is doing.

     2026-08-19 — 'operator-zero', not plain `true`, and the reason is that the
     unlocked road MOVED. This line read `(approval !== null)` from 2026-08-16,
     and the sentence above it — "exactly the authority the operator would have
     had on the SAME order before it locked" — was true when written, because on
     that date NOBODY could author RM 0 anywhere: plain `true` reads a 0 as "not
     provided" and hands back the catalogue figure. #2425 (2026-08-18) then gave
     the UNLOCKED road exactly that power via 'operator-zero'. From that moment
     the two roads disagreed on one value, so the stated invariant was broken by
     the newer change, not by this code — an approver holding
     scm.amendment.approve_* could sign RM 0 and the catalogue price landed,
     silently, the same shape as the RM 50 defect this whole path was written to
     close.

     'operator-zero' is the SANCTIONED mode for an authored zero (see the
     docblock in mfg-pricing-recompute). On the unlocked road the ERP line editor
     states the operator typed it (`zeroPriceIntended`); here the statement is
     stronger — a human holding the approve permission signed the diff, and
     `clientUnit` below already refuses to read the requested price at all
     without one. So the ceiling is unchanged in kind: still exactly the unlocked
     road's authority, now including the one value it gained.

     It also closes a second hole of the same shape. The editor sends
     `newUnitPriceSen` on EVERY changed line, not only when the price moved (see
     the QTY-only test), so approving a pure QUANTITY change on a line that sits
     at 0 — a free gift, a PWP reward — used to hand it the catalogue price and
     bill the customer for something given away. That is the RM 80 → RM 100
     defect the QTY-only test pins, at the one value the test did not cover. */
  const amendTrust: TrustSelling = soIsMigrated
    ? 'including-zero'
    : (approval !== null ? 'operator-zero' : false);

  const addLineTrust: TrustSelling = approval !== null;

  const cachedConfig = await loadMaintenanceConfig(sb, soCompanyId);

  const touched: Array<{ change: string; itemCode: string; qty: number }> = [];
  /* Row ids of the lines this apply INSERTED (an ADD diff). They carry no
     AutoCount DtlKey yet, so the write-back edit queued after this must declare
     them NEW — otherwise composeEdit refuses the whole document as keyless and
     the amendment never reaches the account book (docs/bugs/0942). */
  const addedLineIds: string[] = [];

  /* Per-field from -> to for the SO's OWN audit trail (Owner 2026-07-19: every
     edit anywhere in the system must show who, when, and what changed from ->
     to, reachable from the document's own page).

     Until now approving an amendment recorded only "lines_applied: 3" and a
     coarse note like "SPEC SF-100; QTY SF-200" — no old value for anything. The
     before values existed, but only inside so_amendment_lines.old_snapshot,
     which the audit drawer does not read. So the one moment the SO's lines are
     rewritten by somebody other than their owner was the one moment the trail
     could not say what they had been. */
  const groupOf = await skuCategoryResolver(
    sb,
    amendmentLines.filter((d) => d.new_item_code).map((d) => ({ materialKind: 'mfg_product', itemCode: d.new_item_code })),
    soCompanyId,
  );
  const lineChanges: FieldChange[] = [];
  const noteChange =(field: string, from: unknown, to: unknown) => {
    if (String(from ?? '') === String(to ?? '')) return;
    lineChanges.push({ field, from: from ?? null, to: to ?? null });
  };

  for (const diff of amendmentLines) {
    const change = String(diff.change_type ?? '').toUpperCase();

    if (change === 'REMOVE') {
      if (!diff.sales_order_item_id) continue;
      const { error: delErr } = await sb
        .from('mfg_sales_order_items')
        .delete()
        .eq('id', diff.sales_order_item_id)
        .eq('doc_no', docNo);
      if (delErr) throw new Error(`applySoAmendment: REMOVE failed for line ${diff.sales_order_item_id}: ${delErr.message}`);
      {
        const snap = (diff.old_snapshot ?? {}) as Record<string, unknown>;
        if (ruleTwo && String(snap.item_group ?? '').toLowerCase() === 'sofa' && snap.item_code) {
          ruleTwoModels.add(sofaModelOf(String(snap.item_code)));
        }
        const gone = String(snap.item_code ?? snap.itemCode ?? diff.sales_order_item_id);
        lineChanges.push({ field: `line_removed_${gone}`, from: `qty ${snap.qty ?? '?'}`, to: 'removed' });
        touched.push({ change, itemCode: String(snap.item_code ?? ''), qty: 0 });
      }
      continue;
    }

    if (change === 'ADD') {
      const itemCode = String(diff.new_item_code ?? '').trim();
      if (!itemCode) throw new Error('applySoAmendment: ADD line has no new_item_code');
      /* Edge #4 at the insert choke point (owner 2026-08-08: every SO line is
         a catalog SKU). The submit route already refused unknown codes; this
         re-check covers amendments raised before that gate existed and any
         non-route writer. Company-scoped to the SO's own company — code is
         only unique per company. */
      let prodName: string | null = null;
      let prodCategory: string | null = null;
      {
        let q = sb.from('mfg_products').select('code, name, category').eq('code', itemCode);
        if (soCompanyId != null) q = q.eq('company_id', soCompanyId);
        const { data: prodRows } = await q.limit(1);
        if (!prodRows || prodRows.length === 0) {
          throw new Error(`applySoAmendment: ADD line item code is not in the product catalog: ${itemCode}`);
        }
        const prod = prodRows[0] as { name?: string | null; category?: string | null };
        prodName = (prod.name ?? '').trim() || null;
        prodCategory = (prod.category ?? '').trim() || null;
      }
      const variants = (diff.new_variants ?? null) as Record<string, unknown> | null;
      /* ITEM GROUP — the CATALOG's category first (SKU wins, docs/bugs/0514), then
         the requested blob, then the line's own old snapshot (owner 2026-08-11). The catalog step is new:
         the chain used to fall straight to the literal 'others', so an added
         SVC-ADDON landed with item_group='others' while the identical SKU
         created through POST / lands 'service'. That is not cosmetic —
         isServiceLine() reads item_group, and a SERVICE line is never allocated
         stock, never gates SO readiness, never becomes MRP demand and never
         produces an inventory movement (vendor/shared/service-sku.ts). A service
         line mis-grouped as goods asks the factory to make a delivery fee.
         'others' remains the last resort for a catalog row with no category. */
      const itemGroup = String(
        prodCategory ?? variants?.itemGroup ?? diff.old_snapshot?.item_group ?? 'others',
      ).toLowerCase();
      const qty = Math.max(1, Number(diff.new_qty ?? 1));

      const rec = await recomputeOneLine(sb, {
        itemCode,
        itemGroup,
        qty,
        unitPriceSen: Number(diff.new_unit_price_sen ?? 0),
        variants: (variants as MfgItemForRecompute['variants']) ?? null,
      }, cachedConfig, soCompanyId, { trustOperatorSelling: addLineTrust, asOf: ruleTwo ? changeDay : soAsOf });

      const unit = rec.unit_price_sen;
      const lineTotal = qty * unit;
      const unitCost = rec.unit_cost_sen;
      const lineCost = unitCost * qty;

      /* The warehouse follows the SO (owner 2026-07-31): "我们的 item 都不会有仓库,
         还是跟着 SO 的". This insert used to omit warehouse_id, so an amendment
         ADD line landed NULL and split its order into a second MRP row under the
         WH_NONE bucket. Resolved from the SO's OWN header — never from a sibling
         line, which would pool stock across a warehouse boundary. Fail-soft: an
         unresolvable header yields null, the previous behaviour, so an amendment
         is never blocked by a missing state mapping. */
      const addLineWarehouseId = await soWarehouseIdForDoc(sb, docNo, soCompanyId);

      const { data: maxNoRow, error: maxNoErr } = await scopeToCompanyIdOrOpen(
        sb.from('mfg_sales_order_items').select('line_no').eq('doc_no', docNo),
        soCompanyId,
      ).order('line_no', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
      if (maxNoErr) throw new Error(`applySoAmendment: line number read failed: ${maxNoErr.message}`);
      const maxLineNo = (maxNoRow as { line_no?: number | null } | null)?.line_no;

      const { data: insRow, error: insErr } = await sb.from('mfg_sales_order_items').insert({
        ...(soCompanyId != null ? { company_id: soCompanyId } : {}),
        ...(typeof maxLineNo === 'number' ? { line_no: maxLineNo + 1 } : {}),
        doc_no:                  docNo,
        ...(ruleTwo ? { cost_day: changeDay } : {}),
        line_date:              todayMyt(),
        item_group:             itemGroup,
        item_code:              itemCode,
        /* NAME + variant summary (owner 2026-08-11). This insert wrote NEITHER,
           so every line ever added by an approved amendment landed with
           description NULL and description2 NULL — the row could only ever name
           itself by its bare SKU code, on the SO, on the DO and SI it flows to,
           and on all three printed documents. The name comes from the CATALOG
           row just read (`mfg_products.name`), never from the amendment payload:
           an amendment line carries no description field, and the catalog is the
           authority the swap path (PATCH …/items/:id/swap) already uses.
           description2 is the server-built variant summary, exactly as POST /
           builds it — the single source of truth for the long attribute string. */
        description:            prodName,
        description2:           buildVariantSummary(itemGroup, variants) || null,
        uom:                    'UNIT',
        qty,
        unit_price_sen:       unit,
        discount_sen:         0,
        total_sen:            lineTotal,
        total_inc_sen:        lineTotal,
        balance_sen:          lineTotal,
        variants,
        unit_cost_sen:        unitCost,
        line_cost_sen:        lineCost,
        line_margin_sen:      lineTotal - lineCost,
        divan_price_sen:        rec.divan_price_sen,
        leg_price_sen:          rec.leg_price_sen,
        special_order_price_sen: rec.special_order_sen,
        custom_specials:        rec.custom_specials ?? null,
        stock_status:           'PENDING',
        warehouse_id:           addLineWarehouseId,
        remark:                 diff.new_remark,
      }).select('id').single();
      if (insErr) throw new Error(`applySoAmendment: ADD insert failed: ${insErr.message}`);
      if (insRow?.id) addedLineIds.push(String(insRow.id));
      if (ruleTwo && insRow?.id && itemGroup === 'sofa') {
        ruleTwoModels.add(sofaModelOf(itemCode));
        ruleTwoLineIds.push(String(insRow.id));
      }
      lineChanges.push({ field: `line_added_${itemCode}`, from: null, to: `qty ${qty}` });
      if ((diff.new_remark ?? '').trim()) {
        lineChanges.push({ field: `line_added_${itemCode}_remark`, from: null, to: diff.new_remark });
      }
      touched.push({ change, itemCode, qty });
      continue;
    }

    if (!diff.sales_order_item_id) continue;

    const { data: existing, error: exErr } = await sb
      .from('mfg_sales_order_items')
      .select('*')
      .eq('id', diff.sales_order_item_id)
      .eq('doc_no', docNo)
      .maybeSingle();
    if (exErr) throw new Error(`applySoAmendment: line load failed: ${exErr.message}`);
    if (!existing) continue;

    const row = existing as Record<string, unknown>;
    const itemCode = change === 'SPEC' && diff.new_item_code
      ? String(diff.new_item_code).trim()
      : String(row.item_code ?? '');
    /* A code moved by SPEC takes the NEW SKU's category (docs/bugs/0514), as the
       PO twin does (po-revision.ts). Keeping the old line's group left
       HC-SO-012243's free-gift pillow, swapped from SQUARE PILLOW, on the Sofa
       Accessory group: hard-bound, so MRP read it SHORT beside 78 in stock. */
    const codeMoved = itemCode !== String(row.item_code ?? '').trim();
    const itemGroup = String(
      (codeMoved ? groupOf({ materialKind: 'mfg_product', itemCode }) : null) ?? row.item_group ?? 'others',
    ).toLowerCase();
    const qty = diff.new_qty != null ? Math.max(1, Number(diff.new_qty)) : Math.max(1, Number(row.qty ?? 1));
    const variants = change === 'SPEC' && diff.new_variants != null
      ? (diff.new_variants as Record<string, unknown>)
      : (row.variants as Record<string, unknown> | null) ?? null;
    /* WHOSE number reaches the pricing engine. `new_unit_price_sen` is a REQUEST
       written from the browser and validated nowhere, so it is read ONLY when an
       approval is being claimed. Without one the line simply keeps its stored
       price as the client figure — which on a native order the recompute then
       replaces with the catalogue figure, exactly as before, and on a migrated
       order the 'including-zero' protection preserves. That is the property that
       makes this fix incapable of authoring a price without an approval: with
       `approval === null` an unvalidated payload number is never even read.
       HC-0095: a requested 0 counts only when the operator claimed it
       (zero_price_intended), the amendment twin of unitAfterLineEdit. An
       unclaimed 0 is an unpriced SKU's seed and keeps the stored price. */
    const requestedUnit = diff.new_unit_price_sen;
    const clientUnit = (approval !== null && requestedUnit != null
        && (Number(requestedUnit) !== 0 || diff.zero_price_intended === true))
      ? Number(requestedUnit)
      : Number(row.unit_price_sen ?? 0);

    const rec = await recomputeOneLine(sb, {
      itemCode,
      itemGroup,
      qty,
      unitPriceSen: clientUnit,
      variants: (variants as MfgItemForRecompute['variants']) ?? null,
    }, cachedConfig, soCompanyId, { trustOperatorSelling: amendTrust, asOf: soAsOf });

    const unit = rec.unit_price_sen;
    const discount = diff.new_discount_sen != null
      ? Math.min(Math.max(Math.round(Number(diff.new_discount_sen)), 0), qty * unit)
      : Number(row.discount_sen ?? 0);
    const lineTotal = (qty * unit) - discount;
    let unitCost = rec.unit_cost_sen;
    let lineCost = unitCost * qty;
    let lineCostDay: string | null = null;
    if (ruleTwo) {
      const prevUnitCost = Math.max(0, Math.round(Number(row.unit_cost_sen) || 0));
      const prevQty = Math.max(1, Number(row.qty) || 1);
      const shape = lineEditCostKind(
        { itemCode: String(row.item_code ?? ''), variants: canonicalizeVariants(String(row.item_group ?? ''), (row.variants as Record<string, unknown> | null) ?? null), unitCostSen: 1 },
        { itemCode, variants: canonicalizeVariants(itemGroup, variants) },
      );
      const atChangeDay = (spec: { itemCode: string; itemGroup: string; variants: Record<string, unknown> | null }) => recomputeOneLine(sb, {
        itemCode: spec.itemCode, itemGroup: spec.itemGroup, qty, unitPriceSen: clientUnit,
        variants: (spec.variants as MfgItemForRecompute['variants']) ?? null,
      }, cachedConfig, soCompanyId, { trustOperatorSelling: amendTrust, asOf: changeDay });
      let sameHeight = false;
      let changeUnit: number | null = null;
      if (shape === 'height' && prevUnitCost > 0) {
        const [was, now] = await Promise.all([
          atChangeDay({ itemCode: String(row.item_code ?? ''), itemGroup: String(row.item_group ?? itemGroup), variants: (row.variants as Record<string, unknown> | null) ?? null }),
          atChangeDay({ itemCode, itemGroup, variants }),
        ]);
        sameHeight = was.unit_cost_sen === now.unit_cost_sen;
        changeUnit = now.unit_cost_sen;
      }
      if ((shape === 'keep' || sameHeight) && prevUnitCost > 0) {
        const sellingMoved = lineTotal !== Math.round(Number(row.total_sen) || 0);
        const extraToday = sellingMoved && qty > prevQty;
        const extraUnit = extraToday ? (changeUnit ?? (await atChangeDay({ itemCode, itemGroup, variants })).unit_cost_sen) : null;
        lineCost = qtyChangeLineCostSen({
          qtyBefore: prevQty, qtyAfter: qty, lineCostBeforeSen: prevUnitCost * prevQty,
          sellingChanged: sellingMoved, changeDayUnitCostSen: extraUnit,
        });
        unitCost = qty === prevQty ? prevUnitCost : Math.round(lineCost / qty);
        if (extraToday) lineCostDay = changeDay;
      } else if (shape !== 'keep') {
        unitCost = changeUnit ?? (await atChangeDay({ itemCode, itemGroup, variants })).unit_cost_sen;
        lineCost = unitCost * qty;
        lineCostDay = changeDay;
      }
      if (lineCostDay && itemGroup === 'sofa') {
        ruleTwoModels.add(sofaModelOf(itemCode));
        if (codeMoved) ruleTwoModels.add(sofaModelOf(String(row.item_code ?? '')));
        ruleTwoLineIds.push(String(diff.sales_order_item_id));
      }
    }

    /* NAME + variant summary must track a SPEC's new code (owner 2026-08-11).
       This UPDATE rewrote item_code but left description / description2 untouched,
       so a code-swap amendment left the line naming itself by the OLD product on
       every name-first surface — the amend editor's SoLineCard picker, the
       follow-up PO's material_name, and anything reading `description`. The ADD
       branch above already resolves the name from the catalog (mfg_products.name);
       SPEC must do the same. Fail-soft: an unknown code keeps the stored name
       rather than blocking an approved amendment over a display field (the ADD
       branch refuses a brand-new line with no catalog row; a SPEC line already
       exists and its code passed the submit gate). */
    let specDescription: string | null | undefined;
    if (change === 'SPEC') {
      let pq = sb.from('mfg_products').select('name').eq('code', itemCode);
      if (soCompanyId != null) pq = pq.eq('company_id', soCompanyId);
      const { data: prodRows, error: prodErr } = await pq.limit(1);
      if (prodErr) throw new Error(`applySoAmendment: SPEC name lookup failed for ${itemCode}: ${prodErr.message}`);
      const prod = prodRows?.[0] as { name?: string | null } | undefined;
      if (prod) specDescription = (prod.name ?? '').trim() || null;
    }

    const { error: updErr } = await sb.from('mfg_sales_order_items').update({
      item_code:               itemCode,
      ...(codeMoved ? { item_group: itemGroup } : {}),
      qty,
      variants,
      unit_price_sen:        unit,
      total_sen:             lineTotal,
      total_inc_sen:         lineTotal,
      balance_sen:           lineTotal,
      unit_cost_sen:         unitCost,
      line_cost_sen:         lineCost,
      line_margin_sen:       lineTotal - lineCost,
      ...(lineCostDay ? { cost_day: lineCostDay } : {}),
      divan_price_sen:         rec.divan_price_sen,
      leg_price_sen:           rec.leg_price_sen,
      special_order_price_sen: rec.special_order_sen,
      custom_specials:         rec.custom_specials ?? null,
      ...(specDescription !== undefined ? { description: specDescription } : {}),
      ...(change === 'SPEC' ? { description2: buildVariantSummary(itemGroup, variants) || null } : {}),
      ...(diff.new_remark != null ? { remark: diff.new_remark } : {}),
      ...(diff.new_discount_sen != null ? { discount_sen: discount } : {}),
    }).eq('id', diff.sales_order_item_id);
    if (updErr) throw new Error(`applySoAmendment: ${change} update failed for line ${diff.sales_order_item_id}: ${updErr.message}`);
    {
      const wasCode = String(row.item_code ?? '');
      const key = wasCode || String(diff.sales_order_item_id);
      noteChange(`line_${key}_item_code`, wasCode, itemCode);
      noteChange(`line_${key}_item_group`, row.item_group, itemGroup);
      noteChange(`line_${key}_qty`, row.qty, qty);
      noteChange(`line_${key}_unit_price_sen`, row.unit_price_sen, unit);
      noteChange(
        `line_${key}_spec`,
        buildVariantSummary(itemGroup, (row.variants as Record<string, unknown> | null) ?? null),
        buildVariantSummary(itemGroup, variants ?? null),
      );
      if (diff.new_remark != null) noteChange(`line_${key}_remark`, row.remark, diff.new_remark);
      if (diff.new_discount_sen != null) noteChange(`line_${key}_discount_sen`, row.discount_sen, discount);
    }
    touched.push({ change, itemCode, qty });
  }

  /* (4b) Apply the HEADER half of the amendment (mig 0119, Owner 2026-07-16).
     These are the columns the processing lock FREEZES, so the direct header
     PATCH refuses them once the SO is locked — approving the amendment is the
     only way they ever change, and this is where that happens.

     Runs BEFORE rederiveDeliveryFee below because the delivery fee is computed
     from the SO's state/location: a state change must be on the row before the
     fee is re-derived, or the SO would keep a fee priced for the old state.

     Every key is re-checked against AMENDABLE_HEADER_FIELDS — the create route
     already rejects an unlisted key, this is defence in depth on the last step
     before the write. */
  const soHdrNow = (soHdrCo ?? {}) as { status?: string | null; processing_date?: unknown; customer_delivery_date?: unknown; sales_exemption_expiry?: string | null };
  const storedHeaderChanges = canonicaliseSoHeaderChanges(amendment.header_changes ?? null);
  const headerChanges = storedHeaderChanges && withProcessingRemovalCascade(storedHeaderChanges, {
    processingDate: soHdrNow.processing_date, deliveryDate: soHdrNow.customer_delivery_date,
  });
  const headerApplied: string[] = [];
  if (headerChanges && Object.keys(headerChanges).length > 0) {
    const headerUpdates: Record<string, unknown> = {};
    if ('processingDate' in headerChanges) {
      const nextStatus = await soStatusAfterProcessingDateChange(sb, docNo, {
        currentStatus: soHdrNow.status,
        storedProcessingDate: soDateYmd(soHdrNow.processing_date),
        effectiveProcessingDate: soDateYmd(headerChanges['processingDate']),
      });
      if (nextStatus) headerUpdates['status'] = nextStatus;
    }
    for (const [key, value] of Object.entries(headerChanges)) {
      if (!Object.prototype.hasOwnProperty.call(AMENDABLE_HEADER_FIELDS, key)) continue;
      const col = AMENDABLE_HEADER_FIELDS[key];
      headerUpdates[col] = value === '' ? null : value;
      if (key === 'customerDeliveryDate') headerUpdates['amended_delivery_date'] = value === '' ? null : value;
      /* HC-0122: the first date an order ever gets may arrive through an amendment;
         freeze it as the Sales Exemption Expiry exactly as create / header PATCH do. */
      if (key === 'customerDeliveryDate') {
        const seed = exemptionExpirySeed(soHdrNow.status === 'DRAFT' ? null : soHdrNow.sales_exemption_expiry, dateOrNull(value));
        if (seed) headerUpdates['sales_exemption_expiry'] = seed;
      }
      headerApplied.push(`${col}=${value ?? 'cleared'}`);
    }

    if ('customerState' in headerChanges) {
      const newState = headerChanges['customerState'] ?? null;
      headerUpdates['customer_country'] = await deriveCountryFromState(sb, newState);
      if (c) {
        const derivedLocation = await deriveSalesLocationFromState(sb, newState, c);
        if (derivedLocation) headerUpdates['sales_location'] = derivedLocation;
      }
    }

    if (Object.keys(headerUpdates).length > 0) {
      const { error: hUpdErr } = await sb
        .from('mfg_sales_orders')
        .update(headerUpdates)
        .eq('doc_no', docNo);
      if (hUpdErr) throw new Error(`applySoAmendment: header change apply failed: ${hUpdErr.message}`);
    }

    if ('customerDeliveryDate' in headerChanges && frozenLineFilter !== null) {
      const { error: cascErr } = await skipFrozen(sb.from('mfg_sales_order_items')
        .update({
          line_delivery_date: dateOrNull(headerChanges['customerDeliveryDate']),
          line_delivery_date_overridden: true,
        })
        .eq('doc_no', docNo));
      if (cascErr) {
        if ((sb as unknown as { __atomicCommand?: boolean }).__atomicCommand === true) {
          throw new Error(`applySoAmendment: delivery-date cascade failed: ${cascErr.message}`);
        }
        // eslint-disable-next-line no-console
        console.error('[so-amendment] delivery-date line cascade failed (non-fatal):', cascErr.message);
      }
    }

    /* State -> per-line warehouse rebind. The State is frozen by the lock
       PRECISELY because it drives each line's warehouse_id and that warehouse is
       what the PO ships from (Owner 2026-06-16) — so an APPROVED state change
       must move the lines too, otherwise approving it would produce the exact
       warehouse/PO desync the lock exists to prevent. The bound PO is then
       re-derived from these lines at the approve-po gate.

       NOTE this is deliberately BROADER than the header PATCH's rebind, which
       only backfills lines whose warehouse_id is NULL (it must not clobber a
       per-line override during a routine edit). Here the change has passed a
       supplier confirmation + an explicit approval, so every non-cancelled line
       follows the approved address. FLAGGED in BUG-HISTORY for owner review. */
    if ('customerState' in headerChanges && c && frozenLineFilter !== null) {
      const reboundWh = await deriveWarehouseIdFromState(sb, headerChanges['customerState'] ?? null, c);
      if (reboundWh) {
        const { error: whErr } = await skipFrozen(sb
          .from('mfg_sales_order_items')
          .update({ warehouse_id: reboundWh })
          .eq('doc_no', docNo)
          .eq('cancelled', false));
        if (whErr) {
          if ((sb as unknown as { __atomicCommand?: boolean }).__atomicCommand === true) {
            throw new Error(`applySoAmendment: warehouse rebind failed: ${whErr.message}`);
          }
          // eslint-disable-next-line no-console
          console.error('[so-amendment] warehouse rebind failed (non-fatal):', whErr.message);
        }
      }
    }
  }

  if (ruleTwo && soCompanyId != null && ruleTwoModels.size > 0) {
    const set = await costChangedSofaSets(sb, {
      docNo, companyId: soCompanyId, orderDay: ruleTwo.orderDay, changeDay,
      models: [...ruleTwoModels], changedLineIds: ruleTwoLineIds,
    });
    // eslint-disable-next-line no-console
    if (!set.ok) console.error('[so-rule-2] set re-cost failed — the order-date spread stands:', docNo, set.reason);
  }

  try {
    await rederiveDeliveryFee(sb, docNo, c);
  } catch (e) {
    if ((sb as unknown as { __atomicCommand?: boolean }).__atomicCommand === true) throw e;
    // eslint-disable-next-line no-console
    console.error('[so-amendment] rederiveDeliveryFee failed (non-fatal):', e);
  }
  /* An approved product change can change the brand (HC-0095): re-derive the
     header and its fair booth exactly as a direct line edit does. Non-fatal. */
  if (c) await restampHeaderBranding(sb, docNo, c);

  let bump = sb
    .from('mfg_sales_orders')
    .update({
      revision: nextRevision,
      ...(concurrency ? {
        version: concurrency.soVersion + 1,
        edit_lease_token: null,
        edit_lease_expires_at: null,
      } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('doc_no', docNo);
  if (concurrency) {
    bump = bump.eq('version', concurrency.soVersion).eq('edit_lease_token', concurrency.leaseToken);
  }
  const { data: bumped, error: bumpErr } = await bump.select('doc_no').maybeSingle();
  if (bumpErr) throw new Error(`applySoAmendment: revision bump failed: ${bumpErr.message}`);
  if (!bumped) throw new Error('applySoAmendment: Sales Order version changed during amendment apply');

  const routingSummary = routingNote(soAmendmentFieldKinds(amendmentLines, headerChanges as Record<string, unknown> | null));
  await recordSoAudit(sb, {
    docNo,
    action: 'AMENDMENT_SO_APPROVED',
    actorId: userId,
    actorName: realActorName(c),
    fieldChanges: [
      { field: 'amendment_id', to: amendmentId },
      { field: 'revision', from: nextRevision - 1, to: nextRevision },
      { field: 'lines_applied', to: touched.length },
      ...(headerApplied.length > 0 ? [{ field: 'header_applied', to: headerApplied.join(', ') }] : []),
      ...(approval ? [{ field: 'price_authority', to: approval.approvalPermission }] : []),
      ...(routingSummary ? [{ field: 'routing', to: routingSummary }] : []),
      ...lineChanges,
    ],
    note: `Amendment applied: ${[
      touched.map((t) => `${t.change} ${t.itemCode}`).join('; ') || null,
      headerApplied.length > 0 ? `header ${headerApplied.join(', ')}` : null,
      routingSummary ? `routing ${routingSummary}` : null,
    ].filter(Boolean).join('; ') || 'no diffs'}`,
  });

  if (addedLineIds.length > 0) await syncSoDeliveredFromDo(sb, [docNo], userId);

  if (changeWindow && changeWindowId) {
    await closeChangeWindow(sb, changeWindow, changeWindowId, {
      changedBy: await staffNameOf(sb, amendment.requested_by ?? null),
      approvedBy: realActorName(c),
      amendmentNo: amendment.amendment_no ?? null,
      changeDay,
    });
  }

  return { soDocNo: docNo, revision: nextRevision, addedLineIds };
}

async function staffNameOf(sb: Sb, staffId: string | null): Promise<string | null> {
  if (!staffId) return null;
  const { data, error } = await sb.from('staff').select('name').eq('id', staffId).maybeSingle();
  if (error) return null;
  return ((data as { name?: string | null } | null)?.name ?? '').trim() || null;
}

export async function snapshotPo(
  sb: Sb,
  poId: string,
  amendmentId?: string | null,
  userId?: string | null,
  c?: Context<any>,
): Promise<number> {
  const { data: header, error: hErr } = await sb
    .from('purchase_orders')
    .select('*')
    .eq('id', poId)
    .maybeSingle();
  if (hErr) throw new Error(`snapshotPo: header load failed: ${hErr.message}`);
  if (!header) throw new Error(`snapshotPo: PO ${poId} not found`);

  const currentRevision =
    typeof (header as { revision?: unknown }).revision === 'number'
      ? (header as { revision: number }).revision
      : 1;

  /* The document's own order (owner 2026-09-10), not created_at alone: a
     snapshot is diffed against the next one, and `created_at` is not a total
     order — every line of a converted sofa shares it (lib/po-line-order.ts). */
  const { data: lines, error: lErr } = await inPoLineOrder(sb
    .from('purchase_order_items')
    .select('*')
    .eq('purchase_order_id', poId));
  if (lErr) throw new Error(`snapshotPo: lines load failed: ${lErr.message}`);

  const snapshot = {
    header,
    lines: lines ?? [],
    snapshotAt: new Date().toISOString(),
  };

  const { error: insErr } = await sb
    .from('po_revisions')
    .upsert(
      {
        po_id:        poId,
        revision:     currentRevision,
        snapshot,
        amendment_id: amendmentId ?? null,
        created_by:   userId ?? null,
        company_id:   c ? activeCompanyId(c) : undefined,
      },
      { onConflict: 'po_id,revision', ignoreDuplicates: true },
    );
  if (insErr) throw new Error(`snapshotPo: revision insert failed: ${insErr.message}`);

  return currentRevision + 1;
}

export type ReviseBoundPoResult = {
  revisedPoIds: string[];
  perPo: Array<{
    poId: string; poNumber: string; revision: number;
    linesRederived: number; linesRemoved: number; linesAdded: number;
  }>;
  warnings: string[];
  /* AutoCount keys of the PO lines deleted here, read before the delete, so the
     caller's AutoCount edit retires them — as applyPoAmendment's REMOVE does (HC-0121). */
  retired: AcRetiredLine[];
};

export class ReceivedFloorError extends Error {
  code = 'received_floor' as const;
  poItemId: string;
  revisedQty: number;
  receivedQty: number;
  constructor(poItemId: string, revisedQty: number, receivedQty: number) {
    super(
      `Revised qty ${revisedQty} for PO line ${poItemId} drops below the ${receivedQty} already received.`,
    );
    this.name = 'ReceivedFloorError';
    this.poItemId = poItemId;
    this.revisedQty = revisedQty;
    this.receivedQty = receivedQty;
  }
}

/** HC-0004: the DB floor (mig 20261014T1430) refused a PO line qty cut below
 *  what live GRNs received — a GRN posted after the floor read above. Same
 *  ReceivedFloorError, so the callers' existing 409 answers it. */
export function receivedFloorFromDb(
  err: { code?: string | null; message?: string } | null,
  poItemId: string,
  revisedQty: number,
): ReceivedFloorError | null {
  if (!isPoLineOverReceived(err)) return null;
  const m = /would have ([\d.]+) received/.exec(err?.message ?? '');
  return new ReceivedFloorError(poItemId, revisedQty, m ? Number(m[1]) : NaN);
}

/** Inside runScmPgCommand a refused statement THROWS (it never returns `{ error }`),
 *  so receivedFloorFromDb on the result would never run. Await the update through
 *  this and a P0411 comes out as the ReceivedFloorError the callers answer with 409. */
export async function withReceivedFloor(
  write: PromiseLike<{ error: { code?: string | null; message?: string } | null }>,
  poItemId: string,
  revisedQty: number,
): Promise<{ error: { code?: string | null; message?: string } | null }> {
  try {
    return await write;
  } catch (e) {
    throw receivedFloorFromDb(e as { code?: string | null; message?: string }, poItemId, revisedQty) ?? e;
  }
}

export async function reviseBoundPo(
  sb: Sb,
  amendmentId: string,
  userId: string | null,
  c?: Context<any>,
  opts?: { onlyPoId?: string },
): Promise<ReviseBoundPoResult> {
  const noop = (): ReviseBoundPoResult => ({ revisedPoIds: [], perPo: [], warnings: [], retired: [] });

  const { data: amdRow, error: amdErr } = await sb
    .from('so_amendments')
    .select('id, so_doc_no, status')
    .eq('id', amendmentId)
    .maybeSingle();
  if (amdErr) throw new Error(`reviseBoundPo: amendment load failed: ${amdErr.message}`);
  if (!amdRow) throw new Error('reviseBoundPo: amendment not found');
  const docNo = (amdRow as AmendmentRow).so_doc_no;
  assertNotMirrored(docNo, 'reviseBoundPo', c);

  const { data: soHdr, error: soHdrErr } = await sb
    .from('mfg_sales_orders')
    .select('company_id')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (soHdrErr) throw new Error(`reviseBoundPo: SO company load failed: ${soHdrErr.message}`);
  const soCompanyId = (soHdr as { company_id?: number | null } | null)?.company_id ?? null;

  const { data: snapRow, error: snapErr } = await sb
    .from('so_revisions')
    .select('snapshot')
    .eq('amendment_id', amendmentId)
    .order('revision', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (snapErr) throw new Error(`reviseBoundPo: revision snapshot load failed: ${snapErr.message}`);
  const snap = (snapRow as { snapshot?: { lines?: Array<{ id?: string }>; poLinks?: Record<string, string[]> } } | null)?.snapshot ?? null;
  const prevLineIds = new Set(
    ((snap?.lines ?? []) as Array<{ id?: string }>)
      .map((r) => String(r.id ?? ''))
      .filter((x) => x.length > 0),
  );
  const poLinks = (snap?.poLinks ?? {}) as Record<string, string[]>;

  const { data: soItemRows, error: soItemErr } = await sb
    .from('mfg_sales_order_items')
    .select('id, cancelled')
    .eq('doc_no', docNo);
  if (soItemErr) throw new Error(`reviseBoundPo: SO items load failed: ${soItemErr.message}`);
  const soItemIds = ((soItemRows ?? []) as Array<{ id: string; cancelled?: boolean | null }>)
    .filter((r) => r.cancelled !== true).map((r) => r.id);
  const currentIdSet = new Set(soItemIds);

  const addedSoItemIds = prevLineIds.size > 0
    ? soItemIds.filter((id) => !prevLineIds.has(id))
    : [];
  const removedSoItemIds = [...prevLineIds].filter((id) => !currentIdSet.has(id));
  const orphanPoItemIds = [...new Set(removedSoItemIds.flatMap((id) => poLinks[id] ?? []))];

  const boundSoItemIdSet = new Set<string>();
  let allPoItems: Array<{
    id: string; purchase_order_id: string | null; so_item_id: string | null;
    qty: number | null; received_qty: number | null;
  }> = [];
  if (soItemIds.length > 0) {
    const { data: poItemRows, error: poItemErr } = await sb
      .from('purchase_order_items')
      .select('id, purchase_order_id, so_item_id, qty, received_qty')
      .in('so_item_id', soItemIds);
    if (poItemErr) throw new Error(`reviseBoundPo: PO items load failed: ${poItemErr.message}`);
    allPoItems = (poItemRows ?? []) as typeof allPoItems;
    for (const pi of allPoItems) if (pi.so_item_id) boundSoItemIdSet.add(pi.so_item_id);
  }

  let orphanRows: Array<{
    id: string; purchase_order_id: string | null; received_qty: number | null;
    item_code: string | null; material_name: string | null;
  }> = [];
  if (orphanPoItemIds.length > 0) {
    const { data: oRows, error: oErr } = await sb
      .from('purchase_order_items')
      .select('id, purchase_order_id, received_qty, item_code, material_name')
      .in('id', orphanPoItemIds);
    if (oErr) throw new Error(`reviseBoundPo: orphan PO lines load failed: ${oErr.message}`);
    orphanRows = (oRows ?? []) as typeof orphanRows;
  }

  const candidatePoIds = [...new Set([
    ...allPoItems.map((r) => r.purchase_order_id),
    ...orphanRows.map((r) => r.purchase_order_id),
  ].filter((x): x is string => Boolean(x)))];
  if (candidatePoIds.length === 0) return noop();

  const { data: poHeaders, error: poHeadErr } = await sb
    .from('purchase_orders')
    .select('id, po_number, status, revision, supplier_id, purchase_location_id, company_id')
    .in('id', candidatePoIds);
  if (poHeadErr) throw new Error(`reviseBoundPo: PO headers load failed: ${poHeadErr.message}`);
  const livePos = ((poHeaders ?? []) as Array<{
    id: string; po_number: string; status: string; revision: number | null;
    supplier_id: string | null; purchase_location_id: string | null; company_id: number | null;
  }>).filter((p) => String(p.status).toUpperCase() !== 'CANCELLED');
  if (livePos.length === 0) return noop();

  const scopedPos = opts?.onlyPoId ? livePos.filter((p) => p.id === opts.onlyPoId) : livePos;
  if (scopedPos.length === 0) return noop();
  const livePoIds = new Set(scopedPos.map((p) => p.id));

  const { data: revisedSoRows, error: revErr } = await sb
    .from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, variants, warehouse_id, line_delivery_date, description, photo_urls')
    .in('id', soItemIds);
  if (revErr) throw new Error(`reviseBoundPo: revised SO lines load failed: ${revErr.message}`);
  type RevisedLine = RevisedSoLine;
  const revisedById = new Map<string, RevisedLine>();
  for (const r of (revisedSoRows ?? []) as Array<Record<string, unknown>>) {
    revisedById.set(String(r.id), {
      item_code:          (r.item_code as string | null) ?? null,
      item_group:         (r.item_group as string | null) ?? null,
      qty:                r.qty == null ? null : Number(r.qty),
      variants:           (r.variants as Record<string, unknown> | null) ?? null,
      warehouse_id:       (r.warehouse_id as string | null) ?? null,
      line_delivery_date: (r.line_delivery_date as string | null) ?? null,
      description:        (r.description as string | null) ?? null,
      photo_urls:         (r.photo_urls as string[] | null) ?? null,
    });
  }

  const targetPoItems = allPoItems.filter(
    (pi) => pi.purchase_order_id && livePoIds.has(pi.purchase_order_id)
      && pi.so_item_id && revisedById.has(pi.so_item_id),
  );

  for (const pi of targetPoItems) {
    const revised = revisedById.get(pi.so_item_id as string)!;
    const receivedQty = Number(pi.received_qty ?? 0);
    if (receivedFloorViolation({ newQty: revised.qty }, { receivedQty })) {
      throw new ReceivedFloorError(pi.id, Number(revised.qty), receivedQty);
    }
  }

  const warnings: string[] = [];
  const retired: AcRetiredLine[] = [];
  const addedNeedingPo = addedSoItemIds.filter((id) => !boundSoItemIdSet.has(id) && revisedById.has(id));
  const addedByPo = new Map<string, Array<{ soItemId: string; line: RevisedLine; supplierSku: string | null }>>();
  if (addedNeedingPo.length > 0) {
    const codes = [...new Set(
      addedNeedingPo.map((id) => revisedById.get(id)?.item_code).filter((x): x is string => Boolean(x)),
    )];
    const bindingsByCode = new Map<string, Array<{ supplier_id: string; supplier_sku: string | null }>>();
    if (codes.length > 0) {
      const { data: bRows, error: bErr } = await readMfgProductBindings<{
        item_code: string; supplier_id: string; supplier_sku: string | null;
      }>(sb, {
        codes,
        companyId: soCompanyId,
        select: 'item_code, supplier_id, supplier_sku, is_main_supplier',
      });
      if (bErr) throw new Error(`reviseBoundPo: added-line supplier binding load failed: ${bErr.message}`);
      for (const b of (bRows ?? []) as Array<{ item_code: string; supplier_id: string; supplier_sku: string | null }>) {
        const arr = bindingsByCode.get(b.item_code) ?? [];
        arr.push(b);
        bindingsByCode.set(b.item_code, arr);
      }
    }
    const boundSupplierIds = new Set(livePos.map((p) => p.supplier_id).filter((x): x is string => Boolean(x)));
    for (const soItemId of addedNeedingPo) {
      const line = revisedById.get(soItemId)!;
      const itemCode = line.item_code ?? '';
      const label = (line.description || itemCode || 'a new item').trim();
      const codeBindings = itemCode ? (bindingsByCode.get(itemCode) ?? []) : [];
      if (codeBindings.length === 0) {
        warnings.push(`A newly added item (${label}) has no supplier set, so it could not be added to a purchase order. Set its main supplier, then raise a purchase order for it.`);
        continue;
      }
      const binding = pickAddLineBinding(codeBindings, boundSupplierIds);
      if (!binding) {
        warnings.push(`A newly added item (${label}) is from a supplier that has no open purchase order on this sales order, so a purchase order still needs to be raised for it.`);
        continue;
      }
      const forSupplier = livePos.filter((p) => p.supplier_id === binding.supplier_id);
      const target = forSupplier.find((p) => p.purchase_location_id && p.purchase_location_id === line.warehouse_id)
        ?? forSupplier[0]!;
      if (!livePoIds.has(target.id)) continue;
      const arr = addedByPo.get(target.id) ?? [];
      arr.push({ soItemId, line, supplierSku: binding.supplier_sku ?? null });
      addedByPo.set(target.id, arr);
    }
  }

  const matchedByPo = new Map<string, typeof targetPoItems>();
  for (const pi of targetPoItems) {
    const key = pi.purchase_order_id as string;
    const arr = matchedByPo.get(key) ?? [];
    arr.push(pi);
    matchedByPo.set(key, arr);
  }
  const orphansByPo = new Map<string, typeof orphanRows>();
  for (const orow of orphanRows) {
    if (!orow.purchase_order_id || !livePoIds.has(orow.purchase_order_id)) continue;
    const arr = orphansByPo.get(orow.purchase_order_id) ?? [];
    arr.push(orow);
    orphansByPo.set(orow.purchase_order_id, arr);
  }

  type Lead = { base: LeadTimeBase; overrides: LeadOverrides; buffers: LeadBuffers };
  const leadByCompany = new Map<number | null, Promise<Lead>>();
  const leadFor = (companyId: number | null): Promise<Lead> => {
    let p = leadByCompany.get(companyId);
    if (!p) {
      p = (async () => ({
        base: await loadLeadTimeBase(
          scopeToCompanyIdOrOpen(sb.from('mrp_category_lead_times').select(LEAD_TIME_SELECT), companyId)),
        overrides: await loadSupplierCategoryOverrides(
          scopeToCompanyIdOrOpen(sb.from('mrp_supplier_category_lead_times').select(LEAD_OVERRIDE_SELECT), companyId)),
        buffers: c?.env?.DB ? await loadLeadBuffers(c.env.DB) : NO_BUFFERS,
      }))();
      leadByCompany.set(companyId, p);
    }
    return p;
  };

  const perPo: ReviseBoundPoResult['perPo'] = [];
  for (const po of scopedPos) {
    const nextRevision = await snapshotPo(sb, po.id, amendmentId, userId, c);
    let linesRederived = 0;
    let linesRemoved = 0;
    let linesAdded = 0;

    for (const pi of matchedByPo.get(po.id) ?? []) {
      const revised = revisedById.get(pi.so_item_id as string)!;
      const { patch, warnings: lineWarnings } = await rederivePoLineFromSoLine(sb, {
        poLineId: pi.id, currentQty: pi.qty, po, soCompanyId, revised,
      });
      warnings.push(...lineWarnings);
      const { error: updErr } = await withReceivedFloor(sb.from('purchase_order_items').update(patch).eq('id', pi.id), pi.id, Number(patch.qty));
      if (updErr) {
        throw receivedFloorFromDb(updErr, pi.id, Number(patch.qty))
          ?? new Error(`reviseBoundPo: PO line update failed for ${pi.id}: ${updErr.message}`);
      }
      linesRederived += 1;
    }

    for (const orow of orphansByPo.get(po.id) ?? []) {
      const receivedQty = Number(orow.received_qty ?? 0);
      const label = (orow.material_name || orow.item_code || 'a removed item').trim();
      if (receivedQty > 0) {
        warnings.push(`A removed item (${label}) was already received on purchase order ${po.po_number}, so it was left on the purchase order and needs manual handling (for example, a purchase return).`);
        continue;
      }
      const retire = await retiredLineOf(
        sb as unknown as Parameters<typeof retiredLineOf>[0], 'purchase_order_items', String(orow.id),
      );
      const { error: delErr } = await sb.from('purchase_order_items').delete().eq('id', orow.id);
      if (delErr) throw new Error(`reviseBoundPo: orphan PO line delete failed for ${orow.id}: ${delErr.message}`);
      retired.push(...retire);
      linesRemoved += 1;
    }

    /* Owner 2026-09-10 — added lines go at the END of the purchase order, in
       the order the SALES ORDER holds them (lib/po-line-order.ts). Read once
       per PO and incremented locally: the rows are inserted one at a time, so
       re-reading the max between them would cost a round trip per line. */
    const addsForPo = sortBySourceSoLine(
      (addedByPo.get(po.id) ?? []).map((a) => ({
        add: a,
        soDocNo: (a.line as { doc_no?: string | null }).doc_no ?? null,
        soLineNo: (a.line as { line_no?: number | null }).line_no ?? null,
      })),
    );
    let nextLineNo = await nextPoLineNo(sb, po.id);
    const lead = addsForPo.length > 0 ? await leadFor(po.company_id) : null;
    let supplierCode: string | null = null;
    if (lead && po.supplier_id && Object.keys(lead.buffers.supplierBufferDays).length > 0) {
      const { data: sup, error: supErr } = await sb.from('suppliers').select('code').eq('id', po.supplier_id).maybeSingle();
      if (supErr) throw new Error(`reviseBoundPo: supplier code read failed for PO ${po.id}: ${supErr.message}`);
      supplierCode = (sup as { code?: string | null } | null)?.code ?? null;
    }
    for (const { add } of addsForPo) {
      const line = add.line;
      const qty = line.qty != null ? Math.max(1, line.qty) : 1;
      const itemGroup = line.item_group;
      const variants = line.variants;
      const unitPriceSen = await deriveMfgPoUnitCost(sb, {
        supplierId: po.supplier_id ?? '',
        companyId:  po.company_id,
        itemCode:   line.item_code ?? '',
        itemGroup,
        variants:   variants ?? null,
      });
      const leadDays = resolveLeadDays(lead!.base, lead!.overrides, lead!.buffers, {
        warehouseId: line.warehouse_id ?? null,
        category: itemGroup ?? null,
        supplierId: po.supplier_id,
        supplierCode,
        deliveryDate: line.line_delivery_date ?? null,
      });
      const { error: insErr } = await sb.from('purchase_order_items').insert({
        ...(po.company_id != null ? { company_id: po.company_id } : {}),
        purchase_order_id: po.id,
        line_no:           nextLineNo,
        material_kind:     'mfg_product',
        item_code:     line.item_code ?? '',
        material_name:     line.description ?? line.item_code ?? '',
        supplier_sku:      add.supplierSku ?? '',
        qty,
        unit_price_sen:  unitPriceSen,
        line_total_sen:  qty * unitPriceSen,
        delivery_date:     subtractCalendarDays(line.line_delivery_date, leadDays.total),
        warehouse_id:      line.warehouse_id,
        item_group:        itemGroup,
        variants,
        description2:      buildVariantSummary(String(itemGroup ?? ''), variants ?? null) || null,
        so_item_id:        add.soItemId,
        photo_urls:        line.photo_urls ?? [],
        from_mrp:          false,
      });
      if (insErr) throw new Error(`reviseBoundPo: added PO line insert failed for SO line ${add.soItemId}: ${insErr.message}`);
      nextLineNo += 1;
      linesAdded += 1;
    }

    const { data: liveLines, error: liveErr } = await sb
      .from('purchase_order_items')
      .select('line_total_sen, delivery_date')
      .eq('purchase_order_id', po.id);
    if (liveErr) throw new Error(`reviseBoundPo: PO lines re-read failed for ${po.id}: ${liveErr.message}`);
    const rows = (liveLines ?? []) as Array<{ line_total_sen: number | null; delivery_date: string | null }>;
    const subtotal = rows.reduce((s, r) => s + Number(r.line_total_sen ?? 0), 0);
    const dates = rows.map((r) => r.delivery_date).filter((d): d is string => Boolean(d)).sort();

    if (rows.length === 0 && linesRemoved > 0) {
      warnings.push(`Every item on purchase order ${po.po_number} was removed from the sales order, so it now has no lines and may need to be cancelled.`);
    }

    const { error: bumpErr } = await sb.from('purchase_orders').update({
      subtotal_sen: subtotal,
      total_sen:    subtotal,
      expected_at:    dates[0] ?? null,
      revision:       nextRevision,
      updated_at:     new Date().toISOString(),
    }).eq('id', po.id);
    if (bumpErr) throw new Error(`reviseBoundPo: PO revision bump failed for ${po.id}: ${bumpErr.message}`);

    await recordSoAudit(sb, {
      docNo,
      action: 'AMENDMENT_PO_REVISED',
      actorId: userId,
      actorName: realActorName(c),
      fieldChanges: [
        { field: 'amendment_id', to: amendmentId },
        { field: 'po_number', to: po.po_number },
        { field: 'po_revision', from: nextRevision - 1, to: nextRevision },
        { field: 'lines_rederived', to: linesRederived },
        { field: 'lines_removed', to: linesRemoved },
        { field: 'lines_added', to: linesAdded },
      ],
      note: `PO ${po.po_number} reconciled to revised SO ${docNo} (rev ${nextRevision}): `
        + `${linesRederived} re-derived, ${linesRemoved} removed, ${linesAdded} added`,
    });

    perPo.push({ poId: po.id, poNumber: po.po_number, revision: nextRevision, linesRederived, linesRemoved, linesAdded });
  }

  return { revisedPoIds: perPo.map((p) => p.poId), perPo, warnings, retired };
}
