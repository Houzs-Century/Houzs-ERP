// ----------------------------------------------------------------------------
// accounting-opening — Finance › Setup › Opening Balance (owner 2026-10-28:
// 「然后确定一下我是会有一个opening balance maintainence 表是吗？」, 「这个你帮我
// 导入哦」 — the import (scripts/open-houzs-books-start.mjs) fills it, this page
// keeps it until he calls the old book's last day final and locks it).
//
//   GET    /opening                          the whole opening: accounts, stock,
//                                            creditors, other debtors, the check
//   PUT    /opening/accounts                 the account lines, re-posted
//   PUT    /opening/stock                    the opening stock per bucket, re-posted
//   POST   /opening/papers                   a new opening paper (API/SCN/ODB/ODR)
//   PATCH  /opening/papers/:kind/:id         a paper's date / reference / amount
//   POST   /opening/papers/:kind/:id/cancel  a paper nothing has touched
//   POST   /opening/lock | /opening/unlock   the opening is final / open again
//
// Every write re-posts through the one gate (acc/engine.ts) with the `opening`
// flag, so the books count it whatever its date (mig 20261028T2100); a locked
// opening refuses them all. The rules are acc/opening-balance.ts.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { companyDocPrefix, requireActiveCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { docMonthTag, mintMonthlyDocNo } from '../lib/doc-no';
import { coerceEmptyDates, dateOrNull } from '../lib/date-coerce';
import { fmtSen } from '../shared/format';
import { compactChanges, fieldChange, recordEntityAudit } from '../lib/entity-audit';
import { postJournal, reverseJournal } from '../../acc/engine';
import { CONTROL_ROLES, STOCK_BUCKET_ROLES, apControlRole, resolveRoles, type AccountRole } from '../../acc/rules';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { loadBooksOpening, type BooksOpening } from '../../acc/books-opening';
import {
  OPENING_CLEARING, OPENING_PAPER_KINDS, OPENING_SOURCE, checkAccountLines, checkStock, openingJournalLines, openingPaperLines,
  type OpeningAccountLine, type OpeningPaperKind,
} from '../../acc/opening-balance';
import { STOCK_BUCKETS, type StockBucket } from '../lib/stock-bucket';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped in this family */
type Row = Record<string, any>;

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to keep the opening balance." };
const who = (c: any): string => String(c.get('houzsUser')?.name ?? c.get('user')?.id ?? '');
const LOCKED = (o: BooksOpening) => ({ error: 'opening_locked', message: `The opening is locked (${o.lockedBy ?? 'by Finance'}) — unlock it first.` });
const NO_OPENING = { error: 'no_opening', message: 'This company has no opening yet — its books have no start day.' };

/** The paper tables, by kind. */
const PAPER = {
  API: { table: 'ap_invoices', no: 'invoice_number', date: 'invoice_date', party: 'supplier_id', lines: 'ap_invoice_lines', lineFk: 'invoice_id', lineAccount: 'debit_account_code', word: 'AP invoice' },
  SCN: { table: 'acc_credit_notes', no: 'note_number', date: 'note_date', party: 'supplier_id', lines: 'acc_credit_note_lines', lineFk: 'note_id', lineAccount: 'account_code', word: 'Supplier credit note' },
  ODB: { table: 'acc_debtor_bills', no: 'bill_number', date: 'bill_date', party: 'debtor_id', lines: 'acc_debtor_bill_lines', lineFk: 'bill_id', lineAccount: 'credit_account_code', word: 'Debtor bill' },
  ODR: { table: 'acc_debtor_receipts', no: 'receipt_number', date: 'receipt_date', party: 'debtor_id', lines: null, lineFk: null, lineAccount: null, word: 'Debtor receipt' },
} as const satisfies Record<OpeningPaperKind, unknown>;

type Paper = { id: string; kind: OpeningPaperKind; no: string; partyId: string; date: string; ref: string | null; amountSen: number; settledSen: number; status: string; note: string | null };

