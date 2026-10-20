// ----------------------------------------------------------------------------
// fair-transfer — move orders to the project they belong to, by hand, one or
// many at once (owner 2026-10-20: 「做成 manual bulk transfer 去对的 project，单上
// 的资料也要改」; 「在每个 project … 也要支持一键按钮转」).
//
// What moves with the fair (「单上的资料也要改」):
//   Fair      project_id → the target; fair_match PICKED.
//   Venue     the target fair's venue; venue_source PMS.
//   Fair Day  the day the target's evening report gives for the order's
//             booklet when it falls inside the fair; else the order's own Fair
//             Day when that does; else cleared — a day of another fair is wrong.
// One History row per order (fair-audit.ts, source `transfer`), naming the
// report when it was the evidence.
//
// Finance or PMS only — the route checks canReassignFair, as the settle screen
// does. Nothing here runs by itself: every move is a person's (「不要先，我要去
// 检查」).
// ----------------------------------------------------------------------------

import { loadLiveFairsByIds, type FairDb } from './fair-binding';
import { periodContains, type FairProjectRow } from './fair-options';
import { fairStateOf, recordFairChange } from './fair-audit';
import { chunkIn } from './paginate-all';
import { loadReportEvidence, sightingsOf } from '../../routes/lib/sales-report-evidence';

/** Most orders one request may move. */
export const FAIR_TRANSFER_MAX = 200;

export type FairTransferItem = { docNo: string; projectId: number };

export type FairTransferResult =
  | { docNo: string; ok: true; projectId: number; venue: string; fairDate: string | null }
  | { docNo: string; ok: false; reason: 'not_found' | 'cancelled' | 'fair_not_open' | 'already_there' | 'update_failed' };

/** The items of a request body, or null when it is not a usable list. One move
 *  per order: a repeated order keeps its first target. */
export function fairTransferItemsOf(body: unknown): FairTransferItem[] | null {
  const raw = (body && typeof body === 'object' ? (body as { items?: unknown }).items : null);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > FAIR_TRANSFER_MAX) return null;
  const out: FairTransferItem[] = [];
  const seen = new Set<string>();
  for (const it of raw as Array<Record<string, unknown> | null>) {
    const docNo = typeof it?.docNo === 'string' ? it.docNo.trim() : '';
    const projectId = Number(it?.projectId);
    if (!docNo || !Number.isInteger(projectId) || projectId <= 0) return null;
    if (seen.has(docNo)) continue;
    seen.add(docNo);
    out.push({ docNo, projectId });
  }
  return out;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The Fair Day an order takes at its new fair: the report's day, else its own,
 *  whichever is a day of that fair; else none. */
export function transferFairDay(
  fair: Pick<FairProjectRow, 'startDate' | 'endDate'>,
  reportDay: string | null,
  currentDay: string | null,
): string | null {
  for (const d of [reportDay, currentDay]) {
    const day = String(d ?? '').slice(0, 10);
    if (ISO_DAY.test(day) && periodContains(fair, day)) return day;
  }
  return null;
}

type OrderRow = {
  doc_no: string;
  project_id: number | string | null;
  fair_match: string | null;
  venue: string | null;
  fair_date: string | null;
  customer_so_no: string | null;
  ref: string | null;
  status: string | null;
};

const day = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).slice(0, 10);
  return ISO_DAY.test(s) ? s : null;
};

/**
 * Move each order to its target project. Per-order results: one that cannot
 * move says why and the others still move. Throws only when the orders or the
 * projects cannot be read at all.
 */
export async function transferOrdersToFairs(args: {
  sb: any;
  db: FairDb;
  companySql: string;
  /** The active company — every read and write here is held to it. */
  companyId: number;
  items: readonly FairTransferItem[];
  actorId: string | null;
  actorName: string | null;
}): Promise<FairTransferResult[]> {
  const { sb, db, companySql, companyId, items } = args;
  const targets = await loadLiveFairsByIds(db, companySql, items.map((i) => i.projectId));
  /* The targets' own reports, for the Fair Day. A chat that cannot be read
     costs only that: the move still happens, with the order's own day. */
  const evidence = await loadReportEvidence(db, companySql, { projectIds: [...targets.keys()] }).catch(() => new Map());
  const read = await chunkIn<OrderRow>(items.map((i) => i.docNo), (batch, from, to) =>
    sb.from('mfg_sales_orders')
      .select('doc_no, project_id, fair_match, venue, fair_date, customer_so_no, ref, status')
      .in('doc_no', batch)
      .eq('company_id', companyId)
      .range(from, to));
  if (read.error) throw new Error('order_read_failed');
  const orders = new Map(read.data.map((o) => [o.doc_no, o] as const));

  const out: FairTransferResult[] = [];
  for (const it of items) {
    const o = orders.get(it.docNo);
    const fair = targets.get(it.projectId);
    if (!o) { out.push({ docNo: it.docNo, ok: false, reason: 'not_found' }); continue; }
    if (o.status === 'CANCELLED') { out.push({ docNo: it.docNo, ok: false, reason: 'cancelled' }); continue; }
    if (!fair) { out.push({ docNo: it.docNo, ok: false, reason: 'fair_not_open' }); continue; }
    if (o.project_id != null && Number(o.project_id) === it.projectId) {
      out.push({ docNo: it.docNo, ok: false, reason: 'already_there' });
      continue;
    }
    const reported = sightingsOf(o, evidence).find((s) => s.projectId === it.projectId) ?? null;
    /* The order as it stood, taken before the write: History says what it was. */
    const before = { state: fairStateOf(o), venue: o.venue ?? null, fairDay: day(o.fair_date) };
    const fairDate = transferFairDay(fair, reported?.reportDate ?? null, before.fairDay);
    const venue = (fair.venue ?? '').trim();
    const { error } = await sb.from('mfg_sales_orders')
      .update({ project_id: it.projectId, fair_match: 'PICKED', venue, venue_source: 'PMS', fair_date: fairDate })
      .eq('doc_no', it.docNo)
      .eq('company_id', companyId);
    if (error) { out.push({ docNo: it.docNo, ok: false, reason: 'update_failed' }); continue; }
    const name = fair.name ?? `event #${it.projectId}`;
    await recordFairChange({
      sb, db, companySql, docNo: it.docNo,
      before: before.state,
      after: { projectId: it.projectId, fairMatch: 'PICKED' },
      how: 'transfer', actorId: args.actorId, actorName: args.actorName,
      note: reported
        ? `Moved to ${name}: its evening sales report lists this order${reported.reportDate ? ` on ${reported.reportDate}` : ''}.`
        : `Moved to ${name} by hand.`,
      also: [
        { field: 'venue', from: before.venue, to: venue },
        { field: 'fairDate', from: before.fairDay, to: fairDate },
      ],
    });
    out.push({ docNo: it.docNo, ok: true, projectId: it.projectId, venue, fairDate });
  }
  return out;
}
