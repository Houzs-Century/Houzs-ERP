// ----------------------------------------------------------------------------
// acc/stock-close — month-end stock value into the ledger (GL redesign item 4).
//
// The owner's design (2026-09-05), his words setting each rule:
//   • ledger 只根据 invoice 认 — documents post purchases (item 2); stock value
//     enters the GL ONCE a month, from the live engine;
//   • 可以不可以抓实时的 — the close GRABS THE LIVE VALUE the night the month
//     ends (Dr 330-0000 STOCK / Cr 620-0000 STOCKS AT END), and the next
//     month opens with the automatic reversal — so every month's P&L reads
//     purchases + opening − closing = cost of goods sold, AutoCount's own
//     arithmetic, monthly instead of yearly;
//   • 如果他们迟进 GRN 呢 — the replay runs on movement_date (the BUSINESS
//     date: a GRN's received date), and a DAILY sweep re-checks recent months;
//     a late-keyed document changes the replayed value, the sweep sees the
//     difference and re-posts — reversal first, never a silent edit;
//   • 我有没有办法看到你每天检查的成果 — every run, including the quiet
//     "unchanged" ones, writes scm.acc_stock_close_runs.
//
// The month's two entries are BOTH posted by the close, immediately:
//   STOCKADJ-{co}-{YYYY-MM}      Dr STOCK V / Cr CLOSING_STOCK V   (last day)
//   STOCKADJ-REV-{co}-{YYYY-MM}  Dr CLOSING_STOCK V / Cr STOCK V   (1st of next)
// A dated reversal is not a cancellation: both stay active, the month-end TB
// shows the stock, and the pair nets to zero from the next month on. Months
// are therefore INDEPENDENT — re-posting July never touches August.
//
// Pure sb logic, engine-gated (postJournal / reverseJournal): the close can
// never mint a second entry for a month (idempotency key = the doc numbers)
// and never deletes — a wrong value is reversed and re-posted, on the record.
// ----------------------------------------------------------------------------

import { postJournal, reverseJournal } from './engine';
import { resolveRoles } from './rules';
import { paginateAll } from '../scm/lib/paginate-all';

const isoDay = (v: unknown): string => String(v ?? '').slice(0, 10);

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

/**
 * The stock value as of END OF `date` (inclusive), replayed from movements on
 * their BUSINESS date. Signs: IN adds, OUT subtracts, ADJUSTMENT follows its
 * own qty sign (write-offs negative). AC_CUTOVER — the migrated opening —
 * is an ADJUSTMENT like any other.
 */
export async function stockValueAsOf(
  sb: any,
  companyId: number,
  date: string,
): Promise<{ ok: true; valueSen: number } | { ok: false; reason: string }> {
  const { data, error } = await paginateAll((from, to) => sb
    .from('inventory_movements')
    .select('movement_type, qty, total_cost_sen')
    .eq('company_id', companyId)
    .lte('movement_date', date)
    .range(from, to));
  if (error) return { ok: false, reason: (error as { message?: string }).message ?? String(error) };

  /* Rows written by a not-yet-redeployed worker in the minutes around the
     migration carry NO movement_date and would silently fall out of the lte
     above. Count them by their keyed time instead — the pre-item-4 meaning. */
  const { data: dateless, error: dlErr } = await sb
    .from('inventory_movements')
    .select('movement_type, qty, total_cost_sen')
    .eq('company_id', companyId)
    .is('movement_date', null)
    .lte('created_at', `${date}T23:59:59.999`);
  if (dlErr) return { ok: false, reason: dlErr.message };

  let valueSen = 0;
  for (const r of [...((data ?? []) as Array<Record<string, unknown>>), ...((dateless ?? []) as Array<Record<string, unknown>>)]) {
    const cost = Math.abs(Number(r.total_cost_sen ?? 0));
    const type = String(r.movement_type);
    if (type === 'IN') valueSen += cost;
    else if (type === 'OUT') valueSen -= cost;
    else valueSen += Number(r.qty ?? 0) >= 0 ? cost : -cost;
  }
  return { ok: true, valueSen };
}

export type CloseOutcome = {
  companyId: number;
  month: string;
  valueSen: number;
  action: 'posted' | 'unchanged' | 'reposted' | 'failed';
  jeNo?: string;
  revJeNo?: string;
  note?: string;
};

/** The ACTIVE (non-reversed) entry for a doc, or null. */
async function activeJe(sb: any, companyId: number, docNo: string): Promise<
  { ok: true; je: { id: string; je_no: string; total_debit_sen: number } | null } | { ok: false; reason: string }
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

