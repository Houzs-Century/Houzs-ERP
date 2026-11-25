// ----------------------------------------------------------------------------
// acc/commission-release — the monthly commission release, read and posted
// (owner 2026-11-25: 「系统自动转」 for the actual P&L). The rules are
// acc/commission-release-plan.ts; this file reads what they need and books
// each month's answer through the engine.
//
// ONE ENTRY PER MONTH: COMMREL-{co}-{YYYY-MM}, dated the month's last day, a
// pair per bill month that moved (acc/rules commissionReleaseLines). Every
// night (with the stock close, 00:05 MYT) every month from the books' start to
// last month is worked out again; a month whose lines moved — a bill booked
// late or edited, an invoice keyed back into it, a deposit refunded — is
// reversed on its own date and posted again, so a late bill lands in the month
// it belongs to (「要改会原月份」). Never edited, never deleted, never doubled
// (the engine's one-active-entry rule). The current month is posted the night
// it ends.
//
// A company opts in (scm.acc_company_settings.commission_release_on). Off, the
// page still shows what the release would post; nothing is booked.
// ----------------------------------------------------------------------------

import { postJournal, reverseJournal, validateJournal } from './engine';
import { commissionReleaseLines, resolveRoles, type RoleCodes } from './rules';
import { loadPrepaidLines, RELEASE_SOURCE, type PrepaidLedgerLine } from './commission-bills';
import {
  lastDayOf, layerLabel, monthsFromTo, planCommissionRelease,
  type CommissionPlan, type PlanClose, type PlanInput, type PlanOrder, type PlanSale, type Ym,
} from './commission-release-plan';
import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { mytDateOf } from '../scm/lib/my-time';
import { fmtSen } from '../scm/shared/format';

/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Db = Parameters<typeof resolveRoles>[0];
type SoRow = {
  doc_no: string; so_date: string | null; status: string | null; total_revenue_sen: number | null; local_total_sen: number | null;
  mattress_sofa_sen: number | null; bedframe_sen: number | null; accessories_sen: number | null; others_sen: number | null;
};
type CloseRow = { month: string; paid: { so_date?: Record<string, unknown> } | null; carried: { so_date?: Array<{ docNo?: string; sen?: unknown } | null> } | null };
type AuditRow = { so_doc_no: string; action: string | null; status_snapshot: string | null; created_at: string };
type SiRow = { so_doc_no: string | null; invoice_date: string | null; total_sen: number | null; status: string | null };
type DiRow = { di_number: string; so_doc_no: string | null; invoice_date: string | null; amount_sen: number | null; status: string | null };
type CnRow = { source_doc_no: string | null; note_date: string | null; total_sen: number | null; status: string | null; kind: string | null };
type ChangeRow = { so_doc_no: string; changed_at: string; before_goods_sen: number | null };
type EntryRow = { id: string; je_no: string; source_doc_no: string | null; reversed: boolean | null; posted: boolean | null; created_at: string | null };
type LineRow = { journal_entry_id: string; account_code: string; debit_sen: number | null; credit_sen: number | null };
const failed = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e);
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The month `nowMs` falls in, and the one before it — MYT. */
export function mytMonths(nowMs: number): { current: Ym; last: Ym } {
  const myt = new Date(nowMs + 8 * 3600_000);
  const y = myt.getUTCFullYear();
  const m = myt.getUTCMonth();
  const pad = (x: number): string => String(x).padStart(2, '0');
  const current = `${y}-${pad(m + 1)}`;
  const last = m === 0 ? `${y - 1}-12` : `${y}-${pad(m)}`;
  return { current, last };
}

export const releaseDocNo = (companyId: number, month: Ym): string => `${RELEASE_SOURCE}-${companyId}-${month}`;

/* ── Settings ────────────────────────────────────────────────────────────── */

export type ReleaseSettings = { on: boolean; booksStart: Ym | null };

