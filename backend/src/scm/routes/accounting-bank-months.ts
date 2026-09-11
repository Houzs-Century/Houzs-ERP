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
// These two doors are that answer. Neither of them decides anything: the month
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
import { assembleMonth, monthOf, monthWindow, type MonthStatement } from '../../acc/bank-month';
import { reconcileBankStatement, type StatementMovement } from '../../acc/bank-reconcile';
import { entryCandidatesFor } from '../../acc/bank-match';
import { loadPayableBatches, loadAccountLedger, loadLiveMonthLock, claimedSetFor } from '../../acc/bank';
import { bankGuard } from './accounting-bank';

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
  + ' matched_batch_id, split';

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
    const je = textOf(l.posted_je_no) ?? textOf(matchesByLine.get(Number(l.id))?.[0]?.je_no);
    if (je) out.add(je);
  }
  return out;
};

/** The movement shape the reconciliation wants, off a line row. */
const asMovement = (l: Row, jeNo: string | null): StatementMovement => ({
  id: Number(l.id),
  bookedOn: dayOf(l.booked_on) ?? '',
  description: textOf(l.description) ?? '',
  reference: textOf(l.reference),
  amountSen: Number(l.amount_sen ?? 0),
  state: String(l.state) as StatementMovement['state'],
  jeNo,
});

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
      const assembly = assembleMonth(b.month, fed, b.movements);
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
  const movements = lines.map((l) => asMovement(l, textOf(l.posted_je_no)));
  const firstPeriodFrom = allStatements.map((s) => dayOf(s.period_from) ?? '').filter(Boolean).sort()[0] ?? null;

  const fed = feedersOf(allStatements, new Set(lines.map((l) => Number(l.statement_id))), window);
  const assembly = assembleMonth(month, fed.map(asMonthStatement), movements);
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
      claimedElsewhere: claimedSetFor(
        { claimed: claimedOutside(everyLine, new Set(lines.map((l) => Number(l.id))), new Map()), firstPeriodFrom },
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

  const [linesRes, matchRes, batches] = await Promise.all([
    linesP, matchP, loadPayableBatches(sb, co.companyId),
  ]);
  if (linesRes.error) return c.json({ error: 'load_failed', reason: linesRes.error.message }, 500);
  if (matchRes.error) return c.json({ error: 'load_failed', reason: matchRes.error.message }, 500);
  if (!batches.ok) return c.json({ error: 'load_failed', reason: batches.reason }, 500);

  const matchesByLine = new Map<number, Row[]>();
  for (const m of rowsOf(matchRes.data)) {
    const key = Number(m.bank_line_id);
    const at = matchesByLine.get(key);
    if (at) at.push(m); else matchesByLine.set(key, [m]);
  }

  /* Rule 1: the month takes the lines whose own date is in it, from whichever
     file they arrived in. */
  const everyLine = rowsOf(linesRes.data);
  const lines = everyLine.filter((l) => {
    const on = dayOf(l.booked_on);
    return on !== null && on >= window.from && on <= window.to;
  });

  /* The entry a movement claims: its own first, and the match table only where
     it has none. Two sources for one fact, in a fixed order, so the answer
     cannot depend on which read came back first. */
  /* Only a POSTED line claims anything — a match row on an OPEN line is what
     an older undo left behind (docs/bugs/0802), not a claim. */
  const jeOf = (l: Row): string | null =>
    (String(l.state) === 'POSTED' ? (textOf(l.posted_je_no) ?? textOf(matchesByLine.get(Number(l.id))?.[0]?.je_no)) : null);

  const movements = lines.map((l) => asMovement(l, jeOf(l)));

  /* The files that fed this month — the ones a line came from, plus an empty
     statement filed under it. A file uploaded against this account whose every
     movement is in another month has no business speaking for this one's
     balances. */
  const fed = feedersOf(allStatements, new Set(lines.map((l) => Number(l.statement_id))), window);
  const assembly = assembleMonth(month, fed.map(asMonthStatement), movements);
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

  const claimed = new Set(movements.map((m) => m.jeNo).filter(Boolean));
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
