// ----------------------------------------------------------------------------
// soDeliverableRemaining — the live "how much of each SO line can still ship".
//
// Moved out of routes/delivery-orders-mfg.ts (at its size ceiling) when its
// reads were overlapped (perf/do-create-and-picker, 2026-11). The ANSWER is
// unchanged — routes/delivery-orders-mfg.read-pin.test.ts pins it on a fixture
// that was snapshotted before the move. What changed is only how the rows
// arrive:
//
//   · LINKED delivered — each SO line's DO lines ride EMBEDDED in the SO-line
//     read (`do_lines:…`), the shape MRP has used in production since HC-0002
//     (lib/mrp-delivered.ts). That removes the separate chunked read of
//     delivery_order_items by so_item_id: one uuid per SO line in the URL, 76
//     to a request — ~200 requests for the picker's whole-company call. If the
//     embedded read fails, the old two-step path (netDeliveredBySoItem) runs
//     instead, so a failure reads exactly as it did before.
//   · The header-debtor read and the unlinked-DO-line reads key off the doc
//     numbers only, so they START beside the SO-line read instead of after it.
//   · The return-line read keys off DO-line ids (~1 per shipped line). When that
//     list would take more than one wave of chunked requests and the whole
//     delivery_return_items table is smaller than that, the table is read in
//     keyset pages and filtered here by the same ids — the same rows, in a
//     handful of requests. Any doubt (count failed, a page failed, fewer rows
//     than counted) falls back to the chunked read.
// ----------------------------------------------------------------------------

import { doCountsAsDelivered } from '../shared/do-shipped-states';
import { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank } from '../shared/so-line-display';
import { eager } from './concurrency';
import { attributeUnlinkedDoLines, netDeliveredBySoItem, readUnlinkedDoLinesUnder } from './do-unlinked-coverage';
import { chunkIn, chunkSizeForUrl, PAGE } from './paginate-all';

const SO_LINE_SELECT =
  'id, doc_no, debtor_code, debtor_name, item_code, item_group, description, description2, ' +
  'uom, qty, unit_price_sen, unit_cost_sen, discount_sen, variants, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen';

/** Each SO line's DO lines with their DO's status — the linked half of Σ delivered. */
export const SO_LINE_DO_LINES_EMBED = 'do_lines:delivery_order_items(id, qty, parent:delivery_orders(status))';

type One<T> = T | T[] | null | undefined;
const one = <T>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

type ReturnLine = { do_item_id: string | null; qty_returned: number | null; parent: One<{ status: string | null }> };
const RETURN_SELECT = 'do_item_id, qty_returned, parent:delivery_returns(status)';

/* These reads have always answered with whatever arrived when one failed — the
   callers' numbers were built on that, and this change keeps every answer as it
   was. It is no longer SILENT: a failure is logged with what it can cost. */
function readFailed(what: string, error: { message: string }): void {
  // eslint-disable-next-line no-console
  console.error(`[so-deliverable-remaining] ${what} read failed; this answer may be short: ${error.message}`);
}

/* chunkIn runs 6 batches at a time; past one such wave a whole-table read can be cheaper. */
const CHUNK_WAVE = 6;
/* Never scan more than this many pages instead — a big table goes back to the chunked read. */
const RETURN_SCAN_MAX_PAGES = 10;

/**
 * Every delivery_return_items row (keyset pages on id), or null when the table
 * is not small enough to beat `chunkedRequests`, or anything about the read is
 * in doubt. Null always means "use the chunked read" — never "no returns".
 */
async function readAllReturnLinesIfCheaper(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped SCM client
  sb: any,
  chunkedRequests: number,
): Promise<ReturnLine[] | null> {
  try {
    const { count, error } = await sb.from('delivery_return_items').select('id', { count: 'exact', head: true });
    if (error || typeof count !== 'number') return null;
    const pages = Math.max(1, Math.ceil(count / PAGE));
    if (pages > RETURN_SCAN_MAX_PAGES || pages + 1 >= Math.ceil(chunkedRequests / CHUNK_WAVE)) return null;
    const all: Array<ReturnLine & { id: string }> = [];
    let after: string | null = null;
    for (let i = 0; i <= pages + 1; i++) {
      let q = sb.from('delivery_return_items').select(`id, ${RETURN_SELECT}`);
      if (after !== null) q = q.gt('id', after);
      const { data, error: pErr } = await q.order('id').limit(PAGE);
      if (pErr) return null;
      const rows = (data ?? []) as Array<ReturnLine & { id: string }>;
      all.push(...rows);
      if (rows.length < PAGE) {
        /* Fewer rows than were counted means a page came back short for some
           other reason than the end of the table (a lower server row cap, or
           rows deleted mid-read) — not provably complete, so do not use it. */
        return all.length >= count ? all : null;
      }
      after = rows[rows.length - 1]!.id;
    }
    return null; // the table grew past the planned pages mid-read
  } catch {
    return null;
  }
}

