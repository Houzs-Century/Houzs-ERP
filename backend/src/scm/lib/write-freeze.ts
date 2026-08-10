// ----------------------------------------------------------------------------
// write-freeze — a global, DB-toggled STOP on SCM writes.
//
// Owner 2026-08-10, go-live cutover: "暂时把整个 ERP 的 edit 和 create 功能也
// 关掉 sales 有些 update". While the AutoCount data is being landed and
// reconciled, every staff edit is drift the cutover has to chase — the owner
// already froze AutoCount-side updates; this is the ERP-side half.
//
// Why app_config and not an env var: the owner must be able to lift the freeze
// the moment cutover finishes, WITHOUT a code change + deploy. The row is
// written by the scm-write-freeze workflow (see .github/workflows), read here
// with a short in-isolate cache so the freeze costs at most one extra query
// every FREEZE_TTL_MS per isolate.
//
//   app_config.key   = 'scm.write_freeze'
//   app_config.value = 'off' / '' / row absent  → open
//                    = 'all'                    → every company frozen
//                    = comma-separated company ids ('1') → ONLY those frozen
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
// SCOPE — deliberately narrow to what it must stop:
//   • Only non-GET/HEAD/OPTIONS methods on /api/scm/*. Reads stay open so the
//     floor can still look things up, print, and answer customers.
//   • Bypassed for owner/`*` and anyone holding 'scm.admin' — IT must still be
//     able to correct data during the freeze (and the cutover's own repairs run
//     over DATABASE_URL, not this API, so they are unaffected either way).
//   • An UNRESOLVED active company is NOT frozen: refusing writes we cannot
//     attribute would take 2990 down on a companies-master blip, which is the
//     exact outage this scoping exists to avoid.
// ----------------------------------------------------------------------------
import type { Context, Next } from 'hono';
import { getSupabaseService } from '../../db/supabase';
import { activeCompanyId } from './companyScope';

const FREEZE_TTL_MS = 30_000;
const FREEZE_KEY = 'scm.write_freeze';

type FreezeState = { scope: 'off' | 'all' | number[]; message: string | null };
let cached: { at: number; state: FreezeState } | null = null;

/** Test seam — drop the cache so a toggle is observed immediately. */
export function resetWriteFreezeCache(): void { cached = null; }

/** Parse the stored value into a scope. Exported for the unit test. */
export function parseFreezeValue(raw: string | null | undefined): 'off' | 'all' | number[] {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v || v === 'off' || v === '0' || v === 'false') return 'off';
  if (v === 'all' || v === 'true') return 'all';
  const ids = v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  return ids.length ? ids : 'off';
}

async function readFreeze(sb: unknown): Promise<FreezeState> {
  const now = Date.now();
  if (cached && now - cached.at < FREEZE_TTL_MS) return cached.state;
  try {
    const { data } = await (sb as {
      from(t: string): {
        select(cols: string): {
          eq(col: string, val: string): { maybeSingle(): Promise<{ data: { value?: string; description?: string } | null }> };
        };
      };
    }).from('app_config').select('value, description').eq('key', FREEZE_KEY).maybeSingle();
    const state: FreezeState = { scope: parseFreezeValue(data?.value), message: data?.description ?? null };
    cached = { at: now, state };
    return state;
  } catch {
    /* FAIL OPEN, deliberately. A freeze is an operational convenience; a
       misconfigured/unreachable app_config must not take the whole SCM write
       surface down. The cutover's real protection is that staff were TOLD to
       stop — this makes that stick, it is not a security control. */
    const state: FreezeState = { scope: 'off', message: null };
    cached = { at: now, state };
    return state;
  }
}

const BYPASS_PERMS = ['*', 'scm.admin'];

/** Hono middleware — mount once, ahead of the SCM sub-routers. */
export function scmWriteFreeze() {
  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    /* Own client on purpose: `supabase` is set by each sub-router's
       supabaseAuth, so it is NOT in the context this early. Reading one
       app_config row with the service client keeps the freeze ahead of every
       sub-router instead of having to repeat it inside each one. */
    const { scope, message } = await readFreeze(getSupabaseService(c.env));
    if (scope === 'off') return next();
    if (scope !== 'all') {
      const co = activeCompanyId(c);
      // Unresolved company → let it through (see the header note).
      if (co == null || !scope.includes(co)) return next();
    }

    const hu = c.get('houzsUser') as { permissions?: string[]; is_owner?: boolean } | undefined;
    const perms = hu?.permissions ?? [];
    if (hu?.is_owner || BYPASS_PERMS.some((p) => perms.includes(p))) return next();

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
    const text = freezeMessage(message);
    return c.json({ error: 'write_frozen', reason: text, message: text }, 503);
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

/** Exported for the unit test. */
export function freezeMessage(description: string | null | undefined): string {
  const v = String(description ?? '').trim();
  return v.length > 0 && v.length < OPERATOR_MESSAGE_MAX ? v : DEFAULT_FROZEN_MESSAGE;
}
