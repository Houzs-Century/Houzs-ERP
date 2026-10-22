// Verification step findings (HC-0133): inspection findings / action taken,
// next action and pending with. Stored 1:1 in assr_case_verification_notes, not
// on assr_cases — the case list / detail read c.* plus their joined columns and
// the D1 test mirror caps a result set at 100 columns (see the migration).
import type { Env } from "../types";
import { logActivity } from "./assr";

const FIELDS = ["inspection_findings", "next_action", "pending_with"] as const;
type Field = (typeof FIELDS)[number];
export type VerificationNotes = Record<Field, string | null>;

const LABELS: Record<Field, string> = {
  inspection_findings: "Inspection Findings / Action Taken",
  next_action: "Next Action",
  pending_with: "Pending With",
};
// Notes go on the timeline like the case's other remarks; pending_with is a
// status pick, not a remark (owner 2026-07-21: record date + remark only).
const LOGGED = new Set<Field>(["inspection_findings", "next_action"]);
const show = (v: string | null) => (v == null || v === "" ? "(empty)" : v.length > 120 ? v.slice(0, 117) + "..." : v);

/** Removes the notes keys from a PATCH body; null when the body sent none. */
export function takeVerificationNotes(body: Record<string, any>): Partial<VerificationNotes> | null {
  const picked: Partial<VerificationNotes> = {};
  for (const k of FIELDS) {
    if (k in body) {
      picked[k] = body[k] ?? null;
      delete body[k];
    }
  }
  return Object.keys(picked).length ? picked : null;
}

export async function getVerificationNotes(env: Env, assrId: number): Promise<VerificationNotes> {
  const row = await env.DB.prepare(
    `SELECT inspection_findings, next_action, pending_with FROM assr_case_verification_notes WHERE assr_id = ?`,
  )
    .bind(assrId)
    .first<Record<string, string | null>>();
  return {
    inspection_findings: row?.inspection_findings ?? row?.inspectionFindings ?? null,
    next_action: row?.next_action ?? row?.nextAction ?? null,
    pending_with: row?.pending_with ?? row?.pendingWith ?? null,
  };
}

/** Upserts the sent fields; false when the case does not exist. */
export async function saveVerificationNotes(
  env: Env,
  assrId: number,
  notes: Partial<VerificationNotes>,
  userId: number,
): Promise<boolean> {
  const exists = await env.DB.prepare(`SELECT id FROM assr_cases WHERE id = ?`).bind(assrId).first();
  if (!exists) return false;
  const before = await getVerificationNotes(env, assrId);
  const keys = FIELDS.filter((k) => k in notes);
  const by = userId > 0 ? userId : null;
  await env.DB.prepare(
    `INSERT INTO assr_case_verification_notes (assr_id, ${keys.join(", ")}, updated_by)
     VALUES (?, ${keys.map(() => "?").join(", ")}, ?)
     ON CONFLICT (assr_id) DO UPDATE SET
       ${keys.map((k) => `${k} = excluded.${k}`).join(", ")},
       updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(assrId, ...keys.map((k) => notes[k] ?? null), by)
    .run();
  await env.DB.prepare(`UPDATE assr_cases SET updated_at = datetime('now') WHERE id = ?`).bind(assrId).run();
  for (const k of keys) {
    const was = before[k] ?? null;
    const now = notes[k] ?? null;
    if (!LOGGED.has(k) || String(was ?? "") === String(now ?? "")) continue;
    await logActivity(env, assrId, "field_change", was, now, `${LABELS[k]}: ${show(was)} → ${show(now)}`, userId, {
      category: "service",
      source_channel: "app",
    });
  }
  return true;
}
