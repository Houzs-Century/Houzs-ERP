// ---------------------------------------------------------------------------
// Announcement attachments — the policy and the log (owner 2026-09-06,
// "标准化编号与文档管理": 强制附件 + 操作日志; mig 20260907T0715).
//
//   · POLICY — document_types.attachment_required for the ANN type (mig
//     20260906T1417, edited under Settings → Documents) says whether a notice
//     may be SUBMITTED without an attachment. The gate sits on the two doors
//     into the approval queue (POST without `draft`, POST /:id/submit); a
//     draft may always be saved.
//   · LOG — announcement_files is who attached / removed which file and when.
//     announcements.attachments (the JSON manifest the readers render) stays
//     the source of WHAT is attached; this table is kept in step with it on
//     every create / edit: a key that appears becomes a row with the actor as
//     uploader, a key that disappears keeps its row with removed_by /
//     removed_at, a key that comes back is re-opened.
//
// Both readers tolerate the table (or document_types) being absent — the D1
// test mirrors and the merge-to-migrate window — the same way the reminder
// readers in lib/announcementAudience.ts do: absent policy = not required,
// absent log = nothing logged.
//
// Prepared SQL only (d1-compat): no `--` comments inside a statement.
// ---------------------------------------------------------------------------
import type { Env } from "../types";
import type { AnnouncementAttachment } from "../lib/announcementAudience";
import { getDocumentType, normaliseCode } from "./documentRefs";

export const ANNOUNCEMENT_DOC_TYPE = "ANN";
export const ATTACHMENT_REQUIRED_MESSAGE =
  "An attachment is required before an announcement is submitted. Attach a file, or save it as a draft.";

function isMissingTable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /no such table|does not exist|relation .* does not exist/i.test(msg);
}

/** Does this document type currently demand an attachment before submit?
 *  Unknown type / absent table → false (nothing is blocked by a policy that
 *  has not been set up). */
export async function attachmentRequiredForType(env: Env, typeCode: string): Promise<boolean> {
  try {
    const t = await getDocumentType(env, typeCode);
    return t?.attachmentRequired === true;
  } catch (e) {
    if (isMissingTable(e)) return false;
    throw e;
  }
}

/** The document type a notice is created as (mig 20260908T0300). Absent →
 *  ANN. Anything else must be an ACTIVE row of document_types (Settings →
 *  Documents); an unknown or inactive code is refused with the message to
 *  show. When the registry table is absent (a D1 mirror) the shape alone is
 *  checked. */
export async function resolveDocType(env: Env, raw: unknown): Promise<{ code: string } | { error: string }> {
  if (raw == null || String(raw).trim() === "") return { code: ANNOUNCEMENT_DOC_TYPE };
  const code = normaliseCode(raw);
  if (!code) return { error: "Document type must be a 2–4 letter code (ANN, MEMO)." };
  if (code === ANNOUNCEMENT_DOC_TYPE) return { code };
  try {
    const t = await getDocumentType(env, code);
    if (!t) return { error: `Document type ${code} is not registered (Settings → Documents).` };
    if (!t.isActive) return { error: `Document type ${code} is inactive (Settings → Documents).` };
    return { code };
  } catch (e) {
    if (isMissingTable(e)) return { code };
    throw e;
  }
}

type FileRow = {
  id: number;
  r2_key?: string;
  r2Key?: string;
  removed_at?: string | null;
  removedAt?: string | null;
};

/**
 * Bring the log in step with the manifest the caller just saved. Idempotent:
 * saving the same manifest twice changes nothing. Returns what moved.
 */
