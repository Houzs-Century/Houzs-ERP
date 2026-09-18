// ----------------------------------------------------------------------------
// accounting-ledger — the General Ledger the AutoCount way (owner 2026-09-14,
// from his AutoCount screenshot; docs/bugs/0924): one block per account, its
// BALANCE B/F before the period, every line of the period with a running
// balance, the block's totals, then the grand totals. The columns are his:
// Date · Acc. Desc. · DE Acc. Desc. (the other side) · Journal Type · Ref. 1
// · Ref. 2 · Desc. · Debit · Credit · Balance.
//
// ONE SOURCE. The lines are scm.v_gl_entries, the read every statement makes,
// cut by the same predicate (acc/reversal-pairs.ts): a reversed entry and its
// contra count nowhere. Asked for (showReversed), they are LISTED and marked
// — the record is the journal's — but neither the running balance nor a total
// moves for them, so the ledger cannot disagree with the statements that
// drill into it.
//
// The references are the journal's own (acc/journal-refs.ts): Ref. 1 is the
// document a person files the entry under, Ref. 2 its second handle. The
// description is the line's own note, else the entry's narration — the
// sentence the poster wrote ("Payment cash on 2990-SO-2606-013 — Rachael
// Yip", "Reversal of 2990-JE-2606-0025 — …").
//
// The balance sits on the account's natural side — debit for assets and
// expenses, credit for the rest — so a bank reads positive while it holds
// money and sales read positive while they are earned; the screen brackets
// the contrary sign, the way the statements do (docs/bugs/0910).
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { resolveRoles } from '../../acc/rules';
import { classifyJournal, type JournalClass } from '../../acc/journal-class';
import { resolveJournalRefs } from '../../acc/journal-refs';
import { isReversalPair } from '../../acc/reversal-pairs';

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the general ledger." };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type GlLine = {
  line_id: string; je_no: string; entry_date: string; source_type: string | null; source_doc_no: string | null;
  line_no: number; account_code: string; account_name: string | null; account_type: string | null;
  debit_sen: number; credit_sen: number; party_name: string | null; notes: string | null;
  reversed: boolean | null; reversed_by_je: string | null;
};

export type LedgerLine = {
  lineId: string;
  date: string;
  jeNo: string;
  journal: JournalClass;
  /** The other side of the entry: the one other account, or the largest one and how many more. */
  counter: { code: string; name: string; more: number } | null;
  doc: string | null;
  doc2: string | null;
  description: string | null;
  who: string | null;
  debitSen: number;
  creditSen: number;
  /** Running balance on the account's natural side, after this line. */
  balanceSen: number;
  /** Which side of a reversal pair the line is on — '' for a line the books count. */
  reversal: 'reversed' | 'contra' | '';
};

export type LedgerBlock = {
  code: string;
  name: string;
  type: string;
  openingSen: number;
  lines: LedgerLine[];
  debitSen: number;
  creditSen: number;
  closingSen: number;
};

export type LedgerReport = {
  from: string;
  to: string;
  showReversed: boolean;
  /** The accounts asked for — every active account when none was named. */
  scope: { codes: string[]; fromCode: string | null; toCode: string | null; all: boolean };
  blocks: LedgerBlock[];
  totals: { debitSen: number; creditSen: number };
};

const DEBIT_SIDE = new Set(['ASSET', 'EXPENSE']);
/** The account's natural-side balance: debit for assets and expenses, credit for the rest. */
export const naturalSen = (type: string | null, drSen: number, crSen: number): number =>
  DEBIT_SIDE.has(String(type ?? '').toUpperCase()) ? drSen - crSen : crSen - drSen;

const SELECT = 'line_id, je_no, entry_date, source_type, source_doc_no, line_no, account_code, account_name, account_type, debit_sen, credit_sen, party_name, notes, reversed, reversed_by_je';

const CHUNK = 150;
const chunks = <T>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

/** The other side of one entry, as seen from `line`: the one other account of a
    two-line entry; of a longer one, the largest account on the opposite side
    and how many more stand beside it. */
