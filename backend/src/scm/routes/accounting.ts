
import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { postSiRevenue } from '../lib/post-si-revenue';
import { MIGRATED_NO_GL_MESSAGE } from '../lib/migrated-chain';
import { paginateAll } from '../lib/paginate-all';
import { safeRate, toMyrSen } from '../lib/fx';
import { todayMyt } from '../lib/my-time';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { postJournal, reverseJournal } from '../../acc/engine';
import { upperTyped } from '../../acc/typed-text';
import { CONVERT_SOURCE, backfillSoPayments, paymentEntryDisagreements, unbookedPayments } from '../../acc/payments';
import { dailyBankHandler, cashbookBoardHandler } from './accounting-daily-bank';
import {
  cashbookGet, cashbookStartPut, cashbookStartDelete, cashbookReceiptCreate, cashbookReceiptUpdate, cashbookReceiptDelete,
  cashbookReceiptsDayPut, cashbookSkipPut, cashbookSkipDelete,
} from './accounting-daily-bank-cashbook';
import { systemTakings, postCashOverShort } from '../../acc/daily-close';
import { resolveRoles, piLines, DEFAULT_ROLE_CODES } from '../../acc/rules';
import { splitByItemGroup } from '../../acc/item-group-split';
import { classifyJournal } from '../../acc/journal-class';
import { isReversalPair } from '../../acc/reversal-pairs';
import { balancesAsOf, type AccountBalanceRow, type LaterLine } from '../../acc/balances-as-of';
import { resolveJournalRefs } from '../../acc/journal-refs';
import { resolveJournalDocument } from '../../acc/journal-document';
import { runControlCheck } from '../../acc/control-check';
import { selfCheckRunHandler } from './accounting-self-check';
import { ledgerReport } from './accounting-ledger';
import {
  settlementSetup, settlementSetupSave, settlementUpload, settlementBatches,
  settlementBatchDetail, settlementConfirmRow, settlementConfirmGroup, settlementConfirmMatched, settlementRowUnconfirm,
  settlementIgnoreRow, settlementReleaseRow, settlementWatchlist, settlementExport, settlementInTransit, settlementFindPayments,
  settlementBatchReceived, settlementReceiptUndo,
  settlementMaintenance, settlementMaintenanceMerchant, settlementMaintenanceBank, settlementRematch,
} from './accounting-settlement';
import { settlementOtherCompanies, settlementRowSoldBy } from './accounting-settlement-sold-by';
import {
  bankSetup, bankUpload, bankStatements, bankStatementDetail,
  bankRulesList, bankRuleCreate, bankRuleUpdate,
  bankLineReceipt, bankLineMatch, bankLineIgnore, bankLineUndo, bankLinesMatchGroup, bankStatementPeriod, bankStatementAutoMatch,
  bankStatementRepeats,
} from './accounting-bank';
import { bankCardPayments, bankLineMatchWithCards } from './accounting-bank-cards';
import { bankMonths, bankMonthDetail, bankMonthClosing } from './accounting-bank-months';
import { bankLocks, bankMonthLock, bankMonthUnlock } from './accounting-bank-locks';
import { paymentCorrections } from './accounting-payment-corrections';
import { unmatchedBankLinesHandler, unmatchedPaymentsHandler } from './accounting-unmatched-payments';
import { previousPaymentsList, previousPaymentsMark, previousPaymentsUndo } from './accounting-previous-payments';
import { arAgingHandler, apAgingHandler } from './accounting-aging';
import { productProfitHandler } from './accounting-product-profit';
import { productChangesHandler } from './accounting-product-changes';
import { soBacklogCoverHandler } from './accounting-so-backlog-cover';
import { bankConfigList, bankConfigSave } from './accounting-bank-config';
import { payoutUpload, payoutList, payoutCharge, payoutChargeUndo, chargeAccountsHandler } from './accounting-payouts';
import {
  chartUnionHandler, chartTickHandler, chartImportHandler,
  chartRenameHandler, chartUpdateHandler, chartDeleteHandler, chartCreateHandler,
} from './accounting-chart';
import { itemGroupsList, itemGroupCreate, itemGroupBind, itemGroupPatch } from './accounting-item-groups';
import { piPeriodicBackfill } from './accounting-pi-backfill';
import { stockCloseStatus, stockCloseRun } from './accounting-stock-close';
import { commissionReleaseOrders, commissionReleaseRun, commissionReleaseSettings, commissionReleaseStatus } from './accounting-commission-release';
import { pnlReport, balanceSheetReport } from './accounting-reports';
import { journalEntryEdit } from './accounting-journal-edit';
import { reportLayoutGet, reportLayoutPut, reportLayoutReset } from './accounting-report-layouts';
import { receiptsPaymentsReport } from './accounting-rp';
import { openingBillPlacePut, openingBillsGet, openingBillsOfSupplier } from './accounting-opening-bill-places';
import { cashFlowForecastHandler, forecastInputsGetHandler, forecastInputsPutHandler, tfGetHandler, tfPutHandler, balanceSheetForecastHandler } from './accounting-cashflow-forecast';
import { collectionReport } from './accounting-collection';
import { merchantChargesReport } from './accounting-merchant-charges';
import { performanceMonthsHandler, performanceReport, savePerformanceSettingsHandler } from './accounting-performance';
import { forecastFiguresHandler, forecastGetHandler, forecastPutHandler } from './accounting-forecast';
import { pnlViewsReport } from './accounting-pnl-views';
import { dashboardForecastMonthHandler, dashboardHandler } from './accounting-dashboard';
import { financeTodoHandler, financeTodoCountHandler } from './accounting-todo';
import {
  todoPeopleHandler, todoSettingsGetHandler, todoSettingsPutHandler, todoGroupAddHandler,
  todoTaskCreateHandler, todoTaskGetHandler, todoTaskPatchHandler, todoTaskDeleteHandler, todoTaskDoneHandler, todoTaskReopenHandler,
  todoTaskMoveHandler, todoRemarkAddHandler, todoRemarkEditHandler, todoLinkSearchHandler, todoRuleAddHandler,
} from './accounting-todo-tasks';
import { todoCalendarHandler } from './accounting-todo-calendar';
import { rebankListHandler, rebankMoveHandler } from './accounting-rebank';
export { dailyBankHandler, loadDailyBankBoard } from './accounting-daily-bank';
import { openingAccountsPut, openingGet, openingLock, openingPaperCancel, openingPaperCreate, openingPaperUpdate, openingStockPut, openingUnlock } from './accounting-opening';
import { numberingGet, numberingPut } from './accounting-numbering';
import { receiptsList, receiptEnsure, receiptFormalise, receiptDetail } from './accounting-receipts';
import { receiptsCheck } from './accounting-receipts-check';
import { receiptsBackfillPlan, receiptsBackfillRun } from './accounting-receipts-backfill';
import { ACCOUNT_SECTIONS, defaultSectionFor } from '../lib/account-sections';
import { dateOrNull } from '../lib/date-coerce';

/* THE GENERAL LEDGER HAD NO PERMISSION CHECK AT ALL — eleven routes, zero
   `hasHouzsPerm` calls, including four that WRITE to the ledger: a hand-written
   journal entry, its posting, and the SI / PI revenue postings.

   Its only gate was `moneyWriteDenial` in the SCM area guard, and that fails
   OPEN for a caller with no position (services/positionPolicy.ts: "Unidentifiable
   caller (no position) -> not denied"). Payment vouchers are double-gated —
   flat keys on every write verb ON TOP of that policy — and the GL, which is
   what a voucher posts INTO, was not gated at all. The asymmetry is even named
   in positionPolicy's own comment: "payment-vouchers additionally checks flat
   scm.payment_voucher.* perms, so it was already double-gated; accounting was
   not gated at all."

   Gated on `scm.payment_voucher.post` — owner decision 2026-08-13, asked
   directly. It reuses a key that already exists and is already granted to the
   finance positions, so nobody is locked out today; inventing a new
   `scm.accounting.post` would have taken effect with NOBODY holding it and
   stopped GL posting until the positions matrix was updated. The semantics are
   near enough: posting a voucher IS posting to the GL. */
