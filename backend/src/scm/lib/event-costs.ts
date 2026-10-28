// ----------------------------------------------------------------------------
// event-costs.ts — the event cost report's arithmetic, pure (owner 2026-09-30:
// payment 绑定 event → what each event cost). The route (routes/acc-events.ts)
// fetches; this decides.
//
// The report reads the LEDGER, not the documents: every journal leg carrying
// the event (a voucher or AP invoice line's own leg — acc/rules.ts), net Dr − Cr,
// counted only while the entry is posted and on neither side of a reversal
// pair (acc/reversal-pairs.ts — the rule every statement keeps). So a cancelled
// voucher and an edited AP invoice's first entry drop out on their own, and
// the report agrees with the P&L it is a slice of.
// ----------------------------------------------------------------------------

import { countsInTheBooks } from '../../acc/reversal-pairs';
import type { EventRow } from './event-tags';

export type TaggedLeg = {
  journal_entry_id: string;
  line_no: number | null;
  account_code: string;
  debit_sen: number | null;
  credit_sen: number | null;
  notes: string | null;
  project_id: number | null;
};

export type LegEntry = {
  id: string;
  je_no: string;
  entry_date: string | null;
  source_type: string | null;
  source_doc_no: string | null;
  posted: boolean | null;
  reversed: boolean | null;
  reversed_by_je: string | null;
};

export type ChartRow = { account_code: string; account_name: string | null; account_type: string | null };

export type EventCostLine = {
  jeNo: string;
  entryDate: string | null;
  sourceType: string | null;
  sourceDocNo: string | null;
  accountCode: string;
  notes: string | null;
  amountSen: number;
};

export type EventCostAccount = { accountCode: string; accountName: string | null; accountType: string | null; amountSen: number };

export type EventCost = {
  event: EventRow;
  /** Σ on EXPENSE accounts — what the event cost. */
  costSen: number;
  /** Σ on every other account (a rental deposit is an asset, not a cost). */
  otherSen: number;
  accounts: EventCostAccount[];
  lines: EventCostLine[];
};

/**
 * One row per event, in the order the events arrive (the route sends them by
 * start date). An event with no counted leg still gets its row — "this fair has
 * no bill booked yet" is an answer the report exists to give — except an
 * ARCHIVED one, which the office withdrew: it shows only if money is on it.
 */
export function buildEventCosts(events: EventRow[], legs: TaggedLeg[], entries: LegEntry[], chart: ChartRow[]): EventCost[] {
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const acct = new Map(chart.map((a) => [a.account_code, a]));
  const legsByEvent = new Map<number, Array<{ leg: TaggedLeg; entry: LegEntry }>>();
  for (const leg of legs) {
    if (leg.project_id == null) continue;
    const entry = entryById.get(leg.journal_entry_id);
    if (!entry || !countsInTheBooks(entry)) continue;
    const list = legsByEvent.get(Number(leg.project_id)) ?? [];
    list.push({ leg, entry });
    legsByEvent.set(Number(leg.project_id), list);
  }

  const out: EventCost[] = [];
  for (const event of events) {
    const tagged = legsByEvent.get(event.id) ?? [];
    if (event.archived && tagged.length === 0) continue;
    const byAccount = new Map<string, number>();
    const lines: EventCostLine[] = [];
    for (const { leg, entry } of tagged) {
      const amountSen = Number(leg.debit_sen ?? 0) - Number(leg.credit_sen ?? 0);
      byAccount.set(leg.account_code, (byAccount.get(leg.account_code) ?? 0) + amountSen);
      lines.push({
        jeNo: entry.je_no,
        entryDate: entry.entry_date,
        sourceType: entry.source_type,
        sourceDocNo: entry.source_doc_no,
        accountCode: leg.account_code,
        notes: leg.notes,
        amountSen,
      });
    }
    lines.sort((a, b) => String(a.entryDate ?? '').localeCompare(String(b.entryDate ?? '')) || a.jeNo.localeCompare(b.jeNo));
    const accounts = [...byAccount.entries()]
      .map(([accountCode, amountSen]) => ({
        accountCode,
        accountName: acct.get(accountCode)?.account_name ?? null,
        accountType: acct.get(accountCode)?.account_type ?? null,
        amountSen,
      }))
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    const isCost = (a: EventCostAccount) => String(a.accountType ?? '').toUpperCase() === 'EXPENSE';
    out.push({
      event,
      costSen: accounts.filter(isCost).reduce((s, a) => s + a.amountSen, 0),
      otherSen: accounts.filter((a) => !isCost(a)).reduce((s, a) => s + a.amountSen, 0),
      accounts,
      lines,
    });
  }
  return out;
}
