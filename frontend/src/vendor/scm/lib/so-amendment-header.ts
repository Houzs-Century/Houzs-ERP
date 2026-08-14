// ----------------------------------------------------------------------------
// so-amendment-header — PURE diff logic for the HEADER half of an SO amendment.
// NO React, no I/O. Desktop SalesOrderDetail and mobile MobileNewSO both feed
// their own form state into these, so the "what can an amendment carry" rule
// lives ONCE.
//
// WHY THIS EXISTS (Owner 2026-07-16): "我就是 processing date 過了 我才需要 submit
// SO Amendment request 修改東西啊 應該是全部可以 request 啊 然後看有沒有 approval"
// — once an SO is processing-locked, EVERYTHING the lock freezes must still be
// requestable through the amendment; approval decides. The amendment previously
// carried LINE diffs only, so a Delivery Date change had nowhere to go: the
// direct header PATCH 409s it (so_locked_processing) and the amendment dropped
// it silently.
//
// THE TWO HALVES OF AN EDIT ON A PROCESSING-LOCKED SO:
//   * FROZEN header columns (this module)   -> ride the amendment, need approval.
//   * everything else (customer contact, address lines, city, note, payment)
//     -> saved DIRECTLY by the normal header PATCH, no amendment, no approval.
//        Those never reach the supplier, so they were never amendment material
//        (Owner: "有些東西原本不需要 SO amendment 都可以 edit 的 例如顧客名字 電話號碼").
//
// The key set below mirrors the backend's SO_PROCESSING_LOCK_COLS
// (scm/routes/mfg-sales-orders.ts) EXACTLY — that Set is what the header PATCH
// rejects while locked, so it is precisely what must be requestable here. Keep
// the two in step: a column added to the lock with no entry here becomes
// un-amendable (the bug this closes).
//
// `sales_location` is in the backend lock Set but is NOT a key here: it is
// DERIVED from customerState (deriveWarehouseIdFromState) and is re-derived
// server-side when the amendment applies, exactly as the header PATCH does.
// ----------------------------------------------------------------------------

/** The header fields an amendment can request a change to. Payload keys are the
    camelCase names the API already uses on the SO header PATCH.

    Owner 2026-07-17 — the AUTHORITY for this list is now the shared
    SO_HEADER_FIELD_POLICY table (so-field-policy.ts), which is the single
    source of truth for the FREE / CONTROLLED split and is drift-tested against
    the backend's copy.

    It stays an `as const` literal here rather than a call to
    soAmendableHeaderKeys() for one reason only: AmendableHeaderKey is a union
    type the whole amendment surface depends on, and a function returning
    string[] cannot produce it. So the literal is kept, and
    so-field-policy.test.ts asserts it equals soAmendableHeaderKeys() exactly —
    a mismatch fails CI. Do not add a key here without adding the row there.

    `city` joined 2026-07-17: it was the casualty of the old three-list prose
    mirroring — disabled by the mobile UI and named in its lock copy, but in
    neither backend set, so it was both un-editable AND un-requestable. */
export const AMENDABLE_HEADER_KEYS = [
  'processingDate',
  'customerDeliveryDate',
  'customerState',
  'postcode',
  'city',
  /* Two-lane rework phase 2 (owner 2026-07-27): the delivery-address block +
     disposal note join the amendable set (DELIVERY lane — Logistics signs;
     the Processing Date above signs with Purchasing per the same ruling). */
  'address1',
  'address2',
  'address3',
  'address4',
  'shipToAddress',
  'billToAddress',
  'installToAddress',
  'replacementDisposal',
] as const;

export type AmendableHeaderKey = (typeof AMENDABLE_HEADER_KEYS)[number];

/** Route an SO amendment HEADER key to its routing atom (amendment-routing.ts).
    All amendable header keys are scheduling / delivery-address changes — WHEN and
    WHERE it ships — so they classify as delivery/commercial, owned by Logistics. */
export const soHeaderFieldKind = (
  _key: AmendableHeaderKey,
): 'DELIVERY' => 'DELIVERY';

/** Only the CHANGED keys are present; a value of null clears the column. */
export type SoAmendmentHeaderChanges = Partial<Record<AmendableHeaderKey, string | null>>;

/** Human labels for the before/after diff (desktop AmendmentDetailV2 + the
    mobile "View changes" sheet render these, so the wording lives once). */
export const AMENDABLE_HEADER_LABELS: Record<AmendableHeaderKey, string> = {
  processingDate:       'Processing Date',
  customerDeliveryDate: 'Delivery Date',
  customerState:        'State',
  postcode:             'Postcode',
  city:                 'City',
  address1:             'Address line 1',
  address2:             'Address line 2',
  address3:             'Address line 3',
  address4:             'Address line 4',
  shipToAddress:        'Ship-to address',
  billToAddress:        'Bill-to address',
  installToAddress:     'Install-to address',
  replacementDisposal:  'Replacement / disposal',
};

/** Loose equality mirroring the backend's `norm()` — null / undefined / '' all
    collapse, so a form re-sending a blank field as '' does not read as a change
    from null. */