const requireGlPost = (c: Parameters<typeof hasHouzsPerm>[0]) =>
  hasHouzsPerm(c, 'scm.payment_voucher.post');
import {
  scopeToCompany, activeCompanyId, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
} from '../lib/companyScope';

export const accounting = new Hono<{ Bindings: Env; Variables: Variables }>();
accounting.use('*', supabaseAuth);

accounting.get('/settlement/setup', settlementSetup);
accounting.patch('/settlement/setup/:code', settlementSetupSave);
// Maintenance takes the company as a parameter (owner: 我会 overall 维护) — the
// handlers re-check it against the caller's own grants.
accounting.get('/settlement/maintenance', settlementMaintenance);
accounting.patch('/settlement/maintenance/merchant', settlementMaintenanceMerchant);
accounting.patch('/settlement/maintenance/bank', settlementMaintenanceBank);
accounting.post('/settlement/rematch', settlementRematch);
accounting.post('/settlement/batches', settlementUpload);
accounting.get('/settlement/batches', settlementBatches);
accounting.get('/settlement/batches/:id', settlementBatchDetail);
accounting.get('/settlement/batches/:id/export', settlementExport);
accounting.post('/settlement/batches/:id/confirm-matched', settlementConfirmMatched);
accounting.post('/settlement/batches/:id/received', settlementBatchReceived);
accounting.post('/settlement/receipts/:id/undo', settlementReceiptUndo);
accounting.post('/settlement/rows/:id/confirm', settlementConfirmRow);
/* Several lines of one report against several payments (owner 2026-11-03, option B). */
accounting.post('/settlement/rows/confirm-together', settlementConfirmGroup);
accounting.post('/settlement/rows/:id/unconfirm', settlementRowUnconfirm);
accounting.post('/settlement/rows/:id/ignore', settlementIgnoreRow);
/* Another company's sale swiped on this terminal (owner 2026-11-17: 2990's on Houzs's AEON). */
accounting.get('/settlement/other-companies', settlementOtherCompanies);
accounting.post('/settlement/rows/:id/sold-by', settlementRowSoldBy);
/* "Not this" — release an unconfirmed line's match (owner 2026-11-03, batch 3 d2). */
accounting.post('/settlement/rows/:id/release', settlementReleaseRow);
/* "Find the sale" — the card payments the window could not offer (docs/bugs/0792). */
accounting.get('/settlement/rows/:id/find', settlementFindPayments);
accounting.get('/settlement/watchlist', settlementWatchlist);
accounting.get('/settlement/in-transit', settlementInTransit);
/* Card AND transfer payments not matched yet, on one list (owner 2026-09-30:
   我有没有一个表是显示全部还没 match 的). Rules in acc/unmatched-payments. */
accounting.get('/unmatched-payments', unmatchedPaymentsHandler);
/* And the bank's money-in lines nothing in the books is matched to (owner
   2026-11-10: 如果银行那边的收款有，也没有对应的transaction 也可以显示). */
accounting.get('/unmatched-bank-lines', unmatchedBankLinesHandler);
/* A salesperson's payment record the owner marked as the previous system's — taken
   in nowhere (owner 2026-11-11: 我检查确定后，就直接说这个是之前record). Rules in
   acc/previous-payments. */
accounting.get('/previous-payments', previousPaymentsList);
accounting.post('/previous-payments', previousPaymentsMark);
accounting.post('/previous-payments/undo', previousPaymentsUndo);
/* The acquirer's own payment advice — Public Bank's IBG, which says which
   reports one bank credit pays (owner: 几份 excel 对一份 pdf). */
accounting.post('/settlement/payouts', payoutUpload);
accounting.get('/settlement/payouts', payoutList);
/* A bank charge deducted from one day of an advice, booked to the account
   Finance picks (docs/bugs/0787); and its undo. */
accounting.post('/settlement/payouts/:id/days/:settledOn/charge', payoutCharge);
accounting.delete('/settlement/payouts/:id/days/:settledOn/charge', payoutChargeUndo);
/* Where a charge may go, alone — for one kept off a bank credit (owner 2026-09-30). */
accounting.get('/settlement/charge-accounts', chargeAccountsHandler);

/* Layer 4 — reconciling the BANK's own statement (brief §3.5). Registered the
   same way and for the same reason: one path each, every one in the matrix.
   Owner, 2026-08-19: 我不是应该upload bank statement…然后你也自动核对吗 —
   整张月结单全部对. */
accounting.get('/bank/setup', bankSetup);
accounting.get('/item-groups', itemGroupsList);
accounting.post('/backfill/pi-periodic', piPeriodicBackfill);
accounting.get('/stock-close', stockCloseStatus);
accounting.post('/stock-close/run', stockCloseRun);
/* The monthly commission release (owner 2026-11-25): what the prepayment holds
   and releases, the switch and a manual run — the nightly run fires from the cron. */
accounting.get('/commission-release', commissionReleaseStatus);
accounting.get('/commission-release/orders', commissionReleaseOrders);
accounting.post('/commission-release/run', commissionReleaseRun);
accounting.post('/commission-release/settings', commissionReleaseSettings);
accounting.get('/reports/pnl', pnlReport);
/* The Overall P&L's views side by side — Actual, Performance, Forecast on the P&L's tree (owner 2026-11-25). */
accounting.get('/reports/pnl-views', pnlViewsReport);
accounting.get('/reports/receipts-payments', receiptsPaymentsReport);
accounting.get('/reports/receipts-payments/opening-bills', openingBillsGet);
accounting.put('/reports/receipts-payments/opening-bills/place', openingBillPlacePut);
accounting.get('/reports/receipts-payments/opening-bills/:supplierId', openingBillsOfSupplier);
accounting.get('/reports/cash-flow-forecast', cashFlowForecastHandler);
accounting.get('/reports/cash-flow-forecast/inputs', forecastInputsGetHandler);
accounting.put('/reports/cash-flow-forecast/inputs', forecastInputsPutHandler);
accounting.get('/reports/cash-flow-forecast/tf', tfGetHandler);
accounting.put('/reports/cash-flow-forecast/tf', tfPutHandler);
accounting.get('/reports/balance-sheet-forecast', balanceSheetForecastHandler);
/* Deposit and balance collected per salesman (owner 2026-09-12; docs/bugs/0825). */
accounting.get('/reports/collection', collectionReport);
/* What each acquirer charged against the gross, per month and per merchant (owner 2026-09-12; docs/bugs/0826). */
accounting.get('/reports/merchant-charges', merchantChargesReport);
accounting.get('/reports/balance-sheet', balanceSheetReport);
/* The layout a statement is drawn on — one tree of categories per report,
   shared by every company, ticked per company (owner 2026-09-14; docs/bugs/0911).
   Handlers in accounting-report-layouts.ts. */
accounting.get('/reports/layout', reportLayoutGet);
accounting.put('/reports/layout', reportLayoutPut);
accounting.delete('/reports/layout', reportLayoutReset);
/* The Performance P&L — the month's orders per group, a budgeted operating
   expense in place of one ledger account, the rest as booked (owner
   2026-09-12; docs/bugs/0835). Handlers in accounting-performance.ts. */
accounting.get('/reports/performance', performanceReport);
accounting.get('/reports/performance/months', performanceMonthsHandler);
/* The monthly product profit ranking (owner 2026-10-05): every product the
   month sold, by model, with its own cost and its share of the gifts.
   accounting-product-profit.ts; acc/product-profit.ts. */
accounting.get('/product-profit', productProfitHandler);
/* The product change reports (owner 2026-11-23): every product change on a
   sales order with its selling and cost before and after, by the month of its
   change day. accounting-product-changes.ts; acc/product-changes.ts. */
accounting.get('/product-changes', productChangesHandler);
/* The SO conversion & backlog report (owner 2026-11-24): the month's orders by
   Processing Date, this month's and the backlog's, and the backlog cover rates
   with their average. accounting-so-backlog-cover.ts; acc/so-backlog-cover.ts. */
