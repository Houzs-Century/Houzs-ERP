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
import { refreshUnconfirmedLinks, type LinkRow } from '../../acc/settlement';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, allowedCompanyIds } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { cardTotalsOf, parseStatement, type StatementColumnMap } from '../../acc/settlement-parse';
import { matchStatement, listOnce, UNTAGGED_LIST, type MatchBucket, type PaymentCandidate } from '../../acc/settlement-match';
import { loadWaitingCardPayments } from '../../acc/waiting-card-payments';
import {
  loadAcquirer, loadPaymentCandidates, loadSettledKeys, loadSettledKeysFor, linesAlreadyOnFile, confirmSettlementRow, confirmSettlementGroup, postStatementCharge,
  releaseSettlementRow, notThisOf, turnedDownKeysOf, MAX_TURNED_DOWN,
  postBatchReceipt, loadBatchReceipts, undoBatchReceipt, unconfirmSettlementRow, clearOrphanBatch, findPaymentsForRow,
} from '../../acc/settlement';
import { rematchOpenLines } from '../../acc/settlement-rematch';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { resolveRoles } from '../../acc/rules';
import { loadLineMonth, loadLiveMonthLock } from '../../acc/bank';
import { lockedRefusal } from '../../acc/bank-lock';
import { bankFollowsMerchant, type BankFollows } from './accounting-bank';
import { unmarkSoldBy } from '../../acc/settlement-sold-by';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** The permission check the brief asks for at this end (the page checks at the
    other). One wrapper, so no handler in this file can be added without it. */
export const settlementGuard = (handler: (c: Ctx) => Promise<Response>) => async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return c.json({ error: "You don't have permission to reconcile acquirer settlements." }, 403);
  }
  return handler(c);
};
const guard = settlementGuard;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Where a company books an acquirer's merchant fee when nobody has said
 * otherwise. Matches the column DEFAULT set by migration 20260910T0147; the two
 * must move together, which is why the code is written once here rather than
 * spelled into each call site.
 *
 * Owner's choice, 2026-09-09: 900-T009 TERMINAL INTEREST CHARGES. It replaced
 * 930-0000, which his AutoCount chart carries as a DEACTIVATED placeholder
 * called MISCELLANEOUS EXPENSES XXX — every settlement confirm in both
 * companies refused with "account 930-0000 is deactivated" until this moved.
 */
const MERCHANT_FEE_ACCOUNT = '900-T009';

type StoredRow = {
  id: number; line_no: number; txn_date: string; ref: string | null;
  gross_sen: number; fee_sen: number; net_sen: number;
  bucket: string; match_reason: string | null; confirmed_at: string | null;
  posted_je_no: string | null; notes: string | null;
  matched_with_row_id?: number | null;
  not_this?: unknown;
  /** 'QR' for a DuitNow QR line (owner 2026-11-09), else null — card. */
  channel?: string | null;
};

const onlinePoolFor = (
  sb: Parameters<typeof loadPaymentCandidates>[0], companyId: number, acquirer: Parameters<typeof loadPaymentCandidates>[2],
  from: string, to: string, hasQr: boolean,
): ReturnType<typeof loadPaymentCandidates> => (hasQr
  ? loadPaymentCandidates(sb, companyId, acquirer, from, to, [], { online: true })
  : Promise.resolve({ ok: true as const, payments: [] }));

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
    .select('code, display_name, statement_format, has_unique_ref, fee_method, date_tolerance_days, column_map, total_net_label, dates_have_no_year, transit_account_code, fee_account_code, bank_account_code, is_active, so_names')
    .eq('company_id', co.companyId).order('code');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const acquirers = ((data ?? []) as Array<Record<string, any>>).map((a) => ({
    ...a,
    ready: Boolean(a.statement_format && a.fee_method && a.column_map?.date && a.column_map?.gross),
    bankReady: Boolean(a.bank_account_code),
    autoMatchable: a.has_unique_ref === true,
  }));

  const { data: bankRaw, error: bErr } = await sb.from('accounts')
    .select('account_code, account_name')
    .eq('company_id', co.companyId).eq('acc_money', true).eq('is_active', true)
    .order('account_code');
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);

  return c.json({ acquirers, bankAccounts: bankRaw ?? [] });
});

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
  if (body.soNames !== undefined) {
    const raw: unknown[] = Array.isArray(body.soNames) ? body.soNames : String(body.soNames ?? '').split(',');
    const names: string[] = [];
    const seen = new Set<string>();
    for (const v of raw) {
      const t = String(v ?? '').trim();
      if (t === '' || seen.has(t.toUpperCase())) continue;
      if (t.length > 40) return c.json({ error: 'bad_so_name', message: `"${t.slice(0, 40)}…" is too long for a merchant name.` }, 400);
      seen.add(t.toUpperCase());
      names.push(t);
    }
    if (names.length > 10) return c.json({ error: 'bad_so_name', message: 'Give at most 10 other names.' }, 400);
    const { data: allRaw, error: aErr } = await sb.from('acc_acquirer_config').select('code, display_name, so_names');
    if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
    const all = (allRaw ?? []) as Array<{ code: string; display_name: string; so_names: string[] | null }>;
    const self = all.find((a) => a.code === code);
    if (!self) return c.json({ error: 'not_found', message: `${code} is not a merchant.` }, 404);
    const kept = names.filter((n) => n.toUpperCase() !== String(self.display_name).trim().toUpperCase());
    for (const other of all) {
      if (other.code === code) continue;
      const theirs = [other.display_name, ...(other.so_names ?? [])].map((n) => String(n ?? '').trim().toUpperCase());
      const clash = kept.find((n) => theirs.includes(n.toUpperCase()));
      if (clash) {
        return c.json({ error: 'so_name_taken', message: `"${clash}" is already ${other.display_name}'s name — one name can belong to one merchant only.` }, 409);
      }
    }
    global.so_names = kept;
  }
  if (Object.keys(global).length > 0) {
    global.updated_at = new Date().toISOString();
    const { error } = await sb.from('acc_acquirer_config').update(global).eq('code', code);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }

  const link: Record<string, unknown> = {};
  if (body.bankAccountCode !== undefined) link.bank_account_code = body.bankAccountCode || null;
  if (body.transitAccountCode !== undefined) link.transit_account_code = String(body.transitAccountCode || '326-0000');
  /* MERCHANT_FEE_ACCOUNT, not a literal repeated twice. 930-0000 was the seed
     default until 2026-09-09, when the owner's AutoCount chart turned out to
     have deactivated it — every settlement confirm refused with 'account
     930-0000 is deactivated' (migration 20260910T0147). */
  if (body.feeAccountCode !== undefined) link.fee_account_code = String(body.feeAccountCode || MERCHANT_FEE_ACCOUNT);
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

const isClearingCode = (code: string): boolean => /^32[67]-/.test(code);

