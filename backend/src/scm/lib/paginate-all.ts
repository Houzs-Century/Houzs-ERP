import { mapBounded } from './concurrency';


export const PAGE = 1000;
const MAX_PAGES = 50;

export type PageResult<T> = { data: T[] | null; error: { message: string; code?: string } | null };

export type PagedResult<T> = PageResult<T> & { truncated: boolean };

export async function paginateAll<T = Record<string, unknown>>(
  makeQuery: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<PagedResult<T>> {
  const all: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await makeQuery(from, from + PAGE - 1);
    if (error) return { data: null, error, truncated: false };
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) return { data: all, error: null, truncated: false };
  }
  // eslint-disable-next-line no-console
  console.warn(`[paginateAll] stopped at ${MAX_PAGES} pages (${all.length} rows); result truncated`);
  return { data: all, error: null, truncated: true };
}

export const URL_QUERY_BUDGET = 4000;

/** What PostgREST can carry in an `in.(…)` list. Numbers are here because the
 *  ASSR stops filter on an integer key — the byte arithmetic is identical, and
 *  forcing the caller to stringify would only move the conversion. */
export type InValue = string | number;

const URL_OVERHEAD_ALLOWANCE = 1000;
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

const CHUNK_CONCURRENCY = 6;

/**
 * A PostgREST `in.(...)` list with every value quoted and escaped, for
 * `.filter(col, 'in', inList(values))`.
 *
 * postgrest-js `.in()` wraps a value holding `,()` in double quotes but does not
 * escape a double quote inside it, so a product code like `GENERASI 5" MATT (S)`
 * ends the quoted value early and the rest of that batch matches nothing, with
 * no error (2026-10-19: 233 open order lines silently missing from the
 * Procurement dead-stock demand).
 */
export function inList(values: readonly InValue[]): string {
  return `(${values.map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`;
}

export async function chunkIn<T = Record<string, unknown>, V extends InValue = string>(
  codes: readonly V[],
  makeQuery: (batch: V[], from: number, to: number) => PromiseLike<PageResult<T>>,
  size = chunkSizeForUrl(codes),
): Promise<{ data: T[]; error: { message: string; code?: string } | null; truncated: boolean }> {
  const batches: V[][] = [];
  for (let i = 0; i < codes.length; i += size) batches.push(codes.slice(i, i + size));
  if (batches.length === 0) return { data: [], error: null, truncated: false };

  const results = await mapBounded(batches, CHUNK_CONCURRENCY, (batch) =>
    paginateAll<T>((from, to) => makeQuery(batch, from, to)),
  );

  const merged: T[] = [];
  let truncated = false;
  for (const r of results) {
    if (r.error) return { data: merged, error: r.error, truncated };
    merged.push(...(r.data ?? []));
    truncated ||= r.truncated;
  }
  return { data: merged, error: null, truncated };
}
