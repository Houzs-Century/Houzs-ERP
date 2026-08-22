/* ----------------------------------------------------------------------------
   downstream-doc-refs — a child document as a list row needs it: an ADDRESS
   beside its NUMBER.

   WHY THIS EXISTS. The row menus print any document in a row's chain without
   leaving the list (owner 2026-08-22, 「我是要全部的 Transaction Flow 都要」), and
   a PDF is fetched by ADDRESS: every detail route but the Sales Order's is
   `.eq('id', id)`. The list payloads already carried the child NUMBERS — the DO
   No. column, `invoiced_si_nos`, `return_nos` — which can NAME a document and
   cannot fetch one. A menu entry built from one of those 404s.

   NO NEW READS. Every caller here is handed rows from a select that was ALREADY
   in flight for `has_children` and the lineage columns; the change at each call
   site is one more column in that select. A per-row lookup would cost more than
   the navigation this replaces, on lists that page 50 rows at a time.

   WHY IT IS ONE MODULE AND NOT FOUR INLINE LOOPS. Four child relations needed
   the identical decision — drop a row with no address, dedupe on id, order
   stably — and four hand-written copies of "stably" is how one menu comes to
   list a customer's invoices in a different order from the column above it.
   Written inline it was also 26 lines inside `mfg-sales-orders.ts`, which is
   ~12,000 lines and 3 under its size ceiling.

   THE NUMBERS ARRAYS ARE NOT REPLACED BY THIS. `do_nos`, `invoiced_si_nos` and
   `return_nos` feed DISPLAY columns and must keep a child that carries no id —
   the delivery still happened. Only the caller that exists in order to FETCH
   drops it. `so-delivery-order-nos.ts` states the same split.
   ---------------------------------------------------------------------------- */

import { doRefsBySalesOrder, type DeliveryOrderNoRow, type DeliveryOrderRef } from './so-delivery-order-nos';

/** A child document that can be both NAMED and FETCHED. */
export type DocRef = DeliveryOrderRef;

/**
 * Group child rows under their parent id, keeping each child's address.
 *
 * Ordered by document number, descending and numeric-aware, because a menu that
 * reshuffles between reloads reads as a different set of documents. Deduped on
 * id: one invoice must never be offered twice. A row missing the parent, the id
 * or the number is dropped — all three are needed to build an entry that works.
 */
export function refsByParent<R extends Record<string, unknown>>(
  rows: readonly R[] | null | undefined,
  parentKey: keyof R & string,
  docNoKey: keyof R & string,
): Map<string, DocRef[]> {
  const out = new Map<string, DocRef[]>();
  for (const r of rows ?? []) {
    const parent = r[parentKey];
    const id = r['id'];
    const docNo = r[docNoKey];
    if (typeof parent !== 'string' || !parent) continue;
    if (typeof id !== 'string' || !id) continue;
    if (typeof docNo !== 'string' || !docNo) continue;
    const list = out.get(parent) ?? [];
    if (list.some((x) => x.id === id)) continue;
    list.push({ id, docNo });
    out.set(parent, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => b.docNo.localeCompare(a.docNo, undefined, { numeric: true }));
  }
  return out;
}

/** What a Sales Order row carries so its menu can print what came after it. */
export type SoDownstreamRefs = { do_refs: DocRef[]; si_refs: DocRef[] };

/** The answer for an order with nothing downstream. Frozen and shared so the
 *  hot path does not allocate two arrays per row to say "none". */
const NONE: DocRef[] = Object.freeze([]) as unknown as DocRef[];
export const NO_SO_DOWNSTREAM_REFS: SoDownstreamRefs = Object.freeze({ do_refs: NONE, si_refs: NONE });

/**
 * The delivery orders and sales invoices under each Sales Order.
 *
 * The DO half goes through `doRefsBySalesOrder` rather than `refsByParent`, and
 * that is deliberate: the DO No. COLUMN orders by delivery date with created_at
 * as the fallback, and the menu has to list the same deliveries in the same
 * order as the column two pixels above it. Sorting them independently here
 * would look like a different set of documents.
 */
export function soDownstreamRefs(
  doRows: readonly DeliveryOrderNoRow[] | null | undefined,
  siRows: readonly Record<string, unknown>[] | null | undefined,
): Map<string, SoDownstreamRefs> {
  const byDo = doRefsBySalesOrder([...(doRows ?? [])]);
  const bySi = refsByParent(siRows, 'so_doc_no', 'invoice_number');
  const out = new Map<string, SoDownstreamRefs>();
  for (const so of new Set([...byDo.keys(), ...bySi.keys()])) {
    out.set(so, { do_refs: byDo.get(so) ?? [], si_refs: bySi.get(so) ?? [] });
  }
  return out;
}
