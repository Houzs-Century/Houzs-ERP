// ----------------------------------------------------------------------------
// outstanding-po-lines — the read behind GET /grns/outstanding-po-items, and the
// REASON an empty answer is empty.
//
// THE BUG THIS EXISTS FOR (owner, 2026-08-17). He opened "Pick PO lines for this
// GRN" scoped to one PO (`?poId=`), the banner read "Reviewing this PO", the
// grid returned ZERO rows, and the screen said:
//
//     "No outstanding PO lines — every line has been received (or there are no
//      outstanding POs)."
//
// The PO had never been received. Three separate mechanisms could produce that
// screen, and the sentence asserted the one that was false:
//
//  1. `.limit(500)` sat on the RAW `purchase_order_items` select, and BOTH
//     filters — parent status, and `qty - received_qty > 0` — ran afterwards in
//     JavaScript. So the 500-row window was spent on every PO line in the
//     company, received or not, draft or not. The picker never saw "the first
//     500 outstanding lines"; it saw "however many of an arbitrary 500 lines
//     happened to be outstanding". Any PO outside that window was invisible,
//     with no signal of any kind.
//  2. The window was ordered by `purchase_order_id DESC`. That is a key order,
//     not a date order, so WHICH 500 lines you got was arbitrary rather than
//     "the newest".
//  3. `?poId=` was never sent to the server. The scope was applied in the
//     browser, to the already-truncated list, so scoping could only ever
//     NARROW the window — never recover a PO that fell outside it.
//
// This module fixes all three by construction: the status filter and the poId
// scope are pushed into SQL, so the window is spent only on candidate rows and a
// scoped read is bounded by one PO's line count. `qty - received_qty > 0` stays
// in JS because PostgREST cannot compare two columns — but the read is now paged
// rather than capped, so that filter no longer runs over a truncated set.
//
// AND it reports WHY. `explainOutstanding` returns the facts an empty grid needs
// in order to say something true: the requested POs with their statuses, the
// ones this company's books do not hold, and whether the paged read hit its
// ceiling. "Every line has been received" and "your PO is not in the window I
// looked at" are opposite facts, and the operator acts on the first one by
// walking away from work that is still outstanding.
// ----------------------------------------------------------------------------

/* THE RECEIVABLE STATUS SET IS NOT DECLARED HERE, ON PURPOSE.
 *
 * `routes/grns.ts` already owns it — `RECEIVABLE_PO_STATUSES` +
 * `isReceivablePoStatus`, whose comment calls itself "the SINGLE predicate the
 * GRN create paths share". A copy in this module would be a second authority for
 * the same question, which is the duplicated-list bug CLAUDE.md names; worse, it
 * would be the copy that decides what the PICKER shows while the original
 * decides what the CONVERTER accepts, so a drift between them would present a
 * line the server then refuses. `explainOutstanding` therefore takes the
 * predicate as a REQUIRED parameter and calls the caller's one.
 */

/**
 * The NARROWER, SQL-side status filter — DRAFT and CANCELLED only.
 *
 * Why it is not the complement of RECEIVABLE_PO_STATUSES. The only embedded-
 * resource status filter this repo has proven against production is
 * `.not('<alias>.status', 'in', <quoted list>)` (`mrp.ts:535`, same table, same
 * `po:purchase_orders!inner` embed, and its own header records that
 * so-delivery-sync.ts proved the quoting). An `.in()` on an embedded path would
 * be a NEW form, and there is no local database and no PostgREST in CI to prove
 * it on — so it would ship on reasoning alone, which is the thing CLAUDE.md
 * forbids. Copying the proven form and leaving the exact set to JS keeps the
 * behaviour byte-identical to today's while still doing the job that matters:
 * the paged read stops walking every draft and cancelled order in history.
 *
 * A NULL-status row is dropped by `not.in` (NULL never passes NOT IN). That is
 * not a behaviour change: the JS gate drops it too, since NULL is in neither
 * RECEIVABLE status.
 */
export const PO_DEAD_FOR_RECEIPT: readonly string[] = ['DRAFT', 'CANCELLED'];

/** PostgREST's quoted in-list form, copied from mrp.ts's `sqlNotInList`. */
export const poDeadForReceiptSql = (): string =>
  `(${PO_DEAD_FOR_RECEIPT.map((s) => `"${s}"`).join(',')})`;

