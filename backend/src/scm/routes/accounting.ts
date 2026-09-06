// ----------------------------------------------------------------------------
// /accounting — simple double-entry accounting layer (PR #36).
//
// Endpoints:
//   GET    /accounts                  — chart of accounts
//   GET    /journal-entries           — list (filter by date range / source)
//   GET    /journal-entries/:id       — one JE w/ lines
//   POST   /journal-entries           — create draft JE (lines included)
//   POST   /journal-entries/:id/post  — mark posted (trigger checks balance)
//   POST   /post/si/:invoiceNumber    — auto-post a SI: Dr AR, Cr Revenue
//   POST   /post/pi/:invoiceNumber    — auto-post a PI: Dr Inventory, Cr AP
//   GET    /gl                        — flat GL stream (v_gl_entries)
//   GET    /balances                  — running account balances (v_account_balances)
//   GET    /ar-aging                  — v_ar_aging
//   GET    /ap-aging                  — v_ap_aging
//
// Note: this is intentionally minimal — single legal entity, single currency.
// ERPNext-style chart hierarchy + cost centres are deferred.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { postSiRevenue } from '../lib/post-si-revenue';
import { MIGRATED_NO_GL_MESSAGE } from '../lib/migrated-chain';
import { paginateAll } from '../lib/paginate-all';
import { safeRate, toMyrSen } from '../lib/fx';
import { todayMyt } from '../lib/my-time';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { postJournal, reverseJournal } from '../../acc/engine';
import { backfillSoPayments, unbookedPayments } from '../../acc/payments';
import { computeDailyBank } from '../../acc/daily-bank';
import { systemTakings, postCashOverShort } from '../../acc/daily-close';
import { resolveRoles, piLines, DEFAULT_ROLE_CODES } from '../../acc/rules';
import { classifyJournal } from '../../acc/journal-class';
import {
  settlementSetup, settlementSetupSave, settlementUpload, settlementBatches,
  settlementBatchDetail, settlementConfirmRow, settlementConfirmMatched, settlementRowUnconfirm,
  settlementIgnoreRow, settlementWatchlist, settlementExport, settlementInTransit,
  settlementBatchReceived, settlementReceiptUndo,
  settlementMaintenance, settlementMaintenanceMerchant, settlementMaintenanceBank,
} from './accounting-settlement';
import {
  bankSetup, bankUpload, bankStatements, bankStatementDetail,
  bankRulesList, bankRuleCreate, bankRuleUpdate,
  bankLineReceipt, bankLineMatch, bankLineIgnore, bankLineUndo,
} from './accounting-bank';
import { payoutUpload, payoutList } from './accounting-payouts';
import {
  chartUnionHandler, chartTickHandler, chartImportHandler,
  chartRenameHandler, chartUpdateHandler, chartDeleteHandler, chartCreateHandler,
} from './accounting-chart';
import { itemGroupsList, itemGroupCreate, itemGroupBind, itemGroupPatch } from './accounting-item-groups';
import { piPeriodicBackfill } from './accounting-pi-backfill';
import { stockCloseStatus, stockCloseRun } from './accounting-stock-close';
import { pnlReport, balanceSheetReport } from './accounting-reports';
import { numberingGet, numberingPut } from './accounting-numbering';
import { receiptsList, receiptEnsure, receiptFormalise } from './accounting-receipts';
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

/* Layer 3 — acquirer settlement reconciliation (brief §3.5). The handlers live
   in accounting-settlement.ts because it is a feature, not an endpoint; they
   are registered HERE, one path each, so every one of them appears in the
   route-capability matrix with its gate. Each handler carries its own
   permission check (the file's `guard`). */
accounting.get('/settlement/setup', settlementSetup);
accounting.patch('/settlement/setup/:code', settlementSetupSave);
// Maintenance takes the company as a parameter (owner: 我会 overall 维护) — the
// handlers re-check it against the caller's own grants.
accounting.get('/settlement/maintenance', settlementMaintenance);
accounting.patch('/settlement/maintenance/merchant', settlementMaintenanceMerchant);
accounting.patch('/settlement/maintenance/bank', settlementMaintenanceBank);
accounting.post('/settlement/batches', settlementUpload);
accounting.get('/settlement/batches', settlementBatches);
accounting.get('/settlement/batches/:id', settlementBatchDetail);
accounting.get('/settlement/batches/:id/export', settlementExport);
accounting.post('/settlement/batches/:id/confirm-matched', settlementConfirmMatched);
accounting.post('/settlement/batches/:id/received', settlementBatchReceived);
accounting.post('/settlement/receipts/:id/undo', settlementReceiptUndo);
accounting.post('/settlement/rows/:id/confirm', settlementConfirmRow);
accounting.post('/settlement/rows/:id/unconfirm', settlementRowUnconfirm);
accounting.post('/settlement/rows/:id/ignore', settlementIgnoreRow);
accounting.get('/settlement/watchlist', settlementWatchlist);
accounting.get('/settlement/in-transit', settlementInTransit);
/* The acquirer's own payment advice — Public Bank's IBG, which says which
   reports one bank credit pays (owner: 几份 excel 对一份 pdf). */
accounting.post('/settlement/payouts', payoutUpload);
accounting.get('/settlement/payouts', payoutList);

/* Layer 4 — reconciling the BANK's own statement (brief §3.5). Registered the
   same way and for the same reason: one path each, every one in the matrix.
   Owner, 2026-08-19: 我不是应该upload bank statement…然后你也自动核对吗 —
   整张月结单全部对. */
accounting.get('/bank/setup', bankSetup);
/* The chart maintenance surface (roadmap A) — union + per-company ticks +
   the accountant's import. Handlers in accounting-chart.ts. */
/* The product-group ↔ account registry (GL redesign item 1) — the rules that
   decide WHICH purchase/sales account a document line posts to. Handlers in
   accounting-item-groups.ts. */
accounting.get('/item-groups', itemGroupsList);
/* One-shot ledger repair (GL redesign item 3): every posted PI reaches the
   periodic shape — missing journals posted, Dr-330 journals reversed and
   re-posted — through the SAME functions live documents use. dryRun first. */
