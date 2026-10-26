/* After an edit, re-read ONLY the edited orders and swap them into every cached
   Delivery Planning board (owner 2026-10-27, option A). Re-reading the whole
   board after each edit took 2-12 s, and for that long the screen showed the
   pre-edit server copy: "改了没有变动", and a WhatsApp sent in the gap carried the
   old date.

   Pitfalls designed out (Hookka ERP and this repo met each one):
   - an older response landing over a newer one: each doc remembers the request
     that last asked for it, and only that request may write it back;
   - a row that no longer fits a cached slice (e.g. delivered while the OPEN
     slice is cached) is taken out of that slice, not left stale;
   - a failed row read is never merged: the board falls back to a full re-read. */
import type { QueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import type { PlanningOrder, PlanningResponse } from './delivery-planning-queries';

/** Same coalescing window as the full refresh it replaces. */
const ROW_REFRESH_MS = 500;
let timer: ReturnType<typeof setTimeout> | null = null;
let client: QueryClient | null = null;
const waiting = new Set<string>();
const lastAskedBy = new Map<string, number>();
let requestNo = 0;

/** Does a row belong in the board cached under ['delivery-planning', region, state]? */
function fitsSlice(o: PlanningOrder, region: unknown, state: unknown): boolean {
  if (region !== 'ALL' && typeof region === 'string' && !o.regions.includes(region as PlanningOrder['regions'][number])) return false;
  if (state === 'ALL' || state == null) return true;
  if (state === 'OPEN') return o.delivery_state !== 'DELIVERED';
  return o.delivery_state === state;
}

/** Replace the SO rows for `docs` in one cached board: in place when the fresh
 *  row still fits, removed when it no longer does (or no longer exists), appended
 *  when it newly fits. Every other row is untouched. */
export function mergeRowsIntoBoard(
  prev: PlanningResponse,
  key: readonly unknown[],
  docs: readonly string[],
  fresh: readonly PlanningOrder[],
): PlanningResponse {
  const region = key[1] ?? 'ALL';
  const state = key[2] ?? 'ALL';
  const wanted = new Set(docs);
  const freshByDoc = new Map(fresh.filter((o) => o.row_type === 'so').map((o) => [o.so_doc_no, o]));
  const placed = new Set<string>();
  const orders: PlanningOrder[] = [];
  for (const o of prev.orders) {
    if (o.row_type !== 'so' || !wanted.has(o.so_doc_no)) { orders.push(o); continue; }
    const next = freshByDoc.get(o.so_doc_no);
    placed.add(o.so_doc_no);
    if (next && fitsSlice(next, region, state)) orders.push(next);
  }
  for (const [doc, next] of freshByDoc) {
    if (!placed.has(doc) && wanted.has(doc) && fitsSlice(next, region, state)) orders.push(next);
  }
  return { ...prev, orders };
}

async function flush(): Promise<void> {
  timer = null;
  const qc = client;
  const docs = [...waiting];
  waiting.clear();
  if (!qc || docs.length === 0) return;
  const mine = ++requestNo;
  for (const d of docs) lastAskedBy.set(d, mine);
  let fresh: PlanningOrder[];
  try {
    fresh = (await authedFetch<PlanningResponse>(`/delivery-planning?docs=${encodeURIComponent(docs.join(','))}`)).orders;
  } catch {
    void qc.invalidateQueries({ queryKey: ['delivery-planning'] });
    return;
  }
  const current = docs.filter((d) => lastAskedBy.get(d) === mine);
  if (current.length === 0) return;
  for (const [key, prev] of qc.getQueriesData<PlanningResponse>({ queryKey: ['delivery-planning'] })) {
    if (!prev || !Array.isArray(prev.orders)) continue;
    qc.setQueryData<PlanningResponse>(key, mergeRowsIntoBoard(prev, key, current, fresh));
  }
}

/** Queue SO doc numbers for a row refresh; a burst of edits shares one request. */
export function scheduleRowRefresh(qc: QueryClient, docNos: readonly string[]): void {
  client = qc;
  for (const d of docNos) if (d) waiting.add(d);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void flush(); }, ROW_REFRESH_MS);
}
