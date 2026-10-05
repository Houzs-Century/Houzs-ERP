// ---------------------------------------------------------------------------
// delivery-messages.ts — WhatsApp sends from the Delivery Planning board, via
// Houzs Connect (chat.houzscentury.com).
//
// "Send Now" bundles a customer's selected orders into ONE message per CUSTOMER
// PHONE and POSTs to Connect's /api/webhooks/erp (see services/connect.ts),
// which fires the "New Delivery Follow-up" automation — Connect sends the
// Meta-approved template with Confirm / Amend buttons, and the customer's tap
// comes back to /api/chat-callback. Gated on CONNECT_WEBHOOK_URL +
// CONNECT_WEBHOOK_KEY; until both are set /send answers 503 not_configured and
// writes nothing — the UI ships before the credentials.
//
// Every real attempt (success or fail) is logged to scm.wa_message_log
// (mig 0185), one row per doc with a shared batch_id per phone, so the board
// shows a per-row "Message" status. (Replaced the retired Seampify gateway,
// owner 2026-09-28.)
//
// Mounted at /api/scm/delivery-messages under scm.transportation.drivers —
// the same area as the board itself.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../env';
import { activeCompanyId, scopeToAllowedCompanies } from '../lib/companyScope';
import { supabaseAuth } from '../middleware/auth';
import { effectiveSoDelivery, type SoDeliveryDateRow } from '../shared';
import {
  isConnectConfigured,
  buildDeliveryFollowUp,
  postConnectContact,
  parseConnectCompanyProfiles,
  chatCallbackUrl,
  CONNECT_COMPANY_PROFILE_KEY,
  type ConnectOrder,
  type ConnectCompanyProfile,
} from '../../services/connect';

export const deliveryMessages = new Hono<{ Bindings: Env; Variables: Variables }>();

// Same client wiring every scm sub-router carries (see dp-orders.ts — a router
// without it has no c.get('supabase') and 500s on the first query).
deliveryMessages.use('*', supabaseAuth);

/** Digits-only, then '+'-prefixed — the sheet-era fix: the first BulkSend
 *  failed until the phone carried the '+'. Returns null for an empty/blank
 *  phone so the caller can skip (and report) the row instead of sending into
 *  the void. */
function normalizePhone(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? `+${digits}` : null;
}

/** ISO YYYY-MM-DD → the template payload's YYYY/MM/DD. */
function payloadDate(iso: string | null | undefined): string {
  return String(iso ?? '').slice(0, 10).replace(/-/g, '/');
}

const sendSchema = z.object({
  docNos: z.array(z.string().min(1)).min(1).max(200),
});

