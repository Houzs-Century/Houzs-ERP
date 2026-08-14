import type { Env } from "../types";
import { logProjectActivity } from "./projects";

/**
 * Read the total booth area (m²) off an uploaded Display Floor Plan.
 *
 * Owner 2026-08-04: "add features can read measurement for total size (sqm)
 * from display floorplan". Extracted from routes/projects.ts (2026-08-14) so
 * the route is a thin call — the prompt, the per-kind size ceilings and the
 * write policy are the parts that get re-read.
 *
 * Write policy: a detected size only overwrites an existing one when the caller
 * asks (`overwrite`), and every write is stamped on the project activity log
 * with the file and the model's own evidence, so a wrong read is traceable
 * rather than mysterious.
 */

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
    );
  }
  return btoa(binary);
}

const FLOORPLAN_SIZE_PROMPT = `You are reading an exhibition/mall BOOTH FLOOR PLAN for Houzs Century.

Return ONLY minified JSON, no prose:
{"total_sqm": <number|null>, "method": "<explicit_total|dimensions|booth_count|none>", "evidence": "<short quote of what you read>", "booth_count": <number|null>, "confidence": "<high|medium|low>"}

How to decide total_sqm, in priority order:
1. explicit_total — the plan states a total area for OUR booth ("72 sqm", "72 m2", "72m²", "SIZE: 72"). Use it verbatim.
2. dimensions — the plan gives our booth's width x depth in metres ("8m x 9m", "8 x 9"). total_sqm = width * depth.
3. booth_count — the plan only identifies booth NUMBERS/units for us (e.g. "195-202 (8 BOOTH)", or 8 highlighted cells). A Houzs standard booth is 3m x 3m = 9 m², so total_sqm = booth_count * 9. Set booth_count.
4. none — you cannot tell. total_sqm must be null. NEVER guess.

Rules:
- Measure OUR booth only (usually highlighted/coloured/labelled Houzs, AKEMI, ZANOTTI, ERGOTEX), never the whole hall.
- Units are metres. If a dimension is clearly in feet, convert (1 ft = 0.3048 m) and say so in evidence.
- Round total_sqm to a whole number when it is within 0.5 of one.
- confidence: high = you read a clear total or clear dimensions; medium = derived from booth count or a partly legible label; low = anything shakier. If low and you are not reasonably sure, prefer total_sqm null.`;

export type FloorplanSizeResult =
  | { ok: false; status: 400 | 404 | 502 | 503; error: string }
  | {
      ok: true;
      detected_sqm: number | null;
      applied: boolean;
      skipped_reason: string | null;
      previous_sqm: number | null;
      method: string;
      evidence: string | null;
      booth_count: number | null;
      confidence: string;
      source_file: string;
    };

/** Does this checklist item hold the floorplan we read sizes from? Templates
 *  use both namings, and titles carry owner-added suffixes. */
export function isFloorplanTitle(title: string | null | undefined): boolean {
  return /^(display floor\s*plan|blank floorplan)/i.test((title ?? "").trim());
}

/**
 * `overwrite`:
 *   false  — never touch an existing size (the old post-upload behaviour)
 *   true   — always write (the manual "Auto" button; the user asked for it)
 *   "auto" — write when the box is empty, OR when the value standing there is
 *            the one a previous read wrote. A number a person typed always
 *            wins; a stale auto-read gets refreshed when a corrected plan is
 *            uploaded (owner 2026-08-14).
 */
async function mayWrite(
  env: Env,
  id: number,
  current: number | null,
  mode: boolean | "auto",
): Promise<boolean> {
  const hasValue = current != null && Number(current) > 0;
  if (!hasValue) return true;
  if (mode === true) return true;
  if (mode !== "auto") return false;
  const last = await env.DB.prepare(
    `SELECT to_value FROM project_activity
      WHERE project_id = ? AND action = 'floorplan_size_detected'
      ORDER BY id DESC LIMIT 1`
  )
    .bind(id)
    .first<{ to_value: string | null }>();
  if (!last?.to_value) return false; // nothing was ever auto-written: a human typed this
  return Number(last.to_value) === Number(current);
}

