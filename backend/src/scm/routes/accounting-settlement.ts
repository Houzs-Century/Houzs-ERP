// ----------------------------------------------------------------------------
// /accounting/settlement — acquirer settlement reconciliation (brief §3.5
// layer 3). The HANDLERS live here; routes/accounting.ts registers each one on
// its own router, so they inherit supabaseAuth and the SCM area guard.
//
// Handlers rather than a sub-router on purpose: the route-capability audit
// (scripts/generate-route-capability-matrix.mjs) follows `app.route` and
// `scm.route` only, so a router mounted inside another router would take nine
// endpoints OUT of the matrix that lists every route and its gate. Feature-
// sized logic in its own file, every path visible to the audit.
//
// The screen shows FOUR piles and nothing else (已配对／需要确认／没配对上／
// 已忽略) — that skeleton is the one thing 系统3 got right and it is reused
// deliberately. What is new here:
//
//   • every acquirer difference is CONFIG (scm.acc_acquirer_config), so no
//     `if (acquirer === 'GHL')` exists anywhere in this module;
//   • an acquirer with no unique reference can never auto-confirm;
//   • the wrong file is refused by name, never parsed into a clean empty screen;
//   • confirming POSTS, immediately, through the one gate.
//
// Permission: the brief asks for a check at both ends for this feature
// (权限：前后端各检查一次), so reads are gated here as well as writes — with
// the same key the GL writes already use (owner decision 2026-08-13: reuse
// scm.payment_voucher.post rather than mint a key nobody holds).
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, allowedCompanyIds } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { parseStatement, type StatementColumnMap } from '../../acc/settlement-parse';
import { matchStatement, recordedNotArrived, type MatchBucket, type PaymentCandidate } from '../../acc/settlement-match';
import {
  loadAcquirer, loadPaymentCandidates, loadSettledKeys, confirmSettlementRow, postStatementCharge,
  postBatchReceipt, loadBatchReceipts, undoBatchReceipt,
} from '../../acc/settlement';
import { resolveRoles } from '../../acc/rules';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** The permission check the brief asks for at this end (the page checks at the
    other). One wrapper, so no handler in this file can be added without it. */
const guard = (handler: (c: Ctx) => Promise<Response>) => async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return c.json({ error: "You don't have permission to reconcile acquirer settlements." }, 403);
  }
  return handler(c);
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Content fingerprint — the same file uploaded twice is refused by the
    batch's UNIQUE (company_id, file_hash), not doubled into the ledger. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type StoredRow = {
  id: number; line_no: number; txn_date: string; ref: string | null;
  gross_sen: number; fee_sen: number; net_sen: number;
  bucket: string; match_reason: string | null; confirmed_at: string | null;
  posted_je_no: string | null; notes: string | null;
};

/* ════════════════════════════════════════════════════════════════════════
   Acquirer setup — 决定4, entered once, shared by every company
   ════════════════════════════════════════════════════════════════════════ */

/* GET /setup — the global config of every acquirer plus THIS company's links,
   and the bank accounts THIS company could receive into.

   The two `ready` flags are different questions and the screen must not merge
   them: `ready` = a statement can be READ (statement shape, taught once, shared
   by every company); `bankReady` = a payout can be BOOKED (which bank account
   the money lands in — per company, because the same merchant pays different
   companies into different banks. Owner, 2026-08-18: "例如pbb，在houzs 可能是
   maybank 收钱，但是在2990 是hong leong bank 收钱"). */
export const settlementSetup = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data, error } = await sb.from('acc_acquirers')
    .select('code, display_name, statement_format, has_unique_ref, fee_method, date_tolerance_days, column_map, total_net_label, dates_have_no_year, transit_account_code, fee_account_code, bank_account_code, is_active')
    .eq('company_id', co.companyId).order('code');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const acquirers = ((data ?? []) as Array<Record<string, any>>).map((a) => ({
    ...a,
    ready: Boolean(a.statement_format && a.fee_method && a.column_map?.date && a.column_map?.gross),
    bankReady: Boolean(a.bank_account_code),
    autoMatchable: a.has_unique_ref === true,
  }));

  /* The money accounts of THIS company, so the screen offers a choice instead
     of asking an operator to type an account code from memory. */
  const { data: bankRaw, error: bErr } = await sb.from('accounts')
    .select('account_code, account_name')
    .eq('company_id', co.companyId).eq('acc_money', true).eq('is_active', true)
    .order('account_code');
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);

  return c.json({ acquirers, bankAccounts: bankRaw ?? [] });
});

/* PATCH /setup/:code — teach the system one acquirer. The statement shape is
   written to the GLOBAL row (every company benefits); the bank/transit/fee
   accounts are written to THIS company's link. That split IS the owner's
   "define once, all companies share" principle, in one endpoint. */