/** What has already come off a paper: payments on a bill, knock-offs of a credit, receipts on a debtor bill, allocations of a receipt. */
async function settledOf(sb: any, companyId: number, kind: OpeningPaperKind, rows: Row[]): Promise<{ ok: true; of: Map<string, number> } | { ok: false; reason: string }> {
  const of = new Map<string, number>();
  if (kind === 'API') { for (const r of rows) of.set(String(r.id), Number(r.paid_sen ?? 0)); return { ok: true, of }; }
  if (kind === 'ODB') { for (const r of rows) of.set(String(r.id), Number(r.received_sen ?? 0)); return { ok: true, of }; }
  const ids = rows.map((r) => String(r.id));
  const table = kind === 'SCN' ? 'acc_credit_note_allocations' : 'acc_debtor_receipt_allocations';
  const fk = kind === 'SCN' ? 'note_id' : 'receipt_id';
  const col = kind === 'SCN' ? 'applied_sen' : 'amount_sen';
  const { data, error } = await chunkIn<Row>(ids, (batch, from, to) => sb.from(table).select(`${fk}, ${col}`).eq('company_id', companyId).in(fk, batch).order(fk).range(from, to));
  if (error) return { ok: false, reason: `${table}: ${error.message}` };
  for (const a of data) of.set(String(a[fk]), (of.get(String(a[fk])) ?? 0) + Number(a[col] ?? 0));
  return { ok: true, of };
}

async function loadPapers(sb: any, companyId: number, kind: OpeningPaperKind): Promise<{ ok: true; papers: Paper[] } | { ok: false; reason: string }> {
  const t = PAPER[kind];
  const cols = kind === 'API' ? 'id, invoice_number, supplier_id, supplier_invoice_ref, invoice_date, total_sen, paid_sen, status, notes'
    : kind === 'SCN' ? 'id, note_number, supplier_id, source_doc_no, note_date, total_sen, status, notes'
    : kind === 'ODB' ? 'id, bill_number, debtor_id, bill_date, total_sen, received_sen, status, notes'
    : 'id, receipt_number, debtor_id, receipt_date, total_sen, status, notes';
  const { data, error } = await paginateAll<Row>((f, to) => {
    let q = sb.from(t.table).select(cols).eq('company_id', companyId).eq('opening', true).neq('status', 'CANCELLED');
    if (kind === 'SCN') q = q.eq('kind', 'SCN');
    return q.order('id').range(f, to);
  });
  if (error) return { ok: false, reason: `${t.table}: ${(error as { message?: string }).message ?? error}` };
  const rows = (data ?? []) as Row[];
  const settled = await settledOf(sb, companyId, kind, rows);
  if (!settled.ok) return settled;
  return {
    ok: true,
    papers: rows.map((r) => ({
      id: String(r.id), kind, no: String(r[t.no]), partyId: String(r[t.party]), date: String(r[t.date]).slice(0, 10),
      ref: (kind === 'API' ? r.supplier_invoice_ref : kind === 'SCN' ? r.source_doc_no : null) ?? null,
      amountSen: Number(r.total_sen ?? 0), settledSen: settled.of.get(String(r.id)) ?? 0, status: String(r.status), note: r.notes ?? null,
    })),
  };
}

/** The live OPENING journal and its lines. */
async function loadOpeningJournal(sb: any, companyId: number): Promise<{ ok: true; je: Row | null; lines: Row[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('journal_entries').select('id, je_no, entry_date, source_doc_no')
    .eq('company_id', companyId).eq('source_type', OPENING_SOURCE).eq('posted', true).eq('reversed', false).is('reversed_by_je', null);
  if (error) return { ok: false, reason: `opening journal: ${error.message}` };
  const live = (data ?? []) as Row[];
  if (live.length > 1) return { ok: false, reason: `${live.length} opening journals stand (${live.map((j) => j.je_no).join(', ')}) — there must be one` };
  if (live.length === 0) return { ok: true, je: null, lines: [] };
  const { data: lines, error: lErr } = await sb.from('journal_entry_lines').select('account_code, debit_sen, credit_sen').eq('journal_entry_id', live[0]!.id).order('line_no');
  if (lErr) return { ok: false, reason: `opening journal lines: ${lErr.message}` };
  return { ok: true, je: live[0]!, lines: (lines ?? []) as Row[] };
}

const stockCodesOf = (roles: Record<AccountRole, string>): Record<StockBucket, string> =>
  Object.fromEntries(STOCK_BUCKETS.map((b) => [b, roles[STOCK_BUCKET_ROLES[b].opening]])) as Record<StockBucket, string>;

/** Every account the opening journal may not carry, and the sentence that says why. */
async function refusedAccounts(sb: any, companyId: number, roles: Record<AccountRole, string>): Promise<{ ok: true; known: Set<string>; refused: Map<string, string>; names: Map<string, Row> } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('accounts').select('account_code, account_name, account_type, section, parent_code, is_active').eq('company_id', companyId);
  if (error) return { ok: false, reason: `chart: ${error.message}` };
  const chart = (data ?? []) as Row[];
  const parents = new Set(chart.map((a) => a.parent_code).filter(Boolean).map(String));
  const refused = new Map<string, string>();
  for (const a of chart) {
    if (parents.has(String(a.account_code))) refused.set(String(a.account_code), 'is a header account — post to its children.');
    else if (a.is_active === false) refused.set(String(a.account_code), 'is deactivated on the chart.');
  }
  for (const r of CONTROL_ROLES) refused.set(roles[r], 'is a control account — its opening is the creditors / other debtors papers.');
  const stockRoles = [roles.INVENTORY, roles.CLOSING_STOCK, ...STOCK_BUCKETS.flatMap((b) => [roles[STOCK_BUCKET_ROLES[b].inventory], roles[STOCK_BUCKET_ROLES[b].opening], roles[STOCK_BUCKET_ROLES[b].closing]])];
  for (const code of stockRoles) refused.set(code, 'is a stock account — the opening stock is set on the Stock tab.');
  refused.set(OPENING_CLEARING, 'is the opening\'s own clearing account — it balances itself.');
  return { ok: true, known: new Set(chart.map((a) => String(a.account_code))), refused, names: new Map(chart.map((a) => [String(a.account_code), a])) };
}