export const settlementMaintenance = guard(async (c) => {
  const sb = c.get('supabase');

  /* EVERY company he may maintain, in ONE answer — the screen is a matrix, not
     a company at a time (owner, 2026-08-18: 我应该 overall maintenance table，左
     手边是 merchant、bank，上面 header 是公司，这个公司有就 tick). */
  const granted = allowedCompanyIds(c);
  const all = (c.get('companies') as Array<{ id: number; code: string; name: string }> | undefined) ?? [];
  const companies = all.filter((co) => granted === undefined || granted.includes(Number(co.id)));
  if (companies.length === 0) {
    const co = requireActiveCompanyId(c);
    if (!co.ok) return c.json(co.refusal, 409);
    companies.push({ id: co.companyId, code: String(co.companyId), name: `Company ${co.companyId}` });
  }
  const ids = companies.map((co) => Number(co.id));

  const { data: cfgRaw, error: cErr } = await sb.from('acc_acquirer_config')
    .select('code, display_name, statement_format, has_unique_ref, fee_method, date_tolerance_days, column_map, is_active, so_names')
    .order('code');
  if (cErr) return c.json({ error: 'load_failed', reason: cErr.message }, 500);

  const { data: linkRaw, error: lErr } = await sb.from('acc_company_acquirers')
    .select('company_id, acquirer_code, transit_account_code, fee_account_code, bank_account_code, is_active')
    .in('company_id', ids);
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const linkOf = new Map(((linkRaw ?? []) as Array<Record<string, any>>)
    .map((l) => [`${Number(l.company_id)}:${String(l.acquirer_code)}`, l]));

  const { data: bankRaw, error: bErr } = await sb.from('accounts')
    .select('company_id, account_code, account_name, is_active')
    .in('company_id', ids).eq('acc_money', true).order('account_code');
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  const bankRows = (bankRaw ?? []) as Array<Record<string, any>>;

  /* Every company's CLEARING accounts — where a machine's card money sits
     before the payout (owner 2026-09-07: 我想要拆账户 — one per bank, so the
     screen must offer them). The 326-/327- codes: card and online clearing;
     not money, so the payout picker above never shows them. */
  const { data: clearRaw, error: clErr } = await sb.from('accounts')
    .select('company_id, account_code, account_name')
    .in('company_id', ids).eq('acc_money', false).eq('is_active', true).order('account_code');
  if (clErr) return c.json({ error: 'load_failed', reason: clErr.message }, 500);
  const clearings: Record<string, Array<{ account_code: string; account_name: string }>> = {};
  for (const id of ids) clearings[String(id)] = [];
  for (const r of (clearRaw ?? []) as Array<Record<string, any>>) {
    if (!isClearingCode(String(r.account_code))) continue;
    clearings[String(Number(r.company_id))]?.push({ account_code: String(r.account_code), account_name: String(r.account_name ?? r.account_code) });
  }

  /* Every company's EXPENSE accounts a merchant fee could be booked to.
     Offered because it had to be a migration once already: the fee account was
     seeded at 930-0000, the AutoCount chart deactivated that code, and every
     settlement confirm in both companies refused — with no way to repoint it
     from a screen (docs/bugs/0762).

     ACTIVE LEAVES ONLY, the same two properties the posting gate checks, so a
     code offered here cannot be one the gate will refuse. A header account
     (one with children) never appears. */
  const { data: feeRaw, error: fErr } = await sb.from('accounts')
    .select('company_id, account_code, account_name, parent_code')
    .in('company_id', ids).eq('account_type', 'EXPENSE').eq('is_active', true)
    .order('account_code');
  if (fErr) return c.json({ error: 'load_failed', reason: fErr.message }, 500);
  const feeRows = (feeRaw ?? []) as Array<Record<string, any>>;
  const hasChild = new Set(
    feeRows.filter((r) => r.parent_code).map((r) => `${Number(r.company_id)}:${String(r.parent_code)}`),
  );
  const feeAccounts: Record<string, Array<{ account_code: string; account_name: string }>> = {};
  for (const id of ids) feeAccounts[String(id)] = [];
  for (const r of feeRows) {
    const co = Number(r.company_id);
    if (hasChild.has(`${co}:${String(r.account_code)}`)) continue;
    feeAccounts[String(co)]?.push({
      account_code: String(r.account_code),
      account_name: String(r.account_name ?? r.account_code),
    });
  }

  const merchants = ((cfgRaw ?? []) as Array<Record<string, any>>).map((g) => {
    const byCompany: Record<string, { enabled: boolean; linked: boolean; bankAccountCode: string | null; transitAccountCode: string | null; feeAccountCode: string | null }> = {};
    for (const id of ids) {
      const link = linkOf.get(`${id}:${String(g.code)}`);
      byCompany[String(id)] = {
        enabled: link ? link.is_active !== false : false,
        linked: Boolean(link),
        bankAccountCode: link?.bank_account_code ?? null,
        transitAccountCode: link?.transit_account_code ?? null,
        feeAccountCode: link?.fee_account_code ?? null,
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
      so_names: Array.isArray(g.so_names) ? g.so_names : [],
      ready: Boolean(g.statement_format && g.fee_method && g.column_map?.date && g.column_map?.gross),
      autoMatchable: g.has_unique_ref === true,
      byCompany,
    };
  });

  const codes = [...new Set(bankRows.map((b) => String(b.account_code)))].sort();
  const banks = codes.map((code) => {
    const byCompany: Record<string, { inChart: boolean; enabled: boolean; usedBy: string[] }> = {};
    for (const id of ids) {
      const row = bankRows.find((b) => Number(b.company_id) === id && String(b.account_code) === code);
      byCompany[String(id)] = {
        inChart: Boolean(row),
        enabled: Boolean(row) && row!.is_active !== false,
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

  return c.json({ companies, merchants, banks, clearings, feeAccounts });
});

/* POST /rematch — decide one merchant's OPEN report lines again, for one
   company (acc/settlement-rematch). Setup calls it after a merchant's matching
   rule changes — its other names, its drift days, its unique reference — once
   per company that uses the merchant: the rule is shared, the reports are each
   company's own (owner 2026-10-21: 已经上传的报告也重新对一次). The company is
   named like the maintenance writes name it, and the grant is re-checked. */
export const settlementRematch = guard(async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const target = maintenanceCompany(c, body.companyId);
  if (!target.ok) return c.json(target.refusal, 409);
  const code = String(body.acquirerCode ?? '').trim();
  if (!code) return c.json({ error: 'no_merchant', message: 'Which merchant?' }, 400);
  const r = await rematchOpenLines(c.get('supabase'), target.companyId, code);
  if (!r.ok) return c.json({ error: 'rematch_failed', message: `${code} was not matched again: ${r.reason}`.slice(0, 190) }, 500);
  return c.json(r);
});


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
  /* The clearing account (owner 2026-09-07: one per bank). Must be one of THIS
     company's live 326-/327- accounts — the posting rules read it blind, so a
     typo here would book card money onto an address that is not a clearing
     account at all. Blank = back to the generic 326-0000. */
  if (body.transitAccountCode !== undefined) {
    const code = String(body.transitAccountCode ?? '').trim() || '326-0000';
    if (!isClearingCode(code)) return c.json({ error: 'bad_clearing_account', message: `${code} is not a clearing account (326-/327-).` }, 400);
    const { data: acct, error: aErr } = await sb.from('accounts')
      .select('account_code, is_active, acc_money').eq('company_id', companyId).eq('account_code', code).maybeSingle();
    if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
    const a = acct as { is_active?: boolean; acc_money?: boolean } | null;
    if (!a || a.is_active === false || a.acc_money === true) {
      return c.json({ error: 'bad_clearing_account', message: `${code} is not a live clearing account in this company's chart.` }, 400);
    }
    patch.transit_account_code = code;
  }

  /* THE FEE ACCOUNT, which had to be a migration once already (docs/bugs/0762):
     it was seeded at 930-0000, the AutoCount chart deactivated that code, and
     every settlement confirm in both companies refused with no way to repoint
     it from a screen.

     Validated by the SAME three properties the posting gate checks — an EXPENSE,
     ACTIVE, and a LEAF in this company's own chart. Anything else is refused
     here, by name, rather than accepted and left to fail at the moment somebody
     confirms a statement. Blank returns it to the default. */
  if (body.feeAccountCode !== undefined) {
    const fee = String(body.feeAccountCode ?? '').trim() || MERCHANT_FEE_ACCOUNT;
    const { data: acct, error: aErr } = await sb.from('accounts')
      .select('account_code, account_type, is_active').eq('company_id', companyId).eq('account_code', fee).maybeSingle();
    if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
    const a = acct as { account_type?: string; is_active?: boolean } | null;
    if (!a) {
      return c.json({ error: 'bad_fee_account', message: `${fee} is not in this company's chart.` }, 400);
    }
    if (a.is_active === false) {
      return c.json({ error: 'bad_fee_account', message: `${fee} is switched off in this company's chart, so nothing could be booked to it.` }, 400);
    }
    if (a.account_type !== 'EXPENSE') {
      return c.json({ error: 'bad_fee_account', message: `${fee} is ${String(a.account_type ?? 'not an expense account')} — a merchant fee is an expense.` }, 400);
    }
    const { data: kids, error: kErr } = await sb.from('accounts')
      .select('account_code').eq('company_id', companyId).eq('parent_code', fee).limit(1);
    if (kErr) return c.json({ error: 'load_failed', reason: kErr.message }, 500);
    if ((kids ?? []).length > 0) {
      return c.json({ error: 'bad_fee_account', message: `${fee} has sub-accounts, so nothing posts to it directly. Pick one of them.` }, 400);
    }
    patch.fee_account_code = fee;
  }

  if (!existing) {
    const { error } = await sb.from('acc_company_acquirers').insert({
      company_id: companyId,
      acquirer_code: code,
      transit_account_code: (patch.transit_account_code as string | undefined) ?? '326-0000',
      fee_account_code: (patch.fee_account_code as string | undefined) ?? MERCHANT_FEE_ACCOUNT,
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
    statementMonth: /^\d{4}-\d{2}$/.test(String(body.statementMonth ?? '')) ? String(body.statementMonth) : null,
    total_net_label: (acq.acquirer as { total_net_label?: string | null }).total_net_label ?? null,
    summary_totals: (acq.acquirer as { summary_totals?: { rowLabel: string; fee?: string; net?: string } | null }).summary_totals ?? null,
  }, content);
  if (!parsed.ok) return c.json({ error: 'unreadable_statement', message: parsed.reason }, 400);

  const fileHash = await sha256Hex(content);
  const gate = await clearOrphanBatch(sb, co.companyId, fileHash);
  if (!gate.ok) return c.json({ error: 'load_failed', reason: gate.reason }, 500);
  if (gate.state === 'duplicate') {
    return c.json({ error: 'already_uploaded', message: 'This exact file has already been uploaded. Open the existing batch instead of loading it twice.' }, 409);
  }
  /* A TRANSACTION ALREADY ON ANOTHER REPORT (docs/bugs/0823). The gate above
     knows the same FILE; this knows the same LINE — Maybank prints an Amex
     card sold on an EzyPay instalment on both the EP41 and the T41AX report
     of the day, and the bank pays it once. Such a line is left out of this
     batch, the reply names the report it is on, and a file with nothing new
     is refused before a batch head is written. */
  const dedupe = await linesAlreadyOnFile(sb, co.companyId, acq.acquirer, parsed);
  if (!dedupe.ok) return c.json({ error: 'load_failed', reason: dedupe.reason }, 500);
  if (dedupe.kept.rows.length === 0 && dedupe.alreadyOn.length > 0) {
    const n = dedupe.alreadyOn.length;
    const where = [...new Set(dedupe.alreadyOn.map((a) => a.fileName ?? `batch ${a.batchId}`))].join(', ');
    return c.json({
      error: 'already_on_report',
      alreadyOnReport: n,
      alreadyOnReportDetail: dedupe.alreadyOn,
      message: `This file was not loaded: its ${n === 1 ? 'transaction is' : `${n} transactions are`} already on ${where}. `
        + 'The bank pays a card transaction once — open that batch instead.',
    }, 409);
  }
  const stmt = dedupe.kept;
  /* The head is what the acquirer owes THROUGH ITS CLEARING ACCOUNT: the card
     lines. A DuitNow QR line's money reached the bank by its sale (owner
     2026-11-09: 0000PP 是 qr direct 去 bank 的，不算卡机的) — it stays a line of
     the report, matched to that sale, and never becomes money owed. */
  const head = cardTotalsOf(stmt);
  const qrRows = stmt.rows.filter((r) => r.channel === 'QR');
  const { data: batchRow, error: batchErr } = await sb.from('acc_settlement_batches').insert({
    company_id: co.companyId,
    acquirer_code: acquirerCode,
    file_name: fileName,
    file_hash: fileHash,
    period_from: stmt.periodFrom,
    period_to: stmt.periodTo,
    row_count: stmt.rows.length,
    gross_sen: head.grossSen,
    fee_sen: head.feeSen,
    net_sen: head.netSen,
    stated_net_sen: head.statedNetSen,
    adjustment_sen: stmt.adjustmentSen,
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
  const abandonBatch = async () => {
    await sb.from('acc_settlement_batches').delete().eq('id', batchId).eq('company_id', co.companyId);
  };

  const [candidates, settled, online] = await Promise.all([
    /* The file's own references travel with the request: a payment carrying an
       exact reference must be found whatever its date (docs/bugs/0760). */
    loadPaymentCandidates(sb, co.companyId, acq.acquirer, stmt.periodFrom, stmt.periodTo,
      stmt.rows.map((r) => r.ref).filter((r): r is string => typeof r === 'string' && r !== '')),
    loadSettledKeys(sb, co.companyId),
    onlinePoolFor(sb, co.companyId, acq.acquirer, stmt.periodFrom, stmt.periodTo, qrRows.length > 0),
  ]);
  if (!candidates.ok) { await abandonBatch(); return c.json({ error: 'load_failed', reason: candidates.reason }, 500); }
  if (!settled.ok) { await abandonBatch(); return c.json({ error: 'load_failed', reason: settled.reason }, 500); }
  if (!online.ok) { await abandonBatch(); return c.json({ error: 'load_failed', reason: online.reason }, 500); }

  const decisions = matchStatement(
    { code: acq.acquirer.code, has_unique_ref: acq.acquirer.has_unique_ref, date_tolerance_days: acq.acquirer.date_tolerance_days },
    stmt.rows, candidates.payments, settled.keys, online.payments,
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
      ...(d.row.channel === 'QR' ? { channel: 'QR' } : {}),
    })),
  ).select('id, line_no');
  if (rowsErr) { await abandonBatch(); return c.json({ error: 'save_failed', reason: rowsErr.message }, 500); }

  const idByLine = new Map(((writtenRaw ?? []) as Array<{ id: number; line_no: number }>).map((r) => [r.line_no, r.id]));
  /* THE INSERT SUCCEEDED AND TOLD US NOTHING BACK.
     On prod, nine reference-matched lines were stored MATCHED and NOT ONE link
     row was written, with no error anywhere: the rows insert reported no error,
     its returning-select came back empty, so this map was empty, so every link
     below hit its `continue` and was skipped in silence (docs/bugs/0760).
     A count that cannot be reconciled to the decisions is the one thing that
     would have said so, so it is checked here rather than trusted. */
  if (idByLine.size !== decisions.length) {
    await abandonBatch();
    return c.json({
      error: 'save_failed',
      reason: `wrote ${decisions.length} line(s) but got ${idByLine.size} id(s) back`,
      message: 'The statement\'s lines saved but did not report their ids, so their payments could not be'
        + ' linked. Nothing was kept — upload the file again.',
    }, 500);
  }
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
    skippedLines: stmt.skippedLines,
    /* Lines already on another report of this acquirer, left out of this
       batch, each with the report and line they are on (docs/bugs/0823). */
    alreadyOnReport: dedupe.alreadyOn.length,
    alreadyOnReportDetail: dedupe.alreadyOn,
    statedNetSen: head.statedNetSen,
    adjustmentSen: stmt.adjustmentSen,
    grossSen: head.grossSen,
    feeSen: head.feeSen,
    netSen: head.netSen,
    qrLines: qrRows.length,
    qrSen: qrRows.reduce((s, r) => s + r.grossSen, 0),
    periodFrom: stmt.periodFrom,
    periodTo: stmt.periodTo,
    buckets: { MATCHED: autoMatched, NEEDS_CONFIRM: count('NEEDS_CONFIRM') + (count('MATCHED') - autoMatched), UNMATCHED: count('UNMATCHED'), IGNORED: 0 },
  });
});

