
import { yymmFor } from '../../services/documentRefs';
import { isSoLineOverDelivered } from '../lib/so-remaining-by-item';
import { activeSoEditLease, soCallerUserId, soHeaderLeaseIntent, soLineWriteLeaseMatches, soEditLeaseExpiryIso, soEditLeaseRefusal, soEditLeaseTakeoverAllowed, type SoEditLeaseRow } from '../lib/so-edit-lease';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { normalizePhone } from '../shared/phone';
import { checkPaymentSlipDate } from '../shared/payment-slip-date';
import { checkPaymentSlip } from '../shared/payment-slip-required';
import {
  splitSofaCode,
  buildVariantSummary, matchComboBuild, type SofaPriceTier,
  oneShotSofaCode, oneShotSimpleCode, remarkSlug,
  fabricTierAddon,
  validateFreeGiftClaims, buildFreeGiftTriggers,
  type FreeGiftLineClaim, type TriggerLine,
  campaignsCoveringLine,
  isFreeItemLine,
  resolveFabricTierOverride,
  type RuleLineInput,
  passesRefinementColumns,
  LANE_LABEL, PRICE_LANE_COMPANY_CODES, ADD_REMOVE_LANE_COMPANY_CODES, type AmendmentLane,
  laneSelfApproves, SELF_APPROVE_KEY,
} from '../shared';
import { computeSoDeliveryFee, type SoDeliveryFeeResult } from '../shared/pricing';
import {
  deriveCountryFromState, deriveSalesLocationFromState, senOrZero, snapshotUnitCostSen,
} from '../lib/sales-doc-derive';
export { deriveCountryFromState, deriveSalesLocationFromState };
import { specialDeliveryFeesForLines, reconstructDeliveryRuleLines } from '../lib/special-delivery';
import { soHasDownstream } from '../lib/downstream-lock';
import { dateOrNull, effectiveDateAfterPatch, isDateColumn } from '../lib/date-coerce';
import { soStatusAfterProcessingDateChange } from '../lib/so-proceed-status-change';
import { recordSoTotalChange, snapshotSoTotals } from '../lib/so-total-changes';
import { liveStatusForProcessingDate, processingDateOnConfirm } from '../shared/so-proceeded-status';
import { syncSoDeliveredFromDo } from '../lib/so-delivery-sync';
import { exemptionExpirySeed } from '../lib/so-exemption-expiry';
import { soIsMigrated, withSoMigratedReadonly } from '../lib/migrated-so-readonly';
import { readSoLineFreeze, soLineWriteRefusal, soBuildLineIds, soLineFrozen, SO_FULLY_FROZEN_REFUSAL, SO_LINE_FROZEN_REFUSAL } from '../lib/downstream-lock';
import { SO_STATUS_RANK, soStatusTransitionError, soDiscardBlocked } from '../lib/so-lifecycle-guards';
import { HELD_OR_TERM, HOLD_COLUMNS, isDocumentHeld } from '../lib/document-hold';
import { mountHoldRoute } from './document-hold-routes';
import { enqueueSoCreate, enqueueCancel, enqueueEdit, retiredLineOf, type AcRetiredLine } from '../lib/autocount-outbox';
import { fitSoAddress } from '../../services/autocount-address-fit';
import { fitAddressIfTouched } from '../lib/so-address-on-save';
import { signalNullWarehouseRows } from '../lib/null-warehouse-signal';
import { deriveAccountSheet, PAYMENT_COLS, recordSoPaymentRow, afterSoPaymentRemoved, bookSoPaymentBestEffort, repostSoPaymentBestEffort, receiptFieldChange, soPaymentFieldChanges, type SoPaymentRowInput } from '../lib/so-payment-row';
import { linkPaymentScan } from '../lib/scan-files';
import { enqueueSoPaymentEdit } from '../lib/ac-so-payment-edit';
import { paymentMethodFieldRefusal } from '../lib/payment-method-fields';
import { selfScopedSalesBlocked } from '../lib/so-self-scope';
import { recomputeSiPaidForOrder } from '../lib/si-order-deposit';
export { recordSoPaymentRow };
export type { SoPaymentRowInput };
import { buildCompartmentsFromModuleLines } from '../lib/compartments-from-module-lines';
import { resolveProceedProcessingDate, PROCEED_NEEDS_DATE } from '../shared/order-rules';
/* The SO edit-policy table (Owner 2026-07-17): FREE fields Save writes straight
   through; CONTROLLED fields Save routes into the amendment. Both the lock Set
   and the amendment allow-list below are DERIVED from it so the three lists
   that used to be hand-mirrored can no longer drift apart. */
import {
  soProcessingLockColumns,
  soAmendableHeaderFields,
  lockedColumnsChanged,
  PAYMENT_WINDOW_CLOSED_ERROR,
} from '../shared/so-field-policy';
import { paymentMayChange, SLIP_DATE_OVERRIDE_NOTE, SO_PAYMENT_AMEND, SO_PAYMENT_BACKDATE } from '../../acc/payment-reconciled';
import { AMEND_SOURCE, ledgerFieldChange } from '../../acc/payment-corrections';
import { paymentReasonRule } from '../lib/so-payment-reason';
import { paymentVersionGuard, soCasGrace, soCasGraceOpen } from '../lib/so-cas';
import { markIdempotencyNoWrite } from '../../middleware/idempotency';
import {
  isServiceLine, isDeliveryFeeServiceCode,
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
import { splitSofaBuildIntoModuleLines, distributeBuildDiscount } from '../shared/so-sofa-split';
import { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank } from '../shared/so-line-display';
import { PAYMENT_METHOD_CODES } from '../shared/payment-methods';
import { soPaidSen, soBalanceSen, soPaidInputsOf } from '../shared/so-outstanding';
import { buildOneShotMints, type OneShotMintReq } from '../lib/one-shot-mint';
import { loadSoWarehouseMasters, resolveSoWarehouseId } from '../lib/so-warehouse';
import { resolveCreateWarehouseDefaults } from '../lib/so-create-warehouse-default';
import { planStateRebindForDoc, stateChangeConflictBody } from '../lib/so-state-warehouse-rebind';
import { canonicalizeMyState } from '../lib/canonical-state';
import { deriveLineBrandingFromProduct, deriveHeaderBrandingFromLines, clientHeaderBranding, loadHeaderBrandList } from '../lib/derive-line-branding';
import { resolveBrandLetterheadKey } from '../lib/brand-letterhead';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { correctedSizeDescription, loadSizeSkuMap } from '../lib/size-variant-description';
import {
  scopeToCompany, activeCompanyId, activeCompanySql, stampCompany, companyDocPrefix,
  isMirroredDocNo, mintsIntoMirroredNamespace, houzsOwns2990,
  MIRRORED_SO_READONLY, MIRRORED_SO_CREATE_BLOCKED,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
} from '../lib/companyScope';
import { loadComboModulesById, loadMasterSofaComboCosts, loadSellingSofaCombos } from '../lib/pos-sofa-combos';
import { comboCostAsOf, combosStandingOn, planComboCostSpread } from '../lib/sofa-combo-cost-spread';
import { priceLineEdit } from '../lib/so-line-edit-cost';
import { openDirectChangeWindow, productChangeWindow } from '../lib/so-product-change-record';
import { recostSofaSetsAfterWrite, sofaModelOf } from '../lib/so-set-change-cost';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { effectiveStatusFilter, isRangeNotSatisfiable } from '../lib/so-list-filters';
import { soLineRemark } from '../lib/so-line-remark';
import { moneySkipsCancelled, NOT_CANCELLED_OR } from '../lib/list-money-cancelled';
import { SO_CANCELLED_FINAL_REASON } from '../lib/so-reopen';
import { fromSoList, orderSoList, prepareSoListRead, readSoListParams } from '../lib/so-list-read';
import { buildSoListRows } from '../lib/so-list-rows';
import { attachSoLines } from '../lib/so-list-lines';
import { SO_TAB_STATUSES, soStatusesForTab } from '../lib/so-tab-statuses';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { tallyStatusRows, type StatusTally } from '../lib/status-counts';
import { readAggregate } from '../lib/postgrest-aggregate';
import { soListKpisSql } from '../lib/so-list-kpis-sql';
import { SO_CUSTOMER_COLS, soCustomerRowsSql } from '../lib/so-customers-sql';
/* "A PO is already out for this SO" — the second road to the same soft lock
   (owner 2026-08-12; every company since 2026-11-09). See lib/so-po-lock.ts. */
import { soHasLivePo, soHasUnreceivedPo, soPoLocked } from '../lib/so-po-lock';
import { deliveryBroughtForward, deliveryNeedsPurchaserOk, processingDateFrozenByPo, PROCESSING_DATE_PO_LOCKED, PROCESSING_DATE_PO_OVERRIDE_KEY } from '../shared/so-po-date-rule';
import { notifySoAmendmentPurchaserOkNeeded } from '../../services/amendmentNotify';
import { monthBoundsMy, rangeBoundsMy, todayMyt, mytDateOf } from '../lib/my-time';
import { hasHouzsPerm, canViewAllSales, isSalesCaller, canViewScmFinance } from '../lib/houzs-perms';
import { SESSION_ORIGIN_POS } from '../../services/auth';
import { sharedLiveMrp } from '../lib/live-mrp-memo';
import { SO_FINANCE_KEYS, SO_ITEM_FINANCE_KEYS, stripAuditFinance } from '../lib/finance-keys';
import { resolveSalesScopeIds, applySoScope, soDocOutOfScope, resolveCallerStaffId } from '../lib/salesScope';
import { recordAmendmentRequested, notifyAmendmentsRaised } from '../lib/amendment-raised-effects';
import {
  venueNameForHalfWrittenPair,
  type VenueSource,
  type VenueBindingSb,
} from '../lib/venue-binding';
import { bindVenueOnCreate, editFairKeyerId, fairConfirmProblems, fairLinkForEdit, fairLinkOnCreate, fairRequiredProblem, isScanCreate, loadLinkedFair, resolveFairForSave, type FairDb } from '../lib/fair-binding';
import { companyUsesKeyerFair, fairDayMissing, fairDayOnSave, fairWhyOf } from '../lib/fair-options';
import { loadVpBrandAsk, type VpBrandDb } from '../lib/vp-brand-ask';
import { recordSoAudit, diffFields, type FieldChange } from '../lib/so-audit';
import { carrySoPhotoToPoLines } from '../lib/so-photo-po-carry';
import { fairStateOf, recordFairChange } from '../lib/fair-audit';
/* What changed on a LINE, for the audit trail — derived from the update about to
   be persisted rather than a hand-kept field list (owner 2026-08-12; see the
   module header for the 2990-SO-2608-017 edit this existed to catch and did not). */
import { soLineFieldChanges } from '../lib/so-line-audit-diff';
import { buildAmendmentLineRows, LINE_BUILD_ERRORS } from '../lib/amendment-lines';
import { resolveAmendmentLaneSplit } from '../lib/amendment-lane-resolve';
import { dropNoopAmendmentLines } from '../lib/amendment-noop-lines';
import { noteScanDraftAccepted } from '../lib/scan-sample-review';
import { genCode, inList, resolveOwnerStaffId } from './pwp-codes';
import { signSoItemPhotoUrl, soItemPhotoBindings, type SlipMime } from '../lib/r2';
import { baseKeyOf, deleteThumbFor, putOptionalThumb, thumbKeyFor } from '../../services/photoThumbs';
import { photoProxyPath, proxyFallbackPayload, warnSigningFailedOnce, type PhotoUrlPayload } from '../lib/photoProxyFallback';
import { slipBindings } from '../lib/slip';
import { amendmentMixRefusal, createMixRefusal, lineMixRefusal, mixesSofaWithOtherMain } from '../lib/main-mix';
import { noWriteUntilMarked, refuseWithoutWriting, writesFromHere } from '../lib/no-write-refusal';
import {
  loadMaintenanceConfig,
  loadSpecialAddons,
  recomputeFromSnapshot,
  erpLineTrust,
  unitAfterLineEdit,
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
import {
  checkAllowedOptions,
  variantsForEditCheck,
  loadProductAndModel,
  loadProductsAndModels,
  variantCheckUnavailableResponse,
} from '../lib/allowed-options-check';
import { findColourKivLines, findIncompleteVariantLines, type ColourKivOffender, type VariantOffender } from '../lib/so-variant-check';
/* Aggregate ALL Processing-Date/save gate failures into one response instead of
   returning on the first (owner 2026-07-18). Pure — no I/O. */
import { collectProcessingGateProblems, validationFailedBody } from '../shared/so-save-problems';
import {
  soProcessingDateProblemsForDoc,
} from '../lib/so-proceed-gate';
import {
  SO_PROCESSING_DATE_COLUMN,
  readSoProcessingDateFromBody,
  soDatePairCascadeColumns,
  soDatePairRefusal,
  soDateYmd,
  soLineDateRefusal,
  withProcessingRemovalCascade,
  isProcessingRemovalOnlyRequest,
} from '../shared/so-processing-date';
import { ATTRIBUTE_OTHER_REFUSAL, SO_IDENTITY_LOCK_COLS, changedIdentityLockCols, salespersonReattributed } from '../shared/so-identity-lock';
import { SO_EDIT_AFTER_DO_PERMISSION, SO_EDIT_PRICE_AFTER_DO_PERMISSION, SO_EDIT_LINES_AFTER_DO_PERMISSION, SO_AFTER_DO_CUSTOMER_COLS, AFTER_DO_INVOICED, AFTER_DO_PRICE_FORBIDDEN, AFTER_DO_PRICE_NOT_DELIVERED, AFTER_DO_LINES_FORBIDDEN, afterDoPriceReturnedRefusal, AFTER_DO_SERVICE_ONLY, afterDoBlockedCols, afterDoFieldsRefusal, afterDoHeaderRefusal, afterDoTargetLockedRefusal, pickAfterDoTarget, type AfterDoTarget } from '../shared/so-after-do-edit';
import { openAfterDo, readAfterDoTargets, catalogSaysService, copyCustomerDetailsToDos, addChargeLineToDo, readDoLinesOfSoLine, copyChargeLineToDo, copyLinePriceToDos, copyLinePriceToInvoices, type DoLineOfSoLine } from '../lib/so-after-do';
import { openProductLineAfterDo, openProductLineRemove, afterDoQtyChangeAllowed, propagateLineEditAfterDo, propagateLineRemoveAfterDo, AFTER_DO_LINE_NOT_SETTLED, type AfterDoLineDeps, type OpenProductLineOk } from '../lib/so-after-do-lines';
import { canonicalizeVariants } from '../shared/so-variant-rule';
import { validateSofaAccessoryOrder, applySofaAccessoryInclusions, isStoredIncludedSofaAccessory, sameSofaComboVariants } from '../lib/sofa-accessory-order';
import { reconcileFreeGiftLinesForSo } from '../lib/free-gift-reconcile';
import { claimPwpForSingleLine, rollbackSinglePwpClaim } from '../lib/pwp-claim-single';
import {
  validateItemCodes, unknownItemCodeResponse,
  findFreeTextSoLines, freeTextSoLineResponse,
} from '../lib/validate-item-codes';
import { collectSoConfirmProblems, soConfirmProblemsForDoc } from '../lib/so-confirm-gate';
import { companyNeedsTransportFee, transportFeeProblem, transportFeeRegion } from '../shared/so-transport-fee';
import { soTransportFeeEditProblem, type SoTransportFeeChange } from '../lib/so-transport-fee-edit';
import { companyRequiresStockLocation, soLocationProblem, soLocationProblemForDoc } from '../lib/so-location-gate';
import { collectSoSubmitProblems, soPaymentSubFieldGap } from '../shared/so-submit-problems';
import { soAgentToStamp, readStaffForStamp, followSalespersonToAgent } from '../lib/so-agent';
import {
  claimedSlipSessionIds,
  planCreatePaymentSlips,
  soCreatePaymentsSchema,
  type SoCreatePayment,
} from '../lib/so-create-payment-slips';
import { pickCrossCategoryMatch, type AutoMatchCandidate } from '../lib/cross-category-match';
import { cancelledRemovalGuard, convertGuard, type ConvertPlan } from '../lib/so-money';
import { cancelledWithMoneyHandler, ordersWithMoneyHandler, soConvertSourcesHandler, soMoneyHandler, soMoneyRefundHandler } from './so-money-routes';
import { recomputeSoStockAllocation, isHardBoundLine } from '../lib/so-stock-allocation';
import { snapshotSoLineLinks, planSoLineRelink, applySoLineRelink, soLineVariantSig } from '../lib/so-line-relink';
import { advanceSoGeneration } from '../lib/so-generation';
import { creditFromCancelledSo, reverseCancelledSoCredit, getCustomerCreditBalance } from '../lib/customer-credits';
import { summariseReadiness, type ReadinessLine } from '../lib/so-readiness';
import { soLineStockVerdict, type LiveStockState, type SoLineStockVerdictRow } from '../lib/so-line-effective-stock';
import { loadNonSellingWarehouses } from '../lib/non-selling-warehouse';
import { resolveLineCategories } from '../lib/so-readiness-category';
import { deriveDisplayBrandingRowByDoc } from '../lib/so-display-branding';
import { mintMonthlyDocNo, insertWithDocNoRetry, companyCodeById } from '../lib/doc-no';
import { soDeliverableRemaining, soLineDeliveries, computeSoLifecycle, soCurrentDocNo, soLineShippedSources, resyncInventoryForDo, restampDoActualCost } from './delivery-orders-mfg';
import { soLineReadySourcePos } from '../lib/source-po-trace';
import { soLineBoundPoNumbers } from '../lib/so-converted-po';
import { mrpLineCoverage, type MrpResult } from './mrp';
import type { Env, Variables } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { deferScmAfterCommit, runScmPgCommand } from '../lib/pg-supabase-transaction';
import {
  applySoCancelVouchers, planSoCancelVouchers, soCancelVoucherAuditChanges,
} from '../lib/so-cancel-vouchers';
import { deferAllocationRecompute, recomputeAllocationAfterSave, scheduleStockAllocationAfterCommand } from '../lib/stock-allocation-job';
import { pgrestIn } from '../lib/pgrest-in-list';
import { skuCategoryResolver } from '../lib/sku-category';
import { fmtSen } from '../shared/format';
import { checkCrossCategorySource, crossCatReasonText } from '../lib/cross-category-source';
import { mimeFromKey } from '../lib/r2';
import { registerMineRoutes } from './mfg-sales-orders/mine';
import { registerSlipRoutes } from './mfg-sales-orders/slip';
import { registerCrossCategoryRoutes } from './mfg-sales-orders/cross-category';
import { registerCustomerCreditRoutes } from './mfg-sales-orders/customer-credit';
import { registerHistoryRoutes } from './mfg-sales-orders/history';
import { registerPaymentsListRoutes } from './mfg-sales-orders/payments-list';
import { registerDebtorSearchRoutes } from './mfg-sales-orders/debtor-search';
import { linesUnreadableBody } from '../lib/failed-read-refusal'; import { readFailure } from '../lib/read-failure'; import { readOverrideLineCost } from '../lib/so-override-cost';
import { stepClock } from '../../lib/step-timing';

export const mfgSalesOrders = new Hono<{ Bindings: Env; Variables: Variables }>();
mfgSalesOrders.use('*', supabaseAuth);

mfgSalesOrders.use('*', async (c, next) => {
  if (c.req.method === 'GET') return next();
  const touchesMirrored = c.req.path.split('/').some((seg) => {
    let s = seg;
    try { s = decodeURIComponent(seg); } catch { }
    return isMirroredDocNo(s);
  });
  if (touchesMirrored && !houzsOwns2990(c.env)) return c.json(MIRRORED_SO_READONLY, 409);
  return next();
});

mfgSalesOrders.use('/:docNo/items/*', productChangeWindow());


async function queueAcSoEdit(
  c: any,
  docNo: string,
  retire: AcRetiredLine[] = [],
  newLineIds: string[] = [],
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

type SoCoverage = { coverage: Map<string, { source: string; po: string | null; eta: string | null }>; mrp: MrpResult | null };
export async function soCoverage(c: any, sb: unknown, savedAt: string | null = null): Promise<SoCoverage> {
  try {
    const mrp = await sharedLiveMrp(sb, c.env.DB, activeCompanyId(c), savedAt).result;
    return { coverage: mrpLineCoverage(mrp), mrp };
  } catch {
    return { coverage: new Map(), mrp: null };
  }
}

async function queueAcSoEditAfter(c: any, docNo: string, res: Response): Promise<Response> {
  if (res.ok) await queueAcSoEdit(c, docNo);
  return res;
}

const SO_PROCESSING_LOCKED_RESPONSE = {
  error: 'so_locked_processing',
  reason: 'Processing date has passed — this Sales Order is locked. (Locked orders are what we PO to the supplier.)',
} as const;

const SO_PO_LOCKED_RESPONSE = {
  error: 'so_locked_po_raised',
  reason: 'A Purchase Order has already been raised for this order — submit an amendment so purchasing can re-send it to the supplier.',
} as const;

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

export { paymentVersionGuard, soCasGrace, soCasGraceOpen } from '../lib/so-cas';
export type { PaymentVersionGuard, SoCasGraceWindow } from '../lib/so-cas';

/* 'held' is all its two callers can be in: both read a LIVE lease first. The
   three-way lives in requireSoLineWriteLease below - docs/bugs/0630. */
const SO_EDIT_LEASE_CONFLICT = soEditLeaseRefusal('held');

export { soLineWriteLeaseMatches } from '../lib/so-edit-lease';

async function requireSoLineWriteLease(sb: any, docNo: string, c: any): Promise<Response | null> {
  const supplied = c.req.header('X-SO-Edit-Lease')?.trim() ?? '';
  const { data, error } = await sb.from('mfg_sales_orders')
    .select('edit_lease_token, edit_lease_expires_at, edit_lease_user_id')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (error) return refuseWithoutWriting(c, { error: 'load_failed', reason: error.message }, 500);
  if (!data) return refuseWithoutWriting(c, { error: 'not_found' }, 404);
  if (!soLineWriteLeaseMatches(data as SoEditLeaseRow, supplied)) {
    const live = activeSoEditLease(data as SoEditLeaseRow);
    const holder = (data as { edit_lease_user_id?: number | string | null }).edit_lease_user_id;
    if (live && supplied && soEditLeaseTakeoverAllowed(holder, soCallerUserId(c))) return null;
    return refuseWithoutWriting(c, soEditLeaseRefusal(!supplied ? 'missing' : live ? 'held' : 'expired'), 409);
  }
  return null;
}

type DocumentScopedQuery = {
  eq: (column: string, value: string) => DocumentScopedQuery;
};

export function scopeSoItemToDocument<T>(
  query: T,
  docNo: string,
  itemId: string,
): T {
  return (query as T & DocumentScopedQuery)
    .eq('doc_no', docNo)
    .eq('id', itemId) as T;
}

export function soProcessingLocked(
  header: { processing_date?: string | null; status: string | null } | null | undefined,
): boolean {
  if (!header) return false;
  const proc = header.processing_date ?? null;
  if (!proc) return false;
  const procYmd = String(proc).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(procYmd)) return false;
  const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (!(procYmd < todayMY)) return false;
  const status = String(header.status ?? '').toUpperCase();
  if (!status) return false;
  return status !== 'DRAFT' && status !== 'CANCELLED';
}

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

async function soEditLocked(
  sb: any,
  docNo: string,
  header: { processing_date?: string | null; status: string | null } | null | undefined,
): Promise<boolean> {
  return soProcessingLocked(header) || await soPoLocked(sb, docNo);
}


const SO_PROCESSING_LOCK_COLS = soProcessingLockColumns();

const AMENDABLE_HEADER_FIELDS: Record<string, string> = soAmendableHeaderFields();

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

type PosCallerSource = { get(key: 'sessionOrigin'): Variables['sessionOrigin'] };

async function isPosTabletCaller(c: PosCallerSource): Promise<boolean> {
  return c.get('sessionOrigin') === SESSION_ORIGIN_POS;
}

async function isPriceOverrideCaller(c: any): Promise<boolean> {
  return hasHouzsPerm(c, 'scm.so.price_override');
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

function stripFreeItem(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'freeItem' in v) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { freeItem: _fi, ..._rest } = v as Record<string, unknown>;
    return _rest;
  }
  return v;
}

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
  const tier = (v.tier ?? v.fabricTier ?? 'PRICE_2') as SofaPriceTier;
  return { modules, height, tier };
}

const HEADER =
  'doc_no, transfer_to, so_date, branding, debtor_code, debtor_name, agent, sales_location, ref, venue, venue_id, ' +
  'address1, address2, address3, address4, phone, ' +
  'mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, service_sen, local_total_sen, balance_sen, ' +
  'mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, service_cost_sen, ' +
  'total_cost_sen, total_revenue_sen, total_margin_sen, margin_pct_basis, line_count, ' +
  'currency, status, remark2, remark3, remark4, note, sales_exemption_expiry, ' +
  'customer_id, customer_po_image_b64, customer_so_no, hub_id, hub_name, ' +
  'customer_state, customer_country, customer_delivery_date, processing_date, linked_do_doc_no, ' +
  'ship_to_address, bill_to_address, install_to_address, subtotal_sen, overdue, ' +
  'email, customer_type, salesperson_id, city, postcode, building_type, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, target_date, ' +
  'payment_method, installment_months, merchant_provider, approval_code, payment_date, deposit_sen, paid_sen, ' +
  'delivery_fee_sen, ' +
  'created_at, created_by, updated_at, ' +
  HOLD_COLUMNS;
export const SO_LIST_COLS = `${HEADER.replace(/,\s*customer_po_image_b64/, '')}, paid_total_sen, balance_sen_live`;

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
  'line_delivery_date, line_delivery_date_overridden, ' +
  'photo_urls, ' +
  'stock_status, ' +
  'allocated_batch_no, ' +
  'created_at';



export const deriveWarehouseIdFromState = async (
  sb: any,
  state: string | null | undefined,
  c: any,
): Promise<string | null> => {
  if (!state) return null;
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

export const nextDocNo = async (sb: any, c: any): Promise<string> => {
  const p = companyDocPrefix(c);
  const yymm = yymmFor();
  return mintMonthlyDocNo(sb, 'mfg_sales_orders', 'doc_no', `${p}SO-${yymm}`);
};


type SoListMoneyKpis = { revenueSen: number; outstandingSen: number; paidSen: number };

export async function soListMoneyKpis(
  sb: { from(table: string): { select(columns: string): unknown } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the dynamic aggregate `.select('...sum()')` defeats supabase-js's column-type inference (same reason as outstanding.ts /summary)
  applyMoneyFilters: (q: any) => any,
): Promise<{ data: SoListMoneyKpis | null; error: { message: string } | null }> {
  const agg = await readAggregate(() => applyMoneyFilters(
    sb
      .from('mfg_sales_orders_with_payment_totals')
      .select('rev:local_total_sen.sum(),outLive:balance_sen_live.sum(),paid:paid_total_sen.sum()'),
  ));
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
    ).order('doc_no', { ascending: true }).range(mfrom, mto),
  );
  if (fb.error) return { data: null, error: fb.error };
  let revenueSen = 0, outstandingSen = 0, paidSen = 0;
  for (const m of fb.data ?? []) {
    revenueSen += m.local_total_sen ?? 0;
    outstandingSen += m.balance_sen_live ?? (m.local_total_sen ?? 0) - (m.paid_total_sen ?? 0);
    paidSen += m.paid_total_sen ?? 0;
  }
  return { data: { revenueSen, outstandingSen, paidSen }, error: null };
}