/** The clearing over every date the books count: nil when the opening balances. */
async function clearingBalance(sb: any, companyId: number): Promise<{ ok: true; sen: number } | { ok: false; reason: string }> {
  const { data, error } = await paginateAll<Row>((f, t) => sb.from('v_gl_entries').select('debit_sen, credit_sen, posted, reversed, reversed_by_je')
    .eq('company_id', companyId).eq('account_code', OPENING_CLEARING).order('line_id').range(f, t));
  if (error) return { ok: false, reason: `clearing: ${(error as { message?: string }).message ?? error}` };
  return { ok: true, sen: ((data ?? []) as Row[]).filter((r) => countsInTheBooks(r)).reduce((s, r) => s + Number(r.debit_sen ?? 0) - Number(r.credit_sen ?? 0), 0) };
}

/* ── GET /opening ──────────────────────────────────────────────────────────── */
export const openingGet = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const books = await loadBooksOpening(sb, co.companyId);
  if (!books.ok) return c.json({ error: 'load_failed', reason: books.reason }, 500);
  const o = books.opening;
  if (!o) return c.json({ booksStart: null });
  const roles = await resolveRoles(sb, co.companyId);
  const [je, chart, clearing, ...papers] = await Promise.all([
    loadOpeningJournal(sb, co.companyId), refusedAccounts(sb, co.companyId, roles), clearingBalance(sb, co.companyId),
    ...OPENING_PAPER_KINDS.map((k) => loadPapers(sb, co.companyId, k)),
  ]);
  if (!je.ok) return c.json({ error: 'load_failed', reason: je.reason }, 500);
  if (!chart.ok) return c.json({ error: 'load_failed', reason: chart.reason }, 500);
  if (!clearing.ok) return c.json({ error: 'load_failed', reason: clearing.reason }, 500);
  for (const p of papers) if (!p.ok) return c.json({ error: 'load_failed', reason: p.reason }, 500);
  const all = papers.flatMap((p) => (p.ok ? p.papers : []));

  const stockCodes = stockCodesOf(roles);
  const stockSet = new Set(Object.values(stockCodes));
  const accounts = je.lines.filter((l) => l.account_code !== OPENING_CLEARING && !stockSet.has(String(l.account_code)))
    .map((l) => {
      const a = chart.names.get(String(l.account_code));
      return { code: String(l.account_code), name: a?.account_name ?? String(l.account_code), type: a?.account_type ?? null, section: a?.section ?? null, drSen: Number(l.debit_sen ?? 0), crSen: Number(l.credit_sen ?? 0) };
    });

  /* The parties, named. */
  const supplierIds = [...new Set(all.filter((p) => p.kind === 'API' || p.kind === 'SCN').map((p) => p.partyId))];
  const debtorIds = [...new Set(all.filter((p) => p.kind === 'ODB' || p.kind === 'ODR').map((p) => p.partyId))];
  const [sups, debs] = await Promise.all([
    chunkIn<Row>(supplierIds, (batch, f, t) => sb.from('suppliers').select('id, code, name').eq('company_id', co.companyId).in('id', batch).order('id').range(f, t)),
    chunkIn<Row>(debtorIds, (batch, f, t) => sb.from('acc_debtors').select('id, name').eq('company_id', co.companyId).in('id', batch).order('id').range(f, t)),
  ]);
  if (sups.error) return c.json({ error: 'load_failed', reason: `suppliers: ${sups.error.message}` }, 500);
  if (debs.error) return c.json({ error: 'load_failed', reason: `debtors: ${debs.error.message}` }, 500);
  const supBy = new Map(sups.data.map((s) => [String(s.id), s]));
  const debBy = new Map(debs.data.map((d) => [String(d.id), d]));
  const group = (kinds: OpeningPaperKind[], owe: OpeningPaperKind) => {
    const by = new Map<string, Paper[]>();
    for (const p of all.filter((x) => kinds.includes(x.kind))) by.set(p.partyId, [...(by.get(p.partyId) ?? []), p]);
    return [...by].map(([id, ps]) => {
      const debit = ps.filter((p) => p.kind === owe).reduce((s, p) => s + p.amountSen, 0);
      const credit = ps.filter((p) => p.kind !== owe).reduce((s, p) => s + p.amountSen, 0);
      const party = owe === 'API' ? supBy.get(id) : debBy.get(id);
      return {
        partyId: id, code: party?.code ?? null, name: party?.name ?? '(unknown)',
        ...(owe === 'API' ? { control: roles[apControlRole(party?.code ?? null)] } : {}),
        owingSen: debit, creditSen: credit, netSen: debit - credit,
        papers: ps.sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no)),
      };
    }).sort((a, b) => String(a.code ?? a.name).localeCompare(String(b.code ?? b.name)));
  };

  return c.json({
    booksStart: o.booksStart,
    openingDate: o.openingDate,
    locked: o.lockedAt ? { at: o.lockedAt, by: o.lockedBy } : null,
    journal: je.je ? { jeNo: je.je.je_no, date: String(je.je.entry_date).slice(0, 10) } : null,
    accounts,
    stock: { buckets: o.stock, totalSen: o.stockTotalSen, codes: stockCodes },
    creditors: group(['API', 'SCN'], 'API'),
    debtors: group(['ODB', 'ODR'], 'ODB'),
    check: { clearingCode: OPENING_CLEARING, clearingSen: clearing.sen },
  });
};

