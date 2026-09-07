// ----------------------------------------------------------------------------
// acc/rules — THE posting rules table.
//
// One table of "which action books which entry". If a document type is not in
// this table, nothing in the system may write it to the ledger. (Requirements
// brief §2.1: a rules table you can read at a glance, one posting gate, and a
// mandatory automated test per auto-posting document type.)
//
//  action                    | entry                                   | source_type | reversal
//  --------------------------+-----------------------------------------+-------------+-----------------
//  Sales invoice issued      | Dr AR             / Cr SALES            | SI          | SI_REVERSAL
//  Purchase invoice posted   | Dr INVENTORY      / Cr AP               | PI          | PI_REVERSAL
//  Payment voucher posted    | Dr expense lines  / Cr bank/AP (header) | PV          | PV_REVERSAL
//  Manual journal (JV)       | operator-entered lines                  | MANUAL      | MANUAL_REVERSAL
//  SO payment collected      | Dr CASH/BANK/transit / Cr AR            | SOPAY       | SOPAY_REVERSAL
//  SI payment collected      | Dr CASH/BANK/transit / Cr AR            | SIPAY       | SIPAY_REVERSAL
//  Daily cash close          | Dr/Cr OVER_SHORT      / Cr/Dr CASH      | CASHUP      | (none — correct by JV)
//  Acquirer settlement conf. | Dr fee                / Cr transit      | SETTLE      | SETTLE_REVERSAL
//  Statement-level charge    | Dr fee                / Cr transit      | SETTLEADJ   | SETTLEADJ_REVERSAL
//  Acquirer payout received  | Dr bank               / Cr transit      | SETTLEBANK  | SETTLEBANK_REVERSAL
//
//  Customer-payment debit side, by the sales panel's own method model:
//    cash                 -> CASH role (335-0000)
//    transfer             -> BANK_DEFAULT role (the transfer lands in the bank)
//    merchant/installment -> the acquirer's transit account (scm.acc_acquirers),
//                            falling back to the TRANSIT_EDC role when the
//                            acquirer is unmapped - loudly, never silently
//  Credit side is always AR: invoices post the receivable in full, receipts
//  relieve it, and the AR control = invoices minus receipts stays one rule.
//  (Deposits collected before any invoice sit as a debtor credit balance -
//  the CUSTOMER_DEPOSITS refinement is reserved, deliberately not wired.)
//
// Account codes are resolved through ROLES (scm.acc_account_roles, per
// company), never hardcoded at a call site. The historical literals stay as
// the fallback so a missing/unreadable roles row cannot silently stop the
// books — it books exactly what the system booked before roles existed.
// ----------------------------------------------------------------------------

import { accMastersCompanyId } from './masters-company';

export type AccountRole =
  | 'AR' | 'AR_OTHER' | 'SALES' | 'INVENTORY' | 'AP' | 'AP_OTHER'
  | 'CASH' | 'BANK_DEFAULT' | 'TRANSIT_EDC' | 'TRANSIT_ONLINE' | 'CUSTOMER_DEPOSITS' | 'OVER_SHORT'
  | 'CLOSING_STOCK';

/* Fallback = the accountant's own AutoCount codes (migration 0344; owner
   decision 2026-09-02: 迁到 AutoCount 码). Every company carries these codes,
   so a company whose roles rows are missing or unreadable still books onto
   real accounts. 326/327 are the ERP-extension clearing codes parked in
   AutoCount's free gap — the settlement layer's own accounts. */
