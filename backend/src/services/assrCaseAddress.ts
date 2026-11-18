// A service case's Postcode / City / State (owner 2026-11-17). Stored 1:1 in
// public.assr_case_address, not on assr_cases, for the same reason as
// assrVerificationNotes.ts: the case list and detail read c.* and the D1 test
// mirror caps a result set at 100 columns. The address LINES stay on
// assr_cases.addr1..addr4. Readers join the table (LEFT JOIN assr_case_address
// ca ON ca.assr_id = <case>.id) and print through scm/shared/assr-case-address.ts.
import type { Env } from "../types";
import { logActivity } from "./assr";
import { CASE_ADDRESS_KEYS, type CaseAddressKey } from "../scm/shared/assr-case-address";
export { caseAddressError } from "../scm/shared/assr-case-address";

export type CaseAddress = Record<CaseAddressKey, string | null>;

const LABELS: Record<CaseAddressKey, string> = { postcode: "Postcode", city: "City", state: "State" };
const clean = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s ? s : null;
};

/** Removes postcode / city / state from a PATCH body; null when it sent none. */
export function takeCaseAddress(body: Record<string, unknown>): Partial<CaseAddress> | null {
  const picked: Partial<CaseAddress> = {};
  for (const k of CASE_ADDRESS_KEYS) {
    if (k in body) {
      picked[k] = clean(body[k]);
      delete body[k];
    }
  }
  return Object.keys(picked).length ? picked : null;
}

export async function getCaseAddress(env: Env, assrId: number): Promise<CaseAddress> {
  const row = await env.DB.prepare(`SELECT postcode, city, state FROM assr_case_address WHERE assr_id = ?`)
    .bind(assrId)
    .first<Record<string, string | null>>();
  return { postcode: row?.postcode ?? null, city: row?.city ?? null, state: row?.state ?? null };
}

/** Upserts the sent parts and, when `log`, puts each change on the timeline (an
 *  edit does; the fill at create does not); false when the case does not exist
 *  or nothing changed. */
export async function saveCaseAddress(
  env: Env, assrId: number, parts: Partial<CaseAddress>, userId: number, log: boolean,
): Promise<boolean> {
  const exists = await env.DB.prepare(`SELECT id FROM assr_cases WHERE id = ?`).bind(assrId).first();
  if (!exists) return false;
  const before = await getCaseAddress(env, assrId);
  const keys = CASE_ADDRESS_KEYS.filter((k) => k in parts && (parts[k] ?? null) !== before[k]);
  if (!keys.length) return false;
  const by = userId > 0 ? userId : null;
  await env.DB.prepare(
    `INSERT INTO assr_case_address (assr_id, ${keys.join(", ")}, updated_by)
     VALUES (?, ${keys.map(() => "?").join(", ")}, ?)
     ON CONFLICT (assr_id) DO UPDATE SET
       ${keys.map((k) => `${k} = excluded.${k}`).join(", ")},
       updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(assrId, ...keys.map((k) => parts[k] ?? null), by)
    .run();
  await env.DB.prepare(`UPDATE assr_cases SET updated_at = datetime('now') WHERE id = ?`).bind(assrId).run();
  for (const k of log ? keys : []) {
    const was = before[k] ?? "(empty)";
    const now = parts[k] ?? "(empty)";
    await logActivity(env, assrId, "field_change", before[k], parts[k] ?? null, `${LABELS[k]}: ${was} → ${now}`, userId, {
      category: "service",
      source_channel: "app",
    });
  }
  return true;
}