/* ── re-posting the OPENING journal ───────────────────────────────────────── */

async function rePostOpening(sb: any, companyId: number, o: BooksOpening, docNo: string, lines: ReturnType<typeof openingJournalLines>, actor: string): Promise<{ ok: true; jeNo: string } | { ok: false; reason: string }> {
  const rev = await reverseJournal(sb, {
    sourceType: OPENING_SOURCE, sourceDocNo: docNo, companyId,
    narration: (orig) => `Reversal of ${orig.je_no} — the opening changed on the Opening Balance page`,
    onOriginalDate: true, opening: true,
  });
  if (!rev.ok) return { ok: false, reason: `reverse: ${rev.reason ?? rev.status}` };
  const je = await postJournal(sb, {
    companyId, entryDate: o.openingDate, sourceType: OPENING_SOURCE, sourceDocNo: docNo, opening: true, lines,
    narration: `Opening balances at ${o.openingDate} — kept on the Opening Balance page (${actor})`,
  });
  if (!je.ok) return { ok: false, reason: `post: ${(je as { reason?: string }).reason ?? je.status}` };
  return { ok: true, jeNo: je.jeNo };
}

/** What a write needs first: the permission, the company, an opening, unlocked. */
async function openForWrites(c: any): Promise<{ resp: Response } | { companyId: number; sb: any; o: BooksOpening; roles: Record<AccountRole, string> }> {
  if (!requirePerm(c)) return { resp: c.json(NO_PERM, 403) };
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { resp: c.json(co.refusal, 409) };
  const sb = c.get('supabase');
  const books = await loadBooksOpening(sb, co.companyId);
  if (!books.ok) return { resp: c.json({ error: 'load_failed', reason: books.reason }, 500) };
  if (!books.opening) return { resp: c.json(NO_OPENING, 409) };
  if (books.opening.lockedAt) return { resp: c.json(LOCKED(books.opening), 409) };
  return { companyId: co.companyId, sb, o: books.opening, roles: await resolveRoles(sb, co.companyId) };
}

/* ── PUT /opening/accounts { lines: [{ code, drSen, crSen }] } ─────────────── */
export const openingAccountsPut = async (c: any): Promise<Response> => {
  const w = await openForWrites(c);
  if ('resp' in w) return w.resp;
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const lines: OpeningAccountLine[] = (Array.isArray(body?.lines) ? body.lines : [])
    .map((l: any) => ({ code: String(l?.code ?? '').trim(), drSen: Number(l?.drSen ?? 0), crSen: Number(l?.crSen ?? 0) }));
  const chart = await refusedAccounts(w.sb, w.companyId, w.roles);
  if (!chart.ok) return c.json({ error: 'load_failed', reason: chart.reason }, 500);
  const bad = checkAccountLines(lines, chart.known, chart.refused);
  if (bad) return c.json({ error: 'bad_line', message: bad }, 400);
  const je = await loadOpeningJournal(w.sb, w.companyId);
  if (!je.ok) return c.json({ error: 'load_failed', reason: je.reason }, 500);
  const docNo = je.je ? String(je.je.source_doc_no) : `OPENING-${w.companyId}-${w.o.openingDate}`;
  const posted = await rePostOpening(w.sb, w.companyId, w.o, docNo, openingJournalLines(lines, w.o.stock, stockCodesOf(w.roles)), who(c));
  if (!posted.ok) return c.json({ error: 'post_failed', reason: posted.reason }, 500);
  await recordEntityAudit(w.sb, {
    entityType: 'OPENING_BALANCE', entityId: String(w.companyId), entityDocNo: docNo, action: 'UPDATE', actor: c.get('houzsUser'), companyId: w.companyId,
    note: `Opening accounts re-posted as ${posted.jeNo} (${lines.length} lines)`, fieldChanges: [],
  });
  return c.json({ ok: true, jeNo: posted.jeNo });
};

