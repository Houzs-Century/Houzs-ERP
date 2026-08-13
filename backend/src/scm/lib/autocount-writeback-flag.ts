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
// Identical grammar to the freeze flag; sharing the parser keeps the two
// switches from drifting into two dialects of the same value. What is NOT
// shared is what an unreadable value means — see readWritebackScope: the freeze
// fails closed by freezing everything, this flag fails closed by staying OFF.
import { parseFreezeValue } from './write-freeze';

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
    /* SHARED PARSER, OPPOSITE SAFE DIRECTION — the one thing that must not be
       inherited. For the write FREEZE, a value nobody can parse resolves to
       'all', because freezing too much is loud and one UPDATE undoes it. Here
       'all' would mean START PUSHING every company's documents into a LIVE
       licensed AutoCount book on the strength of a typo. So this flag's own
       fail-closed is OFF, and it refuses three things rather than one:
         • malformed        — we could not read the instruction;
         • an area clause   — this switch has no per-module meaning, so a '-'
                              in its value means somebody pasted the freeze
                              row's value into the adjacent key (same table,
                              same grammar, one line apart in app_config);
         • unknown tokens   — anything left over we did not understand.
       None of them are worth guessing about when the downside is writing into
       a live account book. */
    const scope: Scope =
      parsed.malformed || parsed.open.length > 0 || parsed.unknown.length > 0
        ? 'off'
        : parsed.scope;
    cached = { at: now, scope };
    return scope;
  } catch {
    /* Last known state, else the seeded default (off). Deliberately does NOT
       cache the fallback: a transient PostgREST blip must not pin the feature
       off for the next 30 seconds once the flag is readable again. */
    return cached?.scope ?? 'off';
  }
}

/** Is the write-back on for this company? Never throws. */
export async function isWritebackEnabled(
  sb: SupabaseClient<any, any, any>,
  companyId: number | null | undefined,
): Promise<boolean> {
  const scope = await readWritebackScope(sb);
  if (scope === 'off') return false;
  if (scope === 'all') return true;
  if (companyId == null) return false;
  return scope.includes(Number(companyId));
}
