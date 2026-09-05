// ============================================================
// Announcements — office posts every logged-in user sees as a top-of-screen
// banner with a "Got it" acknowledgement. Ported from Hookka
// (src/api/routes/announcements.ts), adapted for Houzs:
//   - Single-tenant (no org_id).
//   - No worker portal: every user is office staff who logs in via /api/auth.
//   - Targeting reframed: ALL_USERS | DEPARTMENT_IDS | POSITION_IDS | USER_IDS
//     | MIXED. Lists hold INTEGER ids (matches users.id / departments.id /
//     positions.id). Workers / dept-codes don't exist on this side.
//   - No web push (Houzs has no push_subscriptions). BrowserPushSink already
//     fires native Notifications off the polled activity feed; reusing that
//     here is a future enhancement.
//   - Translate-announcement.ts is ported and called best-effort. Returns null
//     when ANTHROPIC_API_KEY is unset → FE falls back to original text.
//   - No runtime self-apply DDL block: Houzs migrates-before-deploy
//     (mig 0058 must be applied before this route's first request).
// ============================================================
import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermissionOrSalesDirector } from "../middleware/auth";
import { hasPermission } from "../services/permissions";
import { baseKeyOf, isThumbKey, THUMB_MAX_BYTES, thumbKeyFor } from "../services/photoThumbs";
import { isSalesDirectorUser } from "../services/pmsAccess";
import type { AuthUser } from "../services/auth";
import { activeCompanyId, allowedCompanyIds } from "../scm/lib/companyScope";
import {
  CONFIG_CACHE_TTL_SECONDS,
  bannerCacheKey,
  bumpConfigVersion,
  bustBannerForUser,
  configCacheVersion,
} from "../services/configCache";
import type { BannerScope } from "../services/configCache";
import {
  translateAnnouncement,
  type AnnouncementTranslations,
} from "../lib/translate-announcement";
import {
  RICH_HTML_MAX,
  hasRichFormatting,
  richTextToPlain,
  sanitizeAnnouncementHtml,
  stripUnreferencedImages,
} from "../lib/announcementRichText";
import { postPersonalNotice } from "../services/personalNotice";

const app = new Hono<{ Bindings: Env }>();

// Multi-company: announcements are a UNIFIED module with a COMPANY-TARGET
// dimension (owner decision 2026-07). Rather than hard-isolating each company's
// stream by the active/switched company, a notice carries target_company_ids
// (mig 0113); a reader sees it only if that list is NULL/empty (= all companies)
// OR intersects the reader's OWN companies (c.get('allowedCompanyIds') — their
// user_companies grants, fail-open to all when unresolved). The per-row
// company_id (mig 0093) is retained as the AUTHORING company (stamped on POST,
// used for read-receipt ack tagging); it no longer gates visibility. The
// company gate is an ADDITIONAL AND filter layered on top of the existing
// dept/position/user audience match — a notice must pass BOTH.

// The four announcement categories. GENERAL is the back-compat default.
type AnnouncementCategory = "GENERAL" | "WARNING" | "SOP" | "LEARNING";

// Targeting kinds. ALL_USERS = everyone (the back-compat default).
type TargetType =
  | "ALL_USERS"
  | "DEPARTMENT_IDS"
  | "POSITION_IDS"
  | "USER_IDS"
  | "MIXED";

// One attached media file on an announcement. `r2Key` lives in POD_BUCKET.
// `name` is the original filename; `mime` drives the renderer (image/video/pdf).
type AnnouncementAttachment = {
  r2Key: string;
  name: string;
  mime: string;
  size?: number;
};

// Rich-media LAYOUT hint (mig 0140). The author picks how the media is laid out;
// every renderer (desktop pop-up + page, mobile detail) honours the SAME hint so
// a notice looks identical everywhere. Both keys optional — a missing key means
// "derive a default from the attachment count", which is exactly how pre-0140
// (NULL) rows keep rendering unchanged.
//   · photo: how the photo set is arranged — "1" one big, "2" side-by-side,
//     "3" three across, "4" a 2x2 grid.
//   · video: the video block's shape — "1x1" square, "1x2" portrait (tall).
type PhotoLayout = "1" | "2" | "3" | "4";
type VideoLayout = "1x1" | "1x2";
type MediaLayout = { photo?: PhotoLayout; video?: VideoLayout };

// Parse the stored media_layout JSON, dropping anything not in the small allowed
// set. Returns null when empty/unrecognised so toPublic emits `mediaLayout: null`
// and the client falls back to count-derived defaults.
function readMediaLayout(raw: unknown): MediaLayout | null {
  let obj: unknown = raw;
  if (typeof obj === "string") {
    const s = obj.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const out: MediaLayout = {};
  const photo = String(o.photo ?? "").trim();
  if (photo === "1" || photo === "2" || photo === "3" || photo === "4") {
    out.photo = photo;
  }
  const video = String(o.video ?? "").trim();
  if (video === "1x1" || video === "1x2") out.video = video;
  return out.photo || out.video ? out : null;
}

// Raw row shape from the DB (dual-keyed because the pg driver folds
// snake_case -> camelCase on read — the #1 Hookka read-gotcha).
type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  // Rich body (mig 20260904T1700). Canonical HTML fragment — see
  // lib/announcementRichText.ts — or NULL for a plain-text notice. `body` is
  // ALWAYS the plain-text shadow of it, so plain-only readers need no branch.
  body_html?: string | null;
  bodyHtml?: string | null;
  // Per-notice "must acknowledge" flag (mig 20260905T1125), integer 0/1. NULL
  // only on a pre-migration row / the D1 test mirror — toPublic then emits
  // null and the client falls back to the category rule (WARNING / SOP).
  require_ack?: number | boolean | null;
  requireAck?: number | boolean | null;
  // Scheduled posting instant (same migration). ISO text; NULL = posted at
  // once. A row is not delivered (list / banner / ack) before it.
  scheduled_at?: string | null;
  scheduledAt?: string | null;
  is_active?: number | boolean | null;
  isActive?: number | boolean | null;
  expires_at?: string | null;
  expiresAt?: string | null;
  reminded_at?: string | null;
  remindedAt?: string | null;
  created_by?: number | null;
  createdBy?: number | null;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
  translations?: AnnouncementTranslations | string | null;
  attachments?: string | unknown[] | null;
  // Rich-media layout hint (mig 0140). JSON string, dual-keyed for the pg
  // snake->camel fold. NULL = derive a default from the attachment count.
  media_layout?: string | MediaLayout | null;
  mediaLayout?: string | MediaLayout | null;
  target_type?: string | null;
  targetType?: string | null;
  target_dept_ids?: string | number[] | null;
  targetDeptIds?: string | number[] | null;
  target_position_ids?: string | number[] | null;
  targetPositionIds?: string | number[] | null;
  target_user_ids?: string | number[] | null;
  targetUserIds?: string | number[] | null;
  // Company-targeting dimension (mig 0113). JSON array of company ids, e.g.
  // '[1]' or '[1,2]'. NULL / empty = ALL companies (visible to everyone). The
  // existing per-row company_id below is the AUTHORING company; this is the
  // independent audience filter combined (AND) with the dept/position/user
  // audience match. See userCompanyCanSee / the unified read paths below.
  target_company_ids?: string | number[] | null;
  targetCompanyIds?: string | number[] | null;
  category?: string | null;
  source?: string | null;
  company_id?: number | null;
  companyId?: number | null;
};

function readCategory(v: unknown): AnnouncementCategory {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "WARNING" || s === "SOP" || s === "LEARNING") return s;
  return "GENERAL";
}

function isActiveFlag(v: number | boolean | null | undefined): boolean {
  return v === true || v === 1;
}

function notExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t > Date.now();
}

// Categories that block by default — the value the require_ack flag takes when
// the composer does not say otherwise, and the rule a pre-migration row falls
// back to. Mirrors frontend/src/components/announcementCategory.ts.
function categoryRequiresAck(category: AnnouncementCategory): boolean {
  return category === "WARNING" || category === "SOP";
}

// The stored flag, or null when the column is absent / NULL (pre-migration row,
// D1 test mirror) so the client applies the category rule itself.
function readRequireAck(v: number | boolean | null | undefined): boolean | null {
  if (v == null) return null;
  return v === true || v === 1;
}

// Not yet reached its scheduled posting instant. NULL / unparseable = live now.
function scheduledLater(scheduledAt: string | null | undefined, now = Date.now()): boolean {
  if (!scheduledAt) return false;
  const t = Date.parse(scheduledAt);
  return !Number.isNaN(t) && t > now;
}

// Is this row DELIVERABLE to a reader right now? Active, past its schedule,
// and not expired — where an SOP never expires (redesign 2026-09-04: the SOP
// Library is permanent, so a stale expires_at on an SOP is ignored rather than
// silently pulling a standing procedure off everyone's screen). The list's
// reader branch, /banner and the ack POST all use this one answer.
function deliverableNow(r: AnnouncementRow, now = Date.now()): boolean {
  if (!isActiveFlag(r.isActive ?? r.is_active ?? null)) return false;
  if (scheduledLater(r.scheduledAt ?? r.scheduled_at ?? null, now)) return false;
  if (readCategory(r.category) === "SOP") return true;
  return notExpired(r.expiresAt ?? r.expires_at ?? null);
}

function isRemindedSince(
  remindedAt: string | null,
  ackedAt: string | null,
): boolean {
  if (!remindedAt || !ackedAt) return false;
  const r = Date.parse(remindedAt);
  const a = Date.parse(ackedAt);
  if (Number.isNaN(r) || Number.isNaN(a)) return false;
  return r > a;
}

