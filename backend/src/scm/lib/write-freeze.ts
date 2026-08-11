// ----------------------------------------------------------------------------
// write-freeze — a DB-toggled STOP on SCM writes, liftable per company AND
// per module.
//
// Owner 2026-08-10, go-live cutover: "暂时把整个 ERP 的 edit 和 create 功能也
// 关掉 sales 有些 update". While the AutoCount data is being landed and
// reconciled, every staff edit is drift the cutover has to chase — the owner
// already froze AutoCount-side updates; this is the ERP-side half.
//
// Why app_config and not an env var: the owner must be able to lift the freeze
// the moment cutover finishes, WITHOUT a code change + deploy. The row is
// written by the set-write-freeze workflow (see .github/workflows), read here
// with a short in-isolate cache so the freeze costs at most one extra query
// every FREEZE_TTL_MS per isolate.
//
//   app_config.key   = 'scm.write_freeze'
//   app_config.value = 'off' / '' / row absent  → open
//                    = 'all'                    → every company frozen
//                    = company ids ('1', '1,3') → ONLY those frozen
//                    = '<companies> - <area>[, <area>]'
//                                               → those companies frozen EXCEPT
//                                                  the named L2 areas
//   app_config.description = the message shown to staff (optional; must be
//                            under 200 characters or both clients discard it
//                            and fall back to a generic 5xx line — see
//                            freezeMessage at the bottom of this file)
//
// PER-COMPANY IS THE POINT (owner 2026-08-10: "是 Houzs company 而已, 2990
// remain"). Only Houzs is mid-migration; 2990 trades normally through the same
// deployment, so a global freeze would stop a business that has no reason to
// stop. The active company comes from the app-level companyContext middleware
// (mounted on /api/*, i.e. before this one).
//
// PER-MODULE IS THE STAGED LIFT. Go-live does not resume in one step: the owner
// reopens sales orders, watches, then purchase orders, and so on. The `-`
// clause is that sequence expressed in the row he already owns. Areas are the
// SAME L2 keys the route guards use (lib/scm-areas.ts mirrors those mounts, and
// a test pins the mirror). Full grammar + the exact UPDATE for each stage:
// docs/write-freeze-staged-lift.md.
//
// FAIL CLOSED ON A VALUE, FAIL OPEN ON AN OUTAGE — these are different faults
// and they get opposite answers:
//   • A value that is PRESENT but unintelligible ('houzs', '1 -- sales') means
//     somebody typed a freeze instruction we cannot honour. Freezing everything
//     is loud, visible in seconds, and reversed by one UPDATE. Silently opening
//     is invisible, and lets exactly the drift this exists to stop back in. So
//     an unparseable value resolves to 'all', and an unrecognised AREA token is
//     discarded rather than lifted — a typo can never open anything.
//   • An UNREACHABLE app_config is not an instruction at all. That still fails
//     OPEN (see readFreeze) — a Supabase blip must not take the SCM write
//     surface down for both companies.
//   • ABSENT / EMPTY is not a typo either: it is the seeded default (migration
//     0272 seeds 'off'), and every fresh environment has it. Stays open.
//
// SCOPE — deliberately narrow to what it must stop:
//   • Only non-GET/HEAD/OPTIONS methods on /api/scm/*. Reads stay open so the
//     floor can still look things up, print, and answer customers.
//   • Bypassed for owner/`*` and anyone holding 'scm.admin' — IT must still be
//     able to correct data during the freeze (and the cutover's own repairs run
//     over DATABASE_URL, not this API, so they are unaffected either way).
//   • An UNRESOLVED active company is NOT frozen: refusing writes we cannot
//     attribute would take 2990 down on a companies-master blip, which is the
//     exact outage this scoping exists to avoid.
//   • A path behind NO area guard (see SCM_UNGUARDED_PREFIXES) has no area key,
//     so no exception can name it and it stays frozen with its company.
// ----------------------------------------------------------------------------
import type { Context, Next } from 'hono';
import { getSupabaseService } from '../../db/supabase';
import { activeCompanyId } from './companyScope';
import { SCM_AREAS, areaForPath, areaLabel } from './scm-areas';

const FREEZE_TTL_MS = 30_000;
const FREEZE_KEY = 'scm.write_freeze';