export const settlementSetupSave = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const code = c.req.param('code');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');

  const global: Record<string, unknown> = {};
  if (body.statementFormat !== undefined) {
    const f = body.statementFormat == null ? null : String(body.statementFormat).toUpperCase();
    if (f !== null && !['CSV', 'XLSX', 'PDF'].includes(f)) return c.json({ error: 'bad_format' }, 400);
    global.statement_format = f;
  }
  if (body.hasUniqueRef !== undefined) global.has_unique_ref = body.hasUniqueRef == null ? null : Boolean(body.hasUniqueRef);
  if (body.feeMethod !== undefined) {
    const m = body.feeMethod == null ? null : String(body.feeMethod);
    if (m !== null && !['stated', 'gross-minus-net', 'prorated-summary'].includes(m)) return c.json({ error: 'bad_fee_method' }, 400);
    global.fee_method = m;
  }
  if (body.dateToleranceDays !== undefined) {
    const d = Number(body.dateToleranceDays);
    if (!Number.isInteger(d) || d < 0 || d > 30) return c.json({ error: 'bad_tolerance', message: 'Tolerance must be 0–30 days.' }, 400);
    global.date_tolerance_days = d;
  }
  if (body.columnMap !== undefined) global.column_map = body.columnMap ?? null;
  if (Object.keys(global).length > 0) {
    global.updated_at = new Date().toISOString();
    const { error } = await sb.from('acc_acquirer_config').update(global).eq('code', code);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }

  const link: Record<string, unknown> = {};
  if (body.bankAccountCode !== undefined) link.bank_account_code = body.bankAccountCode || null;
  if (body.transitAccountCode !== undefined) link.transit_account_code = String(body.transitAccountCode || '320-0000');
  if (body.feeAccountCode !== undefined) link.fee_account_code = String(body.feeAccountCode || '930-0000');
  if (body.isActive !== undefined) link.is_active = Boolean(body.isActive);
  if (Object.keys(link).length > 0) {
    link.updated_at = new Date().toISOString();
    const { error } = await sb.from('acc_company_acquirers').update(link)
      .eq('company_id', co.companyId).eq('acquirer_code', code);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════════════════
   Maintenance — one screen, every company (owner, 2026-08-18)
   ════════════════════════════════════════════════════════════════════════

   "我记得我说我这个自动对账要做成每个公司都能用，无论是merchant recon还是bank
   recon。具体怎样应该是我会overall 维护，然后在维护那边选这个公司是使用哪里几个
   merchant，然后他有什么bank。可能是以勾选的方式选择？"

   So these three endpoints take the company as a PARAMETER instead of reading
   the active one: he maintains both companies from one screen without switching
   the top bar. Every one of them re-checks that the target company is in the
   caller's own grants (`allowedCompanyIds`) — a company id in a request body is
   an instruction, not an authorisation.

   Nothing new is stored. Which merchants a company uses and where their money
   lands is `scm.acc_company_acquirers` (migration 0332, one row per company per
   merchant); which banks a company has is `scm.accounts.is_active` on its money
   accounts — the chart is already maintained centrally (migration 0297: one
   AutoCount-style chart for every company), which is his own answer to where
   banks are defined: "chart of account 我也是会做成总维护不是？". */

/** The target company for a maintenance call: the one asked for, but only if
    the caller is granted it. Falls back to the active company when none is
    named, and REFUSES rather than silently retargeting when one is named and
    not granted. */
function maintenanceCompany(c: Ctx, asked: unknown): { ok: true; companyId: number } | { ok: false; refusal: Record<string, string> } {
  const allowed = allowedCompanyIds(c);
  const wanted = Number(asked);
  if (!Number.isInteger(wanted) || wanted <= 0) {
    const co = requireActiveCompanyId(c);
    return co.ok ? { ok: true, companyId: co.companyId } : { ok: false, refusal: co.refusal as Record<string, string> };
  }
  if (allowed !== undefined && !allowed.includes(wanted)) {
    return { ok: false, refusal: { error: 'company_not_granted', message: 'You do not have access to that company.' } };
  }
  return { ok: true, companyId: wanted };
}

/* GET /maintenance?companyId= — everything one company's setup needs: the
   companies the caller may maintain, every merchant with whether THIS company
   uses it and where its money lands, and this company's money accounts with
   whether it banks with them. */
export const settlementMaintenance = guard(async (c) => {
  const sb = c.get('supabase');

  /* EVERY company he may maintain, in ONE answer — the screen is a matrix, not
     a company at a time (owner, 2026-08-18: 我应该 overall maintenance table，左
     手边是 merchant、bank，上面 header 是公司，这个公司有就 tick). */
  const granted = allowedCompanyIds(c);
  const all = (c.get('companies') as Array<{ id: number; code: string; name: string }> | undefined) ?? [];
  const companies = all.filter((co) => granted === undefined || granted.includes(Number(co.id)));
  if (companies.length === 0) {
    /* No companies master (pre-migration / cold start): fall back to the active
       one so the screen still works rather than rendering an empty grid. */
    const co = requireActiveCompanyId(c);
    if (!co.ok) return c.json(co.refusal, 409);
    companies.push({ id: co.companyId, code: String(co.companyId), name: `Company ${co.companyId}` });
  }
  const ids = companies.map((co) => Number(co.id));

  /* The merchants that EXIST — global, one row each, whatever any company does
     with them. A merchant no company uses is still a row: that is how a company
     starts using it. */
  const { data: cfgRaw, error: cErr } = await sb.from('acc_acquirer_config')
    .select('code, display_name, statement_format, has_unique_ref, fee_method, date_tolerance_days, column_map, is_active')
    .order('code');
  if (cErr) return c.json({ error: 'load_failed', reason: cErr.message }, 500);

  const { data: linkRaw, error: lErr } = await sb.from('acc_company_acquirers')
    .select('company_id, acquirer_code, transit_account_code, fee_account_code, bank_account_code, is_active')
    .in('company_id', ids);
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const linkOf = new Map(((linkRaw ?? []) as Array<Record<string, any>>)
    .map((l) => [`${Number(l.company_id)}:${String(l.acquirer_code)}`, l]));

  /* Every company's money accounts. The chart is unified (0297) so the codes
     mostly agree, but a code one company simply does not carry must read as
     "not in its chart", never as an unticked box it could tick. */
  const { data: bankRaw, error: bErr } = await sb.from('accounts')
    .select('company_id, account_code, account_name, is_active')
    .in('company_id', ids).eq('acc_money', true).order('account_code');
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  const bankRows = (bankRaw ?? []) as Array<Record<string, any>>;

  const merchants = ((cfgRaw ?? []) as Array<Record<string, any>>).map((g) => {
    const byCompany: Record<string, { enabled: boolean; linked: boolean; bankAccountCode: string | null }> = {};
    for (const id of ids) {
      const link = linkOf.get(`${id}:${String(g.code)}`);
      byCompany[String(id)] = {
        /* Used by this company = a link row that is switched on. No row at all
           is the honest "not set up here", not an error. */
        enabled: link ? link.is_active !== false : false,
        linked: Boolean(link),
        bankAccountCode: link?.bank_account_code ?? null,
      };
    }
    return {
      code: g.code,
      display_name: g.display_name,
      statement_format: g.statement_format,
      has_unique_ref: g.has_unique_ref,
      fee_method: g.fee_method,
      date_tolerance_days: g.date_tolerance_days,
      column_map: g.column_map,
      ready: Boolean(g.statement_format && g.fee_method && g.column_map?.date && g.column_map?.gross),
      autoMatchable: g.has_unique_ref === true,
      byCompany,
    };
  });

  /* One row per account CODE across every company — the left-hand column of the
     matrix — with what each company does with it. */
  const codes = [...new Set(bankRows.map((b) => String(b.account_code)))].sort();
  const banks = codes.map((code) => {
    const byCompany: Record<string, { inChart: boolean; enabled: boolean; usedBy: string[] }> = {};
    for (const id of ids) {
      const row = bankRows.find((b) => Number(b.company_id) === id && String(b.account_code) === code);
      byCompany[String(id)] = {
        inChart: Boolean(row),
        enabled: Boolean(row) && row!.is_active !== false,
        /* Which merchants pay into it FOR THAT COMPANY — so unticking can say
           what would break instead of breaking it. */
        usedBy: merchants
          .filter((m) => m.byCompany[String(id)]?.enabled && m.byCompany[String(id)]?.bankAccountCode === code)
          .map((m) => String(m.code)),
      };
    }
    return {
      account_code: code,
      account_name: bankRows.find((b) => String(b.account_code) === code)?.account_name ?? code,
      byCompany,
    };
  });

  return c.json({ companies, merchants, banks });
});


/* PATCH /maintenance/merchant — tick a merchant on or off for one company, and
   say which of that company's banks it pays into. Creates the link row the
   first time, so a company nobody has set up needs no migration. */
export const settlementMaintenanceMerchant = guard(async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const target = maintenanceCompany(c, body.companyId);
  if (!target.ok) return c.json(target.refusal, 409);
  const code = String(body.code ?? '').trim();
  if (!code) return c.json({ error: 'no_merchant', message: 'Which merchant?' }, 400);
  const sb = c.get('supabase');
  const companyId = target.companyId;

  const { data: existing, error: exErr } = await sb.from('acc_company_acquirers')
    .select('acquirer_code').eq('company_id', companyId).eq('acquirer_code', code).maybeSingle();
  if (exErr) return c.json({ error: 'load_failed', reason: exErr.message }, 500);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.enabled !== undefined) patch.is_active = Boolean(body.enabled);
  if (body.bankAccountCode !== undefined) patch.bank_account_code = body.bankAccountCode || null;

  if (!existing) {
    const { error } = await sb.from('acc_company_acquirers').insert({
      company_id: companyId,
      acquirer_code: code,
      transit_account_code: '320-0000',
      fee_account_code: '930-0000',
      bank_account_code: body.bankAccountCode || null,
      is_active: body.enabled === undefined ? true : Boolean(body.enabled),
    });
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
    return c.json({ ok: true, created: true });
  }

  const { error } = await sb.from('acc_company_acquirers').update(patch)
    .eq('company_id', companyId).eq('acquirer_code', code);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, created: false });
});

