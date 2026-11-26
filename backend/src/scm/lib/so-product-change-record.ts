/* The record of every product change on a sales order: scm.so_product_changes,
   written when the change is saved or approved (owner 2026-11-23). The rules of
   one event are so-product-change.ts; this file keeps the rows.

   One row is one WINDOW of changes to one order:
     DIRECT     the direct edits of one Malaysia day (window_key = the day). A
                Save sends one request per line, deletes and edits in parallel,
                so the day is the event, as the 2026-11-23 analysis counted it;
     AMENDMENT  one submission (window_key = its first amendment's id). A
                product change whose price moved too is split at submit into a
                LINES half and a PRICE half signed on separate desks; both halves
                land in one event, or the product half would read "selling
                unchanged" and the price half would not be a product change.
   The window's first write stores the product lines as they were (before_lines);
   every write after recomputes the event against the lines as they are now. A
   window with no product change, or one that moved neither selling nor cost,
   keeps bucket NULL and is not an event: the reports read bucket IS NOT NULL.

   Only after the order's opening day (Malaysia), and never on a DRAFT or a
   CANCELLED order. Best effort: a failed read or write is logged and the edit
   stands, as with the SO audit and so_total_changes. */

import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../env';
import { activeCompanyId, scopeToCompanyId, type CompanyScopeCtx } from './companyScope';
import { mytDateOf, todayMyt } from './my-time';
import { catalogCategoriesByCode } from './validate-item-codes';
import { changeSnapshot, productChangeEvent, type ChangeLineSnap, type SoLineForChange } from './so-product-change';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped at every call site in this tree.
type Sb = any;

export type ChangeRoute = 'DIRECT' | 'AMENDMENT';

export interface ChangeWindow {
  companyId: number;
  docNo: string;
  route: ChangeRoute;
  windowKey: string;
}

/** What the record needs to know of the order. */
export interface OrderDays {
  openingDay: string;
  orderDay: string;
  status: string;
}

const log = (what: string, docNo: string, e: unknown) => {
  /* eslint-disable-next-line no-console */
  console.error(`[so-product-change] ${what}:`, docNo, e instanceof Error ? e.message : (e as { message?: string } | null)?.message ?? e);
};

export async function readOrderDays(sb: Sb, companyId: number, docNo: string): Promise<OrderDays | null> {
  const { data, error } = await scopeToCompanyId(
    sb.from('mfg_sales_orders').select('created_at, so_date, status').eq('doc_no', docNo),
    companyId,
  ).maybeSingle();
  if (error || !data) return null;
  const row = data as { created_at?: string | null; so_date?: string | null; status?: string | null };
  if (!row.created_at) return null;
  const openingDay = mytDateOf(row.created_at);
  const orderDay = row.so_date && /^\d{4}-\d{2}-\d{2}/.test(row.so_date) ? row.so_date.slice(0, 10) : openingDay;
  return { openingDay, orderDay, status: String(row.status ?? '') };
}

/** Rule 2 applies to a change made after the order's opening day, on a live order. */
export function isLaterChange(days: OrderDays | null, changeDay: string): days is OrderDays {
  if (!days) return false;
  if (days.status === 'DRAFT' || days.status === 'CANCELLED') return false;
  return changeDay > days.openingDay;
}

/** The order's live product lines now, or null when a read failed. */
export async function readChangeSnapshot(sb: Sb, companyId: number, docNo: string): Promise<ChangeLineSnap[] | null> {
  const { data, error } = await scopeToCompanyId(
    sb.from('mfg_sales_order_items')
      .select('id, item_code, item_group, variants, qty, total_sen, line_cost_sen, cancelled')
      .eq('doc_no', docNo),
    companyId,
  );
  if (error) return null;
  const rows = (data ?? []) as SoLineForChange[];
  const categories = await catalogCategoriesByCode(sb, rows.map((r) => r.item_code), companyId);
  if (!categories) return null;
  return changeSnapshot(rows, (code) => categories.get(code) ?? null);
}

