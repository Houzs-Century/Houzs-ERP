// ----------------------------------------------------------------------------
// /accounting/bank/months/:accountCode/:month/lock — closing a reconciled month.
//
// Owner, 2026-09-08: 还有lock 起来不可以随便碰.
//
// The rules are next door in acc/bank-lock.ts and the doors are here. What this
// file adds is the two things a rule cannot decide on its own:
//
//   • WHAT WAS TRUE AT THE MOMENT OF CLOSING is snapshotted onto the lock —
//     the two closing balances, the difference, how many files fed the month,
//     whether it was covered end to end. Deliberately frozen: a lock exists to
//     fix a claim, and a claim that silently follows today's data is not a
//     claim. If the ledger later disagrees with the snapshot, THAT DISAGREEMENT
//     IS THE FINDING — recomputing would erase it.
//
//   • WHO MAY REOPEN ONE is not who may close one. Closing is the ordinary end
//     of a month's work and uses the same key as the rest of layer 4. Reopening
//     undoes a document somebody filed, which is the shape of decision the PV
//     approval key already stands for in this system, so that is the key it
//     asks for — and it asks for a reason as well, which is kept.
//
// The lock is never deleted. Releasing sets released_at and the row stays, so
// "this month was closed on the 2nd and reopened on the 5th because …" is a
// question the table can answer. A partial unique index keeps exactly one lock
// live per company × account × month (migration 20260909T0243).
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { monthWindow } from '../../acc/bank-month';
import { mayLockMonth, monthAsDate, monthFromDate } from '../../acc/bank-lock';
import { bankGuard } from './accounting-bank';
import { loadMonthForLock } from './accounting-bank-months';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Row = Record<string, unknown>;

const rowsOf = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);
const textOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const userName = (c: Ctx) => (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;

export const LOCK_FIELDS =
  'id, company_id, account_code, period_month, closing_statement_sen, closing_ledger_sen,'
  + ' difference_sen, statement_count, was_complete, locked_by, locked_at, lock_note,'
  + ' released_by, released_at, release_note';

/** One stored lock, in the shape the screens and the guards read. */
export const asLock = (r: Row) => ({
  id: Number(r.id),
  accountCode: textOf(r.account_code) ?? '',
  month: monthFromDate(String(r.period_month ?? '')),
  closingStatementSen: r.closing_statement_sen == null ? null : Number(r.closing_statement_sen),
  closingLedgerSen: r.closing_ledger_sen == null ? null : Number(r.closing_ledger_sen),
  differenceSen: r.difference_sen == null ? null : Number(r.difference_sen),
  statementCount: Number(r.statement_count ?? 0),
  wasComplete: r.was_complete === true,
  lockedBy: textOf(r.locked_by),
  lockedAt: String(r.locked_at ?? ''),
  lockNote: textOf(r.lock_note),
  releasedBy: textOf(r.released_by),
  releasedAt: textOf(r.released_at),
  releaseNote: textOf(r.release_note),
});

/* ── GET /bank/locks — every month ever closed on this company ────────────── */

export const bankLocks = bankGuard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const res = await sb.from('acc_bank_month_locks')
    .select(LOCK_FIELDS)
    .eq('company_id', co.companyId)
    .order('period_month', { ascending: false });
  if (res.error) return c.json({ error: 'load_failed', reason: res.error.message }, 500);

  /* Released locks come back too. A month that was closed and reopened is a
     thing somebody will ask about, and a list that only shows live locks
     cannot answer it. */
  return c.json({ locks: rowsOf(res.data).map(asLock) });
});

/* ── POST /bank/months/:accountCode/:month/lock ───────────────────────────── */

