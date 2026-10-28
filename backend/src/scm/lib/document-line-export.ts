// ----------------------------------------------------------------------------
// document-line-export — read EVERY document a list matches, and every line of
// each, for a one-row-per-line export.
//
// Owner 2026-09-15: the Purchase Order export must work like AutoCount's "PO
// chasing list" — one row per LINE, across every page the list's filters match,
// never the screen page. He named PO, SO and DO; GR, PI and SI have the same
// shape (a header table + a line table keyed by the header id). This module is
// the part they share. A document plugs in with three queries it already knows
// how to write; nothing here names a table.
//
// THE READ, and why it is two reads rather than one embedded query:
//   1. HEADERS through the list's own filter + sort, paged to exhaustion. Paged
//      because PostgREST answers a big read with a silent ceiling
//      (lib/paginate-all.ts), and read through the list's function because a
//      second copy of "what does this tab match" is how an export and its list
//      come to disagree.
//   2. LINES by header id, in URL-sized batches (chunkIn). A single embedded
//      read would need the tab / search / hold filters written against an
//      embedded resource, a form this repo has not proven against production
//      (see the PO_DEAD_FOR_RECEIPT note in lib/outstanding-po-lines.ts).
//
// It REPORTS a stopped read. The header read stops at a ceiling rather than
// looping forever; when it does, `truncated` is true and the caller must say so
// rather than hand over a short file that looks complete.
// ----------------------------------------------------------------------------

import { chunkIn } from './paginate-all';
import { pageWithTruncation, type RawPage } from './outstanding-po-lines';

type QueryError = { message: string; code?: string } | null;

/* A list export can be served in WINDOWS of documents, one request each, with
   the browser asking for the next window until there is none. Every PostgREST
   read is a Worker subrequest, and one invocation has a cap. Measured 2026-09-15
   on production data: the Sales Order list builder and line attach cost about
   64 requests per 100 orders, so ONE request for the Houzs "All" tab (2,959
   orders) made 1,923 — over the cap. A window of 500 orders made at most 332. */
export const EXPORT_WINDOW = 500;
export type ExportWindow = { offset: number; limit: number };

/** `?offset=&limit=` of an export request: whole numbers only, the limit clamped
 *  to 1..EXPORT_WINDOW, anything else read as the default. */
export function readExportWindow(query: (key: string) => string | undefined): ExportWindow {
  const int = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  const limit = int(query('limit'));
  return { offset: int(query('offset')) ?? 0, limit: Math.min(Math.max(limit ?? EXPORT_WINDOW, 1), EXPORT_WINDOW) };
}

type LinePage<L> = PromiseLike<{ data: L[] | null; error: QueryError }>;

export type DocumentLineExportRead<H extends { id: string }, L> = {
  /** One page of the filtered, sorted, COMPANY-SCOPED header read. */
  headers: (from: number, to: number) => RawPage;
  /** One page of the COMPANY-SCOPED lines for a batch of header ids. Must be
   *  ordered deterministically, or paging can skip and repeat rows. */
  lines: (headerIds: string[], from: number, to: number) => LinePage<L>;
  /** The header id a line belongs to. */
  parentOf: (line: L) => string | null | undefined;
};

export type DocumentLineExportResult<H, L> =
  | { error: string }
  | { error: null; headers: H[]; linesByHeader: Map<string, L[]>; lineCount: number; truncated: boolean };

export async function readDocumentsWithLines<H extends { id: string }, L>(
  read: DocumentLineExportRead<H, L>,
): Promise<DocumentLineExportResult<H, L>> {
  const head = await pageWithTruncation<H>(read.headers);
  if (head.error) return { error: `headers: ${head.error.message}` };
  const headers = head.data ?? [];

  const ids = [...new Set(headers.map((h) => h.id))];
  const lineRead = await chunkIn<L>(ids, (batch, from, to) => read.lines(batch, from, to));
  if (lineRead.error) return { error: `lines: ${lineRead.error.message}` };

  const linesByHeader = new Map<string, L[]>();
  for (const line of lineRead.data) {
    const parent = read.parentOf(line);
    if (!parent) continue;
    const arr = linesByHeader.get(parent) ?? [];
    arr.push(line);
    linesByHeader.set(parent, arr);
  }
  return { error: null, headers, linesByHeader, lineCount: lineRead.data.length, truncated: head.truncated };
}

/** Look rows up by id in URL-sized batches and index them — the SO number a
 *  line was raised for, the warehouse it ships to. Returns the error rather
 *  than an empty map, so a failed lookup is never exported as blank cells. */
export async function lookupByIds<T extends { id: string }>(
  ids: Iterable<string | null | undefined>,
  query: (batch: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: QueryError }>,
): Promise<{ error: string | null; byId: Map<string, T> }> {
  const wanted = [...new Set([...ids].filter((x): x is string => !!x))];
  const byId = new Map<string, T>();
  if (wanted.length === 0) return { error: null, byId };
  const res = await chunkIn<T>(wanted, query);
  if (res.error) return { error: res.error.message, byId };
  for (const row of res.data) byId.set(row.id, row);
  return { error: null, byId };
}