mfgSalesOrders.get('/', async (c) => {
  const sb = c.get('supabase');

  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  if (c.req.query('summary')) {
    let sq = sb
      .from('mfg_sales_orders')
      .select('doc_no, status, local_total_sen, created_at, so_date')
      .neq('status', 'DRAFT')
      .order('so_date', { ascending: false })
      .limit(500);
    sq = applySoScope(sq, scopeIds);
    sq = scopeToCompany(sq, c);
    const { data, error } = await sq;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    return c.json({ salesOrders: data ?? [] });
  }

  const LIST_COLS = SO_LIST_COLS;

  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  let data: unknown = null;
  let error: { message: string } | null = null;
  let total = 0;
  let page = 0;
  let pageSize = 50;
  let statusCounts: Record<string, number> | undefined;
  let countError: string | null = null;
  let aggregates: { revenueSen: number; outstandingSen: number; paidSen: number } | undefined;

  if (!paginate) {
    let q = sb.from('mfg_sales_orders_with_payment_totals').select(LIST_COLS).order('so_date', { ascending: false }).limit(500);
    q = applySoScope(q, scopeIds);
    q = scopeToCompany(q, c);
    const status = effectiveStatusFilter(c.req.query('status'));
    /* A tab may cover more than one status — SHIPPED folds into DELIVERED
       (owner 2026-08-22). Read the bucket so the fold is one fact, not a
       spelling repeated at each of the three query sites below. */
    if (status === 'ON_HOLD') q = q.or(HELD_OR_TERM);
    else if (status) { const vals = soStatusesForTab(status); q = vals.length === 1 ? q.eq('status', vals[0]) : q.in('status', vals); }
    const debtor = c.req.query('debtor'); if (debtor) q = q.ilike('debtor_name', `%${debtor}%`);
    const res = await q;
    data = res.data;
    error = res.error;
  } else {
    page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
    const psRaw = Number(c.req.query('pageSize'));
    pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;
    const read = await prepareSoListRead(sb, c, readSoListParams((k) => c.req.query(k), (k) => c.req.queries(k), canViewScmFinance(c)), scopeIds, c.get('houzsUser')?.id ?? null, new Date());
    if (!read.ok) return c.json(read.body, read.status);
    let q = read.header(orderSoList(fromSoList(sb, LIST_COLS, { count: 'exact' }), c.req.query('sort') ?? null));
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);

    /* Status counts over the SAME scope + company + second-level filters, WITHOUT the status
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
    const scopedCountQ = (q0: any): any => read.scoped(q0);
    const heldProm = async (): Promise<{ ok: true; n: number } | { ok: false; reason: string }> => {
      const r = await scopedCountQ(
        sb.from(read.countFrom).select('*', { count: 'exact', head: true }),
      ).or(HELD_OR_TERM);
      if (r.error) return { ok: false, reason: `on-hold count failed: ${r.error.message}` };
      return { ok: true, n: r.count ?? 0 };
    };
    const countsProm = async (): Promise<StatusTally> => {
      const agg = await readAggregate<{ data: Array<{ status: string | null; cnt: number }> | null; error: { message: string } | null }>(() => scopedCountQ(sb.from(read.countFrom).select('status, cnt:doc_no.count()')));
      if (!agg.error) return tallyStatusRows<{ status: string | null; cnt: number }>(agg, (r) => Number(r.cnt ?? 0));
      const fb = await paginateAll<{ status: string | null }>((cfrom, cto) =>
        scopedCountQ(sb.from(read.countFrom).select('status')).order('doc_no', { ascending: true }).range(cfrom, cto));
      if (fb.error) return { ok: false, reason: `status counts failed: aggregate ${agg.error.message}; fallback ${fb.error.message}` };
      return tallyStatusRows(fb, () => 1);
    };

    const moneySkipCancelled = moneySkipsCancelled(effectiveStatusFilter(c.req.query('status')));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shared closure is applied to both the aggregate `.select('...sum()')` builder and the paged builder; the aggregate select defeats supabase-js's column-type inference (same reason as outstanding.ts /summary)
    const applyMoneyFilters = (moneyQ0: any): any => read.header(moneyQ0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same builder as applyMoneyFilters
    const moneyProm = () => soListMoneyKpis(sb, moneySkipCancelled ? (q: any) => applyMoneyFilters(q).or(NOT_CANCELLED_OR) : applyMoneyFilters);
    const kpiProm = soListKpisSql(c.env, read, moneySkipCancelled).then(async (s) => (s
      ? [s.counted, { data: s.money, error: null }, s.held] as const
      : Promise.all([countsProm(), moneyProm(), heldProm()])));

    const [res, [counted, moneyRes, heldCount]] = await Promise.all([q, kpiProm]);
    data = res.data;
    error = res.error;
    total = res.count ?? (res.data?.length ?? 0);
    if (error && isRangeNotSatisfiable(error)) {
      data = [];
      error = null;
      const head = res.count == null ? await read.header(fromSoList(sb, 'doc_no', { count: 'exact', head: true })) : null;
      if (head?.error) error = head.error;
      total = res.count ?? head?.count ?? 0;
    }
    if (!counted.ok) countError = counted.reason;
    else {
      const allCount = Object.values(counted.byStatus).reduce((s, n) => s + n, 0);
      let known = 0;
      statusCounts = { all: allCount };
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

  const rows = (data ?? []) as Array<{ doc_no?: string } & Record<string, unknown>>;
  const prior = await buildSoListRows(sb, c, rows);
  if (paginate) {
    const withLines = await attachSoLines(sb, c, rows, prior);
    if (withLines.error) return c.json({ error: 'lines_read_failed', reason: withLines.error }, 500);
  }

  if (paginate) return c.json({ salesOrders: rows, total, page, pageSize, statusCounts, aggregates });
  return c.json({ salesOrders: rows });
});

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
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  const viaSql = await soCustomerRowsSql<CustomerSoRow>(c.env, (q) => scopeToCompany(applySoScope(q, scopeIds), c));
  const { data, error } = viaSql ? { data: viaSql, error: null } : await paginateAll<CustomerSoRow>((from, to) => {
    let q = sb
      .from('mfg_sales_orders')
      .select(SO_CUSTOMER_COLS)
      .order('so_date', { ascending: false });
    q = applySoScope(q, scopeIds);
    q = scopeToCompany(q, c);
    return q.range(from, to);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const map = new Map<string, CustomerEntry>();
  for (const o of (data ?? [])) {
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

registerMineRoutes(mfgSalesOrders);

registerSlipRoutes(mfgSalesOrders);

registerCrossCategoryRoutes(mfgSalesOrders);

/* The money on a cancelled order — refund or convert (docs/bugs/0927); handlers in so-money-routes.ts. */
mfgSalesOrders.get('/cancelled-with-money', cancelledWithMoneyHandler);
mfgSalesOrders.get('/with-money', ordersWithMoneyHandler);
const guarded = (h: (c: any) => Promise<Response>) => async (c: any) => ((await selfScopedSalesBlocked(c, c.req.param('docNo'))) ? c.json({ error: 'not_found' }, 404) : h(c));
mfgSalesOrders.get('/:docNo/money', guarded(soMoneyHandler));
mfgSalesOrders.post('/:docNo/money/refund', guarded(soMoneyRefundHandler));
mfgSalesOrders.get('/:docNo/convert-sources', guarded(soConvertSourcesHandler));
mfgSalesOrders.get('/customer-search', async (c) => {
  const sb = c.get('supabase');
  const q = (c.req.query('name') ?? '').trim();
  if (q.length < 2) return c.json({ customers: [] });
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
  const byKey = new Map<string, Record<string, unknown>>();
  const FILL_FIELDS = [
    ['email', 'email'], ['customerType', 'customer_type'],
    ['address1', 'address1'], ['address2', 'address2'], ['city', 'city'],
    ['postcode', 'postcode'], ['customerState', 'customer_state'],
    ['buildingType', 'building_type'],
    ['race', 'customer_race'], ['birthday', 'customer_birthday'], ['gender', 'customer_gender'],
  ] as const;
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

mfgSalesOrders.get('/:docNo', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('mfg_sales_orders').select(`${HEADER}, amend_date_from_customer, amended_delivery_date, amend_reason, revision, signature_b64, slip_key, slip_state, slip_image_key, receipt_image_key, version, linked_ac_docno, collaborator_staff_ids, access_staff_ids, open_to_all, project_id, fair_match, fair_date`).eq('doc_no', docNo), c).maybeSingle(),
    sb.from('mfg_sales_order_items').select(ITEM).eq('doc_no', docNo)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  if (i.error) return c.json(readFailure('so_lines', i.error), 500);
  {
    const d = h.data as { salesperson_id?: number | string | null; access_staff_ids?: string[] | null; open_to_all?: boolean | null };
    if (await soDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), { salespersonId: d.salesperson_id, accessStaffIds: d.access_staff_ids, openToAll: d.open_to_all })) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  const [{ count: doCount }, { count: siCount }, freezeRes] = await Promise.all([
    sb.from('delivery_orders')
      .select('id', { head: true, count: 'exact' })
      .eq('so_doc_no', docNo)
      .neq('status', 'CANCELLED'),
    sb.from('sales_invoices')
      .select('id', { head: true, count: 'exact' })
      .eq('so_doc_no', docNo)
      .neq('status', 'CANCELLED'),
    readSoLineFreeze(sb, docNo),
  ]);
  const fullyFrozen = freezeRes.ok ? freezeRes.fullyFrozen : (doCount ?? 0) > 0 || (siCount ?? 0) > 0;
  const debtorCode = (h.data as { debtor_code?: string | null }).debtor_code ?? null;
  const customerCreditSen = debtorCode ? await getCustomerCreditBalance(sb, debtorCode, activeCompanyId(c) ?? null) : 0;
  let paidLedgerSen = 0;
  let depositInLedger = false;
  {
    const { data: payRows, error: payErr } = await sb
      .from('mfg_sales_order_payments')
      .select('amount_sen, is_deposit')
      .eq('so_doc_no', docNo);
    if (payErr) return c.json(readFailure('so_payments', payErr), 500);
    for (const p of payRows as Array<{ amount_sen: number; is_deposit?: boolean | null }>) {
      paidLedgerSen += p.amount_sen ?? 0;
      if (p.is_deposit) depositInLedger = true;
    }
  }
  const paidInputs = soPaidInputsOf(h.data as Record<string, unknown>, paidLedgerSen, depositInLedger);
  const paidSenTotal = soPaidSen(paidInputs);
  const amendDateLocked = soProcessingLocked(
    h.data as { processing_date?: string | null; status: string | null },
  );
  /* Owner 2026-08-12 — the PO lock feeds the SAME flag, so an SO with a live
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
  const amendHardLocked = fullyFrozen; // a partly delivered order can still amend its unfrozen lines (owner 2026-09-15)
  const amendSoStatus = String((h.data as { status?: string | null }).status ?? '').toUpperCase();
  const amendTerminalStatus = ['SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED'].includes(amendSoStatus);
  const amendmentEligible = amendProcessingLocked && !amendHardLocked && !amendTerminalStatus;
  type OpenAmendment = { id: string; status: string; amendment_no: string; lane: string | null };
  let openAmendments: OpenAmendment[] = [];
  {
    const { data: amRows, error: amErr } = await scopeToCompany(sb
      .from('so_amendments')
      .select('id, status, amendment_no, lane')
      .eq('so_doc_no', docNo), c)
      .not('status', 'in', '("SENT","REJECTED")')
      .or('lane.is.null,status.eq.REQUESTED')
      .order('created_at', { ascending: false })
      .limit(4);
    if (amErr) return c.json(readFailure('so_amendments', amErr), 500);
    openAmendments = (amRows as Array<Record<string, unknown>>)
      .map((am) => ({
        id: String(am.id ?? ''),
        status: String(am.status ?? ''),
        amendment_no: String((am.amendment_no ?? (am as Record<string, unknown>).amendmentNo) ?? ''),
        lane: am.lane == null ? null : String(am.lane),
      }));
  }
  const openAmendment = openAmendments[0] ?? null;
  const processingDatePoLocked = amendPoLocked
    || (soDateYmd((h.data as { processing_date?: unknown }).processing_date) != null && await soHasLivePo(sb, docNo));
  const afterDoCo = activeCompanyId(c);
  const afterDoRead = (doCount ?? 0) > 0 && afterDoCo != null ? await readAfterDoTargets(sb, docNo, afterDoCo) : null;
  const salesOrder = {
    ...(h.data as unknown as Record<string, unknown>),
    has_children: (doCount ?? 0) > 0 || (siCount ?? 0) > 0,
    downstream_fully_frozen: fullyFrozen,
    after_do_targets: afterDoRead ? (afterDoRead.ok ? afterDoRead.targets : null) : [],
    after_do_invoiced: afterDoRead?.ok ? afterDoRead.invoicedWithoutDo : false,
    amendment_eligible: amendmentEligible,
    /* The PO half of the soft lock, as its own fact — so-detail-gates.procLockActive
       ORs it with its date test (owner 2026-08-12). NOT folded into
       amendment_eligible: that flag is already false for a hard-locked / terminal
       SO, and the editors must stay disabled in exactly those cases. */
    po_locked: amendPoLocked,
    processing_date_po_locked: processingDatePoLocked,
    has_open_amendment: openAmendment != null,
    open_amendment: openAmendment,
    open_amendments: openAmendments,
    customer_credit_sen: customerCreditSen,
    paid_sen_total: paidSenTotal,
    paid_outside_ledger_sen: paidSenTotal - paidLedgerSen,
    /* SIGNED (owner 2026-08-16) — negative = over-collected, painted red by the
       detail page, the mobile detail and the SO print. The write-back keeps the
       CLAMPED `soOutstandingSen`: a screen can say "you hold RM 250 of his
       money", AutoCount's UDF_BALANCE cannot. Same inputs, two audiences. */
    balance_sen: soBalanceSen(paidInputs),
    /* The event the order is linked to, so a recorded pick reads back as venue,
       organizer and dates (owner 2026-09-24). Null = show the venue alone. */
    fair: await loadLinkedFair(c.env.DB as unknown as FairDb, activeCompanySql(c, 'p.company_id'), (h.data as { project_id?: unknown }).project_id),
  };
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
      } catch { }
    }
    (salesOrder as Record<string, unknown>).salesperson_name = spName;
    (salesOrder as Record<string, unknown>).salesperson_phone = spPhone;
  }
  const itemRows = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      i.data as unknown as Array<Record<string, unknown> & { id: string; item_code: string; qty?: number | null }>,
      (r) => r.item_group as string | null | undefined,
    ),
  );
  {
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
  const [remainingMap, deliveriesMap, shippedTraceMap, nonSellingWh, boundPoMap] = await Promise.all([
    soDeliverableRemaining(sb, [docNo]),
    soLineDeliveries(sb, itemRows.map((it) => it.id)),
    soLineShippedSources(sb, itemRows.map((it) => it.id)),
    // Owner ruling 2026-09-08: a 16-row read, alongside the three above so the
    // detail's critical path costs no extra round trip.
    loadNonSellingWarehouses(sb),
    /* Owner 2026-09-22: the line's OWN incoming PO (the PO raised against this
       so_item), so the "Incoming PO" chip names this order's PO, not the PO whose
       FIFO batch its goods happened to ship from (another order's PO on shared
       stock). Same cheap batched link, scoped to the company. */
    soLineBoundPoNumbers(sb, itemRows.map((it) => it.id), activeCompanyId(c) ?? null),
  ]);
  const orderProcessed = !!(h.data as { processing_date?: string | null }).processing_date;
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
      downstream_frozen: freezeRes.ok ? soLineFrozen(freezeRes.freeze, it.id) : true,
      deliveries,
      delivered_qty: rem?.delivered ?? deliveredQty,
      remaining_qty: rem?.remaining ?? Number(it.qty ?? 0),
      stock_state: stockState,
      ...soLineStockVerdict(it as SoLineStockVerdictRow, null, orderProcessed, nonSellingWh),
      coverage_po: null,
      coverage_eta: null,
      shipped_source_pos: shippedPos,
      shipped_source_adj: (shippedTrace?.adjQty ?? 0) > 0,
      ready_source_pos: [],
      bound_source_pos: boundPoMap.get(it.id)?.pos ?? [],
      bound_source_po_etas: boundPoMap.get(it.id)?.etas ?? {},
    };
  });
  const totalDelivered = items.reduce((s, it) => s + Number(it.delivered_qty ?? 0), 0);
  const totalRemaining = items.reduce((s, it) => s + Number(it.remaining_qty ?? 0), 0);
  (salesOrder as Record<string, unknown>).delivery_state =
    totalDelivered <= 0 ? 'none' : totalRemaining > 0 ? 'partial' : 'full';
  (salesOrder as Record<string, unknown>).shipped_qty = totalDelivered;
  (salesOrder as Record<string, unknown>).deliverable_qty = totalDelivered + totalRemaining;
  const [lifecycleByDoc, currentByDoc] = await Promise.all([
    computeSoLifecycle(sb, [docNo]),
    soCurrentDocNo(sb, [docNo]),
  ]);
  (salesOrder as Record<string, unknown>).lifecycle_state = lifecycleByDoc.get(docNo) ?? 'none';
  (salesOrder as Record<string, unknown>).current_doc_no = currentByDoc.get(docNo) ?? (docNo || null);
  let pwpCodes: Array<Record<string, unknown>> = [];
  try {
    const { data: codeRows } = await sb
      .from('pwp_codes')
      .select('code, status, trigger_item_code, redeemed_doc_no, cart_line_key')
      .eq('source_doc_no', docNo)
      .order('created_at', { ascending: true });
    pwpCodes = (codeRows ?? []) as Array<Record<string, unknown>>;
  } catch {
    pwpCodes = [];
  }
  gateSoFinance(c, salesOrder, items);
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ salesOrder: await withSoMigratedReadonly(c, salesOrder as Record<string, unknown>, (h.data as { linked_ac_docno?: string | null }).linked_ac_docno ?? null), items, pwpCodes });
});


mfgSalesOrders.get('/:docNo/items', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('mfg_sales_orders').select('doc_no, salesperson_id, access_staff_ids, processing_date, open_to_all, updated_at').eq('doc_no', docNo), c).maybeSingle(),
    sb.from('mfg_sales_order_items').select(ITEM).eq('doc_no', docNo)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  if (i.error) return c.json(readFailure('so_lines', i.error), 500);
  {
    const d = h.data as { salesperson_id?: number | string | null; access_staff_ids?: string[] | null; open_to_all?: boolean | null };
    if (await soDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), { salespersonId: d.salesperson_id, accessStaffIds: d.access_staff_ids, openToAll: d.open_to_all })) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  const itemRows = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      i.data as unknown as Array<Record<string, unknown> & { id: string; item_code: string; qty?: number | null }>,
      (r) => r.item_group as string | null | undefined,
    ),
  );
  const [remainingMap, deliveriesMap, shippedTraceMap, cov, nonSellingWh, freezeRes] = await Promise.all([
    soDeliverableRemaining(sb, [docNo]),
    soLineDeliveries(sb, itemRows.map((it) => it.id)),
    soLineShippedSources(sb, itemRows.map((it) => it.id)),
    soCoverage(c, sb, (h.data as { updated_at?: string | null } | null)?.updated_at ?? null),
    // Where the live-'stock' promotion fires, so it must know which
    // warehouses may not promise (owner ruling 2026-09-08).
    loadNonSellingWarehouses(sb),
    readSoLineFreeze(sb, docNo),
  ]);
  const coverageMap = cov.coverage;
  const readyPosMap = await soLineReadySourcePos(sb, activeCompanyId(c) ?? null, cov.mrp, itemRows as Array<{ id: string; item_group?: string | null; qty?: number | null; stock_status?: string | null; allocated_batch_no?: string | null }>);
  // Owner 2026-09-22: the line's OWN incoming PO — see the /:docNo detail note.
  const boundPoMap = await soLineBoundPoNumbers(sb, itemRows.map((it) => it.id), activeCompanyId(c) ?? null);
  const orderProcessed = !!(h.data as { processing_date?: string | null }).processing_date;
  const items = itemRows.map((it) => {
    const rem = remainingMap.get(it.id);
    const deliveries = deliveriesMap.get(it.id) ?? [];
    const deliveredQty = deliveries.reduce((s, d) => s + d.qty, 0);
    const cov = coverageMap.get(it.id);
    const covered = cov?.source === 'po';
    const shippedTrace = shippedTraceMap.get(it.id);
    const shippedPos = shippedTrace?.pos ?? [];
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
      downstream_frozen: freezeRes.ok ? soLineFrozen(freezeRes.freeze, it.id) : true,
      deliveries,
      delivered_qty: rem?.delivered ?? deliveredQty,
      remaining_qty: rem?.remaining ?? Number(it.qty ?? 0),
      stock_state: stockState,
      ...soLineStockVerdict(it as SoLineStockVerdictRow, stockState as LiveStockState, orderProcessed, nonSellingWh),
      coverage_po: covered ? cov?.po ?? null : null,
      coverage_eta: covered ? cov?.eta ?? null : null,
      shipped_source_pos: shippedPos,
      shipped_source_adj: (shippedTrace?.adjQty ?? 0) > 0,
      ready_source_pos: readyPosMap.get(it.id) ?? [],
      bound_source_pos: boundPoMap.get(it.id)?.pos ?? [],
      bound_source_po_etas: boundPoMap.get(it.id)?.etas ?? {},
    };
  });
  gateSoFinance(c, null, items);
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ items });
});

registerCustomerCreditRoutes(mfgSalesOrders);