export const bankMonthLock = bankGuard(async (c) => {
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
  const note = textOf(body.note)?.trim() ?? null;

  const sb = c.get('supabase');

  /* Already closed? Say so rather than writing a second lock and letting the
     unique index produce a database error nobody can read. */
  const existing = await sb.from('acc_bank_month_locks')
    .select(LOCK_FIELDS)
    .eq('company_id', co.companyId).eq('account_code', accountCode)
    .eq('period_month', monthAsDate(month)).is('released_at', null)
    .maybeSingle();
  if (existing.error) return c.json({ error: 'load_failed', reason: existing.error.message }, 500);
  if (existing.data) {
    const lock = asLock(existing.data as unknown as Row);
    return c.json({
      error: 'already_locked',
      message: `${accountCode} ${month} was already closed by ${lock.lockedBy ?? 'somebody'}`
        + ` on ${lock.lockedAt.slice(0, 10)}.`,
      lock,
    }, 409);
  }

  /* THE MONTH AS IT STANDS RIGHT NOW — assembled by exactly the code the month
     screen reads, so what is being closed is what he was looking at. */
  const state = await loadMonthForLock(sb, co.companyId, accountCode, month);
  if (!state.ok) return c.json({ error: 'load_failed', reason: state.reason }, 500);

  const verdict = mayLockMonth({
    accountCode, month,
    openCount: state.openCount,
    lineCount: state.lineCount,
    statementCount: state.statementCount,
    computedClosingSen: state.reconciliation.computedClosingSen,
    closingStatementSen: state.reconciliation.closingStatementSen,
    unexplainedSen: state.reconciliation.unexplainedSen,
    tallies: state.reconciliation.tallies,
    consistent: state.reconciliation.consistent,
    complete: state.assembly.complete,
  });
  if (!verdict.ok) return c.json({ error: verdict.error, message: verdict.message }, 409);

  const insert = await sb.from('acc_bank_month_locks').insert({
    company_id: co.companyId,
    account_code: accountCode,
    period_month: monthAsDate(month),
    /* Snapshotted, never recomputed — see the header. */
    closing_statement_sen: state.reconciliation.closingStatementSen,
    closing_ledger_sen: state.reconciliation.closingLedgerSen,
    difference_sen: state.reconciliation.differenceSen,
    statement_count: state.statementCount,
    was_complete: state.assembly.complete,
    locked_by: userName(c),
    /* No reason is taken any more (docs/bugs/0806): a month closes because it
       tallies, and the snapshot above is the whole record. The column stays
       for the locks that were closed with one. */
    lock_note: null,
  }).select(LOCK_FIELDS).single();
  if (insert.error) {
    /* The unique index is the last word, and a race loses to it rather than to
       the read above. */
    const twice = String((insert.error as { code?: string }).code ?? '') === '23505';
    return c.json({
      error: twice ? 'already_locked' : 'save_failed',
      message: twice
        ? `${accountCode} ${month} was closed by somebody else a moment ago.`
        : insert.error.message,
    }, twice ? 409 : 500);
  }

  return c.json({ ok: true, lock: asLock(insert.data as unknown as Row) });
});

/* ── POST /bank/months/:accountCode/:month/unlock ─────────────────────────── */

export const bankMonthUnlock = bankGuard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  /* A SECOND KEY, deliberately. Closing a month is the ordinary end of its
     work; reopening one undoes a document somebody filed and an auditor may
     already have seen. That is the shape of decision scm.payment_voucher.approve
     already stands for in this system. */
  if (!hasHouzsPerm(c, 'scm.payment_voucher.approve')) {
    return c.json({
      error: 'forbidden',
      message: 'Reopening a closed month needs approval rights — it undoes a reconciliation that has'
        + ' already been reported.',
    }, 403);
  }

  const accountCode = String(c.req.param('accountCode') ?? '').trim();
  const month = String(c.req.param('month') ?? '').trim();
  if (!accountCode) return c.json({ error: 'no_account' }, 400);
  if (!monthWindow(month)) {
    return c.json({ error: 'bad_month', message: `${month} is not a month. Use YYYY-MM.` }, 400);
  }
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { body = {}; }
  const note = textOf(body.note)?.trim() ?? null;

  /* REQUIRED. A month that was closed and is open again with no explanation is
     the one state this table exists to make impossible. */
  if (note === null) {
    return c.json({
      error: 'reason_required',
      message: 'Say why this month is being reopened. It was closed after being reconciled, and this'
        + ' sentence is the only record of why it was opened again.',
    }, 400);
  }

  const sb = c.get('supabase');
  const found = await sb.from('acc_bank_month_locks')
    .select(LOCK_FIELDS)
    .eq('company_id', co.companyId).eq('account_code', accountCode)
    .eq('period_month', monthAsDate(month)).is('released_at', null)
    .maybeSingle();
  if (found.error) return c.json({ error: 'load_failed', reason: found.error.message }, 500);
  if (!found.data) {
    return c.json({ error: 'not_locked', message: `${accountCode} ${month} is not closed.` }, 409);
  }

  /* Released, never deleted: the row is the record that this happened. */
  const released = await sb.from('acc_bank_month_locks').update({
    released_by: userName(c),
    released_at: new Date().toISOString(),
    release_note: note,
    updated_at: new Date().toISOString(),
  }).eq('id', Number((found.data as unknown as Row).id)).select(LOCK_FIELDS).single();
  if (released.error) return c.json({ error: 'save_failed', reason: released.error.message }, 500);

  return c.json({ ok: true, lock: asLock(released.data as unknown as Row) });
});