function readTranslations(r: AnnouncementRow): AnnouncementTranslations | null {
  const raw = r.translations ?? null;
  if (raw == null) return null;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as AnnouncementTranslations;
    } catch {
      return null;
    }
  }
  return raw;
}

// Parse a stored JSON array of integers. Tolerates a JSON string OR a parsed
// array; drops non-numbers; deduplicates.
function readIntArray(v: string | number[] | null | undefined): number[] {
  if (v == null) return [];
  let arr: unknown = v;
  if (typeof v === "string") {
    if (!v.trim()) return [];
    try {
      arr = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of arr) {
    const n = typeof x === "number" ? x : parseInt(String(x), 10);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function normalizeAttachments(raw: unknown): AnnouncementAttachment[] {
  let arr: unknown = raw;
  if (typeof arr === "string") {
    const s = arr.trim();
    if (!s) return [];
    try {
      arr = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: AnnouncementAttachment[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const r2Key = String(o.r2Key ?? o.r2_key ?? "").trim();
    if (!r2Key) continue;
    const att: AnnouncementAttachment = {
      r2Key,
      name: String(o.name ?? "").trim(),
      mime: String(o.mime ?? o.contentType ?? "").trim(),
    };
    const size = Number(o.size);
    if (Number.isFinite(size) && size > 0) att.size = size;
    out.push(att);
  }
  return out;
}

function readTargetType(r: AnnouncementRow): TargetType {
  const t = String(r.targetType ?? r.target_type ?? "ALL_USERS").toUpperCase();
  if (
    t === "DEPARTMENT_IDS" ||
    t === "POSITION_IDS" ||
    t === "USER_IDS" ||
    t === "MIXED"
  )
    return t;
  return "ALL_USERS";
}

// Derive the canonical target_type from which target lists are non-empty.
// Empty all -> ALL_USERS; one bucket -> that bucket's enum; multiple -> MIXED.
function deriveTargetType(
  deptIds: number[],
  positionIds: number[],
  userIds: number[],
): TargetType {
  const buckets =
    (deptIds.length > 0 ? 1 : 0) +
    (positionIds.length > 0 ? 1 : 0) +
    (userIds.length > 0 ? 1 : 0);
  if (buckets === 0) return "ALL_USERS";
  if (buckets > 1) return "MIXED";
  if (deptIds.length > 0) return "DEPARTMENT_IDS";
  if (positionIds.length > 0) return "POSITION_IDS";
  return "USER_IDS";
}

// The rich body as the client may send it. Returns the canonical HTML, or null
// when there is nothing a plain string could not carry (no marks, no lists, no
// sizes) — that keeps every unformatted notice on the pre-feature plain path.
// `canonical` is the same fragment even when `html` folded to null — the
// plain-text shadow is derived from it, never from the client's string.
// `error` is set only for a fragment past the hard cap; the caller 400s it.
//
// Inline images (2026-09-05): an `<img data-att>` may only name one of THIS
// notice's attachments (`attachmentKeys` = the manifest about to be stored).
// The serve route refuses any other key anyway, so stripping here only turns
// a broken image into no image — but it keeps the stored body honest.
function readBodyHtml(
  v: unknown,
  attachmentKeys: readonly string[],
): { html: string | null; canonical: string; error?: string } {
  if (typeof v !== "string" || !v.trim()) return { html: null, canonical: "" };
  if (v.length > RICH_HTML_MAX) {
    return { html: null, canonical: "", error: `Message too long (${RICH_HTML_MAX} max)` };
  }
  const canonical = stripUnreferencedImages(sanitizeAnnouncementHtml(v), attachmentKeys);
  return { html: hasRichFormatting(canonical) ? canonical : null, canonical };
}

function toPublic(r: AnnouncementRow) {
  return {
    id: r.id,
    title: r.title,
    body: r.body ?? "",
    bodyHtml: r.bodyHtml ?? r.body_html ?? null,
    isActive: isActiveFlag(r.isActive ?? r.is_active ?? null),
    expiresAt: r.expiresAt ?? r.expires_at ?? null,
    createdAt: r.createdAt ?? r.created_at ?? null,
    createdBy: r.createdBy ?? r.created_by ?? null,
    remindedAt: r.remindedAt ?? r.reminded_at ?? null,
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
    translations: readTranslations(r),
    attachments: normalizeAttachments(r.attachments ?? null),
    mediaLayout: readMediaLayout(r.mediaLayout ?? r.media_layout ?? null),
    targetType: readTargetType(r),
    targetDeptIds: readIntArray(r.targetDeptIds ?? r.target_dept_ids ?? null),
    targetPositionIds: readIntArray(
      r.targetPositionIds ?? r.target_position_ids ?? null,
    ),
    targetUserIds: readIntArray(r.targetUserIds ?? r.target_user_ids ?? null),
    targetCompanyIds: readTargetCompanyIds(r),
    category: readCategory(r.category),
    requireAck: readRequireAck(r.requireAck ?? r.require_ack ?? null),
    scheduledAt: r.scheduledAt ?? r.scheduled_at ?? null,
    // System-notice tag ('scan' for background slip-scan results). Lets the
    // client suppress the read-receipt roster on private per-user notices.
    source: (r.source ?? null) as string | null,
  };
}

type PublicAnnouncement = ReturnType<typeof toPublic> & {
  createdByName?: string | null;
  targetDeptNames?: string[];
};

// Author and department NAMES for a batch of rows. Resolved here because a
// plain reader cannot load /api/users or /api/departments (both sit behind
// users.read), yet the redesigned inbox shows "Lee Wei · Operation" on every
// row and groups the SOP Library by department. Two small lookups per request,
// scoped to the ids actually present; a lookup that fails leaves the names
// absent rather than failing the list. Ids are validated integers, so the
// inline IN lists are safe (d1-compat prepared SQL, no `--` comments).
async function withNames(
  env: Env,
  rows: AnnouncementRow[],
): Promise<PublicAnnouncement[]> {
  const pub: PublicAnnouncement[] = rows.map(toPublic);
  const authorIds = new Set<number>();
  const deptIds = new Set<number>();
  for (const p of pub) {
    if (p.createdBy != null && Number.isInteger(p.createdBy)) authorIds.add(p.createdBy);
    for (const d of p.targetDeptIds) if (Number.isInteger(d)) deptIds.add(d);
  }
  const authorName = new Map<number, string>();
  const deptName = new Map<number, string>();
  try {
    if (authorIds.size > 0) {
      const res = await env.DB.prepare(
        `SELECT id, name, email FROM users WHERE id IN (${Array.from(authorIds).join(",")})`,
      ).all<{ id: number; name?: string | null; email?: string | null }>();
      for (const u of res.results) {
        authorName.set(u.id, (u.name ?? "").trim() || (u.email ?? "").trim());
      }
    }
    if (deptIds.size > 0) {
      const res = await env.DB.prepare(
        `SELECT id, name FROM departments WHERE id IN (${Array.from(deptIds).join(",")})`,
      ).all<{ id: number; name?: string | null }>();
      for (const d of res.results) deptName.set(d.id, (d.name ?? "").trim());
    }
  } catch (e) {
    console.error("[announcements] name lookup failed; serving rows unnamed:", (e as Error).message);
  }
  for (const p of pub) {
    if (p.createdBy != null && authorName.has(p.createdBy)) {
      p.createdByName = authorName.get(p.createdBy) ?? null;
    }
    if (p.targetDeptIds.length > 0) {
      p.targetDeptNames = p.targetDeptIds.map((id) => deptName.get(id) ?? `Dept #${id}`);
    }
  }
  return pub;
}

function genId(): string {
  return `ann-${crypto.randomUUID().slice(0, 12).replace(/-/g, "")}`;
}

// Fetch one announcement the caller is allowed to see under the company gate.
// A notice targeting only companies the caller does NOT belong to resolves to
// null (callers answer 404, indistinguishable from a nonexistent id). The gate
// is skipped (fail-open) when the caller's allow-list is unresolved.
async function getScopedAnnouncement(
  c: { env: Env; get: (k: string) => unknown },
  id: string,
): Promise<AnnouncementRow | null> {
  const row = await c.env.DB.prepare(
    `SELECT * FROM announcements WHERE id = ?`,
  )
    .bind(id)
    .first<AnnouncementRow>();
  if (!row) return null;
  const allowed = allowedCompanyIds(c as never);
  return companyCanSee(row, allowed) ? row : null;
}

/**
 * Company filter for a notice's read-receipt / reminder roster. A notice's
 * audience spans the companies it TARGETS (target_company_ids); a user belongs
 * to that audience when they have a `user_companies` (mig 0085) grant for any
 * targeted company — with the same FAIL-OPEN rule as companyContext: a user
 * with NO grant rows belongs to every company. When the notice targets ALL
 * companies (empty list) OR no valid ids are given, returns "" (no filter) so
 * the whole active roster counts. Ids come from OUR companies master and are
 * re-validated as positive integers, so inlining them (no binds) is safe.
 */
function rosterCompaniesSql(companyIds: number[], alias = "users"): string {
  const ids = (companyIds ?? [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return "";
  const inList = ids.join(",");
  return ` AND (NOT EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = ${alias}.id)
             OR EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = ${alias}.id AND uc.company_id IN (${inList})))`;
}

// The announcement's targeted company ids (JSON array), dual-keyed for the pg
// snake->camel fold. Empty = ALL companies.
function readTargetCompanyIds(r: AnnouncementRow): number[] {
  return readIntArray(r.targetCompanyIds ?? r.target_company_ids ?? null);
}

// Company gate: an announcement is visible to a reader whose granted companies
// are `allowed` IFF its target_company_ids is empty (= all companies) OR
// intersects `allowed`. Fail-open when the reader's allow-list is UNRESOLVED
// (single-company Houzs / D1 test mirror / cold-start) — matches the
// allowedCompaniesSql idiom so legacy single-company reads run unchanged.
// `allowed === []` is NOT that case: it means the reader is granted no active
// company, so a company-TARGETED notice must stay hidden (see the sentinel doc
// on allowedCompanyIds). A notice targeting ALL companies stays visible either
// way — that gate is the notice's audience, not the company boundary.
function companyCanSee(r: AnnouncementRow, allowed: number[] | undefined): boolean {
  const targets = readTargetCompanyIds(r);
  if (targets.length === 0) return true;
  if (allowed === undefined) return true;
  return targets.some((id) => allowed.includes(id));
}

// True when a user with (id, deptId, positionId) is in the announcement's
// audience. Used by the banner GET so we never surface a notice the user
// shouldn't see.
function userCanSee(
  r: AnnouncementRow,
  userId: number,
  userDeptId: number | null,
  userPositionId: number | null,
): boolean {
  const type = readTargetType(r);
  if (type === "ALL_USERS") return true;
  const deptIds = readIntArray(r.targetDeptIds ?? r.target_dept_ids ?? null);
  if (userDeptId != null && deptIds.includes(userDeptId)) return true;
  const positionIds = readIntArray(
    r.targetPositionIds ?? r.target_position_ids ?? null,
  );
  if (userPositionId != null && positionIds.includes(userPositionId)) return true;
  const userIds = readIntArray(r.targetUserIds ?? r.target_user_ids ?? null);
  if (userIds.includes(userId)) return true;
  return false;
}

// ============================================================
// Sales-Director post scope (owner 2026-07-15). A Sales Director is admitted to
// the announcements management surface ADDITIVELY (requirePermissionOrSalesDirector)
// even though their POSITION never carries the flat announcements.* permission —
// positions get NO permission-matrix backfill, so a Sales Director holds neither
// announcements.read nor announcements.write. That is exactly why the composer /
// audience picker rendered empty for them: the whole surface was gated purely on
// those flat verbs. Admittance mirrors the Team/departments/positions endpoints.
//
// Unlike a full announcer (`*` / announcements.write, unrestricted), a Sales
// Director may ONLY address (a) their OWN Sales department (whole) or (b) specific
// people WITHIN that department — never all-company, another department, a
// position, or a company target. This is enforced server-side (the FE is UX
// only). `restricted` is true ONLY for a caller admitted purely as a Sales
// Director; a `*`/announcements.write holder is never restricted.
type SdScope = { restricted: boolean; deptId: number | null };

function salesDirectorScope(c: { get: (k: string) => unknown }): SdScope {
  const user = c.get("user") as AuthUser | undefined;
  const granted = user?.permissions_set ?? user?.permissions ?? [];
  if (
    hasPermission(granted, "*") ||
    hasPermission(granted, "announcements.write")
  ) {
    return { restricted: false, deptId: null };
  }
  if (isSalesDirectorUser(user)) {
    return { restricted: true, deptId: user?.department_id ?? null };
  }
  return { restricted: false, deptId: null };
}

// Validate + normalise a restricted Sales Director's requested audience. Returns
// the (possibly defaulted) dept/user id lists to persist, or a plain-language
// error to answer 403 on. An empty selection defaults to the WHOLE own
// department (never ALL_USERS). Company / position targets are rejected.
async function enforceSalesDirectorScope(
  c: { env: Env; get: (k: string) => unknown },
  scope: SdScope,
  req: {
    deptIds: number[];
    positionIds: number[];
    userIds: number[];
    companyIds: number[];
  },
): Promise<
  | { ok: true; deptIds: number[]; userIds: number[] }
  | { ok: false; error: string }
> {
  const deptId = scope.deptId;
  if (deptId == null) {
    return {
      ok: false,
      error:
        "Your account has no department yet — ask an admin to add you to Sales before posting.",
    };
  }
  if (req.positionIds.length > 0) {
    return {
      ok: false,
      error:
        "A Sales Director can only post to the Sales department or specific salespeople, not to positions.",
    };
  }
  if (req.companyIds.length > 0) {
    return {
      ok: false,
      error: "A Sales Director cannot choose a company target.",
    };
  }
  if (req.deptIds.some((id) => id !== deptId)) {
    return {
      ok: false,
      error: "A Sales Director can only post to their own Sales department.",
    };
  }
  if (req.userIds.length > 0) {
    const ph = req.userIds.map(() => "?").join(",");
    const rows = await c.env.DB.prepare(
      `SELECT id FROM users
         WHERE id IN (${ph})
           AND (department_id = ?
                OR EXISTS (SELECT 1 FROM user_departments ud
                            WHERE ud.user_id = users.id AND ud.department_id = ?))`,
    )
      .bind(...req.userIds, deptId, deptId)
      .all<{ id: number }>();
    const okIds = new Set((rows.results ?? []).map((r) => r.id));
    const bad = req.userIds.filter((id) => !okIds.has(id));
    if (bad.length > 0) {
      return {
        ok: false,
        error:
          "A Sales Director can only target salespeople in their own department.",
      };
    }
  }
  let deptIds = req.deptIds;
  if (deptIds.length === 0 && req.userIds.length === 0) {
    deptIds = [deptId];
  }
  return { ok: true, deptIds, userIds: req.userIds };
}

// True when a restricted Sales Director is acting on a notice they did NOT
// author. Ownership-gates edit / delete / remind / receipts so a Sales Director
// can only manage their OWN posts (a full announcer is never restricted).
function sdBlockedFromRow(scope: SdScope, row: AnnouncementRow, userId: number | null): boolean {
  if (!scope.restricted) return false;
  const author = row.createdBy ?? row.created_by ?? null;
  return author == null || author !== userId;
}

// ============================================================
// LIST — newest first. Open to every authed user; NO permission gate.
//   · Managers (`*` wildcard or announcements.write, i.e. composers) get the
//     FULL admin list: every active + inactive + expired row.
//   · Everyone else gets ONLY live announcements addressed to THEM (owner
//     rule 2026-07: audience-targeted content — same active + not-expired +
//     audience filter as /banner). Server-side; the composer's targeting
//     can't be bypassed by a read-only caller.
//
// WHY NO announcements.read GATE (owner restated 2026-07-21). That verb is the
// ADMIN list/composer permission — no ordinary salesperson holds it, positions
// get no matrix backfill. Gating this endpoint on it meant the notice pop-up's
// "Read SOP" / "View details" button (which rides /banner, ungated) sent every
// non-admin to a 403. The mobile shell already treats announcements as readable
// by EVERY active user (MobileApp's row carries alwaysShow and reads /banner);
// this closes the desktop half of that divergence. What protects the data is
// NOT the door but the AUDIENCE FILTER below — which is exactly the same one
// /banner has always run for the same ungated cohort, so nothing becomes
// visible here that /banner did not already show that caller. WRITE stays on
// announcements.write: create / edit / remind / delete / read-receipts are
// untouched.
// ============================================================
app.get("/", async (c) => {
  // Authentication is still mandatory — the /api/* auth wall (index.ts) is what
  // supplies `user`, and every filter below is keyed on their id / dept /
  // position. Mirror /banner's explicit check rather than trusting the wall:
  // a missing user must 401, never fall through to an unscoped list.
  const user = c.get("user");
  if (!user || !user.id) {
    return c.json({ success: false, error: "Your session has expired. Please sign in again." }, 401);
  }
  // System per-user notices (source='scan' slip-scan results, source=
  // 'service_case' service-case assignments) are delivered only through the
  // notification bell (/banner?scope=system, on both shells) — they must NOT
  // clutter this office composer list. Human-authored posts have source NULL,
  // so filter to those.
  const res = await c.env.DB
    .prepare(
      `SELECT * FROM announcements WHERE source IS NULL ORDER BY created_at DESC`,
    )
    .all<AnnouncementRow>();
  const allowed = allowedCompanyIds(c);
  const granted = user.permissions_set ?? user.permissions ?? [];
  const isManager =
    hasPermission(granted, "*") || hasPermission(granted, "announcements.write");
  const sd = salesDirectorScope(c);
  // Company gate first (applies to managers AND readers): a notice is listed
  // only for a caller who belongs to a targeted company (or it targets all).
  const visible = (res.results ?? []).filter((r) => companyCanSee(r, allowed));
  const rows = isManager
    ? visible
    : visible.filter((r) => {
        // A Sales Director sees + manages their OWN posts here regardless of
        // active/expiry (so the desktop page isn't empty for them), plus their
        // normal audience feed. Full managers already saw everything above.
        if (sd.restricted && (r.createdBy ?? r.created_by ?? null) === user.id) {
          return true;
        }
        return (
          deliverableNow(r) &&
          userCanSee(
            r,
            user.id,
            user.department_id ?? null,
            user.position_id ?? null,
          )
        );
      });
  return c.json({ success: true, data: await withNames(c.env, rows) });
});

// ============================================================
// BANNER (every authed user) — newest ACTIVE + not-expired + audience-matching
// rows + this user's acked ids (for the popup gate). Default = the POP-UP
// slice (human posts only); ?scope=system = the BELL slice (machine notices).
// No permission gate: anyone who passes the /api/* auth wall can see their
// own banner.
// ============================================================
app.get("/banner", async (c) => {
  const user = c.get("user");
  if (!user || !user.id) {
    return c.json({ success: false, error: "Your session has expired. Please sign in again." }, 401);
  }

  // This endpoint serves exactly TWO slices (owner 2026-08-08, "为什么一直有
  // 这个"): the POP-UP slice — human-authored posts only (source IS NULL) —
  // and, under scope=system, the notification-BELL slice (source NOT NULL —
  // the machine-generated scan / service-case per-user notices).
  //
  // The old unscoped FULL feed is gone on purpose. Its only consumer was the
  // desktop pop-up, which is exactly where machine notices were badgering:
  // every "New service case ASSR/…" popped a modal card, and under the
  // two-skips-then-mandatory-ack rule (#1728) that modal eventually refuses to
  // leave. A machine notice has no author waiting on an acknowledgement — it
  // belongs in the bell, so the pop-up slice excludes source NOT NULL rows.
  // Absent/unknown scope falls back to the human slice (NOT to "everything"),
  // which is also what silences the HISTORICAL machine rows the moment this
  // deploys: the split is applied on read, and a stale cached bundle still
  // requesting the unscoped feed gets the human slice too.
  const scope = (c.req.query("scope") ?? "").toLowerCase();
  const systemOnly = scope === "system";
  // The payload depends only on this boolean: default and scope=human are the
  // identical human slice, so BOTH key as "human" (one entry, shared). Keyed
  // separately from "system" so the two payloads can never answer each other.
  const bannerScope: BannerScope = systemOnly ? "system" : "human";

  // PER-USER + PER-SCOPE KV snapshot (inbox.ts pattern) — this payload is
  // per-user three times over (own ackedIds, dept/position/user-id targeting,
  // the reader's company grants) AND per-scope (human vs system filter), so it
  // must NEVER enter a shared cache; the key's scope dimensions are the USER id
  // and the slice. The family version orphans every user's entry on any
  // broadcast-shaped mutation (create/edit/delete/remind below); per-user
  // changes (own ack, a private notice) bust BOTH of that user's slices.
  // TTL is CONFIG_CACHE_TTL_SECONDS.banner (300s / 5 min); the desktop + mobile
  // pollers run at 3 min (as of 2026-08-20), so a poll lands mostly on a cache
  // hit and only re-pays the DB round trip once per ~5 min. A reader may serve up
  // to TTL-stale, the trade the human slice already makes. Best-effort: any KV
  // trouble serves the live build.
  const bannerVersion = await configCacheVersion(c.env, "banner");
  // Both slices now take the cached path (the key carries the slice). The only
  // bypass is a best-effort one: an UNUSABLE cache version (KV unbound /
  // erroring) reads null, and a guessed version could serve an orphaned entry.
  const cacheKey =
    bannerVersion == null
      ? null
      : bannerCacheKey(bannerVersion, user.id, bannerScope);
  if (cacheKey) {
    try {
      const cached = await c.env.SESSION_CACHE?.get(cacheKey);
      if (cached) {
        c.header("x-config-cache", "hit");
        return c.json(JSON.parse(cached));
      }
    } catch {
      /* fall through to the live build */
    }
  }

  const allowed = allowedCompanyIds(c);
  // The two reads are independent — the feed does not depend on the acks, and
  // the acks are keyed on user id alone — so a MISS pays ONE round-trip, not
  // two sequential ~450ms awaits (~900ms). Behaviour-identical: an error in
  // either still rejects the handler, exactly as the sequential awaits did.
  // This user's ack rows (id + when they acked): the popup gate re-pops a
  // notice the user has NOT acked, OR has acked but was reminded AFTER that
  // ack. Read dual-keyed (pg folds snake -> camel on read).
  // company-scope: the acks read is keyed on the caller's user_id alone (a
  // user's own receipts, no company dimension), and the notices it is joined
  // against in JS pass companyCanSee(allowed) at the filter below — a receipt
  // for a notice the caller's companies cannot see never reaches the payload.
  const [res, ackRes] = await Promise.all([
    c.env.DB
      // WHERE is_active = 1 pushes the active filter to SQL so this uses the
      // (is_active, created_at DESC) index (mig 0058) as a range scan instead of
      // reading the WHOLE table on every ~60s cache miss (polled from every page,
      // measured ~900ms on prod 2026-08-20). Behaviour-identical: the JS
      // isActiveFlag filter below already drops exactly the is_active<>1 rows the
      // integer column can hold, so no row that used to be served is lost.
      .prepare(`SELECT * FROM announcements WHERE is_active = 1 ORDER BY created_at DESC`)
      .all<AnnouncementRow>(),
    c.env.DB
      // company-scope: keyed on the caller's own user_id; the notice side is gated by companyCanSee below.
      .prepare(
        "SELECT announcement_id, acked_at FROM announcement_acks WHERE user_id = ?",
      )
      .bind(user.id)
      .all<{
        announcement_id?: string;
        announcementId?: string;
        acked_at?: string | null;
        ackedAt?: string | null;
      }>(),
  ]);
  const active = (res.results ?? []).filter(
    (r) =>
      (systemOnly ? !!r.source : !r.source) &&
      deliverableNow(r) &&
      companyCanSee(r, allowed) &&
      userCanSee(
        r,
        user.id,
        user.department_id ?? null,
        user.position_id ?? null,
      ),
  );

  const ackedAtById = new Map<string, string | null>();
  for (const a of ackRes.results ?? []) {
    const id = a.announcementId ?? a.announcement_id;
    if (id) ackedAtById.set(id, a.ackedAt ?? a.acked_at ?? null);
  }
  const ackedIds: string[] = [];
  for (const r of active) {
    if (!ackedAtById.has(r.id)) continue;
    const ackedAt = ackedAtById.get(r.id) ?? null;
    const remindedAt = r.remindedAt ?? r.reminded_at ?? null;
    if (isRemindedSince(remindedAt, ackedAt)) continue;
    ackedIds.push(r.id);
  }

  const payload = {
    success: true,
    data: await withNames(c.env, active),
    ackedIds,
  };
  if (cacheKey) {
    // Not awaited — the response does not depend on the write landing, and the
    // banner is polled from every page, so a KV round trip on each miss was
    // charged to a request that is already on the slow path. Measured on prod
    // 2026-08-01: announcements/banner was the slowest call on several routes,
    // peaking at 527ms. Same waitUntil-with-floating-fallback shape as
    // routes/inbox.ts and /auth/me.
    const fill = (async () => {
      try {
        await c.env.SESSION_CACHE?.put(cacheKey, JSON.stringify(payload), {
          expirationTtl: CONFIG_CACHE_TTL_SECONDS.banner,
        });
      } catch {
        /* non-fatal */
      }
    })();
    try {
      c.executionCtx.waitUntil(fill);
    } catch {
      void fill;
    }
  }
  c.header("x-config-cache", cacheKey ? "miss" : "bypass");
  return c.json(payload);
});

// ============================================================
// GET /:id/acks — read-receipt for one notice. Roster = the notice's ACTUAL
// audience (not the whole company), split into who has acked and who hasn't, so
// a private USER_IDS notice reads "Read 1 / 1", not "1 / 48".
// Gated on announcements.WRITE — only publishers/admins see who read a notice
// (owner: a normal user must not see the read-receipts). The frontend already
// only renders this for write-holders; this is the server-side backstop.
// ============================================================
// ── Roster + ack helpers shared by the receipts, summary, team and escalation
// reads below. One SELECT shape, one definition of "in the audience", one
// definition of a pending person's state, so the drawer, the manage table,
// the dashboard card and the supervisor notice can never disagree.

type RosterUser = {
  id: number;
  email: string;
  name: string;
  departmentId: number | null;
  departmentName: string | null;
  positionId: number | null;
  positionName: string | null;
  managerId: number | null;
};

// Every ACTIVE user with their org-chart fields. `companyIds` narrows to the
// notice's targeted companies via the same fail-open grant rule as before
// (rosterCompaniesSql); [] = the whole roster. Reads dual-keyed because the pg
// driver folds snake_case → camelCase on read.
async function loadRoster(env: Env, companyIds: number[]): Promise<RosterUser[]> {
  const res = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.department_id, u.position_id, u.manager_id,
            d.name AS department_name, p.name AS position_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN positions p ON p.id = u.position_id
      WHERE u.status = 'active'${rosterCompaniesSql(companyIds, "u")}
      ORDER BY u.name ASC`,
  ).all<{
    id: number;
    email?: string | null;
    name?: string | null;
    department_id?: number | null;
    departmentId?: number | null;
    position_id?: number | null;
    positionId?: number | null;
    manager_id?: number | null;
    managerId?: number | null;
    department_name?: string | null;
    departmentName?: string | null;
    position_name?: string | null;
    positionName?: string | null;
  }>();
  return (res.results).map((u) => ({
    id: u.id,
    email: u.email ?? "",
    name: u.name ?? "",
    departmentId: u.departmentId ?? u.department_id ?? null,
    departmentName: u.departmentName ?? u.department_name ?? null,
    positionId: u.positionId ?? u.position_id ?? null,
    positionName: u.positionName ?? u.position_name ?? null,
    managerId: u.managerId ?? u.manager_id ?? null,
  }));
}

function audienceOf(ann: AnnouncementRow, roster: RosterUser[]): RosterUser[] {
  return roster.filter((u) => userCanSee(ann, u.id, u.departmentId, u.positionId));
}

// acked_at per user for ONE notice (or, with no id, every notice → keyed by
// notice id first).
async function loadAckMap(env: Env, id: string): Promise<Map<number, string | null>> {
  // company-scope: receipts for ONE notice the caller already passed getScopedAnnouncement (companyCanSee) for; acks carry no company dimension of their own.
  const res = await env.DB.prepare(
    "SELECT user_id, acked_at FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
    .all<{ user_id?: number; userId?: number; acked_at?: string | null; ackedAt?: string | null }>();
  const out = new Map<number, string | null>();
  for (const a of res.results) {
    const uid = a.userId ?? a.user_id;
    if (uid != null) out.set(uid, a.ackedAt ?? a.acked_at ?? null);
  }
  return out;
}

async function loadAllAcks(env: Env): Promise<Map<string, Set<number>>> {
  // company-scope: a lookup map consulted only for notices the caller has already filtered through companyCanSee / inTargetCompanies; never returned raw.
  const res = await env.DB.prepare(
    "SELECT announcement_id, user_id FROM announcement_acks",
  ).all<{ announcement_id?: string; announcementId?: string; user_id?: number; userId?: number }>();
  const out = new Map<string, Set<number>>();
  for (const a of res.results) {
    const id = a.announcementId ?? a.announcement_id;
    const uid = a.userId ?? a.user_id;
    if (!id || uid == null) continue;
    let set = out.get(id);
    if (!set) {
      set = new Set<number>();
      out.set(id, set);
    }
    set.add(uid);
  }
  return out;
}

// The user_companies grants, for narrowing a roster to a notice's targeted
// companies in JS (the summary walks every notice against one roster, so the
// per-notice SQL filter does not fit). Same fail-open rule as
// rosterCompaniesSql: a user with NO grant row belongs to every company. A
// missing table (D1 test mirror, pre-0085) means no grants → everyone belongs.
async function loadCompanyGrants(env: Env): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  try {
    const res = await env.DB.prepare(
      "SELECT user_id, company_id FROM user_companies",
    ).all<{ user_id?: number; userId?: number; company_id?: number; companyId?: number }>();
    for (const g of res.results) {
      const uid = g.userId ?? g.user_id;
      const cid = g.companyId ?? g.company_id;
      if (uid == null || cid == null) continue;
      let set = out.get(uid);
      if (!set) {
        set = new Set<number>();
        out.set(uid, set);
      }
      set.add(cid);
    }
  } catch {
    /* no grants table → fail-open, everyone belongs to every company */
  }
  return out;
}

function inTargetCompanies(
  grants: Map<number, Set<number>>,
  userId: number,
  targets: number[],
): boolean {
  if (targets.length === 0) return true;
  const mine = grants.get(userId);
  if (!mine || mine.size === 0) return true;
  return targets.some((id) => mine.has(id));
}

// A pending person's state (design handoff 2026-09-04, drawer + dashboard):
// reminded = the office has reminded since the post; overdue = still unacked
// past the window; otherwise plainly pending. Confirmed is the acked side.
const ACK_OVERDUE_HOURS = 48;
type PendingState = "pending" | "reminded" | "overdue";
function pendingState(ann: AnnouncementRow, now = Date.now()): PendingState {
  const remindedAt = ann.remindedAt ?? ann.reminded_at ?? null;
  if (remindedAt && !Number.isNaN(Date.parse(remindedAt))) return "reminded";
  const createdAt = ann.createdAt ?? ann.created_at ?? null;
  const t = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isNaN(t) && now - t > ACK_OVERDUE_HOURS * 3_600_000) return "overdue";
  return "pending";
}

// Does the notice demand an acknowledgement? The stored flag, else the
// category rule — the same fallback the client applies.
function announcementRequiresAck(r: AnnouncementRow): boolean {
  return readRequireAck(r.requireAck ?? r.require_ack ?? null) ?? categoryRequiresAck(readCategory(r.category));
}

app.get("/:id/acks", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const ann = await getScopedAnnouncement(c, id);
  if (!ann) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  // A Sales Director may only see read-receipts for notices they authored.
  if (sdBlockedFromRow(salesDirectorScope(c), ann, c.get("user")?.id ?? null)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }

  // Only the active users this notice actually targets (userCanSee respects
  // ALL_USERS / DEPARTMENT_IDS / POSITION_IDS / USER_IDS / MIXED), narrowed to
  // the notice's TARGETED companies (user_companies grants, fail-open — see
  // helper). A notice targeting all companies counts the whole roster.
  const roster = audienceOf(ann, await loadRoster(c.env, readTargetCompanyIds(ann)));
  const ackedAtByUser = await loadAckMap(c.env, id);
  const state = pendingState(ann);

  type Person = {
    id: number;
    name: string;
    email: string;
    departmentId: number | null;
    departmentName: string | null;
    positionName: string | null;
    managerId: number | null;
  };
  const person = (u: RosterUser): Person => ({
    id: u.id,
    name: u.name,
    email: u.email,
    departmentId: u.departmentId,
    departmentName: u.departmentName,
    positionName: u.positionName,
    managerId: u.managerId,
  });
  const acked: Array<Person & { ackedAt: string | null }> = [];
  const pending: Array<Person & { state: PendingState }> = [];
  // Two-level drill-down (notice → department → person): one bucket per
  // department in the audience, in roster (name) order of first appearance.
  const byDepartment = new Map<
    string,
    { id: number | null; name: string; total: number; acked: number; pending: number }
  >();
  for (const u of roster) {
    const key = u.departmentId == null ? "none" : String(u.departmentId);
    let d = byDepartment.get(key);
    if (!d) {
      d = {
        id: u.departmentId,
        name: u.departmentName ?? (u.departmentId == null ? "No department" : `Dept #${u.departmentId}`),
        total: 0,
        acked: 0,
        pending: 0,
      };
      byDepartment.set(key, d);
    }
    d.total += 1;
    if (ackedAtByUser.has(u.id)) {
      d.acked += 1;
      acked.push({ ...person(u), ackedAt: ackedAtByUser.get(u.id) ?? null });
    } else {
      d.pending += 1;
      pending.push({ ...person(u), state });
    }
  }
  acked.sort((x, y) => {
    const tx = x.ackedAt ? Date.parse(x.ackedAt) : 0;
    const ty = y.ackedAt ? Date.parse(y.ackedAt) : 0;
    return (Number.isNaN(ty) ? 0 : ty) - (Number.isNaN(tx) ? 0 : tx);
  });

  return c.json({
    success: true,
    data: {
      total: roster.length,
      ackedCount: acked.length,
      acked,
      pending,
      byDepartment: Array.from(byDepartment.values()).sort((a, b) => a.name.localeCompare(b.name)),
      remindedAt: ann.remindedAt ?? ann.reminded_at ?? null,
      overdueAfterHours: ACK_OVERDUE_HOURS,
    },
  });
});

// ============================================================
// GET /ack-summary — { [id]: { total, acked } } for every human post the
// caller may manage, in ONE round trip. Feeds the Manage table's ack-rate
// column and stat strip (design handoff 2026-09-04); walking /:id/acks per row
// would be N requests. Same gate + Sales-Director ownership rule as the
// receipts. Company narrowing is done in JS against the grants map because
// each notice has its own target set.
// ============================================================
app.get("/ack-summary", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ success: false, error: "Your session has expired. Please sign in again." }, 401);
  }
  const sd = salesDirectorScope(c);
  const allowed = allowedCompanyIds(c);
  // company-scope: announcements carry their audience as target_company_ids
  // (NULL = every company), not a per-row company predicate — the same
  // in-JS companyCanSee(allowed) gate GET / applies runs on the very next
  // line, so a notice targeting only companies the caller lacks is dropped
  // before its counts are computed.
  const res = await c.env.DB
    .prepare(`SELECT * FROM announcements WHERE source IS NULL ORDER BY created_at DESC`)
    .all<AnnouncementRow>();
  const rows = (res.results).filter(
    (r) => companyCanSee(r, allowed) && !sdBlockedFromRow(sd, r, user.id),
  );
  const [roster, acks, grants] = await Promise.all([
    loadRoster(c.env, []),
    loadAllAcks(c.env),
    loadCompanyGrants(c.env),
  ]);
  const data: Record<string, { total: number; acked: number }> = {};
  for (const r of rows) {
    const targets = readTargetCompanyIds(r);
    const audience = audienceOf(r, roster).filter((u) => inTargetCompanies(grants, u.id, targets));
    const ackedSet = acks.get(r.id);
    let acked = 0;
    for (const u of audience) if (ackedSet?.has(u.id)) acked += 1;
    data[r.id] = { total: audience.length, acked };
  }
  return c.json({ success: true, data });
});

