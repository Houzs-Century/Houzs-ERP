// ----------------------------------------------------------------------------
// so-form-validate — PURE save-time guards for the NEW / EDIT Sales-Order form.
// NO React, no I/O. Desktop `SalesOrderNew` and mobile `MobileNewSO` both feed
// their own state into these, so a guard can't exist on one surface and be
// missing on the other (mobile was missing the past-date / processing>delivery
// guards, and silently DROPPED a slip-less payment — a real money bug where a
// cashier's payment never posted).
//
// Each guard returns the FIRST blocking error as `{ title, body? }` (both
// surfaces short-circuit on the first failure) or null when the input passes.
// Desktop renders it via notify({title, body}); mobile flattens to a sentence.
// ----------------------------------------------------------------------------

export interface SoFormError {
  title: string;
  body?: string;
}

/** Flatten a structured error into a single sentence (mobile `setError`). */
export const soErrorText = (e: SoFormError): string =>
  e.body ? `${e.title} ${e.body}` : e.title;

export interface SoDateGuardInput {
  /** '' when unset. */
  processingDate: string;
  deliveryDate: string;
  /** todayMyt() — MYT calendar day, NOT the device clock. */
  today: string;
  /**
   * Enforce the "both dates or neither" rule. Desktop always does; mobile skips
   * it for a draft (it strips both dates), so pass false there.
   */
  requireDatesTogether?: boolean;
  /**
   * GRANDFATHER (Owner 2026-06-01) — the value ALREADY SAVED on this SO, for an
   * EDIT flow. Omit / '' on a create form (every date is then a fresh entry).
   *
   * The not-in-past rule exists to stop someone SETTING a date in the past. An
   * already-saved past date that this edit does not touch is a historical record
   * — re-submitting it unchanged is not "setting a past date", it is leaving it
   * alone, so the rule must not fire on it. Without this, an SO that needs an
   * amendment (which by definition has a PAST processing date) could never have
   * that amendment submitted: its own unchanged date blocked the save.
   */
  originalProcessingDate?: string;
  originalDeliveryDate?: string;
  /**
   * Remove-Processing-Date gate (Owner 2026-07-09, port of 2990 #717) — false
   * when the caller LACKS `scm.so.remove_processing_date`. Clearing a set
   * Processing Date pulls the SO back out of the Proceed lane, so the server
   * 403s a non-holder; this turns that raw code into a plain sentence BEFORE
   * the request goes out.
   *
   * Defaults to TRUE (permissive): a create form has no original date, so the
   * rule can't fire, and any surface that forgets to pass it simply degrades to
   * the server's 403 rather than wrongly blocking a holder.
   */
  canRemoveProcessingDate?: boolean;
}

/** True when `v` is a non-empty date identical to the already-saved original —
    i.e. this edit is leaving it exactly as it was. */
const unchanged = (v: string, original: string | undefined): boolean =>
  v !== "" && original != null && v === original.trim();

/**
 * Date sanity for an SO: dates set together, not in the past, and processing
 * (factory start) not after delivery. Mirrors desktop `SalesOrderNew.onSave`
 * (Commander 2026-05-28 / Owner 2026-06-03) verbatim.
 *
 * The not-in-past rule applies ONLY to a date this edit CHANGED (see
 * originalProcessingDate / originalDeliveryDate). The XOR (set-together) and
 * processing<=delivery rules always run against the REAL submitted values, so a
 * newly-typed past date, or a date moved to another past day, is still rejected.
 */
export function soDateGuardError(i: SoDateGuardInput): SoFormError | null {
  const p = i.processingDate.trim();
  const d = i.deliveryDate.trim();
  const hasP = p !== "";
  const hasD = d !== "";
  /* Runs BEFORE the XOR rule: clearing the Processing Date always trips XOR too
     (or forces the paired Delivery clear), and "you may not remove this" is the
     reason the save is blocked — the XOR sentence would misdirect. */
  if (
    !hasP &&
    (i.originalProcessingDate ?? "").trim() !== "" &&
    !(i.canRemoveProcessingDate ?? true)
  ) {
    return {
      title: "Only a Super Admin can remove the Processing Date.",
      body: "Removing it pulls the order back out of Proceed — ask a Super Admin to do it.",
    };
  }
  if ((i.requireDatesTogether ?? true) && hasP !== hasD) {
    return {
      title: "Processing Date and Delivery Date must be set together.",
      body:
        "Either fill in BOTH dates, or leave BOTH empty — partial dates cause scheduling issues.",
    };
  }
  if (hasP && p < i.today && !unchanged(p, i.originalProcessingDate)) {
    return { title: "Processing Date cannot be in the past — pick today or a future date." };
  }
  if (hasD && d < i.today && !unchanged(d, i.originalDeliveryDate)) {
    return { title: "Delivery Date cannot be in the past — pick today or a future date." };
  }
  if (hasP && hasD && p > d) {
    return { title: "Processing Date cannot be later than the Delivery Date." };
  }
  return null;
}