/** Ceiling on the paged read. 20 pages of 1000 = 20,000 candidate lines, which
 *  is a bound on RUNAWAY, not a business limit: it is only reachable when a
 *  company holds that many lines on live POs, and when it IS reached the caller
 *  is told so rather than being handed a short list that looks complete. */
export const OUTSTANDING_PAGE = 1000;
export const OUTSTANDING_MAX_PAGES = 20;

type QueryError = { message: string; code?: string } | null;

/** What one page of a PostgREST read looks like, typed loosely on purpose.
 *
 *  `unknown[]` rather than `T[]`: supabase-js infers a to-ONE embed
 *  (`po:purchase_orders!inner (...)`) as an ARRAY, which is wrong at runtime and
 *  makes every hand-written row type structurally incompatible with the builder.
 *  The repo's existing answer is `as unknown as Row[]` at the use site; keeping
 *  the widening HERE means the cast happens once, inside a function whose job is
 *  the read, instead of at each caller. */
export type RawPage = PromiseLike<{ data: unknown[] | null; error: QueryError }>;

export type OutstandingPageResult<T> = { data: T[] | null; error: QueryError; truncated: boolean };

/**
 * Page a PostgREST query to exhaustion and SAY whether it stopped early.
 *
 * Not `paginateAll` — that helper returns `{ data, error }` and therefore cannot
 * distinguish "that is all of them" from "that is as many as I was willing to
 * read", which is exactly the distinction this endpoint got wrong. The loop is
 * otherwise the same shape, deliberately.
 */
export async function pageWithTruncation<T>(
  makeQuery: (from: number, to: number) => RawPage,
): Promise<OutstandingPageResult<T>> {
  const all: T[] = [];
  for (let page = 0; page < OUTSTANDING_MAX_PAGES; page++) {
    const from = page * OUTSTANDING_PAGE;
    const { data, error } = await makeQuery(from, from + OUTSTANDING_PAGE - 1);
    if (error) return { data: null, error, truncated: false };
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < OUTSTANDING_PAGE) return { data: all, error: null, truncated: false };
  }
  // Every page came back full, so there is at least one more row we did not read.
  return { data: all, error: null, truncated: true };
}

/** `?poId=a,b,c` → `['a','b','c']`. Empty means the full, unscoped picker, which
 *  is a legitimate entry point (the list toolbar's "From PO"), not a broken link
 *  — see `frontend/src/lib/convertScope.tsx`. */
