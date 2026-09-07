// /mfg-sales-orders — B2B sales orders (HOUZS pattern).
// Separate from retail `orders` (POS) — different lifecycle, different ID format.

import { activeSoEditLease, soCallerUserId, soLineWriteLeaseMatches, soEditLeaseExpiryIso, soEditLeaseRefusal, soEditLeaseTakeoverAllowed, type SoEditLeaseRow } from '../lib/so-edit-lease';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { normalizePhone } from '../shared/phone';
import {
  pickComboMatch, spreadComboTotal, splitSofaCode, sofaHeightKey,
  buildVariantSummary, comboChargedPrices, matchComboSubset, type SofaComboRow, type SofaPriceTier,
  oneShotSofaCode, oneShotSimpleCode, remarkSlug,
  fabricTierAddon,
  validateFreeGiftClaims, buildFreeGiftTriggers,
  type FreeGiftLineClaim, type TriggerLine,
  campaignsCoveringLine,
  isFreeItemLine,
  resolveFabricTierOverride,
  type RuleLineInput,
  passesRefinementColumns,
  splitAmendmentByLane, LANE_LABEL, type AmendmentLane,
} from '../shared';
import { computeSoDeliveryFee, type SoDeliveryFeeResult } from '../shared/pricing';
/* Special delivery fee rules (migration 0024, #691 RuleTarget) — the model |
   variant | compartment | combo matcher shared with the POS, used at BOTH
   recompute sites (create + cross-category re-detect). */
import {
  deriveCountryFromState, deriveSalesLocationFromState, senOrZero, snapshotUnitCostSen,
} from '../lib/sales-doc-derive';
export { deriveCountryFromState, deriveSalesLocationFromState };
import { specialDeliveryFeesForLines, reconstructDeliveryRuleLines } from '../lib/special-delivery';
import { soHasDownstream } from '../lib/downstream-lock';
import { dateOrNull, effectiveDateAfterPatch, isDateColumn } from '../lib/date-coerce';
import { soStatusAfterProcessingDateChange } from '../lib/so-proceed-status-change';
import { soIsMigrated } from '../lib/so-is-migrated';
import { soDocNosWithDownstream } from '../lib/downstream-lock'; // own line: autocountWritebackWiring asserts the import above verbatim
import { doNosBySalesOrder, type DeliveryOrderNoRow } from '../lib/so-delivery-order-nos';
import { soDownstreamRefs, NO_SO_DOWNSTREAM_REFS } from '../lib/downstream-doc-refs';
/* Status-transition table + the discard guards — lifted out of this file, which
   may only shrink. See lib/so-lifecycle-guards.ts. */
import { SO_STATUSES, SO_STATUS_RANK, soStatusTransitionError, soDiscardBlocked } from '../lib/so-lifecycle-guards';
import { HELD_OR_TERM, HOLD_COLUMNS, isDocumentHeld } from '../lib/document-hold';
import { mountHoldRoute } from './document-hold-routes';
import { enqueueSoCreate, enqueueCancel, enqueueEdit, retiredLineOf, type AcRetiredLine } from '../lib/autocount-outbox';
import { signalNullWarehouseRows } from '../lib/null-warehouse-signal';
/* The payment insert core, the Account Sheet rule and the payment column list
   moved to scm/lib so scan-so.ts's background writer reaches the same rules
   without importing a 12,000-line router. Re-exported below for the callers
   that still name this module. */
import { deriveAccountSheet, PAYMENT_COLS, recordSoPaymentRow, afterSoPaymentRemoved, bookSoPaymentBestEffort, type SoPaymentRowInput } from '../lib/so-payment-row';
import { recomputeSiPaidForOrder } from '../lib/si-order-deposit';
export { recordSoPaymentRow };
export type { SoPaymentRowInput };
/* Per-compartment fabric-tier Δ (migration 0025) — reconstruct a split sofa
   build's compartment codes from its persisted module lines for the TBC path. */
import { buildCompartmentsFromModuleLines } from '../lib/compartments-from-module-lines';
/* See "THE PAIR RULE" in shared/so-processing-date.ts. */
import { resolveProceedProcessingDate, PROCEED_NEEDS_DATE } from '../shared/order-rules';
/* The SO edit-policy table (Owner 2026-07-17): FREE fields Save writes straight
   through; CONTROLLED fields Save routes into the amendment. Both the lock Set
   and the amendment allow-list below are DERIVED from it so the three lists
   that used to be hand-mirrored can no longer drift apart. */
import {
  soProcessingLockColumns,
  soAmendableHeaderFields,
  lockedColumnsChanged,
  paymentRowMutable,
  PAYMENT_WINDOW_CLOSED_ERROR,
} from '../shared/so-field-policy';
/* SO-SKU spec P2 — every charge is a SKU line. Predicates from P1; the
   fee/addon → SERVICE-line decomposition builders are pure + shared. */
import {
  isServiceLine, isDeliveryFeeServiceCode,
  // SVC_DELIVERY / SVC_DELIVERY_CROSS are no longer named here: the delete side
  // of the delivery-line rebuild moved into scm.rebuild_mfg_so_delivery_lines
  // (migration 0214), which lists the three codes itself.
  SVC_DELIVERY_ADD,
} from '../shared/service-sku';
import {
  applyDeliveryFeeRebuild,
  buildDeliveryRebuildRows,
  DELIVERY_REBUILD_MAX_ATTEMPTS,
} from '../lib/so-delivery-fee-rebuild';
import {
  buildDeliveryFeeServiceLines,
  computeAddonServiceLines,
  recoverOperatorDeliveryState,
  type AddonSelectionInput,
  type ServiceLineSpec,
} from '../shared/service-lines';
/* SO-SKU spec P3 — a POS sofa build splits into per-compartment module lines
   (SO-2606-018 reference shape). Pure decomposition in shared; the build-level
   recompute + drift gate stay authoritative for the money. */
import { splitSofaBuildIntoModuleLines, distributeBuildDiscount } from '../shared/so-sofa-split';
/* SO line ORDER rules (Loo 2026-06-12) — persisted row order: mains
   (sofa/mattress/bedframe) first, accessories after, services last; within a
   rank the cart order is preserved. Shared with the Backend PDF + POS print
   so every surface ranks identically. */
import { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank } from '../shared/so-line-display';
import { PAYMENT_METHOD_CODES } from '../shared/payment-methods';
import { soPaidSen, soBalanceSen, soPaidInputsOf } from '../shared/so-outstanding';
/* Task 5 — mint one-shot SKUs at SO create when a line carries an extra add-on
   charge (gated by so_settings.pos_remark_extra_auto_sku). Pure code-resolution
   + row-build lives in the lib; this route batches the DB collision check. */
import { buildOneShotMints, type OneShotMintReq } from '../lib/one-shot-mint';
import { warehouseLabel } from '../lib/warehouse-label';
import { loadSoWarehouseMasters, resolveSoWarehouseId } from '../lib/so-warehouse';
import { resolveCreateWarehouseDefaults } from '../lib/so-create-warehouse-default';
import { planStateRebindForDoc, stateChangeConflictBody } from '../lib/so-state-warehouse-rebind';
import { canonicalizeMyState } from '../lib/canonical-state';
import { deriveLineBrandingFromProduct, deriveHeaderBrandingFromLines } from '../lib/derive-line-branding';
import { resolveBrandLetterheadKey } from '../lib/brand-letterhead';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { correctedSizeDescription, loadSizeSkuMap } from '../lib/size-variant-description';
import {
  scopeToCompany, activeCompanyId, activeCompanySql, stampCompany, companyDocPrefix,
  isMirroredDocNo, mintsIntoMirroredNamespace, houzsOwns2990,
  MIRRORED_SO_READONLY, MIRRORED_SO_CREATE_BLOCKED,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
} from '../lib/companyScope';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr, phoneSearchOrParts } from '../lib/postgrest-search';
import { effectiveStatusFilter, isRangeNotSatisfiable } from '../lib/so-list-filters';
import { SO_TAB_STATUSES, soStatusesForTab } from '../lib/so-tab-statuses';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { tallyStatusRows, type StatusTally } from '../lib/status-counts';
import { soConvertedPoNumbers } from '../lib/so-converted-po';
/* "A PO is already out for this SO" — the second road to the same soft lock
   (owner 2026-08-12, 2990 only). See lib/so-po-lock.ts. */
import { soPoLocked } from '../lib/so-po-lock';
import { monthBoundsMy, rangeBoundsMy, todayMyt, mytDateOf } from '../lib/my-time';
// (canViewAllSales / isSelfScopedSales removed — replaced by flat permission
// gates `scm.so.view_all` / `scm.so.attribute_other` against the REAL Houzs
// caller; see lib/houzs-perms.ts.)
import { hasHouzsPerm, canViewAllSales, isSalesCaller, canViewScmFinance } from '../lib/houzs-perms';
/* The POS session-origin sentinel (mig 0120). Imported rather than re-typed as
   a literal so the value the POS door WRITES and the value this route READS
   cannot drift apart — a typo on either side would silently disarm the pricing
   envelope, and no test would fail. */
import { SESSION_ORIGIN_POS } from '../../services/auth';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import { SO_FINANCE_KEYS, SO_ITEM_FINANCE_KEYS, stripAuditFinance } from '../lib/finance-keys';
import { resolveSalesScopeIds, salesDocOutOfScope, resolveCallerStaffId } from '../lib/salesScope';
import { recordAmendmentRequested, notifyAmendmentsRaised } from '../lib/amendment-raised-effects';
import {
  resolveVenueBinding,
  loadVenueBindingInputs, venueNameForHalfWrittenPair,
  type VenueSource,
  type VenueBindingSb,
} from '../lib/venue-binding';
import { recordSoAudit, diffFields, type FieldChange } from '../lib/so-audit';
/* What changed on a LINE, for the audit trail — derived from the update about to
   be persisted rather than a hand-kept field list (owner 2026-08-12; see the
   module header for the 2990-SO-2608-017 edit this existed to catch and did not). */
import { soLineFieldChanges } from '../lib/so-line-audit-diff';
import { buildAmendmentLineRows, LINE_BUILD_ERRORS } from '../lib/amendment-lines';
// OCR self-learning: a DRAFT confirm is the review event the background scan
// path never reported. Lives in lib/ (not scan-so.ts) — scan-so.ts already
// imports this route's create core, so the reverse import would be a cycle.
import { noteScanDraftAccepted } from '../lib/scan-sample-review';
/* TBC sofa exchange PWP re-evaluation (Loo 2026-06-12) — reuse the voucher
   generator + model-list matcher from the reserve route. */
/* resolveOwnerStaffId — the caller's REAL scm.staff uuid for ownership /
   attribution, with the headless-replay allowance. Homed in pwp-codes.ts only
   because that is the module both consumers already share (see its header). */
import { genCode, inList, resolveOwnerStaffId } from './pwp-codes';
import { signSoItemPhotoUrl, soItemPhotoBindings, type SlipMime } from '../lib/r2';
import { baseKeyOf, deleteThumbFor, putOptionalThumb, thumbKeyFor } from '../../services/photoThumbs';
import { photoProxyPath, proxyFallbackPayload, warnSigningFailedOnce, type PhotoUrlPayload } from '../lib/photoProxyFallback';
import { slipBindings } from '../lib/slip';
import { amendmentMixRefusal, createMixRefusal, lineMixRefusal } from '../lib/main-mix';
import {
  loadMaintenanceConfig,
  loadSpecialAddons,
  recomputeFromSnapshot,
  erpLineTrust,
  loadProductByCode,
  loadProductsByCodes,
  loadFabricByCode,
  loadFabricsByCodes,
  loadFabricSellingTiers,
  loadFabricSellingTiersByIds,
  loadFabricTierAddonConfig,
  loadModelFabricTierOverrides,
  loadCompartmentFabricTierOverrides,
  loadModelDefaultGifts,
  loadModelSofaModulePrices,
  loadModelSofaModuleCostRows,
  loadActiveFreeItemCampaigns,
  type MfgItemForRecompute,
  type RecomputedLine,
  type SofaModuleCostRowLite,
} from '../lib/mfg-pricing-recompute';
/* PR #216 — per-Model variant chip enforcement (Commander 2026-05-27
   follow-up to PR #205). Reject POST/PATCH SO line items that carry a
   variant excluded by the Model's allowed_options. Empty pool = no
   restriction; null model_id = skip entirely. */
import {
  checkAllowedOptions,
  loadProductAndModel,
  loadProductsAndModels,
  variantCheckUnavailableResponse,
} from '../lib/allowed-options-check';
import { findColourKivLines, findIncompleteVariantLines, type ColourKivOffender, type VariantOffender } from '../lib/so-variant-check';
/* Aggregate ALL Processing-Date/save gate failures into one response instead of
   returning on the first (owner 2026-07-18). Pure — no I/O. */
import { collectProcessingGateProblems, validationFailedBody } from '../shared/so-save-problems';
/* The gate's DB reads and its refusals. Lifted out of this file (2026-08-18)
   when the proceed refusal grew the per-condition detail it now carries — this
   router is at its file-size ceiling, and the three helpers were already a
   coherent unit: docNo in, gate FACTS out, judged by the shared pure rules.

   Only ONE of the three is imported now. `soProceedGateBlocked` lost both of
   its call sites here on the same day, with the second Processing-Date storage;
   `soDepositFacts` is reached through the helper below. Where the proceed rule
   is actually enforced after that, and what it leaves orphaned, is written at
   soProceedGateBlocked itself in that module. */
import {
  soProcessingDateProblemsForDoc,
} from '../lib/so-proceed-gate';
import {
  SO_PROCESSING_DATE_COLUMN,
  readSoProcessingDateFromBody,
  soDatePairCascadeColumns,
  soDatePairRefusal,
} from '../shared/so-processing-date';
import { ATTRIBUTE_OTHER_REFUSAL, changedIdentityLockCols, salespersonReattributed } from '../shared/so-identity-lock';
/* Variants-vocabulary unification (port of 2990 73aeeb1e, 2026-06-26):
   POS-handover sofa lines speak `depth`/`sofaLegHeight`/`fabricColor`, Backend
   editors read `seatHeight`/`legHeight`/`fabricCode`. canonicalizeVariants
   rewrites POS keys to canonical Backend keys at PERSIST time so every stored
   row is canonical — used at all 4 SO persist seams (create, sofa-split shared,
   add-line, add-line split, PATCH, sofa-exchange/tbc-swap-sofa) below. */
import { canonicalizeVariants } from '../shared/so-variant-rule';
/* Default Free Gift (migration 0170/0174, D9) — ONE per-Model trigger builder
   (in ../shared) is shared by the SO-create validator below and the
   placed-SO edit reconciler, so create and reconcile can never compute a
   different gift set. */
import { reconcileFreeGiftLinesForSo } from '../lib/free-gift-reconcile';
import { claimPwpForSingleLine, rollbackSinglePwpClaim } from '../lib/pwp-claim-single';
import {
  validateItemCodes, unknownItemCodeResponse,
  findFreeTextSoLines, freeTextSoLineResponse,
} from '../lib/validate-item-codes';
import { collectSoConfirmProblems, soConfirmProblemsForDoc } from '../lib/so-confirm-gate';
import { soLocationProblem, soLocationProblemForDoc } from '../lib/so-location-gate';
import { soAgentToStamp, readStaffForStamp, followSalespersonToAgent } from '../lib/so-agent';
import {
  claimedSlipSessionIds,
  planCreatePaymentSlips,
  soCreatePaymentsSchema,
  type SoCreatePayment,
} from '../lib/so-create-payment-slips';
import { pickCrossCategoryMatch, type AutoMatchCandidate } from '../lib/cross-category-match';
import { recomputeSoStockAllocation, isHardBoundLine } from '../lib/so-stock-allocation';
import { snapshotSoLineLinks, planSoLineRelink, applySoLineRelink } from '../lib/so-line-relink';
import { advanceSoGeneration } from '../lib/so-generation';
import { creditFromCancelledSo, getCustomerCreditBalance } from '../lib/customer-credits';
import { summariseReadiness, type ReadinessLine } from '../lib/so-readiness';
import { effectiveLineStockStatus, readinessLinesByDoc, type LiveStockState } from '../lib/so-line-effective-stock';
import { attachLineCategories, resolveLineCategories } from '../lib/so-readiness-category';
import { deriveDisplayBrandingRowByDoc } from '../lib/so-display-branding';
import { mintMonthlyDocNo, insertWithDocNoRetry, companyCodeById } from '../lib/doc-no';
import { soDeliverableRemaining, soLineDeliveries, computeSoLifecycle, soCurrentDocNo, soLineShippedSources } from './delivery-orders-mfg';
import { soLineReadySourcePos, unionSoLineChips } from '../lib/source-po-trace';
/* Shared 4-state delivery-planning derivation — the SO list emits planning_state
   (the mobile Orders-list card's status) from the SAME helper the Delivery
   Planning board uses, so the two can never drift. */
import { derivePlanningState } from './delivery-planning';
import { computeMrp, mrpLineCoverage, type MrpResult } from './mrp';
import type { Env, Variables } from '../env';
/* scan-bg-job — the headless createDraftSalesOrder below runs the create core
   without a request-scoped client; it uses the scm-scoped service client. */
import { getSupabaseService } from '../../db/supabase';
import { deferScmAfterCommit, runScmPgCommand } from '../lib/pg-supabase-transaction';
import {
  applySoCancelVouchers, planSoCancelVouchers, soCancelVoucherAuditChanges,
} from '../lib/so-cancel-vouchers';
import { deferAllocationRecompute, scheduleStockAllocationAfterCommand } from '../lib/stock-allocation-job';

export const mfgSalesOrders = new Hono<{ Bindings: Env; Variables: Variables }>();
mfgSalesOrders.use('*', supabaseAuth);

/* ── Mirrored SOs are READ-ONLY here (originating-system ownership) ─────────
   2990 owns every SO it originates; the live mirror re-applies 2990's version
   of that SO on every drain, so an edit made here is silently reverted seconds
   later — see the MIRRORED_COMPANY_CODE block in lib/companyScope.ts for why
   this is invisible to both the operator and the drift sentinel.

   Guarded at the ROUTER rather than per handler because this file holds ~28
   separate write sites against the SO trio, and every one of them reaches its
   SO through the :docNo path segment. A per-writer guard would leave the next
   writer added to this file unguarded by default — the "the twin never got it"
   shape #600 / #625 / #632 already cost us three times.

   Reads pass untouched: seeing a 2990 order in Houzs is the entire point of
   the mirror.

   The path is scanned segment-wise instead of via c.req.param('docNo') so the
   guard cannot silently no-op if a route's param name changes or a future
   writer nests the doc number differently — a doc number is the only path
   segment that can carry the mirror's prefix. A guard that fails open without
   saying so is worse than no guard. */
mfgSalesOrders.use('*', async (c, next) => {
  if (c.req.method === 'GET') return next();
  const touchesMirrored = c.req.path.split('/').some((seg) => {
    let s = seg;
    try { s = decodeURIComponent(seg); } catch { /* not encoded — test the raw segment */ }
    return isMirroredDocNo(s);
  });
  // Flip-gated (task #15): pre-flip a 2990- doc is a read-only mirror; once
  // HOUZS_OWNS_2990 the POS writes them natively, so the readonly wall lifts.
  if (touchesMirrored && !houzsOwns2990(c.env)) return c.json(MIRRORED_SO_READONLY, 409);
  return next();
});

/* ── SO child-lock guard (Tier 2 — downstream lock) ─────────────────────────
   An SO locks (read-only — no line edit / no CANCELLED transition) once it has
   ANY non-cancelled Delivery Order OR Sales Invoice referencing it. Convert-to-
   DO (partial delivery) is NOT gated by this: the SO can keep emitting DOs;
   only line MUTATIONS + the CANCELLED status transition are blocked. Mirrors
   grnHasDownstream. The rule now lives in scm/lib/downstream-lock.ts with its
   three siblings, which had drifted into four private copies in four route
   files. Same signature, same JSON, same behaviour — and see that module for
   why it is also the ERP half of AutoCount's transferred-document rule. */

/* -- ERP -> AutoCount edit --------------------------------------------------
   Every SO mutation route funnels through one of these two, so exactly one
   snapshot of the SAVED order is queued per successful save -- header edits,
   line add/edit/delete and the tbc variant/SKU swaps alike. A variant or SKU
   change IS a line change: AutoCount takes it as Desc2 + ItemCode on the same
   DtlKey, which is why they need no operation of their own.

   Only ever reached for an order the downstream lock let through, which is the
   same rule AutoCount enforces on its side. Never throws. */
async function queueAcSoEdit(
  c: any,
  docNo: string,
  retire: AcRetiredLine[] = [],
  /* Rows THIS request inserted. A line with no AutoCount key is otherwise
     indistinguishable from a legacy line the backfill missed, and guessing
     "new" appends a duplicate into a live account book. Only the route that
     did the inserting can say, so only the route that did it passes this. */
  newLineIds: string[] = [],
  /* ERP columns THIS request wrote. Only the header PATCH passes any: a value
     the operator DELETED and a value that was never there look identical in the
     saved row, so the composer cannot tell them apart and the route has to say.
     Absent is the STRICTER direction — nothing is cleared — which is why this
     one is allowed to be optional where `itemCode` was not. */
  touchedFields: readonly string[] = [],
): Promise<void> {
  await enqueueEdit(c.get('supabase'), {
    companyId: activeCompanyId(c),
    docType: 'SO',
    docNo,
    retire,
    newLineIds,
    touchedFields,
    createdBy: c.get('houzsUser')?.id ?? null,
  });
}

/* -- SO line coverage (the Stock column) ------------------------------------
   The MRP allocation is GLOBAL by design: a line's coverage depends on what
   every higher-priority line already claimed, so asking it for ONE order would
   answer a different question, not the same one faster. It therefore cannot be
   narrowed — but it also does not DEPEND on the per-line reads that follow it in
   both handlers below, so it is returned as a promise and awaited ALONGSIDE
   them instead of in front of them. Same reads, same result, one wait instead
   of two. `mrp` is handed on to soLineReadySourcePos, which genuinely needs it
   and so genuinely stays behind it.

   `sb` is `unknown` rather than the file's usual `any`: nothing here does more
   than hand it straight to computeMrp, so there is no reason to turn the
   checker off for it. */
type SoCoverage = { coverage: Map<string, { source: string; po: string | null; eta: string | null }>; mrp: MrpResult | null };
/* Exported for the deferred `GET /:docNo/coverage` handler, which lives in
   mfg-sales-orders-list-enrichment.ts (this file is at its size ceiling). Same
   engine, same call — it must not re-implement the MRP logic. */
export async function soCoverage(c: any, sb: unknown): Promise<SoCoverage> {
  /* Best-effort, exactly as before: a failed allocation drops every line to
     Pending and the page still loads. */
  try {
    const mrp = await computeMrp(sb, { catFilter: null, whFilter: null, includeUndated: true, companyId: activeCompanyId(c), leadBuffers: await loadLeadBuffers(c.env.DB) });
    return { coverage: mrpLineCoverage(mrp), mrp };
  } catch {
    return { coverage: new Map(), mrp: null };
  }
}

/* The same, for a route whose body runs inside runScmPgCommand: queue only
   when the transaction actually committed (a non-2xx rolls it back). */
async function queueAcSoEditAfter(c: any, docNo: string, res: Response): Promise<Response> {
  if (res.ok) await queueAcSoEdit(c, docNo);
  return res;
}

/* See "WHY A CONSTANT" in shared/so-processing-date.ts. */
const SO_PROCESSING_LOCKED_RESPONSE = {
  error: 'so_locked_processing',
  reason: 'Processing date has passed — this Sales Order is locked. (Locked orders are what we PO to the supplier.)',
} as const;

/* See "THE PAIR RULE" in shared/so-processing-date.ts. */
const SO_PO_LOCKED_RESPONSE = {
  error: 'so_locked_po_raised',
  reason: 'A Purchase Order has already been raised for this order — submit an amendment so purchasing can re-send it to the supplier.',
} as const;

/* Optimistic-lock rejection (WO-8 / GO-LIVE charter item 3). `error` is a CODE
   the frontend maps to a curated plain sentence (authed-fetch.ts humanApiError),
   so the wording can never drift; `message` carries the same sentence inline as
   a fallback for any surface that reads the body raw. Desktop and mobile must
   send the `version` they loaded for every real header mutation; a missing token
   is rejected with 428 instead of silently falling back to last-writer-wins. */
const SO_VERSION_CONFLICT = {
  error: 'so_version_conflict',
  message: 'Someone else updated this order while you were editing. Your changes are still on this screen; review the latest order before saving again.',
} as const;

const SO_VERSION_REQUIRED = {
  error: 'so_version_required',
  message: 'This order was opened with an older screen. Your changes are still here; refresh the order before saving again.',
} as const;

const soVersionConflict = (currentVersion: number) => ({
  ...SO_VERSION_CONFLICT,
  currentVersion,
});

/* ── ROLLOUT GRACE WINDOW for mandatory CAS (2026-07-22) ───────────────────────
   Making `version` mandatory is a BREAKING wire change for every browser tab
   that is ALREADY OPEN when this deploys. Those tabs run the previous JS
   bundle, which never sends a version, so without a grace path the first Save
   after deploy 428s for every single person mid-edit, all at once, with no way
   to recover except a reload they have not been told to do. A correctness fix
   that interrupts the whole shop the moment it lands is not a fix yet.

   MECHANISM: a bounded, opt-in, self-closing window driven by the
   `SO_CAS_GRACE_UNTIL` Worker variable (an ISO-8601 instant).
     • unset  → strict from the first request (the safe default, and the
                permanent steady state; nothing to remember to turn off)
     • set and in the FUTURE → a request that omits the version is accepted with
                the PRE-CAS semantics (server-current version, last-writer-wins,
                exactly today's production behaviour) and flagged `casGrace`
     • set and in the PAST → strict again, automatically

   A STALE version is ALWAYS a 409, in or out of the window: the grace only
   covers clients that cannot speak the protocol at all, never a client that
   spoke it and lost. Set it to deploy time + 30 minutes at rollout and delete
   the variable afterwards — see docs/IDEMPOTENCY-PHASE2-RUNBOOK.md. */
export type SoCasGraceWindow = { until?: string | null; now?: number };

export function soCasGraceOpen(window?: SoCasGraceWindow): boolean {
  const raw = window?.until;
  if (!raw) return false;
  const until = Date.parse(String(raw));
  if (!Number.isFinite(until)) return false;
  return (window?.now ?? Date.now()) < until;
}

/** Read the window off the Worker env. One place, so no route invents its own. */
export const soCasGrace = (c: any): SoCasGraceWindow => ({
  until: (c?.env?.SO_CAS_GRACE_UNTIL as string | undefined) ?? null,
});

/* 'held' is all its two callers can be in: both read a LIVE lease first. The
   three-way lives in requireSoLineWriteLease below - docs/bugs/0630. */
const SO_EDIT_LEASE_CONFLICT = soEditLeaseRefusal('held');

/* The lock's rules live in scm/lib/so-edit-lease.ts. Re-exported because two
   suites import this one from here. */
export { soLineWriteLeaseMatches } from '../lib/so-edit-lease';

/* Every direct line mutation belongs to an acquired header lease. This is the
   enforceable half of the multi-request composite save: a caller cannot bypass
   CAS by skipping the header request and writing lines directly. */
async function requireSoLineWriteLease(sb: any, docNo: string, c: any): Promise<Response | null> {
  const supplied = c.req.header('X-SO-Edit-Lease')?.trim() ?? '';
  const { data, error } = await sb.from('mfg_sales_orders')
    .select('edit_lease_token, edit_lease_expires_at, edit_lease_user_id')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  if (!soLineWriteLeaseMatches(data as SoEditLeaseRow, supplied)) {
    const live = activeSoEditLease(data as SoEditLeaseRow);
    const holder = (data as { edit_lease_user_id?: number | string | null }).edit_lease_user_id;
    // The same person takes their own lock back - 0348, as the composite path does.
    if (live && supplied && soEditLeaseTakeoverAllowed(holder, soCallerUserId(c))) return null;
    return c.json(soEditLeaseRefusal(!supplied ? 'missing' : live ? 'held' : 'expired'), 409);
  }
  return null;
}

/** A line id is never globally trusted: every read/write/delete also proves it
 * belongs to the docNo in the route. Exported for the regression test. */
type DocumentScopedQuery = {
  eq: (column: string, value: string) => DocumentScopedQuery;
};

export function scopeSoItemToDocument<T>(
  query: T,
  docNo: string,
  itemId: string,
): T {
  // Keep T unconstrained at the call-site. Recursively constraining Supabase's
  // generic query builder makes TypeScript expand the full generated schema
  // here and can hit TS2589 (excessively deep type instantiation).
  return (query as T & DocumentScopedQuery)
    .eq('doc_no', docNo)
    .eq('id', itemId) as T;
}

/* Exported (two-lane phase 2): delivery-planning.ts guards its board write of
   the CONTROLLED replacement_disposal field with the SAME predicate, so the
   two surfaces can never disagree about when the lock is on. */
export function soProcessingLocked(
  header: { processing_date?: string | null; status: string | null } | null | undefined,
): boolean {
  if (!header) return false;
  const proc = header.processing_date ?? null;
  if (!proc) return false;
  const procYmd = String(proc).slice(0, 10);            // 'YYYY-MM-DD' (date or timestamp)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(procYmd)) return false;
  /* "Today" in Malaysia: shift the UTC clock +8 h, read the calendar date.
     Locked strictly AFTER the processing day — procYmd === today stays open. */
  const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (!(procYmd < todayMY)) return false;
  /* "THE PAIR RULE" + "RETIRING THE SECOND STORAGE" in so-processing-date.ts.
     `status` is REQUIRED on the parameter type, and that requirement is what
     replaced the `Boolean(header.proceeded_at)` fallback. */
  const status = String(header.status ?? '').toUpperCase();
  if (!status) return false;
  return status !== 'DRAFT' && status !== 'CANCELLED';
}

/* See "THE PAIR RULE" in shared/so-processing-date.ts. */
async function soProcessingLockBlocked(
  sb: any,
  docNo: string,
): Promise<typeof SO_PROCESSING_LOCKED_RESPONSE | typeof SO_PO_LOCKED_RESPONSE | null> {
  const { data } = await sb.from('mfg_sales_orders')
    .select('processing_date, status')
    .eq('doc_no', docNo).maybeSingle();
  if (soProcessingLocked(data as { processing_date?: string | null; status: string | null } | null)) {
    return SO_PROCESSING_LOCKED_RESPONSE;
  }
  return (await soPoLocked(sb, docNo)) ? SO_PO_LOCKED_RESPONSE : null;
}

/* Both soft locks as one boolean, for the call sites that already hold the
   header row (and so would waste a re-read going through the helper above).
   Same precedence-free question: "must this edit go through an amendment?" */
async function soEditLocked(
  sb: any,
  docNo: string,
  header: { processing_date?: string | null; status: string | null } | null | undefined,
): Promise<boolean> {
  return soProcessingLocked(header) || await soPoLocked(sb, docNo);
}

/* The identity lock (which columns freeze once a DO / SI exists, and why
   `salesperson_id` no longer does) lives in shared/so-identity-lock.ts. */

/* See "THE PAIR RULE" in shared/so-processing-date.ts. */
const SO_PROCESSING_LOCK_COLS = soProcessingLockColumns();

/* See "THE PAIR RULE" in shared/so-processing-date.ts. */
const AMENDABLE_HEADER_FIELDS: Record<string, string> = soAmendableHeaderFields();

/* Loose equality for the lock diff — null / undefined / '' all collapse so a
   UI re-sending an empty field as '' does not read as a change from null. */
function norm(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/* Pricing trust boundary (Owner 2026-05-31).
   The selling unit price is operator-authored on the Backend SO form, and the
   owner ruled the selling price legitimately varies per order. So a Backend /
   office author may set ANY selling price: the server still recomputes COST,
   but it PERSISTS the operator's selling figure and never drift-rejects it.

   The POS tablet stays on the server-authoritative selling price + >0.5% drift
   reject — the CLAUDE.md anti-tamper non-negotiable (a tampered POS must never
   submit a doctored low total). Returns true ONLY for a POS-tablet caller;
   every Backend / office author returns false and is trusted to price freely.

   ── HOUZS IDENTIFICATION (POS cutover, 2026-07) ────────────────────────────
   2990 keyed this on `scm.staff.role` (POS_TABLET_ROLES = sales /
   sales_executive / outlet_manager). That lookup is DEAD here, and must NOT be
   revived against the real caller either:
     · The SCM auth bridge pins every caller's `user.id` to ONE super_admin
       system staff row (scm/middleware/auth.ts), so the role read super_admin
       for everybody and the gate fired for nobody.
     · Gating on the REAL caller (houzsUser position/department) CANNOT work:
       2990 could assume role ⇒ device (a `sales` role only ever touched the POS
       tablet). Houzs breaks that mapping. routes/pos.ts /pin-login mints a
       session for the SAME public.users row the person signs into desktop and
       mobile with, and the mobile SO form lets a salesperson TYPE any selling
       price (MobileNewSO.tsx — the price is a free input). Position-gating
       would drift-reject live Sales staff on mobile; worse,
       pmsAccess.SALES_POSITION (/^sales/i) also matches OFFICE authors such as
       "Sales Director" and "Sales Coordinator" on the desktop SO form.

   ONE PRINCIPAL, THREE DEVICES: the person is identical across all of them, so
   the POS-ness of a write is a property of the SESSION and nothing else. That
   is what `sessionOrigin` is (services/auth.ts SessionOrigin, mig 0120): the
   DOOR the token was minted at, stamped server-side at /api/pos/pin-login.

   ── THREAT MODEL — READ THIS BEFORE TRUSTING THE GATE ──────────────────────
   DEFENDS (the 2990 anti-tamper non-negotiable — a tampered POS must never
   submit a doctored low total): every request bearing a POS-minted token is
   price-checked, unconditionally. Patching the tablet's JS, replaying its token
   from curl, or hand-rolling the payload all still carry that token, and the
   origin rides the session row, not the request — there is no field to strip,
   spoof or omit. The predecessor of this gate read a self-asserted
   `X-Client: pos-tablet` header, which a hostile client escaped by simply not
   sending it. That escape is now closed: a caller cannot shed what it never
   sent.

   DOES NOT DEFEND, AND THIS IS THE BIG ONE (Owner 2026-08-16): the SSO door,
   POST /api/pos/exchange-web-session, mints an ORIGIN-LESS session for the same
   person. Anyone who can pass the PIN gate can therefore obtain a token that
   reads as not-POS here, open the ERP web app with it, and price freely on
   every route below. The owner ruled it: 「进了这个 ERP 就跟这个 ERP 的规矩」 —
   the amount must be editable in the ERP. So this gate now binds the POS APP,
   not the tablet and not the person: it holds requests made with the token the
   PIN door issued, and nothing else. Do not read anything stronger into it, and
   do not re-tighten that door without an owner ruling reversing this one.

   DOES NOT DEFEND — and this is a POLICY boundary, not an oversight: a person
   who knows their own Houzs PASSWORD can log in at the desktop/mobile door,
   get an origin-less session, and price freely. That is the owner's explicit
   ruling (selling price varies per order; the mobile SO form is a free price
   input), not a hole this gate leaks. The gate binds the DEVICE, which is what
   2990 ever promised; it does not and cannot bind the HUMAN. If office/mobile
   authoring should also be price-checked, that is a separate owner ruling with
   a much larger blast radius — do not smuggle it in here.

   Also undefended, unchanged and out of scope: anyone who can write the
   `sessions` table or hold the DASHBOARD_API_KEY is already past every gate in
   this app.

   ── FAIL-OPEN, deliberately ────────────────────────────────────────────────
   Any session WITHOUT origin='pos' reads as NOT-POS, so no drift check. That
   covers: every session minted before mig 0120, every desktop/mobile/invite/
   TOTP login, the DASHBOARD_API_KEY service caller, and the headless scan job.
   Fail-closed is not an option: each of those is an operator-authored price
   surface that would 400 on a perfectly legitimate price. Blast radius is
   therefore exactly the set of callers holding a POS-minted session — until
   the 2990 POS actually repoints here, that set is EMPTY and this gate is
   inert by construction. */

/* Structural caller source — satisfied by the real Hono context AND by
   mfg-sales-orders' SoCreateContext (the headless scan job), exactly like
   lib/houzs-perms' HouzsUserSource. Only `get('sessionOrigin')` is required:
   the origin is the ONE fact this gate may consult, and narrowing the
   parameter to it is what stops a later edit from quietly reaching for a
   self-asserted header again. */
type PosCallerSource = { get(key: 'sessionOrigin'): Variables['sessionOrigin'] };

async function isPosTabletCaller(c: PosCallerSource): Promise<boolean> {
  return c.get('sessionOrigin') === SESSION_ORIGIN_POS;
}

/* SO-SKU spec P4 (D4, Loo 2026-06-05) — the SELLING price is locked to the
   SKU Master; only admin-level callers may hand-override it (the audited
   /override route). Houzs-flavoured: gate on the flat permission key
   `scm.so.price_override` against the REAL caller; the original
   scm.staff.role lookup is dead in Houzs (bridge pins to one super_admin
   row). Owner + IT Admin pass via `*`; grant to other positions via the
   Team > Positions matrix. Signature takes the Hono context so we can read
   the real user's permissions stash. */
async function isPriceOverrideCaller(c: any): Promise<boolean> {
  return hasHouzsPerm(c, 'scm.so.price_override');
}

/* Write-side own/downline guard (Audit 2026-07, go-live review #2) — the SO
   READ paths scope a rep to their OWN + reporting-downline orders via
   salesDocOutOfScope, but the MUTATION routes were a no-op stub (returned
   false), so a scoped salesperson could PATCH / delete / repay / reassign ANY
   SO by enumerable doc_no. This mirrors salesDocOutOfScope exactly: load the
   target SO's salesperson_id by doc_no, then defer to the shared scope helper
   (view-all callers — `scm.so.view_all` / director / office via
   canViewAllSales — bypass; everyone else is held to self + full reporting
   chain). Reads sb / env / real Houzs caller id / view-all off the Hono
   context so it uses the SAME identity vocabulary as the reads (houzsUser.id,
   NOT the pinned scm.staff uuid on user.id). Returns TRUE ⇒ block (the caller
   answers 404, indistinguishable from a nonexistent doc_no). A missing SO also
   returns TRUE (fail closed). */
/* Row-scope guard for the 18 /:docNo handlers that hang off a sales order.

   TWO dimensions. The salesperson one answers "is this MY order" and returns
   false immediately for a view-all tier - correct for its own question, and
   useless for tenancy, since a view-all caller holding the other company's
   doc_no passed every caller of this guard, four money-writing payment verbs
   included. So COMPANY is checked FIRST and for everyone. It belongs here
   rather than in each handler: 18 callers share it, and the 19th gets it free. */
async function selfScopedSalesBlocked(c: any, docNo: string): Promise<boolean> {
  const sb = c.get('supabase');

  /* 1. Tenancy - every tier, view-all included. scopeToCompany DEGRADES when the
     company is UNRESOLVED and must NOT fail closed: unresolved means the
     companies master could not be read (pre-migration, D1 test mirror,
     Hyperdrive cold start), and refusing there locks every user out of all 18
     handlers. See "THE ALLOW-LIST SENTINEL" in companyScope.ts. */
  const { data: owned, error: ownedErr } = await scopeToCompany(
    sb.from('mfg_sales_orders').select('doc_no').eq('doc_no', docNo),
    c,
  ).maybeSingle();
  if (ownedErr || !owned) return true;

  // 2. Salesperson - only for the self-scoped tier.
  if (canViewAllSales(c)) return false; // view-all tier (director / office / *)
  const { data, error } = await sb
    .from('mfg_sales_orders')
    .select('salesperson_id')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (error || !data) return true; // fail closed - unknown/unreadable doc is out of scope
  const sp = (data as { salesperson_id?: number | string | null }).salesperson_id;
  return salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, false, sp);
}

/* THE venue_id coercion — every writer of mfg_sales_orders.venue_id goes
   through this. The column is a UUID FK to the (empty/unused) scm.venues, but
   the Venue picker is fed from TWO other masters whose ids are not uuids:
   public.project_venues (INTEGER ids, stringified by the FE) and, since the
   showroom feed (owner 2026-07-19), synthetic `showroom:<warehouse-uuid>`
   ids minted by GET /api/projects/venues?includeShowrooms=1. Either one posted
   into the uuid column aborts the whole statement with
   "invalid input syntax for type uuid" — a 500, not a validation message.

   The create path has carried this guard since #154; the header PATCH did NOT,
   and on 2026-08-10 the imported-order venue-seeding effect (SalesOrderDetail)
   started ADOPTING the matching picker option into form.venueId, which made
   every Save on a showroom-venue SO post `showroom:…` and 500. Hence one shared
   helper rather than a second copy of the regex.

   Returning NULL rather than throwing is deliberate: the venue TEXT column +
   the venue_source marker already carry the venue's identity, and scm.venues is
   unused, so nothing downstream reads venue_id for these rows. What each caller
   DOES with a NULL differs — create stamps it, the header PATCH skips the
   column — and each says why at its own callsite. */
export function venueIdUuidOrNull(value: unknown): string | null {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

/* Anti-tamper (Task 6) — Strip variants.freeItem from a client-supplied
   variants blob. The freeItem marker is ONLY ever stamped by the validated
   POST /mfg-sales-orders create path (campaign check + cap). Any SO-EDIT
   endpoint that writes client variants must call this before persisting so
   a crafted request cannot inject an unvalidated marker that the grandfather
   guard (isFreeItemLine) would later honour to force a line to RM 0. */
function stripFreeItem(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'freeItem' in v) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { freeItem: _fi, ..._rest } = v as Record<string, unknown>;
    return _rest;
  }
  return v;
}

/* POS line quantity (Loo 2026-06-12) — line qty is a money input the
   unit-price drift gate does NOT cover: qty 0 zeroes a line for free, a
   fraction / NaN corrupts total_sen math, and the discount ceiling is
   qty × unit. An absent qty (defaults to 1 downstream) is fine; anything
   else must be a positive integer. Returns the 422 payload, or null when
   valid. Shared by POST /, POST /:docNo/items and PATCH /:docNo/items/:itemId. */
function invalidQtyResponse(rawQty: unknown, itemCode: unknown, lineIdx = 0): Record<string, unknown> | null {
  if (rawQty == null) return null;
  const q = Number(rawQty);
  if (Number.isInteger(q) && q >= 1) return null;
  return {
    error:    'invalid_qty',
    reason:   'qty must be a positive whole number.',
    lineIdx,
    itemCode: String(itemCode ?? ''),
    qty:      rawQty,
  };
}

/* Special add-on with no reason (Owner 2026-07-17, on finding one on a live
   order) — a free-text add-on is variants.extraAddonNote + extraAddonAmountRM.
   The AMOUNT does not print as its own figure: it folds into the line's selling
   price via the extraSen fold in mfg-pricing-recompute, and Loo 2026-06-15
   deliberately dropped the "(+RM…)" from the SPECIAL segment because it
   double-showed money already inside the product amount. So the NOTE is the
   only place the charge is ever explained — and when it is blank, both summary
   builders fall back to the literal string "Extra add-on", which reads like a
   description and is not one. Net effect on a real order: the customer paid
   RM 125 more, and nothing on the document says why.

   Fixing the display cannot fix that (any label is either invented or
   double-counts the money), so require the note at the source: an amount
   without a note is refused. Blank note + no amount stays legal — that is just
   an untouched line. Returns the 422 payload, or null when valid. Shared by
   POST /, POST /:docNo/items and PATCH /:docNo/items/:itemId; a PATCH that
   omits `variants` reads undefined -> amount 0 -> null, so a partial patch
   never trips this. */
function unexplainedExtraAddonResponse(
  variants: unknown, itemCode: unknown, lineIdx = 0,
): Record<string, unknown> | null {
  const v = variants as { extraAddonNote?: unknown; extraAddonAmountRM?: unknown } | null | undefined;
  const raw = Number(v?.extraAddonAmountRM ?? 0);
  const amountRM = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  if (amountRM <= 0) return null;
  const note = typeof v?.extraAddonNote === 'string' ? v.extraAddonNote.trim() : '';
  if (note) return null;
  return {
    error:    'extra_addon_needs_description',
    reason:   'A special add-on charge needs a description saying what it is for.',
    lineIdx,
    itemCode: String(itemCode ?? ''),
    extraAddonAmountRM: amountRM,
  };
}

/* PR — Commander 2026-05-28 — Server-side combo recompute.
   Fetches all active sofa_combo_pricing rows once (small table; ~64 rows
   in steady state) and returns them as SofaComboRow[] for the pure
   pickComboPrice() picker. Called by POST / and PATCH /:docNo/items/:itemId
   before the line is persisted; if a sofa line's variants.cells match a
   combo's modules at the line's seat-height tier, the combo price OVERRIDES
   the client-submitted unit_price (anti-tamper). */
async function loadActiveSofaCombos(sb: any, c: any): Promise<SofaComboRow[]> {
  const { data } = await scopeToCompany(
    sb
      .from('sofa_combo_pricing')
      .select('id, base_model, modules, tier, customer_id, prices_by_height, selling_prices_by_height, pwp_prices_by_height, label, effective_from, created_at, deleted_at, default_free_gifts'),
    c,
  )
    .is('deleted_at', null)
    .is('customer_id', null)   // 2990 B2C — default-scope rows only
    .is('supplier_id', null);  // sales-side only — never auto-price a SO from a supplier's purchasing combos
  return ((data ?? []) as Array<{
    id: string; base_model: string; modules: string[][]; tier: SofaPriceTier | null;
    customer_id: string | null; prices_by_height: Record<string, number | null>;
    selling_prices_by_height: Record<string, number | null>;
    pwp_prices_by_height: Record<string, number | null> | null;
    label: string | null; effective_from: string; created_at: string; deleted_at: string | null;
    default_free_gifts: unknown;
  }>).map((r) => ({
    id: r.id, baseModel: r.base_model, modules: r.modules ?? [],
    tier: r.tier, customerId: r.customer_id,
    // Combo cost/sell split — the engine charges SELLING merged over cost.
    pricesByHeight: comboChargedPrices(r.selling_prices_by_height, r.prices_by_height),
    // PWP (换购) selling price per height (Phase 2) — used INSTEAD of the above
    // only when a sofa-reward line redeems a valid PWP code (see recompute).
    pwpPricesByHeight: r.pwp_prices_by_height ?? {},
    // created_at feeds the picker's duplicate tie-break (equal effective_from
    // → newest row wins, matching the GET /sofa-combos admin list).
    label: r.label, effectiveFrom: r.effective_from, createdAt: r.created_at, deletedAt: r.deleted_at,
    // Default Free Gift (migration 0170, D9) — passthrough jsonb; the SO-create
    // handler parses it to build the per-combo free-gift trigger.
    defaultFreeGifts: r.default_free_gifts ?? [],
  }));
}

/* Extract module ids + seat-height from a sofa line's `variants` blob.
   POS handover writes variants.cells = [{ moduleId, x, y, rot }] and
   variants.depth = '24' | '28' | '30' | ... so the picker has everything
   it needs to match a combo. Returns null when the line isn't a sofa
   custom build (e.g. quick-pick bundle = `bundleId` only; price already
   matches the bundle row). */
function extractSofaComboLookupArgs(
  itemGroup: string | undefined | null,
  variants: unknown,
): { modules: string[]; height: string; tier: SofaPriceTier } | null {
  if ((itemGroup ?? '').toLowerCase() !== 'sofa') return null;
  if (!variants || typeof variants !== 'object') return null;
  const v = variants as Record<string, unknown>;
  const cells = v.cells as Array<{ moduleId?: string }> | undefined;
  if (!Array.isArray(cells) || cells.length === 0) return null;
  const modules = cells.map((c) => String(c.moduleId ?? '')).filter(Boolean);
  if (modules.length === 0) return null;
  const height = String(v.depth ?? v.seatHeight ?? '24');
  /* Tier: prefer an explicit tier on variants; fall back to PRICE_2 (HOOKKA
     legacy default per the SO rendering code in Products.tsx). When the
     POS fabric model carries a tier per row, wire it here. */
  const tier = (v.tier ?? v.fabricTier ?? 'PRICE_2') as SofaPriceTier;
  return { modules, height, tier };
}

/* VIEW-TRAP (see backend/docs/scm-view-trap-coe.md): this HEADER feeds BOTH the
   SO detail GET (reads BASE TABLE scm.mfg_sales_orders) AND the SO list GET
   (reads the VIEW scm.mfg_sales_orders_with_payment_totals; LIST_COLS = HEADER
   + 3). The view was created `SELECT so.*` from 2990 mig 0155 — Postgres FREEZES
   that column set at CREATE VIEW, so new base-table columns are NOT visible
   through it. Adding a column here REQUIRES a same-PR migration that recreates
   the view (CREATE OR REPLACE VIEW … AS SELECT so.* …) — else the SO LIST 500s
   ("Failed to load") in prod. For a field only the detail needs, append it on
   the detail SELECT (see slip_image_key/receipt_image_key at the
   `/:docNo` handler), NOT here. 2990 hit this 2026-06-26 (their mig 0200). */
const HEADER =
  'doc_no, transfer_to, so_date, branding, debtor_code, debtor_name, agent, sales_location, ref, venue, venue_id, ' +
  'address1, address2, address3, address4, phone, ' +
  'mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, service_sen, local_total_sen, balance_sen, ' +
  /* Task #114 — per-category cost columns (migration 0079). Mirrors the
     four category revenue columns above so the SO list grid + Totals card
     can show category-level margins without per-item rollups. */
  'mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, service_cost_sen, ' +
  'total_cost_sen, total_revenue_sen, total_margin_sen, margin_pct_basis, line_count, ' +
  'currency, status, remark2, remark3, remark4, note, sales_exemption_expiry, ' +
  /* PR #35 + #46 — extended PO + POS handover fields */
  'customer_id, customer_po_image_b64, customer_so_no, hub_id, hub_name, ' +
  /* Task #121 — customer_country snapshot auto-derived from customer_state
     via my_localities lookup on POST/PATCH (migration 0082). */
  'customer_state, customer_country, customer_delivery_date, processing_date, linked_do_doc_no, ' +
  'ship_to_address, bill_to_address, install_to_address, subtotal_sen, overdue, ' +
  /* PR #46 — POS handover */
  'email, customer_type, salesperson_id, city, postcode, building_type, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, target_date, ' +
  /* PR #143 + #150 + #157 — Payment (migrations 0068 + 0069 + 0070) */
  'payment_method, installment_months, merchant_provider, approval_code, payment_date, deposit_sen, paid_sen, ' +
  /* Delivery fee snapshot (migration 0133) — folded into local_total/revenue/margin. */
  'delivery_fee_sen, ' +
  'created_at, created_by, updated_at, ' +
  /* Migration 0324 — the HOLD MARKER, rendered BESIDE the status pill. The list
     reads the payment-totals VIEW, which had to be taught these four columns
     separately (mig 0325); a base-table column the view does not enumerate is
     invisible to the list. */
  HOLD_COLUMNS;
/* FINANCE-GATED keys — cost / margin / per-category revenue+cost subtotals +
   deposit (header) and unit/line cost+margin (line). The lists moved to
   lib/finance-keys.ts so /reports shares this EXACT vocabulary: it had no copy
   at all and shipped the whole book's cost/margin to any Sales Executive
   (fix/c1-reports). Four routes re-declaring the list is what let #574 / #600 /
   #625 / #632 drift apart — one list now gates every surface. */

/** Strip header + line cost/margin in place for a non-finance caller. */
function gateSoFinance(
  c: Parameters<typeof canViewScmFinance>[0],
  salesOrder: unknown,
  items: unknown,
): void {
  if (canViewScmFinance(c)) return;
  if (salesOrder && typeof salesOrder === 'object') {
    for (const k of SO_FINANCE_KEYS) delete (salesOrder as Record<string, unknown>)[k];
  }
  for (const it of (Array.isArray(items) ? items : []) as Array<Record<string, unknown>>) {
    for (const k of SO_ITEM_FINANCE_KEYS) delete it[k];
  }
}

const ITEM =
  'id, doc_no, line_date, debtor_code, debtor_name, agent, item_group, item_code, description, description2, ' +
  'uom, location, qty, unit_price_sen, discount_sen, total_sen, tax_sen, total_inc_sen, balance_sen, ' +
  'payment_status, venue, branding, remark, cancelled, variants, unit_cost_sen, line_cost_sen, line_margin_sen, ' +
  /* PR-E — per-item delivery date + cascade override flag (migration 0074) */
  'line_delivery_date, line_delivery_date_overridden, ' +
  /* PR-F — per-line photo keys (migration 0076) */
  'photo_urls, ' +
  /* PR — Commander 2026-05-28: per-line stock fulfillment flag (migration 0091) */
  'stock_status, ' +
  /* Sofa batch allocator's locked source batch (= source PO number, mig 0121).
     Read so a READY sofa line can name the PO its goods sit in (owner
     2026-08-01: READY must always trace to a PO). Non-sofa lines are NULL. */
  'allocated_batch_no, ' +
  'created_at';

/* ─────────────────────────── Country auto-derive (Task #121) ──────────
   Given a customer_state, look up any my_localities row carrying that
   state and read its `country` column. Returns null when the state is
   unknown / not yet seeded — caller decides whether to fall back to a
   default. Cheap single-row lookup; the read is on the indexed `state`
   column so it stays under a millisecond even with the full ~7k MY
   postcode set. ─────────────────────────────────────────────────────── */
/* Exported (2026-07-16) so the amendment apply engine (lib/so-revision.ts) runs
   the SAME State cascade the header PATCH does, instead of re-deriving it. */

/* Commander 2026-05-29 — the Sales/shipping Location (warehouse) follows the
   customer's State. The create FORM resolves it via state_warehouse_mappings
   and sends salesLocation; this server-side derive closes the gap for callers
   that set a State but no salesLocation (e.g. API/import) so Location is bound
   to the address everywhere, not only through the form. Returns the warehouse
   code for the state, or null when unmapped. */

/* Commander 2026-05-31 (MRP/Supply-Chain rebuild) — the per-LINE warehouse_id
   UUID (migration 0118) drives MRP + auto-allocation, which run strictly
   per-warehouse. It defaults from the SO's customer_state (same mapping the
   text sales_location uses) and is editable per line. Returns the warehouse
   UUID for the state, or null when unmapped/no state. */
export const deriveWarehouseIdFromState = async (
  sb: any,
  state: string | null | undefined,
  c: any,
): Promise<string | null> => {
  if (!state) return null;
  /* Match the state against state_warehouse_mappings tolerantly: trim +
     lowercase + collapse spaces + a few known aliases, matched in JS over the
     (small, operator-maintained) table. The old exact case-sensitive .eq
     silently missed e.g. "Pulau Pinang" vs "Penang", a stray-case row, or a
     trailing space → NULL warehouse despite a filled state. */
  const canon = (s: string): string => {
    const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
    const aliases: Record<string, string> = {
      'wilayah persekutuan kuala lumpur': 'kuala lumpur',
      'wp kuala lumpur': 'kuala lumpur',
      'kl': 'kuala lumpur',
      'penang': 'pulau pinang',
      'malacca': 'melaka',
    };
    return aliases[t] ?? t;
  };
  const want = canon(state);
  const { data: rows } = await scopeToCompany(
    sb
      .from('state_warehouse_mappings')
      .select('state, warehouse_id'),
    c,
  );
  for (const m of (rows ?? []) as Array<{ state: string; warehouse_id: string | null }>) {
    if (m.warehouse_id && canon(m.state) === want) return m.warehouse_id;
  }
  return null;
};

const nextDocNo = async (sb: any, c: any): Promise<string> => {
  // Format: SO-YYMM-NNN — matches PO/DO/GRN/SI/DR/PI/PRT.
  // Legacy SO-NNNNNN numbers stay as-is; only newly created SOs use this scheme.
  // max+1 via nextMonthlyDocNo, NOT count+1 — see lib/doc-no.ts for why
  // (2026-06-12: count+1 re-minted a surviving doc_no after a mid-month
  // delete and jammed every SO create on the pkey).
  const p = companyDocPrefix(c);
  const yymm = (() => {
    const d = new Date();
    return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  return mintMonthlyDocNo(sb, 'mfg_sales_orders', 'doc_no', `${p}SO-${yymm}`);
};

/* ─────────────────────────── Cost snapshot ────────────────────────────
   Task #114 — Pull cost_price_sen off mfg_products on line create so the
   header's total_cost_sen / category cost columns get populated even
   when the client doesn't snapshot the cost themselves. Falls through in
   order: explicit client value (when > 0) → mfg_products.cost_price_sen
   → 0. Returns sen (integer). itemCode is matched on mfg_products.code
   which is the canonical lookup key (sku_code is denormalized text).

   Note: Houzs builds cost from a live skusMaster store + variant
   surcharges. We use a server snapshot instead (simpler + tamper-proof)
   per Task #114 spec. ─────────────────────────────────────────────────── */
/* Money guard (2026-07-16) — every sen figure that enters the totals arithmetic
   passes through here first. The roll-up accumulators used to take `unitCost *
   qty` on trust: a single non-finite input (an unknown cost arriving as
   undefined / NaN, or a 0/0 percentage) poisoned totalCost → total_margin_sen
   → margin_pct_basis in one go, because NaN is contagious across +, -, * and /.
   A cost the ERP does not know is 0 — never NaN. Postgres would reject the NaN
   anyway (these columns are `integer NOT NULL`, and supabase-js serializes NaN
   to JSON `null`), so an unguarded NaN does not corrupt the row — it 23502s the
   whole write, taking the customer's order down with it on the create path and
   silently leaving STALE totals on recomputeTotals. Guard at the source instead.

   Corrected 2026-07-17 (fix/s1-recompute-silent): this note used to add "(whose
   UPDATE error is not checked)" as an aside, which understated the defect it was
   describing. That unchecked UPDATE was only the quieter half — recomputeTotals
   ALSO discarded its item-read error and coalesced the null to `[]`, so a
   transient read failure did not leave totals stale, it wrote local_total /
   balance / revenue / margin / every category bucket / line_count to ZERO on an
   order whose lines were intact, and the result looked like an ordinary empty SO.
   Both results are checked now and the roll-up aborts rather than writing. The
   STALE-totals outcome described above is real and remains the DESIGNED failure
   mode — it is what the function does deliberately when it cannot vouch for its
   inputs. */

type SoListMoneyKpis = { revenueSen: number; outstandingSen: number; paidSen: number };

/* Full-set money KPIs (Revenue / Outstanding / Paid) for the SO list's
   paginated path. ONE grouped PostgREST aggregate — three server-side SUMs over
   the SAME filtered set the page query pages, WITHOUT `.range()` — replaces
   paging the WHOLE filtered set in 1000-row chunks and summing in JS. So an
   unfiltered "All" tab at N orders goes from ceil(N/1000) sequential round trips
   plus N rows over the wire down to ONE round trip returning three numbers.

   `applyMoneyFilters` is the single filter closure the aggregate fast path AND
   the paginateAll fallback share, so the two totals apply byte-identical
   predicates and cannot drift.

   Byte-identical to the old paginateAll JS reduce: `local_total_sen` is
   `integer DEFAULT 0 NOT NULL` (backend/scripts/scm-schema/2990s-full-schema.sql),
   and the view's `paid_total_sen` (= COALESCE(Σ payments, 0)) and
   `balance_sen_live` (= local_total − paid) are never null when the view
   exposes them — so SQL SUM (which skips nulls) equals the `?? 0` reduce over
   the same rows, and SUM over zero rows is NULL, coalesced to 0 exactly like the
   empty reduce. Both summed columns are view-COMPUTED, so this stays VIEW-TRAP
   safe (see backend/docs/scm-view-trap-coe.md). If the view LACKS them
   (old/absent view) the aggregate errors on the missing column and we fall
   through to the paginateAll path, which reads `balance_sen` as its own
   absent-`balance_sen_live` fallback — identical to the prior behaviour. */
export async function soListMoneyKpis(
  sb: { from(table: string): { select(columns: string): unknown } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the dynamic aggregate `.select('...sum()')` defeats supabase-js's column-type inference (same reason as outstanding.ts /summary)
  applyMoneyFilters: (q: any) => any,
): Promise<{ data: SoListMoneyKpis | null; error: { message: string } | null }> {
  /* FAST PATH — all aggregates, no plain column → one implicit group → one row.
     Idiom: outstanding.ts /summary. */
  const agg = await applyMoneyFilters(
    sb
      .from('mfg_sales_orders_with_payment_totals')
      .select('rev:local_total_sen.sum(),outLive:balance_sen_live.sum(),paid:paid_total_sen.sum()'),
  );
  if (!agg.error) {
    const row = ((agg.data ?? []) as Array<Record<string, unknown>>)[0] ?? {};
    return {
      data: {
        revenueSen: Number(row.rev ?? 0),
        outstandingSen: Number(row.outLive ?? 0),
        paidSen: Number(row.paid ?? 0),
      },
      error: null,
    };
  }
  /* FALLBACK — aggregates disabled, or the computed columns absent from the
     view: page the int cols and reduce in JS. Slower, never wrong. */
  const fb = await paginateAll<{
    local_total_sen: number | null;
    balance_sen: number | null;
    balance_sen_live: number | null;
    paid_total_sen: number | null;
  }>((mfrom, mto) =>
    applyMoneyFilters(
      sb
        .from('mfg_sales_orders_with_payment_totals')
        .select('local_total_sen, balance_sen, balance_sen_live, paid_total_sen'),
    ).range(mfrom, mto),
  );
  if (fb.error) return { data: null, error: fb.error };
  let revenueSen = 0, outstandingSen = 0, paidSen = 0;
  for (const m of fb.data ?? []) {
    revenueSen += m.local_total_sen ?? 0;
    outstandingSen += m.balance_sen_live ?? m.balance_sen ?? 0;
    paidSen += m.paid_total_sen ?? 0;
  }
  return { data: { revenueSen, outstandingSen, paidSen }, error: null };
}

mfgSalesOrders.get('/', async (c) => {
  const sb = c.get('supabase');

  /* Row-level visibility scope — list of allowed salesperson_ids (scm.staff
     uuids), or null = unrestricted. Single source of truth in
     lib/salesScope.ts: view-all callers (`*` / scm.so.view_all) → all;
     everyone else → SELF + full manager_id downline chain (owner spec).
     view-all = scm.so.view_all permission OR a director position (Sales
     Director / Super Admin / Finance Manager) via canViewAllSales.
     NOTE: must pass the REAL Houzs integer user id — user.id here is the
     bridge's pinned system staff uuid and feeding it to the scope lookup
     was the non-admin 500 (uuid bound to an integer column). */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  /* Dashboard summary mode (`?summary=1`): the landing page only needs to bucket
     SOs by status and count "new today" — it does NOT need the payment-totals
     view join or the per-line stock-status second query. Return just those 5
     columns so the Dashboard isn't paying for 500 fully-hydrated rows + a
     line-item aggregation on first paint. Bucketing stays in the frontend.
     `proceeded_at` rode along until 2026-08-18 and nothing read it —
     useMfgSalesOrdersSummary has zero callers. */
  if (c.req.query('summary')) {
    let sq = sb
      .from('mfg_sales_orders')
      .select('doc_no, status, local_total_sen, created_at, so_date')
      .neq('status', 'DRAFT')
      .order('so_date', { ascending: false })
      .limit(500);
    if (scopeIds) sq = sq.in('salesperson_id', scopeIds);
    sq = scopeToCompany(sq, c); // multi-company: isolate to the active company
    const { data, error } = await sq;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    return c.json({ salesOrders: data ?? [] });
  }

  /* Follow-up #83 — read from the view that joins payments ledger totals so
     Balance column is live (= local_total − sum(payments)). Header column
     `balance_sen` is still in the SELECT for backward compat (the grid
     falls back to it if the view's `balance_sen_live` is absent). */
  /* VIEW-TRAP (see backend/docs/scm-view-trap-coe.md): this select hits the
     VIEW `mfg_sales_orders_with_payment_totals`, which has a FROZEN column set
     captured at CREATE VIEW time (2990 mig 0155, `SELECT so.*`). Any column you
     add to HEADER above MUST already exist in the view — else this query 500s
     the whole SO list page in prod. If you're adding a new base-table column,
     ship a recreate-view migration in the SAME PR FIRST, or keep the col out
     of HEADER (detail-only). paid_total_sen + balance_sen_live are the
     view's own computed columns, so they are always present. The view still
     projects proceeded_at; the follow-up drop must clear that WITHOUT dropping
     the view ("RETIRING…" carries the 0189/0190/0191 ACL trap). */
  /* customer_po_image_b64 is a base64 PO-slip image that ONLY the SO detail
     page renders (SalesOrderDetail.tsx) — it is never a list-grid column.
     Streaming it per row (up to 500 rows) bloated the SO-list payload for every
     POS-origin SO that carries one. Strip it from the LIST projection only; the
     detail select (~L2241) still reads full HEADER, so nothing the detail shows
     changes. Dropping a column from a SELECT is always VIEW-TRAP safe. */
  const LIST_COLS = `${HEADER.replace(/,\s*customer_po_image_b64/, '')}, paid_total_sen, balance_sen_live`;

  /* Opt-in server-side pagination + search + sort + status-counts.
     WHY: keep this endpoint flat as the SO table grows — the legacy path streams
     up to 500 fully-hydrated rows on every load. The PRESENCE of `page` switches
     paging on; when it is absent/empty the query below is left BYTE-IDENTICAL to
     the historical behavior (order so_date desc, limit 500, status + debtor
     params, `{ salesOrders }` shape) so nothing that calls this today changes.
     Status counts are computed over the FULL scoped set (no status/search/page
     filter) so the tab counts stay stable while the user types or a status tab
     is active — this avoids a page-scoped-KPI bug and mirrors the current FE. */
  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  let data: unknown = null;
  let error: { message: string } | null = null;
  let total = 0;
  let page = 0;
  let pageSize = 50;
  let statusCounts: Record<string, number> | undefined;
  let countError: string | null = null; // held, not returned here, so the LIST read's own error still wins the report
  /* Full-set money KPIs (Revenue / Outstanding / Paid). Pre-pagination the FE
     summed these three view columns over the whole status+search-filtered set;
     paging broke that (the client could only sum the current page → "on this
     page"). We recompute the identical full-set sums server-side here. */
  let aggregates: { revenueSen: number; outstandingSen: number; paidSen: number } | undefined;

  if (!paginate) {
    /* --- LEGACY PATH (unchanged) --- */
    let q = sb.from('mfg_sales_orders_with_payment_totals').select(LIST_COLS).order('so_date', { ascending: false }).limit(500);
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    const status = effectiveStatusFilter(c.req.query('status'));
    /* A tab may cover more than one status — SHIPPED folds into DELIVERED
       (owner 2026-08-22). Read the bucket so the fold is one fact, not a
       spelling repeated at each of the three query sites below. */
    /* The ON_HOLD tab reads the mig-0324 MARKER, not the status. */
    if (status === 'ON_HOLD') q = q.or(HELD_OR_TERM);
    else if (status) { const vals = soStatusesForTab(status); q = vals.length === 1 ? q.eq('status', vals[0]) : q.in('status', vals); }
    const debtor = c.req.query('debtor'); if (debtor) q = q.ilike('debtor_name', `%${debtor}%`);
    const res = await q;
    data = res.data;
    error = res.error;
  } else {
    /* --- PAGINATED PATH (opt-in via `page`) --- */
    page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
    const psRaw = Number(c.req.query('pageSize'));
    pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

    /* sort whitelist — map to the view's columns; anything else → so_date. */
    const SORT_COLS = new Set(['so_date', 'doc_no', 'debtor_name', 'status', 'local_total_sen', 'customer_delivery_date']);
    const [rawCol, rawDir] = (c.req.query('sort') ?? 'so_date:desc').split(':');
    const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'so_date';
    const sortAsc = rawDir === 'asc';

    let q = sb.from('mfg_sales_orders_with_payment_totals').select(LIST_COLS, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
    /* unique tiebreaker so range paging can't skip/repeat rows sharing the sort key */
    if (sortCol !== 'doc_no') q = q.order('doc_no', { ascending: sortAsc });
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    /* status=OTHER → rows whose status is OUTSIDE the known vocabulary (legacy
       spellings / blanks). It exists so the list's "Other" pill — shown only
       when such rows exist — can actually be opened; every real status stays
       the exact-match it always was. */
    const status = effectiveStatusFilter(c.req.query('status'));
    const otherStatusOr = `status.is.null,status.not.in.(${[...SO_STATUSES].join(',')})`;
    if (status === 'ON_HOLD') q = q.or(HELD_OR_TERM);
    else if (status) { const vals = soStatusesForTab(status); q = status === 'OTHER' ? q.or(otherStatusOr) : (vals.length === 1 ? q.eq('status', vals[0]) : q.in('status', vals)); }
    /* free-text search replaces the legacy `debtor` param in this branch.
       One term matches customer NAME (debtor_name), PHONE, or the SO
       REFERENCE (ref) — plus doc_no / debtor_code / agent / location /
       branding it already covered. */
    const search = c.req.query('q');
    if (search) {
      const s = escapeForOr(search);
      if (s) q = q.or([
        `doc_no.ilike.%${s}%`, `debtor_name.ilike.%${s}%`, `debtor_code.ilike.%${s}%`,
        `agent.ilike.%${s}%`, `sales_location.ilike.%${s}%`, `ref.ilike.%${s}%`, `branding.ilike.%${s}%`,
        ...phoneSearchOrParts(s, search, normalizePhone),
      ].join(','));
    }
    /* Optional so_date window (ISO yyyy-mm-dd, inclusive). The mobile list's
       period chips (this-month / last-month / next-month / this-year) send a
       from/to so the range filter runs server-side across the whole table, not
       just the current page. Absent → no date bound. */
    const from = c.req.query('from'); if (from) q = q.gte('so_date', from);
    const to = c.req.query('to'); if (to) q = q.lte('so_date', to);
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);

    /* Status counts over the SAME scope + company filters but WITHOUT the status
       filter, search, or pagination. ONE grouped PostgREST aggregate (status +
       count per bucket) replaced the old four head-only counts, whose shape
       (all/draft/confirmed/cancelled) HID every other live status and stopped
       the buckets summing to All once an SO passed CONFIRMED (owner 2026-07-24:
       "ALL 68 but CONFIRMED 35 — where did they go?"). Aggregates disabled →
       fall back to paging the status column and reducing in JS (precedent:
       outstanding.ts /summary). BOTH reads failing is NOT "no orders": `fb.error`
       was dropped and `fb.data ?? []` read as zero rows, so every pill — and
       `all`, which is their SUM — served 0 beside a full page of orders. That is
       a 500 now, as on the other five SCM lists (scm/lib/status-counts.ts). */
    const scopedCountQ = (q0: any): any =>
      scopeToCompany(scopeIds ? q0.in('salesperson_id', scopeIds) : q0, c);
    /* The held count is its own head-only read because the marker is a COLUMN,
       not a status, so the grouped status aggregate above cannot produce it.
       Same scope + company predicates, no status filter, no search, no paging —
       the strip's other numbers are computed the same way. */
    const heldProm = (async (): Promise<{ ok: true; n: number } | { ok: false; reason: string }> => {
      const r = await scopedCountQ(
        sb.from('mfg_sales_orders').select('*', { count: 'exact', head: true }),
      ).or(HELD_OR_TERM);
      if (r.error) return { ok: false, reason: `on-hold count failed: ${r.error.message}` };
      return { ok: true, n: r.count ?? 0 };
    })();
    const countsProm = (async (): Promise<StatusTally> => {
      const agg = await scopedCountQ(sb.from('mfg_sales_orders').select('status, cnt:doc_no.count()'));
      if (!agg.error) return tallyStatusRows<{ status: string | null; cnt: number }>(agg, (r) => Number(r.cnt ?? 0));
      const fb = await paginateAll<{ status: string | null }>((cfrom, cto) =>
        scopedCountQ(sb.from('mfg_sales_orders').select('status')).range(cfrom, cto));
      /* Named separately from tallyStatusRows' own error branch so the 500 says
         which of the TWO reads died, not just that the second one did. */
      if (fb.error) return { ok: false, reason: `status counts failed: aggregate ${agg.error.message}; fallback ${fb.error.message}` };
      return tallyStatusRows(fb, () => 1);
    })();

    /* Full-set money KPIs — Revenue / Outstanding / Paid over the SAME scope +
       company + status + search (+ optional so_date window) filters as the page
       query, but WITHOUT `.range()`/pagination.

       `applyMoneyFilters` is that predicate set, built ONCE, so the aggregate
       fast path and its paginateAll fallback (both inside soListMoneyKpis) apply
       byte-identical filters and cannot drift. These are the identical money
       predicates this path applied before; the only change is that the SUM now
       happens in ONE server-side grouped aggregate instead of paging the whole
       filtered set and summing in JS.

       Paid + Outstanding read the view's LEDGER-DERIVED columns, not the stored
       `paid_sen` / `balance_sen`. Those two are not the truth: `paid_sen`
       has no writer that maintains it (deprecated, scheduled for drop), and
       `balance_sen` is set to the GROSS grandTotal by recomputeTotals on every
       edit, so it never reflects a payment — the old Outstanding tile was just
       Revenue restated. paid_total_sen (= Σ payments) and balance_sen_live
       (= local_total − Σ payments) are the same source-of-truth the row grid,
       the mobile SO list and delivery-planning.ts already read, and both are
       view-COMPUTED columns, so this stays VIEW-TRAP safe (see
       backend/docs/scm-view-trap-coe.md). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shared closure is applied to both the aggregate `.select('...sum()')` builder and the paged builder; the aggregate select defeats supabase-js's column-type inference (same reason as outstanding.ts /summary)
    const applyMoneyFilters = (moneyQ0: any): any => {
      let moneyQ = moneyQ0;
      if (scopeIds) moneyQ = moneyQ.in('salesperson_id', scopeIds);
      moneyQ = scopeToCompany(moneyQ, c);
      if (status === 'ON_HOLD') moneyQ = moneyQ.or(HELD_OR_TERM);
      else if (status) { const vals = soStatusesForTab(status); moneyQ = status === 'OTHER' ? moneyQ.or(otherStatusOr) : (vals.length === 1 ? moneyQ.eq('status', vals[0]) : moneyQ.in('status', vals)); }
      if (search) {
        const ms = escapeForOr(search);
        if (ms) moneyQ = moneyQ.or(`doc_no.ilike.%${ms}%,debtor_name.ilike.%${ms}%,debtor_code.ilike.%${ms}%,agent.ilike.%${ms}%,sales_location.ilike.%${ms}%,ref.ilike.%${ms}%,branding.ilike.%${ms}%`);
      }
      if (from) moneyQ = moneyQ.gte('so_date', from);
      if (to) moneyQ = moneyQ.lte('so_date', to);
      return moneyQ;
    };
    const moneyProm = soListMoneyKpis(sb, applyMoneyFilters);

    /* One concurrent wave. The page rows, the grouped status counts and the
       full-set money KPIs are mutually independent — each keys off scopeIds +
       the same filter params, none reads the page result — yet they were paying
       three sequential DB round-trips. Fire them together; only the per-doc
       enrichment below actually needs the page rows, so it still follows. */
    const [res, counted, moneyRes, heldCount] = await Promise.all([q, countsProm, moneyProm, heldProm]);
    data = res.data;
    error = res.error;
    total = res.count ?? (res.data?.length ?? 0);
    /* A page whose offset is at/beyond the row count is an EMPTY PAGE, not a
       failure. PostgREST answers it PGRST103 / 416 "Requested range not
       satisfiable" instead of an empty 200, and this handler turned that into a
       500 — which the grid masked as "No sales orders yet" (the 2026-08-18
       incident: `?status=all` matched zero rows, so page 1 exceeded the count).
       Empty status tab, no-match search, last page + 1 all land here; `res.count`
       still carries the true total via PostgREST's `Content-Range` header. */
    if (error && isRangeNotSatisfiable(error)) {
      data = [];
      total = res.count ?? 0;
      error = null;
    }
    /* Every status in the vocabulary gets a bucket (lowercase keys, the wire
       shape the tabs read), plus `other` for anything OUTSIDE it (legacy
       spellings, blanks) — so the visible buckets ALWAYS sum to `all` and no
       order can silently fall between tabs again. */
    if (!counted.ok) countError = counted.reason;
    else {
      const allCount = Object.values(counted.byStatus).reduce((s, n) => s + n, 0);
      let known = 0;
      statusCounts = { all: allCount };
      /* Counted per TAB, not per status, so a folded status is counted under
         the tab that shows it instead of falling into `other`. */
      for (const [tab, members] of Object.entries(SO_TAB_STATUSES)) {
        const cnt = members.reduce((n, m) => n + (counted.byStatus[m] ?? 0), 0);
        statusCounts[tab.toLowerCase()] = cnt; known += cnt;
      }
      statusCounts.other = allCount - known;
      /* THE On Hold PILL IS AN OVERLAY, NOT A BUCKET (mig 0324), and it is the
         one number on this strip that does not partition the set. A held order
         keeps its real status, so it is counted under that status AND here —
         the same deliberate overlap the Purchase Order list's `outstanding`
         pill has carried since 2026-07-31.

         `known` is NOT adjusted, and that is what protects the invariant the
         owner bought in 2026-07-24 ("ALL 68 but CONFIRMED 35 — where did they
         go?"): every order is still counted exactly once by the status walk
         above, so `other` stays exact and no order can fall between tabs.
         Overwriting the value afterwards is deliberate — the walk's ON_HOLD
         entry counts LEGACY rows only, and this count covers both. */
      if (heldCount.ok) statusCounts.on_hold = heldCount.n;
      else countError = heldCount.reason;
    }

    if (moneyRes.error || !moneyRes.data) return c.json({ error: 'load_failed', reason: moneyRes.error?.message ?? 'money_kpis_failed' }, 500);
    aggregates = moneyRes.data;
  }
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (countError) return c.json({ error: 'status_counts_failed', reason: countError }, 500);

  /* PR — Commander 2026-05-28: Stock Status chip column.
     Per-SO aggregate computed from mfg_sales_order_items.stock_status grouped
     by item_group. UI renders:
       · empty            — no category fully ready
       · ["MATTRESS"]     — all mattress lines READY, but other categories pending
       · isFullyReady     — every non-cancelled line READY (chip column shows "READY")
     We hand the per-row arrays back so the UI doesn't need a second round-trip. */
  const rows = (data ?? []) as Array<{ doc_no?: string } & Record<string, unknown>>;
  const docNos = rows.map((r) => r.doc_no).filter((x): x is string => !!x);
  if (docNos.length > 0) {
    /* PERF: every per-doc_no enrichment read below only needs `docNos`, so they
       are independent of one another AND of the item/catalog chain. Launch them
       all up-front so they run as ONE concurrent wave instead of ~6 serial
       round-trips. supabase-js builders are lazy (the request fires on await/
       then), so each is wrapped in an immediately-invoked async thunk to kick it
       off now; each is awaited at its original use-site below, so results and
       error propagation are unchanged. This was the SO list's dominant cost
       (~390ms desktop / ~650ms mobile, almost all serial DB latency). */
    /* chunkIn on every `docNos` read below — the LEGACY arm reads `.limit(500)`, so each URL carried 500 doc numbers (~9.5KB). All feed doc-keyed maps. */
    const payRowsProm = (async () =>
      (await chunkIn(docNos, (batch, from, to) => sb.from('mfg_sales_order_payments')
        .select('so_doc_no, method, online_type').in('so_doc_no', batch).order('so_doc_no').range(from, to))).data)();
    // DO No. rides this read rather than a query of its own — the list's cost
    // is round-trips, not rows (see so-delivery-order-nos.ts).
    const downstreamProm = Promise.all([
      chunkIn(docNos, (batch, from, to) => sb.from('delivery_orders').select('id, so_doc_no, do_number, do_date, created_at').in('so_doc_no', batch).neq('status', 'CANCELLED').order('so_doc_no').range(from, to)),
      chunkIn(docNos, (batch, from, to) => sb.from('sales_invoices').select('id, so_doc_no, invoice_number').in('so_doc_no', batch).neq('status', 'CANCELLED').order('so_doc_no').range(from, to)),
    ]);
    const deliverableProm = soDeliverableRemaining(sb, docNos);
    const lifecycleProm = Promise.all([
      computeSoLifecycle(sb, docNos),
      soCurrentDocNo(sb, docNos),
    ]);
    const whRowsProm = (async () =>
      (await sb.from('warehouses').select('id, code, name')).data ?? [])();
    const baseRowsProm = (async () =>
      (await chunkIn(docNos, (batch, from, to) => sb.from('mfg_sales_orders')
        .select('doc_no, delivery_state, amended_delivery_date').in('doc_no', batch).order('doc_no').range(from, to))).data)();
    /* PO No. column (owner 2026-07-24): the system Purchase Order numbers this
       SO was converted into. Its own SO-line→PO-item→PO chain, independent of
       every other enrichment above, so it rides the same concurrent wave.
       Since 2026-08-02 this is the TOOLTIP-only legacy raise-link — the visible
       chips come from source_po_union below. */
    const convertedPoProm = soConvertedPoNumbers(sb, docNos);
    /* Source-PO union (owner 2026-08-02, "他拿的货是谁的货"): the list "PO No."
       column shows the union of per-line source chips the drill shows —
       SHIPPED/DELIVERED consumed batches ∪ READY projections. Only the SHIPPED
       arm is computed HERE (cheap real-batch reads); the READY arm needs the
       GLOBAL MRP allocation (`computeMrp`), which paginates the company's whole
       products / balances / PO-lines / SO-lines tables and was the dominant cost
       of opening this list. It — and the readiness/planning fields it also fed
       (see below) — are no longer on this path. The client fetches them a beat
       later from GET /mfg-sales-orders/list-mrp-enrichment and merges them in
       (lib/so-list-mrp-enrichment.ts). */

    /* Order deterministically so the FIRST line per doc_no is the earliest
       one created (matches the detail endpoint's `.order('created_at')`). We
       add `branding`, `item_code` and `created_at` to the select: branding is
       the mattress brand source for the first-item rule below; item_code lets
       us fall back to mfg_products.branding when a mattress line's own branding
       is blank; created_at drives the first-line pick. */
    /* chunkIn, not paginateAll: the latter bounded the ROWS and re-sent all 500 doc numbers
       in every page's URL. Splitting on doc_no keeps each SO's lines together and ordered
       as before, so the "first line per doc_no" rule below picks the same row. */
    const { data: itemRows } = await chunkIn<{ id: string; doc_no: string; item_group: string | null; stock_status: string | null; cancelled: boolean; branding: string | null; item_code: string | null; warehouse_id: string | null; created_at: string; qty: number | null; allocated_batch_no: string | null }>(docNos, (batch, from, to) => sb
      .from('mfg_sales_order_items')
      // id / qty / allocated_batch_no ride along for the source-PO union below
      // (per-line shipped trace + READY projection — the drill's exact inputs).
      .select('id, doc_no, item_group, stock_status, cancelled, branding, item_code, warehouse_id, created_at, qty, allocated_batch_no')
      .in('doc_no', batch)
      .eq('cancelled', false)
      .order('doc_no')
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(from, to));
    /* Per-line SHIPPED source trace for the whole page — the same resolver call
       the drill makes per SO, batched once (chunked internally). Fired now so it
       overlaps the remaining enrichment reads; awaited at the union below. */
    const shippedTraceProm = soLineShippedSources(sb, itemRows.map((it) => it.id));
    const agg = new Map<string, Map<string, { total: number; ready: number }>>();
    /* Branding auto-derive (Commander 2026-05-28, refined PR #266): the SO list
       grid derives its Branding pill from the SO's FIRST line item — no longer
       "Mixed" when categories differ. We track per doc_no:
         · item_categories     — DISTINCT normalized categories (kept for back-compat)
         · first_item_category — normalized category of the earliest-created line
         · first_item_branding — that line's own `branding` text (the mattress brand)
       The header revenue columns merge mattress + sofa into one bucket, so the
       grid can't tell SOFA from MATTRESS at the header level — hence this
       per-line first-item read (from the same fetch already running for stock
       status). The UI maps these through shared/so-branding-label (owner
       2026-08-18): SOFA → the COMPANY's house sofa brand ("ZANOTTI" for Houzs,
       "2990s Sofa" for 2990 — the line's own text is not consulted), BEDFRAME →
       "Bedframe", MATTRESS → first_item_branding, which is the SKU's brand
       (resolved SKU-first below), falling back to "Mattress" when the SKU
       carries none; everything else names its category. */
    const cats = new Map<string, Set<string>>();
    const firstCat = new Map<string, string>();
    const firstBranding = new Map<string, string | null>();
    const firstItemCode = new Map<string, string | null>();
    /* Primary warehouse per SO — the FIRST non-null line warehouse_id (mirrors
       the Delivery Planning board's primaryWh = warehouseIds[0]). Drives the
       mobile Orders-list card's warehouse_name. */
    const firstWarehouseByDoc = new Map<string, string>();
    const allCodes = new Set<string>();
    const normCategory = (raw: string): string => {
      const g = (raw ?? '').trim().toUpperCase();
      if (g.includes('BEDFRAME')) return 'BEDFRAME';
      if (g.includes('SOFA'))     return 'SOFA';
      if (g.includes('MATTRESS')) return 'MATTRESS';
      if (g.includes('ACCESSOR')) return 'ACCESSORY';
      if (g.includes('SERVICE')) return 'SERVICE'; // SO-SKU spec P2 — synced with normCat below
      return 'OTHERS';
    };
    for (const it of itemRows as unknown as Array<{ doc_no: string; item_group: string; stock_status: string; cancelled: boolean; branding: string | null; item_code: string | null; warehouse_id: string | null; created_at: string | null }>) {
      let perGroup = agg.get(it.doc_no);
      if (!perGroup) { perGroup = new Map(); agg.set(it.doc_no, perGroup); }
      const g = (it.item_group ?? '').trim().toUpperCase() || 'OTHERS';
      let cell = perGroup.get(g);
      if (!cell) { cell = { total: 0, ready: 0 }; perGroup.set(g, cell); }
      cell.total += 1;
      if (it.stock_status === 'READY') cell.ready += 1;

      let catSet = cats.get(it.doc_no);
      if (!catSet) { catSet = new Set(); cats.set(it.doc_no, catSet); }
      catSet.add(normCategory(it.item_group));
      if (it.item_code) allCodes.add(it.item_code);
      /* First non-null line warehouse per doc (rows are line_no/created_at
         ordered) — the SO's primary warehouse for the mobile card. */
      if (it.warehouse_id && !firstWarehouseByDoc.has(it.doc_no)) {
        firstWarehouseByDoc.set(it.doc_no, it.warehouse_id);
      }

      /* Rows arrive ordered by (doc_no, created_at ASC) so the first time we
         see a doc_no IS its earliest line — record it once. */
      if (!firstCat.has(it.doc_no)) {
        firstCat.set(it.doc_no, normCategory(it.item_group));
        firstBranding.set(it.doc_no, it.branding ?? null);
        firstItemCode.set(it.doc_no, it.item_code ?? null);
      }
    }

    /* Resolve each line's category from the CATALOG (mfg_products.category),
       not just the line's free-text item_group. A sofa module line saved with
       item_group 'others' (or a leading SERVICE/delivery line) must not blank
       the SO's Branding pill — so we (a) trust the catalog category and (b) pick
       the first MAIN line (sofa/bedframe/mattress) as the SO's representative,
       falling back to the earliest line when there is none. Batch-fetch the
       catalog by the codes actually in view (bounded .in, chunked — never the
       whole table) so this can't hit the PostgREST row cap. The same map also
       supplies the mattress-brand fallback (mfg_products.branding). */
    const productCategory = new Map<string, string>();
    const productBranding = new Map<string, string>();
    const codeList = [...allCodes];
    for (let i = 0; i < codeList.length; i += 300) {
      const chunk = codeList.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: prodRows } = await scopeToCompany(
        sb
          .from('mfg_products')
          .select('code, category, branding')
          .in('code', chunk),
        c,
      );
      for (const p of (prodRows ?? []) as Array<{ code: string; category: string | null; branding: string | null }>) {
        if (p.category) productCategory.set(p.code, normCategory(p.category));
        if (p.branding && p.branding.trim()) productBranding.set(p.code, p.branding);
      }
    }
    const resolveLineCat = (code: string | null, group: string): string =>
      (code ? productCategory.get(code) : undefined) ?? normCategory(group);
    const MAIN_CATS = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);
    /* First MAIN line per doc (catalog-resolved), re-iterating the already
       (doc_no, line_no, created_at)-ordered itemRows. Falls back to the earliest
       line captured above when an SO has no sofa/bedframe/mattress line. */
    const repCat = new Map<string, string>();
    const repBranding = new Map<string, string | null>();
    const repCode = new Map<string, string | null>();
    for (const it of itemRows as unknown as Array<{ doc_no: string; item_group: string; branding: string | null; item_code: string | null }>) {
      if (repCat.has(it.doc_no)) continue;
      const cat = resolveLineCat(it.item_code, it.item_group);
      if (MAIN_CATS.has(cat)) {
        repCat.set(it.doc_no, cat);
        repBranding.set(it.doc_no, it.branding ?? null);
        repCode.set(it.doc_no, it.item_code ?? null);
      }
    }

    /* Bedframe-only branding (Commander 2026-07-16): "如果 BEDFRAME only 的话
       branding 就放 BEDFRAME". When an SO's lines are ALL bedframe — at least
       one BEDFRAME line and NO branded MATTRESS/SOFA line — its Branding pill
       reads "BEDFRAME" instead of a blank dash. Built from the SAME catalog-
       resolved per-line category (resolveLineCat), so a sofa-module line mis-
       saved with item_group 'others' can't fool it into hiding an AKEMI/2990
       brand. Non-branded ACCESSORY / SERVICE / OTHERS lines carry no brand and
       may legitimately ride along, so they don't disqualify. */
    const resolvedCatsByDoc = new Map<string, Set<string>>();
    for (const it of itemRows as unknown as Array<{ doc_no: string; item_group: string; item_code: string | null }>) {
      let s = resolvedCatsByDoc.get(it.doc_no);
      if (!s) { s = new Set(); resolvedCatsByDoc.set(it.doc_no, s); }
      s.add(resolveLineCat(it.item_code, it.item_group));
    }
    const isBedframeOnly = (docNo: string): boolean => {
      const s = resolvedCatsByDoc.get(docNo);
      return !!s && s.has('BEDFRAME') && !s.has('MATTRESS') && !s.has('SOFA');
    };

    /* Commander 2026-05-29 (#19) — Payment Method column summarises the
       payments LEDGER, not just the header's single payment_method field. A
       SO can be settled across several methods (e.g. a cash deposit + a card
       balance), so we collect the DISTINCT method labels per doc_no and join
       them with " + " (→ "Cash + Card"). Label rules mirror the payment form
       cascade: cash→"Cash"; merchant→"Card"; transfer→its online_type
       (Bank Transfer / TNG / Cheque / DuitNow) when set, else "Transfer";
       installment→"Installment" (2026-06-06 unify — these rows were
       silently dropped from the summary before).
       One cheap batched read over the same doc_no set already in play. */
    const paymentMethods = new Map<string, Set<string>>();
    {
      const payRows = await payRowsProm;
      for (const p of payRows as unknown as Array<{ so_doc_no: string; method: string | null; online_type: string | null }>) {
        const m = (p.method ?? '').trim().toLowerCase();
        let label: string;
        if (m === 'cash') label = 'Cash';
        else if (m === 'merchant') label = 'Card';
        else if (m === 'transfer') label = (p.online_type && p.online_type.trim()) ? p.online_type.trim() : 'Transfer';
        else if (m === 'installment') label = 'Installment';
        else continue;
        let set = paymentMethods.get(p.so_doc_no);
        if (!set) { set = new Set(); paymentMethods.set(p.so_doc_no, set); }
        set.add(label);
      }
    }

    /* Tier 2 downstream-lock — one extra batched read per doc set: pull every
       non-cancelled DO/SI that points back to a listed SO and mark has_children
       on the row. The list grid uses this to hide Edit / Cancel from SOs that
       are downstream-locked (mirrors computeGrnFlags in lib/grn-consumption-flags). */
    const [doRowsRes, siRowsRes] = await downstreamProm;
    const doNosBySo = doNosBySalesOrder(doRowsRes.data as unknown as DeliveryOrderNoRow[]);
    const downRefsBySo = soDownstreamRefs(doRowsRes.data as unknown as DeliveryOrderNoRow[], siRowsRes.data); // do_refs + si_refs: the row menu prints by ADDRESS, not by number
    const downstreamDocNos = soDocNosWithDownstream(doRowsRes.data, siRowsRes.data);

    /* B2C readiness summary per SO (Commander 2026-05-30) — derive the
       "Stock Remark" the operator's existing ERP shows: READY, PARTIAL
       (every MAIN line in, an accessory not), or the "/"-joined list of
       groups that ARE in — blank when none is, because it names what IS
       ready (owner 2026-08-16). `category` rides along from the catalog map
       already built above (productCategory, zero extra reads): it is
       isServiceLine's strongest signal, so a delivery/dispose SKU whose line
       item_group was saved as 'others' is still recognised as a SERVICE line
       and cannot masquerade as a short accessory. */
    /* FIRST PAINT uses the STORED stock_status alone (`null` live coverage —
       so-line-effective-stock.ts's fail-soft path: the stored value stands).
       The MRP-corrected verdict — which can flip a stale-stored line to READY,
       the 2026-08-17 union — arrives with the deferred enrichment fetch and the
       client overlays stock_remark / is_main_ready / planning_state then. Not
       running computeMrp here is the whole point of the deferral. */
    const readinessByDoc = new Map<string, ReturnType<typeof summariseReadiness>>();
    /* Third argument null: the list first-paint reads the payment-totals VIEW
       (frozen column set, no processing_date) — and with null coverage the
       promotion arm cannot fire anyway, so "cannot say" is exact. */
    const linesByDoc = readinessLinesByDoc(itemRows, null, null);
    attachLineCategories(linesByDoc.values(), productCategory);
    for (const [docNo, ls] of linesByDoc) readinessByDoc.set(docNo, summariseReadiness(ls));

    /* "Has undelivered qty" per SO (Wei Siang 2026-05-30) — drives the Issue
       Delivery Order menu gate. Recomputed LIVE (remaining = qty − delivered +
       returned, cancelled DOs excluded) by the same helper the line-level
       picker uses, so it re-opens after a DO is cancelled / a DO line is
       deleted and closes once every line is fully delivered. Replaces the old
       status-only gate that hid the action at SHIPPED/DELIVERED. */
    const hasUndelivered = new Set<string>();
    /* Per-SO delivery progress — the verdict AND the numbers, §0.4b. */
    const deliveredTotal = new Map<string, number>();
    const remainingTotal = new Map<string, number>();
    /* Fully-shipped LINE ids — the union below suppresses READY chips for them,
       exactly as the drill's SoSourceChips does. */
    const fullyShippedItemIds = new Set<string>();
    {
      const deliverableMap = await deliverableProm;
      for (const [itemId, line] of deliverableMap.entries()) {
        if (line.remaining > 0) hasUndelivered.add(line.docNo);
        else if (line.delivered > 0) fullyShippedItemIds.add(itemId);
        deliveredTotal.set(line.docNo, (deliveredTotal.get(line.docNo) ?? 0) + line.delivered);
        remainingTotal.set(line.docNo, (remainingTotal.get(line.docNo) ?? 0) + line.remaining);
      }
    }

    /* Per-SO status badge driver — "latest event wins" across DO / SI / DR
       (Wei Siang 2026-05-31). 'none' falls back to the stored status. */
    const [lifecycleByDoc, currentByDoc] = await lifecycleProm;

    /* Warehouse label map (id → label) for the Orders-list `warehouse_name`.
       Small master, unpaginated. This map used to be the ONE name-first label
       in the codebase, so the same warehouse read "BALAKONG WAREHOUSE" here and
       "KL WAREHOUSE" on every document — it now shares warehouseLabel() with
       them, which also makes a correctly-derived SO's label identical to its
       stored sales_location text. */
    const whName = new Map<string, string>();
    {
      const whRows = await whRowsProm;
      for (const w of (whRows ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
        const label = warehouseLabel(w);
        if (label) whName.set(w.id, label);
      }
    }

    /* Planning-state inputs that live ONLY on the BASE table (NOT in the
       payment-totals VIEW backing this list): the manual delivery_state override
       and amended_delivery_date. Per the VIEW-TRAP CoE these post-view columns
       must NEVER be added to LIST_COLS/HEADER (they 500 the list), so read them
       straight off mfg_sales_orders keyed by doc_no. customer_delivery_date +
       status are already on the view rows (`r`). */
    const overrideByDoc = new Map<string, string | null>();
    const amendedDDByDoc = new Map<string, string | null>();
    {
      const baseRows = await baseRowsProm;
      for (const b of baseRows as unknown as Array<{ doc_no: string | null; delivery_state?: string | null; deliveryState?: string | null; amended_delivery_date?: string | null; amendedDeliveryDate?: string | null }>) {
        if (!b.doc_no) continue;
        overrideByDoc.set(b.doc_no, b.deliveryState ?? b.delivery_state ?? null);
        amendedDDByDoc.set(b.doc_no, b.amendedDeliveryDate ?? b.amended_delivery_date ?? null);
      }
    }
    const planningToday = todayMyt();

    // PO No. — SO doc_no → system PO numbers it was converted into (see wave).
    const convertedPoByDoc = await convertedPoProm;

    /* Source-PO union per SO (defect 2026-08-02-A): SHIPPED arm only on this
       path — shipped trace from `shippedTraceProm` (cheap real-batch reads),
       run through the SAME pure union the drill uses with an EMPTY ready map.
       The READY arm (`soLineReadySourcePos`, which needs the global MRP run)
       arrives via GET /mfg-sales-orders/list-mrp-enrichment and the client
       unions its chips into this column. Union(shipped-only, ready-only) per
       doc equals the old combined union (set union is associative), so the
       final displayed chips are unchanged; they just fill in a beat later. */
    const sourceUnionByDoc = await (async () => {
      try {
        const pageItems = itemRows as unknown as Array<{ id: string; doc_no: string }>;
        const shippedByItem = await shippedTraceProm;
        return unionSoLineChips(
          pageItems.map((it) => ({ id: it.id, docNo: it.doc_no })),
          shippedByItem,
          new Map(),
          fullyShippedItemIds,
        );
      } catch {
        return new Map<string, { pos: string[]; adj: boolean }>();
      }
    })();

    for (const r of rows) {
      const docNo = r.doc_no ?? '';
      const perGroup = agg.get(docNo);
      (r as Record<string, unknown>).item_categories = [...(cats.get(docNo) ?? [])].sort();
      /* The PO numbers this SO produced (LEGACY convert-time raise-link; empty
         array when none). Kept for the FE tooltip — the VISIBLE chips are
         source_po_union below (owner 2026-08-02: the list must show the same
         union of per-line source chips the drill shows). */
      (r as Record<string, unknown>).converted_po_nos = convertedPoByDoc.get(docNo) ?? [];
      /* Union of per-line source-PO chips (shipped ∪ READY projection) — the
         drill's exact visible set, rolled up per SO.
         C16 CONTRACT: source_po_union / source_po_adj / stock_remark /
         is_main_ready / planning_state are the MRP-DERIVED fields emitted here
         as stored-status placeholders and HEALED by GET /list-mrp-enrichment. If
         you add another field whose value depends on the MRP allocation, add it
         to the enrichment path too — MRP_DERIVED_LIST_FIELD_MAP
         (frontend/src/lib/soListEnrichment.ts) + SO_LIST_MRP_ENRICHMENT_KEYS
         (scm/lib/so-list-mrp-enrichment.ts); the parity tests fail otherwise. */
      (r as Record<string, unknown>).source_po_union = sourceUnionByDoc.get(docNo)?.pos ?? [];
      (r as Record<string, unknown>).source_po_adj = sourceUnionByDoc.get(docNo)?.adj ?? false;
      (r as Record<string, unknown>).has_children = downstreamDocNos.has(docNo);
      const dDelivered = deliveredTotal.get(docNo) ?? 0;
      const dRemaining = remainingTotal.get(docNo) ?? 0;
      (r as Record<string, unknown>).delivery_state =
        dDelivered <= 0 ? 'none' : dRemaining > 0 ? 'partial' : 'full';
      (r as Record<string, unknown>).shipped_qty = dDelivered;          // §0.4b
      (r as Record<string, unknown>).deliverable_qty = dDelivered + dRemaining;
      (r as Record<string, unknown>).lifecycle_state = lifecycleByDoc.get(docNo) ?? 'none';
      (r as Record<string, unknown>).current_doc_no = currentByDoc.get(docNo) ?? (docNo || null);
      (r as Record<string, unknown>).do_nos = doNosBySo.get(docNo) ?? [];
      Object.assign(r as Record<string, unknown>, downRefsBySo.get(docNo) ?? NO_SO_DOWNSTREAM_REFS);
      (r as Record<string, unknown>).has_undelivered = hasUndelivered.has(docNo);
      const readiness = readinessByDoc.get(docNo);
      (r as Record<string, unknown>).stock_remark = readiness?.stockRemark ?? '';
      (r as Record<string, unknown>).is_main_ready = readiness?.isMainReady ?? false;
      /* Orders-list card fields (snake_case, dual-read by the FE):
         · warehouse_name  — the SO's primary line warehouse label (null until
           set). Desktop AND mobile both render the Location column from this,
           falling back to the free-text sales_location snapshot only when no
           line carries a warehouse.
         · planning_state  — the 4-state Delivery-Planning status, derived from the
           SAME shared helper the board uses. delivery_state (above) is the DO-
           progress none/partial/full field — this is the ORTHOGONAL planning
           status; both are emitted. */
      const primaryWh = firstWarehouseByDoc.get(docNo) ?? null;
      (r as Record<string, unknown>).warehouse_name = primaryWh ? (whName.get(primaryWh) ?? null) : null;
      const effectiveDD = (amendedDDByDoc.get(docNo) ?? null) ?? ((r as Record<string, unknown>).customer_delivery_date as string | null ?? null);
      (r as Record<string, unknown>).planning_state = derivePlanningState({
        storedOverride: overrideByDoc.get(docNo) ?? null,
        status: (r as Record<string, unknown>).status as string | null,
        readiness: { isShipReady: readiness?.isShipReady ?? false },
        delivered: dDelivered,
        remaining: dRemaining,
        effectiveDD,
        today: planningToday,
      });
      /* First-item branding source (PR #266; catalog-resolved + mains-first). */
      const hasRep = repCat.has(docNo);
      const fCat = (hasRep ? repCat.get(docNo) : firstCat.get(docNo)) ?? null;
      (r as Record<string, unknown>).first_item_category = fCat ?? null;
      let fBranding = (hasRep ? repBranding.get(docNo) : firstBranding.get(docNo)) ?? null;
      /* MATTRESS reads the SKU FIRST, not just as a fallback (owner 2026-08-18:
         «mattress follow SKU branding»). The line's own text only survives when
         the catalog has none. Six live 2990 lines carry the loose spellings
         "2990" / "2990s" while their SKU says "2990s Mattress"; under the old
         blank-only borrow they kept the loose text and the label rule needed a
         normalisation regex to recover from it. Reading the catalog first makes
         that regex unnecessary — and it is deleted, not left dormant. */
      if (fCat === 'MATTRESS') {
        const code = hasRep ? repCode.get(docNo) : firstItemCode.get(docNo);
        const skuBrand = code ? productBranding.get(code) : undefined;
        if (skuBrand && skuBrand.trim()) fBranding = skuBrand;
      }
      /* Bedframe-only SO → "BEDFRAME" pill (only when no explicit brand text
         is present, so an AKEMI/2990 line always wins). */
      if ((!fBranding || !fBranding.trim()) && isBedframeOnly(docNo)) {
        fBranding = 'BEDFRAME';
      }
      (r as Record<string, unknown>).first_item_branding = fBranding;
      /* #19 — distinct ledger payment methods, sorted + joined ("Cash + Card").
         Empty string when no payments recorded yet (UI falls back to the
         header payment_method field). */
      const pm = paymentMethods.get(docNo);
      (r as Record<string, unknown>).payment_methods_summary = pm ? [...pm].sort().join(' + ') : '';
      if (!perGroup) {
        (r as Record<string, unknown>).ready_categories = [];
        (r as Record<string, unknown>).is_fully_ready = false;
        continue;
      }
      const ready: string[] = [];
      let allReady = true;
      for (const [grp, cell] of perGroup) {
        if (cell.total > 0 && cell.ready === cell.total) ready.push(grp);
        else allReady = false;
      }
      (r as Record<string, unknown>).ready_categories = ready;
      (r as Record<string, unknown>).is_fully_ready = allReady && perGroup.size > 0;
    }
  }

  /* Finance gate — strip cost / margin / per-category subtotals + deposit from
     every row unless the caller is a finance-viewer. The KPI aggregates above
     read local_total / balance / paid only, so they are unaffected. */
  if (!canViewScmFinance(c)) {
    for (const r of rows) {
      for (const k of SO_FINANCE_KEYS) delete (r as Record<string, unknown>)[k];
    }
  }

  if (paginate) return c.json({ salesOrders: rows, total, page, pageSize, statusCounts, aggregates });
  return c.json({ salesOrders: rows });
});

/* ── Customer directory (server-side aggregation) ─────────────────────────────
   Ported from 2990's backend Customers page, which GROUP BYs the Sales-Order
   debtor CLIENT-side over the legacy 500-row list. Houzs has no dedicated
   `customers` table — SOs carry denormalised debtor_name / phone — so the
   "directory" is a GROUP BY over mfg_sales_orders. We do the aggregation
   SERVER-side here (paginateAll pages past the 1000-row PostgREST cap) so it
   scales past 500 rows and stays company + sales-scope scoped like the list.

   Key = phone (trimmed) when present, else `name:<lower(debtor_name)>`, matching
   2990's aggregate(). CANCELLED + ON_HOLD are excluded from lifetime value and
   the directory (same exclusion set as 2990). Money is centi (integers); the FE
   divides by 100. Registered BEFORE '/:docNo' so 'customers' is never a doc-no
   param, and under the scm.sales.orders area guard (scm/index.ts mounts the whole
   /mfg-sales-orders/* subtree behind scmAreaGuard('scm.sales.orders')). */
type CustomerSoRow = {
  doc_no: string;
  status: string;
  debtor_name: string | null;
  phone: string | null;
  local_total_sen: number | null;
  created_at: string | null;
  so_date: string | null;
  line_count: number | null;
};
type CustomerOrder = {
  doc_no: string;
  status: string;
  so_date: string | null;
  created_at: string | null;
  local_total_sen: number;
  line_count: number;
};
type CustomerEntry = {
  key: string;
  name: string;
  phone: string | null;
  order_count: number;
  lifetime_value_sen: number;
  last_order_at: string;
  orders: CustomerOrder[];
};
const customerSoDateOf = (o: { created_at: string | null; so_date: string | null }): string =>
  o.created_at ?? o.so_date ?? '';

mfgSalesOrders.get('/customers', async (c) => {
  const sb = c.get('supabase');
  /* Same row-level visibility scope as the SO list: allowed salesperson ids
     (self + downline) or null = unrestricted. Pass the REAL Houzs integer user
     id, NOT the pinned system-staff uuid (the scm.staff-UUID bigint trap). */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  const { data, error } = await paginateAll<CustomerSoRow>((from, to) => {
    let q = sb
      .from('mfg_sales_orders')
      .select('doc_no, status, on_hold, debtor_name, phone, local_total_sen, created_at, so_date, line_count')
      .order('so_date', { ascending: false });
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    return q.range(from, to);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const map = new Map<string, CustomerEntry>();
  for (const o of (data ?? [])) {
    // CANCELLED + ON_HOLD don't count toward LTV / the directory (2990 parity).
    /* `on_hold` since mig 0324 — a held order's status is its real status, so
       the two labels below stopped being able to see a hold on their own. */
    if (isDocumentHeld(o) || o.status === 'CANCELLED' || o.status === 'ON_HOLD') continue;
    const key = o.phone?.trim() || `name:${(o.debtor_name ?? '').toLowerCase().trim()}`;
    if (!key || key === 'name:') continue;

    const totalSen = o.local_total_sen ?? 0;
    const when = customerSoDateOf(o);
    const order: CustomerOrder = {
      doc_no: o.doc_no,
      status: o.status,
      so_date: o.so_date,
      created_at: o.created_at,
      local_total_sen: totalSen,
      line_count: o.line_count ?? 0,
    };

    const existing = map.get(key);
    if (existing) {
      existing.order_count += 1;
      existing.lifetime_value_sen += totalSen;
      existing.orders.push(order);
      // Denormalised name/phone snapshots can drift — keep the most recent.
      if (when > existing.last_order_at) {
        existing.last_order_at = when;
        existing.name = o.debtor_name || existing.name;
        existing.phone = o.phone ?? existing.phone;
      }
    } else {
      map.set(key, {
        key,
        name: o.debtor_name || 'Walk-in',
        phone: o.phone ?? null,
        order_count: 1,
        lifetime_value_sen: totalSen,
        last_order_at: when,
        orders: [order],
      });
    }
  }

  const customers = Array.from(map.values());
  for (const cust of customers) {
    cust.orders.sort((a, b) => (customerSoDateOf(a) < customerSoDateOf(b) ? 1 : -1));
  }
  customers.sort((a, b) => (a.last_order_at < b.last_order_at ? 1 : -1));

  return c.json({ customers });
});

/* Salesperson MTD scoreboard — feeds the mobile Profile v7 tiles
   (Orders MTD / Sales MTD). Self-scoped the same way as '/mine':
   salesperson_id === auth user id, on the caller's RLS-scoped client, so a
   caller only ever sees their OWN orders. Counts orders created within the
   current Malaysia-calendar month, excluding CANCELLED / DRAFT (not real
   sales). Registered BEFORE '/:docNo' so 'my-mtd' is never a doc-no param. */
mfgSalesOrders.get('/my-mtd', async (c) => {
  const sb = c.get('supabase');
  /* Self = the caller's REAL scm.staff uuid (mig 0066), NOT user.id — the
     bridge pins user.id to the shared system staff row, so matching on it
     returned the SAME (system-attributed) orders for every caller instead
     of the person's own. No sync row → zero stats, not someone else's. */
  const myStaffId = await resolveCallerStaffId(sb, c.get('houzsUser')?.id);
  if (!myStaffId) return c.json({ mtd_orders: 0, mtd_sales_sen: 0 });
  // Current month in Malaysia time → UTC [start, end) bounds for created_at.
  const ymd = todayMyt();
  const { startUtc, endUtc } = monthBoundsMy(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1);
  // A single salesperson's monthly orders never approach the 1000-row cap.
  // Company-scoped too (owner 2026-08-10 audit): a rep granted to BOTH
  // companies otherwise sees one pooled MTD figure instead of this company's.
  const { data, error } = await scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select('local_total_sen, total_revenue_sen')
      .eq('salesperson_id', myStaffId)
      .not('status', 'in', '("CANCELLED","DRAFT")')
      .gte('created_at', startUtc)
      .lt('created_at', endUtc),
    c,
  ).limit(1000);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = (data ?? []) as Array<{ local_total_sen: number | null; total_revenue_sen: number | null }>;
  const mtd_sales_sen = rows.reduce(
    (sum, r) => sum + Number(r.local_total_sen ?? r.total_revenue_sen ?? 0),
    0,
  );
  return c.json({ mtd_orders: rows.length, mtd_sales_sen });
});

/* POS "My orders" board — the salesperson's OWN Sales Orders, lightweight
   columns for the 3-status board (Order Placed / Proceed / Delivered).
   Filtered by salesperson_id = caller (staff.id === auth.users.id, schema.ts
   line 162; the POS handover writes the placing salesperson's id into
   salesperson_id) so a POS tablet sees only its own orders WITHOUT relying on
   an RLS SELECT policy. Excludes CANCELLED / ON_HOLD (mirrors the legacy
   board's cancelled exclusion). Registered BEFORE '/:docNo' so 'mine' is never
   captured as a doc-no param. */
mfgSalesOrders.get('/mine', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  /* Read the BASE table (NOT the mfg_sales_orders_with_payment_totals view): a
     Postgres view fixes its column list at creation, so any column newer than
     the last recreation is missing and selecting one 500s at runtime. Paid is
     summed from the payments ledger separately below. */
  /* Board filters (POS My-orders toolbar):
       ?q=   free-text → searches doc_no / debtor_name / phone across ALL dates
             (the period is intentionally ignored — search is a global lookup).
       ?from=&to=  YYYY-MM-DD (MY-local, `to` inclusive) → filter created_at
             (order-placed date) to that period. Only applied when there's no q.
     The default (no params) returns everything; the POS always passes the
     current-month window, so the board mirrors the KPI cards. */
  const q = (c.req.query('q') ?? '').trim();
  const fromYmd = c.req.query('from') ?? null;
  const toYmd = c.req.query('to') ?? null;
  const LIMIT = 300;

  /* ?salesperson=<id|all> — only view-all roles (super_admin / sales_director /
     outlet_manager) may view OTHER salespeople. We verify the caller's role with a service-role
     lookup; if they qualify we run the whole board on the service-role client
     (so RLS can't clip another salesperson's rows/items/payments). Everyone
     else: the param is ignored and they stay self-scoped on their own client. */
  const wantSalesperson = c.req.query('salesperson') ?? null;
  /* Self = the caller's REAL scm.staff uuid (mig 0066) — never user.id, the
     bridge's pinned system row shared by every caller (see /my-mtd note). The
     old `?? user.id` handed an unresolved caller every order ever mis-stamped
     with that pin, i.e. other people's orders on a board called "mine". */
  let targetSalespersonId: string | null = await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id);
  /* `null` below means NO salesperson filter (see the .eq guard), i.e. EVERY
     order — so "unresolved" and "deliberately unscoped" must never be the same
     value. Only a view-all caller asking for ?salesperson=all earns the second. */
  let viewingAll = false;
  if (wantSalesperson) {
    // Same view-all tier as the rest of this file (:772, :1161, :1877):
    // `scm.so.view_all` OR a director position, via canViewAllSales.
    // No client swap here: `sb` IS the service-role client already
    // (getSupabaseService), pointed at db.schema 'scm'. The ported 2990 branch
    // built a raw createClient() for RLS bypass — which defaults to the PUBLIC
    // schema, where mfg_sales_orders has no company_id, so the first caller to
    // ever pass this gate got a 500 instead of a board.
    if (canViewAllSales(c)) {
      viewingAll = wantSalesperson === 'all';
      targetSalespersonId = viewingAll ? null : wantSalesperson;
    }
  }
  /* Unidentified caller, self-scoped → an EMPTY board, matching /my-mtd's zeroes
     directly above. Falling through would drop the filter and show them the
     whole book. */
  if (!targetSalespersonId && !viewingAll) return c.json({ salesOrders: [] });

  let query = scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select(
        'doc_no, debtor_name, phone, email, address1, address2, city, postcode, customer_state, ' +
        'customer_delivery_date, processing_date, status, payment_method, approval_code, note, so_date, created_at, ' +
        'total_revenue_sen, line_count, deposit_sen',
      )
      /* `on_hold` since mig 0324 — the status arm below can no longer see a
         hold, because a held order keeps the status it was on. */
      .eq('on_hold', false)
      .not('status', 'in', '("CANCELLED","ON_HOLD")'), // DRAFT shown on purpose — pairs with /pos/sales-stats; BUG-HISTORY 2026-08-17
    c,
  );
  /* Company scope is NOT optional here (owner 2026-08-10 cross-company audit).
     `sb` is the SERVICE-ROLE client, and the view_all branch above clears
     targetSalespersonId, so without this wrap the query degrades to "every
     non-cancelled SO in the database" — both companies, RLS bypassed, with
     customer PII and total_revenue_sen. */
  if (targetSalespersonId) query = query.eq('salesperson_id', targetSalespersonId);

  if (q) {
    const safe = escapeForOr(q);
    if (safe) {
      query = query.or(
        `doc_no.ilike.%${safe}%,debtor_name.ilike.%${safe}%,phone.ilike.%${safe}%`,
      );
    }
  } else {
    const { startUtc, endUtc } = rangeBoundsMy(fromYmd, toYmd);
    if (startUtc) query = query.gte('created_at', startUtc);
    if (endUtc) query = query.lt('created_at', endUtc);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if ((data?.length ?? 0) >= LIMIT) {
    console.log(`[/mine] ${LIMIT}-row cap hit caller=${user.id} target=${targetSalespersonId ?? 'all'} q=${q ? 'yes' : 'no'} from=${fromYmd ?? '-'} to=${toYmd ?? '-'}`);
  }

  // Cast via `unknown` first — supabase-js types a view select as
  // GenericStringError[] until the schema cache materialises (same pattern as
  // the list route's joined-select casts above).
  const rows = (data ?? []) as unknown as Array<{ doc_no?: string; deposit_sen?: number } & Record<string, unknown>>;

  /* Attach the line items so the drawer can render the cart without a second
     fetch. Group non-cancelled lines by doc_no → each item the board needs:
     { item_code, description, qty, total_sen, variants }. */
  const docNos = rows.map((r) => r.doc_no).filter((x): x is string => !!x);
  /* TBC fill-in (Loo 2026-06-11) — the editor needs the line id (mutation
     target), item_group (which picker set to render) and unit/discount (the
     floor-rule preview), so they ride the same fetch. */
  const itemsByDoc = new Map<string, Array<{ id: string; item_code: string; item_group: string | null; description: string | null; qty: number; unit_price_sen: number; discount_sen: number; total_sen: number; variants: unknown; remark: string | null }>>();
  if (docNos.length > 0) {
    /* chunkIn — `docNos` is this board's whole page (LIMIT 300) and the read had neither batching nor paging, so past the 1000-row cap a later order's drawer rendered empty. */
    const { data: itemRows } = await chunkIn<{ id: string; doc_no: string; item_code: string; item_group: string | null; description: string | null; qty: number; unit_price_sen: number; discount_sen: number; total_sen: number; variants: unknown; remark: string | null }>(docNos, (batch, from, to) => sb
      .from('mfg_sales_order_items')
      .select('id, doc_no, item_code, item_group, description, qty, unit_price_sen, discount_sen, total_sen, variants, remark')
      .in('doc_no', batch).eq('cancelled', false)
      .order('doc_no').order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true }).range(from, to));
    for (const it of itemRows) {
      const arr = itemsByDoc.get(it.doc_no) ?? [];
      arr.push({ id: it.id, item_code: it.item_code, item_group: it.item_group ?? null, description: it.description, qty: it.qty, unit_price_sen: it.unit_price_sen, discount_sen: it.discount_sen, total_sen: it.total_sen, variants: it.variants, remark: it.remark ?? null });
      itemsByDoc.set(it.doc_no, arr);
    }
  }

  /* Live paid = the payments ledger, PLUS the header deposit ONLY for legacy
     SOs whose deposit never reached the ledger. Since P2 (D5, migration 0155)
     the SO create path writes the deposit as an is_deposit ledger row (and
     0155 backfilled history), so adding the header column on top would double
     count — the is_deposit marker tells the two worlds apart. The header
     `paid_sen` is deprecated; not read. One batched ledger query. */
  const paidLedgerByDoc = new Map<string, number>();
  const depositInLedger = new Set<string>();
  if (docNos.length > 0) {
    const { data: payRows } = await chunkIn<{ so_doc_no: string; amount_sen: number; is_deposit?: boolean | null }>(docNos, (batch, from, to) => sb
      .from('mfg_sales_order_payments')
      .select('so_doc_no, amount_sen, is_deposit')
      .in('so_doc_no', batch).order('so_doc_no').range(from, to));
    for (const p of payRows) {
      paidLedgerByDoc.set(p.so_doc_no, (paidLedgerByDoc.get(p.so_doc_no) ?? 0) + (p.amount_sen ?? 0));
      if (p.is_deposit) depositInLedger.add(p.so_doc_no);
    }
  }

  const salesOrders = rows.map((r) => {
    const docNo = r.doc_no ?? '';
    const deposit = typeof r.deposit_sen === 'number' ? r.deposit_sen : 0;
    const ledger = paidLedgerByDoc.get(docNo) ?? 0;
    const soItems = itemsByDoc.get(docNo) ?? [];
    return {
      ...r,
      // Total received = ledger payments (+ header deposit only when the
      // ledger doesn't already carry it as an is_deposit row).
      paid_sen_total: (depositInLedger.has(docNo) ? 0 : deposit) + ledger,
      items: soItems,
    };
  });

  return c.json({ salesOrders });
});

/* P1 (Owner 2026-06-03, migration 0143) — serve an SO's payment slip so the
   Backend SO detail page can display the proof. (Mirrored the legacy
   /orders/:id/slip-url route, removed 2026-06-12.) Auth is router-level (same
   as the SO detail GET); RLS governs which SOs the caller can read.

   2026-07-04 — converted from returning a presigned S3 GET URL (JSON {url})
   to STREAMING the object through the SLIPS binding, part of killing the
   never-provisioned R2 S3 creds (see routes/slips.ts header). The frontend
   (vendor/scm/lib/slip.ts fetchSoSlipUrl / fetchPaymentSlipUrl) blob-fetches
   this and hands consumers an object URL, keeping their {url, contentType}
   contract intact. */
function mimeFromKey(key: string): SlipMime {
  const ext = key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    default: throw new Error(`unknown slip extension: ${key}`);
  }
}

mfgSalesOrders.get('/:docNo/slip-url', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  /* This route does not return a row, it streams the R2 OBJECT the row points
     at — so an unscoped lookup hands over the other company's payment slip
     itself, not a field of it. */
  const { data: row, error } = await scopeToCompany(sb
    .from('mfg_sales_orders')
    .select('slip_key')
    .eq('doc_no', docNo), c)
    .maybeSingle();
  if (error) return c.json({ error: 'db_fetch_failed', detail: error.message }, 500);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const slipKey = (row as { slip_key?: string | null }).slip_key ?? null;
  if (!slipKey) return c.json({ error: 'no_slip_attached' }, 400);

  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }
  const obj = await bindings.bucket.get(slipKey);
  if (!obj) return c.json({ error: 'file_not_in_r2' }, 404);
  return new Response(obj.body as unknown as BodyInit, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? mimeFromKey(slipKey),
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=300',
    },
  });
});

/* Cross-category delivery link (migration 0141) — shared eligibility check used
   by BOTH the live handover preview (GET /cross-category-eligibility) and the
   order POST, so the fee shown equals the fee charged. A non-empty SO number is
   eligible only when it exists, isn't cancelled, belongs to the same customer
   (by normalized phone, when both have one), and hasn't already backed another
   follow-up (the unique index is the hard backstop). */
type CrossCatEligibility = {
  eligible: boolean;
  reason?: 'not_found' | 'cancelled' | 'different_customer' | 'already_used' | 'lookup_failed';
  debtorName?: string | null;
};

async function checkCrossCategorySource(
  c: any,
  sb: any,
  docNo: string,
  newPhoneRaw: string | null,
  newCustomerId: string | null = null,
): Promise<CrossCatEligibility> {
  /* Both reads below are keyed on a caller-supplied doc_no. Unscoped, the
     eligibility probe answered for the OTHER company's order and handed back
     its debtor_name — a customer identity, from a GET that needs only a doc
     number. `c` is threaded in for exactly this. */
  const { data: srcRow, error: srcErr } = await scopeToCompany(sb
    .from('mfg_sales_orders')
    .select('doc_no, status, phone, debtor_name, customer_id')
    .eq('doc_no', docNo), c)
    .maybeSingle();
  /* Loo 2026-06-06 (SO-2606-025 incident) — a FAILED query is not a missing
     order. This used to swallow the error and report "Order was not found"
     for a real SO when the CF Workers free-plan subrequest cap killed this
     exact fetch (#51 of 50). Surface it as retryable instead. */
  if (srcErr) {
    console.error('[mfg-so] cross-category source lookup failed:', srcErr.message ?? srcErr);
    return { eligible: false, reason: 'lookup_failed' };
  }
  const src = srcRow as { doc_no: string; status: string; phone: string | null; debtor_name: string | null; customer_id: string | null } | null;
  if (!src) return { eligible: false, reason: 'not_found' };
  if (src.status === 'CANCELLED') return { eligible: false, reason: 'cancelled' };
  /* "Same customer" — prefer the real customer_id link (exact) now that every
     new SO resolves one (migration 0144). Fall back to normalised phone only
     when the SOURCE is a legacy row with no customer_id; the NEW order always
     carries both a compulsory phone and a resolved customer_id. */
  if (src.customer_id && newCustomerId) {
    if (src.customer_id !== newCustomerId) return { eligible: false, reason: 'different_customer' };
  } else {
    const newPhone = newPhoneRaw ? (normalizePhone(newPhoneRaw) ?? newPhoneRaw) : null;
    const srcPhone = src.phone ? (normalizePhone(src.phone) ?? src.phone) : null;
    if (newPhone && srcPhone && newPhone !== srcPhone) return { eligible: false, reason: 'different_customer' };
  }
  const { count, error: countErr } = await scopeToCompany(sb
    .from('mfg_sales_orders')
    .select('doc_no', { count: 'exact', head: true })
    .eq('cross_category_source_doc_no', docNo), c);
  // Same honesty rule as above — a failed count must not silently pass the
  // already-used gate (fail-open) nor masquerade as another reason.
  if (countErr) {
    console.error('[mfg-so] cross-category already-used count failed:', countErr.message ?? countErr);
    return { eligible: false, reason: 'lookup_failed' };
  }
  if ((count ?? 0) > 0) return { eligible: false, reason: 'already_used' };
  return { eligible: true, debtorName: src.debtor_name ?? null };
}

const crossCatReasonText = (docNo: string, reason?: string): string =>
  reason === 'not_found'         ? `Order ${docNo} was not found.`
  : reason === 'cancelled'         ? `Order ${docNo} is cancelled.`
  : reason === 'different_customer'? `Order ${docNo} belongs to a different customer.`
  : reason === 'already_used'      ? `Order ${docNo} was already used for a cross-category discount.`
  : reason === 'lookup_failed'     ? `Could not verify order ${docNo} — please try again.`
  :                                  `Order ${docNo} is not a valid linked order.`;

// GET /cross-category-eligibility?docNo&phone — live check for the handover
// preview so the cross-category delivery discount only applies for a real,
// eligible SO (sales can no longer "type anything" and get the reduced rate).
// Static path is registered before /:docNo so it isn't captured as a docNo.
mfgSalesOrders.get('/cross-category-eligibility', async (c) => {
  const sb = c.get('supabase');
  const docNo = (c.req.query('docNo') ?? '').trim();
  const phone = (c.req.query('phone') ?? '').trim();
  if (!docNo) return c.json({ eligible: false });
  const result = await checkCrossCategorySource(c, sb, docNo, phone || null);
  return c.json({
    eligible:  result.eligible,
    debtorName: result.debtorName ?? null,
    message:   result.eligible ? null : crossCatReasonText(docNo, result.reason),
  });
});

// GET /cross-category-match?name&phone — the Confirm-screen "Auto-match" button.
// Scans THIS customer's earlier sales orders and returns the most recent one
// that can still back a cross-category follow-up, so sales don't have to recall
// the SO number. "Same customer" = the (name, phone) identity key (migration
// 0144) — a shared phone with a different name is a different customer. The SO
// must not be cancelled and must not already be linked-from by another order
// (single-use; the unique index on cross_category_source_doc_no is the hard
// gate, this just keeps the button from offering a burnt SO). Read-only: it
// never mints a customer row (unlike the order POST). Registered before /:docNo
// so the static path isn't captured as a docNo.
mfgSalesOrders.get('/cross-category-match', async (c) => {
  const sb = c.get('supabase');
  const name = (c.req.query('name') ?? '').trim();
  const phoneRaw = (c.req.query('phone') ?? '').trim();
  const normPhone = phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null;
  // Both halves of the identity key are required to find a customer's orders.
  if (!name || !normPhone) return c.json({ found: false });

  // Candidate earlier SOs for this phone, newest first. Name is matched in the
  // pure helper with the same lower(trim) rule as the customers unique index.
  const { data: rows } = await scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select('doc_no, debtor_name, created_at')
      .eq('phone', normPhone)
      .not('status', 'in', '("CANCELLED","DRAFT")'),
    c,
  )
    .order('created_at', { ascending: false })
    .limit(50);
  const candidates: AutoMatchCandidate[] = ((rows ?? []) as Array<{ doc_no: string; debtor_name: string | null }>)
    .map((r) => ({ docNo: r.doc_no, debtorName: r.debtor_name }));
  if (candidates.length === 0) return c.json({ found: false });

  // Which of those candidate SOs are already linked-from by another order.
  const { data: usedRows } = await scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select('cross_category_source_doc_no')
      .in('cross_category_source_doc_no', candidates.map((c2) => c2.docNo)),
    c,
  );
  const used = ((usedRows ?? []) as Array<{ cross_category_source_doc_no: string | null }>)
    .map((r) => r.cross_category_source_doc_no)
    .filter((v): v is string => !!v);

  const match = pickCrossCategoryMatch(candidates, name, used);
  return match
    ? c.json({ found: true, docNo: match.docNo, debtorName: match.debtorName })
    : c.json({ found: false });
});

/* GET /customer-search?name= — POS customer-name autocomplete (Loo
   2026-06-06: "when key in customer name, search the customer list, give
   option for same name"). Searches past SO headers by name (ilike) and
   dedupes to ONE entry per (lower-trim name, phone) identity — the same key
   as migration 0144's customers unique index — keeping the NEWEST order's
   contact + address snapshot for the autofill. Header-based (not the
   customers registry) so it covers ALL order history today; the registry
   only has rows minted since 0144 went live (backfill = Phase 2). Phone is
   returned in full — this is a staff-only surface behind auth, and the
   phone is exactly how sales tell two same-name customers apart.
   Read-only: never mints a customer row. Registered before /:docNo so the
   static path isn't captured as a docNo. */
mfgSalesOrders.get('/customer-search', async (c) => {
  const sb = c.get('supabase');
  const q = (c.req.query('name') ?? '').trim();
  if (q.length < 2) return c.json({ customers: [] });
  // Escape LIKE metacharacters so a literal "%" in a name can't widen the scan.
  const esc = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { data, error } = await scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select('doc_no, debtor_name, phone, email, customer_type, address1, address2, city, postcode, customer_state, building_type, emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, customer_id, customer_race, customer_birthday, customer_gender, created_at')
      .ilike('debtor_name', `%${esc}%`)
      .not('status', 'in', '("CANCELLED","DRAFT")'),
    c,
  )
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  type Row = {
    doc_no: string; debtor_name: string | null; phone: string | null;
    email: string | null; customer_type: string | null;
    address1: string | null; address2: string | null; city: string | null;
    postcode: string | null; customer_state: string | null;
    building_type: string | null;
    emergency_contact_name: string | null; emergency_contact_phone: string | null;
    emergency_contact_relationship: string | null;
    customer_id: string | null;
    customer_race: string | null; customer_birthday: string | null; customer_gender: string | null;
    created_at: string;
  };
  /* Per-identity COALESCE (Loo 2026-06-06 follow-up: "link them with address
     as well") — the newest order wins per FIELD, not per row. A customer whose
     latest SO was "fill in address later" still autofills from their previous
     order's address: rows arrive newest-first, the first occurrence seeds the
     entry, and older same-identity rows only patch fields that are still
     empty. lastDocNo/lastOrderAt always stay the newest order's. */
  const byKey = new Map<string, Record<string, unknown>>();
  const FILL_FIELDS = [
    ['email', 'email'], ['customerType', 'customer_type'],
    ['address1', 'address1'], ['address2', 'address2'], ['city', 'city'],
    ['postcode', 'postcode'], ['customerState', 'customer_state'],
    ['buildingType', 'building_type'],
    // Cutover #14 read-side: coalesce the SO-captured marketing demographics so
    // picking a returning customer prefills race/birthday/gender (all required
    // for a new customer) from their newest order that carries each.
    ['race', 'customer_race'], ['birthday', 'customer_birthday'], ['gender', 'customer_gender'],
  ] as const;
  /* Emergency contact coalesces as a GROUP, not per field (Loo 2026-06-12:
     copy it over like the address) — name/phone/relationship describe ONE
     person, so mixing the name from one order with the phone of another
     would invent a contact that doesn't exist. The newest order carrying
     any of the three wins all three. */
  const hasEmergency = (e: Record<string, unknown>): boolean =>
    Boolean(e.emergencyContactName || e.emergencyContactPhone || e.emergencyContactRelationship);
  const emergencyOf = (r: Row) => ({
    emergencyContactName:         r.emergency_contact_name,
    emergencyContactPhone:        r.emergency_contact_phone,
    emergencyContactRelationship: r.emergency_contact_relationship,
  });
  for (const r of (data ?? []) as Row[]) {
    const name = (r.debtor_name ?? '').trim();
    if (!name) continue;
    const key = `${name.toLowerCase()}|${(r.phone ?? '').trim()}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const [out, col] of FILL_FIELDS) {
        if (existing[out] == null || existing[out] === '') existing[out] = r[col];
      }
      if (!hasEmergency(existing) && hasEmergency(emergencyOf(r))) {
        Object.assign(existing, emergencyOf(r));
      }
      continue;
    }
    byKey.set(key, {
      debtorName:    name,
      phone:         r.phone,
      email:         r.email,
      customerType:  r.customer_type,
      address1:      r.address1,
      address2:      r.address2,
      city:          r.city,
      postcode:      r.postcode,
      customerState: r.customer_state,
      buildingType:  r.building_type,
      customerId:    r.customer_id,
      race:          r.customer_race,
      birthday:      r.customer_birthday,
      gender:        r.customer_gender,
      ...emergencyOf(r),
      lastDocNo:     r.doc_no,
      lastOrderAt:   r.created_at,
    });
  }
  return c.json({ customers: [...byKey.values()].slice(0, 8) });
});

// Houzs — resolve the venue the logged-in salesperson is BOUND to on a given
// date, so the New-SO / OCR form (desktop AND mobile) can pre-select it in the
// Venue dropdown. MUST be registered BEFORE "/:docNo" (single-segment static
// path, else Hono treats "active-venue" as a docNo).
//
// The rule itself lives in lib/venue-binding.ts and is shared with the SO create
// path — this endpoint only fetches, calls it, and maps the venue NAME onto the
// project_venues master id the dropdown compares against. The route name is
// kept as "active-venue" (rather than renamed to match the resolver) because the
// desktop form, the mobile form and the vendored SCM client all call this exact
// path; the concept it returns is now "the rep's bound venue", of which the
// active exhibition is one of two sources.
//
// ZERO PMS DATA IS THE NORMAL CASE: showroom parking is the primary binding, and
// a rep on no projects at all must still get their showroom's venue back here.
// Nothing on this path warns, errors or degrades because no project has a team.
//
// venueId is null when the resolved venue text isn't in the project_venues
// master — a KNOWN and tolerated gap (projects reference ~60 distinct venues,
// the master holds ~38). The form stamps the text anyway and hints that it is
// unmastered; it does NOT reject the order. Rejecting unmastered venues would
// block real sales to enforce a list nobody has finished filling in.
mfgSalesOrders.get('/active-venue', async (c) => {
  const hu = c.get('houzsUser');
  const uid = hu?.id != null ? Number(hu.id) : NaN;
  const dateRaw = c.req.query('date');
  /* The ORDER's date when the form supplies one (a backdated slip must resolve
     against the fair that was running the day it was written), else today in
     MYT — never the UTC date, which is yesterday until 08:00 local. */
  const soDate =
    typeof dateRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateRaw)
      ? dateRaw.slice(0, 10)
      : todayMyt();
  const EMPTY = {
    venueId: null, venueName: null, projectName: null,
    source: null, projectId: null, showroomName: null,
  };
  if (!Number.isFinite(uid)) return c.json(EMPTY);
  try {
    const sb = c.get('supabase');
    const staffId = await resolveCallerStaffId(sb, uid);
    const { pmsCandidates, showroom } = await loadVenueBindingInputs({
      db: c.env.DB, sb: sb as unknown as VenueBindingSb, userId: uid, staffId,
    });
    const binding = resolveVenueBinding({ soDate, pmsCandidates, showroom });
    if (!binding.venueName) return c.json(EMPTY);

    /* Map the resolved venue TEXT onto the project_venues master id, so the
       dropdown can SELECT the row rather than only display the text. Lives here
       and not in the resolver because it is a presentation concern — the venue
       that gets stamped is the text either way. */
    let venueId: string | null = null;
    try {
      /* Company-scoped (mig 0093): venue NAMES are not unique across the two
         masters, so an unscoped match hands this company the OTHER company's
         venue id — and that id is what the SO stores. See projects-pms.md. */
      const row = await c.env.DB.prepare(
        `SELECT id FROM project_venues
          WHERE lower(trim(name)) = lower(trim(?)) AND active = 1${activeCompanySql(c)} LIMIT 1`,
      )
        .bind(binding.venueName)
        .first<{ id?: number | null }>();
      venueId = row?.id != null ? String(row.id) : null;
    } catch {
      venueId = null; // unmastered venue — the text still stands
    }
    return c.json({
      venueId,
      venueName: binding.venueName,
      projectName: binding.projectName,
      projectId: binding.projectId,
      source: binding.source,
      showroomName: showroom && binding.source === 'SHOWROOM' ? showroom.warehouseName : null,
    });
  } catch {
    return c.json(EMPTY);
  }
});

mfgSalesOrders.get('/:docNo', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const [h, i] = await Promise.all([
    /* amend_date_from_customer / amended_delivery_date / amend_reason (mig 0053)
       are appended here rather than in the shared HEADER: the payment-totals
       view's frozen column set (see VIEW-TRAP above) does not carry them and the
       LIST route reads that view, so the base-table detail read is the only
       place they are valid. (`proceeded_at` was appended here until 2026-08-18,
       feeding a "Proceed Date" the desktop deleted on 2026-06-05.) */
    scopeToCompany(sb.from('mfg_sales_orders').select(`${HEADER}, amend_date_from_customer, amended_delivery_date, amend_reason, revision, signature_b64, slip_key, slip_state, slip_image_key, receipt_image_key, version`).eq('doc_no', docNo), c).maybeSingle(),
    /* line_no = the persisted listing order (0165); NULLS LAST so pre-0165
       docs fall back to created_at + the rule re-derive below. */
    sb.from('mfg_sales_order_items').select(ITEM).eq('doc_no', docNo)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* TEMPORARY (Loo 2026-06-10, Backend SO emergency hatch) — self-scoped
     selling roles may open only their OWN SO; another salesperson's doc_no
     answers 404 (not 403) so it's indistinguishable from a nonexistent one.
     POS reads its own orders through /mine, and the salesperson's own POS
     print/detail fetches carry salesperson_id = caller, so those still pass.
     Remove with the hatch (see lib/roles.ts isSelfScopedSales). */
  {
    // Same tiering as the list (lib/salesScope.ts): view-all roles pass; POS
    // sellers pass only their own; other reps are held to their subtree. An
    // out-of-scope doc_no answers 404 — indistinguishable from a missing one.
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  /* Tier 2 downstream-lock — stamp has_children so the SO Detail page can lock
     once any non-cancelled DO / SI references it. */
  const [{ count: doCount }, { count: siCount }] = await Promise.all([
    sb.from('delivery_orders')
      .select('id', { head: true, count: 'exact' })
      .eq('so_doc_no', docNo)
      .neq('status', 'CANCELLED'),
    sb.from('sales_invoices')
      .select('id', { head: true, count: 'exact' })
      .eq('so_doc_no', docNo)
      .neq('status', 'CANCELLED'),
  ]);
  /* Edge #D — surface the customer's current credit balance on the SO Detail
     response so the page can show "Customer has RM X available" without a
     second round-trip. 0 when no debtor / no credit history. */
  const debtorCode = (h.data as { debtor_code?: string | null }).debtor_code ?? null;
  const customerCreditSen = debtorCode ? await getCustomerCreditBalance(sb, debtorCode, activeCompanyId(c) ?? null) : 0;
  /* Live paid rollup — same rule as the LIST route (lines ~678): sum the
     payments ledger, and add the header deposit ONLY for legacy SOs whose
     deposit never reached the ledger (is_deposit marker distinguishes them).
     Without this the single-SO response carried only the deprecated
     `paid_sen` (0 for a balance payment recorded via the drawer), so the
     customer-facing print showed "Deposit paid 0.00" + a wrong balance even
     though money had been collected (Loo 2026-06-09). */
  let paidLedgerSen = 0;
  let depositInLedger = false;
  {
    const { data: payRows } = await sb
      .from('mfg_sales_order_payments')
      .select('amount_sen, is_deposit')
      .eq('so_doc_no', docNo);
    for (const p of (payRows ?? []) as Array<{ amount_sen: number; is_deposit?: boolean | null }>) {
      paidLedgerSen += p.amount_sen ?? 0;
      if (p.is_deposit) depositInLedger = true;
    }
  }
  /* ONE rule, shared with the AutoCount write-back's BALANCE UDF so the account
     book and this page cannot disagree. Why not `balance_sen`: so-outstanding.ts. */
  const paidInputs = soPaidInputsOf(h.data as Record<string, unknown>, paidLedgerSen, depositInLedger);
  const paidSenTotal = soPaidSen(paidInputs);
  /* SO amendment gate (port of 2990 110a472 — flags only, no 409 change).
     `amendment_eligible` tells the frontend that direct edits here must instead
     go through the amendment request flow: the SO IS processing-locked (already
     PO'd to the supplier) but is NOT yet hard-locked by a DO/SI and hasn't
     reached a terminal status. When true the FE swaps its Save button to
     "Submit amendment request". `open_amendment` is the light summary of any
     in-flight amendment (status NOT IN SENT/REJECTED) for the pending banner.
     Reuses the SAME soProcessingLocked helper the edit endpoints use + the
     doCount/siCount already computed above for the hard-lock signal. */
  const amendDateLocked = soProcessingLocked(
    h.data as { processing_date?: string | null; status: string | null },
  );
  /* Owner 2026-08-12 — the PO lock feeds the SAME flag, so a 2990 SO with a live
     PO flips the FE's Save into "Submit amendment request" exactly as an elapsed
     processing date does. Shipped as its own header field (`po_locked`) too: the
     desktop + mobile detail gates need to disable the line editors, and they are
     PURE header functions (so-detail-gates.ts) that cannot run this query
     themselves — deriving it client-side is what let the two surfaces drift
     before. Skipped entirely when the date lock already answered true: the
     result is identical and this is a per-request round trip on the hottest SO
     read in the app. */
  const amendPoLocked = amendDateLocked ? false : await soPoLocked(sb, docNo);
  const amendProcessingLocked = amendDateLocked || amendPoLocked;
  const amendHardLocked = (doCount ?? 0) > 0 || (siCount ?? 0) > 0;
  const amendSoStatus = String((h.data as { status?: string | null }).status ?? '').toUpperCase();
  const amendTerminalStatus = ['SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED'].includes(amendSoStatus);
  const amendmentEligible = amendProcessingLocked && !amendHardLocked && !amendTerminalStatus;
  /* Two-lane rework: up to TWO amendments can be awaiting approval at once —
     one per lane. `open_amendments` is the full set; the singular
     `open_amendment` (first/newest) is kept so pre-rework consumers keep
     working. OPEN for a lane row = REQUESTED (SO_APPROVED is its applied
     terminal); a legacy row stays open through its whole two-gate chain. */
  type OpenAmendment = { id: string; status: string; amendment_no: string; lane: string | null };
  let openAmendments: OpenAmendment[] = [];
  {
    // scopeToCompany: the new so_amendments table carries company_id (mig 0080);
    // no-op pre-activation. so_doc_no is already company-unique, so this is belt+braces.
    /* Server-side openness filter — applied (SO_APPROVED) lane rows accumulate
       over an SO's life, so a bare newest-N read could push the one genuinely
       OPEN row past the limit. (lane IS NULL OR status = REQUESTED) AND status
       NOT IN (SENT, REJECTED) returns at most 2 lane rows + any legacy chain. */
    const { data: amRows } = await scopeToCompany(sb
      .from('so_amendments')
      .select('id, status, amendment_no, lane')
      .eq('so_doc_no', docNo), c)
      .not('status', 'in', '("SENT","REJECTED")')
      .or('lane.is.null,status.eq.REQUESTED')
      .order('created_at', { ascending: false })
      .limit(4);
    openAmendments = ((amRows ?? []) as Array<Record<string, unknown>>)
      .map((am) => ({
        // Postgres.js/PostgREST may surface columns camelCased; dual-read to be safe.
        id: String(am.id ?? ''),
        status: String(am.status ?? ''),
        amendment_no: String((am.amendment_no ?? (am as Record<string, unknown>).amendmentNo) ?? ''),
        lane: am.lane == null ? null : String(am.lane),
      }));
  }
  const openAmendment = openAmendments[0] ?? null;
  const salesOrder = {
    ...(h.data as unknown as Record<string, unknown>),
    has_children: (doCount ?? 0) > 0 || (siCount ?? 0) > 0,
    // Amendment flags (read-only; the FE routes on these).
    amendment_eligible: amendmentEligible,
    /* The PO half of the soft lock, as its own fact — so-detail-gates.procLockActive
       ORs it with its date test (owner 2026-08-12). NOT folded into
       amendment_eligible: that flag is already false for a hard-locked / terminal
       SO, and the editors must stay disabled in exactly those cases. */
    po_locked: amendPoLocked,
    has_open_amendment: openAmendment != null,
    open_amendment: openAmendment,
    open_amendments: openAmendments,
    customer_credit_sen: customerCreditSen,
    // Authoritative received-to-date + remaining balance for the detail page
    // and the customer-facing print (so-doc.ts reads paid_sen_total).
    paid_sen_total: paidSenTotal,
    /* SIGNED (owner 2026-08-16) — negative = over-collected, painted red by the
       detail page, the mobile detail and the SO print. The write-back keeps the
       CLAMPED `soOutstandingSen`: a screen can say "you hold RM 250 of his
       money", AutoCount's UDF_BALANCE cannot. Same inputs, two audiences. */
    balance_sen: soBalanceSen(paidInputs),
  };
  /* Owner batch 2026-07 — resolve the salesperson's display name + contact
     phone (scm.staff) so the SO PDF's ORDER DETAILS can print "Salesperson:
     name · phone" without a second round-trip. Best-effort: a failed lookup
     (or a null salesperson_id) leaves both null and the PDF row is skipped. */
  {
    const spId = (h.data as { salesperson_id?: string | null }).salesperson_id ?? null;
    let spName: string | null = null;
    let spPhone: string | null = null;
    if (spId) {
      try {
        const { data: sp } = await sb
          .from('staff')
          .select('name, phone')
          .eq('id', spId)
          .maybeSingle();
        const row = sp as { name?: string | null; phone?: string | null } | null;
        spName = (row?.name ?? '').trim() || null;
        spPhone = (row?.phone ?? '').trim() || null;
      } catch { /* best-effort — PDF falls back to omitting the row */ }
    }
    (salesOrder as Record<string, unknown>).salesperson_name = spName;
    (salesOrder as Record<string, unknown>).salesperson_phone = spPhone;
  }
  /* Per-line delivery breakdown so the SO views can show a "Delivered" column
     (which DO took how much, and the live balance) without a second round-trip.
     remaining/delivered come from the authoritative soDeliverableRemaining
     engine; the DO-number breakdown rides alongside from soLineDeliveries. */
  /* Rule-order the rows at READ (Loo 2026-06-12). The bulk insert gives every
     line of an SO the same created_at, so the persisted order is NOT
     recoverable from the timestamp once routine updates (stock_status flips,
     recomputeTotals' combo spread) physically relocate rows. Rank
     (mains → accessories → services) + each build's left-to-right walk are
     re-derived from the rows themselves; within-rank residual order keeps the
     read-back order (usually the cart order). */
  const itemRows = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      (i.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; item_code: string; qty?: number | null }>,
      (r) => r.item_group as string | null | undefined,
    ),
  );
  /* Display branding for the detail view — derive the SAME `first_item_branding`
     the SO LIST shows (single source of truth: deriveDisplayBrandingByDoc, the
     helper the Fair/Sales Report detail already uses). The header `branding`
     column is NULL on essentially every SO, so the detail's brandOf() —
     `branding || first_item_branding || "—"` — fell through to a dash whenever
     the endpoint left first_item_branding unset. This USED to be a partial
     bedframe-only rule (Commander 2026-07-16) that only stamped "BEDFRAME" for
     bedframe-only SOs; a SOFA / branded-MATTRESS / accessories SO got nothing,
     so the detail read "—" while the list showed e.g. "2990S SOFA". The helper
     covers mains-first + mattress-brand fallback + bedframe-only in one place,
     so both surfaces resolve the identical value. */
  {
    /* 2026-08-18: emit the CATEGORY too. The detail page used to render
       `branding || first_item_branding || "—"` — its own rule, not the list's —
       so it printed a dash for any order whose rep line carries no brand text,
       which is every sofa. It now calls the shared brandingLabel, and that needs
       both inputs. */
    const derived = await deriveDisplayBrandingRowByDoc(sb, c, [docNo]);
    const row = derived.get(docNo);
    if (row) {
      (salesOrder as Record<string, unknown>).first_item_category = row.category;
      if (row.branding) (salesOrder as Record<string, unknown>).first_item_branding = row.branding;
    }
  }
  /* Brand letterhead resolution (owner 2026-07; company-scoped 2026-08-21) —
     stamp the R2 key of the brand logo the SO PDF should print IN PLACE OF the
     company logo (the company letterhead stays the fallback when this is
     null). Brands + their logos live in public.project_brands (Project
     Maintenance → Brands; logo_r2_key, migration-pg 0069), read via c.env.DB —
     same public-schema hop as the venue lookup above.

     COMPANY-SCOPED, and that is the whole point of the 2026-08-21 change: this
     read had NO company predicate and the sofa rule hardcoded the name
     'ZANOTTI', so a "2990 HOME SDN. BHD." Sales Order printed HOUZS's mark
     (doc 2990-SO-2607-026; 69 orders in that state). `activeCompanySql`
     degrades to no predicate only on a genuinely unresolved / single-company
     context, and the rule itself refuses to attribute a house brand it cannot
     identify — see lib/brand-letterhead.ts, which carries the rule and its
     tests, and shared/so-branding-label.ts, which is where the owner's
     equations live for BOTH this and the grid label.

     Best-effort: any failure stamps null and the PDF keeps the company
     letterhead — a PDF must never fail because of a logo. */
  {
    let brandLogoKey: string | null = null;
    try {
      const brandRows = await c.env.DB.prepare(
        `SELECT name, logo_r2_key FROM project_brands WHERE active = 1${activeCompanySql(c)}`
      ).all<{ name: string; logo_r2_key: string | null }>();
      brandLogoKey = resolveBrandLetterheadKey({
        brands: (brandRows.results ?? []) as Array<Record<string, unknown>>,
        itemGroups: itemRows.map((it) => (it as { item_group?: string | null }).item_group ?? null),
        firstDescription: ((itemRows[0] ?? {}) as { description?: string | null }).description ?? null,
        companyCode: c.get('companyCode') ?? null,
      });
    } catch { brandLogoKey = null; }
    (salesOrder as Record<string, unknown>).resolvedBrandLogoKey = brandLogoKey;
  }
  /* PERF (2026-09-01, docs/bugs/…) — the live Stock column used to run the
     GLOBAL company-wide MRP allocation (`soCoverage` → `computeMrp`, ~105 DB
     round-trips) INLINE here, plus `soLineReadySourcePos`, only to paint the
     per-line badge. On a cold DB connection that made opening any order ~4.7s.
     The list already defers this; the detail now does too. The MRP-derived
     values below fall back to their no-MRP defaults, the STORED `stock_status`
     stands as the verdict, and the client fetches the live coverage from
     `GET /:docNo/coverage` after the doc renders. The computation is UNCHANGED,
     just moved off the critical path — see that endpoint below. */
  const [remainingMap, deliveriesMap, shippedTraceMap] = await Promise.all([
    soDeliverableRemaining(sb, [docNo]),
    soLineDeliveries(sb, itemRows.map((it) => it.id)),
    /* Traceability — the source PO(s) each line's SHIPPED goods came from,
       recovered from the DO OUT movements' batch_no ∪ consumed lots (the ONE
       shared resolver, GRN-healed + adjustment-classified). Cheap batched query,
       NOT MRP — stays inline so the detail keeps showing the source PO even
       after the line is delivered (MRP coverage drops off once satisfied). */
    soLineShippedSources(sb, itemRows.map((it) => it.id)),
  ]);
  const items = itemRows.map((it) => {
    const rem = remainingMap.get(it.id);
    const deliveries = deliveriesMap.get(it.id) ?? [];
    const deliveredQty = deliveries.reduce((s, d) => s + d.qty, 0);
    const shippedTrace = shippedTraceMap.get(it.id);
    const shippedPos = shippedTrace?.pos ?? [];
    /* SERVICE lines carry no inventory and are inherently available, so they
       stay 'stock' with no MRP run needed. Every other line's live coverage is
       UNKNOWN without MRP, so stock_state is null here and the client heals it
       from GET /:docNo/coverage. (Owner Q2, 2026-07-24.) */
    const isSvcLine = isServiceLine({
      itemGroup: (it as { item_group?: string | null }).item_group ?? null,
      itemCode: (it as { item_code?: string | null }).item_code ?? null,
    });
    const stockState = isSvcLine ? 'stock' : null;
    return {
      ...it,
      deliveries,
      delivered_qty: rem?.delivered ?? deliveredQty,
      remaining_qty: rem?.remaining ?? Number(it.qty ?? 0),
      /* Live allocation outcome. Without the inline MRP run it is 'stock' for a
         service line and null (unknown) otherwise; GET /:docNo/coverage fills the
         real value in a beat later. */
      stock_state: stockState,
      /* What the PILL renders, decided here so it and the board agree (§0.4).
         Live state is passed as `null` so the STORED engine verdict stands
         (so-line-effective-stock.ts: null live-state = stored verdict) — the
         coverage endpoint recomputes it with the live state. */
      stock_status_effective: effectiveLineStockStatus(
        (it as { stock_status?: string | null }).stock_status ?? null,
        null,
        {
          orderProcessed: !!(h.data as { processing_date?: string | null }).processing_date,
          lineHardBound: isHardBoundLine(
            (it as { item_group?: string | null }).item_group ?? null,
            (it as { item_code?: string | null }).item_code ?? null,
          ),
        },
      ),
      // coverage_po / coverage_eta are MRP-derived — unknown without the run.
      coverage_po: null,
      coverage_eta: null,
      /* Source PO(s) the delivered goods actually shipped from (from the DO OUT
         batch_no). Populated once the line has shipped; empty for un-batched
         (plain-FIFO) stock. The detail shows these even after full delivery so
         supplier→shipment traceability survives (falls back to coverage_po). */
      shipped_source_pos: shippedPos,
      /* Shipped (at least partly) from a PO-less stock ADJUSTMENT lot (free
         gift / cancel add-back) — the UI renders "STOCK ADJ", never a blank. */
      shipped_source_adj: (shippedTrace?.adjQty ?? 0) > 0,
      // READY trace is MRP-derived — filled by GET /:docNo/coverage.
      ready_source_pos: [],
    };
  });
  const totalDelivered = items.reduce((s, it) => s + Number(it.delivered_qty ?? 0), 0);
  const totalRemaining = items.reduce((s, it) => s + Number(it.remaining_qty ?? 0), 0);
  (salesOrder as Record<string, unknown>).delivery_state =
    totalDelivered <= 0 ? 'none' : totalRemaining > 0 ? 'partial' : 'full';
  (salesOrder as Record<string, unknown>).shipped_qty = totalDelivered;       // §0.4b
  (salesOrder as Record<string, unknown>).deliverable_qty = totalDelivered + totalRemaining;
  /* Status badge driver — same "latest event wins" engine as the list. */
  const [lifecycleByDoc, currentByDoc] = await Promise.all([
    computeSoLifecycle(sb, [docNo]),
    soCurrentDocNo(sb, [docNo]),
  ]);
  (salesOrder as Record<string, unknown>).lifecycle_state = lifecycleByDoc.get(docNo) ?? 'none';
  (salesOrder as Record<string, unknown>).current_doc_no = currentByDoc.get(docNo) ?? (docNo || null);
  /* PWP vouchers THIS order's trigger items issued (Loo 2026-06-05) — the
     customer-facing prints mark the trigger line with the code (used → short
     reference; unused → "issued, not redeemed yet"). pwp_codes always intended
     this ("printed on the SO, redeemable cross-order"); this is the read half.
     Best-effort: a failed lookup never blocks the SO detail. */
  let pwpCodes: Array<Record<string, unknown>> = [];
  try {
    const { data: codeRows } = await sb
      .from('pwp_codes')
      .select('code, status, trigger_item_code, redeemed_doc_no, cart_line_key')
      .eq('source_doc_no', docNo)
      // Deterministic batch order for allocatePwpTriggerNotes — codes earned
      // by the first-added trigger line print on the first matching line.
      .order('created_at', { ascending: true });
    pwpCodes = (codeRows ?? []) as Array<Record<string, unknown>>;
  } catch {
    pwpCodes = [];
  }
  gateSoFinance(c, salesOrder, items);
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ salesOrder, items, pwpCodes });
});

/* GET /:docNo/coverage — the DEFERRED live Stock column — lives in
   mfg-sales-orders-list-enrichment.ts, mounted at this same `/mfg-sales-orders`
   prefix (this file is at its size ceiling). It runs the exact `soCoverage`
   (exported above) + `soLineReadySourcePos` the `/:docNo` detail stopped running
   inline. Final path is still `/api/scm/mfg-sales-orders/:docNo/coverage`. */

/* GET /:docNo/items — cutover P3 (#389): the 2990 POS (apps/pos queries.ts)
   calls this dedicated items endpoint directly. Houzs only served items inside
   the /:docNo detail (alongside salesOrder + pwpCodes); the bare /:docNo/items
   GET 404'd. This mirrors the detail handler's items path EXACTLY — same
   company scope + self-scoped-sales 404, same line_no ordering, same rule
   re-order (sortSoLinesByGroupRank + orderSofaModuleRowsWithinBuilds), and the
   same per-line enrichment (deliveries / delivered_qty / remaining_qty /
   stock_state / coverage_po / coverage_eta / shipped_source_pos) — so the item
   shape is identical to what the detail returns. Returns { items }. */
mfgSalesOrders.get('/:docNo/items', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const [h, i] = await Promise.all([
    // Header read is company-scoped + minimal — we only need it to exist,
    // resolve salesperson_id for the same self-scoped-sales gate the detail
    // uses, and carry processing_date for the promotion gate below.
    scopeToCompany(sb.from('mfg_sales_orders').select('doc_no, salesperson_id, processing_date').eq('doc_no', docNo), c).maybeSingle(),
    // Same ITEM select + line_no ordering as the detail (nulls last → pre-0165
    // fallback to created_at, then the rule re-order below).
    sb.from('mfg_sales_order_items').select(ITEM).eq('doc_no', docNo)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Same tiering as the detail (lib/salesScope.ts): view-all roles pass; POS
     sellers pass only their own; other reps are held to their subtree. An
     out-of-scope doc_no answers 404 — indistinguishable from a missing one. */
  {
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  // Rule-order the rows at READ — identical to the detail (mains → accessories
  // → services, each build walked left-to-right; see the detail's note).
  const itemRows = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      (i.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; item_code: string; qty?: number | null }>,
      (r) => r.item_group as string | null | undefined,
    ),
  );
  // Coverage from the SAME MRP allocation engine the detail + MRP page use.
  // Best-effort: a failed allocation just drops lines to Pending.
  const [remainingMap, deliveriesMap, shippedTraceMap, cov] = await Promise.all([
    soDeliverableRemaining(sb, [docNo]),
    soLineDeliveries(sb, itemRows.map((it) => it.id)),
    soLineShippedSources(sb, itemRows.map((it) => it.id)),
    soCoverage(c, sb),
  ]);
  const coverageMap = cov.coverage;
  const readyPosMap = await soLineReadySourcePos(sb, activeCompanyId(c) ?? null, cov.mrp, itemRows as Array<{ id: string; item_group?: string | null; qty?: number | null; stock_status?: string | null; allocated_batch_no?: string | null }>);
  const items = itemRows.map((it) => {
    const rem = remainingMap.get(it.id);
    const deliveries = deliveriesMap.get(it.id) ?? [];
    const deliveredQty = deliveries.reduce((s, d) => s + d.qty, 0);
    const cov = coverageMap.get(it.id);
    const covered = cov?.source === 'po';
    const shippedTrace = shippedTraceMap.get(it.id);
    const shippedPos = shippedTrace?.pos ?? [];
    // SOFA stock-coverage trusts the batch-aware stock_status; non-sofa trusts
    // the MRP SKU-pool source (identical to the detail's rule).
    const isSofaLine = String((it as { item_group?: string | null }).item_group ?? '').toUpperCase().includes('SOFA');
    /* SERVICE lines (delivery fee / dispose / lift) never enter the MRP
       allocator — they create no purchase demand (mrp.ts skips them), so `cov`
       is always undefined and stock_state would fall through to null, rendering
       a blank Stock cell. A service is inherently available, so surface it as
       READY ('stock') — matching the stored stock_status the SO create path
       already stamps READY-from-birth. (Owner Q2, 2026-07-24.) */
    const isSvcLine = isServiceLine({
      itemGroup: (it as { item_group?: string | null }).item_group ?? null,
      itemCode: (it as { item_code?: string | null }).item_code ?? null,
    });
    const stockState = isSvcLine
      ? 'stock'
      : isSofaLine
      ? (it.stock_status === 'READY' ? 'stock' : (cov?.source === 'po' ? 'po' : 'shortage'))
      : (cov?.source ?? null);
    return {
      ...it,
      deliveries,
      delivered_qty: rem?.delivered ?? deliveredQty,
      remaining_qty: rem?.remaining ?? Number(it.qty ?? 0),
      stock_state: stockState,
      // What the PILL renders, decided here so it and the board agree (§0.4).
      // Gated (2026-08-30): no processing date, or a hard-bound line, and the
      // live-'stock' promotion is off — the stored engine verdict stands.
      stock_status_effective: effectiveLineStockStatus(
        (it as { stock_status?: string | null }).stock_status ?? null,
        stockState as LiveStockState,
        {
          orderProcessed: !!(h.data as { processing_date?: string | null }).processing_date,
          lineHardBound: isHardBoundLine(
            (it as { item_group?: string | null }).item_group ?? null,
            (it as { item_code?: string | null }).item_code ?? null,
          ),
        },
      ),
      coverage_po: covered ? cov?.po ?? null : null,
      coverage_eta: covered ? cov?.eta ?? null : null,
      shipped_source_pos: shippedPos,
      shipped_source_adj: (shippedTrace?.adjQty ?? 0) > 0,
      ready_source_pos: readyPosMap.get(it.id) ?? [],
    };
  });
  gateSoFinance(c, null, items);
  // Same supplier-fabric-code stamp as the /:docNo detail (this endpoint mirrors
  // its items path exactly), so both surfaces read "BF-01 (PC151-01)".
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ items });
});

/* Customer credit balance lookup — used by the New Sales Order form to flash
   "Customer has RM X credit available" once the operator picks the customer.
   Returns 0 (not 404) when there's no history yet. */
mfgSalesOrders.get('/customer-credit/:debtorCode', async (c) => {
  const sb = c.get('supabase');
  const debtorCode = c.req.param('debtorCode');
  const balance = await getCustomerCreditBalance(sb, debtorCode, activeCompanyId(c) ?? null);
  return c.json({ debtorCode, balanceSen: balance });
});

/* Loo 2026-06-05 — 409 gate for the maintained SO dropdown header fields.
   customer_type / building_type / emergency_contact_relationship must hold a
   value from the ACTIVE so_dropdown_options rows: these columns freeze under
   the SO identity lock once a DO/SI exists, so a dirty value would be locked
   in forever. Null / empty passes (the fields are optional); matching is exact
   (the POS / Backend selects submit the maintained `value` verbatim).
   Fail-open when the lookup itself returns nothing — a maintenance-table
   hiccup must never block a paying customer at the counter. */
const SO_DROPDOWN_FIELDS: Array<{ bodyKey: string; category: string }> = [
  { bodyKey: 'customerType',                 category: 'customer_type' },
  { bodyKey: 'buildingType',                 category: 'building_type' },
  { bodyKey: 'emergencyContactRelationship', category: 'relationship' },
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same loose sb
// typing the other loaders in this file use.
async function validateSoDropdownFields(
  sb: any,
  body: Record<string, unknown>,
  /* Multi-company (mig 0089): validate against the ACTIVE company's vocabulary
     only. Callers pass activeCompanyId(c) / c.get('companyId'); null/undefined
     (unresolved) keeps the read global — companyScope's no-op rule. */
  companyId?: number | null,
): Promise<{ error: string; reason: string; offenders: Array<{ field: string; value: string }> } | null> {
  const present = SO_DROPDOWN_FIELDS
    .map(({ bodyKey, category }) => ({ bodyKey, category, value: body[bodyKey] }))
    .filter((f): f is { bodyKey: string; category: string; value: string } =>
      typeof f.value === 'string' && f.value.trim().length > 0);
  if (present.length === 0) return null;
  let vocabQ = sb
    .from('so_dropdown_options')
    .select('category, value')
    .eq('active', true)
    .in('category', present.map((f) => f.category));
  if (companyId != null) vocabQ = vocabQ.eq('company_id', companyId);
  const { data, error } = await vocabQ;
  if (error || !data || data.length === 0) return null;  // fail-open
  const allowed = new Set(
    (data as Array<{ category: string; value: string }>).map((r) => `${r.category}:${r.value}`),
  );
  const offenders = present
    .filter((f) => !allowed.has(`${f.category}:${f.value.trim()}`))
    .map((f) => ({ field: f.bodyKey, value: f.value.trim() }));
  if (offenders.length === 0) return null;
  return {
    error: 'dropdown_value_invalid',
    reason: offenders
      .map((o) => `${o.field} "${o.value}" is not an active option in Sales Order Maintenance`)
      .join('; '),
    offenders,
  };
}

/* One-time backfill — bind a warehouse to every SO line that still has none, by
   re-deriving from its SO's State. The create-time derive only ran once, so SOs
   placed before per-line warehouse routing existed (or via paths that sent no
   address) kept NULL warehouses and show "—" in MRP. Admin-only. SOs with no /
   unmapped State are skipped (they need a location set). Only NULL lines are
   touched — explicit per-line warehouses are never overwritten. */
mfgSalesOrders.post('/backfill-warehouses', async (c) => {
  const sb = c.get('supabase');
  if (!(await isPriceOverrideCaller(c))) return c.json({ error: 'forbidden' }, 403);

  const { data: nullLines } = await scopeToCompany(
    sb
      .from('mfg_sales_order_items')
      .select('doc_no')
      .is('warehouse_id', null)
      .eq('cancelled', false),
    c,
  );
  const docNos = [...new Set(
    ((nullLines ?? []) as Array<{ doc_no: string | null }>).map((r) => r.doc_no).filter((x): x is string => !!x),
  )];
  if (docNos.length === 0) return c.json({ filled: 0, skipped: 0, orders: 0 });

  // States for those SOs (chunk the .in to dodge the PostgREST row cap).
  const stateByDoc = new Map<string, string | null>();
  for (let i = 0; i < docNos.length; i += 200) {
    const { data: sos } = await scopeToCompany(
      sb
        .from('mfg_sales_orders')
        .select('doc_no, customer_state')
        .in('doc_no', docNos.slice(i, i + 200)),
      c,
    );
    for (const s of (sos ?? []) as Array<{ doc_no: string; customer_state: string | null }>) {
      stateByDoc.set(s.doc_no, s.customer_state);
    }
  }

  let filled = 0; let skipped = 0;
  for (const docNo of docNos) {
    const wh = await deriveWarehouseIdFromState(sb, stateByDoc.get(docNo) ?? null, c);
    if (!wh) { skipped += 1; continue; }
    await scopeToCompany(
      sb
        .from('mfg_sales_order_items')
        .update({ warehouse_id: wh })
        .eq('doc_no', docNo)
        .is('warehouse_id', null)
        .eq('cancelled', false),
      c,
    );
    filled += 1;
  }
  return c.json({ filled, skipped, orders: docNos.length });
});

/* ── SO create core (scan-bg-job factoring, 2026-07-04) ─────────────────────
   The POST / handler body below is PRICING-CRITICAL and must stay the single
   authority for SO creation. The background scan job (scan-so.ts /enqueue)
   needs to create a DRAFT SO AFTER the HTTP request has already returned, so
   the handler body is factored MECHANICALLY into `createSalesOrderCore` — the
   body is UNCHANGED; it now takes a minimal structural context instead of the
   full Hono context. The HTTP route wires the real context through (auth /
   validation / response behaviour identical), while `createDraftSalesOrder`
   below feeds it a synthetic context built from Env + the identities captured
   at enqueue time. `c.json(body, status)` inside the core returns a plain
   outcome object; the HTTP route re-emits it as the real JSON response. */
export type SoCreateOutcome = { status: number; body: Record<string, unknown> };
export type SoCreateContext = {
  req: { json(): Promise<unknown> };
  /* supabase keeps the REAL client type — the core body relies on the typed
     query builders for callback inference (an `any` here turns every
     `.map((r) => ...)` inside the body into an implicit-any TS7006). */
  get(key: 'supabase'): Variables['supabase'];
  get(key: 'user'): { id: string; user_metadata?: unknown };
  get(key: 'houzsUser'): Variables['houzsUser'];
  /* Session origin (mig 0120) — read ONLY by isPosTabletCaller. The HTTP route
     forwards the real context var; the headless scan job returns undefined, so
     an OCR-created draft can never read as a POS caller and can never be
     drift-rejected (its prices come off a handwritten slip). */
  get(key: 'sessionOrigin'): string | undefined;
  /* Multi-company (mig 0061): active company from companyContext. Undefined pre-
     migration / cold-start / headless (scan) so the stamping no-ops. */
  get(key: 'companyId'): number | undefined;
  /* Active company CODE ('HOUZS' | '2990') — picks the Processing-Date deposit
     threshold (owner 2026-07-31: Houzs 30%, 2990 50%). Undefined on the headless
     scan path, which captured only the company ID at enqueue; harmless, because
     that path creates DRAFTS with processing_date = null and the deposit
     gate only runs when a Processing Date is actually being set. */
  get(key: 'companyCode'): string | undefined;
  env: Env;
  json(body: unknown, status?: number): SoCreateOutcome;
  /* Audit-trail source tag for the CREATE entry ("via <source>" in the History
     panel). Omitted → 'web' (interactive POST /). The background scan job
     passes 'scan' so the timeline distinguishes an OCR-created draft from a
     hand-typed order. */
  auditSource?: string;
  /* Optional free-text note stamped on the CREATE audit row (the scan job uses
     it to say the draft came from the background OCR pipeline). */
  auditNote?: string;
};

async function createSalesOrderCore(c: SoCreateContext): Promise<SoCreateOutcome> {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  /* Multi-company (mig 0061): the active company for this create (SoCreateContext
     carries no Hono Context, so companyScope's activeCompanyId/stampCompany can't
     be applied structurally — read companyId here and stamp locally). No-op when
     unresolved (pre-migration / cold-start / headless scan). */
  const companyId = c.get('companyId');
  const stampCo = <T extends Record<string, unknown>>(rows: T[]): Array<T & { company_id?: number }> =>
    companyId != null ? rows.map((r) => ({ company_id: companyId, ...r })) : rows;
  /* Houzs must not mint into 2990's doc-number namespace. nextDocNo below reads
     the month's existing numbers with `.like('${prefix}SO-YYMM-%')` — under the
     2990 company that pattern matches the MIRRORED rows, which are a copy of
     2990's own set, so max+1 returns precisely the number 2990's own minter
     hands out next. The mirror's `ON CONFLICT (doc_no) DO UPDATE` then
     overwrites this order's header and delete-then-reinserts its lines as 2990's
     — a real order, silently gone. Refuse the create instead: the collision has
     to be impossible, not merely detected. */
  // Flip-gated (task #15): pre-flip Houzs must not mint into 2990's namespace;
  // post-flip (HOUZS_OWNS_2990) Houzs IS the minter, so the create-block lifts.
  // The 2990 SO outbox must be fully drained + its minter stopped BEFORE the
  // flip so the two systems can never both hand out the same number.
  if (mintsIntoMirroredNamespace(c as unknown as Context<any>) && !houzsOwns2990(c.env)) {
    return c.json(MIRRORED_SO_CREATE_BLOCKED, 409);
  }
  /* PR #46 — accept customerName as alias for debtorName (rename in flight).
     Commander 2026-05-26: "Debtor Name 其实可以换成 Customer Name". */
  const customerName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!customerName) return c.json({ error: 'customer_name_required' }, 400);
  /* Owner 2026-06-03 (migration 0144) — phone is COMPULSORY on every SO,
     enforced server-side: the POS already client-gates it (validateCustomer)
     and the Backend New SO form gates it too, but the server is the layer a
     tampered or direct API caller can't bypass. Normalise ONCE here and reuse
     for both the SO snapshot (phone column) and the customer identity key. A
     non-MY / unparseable number keeps its raw form (normalizePhone → null)
     rather than being rejected — only an empty phone is blocked. */
  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!rawPhone) {
    return c.json({ error: 'phone_required', reason: 'A phone number is required on every sales order.' }, 400);
  }
  const normPhone = normalizePhone(rawPhone) ?? rawPhone;
  /* PR #46 — Items optional. POS handover may create the SO header first,
     then add items via POST /:docNo/items. Matches PR #41 PO blank-draft
     pattern. Only B2B-bulk path requires items at create. */
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const sb = c.get('supabase'); const user = c.get('user');

  // Edge #4 — itemCode catalog guard. Reject typos / stale codes before any
  // pricing / variant / inventory work runs. requireActive: a create is a NEW
  // pick, and the picker only offers ACTIVE products (owner 2026-08-08).
  if (items.length > 0) {
    const codeCheck = await validateItemCodes(
      sb, items.map((it) => it.itemCode as string | null | undefined), companyId,
      { requireActive: true },
    );
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown, codeCheck.inactive), 409);
    /* Owner 2026-08-08 (HC-SO-2607-013 "square pillow") — a BLANK code with
       typed text is free text wearing a line's clothes; it must never insert,
       DRAFT or not. A blank code with a blank description is the scan
       pipeline's deliberate "Pick a product…" placeholder and is allowed on
       DRAFT creates ONLY — a direct-to-CONFIRMED create refuses it below via
       the confirm gate. */
    const freeText = findFreeTextSoLines(items);
    if (freeText.length > 0) return c.json(freeTextSoLineResponse(freeText), 409);
  }

  /* POS line quantity (Loo 2026-06-12) — see invalidQtyResponse. Runs before
     any PWP claim so a reject burns nothing. */
  for (let i = 0; i < items.length; i++) {
    const badQty = invalidQtyResponse(items[i]?.qty, items[i]?.itemCode, i);
    if (badQty) return c.json(badQty, 422);
    /* Owner 2026-07-17 — see unexplainedExtraAddonResponse. Same loop, same
       "before any PWP claim" position: a reject here must burn nothing. */
    const badExtra = unexplainedExtraAddonResponse(items[i]?.variants, items[i]?.itemCode, i);
    if (badExtra) return c.json(badExtra, 422);
  }

  /* PR — Commander 2026-05-28 — SO composition rules, enforced on the CREATE
     path so the API matches what the SO Detail edit page already blocks.
     (Bug: the create path let through both "delivery date without a processing
     date" AND a sofa+mattress mixed cart — the test batch hit both.)
       1. Processing Date + Delivery Date are all-or-nothing — never one without
          the other (mirrors the edit page's "must be set together" guard).
       2. SOFA is exclusive among MAIN products (sofa / bedframe / mattress):
          a sofa SO may NOT also contain a bedframe or mattress. SERVICE and
          ACCESSORY (and other add-on lines) ride on ANY SO — they never trip
          this. (Commander 2026-05-28: "main product 不能添加…但 service 或
          accessory 什么 products 都可以配".)
       3. All MATTRESS lines in one SO must share ONE brand — different mattress
          brands bill on separate SOs. (Bedframe may ride with a single-brand
          mattress; that combo stays allowed.) */
  {
    const procDate  = (body.processingDate as string | null | undefined) || null;
    const delivDate = (body.customerDeliveryDate as string | null | undefined) || null;
    /* Processing + Delivery are all-or-nothing (both set or both empty). Kept as
       a SHORT-CIRCUIT (not aggregated): an unpaired date is a structurally-
       incomplete input, not one of several field-level fixes. The predicate is
       shared/so-processing-date's, not a local Boolean() compare, so the five
       write paths that enforce this rule cannot drift apart again. No originals
       — every date on a create is new, so nothing is grandfathered. */
    const createPairRefusal = soDatePairRefusal({
      nextProc: procDate, nextDeliv: delivDate, origProc: null, origDeliv: null,
    });
    if (createPairRefusal) return c.json(createPairRefusal, 400);
    /* Aggregate the remaining Processing-Date gates into ONE response instead of
       returning on the first (owner 2026-07-18): the category-mandatory variants
       (Commander 2026-05-29 — a Processing Date means purchasing is released to
       ORDER these goods, so every line must carry the variants that say WHAT to
       order; the CREATE path once skipped this, letting a direct POST slip
       through), the past-date rule (Malaysia UTC+8 "today" so an
       early-UTC request near midnight isn't wrongly rejected), and
       processing-≤-delivery (Owner 2026-06-03). The 30% deposit gate can't join
       here — the order total isn't priced until later — so it emits the SAME
       aggregated shape at its own site below. All dates are NEW on create, so no
       grandfather originals are passed. Fast-fail, before any PWP claim burns. */
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const linesForVariantCheck = items.map((it) => ({
      itemCode: String(it.itemCode ?? ''),
      group:    (it.itemGroup as string | null | undefined) ?? null,
      variants: (it.variants as Record<string, unknown> | null) ?? null,
    }));
    const createProblems = collectProcessingGateProblems({
      procDate,
      delivDate,
      todayMY,
      variantOffenders: procDate ? findIncompleteVariantLines(linesForVariantCheck) : [],
      /* Colour-KIV gate (owner 2026-07-24, SO-2607-016) — a create IS a fresh
         date, so any procDate here is "setting" it: no KIV line may ride in. */
      kivOffenders: procDate ? findColourKivLines(linesForVariantCheck) : [],
    });
    if (createProblems.length > 0) return c.json(validationFailedBody(createProblems), 422);
    /* Rule 2 — sofa is exclusive among MAIN products: no bedframe / mattress
       alongside a sofa. SERVICE / ACCESSORY / OTHERS ride on any SO. The rule
       and its classifier live in lib/main-mix.ts and are shared with the three
       SO line paths and the three CO paths — it used to be a closure here, which
       is exactly why the CO line routes were written without it.
       Loo 2026-06-07 — mattress lines MAY mix BRANDS on one SO. The old Rule 3
       (`so_mattress_one_brand`, #280) blocked e.g. a Happi.S + 2990 mattress in
       one order at the POS counter; the owner never set that rule. Sofa
       exclusivity is the only MAIN-mix gate. Don't re-add a brand gate here. */
    const mainMix = await createMixRefusal(sb, items, companyId);
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  let docNo = await nextDocNo(sb, c);

  /* Caller's REAL scm.staff identity (mig 0066 deterministic sync row, linked
     by staff.user_id) — drives the venue auto-stamp AND the salesperson
     self-lock below. NEVER the bridge's pinned SYSTEM uuid: it is shared by
     every caller, so stamping it as salesperson_id credits the order to one
     phantom salesperson. Nothing looks wrong on screen — it surfaces at
     month-end, when the commission run pays the wrong people and sales analysis
     attributes their orders to "System". resolveOwnerStaffId still returns the
     headless scan job's PRE-RESOLVED uploader id (createDraftSalesOrder feeds it
     through `user`), so an OCR draft keeps crediting whoever scanned the slip. */
  const callerStaffId = await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id);
  /* Refuse rather than mis-attribute — but ONLY for a caller who would actually
     be attributed by it. A self-scoped caller (no scm.so.attribute_other) IS the
     salesperson on this order, so an unidentified one must not silently become
     the phantom; a caller WITH the permission names the salesperson explicitly
     below (or leaves it blank, which stamps NULL, not the phantom) and only
     loses the caller-venue default — blocking them would be a regression for a
     field they never depended on. */
  const canAttributeOther = hasHouzsPerm(c, 'scm.so.attribute_other');
  if (!callerStaffId && !canAttributeOther) {
    /* Deliberately covers BOTH reachable causes (no staff link, or the staff
       lookup itself failed — resolveCallerStaffId drops its `error`), because
       from here they are indistinguishable and the operator's next move is the
       same either way. One plain sentence, no internals: the SCM client's
       humanApiError has no entry for this code and falls through to `message`. */
    return c.json({
      error: 'staff_unlinked',
      message:
        'We could not confirm who this order belongs to — please try again, and if it keeps happening ask IT to link your account to a sales profile.',
    }, 409);
  }
  /* Guarded: `.eq('id', null)` is not "no venue", it is a malformed filter. */
  const callerStaffRes = callerStaffId
    ? await sb.from('staff').select('role, venue_id, showroom_warehouse_id').eq('id', callerStaffId).maybeSingle()
    : null;
  const callerStaff = callerStaffRes?.data ?? null;
  /* Loo 2026-06-05 — a self-scoped sales caller can only create orders under
     their OWN account: whatever salespersonId the client sent is overridden
     with the caller's id (the POS locks the picker too; this closes the API
     hole). Houzs-flavoured: gate on the flat permission key
     `scm.so.attribute_other` against the REAL caller (the 2990 scm.staff.role
     lookup is dead in Houzs — the SCM bridge pins every caller to one
     super_admin row). Owner + IT Admin pass via `*`; grant to other positions
     via the Team > Positions matrix. */
  /* An OMITTED salespersonId falls back to the caller's own staff row, for the
     same reason the self-scoped branch below already does: the creator IS the
     salesperson unless they name someone else. The frontend states this contract
     out loud - SalesOrderNew.tsx omits its UI-only `__self__` sentinel "so the
     backend keeps its own caller-based resolution rather than choking on a fake
     id" - but this branch never implemented that resolution, so an omitted id
     stamped NULL and collectSoConfirmProblems then refused the order with
     "A salesperson must be assigned". Every caller holding
     scm.so.attribute_other (owner, IT Admin, via `*`) could therefore not create
     a confirmed Sales Order at all, while self-scoped sales staff were fine.

     This is NOT the phantom risk the comment above guards against:
     resolveOwnerStaffId returns the caller's REAL scm.staff row (joined by
     staff.user_id) and never the bridge's pinned SYSTEM uuid, so the order is
     credited to the human who raised it. An explicit null in the body still
     means null - only an ABSENT field falls back. */
  const salespersonIdToStamp = canAttributeOther
    ? ((body.salespersonId as string) ?? callerStaffId ?? null)
    : callerStaffId;
  /* ONE read of the selected salesperson, feeding both the `agent` stamp and the
     venue chain below — scm/lib/so-agent.ts has the rule and the FK it closes. */
  const stampStaff = await readStaffForStamp(sb as never, salespersonIdToStamp);
  const agentToStamp = soAgentToStamp(body.agent, stampStaff?.name ?? null);
  /* Migration 0086 + Loo 2026-06-06 — venue follows the SELECTED salesperson:
     an admin/coordinator entering an SO on behalf of a PJ salesperson stamps
     PJ automatically (before, only the CALLER's venue counted, so any
     admin-placed POS order carried a blank venue). Priority:
       1. explicit body.venueId (the Backend form types/derives it)
       2. the stamped salesperson's staff.venue_id
       3. the caller's own staff.venue_id when they're a POS-side role
     A venue-less salesperson (admin testing under their own name) stays
     NULL — admins oversee every venue by design. */
  let venueIdToStamp: string | null = (body.venueId as string | null | undefined) ?? null;
  if (!venueIdToStamp && salespersonIdToStamp) {
    venueIdToStamp = salespersonIdToStamp === callerStaffId
      ? ((callerStaff?.venue_id as string | null) ?? null)
      : (stampStaff?.venueId ?? null);
  }
  if (!venueIdToStamp) {
    if (callerStaff && callerStaff.venue_id &&
        ['sales', 'sales_executive', 'outlet_manager'].includes(callerStaff.role)) {
      venueIdToStamp = callerStaff.venue_id as string;
    }
  }

  /* SO-SKU spec P5 (§4.5) — resolve the venue FK to its display name once.
     Until now venue_id was stamped but the `venue` TEXT stayed NULL, so the
     Detail Listing's Venue column never lit for POS orders. An explicit
     body.venue still wins (the Backend form types it); lines inherit via the
     report flatten. */
  let resolvedVenueName: string | null =
    typeof body.venue === 'string' && body.venue.trim() ? body.venue.trim() : null;
  /* A venue the CLIENT sent is a human's pick — the operator either accepted the
     pre-filled default or typed over it, and either way they are the person who
     knows where they are standing. Marking it MANUAL is what stops any later
     automatic re-resolve (amendment, backfill, re-scan) from quietly replacing
     it; see canAutoResolveVenue. The binding is a DEFAULT, never a lock. */
  let venueSource: VenueSource | null = resolvedVenueName ? 'MANUAL' : null;
  if (!resolvedVenueName && venueIdToStamp) {
    const { data: venueRow } = await sb
      .from('venues').select('name').eq('id', venueIdToStamp).maybeSingle();
    resolvedVenueName = (venueRow as { name?: string } | null)?.name ?? null;
    /* Not MANUAL: nobody typed this, it was derived from the salesperson's
       scm.venues home venue. It stays eligible for a re-resolve. */
    if (resolvedVenueName) venueSource = 'SHOWROOM';
  }

  /* ── VENUE BINDING (owner 2026-07-19) ────────────────────────────────────
     The two remaining sources, resolved by ONE shared rule in
     lib/venue-binding.ts and consumed identically by desktop, mobile and the
     OCR scan path:
       1. PMS / exhibition — the rep is PIC or Sales Attending on a project whose
          PERIOD CONTAINS the SO date -> that project's venue (and its id, which
          hard-links this SO to its fair for the Fair Report, #814).
       2. Showroom — the rep is parked under a Showroom (a scm.warehouses row
          flagged is_showroom) on the Members page -> that showroom's venue.
     Then NOTHING. No company default, no first-venue-in-the-list, no `?? ''`.
     An unresolvable venue stays NULL, because venue feeds exhibition P&L and
     commission and a guessed venue is a wrong profit figure paid to a real
     person. Empty is visibly incomplete; wrong is not.

     WHY THIS REPLACED THREE COPIES OF ONE QUERY: the same SELECT was written out
     here, in the project_id stamp below, and in GET /active-venue — and had
     already begun to differ. They are now one call.

     SHOWROOM PARKING IS THE PRIMARY PATH, and this block must be correct with
     ZERO project assignments in the system — which is the actual production
     state and the expected steady state. A rep on no projects is NORMAL: they
     take rule 2 silently. Nothing here warns or errors because a project has no
     team.

     TWO FIXES vs the rule this replaces: it never tested end_date (so a fair
     that ended in March claimed every order forever, for anyone ever assigned to
     it), and `ORDER BY start_date DESC LIMIT 1` was arbitrary among same-day
     projects (the same rep could get two different venues on two identical
     orders). See BUG-HISTORY.md.

     project_id is deliberately still resolved even when the venue came from the
     client: the New-SO form pre-fills body.venue from /active-venue, which marks
     it MANUAL, and hanging the fair link off the venue branch would leave
     project_id NULL for the very flow the Fair Report needs. NON-FATAL
     throughout — no lookup failure may ever block a sale. */
  let projectIdToStamp: number | null = null;
  {
    const houzsUser = c.get('houzsUser');
    const uid = houzsUser?.id != null ? Number(houzsUser.id) : NaN;
    if (Number.isFinite(uid)) {
      /* The ORDER's date, not today's — a backdated slip must resolve against
         the fair that was running the day it was written, in MYT. */
      const soDateForVenue =
        typeof body.soDate === 'string' && body.soDate.trim()
          ? body.soDate.trim().slice(0, 10)
          : todayMyt();
      try {
        const { pmsCandidates, showroom } = await loadVenueBindingInputs({
          /* Cast: SupabaseClient's generics are deep enough that structurally
             matching them here trips TS2589. The loader only ever calls
             .from().select().eq().maybeSingle(), which VenueBindingSb pins. */
          db: c.env.DB, sb: sb as unknown as VenueBindingSb, userId: uid,
          /* The SALESPERSON the order is attributed to, not necessarily the
             caller: an admin keying an order in for a showroom rep must stamp
             the REP's showroom, exactly as the home-venue chain above follows
             the selected salesperson. */
          staffId: salespersonIdToStamp ?? callerStaffId,
        });
        const binding = resolveVenueBinding({ soDate: soDateForVenue, pmsCandidates, showroom });
        projectIdToStamp = binding.projectId;
        if (!resolvedVenueName && binding.venueName) {
          resolvedVenueName = binding.venueName;
          venueSource = binding.source;
        }
      } catch {
        /* non-fatal — leave venue + project_id NULL if the lookup fails */
      }
    }
  }

  /* Houzs venue_id guard — only a real uuid reaches the uuid column; a
     project_venues integer id or a `showroom:…` synthetic id becomes NULL and
     the venue TEXT column (resolvedVenueName) carries the venue. See
     venueIdUuidOrNull for the full rationale; the header PATCH shares it. */
  const venueIdUuid = venueIdUuidOrNull(venueIdToStamp);

  /* ── Confirm gate on the DIRECT-TO-CONFIRMED create (owner 2026-08-08) ────
     Every create that is not asDraft lands CONFIRMED (PR #154), so the same
     gates the DRAFT→CONFIRMED status transition enforces must hold HERE too:
     a salesperson, a venue, and every line a real catalog SKU with its
     required variant axes. Runs AFTER the venue / salesperson resolution
     above (so the caller's home-venue / PMS autofill gets its chance to
     satisfy the gate) and BEFORE any PWP claim (a reject must burn nothing).
     Unknown codes were already refused above, so only blank-code placeholder
     lines can trip the catalog half here. Drafts (asDraft: true — the scan
     pipeline, Save as draft) skip this entirely and stay freely saveable. */
  if ((body as { asDraft?: unknown }).asDraft !== true) {
    const confirmProblems = collectSoConfirmProblems({
      salespersonId: salespersonIdToStamp,
      agent: agentToStamp,
      venue: resolvedVenueName,
      venueId: venueIdToStamp,
      lines: items.map((it) => ({
        itemCode: it.itemCode as string | null | undefined,
        group: (it.itemGroup as string | null | undefined) ?? null,
        variants: (it.variants as Record<string, unknown> | null) ?? null,
        description: (it.description as string | null | undefined) ?? null,
      })),
    });
    if (confirmProblems.length > 0) return c.json(validationFailedBody(confirmProblems), 422);
  }

  // Compute totals + category breakdown
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  // Task #114 — also accumulate per-category COST so the four cost columns
  // on the header (migration 0079) get populated on insert. Mirrors the
  // revenue accumulators above.
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  /* PR-E — Per-item delivery date inherits the SO header's
     customer_delivery_date on create unless the client explicitly
     supplies a per-line lineDeliveryDate. Override flag mirrors the
     client's choice (defaults false → cascade-tracked). */
  const headerDeliveryDate = dateOrNull(body.customerDeliveryDate);
  /* MFG-PRICING-ENGINE — Server-side recompute (Commander 2026-05-27
     non-negotiable; the honest-pricing red line). Load the master
     maintenance config once, then for each line item recompute the
     unit price from (product, fabric, variants). Drift > 0.5% rejects
     the request with HTTP 400. Manual override path (mfgSoPriceOverrides)
     stays intact at PATCH /:docNo/items/:itemId/override. */
  const cachedConfig = await loadMaintenanceConfig(sb);
  // Special Add-ons (migration 0134) — fetched once; each line's specials pool is
  // built from these so POS add-ons price from special_addons, not the legacy pool.
  const cachedSpecialAddons = await loadSpecialAddons(sb);
  /* PR #216 — allowed_options pre-flight. Run BEFORE the pricing recompute
     so a disallowed variant returns the precise field/value/allowed
     payload instead of getting silently re-priced. Batched (Loo 2026-06-06):
     2 `in()` queries for the whole order instead of 2 × lines — per-line
     loads helped a 6-item order blow the CF Workers subrequest cap.
     First violation across all lines short-circuits the request. */
  const { byCode: pmByCode, lookupError: pmErr } = await loadProductsAndModels(sb, items.map((it) => String(it?.itemCode ?? '')), companyId);
  /* A code missing from the map because the READ FAILED is not a code the
     catalog has nothing to say about — the loop below would read the resulting
     nulls as "allowed" and create the order. Refuse instead. */
  if (pmErr) return c.json(variantCheckUnavailableResponse(pmErr), 409);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const code = String(it.itemCode ?? '');
    if (!code) continue;
    const pm = pmByCode.get(code) ?? { product: null, model: null };
    const err = checkAllowedOptions(
      pm.product,
      pm.model,
      (it.variants as Parameters<typeof checkAllowedOptions>[2]) ?? null,
    );
    if (err) {
      return c.json({ ...err, lineIdx: i, itemCode: code }, 400);
    }
  }
  const cachedCombos = await loadActiveSofaCombos(sb, c);  // Phase 4b — sofa selling recompute
  const cachedFabricAddonConfig = await loadFabricTierAddonConfig(sb, companyId);  // migration 0124 — fabric-tier Δ (SoCreateContext → local companyId)
  const cachedModelOverrides = await loadModelFabricTierOverrides(sb);  // migration 0175 — per-Model Δ
  const cachedCompartmentOverrides = await loadCompartmentFabricTierOverrides(sb);  // migration 0025 — per-compartment Δ

  /* Loo 2026-06-05 — maintained-dropdown 409 gate. Runs BEFORE any side
     effect (customer upsert, PWP claims) so a rejected request leaves
     nothing behind. */
  const dropdownErr = await validateSoDropdownFields(sb, body, companyId);
  if (dropdownErr) return c.json(dropdownErr, 409);

  // Subrequest diet (Loo 2026-06-06) — one `in()` query for every line's
  // product row instead of one query per line.
  const productRowByCode = await loadProductsByCodes(sb, items.map((it) => String(it.itemCode ?? '')), companyId);
  const lineProducts = items.map((it) => productRowByCode.get(String(it.itemCode ?? '').trim()) ?? null);
  /* PWP Code Voucher (migration 0130) — code-driven grant + atomic claim. A
     reward line earns its per-SKU pwp_price_sen ONLY if it carries a valid
     `variants.pwpCode`: the code exists, is redeemable (AVAILABLE, or RESERVED
     owned by the caller), its snapshot reward_category + eligible model list
     match the reward product, the reward SKU has pwp_price_sen > 0, and — for an
     AVAILABLE cross-order voucher — the order's customer matches the code's bound
     customer (§8.8). Each valid code is CLAIMED atomically (conditional UPDATE →
     USED) so two orders can't double-spend one; a lost race / forged / used /
     ineligible code is simply not granted → that line reprices at full
     sell_price_sen → drift → 400 for a POS-tablet caller. Un-applied reserved
     codes owned by this order's triggers are flipped to AVAILABLE after insert
     (carried-forward voucher). Default data (no codes) → nothing granted → no
     change. NOTE: applied on the create path; backend per-line PATCH/override
     re-prices at full sell price (no order context) — re-create to re-apply. */
  /* Owner 2026-06-03 (migration 0144) — resolve the REAL customer identity
     (find-or-create by name + phone) and stamp it on the SO. Phone is validated
     above so the key is always complete. Best-effort: an unexpected RPC error
     must not block a paying customer at the counter, so we log it and fall back
     to null (a Phase 2 backfill can repair it). The resolved id flows into the
     SO header (customer_id), the cross-category "same customer" match, and the
     PWP voucher binding below — all of which previously saw a permanently-null
     customer_id (the POS never sent one). */
  let orderCustomerId: string | null = null;
  const casCo = requireActiveCompanyId(c); if (!casCo.ok) return c.json(casCo.refusal, 409);  // HAZARD 1
  /* Scan blank-draft shell (owner 2026-07-04) — a scan that could not read the
     customer's name/phone still lands a draft the rep completes by hand, but it
     carries PLACEHOLDER name/phone. Resolving a customer identity off those
     placeholders would spawn a phantom customer (and collide every blank shell
     onto one bogus record), so shells skip the upsert; customer_id stays null
     until the rep fills the real name/phone and re-saves. */
  if (body._scanShell !== true) {
    const { data: resolvedCustomerId, error: customerErr } = await sb.rpc('upsert_customer_by_name_phone', {
      p_name:  customerName,
      p_phone: normPhone,
      p_email: typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null,
      p_company_id: casCo.companyId,  // NOT `?? null` — HAZARD 1 in docs/modules/sales-order.md
    });
    if (customerErr) {
      console.error('[mfg-so] customer resolve failed:', customerErr.message ?? customerErr);
    } else {
      orderCustomerId = (resolvedCustomerId as string | null) ?? null;
    }
  }
  const pwpBaseByIdx = new Map<number, number>();            // non-sofa idx → pwp_price_sen
  const pwpSofaByIdx = new Map<number, string[]>();          // sofa idx → granted reward combo ids
  /* Default Free Gift (migration 0170) — a line tagged variants.freeGift is
     priced to RM 0 ONLY when the order also carries a real qualifying trigger
     (a non-sofa product's default_free_gifts, or a sofa build matching a combo's
     default_free_gifts — D9). Validated below, after PWP settles; an ineligible
     gift is rejected 409 free_gift_not_eligible. The grant rides the SAME 0-base
     path PWP uses (pwpBaseSen = 0 ⇒ free), so recomputeFromSnapshot needs no new
     parameter. Honest-pricing (CLAUDE.md): a gift with no trigger reprices to the
     accessory's real sell_price_sen → a tampered "free" client price drifts. */
  const freeGiftBaseByIdx = new Map<number, number>();       // gift line idx → granted base (always 0)
  // Free Item Campaign (migration 0176) — idx → resolved {campaignId, campaignName}.
  const freeItemByIdx = new Map<number, { campaignId: string; campaignName: string }>();
  const claimedPwpCodes: Array<{ code: string; prevStatus: string }> = [];
  /* Loo 2026-06-05 (VALOR / PW-Test-voucher incident) — a line that CARRIES a
     pwpCode but fails the grant used to be silently repriced at full price,
     surfacing later as an inscrutable pricing_drift. Track WHY each code was
     refused and reject the whole order with an explicit 409 instead — the
     salesperson sees "code belongs to a different customer", not a price diff. */
  const pwpRejections: Array<{ idx: number; itemCode: string; code: string; reason: string }> = [];
  /* One code = one redemption (Loo 2026-06-06, PWP-1528WLIE incident) — the
     same code on TWO lines of one order used to double-grant: line A's claim
     flips it USED → redeemed_doc_no = docNo, but the SO row isn't inserted
     until after this loop, so line B's orphan check found no such SO and
     "self-healed" line A's fresh claim. Gate duplicates up front. */
  const seenPwpCodes = new Set<string>();
  /* Subrequest diet (Loo 2026-06-06) — prefetch every carried code in ONE
     `in()` query instead of one read per code. The conditional UPDATE below
     stays the atomicity authority: a code claimed by a parallel order between
     this read and the claim simply fails the claim ("just claimed — try
     again"), exactly as before. */
  const allPwpCodes = Array.from(new Set(
    items
      .map((it) => String((it?.variants as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim())
      .filter(Boolean),
  ));
  // mig 0188 re-keyed pwp_codes on (company_id, code): a caller-supplied `code` alone matches whichever company's row comes back first, so the prefetch/burn/rollback below all carry pwpCompanyId (matches add-line ~L3828). BUG-HISTORY 2026-08-19.
  const pwpCompanyId = activeCompanyId(c);
  if (allPwpCodes.length > 0 && pwpCompanyId == null) return c.json({ error: 'company_unresolved', message: 'Cannot tell which company this order belongs to right now. Reload and try again.' }, 409);
  const pwpRowByCode = new Map<string, Record<string, any>>();
  let pwpPrefetchFailed = false;
  if (allPwpCodes.length > 0) {
    const { data: codeRows, error: codeReadErr } = await sb
      .from('pwp_codes')
      .select('code, status, owner_staff_id, reward_category, eligible_reward_model_ids, reward_combo_ids, reward_size_codes, reward_compartments, customer_id, source_doc_no, redeemed_doc_no, type')
      .in('code', allPwpCodes).eq('company_id', pwpCompanyId);
    if (codeReadErr) {
      // A failed read is NOT "code not found" (same honesty rule as the
      // cross-category lookup) — reject as retryable, burn nothing.
      console.error('[mfg-so] pwp code prefetch failed:', codeReadErr.message ?? codeReadErr);
      pwpPrefetchFailed = true;
    }
    for (const r of ((codeRows as Array<Record<string, any>>) ?? [])) pwpRowByCode.set(String(r.code), r);
  }
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const code = String((it?.variants as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim();
    if (!code) continue;
    const reject = (reason: string) =>
      pwpRejections.push({ idx, itemCode: String(it?.itemCode ?? ''), code, reason });
    // HAZARD 2 (see the guide): claiming nothing is safe; claiming theirs is not.
    if (companyId == null) { reject('cannot tell which company this order belongs to — reload and try again'); continue; }
    const pwpCompanyId: number = companyId;
    if (seenPwpCodes.has(code)) { reject('code is already applied to another line on this order'); continue; }
    seenPwpCodes.add(code);
    /* One code = one redemption = ONE unit (Loo 2026-06-12); qty>1 would price every unit off one voucher. POS pins reward lines to 1. */
    if (Number(it?.qty ?? 1) !== 1) { reject('a PWP reward line must be quantity 1'); continue; }
    const product = lineProducts[idx];
    if (!product) { reject('unknown item code'); continue; }
    if (pwpPrefetchFailed) { reject('could not verify the code — please try again'); continue; }
    const cRow = pwpRowByCode.get(code) ?? null;
    if (!cRow) { reject('code not found — it may have been replaced; re-apply PWP on this line'); continue; }
    /* Same-cart ownership — MUST key on callerStaffId, the same identity
       /pwp-codes reserve stamps. It read `user.id` (the bridge's pin) on both
       sides, so every RESERVED code looked owned by whoever was confirming: one
       salesperson could burn another's held code. A null callerStaffId owns no
       RESERVED codes by construction (reserve refuses to stamp one), so only an
       AVAILABLE voucher can redeem — never a null===null match. */
    const redeemable =
      cRow.status === 'AVAILABLE' ||
      (cRow.status === 'RESERVED' && callerStaffId != null && cRow.owner_staff_id === callerStaffId);
    /* Orphan self-heal (2026-06-05, SO-2606-020 incident) — a code claimed by a
       create attempt that died on a path without rollbackPwpClaims (uncaught
       exception / Worker timeout) is left USED pointing at a doc_no that was
       never inserted. Every retry then sees USED → no grant → full reprice →
       pricing_drift, bricking the cart forever. If the redeemed SO does not
       exist, the claim never really happened — treat the code as redeemable
       again. (A legitimately USED code points at a real SO and stays burned.) */
    let orphanedUsed = false;
    // Never treat THIS request's own docNo as a dead SO — it is inserted only
    // after this loop, so a code claimed earlier in this request would look
    // orphaned and get double-granted (belt to the seenPwpCodes braces above).
    if (!redeemable && cRow.status === 'USED' && cRow.redeemed_doc_no && cRow.redeemed_doc_no !== docNo) {
      const { data: deadSo } = await sb
        .from('mfg_sales_orders')
        .select('doc_no')
        .eq('doc_no', cRow.redeemed_doc_no)
        .maybeSingle();
      orphanedUsed = !deadSo;
    }
    if (!redeemable && !orphanedUsed) {
      reject(cRow.status === 'USED'
        ? `code already used${cRow.redeemed_doc_no ? ` on ${cRow.redeemed_doc_no}` : ''}`
        : cRow.status === 'RESERVED'
          ? 'code is reserved by another salesperson'
          : `code is not redeemable (${cRow.status})`);
      continue;
    }
    const prodCat = String(product.category ?? '').toUpperCase();
    if (prodCat !== String(cRow.reward_category).toUpperCase()) {
      reject(`code rewards ${String(cRow.reward_category)}, not this item`);
      continue;
    }
    // Customer binding — an AVAILABLE voucher only redeems for its earner.
    if (cRow.status === 'AVAILABLE' && cRow.customer_id && orderCustomerId && cRow.customer_id !== orderCustomerId) {
      reject('code belongs to a different customer');
      continue;
    }

    // Eligibility — SOFA is matched by Combo (Phase 2); other categories by the
    // reward Model + a per-SKU PWP price. A miss → not granted → the line keeps
    // its full price → a claimed-PWP tamper drifts → 400 (the code is NOT burned).
    let grantSofaComboIds: string[] | null = null;
    let grantPwpPrice = 0;
    if (prodCat === 'SOFA') {
      const rewardComboIds = (cRow.reward_combo_ids as string[] | null) ?? [];
      if (rewardComboIds.length === 0) { reject('voucher has no reward combos'); continue; }
      const sofaArgs = extractSofaComboLookupArgs(String(it?.itemGroup ?? 'sofa'), (it?.variants as Record<string, unknown> | null) ?? null);
      const built = sofaArgs?.modules ?? [];
      if (built.length === 0) { reject('sofa line carries no build modules'); continue; }
      const candidate = cachedCombos.filter(
        (c) => rewardComboIds.includes(c.id) && (!product.base_model || c.baseModel === product.base_model),
      );
      if (!candidate.some((c) => matchComboSubset(built, c.modules) != null)) {
        reject("sofa build doesn't match the voucher's reward combo");
        continue;
      }
      // Reward compartment refinement (0182) — the code snapshots the rule's
      // reward refinement; the build must satisfy it.
      if (!passesRefinementColumns(
        { category: 'SOFA', modelId: product.model_id ?? null, sizeCode: null, builtCompartments: built },
        (cRow.reward_size_codes as string[] | null) ?? null,
        (cRow.reward_compartments as string[] | null) ?? null,
      )) { reject("sofa build doesn't match the voucher's reward compartment"); continue; }
      grantSofaComboIds = rewardComboIds;
    } else {
      const pwpPrice = Math.round(Number(product.pwp_price_sen ?? 0));
      // A 'promo' code prices a 0 reward as FREE; a 'pwp' code still needs a set
      // price (> 0), where 0 means "no PWP price". (migration 0145)
      const isPromo = String(cRow.type ?? 'pwp') === 'promo';
      if (!isPromo && !(pwpPrice > 0)) { reject('this SKU has no PWP price set (SKU Master)'); continue; }
      const elig = (cRow.eligible_reward_model_ids as string[] | null) ?? [];
      const modelOk = elig.length === 0 || (product.model_id != null && elig.includes(product.model_id));
      if (!modelOk) { reject('code is not valid for this model'); continue; }
      // Reward size refinement (0182).
      if (!passesRefinementColumns(
        { category: prodCat, modelId: product.model_id ?? null, sizeCode: product.size_code ? String(product.size_code).toUpperCase() : null, builtCompartments: [] },
        (cRow.reward_size_codes as string[] | null) ?? null,
        (cRow.reward_compartments as string[] | null) ?? null,
      )) { reject('code is not valid for this size'); continue; }
      grantPwpPrice = pwpPrice;
    }

    // Atomic claim — USED only if still redeemable. Preserve the original
    // source_doc_no (earning SO) for a cross-order voucher; stamp it for a
    // same-cart one.
    let claimQ = sb
      .from('pwp_codes')
      .update({
        status:             'USED',
        source_doc_no:      cRow.source_doc_no ?? docNo,
        redeemed_doc_no:    docNo,
        redeemed_item_code: product.code,
        updated_at:         new Date().toISOString(),
      })
      // HAZARD 2 (see the guide) — both halves of the key
      .eq('code', code).eq('company_id', pwpCompanyId);
    // Orphaned-USED re-claim matches the orphan row exactly (USED + same dead doc_no) so a live redemption can't be hijacked.
    claimQ = orphanedUsed
      ? claimQ.eq('status', 'USED').eq('redeemed_doc_no', cRow.redeemed_doc_no)
      : claimQ.in('status', ['RESERVED', 'AVAILABLE']);
    const { data: claimed } = await claimQ.select('code').maybeSingle();
    if (!claimed) { reject('code was just claimed by another order — try again'); continue; }
    /* prevStatus drives the rollback restore. An orphan re-claim's true prior status is unknown, so restore the plausible redeemable state — RESERVED when owned, else AVAILABLE — never the bricked USED. */
    const prevStatus = orphanedUsed
      ? (cRow.owner_staff_id ? 'RESERVED' : 'AVAILABLE')
      : cRow.status;
    claimedPwpCodes.push({ code, prevStatus });
    if (grantSofaComboIds) pwpSofaByIdx.set(idx, grantSofaComboIds);
    else pwpBaseByIdx.set(idx, grantPwpPrice);
  }
  /* Restore claimed codes to their prior state on a post-claim rejection (drift 400 / insert failure) so a failed order never burns a voucher. */
  const rollbackPwpClaims = async () => {
    for (const { code, prevStatus } of claimedPwpCodes) {
      const patch: Record<string, unknown> = {
        status: prevStatus, redeemed_doc_no: null, redeemed_item_code: null,
        updated_at: new Date().toISOString(),
      };
      if (prevStatus === 'RESERVED') patch.source_doc_no = null;  // we stamped it on claim
      await sb.from('pwp_codes').update(patch)  // HAZARD 2: code alone un-burns theirs
        .eq('code', code).eq('status', 'USED').eq('company_id', pwpCompanyId);
    }
  };

  /* Explicit 409 when ANY carried code was refused (Loo 2026-06-05); otherwise the line silently repriced full and died later as a bare pricing_drift. Claimed codes are rolled back so nothing burns. */
  if (pwpRejections.length > 0) {
    await rollbackPwpClaims();
    return c.json({
      error: 'pwp_code_rejected',
      reason: pwpRejections
        .map((r) => `${r.itemCode || `line ${r.idx + 1}`}: ${r.code} — ${r.reason}`)
        .join('; '),
      offendersPwp: pwpRejections,
    }, 409);
  }

  /* Default Free Gift validation (migration 0170, D9) — runs AFTER PWP settles
     (so a gift never collides with a voucher) and BEFORE the recompute pass (so
     a granted gift can ride the pwpBaseSen = 0 path). A line tagged
     `variants.freeGift` is granted base 0 ONLY when the order ALSO carries a real
     qualifying trigger: a NON-sofa product whose default_free_gifts grants the
     claimed gift product, OR a SOFA line whose build matches a combo carrying
     default_free_gifts (D9). Triggers and claims are pure data fed to the shared
     validateFreeGiftClaims; ANY ineligible gift → 409 free_gift_not_eligible
     (after rollbackPwpClaims so nothing burns). Honest-pricing: a rejected /
     un-granted gift reprices to the accessory's real sell_price_sen below, so a
     tampered "free" client price drifts → 400. */
  {
    // Per-Model default-gift map (migration 0174), keyed by product_models.id,
    // loaded ONCE for the whole request (never per-line — CF Workers subrequest
    // cap). Shared with reconcile via the per-Model buildFreeGiftTriggers so
    // create + edit can never compute a different gift set.
    const modelGiftsById = await loadModelDefaultGifts(sb);

    // Flatten each request line to a TriggerLine for the shared builder. The
    // per-line index keys the trigger (`idx-${idx}`); a gift line (freeGift)
    // is flagged so the builder skips it as a trigger (one-way). Gifts resolve
    // from the line's Model (model_id), not the combo — combo gifting is retired.
    const triggerLines: TriggerLine[] = items.map((it, idx) => {
      const variants = (it?.variants as Record<string, unknown> | null) ?? null;
      const product = lineProducts[idx] ?? null;
      const modelId = product?.model_id ?? null;
      const cells = (variants?.cells as Array<{ moduleId?: unknown }> | undefined) ?? [];
      const builtCompartments = Array.isArray(cells)
        ? cells.map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
        : [];
      return {
        triggerKey: `idx-${idx}`,
        itemCode:   product?.code ?? '',
        category:   String(product?.category ?? ''),
        qty:        Number(it?.qty ?? 1),
        modelId,
        buildKey:   (variants?.buildKey as string | undefined) ?? null,
        isFreeGift: Boolean(variants?.freeGift),
        sizeCode:   product?.size_code ? String(product.size_code).toUpperCase() : null,
        builtCompartments,
        gifts:      modelId ? (modelGiftsById.get(modelId) ?? []) : [],
      };
    });
    const triggers = buildFreeGiftTriggers(triggerLines);

    const claims: FreeGiftLineClaim[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const variants = (it?.variants as Record<string, unknown> | null) ?? null;
      const fg = variants?.freeGift;
      if (!fg) continue;
      const fgObj = (fg && typeof fg === 'object') ? (fg as Record<string, unknown>) : null;
      // giftProductId is an mfg_products.id (set by the POS marshaller). No
      // itemCode (SKU) fallback — a SKU would never match the UUID-keyed trigger
      // config, so an empty id fails honestly as `no_trigger` rather than
      // masquerading as ineligibility.
      const giftProductId = String(fgObj?.giftProductId ?? '');
      claims.push({ idx, giftProductId, qty: Number(it?.qty ?? 1) });
    }

    if (claims.length > 0) {
      const { valid, rejected } = validateFreeGiftClaims(claims, triggers);
      if (rejected.length > 0) {
        await rollbackPwpClaims();
        return c.json({
          error: 'free_gift_not_eligible',
          reason: rejected
            .map((r) => `line ${r.idx + 1}: ${r.giftProductId} — ${r.reason}`)
            .join('; '),
          offendersFreeGift: rejected,
        }, 409);
      }
      for (const idx of valid) freeGiftBaseByIdx.set(idx, 0);
    }
  }

  /* Free Item Campaign (migration 0176) — a line tagged variants.freeItem
     { campaignId } is forced to RM0 ONLY when an ACTIVE campaign covers the
     line's Model (sofa 'combo' scope: the build must match the pinned combo) AND
     the line qty <= the campaign's per-line cap. Eligibility uses the SAME shared
     campaignsCoveringLine the POS button uses (no drift). Ineligible → 409
     free_item_not_eligible (after rollbackPwpClaims). The forced-zero + drift skip
     live in the persist pass below; here we only validate + resolve the name. */
  {
    const activeCampaigns = await loadActiveFreeItemCampaigns(sb);
    const comboModulesById = new Map<string, string[][]>(
      cachedCombos.map((cb) => [cb.id, cb.modules]),
    );
    const rejections: Array<{ idx: number; reason: string }> = [];
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const variants = (it?.variants as Record<string, unknown> | null) ?? null;
      const fi = variants?.freeItem;
      if (!fi || typeof fi !== 'object') continue;
      const campaignId = String((fi as Record<string, unknown>).campaignId ?? '');
      if (!campaignId) { rejections.push({ idx, reason: 'no_campaign' }); continue; }
      const product = lineProducts[idx] ?? null;
      const cells = (variants?.cells as Array<{ moduleId?: unknown }> | undefined) ?? [];
      const built = Array.isArray(cells)
        ? cells.map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
        : [];
      const covering = campaignsCoveringLine(
        {
          category: String(product?.category ?? ''),
          modelId: product?.model_id ?? null,
          sizeCode: product?.size_code ? String(product.size_code).toUpperCase() : null,
          builtModuleIds: built,
        },
        activeCampaigns,
        comboModulesById,
      );
      const chosen = covering.find((c) => c.id === campaignId);
      if (!chosen) { rejections.push({ idx, reason: 'not_eligible' }); continue; }
      if (Number(it?.qty ?? 1) > chosen.maxFreeQty) { rejections.push({ idx, reason: 'over_cap' }); continue; }
      // Stamp the resolved name onto the persisted variants (D8) + mark forced-zero.
      if (!it) continue; // narrowing guard — items[idx] is always set at this point
      const v = (it.variants as Record<string, unknown> | null) ?? {};
      v.freeItem = { campaignId: chosen.id, campaignName: chosen.name };
      (it as { variants?: unknown }).variants = v;
      freeItemByIdx.set(idx, { campaignId: chosen.id, campaignName: chosen.name });
    }
    if (rejections.length > 0) {
      await rollbackPwpClaims();
      return c.json({
        error: 'free_item_not_eligible',
        reason: rejections.map((r) => `line ${r.idx + 1}: ${r.reason}`).join('; '),
        offendersFreeItem: rejections,
      }, 409);
    }
  }

  /* P3 — keep each sofa item's module price map so the split below distributes
     the build total with the SAME weights the drift gate priced from. */
  const sofaModulePricesByIdx = new Map<number, Record<string, number> | null>();
  /* Loo 2026-06-13 — the POS product-page remark + special add-on (note + extra
     charge) is always available; the pos_product_remark gate was removed. The
     only flag still read here is the retired pos_remark_extra_auto_sku (one-shot
     mint, OFF by default); resolve it just for the lines that declare an extra. */
  const hasDeclaredExtra = items.some((it) =>
    Number((it.variants as { extraAddonAmountRM?: unknown } | null)?.extraAddonAmountRM ?? 0) > 0);
  let autoSkuEnabled = false;
  if (hasDeclaredExtra) {
    // SoCreateContext is not a Hono Context (see metaQ note above) — add the
    // company predicate from the local companyId instead of scopeToCompany(c).
    let flagQ = sb
      .from('so_settings').select('key, enabled')
      .in('key', ['pos_remark_extra_auto_sku']);
    if (companyId != null) flagQ = flagQ.eq('company_id', companyId);
    const { data: flagRows, error: flagErr } = await flagQ;
    if (flagErr) {
      await rollbackPwpClaims();
      return c.json({ error: 'lookup_failed', reason: flagErr.message }, 500);
    }
    const flags = new Map((flagRows ?? []).map((r) => [(r as { key: string }).key, (r as { enabled: boolean }).enabled]));
    autoSkuEnabled = flags.get('pos_remark_extra_auto_sku') === true; // missing row → OFF
  }

  /* Subrequest diet (Loo 2026-06-06) — prefetch every line's fabric rows in
     TWO `in()` queries (was 2 × lines), and memoize the per-(base_model,
     depth) sofa module-price load so N lines of the same Model cost one
     query instead of N. */
  const fabricRowByCode = await loadFabricsByCodes(
    sb, items.map((it) => (it.variants as { fabricCode?: string } | null)?.fabricCode ?? null));
  const sellingTiersByFabricId = await loadFabricSellingTiersByIds(
    sb, items.map((it) => (it.variants as { fabricId?: string } | null)?.fabricId ?? null));
  const sofaModulePricesMemo = new Map<string, Promise<Record<string, number> | null>>();
  // Audit 2026-06-11 C2 — module COST rows, memoized per base_model (the
  // per-line seat size + fabric tier resolution happens inside the recompute).
  const sofaModuleCostRowsMemo = new Map<string, Promise<SofaModuleCostRowLite[] | null>>();
  /* Owner ruling — a non-POS author prices freely, so their hand-entered selling
     price is persisted as-is. Trust is decided PER LINE by the same `erpLineTrust`
     the two line writes use: this was one boolean for the whole request, which
     cannot express "THIS line is deliberately free", so `zeroPriceIntended` was
     never read on create and a line marked RM 0 on a NEW order silently took the
     catalogue price. The POS lookup does I/O and cannot vary per line — resolved
     once here. POS callers stay authoritative + drift-rejected. */
  const createPosTablet = await isPosTabletCaller(c);
  const recomputes: Array<RecomputedLine | null> = await Promise.all(items.map(async (it, idx) => {
    const itemCode = String(it.itemCode ?? '');
    if (!itemCode) return null;
    const product = lineProducts[idx] ?? null;
    const fabricCode = ((it.variants as { fabricCode?: string } | null)?.fabricCode ?? '').trim();
    const fabricId = ((it.variants as { fabricId?: string } | null)?.fabricId ?? '').trim();
    const fabric = fabricCode ? (fabricRowByCode.get(fabricCode) ?? null) : null;
    const sellingTiers = fabricId ? (sellingTiersByFabricId.get(fabricId) ?? null) : null;
    // SOFA-SELLING-PLAN — a sofa's per-module SELLING prices are its Model's
    // module-SKU sell_price_sen; load them so the drift gate reprices the build
    // from the same source the POS used. Non-sofa lines skip it.
    let sofaModulePrices: Record<string, number> | null = null;
    let sofaModuleCostRows: SofaModuleCostRowLite[] | null = null;
    if (product?.category === 'SOFA') {
      const depth = String((it.variants as { depth?: unknown } | null)?.depth ?? '24');
      const memoKey = `${product.base_model ?? ''}|${depth}`;
      let pending = sofaModulePricesMemo.get(memoKey);
      if (!pending) {
        pending = loadModelSofaModulePrices(sb, product.base_model, depth, companyId);
        sofaModulePricesMemo.set(memoKey, pending);
      }
      // C2 — COST rows ride the same diet: one load per base_model.
      const costKey = product.base_model ?? '';
      let pendingCost = sofaModuleCostRowsMemo.get(costKey);
      if (!pendingCost) {
        pendingCost = loadModelSofaModuleCostRows(sb, product.base_model, companyId);
        sofaModuleCostRowsMemo.set(costKey, pendingCost);
      }
      [sofaModulePrices, sofaModuleCostRows] = await Promise.all([pending, pendingCost]);
    }
    sofaModulePricesByIdx.set(idx, sofaModulePrices);
    const draft: MfgItemForRecompute = {
      itemCode,
      itemGroup:      String(it.itemGroup ?? 'others'),
      qty:            Number(it.qty ?? 1),
      unitPriceSen: Number(it.unitPriceSen ?? 0),
      variants:       (it.variants as MfgItemForRecompute['variants']) ?? null,
    };
    // PWP grant for this line when its code was claimed: a per-SKU base (non-
    // sofa) or the reward combo ids (sofa). Else null → normal base / price.
    // Default Free Gift (migration 0170) — a validated gift line falls back to a
    // 0 base on the SAME pwpBaseSen path (0 ⇒ free), so no recompute signature
    // change. PWP always wins if both somehow apply (a gift is non-sofa, no code).
    const pwpBaseSen = pwpBaseByIdx.get(idx) ?? freeGiftBaseByIdx.get(idx) ?? null;
    const pwpSofaComboIds = pwpSofaByIdx.get(idx) ?? null;
    return recomputeFromSnapshot(draft, product, fabric, cachedConfig, cachedCombos, sofaModulePrices, sellingTiers, cachedFabricAddonConfig, pwpBaseSen, pwpSofaComboIds, cachedSpecialAddons, sofaModuleCostRows, cachedModelOverrides, cachedCompartmentOverrides, erpLineTrust(createPosTablet, Number(it.unitPriceSen ?? 0), it.zeroPriceIntended, false));
  }));
  /* Commander 2026-05-29 (system-wide) — the SELLING unit price is now
     operator-authored on every SO line. The product price tables are COST,
     so there is no server-computed selling figure to enforce a combo floor /
     ceiling against. The former combo selling-price override (which replaced
     the line's selling price with a cheaper whole-build combo total, or
     clamped/rejected an out-of-band client price) is therefore retired — it
     would clobber or reject the operator's manual selling price. The COST
     path (computeMfgLineCost → unit_cost_sen / line_cost_sen /
     line_margin_sen) is untouched; combos never fed it.

     Combos DO feed the COST side now (Commander 2026-05-29): recomputeTotals
     applies the master sofa-combo price to a matched sofa set's cost. They are
     still NOT applied to the operator's manual SELLING price here.
     `extractSofaComboLookupArgs` is retained for the POS handover path. */
  void extractSofaComboLookupArgs;

  /* Pricing trust boundary (Owner 2026-05-31, see isPosTabletCaller). Only the
     untrusted POS tablet roles are drift-rejected; a Backend / office author
     sets the selling price freely (the owner ruled it varies per order). */
  const posTablet = await isPosTabletCaller(c);
  if (posTablet) {
    for (let i = 0; i < recomputes.length; i++) {
      const r = recomputes[i];
      if (r && r.drift && !freeItemByIdx.has(i)) {
        await rollbackPwpClaims();  // don't burn a voucher on a rejected order
        return c.json({
          error:    'pricing_drift',
          reason:   'The price for this item is out of date — please refresh and try again.',
          lineIdx:  i,
          itemCode: r.itemCode,
          client:   Number(items[i]?.unitPriceSen ?? 0),
          server:   r.unit_price_sen,
          breakdown: r.breakdown,
        }, 400);
      }
    }
  }
  /* Audit 2026-06-11 C-2 — discountSen is client-authored and was NOT covered
     by the drift gate: a tampered POS could submit the correct catalog unit
     price (passing drift) then zero the line out with an arbitrary discount —
     or inflate the total with a negative one. Reject any discount outside
     [0, qty × unit] on every line (422, reject-don't-normalize). */
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const r = recomputes[i];
    const qtyI = Number(it.qty ?? 1);
    const unitI = freeItemByIdx.has(i) ? 0 : (r ? r.unit_price_sen : Number(it.unitPriceSen ?? 0));
    const discI = Number(it.discountSen ?? 0);
    if (!Number.isFinite(discI) || discI < 0 || discI > qtyI * unitI) {
      await rollbackPwpClaims();  // don't burn a voucher on a rejected order
      return c.json({
        error:    'invalid_discount',
        reason:   'discountSen must be between 0 and qty × unit price.',
        lineIdx:  i,
        itemCode: String(it.itemCode ?? ''),
        discount: discI,
        max:      qtyI * unitI,
      }, 422);
    }
  }
  /* Commander 2026-05-31 — per-line ship-from warehouse default; editable per
     line via it.warehouseId. Owner 2026-08-25: Location, then State, then the
     creating OPERATOR'S OWN STORE when the order is otherwise locationless
     (2990-SO-2608-045, docs/bugs/0541) — decision in lib/so-warehouse.ts
     chooseCreateWarehouseDefault, reads in lib/so-create-warehouse-default.ts. */
  const createWhDefaults = await resolveCreateWarehouseDefaults({
    sb,
    scope: <Q,>(q: Q): Q => scopeToCompany(q, c),
    bodySalesLocation: body.salesLocation,
    stateWarehouseIdOf: () => deriveWarehouseIdFromState(
      sb, (body.customerState as string | null | undefined) ?? null, c),
    callerStaff,
  });
  const defaultWarehouseId = createWhDefaults.defaultWarehouseId;

  /* Task 5 — one-shot SKU mint accumulator. When pos_remark_extra_auto_sku is
     ON and a line declares an extra add-on charge, we collect a mint request per
     affected SO line (one per sofa module; one for non-sofa) here, then resolve
     collision-free codes + insert the inactive mfg_products rows after the build
     pass. The line rows are mutated in place to point at the minted codes. */
  const oneShotReqs: OneShotMintReq[] = [];
  /* PWP trigger re-stamp source (Loo 2026-06-12, SO-2606-008) — the first
     BOOKED row per POS cart line. A sofa build's payload itemCode is the POS
     ANCHOR SKU (the catalog card's mfg row), which the per-module split never
     books onto the document — so the re-stamp below must read the lead MODULE
     row instead of the raw payload. Row OBJECT references on purpose: the
     one-shot mint pass rewrites item_code in place, and the reference keeps
     the map pointing at the final booked SKU. */
  const pwpLeadRowByCartKey = new Map<string, { item_code?: unknown }>();
  const extraRMof = (it: { variants?: unknown }) =>
    Math.max(0, Math.round(Number((it.variants as { extraAddonAmountRM?: unknown } | null)?.extraAddonAmountRM ?? 0)));
  const remarkTextOf = (it: { variants?: unknown }) => {
    const r = (it.variants as { remark?: unknown } | null)?.remark;
    return typeof r === 'string' ? r.trim() : '';
  };
  const catOf = (g: string): 'SOFA' | 'BEDFRAME' | 'MATTRESS' | 'ACCESSORY' =>
    g.includes('sofa') ? 'SOFA' : g.includes('bedframe') ? 'BEDFRAME' : g.includes('mattress') ? 'MATTRESS' : 'ACCESSORY';

  /* Size-variant description guard (2026-08-03) — a mattress/bedframe line
     whose description is verbatim ANOTHER size's SKU name is corrected to the
     booked SKU's own name. See lib/size-variant-description for the failure it
     exists for (2990-PO-2608-005 printed King dimensions on Queen/Single/
     Super-single lines) and why the rule is this narrow. */
  const sizeSkuMap = await loadSizeSkuMap(sb, items.map((it) => String(it.itemCode ?? '')), c);

  /* Task #114 — snapshot unit cost from mfg_products when client didn't.
     Build itemRows sequentially with Promise.all so the cost lookup runs
     in parallel across lines but each row still has its own awaited cost. */
  const itemRows = await Promise.all(items.map(async (it, idx) => {
    const qty = Number(it.qty ?? 1);
    const recomputed = recomputes[idx] ?? null;
    /* The server-computed selling price (the bound price-list figure) is always
       persisted — the Backend is costing-only and sends no real selling price,
       so we carry the catalog price out instead of the client's junk value.
       POS-tablet drift is rejected above; Backend drift is accepted silently. */
    // Free Item Campaign (mig 0176): a validated free-item line is forced to 0
    // (server-validated above), which zeroes the non-sofa row AND, via
    // buildUnitPriceSen below, every sofa module row of the build.
    const unit = freeItemByIdx.has(idx)
      ? 0
      : (recomputed ? recomputed.unit_price_sen : Number(it.unitPriceSen ?? 0));
    const discount = Number(it.discountSen ?? 0);
    /* senOrZero at the DEFINITION, not just at the accumulator: lineTotal also
       lands on the persisted row (total_sen / total_inc_sen / balance_sen)
       and feeds the per-category buckets, so guarding only the roll-up would
       still write a non-finite figure onto the line itself. */
    const lineTotal = senOrZero((qty * unit) - discount);
    // Commander 2026-05-28 — the server-computed cost (base + Σ backend
    // priceSen surcharges via computeMfgLineCost) is the source of truth.
    // Fall back to mfg_products.cost_price_sen / explicit client cost only
    // when the recompute didn't produce a cost (e.g. product not found).
    const itemCode = String(it.itemCode ?? '');
    const unitCost = senOrZero(
      recomputed && recomputed.unit_cost_sen > 0
        ? recomputed.unit_cost_sen
        : await snapshotUnitCostSen(sb, itemCode, Number(it.unitCostSen ?? 0), c),
    );
    const lineCost = senOrZero(unitCost * qty);
    const group = String(it.itemGroup ?? '').toLowerCase();
    /* lineTotal / lineCost are senOrZero'd above. recomputeTotals (the
       re-derive path) has always folded with `it.total_sen || 0` /
       `it.line_cost_sen || 0`, so a stray non-finite there collapses to 0;
       this CREATE path folded raw — the one totals accumulator in the file with
       no guard. The two are now in lockstep: one non-finite line must never
       decide the whole header. */
    total += lineTotal;
    totalCost += lineCost;
    if (group.includes('mattress') || group.includes('sofa')) {
      mattressSofa += lineTotal;
      mattressSofaCost += lineCost;
    } else if (group.includes('bedframe')) {
      bedframe += lineTotal;
      bedframeCost += lineCost;
    } else if (group.includes('accessor')) {
      accessories += lineTotal;
      accessoriesCost += lineCost;
    } else {
      others += lineTotal;
      othersCost += lineCost;
    }
    /* Task 5 — the per-line declared extra add-on (whole RM), only honoured when
       the auto-SKU flag is ON. Drives whether this line mints a one-shot SKU. */
    const extraRM = autoSkuEnabled ? extraRMof(it) : 0;
    /* PR-E — a sent lineDeliveryDate wins (overridden=true unless explicitly
       false), else inherit the header date. "" is stored as NULL, not "". */
    const hasExplicitLineDate = it.lineDeliveryDate !== undefined && it.lineDeliveryDate !== null;
    const lineDeliveryDate = hasExplicitLineDate
      ? (it.lineDeliveryDate as string | null)
      : headerDeliveryDate;
    const lineDeliveryDateOverridden = hasExplicitLineDate
      ? (it.lineDeliveryDateOverridden === undefined ? true : Boolean(it.lineDeliveryDateOverridden))
      : Boolean(it.lineDeliveryDateOverridden ?? false);
    const baseRow = {
      line_date: dateOrNull(it.lineDate) ?? todayMyt(),
      debtor_code: (body.debtorCode as string) ?? null,
      debtor_name: body.debtorName,
      agent: agentToStamp,
      item_group: (productRowByCode.get(String(it.itemCode ?? '').trim())?.category ?? '').trim().toLowerCase() || String(it.itemGroup ?? '').trim() || 'others', // SKU wins — lib/sku-category.ts, docs/bugs/0514
      item_code: it.itemCode,
      description: correctedSizeDescription(itemCode, it.description as string | null, sizeSkuMap)
        ?? ((it.description as string) ?? null),
      /* Commander 2026-05-28 — "Description 2" is the auto-combined variant
         summary (the long attribute string). Server-generated from the line's
         variants so it stays the single source of truth. */
      description2: buildVariantSummary((productRowByCode.get(String(it.itemCode ?? '').trim())?.category ?? '').trim().toLowerCase() || String(it.itemGroup ?? '').trim() || 'others', (it.variants as Record<string, unknown> | null) ?? null) || null,
      /* Spec 2026-06-06 — per-line operator remark from the POS product page.
         Same column SoLineCard edits (mfg_sales_order_items.remark). */
      remark: (() => {
        const r = (it.variants as { remark?: unknown } | null)?.remark;
        return typeof r === 'string' && r.trim() !== '' ? r.trim() : null;
      })(),
      uom: (it.uom as string) ?? 'UNIT',
      qty,
      unit_price_sen: unit,
      discount_sen: discount,
      total_sen: lineTotal,
      total_inc_sen: lineTotal,
      balance_sen: lineTotal,
      /* Variants-vocabulary unification (port of 2990 73aeeb1e) — canonicalize
         at the LAST step before the DB write. Every depth-keyed read
         (recompute, split, fabricCode/fabricId loads) above ran on the raw
         `it.variants`, so a POS-created sofa line ends up stored with the
         canonical Backend keys (seatHeight/legHeight/fabricCode) and the read
         seams in DO/SI/PO/GRN/PI/PR editors never render blank dropdowns. */
      variants: canonicalizeVariants(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null),
      unit_cost_sen: unitCost,
      line_cost_sen: lineCost,
      line_margin_sen: lineTotal - lineCost,
      // MFG-PRICING-ENGINE — Persist the line-level breakdown columns from
      // the server recompute so the SO detail page + cost reports show the
      // canonical surcharge mix without re-deriving from the variants blob.
      divan_price_sen:         recomputed?.divan_price_sen ?? 0,
      leg_price_sen:           recomputed?.leg_price_sen ?? 0,
      special_order_price_sen: recomputed?.special_order_sen ?? 0,
      custom_specials:         recomputed?.custom_specials ?? null,
      line_delivery_date: dateOrNull(lineDeliveryDate),
      line_delivery_date_overridden: lineDeliveryDateOverridden,
      // Commander 2026-05-31 — per-line ship-from warehouse (migration 0118).
      // Explicit per-line override wins; else the SO state's default.
      warehouse_id: (it.warehouseId as string | null | undefined) ?? defaultWarehouseId,
      /* SO-SKU spec P5 (§4.5) — per-line snapshots so the Detail Listing's
         Branding / Venue columns light without joins: branding from the SKU's
         catalog row (mainly MATTRESS brands — already loaded, zero extra
         queries), venue from the resolved header name (mirrors the add-line
         path, which snapshots header.venue/branding). */
      branding: lineProducts[idx]?.branding ?? null,
      venue: resolvedVenueName,
      /* SO-SKU spec P2 — explicit (= the column default). Service rows appended
         below start READY; PostgREST bulk inserts null-fill missing keys
         instead of applying column defaults, so every row spells it out. */
      stock_status: 'PENDING',
    };

    /* ── SO-SKU spec P3 (§4.3 + D3) — a POS sofa BUILD becomes one SO line per
       compartment module SKU (the Backend hand-opened SO-2606-018 shape). The
       money is settled ABOVE this point: `unit` is the authoritative per-build
       selling price (combo / PWP / fabric-tier folded in by the recompute, the
       drift gate already passed on it). Splitting only decomposes it — each
       line gets its module-sell-price share, residue on the last line, so
       Σ line totals === build total exactly. Shared variants ride every line
       (the per-line variant-rule gate keeps passing); the cells array is
       replaced by per-line buildKey/cellIndex/x/y/rot so DO picking, returns
       and previews can regroup the set. Breakdown columns + custom_specials
       stay on the FIRST line only — they are build-level report figures and
       duplicating them ×N would double-display in SO Details. Non-splittable
       payloads (no cells / unknown base model) keep the legacy single line. */
    if (group === 'sofa') {
      const product = lineProducts[idx] ?? null;
      const modulePrices = sofaModulePricesByIdx.get(idx) ?? null;
      if (!modulePrices && product?.base_model) {
        // Catalog gap — split degrades to an equal-price split. Surface it so
        // ops can fix the Model's module SKU prices instead of silently
        // booking approximate per-line figures (Σ stays exact regardless).
        // eslint-disable-next-line no-console
        console.warn(`[so-create] no module prices for ${product.base_model} — sofa split uses equal weights`);
      }
      const split = splitSofaBuildIntoModuleLines({
        baseModel: product?.base_model ?? null,
        cells: (it.variants as { cells?: unknown } | null)?.cells,
        buildUnitPriceSen: unit,
        buildUnitCostSen: unitCost,
        modulePrices,
        // Task 5 (D4) — when this line mints one-shot SKUs (extra charge), the
        // selling price is split EVENLY across modules; cost stays proportional.
        evenSplitPrice: extraRM > 0,
        // Left-to-right walk (Loo 2026-06-12) sizes footprints at the build's
        // real seat depth so adjacency matches the canvas the cells came from.
        depth: String((it.variants as { depth?: unknown } | null)?.depth ?? '24'),
      });
      if (split && split.length > 0) {
        const buildKey = `build-${idx + 1}`;
        /* Variants-vocabulary unification (port of 2990 73aeeb1e) —
           canonicalize BEFORE deriving the split's shared variants so every
           module row stores seatHeight/legHeight/fabricCode. Safe: the split's
           own depth read above ran on the raw `it.variants`, so dropping the
           `depth` alias here does NOT change the geometry. */
        const { cells: _cells, ...sharedVariants } =
          canonicalizeVariants('sofa', (it.variants as Record<string, unknown> | null) ?? {});
        /* SPREAD THE DISCOUNT ACROSS THE MODULES, never dump it on module 0.
           The discount is validated against the WHOLE BUILD's unit price, but
           module 0 carries only its share, so a build-level discount larger than
           that share made the row total NEGATIVE (senOrZero passes negatives
           through) — and every downstream document clamps with
           Math.max(0, ...), so the discount was silently DELETED and the order
           invoiced for MORE than it was sold. The item PATCH below already
           refuses such a row, so it could be created but not edited.

           distributeBuildDiscount is exact (residue on the last line) and each
           share is `discount * unit_i / SUM(unit)`, so with the gate above
           (`discount <= qty * SUM(unit)`) every share is <= `qty * unit_i`, the
           invariant that PATCH enforces. The header total is computed BEFORE the
           split, so it is unchanged. */
        const moduleDiscounts = distributeBuildDiscount(discount, qty, split.map((s) => Number(s.unitPriceSen) || 0));
        const moduleRows = split.map((s, i) => {
          const moduleVariants: Record<string, unknown> = {
            ...sharedVariants,
            buildKey,
            cellIndex: s.cellIndex,
            x: s.x,
            y: s.y,
            rot: s.rot,
          };
          const moduleLineTotal = senOrZero((qty * s.unitPriceSen) - (moduleDiscounts[i] ?? 0));
          const moduleLineCost = senOrZero(qty * s.unitCostSen);
          const row = {
            ...baseRow,
            item_code: s.itemCode,
            description: s.description,
            description2: buildVariantSummary('sofa', moduleVariants) || null,
            unit_price_sen: s.unitPriceSen,
            discount_sen: moduleDiscounts[i] ?? 0,
            total_sen: moduleLineTotal,
            total_inc_sen: moduleLineTotal,
            balance_sen: moduleLineTotal,
            variants: moduleVariants,
            unit_cost_sen: s.unitCostSen,
            line_cost_sen: moduleLineCost,
            line_margin_sen: moduleLineTotal - moduleLineCost,
            divan_price_sen:         i === 0 ? (recomputed?.divan_price_sen ?? 0) : 0,
            leg_price_sen:           i === 0 ? (recomputed?.leg_price_sen ?? 0) : 0,
            special_order_price_sen: i === 0 ? (recomputed?.special_order_sen ?? 0) : 0,
            /* Loo 2026-06-13 — custom_specials is the DISPLAY composition of the
               line's specials (incl. the POS special add-on note), NOT a money
               figure: the money lives in unit_price_sen (split across modules)
               + the i===0 breakdown columns above. So, like the remark below, it
               rides EVERY module line of a split sofa — each row of the internal
               Detail Listing then shows the same specials, matching the per-module
               SoLineCard editor and the every-line description2. The customer
               print folds the build into one line and never reads custom_specials,
               so this can't double on the invoice. */
            custom_specials:         recomputed?.custom_specials ?? null,
            /* Loo 2026-06-09 — the operator remark rides EVERY compartment line
               of the sofa, not just the first. One sofa = one remark, so each
               piece (and its printed SO line) carries the same note. Unlike the
               i===0 breakdown columns above, the remark is not a build-level money
               figure, so duplicating it across the set is not double-counting. */
            remark: baseRow.remark,
          };
          /* Task 5 — mint a one-shot SKU per module when an extra charge was
             declared. The minted sell price = this module's catalog base + its
             EVEN share of the extra (N = module count); the SO line is rewritten
             to point at the minted code by buildOneShotMints later. */
          if (extraRM > 0 && product?.base_model) {
            const remarkText = remarkTextOf(it);
            const n = split.length;
            const baseSell = modulePrices?.[s.moduleCode] ?? 0;
            const brand = (product as { branding?: string | null }).branding ?? null;
            oneShotReqs.push({
              row,
              category: 'SOFA',
              modelCode: product.base_model,
              baseSkuCode: s.itemCode,
              baseName: (brand ? `${String(brand).toUpperCase()} ` : '') + s.description,
              modelId: (product as { model_id?: string | null }).model_id ?? null,
              branding: brand,
              compartment: s.moduleCode,
              remarkText,
              sellPriceSen: baseSell + Math.round((extraRM * 100) / n),
            });
          }
          return row;
        });
        {
          const pwpKey = String((it as { cartLineKey?: string }).cartLineKey ?? '');
          if (pwpKey && moduleRows[0] && !pwpLeadRowByCartKey.has(pwpKey)) {
            pwpLeadRowByCartKey.set(pwpKey, moduleRows[0]);
          }
        }
        return moduleRows;
      }
    }
    /* Task 5 — non-sofa (or non-splittable) line: mint a single one-shot SKU
       when an extra charge was declared. unit_price_sen already carries the
       D9 list price (base + extra, N=1) from the recompute, so reuse it as the
       minted SKU's sell price. */
    if (extraRM > 0 && lineProducts[idx]) {
      const product = lineProducts[idx]!;
      oneShotReqs.push({
        row: baseRow,
        category: catOf(group),
        modelCode: (product as { base_model?: string | null }).base_model ?? '',
        baseSkuCode: String((product as { code?: string }).code ?? baseRow.item_code),
        baseName: String((product as { name?: string }).name ?? baseRow.description ?? baseRow.item_code),
        modelId: (product as { model_id?: string | null }).model_id ?? null,
        branding: (product as { branding?: string | null }).branding ?? null,
        compartment: '',
        remarkText: remarkTextOf(it),
        sellPriceSen: Number(baseRow.unit_price_sen ?? 0), // base + extra (N=1)
      });
    }
    {
      const pwpKey = String((it as { cartLineKey?: string }).cartLineKey ?? '');
      if (pwpKey && !pwpLeadRowByCartKey.has(pwpKey)) pwpLeadRowByCartKey.set(pwpKey, baseRow);
    }
    return [baseRow];
  })).then((rows) =>
    /* Priority lines (Loo 2026-06-12): persist mains (sofa/mattress/bedframe)
       ahead of accessories/others. Stable, so the cart order survives within a
       rank and a split build's module rows stay contiguous (same item_group).
       SERVICE rows are pushed after this array and stay last either way. */
    sortSoLinesByGroupRank(rows.flat(), (r) => r.item_group as string | null | undefined));

  const margin = total - totalCost;
  const marginPctBasis = total > 0 ? Math.round((margin / total) * 10000) : 0;

  /* ── Delivery fee (migration 0133) — POS handover path only ──────────────
     Activates the dormant delivery fee on the LIVE SO. Gated on the explicit
     applyDeliveryFee flag the POS handover sends, so backend-authored SOs are
     untouched (delivery_fee_sen stays 0). Fully server-recomputed via the
     pure computeSoDeliveryFee — the only client value trusted is the free-form
     additionalDeliveryFee (clamped >= 0). Categories are the cart's distinct
     DELIVERABLE item_groups (sofa/mattress/bedframe); accessories/others don't
     trip cross-category. delivery_fee_config is whole-MYR, the SO ledger is
     sen, so the config is scaled ×100 before the pure call. The result folds
     into the grand totals + margin like the fabric-tier add-on; the per-
     category revenue buckets stay goods-only. (Phase 1 special-model fees +
     Phase 2 cross-order follow-up plug into the same call.) */
  let deliveryFeeSen = 0;
  let deliveryFee: SoDeliveryFeeResult | null = null;
  let crossCategorySourceDocNo: string | null = null;
  if (body.applyDeliveryFee) {
    // SoCreateContext is not a Hono Context (see metaQ note above) — add the
    // company predicate from the local companyId so the non-owning company
    // reads its own delivery_fee_config, not the base company's row.
    // Key by company_id (2990's row is id=100001, not 1); fall back to id=1 only
    // when the company is unresolved (single-company/cold-start).
    let dcfgQ = sb.from('delivery_fee_config').select('base_fee, cross_category_fee');
    if (companyId != null) dcfgQ = dcfgQ.eq('company_id', companyId);
    else dcfgQ = dcfgQ.eq('id', 1);
    const { data: dcfg } = await dcfgQ.single();
    const DELIVERABLE = new Set(['sofa', 'mattress', 'bedframe']);
    const categoryIds = items
      .map((it) => String((it as { itemGroup?: string }).itemGroup ?? '').toLowerCase())
      .filter((g) => DELIVERABLE.has(g));
    const additionalSen = Math.max(0, Math.round(Number(body.additionalDeliveryFee ?? 0) * 100));
    // delivery_fee_config + special fees are whole-MYR; the SO ledger is sen → ×100.
    const cfgSen = {
      baseFee:          Number((dcfg as { base_fee?: number } | null)?.base_fee ?? 0) * 100,
      crossCategoryFee: Number((dcfg as { cross_category_fee?: number } | null)?.cross_category_fee ?? 0) * 100,
    };

    /* Phase 1 — special delivery fee rules (migration 0024). Generalises the old
       model-only model_special_delivery_fees lookup onto the #691 RuleTarget
       abstraction: any cart line a rule's target covers (model | variant |
       compartment | combo) contributes a special fee; computeSoDeliveryFee folds
       in the highest standalone (overriding base) + the cross-followup. Lines are
       flattened to RuleLineInput[] and matched by the SAME shared matcher the POS
       runs — no drift. Free-item lines are skipped (a free giveaway carries no
       special transport fee). */
    const comboModulesById = new Map<string, string[][]>(
      cachedCombos.map((cb) => [cb.id, cb.modules]),
    );
    const deliveryRuleLines: RuleLineInput[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      if (freeItemByIdx.has(idx)) continue;
      const product = lineProducts[idx] ?? null;
      if (!product) continue;
      const variants = (items[idx]?.variants as Record<string, unknown> | null) ?? null;
      const cells = (variants?.cells as Array<{ moduleId?: unknown }> | undefined) ?? [];
      const built = Array.isArray(cells)
        ? cells.map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
        : [];
      deliveryRuleLines.push({
        category: String((product as { category?: string | null }).category ?? ''),
        modelId: (product as { model_id?: string | null }).model_id ?? null,
        sizeCode: (product as { size_code?: string | null }).size_code
          ? String((product as { size_code?: string | null }).size_code).toUpperCase()
          : null,
        builtCompartments: built,
      });
    }
    const specialModels = await specialDeliveryFeesForLines(sb, deliveryRuleLines, comboModulesById);

    /* Phase 2 — cross-order link. Sales typed the earlier SO's doc_no at
       handover. Validate it (exists, not cancelled, same customer by phone
       when both have one, not already used), then this SO charges only the
       reduced cross / special-cross rate. A 400 here rolls back any PWP claim
       so a voucher isn't burned on a rejected order. The unique index on
       cross_category_source_doc_no is the hard anti-double-dip backstop. */
    let isCrossCategoryFollowup = false;
    const rawLink = String((body.crossCategorySourceDocNo as string | undefined) ?? '').trim();
    if (rawLink) {
      const elig = await checkCrossCategorySource(
        c, sb, rawLink, typeof body.phone === 'string' ? body.phone : null, orderCustomerId,
      );
      if (!elig.eligible) {
        await rollbackPwpClaims();  // don't burn a voucher on a rejected order
        return c.json({ error: 'cross_category_link_invalid', reason: crossCatReasonText(rawLink, elig.reason) }, 400);
      }
      crossCategorySourceDocNo = rawLink;
      isCrossCategoryFollowup = true;
    }

    deliveryFee = computeSoDeliveryFee(
      { categoryIds, specialModels, isCrossCategoryFollowup, additionalFee: additionalSen },
      cfgSen,
    );
    deliveryFeeSen = deliveryFee.total;
  }

  /* ── SO-SKU spec P2 (§4.1 + §4.2, D2/D6/D9 final) — every charge is a SKU
     line. The delivery fee just computed decomposes into SVC-DELIVERY* lines
     (Σ lines === deliveryFeeSen always); POS handover add-ons (dispose /
     lift) are re-priced server-side from the addons table — the client's
     amounts are never trusted — and become SVC-DISPOSE-* / SVC-LIFT-CARRY
     lines. The header delivery_fee_sen keeps being written (dual-write
     transition; recomputeTotals only folds it back in when NO fee lines
     exist, so nothing double-counts). Lines ride the whole SO→DO→SI chain;
     they are not goods — P1 guards keep them out of allocation / inventory /
     MRP / returns, and stock_status starts READY so the stock remark never
     shows a phantom PENDING service. */
  const feeServiceSpecs = deliveryFee
    ? buildDeliveryFeeServiceLines(deliveryFee, crossCategorySourceDocNo)
    : [];
  let addonServiceSpecs: ServiceLineSpec[] = [];
  const addonSelections: AddonSelectionInput[] = Array.isArray(body.addons)
    ? (body.addons as Array<Record<string, unknown>>)
        .filter((a) => a && typeof a.id === 'string' && (a.id as string).trim())
        .map((a) => ({
          id:          (a.id as string).trim(),
          qty:         typeof a.qty === 'number' ? a.qty : undefined,
          floorsCount: typeof a.floorsCount === 'number' ? a.floorsCount : undefined,
          itemsCount:  typeof a.itemsCount === 'number' ? a.itemsCount : undefined,
        }))
    : [];
  if (addonSelections.length > 0) {
    const { data: addonRows } = await sb
      .from('addons')
      .select('id, kind, price, per_floor_item, label, enabled, service_sku')
      .in('id', [...new Set(addonSelections.map((a) => a.id))]);
    addonServiceSpecs = computeAddonServiceLines(
      addonSelections,
      ((addonRows ?? []) as Array<{ id: string; kind: string; price: number; per_floor_item: number | null; label: string | null; enabled: boolean | null; service_sku: string | null }>)
        .map((r) => ({ id: r.id, kind: r.kind, price: Number(r.price ?? 0), perFloorItem: r.per_floor_item, label: r.label, enabled: r.enabled, serviceSku: r.service_sku })),
    );
  }
  const serviceSpecs = [...feeServiceSpecs, ...addonServiceSpecs];
  const serviceSen = serviceSpecs.reduce((s, l) => s + senOrZero(l.totalSen), 0);
  if (serviceSpecs.length > 0) {
    /* Same Edge #4 contract as goods lines: a SERVICE line's SKU must exist in
       the catalog (seeded by migration 0155). A 409 here means the seed is
       missing — fail loudly rather than booking an off-catalog charge. */
    const svcCheck = await validateItemCodes(sb, serviceSpecs.map((s) => s.itemCode), companyId);
    if (!svcCheck.ok) {
      await rollbackPwpClaims();
      return c.json(unknownItemCodeResponse(svcCheck.unknown), 409);
    }
    const lineDateToday = todayMyt();
    for (const spec of serviceSpecs) {
      itemRows.push({
        line_date: lineDateToday,
        debtor_code: (body.debtorCode as string) ?? null,
        debtor_name: customerName,
        agent: agentToStamp,
        item_group: 'service',
        item_code: spec.itemCode,
        description: spec.description,
        description2: null,
        /* Loo 2026-06-10 — the order-specific detail (cross-order source SO,
           lift floors×items math) rides in remark; description stays the
           stable SKU wording so the line reads as the catalog service. */
        remark: spec.remark ?? null,
        uom: 'UNIT',
        qty: spec.qty,
        unit_price_sen: spec.unitPriceSen,
        discount_sen: 0,
        total_sen: spec.totalSen,
        total_inc_sen: spec.totalSen,
        balance_sen: spec.totalSen,
        variants: null,
        unit_cost_sen: 0,
        line_cost_sen: 0,
        line_margin_sen: spec.totalSen,
        divan_price_sen: 0,
        leg_price_sen: 0,
        special_order_price_sen: 0,
        custom_specials: null,
        line_delivery_date: headerDeliveryDate,
        line_delivery_date_overridden: false,
        // Services don't ship from a warehouse; NULL keeps them out of every
        // per-warehouse pool (allocation skips them anyway, P1).
        warehouse_id: null,
        /* P5 — key parity with the goods rows (PostgREST null-fills missing
           keys). Services carry no brand; venue mirrors the header. */
        branding: null,
        venue: resolvedVenueName,
        // Not goods — nothing to allocate; READY from birth (spec §4.6).
        stock_status: 'READY',
        /* Variants-vocabulary unification (port of 2990 73aeeb1e) — goods rows
           above now type `variants` as the non-null canonicalizeVariants
           result, so a SERVICE row's null variants needs `unknown` widening. */
      } as unknown as (typeof itemRows)[number]);
    }
  }

  const grandTotal          = total + serviceSen;
  /* Service lines carry zero cost, so the whole serviceSen is margin —
     same treatment the header-only delivery fee got before. */
  const grandMargin         = margin + serviceSen;
  const grandMarginPctBasis = grandTotal > 0 ? Math.round((grandMargin / grandTotal) * 10000) : 0;

  /* SO-SKU spec P3 — Edge #4 for the ASSEMBLED rows. The payload-level gate
     at the top validated what the client sent; the split just minted module
     SKUs (ANNSA-1A(RHF) …) that must ALSO exist in the catalog. A 409 here
     means the Model's module SKU is missing from the SKU Master — fail loudly
     BEFORE the header insert so a rejected order leaves nothing behind. */
  {
    const rowCodes = itemRows.map((r) => (r as { item_code?: string | null }).item_code);
    const rowCheck = await validateItemCodes(sb, rowCodes, companyId);
    if (!rowCheck.ok) {
      await rollbackPwpClaims();
      return c.json(unknownItemCodeResponse(rowCheck.unknown), 409);
    }
  }

  /* Task #121 — derive country from the picked customer_state via the
     localities lookup. Stays null when the state is unknown so we don't
     forge a country the locality table never declared. */
  const customerCountrySnapshot = await deriveCountryFromState(
    sb,
    (body.customerState as string | null | undefined) ?? null,
  );

  /* Commander 2026-05-29 — Location follows the address (State). When the
     caller already sent a salesLocation it wins; otherwise derive it from the
     State so API/import callers get the same warehouse binding the form gives.
     Since 2026-08-25 a locationless order falls back to the operator's STORE
     label — same fallback as the line default, so the two cannot disagree. */
  const derivedSalesLocation =
    createWhDefaults.explicitSalesLocation ??
    (await deriveSalesLocationFromState(
      sb,
      (body.customerState as string | null | undefined) ?? null,
      c,
    )) ??
    createWhDefaults.operatorStoreLabel ?? null;

  /* ── Stock-location gate (owner 2026-08-13, company 1 only) ───────────────
     An order this company writes to AutoCount must resolve a warehouse, or the
     account book refuses the whole document (FK_SODTL_Location) AFTER the
     salesperson has been told it saved — which is exactly how HC-SO-2608-002
     died. Gated on the DERIVED location above, not on the bare presence of a
     State, because an unmapped State derives nothing either; see
     lib/so-location-gate.ts for the two causes and who fixes each.

     DRAFTS ARE EXEMPT, same rule as the confirm gate and for the same reason:
     a draft is the scan job's guess awaiting an operator's verdict and is
     never written to AutoCount. The DRAFT -> live transition (the only OTHER
     place this router enqueues an AutoCount create) carries the same gate, so
     the invariant holds wherever a create is enqueued. */
  if ((body as { asDraft?: unknown }).asDraft !== true) {
    const locationProblem = soLocationProblem({
      companyCode: c.get('companyCode') ?? null,
      salesLocation: derivedSalesLocation,
      customerState: (body.customerState as string | null | undefined) ?? null,
    });
    if (locationProblem) {
      await rollbackPwpClaims();
      return c.json(validationFailedBody([locationProblem]), 422);
    }
  }

  /* Delivery-date requires an address (owner 2026-07-22 — "有 delivery date
     就必须有地址，不然我们怎么知道送去哪里"). Owner-sighting: POS test SO
     2990-SO-2607-019 had customerDeliveryDate set but no address1 / postcode
     / customerState — the SLGR-warehouse-derived Location was empty and the
     coordinator had no place to send the order. The Proceed gate already
     requires address (meetsProceedGate), but CREATE was silently accepting
     an incomplete-address SO whose only way forward was to bounce at Proceed.
     Block it here so the operator has to either fill address OR unset
     delivery_date at handover time. `customerDeliveryDate` empty (address-
     later flow) still passes — nothing to route yet. */
  {
    const dd = (body.customerDeliveryDate as string | null | undefined) ?? null;
    if (dd) {
      const missing: string[] = [];
      if (typeof body.address1 !== 'string' || !body.address1.trim()) missing.push('address line 1');
      if (typeof body.postcode !== 'string' || !body.postcode.trim()) missing.push('postcode');
      if (typeof body.customerState !== 'string' || !body.customerState.trim()) missing.push('state');
      if (missing.length > 0) {
        return c.json({
          error: 'delivery_date_needs_address',
          message: `A delivery date can't be set until the customer's address is filled — missing ${missing.join(', ')}. Either add the address or take off the delivery date.`,
          missing,
        }, 422);
      }
    }
  }

  /* P1 (Owner 2026-06-03, migration 0143) — resolve the POS handover payment
     slip. The POS uploads the slip to R2 first (via /slips/init + confirm) and
     sends us the uploadSessionId; we look up its committed R2 key and attach it
     to the SO so the coordinator can see the payment proof. Best-effort: a
     missing / un-uploaded session just leaves the SO slip-less (slip_state stays
     'none') rather than blocking the order. */
  let slipKey: string | null = null;
  const uploadSessionId = (body.uploadSessionId as string | null | undefined) ?? null;
  if (uploadSessionId) {
    const { data: slipRow } = await sb
      .from('pending_slip_uploads')
      .select('r2_key, status')
      .eq('upload_session_id', uploadSessionId)
      .maybeSingle();
    const sr = slipRow as { r2_key?: string; status?: string } | null;
    if (sr?.r2_key && (sr.status === 'uploaded' || sr.status === 'promoted')) {
      slipKey = sr.r2_key;
    }
  }

  /* Scan-Order receipt as the deposit's Slip (Owner 2026-07-15) — an SO opened
     from a scanned card-terminal receipt carries `receiptImageKey` (the R2 key
     of that receipt photo) but NO handover slip / per-row slip session, so the
     auto-recorded deposit row's slip_key stayed NULL and the receipt only ever
     showed in the separate "Payment Receipt" card — never in the payment row's
     Slip column. Owner: "the payment slip should go directly into my Slip." The
     receipt IS the deposit's proof, so fall it back onto the deposit row's
     slip_key when no explicit slip was attached. Both are R2 keys in the same
     bucket, so /payments/:id/slip-url resolves it. */
  const receiptImageKey = (body.receiptImageKey as string | null | undefined) ?? null;

  /* ── POS split payment (Loo 2026-06-06) — optional `payments[]` on create.
     A handover deposit can now arrive as SEVERAL transactions (e.g. half
     cash + half card). Validated STRICTLY (unlike the tolerant single-deposit
     fallback below, a money row must never be silently dropped) and booked
     atomically with the order: deposit_sen on the header = Σ rows, each row
     lands in mfg_sales_order_payments as an is_deposit row. Absent payments[]
     → the legacy single depositSen/paymentMethod path runs unchanged, so
     old PWA clients keep working.

     Each row's `uploadSessionId` is OPTIONAL (Owner 2026-08-13) — schema and
     rule both live in lib/so-create-payment-slips.ts. */
  let posPayments: SoCreatePayment[] | null = null;
  if (body.payments !== undefined) {
    const parsed = soCreatePaymentsSchema.safeParse(body.payments);
    if (!parsed.success) {
      await rollbackPwpClaims();
      return c.json({ error: 'invalid_payments', issues: parsed.error.issues }, 400);
    }
    posPayments = parsed.data;
  }
  const posPaymentsTotalSen = posPayments
    ? posPayments.reduce((acc, p) => acc + p.amountSen, 0)
    : null;

  /* Resolve each split payment's slip session → R2 key up front, for the rows
     that CLAIM one. A slip-less row resolves to null and books slip-less — the
     slip is optional (Owner 2026-08-13); a slip that is claimed and does not
     resolve still refuses the create. The rule is
     `planCreatePaymentSlips` (so-create-payment-slips.ts); this block is its
     IO. All-or-nothing, BEFORE the header insert (and rolling back PWP
     claims), so no SO is created with half its payment proofs missing. */
  let posPaymentSlipKeys: Array<string | null> | null = null;
  if (posPayments) {
    const sessionIds = claimedSlipSessionIds(posPayments);
    const slipById = new Map<string, { r2_key: string | null; status: string }>();
    // A wholly slip-less create claims nothing, so it pays for no query.
    if (sessionIds.length > 0) {
      const { data: slipRows, error: slipRowsErr } = await sb
        .from('pending_slip_uploads')
        .select('upload_session_id, r2_key, status')
        .in('upload_session_id', sessionIds);
      if (slipRowsErr) {
        await rollbackPwpClaims();
        return c.json({ error: 'lookup_failed', reason: slipRowsErr.message }, 500);
      }
      for (const r of slipRows ?? []) {
        const t = r as { upload_session_id: string; r2_key: string | null; status: string };
        slipById.set(t.upload_session_id, { r2_key: t.r2_key, status: t.status });
      }
    }
    const plan = planCreatePaymentSlips(posPayments, slipById);
    if (!plan.ok) {
      await rollbackPwpClaims();
      return c.json({ error: 'slip_required', reason: plan.reason }, 400);
    }
    posPaymentSlipKeys = plan.slipKeys;
  }

  /* POS auto-Proceed (Loo 2026-06-09) — if this handover already satisfies the
     same gate as the POS "Move to Proceed" button (customer name, a delivery
     address line 1 + postcode, a delivery date, and the company's deposit), the
     order skips Order Placed and lands directly in Proceed. A "Fill in later"
     handover (blank address) fails the gate and stays in Order Placed for the
     salesperson to complete + proceed manually.

     A HANDOVER WITH NO PROCESSING DATE IS NOT PROCEEDED, however complete it is
     (owner, pinned 2026-08-13: *"没有 processing date 就代表没有 proceed"*). This
     used to stamp a separate Proceed marker anyway, minting exactly the order
     the rule says cannot exist: proceeded, released, with no day it was released
     ON. That marker is gone entirely (2026-08-18): the order is simply created
     un-proceeded and gets its Proceed when someone picks a date.

     Read through the shared helper, not a literal. This said
     `body.internalExpectedDd`, a key NO client sends — desktop New SO, both
     mobile surfaces, from-products and this route's own INSERT all send
     `processingDate` — so the create's auto-proceed test was always false and an
     order created WITH a Processing Date was created UN-proceeded, the inverse
     of the owner's pinned rule. An absent property is `undefined`, not an error,
     so nothing said a word. The helper accepts the legacy spelling too. */
  const procDateOnCreate = readSoProcessingDateFromBody(body as Record<string, unknown>);
  /* `depositTotalSen` stood here and is GONE with the deposit gate (owner
     2026-08-20). It was the create's read of the money — the POS deposit, else
     `body.depositSen` — and the gate below was its only reader. The value that
     is actually STORED is computed independently at the INSERT
     (`deposit_sen: posPaymentsTotalSen ?? ...`), so removing this changes what
     the create REFUSES and nothing about what it WRITES. */
  /* `autoProceed` — the boolean that decided whether to stamp `proceeded_at`
     here — is GONE with the stamp (2026-08-18), and with it this file's last
     `meetsProceedGate` call. #2383 had just documented this site as "THE ONE
     meetsProceedGate CALLER THAT CARRIES NO PROBLEM LIST", because it REFUSES
     NOTHING: a handover that missed the gate was simply created un-proceeded for
     the salesperson to complete manually. That is exactly why it can go —
     `autoProceed` could only ever be true when a Processing Date was ALSO being
     written, and the create already refuses (422, below) to write that date
     unless the same conditions pass. "Proceeded at create" is now the date
     landing on the row, and the 422 block below is the gate that refuses. */

  /* Processing-Date gate, post-pricing half — a Processing Date RELEASES the
     order to purchasing (owner 2026-08-18: "Processing Date 就代表这张单可以
     安排订货了，然后过了一天我们才会落下来，然后采购才会去订货"), so the order
     must be one purchasing can actually act on: a customer, a delivery address
     line 1, a postcode and a delivery date.

     It used to be the DEPOSIT gate as well (Loo 2026-06-30 — the company's
     fraction, Houzs 30% / 2990 50%). The owner removed that condition on
     2026-08-20 (「以电脑为准 —— 两边都不查」); see the block below. The block
     stays because the four completeness conditions still need the priced order's
     own header, and it still cannot live in the early gate block above. */
  {
    /* Same helper as the INSERT, or a legacy create writes an unjudged date. */
    const procDateOnCreate = readSoProcessingDateFromBody(body as Record<string, unknown>);
    /* Emits the SAME aggregated `validation_failed` shape as the early gate block
       (owner 2026-07-18) so the client renders every Processing-Date failure the
       same way — this gate simply can't live up there because the order total
       isn't priced until now. Single-problem list here, but consistent shape.
       rollbackPwpClaims first: a rejected order must not burn a voucher (matches
       every other bail in this pricing block). */
    /* NO DEPOSIT CONDITION ON THIS CREATE — owner ruling, 2026-08-20:
       「以电脑为准 —— 两边都不查」.

       What stood here was the money half of the gate plus the machinery that had
       grown around it: a `pendingDepositSen` read, and a `manualEntry` flag the
       desktop New-SO screen set to `true` on EVERY create so the condition would
       be dropped for it. The phone sent no such flag, so the identical order was
       accepted on the desk and refused on the phone — the rule depended on the
       screen, not on the order. Both are gone; the condition itself was removed
       from collectProcessingGateProblems, so this call site cannot re-introduce
       it and neither can the phone's.

       The four remaining conditions still apply on create, unchanged. */
    const pricedGateProblems = procDateOnCreate
      ? collectProcessingGateProblems({
          procDate: procDateOnCreate,
          delivDate: (body.customerDeliveryDate as string | null | undefined) || null,
          todayMY: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),
          /* One rule (owner 2026-07-31: Processing Date IS Proceed), and since
             2026-08-18 one place that applies it on this path. No email. */
          completeness: {
            hasCustomerName: !!customerName?.trim(),
            hasAddress: typeof body.address1 === 'string' && !!body.address1.trim(),
            hasPostcode: typeof body.postcode === 'string' && !!body.postcode.trim(),
          },
        })
      : [];
    if (pricedGateProblems.length > 0) {
      await rollbackPwpClaims();
      return c.json(validationFailedBody(pricedGateProblems), 422);
    }
  }

  /* Doc-no collision retry (HIGH, 2026-07-14): two concurrent same-company SO
     creates in the same YYMM both read the same max and mint the same doc_no;
     without a retry the loser hits the doc_no PK (Postgres 23505) and the whole
     order 500s (customer + payments + PWP all lost). Wrap the header insert in
     insertWithDocNoRetry so a collision re-mints and retries. The FIRST attempt
     reuses the already-minted docNo (PWP claims were reserved against it, with
     rollbackPwpClaims on failure); we only auto-retry when NO PWP claim was made
     (tries=1 keeps today's exact clean-fail+rollback for the rare promo order,
     so a re-mint can never orphan a pwp_codes.redeemed_doc_no). */
  let mintedDocNo = docNo;
  let firstMint = true;
  const { error: hErr } = await insertWithDocNoRetry(
    async () => {
      if (firstMint) { firstMint = false; return mintedDocNo; }
      mintedDocNo = await nextDocNo(sb, c);
      return mintedDocNo;
    },
    (dn) => sb.from('mfg_sales_orders').insert({
    company_id: companyId, // multi-company: stamp the active company
    doc_no: dn,
    transfer_to: (body.transferTo as string) ?? null,
    so_date: dateOrNull(body.soDate) ?? todayMyt(),
    branding: (body.branding as string) ?? null,
    debtor_code: (body.debtorCode ?? body.customerCode as string) ?? null,
    debtor_name: customerName,
    agent: agentToStamp,
    sales_location: derivedSalesLocation ?? null,
    ref: (body.ref as string) ?? null,
    /* SO-SKU spec P5 — the resolved venue NAME (explicit body.venue wins,
       else looked up from the stamped venue_id) so the column finally lights. */
    venue: resolvedVenueName,
    /* Migration 0148 — HOW the venue above got here: 'MANUAL' (a human picked
       or accepted it on the form), 'PMS' (an in-period exhibition project) or
       'SHOWROOM' (the rep's parked showroom). This is what protects the human's
       choice: canAutoResolveVenue() refuses to let any later automatic
       re-resolve overwrite a MANUAL venue. The binding is a DEFAULT, not a
       lock — the operator is the person who actually knows where they are
       standing, and their pick is the backstop for both mechanisms. */
    venue_source: venueSource,
    /* Migration 0086 — venue master FK (separate from legacy `venue` text).
       Guarded to a real uuid; project_venues integer ids are nulled (the venue
       TEXT carries the value). See the venueIdUuid guard above. */
    venue_id: venueIdUuid,
    /* Fair Report FOUNDATION (migration 0146) — the active fair this SO belongs
       to, resolved above via the active-fair resolver. NULL when the salesperson
       has no active fair; never blocks creation. */
    project_id: projectIdToStamp,
    address1: (body.address1 as string) ?? null,
    address2: (body.address2 as string) ?? null,
    address3: (body.address3 as string) ?? null,
    address4: (body.address4 as string) ?? null,
    /* Task #91 — defensively normalize to E.164 storage form. The UI does this
       on blur via <PhoneInput>, but a misbehaving client could still POST a
       raw "+60 12 345 6789" — normalize once on the server so the DB never
       holds a half-typed format. Falls back to the raw value if normalize
       returns null (e.g. non-MY international numbers we don't recognise). */
    phone: normPhone,
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    // Task #114 — per-category cost (migration 0079).
    mattress_sofa_cost_sen: mattressSofaCost,
    bedframe_cost_sen:      bedframeCost,
    accessories_cost_sen:   accessoriesCost,
    others_cost_sen:        othersCost,
    /* SO-SKU spec P2 (D1, migration 0155) — SERVICE bucket = fee + addon
       lines (cost 0). Keeps Finance's "Others" goods-only. */
    service_sen: serviceSen,
    service_cost_sen: 0,
    local_total_sen: grandTotal,
    balance_sen: grandTotal,
    total_cost_sen: totalCost,
    total_revenue_sen: grandTotal,
    total_margin_sen: grandMargin,
    margin_pct_basis: grandMarginPctBasis,
    // Delivery fee snapshot (migration 0133) — DUAL-WRITE transition (P2):
    // still written for view/report back-compat, but recomputeTotals now folds
    // it in ONLY when no SVC-DELIVERY* lines exist (they are the new truth).
    delivery_fee_sen: deliveryFeeSen,
    // Cross-category follow-up link (migration 0141) — null unless sales linked
    // this SO back to an earlier one for the reduced delivery rate.
    cross_category_source_doc_no: crossCategorySourceDocNo,
    // P3 — itemRows now carries split sofa module lines + SERVICE lines;
    // its length IS the line count (recomputeTotals re-derives it anyway).
    line_count: itemRows.length,
    currency: ((body.currency as string) ?? 'MYR').toUpperCase(),
    note: (body.note as string) ?? null,
    /* PR #46 — POS handover fields written at create */
    email: (body.email as string) ?? null,
    customer_type: (body.customerType as string) ?? null,
    salesperson_id: salespersonIdToStamp,
    city: (body.city as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    building_type: (body.buildingType as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    /* Task #91 — also normalize the emergency contact phone. */
    emergency_contact_phone: typeof body.emergencyContactPhone === 'string'
      ? (normalizePhone(body.emergencyContactPhone) ?? body.emergencyContactPhone)
      : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    /* NOT DEAD — measured on prod 2026-08-18, and the census that called it dead
       was wrong. `probe-rename-preconditions.mjs` section F: 46 of 2826 SO rows
       carry a target_date and ALL 46 were CREATED inside the last 90 days, the
       newest 6.75 days ago. No client in THIS repo sends the key (`grep -rn
       targetDate frontend/src native e2e` = 0 hits), so the producer is the POS
       handover, outside this deploy — and `routes/reports.ts` selects the column
       into the sales-report export, so it has a live reader too.

       A sweep removed this line on 2026-08-18 and put it back the same day: with
       the door shut the POS keeps POSTing `targetDate`, the create returns 201,
       and the value is silently dropped — the exact failure class the
       Processing-Date work exists to end. Do not remove it again without a fresh
       section-F run showing zero rows BORN with one. */
    target_date: dateOrNull(body.targetDate),
    customer_id: orderCustomerId,
    /* Mig 0175 — canonicalize MY state at write so 'PENANG' / 'Kl' / 'W.P.
       Kuala Lumpur' land as the exact my_localities spelling. Foreign state
       names (China, SG) round-trip unchanged. */
    customer_state: canonicalizeMyState((body.customerState as string | null | undefined) ?? null),
    /* Task #121 — country snapshot auto-derived above. */
    customer_country: customerCountrySnapshot,
    /* Cutover #14 (mig 0158) — POS marketing demographics captured ON the SO,
       hidden (never surfaced on SO/PDF/UI). 2990 kept these on the customers
       table; owner ruled they slot onto the SO here. Capture-only at create. */
    customer_race: (body.customerRace as string) ?? null,
    customer_birthday: dateOrNull(body.customerBirthday),
    customer_gender: (body.customerGender as string) ?? null,
    customer_delivery_date: dateOrNull(body.customerDeliveryDate),
    /* PR #144 — Commander: "当我已经 create 好了这个 sales order 的时候，
       为什么我点进去 edit processing 的 delivery date 时，怎么没看到呢".
       processing_date was wired on PATCH (update header) but missed
       on the POST (create) — so the New SO form's Processing Date field
       never persisted; reopening the SO showed an empty field. */
    /* The SAME helper the create gate reads; this said
       `dateOrNull(body.processingDate)`, so a legacy create wrote NO date. */
    processing_date: dateOrNull(procDateOnCreate),
    /* Mig 0053 (port of 2990 0199 + 0201) — amendment carriers. The customer's
       ORIGINAL `customer_delivery_date` above is NEVER overwritten by an
       amend; the customer's REQUESTED-changed date lands here, the date WE
       confirm goes to `amended_delivery_date`, and the free-text "why" goes to
       `amend_reason`. The effective date for Days Left / OVERDUE is
       amended_delivery_date ?? customer_delivery_date. Persisted on CREATE so
       an amend captured at SO entry (e.g. customer asked for a date change
       between quote + sign-off) doesn't get lost waiting for a follow-up PATCH. */
    amend_date_from_customer: dateOrNull(body.amendDateFromCustomer),
    amended_delivery_date: dateOrNull(body.amendedDeliveryDate),
    amend_reason: (body.amendReason as string) ?? null,
    // PR #121 — POS-aligned Order Details fields
    customer_so_no: (body.customerSoNo as string) ?? null,
    hub_id: (body.hubId as string) ?? null,
    hub_name: (body.hubName as string) ?? null,
    /* P1 (Owner 2026-06-03) — billing address from the POS handover, sent only
       when it differs from the delivery address. Single text column (already
       persisted on PATCH + shown on the SO detail page); just wire it on create
       so a POS order's separate billing address isn't lost. */
    bill_to_address: (body.billToAddress as string) ?? null,
    /* P1 (Owner 2026-06-03, migration 0142) — POS handover signature data URL. */
    signature_b64: (body.signatureB64 as string) ?? null,
    /* P1 (Owner 2026-06-03, migration 0143) — POS handover payment slip (R2 key
       resolved above). slip_state → 'pending' (coordinator to check) when a slip
       is attached; left at the column default 'none' otherwise. */
    slip_key: slipKey,
    slip_state: slipKey ? 'pending' : 'none',
    /* Original-slip provenance (migration 0033) — the R2 key of the handwritten
       slip photo this SO was scanned from, carried over from the Scan Order
       flow so the SO detail page can show it as "Original Slip" proof. null for
       manually-keyed orders. */
    slip_image_key: (body.slipImageKey as string) ?? null,
    /* Payment-receipt provenance (migration 0034) — the R2 key of the printed
       card-terminal payment receipt this SO was scanned from, carried over from
       the Scan Order flow so the SO detail page can show it as "Payment Receipt"
       proof. null for manually-keyed orders / scans with no receipt photo. */
    receipt_image_key: receiptImageKey,
    /* PR #148 + #150 — Payment fields on create (mirror PATCH handler).
       Lets commander set payment_method + deposit_sen straight from the
       New SO form, including approval_code for merchant transactions. */
    payment_method:     (body.paymentMethod as string) ?? null,
    installment_months: typeof body.installmentMonths === 'number' ? body.installmentMonths : null,
    merchant_provider:  (body.merchantProvider as string) ?? null,
    approval_code:      (body.approvalCode as string) ?? null,
    payment_date:       dateOrNull(body.paymentDate),
    // Clamped ≥ 0 — a negative deposit would deflate the live paid rollup.
    // Split payment (Loo 2026-06-06): with payments[] the deposit IS the sum
    // of the validated rows (each positive by schema), not the legacy field.
    deposit_sen:      posPaymentsTotalSen ?? Math.max(0, typeof body.depositSen === 'number' ? body.depositSen : 0),
    /* SERVER-OWNED — never the client's number. Paid is derived from the
       payments ledger (the view's paid_total_sen); taking body.paidSen here
       let a create book an order as already-paid with zero payment rows. A
       deposit does NOT belong here either: it posts an is_deposit ledger row
       below, which is what the rollups read. Always 0 at birth. */
    paid_sen:         0,
    /* PR #154 — Commander 2026-05-27: "我们的整个系统是没有 Draft 功能的，
       把 Draft 的功能去除掉, 我们 create 的全部都是 confirm 的". 2990 is a
       trading company; we don't need a DRAFT staging step. Every new SO is
       CONFIRMED on insert. The DRAFT enum value still exists for legacy
       row compatibility, but new rows skip it entirely. */
    status: (body as { asDraft?: unknown }).asDraft === true ? 'DRAFT' : 'CONFIRMED',
    created_by: user.id,
    }),
    claimedPwpCodes.length === 0 ? 8 : 1,
  );
  if (hErr) { await rollbackPwpClaims(); return c.json({ error: 'insert_failed', reason: hErr.message }, 500); }
  docNo = mintedDocNo; // committed doc_no — every child insert below keys off it

  /* P1 (migration 0143) — the slip is now owned by this SO, so promote its
     pending row. 'promoted' rows are excluded from the reaper that deletes the
     R2 object for expired 'pending'/'uploaded' uploads (schema.ts slipUpload-
     Status comment). Best-effort — a failed promote never blocks the order. */
  if (slipKey && uploadSessionId) {
    await sb.from('pending_slip_uploads')
      .update({ status: 'promoted', promoted_at: new Date().toISOString() })
      .eq('upload_session_id', uploadSessionId);
  }

  /* ── SO-SKU spec P2 (D5, migration 0155) — the POS deposit becomes a real
     payments-ledger row at create, so Paid / Last Payment / Account Sheet /
     Collected By / Balance derive live instead of sitting dead in the
     deposit_sen header. is_deposit=true marks it so the list paid-rollup
     doesn't ALSO add the header column (double count) and Finance can tell
     deposits from balance payments. Method-scoped fields mirror the manual
     POST /:docNo/payments route. Best-effort: a ledger failure must never
     block the order (the header column still carries the deposit). */
  if (posPayments) {
    /* Split payment — every validated row, best-effort (the header carries Σ; a ledger hiccup never blocks the order). */
    const paidAt = dateOrNull(body.paymentDate) ?? todayMyt(); // header coerces the same key; uncoerced here the swallowed insert lost the deposit row
    for (let i = 0; i < posPayments.length; i++) {
      const p = posPayments[i]!;
      const merchantLike = p.method === 'merchant' || p.method === 'installment';
      const merchantProvider = merchantLike ? (p.merchantProvider ?? null) : null;
      const installmentMonths = merchantLike
        && typeof p.installmentMonths === 'number' && p.installmentMonths > 0
        ? p.installmentMonths : null;
      const { data: depRow, error: depErr } = await sb.from('mfg_sales_order_payments').insert({
        company_id:         companyId, // multi-company: match the SO's company
        so_doc_no:          docNo,
        paid_at:            paidAt,
        method:             p.method,
        merchant_provider:  merchantProvider,
        installment_months: installmentMonths,
        approval_code:      p.approvalCode ?? null,
        /* A split row's OWN slip when it sent one, else null — the slip is
           optional (Owner 2026-08-13). Deliberately NOT falling back to
           `receiptImageKey`: that key is the single-deposit scan path's proof
           (below) and stamping it on several split rows would put one photo on
           payments it does not evidence. */
        slip_key:           posPaymentSlipKeys![i] ?? null,
        /* Account Sheet auto-fill (Loo 2026-06-07) — split rows carry no
           onlineType, so transfer falls back to 'Bank transfer'. */
        account_sheet:      deriveAccountSheet(p.method, merchantProvider, null),
        amount_sen:       p.amountSen,
        /* Who took the money. The fallback was the bridge's pinned system uuid,
           so an unnamed collector recorded as "System" on the money ledger; the
           column is a NULLABLE FK to staff (the /payments writer stamps null
           freely), so the real caller — or an honest blank — is always better.
           Precedence is unchanged: an explicit salespersonId still wins. */
        collected_by:       (body.salespersonId as string) ?? callerStaffId,
        created_by:         user.id,
        is_deposit:         true,
        note:               'POS split payment (auto-recorded at SO create)',
      }).select('id, so_doc_no, paid_at, method, merchant_provider, amount_sen, company_id').single();
      if (depErr) {
        // eslint-disable-next-line no-console
        console.error('[so-create] split-payment ledger insert failed:', depErr.message);
        continue;
      }
      await bookSoPaymentBestEffort(sb, depRow, 'split payment at SO create'); // docs/bugs/0652: this row used to skip the gate
      /* Promote — 'promoted' rows are excluded from the slip reaper (same dance
         as the SO-create order slip). The UPDATE runs under the caller's RLS
         (pending_slip_uploads allows the UPLOADER to promote); in this flow the
         uploader IS the order creator, so it matches. If it ever doesn't (or
         errors), the row stays 'uploaded' → the reaper would delete the R2
         object after TTL and the same session would be replayable — so a no-op
         promote is logged LOUDLY instead of swallowed. Best-effort: the payment
         row stands either way (slip_key already persisted on it).

         Guarded on the session because the slip is OPTIONAL now (Owner
         2026-08-13): with no id there is nothing to promote, and an unguarded
         `.eq('upload_session_id', null)` is a filter nobody wrote on purpose.
         The AUDIT below still runs — a slip-less payment is just as much a
         payment. */
      if (p.uploadSessionId) {
        const { data: promoted, error: promoteErr } = await sb
          .from('pending_slip_uploads')
          .update({ status: 'promoted', promoted_at: new Date().toISOString() })
          .eq('upload_session_id', p.uploadSessionId)
          .select('upload_session_id');
        if (promoteErr || !promoted || promoted.length === 0) {
          // eslint-disable-next-line no-console
          console.error(
            `[so-create] slip promote FAILED for session ${p.uploadSessionId} on ${docNo}: `
            + (promoteErr?.message ?? 'no row matched (RLS uploader mismatch?)')
            + ' — slip will be reaped after TTL; replay window open until then.',
          );
        }
      }
      await recordSoAudit(sb, {
        docNo,
        action: 'ADD_PAYMENT',
        actorId: user.id,
        actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
        source: 'automation',
        note: 'Auto: POS split payment recorded at SO create',
        fieldChanges: [
          { field: 'paidAt',      from: null, to: paidAt },
          { field: 'method',      from: null, to: p.method },
          { field: 'amountSen', from: null, to: p.amountSen },
          ...(merchantProvider ? [{ field: 'merchantProvider', from: null, to: merchantProvider } satisfies FieldChange] : []),
          ...(installmentMonths ? [{ field: 'installmentMonths', from: null, to: installmentMonths } satisfies FieldChange] : []),
          ...(p.approvalCode ? [{ field: 'approvalCode', from: null, to: p.approvalCode } satisfies FieldChange] : []),
        ],
      });
    }
  } else {
    const depositSen = typeof body.depositSen === 'number' ? body.depositSen : 0;
    /* Whitelist — the ledger's method vocabulary is closed; an arbitrary
       string must not reach Finance reports. Unknown method → header-only
       (the deposit still shows via the legacy fallback), no ledger row. */
    const VALID_METHODS = new Set(['cash', 'merchant', 'transfer', 'installment']);
    const rawMethod = typeof body.paymentMethod === 'string' ? body.paymentMethod.trim() : '';
    const depositMethod = VALID_METHODS.has(rawMethod) ? rawMethod : null;
    if (depositSen > 0 && depositMethod) {
      /* 'installment' is a merchant transaction with a term — both keep the
         provider/months fields (prod uses both method values). */
      const merchantLike = depositMethod === 'merchant' || depositMethod === 'installment';
      const merchantProvider = merchantLike ? ((body.merchantProvider as string) ?? null) : null;
      const installmentMonths = merchantLike
        && typeof body.installmentMonths === 'number' && body.installmentMonths > 0
        ? body.installmentMonths : null;
      const paidAt = dateOrNull(body.paymentDate) ?? todayMyt(); // same as the split-payment row above
      const { data: depRow, error: depErr } = await sb.from('mfg_sales_order_payments').insert({
        company_id:         companyId, // multi-company: match the SO's company
        so_doc_no:          docNo,
        paid_at:            paidAt,
        method:             depositMethod,
        merchant_provider:  merchantProvider,
        installment_months: installmentMonths,
        approval_code:      (body.approvalCode as string) ?? null,
        slip_key:           slipKey ?? receiptImageKey,        // handover slip, else the scanned receipt = the deposit's proof
        /* Account Sheet auto-fill (Loo 2026-06-07). */
        account_sheet:      deriveAccountSheet(depositMethod, merchantProvider, null),
        amount_sen:       depositSen,
        // Same as the split-payment row above: never the pin on the money ledger.
        collected_by:       (body.salespersonId as string) ?? callerStaffId,
        created_by:         user.id,
        is_deposit:         true,
        note:               'POS deposit (auto-recorded at SO create)',
      }).select('id, so_doc_no, paid_at, method, merchant_provider, amount_sen, company_id').single();
      if (depErr) {
        // eslint-disable-next-line no-console
        console.error('[so-create] deposit ledger insert failed:', depErr.message);
      } else {
        await bookSoPaymentBestEffort(sb, depRow, 'deposit at SO create'); // docs/bugs/0652: this row used to skip the gate
        await recordSoAudit(sb, {
          docNo,
          action: 'ADD_PAYMENT',
          actorId: user.id,
          actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
          source: 'automation',
          note: 'Auto: POS deposit recorded at SO create',
          fieldChanges: [
            { field: 'paidAt',      from: null, to: paidAt },
            { field: 'method',      from: null, to: depositMethod },
            { field: 'amountSen', from: null, to: depositSen },
            ...(merchantProvider ? [{ field: 'merchantProvider', from: null, to: merchantProvider } satisfies FieldChange] : []),
            ...(body.approvalCode ? [{ field: 'approvalCode', from: null, to: body.approvalCode as string } satisfies FieldChange] : []),
          ],
        });
      }
    }
  }

  /* Task 5 — mint the one-shot SKUs (gated + collision-safe). Runs BEFORE the
     item insert: buildOneShotMints mutates each accumulated row's item_code to
     the minted code, and the insert below spreads those rows. Uses a service-
     role client so the minted catalog rows land regardless of the caller's RLS.
     Best-effort: a minted row is an inactive tombstone — an orphan (insert that
     fails for a non-collision reason) is harmless and the SO line still carries
     the code, so we never fail the SO on a mint error. */
  if (oneShotReqs.length > 0) {
    const admin = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Probe a few collision suffixes (n=1..3) per request in ONE query so the
    // code buildOneShotMints picks is free even if a prior order already minted
    // the same remark on the same module (mfg_products.code is NOT uniquely
    // constrained, so a plain .insert() can't ON CONFLICT — we must pre-resolve).
    const candidate = (r: OneShotMintReq, n: number) => r.category === 'SOFA'
      ? oneShotSofaCode(r.modelCode, r.compartment, remarkSlug(r.remarkText), n)
      : oneShotSimpleCode(r.baseSkuCode, remarkSlug(r.remarkText), n);
    const probe = oneShotReqs.flatMap((r) => [1, 2, 3].map((n) => candidate(r, n)));
    // Per-company: a taken code in the OTHER company is not taken here (0233
    // makes uniqueness per (company_id, code)), and treating it as taken would
    // skip a perfectly free suffix.
    let probeQ = admin.from('mfg_products').select('code').in('code', probe);
    if (companyId != null) probeQ = probeQ.eq('company_id', companyId);
    const { data: existing } = await probeQ;
    const taken = new Set((existing ?? []).map((x) => (x as { code: string }).code));
    const nowIso = new Date().toISOString();
    const idGen = () => {
      const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      return `mfg-${rand.replace(/-/g, '').slice(0, 12)}`;
    };
    const skuRows = buildOneShotMints(oneShotReqs, taken, docNo, idGen, nowIso).map((r) => ({
      ...r,
      // mfg_products.cost_price_sen is NOT NULL DEFAULT 0; the minted cost is
      // unknown, so book 0 (the column default) rather than sending NULL — an
      // explicit NULL would trip a 23502 and silently drop every mint.
      cost_price_sen: r.cost_price_sen ?? 0,
    }));
    // Codes are pre-resolved free against the probe above, so a plain batched
    // insert won't collide in practice. Best-effort: any residual error (e.g. a
    // 23505 from an extremely rare 3+-order same-remark clash, or a transient
    // fault) is logged but never fails the SO — the line already references the
    // code and the SKU can be re-created from SKU Master.
    const { error: skuErr } = await admin.from('mfg_products').insert(stampCo(skuRows));
    if (skuErr && skuErr.code !== '23505') {
      // eslint-disable-next-line no-console
      console.error(`[so-create] one-shot SKU mint failed for ${docNo}: ${skuErr.message}`);
    }
  }

  if (itemRows.length > 0) {
    /* Migration 0165 — line_no makes the ranked/walked array order a
       first-class column (created_at is identical across one bulk insert,
       so it can never recover this order on read). */
    const rowsWithDoc = itemRows.map((r, lineNo) => ({ ...r, doc_no: docNo, line_no: lineNo }));
    /* Owner 2026-07-23 — auto-derive line.branding from the product catalog
       for any line the client did not stamp explicitly. The SO CREATE form
       has never exposed a per-line branding field, so before this fix every
       new SO shipped with branding=NULL on every line and the SO list
       Branding column read "—" for the whole book (2990 CoE 2026-07-23).
       Runs BEFORE stampCo so we can find the per-row company_id via the
       active-user fallback; stampCo then adds it. */
    await deriveLineBrandingFromProduct(sb, rowsWithDoc as unknown as Array<{ item_code?: string | null; branding?: string | null; company_id?: number | null }>, activeCompanyId(c) ?? null);
    signalNullWarehouseRows('POST /mfg-sales-orders (create)', docNo, rowsWithDoc as unknown as Array<Record<string, unknown>>); // logs only, never blocks
    const { error: iErr } = await sb.from('mfg_sales_order_items').insert(stampCo(rowsWithDoc));
    if (iErr) { await rollbackPwpClaims(); await sb.from('mfg_sales_orders').delete().eq('doc_no', docNo); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
    /* Stamp the HEADER branding from the representative line's SKU (owner
       2026-08-18, "我要表头啊"). The insert above wrote `body.branding ?? null`
       and no shipped client sends that field, so every ERP-created order landed
       with a blank header — which is exactly the hole the 2990 backfill had to
       fill for 100 orders, and would have re-opened on the next order created.
       Only ever fills a BLANK header: an explicit body.branding is the caller's
       decision and is not second-guessed. A null result leaves it blank rather
       than inventing one. */
    if (String((body.branding as string | null | undefined) ?? '').trim() === '') {
      const headerBrand = await deriveHeaderBrandingFromLines(
        sb,
        rowsWithDoc as unknown as Array<{ item_code?: string | null; branding?: string | null; company_id?: number | null }>,
        activeCompanyId(c) ?? null,
      );
      if (headerBrand) {
        await scopeToCompany(
          sb.from('mfg_sales_orders').update({ branding: headerBrand }).eq('doc_no', docNo),
          c,
        );
      }
    }
    /* Commander 2026-05-29 — re-roll the header through recomputeTotals so a
       matched sofa SET picks up its MASTER combo cost (spread across the lines).
       The inline rollup above set per-module costs; this corrects them + the
       header totals to the combo. No-op for non-sofa / non-matching SOs. */
    await recomputeTotals(sb, docNo, c);
  }

  /* PWP Code Voucher (migration 0130) — carry forward the un-applied reserved
     codes. Any code still RESERVED against one of THIS order's cart lines (the
     applied ones already flipped to USED in the claim pass above) becomes an
     AVAILABLE voucher bound to this order's customer: printed on the SO and
     redeemable in a future order. Keyed by the trigger line's cart_line_key,
     which the POS threads on each line as `cartLineKey`. */
  const pwpCartLineKeys = Array.from(new Set(
    items.map((it) => String((it as { cartLineKey?: string } | null)?.cartLineKey ?? '')).filter(Boolean),
  ));
  /* Promo is ONE-WAY (Loo 2026-06-06, the PWP-7615UAWC incident) — a reward
     line (bought with a code, variants.pwpCode) must never mint a FREE
     voucher of its own: with a rule whose trigger set == reward set (buy
     ARRUS → free ARRUS) the free unit would fund the next free unit, forever.
     The POS reconciler + /pwp-codes/reserve already refuse to mint these;
     this backstop kills anything reserved before that gate (old carts /
     tampered clients) instead of carrying it forward as an AVAILABLE voucher. */
  const rewardLineKeys = Array.from(new Set(
    items
      .filter((it) => String((it?.variants as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim() !== '')
      .map((it) => String((it as { cartLineKey?: string } | null)?.cartLineKey ?? ''))
      .filter(Boolean),
  ));
  /* These three blocks key on owner_staff_id + cart_line_key and MUST use the
     same identity /pwp-codes reserve stamps (callerStaffId), not the bridge's
     pin. They are the reason the reserve-side fix could not ship alone: left on
     the pin they would match NOTHING once reserve stamps the real owner, and the
     carry-forward below is what turns an un-applied reservation into the
     customer's AVAILABLE voucher — it would have failed silently (no error, no
     rows) and quietly cost customers the vouchers they had earned.
     A null callerStaffId owns no RESERVED codes (reserve refuses to stamp one),
     so skip rather than send `.eq('owner_staff_id', null)`, which is a malformed
     filter and not "no owner". */
  if (callerStaffId && rewardLineKeys.length > 0) {
    await sb.from('pwp_codes').delete()
      .eq('owner_staff_id', callerStaffId).eq('status', 'RESERVED').eq('type', 'promo')
      .in('cart_line_key', rewardLineKeys);
  }
  if (callerStaffId && pwpCartLineKeys.length > 0) {
    await sb.from('pwp_codes').update({
      status: 'AVAILABLE', source_doc_no: docNo, customer_id: orderCustomerId, updated_at: new Date().toISOString(),
    }).eq('owner_staff_id', callerStaffId).eq('status', 'RESERVED').in('cart_line_key', pwpCartLineKeys);
  }

  /* Re-stamp trigger_item_code (Loo 2026-06-06, the (K)→(Q) drift; reworked
     Loo 2026-06-12, SO-2606-008) — the snapshot is written ONCE at reserve
     time as the cart line's ANCHOR SKU. The printed SO's trigger / unused-
     voucher annotations (matched by item_code in shared/so-line-display.ts)
     need it to be a SKU that's actually ON the document, so re-stamp from
     pwpLeadRowByCartKey: the first BOOKED row per cart line (a sofa build's
     lead MODULE row — the payload anchor never lands post-split; one-shot
     mints are reflected via the in-place row rewrite). One batched read, then
     one update per distinct lead code that drifted. Covers both USED (claimed
     above — cart_line_key survives the claim) and AVAILABLE. */
  if (callerStaffId && pwpCartLineKeys.length > 0) {
    const { data: stampRows } = await sb.from('pwp_codes')
      .select('code, cart_line_key, trigger_item_code')
      .eq('owner_staff_id', callerStaffId)
      .in('cart_line_key', pwpCartLineKeys);
    const codesByLead = new Map<string, string[]>();
    for (const r of ((stampRows ?? []) as Array<{ code: string; cart_line_key: string | null; trigger_item_code: string | null }>)) {
      const leadRow = r.cart_line_key ? pwpLeadRowByCartKey.get(r.cart_line_key) : undefined;
      const lead = leadRow ? String(leadRow.item_code ?? '') : '';
      if (lead && r.trigger_item_code !== lead) {
        const arr = codesByLead.get(lead) ?? [];
        arr.push(r.code);
        codesByLead.set(lead, arr);
      }
    }
    // HAZARD 2 (mig 0188 re-keyed pwp_codes on (company_id, code)): `code`
    // alone re-stamps whichever company's voucher sorts first. The rows being
    // re-stamped are this order's, so the active company IS their company —
    // the same pairing the claim/burn/rollback sites above already carry.
    const restampCompanyId = activeCompanyId(c);
    for (const [lead, codes] of codesByLead) {
      if (restampCompanyId == null) break; // unresolved company: skip, never write half-keyed
      const { error: stampErr } = await sb.from('pwp_codes')
        .update({ trigger_item_code: lead, updated_at: new Date().toISOString() })
        .in('code', codes).eq('company_id', restampCompanyId);
      // eslint-disable-next-line no-console
      if (stampErr) console.error('[so-create] pwp trigger restamp failed:', lead, stampErr.message);
    }
  }

  // PR-D — audit row. Emit one CREATE entry with every non-null field the
  // commander typed on the new-SO form so the timeline shows the genesis
  // state. We deliberately include the line count rather than each line
  // (those get their own ADD_LINE rows if they're added later via PATCH).
  const createFields: FieldChange[] = [];
  const captureIfSet = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') createFields.push({ field: k, to: v });
  };
  captureIfSet('debtorName', customerName);
  captureIfSet('debtorCode', body.debtorCode);
  captureIfSet('agent', body.agent);
  captureIfSet('phone', body.phone);
  captureIfSet('email', body.email);
  captureIfSet('soDate', body.soDate);
  captureIfSet('lineCount', items.length);
  captureIfSet('localTotalSen', total);
  captureIfSet('paymentMethod', body.paymentMethod);
  captureIfSet('depositSen', body.depositSen);
  captureIfSet('processingDate', body.processingDate);
  captureIfSet('customerSoNo', body.customerSoNo);
  await recordSoAudit(sb, {
    docNo,
    action: 'CREATE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: createFields,
    /* Snapshot the REAL insert status — asDraft creates land as DRAFT (the
       background scan job path), everything else as CONFIRMED. Previously
       hardcoded 'CONFIRMED', which mislabelled scan drafts. */
    statusSnapshot: (body as { asDraft?: unknown }).asDraft === true ? 'DRAFT' : 'CONFIRMED',
    source: c.auditSource ?? 'web',
    note: c.auditNote,
  });

  /* B2C auto-allocation — if stock is already on hand, the new SO's lines flip
     to READY immediately and the header advances to READY_TO_SHIP. Runs a GLOBAL
     re-walk (not scoped to this doc) so that if this higher-priority order steals
     stock from a lower-priority one, the loser regresses from READY in the SAME
     pass instead of lagging. Best-effort: a failure never sinks the SO create. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-create failed:', e); }

  /* ERP -> AutoCount write-back. Queued, never pushed inline: the AutoCount
     host must not be able to fail a salesperson's Save. No-op while the flag is
     off, which is how it ships.

     NOT for a DRAFT. A draft is the scan job's guess awaiting an operator's
     verdict; it may be rewritten or thrown away, and neither belongs in a live
     account book. The DRAFT -> live transition below queues it instead. */
  /* AND THE REFUSAL COMES BACK OUT — never as a 422 (the order is committed by
     now); lib/ac-preflight.ts holds the block-or-warn ruling for every cause. */
  const acNotSent = (body as { asDraft?: unknown }).asDraft === true ? []
    : (await enqueueSoCreate(sb, { companyId, docNo, createdBy: c.get('houzsUser')?.id ?? null })).problems;

  return c.json({ docNo, ...(acNotSent.length ? { acNotSent } : {}) }, 201);
}

/* HTTP route — auth (router-level supabaseAuth) + the real Hono context wired
   into the core verbatim, so the request path behaves exactly as before the
   factoring. The dynamic-status cast is safe: every core outcome status is a
   contentful JSON status the old inline c.json calls already used. */
mfgSalesOrders.post('/', async (c) => {
  const out = await createSalesOrderCore({
    req: { json: () => c.req.json() },
    /* Forwards every key verbatim — including `sessionOrigin`, which the
       pricing trust boundary reads (see isPosTabletCaller). */
    get: ((key: 'supabase' | 'user' | 'houzsUser' | 'companyId' | 'sessionOrigin') => c.get(key as 'supabase')) as unknown as SoCreateContext['get'],
    env: c.env,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
  });
  return c.json(out.body, out.status as 201);
});

/* ── createDraftSalesOrder — headless SO create for the background scan job ──
   Runs the SAME createSalesOrderCore (pricing / guards / doc-no / audit all
   identical) without an HTTP request: the scan /enqueue endpoint captures the
   caller's identities while the request is still authed, and the waitUntil
   pipeline replays them here through a synthetic context.
     - salespersonId  = c.get('user').id captured at enqueue (scm.staff UUID —
       the SCM auth bridge identity the interactive create stamps).
     - houzsUserId    = c.get('houzsUser').id captured at enqueue (public users
       bigint — drives the venue-by-active-project auto-fill). No permissions
       are carried, so hasHouzsPerm gates resolve false — the draft is always
       self-attributed, exactly like a self-scoped interactive caller.
   Uses the scm-scoped service-role client (getSupabaseService) — authorization
   already happened at enqueue time; there is no request-scoped client here. */
export async function createDraftSalesOrder(
  env: Env,
  opts: {
    salespersonId: string;
    salespersonName?: string | null;
    houzsUserId?: number | null;
    /** Multi-company: the ACTIVE company captured at enqueue time (the
     *  scan_jobs row's company_id). Undefined = legacy row / pre-0083 —
     *  falls back to the 0091 HOUZS default. */
    companyId?: number | null;
    body: Record<string, unknown>;
  },
): Promise<SoCreateOutcome> {
  const svc = getSupabaseService(env);
  /* RESOLVE THE CODE, DO NOT LET THE MINTER GUESS IT — companyDocPrefix's
     missing-code branch mints `HC-`, so a 2990 scan named the wrong company
     permanently. docs/bugs/0616-a-2990-scan-minted-a-houzs-century-document-number.md */
  const resolvedCompanyCode = await companyCodeById(svc, opts.companyId ?? null);
  const syntheticGet = (key: 'supabase' | 'user' | 'houzsUser' | 'companyId' | 'companyCode' | 'sessionOrigin'): unknown => {
    if (key === 'supabase') return svc;
    // Headless scan job — replay the company captured on the scan_jobs row at
    // enqueue time so the draft (header + lines + payments + audit) lands under
    // the uploader's company, not the 0091 HOUZS default.
    if (key === 'companyId') return opts.companyId ?? undefined;
    // Resolved above from the id captured at enqueue. EXPLICIT branch, not a
    // fallthrough: the default below returns houzsUser, which companyDocPrefix
    // once stringified into "[object Object]-SO-YYMM-NNN". `undefined` now
    // survives only for a legacy row that captured no company at all.
    if (key === 'companyCode') return resolvedCompanyCode ?? undefined;
    // There is no session here at all (this runs after the HTTP response, off
    // waitUntil), so the draft is NOT-POS and is never drift-rejected — its
    // prices come off a handwritten slip. EXPLICIT branch, not a fallthrough:
    // the default below returns houzsUser, so an unhandled key would hand
    // isPosTabletCaller the wrong object entirely.
    if (key === 'sessionOrigin') return undefined;
    if (key === 'user') {
      return {
        id: opts.salespersonId,
        user_metadata: opts.salespersonName ? { name: opts.salespersonName } : undefined,
      };
    }
    // houzsUser — id only; permissions intentionally absent (see doc above).
    return opts.houzsUserId != null ? { id: opts.houzsUserId } : undefined;
  };
  return createSalesOrderCore({
    req: { json: async () => opts.body },
    get: syntheticGet as unknown as SoCreateContext['get'],
    env,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
    /* History attribution — the CREATE audit row shows the salesperson captured
       at enqueue time as the actor, tagged "via scan" so a rep can't claim a
       hand-typed order was OCR'd (or vice versa). */
    auditSource: 'scan',
    auditNote: 'Draft created by the background slip-scan job (photo OCR)',
  });
}

/* ── POST /recompute-allocation — re-walk every active SO line, flip
       PENDING/READY against live inventory, advance / regress SO header
       status. Manual trigger from the SO list "Re-allocate stock" button or
       admin debug. Best-effort. */
mfgSalesOrders.post('/recompute-allocation', async (c) => {
  const sb = c.get('supabase');
  const res = await recomputeSoStockAllocation(sb);
  return c.json(res);
});

// Status transition with audit row. Reads the prior status, updates, then
// inserts to mfg_so_status_changes — best-effort (audit failure does NOT
// roll back the status change).
export const patchMfgSalesOrderStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  /* `processingDate` — the Processing Date a move to IN_PRODUCTION proceeds
     WITH, for a caller proceeding an order that does not carry one yet.
     `internalExpectedDd` is the legacy spelling of the same key and is still
     accepted (readSoProcessingDateFromBody); it is the name this route's
     contract was documented under, and no live client sends it. */
  let body: { status?: string; notes?: string; version?: number; expectedStatus?: string; processingDate?: string; internalExpectedDd?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  /* FIX 1 (2026-07-16) — normalise the target to UPPERCASE before any check or
     write. Some clients post lowercase (the V2 list "Confirm" button sends
     "confirmed"), which the old verbatim writer persisted as-is — a status no
     `=== 'CONFIRMED'` check would ever match. Normalising fixes that latent
     lowercase-persist bug and lets the transition table judge a canonical value. */
  const toStatus = String(body.status).trim().toUpperCase();

  /* Company scope made STRICT, 2026-08-18. selfScopedSalesBlocked below already
     refuses a doc outside the active company — that is its step 1, not the
     salesperson half — but it does so through scopeToCompany, which DEGRADES to
     NO predicate when the company is unresolved, and only on a READ. This table
     is cross-company with a guessable `text PRIMARY KEY` doc_no and the client is
     service-role, so: refuse on unresolved, and predicate the UPDATE too. */
  const co = requireActiveCompanyId(c); if (!co.ok) return c.json(co.refusal, 409);
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: prev } = await scopeToCompanyId(sb.from('mfg_sales_orders')
    .select('status, version, edit_lease_token, edit_lease_expires_at, linked_ac_docno'), co.companyId)
    .eq('doc_no', docNo).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  const fromStatus = (prev as { status: string } | null)?.status ?? null;
  const fromNorm = fromStatus == null ? null : String(fromStatus).toUpperCase();

  /* A CANCEL THAT REACHED AUTOCOUNT CANNOT BE TAKEN BACK.
     The 2.2 SDK has no un-cancel: a whole-file grep of the reflected surface
     for `uncancel`, `Cancelled:Boolean` and `set_Cancelled` returns nothing,
     and CancelDocument is a COMMAND, not a flag we could write back to false.
     So an ERP un-cancel has no push - it would leave the order live here and
     cancelled there, which is exactly the divergence the owner named
     ("一边取消一边没取消"). Refusing is the only option that cannot silently
     diverge, and it matches what AutoCount itself enforces. */
  if (fromNorm === 'CANCELLED' && toStatus !== 'CANCELLED'
      && (prev as { linked_ac_docno?: string | null }).linked_ac_docno) {
    return c.json({
      error: 'cancel_is_final',
      reason: 'This order was cancelled in AutoCount too, and AutoCount has no un-cancel. '
        + 'Raise a new sales order instead.',
      acDocNo: (prev as { linked_ac_docno?: string | null }).linked_ac_docno,
    }, 409);
  }
  const currentVersion = Number((prev as { version?: number | string }).version ?? 1);
  const expectedVersionRaw = Number(body.version);
  const statusGrace = !Number.isInteger(expectedVersionRaw) || expectedVersionRaw < 1;
  if (statusGrace && !soCasGraceOpen(soCasGrace(c))) {
    return c.json({ ...SO_VERSION_REQUIRED, currentVersion }, 428);
  }
  // Rollout grace: a pre-CAS tab keeps the old last-writer-wins semantics.
  const expectedVersion = statusGrace ? currentVersion : expectedVersionRaw;
  if (expectedVersion !== currentVersion
      || (body.expectedStatus && String(body.expectedStatus).toUpperCase() !== fromNorm)) {
    return c.json(soVersionConflict(currentVersion), 409);
  }
  if (activeSoEditLease(prev as SoEditLeaseRow)) return c.json(SO_EDIT_LEASE_CONFLICT, 409);

  /* Audit 2026-06-11 C-1/H1 — a CANCELLED SO is FINAL (mirrors do_cancelled_final).
     Un-cancelling left the Edge #B SO_CANCEL_REFUND customer credit standing while
     the SO's deposit payments went live again — the same money existed twice
     (there is no SO_REOPEN_CONTRA claw-back on the SO side). Re-order via a NEW
     SO instead. Re-cancel (CANCELLED→CANCELLED) still rides through below and is
     idempotent (creditFromCancelledSo no-ops on the source pair). */
  if (fromNorm === 'CANCELLED' && toStatus !== 'CANCELLED') {
    return c.json({
      error: 'so_cancelled_final',
      reason: 'A cancelled Sales Order cannot be reactivated — its deposit was already converted to customer credit. Create a new SO instead.',
    }, 409);
  }

  /* Tier 2 downstream-lock — only the CANCELLED transition is gated (mirrors
     the GRN cancel guard). Other status transitions (CONFIRMED ↔ READY_TO_SHIP
     ↔ SHIPPED ↔ DELIVERED…) ride through untouched so the existing state
     machine + auto-advance (e.g. all-lines-READY → READY_TO_SHIP) keep working. */
  if (toStatus === 'CANCELLED' && fromNorm !== 'CANCELLED') {
    const childLock = await soHasDownstream(sb, docNo);
    if (childLock) return c.json(childLock, 409);
  }

  /* FIX 1 (2026-07-16) — legal-transition guard. Rejects an unknown/garbage
     target (400 invalid_status) and a clearly-illegal BACKWARD jump
     (409 illegal_status_transition). CANCELLED targets/sources are owned by the
     cancel-final + downstream guards above and short-circuit inside the helper;
     forward moves, idempotent no-ops, ON_HOLD pause/resume and the known stock /
     delivery-return regressions all pass. */
  {
    const txErr = soStatusTransitionError(fromNorm, toStatus);
    if (txErr) return c.json({ error: txErr.error, reason: txErr.reason }, txErr.code);
  }

  /* POS "Proceed" → stamp ONCE, on the first move into IN_PRODUCTION: the
     existing value is read first so a re-entry never overwrites it. (Merged
     with main's CANCELLED downstream-lock guard above — both apply.) */
  if (fromNorm === toStatus) {
    return c.json({ salesOrder: prev, version: currentVersion, unchanged: true });
  }
  /* ── Confirm gate (owner 2026-08-08) — a DRAFT may only become CONFIRMED
     with a salesperson, a venue, and every non-cancelled line a REAL catalog
     SKU carrying its required variant axes (colour-KIV satisfies the fabric
     axis — KIV blocks the Processing Date, not confirm). This is where a
     scan draft's "Pick a product…" placeholder line, and legacy free-text
     lines like HC-SO-2607-013's "Square pillow", stop: the review screen's
     Create Sales Order button gets the full aggregated problem list instead
     of silently passing through. DRAFT→CONFIRMED only — a resume from
     ON_HOLD or a reopen re-enters CONFIRMED on an order that already passed
     (or predates) the gate, and re-gating those would strand legacy orders. */
  if (fromNorm === 'DRAFT' && toStatus === 'CONFIRMED') {
    const confirmProblems = await soConfirmProblemsForDoc(sb, docNo);
    if (confirmProblems.length > 0) return c.json(validationFailedBody(confirmProblems), 422);
  }
  /* ── Stock-location gate on the DRAFT -> live transition (owner 2026-08-13,
     company 1 only) — the SAME invariant the create path enforces. This is the
     moment the draft becomes a real order and gets enqueued for AutoCount (see
     the enqueueSoCreate below), so it is the second and last place a create is
     queued, and a draft that never got a State has to be resolved HERE rather
     than refused by the account book. Condition mirrors that enqueue exactly:
     out of DRAFT, not a cancel (a cancelled draft queues no create). */
  if (fromNorm === 'DRAFT' && toStatus !== 'CANCELLED') {
    const locationProblem = await soLocationProblemForDoc(sb, docNo, c.get('companyCode') ?? null);
    if (locationProblem) return c.json(validationFailedBody([locationProblem]), 422);
  }
  const patch: Record<string, unknown> = { status: toStatus, version: currentVersion + 1, updated_at: new Date().toISOString() };
  if (toStatus === 'IN_PRODUCTION') {
    /* Column bound to the constant — see "WHY A CONSTANT" in
       shared/so-processing-date.ts. */
    const { data: cur } = await scopeToCompanyId(sb.from('mfg_sales_orders')
      .select(`${SO_PROCESSING_DATE_COLUMN}, debtor_name, email, address1, postcode, customer_delivery_date`), co.companyId)
      .eq('doc_no', docNo).maybeSingle();
    const curRow = cur as {
      processing_date?: string | null;
      debtor_name?: string | null; email?: string | null;
      address1?: string | null; postcode?: string | null; customer_delivery_date?: string | null;
    } | null;
    /* PROCEED IS THE DATE (owner, pinned 2026-08-13: *"只要有 Processing Date,
       就代表他 Proceed 了。Proceed 的日期是他填入 Processing Date 的日期。"*).
       This route used to stamp a Proceed marker with the click time and write NO
       date, so an order could sit IN_PRODUCTION with no release date at all —
       nothing ever told purchasing it was theirs to order. The date the proceed
       proceeds WITH is either already on the order or comes in on this request;
       there is no third source, and today is a guess. */
    const resolved = resolveProceedProcessingDate({
      /* Both spellings — the canonical `processingDate` every live client
         actually sends, and the legacy `internalExpectedDd` this route's
         contract was documented under. */
      supplied: readSoProcessingDateFromBody(body as Record<string, unknown>),
      stored: curRow?.[SO_PROCESSING_DATE_COLUMN] ?? null,
    });
    if (!resolved.ok) return c.json(resolved.refusal, 422);
    if (resolved.write) {
      /* An SO whose supplier PO is already out cannot take a schedule change
         through the header PATCH, so it must not take one through here either.
         (The processing-date half of that lock cannot be on: this branch runs
         only when the order has no date.) */
      const lock = await soProcessingLockBlocked(sb, docNo);
      if (lock) return c.json(lock, 409);
      /* Setting the date here must clear what setting it on the header clears —
         variants, colour-KIV, completeness, the date rules — or this route is
         the way around them, and it supersedes the proceed gate below (the
         aggregated list already carries both of that gate's conditions).

         The deposit is no longer among them (owner 2026-08-20), and the
         `companyCode` argument went with it — it only ever picked the deposit
         fraction. Proceeding through /status is the third surface of the same
         act, so leaving the money condition here would have re-created the
         split the ruling closes, one screen further along. */
      const problems = await soProcessingDateProblemsForDoc(sb, docNo, resolved.date, {
        customerName: curRow?.debtor_name,
        address1: curRow?.address1, postcode: curRow?.postcode,
        deliveryDate: curRow?.customer_delivery_date,
      });
      if (problems.length > 0) return c.json(validationFailedBody(problems), 422);
      /* The pair rule, on the one write path that reaches the date without a
         header patch. The helper above already refuses a missing delivery date
         through completeness; stating it again at the WRITE is what stops a
         future edit to that helper quietly re-opening the hole. */
      const pairRefusal = soDatePairRefusal({
        nextProc: resolved.date,
        nextDeliv: curRow?.customer_delivery_date ?? null,
        origProc: curRow?.[SO_PROCESSING_DATE_COLUMN] ?? null,
        origDeliv: curRow?.customer_delivery_date ?? null,
      });
      if (pairRefusal) return c.json(pairRefusal, 400);
      patch[SO_PROCESSING_DATE_COLUMN] = resolved.date;
    }
    /* NO STAMP, AND NO SECOND GATE (2026-08-18). This ended
       `if (!curRow?.proceeded_at) { …gate…; patch.proceeded_at = now }`, and
       both halves go with the second storage:
       · the stamp had exactly ONE consumer, the allocator, and #2396 moved that
         onto `processing_date`. Nothing reads the value as a timestamp — the
         desktop Proceed Date field was deleted 2026-06-05, no export, PDF or
         AutoCount payload names it — so writing it recorded nothing.
       · the gate inside it fired only when `!resolved.write`, i.e. when the
         order ALREADY carried a Processing Date. Under the owner's rule that
         order is already proceeded, so this re-gated a state that had passed —
         and inconsistently, since an order that also had a stamp was NOT
         re-gated. The first proceed IS `resolved.write`, and that branch above
         already runs soProcessingDateProblemsForDoc, a superset of this gate. */
  }
  /* PWP settlement on cancel (2026-07-29) — a cancel must also settle the
     vouchers the order touched, and it must do so in the SAME unit of work as
     the status flip: half-applied, a cancel either burns the customer's
     vouchers on an order that is still live, or leaves a cancelled order's
     vouchers AVAILABLE and redeemable (the bug this closes). PostgREST cannot
     span two statements, so the cancel transition — and ONLY that transition —
     runs through runScmPgCommand's real transaction; every other status move
     keeps the existing single-statement path (and its D1/PostgREST
     availability) untouched. */
  const isCancel = toStatus === 'CANCELLED' && fromNorm !== 'CANCELLED';

  const commitStatusChange = async (sbx: any): Promise<Response> => {
    /* Read the voucher position INSIDE the transaction, and refuse before any
       write — a blocked cancel must leave the order exactly as it was. */
    const voucherPlan = isCancel ? await planSoCancelVouchers(sbx, docNo) : null;
    if (voucherPlan?.blocked) return c.json(voucherPlan.blocked, 409);

    const { data, error } = await scopeToCompanyId(sbx.from('mfg_sales_orders').update(patch)
      .eq('version', currentVersion)
      .eq('status', fromStatus)
      .or(`edit_lease_token.is.null,edit_lease_expires_at.lt.${new Date().toISOString()}`), co.companyId)
      .eq('doc_no', docNo)
      .select('doc_no, status, version').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    // Stale/missing docNo (deleted, wrong tab) matches 0 rows → a clean 404
    // ("no longer found, refresh") instead of an opaque 500 (bug-hunt 2026-06-20).
    if (!data) {
      const { data: latest } = await scopeToCompanyId(sbx.from('mfg_sales_orders').select('version'), co.companyId).eq('doc_no', docNo).maybeSingle();
      if (!latest) return c.json({ error: 'not_found' }, 404);
      return c.json(soVersionConflict(Number((latest as { version?: number }).version ?? currentVersion)), 409);
    }

    if (voucherPlan) await applySoCancelVouchers(sbx, docNo, voucherPlan);

    // Audit row — best-effort on the ordinary path. Inside the cancel's atomic
    // command recordSoAudit throws instead, so a cancel can never commit the
    // voiding without the trail that explains it.
    await sbx.from('mfg_so_status_changes').insert({
      company_id: activeCompanyId(c), // multi-company: match the SO's company
      doc_no: docNo,
      from_status: fromStatus,
      to_status: toStatus,
      changed_by: user.id,
      notes: body.notes ?? null,
    });
    await recordSoAudit(sbx, {
      docNo,
      action: 'UPDATE_STATUS',
      actorId: user.id,
      actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
      fieldChanges: [
        { field: 'status', from: fromStatus, to: toStatus },
        ...(voucherPlan ? soCancelVoucherAuditChanges(voucherPlan) : []),
      ],
      statusSnapshot: toStatus,
      note: body.notes ?? undefined,
    });

    return c.json({
      salesOrder: data,
      version: currentVersion + 1,
      ...(voucherPlan ? {
        pwpVouchers: {
          voided: voucherPlan.toVoid.map((r) => r.code),
          returned: voucherPlan.toRestore.map((r) => r.code),
        },
      } : {}),
    });
  };

  const statusResponse = isCancel
    ? await runScmPgCommand(c, (tx) => commitStatusChange(tx))
    : await commitStatusChange(sb);
  if (!statusResponse.ok) return statusResponse;

  /* OCR self-learning — a DRAFT confirmed is the operator's verdict on the
     scan that produced it. The BACKGROUND scan path (enqueue → DRAFT) stamps
     scan_jobs.sample_id and had nothing listening for that verdict, so the
     main scan route never fed the learning pool. This is the listener. No-ops
     for the ~all SOs that did not come from a scan (one lookup on scan_jobs,
     one row per scan — see scan-sample-review on the missing so_doc_no index),
     and for a draft the operator edited (same header).
     Best-effort — never costs the operator their confirm. */
  if (fromNorm === 'DRAFT' && toStatus === 'CONFIRMED') {
    const acceptNote = noteScanDraftAccepted(getSupabaseService(c.env), docNo);
    try { c.executionCtx.waitUntil(acceptNote); }
    catch { /* non-Workers runtime (tests) — let the floating promise run */ }
  }

  /* SO status changed → recompute allocation. CANCELLED removes the SO from
     the queue (its claim releases); terminal statuses (SHIPPED/DELIVERED/…)
     also drop it out. Other PENDING SOs may move into READY. Best-effort. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-status failed:', e); }

  /* ERP -> AutoCount cancel. Reached only for an SO the downstream lock let
     through (soHasDownstream, checked above), which is the same rule AutoCount
     applies on its side — so this can never ask AutoCount to cancel something
     it has already shipped. Outside the transaction on purpose: the queue row
     must describe a cancel that actually committed. */
  if (isCancel) {
    await enqueueCancel(sb, {
      companyId: activeCompanyId(c),
      docType: 'SO',
      docNo,
      self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: docNo },
      createdBy: c.get('houzsUser')?.id ?? null,
    });
  } else if (fromNorm === 'DRAFT') {
    /* The draft just became a real order — this is the moment it belongs in
       AutoCount. enqueueSoCreate refuses an SO that already has an AutoCount
       counterpart, so a re-entered transition cannot duplicate it. */
    await enqueueSoCreate(sb, {
      companyId: activeCompanyId(c),
      docNo,
      createdBy: c.get('houzsUser')?.id ?? null,
    });
  }

  /* Edge #B — SO cancel with deposit paid turns the deposit into a customer
     credit. Idempotent on (source_type, source_doc_no). Best-effort. */
  if (toStatus === 'CANCELLED' && fromNorm !== 'CANCELLED' && fromNorm !== 'DRAFT') {
    try {
      const { data: so } = await scopeToCompanyId(sb.from('mfg_sales_orders').select('debtor_code, debtor_name'), co.companyId).eq('doc_no', docNo).maybeSingle();
      const s = so as { debtor_code: string | null; debtor_name: string | null } | null;
      if (s?.debtor_code) {
        await creditFromCancelledSo(sb, {
          docNo,
          debtorCode: s.debtor_code,
          debtorName: s.debtor_name,
          createdBy: user.id,
        });
      }
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] so-cancel credit failed:', e); }
  }

  // The committed response (incl. any pwpVouchers summary) was built inside the
  // command; the effects above are best-effort and never change it.
  return statusResponse;
};
mfgSalesOrders.patch('/:docNo/status', patchMfgSalesOrderStatusHandler);

/* PATCH .../hold — the mig-0324 MARKER, never `status`. routes/document-hold-routes.ts. */
mountHoldRoute(mfgSalesOrders, 'so');

// ── DELETE /mfg-sales-orders/:docNo — discard a DRAFT ───────────────────────
// Owner 2026-07-20 — a DRAFT (especially a junk scan / OCR draft) had NO way out
// but confirm→cancel, which burns a doc number and leaves a dead CANCELLED row
// (DRAFT was never in CANCELLABLE_STATUSES and no DELETE route existed). This
// hard-deletes a DRAFT — and ONLY a DRAFT.
//
//   • DRAFT ONLY. A CONFIRMED+ order is CANCELLED (a reversible, audited status
//     change that also books any deposit credit), never hard-deleted — 409 on a
//     non-draft, 404 on a missing / other-company doc.
//   • Company-scoped as a STRICT write: requireActiveCompanyId REFUSES when the
//     active company is unknown (no default, no `??` — an unresolved company must
//     never degrade to "all companies" on a delete). The load + the delete are
//     both scoped to that company, so a cross-company doc reads as 404 (leaking
//     that someone else's doc exists is itself a leak).
//   • Children go by ON DELETE CASCADE — mfg_sales_order_items / _payments /
//     mfg_so_status_changes / mfg_so_audit_log / mfg_so_price_overrides all carry
//     it (scripts/scm-schema/2990s-full-schema.sql); a DRAFT has no DO/SI, which
//     are SET NULL anyway. The DELETE statement is itself guarded on
//     status = 'DRAFT', so a confirm that races in between the read and the write
//     matches 0 rows and touches nothing.
//   • Permission = SO edit: the router mounts behind scmAreaGuard('scm.sales.orders')
//     with the default 'edit' write level, so DELETE already requires edit.
mfgSalesOrders.delete('/:docNo', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');

  // STRICT company scope for a destructive write — refuse when unresolved.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Self-scoped selling roles may only touch their OWN SO (mirror the line /
  // status / payment mutations). Not-theirs reads as not-found.
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  // Load the SO in THIS company only. Missing OR another company's → same 404.
  const { data: soRow } = await scopeToCompanyId(
    sb.from('mfg_sales_orders')
      .select('doc_no, status, version, edit_lease_token, edit_lease_expires_at, slip_image_key, receipt_image_key'),
    co.companyId,
  ).eq('doc_no', docNo).maybeSingle();
  if (!soRow) return c.json(NOT_THIS_COMPANY, 404);

  const status = String((soRow as { status?: string | null }).status ?? '').toUpperCase();
  if (status !== 'DRAFT') {
    return c.json({
      error: 'so_not_draft',
      reason: 'Only a draft can be discarded. A confirmed order must be cancelled, not deleted.',
    }, 409);
  }

  /* DRAFT is a claim about the STATUS COLUMN, not about the document chain.
     soDiscardBlocked asks the two questions the column cannot answer — see
     lib/so-lifecycle-guards.ts for what the cascade actually destroys. */
  const discardBlock = await soDiscardBlocked(sb, docNo, soHasDownstream);
  if (discardBlock) return c.json(discardBlock.body as any, discardBlock.code);

  const currentVersion = Number((soRow as { version?: number | string }).version ?? 1);
  const expectedVersionRaw = Number(c.req.query('version'));
  const deleteGrace = !Number.isInteger(expectedVersionRaw) || expectedVersionRaw < 1;
  if (deleteGrace && !soCasGraceOpen(soCasGrace(c))) {
    return c.json({ ...SO_VERSION_REQUIRED, currentVersion }, 428);
  }
  // Rollout grace: a pre-CAS tab keeps the old last-writer-wins semantics.
  const expectedVersion = deleteGrace ? currentVersion : expectedVersionRaw;
  if (expectedVersion !== currentVersion) return c.json(soVersionConflict(currentVersion), 409);
  if (activeSoEditLease(soRow as SoEditLeaseRow)) return c.json(SO_EDIT_LEASE_CONFLICT, 409);

  // Grab the R2 keys BEFORE the rows vanish (the DB rows cascade away): the
  // draft's scan slip + receipt and any per-line photos all live in the
  // SO_ITEM_PHOTOS bucket (scan-slips/<id> keys + item photo_urls).
  const slipImageKey = (soRow as { slip_image_key?: string | null }).slip_image_key ?? null;
  const receiptImageKey = (soRow as { receipt_image_key?: string | null }).receipt_image_key ?? null;
  const { data: itemRows } = await sb.from('mfg_sales_order_items').select('photo_urls').eq('doc_no', docNo);

  // Atomic, race-safe delete: doc_no + company + still-DRAFT. If a confirm landed
  // between the check above and here, this matches 0 rows → 409, nothing touched.
  const del = await scopeToCompanyId(
    sb.from('mfg_sales_orders').delete()
      .eq('status', 'DRAFT')
      .eq('version', currentVersion)
      .or(`edit_lease_token.is.null,edit_lease_expires_at.lt.${new Date().toISOString()}`),
    co.companyId,
  ).eq('doc_no', docNo).select('doc_no').maybeSingle();
  if (del.error) return c.json({ error: 'delete_failed', reason: del.error.message }, 500);
  if (!del.data) {
    return c.json({
      error: 'so_not_draft',
      reason: 'This order is no longer a draft — refresh to see its current status.',
    }, 409);
  }

  // Best-effort R2 orphan sweep — never fails the delete (a few KB of orphaned
  // blob is cheaper to leave than to roll a committed delete back over). Mirrors
  // the delete-item handler: main object + its `.thumb` sibling.
  if (c.env.SO_ITEM_PHOTOS) {
    const photoKeys = (itemRows ?? []).flatMap(
      (r) => ((r as { photo_urls?: string[] | null }).photo_urls ?? []),
    );
    const keys = [...photoKeys, slipImageKey, receiptImageKey].filter(
      (k): k is string => typeof k === 'string' && k.length > 0,
    );
    for (const key of keys) {
      try { await c.env.SO_ITEM_PHOTOS.delete(key); }
      catch (e) { /* eslint-disable-next-line no-console */ console.warn('[so-discard] R2 sweep failed for', key, e); }
      await deleteThumbFor(c.env.SO_ITEM_PHOTOS, key);
    }
  }

  return c.json({ ok: true, docNo });
});

// ── GET /mfg-sales-orders/:docNo/audit-log ──────────────────────────
// PR-D — unified history feed (newest first). Returns one envelope:
//   { entries: [{ id, so_doc_no, action, actor_id, actor_name_snapshot,
//                  field_changes, status_snapshot, source, note, created_at }] }
mfgSalesOrders.get('/:docNo/audit-log', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  /* so_doc_no is the ONLY key here and doc numbers are unique per company by
     PREFIX, not by constraint — so a 2990 number pasted into the Houzs URL used
     to return 2990's history. Same predicate the /:docNo/revisions read below
     already carries; mfg_so_audit_log took company_id in mig 0083. */
  const { data, error } = await scopeToCompany(sb.from('mfg_so_audit_log')
    .select('id, so_doc_no, action, actor_id, actor_name_snapshot, field_changes, status_snapshot, source, note, created_at')
    .eq('so_doc_no', docNo), c)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  /* The audit HISTORY is a finance read too — this route's own line PATCH does
     `cmp('unitCostSen', prev.unit_cost_sen, unitCost)`, so field_changes
     carries the old AND new unit cost. gateSoFinance strips the DETAIL, so
     leaving this open just moves the leak one endpoint over. Shared vocabulary
     (lib/finance-keys) — the consignment audit-log reads this SAME table. */
  const entries = (data ?? []) as Array<Record<string, unknown>>;
  if (!canViewScmFinance(c)) stripAuditFinance(entries);
  return c.json({ entries });
});

// GET — list status change history for the SO detail timeline.
mfgSalesOrders.get('/:docNo/status-changes', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb.from('mfg_so_status_changes')
    .select('id, doc_no, from_status, to_status, changed_by, notes, auto_actions, created_at')
    .eq('doc_no', docNo), c)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ statusChanges: data ?? [] });
});

// GET — list SO revision snapshots for the Detail "Revisions" tab (Phase 6b).
// Each row is a full header+lines snapshot captured when an amendment's approve-so
// gate re-derived the SO (so_revisions, keyed on so_doc_no + revision). Newest
// first so the tab lists the latest revision on top. Mirrors the audit-log read
// above: supabase select, plain load_failed on error. scopeToCompany: so_revisions
// carries company_id (mig 0080); no-op pre-activation.
mfgSalesOrders.get('/:docNo/revisions', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb.from('so_revisions')
    .select('id, revision, snapshot, created_at, created_by')
    .eq('so_doc_no', docNo), c)
    .order('revision', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ revisions: data ?? [] });
});

// GET — list line price overrides for the audit panel.
mfgSalesOrders.get('/:docNo/price-overrides', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb.from('mfg_so_price_overrides')
    .select('id, doc_no, item_id, item_code, original_price_sen, override_price_sen, reason, approved_by, created_at')
    .eq('doc_no', docNo), c)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ overrides: data ?? [] });
});

// POST — override the price on a single line item. Captures the original
// in the audit row so we never lose the history.
mfgSalesOrders.post('/:docNo/items/:itemId/override', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId');
  const user = c.get('user');
  /* SO-SKU spec P4 (D4) — price overrides are admin-level only. Everyone else
     gets the SKU Master price (auto-filled in the UI, enforced by the server
     recompute on POST/PATCH); this audited side-door is the ONLY way to
     deviate, so it carries the role gate.

     AUTHZ BEFORE CONCURRENCY (2026-07-22) — the role gate runs BEFORE the edit
     lease. A non-admin used to get the 409 "This order is being saved on
     another screen; wait a moment and try again", so they retried forever and
     were never told that only an admin can override a price. */
  if (!(await isPriceOverrideCaller(c))) {
    return c.json({
      error: 'price_override_admin_only',
      message: 'Unit prices follow the SKU Master sell price. Only an admin can override a line price.',
    }, 403);
  }
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;
  /* Owner 2026-06-12 — processing-date lock: no price overrides once the
     processing day has passed (the locked order is already PO'd). */
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }
  let body: { overridePriceSen?: number; reason?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const newPrice = Number(body.overridePriceSen ?? 0);
  if (!Number.isFinite(newPrice) || newPrice < 0) return c.json({ error: 'invalid_price' }, 400);

  const { data: item } = await sb.from('mfg_sales_order_items')
    .select('id, doc_no, item_code, unit_price_sen, qty, discount_sen')
    .eq('id', itemId).maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { id: string; doc_no: string; item_code: string; unit_price_sen: number; qty: number; discount_sen: number };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  /* Audit 2026-06-11 C-2 — the override recomputes total as qty × newPrice −
     stored discount; reject an override price that would push the line total
     negative (discount invariant: 0 ≤ discount ≤ qty × unit). */
  if (Number(i.discount_sen ?? 0) > i.qty * newPrice) {
    return c.json({
      error:    'invalid_discount',
      reason:   'Stored line discount exceeds qty × override price — the line total would go negative.',
      discount: Number(i.discount_sen ?? 0),
      max:      i.qty * newPrice,
    }, 422);
  }

  // Audit first (so we don't lose original even if the update fails)
  const originalPriceSen = i.unit_price_sen;
  const overridePriceSen = newPrice;
  await sb.from('mfg_so_price_overrides').insert({
    company_id: activeCompanyId(c), // multi-company: match the SO's company
    doc_no: docNo,
    item_id: itemId,
    item_code: i.item_code,
    original_price_sen: originalPriceSen,
    override_price_sen: overridePriceSen,
    reason: body.reason ?? null,
    approved_by: user.id,
  });

  const newLineTotal = (i.qty * newPrice) - i.discount_sen;
  /* Task #114 — pull current line_cost_sen so the price override
     recomputes line_margin_sen correctly. Previous code used `- 0`
     which silently broke margin tracking on every override. */
  const { data: costRow } = await sb.from('mfg_sales_order_items')
    .select('line_cost_sen')
    .eq('id', itemId)
    .maybeSingle();
  const currentLineCost = Number((costRow as { line_cost_sen?: number } | null)?.line_cost_sen ?? 0);
  const { error } = await sb.from('mfg_sales_order_items').update({
    unit_price_sen: newPrice,
    total_sen: newLineTotal,
    total_inc_sen: newLineTotal,
    balance_sen: newLineTotal,
    line_margin_sen: newLineTotal - currentLineCost,
  }).eq('id', itemId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  /* Task #114 — also refresh the header totals after the override so
     total_cost_sen / total_margin_sen / category cost columns stay
     consistent with the new line revenue + margin. */
  await recomputeTotals(sb, docNo, c);

  // PR-D — also emit a unified audit-log entry so the History drawer
  // shows this price override alongside other UPDATE_LINE actions.
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'unitPriceSen', from: originalPriceSen, to: overridePriceSen },
    ],
    note: (body.reason as string) || undefined,
  });

  /* ERP -> AutoCount edit. This route writes unit_price_sen, which IS an
     AutoCount field (UnitPrice on SODTL) — so an override that never reached
     the account book left the two sides quoting different money for the same
     order line. It was missed because it is the one price path that does not go
     through PATCH /:docNo/items/:itemId: it is the admin-only audited side-door,
     and the wiring test that claimed "every SO mutation path queues an edit"
     asserted seven named anchors rather than the set. */
  await queueAcSoEdit(c, docNo);
  return c.json({ ok: true, itemId, newPrice });
});

// ── PATCH header — edit debtor info, addresses, note, etc. ───────────
/* ── Customer change on an existing SO (Loo 2026-06-13, bug-fix round 2) ───────
   When a Save re-points an SO to a different customer:
     • PWP PRODUCT lines are MAINTAINED — a customer/name edit must not re-price
       a reward. Only an ITEM change re-prices PWP (tbc-swap). So there is NO
       strip here.
     • the SO's MINTED vouchers (source_doc_no = docNo) follow the order — their
       customer_id is re-pointed to the new customer.
     • the cross-category DELIVERY fee (a SERVICE line whose rate depends on the
       customer's other orders) is RE-DETECTED — see redetectCrossCategoryDelivery. */
/* A rebuild the 0314 RPC REFUSED because the SVC-DELIVERY* lines moved between
   the derivation's read and the function's advisory lock. Neither an error nor
   "no fee": the inputs went stale, so the whole derivation is re-run. */
const STALE_DERIVATION = Symbol('so-delivery-stale-derivation');
type DeliveryFeeCoreResult = { isFollowup: boolean; sourceDocNo: string | null; total: number } | null;

/* Core delivery-fee recompute — re-derives the authoritative delivery FEE from
   the SO's CURRENT items, for a CALLER-SUPPLIED cross-category sourceDocNo. It
   does NOT auto-match a source: the caller decides whether to re-run the
   customer auto-match (the customer-change path, redetectCrossCategoryDelivery)
   or to pass the SO's already-stored source through unchanged (the item-edit
   path, rederiveDeliveryFee). Preserves the operator's free-form additional fee
   (recovered from the existing SVC-DELIVERY-ADD line), recomputes on the
   authoritative computeSoDeliveryFee, and rebuilds the SVC-DELIVERY* lines. Only
   runs when the SO already carries a delivery fee — as SVC-DELIVERY* LINES, or
   as an orphaned header delivery_fee_sen that lost its lines (see the bail
   below); a genuinely fee-less SO returns null BEFORE recomputeTotals (the
   caller is responsible for any totals refresh), so nothing here ever STARTS a
   fee on a backend-authored SO. Best-effort: logs DB errors, never throws. */
async function recomputeDeliveryFeeAttempt(
  sb: any, docNo: string, sourceDocNo: string | null, c: any,
): Promise<DeliveryFeeCoreResult | typeof STALE_DERIVATION> {
  /* `id` is selected because it KEYS the staleness expectation (0314): the RPC
     re-reads these same rows under its lock and compares by row id. */
  const { data: lineRows } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, total_sen, unit_price_sen, discount_sen, qty, line_no, variants')
    .eq('doc_no', docNo).eq('cancelled', false);
  const lines = (lineRows ?? []) as Array<{ id: string; item_code: string; item_group: string | null; total_sen: number | null; unit_price_sen: number | null; discount_sen: number | null; qty: number | null; line_no: number | null; variants: Record<string, unknown> | null }>;
  const deliveryLines = lines.filter((l) => isDeliveryFeeServiceCode(l.item_code));
  /* Owner ruling 2026-08-07 ("全部都会有 SKU 的 … 怎么可以走后门呢?"): every
     ringgit on a Sales Order is a LINE. The header delivery_fee_sen is a
     dual-write MIRROR of the SVC-DELIVERY* lines, never money of its own — but
     2990-SO-2608-006 proved the mirror could outlive the lines: delete (or
     cancel) every fee line and the old `length === 0 → return null` bail turned
     this derivation off FOREVER, while recomputeTotals' legacy line-less
     fallback kept folding the orphaned header snapshot into the total. The SO
     then read subtotal RM0 / total RM250 with no line saying why — the back
     door. So the bail now asks the header too: no fee lines but a header still
     carrying a fee means the fee must be RE-MATERIALISED as lines through this
     same derivation (the 0214 RPC below), which also re-stamps the header to
     the derived total — the ONE truth. Only an SO with no fee lines AND no
     header fee is genuinely fee-less; the dormant-fee rule stands (nothing
     here ever STARTS a fee — only the create path's applyDeliveryFee does). */
  if (deliveryLines.length === 0) {
    const { data: feeHdr, error: feeHdrErr } = await sb.from('mfg_sales_orders')
      .select('delivery_fee_sen').eq('doc_no', docNo).maybeSingle();
    /* Fail CLOSED (the 2026-07-17 zeroing lesson): a failed read is not "no
       fee". Bail without writing — the shape self-heals on the next edit. */
    if (feeHdrErr) {
      /* eslint-disable-next-line no-console */
      console.error('[so-redetect] header fee read failed — delivery derivation skipped:', docNo, feeHdrErr.message);
      return null;
    }
    const headerFeeSen = Number((feeHdr as { delivery_fee_sen?: number } | null)?.delivery_fee_sen ?? 0);
    if (headerFeeSen <= 0) return null; // no lines AND no header fee → genuinely fee-less
  }

  // The rebuilt SVC-DELIVERY* lines append AFTER the kept lines (services sort
  // last anyway, but a numbered line_no keeps the order stable + matches create).
  const keptMaxLineNo = Math.max(
    -1,
    ...lines.filter((l) => !isDeliveryFeeServiceCode(l.item_code))
      .map((l) => (typeof l.line_no === 'number' ? l.line_no : -1)),
  );

  // Operator-owned state (free-form fee + discounts) — see recoverOperatorDeliveryState.
  const { additionalSen, discountByCode } = recoverOperatorDeliveryState(deliveryLines);

  // Deliverable categories (sofa / mattress / bedframe) + their special-model fees.
  const DELIVERABLE = new Set(['sofa', 'mattress', 'bedframe']);
  const categoryIds = lines
    .map((l) => String(l.item_group ?? '').toLowerCase())
    .filter((g) => DELIVERABLE.has(g));
  const goodsLines = lines.filter((l) => DELIVERABLE.has(String(l.item_group ?? '').toLowerCase()));
  const goodsCodes = [...new Set(goodsLines.map((l) => l.item_code))];
  /* Phase 1 — special delivery fee rules (migration 0024, #691 RuleTarget).
     The persisted SO carries the split sofa as one row PER module SKU (cells
     stripped, buildKey kept). A sofa module's compartment code lives in its
     item_code SUFFIX (every sofa SKU has size_code = NULL); size_code is the
     real variant code ONLY for mattress/bedframe. Sofa rows are regrouped by
     buildKey so combo matching sees the WHOLE build's modules together. The
     reconstruction is a pure helper (reconstructDeliveryRuleLines) and the
     result is matched by the SAME shared matcher the create path runs. */
  let specialModels: { standaloneFee: number; crossCategoryFollowupFee: number }[] = [];
  if (goodsCodes.length > 0) {
    const { data: prodRows } = await scopeToCompany(
      sb.from('mfg_products').select('code, category, model_id, size_code').in('code', goodsCodes),
      c,
    );
    const prodByCode = new Map(
      ((prodRows ?? []) as Array<{ code: string; category: string | null; model_id: string | null; size_code: string | null }>)
        .map((p) => [p.code, p]),
    );
    const deliveryRuleLines = reconstructDeliveryRuleLines(
      goodsLines.map((l) => {
        const prod = prodByCode.get(l.item_code) ?? null;
        return {
          itemCode: l.item_code,
          category: prod?.category ?? l.item_group ?? null,
          modelId: prod?.model_id ?? null,
          sizeCode: prod?.size_code ?? null, // NULL for sofa; the helper reads the item_code suffix
          buildKey: ((l.variants as { buildKey?: unknown } | null)?.buildKey as string | null) ?? null,
        };
      }),
    );
    const { data: comboRows } = await scopeToCompany(
      sb.from('sofa_combo_pricing').select('id, modules'),
      c,
    );
    const comboModulesById = new Map<string, string[][]>(
      ((comboRows ?? []) as Array<{ id: string; modules: string[][] | null }>)
        .map((cb) => [cb.id, cb.modules ?? []]),
    );
    specialModels = await specialDeliveryFeesForLines(sb, deliveryRuleLines, comboModulesById);
  }

  // Key by company_id (2990's row is id=100001); id=1 fallback when unresolved
  // (scopeToCompany no-ops when unresolved, which would read >1 row here).
  const _dcfgCid = activeCompanyId(c);
  let dcfgQ2 = sb.from('delivery_fee_config').select('base_fee, cross_category_fee');
  dcfgQ2 = _dcfgCid != null ? dcfgQ2.eq('company_id', _dcfgCid) : dcfgQ2.eq('id', 1);
  const { data: dcfg } = await dcfgQ2.single();
  const cfgSen = {
    baseFee: Number((dcfg as { base_fee?: number } | null)?.base_fee ?? 0) * 100,
    crossCategoryFee: Number((dcfg as { cross_category_fee?: number } | null)?.cross_category_fee ?? 0) * 100,
  };

  /* sourceDocNo is the caller's responsibility (see the function doc). No
     auto-match here — the item-edit path MUST pass the SO's stored source
     through unchanged. */
  const isFollowup = !!sourceDocNo;
  const fee = computeSoDeliveryFee(
    { categoryIds, specialModels, isCrossCategoryFollowup: isFollowup, additionalFee: additionalSen },
    cfgSen,
  );
  const specs = buildDeliveryFeeServiceLines(fee, sourceDocNo);

  // Header context for the rebuilt service rows.
  const { data: hdr } = await sb.from('mfg_sales_orders')
    .select('debtor_name, venue, customer_delivery_date, company_id').eq('doc_no', docNo).maybeSingle();
  const h = (hdr ?? {}) as { debtor_name?: string | null; venue?: string | null; customer_delivery_date?: string | null; company_id?: number | null };

  /* The write half lives in lib/so-delivery-fee-rebuild.ts — it owns the 0214
     lock contract, the 0310 line reuse and the 0314 staleness refusal, and it
     is the reason this function is an ATTEMPT rather than the whole job. */
  const outcome = await applyDeliveryFeeRebuild(sb, {
    docNo,
    sourceDocNo,
    rows: buildDeliveryRebuildRows(specs, {
      docNo,
      keptMaxLineNo,
      discountByCode,
      debtorName: h.debtor_name ?? null,
      venue: h.venue ?? null,
      customerDeliveryDate: h.customer_delivery_date ?? null,
    }),
    liveLines: deliveryLines,
  });
  if (outcome.status === 'stale') return STALE_DERIVATION;

  await recomputeTotals(sb, docNo, c);
  return { isFollowup, sourceDocNo, total: fee.total };
}

/* READ, THEN LOCK was the defect. `recomputeDeliveryFeeAttempt` reads the fee
   lines and only then calls the RPC that takes the per-doc_no advisory lock, so
   two line PATCHes from ONE Save (runSoLineWrites fans the dirty-line stage out
   with Promise.allSettled) could both derive from the same pre-edit snapshot and
   the second write put the operator's reduction back — quoted RM 125, invoiced
   RM 250. Migration 0314 makes the RPC refuse a derivation whose inputs moved;
   this loop is the other half, re-reading and deriving again.

   Exhaustion writes NOTHING, deliberately: the same posture as the failed
   header read above ("a failed read is not 'no fee'"). Something else is
   actively rewriting these lines and will re-derive after itself. */
async function recomputeDeliveryFeeCore(
  sb: any, docNo: string, sourceDocNo: string | null, c: any,
): Promise<DeliveryFeeCoreResult> {
  for (let attempt = 1; attempt <= DELIVERY_REBUILD_MAX_ATTEMPTS; attempt += 1) {
    const res = await recomputeDeliveryFeeAttempt(sb, docNo, sourceDocNo, c);
    if (res !== STALE_DERIVATION) return res;
  }
  /* eslint-disable-next-line no-console */
  console.error('[so-redetect] delivery fee NOT re-derived — the fee lines moved under every attempt:', docNo);
  return null;
}

/* Re-detect the cross-category delivery fee against a (re-resolved) customer —
   the CUSTOMER-CHANGE path. Auto-matches the new customer's eligible source SO
   with the SAME logic as the handover Auto-match button (pickCrossCategoryMatch),
   self-excluding THIS SO so changing BACK to the original customer restores the
   discount. The match (or null) is then handed to recomputeDeliveryFeeCore which
   rebuilds the SVC-DELIVERY* lines + header on the authoritative
   computeSoDeliveryFee. Only runs when the SO already carries a delivery fee.
   Best-effort. */
async function redetectCrossCategoryDelivery(
  sb: any, docNo: string, newName: string, newPhone: string | null, c: any,
): Promise<{ isFollowup: boolean; sourceDocNo: string | null; total: number } | null> {
  // Auto-match the new customer for an eligible cross-category source SO.
  let sourceDocNo: string | null = null;
  const normPhone = newPhone ? (normalizePhone(newPhone) ?? newPhone) : null;
  if (newName && normPhone) {
    const { data: candRows } = await scopeToCompany(
      sb.from('mfg_sales_orders')
        .select('doc_no, debtor_name, created_at')
        .eq('phone', normPhone).not('status', 'in', '("CANCELLED","DRAFT")').neq('doc_no', docNo),
      c,
    )
      .order('created_at', { ascending: false }).limit(50);
    const candidates: AutoMatchCandidate[] = ((candRows ?? []) as Array<{ doc_no: string; debtor_name: string | null }>)
      .map((r) => ({ docNo: r.doc_no, debtorName: r.debtor_name }));
    if (candidates.length > 0) {
      const { data: usedRows } = await scopeToCompany(
        sb.from('mfg_sales_orders')
          .select('cross_category_source_doc_no')
          .in('cross_category_source_doc_no', candidates.map((x) => x.docNo))
          .neq('doc_no', docNo), // self-excluded: this SO's own link must not burn its own source
        c,
      );
      const used = ((usedRows ?? []) as Array<{ cross_category_source_doc_no: string | null }>)
        .map((r) => r.cross_category_source_doc_no).filter((v): v is string => !!v);
      const match = pickCrossCategoryMatch(candidates, newName, used);
      if (match) sourceDocNo = match.docNo;
    }
  }
  return recomputeDeliveryFeeCore(sb, docNo, sourceDocNo, c);
}

/* Re-derive the delivery fee from the SO's CURRENT items — the ITEM-EDIT path.
   Unlike the customer-change path, this MUST NOT re-run the customer auto-match:
   it reads the SO's already-stored cross_category_source_doc_no and passes it
   THROUGH unchanged, so a benign item edit never drops or flips an operator-
   pinned cross-category source link. Only the FEE re-derives (special-delivery
   triggers + sofa↔mattress cross-category mix follow the current items). When
   the SO carries no delivery fee — no SVC-DELIVERY* lines AND no header
   delivery_fee_sen (the core checks both; an orphaned header fee is
   re-materialised as lines, never left header-only) — the core early-bails
   (null) before recomputeTotals, so we still refresh the header totals for
   the edit. Best-effort. */
export async function rederiveDeliveryFee(sb: any, docNo: string, c: any): Promise<void> {
  let storedSource: string | null = null;
  const { data: hdr } = await sb.from('mfg_sales_orders')
    .select('cross_category_source_doc_no').eq('doc_no', docNo).maybeSingle();
  storedSource = (hdr as { cross_category_source_doc_no?: string | null } | null)?.cross_category_source_doc_no ?? null;
  const res = await recomputeDeliveryFeeCore(sb, docNo, storedSource, c);
  if (res === null) await recomputeTotals(sb, docNo, c);
}

export const patchMfgSalesOrderHeaderHandler = async (c: any) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* Audit 2026-06-20 — self-scoped sales may only edit their OWN SO. Without
     this a sales/sales_executive reaching the Backend SO detail could PATCH any
     order by doc_no (customer fields, even salesperson_id reassignment). Mirror
     the line-mutation endpoints' self-scope guard. */
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'], ['transferTo', 'transfer_to'],
    ['address1', 'address1'], ['address2', 'address2'], ['address3', 'address3'],
    ['address4', 'address4'], ['phone', 'phone'], ['note', 'note'],
    ['remark2', 'remark2'], ['remark3', 'remark3'], ['remark4', 'remark4'],
    ['soDate', 'so_date'], ['currency', 'currency'],
    // PR #35 — new header fields
    ['customerId', 'customer_id'], ['customerState', 'customer_state'],
    ['customerPoImageB64', 'customer_po_image_b64'],
    // PR #121 — customer's own SO number (their ERP ref)
    ['customerSoNo', 'customer_so_no'],
    ['hubId', 'hub_id'], ['hubName', 'hub_name'],
    ['customerDeliveryDate', 'customer_delivery_date'],
    ['processingDate', 'processing_date'],
    /* Mig 0053 (port of 2990 0199 + 0201) — amendment carriers. The customer's
       original `customer_delivery_date` above is NEVER overwritten by an amend;
       these three columns hold the customer's REQUESTED-changed date, the date
       WE confirm, and the free-text "why". Delivery Planning's `/fields` route
       also writes `amend_date_from_customer` + `amended_delivery_date` (and the
       `/schedule` action stamps `amended_delivery_date`); this PATCH lets the
       SO Detail page edit any of them inline too, including the reason. */
    ['amendDateFromCustomer', 'amend_date_from_customer'],
    ['amendedDeliveryDate', 'amended_delivery_date'],
    ['amendReason', 'amend_reason'],
    ['linkedDoDocNo', 'linked_do_doc_no'],
    ['shipToAddress', 'ship_to_address'], ['billToAddress', 'bill_to_address'],
    ['installToAddress', 'install_to_address'],
    /* PR #46 — POS handover fields */
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'],
    ['city', 'city'], ['postcode', 'postcode'], ['buildingType', 'building_type'],
    ['emergencyContactName', 'emergency_contact_name'],
    ['emergencyContactPhone', 'emergency_contact_phone'],
    ['emergencyContactRelationship', 'emergency_contact_relationship'],
    /* POS handover, still live — see the create path's note. */
    ['targetDate', 'target_date'],
    /* PR #143 + #150 — Payment fields */
    ['paymentMethod', 'payment_method'],
    ['installmentMonths', 'installment_months'],
    ['merchantProvider', 'merchant_provider'],
    ['approvalCode', 'approval_code'],
    ['paymentDate', 'payment_date'],
    ['depositSen', 'deposit_sen'],
    /* `paidSen` is deliberately NOT mapped — paid is SERVER-OWNED. It is
       derived from the mfg_sales_order_payments ledger (the view's
       paid_total_sen); the stored `paid_sen` column has no writer that
       keeps it true and is already documented deprecated + scheduled for drop
       (see the /:docNo/payments PAYMENT_COLS note and the list rollup). While
       it was mapped here, a self-scoped salesperson could PATCH
       {paidSen: <order total>} onto their OWN order and book it fully paid
       with zero payment rows. Record a payment; never set a total. */
  ];
  /* Task #91 — phone columns get normalized to E.164 storage form before any
     UPDATE. UI sends the storage form already (PhoneInput blur), but a
     misbehaving client could still PATCH a raw "+60 12 345 6789". */
  const PHONE_FIELDS = new Set(['phone', 'emergencyContactPhone']);
  /* A caller who cannot READ deposit must not WRITE it. gateSoFinance strips
     deposit_sen (an SO_FINANCE_KEY since #574) from the detail payload, and
     this map accepts ANY defined value — so a client that seeded its header
     draft off that stripped payload would round-trip the missing field as a
     genuine 0 and wipe the deposit (the #632 trap). consignment-orders.ts
     already carries this exact guard; the SO it was CLONED FROM never got it.
     No Houzs caller sends depositSen on PATCH today (SalesOrderNew posts it
     on CREATE only), so this is defence-in-depth that keeps the strip safe by
     construction rather than by the frontend's current shape. A finance caller
     is unaffected. */
  const canFinance = canViewScmFinance(c);
  const updates: Record<string, unknown> = {};
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    if (from === 'depositSen' && !canFinance) continue;
    if (PHONE_FIELDS.has(from) && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else if (from === 'venueId') {
      /* Normalise BEFORE the change-detection compare below, exactly as
         customer_state is canonicalized. Three cases, and the middle one is the
         load-bearing distinction:
           • a real uuid            -> written
           • blank / null           -> written as NULL (a deliberate clear)
           • a foreign picker id    -> NOT WRITTEN AT ALL (skip the column)
         The third must not collapse to NULL: 18 live rows hold a genuine uuid,
         and their picker option is a project/showroom id that matches no uuid,
         so writing the coercion result would silently WIPE a good FK on every
         unrelated save. Leaving the column untouched keeps the stored value and
         still lets the rest of the header save. */
      const venueIdValue = venueIdUuidOrNull(body[from]);
      const venueIdBlank = body[from] == null || String(body[from]).trim() === '';
      if (venueIdValue === null && !venueIdBlank) {
        /* Drop it from `body` as well: diffFields() audits from `body` via the
           same map, so a key left behind would write an UPDATE_DETAILS row
           claiming venueId changed to a value nothing stored. */
        delete body[from];
        continue;
      }
      updates[to] = venueIdValue;
    } else if (from === 'depositSen') {
      /* Clamp >= 0, matching the create path: the header deposit is still added
         on top of the ledger for legacy SOs whose deposit never landed as an
         is_deposit row, so a negative value would deflate that paid rollup. */
      updates[to] = Math.max(0, typeof body[from] === 'number' ? (body[from] as number) : 0);
    } else {
      updates[to] = isDateColumn(to) ? dateOrNull(body[from]) : body[from]; // "" -> NULL
    }
  }
  /* Mig 0175 (owner 2026-07-22) — canonicalize customer_state at write so a
     PATCH that sends 'PENANG' / 'Kl' / 'W.P. Kuala Lumpur' lands as the exact
     my_localities spelling. Foreign state names (China, SG) round-trip
     unchanged. Runs BEFORE the change-detection compare below so the
     no-op skip sees the canonical value, not the raw client string — a
     PATCH sending 'PENANG' when storage already holds 'Pulau Pinang' is a
     no-op after canonicalize and correctly drops out. */
  if (updates['customer_state'] !== undefined) {
    updates['customer_state'] = canonicalizeMyState(updates['customer_state'] as string | null);
  }

  /* `agent` follows a reassigned salesperson; a PATCH naming `agent` still wins.
     scm/lib/so-agent.ts says why this must precede the read below. */
  const agentBeforeFollow = updates['agent'];
  await followSalespersonToAgent(sb as never, updates, body);
  /* Did `agent` change ONLY because it followed the salesperson? It is an
     identity-locked column — see the carve-out in shared/so-identity-lock.ts. */
  const agentFollowedSalesperson = updates['agent'] !== agentBeforeFollow;
  /* A PATCH is a real mutation only when at least one recognised, normalised
     field differs from storage. Compare before validation or derivation so an
     unchanged phone/dropdown/date cannot demand a version, bump it, or fire a
     follower side effect. `reserveLineWrites` is the one explicit exception:
     the desktop composite-save uses it to acquire a CAS token before lines. */
  const beforeCols = map.map(([, snake]) => snake)
    .concat(['status', 'version', 'edit_lease_token', 'edit_lease_expires_at'])
    .join(', ');
  const { data: before, error: beforeError } = await sb.from('mfg_sales_orders').select(beforeCols).eq('doc_no', docNo).maybeSingle();
  if (beforeError) return c.json({ error: 'load_failed', reason: beforeError.message }, 500);
  if (!before) return c.json({ error: 'not_found' }, 404);
  const beforeRecord = before as unknown as Record<string, unknown>;
  for (const [from, to] of map) {
    if (!(to in updates) || norm(updates[to]) !== norm(beforeRecord[to])) continue;
    delete updates[to];
    delete body[from];
  }

  const reserveForLineWrites = body['reserveLineWrites'] === true;
  const completeLineWrites = body['completeLineWrites'] === true;
  const requestedLeaseToken = typeof body['lineWriteLeaseToken'] === 'string'
    ? (body['lineWriteLeaseToken'] as string).trim()
    : '';
  const activeLeaseToken = activeSoEditLease(before as SoEditLeaseRow);
  if ((reserveForLineWrites || completeLineWrites) && requestedLeaseToken.length < 16) {
    return c.json({ error: 'so_edit_lease_invalid', message: 'The save lease is invalid. Refresh the order and try again.' }, 400);
  }
  const hasHeaderFieldChanges = Object.keys(updates).length > 0;
  if (!hasHeaderFieldChanges && !reserveForLineWrites && !completeLineWrites) {
    return c.json({ ok: true, changed: 0 });
  }
  if (activeLeaseToken && activeLeaseToken !== requestedLeaseToken) {
    return c.json(SO_EDIT_LEASE_CONFLICT, 409);
  }

  const currentVersion = Number((before as unknown as { version?: number | string }).version ?? 1);
  if (reserveForLineWrites && activeLeaseToken === requestedLeaseToken) {
    return c.json({ ok: true, docNo, version: currentVersion, reserved: true, leaseToken: requestedLeaseToken });
  }

  const headerGrace = body.version === undefined;
  if (headerGrace && !soCasGraceOpen(soCasGrace(c))) {
    return c.json({ ...SO_VERSION_REQUIRED, currentVersion }, 428);
  }
  // Rollout grace: a pre-CAS tab keeps the old last-writer-wins semantics.
  const clientVersion = headerGrace ? currentVersion : Number(body.version);
  if (!Number.isInteger(clientVersion) || clientVersion < 1) {
    return c.json({
      error: 'so_version_invalid',
      message: 'The order version is invalid. Refresh the order before saving again.',
      currentVersion,
    }, 400);
  }
  if (clientVersion !== currentVersion) {
    return c.json(soVersionConflict(currentVersion), 409);
  }

  /* A line-only composite completes by releasing its matching lease without a
     data/version bump. Both predicates make a stale/wrong release a no-op. */
  if (!hasHeaderFieldChanges && completeLineWrites) {
    const { data: released, error: releaseError } = await sb.from('mfg_sales_orders')
      .update({ edit_lease_token: null, edit_lease_expires_at: null })
      .eq('doc_no', docNo)
      .eq('version', clientVersion)
      .eq('edit_lease_token', requestedLeaseToken)
      .select('version')
      .maybeSingle();
    if (releaseError) return c.json({ error: 'update_failed', reason: releaseError.message }, 500);
    if (!released) return c.json(SO_EDIT_LEASE_CONFLICT, 409);
    return c.json({ ok: true, docNo, version: clientVersion, released: true });
  }

  updates.updated_at = new Date().toISOString();

  /* Phone is compulsory, but unchanged values were removed above: only a
     genuine attempt to blank the stored phone is rejected. */
  if (body.phone !== undefined) {
    const patchPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!patchPhone) {
      return c.json({ error: 'phone_required', reason: 'A phone number is required on every sales order.' }, 400);
    }
  }

  /* Maintained-dropdown gate on genuine edits only. */
  const dropdownErr = await validateSoDropdownFields(sb, body, activeCompanyId(c));
  if (dropdownErr) return c.json(dropdownErr, 409);
  /* VENUE OVERRIDE (owner 2026-07-19, migration 0148) — the operator has just
     edited the venue on this order, so the value is now theirs, not the
     resolver's. Marking it MANUAL is the whole protection: canAutoResolveVenue()
     makes every automatic writer stand down on this row, so no later amendment,
     backfill or re-scan can quietly put the resolved default back.
     THIS IS THE BACKSTOP FOR BOTH BINDINGS. The salesperson is the person who
     actually knows where they are standing — a showroom rep sent to an
     exhibition, or an exhibition rep back on the floor, corrects it HERE, and
     that correction has to stick.
     The change is recorded by the `['venue', 'venue']` field-map entry, and a
     blank BESIDE a venue id is a half-written pair, not a clear (0591). */
  const vFix = await venueNameForHalfWrittenPair(sb, body['venue'], body['venueId']);
  if (vFix.kind === 'resolved') { body['venue'] = vFix.name; updates['venue'] = vFix.name; }
  if (vFix.kind === 'unresolved') { delete body['venue']; delete updates['venue']; }
  if (body['venue'] !== undefined) {
    updates['venue_source'] = 'MANUAL' satisfies VenueSource;
  }

  /* Task #121 — when customerState changes, re-derive customer_country
     from my_localities so the SO snapshot follows the new state's country.
     A null state explicitly clears the snapshot (so an SO whose state is
     wiped doesn't keep a stale country). */
  let reboundWarehouseId: string | null = null;
  let rebindLineIds: string[] = []; // un-anchored conflicts the CAS moves too

  if (body['customerState'] !== undefined) {
    updates['customer_country'] = await deriveCountryFromState(
      sb,
      body['customerState'] as string | null,
    );
    /* Commander 2026-05-29 — Location follows the address. When the State
       changes and the caller didn't also send an explicit salesLocation,
       re-derive the warehouse so Location tracks the new State. An explicit
       salesLocation in the same patch still wins (already mapped above). A
       null/unmapped State leaves Location untouched rather than wiping it. */
    if (body['salesLocation'] === undefined) {
      const derived = await deriveSalesLocationFromState(
        sb,
        body['customerState'] as string | null,
        c,
      );
      if (derived) updates['sales_location'] = derived;
    }
    /* Re-bind the per-line warehouse: the create-time derive runs only once, so
       an SO whose State was filled in / corrected AFTER creation kept its lines'
       warehouse_id NULL → "—" in MRP. Backfill the warehouse onto lines that
       don't have one yet (NULL only — explicit per-line overrides untouched).
       Wei Siang 2026-06-16.

       CONFLICT BLOCK (owner 2026-07-22 — 'supplier 就会发错货给我'), NARROWED
       2026-08-25: only a line ANCHORED by a live downstream PO/DO still 409s;
       an un-anchored bound line moves with its order like a NULL line (gate,
       fail modes and plan: lib/so-state-warehouse-rebind.ts). The rebind runs
       inside apply_so_header_cas (mig 0330, p_rebind_line_ids) — same
       transaction as the CAS, so a losing stale editor half-moves nothing. */
    const reboundWh = await deriveWarehouseIdFromState(sb, body['customerState'] as string | null, c);
    if (reboundWh) {
      const plan = await planStateRebindForDoc(sb, docNo, reboundWh);
      if (plan.offenders.length > 0) {
        return c.json(stateChangeConflictBody(reboundWh, plan.offenders), 409);
      }
      rebindLineIds = plan.rebindLineIds;
      reboundWarehouseId = reboundWh;
    }
  }

  /* Aggregate EVERY Processing-Date save gate into ONE response (owner
     2026-07-18) — the routes used to `return` on the FIRST failing gate, so the
     coordinator fixed one thing, saved, hit the next. Collect each gate's facts
     as it computes them below, then report them all at once via
     collectProcessingGateProblems. The permission (remove-forbidden), lock, and
     Proceed gates KEEP their own short-circuit returns: they are authz / a
     wholesale lock / a different action, not "fix this field and re-save" input
     problems, and each carries a distinct HTTP status. */
  let variantOffenders: VariantOffender[] = [];
  let kivOffenders: ColourKivOffender[] = [];

  /* PR — Commander 2026-05-28 — Server-side variant rule enforcement.
     When the caller sets processingDate (Processing Date) to a non-null
     value, EVERY non-cancelled line for this SO must have its category-
     required variants filled. Mirrors the UI warning in SalesOrderDetail
     (REQUIRED_BY_CATEGORY: bedframe needs divanHeight+legHeight+gap+fabricCode;
     sofa needs seatHeight+legHeight+fabricCode). Without this guard, the
     coordinator can ignore the red banner and still hit the API directly.

     Collected (not returned) — the aggregated report at the end of the gate
     block turns the offender list into per-line+axis problems. */
  if (body['processingDate'] !== undefined && body['processingDate'] !== null && body['processingDate'] !== '') {
    const { data: liveItems } = await sb
      .from('mfg_sales_order_items')
      .select('id, item_code, item_group, variants, cancelled')
      .eq('doc_no', docNo);
    // Shared with the POST create path (so-variant-check) — one rule, no drift.
    const liveLinesForCheck =
      ((liveItems ?? []) as Array<{ id: string; item_code: string; item_group: string; variants: Record<string, unknown> | null; cancelled: boolean }>)
        .filter((it) => !it.cancelled)
        .map((it) => ({ id: it.id, itemCode: it.item_code, group: it.item_group, variants: it.variants }));
    variantOffenders = findIncompleteVariantLines(liveLinesForCheck);
    /* Colour-KIV gate (owner 2026-07-24, SO-2607-016) — only when this PATCH
       genuinely SETS or CHANGES the Processing Date (unchanged values were
       dropped by the normalisation above; the compare here is belt-and-braces,
       mirroring the deposit gate below). An edit that leaves the stored date
       alone — remarks on an old KIV order — must never trip this, and clearing
       the date is handled by the non-null condition on this whole block. */
    {
      const procPatch = String(body['processingDate']).slice(0, 10);
      const origProcPatch = String(
        ((before as unknown as Record<string, unknown> | null)?.['processing_date'] as string | null) ?? '',
      ).slice(0, 10);
      if (procPatch !== origProcPatch) {
        kivOffenders = findColourKivLines(liveLinesForCheck);
      }
    }
  }

  /* HZ-C-02: every real human-editor header mutation carries the token returned
     by the detail GET. Empty or unrecognised patches returned changed:0 above,
     so they do not falsely trip this gate. Mirror ingestion and Delivery
     Planning update the base table through their own routes, not this endpoint. */
  updates.version = clientVersion + 1;

  /* Remove-Processing-Date gate (Owner 2026-07-09, port of 2990 #717) — clearing
     an already-set Processing Date pulls the SO back out of the Proceed lane (and,
     once the day has elapsed, undoes the very lock that says "this is what we PO to
     the supplier"), so the REMOVE action is admin-level only. 2990 gates on
     super_admin; Houzs has no live staff_role (the SCM bridge pins every caller to
     one super_admin row), so gate on the flat `scm.so.remove_processing_date` key
     (Owner + IT Admin pass via `*`). Setting it the first time, or moving it to
     another date, stays governed by the existing gates (payment ≥30%, variants
     complete, not-in-the-past, processing lock). */
  let superAdminClearsProc = false;
  /* Set by the date-pair block below when clearing the Processing Date also
     clears a Delivery Date the request never named. Read at the RPC call so the
     line-level cascade runs for it too. */
  let cascadedDeliveryClear = false;
  {
    const proc = body['processingDate'];
    const origProc =
      ((before as unknown as Record<string, unknown> | null)?.['processing_date'] as string | null)
      ?? null;
    if (proc !== undefined && norm(proc) === '' && origProc) {
      if (!hasHouzsPerm(c, 'scm.so.remove_processing_date')) {
        return c.json({
          error: 'processing_date_remove_forbidden',
          reason: 'Only a Super Admin can remove the Processing Date.',
        }, 403);
      }
      superAdminClearsProc = true;
    }
  }

  /* Owner 2026-06-12 — processing-date lock: once the processing day has
     passed (midnight MYT after), the SO is what we PO to the supplier — every
     header edit is rejected wholesale. Status transitions (/status route),
     the payments ledger and PO/DO conversions do NOT come through this PATCH
     and stay open. Sits AFTER the cancelled/downstream-agnostic validations
     above but before any write. (`before` carries processing_date via
     the map above.) */
  /* Owner 2026-08-12 — the PO lock (2990 only) reaches the SAME field-scoped
     diff by the other road. Evaluated once, here, so both roads share one
     rejection and a future CONTROLLED-column change cannot land on one and miss
     the other. */
  const patchDateLocked = soProcessingLocked(
    before as unknown as { processing_date?: string | null; status: string | null } | null,
  );
  const patchPoLocked = patchDateLocked ? false : await soPoLocked(sb, docNo);
  if (patchDateLocked || patchPoLocked) {
    /* Field-scoped (Loo 2026-06-13) — only a genuine change to a production-
       schedule date column is rejected; customer / address / payment header
       fields stay editable in the Proceed lane. `before` carries every patched
       column via the map snapshot above.

       Remove-Processing-Date (Owner 2026-07-09, port of 2990 #717) — an admin
       CLEARING the Processing Date is the one sanctioned way to pull a locked SO
       back, so that clear (and the paired Delivery Date clear the set-together
       rule forces with it) passes the lock. Any other schedule change — including
       the same admin moving the date instead of clearing it — still 409s; to
       reschedule a locked SO, remove the date first (unlocks), then set the new
       pair. */
    /* The diff itself lives in the shared policy module (lockedColumnsChanged)
       so it can be tested directly rather than through a copy that drifts from
       what actually ships. This IS the server-side control: a client that posts
       a CONTROLLED field here is rejected regardless of what its UI allowed. */
    const beforeRowProc = before as unknown as Record<string, unknown>;
    /* The remove-the-Processing-Date escape hatch is honoured ONLY for the date
       lock. Deleting a date does not un-raise a Purchase Order, so under the PO
       lock the same clear is just another CONTROLLED change and 409s — the way
       to release a PO-locked SO is to cancel the PO, which this guard reads
       live. Letting the hatch through here would hand every admin a one-click
       bypass of the exact rule 2990-SO-2608-017 exists to justify. */
    const changedSchedule = lockedColumnsChanged(updates, beforeRowProc, {
      superAdminClearsProcessingDate: patchDateLocked ? superAdminClearsProc : false,
    });
    if (changedSchedule.length > 0) {
      return c.json(patchDateLocked ? SO_PROCESSING_LOCKED_RESPONSE : SO_PO_LOCKED_RESPONSE, 409);
    }
  }

  /* THE EDIT PATH'S DEPOSIT GATE IS GONE — owner ruling, 2026-08-20:
     「以电脑为准 —— 两边都不查」.

     What stood here (Loo 2026-06-30) read the order total and summed
     `mfg_sales_order_payments` whenever a header PATCH SET or CHANGED the
     Processing Date, and handed the result to the aggregated report as
     `depositFacts`. It had NO waiver — the create path had one and this did not
     — so the two halves of one order's life disagreed: a hand-keyed RM 0 order
     was accepted at create and then REFUSED the moment anyone rescheduled it,
     naming a deposit the operator had been told was fine the day before. That
     asymmetry is what the owner's ruling closes, and it is closed by removing
     the condition rather than by copying the create's waiver down here.

     Two DB round-trips per dated header PATCH go with it — this block existed
     only to feed the condition, and the aggregated report below no longer has a
     money term to weigh. Everything else that block reports (variants, KIV,
     completeness, the date rules) is untouched. */

  /* THE `proceededAt` PROCEED PATH IS GONE (2026-08-18), not merely ungated.
     `['proceededAt','proceeded_at']` left the map above, so no request body can
     reach the column at all — which DELETES this block rather than loosening it.
     What stood here gated a "genuine forward Proceed" arriving as a bare
     timestamp from mobile / API. Nothing ever sent one: `grep -rn proceededAt`
     over frontend/src, native/ and e2e/ returns type declarations and comments,
     never a request body. Proceeding through this route now means one thing —
     setting `processingDate` — and that is gated by the aggregated
     Processing-Date block below, which carries the same deposit + completeness
     conditions this did, plus the variant / KIV / date rules it did not. */

  /* Commander 2026-05-28 / Owner 2026-06-01 — Processing & Delivery Date may
     only be today or a future date, BUT an already-past value the edit does NOT
     change is grandfathered through. The old rule rejected ANY past value, so an
     SO whose Processing Date had simply elapsed could never be edited again
     (e.g. to postpone the Delivery Date). Now only a genuinely NEW past value is
     rejected — an unchanged elapsed date passes. today = Malaysia UTC+8. */
  {
    const beforeRow = (before as unknown as Record<string, unknown> | null);
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const proc = body['processingDate'];
    const deliv = body['customerDeliveryDate'];
    const origProc = (beforeRow?.['processing_date'] as string | null) ?? null;
    const origDeliv = (beforeRow?.['customer_delivery_date'] as string | null) ?? null;
    /* Owner 2026-06-03 — Process Date ≤ Delivery Date (purchasing cannot be
       released to buy AFTER the goods were promised). Use the EFFECTIVE values: the patch value
       when this request sets the key, else the stored value — so editing only
       one date still validates against the other already on the row. */
    const effProc  = effectiveDateAfterPatch(proc,  origProc);
    const effDeliv = effectiveDateAfterPatch(deliv, origDeliv);
    /* Owner 2026-07-04 — Processing + Delivery are all-or-nothing (both set or
       both empty), kept as a SHORT-CIRCUIT rather than aggregated: half a date
       pair is structurally incomplete. The predicate is shared/so-processing-date's
       — this path, create, the CO paths and both amendment paths state it ONCE,
       and its grandfather carve-out lives inside it, not in a `touchesDates` flag.

       CLEARING ONE CLEARS BOTH (owner: 同时有或者同时没有). Removing the
       Processing Date is already super-admin-only (superAdminClearsProc above),
       so once authorised the Delivery Date it was promised against goes with it
       and a caller sending only `processingDate: ''` need not send the delivery
       key. Computed BEFORE the refusal, so the cascade is what the refusal is
       judged against. The reverse does NOT cascade: clearing only the delivery
       date would clear the Processing Date, the write permission guards. */
    const cascadeCols = soDatePairCascadeColumns({
      procCleared: superAdminClearsProc,
      delivInPatch: deliv !== undefined,
      origDeliv,
    });
    for (const col of cascadeCols) updates[col] = null;
    /* THE ORPHAN-STAMP LEAK was here: this cleared the date and LEFT
       `proceeded_at`, which the stamp-once filter then froze permanently — the
       shape 25 company-2 rows carry today, and the one live path that made new
       ones. It is closed by there being no stamp at all rather than by a second
       clear: since 2026-08-18 nothing on this route reads or writes that column,
       so a removed Processing Date can no longer leave anything behind. */
    /* The header column is only half the write: apply_so_header_cas cascades a
       delivery-date change down to every line_delivery_date behind
       p_apply_delivery_date, which keys off the request body. A cascade the
       body never mentioned would move the header and leave every LINE on the
       old date — the exact split MRP reads (it orders by line_delivery_date).
       Flagged here so the RPC call below applies both halves. */
    cascadedDeliveryClear = cascadeCols.length > 0;
    const effDelivAfterCascade = cascadedDeliveryClear ? null : effDeliv;
    /* THE DATE IS THE ANSWER, BOTH WAYS — shared/so-proceeded-status, 0597/0631. */
    const nextStatus = await soStatusAfterProcessingDateChange(sb, docNo, { currentStatus: beforeRecord['status'] as string | null, storedProcessingDate: origProc, effectiveProcessingDate: effProc });
    if (nextStatus) updates['status'] = nextStatus;    const pairRefusal = soDatePairRefusal({
      nextProc: effProc,
      nextDeliv: effDelivAfterCascade,
      origProc,
      origDeliv,
    });
    if (pairRefusal) return c.json(pairRefusal, 400);
    /* The aggregated report — variants (collected above), the customer/delivery
       completeness, and the past-date / processing-≤-delivery date rules, ALL in
       one response so the coordinator fixes them in a single pass. The helper
       re-derives the past-date grandfather + processing-≤-delivery from the
       effective + original dates, exactly matching the checks this block used to
       `return` on one at a time.

       No deposit term and no `companyCode` any more (owner 2026-08-20): the
       company code was here only to pick the deposit fraction, and the deposit
       is no longer a condition of this gate. */
    const problems = collectProcessingGateProblems({
      procDate: effProc,
      /* Post-cascade, so the aggregated report judges the row this save will
         actually leave behind rather than the one the body described. */
      delivDate: effDelivAfterCascade,
      todayMY,
      origProcDate: origProc,
      origDelivDate: origDeliv,
      variantOffenders,
      kivOffenders,
      /* Effective header values — the patch value when THIS request sets the
         field, else the stored one. Since 2026-08-18 this is the ONLY proceed
         gate on the route: the separate `proceededAt` branch that carried its
         own copy of these facts went with the second storage. One rule, one set
         of facts (owner 2026-07-31: Processing Date IS Proceed). Email is
         deliberately absent. */
      completeness: (() => {
        const beforeRow = before as unknown as Record<string, unknown> | null;
        const eff = (snake: string): string => {
          const v = updates[snake] !== undefined ? updates[snake] : beforeRow?.[snake];
          return v == null ? '' : String(v).trim();
        };
        return {
          hasCustomerName: !!eff('debtor_name'),
          hasAddress: !!eff('address1'),
          hasPostcode: !!eff('postcode'),
        };
      })(),
    });
    if (problems.length > 0) return c.json(validationFailedBody(problems), 422);
  }

  /* Loo 2026-06-13 — POS "Save" opt-in (recustomer:true). Detect the edited
     identity here, but defer the write-producing customer resolution until the
     header CAS wins. The changed name/phone already participate in the identity
     lock; customer_id is attached in the post-CAS safe split below. */
  const beforeRowAll = before as unknown as Record<string, unknown> | null;
  let resolvedNewCustomerId: string | null = null;
  let customerIdentityChanged = false; // name or phone changed → re-detect cross-category
  let reNewName = '';
  let reNewPhone: string | null = null;
  if (body['recustomer'] === true) {
    const nm = typeof body['debtorName'] === 'string' ? (body['debtorName'] as string).trim()
             : typeof body['customerName'] === 'string' ? (body['customerName'] as string).trim()
             : ((beforeRowAll?.['debtor_name'] as string | null) ?? '');
    const ph = typeof updates['phone'] === 'string' ? (updates['phone'] as string)
             : ((beforeRowAll?.['phone'] as string | null) ?? null);
    const nameChanged = nm !== ((beforeRowAll?.['debtor_name'] as string | null) ?? '');
    const phoneChanged = ph !== null && norm(ph) !== norm(beforeRowAll?.['phone']);
    if ((nameChanged || phoneChanged) && nm && ph) {
      customerIdentityChanged = true;
      reNewName = nm;
      reNewPhone = ph;
      /* Do not call the write-producing customer RPC here. The header CAS must
         win first; otherwise a stale editor could create/update a customer and
         still receive 409. Resolution is safely split after the CAS below —
         apply_so_header_cas calls upsert_customer_by_name_phone itself, with
         the active company id (mig 0164) so the scoped overload is used. */
    }
  }

  /* Owner 2026-05-31 — Partial header lock. Once a non-cancelled DO / SI exists,
     the IDENTITY + VALUE fields that downstream documents snapshot (customer,
     branding, addresses, ref, location, customer PO, currency, SO date, etc.)
     are frozen. Payment / remark / scheduling fields stay editable because a
     small shop records customer payment AFTER delivery. We compare the patch
     against the stored row so a UI that re-sends unchanged identity fields does
     not falsely trip the lock — only a genuine change to a locked field blocks. */
  if (before) {
    const beforeRow = before as unknown as Record<string, unknown>;
    /* Re-attribution gate (Owner 2026-08-17) — shared/so-identity-lock.ts says
       why the UI disabling the select was never the control. */
    if (salespersonReattributed(updates, beforeRow) && !hasHouzsPerm(c, 'scm.so.attribute_other')) {
      return c.json(ATTRIBUTE_OTHER_REFUSAL, 403);
    }
    const changedLocked = changedIdentityLockCols(updates, beforeRow, { agentFollowedSalesperson });
    if (changedLocked.length > 0) {
      const lock = await soHasDownstream(sb, docNo);
      if (lock) {
        return c.json({
          error: 'so_identity_locked',
          message: 'SO has a Delivery Order / Sales Invoice — customer, branding, address, reference and value fields are locked. Payment and remarks can still be edited.',
          lockedFields: changedLocked,
        }, 409);
      }
    }
  }

  const leaseExpiryIso = soEditLeaseExpiryIso();
  /* Keep a durable lease through every post-CAS follower. Composite saves reuse
     the caller token; a header-only save gets a short internal token. The lease
     is released only after followers/audit/recompute finish below. */
  const operationLeaseToken = requestedLeaseToken || crypto.randomUUID();
  updates.edit_lease_token = operationLeaseToken;
  updates.edit_lease_expires_at = leaseExpiryIso;
  updates.edit_lease_user_id = soCallerUserId(c);  // WHO holds it - 0348, docs/bugs/0630

  const casCo = requireActiveCompanyId(c); if (!casCo.ok) return c.json(casCo.refusal, 409);  // HAZARD 1
  /* The header CAS and every version-bound follower commit in ONE PostgreSQL
     transaction. A follower exception rolls the header back as well; there is
     no longer a committed-header / failed-cascade split brain. */
  const { data: casRows, error: casError } = await sb.rpc('apply_so_header_cas', {
    p_doc_no: docNo,
    p_expected_version: clientVersion,
    p_required_lease: requestedLeaseToken && !reserveForLineWrites ? requestedLeaseToken : null,
    p_patch: updates,
    p_recustomer: customerIdentityChanged,
    p_customer_name: reNewName || null,
    p_customer_phone: reNewPhone,
    p_customer_email: typeof body['email'] === 'string' && (body['email'] as string).trim()
      ? (body['email'] as string).trim()
      : null,
    p_apply_warehouse: Boolean(reboundWarehouseId),
    p_warehouse_id: reboundWarehouseId,
    // mig 0330 — cleared conflicts move with the order; null = NULL lines only.
    p_rebind_line_ids: rebindLineIds.length > 0 ? rebindLineIds : null,
    p_apply_delivery_date: body['customerDeliveryDate'] !== undefined || cascadedDeliveryClear,
    p_delivery_date: cascadedDeliveryClear ? null : dateOrNull(body['customerDeliveryDate']),
    // mig 0164 — the customer upsert inside the RPC is company-scoped. Omitting
    // this resolves every re-customer against HOUZS.
    p_company_id: casCo.companyId,  // NOT `?? null` — HAZARD 1 in docs/modules/sales-order.md
  });
  if (casError) return c.json({ error: 'update_failed', reason: casError.message }, 500);
  const cas = (Array.isArray(casRows) ? casRows[0] : casRows) as
    | { applied?: boolean; current_version?: number; resolved_customer_id?: string | null; conflict_reason?: string | null }
    | null;
  if (!cas?.applied) {
    if (cas?.conflict_reason === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (cas?.conflict_reason === 'lease') return c.json(SO_EDIT_LEASE_CONFLICT, 409);
    return c.json(soVersionConflict(Number(cas?.current_version ?? currentVersion)), 409);
  }
  const savedVersion = Number(cas.current_version ?? clientVersion + 1);
  resolvedNewCustomerId = cas.resolved_customer_id ?? null;

  /* A reservation is deliberately only version+timestamp. It proves the
     editor still owns the loaded header token before any line call is sent,
     and must not run header followers/audit/allocation as if data changed. */
  if (!hasHeaderFieldChanges && reserveForLineWrites) {
    return c.json({ ok: true, docNo, version: savedVersion, reserved: true, leaseToken: operationLeaseToken });
  }

  /* Customer identity changed → the minted vouchers follow the order, and the
     cross-category delivery fee re-detects against the new customer. PWP PRODUCT
     prices are deliberately UNTOUCHED. Best-effort: the header is already saved;
     a failure here is logged, not surfaced. */
  let crossCategoryRedetect: { isFollowup: boolean; sourceDocNo: string | null; total: number } | null = null;
  if (customerIdentityChanged) {
    try {
      crossCategoryRedetect = await redetectCrossCategoryDelivery(sb, docNo, reNewName, reNewPhone, c);
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.error('[mfg-so] customer-change re-detect failed:', e);
    }
  }

  /* PR-D — Audit log row capturing field-level from→to diff. */
  if (before) {
    // Cast via `unknown` first: Supabase types the joined select result as
    // `GenericStringError` until proven typed, which doesn't structurally
    // overlap with our Record. The runtime shape IS a Record though, so the
    // double-cast is safe.
    const beforeRow = before as unknown as Record<string, unknown>;
    const fieldChanges = diffFields(beforeRow, body, map);
    if (fieldChanges.length > 0) {
      await recordSoAudit(sb, {
        docNo,
        action: 'UPDATE_DETAILS',
        actorId: user.id,
        actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
        fieldChanges,
        statusSnapshot: (beforeRow as { status?: string }).status ?? null,
      });
    }
  }

  /* SO header edit may have changed customer_delivery_date or
     allocation_warehouse_id — both reshuffle the allocation queue. Recompute.
     Best-effort, and DEFERRED: this sweep is global (2,784 SOs / 14,076 lines,
     ~25-30 PostgREST pages) and was 10 of the 10.6 seconds an operator waited
     for a one-field save. The save answers immediately and the projection
     settles behind it. See deferAllocationRecompute for what that does and does
     not buy.

     WHY THIS IS SAFE NEXT TO THE LEASE RELEASE BELOW, which keys off
     `version = savedVersion` and so would break if the sweep bumped the version
     first. It cannot. The sweep's only header write is advanceSoGeneration,
     which both refuses when a lease is active AND carries
     `edit_lease_token IS NULL OR expired` in its UPDATE predicate — so while we
     still hold the lease it cannot touch this row, and once the release below
     has run there is no longer a version for it to invalidate. Both
     interleavings are correct.

     One behaviour change falls out of that, and it is an improvement: the
     awaited version ALWAYS ran while our own lease was held, so this SO's
     header was always skipped ('lease' deferral) and left to the 5-minute cron.
     The deferred sweep reaches its header pass after the release, so the order
     now advances to READY_TO_SHIP in its own save's pass. */
  deferAllocationRecompute(c, sb, 'post-header-patch');

  const { data: releasedLease, error: releaseLeaseError } = await sb.from('mfg_sales_orders')
    .update({ edit_lease_token: null, edit_lease_expires_at: null })
    .eq('doc_no', docNo)
    .eq('version', savedVersion)
    .eq('edit_lease_token', operationLeaseToken)
    .select('version')
    .maybeSingle();
  if (releaseLeaseError) {
    return c.json({ error: 'so_edit_lease_release_failed', message: 'The order saved, but the edit lock could not be released. It clears itself within a minute — wait, then edit again.' }, 500);
  }
  /* The header CAS ALREADY COMMITTED above. A 0-row lease release means our
     lease was rotated/expired underneath us, NOT that the save lost a race —
     reporting soVersionConflict here told the operator "someone else updated
     this order" about a save that actually succeeded, and they re-sent it.
     Report the truth: saved, lock not ours to clear (it expires on its own). */
  if (!releasedLease) {
    // eslint-disable-next-line no-console
    console.warn('[mfg-so] header saved but edit lease was no longer ours to release:', docNo, savedVersion);
  }

  /* The header PATCH is the ONE caller that can clear a field, and
     Object.keys(updates) is exactly the set it wrote — the loop above only adds
     a key when the request body carried it. */
  await queueAcSoEdit(c, docNo, [], [], Object.keys(updates));

  return c.json({
    ok: true,
    docNo,
    /* The bumped token, so a version-aware editor can advance its pinned value
       after a successful Save without waiting for the detail refetch. */
    version: savedVersion,
    ...(crossCategoryRedetect ? {
      deliveryRedetected: true,
      crossCategory: crossCategoryRedetect.isFollowup,
      crossCategorySourceDocNo: crossCategoryRedetect.sourceDocNo,
      deliveryFeeSen: crossCategoryRedetect.total,
    } : {}),
  });
};

mfgSalesOrders.patch('/:docNo', patchMfgSalesOrderHeaderHandler);

// ── Item CRUD ─────────────────────────────────────────────────────────
//
// Each mutation recomputes the header totals + category breakdown so the
// list view stays accurate without a separate refresh step.
// Exported so the free-gift reconciler (lib/free-gift-reconcile.ts) can finish
// with the SAME authoritative roll-up the edit endpoints used to call directly.
// route<->lib function cycle is safe (not invoked at module-eval time).
//
// Fails CLOSED and never throws (2026-07-17) — the two halves are separate
// decisions. It must not WRITE from a read it cannot vouch for: every read below
// aborts the whole recompute on error, because a header written from partial
// data is a lie that looks like a fact, while a stale header is merely old and
// self-heals on the next successful edit. It must not THROW to say so, and that
// is true at EVERY caller for one structural reason: this roll-up only ever runs
// AFTER its triggering mutation has already committed (create inserts the header
// with its own inline totals, then calls this to correct the sofa-combo cost; the
// line PATCHes write the line first; free-gift-reconcile.ts calls it last and
// deliberately "even if the reconcile pass above threw"). A throw here cannot
// undo any of that — it can only turn a committed write into a 500 the client
// retries, which on the create path is a DUPLICATE ORDER (the #657/#658 scar).
// So: log and abort. Matches the sibling contract at recomputeDeliveryFeeCore
// ("Best-effort: logs DB errors, never throws") and the non-fatal try/catch
// so-revision.ts already wraps this path in.
export async function recomputeTotals(sb: any, docNo: string, c: any) {
  const { data: items, error: itemsErr } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, variants, qty, total_sen, line_cost_sen')
    .eq('doc_no', docNo).eq('cancelled', false);
  /* A failed READ is not an empty SO — and `?? []` cannot tell them apart.
     supabase-js resolves a failed select to { data: null, error } and does NOT
     throw (shouldThrowOnError defaults false; nothing here calls .throwOnError),
     so on a transient REST blip `data ?? []` used to hand the roll-up below an
     empty line list and the UPDATE wrote local_total / balance / revenue /
     margin / every category bucket / line_count to ZERO on an order whose lines
     were intact — silently, and looking exactly like a legitimately empty SO.
     The ERROR is the signal, never the emptiness: a genuinely empty SO (every
     line cancelled) resolves error === null with data === [] and MUST still fall
     through to zero the header. Abort without writing: the header keeps its
     previous totals, which are stale at worst and self-heal on the next edit.
     See BUG-HISTORY 2026-07-17 (fix/s1-recompute-silent). */
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[so-recompute] item read failed — header left unchanged:', docNo, itemsErr.message);
    return;
  }
  type Row = { id: string; item_code: string; item_group: string; variants: Record<string, unknown> | null; qty: number; total_sen: number; line_cost_sen: number };
  const rows = (items ?? []) as Row[];

  /* ── Master sofa-combo COST spread (Commander 2026-05-29) ──────────────────
     A sofa is a set of per-module lines. When those lines (same base model)
     match a MASTER combo (sofa_combo_pricing where supplier_id IS NULL — the
     Product-Maintenance combo), the set's COST = the combo price, spread across
     the matched lines (mirror of the PO side, but master-scoped). We spread off
     the stored per-line line_cost_sen (the per-module base cost). Idempotent:
     spreadComboTotal re-normalises an already-spread group to the same total. */
  const sofaRows = rows.filter((r) => (r.item_group ?? '').toLowerCase() === 'sofa');
  if (sofaRows.length > 0) {
    const combos = await loadActiveSofaCombos(sb, c); // master scope only
    if (combos.length > 0) {
      const fabricCodes = [...new Set(sofaRows.map((r) => String((r.variants ?? {} as Record<string, unknown>).fabricCode ?? '')).filter(Boolean))];
      const tierByFabric = new Map<string, SofaPriceTier>();
      if (fabricCodes.length > 0) {
        const { data: fabs, error: fabsErr } = await scopeToCompany(
          sb.from('fabric_trackings').select('fabric_code, price_tier, sofa_price_tier').in('fabric_code', fabricCodes),
          c,
        );
        /* Same collapse as the item read, one step subtler: an empty tier map
           does not skip the combo, it makes every fabric fall to the PRICE_2
           default below — so a failed read would pick a REAL combo at the WRONG
           tier and write that cost to the header as fact. A fabric row that
           genuinely carries no tier still defaults; only the error aborts. */
        if (fabsErr) {
          /* eslint-disable-next-line no-console */
          console.error('[so-recompute] fabric tier read failed — header left unchanged:', docNo, fabsErr.message);
          return;
        }
        for (const f of (fabs ?? []) as Array<{ fabric_code: string; price_tier: SofaPriceTier | null; sofa_price_tier: SofaPriceTier | null }>) {
          tierByFabric.set(f.fabric_code, (f.sofa_price_tier ?? f.price_tier ?? 'PRICE_2'));
        }
      }
      const groups = new Map<string, Row[]>();
      for (const r of sofaRows) {
        const { baseModel, sizeCode } = splitSofaCode(r.item_code);
        /* Audit 2026-06-11 I-1 — the old `sizeCode.includes('-')` gate was a
           legacy dash-vocabulary sniff that skipped EVERY canonical parens
           module (`1A(LHF)`) AND whole-unit codes (1S/2S/3S), making this
           whole spread dead code since the 2026-06-04 vocabulary unification.
           Module-set matching is pickComboMatch's job (it already rejects
           non-matching sets); we only skip codes with no module token at all. */
        if (!sizeCode) continue; // bare model code → nothing to match
        const key = baseModel.toUpperCase();
        const arr = groups.get(key) ?? [];
        arr.push(r); groups.set(key, arr);
      }
      for (const [bm, members] of groups) {
        const tierOf = (m: Row) => tierByFabric.get(String((m.variants ?? {} as Record<string, unknown>).fabricCode ?? '')) ?? 'PRICE_2';
        const tiers = new Set(members.map(tierOf));
        if (tiers.size !== 1) continue;
        const tier = [...tiers][0]!;
        const heights = new Set(members.map((m) => sofaHeightKey(m.variants)));
        if (heights.size !== 1) continue;
        const height = [...heights][0]!;
        if (!height) continue;
        /* Audit 2026-06-11 I2 — combos must match the SAME base model only
           (owner rule: no cross-model fallback). Module codes are a shared
           vocabulary, so falling back to ALL combos let a Model with no combos
           silently take another Model's combo price as its set cost. */
        const pool = combos.filter((cmb) => (cmb.baseModel ?? '').toUpperCase() === bm);
        if (pool.length === 0) continue; // no combo named for this Model → no combo
        const match = pickComboMatch(
          { baseModel: '', modules: members.map((m) => splitSofaCode(m.item_code).sizeCode), customerId: null, tier, height },
          pool,
        );
        if (!match) continue;
        const matched = match.matchedIndices.map((i) => members[i]).filter((m): m is Row => !!m);
        if (matched.length === 0) continue;
        /* Audit 2026-06-11 I1 — the combo price is ONE set; line_cost_sen is
           a LINE total (unit × qty). Owner rule: combo cost MUST multiply by
           qty. Uniform qty q across the matched lines → q sets → comboTotal×q.
           Mixed qtys → no clean set count → SKIP the combo and keep the
           per-module costs (never under-book). */
        const qtySet = new Set(matched.map((m) => Math.max(1, m.qty || 1)));
        if (qtySet.size !== 1) continue;
        const uniformQty = [...qtySet][0]!;
        const comboTotal = match.comboPriceSen * uniformQty;
        if (comboTotal <= 0) continue;
        const spread = spreadComboTotal(matched.map((m) => m.line_cost_sen || 0), comboTotal);
        for (let i = 0; i < matched.length; i++) {
          const m = matched[i]!; const newLineCost = spread[i] ?? 0; const q = Math.max(1, m.qty || 1);
          m.line_cost_sen = newLineCost; // mutate in place so the rollup below sees it
          const { error: spreadErr } = await sb.from('mfg_sales_order_items').update({
            line_cost_sen:   newLineCost,
            unit_cost_sen:   Math.round(newLineCost / q),
            line_margin_sen: (m.total_sen || 0) - newLineCost,
          }).eq('id', m.id);
          /* The in-memory mutation above already fed this cost to the roll-up,
             so a failed line write would have the header assert a cost its own
             lines do not carry. There is no transaction here to undo the sibling
             lines that did land; leaving the header alone keeps the ONE row every
             list, report and margin reads honest, and the spread is idempotent so
             the next successful edit re-rolls the whole group. */
          if (spreadErr) {
            if (sb?.__atomicCommand === true) {
              throw new Error(`SO combo cost spread failed: ${spreadErr.message}`);
            }
            /* eslint-disable-next-line no-console */
            console.error('[so-recompute] combo cost spread failed — header left unchanged:', docNo, m.id, spreadErr.message);
            return;
          }
        }
      }
    }
  }

  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, service = 0, total = 0, totalCost = 0;
  // Task #114 — per-category cost mirrors the revenue accumulators. Each
  // bucket below tracks both revenue (total_sen) and cost (line_cost_sen)
  // so the SO header's cost columns (migration 0079 + 0155) stay in sync
  // with the revenue columns.
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0, serviceCost = 0;
  for (const it of rows) {
    const lineTotal = it.total_sen || 0;
    const lineCost  = it.line_cost_sen || 0;
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    /* SO-SKU spec P2 (D1) — SERVICE lines get their own bucket; checked
       FIRST so a service line can never leak into the goods buckets. */
    if (isServiceLine({ itemGroup: g, itemCode: it.item_code })) {
      service += lineTotal;
      serviceCost += lineCost;
    } else if (g.includes('mattress') || g.includes('sofa')) {
      mattressSofa += lineTotal;
      mattressSofaCost += lineCost;
    } else if (g.includes('bedframe')) {
      bedframe += lineTotal;
      bedframeCost += lineCost;
    } else if (g.includes('accessor')) {
      accessories += lineTotal;
      accessoriesCost += lineCost;
    } else {
      others += lineTotal;
      othersCost += lineCost;
    }
  }
  // Delivery fee (migration 0133) — header-only on legacy SOs, so the lines-
  // only roll-up would erase it there. P2 transition rule: the SVC-DELIVERY*
  // LINES are the truth when they exist (their amounts are already inside
  // `service`/`total` above — folding the header snapshot back in would
  // double-count); only a line-less legacy SO still reads the header back.
  // ⚠️ DO NOT DELETE this fallback without retiring the delivery_fee_sen
  // header column itself (SO-SKU spec §5 P6 — Loo decides the retirement).
  //
  // ⚠️ This fallback is for LEGACY line-less SOs ONLY, and it is the half of
  // the 2990-SO-2608-006 back door (owner ruling 2026-08-07: every ringgit is
  // a LINE): a MODERN SO whose SVC-DELIVERY* lines were deleted/cancelled fell
  // into this branch and its total silently re-absorbed the orphaned header
  // snapshot with no line saying why. The other half is closed at the source —
  // recomputeDeliveryFeeCore no longer bails on "no fee lines" when the header
  // still carries a fee; it re-materialises the lines through the one true
  // derivation (0214 RPC), so every edit path exits with lines and this branch
  // stays unreachable for it. Stragglers (SOs not edited since) are listed by
  // backend/scripts/check-so-fee-line-integrity.mjs and repaired (DRY-RUN
  // gated) by repair-so-fee-line-integrity.mjs.
  const hasDeliveryFeeLines = rows.some((r) => isDeliveryFeeServiceCode(r.item_code));
  let deliverySen = 0;
  if (!hasDeliveryFeeLines) {
    const { data: hdrFee, error: hdrErr } = await sb
      .from('mfg_sales_orders')
      .select('delivery_fee_sen')
      .eq('doc_no', docNo)
      .maybeSingle();
    /* A failed read here reads as "this legacy SO carries no delivery fee" and
       would silently write a total SHORT by that fee. A real null (no fee) is
       error === null and still legitimately means zero. */
    if (hdrErr) {
      /* eslint-disable-next-line no-console */
      console.error('[so-recompute] delivery fee read failed — header left unchanged:', docNo, hdrErr.message);
      return;
    }
    deliverySen = Number((hdrFee as { delivery_fee_sen?: number } | null)?.delivery_fee_sen ?? 0);
  }
  const grandTotal  = total + deliverySen;
  const grandMargin = grandTotal - totalCost;
  const { error: updErr } = await sb.from('mfg_sales_orders').update({
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    /* SO-SKU spec P2 (D1, migration 0155). */
    service_sen: service,
    service_cost_sen: serviceCost,
    // Task #114 — per-category cost (migration 0079).
    mattress_sofa_cost_sen: mattressSofaCost,
    bedframe_cost_sen:      bedframeCost,
    accessories_cost_sen:   accessoriesCost,
    others_cost_sen:        othersCost,
    local_total_sen: grandTotal,
    balance_sen: grandTotal,
    total_cost_sen: totalCost,
    total_revenue_sen: grandTotal,
    total_margin_sen: grandMargin,
    margin_pct_basis: grandTotal > 0 ? Math.round((grandMargin / grandTotal) * 10000) : 0,
    line_count: rows.length,
    updated_at: new Date().toISOString(),
  }).eq('doc_no', docNo);
  /* The write's own result was discarded until 2026-07-17, so a rejected UPDATE
     (e.g. a 23502 from a non-finite figure — see the money guard above) left the
     header STALE with nothing logged and every caller reporting success. Logged,
     not thrown: see the header note on why this roll-up never throws. */
  if (updErr) {
    if (sb?.__atomicCommand === true) {
      throw new Error(`SO totals update failed: ${updErr.message}`);
    }
    /* eslint-disable-next-line no-console */
    console.error('[so-recompute] header update failed — totals left STALE:', docNo, updErr.message);
  }
}

mfgSalesOrders.post('/:docNo/items', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  /* Trimmed — a whitespace-only code used to pass this truthy check and then
     slide through validateItemCodes' skip-as-no-op (owner 2026-08-08: every
     line is a catalog SKU, so an add-line ALWAYS names one). */
  if (!String(it.itemCode ?? '').trim()) return c.json({ error: 'item_code_required' }, 400);

  /* Edge #4 — itemCode catalog guard. requireActive: an add-line is a NEW
     pick, and the picker only offers ACTIVE products. */
  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c), { requireActive: true });
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown, codeCheck.inactive), 409);
  }

  /* Tier 2 downstream-lock — line-add is blocked once a DO / SI exists. */
  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  /* TBC fill-in (Loo 2026-06-11) — self-scoped selling roles only touch
     their own SO. */
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  /* AUTHZ BEFORE CONCURRENCY (2026-07-22) — the self-scope gate above now runs
     BEFORE the edit lease. A caller who may not touch this order at all used to
     be told "This order is being saved on another screen; wait a moment and try
     Save again" — a permission refusal wearing a conflict's clothes, which
     invites an endless retry and never surfaces the real reason. */
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  /* Composition guard (Loo 2026-06-11) — the create-path MAIN-mix rule
     (sofa never shares a bill with bedframe / mattress, PR #519) now also
     holds when a line is ADDED later. Only a change that INTRODUCES the
     violation is rejected — a pre-rule SO that already mixes is left
     editable (grandfathered). */
  {
    const mainMix = await lineMixRefusal(sb, 'mfg_sales_order_items', docNo, null, it.itemCode as string, activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  /* PR-E — pull customer_delivery_date alongside debtor/agent/venue so a
     line added later still inherits the SO header's delivery date by
     default. Client can override by sending lineDeliveryDate explicitly. */
  const { data: header } = await sb.from('mfg_sales_orders').select('debtor_code, debtor_name, agent, branding, venue, customer_delivery_date, customer_state, sales_location, processing_date, status, customer_id').eq('doc_no', docNo).maybeSingle();
  if (!header) return c.json({ error: 'not_found' }, 404);
  /* Owner 2026-06-12 — processing-date lock: no line ADD once a CONFIRMED-or-later
     SO's processing day has passed (already PO'd to the supplier). Owner
     2026-08-12 — nor once a live PO actually exists (2990), which is the case
     this rule was always describing and only sometimes catching. */
  if (soProcessingLocked(header as { processing_date?: string | null; status: string | null })) {
    return c.json(SO_PROCESSING_LOCKED_RESPONSE, 409);
  }
  if (await soPoLocked(sb, docNo)) {
    return c.json(SO_PO_LOCKED_RESPONSE, 409);
  }
  /* Commander 2026-05-31 — a line added later inherits the SO state's warehouse
     by default (migration 0118). Explicit it.warehouseId override wins. */
  /* The line inherits the ORDER'S warehouse (resolveSoWarehouseId: recorded
     sales_location first, then State). It used to read the State ALONE, so a
     line added to an order located any other way landed NULL and could never
     allocate — 2990-SO-2608-045's hand-added pillow (docs/bugs/0541). */
  const addLineWarehouseId = (it.warehouseId as string | null | undefined)
    ?? resolveSoWarehouseId(
      {
        sales_location: (header.sales_location as string | null) ?? null,
        customer_state: (header.customer_state as string | null) ?? null,
      },
      await loadSoWarehouseMasters(sb, (q) => scopeToCompany(q, c)),
    );

  /* POS line quantity (Loo 2026-06-12) — same 422 gate as POST / (review
     found the create-only gate left qty 0 free-line inserts open here). */
  const badQty = invalidQtyResponse(it.qty, it.itemCode);
  if (badQty) return c.json(badQty, 422);
  /* Owner 2026-07-17 — see unexplainedExtraAddonResponse. Gating create only
     would leave the same unexplained charge reachable one click later via
     "add line", which is exactly how the qty gate above was found short. */
  const badExtra = unexplainedExtraAddonResponse(it.variants, it.itemCode);
  if (badExtra) return c.json(badExtra, 422);
  const qty = Number(it.qty ?? 1);
  const discount = Number(it.discountSen ?? 0);
  // MFG-PRICING-ENGINE — Recompute unit price server-side. Same path as
  // POST /. Drift > 0.5% returns HTTP 400 with the breakdown so the UI can
  // show what went wrong.
  const itemCodeStr = String(it.itemCode ?? '');
  const variantsObj = (it.variants as MfgItemForRecompute['variants']) ?? null;
  /* PR #216 — allowed_options check on add-item. Same shape as POST /. */
  {
    const { product, model, lookupError } = await loadProductAndModel(sb, itemCodeStr, activeCompanyId(c));
    // A failed catalog read is ignorance, not permission — refuse, don't skip the gate.
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(
      product,
      model,
      variantsObj as Parameters<typeof checkAllowedOptions>[2],
    );
    if (aoErr) return c.json({ ...aoErr, itemCode: itemCodeStr }, 400);
  }
  /* Go-live review #6 — variant completeness on the LINE routes. The header
     POST/PATCH already blocks setting a Processing Date while any line has
     blank category-mandatory variants (findIncompleteVariantLines), but a line
     ADDED to an already processing-dated SO skipped that check — so a fabric
     could be blanked on an order purchasing was already released to buy. Re-run the
     shared guard on this added line when the SO carries a Processing Date
     (processing_date). Same 409 shape the header path returns. */
  if ((header as { processing_date?: string | null }).processing_date) {
    const addedLine = [{
      itemCode: itemCodeStr,
      group: (it.itemGroup as string | null | undefined) ?? null,
      variants: variantsObj as Record<string, unknown> | null,
    }];
    const offenders = findIncompleteVariantLines(addedLine);
    if (offenders.length > 0) {
      return c.json({
        error: 'variants_incomplete',
        message: 'Processing Date requires all category-mandatory variants on every line.',
        offenders,
      }, 409);
    }
    /* Colour-KIV (owner 2026-07-24, SO-2607-016) — the header gate blocks
       SETTING a Processing Date while a line is KIV; this closes the mirror
       hole of ADDING a KIV line to an SO that already carries one. Same 409
       shape as the variants gate above. */
    const kiv = findColourKivLines(addedLine);
    if (kiv.length > 0) {
      return c.json({
        error: 'fabric_colour_kiv',
        message: `${itemCodeStr} — fabric colour is still KIV. This order already has a Processing Date, so confirm the colour before adding the line.`,
        offenders: kiv,
      }, 409);
    }
  }
  const [cachedConfig, productLite, fabricLite, sofaCombosLite, sellingTiersLite, fabricAddonConfigLite, specialAddonsLite, modelOverridesLite, compartmentOverridesLite] = await Promise.all([
    loadMaintenanceConfig(sb),
    loadProductByCode(sb, itemCodeStr, activeCompanyId(c)),
    loadFabricByCode(sb, variantsObj?.fabricCode ?? null),
    loadActiveSofaCombos(sb, c),
    loadFabricSellingTiers(sb, (variantsObj as { fabricId?: string } | null)?.fabricId ?? null),
    loadFabricTierAddonConfig(sb, activeCompanyId(c)),
    loadSpecialAddons(sb),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  // SOFA-SELLING-PLAN — per-Model module SELLING prices for the sofa drift gate.
  // Audit 2026-06-11 C2 — module COST rows so a build's cost = Σ module costs.
  const [sofaModulePricesLite, sofaModuleCostRowsLite] = productLite?.category === 'SOFA'
    ? await Promise.all([
        loadModelSofaModulePrices(
          sb,
          productLite.base_model,
          String((variantsObj as { depth?: unknown } | null)?.depth ?? '24'),
          activeCompanyId(c),
        ),
        loadModelSofaModuleCostRows(sb, productLite.base_model, activeCompanyId(c)),
      ])
    : [null, null];
  /* Free Item Campaign (add-line path, Task 4) — body field `freeItemCampaignId`
     opts a single added line into server-validated forced-RM0. Mutually exclusive
     with PWP (both cannot apply to the same line). Check mutual exclusion BEFORE
     the PWP claim so we never burn a code and then reject. */
  const addLineFreeItemCampaignId = String((it.freeItemCampaignId as string | null | undefined) ?? '').trim();
  const addLinePwpCodeEarly = String((variantsObj as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim();
  if (addLineFreeItemCampaignId && addLinePwpCodeEarly) {
    return c.json({ error: 'free_and_pwp_exclusive', reason: 'A line cannot be both a free-item and a PWP reward.' }, 400);
  }
  // Resolved after validation below — { campaignId, campaignName } or null.
  let addLineFreeItem: { campaignId: string; campaignName: string } | null = null;

  /* PWP claim (add-line path) — mirrors the create-path loop for ONE code.
     If the client sends variants.pwpCode we attempt to claim the voucher now,
     BEFORE recompute so the PWP base feeds the drift gate correctly.
     On rejection we return 409 (same shape as create). On success we carry
     `addLinePwpClaimed` for rollback on a subsequent insert failure. */
  let addLinePwpBaseSen: number | null = null;
  let addLinePwpSofaComboIds: string[] | null = null;
  let addLinePwpClaimed: { code: string; companyId: number; prevStatus: string } | null = null;
  const addLinePwpCode = String((variantsObj as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim();
  if (addLinePwpCode) {
    /* PWP reward qty lock (Loo 2026-06-12) — a reward line must be exactly 1
       unit; the claim helper enforces this too, but a fast 422 mirrors the
       create-path pattern so the error shape is consistent. */
    if (qty !== 1) {
      return c.json({
        error: 'invalid_qty',
        reason: 'A PWP reward line must have quantity 1.',
        itemCode: itemCodeStr,
        qty,
      }, 422);
    }
    /* Same-cart ownership — the helper compares owner_staff_id against this arg,
       so it must be the identity /pwp-codes reserve stamps, not the bridge's pin
       (which made every RESERVED code redeemable by any caller). '' when
       unresolved: the helper takes a plain string, and an unidentified caller
       owns no RESERVED code, so '' correctly matches none while leaving an
       AVAILABLE voucher redeemable. */
    const addLineOwnerStaffId =
      (await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id)) ?? '';
    /* mig 0188 re-keyed pwp_codes on (company_id, code), so `.eq('code', ...)`
       alone means "whichever company's row comes back first" on the path that
       BURNS the voucher. */
    const pwpCompanyId = activeCompanyId(c);
    if (pwpCompanyId == null) {
      return c.json({
        error: 'company_unresolved',
        message: 'Cannot tell which company this order belongs to right now. Reload and try again.',
      }, 409);
    }
    const pwpClaimResult = await claimPwpForSingleLine(sb, {
      code: addLinePwpCode,
      companyId: pwpCompanyId,
      docNo,
      itemCode: productLite?.code ?? itemCodeStr,  // resolved catalog SKU — matches create audit
      product: {
        category:      productLite?.category ?? '',
        model_id:      productLite?.model_id ?? null,
        base_model:    productLite?.base_model ?? null,
        pwp_price_sen: productLite?.pwp_price_sen ?? null,
      },
      customerId:    (header.customer_id as string | null) ?? null,
      ownerStaffId:  addLineOwnerStaffId,
      qty,
      variants:      variantsObj as Record<string, unknown> | null,
    });
    if (pwpClaimResult.rejection) {
      return c.json({
        error:  'pwp_code_rejected',
        code:   pwpClaimResult.rejection.code,
        reason: pwpClaimResult.rejection.reason,
      }, 409);
    }
    addLinePwpBaseSen      = pwpClaimResult.pwpBaseSen;
    addLinePwpSofaComboIds = pwpClaimResult.pwpSofaComboIds;
    addLinePwpClaimed      = pwpClaimResult.claimed;
  }

  /* Free Item Campaign validation (Task 4) — if freeItemCampaignId was supplied,
     verify it against active campaigns + the line's model/category/build before
     persisting anything. Mirrors the create-path block (~2111-2159). */
  if (addLineFreeItemCampaignId) {
    const addLineActiveCampaigns = await loadActiveFreeItemCampaigns(sb);
    const addLineComboModulesById = new Map<string, string[][]>(
      sofaCombosLite.map((cb) => [cb.id, cb.modules]),
    );
    const addLineCells = (variantsObj as { cells?: Array<{ moduleId?: unknown }> } | null)?.cells ?? [];
    const addLineBuiltModuleIds = Array.isArray(addLineCells)
      ? addLineCells.map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
      : [];
    const addLineCovering = campaignsCoveringLine(
      {
        category:       String(productLite?.category ?? ''),
        modelId:        productLite?.model_id ?? null,
        sizeCode:       productLite?.size_code ? String(productLite.size_code).toUpperCase() : null,
        builtModuleIds: addLineBuiltModuleIds,
      },
      addLineActiveCampaigns,
      addLineComboModulesById,
    );
    const addLineChosen = addLineCovering.find((camp) => camp.id === addLineFreeItemCampaignId);
    if (!addLineChosen) {
      if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
      return c.json({ error: 'free_item_not_eligible', reason: 'not_eligible' }, 409);
    }
    if (qty > addLineChosen.maxFreeQty) {
      if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
      return c.json({ error: 'free_item_not_eligible', reason: 'over_cap' }, 409);
    }
    // Resolved: stamp the server-resolved name so the UI never depends on a client string.
    addLineFreeItem = { campaignId: addLineChosen.id, campaignName: addLineChosen.name };
  }

  const addLinePosTablet = await isPosTabletCaller(c);
  const recomputed = recomputeFromSnapshot(
    {
      itemCode:       itemCodeStr,
      itemGroup:      String(it.itemGroup ?? 'others'),
      qty,
      unitPriceSen: Number(it.unitPriceSen ?? 0),
      variants:       variantsObj,
    },
    productLite,
    fabricLite,
    cachedConfig,
    sofaCombosLite,
    sofaModulePricesLite,
    sellingTiersLite,
    fabricAddonConfigLite,
    addLinePwpBaseSen,       // pwpBaseSen — claimed above, or null for non-PWP lines
    addLinePwpSofaComboIds,  // pwpSofaComboIds — claimed above, or null
    specialAddonsLite,
    sofaModuleCostRowsLite,
    modelOverridesLite,      // migration 0175 — per-Model Δ
    compartmentOverridesLite, // migration 0025 — per-compartment Δ
    // owner ruling — non-POS author prices freely; see erpLineTrust.
    erpLineTrust(addLinePosTablet, Number(it.unitPriceSen ?? 0), it.zeroPriceIntended, false),
  );
  /* Pricing trust boundary (Owner 2026-05-31, see isPosTabletCaller). POS tablet
     roles are drift-rejected + take the server price; Backend / office authors
     set the selling price freely.
     Free Item Campaign (Task 4) — drift check is SKIPPED for a validated free
     line (unit will be forced to 0 below; client always submits 0, so there is
     no meaningful drift to gate on — and the cap check already enforced qty). */
  const posTablet = await isPosTabletCaller(c);
  if (posTablet && recomputed.drift && !addLineFreeItem) {
    /* Rollback any PWP claim before rejecting — must not burn a code on drift. */
    if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
    return c.json({
      error:    'pricing_drift',
      reason:   'The price for this item is out of date — please refresh and try again.',
      itemCode: itemCodeStr,
      client:   Number(it.unitPriceSen ?? 0),
      server:   recomputed.unit_price_sen,
      breakdown: recomputed.breakdown,
    }, 400);
  }
  /* Carry the bound price-list figure out (costing-only Backend sends no real
     selling price). POS drift rejects above; Backend drift saves silently.
     Free Item Campaign (Task 4) — forced to 0 when validated above. */
  const unit = addLineFreeItem ? 0 : recomputed.unit_price_sen;
  /* Audit 2026-06-11 C-2 — same discount gate as POST /: client-authored
     discount must sit in [0, qty × unit] (422, reject-don't-normalize). */
  if (!Number.isFinite(discount) || discount < 0 || discount > qty * unit) {
    /* Rollback any PWP claim before rejecting — must not burn a code on invalid discount. */
    if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
    return c.json({
      error:    'invalid_discount',
      reason:   'discountSen must be between 0 and qty × unit price.',
      itemCode: itemCodeStr,
      discount,
      max:      qty * unit,
    }, 422);
  }
  const lineTotal = (qty * unit) - discount;
  // Commander 2026-05-28 — server-computed cost (base + Σ backend priceSen
  // surcharges) wins. Fall back to mfg_products.cost_price_sen / explicit
  // client cost only when the recompute produced no cost.
  const unitCost = recomputed.unit_cost_sen > 0
    ? recomputed.unit_cost_sen
    : await snapshotUnitCostSen(sb, itemCodeStr, Number(it.unitCostSen ?? 0), c);
  const lineCost = unitCost * qty;
  /* Same size-variant description guard the create path runs — an added line
     must not be able to smuggle in another size's SKU name either. */
  const sizeSkuMap = await loadSizeSkuMap(sb, [itemCodeStr], c);
  /* PR-E — same inheritance rule as POST /. Explicit per-line value wins
     (and flips overridden=true unless the client says otherwise);
     otherwise fall back to header.customer_delivery_date with
     overridden=false so the line tracks future header changes. */
  const hasExplicitLineDate = it.lineDeliveryDate !== undefined && it.lineDeliveryDate !== null;
  const lineDeliveryDate = hasExplicitLineDate
    ? (it.lineDeliveryDate as string | null)
    : (header.customer_delivery_date as string | null) ?? null;
  const lineDeliveryDateOverridden = hasExplicitLineDate
    ? (it.lineDeliveryDateOverridden === undefined ? true : Boolean(it.lineDeliveryDateOverridden))
    : Boolean(it.lineDeliveryDateOverridden ?? false);
  /* 0165 — continue the doc's line numbering; a pre-0165 doc (max NULL)
     stays un-numbered so its lines keep one consistent ordering regime. */
  const { data: maxNoRow } = await sb
    .from('mfg_sales_order_items')
    .select('line_no')
    .eq('doc_no', docNo)
    .order('line_no', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const nextLineNo = typeof (maxNoRow as { line_no?: number | null } | null)?.line_no === 'number'
    ? (maxNoRow as { line_no: number }).line_no + 1
    : null;
  /* Shared base fields — used for both the single-row non-sofa path and as the
     template for each sofa module row (create-path convention: baseRow). */
  const baseRow = {
    doc_no: docNo,
    line_date: dateOrNull(it.lineDate) ?? todayMyt(),
    debtor_code: header.debtor_code,
    debtor_name: header.debtor_name,
    agent: header.agent,
    item_group: it.itemGroup ?? 'others',
    item_code: it.itemCode,
    description: correctedSizeDescription(itemCodeStr, it.description as string | null, sizeSkuMap)
      ?? ((it.description as string) ?? null),
    uom: (it.uom as string) ?? 'UNIT',
    qty,
    unit_price_sen: unit,
    discount_sen: discount,
    total_sen: lineTotal,
    total_inc_sen: lineTotal,
    balance_sen: lineTotal,
    venue: header.venue,
    branding: header.branding,
    /* Anti-tamper (Task 6) — strip any client-supplied freeItem marker from a
       line added via the SO-edit path. The freeItem marker is ONLY stamped by
       the server after campaign validation — never trusted from the client.
       Task 4: if freeItemCampaignId was validated above, re-stamp the server-
       resolved marker (campaignId + campaignName) after stripping. This is the
       same pattern as the create path (strip then re-add validated marker). */
    /* Variants-vocabulary unification (port of 2990 73aeeb1e) — canonicalize at
       the LAST step before the DB write. Every depth-keyed read (recompute,
       split, fabricCode/fabricId/pwpCode loads) above ran on the raw
       variantsObj/it.variants, so dropping POS aliases here is safe; the
       persisted single-row line stores seatHeight/legHeight/fabricCode. */
    variants: canonicalizeVariants(
      String(it.itemGroup ?? ''),
      addLineFreeItem
        ? { ...(stripFreeItem(it.variants) as Record<string, unknown> | null ?? {}), freeItem: addLineFreeItem }
        : ((stripFreeItem(it.variants) as Record<string, unknown> | null) ?? null),
    ),
    unit_cost_sen: unitCost,
    line_cost_sen: lineCost,
    line_margin_sen: lineTotal - lineCost,
    // MFG-PRICING-ENGINE — Persist breakdown columns (same as POST /).
    divan_price_sen:         recomputed.divan_price_sen,
    leg_price_sen:           recomputed.leg_price_sen,
    special_order_price_sen: recomputed.special_order_sen,
    custom_specials:         recomputed.custom_specials ?? null,
    line_delivery_date: dateOrNull(lineDeliveryDate),
    line_delivery_date_overridden: lineDeliveryDateOverridden,
    warehouse_id: addLineWarehouseId,
    /* SO-SKU spec P2 — a hand-added SERVICE line (Backend SoLineCard picks a
       SVC SKU → itemGroup 'service') is not goods: allocation skips it (P1),
       so it must start READY or its PENDING badge would never clear. */
    ...(isServiceLine({ itemGroup: String(it.itemGroup ?? ''), itemCode: itemCodeStr })
      ? { stock_status: 'READY' }
      : {}),
  };

  /* SO-SKU spec P3 (add-line mirror) — a sofa BUILD added to a placed SO is
     split into per-compartment module rows, exactly like the create path
     (~2456-2559). The money is already settled above: `unit` is the
     authoritative per-build selling price and the drift gate already passed.
     Splitting only decomposes it — each module gets its price share, residue
     on the last, Σ totals === build total. Non-splittable lines (no cells /
     unknown base model) keep the single-row insert below. */
  const addLineCells = (it.variants as { cells?: unknown } | null)?.cells;
  if (
    productLite?.category === 'SOFA' &&
    Array.isArray(addLineCells) && addLineCells.length > 0 &&
    productLite.base_model
  ) {
    if (!sofaModulePricesLite && productLite.base_model) {
      // Catalog gap — split degrades to equal-price weights. Surface so ops
      // can fix the Model's module SKU prices.
      // eslint-disable-next-line no-console
      console.warn(`[so-add-line] no module prices for ${productLite.base_model} — sofa split uses equal weights`);
    }
    // add-line has no extra-charge path, so always proportional split (no evenSplitPrice).
    const split = splitSofaBuildIntoModuleLines({
      baseModel: productLite.base_model,
      cells: addLineCells,
      buildUnitPriceSen: unit,
      buildUnitCostSen: unitCost,
      modulePrices: sofaModulePricesLite,
      depth: String((it.variants as { depth?: unknown } | null)?.depth ?? '24'),
    });
    if (split && split.length > 0) {
      const buildKey = `build-add-${nextLineNo ?? crypto.randomUUID().slice(0, 8)}`;
      /* Variants-vocabulary unification (port of 2990 73aeeb1e) — canonicalize
         BEFORE deriving the split's shared variants so each module row stores
         seatHeight/legHeight/fabricCode. Safe: the split's depth read above
         ran on the raw it.variants. */
      const { cells: _cells, freeItem: _clientFreeItem, ...sharedVariants } =
        canonicalizeVariants('sofa', (it.variants as Record<string, unknown> | null) ?? {});
      // Spread across the modules - see the create path. On module 0 the row goes
      // NEGATIVE and downstream Math.max(0, ...) then deletes the discount.
      const moduleDiscounts = distributeBuildDiscount(discount, qty, split.map((s) => Number(s.unitPriceSen) || 0));
      const moduleRows = split.map((s, i) => {
        const moduleVariants: Record<string, unknown> = {
          ...sharedVariants,
          buildKey,
          cellIndex: s.cellIndex,
          x: s.x,
          y: s.y,
          rot: s.rot,
          /* Task 4 — stamp server-validated freeItem on every module row so the
             grandfather guard (isFreeItemLine) sees the marker on each piece of
             the split build, exactly mirroring the create-path behaviour. */
          ...(addLineFreeItem ? { freeItem: addLineFreeItem } : {}),
        };
        const moduleLineTotal = (qty * s.unitPriceSen) - (moduleDiscounts[i] ?? 0);
        const moduleLineCost = qty * s.unitCostSen;
        return {
          ...baseRow,
          /* line_no: first module gets nextLineNo (same as single-row), each
             subsequent module increments. Pre-0165 docs (nextLineNo === null)
             stay un-numbered consistent with the rest of the SO. */
          ...(nextLineNo !== null ? { line_no: nextLineNo + i } : {}),
          item_code: s.itemCode,
          description: s.description,
          description2: buildVariantSummary('sofa', moduleVariants) || null,
          unit_price_sen: s.unitPriceSen,
          discount_sen: moduleDiscounts[i] ?? 0,
          total_sen: moduleLineTotal,
          total_inc_sen: moduleLineTotal,
          balance_sen: moduleLineTotal,
          variants: moduleVariants,
          unit_cost_sen: s.unitCostSen,
          line_cost_sen: moduleLineCost,
          line_margin_sen: moduleLineTotal - moduleLineCost,
          /* Breakdown columns (divan/leg/special) on first row only; custom_specials + remark on every row (display, same as create). */
          divan_price_sen:         i === 0 ? (recomputed.divan_price_sen ?? 0) : 0,
          leg_price_sen:           i === 0 ? (recomputed.leg_price_sen ?? 0) : 0,
          special_order_price_sen: i === 0 ? (recomputed.special_order_sen ?? 0) : 0,
          custom_specials:         recomputed.custom_specials ?? null,
          remark: typeof sharedVariants.remark === 'string' && (sharedVariants.remark as string).trim() !== ''
            ? (sharedVariants.remark as string).trim()
            : null,
        };
      });
      /* Owner 2026-07-23 — auto-derive branding from product catalog on the
         add-line path, same rule as SO CREATE (see createSalesOrderCore). */
      await deriveLineBrandingFromProduct(sb, moduleRows as unknown as Array<{ item_code?: string | null; branding?: string | null; company_id?: number | null }>, activeCompanyId(c) ?? null);
      signalNullWarehouseRows('PATCH /mfg-sales-orders/:docNo/items (sofa split)', docNo, moduleRows as unknown as Array<Record<string, unknown>>); // logs only, never blocks
      const { data: moduleData, error: moduleError } = await sb
        .from('mfg_sales_order_items')
        .insert(stampCompany(moduleRows, c))
        .select('*');
      if (moduleError) {
        /* Don't burn a PWP code on a failed insert — mirror create's rollbackPwpClaims. */
        if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
        return c.json({ error: 'insert_failed', reason: moduleError.message }, 500);
      }
      const firstRow = (moduleData ?? [])[0] ?? moduleRows[0];

      // Default Free Gift — adding a sofa trigger may grant a gift.
      await reconcileFreeGiftLinesForSo(sb, docNo, c);
      // Re-derive the delivery fee — a new sofa can introduce a cross-category
      // mix or a special-delivery trigger. Stored cross-category source kept.
      await rederiveDeliveryFee(sb, docNo, c);

      await recordSoAudit(sb, {
        docNo,
        action: 'ADD_LINE',
        actorId: user.id,
        actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
        fieldChanges: [
          { field: 'itemCode', to: String(firstRow.item_code ?? itemCodeStr) },
          { field: 'qty', to: qty },
          { field: 'unitPriceSen', to: unit },
          { field: 'totalSen', to: lineTotal },
        ],
      });

      try { await recomputeSoStockAllocation(sb); }
      catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-line-add failed:', e); }

      /* The sofa branch RETURNED here and queued nothing, so adding a sofa to
         an order AutoCount already holds never reached the account book at all.
         The same shape as the guard-with-no-else class in BUG-HISTORY: an early
         return past the hook. Every inserted compartment row is declared, so
         the whole build can go as new lines rather than being refused. */
      await queueAcSoEdit(c, docNo, [], ((moduleData ?? []) as Array<{ id?: unknown }>)
        .map((r) => (r?.id == null ? '' : String(r.id))).filter(Boolean));

      return c.json({ item: firstRow }, 201);
    }
  }

  /* Non-sofa (or non-splittable sofa) — single-row insert, original path. */
  const row = {
    ...baseRow,
    ...(nextLineNo !== null ? { line_no: nextLineNo } : {}),
    /* Commander 2026-05-28 — "Description 2" auto-generated from variants. */
    description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
  };
  /* Owner 2026-07-23 — auto-derive branding on the single-row add-line path. */
  const rowWithCid = { ...row, company_id: activeCompanyId(c) };
  await deriveLineBrandingFromProduct(sb, [rowWithCid] as unknown as Array<{ item_code?: string | null; branding?: string | null; company_id?: number | null }>, activeCompanyId(c) ?? null);
  signalNullWarehouseRows('PATCH /mfg-sales-orders/:docNo/items (single row)', docNo, [rowWithCid] as unknown as Array<Record<string, unknown>>); // logs only, never blocks
  const { data, error } = await sb.from('mfg_sales_order_items').insert(rowWithCid).select('*').single();
  if (error) {
    /* Don't burn a PWP code on a failed insert — mirror create's rollbackPwpClaims. */
    if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  // Default Free Gift (0170) — adding a trigger line may grant a new accessory
  // gift; reconcile auto-inserts/deletes gift lines, then recomputes totals.
  await reconcileFreeGiftLinesForSo(sb, docNo, c);
  // Re-derive the delivery fee — a new goods line can introduce a cross-category
  // mix or a special-delivery trigger. Stored cross-category source kept.
  await rederiveDeliveryFee(sb, docNo, c);

  // PR-D — emit ADD_LINE audit row. Capture item code + qty + unit price
  // so the timeline shows the meaningful what-was-added without an explosion
  // of every column.
  await recordSoAudit(sb, {
    docNo,
    action: 'ADD_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: row.item_code },
      { field: 'qty', to: row.qty },
      { field: 'unitPriceSen', to: row.unit_price_sen },
      { field: 'totalSen', to: row.total_sen },
    ],
  });

  /* New line = new demand → recompute may flip this SO into READY (or
     bump another SO out). Best-effort. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-line-add failed:', e); }

  await queueAcSoEdit(c, docNo, [], data?.id ? [String(data.id)] : []);

  return c.json({ item: data }, 201);
});

mfgSalesOrders.patch('/:docNo/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  const patchSoIsMigrated = await soIsMigrated((d) => sb.from('mfg_sales_orders').select('linked_ac_docno').eq('doc_no', d).maybeSingle(), docNo);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* Edge #4 — itemCode catalog guard (only when caller is changing it).
     A PATCH may never BLANK the code (owner 2026-08-08: every line is a
     catalog SKU — the '' the skip-as-no-op used to wave through would turn a
     real line into a product-less one). Existence-only here: line edits
     resend the unchanged code, and a legacy line whose product went INACTIVE
     must stay editable — the ACTIVE requirement applies below, only when the
     code actually CHANGES (a new pick). */
  if (it.itemCode !== undefined) {
    if (!String(it.itemCode ?? '').trim()) return c.json({ error: 'item_code_required' }, 400);
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown, codeCheck.inactive), 409);
  }

  /* Tier 2 downstream-lock — line-edit is blocked once a DO / SI exists. */
  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  /* TBC fill-in (Loo 2026-06-11) — self-scoped selling roles only touch
     their own SO. */
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  /* AUTHZ BEFORE CONCURRENCY (2026-07-22) — the self-scope gate above now runs
     BEFORE the edit lease. A caller who may not touch this order at all used to
     be told "This order is being saved on another screen; wait a moment and try
     Save again" — a permission refusal wearing a conflict's clothes, which
     invites an endless retry and never surfaces the real reason. */
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  /* Owner 2026-06-12 — processing-date lock: no line EDIT once the processing
     day has passed (the locked order is already PO'd to the supplier). */
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }

  /* Composition guard (Loo 2026-06-11) — a product swap must not INTRODUCE a
     sofa × (bedframe | mattress) mix (PR #519 create rule, now on swap too). */
  if (it.itemCode !== undefined) {
    const mainMix = await lineMixRefusal(sb, 'mfg_sales_order_items', docNo, itemId, it.itemCode as string, activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  /* Pricing trust boundary (Owner 2026-05-31, see isPosTabletCaller). */
  const posTablet = await isPosTabletCaller(c);

  // Re-derive totals if qty/price/discount changed. PR-D — also pull the
  // human-facing columns (item_code, description, uom) for the audit diff.
  const { data: prev } = await scopeSoItemToDocument(
    sb.from('mfg_sales_order_items')
      .select('qty, unit_price_sen, discount_sen, unit_cost_sen, item_code, item_group, description, description2, uom, variants, remark, cancelled'),
    docNo,
    itemId,
  ).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  /* ACTIVE gate on a CHANGED code only (owner 2026-08-08) — a product swap is
     a NEW pick, so the replacement must be ACTIVE like every picker offer;
     re-sending the line's unchanged code (every editor does, on any edit)
     stays existence-only so discontinued-SKU history remains editable. */
  if (it.itemCode !== undefined && String(it.itemCode).trim() !== String(prev.item_code ?? '')) {
    const activeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c), { requireActive: true });
    if (!activeCheck.ok) return c.json(unknownItemCodeResponse(activeCheck.unknown, activeCheck.inactive), 409);
  }
  /* POS line quantity (Loo 2026-06-12) — same 422 gate as POST /. */
  const badQty = invalidQtyResponse(it.qty, prev.item_code);
  if (badQty) return c.json(badQty, 422);
  /* Owner 2026-07-17 — see unexplainedExtraAddonResponse. Validates the
     INCOMING variants, not prev: this PATCH replaces the object wholesale, so
     clearing a note while keeping the amount has to be refused too. */
  const badExtra = unexplainedExtraAddonResponse(it.variants, prev.item_code);
  if (badExtra) return c.json(badExtra, 422);
  const qty = it.qty !== undefined ? Number(it.qty) : prev.qty;
  /* One code = one redemption = ONE unit (Loo 2026-06-12) — mirror of the
     create-path claim-loop gate. A qty-only PATCH skips the recompute, so a
     reward line bumped to qty N would book N units at the stored PWP grant
     price off a single voucher (review blocker 2026-06-12). */
  const prevPwp = (prev.variants ?? null) as { pwp?: boolean; pwpCode?: string | null } | null;
  const prevIsReward = prevPwp?.pwp === true ||
    (typeof prevPwp?.pwpCode === 'string' && prevPwp.pwpCode.trim() !== '');
  if (prevIsReward && qty !== 1) {
    return c.json({
      error:  'pwp_reward_qty_locked',
      reason: 'A PWP reward line redeems one unit per code — quantity stays 1.',
    }, 422);
  }
  const clientUnit = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : prev.unit_price_sen;
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : prev.discount_sen;

  /* MFG-PRICING-ENGINE — Server-side recompute on PATCH. Triggered when
     the caller touches variants OR unitPriceSen (qty alone doesn't move
     the unit price). For variant-driven edits we use the merged item shape
     (prev + patch) so omitted variants stay sticky. The manual-override
     audit path (POST /:docNo/items/:itemId/override → mfg_so_price_overrides)
     is unaffected — it routes around this PATCH entirely. */
  let recomputedPatch: RecomputedLine | null = null;
  const variantsAfter = it.variants !== undefined
    ? (it.variants as MfgItemForRecompute['variants'])
    : ((prev as { variants?: MfgItemForRecompute['variants'] }).variants ?? null);
  const itemCodeAfter = it.itemCode !== undefined ? String(it.itemCode) : prev.item_code;
  const itemGroupAfter = it.itemGroup !== undefined ? String(it.itemGroup) : prev.item_group;

  /* Did the caller actually CHANGE the priced shape of this line? Loo 2026-06-28:
     the Backend SO Detail Save re-commits EVERY line, even untouched ones, so an
     unrelated header / customer / demographics edit re-sends a line verbatim. We
     must NOT re-validate or re-price a line whose itemCode + variants + price the
     caller left identical — the Model's allowed_options can drift after the SO is
     placed (a changed pool, or a stored value with a curly inch-mark "12“" while
     the pool now lists the straight "12\"") and would wrongly reject (or silently
     re-price) a line the user never touched. canonJson is key-order-independent
     because Postgres jsonb reorders object keys, so a naive JSON.stringify of the
     stored blob vs the incoming one would false-positive "changed". */
  const canonJson = (o: unknown): string => {
    if (o == null) return 'null';
    if (typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) return '[' + o.map(canonJson).join(',') + ']';
    return '{' + Object.keys(o as Record<string, unknown>).sort()
      .map((k) => JSON.stringify(k) + ':' + canonJson((o as Record<string, unknown>)[k]))
      .join(',') + '}';
  };
  const variantsChanged = it.variants !== undefined
    && canonJson(variantsAfter ?? null) !== canonJson((prev as { variants?: unknown }).variants ?? null);
  const itemCodeChangedOnPatch = it.itemCode !== undefined && String(it.itemCode) !== prev.item_code;
  const priceChanged = it.unitPriceSen !== undefined && Number(it.unitPriceSen) !== prev.unit_price_sen;
  const shouldRecompute = variantsChanged || itemCodeChangedOnPatch || priceChanged;

  /* PR #216 — allowed_options check on PATCH. Only when the caller actually
     CHANGES variants or the item code (see above) — a genuine edit picks from
     the CURRENT pool so it still validates; an untouched line is grandfathered. */
  if (variantsChanged || itemCodeChangedOnPatch) {
    const { product, model, lookupError } = await loadProductAndModel(sb, itemCodeAfter, activeCompanyId(c));
    // A failed catalog read is ignorance, not permission — refuse, don't skip the gate.
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(
      product,
      model,
      variantsAfter as Parameters<typeof checkAllowedOptions>[2],
    );
    if (aoErr) return c.json({ ...aoErr, itemCode: itemCodeAfter }, 400);
    /* Go-live review #6 — variant completeness on the LINE-EDIT route. When the
       SO already carries a Processing Date (processing_date) the header
       guard (findIncompleteVariantLines) has already vouched every line is
       complete; a later line edit must not be able to blank a category-mandatory
       variant (e.g. clear a fabric) on an order already released for ordering.
       Only checked
       when the caller actually CHANGED variants / item code (same grandfather as
       the allowed-options gate above) so an untouched re-save is never rejected. */
    const { data: soHdr } = await sb.from('mfg_sales_orders')
      .select('processing_date').eq('doc_no', docNo).maybeSingle();
    if ((soHdr as { processing_date?: string | null } | null)?.processing_date) {
      const editedLine = [{
        id: itemId,
        itemCode: itemCodeAfter,
        group: itemGroupAfter,
        variants: variantsAfter as Record<string, unknown> | null,
      }];
      const offenders = findIncompleteVariantLines(editedLine);
      if (offenders.length > 0) {
        return c.json({
          error: 'variants_incomplete',
          message: 'Processing Date requires all category-mandatory variants on every line.',
          offenders,
        }, 409);
      }
      /* Colour-KIV (owner 2026-07-24, SO-2607-016) — a line edit must not turn
         a confirmed fabric back into KIV on an SO that already carries a
         Processing Date. Same grandfather as the variants gate: only fires
         when this call actually changed variants / item code. */
      const kiv = findColourKivLines(editedLine);
      if (kiv.length > 0) {
        return c.json({
          error: 'fabric_colour_kiv',
          message: `${itemCodeAfter} — fabric colour is still KIV. This order already has a Processing Date, so confirm the colour instead of leaving it KIV.`,
          offenders: kiv,
        }, 409);
      }
    }
  }
  if (shouldRecompute && itemCodeAfter) {
    const [cfg, prodLite, fabLite, sofaCombosPatch, sellingTiersPatch, fabricAddonConfigPatch, specialAddonsPatch, modelOverridesPatch, compartmentOverridesPatch] = await Promise.all([
      loadMaintenanceConfig(sb),
      loadProductByCode(sb, itemCodeAfter, activeCompanyId(c)),
      loadFabricByCode(sb, variantsAfter?.fabricCode ?? null),
      loadActiveSofaCombos(sb, c),
      loadFabricSellingTiers(sb, (variantsAfter as { fabricId?: string } | null)?.fabricId ?? null),
      loadFabricTierAddonConfig(sb, activeCompanyId(c)),
      loadSpecialAddons(sb),
      loadModelFabricTierOverrides(sb),
      loadCompartmentFabricTierOverrides(sb),
    ]);
    // SOFA-SELLING-PLAN — per-Model module SELLING prices for the sofa drift gate.
    // Audit 2026-06-11 C2 — module COST rows so a build's cost = Σ module costs.
    const [sofaModulePricesPatch, sofaModuleCostRowsPatch] = prodLite?.category === 'SOFA'
      ? await Promise.all([
          loadModelSofaModulePrices(
            sb,
            prodLite.base_model,
            String((variantsAfter as { depth?: unknown } | null)?.depth ?? '24'),
            activeCompanyId(c),
          ),
          loadModelSofaModuleCostRows(sb, prodLite.base_model, activeCompanyId(c)),
        ])
      : [null, null];
    recomputedPatch = recomputeFromSnapshot(
      {
        itemCode:       itemCodeAfter,
        itemGroup:      itemGroupAfter,
        qty,
        unitPriceSen: clientUnit,
        variants:       variantsAfter,
      },
      prodLite,
      fabLite,
      cfg,
      sofaCombosPatch,
      sofaModulePricesPatch,
      sellingTiersPatch,
      fabricAddonConfigPatch,
      null,                // pwpBaseSen
      null,                // pwpSofaComboIds
      specialAddonsPatch,
      sofaModuleCostRowsPatch,
      modelOverridesPatch, // migration 0175 — per-Model Δ
      compartmentOverridesPatch, // migration 0025 — per-compartment Δ
      // owner ruling — non-POS author prices freely; see erpLineTrust.
      erpLineTrust(posTablet, clientUnit, it.zeroPriceIntended, patchSoIsMigrated),
    );
    /* Task 6 — grandfathering: a line already carrying variants.freeItem was
       made free at create time and must STAY at RM 0 on edit recompute, even
       if the campaign has since been toggled off. Skip the drift check too —
       the client always sends 0 for a free-item line so there is no drift to
       gate against. */
    /* PWP reward lines are grandfathered too (Loo 2026-06-28). The grant price
       was locked when the voucher was claimed; the edit path passes no
       pwpBaseSen, so recompute returns FULL RETAIL — comparing the stored grant
       price against it always "drifts". Skip the gate for a reward line exactly
       like a free-item line; the unit below is forced back to the stored grant. */
    if (!isFreeItemLine(prev.variants) && !prevIsReward && posTablet && recomputedPatch.drift) {
      return c.json({
        error:    'pricing_drift',
        reason:   'The price for this item is out of date — please refresh and try again.',
        itemCode: itemCodeAfter,
        client:   clientUnit,
        server:   recomputedPatch.unit_price_sen,
        breakdown: recomputedPatch.breakdown,
      }, 400);
    }
  }
  /* Carry the bound price-list figure out when a recompute ran (costing-only
     Backend sends no real selling price). POS drift rejects above; Backend
     drift saves silently. Task 6 — a persisted free-item line is grandfathered
     at RM 0 regardless of what the current recompute produced. */
  const unit = isFreeItemLine(prev.variants)
    ? 0
    /* PWP reward — keep the grant price locked at claim time. Recompute (no
       pwpBaseSen on the edit path) would reset it to full retail and the
       Backend, not being a POS tablet, would save that silently — turning a
       RM490 加购 into RM990 with no warning (Loo 2026-06-28). */
    : prevIsReward
    ? prev.unit_price_sen
    : (recomputedPatch ? recomputedPatch.unit_price_sen : clientUnit);
  /* Audit 2026-06-11 C-2 — same discount gate as POST /: the effective
     (patch-else-stored) discount must sit in [0, qty × unit] against the
     effective unit price (422, reject-don't-normalize). */
  if (!Number.isFinite(discount) || discount < 0 || discount > qty * unit) {
    return c.json({
      error:    'invalid_discount',
      reason:   'discountSen must be between 0 and qty × unit price.',
      itemCode: itemCodeAfter,
      discount,
      max:      qty * unit,
    }, 422);
  }
  /* The total floor that stood here (Loo 2026-06-11) is GONE — owner ruling,
     relayed 2026-08-18: a POS caller may lower a line. `posTablet` still gates
     the pricing_drift check below, which is a different rule and stays. */
  /* Commander 2026-05-28 — cost snapshot on PATCH. Order of precedence:
       1. Client sent unitCostSen > 0 → use it (explicit override).
       2. A recompute ran (variants/itemCode/price touched) AND produced a
          cost > 0 → use the server-computed cost (base + Σ backend priceSen
          surcharges via computeMfgLineCost). This is the source of truth.
       3. Client changed itemCode but recompute had no cost → re-snapshot
          mfg_products under the new code.
       4. Otherwise keep the prior unit_cost_sen unchanged. */
  let unitCost: number;
  const explicitCost = it.unitCostSen !== undefined ? Number(it.unitCostSen) : 0;
  const itemCodeChanged = it.itemCode !== undefined && it.itemCode !== prev.item_code;
  if (explicitCost > 0) {
    unitCost = explicitCost;
  } else if (recomputedPatch && recomputedPatch.unit_cost_sen > 0) {
    unitCost = recomputedPatch.unit_cost_sen;
  } else if (itemCodeChanged) {
    unitCost = await snapshotUnitCostSen(sb, String(it.itemCode ?? ''), 0, c);
  } else {
    /* Case 4 "keep the prior cost" — a legacy row whose unit_cost_sen was
       never stamped reads back null/undefined here, and `undefined * qty` is
       NaN, which then rides into line_cost_sen / line_margin_sen and the
       header roll-up. Unknown prior cost = 0. */
    unitCost = senOrZero(prev.unit_cost_sen);
  }
  const lineTotal = senOrZero((qty * unit) - discount);
  const lineCost = senOrZero(unitCost * qty);

  const updates: Record<string, unknown> = {
    qty, unit_price_sen: unit, discount_sen: discount, unit_cost_sen: unitCost,
    total_sen: lineTotal, total_inc_sen: lineTotal, balance_sen: lineTotal,
    line_cost_sen: lineCost, line_margin_sen: lineTotal - lineCost,
  };
  // MFG-PRICING-ENGINE — Refresh the persisted breakdown columns when we
  // ran a recompute. Without this they'd drift from `variants` over time.
  if (recomputedPatch) {
    updates.divan_price_sen         = recomputedPatch.divan_price_sen;
    updates.leg_price_sen           = recomputedPatch.leg_price_sen;
    updates.special_order_price_sen = recomputedPatch.special_order_sen;
    updates.custom_specials         = recomputedPatch.custom_specials ?? null;
  }
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['description2', 'description2'], ['uom', 'uom'], ['variants', 'variants'],
    ['remark', 'remark'], ['cancelled', 'cancelled'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* Anti-tamper (Task 6) — when the client sends variants, strip any client-supplied
     freeItem marker, then re-graft the persisted marker (if any) so an already-free
     line stays free and a normal line cannot be made free via a crafted PATCH.
     Must run AFTER the loop above so variants is already in updates. */
  if (it.variants !== undefined) {
    const clientVariants = stripFreeItem(updates['variants']);
    const prevFreeItem = (prev.variants as Record<string, unknown> | null | undefined)?.freeItem;
    updates['variants'] = prevFreeItem !== undefined
      ? { ...(clientVariants as Record<string, unknown> ?? {}), freeItem: prevFreeItem }
      : clientVariants ?? null;
    /* Variants-vocabulary unification (port of 2990 73aeeb1e) — canonicalize
       the FINAL persisted variants. The recompute + sofa depth loads above
       already ran on the raw variantsAfter, so dropping aliases here is safe;
       the persisted row stores seatHeight/legHeight/fabricCode and the
       description2 block below (which reads updates['variants']) sees the
       canonical object. */
    const itemGroupAfter = String(it.itemGroup ?? prev.item_group ?? '');
    updates['variants'] = canonicalizeVariants(
      itemGroupAfter,
      updates['variants'] as Record<string, unknown> | null,
    );
  }
  /* Commander 2026-05-28 — "Description 2" is ALWAYS the server-generated
     variant summary; never trust a client-sent value. Recompute from the
     effective itemGroup + variants (incoming patch, else the stored row).
     Use the FINAL persisted variants (updates['variants']) if variants were patched,
     to ensure description2 matches the stripped-and-re-grafted variants that will
     actually be persisted, not the raw client input. */
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants !== undefined ? updates['variants'] : prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  /* PR-E — Per-item delivery date PATCH. If the caller sends
     lineDeliveryDate (including null to clear it), we ALSO server-side
     flip line_delivery_date_overridden to true. This is defensive — the
     UI should already mark the line as overridden when the user types
     into the field, but enforcing it here protects against clients that
     forget. A separate lineDeliveryDateOverridden=false reset path lets
     the UI deliberately rejoin the header cascade. */
  if (it.lineDeliveryDate !== undefined) {
    updates['line_delivery_date'] = dateOrNull(it.lineDeliveryDate);
    updates['line_delivery_date_overridden'] = true;
  }
  if (it.lineDeliveryDateOverridden !== undefined) {
    updates['line_delivery_date_overridden'] = Boolean(it.lineDeliveryDateOverridden);
  }
  /* Commander 2026-05-31 — per-line ship-from warehouse is editable. Moving a
     line to another warehouse reshuffles the per-warehouse allocation pool, so
     recomputeSoStockAllocation below re-derives stock_status. */
  if (it.warehouseId !== undefined) {
    updates['warehouse_id'] = it.warehouseId as string | null;
  }

  const { error } = await scopeSoItemToDocument(
    sb.from('mfg_sales_order_items').update(updates),
    docNo,
    itemId,
  );
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  // Default Free Gift (0170) — editing a line (code/qty) may add or drop a
  // trigger; reconcile auto-syncs the gift lines, then recomputes totals.
  await reconcileFreeGiftLinesForSo(sb, docNo, c);
  // Re-derive the delivery fee — a line code/qty change can flip a cross-category
  // mix or a special-delivery trigger. Stored cross-category source kept.
  await rederiveDeliveryFee(sb, docNo, c);

  /* PR-D — one UPDATE_LINE row when anything moved.
     Owner 2026-08-12, after 2990-SO-2608-017: this used to compare a
     HAND-MAINTAINED list (qty / prices / code / group / description / uom /
     remark / cancelled). `variants` was never on it, and neither were the spec
     columns the same handler writes — so changing ONLY a line's specification
     produced an empty diff and the `length > 0` guard below skipped the audit
     ENTIRELY. That SO had LEG 6" added to two sofa lines at a price that did
     not move (leg_price_sen 0): the write landed, the supplier's PO went stale
     against it, and the History timeline showed nothing at all. The single most
     damaging edit we make was the one edit we did not record.

     So the diff is now DERIVED FROM `updates` — the exact object about to be
     persisted — instead of a parallel list that has to be remembered. A column
     added to this handler is audited by construction; there is nothing left to
     forget. (Same lesson as the amendment apply white-list: a hand-copy that
     "MIRRORS" another list is a drift bug with a delay fuse.) */
  const fieldChanges = soLineFieldChanges(prev as unknown as Record<string, unknown>, updates);
  if (fieldChanges.length > 0) {
    // Prefix with itemCode so the timeline can show "Updated line ITEM-123"
    // without a dedicated column on the audit row.
    fieldChanges.unshift({ field: 'itemCode', to: prev.item_code });
    await recordSoAudit(sb, {
      docNo,
      action: 'UPDATE_LINE',
      actorId: user.id,
      actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
      fieldChanges,
    });
  }

  /* Line qty / variants / category may have changed → recompute. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-line-patch failed:', e); }

  await queueAcSoEdit(c, docNo);

  return c.json({ ok: true });
});

mfgSalesOrders.delete('/:docNo/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');

  /* Tier 2 downstream-lock — line-delete is blocked once a DO / SI exists. */
  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  /* TBC fill-in (Loo 2026-06-11) — self-scoped selling roles only touch
     their own SO. */
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  /* AUTHZ BEFORE CONCURRENCY (2026-07-22) — the self-scope gate above now runs
     BEFORE the edit lease. A caller who may not touch this order at all used to
     be told "This order is being saved on another screen; wait a moment and try
     Save again" — a permission refusal wearing a conflict's clothes, which
     invites an endless retry and never surfaces the real reason. */
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  /* Owner 2026-06-12 — processing-date lock: no line DELETE once the
     processing day has passed (the locked order is already PO'd). */
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }

  // PR-D — capture the line snapshot before delete so the timeline can
  // show what was removed (item code + qty + unit price).
  // Task #93 — also fetch photo_urls so we can clean up R2 orphans
  // after the DB row is gone. We grab them BEFORE the delete because
  // the row is the source of truth for which keys belong to this line.
  const { data: prev } = await scopeSoItemToDocument(
    sb.from('mfg_sales_order_items')
      .select('item_code, qty, unit_price_sen, total_sen, photo_urls, cancelled'),
    docNo,
    itemId,
  ).maybeSingle();
  const prevTyped = prev as
    | { item_code: string; qty: number; unit_price_sen: number; total_sen: number; photo_urls: string[] | null; cancelled?: boolean }
    | null;

  /* The total floor that stood here (Loo 2026-06-11) is GONE — owner ruling,
     relayed 2026-08-18. A POS caller may delete a priced line. */
  /* The AutoCount key of the line this save REMOVES. Read BEFORE the delete:
     afterwards the row is gone and its DtlKey with it, and an edit that does not
     NAME the removal leaves the line live and outstanding in the account book. */
  const retire = await retiredLineOf(sb, 'mfg_sales_order_items', itemId);

  const { error } = await scopeSoItemToDocument(
    sb.from('mfg_sales_order_items').delete(),
    docNo,
    itemId,
  );
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  // Default Free Gift (0170) — removing a trigger line (e.g. a mattress) must
  // auto-delete its free gift; reconcile drops orphaned gifts, then recomputes.
  await reconcileFreeGiftLinesForSo(sb, docNo, c);
  // Re-derive the delivery fee — removing a goods line can drop a cross-category
  // mix or a special-delivery trigger. Stored cross-category source kept.
  await rederiveDeliveryFee(sb, docNo, c);

  // Task #93 — orphan cleanup. Loop over the photo keys and best-effort
  // delete each from R2. Failures are swallowed (logged) so a flaky R2
  // op doesn't leave the user with a "delete failed" toast on top of a
  // DB delete that already succeeded — rolling back the row to recover
  // a few KB of blob is worse than the orphan.
  let photosCleaned = 0;
  const photoKeys = prevTyped?.photo_urls ?? [];
  if (photoKeys.length > 0 && c.env.SO_ITEM_PHOTOS) {
    for (const key of photoKeys) {
      try {
        await c.env.SO_ITEM_PHOTOS.delete(key);
        photosCleaned += 1;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[so-item-photo] orphan cleanup failed for', key, e);
      }
      // WO-7: sweep the thumb sibling alongside its main object.
      await deleteThumbFor(c.env.SO_ITEM_PHOTOS, key);
    }
  }

  if (prevTyped) {
    await recordSoAudit(sb, {
      docNo,
      action: 'DELETE_LINE',
      actorId: user.id,
      actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
      fieldChanges: [
        { field: 'itemCode', from: prevTyped.item_code },
        { field: 'qty', from: prevTyped.qty },
        { field: 'unitPriceSen', from: prevTyped.unit_price_sen },
        { field: 'totalSen', from: prevTyped.total_sen },
        // Task #93 — note the photo cleanup so the timeline shows
        // "deleted N photos" alongside the line removal.
        ...(photoKeys.length > 0
          ? [{ field: 'photosCleaned', from: photoKeys.length, to: photosCleaned } satisfies FieldChange]
          : []),
      ],
    });
  }

  /* Line delete = demand drops → other queued SOs may move into READY. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-line-delete failed:', e); }

  await queueAcSoEdit(c, docNo, retire);

  return c.body(null, 204);
});

/* ───────────────────── TBC fill-in (Loo 2026-06-11) ──────────────────────
   POS sales complete a customer's deferred picks (fabric / leg height / gap /
   divan / special add-ons) on an EXISTING SO line, from My orders. Pricing is
   a server-computed DELTA:

       newUnitPrice = storedUnitPrice
                    + (surcharges(nextVariants) − surcharges(prevVariants))
                    + (fabricTierΔ(next) − fabricTierΔ(prev))

   The stored deal (combo proration on split sofa lines, PWP bases, any
   negotiated figure) is never re-derived — only the CHANGED options move the
   bill. computeMfgLinePrice runs twice with identical base inputs, so every
   constant term cancels; the selling fabric-tier Δ (migration 0124) rides
   separately, mirroring recomputeFromSnapshot's authoritative branches.

   Sofa builds (P3 per-module lines): the shared picks (fabric + leg) copy
   onto EVERY line of the build (variants.buildKey) so so-variant-rule sees a
   complete build, while the price delta lands ONCE on the requested line.

   Floor rule: for POS tablet callers the delta may never be negative — the
   bill only grows or stays equal vs the original sales order total. Backend
   roles keep using SoLineCard / the generic PATCH. */

const TBC_VARIANT_KEYS = [
  'fabricId', 'fabricCode', 'fabricLabel', 'colourId', 'colourLabel', 'colourHex',
  'sofaLegHeight',
  'gap', 'gapLabel', 'legHeight', 'legHeightLabel', 'divanHeight', 'divanHeightLabel',
  'specials', 'specialIds', 'specialLabels', 'specialChoices',
] as const;
/* Picks shared by every module line of a sofa build. */
const TBC_BUILD_SHARED_KEYS = ['fabricId', 'fabricCode', 'fabricLabel', 'colourId', 'colourLabel', 'colourHex', 'sofaLegHeight'] as const;

const throwAtomicCommandWrite = (sb: any, error: { message?: string } | null | undefined, label: string): void => {
  if (error && sb?.__atomicCommand === true) throw new Error(`${label}: ${error.message ?? 'database write failed'}`);
};

export async function tbcUpdateCommandHandler(c: any, sb: any): Promise<Response> {
  const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const patch = (body.variants ?? {}) as Record<string, unknown>;
  if (Object.keys(patch).length === 0) return c.json({ error: 'variants_required' }, 400);
  const badKey = Object.keys(patch).find((k) => !(TBC_VARIANT_KEYS as readonly string[]).includes(k));
  if (badKey) return c.json({ error: 'invalid_variant_key', key: badKey, allowed: TBC_VARIANT_KEYS }, 400);

  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  /* AUTHZ BEFORE CONCURRENCY (2026-07-22) — the self-scope gate above now runs
     BEFORE the edit lease. A caller who may not touch this order at all used to
     be told "This order is being saved on another screen; wait a moment and try
     Save again" — a permission refusal wearing a conflict's clothes, which
     invites an endless retry and never surfaces the real reason. */
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  /* Owner 2026-06-12 — processing-date lock: a TBC fill-in is still a line
     EDIT (it changes what we PO to the supplier), so it locks too. */
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }

  const { data: prev } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, unit_price_sen, discount_sen, unit_cost_sen, variants, cancelled')
    .eq('id', itemId).eq('doc_no', docNo).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  if (prev.cancelled) return c.json({ error: 'line_cancelled' }, 409);
  const prevVariants = ((prev.variants ?? {}) as Record<string, unknown>);
  /* PWP reward lines ARE editable here (Loo 2026-06-12 — SO-2606-009's
     FENRIR-(K) reward arrived all-TBC and could never be completed). Safe
     because the delta below never re-derives the base: only the surcharge
     difference + fabric-tier Δ move the price, exactly the components a PWP
     line stacks on top of its granted base at create — and the
     TBC_VARIANT_KEYS whitelist keeps pwp / pwpCode untouchable. Only the
     product SWAP stays locked for PWP (it would break the voucher binding). */

  /* Merge — a present key overwrites; null / '' / [] clears the key (the
     sales picked "Confirm later" again). */
  const nextVariants: Record<string, unknown> = { ...prevVariants };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '' || (Array.isArray(v) && v.length === 0)
        || (k === 'specialChoices' && typeof v === 'object' && v !== null && Object.keys(v as object).length === 0)) {
      delete nextVariants[k];
    } else {
      nextVariants[k] = v;
    }
  }

  /* allowed_options gate on the merged shape (same as the generic PATCH). */
  {
    const { product, model, lookupError } = await loadProductAndModel(sb, prev.item_code, activeCompanyId(c));
    // A failed catalog read is ignorance, not permission — refuse, don't skip the gate.
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(product, model, nextVariants as Parameters<typeof checkAllowedOptions>[2]);
    if (aoErr) return c.json({ ...aoErr, itemCode: prev.item_code }, 400);
  }

  const [cfg, prodLite, fabPrev, fabNext, tiersPrev, tiersNext, addonCfg, specialDefs, modelOverrides, compartmentOverrides] = await Promise.all([
    loadMaintenanceConfig(sb),
    loadProductByCode(sb, prev.item_code, activeCompanyId(c)),
    loadFabricByCode(sb, (prevVariants.fabricCode as string | undefined) ?? null),
    loadFabricByCode(sb, (nextVariants.fabricCode as string | undefined) ?? null),
    loadFabricSellingTiers(sb, (prevVariants.fabricId as string | undefined) ?? null),
    loadFabricSellingTiers(sb, (nextVariants.fabricId as string | undefined) ?? null),
    loadFabricTierAddonConfig(sb, activeCompanyId(c)),
    loadSpecialAddons(sb),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  /* Two snapshots, identical base inputs — only `variants` (and its fabric
     row) differ, so base / combo / PWP terms cancel in the difference. The
     fabric-tier Δ inputs (sellingTiers / addonConfig) are deliberately NOT
     passed: the Δ is applied once, below, never double-counted. */
  const snap = (variants: Record<string, unknown>, fab: typeof fabPrev) =>
    recomputeFromSnapshot(
      {
        itemCode:       prev.item_code,
        itemGroup:      String(prev.item_group ?? 'others'),
        qty:            Number(prev.qty),
        unitPriceSen: Number(prev.unit_price_sen),
        variants:       variants as MfgItemForRecompute['variants'],
      },
      prodLite, fab, cfg, null, null, null, null, null, null, specialDefs, null, null,
    );
  const before = snap(prevVariants, fabPrev);
  const after  = snap(nextVariants, fabNext);
  const category = String(prodLite?.category ?? '').toUpperCase();
  // migration 0175 — per-Model Δ override (same for prev/next; the Model doesn't
  // change on a TBC fill-in). Resolved by the line's model_id, replaces global.
  // migration 0025 — folded with any matching per-compartment Δ (MAX per tier)
  // over the build's cells; cells don't change on a TBC fill-in (fabric only).
  const tbcBaseOverride = (modelOverrides && prodLite?.model_id) ? (modelOverrides.get(prodLite.model_id) ?? null) : null;
  /* A persisted split-sofa module line STRIPS `variants.cells`, so the build's
     compartment codes can't be read off `nextVariants` — that yielded `[]` and
     resolved model-only, under-charging a build that carries a per-compartment
     Δ (the POS preview showed the higher Δ but the server billed less; no drift
     gate here). Reconstruct them from the SIBLING module lines' item_code suffix,
     the same way the create path does. */
  let tbcCells: string[] = [];
  if (category === 'SOFA') {
    const buildKeyForCells = (prevVariants.buildKey as string | undefined) ?? null;
    if (buildKeyForCells) {
      const { data: cellRows } = await sb.from('mfg_sales_order_items')
        .select('item_code, variants')
        .eq('doc_no', docNo).eq('cancelled', false)
        .filter('variants->>buildKey', 'eq', buildKeyForCells);
      tbcCells = buildCompartmentsFromModuleLines(
        ((cellRows ?? []) as Array<{ item_code: string; variants: Record<string, unknown> | null }>)
          .map((r) => ({ item_code: r.item_code, buildKey: String((r.variants ?? {}).buildKey ?? '') })),
        buildKeyForCells,
      );
    } else {
      // Not a split build (whole-unit code carries cells inline) — fall back to
      // the inline cells if present.
      tbcCells = Array.isArray((nextVariants as { cells?: unknown }).cells)
        ? ((nextVariants as { cells?: Array<{ moduleId?: unknown }> }).cells ?? []).map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
        : [];
    }
  }
  const tbcOverride = resolveFabricTierOverride(tbcCells, tbcBaseOverride, compartmentOverrides ?? new Map());
  const tierDeltaSen = (addonCfg && (category === 'SOFA' || category === 'BEDFRAME'))
    ? (fabricTierAddon(category, (category === 'SOFA' ? tiersNext?.sofaTier : tiersNext?.bedframeTier) ?? null, addonCfg, tbcOverride)
     - fabricTierAddon(category, (category === 'SOFA' ? tiersPrev?.sofaTier : tiersPrev?.bedframeTier) ?? null, addonCfg, tbcOverride)) * 100
    : 0;
  const sellingDeltaSen = (after.breakdown.unitPriceSen - before.breakdown.unitPriceSen) + tierDeltaSen;
  const costDeltaSen = after.unit_cost_sen - before.unit_cost_sen;

  /* Task 6 — grandfathering: a line carrying variants.freeItem was made free
     at create time and must STAY at RM 0 regardless of any fabric/option delta.
     Treat it as a no-price-change TBC edit (the variant picks still land). */
  const isFreeItemGrandfathered = isFreeItemLine(prevVariants);
  /* The total floor that stood here (Loo 2026-06-11) is GONE — owner ruling,
     relayed 2026-08-18. A TBC edit may lower the line. */
  const qty = Number(prev.qty);
  const newUnit = isFreeItemGrandfathered ? 0 : Math.max(0, Number(prev.unit_price_sen) + sellingDeltaSen);
  /* The unit price just MOVED and the stored discount did not. newUnit is
     clamped at 0, newTotal is not, so a variant edit that LOWERS the price drives
     the line total NEGATIVE — and downstream Math.max(0, ...) then deletes the
     discount and over-bills. REJECT, do not normalize: the price-override path
     in this file already sets that house rule (discount invariant:
     0 <= discount <= qty * unit), and silently shrinking a discount changes the
     money without telling anyone. */
  const prevDiscount = Number(prev.discount_sen ?? 0);
  if (prevDiscount > qty * newUnit) {
    return c.json({
      error: 'discount_exceeds_new_price',
      message:
        `This change lowers the unit price to ${(newUnit / 100).toFixed(2)}, and the line already carries a ` +
        `${(prevDiscount / 100).toFixed(2)} discount — which no longer fits. Reduce the discount first, then re-apply this change.`,
      discount: prevDiscount,
      max: qty * newUnit,
    }, 422);
  }
  const newTotal = (qty * newUnit) - prevDiscount;
  const newUnitCost = Math.max(0, Number(prev.unit_cost_sen ?? 0) + costDeltaSen);
  const { error: upErr } = await sb.from('mfg_sales_order_items').update({
    variants: nextVariants,
    description2: buildVariantSummary(String(prev.item_group ?? ''), nextVariants) || null,
    unit_price_sen: newUnit,
    total_sen: newTotal,
    total_inc_sen: newTotal,
    balance_sen: newTotal,
    unit_cost_sen: newUnitCost,
    line_cost_sen: newUnitCost * qty,
    line_margin_sen: newTotal - (newUnitCost * qty),
    divan_price_sen: after.breakdown.divanSurchargeSen,
    leg_price_sen: after.breakdown.legSurchargeSen,
    special_order_price_sen: after.breakdown.specialsSurchargeSen,
    custom_specials: after.custom_specials ?? null,
  }).eq('id', itemId);
  if (upErr) return c.json({ error: 'update_failed', reason: upErr.message }, 500);

  /* Mirror the SHARED picks onto the rest of the sofa build — variants only;
     the money landed once above. */
  const buildKey = String(prev.item_group) === 'sofa' ? ((prevVariants.buildKey as string | undefined) ?? null) : null;
  if (buildKey) {
    const { data: rows } = await sb.from('mfg_sales_order_items')
      .select('id, variants')
      .eq('doc_no', docNo).eq('cancelled', false)
      .filter('variants->>buildKey', 'eq', buildKey);
    for (const row of ((rows ?? []) as Array<{ id: string; variants: Record<string, unknown> | null }>)) {
      if (row.id === itemId) continue;
      const merged: Record<string, unknown> = { ...((row.variants ?? {}) as Record<string, unknown>) };
      for (const k of TBC_BUILD_SHARED_KEYS) {
        if (!(k in patch)) continue;
        const v = patch[k];
        if (v === null || v === '') delete merged[k]; else merged[k] = v;
      }
      await sb.from('mfg_sales_order_items').update({
        variants: merged,
        description2: buildVariantSummary('sofa', merged) || null,
      }).eq('id', row.id);
    }
  }

  // Default Free Gift (0170) — a sofa/variant build change may newly match (or
  // stop matching) a gifting combo; reconcile syncs the gift lines, then totals.
  await reconcileFreeGiftLinesForSo(sb, docNo, c);
  // Re-derive the delivery fee — a TBC variant fill-in can resolve a special-
  // delivery trigger (model/variant/combo). Stored cross-category source kept.
  await rederiveDeliveryFee(sb, docNo, c);
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    /* Owner 2026-08-12 — this used to record `tbcVariants: "legHeight, seatHeight"`:
       the NAMES of the keys that were filled, with neither the old nor the new
       value. So the timeline could say a spec was touched but never what it
       became, which is the one thing an audit of a spec change exists to answer.
       Now the same readable before→after summary the line PATCH emits (`spec`),
       from the SAME buildVariantSummary the persisted description2 uses. */
    fieldChanges: [
      { field: 'itemCode', to: prev.item_code },
      {
        field: 'spec',
        from: buildVariantSummary(String(prev.item_group ?? ''), (prev.variants ?? null) as Record<string, unknown> | null) || null,
        to: buildVariantSummary(String(prev.item_group ?? ''), nextVariants) || null,
      },
      ...(sellingDeltaSen !== 0
        ? [{ field: 'unitPriceSen', from: prev.unit_price_sen, to: newUnit } satisfies FieldChange]
        : []),
    ],
  });

  await scheduleStockAllocationAfterCommand(c, sb, `tbc-update:${docNo}`);
  return c.json({ ok: true, unitPriceSen: newUnit, deltaSen: sellingDeltaSen, totalSen: newTotal });
}
mfgSalesOrders.post('/:docNo/items/:itemId/tbc-update', async (c) => {
  const company = requireActiveCompanyId(c);
  if (!company.ok) return c.json(company.refusal, 409);
  return queueAcSoEditAfter(c, c.req.param('docNo'), await runScmPgCommand(c, (sb) => tbcUpdateCommandHandler(c, sb), {
    docNo: c.req.param('docNo'),
    leaseToken: c.req.header('X-SO-Edit-Lease')?.trim() ?? null, userId: soCallerUserId(c),
    companyId: company.companyId,
  }));
});

/* TBC product swap (Loo 2026-06-11) — exchange a line for a DIFFERENT product
   from My orders. Non-sofa ↔ non-sofa only (a sofa is a multi-line build).
   The new line reprices from the catalog (sell_price_sen) with every option
   reset to TBC; the floor rule keeps a POS sales caller from swapping the
   bill downward. The composition guard keeps sofa exclusive on the SO. */
export async function tbcSwapCommandHandler(c: any, sb: any): Promise<Response> {
  const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const newCode = String(body.itemCode ?? '').trim();
  if (!newCode) return c.json({ error: 'item_code_required' }, 400);

  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  /* AUTHZ BEFORE CONCURRENCY (2026-07-22) — the self-scope gate above now runs
     BEFORE the edit lease. A caller who may not touch this order at all used to
     be told "This order is being saved on another screen; wait a moment and try
     Save again" — a permission refusal wearing a conflict's clothes, which
     invites an endless retry and never surfaces the real reason. */
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  /* Owner 2026-06-12 — processing-date lock: a product swap is a line EDIT
     (it changes what we PO to the supplier), so it locks too. */
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }

  const { data: prev } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, unit_price_sen, discount_sen, total_sen, variants, cancelled')
    .eq('id', itemId).eq('doc_no', docNo).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  if (prev.cancelled) return c.json({ error: 'line_cancelled' }, 409);
  const prevVariants = ((prev.variants ?? {}) as Record<string, unknown>);
  if (String(prev.item_group) === 'sofa' || prevVariants.buildKey || prevVariants.cells) {
    return c.json({ error: 'sofa_swap_not_supported', reason: 'A sofa build is exchanged by rebuilding the order, not by swapping one line.' }, 400);
  }

  const { data: prodRow } = await scopeToCompany(
    sb.from('mfg_products')
      .select('code, name, category, status, pos_active, sell_price_sen, cost_price_sen, pwp_price_sen, model_id, size_code')
      .eq('code', newCode),
    c,
  ).maybeSingle();
  const prod = prodRow as { code: string; name: string; category: string; status: string; pos_active: boolean; sell_price_sen: number | null; cost_price_sen: number | null; pwp_price_sen: number | null; model_id: string | null; size_code: string | null } | null;
  if (!prod) return c.json(unknownItemCodeResponse([newCode]), 409);
  if (String(prod.category).toUpperCase() === 'SOFA') {
    return c.json({ error: 'sofa_swap_not_supported', reason: 'A sofa build is added through the configurator, not a line swap.' }, 400);
  }
  if (prod.status !== 'ACTIVE' || !prod.pos_active) {
    return c.json({ error: 'product_inactive', itemCode: newCode }, 409);
  }

  /* ── PWP swap ranges (Loo 2026-06-12) ─────────────────────────────────
     A line tied to a PWP (换购) promotion may only be exchanged WITHIN the
     promotion's own range:
       • REWARD line (variants.pwp + pwpCode) → only SKUs inside the code's
         snapshotted reward set (reward_category + eligible_reward_model_ids,
         [] = whole category), priced at the new SKU's PWP price — the deal
         survives the exchange; redeemed_item_code is re-stamped after.
       • TRIGGER line (this SO minted codes off it — pwp_codes.source_doc_no
         = docNo, trigger_item_code = the line's SKU) → only SKUs inside
         EVERY anchoring rule's trigger set (trigger_category +
         trigger_eligible_model_ids); trigger_item_code is re-stamped after.
     A code whose rule is gone can't be validated → locked (coordinator). */
  const rewardPwpCode = prevVariants.pwp ? String(prevVariants.pwpCode ?? '').trim() : '';
  let unitSen: number;
  let variantsAfterSwap: Record<string, unknown> | null = null;
  /* PWP dynamic re-evaluation (Loo 2026-06-12, unified with the sofa
     exchange): classified before any write, applied after the line lands. */
  type SwapPwpRule = {
    id: string; trigger_category: string; trigger_eligible_model_ids: string[] | null;
    trigger_combo_ids: string[] | null; reward_category: string;
    eligible_reward_model_ids: string[] | null; reward_combo_ids: string[] | null;
    trigger_size_codes: string[] | null; trigger_compartments: string[] | null;
    reward_size_codes: string[] | null; reward_compartments: string[] | null;
    qty_per_trigger: number | null; type: string | null;
  };
  type SwapRewardRevertLine = {
    id: string; item_code: string; item_group: string; qty: number;
    unit_price_sen: number; discount_sen: number | null;
    unit_cost_sen: number | null; variants: Record<string, unknown> | null;
  };
  let triggerCodesToRestamp: string[] = [];
  const pwpDeleteCodes: string[] = [];
  const pwpRevertCodes: string[] = [];
  let rewardLinesToRevert: SwapRewardRevertLine[] = [];
  const sofaRevertPlans: SofaRewardRevertUpdate[] = [];
  let pwpNewlyTriggered: SwapPwpRule[] = [];
  if (prevVariants.pwp) {
    if (!rewardPwpCode) {
      return c.json({ error: 'pwp_line_locked', reason: 'This PWP reward carries no voucher code — ask the coordinator to exchange it.' }, 409);
    }
    const { data: codeRow } = await scopeToCompany(sb.from('pwp_codes').select('code, reward_category, eligible_reward_model_ids, reward_size_codes, reward_compartments, type').eq('code', rewardPwpCode), c).maybeSingle();
    const codeTyped = codeRow as { code: string; reward_category: string; eligible_reward_model_ids: string[] | null; reward_size_codes: string[] | null; reward_compartments: string[] | null; type: string } | null;
    if (!codeTyped) {
      return c.json({ error: 'pwp_line_locked', reason: 'This PWP voucher could not be found — ask the coordinator to exchange it.' }, 409);
    }
    const inCategory = String(prod.category).toUpperCase() === String(codeTyped.reward_category).toUpperCase();
    const eligibleModels = codeTyped.eligible_reward_model_ids ?? [];
    const inModels = eligibleModels.length === 0 || (prod.model_id != null && eligibleModels.includes(prod.model_id));
    // 0182 reward refinement — a refined voucher's size narrowing applies to a swap too.
    const inRefinement = passesRefinementColumns(
      { category: String(prod.category), modelId: prod.model_id ?? null, sizeCode: prod.size_code ? String(prod.size_code).toUpperCase() : null, builtCompartments: [] },
      codeTyped.reward_size_codes, codeTyped.reward_compartments,
    );
    if (!inCategory || !inModels || !inRefinement) {
      return c.json({
        error: 'pwp_swap_out_of_range',
        reason: 'A PWP reward can only be exchanged for another item inside the promotion\'s reward range.',
        itemCode: newCode,
      }, 409);
    }
    const pwpSen = Math.max(0, Math.round(Number(prod.pwp_price_sen ?? 0)));
    if (codeTyped.type !== 'promo' && pwpSen <= 0) {
      return c.json({ error: 'pwp_reward_unpriced', reason: 'This item has no PWP price yet — ask an admin to set it in the SKU Master.', itemCode: newCode }, 409);
    }
    unitSen = pwpSen;  // 'promo' grants may redeem at 0 (free) — migration 0145
    variantsAfterSwap = { pwp: true, pwpCode: rewardPwpCode };
  } else {
    /* PWP dynamic re-evaluation (Loo 2026-06-12 - same model as the sofa
       exchange): a trigger line may be exchanged into ANYTHING; the
       promotion then re-evaluates against the NEW product:
         - rule still triggered: voucher survives, stamp re-points;
         - trigger gone + voucher redeemed on THIS order: that reward line
           reverts to its normal price and the code is deleted;
         - trigger gone + un-redeemed: code deleted (released);
         - trigger gone + redeemed on ANOTHER order: blocked (the reward
           was already given out - coordinator only);
         - newly triggered rule: fresh vouchers mint after the swap.
       Anchoring is RANGE-based with the stamp as fallback (stamps go stale
       - SO-2606-009), plus orphan-stamp adoption for legacy swaps. */
    const { data: soCodes } = await sb.from('pwp_codes')
      .select('code, rule_id, status, trigger_item_code, redeemed_doc_no')
      .eq('source_doc_no', docNo);
    const anchors = (soCodes ?? []) as Array<{ code: string; rule_id: string | null; status: string; trigger_item_code: string | null; redeemed_doc_no: string | null }>;
    {
      const { data: ruleRows } = await scopeToCompany(
        sb.from('pwp_rules')
          .select('id, trigger_category, trigger_eligible_model_ids, trigger_combo_ids, reward_category, eligible_reward_model_ids, reward_combo_ids, trigger_size_codes, trigger_compartments, reward_size_codes, reward_compartments, qty_per_trigger, type'),
        c,
      ).eq('active', true);
      const rules = (ruleRows ?? []) as SwapPwpRule[];
      const ruleById = new Map(rules.map((r) => [r.id, r]));
      const fitsTrigger = (r: SwapPwpRule | undefined,
                           p: { category?: string | null; model_id?: string | null; size_code?: string | null } | null): boolean => {
        if (!r || !p) return false;
        // Combo-defined (sofa) triggers can never be satisfied by a one-line
        // product swap; the category check below also excludes them.
        if ((r.trigger_combo_ids ?? []).length > 0) return false;
        const inCat = String(p.category ?? '').toUpperCase() === String(r.trigger_category).toUpperCase();
        const models = r.trigger_eligible_model_ids ?? [];
        if (!inCat || !(models.length === 0 || (p.model_id != null && models.includes(p.model_id)))) return false;
        // Size refinement (0182) — a one-line swap is non-sofa, so only size_codes apply.
        return passesRefinementColumns(
          { category: String(p.category ?? ''), modelId: p.model_id ?? null, sizeCode: p.size_code ? String(p.size_code).toUpperCase() : null, builtCompartments: [] },
          r.trigger_size_codes, r.trigger_compartments,
        );
      };
      if (anchors.length > 0) {
        const prevProd = await loadProductByCode(sb, prev.item_code, activeCompanyId(c));
        const { data: lineRows } = await sb.from('mfg_sales_order_items')
          .select('item_code').eq('doc_no', docNo).eq('cancelled', false);
        const liveCodes = new Set(((lineRows ?? []) as Array<{ item_code: string }>).map((r) => r.item_code));
        /* Anchored to THIS line: stamp match, current product in the rule's
           trigger range, or an orphaned stamp whose rule matches the line's
           category (legacy pre-restamp swaps). */
        const anchored = anchors.filter((a) => {
          if (a.trigger_item_code === prev.item_code) return true;
          const r = a.rule_id ? ruleById.get(a.rule_id) : undefined;
          if (fitsTrigger(r, prevProd)) return true;
          return a.trigger_item_code != null && !liveCodes.has(a.trigger_item_code)
            && !!r && String(r.trigger_category).toUpperCase() === String(prevProd?.category ?? '').toUpperCase();
        });
        for (const cd of anchored) {
          const r = cd.rule_id ? ruleById.get(cd.rule_id) : undefined;
          if (r && fitsTrigger(r, prod)) { triggerCodesToRestamp.push(cd.code); continue; }
          if (cd.status === 'USED') {
            if (cd.redeemed_doc_no && cd.redeemed_doc_no !== docNo) {
              return c.json({
                error: 'pwp_trigger_cross_order',
                reason: `This item triggered voucher ${cd.code}, already redeemed on ${cd.redeemed_doc_no} - ask the coordinator to exchange it.`,
              }, 409);
            }
            pwpRevertCodes.push(cd.code);
          } else {
            pwpDeleteCodes.push(cd.code);
          }
        }
        if (pwpRevertCodes.length > 0) {
          const { data: pwpLines } = await sb.from('mfg_sales_order_items')
            .select('id, item_code, item_group, qty, unit_price_sen, discount_sen, unit_cost_sen, variants')
            .eq('doc_no', docNo).eq('cancelled', false)
            .filter('variants->>pwp', 'eq', 'true');
          const revertSet = new Set(pwpRevertCodes);
          const allRevertLines = ((pwpLines ?? []) as SwapRewardRevertLine[])
            .filter((l) => revertSet.has(String(((l.variants ?? {}) as Record<string, unknown>).pwpCode ?? '')));
          rewardLinesToRevert = allRevertLines.filter((l) => String(l.item_group) !== 'sofa');
          /* Sofa rewards revert as a WHOLE build (read-only plan first - a
             build that can't be safely repriced blocks before any write). */
          const sofaRevertCodes = [...new Set(allRevertLines
            .filter((l) => String(l.item_group) === 'sofa')
            .map((l) => String(((l.variants ?? {}) as Record<string, unknown>).pwpCode ?? ''))
            .filter(Boolean))];
          for (const cdx of sofaRevertCodes) {
            const plan = await planSofaRewardRevert(sb, docNo, cdx, c);
            if (!plan.ok) {
              return c.json({
                error: 'pwp_reward_sofa_revert_unsupported',
                reason: 'The sofa reward this voucher paid for cannot be auto-repriced - ask the coordinator to exchange it.',
              }, 409);
            }
            sofaRevertPlans.push(...plan.updates);
          }
        }
      }
      pwpNewlyTriggered = rules.filter((r) => fitsTrigger(r, prod));
    }
    const sellSen = Math.max(0, Math.round(Number(prod.sell_price_sen ?? 0)));
    if (sellSen <= 0) {
      return c.json({ error: 'product_unpriced', reason: 'This product has no selling price yet — ask an admin to price it in the SKU Master.', itemCode: newCode }, 409);
    }
    unitSen = sellSen;
  }

  /* Composition — a swap must not INTRODUCE a sofa × (bedframe|mattress) mix. */
  {
    const mainMix = await lineMixRefusal(sb, 'mfg_sales_order_items', docNo, itemId, newCode, activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  const qty = Number(prev.qty);
  const discount = Number(prev.discount_sen ?? 0);
  // Same invariant as the price-override path and the variant edit above: a SWAP
  // to a cheaper SKU must not strand a discount that no longer fits, because the
  // negative total is then clamped away downstream.
  if (discount > qty * unitSen) {
    return c.json({
      error: 'discount_exceeds_new_price',
      message:
        `That product is cheaper than the line's ${(discount / 100).toFixed(2)} discount allows. ` +
        `Reduce the discount first, then swap the product.`,
      discount,
      max: qty * unitSen,
    }, 422);
  }
  const newTotal = (qty * unitSen) - discount;
  /* The total floor that stood here (Loo 2026-06-11) is GONE — owner ruling,
     relayed 2026-08-18. A swap may land on a cheaper product. */
  const newCost = Math.max(0, Math.round(Number(prod.cost_price_sen ?? 0)));
  const { error: upErr } = await sb.from('mfg_sales_order_items').update({
    item_code: newCode,
    item_group: String(prod.category ?? 'others').toLowerCase(),
    description: prod.name,
    description2: null,
    variants: variantsAfterSwap,
    unit_price_sen: unitSen,
    total_sen: newTotal,
    total_inc_sen: newTotal,
    balance_sen: newTotal,
    unit_cost_sen: newCost,
    line_cost_sen: newCost * qty,
    line_margin_sen: newTotal - (newCost * qty),
    divan_price_sen: 0,
    leg_price_sen: 0,
    special_order_price_sen: 0,
    custom_specials: null,
  }).eq('id', itemId);
  if (upErr) return c.json({ error: 'update_failed', reason: upErr.message }, 500);

  /* Re-stamp the voucher audit columns so the codes keep pointing at the
     line's CURRENT SKU (best-effort — the line is already correct).

     HAZARD 2 (mig 0188): pwp_codes is keyed on (company_id, code), so every
     statement below carries BOTH halves. `redeemed_doc_no = docNo` on the first
     one proves the voucher is ON this order — it does not prove the order is in
     this caller's books, which is a different question and the one company_id
     answers. */
  const voucherCompanyId = activeCompanyId(c);
  if (voucherCompanyId == null) {
    return c.json({ error: 'company_unresolved', message: 'Cannot tell which company this order belongs to right now. Reload and try again.' }, 409);
  }
  if (rewardPwpCode) {
    const { error: e1 } = await sb.from('pwp_codes')
      .update({ redeemed_item_code: newCode })
      .eq('code', rewardPwpCode).eq('redeemed_doc_no', docNo).eq('company_id', voucherCompanyId);
    throwAtomicCommandWrite(sb, e1, 'TBC reward code restamp failed');
    if (e1) console.error('[tbc-swap] reward code restamp failed:', e1.message); // eslint-disable-line no-console
  }
  if (triggerCodesToRestamp.length > 0) {
    const { error: e2 } = await sb.from('pwp_codes')
      .update({ trigger_item_code: newCode, updated_at: new Date().toISOString() })
      .in('code', triggerCodesToRestamp).eq('company_id', voucherCompanyId);
    throwAtomicCommandWrite(sb, e2, 'TBC trigger code restamp failed');
    if (e2) console.error('[tbc-swap] trigger code restamp failed:', e2.message); // eslint-disable-line no-console
  }

  /* ── PWP mutations (classified above, applied after the line landed) —
     mirrors the sofa exchange (tbc-swap-sofa). ── */
  const pwpMintedCodes: string[] = [];
  /* Sofa-reward builds revert via the pre-computed whole-build plan. */
  for (const u of sofaRevertPlans) {
    const { id: uid, ...cols } = u;
    const { error } = await sb.from('mfg_sales_order_items').update({
      ...cols,
      total_inc_sen: cols.total_sen,
      balance_sen: cols.total_sen,
    }).eq('id', uid);
    throwAtomicCommandWrite(sb, error, `TBC sofa reward revert failed for ${uid}`);
    if (error) console.error('[tbc-swap] sofa reward revert failed for', uid, error.message); // eslint-disable-line no-console
  }
  if (rewardLinesToRevert.length > 0 || pwpDeleteCodes.length > 0 || pwpRevertCodes.length > 0 || pwpNewlyTriggered.length > 0) {
    // Loaders only when the re-evaluation actually has work to do.
    const [cfgX, addonCfgX, specialDefsX, modelOverridesX, compartmentOverridesX] = await Promise.all([
      loadMaintenanceConfig(sb),
      loadFabricTierAddonConfig(sb, activeCompanyId(c)),
      loadSpecialAddons(sb),
      loadModelFabricTierOverrides(sb),
      loadCompartmentFabricTierOverrides(sb),
    ]);
    // 1. Rewards whose trigger is gone revert to their normal price (picks +
    //    surcharges survive; pwp markers stripped). clientUnit 0 lets the
    //    recompute FILL the authoritative price without a drift reject.
    for (const line of rewardLinesToRevert) {
      const v: Record<string, unknown> = { ...((line.variants ?? {}) as Record<string, unknown>) };
      delete v.pwp; delete v.pwpCode; delete v.pwpTriggerLabel;
      const [rp, rfab, rtiers] = await Promise.all([
        loadProductByCode(sb, line.item_code, activeCompanyId(c)),
        loadFabricByCode(sb, (v.fabricCode as string | undefined) ?? null),
        loadFabricSellingTiers(sb, (v.fabricId as string | undefined) ?? null),
      ]);
      const rec = recomputeFromSnapshot(
        { itemCode: line.item_code, itemGroup: String(line.item_group ?? 'others'), qty: Number(line.qty), unitPriceSen: 0, variants: v as MfgItemForRecompute['variants'] },
        rp, rfab, cfgX, null, null, rtiers, addonCfgX, null, null, specialDefsX, null, modelOverridesX, compartmentOverridesX,
      );
      const revertUnit = rec.unit_price_sen > 0 ? rec.unit_price_sen : Number(line.unit_price_sen);
      const lqty = Number(line.qty);
      const ldisc = Number(line.discount_sen ?? 0);
      const lTotal = (lqty * revertUnit) - ldisc;
      const lCost = Number(line.unit_cost_sen ?? 0);
      const { error } = await sb.from('mfg_sales_order_items').update({
        variants: v,
        description2: buildVariantSummary(String(line.item_group ?? ''), v) || null,
        unit_price_sen: revertUnit,
        total_sen: lTotal,
        total_inc_sen: lTotal,
        balance_sen: lTotal,
        line_margin_sen: lTotal - (lCost * lqty),
        divan_price_sen: rec.breakdown.divanSurchargeSen,
        leg_price_sen: rec.breakdown.legSurchargeSen,
        special_order_price_sen: rec.breakdown.specialsSurchargeSen,
        custom_specials: rec.custom_specials ?? null,
      }).eq('id', line.id);
      throwAtomicCommandWrite(sb, error, `TBC reward revert failed for ${line.id}`);
      if (error) console.error('[tbc-swap] reward revert failed for', line.id, error.message); // eslint-disable-line no-console
    }
    // 2. Dead vouchers go (un-redeemed + reverted ones - Loo: delete).
    //    HAZARD 2: this DESTROYS a voucher. Half a key deletes theirs.
    const toDelete = [...pwpDeleteCodes, ...pwpRevertCodes];
    if (toDelete.length > 0) {
      const { error } = await sb.from('pwp_codes').delete()
        .in('code', toDelete).eq('company_id', voucherCompanyId);
      throwAtomicCommandWrite(sb, error, 'TBC code delete failed');
      if (error) console.error('[tbc-swap] code delete failed:', error.message); // eslint-disable-line no-console
    }
    // 3. Newly-triggered rules mint fresh vouchers (AVAILABLE, customer-bound),
    //    topped up against the codes this line kept.
    if (pwpNewlyTriggered.length > 0) {
      const { data: hdr } = await sb.from('mfg_sales_orders').select('customer_id').eq('doc_no', docNo).maybeSingle();
      const customerId = ((hdr as { customer_id?: string | null } | null)?.customer_id) ?? null;
      /* Provenance for the minted vouchers — resolved ONCE, outside the mint
         loops. These land AVAILABLE, which is redeemable regardless of owner, so
         this is who minted it rather than a gate; it still must not be the
         bridge's pin, which records every voucher as minted by "System". */
      const mintOwnerStaffId = await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id);
      const { data: keptRows } = triggerCodesToRestamp.length > 0
        ? await sb.from('pwp_codes').select('code, rule_id')
            .in('code', triggerCodesToRestamp).eq('company_id', voucherCompanyId)
        : { data: [] };
      const keptByRule = new Map<string, number>();
      for (const k of ((keptRows ?? []) as Array<{ rule_id: string | null }>)) {
        if (k.rule_id) keptByRule.set(k.rule_id, (keptByRule.get(k.rule_id) ?? 0) + 1);
      }
      for (const r of pwpNewlyTriggered) {
        const target = Math.max(0, Math.floor((Number(r.qty_per_trigger) || 1) * qty));
        const have = keptByRule.get(r.id) ?? 0;
        for (let i = have; i < target; i++) {
          for (let attempt = 0; attempt < 5; attempt++) {
            const code = genCode();
            const { error } = await sb.from('pwp_codes').insert({
              company_id: activeCompanyId(c), // multi-company: match the SO's company
              code,
              rule_id: r.id,
              reward_category: r.reward_category,
              eligible_reward_model_ids: r.eligible_reward_model_ids ?? [],
              reward_combo_ids: r.reward_combo_ids ?? [],
              reward_size_codes: r.reward_size_codes ?? [],
              reward_compartments: r.reward_compartments ?? [],
              type: r.type ?? 'pwp',
              status: 'AVAILABLE',
              owner_staff_id: mintOwnerStaffId,
              cart_line_key: null,
              trigger_item_code: newCode,
              source_doc_no: docNo,
              customer_id: customerId,
            });
            if (!error) { pwpMintedCodes.push(code); break; }
            if (attempt === 4) {
              throwAtomicCommandWrite(sb, error, 'TBC voucher mint failed');
              console.error('[tbc-swap] voucher mint failed:', error.message); // eslint-disable-line no-console
            }
          }
        }
      }
    }
  }

  // Default Free Gift (0170) — runs AFTER the PWP re-evaluation above, in place
  // of the final recomputeTotals: a product swap can add/drop a trigger, so
  // reconcile syncs the accessory gift lines and then recomputes header totals.
  await reconcileFreeGiftLinesForSo(sb, docNo, c);
  // Re-derive the delivery fee — a product swap can flip a cross-category mix or
  // a special-delivery trigger. Stored cross-category source kept.
  await rederiveDeliveryFee(sb, docNo, c);
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', from: prev.item_code, to: newCode },
      { field: 'unitPriceSen', from: prev.unit_price_sen, to: unitSen },
      { field: 'totalSen', from: prev.total_sen, to: newTotal },
      ...(rewardPwpCode ? [{ field: 'pwpCode', to: rewardPwpCode } satisfies FieldChange] : []),
      ...(pwpRevertCodes.length > 0
        ? [{ field: 'pwpRewardsReverted', to: pwpRevertCodes.join(', ') } satisfies FieldChange] : []),
      ...(pwpDeleteCodes.length > 0
        ? [{ field: 'pwpCodesDeleted', to: pwpDeleteCodes.join(', ') } satisfies FieldChange] : []),
      ...(pwpMintedCodes.length > 0
        ? [{ field: 'pwpCodesMinted', to: pwpMintedCodes.join(', ') } satisfies FieldChange] : []),
    ],
  });
  /* Persist the invalidation in this transaction; an after-commit attempt gives
     low latency and the cron-backed singleton queue guarantees retry. */
  await scheduleStockAllocationAfterCommand(c, sb, `tbc-swap:${docNo}`);

  return c.json({
    ok: true,
    itemCode: newCode,
    unitPriceSen: unitSen,
    totalSen: newTotal,
    pwp: {
      kept: triggerCodesToRestamp.length,
      reverted: pwpRevertCodes.length,
      deleted: pwpDeleteCodes.length,
      minted: pwpMintedCodes,
    },
  });
}
mfgSalesOrders.post('/:docNo/items/:itemId/tbc-swap', async (c) => {
  const company = requireActiveCompanyId(c);
  if (!company.ok) return c.json(company.refusal, 409);
  return queueAcSoEditAfter(c, c.req.param('docNo'), await runScmPgCommand(c, (sb) => tbcSwapCommandHandler(c, sb), {
    docNo: c.req.param('docNo'),
    leaseToken: c.req.header('X-SO-Edit-Lease')?.trim() ?? null, userId: soCallerUserId(c),
    companyId: company.companyId,
  }));
});

/* ── Sofa-reward revert plan (Loo 2026-06-12) ──
   When a TRIGGER swap strands a SOFA reward on the same SO, the reward must
   revert to its normal selling price — but a sofa lives as per-module split
   lines whose PWP total was spread proportionally, so the revert is a
   whole-build job: reconstruct the build from the split lines (module code
   from the SKU, x/y/rot/cellIndex from variants), reprice it on the
   authoritative engine WITHOUT the PWP grant, re-spread across the same
   lines, strip the pwp markers. Planned READ-ONLY before any write — a
   build that can't be safely repriced (no module prices / line-count
   mismatch) returns ok:false and the caller blocks for the coordinator. */
type SofaRewardRevertUpdate = {
  id: string;
  unit_price_sen: number;
  total_sen: number;
  line_margin_sen: number;
  variants: Record<string, unknown>;
  description2: string | null;
  divan_price_sen: number;
  leg_price_sen: number;
  special_order_price_sen: number;
  custom_specials: unknown;
};
async function planSofaRewardRevert(
  sb: any,
  docNo: string,
  pwpCode: string,
  c: any,
): Promise<{ ok: true; updates: SofaRewardRevertUpdate[] } | { ok: false }> {
  const { data } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, unit_price_sen, discount_sen, unit_cost_sen, line_cost_sen, variants')
    .eq('doc_no', docNo).eq('cancelled', false)
    .filter('variants->>pwpCode', 'eq', pwpCode);
  type Row = {
    id: string; item_code: string; item_group: string; qty: number;
    unit_price_sen: number; discount_sen: number | null;
    unit_cost_sen: number | null; line_cost_sen: number | null;
    variants: Record<string, unknown> | null;
  };
  const lines = (((data ?? []) as Row[]))
    .filter((l) => String(l.item_group) === 'sofa' && ((l.variants ?? {}) as Record<string, unknown>).pwp)
    .sort((a, b) =>
      Number(((a.variants ?? {}) as Record<string, unknown>).cellIndex ?? 0)
      - Number(((b.variants ?? {}) as Record<string, unknown>).cellIndex ?? 0));
  if (lines.length === 0) return { ok: true, updates: [] };

  const lead = lines[0]!;
  const leadV = ((lead.variants ?? {}) as Record<string, unknown>);
  const baseModel = splitSofaCode(lead.item_code).baseModel;
  if (!baseModel) return { ok: false };
  const cells = lines.map((l) => {
    const v = ((l.variants ?? {}) as Record<string, unknown>);
    return {
      moduleId: splitSofaCode(l.item_code).sizeCode || l.item_code,
      x: typeof v.x === 'number' ? v.x : 0,
      y: typeof v.y === 'number' ? v.y : 0,
      rot: typeof v.rot === 'number' ? v.rot : 0,
    };
  });
  /* Variants-vocabulary unification (port of 2990 73aeeb1e) — dual-read:
     post-unification a persisted sofa row stores `seatHeight`; legacy rows
     stored `depth`. */
  const depth = String(leadV.depth ?? leadV.seatHeight ?? '24');
  const [cfg, prodLite, fabLite, combos, sellingTiers, addonCfg, specialDefs, modulePrices, modelOverridesLead, compartmentOverridesLead] = await Promise.all([
    loadMaintenanceConfig(sb),
    loadProductByCode(sb, lead.item_code, activeCompanyId(c)),
    loadFabricByCode(sb, (leadV.fabricCode as string | undefined) ?? null),
    loadActiveSofaCombos(sb, c),
    loadFabricSellingTiers(sb, (leadV.fabricId as string | undefined) ?? null),
    loadFabricTierAddonConfig(sb, activeCompanyId(c)),
    loadSpecialAddons(sb),
    loadModelSofaModulePrices(sb, splitSofaCode(lead.item_code).baseModel, depth, activeCompanyId(c)),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  if (!prodLite || !modulePrices) return { ok: false };
  const pricingVariants: Record<string, unknown> = { ...leadV, cells };
  delete pricingVariants.pwp; delete pricingVariants.pwpCode; delete pricingVariants.pwpTriggerLabel;
  delete pricingVariants.buildKey; delete pricingVariants.cellIndex;
  delete pricingVariants.x; delete pricingVariants.y; delete pricingVariants.rot;
  const rec = recomputeFromSnapshot(
    { itemCode: lead.item_code, itemGroup: 'sofa', qty: Number(lead.qty), unitPriceSen: 0, variants: pricingVariants as MfgItemForRecompute['variants'] },
    prodLite, fabLite, cfg, combos, modulePrices, sellingTiers, addonCfg,
    null, null,   // NO pwp grant — this IS the revert
    specialDefs, null, modelOverridesLead,
  );
  if (rec.unit_price_sen <= 0) return { ok: false };
  const split = splitSofaBuildIntoModuleLines({
    baseModel,
    cells,
    buildUnitPriceSen: rec.unit_price_sen,
    buildUnitCostSen: 0,   // costs stay per-line as already booked
    modulePrices,
  });
  if (!split || split.length !== lines.length) return { ok: false };
  const updates: SofaRewardRevertUpdate[] = lines.map((l, i) => {
    const v: Record<string, unknown> = { ...((l.variants ?? {}) as Record<string, unknown>) };
    delete v.pwp; delete v.pwpCode; delete v.pwpTriggerLabel;
    const unitSenI = split[i]!.unitPriceSen;
    const lqty = Number(l.qty);
    const ldisc = Number(l.discount_sen ?? 0);
    const lTotal = (lqty * unitSenI) - ldisc;
    const lCost = Number(l.line_cost_sen ?? (Number(l.unit_cost_sen ?? 0) * lqty));
    return {
      id: l.id,
      unit_price_sen: unitSenI,
      total_sen: lTotal,
      line_margin_sen: lTotal - lCost,
      variants: v,
      description2: buildVariantSummary('sofa', v) || null,
      divan_price_sen: i === 0 ? rec.breakdown.divanSurchargeSen : 0,
      leg_price_sen: i === 0 ? rec.breakdown.legSurchargeSen : 0,
      special_order_price_sen: i === 0 ? rec.breakdown.specialsSurchargeSen : 0,
      custom_specials: i === 0 ? (rec.custom_specials ?? null) : null,
    };
  });
  return { ok: true, updates };
}

/* TBC sofa exchange (Loo 2026-06-12) — replace a WHOLE sofa build from the
   POS configurator's "Confirm Change". The new build arrives as ONE
   handover-shaped sofa item (variants.cells + depth + fabric / leg /
   specials); the server reprices it on the SAME authoritative path as SO
   create (per-Model module sell prices + combos + fabric-tier Δ + special
   add-ons, drift-gated for POS callers), splits it into per-module lines
   (P3) under the OLD buildKey, inserts the new set, then removes the old.
   The edit lease prevents another SO writer from interleaving, but these
   The route wrapper executes the complete command on one PostgreSQL transaction;
   any database failure rolls the old/new build and voucher writes back.
   Floor rule: the new build total may not sit below the old one (sales).
   PWP reward sofa builds stay coordinator-only (the reward is combo-bound). */
export async function tbcSwapSofaCommandHandler(c: any, sb: any): Promise<Response> {
  const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const item = (body.item ?? null) as { itemCode?: unknown; qty?: unknown; unitPriceSen?: unknown; description?: unknown; variants?: Record<string, unknown> | null } | null;
  const newCode = String(item?.itemCode ?? '').trim();
  if (!item || !newCode) return c.json({ error: 'item_code_required' }, 400);

  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  /* AUTHZ BEFORE CONCURRENCY (2026-07-22) — the self-scope gate above now runs
     BEFORE the edit lease. A caller who may not touch this order at all used to
     be told "This order is being saved on another screen; wait a moment and try
     Save again" — a permission refusal wearing a conflict's clothes, which
     invites an endless retry and never surfaces the real reason. */
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  const { data: prevRow } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, discount_sen, total_sen, variants, cancelled, line_date, debtor_code, debtor_name, agent, venue, branding, line_delivery_date, line_delivery_date_overridden, warehouse_id, remark')
    .eq('id', itemId).eq('doc_no', docNo).maybeSingle();
  const prev = prevRow as {
    id: string; item_code: string; item_group: string; qty: number; discount_sen: number | null;
    total_sen: number | null; variants: Record<string, unknown> | null; cancelled: boolean;
    line_date: string | null; debtor_code: string | null; debtor_name: string | null; agent: string | null;
    venue: string | null; branding: string | null; line_delivery_date: string | null;
    line_delivery_date_overridden: boolean | null; warehouse_id: string | null; remark: string | null;
  } | null;
  if (!prev) return c.json({ error: 'not_found' }, 404);
  if (prev.cancelled) return c.json({ error: 'line_cancelled' }, 409);
  if (String(prev.item_group) !== 'sofa') {
    return c.json({ error: 'sofa_swap_only', reason: 'This exchange path only replaces sofa builds.' }, 400);
  }
  const prevVariants = ((prev.variants ?? {}) as Record<string, unknown>);
  const buildKey = (prevVariants.buildKey as string | undefined) ?? null;

  /* The whole OLD build — every non-cancelled line sharing the buildKey
     (legacy single-line sofas have no buildKey → just the requested line). */
  let oldLines: Array<{ id: string; item_code: string; total_sen: number | null; variants: Record<string, unknown> | null; photo_urls: string[] | null; line_no?: number | null }> = [];
  if (buildKey) {
    const { data: rows } = await sb.from('mfg_sales_order_items')
      .select('id, item_code, total_sen, variants, photo_urls, line_no')
      .eq('doc_no', docNo).eq('cancelled', false)
      .filter('variants->>buildKey', 'eq', buildKey);
    oldLines = ((rows ?? []) as typeof oldLines);
  }
  if (oldLines.length === 0) {
    const { data: solo } = await sb.from('mfg_sales_order_items')
      .select('id, item_code, total_sen, variants, photo_urls, line_no').eq('id', itemId).maybeSingle();
    if (solo) oldLines = [solo as (typeof oldLines)[number]];
  }
  /* PWP REWARD build (Loo 2026-06-12) — exchangeable: the new build
     re-matches the voucher's reward combos. Matched -> priced at that
     combo's PWP price and the voucher rides on (redeemed_item_code
     re-points). Unmatched -> the build prices as a normal sale and the
     voucher RELEASES back to AVAILABLE: the customer earned it off a
     trigger that still stands, so deleting it would strip a paid-for
     entitlement (the trigger-side path deletes when the JUSTIFICATION
     dies instead). */
  let rewardCtx: { code: string; comboIds: string[]; type: string } | null = null;
  if (oldLines.some((l) => ((l.variants ?? {}) as Record<string, unknown>).pwp)) {
    const codeStr = String(
      oldLines.map((l) => ((l.variants ?? {}) as Record<string, unknown>).pwpCode).find(Boolean) ?? '',
    ).trim();
    if (!codeStr) {
      return c.json({ error: 'pwp_line_locked', reason: 'This PWP reward carries no voucher code — ask the coordinator to exchange it.' }, 409);
    }
    const { data: codeRow } = await scopeToCompany(sb.from('pwp_codes').select('code, reward_combo_ids, type, redeemed_doc_no').eq('code', codeStr), c).maybeSingle();
    const ct = codeRow as { code: string; reward_combo_ids: string[] | null; type: string | null; redeemed_doc_no: string | null } | null;
    if (!ct) {
      return c.json({ error: 'pwp_line_locked', reason: 'This PWP voucher could not be found — ask the coordinator to exchange it.' }, 409);
    }
    if (ct.redeemed_doc_no && ct.redeemed_doc_no !== docNo) {
      return c.json({ error: 'pwp_line_locked', reason: 'This voucher is redeemed on a different order — ask the coordinator to exchange it.' }, 409);
    }
    rewardCtx = { code: ct.code, comboIds: ct.reward_combo_ids ?? [], type: String(ct.type ?? 'pwp') };
  }

  /* New build validation — must be a real configurator build on a SOFA SKU. */
  {
    const codeCheck = await validateItemCodes(sb, [newCode], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }
  const newVariants: Record<string, unknown> = { ...((item.variants ?? {}) as Record<string, unknown>) };
  /* A swap build is a normal sale — strip any PWP markers the configurator
     PWP machinery could have left on the snapshot. Also strip freeItem: a
     sofa swap cannot inject a free-item marker (anti-tamper, Task 6). */
  delete newVariants.pwp; delete newVariants.pwpCode; delete newVariants.pwpTriggerLabel;
  delete newVariants.freeItem;
  const newCells = newVariants.cells;
  if (!Array.isArray(newCells) || newCells.length === 0) {
    return c.json({ error: 'sofa_swap_requires_build', reason: 'Configure the sofa (its modules) before confirming the exchange.' }, 400);
  }
  const prodLite = await loadProductByCode(sb, newCode, activeCompanyId(c));
  if (!prodLite || String(prodLite.category).toUpperCase() !== 'SOFA') {
    return c.json({ error: 'sofa_swap_only', reason: 'The replacement must be a sofa.' }, 400);
  }
  {
    const { product, model, lookupError } = await loadProductAndModel(sb, newCode, activeCompanyId(c));
    // A failed catalog read is ignorance, not permission — refuse, don't skip the gate.
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(product, model, newVariants as Parameters<typeof checkAllowedOptions>[2]);
    if (aoErr) return c.json({ ...aoErr, itemCode: newCode }, 400);
  }

  /* Authoritative reprice — the SAME inputs as SO create / item PATCH. */
  /* Variants-vocabulary unification (port of 2990 73aeeb1e) — dual-read: a
     Backend-loaded swap build may carry the canonical `seatHeight`; POS posts
     `depth`. recomputeFromSnapshot below also reads `depth ?? seatHeight`. */
  const depth = String((newVariants as { depth?: unknown; seatHeight?: unknown }).depth ?? (newVariants as { seatHeight?: unknown }).seatHeight ?? '24');
  const [cfg, fabLite, combos, sellingTiers, fabricAddonCfg, specialDefs, modulePrices, moduleCostRows, modelOverridesSwap, compartmentOverridesSwap] = await Promise.all([
    loadMaintenanceConfig(sb),
    loadFabricByCode(sb, (newVariants.fabricCode as string | undefined) ?? null),
    loadActiveSofaCombos(sb, c),
    loadFabricSellingTiers(sb, (newVariants.fabricId as string | undefined) ?? null),
    loadFabricTierAddonConfig(sb, activeCompanyId(c)),
    loadSpecialAddons(sb),
    loadModelSofaModulePrices(sb, prodLite.base_model, depth, activeCompanyId(c)),
    loadModelSofaModuleCostRows(sb, prodLite.base_model, activeCompanyId(c)),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb), // migration 0025 — per-compartment Δ
  ]);
  const qty = Math.max(1, Math.floor(Number(item.qty ?? 1)));
  const clientUnit = Math.max(0, Math.round(Number(item.unitPriceSen ?? 0)));
  /* Does the NEW build match one of the voucher's reward combos? Same
     matcher the engine + POS use. Matched -> the recompute charges those
     combos' PWP prices (pwpSofaComboIds); unmatched -> normal selling. */
  const rewardComboMatch = rewardCtx != null && (() => {
    const comboByIdR = new Map((combos ?? []).map((cb) => [cb.id, cb]));
    const mods = (newCells as Array<{ moduleId?: unknown }>)
      .map((cl) => String(cl?.moduleId ?? '').trim()).filter(Boolean);
    return rewardCtx.comboIds.some((id) => {
      const cb = comboByIdR.get(id);
      if (!cb) return false;
      if (cb.baseModel && cb.baseModel !== (prodLite.base_model ?? '')) return false;
      return matchComboSubset(mods, cb.modules) != null;
    });
  })();
  const recomputed = recomputeFromSnapshot(
    { itemCode: newCode, itemGroup: 'sofa', qty, unitPriceSen: clientUnit, variants: newVariants as MfgItemForRecompute['variants'] },
    prodLite, fabLite, cfg, combos, modulePrices, sellingTiers, fabricAddonCfg,
    null,
    rewardComboMatch && rewardCtx ? rewardCtx.comboIds : null,
    specialDefs, moduleCostRows, modelOverridesSwap, compartmentOverridesSwap,
  );
  const posTablet = await isPosTabletCaller(c);
  /* Reward swaps skip the drift COMPARISON (the POS configurator prices the
     build at normal selling — it has no voucher awareness); the persisted
     figure is the server's authoritative PWP price either way, so a client
     can still never author the money. */
  if (posTablet && recomputed.drift && !rewardCtx) {
    return c.json({
      error: 'pricing_drift',
      reason: 'The price for this item is out of date — please refresh and try again.',
      itemCode: newCode,
      client: clientUnit,
      server: recomputed.unit_price_sen,
      breakdown: recomputed.breakdown,
    }, 400);
  }
  const unit = recomputed.unit_price_sen;
  const unitCost = recomputed.unit_cost_sen > 0
    ? recomputed.unit_cost_sen
    : await snapshotUnitCostSen(sb, newCode, 0, c);
  const discount = Number(prev.discount_sen ?? 0);
  // Same invariant as :6199 / the variant edit / the product swap — a sofa
  // exchange to a cheaper build must not strand a discount that no longer fits.
  if (discount > qty * unit) {
    return c.json({
      error: 'discount_exceeds_new_price',
      message:
        `That build is cheaper than the line's ${(discount / 100).toFixed(2)} discount allows. ` +
        `Reduce the discount first, then exchange the sofa.`,
      discount,
      max: qty * unit,
    }, 422);
  }
  const newBuildTotal = (qty * unit) - discount;
  const oldBuildTotal = oldLines.reduce((s, l) => s + Number(l.total_sen ?? 0), 0);
  /* The total floor that stood here (Loo 2026-06-11) is GONE — owner ruling,
     relayed 2026-08-18. A sofa may be exchanged for a cheaper build.
     `posTablet` above still gates the pricing_drift check, which stays.
     Both totals are still computed: the audit log reports the change. */
  /* A still-matched reward keeps its voucher markers — they ride every
     split line like at SO create. An unmatched one stays stripped (normal
     sale; the voucher releases below). */
  if (rewardCtx && rewardComboMatch) {
    newVariants.pwp = true;
    newVariants.pwpCode = rewardCtx.code;
  }

  /* Variants-vocabulary unification (port of 2990 73aeeb1e) — the sofa-exchange
     path is a 4th persist seam (beyond create/add-line/PATCH). Canonicalize
     the swap build's variants into a separate object that feeds ONLY the
     persisted rows (split or single-line below), so they store seatHeight/
     legHeight/fabricCode. Safe: the authoritative reprice (recomputeFromSnapshot
     above, depth load further up) already ran on the raw POS-vocabulary
     `newVariants`, and splitSofaBuildIntoModuleLines below doesn't read `depth`.
     PWP markers added just above are preserved. */
  const persistVariants = canonicalizeVariants('sofa', newVariants);

  /* Split into per-module lines (P3) — same decomposition as SO create. */
  const split = splitSofaBuildIntoModuleLines({
    baseModel: prodLite.base_model ?? null,
    cells: newCells,
    buildUnitPriceSen: unit,
    buildUnitCostSen: unitCost,
    modulePrices,
  });
  const newBuildKey = buildKey ?? `build-x${String(itemId).slice(0, 8)}`;
  const newLeadCode = split?.[0]?.itemCode ?? newCode;

  /* ── PWP dynamic re-evaluation (Loo 2026-06-12) ──────────────────────
     A trigger sofa may be exchanged into ANYTHING — the promotion then
     re-evaluates against the NEW build instead of restricting the swap:
       • a voucher whose rule the new build STILL triggers survives (its
         trigger stamp re-points at the new lead SKU);
       • a voucher whose trigger is GONE: redeemed on THIS order → that
         reward line reverts to its normal price and the code is deleted;
         un-redeemed (AVAILABLE/RESERVED) → the code is deleted;
         redeemed on ANOTHER order → the exchange is blocked (the reward
         was already given out — coordinator only);
       • a rule the new build NEWLY triggers mints fresh vouchers
         (AVAILABLE, customer-bound, printed on the SO).
     Everything is CLASSIFIED here, before any line is written, so a block
     aborts cleanly; the mutations run after the build replacement. */
  type PwpRuleRow = {
    id: string; trigger_category: string; trigger_eligible_model_ids: string[] | null;
    trigger_combo_ids: string[] | null; reward_category: string;
    eligible_reward_model_ids: string[] | null; reward_combo_ids: string[] | null;
    trigger_size_codes: string[] | null; trigger_compartments: string[] | null;
    reward_size_codes: string[] | null; reward_compartments: string[] | null;
    qty_per_trigger: number | null; type: string | null; active: boolean;
  };
  type RewardRevertLine = {
    id: string; item_code: string; item_group: string; qty: number;
    unit_price_sen: number; discount_sen: number | null;
    unit_cost_sen: number | null; variants: Record<string, unknown> | null;
  };
  const pwpKeepCodes: string[] = [];
  const pwpDeleteCodes: string[] = [];
  const pwpRevertCodes: string[] = [];
  const sofaRevertPlans: SofaRewardRevertUpdate[] = [];
  let pwpRules: PwpRuleRow[] = [];
  let pwpNewlyTriggered: PwpRuleRow[] = [];
  let rewardLinesToRevert: RewardRevertLine[] = [];
  {
    const { data: ruleRows } = await scopeToCompany(
      sb.from('pwp_rules')
        .select('id, trigger_category, trigger_eligible_model_ids, trigger_combo_ids, reward_category, eligible_reward_model_ids, reward_combo_ids, trigger_size_codes, trigger_compartments, reward_size_codes, reward_compartments, qty_per_trigger, type, active'),
      c,
    ).eq('active', true);
    pwpRules = ((ruleRows ?? []) as PwpRuleRow[]);
    const comboById = new Map((combos ?? []).map((cb) => [cb.id, cb]));
    const newModuleIds = (newCells as Array<{ moduleId?: unknown }>)
      .map((cell) => String(cell?.moduleId ?? '').trim()).filter(Boolean);
    const ruleTriggeredByNewBuild = (r: PwpRuleRow): boolean => {
      const comboIds = r.trigger_combo_ids ?? [];
      if (comboIds.length > 0) {
        return comboIds.some((id) => {
          const cb = comboById.get(id);
          if (!cb) return false;
          if (cb.baseModel && cb.baseModel !== (prodLite.base_model ?? '')) return false;
          return matchComboSubset(newModuleIds, cb.modules) != null;
        });
      }
      return String(r.trigger_category).toUpperCase() === 'SOFA'
        && inList(prodLite.model_id ?? null, r.trigger_eligible_model_ids ?? [])
        // Compartment refinement (0182) — an any-build sofa trigger may require a module.
        && passesRefinementColumns(
          { category: 'SOFA', modelId: prodLite.model_id ?? null, sizeCode: null, builtCompartments: newModuleIds },
          r.trigger_size_codes, r.trigger_compartments,
        );
    };
    const ruleById = new Map(pwpRules.map((r) => [r.id, r]));

    const { data: soCodeRows } = await sb.from('pwp_codes')
      .select('code, rule_id, status, trigger_item_code, redeemed_doc_no')
      .eq('source_doc_no', docNo);
    const soCodes = ((soCodeRows ?? []) as Array<{ code: string; rule_id: string | null; status: string; trigger_item_code: string | null; redeemed_doc_no: string | null }>);
    if (soCodes.length > 0) {
      const oldBuildCodes = new Set(oldLines.map((l) => l.item_code));
      const { data: liveRows } = await sb.from('mfg_sales_order_items')
        .select('item_code').eq('doc_no', docNo).eq('cancelled', false);
      const liveCodes = new Set(((liveRows ?? []) as Array<{ item_code: string }>).map((r) => r.item_code));
      /* Anchored to THIS build: stamp inside the build, or an ORPHANED stamp
         (matches no live line — legacy pre-restamp swaps) whose rule is
         sofa-triggered, adopted by this exchange. */
      const anchored = soCodes.filter((cd) => {
        if (!cd.trigger_item_code) return false;
        if (oldBuildCodes.has(cd.trigger_item_code)) return true;
        if (liveCodes.has(cd.trigger_item_code)) return false;
        const r = cd.rule_id ? ruleById.get(cd.rule_id) : undefined;
        return !!r && ((r.trigger_combo_ids ?? []).length > 0 || String(r.trigger_category).toUpperCase() === 'SOFA');
      });
      for (const cd of anchored) {
        const r = cd.rule_id ? ruleById.get(cd.rule_id) : undefined;
        if (r && ruleTriggeredByNewBuild(r)) { pwpKeepCodes.push(cd.code); continue; }
        if (cd.status === 'USED') {
          if (cd.redeemed_doc_no && cd.redeemed_doc_no !== docNo) {
            return c.json({
              error: 'pwp_trigger_cross_order',
              reason: `This sofa triggered voucher ${cd.code}, already redeemed on ${cd.redeemed_doc_no} — ask the coordinator to exchange it.`,
            }, 409);
          }
          pwpRevertCodes.push(cd.code);
        } else {
          pwpDeleteCodes.push(cd.code);
        }
      }
    }
    if (pwpRevertCodes.length > 0) {
      const { data: pwpLines } = await sb.from('mfg_sales_order_items')
        .select('id, item_code, item_group, qty, unit_price_sen, discount_sen, unit_cost_sen, variants')
        .eq('doc_no', docNo).eq('cancelled', false)
        .filter('variants->>pwp', 'eq', 'true');
      const revertSet = new Set(pwpRevertCodes);
      const allRevertLines = ((pwpLines ?? []) as RewardRevertLine[])
        .filter((l) => revertSet.has(String(((l.variants ?? {}) as Record<string, unknown>).pwpCode ?? '')));
      rewardLinesToRevert = allRevertLines.filter((l) => String(l.item_group) !== 'sofa');
      /* Sofa rewards revert as a WHOLE build (read-only plan first - a
         build that can't be safely repriced blocks before any write). */
      const sofaRevertCodes = [...new Set(allRevertLines
        .filter((l) => String(l.item_group) === 'sofa')
        .map((l) => String(((l.variants ?? {}) as Record<string, unknown>).pwpCode ?? ''))
        .filter(Boolean))];
      for (const cdx of sofaRevertCodes) {
        const plan = await planSofaRewardRevert(sb, docNo, cdx, c);
        if (!plan.ok) {
          return c.json({
            error: 'pwp_reward_sofa_revert_unsupported',
            reason: 'The sofa reward this voucher paid for cannot be auto-repriced — ask the coordinator to exchange it.',
          }, 409);
        }
        sofaRevertPlans.push(...plan.updates);
      }
    }
    /* Promo one-way (PWP-7615UAWC): a build that is still a REWARD must
       never mint trigger vouchers of its own — free funding free, forever. */
    pwpNewlyTriggered = (rewardCtx && rewardComboMatch) ? [] : pwpRules.filter(ruleTriggeredByNewBuild);
  }
  const baseRow = {
    doc_no: docNo,
    line_date: prev.line_date ?? todayMyt(),
    debtor_code: prev.debtor_code,
    debtor_name: prev.debtor_name,
    agent: prev.agent,
    item_group: 'sofa',
    uom: 'UNIT',
    qty,
    venue: prev.venue,
    branding: prev.branding,
    line_delivery_date: prev.line_delivery_date,
    line_delivery_date_overridden: Boolean(prev.line_delivery_date_overridden ?? false),
    warehouse_id: prev.warehouse_id,
    stock_status: 'PENDING',
    remark: (newVariants.remark as string | undefined) ?? null,
  };
  let rows: Array<Record<string, unknown>>;
  if (split && split.length > 0) {
    const { cells: _cells, ...sharedVariants } = persistVariants;
    // Spread across the modules - see the create path. On module 0 the row goes
    // NEGATIVE and downstream Math.max(0, ...) then deletes the discount.
    const moduleDiscounts = distributeBuildDiscount(discount, qty, split.map((s) => Number(s.unitPriceSen) || 0));
    rows = split.map((s, i) => {
      const moduleVariants: Record<string, unknown> = {
        ...sharedVariants, buildKey: newBuildKey, cellIndex: s.cellIndex, x: s.x, y: s.y, rot: s.rot,
      };
      const moduleLineTotal = (qty * s.unitPriceSen) - (moduleDiscounts[i] ?? 0);
      const moduleLineCost = qty * s.unitCostSen;
      return {
        ...baseRow,
        item_code: s.itemCode,
        description: s.description,
        description2: buildVariantSummary('sofa', moduleVariants) || null,
        unit_price_sen: s.unitPriceSen,
        discount_sen: moduleDiscounts[i] ?? 0,
        total_sen: moduleLineTotal,
        total_inc_sen: moduleLineTotal,
        balance_sen: moduleLineTotal,
        variants: moduleVariants,
        unit_cost_sen: s.unitCostSen,
        line_cost_sen: moduleLineCost,
        line_margin_sen: moduleLineTotal - moduleLineCost,
        divan_price_sen: i === 0 ? recomputed.breakdown.divanSurchargeSen : 0,
        leg_price_sen: i === 0 ? recomputed.breakdown.legSurchargeSen : 0,
        special_order_price_sen: i === 0 ? recomputed.breakdown.specialsSurchargeSen : 0,
        custom_specials: i === 0 ? (recomputed.custom_specials ?? null) : null,
      };
    });
  } else {
    /* Unknown base model — keep the legacy single-line shape (cells inline). */
    const lineTotal = (qty * unit) - discount;
    rows = [{
      ...baseRow,
      item_code: newCode,
      description: String(item.description ?? newCode),
      description2: buildVariantSummary('sofa', persistVariants) || null,
      unit_price_sen: unit,
      discount_sen: discount,
      total_sen: lineTotal,
      total_inc_sen: lineTotal,
      balance_sen: lineTotal,
      variants: persistVariants,
      unit_cost_sen: unitCost,
      line_cost_sen: unitCost * qty,
      line_margin_sen: lineTotal - (unitCost * qty),
      divan_price_sen: recomputed.breakdown.divanSurchargeSen,
      leg_price_sen: recomputed.breakdown.legSurchargeSen,
      special_order_price_sen: recomputed.breakdown.specialsSurchargeSen,
      custom_specials: recomputed.custom_specials ?? null,
    }];
  }

  /* 0165 — the replacement build INHERITS the old build's position: new rows
     number from the old set's lowest line_no (un-numbered docs stay NULL).
     A different module count can overlap following numbers — ordering-only,
     and the read-side rank/walk re-derive keeps the rules intact. */
  {
    const oldNos = oldLines
      .map((l) => l.line_no)
      .filter((n): n is number => typeof n === 'number');
    if (oldNos.length > 0) {
      const base = Math.min(...oldNos);
      rows = rows.map((r, i) => ({ ...r, line_no: base + i }));
    }
  }

  /* Freeze the downstream SO-line links BEFORE the delete below. Three tables
     reference mfg_sales_order_items.id with ON DELETE SET NULL — the PO line
     (which is what the drop-ship guard resolves an incoming batch through), the
     DO line and the SI line. This exchange is a delete-and-REINSERT, not a
     removal, so letting the FK null them loses the SO<->PO binding on exactly
     the product family where it is load-bearing. See so-line-relink.ts. */
  const oldIds = oldLines.map((l) => l.id);
  const soLinkSnapshot = await snapshotSoLineLinks(sb, oldIds);

  /* Insert the NEW set first, then remove the OLD — an insert failure leaves
     the order untouched; a delete failure rolls the inserts back. */
  const { data: inserted, error: insErr } = await sb.from('mfg_sales_order_items')
    .insert(stampCompany(rows, c)).select('id, item_code, line_no');
  if (insErr) return c.json({ error: 'insert_failed', reason: insErr.message }, 500);
  const { error: delErr } = await sb.from('mfg_sales_order_items').delete().in('id', oldIds);
  if (delErr) {
    const newIds = ((inserted ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (newIds.length > 0) await sb.from('mfg_sales_order_items').delete().in('id', newIds);
    return c.json({ error: 'swap_failed', reason: delErr.message }, 500);
  }

  /* Carry the frozen links onto the replacement lines, matched by SKU. A module
     SKU with no counterpart in the new build is NOT re-pointed — that link is
     genuinely gone and is reported instead of quietly invented. */
  const soLinkResult = await (async () => {
    if (soLinkSnapshot.length === 0) return { restored: 0, dropped: 0 };
    const plan = planSoLineRelink(
      oldLines.map((l) => ({ id: l.id, itemCode: l.item_code, lineNo: l.line_no ?? null })),
      ((inserted ?? []) as Array<{ id: string; item_code: string | null; line_no: number | null }>)
        .map((r) => ({ id: r.id, itemCode: r.item_code, lineNo: r.line_no })),
      soLinkSnapshot,
    );
    if (plan.dropped.length > 0) {
      // eslint-disable-next-line no-console
      console.warn('[tbc-swap-sofa] SO line links dropped (no replacement carries the SKU)', {
        docNo, dropped: plan.dropped,
      });
    }
    return applySoLineRelink(sb, plan, (error, label) => throwAtomicCommandWrite(sb, error, label));
  })();

  /* Old build photos are external R2 side effects. Defer until AFTER the DB
     transaction commits; deleting them here would make rollback lose files. */
  if (c.env.SO_ITEM_PHOTOS) {
    const oldPhotoKeys = oldLines.flatMap((line) => line.photo_urls ?? []);
    deferScmAfterCommit(c, async () => {
      for (const key of oldPhotoKeys) {
        try { await c.env.SO_ITEM_PHOTOS.delete(key); }
        catch (e) { console.warn('[tbc-swap-sofa] photo cleanup failed for', key, e); } // eslint-disable-line no-console
      }
    });
  }

  /* ── PWP mutations (classified above, applied after the build landed) ── */
  const pwpMintedCodes: string[] = [];
  let pwpVoucherReleased: string | null = null;
  /* Sofa-reward builds stranded by this exchange revert via the
     pre-computed whole-build plan. */
  for (const u of sofaRevertPlans) {
    const { id: uid, ...cols } = u;
    const { error } = await sb.from('mfg_sales_order_items').update({
      ...cols,
      total_inc_sen: cols.total_sen,
      balance_sen: cols.total_sen,
    }).eq('id', uid);
    throwAtomicCommandWrite(sb, error, `TBC sofa reward revert failed for ${uid}`);
    if (error) console.error('[tbc-swap-sofa] sofa reward revert failed for', uid, error.message); // eslint-disable-line no-console
  }
  /* HAZARD 2 (mig 0188 re-keyed pwp_codes on (company_id, code)) — hoisted to
     the whole voucher settlement, not just the RELEASE below. Everything in
     this function that touches a voucher by `code` (release, re-point, restamp,
     DELETE) needs both halves; four of them were carrying one, sixty lines
     under the two that were correct. */
  const rewardCompanyId = activeCompanyId(c);
  if (rewardCompanyId == null) throw new Error('TBC sofa voucher write refused: company unresolved');
  if (rewardCtx) {
    // HAZARD 2 again: these RELEASE a voucher — unfiltered hands theirs back to stock.
    if (rewardComboMatch) {
      const { error } = await sb.from('pwp_codes')
        .update({ redeemed_item_code: newLeadCode, updated_at: new Date().toISOString() })
        .eq('code', rewardCtx.code).eq('company_id', rewardCompanyId);
      throwAtomicCommandWrite(sb, error, 'TBC sofa reward code re-point failed');
      if (error) console.error('[tbc-swap-sofa] reward code re-point failed:', error.message); // eslint-disable-line no-console
    } else {
      const { error } = await sb.from('pwp_codes')
        .update({ status: 'AVAILABLE', redeemed_doc_no: null, redeemed_item_code: null, updated_at: new Date().toISOString() })
        .eq('code', rewardCtx.code).eq('company_id', rewardCompanyId);
      throwAtomicCommandWrite(sb, error, 'TBC sofa reward code release failed');
      if (error) console.error('[tbc-swap-sofa] reward code release failed:', error.message); // eslint-disable-line no-console
      else pwpVoucherReleased = rewardCtx.code;
    }
  }
  {
    // 1. Surviving vouchers re-point at the new lead SKU.
    if (pwpKeepCodes.length > 0) {
      const { error } = await sb.from('pwp_codes')
        .update({ trigger_item_code: newLeadCode, updated_at: new Date().toISOString() })
        .in('code', pwpKeepCodes).eq('company_id', rewardCompanyId);
      throwAtomicCommandWrite(sb, error, 'TBC sofa keep-code restamp failed');
      if (error) console.error('[tbc-swap-sofa] keep-code restamp failed:', error.message); // eslint-disable-line no-console
    }
    // 2. Rewards whose trigger is gone revert to their normal price (the PWP
    //    base is replaced by the catalog-authoritative figure; picks and their
    //    surcharges survive). clientUnit 0 → the recompute FILLS the
    //    authoritative price without a drift reject.
    for (const line of rewardLinesToRevert) {
      const v: Record<string, unknown> = { ...((line.variants ?? {}) as Record<string, unknown>) };
      delete v.pwp; delete v.pwpCode; delete v.pwpTriggerLabel;
      const [rp, rfab, rtiers] = await Promise.all([
        loadProductByCode(sb, line.item_code, activeCompanyId(c)),
        loadFabricByCode(sb, (v.fabricCode as string | undefined) ?? null),
        loadFabricSellingTiers(sb, (v.fabricId as string | undefined) ?? null),
      ]);
      const rec = recomputeFromSnapshot(
        { itemCode: line.item_code, itemGroup: String(line.item_group ?? 'others'), qty: Number(line.qty), unitPriceSen: 0, variants: v as MfgItemForRecompute['variants'] },
        rp, rfab, cfg, null, null, rtiers, fabricAddonCfg, null, null, specialDefs, null, modelOverridesSwap, compartmentOverridesSwap,
      );
      const revertUnit = rec.unit_price_sen > 0 ? rec.unit_price_sen : Number(line.unit_price_sen);
      const lqty = Number(line.qty);
      const ldisc = Number(line.discount_sen ?? 0);
      const lTotal = (lqty * revertUnit) - ldisc;
      const lCost = Number(line.unit_cost_sen ?? 0);
      const { error } = await sb.from('mfg_sales_order_items').update({
        variants: v,
        description2: buildVariantSummary(String(line.item_group ?? ''), v) || null,
        unit_price_sen: revertUnit,
        total_sen: lTotal,
        total_inc_sen: lTotal,
        balance_sen: lTotal,
        line_margin_sen: lTotal - (lCost * lqty),
        divan_price_sen: rec.breakdown.divanSurchargeSen,
        leg_price_sen: rec.breakdown.legSurchargeSen,
        special_order_price_sen: rec.breakdown.specialsSurchargeSen,
        custom_specials: rec.custom_specials ?? null,
      }).eq('id', line.id);
      throwAtomicCommandWrite(sb, error, `TBC sofa reward revert failed for ${line.id}`);
      if (error) console.error('[tbc-swap-sofa] reward revert failed for', line.id, error.message); // eslint-disable-line no-console
    }
    // 3. Dead vouchers go (un-redeemed + the reverted ones — Loo: delete).
    const toDelete = [...pwpDeleteCodes, ...pwpRevertCodes];
    if (toDelete.length > 0) {
      const { error } = await sb.from('pwp_codes').delete()
        .in('code', toDelete).eq('company_id', rewardCompanyId);
      throwAtomicCommandWrite(sb, error, 'TBC sofa code delete failed');
      if (error) console.error('[tbc-swap-sofa] code delete failed:', error.message); // eslint-disable-line no-console
    }
    // 4. Newly-triggered rules mint fresh vouchers (AVAILABLE, customer-bound,
    //    printed on the SO) — topped up against the surviving codes per rule.
    if (pwpNewlyTriggered.length > 0) {
      const { data: hdr } = await sb.from('mfg_sales_orders').select('customer_id').eq('doc_no', docNo).maybeSingle();
      const customerId = ((hdr as { customer_id?: string | null } | null)?.customer_id) ?? null;
      /* Minting provenance — resolved once outside the loops; see the non-sofa
         swap above for why this must not be the bridge's pinned system uuid. */
      const mintOwnerStaffId = await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id);
      const { data: keptRows } = pwpKeepCodes.length > 0
        ? await sb.from('pwp_codes').select('code, rule_id')
            .in('code', pwpKeepCodes).eq('company_id', rewardCompanyId)
        : { data: [] };
      const keptByRule = new Map<string, number>();
      for (const k of ((keptRows ?? []) as Array<{ rule_id: string | null }>)) {
        if (k.rule_id) keptByRule.set(k.rule_id, (keptByRule.get(k.rule_id) ?? 0) + 1);
      }
      for (const r of pwpNewlyTriggered) {
        const target = Math.max(0, Math.floor((Number(r.qty_per_trigger) || 1) * qty));
        const have = keptByRule.get(r.id) ?? 0;
        for (let i = have; i < target; i++) {
          for (let attempt = 0; attempt < 5; attempt++) {
            const code = genCode();
            const { error } = await sb.from('pwp_codes').insert({
              company_id: activeCompanyId(c), // multi-company: match the SO's company
              code,
              rule_id: r.id,
              reward_category: r.reward_category,
              eligible_reward_model_ids: r.eligible_reward_model_ids ?? [],
              reward_combo_ids: r.reward_combo_ids ?? [],
              reward_size_codes: r.reward_size_codes ?? [],
              reward_compartments: r.reward_compartments ?? [],
              type: r.type ?? 'pwp',
              status: 'AVAILABLE',
              owner_staff_id: mintOwnerStaffId,
              cart_line_key: null,
              trigger_item_code: newLeadCode,
              source_doc_no: docNo,
              customer_id: customerId,
            });
            if (!error) { pwpMintedCodes.push(code); break; }
            if (attempt === 4) {
              throwAtomicCommandWrite(sb, error, 'TBC sofa voucher mint failed');
              console.error('[tbc-swap-sofa] voucher mint failed:', error.message); // eslint-disable-line no-console
            }
          }
        }
      }
    }
  }

  // Default Free Gift (0170) — runs AFTER the sofa PWP re-evaluation above, in
  // place of the final recomputeTotals: a sofa build swap can newly match (or
  // stop matching) a gifting combo, so reconcile syncs the accessory gift lines
  // and then recomputes header totals.
  await reconcileFreeGiftLinesForSo(sb, docNo, c);
  // Re-derive the delivery fee — a sofa build swap can flip a cross-category mix
  // or a special-delivery trigger (model/combo/compartment). Source kept.
  await rederiveDeliveryFee(sb, docNo, c);
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', from: prev.item_code, to: split?.[0]?.itemCode ?? newCode },
      { field: 'sofaBuild', from: `${oldLines.length} lines`, to: `${rows.length} lines` },
      { field: 'totalSen', from: oldBuildTotal, to: newBuildTotal },
      ...(pwpRevertCodes.length > 0
        ? [{ field: 'pwpRewardsReverted', to: pwpRevertCodes.join(', ') } satisfies FieldChange] : []),
      ...(pwpDeleteCodes.length > 0
        ? [{ field: 'pwpCodesDeleted', to: pwpDeleteCodes.join(', ') } satisfies FieldChange] : []),
      ...(pwpMintedCodes.length > 0
        ? [{ field: 'pwpCodesMinted', to: pwpMintedCodes.join(', ') } satisfies FieldChange] : []),
      ...(rewardCtx && rewardComboMatch
        ? [{ field: 'pwpRewardKept', to: rewardCtx.code } satisfies FieldChange] : []),
      ...(pwpVoucherReleased
        ? [{ field: 'pwpVoucherReleased', to: pwpVoucherReleased } satisfies FieldChange] : []),
      /* Say out loud what happened to the SO<->PO/DO/SI links: silence here is
         what let the 2026-07-29 incident look like a routine exchange. */
      ...(soLinkResult.restored > 0
        ? [{ field: 'sourceLinksCarried', to: String(soLinkResult.restored) } satisfies FieldChange] : []),
      ...(soLinkResult.dropped > 0
        ? [{ field: 'sourceLinksDropped', to: String(soLinkResult.dropped) } satisfies FieldChange] : []),
    ],
  });
  await scheduleStockAllocationAfterCommand(c, sb, `tbc-swap-sofa:${docNo}`);

  return c.json({
    ok: true,
    totalSen: newBuildTotal,
    lines: rows.length,
    soLinks: soLinkResult,
    pwp: {
      kept: pwpKeepCodes.length,
      reverted: pwpRevertCodes.length,
      deleted: pwpDeleteCodes.length,
      minted: pwpMintedCodes,
      rewardKept: rewardCtx && rewardComboMatch ? rewardCtx.code : null,
      rewardReleased: pwpVoucherReleased,
    },
  });
}
mfgSalesOrders.post('/:docNo/items/:itemId/tbc-swap-sofa', async (c) => {
  const company = requireActiveCompanyId(c);
  if (!company.ok) return c.json(company.refusal, 409);
  return queueAcSoEditAfter(c, c.req.param('docNo'), await runScmPgCommand(c, (sb) => tbcSwapSofaCommandHandler(c, sb), {
    docNo: c.req.param('docNo'),
    leaseToken: c.req.header('X-SO-Edit-Lease')?.trim() ?? null, userId: soCallerUserId(c),
    companyId: company.companyId,
  }));
});

// ── Per-line photos — PR-F (migration 0076) ──────────────────────────
//
// Commander 2026-05-27: customisation orders attach photos per line
// (color swatches, sketches, customer-supplied refs). HOOKKA's
// AutoCount-style detail view shows a "Photo" column on each line; we
// mirror that with an R2-backed photo array on every SO item.
//
// Storage: keys live in mfg_sales_order_items.photo_urls (text[]),
// objects live in the SO_ITEM_PHOTOS R2 bucket (private). The proxy
// GET endpoint streams bytes back so the bucket itself never needs
// public access. A custom domain (e.g. r2.2990s.com) can replace the
// proxy later — until then this is the only read path.
//
// Key layout: so-items/<docNo>/<itemId>/<uuid>.<ext>
//   The docNo + itemId prefix keeps the bucket browseable by SO and
//   makes lifecycle policies (delete-on-cancel) straightforward.

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

const extFromMime = (mime: string): string => {
  // Conservative whitelist — image/* only. Fallback to 'bin' if a
  // browser-supplied subtype isn't recognised; the bucket-key suffix
  // is cosmetic (Content-Type stored as R2 metadata).
  const m = mime.toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png')                       return 'png';
  if (m === 'image/webp')                      return 'webp';
  if (m === 'image/gif')                       return 'gif';
  if (m === 'image/heic')                      return 'heic';
  if (m === 'image/heif')                      return 'heif';
  if (m === 'image/avif')                      return 'avif';
  if (m.startsWith('image/'))                  return 'bin';
  return '';
};

mfgSalesOrders.post('/:docNo/items/:itemId/photos', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const user = c.get('user');
  // Audit 2026-06-20 — self-scoped sales may only touch their OWN SO (mirror the line/header guards).
  // AUTHZ BEFORE CONCURRENCY (2026-07-22): this gate now runs BEFORE the edit
  // lease. A caller who may not touch this order at all was previously told
  // "This order is being saved on another screen — wait a moment and try Save
  // again", i.e. a permission refusal wearing a conflict's clothes, which
  // invites an endless retry and never surfaces the real reason.
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  // Verify the line exists + belongs to this SO. Cheaper to fail here than after a multi-MB upload to R2.
  const { data: item, error: itemErr } = await sb
    .from('mfg_sales_order_items')
    .select('id, doc_no, item_code, photo_urls')
    .eq('id', itemId)
    .maybeSingle();
  if (itemErr) return c.json({ error: 'item_lookup_failed', reason: itemErr.message }, 500);
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { id: string; doc_no: string; item_code: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);

  // Parse multipart body via Hono's c.req.parseBody(). The slip route
  // uses presigned URLs (out-of-band PUT) — this route is the
  // simpler proxy path because per-item photo files are small (<10 MB)
  // and commander wants drag-drop straight from the line card without
  // a two-step handshake.
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch (e) {
    return c.json({ error: 'invalid_multipart', reason: e instanceof Error ? e.message : String(e) }, 400);
  }
  const file = form.file as File | undefined;
  if (!file || typeof file === 'string') return c.json({ error: 'file_field_required' }, 400);

  if (!file.type || !file.type.toLowerCase().startsWith('image/')) {
    return c.json({ error: 'invalid_mime', got: file.type || '(none)' }, 400);
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return c.json({ error: 'file_too_large', maxBytes: MAX_PHOTO_BYTES, got: file.size }, 400);
  }

  const photoId = crypto.randomUUID();
  const ext = extFromMime(file.type) || 'bin';
  const photoKey = `so-items/${docNo}/${itemId}/${photoId}.${ext}`;

  try {
    await c.env.SO_ITEM_PHOTOS.put(photoKey, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        docNo,
        itemId,
        itemCode: i.item_code,
        uploadedBy: user.id,
      },
    });
  } catch (e) {
    return c.json({ error: 'r2_put_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  // WO-7: optional client-generated thumbnail in the same multipart body,
  // stored at `<photoKey>.thumb`. Best-effort; absent for old clients.
  await putOptionalThumb(c.env.SO_ITEM_PHOTOS, form.thumb, photoKey, {
    docNo,
    itemId,
    uploadedBy: user.id,
  });

  // Append the new key to photo_urls. Pulled-then-pushed (rather than
  // a Postgres array_append RPC) so the call stays inside the standard
  // Supabase REST surface — supabase-js doesn't expose array operators.
  const nextKeys = [...(i.photo_urls ?? []), photoKey];
  const { error: updErr } = await sb
    .from('mfg_sales_order_items')
    .update({ photo_urls: nextKeys })
    .eq('id', itemId);
  if (updErr) {
    // Rollback the R2 objects so we don't leak dangling blobs.
    await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
    await deleteThumbFor(c.env.SO_ITEM_PHOTOS, photoKey);
    return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);
  }

  // PR-D — emit an ADD_LINE-style audit row noting the photo addition.
  // Reuses UPDATE_LINE so the History panel groups it with other line
  // edits; itemCode prefix gives the timeline a human label.
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: i.item_code },
      { field: 'photoAdded', to: photoKey },
    ],
  });

  // Task #92 — return a short-lived signed GET URL alongside the key.
  // Frontend uses this directly as <img src> (no Worker proxy roundtrip
  // on first render). When the URL expires the frontend re-fetches via
  // GET /photos/:photoKey/signed. Falling back to the legacy proxy path
  // here keeps existing callers (and stale clients) working until a
  // post-deploy cleanup removes the proxy entirely.
  try {
    const bindings = soItemPhotoBindings(c.env);
    const { signedUrl, expiresAt } = await signSoItemPhotoUrl(bindings, photoKey);
    // WO-7: thumbUrl is signed for the `.thumb` sibling. When no thumb was
    // uploaded the URL 404s on fetch and the frontend falls back to photoUrl.
    const { signedUrl: thumbUrl } = await signSoItemPhotoUrl(bindings, thumbKeyFor(photoKey));
    return c.json({ photoKey, mode: 'signed', photoUrl: signedUrl, thumbUrl, expiresAt }, 201);
  } catch (e) {
    /* Signing failed — the upload itself succeeded and the row is already
       inserted, so never lose it. Hand back the proxy path.

       2026-08-10: this fallback existed but was INERT. It returns `photoUrl` as
       an API-client-relative path, and the caller only cached the value when it
       `startsWith('http')` — which a relative path never does. So nothing was
       cached, the tile re-fetched /signed, got the 500, and showed "err".
       `mode` is emitted so the client can branch on the contract instead of
       sniffing the string shape. */
    const basePath = `/mfg-sales-orders/${docNo}/items/${itemId}`;
    const reason = e instanceof Error ? e.message : String(e);
    warnSigningFailedOnce('so-item-photo', reason);
    return c.json(
      {
        photoKey,
        mode: 'proxy',
        photoUrl: photoProxyPath(basePath, photoKey),
        thumbProxyPath: photoProxyPath(basePath, thumbKeyFor(photoKey)),
        expiresAt: null,
        reason,
      },
      201,
    );
  }
});

// Task #92 — refresh a signed GET URL for an existing key. Frontend
// hits this on mount when no cached URL exists for a key, and on a
// 403 (URL expired). Auth-checked the same way as the proxy: the key
// must belong to this SO+item and currently be in photo_urls.
export const soItemPhotoSignedHandler = async (c: any) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));

  const { data: item } = await sb
    .from('mfg_sales_order_items')
    .select('doc_no, photo_urls')
    .eq('id', itemId)
    .maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { doc_no: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  if (!(i.photo_urls ?? []).includes(photoKey)) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  try {
    const bindings = soItemPhotoBindings(c.env);
    const { signedUrl, expiresAt } = await signSoItemPhotoUrl(bindings, photoKey);
    // WO-7: signed thumb sibling. Pre-existing photos have no thumb object —
    // the frontend's <img> onError falls back to signedUrl on the 404.
    const { signedUrl: thumbUrl } = await signSoItemPhotoUrl(bindings, thumbKeyFor(photoKey));
    const payload: PhotoUrlPayload = { mode: 'signed', signedUrl, thumbUrl, expiresAt };
    return c.json(payload);
  } catch (e) {
    /* 2026-08-10: the R2 S3 creds are unset in prod, so signing throws for
       EVERY photo and this used to answer 500 — the line card rendered "err"
       even though the bytes are readable through the proxy below via the R2
       binding. Serve the proxy path instead of failing. See
       scm/lib/photoProxyFallback.ts for why this is NOT returned as
       `signedUrl` (an <img src> sends no bearer token, so it would 401). */
    return c.json(
      proxyFallbackPayload(
        'so-item-photo',
        `/mfg-sales-orders/${docNo}/items/${itemId}`,
        photoKey,
        e,
      ),
    );
  }
};

mfgSalesOrders.get('/:docNo/items/:itemId/photos/:photoKey/signed', soItemPhotoSignedHandler);

/**
 * NOT deprecated — load-bearing. (It was marked `@deprecated Task #92` with a
 * "remove after ~7 day cooldown" note when the signed-URL flow landed.)
 *
 * 2026-08-10: the R2 S3 credentials that `/photos/:photoKey/signed` needs were
 * never provisioned in production, so signing throws for every photo and the
 * signed route now FALLS BACK to this endpoint. It reads the R2 *binding*
 * (c.env.SO_ITEM_PHOTOS), which needs no credential, and is the only reason SO
 * photos display at all today. Deleting it would blank every photo in the app.
 *
 * It may be retired only once signing is proven working in production AND the
 * fallback in soItemPhotoSignedHandler is removed with it.
 */
mfgSalesOrders.get('/:docNo/items/:itemId/photos/:photoKey', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));

  /* The `i.doc_no !== docNo` check below compares two CALLER-supplied values, so
     it proves nothing about whose SO this is. Run the same shared guard the
     sibling /:docNo routes use, or a guessed item uuid serves another company's
     product photos out of R2. */
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  // Authorise: the photo key must belong to this SO+item AND be
  // currently listed in photo_urls. Prevents enumeration of unrelated
  // objects via a guessed key. WO-7: a `.thumb` sibling is authorised
  // against its BASE key — thumbs are never listed in photo_urls.
  const { data: item } = await sb
    .from('mfg_sales_order_items')
    .select('doc_no, photo_urls')
    .eq('id', itemId)
    .maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { doc_no: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  if (!(i.photo_urls ?? []).includes(baseKeyOf(photoKey))) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  const obj = await c.env.SO_ITEM_PHOTOS.get(photoKey);
  if (!obj) return c.json({ error: 'photo_not_found_in_r2' }, 404);

  const contentType =
    obj.httpMetadata?.contentType ?? 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type': contentType,
      // Photos are immutable per key — `so-items/<docNo>/<itemId>/<uuid>.<ext>`
      // via crypto.randomUUID() (:9793) — so a replaced photo is a different
      // url. Stays `private` (SO item photos are not public), but the age is
      // now what the key identity actually supports.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
});

mfgSalesOrders.delete('/:docNo/items/:itemId/photos/:photoKey', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));
  const user = c.get('user');
  // Audit 2026-06-20 — self-scoped sales may only touch their OWN SO (mirror the line/header guards).
  // AUTHZ BEFORE CONCURRENCY (2026-07-22): this gate now runs BEFORE the edit
  // lease. A caller who may not touch this order at all was previously told
  // "This order is being saved on another screen — wait a moment and try Save
  // again", i.e. a permission refusal wearing a conflict's clothes, which
  // invites an endless retry and never surfaces the real reason.
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  const { data: item } = await sb
    .from('mfg_sales_order_items')
    .select('doc_no, item_code, photo_urls')
    .eq('id', itemId)
    .maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { doc_no: string; item_code: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  const existing = i.photo_urls ?? [];
  if (!existing.includes(photoKey)) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  const nextKeys = existing.filter((k) => k !== photoKey);
  const { error: updErr } = await sb
    .from('mfg_sales_order_items')
    .update({ photo_urls: nextKeys })
    .eq('id', itemId);
  if (updErr) return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);

  // R2 delete best-effort — if it fails we've already removed the key
  // from the array, so the orphan is invisible to the UI. A future
  // reaper job could sweep for dangling objects.
  await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
  await deleteThumbFor(c.env.SO_ITEM_PHOTOS, photoKey);

  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: i.item_code },
      { field: 'photoRemoved', from: photoKey, to: null },
    ],
  });

  return c.json({ ok: true });
});

// ── Payments — PR #163 (migration 0073) ───────────────────────────────
//
// HOOKKA-style transaction ledger per SO. Each row is one receipt /
// auth slip. UI lists them, sums into a "Deposit Paid" total, and the
// balance computes from header.local_total_sen − sum(amount_sen).
//
// Legacy single-row payment fields on mfg_sales_orders (payment_method,
mfgSalesOrders.get('/:docNo/payments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb
    .from('mfg_sales_order_payments')
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .eq('so_doc_no', docNo), c)
    .order('paid_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  // Flatten the joined `staff.name` onto `collected_by_name` so the UI
  // doesn't need to drill into a nested object.
  const payments = (data ?? []).map((r: unknown) => {
    const row = r as Record<string, unknown> & { staff: { name: string } | null };
    const { staff, ...rest } = row;
    return { ...rest, collected_by_name: staff?.name ?? null };
  });
  return c.json({ payments });
});

/* Task #122 (cascade) — Method is a 3-step pick now. merchantProvider was
   a fixed 4-bank enum and installmentMonths was 6|12 only; both widened.
   Banks are now an open-ended text field sourced from
   so_dropdown_options('payment_merchant'). Installment plans likewise come
   from so_dropdown_options('installment_plan') and are sent here as an
   integer 0..60 (0 = "One-off", which we coerce to NULL below). A new
   onlineType field carries the Online sub-type (Bank Transfer / TNG /
   Cheque / DuitNow). */
const paymentCreateSchema = z.object({
  paidAt:             z.string().min(1),
  /* 2026-06-06 payment-method unify — 'installment' joins the manual route.
     It was already a first-class method on the POS deposit path (SO create
     writes method='installment' raw); now Finance can record installment
     receipts directly too. The enum IS PAYMENT_METHOD_CODES now, imported
     from scm/shared/payment-methods.ts — "kept in sync with" was a promise
     seven route files had to keep by hand, pointing at a packages/shared/
     path that no longer exists in this repo. */
  method:             z.enum(PAYMENT_METHOD_CODES),
  merchantProvider:   z.string().trim().min(1).optional().nullable(),
  installmentMonths:  z.number().int().min(0).max(60).optional().nullable(),
  onlineType:         z.string().trim().min(1).optional().nullable(),
  approvalCode:       z.string().optional().nullable(),
  amountSen:        z.number().int().nonnegative(),
  accountSheet:       z.string().optional().nullable(),
  collectedBy:        z.string().uuid().optional().nullable(),
  note:               z.string().optional().nullable(),
  /* Owner 2026-07-13 — a payment slip is NOT always available (cash / walk-in
     receipts), so the slip is OPTIONAL. When the client DID upload one it still
     sends the session id and the row links it; when absent the payment records
     slip-less (slip_key NULL, same as a scan-job first receipt). Previously
     `.min(1)` (required). */
  uploadSessionId:    z.string().min(1).optional().nullable(),
});

mfgSalesOrders.post('/:docNo/payments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  // Audit 2026-06-20 — self-scoped sales may only touch their OWN SO (mirror the line/header guards).
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  // Ensure the SO exists before inserting a child row (gives a cleaner 404 than a deferred FK violation).
  const { data: so } = await sb.from('mfg_sales_orders').select('doc_no').eq('doc_no', docNo).maybeSingle();
  if (!so) return c.json({ error: 'sales_order_not_found' }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  /* FIX 3 (2026-07-16) — method ⇒ bank/account mapping, enforced server-side.
     The desktop New-SO / Payments cascade blocks saving a Merchant payment with
     no Bank or an Online (transfer) payment with no Sub-Type
     (missingMethodSubField in PaymentsTable.tsx), but mobile / API POST straight
     to this route and paymentCreateSchema left every sub-field optional. Mirror
     the desktop rule for the SERVER-observable part: an amount-bearing Merchant
     needs a Bank (merchantProvider); an Online/transfer needs a Sub-Type
     (onlineType); Cash and legacy Installment need nothing. NOTE: the desktop also
     makes a Merchant pick a Plan, but "One-off" serialises to installmentMonths
     null — indistinguishable from unset — so requiring it here would reject a
     legitimate one-shot card payment; the Plan is deliberately NOT gated. Slip
     stays optional (owner 2026-07-13). Only amount > 0 rows are checked, matching
     the desktop guard (a zeroed row carries no method commitment). */
  if (p.amountSen > 0) {
    let missing: string | null = null;
    let methodName = '';
    if (p.method === 'merchant' && !p.merchantProvider?.trim()) { missing = 'bank'; methodName = 'card / merchant'; }
    else if (p.method === 'transfer' && !p.onlineType?.trim()) { missing = 'sub-type'; methodName = 'bank transfer / online'; }
    if (missing) {
      return c.json({
        error: 'payment_method_field_required',
        reason: `A ${methodName} payment needs a ${missing} before it can be recorded.`,
      }, 400);
    }
  }

  /* OVER-COLLECTION IS ALLOWED (owner 2026-08-16). Spec D6's guard used to
     refuse Σ(ledger) + this payment > total_revenue_sen. It is deleted, not
     relaxed, and the two reads it needed went with it.

     WHAT THE GUARD ACTUALLY COST. It never stopped an over-collection; it
     redirected one. Refused at the till, the operator's only way to bank cash
     already in hand was to go back and re-price the ORDER until the total
     covered it — which is what happened to HC-SO-2608-002 on 2026-08-16:
     UPDATE_LINE at 08:26:22 put RM 250 of "Right Drawer" special onto a
     JAGER-(K) line (unitPriceSen 0 → 25000), and the RM 2,250 payment landed
     76 seconds later at 08:27:38, accepted because the total was now exactly
     425000. The receipt balanced and the customer's order silently grew a
     drawer he never bought. Refusing money the business is holding does not
     make the books truer, it makes the ITEMS lie — and an item is what gets
     manufactured and delivered.

     So the excess is simply recorded, and the balance goes negative (red on
     the screen: soBalanceSen). Nothing here touches lines, prices or the
     order total — a payment is a payment. */

  /* Owner 2026-07-13 — the slip is OPTIONAL here, and since 2026-08-13 it is
     optional on EVERY SO path, so this route is no longer the loose end of a
     stricter create. Only when the client attached one (uploadSessionId
     present) do we resolve the upload session → committed R2 key; an
     unresolved / not-yet-uploaded session is still rejected so a dangling id
     never books a payment whose proof points nowhere. Absent session →
     paymentSlipKey stays null (records slip-less). */
  let paymentSlipKey: string | null = null;
  if (p.uploadSessionId) {
    const { data: slipRow, error: slipErr } = await sb
      .from('pending_slip_uploads')
      .select('r2_key, status')
      .eq('upload_session_id', p.uploadSessionId)
      .maybeSingle();
    if (slipErr) return c.json({ error: 'lookup_failed', reason: slipErr.message }, 500);
    const slipRowT = slipRow as { r2_key: string | null; status: string } | null;
    if (!slipRowT || slipRowT.status !== 'uploaded' || !slipRowT.r2_key) {
      /* Names the CLAIM, not a requirement — the payment saves fine with no
         slip; what it cannot do is carry one that never finished uploading. */
      return c.json({
        error: 'slip_required',
        reason: "That payment slip hasn't finished uploading. Attach it again, or save the payment without one.",
      }, 400);
    }
    paymentSlipKey = slipRowT.r2_key;
  }

  /* Insert + ADD_PAYMENT audit — the factored recordSoPaymentRow core (shared
     with the background scan job). Same derivation, same insert, same audit
     shape as the pre-factoring inline code. */
  const { payment, errorMessage } = await recordSoPaymentRow(sb, {
    docNo,
    paidAt:            p.paidAt,
    method:            p.method,
    merchantProvider:  p.merchantProvider,
    installmentMonths: p.installmentMonths,
    onlineType:        p.onlineType,
    approvalCode:      p.approvalCode,
    amountSen:       p.amountSen,
    accountSheet:      p.accountSheet,
    slipKey:           paymentSlipKey,
    collectedBy:       p.collectedBy,
    note:              p.note,
    createdBy:         user.id,
    actorName:         (user.user_metadata as { name?: string } | undefined)?.name ?? null,
  });
  if (errorMessage) return c.json({ error: 'insert_failed', reason: errorMessage }, 500);

  /* Promote — 'promoted' rows are excluded from the slip reaper (same dance
     as the SO-create slip). The UPDATE runs under the caller's RLS
     (pending_slip_uploads allows the UPLOADER to promote); in this flow the
     uploader IS the payment recorder, so it matches. If it ever doesn't
     (or errors), the row stays 'uploaded' → the reaper would delete the R2
     object after TTL and the same session would be replayable — so a
     no-op promote is logged LOUDLY instead of swallowed. Best-effort: the
     payment itself stands either way (slip_key already persisted). */
  if (p.uploadSessionId) {
    const { data: promoted, error: promoteErr } = await sb
      .from('pending_slip_uploads')
      .update({ status: 'promoted', promoted_at: new Date().toISOString() })
      .eq('upload_session_id', p.uploadSessionId)
      .select('upload_session_id');
    if (promoteErr || !promoted || promoted.length === 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[payments] slip promote FAILED for session ${p.uploadSessionId} on ${docNo}: `
        + (promoteErr?.message ?? 'no row matched (RLS uploader mismatch?)')
        + ' — slip will be reaped after TTL; replay window open until then.',
      );
    }
  }

  /* ADD_PAYMENT audit already appended inside recordSoPaymentRow. */
  return c.json({ payment }, 201);
});

/* Owner 2026-07-13 — SAME-DAY payment EDIT. A payment recorded TODAY can be
   corrected within the same Malaysia (UTC+8) calendar day; after MYT midnight it
   LOCKS (the day's cash-up is settled). Editable fields: amount, method (+ its
   method-scoped bank / plan / online sub-fields), paid date, account sheet,
   approval code, collected-by. The whole editable set is rewritten each call so
   a method change can't leave a stale sub-field behind. Paid / balance / status
   are DERIVED live from the payments ledger (the list/detail rollup + the
   payment view sum amount_sen) — exactly as the DELETE path relies on — so no
   header recompute is needed here; the amended amount flows straight through. */
const paymentPatchSchema = z.object({
  version:           z.number().int().min(1).optional(),
  paidAt:            z.string().min(1).optional(),
  method:            z.enum(PAYMENT_METHOD_CODES).optional(),
  merchantProvider:  z.string().trim().min(1).optional().nullable(),
  installmentMonths: z.number().int().min(0).max(60).optional().nullable(),
  onlineType:        z.string().trim().min(1).optional().nullable(),
  approvalCode:      z.string().optional().nullable(),
  amountSen:       z.number().int().nonnegative().optional(),
  accountSheet:      z.string().optional().nullable(),
  collectedBy:       z.string().uuid().optional().nullable(),
});

export type PaymentVersionGuard =
  | { ok: true; version: number; grace?: true }
  | { ok: false; status: 409 | 428; body: { error: string; currentVersion: number } };

/** Shared PATCH/DELETE payment CAS contract. Missing is 428, stale is 409. */
export function paymentVersionGuard(
  candidate: unknown,
  currentVersion: number,
  grace?: SoCasGraceWindow,
): PaymentVersionGuard {
  const version = Number(candidate);
  if (!Number.isInteger(version) || version < 1) {
    if (soCasGraceOpen(grace)) return { ok: true, version: currentVersion, grace: true };
    return {
      ok: false,
      status: 428,
      body: { error: 'payment_version_required', currentVersion },
    };
  }
  if (version !== currentVersion) {
    return {
      ok: false,
      status: 409,
      body: { error: 'payment_version_conflict', currentVersion },
    };
  }
  return { ok: true, version };
}

mfgSalesOrders.patch('/:docNo/payments/:id', async (c) => {
  // WRITE: the company must RESOLVE (companyScope.ts strict rule) - a payment
  // edit is a books change, so an unknown company refuses rather than widens.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
  const user = c.get('user');
  // Same self-scope gate as POST / DELETE payments.
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  // Load the row (need every method-scoped column + created_at for the lock).
  const { data: row } = await scopeToCompany(sb.from('mfg_sales_order_payments').select('*').eq('id', id), c).maybeSingle();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const before = row as {
    so_doc_no: string; created_at: string; paid_at: string;
    version: number;
    method: 'merchant' | 'transfer' | 'cash' | 'installment';
    merchant_provider: string | null; installment_months: number | null;
    online_type: string | null; approval_code: string | null;
    amount_sen: number; account_sheet: string | null; collected_by: string | null;
  };
  if (before.so_doc_no !== docNo) return c.json({ error: 'payment_doc_mismatch' }, 400);

  /* Same-day lock — a payment recorded TODAY (MYT) can be corrected; after
     midnight the day's cash-up is settled and it LOCKS. EXEMPT DRAFT SOs: a
     draft isn't confirmed/settled yet (e.g. an OCR-scanned draft whose payment
     was mis-read), so its payments must stay freely editable — mirrors the
     frontend's draftUnlocked (2026-07-13), which was never matched here.

     Owner 2026-07-19 confirmed this same window governs DELETE too, which had
     no time gate at all. Both routes now go through the shared
     paymentRowMutable() predicate rather than each spelling the rule out, so
     they cannot drift — and the deferred bank-reconciliation condition will
     have exactly one place to land. */
  const { data: soRow } = await sb
    .from('mfg_sales_orders')
    .select('status')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (typeof before.created_at !== 'string' || Number.isNaN(new Date(before.created_at).getTime())) {
    return c.json({
      error: 'payment_created_at_unreadable',
      reason: 'This payment is missing the date it was keyed in, so it cannot be edited safely. '
        + 'Please tell IT which payment this is.',
    }, 409);
  }
  const editWindow = paymentRowMutable(
    mytDateOf(before.created_at),
    todayMyt(),
    (soRow?.status as string | undefined) === 'DRAFT',
  );
  if (!editWindow.mutable) {
    return c.json({ error: PAYMENT_WINDOW_CLOSED_ERROR, reason: editWindow.problem }, 409);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const versionCheck = paymentVersionGuard(p.version, Number(before.version ?? 1), soCasGrace(c));
  if (!versionCheck.ok) return c.json(versionCheck.body, versionCheck.status);
  const expectedPaymentVersion = versionCheck.version;

  // Effective (post-edit) method + its scoped sub-fields — mirror recordSoPaymentRow.
  const nextMethod = p.method ?? before.method;
  const merchantLike = nextMethod === 'merchant' || nextMethod === 'installment';
  const rawProvider = p.merchantProvider !== undefined ? p.merchantProvider : before.merchant_provider;
  const nextMerchantProvider = merchantLike ? (rawProvider ?? null) : null;
  const rawInstallment = p.installmentMonths !== undefined ? p.installmentMonths : before.installment_months;
  const nextInstallment = merchantLike
    ? (typeof rawInstallment === 'number' && rawInstallment > 0 ? rawInstallment : null)
    : null;
  const rawOnline = p.onlineType !== undefined ? p.onlineType : before.online_type;
  const nextOnline = nextMethod === 'transfer' ? (rawOnline ?? null) : null;
  const nextAmount = p.amountSen ?? before.amount_sen;
  const nextPaidAt = p.paidAt ?? before.paid_at;
  const nextApproval = p.approvalCode !== undefined ? (p.approvalCode ?? null) : before.approval_code;
  const nextCollectedBy = p.collectedBy !== undefined ? (p.collectedBy ?? null) : before.collected_by;
  /* Account Sheet on EDIT (owner 2026-07-16, "Acc sheet 亂填?") — the sheet is
     DERIVED from the payment's own method + bank / online sub-type, and a
     hand-typed value wins. Both editors (desktop PaymentsTable.beginEditPersisted,
     mobile AddPaymentSheet) seed the STORED sheet into an editable box and send
     it back verbatim, so changing only the Bank re-sent the OLD derived sheet
     ("PBB") next to the NEW bank ("MBB") and the hand-typed-wins branch happily
     persisted a row whose Account Sheet contradicted its own Bank. Nothing was
     "randomly filled": the stale auto-derived value simply outlived the bank it
     was derived from.
     Fix here rather than in each client (single logic layer — desktop + mobile +
     API all get it): if the incoming/stored sheet is EXACTLY what the PREVIOUS
     method/bank/online would have derived, it was auto-filled, not typed — so
     when those inputs change, re-derive it. A sheet that differs from the prior
     derived value is a genuine operator entry and is left alone. */
  const priorDerived = deriveAccountSheet(before.method, before.merchant_provider, before.online_type);
  const nextDerived = () => deriveAccountSheet(nextMethod, nextMerchantProvider, nextOnline);
  const derivedInputsChanged =
    nextMethod !== before.method
    || (nextMerchantProvider ?? null) !== (before.merchant_provider ?? null)
    || (nextOnline ?? null) !== (before.online_type ?? null);
  /* `staleAutoFill` = the sheet we'd keep is verbatim what the OLD method/bank
     derived, and that method/bank just changed ⇒ it was auto-filled and is now
     wrong. Anything else is either blank or an operator's own text. */
  const staleAutoFill = (sheet: string | null): boolean =>
    derivedInputsChanged && (sheet ?? '') === priorDerived;
  // undefined = field absent from the PATCH body; '' = explicitly cleared.
  const sentSheet = p.accountSheet === undefined ? undefined : (p.accountSheet ?? '').trim();
  const nextAccountSheet = sentSheet !== undefined
    // Sent: blank → derive (unchanged); stale auto-fill → re-derive; else hand-typed wins.
    ? (!sentSheet || staleAutoFill(sentSheet) ? nextDerived() : sentSheet)
    // Not sent: untouched (unchanged) UNLESS the stored value is a stale auto-fill.
    : (staleAutoFill(before.account_sheet) ? nextDerived() : before.account_sheet);

  /* Method ⇒ sub-field mapping on EDIT (2026-07-16) — the same rule POST enforces
     (payment_method_field_required), applied to the EFFECTIVE post-edit values.
     POST was hardened earlier the same day but PATCH was not, so an edit could
     still strip the Bank off a card payment (or the Sub-Type off a transfer) and
     leave the row with no mapping — the exact state the POST guard exists to
     prevent. Amount-bearing rows only, matching POST + the desktop guard; the
     Plan stays un-gated for the same reason (One-off ⇒ installmentMonths null). */
  if (nextAmount > 0) {
    let missing: string | null = null;
    let methodName = '';
    if (nextMethod === 'merchant' && !nextMerchantProvider?.trim()) { missing = 'bank'; methodName = 'card / merchant'; }
    else if (nextMethod === 'transfer' && !nextOnline?.trim()) { missing = 'sub-type'; methodName = 'bank transfer / online'; }
    if (missing) {
      return c.json({
        error: 'payment_method_field_required',
        reason: `A ${methodName} payment needs a ${missing} before it can be saved.`,
      }, 400);
    }
  }

  /* Over-collection is allowed here too (owner 2026-08-16) — the POST's mirror
     guard is gone, and a correction that lands above the total must not be
     refused when the original could not be either. Amending RM 2,000 up to
     RM 2,250 on a RM 2,000 order is exactly the correction the guard used to
     push into a line re-price. See the POST for the full note. */

  const { data: updated, error: updErr } = await sb
    .from('mfg_sales_order_payments')
    .update({
      paid_at:            nextPaidAt,
      method:             nextMethod,
      merchant_provider:  nextMerchantProvider,
      installment_months: nextInstallment,
      online_type:        nextOnline,
      approval_code:      nextApproval,
      amount_sen:       nextAmount,
      account_sheet:      nextAccountSheet,
      collected_by:       nextCollectedBy,
      version:             expectedPaymentVersion + 1,
      updated_at:          new Date().toISOString(),
    })
    .eq('id', id)
    .eq('so_doc_no', docNo)
    .eq('version', expectedPaymentVersion)
    /* so_doc_no proves the payment is on THIS order; company_id proves the order
       is in THIS company's books. Today the router-level mirrored-SO guard also
       refuses any `2990-` path, but that guard LIFTS on the HOUZS_OWNS_2990
       cutover flip - after which this predicate is the only isolation left, the
       SCM client being service-role. */
    .eq('company_id', co.companyId)
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) {
    const { data: latest } = await sb.from('mfg_sales_order_payments').select('version').eq('id', id).maybeSingle();
    return c.json({ error: 'payment_version_conflict', currentVersion: Number(latest?.version ?? expectedPaymentVersion) }, 409);
  }

  /* UPDATE_PAYMENT audit — same ledger + shape as ADD/DELETE, listing only the
     fields that actually changed (from → to). Best-effort inside recordSoAudit. */
  const changes: FieldChange[] = [];
  if (nextPaidAt !== before.paid_at) changes.push({ field: 'paidAt', from: before.paid_at, to: nextPaidAt });
  if (nextMethod !== before.method) changes.push({ field: 'method', from: before.method, to: nextMethod });
  if (nextAmount !== before.amount_sen) changes.push({ field: 'amountSen', from: before.amount_sen, to: nextAmount });
  if ((nextMerchantProvider ?? null) !== (before.merchant_provider ?? null)) changes.push({ field: 'merchantProvider', from: before.merchant_provider, to: nextMerchantProvider });
  if ((nextInstallment ?? null) !== (before.installment_months ?? null)) changes.push({ field: 'installmentMonths', from: before.installment_months, to: nextInstallment });
  if ((nextOnline ?? null) !== (before.online_type ?? null)) changes.push({ field: 'onlineType', from: before.online_type, to: nextOnline });
  if ((nextApproval ?? null) !== (before.approval_code ?? null)) changes.push({ field: 'approvalCode', from: before.approval_code, to: nextApproval });
  if ((nextAccountSheet ?? null) !== (before.account_sheet ?? null)) changes.push({ field: 'accountSheet', from: before.account_sheet, to: nextAccountSheet });
  if ((nextCollectedBy ?? null) !== (before.collected_by ?? null)) changes.push({ field: 'collectedBy', from: before.collected_by, to: nextCollectedBy });
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_PAYMENT',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: changes,
  });

  /* Same reason as the insert: an edited amount moves the outstanding balance,
     which is a value AutoCount holds. Unlike the insert this one lives in the
     route, because the UPDATE above is the route's own and has no shared core.
     Fires even when only the method changed — recomposing an unchanged BALANCE
     costs one queued edit, while deciding here which fields matter would put a
     second opinion about the balance rule next to so-outstanding.ts. */
  await queueAcSoEdit(c, docNo);
  // An edited amount also moves what the invoices off this order have settled.
  await recomputeSiPaidForOrder(sb, docNo, co.companyId);

  const { staff, ...rest } = updated as unknown as Record<string, unknown> & { staff: { name: string } | null };
  return c.json({ payment: { ...rest, collected_by_name: staff?.name ?? null } });
});

mfgSalesOrders.delete('/:docNo/payments/:id', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
  const user = c.get('user');
  // Audit 2026-06-20 — self-scoped sales may only touch their OWN SO (mirror the line/header guards).
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  // Guard: only delete if the row belongs to this docNo. Prevents a
  // mis-routed call from nuking another SO's payment.
  const { data: row } = await scopeToCompany(sb.from('mfg_sales_order_payments').select('*').eq('id', id), c).maybeSingle();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const rowTyped = row as { so_doc_no: string; paid_at: string; method: string; amount_sen: number; approval_code: string | null; version: number };
  if (rowTyped.so_doc_no !== docNo) return c.json({ error: 'payment_doc_mismatch' }, 400);
  const currentVersion = Number(rowTyped.version ?? 1);
  const versionCheck = paymentVersionGuard(c.req.query('version'), currentVersion, soCasGrace(c));
  if (!versionCheck.ok) return c.json(versionCheck.body, versionCheck.status);
  const expectedVersion = versionCheck.version;

  /* SAME-DAY WINDOW (Owner 2026-07-19) — "删除只有在当天才行。正常情况下，他当天
     key in 的时候，因为还没有 lock 下来，所以当天都可以任意更改." A payment row may
     be deleted ONLY on the MY calendar day it was keyed in.

     This route previously had NO time gate at all — strictly weaker than the
     PATCH on the same row, which has carried this window since 2026-07-13. So a
     months-old payment on a delivered, invoiced SO could be hard-deleted,
     silently flipping the order from PAID back to owing. This closes that.

     Keyed off created_at (when the row was KEYED IN), never paid_at (the date
     on the document): keying off paid_at would let someone unlock an old
     payment's deletion by first editing its date to today, with the edit and
     the delete authorising each other.

     MYT, not UTC — mytDateOf/todayMyt shift +8h before reading the date, so the
     window closes at Malaysian midnight rather than 8h late or 8h early.

     Enforced HERE and not only in the UI: the clients also drop the delete
     control once the window closes, but that is the courtesy — this is the
     control. The DRAFT exemption mirrors the PATCH route exactly (a draft has
     nothing locked; the owner was describing a confirmed order).

     WHERE THE DEFERRED RULE GOES: the owner has parked the bank-reconciliation
     condition ("如果他已经做完 bank record 并且 knock off 掉了，就不行了") until
     reconciliation and knock-off exist. When he defines it, it becomes one more
     argument to paymentRowMutable() — that predicate is the only place any
     surface asks this question, so it lands everywhere at once. Nothing
     speculative is built for it here. */
  const { data: soStatusRow } = await sb
    .from('mfg_sales_orders')
    .select('status')
    .eq('doc_no', docNo)
    .maybeSingle();
  const soIsDraft = (soStatusRow?.status as string | undefined) === 'DRAFT';
  const createdAtRaw = (row as { created_at?: unknown }).created_at;
  if (typeof createdAtRaw !== 'string' || Number.isNaN(new Date(createdAtRaw).getTime())) {
    /* An unreadable created_at means we cannot tell whether the window is open.
       Surface it rather than defaulting — a `?? today` would silently allow the
       delete, a `?? ''` would silently deny it, and both lie about why. */
    return c.json({
      error: 'payment_created_at_unreadable',
      reason: 'This payment is missing the date it was keyed in, so it cannot be removed safely. '
        + 'Please tell IT which payment this is.',
    }, 409);
  }
  const windowCheck = paymentRowMutable(mytDateOf(createdAtRaw), todayMyt(), soIsDraft);
  if (!windowCheck.mutable) {
    return c.json({
      error: PAYMENT_WINDOW_CLOSED_ERROR,
      reason: windowCheck.problem,
    }, 409);
  }

  // STRICT like the PATCH/POST either side: scopeToCompany degrades, and this DELETEs.
  const delCo = requireActiveCompanyId(c); if (!delCo.ok) return c.json(delCo.refusal, 409);
  const { data: deleted, error } = await scopeToCompanyId(sb.from('mfg_sales_order_payments').delete()
    .eq('id', id)
    .eq('so_doc_no', docNo)
    .eq('version', expectedVersion), delCo.companyId)
    .select('id')
    .maybeSingle();
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!deleted) {
    const { data: latest } = await sb.from('mfg_sales_order_payments').select('version').eq('id', id).maybeSingle();
    return c.json({ error: 'payment_version_conflict', currentVersion: Number(latest?.version ?? expectedVersion) }, 409);
  }

  // Void the ledger entry AND re-roll the invoices this deposit was settling
  // (lib/so-payment-row afterSoPaymentRemoved). Best-effort, never blocks.
  await afterSoPaymentRemoved(sb, { paymentId: id, docNo, companyId: delCo.companyId });

  /* Post-merge stitch — DELETE_PAYMENT audit row. Carries the typed reason as a
     field change so it renders in AuditHistoryPanel alongside the amount that
     vanished, rather than sitting in a note nobody opens. */
  await recordSoAudit(sb, {
    docNo,
    action: 'DELETE_PAYMENT',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'paidAt',       from: rowTyped.paid_at,       to: null },
      { field: 'method',       from: rowTyped.method,        to: null },
      { field: 'amountSen',  from: rowTyped.amount_sen,  to: null },
      ...(rowTyped.approval_code ? [{ field: 'approvalCode', from: rowTyped.approval_code, to: null } satisfies FieldChange] : []),
    ],
  });

  /* A deleted payment raises the outstanding balance, so the account book has
     to be told in the same way an added one does. This is the direction that
     matters most: a book left showing a settled order after the payment was
     reversed understates what the customer owes. */
  await queueAcSoEdit(c, docNo);

  return c.json({ ok: true });
});

/* Spec D4 — per-payment slip view. Same binding-served proxy + vocabulary as
   the order-level /:docNo/slip-url route (converted from presign 2026-07-04,
   see that route's comment); legacy rows (slip_key NULL) → no_slip_attached
   and the UI falls back to the order slip. */
mfgSalesOrders.get('/:docNo/payments/:id/slip-url', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
  // Same reasoning as the item-photo route: the so_doc_no match below compares
  // two caller-supplied values. A payment SLIP is a bank record — gate it.
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const { data: row, error } = await sb
    .from('mfg_sales_order_payments')
    .select('so_doc_no, slip_key')
    .eq('id', id)
    .maybeSingle();
  if (error) return c.json({ error: 'db_fetch_failed', detail: error.message }, 500);
  const r = row as { so_doc_no: string; slip_key: string | null } | null;
  if (!r || r.so_doc_no !== docNo) return c.json({ error: 'not_found' }, 404);
  if (!r.slip_key) return c.json({ error: 'no_slip_attached' }, 400);

  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }
  const obj = await bindings.bucket.get(r.slip_key);
  if (!obj) return c.json({ error: 'file_not_in_r2' }, 404);
  return new Response(obj.body as unknown as BodyInit, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? mimeFromKey(r.slip_key),
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=300',
    },
  });
});

/* Attach the proof to an ALREADY-RECORDED payment (owner 2026-08-07 —
   "开放 backend 可以上传 balance payment proof").

   Until now the slip could only ride along with the INSERT: paymentCreateSchema
   took an uploadSessionId, paymentPatchSchema did not, and both editors say in
   as many words that an edit never touches the slip. So a balance collected
   without the receipt on hand — the normal case when the money lands in the
   bank before the slip reaches the office — had no route back to its proof,
   ever.

   Deliberately NOT behind the same-day window that gates PATCH / DELETE. That
   window exists because the day's cash-up settles the MONEY, and a settled
   amount must not move afterwards. This route moves no money: amount, method,
   date and collector are all untouched, and the paid/balance rollups (which sum
   amount_sen) cannot shift. Gating it would defeat the entire point, since
   the proof that arrives late is precisely the proof that arrives on a later
   day.

   Replacing an existing slip is allowed — a wrong photo needs a way back — and
   both keys go into the UPDATE_PAYMENT audit entry, so a swap is on the record
   rather than silent. */
const paymentSlipAttachSchema = z.object({
  uploadSessionId: z.string().min(1),
});

mfgSalesOrders.post('/:docNo/payments/:id/slip', async (c) => {
  // WRITE: the company must RESOLVE (companyScope.ts strict rule) - a payment
  // edit is a books change, so an unknown company refuses rather than widens.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
  const user = c.get('user');
  // Same self-scope gate as POST / PATCH / DELETE payments.
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: row, error: rowErr } = await sb
    .from('mfg_sales_order_payments')
    .select('id, so_doc_no, slip_key, version')
    .eq('id', id)
    .maybeSingle();
  if (rowErr) return c.json({ error: 'lookup_failed', reason: rowErr.message }, 500);
  const before = row as { so_doc_no: string; slip_key: string | null; version: number } | null;
  if (!before) return c.json({ error: 'not_found' }, 404);
  if (before.so_doc_no !== docNo) return c.json({ error: 'payment_doc_mismatch' }, 400);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentSlipAttachSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const { uploadSessionId } = parsed.data;

  /* Resolve the upload session → committed R2 key. Same contract as the POST
     route: only a session that finished its PUT ('uploaded') resolves, so a
     dangling id can never blank out or mis-point an existing slip.

     `uploadSessionId` is REQUIRED on this route and that is not the rule the
     owner relaxed on 2026-08-13 — attaching a slip is the whole point of the
     endpoint. A payment that wants no slip simply never calls it. */
  const { data: slipRow, error: slipErr } = await sb
    .from('pending_slip_uploads')
    .select('r2_key, status')
    .eq('upload_session_id', uploadSessionId)
    .maybeSingle();
  if (slipErr) return c.json({ error: 'lookup_failed', reason: slipErr.message }, 500);
  const slipRowT = slipRow as { r2_key: string | null; status: string } | null;
  if (!slipRowT || slipRowT.status !== 'uploaded' || !slipRowT.r2_key) {
    return c.json({ error: 'slip_required', reason: 'Upload the payment slip first.' }, 400);
  }
  const nextSlipKey = slipRowT.r2_key;

  const expectedVersion = Number(before.version ?? 1);
  const { data: updated, error: updErr } = await sb
    .from('mfg_sales_order_payments')
    .update({
      slip_key:   nextSlipKey,
      version:    expectedVersion + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('so_doc_no', docNo)
    .eq('version', expectedVersion)
    .eq('company_id', co.companyId) // see the note on the payment PATCH
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) {
    const { data: latest } = await sb.from('mfg_sales_order_payments').select('version').eq('id', id).maybeSingle();
    return c.json({ error: 'payment_version_conflict', currentVersion: Number(latest?.version ?? expectedVersion) }, 409);
  }

  /* Promote — 'promoted' rows are excluded from the slip reaper, same dance as
     the POST path. Logged loudly rather than swallowed on a no-op: the payment
     keeps its slip_key either way, but an un-promoted row means the R2 object
     is on the reaper's list. */
  const { data: promoted, error: promoteErr } = await sb
    .from('pending_slip_uploads')
    .update({ status: 'promoted', promoted_at: new Date().toISOString() })
    .eq('upload_session_id', uploadSessionId)
    .select('upload_session_id');
  if (promoteErr || !promoted || promoted.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[payments] slip promote FAILED for session ${uploadSessionId} on ${docNo}/${id}: `
      + (promoteErr?.message ?? 'no row matched (RLS uploader mismatch?)')
      + ' — slip will be reaped after TTL; re-upload window open until then.',
    );
  }

  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_PAYMENT',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    note: before.slip_key ? 'Payment proof replaced' : 'Payment proof attached',
    fieldChanges: [{ field: 'slipKey', from: before.slip_key, to: nextSlipKey }],
  });

  const { staff, ...rest } = updated as unknown as Record<string, unknown> & { staff: { name: string } | null };
  return c.json({ payment: { ...rest, collected_by_name: staff?.name ?? null } });
});

// ── Debtor lookup — autocomplete from prior SOs ───────────────────────
mfgSalesOrders.get('/debtors/search', async (c) => {
  const sb = c.get('supabase'); const q = c.req.query('q') ?? '';
  let query = scopeToCompany(sb.from('mfg_sales_orders').select('debtor_code, debtor_name, phone, address1, address2, address3, address4'), c).order('updated_at', { ascending: false }).limit(200);
  { const s = escapeForOr(q); if (s) query = query.or(`debtor_name.ilike.%${s}%,debtor_code.ilike.%${s}%`); }
  const { data, error } = await query;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  // Dedupe by (debtor_code || debtor_name) — keep most recent only.
  const seen = new Set<string>();
  const out = [];
  for (const r of (data ?? []) as Array<Record<string, string | null>>) {
    const key = (r.debtor_code || r.debtor_name || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= 25) break;
  }
  return c.json({ debtors: out });
});

/* ════════════════════════════════════════════════════════════════════════
   PATCH /:docNo/items/:itemId/stock-status
   ────────────────────────────────────────────────────────────────────────
   Commander 2026-05-28: per-line stock fulfillment flag. body { status:
   'PENDING' | 'READY' }. After the flip, recompute the SO-level aggregate
   and auto-advance the SO's status to READY_TO_SHIP when EVERY non-cancelled
   line is READY (and the order is currently in a pre-ready state). An
   audit log entry is written for both the line flip and the status
   transition.
   ════════════════════════════════════════════════════════════════════════ */
mfgSalesOrders.patch('/:docNo/items/:itemId/stock-status', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const user = c.get('user');
  // Audit 2026-06-20 — self-scoped sales may only touch their OWN SO (mirror the line/header guards).
  // AUTHZ BEFORE CONCURRENCY (2026-07-22): this gate now runs BEFORE the edit
  // lease. A caller who may not touch this order at all was previously told
  // "This order is being saved on another screen — wait a moment and try Save
  // again", i.e. a permission refusal wearing a conflict's clothes, which
  // invites an endless retry and never surfaces the real reason.
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  let body: { status?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const nextStatus = (body.status ?? '').trim().toUpperCase();
  if (nextStatus !== 'PENDING' && nextStatus !== 'READY') {
    return c.json({ error: 'status_invalid', message: 'PENDING or READY' }, 400);
  }

  // Look up the current row so the audit log can capture from→to.
  const { data: prev, error: findErr } = await sb
    .from('mfg_sales_order_items')
    .select('doc_no, stock_status, item_code, item_group, cancelled')
    .eq('id', itemId)
    .eq('doc_no', docNo)
    .maybeSingle();
  if (findErr) return c.json({ error: 'load_failed', reason: findErr.message }, 500);
  if (!prev) return c.json({ error: 'not_found' }, 404);

  const prevTyped = prev as { stock_status: string; item_code: string; item_group: string; cancelled: boolean };
  if (prevTyped.cancelled) {
    return c.json({ error: 'item_cancelled', message: 'Cannot change stock_status on a cancelled line.' }, 400);
  }
  if (prevTyped.stock_status === nextStatus) {
    return c.json({ ok: true, unchanged: true });
  }

  // Flip the line.
  const { error: updErr } = await sb
    .from('mfg_sales_order_items')
    .update({ stock_status: nextStatus })
    .eq('id', itemId);
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);

  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'stockStatus', from: prevTyped.stock_status, to: nextStatus },
      { field: 'itemCode',    from: prevTyped.item_code,    to: prevTyped.item_code },
    ],
    note: nextStatus === 'READY' ? 'Stock marked ready' : 'Stock marked pending',
  });

  // Re-aggregate at the SO level. B2C semantic: an SO is ship-able once every
  // MAIN product line (sofa/bedframe/mattress) is READY — accessories pending
  // are OK. isShipReady adds a refusal to ship an SO with no stock-bearing lines, where bare isMainReady is vacuously true.
  //
  // item_code + the catalog category ride the read (2026-08-16). Without them
  // this path could not see a SERVICE line at all: it passed item_group alone,
  // so a delivery-fee SKU saved with item_group 'others' counted as a short
  // accessory and held the whole order back — while the list endpoint and the
  // allocation sweep, which do pass the code, disagreed with it on the same SO.
  const { data: allLines } = await sb
    .from('mfg_sales_order_items')
    .select('item_group, item_code, stock_status, cancelled')
    .eq('doc_no', docNo);
  const liveRows: ReadinessLine[] = ((allLines ?? []) as Array<{ item_group: string; item_code: string | null; stock_status: string; cancelled: boolean }>)
    .filter((l) => !l.cancelled);
  /* One bounded catalog read for THIS SO's codes (a single order — tens of rows
     at most), through the same helper the list and the board use, so
     isServiceLine gets its strongest signal here too.
     Refuse on failure, do NOT fall through: this decides whether a line is a
     SERVICE, i.e. whether it can hold the SO out of READY_TO_SHIP. The line flip
     above is already committed and the allocation sweep re-derives the header
     idempotently, so refusing costs the caller a retry, not the edit. */
  const { error: catErr } = await resolveLineCategories(sb, [liveRows], (q) => scopeToCompany(q, c));
  if (catErr) return c.json({ error: 'load_failed', reason: catErr.message }, 500);
  const readiness = summariseReadiness(liveRows);
  const allReady = readiness.isShipReady;

  let advancedTo: string | null = null;
  if (allReady) {
    const { data: header } = await sb
      .from('mfg_sales_orders')
      .select('status')
      .eq('doc_no', docNo)
      .maybeSingle();
    const cur = (header as { status?: string } | null)?.status ?? null;
    if (cur === 'CONFIRMED' || cur === 'IN_PRODUCTION') {
      const generation = await advanceSoGeneration(sb, docNo, { status: 'READY_TO_SHIP' }, { status: cur });
      if (generation.applied) {
        advancedTo = 'READY_TO_SHIP';
        await recordSoAudit(sb, {
          docNo,
          action: 'UPDATE_STATUS',
          actorId: user.id,
          actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
          statusSnapshot: 'READY_TO_SHIP',
          fieldChanges: [{ field: 'status', from: cur, to: 'READY_TO_SHIP' }],
          note: 'Auto-advanced: all lines READY',
        });
      }
    }
  }

  return c.json({ ok: true, advancedTo });
});

/* ── SO amendment create (port of 2990 ec7945f) ─────────────────────────────
   POST /mfg-sales-orders/:docNo/amendments — raise an amendment request against
   a PROCESSING-LOCKED Sales Order. Once the processing date has passed the SO is
   what we PO'd to the supplier (soProcessingLocked), so a change can no longer be
   a naked line edit — it must ride the supplier-confirmed, two-gate amendment
   workflow (state machine in ../shared). This handler lives here (not
   so-amendments.ts) so it can reuse this file's private guards
   (soProcessingLocked / soHasDownstream / recordSoAudit) and nest under the SO
   mount. The remaining amendment endpoints live in routes/so-amendments.ts.

   Guards, in order:
     1. SO exists                          → 404 not_found
     2. SO IS processing-locked            → else 409 not_locked_no_amendment_needed
     3. SO is NOT DO/SI hard-locked        → else 409 so_hard_locked
     4. No existing OPEN amendment          → else 409 amendment_already_open
        (status NOT IN SENT/REJECTED; the partial unique index is the backstop)

   Houzs gate: scm.amendment.create against the REAL caller (hasHouzsPerm) — the
   2990 scm.staff.role check is dead here (the SCM bridge pins to one super_admin
   row). Owner + IT Admin pass via `*`. ADDITIVELY, any salesperson (isSalesCaller,
   keyed off STABLE ORG FIELDS) may submit an amendment on their OWN locked SO:
   the gate below OR-s in isSalesCaller, and the ownership check further down
   (salesDocOutOfScope) confines a rep to their own + downline Sales Orders while
   view-all roles (directors / office) stay unrestricted. The approve-so /
   approve-po / supplier-confirm gates are UNCHANGED — those remain office-only
   (scm.amendment.approve_so / approve_po). */
mfgSalesOrders.post('/:docNo/amendments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');

  // Submit gate — the flat `scm.amendment.create` grant (Owner / IT Admin via
  // `*`, office positions via the matrix) OR any salesperson by STABLE ORG
  // FIELD (isSalesCaller). Ownership is enforced after the SO row loads, so a
  // rep passing here can still only amend a Sales Order within their own scope.
  /* Two-lane phase 2: a LANE APPROVER may also RAISE a request — whoever can
     sign a change can obviously ask for it (the Delivery-Planning drawer
     raises replacement-disposal changes under this: the owner ruled those
     "appear in SO Amendment — Logistics reviews → approves" rather than any
     direct-write shortcut). Additive to the create key + the sales org-field
     path; ownership scoping below is unchanged. */
  const isLaneApprover =
    hasHouzsPerm(c, 'scm.amendment.approve_lines') || hasHouzsPerm(c, 'scm.amendment.approve_delivery');
  if (!hasHouzsPerm(c, 'scm.amendment.create') && !isSalesCaller(c) && !isLaneApprover) {
    return c.json({
      error: 'amendment_create_forbidden',
      message: 'You do not have permission to raise a Sales Order amendment.',
    }, 403);
  }

  let body: {
    reason?: string;
    headerChanges?: Record<string, unknown> | null;
    lines?: Array<{
      salesOrderItemId?: string | null;
      changeType?: string;
      newItemCode?: string | null;
      newVariants?: unknown;
      newQty?: number | null;
      newUnitPriceSen?: number | null;
      oldSnapshot?: unknown;
    }>;
  };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }

  // Guard 1 — SO exists. Pull the lock columns (processing_date + status) plus
  // salesperson_id for the ownership scope check below, plus the amendable
  // header columns for the header-change snapshot / date checks.
  const { data: soRow } = await scopeToCompany(sb.from('mfg_sales_orders')
    .select('doc_no, status, revision, processing_date, salesperson_id, ' +
      'customer_delivery_date, customer_state, postcode')
    .eq('doc_no', docNo), c).maybeSingle();
  if (!soRow) return c.json({ error: 'not_found' }, 404);

  // Ownership scope — same tiering as the SO detail/list reads (lib/salesScope):
  // view-all roles (directors / office, canViewAllSales) may amend ANY SO; a
  // scoped salesperson may amend only a Sales Order whose salesperson_id is in
  // their own + downline subtree. An out-of-scope doc_no answers 404 —
  // indistinguishable from a nonexistent one, exactly like the detail route.
  {
    const sp = (soRow as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }

  // Self-scope stub (no-op in Houzs — the SCM bridge has no POS-self-scoped
  // sellers); kept for call-site parity with 2990.
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  /* Guard 2 — an amendment only makes sense once the SO is locked; an unlocked
     SO is still directly editable, so no amendment is needed. Owner 2026-08-12:
     "locked" now means date-locked OR PO-locked (2990). This guard is the MIRROR
     of the write guards above — if it kept asking only about the date, a
     PO-locked SO would be refused BOTH roads (409 on the direct edit, 409 here
     for "not locked yet") and the operator would have no way to change anything
     at all. Keep the two definitions in lock-step. */
  if (!await soEditLocked(sb, docNo, soRow as unknown as { processing_date?: string | null; status: string | null })) {
    return c.json({
      error: 'not_locked_no_amendment_needed',
      reason: 'This Sales Order is not processing-locked yet — edit it directly instead of raising an amendment.',
    }, 409);
  }

  // Guard 3 — a DO/SI (SHIPPED+ implies a DO) hard-locks the SO.
  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) {
    return c.json({
      error: 'so_hard_locked',
      reason: 'This Sales Order already has a Delivery Order / Sales Invoice — it is too far along to amend.',
    }, 409);
  }

  // Guard 4 — openness (two-lane rework 2026-07-27). A LEGACY open row (lane
  // NULL, pre-rework, possibly mid two-gate chain) still blocks EVERYTHING —
  // its chain owns the SO until it closes. Lane rows block only their OWN lane;
  // that half of the guard runs after classification below, where we know which
  // lanes this submission needs. The partial unique indexes
  // (uq_so_amendment_open_legacy / uq_so_amendment_open_lane, mig 0215) are the
  // DB backstop; the pre-checks give clean 409s + feed the amendment_no counter.
  const { data: priorRows } = await scopeToCompany(sb.from('so_amendments')
    .select('id, status, lane').eq('so_doc_no', docNo), c);
  const prior = (priorRows ?? []) as Array<{ id: string; status: string; lane: string | null }>;
  const legacyOpen = prior.some((a) => a.lane == null && a.status !== 'SENT' && a.status !== 'REJECTED');
  if (legacyOpen) {
    return c.json({
      error: 'amendment_already_open',
      reason: 'An amendment is already open on this Sales Order — resolve it before raising another.',
    }, 409);
  }

  /* Guard 5 (Owner 2026-07-16) — an amendment must actually REQUEST something.
     Validate the client-authored header_changes against AMENDABLE_HEADER_FIELDS
     (the trust boundary — an unlisted key would otherwise be written straight to
     the SO on approve), then reject a wholly-empty amendment. Previously `lines`
     could be [] with no header channel at all, so an operator who changed only a
     header field created an EMPTY amendment that went to the approval queue with
     nothing in it — or, on the frontend, was silently dropped. Both halves are
     optional; at least ONE must be present. */
  const rawHeaderChanges = (body.headerChanges ?? null) as Record<string, unknown> | null;
  const headerChanges: Record<string, string | null> = {};
  if (rawHeaderChanges && typeof rawHeaderChanges === 'object') {
    /* hasOwnProperty, NOT `in` — `in` walks the prototype chain, so a payload key
       of "constructor" / "toString" would pass an `in` allow-list check and then
       resolve to an inherited value. Own-keys only. */
    const isAmendable = (k: string): boolean =>
      Object.prototype.hasOwnProperty.call(AMENDABLE_HEADER_FIELDS, k);
    const unknownKeys = Object.keys(rawHeaderChanges).filter((k) => !isAmendable(k));
    if (unknownKeys.length > 0) {
      return c.json({
        error: 'header_field_not_amendable',
        reason: `These fields cannot be changed by an amendment: ${unknownKeys.join(', ')}.`,
      }, 400);
    }
    for (const [k, v] of Object.entries(rawHeaderChanges)) {
      if (v !== null && typeof v !== 'string') {
        return c.json({ error: 'header_field_invalid', reason: `The requested value for ${k} is not valid.` }, 400);
      }
      const val = v === null ? null : v.trim();
      headerChanges[k] = val === '' ? null : val;
    }
    /* debtor_name is NOT NULL — refuse a blank requested name at SUBMIT so the
       requester fixes it, not the approve failing on the constraint. */
    if ('debtorName' in headerChanges && headerChanges['debtorName'] === null) {
      return c.json({ error: 'header_field_invalid', reason: 'Customer name cannot be blank — enter the corrected name instead.' }, 400);
    }
  }
  const hasHeaderChanges = Object.keys(headerChanges).length > 0;
  const submittedLines = Array.isArray(body.lines) ? body.lines : [];
  if (!hasHeaderChanges && submittedLines.length === 0) {
    return c.json({
      error: 'amendment_empty',
      reason: 'There are no changes to request — edit a line, a date or the delivery location first, then submit the amendment.',
    }, 400);
  }

  /* Edge #4, amendment flavour (owner 2026-08-08: every line is a catalog
     SKU) — any requested new_item_code (an ADD line, or an EDIT that swaps
     the product) must be a real ACTIVE catalog SKU in this company. Refused
     at SUBMIT so the requester fixes it, not the approver; applySoAmendment
     re-checks at apply time as the insert choke point. */
  {
    const requestedCodes = submittedLines
      .map((l) => (typeof l.newItemCode === 'string' ? l.newItemCode.trim() : ''))
      .filter(Boolean);
    if (requestedCodes.length > 0) {
      const codeCheck = await validateItemCodes(sb, requestedCodes, activeCompanyId(c), { requireActive: true });
      if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown, codeCheck.inactive), 409);
    }
  }

  /* Composition, same rule and same home as every other line write (see
     lib/main-mix.ts). This route is the one path that can ADD a line without
     going through POST /:docNo/items, and it had no copy of the rule — nor does
     applySoAmendment — so an amendment could put a sofa on a bedframe order.
     Refused at SUBMIT for the same reason the code check above is: the requester
     can fix it, the approver cannot. Grandfathered like every other edit path —
     an order that already mixes is not made unamendable. */
  {
    const mixLines = submittedLines.map((l) => ({
      salesOrderItemId: typeof l.salesOrderItemId === 'string' ? l.salesOrderItemId : null,
      changeType:       typeof l.changeType === 'string' ? l.changeType : null,
      newItemCode:      typeof l.newItemCode === 'string' ? l.newItemCode : null,
    }));
    const mainMix = await amendmentMixRefusal(sb, docNo, mixLines, activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  /* Date sanity on a requested schedule change (mirrors the create/edit form's
     shared soDateGuardError). The pair is resolved against the SO's CURRENT
     values so changing ONE date is still checked against the other; an unchanged
     already-past date is NOT re-rejected (it is what the amendment exists to
     fix), but a NEWLY-requested past date is. */
  if (hasHeaderChanges) {
    const cur = soRow as { processing_date?: string | null; customer_delivery_date?: string | null };
    const ymd = (v: string | null | undefined): string => (v == null ? '' : String(v).slice(0, 10));
    const curProc = ymd(cur.processing_date);
    const curDeliv = ymd(cur.customer_delivery_date);
    const nextProc = 'processingDate' in headerChanges ? ymd(headerChanges['processingDate']) : curProc;
    const nextDeliv = 'customerDeliveryDate' in headerChanges ? ymd(headerChanges['customerDeliveryDate']) : curDeliv;
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    /* Same predicate as every other write path (shared/so-processing-date), with
       this path's own error code kept: `amendment_dates_xor` is what the
       amendment UI branches on, and the aim is one RULE, not one string. The
       stored pair is passed as the originals so an amendment that touches
       neither date on a legacy unpaired order is still submittable — that is
       what the amendment queue exists to fix. */
    if (soDatePairRefusal({ nextProc, nextDeliv, origProc: curProc, origDeliv: curDeliv })) {
      return c.json({
        error: 'amendment_dates_xor',
        reason: 'Processing Date and Delivery Date must be set together — request both, or clear both.',
      }, 400);
    }
    if ('processingDate' in headerChanges && nextProc !== '' && nextProc !== curProc && nextProc < todayMY) {
      return c.json({
        error: 'amendment_date_in_past',
        reason: 'The new Processing Date cannot be in the past — pick today or a future date.',
      }, 400);
    }
    if ('customerDeliveryDate' in headerChanges && nextDeliv !== '' && nextDeliv !== curDeliv && nextDeliv < todayMY) {
      return c.json({
        error: 'amendment_date_in_past',
        reason: 'The new Delivery Date cannot be in the past — pick today or a future date.',
      }, 400);
    }
    if (nextProc !== '' && nextDeliv !== '' && nextProc > nextDeliv) {
      return c.json({
        error: 'amendment_dates_order',
        reason: 'The Processing Date cannot be later than the Delivery Date.',
      }, 400);
    }
  }

  /* ── Two-lane split (owner rework 2026-07-27) ─────────────────────────────
     Classify every requested change into its approval lane — LINES (product
     lines → Purchasing) or DELIVERY (schedule/location, service lines →
     Logistics) — and, when the submission mixes both, SPLIT it into two
     amendment documents that live independent lives. Line classification keys
     off the item code the change targets, resolved SERVER-SIDE from the order
     (an ADD has no persisted line, so its requested new_item_code is used). */
  const referencedIds = [...new Set(submittedLines
    .map((l) => l.salesOrderItemId)
    .filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const itemCodeById = new Map<string, string | null>();
  if (referencedIds.length > 0) {
    const { data: codeRows, error: codeErr } = await sb.from('mfg_sales_order_items')
      .select('id, item_code').eq('doc_no', docNo).in('id', referencedIds);
    if (codeErr) return c.json(LINE_BUILD_ERRORS.unreadable, 500);
    for (const r of (codeRows ?? []) as Array<{ id: string; item_code: string | null }>) {
      itemCodeById.set(r.id, r.item_code);
    }
  }
  const split = splitAmendmentByLane(
    headerChanges,
    submittedLines,
    (l) => (l.salesOrderItemId ? itemCodeById.get(l.salesOrderItemId) : l.newItemCode),
  );

  // Guard 4b — per-lane openness: each lane admits ONE amendment awaiting its
  // approver. The other lane stays free — that is the whole point of the split.
  const openLanes = new Set(prior
    .filter((a) => (a.lane === 'LINES' || a.lane === 'DELIVERY') && a.status === 'REQUESTED')
    .map((a) => a.lane as AmendmentLane));
  const blockedLanes = split.lanes.filter((l) => openLanes.has(l));
  if (blockedLanes.length > 0) {
    return c.json({
      error: 'amendment_already_open',
      reason: `An amendment for ${blockedLanes.map((l) => LANE_LABEL[l]).join(' and ')} is already awaiting approval on this Sales Order — resolve it before requesting another change of that kind.`,
      lanes: blockedLanes,
    }, 409);
  }

  /* Requester = the caller's REAL scm.staff uuid (mig 0066 sync row), NOT
     user.id — the bridge pins user.id to ONE shared system staff row, so
     stamping it made EVERY amendment read as requested by the same system
     identity and "Requested by" could not answer who raised it (same defect
     class as the salesperson_id stamp at ~2738). Fall back to the system row
     when the sync row is missing so the FK stays valid. */
  const requesterStaffId = (await resolveCallerStaffId(sb, c.get('houzsUser')?.id)) ?? user.id;

  /* One insert per lane present. Numbering stays a single /A{n} sequence per SO
     (a mixed submission mints /A3 and /A4). Everything is rolled back together
     if any half fails — a split must never half-exist. */
  const createdAmendments: Array<{
    id: string; so_doc_no: string; amendment_no: string; status: string; lane: AmendmentLane;
    reason: string | null; requested_by: string | null; created_at: string;
  }> = [];
  const rollbackCreated = async () => {
    for (const a of createdAmendments) {
      await sb.from('so_amendments').delete().eq('id', a.id);
    }
  };

  for (const [i, laneKey] of split.lanes.entries()) {
    const half = split.perLane[laneKey];
    const laneHasHeader = half.headerKeys.length > 0;
    const amendmentNo = `${docNo}/A${prior.length + 1 + i}`;

    /* Header half (mig 0119) — the REQUESTED values plus a snapshot of what
       they replace, so the approver sees a before/after without re-reading the
       SO. Snapshot only this LANE's keys, read off the SO row we already hold. */
    const oldHeaderSnapshot: Record<string, string | null> = {};
    if (laneHasHeader) {
      const curRow = soRow as unknown as Record<string, unknown>;
      for (const key of half.headerKeys) {
        const col = AMENDABLE_HEADER_FIELDS[key];
        const cur = curRow[col];
        oldHeaderSnapshot[key] = cur == null ? null : String(cur);
      }
    }

    const { data: created, error: insErr } = await sb.from('so_amendments').insert({
      so_doc_no:    docNo,
      amendment_no: amendmentNo,
      status:       'REQUESTED',
      lane:         laneKey,
      reason:       body.reason ?? null,
      requested_by: requesterStaffId,
      company_id:   activeCompanyId(c),
      header_changes:      laneHasHeader ? half.headerChanges : null,
      old_header_snapshot: laneHasHeader ? oldHeaderSnapshot : null,
    }).select('id, so_doc_no, amendment_no, status, lane, reason, requested_by, created_at, header_changes, old_header_snapshot').single();
    if (insErr) {
      await rollbackCreated();
      if (/uq_so_amendment_open|duplicate key/i.test(insErr.message)) {
        return c.json({
          error: 'amendment_already_open',
          reason: 'An amendment is already open for this kind of change — reload and try again.',
        }, 409);
      }
      return c.json({ error: 'create_failed', reason: insErr.message }, 500);
    }
    const amendment = created as (typeof createdAmendments)[number];
    createdAmendments.push(amendment);

    /* Line rows come from the SHARED builder (lib/amendment-lines), which also
       stamps each line's ITEM GROUP into old_snapshot server-side, read from
       mfg_sales_order_items rather than trusted from the client. The EDIT
       endpoint (PUT /so-amendments/:id) calls the same function. */
    if (half.lines.length > 0) {
      const built = await buildAmendmentLineRows(sb, docNo, amendment.id, half.lines);
      if (!built.ok) {
        await rollbackCreated();
        return built.reason === 'unreadable'
          ? c.json(LINE_BUILD_ERRORS.unreadable, 500)
          : c.json(LINE_BUILD_ERRORS.missing(built.missingIds.length), 409);
      }
      // stampCompany: tag every line row with the active company (mig 0080).
      const { error: lineErr } = await sb.from('so_amendment_lines').insert(stampCompany(built.rows, c));
      if (lineErr) {
        await rollbackCreated();
        return c.json({ error: 'create_failed', reason: lineErr.message }, 500);
      }
    }

    /* History row now, per lane; the notice after the loop, once every half has
       landed. Both live in lib/amendment-raised-effects. */
    await recordAmendmentRequested(sb, {
      docNo, amendmentNo, lane: laneKey, actorId: user.id, reason: body.reason,
      actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
      headerKeys: half.headerKeys, headerChanges: half.headerChanges,
      oldHeaderSnapshot, columnOf: AMENDABLE_HEADER_FIELDS,
    });
  }

  await notifyAmendmentsRaised(c, sb, {
    docNo, reason: body.reason, created: createdAmendments,
    salespersonStaffId: (soRow as { salesperson_id?: string | null }).salesperson_id,
  });

  /* `amendment` (singular) keeps the pre-split response contract for existing
     callers; `amendments` carries the full split so the UI can say "this was
     split into two approvals". */
  return c.json({
    amendment: createdAmendments[0],
    amendments: createdAmendments,
    lanes: split.lanes,
  }, 201);
});
