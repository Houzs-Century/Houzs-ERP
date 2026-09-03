// ----------------------------------------------------------------------------
// Other Debtors — the counterparty registry and its two documents.
//
// The owner's design, confirmed line by line (2026-09-03): other debtor 主要
// 就是我会开 bill 其他和生意性质没有关系的人或公司收回钱. So:
//
//   · a REGISTRY of counterparties (name/phone/notes) — 因为 other debtor
//     需要填他们的资料, and 照理 chart of account 只能维护其他的: the GL
//     keeps ONE control (305-0000, role AR_OTHER) and never a per-party
//     sub-account;
//   · a DEBTOR BILL that posts DIRECTLY (his call: bill 直接过账) —
//     Dr AR_OTHER / Cr each line's own account (我开 bill 时决定 account
//     就行了), source ODB;
//   · a RECEIPT that walks the SAME FOUR LAYERS as the PV (就收款就好):
//     Draft → Prepared → Checked → Approved, approve posts Dr bank /
//     Cr AR_OTHER (source ODR) and knocks the ticked bills off, partial
//     included (确定到时也可以 partial), the exact AP-Payment shape.
//
// Receipts land in Daily Bank for free: the posted ODR debits a money
// account, and Daily Bank reads the GL. Permission keys are the PV family's
// on purpose — the same people prepare, check and approve money documents:
// create/write raise and prepare, scm.payment_voucher.check checks,
// scm.payment_voucher.approve approves-and-posts, cancel cancels bills.
//
// Handlers exported bare for the vitest harness (accounting-chart precedent).
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanyId, companyDocPrefix, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { mintMonthlyDocNo } from '../lib/doc-no';
import { postJournal, reverseJournal } from '../../acc/engine';
import { resolveRoles, type RuleLine } from '../../acc/rules';
import { requireLeafAccount } from './accounting-chart';

type Row = Record<string, any>;

const now = () => new Date().toISOString();

const yymm = () => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/* Same door as the PV's Paid From: the receiving account must BE money. */
const requireMoneyIn = async (c: any, code: string): Promise<Response | null> => {
  const sb = c.get('supabase');
  const coId = activeCompanyId(c);
  const { data, error } = await sb.from('accounts')
    .select('acc_money, is_active')
    .eq('company_id', coId).eq('account_code', code).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const a = data as { acc_money?: boolean; is_active?: boolean } | null;
  if (!a || a.is_active !== true || a.acc_money !== true) {
    return c.json({ error: 'not_a_money_account', message: `${code} is not an active bank/cash account — the receipt must land on money.` }, 400);
  }
  return null;
};

const loadDebtor = async (c: any, id: string): Promise<{ debtor: Row } | { resp: Response }> => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb.from('acc_debtors').select('id, company_id, name, phone, notes, is_active').eq('id', id), c,
  ).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'not_found' }, 404) };
  return { debtor: data as Row };
};

/* ── Registry ─────────────────────────────────────────────────────────────── */

export const listDebtorsHandler = async (c: any): Promise<Response> => {
  const sb = c.get('supabase');
  const { data: debtors, error } = await scopeToCompany(
    sb.from('acc_debtors').select('id, name, phone, notes, is_active, created_at'), c,
  ).order('name');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const { data: bills, error: bErr } = await scopeToCompany(
    sb.from('acc_debtor_bills').select('debtor_id, total_sen, received_sen, status'), c,
  );
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  const outstanding = new Map<string, number>();
  for (const b of (bills ?? []) as Row[]) {
    if (b.status === 'CANCELLED') continue;
    outstanding.set(b.debtor_id, (outstanding.get(b.debtor_id) ?? 0) + Number(b.total_sen) - Number(b.received_sen ?? 0));
  }
  return c.json({
    debtors: ((debtors ?? []) as Row[]).map((d) => ({ ...d, outstanding_sen: outstanding.get(d.id) ?? 0 })),
  });
};