accounting.get('/so-backlog-cover', soBacklogCoverHandler);
/* The Forecast P&L (owner 2026-09-21): a planning grid beside the statements; nothing posts. */
accounting.get('/forecast', forecastGetHandler);
accounting.put('/forecast', forecastPutHandler);
accounting.get('/forecast/figures', forecastFiguresHandler);
/* The Financial Dashboard (owner 2026-09-21): the statements per period, beside the forecast. */
accounting.get('/dashboard', dashboardHandler);
accounting.get('/dashboard/forecast-month', dashboardForecastMonthHandler);
/* Finance's To do (the owner's Claude Design redesign, 2026-11-02): the jobs
   the books raise, and their count for the sidebar badge (routes/accounting-todo.ts). */
accounting.get('/todo', financeTodoHandler);
accounting.get('/todo/count', financeTodoCountHandler);
accounting.get('/todo/people', todoPeopleHandler);
accounting.get('/todo/settings', todoSettingsGetHandler);
accounting.put('/todo/settings', todoSettingsPutHandler);
accounting.post('/todo/groups', todoGroupAddHandler);
accounting.post('/todo/rules', todoRuleAddHandler);
accounting.get('/todo/link-search', todoLinkSearchHandler);
accounting.get('/todo/calendar', todoCalendarHandler);
accounting.get('/receipts/rebank', rebankListHandler);
accounting.post('/receipts/rebank', rebankMoveHandler);
accounting.post('/todo/tasks', todoTaskCreateHandler);
accounting.get('/todo/tasks/:id', todoTaskGetHandler);
accounting.patch('/todo/tasks/:id', todoTaskPatchHandler);
accounting.delete('/todo/tasks/:id', todoTaskDeleteHandler);
accounting.post('/todo/tasks/:id/done', todoTaskDoneHandler);
accounting.post('/todo/tasks/:id/reopen', todoTaskReopenHandler);
accounting.post('/todo/tasks/:id/move', todoTaskMoveHandler);
accounting.post('/todo/tasks/:id/remarks', todoRemarkAddHandler);
accounting.patch('/todo/remarks/:id', todoRemarkEditHandler);
/* The books' opening (owner 2026-10-28; Finance › Setup › Opening Balance): routes/accounting-opening.ts. */
accounting.get('/opening', openingGet);
accounting.put('/opening/accounts', openingAccountsPut);
accounting.put('/opening/stock', openingStockPut);
accounting.post('/opening/papers', openingPaperCreate);
accounting.patch('/opening/papers/:kind/:id', openingPaperUpdate);
accounting.post('/opening/papers/:kind/:id/cancel', openingPaperCancel);
accounting.post('/opening/lock', openingLock);
accounting.post('/opening/unlock', openingUnlock);
accounting.post('/reports/performance/settings', savePerformanceSettingsHandler);
accounting.get('/numbering', numberingGet);
accounting.put('/numbering', numberingPut);
accounting.get('/receipts', receiptsList);
accounting.post('/receipts/ensure', receiptEnsure);
accounting.get('/receipts/backfill', receiptsBackfillPlan);
accounting.get('/receipts/check', receiptsCheck);
accounting.post('/receipts/backfill', receiptsBackfillRun);
accounting.post('/receipts/:id/formalise', receiptFormalise);
accounting.get('/receipts/:id', receiptDetail);
accounting.post('/item-groups', itemGroupCreate);
accounting.put('/item-groups/:code/accounts', itemGroupBind);
accounting.patch('/item-groups/:code', itemGroupPatch);
accounting.get('/chart', chartUnionHandler);
accounting.put('/chart/tick', chartTickHandler);
accounting.post('/chart/import', chartImportHandler);
accounting.put('/chart/rename', chartRenameHandler);
accounting.put('/chart/update', chartUpdateHandler);
accounting.post('/chart/account', chartCreateHandler);
accounting.delete('/chart/account', chartDeleteHandler);
accounting.get('/bank/config', bankConfigList);
accounting.post('/bank/config', bankConfigSave);
accounting.get('/bank/rules', bankRulesList);
accounting.post('/bank/rules', bankRuleCreate);
accounting.patch('/bank/rules/:id', bankRuleUpdate);
accounting.post('/bank/statements', bankUpload);
accounting.get('/bank/statements', bankStatements);
accounting.get('/bank/statements/:id', bankStatementDetail);
/* An old file re-filed as its month's statement (docs/bugs/0806). */
accounting.post('/bank/statements/:id/period', bankStatementPeriod);
/* The obvious matches, run over a statement uploaded before the rule (docs/bugs/0814). */
accounting.post('/bank/statements/:id/auto-match', bankStatementAutoMatch);
/* What an earlier file of the account already recorded, left out (owner 2026-10-14). */
accounting.post('/bank/statements/:id/repeats', bankStatementRepeats);
accounting.get('/bank/months', bankMonths);
accounting.get('/bank/months/:accountCode/:month', bankMonthDetail);
/* Closing a reconciled month, and reopening one (owner: 还有lock 起来不可以随便
   碰). The unlock asks a SECOND permission key inside its handler — reopening
   undoes a document somebody filed. */
accounting.get('/bank/locks', bankLocks);
/* The Finance report of payment corrections made on the amend right
   (docs/bugs/0785) — a filtered read of the SO audit log. */
accounting.get('/payment-corrections', paymentCorrections);
accounting.post('/bank/months/:accountCode/:month/lock', bankMonthLock);
accounting.post('/bank/months/:accountCode/:month/unlock', bankMonthUnlock);
/* The month-end figure typed off the bank's own statement, for an account
   whose files print no balance (docs/bugs/0858). */
accounting.post('/bank/months/:accountCode/:month/closing', bankMonthClosing);
accounting.post('/bank/lines/:id/receipt', bankLineReceipt);
accounting.post('/bank/lines/:id/match', bankLineMatch);
accounting.post('/bank/lines/:id/ignore', bankLineIgnore);
accounting.post('/bank/lines/:id/undo', bankLineUndo);
/* Several movements are one entry, or one movement is several (docs/bugs/0803). */
accounting.post('/bank/lines/match-group', bankLinesMatchGroup);
/* One credit takes entries AND card payments no report carries; the difference
   goes to the charges account (owner 2026-11-17, acc/bank-card-settle). */
accounting.get('/bank/card-payments', bankCardPayments);
accounting.post('/bank/lines/:id/match-with-cards', bankLineMatchWithCards);


type JeLineIn = {
  accountCode: string;
  debitSen?: number;
  creditSen?: number;
  partyType?: string | null;
  partyCode?: string | null;
  partyName?: string | null;
  notes?: string | null;
};


accounting.get('/accounts', async (c) => {
  const sb = c.get('supabase');
  let q = sb
    .from('accounts')
    .select('account_code, account_name, account_type, parent_code, is_active, acc_money, special_type, section');
  q = scopeToCompany(q, c);
  const { data, error } = await q.order('account_code');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ accounts: data ?? [], sections: ACCOUNT_SECTIONS });
});

/* ── Account roles — which account plays which part ─────────────────────────
   resolveRoles is what the posting rules read; this pair is the OWNER'S window
   onto it. GET answers "which bank is my default, which account is AP" per
   company; PUT repoints ONE role. Only the two default banks are repointable
   from here (the owner: 默认银行我可以自己maintenance) — BANK_DEFAULT, money
   received INTO, and BANK_PAY_DEFAULT, the voucher's Paid From (2026-11-04:
   收款和付款的 default bank 要分开, 也要分公司). The control roles (AR / AP)
   stay code-seeded until there is a reason to move them. */
export const accountRolesGet = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const roles = await resolveRoles(sb, co.companyId);
  const { data: overrides, error } = await sb.from('acc_account_roles')
    .select('role, account_code').eq('company_id', co.companyId);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const overridden = Object.fromEntries(((overrides ?? []) as Array<{ role: string; account_code: string }>).map((r) => [r.role, r.account_code]));
  return c.json({ roles, overridden });
};
accounting.get('/roles', accountRolesGet);

