// ----------------------------------------------------------------------------
// migrated-so-readonly — the ROUTER-level guard that applies migrated-so-lock.
//
// Owner 2026-09-08: 「只开新单，旧单暂时不能改」. The decision lives in
// lib/migrated-so-lock.ts (pure, unit-tested); this is the one place that feeds
// it a request and turns a `true` into something a salesperson can act on.
//
// GUARDED AT THE ROUTER, NOT PER HANDLER — the same argument the mirrored-SO
// guard directly above it makes, and for the same file: mfg-sales-orders.ts
// holds ~22 write routes that carry a :docNo, and a per-writer guard leaves the
// NEXT writer added to the file unguarded by default. That is the shape that
// already cost this repo #600 / #625 / #632.
//
// THE PATH IS SCANNED SEGMENT-WISE rather than read from c.req.param('docNo'),
// copying the mirrored guard verbatim in intent: a `use('*')` mount has no
// matched params at all, and a guard that silently finds `undefined` and waves
// the write through is worse than no guard.
//
// WHAT IS DELIBERATELY NOT GUARDED:
//   • Every GET/HEAD/OPTIONS. Reading a migrated order is the entire point of
//     having imported it.
//   • POST / (create). A brand-new order carries no doc number in its path, so
//     it never reaches the lookup. That is the owner's ruling in one line.
//   • A path segment that names no sales order (`/recompute-allocation`,
//     `/backfill-warehouses`). The lookup finds no row, the answer is "not
//     migrated", the write proceeds. Safe by construction rather than by a
//     hand-maintained allow-list that the next static route would fall off.
//   • `*` / `scm.admin`. IT must still be able to correct a migrated document
//     during the lock — the same bypass cohort as the write freeze, so there is
//     one answer to "who can still save" and not two.
// ----------------------------------------------------------------------------
import type { Context, Next } from 'hono';
import { getSupabaseService } from '../../db/supabase';
import { soIsMigrated } from './so-is-migrated';
import { callerBypasses } from './write-freeze';
import { activeCompanyId } from './companyScope';
import {
  migratedSoIsLocked,
  migratedSoLockMessage,
  parseMigratedSoLock,
  type MigratedSoLockValue,
} from './migrated-so-lock';

const LOCK_TTL_MS = 30_000;
const LOCK_KEY = 'scm.migrated_so_lock';
const MOUNT_SEGMENT = 'mfg-sales-orders';

type LockState = { value: MigratedSoLockValue; message: string | null };
let cached: { at: number; state: LockState } | null = null;

/** Test seam — drop the cache so a toggle is observed immediately. */
export function resetMigratedSoLockCache(): void { cached = null; }

/** Test seam — prime the cache with a raw value so the middleware can be
 *  exercised without a database. `vi.mock` does not reliably intercept module
 *  imports under the Cloudflare Workers pool (recorded in
 *  tests/pvRateFromPayment.test.ts), so the seam is here rather than a mock —
 *  the same seam write-freeze.ts carries, for the same reason. */
export function primeMigratedSoLockCache(raw: string | null | undefined, description?: string | null): void {
  cached = { at: Date.now(), state: { value: parseMigratedSoLock(raw), message: description ?? null } };
}

type ConfigRow = { value?: string; description?: string } | null;
type ConfigReader = () => PromiseLike<{ data: ConfigRow; error: unknown }>;

/**
 * The doc number a request targets, or null when it targets none.
 *
 * Exported for the tests, which are the specification: `/mfg-sales-orders`
 * (create) and a trailing slash must both answer null, and a nested write must
 * answer the SAME doc number as a top-level one.
 */
export function soDocNoFromPath(path: string): string | null {
  const segs = path.split('?')[0].split('/').filter((s) => s.length > 0);
  const i = segs.lastIndexOf(MOUNT_SEGMENT);
  if (i === -1 || i + 1 >= segs.length) return null;
  const raw = segs[i + 1];
  try { return decodeURIComponent(raw); } catch { return raw; }
}