/* ── PUT /opening/stock { buckets: { customer: sen, … } } ─────────────────── */
export const openingStockPut = async (c: any): Promise<Response> => {
  const w = await openForWrites(c);
  if ('resp' in w) return w.resp;
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const checked = checkStock(body?.buckets ?? {});
  if (!checked.ok) return c.json({ error: 'bad_stock', message: checked.message }, 400);
  const je = await loadOpeningJournal(w.sb, w.companyId);
  if (!je.ok) return c.json({ error: 'load_failed', reason: je.reason }, 500);
  const stockCodes = stockCodesOf(w.roles);
  const stockSet = new Set(Object.values(stockCodes));
  const accounts: OpeningAccountLine[] = je.lines.filter((l) => l.account_code !== OPENING_CLEARING && !stockSet.has(String(l.account_code)))
    .map((l) => ({ code: String(l.account_code), drSen: Number(l.debit_sen ?? 0), crSen: Number(l.credit_sen ?? 0) }));
  const stored = Object.fromEntries(STOCK_BUCKETS.filter((b) => checked.stock[b] !== 0).map((b) => [b, checked.stock[b]]));
  const { error } = await w.sb.from('acc_company_settings').update({ opening_stock: stored, updated_at: new Date().toISOString(), updated_by: who(c) }).eq('company_id', w.companyId);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  const docNo = je.je ? String(je.je.source_doc_no) : `OPENING-${w.companyId}-${w.o.openingDate}`;
  const posted = await rePostOpening(w.sb, w.companyId, w.o, docNo, openingJournalLines(accounts, checked.stock, stockCodes), who(c));
  if (!posted.ok) return c.json({ error: 'post_failed', reason: posted.reason }, 500);
  await recordEntityAudit(w.sb, {
    entityType: 'OPENING_BALANCE', entityId: String(w.companyId), entityDocNo: docNo, action: 'UPDATE', actor: c.get('houzsUser'), companyId: w.companyId,
    note: `Opening stock set to ${STOCK_BUCKETS.map((b) => `${b} ${fmtSen(checked.stock[b])}`).join(', ')}; re-posted as ${posted.jeNo}`,
    fieldChanges: compactChanges([fieldChange('openingStockSen', w.o.stockTotalSen, STOCK_BUCKETS.reduce((s, b) => s + checked.stock[b], 0))]),
  });
  return c.json({ ok: true, jeNo: posted.jeNo });
};

/* ── the papers ────────────────────────────────────────────────────────────── */

const isKind = (k: unknown): k is OpeningPaperKind => (OPENING_PAPER_KINDS as readonly unknown[]).includes(k);

/** The party a paper is for: a supplier (API/SCN) or an other debtor (ODB/ODR). */
async function partyOf(sb: any, companyId: number, kind: OpeningPaperKind, id: string): Promise<{ ok: true; party: { id: string; code: string | null; name: string } } | { ok: false; message: string }> {
  const supplier = kind === 'API' || kind === 'SCN';
  const { data, error } = await sb.from(supplier ? 'suppliers' : 'acc_debtors').select(supplier ? 'id, code, name' : 'id, name').eq('company_id', companyId).eq('id', id).maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: `That ${supplier ? 'supplier' : 'other debtor'} is not in the company you are working in.` };
  return { ok: true, party: { id: String(data.id), code: supplier ? (data.code ?? null) : null, name: String(data.name ?? '') } };
}

const controlOf = (roles: Record<AccountRole, string>, kind: OpeningPaperKind, code: string | null): string =>
  kind === 'API' || kind === 'SCN' ? roles[apControlRole(code)] : roles.AR_OTHER;

