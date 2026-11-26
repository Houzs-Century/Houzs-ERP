
/** The Connect automation the delivery follow-up triggers, matched BY NAME.
 *  Must equal the automation's name in chat.houzscentury.com exactly. */
export const CONNECT_DELIVERY_AUTOMATION = 'New Delivery Follow-up';

/** The Connect automation fired when a Service Case (ASSR) is created, matched
 *  BY NAME — must equal the automation's name in chat.houzscentury.com exactly.
 *  Its flow sends the button-less template hc_service_case_received (params
 *  full_name + ref_1 = the SO/order ref + assr_no) acknowledging the request.
 *  Re-enabled 2026-11-11 (owner), gated: only a case whose order has a DO is
 *  acknowledged — the gate lives in assrConnectAck.ts, not here. */
export const CONNECT_SERVICE_CASE_AUTOMATION = 'Service Case Received';

/** The Connect automation fired for the weekly Service Case status update,
 *  matched BY NAME — must equal the automation's name in chat.houzscentury.com
 *  exactly. Its flow sends the button-less template hc_service_case_status_update
 *  (params full_name + assr_no + case_status). */
export const CONNECT_SERVICE_CASE_STATUS_AUTOMATION = 'Service Case Status Update';

/** A sentinel automation name that matches NO enabled Connect automation. The
 *  "Sync to Connect" action POSTs the contact's full field set under this name:
 *  handleErpWebhook upserts the attributes BEFORE it matches automations, and
 *  when a name IS given it matches only that name — so an unmatched name stores
 *  the fields and fires nothing (no WhatsApp). Never give a real Connect
 *  automation this name, or a sync would start sending. */
export const CONNECT_SYNC_AUTOMATION = '__erp_contact_sync__';

export interface ConnectConfig {
  CONNECT_WEBHOOK_URL?: string;
  CONNECT_WEBHOOK_KEY?: string;
}

export interface ConnectOrder {
  /** The ERP Sales Order number (doc_no) — the number the message prints as
   *  "Sales Order No." (owner 2026-10-06; before that the AutoCount number when
   *  linked). /api/chat-callback resolves either number back to the SO, so a
   *  conversation opened under the old rule still records. */
  ref: string;
  orderRef: string;
  branding: string;
  deliveryDate: string;
  balanceSen?: number | null;
  totalSen?: number | null;
  companyCode?: string | null;
}

/** Everything the ERP must tell Connect on EVERY send besides the order lines. */
export interface ConnectSendContext {
  callbackUrl: string;
  automation?: string;
  extra?: Record<string, string>;
  resetConversation?: boolean;
}

/** Where the customer's tap comes back (routes/chatCallback.ts). */
export const CHAT_CALLBACK_PATH = '/api/chat-callback';
/** wrangler.toml sets PUBLIC_APP_URL per environment; this is prod's value and
 *  only a last resort for an environment that forgot to. */
export const DEFAULT_PUBLIC_APP_URL = 'https://erp.houzscentury.com';

export function chatCallbackUrl(env: { PUBLIC_APP_URL?: string }): string {
  const base = String(env.PUBLIC_APP_URL || DEFAULT_PUBLIC_APP_URL).replace(/\/+$/, '');
  return `${base}${CHAT_CALLBACK_PATH}`;
}

/** The figure the balance paragraph prints after "RM": sen → "1,500.00". */
export function formatRm(sen: number): string {
  return (Math.round(sen) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Contact attributes the flows READ before they WRITE, reset to '' on every
 *  send. Connect MERGES incoming attributes over the contact's existing ones,
 *  so without this a value left by the customer's PREVIOUS order leaks into the
 *  new conversation: a stale `button_status=Confirm` makes the Delivery Lock
 *  guard refuse the new order's Amend tap, a stale `amount` prints a balance
 *  that was settled months ago, a stale `amended_delivery_date` rides into the
 *  amend callback when the date form is skipped, a stale `company_code` routes
 *  the send by the PREVIOUS order's company. '' reads as "unset" to Connect's
 *  criteria_router. */
export const CONNECT_RESET_ATTRIBUTES = [
  'button_status',
  'last_button',
  'amount',
  'order_amount',
  'orders_json',
  'company_code',
  'amended_delivery_date',
  'amend_date_reason',
  'date_amended',
] as const;

export interface ConnectContact {
  phone: string;
  name: string;
  automation: string;
  attributes: Record<string, string>;
}

export interface ConnectResult {
  ok: boolean;
  httpCode: number | null;
  error: string | null;
}

/** Per-company message values the ERP fills so ONE template/flow serves both
 *  companies (2990 delivers from the Houzs number but must show 2990's figures).
 *  Each field maps to a flow variable the rebuilt flows reference:
 *  {company_signature}, {bank_block}, {disposal_block}. */
export interface ConnectCompanyProfile {
  signature: string;
  bankBlock: string;
  disposalBlock: string;
}

/** app_config key holding a JSON map { "<company_id>": ConnectCompanyProfile }.
 *  Lives in app_config, NOT in this (public) repo's source, because bank_block
 *  carries a receiving account number. */
export const CONNECT_COMPANY_PROFILE_KEY = 'connect.company_profile';

/** Parse the app_config value into a company_id -> profile map. Never throws: a
 *  missing value, bad JSON, or a non-string field yields {} or drops that row,
 *  so a mis-edit cannot break a send and an unset key simply sends no
 *  per-company attributes. */
export function parseConnectCompanyProfiles(
  raw: string | null,
): Record<string, ConnectCompanyProfile> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, ConnectCompanyProfile> = {};
  for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    const signature = typeof p.signature === 'string' ? p.signature : '';
    const bankBlock = typeof p.bankBlock === 'string' ? p.bankBlock : '';
    const disposalBlock = typeof p.disposalBlock === 'string' ? p.disposalBlock : '';
    if (!signature && !bankBlock && !disposalBlock) continue;
    out[id] = { signature, bankBlock, disposalBlock };
  }
  return out;
}