accounting.post('/backfill/pi-periodic', piPeriodicBackfill);
/* Month-end stock close (GL redesign item 4): the run log + live value, and
   the manual run — the nightly close itself fires from the cron. */
accounting.get('/stock-close', stockCloseStatus);
accounting.post('/stock-close/run', stockCloseRun);
/* The standard statements (GL redesign item 6) — one source (v_gl_entries),
   AutoCount arithmetic; handlers in accounting-reports.ts. */
accounting.get('/reports/pnl', pnlReport);
accounting.get('/reports/balance-sheet', balanceSheetReport);
/* Voucher numbering — the owner's own levers (GL redesign item 8a): per-bank
   letters + suffix width. Handlers in accounting-numbering.ts. */
accounting.get('/numbering', numberingGet);
accounting.put('/numbering', numberingPut);
/* Official Receipts (GL redesign item 9): list / fetch-or-heal / the manual
   money-confirmed button. Handlers in accounting-receipts.ts. */
accounting.get('/receipts', receiptsList);
accounting.post('/receipts/ensure', receiptEnsure);
accounting.post('/receipts/:id/formalise', receiptFormalise);
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
accounting.get('/bank/rules', bankRulesList);
accounting.post('/bank/rules', bankRuleCreate);
accounting.patch('/bank/rules/:id', bankRuleUpdate);
accounting.post('/bank/statements', bankUpload);
accounting.get('/bank/statements', bankStatements);
accounting.get('/bank/statements/:id', bankStatementDetail);
accounting.post('/bank/lines/:id/receipt', bankLineReceipt);
accounting.post('/bank/lines/:id/match', bankLineMatch);
accounting.post('/bank/lines/:id/ignore', bankLineIgnore);
accounting.post('/bank/lines/:id/undo', bankLineUndo);

/* ════════════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════════════ */

type JeLineIn = {
  accountCode: string;
  debitSen?: number;
  creditSen?: number;
  partyType?: string | null;
  partyCode?: string | null;
  partyName?: string | null;
  notes?: string | null;
};

/* ════════════════════════════════════════════════════════════════════════
   Chart of Accounts
   ════════════════════════════════════════════════════════════════════════ */

accounting.get('/accounts', async (c) => {
  const sb = c.get('supabase');
  // Chart of Accounts is per-company (scm.accounts.company_id NOT NULL, mig 0083)
  // — scope so one company can't see the other's account codes/names.
  let q = sb
    .from('accounts')
    /* acc_money marks the accounts that ARE money (bank / cash / e-wallet —
       the Daily Bank set). The PV "Paid From" picker offers only these; the
       flag rides along so screens don't hardcode code ranges. special_type is
       the AutoCount special column (0347) — pickers hide the SDC/SCC/SBS
       control accounts by it. */
    .select('account_code, account_name, account_type, parent_code, is_active, acc_money, special_type, section');
  q = scopeToCompany(q, c);
  const { data, error } = await q.order('account_code');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  /* `sections` = the AutoCount section vocabulary in render order, so a
     picker can group its options under the same headers the chart page
     shows (lib/account-sections.ts, the one home). */
  return c.json({ accounts: data ?? [], sections: ACCOUNT_SECTIONS });
});

/* ── Account roles — which account plays which part ─────────────────────────
   resolveRoles is what the posting rules read; this pair is the OWNER'S window
   onto it. GET answers "which bank is my default, which account is AP" per
   company; PUT repoints ONE role. Only BANK_DEFAULT is repointable from here
   for now (the owner: 默认银行我可以自己maintenance) — the control roles (AR /
   AP) stay code-seeded until there is a reason to move them. */
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

export const accountRolesPutBankDefault = async (c: any): Promise<Response> => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to manage account roles." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const code = String(body.accountCode ?? '').trim();
  if (!code) return c.json({ error: 'account_required' }, 400);

  /* The default bank must actually BE money — an expense account set here
     would silently mis-book every transfer payment and daily-bank line. */
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
    .upsert({ company_id: co.companyId, role: 'BANK_DEFAULT', account_code: code }, { onConflict: 'company_id,role' });
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true, role: 'BANK_DEFAULT', accountCode: code });
};
accounting.put('/roles/BANK_DEFAULT', accountRolesPutBankDefault);

/* ════════════════════════════════════════════════════════════════════════
   Journal Entries
   ════════════════════════════════════════════════════════════════════════ */

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
  q = scopeToCompany(q, c); // multi-company: isolate JEs to the active company

  const { data, error } = await q.limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  /* THE FIVE JOURNALS (GL redesign item 7) — each entry labelled the
     AutoCount way (SALES/PURCHASE/BANK/CASH/GENERAL), derived per request
     from its source type and, for the money-side documents, from which money
     account its lines actually touch (acc/journal-class.ts). One lines read
     for the whole page, never one per entry. */
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const jeIds = rows.map((r) => r.id);
  const codesByJe = new Map<unknown, string[]>();
  if (jeIds.length > 0) {
    const { data: lineRows, error: lnErr } = await sb
      .from('journal_entry_lines')
      .select('journal_entry_id, account_code')
      .in('journal_entry_id', jeIds);
    if (lnErr) return c.json({ error: 'load_failed', reason: lnErr.message }, 500);
    for (const l of (lineRows ?? []) as Array<{ journal_entry_id: unknown; account_code: string }>) {
      const list = codesByJe.get(l.journal_entry_id) ?? [];
      list.push(l.account_code);
      codesByJe.set(l.journal_entry_id, list);
    }
  }
  const roles = await resolveRoles(sb, activeCompanyId(c) ?? null);
  const classed = rows.map((r) => ({
    ...r,
    journal_class: classifyJournal(String(r.source_type ?? ''), codesByJe.get(r.id) ?? [], roles.CASH),
  }));
  const journal = String(c.req.query('journal') ?? '').trim().toUpperCase();
  return c.json({
    journalEntries: journal ? classed.filter((r) => r.journal_class === journal) : classed,
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
  return c.json({ journalEntry: je, lines: lines ?? [] });
});