/* ── POST /opening/papers { kind, partyId, date, ref?, amountSen, note? } ─── */
export const openingPaperCreate = async (c: any): Promise<Response> => {
  const w = await openForWrites(c);
  if ('resp' in w) return w.resp;
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const kind = String(body?.kind ?? '').toUpperCase();
  if (!isKind(kind)) return c.json({ error: 'bad_kind', message: 'kind is API, SCN, ODB or ODR.' }, 400);
  const date = dateOrNull(body?.date);
  if (!date || date > w.o.openingDate) return c.json({ error: 'bad_date', message: `An opening paper is dated ${w.o.openingDate} or before.` }, 400);
  const amountSen = Number(body?.amountSen);
  if (!Number.isSafeInteger(amountSen) || amountSen <= 0) return c.json({ error: 'bad_amount', message: 'amountSen must be a positive whole number of sen.' }, 400);
  const party = await partyOf(w.sb, w.companyId, kind, String(body?.partyId ?? ''));
  if (!party.ok) return c.json({ error: 'party_unknown', message: party.message }, 400);
  const ref = body?.ref ? String(body.ref).trim().slice(0, 120) : null;
  const note = body?.note ? String(body.note).trim().slice(0, 500) : `Opening ${w.o.openingDate} — added on the Opening Balance page`;
  const t = PAPER[kind];
  const docNo = await mintMonthlyDocNo(w.sb, t.table, t.no, `${companyDocPrefix(c)}${kind}-${docMonthTag(date)}`);
  const now = new Date().toISOString();
  const head: Row = kind === 'API'
    ? { invoice_number: docNo, supplier_id: party.party.id, supplier_invoice_ref: ref, invoice_date: date, currency: 'MYR', exchange_rate: 1, total_sen: amountSen, paid_sen: 0, status: 'POSTED', notes: note, created_by: who(c), posted_at: now, posted_by: who(c) }
    : kind === 'SCN'
      ? { note_number: docNo, kind: 'SCN', party_type: 'SUPPLIER', party_code: party.party.code, party_name: party.party.name, supplier_id: party.party.id, source_doc_no: ref, note_date: date, total_sen: amountSen, reason: note.slice(0, 300), notes: note, status: 'POSTED', created_by: who(c), posted_at: now, posted_by: who(c) }
      : kind === 'ODB'
        ? { bill_number: docNo, debtor_id: party.party.id, bill_date: date, total_sen: amountSen, received_sen: 0, status: 'POSTED', notes: note, created_by: who(c) }
        : { receipt_number: docNo, debtor_id: party.party.id, receipt_date: date, bank_account_code: OPENING_CLEARING, total_sen: amountSen, status: 'POSTED', approved_at: now, approved_by: who(c), posted_at: now, notes: note, created_by: who(c) };
  const { data: row, error } = await w.sb.from(t.table).insert({ company_id: w.companyId, ...head, opening: true }).select('id').single();
  if (error || !row) return c.json({ error: 'save_failed', reason: error?.message ?? 'insert returned nothing' }, 500);
  if (t.lines) {
    const { error: lErr } = await w.sb.from(t.lines).insert({ company_id: w.companyId, [t.lineFk!]: row.id, line_no: 1, description: note, [t.lineAccount!]: OPENING_CLEARING, amount_sen: amountSen });
    if (lErr) { await w.sb.from(t.table).delete().eq('company_id', w.companyId).eq('id', row.id); return c.json({ error: 'save_failed', reason: lErr.message }, 500); }
  }
  const je = await postJournal(w.sb, {
    companyId: w.companyId, entryDate: date, sourceType: kind, sourceDocNo: docNo, opening: true,
    narration: `${t.word} ${docNo} — ${party.party.name} — opening ${w.o.openingDate}`,
    lines: openingPaperLines(kind, { docNo, amountSen, party: party.party, control: controlOf(w.roles, kind, party.party.code) }),
  });
  if (!je.ok) {
    if (t.lines) await w.sb.from(t.lines).delete().eq('company_id', w.companyId).eq(t.lineFk!, row.id);
    await w.sb.from(t.table).delete().eq('company_id', w.companyId).eq('id', row.id);
    return c.json({ error: 'post_failed', reason: (je as { reason?: string }).reason ?? je.status }, 500);
  }
  if (kind === 'SCN') await w.sb.from(t.table).update({ je_no: je.jeNo }).eq('company_id', w.companyId).eq('id', row.id);
  await recordEntityAudit(w.sb, { entityType: 'OPENING_BALANCE', entityId: String(row.id), entityDocNo: docNo, action: 'CREATE', actor: c.get('houzsUser'), companyId: w.companyId,
    note: `Opening ${t.word.toLowerCase()} ${docNo} for ${party.party.name}, ${fmtSen(amountSen)}`, fieldChanges: [] });
  return c.json({ ok: true, id: row.id, docNo, jeNo: je.jeNo }, 201);
};

