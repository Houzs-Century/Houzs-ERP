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
//  Acquirer settlement conf. | Dr bank + Dr fee      / Cr transit      | SETTLE      | SETTLE_REVERSAL
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

export type AccountRole =
  | 'AR' | 'SALES' | 'INVENTORY' | 'AP'
  | 'CASH' | 'BANK_DEFAULT' | 'TRANSIT_EDC' | 'TRANSIT_ONLINE' | 'CUSTOMER_DEPOSITS' | 'OVER_SHORT';

/* Fallback = the unified AutoCount-style chart (phase 1, migration 0297;
   owner decision 2026-08-16). Every company carries these codes, so a company
   whose roles rows are missing or unreadable still books onto real accounts. */
export const DEFAULT_ROLE_CODES: Record<AccountRole, string> = {
  AR: '300-0000',                // Trade Debtor
  SALES: '500-0000',             // Sales Revenue
  INVENTORY: '310-0000',         // Inventory
  AP: '400-0000',                // Trade Creditor
  CASH: '335-0000',              // Cash on Hand
  BANK_DEFAULT: '330-0000',      // Bank — Maybank Current
  TRANSIT_EDC: '320-0000',       // Card Machine Clearing (EDC)
  TRANSIT_ONLINE: '325-0000',    // Online Payment Clearing (FPX/e-wallet)
  CUSTOMER_DEPOSITS: '410-0000', // Customer Deposits (reserved: advance-receipt refinement)
  OVER_SHORT: '946-0000',        // Cash Over/Short (daily cashup differences)
};

/* Control accounts (brief §2.4): system-maintained, and a MANUAL journal may
   not touch them — the engine enforces this. AR and AP today; the
   settlement-in-transit roles join in phase 2. */
export const CONTROL_ROLES: AccountRole[] = ['AR', 'AP'];

/** source_type of the contra entry that voids a given source_type. */
export const REVERSAL_SOURCE: Record<string, string> = {
  SI: 'SI_REVERSAL',
  PI: 'PI_REVERSAL',
  PV: 'PV_REVERSAL',
  MANUAL: 'MANUAL_REVERSAL',
  SOPAY: 'SOPAY_REVERSAL',
  SIPAY: 'SIPAY_REVERSAL',
  SETTLE: 'SETTLE_REVERSAL',
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
    .eq('company_id', companyId == null ? 1 : Number(companyId));
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

/** Purchase invoice posted: Dr INVENTORY / Cr AP for the MYR total. */
export function piLines(
  roles: RoleCodes,
  pi: { invoice_number: string },
  supplier: { code: string | null; name: string | null },
  totalSen: number,
): RuleLine[] {
  return [
    {
      accountCode: roles.INVENTORY,
      debitSen: totalSen,
      creditSen: 0,
      partyType: null,
      partyCode: null,
      partyName: null,
      notes: `Inventory from ${pi.invoice_number}`,
    },
    {
      accountCode: roles.AP,
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
): RuleLine[] {
  const totalSen = debitLegs.reduce((s, l) => s + l.myrSen, 0);
  const lines: RuleLine[] = debitLegs.map((l) => ({
    accountCode: l.debit_account_code,
    debitSen: l.myrSen,
    creditSen: 0,
    partyType: null,
    partyCode: null,
    partyName: null,
    notes: `${l.description ?? 'Payment'} — ${pv.pv_number}`,
  }));
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
 *     Dr Bank              net    (what actually arrived)
 *     Dr Merchant charges  fee    (what the acquirer kept — an EXPENSE)
 *         Cr Settlement-in-transit  gross  (clearing the swipe)
 *
 * A zero fee simply drops its line — two lines still balance. A NEGATIVE gross
 * (a refund or chargeback line on the statement) mirrors every side, so the
 * refund walks back out of the same three accounts it walked in through
 * instead of being posted as a strange positive somewhere else.
 *
 * Fee SST: the fee is booked whole here. Splitting it into expense + input tax
 * is phase 5's job (the brief's tax work) and is deliberately NOT faked with a
 * hardcoded rate.
 */
export function settlementLines(
  accounts: { bankAccountCode: string; feeAccountCode: string; transitAccountCode: string },
  s: { acquirerCode: string; txnDate: string; ref: string | null; grossSen: number; feeSen: number },
): RuleLine[] {
  const refund = s.grossSen < 0;
  const gross = Math.abs(s.grossSen);
  const fee = Math.abs(s.feeSen);
  const net = gross - fee;
  const tag = `${s.acquirerCode} settlement ${s.txnDate}${s.ref ? ` ref ${s.ref}` : ''}`;
  const lines: RuleLine[] = [];
  if (net !== 0) {
    lines.push({
      accountCode: accounts.bankAccountCode,
      debitSen: refund ? 0 : net,
      creditSen: refund ? net : 0,
      notes: `Net received — ${tag}`,
    });
  }
  if (fee > 0) {
    lines.push({
      accountCode: accounts.feeAccountCode,
      debitSen: refund ? 0 : fee,
      creditSen: refund ? fee : 0,
      notes: `Acquirer fee — ${tag}`,
    });
  }
  lines.push({
    accountCode: accounts.transitAccountCode,
    debitSen: refund ? gross : 0,
    creditSen: refund ? 0 : gross,
    notes: `Clears in-transit — ${tag}`,
  });
  return lines;
}