/** Which companies a value freezes. Unchanged from the pre-area shape. */
export type FreezeScope = 'off' | 'all' | number[];

/** A parsed app_config value. */
export interface FreezeValue {
  scope: FreezeScope;
  /** L2 areas lifted out of the freeze — the staged-lift exceptions. */
  open: readonly string[];
  /** Tokens after the `-` we could not resolve to an area. NOT lifted. */
  unknown: readonly string[];
  /** The company part was present but unintelligible; scope was forced to 'all'. */
  malformed: boolean;
}

type FreezeState = { value: FreezeValue; message: string | null };
let cached: { at: number; state: FreezeState } | null = null;

/** Test seam — drop the cache so a toggle is observed immediately. */
export function resetWriteFreezeCache(): void { cached = null; }

/** Test seam — prime the cache with a raw value so the middleware can be
 *  exercised without a database. `vi.mock` does not reliably intercept module
 *  imports under the Cloudflare Workers pool (recorded in
 *  tests/pvRateFromPayment.test.ts), so the seam is here rather than a mock. */
export function primeWriteFreezeCache(raw: string | null | undefined, description?: string | null): void {
  cached = { at: Date.now(), state: { value: parseFreezeValue(raw), message: description ?? null } };
}

/* An explicit "we are open" token. Anything else non-empty is an instruction to
   freeze something, and is parsed as such. */
const OPEN_TOKENS = new Set(['', 'off', '0', 'false']);
const ALL_TOKENS = new Set(['all', 'true']);

const dedupe = <T>(xs: T[]): T[] => [...new Set(xs)];
const split = (s: string): string[] => s.split(',').map((t) => t.trim()).filter((t) => t.length > 0);

/**
 * Parse the stored value into companies + area exceptions.
 *
 *   'off' | '' | '0' | 'false'      -> open
 *   'all' | 'true'                  -> every company
 *   '1' | '1,3' | ' 1 , 3 '         -> those companies
 *   '1 - scm.sales.orders'          -> company 1, except sales orders
 *   '1 - sales.orders, procurement.po'  (the `scm.` prefix is optional)
 *   anything else                   -> 'all' (fail closed), lifts discarded
 *
 * Case-insensitive and whitespace-tolerant throughout. Exported for the unit
 * tests, which are the specification for every row above.
 */
export function parseFreezeValue(raw: string | null | undefined): FreezeValue {
  const v = String(raw ?? '').trim().toLowerCase();
  if (OPEN_TOKENS.has(v)) return { scope: 'off', open: [], unknown: [], malformed: false };

  /* Split on the FIRST '-' only. It reads as "minus": freeze company 1 MINUS
     sales orders. No company id and no area key contains one, so there is
     nothing for it to collide with. */
  const dash = v.indexOf('-');
  const head = (dash === -1 ? v : v.slice(0, dash)).trim();
  const tail = dash === -1 ? '' : v.slice(dash + 1).trim();

  let scope: FreezeScope;
  let malformed = false;
  if (ALL_TOKENS.has(head)) {
    scope = 'all';
  } else {
    const tokens = split(head);
    /* STRICT digits. The old parser used Number(), so a stray trailing comma
       ('1,') yielded company 0 and '1.5' yielded a fractional id — neither can
       ever match a real company, but both quietly mean "not what was typed". */
    const ids = tokens.filter((t) => /^\d+$/.test(t)).map(Number);
    if (tokens.length > 0 && ids.length === tokens.length) {
      scope = dedupe(ids);
    } else {
      scope = 'all';
      malformed = true;
    }
  }

  const open: string[] = [];
  const unknown: string[] = [];
  for (const token of split(tail)) {
    // The `scm.` prefix is optional — a mechanical rule, not a synonym list.
    const key = token.startsWith('scm.') ? token : `scm.${token}`;
    if (SCM_AREAS.has(key)) { if (!open.includes(key)) open.push(key); }
    else if (!unknown.includes(token)) unknown.push(token);
  }

  /* A freeze instruction we could not read does not get to carry a lift. */
  if (malformed) return { scope, open: [], unknown: dedupe([...unknown, ...open]), malformed: true };
  return { scope, open, unknown, malformed: false };
}