/* ── POST /send — one Houzs Connect call per customer phone ────────────────── */
deliveryMessages.post('/send', async (c) => {
  if (!isConnectConfigured(c.env)) {
    return c.json({
      error: 'not_configured',
      reason: 'Houzs Connect is not configured yet — set the CONNECT_WEBHOOK_URL and CONNECT_WEBHOOK_KEY secrets to enable sending.',
    }, 503);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const docNos = [...new Set(parsed.data.docNos)];

  const sb = c.get('supabase');
  const user = c.get('user') as { id?: string } | null;

  // The message fields, straight off the SO header (the board's own source).
  const { data: rowsRaw, error: readErr } = await scopeToAllowedCompanies(
    sb.from('mfg_sales_orders')
      .select('doc_no, linked_ac_docno, debtor_name, phone, branding, customer_delivery_date, amended_delivery_date')
      .in('doc_no', docNos),
    c,
  );
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  const rows = (rowsRaw ?? []) as Array<Record<string, unknown>>;

  const byDoc = new Map(rows.map((r) => [String(r.doc_no), r]));
  const skipped: Array<{ docNo: string; reason: string }> = [];
  // Group by normalized phone — ONE message per customer phone.
  const byPhone = new Map<string, Array<Record<string, unknown>>>();
  for (const docNo of docNos) {
    const r = byDoc.get(docNo);
    if (!r) { skipped.push({ docNo, reason: 'not_found' }); continue; }
    const phone = normalizePhone(r.phone);
    if (!phone) { skipped.push({ docNo, reason: 'no_phone' }); continue; }
    const arr = byPhone.get(phone) ?? [];
    arr.push(r);
    byPhone.set(phone, arr);
  }

  const sent: Array<{ phone: string; docNos: string[]; httpCode: number }> = [];
  const failed: Array<{ phone: string; docNos: string[]; error: string }> = [];

  // Per-company message values (signature / bank / disposal) the rebuilt flows
  // reference; read once. A profile keyed by company is config, not business
  // data, so it is read by key and not company-scoped. Unset / malformed
  // app_config => null => no per-company attributes (the message still goes).
  // company-scope: app_config is a global key/value config table, not per-company data.
  const { data: profileRow, error: profileErr } = await sb.from('app_config')
    .select('value').eq('key', CONNECT_COMPANY_PROFILE_KEY).maybeSingle();
  // A FAILED read is not "no profile": sending without it would hand the
  // customer a balance paragraph with no bank details and no signature, and
  // the staff would never know. Refuse; nothing has been sent yet.
  if (profileErr) return c.json({ error: 'profile_load_failed', reason: profileErr.message }, 500);
  const companyProfile: ConnectCompanyProfile | null =
    parseConnectCompanyProfiles((profileRow as { value?: string | null } | null)?.value ?? null)[
      String(activeCompanyId(c) ?? '')
    ] ?? null;

  // LIVE balance per SO — the SO list's own source of truth
  // (mfg_sales_orders_with_payment_totals.balance_sen_live = local_total −
  // Σpayments), NOT the base table's balance_sen, which nothing maintains.
  // VIEW-TRAP (backend/docs/scm-view-trap-coe.md): only view-native columns
  // here, never a base-table header column added after the view was recreated.
  // Same fail-closed rule as the profile: a balance we could not read must not
  // go out as "nothing owed".
  const { data: balRaw, error: balErr } = await scopeToAllowedCompanies(
    sb.from('mfg_sales_orders_with_payment_totals')
      .select('doc_no, balance_sen_live')
      .in('doc_no', docNos),
    c,
  );
  if (balErr) return c.json({ error: 'balance_load_failed', reason: balErr.message }, 500);
  const balanceByDoc = new Map<string, number>();
  for (const b of (balRaw ?? []) as Array<{ doc_no: string | null; balance_sen_live: number | null }>) {
    if (b.doc_no != null && b.balance_sen_live != null) balanceByDoc.set(String(b.doc_no), Number(b.balance_sen_live));
  }
  const sendCtx = { callbackUrl: chatCallbackUrl(c.env) };

  for (const [phone, group] of byPhone) {
    const groupDocs = group.map((r) => String(r.doc_no));
    // ONE message per customer phone. buildDeliveryFollowUp shows the first 3
    // orders and carries the TRUE count in order_total, so a customer with 4+
    // orders gets a single "first 3 of N" message, not several sends. ref = the
    // number the customer knows (AutoCount doc if linked, else ours); effective
    // (amended ?? original) date as yyyy/mm/dd, same as the board.
    const orders: ConnectOrder[] = group.map((r) => ({
      ref: String(r.linked_ac_docno ?? r.doc_no ?? ''),
      branding: String(r.branding ?? ''),
      deliveryDate: payloadDate(effectiveSoDelivery(r as SoDeliveryDateRow)),
      balanceSen: balanceByDoc.get(String(r.doc_no)) ?? null,
    }));
    const contact = buildDeliveryFollowUp(
      phone, String(group[0]?.debtor_name ?? ''), orders, companyProfile, sendCtx,
    );

    const result = await postConnectContact(c.env, contact);

    // Log one row per doc (all of the phone's docs, not only the 3 shown — the
    // send covers them all), tied by batch_id. Best-effort: a log failure must
    // not turn a delivered WhatsApp into a reported error — but it is COUNTED
    // (console.warn), never silently dropped.
    const batchId = crypto.randomUUID();
    try {
      await sb.from('wa_message_log').insert(groupDocs.map((docNo) => ({
        batch_id: batchId,
        company_id: activeCompanyId(c) ?? null,
        doc_no: docNo,
        phone,
        payload: JSON.stringify(contact),
        http_code: result.httpCode,
        success: result.ok,
        error: result.error,
        source: 'delivery-planning',
        created_by: user?.id ?? null,
      })));
    } catch (e) {
      console.warn(`[delivery-messages] log insert failed: ${String((e as Error).message).slice(0, 120)}`);
    }

    if (result.ok) sent.push({ phone, docNos: groupDocs, httpCode: result.httpCode ?? 0 });
    else failed.push({ phone, docNos: groupDocs, error: result.error ?? 'send failed' });
  }

  return c.json({ sent, failed, skipped });
});

/* ── POST /statuses — latest send status per doc (board "Message" column) ──── */
const statusesSchema = z.object({
  docNos: z.array(z.string().min(1)).min(1).max(1000),
});

deliveryMessages.post('/statuses', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = statusesSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const docNos = [...new Set(parsed.data.docNos)];

  const sb = c.get('supabase');
  // source='delivery-planning' is load-bearing, not tidiness. wa_message_log
  // also carries INBOUND rows now — routes/chatCallback.ts writes what the
  // customer tapped with source='chat-callback' — and those are newer than the
  // send they answer. Without this predicate the "first hit per doc" below
  // would hand the board the customer's reply as if it were the send status,
  // i.e. every answered message would report itself as freshly sent.
  const { data, error } = await sb.from('wa_message_log')
    .select('doc_no, success, http_code, created_at')
    .eq('source', 'delivery-planning')
    .in('doc_no', docNos)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  // First hit per doc = the latest (ordered DESC above).
  const statuses: Record<string, { success: boolean; http_code: number | null; created_at: string }> = {};
  for (const r of (data ?? []) as Array<{ doc_no: string; success: boolean; http_code: number | null; created_at: string }>) {
    if (!(r.doc_no in statuses)) {
      statuses[r.doc_no] = { success: !!r.success, http_code: r.http_code ?? null, created_at: r.created_at };
    }
  }
  return c.json({ statuses });
});

export default deliveryMessages;
