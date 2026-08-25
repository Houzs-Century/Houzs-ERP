// ----------------------------------------------------------------------------
// do-scan-token — the credential behind the no-login scan, for BOTH the things
// that get scanned: one delivery order, or one packing list (= one trip, whose
// scan moves every delivery order on the run).
//
// THE OWNER'S DECISION, after being shown the risk twice: 「就跟hookka一样」 —
// a public QR the driver opens with a normal phone camera and no login, exactly
// like Hookka's. That is settled. He accepted ONE addition Hookka does not have:
// a way to KILL one leaked link (`qr_revoked_at`, mig 0328), because Hookka's
// token has neither an expiry nor a kill switch while Houzs already runs that
// pattern on its other public surfaces (mig 0126, case_track_tokens).
//
// TWO KINDS, ONE MECHANISM (2026-08-26). The trip half was missed by PR #2722 on
// the stated reasoning that "a packing list is not a row — there is no
// packing_lists table, so there is nothing to hang a token on". True clause,
// wrong conclusion: A PACKING LIST IS A TRIP, AND A TRIP IS A ROW (scm.trips,
// uuid PK, mig 0053), carrying company_id NOT NULL from the very migration that
// gave scm.delivery_orders its own (mig 0083). So the trip gets the SAME column
// pair (mig 0329), the SAME atomic claim and the SAME resolver — deliberately
// one mechanism rather than two, because two would be a second place to forget
// the revocation check.
//
// Shape copied from Hookka's src/api/lib/do-qr-token.ts [external]. What was
// kept, and why each part is load-bearing:
//
//   · 64 hex chars from two crypto.randomUUID()s — ~244 bits. The token IS the
//     credential; there is nothing else between a stranger and the document.
//   · MINTED ONLY BY AN AUTHENTICATED ROUTE. The public route may RESOLVE a
//     token and may never create one, so the population of live public URLs is
//     exactly the population of papers the office has printed.
//   · AN ATOMIC CLAIM, so two people opening the print dialog at the same moment
//     cannot mint two diverging tokens and leave one of the two printed papers
//     dead. The UPDATE carries its own `qr_token IS NULL` predicate; the loser's
//     update matches no row and it re-reads the winner's value.
//
// What was deliberately NOT copied: Hookka's `ensureQrTokenColumns` runtime DDL.
// Houzs runs real migrations through scripts/pg-migrate.mjs, so the columns are
// mig 0328's job and a route that ALTERs a table on first use is a deploy-order
// workaround this repo does not need.
//
// ONE DIFFERENCE FROM HOOKKA WORTH STATING. Its claim predicate is
// `(qrtoken IS NULL OR qrtoken = '')`; this one is `qr_token IS NULL` alone.
// The empty-string half defends a column Hookka creates at runtime on a D1
// tree where a blank could arrive from anywhere. Here the column is created by
// a migration with no default and no backfill, and THIS FILE is its only
// writer — it writes a 64-hex string or nothing — so `''` is not a reachable
// value. resolveDoScanToken still re-checks the SHAPE of what it reads rather
// than trusting that argument, which is the cheap half of the defence.
// ----------------------------------------------------------------------------

/** Exactly 64 lower/upper hex characters. The shape gate, before any query. */
export const DO_SCAN_TOKEN_RE = /^[0-9a-f]{64}$/i;

/** Two UUIDs, hyphens stripped: 64 hex chars, ~244 bits of randomness. */
export function newDoScanToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
}

/**
 * What a resolved token proves. Note `companyId` in particular: the public
 * route has NO session, so this field — read off the row the token resolved to,
 * never off the request — is the entire tenant scope for everything that
 * follows. `scm.delivery_orders.company_id` is NOT NULL (mig 0083), and a row
 * that somehow carries no usable company resolves to `unknown` rather than being
 * served with an unscoped follow-up.
 */
export type ResolvedDoScan = {
  id: string;
  companyId: number;
  doNumber: string;
  customerName: string | null;
  city: string | null;
  state: string | null;
  status: string | null;
  onHold: boolean | null;
};

/** The columns the resolve reads. No money, no address line, no contact. */
const RESOLVE_COLS =
  'id, company_id, do_number, debtor_name, city, state, status, on_hold, qr_revoked_at';

