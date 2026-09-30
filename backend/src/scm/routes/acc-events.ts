// /acc-events — events on the money side (owner 2026-09-29/30: 我的 payment 可能
// 需要绑定 event; 5a, an event per line with the header a default).
//
//   GET  /options                 the event picker: ?q= searches, else the events
//                                 around ?around=YYYY-MM-DD; ?ids= reads labels
//   GET  /costs                   the event cost report: events starting in
//                                 ?from..?to, each with every posted leg tagged to it
//   POST /pv-lines/:lineId/event  change the event on one voucher line — posted
//                                 or not — and on its journal leg
//
// Mounted behind scmAreaGuard("scm.finance.accounting") (scm/index.ts): a read
// needs view on Finance > Accounting, a write needs the money right.

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanySql, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { chunkIn } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { dateOrNull } from '../lib/date-coerce';
import { assertAuditWritable, auditUnavailableBody, fieldChange, recordEntityAudit } from '../lib/entity-audit';
import { listEventOptions, loadEventsByIds, parseEventId, pvLineEventRefusal, toEventRow, type EventRow } from '../lib/event-tags';
import { buildEventCosts, type ChartRow, type LegEntry, type TaggedLeg } from '../lib/event-costs';

export const accEvents = new Hono<{ Bindings: Env; Variables: Variables }>();
accEvents.use('*', supabaseAuth);

const NO_PERM = { error: "You don't have permission to do that." };

/* ── GET /options ─────────────────────────────────────────────────────────── */
export const eventOptionsHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const companySql = activeCompanySql(c, 'p.company_id');
  try {
    const idsRaw = String(c.req.query('ids') ?? '').trim();
    if (idsRaw) {
      const ids = idsRaw.split(',').map((s) => parseEventId(s.trim())).filter((n): n is number => typeof n === 'number');
      const found = await loadEventsByIds(c.env.DB, companySql, ids);
      return c.json({ events: [...found.values()] });
    }
    const around = dateOrNull(c.req.query('around')) ?? todayMyt();
    const events = await listEventOptions(c.env.DB, companySql, { q: c.req.query('q') ?? null, around });
    return c.json({ events });
  } catch (e) {
    return c.json({ error: 'event_read_failed', message: 'The events could not be read — try again.', reason: String((e as Error)?.message ?? e) }, 500);
  }
};
accEvents.get('/options', eventOptionsHandler);

/* ── GET /costs ───────────────────────────────────────────────────────────── */
const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;
const monthEnd = (ymd: string) => {
  const d = new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

export const eventCostsHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const today = todayMyt();
  const from = dateOrNull(c.req.query('from')) ?? monthStart(today);
  const to = dateOrNull(c.req.query('to')) ?? monthEnd(today);
  if (from > to) return c.json({ error: 'bad_range', message: 'The From date is after the To date.' }, 400);

  /* The events that START in the range — archived ones too, so money already
     tagged to an event the office later withdrew still shows (buildEventCosts
     drops an archived event only when nothing is on it). */
  let events: EventRow[];
  try {
    const res = await c.env.DB.prepare(
      `SELECT p.id AS id, p.code AS code, p.name AS name, p.start_date AS startdate, p.end_date AS enddate,
              p.status AS status, p.archived_at AS archivedat, p.venue AS venue, p.brand AS brand,
              p.organizer AS organizer, p.booth_no AS boothno
         FROM projects p
        WHERE p.start_date IS NOT NULL AND p.start_date >= ? AND p.start_date <= ?${activeCompanySql(c, 'p.company_id')}
        ORDER BY p.start_date, p.id`,
    ).bind(from, to).all();
    events = ((res.results ?? []) as Array<Record<string, unknown>>).map(toEventRow).filter((e) => Number.isFinite(e.id));
  } catch (e) {
    return c.json({ error: 'event_read_failed', message: 'The events could not be read — try again.', reason: String((e as Error)?.message ?? e) }, 500);
  }

  const sb = c.get('supabase');
  const legs = await chunkIn<TaggedLeg, number>(events.map((e) => e.id), (batch, lo, hi) =>
    sb.from('journal_entry_lines')
      .select('journal_entry_id, line_no, account_code, debit_sen, credit_sen, notes, project_id')
      .eq('company_id', co.companyId).in('project_id', batch).order('id').range(lo, hi));
  if (legs.error) return c.json({ error: 'load_failed', reason: legs.error.message }, 500);
  const jeIds = [...new Set(legs.data.map((l) => l.journal_entry_id))];
  const entries = await chunkIn<LegEntry>(jeIds, (batch, lo, hi) =>
    sb.from('journal_entries')
      .select('id, je_no, entry_date, source_type, source_doc_no, posted, reversed, reversed_by_je')
      .eq('company_id', co.companyId).in('id', batch).order('id').range(lo, hi));
  if (entries.error) return c.json({ error: 'load_failed', reason: entries.error.message }, 500);
  const { data: chart, error: chartErr } = await sb.from('accounts')
    .select('account_code, account_name, account_type').eq('company_id', co.companyId);
  if (chartErr) return c.json({ error: 'load_failed', reason: chartErr.message }, 500);

  const rows = buildEventCosts(events, legs.data, entries.data, (chart ?? []) as ChartRow[]);
  return c.json({
    from, to, events: rows,
    totals: { costSen: rows.reduce((s, r) => s + r.costSen, 0), otherSen: rows.reduce((s, r) => s + r.otherSen, 0) },
  });
};
accEvents.get('/costs', eventCostsHandler);

