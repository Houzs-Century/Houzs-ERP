// ----------------------------------------------------------------------------
// /accounting/bank — reconciling the BANK's own statement (brief §3.5 layer 4).
//
// The handlers live here and routes/accounting.ts registers each one, for the
// same reason accounting-settlement.ts does it: the route-capability audit
// (scripts/generate-route-capability-matrix.mjs) follows `app.route` and
// `scm.route` only, so a sub-router would take these endpoints OUT of the
// matrix that lists every route and its gate.
//
// Owner, 2026-08-19: 我不是应该upload bank statement 或 daily transaction report
// 然后你也自动核对吗 — and, asked how far it should go, 整张月结单全部对. So this
// reads the whole statement, not only the card credits: the acquirer payouts it
// can post, and everything else it presents against the ledger so a person can
// see what is unreconciled and why.
//
// Permission: the same key and the same both-ends rule as layer 3
// (权限：前后端各检查一次).
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { parseBankStatement, movementFingerprint } from '../../acc/bank-parse';
import { monthWindow } from '../../acc/bank-month';
import { groupBankMovements, matchBankMovements, entryCandidatesFor, obviousEntryFor } from '../../acc/bank-match';
import { reconcileBankStatement, type StatementMovement } from '../../acc/bank-reconcile';
import {
  loadBankConfigs, loadBankConfig, parseConfigFrom,
  loadRecognitionRules, loadPayableBatches, loadPayoutAdvices, loadAccountLedger,
  loadLiveMonthLock, loadLineMonth, loadClaimedElsewhere, claimedSetFor, jeNosOf } from '../../acc/bank';
import { lockedRefusal, lockMonthOf } from '../../acc/bank-lock';
import { postBatchReceipt, undoBatchReceipt } from '../../acc/settlement';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/* Exported so the month view (accounting-bank-months) guards on exactly this
   and not on a copy of it: two spellings of one permission rule are one
   refactor away from being two different rules. */
export const bankGuard = (handler: (c: Ctx) => Promise<Response>) => async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return c.json({ error: "You don't have permission to reconcile bank statements." }, 403);
  }
  return handler(c);
};

const guard = bankGuard;

/**
 * A CLOSED MONTH REFUSES EVERY WRITE THAT WOULD CHANGE WHAT IT SAYS.
 *
 * Owner, 2026-09-08: 还有lock 起来不可以随便碰. Every handler below that books,
 * matches, ignores or undoes a movement asks this first, by the movement's OWN
 * date — the month a movement belongs to is the month its date falls in
 * (acc/bank-month rule 1), never the month of the file it arrived in, so a
 * straddling file cannot smuggle a write into a closed September.
 *
 * Returns a Response to send, or null to carry on.
 */
async function refuseIfLocked(
  c: Ctx, companyId: number, accountCode: string, isoDate: string, what: string,
): Promise<Response | null> {
  const sb = c.get('supabase');
  const held = await loadLiveMonthLock(sb, companyId, accountCode, lockMonthOf(isoDate));
  /* A LOCK THAT CANNOT BE READ IS A REFUSAL, not a pass. The one failure mode
     worth spending a 500 on is writing into a closed month because the check
     itself broke quietly. */
  if (!held.ok) {
    return c.json({
      error: 'lock_check_failed',
      reason: held.reason,
      message: 'Whether this month is closed could not be checked, so nothing was changed. Try again.',
    }, 500);
  }
  if (!held.lock) return null;
  return c.json(lockedRefusal(held.lock, what), 409);
}

/** The same question asked of a LINE, which knows its own account and date. */
async function refuseIfLineLocked(
  c: Ctx, companyId: number, lineId: number, what: string,
): Promise<Response | null> {
  const sb = c.get('supabase');
  const where = await loadLineMonth(sb, companyId, lineId);
  if (!where.ok) {
    return c.json({
      error: 'lock_check_failed',
      reason: where.reason,
      message: 'Whether this month is closed could not be checked, so nothing was changed. Try again.',
    }, 500);
  }
  /* Not found here is not a refusal — the handler's own 404 is the better
     message, and it is one line further down. */
  if (!where.found) return null;
  const held = await loadLiveMonthLock(sb, companyId, where.accountCode, where.month);
  if (!held.ok) {
    return c.json({
      error: 'lock_check_failed',
      reason: held.reason,
      message: 'Whether this month is closed could not be checked, so nothing was changed. Try again.',
    }, 500);
  }
  if (!held.lock) return null;
  return c.json(lockedRefusal(held.lock, what), 409);
}

/** The same fingerprint layer 3 uses: one file is one statement, and a second
    upload of it loses to the UNIQUE rather than doubling the movements. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const userName = (c: Ctx) => (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;

/* ── GET /bank/setup — which accounts can take a statement ────────────────── */

export const bankSetup = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const [cfgs, rules] = await Promise.all([loadBankConfigs(sb, co.companyId), loadRecognitionRules(sb)]);
  if (!cfgs.ok) return c.json({ error: 'load_failed', reason: cfgs.reason }, 500);
  if (!rules.ok) return c.json({ error: 'load_failed', reason: rules.reason }, 500);

  return c.json({
    accounts: cfgs.configs.map((cfg) => ({
      account_code: cfg.account_code,
      bank_code: cfg.bank_code,
      account_no: cfg.account_no,
      statement_format: cfg.statement_format,
      is_active: cfg.is_active,
      /* The reader carries built-in headings for every role (bank-parse.ts
         DEFAULT_HEADINGS), so a config that names nothing still reads a
         file captioned the way banks caption them; a file it cannot read is
         refused at upload with its own headings quoted. */
      ready: true,
    })),
    /* Which acquirers this system can recognise on a statement at all. An
       acquirer missing here is one whose money will read as "not a card
       payout" for ever, so the screen has to be able to say so. */
    recognises: [...new Set(rules.rules.map((r) => r.acquirerCode))],
  });
});

/* ── POST /bank/statements — upload one ───────────────────────────────────── */

