// ----------------------------------------------------------------------------
// POST /payment-vouchers/remind { ids } — Remind approver (the owner's Claude
// Design, batch 4 e8; owner 2026-11-03 「主要是付款吧」: payment vouchers only,
// not receipts). A preparer or checker who cannot approve sends the approver a
// note through the ERP's own bell — the system slice of the announcements
// (services/personalNotice.ts), the same delivery the amendment and
// cancellation notices use. Nothing posts and the voucher does not change.
//
//   · Only a checked voucher waits for the approver (pv-approval.ts
//     pvCanRemind); another company's voucher is not found.
//   · One reminder per voucher an hour, whoever sends it. The voucher's own
//     trail is the record (REMIND_APPROVER), so the hour is read from there
//     and the voucher page shows who reminded and when.
//   · The approver is whoever holds scm.payment_voucher.approve (A6: no names
//     on the screen): the users whose role holds it, else — as the To do reads
//     the approver's desk — whoever may approve (permissionHolders.ts
//     usersOnDeskFor). The sender is never their own audience.
//   · One voucher: "<sender> asks you to approve <no> · <payee> · RM x", and
//     the click opens the voucher. Several: ONE note listing them, and the
//     click opens the Checked vouchers — never a card per voucher per person.
//
// Its own file because payment-vouchers.ts sits at the file-size cap.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { chunkIn } from '../lib/paginate-all';
import { recordEntityAudit } from '../lib/entity-audit';
import { pvCanRemind, type PvApprovalShape } from '../lib/pv-approval';
import { fmtDate, fmtMoneySen, fmtSen, fmtTime } from '../shared/format';
import { usersOnDeskFor } from '../../services/permissionHolders';
import { postPersonalNotice } from '../../services/personalNotice';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** One reminder per voucher this often, whoever sends it. */
export const REMIND_EVERY_MS = 60 * 60_000;
/** At most this many vouchers in one request. */
const MAX_IDS = 200;
/** The bell's tag for these notes. `pv_approval:<company>:<voucher>` opens the
    voucher; `pv_approval:<company>` opens the checked vouchers
    (frontend components/systemNoticeLink.ts reads it back). */
export const PV_REMIND_SOURCE = 'pv_approval';
const APPROVE_KEY = 'scm.payment_voucher.approve';
const COLS = 'id, pv_number, status, submitted_at, checked_at, checked_by, approved_at, payee_name, notes, total_sen, currency, exchange_rate';
const LISTED = 8;

type Pv = PvApprovalShape & {
  id: string; pv_number: string; checked_by?: string | null; payee_name?: string | null; notes?: string | null;
  total_sen?: number | null; currency?: string | null; exchange_rate?: string | number | null;
};
type TrailRow = { entity_id: string; created_at: string; actor_name_snapshot: string | null };
export type RemindRefusal = { id: string; pvNumber: string | null; error: 'not_this_company' | 'not_checked' | 'reminded_recently'; message: string };

/** Whoever may see and prepare vouchers today; the approver approves instead. */
export const mayRemindApprover = (c: Ctx): boolean =>
  hasHouzsPerm(c, 'scm.payment_voucher.create') || hasHouzsPerm(c, 'scm.payment_voucher.write') || hasHouzsPerm(c, 'scm.payment_voucher.check');

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
const amountOf = (pv: Pv): string => fmtMoneySen(Number(pv.total_sen ?? 0), String(pv.currency ?? 'MYR'));
/** The ringgit it moves: round(total × rate), as Daily Bank and the post count it. */
const myrSen = (pv: Pv): number => {
  const rate = Number(pv.exchange_rate ?? 1);
  return Math.round(Number(pv.total_sen ?? 0) * (Number.isFinite(rate) && rate > 0 ? rate : 1));
};

function parseIds(body: unknown): string[] | null {
  const raw = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.map((v) => String(v ?? '').trim()).filter((v) => v.length > 0 && v.length <= 64))];
  return ids.length > 0 && ids.length === raw.length ? ids : null;
}

