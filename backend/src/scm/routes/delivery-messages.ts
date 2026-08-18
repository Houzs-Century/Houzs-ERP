// ---------------------------------------------------------------------------
// delivery-messages.ts — WhatsApp (Seampify) sends from the Delivery Planning
// board.
//
// Owner 2026-07-22: the board takes over the sheet-era "BulkSend" Apps Script.
// One WhatsApp per CUSTOMER PHONE bundling all their selected orders — the
// exact payload shape the sheet's "Delivery Logs" tab recorded:
//   { phone: '+60...', total_item: N,
//     ref_1, branding_1, debtor_name_1, delivery_date_1, address4_1,
//     ref_2, ... }
// The Seampify endpoint + key come from env (SEAMPIFY_SEND_URL /
// SEAMPIFY_API_KEY, wrangler secrets). Until BOTH are set, /send answers 503
// not_configured and writes nothing — the UI ships before the credentials.
// Every real attempt (success or fail) is logged to scm.wa_message_log
// (mig 0185), one row per doc with a shared batch_id per phone, so the board
// shows a per-row "Message" status.
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

/** ISO YYYY-MM-DD → the sheet payload's YYYY/MM/DD. */
function payloadDate(iso: string | null | undefined): string {
  return String(iso ?? '').slice(0, 10).replace(/-/g, '/');
}

const sendSchema = z.object({
  docNos: z.array(z.string().min(1)).min(1).max(200),
});

/* ── POST /send — one Seampify call per customer phone ─────────────────────── */
deliveryMessages.post('/send', async (c) => {
  const url = c.env.SEAMPIFY_SEND_URL;
  const key = c.env.SEAMPIFY_API_KEY;
  if (!url || !key) {
    return c.json({
      error: 'not_configured',
      reason: 'Seampify is not configured yet — set the SEAMPIFY_SEND_URL and SEAMPIFY_API_KEY secrets to enable sending.',
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
      .select('doc_no, debtor_name, phone, branding, address4, customer_delivery_date, amended_delivery_date')
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

  for (const [phone, group] of byPhone) {
    // The sheet-era BulkSend payload, byte-compatible: numbered per-item vars.
    const payload: Record<string, unknown> = { phone, total_item: group.length };
    group.forEach((r, i) => {
      const n = i + 1;
      payload[`ref_${n}`] = String(r.doc_no ?? '');
      payload[`branding_${n}`] = String(r.branding ?? '');
      payload[`debtor_name_${n}`] = String(r.debtor_name ?? '');
      // Effective date rule (amended ?? original), same as the board.
      payload[`delivery_date_${n}`] = payloadDate(
        effectiveSoDelivery(r as SoDeliveryDateRow),
      );
      payload[`address4_${n}`] = String(r.address4 ?? '');
    });
    const groupDocs = group.map((r) => String(r.doc_no));

    let httpCode: number | null = null;
    let ok = false;
    let errText: string | null = null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
      httpCode = res.status;
      ok = res.ok;
      if (!res.ok) errText = (await res.text().catch(() => '')).slice(0, 300) || `HTTP ${res.status}`;
    } catch (e) {
      errText = String((e as Error)?.message ?? e).slice(0, 300);
    }

    // Log one row per doc, tied by batch_id. Best-effort: a log failure must
    // not turn a delivered WhatsApp into a reported error — but it is COUNTED
    // (console.warn), never silently dropped.
    const batchId = crypto.randomUUID();
    try {
      await sb.from('wa_message_log').insert(groupDocs.map((docNo) => ({
        batch_id: batchId,
        company_id: activeCompanyId(c) ?? null,
        doc_no: docNo,
        phone,
        payload: JSON.stringify(payload),
        http_code: httpCode,
        success: ok,
        error: errText,
        source: 'delivery-planning',
        created_by: user?.id ?? null,
      })));
    } catch (e) {
      console.warn(`[delivery-messages] log insert failed: ${String((e as Error).message).slice(0, 120)}`);
    }

    if (ok) sent.push({ phone, docNos: groupDocs, httpCode: httpCode ?? 0 });
    else failed.push({ phone, docNos: groupDocs, error: errText ?? 'send failed' });
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
  const { data, error } = await sb.from('wa_message_log')
    .select('doc_no, success, http_code, created_at')
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