const sums = (snap: readonly ChangeLineSnap[]) => ({
  selling: snap.reduce((s, l) => s + l.sellingSen, 0),
  cost: snap.reduce((s, l) => s + l.costSen, 0),
});

/** Opens the window: the first write stores the product lines as they are,
 *  before it changes them. Two writes in parallel race to insert; the first
 *  insert wins, and its snapshot was read before any write of the window landed
 *  (each request snapshots BEFORE it writes). Returns the row id, or null. */
export async function openChangeWindow(sb: Sb, w: ChangeWindow, changeDay: string): Promise<string | null> {
  const found = await findWindow(sb, w);
  if (found === undefined) return null;
  if (found) return found;
  const snap = await readChangeSnapshot(sb, w.companyId, w.docNo);
  if (!snap) { log('baseline read failed', w.docNo, null); return null; }
  const t = sums(snap);
  const { error } = await sb.from('so_product_changes').upsert({
    company_id: w.companyId,
    so_doc_no: w.docNo,
    route: w.route,
    window_key: w.windowKey,
    change_day: changeDay,
    before_lines: snap,
    selling_before_sen: t.selling,
    selling_after_sen: t.selling,
    cost_before_sen: t.cost,
    cost_after_sen: t.cost,
  }, { onConflict: 'company_id,so_doc_no,route,window_key', ignoreDuplicates: true });
  if (error) {
    if (sb?.__atomicCommand === true) throw new Error(`product change not recorded: ${error.message}`);
    log('baseline write failed', w.docNo, error);
    return null;
  }
  return (await findWindow(sb, w)) ?? null;
}

async function findWindow(sb: Sb, w: ChangeWindow): Promise<string | null | undefined> {
  const { data, error } = await scopeToCompanyId(
    sb.from('so_product_changes').select('id')
      .eq('so_doc_no', w.docNo).eq('route', w.route).eq('window_key', w.windowKey),
    w.companyId,
  ).maybeSingle();
  if (error) { log('window read failed', w.docNo, error); return undefined; }
  return (data as { id?: string } | null)?.id ?? null;
}

type WindowRow = {
  before_lines: ChangeLineSnap[] | null;
  change_types: string[] | null;
  changed_by: string[] | null;
  approved_by: string[] | null;
  amendment_nos: string[] | null;
};

const withName = (list: string[] | null, name: string | null | undefined): string[] => {
  const out = [...(list ?? [])];
  const n = (name ?? '').trim();
  if (n && !out.includes(n)) out.push(n);
  return out;
};

/** Recomputes the window's event from its stored before-lines and the lines
 *  now, and writes it. Lines saved in parallel can land between the read and
 *  the write, so it reads again after writing and repeats until the lines
 *  stand still: the last request to finish writes the final state. */
export async function closeChangeWindow(sb: Sb, w: ChangeWindow, id: string, who: {
  changedBy: string | null;
  approvedBy?: string | null;
  amendmentNo?: string | null;
  changeDay: string;
}): Promise<void> {
  const { data, error } = await scopeToCompanyId(
    sb.from('so_product_changes').select('before_lines, change_types, changed_by, approved_by, amendment_nos').eq('id', id),
    w.companyId,
  ).maybeSingle();
  if (error || !data) { log('window reread failed', w.docNo, error); return; }
  const row = data as WindowRow;
  const before = row.before_lines ?? [];
  let after = await readChangeSnapshot(sb, w.companyId, w.docNo);
  for (let pass = 0; after && pass < 3; pass += 1) {
    const ev = productChangeEvent(before, after);
    const hadTypes = (row.change_types ?? []).length > 0;
    const patch: Record<string, unknown> = {
      change_types: ev.types,
      bucket: ev.bucket,
      selling_before_sen: ev.sellingBeforeSen,
      selling_after_sen: ev.sellingAfterSen,
      cost_before_sen: ev.costBeforeSen,
      cost_after_sen: ev.costAfterSen,
      lines: ev.lines,
      changed_by: withName(row.changed_by, who.changedBy),
      approved_by: withName(row.approved_by, who.approvedBy),
      amendment_nos: withName(row.amendment_nos, who.amendmentNo),
      changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...(w.route === 'AMENDMENT' && !hadTypes ? { change_day: who.changeDay } : {}),
    };
    const { error: upErr } = await scopeToCompanyId(sb.from('so_product_changes').update(patch).eq('id', id), w.companyId);
    if (upErr) {
      if (sb?.__atomicCommand === true) throw new Error(`product change not recorded: ${upErr.message}`);
      log('event write failed', w.docNo, upErr);
      return;
    }
    const again = await readChangeSnapshot(sb, w.companyId, w.docNo);
    if (!again || JSON.stringify(again) === JSON.stringify(after)) return;
    after = again;
  }
  if (!after) log('lines read failed', w.docNo, null);
}