/** One opening paper, with what has come off it. */
async function loadPaper(sb: any, companyId: number, kind: OpeningPaperKind, id: string): Promise<{ ok: true; paper: Paper } | { ok: false; status: number; body: Row }> {
  const all = await loadPapers(sb, companyId, kind);
  if (!all.ok) return { ok: false, status: 500, body: { error: 'load_failed', reason: all.reason } };
  const paper = all.papers.find((p) => p.id === id);
  if (!paper) return { ok: false, status: 404, body: { error: 'not_found', message: 'That opening paper is not in the company you are working in (or it is cancelled).' } };
  return { ok: true, paper };
}

/* ── PATCH /opening/papers/:kind/:id { date?, ref?, amountSen?, note? } ───── */
export const openingPaperUpdate = async (c: any): Promise<Response> => {
  const w = await openForWrites(c);
  if ('resp' in w) return w.resp;
  const kind = String(c.req.param('kind') ?? '').toUpperCase();
  if (!isKind(kind)) return c.json({ error: 'bad_kind', message: 'kind is API, SCN, ODB or ODR.' }, 400);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const got = await loadPaper(w.sb, w.companyId, kind, String(c.req.param('id')));
  if (!got.ok) return c.json(got.body, got.status);
  const p = got.paper;
  const date = body?.date !== undefined ? dateOrNull(body.date) : p.date;
  if (!date || date > w.o.openingDate) return c.json({ error: 'bad_date', message: `An opening paper is dated ${w.o.openingDate} or before.` }, 400);
  const amountSen = body?.amountSen !== undefined ? Number(body.amountSen) : p.amountSen;
  if (!Number.isSafeInteger(amountSen) || amountSen <= 0) return c.json({ error: 'bad_amount', message: 'amountSen must be a positive whole number of sen.' }, 400);
  if (amountSen < p.settledSen) return c.json({ error: 'below_settled', message: `${p.no} already has ${fmtSen(p.settledSen)} settled against it — it cannot fall below that.` }, 409);
  const t = PAPER[kind];
  const patch: Row = { [t.date]: dateOrNull(date), total_sen: amountSen };
  if (body?.ref !== undefined && (kind === 'API' || kind === 'SCN')) patch[kind === 'API' ? 'supplier_invoice_ref' : 'source_doc_no'] = body.ref ? String(body.ref).trim().slice(0, 120) : null;
  if (body?.note !== undefined) patch.notes = body.note ? String(body.note).trim().slice(0, 500) : null;
  if (kind === 'API') patch.status = p.settledSen >= amountSen ? 'PAID' : p.settledSen > 0 ? 'PARTIALLY_PAID' : 'POSTED';
  if (kind === 'ODB') patch.status = p.settledSen >= amountSen ? 'PAID' : 'POSTED';
  if (kind === 'API' || kind === 'SCN') patch.updated_at = new Date().toISOString();
  const { error } = await w.sb.from(t.table).update(coerceEmptyDates(patch)).eq('company_id', w.companyId).eq('id', p.id);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (t.lines) {
    const { error: lErr } = await w.sb.from(t.lines).update({ amount_sen: amountSen }).eq('company_id', w.companyId).eq(t.lineFk!, p.id);
    if (lErr) return c.json({ error: 'save_failed', reason: lErr.message }, 500);
  }
  const party = await partyOf(w.sb, w.companyId, kind, p.partyId);
  if (!party.ok) return c.json({ error: 'party_unknown', message: party.message }, 400);
  const rev = await reverseJournal(w.sb, {
    sourceType: kind, sourceDocNo: p.no, companyId: w.companyId, onOriginalDate: true, opening: true,
    narration: (orig) => `Reversal of ${orig.je_no} — opening ${t.word.toLowerCase()} ${p.no} changed`,
  });
  if (!rev.ok) return c.json({ error: 'reverse_failed', reason: rev.reason ?? rev.status }, 500);
  const je = await postJournal(w.sb, {
    companyId: w.companyId, entryDate: date, sourceType: kind, sourceDocNo: p.no, opening: true,
    narration: `${t.word} ${p.no} — ${party.party.name} — opening ${w.o.openingDate} (changed)`,
    lines: openingPaperLines(kind, { docNo: p.no, amountSen, party: party.party, control: controlOf(w.roles, kind, party.party.code) }),
  });
  if (!je.ok) return c.json({ error: 'post_failed', reason: (je as { reason?: string }).reason ?? je.status }, 500);
  if (kind === 'SCN') await w.sb.from(t.table).update({ je_no: je.jeNo }).eq('company_id', w.companyId).eq('id', p.id);
  await recordEntityAudit(w.sb, { entityType: 'OPENING_BALANCE', entityId: p.id, entityDocNo: p.no, action: 'UPDATE', actor: c.get('houzsUser'), companyId: w.companyId,
    note: `Opening ${t.word.toLowerCase()} ${p.no} re-posted as ${je.jeNo}`,
    fieldChanges: compactChanges([fieldChange('amountSen', p.amountSen, amountSen), fieldChange('date', p.date, date)]) });
  return c.json({ ok: true, jeNo: je.jeNo });
};