accounting.post('/journal-entries', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to write to the general ledger." }, 403);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* `??` is NULLISH — a cleared <input type="date"> posts "", which sails past
     it into journal_entries.entry_date (`date NOT NULL`) and 500s the post.
     Blank takes the same path an absent key already takes: today. */
  const entryDate = dateOrNull(body.entryDate) ?? todayMyt();
  /* Hand-written journals are ALWAYS 'MANUAL'. The old route trusted
     body.sourceType, which let an operator mint an entry that impersonates a
     document type ('SI', 'PV', …) — colliding with the real document's
     idempotency and dodging the manual-journal control-account block. */
  const sourceType = 'MANUAL';
  const sourceDocNo = body.sourceDocNo ?? null;
  const narration = body.narration ?? null;
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

  /* Through the ONE gate (acc/engine), as a DRAFT — posting stays a separate,
     gated step. The engine additionally validates the chart, which this route
     never did: an account code the company does not have (or a parent header,
     or a deactivated account) is now a 400 instead of a line the trial balance
     can see but the chart cannot explain. */
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
      notes: l.notes ?? null,
    })),
    postNow: false,
  });
  if (!r.ok) {
    if (r.status === 'account_invalid' || r.status === 'bad_line') return c.json({ error: r.status, reason: r.reason }, 400);
    if (r.status === 'lines_insert_failed') return c.json({ error: 'lines_insert_failed', reason: r.reason }, 500);
    return c.json({ error: 'insert_failed', reason: r.reason }, 500);
  }
  const { data: je, error: jeReadErr } = await sb.from('journal_entries').select('*').eq('id', r.jeId).maybeSingle();
  // The draft IS created at this point — a failed read-back degrades the
  // response body, never the outcome.
  if (jeReadErr) return c.json({ journalEntry: { id: r.jeId, je_no: r.jeNo }, lineCount: lines.length }, 201);
  return c.json({ journalEntry: je ?? { id: r.jeId, je_no: r.jeNo }, lineCount: lines.length }, 201);
});

/* POST /journal-entries/:id/post — mark a journal entry posted.
 *
 * LEAK FIX (audit item 1). This used to post by BLIND ID: no load, no company
 * scope, no status check. `UPDATE journal_entries SET posted = true WHERE id =
 * $1` on a service-role client — RLS is bypassed, so that predicate WAS the
 * isolation boundary and it named only the id. Anyone signed into company A
 * who could produce a company B journal-entry id posted B's GL entry, and the
 * only trace was a posted JE in B's books that nobody in B did.
 *
 * Now: resolve the company (required — see requireActiveCompanyId), LOAD the
 * entry within it, check its status, and scope the UPDATE itself as well. The
 * update carries the company predicate too, rather than trusting the load —
 * they run as two statements, and the one that writes is the one that has to
 * be safe.
 *
 * Exported so the route test can drive it without the supabaseAuth bridge,
 * which cannot run in this harness. */
export const postJournalEntryHandler = async (c: any) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  const id = c.req.param('id');
  const sb = c.get('supabase');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Load within the company first. A miss means "not yours OR not there", and
  // both answer the same way — telling A that B's id exists is itself a leak.
  const { data: je, error: loadErr } = await scopeToCompanyId(
    sb.from('journal_entries').select('id, je_no, posted, reversed').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!je) return c.json(NOT_THIS_COMPANY, 404);

  // Status checks the blind update never made.
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
    // The trigger throws if unbalanced — pass through as 400
    if (String(error.message).includes('not balanced')) {
      return c.json({ error: 'unbalanced', reason: error.message }, 400);
    }
    return c.json({ error: 'post_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ journalEntry: data });
};

accounting.post('/journal-entries/:id/post', postJournalEntryHandler);

/* ════════════════════════════════════════════════════════════════════════
   Auto-post helpers — SI / PI confirm
   ════════════════════════════════════════════════════════════════════════ */

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

  // Delegates to the shared idempotent poster (post-si-revenue). Same code path
  // the SI POST handler uses on confirm, so manual + auto posting can never
  // diverge or double-post.
  const r = await postSiRevenue(sb, invoiceNumber);

  if (r.ok) {
    /* Nothing to post and nothing wrong: AutoCount already booked this sale.
       Answered explicitly so the caller is not left inferring it from a missing
       jeNo. */
    if (r.status === 'migrated_source') {
      return c.json({ ok: true, status: 'migrated_source', posted: false, message: MIGRATED_NO_GL_MESSAGE });
    }
    if (r.status === 'already_posted') {
      // Keep the historical 409 contract for the explicit re-post endpoint.
      return c.json({ error: 'already_posted', existingJe: { id: r.jeId, je_no: r.jeNo } }, 409);
    }
    return c.json({ ok: true, jeNo: r.jeNo, jeId: r.jeId, totalSen: r.totalSen });
  }
  if (r.status === 'invoice_not_found') return c.json({ error: 'invoice_not_found' }, 404);
  if (r.status === 'zero_total')        return c.json({ error: 'zero_total' }, 400);
  return c.json({ error: r.status, reason: r.reason }, 500);
});

/* ── postPiAccounting (extracted 2026-06-01) — idempotent PI → GL post ──────
   Writes Dr <each group's purchase account> / Cr AP for the PI total (the
   AutoCount periodic shape, GL redesign item 2 — Dr INVENTORY until
   2026-09-05; stock value now reaches the GL only as the month-end
   adjustment). Shared by
   the manual POST /post/pi route AND resyncPiAccounting (void+repost on a
   post-issue line edit). Mirrors postSiRevenue: keyed on an ACTIVE (non-reversed)
   PI JE, so a reversed original never blocks a fresh re-post. */