export function parsePoIdScope(raw: string | undefined | null): string[] {
  return [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
}

/** What the server found for one PO the operator asked to receive. */
export type ScopedPo = {
  poId: string;
  poDocNo: string | null;
  status: string | null;
  /** Is this status one the picker will show lines from at all? */
  receivable: boolean;
  /** Lines on this PO that the status filter let through. */
  candidateLines: number;
  /** Of those, how many still have qty − received_qty > 0. */
  outstandingLines: number;
};

/**
 * The facts an empty grid needs. Returned as DATA, not as a sentence: the
 * desktop picker and the mobile convert wizard read the same endpoint, so the
 * wording belongs to each surface and the truth belongs here.
 */
export type OutstandingScope = {
  /** The ids the caller asked to be scoped to, after parsing. */
  requestedPoIds: string[];
  /** One entry per requested id THIS COMPANY HOLDS, in request order. */
  pos: ScopedPo[];
  /** Requested ids with no PO in this company's books — a wrong id, or another
   *  company's PO. Silence here is how a cross-company link reads as "done". */
  unknownPoIds: string[];
  /** The paged read stopped at its ceiling, so lines are missing from `items`. */
  truncated: boolean;
  /** The follow-up HEADER read failed, so a requested PO's absence from `pos`
   *  proves nothing. Without this, a database blip renders as "that Purchase
   *  Order is not in this company's books". Optional on the type because
   *  `explainOutstanding` does not perform that read — `loadOutstandingPoLines`
   *  adds it — and a report that never looked must not claim it succeeded. */
  headerReadFailed?: boolean;
  /** Candidate lines actually read (post status filter, pre remaining filter). */
  scanned: number;
};

/** Minimal row shape the REPORT reasons about. `OutstandingPoRow` is wider. */
export type CountableRow = {
  purchase_order_id: string;
  qty: number;
  received_qty: number | null;
  po: { po_number?: string | null; status?: string | null } | null;
};

/** One PO line as the picker needs it, with its parent embedded. */
export type OutstandingPoRow = {
  id: string; purchase_order_id: string; material_kind: string; material_code: string;
  material_name: string; supplier_sku: string | null; item_group: string | null;
  description: string | null;
  /* `received_qty` is `number | null`, not `number`. The column is NOT NULL in
     the schema dump, but that dump is the 2990 SOURCE system's and is already
     known to be behind production, and the value arrives through an UNTYPED
     supabase-js client — so a hand-written `number` here is a promise nothing
     checks. Declaring it nullable is what makes the `?? 0` guards below load-
     bearing instead of "unnecessary conditions" the linter offers to delete;
     CLAUDE.md's lint section describes exactly that trap. It also matches
     `remainingOf` and `CountableRow`, which already type it this way. */
  qty: number; received_qty: number | null; unit_price_centi: number;
  warehouse_id: string | null; variants: unknown; delivery_date: string | null;
  // Migration 0180 — per-line supplier-revised delivery dates.
  supplier_delivery_date_2: string | null;
  supplier_delivery_date_3: string | null;
  supplier_delivery_date_4: string | null;
  po: {
    id: string; po_number: string; supplier_id: string; status: string;
    po_date: string; expected_at: string | null; purchase_location_id: string | null;
    // Migration 0180 — header supplier-revised delivery dates.
    supplier_delivery_date_2: string | null;
    supplier_delivery_date_3: string | null;
    supplier_delivery_date_4: string | null;
    supplier: { code: string; name: string } | null;
  };
};

/* The columns the picker reads. Kept beside the row type so the two cannot drift
   — a select that stops returning a field the type promises is a runtime
   undefined with no compile error.
   The parent's `purchase_location_id` is here because the GRN-from-PO picker
   locks to ONE warehouse per GRN and shows a Warehouse column (Commander
   2026-05-29, mirroring the supplier lock); the warehouse code/name needs a
   second round trip in the caller, because a Supabase nested select cannot reach
   `warehouses` through the items -> po hop cleanly. */
const OUTSTANDING_SELECT = `
      id, purchase_order_id, material_kind, material_code, material_name, supplier_sku, item_group,
      description, qty, received_qty, unit_price_centi, warehouse_id, variants, delivery_date,
      supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
      po:purchase_orders!inner ( id, po_number, supplier_id, status, po_date, expected_at,
        supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
        purchase_location_id, supplier:suppliers ( code, name ) )
    `;

/**
 * The whole read: paged, scoped in SQL, filtered, and explained.
 *
 * `scopeQuery` is the CALLER's company predicate, passed in rather than imported,
 * so this module cannot be the place a company scope goes missing — it has no
 * `Context` and cannot silently degrade to no predicate. The SCM client is
 * service-role and bypasses RLS, so that predicate is the entire tenant
 * boundary (CLAUDE.md).
 *
 * `isReceivable` is likewise the caller's, so the picker and the converter cannot
 * disagree about which statuses accept a receipt.
 */
export async function loadOutstandingPoLines(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase-js client this tree passes around
  sb: any;
  scopeQuery: <Q>(q: Q) => Q;
  requestedPoIds: string[];
  isReceivable: (status: string | null | undefined) => boolean;
}): Promise<
  | { error: string }
  | { error: null; rows: OutstandingPoRow[]; scope: OutstandingScope }