export const createDebtorHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const name = String(body.name ?? '').trim();
  if (!name) return c.json({ error: 'name_required' }, 400);
  const sb = c.get('supabase');
  const { data, error } = await sb.from('acc_debtors').insert({
    company_id: activeCompanyId(c),
    name,
    phone: body.phone ? String(body.phone).trim() : null,
    notes: body.notes ? String(body.notes).trim() : null,
    created_by: String(c.get('user')?.id ?? ''),
  }).select('id, name').single();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, debtor: data }, 201);
};

export const updateDebtorHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const found = await loadDebtor(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const patch: Row = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return c.json({ error: 'name_required' }, 400);
    patch.name = name;
  }
  if (body.phone !== undefined) patch.phone = body.phone ? String(body.phone).trim() : null;
  if (body.notes !== undefined) patch.notes = body.notes ? String(body.notes).trim() : null;
  if (body.isActive !== undefined) patch.is_active = body.isActive === true;
  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing_to_change' }, 400);
  const sb = c.get('supabase');
  const { error } = await sb.from('acc_debtors').update(patch).eq('company_id', found.debtor.company_id).eq('id', found.debtor.id);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true });
};

export const debtorDetailHandler = async (c: any): Promise<Response> => {
  const found = await loadDebtor(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const sb = c.get('supabase');
  const [bills, receipts] = await Promise.all([
    scopeToCompany(sb.from('acc_debtor_bills')
      .select('id, bill_number, bill_date, total_sen, received_sen, status, notes, created_at')
      .eq('debtor_id', found.debtor.id), c).order('bill_number'),
    scopeToCompany(sb.from('acc_debtor_receipts')
      .select('id, receipt_number, receipt_date, bank_account_code, total_sen, status, submitted_at, submitted_by, checked_at, checked_by, approved_at, approved_by, posted_at, notes, created_at')
      .eq('debtor_id', found.debtor.id), c).order('receipt_number'),
  ]);
  if (bills.error) return c.json({ error: 'load_failed', reason: bills.error.message }, 500);
  if (receipts.error) return c.json({ error: 'load_failed', reason: receipts.error.message }, 500);
  return c.json({ debtor: found.debtor, bills: bills.data ?? [], receipts: receipts.data ?? [] });
};

/* ── Debtor Bill — posts directly (the owner: bill 直接过账) ───────────────── */

export const createDebtorBillHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const found = await loadDebtor(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  if (found.debtor.is_active !== true) return c.json({ error: 'debtor_inactive', message: `${found.debtor.name} is deactivated.` }, 400);

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length === 0 || rawLines.length > 50) {
    return c.json({ error: 'lines_required', message: 'A bill takes 1 to 50 lines.' }, 400);
  }
  const lines: Array<{ description: string | null; code: string; amountSen: number }> = [];
  for (const [i, l] of rawLines.entries()) {
    const code = String(l?.creditAccountCode ?? '').trim();
    const amount = Number(l?.amountSen);
    if (!code) return c.json({ error: 'bad_line', message: `Line ${i + 1} has no account.` }, 400);
    if (!Number.isInteger(amount) || amount <= 0) {
      return c.json({ error: 'bad_line', message: `Line ${i + 1}: amountSen must be a positive integer (got ${String(l?.amountSen)}).` }, 400);
    }
    lines.push({ description: l?.description ? String(l.description).trim() : null, code, amountSen: amount });
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json({ error: 'no_company', message: 'No active company resolves for this session.' }, 409);
  const coId = co.companyId;
  /* Each credit line takes only ordinary LEAVES — the same door the PV's
     debit walks: headers refuse (父户不记账), controls refuse (由模块过账). */
  for (const code of [...new Set(lines.map((l) => l.code))]) {
    const leafErr = await requireLeafAccount(c, coId, code);
    if (leafErr) return leafErr;
  }
  const billDate = String(body.billDate ?? '').trim() || new Date().toISOString().slice(0, 10);
  const totalSen = lines.reduce((s, l) => s + l.amountSen, 0);

  const sb = c.get('supabase');
  const billNumber = await mintMonthlyDocNo(sb, 'acc_debtor_bills', 'bill_number', `${companyDocPrefix(c)}ODB-${yymm()}`);
  const { data: bill, error: insErr } = await sb.from('acc_debtor_bills').insert({
    company_id: coId,
    bill_number: billNumber,
    debtor_id: found.debtor.id,
    bill_date: billDate,
    total_sen: totalSen,
    received_sen: 0,
    status: 'POSTED',
    notes: body.notes ? String(body.notes).trim() : null,
    created_by: String(c.get('user')?.id ?? ''),
  }).select('id, bill_number').single();
  if (insErr || !bill) return c.json({ error: 'save_failed', reason: insErr?.message ?? 'insert returned nothing' }, 500);

  const { error: lineErr } = await sb.from('acc_debtor_bill_lines').insert(lines.map((l, i) => ({
    company_id: coId,
    bill_id: bill.id,
    line_no: i + 1,
    description: l.description,
    credit_account_code: l.code,
    amount_sen: l.amountSen,
  })));
  if (lineErr) {
    await sb.from('acc_debtor_bills').delete().eq('company_id', coId).eq('id', bill.id);
    return c.json({ error: 'save_failed', reason: lineErr.message }, 500);
  }

  const roles = await resolveRoles(sb, coId);
  const ruleLines: RuleLine[] = [
    {
      accountCode: roles.AR_OTHER, debitSen: totalSen, creditSen: 0,
      partyType: 'ODEBTOR', partyCode: null, partyName: found.debtor.name,
      notes: `Other debtor ${found.debtor.name} — ${bill.bill_number}`,
    },
    ...lines.map((l) => ({
      accountCode: l.code, debitSen: 0, creditSen: l.amountSen,
      partyType: null, partyCode: null, partyName: null,
      notes: l.description ?? bill.bill_number,
    })),
  ];
  const r = await postJournal(sb, {
    companyId: coId,
    entryDate: billDate,
    sourceType: 'ODB',
    sourceDocNo: bill.bill_number,
    narration: `Debtor bill ${bill.bill_number} — ${found.debtor.name}`,
    lines: ruleLines,
  });
  if (!r.ok) {
    /* The bill does not exist without its journal — direct-post means BOTH. */
    await sb.from('acc_debtor_bill_lines').delete().eq('company_id', coId).eq('bill_id', bill.id);
    await sb.from('acc_debtor_bills').delete().eq('company_id', coId).eq('id', bill.id);
    return c.json({ error: 'post_failed', reason: (r as { reason?: string }).reason ?? r.status }, 500);
  }
  return c.json({ ok: true, bill: { id: bill.id, billNumber: bill.bill_number, totalSen } }, 201);
};

export const cancelDebtorBillHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.cancel')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const sb = c.get('supabase');
  const { data: bill, error } = await scopeToCompany(
    sb.from('acc_debtor_bills').select('id, bill_number, status, received_sen, company_id').eq('id', c.req.param('billId')), c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!bill) return c.json({ error: 'not_found' }, 404);
  if (bill.status === 'CANCELLED') return c.json({ error: 'already_cancelled' }, 409);
  if (Number(bill.received_sen ?? 0) > 0) {
    return c.json({ error: 'bill_has_receipts', message: 'Money was already received against this bill — it cannot be cancelled.' }, 409);
  }
  const rev = await reverseJournal(sb, {
    companyId: bill.company_id,
    sourceType: 'ODB',
    sourceDocNo: bill.bill_number,
    narration: (orig) => `Cancel debtor bill ${bill.bill_number} — voids ${orig.je_no}`,
  });
  if (!rev.ok) return c.json({ error: 'reverse_failed', reason: (rev as { reason?: string }).reason ?? rev.status }, 500);
  const { error: upErr } = await sb.from('acc_debtor_bills').update({ status: 'CANCELLED' }).eq('company_id', bill.company_id).eq('id', bill.id);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true });
};

