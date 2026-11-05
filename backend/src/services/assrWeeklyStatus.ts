// ─────────────────────────────────────────────────────────────────────────
// assrWeeklyStatus.ts — weekly (Monday) WhatsApp status update to Service Case
// (ASSR) customers, via Houzs Connect.
//
// Owner 2026-11-02 (moved Friday -> Monday 2026-11-03): customers complain nobody
// updates them on their service case. Every Monday, tell each customer the current
// status of their OPEN case. The day is set by the getUTCDay() gate in index.ts.
//
// Scope (owner's choice): a case is eligible when it is OPEN (not completed /
// voided / archived), has a phone, AND the customer was NOT WhatsApp'd in the
// last 7 days — so a customer we already contacted this week (delivery, service
// arrangement, reminder …) is not pinged again. The weekly-status send itself is
// EXCLUDED from that "contacted this week" test, or it would suppress its own
// next run and the update would land only every other week.
//
// Ships DARK. scm.app_config 'scm.assr_weekly_status' gates it:
//   · 'off' (default) — no-op.
//   · 'pilot' — only phones listed in 'scm.assr_weekly_status_pilot' (comma /
//     space separated) receive it, so it can be tried on a few numbers first.
//   · 'on' — every eligible case.
//
// Best-effort throughout: a send or log failure is counted and logged, never
// thrown, so one bad case can never break the Friday cron slot.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";
import { normalizePhone } from "../scm/shared/phone";
import { assrCustomerStatus } from "../scm/shared/assr-stage-labels";
import { assrOpenStageSql } from "./assrStages";
import {
  buildServiceCaseStatus,
  isConnectConfigured,
  postConnectContact,
} from "./connect";

/** Customer-facing status line per open stage — warmer than the bare stage
 *  label. A stage not listed falls back to the shared customer label, so a new
 *  or retired stage still reads sensibly rather than as a slug. */
const FRIENDLY_STATUS: Record<string, string> = {
  pending_review: "Reviewing your request",
  pending_solution: "Preparing the solution",
  under_verification: "Inspecting the item",
  pending_supplier_pickup: "Arranging pickup / with the supplier",
  pending_item_ready: "Preparing your item",
  pending_delivery_service: "Arranging delivery / service",
};

export function friendlyStatus(stage: string | null | undefined): string {
  const key = stage ?? "";
  return FRIENDLY_STATUS[key] ?? assrCustomerStatus(stage).label;
}

type Mode = "off" | "pilot" | "on";

/** The weekly-status source tag on scm.wa_message_log — also the value the
 *  "contacted this week" check excludes so the send never suppresses itself. */
const SOURCE = "assr-weekly-status";

async function readMode(env: Env): Promise<{ mode: Mode; pilotPhones: Set<string> }> {
  const row = await env.DB.prepare(
    `SELECT value FROM scm.app_config WHERE key = 'scm.assr_weekly_status'`,
  ).first<{ value: string | null }>();
  const raw = (row?.value ?? "off").trim().toLowerCase();
  const mode: Mode = raw === "on" ? "on" : raw === "pilot" ? "pilot" : "off";
  const pilotPhones = new Set<string>();
  if (mode === "pilot") {
    const p = await env.DB.prepare(
      `SELECT value FROM scm.app_config WHERE key = 'scm.assr_weekly_status_pilot'`,
    ).first<{ value: string | null }>();
    for (const part of String(p?.value ?? "").split(/[,\s]+/)) {
      const n = normalizePhone(part);
      if (n) pilotPhones.add(n);
    }
  }
  return { mode, pilotPhones };
}

export interface WeeklyStatusResult {
  mode: Mode;
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}

type CaseRow = {
  id: number;
  assr_no: string | null;
  customer_name: string | null;
  phone: string | null;
  stage: string | null;
  company_id: number | null;
};

export async function runWeeklyServiceCaseStatus(env: Env): Promise<WeeklyStatusResult> {
  const result: WeeklyStatusResult = { mode: "off", scanned: 0, sent: 0, skipped: 0, failed: 0 };
  if (!isConnectConfigured(env)) return result;
  const { mode, pilotPhones } = await readMode(env);
  result.mode = mode;
  if (mode === "off") return result;

  // Open, non-archived cases that carry a phone.
  const rows = await env.DB.prepare(
    `SELECT id, assr_no, customer_name, phone, stage, company_id
       FROM assr_cases
      WHERE ${assrOpenStageSql()} AND archived_at IS NULL
        AND phone IS NOT NULL AND btrim(phone) <> ''`,
  ).all<CaseRow>();
  const cases = (rows.results ?? [])
    .map((r) => ({ ...r, nphone: normalizePhone(r.phone) }))
    .filter((r): r is CaseRow & { nphone: string } => !!r.nphone && !!r.assr_no);
  result.scanned = cases.length;
  if (cases.length === 0) return result;

  // "Contacted this week" = any WhatsApp to that phone in the last 7 days EXCEPT
  // a prior weekly status (excluding self keeps the update weekly, not fortnightly).
  const phones = [...new Set(cases.map((c) => c.nphone))];
  const contacted = new Set<string>();
  for (let i = 0; i < phones.length; i += 200) {
    const chunk = phones.slice(i, i + 200);
    const q = await env.DB.prepare(
      `SELECT DISTINCT phone FROM scm.wa_message_log
        WHERE created_at > now() - interval '7 days'
          AND source <> '${SOURCE}'
          AND phone IN (${chunk.map(() => "?").join(", ")})`,
    )
      .bind(...chunk)
      .all<{ phone: string }>();
    for (const r of q.results ?? []) contacted.add(r.phone);
  }

  for (const c of cases) {
    const phone = c.nphone;
    if (contacted.has(phone)) { result.skipped++; continue; }
    if (mode === "pilot" && !pilotPhones.has(phone)) { result.skipped++; continue; }
    const assrNo = String(c.assr_no);
    const contact = buildServiceCaseStatus(
      phone,
      String(c.customer_name ?? ""),
      assrNo,
      friendlyStatus(c.stage),
    );
    let res;
    try {
      res = await postConnectContact(env, contact);
    } catch (e) {
      console.error(`[assr-weekly-status] send threw (${assrNo}): ${(e as Error).message}`);
      result.failed++;
      continue;
    }
    // Visible trail; excluded from the dedup above so it never suppresses itself.
    try {
      await env.DB.prepare(
        `INSERT INTO scm.wa_message_log
           (batch_id, company_id, doc_no, phone, payload, http_code, success, error, source)
         VALUES (gen_random_uuid(), ?, ?, ?, ?, ?, ?, ?, '${SOURCE}')`,
      )
        .bind(c.company_id ?? null, assrNo, phone, JSON.stringify(contact), res.httpCode, res.ok, res.error)
        .run();
    } catch (e) {
      console.warn(`[assr-weekly-status] log insert failed (${assrNo}): ${(e as Error).message}`);
    }
    if (res.ok) result.sent++; else result.failed++;
  }
  return result;
}
