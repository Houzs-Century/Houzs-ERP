// ----------------------------------------------------------------------------
// acc/stock-close — month-end stock value into the ledger (GL redesign item 4).
//
// The owner's design (2026-09-05), his words setting each rule:
//   • ledger 只根据 invoice 认 — documents post purchases (item 2); stock value
//     enters the GL ONCE a month, from the live engine;
//   • 可以不可以抓实时的 — the close GRABS THE LIVE VALUE the night the month
//     ends (Dr STOCK / Cr STOCKS AT THE END), and the next month opens with
//     the automatic reversal — so every month's P&L reads purchases + opening
//     − closing = cost of goods sold, AutoCount's own arithmetic, monthly
//     instead of yearly;
//   • 如果他们迟进 GRN 呢 — the replay runs on movement_date (the BUSINESS
//     date: a GRN's received date), and a DAILY sweep re-checks recent months;
//     a late-keyed document changes the replayed value, the sweep sees the
//     difference and re-posts — reversal first, never a silent edit;
//   • 我有没有办法看到你每天检查的成果 — every run, including the quiet
//     "unchanged" ones, writes scm.acc_stock_close_runs.
//
// 2026-09-21, the owner's second round (closing stock 那边我要分三个东西;
// consignment 应该没有 cost; reversal 记到 600):
//   • the value is split into THREE BUCKETS by the warehouse the goods stand
//     in — customer / display / service (scm/lib/stock-bucket.ts: the
//     warehouse's own override, else its type) — and each bucket books on its
//     own child accounts: STOCK - CUSTOMER (330-0001) … STOCKS AT THE END -
//     CUSTOMER (620-0001) … (acc/rules.ts STOCK_BUCKET_ROLES);
//   • CONSIGNMENT goods — received on a Purchase Consignment note, the
//     supplier's until sold (isConsignmentLotSource, the ONE classifier the
//     Inventory page already uses) — are NOT ours and never enter the value;
//   • the next month's reversal opens on STOCKS AT THE BEGINNING (600-000x),
//     not back on the closing account, so opening and closing read as two
//     lines on the P&L the way AutoCount prints them.
//
// The month's two entries are BOTH posted by the close, immediately:
//   STOCKADJ-{co}-{YYYY-MM}      Dr STOCK-b V_b / Cr CLOSING-b V_b   (last day, per bucket)
//   STOCKADJ-REV-{co}-{YYYY-MM}  Dr OPENING-b V_b / Cr STOCK-b V_b   (1st of next, per bucket)
// A dated reversal is not a cancellation: both stay active, the month-end TB
// shows the stock, and the pair nets to zero from the next month on. Months
// are therefore INDEPENDENT — re-posting July never touches August. A month
// closed under the old one-account shape is re-posted the first time the
// sweep sees it: the lines it wants and the lines on file differ.
//
// Pure sb logic, engine-gated (postJournal / reverseJournal): the close can
// never mint a second entry for a month (idempotency key = the doc numbers)
// and never deletes — a wrong value is reversed and re-posted, on the record.
// ----------------------------------------------------------------------------

import { postJournal, reverseJournal } from './engine';
import { resolveRoles, STOCK_BUCKET_ROLES, type RuleLine } from './rules';
import { paginateAll } from '../scm/lib/paginate-all';
import { fmtSen } from '../scm/shared/format';
import { isConsignmentLotSource } from '../scm/lib/inventory-movements';
import { STOCK_BUCKETS, emptyBuckets, stockBucketOf, type StockBucket } from '../scm/lib/stock-bucket';

/** 'YYYY-MM' arithmetic without Date-object timezone traps. */
export function monthEdges(month: string): { ok: true; lastDay: string; nextFirst: string } | { ok: false } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return { ok: false };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return { ok: false };
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDate = new Date(Date.UTC(ny, nm - 1, 1) - 86_400_000);
  return {
    ok: true,
    lastDay: lastDate.toISOString().slice(0, 10),
    nextFirst: `${ny}-${pad(nm)}-01`,
  };
}

