/* ----------------------------------------------------------------------------
   po-line-order — WHERE A PURCHASE ORDER LINE SITS ON THE ORDER, in one place.

   OWNER'S RULE, 2026-09-10, on a PO that printed a three-piece sofa with the
   armless module first: 「我们的 Sales Order 都是从 L 到 R（L 在第一，R 在最后）」
   — and 「照片是根据 line item 的顺序来的」, so the printed PO's ITEM PHOTOS
   block scrambles with the table.

   WHY IT WAS NOT TRUE. `scm.purchase_order_items` had no line-order column at
   all. Every line of a converted sofa is written by ONE insert, so they share
   a `created_at` to the microsecond, and `.order('created_at')` alone has
   nothing left to break the tie with — Postgres answers in physical order, and
   an UPDATE moves a row's physical position. Migration
   20260910T0547_scm_po_item_line_no adds `line_no` and back-fills it from the
   source SO line where that is derivable.

   TWO HALVES, AND THEY MUST STAY TOGETHER:

     · `inPoLineOrder` — every read whose rows are DISPLAYED or PRINTED.
       `poLineOrderWiring.test.ts` fails the build if a purchase_order_items
       read used for display skips it.
     · `nextPoLineNo` + `stampPoLineNos` — every write that BORNS lines. The
       order is decided where lines are created and STORED; a display path
       never recomputes it. That is the boundary the owner drew for the sofa
       handedness rule (「只针对新的order生效 旧的就不理了」,
       sofaOrderForNewLines.test.ts) and it holds here for the same reason:
       re-deriving at read time would re-sequence every existing document the
       next time somebody opened it.

   NULLS FIRST, and it is not a detail. A line whose PO predates the column has
   line_no NULL. `nextPoLineNo` on such a PO answers 1 (there is no max to add
   to), so an appended line MUST sort after the NULLs, not in front of them.
   `created_at` then `id` keep the fallback total, so two reads of the same
   untouched document can never disagree.
   -------------------------------------------------------------------------- */

/** Minimal shape of the PostgREST builder this applies to. */
type Orderable<T> = { order(col: string, opts: { ascending: boolean; nullsFirst?: boolean }): T };

/** Apply the canonical purchase-order line order. */
export function inPoLineOrder<T extends Orderable<T>>(q: T): T {
  return q
    .order('line_no', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
}

/** Minimal shape of the PostgREST client `nextPoLineNo` needs. The parameter
 *  is `unknown` and asserted to this INSIDE, not typed as this: the real
 *  supabase-js client's `from()` is generic over every table in the schema, and
 *  structurally matching it against a hand-written shape makes tsc give up with
 *  "Type instantiation is excessively deep" (TS2589) at the call site. The
 *  repo's usual escape is `sb: any`, which a new file cannot carry — its
 *  no-explicit-any ceiling is zero. */
type LineNoReader = {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        order(col: string, opts: { ascending: boolean; nullsFirst?: boolean }): {
          limit(n: number): {
            maybeSingle(): PromiseLike<{ data: { line_no?: number | null } | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
};

/**
 * The number the NEXT line appended to this purchase order should carry.
 *
 * 1 for a PO with no lines AND for a PO whose lines all predate the column —
 * both answer max(line_no) = NULL. That is correct in both cases only because
 * the read sorts NULLS FIRST (see the header).
 *
 * A FAILED read THROWS. supabase-js does not throw on its own, so an unbound
 * `error` here would be indistinguishable from "this PO has no lines" and the
 * next line would write line_no 1 onto a document that already has ten
 * (`check-swallowed-reads.mjs`). The caller is about to insert into this same
 * table; if it cannot be read, the insert has no business proceeding.
 */
export async function nextPoLineNo(sb: unknown, purchaseOrderId: string): Promise<number> {
  const { data, error } = await (sb as LineNoReader)
    .from('purchase_order_items')
    .select('line_no')
    .eq('purchase_order_id', purchaseOrderId)
    .order('line_no', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`nextPoLineNo: could not read the PO's line order: ${error.message}`);
  const max = data?.line_no;
  return typeof max === 'number' && Number.isFinite(max) ? max + 1 : 1;
}

/**
 * Number an insert payload from `startAt`, in the order the array is already
 * in. The caller owns putting the array in the right order first — for a
 * convert that is `sortBySourceSoLine`, for a manual create it is the order the
 * operator arranged the form.
 */
export function stampPoLineNos<T extends object>(rows: readonly T[], startAt: number): Array<T & { line_no: number }> {
  return rows.map((r, i) => ({ ...r, line_no: startAt + i }));
}

/** The bit of a picked SO line that decides where it lands on the PO. */
export interface SourceSoLineOrder {
  soDocNo: string | null | undefined;
  soLineNo: number | null | undefined;
}

/**
 * Order picked lines the way their SALES ORDERS hold them: by document, then by
 * the SO's own `line_no`.
 *
 * STABLE, and the fallback matters. A line with no `line_no` (12 SO lines on
 * production carry NULL, and the legacy `soItems` convert path fabricates rows
 * that have none) keeps the caller's position among its document's lines
 * instead of being shuffled to an end — there is no evidence for where it
 * belongs, so the document it came in on is the only answer there is.
 */
export function sortBySourceSoLine<T extends SourceSoLineOrder>(lines: readonly T[]): T[] {
  return lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      const da = a.l.soDocNo ?? '';
      const db = b.l.soDocNo ?? '';
      if (da !== db) return da < db ? -1 : 1;
      const na = typeof a.l.soLineNo === 'number' && Number.isFinite(a.l.soLineNo) ? a.l.soLineNo : null;
      const nb = typeof b.l.soLineNo === 'number' && Number.isFinite(b.l.soLineNo) ? b.l.soLineNo : null;
      if (na !== null && nb !== null && na !== nb) return na - nb;
      return a.i - b.i;
    })
    .map((e) => e.l);
}
