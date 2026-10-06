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
// COMPANY. By the 2026-08-18 rule a shared secret speaks for exactly ONE
// company and opens nothing else. CHAT_CALLBACK_KEY is a Houzs Century
// artifact — the WhatsApp number it calls back about is Houzs's — so it
// resolves HOUZS and REFUSES any doc_no that is not Houzs's. A future 2990
// chat number gets its own key and its own row in the table below; it must
// never be handed this one.
//
// PAYLOAD (chat's `Call REST API` body):
//   What it WRITES on the SO: only the request columns the board shows
//   (amend_date_from_customer, amend_reason, delivery_message_status) via
//   lib/chat-request-patch.ts — never the schedule. See that module.
//
//   { callback_id?: string,          // idempotency; chat's own step id
//     event: "confirm" | "amend",
//     ref: string,                   // the number the customer was shown: our
//                                    // doc_no OR the AutoCount linked_ac_docno
//     refs?: string,                 // the whole bundle, comma-joined (refs_all)
//     phone?: string,
//     delivery_date?: string,        // amend only — what the customer asked for
//     reason?: string,               // amend only — Renovation Delay / Date Unavailable
//     note?: string }                // free text, optional
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../types";
import { timingSafeEqualStr } from "../services/auth";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { DOC_REF_RE, parseCallbackRefs, type ChatEvent } from "../lib/chat-request-patch";
import { ChatTapLogFailed, recordChatTap, type ChatTapResult } from "../lib/chat-callback-record";

const app = new Hono<{ Bindings: Env }>();

/** The one company CHAT_CALLBACK_KEY speaks for. See the COMPANY note above. */
const CHAT_KEY_COMPANY = "HOUZS";

/** Shared-secret guard. Constant-time compare (the key should be 48 random
 *  chars — brute force is hopeless, but the comparison shouldn't leak match
 *  length anyway), a small failure delay, and a per-IP failure limiter so
 *  key-guessing costs real time and eventually 429s. Same shape as
 *  assrFormIntake's badIntakeKey; kept local rather than shared because the
 *  two endpoints must be able to diverge (different key, different company). */
async function badChatKey(c: any): Promise<Response | null> {
  const provided = c.req.header("X-Chat-Key") || "";
  const expected = c.env.CHAT_CALLBACK_KEY || "";
  if (expected && timingSafeEqualStr(provided, expected)) return null;
  const limited = await checkRateLimit(c, "chatcb_badkey", clientIp(c), 10, 900);
  await new Promise((r) => setTimeout(r, 250));
  if (limited) return limited;
  return c.json({ error: "unauthorized" }, 401);
}

/** Resolve a company code to its id. Three-state contract, identical to
 *  assrFormIntake.intakeCompany and scm/lib/companyScope:
 *   · { master: false }            — the companies master is not readable at
 *     all (pre-migration / the D1 test mirror). Single-company install, no
 *     second tenant to leak to, so the caller degrades to no predicate.
 *   · { master: true, id: null }   — the master IS readable and has no row for
 *     this code. That is a MISCONFIGURATION, not a legacy state, and the caller
 *     must REFUSE: falling back to "no predicate" would re-open the hole on the
 *     day someone renames a company code. */
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

/** Digits-only then '+'-prefixed, matching delivery-messages.normalizePhone so
 *  a callback's phone is comparable to the one the send logged. */
function normalizePhone(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? `+${digits}` : null;
}

/** Trim to a bounded, LIKE-safe token. The callback id is interpolated into an
 *  idempotency LIKE below, so anything that is not [A-Za-z0-9_-] is dropped
 *  rather than escaped — chat's own ids are already in that alphabet, and a
 *  stray % or _ would silently widen the duplicate match. */
function safeId(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
  return s || null;
}

const EVENTS = new Set(["confirm", "amend"]);