export const bankUpload = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const accountCode = String(body.accountCode ?? '').trim();
  const fileName = String(body.fileName ?? '').trim() || 'statement.csv';
  const content = String(body.content ?? '');
  if (!accountCode) return c.json({ error: 'no_account', message: 'Choose which bank account this statement is for.' }, 400);
  if (!content.trim()) return c.json({ error: 'empty_file', message: 'The file is empty.' }, 400);

  const sb = c.get('supabase');
  const cfg = await loadBankConfig(sb, co.companyId, accountCode);
  if (!cfg.ok) return c.json({ error: 'account_unavailable', message: cfg.reason }, 400);
  if (!cfg.config.is_active) {
    return c.json({ error: 'account_inactive', message: `${accountCode} is switched off for this company.` }, 400);
  }

  /* THE ONE MISTAKE HERE THAT PRODUCES A CLEAN-LOOKING WRONG ANSWER is
     reconciling a statement against the wrong account: every number computes,
     every total balances, and the answer is about somebody else's money. So if
     the config knows the account number and the file names a different one, it
     is refused by name. */
  const expectNo = (cfg.config.account_no ?? '').replace(/\D/g, '');
  if (expectNo) {
    const digits = content.slice(0, 20000).replace(/\D/g, '');
    if (!digits.includes(expectNo)) {
      return c.json({
        error: 'wrong_account',
        message: `This file does not mention account ${cfg.config.account_no}, which is the ${cfg.config.bank_code} account you chose. Check you picked the right account, or the right file.`,
      }, 400);
    }
  }

  const parsed = parseBankStatement(
    parseConfigFrom(cfg.config, /^\d{4}-\d{2}$/.test(String(body.statementMonth ?? '')) ? String(body.statementMonth) : null),
    content,
  );
  if (!parsed.ok) return c.json({ error: 'unreadable_statement', message: parsed.reason }, 400);

  /* THE MONTH A STATEMENT COVERS (docs/bugs/0802). Hong Leong's April statement
     for 2990 carried fifteen movements, every one dated the 30th, so its
     period read as one day and the two payments posted on the 28th were not
     on the "in the books" list — the books were being compared over one day
     of a month's statement. Naming the month in the Year-and-month box now
     says: this file IS the month's statement, the 1st to the last day. The
     movements keep their own dates (bank-month rule 1); what changes is the
     span the books are compared over. A movement dated outside the named
     month gives the lie to the claim and refuses the file. */
  const named = /^\d{4}-\d{2}$/.test(String(body.statementMonth ?? '')) ? String(body.statementMonth) : null;
  const window = named ? monthWindow(named) : null;
  let periodFrom = parsed.periodFrom;
  let periodTo = parsed.periodTo;
  if (window && parsed.lines.length > 0) {
    const outside = parsed.lines.find((l) => l.bookedOn < window.from || l.bookedOn > window.to);
    if (outside) {
      return c.json({
        error: 'month_mismatch',
        message: `This file carries a movement dated ${outside.bookedOn}, outside ${named}. A statement filed for a month must lie inside it — choose the month it is for, or clear the box so the file's own dates set its period.`,
      }, 400);
    }
    periodFrom = window.from;
    periodTo = window.to;
  }

  /* A CLOSED MONTH TAKES NO NEW MOVEMENTS. Checked here, after the file has been
     read and before a single row is written, because the answer depends on the
     DATES the file turned out to carry — a file is refused for the months it
     lands in, not for the month somebody meant it for. Both ends are checked:
     one file can straddle a close, and a September that is shut must refuse a
     28 Aug – 3 Sep export even though August is open. */
  for (const edge of new Set([periodFrom, periodTo])) {
    const shut = await refuseIfLocked(
      c, co.companyId, accountCode, edge,
      `loading a statement carrying movements dated ${edge}`,
    );
    if (shut) return shut;
  }

  const [rules, batches, payouts] = await Promise.all([
    loadRecognitionRules(sb), loadPayableBatches(sb, co.companyId), loadPayoutAdvices(sb, co.companyId),
  ]);
  if (!rules.ok) return c.json({ error: 'load_failed', reason: rules.reason }, 500);
  if (!batches.ok) return c.json({ error: 'load_failed', reason: batches.reason }, 500);
  if (!payouts.ok) return c.json({ error: 'load_failed', reason: payouts.reason }, 500);

  const movements = groupBankMovements(parsed.lines);
  const decisions = matchBankMovements({
    movements, rules: rules.rules, batches: batches.batches, payouts: payouts.payouts,
  });

  /* MOVEMENTS THIS ACCOUNT HAS ALREADY DEALT WITH.
     The owner: 这个 statement 如果我同一个月 submit 多次，他会想要重新 check 过？
     还是已经 settle 了就不见了.

     The exact same FILE is refused below by its hash. But a LONGER export of
     the same month is a different file carrying the same days, and its credits
     cannot be booked twice — the reports they paid are fully received, so the
     matcher finds nothing waiting and calls them PAYOUT_NO_BATCH, whose clue
     tells him to go and reconcile a merchant report that is already done.
     Correct about the money, useless as an instruction.

     So a movement this account has ALREADY TAKEN IN — posted, still open on an
     earlier statement, or ignored there — is named for what it is. The owner
     reconciles every few days and again at month end (2026-09-08: 可能隔几天我
     就做一次), so overlapping exports are the ordinary case, not a mistake.

     Keyed on the movement's FINGERPRINT (bank-parse.ts movementFingerprint):
     its day, its amount and its WORDS in any order — not its text, because the
     same transaction reads "Fund transfer RACHEL NG" on Hong Leong's monthly
     statement and "RACHEL NG Fund transfer" on its any-day export. COUNTED, not
     just seen: two identical transfers on one day are two movements, and a
     longer export carrying one more of them than an earlier one contributes
     exactly that one. */
  const seenBefore = new Map<string, { count: number; where: string }>();
  {
    const { data: mine, error: mErr } = await sb.from('acc_bank_statements')
      .select('id').eq('company_id', co.companyId).eq('account_code', accountCode);
    if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
    const ids = ((mine ?? []) as Array<{ id: number }>).map((s) => Number(s.id));
    if (ids.length > 0) {
      const { data, error: seenErr } = await sb.from('acc_bank_statement_lines')
        .select('booked_on, description, reference, amount_sen, state, posted_je_no, statement_id')
        .eq('company_id', co.companyId).in('statement_id', ids);
      if (seenErr) return c.json({ error: 'load_failed', reason: seenErr.message }, 500);
      for (const r of (data ?? []) as Array<Record<string, any>>) {
        const key = movementFingerprint({
          bookedOn: String(r.booked_on).slice(0, 10), amountSen: Number(r.amount_sen ?? 0),
          description: String(r.description ?? ''), reference: (r.reference as string | null) ?? null,
        });
        const at = seenBefore.get(key) ?? { count: 0, where: '' };
        at.count += 1;
        at.where = r.posted_je_no
          ? String(r.posted_je_no)
          : `statement ${r.statement_id}${String(r.state) === 'OPEN' ? ' (still open there)' : String(r.state) === 'IGNORED' ? ' (ignored there)' : ''}`;
        seenBefore.set(key, at);
      }
    }
  }
  /* Which of THIS file's movements are repeats — decided once, in file order,
     so the first occurrences of a repeated fingerprint are the ones that match
     what was seen and any beyond that count are new. */
  const usedNow = new Map<string, number>();
  const alreadyRecorded = decisions.map((d) => {
    const key = movementFingerprint(d.movement);
    const seen = seenBefore.get(key);
    if (!seen) return null;
    const used = usedNow.get(key) ?? 0;
    if (used >= seen.count) return null;
    usedNow.set(key, used + 1);
    return seen.where;
  });

  const fileHash = await sha256Hex(content);
  const { data: stmtRow, error: stmtErr } = await sb.from('acc_bank_statements').insert({
    company_id: co.companyId,
    account_code: accountCode,
    file_name: fileName,
    file_hash: fileHash,
    period_from: periodFrom,
    period_to: periodTo,
    line_count: movements.length,
    skipped_lines: parsed.skippedLines,
    in_sen: parsed.inSen,
    out_sen: parsed.outSen,
    opening_balance_sen: parsed.openingBalanceSen,
    closing_balance_sen: parsed.closingBalanceSen,
    uploaded_by: userName(c),
  }).select('id').single();
  if (stmtErr) {
    const twice = String(stmtErr.code ?? '') === '23505' || /duplicate key/i.test(String(stmtErr.message ?? ''));
    return c.json({
      error: twice ? 'already_uploaded' : 'save_failed',
      message: twice
        ? 'This exact file has already been uploaded. Open the existing statement instead of loading it twice.'
        : stmtErr.message,
    }, twice ? 409 : 500);
  }
  const statementId = (stmtRow as { id: number }).id;

  /* A quiet month's statement has no lines to write (docs/bugs/0794); an
     insert of nothing is not asked for. */
  const { error: linesErr } = decisions.length === 0 ? { error: null } : await sb.from('acc_bank_statement_lines').insert(
    decisions.map((raw, idx) => {
      const already = alreadyRecorded[idx];
      /* Named, not silently dropped: a movement that looks identical is not
         PROVEN identical, and the person who uploaded the file is the one who
         can say. What the screen owes him is the truth about why it is here. */
      const d = already
        ? {
          ...raw,
          kind: 'DUPLICATE' as const,
          clue: `This movement is already recorded — ${already} on a statement uploaded earlier.`
            + ' Leave it out unless the bank really paid twice.',
        }
        : raw;
      return {
      statement_id: statementId,
      company_id: co.companyId,
      line_no: d.movement.lines[0]!.lineNo,
      booked_on: d.movement.bookedOn,
      description: d.movement.description,
      reference: d.movement.reference,
      amount_sen: d.movement.amountSen,
      charge_sen: d.movement.chargeSen,
      kind: d.kind,
      /* Stated, not left to the column default. Every read in this module asks
         what state a line is in, and a row whose state depends on a default
         declared in another file is a row that can come back without one.

         A DUPLICATE arrives already settled — the owner: 当我重新上传他应该是
         ignore 已经 recon 了的 transaction. Nothing is left for him to press on
         a movement whose entry already exists; it goes straight under "already
         dealt with", carrying the sentence that says which entry that was.

         Safe because the match is reference AND day AND amount against a line
         already POSTED — and if a bank ever genuinely paid the same amount
         twice on the same reference and day, the reconciliation catches it: an
         IGNORED line leaves the statement's movements, so opening + movements
         would no longer reach the closing balance the FILE prints, and the
         consistency check refuses to publish a difference it cannot account
         for. */
      state: already ? 'IGNORED' : 'OPEN',
      acquirer_code: d.acquirerCode,
      trading_date: d.tradingDate,
      merchant_no: d.merchantNo,
      /* The decision itself, not just the reasoning. Without it the screen has
         to pick a statement back out of the candidate list, and "the first one
         of that acquirer" is a different answer from "the one whose trading day
         and amount agreed". */
      matched_batch_id: d.batchId,
      /* And the SPLIT, when several statements add up to it — Public Bank pays
         three trading days with one advice, so this is ordinary. */
      split: d.split.length > 0 ? d.split : null,
      note: d.clue,
      };
    }),
  );
  if (linesErr) return c.json({ error: 'save_failed', reason: linesErr.message }, 500);

  /* THE OBVIOUS ONES, before the operator sees the list (docs/bugs/0814). */
  const obvious = decisions.length === 0
    ? { ok: true as const, matched: 0, jeNos: [] as string[] }
    : await applyObviousMatches(sb, co.companyId, { id: statementId, account_code: accountCode, period_to: periodTo });
  if (!obvious.ok) return c.json({ error: 'match_failed', reason: obvious.reason, message: `The file was read, but the obvious matches could not be applied: ${obvious.reason}` }, 500);

  const counts = decisions.reduce<Record<string, number>>((acc, d, idx) => {
    const kind = alreadyRecorded[idx] ? 'DUPLICATE' : d.kind;
    acc[kind] = (acc[kind] ?? 0) + 1;
    return acc;
  }, {});

  return c.json({
    ok: true,
    statementId,
    lines: movements.length,
    joinedPairs: parsed.lines.length - movements.length,
    skippedLines: parsed.skippedLines,
    /* Said on the upload itself, not only findable inside the statement: a
       re-upload that quietly settles half its own lines is a surprise, even
       when every one of them is right. */
    alreadyRecorded: counts.DUPLICATE ?? 0,
    /* Matched by amount and name on the way in (docs/bugs/0814). */
    autoMatched: obvious.matched,
    periodFrom,
    periodTo,
    inSen: parsed.inSen,
    outSen: parsed.outSen,
    openingBalanceSen: parsed.openingBalanceSen,
    closingBalanceSen: parsed.closingBalanceSen,
    kinds: counts,
  });
});

