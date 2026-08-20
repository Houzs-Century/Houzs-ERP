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
import {
  loadMaintenanceConfig,
  recomputeOneLine,
  type MfgItemForRecompute,
  type TrustSelling,
} from './mfg-pricing-recompute';
import { recordSoAudit, type FieldChange } from './so-audit';
import { deriveMfgPoUnitCost } from './po-pricing';
import { readMfgProductBindings } from './supplier-bindings';
import {
  rederiveDeliveryFee,
  deriveCountryFromState,
  deriveSalesLocationFromState,
  deriveWarehouseIdFromState,
} from '../routes/mfg-sales-orders';
import { activeCompanyId, isMirroredDocNo, houzsOwns2990 } from './companyScope';
import { todayMyt } from './my-time';
import { dateOrNull } from './date-coerce';
import { soWarehouseIdForDoc } from './so-warehouse';
import { routingNote, type AmendmentFieldKind } from '../shared/amendment-routing';
import { soAmendableHeaderFields } from '../shared/so-field-policy';
import { canonicaliseSoHeaderChanges } from '../shared/so-processing-date';

/* The routable field atoms an SO amendment moves — lines + header — for the audit
   routing note. Mirrors the frontend amendmentLineFieldKinds / soHeaderFieldKind
   so the recorded accountability matches what the detail page and PDF show. All
   amendable SO header keys are scheduling / delivery-address (WHEN / WHERE) →
   DELIVERY. */
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
    if (l.new_variants != null && JSON.stringify(l.new_variants) !== JSON.stringify(old.variants ?? null)) kinds.push('VARIANT');
    if (l.new_qty != null && Number(l.new_qty) !== Number(old.qty ?? NaN)) kinds.push('QTY');
    if (l.new_unit_price_sen != null && Number(l.new_unit_price_sen) !== Number(old.unit_price_sen ?? old.unitPriceSen ?? NaN)) kinds.push('PRICE');
  }
  if (headerChanges) {
    for (const key of Object.keys(headerChanges)) {
      // Every amendable SO header key is a delivery/scheduling change -> Logistics.
      if (key === 'notes') continue;
      kinds.push('DELIVERY');
    }
  }
  return kinds;
}

/* The Supabase client threaded through the routes is loosely typed (`any` in
   every sibling helper — see mfg-pricing-recompute.ts / so-audit callers). Keep
   the same shape so this file composes with them without a type fight. */
type Sb = any;

/* The amendment audit rows below stamp the pinned SCM system `userId` as actor_id
   (the bridge pins every caller to one super_admin row — see scm/middleware/auth).
   Left to look itself up, recordSoAudit would snapshot the SYSTEM row's name, so
   "who approved" would read as the system for SO_APPROVED / PO_REVISED. Resolve
   the REAL Houzs caller's name off the request context and pass it explicitly, the
   way the sibling gate audits in routes/so-amendments.ts already do. */
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
  /* mig 0119 — the HEADER half of the request: { camelCaseKey: newValue|null }
     for the frozen columns only. NULL on a line-only amendment. */
  header_changes?: Record<string, string | null> | null;
};

/* ── assertNotMirrored — the last gate before either engine mutates ─────────
   Both engines below rewrite a Sales Order and its bound PO from an amendment
   id. If that SO is 2990's, the next 2990 mirror drain re-applies 2990's
   version over the top — header upsert plus delete-then-reinsert of every line
   — so the whole re-derivation vanishes with no error and no alarm, and the
   operator is left believing an approval landed that did not (see the
   MIRRORED_COMPANY_CODE block in lib/companyScope.ts).

   The route gate in routes/so-amendments.ts already refuses these, so this is
   defence in depth — but it belongs HERE too, because these are exported
   library functions reachable from any future caller, and because the doc-no
   marker needs no Context: the guard still holds on the `c`-less call the
   signature allows, where a company_id lookup would silently no-op. */
function assertNotMirrored(docNo: string, fn: string, c?: Context<any>): void {
  // Flip-gated (task #15): post-flip (HOUZS_OWNS_2990) Houzs owns the 2990-
  // namespace and its revision engines may rewrite these SOs/POs. c is absent in
  // the unit tests → guard stays active (pre-flip default).
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
  change_type: string;                 // SPEC | QTY | ADD | REMOVE
  new_item_code: string | null;
  new_variants: Record<string, unknown> | null;
  new_qty: number | null;
  new_unit_price_sen: number | null;
  /* Mig 0280 — the requested REMARK. NULL = the request does not touch it (every
     row created before 0280, and every line whose remark did not move); '' = a
     real request to clear it. The `!= null` test at the write is the ONE gate,
     so approving an old amendment can never blank a remark typed since. */
  new_remark: string | null;
  old_snapshot: Record<string, unknown> | null;
};

/* ── snapshotSo ─────────────────────────────────────────────────────────────
   Freeze the SO's CURRENT state (header + all items) into a `so_revisions` row
   at the SO's CURRENT `revision`, so the version being replaced stays immutable.
   Returns the NEXT revision number (current + 1) for the caller to stamp on the
   SO after applying the diffs.

   Idempotent-safe: the `uq_so_revision (so_doc_no, revision)` unique index means
   a re-run at the same revision no-ops on conflict (ignoreDuplicates) rather
   than doubling the snapshot — so an Approve-SO retry after a mid-apply failure
   can't create two snapshots at the same counter. */
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

  /* Freeze the SO line -> bound-PO line linkage NOW, while it is still intact.
     purchase_order_items.so_item_id is a FK with ON DELETE SET NULL (verified on
     the live schema), so the instant applySoAmendment REMOVEs an SO line the
     database wipes that PO line's ONLY trace of which SO line it served — the
     line survives, unlinked, and keeps ordering + billing an item the customer
     no longer has. This snapshot runs BEFORE any line is removed, so it is the
     one moment that mapping still exists; the Approve-PO gate (reviseBoundPo)
     reads it back to find and reconcile the orphaned PO line. Keyed
     SO-line-id -> [bound PO line ids]; empty when no PO is bound yet.

     Idempotent by construction: this whole row upserts with ignoreDuplicates on
     (so_doc_no, revision), so an Approve-SO retry (which runs AFTER the removal,
     when the link is already gone) cannot overwrite the good pre-removal
     capture — the first snapshot wins. */
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
        // company_id: active company (mig 0080 nullable column); no-op pre-activation.
        company_id:   c ? activeCompanyId(c) : undefined,
      },
      { onConflict: 'so_doc_no,revision', ignoreDuplicates: true },
    );
  if (insErr) throw new Error(`snapshotSo: revision insert failed: ${insErr.message}`);

  return currentRevision + 1;
}

