// do-shipped-from-retry — the nightly pass that locks DO lines left open.
//
// Owner decision 2026-11-10: a line whose rack or PO is not known for its full
// qty is NOT locked at the ship; it stays open "so it can be filled later, once
// the GRN gets its rack", tried at the ship and again every night. This is the
// nightly half: for each company, the confirmed, non-cancelled DOs of the last
// RETRY_DAYS with an unstamped goods line, re-run through stampDoShippedFrom
// (the same planner and lock gate as the ship). A line still incomplete stays
// open; a stamped line is never selected and never written (the UPDATE matches
// only a NULL column, and the DB trigger refuses changing a set stamp).
//
// Bounded: at most RETRY_DO_LIMIT DOs per company per night, rotated by day so
// a backlog of lines that never complete cannot starve the rest. Idempotent: a
// re-run only locks what has become complete since.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { isServiceLine } from '../shared';
import { DO_SHIPPED_STATES } from '../shared/do-shipped-states';
import { scopeToCompanyId } from './companyScope';
import { stampDoShippedFrom } from './do-shipped-from-stamp';

export const RETRY_DAYS = 180;
export const RETRY_DO_LIMIT = 15;
const PAGE = 1000;
const MAX_PAGES = 5;

export type DoStampRetryResult = { companyId: number; open_dos: number; tried: number; written: number; error: string | null };

/** The DOs (ids, stable order) of one company with an unstamped goods line. Throws on a read error. */
export async function listDosWithOpenLines(sb: any, companyId: number, since: string): Promise<string[]> {
  const ids = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await scopeToCompanyId(
      sb.from('delivery_order_items')
        .select('delivery_order_id, item_code, item_group, d:delivery_orders!inner(created_at)'),
      companyId)
      .is('shipped_from', null)
      .gt('qty', 0)
      .in('d.status', [...DO_SHIPPED_STATES])
      .eq('d.migrated_no_stock', false)
      .eq('d.company_id', companyId)
      .gte('d.created_at', since)
      .order('delivery_order_id')
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`delivery_order_items: ${error.message}`);
    const rows = (data ?? []) as Array<{ delivery_order_id: string; item_code: string | null; item_group: string | null }>;
    for (const r of rows) {
      if (!isServiceLine({ itemGroup: r.item_group, itemCode: r.item_code ?? '' })) ids.add(r.delivery_order_id);
    }
    if (rows.length < PAGE) break;
  }
  return [...ids];
}

/** Tonight's window of `ids`: RETRY_DO_LIMIT long, starting further on each day. PURE. */
export function rotateWindow<T>(ids: T[], limit: number, dayNo: number): T[] {
  if (ids.length <= limit) return ids;
  const start = (dayNo * limit) % ids.length;
  return [...ids.slice(start), ...ids.slice(0, start)].slice(0, limit);
}

/** One nightly pass over the given companies. A company's failure is reported
 *  in its row and never stops the next company. */
export async function retryOpenDoStamps(sb: any, companyIds: number[], now: Date): Promise<DoStampRetryResult[]> {
  const since = new Date(now.getTime() - RETRY_DAYS * 86_400_000).toISOString();
  const dayNo = Math.floor(now.getTime() / 86_400_000);
  const out: DoStampRetryResult[] = [];
  for (const companyId of companyIds) {
    try {
      const open = await listDosWithOpenLines(sb, companyId, since);
      const batch = rotateWindow(open, RETRY_DO_LIMIT, dayNo);
      let written = 0;
      for (const doId of batch) written += await stampDoShippedFrom(sb, doId, companyId);
      out.push({ companyId, open_dos: open.length, tried: batch.length, written, error: null });
    } catch (e) {
      out.push({ companyId, open_dos: 0, tried: 0, written: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