/* ── The obvious ones, matched without a hand (docs/bugs/0814) ────────────────
   Every OPEN movement of one statement that is not card money, against the
   account's ledger: exactly one same-amount entry within the window whose
   payee the bank's text names is matched here — a match row with reason
   "amount+name", the line POSTED, listed under "already dealt with" with Undo.
   Runs on upload and on demand for a statement uploaded before the rule
   existed. Reads fail closed: a ledger or claim read that fails matches
   nothing and says so. */
async function applyObviousMatches(
  sb: Parameters<typeof loadAccountLedger>[0], companyId: number, statement: { id: number; account_code: string; period_to: string },
): Promise<{ ok: true; matched: number; jeNos: string[] } | { ok: false; reason: string }> {
  const { data: linesRaw, error: lErr } = await sb.from('acc_bank_statement_lines')
    .select('id, booked_on, description, reference, amount_sen, state, kind')
    .eq('statement_id', statement.id).eq('company_id', companyId).eq('state', 'OPEN');
  if (lErr) return { ok: false, reason: lErr.message };
  const lines = (Array.isArray(linesRaw) ? linesRaw : []) as Array<{ id: number; booked_on: string; description: string | null; reference: string | null; amount_sen: number; kind: string }>;
  const open = lines.filter((l) => String(l.kind) === 'OTHER');
  if (open.length === 0) return { ok: true, matched: 0, jeNos: [] };

  const [ledger, elsewhere] = await Promise.all([
    loadAccountLedger(sb, companyId, statement.account_code, String(statement.period_to).slice(0, 10)),
    /* Every statement's claims, this one's included. */
    loadClaimedElsewhere(sb, companyId, statement.account_code, null),
  ]);
  if (!ledger.ok) return { ok: false, reason: ledger.reason };
  if (!elsewhere.ok) return { ok: false, reason: elsewhere.reason };
  const claimed = claimedSetFor(elsewhere, ledger.movements);

  const jeNos: string[] = [];
  for (const l of open) {
    const hit = obviousEntryFor(
      { bookedOn: String(l.booked_on).slice(0, 10), amountSen: Number(l.amount_sen), description: String(l.description ?? ''), reference: l.reference ?? null },
      ledger.movements,
      claimed,
    );
    if (!hit) continue;
    const { error: insErr } = await sb.from('acc_bank_statement_matches').insert({
      bank_line_id: Number(l.id), company_id: companyId, je_no: hit.jeNo, amount_sen: Number(l.amount_sen), match_reason: 'amount+name',
    });
    if (insErr) return { ok: false, reason: insErr.message };
    const { error: upErr } = await sb.from('acc_bank_statement_lines')
      .update({ state: 'POSTED', posted_je_no: hit.jeNo, updated_at: new Date().toISOString() })
      .eq('id', Number(l.id)).eq('company_id', companyId);
    if (upErr) return { ok: false, reason: upErr.message };
    claimed.add(hit.jeNo);
    jeNos.push(hit.jeNo);
  }
  return { ok: true, matched: jeNos.length, jeNos };
}

/* POST /bank/statements/:id/auto-match — the same rule, for a statement
   uploaded before it existed (owner: June was already up). */
export const bankStatementAutoMatch = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'bad_id' }, 400);
  const sb = c.get('supabase');
  const { data: stmt, error } = await sb.from('acc_bank_statements')
    .select('id, account_code, period_from, period_to').eq('id', id).eq('company_id', co.companyId).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!stmt) return c.json({ error: 'not_found' }, 404);
  const statement = stmt as { id: number; account_code: string; period_from: string; period_to: string };
  for (const edge of new Set([String(statement.period_from).slice(0, 10), String(statement.period_to).slice(0, 10)])) {
    const shut = await refuseIfLocked(c, co.companyId, statement.account_code, edge, 'matching movements on this statement');
    if (shut) return shut;
  }
  const r = await applyObviousMatches(sb, co.companyId, statement);
  if (!r.ok) return c.json({ error: 'match_failed', reason: r.reason, message: `The obvious matches could not be applied: ${r.reason}` }, 500);
  return c.json({ ok: true, matched: r.matched, jeNos: r.jeNos });
});