/** The return lines on `doLineIds` — the same rows the chunked `.in('do_item_id')` read returns. */
async function readReturnLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped SCM client
  sb: any,
  doLineIds: string[],
): Promise<ReturnLine[]> {
  if (doLineIds.length === 0) return [];
  const requests = Math.ceil(doLineIds.length / chunkSizeForUrl(doLineIds));
  if (requests > CHUNK_WAVE) {
    const all = await readAllReturnLinesIfCheaper(sb, requests);
    if (all) {
      const want = new Set(doLineIds);
      return all.filter((r) => r.do_item_id != null && want.has(r.do_item_id));
    }
  }
  /* CHUNKED + PAGED, mirroring the delivered hop: one DO-LINE uuid per shipped line of
     every order in the batch, all in one URL. Under-reading is the bad direction here —
     a dropped return leaves the order no longer asking for goods that came back. */
  const { data, error } = await chunkIn<ReturnLine>(doLineIds, (batch, from, to) => sb.from('delivery_return_items').select(RETURN_SELECT).in('do_item_id', batch).order('id').range(from, to));
  if (error) readFailed('return-line', error);
  return data;
}

/* Commander 2026-05-30 — LINE-LEVEL, QUANTITY-BASED partial delivery.
   Replaces the old binary whole-SO conversion lock. For each SO line, the
   DELIVERABLE REMAINING quantity is DERIVED LIVE (no stored counter — that
   drifts):

     remaining(soItem) = soItem.qty
       − Σ delivery_order_items.qty   where so_item_id = soItem.id
                                      AND its delivery_orders.status != 'CANCELLED'
       + Σ delivery_return_items.qty_returned  where that return line traces
              (do_item_id → delivery_order_items.so_item_id = soItem.id) to a
              non-cancelled delivery_returns

   So a line is partially delivered (remaining > 0 → still convertible) or
   fully delivered (remaining == 0 → not convertible). Cancelling a DO,
   deleting a DO line, or processing a Delivery Return automatically RAISES
   remaining again, because the formula re-derives from the live rows.

   Returns one descriptor row per requested SO line (qty + remaining + the
   fields the picker / convert handler need), keyed by SO line id. */
export type DeliverableLine = {
  soItemId: string;
  docNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number;
  unitPriceSen: number;
  unitCostSen: number;
  discountSen: number;
  variants: unknown;
  /* Migration 0058 — dedicated sofa/bedframe variant-breakdown columns. Carried
     so the SO→DO convert keeps them (delivery_order_items has all 8); previously
     dropped here, so a converted DO lost the sofa/bedframe build breakdown. */
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  customSpecials: unknown;
  lineSuffix: string | null;
  specialOrderPriceSen: number;
  delivered: number;
  returned: number;
  remaining: number;
  /** Position of this line within ITS SO listing order (re-derived at read:
   *  rank mains→accessories→services + each build's left-to-right walk) — DO
   *  lines copy the SO's listing order instead of shuffling by uuid (Loo
   *  2026-06-12: mains first + sofa modules left-to-right survive onto the DO). */
  lineSeq: number;
};

const isEmbeddedDoLine = (d: unknown): boolean =>
  typeof d === 'object' && d !== null && typeof (d as { id?: unknown }).id === 'string' && 'parent' in d;

type SoLineRow = Record<string, unknown> & {
  id: string; doc_no: string; item_code: string; qty: number | null;
  do_lines?: Array<{ id: string; qty: number | null; parent: One<{ status: string | null }> }> | null;
};

