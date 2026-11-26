// ----------------------------------------------------------------------------
// bank-card-settled — the card payments a bank movement took in directly,
// with no merchant report carrying them (scm.acc_bank_card_settlements).
//
// Owner, 2026-11-17: 2990's instalment sales swiped on Houzs's AEON terminal
// come back as a transfer from Houzs, less AEON's charges, and no 2990 report
// will ever list them — 「我在bank recon时可以选刷卡的transaction，然后差额就直接去
// terminal charges」. Such a payment is SETTLED, exactly as one a confirmed report
// line holds: it leaves Merchant Recon's lists and pools, Payments not matched
// yet, and may no longer be edited. These are the reads every one of those asks;
// the writing is acc/bank-card-settle.
//
// Every read fails closed: "could not tell" is never "not taken".
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import type { resolveRoles } from './rules';

export const BANK_CARD_TABLE = 'acc_bank_card_settlements';

type Sb = Parameters<typeof resolveRoles>[0];
type Fail = { ok: false; reason: string };

export type BankCardRow = {
  id: number;
  bank_line_id: number;
  payment_source: string;
  payment_id: string;
  doc_no: string | null;
  gross_sen: number;
  clearing_account_code: string;
  received_on: string;
  je_no: string | null;
};

const ROW_COLUMNS = 'id, bank_line_id, payment_source, payment_id, doc_no, gross_sen, clearing_account_code, received_on, je_no';

const keyOf = (source: string, id: string): string => `${source}:${id}`;

/** `${source}:${id}` of each payment a bank movement took in — of these payments,
    or of the whole company when `payments` is null. */
export async function loadBankCardKeys(
  sb: Sb, companyId: number, payments: ReadonlyArray<{ source: string; id: string }> | null,
): Promise<{ ok: true; keys: Set<string> } | Fail> {
  const keys = new Set<string>();
  if (payments === null) {
    const all = await paginateAll<{ payment_source: string; payment_id: string }>((f, t) => sb
      .from(BANK_CARD_TABLE).select('payment_source, payment_id')
      .eq('company_id', companyId).order('id').range(f, t));
    if (all.error) return { ok: false, reason: `card payments the bank took in: ${all.error.message}` };
    for (const r of all.data ?? []) keys.add(keyOf(String(r.payment_source), String(r.payment_id)));
    return { ok: true, keys };
  }
  const idsBySource = new Map<string, Set<string>>();
  for (const p of payments) {
    const ids = idsBySource.get(p.source) ?? new Set<string>();
    ids.add(String(p.id));
    idsBySource.set(p.source, ids);
  }
  const reads = await Promise.all([...idsBySource].map(([source, ids]) => chunkIn<{ payment_source: string; payment_id: string }>(
    [...ids], (batch, f, t) => sb
      .from(BANK_CARD_TABLE).select('payment_source, payment_id')
      .eq('company_id', companyId).eq('payment_source', source).in('payment_id', batch)
      .order('id').range(f, t),
  )));
  for (const r of reads) {
    if (r.error) return { ok: false, reason: `card payments the bank took in: ${r.error.message}` };
    for (const m of r.data) keys.add(keyOf(String(m.payment_source), String(m.payment_id)));
  }
  return { ok: true, keys };
}

/** The movement that took this one payment in, or null. */
export async function bankCardRowOf(
  sb: Sb, companyId: number, source: string, paymentId: string,
): Promise<{ ok: true; row: BankCardRow | null } | Fail> {
  const { data, error } = await sb.from(BANK_CARD_TABLE).select(ROW_COLUMNS)
    .eq('company_id', companyId).eq('payment_source', source).eq('payment_id', paymentId).maybeSingle();
  if (error) return { ok: false, reason: `card payment taken in by the bank: ${String(error.message ?? error)}` };
  return { ok: true, row: (data as BankCardRow | null) ?? null };
}

/** Every payment one movement took in. */
export async function bankCardRowsOfLine(
  sb: Sb, companyId: number, bankLineId: number,
): Promise<{ ok: true; rows: BankCardRow[] } | Fail> {
  const { data, error } = await sb.from(BANK_CARD_TABLE).select(ROW_COLUMNS)
    .eq('company_id', companyId).eq('bank_line_id', bankLineId).order('id');
  if (error) return { ok: false, reason: `card payments this movement took in: ${String(error.message ?? error)}` };
  return { ok: true, rows: (Array.isArray(data) ? data : []) as BankCardRow[] };
}

/** The whole company's, for the reports that ask when card money reached a bank. */
export async function loadBankCardFacts(
  sb: Sb, companyId: number,
): Promise<{ ok: true; rows: Array<{ payment_source: string; payment_id: string; received_on: string }> } | Fail> {
  const { data, error } = await paginateAll<{ payment_source: string; payment_id: string; received_on: string }>((f, t) => sb
    .from(BANK_CARD_TABLE).select('payment_source, payment_id, received_on')
    .eq('company_id', companyId).order('id').range(f, t));
  if (error) return { ok: false, reason: `card payments the bank took in: ${error.message}` };
  return { ok: true, rows: data ?? [] };
}
