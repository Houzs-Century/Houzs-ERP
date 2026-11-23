// ----------------------------------------------------------------------------
// acc/daily-bank — "today, where is the money, and how much can actually move"
// (brief §3.6, owner decision 2b: build it).
//
// Everything is computed LIVE from the ledger (§2.3: no balance caches), with
// the same posted-and-not-reversed predicate every balance view uses — so the
// board, the trial balance and the reconciliation pages can never disagree.
//
// The board's shape, one block per money account (owner 2026-09-29, his
// "BANK BALANCE AVAILABLE" sample in hand: 1 By bank · 2 pending = checked,
// not yet approved — approved 了就会扣钱 · 3 show what was paid · 4 keep the
// totals; then settlement in transit 放在相对应的银行, and 1 要 the line with
// the transit added):
//   Balance B/F (yesterday's closing)
//   + today's receipts (green, listed: who paid, the document, the note)
//   − today's payouts  (listed: who was paid, the document, the note)
//   = Bank Balance (the account's closing)
//   − the checked vouchers awaiting approval that will pay out of THIS account
//     (listed: payee, voucher, description)
//   = Available (after pending)
//   + the card money swiped for this account's acquirers, not yet remitted
//     (listed per acquirer — the bank each acquirer pays into is Settlement
//     Setup's) — shown, never counted as movable
//   = Available + in transit.
// An approved voucher leaves pending and posts its payment on the VOUCHER'S
// date (the posting gate's rule): a back-dated one lowers Balance B/F rather
// than joining today's payouts, so the board always ties to the ledger
// (owner 2026-09-29: 照你建议).
// Transit whose acquirer names no bank here (未标银行, the generic clearing
// account) and a voucher paying from an account the board does not carry
// stay in their own lists, still inside the totals.
//
// THE CASH BOOK (owner 2026-11-23: 先做一个daily bank的一开始直接，但不需要列实际
// 差额。然后我每天会手动输入收到的金额; 付款就根据pv). An account given a starting
// balance reads, from its start date on, his own figures instead of the
// ledger's: the bank's real balance at the start of that day, plus the receipts
// he types, less the approved (POSTED) vouchers paying out of it on their
// voucher date — what the voucher posts, its bank charge included. Pending and
// transit stay as above. No books-versus-bank difference is shown anywhere, and
// nothing here writes to the ledger. An account with no start, or a day before
// its start, keeps the ledger board.
// ----------------------------------------------------------------------------

import { fmtSen } from '../scm/shared/format';

export type GlLine = {
  entry_date: string;
  je_no: string;
  source_type: string;
  source_doc_no: string | null;
  account_code: string;
  debit_sen: number;
  credit_sen: number;
  narration?: string | null;
  notes?: string | null;
  /** Who paid or was paid — the entry's party, stamped by the route. */
  party?: string | null;
  /** A customer payment's method, stamped by the route. */
  method?: string | null;
  /** The document number the board prints (a customer payment's official receipt or order, a voucher's number), stamped by the route. */
  doc_no?: string | null;
};

export type MoneyAccount = { account_code: string; account_name: string };
/** A settlement transit account and the money account its acquirer remits into (Settlement Setup's bank; null = none named). */
export type TransitAccount = { acquirerCode: string; account_code: string; account_name: string; bankAccountCode?: string | null };

export type DailyBankMovement = {
  jeNo: string;
  sourceType: string;
  sourceDocNo: string | null;
  /** The number the board prints: the stamped document, else the source's own number, else the journal's. */
  docNo: string;
  /** Who paid or was paid; null when the entry names nobody. */
  party: string | null;
  note: string;
  amountSen: number;
  /** A customer payment's method (cash, transfer, online:<how>, …); null for anything else. */
  method: string | null;
  /** A receipt typed into the cash book: who typed it. Absent on every other line. */
  typedBy?: string | null;
};

/** A checked voucher awaiting approval — money already asked for. */
export type DailyBankPending = {
  id: string | null;
  pvNumber: string | null;
  payee: string | null;
  description: string;
  voucherDate: string | null;
  /** The money account it will pay out of (its Paid From). */
  accountCode: string | null;
  /** MYR sen, converted the way posting will (round per voucher). */
  amountSen: number;
};

