// ---------------------------------------------------------------------------
// assr-arrangement-message.ts — the Service Case (ASSR) WhatsApp from the
// Delivery Planning board, and the customer's Confirm / Amend tap coming back
// (HC-0171, Azza 2026-10-28: "we need also the ASSR customer to tap the
// confirm/amend the date.. then we have a history also with customer").
//
// An ASSR leg row (`<assr_no>#<leg>`, delivery-planning.ts) has no Sales Order
// behind it, so the SO sender (delivery-messages.ts) and the SO tap recorder
// (lib/chat-callback-record.ts) cannot serve it: one reads mfg_sales_orders,
// the other writes SO request columns. This module is their ASSR twin:
//   SEND  — one message per leg, Connect automation "Service Arrangement"
//           (template hc_service_arrangement: name, case no., what we arranged,
//           the date; Confirm Date / Amend Date buttons).
//   TAP   — the answer is recorded in scm.wa_message_log (row key as doc_no, so
//           the board reads it like an SO's) AND on the case's own timeline
//           (assr_activity) — the arrangement history Azza asked for.
// Same rule as the SO side: a customer's date is a REQUEST. Nothing here moves
// the leg's date; Logistics still sets it with "Set job date".
// ---------------------------------------------------------------------------

import type { Context } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env, Variables } from '../env';
import { assrCompanySql } from '../../routes/assr';
import { logActivity } from '../../services/assr';
import { normDate } from '../../services/agents/schedule-reconcile';
import { fmtDate } from '../shared/format';
import { normalizePhone } from '../shared/phone';
import { ASSR_CONFIRMED_COL, ASSR_LEG_AMEND_REASON_COL, ASSR_STATUS_PICK_SOURCE } from './assr-board-scope';
import { chunkIn, inList } from './paginate-all';
import { KIND_AFTER_STATUS, KIND_AUTOMATION, OPENER_KINDS, kindAttributes, templateDate, type DriverInfoInput, type MessageKind } from './delivery-message-kinds';
import { buildDeliveryFollowUp, chatCallbackUrl, postConnectContact } from '../../services/connect';

export type AssrLeg = keyof typeof ASSR_CONFIRMED_COL;

const ASSR_SEND_STATUS_BY_AUTOMATION: Record<string, string> = Object.fromEntries(
  (Object.keys(KIND_AFTER_STATUS) as Array<keyof typeof KIND_AFTER_STATUS>)
    .map((k) => [KIND_AUTOMATION[k], KIND_AFTER_STATUS[k]]),
);

const REQUESTED_COL: Record<AssrLeg, 'customer_pickup_at' | 'inspection_visit_at' | 'do_date'> = {
  customer_pickup: 'customer_pickup_at',
  inspection: 'inspection_visit_at',
  delivery: 'do_date',
};

/** What the customer reads after "We have arranged the ...". */
export const ASSR_LEG_CUSTOMER_LABEL: Record<AssrLeg, string> = {
  customer_pickup: 'service item pickup',
  inspection: 'inspection visit',
  delivery: 'service item delivery',
};

const ASSR_LEG_STAFF_LABEL: Record<AssrLeg, string> = {
  customer_pickup: 'Pickup',
  inspection: 'Inspection',
  delivery: 'Service',
};

const ROW_KEY_RE = /^(.+)#(customer_pickup|inspection|delivery)$/;

/** `ASSR/2610-038#inspection` -> its case number and leg; null for an SO doc. */
export function parseAssrRowKey(key: string): { assrNo: string; leg: AssrLeg } | null {
  const m = ROW_KEY_RE.exec(key);
  return m ? { assrNo: m[1]!, leg: m[2] as AssrLeg } : null;
}

export function isAssrLeg(v: unknown): v is AssrLeg {
  return v === 'customer_pickup' || v === 'inspection' || v === 'delivery';
}

type CaseRow = {
  id: number; assr_no: string; doc_no: string | null; company_id: number | null;
  customer_name: string | null; phone: string | null;
  closed_at: string | null; archived_at: string | null;
} & Partial<Record<string, string | null>>;

const CASE_COLS = `id, assr_no, doc_no, company_id, customer_name, phone, closed_at, archived_at,
  customer_pickup_at, inspection_visit_at, do_date,
  sched_pickup_date, sched_inspection_date, sched_delivery_date,
  pickup_amend_reason, inspection_amend_reason, delivery_amend_reason`;

/** The leg's date as the customer should read it: Logistics' confirmed date,
 *  else Service's requested one. ISO yyyy-mm-dd, or null. */
export function assrLegDate(row: Partial<Record<string, unknown>>, leg: AssrLeg): string | null {
  const v = row[ASSR_CONFIRMED_COL[leg]] ?? row[REQUESTED_COL[leg]];
  const s = String(v ?? '').slice(0, 10);
  return s || null;
}

