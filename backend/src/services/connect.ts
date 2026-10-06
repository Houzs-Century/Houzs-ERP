// ---------------------------------------------------------------------------
// connect.ts — ERP -> Houzs Connect (chat.houzscentury.com) sender.
//
// The Delivery Planning board's "Send Now" posts an order event here; Connect
// upserts the customer's contact + attributes and fires the named automation,
// which sends the Meta-approved WhatsApp template (with Confirm / Amend
// buttons). The customer's tap comes back to the ERP at /api/chat-callback.
//
// ONE call per CUSTOMER PHONE, bundling that customer's selected orders as
// ref_1..N / delivery_date_1..N / brand_1..N (+ order_total). Connect's flow
// picks the N-order template from order_total, so a 2/3/4-order bundle needs the
// matching Meta-approved template AND a flow that branches on the count; until
// those exist only a single-order (N=1) bundle renders correctly.
//
// Auth: the X-Connect-Key header carries CONNECT_WEBHOOK_KEY, the shared secret
// Connect's /api/webhooks/erp checks. Gated on CONNECT_WEBHOOK_URL +
// CONNECT_WEBHOOK_KEY — while either is unset isConnectConfigured() is false and
// the board's Send Now answers 503, exactly as the retired Seampify path did.
// ---------------------------------------------------------------------------

/** The Connect automation the delivery follow-up triggers, matched BY NAME.
 *  Must equal the automation's name in chat.houzscentury.com exactly. */
export const CONNECT_DELIVERY_AUTOMATION = 'New Delivery Follow-up';

export interface ConnectConfig {
  CONNECT_WEBHOOK_URL?: string;
  CONNECT_WEBHOOK_KEY?: string;
}

export interface ConnectOrder {
  /** COALESCE(linked_ac_docno, doc_no) — the number the customer knows.
   *  /api/chat-callback resolves EITHER number back to the SO, so the flow can
   *  echo this one straight into its callback body. */
  ref: string;
  branding: string;
  /** yyyy/mm/dd, already the effective (amended ?? original) date. */
  deliveryDate: string;
  /** Outstanding balance in sen (local_total − Σpayments) from the SO list's
   *  own view; null when the view had no row for the doc. Drives `amount`. */
  balanceSen?: number | null;
}

/** Everything the ERP must tell Connect on EVERY send besides the order lines. */
export interface ConnectSendContext {
  /** Absolute URL the flow's call_rest_api node posts the customer's tap to. */
  callbackUrl: string;
  /** The Connect automation to fire, BY NAME. Defaults to the delivery
   *  follow-up; scm/lib/delivery-message-kinds.ts maps the board's message
   *  kinds onto the seeded names. */
  automation?: string;
  /** Per-kind template variables (driver fields, postpone fields, postage
   *  address …) merged LAST, so a kind can set what it needs. */
  extra?: Record<string, string>;
  /** Reset the contact's conversation state (CONNECT_RESET_ATTRIBUTES).
   *  Defaults to true — right for a message that OPENS a Confirm / Amend
   *  conversation. A reminder or driver info sent to a customer who already
   *  confirmed passes false, or it would unlock the Delivery Lock guard. */
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
 *  amend callback when the date form is skipped. '' reads as "unset" to
 *  Connect's criteria_router. */
export const CONNECT_RESET_ATTRIBUTES = [
  'button_status',
  'last_button',
  'amount',
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
 *  (ref_1..3 / delivery_date_1..3 / brand_1..3) — Connect's contact schema also
 *  carries only three. A customer with more orders still gets ONE message:
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
  // Resets FIRST so a real value below (amount) wins over its reset.
  if (ctx.resetConversation ?? true) {
    for (const key of CONNECT_RESET_ATTRIBUTES) attributes[key] = '';
  }
  orders.slice(0, CONNECT_ORDER_LINES).forEach((o, i) => {
    const n = i + 1;
    attributes[`ref_${n}`] = o.ref;
    attributes[`delivery_date_${n}`] = o.deliveryDate;
    attributes[`brand_${n}`] = o.branding;
  });
  // EVERY bundled order, not only the 3 lines shown: the flow's callback echoes
  // this as `refs`, so one Confirm / Amend tap lands on all of them in the ERP
  // (/api/chat-callback resolves each number, our doc_no or AutoCount's).
  attributes.refs_all = orders.map((o) => o.ref).join(',');
  // ONE balance paragraph for the whole message, so the figure is the sum over
  // EVERY bundled order (not only the 3 lines shown) and only of what is owed —
  // an over-paid order must not shrink another's balance. Nothing owed leaves
  // amount '' and the flow's has_balance branch stays quiet.
  const owedSen = orders.reduce((sum, o) => sum + Math.max(0, Number(o.balanceSen ?? 0)), 0);
  if (owedSen > 0) attributes.amount = formatRm(owedSen);
  attributes.callback_url = ctx.callbackUrl;
  if (profile) {
    attributes.company_signature = profile.signature;
    attributes.bank_block = profile.bankBlock;
    attributes.disposal_block = profile.disposalBlock;
  }
  if (ctx.extra) Object.assign(attributes, ctx.extra);
  return { phone, name, automation: ctx.automation || CONNECT_DELIVERY_AUTOMATION, attributes };
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
      // 200 means Connect ACCEPTED the event, not that a message went out: it
      // upserts the contact and answers `triggered: [names]` — an EMPTY list
      // when no enabled automation carries that name (still DRAFT, disabled,
      // renamed). Reporting that as sent put "Done Balance Collection" on an
      // order whose customer got nothing (2026-10-05). Treat it as a failure
      // the operator can act on.
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