export async function detectFloorplanSize(
  env: Env,
  id: number,
  opts: { overwrite: boolean | "auto"; userId: number | null },
): Promise<FloorplanSizeResult> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 503, error: "Reading floorplans isn't configured on this server." };
  }
  const project = await env.DB.prepare(`SELECT id, size_sqm, booth_no FROM projects WHERE id = ?`)
    .bind(id)
    .first<{ id: number; size_sqm: number | null; booth_no: string | null }>();
  if (!project) return { ok: false, status: 404, error: "Not found" };

  // Newest live attachment on a Display Floor Plan item (title tolerates the
  // "Display Floor Plan" / "Blank Floorplan" naming both used in templates).
  const att = await env.DB.prepare(
    `SELECT a.r2_key, a.file_name, a.content_type
       FROM project_checklist_attachments a
       JOIN project_checklist pc ON pc.id = a.item_id
      WHERE pc.project_id = ?
        AND a.archived_at IS NULL
        AND (pc.title LIKE 'Display Floor Plan%' OR pc.title LIKE 'Blank Floorplan%')
      ORDER BY a.uploaded_at DESC, a.id DESC
      LIMIT 1`
  )
    .bind(id)
    .first<{ r2_key: string; file_name: string; content_type: string | null }>();
  if (!att) return { ok: false, status: 400, error: "No floorplan uploaded yet." };

  const obj = await env.POD_BUCKET.get(att.r2_key);
  if (!obj) return { ok: false, status: 404, error: "The floorplan file is missing from storage." };
  const buf = await obj.arrayBuffer();
  const mime = (att.content_type || obj.httpMetadata?.contentType || "").toLowerCase();
  // Images go as image blocks; PDFs as a document block (both supported by the
  // model the scan pipeline already uses).
  const isPdf = mime.includes("pdf") || /\.pdf$/i.test(att.file_name);
  const isImage =
    /^image\/(jpeg|png|webp|gif)$/.test(mime) || /\.(jpe?g|png|webp|gif)$/i.test(att.file_name);
  if (!isPdf && !isImage) {
    return { ok: false, status: 400, error: "Only image or PDF floorplans can be read." };
  }
  // Per-kind ceilings: the API caps an IMAGE block near 5MB, while a PDF
  // document block may be much larger (the 32MB request budget is the real
  // limit, and base64 inflates ~33%, so 12MB of PDF is about 16MB on the wire).
  // A venue master floorplan PDF routinely exceeds 5MB — the flat 5MB cap
  // rejected them outright (project 187, verified 2026-08-05).
  const maxBytes = isPdf ? 12 * 1024 * 1024 : 5 * 1024 * 1024;
  if (buf.byteLength > maxBytes) {
    return {
      ok: false,
      status: 400,
      error: `That floorplan is too large to read (${Math.round(
        buf.byteLength / 1024 / 1024,
      )}MB; limit ${maxBytes / 1024 / 1024}MB for ${isPdf ? "PDFs" : "images"}). Please type the size in.`,
    };
  }
  const b64 = arrayBufferToBase64(buf);
  const fileBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : {
        type: "image",
        source: {
          type: "base64",
          media_type:
            /png$/i.test(mime) || /\.png$/i.test(att.file_name)
              ? "image/png"
              : /webp/i.test(mime)
                ? "image/webp"
                : "image/jpeg",
          data: b64,
        },
      };
  const hint = project.booth_no
    ? `\n\nThe operator recorded our booth number(s) as: ${project.booth_no}. Use it to identify OUR booth and, if it names a count, to sanity-check booth_count.`
    : "";

  let parsed: {
    total_sqm: number | null;
    method?: string;
    evidence?: string;
    booth_count?: number | null;
    confidence?: string;
  } | null = null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [
          { role: "user", content: [fileBlock, { type: "text", text: FLOORPLAN_SIZE_PROMPT + hint }] },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error("[floorplan-size] anthropic", resp.status, detail.slice(0, 300));
      return { ok: false, status: 502, error: "Couldn't read the floorplan just now. Please try again." };
    }
    const data = await resp.json<{ content?: { type: string; text?: string }[] }>();
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error("[floorplan-size] failed", e);
    return { ok: false, status: 502, error: "Couldn't read the floorplan just now. Please try again." };
  }

  const raw = parsed?.total_sqm;
  const detected =
    typeof raw === "number" && isFinite(raw) && raw > 0 && raw < 100_000
      ? Math.round(raw * 100) / 100
      : null;
  const hadValue = project.size_sqm != null && Number(project.size_sqm) > 0;
  let applied = false;
  if (detected != null && (await mayWrite(env, id, project.size_sqm, opts.overwrite))) {
    await env.DB.prepare(`UPDATE projects SET size_sqm = ? WHERE id = ?`).bind(detected, id).run();
    applied = true;
    await logProjectActivity(
      env,
      id,
      "floorplan_size_detected",
      hadValue ? String(project.size_sqm) : null,
      String(detected),
      `Read from ${att.file_name} (${parsed?.method ?? "?"}${parsed?.evidence ? `: ${parsed.evidence}` : ""})`,
      opts.userId,
    );
  }
  return {
    ok: true,
    detected_sqm: detected,
    applied,
    skipped_reason: detected == null ? "not_found" : applied ? null : "already_set",
    previous_sqm: project.size_sqm ?? null,
    method: parsed?.method ?? "none",
    evidence: parsed?.evidence ?? null,
    booth_count: parsed?.booth_count ?? null,
    confidence: parsed?.confidence ?? "low",
    source_file: att.file_name,
  };
}