/* ── SoAmendmentApproval — the signature a requested PRICE rides in on ───────
   `so_amendment_lines.new_unit_price_sen` is written straight from the browser
   at submit time and is validated nowhere (mig 0080 gives it a bare nullable
   `integer`; amendment-lines.ts copies `l.newUnitPriceSen` verbatim, unlike
   itemGroup and remark which it re-reads from the record). It is a REQUEST, not
   a fact, and the submit gate is deliberately wide — `scm.amendment.create` OR
   any Sales-org user OR a lane approver (mfg-sales-orders.ts).

   So the thing that makes a requested price payable is not the payload. It is
   the APPROVE gate: `PATCH /so-amendments/:id/approve-so` checks
   `scm.amendment.approve_lines` / `approve_delivery` / `approve_so` and a legal
   status transition before it calls this engine. This value is that gate's
   receipt, constructed only there, and it is a REQUIRED argument with no
   default — a future caller cannot inherit price authority by forgetting to
   think about it, it has to write `null` and take the catalogue behaviour.

   `null` = no approval is being claimed: the requested price is not read at
   all, and the line re-prices from the catalogue exactly as it did before. */
export type SoAmendmentApproval = {
  /** The user the approve gate authenticated. */
  approvedByUserId: string;
  /** The permission key that gate demanded, so the audit records which
   *  signature the price rode in on. */
  approvalPermission: string;
};

/* ── applySoAmendment ───────────────────────────────────────────────────────
   The Approve-SO engine. Load the amendment + its line diffs + the SO; snapshot
   the current SO; apply each diff to mfg_sales_order_items carrying ALL variant
   columns; re-run the honest-pricing recompute on every surviving line via the
   SAME shared path POST /mfg-sales-orders uses; re-derive the delivery fee +
   header totals; bump the SO's revision; write an audit row.

   Returns the applied revision + the affected SO doc_no. Throws on a hard
   failure (load / write) — the caller (approve-so route) leaves the amendment
   status unchanged so the operator can retry.

   `c`, `concurrency` and `approval` are all REQUIRED-with-an-explicit-empty
   value rather than optional: each of them DECIDES something (company scope,
   the optimistic lock, whether a requested price is payable), and CLAUDE.md's
   rule is that such a parameter must fail to compile when it is forgotten
   instead of silently taking the old behaviour. */