const norm = (v: string | null | undefined): string =>
  v === null || v === undefined ? '' : String(v).trim();

/** '' -> null so a cleared field persists as NULL (matches the PATCH payloads). */
const outValue = (v: string | null | undefined): string | null => {
  const n = norm(v);
  return n === '' ? null : n;
};

export type AmendableHeaderValues = Partial<Record<AmendableHeaderKey, string | null>>;

/**
 * Diff the operator's in-flight header values against the pristine SO header.
 *
 * Returns the CHANGED frozen fields only, plus an `oldSnapshot` of those same
 * keys for the before/after display — the header mirror of
 * buildAmendmentLines()'s per-line `oldSnapshot`. An untouched field is absent
 * from both, so re-submitting an unchanged past Delivery Date is a no-op rather
 * than a phantom amendment line.
 */
export function buildAmendmentHeaderChanges(
  next: AmendableHeaderValues,
  original: AmendableHeaderValues,
): { changes: SoAmendmentHeaderChanges; oldSnapshot: SoAmendmentHeaderChanges } {
  const changes: SoAmendmentHeaderChanges = {};
  const oldSnapshot: SoAmendmentHeaderChanges = {};
  for (const key of AMENDABLE_HEADER_KEYS) {
    if (!(key in next)) continue;          // surface doesn't collect this field
    if (norm(next[key]) === norm(original[key])) continue;   // untouched
    changes[key] = outValue(next[key]);
    oldSnapshot[key] = outValue(original[key]);
  }
  return { changes, oldSnapshot };
}

/** True when the amendment carries at least one header change. */
export const hasAmendmentHeaderChanges = (h: SoAmendmentHeaderChanges): boolean =>
  Object.keys(h).length > 0;

/** The date-valued amendable keys — rendered through the caller's date
    formatter so the numeric DD/MM/YYYY house rule applies. */
const DATE_HEADER_KEYS = new Set<AmendableHeaderKey>([
  'processingDate',
  'customerDeliveryDate',
]);

export type AmendmentHeaderDiffRow = {
  key: AmendableHeaderKey;
  label: string;
  from: string;
  to: string;
};

/**
 * Render-ready before/after rows for an amendment's HEADER half. Used by the
 * approver's job card (AmendmentDetailV2), the desktop SO-detail diff modal and
 * the mobile "View changes" sheet — all three previously rendered LINE diffs
 * only, so a header-only amendment (e.g. a Delivery Date change) showed as an
 * empty request and an approver would have been approving something invisible.
 *
 * `fmtDate` is injected rather than imported so this module stays pure and free
 * of any app-tree dependency (the vendored SCM lib boundary).
 */
export function amendmentHeaderDiffRows(
  changes: SoAmendmentHeaderChanges | null | undefined,
  oldSnapshot: SoAmendmentHeaderChanges | null | undefined,
  fmtDate: (v: string) => string,
): AmendmentHeaderDiffRow[] {
  if (!changes) return [];
  const old = oldSnapshot ?? {};
  const show = (key: AmendableHeaderKey, v: string | null | undefined): string => {
    if (v == null || v === '') return '—';
    return DATE_HEADER_KEYS.has(key) ? fmtDate(v) : v;
  };
  return (Object.keys(changes) as AmendableHeaderKey[])
    .filter((k) => k in AMENDABLE_HEADER_LABELS)
    .map((k) => ({
      key:   k,
      label: AMENDABLE_HEADER_LABELS[k],
      from:  show(k, old[k]),
      to:    show(k, changes[k]),
    }));
}

/**
 * The header patch to send ALONGSIDE an amendment: every frozen field is forced
 * back to its ORIGINAL value so the direct PATCH stays inside the server's
 * field-scoped lock (it 409s `so_locked_processing` on a genuine change to a
 * frozen column, and passes an unchanged one). The requested new values travel
 * on the amendment instead. Non-frozen fields in `patch` (name / phone / email /
 * address lines / note) pass through untouched and save immediately.
 *
 * `salesLocation` needs its own treatment. It is a frozen column server-side
 * (SO_PROCESSING_LOCK_COLS) but it is not amendable directly — it is DERIVED
 * from the State, and BOTH forms recompute it live from the State picker. So an
 * amendment that changes the State would carry a changed sales_location in this
 * patch and 409 on it. Dropping the key entirely leaves it out of the server's
 * `col in updates` diff, so the lock passes and the column is untouched; the
 * apply step re-derives it from the approved State exactly as the header PATCH
 * would. That is also why it is absent from AMENDABLE_HEADER_KEYS.
 */
export function withFrozenHeaderFieldsReverted<T extends Record<string, unknown>>(
  patch: T,
  original: AmendableHeaderValues,
): T {
  const out: Record<string, unknown> = { ...patch };
  for (const key of AMENDABLE_HEADER_KEYS) {
    if (key in out) out[key] = outValue(original[key]);
  }
  delete out['salesLocation'];
  // Double cast: T is a generic constrained to Record<string, unknown>, so a
  // direct `as T` from the widened Record is not a comparable conversion.
  return out as unknown as T;
}
