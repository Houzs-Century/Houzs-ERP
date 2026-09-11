// ----------------------------------------------------------------------------
// /accounting/settlement/payouts — the acquirer's own payment advice.
//
// Owner, 2026-08-20: for pbb 就是几份 excel 对一份 pdf. Public Bank sends a
// transaction file per settlement date and, when it pays, ONE IBG advice
// covering several of them. That advice is the answer to "which reports does
// this bank credit pay", written down by the party paying — so it is uploaded,
// checked against the reports already here, and kept for the bank side to read
// instead of guessing.
//
// Handlers here, registered one path each in accounting.ts, for the same reason
// as the other two files in this module: the route-capability audit follows
// `app.route` only, and a sub-router would take these out of the matrix.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { readPbbAdvice } from '../../acc/pbb-advice';
import { statusOfPayout, type ReportForPayout } from '../../acc/payout-advice';
import { postPayoutCharge, undoPayoutCharge } from '../../acc/payout-charge';
import { expenseLeafAccounts } from '../../acc/settlement';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const guard = (handler: (c: Ctx) => Promise<Response>) => async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return c.json({ error: "You don't have permission to reconcile acquirer settlements." }, 403);
  }
  return handler(c);
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Base64 (what the page sends a PDF as) -> bytes. */
function fromBase64(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const bin = atob(clean.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Every merchant report of one acquirer, as the comparison needs it. */
async function reportsFor(sb: any, companyId: number, acquirerCode: string): Promise<
  { ok: true; reports: ReportForPayout[] } | { ok: false; reason: string }
> {
  const { data: batchRaw, error } = await sb.from('acc_settlement_batches')
    .select('id, file_name, period_from, period_to, net_sen, stated_net_sen')
    .eq('company_id', companyId).eq('acquirer_code', acquirerCode);
  if (error) return { ok: false, reason: error.message };
  const { data: rowRaw, error: rErr } = await sb.from('acc_settlement_rows')
    .select('batch_id, confirmed_at, bucket').eq('company_id', companyId);
  if (rErr) return { ok: false, reason: rErr.message };

  const openByBatch = new Map<number, number>();
  for (const r of (rowRaw ?? []) as Array<Record<string, any>>) {
    const id = Number(r.batch_id);
    const open = !r.confirmed_at && r.bucket !== 'IGNORED' ? 1 : 0;
    openByBatch.set(id, (openByBatch.get(id) ?? 0) + open);
  }

  return {
    ok: true,
    reports: ((batchRaw ?? []) as Array<Record<string, any>>).map((b) => ({
      id: Number(b.id),
      fileName: String(b.file_name ?? ''),
      periodFrom: String(b.period_from ?? ''),
      periodTo: String(b.period_to ?? ''),
      payableSen: Number(b.stated_net_sen ?? b.net_sen ?? 0),
      openLines: openByBatch.get(Number(b.id)) ?? 0,
    })),
  };
}

/* ── POST /settlement/payouts — upload one advice ─────────────────────────── */

export const payoutUpload = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const acquirerCode = String(body.acquirerCode ?? '').trim();
  const fileName = String(body.fileName ?? '').trim() || 'advice.pdf';
  const contentBase64 = String(body.contentBase64 ?? '');
  if (!acquirerCode) return c.json({ error: 'no_acquirer', message: 'Choose which acquirer sent this advice.' }, 400);
  if (!contentBase64.trim()) return c.json({ error: 'empty_file', message: 'The file is empty.' }, 400);

  /* Only Public Bank sends one of these so far. Refused by name rather than
     read as an empty advice, which is the §2.14 rule for every reader here. */
  if (acquirerCode !== 'PBB') {
    return c.json({
      error: 'no_advice_reader',
      message: `${acquirerCode} does not send a payment advice this screen can read — only Public Bank's IBG advice is understood.`
        + ' For the others the payout is matched from the bank statement itself.',
    }, 400);
  }

  let bytes: Uint8Array;
  try { bytes = fromBase64(contentBase64); } catch {
    return c.json({ error: 'unreadable_file', message: 'That file could not be read as a PDF.' }, 400);
  }

  const read = await readPbbAdvice(bytes);
  if (!read.ok) return c.json({ error: 'unreadable_advice', message: read.reason }, 400);
  const advice = read.advice;

  const sb = c.get('supabase');
  const fileHash = await sha256Hex(contentBase64);

  const { data: payoutRow, error: insErr } = await sb.from('acc_settlement_payouts').insert({
    company_id: co.companyId,
    acquirer_code: acquirerCode,
    file_name: fileName,
    file_hash: fileHash,
    advice_date: advice.statementDate,
    payee_bank: advice.payeeBank,
    payee_account_no: advice.payeeAccountNo,
    gross_sen: advice.grossSen,
    commission_sen: advice.commissionSen,
    net_sen: advice.netSen,
    printed_net_sen: advice.printedNetSen,
    uploaded_by: (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null,
  }).select('id').single();
  if (insErr) {
    const twice = String(insErr.code ?? '') === '23505' || /duplicate key/i.test(String(insErr.message ?? ''));
    return c.json({
      error: twice ? 'already_uploaded' : 'save_failed',
      message: twice
        ? 'This exact advice has already been uploaded. Open the existing one instead of loading it twice.'
        : insErr.message,
    }, twice ? 409 : 500);
  }
  const payoutId = Number((payoutRow as { id: number }).id);

  const reports = await reportsFor(sb, co.companyId, acquirerCode);
  if (!reports.ok) return c.json({ error: 'load_failed', reason: reports.reason }, 500);
  const status = statusOfPayout(advice, reports.reports);

  const { error: dayErr } = await sb.from('acc_settlement_payout_batches').insert(
    status.days.map((d) => ({
      payout_id: payoutId,
      company_id: co.companyId,
      settled_on: d.settledOn,
      net_sen: d.adviceNetSen,
      batch_id: d.batchId,
    })),
  );
  if (dayErr) return c.json({ error: 'save_failed', reason: dayErr.message }, 500);

  return c.json({ ok: true, payoutId, advice, status });
});

/* ── GET /settlement/payouts — the list, each re-checked live ─────────────── */

export const payoutList = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const { data: payoutRaw, error } = await sb.from('acc_settlement_payouts')
    .select('*').eq('company_id', co.companyId).order('advice_date', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const payouts = (payoutRaw ?? []) as Array<Record<string, any>>;
  if (payouts.length === 0) return c.json({ payouts: [] });

  const { data: dayRaw, error: dErr } = await sb.from('acc_settlement_payout_batches')
    .select('payout_id, settled_on, net_sen, charge_sen, charge_account_code, charge_note, charge_je_no').eq('company_id', co.companyId);
  if (dErr) return c.json({ error: 'load_failed', reason: dErr.message }, 500);
  type DayIn = { settledOn: string; netSen: number; chargeSen: number; chargeAccountCode: string | null; chargeNote: string | null; chargeJeNo: string | null };
  const daysByPayout = new Map<number, DayIn[]>();
  for (const d of (dayRaw ?? []) as Array<Record<string, any>>) {
    const id = Number(d.payout_id);
    const at = daysByPayout.get(id) ?? [];
    at.push({
      settledOn: String(d.settled_on).slice(0, 10), netSen: Number(d.net_sen ?? 0),
      /* A charge the bank deducted from that day (docs/bugs/0787), so the
         status can count it as paid and the screen can show where it went. */
      chargeSen: Number(d.charge_sen ?? 0),
      chargeAccountCode: d.charge_account_code == null ? null : String(d.charge_account_code),
      chargeNote: d.charge_note == null ? null : String(d.charge_note),
      chargeJeNo: d.charge_je_no == null ? null : String(d.charge_je_no),
    });
    daysByPayout.set(id, at);
  }
  /* The accounts a charge may be booked to — active expense leaves of this
     company, the same list the Setup page offers for the merchant fee — and
     each acquirer's fee account, which the dialog defaults to. */
  const chargeAccounts = await expenseLeafAccounts(sb, co.companyId);
  if (!chargeAccounts.ok) return c.json({ error: 'load_failed', reason: chargeAccounts.reason }, 500);
  const { data: acqRaw, error: acqErr } = await sb.from('acc_acquirers')
    .select('code, fee_account_code').eq('company_id', co.companyId);
  if (acqErr) return c.json({ error: 'load_failed', reason: acqErr.message }, 500);
  const feeAccountByAcquirer: Record<string, string | null> = {};
  for (const a of (acqRaw ?? []) as Array<Record<string, any>>) feeAccountByAcquirer[String(a.code)] = a.fee_account_code == null ? null : String(a.fee_account_code);

  const out = [];
  for (const p of payouts) {
    const reports = await reportsFor(sb, co.companyId, String(p.acquirer_code));
    if (!reports.ok) return c.json({ error: 'load_failed', reason: reports.reason }, 500);
    /* RE-CHECKED, not read back from the day rows: a report uploaded since the
       advice was must count, and one whose lines were decided since must stop
       blocking it. The stored rows say what the ADVICE said; whether that is
       satisfied is a question about today. */
    const status = statusOfPayout(
      { netSen: Number(p.net_sen ?? 0), batches: daysByPayout.get(Number(p.id)) ?? [] },
      reports.reports,
    );
    out.push({ ...p, status });
  }
  return c.json({ payouts: out, chargeAccounts: chargeAccounts.accounts, feeAccountByAcquirer });
});

