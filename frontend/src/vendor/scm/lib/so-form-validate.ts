// ----------------------------------------------------------------------------
// so-form-validate — PURE save-time guards for the NEW / EDIT Sales-Order form.
// NO React, no I/O. Desktop `SalesOrderNew` and mobile `MobileNewSO` both feed
// their own state into these, so a guard can't exist on one surface and be
// missing on the other (mobile was missing the past-date / processing>delivery
// guards desktop had).
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

/* NO SLIP GUARD LIVES HERE ANY MORE (Owner 2026-08-13) — "其实 SalesOrder
   所有的付款都不强制 ... 如果是 manually 填写的话,基本上不需要强求." A payment
   slip is OPTIONAL on every SO surface, so `soSliplessPaymentError` is gone
   rather than kept as a guard that always passes.

   What replaced it is NOT another guard: it is the requirement that every
   amount-bearing row is actually POSTED. The rule this file used to enforce
   only existed because both surfaces' post-create writers SKIPPED a slip-less
   row, so refusing the save was the only thing standing between a cashier and
   a payment that silently never booked. Both writers now post on AMOUNT alone
   (`recordNewPayments` on mobile, `flushPaymentDrafts` on desktop), which is
   what makes dropping the guard safe. `so-slip-optional-contract.test.ts`
   pins that pairing on both surfaces — if a writer ever goes back to
   filtering on the slip, that is the money bug returning, not a style change. */

/**
 * The companies whose orders must resolve a stock location before they can be
 * created. MIRRORS `LOCATION_REQUIRED_COMPANY_CODES` in
 * `backend/src/scm/lib/so-location-gate.ts` — the backend is the authoritative
 * gate; this list only decides whether the operator is told before or after the
 * round-trip. Add a company's `companies.code` to BOTH.
 */
export const LOCATION_REQUIRED_COMPANY_CODES: readonly string[] = ["HOUZS"];

/**
 * Does this company's order need a stock location? Mirrors
 * `companyRequiresStockLocation` in the backend gate, including the
 * deliberately UNGATED unknown/absent code — a surface that has not resolved
 * its branding yet must not start refusing orders.
 *
 * Exported so a surface can ask the QUESTION without pretending to answer the
 * whole guard: `SalesOrderNewFromProducts` collects no address, so it needs to
 * know which companies would refuse a CONFIRMED create in order to land a
 * DRAFT for them instead — and it must read the one list, never re-derive it.
 */
export function companyRequiresStockLocation(
  companyCode: string | null | undefined,
): boolean {
  const code = (companyCode ?? "").trim().toUpperCase();
  if (!code) return false;
  return LOCATION_REQUIRED_COMPANY_CODES.includes(code);
}

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
  if (!companyRequiresStockLocation(i.companyCode)) return null;
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

export interface SoRequiredFieldsInput {
  customerName: string;
  phone: string;
  /** True when at least one line has a product picked (itemCode) AND qty > 0. */
  hasNamedLine: boolean;
  /** Save-as-draft: a draft needs none of the confirm-only fields. */
  asDraft: boolean;
  /** Resolved venue — false when none picked. Confirm-only. */
  hasVenue: boolean;
  /** Resolved salesperson — false when none. Confirm-only. */
  hasSalesperson: boolean;
  /** Stock-location gate input — only its "no State picked" case counts as a
      missing FIELD here; the "State has no warehouse" config case stays with
      soStockLocationError, run separately AFTER this returns empty. */
  location: SoLocationGuardInput;
}

/**
 * Collect EVERY missing always-required field for a CREATE/CONFIRM in ONE pass,
 * so the operator sees them together instead of one dialog per field (owner
 * 2026-08-20, live QA: "为什么要慢慢爆呢" — why does it pop one at a time).
 *
 * Returns the human-readable labels of the missing fields (empty = all present).
 * The CONDITIONAL / SEQUENTIAL guards deliberately stay OUT of this and run after
 * it, because each only applies once an earlier choice is made: soDateGuardError
 * (only with dates), the sofa-mix rule (only with those lines), the
 * Processing-Date proceed gate (only with a date), the "State has no warehouse"
 * config error (only once a State is picked), and payment sub-fields (only with
 * payments). Shared by desktop SalesOrderNew and mobile MobileNewSO so the
 * required set can't drift between surfaces.
 */
