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
//
// Account codes are resolved through ROLES (scm.acc_account_roles, per
// company), never hardcoded at a call site. The historical literals stay as
// the fallback so a missing/unreadable roles row cannot silently stop the
// books — it books exactly what the system booked before roles existed.
// ----------------------------------------------------------------------------

export type AccountRole = 'AR' | 'SALES' | 'INVENTORY' | 'AP';

/* Fallback = the unified AutoCount-style chart (phase 1, migration 0297;
   owner decision 2026-08-16). Every company carries these codes, so a company
   whose roles rows are missing or unreadable still books onto real accounts. */
export const DEFAULT_ROLE_CODES: Record<AccountRole, string> = {
  AR: '300-0000',        // Trade Debtor
  SALES: '500-0000',     // Sales Revenue
  INVENTORY: '310-0000', // Inventory
  AP: '400-0000',        // Trade Creditor
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