export type PostPiResult =
  | { ok: true; status: 'posted'; jeNo: string; jeId: string; totalSen: number }
  | { ok: true; status: 'already_posted'; jeNo: string; jeId: string }
  /* Deliberately not posted, and that is a SUCCESS — see the migrated guard
     below. It is `ok: true` so the confirm handler does not write its
     "AP/GL post FAILED" audit row for a thing that was never meant to post. */
  | { ok: true; status: 'migrated_source' }
  | { ok: false; status: 'invoice_not_found' | 'zero_total' | 'je_insert_failed' | 'lines_insert_failed' | 'post_failed'
      /* The periodic-shape refusals (GL redesign item 2): fixable by the
         operator, mapped to 400 at the manual endpoint. */
      | 'group_unbound' | 'no_lines' | 'line_ungrouped'; reason?: string };

export async function postPiAccounting(sb: any, invoiceNumber: string): Promise<PostPiResult> {
  const { data: piRaw, error } = await sb
    .from('purchase_invoices')
    .select('id, invoice_number, invoice_date, supplier_id, total_sen, currency, exchange_rate, company_id, migrated_no_stock, suppliers(code, name)')
    .eq('invoice_number', invoiceNumber)
    .single();
  if (error || !piRaw) return { ok: false, status: 'invoice_not_found' };

  /* MIGRATED PAPERWORK POSTS NO JOURNAL (migration 0280). This invoice mirrors
     one AutoCount already raised, and AutoCount already booked the payable
     behind it. Posting Dr INVENTORY / Cr AP here would count the same money in two
     books. The guard lives in this function rather than at its call sites so
     every caller — the confirm handler, resyncPiAccounting, any future one — is
     covered by construction. */
  if ((piRaw as unknown as { migrated_no_stock?: boolean | null }).migrated_no_stock === true) {
    return { ok: true, status: 'migrated_source' };
  }
  // Cast through `unknown` — Supabase JS without generated types returns
  // `GenericStringError` from `.select(string).single()` even when data is
  // populated. Project-wide pattern; see routes/admin.ts L97.
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

  /* Multi-currency AP (migration 0082) — the PI's total_sen is in the PI's OWN
     currency (RMB / USD / SGD / MYR). The GL must be MYR, so convert AT POST TIME:
     exchange_rate = MYR per 1 unit of `currency` (1 for MYR). The PI row is
     untouched — only the JE legs below carry the converted amount. For an MYR PI
     the rate is 1, so this is a no-op (totalSen unchanged) and existing MYR GL
     behaviour is byte-for-byte identical. The single Dr/Cr pair post the SAME
     figure, so the JE always balances. */
  const foreignTotalSen = Number(pi.total_sen);
  if (foreignTotalSen <= 0) return { ok: false, status: 'zero_total' };
  const totalSen = toMyrSen(foreignTotalSen, pi.exchange_rate); // MYR posted to the GL

  const supplier = pi.suppliers ?? { code: null, name: null };
  // Multi-company (mig 0061): the JE + its lines belong to the PI's company.
  const companyId = pi.company_id ?? null;

  /* WHICH PURCHASE ACCOUNT each ringgit belongs to (GL redesign item 2,
     owner 2026-09-05): the invoice's lines carry their product group, the
     registry carries the group's account, and the entry debits one line per
     group. An invoice whose group is not bound REFUSES by name — the owner's
     own rule (挡下来提醒我去绑) — because a payable silently landed on the
     wrong account is exactly the mis-classification this registry exists to
     end. */
  const { data: itemsRaw, error: itemsErr } = await sb
    .from('purchase_invoice_items')
    .select('item_group, line_total_sen')
    .eq('purchase_invoice_id', pi.id);
  if (itemsErr) return { ok: false, status: 'post_failed', reason: `PI lines: ${itemsErr.message}` };
  const items = (itemsRaw ?? []) as Array<{ item_group: string | null; line_total_sen: number | null }>;
  if (items.length === 0) {
    return { ok: false, status: 'no_lines', reason: `${pi.invoice_number} has no lines — a purchase cannot be classified without them.` };
  }

  /* Group sums in the PI's OWN currency; FX once per group below, so the sen
     conversion happens exactly the way the header's did. The registry stores
     upper-case codes; the sales panels write lower-case — one case-fold here,
     never two vocabularies. */
  const foreignByGroup = new Map<string, number>();
  for (const it of items) {
    const g = String(it.item_group ?? '').trim().toUpperCase();
    if (!g) {
      return { ok: false, status: 'line_ungrouped', reason: `${pi.invoice_number} has a line with no product group — fix the line, then post.` };
    }
    foreignByGroup.set(g, (foreignByGroup.get(g) ?? 0) + Number(it.line_total_sen ?? 0));
  }

  const groupCodes = [...foreignByGroup.keys()];
  const { data: bindsRaw, error: bindsErr } = await sb
    .from('acc_item_group_accounts')
    .select('group_code, purchase_account')
    .eq('company_id', companyId)
    .in('group_code', groupCodes);
  if (bindsErr) return { ok: false, status: 'post_failed', reason: `group bindings: ${bindsErr.message}` };
  const accountOf = new Map(((bindsRaw ?? []) as Array<{ group_code: string; purchase_account: string }>)
    .map((b) => [b.group_code, b.purchase_account]));
  const unbound = groupCodes.filter((g) => !accountOf.get(g));
  if (unbound.length > 0) {
    return {
      ok: false,
      status: 'group_unbound',
      reason: `${unbound.join(', ')} ${unbound.length === 1 ? 'is' : 'are'} not bound to a purchase account for this company — bind ${unbound.length === 1 ? 'it' : 'them'} on Accounting → Item Groups, then post again.`,
    };
  }

  /* MYR per group, and the header total is the LAW: per-group rounding must
     sum to exactly what the invoice posts, so the remainder (a sen or two of
     float, only ever on a foreign PI) lands on the largest group — same rule
     the settlement fee spread uses. */
  const groupDebits = groupCodes.map((g) => ({
    groupCode: g,
    accountCode: accountOf.get(g) as string,
    myrSen: toMyrSen(foreignByGroup.get(g) ?? 0, pi.exchange_rate),
  }));
  const drift = totalSen - groupDebits.reduce((s, g) => s + g.myrSen, 0);
  if (drift !== 0) {
    const biggest = groupDebits.reduce((a, b) => (b.myrSen > a.myrSen ? b : a));
    biggest.myrSen += drift;
  }

  /* Through the ONE gate (acc/engine). The engine owns the idempotency guard
     (fails closed on a read blip — a blip must never book a SECOND payable),
     the je_no mint, and the write sequence; this function owns the PI
     specifics: the fetch, the migrated guard, FX, and the rule's lines. */
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
  /* The operator can FIX these (bind the group / repair the line) — a 400
     with the sentence, not a 500 that reads as "the system broke". */
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
): Promise<{ ok: boolean; status: string; jeNo?: string; jeId?: string; reason?: string }> {
  /* Through the ONE gate (acc/engine): find the ACTIVE PI JE, write a faithful
     contra (same accounts + parties, sides swapped), post it, flag the
     original. The engine fails CLOSED on every read - a failed lookup must
     never read as "nothing to reverse" while Dr Inventory / Cr Payables stays
     live against a cancelled invoice. Fallback (line-less original) mirrors
     the historical canonical contra: Dr AP / Cr Inventory. */
  return reverseJournal(sb, {
    sourceType: 'PI',
    sourceDocNo: invoiceNumber,
    narration: (orig) => `Reversal of ${orig.je_no} — Purchase invoice ${invoiceNumber} cancelled`,
    entryDate: todayMyt(),
    fallbackLines: (totalSen) => [
      { accountCode: DEFAULT_ROLE_CODES.AP, debitSen: totalSen, creditSen: 0, notes: `Reverse AP ${invoiceNumber}` },
      { accountCode: DEFAULT_ROLE_CODES.INVENTORY, debitSen: 0, creditSen: totalSen, notes: `Reverse inventory ${invoiceNumber}` },
    ],
  });
}