export async function applySoAmendment(
  sb: Sb,
  amendmentId: string,
  userId: string | null,
  c: Context<any> | undefined,
  concurrency: { soVersion: number; leaseToken: string } | null,
  approval: SoAmendmentApproval | null,
): Promise<{ soDocNo: string; revision: number }> {
  // (1) Load amendment + lines + SO header.
  const { data: amdRow, error: amdErr } = await sb
    .from('so_amendments')
    .select('id, so_doc_no, status, header_changes')
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
      'new_qty, new_unit_price_sen, new_remark, old_snapshot')
    .eq('amendment_id', amendmentId);
  if (lineErr) throw new Error(`applySoAmendment: amendment lines load failed: ${lineErr.message}`);
  const amendmentLines = (lineRows ?? []) as AmendmentLineRow[];

  // (2) Snapshot the CURRENT SO before touching a single line. Returns the next
  //     revision to stamp once the diffs land.
  const nextRevision = await snapshotSo(sb, docNo, amendmentId, userId, c);

  // Multi-company: an ADD-line diff inserts a new mfg_sales_order_items row —
  // it inherits the SO header's company (NOT the request's active company: an
  // amendment may be approved while another company is active).
  /* Throws, like every other load in this function (and per its docblock) — the
     approve-so route catches it, leaves the amendment status unchanged and lets the
     operator retry; snapshotSo's upsert is idempotent on (so_doc_no, revision), so
     the retry is clean. This read was the one exception, and `?? null` does not
     fail closed: the ADD-line insert below OMITS company_id when this is null, and
     mig 0091 gave the column a HOUZS DEFAULT — so a blip books a 2990 order's new
     line to Houzs, silently, exactly as the note on that insert warns. */
  const { data: soHdrCo, error: soHdrCoErr } = await sb.from('mfg_sales_orders')
    .select('company_id, linked_ac_docno').eq('doc_no', docNo).maybeSingle();
  if (soHdrCoErr) throw new Error(`applySoAmendment: SO company load failed: ${soHdrCoErr.message}`);
  const soCompanyId = (soHdrCo as { company_id?: number | null } | null)?.company_id ?? null;

  /* Is this order MIGRATED from AutoCount? `linked_ac_docno` is the marker that
     actually exists on the SO header (migration 0271); `migrated_no_stock` lives
     only on scm.grns / scm.delivery_orders and is NOT available here.

     It decides whether an approved amendment may re-price the line. For a NATIVE
     order the answer stays what it has always been — re-price to the current
     catalogue, the owner's authoritative default. For a MIGRATED order it must
     not: that unit price is what AutoCount recorded as negotiated with the
     customer, and mfg_products.sell_price_sen is in no sense a better answer for
     an order this ERP never priced. Approving even a QTY-ONLY amendment used to
     overwrite it.

     'including-zero' rather than plain `true` because a migrated sofa is
     routinely carried as the whole-set price on ONE lead module line with 0 on
     its siblings. Plain `true` reads a stored 0 as "not provided" and hands the
     sibling a catalogue price anyway, which bills the set several times over. */
  const soIsMigrated = ((soHdrCo as { linked_ac_docno?: string | null } | null)?.linked_ac_docno ?? null) !== null;

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

  /* An ADD line is authored NOW, so 'including-zero' must never reach it even on
     a migrated order — that flag is a statement about a price AutoCount already
     recorded, and a line typed today has no such history (mfg-pricing-recompute's
     own note on the flag says so). Same approval gate.

     DELIBERATELY NOT 'operator-zero', unlike amendTrust above (2026-08-19). An
     ADD line still reads 0 as "not provided" and takes the catalogue figure.
     so-revision.amendmentPrice.test.ts pins that for a migrated order in as many
     words, and it is a real protection rather than an accident of the old flag:
     an ADD line names a SKU and nothing else about it is established yet, so a 0
     there is far likelier to be an unfilled field than an intended giveaway.
     Editing an EXISTING line is the opposite case — the line already carries a
     price, and moving it to 0 is a deliberate act on a known amount.

     So Add and Edit differ on 0, on purpose. A gift that genuinely belongs on a
     locked order goes through the free-item path, not a hand-typed 0. Revisit
     only with the owner, and update that test in the same breath. */
  const addLineTrust: TrustSelling = approval !== null;

  // Config loaded ONCE and threaded into every per-line recompute (the create
  // path's `cachedConfig` — one maintenance_config read for the whole apply).
  const cachedConfig = await loadMaintenanceConfig(sb);

  /* (3) Apply each line diff to mfg_sales_order_items, carrying ALL variant
     columns. SPEC rewrites item_code + variants (+ optional qty/price); QTY
     rewrites qty; ADD inserts a new line; REMOVE deletes the line. Each write
     that changes/adds a priced line is followed by (4) the honest-pricing
     recompute so unit/cost/margin/breakdown columns stay authoritative. */
  const touched: Array<{ change: string; itemCode: string; qty: number }> = [];

  /* Per-field from -> to for the SO's OWN audit trail (Owner 2026-07-19: every
     edit anywhere in the system must show who, when, and what changed from ->
     to, reachable from the document's own page).

     Until now approving an amendment recorded only "lines_applied: 3" and a
     coarse note like "SPEC SF-100; QTY SF-200" — no old value for anything. The
     before values existed, but only inside so_amendment_lines.old_snapshot,
     which the audit drawer does not read. So the one moment the SO's lines are
     rewritten by somebody other than their owner was the one moment the trail
     could not say what they had been. */
  const lineChanges: FieldChange[] = [];
  const noteChange = (field: string, from: unknown, to: unknown) => {
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
      /* The same row also supplies the line's NAME and CATEGORY (owner
         2026-08-11) — see the two stamps below. One read, three uses. */
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
      /* ITEM GROUP — the requested blob first, then the line's own old snapshot,
         then the CATALOG's category (owner 2026-08-11). The catalog step is new:
         the chain used to fall straight to the literal 'others', so an added
         SVC-ADDON landed with item_group='others' while the identical SKU
         created through POST / lands 'service'. That is not cosmetic —
         isServiceLine() reads item_group, and a SERVICE line is never allocated
         stock, never gates SO readiness, never becomes MRP demand and never
         produces an inventory movement (vendor/shared/service-sku.ts). A service
         line mis-grouped as goods asks the factory to make a delivery fee.
         'others' remains the last resort for a catalog row with no category. */
      const itemGroup = String(
        variants?.itemGroup ?? diff.old_snapshot?.item_group ?? prodCategory ?? 'others',
      ).toLowerCase();
      const qty = Math.max(1, Number(diff.new_qty ?? 1));

      /* Recompute the new line (same path as POST /). `addLineTrust` is what
         stops an APPROVED added line being re-priced to the catalogue: this call
         used to pass no trust at all, so the fourteenth positional argument
         defaulted to false and the price the approver signed for a brand-new
         line was discarded on every order, migrated or not. */
      const rec = await recomputeOneLine(sb, {
        itemCode,
        itemGroup,
        qty,
        unitPriceSen: Number(diff.new_unit_price_sen ?? 0),
        variants: (variants as MfgItemForRecompute['variants']) ?? null,
      }, cachedConfig, soCompanyId, { trustOperatorSelling: addLineTrust });

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
      const addLineWarehouseId = await soWarehouseIdForDoc(sb, docNo);

      // Multi-company (mig 0083/0091): company_id is NOT NULL with a HOUZS
      // DEFAULT — an unstamped insert silently books the line to HOUZS, so the
      // ADD line explicitly inherits the SO header's company.
      const { error: insErr } = await sb.from('mfg_sales_order_items').insert({
        ...(soCompanyId != null ? { company_id: soCompanyId } : {}),
        doc_no:                  docNo,
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
        warehouse_id:           addLineWarehouseId,   // follows the SO — see above
        /* Mig 0280 — the requested REMARK rides onto the added line. This insert
           used to omit it entirely, so a SVC-ADDON line added purely to carry an
           instruction ("Please take back Cody Bedframe (King Size) 2 units")
           landed as an RM0 line saying nothing, and the person meant to execute
           it had no way to read the job. NULL stays NULL. */
        remark:                 diff.new_remark,
      });
      if (insErr) throw new Error(`applySoAmendment: ADD insert failed: ${insErr.message}`);
      lineChanges.push({ field: `line_added_${itemCode}`, from: null, to: `qty ${qty}` });
      /* The remark is its OWN audit row — an added line's note is the request in
         a service line's case, so "qty 1" alone would not say what was approved. */
      if ((diff.new_remark ?? '').trim()) {
        lineChanges.push({ field: `line_added_${itemCode}_remark`, from: null, to: diff.new_remark });
      }
      touched.push({ change, itemCode, qty });
      continue;
    }

    // SPEC / QTY — mutate an existing line in place, then recompute it.
    if (!diff.sales_order_item_id) continue;

    const { data: existing, error: exErr } = await sb
      .from('mfg_sales_order_items')
      .select('*')
      .eq('id', diff.sales_order_item_id)
      .eq('doc_no', docNo)
      .maybeSingle();
    if (exErr) throw new Error(`applySoAmendment: line load failed: ${exErr.message}`);
    if (!existing) continue; // line already gone — nothing to amend

    const row = existing as Record<string, unknown>;
    const itemCode = change === 'SPEC' && diff.new_item_code
      ? String(diff.new_item_code).trim()
      : String(row.item_code ?? '');
    const itemGroup = String(row.item_group ?? 'others').toLowerCase();
    const qty = diff.new_qty != null ? Math.max(1, Number(diff.new_qty)) : Math.max(1, Number(row.qty ?? 1));
    // SPEC carries new variants; QTY leaves the existing variants untouched.
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
       `approval === null` an unvalidated payload number is never even read. */
    const clientUnit = (approval !== null && diff.new_unit_price_sen != null)
      ? Number(diff.new_unit_price_sen)
      : Number(row.unit_price_sen ?? 0);

    /* amendTrust — see where it is derived. MIGRATED: 'including-zero', so the
       price AutoCount recorded (or the explicit new_unit_price_sen when the
       amendment supplies one) survives, zeros included. NATIVE: `true` when an
       approver signed this amendment, so the approved price persists instead of
       being normalised to the catalogue; `false` with no approval, which is the
       behaviour this path had for every native order until 2026-08-16. Either
       way a SPEC change does not silently re-price: if the new spec should cost
       differently, the amendment carries new_unit_price_sen. */
    const rec = await recomputeOneLine(sb, {
      itemCode,
      itemGroup,
      qty,
      unitPriceSen: clientUnit,
      variants: (variants as MfgItemForRecompute['variants']) ?? null,
    }, cachedConfig, soCompanyId, { trustOperatorSelling: amendTrust });

    const unit = rec.unit_price_sen;
    const discount = Number(row.discount_sen ?? 0);
    const lineTotal = (qty * unit) - discount;
    const unitCost = rec.unit_cost_sen;
    const lineCost = unitCost * qty;

    const { error: updErr } = await sb.from('mfg_sales_order_items').update({
      item_code:               itemCode,
      qty,
      variants,
      unit_price_sen:        unit,
      total_sen:             lineTotal,
      total_inc_sen:         lineTotal,
      balance_sen:           lineTotal,
      unit_cost_sen:         unitCost,
      line_cost_sen:         lineCost,
      line_margin_sen:       lineTotal - lineCost,
      divan_price_sen:         rec.divan_price_sen,
      leg_price_sen:           rec.leg_price_sen,
      special_order_price_sen: rec.special_order_sen,
      custom_specials:         rec.custom_specials ?? null,
      /* Mig 0280 — write the REMARK only when the request carries one. NULL is
         "not requested", so spreading it conditionally is what stops an
         amendment raised last week (or any row created before 0280, where the
         column is NULL by definition) from blanking a remark somebody typed on
         the line in the meantime. '' IS a request — clear it. */
      ...(diff.new_remark != null ? { remark: diff.new_remark } : {}),
    }).eq('id', diff.sales_order_item_id);
    if (updErr) throw new Error(`applySoAmendment: ${change} update failed for line ${diff.sales_order_item_id}: ${updErr.message}`);
    /* Keyed by the line's ORIGINAL item code so the drawer reads as one line's
       history rather than a flat list of fields. `variants` is compared as its
       rendered summary, built with the line's REAL item group — the same group
       the amendment card now renders with, so the trail and the card agree on
       what the spec said. */
    {
      const wasCode = String(row.item_code ?? '');
      const key = wasCode || String(diff.sales_order_item_id);
      noteChange(`line_${key}_item_code`, wasCode, itemCode);
      noteChange(`line_${key}_qty`, row.qty, qty);
      noteChange(`line_${key}_unit_price_sen`, row.unit_price_sen, unit);
      noteChange(
        `line_${key}_spec`,
        buildVariantSummary(itemGroup, (row.variants as Record<string, unknown> | null) ?? null),
        buildVariantSummary(itemGroup, variants ?? null),
      );
      // Mig 0280 — only when the request touched it (noteChange drops a no-op).
      if (diff.new_remark != null) noteChange(`line_${key}_remark`, row.remark, diff.new_remark);
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
  /* CANONICALISE THE STORED KEYS FIRST.
     `header_changes` is a jsonb written at REQUEST time and read here at APPROVE
     time — days later, across any number of deploys. The loop below `continue`s
     on a key the allow-list does not have, so a payload-key rename would make an
     already-pending amendment approve cleanly, audit cleanly, and never write
     its value. Rewriting legacy spellings onto today's keys before anything
     reads them is what stops that; it is an identity map until a rename lands.
     See shared/so-processing-date.ts for the removal condition. */
  const headerChanges = canonicaliseSoHeaderChanges(amendment.header_changes ?? null);
  const headerApplied: string[] = [];
  if (headerChanges && Object.keys(headerChanges).length > 0) {
    const headerUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(headerChanges)) {
      // hasOwnProperty, NOT `in` / a bare lookup — a stored key of "constructor"
      // would otherwise resolve to an inherited value and write a garbage column.
      if (!Object.prototype.hasOwnProperty.call(AMENDABLE_HEADER_FIELDS, key)) continue;
      const col = AMENDABLE_HEADER_FIELDS[key];
      headerUpdates[col] = value === '' ? null : value;
      headerApplied.push(`${col}=${value ?? 'cleared'}`);
    }

    /* State cascade — mirrors the header PATCH (mfg-sales-orders.ts) exactly:
       customer_country + sales_location follow the new State. Reuses the SAME
       exported derive helpers rather than re-deriving, so the mapping can't
       drift between the two write paths. */
    if ('customerState' in headerChanges) {
      const newState = headerChanges['customerState'] ?? null;
      headerUpdates['customer_country'] = await deriveCountryFromState(sb, newState);
      /* `c` is optional on this function's signature (it threads the active
         company into the scoped reads) — the only caller, the approve-so route,
         always passes it, but deriveSalesLocationFromState dereferences it, so
         guard rather than throw mid-apply. */
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

    /* Delivery-date master-follower cascade — mirrors the header PATCH: when the
       header's customer_delivery_date moves, EVERY line takes the new date and
       its per-line override flag clears, so MRP's order-by derivation (which
       reads line_delivery_date) stays accurate. Without this an approved date
       amendment would move the header but leave every line on the old date. */
    if ('customerDeliveryDate' in headerChanges) {
      const { error: cascErr } = await sb.from('mfg_sales_order_items')
        .update({
          /* Coerced, not `?? null`: the header loop twenty lines up already
             assumes a stored change can be blank (`value === '' ? null : value`),
             and the follower must not be stricter than the master it copies —
             the same asymmetry fixed at consignment-orders.ts:1299. This cascade
             is non-fatal outside atomic mode, so a 500 here would commit the
             header amendment and silently leave every line on its OLD date. */
          line_delivery_date: dateOrNull(headerChanges['customerDeliveryDate']),
          line_delivery_date_overridden: false,
        })
        .eq('doc_no', docNo);
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
    if ('customerState' in headerChanges && c) {
      const reboundWh = await deriveWarehouseIdFromState(sb, headerChanges['customerState'] ?? null, c);
      if (reboundWh) {
        const { error: whErr } = await sb
          .from('mfg_sales_order_items')
          .update({ warehouse_id: reboundWh })
          .eq('doc_no', docNo)
          .eq('cancelled', false);
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

  /* (4-continued) Re-derive the delivery fee (rebuilds SVC-DELIVERY* lines on
     the authoritative computeSoDeliveryFee) AND fold header totals — the same
     helper the create + add-line paths call after a line change; it internally
     runs recomputeTotals. Legacy callers are best-effort; atomic commands
     rethrow so the enclosing transaction rolls back. */
  try {
    await rederiveDeliveryFee(sb, docNo, c);
  } catch (e) {
    if ((sb as unknown as { __atomicCommand?: boolean }).__atomicCommand === true) throw e;
    // eslint-disable-next-line no-console
    console.error('[so-amendment] rederiveDeliveryFee failed (non-fatal):', e);
  }

  // (5) Bump the SO's revision + updated_at.
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

  // (6) Audit — best-effort, keyed on the SO doc_no like every other SO mutation.
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
      /* Which signature made the requested prices payable. Recorded because from
         2026-08-16 an approved amendment can move MONEY on a locked SO, and the
         drawer has to be able to say under whose authority — the per-line
         `..._unit_price_sen` rows below say what moved, this says why it could. */
      ...(approval ? [{ field: 'price_authority', to: approval.approvalPermission }] : []),
      /* Accountability: the type/department routing this single approval covers.
         The apply stays single-signature — this records WHICH routed fields the
         approver signed for, it does not split the gate. */
      ...(routingSummary ? [{ field: 'routing', to: routingSummary }] : []),
      /* The per-line from -> to the drawer needs to answer "what did this line
         say before the amendment rewrote it". Appended AFTER the summary rows so
         the existing header of the entry is unchanged for any reader used to it. */
      ...lineChanges,
    ],
    note: `Amendment applied: ${[
      touched.map((t) => `${t.change} ${t.itemCode}`).join('; ') || null,
      headerApplied.length > 0 ? `header ${headerApplied.join(', ')}` : null,
      routingSummary ? `routing ${routingSummary}` : null,
    ].filter(Boolean).join('; ') || 'no diffs'}`,
  });

  return { soDocNo: docNo, revision: nextRevision };
}

/* ── snapshotPo ─────────────────────────────────────────────────────────────
   Mirror of snapshotSo for a Purchase Order. Freeze the PO's CURRENT state
   (header + all items) into a `po_revisions` row at the PO's CURRENT `revision`,
   so the version being replaced stays immutable. Returns the NEXT revision
   number (current + 1) for the caller to stamp on the PO after re-deriving.

   Idempotent-safe: the `uq_po_revision (po_id, revision)` unique index means a
   re-run at the same revision no-ops on conflict (ignoreDuplicates). */
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

  const { data: lines, error: lErr } = await sb
    .from('purchase_order_items')
    .select('*')
    .eq('purchase_order_id', poId)
    .order('created_at', { ascending: true, nullsFirst: true });
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
        // company_id: active company (mig 0080 nullable column); no-op pre-activation.
        company_id:   c ? activeCompanyId(c) : undefined,
      },
      { onConflict: 'po_id,revision', ignoreDuplicates: true },
    );
  if (insErr) throw new Error(`snapshotPo: revision insert failed: ${insErr.message}`);

  return currentRevision + 1;
}