/** Who reminded each voucher last within the hour, read off the trail. */
function lastReminders(rows: TrailRow[]): Map<string, TrailRow> {
  const out = new Map<string, TrailRow>();
  for (const r of rows) {
    const had = out.get(String(r.entity_id));
    if (!had || String(r.created_at) > String(had.created_at)) out.set(String(r.entity_id), r);
  }
  return out;
}

/** What the notice says. One voucher: itself; several: one note that lists them. */
export function remindNotice(sender: string, companyId: number, pvs: Pv[]): { title: string; body: string; source: string } {
  if (pvs.length === 1) {
    const pv = pvs[0]!;
    const payee = clip(oneLine(pv.payee_name) || 'the payee', 60);
    const by = oneLine(pv.checked_by);
    const forLine = clip(oneLine(pv.notes).replace(/[.\s]+$/, ''), 120);
    return {
      title: `${sender} asks you to approve ${pv.pv_number} · ${payee} · ${amountOf(pv)}`,
      body: `Checked${by ? ` by ${by}` : ''} on ${fmtDate(pv.checked_at)}${forLine ? ` · ${forLine}` : ''}. Open it to approve & post.`,
      source: `${PV_REMIND_SOURCE}:${companyId}:${pv.id}`,
    };
  }
  const total = pvs.reduce((s, pv) => s + myrSen(pv), 0);
  const lines = pvs.slice(0, LISTED).map((pv) => `${pv.pv_number} · ${clip(oneLine(pv.payee_name) || '—', 40)} · ${amountOf(pv)}`);
  if (pvs.length > LISTED) lines.push(`…and ${pvs.length - LISTED} more`);
  return {
    title: `${sender} asks you to approve ${pvs.length} payment vouchers · ${fmtSen(total)}`,
    body: `${lines.join('\n')}\nOpen the checked vouchers to approve & post.`,
    source: `${PV_REMIND_SOURCE}:${companyId}`,
  };
}

/** The one sentence a refusal of the whole request carries (under 200 characters, so the client shows it). */
function refusedSentence(refused: RemindRefusal[], nextAt: (r: RemindRefusal) => string | null): string {
  if (refused.length === 1) return refused[0]!.message;
  if (refused.every((r) => r.error === 'reminded_recently')) {
    const next = refused.map(nextAt).filter((v): v is string => v != null).sort()[0];
    return `All ${refused.length} were reminded within the hour. One reminder per voucher an hour${next ? ` — the first can go again after ${fmtTime(next)}` : ''}.`;
  }
  const n = (e: RemindRefusal['error']) => refused.filter((r) => r.error === e).length;
  const parts = [
    n('not_checked') ? `${n('not_checked')} not waiting for approval` : '',
    n('reminded_recently') ? `${n('reminded_recently')} reminded within the hour` : '',
    n('not_this_company') ? `${n('not_this_company')} not in this company` : '',
  ].filter(Boolean);
  return `None of the ${refused.length} vouchers was reminded: ${parts.join(', ')}.`;
}