/* PATCH /maintenance/bank — tick which banks a company actually banks with.
   Switching one OFF while a merchant still pays into it is refused BY NAME:
   the ledger would then have a merchant pointed at an account the posting gate
   will not accept, and that failure would surface days later at the worst
   moment — when the money arrives. */
export const settlementMaintenanceBank = guard(async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const target = maintenanceCompany(c, body.companyId);
  if (!target.ok) return c.json(target.refusal, 409);
  const accountCode = String(body.accountCode ?? '').trim();
  if (!accountCode) return c.json({ error: 'no_account', message: 'Which bank account?' }, 400);
  const enabled = Boolean(body.enabled);
  const sb = c.get('supabase');
  const companyId = target.companyId;

  if (!enabled) {
    const { data: usersRaw, error: uErr } = await sb.from('acc_company_acquirers')
      .select('acquirer_code, is_active').eq('company_id', companyId).eq('bank_account_code', accountCode);
    if (uErr) return c.json({ error: 'load_failed', reason: uErr.message }, 500);
    const users = ((usersRaw ?? []) as Array<{ acquirer_code: string; is_active: boolean | null }>)
      .filter((u) => u.is_active !== false).map((u) => u.acquirer_code);
    if (users.length > 0) {
      return c.json({
        error: 'bank_in_use',
        message: `${users.join(', ')} still pay${users.length === 1 ? 's' : ''} into this account for this company. Point ${users.length === 1 ? 'it' : 'them'} somewhere else first.`,
      }, 409);
    }
  }

  const { error } = await sb.from('accounts')
    .update({ is_active: enabled })
    .eq('company_id', companyId).eq('account_code', accountCode);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════════════════
   Uploading a statement
   ════════════════════════════════════════════════════════════════════════ */

/* POST /batches — parse, match, store. Every refusal below is a 400 with a
   sentence the operator can act on; none of them is an empty batch. */
export const settlementUpload = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const acquirerCode = String(body.acquirerCode ?? '').trim();
  const fileName = String(body.fileName ?? '').trim() || 'statement.csv';
  const content = String(body.content ?? '');
  if (!acquirerCode) return c.json({ error: 'no_acquirer', message: 'Choose which acquirer sent this statement.' }, 400);
  if (!content.trim()) return c.json({ error: 'empty_file', message: 'The file is empty.' }, 400);

  const sb = c.get('supabase');
  const acq = await loadAcquirer(sb, co.companyId, acquirerCode);
  if (!acq.ok) return c.json({ error: 'acquirer_unavailable', message: acq.reason }, 400);
  if (!acq.acquirer.is_active) {
    return c.json({ error: 'acquirer_inactive', message: `${acquirerCode} is switched off for this company.` }, 400);
  }

  const parsed = parseStatement({
    code: acq.acquirer.code,
    statement_format: acq.acquirer.statement_format,
    fee_method: acq.acquirer.fee_method,
    column_map: acq.acquirer.column_map as StatementColumnMap | null,
    summaryFeeSen: body.summaryFeeSen == null ? null : Number(body.summaryFeeSen),
    /* Only consulted when the file's own dates carry no year (the Maybank
       terminal statement prints "05-Jun"). The operator answers; nothing here
       guesses which year a payment belongs to. */
    statementMonth: /^\d{4}-\d{2}$/.test(String(body.statementMonth ?? '')) ? String(body.statementMonth) : null,
    total_net_label: (acq.acquirer as { total_net_label?: string | null }).total_net_label ?? null,
    summary_totals: (acq.acquirer as { summary_totals?: { rowLabel: string; fee?: string; net?: string } | null }).summary_totals ?? null,
  }, content);
  if (!parsed.ok) return c.json({ error: 'unreadable_statement', message: parsed.reason }, 400);

  const fileHash = await sha256Hex(content);
  const { data: batchRow, error: batchErr } = await sb.from('acc_settlement_batches').insert({
    company_id: co.companyId,
    acquirer_code: acquirerCode,
    file_name: fileName,
    file_hash: fileHash,
    period_from: parsed.periodFrom,
    period_to: parsed.periodTo,
    row_count: parsed.rows.length,
    gross_sen: parsed.grossSen,
    fee_sen: parsed.feeSen,
    net_sen: parsed.netSen,
    stated_net_sen: parsed.statedNetSen,
    adjustment_sen: parsed.adjustmentSen,
    uploaded_by: (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null,
  }).select('id').single();
  if (batchErr) {
    const twice = String(batchErr.code ?? '') === '23505' || /duplicate key/i.test(String(batchErr.message ?? ''));
    return c.json({
      error: twice ? 'already_uploaded' : 'save_failed',
      message: twice ? 'This exact file has already been uploaded. Open the existing batch instead of loading it twice.' : batchErr.message,
    }, twice ? 409 : 500);
  }
  const batchId = (batchRow as { id: number }).id;

  const [candidates, settled] = await Promise.all([
    loadPaymentCandidates(sb, co.companyId, acq.acquirer, parsed.periodFrom, parsed.periodTo),
    loadSettledKeys(sb, co.companyId),
  ]);
  if (!candidates.ok) return c.json({ error: 'load_failed', reason: candidates.reason }, 500);
  if (!settled.ok) return c.json({ error: 'load_failed', reason: settled.reason }, 500);

  const decisions = matchStatement(
    { code: acq.acquirer.code, has_unique_ref: acq.acquirer.has_unique_ref, date_tolerance_days: acq.acquirer.date_tolerance_days },
    parsed.rows, candidates.payments, settled.keys,
  );

  const { data: writtenRaw, error: rowsErr } = await sb.from('acc_settlement_rows').insert(
    decisions.map((d) => ({
      batch_id: batchId,
      company_id: co.companyId,
      acquirer_code: acquirerCode,
      line_no: d.row.lineNo,
      txn_date: d.row.txnDate,
      ref: d.row.ref,
      gross_sen: d.row.grossSen,
      fee_sen: d.row.feeSen,
      net_sen: d.row.netSen,
      bucket: d.bucket,
      match_reason: d.matchReason,
      notes: d.clue,
    })),
  ).select('id, line_no');
  if (rowsErr) return c.json({ error: 'save_failed', reason: rowsErr.message }, 500);

  /* Link the reference-matched payments to their line. A link that loses the
     acc_settlement_payment_once race (another statement claimed that payment
     between the read above and now) drops its line to NEEDS_CONFIRM rather
     than clearing the same money twice. */
  const idByLine = new Map(((writtenRaw ?? []) as Array<{ id: number; line_no: number }>).map((r) => [r.line_no, r.id]));
  let autoMatched = 0;
  for (const d of decisions) {
    if (d.bucket !== 'MATCHED' || d.matched.length === 0) continue;
    const rowId = idByLine.get(d.row.lineNo);
    if (rowId == null) continue;
    const { error } = await sb.from('acc_settlement_matches').insert(d.matched.map((p) => ({
      settlement_row_id: rowId,
      company_id: co.companyId,
      payment_source: p.source,
      payment_id: p.id,
      doc_no: p.docNo,
      amount_sen: p.amountSen,
    })));
    if (error) {
      await sb.from('acc_settlement_rows').update({
        bucket: 'NEEDS_CONFIRM',
        notes: 'That payment was cleared by another settlement while this file was being read — check it by hand.',
      }).eq('id', rowId);
    } else autoMatched += 1;
  }

  const count = (b: string) => decisions.filter((d) => d.bucket === b).length;
  return c.json({
    batchId,
    fileName,
    acquirerCode,
    rows: decisions.length,
    /* Summary/total rows the file carries that are not transactions. Reported
       rather than swallowed — the operator should never have to wonder why the
       file had 6 lines and the batch has 5. */
    skippedLines: parsed.skippedLines,
    statedNetSen: parsed.statedNetSen,
    adjustmentSen: parsed.adjustmentSen,
    grossSen: parsed.grossSen,
    feeSen: parsed.feeSen,
    netSen: parsed.netSen,
    periodFrom: parsed.periodFrom,
    periodTo: parsed.periodTo,
    buckets: { MATCHED: autoMatched, NEEDS_CONFIRM: count('NEEDS_CONFIRM') + (count('MATCHED') - autoMatched), UNMATCHED: count('UNMATCHED'), IGNORED: 0 },
  });
});