/* ── reviseBoundPo ──────────────────────────────────────────────────────────
   The Approve-PO engine. For an amendment whose SO has already been revised
   (Approve-SO ran first), reconcile every bound PO so its line SET matches the
   NOW-REVISED SO, using the SAME derivation "Create PO from SO" uses. Three
   moves, because an amendment can change the line SET, not just a line's fields:

     • RE-DERIVE a surviving line — each PO line is 1:1 with a SO line via
       `purchase_order_items.so_item_id`; carry the SO line's qty / variants /
       item_group / description2 / per-line warehouse + delivery date and
       re-derive the supplier COST (`unit_price_sen`) from the revised spec
       (deriveMfgPoUnitCost — a fabric/spec swap re-prices; never carry the old
       figure). Scope note: the create path additionally re-spreads a SOFA-COMBO
       total across a matched module set; that group step is NOT reproduced here.

     • REMOVE an orphaned line — when an amendment REMOVEs an SO line, its bound
       PO line is otherwise left ordering + billing an item the customer no longer
       has (the company eats the cost). It CANNOT be found by so_item_id: that FK
       is ON DELETE SET NULL (verified on the live schema), so deleting the SO
       line already wiped the PO line's only link. Instead we read the SO→PO
       linkage snapshotSo froze at Approve-SO — the one moment before removal —
       and delete exactly those PO lines. A line already (partly) received is NOT
       deleted (goods already received are not ours to discard); it is left in
       place and surfaced as a plain-language warning for manual handling.

     • ADD a missing line — when an amendment ADDs an SO line, no PO line exists
       for it (item sold but never ordered → stock shortfall). We insert one on
       the live bound PO whose supplier matches the added line's main-supplier
       binding, priced with the SAME deriveMfgPoUnitCost and carrying the same
       per-line warehouse/date the create path stamps. If no open bound PO belongs
       to that supplier (or the SKU has no supplier bound), we do NOT invent a new
       PO here — raising one is the create path's decision — and warn instead.

   Only THEN is the existing PO subtotal recompute correct: the line SET matches.

   Houzs note: the SO line's per-line delivery date column is `line_delivery_date`
   (2990's was `delivery_date`); the bound PO line's own column stays
   `delivery_date`.

   Bound PO discovery: the surviving SO lines' so_item_id ∪ the snapshot's frozen
   links for removed lines → distinct non-cancelled purchase_orders. No bound PO
   ⇒ NO-OP.

   Received floor: BEFORE mutating anything, any SURVIVING PO line whose revised
   SO qty would drop below its already-received_qty ABORTS the whole revision
   (receivedFloorViolation). An orphaned (removed) line already received is warned,
   not aborted.

   Idempotency: re-running Approve-PO cannot double anything — an added line is
   skipped once a PO line already carries its so_item_id, an orphan delete no-ops
   once the line is gone, and snapshotPo upserts idempotently on (po_id, revision). */
