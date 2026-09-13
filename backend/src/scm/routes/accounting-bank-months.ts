// ----------------------------------------------------------------------------
// /accounting/bank/months — the same reconciliation, asked of a MONTH.
//
// Owner, 2026-09-08: 每天我上传bank statement 和 merchant report 测试，但是有办法
// 选这个是几月的？因为我发现好像没有.
//
// Layer 4 reconciled one FILE. That is right for a monthly statement and wrong
// for the way he works — Hong Leong's any-day export is a file per day, so a
// month was thirty separate answers and none of them was the answer to "did
// September agree".
//
// These doors are that answer (the third, POST …/closing, takes the month-end
// figure typed off the bank's own statement for an account whose files print
// none — docs/bugs/0858). None of them decides anything: the month
// is assembled by acc/bank-month (which month a movement is in, which file may
// speak for a balance, where the chain of files breaks) and judged by
// acc/bank-reconcile (the identity that makes a difference falsifiable). This
// file fetches, groups, and hands over.
//
// Registered one handler at a time in routes/accounting.ts, like the rest of
// layer 4, so the route-capability audit can see them.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId } from '../lib/companyScope';
import {
  assembleMonth, monthOf, monthWindow, nextMonth, previousMonth,
  type MonthStatement, type MonthBalances, type TypedBalance,
} from '../../acc/bank-month';
import { lockedRefusal, monthAsDate, monthFromDate } from '../../acc/bank-lock';
import { reconcileBankStatement, type StatementMovement } from '../../acc/bank-reconcile';
import { entryCandidatesFor } from '../../acc/bank-match';
import {
  loadPayableBatches, loadAccountLedger, loadLiveMonthLock, loadBankConfig, claimedSetFor, jeNosOf,
  loadRecognitionRules, loadPayoutAdvices,
} from '../../acc/bank';
import { bankGuard, freshDecisions } from './accounting-bank';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** A row as it comes back: keys known, values not. Read through the helpers
    below rather than trusted, so a column that changes shape fails here and
    not three screens later. */
type Row = Record<string, unknown>;

/* The Supabase client this tree passes around is untyped, and acc/bank.ts
   already declares what it takes. Borrowing that type rather than writing a
   fresh one keeps the two from drifting and adds no new unchecked surface —
   it is the same client, named once. */
type Db = Parameters<typeof loadAccountLedger>[0];

/** Whatever came back, as rows. Null, undefined and a non-array are all "no
    rows" — the alternative is a read that half-succeeds and is counted. */
const rowsOf = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);
const textOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const dayOf = (v: unknown): string | null => {
  const s = textOf(v);
  return s === null ? null : s.slice(0, 10);
};

const STATEMENT_FIELDS =
  'id, account_code, file_name, period_from, period_to, line_count, in_sen, out_sen,'
  + ' opening_balance_sen, closing_balance_sen, status, uploaded_by, created_at';

const LINE_FIELDS =
  'id, statement_id, line_no, booked_on, description, reference, amount_sen, charge_sen,'
  + ' kind, state, posted_je_no, note, acquirer_code, trading_date, merchant_no,'
  + ' matched_batch_id, split, contra_line_id';

/** The statement shape acc/bank-month wants, off a database row. */
const asMonthStatement = (s: Row): MonthStatement => ({
  id: Number(s.id),
  fileName: textOf(s.file_name) ?? '',
  periodFrom: dayOf(s.period_from),
  periodTo: dayOf(s.period_to),
  openingBalanceSen: s.opening_balance_sen == null ? null : Number(s.opening_balance_sen),
  closingBalanceSen: s.closing_balance_sen == null ? null : Number(s.closing_balance_sen),
});

/** The files that speak for a month: the ones a line of the month came from,
    and an EMPTY statement filed under it (docs/bugs/0794 — a quiet month's file
    has no line to arrive by, so it is found by the period it was filed with,
    which lies wholly inside the month by construction). A file with lines all
    in other months still has no business speaking for this one. */