const BATCH_COLUMNS =
  'id, acquirer_code, file_name, period_from, period_to, row_count, gross_sen, fee_sen, net_sen, stated_net_sen, adjustment_sen, adjustment_je_no, status, created_at';

/** What a statement promised to pay: its own stated total, else its lines. */
const payableOf = (b: { stated_net_sen?: number | null; net_sen?: number | null }) =>
  Number(b.stated_net_sen ?? b.net_sen ?? 0);

/* GET /batches — the upload history, newest first, each carrying how much of
   its payout has actually arrived. Derived from the receipts on every read
   (§2.3: no caches), because "one statement, one credit" is not true — Hong
   Leong pays a multi-day statement one credit per day. */
export const settlementBatches = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data, error } = await sb.from('acc_settlement_batches')
    .select(`${BATCH_COLUMNS}, uploaded_by`)
    .eq('company_id', co.companyId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const { data: recRaw, error: rcErr } = await sb.from('acc_settlement_receipts')
    .select('batch_id, received_on, amount_sen').eq('company_id', co.companyId);
  if (rcErr) return c.json({ error: 'load_failed', reason: rcErr.message }, 500);

  /* How far the CARD MACHINE side has got. The two steps are two screens, so
     each list has to say where the other one stands: the payouts screen must
     not invite money against a statement nobody has reconciled. */
  const { data: rowTally, error: rtErr } = await sb.from('acc_settlement_rows')
    .select('batch_id, bucket, confirmed_at').eq('company_id', co.companyId);
  if (rtErr) return c.json({ error: 'load_failed', reason: rtErr.message }, 500);
  const reconciled = new Map<number, { confirmed: number; open: number; toConfirm: number; toChoose: number; noRecord: number }>();
  for (const r of (rowTally ?? []) as Array<{ batch_id: number; bucket: string; confirmed_at: string | null }>) {
    const at = reconciled.get(Number(r.batch_id)) ?? { confirmed: 0, open: 0, toConfirm: 0, toChoose: 0, noRecord: 0 };
    if (r.confirmed_at) at.confirmed += 1;
    else if (r.bucket !== 'IGNORED') {
      at.open += 1;
      /* THREE kinds of not-done, because each is a different amount of work:
           MATCHED       — already matched by reference; one button;
           NEEDS_CONFIRM — candidates found, a human must choose;
           UNMATCHED     — the report has it and no sale in the ERP does
                           (his second list: merchant report 有但是找不到相对应
                           的 transaction 的是那几笔).
         Calling the first one "to decide" is what made an auto-matched line
         look like a problem. */
      if (r.bucket === 'UNMATCHED') at.noRecord += 1;
      else if (r.bucket === 'MATCHED') at.toConfirm += 1;
      else at.toChoose += 1;
    }
    reconciled.set(Number(r.batch_id), at);
  }

  const got = new Map<number, { sen: number; count: number; lastOn: string | null }>();
  for (const r of (recRaw ?? []) as Array<{ batch_id: number; received_on: string; amount_sen: number }>) {
    const at = got.get(Number(r.batch_id)) ?? { sen: 0, count: 0, lastOn: null };
    at.sen += Number(r.amount_sen ?? 0);
    at.count += 1;
    const on = String(r.received_on ?? '').slice(0, 10);
    if (!at.lastOn || on > at.lastOn) at.lastOn = on;
    got.set(Number(r.batch_id), at);
  }

  const batches = ((data ?? []) as Array<Record<string, any>>).map((b) => {
    const at = got.get(Number(b.id)) ?? { sen: 0, count: 0, lastOn: null };
    const done = reconciled.get(Number(b.id)) ?? { confirmed: 0, open: 0, toConfirm: 0, toChoose: 0, noRecord: 0 };
    const payable = payableOf(b);
    return {
      ...b,
      confirmed_count: done.confirmed,
      open_count: done.open,
      to_confirm_count: done.toConfirm,
      to_choose_count: done.toChoose,
      no_record_count: done.noRecord,
      received_sen: at.sen,
      receipt_count: at.count,
      /* The day it was FULLY received, and null while any of it is still out —
         "partly in the bank" must not read as "in the bank". */
      received_on: at.sen === payable && payable !== 0 ? at.lastOn : null,
      outstanding_sen: payable - at.sen,
    };
  });
  return c.json({ batches });
});

/* GET /batches/:id — the four piles, with live candidates for the pile that
   needs a human. Candidates are recomputed on every read (§2.3: no caches) so
   a payment keyed in after the upload appears without re-uploading the file. */