const putDefaultBank = (role: 'BANK_DEFAULT' | 'BANK_PAY_DEFAULT') => async (c: any): Promise<Response> => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to manage account roles." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const code = String(body.accountCode ?? '').trim();
  if (!code) return c.json({ error: 'account_required' }, 400);

  const { data: acct, error: aErr } = await scopeToCompanyId(
    sb.from('accounts').select('account_code, account_name, acc_money, is_active').eq('account_code', code),
    co.companyId,
  ).maybeSingle();
  if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
  if (!acct) return c.json({ error: 'no_such_account', message: `${code} is not in this company's chart.` }, 404);
  const a = acct as { account_name: string; acc_money: boolean | null; is_active: boolean };
  if (!a.is_active) return c.json({ error: 'account_inactive', message: `${code} ${a.account_name} is inactive.` }, 409);
  if (a.acc_money !== true) {
    return c.json({ error: 'not_a_money_account', message: `${code} ${a.account_name} is not a bank / cash account. The default bank must be one of the money accounts Daily Bank shows.` }, 409);
  }

  const { error: upErr } = await sb.from('acc_account_roles')
    .upsert({ company_id: co.companyId, role, account_code: code }, { onConflict: 'company_id,role' });
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true, role, accountCode: code });
};
export const accountRolesPutBankDefault = putDefaultBank('BANK_DEFAULT');
export const accountRolesPutBankPayDefault = putDefaultBank('BANK_PAY_DEFAULT');
accounting.put('/roles/BANK_DEFAULT', accountRolesPutBankDefault);
accounting.put('/roles/BANK_PAY_DEFAULT', accountRolesPutBankPayDefault);


export const journalEntriesList = async (c: any): Promise<Response> => {
  const sb = c.get('supabase');
  const sourceType = c.req.query('sourceType');
  const sourceDocNo = c.req.query('sourceDocNo');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const posted = c.req.query('posted');

  let q = sb.from('journal_entries')
    .select('id, je_no, entry_date, source_type, source_doc_no, narration, total_debit_sen, total_credit_sen, posted, posted_at, reversed, created_at')
    .order('entry_date', { ascending: false })
    .order('je_no', { ascending: false });

  if (sourceType)  q = q.eq('source_type', sourceType);
  if (sourceDocNo) q = q.eq('source_doc_no', sourceDocNo);
  if (from)        q = q.gte('entry_date', from);
  if (to)          q = q.lte('entry_date', to);
  if (posted === 'true')  q = q.eq('posted', true);
  if (posted === 'false') q = q.eq('posted', false);
  q = scopeToCompany(q, c);

  const { data, error } = await q.limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const jeIds = rows.map((r) => r.id);
  /* ?withLines=1 — the Journal page grouped per entry (docs/bugs/0935): the
     same one lines read, carrying the whole line, and the entry's references
     (Ref. 1 / Ref. 2 / who — acc/journal-refs, the GL page's own) so the page
     prints an entry the way the ledger prints its lines. */
  const withLines = ['1', 'true'].includes(String(c.req.query('withLines') ?? ''));
  type LineOut = { line_no: number; account_code: string; debit_sen: number; credit_sen: number; party_name: string | null; notes: string | null };
  const codesByJe = new Map<unknown, string[]>();
  const linesByJe = new Map<unknown, LineOut[]>();
  if (jeIds.length > 0) {
    const { data: lineRows, error: lnErr } = await sb
      .from('journal_entry_lines')
      .select(withLines ? 'journal_entry_id, line_no, account_code, debit_sen, credit_sen, party_name, notes' : 'journal_entry_id, account_code')
      .in('journal_entry_id', jeIds);
    if (lnErr) return c.json({ error: 'load_failed', reason: lnErr.message }, 500);
    for (const l of (lineRows ?? []) as Array<{ journal_entry_id: unknown; account_code: string } & Partial<LineOut>>) {
      const list = codesByJe.get(l.journal_entry_id) ?? [];
      list.push(l.account_code);
      codesByJe.set(l.journal_entry_id, list);
      if (withLines) {
        const full = linesByJe.get(l.journal_entry_id) ?? [];
        full.push({ line_no: Number(l.line_no ?? 0), account_code: l.account_code, debit_sen: Number(l.debit_sen ?? 0), credit_sen: Number(l.credit_sen ?? 0), party_name: l.party_name ?? null, notes: l.notes ?? null });
        linesByJe.set(l.journal_entry_id, full);
      }
    }
  }
  const companyId = activeCompanyId(c) ?? null;
  const roles = await resolveRoles(sb, companyId);
  const classed = rows.map((r): Record<string, unknown> => ({
    ...r,
    journal_class: classifyJournal(String(r.source_type ?? ''), codesByJe.get(r.id) ?? [], roles.CASH),
  }));
  const journal = String(c.req.query('journal') ?? '').trim().toUpperCase();
  const page = journal ? classed.filter((r) => r.journal_class === journal) : classed;
  if (!withLines || companyId == null) return c.json({ journalEntries: page });

  const refs = await resolveJournalRefs(sb, companyId, page.map((r) => {
    const ls = (linesByJe.get(r.id) ?? []).sort((a, b) => a.line_no - b.line_no);
    return { jeNo: String(r.je_no), sourceType: r.source_type == null ? null : String(r.source_type), sourceDocNo: r.source_doc_no == null ? null : String(r.source_doc_no), partyName: ls.map((l) => l.party_name).find((p) => p != null && p !== '') ?? null, notes: r.narration == null ? null : String(r.narration) };
  }));
  if (!refs.ok) return c.json({ error: 'load_failed', reason: refs.reason }, 500);
  return c.json({
    journalEntries: page.map((r) => {
      const ref = refs.refs.get(String(r.je_no));
      return { ...r, lines: (linesByJe.get(r.id) ?? []).sort((a, b) => a.line_no - b.line_no), doc: ref?.doc ?? r.source_doc_no ?? null, doc2: ref?.doc2 ?? null, who: ref?.who ?? null, reference: ref?.reference ?? null };
    }),
  });
};
accounting.get('/journal-entries', journalEntriesList);

accounting.get('/journal-entries/:id', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { data: je, error: e1 } = await scopeToCompany(
    sb
      .from('journal_entries')
      .select('*')
      .eq('id', id),
    c,
  )
    .single();
  if (e1) return c.json({ error: 'not_found', reason: e1.message }, 404);
  const { data: lines, error: e2 } = await sb
    .from('journal_entry_lines')
    .select('*')
    .eq('journal_entry_id', id)
    .order('line_no');
  if (e2) return c.json({ error: 'load_failed', reason: e2.message }, 500);
  const row = je as { company_id?: number | null; source_type?: string | null; source_doc_no?: string | null };
  const docCompany = activeCompanyId(c) ?? row.company_id ?? null;
  const doc = docCompany == null
    ? { ok: true as const, document: null }
    : await resolveJournalDocument(sb, Number(docCompany), row.source_type ?? null, row.source_doc_no ?? null);
  return c.json({
    journalEntry: je,
    lines: lines ?? [],
    document: doc.ok ? doc.document : null,
    ...(doc.ok ? {} : { documentError: doc.reason }),
  });
});

accounting.post('/journal-entries', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to write to the general ledger." }, 403);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const entryDate = dateOrNull(body.entryDate) ?? todayMyt();
  const sourceType = 'MANUAL';
  const sourceDocNo = body.sourceDocNo ?? null;
  /* A hand-written journal's words in upper case (owner 2026-11-09; acc/typed-text.ts). */
  const narration = upperTyped(typeof body.narration === 'string' ? body.narration : null);
  const lines = Array.isArray(body.lines) ? (body.lines as JeLineIn[]) : [];
  if (lines.length < 2) return c.json({ error: 'min_2_lines' }, 400);

  let dr = 0, cr = 0;
  for (const l of lines) {
    dr += Number(l.debitSen ?? 0);
    cr += Number(l.creditSen ?? 0);
  }
  if (dr !== cr) return c.json({ error: 'unbalanced', debit: dr, credit: cr }, 400);
  if (dr === 0) return c.json({ error: 'zero_amount' }, 400);

  const sb = c.get('supabase');
  const jeCompanyId = activeCompanyId(c);

  const r = await postJournal(sb, {
    companyId: jeCompanyId ?? null,
    entryDate,
    sourceType,
    sourceDocNo,
    narration,
    lines: lines.map((l) => ({
      accountCode: l.accountCode,
      debitSen: Number(l.debitSen ?? 0),
      creditSen: Number(l.creditSen ?? 0),
      partyType: l.partyType ?? null,
      partyCode: l.partyCode ?? null,
      partyName: l.partyName ?? null,
      notes: upperTyped(typeof l.notes === 'string' ? l.notes : null),
    })),
    postNow: false,
  });
  if (!r.ok) {
    if (r.status === 'account_invalid' || r.status === 'bad_line') return c.json({ error: r.status, reason: r.reason }, 400);
    if (r.status === 'lines_insert_failed') return c.json({ error: 'lines_insert_failed', reason: r.reason }, 500);
    return c.json({ error: 'insert_failed', reason: r.reason }, 500);
  }
  const { data: je, error: jeReadErr } = await sb.from('journal_entries').select('*').eq('id', r.jeId).maybeSingle();
  if (jeReadErr) return c.json({ journalEntry: { id: r.jeId, je_no: r.jeNo }, lineCount: lines.length }, 201);
  return c.json({ journalEntry: je ?? { id: r.jeId, je_no: r.jeNo }, lineCount: lines.length }, 201);
});