const feedersOf = (all: Row[], lineStatementIds: Set<number>, window: { from: string; to: string }): Row[] =>
  all.filter((s) => lineStatementIds.has(Number(s.id))
    || (Number(s.line_count ?? 0) === 0
      && (dayOf(s.period_from) ?? '') >= window.from && (dayOf(s.period_to) ?? '') <= window.to));

/** What lines OUTSIDE the window have claimed (docs/bugs/0802): a POSTED
    line's own entry, or its match row. Passed to the reconciliation so an
    earlier entry reconciled on an earlier month is not "still waiting" here. */
const claimedOutside = (
  allLines: Row[], inWindow: Set<number>, matchesByLine: Map<number, Row[]>,
): Set<string> => {
  const out = new Set<string>();
  for (const l of allLines) {
    if (inWindow.has(Number(l.id)) || String(l.state) !== 'POSTED') continue;
    /* Every entry the line names — a split's "A, B" is two (docs/bugs/0809). */
    for (const je of jeNosOf(l.posted_je_no)) out.add(je);
    for (const m of matchesByLine.get(Number(l.id)) ?? []) { const je = textOf(m.je_no); if (je) out.add(je); }
  }
  return out;
};

/** The movement shape the reconciliation wants, off a line row. */
const asMovement = (l: Row, jeNo: string | null, jeNos: string[] = []): StatementMovement => ({
  id: Number(l.id),
  bookedOn: dayOf(l.booked_on) ?? '',
  description: textOf(l.description) ?? '',
  reference: textOf(l.reference),
  amountSen: Number(l.amount_sen ?? 0),
  state: String(l.state) as StatementMovement['state'],
  jeNo,
  /* Every entry a POSTED line claims (docs/bugs/0803) — one movement can be
     several vouchers, and the second is claimed too; a split payout's "A, B"
     in posted_je_no is two as well (docs/bugs/0809). */
  jeNos: String(l.state) === 'POSTED' ? [...new Set([...jeNosOf(l.posted_je_no), ...jeNos])] : [],
});

/** The match rows by line — ONE index for both readers of a month
    (docs/bugs/0818: the lock indexed nothing and carried a claimed entry). */
const matchesByLineOf = (matches: Row[]): Map<number, Row[]> => {
  const out = new Map<number, Row[]>();
  for (const m of matches) {
    const key = Number(m.bank_line_id);
    const at = out.get(key);
    if (at) at.push(m); else out.set(key, [m]);
  }
  return out;
};

/** The entries a line's match rows name, by line. */
const jeNosByLine = (matches: Row[]): Map<number, string[]> => {
  const out = new Map<number, string[]>();
  for (const m of matches) {
    const key = Number(m.bank_line_id);
    const at = out.get(key) ?? [];
    at.push(String(m.je_no));
    out.set(key, at);
  }
  return out;
};

/* ── The month-end figures somebody typed (docs/bugs/0858) ─────────────────── */

const BALANCE_FIELDS = 'id, account_code, period_month, closing_sen, note, typed_by, typed_at';

const asTypedBalance = (r: Row): TypedBalance => ({
  month: monthFromDate(String(r.period_month ?? '')),
  closingSen: Number(r.closing_sen ?? 0),
  typedBy: textOf(r.typed_by),
  typedAt: String(r.typed_at ?? ''),
  note: textOf(r.note),
});

/** Every typed month-end figure of the company — or of one account — keyed
    account|month. One read for a whole list, the same as the locks. */
async function loadTypedBalances(
  sb: Db, companyId: number, accountCode?: string,
): Promise<{ ok: true; byKey: Map<string, TypedBalance> } | { ok: false; reason: string }> {
  const scoped = sb.from('acc_bank_month_balances').select(BALANCE_FIELDS).eq('company_id', companyId);
  const res = await (accountCode ? scoped.eq('account_code', accountCode) : scoped);
  if (res.error) return { ok: false, reason: String(res.error.message) };
  const byKey = new Map<string, TypedBalance>();
  for (const r of rowsOf(res.data)) {
    const b = asTypedBalance(r);
    byKey.set(`${textOf(r.account_code) ?? ''}|${b.month}`, b);
  }
  return { ok: true, byKey };
}

