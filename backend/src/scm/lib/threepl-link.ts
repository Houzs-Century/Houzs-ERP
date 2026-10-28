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
  /** The carrier this row is ALREADY linked to, as read from the DB. Only a
   *  PATCH can supply it; a create has no current row. Without it the rule
   *  below cannot fire, which is exactly how the Fleet grid's tick-box got
   *  round it — see the conflict note. */
  currentCarrierId?: string | null;
}

/** What to write. A key absent from the result must not be written at all. */
export interface CarrierLinkPatch {
  carrierId?: string | null;
  /** The own-fleet flag to write — false whenever a carrier is attached. */
  ownFlag?: boolean;
  /**
   * Set when the request would leave the row marked OURS while it is still
   * linked to a carrier. The caller must refuse the write.
   *
   * WHY THIS EXISTS. Owner, 2026-08-02, on the Fleet grid's Outsource tick-box.
   * That control posts `{ id, inHouse }` and nothing else, so threeplCompanyId
   * was `undefined`, this function only flipped the flag, and a driver
   * belonging to MSJ TRANSPORT ended up with in_house = true while
   * threepl_company_id still pointed at MSJ. The 3PL screen's own footer
   * promises "you cannot mark them in-house while they belong to a 3PL" — that
   * promise was only ever kept on the paths that sent the carrier id.
   *
   * REFUSE, DO NOT AUTO-DETACH. Silently clearing the link would remove the
   * driver from that carrier's roster because someone ticked a box in a grid,
   * with nothing on screen saying so. Making them detach first is the same
   * number of clicks and says what it does.
   *
   * A patch carrying `conflict` intentionally carries NO writable key, so a
   * caller that forgets to check it writes nothing rather than the wrong thing.
   */
  conflict?: 'own_flag_while_linked';
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
 * - Absent (undefined) touches neither field — UNLESS the caller is trying to
 *   mark a row ours while it is still linked to a carrier, which is refused
 *   (see CarrierLinkPatch.conflict).
 */
export function resolveCarrierLink(input: CarrierLinkInput): CarrierLinkPatch {
  const { threeplCompanyId, ownFlag, currentCarrierId } = input;

  if (threeplCompanyId === undefined) {
    if (ownFlag === undefined) return {};
    /* Marking it ours while a carrier still owns it is the contradiction the
       DB cannot express (mig 0237 deliberately wrote no CHECK). Detaching is
       an explicit `threeplCompanyId: null`, which lands in the branch below. */
    if (ownFlag === true && currentCarrierId) return { conflict: 'own_flag_while_linked' };
    return { ownFlag };
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
