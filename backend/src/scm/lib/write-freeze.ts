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
//   app_config.value = '1' (frozen) | anything else / row absent (open)
//   app_config.description = the message shown to staff (optional)
//
// SCOPE — deliberately narrow to what it must stop:
//   • Only non-GET/HEAD/OPTIONS methods on /api/scm/*. Reads stay open so the
//     floor can still look things up, print, and answer customers.
//   • Bypassed for owner/`*` and anyone holding 'scm.admin' — IT must still be
//     able to correct data during the freeze (and the cutover's own repairs run
//     over DATABASE_URL, not this API, so they are unaffected either way).
// ----------------------------------------------------------------------------
import type { Context, Next } from 'hono';
import { getSupabaseService } from '../../db/supabase';

const FREEZE_TTL_MS = 30_000;
const FREEZE_KEY = 'scm.write_freeze';

let cached: { at: number; on: boolean; message: string | null } | null = null;

/** Test seam — drop the cache so a toggle is observed immediately. */
export function resetWriteFreezeCache(): void { cached = null; }

async function readFreeze(sb: unknown): Promise<{ on: boolean; message: string | null }> {
  const now = Date.now();
  if (cached && now - cached.at < FREEZE_TTL_MS) return { on: cached.on, message: cached.message };
  try {
    const { data } = await (sb as {
      from(t: string): {
        select(cols: string): {
          eq(col: string, val: string): { maybeSingle(): Promise<{ data: { value?: string; description?: string } | null }> };
        };
      };
    }).from('app_config').select('value, description').eq('key', FREEZE_KEY).maybeSingle();
    const on = String(data?.value ?? '').trim() === '1';
    const message = data?.description ?? null;
    cached = { at: now, on, message };
    return { on, message };
  } catch {
    /* FAIL OPEN, deliberately. A freeze is an operational convenience; a
       misconfigured/unreachable app_config must not take the whole SCM write
       surface down. The cutover's real protection is that staff were TOLD to
       stop — this makes that stick, it is not a security control. */
    cached = { at: now, on: false, message: null };
    return { on: false, message: null };
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
    const { on, message } = await readFreeze(getSupabaseService(c.env));
    if (!on) return next();

    const hu = c.get('houzsUser') as { permissions?: string[]; is_owner?: boolean } | undefined;
    const perms = hu?.permissions ?? [];
    if (hu?.is_owner || BYPASS_PERMS.some((p) => perms.includes(p))) return next();

    return c.json({
      error: 'write_frozen',
      reason: message
        ?? 'Editing is paused while the AutoCount data migration is completed. Please do not create or change orders — ask IT when you need something updated.',
    }, 503);
  };
}