// ============================================================
// GET /team-pending — the supervisor's gap (design handoff 2026-09-04, the
// dashboard "My team's pending" card). Every authed user may call it; the
// answer is scoped to THEIR direct reports (users.manager_id = caller) and
// lists each mandatory human notice a report has not acknowledged, with the
// same pending state the drawer shows. No reports → an empty answer, and the
// card does not render. Reminders stay manual; the automatic escalation job
// is a separate follow-up.
// ============================================================
app.get("/team-pending", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ success: false, error: "Your session has expired. Please sign in again." }, 401);
  }
  const roster = await loadRoster(c.env, []);
  const reports = roster.filter((u) => u.managerId === user.id);
  if (reports.length === 0) {
    return c.json({ success: true, data: { reports: 0, pending: [] } });
  }
  // company-scope: the audience is the REPORT's, not the caller's — each
  // report is matched against a notice's target_company_ids through their own
  // user_companies grants (inTargetCompanies, fail-open like rosterCompaniesSql)
  // in the loop below, so a report never appears against a notice their
  // companies cannot see; the notice rows themselves have no company column.
  const [res, acks, grants] = await Promise.all([
    c.env.DB
      // company-scope: audience is per REPORT via target_company_ids + inTargetCompanies below; rows carry no company column.
      .prepare(`SELECT * FROM announcements WHERE is_active = 1 AND source IS NULL ORDER BY created_at DESC`)
      .all<AnnouncementRow>(),
    loadAllAcks(c.env),
    loadCompanyGrants(c.env),
  ]);
  const now = Date.now();
  const notices = (res.results).filter(
    (r) => deliverableNow(r, now) && announcementRequiresAck(r),
  );
  const pending: Array<{
    userId: number;
    name: string;
    positionName: string | null;
    announcementId: string;
    title: string;
    category: AnnouncementCategory;
    createdAt: string | null;
    state: PendingState;
  }> = [];
  for (const r of notices) {
    const targets = readTargetCompanyIds(r);
    const ackedSet = acks.get(r.id);
    const state = pendingState(r, now);
    for (const u of reports) {
      if (!userCanSee(r, u.id, u.departmentId, u.positionId)) continue;
      if (!inTargetCompanies(grants, u.id, targets)) continue;
      if (ackedSet?.has(u.id)) continue;
      pending.push({
        userId: u.id,
        name: u.name || u.email,
        positionName: u.positionName,
        announcementId: r.id,
        title: r.title,
        category: readCategory(r.category),
        createdAt: r.createdAt ?? r.created_at ?? null,
        state,
      });
    }
  }
  return c.json({
    success: true,
    data: { reports: reports.length, pending, overdueAfterHours: ACK_OVERDUE_HOURS },
  });
});

