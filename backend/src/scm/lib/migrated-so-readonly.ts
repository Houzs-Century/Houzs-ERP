// ----------------------------------------------------------------------------
// migrated-so-readonly — the ROUTER-level guard that applies migrated-so-lock.
//
// Owner 2026-09-08: 「只开新单，旧单暂时不能改」. The decision lives in
// lib/migrated-so-lock.ts (pure, unit-tested); this is the one place that feeds
// it a request and turns a `true` into something a salesperson can act on.
//
// TWO MOUNTS, ONE RULE. `migratedSoReadonly()` guards `/mfg-sales-orders/*` and
// `migratedSoAmendmentReadonly()` guards `/so-amendments/*`. The second exists
// because approve-so on an amendment is not a status flip: it runs
// applySoAmendment, which rewrites the bound Sales Order's header and lines. The
// first version of this file shipped with that door open and said so
// (docs/migrated-so-lock.md §7) — see the factory below.
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
import { soIsMigrated, soIsMigratedShape } from './so-is-migrated';
import { callerBypasses } from './write-freeze';
import { activeCompanyId } from './companyScope';
import { chunkSizeForUrl } from './paginate-all';
import {
  migratedSoIsLocked,
  migratedSoLockMessage,
  migratedSoVerdictMessage,
  parseMigratedSoLock,
  type MigratedSoLockValue,
} from './migrated-so-lock';
import {
  readSoVerdict,
  soVerdictFromRow,
  type SoReconcileVerdict,
} from './so-reconcile-verdict';

const LOCK_TTL_MS = 30_000;
const LOCK_KEY = 'scm.migrated_so_lock';
const MOUNT_SEGMENT = 'mfg-sales-orders';
const AMENDMENT_MOUNT_SEGMENT = 'so-amendments';

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

const AMENDMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The amendment id a request targets, or null when it targets none.
 *
 * Exported for the tests, which are the specification: the collection route and
 * a trailing slash must answer null, a nested write must answer the SAME id as
 * a top-level one, and a segment that is not a uuid names no amendment.
 */
export function amendmentIdFromPath(path: string): string | null {
  const segs = path.split('?')[0].split('/').filter((s) => s.length > 0);
  const i = segs.lastIndexOf(AMENDMENT_MOUNT_SEGMENT);
  if (i === -1 || i + 1 >= segs.length) return null;
  const raw = segs[i + 1];
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  return AMENDMENT_ID_RE.test(decoded) ? decoded : null;
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
    const state: LockState = { value: { scope: 'off', malformed: false, byVerdict: false }, message: null };
    cached = { at: now, state };
    return state;
  }
}

export const MIGRATED_SO_READONLY_ERROR = 'so_migrated_readonly';