/* ── Receipt — the owner's four layers, then Dr bank / Cr AR_OTHER ────────── */

export const createDebtorReceiptHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const found = await loadDebtor(c, c.req.param('id'));
  if ('resp' in found) return found.resp;

  const bank = String(body.bankAccountCode ?? '').trim();
  if (!bank) return c.json({ error: 'bank_required' }, 400);
  const moneyErr = await requireMoneyIn(c, bank);
  if (moneyErr) return moneyErr;

  const rawAllocs = Array.isArray(body.allocations) ? body.allocations : [];
  if (rawAllocs.length === 0) return c.json({ error: 'allocations_required', message: 'Tick at least one bill.' }, 400);
  const allocs: Array<{ billId: string; amountSen: number }> = [];
  for (const [i, a] of rawAllocs.entries()) {
    const billId = String(a?.billId ?? '').trim();
    const amount = Number(a?.amountSen);
    if (!billId || !Number.isInteger(amount) || amount <= 0) {
      return c.json({ error: 'bad_allocation', message: `Allocation ${i + 1} needs a bill and a positive integer amountSen.` }, 400);
    }
    allocs.push({ billId, amountSen: amount });
  }
  const sb = c.get('supabase');
  const coId = activeCompanyId(c);
  const { data: bills, error: bErr } = await scopeToCompany(
    sb.from('acc_debtor_bills').select('id, debtor_id, status, total_sen, received_sen').in('id', allocs.map((a) => a.billId)), c,
  );
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  const byId = new Map(((bills ?? []) as Row[]).map((b) => [b.id, b]));
  for (const a of allocs) {
    const b = byId.get(a.billId);
    if (!b || b.debtor_id !== found.debtor.id) {
      return c.json({ error: 'bad_allocation', message: `Bill ${a.billId} is not this debtor's.` }, 400);
    }
    if (b.status === 'CANCELLED') return c.json({ error: 'bad_allocation', message: 'A cancelled bill takes no money.' }, 400);
    const outstanding = Number(b.total_sen) - Number(b.received_sen ?? 0);
    if (a.amountSen > outstanding) {
      return c.json({ error: 'over_allocation', message: `That bill has only ${outstanding} sen outstanding.` }, 400);
    }
  }
  const totalSen = allocs.reduce((s, a) => s + a.amountSen, 0);
  const receiptDate = String(body.receiptDate ?? '').trim() || new Date().toISOString().slice(0, 10);

  const receiptNumber = await mintMonthlyDocNo(sb, 'acc_debtor_receipts', 'receipt_number', `${companyDocPrefix(c)}ODR-${yymm()}`);
  const { data: receipt, error: insErr } = await sb.from('acc_debtor_receipts').insert({
    company_id: coId,
    receipt_number: receiptNumber,
    debtor_id: found.debtor.id,
    receipt_date: receiptDate,
    bank_account_code: bank,
    total_sen: totalSen,
    status: 'DRAFT',
    notes: body.notes ? String(body.notes).trim() : null,
    created_by: String(c.get('user')?.id ?? ''),
  }).select('id, receipt_number').single();
  if (insErr || !receipt) return c.json({ error: 'save_failed', reason: insErr?.message ?? 'insert returned nothing' }, 500);
  const { error: aErr } = await sb.from('acc_debtor_receipt_allocations').insert(allocs.map((a) => ({
    company_id: coId, receipt_id: receipt.id, bill_id: a.billId, amount_sen: a.amountSen,
  })));
  if (aErr) {
    await sb.from('acc_debtor_receipts').delete().eq('company_id', coId).eq('id', receipt.id);
    return c.json({ error: 'save_failed', reason: aErr.message }, 500);
  }
  return c.json({ ok: true, receipt: { id: receipt.id, receiptNumber: receipt.receipt_number, totalSen } }, 201);
};