/* ── POST /bank/statements/:id/period — this file is the month's statement ──
   A file uploaded before the month box covered a month reads by its
   movements' dates — 30/4 → 30/4 for a monthly statement whose lines all fell
   on the 30th. Re-filed here as the month's statement in place: the period
   becomes the 1st to the last day and nothing else moves — not a line, not a
   match (owner 2026-09-11: 可以，没有问题，这只是显示问题吧; docs/bugs/0806). A
   movement outside the month gives the lie to the claim, and a closed month
   refuses. */
export const bankStatementPeriod = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'bad_id' }, 400);
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { body = {}; }
  const month = String(body.month ?? '').trim();
  const window = monthWindow(month);
  if (!window) return c.json({ error: 'bad_month', message: `${month || '(nothing)'} is not a month. Use YYYY-MM.` }, 400);
  const sb = c.get('supabase');

  const { data: stmt, error } = await sb.from('acc_bank_statements')
    .select('id, account_code, period_from, period_to').eq('id', id).eq('company_id', co.companyId).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!stmt) return c.json({ error: 'not_found' }, 404);
  const statement = stmt as { account_code: string; period_from: string; period_to: string };

  const { data: linesRaw, error: lErr } = await sb.from('acc_bank_statement_lines')
    .select('booked_on').eq('statement_id', id).eq('company_id', co.companyId);
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const outside = ((Array.isArray(linesRaw) ? linesRaw : []) as Array<{ booked_on: string }>)
    .map((l) => String(l.booked_on).slice(0, 10))
    .find((d) => d < window.from || d > window.to);
  if (outside) {
    return c.json({
      error: 'month_mismatch',
      message: `This file carries a movement dated ${outside}, outside ${month}. A statement filed for a month must lie inside it.`,
    }, 400);
  }

  for (const edge of [window.from, window.to, String(statement.period_from).slice(0, 10), String(statement.period_to).slice(0, 10)]) {
    const shut = await refuseIfLocked(c, co.companyId, String(statement.account_code), edge, `re-filing a statement for ${month}`);
    if (shut) return shut;
  }

  const { error: upErr } = await sb.from('acc_bank_statements')
    .update({ period_from: window.from, period_to: window.to, updated_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', co.companyId);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true, periodFrom: window.from, periodTo: window.to });
});

/* ── GET /bank/statements — the list ──────────────────────────────────────── */

export const bankStatements = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const { data: stmtRaw, error } = await sb.from('acc_bank_statements')
    .select('id, account_code, file_name, period_from, period_to, line_count, skipped_lines, in_sen, out_sen, opening_balance_sen, closing_balance_sen, status, uploaded_by, created_at')
    .eq('company_id', co.companyId)
    .order('period_from', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const statements = (stmtRaw ?? []) as Array<Record<string, any>>;
  if (statements.length === 0) return c.json({ statements: [] });

  const { data: lineRaw, error: lErr } = await sb.from('acc_bank_statement_lines')
    .select('statement_id, state, kind, amount_sen').eq('company_id', co.companyId);
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);

  /* Derived, never stored: how much of each statement is still undecided is a
     live question, and a column would answer yesterday's. */
  const openBy = new Map<number, { count: number; sen: number; payouts: number }>();
  for (const l of (lineRaw ?? []) as Array<Record<string, any>>) {
    if (String(l.state) !== 'OPEN') continue;
    const id = Number(l.statement_id);
    const at = openBy.get(id) ?? { count: 0, sen: 0, payouts: 0 };
    at.count += 1;
    at.sen += Number(l.amount_sen ?? 0);
    if (String(l.kind).startsWith('PAYOUT')) at.payouts += 1;
    openBy.set(id, at);
  }

  return c.json({
    statements: statements.map((s) => {
      const open = openBy.get(Number(s.id)) ?? { count: 0, sen: 0, payouts: 0 };
      return { ...s, open_count: open.count, open_sen: open.sen, open_payout_count: open.payouts };
    }),
  });
});

/* ── GET /bank/statements/:id — one, with its reconciliation ──────────────── */

export const bankStatementDetail = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'bad_id' }, 400);
  const sb = c.get('supabase');

  const { data: stmt, error } = await sb.from('acc_bank_statements')
    .select('*').eq('id', id).eq('company_id', co.companyId).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!stmt) return c.json({ error: 'not_found' }, 404);
  const statement = stmt as Record<string, any>;

  const [linesRes, matchRes, ledger, batches, elsewhere] = await Promise.all([
    sb.from('acc_bank_statement_lines').select('*').eq('statement_id', id).eq('company_id', co.companyId).order('line_no'),
    sb.from('acc_bank_statement_matches').select('bank_line_id, je_no, amount_sen, match_reason').eq('company_id', co.companyId),
    loadAccountLedger(sb, co.companyId, String(statement.account_code), String(statement.period_to)),
    loadPayableBatches(sb, co.companyId),
    loadClaimedElsewhere(sb, co.companyId, String(statement.account_code), id),
  ]);
  if (linesRes.error) return c.json({ error: 'load_failed', reason: linesRes.error.message }, 500);
  if (matchRes.error) return c.json({ error: 'load_failed', reason: matchRes.error.message }, 500);
  if (!ledger.ok) return c.json({ error: 'load_failed', reason: ledger.reason }, 500);
  if (!batches.ok) return c.json({ error: 'load_failed', reason: batches.reason }, 500);
  if (!elsewhere.ok) return c.json({ error: 'load_failed', reason: elsewhere.reason }, 500);
  const claimedElsewhere = claimedSetFor(elsewhere, ledger.movements);

  const lines = (linesRes.data ?? []) as Array<Record<string, any>>;
  const matchesByLine = new Map<number, Array<Record<string, any>>>();
  for (const m of (matchRes.data ?? []) as Array<Record<string, any>>) {
    const key = Number(m.bank_line_id);
    const at = matchesByLine.get(key);
    if (at) at.push(m); else matchesByLine.set(key, [m]);
  }

  /* A match row on a line that is not POSTED is nobody's claim — an older
     undo left such rows behind (docs/bugs/0802) and the books counted six
     entries as claimed while the bank counted six movements as open. */
  const liveMatches = (l: { id?: unknown; state?: unknown }) => (String(l.state) === 'POSTED' ? (matchesByLine.get(Number(l.id)) ?? []) : []);
  const movements: StatementMovement[] = lines.map((l) => ({
    id: Number(l.id),
    bookedOn: String(l.booked_on).slice(0, 10),
    description: String(l.description ?? ''),
    reference: l.reference ?? null,
    amountSen: Number(l.amount_sen ?? 0),
    state: String(l.state) as StatementMovement['state'],
    jeNo: String(l.state) === 'POSTED' ? (jeNosOf(l.posted_je_no).at(0) ?? liveMatches(l)[0]?.je_no ?? null) : null,
    /* Every entry the line names — a split's "A, B" is two (docs/bugs/0809) —
       and every match row it carries. */
    jeNos: String(l.state) === 'POSTED'
      ? [...new Set([...jeNosOf(l.posted_je_no), ...liveMatches(l).map((m) => String(m.je_no))])]
      : [],
  }));

  const reconciliation = reconcileBankStatement({
    periodFrom: String(statement.period_from),
    periodTo: String(statement.period_to),
    statementOpeningSen: statement.opening_balance_sen == null ? null : Number(statement.opening_balance_sen),
    statementClosingSen: statement.closing_balance_sen == null ? null : Number(statement.closing_balance_sen),
    movements,
    ledger: ledger.movements,
    claimedElsewhere,
  });

  /* The ledger entries nothing on this statement claims, named — a count is not
     something anybody can chase. This period's, and the EARLIER ones still
     waiting for a bank to show them (owner: 之前 in book 还没有 recon 的也要带
     下来), each marked which it is. */
  const claimed = new Set(movements.flatMap((m) => [m.jeNo, ...(m.jeNos ?? [])]).filter(Boolean));
  const unmatchedEntries = ledger.movements
    .filter((l) => l.entryDate <= String(statement.period_to))
    .filter((l) => !claimed.has(l.jeNo))
    .filter((l) => l.entryDate >= String(statement.period_from) || !claimedElsewhere.has(l.jeNo))
    .map((l) => ({ ...l, carried: l.entryDate < String(statement.period_from) }));

  return c.json({
    statement,
    reconciliation,
    lines: lines.map((l) => ({
      ...l,
      matches: liveMatches(l),
      /* Which statements this line COULD settle, recomputed live: a batch that
         was paid since the upload must not still be offered. */
      candidates: String(l.kind).startsWith('PAYOUT')
        ? batches.batches.filter((b) => b.acquirerCode === l.acquirer_code)
        : [],
      /* And which LEDGER ENTRY it could be — the answer for the rest of the
         statement, which is most of it. Offered only while the movement is
         still open; a posted one already has its entry. Ranked and filtered by
         acc/bank-match, and drawn from the WHOLE period's ledger rather than
         the unmatched list above, because that list is windowed to the
         statement and an entry posted two days after it ends is exactly the
         cheque this is for. */
      entryCandidates: String(l.state) === 'OPEN'
        ? entryCandidatesFor(
          { bookedOn: String(l.booked_on).slice(0, 10), amountSen: Number(l.amount_sen ?? 0) },
          ledger.movements,
          claimed as ReadonlySet<string>,
        )
        : [],
    })),
    unmatchedEntries,
  });
});

