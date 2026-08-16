// ----------------------------------------------------------------------------
// paginateAll — page through a PostgREST query so the server's per-response row
// cap can never silently truncate a result set.
//
// PostgREST (Supabase) returns at most `db-max-rows` rows per response. A
// `.limit(5000)` does NOT lift that ceiling — it only sets an upper bound; the
// server still hands back the smaller of the two and drops the rest without an
// error. The only safe way to read the full set is to page with
// `.range(from, to)` and concatenate.
//
// THE PAGE SIZE IS A REQUEST, NOT A PROMISE. This used to stop as soon as a
// response came back shorter than PAGE, which silently assumes PAGE <= the
// server's cap: configure the cap below PAGE and every paged read in the
// codebase would stop after one response, having "successfully" read a slice —
// the same class of bug this module exists to prevent, wearing its clothes.
// That assumption is unverifiable from here (the cap is PostgREST's own config,
// not a Postgres GUC, and it is not readable over SQL), so it is gone: the walk
// advances by the number of rows it ACTUALLY received and stops only on an EMPTY
// response. Correct for any cap; costs one extra, empty request per read.
//
// Usage — pass a factory that returns a fully-built query for a given window.
// Apply all filters/ordering INSIDE the factory so every page is consistent, and
// give it a TOTAL order or the windows can overlap and drop rows:
//
//   const { data, error } = await paginateAll((from, to) =>
//     sb.from('mfg_products').select('id, code').eq('status', 'ACTIVE')
//       .order('code').range(from, to),
//   );
//
// The factory's query must include `.range(from, to)` (callers wire it through
// so the builder type stays inferred) and must NOT carry its own `.limit()` —
// the server takes the smaller of the two and the walk would never terminate at
// the right place. Returns the `{ data, error }` shape of a single PostgREST
// call, plus `truncated`, so existing error handling is unchanged.
// ----------------------------------------------------------------------------

/** Rows requested per response. An upper bound on the window, nothing more —
 *  the server may answer with fewer and the walk copes either way. */
const PAGE = 1000;

/* The most rows paginateAll will ever return, and THE ONLY NUMBER A CALLER'S OWN
   truncation guard may be compared against: a guard tested against a bound the
   transport cannot reach is not a guard, it is a comment that looks like one.
   routes/mrp.ts held exactly that shape until 2026-08-16 — it asked PostgREST
   for 5000 rows and threw if it got 5000 back, while the edge never returns more
   than its cap per response, so the condition was permanently false and the plan
   ran on one page of a 13,918-row demand set. See BUG-HISTORY 2026-08-16. */
export const PAGINATE_CEILING = 50_000;

type PageResult<T> = { data: T[] | null; error: { message: string; code?: string } | null };
/* `truncated` is TRUE when the walk stopped at PAGINATE_CEILING rather than at
   the end of the data: completeness UNVERIFIED, treat the result as a slice.
   Exactly PAGINATE_CEILING rows reports true as well — the walk stops without
   having seen the empty response that would prove there is nothing more. It errs
   toward the alarm on purpose, because the two mistakes are not symmetric: a
   false alarm costs a 500 on a read already far past its design size, a false
   all-clear is the silent wrong answer this flag exists to stop.

   Additive on purpose: every existing caller destructures {data, error} and is
   unaffected, while a caller that must not act on a slice can now ask. Not made
   an `error`, because the callers that read whole ledgers would then start
   failing on data volume alone. */
type PagedResult<T> = PageResult<T> & { truncated: boolean };

export async function paginateAll<T = Record<string, unknown>>(
  makeQuery: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<PagedResult<T>> {
  const all: T[] = [];
  for (;;) {
    if (all.length >= PAGINATE_CEILING) return { data: all, error: null, truncated: true };
    // from = what we have, NOT page * PAGE: a server that answers with fewer
    // rows than asked must not leave a hole in the next window.
    const { data, error } = await makeQuery(all.length, all.length + PAGE - 1);
    if (error) return { data: null, error, truncated: false };
    const rows = data ?? [];
    if (rows.length === 0) return { data: all, error: null, truncated: false };
    all.push(...rows);
  }
}

// chunkIn — split a code list into ≤size batches so a `.in(col, codes)` filter
// never builds a >1000-element IN list (PostgREST will reject / the URL blows
// the length limit). Run the query per chunk and merge the rows.
//
//   const rows = await chunkIn(codes, (batch) =>
//     sb.from('...').select('...').in('item_code', batch),
//   );
//
// Each chunk is also paginated, so a single chunk that returns >1000 rows
// (e.g. many lines per code) is read in full.
export async function chunkIn<T = Record<string, unknown>>(
  codes: string[],
  makeQuery: (batch: string[], from: number, to: number) => PromiseLike<PageResult<T>>,
  size = 200,
): Promise<{ data: T[]; error: { message: string; code?: string } | null; truncated: boolean }> {
  const merged: T[] = [];
  let truncated = false;
  for (let i = 0; i < codes.length; i += size) {
    const batch = codes.slice(i, i + size);
    const page = await paginateAll<T>((from, to) => makeQuery(batch, from, to));
    if (page.error) return { data: merged, error: page.error, truncated };
    merged.push(...(page.data ?? []));
    truncated ||= page.truncated;
  }
  return { data: merged, error: null, truncated };
}
