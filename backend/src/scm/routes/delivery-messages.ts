// ---------------------------------------------------------------------------
// delivery-messages.ts — WhatsApp sends from the Delivery Planning board, via
// Houzs Connect (chat.houzscentury.com).
//
// "Send Now" bundles a customer's selected orders into ONE message per CUSTOMER
// PHONE and POSTs to Connect's /api/webhooks/erp (see services/connect.ts),
// which fires the automation the message KIND names (default "New Delivery
// Follow-up"; the full list and what each needs is scm/lib/delivery-message-
// kinds.ts) — Connect sends the Meta-approved template, and for the openers the
// customer's Confirm / Amend tap comes back to /api/chat-callback. Gated on CONNECT_WEBHOOK_URL +
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

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../env';
import { activeCompanyId, companyCodeMap, scopeToAllowedCompanies } from '../lib/companyScope';
import { supabaseAuth } from '../middleware/auth';
import { effectiveSoDelivery, type SoDeliveryDateRow } from '../shared';
import { normalizePhone } from '../shared/phone';
import {
  ASSR_LEG_SEND_KINDS,
  KIND_AFTER_STATUS,
  KIND_AUTOMATION,
  MESSAGE_KINDS,
  OPENER_KINDS,
  kindAttributes,
  movesDeliveryStatus,
  type SendExtras,
} from '../lib/delivery-message-kinds';
import { salesLocationRegion } from '../../lib/delivery-sheet-feed';
import { markSentStatus } from '../lib/delivery-message-status';
import { parseAssrRowKey, sendAssrArrangement } from '../lib/assr-arrangement-message';
import {
  isConnectConfigured,
  buildDeliveryFollowUp,
  buildSyncHeadline,
  postConnectContact,
  parseConnectCompanyProfiles,
  chatCallbackUrl,
  CONNECT_COMPANY_PROFILE_KEY,
  type ConnectOrder,
  type ConnectCompanyProfile,
} from '../../services/connect';
import { buildContactSyncEvent, SYNC_SO_SELECT } from '../lib/connect-contact-sync';
import { chunkIn, inList } from '../lib/paginate-all';

export const deliveryMessages = new Hono<{ Bindings: Env; Variables: Variables }>();

deliveryMessages.use('*', supabaseAuth);

/** The shared E.164 normaliser, so a stored "+6060..." (pre-#4582 header) or
 *  "0176..." is sent as "+60176...", not to a number that does not exist
 *  (HC-0096). Null for a blank phone so the caller can skip (and report) it. */
export function blastPhone(raw: unknown): string | null {
  return normalizePhone(raw == null ? null : String(raw));
}

function payloadDate(iso: string | null | undefined): string {
  return String(iso ?? '').slice(0, 10).replace(/-/g, '/');
}

const sendSchema = z.object({
  docNos: z.array(z.string().min(1)).min(1).max(200),
  kind: z.enum(MESSAGE_KINDS).default('delivery'),
  driverInfo: z.object({
    driverName: z.string().trim().min(1).max(80),
    driverContact: z.string().trim().min(1).max(40),
    driverIc: z.string().trim().max(40).default(''),
    carPlate: z.string().trim().max(20).default(''),
    deliveryTime: z.string().trim().min(1).max(60),
  }).optional(),
});

export interface SendDeliveryMessagesResult {
  sent: Array<{ phone: string; docNos: string[]; httpCode: number }>;
  failed: Array<{ phone: string; docNos: string[]; error: string }>;
  skipped: Array<{ docNo: string; reason: string }>;
  readError?: { code: string; reason: string };
  notLogged: Array<{ phone: string; docNos: string[]; sent: boolean; reason: string }>;
  /** Each order's Delivery Message Status as read before the send (HC-0205). */
  statusAtSend?: Map<string, string | null>;
}