export async function loadReleaseSettings(sb: Db, companyId: number): Promise<{ ok: true; settings: ReleaseSettings } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_company_settings')
    .select('commission_release_on, books_start_date')
    .eq('company_id', companyId).maybeSingle();
  if (error) return { ok: false, reason: `settings: ${failed(error)}` };
  const row = (data ?? null) as { commission_release_on?: boolean | null; books_start_date?: string | null } | null;
  const start = String(row?.books_start_date ?? '').slice(0, 7);
  return { ok: true, settings: { on: row?.commission_release_on === true, booksStart: /^\d{4}-\d{2}$/.test(start) ? start : null } };
}

export async function saveReleaseSwitch(sb: Db, companyId: number, on: boolean, actor: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { error } = await sb.from('acc_company_settings').upsert({
    company_id: companyId, commission_release_on: on, updated_at: new Date().toISOString(), updated_by: actor,
  }, { onConflict: 'company_id' });
  return error ? { ok: false, reason: failed(error) } : { ok: true };
}

/* ── The reads the plan needs ────────────────────────────────────────────── */

export type ReleaseData = {
  input: PlanInput;
  roles: Pick<RoleCodes, 'COMMISSION_PREPAID' | 'COMMISSION_EXPENSE'>;
  prepaid: PrepaidLedgerLine[];
};

const SO_COLS = 'doc_no, so_date, status, total_revenue_sen, local_total_sen, mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen';
const goodsOf = (s: SoRow): number => n(s.mattress_sofa_sen) + n(s.bedframe_sen) + n(s.accessories_sen) + n(s.others_sen);
/* The order's total the way Event Commission measures it (total_revenue_sen, else local_total_sen). */
const totalOf = (s: SoRow): number => (n(s.total_revenue_sen) > 0 ? n(s.total_revenue_sen) : n(s.local_total_sen));
const ENDED = new Set(['CANCELLED', 'CLOSED']);

/** The day an ended order ended: the first of its last run of audit rows in that status (a cancel approval counts for a cancellation). */
export function endedOnOf(status: string, audit: ReadonlyArray<{ action: string | null; status_snapshot: string | null; created_at: string }>): string {
  let since: string | null = null;
  for (const a of [...audit].sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))) {
    const isEnd = a.status_snapshot === status || (status === 'CANCELLED' && (a.action === 'CANCEL_APPROVE' || a.action === 'CANCELLED'));
    if (!isEnd) since = null;
    else if (since == null) since = a.created_at;
  }
  /* No trail at all: it ended before the trail began — long before any release. */
  return since ? mytDateOf(since) : '1970-01-01';
}

