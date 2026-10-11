// ---------------------------------------------------------------------------
// dp-no-mint.ts — the DB-aware half of DP numbering.
//
// lib/dp-no.ts stays PURE (string maths, tested without a database). This file is
// the part that has to talk to Postgres: resolve the lorry's plate, read the
// numbers already handed out, and mint the next one.
//
// THE REGISTRY IS BOTH TABLES. A DP number can exist in two places:
//   • scm.trip_stops.dp_no  — every scheduled job, whichever entry path made it
//   • scm.dp_orders.dp_no   — a manually-created order, including one scheduled
//                             HEADER-ONLY (date + lorry, no trip yet), which has
//                             no stop to carry the number
// Reading only one of them is how the two paths would hand out the same number.
// The manual path's own bug was exactly this shape before the unification: it read
// dp_orders alone, which was complete only while dp_orders was the sole minter.
//
// max+1, NEVER count+1 — inherited from lib/doc-no.ts and the 2026-06-12 POS
// outage it commemorates: a deleted row makes count+1 collapse onto a live number.
// ---------------------------------------------------------------------------

import { dpNoPrefix, formatDpNo, nextDpSeq, plateLetters } from './dp-no';

/* The PostgREST client is typed `any` here, matching lib/deliveryScope.ts. The
   real SupabaseClient's builders are thenable-but-not-Promise and deeply generic;
   a hand-written structural type for them does not unify (TS2589 "excessively
   deep") and buys no safety, since every field read below is already validated at
   runtime. The tests pass a small fake through the same door. */
type Sb = any;

/** The day-wide prefix used to read candidates: `DP-YYMMDD-`. Plate letters are
 *  NOT included, so ONE read covers every lorry that day; `nextDpSeq` then filters
 *  by the exact per-lorry prefix. Fewer round trips, same answer. */
export function dayPrefix(isoDate: string): string {
  const m = String(isoDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `DP-${m[1].slice(2)}${m[2]}${m[3]}-` : 'DP-000000-';
}

/** Pull the dp_no strings out of a PostgREST result, tolerating the camelCase
 *  dual-read the rest of scm lives with. */
export function collectDpNos(rows: unknown): string[] {
  return ((rows ?? []) as Array<{ dp_no?: unknown; dpNo?: unknown }>)
    .map((r) => r?.dp_no ?? r?.dpNo)
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** Resolve a lorry's plate. Returns null when the lorry is unknown — the caller
 *  decides whether that is fatal, because it means different things on the two
 *  paths (a 404 when the user named the lorry; "skip numbering" when we inferred
 *  it from an existing trip). */
export async function plateForLorry(sb: Sb, lorryId: string | null | undefined): Promise<string | null> {
  if (!lorryId) return null;
  const r = await sb.from('lorries').select('plate').eq('id', lorryId).maybeSingle();
  const plate = (r.data as { plate?: string } | null)?.plate;
  return typeof plate === 'string' && plate.trim() !== '' ? plate : null;
}

/**
 * Mint the next DP number for (tripDate, plate), reading BOTH registries.
 *
 * A read failure is NOT swallowed into a lower number: if either table cannot be
 * read we do not know what has been handed out, and minting anyway would reissue a
 * live number. The caller gets null and leaves the job unnumbered — a job with no
 * number is visibly incomplete and fixable; two jobs sharing a number is a silent
 * corruption that surfaces as an argument between drivers.
 */
export async function mintNextDpNo(
  sb: Sb,
  args: { tripDate: string; plate: string },
): Promise<string | null> {
  const like = `${dayPrefix(args.tripDate)}%`;
  try {
    const [stops, orders] = await Promise.all([
      sb.from('trip_stops').select('dp_no').like('dp_no', like),
      sb.from('dp_orders').select('dp_no').like('dp_no', like),
    ]);
    const existing = [...collectDpNos(stops.data), ...collectDpNos(orders.data)];
    const prefix = dpNoPrefix(args.tripDate, args.plate);
    return formatDpNo(prefix, nextDpSeq(existing, prefix));
  } catch {
    return null;
  }
}

/** Convenience for the board path, which knows a lorry id rather than a plate. */
export async function mintDpNoForLorry(
  sb: Sb,
  args: { tripDate: string; lorryId: string | null | undefined },
): Promise<string | null> {
  const plate = await plateForLorry(sb, args.lorryId);
  if (!plate) return null;
  return mintNextDpNo(sb, { tripDate: args.tripDate, plate });
}

export { plateLetters };