> {
  const { sb, scopeQuery, requestedPoIds, isReceivable } = args;

  /* PAGED, not capped, and the dead-status filter is pushed into SQL so the read
     stops walking every draft and cancelled order in history. */
  const { data, error, truncated } = await pageWithTruncation<OutstandingPoRow>((from, to) => {
    let q = scopeQuery(
      sb.from('purchase_order_items').select(OUTSTANDING_SELECT)
        .not('po.status', 'in', poDeadForReceiptSql()),
    );
    if (requestedPoIds.length > 0) q = q.in('purchase_order_id', requestedPoIds);
    /* Order by the line's own key, not the parent's. `purchase_order_id DESC` was
       a key order masquerading as "newest first", and paging needs a total order
       to be stable across pages anyway. */
    return q.order('id').range(from, to);
  });
  if (error) return { error: error.message };

  const candidates = data ?? [];
  const rows = candidates
    .filter((r) => isReceivable(r.po.status))
    .filter((r) => remainingOf(r) > 0);

  /* A requested PO that is DRAFT or CANCELLED produced NO candidate rows (the SQL
     filter dropped it), so its status can only be learned from a header read.
     Without this, "your PO is a draft" is indistinguishable from "your PO does
     not exist" — and both used to render as "every line has been received".
     Scoped requests only; the open picker asks for nothing. */
  const headerStatuses = new Map<string, { poDocNo: string | null; status: string | null }>();
  const missing = requestedPoIds.filter((id) => !candidates.some((r) => r.purchase_order_id === id));
  /* BIND THE ERROR. supabase-js does not throw, so `const { data } = await …`
     cannot tell "the query failed" from "there is nothing here" — and here that
     difference is the whole point: a swallowed failure leaves `headerStatuses`
     empty, `explainOutstanding` then reports the PO as UNKNOWN, and the operator
     is told his Purchase Order is not in this company's books. That is a
     confidently wrong sentence produced by a database blip, which is the exact
     class of bug this module was written to remove. Reported as its own fact
     rather than folded into either answer. */
  let headerReadFailed = false;
  if (missing.length > 0) {
    const { data: hdrs, error: hdrErr } = await scopeQuery(
      sb.from('purchase_orders').select('id, po_number, status'),
    ).in('id', missing);
    if (hdrErr) {
      headerReadFailed = true;
    } else {
      for (const h of (hdrs ?? []) as Array<{ id: string; po_number: string | null; status: string | null }>) {
        headerStatuses.set(h.id, { poDocNo: h.po_number, status: h.status });
      }
    }
  }

  return {
    error: null,
    rows,
    scope: {
      ...explainOutstanding(requestedPoIds, candidates, headerStatuses, truncated, isReceivable),
      headerReadFailed,
    },
  };
}

/** qty − received_qty, floored at nothing (a negative means over-receipt, which
 *  is not outstanding). Kept here so the route and the tests share one rule. */
export const remainingOf = (r: { qty: number; received_qty: number | null }): number =>
  r.qty - (r.received_qty ?? 0);

/**
 * Build the scope report from the rows the SQL returned.
 *
 * `headerStatuses` covers the requested POs that produced NO candidate rows —
 * a DRAFT or CANCELLED PO is filtered out in SQL, so its status can only be
 * learned from a separate header read. Pass an empty map when nothing was
 * requested; `null` is not accepted because "I did not look" and "I looked and
 * found nothing" are the two answers this whole module exists to separate.
 *
 * `isReceivable` is REQUIRED, per CLAUDE.md's rule about a parameter that
 * decides something: it decides whether the operator is told "your PO is a
 * draft" or "every line has been received", and those are opposite facts. It
 * must be the CALLER's predicate — see the note at the top of this file.
 */
export function explainOutstanding(
  requestedPoIds: string[],
  rows: CountableRow[],
  headerStatuses: Map<string, { poDocNo: string | null; status: string | null }>,
  truncated: boolean,
  isReceivable: (status: string | null | undefined) => boolean,
): OutstandingScope {
  const byPo = new Map<string, { docNo: string | null; status: string | null; candidate: number; outstanding: number }>();
  for (const r of rows) {
    const e = byPo.get(r.purchase_order_id) ?? {
      docNo: r.po?.po_number ?? null, status: r.po?.status ?? null, candidate: 0, outstanding: 0,
    };
    e.candidate += 1;
    if (remainingOf(r) > 0) e.outstanding += 1;
    byPo.set(r.purchase_order_id, e);
  }

  const pos: ScopedPo[] = [];
  const unknownPoIds: string[] = [];
  for (const id of requestedPoIds) {
    const seen = byPo.get(id);
    const header = headerStatuses.get(id);
    if (!seen && !header) { unknownPoIds.push(id); continue; }
    const status = seen?.status ?? header?.status ?? null;
    pos.push({
      poId: id,
      poDocNo: seen?.docNo ?? header?.poDocNo ?? null,
      status,
      receivable: isReceivable(status),
      candidateLines: seen?.candidate ?? 0,
      outstandingLines: seen?.outstanding ?? 0,
    });
  }

  return { requestedPoIds, pos, unknownPoIds, truncated, scanned: rows.length };
}

/** How the picker's rows reach the wire. `effectiveDelivery` is injected rather
 *  than imported so this module stays free of the `../shared` barrel, which pulls
 *  in the variant machinery; the caller already holds it. */