/**
 * Resolve a token to exactly one delivery order, or `null`.
 *
 * THIS IS THE ONE QUERY IN THE WHOLE PUBLIC FLOW THAT CARRIES NO COMPANY
 * PREDICATE, and it cannot carry one: there is no session to take a company
 * from, and taking one from the request body would let the caller name it. What
 * makes that safe is that the predicate it DOES carry is unique — mig 0328 puts
 * a UNIQUE index on qr_token — so it resolves to one row and that row's
 * company_id becomes the scope for every statement after it.
 *
 * `unknown` is returned for an unknown token AND for a revoked one, on purpose
 * and by the same route out of this function: a different answer for a revoked
 * token tells whoever holds it that it used to be real, which is the one fact
 * the kill switch exists to stop leaking. Revocation is read only AFTER the row
 * is found, which is what mig 0126 established and why revoked_at needs no index.
 *
 * `read_failed` IS a separate answer, and it leaks nothing — a blip fails for
 * every token alike, so it says nothing about the one in hand. Collapsing it
 * into `unknown` would tell a driver standing at a lorry that the paper in his
 * hand is dead because the database hiccuped, which is the same dishonesty as
 * an unbound `error`: supabase-js does not throw, so the two are identical
 * unless somebody chooses to tell them apart.
 */
export type ResolvedDoScanResult =
  | { status: 'ok'; row: ResolvedDoScan }
  | { status: 'unknown' }
  | { status: 'read_failed' };

export async function resolveDoScanToken(
  sb: any,
  token: string,
): Promise<ResolvedDoScanResult> {
  if (!DO_SCAN_TOKEN_RE.test(token)) return { status: 'unknown' };
  const { data, error } = await sb
    .from('delivery_orders')
    .select(RESOLVE_COLS)
    .eq('qr_token', token)
    .maybeSingle();
  if (error) return { status: 'read_failed' };
  if (!data) return { status: 'unknown' };
  const row = data as {
    id?: string; company_id?: number | string | null; do_number?: string | null;
    debtor_name?: string | null; city?: string | null; state?: string | null;
    status?: string | null; on_hold?: boolean | null; qr_revoked_at?: string | null;
  };
  /* Killed. Same answer as never-existed, deliberately — see above. */
  if (row.qr_revoked_at) return { status: 'unknown' };
  const companyId = Number(row.company_id);
  /* NO USABLE COMPANY = UNKNOWN, never "serve it unscoped". company_id is NOT
     NULL (mig 0083), so this branch is unreachable on a healthy row — and it
     exists because the alternative to refusing is running the rest of the
     request with no tenant boundary at all. */
  if (!Number.isInteger(companyId) || companyId <= 0) return { status: 'unknown' };
  if (!row.id || !row.do_number) return { status: 'unknown' };
  return {
    status: 'ok',
    row: {
      id: row.id,
      companyId,
      doNumber: row.do_number,
      customerName: row.debtor_name ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
      status: row.status ?? null,
      onHold: row.on_hold ?? null,
    },
  };
}

/* ── THE PACKING-LIST (TRIP) HALF ─────────────────────────────────────────── */

/** The columns the trip resolve reads. No money, no address, no contact. */
const TRIP_RESOLVE_COLS = 'id, company_id, trip_no, trip_date, status, qr_revoked_at';

/**
 * One packing list, resolved from its token. `companyId` is the run's own, off
 * the row — the entire tenant scope for everything that follows, exactly as on
 * the delivery-order side.
 */
export type ResolvedTripScan = {
  id: string;
  companyId: number;
  tripNo: string;
  tripDate: string | null;
  status: string | null;
};

/**
 * ONE MEMBER OF A RUN, in the order the dispatcher sequenced it.
 *
 * `foreign` is the interesting field and it is not a paranoid edge case: trips
 * is a CROSS-COMPANY module by design — its own header says "a trip is raised
 * from whichever company you are in; it may still reference the other company's
 * DOs" — so a run legitimately CAN carry a stranger. On an authed dispatcher's
 * screen that is a feature. On a public, no-login scan it is a lever that would
 * move another company's books from a piece of paper, which is the shape of
 * bug 0497, so this surface refuses it. See the note on the public route.
 *
 * A foreign member carries NO document number and NO customer name — reporting
 * it by its stop number is the whole point, because printing the other
 * company's document number on a public page is the leak, not the fix.
 */
export type TripScanMember = {
  stopNo: number;
  doId: string;
  /** Null for a foreign member — deliberately withheld, see above. */
  doNumber: string | null;
  status: string | null;
  onHold: boolean | null;
  foreign: boolean;
};

/**
 * THREE ANSWERS, NEVER TWO. `not_found` and `read_failed` are different facts
 * and the caller must be able to tell them apart: supabase-js does not throw, so
 * a five-second database blip destructured as `const { data }` is
 * indistinguishable from "that delivery order is not in your books" — and the
 * honest answer to a blip is "try again", not a 404 that sends the operator
 * looking for a document that is right there.
 */
export type MintedDoScanToken =
  | { status: 'ok'; token: string }
  | { status: 'not_found' }
  | { status: 'read_failed' };