export const DEFAULT_ROLE_CODES: Record<AccountRole, string> = {
  AR: '300-0000',                // ACCOUNT RECEIVEABLE
  AR_OTHER: '305-0000',          // OTHER DEBTOR (the Other Debtors module's control)
  SALES: '500-0000',             // Sales Revenue (template; refined by the chart import)
  INVENTORY: '330-0000',         // STOCK
  AP: '400-0000',                // ACCOUNT PAYABLE
  AP_OTHER: '405-0000',          // OTHER CREDITOS (the accountant's spelling)
  CASH: '320-0000',              // CASH IN HAND
  BANK_DEFAULT: '310-0010',      // CASH AT BANK - MAYBANK
  TRANSIT_EDC: '326-0000',       // CARD MACHINE CLEARING (EDC)
  TRANSIT_ONLINE: '327-0000',    // ONLINE PAYMENT CLEARING (FPX/E-WALLET)
  CUSTOMER_DEPOSITS: '400-0001', // DEPOSIT (under ACCOUNT PAYABLE)
  OVER_SHORT: '946-0000',        // Cash Over/Short (ERP extension)
  CLOSING_STOCK: '620-0000',     // STOCKS AT THE END OF YEAR (month-close P&L leg)
};

/* Control accounts (brief §2.4): system-maintained, and a MANUAL journal may
   not touch them — the engine enforces this. AR and AP today; the
   settlement-in-transit roles join in phase 2. */
export const CONTROL_ROLES: AccountRole[] = ['AR', 'AR_OTHER', 'AP', 'AP_OTHER'];

/** Which AP control a supplier's paper belongs to. 405-x supplier codes are
    AutoCount's OTHER CREDITORS — their bills and payments land on AP_OTHER
    (405-0000), everyone else on AP (400-0000). The owner's call, 2026-09-03,
    with the split's blast radius on the table: the supplier LIST and every
    screen stay exactly as they are; only the GL landing follows the code.
    ONE home for the prefix — the PV page mirrors the pick for display, and
    the server validates against THIS. */
export const apControlRole = (supplierCode: string | null | undefined): 'AP' | 'AP_OTHER' =>
  supplierCode != null && supplierCode.startsWith('405-') ? 'AP_OTHER' : 'AP';

/** source_type of the contra entry that voids a given source_type. */
export const REVERSAL_SOURCE: Record<string, string> = {
  SI: 'SI_REVERSAL',
  PI: 'PI_REVERSAL',
  API: 'API_REVERSAL',
  PV: 'PV_REVERSAL',
  MANUAL: 'MANUAL_REVERSAL',
  SOPAY: 'SOPAY_REVERSAL',
  SIPAY: 'SIPAY_REVERSAL',
  SETTLE: 'SETTLE_REVERSAL',
  SETTLEADJ: 'SETTLEADJ_REVERSAL',
  ODB: 'ODB_REVERSAL',
  ODR: 'ODR_REVERSAL',
  RCT: 'RCT_REVERSAL',
};

export type RoleCodes = Record<AccountRole, string>;

/**
 * Resolve the account code for each role for one company.
 *
 * Fail-open BY DESIGN, unlike the engine's idempotency reads: a blip here (or
 * a company with no roles rows yet) falls back to DEFAULT_ROLE_CODES, which
 * are the exact literals every historical posting used — so the worst case of
 * a failed read is "books like yesterday", never "books nothing" and never
 * "books differently". The engine still validates the resolved code against
 * the chart before writing.
 */
export async function resolveRoles(sb: any, companyId: number | null): Promise<RoleCodes> {
  const codes: RoleCodes = { ...DEFAULT_ROLE_CODES };
  const { data, error } = await sb
    .from('acc_account_roles')
    .select('role, account_code')
    .eq('company_id', accMastersCompanyId(companyId, 'resolveRoles'));
  if (error) {
    /* eslint-disable-next-line no-console */
    console.error('[acc/rules] roles read failed — using default codes:', error.message);
    return codes;
  }
  for (const r of (data ?? []) as Array<{ role: string; account_code: string }>) {
    if (r.role in codes && r.account_code) codes[r.role as AccountRole] = r.account_code;
  }
  return codes;
}

/* ── Line builders — the rules table above, as code ────────────────────────── */

export type RuleLine = {
  accountCode: string;
  debitSen: number;
  creditSen: number;
  partyType?: string | null;
  partyCode?: string | null;
  partyName?: string | null;
  notes?: string | null;
};