const dmy = (iso: string | null): string => (iso ? fmtDate(iso) : 'no date');

function assrSendSentence(
  kind: MessageKind,
  phone: string,
  leg: AssrLeg,
  date: string,
  opts: { driverInfo?: DriverInfoInput; reason?: string },
): string {
  const label = ASSR_LEG_STAFF_LABEL[leg];
  if (kind === 'driver_info' && opts.driverInfo) {
    const d = opts.driverInfo;
    return `WhatsApp sent to ${phone}: ${label} driver information for ${dmy(date)} (${d.deliveryTime}, driver ${d.driverName}${d.carPlate ? `, lorry ${d.carPlate}` : ''}).`;
  }
  if (kind === 'postpone') {
    return `WhatsApp sent to ${phone}: ${label} postpone notice — new date ${dmy(date)}${opts.reason ? ` (${opts.reason})` : ''}, customer asked to Confirm or Amend.`;
  }
  if (kind === 'reminder_1' || kind === 'reminder_2' || kind === 'reminder_3') {
    return `WhatsApp sent to ${phone}: ${label} reminder ${kind.slice(-1)} for ${dmy(date)}.`;
  }
  return `WhatsApp sent to ${phone}: ${label} on ${dmy(date)}, customer asked to Confirm or Amend the date.`;
}

export interface AssrSendResult {
  sent: Array<{ phone: string; docNos: string[]; httpCode: number }>;
  failed: Array<{ phone: string; docNos: string[]; error: string }>;
  skipped: Array<{ docNo: string; reason: string }>;
}

/** Send one of the ASSR-capable message kinds for each Service Case leg row key,
 *  the Service Case twin of the SO sender (delivery-messages.ts). `kind` picks
 *  the Connect automation and what it carries beyond the shared leg bundle
 *  (full_name / assr_no / service_job / the leg's date):
 *    assr_arrangement — the date message, Confirm / Amend (opener).
 *    driver_info      — the button-less driver card (name / IC / time / lorry).
 *    postpone         — we are moving the date: the leg's own Amend Reason +
 *                       confirmed ("Delivery Date") vs requested date, Confirm /
 *                       Amend (opener). Skips a leg missing either, like the SO.
 *    reminder_1/2/3   — a plain nudge; no reply yet (not an opener).
 *  Cases are read through the caller's granted companies (assrCompanySql) — the
 *  same scope the board showed the row under. One message per leg: the templates
 *  name one date. Nothing here moves a leg's date; Logistics still sets it. */