const SO_DROPDOWN_FIELDS: Array<{ bodyKey: string; category: string }> = [
  { bodyKey: 'customerType',                 category: 'customer_type' },
  { bodyKey: 'buildingType',                 category: 'building_type' },
  { bodyKey: 'emergencyContactRelationship', category: 'relationship' },
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same loose sb
async function validateSoDropdownFields(
  sb: any,
  body: Record<string, unknown>,
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
  if (error || !data || data.length === 0) return null;
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

export type SoCreateOutcome = { status: number; body: Record<string, unknown>; noWrite?: true };
export type SoCreateContext = {
  req: { json(): Promise<unknown> };
  get(key: 'supabase'): Variables['supabase'];
  get(key: 'user'): { id: string; user_metadata?: unknown };
  get(key: 'houzsUser'): Variables['houzsUser'];
  get(key: 'sessionOrigin'): string | undefined;
  get(key: 'companyId'): number | undefined;
  /* Active company CODE ('HOUZS' | '2990') — picks the Processing-Date deposit
     threshold (owner 2026-07-31: Houzs 30%, 2990 50%). Undefined on the headless
     scan path, which captured only the company ID at enqueue; harmless, because
     that path creates DRAFTS with processing_date = null and the deposit
     gate only runs when a Processing Date is actually being set. */
  get(key: 'companyCode'): string | undefined;
  env: Env;
  json(body: unknown, status?: number): SoCreateOutcome;
  auditSource?: string;
  auditNote?: string;
};

async function createSalesOrderCore(c: SoCreateContext): Promise<SoCreateOutcome> {
  let wrote = false;
  const lap = stepClock();
  const answer = c.json;
  c = { ...c, json: (b, s) => (wrote ? answer(b, s) : { ...answer(b, s), noWrite: true }) };
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const companyId = c.get('companyId');
  const stampCo = <T extends Record<string, unknown>>(rows: T[]): Array<T & { company_id?: number }> =>
    companyId != null ? rows.map((r) => ({ company_id: companyId, ...r })) : rows;
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
    const createPairRefusal = soDatePairRefusal({
      nextProc: procDate, nextDeliv: delivDate, origProc: null, origDeliv: null,
    });
    if (createPairRefusal) return c.json(createPairRefusal, 400);
    const createLineDateRefusal = soLineDateRefusal({
      processingDate: procDate, lineDeliveryDates: items.map((it) => it.lineDeliveryDate),
    });
    if (createLineDateRefusal) return c.json(createLineDateRefusal, 400);
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
    const mainMix = await createMixRefusal(sb, items, companyId);
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  let docNo = await nextDocNo(sb, c);

  const callerStaffId = await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id);
  const canAttributeOther = hasHouzsPerm(c, 'scm.so.attribute_other');
  if (!callerStaffId && !canAttributeOther) {
    return c.json({
      error: 'staff_unlinked',
      message:
        'We could not confirm who this order belongs to — please try again, and if it keeps happening ask IT to link your account to a sales profile.',
    }, 409);
  }
  const callerStaffRes = callerStaffId
    ? await sb.from('staff').select('role, venue_id, showroom_warehouse_id').eq('id', callerStaffId).maybeSingle()
    : null;
  const callerStaff = callerStaffRes?.data ?? null;
  const salespersonIdToStamp = canAttributeOther
    ? ((body.salespersonId as string) ?? callerStaffId ?? null)
    : callerStaffId;
  const stampStaff = await readStaffForStamp(sb as never, salespersonIdToStamp);
  const agentToStamp = soAgentToStamp(body.agent, stampStaff?.name ?? null);
  /* A SCAN is written with no venue, no fair and no fair day (owner 2026-11-12):
     none of the defaults below run for it, and a person picks all three on the
     draft before Confirm (fair-binding.ts::fairConfirmProblems). */
  const scanCreate = isScanCreate(c.auditSource, body);
  let venueIdToStamp: string | null = scanCreate ? null : ((body.venueId as string | null | undefined) ?? null);
  if (!scanCreate && !venueIdToStamp && salespersonIdToStamp) {
    venueIdToStamp = salespersonIdToStamp === callerStaffId
      ? ((callerStaff?.venue_id as string | null) ?? null)
      : (stampStaff?.venueId ?? null);
  }
  if (!scanCreate && !venueIdToStamp) {
    if (callerStaff && callerStaff.venue_id &&
        ['sales', 'sales_executive', 'outlet_manager'].includes(callerStaff.role)) {
      venueIdToStamp = callerStaff.venue_id as string;
    }
  }

  let resolvedVenueName: string | null =
    !scanCreate && typeof body.venue === 'string' && body.venue.trim() ? body.venue.trim() : null;
  let venueSource: VenueSource | null = resolvedVenueName ? 'MANUAL' : null;
  if (!resolvedVenueName && venueIdToStamp) {
    const { data: venueRow } = await sb
      .from('venues').select('name').eq('id', venueIdToStamp).maybeSingle();
    resolvedVenueName = (venueRow as { name?: string } | null)?.name ?? null;
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
  const soDateForVenue =
    typeof body.soDate === 'string' && body.soDate.trim()
      ? body.soDate.trim().slice(0, 10)
      : todayMyt();
  const autoBind = await bindVenueOnCreate({
    db: c.env.DB, sb: sb as unknown as VenueBindingSb,
    userId: c.get('houzsUser')?.id != null ? Number(c.get('houzsUser')?.id) : NaN,
    staffId: salespersonIdToStamp ?? callerStaffId,
    soDate: soDateForVenue,
  });
  let projectIdToStamp: number | null = scanCreate ? null : autoBind.projectId;
  if (!scanCreate && !resolvedVenueName && autoBind.venueName) {
    resolvedVenueName = autoBind.venueName;
    venueSource = autoBind.source;
  }
  let effectiveBrand: string | null = clientHeaderBranding(body.branding);

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
    /* ...and a fair or No fair (owner 2026-10-19), worded by why the keyer got
       none — the rule the form asks through /validate. Never the POS. */
    const fairProblem = (await isPosTabletCaller(c)) ? null : await fairRequiredProblem({
      companyCode: c.get('companyCode'), body, db: c.env.DB as unknown as FairDb,
      companySql: activeCompanySql(c, 'p.company_id'), keyerId: Number(c.get('houzsUser')?.id ?? NaN), orderDate: soDateForVenue,
    });
    if (fairProblem) confirmProblems.push(fairProblem);
    /* ...and a transport fee for Sabah / Sarawak / Labuan / Kelantan / Terengganu / Perlis /
       Singapore (owner 2026-11-11). The POS handover's applyDeliveryFee builds
       its fee lines after the insert, so that create is not judged here. */
    if (!body.applyDeliveryFee) {
      const createState = (body.customerState as string | null | undefined) ?? null;
      const createCountry = typeof body.customerCountry === 'string' && body.customerCountry.trim()
        ? body.customerCountry : await deriveCountryFromState(sb, createState);
      const feeProblem = transportFeeProblem(c.get('companyCode') ?? null, createState, createCountry, items.map((it) => ({
        itemCode: (it.itemCode as string | null | undefined) ?? null,
        description: (it.description as string | null | undefined) ?? null,
        itemGroup: (it.itemGroup as string | null | undefined) ?? null,
        amountSen: Number(it.qty ?? 1) * Number(it.unitPriceSen ?? 0) - Number(it.discountSen ?? 0),
      })));
      if (feeProblem) confirmProblems.push(feeProblem);
    }
    if (confirmProblems.length > 0) return c.json(validationFailedBody(confirmProblems), 422);
  }

  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  const headerDeliveryDate = dateOrNull(body.customerDeliveryDate);
  /* HC-0006 speed: these eight reads don't depend on each other, so they run
     together (one round trip instead of eight in a row). None of them throws —
     each returns its failure as data — so every refusal below still comes out
     exactly as before. loadSellingSofaCombos CAN throw, so it stays awaited in its
     old place, after the allowed-options refusal. */
  const itemCodes = items.map((it) => String(it?.itemCode ?? ''));
  const [
    cachedConfig,
    cachedSpecialAddons,
    { byCode: pmByCode, lookupError: pmErr },
    cachedFabricAddonConfig,
    cachedModelOverrides,
    cachedCompartmentOverrides,
    dropdownErr,
    productRowByCode,
  ] = await Promise.all([
    loadMaintenanceConfig(sb, companyId),
    loadSpecialAddons(sb, companyId),
    loadProductsAndModels(sb, itemCodes, companyId),
    loadFabricTierAddonConfig(sb, companyId),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
    validateSoDropdownFields(sb, body, companyId),
    loadProductsByCodes(sb, itemCodes, companyId),
  ]);
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
  const cachedCombos = await loadSellingSofaCombos(sb, c);

  if (dropdownErr) return c.json(dropdownErr, 409);

  const lineProducts = items.map((it) => productRowByCode.get(String(it.itemCode ?? '').trim()) ?? null);
  const accessoryOrder = validateSofaAccessoryOrder(items, lineProducts);
  if (!accessoryOrder.ok) return c.json({ error: 'sofa_accessories_invalid', reason: accessoryOrder.reason }, 400);
  /* Owner 2026-06-03 (migration 0144) — resolve the REAL customer identity
     (find-or-create by name + phone) and stamp it on the SO. Phone is validated
     above so the key is always complete. Best-effort: an unexpected RPC error
     must not block a paying customer at the counter, so we log it and fall back
     to null (a Phase 2 backfill can repair it). The resolved id flows into the
     SO header (customer_id), the cross-category "same customer" match, and the
     PWP voucher binding below — all of which previously saw a permanently-null
     customer_id (the POS never sent one). */
  let orderCustomerId: string | null = null;
  const casCo = requireActiveCompanyId(c); if (!casCo.ok) return c.json(casCo.refusal, 409);
  wrote = true;
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
  const pwpBaseByIdx = new Map<number, number>();
  const pwpSofaByIdx = new Map<number, string[]>();
  const freeGiftBaseByIdx = new Map<number, number>();
  const freeItemByIdx = new Map<number, { campaignId: string; campaignName: string }>();
  const claimedPwpCodes: Array<{ code: string; prevStatus: string }> = [];
  const pwpRejections: Array<{ idx: number; itemCode: string; code: string; reason: string }> = [];
  const seenPwpCodes = new Set<string>();
  const allPwpCodes = Array.from(new Set(
    items
      .map((it) => String((it?.variants as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim())
      .filter(Boolean),
  ));
  const pwpCompanyId = activeCompanyId(c);
  if (allPwpCodes.length > 0 && pwpCompanyId == null) return c.json({ error: 'company_unresolved', message: 'Cannot tell which company this order belongs to right now. Reload and try again.' }, 409);
  const pwpRowByCode = new Map<string, Record<string, any>>();
  let pwpPrefetchFailed = false;
  if (allPwpCodes.length > 0) {
    const { data: codeRows, error: codeReadErr } = await pgrestIn(sb
      .from('pwp_codes')
      .select('code, status, owner_staff_id, reward_category, eligible_reward_model_ids, reward_combo_ids, reward_size_codes, reward_compartments, customer_id, source_doc_no, redeemed_doc_no, type'), 'code', allPwpCodes).eq('company_id', pwpCompanyId);
    if (codeReadErr) {
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
    if (companyId == null) { reject('cannot tell which company this order belongs to — reload and try again'); continue; }
    const pwpCompanyId: number = companyId;
    if (seenPwpCodes.has(code)) { reject('code is already applied to another line on this order'); continue; }
    seenPwpCodes.add(code);
    if (Number(it?.qty ?? 1) !== 1) { reject('a PWP reward line must be quantity 1'); continue; }
    const product = lineProducts[idx];
    if (!product) { reject('unknown item code'); continue; }
    if (pwpPrefetchFailed) { reject('could not verify the code — please try again'); continue; }
    const cRow = pwpRowByCode.get(code) ?? null;
    if (!cRow) { reject('code not found — it may have been replaced; re-apply PWP on this line'); continue; }
    const redeemable =
      cRow.status === 'AVAILABLE' ||
      (cRow.status === 'RESERVED' && callerStaffId != null && cRow.owner_staff_id === callerStaffId);
    let orphanedUsed = false;
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
    if (cRow.status === 'AVAILABLE' && cRow.customer_id && orderCustomerId && cRow.customer_id !== orderCustomerId) {
      reject('code belongs to a different customer');
      continue;
    }

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
      const rewardCells = ((it?.variants as { cells?: Array<{ id?: unknown }> } | null)?.cells ?? []);
      if (!candidate.some((c) => matchComboBuild({
        modules: built, cellIds: rewardCells.map((cell) => String(cell.id ?? '')),
        accessories: accessoryOrder.context.parents.get(idx) ?? [],
      }, c) != null)) {
        reject("sofa build doesn't match the voucher's reward combo");
        continue;
      }
      if (!passesRefinementColumns(
        { category: 'SOFA', modelId: product.model_id ?? null, sizeCode: null, builtCompartments: built },
        (cRow.reward_size_codes as string[] | null) ?? null,
        (cRow.reward_compartments as string[] | null) ?? null,
      )) { reject("sofa build doesn't match the voucher's reward compartment"); continue; }
      grantSofaComboIds = rewardComboIds;
    } else {
      const pwpPrice = Math.round(Number(product.pwp_price_sen ?? 0));
      const isPromo = String(cRow.type ?? 'pwp') === 'promo';
      if (!isPromo && !(pwpPrice > 0)) { reject('this SKU has no PWP price set (SKU Master)'); continue; }
      const elig = (cRow.eligible_reward_model_ids as string[] | null) ?? [];
      const modelOk = elig.length === 0 || (product.model_id != null && elig.includes(product.model_id));
      if (!modelOk) { reject('code is not valid for this model'); continue; }
      if (!passesRefinementColumns(
        { category: prodCat, modelId: product.model_id ?? null, sizeCode: product.size_code ? String(product.size_code).toUpperCase() : null, builtCompartments: [] },
        (cRow.reward_size_codes as string[] | null) ?? null,
        (cRow.reward_compartments as string[] | null) ?? null,
      )) { reject('code is not valid for this size'); continue; }
      grantPwpPrice = pwpPrice;
    }

    let claimQ = sb
      .from('pwp_codes')
      .update({
        status:             'USED',
        source_doc_no:      cRow.source_doc_no ?? docNo,
        redeemed_doc_no:    docNo,
        redeemed_item_code: product.code,
        updated_at:         new Date().toISOString(),
      })
      .eq('code', code).eq('company_id', pwpCompanyId);
    claimQ = orphanedUsed
      ? claimQ.eq('status', 'USED').eq('redeemed_doc_no', cRow.redeemed_doc_no)
      : claimQ.in('status', ['RESERVED', 'AVAILABLE']);
    const { data: claimed } = await claimQ.select('code').maybeSingle();
    if (!claimed) { reject('code was just claimed by another order — try again'); continue; }
    const prevStatus = orphanedUsed
      ? (cRow.owner_staff_id ? 'RESERVED' : 'AVAILABLE')
      : cRow.status;
    claimedPwpCodes.push({ code, prevStatus });
    if (grantSofaComboIds) pwpSofaByIdx.set(idx, grantSofaComboIds);
    else pwpBaseByIdx.set(idx, grantPwpPrice);
  }
  const rollbackPwpClaims = async () => {
    for (const { code, prevStatus } of claimedPwpCodes) {
      const patch: Record<string, unknown> = {
        status: prevStatus, redeemed_doc_no: null, redeemed_item_code: null,
        updated_at: new Date().toISOString(),
      };
      if (prevStatus === 'RESERVED') patch.source_doc_no = null;
      await sb.from('pwp_codes').update(patch)
        .eq('code', code).eq('status', 'USED').eq('company_id', pwpCompanyId);
    }
  };

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

  {
    const modelGiftsById = await loadModelDefaultGifts(sb);

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

  {
    const activeCampaigns = await loadActiveFreeItemCampaigns(sb);
    const comboModulesById = new Map<string, string[][]>(
      cachedCombos.map((cb) => [cb.id, cb.accessories?.length ? [] : cb.modules]),
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
      if (!it) continue;
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

  const sofaModulePricesByIdx = new Map<number, Record<string, number> | null>();
  const hasDeclaredExtra = items.some((it) =>
    Number((it.variants as { extraAddonAmountRM?: unknown } | null)?.extraAddonAmountRM ?? 0) > 0);
  let autoSkuEnabled = false;
  if (hasDeclaredExtra) {
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
    autoSkuEnabled = flags.get('pos_remark_extra_auto_sku') === true;
  }

  const fabricRowByCode = await loadFabricsByCodes(
    sb, items.map((it) => (it.variants as { fabricCode?: string } | null)?.fabricCode ?? null));
  const sellingTiersByFabricId = await loadFabricSellingTiersByIds(
    sb, items.map((it) => (it.variants as { fabricId?: string } | null)?.fabricId ?? null));
  const sofaModulePricesMemo = new Map<string, Promise<Record<string, number> | null>>();
  const sofaModuleCostRowsMemo = new Map<string, Promise<SofaModuleCostRowLite[] | null>>();
  const createPosTablet = await isPosTabletCaller(c);
  const recomputes: Array<RecomputedLine | null> = await Promise.all(items.map(async (it, idx) => {
    const itemCode = String(it.itemCode ?? '');
    if (!itemCode) return null;
    const product = lineProducts[idx] ?? null;
    const fabricCode = ((it.variants as { fabricCode?: string } | null)?.fabricCode ?? '').trim();
    const fabricId = ((it.variants as { fabricId?: string } | null)?.fabricId ?? '').trim();
    const fabric = fabricCode ? (fabricRowByCode.get(fabricCode) ?? null) : null;
    const sellingTiers = fabricId ? (sellingTiersByFabricId.get(fabricId) ?? null) : null;
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
      sofaAccessories: accessoryOrder.context.parents.get(idx) ?? [],
    };
    const pwpBaseSen = pwpBaseByIdx.get(idx) ?? freeGiftBaseByIdx.get(idx) ?? null;
    const pwpSofaComboIds = pwpSofaByIdx.get(idx) ?? null;
    return recomputeFromSnapshot(draft, product, fabric, cachedConfig, cachedCombos, sofaModulePrices, sellingTiers, cachedFabricAddonConfig, pwpBaseSen, pwpSofaComboIds, cachedSpecialAddons, sofaModuleCostRows, cachedModelOverrides, cachedCompartmentOverrides, erpLineTrust(createPosTablet, Number(it.unitPriceSen ?? 0), it.zeroPriceIntended, false));
  }));
  for (const [idx, rewardIds] of pwpSofaByIdx) {
    if (!(recomputes[idx]?.sofaComboIds ?? []).some((id) => rewardIds.includes(id))) {
      await rollbackPwpClaims();
      return c.json({ error: 'pwp_code_rejected', reason: 'The selected sofa combo is outside this voucher. Remove or reselect the voucher before confirming.', lineIdx: idx }, 409);
    }
  }
  const accessoryInclusionError = applySofaAccessoryInclusions(items, recomputes, accessoryOrder.context);
  if (accessoryInclusionError) {
    await rollbackPwpClaims();
    return c.json({ error: 'sofa_accessories_invalid', reason: accessoryInclusionError }, 400);
  }
  void extractSofaComboLookupArgs;

  /* Pricing trust boundary (Owner 2026-05-31, see isPosTabletCaller). Only the
     untrusted POS tablet roles are drift-rejected; a Backend / office author
     sets the selling price freely (the owner ruled it varies per order). */
  const posTablet = await isPosTabletCaller(c);
  if (posTablet) {
    for (let i = 0; i < recomputes.length; i++) {
      const r = recomputes[i];
      if (r && r.drift && !freeItemByIdx.has(i)) {
        await rollbackPwpClaims();
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
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const r = recomputes[i];
    const qtyI = Number(it.qty ?? 1);
    const unitI = freeItemByIdx.has(i) ? 0 : (r ? r.unit_price_sen : Number(it.unitPriceSen ?? 0));
    const discI = Number(it.discountSen ?? 0);
    if (!Number.isFinite(discI) || discI < 0 || discI > qtyI * unitI) {
      await rollbackPwpClaims();
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

  const oneShotReqs: OneShotMintReq[] = [];
  const pwpLeadRowByCartKey = new Map<string, { item_code?: unknown }>();
  const extraRMof = (it: { variants?: unknown }) =>
    Math.max(0, Math.round(Number((it.variants as { extraAddonAmountRM?: unknown } | null)?.extraAddonAmountRM ?? 0)));
  const remarkTextOf = (it: { variants?: unknown }) => {
    const r = (it.variants as { remark?: unknown } | null)?.remark;
    return typeof r === 'string' ? r.trim() : '';
  };
  const catOf = (g: string): 'SOFA' | 'BEDFRAME' | 'MATTRESS' | 'ACCESSORY' =>
    g.includes('sofa') ? 'SOFA' : g.includes('bedframe') ? 'BEDFRAME' : g.includes('mattress') ? 'MATTRESS' : 'ACCESSORY';

  const sizeSkuMap = await loadSizeSkuMap(sb, items.map((it) => String(it.itemCode ?? '')), c);

  const itemRows = await Promise.all(items.map(async (it, idx) => {
    const qty = Number(it.qty ?? 1);
    const recomputed = recomputes[idx] ?? null;
    const unit = freeItemByIdx.has(idx)
      ? 0
      : (recomputed ? recomputed.unit_price_sen : Number(it.unitPriceSen ?? 0));
    const discount = Number(it.discountSen ?? 0);
    const lineTotal = senOrZero((qty * unit) - discount);
    const itemCode = String(it.itemCode ?? '');
    const unitCost = senOrZero(
      recomputed && recomputed.unit_cost_sen > 0
        ? recomputed.unit_cost_sen
        : await snapshotUnitCostSen(sb, itemCode, Number(it.unitCostSen ?? 0), c),
    );
    const lineCost = senOrZero(unitCost * qty);
    const group = String(it.itemGroup ?? '').toLowerCase();
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
    const extraRM = autoSkuEnabled ? extraRMof(it) : 0;
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
      description2: buildVariantSummary((productRowByCode.get(String(it.itemCode ?? '').trim())?.category ?? '').trim().toLowerCase() || String(it.itemGroup ?? '').trim() || 'others', (it.variants as Record<string, unknown> | null) ?? null) || null,
      remark: soLineRemark(it),
      uom: (it.uom as string) ?? 'UNIT',
      qty,
      unit_price_sen: unit,
      discount_sen: discount,
      total_sen: lineTotal,
      total_inc_sen: lineTotal,
      balance_sen: lineTotal,
      variants: canonicalizeVariants(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null),
      unit_cost_sen: unitCost,
      line_cost_sen: lineCost,
      line_margin_sen: lineTotal - lineCost,
      divan_price_sen:         recomputed?.divan_price_sen ?? 0,
      leg_price_sen:           recomputed?.leg_price_sen ?? 0,
      special_order_price_sen: recomputed?.special_order_sen ?? 0,
      custom_specials:         recomputed?.custom_specials ?? null,
      line_delivery_date: dateOrNull(lineDeliveryDate),
      line_delivery_date_overridden: lineDeliveryDateOverridden,
      warehouse_id: (it.warehouseId as string | null | undefined) ?? defaultWarehouseId,
      branding: lineProducts[idx]?.branding ?? null,
      venue: resolvedVenueName,
      stock_status: 'PENDING',
    };

    if (group === 'sofa') {
      const product = lineProducts[idx] ?? null;
      const modulePrices = sofaModulePricesByIdx.get(idx) ?? null;
      if (!modulePrices && product?.base_model) {
        // eslint-disable-next-line no-console
        console.warn(`[so-create] no module prices for ${product.base_model} — sofa split uses equal weights`);
      }
      const split = splitSofaBuildIntoModuleLines({
        baseModel: product?.base_model ?? null,
        cells: (it.variants as { cells?: unknown } | null)?.cells,
        buildUnitPriceSen: unit,
        buildUnitCostSen: unitCost,
        modulePrices, moduleCostsSen: recomputed?.sofa_module_costs_sen ?? null,
        evenSplitPrice: extraRM > 0,
        depth: String((it.variants as { depth?: unknown } | null)?.depth ?? '24'),
      });
      if (split && split.length > 0) {
        const buildKey = `build-${idx + 1}`;
        const { cells: _cells, ...sharedVariants } =
          canonicalizeVariants('sofa', (it.variants as Record<string, unknown> | null) ?? {});
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
            custom_specials:         recomputed?.custom_specials ?? null,
            remark: baseRow.remark,
          };
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
        sellPriceSen: Number(baseRow.unit_price_sen ?? 0),
      });
    }
    {
      const pwpKey = String((it as { cartLineKey?: string }).cartLineKey ?? '');
      if (pwpKey && !pwpLeadRowByCartKey.has(pwpKey)) pwpLeadRowByCartKey.set(pwpKey, baseRow);
    }
    return [baseRow];
  })).then((rows) =>
    sortSoLinesByGroupRank(rows.flat(), (r) => r.item_group as string | null | undefined));

  const margin = total - totalCost;
  const marginPctBasis = total > 0 ? Math.round((margin / total) * 10000) : 0;

  let deliveryFeeSen = 0;
  let deliveryFee: SoDeliveryFeeResult | null = null;
  let crossCategorySourceDocNo: string | null = null;
  if (body.applyDeliveryFee) {
    let dcfgQ = sb.from('delivery_fee_config').select('base_fee, cross_category_fee');
    if (companyId != null) dcfgQ = dcfgQ.eq('company_id', companyId);
    else dcfgQ = dcfgQ.eq('id', 1);
    const { data: dcfg } = await dcfgQ.single();
    const DELIVERABLE = new Set(['sofa', 'mattress', 'bedframe']);
    const categoryIds = items
      .map((it) => String((it as { itemGroup?: string }).itemGroup ?? '').toLowerCase())
      .filter((g) => DELIVERABLE.has(g));
    const additionalSen = Math.max(0, Math.round(Number(body.additionalDeliveryFee ?? 0) * 100));
    const cfgSen = {
      baseFee:          Number((dcfg as { base_fee?: number } | null)?.base_fee ?? 0) * 100,
      crossCategoryFee: Number((dcfg as { cross_category_fee?: number } | null)?.cross_category_fee ?? 0) * 100,
    };

    const comboModulesById = new Map<string, string[][]>(
      cachedCombos.map((cb) => [cb.id, cb.accessories?.length ? [] : cb.modules]),
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
    const specialModels = await specialDeliveryFeesForLines(sb, deliveryRuleLines, comboModulesById, companyId);

    let isCrossCategoryFollowup = false;
    const rawLink = String((body.crossCategorySourceDocNo as string | undefined) ?? '').trim();
    if (rawLink) {
      const elig = await checkCrossCategorySource(
        c, sb, rawLink, typeof body.phone === 'string' ? body.phone : null, orderCustomerId,
      );
      if (!elig.eligible) {
        await rollbackPwpClaims();
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
        warehouse_id: null,
        branding: null,
        venue: resolvedVenueName,
        stock_status: 'READY',
      } as unknown as (typeof itemRows)[number]);
    }
  }

  const grandTotal          = total + serviceSen;
  const grandMargin         = margin + serviceSen;
  const grandMarginPctBasis = grandTotal > 0 ? Math.round((grandMargin / grandTotal) * 10000) : 0;

  {
    const rowCodes = itemRows.map((r) => (r as { item_code?: string | null }).item_code);
    const rowCheck = await validateItemCodes(sb, rowCodes, companyId);
    if (!rowCheck.ok) {
      await rollbackPwpClaims();
      return c.json(unknownItemCodeResponse(rowCheck.unknown), 409);
    }
  }

  const customerCountrySnapshot = await deriveCountryFromState(
    sb,
    (body.customerState as string | null | undefined) ?? null,
  );

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
        await rollbackPwpClaims();
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
  /* Money moved from a cancelled order (docs/bugs/0927): each converted row must fit that order's remaining, BEFORE the header exists. */
  const convertPlans = new Map<number, ConvertPlan>();
  for (const [i, p] of (posPayments ?? []).entries()) {
    if (p.method !== 'converted') continue;
    const g = await convertGuard(sb, Number(companyId), { fromDocNo: p.convertedFromDocNo, toDocNo: '', amountSen: p.amountSen });
    if (!g.ok) { await rollbackPwpClaims(); return c.json({ error: g.error, message: g.message }, g.status); }
    convertPlans.set(i, g.plan);
  }

  /* Slip-date window on CREATE (owner 2026-09-23) — the New-SO form carries ONE
     payment date for every row it books, so it is judged once, here, before any
     row is written. Rows that are money MOVED from another order take the source
     order's date and are exempt, exactly as on the payments panel. The headless
     scan job carries no permissions, so an OCR'd old receipt is refused and goes
     to a human — the owner's call. */
  const booksMoneyOnCreate = (posPayments ?? []).some((p) => p.method !== 'converted')
    || (typeof body.depositSen === 'number' && body.depositSen > 0);
  /* The proof on CREATE (owner 2026-10-13, shared/payment-slip-required). The
     single-deposit body books its row from the header slip or the scanned
     receipt (the legacy `depositSen` path below); with neither there is nothing
     to verify, so the order is not created. The split `payments[]` rows are
     judged per row by planCreatePaymentSlips further down. */
  if (!posPayments && typeof body.depositSen === 'number' && body.depositSen > 0) {
    const slipVerdict = checkPaymentSlip({ converted: false, hasSlip: Boolean(slipKey ?? receiptImageKey) });
    if (!slipVerdict.ok) {
      await rollbackPwpClaims();
      return c.json({ error: slipVerdict.code, reason: slipVerdict.reason }, 400);
    }
  }
  if (booksMoneyOnCreate) {
    const verdict = checkPaymentSlipDate(dateOrNull(body.paymentDate) ?? todayMyt(), todayMyt());
    if (!verdict.ok && !hasHouzsPerm(c, SO_PAYMENT_BACKDATE)) {
      await rollbackPwpClaims();
      return c.json({ error: 'slip_date_out_of_window', reason: verdict.reason }, 400);
    }
  }

  /* Resolve each split payment's slip session → R2 key up front. A keyed row
     without one refuses the create (owner 2026-10-13, slip required); only a
     converted row books slip-less; a slip that is claimed and does not resolve
     refuses too. The rule is `planCreatePaymentSlips`
     (so-create-payment-slips.ts); this block is its IO. All-or-nothing, BEFORE
     the header insert (and rolling back PWP claims), so no SO is created with
     half its payment proofs missing. */
  let posPaymentSlipKeys: Array<string | null> | null = null;
  if (posPayments) {
    const sessionIds = claimedSlipSessionIds(posPayments);
    const slipById = new Map<string, { r2_key: string | null; status: string }>();
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

  lap('so-prep');
  let mintedDocNo = docNo;
  let firstMint = true;
  const { error: hErr } = await insertWithDocNoRetry(
    async () => {
      if (firstMint) { firstMint = false; return mintedDocNo; }
      mintedDocNo = await nextDocNo(sb, c);
      return mintedDocNo;
    },
    (dn) => sb.from('mfg_sales_orders').insert({
    company_id: companyId,
    doc_no: dn,
    transfer_to: (body.transferTo as string) ?? null,
    so_date: dateOrNull(body.soDate) ?? todayMyt(),
    branding: clientHeaderBranding(body.branding),
    debtor_code: (body.debtorCode ?? body.customerCode as string) ?? null,
    debtor_name: customerName,
    agent: agentToStamp,
    sales_location: derivedSalesLocation ?? null,
    ref: (body.ref as string) ?? null,
    venue: resolvedVenueName,
    venue_source: venueSource,
    venue_id: venueIdUuid,
    project_id: projectIdToStamp,
    /* The DAY of the picked event the order was written on (owner 2026-09-24),
       kept only as a day of that event, never after the order date. */
    fair_date: dateOrNull(fairDayOnSave(body, soDateForVenue)),
    /* Fitted to the book's 40-char columns on save — scm/lib/so-address-on-save.ts, docs/bugs/0738. */
    ...fitSoAddress([(body.address1 as string) ?? null, (body.address2 as string) ?? null,
      (body.address3 as string) ?? null, (body.address4 as string) ?? null]),
    phone: normPhone,
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    mattress_sofa_cost_sen: mattressSofaCost,
    bedframe_cost_sen:      bedframeCost,
    accessories_cost_sen:   accessoriesCost,
    others_cost_sen:        othersCost,
    service_sen: serviceSen,
    service_cost_sen: 0,
    local_total_sen: grandTotal,
    balance_sen: grandTotal,
    total_cost_sen: totalCost,
    total_revenue_sen: grandTotal,
    total_margin_sen: grandMargin,
    margin_pct_basis: grandMarginPctBasis,
    delivery_fee_sen: deliveryFeeSen,
    cross_category_source_doc_no: crossCategorySourceDocNo,
    line_count: itemRows.length,
    currency: ((body.currency as string) ?? 'MYR').toUpperCase(),
    note: (body.note as string) ?? null,
    email: (body.email as string) ?? null,
    customer_type: (body.customerType as string) ?? null,
    salesperson_id: salespersonIdToStamp,
    city: (body.city as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    building_type: (body.buildingType as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: typeof body.emergencyContactPhone === 'string'
      ? (normalizePhone(body.emergencyContactPhone) ?? body.emergencyContactPhone)
      : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    target_date: dateOrNull(body.targetDate),
    customer_id: orderCustomerId,
    customer_state: canonicalizeMyState((body.customerState as string | null | undefined) ?? null),
    customer_country: customerCountrySnapshot,
    customer_race: (body.customerRace as string) ?? null,
    customer_birthday: dateOrNull(body.customerBirthday),
    customer_gender: (body.customerGender as string) ?? null,
    customer_delivery_date: dateOrNull(body.customerDeliveryDate),
    sales_exemption_expiry: dateOrNull(body.customerDeliveryDate),
    /* PR #144 — Commander: "当我已经 create 好了这个 sales order 的时候，
       为什么我点进去 edit processing 的 delivery date 时，怎么没看到呢".
       processing_date was wired on PATCH (update header) but missed
       on the POST (create) — so the New SO form's Processing Date field
       never persisted; reopening the SO showed an empty field. */
    processing_date: dateOrNull(procDateOnCreate),
    amend_date_from_customer: dateOrNull(body.amendDateFromCustomer),
    amended_delivery_date: dateOrNull(body.amendedDeliveryDate),
    amend_reason: (body.amendReason as string) ?? null,
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
    slip_image_key: (body.slipImageKey as string) ?? null,
    receipt_image_key: receiptImageKey,
    payment_method:     (body.paymentMethod as string) ?? null,
    installment_months: typeof body.installmentMonths === 'number' ? body.installmentMonths : null,
    merchant_provider:  (body.merchantProvider as string) ?? null,
    approval_code:      (body.approvalCode as string) ?? null,
    payment_date:       dateOrNull(body.paymentDate),
    deposit_sen:      posPaymentsTotalSen ?? Math.max(0, typeof body.depositSen === 'number' ? body.depositSen : 0),
    paid_sen:         0,
    /* PR #154 — Commander 2026-05-27: "我们的整个系统是没有 Draft 功能的，
       把 Draft 的功能去除掉, 我们 create 的全部都是 confirm 的". 2990 is a
       trading company; we don't need a DRAFT staging step. Every new SO is
       CONFIRMED on insert. The DRAFT enum value still exists for legacy
       row compatibility, but new rows skip it entirely. */
    status: (body as { asDraft?: unknown }).asDraft === true ? 'DRAFT' : liveStatusForProcessingDate(dateOrNull(procDateOnCreate)),
    created_by: user.id,
    }),
    claimedPwpCodes.length === 0 ? 8 : 1,
  );
  if (hErr) { await rollbackPwpClaims(); return c.json({ error: 'insert_failed', reason: hErr.message }, 500); }
  docNo = mintedDocNo;
  lap('so-header-write');

  if (slipKey && uploadSessionId) {
    await sb.from('pending_slip_uploads')
      .update({ status: 'promoted', promoted_at: new Date().toISOString() })
      .eq('upload_session_id', uploadSessionId);
  }

  if (oneShotReqs.length > 0) {
    const admin = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const candidate = (r: OneShotMintReq, n: number) => r.category === 'SOFA'
      ? oneShotSofaCode(r.modelCode, r.compartment, remarkSlug(r.remarkText), n)
      : oneShotSimpleCode(r.baseSkuCode, remarkSlug(r.remarkText), n);
    const probe = oneShotReqs.flatMap((r) => [1, 2, 3].map((n) => candidate(r, n)));
    let probeQ = pgrestIn(admin.from('mfg_products').select('code'), 'code', probe);
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
      cost_price_sen: r.cost_price_sen ?? 0,
    }));
    const { error: skuErr } = await admin.from('mfg_products').insert(stampCo(skuRows));
    if (skuErr && skuErr.code !== '23505') {
      // eslint-disable-next-line no-console
      console.error(`[so-create] one-shot SKU mint failed for ${docNo}: ${skuErr.message}`);
    }
  }

  if (itemRows.length > 0) {
    const rowsWithDoc = itemRows.map((r, lineNo) => ({ ...r, doc_no: docNo, line_no: lineNo }));
    /* Owner 2026-07-23 — auto-derive line.branding from the product catalog
       for any line the client did not stamp explicitly. The SO CREATE form
       has never exposed a per-line branding field, so before this fix every
       new SO shipped with branding=NULL on every line and the SO list
       Branding column read "—" for the whole book (2990 CoE 2026-07-23).
       Runs BEFORE stampCo so we can find the per-row company_id via the
       active-user fallback; stampCo then adds it. */
    await deriveLineBrandingFromProduct(sb, rowsWithDoc as unknown as Array<{ item_code?: string | null; branding?: string | null; company_id?: number | null }>, activeCompanyId(c) ?? null);
    signalNullWarehouseRows('POST /mfg-sales-orders (create)', docNo, rowsWithDoc as unknown as Array<Record<string, unknown>>);
    const { error: iErr } = await sb.from('mfg_sales_order_items').insert(stampCo(rowsWithDoc));
    if (iErr) { await rollbackPwpClaims(); await sb.from('mfg_sales_orders').delete().eq('doc_no', docNo); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
    /* Stamp the HEADER branding from the representative line's SKU (owner
       2026-08-18, "我要表头啊"). The insert above wrote `body.branding ?? null`
       and no shipped client sends that field, so every ERP-created order landed
       with a blank header — which is exactly the hole the 2990 backfill had to
       fill for 100 orders, and would have re-opened on the next order created.
       Fills the header unless the caller sent a real brand: a blank, placeholder
       or category word ("BEDFRAME") is not one, so the lines decide. A null result leaves it blank rather
       than inventing one. */
    if (clientHeaderBranding(body.branding) === null) {
      const listFallback = await loadHeaderBrandList(c);
      const headerBrand = await deriveHeaderBrandingFromLines(
        sb,
        rowsWithDoc as unknown as Array<{ item_code?: string | null; item_group?: string | null; branding?: string | null; company_id?: number | null }>,
        activeCompanyId(c) ?? null,
        listFallback,
      );
      if (headerBrand) {
        effectiveBrand = headerBrand;
        await scopeToCompany(
          sb.from('mfg_sales_orders').update({ branding: headerBrand }).eq('doc_no', docNo),
          c,
        );
      }
    }
    await recomputeTotals(sb, docNo, c);
  }
  lap('so-items-write');

  const paymentErrors: string[] = [];
  if (posPayments) {
    const paidAt = dateOrNull(body.paymentDate) ?? todayMyt();
    for (let i = 0; i < posPayments.length; i++) {
      const p = posPayments[i]!;
      const merchantLike = p.method === 'merchant' || p.method === 'installment';
      const merchantProvider = merchantLike ? (p.merchantProvider ?? null) : null;
      const installmentMonths = merchantLike
        && typeof p.installmentMonths === 'number' && p.installmentMonths > 0
        ? p.installmentMonths : null;
      const plan = convertPlans.get(i) ?? null;
      const { data: depRow, error: depErr } = await sb.from('mfg_sales_order_payments').insert({
        company_id:         companyId,
        so_doc_no:          docNo,
        paid_at:            plan ? plan.paidAt : paidAt,
        method:             p.method,
        ...(plan ? { converted_from_so_doc_no: plan.fromDocNo } : {}),
        merchant_provider:  merchantProvider,
        installment_months: installmentMonths,
        approval_code:      p.approvalCode ?? null,
        /* A split row's OWN slip when it sent one, else null — the slip is
           optional (Owner 2026-08-13). Deliberately NOT falling back to
           `receiptImageKey`: that key is the single-deposit scan path's proof
           (below) and stamping it on several split rows would put one photo on
           payments it does not evidence. */
        slip_key:           posPaymentSlipKeys![i] ?? (plan ? plan.slipKey : null),
        account_sheet:      plan ? `Converted from ${plan.fromDocNo}` : deriveAccountSheet(p.method, merchantProvider, null),
        amount_sen:       p.amountSen,
        collected_by:       plan ? plan.collectedBy : ((body.salespersonId as string) ?? callerStaffId),
        created_by:         user.id,
        is_deposit:         true,
        note:               plan ? `Converted from ${plan.fromDocNo} at SO create` : 'POS split payment (auto-recorded at SO create)',
      }).select('id, so_doc_no, paid_at, method, merchant_provider, amount_sen, company_id, converted_from_so_doc_no, created_at, created_by').single();
      if (depErr) {
        // eslint-disable-next-line no-console
        console.error('[so-create] split-payment ledger insert failed:', depErr.message);
        paymentErrors.push(`A payment of ${fmtSen(p.amountSen)} (${p.method}) was NOT recorded: ${depErr.message}. Add it on the order's Payments tab.`);
        continue;
      }
      await bookSoPaymentBestEffort(sb, depRow, 'split payment at SO create'); // docs/bugs/0652: this row used to skip the gate
      await linkPaymentScan(sb, { companyId: companyId ?? null, slipKey: posPaymentSlipKeys![i] ?? null, paymentId: String((depRow as { id?: unknown }).id ?? '') }); // HC-0006 T7
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
        paymentId: String((depRow as { id?: unknown } | null)?.id ?? '') || null,
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
    const VALID_METHODS = new Set(['cash', 'merchant', 'transfer', 'installment']);
    const rawMethod = typeof body.paymentMethod === 'string' ? body.paymentMethod.trim() : '';
    const depositMethod = VALID_METHODS.has(rawMethod) ? rawMethod : null;
    if (depositSen > 0 && depositMethod) {
      const merchantLike = depositMethod === 'merchant' || depositMethod === 'installment';
      const merchantProvider = merchantLike ? ((body.merchantProvider as string) ?? null) : null;
      const installmentMonths = merchantLike
        && typeof body.installmentMonths === 'number' && body.installmentMonths > 0
        ? body.installmentMonths : null;
      const paidAt = dateOrNull(body.paymentDate) ?? todayMyt();
      const { data: depRow, error: depErr } = await sb.from('mfg_sales_order_payments').insert({
        company_id:         companyId,
        so_doc_no:          docNo,
        paid_at:            paidAt,
        method:             depositMethod,
        merchant_provider:  merchantProvider,
        installment_months: installmentMonths,
        approval_code:      (body.approvalCode as string) ?? null,
        slip_key:           slipKey ?? receiptImageKey,
        account_sheet:      deriveAccountSheet(depositMethod, merchantProvider, null),
        amount_sen:       depositSen,
        collected_by:       (body.salespersonId as string) ?? callerStaffId,
        created_by:         user.id,
        is_deposit:         true,
        note:               'POS deposit (auto-recorded at SO create)',
      }).select('id, so_doc_no, paid_at, method, merchant_provider, amount_sen, company_id').single();
      if (depErr) {
        // eslint-disable-next-line no-console
        console.error('[so-create] deposit ledger insert failed:', depErr.message);
        paymentErrors.push(`The deposit of ${fmtSen(depositSen)} (${depositMethod}) was NOT recorded: ${depErr.message}. Add it on the order's Payments tab.`);
      } else {
        await bookSoPaymentBestEffort(sb, depRow, 'deposit at SO create'); // docs/bugs/0652: this row used to skip the gate
        await linkPaymentScan(sb, { companyId: companyId ?? null, slipKey, paymentId: String((depRow as { id?: unknown }).id ?? '') }); // HC-0006 T7
        await recordSoAudit(sb, {
          docNo,
          action: 'ADD_PAYMENT',
          actorId: user.id,
          actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
          source: 'automation',
          note: 'Auto: POS deposit recorded at SO create',
          paymentId: String((depRow as { id?: unknown } | null)?.id ?? '') || null,
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

  lap('so-payments');

  /* ── FAIR LINK (owner 2026-09-13) ─────────────────────────────────────────
     Which EXHIBITION this sale belongs to, not just where it was written. The
     picker sent a place and an organizer; the booth is re-derived here from the
     order's own brand, because a client-supplied project id would let a stale
     dropdown attribute a sale to another company's fair and `project_id` carries
     no company predicate of its own.

     Runs OUTSIDE the items block on purpose: an order with no lines still has a
     venue and a date, and must still record WHY it has no fair link rather than
     leaving a blank that reads the same as "nobody has looked".

     Non-fatal throughout — no fair-link problem may block a sale, and the
     nightly reconcile retries PENDING. The rule — No fair, nothing for a scan
     (owner 2026-11-12), a typed pick, the brand's booth then the keyer's own —
     is fair-binding.ts::fairLinkOnCreate. */
  {
    const fairLink = await fairLinkOnCreate({
      db: c.env.DB as unknown as FairDb, companySql: activeCompanySql(c, 'p.company_id'),
      companyCode: c.get('companyCode'), scanned: scanCreate,
      keyerId: Number(c.get('houzsUser')?.id ?? NaN), body, venue: resolvedVenueName,
      soDate: soDateForVenue, brand: effectiveBrand, bindingProjectId: projectIdToStamp,
    });
    await scopeToCompany(sb.from('mfg_sales_orders').update(fairLink.columns).eq('doc_no', docNo), c);
    if (fairLink.note) {
      await recordFairChange({
        sb, db: c.env.DB as unknown as FairDb, companySql: activeCompanySql(c, 'p.company_id'), docNo,
        before: { projectId: null, fairMatch: null }, after: fairStateOf(fairLink.columns), how: 'scan',
        actorId: user.id, actorName: null, note: fairLink.note,
      });
    }
  }

  const pwpCartLineKeys = Array.from(new Set(
    items.map((it) => String((it as { cartLineKey?: string } | null)?.cartLineKey ?? '')).filter(Boolean),
  ));
  const rewardLineKeys = Array.from(new Set(
    items
      .filter((it) => String((it?.variants as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim() !== '')
      .map((it) => String((it as { cartLineKey?: string } | null)?.cartLineKey ?? ''))
      .filter(Boolean),
  ));
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
    const restampCompanyId = activeCompanyId(c);
    for (const [lead, codes] of codesByLead) {
      if (restampCompanyId == null) break;
      const { error: stampErr } = await pgrestIn(sb.from('pwp_codes')
        .update({ trigger_item_code: lead, updated_at: new Date().toISOString() }), 'code', codes).eq('company_id', restampCompanyId);
      // eslint-disable-next-line no-console
      if (stampErr) console.error('[so-create] pwp trigger restamp failed:', lead, stampErr.message);
    }
  }

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
    statusSnapshot: (body as { asDraft?: unknown }).asDraft === true ? 'DRAFT' : liveStatusForProcessingDate(dateOrNull(procDateOnCreate)),
    source: c.auditSource ?? 'web',
    note: c.auditNote,
  });

  /* B2C auto-allocation — if stock is already on hand, the new SO's lines flip
     to READY immediately and the header advances to READY_TO_SHIP. Runs a GLOBAL
     re-walk (not scoped to this doc) so that if this higher-priority order steals
     stock from a lower-priority one, the loser regresses from READY in the SAME
     pass instead of lagging. Best-effort: a failure never sinks the SO create.
     NOT for a DRAFT (HC-0006 speed): DRAFT is in SO_TERMINAL_STATES, so the walk
     never loads the new order and the full re-walk only cost the scan job
     seconds. DRAFT -> CONFIRMED re-walks on the status route, and the 5-minute
     sweep repairs anything else. */
  lap('so-followers');
  if ((body as { asDraft?: unknown }).asDraft !== true) {
    try { await recomputeAllocationAfterSave(sb, 'post-so-create'); }
    catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-create failed:', e); }
  }
  lap('so-alloc');

  const acNotSent = (body as { asDraft?: unknown }).asDraft === true ? []
    : (await enqueueSoCreate(sb, { companyId, docNo, createdBy: c.get('houzsUser')?.id ?? null })).problems;
  lap('so-ac-queue');

  if (paymentErrors.length) return c.json({ docNo, ...(acNotSent.length ? { acNotSent } : {}), paymentErrors }, 201);
  return c.json({ docNo, ...(acNotSent.length ? { acNotSent } : {}) }, 201);
}

mfgSalesOrders.post('/', async (c) => {
  const out = await createSalesOrderCore({
    req: { json: () => c.req.json() },
    get: ((key: 'supabase' | 'user' | 'houzsUser' | 'companyId' | 'sessionOrigin') => c.get(key as 'supabase')) as unknown as SoCreateContext['get'],
    env: c.env,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
  });
  /* WHICH BRAND IS THIS BILL FOR (owner 2026-09-27) -- asked by the form when
     nothing on the bill names a brand (a bed frame or accessory bill written at
     a brand's fair), for the Venture Portal only; branding is untouched. Added
     here, after the core has answered, so the create itself is exactly as it
     was. A draft is never asked (the loader says so): that is asked when it is
     confirmed. lib/vp-brand-ask.ts. */
  if (out.status === 201 && typeof out.body.docNo === 'string') {
    const vpBrand = await loadVpBrandAsk({
      sb: c.get('supabase'), db: c.env.DB as unknown as VpBrandDb, companyId: activeCompanyId(c) ?? null,
      companySql: activeCompanySql(c), docNo: out.body.docNo,
    });
    if (vpBrand) return c.json({ ...out.body, vpBrand }, 201);
  }
  if (out.noWrite) markIdempotencyNoWrite(c);
  return c.json(out.body, out.status as 201);
});

/* ── POST /validate — dry-run "what is blocking this submit" ────────────────
   Owner 2026-09-16 (「跟 backend 串通, frontend 只是显示问题」): the BACKEND is
   the single source of the submit-blocked problem set AND its wording. This
   endpoint runs the SAME collectSoSubmitProblems the real create would, on the
   DRAFT the operator is still filling in, and returns problems[] WITHOUT writing
   anything — no doc number, no idempotency, no DB. The frontend calls it debounced
   as the operator types and simply renders the list + the "Can't save — N to fix"
   count; it holds no validation rules of its own. Pure (no reads): the form
   already carries the item groups, the resolved sales location, the venue /
   salesperson ids and the payment rows, so this computes the verdict from the
   posted state alone. The authoritative gates still run on the real submit. */
mfgSalesOrders.post('/validate', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];
  const asDraft = body.asDraft === true;
  const isEdit = body.isEdit === true;
  const procDate = str(body.processingDate).trim() || null;
  const delivDate = str(body.customerDeliveryDate).trim() || null;
  const fillAddressLater = body.fillAddressLater === true;
  const companyCode = body.companyCode ?? null;

  const linesForCheck = items.map((it) => ({
    itemCode: String(it.itemCode ?? ''),
    group: (it.itemGroup as string | null | undefined) ?? null,
    variants: (it.variants as Record<string, unknown> | null) ?? null,
  }));
  const hasNamedLine = items.some(
    (it) => String(it.itemCode ?? '').trim() !== '' && Number(it.qty ?? 0) > 0,
  );
  const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  const payments = (body.payments as Array<Record<string, unknown>> | undefined) ?? [];
  const paymentGaps = payments
    .map((p, i) => {
      if (Number(p.amountSen ?? 0) <= 0) return null;
      const missing = soPaymentSubFieldGap({
        methodLabel: str(p.methodLabel),
        merchantProvider: str(p.merchantProvider) || null,
        installmentMonthsLabel: str(p.installmentMonthsLabel) || null,
        onlineType: str(p.onlineType) || null,
        convertedFromDocNo: str(p.convertedFromDocNo) || null,
      });
      return missing ? { row: i + 1, method: str(p.methodLabel) || 'payment', missing } : null;
    })
    .filter((g): g is { row: number; method: string; missing: string } => g !== null);

  const problems = collectSoSubmitProblems({
    customerName: str(body.debtorName) || str(body.customerName),
    phone: str(body.phone),
    origPhone: isEdit && typeof body.origPhone === 'string' ? body.origPhone : null,
    hasNamedLine,
    asDraft,
    hasVenue: str(body.venueId).trim() !== '' || body.hasVenue === true,
    hasSalesperson: str(body.salespersonId).trim() !== '' || body.hasSalesperson === true,
    // Fair compulsory on CREATE (owner 2026-09-26): a picked/auto-filled fair
    // sets fairOrganizer; the operator can instead mark No-fair (showroom). Edits
    // are exempt (isEdit) so the change never blocks editing a legacy order that
    // pre-dates the rule.
    fairChosen: str(body.fairOrganizer).trim() !== '' || isEdit,
    noFair: body.noFair === true,
    fairWhy: fairWhyOf(body.fairWhy),
    fairDayMissing: fairDayMissing(body, str(body.soDate).slice(0, 10) || todayMY),
    gateLocation: !asDraft && !isEdit && companyRequiresStockLocation(companyCode),
    companyCode,
    salesLocation: str(body.salesLocation),
    customerState: str(body.customerState),
    gate: {
      procDate,
      delivDate,
      todayMY,
      /* Edit context (owner 2026-09-16): the edit surfaces send the order's
         ORIGINAL dates so the gate's grandfather carve-out applies — an
         already-saved past (or unpaired) date this edit does NOT change is a
         historical record, not a fresh entry, and must not block. Absent on a
         create (every date is new), so both are null there. */
      origProcDate: str(body.origProcessingDate).trim() || null,
      origDelivDate: str(body.origDeliveryDate).trim() || null,
      variantOffenders: procDate ? findIncompleteVariantLines(linesForCheck) : [],
      kivOffenders: procDate ? findColourKivLines(linesForCheck) : [],
      completeness: {
        hasCustomerName: (str(body.debtorName) || str(body.customerName)).trim() !== '',
        hasAddress: !fillAddressLater && str(body.address1).trim() !== '',
        hasPostcode: !fillAddressLater && str(body.postcode).trim() !== '',
      },
    },
    sofaMixConflict:
      mixesSofaWithOtherMain(items.map((it) => (it.itemGroup as string | null | undefined) ?? null))
      && !mixesSofaWithOtherMain(((body.origItemGroups as unknown[] | undefined) ?? []).map((g) => (typeof g === 'string' ? g : null))),
    paymentGaps,
  });
  /* Transport fee for the far states and Singapore (owner 2026-11-11, Houzs
     only). On a create, on a scanned draft being turned into an order
     (confirmingDraft), and on an edit that moves the order's State (the edit
     surfaces send origCustomerState). Taking the fee off a line is refused by
     the line routes themselves. A line posted without unitPriceSen is not
     judged on its amount. */
  const stateMoved = isEdit && typeof body.origCustomerState === 'string'
    && transportFeeRegion(body.origCustomerState || null, null) !== transportFeeRegion(str(body.customerState) || null, str(body.customerCountry) || null);
  if (!asDraft && (!isEdit || body.confirmingDraft === true || stateMoved)) {
    const feeProblem = transportFeeProblem(typeof companyCode === 'string' ? companyCode : null, str(body.customerState) || null, str(body.customerCountry) || null, items.map((it) => ({
      itemCode: str(it.itemCode) || null,
      description: str(it.description) || null,
      itemGroup: str(it.itemGroup) || null,
      amountSen: it.unitPriceSen === undefined || it.unitPriceSen === null ? null
        : Number(it.qty ?? 1) * Number(it.unitPriceSen) - Number(it.discountSen ?? 0),
    })));
    if (feeProblem) problems.push(feeProblem);
  }

  return c.json({ problems }, 200);
});

export async function createDraftSalesOrder(
  env: Env,
  opts: {
    salespersonId: string;
    salespersonName?: string | null;
    houzsUserId?: number | null;
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
    if (key === 'companyId') return opts.companyId ?? undefined;
    if (key === 'companyCode') return resolvedCompanyCode ?? undefined;
    if (key === 'sessionOrigin') return undefined;
    if (key === 'user') {
      return {
        id: opts.salespersonId,
        user_metadata: opts.salespersonName ? { name: opts.salespersonName } : undefined,
      };
    }
    return opts.houzsUserId != null ? { id: opts.houzsUserId } : undefined;
  };
  return createSalesOrderCore({
    req: { json: async () => opts.body },
    get: syntheticGet as unknown as SoCreateContext['get'],
    env,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
    auditSource: 'scan',
    auditNote: 'Draft created by the background slip-scan job (photo OCR)',
  });
}

mfgSalesOrders.post('/recompute-allocation', async (c) => {
  const sb = c.get('supabase');
  const res = await recomputeSoStockAllocation(sb);
  return c.json(res);
});

export const patchMfgSalesOrderStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  const lap = stepClock();
  let body: { status?: string; notes?: string; version?: number; expectedStatus?: string; processingDate?: string; internalExpectedDd?: string; overrideReason?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  let toStatus = String(body.status).trim().toUpperCase();

  const co = requireActiveCompanyId(c); if (!co.ok) return c.json(co.refusal, 409);
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: prev } = await scopeToCompanyId(sb.from('mfg_sales_orders')
    .select('status, version, edit_lease_token, edit_lease_expires_at, linked_ac_docno'), co.companyId)
    .eq('doc_no', docNo).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  const fromStatus = (prev as { status: string } | null)?.status ?? null;
  const fromNorm = fromStatus == null ? null : String(fromStatus).toUpperCase();

  /* REOPEN (un-cancel) POLICY — owner 2026-09-18.
     A MIGRATED order (linked_ac_docno) carried over from AutoCount CAN be
     reopened. Its CANCELLED almost always came from the AutoCount sync, not the
     ERP cancel flow, so there is nothing to unwind except the status; the one ERP
     money side-effect that can exist — the deposit→credit refund — is clawed back
     after commit (reverseCancelledSoCredit) so a reopen never double-counts.
     AutoCount has no un-cancel, so this reopen pushes NOTHING back (isCancel is
     false below, so neither enqueueCancel nor enqueueSoCreate fires): the ERP goes
     live while AutoCount stays cancelled, a divergence the owner chose to accept
     and reconcile in the book by hand. A NON-migrated cancel, by contrast, ran the
     full ERP cancel flow (credit, PWP vouchers voided, stock released), and
     reversing all of that safely is not something this path does — it stays final
     (the guard just below). */
  const currentVersion = Number((prev as { version?: number | string }).version ?? 1);
  const expectedVersionRaw = Number(body.version);
  const statusGrace = !Number.isInteger(expectedVersionRaw) || expectedVersionRaw < 1;
  if (statusGrace && !soCasGraceOpen(soCasGrace(c))) {
    return c.json({ ...SO_VERSION_REQUIRED, currentVersion }, 428);
  }
  const expectedVersion = statusGrace ? currentVersion : expectedVersionRaw;
  if (expectedVersion !== currentVersion
      || (body.expectedStatus && String(body.expectedStatus).toUpperCase() !== fromNorm)) {
    return c.json(soVersionConflict(currentVersion), 409);
  }
  if (activeSoEditLease(prev as SoEditLeaseRow)) return c.json(SO_EDIT_LEASE_CONFLICT, 409);

  /* Audit 2026-06-11 C-1/H1 — a NON-migrated CANCELLED SO is FINAL (mirrors
     do_cancelled_final). Its cancel ran the full ERP flow: the deposit became a
     customer credit, PWP vouchers were voided and stock was released. The
     SO_REOPEN_CONTRA claw-back (owner 2026-09-18) now reverses the credit, but the
     vouchers and stock release are NOT unwound here, so a hand reopen would leave
     those wrong — re-order via a NEW SO instead. A MIGRATED order is exempt (it is
     let through above): its cancel came from the AutoCount sync with none of those
     side-effects, and the claw-back covers the only one that can exist. Re-cancel
     (CANCELLED→CANCELLED) still rides through below and is idempotent. */
  if (fromNorm === 'CANCELLED' && toStatus !== 'CANCELLED'
      && !(prev as { linked_ac_docno?: string | null }).linked_ac_docno) {
    return c.json({
      error: 'so_cancelled_final',
      reason: SO_CANCELLED_FINAL_REASON,
    }, 409);
  }

  if (toStatus === 'CANCELLED' && fromNorm !== 'CANCELLED') {
    const childLock = await soHasDownstream(sb, docNo);
    if (childLock) return c.json(childLock, 409);
  }

  {
    const txErr = soStatusTransitionError(fromNorm, toStatus);
    if (txErr) return c.json({ error: txErr.error, reason: txErr.reason }, txErr.code);
  }

  if (fromNorm === toStatus) {
    const overrideReason = typeof body.overrideReason === 'string' ? body.overrideReason.trim() : '';
    if (overrideReason) {
      if (overrideReason.length < 10) return c.json({ error: 'override_reason_too_short', message: 'Override needs a reason of at least 10 characters.' }, 400);
      const { error: trailErr } = await sb.from('mfg_so_status_changes').insert({
        company_id: co.companyId,
        doc_no: docNo,
        from_status: fromStatus,
        to_status: fromStatus,
        changed_by: user.id,
        notes: `Edit-lock override: ${overrideReason}`,
      });
      if (trailErr) return c.json({ error: 'override_not_recorded', message: `The override reason could not be saved (${trailErr.message}). The SO stays locked — try again.` }, 500);
      await recordSoAudit(sb, {
        docNo, action: 'UPDATE_STATUS', actorId: user.id,
        actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
        fieldChanges: [], statusSnapshot: fromStatus, note: `Edit-lock override: ${overrideReason}`,
      });
      return c.json({ salesOrder: prev, version: currentVersion, unchanged: true, overrideRecorded: true });
    }
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
  const isConfirm = fromNorm === 'DRAFT' && toStatus === 'CONFIRMED';
  if (isConfirm) {
    const confirmProblems = await soConfirmProblemsForDoc(sb, docNo, c.get('companyCode') ?? null);
    /* ...and the fair (owner 2026-10-19): a fair or No fair — fair-binding.ts
       (Sales Attending no longer stops it, owner 2026-10-22). */
    confirmProblems.push(...await fairConfirmProblems({
      sb, db: c.env.DB as unknown as FairDb, companySql: activeCompanySql(c, 'p.company_id'), companyCode: c.get('companyCode'),
      scope: (q) => scopeToCompanyId(q, co.companyId), docNo, confirmerId: Number(c.get('houzsUser')?.id ?? NaN), todayMyt: todayMyt(),
    }));
    if (confirmProblems.length > 0) return c.json(validationFailedBody(confirmProblems), 422);
  }
  let confirmProcRoll: { from: string | null; to: string } | null = null;
  if (isConfirm) {
    const { data: dated, error: datedErr } = await scopeToCompanyId(sb.from('mfg_sales_orders').select(`${SO_PROCESSING_DATE_COLUMN}, customer_delivery_date`), co.companyId)
      .eq('doc_no', docNo).maybeSingle();
    if (datedErr) return c.json({ error: 'load_failed', reason: datedErr.message }, 500);
    const datedRow = dated as Record<string, string | null> | null;
    const storedProc = datedRow?.[SO_PROCESSING_DATE_COLUMN] ?? null;
    /* HC-0113 — see processingDateOnConfirm. */
    const roll = processingDateOnConfirm({ processingDate: storedProc, deliveryDate: datedRow?.customer_delivery_date, todayMY: todayMyt() });
    if (!roll.ok) return c.json(validationFailedBody([roll.problem]), 422);
    if (roll.write) confirmProcRoll = { from: storedProc, to: roll.write };
    toStatus = liveStatusForProcessingDate(roll.write ?? storedProc);
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
  if (confirmProcRoll) patch[SO_PROCESSING_DATE_COLUMN] = confirmProcRoll.to;
  if (toStatus === 'IN_PRODUCTION') {
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
      supplied: readSoProcessingDateFromBody(body as Record<string, unknown>),
      stored: curRow?.[SO_PROCESSING_DATE_COLUMN] ?? null,
    });
    if (!resolved.ok) return c.json(resolved.refusal, 422);
    if (resolved.write) {
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
  const isCancel = toStatus === 'CANCELLED' && fromNorm !== 'CANCELLED';

  const commitStatusChange = async (sbx: any): Promise<Response> => {
    const voucherPlan = isCancel ? await planSoCancelVouchers(sbx, docNo) : null;
    if (voucherPlan?.blocked) return c.json(voucherPlan.blocked, 409);

    const { data, error } = await scopeToCompanyId(sbx.from('mfg_sales_orders').update(patch)
      .eq('version', currentVersion)
      .eq('status', fromStatus)
      .or(`edit_lease_token.is.null,edit_lease_expires_at.lt.${new Date().toISOString()}`), co.companyId)
      .eq('doc_no', docNo)
      .select('doc_no, status, version').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!data) {
      const { data: latest } = await scopeToCompanyId(sbx.from('mfg_sales_orders').select('version'), co.companyId).eq('doc_no', docNo).maybeSingle();
      if (!latest) return c.json({ error: 'not_found' }, 404);
      return c.json(soVersionConflict(Number((latest as { version?: number }).version ?? currentVersion)), 409);
    }

    if (voucherPlan) await applySoCancelVouchers(sbx, docNo, voucherPlan);

    if (isCancel) {
      const { data: liveLines, error: lineErr } = await scopeToCompanyId(sbx.from('mfg_sales_order_items')
        .select('id, item_code, item_group'), co.companyId)
        .eq('doc_no', docNo).eq('cancelled', false);
      if (lineErr) throw new Error(`so-cancel line read failed: ${lineErr.message}`);
      const goodsIds = ((liveLines ?? []) as Array<{ id: string; item_code: string | null; item_group: string | null }>)
        .filter((l) => !isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code }))
        .map((l) => l.id);
      if (goodsIds.length > 0) {
        const { error: relErr } = await scopeToCompanyId(sbx.from('mfg_sales_order_items')
          .update({ stock_status: 'PENDING', stock_qty_ready: 0, allocated_batch_no: null }), co.companyId)
          .eq('doc_no', docNo).in('id', goodsIds);
        if (relErr) throw new Error(`so-cancel allocation release failed: ${relErr.message}`);
      }
    }

    await sbx.from('mfg_so_status_changes').insert({
      company_id: activeCompanyId(c),
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
        ...(confirmProcRoll ? [{ field: 'processingDate', from: confirmProcRoll.from, to: confirmProcRoll.to }] : []),
        ...(voucherPlan ? soCancelVoucherAuditChanges(voucherPlan) : []),
      ],
      statusSnapshot: toStatus,
      note: body.notes ?? undefined,
    });

    /* A draft that just became a live order is asked which brand it is for,
       exactly as a create is (owner 2026-09-27; lib/vp-brand-ask.ts). */
    const vpBrand = fromNorm === 'DRAFT' && toStatus !== 'CANCELLED'
      ? await loadVpBrandAsk({
          sb, db: c.env.DB as unknown as VpBrandDb, companyId: co.companyId,
          companySql: activeCompanySql(c), docNo,
        })
      : null;

    return c.json({
      salesOrder: data,
      version: currentVersion + 1,
      ...(vpBrand ? { vpBrand } : {}),
      ...(voucherPlan ? {
        pwpVouchers: {
          voided: voucherPlan.toVoid.map((r) => r.code),
          returned: voucherPlan.toRestore.map((r) => r.code),
        },
      } : {}),
    });
  };

  lap('status-checks');
  const statusResponse = isCancel
    ? await runScmPgCommand(c, (tx) => commitStatusChange(tx))
    : await commitStatusChange(sb);
  lap('status-write');
  if (!statusResponse.ok) return statusResponse;

  if (isConfirm) {
    const acceptNote = noteScanDraftAccepted(getSupabaseService(c.env), docNo);
    try { c.executionCtx.waitUntil(acceptNote); }
    catch { }
  }

  lap('status-scan-note');
  try { await recomputeAllocationAfterSave(sb, 'post-so-status'); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-status failed:', e); }
  lap('status-alloc');

  if (isCancel) {
    await enqueueCancel(sb, {
      companyId: activeCompanyId(c),
      docType: 'SO',
      docNo,
      self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: docNo },
      createdBy: c.get('houzsUser')?.id ?? null,
    });
  } else if (fromNorm === 'DRAFT') {
    await enqueueSoCreate(sb, {
      companyId: activeCompanyId(c),
      docNo,
      createdBy: c.get('houzsUser')?.id ?? null,
    });
  }

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

  if (fromNorm === 'CANCELLED' && toStatus !== 'CANCELLED') {
    try {
      const { data: so, error: soErr } = await scopeToCompanyId(sb.from('mfg_sales_orders').select('debtor_code, debtor_name'), co.companyId).eq('doc_no', docNo).maybeSingle();
      if (soErr) throw new Error(soErr.message);
      const s = so as { debtor_code: string | null; debtor_name: string | null } | null;
      if (s?.debtor_code) {
        await reverseCancelledSoCredit(sb, {
          docNo,
          debtorCode: s.debtor_code,
          debtorName: s.debtor_name,
          createdBy: user.id,
        });
      }
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] so-reopen contra failed:', e); }
  }

  lap('status-followers');
  return statusResponse;
};
mfgSalesOrders.patch('/:docNo/status', patchMfgSalesOrderStatusHandler);

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

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

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

  const discardBlock = await soDiscardBlocked(sb, docNo, soHasDownstream);
  if (discardBlock) return c.json(discardBlock.body as any, discardBlock.code);

  const currentVersion = Number((soRow as { version?: number | string }).version ?? 1);
  const expectedVersionRaw = Number(c.req.query('version'));
  const deleteGrace = !Number.isInteger(expectedVersionRaw) || expectedVersionRaw < 1;
  if (deleteGrace && !soCasGraceOpen(soCasGrace(c))) {
    return c.json({ ...SO_VERSION_REQUIRED, currentVersion }, 428);
  }
  const expectedVersion = deleteGrace ? currentVersion : expectedVersionRaw;
  if (expectedVersion !== currentVersion) return c.json(soVersionConflict(currentVersion), 409);
  if (activeSoEditLease(soRow as SoEditLeaseRow)) return c.json(SO_EDIT_LEASE_CONFLICT, 409);

  const slipImageKey = (soRow as { slip_image_key?: string | null }).slip_image_key ?? null;
  const receiptImageKey = (soRow as { receipt_image_key?: string | null }).receipt_image_key ?? null;
  const { data: itemRows } = await sb.from('mfg_sales_order_items').select('photo_urls').eq('doc_no', docNo);

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

registerHistoryRoutes(mfgSalesOrders);

mfgSalesOrders.post('/:docNo/items/:itemId/override', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId');
  const user = c.get('user');
  if (!(await isPriceOverrideCaller(c))) {
    return c.json({
      error: 'price_override_admin_only',
      message: 'Unit prices follow the SKU Master sell price. Only an admin can override a line price.',
    }, 403);
  }
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;
  /* A delivered / invoiced line's price is frozen (owner 2026-09-15). This side-door had no downstream check at all. */
  { const lineLock = soLineWriteRefusal(await readSoLineFreeze(sb, docNo), [itemId]); if (lineLock) return c.json(lineLock, 409); }
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
  if (Number(i.discount_sen ?? 0) > i.qty * newPrice) {
    return c.json({
      error:    'invalid_discount',
      reason:   'Stored line discount exceeds qty × override price — the line total would go negative.',
      discount: Number(i.discount_sen ?? 0),
      max:      i.qty * newPrice,
    }, 422);
  }

  const lineCost = await readOverrideLineCost(sb, itemId);
  if (!lineCost.ok) return c.json(linesUnreadableBody('the line cost', 'changed', lineCost.error), 503);

  const originalPriceSen = i.unit_price_sen;
  const overridePriceSen = newPrice;
  await sb.from('mfg_so_price_overrides').insert({
    company_id: activeCompanyId(c),
    doc_no: docNo,
    item_id: itemId,
    item_code: i.item_code,
    original_price_sen: originalPriceSen,
    override_price_sen: overridePriceSen,
    reason: body.reason ?? null,
    approved_by: user.id,
  });

  const newLineTotal = (i.qty * newPrice) - i.discount_sen;
  const currentLineCost = lineCost.costSen;
  const { error } = await sb.from('mfg_sales_order_items').update({
    unit_price_sen: newPrice,
    total_sen: newLineTotal,
    total_inc_sen: newLineTotal,
    balance_sen: newLineTotal,
    line_margin_sen: newLineTotal - currentLineCost,
  }).eq('id', itemId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, docNo, c);

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

  await queueAcSoEdit(c, docNo);
  return c.json({ ok: true, itemId, newPrice });
});

const STALE_DERIVATION = Symbol('so-delivery-stale-derivation');
type DeliveryFeeCoreResult = { isFollowup: boolean; sourceDocNo: string | null; total: number } | null;

async function recomputeDeliveryFeeAttempt(
  sb: any, docNo: string, sourceDocNo: string | null, c: any,
): Promise<DeliveryFeeCoreResult | typeof STALE_DERIVATION> {
  const { data: lineRows } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, total_sen, unit_price_sen, discount_sen, qty, line_no, variants')
    .eq('doc_no', docNo).eq('cancelled', false);
  const lines = (lineRows ?? []) as Array<{ id: string; item_code: string; item_group: string | null; total_sen: number | null; unit_price_sen: number | null; discount_sen: number | null; qty: number | null; line_no: number | null; variants: Record<string, unknown> | null }>;
  const deliveryLines = lines.filter((l) => isDeliveryFeeServiceCode(l.item_code));
  /* A fee line already on a DO / SI is frozen (owner 2026-09-15): the rebuild would rewrite it, so it does not run. */
  if (deliveryLines.length > 0) { const fr = await readSoLineFreeze(sb, docNo); if (!fr.ok || deliveryLines.some((l) => fr.freeze.unlinked || fr.freeze.frozenLineIds.has(l.id))) return null; }
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
    if (feeHdrErr) {
      /* eslint-disable-next-line no-console */
      console.error('[so-redetect] header fee read failed — delivery derivation skipped:', docNo, feeHdrErr.message);
      return null;
    }
    const headerFeeSen = Number((feeHdr as { delivery_fee_sen?: number } | null)?.delivery_fee_sen ?? 0);
    if (headerFeeSen <= 0) return null;
  }

  const keptMaxLineNo = Math.max(
    -1,
    ...lines.filter((l) => !isDeliveryFeeServiceCode(l.item_code))
      .map((l) => (typeof l.line_no === 'number' ? l.line_no : -1)),
  );

  const { additionalSen, discountByCode } = recoverOperatorDeliveryState(deliveryLines);

  const DELIVERABLE = new Set(['sofa', 'mattress', 'bedframe']);
  const categoryIds = lines
    .map((l) => String(l.item_group ?? '').toLowerCase())
    .filter((g) => DELIVERABLE.has(g));
  const goodsLines = lines.filter((l) => DELIVERABLE.has(String(l.item_group ?? '').toLowerCase()));
  const goodsCodes = [...new Set(goodsLines.map((l) => l.item_code))];
  let specialModels: { standaloneFee: number; crossCategoryFollowupFee: number }[] = [];
  if (goodsCodes.length > 0) {
    const { data: prodRows } = await scopeToCompany(
      pgrestIn(sb.from('mfg_products').select('code, category, model_id, size_code'), 'code', goodsCodes),
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
          sizeCode: prod?.size_code ?? null,
          buildKey: ((l.variants as { buildKey?: unknown } | null)?.buildKey as string | null) ?? null,
        };
      }),
    );
    const comboModulesById = await loadComboModulesById(sb, c);
    specialModels = await specialDeliveryFeesForLines(sb, deliveryRuleLines, comboModulesById, activeCompanyId(c));
  }

  const _dcfgCid = activeCompanyId(c);
  let dcfgQ2 = sb.from('delivery_fee_config').select('base_fee, cross_category_fee');
  dcfgQ2 = _dcfgCid != null ? dcfgQ2.eq('company_id', _dcfgCid) : dcfgQ2.eq('id', 1);
  const { data: dcfg } = await dcfgQ2.single();
  const cfgSen = {
    baseFee: Number((dcfg as { base_fee?: number } | null)?.base_fee ?? 0) * 100,
    crossCategoryFee: Number((dcfg as { cross_category_fee?: number } | null)?.cross_category_fee ?? 0) * 100,
  };

  const isFollowup = !!sourceDocNo;
  const fee = computeSoDeliveryFee(
    { categoryIds, specialModels, isCrossCategoryFollowup: isFollowup, additionalFee: additionalSen },
    cfgSen,
  );
  const specs = buildDeliveryFeeServiceLines(fee, sourceDocNo);

  const { data: hdr } = await sb.from('mfg_sales_orders')
    .select('debtor_name, venue, customer_delivery_date, company_id').eq('doc_no', docNo).maybeSingle();
  const h = (hdr ?? {}) as { debtor_name?: string | null; venue?: string | null; customer_delivery_date?: string | null; company_id?: number | null };

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

async function redetectCrossCategoryDelivery(
  sb: any, docNo: string, newName: string, newPhone: string | null, c: any,
): Promise<{ isFollowup: boolean; sourceDocNo: string | null; total: number } | null> {
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
          .neq('doc_no', docNo),
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

export async function rederiveDeliveryFee(sb: any, docNo: string, c: any): Promise<void> {
  let storedSource: string | null = null;
  const { data: hdr } = await sb.from('mfg_sales_orders')
    .select('cross_category_source_doc_no').eq('doc_no', docNo).maybeSingle();
  storedSource = (hdr as { cross_category_source_doc_no?: string | null } | null)?.cross_category_source_doc_no ?? null;
  const res = await recomputeDeliveryFeeCore(sb, docNo, storedSource, c);
  if (res === null) await recomputeTotals(sb, docNo, c);
}

/** The transport-fee rule on an edit of a live Houzs order (owner 2026-11-11):
 *  a 422 when THIS change moves the order to a fee place without a fee, or
 *  takes the fee off. null = the edit may proceed. */
async function transportFeeEditRefusal(c: any, sb: any, docNo: string, change: SoTransportFeeChange): Promise<Response | null> {
  const companyCode = (c.get('companyCode') as string | null | undefined) ?? null;
  if (!companyNeedsTransportFee(companyCode)) return null;
  const co = requireActiveCompanyId(c); if (!co.ok) return c.json(co.refusal, 409);
  const problem = await soTransportFeeEditProblem(sb, { docNo, companyId: co.companyId, companyCode, change });
  return problem ? c.json(validationFailedBody([problem]), 422) : null;
}

export const patchMfgSalesOrderHeaderHandler = async (c: any) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (body.branding != null && clientHeaderBranding(body.branding) === null) delete body.branding;

  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'], ['transferTo', 'transfer_to'],
    ['fairDate', 'fair_date'],
    ['address1', 'address1'], ['address2', 'address2'], ['address3', 'address3'],
    ['address4', 'address4'], ['phone', 'phone'], ['note', 'note'],
    ['remark2', 'remark2'], ['remark3', 'remark3'], ['remark4', 'remark4'],
    ['soDate', 'so_date'], ['currency', 'currency'],
    ['customerId', 'customer_id'], ['customerState', 'customer_state'],
    ['customerPoImageB64', 'customer_po_image_b64'],
    ['customerSoNo', 'customer_so_no'],
    ['hubId', 'hub_id'], ['hubName', 'hub_name'],
    ['customerDeliveryDate', 'customer_delivery_date'],
    ['processingDate', 'processing_date'],
    ['amendDateFromCustomer', 'amend_date_from_customer'],
    ['amendedDeliveryDate', 'amended_delivery_date'],
    ['amendReason', 'amend_reason'],
    ['linkedDoDocNo', 'linked_do_doc_no'],
    ['shipToAddress', 'ship_to_address'], ['billToAddress', 'bill_to_address'],
    ['installToAddress', 'install_to_address'],
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'],
    ['city', 'city'], ['postcode', 'postcode'], ['buildingType', 'building_type'],
    ['emergencyContactName', 'emergency_contact_name'],
    ['emergencyContactPhone', 'emergency_contact_phone'],
    ['emergencyContactRelationship', 'emergency_contact_relationship'],
    ['targetDate', 'target_date'],
    ['paymentMethod', 'payment_method'],
    ['installmentMonths', 'installment_months'],
    ['merchantProvider', 'merchant_provider'],
    ['approvalCode', 'approval_code'],
    ['paymentDate', 'payment_date'],
    ['depositSen', 'deposit_sen'],
  ];
  const PHONE_FIELDS = new Set(['phone', 'emergencyContactPhone']);
  const canFinance = canViewScmFinance(c);
  const updates: Record<string, unknown> = {};
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    if (from === 'depositSen' && !canFinance) continue;
    if (PHONE_FIELDS.has(from) && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else if (from === 'venueId') {
      const venueIdValue = venueIdUuidOrNull(body[from]);
      const venueIdBlank = body[from] == null || String(body[from]).trim() === '';
      if (venueIdValue === null && !venueIdBlank) {
        delete body[from];
        continue;
      }
      updates[to] = venueIdValue;
    } else if (from === 'depositSen') {
      updates[to] = Math.max(0, typeof body[from] === 'number' ? (body[from] as number) : 0);
    } else {
      updates[to] = isDateColumn(to) ? dateOrNull(body[from]) : body[from];
    }
  }
  await fitAddressIfTouched(sb, c, docNo, updates);
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

  const agentBeforeFollow = updates['agent'];
  await followSalespersonToAgent(sb as never, updates, body);
  const agentFollowedSalesperson = updates['agent'] !== agentBeforeFollow;
  const beforeCols = map.map(([, snake]) => snake)
    .concat(['status', 'version', 'edit_lease_token', 'edit_lease_expires_at', 'edit_lease_user_id', 'project_id', 'fair_match', 'sales_exemption_expiry'])
    .join(', ');
  const { data: before, error: beforeError } = await sb.from('mfg_sales_orders').select(beforeCols).eq('doc_no', docNo).maybeSingle();
  if (beforeError) return c.json({ error: 'load_failed', reason: beforeError.message }, 500);
  if (!before) return c.json({ error: 'not_found' }, 404);
  const beforeRecord = before as unknown as Record<string, unknown>;
  /* A picked EVENT is recorded exactly (owner 2026-09-24). Resolved BEFORE the
     unchanged fields drop out: another event at the same venue changes no mapped
     column, and the save would otherwise answer "nothing to do". */
  const fairLink = await fairLinkForEdit({
    db: c.env?.DB as unknown as FairDb, companySql: activeCompanySql(c, 'p.company_id'), body, stored: beforeRecord,
    keyerId: () => editFairKeyerId({ sb, scope: (q) => scopeToCompany(q, c), docNo, editorId: Number(c.get('houzsUser')?.id ?? NaN) }),
  });
  /* HC-0161: a DRAFT whose re-picked fair links to no booth would only be
     refused at Confirm, with no reason given — say it here, at Save. A
     confirmed order still saves; Fair Links settles it. */
  if (fairLink?.problem && beforeRecord.status === 'DRAFT' && companyUsesKeyerFair(c.get('companyCode'))) {
    return c.json(validationFailedBody([fairLink.problem]), 422);
  }
  if (fairLink && (fairLink.project_id !== (beforeRecord.project_id == null ? null : Number(beforeRecord.project_id)) || fairLink.fair_match !== beforeRecord.fair_match)) {
    updates['project_id'] = fairLink.project_id;
    updates['fair_match'] = fairLink.fair_match;
  }
  if (body['fairStart'] !== undefined) {
    const fairDay = fairDayOnSave(body, String(updates['so_date'] ?? beforeRecord.so_date ?? '').slice(0, 10) || null);
    updates['fair_date'] = fairDay;
    body['fairDate'] = fairDay;
  } else {
    delete updates['fair_date'];
    delete body['fairDate'];
  }
  /* No fair, ticked on an edit (owner 2026-10-19: a scan draft cannot be confirmed
     without a fair or this). A decided state, as on create; written only when it
     changes. Unticking alone changes nothing — picking a fair does. */
  if (body.noFair === true && !fairLink && (beforeRecord.fair_match !== 'NO_FAIR' || beforeRecord.project_id != null)) {
    Object.assign(updates, { project_id: null, fair_match: 'NO_FAIR', fair_date: null }); body['fairDate'] = null;
  }
  for (const [from, to] of map) {
    if (!(to in updates) || norm(updates[to]) !== norm(beforeRecord[to])) continue;
    delete updates[to];
    delete body[from];
  }
  if ('customer_delivery_date' in updates) {
    const stored = beforeRecord.status === 'DRAFT' ? null : beforeRecord.sales_exemption_expiry as string | null;
    const seed = exemptionExpirySeed(stored, updates['customer_delivery_date'] as string | null);
    if (seed) updates['sales_exemption_expiry'] = seed;
  }

  const hasHeaderFieldChanges = Object.keys(updates).length > 0;
  const lease = soHeaderLeaseIntent(body, before as SoEditLeaseRow, hasHeaderFieldChanges, soCallerUserId(c));
  const { reserve: reserveForLineWrites, complete: completeLineWrites, token: requestedLeaseToken } = lease;
  if (lease.refusal === 'invalid') {
    return c.json({ error: 'so_edit_lease_invalid', message: 'The save lease is invalid. Refresh the order and try again.' }, 400);
  }
  const currentVersion = Number((before as unknown as { version?: number | string }).version ?? 1);
  if (!hasHeaderFieldChanges && !reserveForLineWrites && !completeLineWrites) {
    return c.json({ ok: true, changed: 0, version: currentVersion });
  }
  if (lease.refusal === 'held') return c.json(SO_EDIT_LEASE_CONFLICT, 409);

  if (reserveForLineWrites && lease.active === requestedLeaseToken) {
    return c.json({ ok: true, docNo, version: currentVersion, reserved: true, leaseToken: requestedLeaseToken });
  }

  const headerGrace = body.version === undefined;
  if (headerGrace && !soCasGraceOpen(soCasGrace(c))) {
    return c.json({ ...SO_VERSION_REQUIRED, currentVersion }, 428);
  }
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

  if (body.phone !== undefined) {
    const patchPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!patchPhone) {
      return c.json({ error: 'phone_required', reason: 'A phone number is required on every sales order.' }, 400);
    }
  }

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
  /* VENUE IS COMPULSORY ON A LIVE ORDER (owner 2026-10-05: "either sales from
     showroom or sales from any project"). Confirm already demands one
     (so-confirm-gate.ts rule 3); this stops an edit taking it away again. Only
     when THIS patch touches the venue, so a legacy venue-less order stays
     editable, and a DRAFT may still clear it. */
  if (('venue' in updates || 'venue_id' in updates)
    && beforeRecord.status !== 'DRAFT' && beforeRecord.status !== 'CANCELLED') {
    const after = (k: string) => String((k in updates ? updates[k] : beforeRecord[k]) ?? '').trim();
    if (!after('venue') && !after('venue_id')) {
      return c.json(validationFailedBody([{
        code: 'venue_required',
        message: 'A venue is required: pick the showroom or the project this sale was made at.',
        field: 'Venue',
      }]), 422);
    }
  }
  if (body['venue'] !== undefined) {
    updates['venue_source'] = 'MANUAL' satisfies VenueSource;
    /* FAIR LINK (owner 2026-09-13) — the venue just moved, so whatever fair this
       order was linked to is now a claim about a place it was not written at.
       A picked EVENT was linked above; a place alone (Others) runs the same
       venue + date + brand detection create does (HC-0094), and what it cannot
       settle stays PENDING / AMBIGUOUS / UNMATCHED for the reconcile and the
       pending screen. */
    if (!fairLink && body.noFair !== true) {
      const fair = await resolveFairForSave({
        db: c.env?.DB as unknown as FairDb,
        companySql: activeCompanySql(c, 'p.company_id'),
        venue: typeof body['venue'] === 'string' ? body['venue'] : null,
        organizer: null,
        picked: null,
        soDate: String(updates['so_date'] ?? beforeRecord.so_date ?? '').slice(0, 10),
        brand: typeof (updates['branding'] ?? beforeRecord.branding) === 'string' ? String(updates['branding'] ?? beforeRecord.branding) : null,
      });
      updates['project_id'] = fair.projectId;
      updates['fair_match'] = fair.projectId != null ? 'PICKED' : fair.match;
      updates['fair_date'] = null;
      body['fairDate'] = null;
    }
  }

  let reboundWarehouseId: string | null = null;
  let rebindLineIds: string[] = [];

  if (body['customerState'] !== undefined) {
    updates['customer_country'] = await deriveCountryFromState(
      sb,
      body['customerState'] as string | null,
    );
    const feeRefusal = await transportFeeEditRefusal(c, sb, docNo, {
      kind: 'header', state: (body['customerState'] as string | null) ?? null, country: (updates['customer_country'] as string | null) ?? null,
    });
    if (feeRefusal) return feeRefusal;
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

  let variantOffenders: VariantOffender[] = [];
  let kivOffenders: ColourKivOffender[] = [];

  if (body['processingDate'] !== undefined && body['processingDate'] !== null && body['processingDate'] !== '') {
    const { data: liveItems } = await sb
      .from('mfg_sales_order_items')
      .select('id, item_code, item_group, variants, cancelled')
      .eq('doc_no', docNo);
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
    if (proc !== undefined) {
      const storedProc = soDateYmd(origProc) ?? '';
      const nextProc = soDateYmd(norm(proc)) ?? '';
      if (storedProc !== '' && nextProc !== storedProc && !hasHouzsPerm(c, PROCESSING_DATE_PO_OVERRIDE_KEY)
        && processingDateFrozenByPo({ storedProc, nextProc, hasLivePo: await soHasLivePo(sb, docNo) })) {
        return c.json(PROCESSING_DATE_PO_LOCKED, 409);
      }
    }
  }

  let afterDo: { targets: AfterDoTarget[]; companyId: number } | null = null;
  let afterDoCopyCols: string[] = [];
  if (body['afterDo'] === true) {
    const co = requireActiveCompanyId(c); if (!co.ok) return c.json(co.refusal, 409);
    const open = await openAfterDo(sb, docNo, hasHouzsPerm(c, SO_EDIT_AFTER_DO_PERMISSION), co.companyId);
    if (!open.ok) return c.json(open.body, open.status);
    const refusal = afterDoHeaderRefusal(open.targets, open.invoicedWithoutDo);
    if (refusal) return c.json(refusal, 409);
    afterDo = { targets: open.targets, companyId: co.companyId };
  }

  /* Owner 2026-06-12 — processing-date lock: once the processing day has
     passed (midnight MYT after), the SO is what we PO to the supplier — every
     header edit is rejected wholesale. Status transitions (/status route),
     the payments ledger and PO/DO conversions do NOT come through this PATCH
     and stay open. Sits AFTER the cancelled/downstream-agnostic validations
     above but before any write. (`before` carries processing_date via
     the map above.) */
  /* Owner 2026-08-12 — the PO lock (every company) reaches the SAME field-scoped
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
    const beforeRowProc = before as unknown as Record<string, unknown>;
    const changedSchedule = lockedColumnsChanged(updates, beforeRowProc, {
      superAdminClearsProcessingDate: patchDateLocked ? superAdminClearsProc : false,
    }).filter((col) => !afterDo || !(col in SO_AFTER_DO_CUSTOMER_COLS));
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
    cascadedDeliveryClear = cascadeCols.length > 0;
    const effDelivAfterCascade = cascadedDeliveryClear ? null : effDeliv;
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

  const beforeRowAll = before as unknown as Record<string, unknown> | null;
  let resolvedNewCustomerId: string | null = null;
  let customerIdentityChanged = false;
  let reNewName = '';
  let reNewPhone: string | null = null;
  {
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
      if (lock && afterDo && lock.error === 'so_has_downstream') {
        const blocked = afterDoBlockedCols(changedLocked);
        if (blocked.length > 0) return c.json(afterDoFieldsRefusal(blocked), 409);
        afterDoCopyCols = changedLocked;
      } else if (lock) {
        return c.json({
          error: 'so_identity_locked',
          message: 'SO has a Delivery Order / Sales Invoice — customer, branding, address, reference and value fields are locked. Payment and remarks can still be edited.',
          lockedFields: changedLocked,
        }, 409);
      }
    }
  }

  const leaseExpiryIso = soEditLeaseExpiryIso();
  const operationLeaseToken = requestedLeaseToken || crypto.randomUUID();
  updates.edit_lease_token = operationLeaseToken;
  updates.edit_lease_expires_at = leaseExpiryIso;
  updates.edit_lease_user_id = soCallerUserId(c);  // WHO holds it - 0348, docs/bugs/0630

  const casCo = requireActiveCompanyId(c); if (!casCo.ok) return c.json(casCo.refusal, 409);
  const { data: casRows, error: casError } = await sb.rpc('apply_so_header_cas', {
    p_doc_no: docNo,
    p_expected_version: clientVersion,
    p_required_lease: lease.takeover ?? (requestedLeaseToken && !reserveForLineWrites ? requestedLeaseToken : null),
    p_patch: updates,
    p_recustomer: customerIdentityChanged,
    p_customer_name: reNewName || null,
    p_customer_phone: reNewPhone,
    p_customer_email: typeof body['email'] === 'string' && (body['email'] as string).trim()
      ? (body['email'] as string).trim()
      : null,
    p_apply_warehouse: Boolean(reboundWarehouseId),
    p_warehouse_id: reboundWarehouseId,
    p_rebind_line_ids: rebindLineIds.length > 0 ? rebindLineIds : null,
    p_apply_delivery_date: body['customerDeliveryDate'] !== undefined || cascadedDeliveryClear,
    p_delivery_date: cascadedDeliveryClear ? null : dateOrNull(body['customerDeliveryDate']),
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

  if (!hasHeaderFieldChanges && reserveForLineWrites) {
    return c.json({ ok: true, docNo, version: savedVersion, reserved: true, leaseToken: operationLeaseToken });
  }

  let crossCategoryRedetect: { isFollowup: boolean; sourceDocNo: string | null; total: number } | null = null;
  if (customerIdentityChanged) {
    try {
      crossCategoryRedetect = await redetectCrossCategoryDelivery(sb, docNo, reNewName, reNewPhone, c);
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.error('[mfg-so] customer-change re-detect failed:', e);
    }
  }

  if (before) {
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
    /* The fair, named, whenever this edit moved it (owner 2026-10-19) — fair-audit.ts. */
    await recordFairChange({
      sb, db: c.env?.DB as unknown as FairDb, companySql: activeCompanySql(c, 'p.company_id'), docNo,
      before: fairStateOf(beforeRow), after: fairStateOf({ ...beforeRow, ...updates }), how: 'edit',
      actorId: user.id, actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    });
  }

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
  if (!releasedLease) {
    // eslint-disable-next-line no-console
    console.warn('[mfg-so] header saved but edit lease was no longer ours to release:', docNo, savedVersion);
  }

  await queueAcSoEdit(c, docNo, [], [], Object.keys(updates));

  let doCopyFailed: string[] = [];
  if (afterDo && afterDoCopyCols.length > 0) {
    const { data: soRow, error: soRowErr } = await sb.from('mfg_sales_orders')
      .select(Object.keys(SO_AFTER_DO_CUSTOMER_COLS).join(', ')).eq('doc_no', docNo).maybeSingle();
    doCopyFailed = soRow && !soRowErr
      ? await copyCustomerDetailsToDos(sb, { companyId: afterDo.companyId, actor: c.get('houzsUser') ?? null, soDocNo: docNo }, soRow as Record<string, unknown>, afterDoCopyCols, afterDo.targets)
      : afterDo.targets.map((t) => t.do_number ?? t.id);
  }

  return c.json({
    ok: true,
    docNo,
    version: savedVersion,
    ...(afterDo && afterDoCopyCols.length > 0 ? { doCopied: afterDo.targets.map((t) => t.do_number), doCopyFailed } : {}),
    ...(crossCategoryRedetect ? {
      deliveryRedetected: true,
      crossCategory: crossCategoryRedetect.isFollowup,
      crossCategorySourceDocNo: crossCategoryRedetect.sourceDocNo,
      deliveryFeeSen: crossCategoryRedetect.total,
    } : {}),
  });
};

mfgSalesOrders.post('/:docNo/items/:itemId/price-after-do', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId');
  const user = c.get('user');
  if (!hasHouzsPerm(c, SO_EDIT_PRICE_AFTER_DO_PERMISSION)) return c.json(AFTER_DO_PRICE_FORBIDDEN, 403);
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const co = requireActiveCompanyId(c); if (!co.ok) return c.json(co.refusal, 409);
  let body: { unitPriceSen?: unknown; discountSen?: unknown; reason?: unknown };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const unit = Number(body.unitPriceSen), discount = Number(body.discountSen ?? 0);
  if (!Number.isInteger(unit) || unit < 0) return c.json({ error: 'invalid_price', message: 'Unit price must be zero or more.' }, 400);
  if (!Number.isInteger(discount) || discount < 0) return c.json({ error: 'invalid_discount', message: 'Discount must be zero or more.' }, 400);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  const open = await openAfterDo(sb, docNo, true, co.companyId);
  if (!open.ok) return c.json(open.body, open.status);
  if (open.invoicedWithoutDo) return c.json(AFTER_DO_INVOICED, 409);
  const { data: line, error: lineErr } = await scopeSoItemToDocument(
    sb.from('mfg_sales_order_items').select('item_code, qty, unit_price_sen, discount_sen, line_cost_sen'), docNo, itemId,
  ).maybeSingle();
  if (lineErr) return c.json({ error: 'downstream_check_failed', message: 'Could not read the line, so nothing was changed. Try again.' }, 409);
  if (!line) return c.json({ error: 'not_found' }, 404);
  const prev = line as { item_code: string | null; qty: number; unit_price_sen: number; discount_sen: number; line_cost_sen: number | null };
  const doLines = await readDoLinesOfSoLine(sb, itemId, co.companyId, open.targets);
  if (doLines === null) return c.json({ error: 'downstream_check_failed', message: 'Could not read the Delivery Order lines, so nothing was changed. Try again.' }, 409);
  if (doLines.length === 0) return c.json(AFTER_DO_PRICE_NOT_DELIVERED, 409);
  const returnedDos = open.targets.filter((t) => t.returned && doLines.some((d) => d.delivery_order_id === t.id));
  if (returnedDos.length > 0) return c.json(afterDoPriceReturnedRefusal(returnedDos.map((t) => t.do_number ?? t.id)), 409);
  const qty = Number(prev.qty);
  if (discount > qty * unit) {
    return c.json({ error: 'invalid_discount', message: 'Discount cannot be more than qty x unit price.', discount, max: qty * unit }, 422);
  }
  if (unit === Number(prev.unit_price_sen) && discount === Number(prev.discount_sen)) return c.json({ ok: true, unchanged: true });

  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;
  const lineTotal = senOrZero(qty * unit - discount);
  const { error } = await scopeSoItemToDocument(
    sb.from('mfg_sales_order_items').update({
      unit_price_sen: unit, discount_sen: discount,
      total_sen: lineTotal, total_inc_sen: lineTotal, balance_sen: lineTotal,
      line_margin_sen: lineTotal - senOrZero(prev.line_cost_sen),
    }),
    docNo,
    itemId,
  );
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, docNo, c);
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: prev.item_code },
      ...(unit !== prev.unit_price_sen ? [{ field: 'unitPriceSen', from: prev.unit_price_sen, to: unit }] : []),
      ...(discount !== prev.discount_sen ? [{ field: 'discountSen', from: prev.discount_sen, to: discount }] : []),
    ],
    note: `Price changed after DO${reason ? `: ${reason}` : ''}`,
  });
  await queueAcSoEdit(c, docNo);
  const who = { companyId: co.companyId, actor: c.get('houzsUser') ?? null, soDocNo: docNo };
  const priced = { item_code: prev.item_code, qty, unit_price_sen: unit, discount_sen: discount };
  const failed = await copyLinePriceToDos(sb, who, priced, doLines, open.targets);
  const siFailed = await copyLinePriceToInvoices(sb, who, priced, doLines.map((d) => d.id));
  const doNumbers = [...new Set(doLines.map((d) => open.targets.find((t) => t.id === d.delivery_order_id)?.do_number ?? d.delivery_order_id))];
  return c.json({ ok: true, doNumbers, ...(failed.length > 0 ? { doCopyFailed: failed } : {}), ...(siFailed.length > 0 ? { siCopyFailed: siFailed } : {}) });
});