async function readLock(read: ConfigReader): Promise<LockState> {
  const now = Date.now();
  if (cached && now - cached.at < LOCK_TTL_MS) return cached.state;
  try {
    const { data, error } = await read();
    if (error) throw new Error((error as { message?: string }).message ?? 'app_config read failed');
    const state: LockState = { value: parseMigratedSoLock(data?.value), message: data?.description ?? null };
    cached = { at: now, state };
    return state;
  } catch {
    /* FAIL OPEN, deliberately — the OUTAGE case, not the typo case. An
       unreachable app_config is not an instruction, and the migrated documents
       are still sitting behind the write freeze underneath this guard. */
    const state: LockState = { value: { scope: 'off', malformed: false }, message: null };
    cached = { at: now, state };
    return state;
  }
}

export const MIGRATED_SO_READONLY_ERROR = 'so_migrated_readonly';

type SupabaseLike = {
  from(t: string): { select(cols: string): { eq(col: string, v: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> } } };
};

/* The route's own client when there is one, else the service client. This
   middleware is mounted in scm/index.ts, AHEAD of the sales-order router's
   supabaseAuth, so `supabase` is not in the context yet at that point — the same
   position write-freeze.ts is mounted at, and it makes its own client for the
   same reason. The detail/list stampers below run INSIDE the router and do have
   one; sharing this accessor keeps both paths reading one app_config row. */
/* Cast via `unknown` on purpose. Typing the real supabase client structurally
   makes the compiler unroll its generics (TS2589, "excessively deep") — the same
   trap so-is-migrated.ts records at its own boundary. This module needs two
   reads, not a database client. */
const clientFor = (c: Context): SupabaseLike =>
  (c.get('supabase') as unknown as SupabaseLike | undefined)
  ?? (getSupabaseService(c.env) as unknown as SupabaseLike);

const lockReader = (sb: SupabaseLike): ConfigReader =>
  () => sb.from('app_config').select('value, description').eq('key', LOCK_KEY).maybeSingle() as PromiseLike<{ data: ConfigRow; error: unknown }>;

export interface MigratedSoReadonlyState {
  /** May this caller write to this document right now? */
  locked: boolean;
  /** The sentence to show. Null whenever `locked` is false. */
  reason: string | null;
}

/**
 * THE decision, for both the guard and the screen.
 *
 * The middleware below calls this to REFUSE a write; the SO detail GET calls it
 * to tell the two front ends whether to offer editing at all. One function, so
 * the button and the endpoint can never disagree — which is the failure this
 * repo keeps paying for (a rule enforced on one surface and not the other).
 *
 * `isMigrated` is required and `boolean | null`: the caller must say what it
 * found out. The detail handler has the answer for free off the header row it
 * already read; the middleware has to go and get it. `null` ("could not tell")
 * LOCKS — see migrated-so-lock.ts.
 */
export async function migratedSoReadonlyState(
  c: Context,
  isMigrated: boolean | null,
): Promise<MigratedSoReadonlyState> {
  const { value, message } = await readLock(lockReader(clientFor(c)));
  if (value.scope === 'off') return { locked: false, reason: null };
  if (callerBypasses(c)) return { locked: false, reason: null };
  if (!migratedSoIsLocked(value, activeCompanyId(c) ?? null, isMigrated)) return { locked: false, reason: null };
  return { locked: true, reason: migratedSoLockMessage(message) };
}

/**
 * Hono middleware. Mount ONCE on the sales-order router, after supabaseAuth
 * (which is what puts the client in the context) and after the mirrored-SO
 * guard (whose refusal is about a different kind of foreign ownership).
 */