/** Sales invoice issued: Dr AR / Cr SALES for the invoice total. */
export function siLines(
  roles: RoleCodes,
  si: { invoice_number: string; debtor_code: string | null; debtor_name: string | null },
  totalSen: number,
): RuleLine[] {
  return [
    {
      accountCode: roles.AR,
      debitSen: totalSen,
      creditSen: 0,
      partyType: 'CUSTOMER',
      partyCode: si.debtor_code,
      partyName: si.debtor_name,
      notes: `AR for ${si.invoice_number}`,
    },
    {
      accountCode: roles.SALES,
      debitSen: 0,
      creditSen: totalSen,
      partyType: null,
      partyCode: null,
      partyName: null,
      notes: `Revenue from ${si.invoice_number}`,
    },
  ];
}

/**
 * Purchase invoice posted, the AutoCount periodic shape (GL redesign item 2,
 * owner 2026-09-05: ledger 只根据 invoice 认 — Dr purchase, Cr supplier):
 * one debit per PRODUCT GROUP on the invoice, each to that group's own
 * purchase account (scm.acc_item_group_accounts), credited to the supplier's
 * AP control — AP for trade creditors, AP_OTHER for 405-x (apControlRole).
 *
 * Inventory (330-0000) is deliberately NOT here any more: stock value reaches
 * the GL as the month-end adjustment (item 4), not per document. The debits
 * arrive already in MYR sen and already summing EXACTLY to the credit — the
 * caller owns FX and the rounding remainder, because only it knows the
 * header total the entry must reconcile to.
 */
/** AP invoice posted (the non-stock supplier bill — AutoCount's A/P Invoice;
    owner 2026-09-06: other creditor 的 invoice 放过去,不影响 operation 那边的
    purchase invoice): Dr each line's OWN account (rent, service, whatever the
    line says) / Cr the supplier's AP control — 400 or 405 by the supplier's
    code, the same split the PI and the PV use. Amounts arrive in MYR sen. */
export function apInvoiceLines(
  roles: RoleCodes,
  inv: { invoice_number: string },
  supplier: { code: string | null; name: string | null },
  debits: Array<{ accountCode: string; myrSen: number; description: string | null }>,
): RuleLine[] {
  const totalSen = debits.reduce((s, d) => s + d.myrSen, 0);
  return [
    ...debits.map((d) => ({
      accountCode: d.accountCode,
      debitSen: d.myrSen,
      creditSen: 0,
      partyType: null,
      partyCode: null,
      partyName: null,
      notes: d.description ?? `AP invoice ${inv.invoice_number}`,
    })),
    {
      accountCode: roles[apControlRole(supplier.code)],
      debitSen: 0,
      creditSen: totalSen,
      partyType: 'SUPPLIER',
      partyCode: supplier.code,
      partyName: supplier.name,
      notes: `AP invoice ${inv.invoice_number}`,
    },
  ];
}

export function piLines(
  roles: RoleCodes,
  pi: { invoice_number: string },
  supplier: { code: string | null; name: string | null },
  groupDebits: Array<{ groupCode: string; accountCode: string; myrSen: number }>,
): RuleLine[] {
  const totalSen = groupDebits.reduce((s, g) => s + g.myrSen, 0);
  return [
    ...groupDebits.map((g) => ({
      accountCode: g.accountCode,
      debitSen: g.myrSen,
      creditSen: 0,
      partyType: null,
      partyCode: null,
      partyName: null,
      notes: `Purchases — ${g.groupCode} on ${pi.invoice_number}`,
    })),
    {
      accountCode: roles[apControlRole(supplier.code)],
      debitSen: 0,
      creditSen: totalSen,
      partyType: 'SUPPLIER',
      partyCode: supplier.code ?? null,
      partyName: supplier.name ?? null,
      notes: `AP for ${pi.invoice_number}`,
    },
  ];
}