// ============================================================
// POST /:id/escalate — "Notify their supervisors" (design handoff 2026-09-04,
// the drawer's second action). For every person still pending on the notice
// (optionally one department: body.departmentId) with a manager on the org
// chart, the manager gets ONE system notice naming their pending reports. It
// rides the bell (source NOT NULL never pops a modal), and postPersonalNotice's
// dedupe swallows a repeat while the first is still unread. Manual, on the
// poster's click — the automatic overdue job is a separate follow-up.
// ============================================================
app.post("/:id/escalate", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const ann = await getScopedAnnouncement(c, id);
  if (!ann) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  if (sdBlockedFromRow(salesDirectorScope(c), ann, c.get("user").id)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  const body = (await c.req.json().catch(() => ({}))) as { departmentId?: unknown };
  const deptFilter =
    body.departmentId == null ? null : parseInt(String(body.departmentId), 10);

  const roster = audienceOf(ann, await loadRoster(c.env, readTargetCompanyIds(ann)));
  const ackedAtByUser = await loadAckMap(c.env, id);
  const pending = roster.filter(
    (u) =>
      !ackedAtByUser.has(u.id) &&
      (deptFilter == null || !Number.isFinite(deptFilter) || u.departmentId === deptFilter),
  );
  const byManager = new Map<number, RosterUser[]>();
  for (const u of pending) {
    if (u.managerId == null) continue;
    const list = byManager.get(u.managerId);
    if (list) list.push(u);
    else byManager.set(u.managerId, [u]);
  }
  for (const [managerId, people] of byManager) {
    const names = people.map((p) => p.name || p.email);
    await postPersonalNotice(c.env, {
      userIds: [managerId],
      category: "GENERAL",
      title: `${names.length} of your team ${names.length === 1 ? "has" : "have"} not acknowledged "${ann.title}"`,
      body: `Still pending: ${names.join(", ")}. Please follow up — the notice requires acknowledgement.`,
      source: "ack_escalation",
    });
  }
  // The managers' bell slices just changed.
  if (byManager.size > 0) await bumpConfigVersion(c.env, "banner");
  return c.json({
    success: true,
    supervisors: byManager.size,
    people: pending.filter((u) => u.managerId != null).length,
    unsupervised: pending.filter((u) => u.managerId == null).length,
  });
});

