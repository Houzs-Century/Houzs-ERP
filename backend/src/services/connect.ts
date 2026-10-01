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
  /** COALESCE(linked_ac_docno, doc_no) — the number the customer knows. */
  ref: string;
  branding: string;
  /** yyyy/mm/dd, already the effective (amended ?? original) date. */
  deliveryDate: string;
}

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
): ConnectContact {
  const attributes: Record<string, string> = {
    full_name: name,
    order_total: String(orders.length),
  };
  orders.slice(0, CONNECT_ORDER_LINES).forEach((o, i) => {
    const n = i + 1;
    attributes[`ref_${n}`] = o.ref;
    attributes[`delivery_date_${n}`] = o.deliveryDate;
    attributes[`brand_${n}`] = o.branding;
  });
  return { phone, name, automation: CONNECT_DELIVERY_AUTOMATION, attributes };
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
    if (res.ok) return { ok: true, httpCode: res.status, error: null };
    const error = (await res.text().catch(() => '')).slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, httpCode: res.status, error };
  } catch (e) {
    return { ok: false, httpCode: null, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}