export async function loadReleaseData(sb: Db, companyId: number, booksStart: Ym | null, through: Ym): Promise<{ ok: true; data: ReleaseData } | { ok: false; reason: string }> {
  const allRoles = await resolveRoles(sb, companyId);
  const roles = { COMMISSION_PREPAID: allRoles.COMMISSION_PREPAID, COMMISSION_EXPENSE: allRoles.COMMISSION_EXPENSE };
  const pl = await loadPrepaidLines(sb, companyId, roles.COMMISSION_PREPAID);
  if (!pl.ok) return pl;
  const prepaid = pl.lines;
  const start = booksStart ?? [...prepaid.map((p) => p.month ?? p.entryDate.slice(0, 7))].sort().at(0) ?? through;
  const empty: PlanInput = { booksStart: start, through, prepaid, closes: [], orders: [], sales: [], goodsAt: () => 0 };
  if (prepaid.length === 0) return { ok: true, data: { input: empty, roles, prepaid } };

  /* The closes: what each month paid each order, by SO date, its adjustments for earlier months included. */
  const cl = await sb.from('event_commission_closes').select('month, paid, carried').eq('company_id', companyId);
  if (cl.error) return { ok: false, reason: `closes: ${failed(cl.error)}` };
  const closes: PlanClose[] = ((cl.data ?? []) as CloseRow[]).map((c) => {
    const per = new Map<string, number>();
    for (const [doc, sen] of Object.entries(c.paid?.so_date ?? {})) per.set(doc, (per.get(doc) ?? 0) + n(sen));
    for (const a of c.carried?.so_date ?? []) {
      if (a?.docNo) per.set(String(a.docNo), (per.get(String(a.docNo)) ?? 0) + n(a.sen));
    }
    return { month: String(c.month).slice(0, 7), perOrder: [...per.entries()].sort((x, y) => x[0].localeCompare(y[0])) };
  });

  /* The orders: every order dated up to the last month anything pays for or is planned, and any a close names beyond them. */
  const lastMonth = [through, ...prepaid.map((p) => p.month ?? ''), ...closes.map((c) => c.month)].filter(Boolean).sort().at(-1) ?? through;
  const sos = await paginateAll<SoRow>((f, t) => sb.from('mfg_sales_orders').select(SO_COLS)
    .eq('company_id', companyId).lte('so_date', lastDayOf(lastMonth)).order('doc_no').range(f, t));
  if (sos.error) return { ok: false, reason: `orders: ${failed(sos.error)}` };
  const soRows = new Map<string, SoRow>((sos.data ?? []).map((s) => [String(s.doc_no), s]));
  const missing = [...new Set(closes.flatMap((c) => c.perOrder.map(([d]) => d)))].filter((d) => !soRows.has(d));
  if (missing.length > 0) {
    const more = await chunkIn<SoRow>(missing, (batch, f, t) => sb.from('mfg_sales_orders').select(SO_COLS)
      .eq('company_id', companyId).in('doc_no', batch).order('doc_no').range(f, t));
    if (more.error) return { ok: false, reason: `orders: ${failed(more.error)}` };
    for (const s of more.data) soRows.set(String(s.doc_no), s);
  }

  /* When each ended order ended. */
  const endedDocs = [...soRows.values()].filter((s) => ENDED.has(String(s.status))).map((s) => String(s.doc_no));
  const audit = await chunkIn<AuditRow>(endedDocs, (batch, f, t) => sb.from('mfg_so_audit_log').select('so_doc_no, action, status_snapshot, created_at')
    .eq('company_id', companyId).in('so_doc_no', batch).order('created_at').range(f, t));
  if (audit.error) return { ok: false, reason: `order history: ${failed(audit.error)}` };
  const auditOf = new Map<string, AuditRow[]>();
  for (const a of audit.data) auditOf.set(String(a.so_doc_no), [...(auditOf.get(String(a.so_doc_no)) ?? []), a]);

  const orders: PlanOrder[] = [...soRows.values()].map((s) => {
    const status = String(s.status ?? '');
    return {
      docNo: String(s.doc_no), soDate: s.so_date ? String(s.so_date).slice(0, 10) : null, status, totalSen: totalOf(s),
      endedOn: ENDED.has(status) ? endedOnOf(status, auditOf.get(String(s.doc_no)) ?? []) : null,
    };
  });

  /* Net sales: sales invoices, deposit invoices, less the credit notes that contra a deposit invoice. */
  const sis = await paginateAll<SiRow>((f, t) => sb.from('sales_invoices').select('so_doc_no, invoice_date, total_sen, status')
    .eq('company_id', companyId).not('so_doc_no', 'is', null).order('id').range(f, t));
  if (sis.error) return { ok: false, reason: `sales invoices: ${failed(sis.error)}` };
  const dis = await paginateAll<DiRow>((f, t) => sb.from('acc_deposit_invoices').select('di_number, so_doc_no, invoice_date, amount_sen, status')
    .eq('company_id', companyId).order('id').range(f, t));
  if (dis.error) return { ok: false, reason: `deposit invoices: ${failed(dis.error)}` };
  const liveDis = (dis.data ?? []).filter((d) => String(d.status) !== 'CANCELLED' && d.so_doc_no);
  const diOrder = new Map(liveDis.map((d) => [String(d.di_number), String(d.so_doc_no)]));
  const cns = await chunkIn<CnRow>([...diOrder.keys()], (batch, f, t) => sb.from('acc_credit_notes').select('source_doc_no, note_date, total_sen, status, kind')
    .eq('company_id', companyId).eq('kind', 'CN').in('source_doc_no', batch).order('id').range(f, t));
  if (cns.error) return { ok: false, reason: `credit notes: ${failed(cns.error)}` };
  const sales: PlanSale[] = [
    ...(sis.data ?? []).filter((s) => !['DRAFT', 'CANCELLED'].includes(String(s.status ?? '').toUpperCase()) && s.invoice_date)
      .map((s) => ({ docNo: String(s.so_doc_no), day: String(s.invoice_date).slice(0, 10), amountSen: n(s.total_sen) })),
    ...liveDis.filter((d) => d.invoice_date).map((d) => ({ docNo: String(d.so_doc_no), day: String(d.invoice_date).slice(0, 10), amountSen: n(d.amount_sen) })),
    ...cns.data.filter((c) => String(c.status) === 'POSTED' && c.note_date && diOrder.has(String(c.source_doc_no)))
      .map((c) => ({ docNo: diOrder.get(String(c.source_doc_no))!, day: String(c.note_date).slice(0, 10), amountSen: -n(c.total_sen) })),
  ];

  /* Goods as at a day: the earliest change after it says what they were before; no change since, they are today's. */
  const ch = await paginateAll<ChangeRow>((f, t) => sb.from('so_total_changes').select('so_doc_no, changed_at, before_goods_sen')
    .eq('company_id', companyId).order('changed_at').range(f, t));
  if (ch.error) return { ok: false, reason: `order changes: ${failed(ch.error)}` };
  const changesOf = new Map<string, Array<{ day: string; before: number }>>();
  for (const c of ch.data ?? []) {
    const k = String(c.so_doc_no);
    changesOf.set(k, [...(changesOf.get(k) ?? []), { day: mytDateOf(String(c.changed_at)), before: n(c.before_goods_sen) }]);
  }
  const goodsAt = (docNo: string, day: string): number => {
    const later = (changesOf.get(docNo) ?? []).find((c) => c.day > day);
    if (later) return later.before;
    const s = soRows.get(docNo);
    return s ? goodsOf(s) : 0;
  };

  return { ok: true, data: { input: { booksStart: start, through, prepaid, closes, orders, sales, goodsAt }, roles, prepaid } };
}

