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
import { ASSR_CONFIRMED_COL } from './assr-board-scope';
import { KIND_AUTOMATION, templateDate } from './delivery-message-kinds';
import { buildDeliveryFollowUp, chatCallbackUrl, postConnectContact } from '../../services/connect';

export type AssrLeg = keyof typeof ASSR_CONFIRMED_COL;

/** Service's own (requested) date column per leg — the confirmed one is
 *  ASSR_CONFIRMED_COL. Same pairing assrBoardLegs reads. */
const REQUESTED_COL: Record<AssrLeg, 'customer_pickup_at' | 'inspection_visit_at' | 'do_date'> = {
  customer_pickup: 'customer_pickup_at',
  inspection: 'inspection_visit_at',
  delivery: 'do_date',
};

/** What the customer reads after "We have arranged the ...". */
export const ASSR_LEG_CUSTOMER_LABEL: Record<AssrLeg, string> = {
  customer_pickup: 'furniture pickup',
  inspection: 'inspection visit',
  delivery: 'return delivery',
};

/** What staff read on the timeline — the board's own names (ASSR_JOB_KIND_LABEL). */
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
  id: number; assr_no: string; company_id: number | null;
  customer_name: string | null; phone: string | null;
  closed_at: string | null; archived_at: string | null;
} & Partial<Record<string, string | null>>;

const CASE_COLS = `id, assr_no, company_id, customer_name, phone, closed_at, archived_at,
  customer_pickup_at, inspection_visit_at, do_date,
  sched_pickup_date, sched_inspection_date, sched_delivery_date`;

/** The leg's date as the customer should read it: Logistics' confirmed date,
 *  else Service's requested one. ISO yyyy-mm-dd, or null. */
export function assrLegDate(row: Partial<Record<string, unknown>>, leg: AssrLeg): string | null {
  const v = row[ASSR_CONFIRMED_COL[leg]] ?? row[REQUESTED_COL[leg]];
  const s = String(v ?? '').slice(0, 10);
  return s || null;
}

/** dd/mm/yyyy for the timeline sentence. */
const dmy = (iso: string | null): string => (iso ? fmtDate(iso) : 'no date');

export interface AssrSendResult {
  sent: Array<{ phone: string; docNos: string[]; httpCode: number }>;
  failed: Array<{ phone: string; docNos: string[]; error: string }>;
  skipped: Array<{ docNo: string; reason: string }>;
}

/** Send the Service Arrangement message for each ASSR leg row key. Cases are
 *  read through the caller's granted companies (assrCompanySql) — the same
 *  scope the board showed the row under. One message per leg: the template
 *  names one case and one date. */
export async function sendAssrArrangement(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  rowKeys: string[],
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
  const callbackUrl = chatCallbackUrl(c.env);

  for (const { key, assrNo, leg } of legs) {
    const row = byNo.get(assrNo);
    if (!row) { skipped.push({ docNo: key, reason: 'not_found' }); continue; }
    if (row.closed_at || row.archived_at) { skipped.push({ docNo: key, reason: 'case_closed' }); continue; }
    const phone = normalizePhone(row.phone);
    if (!phone) { skipped.push({ docNo: key, reason: 'no_phone' }); continue; }
    const date = assrLegDate(row, leg);
    if (!date) { skipped.push({ docNo: key, reason: 'no_job_date' }); continue; }

    const contact = buildDeliveryFollowUp(
      phone,
      String(row.customer_name ?? ''),
      [{ ref: assrNo, orderRef: '', branding: '', deliveryDate: templateDate(date), balanceSen: null }],
      null,
      {
        callbackUrl,
        automation: KIND_AUTOMATION.assr_arrangement,
        extra: { service_job: ASSR_LEG_CUSTOMER_LABEL[leg], assr_leg: leg },
        resetConversation: true,
      },
    );
    const result = await postConnectContact(c.env, contact);

    // Best-effort, like the SO sender's log: the WhatsApp has left either way.
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
          `WhatsApp sent to ${phone}: ${ASSR_LEG_STAFF_LABEL[leg]} on ${dmy(date)}, customer asked to Confirm or Amend the date.`,
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
  /** HOUZS id resolved by the route (null only in the single-company state). */
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

  // Idempotency — the same contract recordChatTap keeps for an SO.
  if (callbackId) {
    let dupeQuery = sb.from('wa_message_log').select('id')
      .eq('source', 'chat-callback').eq('doc_no', docNo)
      .like('payload', `%"callback_id":"${callbackId}"%`);
    if (companyId != null) dupeQuery = dupeQuery.eq('company_id', companyId);
    const { data: dupe, error: dupeErr } = await dupeQuery.limit(1);
    if (dupeErr) throw new AssrTapFailed(dupeErr.message);
    if (dupe && dupe.length > 0) return { docNo, id: (dupe[0] as { id: string }).id, duplicate: true };
  }

  // Timeline first, then the log row that marks the tap as handled: a log
  // failure makes chat retry, which at worst repeats one history line; the
  // other order would let a retry skip the history for good.
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
 *  row wins: a fresh send after an amend clears the old request. */
export function assrChatStateFromLog(rows: LogRow[]): Map<string, AssrChatState> {
  const out = new Map<string, AssrChatState>();
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const r of sorted) {
    if (r.source === 'delivery-planning') {
      if (!r.success) continue;
      out.set(r.doc_no, { delivery_message_status: 'Done Send', amend_date_from_customer: null, amend_reason_from_customer: null });
      continue;
    }
    let p: { event?: string; requested_delivery_date?: string | null; reason?: string | null } = {};
    try { p = JSON.parse(r.payload ?? '{}'); } catch { continue; }
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
  const { data, error } = await sb.from('wa_message_log')
    .select('doc_no, source, success, payload, created_at')
    .in('doc_no', rowKeys)
    .in('source', ['delivery-planning', 'chat-callback'])
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);
  return assrChatStateFromLog((data ?? []) as LogRow[]);
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