export type ReviseBoundPoResult = {
  revisedPoIds: string[];
  perPo: Array<{
    poId: string; poNumber: string; revision: number;
    linesRederived: number; linesRemoved: number; linesAdded: number;
  }>;
  /* Plain-language notes for the operator about anything that needs a human hand:
     an orphaned line left in place because it was already received, an added item
     whose supplier has no open PO, or a PO left with no lines at all. */
  warnings: string[];
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

export async function reviseBoundPo(
  sb: Sb,
  amendmentId: string,
  userId: string | null,
  c?: Context<any>,
  /* onlyPoId — revise ONE bound PO instead of all (two-lane rework 2026-07-27):
     the PO-Amendments confirm gate approves one follow-up at a time, so its
     apply must not touch the sibling POs still awaiting their own confirms.
     Unscoped (the legacy approve-po gate) keeps the original revise-all. */
  opts?: { onlyPoId?: string },
): Promise<ReviseBoundPoResult> {
  const noop = (): ReviseBoundPoResult => ({ revisedPoIds: [], perPo: [], warnings: [] });

  // (1) Load amendment → SO doc_no.
  const { data: amdRow, error: amdErr } = await sb
    .from('so_amendments')
    .select('id, so_doc_no, status')
    .eq('id', amendmentId)
    .maybeSingle();
  if (amdErr) throw new Error(`reviseBoundPo: amendment load failed: ${amdErr.message}`);
  if (!amdRow) throw new Error('reviseBoundPo: amendment not found');
  const docNo = (amdRow as AmendmentRow).so_doc_no;
  assertNotMirrored(docNo, 'reviseBoundPo', c);

  /* (2) The SO's company — the ADD-line supplier binding is scoped to it. The SO,
     and every PO bound to it, belong to this company; the REQUEST's active
     company may differ (an amendment can be approved while another is active), so
     scoping the binding by the active company would be the wrong tenant. Scope is
     applied ONLY when the company is known (REQUIRED-half); a genuinely unset
     company (pre-migration / single-company) degrades to no filter — never a
     cross-company `??` default. */
  const { data: soHdr, error: soHdrErr } = await sb
    .from('mfg_sales_orders')
    .select('company_id')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (soHdrErr) throw new Error(`reviseBoundPo: SO company load failed: ${soHdrErr.message}`);
  const soCompanyId = (soHdr as { company_id?: number | null } | null)?.company_id ?? null;

  /* (3) The SO→bound-PO linkage snapshotSo froze at Approve-SO, BEFORE any line
     was removed. This is the ONLY durable record of which PO line served a
     since-removed SO line (its so_item_id was SET NULL on the SO line's delete).
     Loaded by amendment_id — not "latest revision" — so a concurrent amendment on
     the same SO cannot misdirect the reconciliation. */
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

  // (4) Current (post-Approve-SO) SO line ids.
  /* CANCELLED IS REMOVED. `removed = prevLineIds \ currentIdSet` is what
     orphans the PO line a since-deleted SO line was bound to, and it is the
     only warning the supplier side ever gets. A retained cancelled row would
     stay in currentIdSet forever, so the customer's cancellation would never
     reach the supplier and the factory would keep building the item. The hard
     delete gives this for free today; the filter is what keeps it true once a
     removal becomes a soft cancel. Filtered in JS rather than SQL so a NULL —
     which the column default forbids but a partial row shape does not — reads
     as LIVE, never as removed. */
  const { data: soItemRows, error: soItemErr } = await sb
    .from('mfg_sales_order_items')
    .select('id, cancelled')
    .eq('doc_no', docNo);
  if (soItemErr) throw new Error(`reviseBoundPo: SO items load failed: ${soItemErr.message}`);
  const soItemIds = ((soItemRows ?? []) as Array<{ id: string; cancelled?: boolean | null }>)
    .filter((r) => r.cancelled !== true).map((r) => r.id);
  const currentIdSet = new Set(soItemIds);

  /* ADDED   = a current line the pre-amendment snapshot did not have (an ADD diff
               inserts a brand-new row id; SPEC/QTY reuse the same id).
     REMOVED = a snapshot line the current SO no longer has.
     With no snapshot (amendments created before this fix), we cannot classify —
     degrade to re-derive-only (no inserts, no orphan deletes), the prior
     behaviour, rather than guess. */
  const addedSoItemIds = prevLineIds.size > 0
    ? soItemIds.filter((id) => !prevLineIds.has(id))
    : [];
  const removedSoItemIds = [...prevLineIds].filter((id) => !currentIdSet.has(id));
  const orphanPoItemIds = [...new Set(removedSoItemIds.flatMap((id) => poLinks[id] ?? []))];

  // (5) Existing bound PO lines for the SURVIVING SO lines (the re-derive set).
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

  /* (6) The orphaned PO lines (removed SO lines' frozen links), read FRESH so
     received_qty + PO ownership reflect NOW. A link already deleted between the
     two gates (a re-run, or a manual delete) simply drops out here — idempotent. */
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

  // (7) Candidate POs = those serving a surviving line ∪ those holding an orphan.
  //     Empty ⇒ no PO is bound to this SO at all ⇒ NO-OP (an added line will be
  //     picked up when the PO is first raised; a removed line has no orphan).
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
  // Exclude cancelled POs — a cancelled PO is not a live obligation (nor billing).
  const livePos = ((poHeaders ?? []) as Array<{
    id: string; po_number: string; status: string; revision: number | null;
    supplier_id: string | null; purchase_location_id: string | null; company_id: number | null;
  }>).filter((p) => String(p.status).toUpperCase() !== 'CANCELLED');
  if (livePos.length === 0) return noop();

  /* Single-PO scope (two-lane rework) — everything downstream keys off
     scopedPos / scopedPoIds: the re-derive set, the orphan set, the ADD
     placement and the per-PO apply loop. ADD supplier-matching still consults
     the FULL livePos so a line whose supplier belongs to a SIBLING po is
     silently deferred to that PO's own confirm rather than mis-warned here. */
  const scopedPos = opts?.onlyPoId ? livePos.filter((p) => p.id === opts.onlyPoId) : livePos;
  if (scopedPos.length === 0) return noop();
  const scopeCoversAll = scopedPos.length === livePos.length;
  const livePoIds = new Set(scopedPos.map((p) => p.id));

  // (8) Re-read the NOW-REVISED SO lines keyed by id (the derivation source).
  //     Houzs: the per-line delivery date column is `line_delivery_date`.
  const { data: revisedSoRows, error: revErr } = await sb
    .from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, variants, warehouse_id, line_delivery_date, description, photo_urls')
    .in('id', soItemIds);
  if (revErr) throw new Error(`reviseBoundPo: revised SO lines load failed: ${revErr.message}`);
  type RevisedLine = {
    item_code: string | null; item_group: string | null; qty: number | null;
    variants: Record<string, unknown> | null; warehouse_id: string | null;
    line_delivery_date: string | null; description: string | null;
    // Owner 2026-08-10 (migration 0274) — an SO line's photos follow it onto the
    // PO line, the same on this amendment path as on the convert paths.
    photo_urls: string[] | null;
  };
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

  // Only the PO items on a LIVE bound PO whose SO line still exists = re-derive set.
  const targetPoItems = allPoItems.filter(
    (pi) => pi.purchase_order_id && livePoIds.has(pi.purchase_order_id)
      && pi.so_item_id && revisedById.has(pi.so_item_id),
  );

  // (9) RECEIVED-FLOOR PRE-CHECK — abort BEFORE any mutation. A SURVIVING PO
  //     line's revised qty must not drop below what's already received. (An
  //     orphaned/removed line that is received is handled by warning in (12b),
  //     not by aborting the whole revision.)
  for (const pi of targetPoItems) {
    const revised = revisedById.get(pi.so_item_id as string)!;
    const receivedQty = Number(pi.received_qty ?? 0);
    if (receivedFloorViolation({ newQty: revised.qty }, { receivedQty })) {
      throw new ReceivedFloorError(pi.id, Number(revised.qty), receivedQty);
    }
  }

  /* (10) Resolve each newly ADDED line (one with no PO line yet) to its supplier
     and its target bound PO. Supplier = the SKU's main-supplier binding, scoped
     to the SO's company. Target PO = a live bound PO on this SO whose supplier
     matches, preferring one whose warehouse matches the line's (mirrors the
     create path's (warehouse, supplier) bucket). No matching open PO, or no
     supplier bound at all, is NOT auto-resolved by inventing a PO here — it is
     warned so the operator raises one. */
  const warnings: string[] = [];
  const addedNeedingPo = addedSoItemIds.filter((id) => !boundSoItemIdSet.has(id) && revisedById.has(id));
  const addedByPo = new Map<string, Array<{ soItemId: string; line: RevisedLine; supplierSku: string | null }>>();
  if (addedNeedingPo.length > 0) {
    const codes = [...new Set(
      addedNeedingPo.map((id) => revisedById.get(id)?.item_code).filter((x): x is string => Boolean(x)),
    )];
    const mainBindingByCode = new Map<string, { supplierId: string; supplierSku: string | null }>();
    if (codes.length > 0) {
      /* Through the SHARED reader (lib/supplier-bindings.ts): chunked, paged and
         TOTALLY ordered. The order matters more than the size does here — the
         loop below takes "the first row seen per code" as that code's main
         supplier, and `is_main_supplier DESC` alone leaves every tie in
         planner order, so which alternate wins was never decided by this file. */
      const { data: bRows, error: bErr } = await readMfgProductBindings<{
        item_code: string; supplier_id: string; supplier_sku: string | null;
      }>(sb, {
        codes,
        companyId: soCompanyId,
        select: 'item_code, supplier_id, supplier_sku, is_main_supplier',
      });
      if (bErr) throw new Error(`reviseBoundPo: added-line supplier binding load failed: ${bErr.message}`);
      // is_main_supplier DESC → the first row seen per code is its main supplier.
      for (const b of (bRows ?? []) as Array<{ item_code: string; supplier_id: string; supplier_sku: string | null }>) {
        if (!mainBindingByCode.has(b.item_code)) {
          mainBindingByCode.set(b.item_code, { supplierId: b.supplier_id, supplierSku: b.supplier_sku ?? null });
        }
      }
    }
    for (const soItemId of addedNeedingPo) {
      const line = revisedById.get(soItemId)!;
      const itemCode = line.item_code ?? '';
      const label = (line.description || itemCode || 'a new item').trim();
      const binding = itemCode ? mainBindingByCode.get(itemCode) : undefined;
      if (!binding) {
        /* Scoped confirm: this warning belongs to whichever confirm can act on
           it. Emit it only when the scope covers every bound PO, so a partial
           confirm doesn't false-alarm about a sibling PO's item. */
        if (scopeCoversAll) warnings.push(`A newly added item (${label}) has no supplier set, so it could not be added to a purchase order. Set its main supplier, then raise a purchase order for it.`);
        continue;
      }
      const forSupplier = livePos.filter((p) => p.supplier_id === binding.supplierId);
      const target = forSupplier.find((p) => p.purchase_location_id && p.purchase_location_id === line.warehouse_id)
        ?? forSupplier[0];
      if (!target) {
        if (scopeCoversAll) warnings.push(`A newly added item (${label}) is from a supplier that has no open purchase order on this sales order, so a purchase order still needs to be raised for it.`);
        continue;
      }
      // Out-of-scope target = a sibling PO's line; its own confirm inserts it.
      if (!livePoIds.has(target.id)) continue;
      const arr = addedByPo.get(target.id) ?? [];
      arr.push({ soItemId, line, supplierSku: binding.supplierSku });
      addedByPo.set(target.id, arr);
    }
  }

  // (11) Group the re-derive + orphan work per PO.
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

  // (12) Per live bound PO: snapshot, re-derive surviving lines, delete orphaned
  //      lines (warn if received), insert added lines, recompute totals, bump,
  //      audit.
  const perPo: ReviseBoundPoResult['perPo'] = [];
  for (const po of scopedPos) {
    const nextRevision = await snapshotPo(sb, po.id, amendmentId, userId, c);
    let linesRederived = 0;
    let linesRemoved = 0;
    let linesAdded = 0;

    // (12a) RE-DERIVE each surviving line in place from its revised SO line.
    for (const pi of matchedByPo.get(po.id) ?? []) {
      const revised = revisedById.get(pi.so_item_id as string)!;
      // Read the existing PO line's discount + item_code (the SKU the
      // supplier binding is keyed on).
      const { data: existing, error: exErr } = await sb
        .from('purchase_order_items')
        .select('item_code, discount_sen')
        .eq('id', pi.id)
        .maybeSingle();
      if (exErr) throw new Error(`reviseBoundPo: PO line load failed: ${exErr.message}`);
      const discountSen = Number((existing as { discount_sen?: number } | null)?.discount_sen ?? 0);
      const qty = revised.qty != null ? Math.max(1, revised.qty) : Number(pi.qty ?? 1);
      const itemGroup = revised.item_group;
      const variants = revised.variants;
      // Re-derive the revised PO line's supplier cost from the NOW-REVISED SO
      // line's spec (SAME cost-anchor "Create PO from SO" runs). The SKU the cost
      // is keyed on = the revised SO line's item_code (a SPEC change may swap it),
      // falling back to the PO line's existing item_code.
      const itemCode = revised.item_code
        ?? String((existing as { item_code?: string } | null)?.item_code ?? '');
      const unitPriceSen = await deriveMfgPoUnitCost(sb, {
        supplierId: po.supplier_id ?? '',
        itemCode:   itemCode,
        itemGroup,
        variants:   variants ?? null,
      });

      const { error: updErr } = await sb.from('purchase_order_items').update({
        qty,
        unit_price_sen: unitPriceSen,
        line_total_sen: qty * unitPriceSen - discountSen,
        item_group:       itemGroup,
        variants,
        description2:     buildVariantSummary(String(itemGroup ?? ''), variants ?? null) || null,
        warehouse_id:     revised.warehouse_id,
        delivery_date:    revised.line_delivery_date,
      }).eq('id', pi.id);
      if (updErr) throw new Error(`reviseBoundPo: PO line update failed for ${pi.id}: ${updErr.message}`);
      linesRederived += 1;
    }

    /* (12b) DELETE each orphaned line whose SO line was removed — UNLESS it has
       already been (partly) received, in which case deleting it would discard a
       receipt: leave it in place and warn for manual handling. Idempotent: a
       re-run finds the line already gone (it dropped out of orphanRows above). */
    for (const orow of orphansByPo.get(po.id) ?? []) {
      const receivedQty = Number(orow.received_qty ?? 0);
      const label = (orow.material_name || orow.item_code || 'a removed item').trim();
      if (receivedQty > 0) {
        warnings.push(`A removed item (${label}) was already received on purchase order ${po.po_number}, so it was left on the purchase order and needs manual handling (for example, a purchase return).`);
        continue;
      }
      const { error: delErr } = await sb.from('purchase_order_items').delete().eq('id', orow.id);
      if (delErr) throw new Error(`reviseBoundPo: orphan PO line delete failed for ${orow.id}: ${delErr.message}`);
      linesRemoved += 1;
    }

    /* (12c) INSERT a PO line for each added SO line assigned to this PO — same
       column shape + cost anchor "Create PO from SO" uses. Idempotent: an added
       line that already carries a PO line was excluded from addedNeedingPo, so a
       re-run inserts nothing. company_id follows the PO's own company (authoritative
       in a cross-company approve), not the request's active company. */
    for (const add of addedByPo.get(po.id) ?? []) {
      const line = add.line;
      const qty = line.qty != null ? Math.max(1, line.qty) : 1;
      const itemGroup = line.item_group;
      const variants = line.variants;
      const unitPriceSen = await deriveMfgPoUnitCost(sb, {
        supplierId: po.supplier_id ?? '',
        itemCode:   line.item_code ?? '',
        itemGroup,
        variants:   variants ?? null,
      });
      const { error: insErr } = await sb.from('purchase_order_items').insert({
        ...(po.company_id != null ? { company_id: po.company_id } : {}),
        purchase_order_id: po.id,
        material_kind:     'mfg_product',
        item_code:     line.item_code ?? '',
        material_name:     line.description ?? line.item_code ?? '',
        supplier_sku:      add.supplierSku ?? '',
        qty,
        unit_price_sen:  unitPriceSen,
        line_total_sen:  qty * unitPriceSen,
        delivery_date:     line.line_delivery_date,
        warehouse_id:      line.warehouse_id,
        item_group:        itemGroup,
        variants,
        description2:      buildVariantSummary(String(itemGroup ?? ''), variants ?? null) || null,
        so_item_id:        add.soItemId,
        // Migration 0274 — carry the SO line's photo keys (same R2 objects).
        photo_urls:        line.photo_urls ?? [],
        from_mrp:          false,
      });
      if (insErr) throw new Error(`reviseBoundPo: added PO line insert failed for SO line ${add.soItemId}: ${insErr.message}`);
      linesAdded += 1;
    }

    // Recompute PO subtotal/total from the live lines and the header expected_at
    // = earliest non-null line delivery_date (mirrors recomputePoTotals /
    // recomputePoExpectedAt in mfg-purchase-orders.ts). NOW correct because the
    // line SET matches the revised SO (orphans gone, added lines present).
    /* The roll-up zeroing shape (BUG-HISTORY 2026-07-17, fix/zeroing-twins): the
       read below THROWS on error (unlike the log-and-skip 15), so `?? []` is not
       hiding a failed read — it is the genuinely-empty case, which is now REAL:
       an amendment can remove every line a PO served, leaving it with no lines,
       for which subtotal 0 is the correct total (and (12b) warns the operator the
       PO may need cancelling). Every load/write here throws; the approve-po route
       catches, returns 500 and does NOT advance the amendment status, so the
       operator retries and snapshotPo is idempotent on (po_id, revision). */
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

    // Audit — best-effort, keyed on the SO doc_no like every other amendment step.
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

  return { revisedPoIds: perPo.map((p) => p.poId), perPo, warnings };
}