export async function sendAssrArrangement(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  rowKeys: string[],
  kind: MessageKind,
  driverInfo?: DriverInfoInput,
): Promise<AssrSendResult> {
  const sent: AssrSendResult['sent'] = [];
  const failed: AssrSendResult['failed'] = [];
  const skipped: AssrSendResult['skipped'] = [];

  const legs: Array<{ key: string; assrNo: string; leg: AssrLeg }> = [];
  for (const key of rowKeys) {
    const p = parseAssrRowKey(key);
    if (!p) { skipped.push({ docNo: key, reason: 'not_assr' }); continue; }
    legs.push({ key, ...p });
  }
  if (legs.length === 0) return { sent, failed, skipped };

  const nos = [...new Set(legs.map((l) => l.assrNo))];
  const { results } = await c.env.DB.prepare(
    `SELECT ${CASE_COLS} FROM assr_cases WHERE assr_no IN (${nos.map(() => '?').join(', ')})${assrCompanySql(c)}`,
  ).bind(...nos).all<CaseRow>();
  const byNo = new Map((results ?? []).map((r) => [String(r.assr_no), r]));

  const sb = c.get('supabase');
  const userId = c.get('houzsUser')?.id ?? null;
  // Who pressed Send (HC-0232): Connect alerts this person if WhatsApp does not deliver.
  const sentByEmail = c.get('houzsUser')?.email;
  const callbackUrl = chatCallbackUrl(c.env);

  for (const { key, assrNo, leg } of legs) {
    const row = byNo.get(assrNo);
    if (!row) { skipped.push({ docNo: key, reason: 'not_found' }); continue; }
    if (row.closed_at || row.archived_at) { skipped.push({ docNo: key, reason: 'case_closed' }); continue; }
    const phone = normalizePhone(row.phone);
    if (!phone) { skipped.push({ docNo: key, reason: 'no_phone' }); continue; }
    const date = assrLegDate(row, leg);
    if (!date) { skipped.push({ docNo: key, reason: 'no_job_date' }); continue; }

    const extra: Record<string, string> = { service_job: ASSR_LEG_CUSTOMER_LABEL[leg], assr_leg: leg, ref_2: String(row.doc_no ?? ''), assr_no: assrNo };
    if (kind === 'driver_info' || kind === 'postpone') {
      const pseudoRow = kind === 'postpone'
        ? {
            amend_reason: row[ASSR_LEG_AMEND_REASON_COL[leg]],
            amended_delivery_date: row[ASSR_CONFIRMED_COL[leg]],
            customer_delivery_date: row[REQUESTED_COL[leg]],
          }
        : {};
      const perKind = kindAttributes(kind, pseudoRow, date, 0, kind === 'driver_info' ? { driverInfo } : undefined);
      if (perKind.skip) { skipped.push({ docNo: key, reason: perKind.skip }); continue; }
      Object.assign(extra, perKind.attributes);
    }
    if (sentByEmail) extra.sent_by_email = sentByEmail;
    const contact = buildDeliveryFollowUp(
      phone,
      String(row.customer_name ?? ''),
      [{ ref: assrNo, orderRef: '', branding: '', deliveryDate: templateDate(date), balanceSen: null }],
      null,
      {
        callbackUrl,
        automation: KIND_AUTOMATION[kind],
        extra,
        resetConversation: OPENER_KINDS.has(kind),
      },
    );
    const result = await postConnectContact(c.env, contact);

    try {
      await sb.from('wa_message_log').insert({
        batch_id: crypto.randomUUID(),
        company_id: row.company_id ?? null,
        doc_no: key,
        phone,
        payload: JSON.stringify(contact),
        http_code: result.httpCode,
        success: result.ok,
        error: result.error,
        source: 'delivery-planning',
        created_by: c.get('user')?.id ?? null,
      });
    } catch (e) {
      console.warn(`[assr-arrangement] log insert failed: ${String((e as Error).message).slice(0, 120)}`);
    }
    if (result.ok) {
      try {
        await logActivity(c.env, row.id, 'whatsapp_sent', null, date,
          assrSendSentence(kind, phone, leg, date, { driverInfo, reason: extra.amend_date_reason_2 }),
          userId, { category: 'service', source_channel: 'whatsapp' });
      } catch (e) {
        console.warn(`[assr-arrangement] activity insert failed: ${String((e as Error).message).slice(0, 120)}`);
      }
      sent.push({ phone, docNos: [key], httpCode: result.httpCode ?? 0 });
    } else {
      failed.push({ phone, docNos: [key], error: result.error ?? 'send failed' });
    }
  }
  return { sent, failed, skipped };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js schema generics; the call sites are typed
type AnySchemaClient = SupabaseClient<any, any, any, any, any>;

export interface AssrTapInput {
  companyId: number | null;
  assrNo: string;
  leg: AssrLeg;
  callbackId: string | null;
  event: 'confirm' | 'amend';
  phone: string | null;
  requestedDate: string | null;
  reason: string | null;
  note: string | null;
}

export class AssrTapFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssrTapFailed';
  }
}

/** Record one Confirm / Amend tap on a Service Case leg. null = no such case
 *  for this company (the route answers it like an unknown SO ref). */
export async function recordAssrChatTap(
  env: Env,
  sb: AnySchemaClient,
  input: AssrTapInput,
): Promise<{ docNo: string; id: string | null; duplicate: boolean } | null> {
  const { companyId, assrNo, leg, callbackId, event, phone, requestedDate, reason, note } = input;
  const row = await env.DB.prepare(
    `SELECT ${CASE_COLS} FROM assr_cases WHERE assr_no = ?${companyId != null ? ' AND company_id = ?' : ''} LIMIT 1`,
  ).bind(...(companyId != null ? [assrNo, companyId] : [assrNo])).first<CaseRow>();
  if (!row) return null;
  const docNo = `${assrNo}#${leg}`;

  if (callbackId) {
    let dupeQuery = sb.from('wa_message_log').select('id')
      .eq('source', 'chat-callback').eq('doc_no', docNo)
      .like('payload', `%"callback_id":"${callbackId}"%`);
    if (companyId != null) dupeQuery = dupeQuery.eq('company_id', companyId);
    const { data: dupe, error: dupeErr } = await dupeQuery.limit(1);
    if (dupeErr) throw new AssrTapFailed(dupeErr.message);
    if (dupe && dupe.length > 0) return { docNo, id: (dupe[0] as { id: string }).id, duplicate: true };
  }

  const label = ASSR_LEG_STAFF_LABEL[leg];
  const iso = normDate(requestedDate);
  const sentence = event === 'confirm'
    ? `Customer confirmed the ${label} date (${dmy(assrLegDate(row, leg))}) in WhatsApp.`
    : `Customer asked to move the ${label} to ${iso ? dmy(iso) : (requestedDate ?? 'another date')}${reason ? ` (${reason})` : ''} in WhatsApp.`;
  try {
    await logActivity(env, row.id, event === 'confirm' ? 'whatsapp_confirm' : 'whatsapp_amend',
      null, event === 'amend' ? (iso ?? requestedDate) : null, sentence, null,
      { category: 'customer', source_channel: 'whatsapp' });
  } catch (e) {
    throw new AssrTapFailed(String((e as Error).message));
  }

  const { data: inserted, error: insErr } = await sb.from('wa_message_log').insert({
    batch_id: crypto.randomUUID(),
    company_id: row.company_id ?? companyId,
    doc_no: docNo,
    phone: phone ?? '',
    payload: JSON.stringify({ callback_id: callbackId, event, ref: assrNo, leg, phone, requested_delivery_date: requestedDate, reason, note }),
    http_code: null,
    success: true,
    error: null,
    source: 'chat-callback',
    created_by: null,
  }).select('id').limit(1);
  if (insErr) throw new AssrTapFailed(insErr.message);
  return { docNo, id: (inserted?.[0] as { id: string } | undefined)?.id ?? null, duplicate: false };
}

