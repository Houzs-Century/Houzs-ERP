// ----------------------------------------------------------------------------
// acc/daily-bank — "today, where is the money, and how much can actually move"
// (brief §3.6, owner decision 2b: build it).
//
// Everything is computed LIVE from the ledger (§2.3: no balance caches), with
// the same posted-and-not-reversed predicate every balance view uses — so the
// board, the trial balance and the reconciliation pages can never disagree.
//
// The board's shape:
//   yesterday's closing (opening)
//   + today's money-account receipts (green, listed)
//   − today's money-account payouts  (orange, listed)
//   = closing per account, summed into "what can actually move"
//   plus the settlement-in-transit balances per acquirer (swiped, not yet
//   remitted) — visible but NOT counted as movable.
//
// Pending-approval payment vouchers subtract from available once the phase-3
// approval flow exists; until then the field is 0 and says so.
// ----------------------------------------------------------------------------

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
};

export type MoneyAccount = { account_code: string; account_name: string };
export type TransitAccount = { acquirerCode: string; account_code: string; account_name: string };

export type DailyBankMovement = {
  jeNo: string;
  sourceType: string;
  sourceDocNo: string | null;
  note: string;
  amountSen: number;
};

export type DailyBankBlock = {
  accountCode: string;
  accountName: string;
  openingSen: number;
  inSen: number;
  outSen: number;
  closingSen: number;
  receipts: DailyBankMovement[];
  payouts: DailyBankMovement[];
};

export type DailyBankBoard = {
  date: string;
  blocks: DailyBankBlock[];
  transit: Array<{ acquirerCode: string; accountCode: string; accountName: string; balanceSen: number }>;
  totalClosingSen: number;
  totalTransitSen: number;
  pendingApprovalSen: number;
  availableSen: number;
  note: string;
};

/** Pure board computation over the account's ledger lines — testable without a
    database. `lines` must already be the POSTED, non-reversed lines of the
    accounts involved (any date range that covers ≤ the board date). */
export function computeDailyBank(
  date: string,
  moneyAccounts: MoneyAccount[],
  transitAccounts: TransitAccount[],
  lines: GlLine[],
  /** Phase 3: every DRAFT voucher sitting in the approval cycle (submitted,
      not yet posted or cancelled) on or before the board date. Money already
      asked for is not money the owner may still spend — it subtracts from
      available whether the yes has been said or not, because saying yes is
      the plan. Amounts are document-currency sen; the rate converts to MYR
      the same way posting will (round per voucher). */
  pendingVouchers: Array<{ total_sen: number; exchange_rate: string | number | null }> = [],
): DailyBankBoard {
  const byAccount = new Map<string, GlLine[]>();
  for (const l of lines) {
    const arr = byAccount.get(l.account_code) ?? [];
    arr.push(l);
    byAccount.set(l.account_code, arr);
  }

  const blocks: DailyBankBlock[] = moneyAccounts.map((a) => {
    const ls = byAccount.get(a.account_code) ?? [];
    let opening = 0;
    let inSen = 0;
    let outSen = 0;
    const receipts: DailyBankMovement[] = [];
    const payouts: DailyBankMovement[] = [];
    for (const l of ls) {
      const net = Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0);
      if (l.entry_date < date) {
        opening += net;
      } else if (l.entry_date === date) {
        const move: DailyBankMovement = {
          jeNo: l.je_no,
          sourceType: l.source_type,
          sourceDocNo: l.source_doc_no,
          note: l.notes ?? l.narration ?? '',
          amountSen: Math.abs(net),
        };
        if (net > 0) { inSen += net; receipts.push(move); }
        else if (net < 0) { outSen += -net; payouts.push(move); }
      }
      // Lines after the board date are ignored: the board answers "as of that
      // evening", so tomorrow's money must not bleed backwards.
    }
    return {
      accountCode: a.account_code,
      accountName: a.account_name,
      openingSen: opening,
      inSen,
      outSen,
      closingSen: opening + inSen - outSen,
      receipts,
      payouts,
    };
  });

  const transit = transitAccounts.map((t) => {
    const ls = byAccount.get(t.account_code) ?? [];
    let bal = 0;
    for (const l of ls) {
      if (l.entry_date <= date) bal += Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0);
    }
    return { acquirerCode: t.acquirerCode, accountCode: t.account_code, accountName: t.account_name, balanceSen: bal };
  });

  const totalClosingSen = blocks.reduce((s, b) => s + b.closingSen, 0);
  const totalTransitSen = transit.reduce((s, t) => s + t.balanceSen, 0);
  const pendingApprovalSen = pendingVouchers.reduce((s, v) => {
    const raw = Number(v.exchange_rate ?? 1);
    const rate = Number.isFinite(raw) && raw > 0 ? raw : 1;
    return s + Math.round(Number(v.total_sen ?? 0) * rate);
  }, 0);

  return {
    date,
    blocks,
    transit,
    totalClosingSen,
    totalTransitSen,
    pendingApprovalSen,
    availableSen: totalClosingSen - pendingApprovalSen,
    note: 'Computed live from the ledger (posted, non-reversed). Transit money is swiped but not yet remitted - visible, not counted as movable. Pending-approval vouchers are money already asked for - subtracted from available until they post or leave the queue.',
  };
}