const BATCH_COLUMNS =
  'id, acquirer_code, file_name, period_from, period_to, row_count, gross_sen, fee_sen, net_sen, stated_net_sen, adjustment_sen, adjustment_je_no, status, created_at';

const payableOf = (b: { stated_net_sen?: number | null; net_sen?: number | null }) =>
  Number(b.stated_net_sen ?? b.net_sen ?? 0);

/** What the bank or acquirer KEPT off each statement's payout: charges booked
    on an advice day (docs/bugs/0787) and charges kept off a credit, carried on
    the receipt rows the caller already read (owner 2026-09-30). A read that
    fails is a refusal, not "nothing was kept". */
async function chargedByBatchOf(
  sb: any, companyId: number, receipts: Array<{ batch_id: number; charge_sen?: number | null }>,
): Promise<{ ok: true; byBatch: Map<number, number> } | { ok: false; reason: string }> {
  const byBatch = new Map<number, number>();
  const add = (id: number, sen: number) => { if (sen !== 0) byBatch.set(id, (byBatch.get(id) ?? 0) + sen); };
  for (const r of receipts) add(Number(r.batch_id), Number(r.charge_sen ?? 0));
  const { data, error } = await paginateAll<{ batch_id: number | null; charge_sen: number | null }>((f, t) => sb
    .from('acc_settlement_payout_batches').select('batch_id, charge_sen')
    .eq('company_id', companyId).order('id').range(f, t));
  if (error) return { ok: false, reason: error.message };
  for (const d of data ?? []) {
    if (d.batch_id != null) add(Number(d.batch_id), Number(d.charge_sen ?? 0));
  }
  return { ok: true, byBatch };
}

