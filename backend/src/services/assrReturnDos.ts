// Supplier delivery orders that come back with the repaired item (Pending Item
// Ready, Operation Dept 2026-11-09). A case can have several. Registered thin in
// routes/assr.ts under /:id/return-dos, inside the enforceCaseScope /:id guard
// (company and row scope) and gated on service_cases.write. Saving a received
// date fills the current trip's back date when that is still empty, so the date
// is typed once.
import type { Context } from "hono";
import type { Env } from "../types";
import { currentSupplierReturn, patchSupplierReturn } from "./assrSupplierReturns";
import { utcNowText } from "../lib/utc-now-text";

export interface ReturnDoInput {
  do_no?: string | null;
  do_date?: string | null;
  received_at?: string | null;
  received_by?: string | null;
  remarks?: string | null;
}

export interface TripBackDateRow {
  id: number;
  round_no: number;
  returned_at: string | null;
  archived_at?: string | null;
}

const RETURN_DO_FIELDS = ["do_no", "do_date", "received_at", "received_by", "remarks"] as const;
const DATE_FIELDS = ["do_date", "received_at"] as const;
const TEXT_LIMITS: Record<"do_no" | "received_by" | "remarks", number> = { do_no: 60, received_by: 120, remarks: 1000 };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function returnDoError(body: ReturnDoInput, isCreate: boolean): string | null {
  if (isCreate && !body.do_no?.trim()) return "do_no is required";
  if ("do_no" in body && !isCreate && !body.do_no?.trim()) return "do_no cannot be empty";
  for (const field of DATE_FIELDS) {
    const value = body[field];
    if (value != null && !(typeof value === "string" && ISO_DATE.test(value))) return `${field} must be a YYYY-MM-DD date`;
  }
  for (const [field, limit] of Object.entries(TEXT_LIMITS) as Array<[keyof typeof TEXT_LIMITS, number]>) {
    const value = body[field];
    if (value != null && !(typeof value === "string" && value.length <= limit)) return `${field} must be text of at most ${limit} characters`;
  }
  return null;
}

const QC_TEXT_LIMITS: Record<"qc_by" | "qc_findings", number> = { qc_by: 120, qc_findings: 2000 };

export function qcInspectionFieldsError(body: Record<string, unknown>): string | null {
  const inspectedAt = body.qc_inspected_at;
  if (inspectedAt != null && !(typeof inspectedAt === "string" && ISO_DATE.test(inspectedAt))) return "qc_inspected_at must be a YYYY-MM-DD date";
  for (const [field, limit] of Object.entries(QC_TEXT_LIMITS)) {
    const value = body[field];
    if (value != null && !(typeof value === "string" && value.length <= limit)) return `${field} must be text of at most ${limit} characters`;
  }
  return null;
}

export function tripToFillBackDate<T extends TripBackDateRow>(trips: readonly T[], receivedAt: string | null | undefined): T | null {
  if (!receivedAt) return null;
  const current = currentSupplierReturn(trips);
  return current && !current.returned_at ? current : null;
}

export async function listReturnDos(env: Env, assrId: number): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(
    `SELECT id, assr_id, do_no, do_date, received_at, received_by, remarks, created_at
       FROM assr_return_dos
      WHERE assr_id = ? AND archived_at IS NULL
      ORDER BY id ASC`,
  )
    .bind(assrId)
    .all();
  return (rows.results ?? []) as Array<Record<string, unknown>>;
}