/* ── POST /bank/lines/:id/receipt — this credit paid that statement ───────── */

export const bankLineReceipt = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const lineId = Number(c.req.param('id'));
  if (!Number.isInteger(lineId)) return c.json({ error: 'bad_id' }, 400);

  /* A closed month refuses this (owner: 还有lock 起来不可以随便碰).
     Asked BEFORE the row is read, so a locked month gives the same answer
     whether or not the movement exists. */
  {
    const shut = await refuseIfLineLocked(c, co.companyId, lineId, "booking this credit");
    if (shut) return shut;
  }
  let body: any;
  try { body = await c.req.json(); } catch { body = {}; }
  const sb = c.get('supabase');

  const { data: lineRaw, error } = await sb.from('acc_bank_statement_lines')
    .select('id, booked_on, amount_sen, state, kind, acquirer_code, reference, statement_id')
    .eq('id', lineId).eq('company_id', co.companyId).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!lineRaw) return c.json({ error: 'not_found' }, 404);
  const line = lineRaw as Record<string, any>;

  if (String(line.state) !== 'OPEN') {
    return c.json({
      error: 'not_open',
      message: `This movement is already ${String(line.state).toLowerCase()}. Undo it first if it went to the wrong statement.`,
    }, 409);
  }
  if (Number(line.amount_sen) <= 0) {
    return c.json({ error: 'not_a_receipt', message: 'This movement takes money OUT of the account — it is not a payout.' }, 400);
  }

  /* ONE CREDIT CAN PAY SEVERAL STATEMENTS. Public Bank's advice of 10 Aug pays
     for trading on the 7th, 8th and 9th — the ordinary case, not an edge one —
     and the owner raised the same shape one level down: 顾客可能刷一次卡，但是还
     两个单. `batchId` stays as the shorthand for the ordinary single payout. */
  const raw: unknown = Array.isArray(body.allocations) && body.allocations.length > 0
    ? body.allocations
    : (body.batchId ? [{ batchId: body.batchId, amountSen: Number(line.amount_sen) }] : []);
  const allocations = (raw as Array<Record<string, unknown>>).map((a) => ({
    batchId: Number(a.batchId ?? 0),
    amountSen: Math.round(Number(a.amountSen ?? 0)),
  }));
  if (allocations.length === 0 || allocations.some((a) => !Number.isInteger(a.batchId) || a.batchId <= 0)) {
    return c.json({ error: 'no_batch', message: 'Say which merchant statement(s) this credit pays.' }, 400);
  }
  if (new Set(allocations.map((a) => a.batchId)).size !== allocations.length) {
    return c.json({ error: 'duplicate_batch', message: 'The same merchant statement is listed twice. One share each.' }, 400);
  }
  if (allocations.some((a) => !Number.isFinite(a.amountSen) || a.amountSen === 0)) {
    return c.json({ error: 'bad_amount', message: 'Every share must be an amount.' }, 400);
  }

  /* The shares must add up to the credit, TO THE SEN — the same discipline the
     merchant side applies to a swipe covering two orders. A leftover is a
     difference, and a difference is the thing this module exists to surface,
     never to absorb. */
  const allocated = allocations.reduce((s, a) => s + a.amountSen, 0);
  if (allocated !== Number(line.amount_sen)) {
    const diff = (allocated - Number(line.amount_sen)) / 100;
    return c.json({
      error: 'amount_mismatch',
      message: `The shares add up to ${(allocated / 100).toFixed(2)}, but this credit is ${(Number(line.amount_sen) / 100).toFixed(2)}`
        + ` — a difference of ${diff.toFixed(2)}. Fix the split; do not book a difference you cannot explain.`,
    }, 400);
  }

  /* The DATE comes off the bank statement, not off the request: it is what the
     bank says, and the whole point of uploading the file is that nobody has to
     retype it. */
  const receivedOn = String(line.booked_on).slice(0, 10);
  const bankRef = line.reference ?? null;
  const posted: Array<{ batchId: number; receiptId: number; jeNo?: string; outstandingSen: number }> = [];

  /* WHICH BANK the money is in — the statement's own account, not the
     acquirer's configured one. The owner asked exactly this: 不确定 maybank 对
     其他的卡机. An acquirer set up to pay into Hong Leong whose credit turns up
     on the Maybank statement really is money in Maybank, and booking it to Hong
     Leong would leave Maybank's reconciliation permanently short by that
     amount. The statement is evidence; the configuration is a guess made before
     the money moved. */
  const { data: stmtRaw, error: stmtRdErr } = await sb.from('acc_bank_statements')
    .select('account_code').eq('id', line.statement_id).eq('company_id', co.companyId).maybeSingle();
  if (stmtRdErr) return c.json({ error: 'load_failed', reason: stmtRdErr.message }, 500);
  const bankAccountCode = (stmtRaw as { account_code?: string } | null)?.account_code ?? null;

  for (const a of allocations) {
    const r = await postBatchReceipt(sb, co.companyId, a.batchId, {
      receivedOn, amountSen: a.amountSen, bankRef, bankAccountCode, userName: userName(c),
    });
    if (!r.ok) {
      /* A refusal partway through must not leave half a payout booked. Every
         receipt already written is reversed — through the engine, so the
         contra entries exist — before the refusal is returned. */
      const undone: string[] = [];
      for (const done of posted) {
        const back = await undoBatchReceipt(sb, co.companyId, done.receiptId);
        if (!back.ok) undone.push(`${done.jeNo ?? done.receiptId}: ${back.reason}`);
      }
      return c.json({
        error: r.status,
        message: r.reason
          + (undone.length > 0
            ? ` — AND ${undone.length} earlier share(s) could not be taken back: ${undone.join('; ')}. Check the ledger before retrying.`
            : posted.length > 0 ? ` The other ${posted.length} share(s) were taken back, so nothing is half-booked.` : ''),
      }, 409);
    }
    posted.push({ batchId: a.batchId, receiptId: r.receiptId, jeNo: r.jeNo, outstandingSen: r.outstandingSen });
  }

  /* Point every receipt back at the movement it was read from. */
  for (const p of posted) {
    await sb.from('acc_settlement_receipts').update({ bank_line_id: lineId }).eq('id', p.receiptId);
  }

  const { error: upErr } = await sb.from('acc_bank_statement_lines').update({
    state: 'POSTED',
    /* One entry number when there is one, all of them when the credit was
       split — the operator asks "which JE" and both answers are true. */
    posted_je_no: posted.map((p) => p.jeNo).filter(Boolean).join(', ') || null,
    updated_at: new Date().toISOString(),
  }).eq('id', lineId).eq('company_id', co.companyId);
  if (upErr) {
    return c.json({
      error: 'save_failed',
      reason: `${upErr.message} (the receipt(s) WERE posted — the statement line did not record it)`,
    }, 500);
  }

  return c.json({
    ok: true,
    status: 'posted',
    jeNo: posted.map((p) => p.jeNo).filter(Boolean).join(', '),
    /* Per statement, because a split has no single outstanding figure and the
       operator wants to know which of them is now clear. */
    results: posted.map((p) => ({ batchId: p.batchId, jeNo: p.jeNo ?? null, outstandingSen: p.outstandingSen })),
  });
});