export async function toOutstandingPoItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase-js client this tree passes around
  sb: any,
  rows: OutstandingPoRow[],
  effectiveDelivery: (...dates: Array<string | null>) => string | null,
) {
  /* Warehouse-lock fix (Agent C 2026-05-31, bug #1 "No outstanding PO lines") —
     the warehouse a PO line ships into is the LINE's own warehouse_id when set,
     falling back to the PO header's purchase_location_id (the per-line warehouse
     OVERRIDES the header — see schema comment on purchase_order_items.warehouse_id).
     The GRN's warehouse_id is set from this same effective value at create time, so
     the append-picker's lock (GrnFromPo: r.warehouseLocationId === grn.warehouse_id)
     only matched when both happened to use the header. When a PO carried only a
     per-line warehouse (header purchase_location_id NULL), every outstanding line
     was filtered out → "No outstanding PO lines". Key the lock off the effective
     warehouse so genuinely-outstanding lines surface. */
  const effWh = (r: OutstandingPoRow): string | null => r.warehouse_id ?? r.po.purchase_location_id ?? null;

  // Resolve each line's effective warehouse code/name in one round trip.
  const whIds = [...new Set(rows.map((r) => effWh(r)).filter((x): x is string => Boolean(x)))];
  const whById = new Map<string, { code: string; name: string }>();
  if (whIds.length > 0) {
    /* Bind the error even though the failure is cosmetic here — a blank warehouse
       column, not a wrong claim. Left unbound it is indistinguishable from "no
       such warehouse", and check-swallowed-reads.mjs cannot tell the two apart
       either, so an unbound read in a NEW file reads as the dangerous kind. */
    const { data: whs, error: whErr } = await sb.from('warehouses').select('id, code, name').in('id', whIds);
    if (whErr) console.error(`outstanding-po-items: warehouse lookup failed, names will be blank: ${whErr.message}`);
    for (const w of (whs ?? []) as Array<{ id: string; code: string; name: string }>) {
      whById.set(w.id, { code: w.code, name: w.name });
    }
  }

  const outstanding = rows.map((r) => {
    const effWhId = effWh(r);
    const wh = effWhId ? whById.get(effWhId) ?? null : null;
    return {
      poItemId:        r.id,
      poId:            r.po.id,
      poDocNo:         r.po.po_number,
      itemCode:        r.material_code,
      /* Owner 2026-07-27 — the SUPPLIER's own code, snapshotted on the PO line
         at raise time (#1189). Carried so the New-GRN line (and the grn_items
         snapshot it saves) shows the code the supplier's delivery note uses. */
      supplierSku:     r.supplier_sku ?? null,
      description:     r.description ?? r.material_name,
      itemGroup:       r.item_group ?? '',
      qty:             r.qty,
      receivedQty:     r.received_qty ?? 0,
      remainingQty:    r.qty - (r.received_qty ?? 0),
      unitPriceCenti:  r.unit_price_centi,
      warehouseId:     r.warehouse_id,
      variants:        r.variants,
      /* Delivery-carry — surface the PO line's EFFECTIVE (latest revised)
         delivery date so it can ride into the converted GRN line (Deliverable
         5). Migration 0180: MAX over non-null of [delivery_date, _2, _3, _4].
         supabase-js returns snake_case, and Row types them, so read directly. */
      deliveryDate:    effectiveDelivery(
        r.delivery_date,
        r.supplier_delivery_date_2,
        r.supplier_delivery_date_3,
        r.supplier_delivery_date_4,
      ),
      supplierId:      r.po.supplier_id,
      supplierCode:    r.po.supplier?.code ?? '',
      supplierName:    r.po.supplier?.name ?? '',
      poDate:          r.po.po_date,
      /* Migration 0180 — header EFFECTIVE (latest revised) delivery date for the
         "Expected" column. MAX over non-null of [expected_at, _2, _3, _4]. */
      expectedAt:      effectiveDelivery(
        r.po.expected_at,
        r.po.supplier_delivery_date_2,
        r.po.supplier_delivery_date_3,
        r.po.supplier_delivery_date_4,
      ),
      /* Warehouse-lock (Deliverable 4) — the line's EFFECTIVE ship-into warehouse
         (per-line warehouse_id, else PO header purchase_location_id). This is the
         GRN's receive-into warehouse. One warehouse per GRN. */
      warehouseLocationId:   effWhId,
      warehouseLocationCode: wh?.code ?? null,
      warehouseLocationName: wh?.name ?? null,
    };
  });
  return outstanding;
}