export async function syncAttachmentLog(
  env: Env,
  announcementId: string,
  manifest: readonly AnnouncementAttachment[],
  actor: { id: number | null },
  now = Date.now(),
): Promise<{ added: number; removed: number }> {
  const nowIso = new Date(now).toISOString();
  let rows: FileRow[];
  try {
    // company-scope: keyed by the announcement's primary key; the caller already resolved the row within its company scope.
    const res = await env.DB.prepare(
      "SELECT id, r2_key, removed_at FROM announcement_files WHERE announcement_id = ?",
    )
      .bind(announcementId)
      .all<FileRow>();
    rows = res.results;
  } catch (e) {
    if (isMissingTable(e)) return { added: 0, removed: 0 };
    throw e;
  }
  const byKey = new Map<string, FileRow>();
  for (const r of rows) byKey.set(r.r2Key ?? r.r2_key ?? "", r);
  const wanted = new Map<string, AnnouncementAttachment>();
  for (const a of manifest) if (a.r2Key) wanted.set(a.r2Key, a);

  let added = 0;
  let removed = 0;
  for (const [key, a] of wanted) {
    const row = byKey.get(key);
    if (!row) {
      // company-scope: log row for one announcement (see above).
      await env.DB.prepare(
        `INSERT INTO announcement_files
           (announcement_id, r2_key, name, mime, size, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(announcementId, key, a.name || null, a.mime || null, a.size ?? null, actor.id, nowIso)
        .run();
      added += 1;
    } else if ((row.removedAt ?? row.removed_at) != null) {
      // Re-attached after a removal: the same key is live again under the
      // actor who brought it back.
      // company-scope: log row for one announcement (see above).
      await env.DB.prepare(
        "UPDATE announcement_files SET removed_by = NULL, removed_at = NULL, uploaded_by = ?, uploaded_at = ? WHERE id = ?",
      )
        .bind(actor.id, nowIso, row.id)
        .run();
      added += 1;
    }
  }
  for (const [key, row] of byKey) {
    if (wanted.has(key) || (row.removedAt ?? row.removed_at) != null) continue;
    // company-scope: log row for one announcement (see above).
    await env.DB.prepare(
      "UPDATE announcement_files SET removed_by = ?, removed_at = ? WHERE id = ?",
    )
      .bind(actor.id, nowIso, row.id)
      .run();
    removed += 1;
  }
  return { added, removed };
}

export type AnnouncementFileLog = {
  id: number;
  r2Key: string;
  name: string | null;
  mime: string | null;
  size: number | null;
  uploadedBy: number | null;
  uploadedByName: string | null;
  uploadedAt: string;
  removedBy: number | null;
  removedByName: string | null;
  removedAt: string | null;
};

type LogRow = {
  id: number;
  r2_key?: string; r2Key?: string;
  name?: string | null;
  mime?: string | null;
  size?: number | null;
  uploaded_by?: number | null; uploadedBy?: number | null;
  uploaded_by_name?: string | null; uploadedByName?: string | null;
  uploaded_at?: string; uploadedAt?: string;
  removed_by?: number | null; removedBy?: number | null;
  removed_by_name?: string | null; removedByName?: string | null;
  removed_at?: string | null; removedAt?: string | null;
};

/** The full log for one notice — live and removed rows, oldest first, with
 *  the people resolved to names. Absent table → []. */
export async function listAttachmentLog(env: Env, announcementId: string): Promise<AnnouncementFileLog[]> {
  try {
    // company-scope: keyed by the announcement's primary key; the route resolved the row within its company scope.
    const res = await env.DB.prepare(
      `SELECT f.id, f.r2_key, f.name, f.mime, f.size,
              f.uploaded_by, up.name AS uploaded_by_name, f.uploaded_at,
              f.removed_by, rm.name AS removed_by_name, f.removed_at
         FROM announcement_files f
         LEFT JOIN users up ON up.id = f.uploaded_by
         LEFT JOIN users rm ON rm.id = f.removed_by
        WHERE f.announcement_id = ?
        ORDER BY f.uploaded_at, f.id`,
    )
      .bind(announcementId)
      .all<LogRow>();
    return res.results.map((r) => ({
      id: Number(r.id),
      r2Key: r.r2Key ?? r.r2_key ?? "",
      name: r.name ?? null,
      mime: r.mime ?? null,
      size: r.size == null ? null : Number(r.size),
      uploadedBy: r.uploadedBy ?? r.uploaded_by ?? null,
      uploadedByName: r.uploadedByName ?? r.uploaded_by_name ?? null,
      uploadedAt: r.uploadedAt ?? r.uploaded_at ?? "",
      removedBy: r.removedBy ?? r.removed_by ?? null,
      removedByName: r.removedByName ?? r.removed_by_name ?? null,
      removedAt: r.removedAt ?? r.removed_at ?? null,
    }));
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
}