/**
 * Create-if-missing, claimed atomically. AUTHENTICATED CALLERS ONLY — the
 * public route must never reach this function, and a test asserts it does not
 * import it.
 *
 * `companyId` is a REQUIRED argument rather than an optional one, per the repo
 * rule that a parameter which decides a scope must fail to compile when
 * forgotten: minting a token for a document is a write, and a write that cannot
 * say whose books it is in is the shape of bug 0497.
 *
 * `not_found` also covers "not this company's" — the same answer as "no such
 * delivery order", for the reason NOT_THIS_COMPANY states.
 */
export async function getOrCreateDoScanToken(
  sb: any,
  id: string,
  companyId: number,
): Promise<MintedDoScanToken> {
  return getOrCreateScanToken(sb, 'delivery_orders', id, companyId);
}

/**
 * The same mint, for either table. `table` is a CLOSED UNION LITERAL and never
 * caller input — that is what makes inlining it into `.from(...)` safe, and it
 * is the same reason Hookka's version gives for the identical pattern.
 */
export type ScanTokenTable = 'delivery_orders' | 'trips';

export async function getOrCreateScanToken(
  sb: any,
  table: ScanTokenTable,
  id: string,
  companyId: number,
): Promise<MintedDoScanToken> {
  type ReadResult =
    | { status: 'ok'; token: string | null }
    | { status: 'not_found' }
    | { status: 'read_failed' };

  const read = async (): Promise<ReadResult> => {
    const { data, error } = await sb
      .from(table)
      .select('qr_token')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) return { status: 'read_failed' };
    if (!data) return { status: 'not_found' }; // no such row IN THIS COMPANY
    return { status: 'ok', token: (data as { qr_token: string | null }).qr_token ?? null };
  };

  const existing = await read();
  if (existing.status !== 'ok') return existing;
  if (existing.token) return { status: 'ok', token: existing.token };

  const fresh = newDoScanToken();
  /* THE CLAIM. `.is('qr_token', null)` is what makes this atomic — Postgres
     serialises the two updates, so the second one matches no row and returns
     nothing. Never `.update()` after a plain read-then-branch: nothing
     re-checks between two PostgREST round trips (the standing company-scope
     rule (a), and the same mechanism as the double-cancel guard on the status
     handler). The company predicate rides on the write itself for the same
     reason, not only on the read above. */
  const { data: claimed, error: claimErr } = await sb
    .from(table)
    .update({ qr_token: fresh })
    .eq('id', id)
    .eq('company_id', companyId)
    .is('qr_token', null)
    .select('qr_token')
    .maybeSingle();
  /* A FAILED CLAIM IS NOT A LOST RACE. Both come back with no row, and reading
     them alike would send the caller to the re-read below, where a second blip
     answers not_found — a printable delivery order reported as somebody else's.
     Say the write failed. */
  if (claimErr) return { status: 'read_failed' };
  if (claimed) return { status: 'ok', token: (claimed as { qr_token: string }).qr_token };

  // Lost the race (or the row moved): the winner's value is the truth.
  const after = await read();
  if (after.status !== 'ok') return after;
  return after.token ? { status: 'ok', token: after.token } : { status: 'not_found' };
}

/**
 * Resolve a token to EITHER one delivery order or one packing list.
 *
 * The delivery-order table is asked first and the trip table second. Both
 * lookups are unique (migs 0328 / 0329), so a token that resolves at all
 * resolves to exactly one row of exactly one kind; the caller branches on the
 * reported `kind` and never infers it from the token's shape, which is
 * identical for both on purpose.
 *
 * A failed read on EITHER lookup is `read_failed`, never `unknown`: the two are
 * indistinguishable unless the error is bound, and answering "unknown code" to a
 * database blip tells a driver standing at a lorry that his paper is dead.
 */
export type ResolvedScanResult =
  | { status: 'ok'; kind: 'do'; row: ResolvedDoScan }
  | { status: 'ok'; kind: 'trip'; row: ResolvedTripScan }
  | { status: 'unknown' }
  | { status: 'read_failed' };