export function isConnectConfigured(env: ConnectConfig): boolean {
  return Boolean(env.CONNECT_WEBHOOK_URL && env.CONNECT_WEBHOOK_KEY);
}

/** The delivery templates render at most this many order lines
 *  (ref_1..3 / ref_no_1..3 / delivery_date_1..3 / brand_1..3) — Connect's contact
 *  schema also carries only three. A customer with more orders still gets ONE message:
 *  order_total carries the true count and the N>=4 template shows the first 3
 *  plus "you have {order_total} orders" (owner's master list, 2026-10-01). */
export const CONNECT_ORDER_LINES = 3;

/** Build the /api/webhooks/erp body for ONE customer phone — ONE message. The
 *  ref_N / delivery_date_N / brand_N lines are 1-indexed and capped at
 *  CONNECT_ORDER_LINES (the first N orders); order_total is the TRUE order count,
 *  which Connect's flow routes on to pick the 1 / 2 / 3 / 4+ template. */
export function buildDeliveryFollowUp(
  phone: string,
  name: string,
  orders: ConnectOrder[],
  profile: ConnectCompanyProfile | null,
  ctx: ConnectSendContext,
): ConnectContact {
  const attributes: Record<string, string> = {
    full_name: name,
    order_total: String(orders.length),
  };
  if (ctx.resetConversation ?? true) {
    for (const key of CONNECT_RESET_ATTRIBUTES) attributes[key] = '';
  }
  orders.slice(0, CONNECT_ORDER_LINES).forEach((o, i) => {
    const n = i + 1;
    attributes[`ref_${n}`] = o.ref;
    attributes[`ref_no_${n}`] = o.orderRef;
    attributes[`delivery_date_${n}`] = o.deliveryDate;
    attributes[`brand_${n}`] = o.branding;
  });
  attributes.refs_all = orders.map((o) => o.ref).join(',');
  const owedSen = orders.reduce((sum, o) => sum + Math.max(0, Number(o.balanceSen ?? 0)), 0);
  if (owedSen > 0) attributes.amount = formatRm(owedSen);
  const totalSen = orders.reduce((sum, o) => sum + Math.max(0, Number(o.totalSen ?? 0)), 0);
  if (totalSen > 0) attributes.order_amount = (totalSen / 100).toFixed(2);
  if (orders.length > 0) {
    attributes.orders_json = JSON.stringify(
      orders.map((o) => ({
        so: o.ref,
        ref: o.orderRef,
        amount: (Math.max(0, Number(o.totalSen ?? 0)) / 100).toFixed(2),
      })),
    );
  }
  const companyCode = orders.find((o) => o.companyCode)?.companyCode ?? '';
  if (companyCode) attributes.company_code = companyCode;
  attributes.callback_url = ctx.callbackUrl;
  if (profile) {
    attributes.company_signature = profile.signature;
    attributes.bank_block = profile.bankBlock;
    attributes.disposal_block = profile.disposalBlock;
  }
  if (ctx.extra) Object.assign(attributes, ctx.extra);
  return { phone, name, automation: ctx.automation || CONNECT_DELIVERY_AUTOMATION, attributes };
}

/** Build the /api/webhooks/erp body for the one-off acknowledgement sent to the
 *  customer when a Service Case (ASSR) is created. Unlike the delivery follow-up
 *  this opens no Confirm / Amend conversation: the template is button-less, so
 *  there is no callback_url and no conversation reset — just the customer name,
 *  the Sales Order the case is about (ref_1, the delivery convention) and the
 *  service case number, which the template features as its focus. The case number
 *  rides in assr_no, its OWN dedicated Connect field (not a shared ref_* slot) so
 *  it never collides with a delivery ref. */