export const settlementBatches = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<Record<string, any>>((f, t) => sb
    .from('acc_settlement_batches').select(`${BATCH_COLUMNS}, uploaded_by`)
    .eq('company_id', co.companyId)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).range(f, t));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const { data: recRaw, error: rcErr } = await paginateAll<{ batch_id: number; received_on: string; amount_sen: number; charge_sen?: number | null }>((f, t) => sb
    .from('acc_settlement_receipts').select('batch_id, received_on, amount_sen, charge_sen')
    .eq('company_id', co.companyId).order('id').range(f, t));
  if (rcErr) return c.json({ error: 'load_failed', reason: rcErr.message }, 500);
  /* What the bank or acquirer KEPT — booked on an advice day, or off a credit
     (owner 2026-09-30) — settles the statement the way a credit does. */
  const charged = await chargedByBatchOf(sb, co.companyId, (recRaw ?? []) as Array<{ batch_id: number; charge_sen?: number | null }>);
  if (!charged.ok) return c.json({ error: 'load_failed', reason: charged.reason }, 500);

  const { data: rowTally, error: rtErr } = await paginateAll<{ batch_id: number; bucket: string; confirmed_at: string | null; channel?: string | null; gross_sen?: number | null }>((f, t) => sb
    .from('acc_settlement_rows').select('batch_id, bucket, confirmed_at, channel, gross_sen')
    .eq('company_id', co.companyId).order('id').range(f, t));
  if (rtErr) return c.json({ error: 'load_failed', reason: rtErr.message }, 500);
  const reconciled = new Map<number, { confirmed: number; open: number; toConfirm: number; toChoose: number; noRecord: number; qr: number; qrSen: number }>();
  for (const r of (rowTally ?? []) as Array<{ batch_id: number; bucket: string; confirmed_at: string | null; channel?: string | null; gross_sen?: number | null }>) {
    const at = reconciled.get(Number(r.batch_id)) ?? { confirmed: 0, open: 0, toConfirm: 0, toChoose: 0, noRecord: 0, qr: 0, qrSen: 0 };
    /* The QR money a report carries (owner 2026-11-09) — in the bank by its
       sales, so not part of what the report is owed; said beside it. */
    if (r.channel === 'QR') { at.qr += 1; at.qrSen += Number(r.gross_sen ?? 0); }
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
    const done = reconciled.get(Number(b.id)) ?? { confirmed: 0, open: 0, toConfirm: 0, toChoose: 0, noRecord: 0, qr: 0, qrSen: 0 };
    const payable = payableOf(b);
    const kept = charged.byBatch.get(Number(b.id)) ?? 0;
    return {
      ...b,
      qr_count: done.qr,
      qr_gross_sen: done.qrSen,
      confirmed_count: done.confirmed,
      open_count: done.open,
      to_confirm_count: done.toConfirm,
      to_choose_count: done.toChoose,
      no_record_count: done.noRecord,
      received_sen: at.sen,
      charged_sen: kept,
      receipt_count: at.count,
      received_on: at.sen + kept === payable && payable !== 0 ? at.lastOn : null,
      outstanding_sen: payable - at.sen - kept,
    };
  });
  return c.json({ batches });
});