export async function resolveScanToken(sb: any, token: string): Promise<ResolvedScanResult> {
  if (!DO_SCAN_TOKEN_RE.test(token)) return { status: 'unknown' };

  const asDo = await resolveDoScanToken(sb, token);
  if (asDo.status === 'read_failed') return { status: 'read_failed' };
  if (asDo.status === 'ok') return { status: 'ok', kind: 'do', row: asDo.row };

  const { data, error } = await sb
    .from('trips')
    .select(TRIP_RESOLVE_COLS)
    .eq('qr_token', token)
    .maybeSingle();
  if (error) return { status: 'read_failed' };
  if (!data) return { status: 'unknown' };
  const row = data as {
    id?: string; company_id?: number | string | null; trip_no?: string | null;
    trip_date?: string | null; status?: string | null; qr_revoked_at?: string | null;
  };
  /* Killed. Same answer as never-existed — a different one would tell whoever
     holds a leaked sheet that the code used to be real. */
  if (row.qr_revoked_at) return { status: 'unknown' };
  const companyId = Number(row.company_id);
  /* NO USABLE COMPANY = UNKNOWN, never "serve it unscoped". company_id is NOT
     NULL on scm.trips (mig 0083); refusing is the only alternative to running
     the rest of the request with no tenant boundary at all. */
  if (!Number.isInteger(companyId) || companyId <= 0) return { status: 'unknown' };
  if (!row.id || !row.trip_no) return { status: 'unknown' };
  return {
    status: 'ok',
    kind: 'trip',
    row: {
      id: row.id,
      companyId,
      tripNo: row.trip_no,
      tripDate: row.trip_date ?? null,
      status: row.status ?? null,
    },
  };
}

export type TripMembersResult =
  | { status: 'ok'; members: TripScanMember[] }
  | { status: 'read_failed' };

/**
 * The run's delivery orders, IN `stop_no` ORDER — the sequence the dispatcher
 * built and the one the owner's spec cares about.
 *
 * TWO READS, AND THE SECOND ONE IS DELIBERATELY NOT SCOPED TO THE RUN'S
 * COMPANY. That looks wrong and is the opposite:
 *
 *   · The stops are read by `trip_id` alone. Normally a parent-ownership
 *     predicate proves the row is on that document and NOT whose document it is
 *     (the standing company-scope rule (b)) — which is why it is not enough on
 *     its own. Here the parent was resolved through a UNIQUE token one statement
 *     earlier, so "whose trip is this" is already answered by the trip row, and
 *     `trip_id` is the correct and complete predicate for its children.
 *   · The delivery orders are then read BY ID, returning each one's OWN
 *     `company_id`. Scoping that read to the run's company would make a foreign
 *     member vanish instead of being reported — and a member that silently
 *     disappears from a driver's sheet is worse than one he is told about,
 *     because he loads it anyway. So the read is by id and the COMPARISON is the
 *     guard: anything whose company differs is marked `foreign`, gets no
 *     document number and no customer name, and is refused by the caller.
 *
 * Every WRITE that follows is still scoped to the run's company. Reading a
 * stranger's id and status in order to refuse it is not the same act as writing
 * to it, and this is the one place the difference is load-bearing.
 */
export async function loadTripScanMembers(
  sb: any,
  trip: ResolvedTripScan,
): Promise<TripMembersResult> {
  const { data: stopData, error: stopErr } = await sb
    .from('trip_stops')
    .select('stop_no, do_id')
    .eq('trip_id', trip.id)
    .order('stop_no', { ascending: true });
  if (stopErr) return { status: 'read_failed' };
  const stops = ((stopData ?? []) as Array<{ stop_no: number | null; do_id: string | null }>)
    .filter((r) => typeof r.do_id === 'string' && r.do_id);
  if (stops.length === 0) return { status: 'ok', members: [] };

  const { data: doData, error: doErr } = await sb
    .from('delivery_orders')
    .select('id, company_id, do_number, status, on_hold')
    .in('id', stops.map((r) => r.do_id as string));
  if (doErr) return { status: 'read_failed' };
  const byId = new Map<string, {
    id: string; company_id: number | string | null; do_number: string | null;
    status: string | null; on_hold: boolean | null;
  }>();
  for (const r of (doData ?? []) as any[]) byId.set(String(r.id), r);

  const members: TripScanMember[] = [];
  const seen = new Set<string>();
  for (const s of stops) {
    const doId = s.do_id as string;
    /* A delivery order can legitimately appear at more than one stop; it is ONE
       document and must be advanced once, or the second pass reports a spurious
       "already done" and the count on the sheet stops matching the load. */
    if (seen.has(doId)) continue;
    seen.add(doId);
    const row = byId.get(doId);
    if (!row) {
      /* The stop names a delivery order the read did not return. Not silently
         dropped: it is a member the driver can see on his sheet, so it is
         reported as one he cannot move. */
      members.push({ stopNo: Number(s.stop_no ?? 0), doId, doNumber: null, status: null, onHold: null, foreign: true });
      continue;
    }
    const foreign = Number(row.company_id) !== trip.companyId;
    members.push({
      stopNo: Number(s.stop_no ?? 0),
      doId,
      doNumber: foreign ? null : (row.do_number ?? null),
      status: foreign ? null : (row.status ?? null),
      onHold: foreign ? null : (row.on_hold ?? null),
      foreign,
    });
  }
  return { status: 'ok', members };
}