/* ── resyncPiAccounting (2026-06-01) — re-align a posted PI's GL after a line edit
   Wei Siang chose "auto void the stale entry + re-post at the new amount". UNLIKE
   the SI side, a PI does NOT auto-post on create — it only has a JE once someone
   manually posts it from the accounting page. So this NEVER auto-creates a JE: it
   only fires when an ACTIVE PI JE already exists and its total no longer matches
   the invoice. Idempotent + best-effort. */
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
  // Not posted to the GL yet → nothing to keep in sync (PI posts only on demand).
  if (!active) return { ok: true, status: 'not_posted' };

  /* #690 flagged this read as folding "a blip into a changed total and churns a
     void+repost". It is worse than that: there is no repost. A blip leaves `pi`
     null, newTotal folds to 0, the live JE is reversed, and `newTotal <= 0` then
     returns 'reversed_to_zero' BEFORE postPiAccounting is reached — so a healthy
     PI silently loses its payable on a line edit and the caller is told ok.
     `error === null && pi === null` (invoice genuinely gone) keeps voiding, as
     today. */
  const { data: pi, error: piErr } = await sb
    .from('purchase_invoices')
    .select('total_sen, exchange_rate')
    .eq('invoice_number', invoiceNumber)
    .maybeSingle();
  if (piErr) return { ok: false, status: 'resync_read_failed', reason: `pi: ${piErr.message}` };
  const piRow = pi as { total_sen?: number; exchange_rate?: string | number | null } | null;
  // Migration 0082 — the posted JE is in MYR; compare against the MYR-equivalent
  // of the (foreign) PI total so a foreign PI doesn't churn a void+repost every
  // edit. MYR ⇒ rate 1, so newTotal === total_sen (unchanged behaviour).
  const newTotal = toMyrSen(Number(piRow?.total_sen ?? 0), safeRate(piRow?.exchange_rate));
  if (Number(active.total_debit_sen) === newTotal) return { ok: true, status: 'unchanged' };

  // Total changed → void the stale JE, then re-post at the new amount.
  const rev = await reversePiAccounting(sb, invoiceNumber);
  if (!rev.ok) return { ok: false, status: rev.status, reason: rev.reason };
  if (newTotal <= 0) return { ok: true, status: 'reversed_to_zero' };
  const post = await postPiAccounting(sb, invoiceNumber);
  return post.ok ? { ok: true, status: 'resynced' } : { ok: false, status: post.status, reason: (post as { reason?: string }).reason };
}

/* ════════════════════════════════════════════════════════════════════════
   GL stream + balances + aging
   ════════════════════════════════════════════════════════════════════════ */

accounting.get('/gl', async (c) => {
  const sb = c.get('supabase');
  const accountCode = c.req.query('accountCode');
  const from = c.req.query('from');
  const to = c.req.query('to');

  // PostgREST's 1000-row cap silently truncated the GL export — page through so
  // a wide account/date range exports every entry, not just the first 1000.
  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb.from('v_gl_entries').select('*');
    q = scopeToCompany(q, c); // multi-company: isolate GL lines to the active company (view exposes company_id, mig 0106)
    if (accountCode) q = q.eq('account_code', accountCode);
    if (from)        q = q.gte('entry_date', from);
    if (to)          q = q.lte('entry_date', to);
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ glEntries: data ?? [] });
});

accounting.get('/balances', async (c) => {
  const sb = c.get('supabase');
  // PostgREST's 1000-row cap silently truncated the balance list — page through
  // so every account balance is returned, not just the first 1000.
  const { data, error } = await paginateAll((from, to) => scopeToCompany(sb
    .from('v_account_balances')
    .select('*'), c) // multi-company: isolate balances to the active company (view exposes company_id, mig 0106)
    .range(from, to));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ balances: data ?? [] });
});

accounting.get('/ar-aging', async (c) => {
  const sb = c.get('supabase');
  /* LEAK GUARD (DRAFT, two-state — 2026-06-25 anchoring diff vs 2990) — v_ar_aging
     filters CANCELLED/VOID but NOT DRAFT (the view predates the SI two-state). A
     DRAFT SI has posted no AR yet, so it must never appear in the aging buckets; the
     view exposes s.status, so filter DRAFT out here at the route (migrations are
     frozen). */
  // PostgREST's 1000-row cap silently truncated the aging buckets — page through
  // so the full AR ledger is bucketed, not just the first 1000 rows. Ordering
  // stays inside the page factory so every page is consistent.
  const { data, error } = await paginateAll((from, to) => scopeToCompany(sb
    .from('v_ar_aging')
    .select('*')
    .neq('status', 'DRAFT'), c) // multi-company: isolate AR aging to the active company (view exposes company_id, mig 0106)
    .order('days_overdue', { ascending: false })
    .range(from, to));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ arAging: data ?? [] });
});