export interface SoPaymentGuardRow {
  /** Payment amount in sen/cents. */
  amountCenti: number;
  /**
   * True when this amount-bearing row has proof attached — a freshly uploaded
   * slip session OR (desktop) a scanned receipt whose R2 key IS the slip.
   */
  hasSlip: boolean;
}

/**
 * Every amount-bearing payment must carry a slip before the SO is saved — the
 * POST /:docNo/payments route 400s a slip-less payment, and (the bug this
 * closes on mobile) silently dropping such a row loses the payment entirely.
 * Mirrors desktop `SalesOrderNew.onSave` Spec D4.
 */
export function soSliplessPaymentError(rows: SoPaymentGuardRow[]): SoFormError | null {
  const n = rows.filter((r) => r.amountCenti > 0 && !r.hasSlip).length;
  if (n === 0) return null;
  return {
    title: "Each payment needs a slip uploaded before saving.",
    body:
      `${n} payment row${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} missing a slip — upload ` +
      `${n === 1 ? "it" : "them"} (the "Slip *" button) and try again.`,
  };
}

/**
 * The companies whose orders must resolve a stock location before they can be
 * created. MIRRORS `LOCATION_REQUIRED_COMPANY_CODES` in
 * `backend/src/scm/lib/so-location-gate.ts` — the backend is the authoritative
 * gate; this list only decides whether the operator is told before or after the
 * round-trip. Add a company's `companies.code` to BOTH.
 */
export const LOCATION_REQUIRED_COMPANY_CODES: readonly string[] = ["HOUZS"];

export interface SoLocationGuardInput {
  /** Active company code from `useBranding().companyCode` ('HOUZS' | '2990'). */
  companyCode: string | null | undefined;
  /**
   * The read-only "Sales Location" the form resolved from the picked State
   * (state_warehouse_mappings). '' when nothing resolved — which is the ONLY
   * thing AutoCount actually cares about, and it covers both causes at once.
   */
  salesLocation: string;
  /** The picked State ('' when none) — used only to name the right cause. */
  state: string;
  /**
   * False while `useStateWarehouseMappings()` has not answered yet, on a
   * surface that resolves the location from it. An unloaded mapping table makes
   * every State look unmapped, and refusing a legitimate order because a query
   * is in flight is worse than letting the server (which reads the mappings
   * directly) have the last word. Defaults TRUE for surfaces that resolve no
   * location at all and must still be gated.
   */
  mappingsLoaded?: boolean;
  /** True for Save-as-draft. A draft is never written to AutoCount. */
  asDraft?: boolean;
  /**
   * True on an EDIT of an existing order. An edit enqueues an AutoCount EDIT,
   * which leaves the account book's own Location alone — only a CREATE has a
   * foreign key to satisfy.
   */
  isEdit?: boolean;
}

/**
 * A Sales Order this company writes to AutoCount must ship from a warehouse.
 *
 * Owner 2026-08-13, after both write-back test orders were refused: "Company 1
 * (Houzs Century) 开单必须有 State。Company 2 (2990) 不需要。其他公司也不必填。"
 * The order's warehouse is derived from the customer's State through
 * state_warehouse_mappings, and AutoCount rejects a document line whose
 * Location is not in `dbo.Location` — so a State-less order is refused by the
 * account book AFTER the salesperson has been told it saved.
 *
 * Gates on the RESOLVED Sales Location, not on the State being picked: a State
 * with no warehouse mapping resolves nothing either, and that second case is an
 * administrator's job, so it gets its own sentence rather than telling the
 * salesperson to pick a State they already picked.
 */
export function soStockLocationError(i: SoLocationGuardInput): SoFormError | null {
  if (i.asDraft || i.isEdit) return null;
  if (i.mappingsLoaded === false) return null;
  const code = (i.companyCode ?? "").trim().toUpperCase();
  if (!code || !LOCATION_REQUIRED_COMPANY_CODES.includes(code)) return null;
  if (i.salesLocation.trim() !== "") return null;

  const state = i.state.trim();
  if (!state) {
    return {
      title: "Pick the delivery State before creating this order.",
      body:
        "The State decides which warehouse the order ships from, and an order with no " +
        "warehouse cannot be created. Fill in the delivery address, then try again.",
    };
  }
  return {
    title: `${state} has no warehouse mapped, so this order has no stock location.`,
    body: "Ask an administrator to map that State to a warehouse, then try again.",
  };
}