export function soRequiredFieldErrors(i: SoRequiredFieldsInput): string[] {
  const missing: string[] = [];
  if (!i.customerName.trim()) missing.push("Customer name");
  if (!i.phone.trim()) missing.push("Phone number");
  if (!i.hasNamedLine) missing.push("At least one line item with a product");
  if (!i.asDraft) {
    if (!i.hasVenue) missing.push("Venue");
    if (!i.hasSalesperson) missing.push("Salesperson");
    // "No State picked yet" is a missing field the operator can fill now, so it
    // joins the list. The "picked State has no warehouse" case is an admin
    // config problem, not a field the operator forgot — it keeps its own
    // sentence via soStockLocationError, which the caller runs once this is empty.
    const l = i.location;
    const locationRequired =
      !l.asDraft && !l.isEdit && l.mappingsLoaded !== false &&
      companyRequiresStockLocation(l.companyCode);
    if (locationRequired && l.salesLocation.trim() === "" && l.state.trim() === "") {
      missing.push("Delivery State (it sets the shipping warehouse)");
    }
  }
  return missing;
}

/** What a PROCEEDING order needs on top of the always-required set.
 *
 * WHY IT IS HERE AND NOT LEFT TO THE CALLER. Its condition — "a Processing Date
 * was entered" — is known at the moment the button is pressed, exactly like
 * every field above it. So it is NOT one of the sequential guards that can only
 * be judged after an earlier choice; it only READ like one because it sat in a
 * second `if` further down the handler, and the first `if` returned before
 * reaching it.
 *
 * The cost of that, live: Venue and Delivery State on the first press, address
 * line 1 and postcode on the second. Owner 2026-08-23: 「create salesorder 要两
 * 次？」 — and 2026-08-20 already, 「为什么要慢慢爆呢」, which is when the
 * always-required set became one pass. This is the half that was left.
 *
 * Every parameter is REQUIRED, none optional: each one DECIDES whether a label
 * appears, and an optional one would let a caller silently keep the old
 * behaviour (CLAUDE.md's optional-param-noop rule).
 */
export interface SoProceedingAddressInput {
  /** Empty = the order is not proceeding, and none of this applies. */
  processingDate: string;
  customerName: string;
  /** Ticked BLANKS the address out of the payload, so it counts as missing. */
  fillAddressLater: boolean;
  address1: string;
  postcode: string;
  deliveryDate: string;
}

export function soProceedingAddressErrors(i: SoProceedingAddressInput): string[] {
  if (!i.processingDate.trim()) return [];
  const missing: string[] = [];
  if (!i.customerName.trim()) missing.push("customer name");
  if (i.fillAddressLater || !i.address1.trim()) missing.push("address line 1");
  if (i.fillAddressLater || !i.postcode.trim()) missing.push("postcode");
  if (!i.deliveryDate.trim()) missing.push("delivery date");
  return missing;
}

/** Render BOTH collected lists as ONE dialog/toast error.
 *
 *  Both arguments are required. Passing the proceeding list separately rather
 *  than concatenating it keeps its EXPLANATION — a Processing Date is what makes
 *  those fields required, and an operator who is not told that reads them as
 *  arbitrary.
 */
export function soRequiredFieldsMessage(missing: string[], proceeding: string[]): SoFormError {
  const all = [...missing, ...proceeding];
  /* The bare "X is required." shortcut is for the ALWAYS-required fields only.
     A lone proceeding field must keep its reason: "postcode is required" does
     not tell an operator that a postcode became required the moment they set a
     Processing Date, and they have no way to work that out. */
  if (all.length === 1 && proceeding.length === 0) {
    return { title: `${all[0]} is required.` };
  }
  const body = `Still missing: ${all.join(", ")}.`;
  /* Only the proceeding half is missing — lead with the reason it is required. */
  if (missing.length === 0) {
    return {
      title: "A Processing Date means this order is proceeding, so it needs a delivery address.",
      body,
    };
  }
  return {
    title: "Fill in the required fields before creating this order.",
    body: proceeding.length > 0
      ? `${body}\n\nThe address fields are required because a Processing Date is set — this order is proceeding.`
      : body,
  };
}