/**
 * Is a write to `area` by `companyId` refused under this value?
 * PURE — the whole decision, so the tests can pin it without a request.
 * `area` is null for a path behind no area guard: never liftable.
 */
export function isFrozen(v: FreezeValue, companyId: number | undefined, area: string | null): boolean {
  if (v.scope === 'off') return false;
  if (v.scope !== 'all') {
    // Unresolved company → let it through (see the header note).
    if (companyId == null || !v.scope.includes(companyId)) return false;
  }
  /* The exception applies only WITHIN the frozen scope — a company that is not
     in `scope` returned above and never consults `open`, so a lift cannot leak
     into a company the value never froze. */
  if (area != null && v.open.includes(area)) return false;
  return true;
}

/** Read the row. Throws — callers decide what a failure means.
 *
 *  A PostgREST `error` is RAISED rather than folded into a null row, because
 *  "the query failed" and "the row is absent" are different answers and only one
 *  of them means open. The middleware treats both the same (fail open, see
 *  readFreeze), so this changes nothing there — but the status surface must not
 *  tell an operator the freeze is off when what actually happened is that we
 *  could not read it. */
async function fetchFreezeRow(sb: unknown): Promise<{ value?: string; description?: string } | null> {
  const { data, error } = await (sb as {
    from(t: string): {
      select(cols: string): {
        eq(col: string, val: string): {
          maybeSingle(): Promise<{
            data: { value?: string; description?: string } | null;
            error?: { message?: string } | null;
          }>;
        };
      };
    };
  }).from('app_config').select('value, description').eq('key', FREEZE_KEY).maybeSingle();
  if (error) throw new Error(error.message ?? 'app_config read failed');
  return data;
}

/** Uncached read for the status surface — an operator checking the row must not
 *  be shown a value up to FREEZE_TTL_MS stale. */
export async function readFreezeUncached(sb: unknown): Promise<FreezeState> {
  const data = await fetchFreezeRow(sb);
  return { value: parseFreezeValue(data?.value), message: data?.description ?? null };
}

/* Takes a FACTORY, not a client: on a cache hit — the common case, since the
   TTL covers ~30s of traffic — no Supabase client is constructed at all. It used
   to be built eagerly as the argument expression, so every write request paid
   for a client it then threw away. */
async function readFreeze(makeSb: () => unknown): Promise<FreezeState> {
  const now = Date.now();
  if (cached && now - cached.at < FREEZE_TTL_MS) return cached.state;
  try {
    const data = await fetchFreezeRow(makeSb());
    const state: FreezeState = { value: parseFreezeValue(data?.value), message: data?.description ?? null };
    cached = { at: now, state };
    return state;
  } catch {
    /* FAIL OPEN, deliberately — and note this is the OUTAGE case, not the typo
       case (see the header). A freeze is an operational convenience; a
       misconfigured/unreachable app_config must not take the whole SCM write
       surface down. The cutover's real protection is that staff were TOLD to
       stop — this makes that stick, it is not a security control. */
    const state: FreezeState = {
      value: { scope: 'off', open: [], unknown: [], malformed: false },
      message: null,
    };
    cached = { at: now, state };
    return state;
  }
}

export const BYPASS_PERMS = ['*', 'scm.admin'] as const;

type PermCarrier = { permissions?: string[]; permissions_set?: Set<string> } | undefined;
const grants = (u: PermCarrier): boolean =>
  !!u && BYPASS_PERMS.some((p) => u.permissions_set?.has(p) || u.permissions?.includes(p));

/**
 * Does this caller hold a freeze bypass?
 *
 * READS BOTH IDENTITIES ON PURPOSE. This middleware is mounted at
 * `scm.use('/*')`, which runs BEFORE each sub-router's own `supabaseAuth` — so
 * `houzsUser` (set by that middleware) is NOT populated yet, and the intact
 * Houzs AuthUser is still sitting in `user`. AFTER supabaseAuth the reverse is
 * true: `user` has been replaced by the pinned scm.staff system identity, which
 * carries no permissions, and `houzsUser` is the real caller. Checking both
 * makes the bypass correct at either point instead of silently granting nobody
 * if the mount order ever changes again — which is exactly the bug this
 * replaces (see BUG-HISTORY.md, 2026-08-11).
 *
 * The god-tier POSITION path is covered without a special case: hydrateAuthUser
 * (services/auth.ts) PUSHES '*' into permissions/permissions_set for a Super
 * Admin / Owner position, so those accounts arrive holding the wildcard. There
 * is deliberately no `is_owner` flag — no identity in this codebase carries one.
 */