/** What can speak for a month: its own typed closing, and the previous
    month's, which is where it opens. */
const typedFor = (byKey: Map<string, TypedBalance>, accountCode: string, month: string): MonthBalances => {
  const prev = previousMonth(month);
  return {
    closing: byKey.get(`${accountCode}|${month}`) ?? null,
    previousClosing: prev == null ? null : (byKey.get(`${accountCode}|${prev}`) ?? null),
  };
};

const userName = (c: Ctx) => (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;

/* ── GET /bank/months — every account × month that has anything in it ─────── */

export const bankMonths = bankGuard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const stmtRes = await sb.from('acc_bank_statements')
    .select(STATEMENT_FIELDS).eq('company_id', co.companyId);
  if (stmtRes.error) return c.json({ error: 'load_failed', reason: stmtRes.error.message }, 500);
  const statements = rowsOf(stmtRes.data);
  if (statements.length === 0) return c.json({ months: [] });

  const lineRes = await sb.from('acc_bank_statement_lines')
    .select('id, statement_id, booked_on, amount_sen, state, kind')
    .eq('company_id', co.companyId);
  if (lineRes.error) return c.json({ error: 'load_failed', reason: lineRes.error.message }, 500);

  /* Which months are already closed. One read for the whole list rather than
     one per month: the list is the screen that decides whether to offer a
     Reconcile button at all, and a month that looks workable and is not wastes
     the press and the trip. */
  const lockRes = await sb.from('acc_bank_month_locks')
    .select('account_code, period_month, locked_by, locked_at')
    .eq('company_id', co.companyId).is('released_at', null);
  if (lockRes.error) return c.json({ error: 'load_failed', reason: lockRes.error.message }, 500);
  const lockedMonths = new Map<string, { lockedBy: string | null; lockedAt: string }>();
  for (const l of rowsOf(lockRes.data)) {
    const account = textOf(l.account_code) ?? '';
    const month = String(l.period_month ?? '').slice(0, 7);
    lockedMonths.set(`${account}|${month}`, {
      lockedBy: textOf(l.locked_by),
      lockedAt: String(l.locked_at ?? ''),
    });
  }

  /* And which months have a figure typed for them — the list has to say
     whether a Maybank month can be trusted without opening it. */
  const typedRes = await loadTypedBalances(sb, co.companyId);
  if (!typedRes.ok) return c.json({ error: 'load_failed', reason: typedRes.reason }, 500);

  const byId = new Map<number, Row>(statements.map((s) => [Number(s.id), s]));

  /* A month is a bucket of LINES (rule 1: a movement belongs to the month its
     own date falls in), and the files that fed it come out of which lines
     landed there — not out of a label on the file. */
  type Bucket = {
    accountCode: string;
    month: string;
    statementIds: Set<number>;
    lines: number;
    openCount: number;
    openSen: number;
    openPayouts: number;
    inSen: number;
    outSen: number;
    movements: StatementMovement[];
  };
  const buckets = new Map<string, Bucket>();

  for (const l of rowsOf(lineRes.data)) {
    const stmt = byId.get(Number(l.statement_id));
    if (!stmt) continue;
    const bookedOn = dayOf(l.booked_on);
    if (bookedOn === null || bookedOn.length !== 10) continue;
    const accountCode = textOf(stmt.account_code) ?? '';
    const month = monthOf(bookedOn);
    const key = `${accountCode}|${month}`;
    const at = buckets.get(key) ?? {
      accountCode,
      month,
      statementIds: new Set<number>(),
      lines: 0,
      openCount: 0,
      openSen: 0,
      openPayouts: 0,
      inSen: 0,
      outSen: 0,
      movements: [],
    };
    const amount = Number(l.amount_sen ?? 0);
    const state = String(l.state);
    at.statementIds.add(Number(stmt.id));
    at.lines += 1;
    /* IGNORED is out of both sides — a movement somebody has declared none of
       our business, most often a repeat of one already recorded. */
    if (state !== 'IGNORED') {
      if (amount >= 0) at.inSen += amount; else at.outSen += -amount;
    }
    if (state === 'OPEN') {
      at.openCount += 1;
      at.openSen += amount;
      if (String(l.kind).startsWith('PAYOUT')) at.openPayouts += 1;
    }
    at.movements.push(asMovement(l, null));
    buckets.set(key, at);
  }

  /* A QUIET MONTH has no line to bucket by (docs/bugs/0794): its empty
     statement is listed under the month it was filed with. */
  for (const s of statements) {
    if (Number(s.line_count ?? 0) !== 0) continue;
    const from = dayOf(s.period_from);
    const to = dayOf(s.period_to);
    if (from === null || to === null || monthOf(from) !== monthOf(to)) continue;
    const accountCode = textOf(s.account_code) ?? '';
    const key = `${accountCode}|${monthOf(from)}`;
    const at = buckets.get(key) ?? {
      accountCode, month: monthOf(from), statementIds: new Set<number>(),
      lines: 0, openCount: 0, openSen: 0, openPayouts: 0, inSen: 0, outSen: 0, movements: [],
    };
    at.statementIds.add(Number(s.id));
    buckets.set(key, at);
  }

  /* Newest first — the month he is working is the one he just uploaded into. */
  const months = [...buckets.values()]
    .sort((a, b) => b.month.localeCompare(a.month) || a.accountCode.localeCompare(b.accountCode))
    .map((b) => {
      const fed: MonthStatement[] = [];
      for (const id of b.statementIds) {
        const row = byId.get(id);
        if (row) fed.push(asMonthStatement(row));
      }
      const assembly = assembleMonth(b.month, fed, b.movements, typedFor(typedRes.byKey, b.accountCode, b.month));
      return {
        accountCode: b.accountCode,
        month: b.month,
        statementCount: b.statementIds.size,
        lineCount: b.lines,
        openCount: b.openCount,
        openSen: b.openSen,
        openPayoutCount: b.openPayouts,
        inSen: b.inSen,
        outSen: b.outSen,
        /* Enough for the list to say whether a month can be trusted, without
           making it fetch every month's full reconciliation. */
        periodFrom: assembly?.periodFrom ?? null,
        periodTo: assembly?.periodTo ?? null,
        openingBalanceSen: assembly?.statementOpeningSen ?? null,
        closingBalanceSen: assembly?.statementClosingSen ?? null,
        complete: assembly?.complete ?? false,
        gapCount: assembly?.gaps.length ?? 0,
        /* Null means open, and the list says WHO closed it — the operator who
           finds a month he cannot work needs the name, not a padlock. */
        locked: lockedMonths.get(`${b.accountCode}|${b.month}`) ?? null,
      };
    });

  return c.json({ months });
});