/* ── POST /bank/lines/:id/undo — take it back ─────────────────────────────── */

export const bankLineUndo = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const lineId = Number(c.req.param('id'));
  if (!Number.isInteger(lineId)) return c.json({ error: 'bad_id' }, 400);

  /* A closed month refuses this (owner: 还有lock 起来不可以随便碰).
     Asked BEFORE the row is read, so a locked month gives the same answer
     whether or not the movement exists. */
  {
    const shut = await refuseIfLineLocked(c, co.companyId, lineId, "undoing this movement");
    if (shut) return shut;
  }
  const sb = c.get('supabase');

  const { data: lineRaw, error } = await sb.from('acc_bank_statement_lines')
    .select('id, state').eq('id', lineId).eq('company_id', co.companyId).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!lineRaw) return c.json({ error: 'not_found' }, 404);
  const line = lineRaw as Record<string, any>;

  /* An IGNORED line has no entry to reverse — putting it back is just a state
     change, and saying so is cheaper than a refusal the operator has to
     interpret. */
  if (String(line.state) === 'OPEN') return c.json({ ok: true, status: 'already_open' });

  /* ALL of them: a split payout wrote one receipt per statement, and undoing
     the movement means undoing every one. Read from the receipt side, which is
     where the link lives precisely because there can be several. */
  const { data: mine, error: rErr } = await sb.from('acc_settlement_receipts')
    .select('id').eq('bank_line_id', lineId).eq('company_id', co.companyId);
  if (rErr) return c.json({ error: 'load_failed', reason: rErr.message }, 500);

  const stuck: string[] = [];
  for (const r of (mine ?? []) as Array<{ id: number }>) {
    const undone = await undoBatchReceipt(sb, co.companyId, Number(r.id));
    /* Keep going rather than stopping at the first refusal: leaving the rest
       booked because one would not come back is the worse of the two states,
       and every failure is named below. */
    if (!undone.ok) stuck.push(`receipt ${r.id}: ${undone.reason}`);
  }
  if (stuck.length > 0) {
    return c.json({
      error: 'undo_incomplete',
      message: `${stuck.length} of ${(mine ?? []).length} credit(s) could not be taken back — ${stuck.join('; ')}.`
        + ' The rest were reversed; this movement is left as posted so nothing is hidden.',
    }, 409);
  }

  /* LET GO OF THE ENTRY (docs/bugs/0802). The link is what makes the books
     count the entry as claimed; a line put back to OPEN with its link still
     standing left the two sides disagreeing and the entry unmatchable.

     THE WHOLE GROUP (docs/bugs/0803). Two movements matched to one entry, or
     one movement to two entries, are one decision: undoing one of the pair
     would leave the entry half-claimed, a state the identity cannot hold. So
     every movement sharing this movement's entries is reopened with it, and
     the reply says how many. */
  const { data: mineRaw, error: mErr } = await sb.from('acc_bank_statement_matches')
    .select('je_no').eq('company_id', co.companyId).eq('bank_line_id', lineId);
  if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
  const myJes = [...new Set(((Array.isArray(mineRaw) ? mineRaw : []) as Array<{ je_no: string }>).map((m) => String(m.je_no)))];
  const groupLineIds = new Set<number>([lineId]);
  if (myJes.length > 0) {
    const { data: sharedRaw, error: sErr } = await sb.from('acc_bank_statement_matches')
      .select('bank_line_id').eq('company_id', co.companyId).in('je_no', myJes);
    if (sErr) return c.json({ error: 'load_failed', reason: sErr.message }, 500);
    for (const m of (Array.isArray(sharedRaw) ? sharedRaw : []) as Array<{ bank_line_id: number }>) groupLineIds.add(Number(m.bank_line_id));
  }
  for (const other of groupLineIds) {
    if (other === lineId) continue;
    const shut = await refuseIfLineLocked(c, co.companyId, other, 'undoing this movement (it shares an entry with a movement in a closed month)');
    if (shut) return shut;
  }
  const ids = [...groupLineIds];
  const { error: unlinkErr } = await sb.from('acc_bank_statement_matches')
    .delete().eq('company_id', co.companyId).in('bank_line_id', ids);
  if (unlinkErr) return c.json({ error: 'save_failed', reason: unlinkErr.message }, 500);

  const { error: upErr } = await sb.from('acc_bank_statement_lines').update({
    state: 'OPEN', posted_je_no: null, posted_je_id: null,
    updated_at: new Date().toISOString(),
  }).in('id', ids).eq('company_id', co.companyId);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);

  return c.json({ ok: true, status: 'undone', linesReopened: ids.length });
});

/* ── POST /bank/lines/:id/ignore — none of our business ───────────────────── */

export const bankLineIgnore = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const lineId = Number(c.req.param('id'));
  if (!Number.isInteger(lineId)) return c.json({ error: 'bad_id' }, 400);

  /* A closed month refuses this (owner: 还有lock 起来不可以随便碰).
     Asked BEFORE the row is read, so a locked month gives the same answer
     whether or not the movement exists. */
  {
    const shut = await refuseIfLineLocked(c, co.companyId, lineId, "leaving this movement out");
    if (shut) return shut;
  }
  let body: any;
  try { body = await c.req.json(); } catch { body = {}; }
  const note = String(body.note ?? '').trim();
  const sb = c.get('supabase');

  const { data: lineRaw, error } = await sb.from('acc_bank_statement_lines')
    .select('id, state').eq('id', lineId).eq('company_id', co.companyId).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!lineRaw) return c.json({ error: 'not_found' }, 404);
  if (String((lineRaw as Record<string, any>).state) === 'POSTED') {
    return c.json({
      error: 'already_posted',
      message: 'This movement has an entry behind it. Undo that first — ignoring it would leave the entry with nothing explaining it.',
    }, 409);
  }
  /* A reason, required. An ignored line leaves the reconciliation for ever and
     the next person to look has only this sentence to go on. */
  if (!note) {
    return c.json({ error: 'no_reason', message: 'Say why this movement is not ours to reconcile — it leaves the difference permanently.' }, 400);
  }

  const { error: upErr } = await sb.from('acc_bank_statement_lines')
    .update({ state: 'IGNORED', note, updated_at: new Date().toISOString() })
    .eq('id', lineId).eq('company_id', co.companyId);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true, status: 'ignored' });
});

/* ── POST /bank/lines/:id/match — this movement is that entry ─────────────── */