export const settlementBatchDetail = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const batchId = Number(c.req.param('id'));
  if (!Number.isInteger(batchId)) return c.json({ error: 'bad_id' }, 400);
  const sb = c.get('supabase');

  const { data: batch, error: bErr } = await sb.from('acc_settlement_batches')
    .select(BATCH_COLUMNS)
    .eq('id', batchId).eq('company_id', co.companyId).maybeSingle();
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  if (!batch) return c.json({ error: 'not_found' }, 404);
  const b = batch as { acquirer_code: string; period_from: string; period_to: string };

  /* Every credit recorded against this statement, and what is still out. */
  const paid = await loadBatchReceipts(sb, co.companyId, batchId);
  if (!paid.ok) return c.json({ error: 'load_failed', reason: paid.reason }, 500);

  const { data: rowsRaw, error: rErr } = await sb.from('acc_settlement_rows')
    .select('id, line_no, txn_date, ref, gross_sen, fee_sen, net_sen, bucket, match_reason, confirmed_at, posted_je_no, notes')
    .eq('batch_id', batchId).order('line_no');
  if (rErr) return c.json({ error: 'load_failed', reason: rErr.message }, 500);
  const stored = (rowsRaw ?? []) as StoredRow[];

  const acq = await loadAcquirer(sb, co.companyId, b.acquirer_code);
  if (!acq.ok) return c.json({ error: 'acquirer_unavailable', message: acq.reason }, 400);
  const [candidates, settled] = await Promise.all([
    loadPaymentCandidates(sb, co.companyId, acq.acquirer, b.period_from, b.period_to),
    loadSettledKeys(sb, co.companyId),
  ]);
  if (!candidates.ok) return c.json({ error: 'load_failed', reason: candidates.reason }, 500);
  if (!settled.ok) return c.json({ error: 'load_failed', reason: settled.reason }, 500);

  /* The payments already linked to each line — what the matched pile shows,
     and what a re-opened line starts from. Read BEFORE the recompute, because
     it decides which lines the recompute is even for. */
  const { data: linkRaw, error: lErr } = await sb.from('acc_settlement_matches')
    .select('settlement_row_id, payment_source, payment_id, doc_no, amount_sen')
    .eq('company_id', co.companyId);
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const linksByRow = new Map<number, Array<Record<string, unknown>>>();
  for (const l of (linkRaw ?? []) as Array<Record<string, any>>) {
    const list = linksByRow.get(Number(l.settlement_row_id));
    if (list) list.push(l);
    else linksByRow.set(Number(l.settlement_row_id), [l]);
  }

  /* Only lines that still need a HUMAN get candidates computed. The stored
     bucket stays the truth — a human's decision is never recomputed away.
     A line that already claimed its payment is excluded, and that exclusion is
     the point: `settled.keys` holds every claimed payment INCLUDING its own, so
     recomputing for it searched a pool its own payment had been taken out of
     and reported "No payment recorded near …" about a line that was matched.
     The screen then said both things at once, which is what the owner saw. */
  const open = stored.filter((r) => !r.confirmed_at && r.bucket !== 'IGNORED');
  const needsAHuman = open.filter((r) => (linksByRow.get(r.id) ?? []).length === 0);
  const suggestions = matchStatement(
    { code: acq.acquirer.code, has_unique_ref: acq.acquirer.has_unique_ref, date_tolerance_days: acq.acquirer.date_tolerance_days },
    needsAHuman.map((r) => ({ lineNo: r.line_no, txnDate: String(r.txn_date).slice(0, 10), ref: r.ref, grossSen: Number(r.gross_sen), feeSen: Number(r.fee_sen), netSen: Number(r.net_sen) })),
    candidates.payments,
    settled.keys,
  );
  const byLine = new Map(suggestions.map((d) => [d.row.lineNo, d]));

  /* Every payment in the window, by key — the linked ones are in here too:
     `settled.keys` gates the MATCHER, it does not shrink this list. */
  const paymentOf = new Map(candidates.payments.map((p) => [`${p.source}:${p.id}`, p]));

  const rows = stored.map((r) => {
    const s = byLine.get(r.line_no);
    return {
      ...r,
      txn_date: String(r.txn_date).slice(0, 10),
      /* The linked rows carry a document number and an amount. The operator is
         reading a RECONCILIATION, so the sale itself belongs here too — who it
         was, when it was paid, what code the till recorded (owner: 我希望他是显示
         transaction detail 和 sales order detail, 而不是 document 罢了). */
      linked: (linksByRow.get(r.id) ?? []).map((l) => {
        const p = paymentOf.get(`${String(l.payment_source)}:${String(l.payment_id)}`);
        return {
          ...l,
          doc_no: l.doc_no ?? p?.docNo ?? null,
          paid_on: p?.paidOn ?? null,
          customer_name: p?.customerName ?? null,
          approval_code: p?.approvalCode ?? null,
        };
      }),
      candidates: s?.candidates ?? [],
      comboHints: s?.comboHints ?? [],
      /* The system's own best answer, pre-ticked on screen. A suggestion, never
         a decision — nothing posts until he confirms. */
      suggested: s?.suggested ?? [],
      clue: s?.clue ?? r.notes,
    };
  });

  /* Typed against the matcher's own union, not `Record<string, …>` — the
     bucket set has ONE home (MatchBucket) and a new bucket must fail to
     compile here rather than tally into nowhere. */
  const tally: Record<MatchBucket, number> = { MATCHED: 0, NEEDS_CONFIRM: 0, UNMATCHED: 0, IGNORED: 0 };
  for (const r of stored) {
    const b = r.bucket as MatchBucket;
    tally[b] = (tally[b] ?? 0) + 1;
  }

  /* WHICH BANK this merchant pays THIS company — named on screen at the moment
     the money is recorded, because the same merchant pays different companies
     into different banks and a wrong one is invisible until the bank statement
     disagrees. Unset falls back to the company default (the books never stop),
     but the fallback is reported, never silent. */
  const roles = await resolveRoles(sb, co.companyId);
  const bankCode = acq.acquirer.bank_account_code || roles.BANK_DEFAULT;
  const { data: bankRow, error: bankErr } = await sb.from('accounts')
    .select('account_code, account_name').eq('company_id', co.companyId).eq('account_code', bankCode).maybeSingle();
  /* The screen names WHICH BANK before money is recorded against it; a failed
     read must not dress up as "no such account". */
  if (bankErr) return c.json({ error: 'load_failed', reason: bankErr.message }, 500);

  const payable = payableOf(batch as Record<string, number | null>);
  return c.json({
    batch: {
      ...batch,
      received_sen: paid.receivedSen,
      outstanding_sen: payable - paid.receivedSen,
      receipts: paid.receipts,
      receiving_bank: {
        code: bankCode,
        name: (bankRow as { account_name?: string } | null)?.account_name ?? null,
        configured: Boolean(acq.acquirer.bank_account_code),
      },
    },
    acquirer: { code: acq.acquirer.code, hasUniqueRef: acq.acquirer.has_unique_ref, dateToleranceDays: acq.acquirer.date_tolerance_days },
    buckets: tally,
    rows,
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Deciding a line
   ════════════════════════════════════════════════════════════════════════ */

/* POST /rows/:id/confirm — the moment that posts. `payments` may hold several
   (一笔刷卡对应两张订单); the sum must be the statement line, to the sen. */
export const settlementConfirmRow = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rowId = Number(c.req.param('id'));
  if (!Number.isInteger(rowId)) return c.json({ error: 'bad_id' }, 400);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const payments = Array.isArray(body.payments) ? body.payments : [];
  const reason = ['ref', 'amount+date', 'manual'].includes(String(body.matchReason)) ? String(body.matchReason) : 'manual';

  const r = await confirmSettlementRow(c.get('supabase'), {
    companyId: co.companyId,
    rowId,
    matchReason: reason as 'ref' | 'amount+date' | 'manual',
    userName: (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null,
    payments: payments.map((p: any) => ({
      source: p.source === 'SIPAY' ? 'SIPAY' : 'SOPAY',
      id: String(p.id),
      docNo: p.docNo == null ? null : String(p.docNo),
      amountSen: Number(p.amountSen ?? 0),
    })),
  });
  if (!r.ok) {
    const status = r.status === 'not_found' ? 404
      : ['amount_mismatch', 'no_payments', 'ignored', 'payment_already_settled'].includes(r.status) ? 409
      : 500;
    return c.json({ error: r.status, message: r.reason }, status);
  }
  return c.json(r);
});

/* POST /batches/:id/confirm-matched — the "全部确认" button: post every line
   the unique reference already matched. Failures are LISTED, not swallowed,
   and never stop the rest of the batch (§2.14). */
export const settlementConfirmMatched = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const batchId = Number(c.req.param('id'));
  if (!Number.isInteger(batchId)) return c.json({ error: 'bad_id' }, 400);
  const sb = c.get('supabase');

  const { data: rowsRaw, error } = await sb.from('acc_settlement_rows')
    .select('id, bucket, confirmed_at').eq('batch_id', batchId).eq('company_id', co.companyId);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const pending = ((rowsRaw ?? []) as StoredRow[]).filter((r) => r.bucket === 'MATCHED' && !r.confirmed_at);

  const { data: linkRaw, error: lErr } = await sb.from('acc_settlement_matches')
    .select('settlement_row_id, payment_source, payment_id, doc_no, amount_sen').eq('company_id', co.companyId);
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const linksByRow = new Map<number, Array<Record<string, any>>>();
  for (const l of (linkRaw ?? []) as Array<Record<string, any>>) {
    const list = linksByRow.get(Number(l.settlement_row_id));
    if (list) list.push(l);
    else linksByRow.set(Number(l.settlement_row_id), [l]);
  }

  const userName = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
  let confirmed = 0;
  const failed: Array<{ rowId: number; reason: string }> = [];
  for (const row of pending) {
    const links = linksByRow.get(row.id) ?? [];
    const r = await confirmSettlementRow(sb, {
      companyId: co.companyId,
      rowId: row.id,
      matchReason: 'ref',
      userName,
      payments: links.map((l) => ({
        source: l.payment_source === 'SIPAY' ? 'SIPAY' : 'SOPAY',
        id: String(l.payment_id),
        docNo: l.doc_no ?? null,
        amountSen: Number(l.amount_sen ?? 0),
      })),
    });
    if (r.ok) confirmed += 1;
    else failed.push({ rowId: row.id, reason: r.reason });
  }

  /* And the charge the STATEMENT made that no transaction explains (AEON's
     subvention fee). Posted here rather than left for a separate click,
     because a batch whose lines are booked and whose statement charge is not
     leaves the bank overstated by exactly that amount. Idempotent, and a zero
     adjustment — the ordinary case — books nothing. */
  const charge = await postStatementCharge(sb, co.companyId, batchId);
  if (!charge.ok) failed.push({ rowId: 0, reason: `statement charge: ${charge.reason}` });

  return c.json({
    ok: true,
    attempted: pending.length,
    confirmed,
    failed,
    statementCharge: charge.ok ? { status: charge.status, ...(charge.jeNo ? { jeNo: charge.jeNo } : {}) } : null,
  });
});