accounting.get('/ap-aging', async (c) => {
  const sb = c.get('supabase');
  /* LEAK GUARD (DRAFT, PI two-state — 2026-06-25 anchoring diff vs 2990) — v_ap_aging
     filters CANCELLED/VOID but NOT DRAFT (the view predates the PI two-state). A
     DRAFT PI has posted no AP yet, so it must never appear in the aging buckets; the
     view exposes p.status, so filter DRAFT out here at the route (migrations are
     frozen). Mirrors the /ar-aging DRAFT fix. */
  // PostgREST's 1000-row cap silently truncated the aging buckets — page through
  // so the full AP ledger is bucketed, not just the first 1000 rows. Ordering
  // stays inside the page factory so every page is consistent.
  const { data, error } = await paginateAll((from, to) => scopeToCompany(sb
    .from('v_ap_aging')
    .select('*')
    .neq('status', 'DRAFT'), c) // multi-company: isolate AP aging to the active company (view exposes company_id, mig 0106)
    .order('days_overdue', { ascending: false })
    .range(from, to));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ apAging: data ?? [] });
});

/* ════════════════════════════════════════════════════════════════════════
   Phase 1 — chart management, manual-JV reversal, control-account self-check
   ════════════════════════════════════════════════════════════════════════ */

const ACCOUNT_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']);

/* POST /accounts — add an account to the ACTIVE company's chart. */
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
      /* The per-company door names no section: the type's default shelf,
         the same rule the migration seeded with. The chart page's own door
         (accounting-chart.ts) takes the section explicitly. */
      section: defaultSectionFor(type, code),
    })
    .select('account_code, account_name, account_type, parent_code, is_active')
    .single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  return c.json({ account: created }, 201);
});

/* PATCH /accounts/:code — rename / re-parent / activate-deactivate. The CODE
   itself is immutable: history references it, and a deactivated row is the
   alias record a rename leaves behind (brief 2.9). */
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
      /* Deactivating a PARENT would orphan its children's grouping, and
         deactivating a ROLE account would stop the posting rules dead —
         refuse both, and say why. */
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

/* POST /journal-entries/:id/reverse — void a MANUAL journal with a contra.
   Document-sourced entries are NOT reversible here: cancel the document and
   its own flow writes the contra (one lifecycle per document, brief 2.8). */
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

/* GET /control-check — reconciliation layer 1 (brief 3.5): control account
   vs the documents that are supposed to explain it, named to the doc.

   For each control role (AR from SI documents, AP from PI documents) it
   reports DRIFT docs (document total != its ACTIVE journal total, including
   a confirmed doc with NO journal and a journal whose doc is gone) and
   FOREIGN lines (control-account lines from a source no rule maps there).
   Sums run over POSTED, non-reversed entries — the same predicate every
   balance view uses. */
/* Exported so a test can mount it on a bare app, the same reason
   postJournalEntryHandler above is: the router carries supabaseAuth, which
   cannot run without Worker bindings. */