export function buildServiceCaseReceived(
  phone: string,
  name: string,
  soNo: string,
  assrNo: string,
): ConnectContact {
  return {
    phone,
    name,
    automation: CONNECT_SERVICE_CASE_AUTOMATION,
    attributes: { full_name: name, ref_1: soNo, assr_no: assrNo },
  };
}

/** Build the /api/webhooks/erp body for the weekly Service Case status update.
 *  Button-less: no callback_url, no conversation reset — just the
 *  customer name, the case number (assr_no, the dedicated field) and the current
 *  status as a customer-facing line (case_status). */
export function buildServiceCaseStatus(
  phone: string,
  name: string,
  assrNo: string,
  status: string,
): ConnectContact {
  return {
    phone,
    name,
    automation: CONNECT_SERVICE_CASE_STATUS_AUTOMATION,
    attributes: { full_name: name, assr_no: assrNo, case_status: status },
  };
}

/** The SO-header columns the contact-info sync reads for the single-value
 *  "headline" fields the Connect panel shows (Reference No. / Brand / Purchase
 *  Venue / Sales Person / Delivery State / House Type / Disposal / Delivery
 *  Message Status). These are the fields the delivery bundle's per-order
 *  ref_N / brand_N slots do NOT fill, which is why the panel sat mostly empty. */
export interface SyncHeadlineRow {
  doc_no?: unknown;
  ref?: unknown;
  branding?: unknown;
  venue?: unknown;
  agent?: unknown;
  customer_state?: unknown;
  house_type?: unknown;
  disposal_request?: unknown;
  delivery_message_status?: unknown;
}

/** The headline contact fields built from a customer's FIRST order (the panel
 *  shows one value per contact, as the single-order templates do). Only NON-EMPTY
 *  values are returned, so a sync FILLS a field and never blanks one the customer
 *  or an earlier message already set. `clientDeliveryDate` is the order's
 *  effective (amended ?? original) delivery date as yyyy/mm/dd; `phone` the E.164
 *  number the caller already resolved. Keys are Connect's contact-field keys. */
export function buildSyncHeadline(
  first: SyncHeadlineRow,
  phone: string,
  clientDeliveryDate: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: unknown): void => {
    const s = String(value ?? '').trim();
    if (s) out[key] = s;
  };
  put('reference_no', String(first.ref ?? '').trim() || first.doc_no);
  put('brand', first.branding);
  put('purchase_venue', first.venue);
  put('sales_person', first.agent);
  put('delivery_state', first.customer_state);
  put('house_type', first.house_type);
  put('disposal', first.disposal_request);
  put('delivery_message_status', first.delivery_message_status);
  const digits = phone.replace(/\D/g, '');
  if (digits) out.customer_phone = `+${digits}`;
  if (clientDeliveryDate) out.client_delivery_date = clientDeliveryDate;
  return out;
}

/** Connect's /api/webhooks/erp answer when it fired nothing for the named
 *  automation: a reason for the operator, or null when a run was triggered (or
 *  the body does not say — an older Connect without `triggered` is trusted). */
export function connectUntriggeredReason(bodyText: string, automation: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const triggered = (body as { triggered?: unknown }).triggered;
  if (!Array.isArray(triggered)) return null;
  if (triggered.length > 0) return null;
  return `Connect has no enabled automation named "${automation}" — publish and enable it in chat.houzscentury.com, then send again.`;
}

/** POST one contact event to Connect. Never throws — a network / non-2xx
 *  failure comes back as { ok:false } so the caller logs it per doc the same way
 *  the Seampify path logged a failed send. Caller must check isConnectConfigured
 *  first; a missing URL/key here would just resolve to a failed fetch. */
export async function postConnectContact(
  env: ConnectConfig,
  contact: ConnectContact,
  opts?: { expectTrigger?: boolean },
): Promise<ConnectResult> {
  const base = String(env.CONNECT_WEBHOOK_URL ?? '').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/webhooks/erp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connect-key': String(env.CONNECT_WEBHOOK_KEY ?? ''),
      },
      body: JSON.stringify(contact),
    });
    const text = (await res.text().catch(() => '')).slice(0, 2000);
    if (res.ok) {
      if (opts?.expectTrigger === false) return { ok: true, httpCode: res.status, error: null };
      const untriggered = connectUntriggeredReason(text, contact.automation);
      if (untriggered) return { ok: false, httpCode: res.status, error: untriggered };
      return { ok: true, httpCode: res.status, error: null };
    }
    const error = text.slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, httpCode: res.status, error };
  } catch (e) {
    return { ok: false, httpCode: null, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}
