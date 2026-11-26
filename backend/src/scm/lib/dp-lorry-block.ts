
/** Prefix every DP-owned window shares — the family name a human scanning the
 *  maintenance list can recognise, and the thing to grep for. */
export const DP_LORRY_BLOCK_PREFIX = 'DP lorry service';

/** The exact `reason` a scheduled lorry-service job writes and its cancel
 *  deletes. One job, one string, one row. */
export function dpLorryBlockReason(dpNo: string): string {
  return `${DP_LORRY_BLOCK_PREFIX} — ${dpNo}`;
}

/** Does this window belong to a DP job? Used nowhere yet by production code —
 *  it exists so a future reader of the maintenance list can tell DP-owned
 *  windows from hand-entered ones without re-deriving the format. */
export function isDpLorryBlock(reason: string | null | undefined): boolean {
  return (reason ?? '').startsWith(`${DP_LORRY_BLOCK_PREFIX} `);
}