/* POST /batches/:id/received — "this much money is in the bank, on this day".
   The second half of the owner's two-step (2026-08-17: 先对卡机报告，然后
   match 了就会去 match bank statement). Reconciling the card machine booked the
   fee; this books ONE credit of the payout, dated by the bank statement. A
   statement may be paid in several (他: 我实际收到的钱可能是多笔的哦), so the
   amount is optional and defaults to whatever is still outstanding. Layer 4
   will call the same function with what it reads off the bank statement. */
export const settlementBatchReceived = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const batchId = Number(c.req.param('id'));
  if (!Number.isInteger(batchId)) return c.json({ error: 'bad_id' }, 400);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const receivedOn = String(body.receivedOn ?? '').trim();
  if (!DAY.test(receivedOn)) {
    return c.json({ error: 'bad_date', message: 'Give the date the money reached the bank, as it reads on the bank statement.' }, 400);
  }
  if (body.amountSen != null && !Number.isFinite(Number(body.amountSen))) {
    return c.json({ error: 'bad_amount', message: 'Give the amount of this credit, as it reads on the bank statement.' }, 400);
  }

  const r = await postBatchReceipt(c.get('supabase'), co.companyId, batchId, {
    receivedOn,
    amountSen: body.amountSen == null ? null : Number(body.amountSen),
    bankRef: body.bankRef == null ? null : String(body.bankRef),
    note: body.note == null ? null : String(body.note),
    userName: (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null,
  });
  if (!r.ok) {
    const status = r.status === 'not_found' ? 404
      : ['bad_date', 'bad_amount', 'nothing_to_receive', 'fully_received', 'over_receipt', 'acquirer_unavailable'].includes(r.status) ? 409
      : 500;
    return c.json({ error: r.status, message: r.reason }, status);
  }
  return c.json(r);
});

/* POST /receipts/:id/undo — take one credit back off the statement.
   A wrong date or a credit that belonged to another statement is corrected by
   REVERSING its entry, not by deleting history: the money goes back into
   settlement-in-transit, where it was. */
export const settlementReceiptUndo = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const receiptId = Number(c.req.param('id'));
  if (!Number.isInteger(receiptId)) return c.json({ error: 'bad_id' }, 400);

  const r = await undoBatchReceipt(c.get('supabase'), co.companyId, receiptId);
  if (!r.ok) return c.json({ error: r.status, message: r.reason }, r.status === 'not_found' ? 404 : 500);
  return c.json(r);
});

/* POST /rows/:id/ignore — set a line aside (or put it back). A confirmed line
   cannot be ignored: it is in the ledger, and the way out of the ledger is a
   journal, not a checkbox. */
export const settlementIgnoreRow = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rowId = Number(c.req.param('id'));
  if (!Number.isInteger(rowId)) return c.json({ error: 'bad_id' }, 400);
  let body: any = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const restore = body.restore === true;
  const sb = c.get('supabase');

  const { data: row, error } = await sb.from('acc_settlement_rows')
    .select('id, confirmed_at').eq('id', rowId).eq('company_id', co.companyId).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if ((row as { confirmed_at: string | null }).confirmed_at) {
    return c.json({ error: 'already_confirmed', message: 'This line is already in the ledger. Reverse its journal entry instead.' }, 409);
  }
  const { error: upErr } = await sb.from('acc_settlement_rows').update({
    bucket: restore ? 'NEEDS_CONFIRM' : 'IGNORED',
    notes: body.notes == null ? null : String(body.notes),
    updated_at: new Date().toISOString(),
  }).eq('id', rowId);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════════════════
   The two standing watchlists + the export
   ════════════════════════════════════════════════════════════════════════ */