export const settlementBatchDetail = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const batchId = Number(c.req.param('id'));
  if (!Number.isInteger(batchId)) return c.json({ error: 'bad_id' }, 400);
  const sb = c.get('supabase');

  const [batchRes, paid, rowsRes] = await Promise.all([
    sb.from('acc_settlement_batches')
      .select(BATCH_COLUMNS)
      .eq('id', batchId).eq('company_id', co.companyId).maybeSingle(),
    loadBatchReceipts(sb, co.companyId, batchId),
    sb.from('acc_settlement_rows')
      .select('id, line_no, txn_date, ref, gross_sen, fee_sen, net_sen, bucket, match_reason, confirmed_at, posted_je_no, notes, matched_with_row_id, not_this, channel, sold_by_company_id')
      .eq('batch_id', batchId).eq('company_id', co.companyId).order('line_no'),
  ]);
  const { data: batch, error: bErr } = batchRes;
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  if (!batch) return c.json({ error: 'not_found' }, 404);
  const b = batch as { acquirer_code: string; period_from: string; period_to: string };

  if (!paid.ok) return c.json({ error: 'load_failed', reason: paid.reason }, 500);

  const { data: rowsRaw, error: rErr } = rowsRes;
  if (rErr) return c.json({ error: 'load_failed', reason: rErr.message }, 500);
  const stored = (rowsRaw ?? []) as StoredRow[];

  const linksP = chunkIn<Record<string, any>, number>(stored.map((r) => Number(r.id)), (batch, f, t) => sb
    .from('acc_settlement_matches').select('settlement_row_id, payment_source, payment_id, doc_no, amount_sen')
    .eq('company_id', co.companyId).in('settlement_row_id', batch).order('id').range(f, t));
  const rolesP = resolveRoles(sb, co.companyId);

  const acq = await loadAcquirer(sb, co.companyId, b.acquirer_code);
  if (!acq.ok) return c.json({ error: 'acquirer_unavailable', message: acq.reason }, 400);
  const bankP = rolesP.then(async (roles) => {
    const code = acq.acquirer.bank_account_code || roles.BANK_DEFAULT;
    const { data, error } = await sb.from('accounts')
      .select('account_code, account_name').eq('company_id', co.companyId).eq('account_code', code).maybeSingle();
    return { code, data, error };
  });
  const [candidates, online] = await Promise.all([
    /* The stored lines' own references travel with the request, so a payment
       carrying an exact reference is found whatever its date — the four PBB
       lines that read "No payment recorded near …" while their payment sat in
       the ERP, keyed a week late (docs/bugs/0760). */
    loadPaymentCandidates(sb, co.companyId, acq.acquirer, b.period_from, b.period_to,
      stored.map((r) => r.ref).filter((r): r is string => typeof r === 'string' && r !== '')),
    /* A report's QR lines are matched to Online sales (owner 2026-11-09). */
    onlinePoolFor(sb, co.companyId, acq.acquirer, b.period_from, b.period_to, stored.some((r) => r.channel === 'QR')),
  ]);
  if (!candidates.ok) return c.json({ error: 'load_failed', reason: candidates.reason }, 500);
  if (!online.ok) return c.json({ error: 'load_failed', reason: online.reason }, 500);
  const everyPayment = [...candidates.payments, ...online.payments];
  const settled = await loadSettledKeysFor(sb, co.companyId, everyPayment);
  if (!settled.ok) return c.json({ error: 'load_failed', reason: settled.reason }, 500);

  const { data: linkRaw, error: lErr } = await linksP;
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const linksByRow = new Map<number, Array<Record<string, unknown>>>();
  for (const l of linkRaw) {
    const list = linksByRow.get(Number(l.settlement_row_id));
    if (list) list.push(l);
    else linksByRow.set(Number(l.settlement_row_id), [l]);
  }

  const open = stored.filter((r) => !r.confirmed_at && r.bucket !== 'IGNORED');
  /* THE OPEN LINES' LINKS FOLLOW THEIR PAYMENT (docs/bugs/0833): a payment
     Finance corrected after the upload is read back at its current amount the
     moment the report is opened — no button — and what moved is named in the
     reply. Confirmed lines are the ledger's and are left alone. Read after the
     candidates so the window's payments need no second read. */
  const openLinks = open.flatMap((r) => (linksByRow.get(r.id) ?? []) as LinkRow[]);
  const refresh = await refreshUnconfirmedLinks(sb, {
    companyId: co.companyId,
    links: openLinks,
    known: new Map(everyPayment.map((p) => [`${p.source}:${p.id}`, { amountSen: Number(p.amountSen), docNo: p.docNo || null }])),
  });
  if (!refresh.ok) return c.json({ error: 'load_failed', reason: refresh.reason }, 500);
  const needsAHuman = open.filter((r) => (linksByRow.get(r.id) ?? []).length === 0);
  const suggestions = matchStatement(
    { code: acq.acquirer.code, has_unique_ref: acq.acquirer.has_unique_ref, date_tolerance_days: acq.acquirer.date_tolerance_days },
    needsAHuman.map((r) => ({
      lineNo: r.line_no, txnDate: String(r.txn_date).slice(0, 10), ref: r.ref, grossSen: Number(r.gross_sen), feeSen: Number(r.fee_sen), netSen: Number(r.net_sen),
      ...(r.channel === 'QR' ? { channel: 'QR' as const } : {}),
    })),
    candidates.payments,
    settled.keys,
    online.payments,
  );
  const byLine = new Map(suggestions.map((d) => [d.row.lineNo, d]));

  const paymentOf = new Map(everyPayment.map((p) => [`${p.source}:${p.id}`, p]));

  /* LINES MATCHED TOGETHER (owner 2026-11-03, option B): the payments are
     linked once, to the group's lead; every line of the group shows them, and
     names the lines it was matched with. */
  const leadOf = (r: StoredRow): number => (r.matched_with_row_id == null ? Number(r.id) : Number(r.matched_with_row_id));
  const groupOf = new Map<number, StoredRow[]>();
  for (const r of stored) {
    if (r.matched_with_row_id == null) continue;
    const lead = stored.find((x) => Number(x.id) === leadOf(r));
    if (!lead) continue;
    if (!groupOf.has(Number(lead.id))) groupOf.set(Number(lead.id), [lead]);
    groupOf.get(Number(lead.id))!.push(r);
  }

  const rows = stored.map((r) => {
    const s = byLine.get(r.line_no);
    const group = groupOf.get(leadOf(r));
    const notThis = new Set(notThisOf(r.not_this));
    const keep = <P extends { source: string; id: string }>(list: P[]): P[] => list.filter((p) => !notThis.has(`${p.source}:${p.id}`));
    /* Whatever the matcher put forward — its match, its guess (owner 2026-11-10)
       or the payments it offered — a turned-down one makes the clue say so, not
       still call it "the only payment of this amount". */
    const putForward = [...(s?.matched ?? []), ...(s?.suggested ?? []), ...(s?.candidates ?? [])];
    const turnedDown = [...new Map(putForward.filter((p) => notThis.has(`${p.source}:${p.id}`)).map((p) => [`${p.source}:${p.id}`, p])).values()];
    const turnedDownIds = new Set([...notThis].map((k) => k.slice(k.indexOf(':') + 1)));
    return {
      ...r,
      txn_date: String(r.txn_date).slice(0, 10),
      matched_with: group
        ? {
          leadRowId: leadOf(r),
          lines: group.map((g) => ({ rowId: Number(g.id), lineNo: Number(g.line_no), grossSen: Number(g.gross_sen) })),
          grossSen: group.reduce((t, g) => t + Number(g.gross_sen), 0),
        }
        : null,
      /* The linked rows carry a document number and an amount. The operator is
         reading a RECONCILIATION, so the sale itself belongs here too — who it
         was, when it was paid, what code the till recorded (owner: 我希望他是显示
         transaction detail 和 sales order detail, 而不是 document 罢了). */
      linked: (linksByRow.get(leadOf(r)) ?? []).map((l) => {
        const p = paymentOf.get(`${String(l.payment_source)}:${String(l.payment_id)}`);
        return {
          ...l,
          doc_no: l.doc_no ?? p?.docNo ?? null,
          paid_on: p?.paidOn ?? null,
          customer_name: p?.customerName ?? null,
          approval_code: p?.approvalCode ?? null,
          salesperson: p?.salesperson ?? null,
          account_sheet: p?.accountSheet ?? null,
        };
      }),
      /* A REF-MATCHED LINE CARRIES ITS PAYMENT IN `matched`, NOT `candidates`.
         matchStatement empties candidates/suggested for that bucket on purpose
         — there is nothing to choose, it is decided — and this map used to read
         only the two empty fields. So a line the matcher had answered arrived
         with no payment at all, and when its link had not persisted either the
         screen ran the last branch it has: "No payment in the ERP explains this
         money", directly under the clue naming the very sale it matched. The
         owner saw both sentences at once (2026-09-09), and pressing Confirm
         sent an empty selection, which the server rightly refused.

         Falling back to `matched` costs nothing when the link IS there — a
         linked line is not recomputed at all — and is the whole answer when it
         is not. Pre-ticked, still his to confirm: nothing posts until he
         presses. */
      candidates: keep((s?.candidates.length ? s.candidates : s?.matched) ?? []),
      comboHints: (s?.comboHints ?? []).filter((combo) => !combo.some((id) => turnedDownIds.has(String(id)))),
      suggested: keep((s?.suggested.length ? s.suggested : s?.matched) ?? []),
      clue: turnedDown.length > 0
        ? `Not ${turnedDown.map((p) => p.docNo || p.id).join(', ')} — you said so. Choose the sale, or find it.`
        : s?.clue ?? r.notes,
    };
  });

  const tally: Record<MatchBucket, number> = { MATCHED: 0, NEEDS_CONFIRM: 0, UNMATCHED: 0, IGNORED: 0 };
  for (const r of stored) {
    const b = r.bucket as MatchBucket;
    tally[b] = (tally[b] ?? 0) + 1;
  }

  const { code: bankCode, data: bankRow, error: bankErr } = await bankP;
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
    refreshedLinks: refresh.refreshed,
  });
});


/* THE BANK FOLLOWS THE MERCHANT SIDE (owner 2026-11-17: 我只要对一边). Once a
   line is confirmed, a bank credit this report now fully accounts for matches
   itself (accounting-bank applyMerchantAgreedMatches): a ready QR credit, or a
   payout of exactly what the report is still owed now that every line of it is
   confirmed. Looked for around the report's first trading day. */
type Sb = Parameters<typeof bankFollowsMerchant>[0];
export async function bankFollows(sb: Sb, companyId: number, batchIds: number[], actor: string | null): Promise<BankFollows> {
  const ids = [...new Set(batchIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return { matched: 0, jeNos: [], left: [] };
  const { data, error } = await sb.from('acc_settlement_batches').select('period_from').eq('company_id', companyId).in('id', ids);
  if (error) return { error: error.message };
  const from = ((data ?? []) as Array<{ period_from: string | null }>).map((b) => String(b.period_from ?? '').slice(0, 10)).filter(Boolean).sort()[0] ?? null;
  return bankFollowsMerchant(sb, companyId, from, actor);
}
async function batchesOfRows(sb: Sb, companyId: number, rowIds: number[]): Promise<number[]> {
  if (rowIds.length === 0) return [];
  const { data, error } = await sb.from('acc_settlement_rows').select('batch_id').eq('company_id', companyId).in('id', rowIds);
  if (error) return [];
  return [...new Set(((data ?? []) as Array<{ batch_id: number }>).map((r) => Number(r.batch_id)))];
}

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
      : ['amount_mismatch', 'no_payments', 'ignored', 'payment_already_settled', 'payment_not_found', 'not_card_payment'].includes(r.status) ? 409
      : 500;
    return c.json({ error: r.status, message: r.reason }, status);
  }
  const sb = c.get('supabase');
  const actor = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
  return c.json({ ...r, bank: await bankFollows(sb, co.companyId, await batchesOfRows(sb, co.companyId, [rowId]), actor) });
});

