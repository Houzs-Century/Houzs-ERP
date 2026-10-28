// ----------------------------------------------------------------------------
// party-ledger — what the books say each creditor (or debtor) is owed, read off
// the control accounts' party lines.
//
// Owner 2026-10-02: Supplier Maintenance shows what each supplier is owed, and
// the AR / AP Aging is rebuilt so that every party's balance IS its balance in
// the books (「每个客户或供应商的余额都等于账上的余额」). One reader serves both,
// so the two screens can never disagree about a supplier.
//
// The source is scm.v_gl_entries (posted lines only), counted the way every
// statement counts them — countsInTheBooks, so a reversed entry and its contra
// count nowhere — on the control accounts asked for, up to a date when given.
// A line is the party's by its party_code: the code stamped when the paper
// posted (the supplier's code; a customer's debtor code).
// ----------------------------------------------------------------------------
import { countsInTheBooks } from './reversal-pairs';
import { paginateAll } from '../scm/lib/paginate-all';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped in this family */
type Db = any;

export type ControlLine = {
  je_no: string;
  entry_date: string;
  source_type: string;
  source_doc_no: string | null;
  account_code: string;
  party_type: string | null;
  party_code: string | null;
  party_name: string | null;
  debit_sen: number;
  credit_sen: number;
};

/** Every counted line on these control accounts, up to `asOf` (inclusive) when
    given. Fails closed: a read that errors is reported, never read as "no lines". */
export async function loadControlLines(
  sb: Db,
  companyId: number,
  accountCodes: readonly string[],
  asOf?: string | null,
): Promise<{ ok: true; lines: ControlLine[] } | { ok: false; reason: string }> {
  const codes = [...new Set(accountCodes.filter(Boolean))];
  if (codes.length === 0) return { ok: true, lines: [] };
  const { data, error } = await paginateAll((from, to) => {
    let q = sb.from('v_gl_entries')
      .select('line_id, je_no, entry_date, source_type, source_doc_no, account_code, party_type, party_code, party_name, debit_sen, credit_sen, posted, reversed, reversed_by_je')
      .eq('company_id', companyId)
      .in('account_code', codes);
    if (asOf) q = q.lte('entry_date', asOf);
    return q.order('line_id').range(from, to);
  });
  if (error) return { ok: false, reason: (error as { message?: string }).message ?? String(error) };
  const lines: ControlLine[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    if (!countsInTheBooks(r as { posted?: boolean | null; reversed?: boolean | null; reversed_by_je?: string | null })) continue;
    lines.push({
      je_no: String(r.je_no ?? ''),
      entry_date: String(r.entry_date ?? '').slice(0, 10),
      source_type: String(r.source_type ?? ''),
      source_doc_no: r.source_doc_no == null ? null : String(r.source_doc_no),
      account_code: String(r.account_code ?? ''),
      party_type: r.party_type == null ? null : String(r.party_type),
      party_code: r.party_code == null || r.party_code === '' ? null : String(r.party_code),
      party_name: r.party_name == null ? null : String(r.party_name),
      debit_sen: Number(r.debit_sen ?? 0),
      credit_sen: Number(r.credit_sen ?? 0),
    });
  }
  return { ok: true, lines };
}

/** What each creditor is owed: credit less debit on its lines, by party code.
    Positive = we owe them; negative = they owe us back (an advance, a credit). */
export function creditorBalances(lines: readonly ControlLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    if (!l.party_code) continue;
    out.set(l.party_code, (out.get(l.party_code) ?? 0) + l.credit_sen - l.debit_sen);
  }
  return out;
}