/* GET /watchlist?acquirer=&from=&to= — the two lists that must never be
   allowed to quietly grow:
     recordedNotArrived — the ERP took card money the acquirer has not sent;
     arrivedNotRecorded — the acquirer sent money with no sale behind it.
   Both are also what layer 4 (bank reconciliation, phase 4) will refuse to
   open until they are empty. */
export const settlementWatchlist = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const to = DAY.test(c.req.query('to') ?? '') ? (c.req.query('to') as string) : todayMyt();
  const from = DAY.test(c.req.query('from') ?? '')
    ? (c.req.query('from') as string)
    : new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
  const only = (c.req.query('acquirer') ?? '').trim();

  const { data: acqRaw, error: aErr } = await sb.from('acc_acquirers')
    .select('code, display_name, date_tolerance_days')
    .eq('company_id', co.companyId).eq('is_active', true).order('code');
  if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
  const acquirers = ((acqRaw ?? []) as Array<{ code: string; display_name: string; date_tolerance_days: number }>)
    .filter((a) => !only || a.code === only);

  const settled = await loadSettledKeys(sb, co.companyId);
  if (!settled.ok) return c.json({ error: 'load_failed', reason: settled.reason }, 500);

  const recorded: Array<PaymentCandidate & { ageDays: number; acquirerCode: string }> = [];
  for (const a of acquirers) {
    const got = await loadPaymentCandidates(sb, co.companyId, a, from, to);
    if (!got.ok) return c.json({ error: 'load_failed', reason: got.reason }, 500);
    for (const p of recordedNotArrived(got.payments, settled.keys, to)) {
      recorded.push({ ...p, acquirerCode: a.code });
    }
  }

  const { data: strandedRaw, error: sErr } = await sb.from('acc_settlement_rows')
    .select('id, batch_id, acquirer_code, txn_date, ref, gross_sen, fee_sen, net_sen, notes')
    .eq('company_id', co.companyId).eq('bucket', 'UNMATCHED')
    .gte('txn_date', from).lte('txn_date', to).order('txn_date');
  if (sErr) return c.json({ error: 'load_failed', reason: sErr.message }, 500);
  const stranded = ((strandedRaw ?? []) as Array<Record<string, any>>).filter((r) => !only || r.acquirer_code === only);

  return c.json({
    from,
    to,
    recordedNotArrived: recorded.sort((a, b) => b.ageDays - a.ageDays),
    arrivedNotRecorded: stranded,
    clean: recorded.length === 0 && stranded.length === 0,
  });
});

/* GET /in-transit — WHOSE money is sitting in settlement-in-transit, line by
   line (the brief's 在途结算款账龄, §3.7 — "刷卡多久还没到账，按收单行分").
   The owner asked for it in these words: he needs to see that a customer has
   paid but the money has not arrived or been reconciled yet, in DETAIL, not as
   a balance. THREE states, because they mean different things and need
   different people chased:
     • not on any statement yet  — the acquirer has not reported it
     • matched, not yet posted   — reported, waiting to be confirmed
     • reconciled, not yet paid  — confirmed, the payout has not arrived
   A line leaves this list only when its batch's money is actually in the bank.
   Live from the payments and the match table; nothing cached (§2.3), so this
   list and the 320-0000 balance can never tell different stories — which is
   also why a reconciled line shows its NET: its fee is already out of transit,
   booked the day it was confirmed. */