const loadReceipt = async (c: any): Promise<{ receipt: Row } | { resp: Response }> => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb.from('acc_debtor_receipts').select('*').eq('id', c.req.param('receiptId')), c,
  ).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'not_found' }, 404) };
  return { receipt: data as Row };
};

const stamp = (c: any) => ({ at: now(), by: String(c.get('user')?.id ?? '') });

export const submitDebtorReceiptHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const found = await loadReceipt(c);
  if ('resp' in found) return found.resp;
  const r = found.receipt;
  if (r.status !== 'DRAFT') return c.json({ error: 'not_editable' }, 409);
  if (r.submitted_at) return c.json({ error: 'already_prepared' }, 409);
  const s = stamp(c);
  const { error } = await c.get('supabase').from('acc_debtor_receipts')
    .update({ submitted_at: s.at, submitted_by: s.by }).eq('company_id', r.company_id).eq('id', r.id);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true });
};

export const withdrawDebtorReceiptHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const found = await loadReceipt(c);
  if ('resp' in found) return found.resp;
  const r = found.receipt;
  if (!r.submitted_at || r.checked_at) return c.json({ error: 'not_withdrawable', message: 'Only a prepared, not-yet-checked receipt can be withdrawn.' }, 409);
  const { error } = await c.get('supabase').from('acc_debtor_receipts')
    .update({ submitted_at: null, submitted_by: null }).eq('company_id', r.company_id).eq('id', r.id);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true });
};