export function counterOf(line: GlLine, entryLines: GlLine[]): LedgerLine['counter'] {
  const others = entryLines.filter((l) => l.line_id !== line.line_id);
  if (others.length === 0) return null;
  if (others.length === 1) return { code: others[0]!.account_code, name: String(others[0]!.account_name ?? ''), more: 0 };
  const mine = Number(line.debit_sen) - Number(line.credit_sen);
  const opposite = others.filter((l) => (Number(l.debit_sen) - Number(l.credit_sen)) * mine < 0);
  const pool = opposite.length > 0 ? opposite : others;
  const byAccount = new Map<string, { name: string; sen: number }>();
  for (const l of pool) {
    const at = byAccount.get(l.account_code) ?? { name: String(l.account_name ?? ''), sen: 0 };
    at.sen += Math.abs(Number(l.debit_sen) - Number(l.credit_sen));
    byAccount.set(l.account_code, at);
  }
  const ranked = [...byAccount.entries()].sort((a, b) => b[1].sen - a[1].sen || a[0].localeCompare(b[0]));
  const [code, top] = ranked[0]!;
  return { code, name: top.name, more: ranked.length - 1 };
}

const byDateThenEntry = (a: GlLine, b: GlLine): number =>
  a.entry_date.localeCompare(b.entry_date) || a.je_no.localeCompare(b.je_no) || Number(a.line_no) - Number(b.line_no);