/**
 * The month as it stands, for the LOCK route to judge.
 *
 * The same assembly and the same reconciliation the month screen reads, so what
 * gets closed is what the operator was looking at. A second, simpler count
 * written beside the lock route would be a second opinion about whether a month
 * is finished, and the two would part company on the first change to either.
 */
export async function loadMonthForLock(
  sb: Db, companyId: number, accountCode: string, month: string,
): Promise<
  | { ok: true; assembly: NonNullable<ReturnType<typeof assembleMonth>>;
      reconciliation: ReturnType<typeof reconcileBankStatement>;
      openCount: number; lineCount: number; statementCount: number }
  | { ok: false; reason: string }
> {
  const window = monthWindow(month);
  if (!window) return { ok: false, reason: `${month} is not a month` };

  const stmtRes = await sb.from('acc_bank_statements')
    .select(STATEMENT_FIELDS).eq('company_id', companyId).eq('account_code', accountCode);
  if (stmtRes.error) return { ok: false, reason: stmtRes.error.message };
  const allStatements = rowsOf(stmtRes.data);
  const ids = allStatements.map((s) => Number(s.id));

  const linesRes = ids.length === 0
    ? { data: [] as Row[], error: null }
    : await sb.from('acc_bank_statement_lines')
      .select(LINE_FIELDS).eq('company_id', companyId).in('statement_id', ids)
      .order('booked_on').order('line_no');
  if (linesRes.error) return { ok: false, reason: linesRes.error.message };

  const everyLine = rowsOf(linesRes.data);
  const lines = everyLine.filter((l) => {
    const on = dayOf(l.booked_on);
    return on !== null && on >= window.from && on <= window.to;
  });
  const matchRes = await sb.from('acc_bank_statement_matches')
    .select('bank_line_id, je_no').eq('company_id', companyId);
  if (matchRes.error) return { ok: false, reason: matchRes.error.message };
  const matchRows = rowsOf(matchRes.data);
  const matchesByLine = matchesByLineOf(matchRows);
  const jesOf = jeNosByLine(matchRows);
  const movements = lines.map((l) => asMovement(l, jeNosOf(l.posted_je_no)[0] ?? null, jesOf.get(Number(l.id)) ?? []));
  const firstPeriodFrom = allStatements.map((s) => dayOf(s.period_from) ?? '').filter(Boolean).sort()[0] ?? null;

  const typedRes = await loadTypedBalances(sb, companyId, accountCode);
  if (!typedRes.ok) return { ok: false, reason: typedRes.reason };

  const fed = feedersOf(allStatements, new Set(lines.map((l) => Number(l.statement_id))), window);
  const assembly = assembleMonth(month, fed.map(asMonthStatement), movements, typedFor(typedRes.byKey, accountCode, month));
  if (!assembly) return { ok: false, reason: `${month} is not a month` };

  const ledger = await loadAccountLedger(sb, companyId, accountCode, assembly.periodTo);
  if (!ledger.ok) return { ok: false, reason: ledger.reason };

  return {
    ok: true,
    assembly,
    reconciliation: reconcileBankStatement({
      periodFrom: assembly.periodFrom,
      periodTo: assembly.periodTo,
      statementOpeningSen: assembly.statementOpeningSen,
      statementClosingSen: assembly.statementClosingSen,
      movements,
      ledger: ledger.movements,
      /* What EARLIER months' lines claim — by the entry the line names AND by
         the match table, the same two sources the month screen reads. A line
         matched to two entries names only the first on itself (May 2026's
         RM 55,000 deposit: the receipt, with the RM 45,000 rental in the match
         table alone); reading the line alone carried that rental into June as
         still outstanding and the lock refused a month the screen said tallied
         (docs/bugs/0818). */
      claimedElsewhere: claimedSetFor(
        { claimed: claimedOutside(everyLine, new Set(lines.map((l) => Number(l.id))), matchesByLine), firstPeriodFrom },
        ledger.movements,
      ),
    }),
    openCount: lines.filter((l) => String(l.state) === 'OPEN').length,
    lineCount: lines.length,
    statementCount: fed.length,
  };
}

