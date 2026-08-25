// ----------------------------------------------------------------------------
// do-scan-token — the credential behind the no-login delivery-order scan.
//
// THE OWNER'S DECISION, after being shown the risk twice: 「就跟hookka一样」 —
// a public QR the driver opens with a normal phone camera and no login, exactly
// like Hookka's. That is settled. He accepted ONE addition Hookka does not have:
// a way to KILL one leaked link (`qr_revoked_at`, mig 0328), because Hookka's
// token has neither an expiry nor a kill switch while Houzs already runs that
// pattern on its other public surfaces (mig 0126, case_track_tokens).
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
 * that somehow carries no usable company resolves to `null` here rather than
 * being served with an unscoped follow-up.
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
 * `null` is returned for an unknown token AND for a revoked one, on purpose and
 * by the same route out of this function: a different answer for a revoked token
 * tells whoever holds it that it used to be real, which is the one fact the kill
 * switch exists to stop leaking. Revocation is read only AFTER the row is found,
 * which is what mig 0126 established and why revoked_at needs no index.
 */
export async function resolveDoScanToken(
  sb: any,
  token: string,
): Promise<ResolvedDoScan | null> {
  if (!DO_SCAN_TOKEN_RE.test(token)) return null;
  const { data, error } = await sb
    .from('delivery_orders')
    .select(RESOLVE_COLS)
    .eq('qr_token', token)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    id?: string; company_id?: number | string | null; do_number?: string | null;
    debtor_name?: string | null; city?: string | null; state?: string | null;
    status?: string | null; on_hold?: boolean | null; qr_revoked_at?: string | null;
  };
  if (row.qr_revoked_at) return null;
  const companyId = Number(row.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) return null;
  if (!row.id || !row.do_number) return null;
  return {
    id: row.id,
    companyId,
    doNumber: row.do_number,
    customerName: row.debtor_name ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    status: row.status ?? null,
    onHold: row.on_hold ?? null,
  };
}

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
 * Returns `null` when the delivery order is not this company's — the same
 * answer as "no such delivery order", for the reason NOT_THIS_COMPANY states.
 */
export async function getOrCreateDoScanToken(
  sb: any,
  id: string,
  companyId: number,
): Promise<string | null> {
  const read = async (): Promise<string | null | undefined> => {
    const { data } = await sb
      .from('delivery_orders')
      .select('qr_token')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (!data) return undefined; // no such row IN THIS COMPANY
    return (data as { qr_token: string | null }).qr_token ?? null;
  };

  const existing = await read();
  if (existing === undefined) return null;
  if (existing) return existing;

  const fresh = newDoScanToken();
  /* THE CLAIM. `.is('qr_token', null)` is what makes this atomic — Postgres
     serialises the two updates, so the second one matches no row and returns
     nothing. Never `.update()` after a plain read-then-branch: nothing
     re-checks between two PostgREST round trips (the standing company-scope
     rule (a), and the same mechanism as the double-cancel guard on the status
     handler). The company predicate rides on the write itself for the same
     reason, not only on the read above. */
  const { data: claimed } = await sb
    .from('delivery_orders')
    .update({ qr_token: fresh })
    .eq('id', id)
    .eq('company_id', companyId)
    .is('qr_token', null)
    .select('qr_token')
    .maybeSingle();
  if (claimed) return (claimed as { qr_token: string }).qr_token;

  // Lost the race (or the row moved): the winner's value is the truth.
  const after = await read();
  return after ?? null;
}
