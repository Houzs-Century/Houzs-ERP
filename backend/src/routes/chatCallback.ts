// ---------------------------------------------------------------------------
// chatCallback.ts — Houzs Chat (Connect) → ERP delivery callback.
//
// Nico 2026-09-02, while moving the delivery-notification pipeline off
// Seampify onto chat.houzscentury.com.
//
// THE OUTBOUND HALF ALREADY EXISTS. The Delivery Planning board's "Send
// Message" (scm/routes/delivery-messages.ts) posts one WhatsApp per customer
// phone and logs one row per doc into scm.wa_message_log (mig 0185). What the
// customer TAPS BACK, however, has never reached the ERP: the Seampify flow's
// `Call REST API` steps point at two Google Apps Script deployments, the answer
// lands in a spreadsheet, and staff work off the sheet. This route is the
// missing return leg — chat's `Call REST API` step posts the customer's answer
// here and it lands in the SAME table the board already reads, tagged
// source='chat-callback'.
//
// WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
// It does not write the customer's chosen date onto the Sales Order. A date a
// customer tapped is a REQUEST, not a schedule: the board owns delivery dates,
// MRP pools off them, and a silent write here would let a customer move a date
// a trip has already been planned around. The callback RECORDS; a human (or a
// later, explicit approve step) decides. That is also exactly what the flow
// promises the customer in its own words — "our team will review and plan
// according to our current delivery schedule."
//
// AUTH. Shared secret in the X-Chat-Key header against the CHAT_CALLBACK_KEY
// worker secret. No session: chat's servers call this. It is therefore mounted
// PRE-AUTH, ABOVE app.use("/api/*", auth) — mounting it below the gate would
// 401 every call before the route's own key check ever ran, which is the
// mistake /api/assr-form-intake documents having made.
//
// COMPANY. A shared secret speaks for the companies whose messages go out on
// its number and opens nothing else. CHAT_CALLBACK_KEY belongs to the Houzs
// WhatsApp number, and 2990's delivery messages are sent from that same number
// (services/connect.ts), so a Sales Order tap resolves HOUZS or 2990 and
// REFUSES any other company's doc_no. Until HC-0200 it resolved HOUZS only, so
// every 2990 Confirm / Amend 404'd and the board never moved. Service Case taps
// stay HOUZS-only. A future separate 2990 number gets its own key.
//
// PAYLOAD (chat's `Call REST API` body):
//   What it WRITES on the SO: only the request columns the board shows
//   (amend_date_from_customer, amend_reason, delivery_message_status) via
//   lib/chat-request-patch.ts — never the schedule. See that module.
//
//   { callback_id?: string,          // idempotency; chat's own step id
//     event: "confirm" | "amend" | "postage_confirm" | "postage_amend"
//            | "property",             // the Property Details form answers
//     ref: string,                   // the number the customer was shown: our
//                                    // doc_no OR the AutoCount linked_ac_docno
//     refs?: string,                 // the whole bundle, comma-joined (refs_all)
//     phone?: string,
//     delivery_date?: string,        // amend only — what the customer asked for
//     reason?: string,               // amend only — Renovation Delay / Date Unavailable
//     house_type?, delivery_purpose?, need_disposal?, disposal_item?: string,
//                                    // property only — the form's four answers
//     note?: string }                // free text, optional
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../types";
import { timingSafeEqualStr } from "../services/auth";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { CHAT_EVENTS, DOC_REF_RE, parseCallbackRefs, type ChatEvent } from "../lib/chat-request-patch";
import { blastPhone } from "../scm/routes/delivery-messages";
import { ChatTapLogFailed, recordChatTap, type ChatTapResult } from "../lib/chat-callback-record";
import { AssrTapFailed, isAssrLeg, recordAssrChatTap } from "../scm/lib/assr-arrangement-message";

const app = new Hono<{ Bindings: Env }>();

const CHAT_KEY_COMPANIES = ["HOUZS", "2990"] as const;

async function badChatKey(c: any): Promise<Response | null> {
  const provided = c.req.header("X-Chat-Key") || "";
  const expected = c.env.CHAT_CALLBACK_KEY || "";
  if (expected && timingSafeEqualStr(provided, expected)) return null;
  const limited = await checkRateLimit(c, "chatcb_badkey", clientIp(c), 10, 900);
  await new Promise((r) => setTimeout(r, 250));
  if (limited) return limited;
  return c.json({ error: "unauthorized" }, 401);
}