/* ── Posting one month ───────────────────────────────────────────────────── */

export type ReleaseOutcome = {
  companyId: number;
  month: Ym;
  releasedSen: number;
  action: 'posted' | 'reposted' | 'cleared' | 'unchanged' | 'failed';
  jeNo?: string;
  note?: string;
};

type MonthPart = { key: string; label: string; sen: number };

const shapeOf = (lines: Array<{ account_code: string; debit_sen: number; credit_sen: number; notes?: string | null }>): string =>
  lines.map((l) => `${l.account_code}|${n(l.debit_sen)}|${n(l.credit_sen)}|${l.notes ?? ''}`).sort().join(';');

async function activeEntry(sb: Db, companyId: number, docNo: string): Promise<{ ok: true; je: { id: string; je_no: string } | null } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('journal_entries').select('id, je_no, reversed')
    .eq('company_id', companyId).eq('source_type', RELEASE_SOURCE).eq('source_doc_no', docNo);
  if (error) return { ok: false, reason: failed(error) };
  const je = ((data ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null }>).find((r) => !r.reversed) ?? null;
  return { ok: true, je };
}

/**
 * Book ONE month's release: lines unchanged → 'unchanged'; none yet → post;
 * moved → reverse the old entry on its own date, then post the new one (checked
 * with the engine's own gate first, so a refusal leaves the old entry standing);
 * nothing left to release → reverse ('cleared'). Every outcome is logged.
 */