/**
 * Payment voucher posted: Dr each voucher line's expense account, Cr the
 * header's bank/cash/AP account for the sum of the (already-rounded) Dr legs —
 * so the entry balances exactly regardless of per-line FX rounding.
 */
export function pvLines(
  pv: { pv_number: string; payee_name: string; credit_account_code: string },
  debitLegs: Array<{ description: string | null; debit_account_code: string; myrSen: number }>,
  supplier: { code: string | null; name: string | null },
  /** The supplier's own AP control (a supplier payment): the Dr leg on it IS
      the supplier's sub-ledger, so it carries the party the way the invoice
      side's Cr leg does — owner 2026-09-06, AutoCount in hand: the payment
      must read Dr 405-H001 / Cr bank. null (an expense voucher) stamps none. */
  apControlCode: string | null = null,
): RuleLine[] {
  const totalSen = debitLegs.reduce((s, l) => s + l.myrSen, 0);
  const lines: RuleLine[] = debitLegs.map((l) => {
    const onControl = apControlCode != null && l.debit_account_code === apControlCode && !!supplier.code;
    return {
      accountCode: l.debit_account_code,
      debitSen: l.myrSen,
      creditSen: 0,
      partyType: onControl ? 'SUPPLIER' : null,
      partyCode: onControl ? supplier.code : null,
      partyName: onControl ? (supplier.name ?? pv.payee_name) : null,
      notes: `${l.description ?? 'Payment'} — ${pv.pv_number}`,
    };
  });
  lines.push({
    accountCode: pv.credit_account_code,
    debitSen: 0,
    creditSen: totalSen,
    partyType: supplier.code ? 'SUPPLIER' : null,
    partyCode: supplier.code ?? null,
    partyName: supplier.name ?? pv.payee_name,
    notes: `Payment to ${pv.payee_name} — ${pv.pv_number}`,
  });
  return lines;
}

/**
 * Customer payment collected (SO or SI panel): Dr the account the money landed
 * in, Cr AR. The debit account follows the sales panel's own 3-method model —
 * see the rules table above.
 */
export function customerPaymentLines(
  roles: RoleCodes,
  p: {
    method: string;
    docNo: string;
    transitAccountCode?: string | null; // resolved acquirer transit, when mapped
    customerCode?: string | null;
    customerName?: string | null;
  },
  amountSen: number,
): RuleLine[] {
  const debitAccount =
    p.method === 'cash' ? roles.CASH
    : p.method === 'transfer' ? roles.BANK_DEFAULT
    : (p.transitAccountCode || roles.TRANSIT_EDC);
  return [
    {
      accountCode: debitAccount,
      debitSen: amountSen,
      creditSen: 0,
      partyType: null,
      partyCode: null,
      partyName: null,
      notes: `Payment received (${p.method}) — ${p.docNo}`,
    },
    {
      accountCode: roles.AR,
      debitSen: 0,
      creditSen: amountSen,
      partyType: 'CUSTOMER',
      partyCode: p.customerCode ?? null,
      partyName: p.customerName ?? null,
      notes: `Settles ${p.docNo}`,
    },
  ];
}

/**
 * Acquirer settlement confirmed (brief §3.5 layer 3) — THE entry 系统3 never
 * wrote, which is why card fees never reached its P&L:
 *
 *     Dr Merchant charges          fee   (what the acquirer kept — an EXPENSE)
 *         Cr Settlement-in-transit fee
 *
 * ONLY the fee. Reconciling the card machine proves what was sold and what it
 * cost; it does NOT prove the money arrived, and every acquirer pays days later
 * (owner, 2026-08-17: "全部卡机都是隔几天收到的"). What remains in in-transit
 * after this is the NET the acquirer still owes — the true answer — and
 * settlementReceiptLines clears it when the bank actually pays.
 *
 * A NEGATIVE fee (a rebate on a refund line) mirrors both sides.
 *
 * Fee SST: booked whole here. Splitting it into expense + input tax is phase
 * 5's job (the brief's tax work) and is deliberately NOT faked with a
 * hardcoded rate.
 */