// ============================================================
// POST / — create. Body validated server-side.
// ============================================================
app.post("/", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const user = c.get("user");
  const body = (await c.req
    .json()
    .catch(() => ({}))) as Record<string, unknown>;

  const title = String(body.title ?? "").trim();
  if (!title) {
    return c.json({ success: false, error: "Title is required" }, 400);
  }
  if (title.length > 200) {
    return c.json({ success: false, error: "Title too long (200 max)" }, 400);
  }
  // Rich body wins when present: `body` is then DERIVED from it server-side
  // (never trusted from the client) so the two columns can never disagree. A
  // client that sends only `body` — the phone, a script, an old build — takes
  // the plain path exactly as before.
  const attachments = normalizeAttachments(body.attachments);
  const rawHtml = body.bodyHtml ?? body.body_html;
  const rich = readBodyHtml(rawHtml, attachments.map((a) => a.r2Key));
  if (rich.error) return c.json({ success: false, error: rich.error }, 400);
  const bodyHtml = rich.html;
  // Any html at all (even one that folded to plain and stores NULL) is the
  // source of truth for the plain text; `body` is read only when no html came.
  const text =
    typeof rawHtml === "string" && rawHtml.trim()
      ? richTextToPlain(rich.canonical)
      : String(body.body ?? "").trim();

  let expiresAt: string | null = null;
  if (body.expiresAt != null && String(body.expiresAt).trim() !== "") {
    const t = Date.parse(String(body.expiresAt));
    if (Number.isNaN(t)) {
      return c.json({ success: false, error: "Invalid expiry date" }, 400);
    }
    expiresAt = new Date(t).toISOString();
  }

  const mediaLayout = readMediaLayout(body.mediaLayout);
  const reqDeptIds = readIntArray(
    body.targetDeptIds as string | number[] | null | undefined,
  );
  const reqPositionIds = readIntArray(
    body.targetPositionIds as string | number[] | null | undefined,
  );
  const reqUserIds = readIntArray(
    body.targetUserIds as string | number[] | null | undefined,
  );
  // Company-target dimension. Empty (author picked "Both"/all, or single-company
  // Houzs) stores NULL = visible to every company.
  const reqCompanyIds = readIntArray(
    (body.targetCompanyIds ?? body.target_company_ids) as
      | string
      | number[]
      | null
      | undefined,
  );

  // Enforce the Sales-Director audience scope (own Sales department, or specific
  // salespeople in it). A full announcer (`*` / announcements.write) is never
  // restricted. This is the AUTHORITY — the FE composer only mirrors it.
  const sd = salesDirectorScope(c);
  let effDeptIds = reqDeptIds;
  let effPositionIds = reqPositionIds;
  let effUserIds = reqUserIds;
  let effCompanyIds = reqCompanyIds;
  if (sd.restricted) {
    const enforced = await enforceSalesDirectorScope(c, sd, {
      deptIds: reqDeptIds,
      positionIds: reqPositionIds,
      userIds: reqUserIds,
      companyIds: reqCompanyIds,
    });
    if (!enforced.ok) {
      return c.json({ success: false, error: enforced.error }, 403);
    }
    effDeptIds = enforced.deptIds;
    effPositionIds = [];
    effUserIds = enforced.userIds;
    effCompanyIds = [];
  }

  const targetType = deriveTargetType(effDeptIds, effPositionIds, effUserIds);
  const category = readCategory(body.category);
  // "Require acknowledgement" (mig 20260905T1125): an explicit boolean wins;
  // otherwise the category default — WARNING / SOP on, GENERAL / LEARNING off.
  const requireAck =
    typeof body.requireAck === "boolean" ? body.requireAck : categoryRequiresAck(category);
  // Scheduled posting: a future instant holds the notice back from every
  // reader until then. A past / absent value posts at once (stored NULL).
  let scheduledAt: string | null = null;
  if (body.scheduledAt != null && String(body.scheduledAt).trim() !== "") {
    const t = Date.parse(String(body.scheduledAt));
    if (Number.isNaN(t)) {
      return c.json({ success: false, error: "Invalid schedule date" }, 400);
    }
    if (t > Date.now()) scheduledAt = new Date(t).toISOString();
  }

  const id = genId();
  const nowIso = new Date().toISOString();
  // Multi-company: stamp the composing company. Column + bind appended ONLY
  // when the company context is resolved (sales.ts idiom) so the pre-migration
  // window / D1 test mirror inserts unchanged; the PG DEFAULT covers the rest.
  const companyId = activeCompanyId(c);
  const stampCo = companyId != null;
  // Best-effort translate. apiKey missing -> returns null and we store null;
  // FE falls back to original text. Awaiting is fine (rare + short).
  const translations = await translateAnnouncement({
    title,
    body: text,
    bodyHtml,
    apiKey: c.env.ANTHROPIC_API_KEY,
  });

  await c.env.DB.prepare(
    `INSERT INTO announcements
       (id, title, body, body_html, is_active, expires_at, created_by, created_at,
        translations, attachments, media_layout, target_type,
        target_dept_ids, target_position_ids, target_user_ids,
        target_company_ids, category, require_ack, scheduled_at${stampCo ? ", company_id" : ""})
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`,
  )
    .bind(
      id,
      title,
      text,
      bodyHtml,
      expiresAt,
      user?.id ?? null,
      nowIso,
      translations ? JSON.stringify(translations) : null,
      attachments.length ? JSON.stringify(attachments) : null,
      mediaLayout ? JSON.stringify(mediaLayout) : null,
      targetType,
      effDeptIds.length ? JSON.stringify(effDeptIds) : null,
      effPositionIds.length ? JSON.stringify(effPositionIds) : null,
      effUserIds.length ? JSON.stringify(effUserIds) : null,
      effCompanyIds.length ? JSON.stringify(effCompanyIds) : null,
      category,
      requireAck ? 1 : 0,
      scheduledAt,
      ...(stampCo ? [companyId] : []),
    )
    .run();

  const row = await c.env.DB.prepare(
    "SELECT * FROM announcements WHERE id = ?",
  )
    .bind(id)
    .first<AnnouncementRow>();

  // A new notice changes every targeted reader's banner — orphan ALL cached
  // banner snapshots via the family version.
  await bumpConfigVersion(c.env, "banner");

  // TODO: web push fan-out (no infra in Houzs yet). BrowserPushSink already
  // fires native browser Notifications from the polled activity feed; wiring
  // announcements into a similar polled trigger is the natural next step.

  return c.json({ success: true, data: row ? toPublic(row) : null }, 201);
});

