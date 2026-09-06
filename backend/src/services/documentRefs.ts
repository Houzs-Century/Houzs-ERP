// ---------------------------------------------------------------------------
// Document reference numbers — [DEPT]-[TYPE]-[YYMM]-[NNNN] (owner 2026-09-06,
// "标准化编号与文档管理", plan A: NEW document families only; the SCM
// documents keep their HC-SO-2609-001 numbers, which are in AutoCount and on
// paper and cannot change).
//
// ONE mint, three guarantees, all inherited from the SCM counter (mig 0316,
// scm.next_doc_no_n / scm.doc_number_counters):
//   · unique under concurrency — the counter is one INSERT … ON CONFLICT DO
//     UPDATE … RETURNING per series, so two simultaneous saves serialise on
//     the row lock; the registry's PRIMARY KEY on ref_no is the belt, and a
//     collision (only possible on the fallback path) is retried;
//   · monthly reset — the month is part of the series key
//     ("OPS-ANN-2609"), so a new month starts at 0001 by construction;
//   · never re-used — the counter only rises; voiding a document keeps its
//     number (status VOID in the registry), a gap is expected and correct.
//
// The registry (public.document_refs, mig 20260906T1417) is what answers
// "which record holds OPS-ANN-2609-0007, who minted it, is it void" — the
// document's own row carries the number too, but the registry is the index.
//
// Prepared SQL only (d1-compat): no `--` comments inside a statement.
// ---------------------------------------------------------------------------
import type { Env } from "../types";

export type DocumentRef = {
  refNo: string;
  series: string;
  deptCode: string;
  typeCode: string;
  yymm: string;
  seq: number;
  entityType: string;
  entityId: string;
  status: "ACTIVE" | "VOID";
  createdBy: number | null;
  createdAt: string;
  voidedBy: number | null;
  voidedAt: string | null;
  voidReason: string | null;
};

/** The company runs on Malaysia time: the month in the number is the month
 *  the office sees, not the UTC month (an 11 pm post on the 31st is still
 *  this month's number). */