/* POST /rows/confirm-together — several lines of one report confirmed against
   several payments (owner 2026-11-03, option B: the customer swiped twice for
   two orders, and only the totals agree). `rowIds` are the lines; the sum of
   `payments` must be the sum of their gross, to the sen. */
export const settlementConfirmGroup = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const rowIds = Array.isArray(body.rowIds) ? body.rowIds.map(Number).filter((n: number) => Number.isInteger(n)) : [];
  const payments = Array.isArray(body.payments) ? body.payments : [];

  const r = await confirmSettlementGroup(c.get('supabase'), {
    companyId: co.companyId,
    rowIds,
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
      : r.status === 'group_too_small' ? 400
      : ['amount_mismatch', 'no_payments', 'ignored', 'already_confirmed', 'different_reports', 'line_already_matched', 'payment_already_settled', 'payment_not_found', 'not_card_payment'].includes(r.status) ? 409
      : 500;
    return c.json({ error: r.status, message: r.reason }, status);
  }
  const sb = c.get('supabase');
  const actor = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
  return c.json({ ...r, bank: await bankFollows(sb, co.companyId, await batchesOfRows(sb, co.companyId, rowIds), actor) });
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

  const { data: batchRaw, error: bErr } = await sb.from('acc_settlement_batches')
    .select('id, acquirer_code, period_from, period_to')
    .eq('id', batchId).eq('company_id', co.companyId).maybeSingle();
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  if (!batchRaw) return c.json({ error: 'not_found' }, 404);
  const b = batchRaw as { acquirer_code: string; period_from: string; period_to: string };

  const { data: rowsRaw, error } = await sb.from('acc_settlement_rows')
    .select('id, line_no, txn_date, ref, gross_sen, fee_sen, net_sen, bucket, confirmed_at, not_this')
    .eq('batch_id', batchId).eq('company_id', co.companyId);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const stored = (rowsRaw ?? []) as StoredRow[];
  const pending = stored.filter((r) => r.bucket === 'MATCHED' && !r.confirmed_at);

  const { data: linkRaw, error: lErr } = await chunkIn<Record<string, any>, number>(pending.map((r) => Number(r.id)), (batch, f, t) => sb
    .from('acc_settlement_matches').select('settlement_row_id, payment_source, payment_id, doc_no, amount_sen')
    .eq('company_id', co.companyId).in('settlement_row_id', batch).order('id').range(f, t));
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const linksByRow = new Map<number, Array<Record<string, any>>>();
  for (const l of linkRaw) {
    const list = linksByRow.get(Number(l.settlement_row_id));
    if (list) list.push(l);
    else linksByRow.set(Number(l.settlement_row_id), [l]);
  }

  /* A MATCHED ROW WHOSE LINK IS MISSING STILL KNOWS ITS PAYMENT.
     This button reads the link table, and on prod nine reference-matched lines
     had none: the upload's link insert was skipped in silence (docs/bugs/0760),
     so every one of them sent an empty selection and was refused —
     "Posted 0. 9 could not be" over nine lines whose payment the screen was by
     then showing. The detail view already falls back to the matcher; this is
     the same fallback on the bulk path, and confirming writes the link, so the
     data heals itself as he works.

     ONLY `matched`, never `suggested`. This button's promise is "post every
     line the unique reference already matched", and nobody is reading each line
     — a suggestion needs the eyes the detail screen gives it. Recomputed only
     for rows that have no link, so a human's stored decision is never
     overridden. */
  const unlinked = pending.filter((r) => (linksByRow.get(r.id) ?? []).length === 0);
  const rescued = new Map<number, Array<{ source: 'SOPAY' | 'SIPAY'; id: string; docNo: string | null; amountSen: number }>>();
  if (unlinked.length > 0) {
    const acq = await loadAcquirer(sb, co.companyId, b.acquirer_code);
    if (!acq.ok) return c.json({ error: 'acquirer_unavailable', message: acq.reason }, 400);
    const [cands, settled] = await Promise.all([
      loadPaymentCandidates(sb, co.companyId, acq.acquirer, b.period_from, b.period_to,
        stored.map((r) => r.ref).filter((r): r is string => typeof r === 'string' && r !== '')),
      loadSettledKeys(sb, co.companyId),
    ]);
    if (!cands.ok) return c.json({ error: 'load_failed', reason: cands.reason }, 500);
    if (!settled.ok) return c.json({ error: 'load_failed', reason: settled.reason }, 500);

    const byLine = new Map(unlinked.map((r) => [r.line_no, r.id]));
    for (const d of matchStatement(
      { code: acq.acquirer.code, has_unique_ref: acq.acquirer.has_unique_ref, date_tolerance_days: acq.acquirer.date_tolerance_days },
      unlinked.map((r) => ({ lineNo: r.line_no, txnDate: String(r.txn_date).slice(0, 10), ref: r.ref, grossSen: Number(r.gross_sen), feeSen: Number(r.fee_sen), netSen: Number(r.net_sen) })),
      cands.payments,
      settled.keys,
    )) {
      if (d.bucket !== 'MATCHED' || d.matched.length === 0) continue;
      const rowId = byLine.get(d.row.lineNo);
      if (rowId == null) continue;
      const notThis = new Set(notThisOf(unlinked.find((r) => r.id === rowId)?.not_this));
      if (d.matched.some((p) => notThis.has(`${p.source}:${p.id}`))) continue;
      rescued.set(rowId, d.matched.map((p) => ({
        source: p.source, id: p.id, docNo: p.docNo, amountSen: p.amountSen,
      })));
    }
  }

  const userName = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
  let confirmed = 0;
  const failed: Array<{ rowId: number; reason: string }> = [];
  for (const row of pending) {
    const links = linksByRow.get(row.id) ?? [];
    const payments = links.length > 0
      ? links.map((l) => ({
        source: (l.payment_source === 'SIPAY' ? 'SIPAY' : 'SOPAY') as 'SOPAY' | 'SIPAY',
        id: String(l.payment_id),
        docNo: (l.doc_no ?? null) as string | null,
        amountSen: Number(l.amount_sen ?? 0),
      }))
      : rescued.get(row.id) ?? [];
    const r = await confirmSettlementRow(sb, {
      companyId: co.companyId,
      rowId: row.id,
      matchReason: 'ref',
      userName,
      payments,
    });
    if (r.ok) confirmed += 1;
    else failed.push({ rowId: row.id, reason: r.reason });
  }

  const charge = await postStatementCharge(sb, co.companyId, batchId);
  if (!charge.ok) failed.push({ rowId: 0, reason: `statement charge: ${charge.reason}` });

  return c.json({
    ok: true,
    attempted: pending.length,
    confirmed,
    failed,
    statementCharge: charge.ok ? { status: charge.status, ...(charge.jeNo ? { jeNo: charge.jeNo } : {}) } : null,
    bank: confirmed > 0 ? await bankFollows(sb, co.companyId, [batchId], userName) : { matched: 0, jeNos: [], left: [] },
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
  const amountGiven = body.amountSen !== undefined;
  if (amountGiven && (typeof body.amountSen !== 'number' || !Number.isInteger(body.amountSen))) {
    return c.json({ error: 'bad_amount', message: 'Could not read the amount of this credit. Type it as it reads on the bank statement, or leave it blank for the whole remaining amount.' }, 400);
  }

  const r = await postBatchReceipt(c.get('supabase'), co.companyId, batchId, {
    receivedOn,
    amountSen: amountGiven ? body.amountSen : null,
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

export const settlementReceiptUndo = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const receiptId = Number(c.req.param('id'));
  if (!Number.isInteger(receiptId)) return c.json({ error: 'bad_id' }, 400);

  const sb = c.get('supabase');

  /* THE BACK DOOR INTO A CLOSED MONTH, shut here (owner, 2026-09-08: 还有lock
     起来不可以随便碰).

     A credit booked FROM a bank statement carries `bank_line_id`, and reversing
     it from this side would undo an entry that a closed bank month has already
     counted and reported — the bank screen's own undo refuses, and without this
     the same act would simply be done through the other door. A credit typed by
     hand has no bank line and is none of the lock's business, which is why this
     is a guard on the LINK rather than on the receipt. */
  const { data: receiptRow, error: rErr } = await sb.from('acc_settlement_receipts')
    .select('bank_line_id').eq('id', receiptId).eq('company_id', co.companyId).maybeSingle();
  if (rErr) {
    return c.json({
      error: 'lock_check_failed',
      reason: rErr.message,
      message: 'Whether this credit belongs to a closed month could not be checked, so nothing was'
        + ' changed. Try again.',
    }, 500);
  }
  const bankLineId = (receiptRow as { bank_line_id?: number | null } | null)?.bank_line_id ?? null;
  if (bankLineId != null) {
    const where = await loadLineMonth(sb, co.companyId, Number(bankLineId));
    if (!where.ok) {
      return c.json({
        error: 'lock_check_failed',
        reason: where.reason,
        message: 'Whether this credit belongs to a closed month could not be checked, so nothing was'
          + ' changed. Try again.',
      }, 500);
    }
    if (where.found) {
      const held = await loadLiveMonthLock(sb, co.companyId, where.accountCode, where.month);
      if (!held.ok) {
        return c.json({
          error: 'lock_check_failed',
          reason: held.reason,
          message: 'Whether this credit belongs to a closed month could not be checked, so nothing was'
            + ' changed. Try again.',
        }, 500);
      }
      if (held.lock) {
        return c.json(lockedRefusal(held.lock, 'taking this credit back'), 409);
      }
    }
  }

  const r = await undoBatchReceipt(sb, co.companyId, receiptId);
  if (!r.ok) return c.json({ error: r.status, message: r.reason }, r.status === 'not_found' ? 404 : 500);
  return c.json(r);
});

export const settlementRowUnconfirm = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rowId = Number(c.req.param('id'));
  if (!Number.isInteger(rowId)) return c.json({ error: 'bad_id' }, 400);
  const sold = await unmarkSoldBy(c.get('supabase'), co.companyId, rowId);
  if (sold.ok) return c.json({ ok: true, ...(sold.jeNo ? { reversalJeNo: sold.jeNo } : {}) });
  if (sold.status !== 'not_sold_by') {
    const code = sold.status === 'not_found' ? 404 : sold.status === 'has_receipts' ? 409 : 500;
    return c.json({ error: sold.status, message: sold.reason }, code);
  }
  const r = await unconfirmSettlementRow(c.get('supabase'), co.companyId, rowId);
  if (!r.ok) {
    const code = r.status === 'not_found' ? 404
      : r.status === 'not_confirmed' || r.status === 'has_receipts' ? 409
      : 500;
    return c.json({ error: r.status, message: r.reason }, code);
  }
  return c.json({ ok: true, ...(r.jeNo ? { reversalJeNo: r.jeNo } : {}) });
});

/* POST /rows/:id/release — "Not this" (owner 2026-11-03, batch 3 d2): an
   unconfirmed line's match is released and the line goes back to be chosen;
   the payments it held are not offered to it again. Posts nothing.
   Body `{ payments?: ["SOPAY:<id>", …] }`: the system's GUESS the screen showed,
   for a line that holds no link (owner 2026-11-10). */
export const settlementReleaseRow = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rowId = Number(c.req.param('id'));
  if (!Number.isInteger(rowId)) return c.json({ error: 'bad_id' }, 400);
  let body: { payments?: unknown } = {};
  try { body = (await c.req.json()) ?? {}; } catch { body = {}; }
  const guessed = turnedDownKeysOf(body.payments);
  if (guessed === null) {
    return c.json({ error: 'bad_payments', message: `Name the payments as "SOPAY:<id>" or "SIPAY:<id>", at most ${MAX_TURNED_DOWN}.` }, 400);
  }
  const r = await releaseSettlementRow(c.get('supabase'), co.companyId, rowId, guessed);
  if (!r.ok) {
    const status = r.status === 'not_found' ? 404
      : ['already_confirmed', 'ignored', 'nothing_matched'].includes(r.status) ? 409
      : 500;
    return c.json({ error: r.status, message: r.reason }, status);
  }
  return c.json(r);
});