mfgSalesOrders.patch('/:docNo', patchMfgSalesOrderHeaderHandler);

export async function recomputeTotals(sb: any, docNo: string, c: any) {
  const { data: items, error: itemsErr } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, variants, qty, total_sen, line_cost_sen, line_margin_sen, set_cost_day')
    .eq('doc_no', docNo).eq('cancelled', false);
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[so-recompute] item read failed — header left unchanged:', docNo, itemsErr.message);
    return;
  }
  type Row = { id: string; item_code: string; item_group: string; variants: Record<string, unknown> | null; qty: number; total_sen: number; line_cost_sen: number; line_margin_sen: number | null; set_cost_day?: string | null };
  const rows = (items ?? []) as Row[];

  const ruleTwoSets = new Set(rows.filter((r) => r.set_cost_day).map((r) => sofaModelOf(r.item_code)));
  const sofaRows = rows.filter((r) => (r.item_group ?? '').toLowerCase() === 'sofa' && !ruleTwoSets.has(sofaModelOf(r.item_code)));
  if (sofaRows.length > 0) {
    const { rows: combos, error: combosErr } = await loadMasterSofaComboCosts(sb, c);
    if (combosErr) {
      /* eslint-disable-next-line no-console */
      console.error('[so-recompute] combo read failed — header left unchanged:', docNo, combosErr);
      return;
    }
    if (combos.length > 0) {
      const fabricCodes = [...new Set(sofaRows.map((r) => String((r.variants ?? {} as Record<string, unknown>).fabricCode ?? '')).filter(Boolean))];
      const tierByFabric = new Map<string, SofaPriceTier>();
      if (fabricCodes.length > 0) {
        const { data: fabs, error: fabsErr } = await scopeToCompany(
          sb.from('fabric_trackings').select('fabric_code, price_tier, sofa_price_tier').in('fabric_code', fabricCodes),
          c,
        );
        if (fabsErr) {
          /* eslint-disable-next-line no-console */
          console.error('[so-recompute] fabric tier read failed — header left unchanged:', docNo, fabsErr.message);
          return;
        }
        for (const f of (fabs ?? []) as Array<{ fabric_code: string; price_tier: SofaPriceTier | null; sofa_price_tier: SofaPriceTier | null }>) {
          tierByFabric.set(f.fabric_code, (f.sofa_price_tier ?? f.price_tier ?? 'PRICE_2'));
        }
      }
      const { data: hdrDate, error: dateErr } = await scopeToCompany(
        sb.from('mfg_sales_orders').select('so_date').eq('doc_no', docNo),
        c,
      ).maybeSingle();
      if (dateErr) {
        /* eslint-disable-next-line no-console */
        console.error('[so-recompute] order date read failed — header left unchanged:', docNo, dateErr.message);
        return;
      }
      const day = comboCostAsOf((hdrDate as { so_date?: string | null } | null)?.so_date ?? null) ?? todayMyt();
      const spread = planComboCostSpread(sofaRows, combosStandingOn(combos, day), (code) => tierByFabric.get(code) ?? 'PRICE_2', day);
      for (const m of sofaRows) {
        const newLineCost = spread.get(m.id);
        if (newLineCost === undefined) continue;
        const q = Math.max(1, m.qty || 1);
        m.line_cost_sen = newLineCost;
        m.line_margin_sen = (m.total_sen || 0) - newLineCost;
        const { error: spreadErr } = await sb.from('mfg_sales_order_items').update({
          line_cost_sen:   newLineCost,
          unit_cost_sen:   Math.round(newLineCost / q),
          line_margin_sen: m.line_margin_sen,
        }).eq('id', m.id);
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

  for (const it of rows) {
    const margin = (it.total_sen || 0) - (it.line_cost_sen || 0);
    if (Number(it.line_margin_sen) === margin) continue;
    const { error: marginErr } = await scopeToCompany(
      sb.from('mfg_sales_order_items').update({ line_margin_sen: margin }).eq('id', it.id),
      c,
    );
    if (marginErr) {
      if (sb?.__atomicCommand === true) {
        throw new Error(`SO line margin update failed: ${marginErr.message}`);
      }
      /* eslint-disable-next-line no-console */
      console.error('[so-recompute] line margin update failed — that line left stale:', docNo, it.id, marginErr.message);
    }
  }

  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, service = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0, serviceCost = 0;
  for (const it of rows) {
    const lineTotal = it.total_sen || 0;
    const lineCost  = it.line_cost_sen || 0;
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
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
    if (hdrErr) {
      /* eslint-disable-next-line no-console */
      console.error('[so-recompute] delivery fee read failed — header left unchanged:', docNo, hdrErr.message);
      return;
    }
    deliverySen = Number((hdrFee as { delivery_fee_sen?: number } | null)?.delivery_fee_sen ?? 0);
  }
  const grandTotal  = total + deliverySen;
  const grandMargin = grandTotal - totalCost;
  // Upsales / drop sales for Event Commission (owner 2026-10-20): the header before the write.
  const totalsBefore = await snapshotSoTotals(sb, docNo);
  const { error: updErr } = await sb.from('mfg_sales_orders').update({
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    service_sen: service,
    service_cost_sen: serviceCost,
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
  if (updErr) {
    if (sb?.__atomicCommand === true) {
      throw new Error(`SO totals update failed: ${updErr.message}`);
    }
    /* eslint-disable-next-line no-console */
    console.error('[so-recompute] header update failed — totals left STALE:', docNo, updErr.message);
    return;
  }
  await recordSoTotalChange(sb, c, docNo, totalsBefore, { goodsSen: mattressSofa + bedframe + accessories + others, totalSen: grandTotal });
}

mfgSalesOrders.post('/:docNo/items', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return refuseWithoutWriting(c, { error: 'invalid_json' }, 400); }
  if ((it.variants as Record<string, unknown> | null)?.sofaComboIncluded !== undefined
    || (it.variants as Record<string, unknown> | null)?.sofaAccessoryGroupKey !== undefined
    || (it.variants as Record<string, unknown> | null)?.sofaAccessoryPieceIds !== undefined
    || (it.variants as Record<string, unknown> | null)?.sofaAccessoryOfKey !== undefined
    || (it.variants as Record<string, unknown> | null)?.sofaAccessories !== undefined) {
    return refuseWithoutWriting(c, { error: 'sofa_combo_requires_complete_order', reason: 'Save the sofa and its accessories together as a complete order.' }, 400);
  }

  /* Trimmed — a whitespace-only code used to pass this truthy check and then
     slide through validateItemCodes' skip-as-no-op (owner 2026-08-08: every
     line is a catalog SKU, so an add-line ALWAYS names one). */
  if (!String(it.itemCode ?? '').trim()) return refuseWithoutWriting(c, { error: 'item_code_required' }, 400);

  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c), { requireActive: true });
    if (!codeCheck.ok) return refuseWithoutWriting(c, unknownItemCodeResponse(codeCheck.unknown, codeCheck.inactive), 409);
  }

  /* Line-add stays open while the order has something left to convert (owner 2026-09-15, shared/so-line-freeze.ts). */
  let afterDoTarget: AfterDoTarget | null = null;
  let afterDoCompanyId = 0;
  if (it.afterDo === true) {
    const co = requireActiveCompanyId(c); if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);
    const open = await openAfterDo(sb, docNo, hasHouzsPerm(c, SO_EDIT_AFTER_DO_PERMISSION), co.companyId);
    if (!open.ok) return refuseWithoutWriting(c, open.body, open.status);
    const service = await catalogSaysService(sb, String(it.itemCode).trim(), co.companyId);
    if (service === null) return refuseWithoutWriting(c, { error: 'downstream_check_failed', message: 'Could not read the product, so nothing was added. Try again.' }, 409);
    if (!service) return refuseWithoutWriting(c, AFTER_DO_SERVICE_ONLY, 409);
    const pick = pickAfterDoTarget(open.targets, typeof it.targetDoId === 'string' ? it.targetDoId : null);
    if (!pick.ok) return refuseWithoutWriting(c, pick.refusal, 409);
    afterDoTarget = pick.target;
    afterDoCompanyId = co.companyId;
  }

  const freezeRead = await readSoLineFreeze(sb, docNo);
  if (!freezeRead.ok || (freezeRead.fullyFrozen && !afterDoTarget)) return refuseWithoutWriting(c, freezeRead.ok ? SO_FULLY_FROZEN_REFUSAL : freezeRead.refusal, 409);

  if (await selfScopedSalesBlocked(c, docNo)) return refuseWithoutWriting(c, { error: 'not_found' }, 404);
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  {
    const mainMix = await lineMixRefusal(sb, 'mfg_sales_order_items', docNo, null, it.itemCode as string, activeCompanyId(c));
    if (mainMix) return refuseWithoutWriting(c, mainMix.body, mainMix.status);
  }

  const { data: header } = await sb.from('mfg_sales_orders').select('debtor_code, debtor_name, agent, branding, venue, customer_delivery_date, customer_state, sales_location, processing_date, status, customer_id').eq('doc_no', docNo).maybeSingle();
  if (!header) return refuseWithoutWriting(c, { error: 'not_found' }, 404);
  /* Owner 2026-06-12 — processing-date lock: no line ADD once a CONFIRMED-or-later
     SO's processing day has passed (already PO'd to the supplier). Owner
     2026-08-12 — nor once a live PO actually exists (every company since 2026-11-09), which is the case
     this rule was always describing and only sometimes catching. */
  if (!afterDoTarget && soProcessingLocked(header as { processing_date?: string | null; status: string | null })) {
    return refuseWithoutWriting(c, SO_PROCESSING_LOCKED_RESPONSE, 409);
  }
  if (!afterDoTarget && await soPoLocked(sb, docNo)) {
    return refuseWithoutWriting(c, SO_PO_LOCKED_RESPONSE, 409);
  }
  const addLineDateRefusal = soLineDateRefusal({
    processingDate: (header as { processing_date?: string | null }).processing_date,
    lineDeliveryDates: [it.lineDeliveryDate],
  });
  if (addLineDateRefusal) return refuseWithoutWriting(c, addLineDateRefusal, 400);
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

  const badQty = invalidQtyResponse(it.qty, it.itemCode);
  if (badQty) return refuseWithoutWriting(c, badQty, 422);
  /* Owner 2026-07-17 — see unexplainedExtraAddonResponse. Gating create only
     would leave the same unexplained charge reachable one click later via
     "add line", which is exactly how the qty gate above was found short. */
  const badExtra = unexplainedExtraAddonResponse(it.variants, it.itemCode);
  if (badExtra) return refuseWithoutWriting(c, badExtra, 422);
  const qty = Number(it.qty ?? 1);
  const discount = Number(it.discountSen ?? 0);
  const itemCodeStr = String(it.itemCode ?? '');
  const variantsObj = (it.variants as MfgItemForRecompute['variants']) ?? null;
  {
    const { product, model, lookupError } = await loadProductAndModel(sb, itemCodeStr, activeCompanyId(c));
    if (lookupError) return refuseWithoutWriting(c, variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(
      product,
      model,
      variantsObj as Parameters<typeof checkAllowedOptions>[2],
    );
    if (aoErr) return refuseWithoutWriting(c, { ...aoErr, itemCode: itemCodeStr }, 400);
  }
  if ((header as { processing_date?: string | null }).processing_date) {
    const addedLine = [{
      itemCode: itemCodeStr,
      group: (it.itemGroup as string | null | undefined) ?? null,
      variants: variantsObj as Record<string, unknown> | null,
    }];
    const offenders = findIncompleteVariantLines(addedLine);
    if (offenders.length > 0) {
      return refuseWithoutWriting(c, {
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
      return refuseWithoutWriting(c, {
        error: 'fabric_colour_kiv',
        message: `${itemCodeStr} — fabric colour is still KIV. This order already has a Processing Date, so confirm the colour before adding the line.`,
        offenders: kiv,
      }, 409);
    }
  }
  const [cachedConfig, productLite, fabricLite, sofaCombosLite, sellingTiersLite, fabricAddonConfigLite, specialAddonsLite, modelOverridesLite, compartmentOverridesLite] = await Promise.all([
    loadMaintenanceConfig(sb, activeCompanyId(c)),
    loadProductByCode(sb, itemCodeStr, activeCompanyId(c)),
    loadFabricByCode(sb, variantsObj?.fabricCode ?? null),
    loadSellingSofaCombos(sb, c),
    loadFabricSellingTiers(sb, (variantsObj as { fabricId?: string } | null)?.fabricId ?? null),
    loadFabricTierAddonConfig(sb, activeCompanyId(c)),
    loadSpecialAddons(sb, activeCompanyId(c)),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
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
  const addLineFreeItemCampaignId = String((it.freeItemCampaignId as string | null | undefined) ?? '').trim();
  const addLinePwpCodeEarly = String((variantsObj as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim();
  if (addLineFreeItemCampaignId && addLinePwpCodeEarly) {
    return refuseWithoutWriting(c, { error: 'free_and_pwp_exclusive', reason: 'A line cannot be both a free-item and a PWP reward.' }, 400);
  }
  let addLineFreeItem: { campaignId: string; campaignName: string } | null = null;

  let addLinePwpBaseSen: number | null = null;
  let addLinePwpSofaComboIds: string[] | null = null;
  let addLinePwpClaimed: { code: string; companyId: number; prevStatus: string } | null = null;
  const addLinePwpCode = String((variantsObj as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim();
  if (addLinePwpCode) {
    if (qty !== 1) {
      return refuseWithoutWriting(c, {
        error: 'invalid_qty',
        reason: 'A PWP reward line must have quantity 1.',
        itemCode: itemCodeStr,
        qty,
      }, 422);
    }
    const addLineOwnerStaffId =
      (await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id)) ?? '';
    const pwpCompanyId = activeCompanyId(c);
    if (pwpCompanyId == null) {
      return refuseWithoutWriting(c, {
        error: 'company_unresolved',
        message: 'Cannot tell which company this order belongs to right now. Reload and try again.',
      }, 409);
    }
    const pwpClaimResult = await claimPwpForSingleLine(sb, {
      code: addLinePwpCode,
      companyId: pwpCompanyId,
      docNo,
      itemCode: productLite?.code ?? itemCodeStr,
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
    addLinePwpBaseSen,
    addLinePwpSofaComboIds,
    specialAddonsLite,
    sofaModuleCostRowsLite,
    modelOverridesLite,
    compartmentOverridesLite,
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
  const unit = addLineFreeItem ? 0 : recomputed.unit_price_sen;
  if (!Number.isFinite(discount) || discount < 0 || discount > qty * unit) {
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
  const unitCost = recomputed.unit_cost_sen > 0
    ? recomputed.unit_cost_sen
    : await snapshotUnitCostSen(sb, itemCodeStr, Number(it.unitCostSen ?? 0), c);
  const lineCost = unitCost * qty;
  const sizeSkuMap = await loadSizeSkuMap(sb, [itemCodeStr], c);
  const hasExplicitLineDate = it.lineDeliveryDate !== undefined && it.lineDeliveryDate !== null;
  const lineDeliveryDate = hasExplicitLineDate
    ? (it.lineDeliveryDate as string | null)
    : (header.processing_date ? (header.customer_delivery_date as string | null) ?? null : null);
  const lineDeliveryDateOverridden = hasExplicitLineDate
    ? (it.lineDeliveryDateOverridden === undefined ? true : Boolean(it.lineDeliveryDateOverridden))
    : Boolean(it.lineDeliveryDateOverridden ?? false);
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
  /* SKU wins — lib/sku-category.ts, docs/bugs/0514. The create door already
     resolved the group from the product master; this door copied the request
     (`it.itemGroup ?? 'others'`) until 2026-09-12, so a sofa added to an
     existing order could land on `others`, lose hard binding, and read SHORT in
     MRP with its purchase order open (docs/bugs/0813's shape, on the SO). The
     phone's add-item payload sends `itemGroup: l.itemGroup || "others"`. */
  const addGroupOf = await skuCategoryResolver(sb, [{ materialKind: 'mfg_product', itemCode: itemCodeStr }], activeCompanyId(c) ?? null);
  const addItemGroup = addGroupOf({ materialKind: 'mfg_product', itemCode: itemCodeStr, itemGroup: it.itemGroup }) ?? 'others';
  const addLater = await openDirectChangeWindow(c, sb, docNo);
  const addChangeDay = todayMyt();
  const baseRow = {
    doc_no: docNo,
    ...(addLater ? { cost_day: addChangeDay } : {}),
    line_date: dateOrNull(it.lineDate) ?? todayMyt(),
    debtor_code: header.debtor_code,
    debtor_name: header.debtor_name,
    agent: header.agent,
    item_group: addItemGroup,
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
    variants: canonicalizeVariants(
      String(it.itemGroup ?? ''),
      addLineFreeItem
        ? { ...(stripFreeItem(it.variants) as Record<string, unknown> | null ?? {}), freeItem: addLineFreeItem }
        : ((stripFreeItem(it.variants) as Record<string, unknown> | null) ?? null),
    ),
    unit_cost_sen: unitCost,
    line_cost_sen: lineCost,
    line_margin_sen: lineTotal - lineCost,
    divan_price_sen:         recomputed.divan_price_sen,
    leg_price_sen:           recomputed.leg_price_sen,
    special_order_price_sen: recomputed.special_order_sen,
    custom_specials:         recomputed.custom_specials ?? null,
    line_delivery_date: dateOrNull(lineDeliveryDate),
    line_delivery_date_overridden: lineDeliveryDateOverridden,
    warehouse_id: addLineWarehouseId,
    ...(isServiceLine({ itemGroup: String(it.itemGroup ?? ''), itemCode: itemCodeStr })
      ? { stock_status: 'READY' }
      : {}),
  };

  const addLineCells = (it.variants as { cells?: unknown } | null)?.cells;
  if (
    productLite?.category === 'SOFA' &&
    Array.isArray(addLineCells) && addLineCells.length > 0 &&
    productLite.base_model
  ) {
    if (!sofaModulePricesLite && productLite.base_model) {
      // eslint-disable-next-line no-console
      console.warn(`[so-add-line] no module prices for ${productLite.base_model} — sofa split uses equal weights`);
    }
    const split = splitSofaBuildIntoModuleLines({
      baseModel: productLite.base_model,
      cells: addLineCells,
      buildUnitPriceSen: unit,
      buildUnitCostSen: unitCost,
      modulePrices: sofaModulePricesLite, moduleCostsSen: recomputed.sofa_module_costs_sen,
      depth: String((it.variants as { depth?: unknown } | null)?.depth ?? '24'),
    });
    if (split && split.length > 0) {
      const buildKey = `build-add-${nextLineNo ?? crypto.randomUUID().slice(0, 8)}`;
      const { cells: _cells, freeItem: _clientFreeItem, ...sharedVariants } =
        canonicalizeVariants('sofa', (it.variants as Record<string, unknown> | null) ?? {});
      const moduleDiscounts = distributeBuildDiscount(discount, qty, split.map((s) => Number(s.unitPriceSen) || 0));
      const moduleRows = split.map((s, i) => {
        const moduleVariants: Record<string, unknown> = {
          ...sharedVariants,
          buildKey,
          cellIndex: s.cellIndex,
          x: s.x,
          y: s.y,
          rot: s.rot,
          ...(addLineFreeItem ? { freeItem: addLineFreeItem } : {}),
        };
        const moduleLineTotal = (qty * s.unitPriceSen) - (moduleDiscounts[i] ?? 0);
        const moduleLineCost = qty * s.unitCostSen;
        return {
          ...baseRow,
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
      signalNullWarehouseRows('PATCH /mfg-sales-orders/:docNo/items (sofa split)', docNo, moduleRows as unknown as Array<Record<string, unknown>>);
      const { data: moduleData, error: moduleError } = await sb
        .from('mfg_sales_order_items')
        .insert(stampCompany(moduleRows, c))
        .select('*');
      if (moduleError) {
        if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
        return c.json({ error: 'insert_failed', reason: moduleError.message }, 500);
      }
      const firstRow = (moduleData ?? [])[0] ?? moduleRows[0];
      await recostSofaSetsAfterWrite(sb, c, docNo, addLater, addChangeDay, moduleData ?? [], true);

      await reconcileFreeGiftLinesForSo(sb, docNo, c);
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

      deferAllocationRecompute(c, sb, 'post-line-add');
      await syncSoDeliveredFromDo(sb, [docNo], user.id);

      await queueAcSoEdit(c, docNo, [], ((moduleData ?? []) as Array<{ id?: unknown }>)
        .map((r) => (r?.id == null ? '' : String(r.id))).filter(Boolean));

      return c.json({ item: firstRow }, 201);
    }
  }

  const row = {
    ...baseRow,
    ...(nextLineNo !== null ? { line_no: nextLineNo } : {}),
    description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
  };
  /* Owner 2026-07-23 — auto-derive branding on the single-row add-line path. */
  const rowWithCid = { ...row, company_id: activeCompanyId(c) };
  await deriveLineBrandingFromProduct(sb, [rowWithCid] as unknown as Array<{ item_code?: string | null; branding?: string | null; company_id?: number | null }>, activeCompanyId(c) ?? null);
  signalNullWarehouseRows('PATCH /mfg-sales-orders/:docNo/items (single row)', docNo, [rowWithCid] as unknown as Array<Record<string, unknown>>);
  const { data, error } = await sb.from('mfg_sales_order_items').insert(rowWithCid).select('*').single();
  if (error) {
    if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  await recostSofaSetsAfterWrite(sb, c, docNo, addLater, addChangeDay, [data], true);
  await reconcileFreeGiftLinesForSo(sb, docNo, c);
  await rederiveDeliveryFee(sb, docNo, c);

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

  deferAllocationRecompute(c, sb, 'post-line-add');
  await syncSoDeliveredFromDo(sb, [docNo], user.id);

  await queueAcSoEdit(c, docNo, [], data?.id ? [String(data.id)] : []);

  if (afterDoTarget && data?.id) {
    const put = await addChargeLineToDo(sb, { companyId: afterDoCompanyId, actor: c.get('houzsUser') ?? null, soDocNo: docNo }, String(data.id), afterDoTarget);
    return c.json({ item: data, doNumber: afterDoTarget.do_number, ...(put.ok ? {} : { doCopyFailed: [afterDoTarget.do_number ?? afterDoTarget.id], doCopyError: put.reason }) }, 201);
  }

  return c.json({ item: data }, 201);
});

mfgSalesOrders.patch('/:docNo/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  const lap = stepClock();
  const patchSoIsMigrated = await soIsMigrated((d) => sb.from('mfg_sales_orders').select('doc_no, linked_ac_docno').eq('doc_no', d).maybeSingle(), docNo);
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

  /* Owner 2026-11-21 — a super admin (scm.so.edit_lines_after_do) may change the
     QUANTITY or SPECIFICATION of a PRODUCT line a DO carries; the DO line and
     every live invoice follow, stock re-synced (lib/so-after-do-lines.ts). This
     runs AHEAD of the DEV-32 charge-line path and claims only product lines, so
     the charge-line behaviour below is untouched. */
  let afterDoProduct: (OpenProductLineOk & { companyId: number }) | null = null;
  if (it.afterDo === true && hasHouzsPerm(c, SO_EDIT_LINES_AFTER_DO_PERMISSION)) {
    const co = requireActiveCompanyId(c); if (!co.ok) return c.json(co.refusal, 409);
    const { data: line, error: lineErr } = await scopeSoItemToDocument(sb.from('mfg_sales_order_items').select('item_code'), docNo, itemId).maybeSingle();
    if (lineErr) return c.json({ error: 'downstream_check_failed', message: 'Could not read the line, so nothing was changed. Try again.' }, 409);
    if (!line) return c.json({ error: 'not_found' }, 404);
    const svc = await catalogSaysService(sb, String((line as { item_code?: string | null }).item_code ?? ''), co.companyId);
    if (svc === null) return c.json({ error: 'downstream_check_failed', message: 'Could not read the product, so nothing was changed. Try again.' }, 409);
    if (!svc) {
      const open = await openProductLineAfterDo(sb, true, docNo, itemId, co.companyId, AFTER_DO_LINES_FORBIDDEN);
      if (!open.ok) return c.json(open.body, open.status);
      afterDoProduct = { target: open.target, doLine: open.doLine, siLines: open.siLines, siQtyOnDoLine: open.siQtyOnDoLine, companyId: co.companyId };
    }
  }

  let afterDoLine: { doLine: DoLineOfSoLine; target: AfterDoTarget; companyId: number } | null = null;
  if (it.afterDo === true && !afterDoProduct) {
    const co = requireActiveCompanyId(c); if (!co.ok) return c.json(co.refusal, 409);
    const open = await openAfterDo(sb, docNo, hasHouzsPerm(c, SO_EDIT_AFTER_DO_PERMISSION), co.companyId);
    if (!open.ok) return c.json(open.body, open.status);
    if (open.invoicedWithoutDo) return c.json(AFTER_DO_INVOICED, 409);
    const { data: line, error: lineErr } = await scopeSoItemToDocument(sb.from('mfg_sales_order_items').select('item_code'), docNo, itemId).maybeSingle();
    if (lineErr) return c.json({ error: 'downstream_check_failed', message: 'Could not read the line, so nothing was changed. Try again.' }, 409);
    if (!line) return c.json({ error: 'not_found' }, 404);
    const code = String((line as { item_code?: string | null }).item_code ?? '');
    const service = await catalogSaysService(sb, code, co.companyId);
    if (service === null) return c.json({ error: 'downstream_check_failed', message: 'Could not read the product, so nothing was changed. Try again.' }, 409);
    if (!service || (it.itemCode !== undefined && String(it.itemCode).trim() !== code)) return c.json(AFTER_DO_SERVICE_ONLY, 409);
    const doLines = await readDoLinesOfSoLine(sb, itemId, co.companyId, open.targets);
    if (doLines === null) return c.json({ error: 'downstream_check_failed', message: 'Could not read the Delivery Order lines, so nothing was changed. Try again.' }, 409);
    if (doLines.length > 1) return c.json({ error: 'after_do_split_line', message: 'This charge is split over more than one Delivery Order line. Change it on each Delivery Order instead.' }, 409);
    const target = doLines.length === 1 ? open.targets.find((t) => t.id === doLines[0].delivery_order_id) : undefined;
    if (target?.locked) return c.json(afterDoTargetLockedRefusal([target.do_number ?? target.id]), 409);
    if (target) afterDoLine = { doLine: doLines[0], target, companyId: co.companyId };
  }

  /* A line a live DO / SI carries is frozen; its siblings are not (owner 2026-09-15, shared/so-line-freeze.ts).
     The DEV-32 charge-line path and the super-admin product path (above) are the
     two keys that turn a frozen line back on. */
  const lineLock = soLineWriteRefusal(await readSoLineFreeze(sb, docNo), [itemId]);
  if (lineLock && !((afterDoLine || afterDoProduct) && lineLock.error === 'so_line_frozen')) return c.json(lineLock, 409);

  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  /* Owner 2026-11-21 — a super admin may edit a non-frozen SERVICE / charge line
     stuck on a processing-locked / completed order (on no DO, carries no PO), so
     it skips the processing-date lock below the same way the after-DO paths do. */
  let superAdminFeeWrite = false;
  if (!afterDoLine && !afterDoProduct && it.afterDo !== true && hasHouzsPerm(c, SO_EDIT_LINES_AFTER_DO_PERMISSION)) {
    const { data: ln, error: lnErr } = await scopeSoItemToDocument(sb.from('mfg_sales_order_items').select('item_code, item_group'), docNo, itemId).maybeSingle();
    const l = lnErr ? null : (ln as { item_code?: string | null; item_group?: string | null } | null);
    if (l) superAdminFeeWrite = isServiceLine({ itemGroup: l.item_group ?? null, itemCode: l.item_code ?? null });
  }

  /* Owner 2026-06-12 — processing-date lock: no line EDIT once the processing
     day has passed (the locked order is already PO'd to the supplier). The
     after-DO paths are PAST that lock by definition (the goods already shipped),
     so they skip it; so does the super-admin fee-line edit above. */
  if (!afterDoLine && !afterDoProduct && !superAdminFeeWrite) {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }

  if (it.itemCode !== undefined) {
    const mainMix = await lineMixRefusal(sb, 'mfg_sales_order_items', docNo, itemId, it.itemCode as string, activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  /* Pricing trust boundary (Owner 2026-05-31, see isPosTabletCaller). */
  const posTablet = await isPosTabletCaller(c);

  const { data: prev } = await scopeSoItemToDocument(
    sb.from('mfg_sales_order_items')
      .select('qty, unit_price_sen, discount_sen, unit_cost_sen, total_sen, item_code, item_group, description, description2, uom, variants, remark, cancelled'),
    docNo,
    itemId,
  ).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  let afterDoSetSiQty: number | null = null;
  if (afterDoProduct) {
    const qtyChanging = it.qty !== undefined && Number(it.qty) !== Number(prev.qty);
    if (qtyChanging && !afterDoQtyChangeAllowed(Number(prev.qty), Number(afterDoProduct.doLine.qty), afterDoProduct.siQtyOnDoLine, afterDoProduct.siLines.length)) {
      return c.json(AFTER_DO_LINE_NOT_SETTLED, 409);
    }
    afterDoSetSiQty = qtyChanging ? Number(it.qty) : null;
  }
  /* ACTIVE gate on a CHANGED code only (owner 2026-08-08) — a product swap is
     a NEW pick, so the replacement must be ACTIVE like every picker offer;
     re-sending the line's unchanged code (every editor does, on any edit)
     stays existence-only so discontinued-SKU history remains editable. */
  if (it.itemCode !== undefined && String(it.itemCode).trim() !== String(prev.item_code ?? '')) {
    const activeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c), { requireActive: true });
    if (!activeCheck.ok) return c.json(unknownItemCodeResponse(activeCheck.unknown, activeCheck.inactive), 409);
  }
  const badQty = invalidQtyResponse(it.qty, prev.item_code);
  if (badQty) return c.json(badQty, 422);
  /* Owner 2026-07-17 — see unexplainedExtraAddonResponse. Validates the
     INCOMING variants, not prev: this PATCH replaces the object wholesale, so
     clearing a note while keeping the amount has to be refused too. */
  const badExtra = unexplainedExtraAddonResponse(it.variants, prev.item_code);
  if (badExtra) return c.json(badExtra, 422);
  const qty = it.qty !== undefined ? Number(it.qty) : prev.qty;
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
  const patchTrust = erpLineTrust(posTablet, clientUnit, it.zeroPriceIntended, patchSoIsMigrated);
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : prev.discount_sen;

  let recomputedPatch: RecomputedLine | null = null;
  const itemCodeAfter = it.itemCode !== undefined ? String(it.itemCode) : prev.item_code;
  const prevIsAccessoryComboParent = !!(prev.variants as Record<string, unknown> | null)?.sofaAccessoryGroupKey;
  if (prevIsAccessoryComboParent
    && (qty !== Number(prev.qty) || itemCodeAfter !== prev.item_code || it.cancelled === true)) {
    return c.json({ error: 'sofa_combo_requires_complete_edit', reason: 'Change the complete sofa combo together with its included accessories.' }, 409);
  }
  const prevIsIncludedAccessory = isStoredIncludedSofaAccessory(prev);
  if (prevIsIncludedAccessory && (qty !== Number(prev.qty) || itemCodeAfter !== prev.item_code)) {
    return c.json({ error: 'sofa_combo_accessory_locked', reason: 'An accessory included in a sofa combo keeps its SKU and quantity. Add extra accessories as a new line.' }, 409);
  }
  if (it.variants !== undefined) {
    const next = { ...((it.variants && typeof it.variants === 'object' && !Array.isArray(it.variants) ? it.variants : {}) as Record<string, unknown>) };
    delete next.sofaComboIncluded;
    delete next.sofaAccessoryGroupKey;
    if ((prev.variants as Record<string, unknown> | null)?.sofaAccessoryGroupKey) next.sofaAccessoryGroupKey = (prev.variants as Record<string, unknown>).sofaAccessoryGroupKey;
    if (prevIsIncludedAccessory) next.sofaComboIncluded = (prev.variants as Record<string, unknown>).sofaComboIncluded;
    if (prevIsAccessoryComboParent && !sameSofaComboVariants(prev.variants, next)) {
      return c.json({ error: 'sofa_combo_requires_complete_edit', reason: 'Use the colour/options editor for this sofa combo. Change its modules or accessories by rebuilding the complete combo.' }, 409);
    }
    it.variants = next;
  }
  const variantsAfter = it.variants !== undefined
    ? (it.variants as MfgItemForRecompute['variants'])
    : ((prev as { variants?: MfgItemForRecompute['variants'] }).variants ?? null);
  /* SKU wins — lib/sku-category.ts, docs/bugs/0514. Until 2026-09-12 this door
     took the request's group verbatim; the product master decides, the request
     is a fallback only when the code is not catalogued, and the stored value is
     the last resort. Same rule as create and add-item. */
  const patchGroupOf = await skuCategoryResolver(sb, [{ materialKind: 'mfg_product', itemCode: itemCodeAfter }], activeCompanyId(c) ?? null);
  const itemGroupAfter = patchGroupOf({ materialKind: 'mfg_product', itemCode: itemCodeAfter, itemGroup: it.itemGroup }) ?? prev.item_group;

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

  if (variantsChanged || itemCodeChangedOnPatch) {
    const { product, model, lookupError } = await loadProductAndModel(sb, itemCodeAfter, activeCompanyId(c));
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(
      product,
      model,
      variantsForEditCheck(variantsAfter as Parameters<typeof checkAllowedOptions>[2], (prev as { variants?: Parameters<typeof checkAllowedOptions>[2] }).variants ?? null),
    );
    if (aoErr) return c.json({ ...aoErr, itemCode: itemCodeAfter }, 400);
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
      loadMaintenanceConfig(sb, activeCompanyId(c)),
      loadProductByCode(sb, itemCodeAfter, activeCompanyId(c)),
      loadFabricByCode(sb, variantsAfter?.fabricCode ?? null),
      loadSellingSofaCombos(sb, c),
      loadFabricSellingTiers(sb, (variantsAfter as { fabricId?: string } | null)?.fabricId ?? null),
      loadFabricTierAddonConfig(sb, activeCompanyId(c)),
      loadSpecialAddons(sb, activeCompanyId(c)),
      loadModelFabricTierOverrides(sb),
      loadCompartmentFabricTierOverrides(sb),
    ]);
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
      null,
      null,
      specialAddonsPatch,
      sofaModuleCostRowsPatch,
      modelOverridesPatch,
      compartmentOverridesPatch,
      patchTrust,
    );
    if (!isFreeItemLine(prev.variants) && !prevIsReward && !prevIsAccessoryComboParent && !prevIsIncludedAccessory && posTablet && recomputedPatch.drift) {
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
  const unit = (isFreeItemLine(prev.variants) || prevIsIncludedAccessory)
    ? 0
    /* PWP reward — keep the grant price locked at claim time. Recompute (no
       pwpBaseSen on the edit path) would reset it to full retail and the
       Backend, not being a POS tablet, would save that silently — turning a
       RM490 加购 into RM990 with no warning (Loo 2026-06-28). */
    : (prevIsReward || prevIsAccessoryComboParent)
    ? prev.unit_price_sen
    : unitAfterLineEdit(recomputedPatch ? recomputedPatch.unit_price_sen : clientUnit, prev.unit_price_sen, patchTrust);
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
  const { unitCost, lineCost, costDay, later: laterChange, changeDay } = await priceLineEdit(sb, c, docNo, {
    prev, explicitUnitCostSen: it.unitCostSen !== undefined ? Number(it.unitCostSen) : 0,
    newItemCode: it.itemCode !== undefined ? String(it.itemCode ?? '') : null,
    qty, unit, discount, itemCodeAfter, itemGroupAfter, variantsAfter: variantsAfter ?? null, recomputed: recomputedPatch,
  });
  const lineTotal = senOrZero((qty * unit) - discount);

  const updates: Record<string, unknown> = {
    qty, unit_price_sen: unit, discount_sen: discount, unit_cost_sen: unitCost,
    total_sen: lineTotal, total_inc_sen: lineTotal, balance_sen: lineTotal,
    line_cost_sen: lineCost, line_margin_sen: lineTotal - lineCost,
    ...(costDay ? { cost_day: costDay } : {}),
  };
  if (recomputedPatch) {
    updates.divan_price_sen         = recomputedPatch.divan_price_sen;
    updates.leg_price_sen           = recomputedPatch.leg_price_sen;
    updates.special_order_price_sen = recomputedPatch.special_order_sen;
    updates.custom_specials         = recomputedPatch.custom_specials ?? null;
  }
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['description', 'description'],
    ['description2', 'description2'], ['uom', 'uom'], ['variants', 'variants'],
    ['remark', 'remark'], ['cancelled', 'cancelled'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  if (itemGroupAfter !== prev.item_group) updates.item_group = itemGroupAfter;
  if (it.variants !== undefined) {
    const clientVariants = stripFreeItem(updates['variants']);
    const prevFreeItem = (prev.variants as Record<string, unknown> | null | undefined)?.freeItem;
    updates['variants'] = prevFreeItem !== undefined
      ? { ...(clientVariants as Record<string, unknown> ?? {}), freeItem: prevFreeItem }
      : clientVariants ?? null;
    const itemGroupAfter = String(it.itemGroup ?? prev.item_group ?? '');
    updates['variants'] = canonicalizeVariants(
      itemGroupAfter,
      updates['variants'] as Record<string, unknown> | null,
    );
  }
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants !== undefined ? updates['variants'] : prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  if (it.lineDeliveryDate !== undefined) {
    const { data: dateRow, error: dateErr } = dateOrNull(it.lineDeliveryDate)
      ? await scopeSoItemToDocument(sb.from('mfg_sales_order_items').select('line_delivery_date'), docNo, itemId).maybeSingle()
      : { data: null, error: null };
    if (dateErr) return c.json({ error: 'so_read_failed', reason: dateErr.message }, 500);
    if (dateOrNull(it.lineDeliveryDate)
      && soDateYmd(it.lineDeliveryDate) !== soDateYmd((dateRow as { line_delivery_date?: string | null } | null)?.line_delivery_date)) {
      const { data: procHdr, error: procErr } = await sb.from('mfg_sales_orders')
        .select('processing_date').eq('doc_no', docNo).maybeSingle();
      if (procErr) return c.json({ error: 'so_read_failed', reason: procErr.message }, 500);
      const patchLineDateRefusal = soLineDateRefusal({
        processingDate: (procHdr as { processing_date?: string | null } | null)?.processing_date,
        lineDeliveryDates: [it.lineDeliveryDate],
      });
      if (patchLineDateRefusal) return c.json(patchLineDateRefusal, 400);
    }
    updates['line_delivery_date'] = dateOrNull(it.lineDeliveryDate);
    updates['line_delivery_date_overridden'] = true;
  }
  if (it.lineDeliveryDateOverridden !== undefined) {
    updates['line_delivery_date_overridden'] = Boolean(it.lineDeliveryDateOverridden);
  }
  if (it.warehouseId !== undefined) {
    updates['warehouse_id'] = it.warehouseId as string | null;
  }

  const feeRefusal = await transportFeeEditRefusal(c, sb, docNo, {
    kind: 'line', itemId, after: {
      itemCode: itemCodeAfter ?? null,
      description: it.description !== undefined ? String(it.description ?? '') : prev.description,
      itemGroup: it.itemGroup !== undefined ? String(it.itemGroup ?? '') : prev.item_group,
      amountSen: qty * unit - discount,
    },
  });
  if (feeRefusal) return feeRefusal;

  lap('line-checks');
  const { error } = await scopeSoItemToDocument(
    sb.from('mfg_sales_order_items').update(updates),
    docNo,
    itemId,
  );
  lap('line-write');
  // HC-0004: the DB floor (mig 20261014T1420) refused a cut below what a DO, created after the freeze read above, ships.
  if (isSoLineOverDelivered(error)) return c.json({ error: 'qty_below_delivered', message: 'A Delivery Order has just shipped this Sales Order line. Its qty can no longer be cut below what was delivered. Refresh and check the order.', reason: error!.message }, 409);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (costDay) await recostSofaSetsAfterWrite(sb, c, docNo, laterChange, changeDay, [{ id: itemId, item_code: itemCodeAfter, item_group: itemGroupAfter }, { item_code: prev.item_code, item_group: prev.item_group }], true);
  await reconcileFreeGiftLinesForSo(sb, docNo, c);
  lap('line-free-gift');
  await rederiveDeliveryFee(sb, docNo, c);
  lap('line-delivery-fee');

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
    fieldChanges.unshift({ field: 'itemCode', to: prev.item_code });
    await recordSoAudit(sb, {
      docNo,
      action: 'UPDATE_LINE',
      actorId: user.id,
      actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
      fieldChanges,
    });
  }

  lap('line-audit');
  deferAllocationRecompute(c, sb, 'post-line-edit');

  await queueAcSoEdit(c, docNo);
  lap('line-ac-queue');

  if (afterDoLine) {
    const put = await copyChargeLineToDo(sb, { companyId: afterDoLine.companyId, actor: c.get('houzsUser') ?? null, soDocNo: docNo }, itemId, afterDoLine.doLine, afterDoLine.target);
    return c.json({ ok: true, doNumber: afterDoLine.target.do_number, ...(put.ok ? {} : { doCopyFailed: [afterDoLine.target.do_number ?? afterDoLine.target.id], doCopyError: put.reason }) });
  }

  if (afterDoProduct) {
    const deps: AfterDoLineDeps = { resyncInventoryForDo, restampDoActualCost, performedBy: user?.id ?? '' };
    const r = await propagateLineEditAfterDo(
      sb,
      { companyId: afterDoProduct.companyId, actor: c.get('houzsUser') ?? null, soDocNo: docNo },
      { soItemId: itemId, doLine: afterDoProduct.doLine, target: afterDoProduct.target, siLines: afterDoProduct.siLines, setSiQty: afterDoSetSiQty, deps },
    );
    return c.json({
      ok: true,
      doNumber: afterDoProduct.target.do_number,
      ...(r.doCopyFailed.length ? { doCopyFailed: r.doCopyFailed } : {}),
      ...(r.siCopyFailed.length ? { siCopyFailed: r.siCopyFailed } : {}),
    });
  }

  return c.json({ ok: true });
});

mfgSalesOrders.delete('/:docNo/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');

  /* A line a live DO / SI carries cannot be deleted; its siblings can (owner 2026-09-15, shared/so-line-freeze.ts). */
  const lineLock = soLineWriteRefusal(await readSoLineFreeze(sb, docNo), [itemId]);
  /* Owner 2026-11-22 — a super admin may REMOVE a frozen PRODUCT line a DO carries (lib/so-after-do-lines.ts); a charge line is the fee path below. */
  let afterDoRemove: (OpenProductLineOk & { companyId: number }) | null = null;
  if (lineLock && lineLock.error === 'so_line_frozen' && hasHouzsPerm(c, SO_EDIT_LINES_AFTER_DO_PERMISSION)) {
    const co = requireActiveCompanyId(c); if (!co.ok) return c.json(co.refusal, 409);
    const g = await openProductLineRemove(sb, docNo, itemId, co.companyId, AFTER_DO_LINES_FORBIDDEN);
    if (g.ok && !g.skip) afterDoRemove = { target: g.target, doLine: g.doLine, siLines: g.siLines, siQtyOnDoLine: g.siQtyOnDoLine, companyId: co.companyId };
  }
  if (lineLock && !afterDoRemove) return c.json(lineLock, 409);

  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  /* Owner 2026-11-21 — a super admin (scm.so.edit_lines_after_do) may remove a
     non-frozen SERVICE / charge line that is stuck on a processing-locked or
     completed order. The freeze gate above already proved it is on no Delivery
     Order, so there is nothing downstream to follow — it is a plain SO delete. */
  let superAdminFeeWrite = false;
  if (hasHouzsPerm(c, SO_EDIT_LINES_AFTER_DO_PERMISSION)) {
    const { data: ln, error: lnErr } = await scopeSoItemToDocument(sb.from('mfg_sales_order_items').select('item_code, item_group'), docNo, itemId).maybeSingle();
    const l = lnErr ? null : (ln as { item_code?: string | null; item_group?: string | null } | null);
    if (l) superAdminFeeWrite = isServiceLine({ itemGroup: l.item_group ?? null, itemCode: l.item_code ?? null });
  }

  /* Owner 2026-06-12 — processing-date lock: no line DELETE once the processing
     day has passed. The super-admin fee / product removals are past it (the
     charge carries no PO; the product line already shipped). */
  if (!superAdminFeeWrite && !afterDoRemove) {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }

  const { data: prev } = await scopeSoItemToDocument(
    sb.from('mfg_sales_order_items')
      .select('item_code, item_group, qty, unit_price_sen, total_sen, photo_urls, cancelled, variants'),
    docNo,
    itemId,
  ).maybeSingle();
  if ((prev as { variants?: Record<string, unknown> } | null)?.variants?.sofaAccessoryGroupKey) {
    return c.json({ error: 'sofa_combo_requires_complete_edit', reason: 'Remove the complete sofa combo together with its included accessories.' }, 409);
  }
  const prevTyped = prev as
    | { item_code: string; qty: number; unit_price_sen: number; total_sen: number; photo_urls: string[] | null; cancelled?: boolean }
    | null;

  /* The total floor that stood here (Loo 2026-06-11) is GONE — owner ruling,
     relayed 2026-08-18. A POS caller may delete a priced line. */
  const retire = await retiredLineOf(sb, 'mfg_sales_order_items', itemId);

  const feeRefusal = await transportFeeEditRefusal(c, sb, docNo, { kind: 'line', itemId, after: null });
  if (feeRefusal) return feeRefusal;

  const removeLater = await openDirectChangeWindow(c, sb, docNo);
  if (afterDoRemove) {
    const deps: AfterDoLineDeps = { resyncInventoryForDo, restampDoActualCost, performedBy: user?.id ?? '' };
    const who = { companyId: afterDoRemove.companyId, actor: c.get('houzsUser') ?? null, soDocNo: docNo };
    const r = await propagateLineRemoveAfterDo(sb, who, { doLine: afterDoRemove.doLine, target: afterDoRemove.target, siLines: afterDoRemove.siLines, deps });
    if (!r.ok) return c.json(r.body, r.status);
  }

  const { error } = await scopeSoItemToDocument(
    sb.from('mfg_sales_order_items').delete(),
    docNo,
    itemId,
  );
  if (isSoLineOverDelivered(error)) return c.json(SO_LINE_FROZEN_REFUSAL, 409);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (prev) await recostSofaSetsAfterWrite(sb, c, docNo, removeLater, todayMyt(), [prev as { item_code?: unknown; item_group?: unknown }], false);
  await reconcileFreeGiftLinesForSo(sb, docNo, c);
  await rederiveDeliveryFee(sb, docNo, c);

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
        ...(photoKeys.length > 0
          ? [{ field: 'photosCleaned', from: photoKeys.length, to: photosCleaned } satisfies FieldChange]
          : []),
      ],
    });
  }

  deferAllocationRecompute(c, sb, 'post-line-delete');

  await queueAcSoEdit(c, docNo, retire);

  return c.body(null, 204);
});


const TBC_VARIANT_KEYS = [
  'fabricId', 'fabricCode', 'fabricLabel', 'colourId', 'colourLabel', 'colourHex',
  'sofaLegHeight',
  'gap', 'gapLabel', 'legHeight', 'legHeightLabel', 'divanHeight', 'divanHeightLabel',
  'specials', 'specialIds', 'specialLabels', 'specialChoices',
] as const;
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

  const freezeRead = await readSoLineFreeze(sb, docNo);
  const childLock = soLineWriteRefusal(freezeRead, soBuildLineIds(freezeRead, itemId));
  if (childLock) return c.json(childLock, 409);
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
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

  const nextVariants: Record<string, unknown> = { ...prevVariants };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '' || (Array.isArray(v) && v.length === 0)
        || (k === 'specialChoices' && typeof v === 'object' && v !== null && Object.keys(v as object).length === 0)) {
      delete nextVariants[k];
    } else {
      nextVariants[k] = v;
    }
  }

  {
    const { product, model, lookupError } = await loadProductAndModel(sb, prev.item_code, activeCompanyId(c));
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(product, model, nextVariants as Parameters<typeof checkAllowedOptions>[2]);
    if (aoErr) return c.json({ ...aoErr, itemCode: prev.item_code }, 400);
  }

  const [cfg, prodLite, fabPrev, fabNext, tiersPrev, tiersNext, addonCfg, specialDefs, modelOverrides, compartmentOverrides] = await Promise.all([
    loadMaintenanceConfig(sb, activeCompanyId(c)),
    loadProductByCode(sb, prev.item_code, activeCompanyId(c)),
    loadFabricByCode(sb, (prevVariants.fabricCode as string | undefined) ?? null),
    loadFabricByCode(sb, (nextVariants.fabricCode as string | undefined) ?? null),
    loadFabricSellingTiers(sb, (prevVariants.fabricId as string | undefined) ?? null),
    loadFabricSellingTiers(sb, (nextVariants.fabricId as string | undefined) ?? null),
    loadFabricTierAddonConfig(sb, activeCompanyId(c)),
    loadSpecialAddons(sb, activeCompanyId(c)),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  const category = String(prodLite?.category ?? '').toUpperCase();
  const tbcBaseOverride = (modelOverrides && prodLite?.model_id) ? (modelOverrides.get(prodLite.model_id) ?? null) : null;
  /* A persisted split-sofa module line STRIPS `variants.cells`, so the build's
     compartment codes can't be read off `nextVariants` — that yielded `[]` and
     resolved model-only, under-charging a build that carries a per-compartment
     Δ (the POS preview showed the higher Δ but the server billed less; no drift
     gate here). Reconstruct them from the SIBLING module lines' item_code suffix,
     the same way the create path does. They also price an add-on set by
     compartment (2990 owner 2026-10-26), so they are read BEFORE the snapshots. */
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
      tbcCells = Array.isArray((nextVariants as { cells?: unknown }).cells)
        ? ((nextVariants as { cells?: Array<{ moduleId?: unknown }> }).cells ?? []).map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
        : [];
    }
  }
  const snap = (variants: Record<string, unknown>, fab: typeof fabPrev) =>
    recomputeFromSnapshot(
      {
        itemCode:          prev.item_code,
        itemGroup:         String(prev.item_group ?? 'others'),
        qty:               Number(prev.qty),
        unitPriceSen:      Number(prev.unit_price_sen),
        variants:          variants as MfgItemForRecompute['variants'],
        buildCompartments: tbcCells,
      },
      prodLite, fab, cfg, null, null, null, null, null, null, specialDefs, null, null,
    );
  const before = snap(prevVariants, fabPrev);
  const after  = snap(nextVariants, fabNext);
  const tbcOverride = resolveFabricTierOverride(tbcCells, tbcBaseOverride, compartmentOverrides ?? new Map());
  const tierDeltaSen = (addonCfg && (category === 'SOFA' || category === 'BEDFRAME'))
    ? (fabricTierAddon(category, (category === 'SOFA' ? tiersNext?.sofaTier : tiersNext?.bedframeTier) ?? null, addonCfg, tbcOverride)
     - fabricTierAddon(category, (category === 'SOFA' ? tiersPrev?.sofaTier : tiersPrev?.bedframeTier) ?? null, addonCfg, tbcOverride)) * 100
    : 0;
  const sellingDeltaSen = (after.breakdown.unitPriceSen - before.breakdown.unitPriceSen) + tierDeltaSen;
  const costDeltaSen = after.unit_cost_sen - before.unit_cost_sen;

  const isFreeItemGrandfathered = isFreeItemLine(prevVariants) || isStoredIncludedSofaAccessory(prev);
  /* The total floor that stood here (Loo 2026-06-11) is GONE — owner ruling,
     relayed 2026-08-18. A TBC edit may lower the line. */
  const qty = Number(prev.qty);
  const newUnit = isFreeItemGrandfathered ? 0 : Math.max(0, Number(prev.unit_price_sen) + sellingDeltaSen);
  const prevDiscount = Number(prev.discount_sen ?? 0);
  if (prevDiscount > qty * newUnit) {
    return c.json({
      error: 'discount_exceeds_new_price',
      message:
        `This change lowers the unit price to ${fmtSen(newUnit)}, and the line already carries a ` +
        `${fmtSen(prevDiscount)} discount — which no longer fits. Reduce the discount first, then re-apply this change.`,
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

  await reconcileFreeGiftLinesForSo(sb, docNo, c);
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

export async function tbcSwapCommandHandler(c: any, sb: any): Promise<Response> {
  const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const newCode = String(body.itemCode ?? '').trim();
  if (!newCode) return c.json({ error: 'item_code_required' }, 400);

  const childLock = soLineWriteRefusal(await readSoLineFreeze(sb, docNo), [itemId]);
  if (childLock) return c.json(childLock, 409);
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
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
  if (isStoredIncludedSofaAccessory(prev)) return c.json({ error: 'sofa_combo_accessory_locked', reason: 'Exchange an included accessory together with its sofa combo.' }, 409);
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
    unitSen = pwpSen;
    variantsAfterSwap = { pwp: true, pwpCode: rewardPwpCode };
  } else {
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
        if ((r.trigger_combo_ids ?? []).length > 0) return false;
        const inCat = String(p.category ?? '').toUpperCase() === String(r.trigger_category).toUpperCase();
        const models = r.trigger_eligible_model_ids ?? [];
        if (!inCat || !(models.length === 0 || (p.model_id != null && models.includes(p.model_id)))) return false;
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

  {
    const mainMix = await lineMixRefusal(sb, 'mfg_sales_order_items', docNo, itemId, newCode, activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  const qty = Number(prev.qty);
  const discount = Number(prev.discount_sen ?? 0);
  if (discount > qty * unitSen) {
    return c.json({
      error: 'discount_exceeds_new_price',
      message:
        `That product is cheaper than the line's ${fmtSen(discount)} discount allows. ` +
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
    const { error: e2 } = await pgrestIn(sb.from('pwp_codes')
      .update({ trigger_item_code: newCode, updated_at: new Date().toISOString() }), 'code', triggerCodesToRestamp).eq('company_id', voucherCompanyId);
    throwAtomicCommandWrite(sb, e2, 'TBC trigger code restamp failed');
    if (e2) console.error('[tbc-swap] trigger code restamp failed:', e2.message); // eslint-disable-line no-console
  }

  const pwpMintedCodes: string[] = [];
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
    const [cfgX, addonCfgX, specialDefsX, modelOverridesX, compartmentOverridesX] = await Promise.all([
      loadMaintenanceConfig(sb, activeCompanyId(c)),
      loadFabricTierAddonConfig(sb, activeCompanyId(c)),
      loadSpecialAddons(sb, activeCompanyId(c)),
      loadModelFabricTierOverrides(sb),
      loadCompartmentFabricTierOverrides(sb),
    ]);
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
    const toDelete = [...pwpDeleteCodes, ...pwpRevertCodes];
    if (toDelete.length > 0) {
      const { error } = await pgrestIn(sb.from('pwp_codes').delete(), 'code', toDelete)
        .eq('company_id', voucherCompanyId);
      throwAtomicCommandWrite(sb, error, 'TBC code delete failed');
      if (error) console.error('[tbc-swap] code delete failed:', error.message); // eslint-disable-line no-console
    }
    if (pwpNewlyTriggered.length > 0) {
      const { data: hdr } = await sb.from('mfg_sales_orders').select('customer_id').eq('doc_no', docNo).maybeSingle();
      const customerId = ((hdr as { customer_id?: string | null } | null)?.customer_id) ?? null;
      const mintOwnerStaffId = await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id);
      const { data: keptRows } = triggerCodesToRestamp.length > 0
        ? await pgrestIn(sb.from('pwp_codes').select('code, rule_id'), 'code', triggerCodesToRestamp).eq('company_id', voucherCompanyId)
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
              company_id: activeCompanyId(c),
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

  await reconcileFreeGiftLinesForSo(sb, docNo, c);
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
  const depth = String(leadV.depth ?? leadV.seatHeight ?? '24');
  const [cfg, prodLite, fabLite, combos, sellingTiers, addonCfg, specialDefs, modulePrices, modelOverridesLead, compartmentOverridesLead] = await Promise.all([
    loadMaintenanceConfig(sb, activeCompanyId(c)),
    loadProductByCode(sb, lead.item_code, activeCompanyId(c)),
    loadFabricByCode(sb, (leadV.fabricCode as string | undefined) ?? null),
    loadSellingSofaCombos(sb, c),
    loadFabricSellingTiers(sb, (leadV.fabricId as string | undefined) ?? null),
    loadFabricTierAddonConfig(sb, activeCompanyId(c)),
    loadSpecialAddons(sb, activeCompanyId(c)),
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
    null, null,
    specialDefs, null, modelOverridesLead,
  );
  if (rec.unit_price_sen <= 0) return { ok: false };
  const split = splitSofaBuildIntoModuleLines({
    baseModel,
    cells,
    buildUnitPriceSen: rec.unit_price_sen,
    buildUnitCostSen: 0,
    modulePrices, moduleCostsSen: null,
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

export async function tbcSwapSofaCommandHandler(c: any, sb: any): Promise<Response> {
  const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const item = (body.item ?? null) as { itemCode?: unknown; qty?: unknown; unitPriceSen?: unknown; description?: unknown; variants?: Record<string, unknown> | null } | null;
  const newCode = String(item?.itemCode ?? '').trim();
  if (!item || !newCode) return c.json({ error: 'item_code_required' }, 400);
  if (['sofaComboIncluded', 'sofaAccessoryGroupKey', 'sofaAccessories', 'sofaAccessoryOfKey', 'sofaAccessoryPieceIds'].some((k) => item.variants?.[k] !== undefined)) {
    return c.json({ error: 'sofa_combo_requires_complete_edit', reason: 'Exchange the complete sofa combo together with its included accessories.' }, 409);
  }

  const freezeRead = await readSoLineFreeze(sb, docNo);
  const childLock = soLineWriteRefusal(freezeRead, soBuildLineIds(freezeRead, itemId));
  if (childLock) return c.json(childLock, 409);
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
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
  if (prev.variants?.sofaAccessoryGroupKey) return c.json({ error: 'sofa_combo_requires_complete_edit', reason: 'Exchange the complete sofa combo together with its included accessories.' }, 409);
  if (String(prev.item_group) !== 'sofa') {
    return c.json({ error: 'sofa_swap_only', reason: 'This exchange path only replaces sofa builds.' }, 400);
  }
  const prevVariants = ((prev.variants ?? {}) as Record<string, unknown>);
  const buildKey = (prevVariants.buildKey as string | undefined) ?? null;

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

  {
    const codeCheck = await validateItemCodes(sb, [newCode], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }
  const newVariants: Record<string, unknown> = { ...((item.variants ?? {}) as Record<string, unknown>) };
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
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(product, model, newVariants as Parameters<typeof checkAllowedOptions>[2]);
    if (aoErr) return c.json({ ...aoErr, itemCode: newCode }, 400);
  }

  const depth = String((newVariants as { depth?: unknown; seatHeight?: unknown }).depth ?? (newVariants as { seatHeight?: unknown }).seatHeight ?? '24');
  const [cfg, fabLite, combos, sellingTiers, fabricAddonCfg, specialDefs, modulePrices, moduleCostRows, modelOverridesSwap, compartmentOverridesSwap] = await Promise.all([
    loadMaintenanceConfig(sb, activeCompanyId(c)),
    loadFabricByCode(sb, (newVariants.fabricCode as string | undefined) ?? null),
    loadSellingSofaCombos(sb, c),
    loadFabricSellingTiers(sb, (newVariants.fabricId as string | undefined) ?? null),
    loadFabricTierAddonConfig(sb, activeCompanyId(c)),
    loadSpecialAddons(sb, activeCompanyId(c)),
    loadModelSofaModulePrices(sb, prodLite.base_model, depth, activeCompanyId(c)),
    loadModelSofaModuleCostRows(sb, prodLite.base_model, activeCompanyId(c)),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  const qty = Math.max(1, Math.floor(Number(item.qty ?? 1)));
  const clientUnit = Math.max(0, Math.round(Number(item.unitPriceSen ?? 0)));
  const rewardComboMatch = rewardCtx != null && (() => {
    const comboByIdR = new Map((combos ?? []).map((cb) => [cb.id, cb]));
    const mods = (newCells as Array<{ moduleId?: unknown }>)
      .map((cl) => String(cl?.moduleId ?? '').trim()).filter(Boolean);
    return rewardCtx.comboIds.some((id) => {
      const cb = comboByIdR.get(id);
      if (!cb) return false;
      if (cb.baseModel && cb.baseModel !== (prodLite.base_model ?? '')) return false;
      return matchComboBuild({ modules: mods }, cb) != null;
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
  if (discount > qty * unit) {
    return c.json({
      error: 'discount_exceeds_new_price',
      message:
        `That build is cheaper than the line's ${fmtSen(discount)} discount allows. ` +
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
  if (rewardCtx && rewardComboMatch) {
    newVariants.pwp = true;
    newVariants.pwpCode = rewardCtx.code;
  }

  const persistVariants = canonicalizeVariants('sofa', newVariants);

  const split = splitSofaBuildIntoModuleLines({
    baseModel: prodLite.base_model ?? null,
    cells: newCells,
    buildUnitPriceSen: unit,
    buildUnitCostSen: unitCost,
    modulePrices, moduleCostsSen: recomputed.sofa_module_costs_sen,
  });
  const newBuildKey = buildKey ?? `build-x${String(itemId).slice(0, 8)}`;
  const newLeadCode = split?.[0]?.itemCode ?? newCode;

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
          return matchComboBuild({ modules: newModuleIds }, cb) != null;
        });
      }
      return String(r.trigger_category).toUpperCase() === 'SOFA'
        && inList(prodLite.model_id ?? null, r.trigger_eligible_model_ids ?? [])
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

  {
    const oldNos = oldLines
      .map((l) => l.line_no)
      .filter((n): n is number => typeof n === 'number');
    if (oldNos.length > 0) {
      const base = Math.min(...oldNos);
      rows = rows.map((r, i) => ({ ...r, line_no: base + i }));
    }
  }

  const oldIds = oldLines.map((l) => l.id);
  const soLinkSnapshot = await snapshotSoLineLinks(sb, oldIds);

  const { data: inserted, error: insErr } = await sb.from('mfg_sales_order_items')
    .insert(stampCompany(rows, c)).select('id, item_code, line_no, variants');
  if (insErr) return c.json({ error: 'insert_failed', reason: insErr.message }, 500);
  const { error: delErr } = await sb.from('mfg_sales_order_items').delete().in('id', oldIds);
  if (delErr) {
    const newIds = ((inserted ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (newIds.length > 0) await sb.from('mfg_sales_order_items').delete().in('id', newIds);
    return c.json({ error: 'swap_failed', reason: delErr.message }, 500);
  }

  /* Carry the frozen links onto the replacement lines, matched by SKU AND COLOUR
     (docs/bugs/0672 site 11: on SKU alone one model's two fabrics pair by
     POSITION). No counterpart -> NOT re-pointed, reported rather than invented. */
  const soLinkResult = await (async () => {
    if (soLinkSnapshot.length === 0) return { restored: 0, dropped: 0 };
    const plan = planSoLineRelink(
      oldLines.map((l) => ({ id: l.id, itemCode: l.item_code, lineNo: l.line_no ?? null, variantSig: soLineVariantSig(l.variants) })),
      ((inserted ?? []) as Array<{ id: string; item_code: string | null; line_no: number | null; variants: unknown }>)
        .map((r) => ({ id: r.id, itemCode: r.item_code, lineNo: r.line_no, variantSig: soLineVariantSig(r.variants) })),
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

  if (c.env.SO_ITEM_PHOTOS) {
    const oldPhotoKeys = oldLines.flatMap((line) => line.photo_urls ?? []);
    deferScmAfterCommit(c, async () => {
      for (const key of oldPhotoKeys) {
        try { await c.env.SO_ITEM_PHOTOS.delete(key); }
        catch (e) { console.warn('[tbc-swap-sofa] photo cleanup failed for', key, e); } // eslint-disable-line no-console
      }
    });
  }

  const pwpMintedCodes: string[] = [];
  let pwpVoucherReleased: string | null = null;
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
  const rewardCompanyId = activeCompanyId(c);
  if (rewardCompanyId == null) throw new Error('TBC sofa voucher write refused: company unresolved');
  if (rewardCtx) {
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
    if (pwpKeepCodes.length > 0) {
      const { error } = await pgrestIn(sb.from('pwp_codes')
        .update({ trigger_item_code: newLeadCode, updated_at: new Date().toISOString() }), 'code', pwpKeepCodes).eq('company_id', rewardCompanyId);
      throwAtomicCommandWrite(sb, error, 'TBC sofa keep-code restamp failed');
      if (error) console.error('[tbc-swap-sofa] keep-code restamp failed:', error.message); // eslint-disable-line no-console
    }
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
    const toDelete = [...pwpDeleteCodes, ...pwpRevertCodes];
    if (toDelete.length > 0) {
      const { error } = await pgrestIn(sb.from('pwp_codes').delete(), 'code', toDelete)
        .eq('company_id', rewardCompanyId);
      throwAtomicCommandWrite(sb, error, 'TBC sofa code delete failed');
      if (error) console.error('[tbc-swap-sofa] code delete failed:', error.message); // eslint-disable-line no-console
    }
    if (pwpNewlyTriggered.length > 0) {
      const { data: hdr } = await sb.from('mfg_sales_orders').select('customer_id').eq('doc_no', docNo).maybeSingle();
      const customerId = ((hdr as { customer_id?: string | null } | null)?.customer_id) ?? null;
      const mintOwnerStaffId = await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id);
      const { data: keptRows } = pwpKeepCodes.length > 0
        ? await pgrestIn(sb.from('pwp_codes').select('code, rule_id'), 'code', pwpKeepCodes).eq('company_id', rewardCompanyId)
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
              company_id: activeCompanyId(c),
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

  await reconcileFreeGiftLinesForSo(sb, docNo, c);
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


const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const extFromMime = (mime: string): string => {
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
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  const { data: item, error: itemErr } = await sb
    .from('mfg_sales_order_items')
    .select('id, doc_no, item_code, photo_urls')
    .eq('id', itemId)
    .maybeSingle();
  if (itemErr) return c.json({ error: 'item_lookup_failed', reason: itemErr.message }, 500);
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { id: string; doc_no: string; item_code: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);

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

  await putOptionalThumb(c.env.SO_ITEM_PHOTOS, form.thumb, photoKey, {
    docNo,
    itemId,
    uploadedBy: user.id,
  });

  const nextKeys = [...(i.photo_urls ?? []), photoKey];
  const { error: updErr } = await sb
    .from('mfg_sales_order_items')
    .update({ photo_urls: nextKeys })
    .eq('id', itemId);
  if (updErr) {
    await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
    await deleteThumbFor(c.env.SO_ITEM_PHOTOS, photoKey);
    return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);
  }
  const carryErr = await carrySoPhotoToPoLines(sb, itemId, { add: photoKey });
  if (carryErr) console.warn(`[so-item-photo] PO carry failed for ${photoKey}: ${carryErr}`);

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

  try {
    const bindings = soItemPhotoBindings(c.env);
    const { signedUrl, expiresAt } = await signSoItemPhotoUrl(bindings, photoKey);
    const { signedUrl: thumbUrl } = await signSoItemPhotoUrl(bindings, thumbKeyFor(photoKey));
    return c.json({ photoKey, mode: 'signed', photoUrl: signedUrl, thumbUrl, expiresAt }, 201);
  } catch (e) {
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
    const { signedUrl: thumbUrl } = await signSoItemPhotoUrl(bindings, thumbKeyFor(photoKey));
    const payload: PhotoUrlPayload = { mode: 'signed', signedUrl, thumbUrl, expiresAt };
    return c.json(payload);
  } catch (e) {
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

mfgSalesOrders.get('/:docNo/items/:itemId/photos/:photoKey', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));

  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

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
  const carryErr = await carrySoPhotoToPoLines(sb, itemId, { remove: photoKey });
  if (carryErr) console.warn(`[so-item-photo] PO carry failed for ${photoKey}: ${carryErr}`);

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

registerPaymentsListRoutes(mfgSalesOrders);

const paymentCreateSchema = z.object({
  paidAt:             z.string().min(1),
  method:             z.enum([...PAYMENT_METHOD_CODES, 'converted']), // + money moved from a cancelled order (docs/bugs/0927)
  convertedFromDocNo: z.string().trim().min(1).optional().nullable(),
  merchantProvider:   z.string().trim().min(1).optional().nullable(),
  installmentMonths:  z.number().int().min(0).max(60).optional().nullable(),
  onlineType:         z.string().trim().min(1).optional().nullable(),
  approvalCode:       z.string().optional().nullable(),
  amountSen:        z.number().int().nonnegative(),
  accountSheet:       z.string().optional().nullable(),
  collectedBy:        z.string().uuid().optional().nullable(),
  note:               z.string().optional().nullable(),
  uploadSessionId:    z.string().min(1).optional().nullable(),
  /* Owed by a role holding the correction right (docs/bugs/0888). */
  reason:             z.string().trim().max(500).optional(),
});

export const postSoPaymentHandler = async (c: any) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: so, error: soErr } = await sb.from('mfg_sales_orders').select('doc_no').eq('doc_no', docNo).maybeSingle();
  if (soErr) return c.json(readFailure('sales_orders', soErr), 500);
  if (!so) return c.json({ error: 'sales_order_not_found' }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  /* A role holding the correction right says why it records money, too
     (docs/bugs/0888) — the rule in lib/so-payment-reason; never a window gate. */
  const owed = paymentReasonRule(c, { reason: p.reason });
  if (owed.refusal) return c.json(owed.refusal, 400);

  /* The proof (owner 2026-10-13, after Admin: "collect payment is attached with
     slip"). A keyed payment carries its slip session or is refused; a converted
     row is money receipted when it was first collected. The write core refuses
     the same way underneath, so no caller can skip this by calling it directly. */
  const slipVerdict = checkPaymentSlip({ converted: p.method === 'converted', hasSlip: Boolean(p.uploadSessionId) });
  if (!slipVerdict.ok) return c.json({ error: slipVerdict.code, reason: slipVerdict.reason }, 400);

  /* Slip-date window (owner 2026-09-23) — the rule is scm/shared/payment-slip-date;
     `scm.payment.backdate` is the exception, and an exercised exception says so
     in the audit note (unless a reason is already owed, which says more). A
     CONVERTED row is money that moved, not a slip somebody keyed: its date comes
     from the source order's first payment, so it is not window-checked here (the
     write core skips it by method too). */
  const mayBackdateSlip = hasHouzsPerm(c, SO_PAYMENT_BACKDATE);
  let slipDateOverride = false;
  if (p.method !== 'converted') {
    const verdict = checkPaymentSlipDate(p.paidAt, todayMyt());
    if (!verdict.ok) {
      if (!mayBackdateSlip) return c.json({ error: 'slip_date_out_of_window', reason: verdict.reason }, 400);
      slipDateOverride = true;
    }
  }

  const methodRefusal = paymentMethodFieldRefusal(p);
  if (methodRefusal) return c.json(methodRefusal, 400);

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
      return c.json({
        error: 'slip_required',
        reason: "That payment slip hasn't finished uploading. Attach it again.",
      }, 400);
    }
    paymentSlipKey = slipRowT.r2_key;
  }

  /* Money moved from a cancelled order (docs/bugs/0927): the cancelled order's remaining is the ceiling; the row takes its first payment's day and collector. */
  let plan: ConvertPlan | null = null;
  if (p.method === 'converted') {
    const g = await convertGuard(sb, Number(activeCompanyId(c)), { fromDocNo: p.convertedFromDocNo, toDocNo: docNo, amountSen: p.amountSen });
    if (!g.ok) return c.json({ error: g.error, message: g.message }, g.status);
    plan = g.plan;
  }
  writesFromHere(c);
  const { payment, errorMessage } = await recordSoPaymentRow(sb, {
    docNo,
    paidAt:            plan ? plan.paidAt : p.paidAt,
    method:            p.method,
    ...(plan ? { convertedFromDocNo: plan.fromDocNo } : {}),
    merchantProvider:  p.merchantProvider,
    installmentMonths: p.installmentMonths,
    onlineType:        p.onlineType,
    approvalCode:      p.approvalCode,
    amountSen:       p.amountSen,
    accountSheet:      p.accountSheet,
    slipKey:           paymentSlipKey ?? (plan ? plan.slipKey : null),
    collectedBy:       plan ? plan.collectedBy : p.collectedBy,
    note:              p.note ?? (plan ? `Converted from ${plan.fromDocNo}` : null),
    createdBy:         user.id,
    actorName:         (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    ...(owed.owed ? { auditSource: AMEND_SOURCE, auditNote: p.reason } : {}),
    ...(slipDateOverride ? { allowOutOfWindowSlipDate: true, ...(owed.owed ? {} : { auditNote: SLIP_DATE_OVERRIDE_NOTE }) } : {}),
  });
  if (errorMessage) return c.json({ error: 'insert_failed', reason: errorMessage }, 500);

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

  return c.json({ payment }, 201);
};
mfgSalesOrders.post('/:docNo/payments', noWriteUntilMarked, postSoPaymentHandler);

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
  /* Why the payment is being corrected — REQUIRED when the amend right is what
     opened the door (paymentMayChange says via 'amend'), optional otherwise
     (owner 2026-09-10: 靠权限改的来决定). Lands on the audit row and the
     Finance corrections report. */
  reason:            z.string().trim().max(500).optional(),
});

mfgSalesOrders.patch('/:docNo/payments/:id', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
  const user = c.get('user');
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: row, error: rowErr } = await scopeToCompany(sb.from('mfg_sales_order_payments').select('*').eq('id', id), c).maybeSingle();
  if (rowErr) return c.json(readFailure('so_payments', rowErr), 500);
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
  /* Money moved from a cancelled order is moved back by deleting the row, never edited in place (docs/bugs/0927). */
  if (String(before.method) === 'converted') return c.json({ error: 'converted_row_not_editable', reason: Number(before.amount_sen) < 0 ? 'This row follows money that left the order — it moves with the converted row or the refund voucher it follows.' : 'This row is money moved from another order. Delete it to move the money back, then move it again.' }, 409);

  const { data: soRow, error: soRowErr } = await sb
    .from('mfg_sales_orders')
    .select('status')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (soRowErr) return c.json(readFailure('sales_orders', soRowErr), 500);
  if (typeof before.created_at !== 'string' || Number.isNaN(new Date(before.created_at).getTime())) {
    return c.json({
      error: 'payment_created_at_unreadable',
      reason: 'This payment is missing the date it was keyed in, so it cannot be edited safely. '
        + 'Please tell IT which payment this is.',
    }, 409);
  }
  const editWindow = await paymentMayChange(sb, {
    companyId: co.companyId, paymentId: id,
    createdDateMyt: mytDateOf(before.created_at), todayDateMyt: todayMyt(),
    soIsDraft: (soRow?.status as string | undefined) === 'DRAFT', mayAmend: hasHouzsPerm(c, SO_PAYMENT_AMEND),
  });
  if (!editWindow.mutable) {
    return c.json({ error: PAYMENT_WINDOW_CLOSED_ERROR, reason: editWindow.problem }, 409);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const owed = paymentReasonRule(c, { reason: p.reason, viaAmend: editWindow.via === 'amend' }); // docs/bugs/0785, 0888
  if (owed.refusal) return c.json(owed.refusal, 400);
  const versionCheck = paymentVersionGuard(p.version, Number(before.version ?? 1), soCasGrace(c));
  if (!versionCheck.ok) return c.json(versionCheck.body, versionCheck.status);
  const expectedPaymentVersion = versionCheck.version;

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
  if (nextPaidAt !== before.paid_at) {
    const verdict = checkPaymentSlipDate(nextPaidAt, todayMyt());
    if (!verdict.ok && !hasHouzsPerm(c, SO_PAYMENT_BACKDATE)) {
      return c.json({ error: 'slip_date_out_of_window', reason: verdict.reason }, 400);
    }
  }
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
  const staleAutoFill = (sheet: string | null): boolean =>
    derivedInputsChanged && (sheet ?? '') === priorDerived;
  const sentSheet = p.accountSheet === undefined ? undefined : (p.accountSheet ?? '').trim();
  const nextAccountSheet = sentSheet !== undefined
    ? (!sentSheet || staleAutoFill(sentSheet) ? nextDerived() : sentSheet)
    : (staleAutoFill(before.account_sheet) ? nextDerived() : before.account_sheet);

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
    .eq('company_id', co.companyId)
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) {
    const { data: latest } = await sb.from('mfg_sales_order_payments').select('version').eq('id', id).maybeSingle();
    return c.json({ error: 'payment_version_conflict', currentVersion: Number(latest?.version ?? expectedPaymentVersion) }, 409);
  }

  const next = {
    paid_at: nextPaidAt, method: nextMethod, amount_sen: nextAmount, merchant_provider: nextMerchantProvider,
    installment_months: nextInstallment, online_type: nextOnline, approval_code: nextApproval,
    account_sheet: nextAccountSheet, collected_by: nextCollectedBy,
  };
  /* THE LEDGER FOLLOWS THE EDIT (docs/bugs/0778) — this route wrote the row and
     stopped, so a correction left its entry behind. See acc/payment-repost.
     BEFORE the audit, so the audit row can carry the two JE numbers. */
  const ledger = await repostSoPaymentBestEffort(sb, { id, docNo, companyId: co.companyId, before, next, actor: c.get('houzsUser')?.name ?? null });
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_PAYMENT',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    paymentId: id,
    fieldChanges: [...soPaymentFieldChanges(before, next), ...ledgerFieldChange(ledger), ...receiptFieldChange(ledger.receipt)],
    /* A correction made on the amend right is a FINANCE event: it carries the
       typed reason and is what the corrections report lists (docs/bugs/0785). */
    ...owed.audit,
  });

  /* Same reason as the insert: an edited amount moves the outstanding balance,
     which is a value AutoCount holds. Unlike the insert this one lives in the
     route, because the UPDATE above is the route's own and has no shared core.
     Fires even when only the method changed — recomposing an unchanged BALANCE
     costs one queued edit, while deciding here which fields matter would put a
     second opinion about the balance rule next to so-outstanding.ts. HEADER-ONLY,
     as the insert (docs/bugs/0896): a line AutoCount refuses must not hold the money back. */
  await enqueueSoPaymentEdit(c.get('supabase'), { companyId: activeCompanyId(c), docNo, createdBy: c.get('houzsUser')?.id ?? null });

  await recomputeSiPaidForOrder(sb, docNo, co.companyId);

  const { staff, ...rest } = updated as unknown as Record<string, unknown> & { staff: { name: string } | null };
  return c.json({ payment: { ...rest, collected_by_name: staff?.name ?? null } });
});

export const deleteSoPaymentHandler = async (c: any) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
  const user = c.get('user');
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: row, error: rowErr } = await scopeToCompany(sb.from('mfg_sales_order_payments').select('*').eq('id', id), c).maybeSingle();
  if (rowErr) return c.json(readFailure('so_payments', rowErr), 500);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const rowTyped = row as { so_doc_no: string; paid_at: string; method: string; amount_sen: number; approval_code: string | null; version: number };
  if (rowTyped.so_doc_no !== docNo) return c.json({ error: 'payment_doc_mismatch' }, 400);
  if (Number(rowTyped.amount_sen) < 0) return c.json({ error: 'mirror_row_not_deletable', reason: 'This row follows money that left the order. Delete the converted row on the order it went to, or cancel the refund voucher, and it goes with it.' }, 409);
  const currentVersion = Number(rowTyped.version ?? 1);
  const versionCheck = paymentVersionGuard(c.req.query('version'), currentVersion, soCasGrace(c));
  if (!versionCheck.ok) return c.json(versionCheck.body, versionCheck.status);
  const expectedVersion = versionCheck.version;

  /* THE SAME GATE AS THE PATCH (owner 2026-07-19: 删除只有在当天才行 — until
     then this route had NO time gate, so a months-old payment on a delivered,
     invoiced SO could be hard-deleted and flip it from PAID to owing). Keyed
     off created_at, never paid_at: keying off the document date would let an
     edit and a delete authorise each other. MYT, not UTC. Enforced HERE — the
     missing button in the clients is the courtesy, this is the control. Since
     2026-09-10 the amend right opens it and a RECONCILED payment shuts it to
     everyone (docs/bugs/0780); paymentMayChange() below asks both. */
  const { data: soStatusRow, error: soStatusErr } = await sb
    .from('mfg_sales_orders')
    .select('status')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (soStatusErr) return c.json(readFailure('sales_orders', soStatusErr), 500);
  const soIsDraft = (soStatusRow?.status as string | undefined) === 'DRAFT';
  const soIsCancelled = (soStatusRow?.status as string | undefined) === 'CANCELLED';
  const createdAtRaw = (row as { created_at?: unknown }).created_at;
  if (typeof createdAtRaw !== 'string' || Number.isNaN(new Date(createdAtRaw).getTime())) {
    return c.json({
      error: 'payment_created_at_unreadable',
      reason: 'This payment is missing the date it was keyed in, so it cannot be removed safely. '
        + 'Please tell IT which payment this is.',
    }, 409);
  }
  const delCo = requireActiveCompanyId(c); if (!delCo.ok) return c.json(delCo.refusal, 409);
  /* A CANCELLED order's payment comes off only at Finance's hand, and only while
     its money is still on the order (owner 2026-09-29; lib/so-money.ts). */
  if (soIsCancelled) {
    const g = await cancelledRemovalGuard(sb, delCo.companyId, { docNo, paymentId: id, mayAmend: hasHouzsPerm(c, SO_PAYMENT_AMEND) });
    if (!g.ok) return c.json({ error: g.error, message: g.message }, g.status);
  }
  const windowCheck = await paymentMayChange(sb, {
    companyId: delCo.companyId, paymentId: id,
    createdDateMyt: mytDateOf(createdAtRaw), todayDateMyt: todayMyt(),
    soIsDraft, mayAmend: hasHouzsPerm(c, SO_PAYMENT_AMEND),
  });
  if (!windowCheck.mutable) {
    return c.json({
      error: PAYMENT_WINDOW_CLOSED_ERROR,
      reason: windowCheck.problem,
    }, 409);
  }
  const owed = paymentReasonRule(c, { reason: c.req.query('reason'), viaAmend: windowCheck.via === 'amend' || soIsCancelled });
  if (owed.refusal) return c.json(owed.refusal, 400);

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

  const delLedger = await afterSoPaymentRemoved(sb, { paymentId: id, docNo, companyId: delCo.companyId, neverHappened: soIsCancelled, actor: c.get('houzsUser')?.name ?? null });

  await recordSoAudit(sb, {
    docNo,
    action: 'DELETE_PAYMENT',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    paymentId: id,
    fieldChanges: [
      { field: 'paidAt',       from: rowTyped.paid_at,       to: null },
      { field: 'method',       from: rowTyped.method,        to: null },
      { field: 'amountSen',  from: rowTyped.amount_sen,  to: null },
      ...(rowTyped.approval_code ? [{ field: 'approvalCode', from: rowTyped.approval_code, to: null } satisfies FieldChange] : []),
      ...ledgerFieldChange(delLedger),
      ...receiptFieldChange(delLedger.receipt),
    ],
    ...owed.audit,
  });

  /* A deleted payment raises the outstanding balance, so the account book has
     to be told in the same way an added one does. This is the direction that
     matters most: a book left showing a settled order after the payment was
     reversed understates what the customer owes. Header-only, as the insert (docs/bugs/0896). */
  await enqueueSoPaymentEdit(c.get('supabase'), { companyId: activeCompanyId(c), docNo, createdBy: c.get('houzsUser')?.id ?? null });

  return c.json({ ok: true });
};
mfgSalesOrders.delete('/:docNo/payments/:id', deleteSoPaymentHandler);

mfgSalesOrders.get('/:docNo/payments/:id/slip-url', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
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
  /* Owed by a role holding the correction right (docs/bugs/0888). */
  reason:          z.string().trim().max(500).optional(),
});

mfgSalesOrders.post('/:docNo/payments/:id/slip', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
  const user = c.get('user');
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
  const { uploadSessionId, reason } = parsed.data;
  const owed = paymentReasonRule(c, { reason }); // not a window gate — see above; docs/bugs/0888
  if (owed.refusal) return c.json(owed.refusal, 400);

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
    .eq('company_id', co.companyId)
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) {
    const { data: latest } = await sb.from('mfg_sales_order_payments').select('version').eq('id', id).maybeSingle();
    return c.json({ error: 'payment_version_conflict', currentVersion: Number(latest?.version ?? expectedVersion) }, 409);
  }

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
    paymentId: id,
    ...(owed.owed ? owed.audit : { note: before.slip_key ? 'Payment proof replaced' : 'Payment proof attached' }),
    fieldChanges: [{ field: 'slipKey', from: before.slip_key, to: nextSlipKey }],
  });

  const { staff, ...rest } = updated as unknown as Record<string, unknown> & { staff: { name: string } | null };
  return c.json({ payment: { ...rest, collected_by_name: staff?.name ?? null } });
});

registerDebtorSearchRoutes(mfgSalesOrders);

mfgSalesOrders.patch('/:docNo/items/:itemId/stock-status', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const user = c.get('user');
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const leaseBlocked = await requireSoLineWriteLease(sb, docNo, c);
  if (leaseBlocked) return leaseBlocked;

  let body: { status?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const nextStatus = (body.status ?? '').trim().toUpperCase();
  if (nextStatus !== 'PENDING' && nextStatus !== 'READY') {
    return c.json({ error: 'status_invalid', message: 'PENDING or READY' }, 400);
  }

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

  const { data: allLines } = await sb
    .from('mfg_sales_order_items')
    .select('item_group, item_code, stock_status, cancelled')
    .eq('doc_no', docNo);
  const liveRows: ReadinessLine[] = ((allLines ?? []) as Array<{ item_group: string; item_code: string | null; stock_status: string; cancelled: boolean }>)
    .filter((l) => !l.cancelled);
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

mfgSalesOrders.post('/:docNo/amendments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  const lap = stepClock();

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

  /* Guard 0 (owner 2026-09-15, 「SO amendment reason 换成一定 fill in」) — the
     reason is REQUIRED. The approver reads it before the lines, and the notice
     to their desk quotes it; a blank one used to be accepted and stored NULL. */
  body.reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!body.reason) {
    return c.json({
      error: 'reason_required',
      reason: 'Say why this amendment is needed — the approver reads the reason before the changes.',
    }, 400);
  }

  const { data: soRow } = await scopeToCompany(sb.from('mfg_sales_orders')
    .select('doc_no, status, revision, processing_date, salesperson_id, access_staff_ids, open_to_all, ' +
      'customer_delivery_date, customer_state, postcode')
    .eq('doc_no', docNo), c).maybeSingle();
  if (!soRow) return c.json({ error: 'not_found' }, 404);

  {
    const d = soRow as { salesperson_id?: number | string | null; access_staff_ids?: string[] | null; open_to_all?: boolean | null };
    if (await soDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), { salespersonId: d.salesperson_id, accessStaffIds: d.access_staff_ids, openToAll: d.open_to_all })) {
      return c.json({ error: 'not_found' }, 404);
    }
  }

  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  /* Guard 2 — an amendment only makes sense once the SO is locked; an unlocked
     SO is still directly editable, so no amendment is needed. Owner 2026-08-12:
     "locked" now means date-locked OR PO-locked (any company). This guard is the MIRROR
     of the write guards above — if it kept asking only about the date, a
     PO-locked SO would be refused BOTH roads (409 on the direct edit, 409 here
     for "not locked yet") and the operator would have no way to change anything
     at all. Keep the two definitions in lock-step. */
  // A Processing Date removal is requestable before the lock too — the Purchaser signs it (owner 2026-09-30).
  const removalOnly = isProcessingRemovalOnlyRequest({ headerChanges: body.headerChanges, lines: body.lines, storedProcessingDate: (soRow as { processing_date?: unknown }).processing_date });
  if (!removalOnly && !await soEditLocked(sb, docNo, soRow as unknown as { processing_date?: string | null; status: string | null })) {
    return c.json({
      error: 'not_locked_no_amendment_needed',
      reason: 'This Sales Order is not processing-locked yet — edit it directly instead of raising an amendment.',
    }, 409);
  }

  /* Guard 3 (owner 2026-09-15, shared/so-line-freeze.ts) — an order with nothing left to convert is too far
     along to amend; otherwise only a CHANGE / REMOVE of a frozen line is refused. applySoAmendment re-checks. */
  const freezeRead = await readSoLineFreeze(sb, docNo);
  if (!freezeRead.ok) return c.json(freezeRead.refusal, 409);
  if (freezeRead.fullyFrozen) {
    return c.json({
      error: 'so_hard_locked',
      reason: 'Everything on this Sales Order is already on a Delivery Order / Sales Invoice — it is too far along to amend.',
    }, 409);
  }
  {
    const lineLock = soLineWriteRefusal(freezeRead, (Array.isArray(body.lines) ? body.lines : [])
      .filter((l) => String(l.changeType ?? '').toUpperCase() !== 'ADD' && typeof l.salesOrderItemId === 'string')
      .map((l) => String(l.salesOrderItemId)));
    if (lineLock) return c.json(lineLock, 409);
  }

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
    if ('debtorName' in headerChanges && headerChanges['debtorName'] === null) {
      return c.json({ error: 'header_field_invalid', reason: 'Customer name cannot be blank — enter the corrected name instead.' }, 400);
    }
  }
  // A Processing Date removal clears the Delivery Date with it — one request, Purchaser signs (owner 2026-09-30).
  { const s = soRow as { processing_date?: unknown; customer_delivery_date?: unknown };
    Object.assign(headerChanges, withProcessingRemovalCascade(headerChanges, { processingDate: s.processing_date, deliveryDate: s.customer_delivery_date })); }
  const hasHeaderChanges = Object.keys(headerChanges).length > 0;
  const lockedByAmendment = Object.keys(headerChanges).map((k) => AMENDABLE_HEADER_FIELDS[k]).filter((col) => SO_IDENTITY_LOCK_COLS.has(col));
  if (lockedByAmendment.length > 0 && freezeRead.freeze.hasLiveDownstream) return c.json({ error: 'so_identity_locked', message: 'SO has a Delivery Order / Sales Invoice — customer, address and contact fields are locked.', lockedFields: lockedByAmendment }, 409);
  /* A line whose every requested value equals the line as stored asks for nothing
     and is dropped BEFORE the empty check and the lane split (lib/amendment-noop-lines):
     HC-SO-011410, owner 2026-09-15 — a phone Delivery Date change also carried two
     such lines and opened a Purchaser approval over no change. */
  const noopSplit = await dropNoopAmendmentLines(sb, docNo, Array.isArray(body.lines) ? body.lines : []);
  if (!noopSplit) return c.json(LINE_BUILD_ERRORS.unreadable, 500);
  const submittedLines = noopSplit.kept;
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

  {
    const mixLines = submittedLines.map((l) => ({
      salesOrderItemId: typeof l.salesOrderItemId === 'string' ? l.salesOrderItemId : null,
      changeType:       typeof l.changeType === 'string' ? l.changeType : null,
      newItemCode:      typeof l.newItemCode === 'string' ? l.newItemCode : null,
    }));
    const mainMix = await amendmentMixRefusal(sb, docNo, mixLines, activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  let needsPurchaserOk = false;
  let usesPoDateOverride = false;
  if (hasHeaderChanges) {
    const cur = soRow as { processing_date?: string | null; customer_delivery_date?: string | null };
    const ymd = (v: string | null | undefined): string => (v == null ? '' : String(v).slice(0, 10));
    const curProc = ymd(cur.processing_date);
    const curDeliv = ymd(cur.customer_delivery_date);
    const nextProc = 'processingDate' in headerChanges ? ymd(headerChanges['processingDate']) : curProc;
    const nextDeliv = 'customerDeliveryDate' in headerChanges ? ymd(headerChanges['customerDeliveryDate']) : curDeliv;
    const procMoves = 'processingDate' in headerChanges && curProc !== '' && nextProc !== curProc;
    const delivForward = 'customerDeliveryDate' in headerChanges && deliveryBroughtForward(curDeliv, nextDeliv);
    const hasLivePo = procMoves && await soHasLivePo(sb, docNo);
    if (processingDateFrozenByPo({ storedProc: curProc, nextProc, hasLivePo })) {
      if (!hasHouzsPerm(c, PROCESSING_DATE_PO_OVERRIDE_KEY)) return c.json(PROCESSING_DATE_PO_LOCKED, 409);
      usesPoDateOverride = true;
    }
    needsPurchaserOk = deliveryNeedsPurchaserOk({
      storedDeliv: curDeliv,
      nextDeliv: 'customerDeliveryDate' in headerChanges ? nextDeliv : null,
      hasUnreceivedPo: delivForward && await soHasUnreceivedPo(sb, docNo),
    });
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
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

  /* Transport fee (owner 2026-11-11, Houzs): an amendment may not move the order
     to Sabah & co. without a fee, nor take the fee off. */
  {
    const stateMove = 'customerState' in headerChanges
      ? { state: headerChanges['customerState'] ?? null, country: await deriveCountryFromState(sb, headerChanges['customerState'] ?? null) }
      : null;
    const feeRefusal = await transportFeeEditRefusal(c, sb, docNo, {
      kind: 'amendment',
      state: stateMove,
      lines: (Array.isArray(body.lines) ? body.lines : []).map((l) => {
        const t = String(l.changeType ?? '').toUpperCase();
        return {
          op: t === 'ADD' ? 'ADD' as const : t === 'REMOVE' ? 'REMOVE' as const : 'CHANGE' as const,
          itemId: typeof l.salesOrderItemId === 'string' ? l.salesOrderItemId : null,
          itemCode: typeof l.newItemCode === 'string' && l.newItemCode.trim() ? l.newItemCode.trim() : null,
          qty: l.newQty == null ? null : Number(l.newQty),
          unitPriceSen: l.newUnitPriceSen == null ? null : Number(l.newUnitPriceSen),
        };
      }),
    });
    if (feeRefusal) return feeRefusal;
  }

  /* ── Two-lane split (owner rework 2026-07-27) ─────────────────────────────
     Classify every requested change into its approval lane — LINES (product
     lines → Purchasing) or DELIVERY (schedule/location, service lines →
     Logistics) — and, when the submission mixes both, SPLIT it into two
     amendment documents that live independent lives. Line classification keys
     off the line's IDENTITY (item_code + item_group — item_group routes a
     bare-code service line to Logistics), resolved SERVER-SIDE from the order;
     an ADDED line has no row, so its code's CATALOGUE category stands in
     (docs/bugs/0895-an-amendment-that-added-a-service-line-went-to-the-purchaser.md). */
  // Price / add-cancel carve-outs are company-gated (owner 2026-09-21, 2026-11-16).
  // Read the ACTIVE company code, not the id — ids drift between environments.
  const companyCode = c.get('companyCode') ?? '';
  const priceLaneEnabled = PRICE_LANE_COMPANY_CODES.has(companyCode);
  const addRemoveLaneEnabled = ADD_REMOVE_LANE_COMPANY_CODES.has(companyCode);
  const split = await resolveAmendmentLaneSplit(sb, docNo, activeCompanyId(c), headerChanges, submittedLines, priceLaneEnabled, addRemoveLaneEnabled);
  if (!split) return c.json(LINE_BUILD_ERRORS.unreadable, 500);

  const openLanes = new Set(prior
    .filter((a) => (a.lane === 'LINES' || a.lane === 'DELIVERY' || a.lane === 'PRICE' || a.lane === 'LINE_ADDREMOVE') && a.status === 'REQUESTED')
    .map((a) => a.lane as AmendmentLane));
  const blockedLanes = split.lanes.filter((l) => openLanes.has(l));
  if (blockedLanes.length > 0) {
    return c.json({
      error: 'amendment_already_open',
      reason: `An amendment for ${blockedLanes.map((l) => LANE_LABEL[l]).join(' and ')} is already awaiting approval on this Sales Order — resolve it before requesting another change of that kind.`,
      lanes: blockedLanes,
    }, 409);
  }

  lap('amd-checks');
  const requesterStaffId = (await resolveCallerStaffId(sb, c.get('houzsUser')?.id)) ?? user.id;

  const createdAmendments: Array<{
    id: string; so_doc_no: string; amendment_no: string; status: string; lane: AmendmentLane;
    reason: string | null; requested_by: string | null; created_at: string;
  }> = [];
  const rollbackCreated = async () => {
    for (const a of createdAmendments) {
      await sb.from('so_amendments').delete().eq('id', a.id);
    }
  };

  /* Owner 2026-09-24: 「如果是 Logistic admin 修改客户信息, Delivery Date - 无需
     approver」. A DELIVERY half raised by someone who can already SIGN that lane,
     and that touches no service line, takes the shortcut: the row is still
     written (the revision, the audit, the write-back all hang off it) and the
     client applies it through the ordinary approve route, with every guard that
     route carries. The rule itself is shared/amendment-self-approve.ts — this
     file only asks it. Nothing here applies anything. */
  const holdsDeliveryKey = hasHouzsPerm(c, SELF_APPROVE_KEY);
  const selfApprovable: string[] = [];
  const purchaserOkNeeded: string[] = [];

  for (const [i, laneKey] of split.lanes.entries()) {
    const half = split.perLane[laneKey];
    const laneHasHeader = half.headerKeys.length > 0;
    const amendmentNo = `${docNo}/A${prior.length + 1 + i}`;

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
      reason:       body.reason,
      requested_by: requesterStaffId,
      company_id:   activeCompanyId(c),
      header_changes:      laneHasHeader ? half.headerChanges : null,
      old_header_snapshot: laneHasHeader ? oldHeaderSnapshot : null,
      ...(usesPoDateOverride && 'processingDate' in half.headerChanges ? { po_date_override_by: requesterStaffId } : {}),
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

    if (half.lines.length > 0) {
      const built = await buildAmendmentLineRows(sb, docNo, amendment.id, half.lines);
      if (!built.ok) {
        await rollbackCreated();
        return built.reason === 'unreadable'
          ? c.json(LINE_BUILD_ERRORS.unreadable, 500)
          : c.json(LINE_BUILD_ERRORS.missing(built.missingIds.length), 409);
      }
      const { error: lineErr } = await sb.from('so_amendment_lines').insert(stampCompany(built.rows, c));
      if (lineErr) {
        await rollbackCreated();
        return c.json({ error: 'create_failed', reason: lineErr.message }, 500);
      }
    }

    const awaitsPurchaserOk = laneKey === 'DELIVERY' && needsPurchaserOk && 'customerDeliveryDate' in half.headerChanges;
    if (awaitsPurchaserOk) purchaserOkNeeded.push(amendment.amendment_no);
    else if (laneSelfApproves(laneKey, { holdsLaneKey: holdsDeliveryKey, hasLineChanges: half.lines.length > 0 })) {
      selfApprovable.push(amendment.id);
    }

    await recordAmendmentRequested(sb, {
      docNo, amendmentNo, lane: laneKey, actorId: user.id, reason: body.reason,
      actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
      headerKeys: half.headerKeys, headerChanges: half.headerChanges,
      oldHeaderSnapshot, columnOf: AMENDABLE_HEADER_FIELDS,
    });
  }

  lap('amd-write');
  await notifyAmendmentsRaised(c, sb, {
    docNo, reason: body.reason,
    created: createdAmendments.filter((a) => !selfApprovable.includes(a.id)),
    salespersonStaffId: (soRow as { salesperson_id?: string | null }).salesperson_id,
  });
  for (const amendmentNo of purchaserOkNeeded) {
    await notifySoAmendmentPurchaserOkNeeded(c.env, {
      amendmentNo, soDocNo: docNo, companyId: activeCompanyId(c),
      requesterName: c.get('houzsUser')?.name ?? null,
      requesterUserId: c.get('houzsUser')?.id ?? null,
    });
  }

  lap('amd-notify');
  return c.json({
    amendment: createdAmendments[0],
    amendments: createdAmendments,
    lanes: split.lanes,
    selfApprovable,
  }, 201);
});
