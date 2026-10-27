// ----------------------------------------------------------------------------
// mrp-delivered — Σ delivered per open SO line for the MRP engine, from the DO
// lines embedded in MRP's own demand read.
//
// HC-0002 (2026-10-23). computeMrp subtracts each open SO line's delivered qty
// from demand (gross of returns — a returned unit is not demand again). It got
// that number from soDeliverableRemaining, called in batches of 200 orders over
// every open order (~2,800 in prod): each batch re-read the SO lines MRP had
// just read, their headers, the linked DO lines, the DO headers by so_doc_no,
// the unlinked DO lines and the return lines — ~70 of the engine's ~90 round
// trips, for one number per line. MRP uses neither the returns nor the header
// debtor that soDeliverableRemaining also builds.
//
// The same number, read the way the Inventory page has read it since #4891:
//   · LINKED — the demand read embeds each SO line's DO lines with their DO
//     status (MRP_DELIVERED_EMBED); a DO counts through doCountsAsDelivered,
//     exactly as netDeliveredBySoItem's linked sum does.
//   · UNLINKED — a DO line whose so_item_id the FK blanked but whose DO header
//     still names the order (lib/do-unlinked-coverage.ts). ONE paged read of the
//     company's `so_item_id IS NULL` DO lines with their header embedded, kept
//     when the header names one of the open orders and has shipped, then spread
//     by attributeUnlinkedDoLines over the order's lines in soDeliverableRemaining's
//     listing order (soListingOrder) — the order that decides which line of a
//     repeated SKU fills first.
//
// computeMrp falls back to the batched soDeliverableRemaining path when the
// embedded demand read fails, and `?nettingCheck=1` on GET /mrp runs both on
// the same demand rows and reports any line where they differ.
// ----------------------------------------------------------------------------

import { doCountsAsDelivered } from '../shared/do-shipped-states';
import { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank, type RawSoDisplayLine } from '../shared/so-line-display';
import { attributeUnlinkedDoLines, type CoverageSoLine, type UnlinkedDoLine } from './do-unlinked-coverage';
import { paginateAll } from './paginate-all';

export const MRP_DELIVERED_EMBED = 'do_lines:delivery_order_items(qty, delivery_order:delivery_orders(status))';

type One<T> = T | T[] | null | undefined;
const one = <T>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export type MrpDemandLine = {
  id: string;
  doc_no: string;
  item_code: string | null;
  item_group: string | null;
  variants: unknown;
  qty: number | null;
  line_no: number | null;
  created_at: string | null;
  do_lines?: Array<{ qty: number | null; delivery_order: One<{ status: string | null }> }> | null;
};

/** soDeliverableRemaining's line order: its read's `line_no ASC NULLS LAST,
 *  created_at, id`, then per order the group-rank sort and the sofa build walk. */
export function soListingOrder<T extends MrpDemandLine>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.line_no !== b.line_no) {
      if (a.line_no == null) return 1;
      if (b.line_no == null) return -1;
      return a.line_no - b.line_no;
    }
    const ac = a.created_at ?? '';
    const bc = b.created_at ?? '';
    if (ac !== bc) return ac < bc ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const byDoc = new Map<string, T[]>();
  for (const r of sorted) byDoc.set(r.doc_no, [...(byDoc.get(r.doc_no) ?? []), r]);
  return [...byDoc.values()].flatMap((docLines) =>
    orderSofaModuleRowsWithinBuilds(
      sortSoLinesByGroupRank(docLines as unknown as Array<T & RawSoDisplayLine>, (r) => r.item_group),
    ) as unknown as T[]);
}

/** Linked half: Σ qty of each line's embedded DO lines on a DO that has shipped. */
export function linkedDeliveredFromEmbedded(lines: MrpDemandLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    for (const d of l.do_lines ?? []) {
      const parent = one(d.delivery_order);
      if (!parent || !doCountsAsDelivered(parent.status)) continue;
      out.set(l.id, (out.get(l.id) ?? 0) + Number(d.qty ?? 0));
    }
  }
  return out;
}

type UnlinkedRow = { id: string; item_code: string | null; qty: number | null; delivery_order: One<{ so_doc_no: string | null; status: string | null }> };

/** The shipped `so_item_id IS NULL` DO lines whose header names one of `docNos`.
 *  Degrades to [] on a read failure, loudly, as loadUnlinkedDoCoverage does. */
export async function readUnlinkedDoLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped SCM client every engine passes around
  sb: any,
  scoped: <Q>(q: Q) => Q,
  docNos: ReadonlySet<string>,
): Promise<UnlinkedDoLine[]> {
  let res: { data: UnlinkedRow[] | null; error: unknown };
  try {
    res = await paginateAll<UnlinkedRow>((from, to) => scoped(sb
      .from('delivery_order_items')
      .select('id, item_code, qty, delivery_order:delivery_orders(so_doc_no, status)')
      .is('so_item_id', null))
      .order('id')
      .range(from, to));
  } catch (e) {
    res = { data: null, error: e };
  }
  if (res.error || !res.data) {
    // eslint-disable-next-line no-console
    console.error('[mrp-delivered] unlinked DO line read failed; falling back to link-only coverage:', res.error);
    return [];
  }
  const out: UnlinkedDoLine[] = [];
  for (const r of res.data) {
    const h = one(r.delivery_order);
    if (!h?.so_doc_no || !docNos.has(h.so_doc_no) || !doCountsAsDelivered(h.status)) continue;
    out.push({ id: r.id, docNo: h.so_doc_no, itemCode: r.item_code, qty: Number(r.qty ?? 0) });
  }
  return out;
}

/** PURE. Linked + unlinked delivered per SO line of `docNos`, from the embedded demand rows. */
export function deliveredBySoItemFrom(
  demandRows: MrpDemandLine[],
  docNos: ReadonlySet<string>,
  unlinked: UnlinkedDoLine[],
): Map<string, number> {
  const rows = demandRows.filter((r) => docNos.has(r.doc_no));
  const delivered = linkedDeliveredFromEmbedded(rows);
  const soLines: CoverageSoLine[] = soListingOrder(rows).map((l) => ({ id: l.id, docNo: l.doc_no, itemCode: l.item_code, qty: Number(l.qty ?? 0) }));
  for (const a of attributeUnlinkedDoLines(soLines, delivered, unlinked)) {
    delivered.set(a.soItemId, (delivered.get(a.soItemId) ?? 0) + a.qty);
  }
  return delivered;
}

export type NettingCheck = {
  lines: number;
  mismatched: number;
  mismatches: Array<{ soItemId: string; docNo: string; itemCode: string | null; batched: number; embedded: number }>;
};

/** Every line where the two readings differ (first 50 listed). */
export function compareDelivered(
  lines: Array<{ id: string; doc_no: string; item_code: string | null }>,
  batched: (id: string) => number,
  embedded: (id: string) => number,
): NettingCheck {
  const mismatches: NettingCheck['mismatches'] = [];
  let mismatched = 0;
  for (const l of lines) {
    const a = batched(l.id);
    const b = embedded(l.id);
    if (a === b) continue;
    mismatched += 1;
    if (mismatches.length < 50) mismatches.push({ soItemId: l.id, docNo: l.doc_no, itemCode: l.item_code, batched: a, embedded: b });
  }
  return { lines: lines.length, mismatched, mismatches };
}
