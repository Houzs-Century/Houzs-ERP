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

function readFailed(what: string, error: { message: string }): void {
  // eslint-disable-next-line no-console
  console.error(`[so-deliverable-remaining] ${what} read failed; this answer may be short: ${error.message}`);
}

const CHUNK_WAVE = 6;
const RETURN_SCAN_MAX_PAGES = 10;

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
        return all.length >= count ? all : null;
      }
      after = rows[rows.length - 1]!.id;
    }
    return null;
  } catch {
    return null;
  }
}

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
  const { data, error } = await chunkIn<ReturnLine>(doLineIds, (batch, from, to) => sb.from('delivery_return_items').select(RETURN_SELECT).in('do_item_id', batch).order('id').range(from, to));
  if (error) readFailed('return-line', error);
  return data;
}

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

  const headsProm = eager(chunkIn<{ doc_no: string; debtor_code: string | null; debtor_name: string | null }>(docs, (batch, from, to) => sb.from('mfg_sales_orders').select('doc_no, debtor_code, debtor_name').in('doc_no', batch).order('doc_no').range(from, to)));
  const unlinkedProm = eager(readUnlinkedDoLinesUnder(sb, soDocNos));

  const readLines = (select: string) => chunkIn<SoLineRow>(docs, (batch, from, to) => sb.from('mfg_sales_order_items')
    .select(select)
    .in('doc_no', batch)
    .eq('cancelled', false)
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at')
    .order('id')
    .range(from, to));
  const embedded = await readLines(`${SO_LINE_SELECT}, ${SO_LINE_DO_LINES_EMBED}`);
  const embeddedOk = !embedded.error && embedded.data.every((r) => Array.isArray(r.do_lines) && r.do_lines.every(isEmbeddedDoLine));
  const plain = embeddedOk ? null : await readLines(SO_LINE_SELECT);
  if (plain?.error) readFailed('sales-order line', plain.error);
  const rawLines = plain ? plain.data : embedded.data;
  if (rawLines.length === 0) return out;

  const headerDebtor = new Map<string, { code: string | null; name: string | null }>();

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
        if (!parent || !doCountsAsDelivered(parent.status)) continue;
        doLineToSoItem.set(d.id, l.id);
        deliveredBySoItem.set(l.id, (deliveredBySoItem.get(l.id) ?? 0) + Number(d.qty ?? 0));
      }
    }
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

  const returnedBySoItem = new Map<string, number>();
  let drLines: ReturnLine[];
  if (returnsProm) {
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