export const remindApproverHandler = async (c: Ctx): Promise<Response> => {
  if (!mayRemindApprover(c)) return c.json({ error: 'forbidden', message: "You don't have permission to do that." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown = null;
  try { body = await c.req.json(); } catch { /* refused just below */ }
  const ids = parseIds(body);
  if (!ids) return c.json({ error: 'bad_ids', message: 'Which vouchers? Send their ids, each once.' }, 400);
  if (ids.length > MAX_IDS) return c.json({ error: 'too_many', message: `Remind at most ${MAX_IDS} vouchers at a time.` }, 400);

  const sb = c.get('supabase');
  const now = Date.now();
  const read = await chunkIn<Pv>(ids, (batch, f, t) =>
    scopeToCompanyId(sb.from('payment_vouchers').select(COLS).in('id', batch), co.companyId).order('id').range(f, t));
  if (read.error) return c.json({ error: 'load_failed', reason: read.error.message }, 500);
  const trail = await chunkIn<TrailRow>(ids, (batch, f, t) =>
    scopeToCompanyId(sb.from('entity_audit_log').select('entity_id, created_at, actor_name_snapshot'), co.companyId)
      .eq('entity_type', 'PAYMENT_VOUCHER').eq('action', 'REMIND_APPROVER').in('entity_id', batch)
      .gte('created_at', new Date(now - REMIND_EVERY_MS).toISOString()).order('created_at').range(f, t));
  if (trail.error) return c.json({ error: 'load_failed', reason: trail.error.message }, 500);

  const byId = new Map(read.data.map((pv) => [String(pv.id), pv]));
  const recent = lastReminders(trail.data);
  const nextOf = (id: string): string | null => {
    const last = recent.get(id);
    return last ? new Date(new Date(last.created_at).getTime() + REMIND_EVERY_MS).toISOString() : null;
  };
  const due: Pv[] = [];
  const refused: RemindRefusal[] = [];
  for (const id of ids) {
    const pv = byId.get(id);
    if (!pv) { refused.push({ id, pvNumber: null, error: 'not_this_company', message: NOT_THIS_COMPANY.message }); continue; }
    const v = pvCanRemind(pv);
    if (!v.ok) { refused.push({ id, pvNumber: pv.pv_number, error: 'not_checked', message: `${pv.pv_number}: ${v.message}` }); continue; }
    const last = recent.get(id);
    if (last) {
      const by = oneLine(last.actor_name_snapshot);
      refused.push({
        id, pvNumber: pv.pv_number, error: 'reminded_recently',
        message: `${pv.pv_number} was reminded at ${fmtTime(last.created_at)}${by ? ` by ${by}` : ''}. One reminder per voucher an hour — the next can go after ${fmtTime(nextOf(id))}.`,
      });
      continue;
    }
    due.push(pv);
  }
  if (due.length === 0) {
    const status = refused.every((r) => r.error === 'reminded_recently') ? 429 : refused.every((r) => r.error === 'not_this_company') ? 404 : 409;
    return c.json({ error: refused.length === 1 ? refused[0]!.error : 'nothing_reminded', message: refusedSentence(refused, (r) => nextOf(r.id)), refused }, status);
  }

  const houzsUser = c.get('houzsUser') as Variables['houzsUser'] | undefined;
  const senderId = Number(houzsUser?.id) || 0;
  let audience: number[];
  try {
    const desk = await usersOnDeskFor(c.env, APPROVE_KEY, { companyId: co.companyId });
    audience = desk.userIds.filter((id) => id !== senderId);
  } catch (e) {
    return c.json({ error: 'load_failed', reason: `who approves vouchers: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  if (audience.length === 0) {
    return c.json({ error: 'no_approver', message: 'Nobody else may approve payment vouchers in this company, so there is no one to remind.' }, 409);
  }

  const sender = oneLine(houzsUser?.name) || oneLine(houzsUser?.email) || 'Finance';
  await postPersonalNotice(c.env, { userIds: audience, category: 'GENERAL', expiresDays: 7, ...remindNotice(sender, co.companyId, due) });
  /* The trail is the record the hour is read from — after the note went, so a
     note that never left is never counted. A row that fails to write is logged
     by recordEntityAudit; the worst it costs is a second reminder too early. */
  for (const pv of due) {
    await recordEntityAudit(sb, {
      entityType: 'PAYMENT_VOUCHER', entityId: String(pv.id), entityDocNo: pv.pv_number, companyId: co.companyId,
      action: 'REMIND_APPROVER', actor: houzsUser ?? null,
    });
  }
  return c.json({
    reminded: due.map((pv) => ({ id: String(pv.id), pvNumber: pv.pv_number })),
    refused,
    approvers: audience.length,
    nextAt: new Date(now + REMIND_EVERY_MS).toISOString(),
  });
};