/* ── POST /settlement/payouts/:id/days/:settledOn/charge — the bank deducted a
   charge from this day's payout (docs/bugs/0787). Owner 2026-09-10: 「银行的卡机
   application fees … 可以让我点了后选这笔进什么户口吗」. The amount defaults to
   the whole difference; the account is Finance's choice, checked the way the
   merchant fee account is; the note is required because the corrections
   report prints it. Everything that can go wrong is a named refusal from
   acc/payout-charge, answered in a sentence. */
const dayParams = (c: Ctx): { payoutId: number; settledOn: string } | null => {
  const payoutId = Number(c.req.param('id'));
  const settledOn = String(c.req.param('settledOn') ?? '').trim();
  if (!Number.isInteger(payoutId) || !/^\d{4}-\d{2}-\d{2}$/.test(settledOn)) return null;
  return { payoutId, settledOn };
};

export const payoutCharge = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const at = dayParams(c);
  if (!at) return c.json({ error: 'bad_request', message: 'Say which advice and which settlement day.' }, 400);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const r = await postPayoutCharge(c.get('supabase'), co.companyId, {
    ...at,
    amountSen: body.amountSen == null ? null : Number(body.amountSen),
    accountCode: String(body.accountCode ?? ''),
    note: String(body.note ?? ''),
    userName: (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null,
  });
  if (!r.ok) {
    const status = r.status === 'not_found' ? 404 : r.status === 'load_failed' || r.status === 'save_failed' ? 500 : 409;
    return c.json({ error: r.status, message: r.reason }, status);
  }
  return c.json(r);
});

export const payoutChargeUndo = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const at = dayParams(c);
  if (!at) return c.json({ error: 'bad_request', message: 'Say which advice and which settlement day.' }, 400);
  const r = await undoPayoutCharge(c.get('supabase'), co.companyId, at);
  if (!r.ok) {
    const status = r.status === 'not_found' ? 404 : r.status === 'load_failed' || r.status === 'save_failed' ? 500 : 409;
    return c.json({ error: r.status, message: r.reason }, status);
  }
  return c.json(r);
});