app.post("/", async (c) => {
  // company-scope: every read below IS scoped — chatCompany() resolves HOUZS
  // first and the predicate is applied as `.eq("company_id", company.id)` on
  // the next line of each statement, which this checker's per-statement
  // heuristic cannot see. It is conditional on purpose: company.id is null ONLY
  // in the master-unreadable state (the single-company install / the D1 test
  // mirror), where scm/lib/companyScope's own contract is "no predicate" —
  // writing `.eq('company_id', null)` there would be a malformed filter, not a
  // tighter one. The misconfiguration state (master readable, no HOUZS row) is
  // refused, not degraded.
  const denied = await badChatKey(c);
  if (denied) return denied;

  if (!isSupabaseConfigured(c.env)) {
    return c.json({ error: "not_configured", reason: "Supabase is not configured" }, 503);
  }

  // try/catch rather than `.catch(() => null)`: the same house pattern
  // scm/routes/delivery-messages.ts uses, and the one check-swallowed-reads
  // wants — a discarded rejection cannot tell a malformed body from a body
  // that never arrived. Here both answers really are 400, but the shape has to
  // be the one that CAN tell, or the next reader copies the one that cannot.
  let body: {
    callback_id?: string;
    event?: string;
    ref?: string;
    refs?: unknown;
    phone?: string;
    delivery_date?: string;
    reason?: string;
    note?: string;
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
    return c.json({ error: "event must be 'confirm' or 'amend'" }, 400);
  }
  const ref = String(body.ref ?? "").trim().slice(0, 64);
  if (!ref) return c.json({ error: "ref (SO doc_no) is required" }, 400);

  const callbackId = safeId(body.callback_id);
  const phone = normalizePhone(body.phone);
  // Dates ride through as the customer's REQUEST, never as a schedule. Kept as
  // the raw string the flow sent: this row is evidence of what was asked for,
  // and reformatting it here would quietly lose "2026-09-30" vs "2026/09/30"
  // information that helps when a mismatch is being chased.
  const requestedDate = String(body.delivery_date ?? "").trim().slice(0, 32) || null;
  const reason = String(body.reason ?? "").trim().slice(0, 200) || null;
  const note = String(body.note ?? "").trim().slice(0, 500) || null;

  const sb = getSupabaseService(c.env);

  // ── Company scope ───────────────────────────────────────────────────────
  // Resolved FIRST, before anything reads a row: the key speaks for HOUZS and
  // nothing else, so every query below carries its predicate. A doc that is
  // not Houzs's is a REFUSAL to notice, not a row to write. See the COMPANY
  // note at the top.
  const company = await chatCompany(c.env.DB, CHAT_KEY_COMPANY);
  if (company.master && company.id == null) {
    return c.json(
      { error: "misconfigured", reason: `no companies row for code ${CHAT_KEY_COMPANY}` },
      500,
    );
  }

  // `ref` is the number the CUSTOMER was shown — delivery-messages sends
  // COALESCE(linked_ac_docno, doc_no), so for an AutoCount-linked order it is
  // the AutoCount number, not ours — and `refs` is the whole bundle (the
  // ERP's `refs_all`): a customer with 2–4 orders gets ONE message, and the
  // tap answers for all of them. Match either column; each row is then keyed
  // by OUR doc_no so the board finds it. Refs are interpolated into a
  // PostgREST `or` filter, where `,` `(` `)` are syntax — anything outside the
  // document-number alphabet is refused up front rather than escaped.
  if (!DOC_REF_RE.test(ref)) {
    return c.json({ error: "invalid_ref", reason: "ref has characters no document number carries" }, 400);
  }
  const refs = parseCallbackRefs(ref, body.refs);
  const list = refs.join(",");
  let soQuery = sb
    .from("mfg_sales_orders")
    .select("doc_no, company_id, linked_ac_docno")
    .or(`doc_no.in.(${list}),linked_ac_docno.in.(${list})`);
  if (company.id != null) soQuery = soQuery.eq("company_id", company.id);
  const { data: soRows, error: soErr } = await soQuery.limit(refs.length * 2);
  if (soErr) {
    return c.json({ error: "load_failed", reason: soErr.message }, 500);
  }
  const hits = (soRows ?? []) as Array<{ doc_no: string; linked_ac_docno: string | null }>;
  // An exact doc_no hit wins over a linked_ac_docno hit, so a number that is
  // somehow both is recorded against the order that literally carries it.
  const resolve = (r: string): string | null =>
    hits.find((h) => h.doc_no === r)?.doc_no ?? hits.find((h) => h.linked_ac_docno === r)?.doc_no ?? null;
  const primaryDoc = resolve(ref);
  if (!primaryDoc) {
    // Deliberately the same answer for "no such SO" and "not this company's
    // SO": the caller holds a Houzs credential and must not be able to probe
    // which doc numbers exist elsewhere.
    return c.json({ error: "unknown_ref", reason: `no ${CHAT_KEY_COMPANY} order ${ref}` }, 404);
  }
  // The primary first, then the rest of the bundle; a sibling that does not
  // resolve is reported, not fatal — the primary order's answer still lands.
  const targets: Array<{ customerRef: string; docNo: string }> = [];
  const unknown: string[] = [];
  for (const r of refs) {
    const d = resolve(r);
    if (!d) { unknown.push(r); continue; }
    if (!targets.some((t) => t.docNo === d)) targets.push({ customerRef: r, docNo: d });
  }

  // ── Record, per order ───────────────────────────────────────────────────
  // lib/chat-callback-record.ts: idempotency by (callback_id, doc), the
  // wa_message_log row, then the board's request columns. A log failure is a
  // 500 — the row IS the record, and a 200 would stop chat retrying.
  const results: ChatTapResult[] = [];
  for (const t of targets) {
    try {
      results.push(await recordChatTap(sb, {
        companyId: company.id,
        docNo: t.docNo,
        customerRef: t.customerRef,
        callbackId,
        event: event as ChatEvent,
        phone,
        requestedDate,
        reason,
        note,
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
    // The schedule is untouched — `applied` keeps meaning "delivery date
    // applied", which this endpoint never does. Each result's `so_request`
    // says whether that order's request columns were filled.
    applied: false,
  });
});

export default app;
