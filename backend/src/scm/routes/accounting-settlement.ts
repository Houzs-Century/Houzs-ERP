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
import { requireActiveCompanyId } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { parseStatement, type StatementColumnMap } from '../../acc/settlement-parse';
import { matchStatement, recordedNotArrived, type PaymentCandidate } from '../../acc/settlement-match';
import {
  loadAcquirer, loadPaymentCandidates, loadSettledKeys, confirmSettlementRow,
} from '../../acc/settlement';

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

/* GET /setup — the global config of every acquirer plus THIS company's links.
   `ready` is the honest answer to "can this acquirer be reconciled yet". */
export const settlementSetup = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data, error } = await sb.from('acc_acquirers')
    .select('code, display_name, statement_format, has_unique_ref, fee_method, date_tolerance_days, column_map, transit_account_code, fee_account_code, bank_account_code, is_active')
    .eq('company_id', co.companyId).order('code');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const acquirers = ((data ?? []) as Array<Record<string, any>>).map((a) => ({
    ...a,
    ready: Boolean(a.statement_format && a.fee_method && a.column_map?.date && a.column_map?.gross),
    autoMatchable: a.has_unique_ref === true,
  }));
  return c.json({ acquirers });
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
    grossSen: parsed.grossSen,
    feeSen: parsed.feeSen,
    netSen: parsed.netSen,
    periodFrom: parsed.periodFrom,
    periodTo: parsed.periodTo,
    buckets: { MATCHED: autoMatched, NEEDS_CONFIRM: count('NEEDS_CONFIRM') + (count('MATCHED') - autoMatched), UNMATCHED: count('UNMATCHED'), IGNORED: 0 },
  });
});

/* GET /batches — the upload history, newest first. */
export const settlementBatches = guard(async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data, error } = await sb.from('acc_settlement_batches')
    .select('id, acquirer_code, file_name, period_from, period_to, row_count, gross_sen, fee_sen, net_sen, status, uploaded_by, created_at')
    .eq('company_id', co.companyId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ batches: data ?? [] });
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
    .select('id, acquirer_code, file_name, period_from, period_to, row_count, gross_sen, fee_sen, net_sen, status, created_at')
    .eq('id', batchId).eq('company_id', co.companyId).maybeSingle();
  if (bErr) return c.json({ error: 'load_failed', reason: bErr.message }, 500);
  if (!batch) return c.json({ error: 'not_found' }, 404);
  const b = batch as { acquirer_code: string; period_from: string; period_to: string };

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

  /* Only lines still awaiting a decision get candidates computed. The stored
     bucket stays the truth — a human's decision is never recomputed away. */
  const open = stored.filter((r) => !r.confirmed_at && r.bucket !== 'IGNORED');
  const suggestions = matchStatement(
    { code: acq.acquirer.code, has_unique_ref: acq.acquirer.has_unique_ref, date_tolerance_days: acq.acquirer.date_tolerance_days },
    open.map((r) => ({ lineNo: r.line_no, txnDate: String(r.txn_date).slice(0, 10), ref: r.ref, grossSen: Number(r.gross_sen), feeSen: Number(r.fee_sen), netSen: Number(r.net_sen) })),
    candidates.payments,
    settled.keys,
  );
  const byLine = new Map(suggestions.map((d) => [d.row.lineNo, d]));

  /* The payments already linked to each line — what the confirmed piles show,
     and what a re-opened line starts from. */
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

  const rows = stored.map((r) => {
    const s = byLine.get(r.line_no);
    return {
      ...r,
      txn_date: String(r.txn_date).slice(0, 10),
      linked: linksByRow.get(r.id) ?? [],
      candidates: s?.candidates ?? [],
      comboHints: s?.comboHints ?? [],
      clue: s?.clue ?? r.notes,
    };
  });

  const tally = { MATCHED: 0, NEEDS_CONFIRM: 0, UNMATCHED: 0, IGNORED: 0 } as Record<string, number>;
  for (const r of stored) tally[r.bucket] = (tally[r.bucket] ?? 0) + 1;

  return c.json({
    batch,
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
  return c.json({ ok: true, attempted: pending.length, confirmed, failed });
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