export const controlCheckHandler = async (c: any) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const roles = await resolveRoles(sb, companyId);

  type Drift = { docNo: string; docTotalSen: number; jeTotalSen: number; diffSen: number; note: string };
  type Foreign = { jeNo: string; sourceType: string; debitSen: number; creditSen: number };
  type CheckOk = { role: string; accountCode: string; glBalanceSen: number; driftDocs: Drift[]; foreignLines: Foreign[]; ok: boolean };
  type CheckErr = { role: string; accountCode: string; error: string };

  const runCheck = async (role: 'AR' | 'AP' | 'AP_OTHER' | 'AR_OTHER', accountCode: string): Promise<CheckOk | CheckErr> => {
    const expectedSource = role === 'AR' ? 'SI' : 'PI';
    /* AP_OTHER (405-0000, the 2026-09-03 split) and AR_OTHER (305-0000, the
       Other Debtors module): the document↔journal drift walk below is
       per-DOCUMENT and control-agnostic — the AP arm already covers every PI
       once, and a debtor bill cannot exist without its journal (the create is
       atomic). These arms contribute what IS control-specific: the GL balance
       and any foreign line parked on the control. */
    const docDrift = role !== 'AP_OTHER' && role !== 'AR_OTHER';

    const jeByDoc = new Map<string, { jeTotal: number }>();
    if (docDrift) {
      const { data: jes, error: jesErr } = await sb.from('journal_entries')
        .select('id, je_no, source_doc_no, total_debit_sen')
        .eq('company_id', companyId).eq('source_type', expectedSource)
        .eq('posted', true).eq('reversed', false);
      if (jesErr) return { role, accountCode, error: jesErr.message };
      for (const j of (jes ?? []) as Array<{ source_doc_no: string | null; total_debit_sen: number }>) {
        if (j.source_doc_no) jeByDoc.set(j.source_doc_no, { jeTotal: Number(j.total_debit_sen ?? 0) });
      }
    }

    const drift: Drift[] = [];
    if (role === 'AR') {
      const { data: docs, error } = await sb.from('sales_invoices')
        .select('invoice_number, total_sen, status, migrated_no_stock')
        .eq('company_id', companyId);
      if (error) return { role, accountCode, error: error.message };
      for (const d of (docs ?? []) as Array<{ invoice_number: string; total_sen: number; status: string | null; migrated_no_stock: boolean | null }>) {
        const s = (d.status ?? '').toUpperCase();
        const je = jeByDoc.get(d.invoice_number);
        if (d.migrated_no_stock === true || s === 'DRAFT' || s === 'CANCELLED') {
          if (je) drift.push({ docNo: d.invoice_number, docTotalSen: 0, jeTotalSen: je.jeTotal, diffSen: je.jeTotal, note: `journal active but document is ${d.migrated_no_stock ? 'migrated' : s}` });
          jeByDoc.delete(d.invoice_number);
          continue;
        }
        const docTotal = Number(d.total_sen ?? 0);
        if (!je) {
          if (docTotal > 0) drift.push({ docNo: d.invoice_number, docTotalSen: docTotal, jeTotalSen: 0, diffSen: -docTotal, note: 'document has no active journal' });
        } else {
          if (je.jeTotal !== docTotal) drift.push({ docNo: d.invoice_number, docTotalSen: docTotal, jeTotalSen: je.jeTotal, diffSen: je.jeTotal - docTotal, note: 'journal total differs from document total' });
          jeByDoc.delete(d.invoice_number);
        }
      }
    } else if (docDrift) {
      const { data: docs, error } = await sb.from('purchase_invoices')
        .select('invoice_number, total_sen, exchange_rate, status, migrated_no_stock')
        .eq('company_id', companyId);
      if (error) return { role, accountCode, error: error.message };
      for (const d of (docs ?? []) as Array<{ invoice_number: string; total_sen: number; exchange_rate: string | number | null; status: string | null; migrated_no_stock: boolean | null }>) {
        const s = (d.status ?? '').toUpperCase();
        const je = jeByDoc.get(d.invoice_number);
        if (d.migrated_no_stock === true || s === 'DRAFT' || s === 'CANCELLED') {
          if (je) drift.push({ docNo: d.invoice_number, docTotalSen: 0, jeTotalSen: je.jeTotal, diffSen: je.jeTotal, note: `journal active but document is ${d.migrated_no_stock ? 'migrated' : s}` });
          jeByDoc.delete(d.invoice_number);
          continue;
        }
        /* A confirmed PI with no active journal IS drift, and this arm used to
           skip it — the AR arm four lines up reports the identical shape. The
           skip carried two reasons and BOTH are false: a PI does not "post on
           demand" (postPurchaseInvoiceHandler calls postPiAccounting on both of
           its arms, so a confirm that reaches this state had its post FAIL), and
           v_ap_aging is not "the place that surfaces unposted PIs" — that view
           selects from purchase_invoices alone and never joins journal_entries,
           so it has no notion of posted at all.

           Found live 2026-08-22: HC-PI-2608-002 and -003 both confirmed with no
           journal, AP CLEAN, while AR reported HC-SI-2608-002 for the same
           thing. The one check built to catch it was the one that couldn't.

           `docTotal > 0` mirrors AR: postPiAccounting refuses a zero total
           (`zero_total`), so a zero-value invoice legitimately has no journal. */
        const docTotal = toMyrSen(Number(d.total_sen ?? 0), safeRate(d.exchange_rate));
        if (!je) {
          if (docTotal > 0) drift.push({ docNo: d.invoice_number, docTotalSen: docTotal, jeTotalSen: 0, diffSen: -docTotal, note: 'document has no active journal' });
          continue;
        }
        if (je.jeTotal !== docTotal) drift.push({ docNo: d.invoice_number, docTotalSen: docTotal, jeTotalSen: je.jeTotal, diffSen: je.jeTotal - docTotal, note: 'journal total differs from document total (MYR)' });
        jeByDoc.delete(d.invoice_number);
      }
    }
    for (const [docNo, je] of jeByDoc) {
      drift.push({ docNo, docTotalSen: 0, jeTotalSen: je.jeTotal, diffSen: je.jeTotal, note: 'journal active but document not found' });
    }

    const { data: lines, error: linesErr } = await paginateAll<Record<string, unknown>>((from, to) =>
      sb.from('v_gl_entries').select('*').eq('company_id', companyId).eq('account_code', accountCode).order('line_id').range(from, to));
    if (linesErr) return { role, accountCode, error: linesErr.message };
    let bal = 0;
    const foreign: Foreign[] = [];
    /* What LEGITIMATELY moves each control account: the document that books it
       plus everything that settles it. AR moves on invoices AND on customer
       payments (SOPAY/SIPAY, phase 2A); AP moves on purchase invoices AND on
       the payment vouchers that settle them. Anything else on the account is
       the finding. */
    const family = role === 'AR'
      ? new Set(['SI', 'SI_REVERSAL', 'SOPAY', 'SOPAY_REVERSAL', 'SIPAY', 'SIPAY_REVERSAL'])
      : role === 'AR_OTHER'
        ? new Set(['ODB', 'ODB_REVERSAL', 'ODR', 'ODR_REVERSAL'])
        : new Set(['PI', 'PI_REVERSAL', 'PV', 'PV_REVERSAL']);
    for (const l of (lines ?? []) as Array<{ je_no: string; source_type: string; debit_sen: number; credit_sen: number }>) {
      bal += Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0);
      if (!family.has(l.source_type)) {
        foreign.push({ jeNo: l.je_no, sourceType: l.source_type, debitSen: Number(l.debit_sen ?? 0), creditSen: Number(l.credit_sen ?? 0) });
      }
    }

    return { role, accountCode, glBalanceSen: bal, driftDocs: drift, foreignLines: foreign, ok: drift.length === 0 && foreign.length === 0 };
  };

  const checks = [
    await runCheck('AR', roles.AR),
    await runCheck('AR_OTHER', roles.AR_OTHER),
    await runCheck('AP', roles.AP),
    await runCheck('AP_OTHER', roles.AP_OTHER),
  ];

  /* THE THIRD FINDING: money recorded on a document that never reached the
     ledger at all. A booking failure does not fail the operator's save (sales
     must be able to record money whatever accounting is doing), so until now
     the only trace was a server log. Owner, asked whether this page should say
     so: 要. `since` is the derived boundary — see acc/payments.ts — and it is
     returned so the screen can show which period it is speaking about. */
  const unbooked = await unbookedPayments(sb, companyId);

  return c.json({
    checks,
    payments: unbooked.ok
      ? { since: unbooked.since, rows: unbooked.rows, totalSen: unbooked.totalSen, ok: unbooked.rows.length === 0 }
      : { since: null, rows: [], totalSen: 0, ok: false, error: unbooked.reason },
  });
};