export function callerBypasses(c: Context): boolean {
  return grants(c.get('houzsUser') as PermCarrier)
    || grants(c.get('user') as unknown as PermCarrier);
}

/** Hono middleware — mount once, ahead of the SCM sub-routers. */
export function scmWriteFreeze() {
  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    /* Own client on purpose: `supabase` is set by each sub-router's
       supabaseAuth, so it is NOT in the context this early. Reading one
       app_config row with the service client keeps the freeze ahead of every
       sub-router instead of having to repeat it inside each one. */
    const { value, message } = await readFreeze(() => getSupabaseService(c.env));
    if (value.scope === 'off') return next();

    const area = areaForPath(c.req.path);
    if (!isFrozen(value, activeCompanyId(c), area)) return next();

    if (callerBypasses(c)) return next();

    /* Both fields carry the SAME sentence on purpose. The vendored SCM client
       reads `reason` (vendor/scm/lib/authed-fetch.ts humanApiError) and has
       always shown this correctly; the core api/client.ts reads
       `message`/`detail` and, sending only `reason`, showed the generic 503
       line instead — "The service is briefly unavailable. Please try again in a
       moment.", an outage sentence for a deliberate business pause. That line
       also matches api/client.ts isColdPool503, so that client silently re-sent
       the refused write four more times. Only one /api/scm write goes through
       it today (pages/Team.tsx showroom parking), but it is the default client
       for anything not vendored, so send both fields and let neither drift. */
    /* `area` is additive metadata for a client that wants to react to WHICH
       module is shut, and it is emitted ONLY during a staged lift. Before the
       first lift the refusal body stays byte-for-byte what it has been since
       #1936 — a new key in a 503 payload is exactly the kind of quiet change
       that makes "nothing else moved" impossible to assert. */
    const staged = value.open.length > 0;
    const text = freezeMessage(message, area, staged);
    return c.json(
      staged
        ? { error: 'write_frozen', reason: text, message: text, area: area ?? null }
        : { error: 'write_frozen', reason: text, message: text },
      503,
    );
  };
}

/* Says the three things the floor needs and nothing else: saving is OFF, the
   system is not broken, retrying will not help. Kept under OPERATOR_MESSAGE_MAX
   so it survives both clients' length guard. */
const DEFAULT_FROZEN_MESSAGE =
  'Saving is paused while the AutoCount data is brought across. '
  + 'Nothing is broken and retrying will not help. '
  + 'Editing reopens after the cutover — ask IT if something must change today.';

/* BOTH clients discard a server sentence of 200 characters or more and fall
   back to their generic 5xx line, which reads as an outage — so an
   operator-typed app_config.description that runs long would silently undo this
   fix. The cap belongs here, the one place that holds both the operator's text
   and the default. */
const OPERATOR_MESSAGE_MAX = 200;

/**
 * The sentence a refused write returns.
 *
 * NAMES THE AREA ONLY DURING A STAGED LIFT. Once some modules have reopened,
 * "saving is paused" is no longer true of the system and no longer actionable —
 * the staff member needs to know that THIS module is the one still closed while
 * their colleague's saves go through. Before any lift (the plain '1' the row
 * holds today) the message is byte-for-byte what it has always been: naming an
 * area would be noise when every area is shut.
 *
 * An operator-typed app_config.description still wins over both, unchanged.
 */
export function freezeMessage(
  description: string | null | undefined,
  area?: string | null,
  staged?: boolean,
): string {
  const v = String(description ?? '').trim();
  if (v.length > 0 && v.length < OPERATOR_MESSAGE_MAX) return v;
  if (staged && area) {
    const sentence =
      `Saving ${areaLabel(area)} is still paused while the AutoCount data is brought across. `
      + 'Other areas have reopened. Retrying will not help — ask IT if this must change today.';
    // Guard, not a hope: a label long enough to breach the cap falls back.
    if (sentence.length < OPERATOR_MESSAGE_MAX) return sentence;
  }
  return DEFAULT_FROZEN_MESSAGE;
}