export const postJournalEntryHandler = async (c: any) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  const id = c.req.param('id');
  const sb = c.get('supabase');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: je, error: loadErr } = await scopeToCompanyId(
    sb.from('journal_entries').select('id, je_no, posted, reversed').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!je) return c.json(NOT_THIS_COMPANY, 404);

  if ((je as { posted?: boolean }).posted === true) {
    return c.json({ error: 'already_posted', message: 'This journal entry is already posted.' }, 409);
  }
  if ((je as { reversed?: boolean }).reversed === true) {
    return c.json({
      error: 'je_reversed',
      message: 'This journal entry was reversed and cannot be posted. Create a new one.',
    }, 409);
  }

  const { data, error } = await scopeToCompanyId(
    sb.from('journal_entries').update({ posted: true }).eq('id', id),
    co.companyId,
  ).select('*').maybeSingle();
  if (error) {
    if (String(error.message).includes('not balanced')) {
      return c.json({ error: 'unbalanced', reason: error.message }, 400);
    }
    return c.json({ error: 'post_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ journalEntry: data });
};

accounting.post('/journal-entries/:id/post', postJournalEntryHandler);
/* A manual journal edited in one step — validate, draft, reverse the old on its
   own day, post the new (owner 2026-09-15: 我无法 edit). Lives next door. */
accounting.put('/journal-entries/:id', journalEntryEdit);


accounting.post('/post/si/:invoiceNumber', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  const invoiceNumber = c.req.param('invoiceNumber');
  const sb = c.get('supabase');

  /* LEAK GUARD (DRAFT, two-state — 2026-06-25 anchoring diff vs 2990) — a DRAFT SI
     has not committed any revenue; the manual re-post endpoint must refuse it, or an
     operator could post a draft's revenue out-of-band (the SI route's confirm
     transition is the ONLY path that should post a draft). postSiRevenue itself does
     not check status, so the guard lives here at the caller.

     Company scope (owner audit 2026-07-22): the SELECT was pinned only by
     invoice_number, safe TODAY because doc-number prefixes ('2990-SI-…') are
     globally unique. Tightening now so a future prefix rule change or a
     collision cannot post revenue against the wrong company's books. */
  {
    const { data: si } = await scopeToCompany(
      sb.from('sales_invoices').select('status').eq('invoice_number', invoiceNumber),
      c,
    ).maybeSingle();
    if (!si) return c.json({ error: 'invoice_not_found' }, 404);
    if ((si as { status?: string }).status === 'DRAFT') {
      return c.json({ error: 'not_postable', message: 'SI is a draft — confirm it (DRAFT → Issued) before posting revenue.' }, 409);
    }
  }

  const r = await postSiRevenue(sb, invoiceNumber);

  if (r.ok) {
    if (r.status === 'migrated_source') {
      return c.json({ ok: true, status: 'migrated_source', posted: false, message: MIGRATED_NO_GL_MESSAGE });
    }
    if (r.status === 'already_posted') {
      return c.json({ error: 'already_posted', existingJe: { id: r.jeId, je_no: r.jeNo } }, 409);
    }
    return c.json({ ok: true, jeNo: r.jeNo, jeId: r.jeId, totalSen: r.totalSen });
  }
  if (r.status === 'invoice_not_found') return c.json({ error: 'invoice_not_found' }, 404);
  if (r.status === 'zero_total')        return c.json({ error: 'zero_total' }, 400);
  return c.json({ error: r.status, reason: r.reason }, 500);
});

export type PostPiResult =
  | { ok: true; status: 'posted'; jeNo: string; jeId: string; totalSen: number }
  | { ok: true; status: 'already_posted'; jeNo: string; jeId: string }
  | { ok: true; status: 'migrated_source' }
  | { ok: false; status: 'invoice_not_found' | 'zero_total' | 'je_insert_failed' | 'lines_insert_failed' | 'post_failed'
      | 'group_unbound' | 'no_lines' | 'line_ungrouped'; reason?: string };

export async function postPiAccounting(sb: any, invoiceNumber: string): Promise<PostPiResult> {
  const { data: piRaw, error } = await sb
    .from('purchase_invoices')
    .select('id, invoice_number, invoice_date, supplier_id, total_sen, currency, exchange_rate, company_id, migrated_no_stock, suppliers(code, name)')
    .eq('invoice_number', invoiceNumber)
    .single();
  if (error || !piRaw) return { ok: false, status: 'invoice_not_found' };

  if ((piRaw as unknown as { migrated_no_stock?: boolean | null }).migrated_no_stock === true) {
    return { ok: true, status: 'migrated_source' };
  }
  const pi = piRaw as unknown as {
    id: string;
    invoice_number: string;
    invoice_date: string;
    supplier_id: string | null;
    total_sen: number;
    currency: string | null;
    exchange_rate: string | number | null;
    company_id: number | null;
    suppliers: { code: string | null; name: string | null } | null;
  };

  const foreignTotalSen = Number(pi.total_sen);
  if (foreignTotalSen <= 0) return { ok: false, status: 'zero_total' };
  const totalSen = toMyrSen(foreignTotalSen, pi.exchange_rate);

  const supplier = pi.suppliers ?? { code: null, name: null };
  const companyId = pi.company_id ?? null;

  /* WHICH PURCHASE ACCOUNT each ringgit belongs to (GL redesign item 2,
     owner 2026-09-05): the invoice's lines carry their product group, the
     registry carries the group's account, and the entry debits one line per
     group. An invoice whose group is not bound REFUSES by name — the owner's
     own rule (挡下来提醒我去绑). The split itself — case-fold, the two
     refusals, FX once per group, the remainder on the largest group — is
     acc/item-group-split, the one home the sales side (docs/bugs/0829)
     shares. */
  const { data: itemsRaw, error: itemsErr } = await sb
    .from('purchase_invoice_items')
    .select('item_group, line_total_sen')
    .eq('purchase_invoice_id', pi.id);
  if (itemsErr) return { ok: false, status: 'post_failed', reason: `PI lines: ${itemsErr.message}` };
  const split = await splitByItemGroup(sb, {
    companyId,
    docNo: pi.invoice_number,
    items: (itemsRaw ?? []) as Array<{ item_group: string | null; line_total_sen: number | null }>,
    account: 'purchase_account',
    myrSen: (sen) => toMyrSen(sen, pi.exchange_rate),
    totalSen,
  });
  if (!split.ok) return { ok: false, status: split.status, reason: split.reason };
  const groupDebits = split.groups;

  const roles = await resolveRoles(sb, companyId);
  const r = await postJournal(sb, {
    companyId,
    entryDate: pi.invoice_date,
    sourceType: 'PI',
    sourceDocNo: pi.invoice_number,
    narration: `Purchase invoice ${pi.invoice_number} — ${supplier.name ?? ''}`,
    lines: piLines(roles, pi, supplier, groupDebits),
  });
  if (r.ok) {
    if (r.status === 'already_posted') return { ok: true, status: 'already_posted', jeNo: r.jeNo, jeId: r.jeId };
    return { ok: true, status: 'posted', jeNo: r.jeNo, jeId: r.jeId, totalSen };
  }
  if (r.status === 'idempotency_read_failed') {
    /* eslint-disable-next-line no-console */
    console.error('[pi-accounting] idempotency read failed — PI NOT posted:', invoiceNumber, r.reason);
    return { ok: false, status: 'post_failed', reason: r.reason };
  }
  if (r.status === 'je_insert_failed' || r.status === 'lines_insert_failed' || r.status === 'post_failed') {
    return { ok: false, status: r.status, reason: r.reason };
  }
  return { ok: false, status: 'post_failed', reason: `${r.status}: ${r.reason ?? ''}` };
}

accounting.post('/post/pi/:invoiceNumber', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  const invoiceNumber = c.req.param('invoiceNumber');
  const sb = c.get('supabase');

  /* LEAK GUARD (DRAFT, PI two-state — 2026-06-25 anchoring diff vs 2990) — a DRAFT
     PI has committed no AP/GL; the manual re-post endpoint must refuse it, or an
     operator could post a draft's payables out-of-band (the PI route's confirm
     transition is the ONLY path that should post a draft). postPiAccounting does not
     check status, so the guard lives here at the caller — mirrors the /post/si DRAFT
     guard.

     Company scope (owner audit 2026-07-22): same treatment as /post/si — pin
     the invoice_number lookup to the active company so a future prefix
     collision or a HOUZS_OWNS_2990 flip can't post AP against the wrong
     company's books. */
  {
    const { data: pi } = await scopeToCompany(
      sb.from('purchase_invoices').select('status').eq('invoice_number', invoiceNumber),
      c,
    ).maybeSingle();
    if (!pi) return c.json({ error: 'invoice_not_found' }, 404);
    if ((pi as { status?: string }).status === 'DRAFT') {
      return c.json({ error: 'not_postable', message: 'PI is a draft — confirm it (DRAFT → Posted) before posting payables.' }, 409);
    }
  }

  const r = await postPiAccounting(sb, invoiceNumber);
  if (r.ok && r.status === 'migrated_source') {
    return c.json({ ok: true, status: 'migrated_source', posted: false, message: MIGRATED_NO_GL_MESSAGE });
  }
  if (r.ok && r.status === 'already_posted') {
    return c.json({ error: 'already_posted', existingJe: { id: r.jeId, je_no: r.jeNo } }, 409);
  }
  if (r.ok) return c.json({ ok: true, jeNo: r.jeNo, jeId: r.jeId, totalSen: r.totalSen });
  if (r.status === 'invoice_not_found') return c.json({ error: 'invoice_not_found' }, 404);
  if (r.status === 'zero_total') return c.json({ error: 'zero_total' }, 400);
  if (r.status === 'group_unbound' || r.status === 'no_lines' || r.status === 'line_ungrouped') {
    return c.json({ error: r.status, message: r.reason }, 400);
  }
  return c.json({ error: r.status, reason: r.reason }, 500);
});