/* ── POST /opening/papers/:kind/:id/cancel ─────────────────────────────────── */
export const openingPaperCancel = async (c: any): Promise<Response> => {
  const w = await openForWrites(c);
  if ('resp' in w) return w.resp;
  const kind = String(c.req.param('kind') ?? '').toUpperCase();
  if (!isKind(kind)) return c.json({ error: 'bad_kind', message: 'kind is API, SCN, ODB or ODR.' }, 400);
  const got = await loadPaper(w.sb, w.companyId, kind, String(c.req.param('id')));
  if (!got.ok) return c.json(got.body, got.status);
  const p = got.paper;
  if (p.settledSen > 0) return c.json({ error: 'settled', message: `${p.no} has ${fmtSen(p.settledSen)} settled against it — take that off first.` }, 409);
  const t = PAPER[kind];
  const rev = await reverseJournal(w.sb, {
    sourceType: kind, sourceDocNo: p.no, companyId: w.companyId, onOriginalDate: true, opening: true,
    narration: (orig) => `Reversal of ${orig.je_no} — opening ${t.word.toLowerCase()} ${p.no} cancelled`,
  });
  if (!rev.ok) return c.json({ error: 'reverse_failed', reason: rev.reason ?? rev.status }, 500);
  const now = new Date().toISOString();
  const patch: Row = kind === 'API' || kind === 'SCN' ? { status: 'CANCELLED', cancelled_at: now, cancelled_by: who(c), updated_at: now } : { status: 'CANCELLED' };
  const { error } = await w.sb.from(t.table).update(coerceEmptyDates(patch)).eq('company_id', w.companyId).eq('id', p.id);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  await recordEntityAudit(w.sb, { entityType: 'OPENING_BALANCE', entityId: p.id, entityDocNo: p.no, action: 'CANCEL', actor: c.get('houzsUser'), companyId: w.companyId,
    note: `Opening ${t.word.toLowerCase()} ${p.no} cancelled (${fmtSen(p.amountSen)})`, fieldChanges: compactChanges([fieldChange('status', p.status, 'CANCELLED')]) });
  return c.json({ ok: true });
};

/* ── POST /opening/lock · /opening/unlock ──────────────────────────────────── */
export const openingLock = async (c: any): Promise<Response> => {
  const w = await openForWrites(c);
  if ('resp' in w) return w.resp;
  const clearing = await clearingBalance(w.sb, w.companyId);
  if (!clearing.ok) return c.json({ error: 'load_failed', reason: clearing.reason }, 500);
  if (clearing.sen !== 0) return c.json({ error: 'not_balanced', message: `The opening does not balance: ${OPENING_CLEARING} reads ${fmtSen(clearing.sen)} — it must be nil to lock.` }, 409);
  const { error } = await w.sb.from('acc_company_settings').update({ opening_locked_at: new Date().toISOString(), opening_locked_by: who(c) }).eq('company_id', w.companyId);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  await recordEntityAudit(w.sb, { entityType: 'OPENING_BALANCE', entityId: String(w.companyId), action: 'UPDATE', actor: c.get('houzsUser'), companyId: w.companyId, note: `Opening ${w.o.openingDate} locked`, fieldChanges: [] });
  return c.json({ ok: true });
};

export const openingUnlock = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const books = await loadBooksOpening(sb, co.companyId);
  if (!books.ok) return c.json({ error: 'load_failed', reason: books.reason }, 500);
  if (!books.opening) return c.json(NO_OPENING, 409);
  if (!books.opening.lockedAt) return c.json({ ok: true, already: true });
  const { error } = await sb.from('acc_company_settings').update({ opening_locked_at: null, opening_locked_by: null }).eq('company_id', co.companyId);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  await recordEntityAudit(sb, { entityType: 'OPENING_BALANCE', entityId: String(co.companyId), action: 'UPDATE', actor: c.get('houzsUser'), companyId: co.companyId,
    note: `Opening ${books.opening.openingDate} unlocked (was locked by ${books.opening.lockedBy ?? '—'})`, fieldChanges: [] });
  return c.json({ ok: true });
};