async function chatCompany(
  db: D1Database,
  code: string,
): Promise<{ master: boolean; id: number | null }> {
  try {
    const row = await db
      .prepare(`SELECT id FROM companies WHERE code = ? LIMIT 1`)
      .bind(code)
      .first<{ id: number | string }>();
    return { master: true, id: row?.id != null ? Number(row.id) : null };
  } catch {
    return { master: false, id: null };
  }
}

function safeId(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
  return s || null;
}

const EVENTS = new Set<string>(CHAT_EVENTS);

app.post("/", async (c) => {
  // company-scope: every read below IS scoped — chatCompany() resolves the
  // key's companies first and the predicate is applied as
  // `.in("company_id", orderCompanyIds)` / `.eq("company_id", companyId)` on
  // the next line of each statement, which this checker's per-statement
  // heuristic cannot see. It is conditional on purpose: the ids are absent ONLY
  // in the master-unreadable state (the single-company install / the D1 test
  // mirror), where scm/lib/companyScope's own contract is "no predicate" —
  // writing `.eq('company_id', null)` there would be a malformed filter, not a
  // tighter one. The misconfiguration state (master readable, a key company
  // with no row) is refused, not degraded.
  const denied = await badChatKey(c);
  if (denied) return denied;

  if (!isSupabaseConfigured(c.env)) {
    return c.json({ error: "not_configured", reason: "Supabase is not configured" }, 503);
  }

  let body: {
    callback_id?: string;
    event?: string;
    ref?: string;
    refs?: unknown;
    phone?: string;
    delivery_date?: string;
    reason?: string;
    address?: string;
    note?: string;
    leg?: string;
    house_type?: string;
    delivery_purpose?: string;
    need_disposal?: string;
    disposal_item?: string;
    recipient_name?: string;
    recipient_phone?: string;
    delivery_address?: string;
    remark?: string;
  } | null = null;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_json" }, 400);
  }

  const event = String(body.event ?? "").trim().toLowerCase();
  if (!EVENTS.has(event)) {
    return c.json({ error: `event must be one of ${CHAT_EVENTS.join(", ")}` }, 400);
  }
  const ref = String(body.ref ?? "").trim().slice(0, 64);
  if (!ref) return c.json({ error: "ref (SO doc_no) is required" }, 400);

  const callbackId = safeId(body.callback_id);
  const phone = blastPhone(body.phone);
  const requestedDate = String(body.delivery_date ?? "").trim().slice(0, 32) || null;
  const requestedAddress = String(body.address ?? "").trim().slice(0, 300) || null;
  const reason = String(body.reason ?? "").trim().slice(0, 200) || null;
  const note = String(body.note ?? "").trim().slice(0, 500) || null;
  const propField = (v: unknown, max: number): string | null => {
    const t = String(v ?? "").trim().slice(0, max);
    return !t || /^\{[a-z0-9_]+\}$/i.test(t) ? null : t;
  };
  const property = event === "property" ? {
    houseType: propField(body.house_type, 60),
    deliveryPurpose: propField(body.delivery_purpose, 60),
    needDisposal: propField(body.need_disposal, 20),
    disposalItem: propField(body.disposal_item, 200),
  } : null;
  const emAckNote = event === "eastmy_ack"
    ? [
        propField(body.recipient_name, 120) && `recipient: ${propField(body.recipient_name, 120)}`,
        blastPhone(body.recipient_phone) && `phone: ${blastPhone(body.recipient_phone)}`,
        propField(body.delivery_address, 300) && `address: ${propField(body.delivery_address, 300)}`,
        propField(body.remark, 500) && `remark: ${propField(body.remark, 500)}`,
      ].filter(Boolean).join(" | ") || null
    : null;

  const sb = getSupabaseService(c.env);

  const keyCompanies = await Promise.all(CHAT_KEY_COMPANIES.map((code) => chatCompany(c.env.DB, code)));
  const missing = CHAT_KEY_COMPANIES.find((_, i) => keyCompanies[i].master && keyCompanies[i].id == null);
  if (missing) {
    return c.json({ error: "misconfigured", reason: `no companies row for code ${missing}` }, 500);
  }
  const company = keyCompanies[0];
  const orderCompanyIds = keyCompanies.flatMap((k) => (k.id != null ? [k.id] : []));

  if (!DOC_REF_RE.test(ref)) {
    return c.json({ error: "invalid_ref", reason: "ref has characters no document number carries" }, 400);
  }
  // A Service Case leg (HC-0171): the Service Arrangement flow sends the case
  // number as ref plus the leg. Same key, company and idempotency rules; the
  // tap lands on the case timeline instead of SO request columns.
  if (body.leg !== undefined) {
    if (!isAssrLeg(body.leg)) return c.json({ error: "invalid_leg" }, 400);
    if (event !== "confirm" && event !== "amend") {
      return c.json({ error: "invalid_event", reason: "a Service Case tap is confirm or amend" }, 400);
    }
    try {
      const tap = await recordAssrChatTap(c.env, sb, {
        companyId: company.id, assrNo: ref, leg: body.leg, callbackId, event, phone, requestedDate, reason, note,
      });
      if (!tap) return c.json({ error: "unknown_ref", reason: `no ${CHAT_KEY_COMPANIES[0]} service case ${ref}` }, 404);
      return c.json({ ok: true, ...(tap.duplicate ? { duplicate: true } : { event, recorded: true }), id: tap.id, ref: tap.docNo, applied: false });
    } catch (e) {
      if (e instanceof AssrTapFailed) return c.json({ error: "log_failed", reason: e.message }, 500);
      throw e;
    }
  }

  const refs = parseCallbackRefs(ref, body.refs);
  const list = refs.join(",");
  let soQuery = sb
    .from("mfg_sales_orders")
    .select("doc_no, company_id, linked_ac_docno")
    .or(`doc_no.in.(${list}),linked_ac_docno.in.(${list})`);
  if (orderCompanyIds.length) soQuery = soQuery.in("company_id", orderCompanyIds);
  const { data: soRows, error: soErr } = await soQuery.limit(refs.length * 2);
  if (soErr) {
    return c.json({ error: "load_failed", reason: soErr.message }, 500);
  }
  type SoHit = { doc_no: string; company_id: number | string | null; linked_ac_docno: string | null };
  const hits = (soRows ?? []) as SoHit[];
  const resolve = (r: string): SoHit | null =>
    hits.find((h) => h.doc_no === r) ?? hits.find((h) => h.linked_ac_docno === r) ?? null;
  const primaryDoc = resolve(ref)?.doc_no;
  if (!primaryDoc) {
    return c.json({ error: "unknown_ref", reason: `no order ${ref}` }, 404);
  }
  const targets: Array<{ customerRef: string; docNo: string; companyId: number | null }> = [];
  const unknown: string[] = [];
  for (const r of refs) {
    const hit = resolve(r);
    if (!hit) { unknown.push(r); continue; }
    if (!targets.some((t) => t.docNo === hit.doc_no)) {
      targets.push({ customerRef: r, docNo: hit.doc_no, companyId: hit.company_id != null ? Number(hit.company_id) : null });
    }
  }

  const results: ChatTapResult[] = [];
  for (const t of targets) {
    try {
      results.push(await recordChatTap(sb, {
        companyId: t.companyId,
        docNo: t.docNo,
        customerRef: t.customerRef,
        callbackId,
        event: event as ChatEvent,
        phone,
        requestedDate,
        reason,
        property,
        note: emAckNote
          ? `${note ?? ""}${note ? " | " : ""}${emAckNote}`
          : requestedAddress ? `${note ?? ""}${note ? " | " : ""}address: ${requestedAddress}` : note,
      }));
    } catch (e) {
      if (e instanceof ChatTapLogFailed) {
        return c.json({ error: "log_failed", reason: e.message, recorded: results.map((r) => r.docNo) }, 500);
      }
      throw e;
    }
  }

  const first = results[0];
  if (results.every((r) => r.duplicate)) {
    return c.json({ ok: true, duplicate: true, id: first?.id ?? null, refs: results.map((r) => r.docNo) });
  }
  return c.json({
    ok: true,
    id: first?.id ?? null,
    event,
    ref: primaryDoc,
    refs: results.map((r) => r.docNo),
    results,
    ...(unknown.length ? { unknown } : {}),
    recorded: true,
    applied: false,
  });
});

export default app;