export async function sendDeliveryMessageForDocs(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  docNos: string[],
  kind: (typeof MESSAGE_KINDS)[number],
  extras: SendExtras,
): Promise<SendDeliveryMessagesResult> {
  const sb = c.get('supabase');
  const user = c.get('user') as { id?: string } | null;
  // Who pressed Send (HC-0232): Connect alerts this person if WhatsApp does not
  // deliver. `user` above is the pinned system staff id, shared by every caller.
  const sentByEmail = c.get('houzsUser')?.email;

  const { data: rowsRaw, error: readErr } = await scopeToAllowedCompanies(
    sb.from('mfg_sales_orders')
      // The headline columns (venue / agent / house_type / disposal_request /
      // delivery_message_status) ride along so EVERY send also fills the contact
      // panel's single-value fields (buildSyncHeadline), not only the fields the
      // message's own template uses (owner 2026-11-02).
      // sales_location + customer_country let the East Malaysia kinds gate on
      // region (sheetRegion) so an EM template never goes to a West / SG order.
      .select('doc_no, ref, debtor_name, phone, branding, company_id, customer_delivery_date, amended_delivery_date, amend_reason, venue, agent, house_type, disposal_request, delivery_message_status, delivery_address1, delivery_address2, delivery_address3, delivery_address4, address1, address2, address3, address4, postcode, city, customer_state, sales_location, customer_country')
      .in('doc_no', docNos),
    c,
  );
  if (readErr) return { sent: [], failed: [], skipped: [], notLogged: [], readError: { code: 'load_failed', reason: readErr.message } };
  const rows = (rowsRaw ?? []) as Array<Record<string, unknown>>;

  const isEmKind = kind === 'eastmy_prep' || kind === 'eastmy_shipped' || kind === 'eastmy_arrived';

  if (kind === 'eastmy_shipped') {
    const emDocs = rows.map((r) => String(r.doc_no));
    const { data: doRaw, error: doErr } = await sb.from('delivery_orders')
      .select('so_doc_no, status, consignment_no, eta_arriving_port')
      .in('so_doc_no', emDocs).order('created_at').order('id');
    if (doErr) return { sent: [], failed: [], skipped: [], notLogged: [], readError: { code: 'em_fields_load_failed', reason: doErr.message } };
    const emByDoc = new Map<string, { consignment_no: unknown; eta_arriving_port: unknown }>();
    for (const d of (doRaw as Array<Record<string, unknown>> | null) ?? []) {
      const st = String(d.status ?? '').toUpperCase();
      if (st === 'DRAFT' || st === 'CANCELLED') continue;
      emByDoc.set(String(d.so_doc_no), {
        consignment_no: d.consignment_no ?? null,
        eta_arriving_port: d.eta_arriving_port ?? null,
      });
    }
    for (const r of rows) { const em = emByDoc.get(String(r.doc_no)); if (em) Object.assign(r, em); }
  }

  const byDoc = new Map(rows.map((r) => [String(r.doc_no), r]));
  const skipped: Array<{ docNo: string; reason: string }> = [];
  const byPhoneCompany = new Map<string, { phone: string; companyId: number | null; rows: Array<Record<string, unknown>> }>();
  for (const docNo of docNos) {
    const r = byDoc.get(docNo);
    if (!r) { skipped.push({ docNo, reason: 'not_found' }); continue; }
    const phone = blastPhone(r.phone);
    if (!phone) { skipped.push({ docNo, reason: 'no_phone' }); continue; }
    if (isEmKind && salesLocationRegion(r.sales_location as string | null, r.address3 as string | null, r.customer_country as string | null) !== 'EAST') {
      skipped.push({ docNo, reason: 'not_east' });
      continue;
    }
    const companyId = r.company_id == null ? null : Number(r.company_id);
    const key = `${phone}\u0000${companyId ?? ''}`;
    const g = byPhoneCompany.get(key) ?? { phone, companyId, rows: [] };
    g.rows.push(r);
    byPhoneCompany.set(key, g);
  }

  const sent: Array<{ phone: string; docNos: string[]; httpCode: number }> = [];
  const failed: Array<{ phone: string; docNos: string[]; error: string }> = [];
  const notLogged: SendDeliveryMessagesResult['notLogged'] = [];

  // Per-company message values (signature / bank / disposal) the rebuilt flows
  // reference; read once. A profile keyed by company is config, not business
  // data, so it is read by key and not company-scoped. Unset / malformed
  // app_config => null => no per-company attributes (the message still goes).
  // company-scope: app_config is a global key/value config table, not per-company data.
  const { data: profileRow, error: profileErr } = await sb.from('app_config')
    .select('value').eq('key', CONNECT_COMPANY_PROFILE_KEY).maybeSingle();
  if (profileErr) return { sent, failed, skipped, notLogged, readError: { code: 'profile_load_failed', reason: profileErr.message } };
  const profilesById = parseConnectCompanyProfiles(
    (profileRow as { value?: string | null } | null)?.value ?? null,
  );
  const codeByCompany = companyCodeMap(c);

  const { data: balRaw, error: balErr } = await scopeToAllowedCompanies(
    sb.from('mfg_sales_orders_with_payment_totals')
      .select('doc_no, balance_sen_live, local_total_sen')
      .in('doc_no', docNos),
    c,
  );
  if (balErr) return { sent, failed, skipped, notLogged, readError: { code: 'balance_load_failed', reason: balErr.message } };
  const balanceByDoc = new Map<string, number>();
  const totalByDoc = new Map<string, number>();
  for (const b of (balRaw ?? []) as Array<{ doc_no: string | null; balance_sen_live: number | null; local_total_sen: number | null }>) {
    if (b.doc_no == null) continue;
    if (b.balance_sen_live != null) balanceByDoc.set(String(b.doc_no), Number(b.balance_sen_live));
    if (b.local_total_sen != null) totalByDoc.set(String(b.doc_no), Number(b.local_total_sen));
  }
  const callbackUrl = chatCallbackUrl(c.env);

  for (const { phone, companyId, rows: groupRows } of byPhoneCompany.values()) {
    const groupDocs = groupRows.map((r) => String(r.doc_no));
    const first = groupRows[0] as Record<string, unknown>;
    const owedSen = groupRows.reduce((sum, r) => sum + Math.max(0, balanceByDoc.get(String(r.doc_no)) ?? 0), 0);
    const perKind = kindAttributes(kind, first, effectiveSoDelivery(first as SoDeliveryDateRow), owedSen, extras);
    if (perKind.skip) {
      for (const docNo of groupDocs) skipped.push({ docNo, reason: perKind.skip });
      continue;
    }
    const companyProfile: ConnectCompanyProfile | null = profilesById[String(companyId ?? '')] ?? null;
    const companyCode = companyId != null ? codeByCompany.get(companyId)?.toUpperCase() ?? null : null;
    const sendCtx = {
      callbackUrl,
      automation: KIND_AUTOMATION[kind],
      extra: {
        service_job: '',
        ...buildSyncHeadline(first, phone, payloadDate(effectiveSoDelivery(first as SoDeliveryDateRow))),
        ...perKind.attributes,
        ...(sentByEmail ? { sent_by_email: sentByEmail } : {}),
      },
      resetConversation: OPENER_KINDS.has(kind),
    };
    const orders: ConnectOrder[] = groupRows.map((r) => ({
      // The ERP Sales Order number, always (owner 2026-10-06) — not the AutoCount
      // number an older / imported order may also carry; the chat-callback still
      // resolves either, so an in-flight conversation opened under the old rule
      // is unaffected.
      ref: String(r.doc_no ?? ''),
      orderRef: String(r.ref ?? ''),
      branding: String(r.branding ?? ''),
      deliveryDate: payloadDate(effectiveSoDelivery(r as SoDeliveryDateRow)),
      balanceSen: balanceByDoc.get(String(r.doc_no)) ?? null,
      totalSen: totalByDoc.get(String(r.doc_no)) ?? null,
      companyCode,
    }));
    const contact = buildDeliveryFollowUp(
      phone, String(groupRows[0]?.debtor_name ?? ''), orders, companyProfile, sendCtx,
    );

    const result = await postConnectContact(c.env, contact);

    const batchId = crypto.randomUUID();
    try {
      const { error: logErr } = await sb.from('wa_message_log').insert(groupDocs.map((docNo) => ({
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
      if (logErr) throw new Error(logErr.message);
    } catch (e) {
      const reason = String((e as Error).message).slice(0, 120);
      console.warn(`[delivery-messages] log insert failed: ${reason}`);
      notLogged.push({ phone, docNos: groupDocs, sent: result.ok, reason });
    }

    if (result.ok) sent.push({ phone, docNos: groupDocs, httpCode: result.httpCode ?? 0 });
    else failed.push({ phone, docNos: groupDocs, error: result.error ?? 'send failed' });
  }

  const statusAtSend = new Map(rows.map((r) => [String(r.doc_no), (r.delivery_message_status as string | null) ?? null]));
  return { sent, failed, skipped, notLogged, statusAtSend };
}

export interface SyncContactsResult {
  synced: Array<{ phone: string; docNos: string[]; httpCode: number }>;
  failed: Array<{ phone: string; docNos: string[]; error: string }>;
  skipped: Array<{ docNo: string; reason: string }>;
  readError?: { code: string; reason: string };
}

/* Push each selected order's full field set into its Connect contact WITHOUT
   sending a message (owner 2026-11-02 — the panel sat at 13/65 because a send
   only ever pushed the fields its own template used). Each (phone, company) gets
   the same delivery bundle a send carries (ref_N / ref_no_N / brand_N /
   delivery_date_N / order_amount / company profile) PLUS the single-value
   "headline" fields the panel shows (buildSyncHeadline: Reference No. / Brand /
   Purchase Venue / Sales Person / Delivery State / House Type / Disposal / phone),
   fired under CONNECT_SYNC_AUTOMATION so Connect upserts the attributes and
   triggers nothing. resetConversation:false — a sync must never blank
   button_status and unlock the Delivery Lock. Groups by company like the sender,
   so a 2990 order carries 2990's profile, not the acting user's. */
export async function syncContactsForDocs(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  docNos: string[],
): Promise<SyncContactsResult> {
  const sb = c.get('supabase');
  const user = c.get('user') as { id?: string } | null;

  const { data: rowsRaw, error: readErr } = await scopeToAllowedCompanies(
    sb.from('mfg_sales_orders').select(SYNC_SO_SELECT).in('doc_no', docNos),
    c,
  );
  if (readErr) return { synced: [], failed: [], skipped: [], readError: { code: 'load_failed', reason: readErr.message } };
  const rows = (rowsRaw ?? []) as Array<Record<string, unknown>>;

  const byDoc = new Map(rows.map((r) => [String(r.doc_no), r]));
  const skipped: Array<{ docNo: string; reason: string }> = [];
  const byPhoneCompany = new Map<string, { phone: string; companyId: number | null; rows: Array<Record<string, unknown>> }>();
  for (const docNo of docNos) {
    const r = byDoc.get(docNo);
    if (!r) { skipped.push({ docNo, reason: 'not_found' }); continue; }
    const phone = blastPhone(r.phone);
    if (!phone) { skipped.push({ docNo, reason: 'no_phone' }); continue; }
    const companyId = r.company_id == null ? null : Number(r.company_id);
    const key = `${phone}\u0000${companyId ?? ''}`;
    const g = byPhoneCompany.get(key) ?? { phone, companyId, rows: [] };
    g.rows.push(r);
    byPhoneCompany.set(key, g);
  }

  const synced: Array<{ phone: string; docNos: string[]; httpCode: number }> = [];
  const failed: Array<{ phone: string; docNos: string[]; error: string }> = [];

  // Same fail-closed per-company profile read as the sender (bank / signature /
  // disposal), so a synced balance block is never left without them.
  // company-scope: app_config is a global key/value config table, not per-company data.
  const { data: profileRow, error: profileErr } = await sb.from('app_config')
    .select('value').eq('key', CONNECT_COMPANY_PROFILE_KEY).maybeSingle();
  if (profileErr) return { synced, failed, skipped, readError: { code: 'profile_load_failed', reason: profileErr.message } };
  const profilesById = parseConnectCompanyProfiles((profileRow as { value?: string | null } | null)?.value ?? null);
  const codeByCompany = companyCodeMap(c);

  const { data: balRaw, error: balErr } = await scopeToAllowedCompanies(
    sb.from('mfg_sales_orders_with_payment_totals')
      .select('doc_no, balance_sen_live, local_total_sen')
      .in('doc_no', docNos),
    c,
  );
  if (balErr) return { synced, failed, skipped, readError: { code: 'balance_load_failed', reason: balErr.message } };
  const balanceByDoc = new Map<string, number>();
  const totalByDoc = new Map<string, number>();
  for (const b of (balRaw ?? []) as Array<{ doc_no: string | null; balance_sen_live: number | null; local_total_sen: number | null }>) {
    if (b.doc_no == null) continue;
    if (b.balance_sen_live != null) balanceByDoc.set(String(b.doc_no), Number(b.balance_sen_live));
    if (b.local_total_sen != null) totalByDoc.set(String(b.doc_no), Number(b.local_total_sen));
  }
  const callbackUrl = chatCallbackUrl(c.env);

  for (const { phone, companyId, rows: groupRows } of byPhoneCompany.values()) {
    const groupDocs = groupRows.map((r) => String(r.doc_no));
    const contact = buildContactSyncEvent({
      phone,
      groupRows,
      balanceByDoc,
      totalByDoc,
      companyProfile: profilesById[String(companyId ?? '')] ?? null,
      companyCode: companyId != null ? codeByCompany.get(companyId)?.toUpperCase() ?? null : null,
      callbackUrl,
    });
    const result = await postConnectContact(c.env, contact, { expectTrigger: false });

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
        source: 'connect-sync',
        created_by: user?.id ?? null,
      })));
    } catch (e) {
      console.warn(`[delivery-messages] sync log insert failed: ${String((e as Error).message).slice(0, 120)}`);
    }

    if (result.ok) synced.push({ phone, docNos: groupDocs, httpCode: result.httpCode ?? 0 });
    else failed.push({ phone, docNos: groupDocs, error: result.error ?? 'sync failed' });
  }

  return { synced, failed, skipped };
}