export type DailyBankTransit = { acquirerCode: string; accountCode: string; accountName: string; balanceSen: number; bankAccountCode: string | null };

export type DailyBankBlock = {
  accountCode: string;
  accountName: string;
  /** Where the money figures come from: 'cashbook' = the start, the typed
      receipts and the approved vouchers; 'ledger' = the posted ledger (no start
      set, or a day before it). */
  source: 'cashbook' | 'ledger';
  /** The account's cash-book start when one is set — also on a day before it,
      when the block still reads the ledger. */
  start: { date: string; balanceSen: number } | null;
  openingSen: number;
  inSen: number;
  outSen: number;
  closingSen: number;
  receipts: DailyBankMovement[];
  payouts: DailyBankMovement[];
  /** Checked vouchers awaiting approval that will pay out of this account. */
  pending: DailyBankPending[];
  pendingSen: number;
  /** closing − pending: what this account can still move. */
  availableSen: number;
  /** Card money for this account's acquirers — swiped, not yet remitted. */
  transit: DailyBankTransit[];
  transitSen: number;
  /** available + transit: what the account holds once the card money lands. */
  availableWithTransitSen: number;
};

export type DailyBankBoard = {
  date: string;
  blocks: DailyBankBlock[];
  /** Every transit account, as before — the per-bank split lives on the blocks. */
  transit: DailyBankTransit[];
  totalClosingSen: number;
  totalTransitSen: number;
  pendingApprovalSen: number;
  availableSen: number;
  /** Transit no block carries (no bank named, or a bank the board does not list). */
  unassignedTransit: DailyBankTransit[];
  /** Pending vouchers paying from an account the board does not carry. */
  unassignedPending: DailyBankPending[];
  note: string;
};

/** A voucher in the approval queue, as the route reads it. Only the money is required. */
export type PendingVoucherRow = {
  total_sen: number;
  exchange_rate: string | number | null;
  id?: string | null;
  pv_number?: string | null;
  payee_name?: string | null;
  notes?: string | null;
  /** What it pays for, as the bills say it (payment-vouchers-describe.ts), when the route read it. */
  description_text?: string | null;
  purpose?: string | null;
  credit_account_code?: string | null;
  voucher_date?: string | null;
};

/** A money account's cash-book start: the bank's real balance at the start of `start_date`. */
export type CashbookStart = { account_code: string; start_date: string; balance_sen: number };
/** Money received, as the owner typed it into the cash book. */
export type CashbookReceipt = { id: string; account_code: string; receipt_date: string; amount_sen: number; note: string; created_by?: string | null };
/** An approved (POSTED) voucher paying out of a cash-book account. */
export type CashbookPayout = PendingVoucherRow & { id: string; pv_number: string; voucher_date: string; credit_account_code: string; bank_charge_sen?: number | null };
/** What the route read for the accounts that have a start. */
export type DailyBankCashbook = { starts: CashbookStart[]; receipts: CashbookReceipt[]; payouts: CashbookPayout[] };

/** The voucher's MYR sen: a garbage rate falls back to 1, never to zero pending. */
const myrSen = (v: PendingVoucherRow): number => {
  const raw = Number(v.exchange_rate ?? 1);
  const rate = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return Math.round(Number(v.total_sen) * rate);
};

/** What a pending line says: what the voucher pays for, as the PV list's Description says
    it (owner 2026-11-09: 只显示单上的费用, never the bill number); else its own remark,
    else its purpose in words. */
const pendingDescription = (v: PendingVoucherRow): string => {
  const described = String(v.description_text ?? '').replace(/\s+/g, ' ').trim();
  if (described) return described;
  const note = String(v.notes ?? '').replace(/\s+/g, ' ').trim();
  if (note) return note;
  const purpose = String(v.purpose ?? '').trim();
  return purpose ? purpose.replace(/_/g, ' ').toLowerCase().replace(/^./, (ch) => ch.toUpperCase()) : '';
};

/** What a POSTED voucher took out of its bank: its MYR total and the bank charge
    the same journal credits to the bank (DEV-75, in MYR as keyed). */