/** The board fields an ASSR leg row takes from its WhatsApp record — the SO
 *  row carries these as columns; an ASSR row derives them from the latest log
 *  row of each kind. */
export interface AssrChatState {
  delivery_message_status: string | null;
  amend_date_from_customer: string | null;
  amend_reason_from_customer: string | null;
}

type LogRow = { doc_no: string; source: string; success: boolean; payload: string | null; created_at: string };

/** Fold the log rows (any order) into each row key's board state. The newest
 *  row wins: a fresh send after an amend clears the old request, and a staff pick
 *  replaces the status but leaves the customer's request on the row. */
export function assrChatStateFromLog(rows: LogRow[]): Map<string, AssrChatState> {
  const out = new Map<string, AssrChatState>();
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const r of sorted) {
    let p: { event?: string; requested_delivery_date?: string | null; reason?: string | null; automation?: string; status?: string | null } = {};
    try { p = JSON.parse(r.payload ?? '{}'); } catch { p = {}; }
    if (r.source === ASSR_STATUS_PICK_SOURCE) {
      const prev = out.get(r.doc_no);
      out.set(r.doc_no, {
        delivery_message_status: p.status ?? null,
        amend_date_from_customer: prev?.amend_date_from_customer ?? null,
        amend_reason_from_customer: prev?.amend_reason_from_customer ?? null,
      });
      continue;
    }
    if (r.source === 'delivery-planning') {
      if (!r.success) continue;
      const status = (p.automation && ASSR_SEND_STATUS_BY_AUTOMATION[p.automation]) || 'Done Send';
      out.set(r.doc_no, { delivery_message_status: status, amend_date_from_customer: null, amend_reason_from_customer: null });
      continue;
    }
    if (p.event === 'confirm') {
      out.set(r.doc_no, { delivery_message_status: 'Done Scheduling', amend_date_from_customer: null, amend_reason_from_customer: null });
    } else if (p.event === 'amend') {
      out.set(r.doc_no, {
        delivery_message_status: 'Pending Reschedule (D)',
        amend_date_from_customer: normDate(p.requested_delivery_date ?? null),
        amend_reason_from_customer: p.reason ?? null,
      });
    }
  }
  return out;
}

/** Read the WhatsApp record for these ASSR row keys. Throws on a failed read;
 *  the board caller treats that as "no state", never as a broken board. */
export async function loadAssrChatState(sb: AnySchemaClient, rowKeys: string[]): Promise<Map<string, AssrChatState>> {
  if (rowKeys.length === 0) return new Map();
  const { data, error, truncated } = await chunkIn<LogRow>(rowKeys, (part, from, to) =>
    sb.from('wa_message_log')
      .select('doc_no, source, success, payload, created_at')
      .filter('doc_no', 'in', inList(part))
      .in('source', ['delivery-planning', 'chat-callback', ASSR_STATUS_PICK_SOURCE])
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to));
  if (error) throw new Error(error.message);
  if (truncated) throw new Error('wa_message_log: too many rows to read in full');
  return assrChatStateFromLog(data);
}

/** Put each open ASSR leg row's WhatsApp state onto the board row, in place.
 *  Best-effort: a failed read leaves the rows as they were (dashes). */
export async function overlayAssrChatState(
  sb: AnySchemaClient,
  rows: Array<{ so_doc_no: string; delivery_state: string } & AssrChatState>,
): Promise<void> {
  const open = rows.filter((r) => r.delivery_state !== 'DELIVERED');
  try {
    const state = await loadAssrChatState(sb, open.map((r) => r.so_doc_no));
    for (const r of open) Object.assign(r, state.get(r.so_doc_no) ?? {});
  } catch (e) {
    console.warn(`[delivery-planning] ASSR WhatsApp state skipped: ${String((e as Error).message).slice(0, 120)}`);
  }
}
