// ----------------------------------------------------------------------------
// /accounting/bank/config — which bank accounts take a statement, and how each
// one's file reads (owner 2026-09-08: the Bank Recon screen said "No bank
// account is set up to take a statement in this company yet" and nothing on
// any screen could set one up — the table had been seed-only since layer 4).
//
// The shape is the reader's own (acc/bank-parse.ts): per account, the bank,
// the account number the file must mention, the file format and delimiter,
// how amounts are written, and the HEADINGS that hold each role — several
// names per role, because the owner will not have the reader 卡死 on one
// caption (我怕未来 bank 可能换 format). The reader carries built-in synonyms
// on top, so a config may leave a role blank and still read.
//
// Registered by routes/accounting.ts like every other bank handler, for the
// route-capability audit. Same key as reconciling (scm.payment_voucher.post).
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { loadBankConfigs } from '../../acc/bank';
import { DEFAULT_HEADINGS, type BankColumnMap } from '../../acc/bank-parse';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const guard = (handler: (c: Ctx) => Promise<Response>) => async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return c.json({ error: "You don't have permission to set up bank statements." }, 403);
  }
  return handler(c);
};

const ROLES = ['date', 'description', 'reference', 'amount', 'debit', 'credit', 'indicator', 'balance', 'valueDate'] as const;

/** A heading list from whatever the screen sent — a string, a comma-separated
    string, or an array — trimmed, deduplicated, empties dropped. */
const headings = (raw: unknown): string[] => {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out: string[] = [];
  for (const h of list) {
    const s = String(h ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
};

/* ── GET /bank/config — this company's statement accounts, and the built-in
   headings the reader knows, so the screen can show what a blank role falls
   back to. ───────────────────────────────────────────────────────────────── */
export const bankConfigList = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const cfgs = await loadBankConfigs(c.get('supabase'), co.companyId);
  if (!cfgs.ok) return c.json({ error: 'load_failed', reason: cfgs.reason }, 500);
  return c.json({ configs: cfgs.configs, defaultHeadings: DEFAULT_HEADINGS });
});

/* ── POST /bank/config — add or change one account's statement setup ──────── */
export const bankConfigSave = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');

  const accountCode = String(body.accountCode ?? '').trim();
  if (!accountCode) return c.json({ error: 'account_required', message: 'Pick the bank account this statement belongs to.' }, 400);
  /* A statement is reconciled against a MONEY account of THIS company's chart —
     never a name, never another company's code. */
  const { data: acct, error: aErr } = await sb.from('accounts')
    .select('account_code, account_name, acc_money, is_active')
    .eq('company_id', co.companyId).eq('account_code', accountCode).maybeSingle();
  if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
  if (!acct) return c.json({ error: 'not_in_chart', message: `${accountCode} is not in this company's chart of accounts.` }, 400);
  if ((acct as { acc_money?: boolean }).acc_money !== true) {
    return c.json({ error: 'not_a_money_account', message: `${accountCode} is not a bank or cash account — a statement reconciles money.` }, 400);
  }

  const bankCode = String(body.bankCode ?? '').trim().toUpperCase().slice(0, 12);
  if (!bankCode) return c.json({ error: 'bank_required', message: 'Name the bank (HLB, MBB, PBB…).' }, 400);
  const statementFormat = String(body.statementFormat ?? 'CSV').trim().toUpperCase();
  if (statementFormat !== 'CSV' && statementFormat !== 'TXT') {
    return c.json({ error: 'bad_format', message: 'The reader takes CSV or TXT. Export the account activity as CSV; PDF cannot be read yet.' }, 400);
  }
  const amountFormat = String(body.amountFormat ?? 'decimal').trim();
  if (amountFormat !== 'decimal' && amountFormat !== 'integer-sen') {
    return c.json({ error: 'bad_amount_format', message: 'Amounts are either decimal (1,710.00) or integer sen (000000000171000).' }, 400);
  }
  const rawDelim = String(body.delimiter ?? '').trim().toLowerCase();
  const delimiter = rawDelim === '' || rawDelim === ',' || rawDelim === 'comma' ? null
    : rawDelim === 'tab' || rawDelim === '\\t' || rawDelim === '\t' ? '\t'
      : rawDelim === 'pipe' ? '|' : rawDelim.slice(0, 1);
  const creditIndicator = String(body.creditIndicator ?? 'CR').trim().toUpperCase() || 'CR';
  const accountNo = String(body.accountNo ?? '').trim() || null;

  const columnMap: Partial<Record<keyof BankColumnMap, string[]>> = {};
  const rawMap = (body.columnMap && typeof body.columnMap === 'object' ? body.columnMap : {}) as Record<string, unknown>;
  for (const role of ROLES) {
    const list = headings(rawMap[role]);
    if (list.length > 0) columnMap[role] = list;
  }
  /* A config may leave every role to the reader's built-in names; what it
     cannot do is name an amount BOTH ways — one column or a pair, not both. */
  if (columnMap.amount && (columnMap.debit || columnMap.credit)) {
    return c.json({ error: 'amount_both_ways', message: 'Name either one signed amount column, or a money-in and a money-out column — not both.' }, 400);
  }

  const row = {
    bank_code: bankCode, account_no: accountNo, statement_format: statementFormat, delimiter,
    amount_format: amountFormat, credit_indicator: creditIndicator, column_map: columnMap,
    is_active: body.isActive === undefined ? true : Boolean(body.isActive),
    updated_at: new Date().toISOString(),
  };
  const { data: existing, error: eErr } = await sb.from('acc_bank_statement_config')
    .select('id').eq('company_id', co.companyId).eq('account_code', accountCode).maybeSingle();
  if (eErr) return c.json({ error: 'load_failed', reason: eErr.message }, 500);
  if (existing) {
    const { error } = await sb.from('acc_bank_statement_config').update(row).eq('id', (existing as { id: number }).id).eq('company_id', co.companyId);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  } else {
    const { error } = await sb.from('acc_bank_statement_config').insert({ company_id: co.companyId, account_code: accountCode, ...row });
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true, config: { account_code: accountCode, ...row } });
});