/* ════════════════════════════════════════════════════════════════════════
   PI accounting reversal (bug #5) — mirror of reverseSiRevenue
   ────────────────────────────────────────────────────────────────────────
   PI posting writes Dr <group purchase accounts> / Cr AP (Dr INVENTORY in
   entries posted before 2026-09-05). On PI cancel we
   must trace that back ("取消 PI 要追溯回去") with a contra JE that nets the
   original to zero + flags the original `reversed = true`, so payables +
   inventory value stop being overstated. The balance views only count
   `posted = TRUE AND reversed = FALSE` (migration 0052), so the reversing entry
   exactly cancels the original — net GL impact zero.

   IDEMPOTENT: keyed on the original JE's `reversed` flag AND on the existence of
   a reversing JE (source_type='PI_REVERSAL', source_doc_no=invoice_number).
   Re-cancelling / retries / a second cancel PATCH all no-op. Best-effort
   (audit-DLQ pattern): the caller logs but never un-cancels the PI on failure. */
export async function reversePiAccounting(
  sb: any,
  invoiceNumber: string,
  opts: {
    /** The contra's entry_date. A CANCEL leaves it out — a void happens when
        it happens (today, MYT). A RESHAPE (the periodic backfill re-posting
        an old-shape entry) passes the original's own date, so the month the
        invoice lives in cancels within itself: the owner's 照理应该根据 PI 的
        日期 (2026-09-06, bug 0647 — 19 contras had landed in September and
        left July/August's stock and AP over-stated until then). */
    entryDate?: string;
  } = {},
): Promise<{ ok: boolean; status: string; jeNo?: string; jeId?: string; reason?: string }> {
  return reverseJournal(sb, {
    sourceType: 'PI',
    sourceDocNo: invoiceNumber,
    narration: (orig) => `Reversal of ${orig.je_no} — Purchase invoice ${invoiceNumber} cancelled`,
    entryDate: opts.entryDate ?? todayMyt(),
    fallbackLines: (totalSen) => [
      { accountCode: DEFAULT_ROLE_CODES.AP, debitSen: totalSen, creditSen: 0, notes: `Reverse AP ${invoiceNumber}` },
      { accountCode: DEFAULT_ROLE_CODES.INVENTORY, debitSen: 0, creditSen: totalSen, notes: `Reverse inventory ${invoiceNumber}` },
    ],
  });
}

export async function resyncPiAccounting(
  sb: any,
  invoiceNumber: string,
): Promise<{ ok: boolean; status: string; reason?: string }> {
  const { data: jeRows, error: jeRowsErr } = await sb
    .from('journal_entries')
    .select('id, total_debit_sen, reversed')
    .eq('source_type', 'PI')
    .eq('source_doc_no', invoiceNumber);
  if (jeRowsErr) return { ok: false, status: 'resync_read_failed', reason: `jeRows: ${jeRowsErr.message}` };
  const active = ((jeRows ?? []) as Array<{ id: string; total_debit_sen: number; reversed: boolean | null }>)
    .find((r) => !r.reversed);
  if (!active) return { ok: true, status: 'not_posted' };

  const { data: pi, error: piErr } = await sb
    .from('purchase_invoices')
    .select('total_sen, exchange_rate')
    .eq('invoice_number', invoiceNumber)
    .maybeSingle();
  if (piErr) return { ok: false, status: 'resync_read_failed', reason: `pi: ${piErr.message}` };
  const piRow = pi as { total_sen?: number; exchange_rate?: string | number | null } | null;
  const newTotal = toMyrSen(Number(piRow?.total_sen ?? 0), safeRate(piRow?.exchange_rate));
  if (Number(active.total_debit_sen) === newTotal) return { ok: true, status: 'unchanged' };

  const rev = await reversePiAccounting(sb, invoiceNumber);
  if (!rev.ok) return { ok: false, status: rev.status, reason: rev.reason };
  if (newTotal <= 0) return { ok: true, status: 'reversed_to_zero' };
  const post = await postPiAccounting(sb, invoiceNumber);
  return post.ok ? { ok: true, status: 'resynced' } : { ok: false, status: post.status, reason: (post as { reason?: string }).reason };
}


export const glStreamHandler = async (c: any) => {
  const sb = c.get('supabase');
  const accountCode = c.req.query('accountCode');
  const from = c.req.query('from');
  const to = c.req.query('to');
  /* A reversed entry and its contra are one correction, not two movements: the
     stream leaves both out unless the reader asks to see them (docs/bugs/0923;
     the journal list still marks the original). The view exposes both flags
     (mig 0290), so the rows that come back carry them for the screen's mark. */
  const showReversed = ['1', 'true'].includes(String(c.req.query('showReversed') ?? ''));

  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb.from('v_gl_entries').select('*');
    q = scopeToCompany(q, c);
    if (accountCode) q = q.eq('account_code', accountCode);
    if (from)        q = q.gte('entry_date', from);
    if (to)          q = q.lte('entry_date', to);
    return q.order('line_id').range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = (data ?? []) as Array<{ reversed?: boolean | null; reversed_by_je?: string | null }>;
  return c.json({ glEntries: showReversed ? rows : rows.filter((r) => !isReversalPair(r)) });
};
accounting.get('/gl', glStreamHandler);
/* The General Ledger the AutoCount way — per-account blocks, balance b/f,
   running balance, the journal's references (docs/bugs/0924). Handler in
   accounting-ledger.ts. */
accounting.get('/gl/ledger', ledgerReport);