export async function postReleaseMonth(
  sb: Db,
  companyId: number,
  month: Ym,
  parts: MonthPart[],
  roles: Pick<RoleCodes, 'COMMISSION_PREPAID' | 'COMMISSION_EXPENSE'>,
  trigger: 'cron' | 'manual',
): Promise<ReleaseOutcome> {
  const releasedSen = parts.reduce((s, p) => s + p.sen, 0);
  const record = async (o: ReleaseOutcome): Promise<ReleaseOutcome> => {
    await sb.from('acc_commission_release_runs').insert({
      company_id: companyId, month: `${month}-01`, trigger, released_sen: o.releasedSen, action: o.action,
      je_no: o.jeNo ?? null, note: o.note ?? null,
      parts: Object.fromEntries(parts.filter((p) => p.sen !== 0).map((p) => [p.key, p.sen])),
    });
    return o;
  };
  const docNo = releaseDocNo(companyId, month);
  const want = commissionReleaseLines(roles, month, parts);
  const wantShape = shapeOf(want.map((l) => ({ account_code: l.accountCode, debit_sen: l.debitSen, credit_sen: l.creditSen, notes: l.notes ?? null })));

  const cur = await activeEntry(sb, companyId, docNo);
  if (!cur.ok) return record({ companyId, month, releasedSen, action: 'failed', note: `read: ${cur.reason}` });
  if (cur.je) {
    const { data, error } = await sb.from('journal_entry_lines').select('account_code, debit_sen, credit_sen, notes')
      .eq('company_id', companyId).eq('journal_entry_id', cur.je.id);
    if (error) return record({ companyId, month, releasedSen, action: 'failed', note: `read lines: ${failed(error)}` });
    if (shapeOf((data ?? []) as Array<{ account_code: string; debit_sen: number; credit_sen: number; notes: string | null }>) === wantShape) return record({ companyId, month, releasedSen, action: 'unchanged', jeNo: cur.je.je_no });
  } else if (want.length === 0) {
    return record({ companyId, month, releasedSen, action: 'unchanged', note: 'the month works out at 0.00 and has no entry' });
  }

  const entryDate = lastDayOf(month);
  const narration = `Commission released ${month} — ${fmtSen(releasedSen)} (${parts.filter((p) => p.sen !== 0).map((p) => `${p.label} ${fmtSen(p.sen)}`).join(', ')})`;
  if (want.length > 0) {
    const v = await validateJournal(sb, { companyId, entryDate, sourceType: RELEASE_SOURCE, sourceDocNo: docNo, narration, lines: want });
    if (!v.ok) {
      return record({ companyId, month, releasedSen, action: 'failed', note: `the new entry cannot post (${v.status}${v.reason ? `: ${v.reason}` : ''}) — nothing was reversed` });
    }
  }
  if (cur.je) {
    const r = await reverseJournal(sb, {
      sourceType: RELEASE_SOURCE, sourceDocNo: docNo, companyId, onOriginalDate: true,
      narration: (o) => `Commission release ${month} worked out again — replaces ${o.je_no}`,
    });
    if (!r.ok) return record({ companyId, month, releasedSen, action: 'failed', note: `reverse: ${r.reason ?? r.status}` });
    if (want.length === 0) return record({ companyId, month, releasedSen: 0, action: 'cleared', note: `the month now works out at 0.00 — ${cur.je.je_no} reversed` });
  }
  const post = await postJournal(sb, { companyId, entryDate, sourceType: RELEASE_SOURCE, sourceDocNo: docNo, narration, lines: want });
  if (!post.ok) return record({ companyId, month, releasedSen, action: 'failed', note: `post: ${post.reason ?? post.status}` });
  return record({ companyId, month, releasedSen, action: cur.je ? 'reposted' : 'posted', jeNo: post.jeNo });
}

/** The plan's month as the poster books it: each moved layer, labelled. */
export function monthParts(plan: CommissionPlan, month: Ym): MonthPart[] {
  const byKey = new Map(plan.layers.map((l) => [l.key, l]));
  const m = plan.months.find((x) => x.month === month);
  return (m?.parts ?? []).map((p) => {
    const l = byKey.get(p.key);
    const docs = l?.docs.length ? ` (${l.docs.join(', ')})` : '';
    return { key: p.key, label: l ? `${layerLabel(l)}${l.key === 'opening' ? '' : docs}` : p.key, sen: p.sen };
  });
}

/* ── One company, every month; the nightly sweep ─────────────────────────── */