/* ── GET /bank/months/:accountCode/:month — one month, reconciled ─────────── */

export const bankMonthDetail = bankGuard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const accountCode = String(c.req.param('accountCode') ?? '').trim();
  const month = String(c.req.param('month') ?? '').trim();
  if (!accountCode) return c.json({ error: 'no_account' }, 400);
  const window = monthWindow(month);
  if (!window) {
    return c.json({ error: 'bad_month', message: `${month} is not a month. Use YYYY-MM.` }, 400);
  }
  const sb = c.get('supabase');

  const stmtRes = await sb.from('acc_bank_statements')
    .select(STATEMENT_FIELDS)
    .eq('company_id', co.companyId)
    .eq('account_code', accountCode);
  if (stmtRes.error) return c.json({ error: 'load_failed', reason: stmtRes.error.message }, 500);
  const allStatements = rowsOf(stmtRes.data);
  const ids = allStatements.map((s) => Number(s.id));

  /* An account with no statements still gets a reconciliation: the books may
     hold entries the bank has never been asked about, and saying so is the
     point. So this is an empty read, not an early return. */
  const linesP = ids.length === 0
    ? Promise.resolve({ data: [], error: null })
    : sb.from('acc_bank_statement_lines')
      .select(LINE_FIELDS)
      .eq('company_id', co.companyId)
      .in('statement_id', ids)
      /* By the day, then by where it sat in its file: the reader is holding a
         month and reads it downwards. */
      .order('booked_on').order('line_no');

  const matchP = sb.from('acc_bank_statement_matches')
    .select('bank_line_id, je_no, amount_sen, match_reason').eq('company_id', co.companyId);

  const [linesRes, matchRes, batches, rules, payouts, typedRes] = await Promise.all([
    linesP, matchP, loadPayableBatches(sb, co.companyId), loadRecognitionRules(sb), loadPayoutAdvices(sb, co.companyId),
    loadTypedBalances(sb, co.companyId, accountCode),
  ]);
  if (linesRes.error) return c.json({ error: 'load_failed', reason: linesRes.error.message }, 500);
  if (matchRes.error) return c.json({ error: 'load_failed', reason: matchRes.error.message }, 500);
  if (!batches.ok) return c.json({ error: 'load_failed', reason: batches.reason }, 500);
  if (!rules.ok) return c.json({ error: 'load_failed', reason: rules.reason }, 500);
  if (!payouts.ok) return c.json({ error: 'load_failed', reason: payouts.reason }, 500);
  if (!typedRes.ok) return c.json({ error: 'load_failed', reason: typedRes.reason }, 500);
  const balances = typedFor(typedRes.byKey, accountCode, month);

  const matchesByLine = matchesByLineOf(rowsOf(matchRes.data));

  /* Rule 1: the month takes the lines whose own date is in it, from whichever
     file they arrived in. Each OPEN card movement is decided again against
     today's reports and advices (docs/bugs/0815). */
  const everyLine = rowsOf(linesRes.data);
  const fresh = freshDecisions(everyLine, rules.rules, batches.batches, payouts.payouts);
  const lines = everyLine
    .filter((l) => {
      const on = dayOf(l.booked_on);
      return on !== null && on >= window.from && on <= window.to;
    })
    .map((l): Row => ({ ...l, ...(fresh.get(Number(l.id)) ?? {}) }));

  /* The entry a movement claims: its own first, and the match table only where
     it has none. Two sources for one fact, in a fixed order, so the answer
     cannot depend on which read came back first. */
  /* Only a POSTED line claims anything — a match row on an OPEN line is what
     an older undo left behind (docs/bugs/0802), not a claim. */
  const jeOf = (l: Row): string | null =>
    (String(l.state) === 'POSTED' ? (jeNosOf(l.posted_je_no)[0] ?? textOf(matchesByLine.get(Number(l.id))?.[0]?.je_no)) : null);

  const jesOf = jeNosByLine(rowsOf(matchRes.data));
  const movements = lines.map((l) => asMovement(l, jeOf(l), jesOf.get(Number(l.id)) ?? []));

  /* The files that fed this month — the ones a line came from, plus an empty
     statement filed under it. A file uploaded against this account whose every
     movement is in another month has no business speaking for this one's
     balances. */
  const fed = feedersOf(allStatements, new Set(lines.map((l) => Number(l.statement_id))), window);
  const assembly = assembleMonth(month, fed.map(asMonthStatement), movements, balances);
  if (!assembly) return c.json({ error: 'bad_month' }, 400);

  const [ledger, held] = await Promise.all([
    loadAccountLedger(sb, co.companyId, accountCode, assembly.periodTo),
    loadLiveMonthLock(sb, co.companyId, accountCode, month),
  ]);
  if (!ledger.ok) return c.json({ error: 'load_failed', reason: ledger.reason }, 500);
  /* A LOCK THE SCREEN CANNOT READ IS A REFUSAL, not an omission. A month that
     draws its buttons as though it were open, because the lock read quietly
     failed, is the one way this can mislead somebody into attempting a write
     the server will then bounce. */
  if (!held.ok) return c.json({ error: 'load_failed', reason: held.reason }, 500);

  const firstPeriodFrom = allStatements.map((s) => dayOf(s.period_from) ?? '').filter(Boolean).sort()[0] ?? null;
  const claimedElsewhere = claimedSetFor(
    { claimed: claimedOutside(everyLine, new Set(lines.map((l) => Number(l.id))), matchesByLine), firstPeriodFrom },
    ledger.movements,
  );
  const reconciliation = reconcileBankStatement({
    periodFrom: assembly.periodFrom,
    periodTo: assembly.periodTo,
    statementOpeningSen: assembly.statementOpeningSen,
    statementClosingSen: assembly.statementClosingSen,
    movements,
    ledger: ledger.movements,
    claimedElsewhere,
  });

  const claimed = new Set(movements.flatMap((m) => [m.jeNo, ...(m.jeNos ?? [])]).filter(Boolean));
  /* This month's, and the earlier ones still waiting for a bank to show them
     (owner 2026-09-11: 之前 in book 还没有 recon 的也要带下来). */
  const unmatchedEntries = ledger.movements
    .filter((l) => l.entryDate <= assembly.periodTo)
    .filter((l) => !claimed.has(l.jeNo))
    .filter((l) => l.entryDate >= assembly.periodFrom || !claimedElsewhere.has(l.jeNo))
    .map((l) => ({ ...l, carried: l.entryDate < assembly.periodFrom }));

  const fileNameOf = (statementId: number): string | null => {
    const s = allStatements.find((x) => Number(x.id) === statementId);
    return s === undefined ? null : textOf(s.file_name);
  };

  return c.json({
    accountCode,
    month,
    assembly,
    reconciliation,
    /* Null means open. The screen renders the LOCK rather than inferring one
       from a disabled button, so a closed month says who closed it and why. */
    lock: held.lock,
    /* The typed month-end figures as stored — this month's and the previous
       month's — so the screen can show what was typed even where a file
       printed the balance and the typed one was not used (docs/bugs/0858). */
    balances,
    /* Named, in the order they cover the month, so a break can be chased to the
       two files it is between. */
    statements: [...fed]
      .sort((a, b) => String(a.period_from).localeCompare(String(b.period_from)))
      .map((s) => ({ ...s, spanning: assembly.spanningIds.includes(Number(s.id)) })),
    lines: lines.map((l) => {
      const acquirer = textOf(l.acquirer_code);
      return {
        ...l,
        /* Which file this movement came off — a month mixes them, and "line 12"
           means nothing until you know of what. */
        file_name: fileNameOf(Number(l.statement_id)),
        matches: String(l.state) === 'POSTED' ? (matchesByLine.get(Number(l.id)) ?? []) : [],
        /* Recomputed live, exactly as the single-statement view does it: a
           batch paid since the upload must not still be offered. */
        candidates: String(l.kind).startsWith('PAYOUT')
          ? batches.batches.filter((b) => b.acquirerCode === acquirer)
          : [],
        /* And which LEDGER ENTRY it could be — the answer for everything on a
           statement that is not card money, which is most of it. Same ranking
           as the single-file view, from the same function. */
        entryCandidates: String(l.state) === 'OPEN'
          ? entryCandidatesFor(
            { bookedOn: dayOf(l.booked_on) ?? '', amountSen: Number(l.amount_sen ?? 0) },
            ledger.movements,
            claimed as ReadonlySet<string>,
          )
          : [],
      };
    }),
    unmatchedEntries,
  });
});