/* GET /rows/:id/find?q= — "Find the sale": the company's card payments the
   window could not offer, searched by document / customer / approval / amount,
   the exact gross ranked first (docs/bugs/0792). Reads only; confirming is the
   same POST /rows/:id/confirm, which reads the chosen payments back. */
export const settlementFindPayments = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rowId = Number(c.req.param('id'));
  if (!Number.isInteger(rowId)) return c.json({ error: 'bad_id' }, 400);
  const q = String(c.req.query('q') ?? '').slice(0, 80);
  const r = await findPaymentsForRow(c.get('supabase'), co.companyId, rowId, q);
  if (!r.ok) return c.json({ error: r.status, message: r.reason }, r.status === 'not_found' ? 404 : 500);
  return c.json({ q, payments: r.payments });
});

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


export const settlementWatchlist = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const to = DAY.test(c.req.query('to') ?? '') ? (c.req.query('to') as string) : todayMyt();
  const from = DAY.test(c.req.query('from') ?? '')
    ? (c.req.query('from') as string)
    : new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
  const only = (c.req.query('acquirer') ?? '').trim();

  /* so_names rides along: a payment keyed "Pinelabs" is AEON's, and is listed
     under AEON rather than nowhere (owner 2026-10-21). */
  const { data: acqRaw, error: aErr } = await sb.from('acc_acquirers')
    .select('code, display_name, date_tolerance_days, so_names')
    .eq('company_id', co.companyId).eq('is_active', true).order('code');
  if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
  const acquirers = ((acqRaw ?? []) as Array<{ code: string; display_name: string; date_tolerance_days: number; so_names?: string[] | null }>)
    .filter((a) => !only || a.code === only);

  const [waiting, strandedRes] = await Promise.all([
    loadWaitingCardPayments(sb, co.companyId, acquirers, from, to),
    paginateAll<Record<string, any>>((f, t) => sb
      .from('acc_settlement_rows').select('id, batch_id, acquirer_code, txn_date, ref, gross_sen, fee_sen, net_sen, notes')
      .eq('company_id', co.companyId).eq('bucket', 'UNMATCHED')
      .gte('txn_date', from).lte('txn_date', to).order('txn_date').order('id').range(f, t)),
  ]);
  if (!waiting.ok) return c.json({ error: 'load_failed', reason: waiting.reason }, 500);
  const recorded = waiting.payments;

  const { data: strandedRaw, error: sErr } = strandedRes;
  if (sErr) return c.json({ error: 'load_failed', reason: sErr.message }, 500);
  const stranded = ((strandedRaw ?? []) as Array<Record<string, any>>).filter((r) => !only || r.acquirer_code === only);

  /* WHO SOLD IT (owner 2026-09-10: 我想要看到 salesman 的名字) — the order's
     salesperson, read off the order and then off the staff table in two plain
     reads; a name that cannot be read is blank, never somebody else's. */
  const salespersonOf = new Map<string, string>();
  /* The order's Ref No., HC13025, ZNT6656 (owner 2026-11-06: 我要有那个 reference), raw, the
     way so-ref-lookup sends it: the screen resolves the pair through its one display rule. */
  const refsOf = new Map<string, { ref: string | null; customer_so_no: string | null }>();
  {
    const docs = [...new Set(recorded.filter((p) => p.source === 'SOPAY').map((p) => p.docNo).filter(Boolean))];
    const staffIdOf = new Map<string, string>();
    for (let i = 0; i < docs.length; i += 200) {
      const { data, error } = await sb.from('mfg_sales_orders').select('doc_no, salesperson_id, ref, customer_so_no').eq('company_id', co.companyId).in('doc_no', docs.slice(i, i + 200));
      if (error) return c.json({ error: 'load_failed', reason: `salesperson: ${error.message}` }, 500);
      for (const r of data as Array<{ doc_no: string; salesperson_id: string | null; ref?: string | null; customer_so_no?: string | null }>) {
        if (r.salesperson_id) staffIdOf.set(r.doc_no, String(r.salesperson_id));
        refsOf.set(r.doc_no, { ref: r.ref ?? null, customer_so_no: r.customer_so_no ?? null });
      }
    }
    const staffIds = [...new Set(staffIdOf.values())];
    const nameOf = new Map<string, string>();
    for (let i = 0; i < staffIds.length; i += 200) {
      const { data, error } = await sb.from('staff').select('id, name').in('id', staffIds.slice(i, i + 200));
      if (error) return c.json({ error: 'load_failed', reason: `staff: ${error.message}` }, 500);
      for (const r of data as Array<{ id: string; name: string | null }>) if (r.name) nameOf.set(String(r.id), r.name);
    }
    for (const [doc, sid] of staffIdOf) { const n = nameOf.get(sid); if (n) salespersonOf.set(doc, n); }
  }
  return c.json({
    from,
    to,
    recordedNotArrived: recorded
      .sort((a, b) => b.ageDays - a.ageDays)
      .map((p) => ({
        ...p,
        salespersonName: p.source === 'SOPAY' ? (salespersonOf.get(p.docNo) ?? null) : null,
        ref: (p.source === 'SOPAY' ? refsOf.get(p.docNo)?.ref : null) ?? null,
        customer_so_no: (p.source === 'SOPAY' ? refsOf.get(p.docNo)?.customer_so_no : null) ?? null,
      })),
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
    .select('code, display_name, date_tolerance_days, so_names')
    .eq('company_id', co.companyId).eq('is_active', true).order('code');
  if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);

  const { data: matchRaw, error: mErr } = await paginateAll<Record<string, any>>((f, t) => sb
    .from('acc_settlement_matches').select('payment_source, payment_id, settlement_row_id, amount_sen')
    .eq('company_id', co.companyId).order('id').range(f, t));
  if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
  const { data: rowRaw, error: rErr } = await paginateAll<Record<string, any>>((f, t) => sb
    .from('acc_settlement_rows').select('id, batch_id, confirmed_at, fee_sen, matched_with_row_id')
    .eq('company_id', co.companyId).order('id').range(f, t));
  if (rErr) return c.json({ error: 'load_failed', reason: rErr.message }, 500);
  const { data: batchRaw, error: bErr } = await paginateAll<Record<string, any>>((f, t) => sb
    .from('acc_settlement_batches').select('id, net_sen, stated_net_sen, adjustment_sen, adjustment_je_no')
    .eq('company_id', co.companyId).order('id').range(f, t));
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  const { data: recRaw, error: rcErr } = await paginateAll<Record<string, any>>((f, t) => sb
    .from('acc_settlement_receipts').select('batch_id, amount_sen, charge_sen')
    .eq('company_id', co.companyId).order('id').range(f, t));
  if (rcErr) return c.json({ error: 'load_failed', reason: rcErr.message }, 500);
  const kept = await chargedByBatchOf(sb, co.companyId, (recRaw ?? []) as Array<{ batch_id: number; charge_sen?: number | null }>);
  if (!kept.ok) return c.json({ error: 'load_failed', reason: kept.reason }, 500);

  type BatchRow = { id: number; net_sen: number | null; stated_net_sen: number | null; adjustment_sen: number | null; adjustment_je_no: string | null };
  const batches = (batchRaw ?? []) as BatchRow[];
  const receivedByBatch = new Map<number, number>();
  for (const r of (recRaw ?? []) as Array<{ batch_id: number; amount_sen: number }>) {
    receivedByBatch.set(Number(r.batch_id), (receivedByBatch.get(Number(r.batch_id)) ?? 0) + Number(r.amount_sen ?? 0));
  }
  const settledOf = (id: number): number => (receivedByBatch.get(id) ?? 0) + (kept.byBatch.get(id) ?? 0);
  const paidBatch = new Set(batches
    .filter((b) => payableOf(b) !== 0 && settledOf(Number(b.id)) === payableOf(b))
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
  const feeOfLead = new Map<number, number>();
  for (const r of (rowRaw ?? []) as Array<{ id: number; confirmed_at: string | null; fee_sen: number | null; matched_with_row_id?: number | null }>) {
    if (!r.confirmed_at) continue;
    const lead = r.matched_with_row_id == null ? Number(r.id) : Number(r.matched_with_row_id);
    feeOfLead.set(lead, (feeOfLead.get(lead) ?? 0) + Number(r.fee_sen ?? 0));
  }
  for (const [rowId, list] of byRow) {
    const row = rowInfo.get(rowId);
    if (row?.confirmed === true) spread(feeOfLead.get(rowId) ?? row.feeSen, list, outOfTransit);
  }

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
    const alreadyPaid = settledOf(id);
    if (adjustment !== 0) spread(adjustment, list, outOfTransit);
    if (alreadyPaid !== 0) spread(alreadyPaid, list, outOfTransit);
  }

  const days = (a: string, b: string) =>
    Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

  const lines: Array<Record<string, unknown>> = [];
  /* Same rule as the watchlist (docs/bugs/0688): money keyed in without a
     bank is every acquirer's candidate but ONE line here, under no acquirer. */
  const listedUntagged = new Set<string>();
  for (const a of (acqRaw ?? []) as Array<{ code: string; display_name: string; date_tolerance_days: number; so_names?: string[] | null }>) {
    const got = await loadPaymentCandidates(sb, co.companyId, a, from, to);
    if (!got.ok) return c.json({ error: 'load_failed', reason: got.reason }, 500);
    for (const p of listOnce(got.payments, a.code, listedUntagged)) {
      const key = `${p.source}:${p.id}`;
      const row = rowInfo.get(claim.get(key) ?? -1);
      if (row?.paid === true) continue;
      const state = row == null ? 'NOT_ON_A_STATEMENT'
        : row.confirmed ? 'RECONCILED_NOT_PAID'
        : 'MATCHED_NOT_POSTED';
      lines.push({
        acquirerCode: p.acquirerCode,
        source: p.source,
        paymentId: p.id,
        docNo: p.docNo,
        paidOn: p.paidOn,
        amountSen: p.amountSen - (outOfTransit.get(key) ?? 0),
        approvalCode: p.approvalCode,
        recordedById: p.recordedById ?? null,
        ageDays: days(p.paidOn, to),
        state,
      });
    }
  }
  lines.sort((x, y) => Number(y.ageDays) - Number(x.ageDays));

  const staffIds = [...new Set(lines.map((l) => l.recordedById).filter((v): v is string => typeof v === 'string' && v !== ''))];
  const nameOf = new Map<string, string>();
  if (staffIds.length > 0) {
    const { data: staffRaw, error: staffErr } = await sb.from('staff').select('id, name').in('id', staffIds);
    if (staffErr) return c.json({ error: 'load_failed', reason: staffErr.message }, 500);
    for (const s of (staffRaw ?? []) as Array<{ id: string; name: string | null }>) {
      if (s.name) nameOf.set(String(s.id), s.name);
    }
  }
  for (const l of lines) l.recordedBy = nameOf.get(String(l.recordedById ?? '')) ?? null;

  const buckets = (n: number) => (n <= 7 ? '0-7' : n <= 14 ? '8-14' : n <= 30 ? '15-30' : 'over-30');
  const byAcquirer: Record<string, Record<string, { count: number; sen: number }>> = {};
  for (const l of lines) {
    /* Money keyed in without a bank ages under its own key, 未标 (docs/bugs/0688). */
    const a = l.acquirerCode == null ? UNTAGGED_LIST : String(l.acquirerCode);
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