accounting.get('/control-check', controlCheckHandler);

/* ════════════════════════════════════════════════════════════════════════
   Phase 2A — acquirer master + customer-payment backfill
   ════════════════════════════════════════════════════════════════════════ */

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

/* POST /backfill/customer-payments — walk SO payment rows that never reached
   the ledger and post them through the gate. Batched (default 200, max 500)
   and idempotent: the engine guard + the acc_je_one_active_source index make
   re-runs converge instead of double-posting. NOT company-scoped on purpose -
   each payment resolves its own SO's company, and the historical debt spans
   both books. Call repeatedly until `remaining` is 0. */
accounting.post('/backfill/customer-payments', async (c) => {
  if (!requireGlPost(c)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  let body: any = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const limit = Math.max(1, Math.min(500, Number(body.limit ?? 200) || 200));
  const sb = c.get('supabase');
  const r = await backfillSoPayments(sb, limit);
  if (!r.ok) return c.json({ error: 'backfill_failed', reason: r.reason }, 500);
  return c.json(r);
});

/* GET /daily-bank?date=YYYY-MM-DD — the owner's board (brief 3.6): where the
   money is today and how much can actually move. Live from the ledger, no
   cache (2.3) - so it can never disagree with the trial balance. */
accounting.get('/daily-bank', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const dateQ = c.req.query('date') ?? todayMyt();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateQ) ? dateQ : todayMyt();
  const sb = c.get('supabase');

  const { data: moneyRaw, error: mErr } = await sb.from('accounts')
    .select('account_code, account_name')
    .eq('company_id', co.companyId).eq('acc_money', true).eq('is_active', true)
    .order('account_code');
  if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
  const money = (moneyRaw ?? []) as Array<{ account_code: string; account_name: string }>;

  const { data: acqRaw, error: aErr } = await sb.from('acc_acquirers')
    .select('code, transit_account_code')
    .eq('company_id', co.companyId).eq('is_active', true).order('code');
  if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
  /* One transit account may serve several acquirers until 决定4 assigns each
     its own - collapse duplicates so the board does not count a balance twice. */
  const transitByAccount = new Map<string, string>();
  for (const a of (acqRaw ?? []) as Array<{ code: string; transit_account_code: string }>) {
    const existing = transitByAccount.get(a.transit_account_code);
    transitByAccount.set(a.transit_account_code, existing ? `${existing}/${a.code}` : a.code);
  }
  const transitCodes = [...transitByAccount.keys()];
  const { data: transitNamesRaw, error: tErr } = await sb.from('accounts')
    .select('account_code, account_name')
    .eq('company_id', co.companyId).in('account_code', transitCodes.length ? transitCodes : ['—none—']);
  if (tErr) return c.json({ error: 'load_failed', reason: tErr.message }, 500);
  const nameOf = new Map(((transitNamesRaw ?? []) as Array<{ account_code: string; account_name: string }>)
    .map((r) => [r.account_code, r.account_name]));
  const transitAccounts = transitCodes.map((code) => ({
    acquirerCode: transitByAccount.get(code) ?? code,
    account_code: code,
    account_name: nameOf.get(code) ?? code,
  }));

  /* Phase 3: DRAFT vouchers sitting in the approval cycle — money already
     asked for. Submitted on or before the board date, still undecided-or-
     approved (posting clears the pending by flipping status; withdraw/reject
     clear the marks). The error is bound: a failed read must not dress up as
     "nothing pending" on the one board that answers how much can move. */
  const { data: pendingRaw, error: pErr } = await sb.from('payment_vouchers')
    .select('total_sen, exchange_rate')
    /* daily bank 的pending 就是第一层的checked (the owner, 2026-09-02): a
       voucher reserves the board's money once the FIRST yes is on it — a
       merely prepared one is still the preparer's business. */
    .eq('company_id', co.companyId).eq('status', 'DRAFT')
    .not('checked_at', 'is', null)
    .lte('checked_at', `${date}T23:59:59.999`);
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const pending = (pendingRaw ?? []) as Array<{ total_sen: number; exchange_rate: string | number | null }>;

  const allCodes = [...money.map((m) => m.account_code), ...transitCodes];
  if (allCodes.length === 0) {
    return c.json(computeDailyBank(date, [], [], [], pending));
  }
  const { data: lines, error: lErr } = await paginateAll<Record<string, unknown>>((from, to) =>
    sb.from('v_gl_entries').select('entry_date, je_no, source_type, source_doc_no, account_code, debit_sen, credit_sen, notes')
      .eq('company_id', co.companyId)
      .in('account_code', allCodes)
      .lte('entry_date', date)
      .order('line_id')
      .range(from, to));
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);

  return c.json(computeDailyBank(date, money, transitAccounts, (lines ?? []) as never, pending));
});

/* ════════════════════════════════════════════════════════════════════════
   Daily close (cashup, brief 3.5 layer 2)
   ════════════════════════════════════════════════════════════════════════ */

/* GET /daily-close?date= — system takings per bucket (live) merged with any
   saved counts. The system side is recomputed on every read: a count sheet
   must always face today's truth, not the truth at first open. */
accounting.get('/daily-close', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const dateQ = c.req.query('date') ?? todayMyt();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateQ) ? dateQ : todayMyt();
  const sb = c.get('supabase');

  const takings = await systemTakings(sb, co.companyId, date);
  if (!takings.ok) return c.json({ error: 'load_failed', reason: takings.reason }, 500);

  const { data: savedRaw, error: sErr } = await sb.from('acc_daily_closes')
    .select('bucket, system_sen, counted_sen, diff_sen, status, notes')
    .eq('company_id', co.companyId).eq('close_date', date);
  if (sErr) return c.json({ error: 'load_failed', reason: sErr.message }, 500);
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
  return c.json({ date, rows });
});

/* PUT /daily-close — save counted amounts (draft). Upsert per bucket. */
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
    /* Refuse to edit a CONFIRMED bucket - the day is closed; corrections go
       through a manual journal, on the record. */
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