export const balancesHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const sb = c.get('supabase');
  const asOf = c.req.query('asOf') ?? '';
  if (asOf !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return c.json({ error: 'bad_request', reason: 'asOf must be a day written YYYY-MM-DD.' }, 400);
  }
  const { data, error } = await paginateAll((from, to) => scopeToCompany(sb
    .from('v_account_balances')
    .select('*'), c)
    .order('account_code')
    .range(from, to));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (asOf === '') return c.json({ balances: data ?? [] });
  const later = await paginateAll((from, to) => scopeToCompany(sb
    .from('v_gl_entries')
    .select('account_code, debit_sen, credit_sen, reversed, reversed_by_je'), c)
    .gt('entry_date', asOf)
    .order('line_id')
    .range(from, to));
  if (later.error) return c.json({ error: 'load_failed', reason: later.error.message }, 500);
  return c.json({ balances: balancesAsOf((data ?? []) as AccountBalanceRow[], (later.data ?? []) as LaterLine[]), asOf });
};
accounting.get('/balances', balancesHandler);

/* AR Aging / AP Aging — the formal debtor and creditor aging (owner 2026-10-02,
   B4: replace the old ones, keep the names): as at a date, one row per debtor
   or creditor, by the invoice's month, money not tied to a bill in 未冲, the
   rows adding up to the control accounts. accounting-aging.ts; acc/aging.ts. */
accounting.get('/ar-aging', arAgingHandler);
accounting.get('/ap-aging', apAgingHandler);


const ACCOUNT_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']);

accounting.post('/accounts', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to manage the chart of accounts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const code = String(body.accountCode ?? '').trim();
  const name = String(body.accountName ?? '').trim();
  const type = String(body.accountType ?? '').trim().toUpperCase();
  const parent = body.parentCode ? String(body.parentCode).trim() : null;
  if (!code) return c.json({ error: 'code_required' }, 400);
  if (!name) return c.json({ error: 'name_required' }, 400);
  if (!ACCOUNT_TYPES.has(type)) return c.json({ error: 'bad_type', message: 'accountType must be ASSET / LIABILITY / EQUITY / INCOME / EXPENSE' }, 400);

  const sb = c.get('supabase');
  if (parent) {
    const { data: p, error: pErr } = await sb.from('accounts').select('account_code, account_type')
      .eq('company_id', co.companyId).eq('account_code', parent).maybeSingle();
    if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
    if (!p) return c.json({ error: 'parent_not_found', message: `Parent ${parent} does not exist in this company's chart` }, 400);
    if ((p as { account_type?: string }).account_type !== type) {
      return c.json({ error: 'parent_type_mismatch', message: 'A child must carry the same type as its parent' }, 400);
    }
  }
  const { data: dup, error: dupErr } = await sb.from('accounts').select('account_code')
    .eq('company_id', co.companyId).eq('account_code', code).maybeSingle();
  if (dupErr) return c.json({ error: 'load_failed', reason: dupErr.message }, 500);
  if (dup) return c.json({ error: 'code_exists' }, 409);

  const { data: created, error } = await sb.from('accounts')
    .insert({
      company_id: co.companyId, account_code: code, account_name: name, account_type: type, parent_code: parent, is_active: true,
      section: defaultSectionFor(type, code),
    })
    .select('account_code, account_name, account_type, parent_code, is_active')
    .single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  return c.json({ account: created }, 201);
});

accounting.patch('/accounts/:code', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to manage the chart of accounts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const code = c.req.param('code');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const sb = c.get('supabase');
  const { data: existing, error: exErr } = await sb.from('accounts').select('account_code, account_name, parent_code, is_active, account_type')
    .eq('company_id', co.companyId).eq('account_code', code).maybeSingle();
  if (exErr) return c.json({ error: 'load_failed', reason: exErr.message }, 500);
  if (!existing) return c.json(NOT_THIS_COMPANY, 404);

  const patch: Record<string, unknown> = {};
  if (body.accountName != null) {
    const name = String(body.accountName).trim();
    if (!name) return c.json({ error: 'name_required' }, 400);
    patch.account_name = name;
  }
  if (body.parentCode !== undefined) {
    const parent = body.parentCode ? String(body.parentCode).trim() : null;
    if (parent === code) return c.json({ error: 'parent_self' }, 400);
    if (parent) {
      const { data: p, error: pErr } = await sb.from('accounts').select('account_code, account_type')
        .eq('company_id', co.companyId).eq('account_code', parent).maybeSingle();
      if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
      if (!p) return c.json({ error: 'parent_not_found' }, 400);
      if ((p as { account_type?: string }).account_type !== (existing as { account_type?: string }).account_type) {
        return c.json({ error: 'parent_type_mismatch' }, 400);
      }
    }
    patch.parent_code = parent;
  }
  if (body.isActive !== undefined) {
    const active = body.isActive === true;
    if (!active) {
      const { data: kids, error: kidsErr } = await sb.from('accounts').select('account_code')
        .eq('company_id', co.companyId).eq('parent_code', code).eq('is_active', true).limit(1);
      if (kidsErr) return c.json({ error: 'load_failed', reason: kidsErr.message }, 500);
      if (kids && kids.length > 0) return c.json({ error: 'has_active_children' }, 409);
      const { data: role, error: roleErr } = await sb.from('acc_account_roles').select('role')
        .eq('company_id', co.companyId).eq('account_code', code).maybeSingle();
      if (roleErr) return c.json({ error: 'load_failed', reason: roleErr.message }, 500);
      if (role) return c.json({ error: 'role_account', message: `This account is the ${(role as { role?: string }).role} role account - repoint the role first` }, 409);
    }
    patch.is_active = active;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing_to_update' }, 400);

  const { data: updated, error } = await sb.from('accounts').update(patch)
    .eq('company_id', co.companyId).eq('account_code', code)
    .select('account_code, account_name, account_type, parent_code, is_active')
    .maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  return c.json({ account: updated });
});

accounting.post('/journal-entries/:id/reverse', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = c.req.param('id');
  const sb = c.get('supabase');

  const { data: je, error: jeLoadErr } = await scopeToCompanyId(
    sb.from('journal_entries').select('id, je_no, source_type, posted, reversed').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (jeLoadErr) return c.json({ error: 'load_failed', reason: jeLoadErr.message }, 500);
  if (!je) return c.json(NOT_THIS_COMPANY, 404);
  const row = je as { je_no: string; source_type: string; posted?: boolean; reversed?: boolean };
  if (row.source_type !== 'MANUAL') {
    return c.json({ error: 'not_manual', message: 'Only manual journals reverse here - cancel the source document instead.' }, 409);
  }
  if (row.posted !== true) return c.json({ error: 'not_posted', message: 'A draft has booked nothing - post it first or leave it.' }, 409);
  if (row.reversed === true) return c.json({ error: 'already_reversed' }, 409);

  const r = await reverseJournal(sb, {
    sourceType: 'MANUAL',
    jeId: id,
    companyId: co.companyId,
    narration: (orig) => `Reversal of ${orig.je_no} - manual journal voided`,
  });
  if (!r.ok) return c.json({ error: r.status, reason: r.reason }, 500);
  return c.json({ ok: true, ...('jeNo' in r ? { jeNo: r.jeNo, jeId: r.jeId } : {}), status: r.status });
});

export const controlCheckHandler = async (c: any) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  return c.json(await runControlCheck(c.get('supabase'), co.companyId));
};

accounting.get('/control-check', controlCheckHandler);
accounting.post('/self-check/run', selfCheckRunHandler);


/* GET /acquirers — the §2.13 master: the acquirer the screen names and the
   accounts the ledger books are ONE row. Phase 2B's reconciliation reads the
   决定4 config columns and refuses to auto-confirm an acquirer left NULL. */
accounting.get('/acquirers', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data, error } = await sb.from('acc_acquirers').select('*')
    .eq('company_id', co.companyId).order('code');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ acquirers: data ?? [] });
});

accounting.post('/backfill/customer-payments', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  let body: any = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const limit = Math.max(1, Math.min(500, Number(body.limit ?? 200) || 200));
  /* dryRun (docs/bugs/0652): every candidate through the gate's checks, each
     verdict and reason reported, nothing written — the Self-check card's Why?. */
  const dryRun = body.dryRun === true;
  const sb = c.get('supabase');
  const r = await backfillSoPayments(sb, limit, { dryRun });
  if (!r.ok) return c.json({ error: 'backfill_failed', reason: r.reason }, 500);
  return c.json(r);
});