// ============================================================
// PATCH /:id — edit fields, toggle isActive, retarget, re-translate.
// ============================================================
app.patch("/:id", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const existing = await getScopedAnnouncement(c, id);
  if (!existing) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  // A Sales Director may only edit notices they authored.
  const sd = salesDirectorScope(c);
  if (sdBlockedFromRow(sd, existing, c.get("user")?.id ?? null)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  const body = (await c.req
    .json()
    .catch(() => ({}))) as Record<string, unknown>;

  const sets: string[] = [];
  const binds: unknown[] = [];
  let textChanged = false;
  let nextTitle = existing.title;
  let nextText = existing.body ?? "";
  let nextHtml: string | null = existing.bodyHtml ?? existing.body_html ?? null;

  if ("isActive" in body) {
    sets.push("is_active = ?");
    binds.push(body.isActive ? 1 : 0);
  }
  if (typeof body.title === "string") {
    const title = String(body.title).trim();
    if (!title) {
      return c.json({ success: false, error: "Title is required" }, 400);
    }
    if (title.length > 200) {
      return c.json({ success: false, error: "Title too long (200 max)" }, 400);
    }
    sets.push("title = ?");
    binds.push(title);
    nextTitle = title;
    textChanged = true;
  }
  // Whoever edits last defines the format: a `bodyHtml` edit rewrites both
  // columns (plain derived from rich); a plain `body` edit clears body_html so
  // a phone editing a formatted notice cannot leave stale formatting behind.
  const nextAttachments =
    "attachments" in body
      ? normalizeAttachments(body.attachments)
      : normalizeAttachments(existing.attachments ?? null);
  const nextKeys = nextAttachments.map((a) => a.r2Key);
  if ("bodyHtml" in body || "body_html" in body) {
    const rawHtml = body.bodyHtml ?? body.body_html;
    const rich = readBodyHtml(rawHtml, nextKeys);
    if (rich.error) return c.json({ success: false, error: rich.error }, 400);
    const text =
      typeof rawHtml === "string" && rawHtml.trim()
        ? richTextToPlain(rich.canonical)
        : typeof body.body === "string"
          ? String(body.body).trim()
          : "";
    sets.push("body_html = ?", "body = ?");
    binds.push(rich.html, text);
    nextHtml = rich.html;
    nextText = text;
    textChanged = true;
  } else if (typeof body.body === "string") {
    const text = String(body.body).trim();
    sets.push("body = ?", "body_html = ?");
    binds.push(text, null);
    nextHtml = null;
    nextText = text;
    textChanged = true;
  }
  if ("attachments" in body) {
    sets.push("attachments = ?");
    binds.push(nextAttachments.length ? JSON.stringify(nextAttachments) : null);
    // An attachment removed while the text still shows it inline: drop the
    // inline use too, and re-derive the plain shadow, so the stored body never
    // names a key the serve route would refuse.
    if (!textChanged && nextHtml) {
      const stripped = stripUnreferencedImages(nextHtml, nextKeys);
      if (stripped !== nextHtml) {
        nextHtml = hasRichFormatting(stripped) ? stripped : null;
        nextText = richTextToPlain(stripped);
        sets.push("body_html = ?", "body = ?");
        binds.push(nextHtml, nextText);
        textChanged = true;
      }
    }
  }
  // Media layout retarget. Present + empty/unrecognised clears to NULL (fall
  // back to count-derived defaults); a valid hint narrows the arrangement.
  if ("mediaLayout" in body || "media_layout" in body) {
    const nextLayout = readMediaLayout(body.mediaLayout ?? body.media_layout);
    sets.push("media_layout = ?");
    binds.push(nextLayout ? JSON.stringify(nextLayout) : null);
  }
  // Retarget when ANY targeting list is present. We rewrite all four columns
  // together so target_type stays in sync; missing buckets fall back to the
  // existing row's value (so a dept-only edit doesn't wipe a worker list).
  if (
    "targetDeptIds" in body ||
    "targetPositionIds" in body ||
    "targetUserIds" in body
  ) {
    const nextDepts =
      "targetDeptIds" in body
        ? readIntArray(body.targetDeptIds as string | number[] | null | undefined)
        : readIntArray(existing.targetDeptIds ?? existing.target_dept_ids ?? null);
    const nextPositions =
      "targetPositionIds" in body
        ? readIntArray(
            body.targetPositionIds as string | number[] | null | undefined,
          )
        : readIntArray(
            existing.targetPositionIds ?? existing.target_position_ids ?? null,
          );
    const nextUsers =
      "targetUserIds" in body
        ? readIntArray(body.targetUserIds as string | number[] | null | undefined)
        : readIntArray(existing.targetUserIds ?? existing.target_user_ids ?? null);
    let outDepts = nextDepts;
    let outPositions = nextPositions;
    let outUsers = nextUsers;
    if (sd.restricted) {
      const enforced = await enforceSalesDirectorScope(c, sd, {
        deptIds: nextDepts,
        positionIds: nextPositions,
        userIds: nextUsers,
        companyIds: [],
      });
      if (!enforced.ok) {
        return c.json({ success: false, error: enforced.error }, 403);
      }
      outDepts = enforced.deptIds;
      outPositions = [];
      outUsers = enforced.userIds;
    }
    sets.push("target_type = ?");
    binds.push(deriveTargetType(outDepts, outPositions, outUsers));
    sets.push("target_dept_ids = ?");
    binds.push(outDepts.length ? JSON.stringify(outDepts) : null);
    sets.push("target_position_ids = ?");
    binds.push(outPositions.length ? JSON.stringify(outPositions) : null);
    sets.push("target_user_ids = ?");
    binds.push(outUsers.length ? JSON.stringify(outUsers) : null);
  }
  // Company retarget. Present + empty array (or null) clears to NULL = all
  // companies; a non-empty array narrows to those companies.
  if ("targetCompanyIds" in body || "target_company_ids" in body) {
    const nextCompanies = readIntArray(
      (body.targetCompanyIds ?? body.target_company_ids) as
        | string
        | number[]
        | null
        | undefined,
    );
    // A Sales Director cannot choose a company target — reject a non-empty set.
    if (sd.restricted && nextCompanies.length > 0) {
      return c.json(
        { success: false, error: "A Sales Director cannot choose a company target." },
        403,
      );
    }
    sets.push("target_company_ids = ?");
    binds.push(nextCompanies.length ? JSON.stringify(nextCompanies) : null);
  }
  if ("category" in body) {
    sets.push("category = ?");
    binds.push(readCategory(body.category));
  }
  if (typeof body.requireAck === "boolean") {
    sets.push("require_ack = ?");
    binds.push(body.requireAck ? 1 : 0);
  }
  if ("scheduledAt" in body) {
    const raw = body.scheduledAt;
    if (raw == null || String(raw).trim() === "") {
      sets.push("scheduled_at = ?");
      binds.push(null);
    } else {
      const t = Date.parse(String(raw));
      if (Number.isNaN(t)) {
        return c.json({ success: false, error: "Invalid schedule date" }, 400);
      }
      sets.push("scheduled_at = ?");
      binds.push(t > Date.now() ? new Date(t).toISOString() : null);
    }
  }
  if ("expiresAt" in body) {
    const raw = body.expiresAt;
    if (raw == null || String(raw).trim() === "") {
      sets.push("expires_at = ?");
      binds.push(null);
    } else {
      const t = Date.parse(String(raw));
      if (Number.isNaN(t)) {
        return c.json({ success: false, error: "Invalid expiry date" }, 400);
      }
      sets.push("expires_at = ?");
      binds.push(new Date(t).toISOString());
    }
  }
  if (sets.length === 0) {
    return c.json({ success: true, data: toPublic(existing) });
  }
  if (textChanged) {
    const retranslated = await translateAnnouncement({
      title: nextTitle,
      body: nextText,
      bodyHtml: nextHtml,
      apiKey: c.env.ANTHROPIC_API_KEY,
    });
    sets.push("translations = ?");
    binds.push(retranslated ? JSON.stringify(retranslated) : null);
  }
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id);

  await c.env.DB.prepare(
    `UPDATE announcements SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...binds)
    .run();

  // Any edit (text, targeting, active toggle, expiry) can change who sees
  // what — orphan all cached banner snapshots.
  await bumpConfigVersion(c.env, "banner");

  const row = await c.env.DB.prepare(
    "SELECT * FROM announcements WHERE id = ?",
  )
    .bind(id)
    .first<AnnouncementRow>();
  return c.json({ success: true, data: row ? toPublic(row) : null });
});

// ============================================================
// POST /:id/remind — re-pop the banner for un-acked users.
// scope=unacked (default): leaves acked rows intact; stamps reminded_at.
// scope=all: wipes acks so the WHOLE roster re-pops from 0-of-N.
// ============================================================
app.post("/:id/remind", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const ann = await getScopedAnnouncement(c, id);
  if (!ann) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  // A Sales Director may only remind on notices they authored.
  if (sdBlockedFromRow(salesDirectorScope(c), ann, c.get("user")?.id ?? null)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  let scope: "all" | "unacked" = "unacked";
  try {
    const body = (await c.req.json().catch(() => null)) as {
      scope?: unknown;
    } | null;
    if (body && body.scope === "all") scope = "all";
  } catch {
    /* default */
  }

  const rosterRes = await c.env.DB.prepare(
    `SELECT id FROM users WHERE status = 'active'${rosterCompaniesSql(readTargetCompanyIds(ann))}`,
  ).all<{ id: number }>();
  const rosterIds = (rosterRes.results ?? []).map((u) => u.id);
  const ackRes = await c.env.DB.prepare(
    "SELECT user_id FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
    .all<{ user_id?: number; userId?: number }>();
  const ackedSet = new Set<number>();
  for (const a of ackRes.results ?? []) {
    const uid = a.userId ?? a.user_id;
    if (uid != null) ackedSet.add(uid);
  }
  const unackedCount = rosterIds.filter((uid) => !ackedSet.has(uid)).length;

  if (scope === "all") {
    await c.env.DB.prepare(
      "DELETE FROM announcement_acks WHERE announcement_id = ?",
    )
      .bind(id)
      .run();
  }
  await c.env.DB.prepare(
    "UPDATE announcements SET reminded_at = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), id)
    .run();

  // The re-pop gate compares reminded_at vs each user's ack — every cached
  // banner is now stale, orphan them all.
  await bumpConfigVersion(c.env, "banner");

  const pendingCount = scope === "all" ? rosterIds.length : unackedCount;
  return c.json({ success: true, pendingCount, scope });
});

// ============================================================
// DELETE /:id — hard delete + clean up ack rows.
// ============================================================
app.delete("/:id", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  // Cross-company guard: verify the notice belongs to the active company
  // before touching it (or its ack rows).
  const existing = await getScopedAnnouncement(c, id);
  if (!existing) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  // A Sales Director may only delete notices they authored.
  if (sdBlockedFromRow(salesDirectorScope(c), existing, c.get("user")?.id ?? null)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM announcements WHERE id = ?")
    .bind(id)
    .run();
  await c.env.DB.prepare(
    "DELETE FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
    .run();
  // The notice vanishes from every reader's banner — orphan all snapshots.
  await bumpConfigVersion(c.env, "banner");
  return c.json({ success: true });
});

// ============================================================
// POST /:id/ack — record THIS user's ack of one active notice. Idempotent
// (ON CONFLICT DO NOTHING) so a double-tap or retry never errors. Available
// to every authed user — no permission gate.
// ============================================================
app.post("/:id/ack", async (c) => {
  const user = c.get("user");
  if (!user || !user.id) {
    return c.json({ success: false, error: "Your session has expired. Please sign in again." }, 401);
  }
  const id = c.req.param("id");
  const row = await getScopedAnnouncement(c, id);
  if (!row || !deliverableNow(row)) {
    return c.json({ success: true, acked: false });
  }
  // Stamp the ack with the NOTICE's company (dual-read: the pg driver
  // camelCases result columns) — conditional so the pre-migration window /
  // D1 test mirror inserts unchanged.
  const annCompanyId = row.companyId ?? row.company_id ?? null;
  const stampCo = annCompanyId != null;
  await c.env.DB.prepare(
    `INSERT INTO announcement_acks (announcement_id, user_id, acked_at${stampCo ? ", company_id" : ""})
     VALUES (?, ?, ?${stampCo ? ", ?" : ""})
     ON CONFLICT (announcement_id, user_id) DO NOTHING`,
  )
    .bind(id, user.id, new Date().toISOString(), ...(stampCo ? [annCompanyId] : []))
    .run();
  // Only THIS user's ackedIds changed — bust their snapshot alone, so the
  // popup gate sees the ack on the very next banner poll.
  await bustBannerForUser(c.env, user.id);
  return c.json({ success: true, acked: true });
});

// ============================================================
// PUT /:id/attachments/upload?ext=... — two-step upload mirroring the projects
// finance / phase-photos pattern. Returns { r2Key, mime }. The FE then merges
// the manifest entry into the create/patch body.
// ============================================================
app.put(
  "/:id/attachments/upload",
  requirePermissionOrSalesDirector("announcements.write"),
  async (c) => {
    const id = c.req.param("id"); // 'compose' before save; real id on edit
    const ext = (c.req.query("ext") || "jpg").toLowerCase();
    const MIME_BY_EXT: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      heic: "image/heic",
      gif: "image/gif",
      pdf: "application/pdf",
      mp4: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
      m4v: "video/x-m4v",
    };
    const mime = MIME_BY_EXT[ext];
    if (!mime) return c.json({ error: "unsupported type" }, 400);
    const body = await c.req.arrayBuffer();
    if (body.byteLength > 25 * 1024 * 1024) {
      return c.json({ error: "Max 25MB" }, 400);
    }
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_") || "compose";
    const key = `announcements/${safeId}/${Date.now()}-${crypto
      .randomUUID()
      .slice(0, 8)}.${ext}`;
    await c.env.POD_BUCKET.put(key, body, {
      httpMetadata: { contentType: mime },
    });
    return c.json({ r2Key: key, mime, size: body.byteLength });
  },
);

// ============================================================
// PUT /:id/attachments/upload-thumb?key=... — WO-7 optional client-generated
// thumbnail for an image attachment uploaded via the route above, stored at
// `<r2Key>.thumb`. Same permission gate as the main upload; the prefix guard
// mirrors the download route's. Old clients never call this. Best-effort by
// contract — a failed/skipped thumb must not fail the attachment itself.
// ============================================================
app.put(
  "/:id/attachments/upload-thumb",
  requirePermissionOrSalesDirector("announcements.write"),
  async (c) => {
    const key = c.req.query("key") || "";
    if (!key.startsWith("announcements/") || isThumbKey(key)) {
      return c.json({ error: "forbidden key" }, 403);
    }
    const contentType = (c.req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
    // Raster allow-list, not startsWith("image/") — the latter admits
    // image/svg+xml, which is a stored-XSS vector when served back (audit M6).
    const THUMB_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
    if (!THUMB_TYPES.has(contentType)) {
      return c.json({ error: "Thumbnails must be JPEG, PNG, WebP, or GIF" }, 400);
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > THUMB_MAX_BYTES) {
      return c.json({ error: "Thumbnail too large (max 1MB)" }, 400);
    }
    await c.env.POD_BUCKET.put(thumbKeyFor(key), body, {
      httpMetadata: { contentType },
    });
    return c.json({ r2Key: thumbKeyFor(key) });
  },
);

// ============================================================
// GET /:id/attachments/:key{.+} — stream the attachment. Gated by the SAME
// audience-targeting check as the list/banner (userCanSee), NOT by the
// announcements.read matrix permission: a broadcast to ALL_USERS (or to this
// user's dept/position/id) must render its image/PDF even for a member who
// lacks announcements.read (e.g. Sales) — otherwise they get a grey
// placeholder. Managers (`*` / announcements.write) stay unaffected. The key
// must belong to THIS announcement's attachment set, so a targeted user can't
// pull an attachment of an announcement they aren't targeted by. The key
// includes slashes, hence the {.+} matcher.
// ============================================================
app.get("/:id/attachments/:key{.+}", async (c) => {
  const user = c.get("user");
  if (!user || !user.id) return c.json({ error: "Your session has expired. Please sign in again." }, 401);

  const id = c.req.param("id");
  const key = c.req.param("key");
  if (!key.startsWith("announcements/")) {
    return c.json({ error: "forbidden key" }, 403);
  }

  // The announcement must exist within the caller's active company. Unknown /
  // cross-company id → 404 (indistinguishable from a nonexistent id).
  const ann = await getScopedAnnouncement(c, id);
  if (!ann) return c.json({ error: "Not found" }, 404);

  // Audience gate — managers see everything; everyone else only announcements
  // whose targeting includes them (same userCanSee used by list/banner).
  const granted = user.permissions_set ?? user.permissions ?? [];
  const isManager =
    hasPermission(granted, "*") || hasPermission(granted, "announcements.write");
  if (
    !isManager &&
    !userCanSee(ann, user.id, user.department_id ?? null, user.position_id ?? null)
  ) {
    return c.json({ error: "Not found" }, 404);
  }

  // The key must be one of THIS announcement's attachments — prevents using a
  // visible announcement's id to stream an unrelated object. WO-7: a `.thumb`
  // sibling is authorised against its BASE key (thumbs never appear in the
  // manifest); a missing thumb object 404s below and the frontend falls back
  // to the original attachment.
  const requestedBase = isThumbKey(key) ? baseKeyOf(key) : key;
  const belongs = normalizeAttachments(ann.attachments ?? null).some(
    (a) => a.r2Key === requestedBase,
  );
  if (!belongs) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // Never serve a stored blob inline with an executable content-type. Keep the
  // known-safe raster/PDF types inline; force everything else (e.g. a legacy SVG
  // thumbnail from before the upload allow-list) to download inertly. nosniff
  // blocks MIME-sniffing back into html/svg either way (audit M6).
  const INLINE_SAFE = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf",
  ]);
  const served = (headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!INLINE_SAFE.has(served)) {
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", "attachment");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(obj.body, { headers });
});

export default app;
