/* The purchase order's save-time version check (sister review G6; Hookka
 * #1228). The SO has had one since WO-8 (`so_version_conflict`); the PO had
 * none, and the desktop editor re-sends the WHOLE header once any field is
 * touched, so the second of two buyers with the same PO open silently put back
 * the supplier, dates and notes the first had just saved.
 *
 * The token is `purchase_orders.updated_at` as the editor loaded it. Every
 * header write, status move and amendment apply bumps that column, so "still
 * equal" means "nobody saved since you opened it". A missing token is refused
 * (428), never treated as last-writer-wins: the only client that sends this
 * PATCH is the desktop editor, which always has the loaded row.
 *
 * The token is compared in JS against the row read just before the write, which
 * alone cannot separate two saves landing inside the same few milliseconds:
 * both read the same row and both pass. So the PATCH also claims
 * `purchase_orders.version` (mig 20261110T2000, the SO's 0153 shape) with a
 * database compare-and-set before its first write; the loser gets
 * `poVersionRaced()`. The token stays the client's half because every PO writer
 * bumps `updated_at`, while only this PATCH bumps `version`. */

export const PO_VERSION_REQUIRED = {
  error: 'po_version_required',
  message: 'This purchase order was opened with an older screen. Your changes are still here; refresh the order before saving again.',
} as const;

export const PO_VERSION_CONFLICT = {
  error: 'po_version_conflict',
  message: 'Someone else saved this purchase order while you were editing. Your changes are still on this screen; refresh to see theirs before saving again.',
} as const;

const ms = (v: unknown): number => (typeof v === 'string' && v.trim() ? Date.parse(v) : Number.NaN);

/** The refusal for this PATCH body against the row as it stands, or null when
 *  the caller's loaded version is still current. */
export function poVersionRefusal(
  body: Record<string, unknown>,
  currentUpdatedAt: unknown,
): { status: 428; body: typeof PO_VERSION_REQUIRED } | { status: 409; body: typeof PO_VERSION_CONFLICT & { currentUpdatedAt: string | null } } | null {
  const token = body.expectedUpdatedAt;
  if (typeof token !== 'string' || token.trim() === '') return { status: 428, body: PO_VERSION_REQUIRED };
  const a = ms(token);
  const b = ms(currentUpdatedAt);
  if (Number.isFinite(a) && Number.isFinite(b) && a === b) return null;
  return { status: 409, body: { ...PO_VERSION_CONFLICT, currentUpdatedAt: typeof currentUpdatedAt === 'string' ? currentUpdatedAt : null } };
}

/** The refusal for the save that lost the database compare-and-set: another
 *  save claimed the next version between this one's read and its write. */
export function poVersionRaced(): typeof PO_VERSION_CONFLICT & { currentUpdatedAt: null } {
  return { ...PO_VERSION_CONFLICT, currentUpdatedAt: null };
}
