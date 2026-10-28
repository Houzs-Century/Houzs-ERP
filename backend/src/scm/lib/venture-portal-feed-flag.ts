// ----------------------------------------------------------------------------
// venture-portal-feed-flag — the runtime ON/OFF for the ERP -> Venture Portal
// live sales-order feed.
//
// The feed pushes real sales orders, their line costs and their cancellations
// into a system outside this one, where they become the input to somebody's
// commission. That must be stoppable in seconds by a person who cannot deploy,
// so it is an app_config row and not an env var — the same decision, the same
// table and the same grammar as the AutoCount write-back (0277 +
// autocount-writeback-flag.ts) and the go-live write freeze (0272):
//
//   app_config.key   = 'scm.venture_portal_feed'
//   app_config.value = 'off' / '' / row absent  -> nothing is queued or sent
//                    = 'all'                    -> every company
//                    = comma-separated ids ('1')-> ONLY those companies
//
// SHIPS OFF (the 20260912T1800 migration seeds 'off'). Turning it on is an
// explicit act, done from the Venture Portal Feed admin page.
//
// FAILING CLOSED, and "closed" here means OFF. A read error re-serves the last
// known state and the seeded default is off, so an unreachable app_config can
// never start sending sales orders outward. readFeedScope NEVER throws, because
// the enqueue path it guards runs inside a salesperson's Save.
//
// Checked TWICE by design, exactly as the write-back is: the trigger is
// unconditional (it is same-transaction capture and must not depend on a
// readable flag), so the DRAIN is where the flag stops delivery, and the rows
// stay pending rather than being marked failed — off is not a failure. The
// SCOPE check at drain is what keeps a company nobody enabled out of the feed.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
// Identical grammar to the freeze and write-back flags. Sharing the parser is
// what keeps three switches over one table from becoming three dialects of the
// same value; what is NOT shared is which direction an unreadable value falls.
import { parseFreezeValue } from './write-freeze';

/* The SCM PostgREST client is untyped at every call site in this tree; a typed
   signature here would describe a contract nothing else keeps. Named once so
   the three `any`s live in one place rather than on every function. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type ScmClient = SupabaseClient<any, any, any>;

export const VENTURE_PORTAL_FEED_KEY = 'scm.venture_portal_feed';

const TTL_MS = 30_000;

export type FeedScope = 'off' | 'all' | number[];

let cached: { at: number; scope: FeedScope } | null = null;

/** Test seam — drop the cache so a toggle is observed immediately. */
export function resetFeedFlagCache(): void {
  cached = null;
}

/** Read the scope, with the short cache. Never throws. */
export async function readFeedScope(
  sb: ScmClient,
): Promise<FeedScope> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.scope;
  try {
    const { data, error } = await sb
      .from('app_config')
      .select('value')
      .eq('key', VENTURE_PORTAL_FEED_KEY)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const parsed = parseFreezeValue((data as { value?: string } | null)?.value);
    /* SHARED PARSER, OPPOSITE SAFE DIRECTION — the one thing that must not be
       inherited. For the write FREEZE a value nobody can parse resolves to
       'all', because freezing too much is loud and one UPDATE undoes it. Here
       'all' would mean START SENDING every company's sales orders to an
       external portal on the strength of a typo, and a delivery cannot be
       recalled. So this flag refuses three things rather than one:
         • malformed      — we could not read the instruction;
         • an area clause — this switch has no per-module meaning, so a '-' in
                            its value means somebody pasted the freeze row's
                            value into a neighbouring key (same table, same
                            grammar, a few rows apart in app_config);
         • unknown tokens — anything left over we did not understand. */
    const scope: FeedScope =
      parsed.malformed || parsed.open.length > 0 || parsed.unknown.length > 0
        ? 'off'
        : parsed.scope;
    cached = { at: now, scope };
    return scope;
  } catch {
    /* Last known state, else the seeded default (off). Deliberately does NOT
       cache the fallback: a transient PostgREST blip must not pin the feed off
       for the next 30 seconds once the flag is readable again. */
    return cached?.scope ?? 'off';
  }
}

/**
 * Is the feed on for this company? NEVER throws.
 *
 * `companyId` is `number | null` and not optional on purpose. It DECIDES
 * whether a document is delivered, and CLAUDE.md's rule for a deciding
 * parameter is that its absence must be a compile error at every call site
 * rather than a silent inheritance of the old behaviour. A null company is not
 * in any scope list, so it answers false unless the feed is 'all'.
 */
export async function isFeedEnabled(
  sb: ScmClient,
  companyId: number | null,
): Promise<boolean> {
  const scope = await readFeedScope(sb);
  if (scope === 'off') return false;
  if (scope === 'all') return true;
  if (companyId == null) return false;
  return scope.includes(Number(companyId));
}
