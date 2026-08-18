// ----------------------------------------------------------------------------
// paginateAll — page through a PostgREST query so the default 1000-row cap can
// never silently truncate a result set.
//
// PostgREST (Supabase) returns at most `max-rows` (1000) rows per response. A
// `.limit(5000)` does NOT lift that ceiling — it only sets an upper bound; the
// server still hands back ≤1000 and the rest is dropped without an error. The
// only safe way to read the full set is to page with `.range(from, to)` and
// concatenate until a page comes back shorter than the page size.
//
// Usage — pass a factory that returns a fully-built query for a given window.
// Apply all filters/ordering INSIDE the factory so every page is consistent:
//
//   const { data, error } = await paginateAll((from, to) =>
//     sb.from('mfg_products').select('id, code').eq('status', 'ACTIVE')
//       .order('code').range(from, to),
//   );
//
// The factory's query must include `.range(from, to)` (callers wire it through
// so the builder type stays inferred). Returns the same `{ data, error }` shape
// as a single PostgREST call so existing error handling is unchanged.
// ----------------------------------------------------------------------------

const PAGE = 1000;
// Absolute ceiling so a runaway view can't loop forever (50 pages = 50k rows).
const MAX_PAGES = 50;

type PageResult<T> = { data: T[] | null; error: { message: string; code?: string } | null };

export async function paginateAll<T = Record<string, unknown>>(
  makeQuery: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<PageResult<T>> {
  const all: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await makeQuery(from, from + PAGE - 1);
    if (error) return { data: null, error };
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) break; // short page → last page
  }
  return { data: all, error: null };
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
/* ── HOW BIG A BATCH MAY BE — sized in BYTES, not in values ────────────────────
 *
 * The old default was a flat 200, which is a row count, and a row count cannot
 * answer the question that actually decides this. PostgREST carries an `.in()`
 * filter in the REQUEST URI, serialized as `col=in.(v1,v2,…)`; what fails is the
 * LENGTH of that string, so the same 200 is comfortable for item codes and a
 * ~7.8KB request line for uuids.
 *
 * Both halves of the failure were observed in production on 2026-08-17/18:
 *
 *   · GET /api/scm/mrp?category=SOFA, Houzs Century — 500,
 *     `delivered-sum read failed: Bad Request`;
 *   · GET /api/scm/delivery-planning — the SAME throw, in BOTH tenants
 *     including the 100-order one, with an EMPTY driver message
 *     (`delivered-sum read failed: `). An empty message is the tell: the request
 *     was refused before PostgREST could write a JSON error body, i.e. the URI
 *     was rejected at the gateway. Delivery Planning breaks first because its
 *     doc set is "every SO needing delivery", which reaches ~500 line uuids
 *     (~19.5KB) at only ~100 orders.
 *
 * So ~19.5KB is REFUSED, and that is the only hard datum we have; the true
 * ceiling sits somewhere below it and we cannot probe for it from here. The
 * budget below is set against the two limits that bracket the answer instead:
 * nginx's default 8KB header buffer (the tightest thing plausibly in the path)
 * and Cloudflare's 16KB URI limit. 4KB clears the first by 2x and the second by
 * 4x.
 *
 * It is NOT set lower than that, and that is a deliberate trade, not caution
 * running out. A smaller budget means more requests, and more requests is the
 * OTHER hard failure on this platform — Workers cap subrequests per request, a
 * cap this repo has already blown twice from per-line reads (see the
 * "subrequest diet" comments in mfg-pricing-recompute.ts and
 * allowed-options-check.ts). Halving the budget to 2KB would roughly double the
 * ~350 subrequests one MRP load already spends here. 4KB is the point where
 * both failure modes have room.
 */
import { mapBounded } from './concurrency';
export const URL_QUERY_BUDGET = 4000;

/** What PostgREST can carry in an `in.(…)` list. Numbers are here because the
 *  ASSR stops filter on an integer key — the byte arithmetic is identical, and
 *  forcing the caller to stringify would only move the conversion. */
export type InValue = string | number;

/* The budget is for the WHOLE query string, and the id list is not the whole
   query string: the path, the `select=` column list (which on these reads runs
   to an embedded resource and ~200 characters), the company predicate, the
   status filters and the `range` header all ride the same request. Reserving a
   flat allowance for them is the conservative reading — it can only make the
   batch smaller than an id-only calculation would, and the alternative
   (measuring the built URL) is not available from here, because chunkIn is
   handed a factory and never sees the query it produces. 1,000 bytes is several
   times the largest select list in this tree. */