export async function runCommissionRelease(sb: Db, companyId: number, trigger: 'cron' | 'manual', nowMs: number = Date.now()): Promise<{ ok: true; outcomes: ReleaseOutcome[] } | { ok: false; reason: string }> {
  const st = await loadReleaseSettings(sb, companyId);
  if (!st.ok) return st;
  if (!st.settings.on) return { ok: true, outcomes: [] };
  const { last } = mytMonths(nowMs);
  const data = await loadReleaseData(sb, companyId, st.settings.booksStart, last);
  if (!data.ok) return data;
  if (data.data.prepaid.length === 0) return { ok: true, outcomes: [] };
  const plan = planCommissionRelease(data.data.input);
  /* Every month from the books' start to last month — including one whose entry should now come out. */
  const outcomes: ReleaseOutcome[] = [];
  for (const month of monthsFromTo(data.data.input.booksStart, last)) {
    outcomes.push(await postReleaseMonth(sb, companyId, month, monthParts(plan, month), data.data.roles, trigger));
  }
  return { ok: true, outcomes };
}

export async function sweepCommissionRelease(sb: Db, companyIds: number[], trigger: 'cron' | 'manual', nowMs: number = Date.now()): Promise<Array<ReleaseOutcome | { companyId: number; action: 'failed'; note: string }>> {
  const out: Array<ReleaseOutcome | { companyId: number; action: 'failed'; note: string }> = [];
  for (const co of companyIds) {
    const r = await runCommissionRelease(sb, co, trigger, nowMs);
    if (r.ok) out.push(...r.outcomes);
    else out.push({ companyId: co, action: 'failed', note: r.reason });
  }
  return out;
}

/* ── What the release has booked, month by month (the page) ──────────────── */

export type PostedReleaseMonth = {
  month: Ym;
  jeNo: string;
  /** The entry's cost: debits less credits on the commission expense. */
  releasedSen: number;
  /** An earlier entry for the month was reversed. */
  reposted: boolean;
  bookedOn: string | null;
};

export async function postedReleaseMonths(sb: Db, companyId: number, expenseCode: string): Promise<{ ok: true; months: PostedReleaseMonth[] } | { ok: false; reason: string }> {
  const entries = await paginateAll<EntryRow>((f, t) => sb.from('journal_entries')
    .select('id, je_no, source_doc_no, reversed, posted, created_at')
    .eq('company_id', companyId).eq('source_type', RELEASE_SOURCE)
    .order('id').range(f, t));
  if (entries.error) return { ok: false, reason: `release entries: ${failed(entries.error)}` };
  const prefix = `${RELEASE_SOURCE}-${companyId}-`;
  const byMonth = new Map<Ym, { active: EntryRow | null; count: number }>();
  for (const e of entries.data ?? []) {
    const doc = String(e.source_doc_no ?? '');
    if (!doc.startsWith(prefix)) continue;
    const month = doc.slice(prefix.length);
    const at = byMonth.get(month) ?? { active: null, count: 0 };
    at.count += 1;
    if (e.reversed !== true && e.posted !== false) at.active = e;
    byMonth.set(month, at);
  }
  const live = [...byMonth.entries()].filter(([, m]) => m.active != null);
  const lines = await chunkIn<LineRow>(live.map(([, m]) => String(m.active!.id)), (batch, f, t) => sb.from('journal_entry_lines')
    .select('journal_entry_id, account_code, debit_sen, credit_sen')
    .eq('company_id', companyId).in('journal_entry_id', batch).order('journal_entry_id').range(f, t));
  if (lines.error) return { ok: false, reason: `release lines: ${failed(lines.error)}` };
  const costOf = new Map<string, number>();
  for (const l of lines.data) {
    if (String(l.account_code) !== expenseCode) continue;
    const k = String(l.journal_entry_id);
    costOf.set(k, (costOf.get(k) ?? 0) + n(l.debit_sen) - n(l.credit_sen));
  }
  return {
    ok: true,
    months: live.map(([month, m]) => ({
      month, jeNo: String(m.active!.je_no), releasedSen: costOf.get(String(m.active!.id)) ?? 0,
      reposted: m.count > 1, bookedOn: m.active!.created_at ? mytDateOf(String(m.active!.created_at)) : null,
    })).sort((a, b) => a.month.localeCompare(b.month)),
  };
}