export const checkDebtorReceiptHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.check')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const found = await loadReceipt(c);
  if ('resp' in found) return found.resp;
  const r = found.receipt;
  if (r.status !== 'DRAFT' || !r.submitted_at) return c.json({ error: 'not_checkable', message: 'Prepare the receipt first.' }, 409);
  if (r.checked_at) return c.json({ error: 'already_checked' }, 409);
  const s = stamp(c);
  const { error } = await c.get('supabase').from('acc_debtor_receipts')
    .update({ checked_at: s.at, checked_by: s.by }).eq('company_id', r.company_id).eq('id', r.id);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true });
};

export const rejectDebtorReceiptHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.check') && !hasHouzsPerm(c, 'scm.payment_voucher.approve')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  let body: any = {};
  try { body = await c.req.json(); } catch { /* note is optional */ }
  const found = await loadReceipt(c);
  if ('resp' in found) return found.resp;
  const r = found.receipt;
  if (r.status !== 'DRAFT' || !r.submitted_at) return c.json({ error: 'not_rejectable' }, 409);
  if (r.approved_at) return c.json({ error: 'already_approved' }, 409);
  /* 一律退回 Draft (the owner's PV rule, reused verbatim): every mark clears. */
  const note = body?.note ? String(body.note).trim() : '';
  const { error } = await c.get('supabase').from('acc_debtor_receipts').update({
    submitted_at: null, submitted_by: null, checked_at: null, checked_by: null,
    notes: note ? `${r.notes ? `${r.notes}\n` : ''}[rejected] ${note}` : r.notes,
  }).eq('company_id', r.company_id).eq('id', r.id);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true });
};