const syncSchema = z.object({
  docNos: z.array(z.string().min(1)).min(1).max(200),
});
deliveryMessages.post('/sync', async (c) => {
  if (!isConnectConfigured(c.env)) {
    return c.json({
      error: 'not_configured',
      reason: 'Houzs Connect is not configured yet — set the CONNECT_WEBHOOK_URL and CONNECT_WEBHOOK_KEY secrets to enable sync.',
    }, 503);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = syncSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const docNos = [...new Set(parsed.data.docNos)];
  const result = await syncContactsForDocs(c, docNos);
  if (result.readError) return c.json({ error: result.readError.code, reason: result.readError.reason }, 500);
  return c.json({ synced: result.synced, failed: result.failed, skipped: result.skipped });
});

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
  const kind = parsed.data.kind;
  const extras: SendExtras = { driverInfo: parsed.data.driverInfo };
  if (kind === 'driver_info' && !extras.driverInfo) {
    return c.json({ error: 'invalid_body', reason: 'Driver Info needs the driver, contact, plate and time.' }, 400);
  }
  // A Service Case leg has no Sales Order to read; its own sender (HC-0171).
  // Only its case read can throw (each send / log is caught), so a throw means
  // nothing went out.
  if (kind === 'assr_arrangement') {
    try {
      return c.json(await sendAssrArrangement(c, docNos, 'assr_arrangement'));
    } catch (e) {
      return c.json({ error: 'load_failed', reason: String((e as Error).message).slice(0, 200) }, 500);
    }
  }
  const assrKeys = ASSR_LEG_SEND_KINDS.has(kind) ? docNos.filter((k) => parseAssrRowKey(k)) : [];
  let assrResult = { sent: [], failed: [], skipped: [] } as Awaited<ReturnType<typeof sendAssrArrangement>>;
  if (assrKeys.length > 0) {
    try {
      assrResult = await sendAssrArrangement(c, assrKeys, kind, extras.driverInfo);
    } catch (e) {
      return c.json({ error: 'load_failed', reason: String((e as Error).message).slice(0, 200) }, 500);
    }
  }
  const soDocNos = assrKeys.length > 0 ? docNos.filter((k) => !assrKeys.includes(k)) : docNos;
  if (soDocNos.length === 0) return c.json({ ...assrResult, statusNotMoved: [] });
  const result = await sendDeliveryMessageForDocs(c, soDocNos, kind, extras);
  if (result.readError) return c.json({ error: result.readError.code, reason: result.readError.reason }, 500);
  const statusNotMoved = movesDeliveryStatus(kind)
    ? await markSentStatus(
        c, result.sent.flatMap((s) => s.docNos), KIND_AFTER_STATUS[kind], KIND_AUTOMATION[kind], result.statusAtSend,
      )
    : [];
  return c.json({
    sent: [...assrResult.sent, ...result.sent],
    failed: [...assrResult.failed, ...result.failed],
    skipped: [...assrResult.skipped, ...result.skipped],
    statusNotMoved,
    ...(result.notLogged.length ? { notLogged: result.notLogged } : {}),
  });
});

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
  const { data, error, truncated } = await chunkIn<{ doc_no: string; success: boolean; http_code: number | null; created_at: string }>(docNos, (part, from, to) =>
    sb.from('wa_message_log')
      .select('doc_no, success, http_code, created_at')
      .eq('source', 'delivery-planning')
      .filter('doc_no', 'in', inList(part))
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (truncated) return c.json({ error: 'load_failed', reason: 'Too many message log rows to read in full.' }, 500);

  const statuses: Record<string, { success: boolean; http_code: number | null; created_at: string }> = {};
  for (const r of (data ?? []) as Array<{ doc_no: string; success: boolean; http_code: number | null; created_at: string }>) {
    if (!(r.doc_no in statuses)) {
      statuses[r.doc_no] = { success: !!r.success, http_code: r.http_code ?? null, created_at: r.created_at };
    }
  }
  return c.json({ statuses });
});

export default deliveryMessages;
