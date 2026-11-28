import type { SupabaseClient } from '@supabase/supabase-js';
import { parseFreezeValue } from './write-freeze';

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
    const scope: FeedScope =
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