const MYT_OFFSET_MS = 8 * 3_600_000;
export function yymmFor(nowMs = Date.now()): string {
  const d = new Date(nowMs + MYT_OFFSET_MS);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}${mm}`;
}

const CODE_RE = /^[A-Z]{2,4}$/;
/** A department / type code: 2–4 capital letters (the spec's 3 and 2–3). */
export function normaliseCode(v: unknown): string | null {
  const s = String(v ?? "").trim().toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

export const REF_NO_RE = /^([A-Z]{2,4})-([A-Z]{2,4})-(\d{4})-(\d{4})$/;
export function formatRefNo(deptCode: string, typeCode: string, yymm: string, seq: number): string {
  return `${deptCode}-${typeCode}-${yymm}-${String(seq).padStart(4, "0")}`;
}

const MAX_ATTEMPTS = 8;

function isMissingFunction(msg: string): boolean {
  return /no such function|does not exist|near "\."|syntax error/i.test(msg);
}
function isUniqueViolation(msg: string): boolean {
  return /unique|duplicate key|23505/i.test(msg);
}

/** The highest sequence the registry holds for a series (the counter's floor). */
async function seriesFloor(env: Env, series: string): Promise<number> {
  // company-scope: a global registry keyed by (department, type, month); numbers are company-wide by design.
  const row = await env.DB.prepare("SELECT MAX(seq) AS m FROM document_refs WHERE series = ?")
    .bind(series)
    .first<{ m?: number | null }>();
  const m = Number(row?.m ?? 0);
  return Number.isFinite(m) && m > 0 ? m : 0;
}

/** Ask the shared counter for the next number, never below floor + 1. Null
 *  when the counter function is not present (the D1 test mirror, or the
 *  window between a merge and pg-migrate) — the caller then falls back to
 *  floor + 1 guarded by the registry's primary key. Any other failure throws:
 *  a fallback taken on a real error would mint against a database that just
 *  refused the atomic path. */
async function claimFromCounter(env: Env, series: string, floor: number): Promise<number | null> {
  try {
    // company-scope: the counter is the same company-wide authority the SCM document numbers use (mig 0316).
    const row = await env.DB.prepare("SELECT scm.next_doc_no_n(?, ?) AS n")
      .bind(series, floor)
      .first<{ n?: number | null }>();
    const n = Number(row?.n);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`next_doc_no_n(${series}, ${floor}) returned no usable number`);
    }
    return n;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isMissingFunction(msg)) return null;
    throw e;
  }
}

export type MintInput = {
  deptCode: string;
  typeCode: string;
  entityType: string;
  entityId: string;
  createdBy: number | null;
  now?: number;
};

/**
 * Mint the next reference number for (department, type, this month) and
 * register it against the record. A record that already holds a number gets
 * the same one back (the registry's (entity_type, entity_id) is unique), so
 * a retried save can never mint twice.
 */
export async function mintDocumentRef(env: Env, input: MintInput): Promise<DocumentRef> {
  const deptCode = normaliseCode(input.deptCode);
  const typeCode = normaliseCode(input.typeCode);
  if (!deptCode) throw new Error("Department code must be 2–4 letters");
  if (!typeCode) throw new Error("Document type code must be 2–4 letters");
  const existing = await findRefForEntity(env, input.entityType, input.entityId);
  if (existing) return existing;

  const now = input.now ?? Date.now();
  const yymm = yymmFor(now);
  const series = `${deptCode}-${typeCode}-${yymm}`;
  const createdAt = new Date(now).toISOString();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const floor = await seriesFloor(env, series);
    const seq = (await claimFromCounter(env, series, floor)) ?? floor + 1;
    const refNo = formatRefNo(deptCode, typeCode, yymm, seq);
    try {
      // company-scope: global registry insert; the number is company-wide by design.
      await env.DB.prepare(
        `INSERT INTO document_refs
           (ref_no, series, dept_code, type_code, yymm, seq, entity_type, entity_id, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      )
        .bind(refNo, series, deptCode, typeCode, yymm, seq, input.entityType, input.entityId, input.createdBy, createdAt)
        .run();
      return {
        refNo,
        series,
        deptCode,
        typeCode,
        yymm,
        seq,
        entityType: input.entityType,
        entityId: input.entityId,
        status: "ACTIVE",
        createdBy: input.createdBy,
        createdAt,
        voidedBy: null,
        voidedAt: null,
        voidReason: null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = e;
      // Someone took this number between our floor read and our insert (only
      // reachable without the counter): read the floor again and go round.
      if (isUniqueViolation(msg)) continue;
      throw e;
    }
  }
  throw new Error(
    `Could not mint a reference number for ${series} after ${MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

type Row = {
  ref_no?: string; refNo?: string;
  series?: string;
  dept_code?: string; deptCode?: string;
  type_code?: string; typeCode?: string;
  yymm?: string;
  seq?: number;
  entity_type?: string; entityType?: string;
  entity_id?: string; entityId?: string;
  status?: string;
  created_by?: number | null; createdBy?: number | null;
  created_at?: string; createdAt?: string;
  voided_by?: number | null; voidedBy?: number | null;
  voided_at?: string | null; voidedAt?: string | null;
  void_reason?: string | null; voidReason?: string | null;
};

function toRef(r: Row): DocumentRef {
  return {
    refNo: r.refNo ?? r.ref_no ?? "",
    series: r.series ?? "",
    deptCode: r.deptCode ?? r.dept_code ?? "",
    typeCode: r.typeCode ?? r.type_code ?? "",
    yymm: r.yymm ?? "",
    seq: Number(r.seq ?? 0),
    entityType: r.entityType ?? r.entity_type ?? "",
    entityId: r.entityId ?? r.entity_id ?? "",
    status: (r.status === "VOID" ? "VOID" : "ACTIVE"),
    createdBy: r.createdBy ?? r.created_by ?? null,
    createdAt: r.createdAt ?? r.created_at ?? "",
    voidedBy: r.voidedBy ?? r.voided_by ?? null,
    voidedAt: r.voidedAt ?? r.voided_at ?? null,
    voidReason: r.voidReason ?? r.void_reason ?? null,
  };
}

/** The registry row for a number, or null. Case-insensitive on the number. */
export async function findRef(env: Env, refNo: string): Promise<DocumentRef | null> {
  const key = String(refNo).trim().toUpperCase();
  if (!REF_NO_RE.test(key)) return null;
  // company-scope: global registry lookup by primary key.
  const row = await env.DB.prepare("SELECT * FROM document_refs WHERE ref_no = ?")
    .bind(key)
    .first<Row>();
  return row ? toRef(row) : null;
}

/** The number a record holds, or null when it was never minted one. */
export async function findRefForEntity(env: Env, entityType: string, entityId: string): Promise<DocumentRef | null> {
  // company-scope: global registry lookup by the record it indexes.
  const row = await env.DB.prepare(
    "SELECT * FROM document_refs WHERE entity_type = ? AND entity_id = ?",
  )
    .bind(entityType, entityId)
    .first<Row>();
  return row ? toRef(row) : null;
}

/**
 * Void a number: it stays in the registry (audit), keeps its place in the
 * sequence (never re-issued), and records who / when / why. Idempotent.
 */
export async function voidDocumentRef(
  env: Env,
  refNo: string,
  by: number | null,
  reason: string,
  now = Date.now(),
): Promise<DocumentRef | null> {
  const current = await findRef(env, refNo);
  if (!current) return null;
  if (current.status === "VOID") return current;
  const voidedAt = new Date(now).toISOString();
  // company-scope: global registry update by primary key.
  await env.DB.prepare(
    "UPDATE document_refs SET status = 'VOID', voided_by = ?, voided_at = ?, void_reason = ? WHERE ref_no = ?",
  )
    .bind(by, voidedAt, reason.trim() || null, current.refNo)
    .run();
  return { ...current, status: "VOID", voidedBy: by, voidedAt, voidReason: reason.trim() || null };
}

export type DocumentType = {
  code: string;
  label: string;
  attachmentRequired: boolean;
  isActive: boolean;
};

export async function listDocumentTypes(env: Env, includeInactive = false): Promise<DocumentType[]> {
  // company-scope: a global policy table (one row per document type), not per company.
  const res = await env.DB.prepare(
    `SELECT code, label, attachment_required, is_active FROM document_types${includeInactive ? "" : " WHERE is_active = 1"} ORDER BY code`,
  ).all<{ code: string; label: string; attachment_required?: number; attachmentRequired?: number; is_active?: number; isActive?: number }>();
  return res.results.map((r) => ({
    code: r.code,
    label: r.label,
    attachmentRequired: (r.attachmentRequired ?? r.attachment_required ?? 0) === 1,
    isActive: (r.isActive ?? r.is_active ?? 1) === 1,
  }));
}

/** The type's policy row, or null when the type is unknown. */
export async function getDocumentType(env: Env, code: string): Promise<DocumentType | null> {
  const key = normaliseCode(code);
  if (!key) return null;
  const all = await listDocumentTypes(env, true);
  return all.find((t) => t.code === key) ?? null;
}
