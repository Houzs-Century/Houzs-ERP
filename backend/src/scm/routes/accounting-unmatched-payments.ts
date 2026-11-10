// ----------------------------------------------------------------------------
// GET /accounting/unmatched-payments?from=&to= — every card and transfer
// payment dated in the window that is not matched yet, on one list (owner
// 2026-09-30: 我有没有一个表是显示全部还没 match 的 → 做). The rules are
// acc/unmatched-payments; this is the door. Registered in routes/accounting.ts
// so it inherits supabaseAuth and appears in the route-capability matrix.
//
// GET /accounting/unmatched-bank-lines?from=&to= — the bank's money-in lines no
// entry is matched to yet, the page's third list (owner 2026-11-10: 如果银行那边
// 的收款有，也没有对应的transaction 也可以显示 → 做). What each one is comes from
// Bank Recon's own live deciders — freshDecisions and withQrSales, which a
// statement and a month read too — and acc/bank-match entryCandidatesFor; the
// words and the order are acc/unmatched-bank-lines. Reads only.
//
// Gated like the two reconciliation screens they summarise (the settlement
// guard): scm.payment_voucher.post, read as well as write.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { paginateAll } from '../lib/paginate-all';
import { loadUnmatchedPayments } from '../../acc/unmatched-payments';
import {
  loadAccountLedger, loadBankConfigs, loadClaimedElsewhere, loadPayableBatches, loadPayoutAdvices,
  loadQrReports, loadRecognitionRules,
} from '../../acc/bank';
import { ENTRY_MATCH_WINDOW_DAYS, entryCandidatesFor, type EntryCandidate } from '../../acc/bank-match';
import { REPEAT_KIND } from '../../acc/bank-repeats';
import { withJournalRefs } from '../../acc/journal-refs';
import { bankName } from '../../acc/finance-todo';
import {
  MAX_ENTRY_OFFERS, unmatchedBankLinesOf, whatOf, type DecidedBankLine, type EntryOffer, type UnmatchedBankLine,
} from '../../acc/unmatched-bank-lines';
import { freshDecisions, withQrSales } from './accounting-bank';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Fail = { ok: false; reason: string };
type Row = Record<string, any>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** How far back the list reaches when the screen names no From — the
    in-transit list's reach, so the two agree on what "recent" means. */
export const UNMATCHED_DEFAULT_DAYS = 180;

const shiftDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The page's one gate and its one window, for every list on it. */
const opened = (c: Ctx): { ok: true; companyId: number; from: string; to: string; today: string } | { ok: false; response: Response } => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return { ok: false, response: c.json({ error: "You don't have permission to see the reconciliation lists." }, 403) };
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { ok: false, response: c.json(co.refusal, 409) };
  const today = todayMyt();
  const toQ = c.req.query('to') ?? '';
  const fromQ = c.req.query('from') ?? '';
  const to = DAY.test(toQ) ? toQ : today;
  const from = DAY.test(fromQ) ? fromQ : shiftDays(to, -UNMATCHED_DEFAULT_DAYS);
  if (from > to) return { ok: false, response: c.json({ error: 'bad_window', message: 'The From date is after the To date.' }, 400) };
  return { ok: true, companyId: co.companyId, from, to, today };
};

export const unmatchedPaymentsHandler = async (c: Ctx): Promise<Response> => {
  const at = opened(c);
  if (!at.ok) return at.response;
  const got = await loadUnmatchedPayments(c.get('supabase'), at.companyId, at);
  if (!got.ok) return c.json({ error: 'load_failed', reason: got.reason }, 500);
  return c.json({ from: at.from, to: at.to, rows: got.rows });
};

export const unmatchedBankLinesHandler = async (c: Ctx): Promise<Response> => {
  const at = opened(c);
  if (!at.ok) return at.response;
  const got = await loadUnmatchedBankLines(c.get('supabase'), at.companyId, at);
  if (!got.ok) return c.json({ error: 'load_failed', reason: got.reason }, 500);
  return c.json({ from: at.from, to: at.to, rows: got.rows });
};

const LINE_FIELDS = 'id, statement_id, line_no, booked_on, description, reference, amount_sen, charge_sen,'
  + ' kind, state, note, acquirer_code, trading_date, merchant_no, matched_batch_id, split';

const dayOf = (v: unknown): string => String(v ?? '').slice(0, 10);