/* ── POST /pv-lines/:lineId/event ─────────────────────────────────────────────
   A voucher is locked from Check on, and an approved one cannot be edited at
   all — cancelling a paid voucher to fix a tag would undo a payment the bank
   has already seen. The event is not money: it moves no amount, account or
   date, so it changes in place — on the voucher line and, once posted, on the
   one journal leg that line wrote (pvLines writes line N as leg N), with the
   change in the voucher's history. The leg is checked against the line
   (account and amount) before it is touched; a leg that does not match is
   refused, never guessed. */
export const retagPvLineHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write') && !hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const projectId = parseEventId(body?.projectId);
  if (projectId === 'invalid') return c.json({ error: 'bad_event', message: 'projectId must be an event id, or null to clear it.' }, 400);

  const sb = c.get('supabase');
  const { data: line, error: lineErr } = await scopeToCompany(sb.from('payment_voucher_lines')
    .select('id, pv_id, line_no, debit_account_code, amount_sen, project_id').eq('id', c.req.param('lineId')), c).maybeSingle();
  if (lineErr) return c.json({ error: 'load_failed', reason: lineErr.message }, 500);
  if (!line) return c.json({ error: 'not_found', message: 'That voucher line is not in the company you are working in.' }, 404);
  const { data: pv, error: pvErr } = await scopeToCompany(sb.from('payment_vouchers')
    .select('id, pv_number, status, purpose, exchange_rate').eq('id', line.pv_id), c).maybeSingle();
  if (pvErr) return c.json({ error: 'load_failed', reason: pvErr.message }, 500);
  if (!pv) return c.json({ error: 'not_found', message: 'That voucher is not in the company you are working in.' }, 404);
  if (pv.status === 'CANCELLED') return c.json({ error: 'cancelled', message: `${pv.pv_number} is cancelled — its event no longer counts.` }, 409);
  const refusal = await pvLineEventRefusal(c, pv.purpose, [{ project_id: projectId }]);
  if (refusal) return refusal;

  const before = line.project_id == null ? null : Number(line.project_id);
  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_VOUCHER', entityId: pv.id, action: 'UPDATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  /* The leg first, then the line: a retry after a half-done change finds the
     line still old and walks the same two steps again. */
  if (pv.status === 'POSTED') {
    const { data: jes, error: jeErr } = await sb.from('journal_entries')
      .select('id, je_no, reversed').eq('company_id', co.companyId).eq('source_type', 'PV').eq('source_doc_no', pv.pv_number);
    if (jeErr) return c.json({ error: 'load_failed', reason: jeErr.message }, 500);
    const live = ((jes ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null }>).find((j) => !j.reversed);
    if (!live) return c.json({ error: 'no_entry', message: `${pv.pv_number} is approved but its ledger entry was not found — nothing was changed.` }, 409);
    const { data: leg, error: legErr } = await sb.from('journal_entry_lines')
      .select('id, account_code, debit_sen').eq('company_id', co.companyId).eq('journal_entry_id', live.id).eq('line_no', line.line_no).maybeSingle();
    if (legErr) return c.json({ error: 'load_failed', reason: legErr.message }, 500);
    const rawRate = Number(pv.exchange_rate ?? 1);
    const rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
    if (!leg || leg.account_code !== line.debit_account_code || Number(leg.debit_sen) !== Math.round(Number(line.amount_sen) * rate)) {
      return c.json({ error: 'entry_mismatch', message: `${live.je_no} line ${line.line_no} does not match the voucher line — nothing was changed.` }, 409);
    }
    const { error: upLegErr } = await sb.from('journal_entry_lines').update({ project_id: projectId }).eq('company_id', co.companyId).eq('id', leg.id);
    if (upLegErr) return c.json({ error: 'save_failed', reason: upLegErr.message }, 500);
  }
  const { error: upErr } = await scopeToCompany(sb.from('payment_voucher_lines').update({ project_id: projectId }).eq('id', line.id), c);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);

  const change = fieldChange(`line ${line.line_no} event`, before, projectId);
  if (change) {
    await recordEntityAudit(sb, {
      entityType: 'PAYMENT_VOUCHER', entityId: pv.id, entityDocNo: pv.pv_number, action: 'UPDATE',
      actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: pv.status ?? null, fieldChanges: [change], note: 'event changed',
    });
  }
  return c.json({ ok: true, projectId, posted: pv.status === 'POSTED' });
};
accEvents.post('/pv-lines/:lineId/event', retagPvLineHandler);
