// ---------------------------------------------------------------------------
// threepl-link.ts — the one rule that decides the OUTSOURCE flag when a fleet
// row is attached to (or detached from) a 3PL carrier company.
//
// WHY THIS IS SHARED. Drivers, helpers and lorries are three tables with three
// differently-named "ours" flags (drivers.in_house, helpers.in_house,
// lorries.is_internal) and three separate routes. Owner's rule is one sentence:
// a row that belongs to a 3PL company is OUTSOURCE, always. Restating that in
// three handlers is how two of them end up disagreeing — so it lives here, pure
// and tested, and each route only supplies its own column name.
//
// It writes nothing and knows no column names. Callers map the result.
// ---------------------------------------------------------------------------

/** What the caller sent. `undefined` means "field absent from the request". */
export interface CarrierLinkInput {
  /** The 3PL company id: a uuid to attach, null to detach, undefined to leave. */
  threeplCompanyId?: string | null;
  /** The caller's own-fleet flag (in_house / is_internal), if they sent one. */
  ownFlag?: boolean;
}

/** What to write. A key absent from the result must not be written at all. */
export interface CarrierLinkPatch {
  carrierId?: string | null;
  /** The own-fleet flag to write — false whenever a carrier is attached. */
  ownFlag?: boolean;
}

/**
 * PURE. Resolve the carrier link and the own-fleet flag together.
 *
 * - Attaching a carrier FORCES outsource, overriding any ownFlag the caller
 *   sent. The two fields cannot disagree: a lorry owned by ABC Logistics is not
 *   our lorry, whatever the form posted.
 * - Detaching (explicit null) clears the link and honours the caller's ownFlag
 *   if they sent one — a detached row is not automatically ours again, so with
 *   no ownFlag supplied the flag is left exactly as it was for a human to set.
 * - Absent (undefined) touches neither field.
 */
export function resolveCarrierLink(input: CarrierLinkInput): CarrierLinkPatch {
  const { threeplCompanyId, ownFlag } = input;

  if (threeplCompanyId === undefined) {
    return ownFlag === undefined ? {} : { ownFlag };
  }
  if (threeplCompanyId === null || threeplCompanyId === '') {
    return ownFlag === undefined ? { carrierId: null } : { carrierId: null, ownFlag };
  }
  return { carrierId: threeplCompanyId, ownFlag: false };
}

/**
 * PURE. The same rule for an INSERT, where the own-fleet flag always has to be
 * written. `defaultOwn` is the table's historical default for a row with no
 * carrier (true — a plain new driver/lorry is ours unless said otherwise).
 */
export function carrierLinkForInsert(
  input: CarrierLinkInput,
  defaultOwn = true,
): { carrierId: string | null; ownFlag: boolean } {
  const patch = resolveCarrierLink(input);
  return {
    carrierId: patch.carrierId ?? (typeof input.threeplCompanyId === 'string' && input.threeplCompanyId !== ''
      ? input.threeplCompanyId
      : null),
    ownFlag: patch.ownFlag ?? input.ownFlag ?? defaultOwn,
  };
}