/**
 * A charge the STATEMENT makes that belongs to no transaction on it.
 *
 * AEON's subvention fee is the case that forced this: its transaction line nets
 * 5,928.00 and the statement pays 5,673.84, keeping 254.16 that no line
 * explains. It is a merchant charge like any other (owner, 2026-08-17 — the
 * report comes off Pine Labs), so it goes to the same account the per-line fees
 * do, and it comes out of the SAME place they do: what the acquirer still owes.
 *
 *     Dr Merchant charges  254.16
 *         Cr Settlement-in-transit  254.16
 *
 * A NEGATIVE adjustment (the statement paid more than its lines come to — a
 * rebate) books the other way round, for the same reason.
 */
export function statementChargeLines(
  accounts: { transitAccountCode: string; feeAccountCode: string },
  s: { acquirerCode: string; statementDate: string; adjustmentSen: number },
): RuleLine[] {
  const amount = Math.abs(s.adjustmentSen);
  const isCharge = s.adjustmentSen > 0;
  const tag = `${s.acquirerCode} statement ${s.statementDate}`;
  return [
    {
      accountCode: accounts.feeAccountCode,
      debitSen: isCharge ? amount : 0,
      creditSen: isCharge ? 0 : amount,
      notes: `${isCharge ? 'Charge on the statement' : 'Rebate on the statement'}, not on any transaction — ${tag}`,
    },
    {
      accountCode: accounts.transitAccountCode,
      debitSen: isCharge ? 0 : amount,
      creditSen: isCharge ? amount : 0,
      notes: `${isCharge ? 'Never coming' : 'Extra due'} — ${tag}`,
    },
  ];
}

/**
 * THE MONEY ARRIVES. One entry per payout, dated by the bank.
 *
 * The second half of the two-step the owner asked for: reconciling the card
 * machine says WHAT was sold and what it cost; this says the money is actually
 * in the account. Until it posts, the batch's net sits in settlement-in-transit
 * — which is not a gap in the books, it is the true answer to "how much do the
 * acquirers still owe me".
 *
 *     Dr Bank                      5,673.84
 *         Cr Settlement-in-transit 5,673.84
 */
export function settlementReceiptLines(
  accounts: { bankAccountCode: string; transitAccountCode: string },
  s: { acquirerCode: string; receivedOn: string; amountSen: number },
): RuleLine[] {
  const amount = Math.abs(s.amountSen);
  const refund = s.amountSen < 0;
  const tag = `${s.acquirerCode} payout received ${s.receivedOn}`;
  return [
    {
      accountCode: accounts.bankAccountCode,
      debitSen: refund ? 0 : amount,
      creditSen: refund ? amount : 0,
      notes: `Into the bank — ${tag}`,
    },
    {
      accountCode: accounts.transitAccountCode,
      debitSen: refund ? amount : 0,
      creditSen: refund ? 0 : amount,
      notes: `Clears in-transit — ${tag}`,
    },
  ];
}

export function settlementLines(
  accounts: { feeAccountCode: string; transitAccountCode: string },
  s: { acquirerCode: string; txnDate: string; ref: string | null; feeSen: number },
): RuleLine[] {
  const fee = Math.abs(s.feeSen);
  const refund = s.feeSen < 0;
  const tag = `${s.acquirerCode} settlement ${s.txnDate}${s.ref ? ` ref ${s.ref}` : ''}`;
  return [
    {
      accountCode: accounts.feeAccountCode,
      debitSen: refund ? 0 : fee,
      creditSen: refund ? fee : 0,
      notes: `Acquirer fee — ${tag}`,
    },
    {
      accountCode: accounts.transitAccountCode,
      debitSen: refund ? fee : 0,
      creditSen: refund ? 0 : fee,
      notes: `Fee is no longer receivable — ${tag}`,
    },
  ];
}