const URL_OVERHEAD_ALLOWANCE = 1000;
/** Serialized cost of one value: itself, plus a percent-encoded `,`. */
const SEPARATOR_BYTES = '%2C'.length;

/**
 * Largest batch of `values` whose serialized `in.(…)` list leaves the rest of
 * the request inside the budget — measured from the WIDEST value present, so a
 * mixed list is sized by its worst case rather than its average.
 *
 * Capped at the historical 200 so this can only ever make an existing call site
 * SMALLER or leave it alone: a 15-character item code would otherwise compute to
 * ~166 anyway, but a shorter one would compute past 200 and silently WIDEN every
 * batch in the repo on the way past.
 */
export function chunkSizeForUrl(values: readonly InValue[]): number {
  let widest = 0;
  for (const v of values) { const n = String(v).length; if (n > widest) widest = n; }
  const perValue = widest + SEPARATOR_BYTES;
  if (perValue <= 0) return 200;
  return Math.max(1, Math.min(200, Math.floor((URL_QUERY_BUDGET - URL_OVERHEAD_ALLOWANCE) / perValue)));
}

/**
 * `chunkSizeForUrl` for a list of uuids, as a constant.
 *
 * For the hand-rolled `for (let i = 0; i < ids.length; i += N)` loops that
 * predate chunkIn and slice before any value list is in scope. Those loops are
 * not the unbounded bug — they DO batch — but they were all written with a
 * literal 300, which is a row count, and 300 uuids is ~11.7KB of filter. That is
 * the same mistake in a smaller size: within sight of the ~19.5KB that was
 * observed refused in production, and with nothing measured in between.
 */
export const UUID_CHUNK = chunkSizeForUrl(['00000000-0000-4000-8000-000000000000']);

/**
 * How many batches may be in flight at once.
 *
 * The batches are independent — each is its own `in.(…)` filter over the same
 * table — so running them one after another spends their latency in series for
 * no reason. Measured on production 2026-08-18 AFTER chunking landed and BEFORE
 * this change: the SO list went 2450ms -> ~5900ms, PO 2767 -> ~5900, GRN 2566
 * -> ~5200. Sizing batches by URL bytes had cut them from 200 to 76 values, so
 * the SAME work became 2.6x as many serial round trips. The chunking was right;
 * doing it in series was the cost.
 *
 * 6, not more: these run inside a Worker against one connection pool, and this
 * repo has twice blown the per-request subrequest cap. Concurrency does not
 * change how many subrequests are issued — only how long the wall clock is —
 * but it does change how many hit the pool at once, and 6 is the figure the MRP
 * engine already settled on in mrp.ts for the same reason.
 */
const CHUNK_CONCURRENCY = 6;

export async function chunkIn<T = Record<string, unknown>, V extends InValue = string>(
  codes: readonly V[],
  makeQuery: (batch: V[], from: number, to: number) => PromiseLike<PageResult<T>>,
  size = chunkSizeForUrl(codes),
): Promise<{ data: T[]; error: { message: string; code?: string } | null }> {
  const batches: V[][] = [];
  for (let i = 0; i < codes.length; i += size) batches.push(codes.slice(i, i + size));
  if (batches.length === 0) return { data: [], error: null };

  /* mapBounded returns results in INPUT order, never completion order, so the
     concatenation below is byte-identical to what the sequential loop produced.
     That is load-bearing: several callers rely on the merged order matching the
     order they passed their ids in. */
  const results = await mapBounded(batches, CHUNK_CONCURRENCY, (batch) =>
    paginateAll<T>((from, to) => makeQuery(batch, from, to)),
  );

  /* Error semantics preserved exactly: the sequential form returned at the
     FIRST failing batch with everything merged so far, so the first failure in
     INPUT order wins and the batches before it are kept. The later batches have
     already run here — that is the only difference, and it costs a discarded
     result, never a wrong one. */
  const merged: T[] = [];
  for (const { data, error } of results) {
    if (error) return { data: merged, error };
    merged.push(...(data ?? []));
  }
  return { data: merged, error: null };
}