/** Every OPEN money-in line dated in the window, decided as Bank Recon decides it today. */
async function loadUnmatchedBankLines(
  sb: any, companyId: number, window: { from: string; to: string; today: string },
): Promise<{ ok: true; rows: UnmatchedBankLine[] } | Fail> {
  const stmts = await paginateAll<Row>((lo, hi) => sb.from('acc_bank_statements')
    .select('id, account_code').eq('company_id', companyId).order('id').range(lo, hi));
  if (stmts.error) return { ok: false, reason: `bank statements: ${stmts.error.message}` };
  const accountOf = new Map((stmts.data ?? []).map((s) => [Number(s.id), String(s.account_code ?? '')]));

  const read = await paginateAll<Row>((lo, hi) => sb.from('acc_bank_statement_lines')
    .select(LINE_FIELDS).eq('company_id', companyId).eq('state', 'OPEN').gt('amount_sen', 0)
    .gte('booked_on', window.from).lte('booked_on', window.to)
    .order('id').range(lo, hi));
  if (read.error) return { ok: false, reason: `bank lines: ${read.error.message}` };
  /* A repeat of a movement an earlier file recorded is a copy, not money. */
  const open = (read.data ?? []).filter((l) => String(l.kind) !== REPEAT_KIND && accountOf.get(Number(l.statement_id)));
  if (open.length === 0) return { ok: true, rows: [] };

  const [rules, batches, payouts, qrReports, configs] = await Promise.all([
    loadRecognitionRules(sb), loadPayableBatches(sb, companyId), loadPayoutAdvices(sb, companyId),
    loadQrReports(sb, companyId), loadBankConfigs(sb, companyId),
  ]);
  if (!rules.ok) return { ok: false, reason: `recognition rules: ${rules.reason}` };
  if (!batches.ok) return { ok: false, reason: `merchant reports: ${batches.reason}` };
  if (!payouts.ok) return { ok: false, reason: `payment advices: ${payouts.reason}` };
  if (!qrReports.ok) return { ok: false, reason: `QR reports: ${qrReports.reason}` };
  if (!configs.ok) return { ok: false, reason: `bank accounts: ${configs.reason}` };

  /* Decided again against today's reports and advices (docs/bugs/0815). */
  const fresh = freshDecisions(open, rules.rules, batches.batches, payouts.payouts);
  const lines = open.map((l) => ({ ...l, ...(fresh.get(Number(l.id)) ?? {}) }) as Row);

  const decided: DecidedBankLine[] = [];
  const offersByLine = new Map<number, EntryOffer[]>();
  for (const account of [...new Set(lines.map((l) => accountOf.get(Number(l.statement_id))!))].sort()) {
    /* What every POSTED line of the account already holds: never offered again. */
    const claimed = await loadClaimedElsewhere(sb, companyId, account, null);
    if (!claimed.ok) return { ok: false, reason: `bank claims on ${account}: ${claimed.reason}` };
    const mine = withQrSales(lines.filter((l) => accountOf.get(Number(l.statement_id)) === account),
      rules.rules, qrReports.reports, claimed.claimed, account);

    const transfers = mine.filter((l) => whatOf(String(l.kind)) === 'TRANSFER');
    if (transfers.length > 0) {
      const last = transfers.map((l) => dayOf(l.booked_on)).sort().at(-1)!;
      const ledger = await loadAccountLedger(sb, companyId, account, shiftDays(last, ENTRY_MATCH_WINDOW_DAYS));
      if (!ledger.ok) return { ok: false, reason: `ledger of ${account}: ${ledger.reason}` };
      const candidates = new Map<number, EntryCandidate[]>(transfers.map((l) => [Number(l.id), entryCandidatesFor(
        { bookedOn: dayOf(l.booked_on), amountSen: Number(l.amount_sen ?? 0) }, ledger.movements, claimed.claimed,
      )]));
      /* Named the way a person knows them (docs/bugs/0918) — only the ones the list shows. */
      const shown = [...new Map([...candidates.values()].flatMap((list) => list.slice(0, MAX_ENTRY_OFFERS)).map((e) => [e.jeNo, e])).values()];
      const named = await withJournalRefs(sb, companyId, shown);
      if (!named.ok) return { ok: false, reason: `entry names on ${account}: ${named.reason}` };
      const nameOf = new Map(named.entries.map((e) => [e.jeNo, e]));
      for (const [id, list] of candidates) {
        offersByLine.set(id, list.map((e) => ({
          jeNo: e.jeNo, entryDate: e.entryDate, daysApart: e.daysApart,
          doc: nameOf.get(e.jeNo)?.doc ?? e.sourceDocNo ?? null,
          who: nameOf.get(e.jeNo)?.who ?? e.partyName ?? null,
        })));
      }
    }
    for (const l of mine) {
      decided.push({
        id: Number(l.id), statementId: Number(l.statement_id), accountCode: account,
        bookedOn: dayOf(l.booked_on), description: String(l.description ?? ''),
        reference: l.reference == null || String(l.reference).trim() === '' ? null : String(l.reference),
        amountSen: Number(l.amount_sen ?? 0), kind: String(l.kind ?? 'OTHER'),
        acquirerCode: l.acquirer_code == null ? null : String(l.acquirer_code),
        note: l.note == null ? null : String(l.note),
      });
    }
  }

  const bankOf = new Map(configs.configs.map((cfg) => [cfg.account_code, bankName(cfg.bank_code)]));
  return {
    ok: true,
    rows: unmatchedBankLinesOf(decided, (l) => offersByLine.get(l.id) ?? [], (a) => bankOf.get(a) ?? null, window.today),
  };
}