export const approveDebtorReceiptHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.approve')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const found = await loadReceipt(c);
  if ('resp' in found) return found.resp;
  const r = found.receipt;
  if (r.status === 'CANCELLED') return c.json({ error: 'cancelled' }, 409);
  if (r.status === 'POSTED') return c.json({ error: 'already_posted' }, 409);
  if (!r.checked_at) return c.json({ error: 'not_approvable', message: 'Check the receipt first.' }, 409);
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json({ error: 'no_company', message: 'No active company resolves for this session.' }, 409);
  const coId = co.companyId;

  /* Approve stamps once; a resume after a died post never rewrites the stamp
     (the PV's 0343 rule, reused). */
  if (!r.approved_at) {
    const s = stamp(c);
    const { error } = await sb.from('acc_debtor_receipts')
      .update({ approved_at: s.at, approved_by: s.by }).eq('company_id', r.company_id).eq('id', r.id);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }

  const { data: debtor } = await sb.from('acc_debtors').select('name').eq('company_id', coId).eq('id', r.debtor_id).maybeSingle();
  const roles = await resolveRoles(sb, coId);
  const lines: RuleLine[] = [
    {
      accountCode: r.bank_account_code, debitSen: Number(r.total_sen ?? 0), creditSen: 0,
      partyType: null, partyCode: null, partyName: null,
      notes: `Receipt ${r.receipt_number}`,
    },
    {
      accountCode: roles.AR_OTHER, debitSen: 0, creditSen: Number(r.total_sen ?? 0),
      partyType: 'ODEBTOR', partyCode: null, partyName: (debtor as Row | null)?.name ?? null,
      notes: `Other debtor settlement — ${r.receipt_number}`,
    },
  ];
  const post = await postJournal(sb, {
    companyId: coId,
    entryDate: r.receipt_date,
    sourceType: 'ODR',
    sourceDocNo: r.receipt_number,
    narration: `Debtor receipt ${r.receipt_number} — ${(debtor as Row | null)?.name ?? ''}`,
    lines,
  });
  if (!post.ok) return c.json({ error: 'post_failed', reason: (post as { reason?: string }).reason ?? post.status }, 500);

  /* Knock the ticked bills off — clamped at each bill's outstanding, the
     pv-settle shape (a concurrent receipt may have landed first). */
  const { data: allocs, error: aErr } = await sb.from('acc_debtor_receipt_allocations')
    .select('bill_id, amount_sen').eq('company_id', coId).eq('receipt_id', r.id);
  if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
  for (const a of (allocs ?? []) as Row[]) {
    const { data: bill } = await sb.from('acc_debtor_bills')
      .select('id, total_sen, received_sen').eq('company_id', coId).eq('id', a.bill_id).maybeSingle();
    if (!bill) continue;
    const room = Number(bill.total_sen) - Number(bill.received_sen ?? 0);
    const applied = Math.min(room, Number(a.amount_sen));
    if (applied < Number(a.amount_sen)) {
      console.error('[debtor-receipt] allocation exceeded the bill outstanding — clamped:', r.receipt_number, a.bill_id);
    }
    if (applied <= 0) continue;
    const nextReceived = Number(bill.received_sen ?? 0) + applied;
    const { error: upErr } = await sb.from('acc_debtor_bills').update({
      received_sen: nextReceived,
      status: nextReceived >= Number(bill.total_sen) ? 'PAID' : 'POSTED',
    }).eq('company_id', coId).eq('id', bill.id);
    if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  }

  const { error: doneErr } = await sb.from('acc_debtor_receipts')
    .update({ status: 'POSTED', posted_at: now() }).eq('company_id', coId).eq('id', r.id);
  if (doneErr) return c.json({ error: 'save_failed', reason: doneErr.message }, 500);
  return c.json({ ok: true, jeNo: (post as Row).jeNo });
};

/* ── Router ───────────────────────────────────────────────────────────────── */

export const otherDebtors = new Hono();
otherDebtors.get('/', listDebtorsHandler);
otherDebtors.post('/', createDebtorHandler);
otherDebtors.get('/:id', debtorDetailHandler);
otherDebtors.patch('/:id', updateDebtorHandler);
otherDebtors.post('/:id/bills', createDebtorBillHandler);
otherDebtors.post('/bills/:billId/cancel', cancelDebtorBillHandler);
otherDebtors.post('/:id/receipts', createDebtorReceiptHandler);
otherDebtors.post('/receipts/:receiptId/submit', submitDebtorReceiptHandler);
otherDebtors.post('/receipts/:receiptId/withdraw', withdrawDebtorReceiptHandler);
otherDebtors.post('/receipts/:receiptId/check', checkDebtorReceiptHandler);
otherDebtors.post('/receipts/:receiptId/reject', rejectDebtorReceiptHandler);
otherDebtors.post('/receipts/:receiptId/approve', approveDebtorReceiptHandler);
