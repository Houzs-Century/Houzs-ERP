
/** What the caller sent. `undefined` means "field absent from the request". */
export interface CarrierLinkInput {
  threeplCompanyId?: string | null;
  ownFlag?: boolean;
  currentCarrierId?: string | null;
}

/** What to write. A key absent from the result must not be written at all. */
export interface CarrierLinkPatch {
  carrierId?: string | null;
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