export function migratedSoReadonly() {
  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    const docNo = soDocNoFromPath(c.req.path);
    if (docNo == null) return next(); // create, or a collection-level route

    const sb = clientFor(c);

    /* Cheap exit BEFORE the per-document read: when the switch is off there is
       nothing to look up, and that is the state this whole file is built to be
       retired into. */
    const { value } = await readLock(lockReader(sb));
    if (value.scope === 'off') return next();
    if (callerBypasses(c)) return next();

    /* `null` = we could not tell, and null LOCKS (see migrated-so-lock.ts).
       soIsMigrated THROWS on a failed read rather than answering false, so this
       catch is where "could not tell" is actually produced. */
    let isMigrated: boolean | null;
    try {
      isMigrated = await soIsMigrated(
        (d) => sb.from('mfg_sales_orders').select('linked_ac_docno').eq('doc_no', d).maybeSingle(),
        docNo,
      );
    } catch {
      isMigrated = null;
    }

    const state = await migratedSoReadonlyState(c, isMigrated);
    if (!state.locked) return next();

    const text = state.reason ?? migratedSoLockMessage(null);
    /* Both `reason` and `message` carry the same sentence on purpose: the
       vendored SCM client reads `reason` (vendor/scm/lib/authed-fetch.ts) and
       the core api/client.ts reads `message`/`detail`. Sending one field is how
       a deliberate refusal came to render as a generic outage line once already
       (see write-freeze.ts). 409, not 503: this is a permanent property of THIS
       document, not a service that is briefly away, and api/client.ts retries a
       503 four times. */
    return c.json(
      { error: MIGRATED_SO_READONLY_ERROR, reason: text, message: text, docNo },
      409,
    );
  };
}

/* Re-exported so routes/mfg-sales-orders.ts reaches the whole migrated-document
   policy through ONE import. Not a second home for the fact — so-is-migrated.ts
   is still the only place it is decided, and this file is already its biggest
   consumer. The router is on its size ceiling and a second import line there is
   a line that has to come from somewhere. */
export { soIsMigrated } from './so-is-migrated';

/* ── The two call sites in the sales-order router ───────────────────────────
   Both live HERE, not in routes/mfg-sales-orders.ts, so that file pays ONE line
   per site. It is a 12,000-line router already sitting on its size ceiling, and
   the answer to "where does this logic go" is never "a block in there". */

/** Stamp the DETAIL payload and hand it back, so the call site is the ONE
 *  expression it already had. `acDocNo` is the header's `linked_ac_docno`, which
 *  the detail select already reads — the caller never pays a second query. */
export async function withSoMigratedReadonly(
  c: Context,
  salesOrder: Record<string, unknown>,
  acDocNo: string | null,
): Promise<Record<string, unknown>> {
  const mig = await migratedSoReadonlyState(c, acDocNo !== null);
  salesOrder.migrated_readonly = mig.locked;
  salesOrder.migrated_readonly_reason = mig.reason;
  return salesOrder;
}

/** Build the LIST's per-row answer from the base-table rows the list already
 *  reads (the payment-totals VIEW does not enumerate `linked_ac_docno`, so it
 *  rides that read). ONE app_config lookup for the whole page, then a pure
 *  function per row, returning the object the row spread merges — a NATIVE row
 *  gets `false` rather than nothing, because an absent key reads as "old build"
 *  on the client and would silently unlock the row. */
export async function migratedSoListGate(
  c: Context,
  baseRows: unknown,
): Promise<(docNo: string) => { migrated_readonly: boolean }> {
  const migrated = new Set<string>();
  for (const b of (Array.isArray(baseRows) ? baseRows : []) as Array<Record<string, unknown>>) {
    const docNo = typeof b.doc_no === 'string' ? b.doc_no : null;
    if (docNo && ((b.linkedAcDocno ?? b.linked_ac_docno ?? null) !== null)) migrated.add(docNo);
  }
  const { locked } = await migratedSoReadonlyState(c, true);
  return (docNo: string) => ({ migrated_readonly: locked && migrated.has(docNo) });
}