/** The month whose close the daily sweep owns right now (MYT clock): always
    LAST month — plus the one before, so a very late document still heals. */
export function sweepMonths(nowMs: number = Date.now()): string[] {
  const myt = new Date(nowMs + 8 * 3600_000);
  const y = myt.getUTCFullYear();
  const m = myt.getUTCMonth(); // 0-based, current month
  const pad = (n: number) => String(n).padStart(2, '0');
  const monthOf = (yy: number, mm0: number): string => {
    const d = new Date(Date.UTC(yy, mm0, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  };
  return [monthOf(y, m - 1), monthOf(y, m - 2)];
}

/* ── The replay ──────────────────────────────────────────────────────────── */

type MovementRow = {
  item_code?: string | null; warehouse_id?: string | null; movement_type?: string | null; qty?: number | null;
  total_cost_sen?: number | null; source_doc_type?: string | null; source_doc_no?: string | null;
};
const REPLAY_COLS = 'item_code, warehouse_id, movement_type, qty, total_cost_sen, source_doc_type, source_doc_no';

/**
 * Every OWNED movement up to END OF `date` (inclusive), on the BUSINESS date.
 * Rows written by a not-yet-redeployed worker in the minutes around the
 * migration carry NO movement_date and would silently fall out of the lte;
 * they count by their keyed time instead — the pre-item-4 meaning.
 * Consignment-sourced rows (the supplier's goods) are left out here, once,
 * for every reader.
 */
async function ownedMovementsAsOf(sb: any, companyId: number, date: string): Promise<{ ok: true; rows: MovementRow[] } | { ok: false; reason: string }> {
  const { data, error } = await paginateAll((from, to) => sb
    .from('inventory_movements')
    .select(REPLAY_COLS)
    .eq('company_id', companyId)
    .lte('movement_date', date)
    .range(from, to));
  if (error) return { ok: false, reason: (error as { message?: string }).message ?? String(error) };
  const { data: dateless, error: dlErr } = await sb
    .from('inventory_movements')
    .select(REPLAY_COLS)
    .eq('company_id', companyId)
    .is('movement_date', null)
    .lte('created_at', `${date}T23:59:59.999`);
  if (dlErr) return { ok: false, reason: dlErr.message };
  const rows = [...((data ?? []) as MovementRow[]), ...((dateless ?? []) as MovementRow[])]
    .filter((r) => !isConsignmentLotSource(r.source_doc_type, r.source_doc_no));
  return { ok: true, rows };
}

/** Signs: IN adds, OUT subtracts, ADJUSTMENT follows its own qty sign
    (write-offs negative). AC_CUTOVER — the migrated opening — is an
    ADJUSTMENT like any other. */
export const signedCost = (r: MovementRow): number => {
  const cost = Math.abs(Number(r.total_cost_sen ?? 0));
  const type = String(r.movement_type);
  if (type === 'IN') return cost;
  if (type === 'OUT') return -cost;
  return Number(r.qty ?? 0) >= 0 ? cost : -cost;
};

/** The bucket each of the company's warehouses files under. */
export async function bucketByWarehouse(sb: any, companyId: number): Promise<{ ok: true; of: (warehouseId: unknown) => StockBucket } | { ok: false; reason: string }> {
  const { data, error } = await sb
    .from('warehouses')
    .select('id, type, stock_bucket')
    .eq('company_id', companyId);
  if (error) return { ok: false, reason: (error as { message?: string }).message ?? String(error) };
  const map = new Map<string, StockBucket>();
  for (const w of (data ?? []) as Array<{ id: string; type?: string | null; stock_bucket?: string | null }>) map.set(String(w.id), stockBucketOf(w));
  return { ok: true, of: (id) => map.get(String(id ?? '')) ?? 'customer' };
}

/**
 * The stock value as of END OF `date` per bucket — the owner's three closing
 * stocks — and in total. Owned goods only.
 */
export async function stockValueByBucketAsOf(
  sb: any,
  companyId: number,
  date: string,
): Promise<{ ok: true; buckets: Record<StockBucket, number>; totalSen: number } | { ok: false; reason: string }> {
  const moves = await ownedMovementsAsOf(sb, companyId, date);
  if (!moves.ok) return moves;
  const wh = await bucketByWarehouse(sb, companyId);
  if (!wh.ok) return wh;
  const buckets = emptyBuckets();
  for (const r of moves.rows) buckets[wh.of(r.warehouse_id)] += signedCost(r);
  return { ok: true, buckets, totalSen: STOCK_BUCKETS.reduce((s, b) => s + buckets[b], 0) };
}

/* ── The replay, preloaded once and folded per date (the Dashboard) ───────── */

export type OwnedMovement = MovementRow & { movement_date?: string | null; created_at?: string | null };
/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Sb = Parameters<typeof resolveRoles>[0];

/**
 * Every OWNED movement up to END OF `date`, with its dates, so a caller that
 * reads many dates at once (the Dashboard's periods) folds them in memory
 * instead of replaying the table once per date. Same rows, same consignment
 * exclusion, same dateless fallback as ownedMovementsAsOf.
 */
export async function loadOwnedMovementsUpTo(sb: Sb, companyId: number, date: string): Promise<{ ok: true; rows: OwnedMovement[] } | { ok: false; reason: string }> {
  const cols = `${REPLAY_COLS}, movement_date, created_at`;
  const { data, error } = await paginateAll((from, to) => sb
    .from('inventory_movements')
    .select(cols)
    .eq('company_id', companyId)
    .lte('movement_date', date)
    .range(from, to));
  if (error) return { ok: false, reason: (error as { message?: string }).message ?? String(error) };
  const { data: dateless, error: dlErr } = await sb
    .from('inventory_movements')
    .select(cols)
    .eq('company_id', companyId)
    .is('movement_date', null)
    .lte('created_at', `${date}T23:59:59.999`);
  if (dlErr) return { ok: false, reason: dlErr.message };
  const rows = [...((data ?? []) as OwnedMovement[]), ...((dateless ?? []) as OwnedMovement[])]
    .filter((r) => !isConsignmentLotSource(r.source_doc_type, r.source_doc_no));
  return { ok: true, rows };
}

/** Whether a preloaded movement counts as of END OF `date` — by its business
    date, else by its keyed time (the pre-item-4 meaning), the lte's own rule. */
export const movementCountsAsOf = (r: OwnedMovement, date: string): boolean =>
  r.movement_date != null && r.movement_date !== ''
    ? String(r.movement_date).slice(0, 10) <= date
    : String(r.created_at ?? '') <= `${date}T23:59:59.999`;

/** stockValueByBucketAsOf, over preloaded rows. */
export function foldStockByBucket(rows: OwnedMovement[], of: (warehouseId: unknown) => StockBucket, date: string): { buckets: Record<StockBucket, number>; totalSen: number } {
  const buckets = emptyBuckets();
  for (const r of rows) if (movementCountsAsOf(r, date)) buckets[of(r.warehouse_id)] += signedCost(r);
  return { buckets, totalSen: STOCK_BUCKETS.reduce((s, b) => s + buckets[b], 0) };
}

/** Quantity, signed the way signedCost signs money. */
const signedQty = (r: MovementRow): number => {
  const q = Number(r.qty ?? 0);
  const type = String(r.movement_type);
  if (type === 'IN') return Math.abs(q);
  if (type === 'OUT') return -Math.abs(q);
  return q;
};

/** stockBreakdownAsOf, over preloaded rows: per item, the quantity and value as of END OF `date`. */
export function foldStockByItem(rows: OwnedMovement[], date: string): Map<string, { qty: number; valueSen: number }> {
  const items = new Map<string, { qty: number; valueSen: number }>();
  for (const r of rows) {
    if (!movementCountsAsOf(r, date)) continue;
    const code = String(r.item_code ?? '');
    if (!code) continue;
    const at = items.get(code) ?? { qty: 0, valueSen: 0 };
    at.qty += signedQty(r);
    at.valueSen += signedCost(r);
    items.set(code, at);
  }
  return items;
}

/** The stock value as of END OF `date` — the three buckets in one figure. */
export async function stockValueAsOf(
  sb: any,
  companyId: number,
  date: string,
): Promise<{ ok: true; valueSen: number } | { ok: false; reason: string }> {
  const r = await stockValueByBucketAsOf(sb, companyId, date);
  return r.ok ? { ok: true, valueSen: r.totalSen } : r;
}

/**
 * The as-of value PER ITEM — the Inventory page's 选日期 view (GL redesign
 * item 5). Same replay, same signs, same dateless-window fallback, the same
 * consignment exclusion as the close; grouped by item_code so the screen can
 * show each product's quantity and value on that day.
 */
export async function stockBreakdownAsOf(
  sb: any,
  companyId: number,
  date: string,
): Promise<{ ok: true; items: Map<string, { qty: number; valueSen: number }> } | { ok: false; reason: string }> {
  const moves = await ownedMovementsAsOf(sb, companyId, date);
  if (!moves.ok) return moves;
  const items = new Map<string, { qty: number; valueSen: number }>();
  for (const r of moves.rows) {
    const code = String(r.item_code ?? '');
    if (!code) continue;
    const at = items.get(code) ?? { qty: 0, valueSen: 0 };
    const q = Number(r.qty ?? 0);
    const type = String(r.movement_type);
    if (type === 'IN') at.qty += Math.abs(q);
    else if (type === 'OUT') at.qty -= Math.abs(q);
    else at.qty += q;
    at.valueSen += signedCost(r);
    items.set(code, at);
  }
  return { ok: true, items };
}

/* ── The close ───────────────────────────────────────────────────────────── */

export type CloseOutcome = {
  companyId: number;
  month: string;
  valueSen: number;
  /** The three closing stocks the value is made of. */
  buckets?: Record<StockBucket, number>;
  action: 'posted' | 'unchanged' | 'reposted' | 'failed';
  jeNo?: string;
  revJeNo?: string;
  note?: string;
};

type ActiveJe = { id: string; je_no: string; total_debit_sen: number };

/** The ACTIVE (non-reversed) entry for a doc, or null. */
async function activeJe(sb: any, companyId: number, docNo: string): Promise<
  { ok: true; je: ActiveJe | null } | { ok: false; reason: string }
> {
  const { data, error } = await sb
    .from('journal_entries')
    .select('id, je_no, reversed, total_debit_sen')
    .eq('company_id', companyId)
    .eq('source_type', 'STOCKADJ')
    .eq('source_doc_no', docNo);
  if (error) return { ok: false, reason: error.message };
  const je = ((data ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null; total_debit_sen: number }>)
    .find((r) => !r.reversed) ?? null;
  return { ok: true, je };
}

/** The lines an entry carries, as `code|dr|cr` — what "the same entry" means. */
async function lineShape(sb: any, companyId: number, jeId: string): Promise<{ ok: true; shape: string } | { ok: false; reason: string }> {
  const { data, error } = await sb
    .from('journal_entry_lines')
    .select('account_code, debit_sen, credit_sen')
    .eq('company_id', companyId)
    .eq('journal_entry_id', jeId);
  if (error) return { ok: false, reason: error.message };
  return { ok: true, shape: shapeOf((data ?? []) as Array<{ account_code: string; debit_sen: number; credit_sen: number }>) };
}
const shapeOf = (lines: Array<{ account_code: string; debit_sen: number; credit_sen: number }>): string =>
  lines.map((l) => `${l.account_code}|${Number(l.debit_sen)}|${Number(l.credit_sen)}`).sort().join(';');

/** The split as the run log and the narration say it. */
const splitText = (buckets: Record<StockBucket, number>): string =>
  STOCK_BUCKETS.filter((b) => buckets[b] !== 0).map((b) => `${b} ${fmtSen(buckets[b])}`).join(', ');

/**
 * Close (or re-check) ONE month for ONE company. Idempotent and self-healing:
 * lines unchanged → 'unchanged'; no entries yet → post the pair; value or
 * shape moved (a late GRN, a warehouse re-bucketed, the accounts split) →
 * reverse the old pair, post the new one. Every outcome is written to
 * acc_stock_close_runs.
 */
export async function closeStockMonth(
  sb: any,
  companyId: number,
  month: string,
  trigger: 'cron' | 'manual',
): Promise<CloseOutcome> {
  const edges = monthEdges(month);
  const record = async (o: CloseOutcome): Promise<CloseOutcome> => {
    await sb.from('acc_stock_close_runs').insert({
      company_id: o.companyId, month: o.month, trigger,
      stock_value_sen: o.valueSen, action: o.action,
      je_no: o.jeNo ?? null, rev_je_no: o.revJeNo ?? null,
      note: [o.buckets ? splitText(o.buckets) : null, o.note ?? null].filter(Boolean).join(' — ') || null,
    });
    return o;
  };
  if (!edges.ok) return { companyId, month, valueSen: 0, action: 'failed', note: `bad month ${month}` };

  const val = await stockValueByBucketAsOf(sb, companyId, edges.lastDay);
  if (!val.ok) return record({ companyId, month, valueSen: 0, action: 'failed', note: `value: ${val.reason}` });
  const { buckets, totalSen } = val;
  const negative = STOCK_BUCKETS.filter((b) => buckets[b] < 0);
  if (negative.length > 0) {
    return record({ companyId, month, valueSen: totalSen, buckets, action: 'failed', note: `replayed value is negative (${negative.join(', ')}) — inventory data needs a look before this month can close` });
  }

  const roles = await resolveRoles(sb, companyId);
  const filled = STOCK_BUCKETS.filter((b) => buckets[b] > 0);
  const closingLines: RuleLine[] = filled.flatMap((b) => [
    { accountCode: roles[STOCK_BUCKET_ROLES[b].inventory], debitSen: buckets[b], creditSen: 0, notes: `Closing stock ${month} — ${b}` },
    { accountCode: roles[STOCK_BUCKET_ROLES[b].closing], debitSen: 0, creditSen: buckets[b], notes: `Closing stock ${month} — ${b}` },
  ]);
  const openingLines: RuleLine[] = filled.flatMap((b) => [
    { accountCode: roles[STOCK_BUCKET_ROLES[b].opening], debitSen: buckets[b], creditSen: 0, notes: `Opening stock ${month} — ${b}` },
    { accountCode: roles[STOCK_BUCKET_ROLES[b].inventory], debitSen: 0, creditSen: buckets[b], notes: `Opening stock ${month} — ${b}` },
  ]);
  const wantShape = (ls: RuleLine[]): string => shapeOf(ls.map((l) => ({ account_code: l.accountCode, debit_sen: l.debitSen, credit_sen: l.creditSen })));

  const adjDoc = `STOCKADJ-${companyId}-${month}`;
  const revDoc = `STOCKADJ-REV-${companyId}-${month}`;
  const cur = await activeJe(sb, companyId, adjDoc);
  if (!cur.ok) return record({ companyId, month, valueSen: totalSen, buckets, action: 'failed', note: `read: ${cur.reason}` });
  const curRev = await activeJe(sb, companyId, revDoc);
  if (!curRev.ok) return record({ companyId, month, valueSen: totalSen, buckets, action: 'failed', note: `read: ${curRev.reason}` });

  const wasPosted = cur.je != null;
  /* "Unchanged" is the LINES, not the total: the same money on other accounts
     (the buckets split, a warehouse re-bucketed) re-posts like a moved value. */
  let sameLines = false;
  if (cur.je && curRev.je && totalSen > 0) {
    const [a, r] = await Promise.all([lineShape(sb, companyId, cur.je.id), lineShape(sb, companyId, curRev.je.id)]);
    if (!a.ok) return record({ companyId, month, valueSen: totalSen, buckets, action: 'failed', note: `read lines: ${a.reason}` });
    if (!r.ok) return record({ companyId, month, valueSen: totalSen, buckets, action: 'failed', note: `read lines: ${r.reason}` });
    sameLines = a.shape === wantShape(closingLines) && r.shape === wantShape(openingLines);
  }
  if (cur.je && curRev.je && sameLines) {
    return record({ companyId, month, valueSen: totalSen, buckets, action: 'unchanged', jeNo: cur.je.je_no, revJeNo: curRev.je.je_no });
  }

  /* Value or shape moved (or a half-posted pair): take the old pair out FIRST
     — a contra each, dated at its own month edge so entry and series stay in
     the month they describe — then post fresh. */
  if (cur.je && !sameLines) {
    const r1 = await reverseJournal(sb, { sourceType: 'STOCKADJ', sourceDocNo: adjDoc, companyId, entryDate: edges.lastDay, narration: (o) => `Re-close of ${month} — replaces ${o.je_no}` });
    if (!r1.ok) return record({ companyId, month, valueSen: totalSen, buckets, action: 'failed', note: `reverse: ${r1.reason ?? r1.status}` });
    if (curRev.je) {
      const r2 = await reverseJournal(sb, { sourceType: 'STOCKADJ', sourceDocNo: revDoc, companyId, entryDate: edges.nextFirst, narration: (o) => `Re-close of ${month} — replaces ${o.je_no}` });
      if (!r2.ok) return record({ companyId, month, valueSen: totalSen, buckets, action: 'failed', note: `reverse rev: ${r2.reason ?? r2.status}` });
    }
  }

  if (totalSen === 0) {
    return record({
      companyId, month, valueSen: 0, buckets,
      action: wasPosted ? 'reposted' : 'unchanged',
      note: 'stock value is zero — nothing to carry',
    });
  }

  const post = await postJournal(sb, {
    companyId,
    entryDate: edges.lastDay,
    sourceType: 'STOCKADJ',
    sourceDocNo: adjDoc,
    narration: `Closing stock ${month} — ${fmtSen(totalSen)} (${splitText(buckets)})`,
    lines: closingLines,
  });
  if (!post.ok) return record({ companyId, month, valueSen: totalSen, buckets, action: 'failed', note: `post: ${post.reason ?? post.status}` });

  const rev = await postJournal(sb, {
    companyId,
    entryDate: edges.nextFirst,
    sourceType: 'STOCKADJ',
    sourceDocNo: revDoc,
    narration: `Opening stock ${month} — the closing carried forward (${splitText(buckets)})`,
    lines: openingLines,
  });
  if (!rev.ok) {
    /* The closing leg IS in the ledger; say so and let the next sweep heal the
       missing reversal (the pair-check above re-enters this path). */
    return record({ companyId, month, valueSen: totalSen, buckets, action: 'failed', jeNo: post.jeNo, note: `reversal post: ${rev.reason ?? rev.status} (closing leg ${post.jeNo} DID post — the next run completes the pair)` });
  }

  return record({
    companyId, month, valueSen: totalSen, buckets,
    action: wasPosted ? 'reposted' : 'posted',
    jeNo: post.jeNo, revJeNo: rev.jeNo,
  });
}

/** The daily sweep: every granted company × the two most recent closed months. */
export async function sweepStockClose(
  sb: any,
  companyIds: number[],
  trigger: 'cron' | 'manual',
  nowMs: number = Date.now(),
): Promise<CloseOutcome[]> {
  const out: CloseOutcome[] = [];
  for (const co of companyIds) {
    for (const month of sweepMonths(nowMs)) {
      out.push(await closeStockMonth(sb, co, month, trigger));
    }
  }
  return out;
}