type SupabaseLike = {
  from(t: string): {
    select(cols: string): {
      eq(col: string, v: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
      in(col: string, v: readonly string[]): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
};

const clientFor = (c: Context): SupabaseLike =>
  (c.get('supabase') as unknown as SupabaseLike | undefined)
  ?? (getSupabaseService(c.env) as unknown as SupabaseLike);

const lockReader = (sb: SupabaseLike): ConfigReader =>
  () => sb.from('app_config').select('value, description').eq('key', LOCK_KEY).maybeSingle() as PromiseLike<{ data: ConfigRow; error: unknown }>;

export interface MigratedSoReadonlyState {
  locked: boolean;
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
  docNo: string | null,
  isMigrated: boolean | null,
  suppliedVerdict?: SoReconcileVerdict | null,
): Promise<MigratedSoReadonlyState> {
  const { value, message } = await readLock(lockReader(clientFor(c)));
  if (value.scope === 'off') return { locked: false, reason: null };
  if (callerBypasses(c)) return { locked: false, reason: null };

  if (!value.byVerdict) {
    if (!migratedSoIsLocked(value, activeCompanyId(c) ?? null, isMigrated, null)) {
      return { locked: false, reason: null };
    }
    return { locked: true, reason: migratedSoLockMessage(message) };
  }

  const companyId = activeCompanyId(c) ?? null;
  const outOfScope = value.scope !== 'all'
    && (companyId == null || !value.scope.includes(companyId));
  if (outOfScope || isMigrated === false) return { locked: false, reason: null };

  const verdict = suppliedVerdict !== undefined
    ? suppliedVerdict
    : (docNo != null ? await fetchVerdict(clientFor(c), docNo) : null);

  if (!migratedSoIsLocked(value, companyId, isMigrated, verdict)) {
    return { locked: false, reason: null };
  }
  return { locked: true, reason: migratedSoVerdictMessage(docNo, verdict) };
}

const VERDICT_TABLE = 'so_reconcile_verdict';
const VERDICT_COLS = 'doc_no, clean, axes, measured_at';

async function fetchVerdict(sb: SupabaseLike, docNo: string): Promise<SoReconcileVerdict> {
  return readSoVerdict(
    (d) => sb.from(VERDICT_TABLE).select(VERDICT_COLS).eq('doc_no', d).maybeSingle(),
    docNo,
  );
}

async function fetchVerdicts(
  sb: SupabaseLike,
  docNos: readonly string[],
  now: number = Date.now(),
): Promise<Map<string, SoReconcileVerdict>> {
  const out = new Map<string, SoReconcileVerdict>();
  if (docNos.length === 0) return out;
  try {
    const size = chunkSizeForUrl(docNos);
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < docNos.length; i += size) {
      const { data, error } = await sb.from(VERDICT_TABLE).select(VERDICT_COLS).in('doc_no', docNos.slice(i, i + size));
      if (error || !Array.isArray(data)) return out;
      rows.push(...(data as Array<Record<string, unknown>>));
    }
    for (const raw of rows) {
      const docNo = raw.doc_no ?? raw.docNo;
      const measuredAt = raw.measured_at ?? raw.measuredAt;
      if (typeof docNo !== 'string' || typeof measuredAt !== 'string') continue;
      out.set(docNo, soVerdictFromRow(
        {
          clean: raw.clean === true,
          axes: Array.isArray(raw.axes) ? (raw.axes as string[]) : null,
          measured_at: measuredAt,
        },
        now,
      ));
    }
  } catch { }
  return out;
}


type GuardTarget = { docNo: string | null; isMigrated: boolean | null };

function migratedGuard(
  keyFromPath: (path: string) => string | null,
  resolve: (sb: SupabaseLike, key: string) => Promise<GuardTarget | null>,
) {
  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    const key = keyFromPath(c.req.path);
    if (key == null) return next();

    const sb = clientFor(c);

    const { value } = await readLock(lockReader(sb));
    if (value.scope === 'off') return next();
    if (callerBypasses(c)) return next();

    const target = await resolve(sb, key);
    if (target == null) return next();

    const state = await migratedSoReadonlyState(c, target.docNo, target.isMigrated);
    if (!state.locked) return next();

    const text = state.reason ?? migratedSoLockMessage(null);
    return c.json(
      { error: MIGRATED_SO_READONLY_ERROR, reason: text, message: text, docNo: target.docNo },
      409,
    );
  };
}

async function migratedByDocNo(sb: SupabaseLike, docNo: string): Promise<GuardTarget> {
  try {
    return {
      docNo,
      /* BOTH numbers, because the rule is about the pair (so-is-migrated.ts).
         Selecting only `linked_ac_docno` is what made a brand-new order read as
         an import the minute the write-back stamped it — docs/bugs/0703. */
      isMigrated: await soIsMigrated(
        (d) => sb.from('mfg_sales_orders').select('doc_no, linked_ac_docno').eq('doc_no', d).maybeSingle(),
        docNo,
      ),
    };
  } catch {
    return { docNo, isMigrated: null };
  }
}

/**
 * The Sales Order an amendment is bound to.
 *
 * THREE ANSWERS, NOT TWO, and the third is the point. A row that is simply not
 * there is `null` — the handler will 404 and no write happens, so the guard has
 * nothing to refuse. A row that IS there but whose `so_doc_no` we could not read
 * THROWS, because that is "could not tell", and the permissive answer must not
 * be reachable by a read that did not work. Folding the two together is how a
 * gate ships looking applied.
 *
 * Both spellings are accepted for the same reason: this repo has already been
 * caught by a PostgREST read coming back camelCase where the code expected
 * snake_case, and here that mistake would read as "no amendment" — open, not
 * shut. Exported for the tests.
 */
export type AmendmentSoReader = (id: string) => PromiseLike<{ data: unknown; error: unknown }>;

export async function amendmentSoDocNo(read: AmendmentSoReader, id: string): Promise<string | null> {
  const { data, error } = await read(id);
  if (error) throw new Error(`amendmentSoDocNo: ${(error as { message?: string }).message ?? 'read failed'}`);
  if (data == null) return null;
  const row = data as { so_doc_no?: unknown; soDocNo?: unknown };
  const v = row.so_doc_no ?? row.soDocNo;
  if (typeof v === 'string' && v.length > 0) return v;
  throw new Error('amendmentSoDocNo: the amendment row carries no readable so_doc_no');
}

async function migratedByAmendmentId(sb: SupabaseLike, id: string): Promise<GuardTarget | null> {
  let docNo: string | null = null;
  try {
    docNo = await amendmentSoDocNo(
      (i) => sb.from('so_amendments').select('so_doc_no').eq('id', i).maybeSingle(),
      id,
    );
  } catch {
    return { docNo: null, isMigrated: null };
  }
  if (docNo == null) return null;
  return migratedByDocNo(sb, docNo);
}

/**
 * Hono middleware for the SALES ORDER router. Mount ONCE, after supabaseAuth
 * (which is what puts the client in the context) and after the mirrored-SO
 * guard (whose refusal is about a different kind of foreign ownership).
 *
 * WHAT IS DELIBERATELY NOT GUARDED is listed at the top of this file.
 */
export function migratedSoReadonly() {
  return migratedGuard(soDocNoFromPath, migratedByDocNo);
}

/**
 * Hono middleware for the AMENDMENT router — the same rule, reached by a
 * different door.
 *
 * `/so-amendments/:id/{supplier-confirm,approve-so,approve-po,send,reject,
 * withdraw}` are the six writes it covers; every one of them acts on an
 * amendment that already exists, which is why the prefix guard on the SO router
 * never sees them. Mounted at the PREFIX for the same reason that one is: a
 * per-handler check leaves the NEXT gate added to the file unguarded by default,
 * and that is the shape this repo has already paid for three times.
 */
export function migratedSoAmendmentReadonly() {
  return migratedGuard(amendmentIdFromPath, migratedByAmendmentId);
}

export { soIsMigrated } from './so-is-migrated';


/** Stamp the DETAIL payload and hand it back, so the call site is the ONE
 *  expression it already had. `acDocNo` is the header's `linked_ac_docno`, which
 *  the detail select already reads — the caller never pays a second query. */
export async function withSoMigratedReadonly(
  c: Context,
  salesOrder: Record<string, unknown>,
  acDocNo: string | null,
): Promise<Record<string, unknown>> {
  const docNo = typeof salesOrder.doc_no === 'string' ? salesOrder.doc_no : null;
  const mig = await migratedSoReadonlyState(c, docNo, soIsMigratedShape(docNo, acDocNo));
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
    const link = b.linkedAcDocno ?? b.linked_ac_docno ?? null;
    /* Same predicate as the guard and the detail, so a row cannot offer Edit on
       a page the endpoint then refuses — or grey one the endpoint would allow,
       which is what docs/bugs/0703 did to every order the write-back had sent. */
    if (docNo && soIsMigratedShape(docNo, typeof link === 'string' ? link : null)) migrated.add(docNo);
  }

  const { value } = await readLock(lockReader(clientFor(c)));

  if (!value.byVerdict) {
    const { locked } = await migratedSoReadonlyState(c, null, true, null);
    return (docNo: string) => ({ migrated_readonly: locked && migrated.has(docNo) });
  }

  const verdicts = await fetchVerdicts(clientFor(c), [...migrated]);
  const states = new Map<string, boolean>();
  for (const docNo of migrated) {
    const { locked } = await migratedSoReadonlyState(
      c, docNo, true, verdicts.get(docNo) ?? null,
    );
    states.set(docNo, locked);
  }
  return (docNo: string) => ({ migrated_readonly: states.get(docNo) === true });
}