/**
 * Close (or re-check) ONE month for ONE company. Idempotent and self-healing:
 * value unchanged → 'unchanged'; no entries yet → post the pair; value moved
 * (a late GRN) → reverse the old pair, post the new one. Every outcome is
 * written to acc_stock_close_runs.
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
      je_no: o.jeNo ?? null, rev_je_no: o.revJeNo ?? null, note: o.note ?? null,
    });
    return o;
  };
  if (!edges.ok) return { companyId, month, valueSen: 0, action: 'failed', note: `bad month ${month}` };

  const val = await stockValueAsOf(sb, companyId, edges.lastDay);
  if (!val.ok) return record({ companyId, month, valueSen: 0, action: 'failed', note: `value: ${val.reason}` });
  if (val.valueSen < 0) {
    return record({ companyId, month, valueSen: val.valueSen, action: 'failed', note: 'replayed value is negative — inventory data needs a look before this month can close' });
  }

  const adjDoc = `STOCKADJ-${companyId}-${month}`;
  const revDoc = `STOCKADJ-REV-${companyId}-${month}`;
  const cur = await activeJe(sb, companyId, adjDoc);
  if (!cur.ok) return record({ companyId, month, valueSen: val.valueSen, action: 'failed', note: `read: ${cur.reason}` });
  const curRev = await activeJe(sb, companyId, revDoc);
  if (!curRev.ok) return record({ companyId, month, valueSen: val.valueSen, action: 'failed', note: `read: ${curRev.reason}` });

  const wasPosted = cur.je != null;
  if (cur.je && Number(cur.je.total_debit_sen) === val.valueSen && curRev.je) {
    return record({ companyId, month, valueSen: val.valueSen, action: 'unchanged', jeNo: cur.je.je_no, revJeNo: curRev.je.je_no });
  }

  /* Value moved (or a half-posted pair): take the old pair out FIRST — a
     contra each, dated at its own month edge so entry and series stay in the
     month they describe — then post fresh. */
  if (cur.je && Number(cur.je.total_debit_sen) !== val.valueSen) {
    const r1 = await reverseJournal(sb, { sourceType: 'STOCKADJ', sourceDocNo: adjDoc, companyId, entryDate: edges.lastDay, narration: (o) => `Re-close of ${month} — replaces ${o.je_no}` });
    if (!r1.ok) return record({ companyId, month, valueSen: val.valueSen, action: 'failed', note: `reverse: ${r1.reason ?? r1.status}` });
    if (curRev.je) {
      const r2 = await reverseJournal(sb, { sourceType: 'STOCKADJ', sourceDocNo: revDoc, companyId, entryDate: edges.nextFirst, narration: (o) => `Re-close of ${month} — replaces ${o.je_no}` });
      if (!r2.ok) return record({ companyId, month, valueSen: val.valueSen, action: 'failed', note: `reverse rev: ${r2.reason ?? r2.status}` });
    }
  }

  if (val.valueSen === 0) {
    return record({
      companyId, month, valueSen: 0,
      action: wasPosted ? 'reposted' : 'unchanged',
      note: 'stock value is zero — nothing to carry',
    });
  }

  const roles = await resolveRoles(sb, companyId);
  const post = await postJournal(sb, {
    companyId,
    entryDate: edges.lastDay,
    sourceType: 'STOCKADJ',
    sourceDocNo: adjDoc,
    narration: `Closing stock ${month} — ${(val.valueSen / 100).toFixed(2)}`,
    lines: [
      { accountCode: roles.INVENTORY, debitSen: val.valueSen, creditSen: 0, notes: `Closing stock ${month}` },
      { accountCode: roles.CLOSING_STOCK, debitSen: 0, creditSen: val.valueSen, notes: `Closing stock ${month}` },
    ],
  });
  if (!post.ok) return record({ companyId, month, valueSen: val.valueSen, action: 'failed', note: `post: ${post.reason ?? post.status}` });

  const rev = await postJournal(sb, {
    companyId,
    entryDate: edges.nextFirst,
    sourceType: 'STOCKADJ',
    sourceDocNo: revDoc,
    narration: `Opening reversal of closing stock ${month}`,
    lines: [
      { accountCode: roles.CLOSING_STOCK, debitSen: val.valueSen, creditSen: 0, notes: `Opening reversal ${month}` },
      { accountCode: roles.INVENTORY, debitSen: 0, creditSen: val.valueSen, notes: `Opening reversal ${month}` },
    ],
  });
  if (!rev.ok) {
    /* The closing leg IS in the ledger; say so and let the next sweep heal the
       missing reversal (the pair-check above re-enters this path). */
    return record({ companyId, month, valueSen: val.valueSen, action: 'failed', jeNo: post.jeNo, note: `reversal post: ${rev.reason ?? rev.status} (closing leg ${post.jeNo} DID post — the next run completes the pair)` });
  }

  return record({
    companyId, month, valueSen: val.valueSen,
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
