// Pending Item Ready QC details (Operation Dept 2026-11-09): QC inspection date,
// who did the QC and the findings. Stored 1:1 in assr_case_qc_notes, not on
// assr_cases, for the same reason as assrVerificationNotes.ts: the case list and
// detail read c.* and the D1 test mirror caps a result set at 100 columns.
import type { Env } from "../types";
import { logActivity } from "./assr";

const FIELDS = ["qc_inspected_at", "qc_by", "qc_findings"] as const;
type Field = (typeof FIELDS)[number];
export type QcNotes = Record<Field, string | null>;

const LABELS: Record<Field, string> = {
  qc_inspected_at: "QC Inspection Date",
  qc_by: "QC By",
  qc_findings: "QC Findings",
};
const show = (v: string | null) => (v == null || v === "" ? "(empty)" : v.length > 120 ? v.slice(0, 117) + "..." : v);

/** Removes the QC keys from a PATCH body; null when the body sent none. */
export function takeQcNotes(body: Record<string, unknown>): Partial<QcNotes> | null {
  const picked: Partial<QcNotes> = {};
  for (const k of FIELDS) {
    if (k in body) {
      const value = body[k];
      picked[k] = typeof value === "string" ? value : null;
      delete body[k];
    }
  }
  return Object.keys(picked).length ? picked : null;
}

export async function getQcNotes(env: Env, assrId: number): Promise<QcNotes> {
  const row = await env.DB.prepare(`SELECT qc_inspected_at, qc_by, qc_findings FROM assr_case_qc_notes WHERE assr_id = ?`)
    .bind(assrId)
    .first<Record<string, string | null>>();
  return {
    qc_inspected_at: row?.qc_inspected_at ?? row?.qcInspectedAt ?? null,
    qc_by: row?.qc_by ?? row?.qcBy ?? null,
    qc_findings: row?.qc_findings ?? row?.qcFindings ?? null,
  };
}

/** Upserts the sent fields and logs each change on the timeline; false when the case does not exist. */
export async function saveQcNotes(env: Env, assrId: number, notes: Partial<QcNotes>, userId: number): Promise<boolean> {
  const exists = await env.DB.prepare(`SELECT id FROM assr_cases WHERE id = ?`).bind(assrId).first();
  if (!exists) return false;
  const before = await getQcNotes(env, assrId);
  const keys = FIELDS.filter((k) => k in notes);
  const by = userId > 0 ? userId : null;
  await env.DB.prepare(
    `INSERT INTO assr_case_qc_notes (assr_id, ${keys.join(", ")}, updated_by)
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
    if (String(was ?? "") === String(now ?? "")) continue;
    await logActivity(env, assrId, "field_change", was, now, `${LABELS[k]}: ${show(was)} → ${show(now)}`, userId, {
      category: "service",
      source_channel: "app",
    });
  }
  return true;
}