export const voucherPayoutSen = (v: CashbookPayout): number => {
  const charge = Number(v.bank_charge_sen ?? 0);
  return myrSen(v) + (Number.isFinite(charge) && charge > 0 ? Math.round(charge) : 0);
};

/** One account's cash-book figures for the day: the start, then every typed
    receipt and approved voucher from the start date on — before the day into
    Balance B/F, on the day listed; after the day ignored. */
function cashbookFigures(
  date: string, start: CashbookStart, receipts: CashbookReceipt[], payouts: CashbookPayout[],
): { opening: number; inSen: number; outSen: number; received: DailyBankMovement[]; paid: DailyBankMovement[] } {
  let opening = Number(start.balance_sen);
  let inSen = 0;
  let outSen = 0;
  const received: DailyBankMovement[] = [];
  const paid: DailyBankMovement[] = [];
  for (const r of receipts) {
    if (r.receipt_date < start.start_date || r.receipt_date > date) continue;
    const amount = Number(r.amount_sen);
    if (r.receipt_date < date) { opening += amount; continue; }
    inSen += amount;
    received.push({
      jeNo: '', sourceType: 'TYPED', sourceDocNo: r.id, docNo: '', party: null,
      note: r.note, amountSen: amount, method: null, typedBy: r.created_by ?? null,
    });
  }
  for (const v of payouts) {
    if (v.voucher_date < start.start_date || v.voucher_date > date) continue;
    const amount = voucherPayoutSen(v);
    if (v.voucher_date < date) { opening -= amount; continue; }
    outSen += amount;
    const charge = amount - myrSen(v);
    const words = pendingDescription(v);
    paid.push({
      jeNo: '', sourceType: 'PV', sourceDocNo: v.id, docNo: v.pv_number, party: v.payee_name ?? null,
      note: charge > 0 ? `${words ? `${words} · ` : ''}incl. bank charge ${fmtSen(charge)}` : words,
      amountSen: amount, method: null,
    });
  }
  return { opening, inSen, outSen, received, paid };
}

/** Pure board computation over the account's ledger lines — testable without a
    database. `lines` must already be the POSTED, non-reversed lines of the
    accounts involved (any date range that covers ≤ the board date). */