accounting.get('/daily-bank', dailyBankHandler);
/* The owner's cash book, a second Daily Bank beside the original (2026-11-23: 原版的
   daily bank还是要保留哦，我这算是新的daily bank): its board, then each money account's
   starting balance and the receipts typed by hand (accounting-daily-bank-cashbook.ts). */
accounting.get('/daily-bank/cashbook/board', cashbookBoardHandler);
accounting.get('/daily-bank/cashbook', cashbookGet);
accounting.put('/daily-bank/starts/:accountCode', cashbookStartPut);
accounting.delete('/daily-bank/starts/:accountCode', cashbookStartDelete);
accounting.post('/daily-bank/receipts', cashbookReceiptCreate);
/* The day's income as a grid, bank by method (owner 2026-11-23). */
accounting.put('/daily-bank/receipts/day', cashbookReceiptsDayPut);
accounting.patch('/daily-bank/receipts/:id', cashbookReceiptUpdate);
accounting.delete('/daily-bank/receipts/:id', cashbookReceiptDelete);
/* An approved voucher ticked as already in its bank's starting balance, and unticked (owner 2026-11-25: 要，加勾选). */
accounting.put('/daily-bank/skips/:pvId', cashbookSkipPut);
accounting.delete('/daily-bank/skips/:pvId', cashbookSkipDelete);


accounting.get('/daily-close', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const dateQ = c.req.query('date') ?? todayMyt();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateQ) ? dateQ : todayMyt();
  const sb = c.get('supabase');

  const takings = await systemTakings(sb, co.companyId, date);
  if (!takings.ok) return c.json({ error: 'load_failed', reason: takings.reason }, 500);

  const [{ data: savedRaw, error: sErr }, cashJe] = await Promise.all([
    sb.from('acc_daily_closes')
      .select('bucket, system_sen, counted_sen, diff_sen, status, notes, confirmed_by, confirmed_at')
      .eq('company_id', co.companyId).eq('close_date', date),
    sb.from('journal_entries').select('je_no').eq('company_id', co.companyId).eq('source_type', 'CASHUP')
      .eq('source_doc_no', `${co.companyId}-${date}-cash`).eq('reversed', false).limit(1),
  ]);
  if (sErr) return c.json({ error: 'load_failed', reason: sErr.message }, 500);
  if (cashJe.error) return c.json({ error: 'load_failed', reason: cashJe.error.message }, 500);
  const saved = new Map(((savedRaw ?? []) as Array<{ bucket: string; system_sen: number; counted_sen: number | null; status: string; notes: string | null }>)
    .map((r) => [r.bucket, r]));

  const bucketKeys = [...new Set(['cash', 'transfer', ...takings.buckets.keys(), ...saved.keys()])];
  const rows = bucketKeys.map((bucket) => {
    const sys = takings.buckets.get(bucket) ?? 0;
    const row = saved.get(bucket);
    const counted = row?.counted_sen ?? null;
    return {
      bucket,
      systemSen: sys,
      countedSen: counted,
      diffSen: counted == null ? null : counted - sys,
      status: row?.status ?? 'DRAFT',
      notes: row?.notes ?? null,
    };
  });
  const confirmed = ((savedRaw ?? []) as Array<{ status: string; confirmed_by: string | null; confirmed_at: string | null }>)
    .filter((r) => r.status === 'CONFIRMED' && r.confirmed_at)
    .sort((a, b) => String(b.confirmed_at).localeCompare(String(a.confirmed_at)))[0];
  return c.json({
    date, rows,
    confirmedBy: confirmed?.confirmed_by ?? null, confirmedAt: confirmed?.confirmed_at ?? null,
    cashJeNo: ((cashJe.data ?? []) as Array<{ je_no: string }>)[0]?.je_no ?? null,
  });
});

accounting.put('/daily-close', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to close the day." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const date = String(body.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'bad_date' }, 400);
  const entries = Array.isArray(body.buckets) ? body.buckets : [];
  const sb = c.get('supabase');

  const takings = await systemTakings(sb, co.companyId, date);
  if (!takings.ok) return c.json({ error: 'load_failed', reason: takings.reason }, 500);

  for (const e of entries as Array<{ bucket?: string; countedSen?: number | null; notes?: string | null }>) {
    const bucket = String(e.bucket ?? '').trim();
    if (!bucket) continue;
    const counted = e.countedSen == null ? null : Number(e.countedSen);
    if (counted != null && (!Number.isInteger(counted) || counted < 0)) {
      return c.json({ error: 'bad_amount', message: `${bucket}: counted amount must be non-negative integer sen` }, 400);
    }
    const sys = takings.buckets.get(bucket) ?? 0;
    const { data: existing, error: exErr } = await sb.from('acc_daily_closes')
      .select('id, status').eq('company_id', co.companyId).eq('close_date', date).eq('bucket', bucket).maybeSingle();
    if (exErr) return c.json({ error: 'load_failed', reason: exErr.message }, 500);
    if (existing && (existing as { status?: string }).status === 'CONFIRMED') {
      return c.json({ error: 'already_confirmed', message: `${bucket} is confirmed for ${date}` }, 409);
    }
    if (existing) {
      const { error } = await sb.from('acc_daily_closes')
        .update({ counted_sen: counted, system_sen: sys, notes: e.notes ?? null, updated_at: new Date().toISOString() })
        .eq('id', (existing as { id: number }).id);
      if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
    } else {
      const { error } = await sb.from('acc_daily_closes')
        .insert({ company_id: co.companyId, close_date: date, bucket, counted_sen: counted, system_sen: sys, notes: e.notes ?? null });
      if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
    }
  }
  return c.json({ ok: true });
});

/* POST /daily-close/confirm — freeze the day: refresh system figures, mark
   every saved bucket CONFIRMED, and post the CASH over/short THAT MOMENT
   (brief 3.5: 对账确认的那一刻就产生分录). Card/transfer differences are
   settlement timing and belong to layer 3 - recorded, never posted here. */
accounting.post('/daily-close/confirm', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to close the day." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const date = String(body.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'bad_date' }, 400);
  const sb = c.get('supabase');

  const { data: rowsRaw, error: rErr } = await sb.from('acc_daily_closes')
    .select('id, bucket, counted_sen, status')
    .eq('company_id', co.companyId).eq('close_date', date);
  if (rErr) return c.json({ error: 'load_failed', reason: rErr.message }, 500);
  const rows = (rowsRaw ?? []) as Array<{ id: number; bucket: string; counted_sen: number | null; status: string }>;
  if (rows.length === 0) return c.json({ error: 'nothing_to_confirm', message: 'Save the counted amounts first.' }, 400);
  const cashRow = rows.find((r) => r.bucket === 'cash');
  if (cashRow && cashRow.counted_sen == null) {
    return c.json({ error: 'cash_not_counted', message: 'Count the cash drawer before confirming - the whole point of the close.' }, 400);
  }

  const takings = await systemTakings(sb, co.companyId, date);
  if (!takings.ok) return c.json({ error: 'load_failed', reason: takings.reason }, 500);

  const user = c.get('houzsUser') as { name?: string } | undefined;
  let cashPosting: { status: string; jeNo?: string } | null = null;
  for (const row of rows) {
    const sys = takings.buckets.get(row.bucket) ?? 0;
    if (row.bucket === 'cash' && row.counted_sen != null) {
      const diff = row.counted_sen - sys;
      const posted = await postCashOverShort(sb, co.companyId, date, diff);
      if (!posted.ok) return c.json({ error: 'over_short_failed', reason: posted.reason ?? posted.status }, 500);
      cashPosting = { status: posted.status, ...(posted.jeNo ? { jeNo: posted.jeNo } : {}) };
    }
    const { error } = await sb.from('acc_daily_closes')
      .update({
        system_sen: sys,
        status: 'CONFIRMED',
        confirmed_by: user?.name ?? null,
        confirmed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (error) return c.json({ error: 'confirm_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true, confirmed: rows.length, cashPosting });
});