async function fillCurrentTripBackDate(env: Env, assrId: number, receivedAt: string | null | undefined): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, round_no, returned_at, archived_at FROM assr_supplier_returns WHERE assr_id = ? AND archived_at IS NULL`,
  )
    .bind(assrId)
    .all<TripBackDateRow>();
  const trip = tripToFillBackDate(rows.results ?? [], receivedAt);
  if (trip && receivedAt) await patchSupplierReturn(env, assrId, Number(trip.id), { returned_at: receivedAt });
}

function cleanInput(body: ReturnDoInput): ReturnDoInput {
  const cleaned: ReturnDoInput = {};
  for (const field of RETURN_DO_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    cleaned[field] = typeof value === "string" ? value.trim() || null : null;
  }
  return cleaned;
}

export async function addReturnDo(env: Env, assrId: number, userId: number | null, body: ReturnDoInput): Promise<number> {
  const input = cleanInput(body);
  const inserted = await env.DB.prepare(
    `INSERT INTO assr_return_dos (assr_id, do_no, do_date, received_at, received_by, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(assrId, input.do_no ?? "", input.do_date ?? null, input.received_at ?? null, input.received_by ?? null, input.remarks ?? null, userId)
    .run();
  const newId = Number(inserted.meta.last_row_id);
  if (!Number.isInteger(newId) || newId <= 0) throw new Error(`Adding a supplier DO to case ${assrId} returned no id`);
  await fillCurrentTripBackDate(env, assrId, input.received_at);
  return newId;
}

export async function patchReturnDo(env: Env, assrId: number, doId: number, body: ReturnDoInput): Promise<boolean> {
  const input = cleanInput(body);
  const fields = RETURN_DO_FIELDS.filter((field) => field in input);
  if (!fields.length) return false;
  const result = await env.DB.prepare(
    `UPDATE assr_return_dos SET ${fields.map((field) => `${field} = ?`).join(", ")}, updated_at = ?
      WHERE id = ? AND assr_id = ? AND archived_at IS NULL`,
  )
    .bind(...fields.map((field) => input[field] ?? null), utcNowText(), doId, assrId)
    .run();
  if (result.meta.changes > 0) await fillCurrentTripBackDate(env, assrId, input.received_at);
  return result.meta.changes > 0;
}

export async function archiveReturnDo(env: Env, assrId: number, doId: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE assr_return_dos SET archived_at = ?, updated_at = ?
      WHERE id = ? AND assr_id = ? AND archived_at IS NULL`,
  )
    .bind(utcNowText(), utcNowText(), doId, assrId)
    .run();
  return result.meta.changes > 0;
}

type Ctx = Context<{ Bindings: Env }>;
const userIdOf = (c: Ctx): number => (c as unknown as { get?: (key: string) => number }).get?.("userId") ?? 0;
const readBody = async (c: Ctx): Promise<ReturnDoInput> => c.req.json<ReturnDoInput>().catch(() => ({}));

export async function addReturnDoRoute(c: Ctx): Promise<Response> {
  const assrId = Number(c.req.param("id"));
  if (!Number.isInteger(assrId)) return c.json({ error: "Invalid ID" }, 400);
  const body = await readBody(c);
  const invalid = returnDoError(body, true);
  if (invalid) return c.json({ error: invalid }, 400);
  const id = await addReturnDo(c.env, assrId, userIdOf(c), body);
  return c.json({ ok: true, id });
}

export async function patchReturnDoRoute(c: Ctx): Promise<Response> {
  const assrId = Number(c.req.param("id"));
  const doId = Number(c.req.param("doId"));
  if (!Number.isInteger(assrId) || !Number.isInteger(doId)) return c.json({ error: "Invalid ID" }, 400);
  const body = await readBody(c);
  const invalid = returnDoError(body, false);
  if (invalid) return c.json({ error: invalid }, 400);
  const isSaved = await patchReturnDo(c.env, assrId, doId, body);
  return isSaved ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
}

export async function archiveReturnDoRoute(c: Ctx): Promise<Response> {
  const assrId = Number(c.req.param("id"));
  const doId = Number(c.req.param("doId"));
  if (!Number.isInteger(assrId) || !Number.isInteger(doId)) return c.json({ error: "Invalid ID" }, 400);
  const isRemoved = await archiveReturnDo(c.env, assrId, doId);
  return isRemoved ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
}