export function computeDailyBank(
  date: string,
  moneyAccounts: MoneyAccount[],
  transitAccounts: TransitAccount[],
  lines: GlLine[],
  /** Every checked voucher still awaiting approval (not yet posted or
      cancelled) on or before the board date. Money already asked for is not
      money the owner may still spend — it subtracts from available, from the
      account it will pay out of. Amounts are document-currency sen; the rate
      converts to MYR the same way posting will (round per voucher). */
  pendingVouchers: PendingVoucherRow[],
  /** The cash book: each account's start, the typed receipts and the approved
      vouchers of the accounts that have one. null = every block reads the ledger. */
  cashbook: DailyBankCashbook | null,
): DailyBankBoard {
  const byAccount = new Map<string, GlLine[]>();
  for (const l of lines) {
    const arr = byAccount.get(l.account_code) ?? [];
    arr.push(l);
    byAccount.set(l.account_code, arr);
  }
  const blockCodes = new Set(moneyAccounts.map((a) => a.account_code));

  /* The vouchers, each on the account it pays from. */
  const pendingAll: DailyBankPending[] = pendingVouchers.map((v) => ({
    id: v.id ?? null,
    pvNumber: v.pv_number ?? null,
    payee: v.payee_name ?? null,
    description: pendingDescription(v),
    voucherDate: v.voucher_date ?? null,
    accountCode: v.credit_account_code ?? null,
    amountSen: myrSen(v),
  }));
  const pendingOf = (code: string): DailyBankPending[] => pendingAll.filter((p) => p.accountCode === code);
  const unassignedPending = pendingAll.filter((p) => p.accountCode == null || !blockCodes.has(p.accountCode));

  const transit: DailyBankTransit[] = transitAccounts.map((t) => {
    const ls = byAccount.get(t.account_code) ?? [];
    let bal = 0;
    for (const l of ls) {
      if (l.entry_date <= date) bal += Number(l.debit_sen) - Number(l.credit_sen);
    }
    return { acquirerCode: t.acquirerCode, accountCode: t.account_code, accountName: t.account_name, balanceSen: bal, bankAccountCode: t.bankAccountCode ?? null };
  });
  const unassignedTransit = transit.filter((t) => t.bankAccountCode == null || !blockCodes.has(t.bankAccountCode));

  const startOf = new Map((cashbook?.starts ?? []).map((s) => [s.account_code, s]));
  const blocks: DailyBankBlock[] = moneyAccounts.map((a) => {
    const ls = byAccount.get(a.account_code) ?? [];
    let opening = 0;
    let inSen = 0;
    let outSen = 0;
    let receipts: DailyBankMovement[] = [];
    let payouts: DailyBankMovement[] = [];
    const start = startOf.get(a.account_code) ?? null;
    const source: DailyBankBlock['source'] = start && start.start_date <= date ? 'cashbook' : 'ledger';
    if (start && source === 'cashbook') {
      const f = cashbookFigures(date, start,
        (cashbook?.receipts ?? []).filter((r) => r.account_code === a.account_code),
        (cashbook?.payouts ?? []).filter((v) => v.credit_account_code === a.account_code));
      opening = f.opening;
      inSen = f.inSen;
      outSen = f.outSen;
      receipts = f.received;
      payouts = f.paid;
    } else {
      for (const l of ls) {
        const net = Number(l.debit_sen) - Number(l.credit_sen);
        if (l.entry_date < date) {
          opening += net;
        } else if (l.entry_date === date) {
          const move: DailyBankMovement = {
            jeNo: l.je_no,
            sourceType: l.source_type,
            sourceDocNo: l.source_doc_no,
            docNo: l.doc_no ?? l.source_doc_no ?? l.je_no,
            party: l.party ?? null,
            note: l.notes ?? l.narration ?? '',
            amountSen: Math.abs(net),
            method: l.method ?? null,
          };
          if (net > 0) { inSen += net; receipts.push(move); }
          else if (net < 0) { outSen += -net; payouts.push(move); }
        }
        // Lines after the board date are ignored: the board answers "as of that
        // evening", so tomorrow's money must not bleed backwards.
      }
    }
    const closingSen = opening + inSen - outSen;
    const pending = pendingOf(a.account_code);
    const pendingSen = pending.reduce((s, p) => s + p.amountSen, 0);
    const own = transit.filter((t) => t.bankAccountCode === a.account_code);
    const transitSen = own.reduce((s, t) => s + t.balanceSen, 0);
    return {
      accountCode: a.account_code,
      accountName: a.account_name,
      source,
      start: start ? { date: start.start_date, balanceSen: Number(start.balance_sen) } : null,
      openingSen: opening,
      inSen,
      outSen,
      closingSen,
      receipts,
      payouts,
      pending,
      pendingSen,
      availableSen: closingSen - pendingSen,
      transit: own,
      transitSen,
      availableWithTransitSen: closingSen - pendingSen + transitSen,
    };
  });

  const totalClosingSen = blocks.reduce((s, b) => s + b.closingSen, 0);
  const totalTransitSen = transit.reduce((s, t) => s + t.balanceSen, 0);
  const pendingApprovalSen = pendingAll.reduce((s, p) => s + p.amountSen, 0);

  return {
    date,
    blocks,
    transit,
    totalClosingSen,
    totalTransitSen,
    pendingApprovalSen,
    availableSen: totalClosingSen - pendingApprovalSen,
    unassignedTransit,
    unassignedPending,
    note: blocks.some((b) => b.source === 'cashbook')
      ? 'An account with a starting balance reads the cash book: the start, the receipts typed for it, less the approved vouchers paying out of it on their voucher date (bank charge included). An account without one reads the ledger (posted, non-reversed). Pending = checked vouchers awaiting approval, on the account they pay from. Transit money is swiped but not yet remitted - shown under the bank its acquirer pays into, never counted as movable.'
      : 'Computed live from the ledger (posted, non-reversed). Pending = checked vouchers awaiting approval, on the account they pay from; an approved one posts on its own date. Transit money is swiped but not yet remitted - shown under the bank its acquirer pays into, never counted as movable.',
  };
}