export const settlementInTransit = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const to = DAY.test(c.req.query('to') ?? '') ? (c.req.query('to') as string) : todayMyt();
  const from = DAY.test(c.req.query('from') ?? '')
    ? (c.req.query('from') as string)
    : new Date(Date.parse(`${to}T00:00:00Z`) - 180 * 86_400_000).toISOString().slice(0, 10);

  const { data: acqRaw, error: aErr } = await sb.from('acc_acquirers')
    .select('code, display_name, date_tolerance_days')
    .eq('company_id', co.companyId).eq('is_active', true).order('code');
  if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);

  /* Which payments a settlement line has claimed, whether that line has been
     confirmed, and whether its batch's money has actually arrived. */
  const { data: matchRaw, error: mErr } = await sb.from('acc_settlement_matches')
    .select('payment_source, payment_id, settlement_row_id, amount_sen').eq('company_id', co.companyId);
  if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
  const { data: rowRaw, error: rErr } = await sb.from('acc_settlement_rows')
    .select('id, batch_id, confirmed_at, fee_sen').eq('company_id', co.companyId);
  if (rErr) return c.json({ error: 'load_failed', reason: rErr.message }, 500);
  const { data: batchRaw, error: bErr } = await sb.from('acc_settlement_batches')
    .select('id, net_sen, stated_net_sen, adjustment_sen, adjustment_je_no').eq('company_id', co.companyId);
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  const { data: recRaw, error: rcErr } = await sb.from('acc_settlement_receipts')
    .select('batch_id, amount_sen').eq('company_id', co.companyId);
  if (rcErr) return c.json({ error: 'load_failed', reason: rcErr.message }, 500);

  type BatchRow = { id: number; net_sen: number | null; stated_net_sen: number | null; adjustment_sen: number | null; adjustment_je_no: string | null };
  const batches = (batchRaw ?? []) as BatchRow[];
  /* How much of each statement's payout has actually landed. A statement is
     out of transit only when its credits ADD UP to what it promised — being
     paid in several is normal, and half-paid is not paid. */
  const receivedByBatch = new Map<number, number>();
  for (const r of (recRaw ?? []) as Array<{ batch_id: number; amount_sen: number }>) {
    receivedByBatch.set(Number(r.batch_id), (receivedByBatch.get(Number(r.batch_id)) ?? 0) + Number(r.amount_sen ?? 0));
  }
  const paidBatch = new Set(batches
    .filter((b) => payableOf(b) !== 0 && (receivedByBatch.get(Number(b.id)) ?? 0) === payableOf(b))
    .map((b) => Number(b.id)));
  const rowInfo = new Map(((rowRaw ?? []) as Array<{ id: number; batch_id: number; confirmed_at: string | null; fee_sen: number | null }>)
    .map((r) => [Number(r.id), {
      confirmed: Boolean(r.confirmed_at),
      batchId: Number(r.batch_id),
      paid: paidBatch.has(Number(r.batch_id)),
      feeSen: Number(r.fee_sen ?? 0),
    }]));

  const matches = (matchRaw ?? []) as Array<{ payment_source: string; payment_id: string; settlement_row_id: number; amount_sen: number | null }>;
  const claim = new Map<string, number>();
  for (const m of matches) claim.set(`${m.payment_source}:${m.payment_id}`, Number(m.settlement_row_id));

  /* A confirmed line's fee is already OUT of in-transit, so what it still holds
     for that line is the net. One statement line can cover two orders (一笔刷卡
     对应两张订单), so the fee is split across them in proportion to their
     amounts — and the last share takes the rounding, so the split adds back to
     the fee exactly rather than leaving a sen adrift from the ledger. */
  const outOfTransit = new Map<string, number>();
  const byRow = new Map<number, typeof matches>();
  for (const m of matches) {
    const list = byRow.get(Number(m.settlement_row_id));
    if (list) list.push(m);
    else byRow.set(Number(m.settlement_row_id), [m]);
  }
  const spread = (amount: number, list: typeof matches, into: Map<string, number>) => {
    const total = list.reduce((s, m) => s + Number(m.amount_sen ?? 0), 0);
    let allocated = 0;
    list.forEach((m, i) => {
      const share = i === list.length - 1 || total === 0
        ? amount - allocated
        : Math.round((amount * Number(m.amount_sen ?? 0)) / total);
      allocated += share;
      const key = `${m.payment_source}:${m.payment_id}`;
      into.set(key, (into.get(key) ?? 0) + share);
    });
  };
  for (const [rowId, list] of byRow) {
    /* Only a CONFIRMED line's fee has actually left the account. */
    const row = rowInfo.get(rowId);
    if (row?.confirmed === true) spread(row.feeSen, list, outOfTransit);
  }

  /* Two more things that have left in-transit without belonging to any single
     payment, spread across the batch's payments so that this list and the
     320-0000 balance cannot tell different stories:
       • the charge the STATEMENT made that no transaction explains (AEON's
         subvention fee), once it is booked;
       • the credits that have ALREADY landed for a statement that is only
         part-paid — normal, since one statement is often paid in several.
     A fully-paid batch is skipped: its payments left the list entirely. */
  const matchesByBatch = new Map<number, typeof matches>();
  for (const m of matches) {
    const batchId = rowInfo.get(Number(m.settlement_row_id))?.batchId;
    if (batchId == null) continue;
    const list = matchesByBatch.get(batchId);
    if (list) list.push(m);
    else matchesByBatch.set(batchId, [m]);
  }
  for (const b of batches) {
    const id = Number(b.id);
    if (paidBatch.has(id)) continue;
    const list = matchesByBatch.get(id);
    if (!list || list.length === 0) continue;
    const adjustment = b.adjustment_je_no ? Number(b.adjustment_sen ?? 0) : 0;
    const alreadyPaid = receivedByBatch.get(id) ?? 0;
    if (adjustment !== 0) spread(adjustment, list, outOfTransit);
    if (alreadyPaid !== 0) spread(alreadyPaid, list, outOfTransit);
  }

  const days = (a: string, b: string) =>
    Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

  const lines: Array<Record<string, unknown>> = [];
  for (const a of (acqRaw ?? []) as Array<{ code: string; display_name: string; date_tolerance_days: number }>) {
    const got = await loadPaymentCandidates(sb, co.companyId, a, from, to);
    if (!got.ok) return c.json({ error: 'load_failed', reason: got.reason }, 500);
    for (const p of got.payments) {
      const key = `${p.source}:${p.id}`;
      const row = rowInfo.get(claim.get(key) ?? -1);
      if (row?.paid === true) continue; // the money is in the bank, out of transit
      const state = row == null ? 'NOT_ON_A_STATEMENT'
        : row.confirmed ? 'RECONCILED_NOT_PAID'
        : 'MATCHED_NOT_POSTED';
      lines.push({
        acquirerCode: a.code,
        source: p.source,
        paymentId: p.id,
        docNo: p.docNo,
        paidOn: p.paidOn,
        /* Still in transit for this payment: what the customer paid, less
           everything that has already left the account on its behalf — its
           fee once the line is confirmed, its share of a booked statement
           charge, and its share of any credit that has already landed. */
        amountSen: p.amountSen - (outOfTransit.get(key) ?? 0),
        approvalCode: p.approvalCode,
        recordedById: p.recordedById ?? null,
        ageDays: days(p.paidOn, to),
        state,
      });
    }
  }
  lines.sort((x, y) => Number(y.ageDays) - Number(x.ageDays));

  /* WHO KEYED IT IN. The owner asked to see this: money sitting in transit for
     weeks is a question for a person, and "which of my staff recorded it" is the
     first thing he needs in order to ask it. Resolved in ONE lookup for the
     whole list rather than a query per line — and a name that cannot be
     resolved shows as blank rather than as a raw uuid nobody can read. */
  const staffIds = [...new Set(lines.map((l) => l.recordedById).filter((v): v is string => typeof v === 'string' && v !== ''))];
  const nameOf = new Map<string, string>();
  if (staffIds.length > 0) {
    const { data: staffRaw, error: staffErr } = await sb.from('staff').select('id, name').in('id', staffIds);
    /* "Who keyed it in" is the first thing he needs in order to ask; a failed
       read showing every line blank would read as "nobody recorded". */
    if (staffErr) return c.json({ error: 'load_failed', reason: staffErr.message }, 500);
    for (const s of (staffRaw ?? []) as Array<{ id: string; name: string | null }>) {
      if (s.name) nameOf.set(String(s.id), s.name);
    }
  }
  for (const l of lines) l.recordedBy = nameOf.get(String(l.recordedById ?? '')) ?? null;

  /* Ageing, by acquirer — the shape the brief asks for, and the one that makes
     a stale balance impossible to miss. */
  const buckets = (n: number) => (n <= 7 ? '0-7' : n <= 14 ? '8-14' : n <= 30 ? '15-30' : 'over-30');
  const byAcquirer: Record<string, Record<string, { count: number; sen: number }>> = {};
  for (const l of lines) {
    const a = String(l.acquirerCode);
    const b = buckets(Number(l.ageDays));
    ((byAcquirer[a] ??= {})[b] ??= { count: 0, sen: 0 });
    byAcquirer[a][b].count += 1;
    byAcquirer[a][b].sen += Number(l.amountSen);
  }

  return c.json({
    from,
    to,
    totalSen: lines.reduce((s, l) => s + Number(l.amountSen), 0),
    ageing: byAcquirer,
    lines,
  });
});

/* GET /batches/:id/export — the unmatched lines and the fees, as CSV. Excel
   opens it; the accountant works from it. */
export const settlementExport = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const batchId = Number(c.req.param('id'));
  if (!Number.isInteger(batchId)) return c.json({ error: 'bad_id' }, 400);
  const sb = c.get('supabase');
  const { data, error } = await sb.from('acc_settlement_rows')
    .select('line_no, txn_date, ref, gross_sen, fee_sen, net_sen, bucket, match_reason, posted_je_no, notes')
    .eq('batch_id', batchId).eq('company_id', co.companyId).order('line_no');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const money = (sen: unknown) => (Number(sen ?? 0) / 100).toFixed(2);
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'Line,Date,Reference,Gross,Fee,Net,Bucket,Matched by,Journal,Note';
  const body = ((data ?? []) as Array<Record<string, any>>).map((r) => [
    r.line_no, String(r.txn_date).slice(0, 10), r.ref ?? '',
    money(r.gross_sen), money(r.fee_sen), money(r.net_sen),
    r.bucket, r.match_reason ?? '', r.posted_je_no ?? '', r.notes ?? '',
  ].map(cell).join(',')).join('\n');

  return new Response(`${header}\n${body}\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="settlement-batch-${batchId}.csv"`,
    },
  });
});
