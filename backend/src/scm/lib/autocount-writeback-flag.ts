// ----------------------------------------------------------------------------
// autocount-writeback-flag — the runtime ON/OFF for ERP -> AutoCount write-back.
//
// Owner 2026-08-10: the ERP becomes master at go-live and pushes every document
// into AutoCount. That push writes into a LIVE licensed account book, so it must
// be stoppable in seconds by someone who cannot deploy — hence app_config and
// not an env var, exactly as the go-live write freeze does (0272 +
// scm/lib/write-freeze.ts). Same table, same grammar, same 30s cache:
//
//   app_config.key   = 'scm.autocount_writeback'
//   app_config.value = 'off' / '' / row absent  -> nothing is queued or sent
//                    = 'all'                    -> every company
//                    = comma-separated ids ('1')-> ONLY those companies
//
// SHIPS OFF (0277 seeds 'off'). Turning it on is an explicit act.
//
// FAILING OPEN, as write-freeze does, but read carefully — "open" means the
// caller is never harmed, NOT that an unreadable flag turns the feature on:
//
//   • a read error re-serves the LAST KNOWN state, and the seeded default is
//     off, so an unreachable app_config can never start pushing into AutoCount;
//   • isWritebackEnabled NEVER throws, so an enqueue can never fail a user's
//     save. That is the property write-freeze's fail-open exists to protect and
//     the one that matters here.
//
// Checked TWICE by design: at enqueue (nothing accumulates while off) and again
// at drain (a flag flipped off after rows were queued stops the push, and the
// rows stay pending rather than being marked failed — off is not a failure).
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseFreezeValue } from './write-freeze';
import { isRepairClient } from './ac-repair-suppression';

export const WRITEBACK_KEY = 'scm.autocount_writeback';

const TTL_MS = 30_000;

type Scope = 'off' | 'all' | number[];

let cached: { at: number; scope: Scope } | null = null;

/** Test seam — drop the cache so a toggle is observed immediately. */
export function resetWritebackFlagCache(): void {
  cached = null;
}

/** Read the scope, with the short cache. Never throws. */
export async function readWritebackScope(
  sb: SupabaseClient<any, any, any>,
): Promise<Scope> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.scope;
  try {
    const { data, error } = await sb
      .from('app_config')
      .select('value')
      .eq('key', WRITEBACK_KEY)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const parsed = parseFreezeValue((data as { value?: string } | null)?.value);
    const scope: Scope =
      parsed.malformed || parsed.open.length > 0 || parsed.unknown.length > 0
        ? 'off'
        : parsed.scope;
    cached = { at: now, scope };
    return scope;
  } catch {
    return cached?.scope ?? 'off';
  }
}

/**
 * May this client write back for this company? NEVER throws.
 *
 * TWO questions, and the second one was added 2026-09-09. The flag asks whether
 * the write-back is ON for the company. `isRepairClient` asks whether a CUTOVER
 * REPAIR is making the change — and a repair's change must never travel,
 * because a repair copies a value out of the account book and sending it back
 * overwrites the owner's source of truth with our version of it.
 *
 * They live in one function on purpose. Every enqueue path in autocount-outbox.ts
 * already gates on this call — including enqueueCancel and enqueueEdit, whose
 * own UPDATE paths never reach enqueueAcOp's insert — so asking here reaches all
 * of them and cannot be forgotten at a new call site the way a second, parallel
 * check could be.
 */
export async function isWritebackEnabled(
  sb: SupabaseClient<any, any, any>,
  companyId: number | null | undefined,
): Promise<boolean> {
  if (isRepairClient(sb)) return false;
  const scope = await readWritebackScope(sb);
  if (scope === 'off') return false;
  if (scope === 'all') return true;
  if (companyId == null) return false;
  return scope.includes(Number(companyId));
}