export const bankLineMatch = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const lineId = Number(c.req.param('id'));
  if (!Number.isInteger(lineId)) return c.json({ error: 'bad_id' }, 400);

  /* A closed month refuses this (owner: 还有lock 起来不可以随便碰).
     Asked BEFORE the row is read, so a locked month gives the same answer
     whether or not the movement exists. */
  {
    const shut = await refuseIfLineLocked(c, co.companyId, lineId, "matching this movement");
    if (shut) return shut;
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const jeNo = String(body.jeNo ?? '').trim();
  if (!jeNo) return c.json({ error: 'no_entry', message: 'Say which journal entry this movement is.' }, 400);
  const sb = c.get('supabase');

  const { data: lineRaw, error } = await sb.from('acc_bank_statement_lines')
    .select('id, amount_sen, state').eq('id', lineId).eq('company_id', co.companyId).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!lineRaw) return c.json({ error: 'not_found' }, 404);
  const line = lineRaw as Record<string, any>;

  /* ROWS AN OLDER UNDO LEFT BEHIND (docs/bugs/0802). A match on a line that is
     no longer POSTED is nobody's claim, and it must not be the reason this
     entry "cannot account for two". Cleared here, by what the line says now,
     before the unique index is asked. */
  {
    const { data: staleRaw, error: sErr } = await sb.from('acc_bank_statement_matches')
      .select('id, bank_line_id').eq('company_id', co.companyId).eq('je_no', jeNo);
    if (sErr) return c.json({ error: 'load_failed', reason: sErr.message }, 500);
    const stale = (Array.isArray(staleRaw) ? staleRaw : []) as Array<{ id: number; bank_line_id: number }>;
    if (stale.length > 0) {
      const { data: theirLines, error: lErr } = await sb.from('acc_bank_statement_lines')
        .select('id, state').eq('company_id', co.companyId).in('id', stale.map((m) => Number(m.bank_line_id)));
      if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
      const posted = new Set(((Array.isArray(theirLines) ? theirLines : []) as Array<{ id: number; state: string }>).filter((l) => String(l.state) === 'POSTED').map((l) => Number(l.id)));
      /* A live claim by another movement: one entry cannot account for two.
         Since docs/bugs/0803 the index no longer says this; the route does. */
      if (stale.some((m) => posted.has(Number(m.bank_line_id)) && Number(m.bank_line_id) !== lineId)) {
        return c.json({
          error: 'already_matched',
          message: `${jeNo} is already reconciled against another movement on a bank statement. One entry cannot account for two.`,
        }, 409);
      }
      const dead = stale.filter((m) => !posted.has(Number(m.bank_line_id)) || Number(m.bank_line_id) === lineId).map((m) => Number(m.id));
      if (dead.length > 0) {
        const { error: dErr } = await sb.from('acc_bank_statement_matches').delete().eq('company_id', co.companyId).in('id', dead);
        if (dErr) return c.json({ error: 'save_failed', reason: dErr.message }, 500);
      }
    }
  }

  const { error: insErr } = await sb.from('acc_bank_statement_matches').insert({
    bank_line_id: lineId,
    company_id: co.companyId,
    je_no: jeNo,
    amount_sen: Number(line.amount_sen ?? 0),
    match_reason: 'manual',
  });
  if (insErr) {
    /* The database's own guarantee, surfaced as a sentence: one entry cannot
       account for two bank movements, and the second one to claim it loses. */
    const twice = String(insErr.code ?? '') === '23505' || /duplicate key/i.test(String(insErr.message ?? ''));
    return c.json({
      error: twice ? 'already_matched' : 'save_failed',
      message: twice
        ? `${jeNo} is already reconciled against another movement on a bank statement. One entry cannot account for two.`
        : insErr.message,
    }, twice ? 409 : 500);
  }

  const { error: upErr } = await sb.from('acc_bank_statement_lines')
    .update({ state: 'POSTED', posted_je_no: jeNo, updated_at: new Date().toISOString() })
    .eq('id', lineId).eq('company_id', co.companyId);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);

  return c.json({ ok: true, status: 'matched', jeNo });
});

/* ── POST /bank/lines/match-group — several movements are one entry, or one
   movement is several entries (docs/bugs/0803) ──────────────────────────────
   Owner, 2026-09-11, on OR-2604-001 — RM 39,000 received, shown by the bank
   as RM 29,000 + RM 10,000: 他对应的是这两笔，你应该开发让我自由选. Any open
   movements of one account and any entries of its ledger, ONE SIDE AT A TIME
   (several-to-one or one-to-several; several-to-several is two decisions
   pretending to be one), and the two sides must add up to the sen (owner:
   勾的总额必须等于那个 entry 的金额). An entry a POSTED movement already
   claims is refused by name; a closed month refuses every line in it. */
export const bankLinesMatchGroup = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const lineIds = [...new Set((Array.isArray(body.lineIds) ? body.lineIds : []).map((v: unknown) => Number(v)).filter((n: number) => Number.isInteger(n)))] as number[];
  const jeNos = [...new Set((Array.isArray(body.jeNos) ? body.jeNos : []).map((v: unknown) => String(v ?? '').trim()).filter(Boolean))] as string[];
  if (lineIds.length === 0) return c.json({ error: 'no_lines', message: 'Tick the movements first.' }, 400);
  if (jeNos.length === 0) return c.json({ error: 'no_entry', message: 'Say which journal entry (or entries) these movements are.' }, 400);
  if (lineIds.length > 1 && jeNos.length > 1) {
    return c.json({
      error: 'one_side_only',
      message: 'Match several movements to ONE entry, or one movement to several entries — not several to several. Do it as two matches.',
    }, 400);
  }

  for (const id of lineIds) {
    const shut = await refuseIfLineLocked(c, co.companyId, id, 'matching these movements');
    if (shut) return shut;
  }
  const sb = c.get('supabase');

  const { data: linesRaw, error: lErr } = await sb.from('acc_bank_statement_lines')
    .select('id, statement_id, amount_sen, state').eq('company_id', co.companyId).in('id', lineIds);
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const lines = (Array.isArray(linesRaw) ? linesRaw : []) as Array<{ id: number; statement_id: number; amount_sen: number; state: string }>;
  if (lines.length !== lineIds.length) return c.json({ error: 'not_found', message: 'One of the movements is not on this company\'s statements. Refresh the list.' }, 404);
  const notOpen = lines.find((l) => String(l.state) !== 'OPEN');
  if (notOpen) {
    return c.json({ error: 'not_open', message: `Movement ${notOpen.id} is already ${String(notOpen.state).toLowerCase()}. Undo it first.` }, 409);
  }
  const { data: stmtsRaw, error: sErr } = await sb.from('acc_bank_statements')
    .select('id, account_code').eq('company_id', co.companyId).in('id', [...new Set(lines.map((l) => Number(l.statement_id)))]);
  if (sErr) return c.json({ error: 'load_failed', reason: sErr.message }, 500);
  const accounts = [...new Set(((Array.isArray(stmtsRaw) ? stmtsRaw : []) as Array<{ account_code: string }>).map((s) => String(s.account_code)))];
  if (accounts.length !== 1) return c.json({ error: 'mixed_accounts', message: 'The movements ticked are on statements of different bank accounts.' }, 400);
  const accountCode = accounts[0]!;

  /* The entries, by what the ledger says they are — never the screen's amount. */
  const ledger = await loadAccountLedger(sb, co.companyId, accountCode, '9999-12-31');
  if (!ledger.ok) return c.json({ error: 'load_failed', reason: ledger.reason }, 500);
  const entries = jeNos.map((n) => ledger.movements.find((m) => m.jeNo === n) ?? null);
  const missingAt = entries.findIndex((e) => e === null);
  if (missingAt >= 0) {
    return c.json({ error: 'entry_not_found', message: `${jeNos[missingAt]} is not a posted entry on ${accountCode}.` }, 404);
  }
  const found = entries as Array<NonNullable<typeof entries[number]>>;

  /* An entry a POSTED movement already accounts for. */
  const { data: heldRaw, error: hErr } = await sb.from('acc_bank_statement_matches')
    .select('je_no, bank_line_id').eq('company_id', co.companyId).in('je_no', jeNos);
  if (hErr) return c.json({ error: 'load_failed', reason: hErr.message }, 500);
  const held = (Array.isArray(heldRaw) ? heldRaw : []) as Array<{ je_no: string; bank_line_id: number }>;
  if (held.length > 0) {
    const { data: heldLines, error: hlErr } = await sb.from('acc_bank_statement_lines')
      .select('id, state').eq('company_id', co.companyId).in('id', held.map((m) => Number(m.bank_line_id)));
    if (hlErr) return c.json({ error: 'load_failed', reason: hlErr.message }, 500);
    const posted = new Set(((Array.isArray(heldLines) ? heldLines : []) as Array<{ id: number; state: string }>).filter((l) => String(l.state) === 'POSTED').map((l) => Number(l.id)));
    const live = held.find((m) => posted.has(Number(m.bank_line_id)));
    if (live) {
      return c.json({
        error: 'already_matched',
        message: `${live.je_no} is already reconciled against another movement on a bank statement. One entry cannot account for two.`,
      }, 409);
    }
    /* The rest are rows an older undo left behind (docs/bugs/0802). */
    const { error: dErr } = await sb.from('acc_bank_statement_matches').delete().eq('company_id', co.companyId).in('je_no', jeNos);
    if (dErr) return c.json({ error: 'save_failed', reason: dErr.message }, 500);
  }

  const linesSen = lines.reduce((s, l) => s + Number(l.amount_sen), 0);
  const entriesSen = found.reduce((s, e) => s + (e.debitSen - e.creditSen), 0);
  if (linesSen !== entriesSen) {
    return c.json({
      error: 'amount_mismatch',
      message: `The movements come to ${rm(linesSen)} and the entries to ${rm(entriesSen)} — ${rm(linesSen - entriesSen)} out. The two sides must add up to the sen before anything is matched.`,
    }, 409);
  }

  /* Rows: several movements → one entry carry each movement's amount; one
     movement → several entries carry each entry's amount. Either way the rows
     of an entry sum to what it is, and the rows of a movement to what it is. */
  const rows = lineIds.length > 1
    ? lines.map((l) => ({ bank_line_id: Number(l.id), company_id: co.companyId, je_no: jeNos[0]!, amount_sen: Number(l.amount_sen), match_reason: 'manual' }))
    : found.map((e) => ({ bank_line_id: lineIds[0]!, company_id: co.companyId, je_no: e.jeNo, amount_sen: e.debitSen - e.creditSen, match_reason: 'manual' }));
  const { error: insErr } = await sb.from('acc_bank_statement_matches').insert(rows);
  if (insErr) return c.json({ error: 'save_failed', reason: insErr.message }, 500);

  const { error: upErr } = await sb.from('acc_bank_statement_lines')
    .update({ state: 'POSTED', posted_je_no: jeNos[0]!, updated_at: new Date().toISOString() })
    .in('id', lineIds).eq('company_id', co.companyId);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);

  return c.json({ ok: true, status: 'matched', lines: lineIds.length, entries: jeNos.length, jeNos });
});