/* ── GET /accounting/gl/ledger?from&to&accounts=a,b&fromAccount&toAccount&showReversed=1 ── */
export const ledgerReport = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '').trim();
  const to = String(c.req.query('to') ?? '').trim();
  if (!DATE.test(from) || !DATE.test(to) || from > to) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM-DD, from no later than to.' }, 400);
  }
  const picked = String(c.req.query('accounts') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const fromCode = String(c.req.query('fromAccount') ?? '').trim() || null;
  const toCode = String(c.req.query('toAccount') ?? '').trim() || null;
  const showReversed = ['1', 'true'].includes(String(c.req.query('showReversed') ?? ''));
  const sb = c.get('supabase');

  /* The chart: which accounts the ledger prints, in code order. */
  const { data: chartRaw, error: chartErr } = await sb.from('accounts')
    .select('account_code, account_name, account_type, is_active')
    .eq('company_id', co.companyId);
  if (chartErr) return c.json({ error: 'load_failed', reason: chartErr.message }, 500);
  const chart = ((chartRaw ?? []) as Array<{ account_code: string; account_name: string; account_type: string; is_active: boolean | null }>)
    .sort((a, b) => a.account_code.localeCompare(b.account_code));
  const inScope = (code: string): boolean => {
    if (picked.length > 0) return picked.includes(code);
    if (fromCode && code < fromCode) return false;
    if (toCode && code > toCode) return false;
    return true;
  };
  const scoped = chart.filter((a) => inScope(a.account_code));
  const all = picked.length === 0 && !fromCode && !toCode;
  const codes = scoped.map((a) => a.account_code);
  const codeSet = new Set(codes);
  /* A range that names most of the chart reads the whole ledger once rather
     than send hundreds of codes down the URL. */
  const readAll = all || codes.length > 200;

  /* Every posted line on those accounts up to the period's end — the ones
     before `from` are the balance brought forward. */
  const ledger = await paginateAll<GlLine>((f, t) => {
    let q = sb.from('v_gl_entries').select(SELECT).eq('company_id', co.companyId).lte('entry_date', to);
    if (!readAll) q = q.in('account_code', codes.length > 0 ? codes : ['—none—']);
    return q.order('line_id').range(f, t);
  });
  if (ledger.error) return c.json({ error: 'load_failed', reason: String((ledger.error as { message?: string }).message ?? ledger.error) }, 500);
  const lines = (ledger.data ?? []).filter((l) => codeSet.has(l.account_code));
  const period = lines.filter((l) => l.entry_date >= from);
  const counted = (l: GlLine): boolean => !isReversalPair(l);

  /* The other side of each entry of the period: every line of those entries.
     When the whole chart is in scope the read above already holds them. */
  const jeNoSet = new Set(period.map((l) => l.je_no));
  const jeNos = [...jeNoSet];
  const entryLines = new Map<string, GlLine[]>();
  const remember = (l: GlLine) => { const at = entryLines.get(l.je_no) ?? []; at.push(l); entryLines.set(l.je_no, at); };
  if (readAll) {
    for (const l of ledger.data ?? []) if (jeNoSet.has(l.je_no)) remember(l);
  } else {
    for (const ns of chunks(jeNos)) {
      const { data, error } = await sb.from('v_gl_entries').select(SELECT).eq('company_id', co.companyId).in('je_no', ns);
      if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
      for (const l of (data ?? []) as GlLine[]) remember(l);
    }
  }

  /* What each entry is called: the narration, the document handles, the who. */
  const narration = new Map<string, string | null>();
  for (const ns of chunks(jeNos)) {
    const { data, error } = await sb.from('journal_entries').select('je_no, narration').eq('company_id', co.companyId).in('je_no', ns);
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    for (const j of (data ?? []) as Array<{ je_no: string; narration: string | null }>) narration.set(j.je_no, j.narration ?? null);
  }
  const partyOf = (jeNo: string): string | null => (entryLines.get(jeNo) ?? []).map((l) => l.party_name).find((p) => p != null && p !== '') ?? null;
  const refs = await resolveJournalRefs(sb, co.companyId, jeNos.map((jeNo) => {
    const first = (entryLines.get(jeNo) ?? [])[0];
    return { jeNo, sourceType: first ? first.source_type : null, sourceDocNo: first ? first.source_doc_no : null, partyName: partyOf(jeNo), notes: narration.get(jeNo) ?? null };
  }));
  if (!refs.ok) return c.json({ error: 'load_failed', reason: refs.reason }, 500);
  const cash = (await resolveRoles(sb, co.companyId)).CASH;

  const blocks: LedgerBlock[] = [];
  for (const a of scoped) {
    const mine = lines.filter((l) => l.account_code === a.account_code);
    const before = mine.filter((l) => l.entry_date < from && counted(l));
    const opening = naturalSen(a.account_type, before.reduce((s, l) => s + Number(l.debit_sen), 0), before.reduce((s, l) => s + Number(l.credit_sen), 0));
    const inPeriod = mine.filter((l) => l.entry_date >= from && (showReversed || counted(l))).sort(byDateThenEntry);
    if (inPeriod.length === 0 && opening === 0) continue;
    let balance = opening;
    let dr = 0;
    let cr = 0;
    const out: LedgerLine[] = inPeriod.map((l) => {
      const counts = counted(l);
      const debitSen = Number(l.debit_sen);
      const creditSen = Number(l.credit_sen);
      if (counts) {
        dr += debitSen;
        cr += creditSen;
        balance += naturalSen(a.account_type, debitSen, creditSen);
      }
      const ref = refs.refs.get(l.je_no);
      const entry = entryLines.get(l.je_no) ?? [l];
      return {
        lineId: String(l.line_id),
        date: String(l.entry_date).slice(0, 10),
        jeNo: l.je_no,
        journal: classifyJournal(l.source_type, entry.map((x) => x.account_code), cash),
        counter: counterOf(l, entry),
        doc: ref?.doc ?? l.source_doc_no ?? null,
        doc2: ref?.doc2 ?? null,
        description: (l.notes && String(l.notes)) || narration.get(l.je_no) || null,
        who: ref?.who ?? l.party_name ?? null,
        debitSen,
        creditSen,
        balanceSen: balance,
        reversal: l.reversed === true ? 'reversed' : l.reversed_by_je != null ? 'contra' : '',
      };
    });
    blocks.push({ code: a.account_code, name: a.account_name, type: a.account_type, openingSen: opening, lines: out, debitSen: dr, creditSen: cr, closingSen: balance });
  }

  const report: LedgerReport = {
    from, to, showReversed,
    scope: { codes: picked, fromCode, toCode, all },
    blocks,
    totals: { debitSen: blocks.reduce((s, b) => s + b.debitSen, 0), creditSen: blocks.reduce((s, b) => s + b.creditSen, 0) },
  };
  return c.json(report);
};