/** An amendment as the record finds its submission. */
export interface SubmittedAmendment {
  id: string;
  so_doc_no: string;
  requested_by?: string | null;
  reason?: string | null;
  created_at?: string | null;
}

/** The submission an amendment came in: its halves (split by lane at submit)
 *  share the order, the requester and the reason, and were written in the same
 *  second. The first half's id names the submission, so both halves land in one
 *  record. */
export async function amendmentSubmissionKey(sb: Sb, a: SubmittedAmendment): Promise<string> {
  if (!a.created_at || !a.requested_by) return a.id;
  const at = new Date(a.created_at).getTime();
  if (!Number.isFinite(at)) return a.id;
  const { data, error } = await sb.from('so_amendments')
    .select('id, created_at, reason')
    .eq('so_doc_no', a.so_doc_no).eq('requested_by', a.requested_by)
    .gte('created_at', new Date(at - 5000).toISOString()).lte('created_at', new Date(at + 5000).toISOString());
  if (error || !Array.isArray(data)) return a.id;
  const halves = (data as Array<{ id: string; created_at: string; reason: string | null }>)
    .filter((r) => (r.reason ?? '') === (a.reason ?? ''))
    .sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id < y.id ? -1 : 1));
  return halves[0]?.id ?? a.id;
}

/** The direct-edit half. A line route calls openDirectChangeWindow right
 *  before its first line write (after its own checks: a refused request never
 *  reaches the database for this), and this middleware, wrapping the line routes,
 *  records the event once the route answered 2xx. Never blocks the edit. */
export function productChangeWindow(): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    await next();
    const opened = openedByRequest.get(c.req.raw);
    if (!opened?.id || c.res.status >= 300) return;
    try {
      await closeChangeWindow(c.get('supabase') as Sb, opened.w, opened.id, {
        changedBy: c.get('houzsUser')?.name ?? null,
        changeDay: opened.day,
      });
    } catch (e) {
      log('window close failed', opened.w.docNo, e);
    }
  };
}

type Opened = { w: ChangeWindow; id: string | null; day: string; days: OrderDays | null };
const openedByRequest = new WeakMap<Request, Opened>();

/** Opens today's direct-edit window for this order, once per request, and
 *  answers whether this edit is a rule-2 change: the order's days when it is
 *  (after the opening day, on a live order), else null. A failed read is not a
 *  rule-2 change and records nothing; the edit goes on as before the rule. */
export async function openDirectChangeWindow(
  c: CompanyScopeCtx & { req: { raw: Request } },
  sb: Sb,
  docNo: string,
): Promise<OrderDays | null> {
  const known = openedByRequest.get(c.req.raw);
  if (known) return known.days;
  const companyId = activeCompanyId(c);
  const day = todayMyt();
  const opened: Opened = { w: { companyId: companyId ?? 0, docNo, route: 'DIRECT', windowKey: day }, id: null, day, days: null };
  openedByRequest.set(c.req.raw, opened);
  if (companyId == null) return null;
  try {
    const days = await readOrderDays(sb, companyId, docNo);
    if (!isLaterChange(days, day)) return null;
    opened.days = days;
    opened.id = await openChangeWindow(sb, opened.w, day);
  } catch (e) {
    log('window open failed', docNo, e);
  }
  return opened.days;
}