const rm = (sen: number) =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ── Bank recognition rules — the maintenance window (2026-09-02) ────────────
   The rules that say "this credit is PBB's payout" have been seed-only since
   0336; when a bank rewords its narration, the owner had to come to us. These
   three handlers are his screwdriver: list everything (off rows included),
   fix a rule, add one. GLOBAL like the table — a payout reads the same in
   every company's statement, so there is nothing per-company to scope.

   The one real hazard is a BROKEN regex: loadRecognitionRules compiles each
   pattern at match time, and a pattern that does not compile silently stops
   recognising that acquirer's money — the 系统3 disease with extra steps. So
   every regex is compiled HERE, at write time, and a bad one is refused with
   the engine's own sentence. No DELETE: is_active=false is the off switch,
   and history stays. */

const RULE_FIELDS = 'id, acquirer_code, pattern, match_field, trading_date_pattern, merchant_pattern, sort_order, is_active';

const ruleValidationError = (body: Record<string, unknown>): string | null => {
  for (const key of ['pattern', 'tradingDatePattern', 'merchantPattern'] as const) {
    const v = body[key];
    if (v == null || v === '') continue;
    try { void new RegExp(String(v), 'i'); } catch (e) {
      return `${key} is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (key !== 'pattern' && !String(v).includes('(')) {
      return `${key} needs a capture group — its FIRST group is the value being extracted.`;
    }
  }
  if (body.matchField != null && !['description', 'reference', 'both'].includes(String(body.matchField))) {
    return `matchField must be description, reference or both.`;
  }
  return null;
};

export const bankRulesList = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data, error } = await sb.from('acc_bank_recognition_rules')
    .select(RULE_FIELDS)
    .order('acquirer_code').order('sort_order');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ rules: data ?? [] });
});

export const bankRuleCreate = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const acquirerCode = String(body.acquirerCode ?? '').trim();
  const pattern = String(body.pattern ?? '').trim();
  if (!acquirerCode) return c.json({ error: 'acquirer_required' }, 400);
  if (!pattern) return c.json({ error: 'pattern_required', message: 'A rule with no pattern matches nothing.' }, 400);
  const bad = ruleValidationError({ ...body, pattern });
  if (bad) return c.json({ error: 'invalid_rule', message: bad }, 400);

  const { data: acq, error: acqErr } = await sb.from('acc_acquirer_config')
    .select('code').eq('code', acquirerCode).maybeSingle();
  if (acqErr) return c.json({ error: 'load_failed', reason: acqErr.message }, 500);
  if (!acq) return c.json({ error: 'no_such_acquirer', message: `${acquirerCode} is not an acquirer this system knows.` }, 404);

  const { data, error } = await sb.from('acc_bank_recognition_rules').insert({
    acquirer_code: acquirerCode,
    pattern,
    match_field: ['description', 'reference', 'both'].includes(String(body.matchField)) ? String(body.matchField) : 'both',
    trading_date_pattern: body.tradingDatePattern ? String(body.tradingDatePattern) : null,
    merchant_pattern: body.merchantPattern ? String(body.merchantPattern) : null,
    sort_order: Number.isFinite(Number(body.sortOrder)) ? Math.round(Number(body.sortOrder)) : 100,
    is_active: body.isActive !== false,
  }).select(RULE_FIELDS).single();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, rule: data });
});

export const bankRuleUpdate = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const ruleId = Number(c.req.param('id'));
  if (!Number.isInteger(ruleId)) return c.json({ error: 'bad_id' }, 400);
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const bad = ruleValidationError(body);
  if (bad) return c.json({ error: 'invalid_rule', message: bad }, 400);
  if (body.pattern !== undefined && !String(body.pattern).trim()) {
    return c.json({ error: 'pattern_required', message: 'A rule with no pattern matches nothing — switch it off instead.' }, 400);
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.pattern !== undefined) updates.pattern = String(body.pattern).trim();
  if (body.matchField !== undefined) updates.match_field = String(body.matchField);
  if (body.tradingDatePattern !== undefined) updates.trading_date_pattern = body.tradingDatePattern ? String(body.tradingDatePattern) : null;
  if (body.merchantPattern !== undefined) updates.merchant_pattern = body.merchantPattern ? String(body.merchantPattern) : null;
  if (body.sortOrder !== undefined) updates.sort_order = Math.round(Number(body.sortOrder));
  if (body.isActive !== undefined) updates.is_active = body.isActive === true;

  const { data, error } = await sb.from('acc_bank_recognition_rules')
    .update(updates).eq('id', ruleId).select(RULE_FIELDS).maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found', message: `rule ${ruleId} does not exist` }, 404);
  return c.json({ ok: true, rule: data });
});