export async function soDeliverableRemaining(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped SCM client every engine passes around
  sb: any,
  soDocNos: string[],
): Promise<Map<string, DeliverableLine>> {
  const out = new Map<string, DeliverableLine>();
  if (soDocNos.length === 0) return out;
  const docs = [...new Set(soDocNos)];

  /* ONE WAVE. The header debtor and the unlinked DO lines key off the doc
     numbers alone, so they run beside the SO-line read. `eager` holds a failure
     until the point of use, where the code below treats it exactly as before. */
  /* chunkIn: unbounded at BOTH ends before; unpaged, the 1001st header silently
     dropped, swapping the header debtor for the drifted line copy below. */
  const headsProm = eager(chunkIn<{ doc_no: string; debtor_code: string | null; debtor_name: string | null }>(docs, (batch, from, to) => sb.from('mfg_sales_orders').select('doc_no, debtor_code, debtor_name').in('doc_no', batch).order('doc_no').range(from, to)));
  const unlinkedProm = eager(readUnlinkedDoLinesUnder(sb, soDocNos));

  // 1. Load the non-cancelled SO lines of the requested SOs and re-derive
  //    each SO's listing order from the rows themselves (Loo 2026-06-12:
  //    mains → accessories → services, sofa modules left-to-right). The bulk
  //    insert gives every line the same created_at, so the timestamp can't
  //    recover the persisted order once routine updates relocate rows.
  /* CHUNKED on doc_no — paginateAll bounds the ROWS back; the doc numbers go OUT in the URL
     unbounded. One SO's lines stay in one batch and the walk below re-derives their order
     regardless ("the walk MUST run per doc"), so the split is invisible downstream.
     The embed is to-many, so it nests JSON and never changes the row count paged on. */
  const readLines = (select: string) => chunkIn<SoLineRow>(docs, (batch, from, to) => sb.from('mfg_sales_order_items')
    .select(select)
    .in('doc_no', batch)
    .eq('cancelled', false)
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at')
    .order('id')
    .range(from, to));
  const embedded = await readLines(`${SO_LINE_SELECT}, ${SO_LINE_DO_LINES_EMBED}`);
  /* Only trust the embed when it came back in the shape asked for: every row an
     ARRAY of DO lines, each carrying its id and its `parent` key (null for an
     orphan). Anything else — an error, a client or proxy that dropped the embed —
     runs the old two-step read, never a silent "nothing delivered". */
  const embeddedOk = !embedded.error && embedded.data.every((r) => Array.isArray(r.do_lines) && r.do_lines.every(isEmbeddedDoLine));
  const plain = embeddedOk ? null : await readLines(SO_LINE_SELECT);
  if (plain?.error) readFailed('sales-order line', plain.error);
  const rawLines = plain ? plain.data : embedded.data;
  if (rawLines.length === 0) return out;

  /* THE CUSTOMER IS A PROPERTY OF THE SALES ORDER, NOT OF ITS LINES.
     mfg_sales_order_items carries its own debtor_code/debtor_name copy, and
     those copies DRIFT: on 2990-SO-2606-034 the two sofa lines say "The Wei
     chin", the delivery line says "Teh Wei chin" and the disposal line says
     nothing at all — while the header says "Teh Wei chin" for all of them.
     Reading the line copy made the same-customer rule split ONE sales order into
     three customers: the picker greyed out half of 2606-034 the moment the
     operator ticked a sofa, and POST /from-sos would have rejected all four
     lines as `mixed_customers` (Nico, 2026-08-03; two SOs in prod carry this
     drift). Stamp the HEADER's debtor on every line — one order, one customer. */
  const headerDebtor = new Map<string, { code: string | null; name: string | null }>();

  /* buildKey values are per-SO ('build-1', …) — the walk MUST run per doc;
     keyed across docs it would mix two SOs' builds into one group. */
  const orderByDoc = new Map<string, typeof rawLines>();
  for (const l of rawLines) {
    const arr = orderByDoc.get(l.doc_no) ?? [];
    arr.push(l);
    orderByDoc.set(l.doc_no, arr);
  }
  const lines = [...orderByDoc.values()].flatMap((docLines) =>
    orderSofaModuleRowsWithinBuilds(
      sortSoLinesByGroupRank(docLines, (r) => r.item_group as string | null | undefined),
    ),
  );
  const coverageLines = lines.map((l) => ({ id: l.id, docNo: l.doc_no, itemCode: l.item_code, qty: Number(l.qty ?? 0) }));

  /* 2. Σ delivered per SO line — the real so_item_id links AND the shipments
        whose link the FK blanked but whose DO header still names this order
        (lib/do-unlinked-coverage.ts). Linked: from the embedded DO lines, the
        same rows and the same gate as netDeliveredBySoItem's linked read (a DO
        line with no parent is skipped; doCountsAsDelivered decides the rest).
        A failed embedded read runs netDeliveredBySoItem itself instead. */
  let deliveredBySoItem: Map<string, number>;
  let doLineToSoItem: Map<string, string>;
  let returnsProm: Promise<() => ReturnLine[]> | null = null;
  let linkedDoLineIds = new Set<string>();
  if (embeddedOk) {
    deliveredBySoItem = new Map();
    doLineToSoItem = new Map();
    for (const l of lines) {
      for (const d of l.do_lines ?? []) {
        const parent = one(d.parent);
        /* LEAK GUARD (PRE-SHIP): DRAFT and LOADED have not shipped —
           shared/do-shipped-states.ts doCountsAsDelivered is the one home. */
        if (!parent || !doCountsAsDelivered(parent.status)) continue;
        doLineToSoItem.set(d.id, l.id);
        deliveredBySoItem.set(l.id, (deliveredBySoItem.get(l.id) ?? 0) + Number(d.qty ?? 0));
      }
    }
    // The linked DO lines' returns can be read now, beside the unlinked attribution.
    linkedDoLineIds = new Set(doLineToSoItem.keys());
    returnsProm = eager(readReturnLines(sb, [...linkedDoLineIds]));
    for (const a of attributeUnlinkedDoLines(coverageLines, deliveredBySoItem, (await unlinkedProm)())) {
      doLineToSoItem.set(a.doLineId, a.soItemId);
      deliveredBySoItem.set(a.soItemId, (deliveredBySoItem.get(a.soItemId) ?? 0) + a.qty);
    }
  } else {
    ({ deliveredBySoItem, doLineToSoItem } = await netDeliveredBySoItem(sb, soDocNos, coverageLines));
  }

  const heads = (await headsProm)();
  if (heads.error) readFailed('order header', heads.error);
  for (const h of heads.data) {
    headerDebtor.set(h.doc_no, { code: h.debtor_code ?? null, name: h.debtor_name ?? null });
  }

  // 3. Σ returned — DR lines whose do_item_id traces (via the active DO line)
  //    back to one of our SO items, and whose parent DR is NOT cancelled.
  //    The non-cancelled decision stays in JS (.toUpperCase()), and an orphan
  //    DR line (no parent) is excluded.
  const returnedBySoItem = new Map<string, number>();
  let drLines: ReturnLine[];
  if (returnsProm) {
    /* The linked lines' returns were started above; only the DO lines the
       unlinked attribution added are left to read. Disjoint id sets (a linked
       DO line has an so_item_id, an unlinked one has none), so the union is
       exactly the one read over every key of doLineToSoItem. */
    const restProm = eager(readReturnLines(sb, [...doLineToSoItem.keys()].filter((id) => !linkedDoLineIds.has(id))));
    drLines = [...(await returnsProm)(), ...(await restProm)()];
  } else {
    drLines = await readReturnLines(sb, [...doLineToSoItem.keys()]);
  }
  for (const l of drLines) {
    const parent = one(l.parent);
    if (!l.do_item_id || !parent) continue;
    if ((parent.status ?? '').toUpperCase() === 'CANCELLED') continue;
    const soItemId = doLineToSoItem.get(l.do_item_id);
    if (!soItemId) continue;
    returnedBySoItem.set(soItemId, (returnedBySoItem.get(soItemId) ?? 0) + Number(l.qty_returned ?? 0));
  }

  // 4. Assemble per-line descriptors with the live remaining. lineSeq counts
  //    per SO so the picker / DO create can keep each SO's listing order.
  const seqByDoc = new Map<string, number>();
  for (const l of lines) {
    const qty = Number(l.qty ?? 0);
    const delivered = deliveredBySoItem.get(l.id) ?? 0;
    const returned = returnedBySoItem.get(l.id) ?? 0;
    const lineSeq = seqByDoc.get(l.doc_no) ?? 0;
    seqByDoc.set(l.doc_no, lineSeq + 1);
    out.set(l.id, {
      soItemId: l.id,
      docNo: l.doc_no,
      /* Header first (see the drift note above); the line copy only fills in for
         an SO whose header row could not be read. */
      debtorCode: headerDebtor.get(l.doc_no)?.code ?? (l.debtor_code as string | null) ?? null,
      debtorName: headerDebtor.get(l.doc_no)?.name ?? (l.debtor_name as string | null) ?? null,
      itemCode: l.item_code as string,
      itemGroup: (l.item_group as string | null) ?? null,
      description: (l.description as string | null) ?? null,
      description2: (l.description2 as string | null) ?? null,
      uom: (l.uom as string | null) ?? null,
      qty,
      unitPriceSen: Number(l.unit_price_sen ?? 0),
      unitCostSen: Number(l.unit_cost_sen ?? 0),
      discountSen: Number(l.discount_sen ?? 0),
      variants: l.variants ?? null,
      /* Migration 0058 — carry the dedicated variant-breakdown columns onto the
         deliverable descriptor (supabase-js snake_case; dual-read stays safe). */
      gapInches: (l.gapInches ?? l.gap_inches ?? null) as number | null,
      divanHeightInches: (l.divanHeightInches ?? l.divan_height_inches ?? null) as number | null,
      divanPriceSen: Number(l.divanPriceSen ?? l.divan_price_sen ?? 0),
      legHeightInches: (l.legHeightInches ?? l.leg_height_inches ?? null) as number | null,
      legPriceSen: Number(l.legPriceSen ?? l.leg_price_sen ?? 0),
      customSpecials: l.customSpecials ?? l.custom_specials ?? null,
      lineSuffix: (l.lineSuffix ?? l.line_suffix ?? null) as string | null,
      specialOrderPriceSen: Number(l.specialOrderPriceSen ?? l.special_order_price_sen ?? 0),
      delivered,
      returned,
      remaining: qty - delivered + returned,
      lineSeq,
    });
  }
  return out;
}