/* ── POST /bank/months/:accountCode/:month/closing — the month-end figure typed
   off the bank's own statement (docs/bugs/0858) ──────────────────────────────
   Maybank's Account Activity Report prints no balance, so the month had
   nothing to tally against and could never close. The figure is typed ONCE
   per month; the next month opens at it. Body: { closingSen: integer sen, or
   null to remove; note?: string }. A figure a FILE prints still wins over it
   (acc/bank-month rule 4), so typing one against a Hong Leong month is
   harmless and unused. */

export const bankMonthClosing = bankGuard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const accountCode = String(c.req.param('accountCode') ?? '').trim();
  const month = String(c.req.param('month') ?? '').trim();
  if (!accountCode) return c.json({ error: 'no_account' }, 400);
  if (!monthWindow(month)) {
    return c.json({ error: 'bad_month', message: `${month} is not a month. Use YYYY-MM.` }, 400);
  }
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { body = {}; }
  const closingSen = body.closingSen == null ? null : Number(body.closingSen);
  if (closingSen != null && (!Number.isInteger(closingSen) || Math.abs(closingSen) > 1e14)) {
    return c.json({ error: 'bad_amount', message: 'The closing balance must be a whole number of sen.' }, 400);
  }
  const noteText = textOf(body.note)?.trim();
  const note = noteText ? noteText : null;
  const sb = c.get('supabase');

  /* Only an account set up to take a statement. A figure typed against an
     account nobody reconciles is a stray row, and the refusal names what IS
     set up. */
  const config = await loadBankConfig(sb, co.companyId, accountCode);
  if (!config.ok) return c.json({ error: 'no_such_account', message: config.reason }, 400);

  /* A CLOSED MONTH REFUSES THE WRITE that would change what it says — and the
     closing of this month is what the NEXT month opens at, so while the next
     month is closed this figure cannot move either. */
  const next = nextMonth(month);
  const [held, heldNext] = await Promise.all([
    loadLiveMonthLock(sb, co.companyId, accountCode, month),
    next == null ? Promise.resolve({ ok: true as const, lock: null }) : loadLiveMonthLock(sb, co.companyId, accountCode, next),
  ]);
  if (!held.ok) return c.json({ error: 'load_failed', reason: held.reason }, 500);
  if (!heldNext.ok) return c.json({ error: 'load_failed', reason: heldNext.reason }, 500);
  if (held.lock) return c.json(lockedRefusal(held.lock, `typing the closing balance of ${month}`), 409);
  if (heldNext.lock) {
    return c.json(lockedRefusal(heldNext.lock, `changing the closing balance of ${month}, which ${next ?? ''} opens at`), 409);
  }

  const existing = await sb.from('acc_bank_month_balances')
    .select(BALANCE_FIELDS)
    .eq('company_id', co.companyId).eq('account_code', accountCode).eq('period_month', monthAsDate(month))
    .maybeSingle();
  if (existing.error) return c.json({ error: 'load_failed', reason: existing.error.message }, 500);
  const current = existing.data ? (existing.data as unknown as Row) : null;

  /* Null removes the figure — the one way to take back a typed number once a
     file that prints the balance has arrived, or a wrong month was typed. */
  if (closingSen == null) {
    if (current) {
      const gone = await sb.from('acc_bank_month_balances').delete()
        .eq('company_id', co.companyId).eq('id', Number(current.id));
      if (gone.error) return c.json({ error: 'save_failed', message: gone.error.message }, 500);
    }
    return c.json({ ok: true, balance: null });
  }

  const now = new Date().toISOString();
  const saved = current
    ? await sb.from('acc_bank_month_balances')
      .update({ closing_sen: closingSen, note, typed_by: userName(c), typed_at: now, updated_at: now })
      .eq('company_id', co.companyId).eq('id', Number(current.id))
      .select(BALANCE_FIELDS).single()
    : await sb.from('acc_bank_month_balances')
      .insert({
        company_id: co.companyId, account_code: accountCode, period_month: monthAsDate(month),
        closing_sen: closingSen, note, typed_by: userName(c), typed_at: now,
      })
      .select(BALANCE_FIELDS).single();
  if (saved.error) return c.json({ error: 'save_failed', message: saved.error.message }, 500);

  return c.json({ ok: true, balance: asTypedBalance(saved.data as unknown as Row) });
});
