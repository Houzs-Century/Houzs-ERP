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
//   - Translate-announcement.ts is ported and called best-effort — and, since
//     2026-09-06, AFTER the response under waitUntil (queueTranslation). The
//     row is written with translations NULL; the FE shows the original text
//     until the fill lands, or for good when ANTHROPIC_API_KEY is unset.
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
  translateAndStore,
  type AnnouncementTranslations,
  type TranslationSource,
} from "../lib/translate-announcement";
import {
  RICH_HTML_MAX,
  hasRichFormatting,
  richTextToPlain,
  sanitizeAnnouncementHtml,
  stripUnreferencedImages,
} from "../lib/announcementRichText";
import { postPersonalNotice } from "../services/personalNotice";
import { escalatePending } from "../services/announcementEscalation";
import {
  ACK_OVERDUE_HOURS,
  announcementRequiresAck,
  audienceOf,
  callerDivision,
  categoryRequiresAck,
  deliverableNow,
  divisionEq,
  inTargetCompanies,
  isActiveFlag,
  laterOf,
  loadAckMap,
  loadAllAcks,
  loadAllReminders,
  loadCompanyGrants,
  loadReminderMap,
  loadRoster,
  loadUserReminders,
  notExpired,
  pendingState,
  readCategory,
  readDivisionTargets,
  readIntArray,
  readRequireAck,
  readTargetCompanyIds,
  readTargetType,
  rosterCompaniesSql,
  rowDivisions,
  rowExcluded,
  recordReminders,
  scheduledLater,
  userCanSee,
  type AnnouncementAttachment,
  type AnnouncementCategory,
  type AnnouncementRow,
  type DivisionTarget,
  type MediaLayout,
  type PendingState,
  type PhotoLayout,
  type RosterUser,
  type TargetType,
  type VideoLayout,
} from "../lib/announcementAudience";

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

// Targeting kinds. ALL_USERS = everyone (the back-compat default).

// One attached media file on an announcement. `r2Key` lives in POD_BUCKET.
// `name` is the original filename; `mime` drives the renderer (image/video/pdf).

// Rich-media LAYOUT hint (mig 0140). The author picks how the media is laid out;
// every renderer (desktop pop-up + page, mobile detail) honours the SAME hint so
// a notice looks identical everywhere. Both keys optional — a missing key means
// "derive a default from the attachment count", which is exactly how pre-0140
// (NULL) rows keep rendering unchanged.
//   · photo: how the photo set is arranged — "1" one big, "2" side-by-side,
//     "3" three across, "4" a 2x2 grid.
//   · video: the video block's shape — "1x1" square, "1x2" portrait (tall).

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





// Categories that block by default — the value the require_ack flag takes when
// the composer does not say otherwise, and the rule a pre-migration row falls
// back to. Mirrors frontend/src/components/announcementCategory.ts.

// The stored flag, or null when the column is absent / NULL (pre-migration row,
// D1 test mirror) so the client applies the category rule itself.

// Not yet reached its scheduled posting instant. NULL / unparseable = live now.


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




// Derive the canonical target_type from which target lists are non-empty.
// Empty all -> ALL_USERS; one bucket -> that bucket's enum; multiple -> MIXED.
function deriveTargetType(
  deptIds: number[],
  positionIds: number[],
  userIds: number[],
  divisions: DivisionTarget[] = [],
): TargetType {
  // A division is a slice of a department, so it counts as the DEPARTMENT
  // bucket — the target_type CHECK constraint keeps its five values.
  const deptBucket = deptIds.length > 0 || divisions.length > 0;
  const buckets =
    (deptBucket ? 1 : 0) +
    (positionIds.length > 0 ? 1 : 0) +
    (userIds.length > 0 ? 1 : 0);
  if (buckets === 0) return "ALL_USERS";
  if (buckets > 1) return "MIXED";
  if (deptBucket) return "DEPARTMENT_IDS";
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
    targetDivisions: rowDivisions(r),
    excludedUserIds: rowExcluded(r),
    targetCompanyIds: readTargetCompanyIds(r),
    category: readCategory(r.category),
    requireAck: readRequireAck(r.requireAck ?? r.require_ack ?? null),
    scheduledAt: r.scheduledAt ?? r.scheduled_at ?? null,
    escalatedAt: r.escalatedAt ?? r.escalated_at ?? null,
    // System-notice tag ('scan' for background slip-scan results). Lets the
    // client suppress the read-receipt roster on private per-user notices.
    source: (r.source ?? null) as string | null,
  };
}

type PublicAnnouncement = ReturnType<typeof toPublic> & {
  createdByName?: string | null;
  targetDeptNames?: string[];
  /** "Operation › Driver Team" per targetDivisions entry, same order. */
  targetDivisionNames?: string[];
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
    for (const d of p.targetDivisions) deptIds.add(d.deptId);
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
    if (p.targetDivisions.length > 0) {
      p.targetDivisionNames = p.targetDivisions.map(
        (d) => `${deptName.get(d.deptId) ?? `Dept #${d.deptId}`} › ${d.division}`,
      );
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
    divisions?: DivisionTarget[];
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
  if ((req.divisions ?? []).some((d) => d.deptId !== deptId)) {
    return {
      ok: false,
      error: "A Sales Director can only post to divisions of their own Sales department.",
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
  if (deptIds.length === 0 && req.userIds.length === 0 && (req.divisions ?? []).length === 0) {
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
    : await (async () => {
        const division = await callerDivision(c.env, user.id);
        return visible.filter((r) => {
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
              division,
            )
          );
        });
      })();
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
  const [res, ackRes, myReminders] = await Promise.all([
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
    loadUserReminders(c.env, user.id),
  ]);
  const division = await callerDivision(c.env, user.id);
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
        division,
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
    // Whole-notice reminder OR this reader's own (per-department) reminder.
    const remindedAt = laterOf(r.remindedAt ?? r.reminded_at ?? null, myReminders.get(r.id) ?? null);
    if (isRemindedSince(remindedAt, ackedAt)) continue;
    ackedIds.push(r.id);
  }

  const payload = {
    success: true,
    // The per-notice remindedAt the client compares against its local ack is
    // the reader's EFFECTIVE one (notice-level or their own row).
    data: (await withNames(c.env, active)).map((p) => ({
      ...p,
      remindedAt: laterOf(p.remindedAt, myReminders.get(p.id) ?? null),
    })),
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
  const reminders = await loadReminderMap(c.env, id);
  const now = Date.now();

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
  const pending: Array<Person & { state: PendingState; remindedAt: string | null }> = [];
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
      const remindedAt = reminders.get(u.id) ?? null;
      pending.push({ ...person(u), state: pendingState(ann, now, remindedAt), remindedAt });
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
  const totals = await noticeAckTotals(c.env, rows);
  const data: Record<string, { total: number; acked: number }> = {};
  for (const [id, t] of totals) data[id] = t;
  return c.json({ success: true, data });
});

// The ONE per-notice arithmetic behind /ack-summary and /ack-trend: the
// audience (roster through the gate, narrowed by company grants) and how many
// of it acknowledged. Kept together so the Manage table and the dashboard
// chart can never disagree on a rate.
async function noticeAckTotals(
  env: Env,
  rows: AnnouncementRow[],
): Promise<Map<string, { total: number; acked: number }>> {
  const [roster, acks, grants] = await Promise.all([
    loadRoster(env, []),
    loadAllAcks(env),
    loadCompanyGrants(env),
  ]);
  const out = new Map<string, { total: number; acked: number }>();
  for (const r of rows) {
    const targets = readTargetCompanyIds(r);
    const audience = audienceOf(r, roster).filter((u) => inTargetCompanies(grants, u.id, targets));
    const ackedSet = acks.get(r.id);
    let acked = 0;
    for (const u of audience) if (ackedSet?.has(u.id)) acked += 1;
    out.set(r.id, { total: audience.length, acked });
  }
  return out;
}

// ============================================================
// GET /ack-trend — the dashboard's "Ack rate · last 30 days" (design handoff
// 2026-09-04, screen 5; endpoint 2026-09-06): six 5-day buckets ending now,
// each the summed audience and acknowledgements of the human notices POSTED
// in it, plus the 30-day summary. Same gate, ownership rule and per-notice
// arithmetic as /ack-summary, so the card and the Manage table agree. A
// bucket with no notice has pct null (drawn empty, never as 0%). Buckets
// carry ISO instants only; the client renders them with the house fmtDate.
// ============================================================
const ACK_TREND_DAYS = 30;
const ACK_TREND_BUCKETS = 6;
app.get("/ack-trend", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ success: false, error: "Your session has expired. Please sign in again." }, 401);
  }
  const sd = salesDirectorScope(c);
  const allowed = allowedCompanyIds(c);
  const now = Date.now();
  const dayMs = 86_400_000;
  const bucketMs = (ACK_TREND_DAYS / ACK_TREND_BUCKETS) * dayMs;
  const windowStart = now - ACK_TREND_DAYS * dayMs;
  // company-scope: announcements carry their audience as target_company_ids
  // (NULL = every company), not a per-row company predicate — the same in-JS
  // companyCanSee(allowed) gate the list applies runs on the very next line.
  const res = await c.env.DB
    .prepare(`SELECT * FROM announcements WHERE source IS NULL AND created_at >= ? ORDER BY created_at ASC`)
    .bind(new Date(windowStart).toISOString())
    .all<AnnouncementRow>();
  const rows = (res.results).filter(
    (r) => companyCanSee(r, allowed) && !sdBlockedFromRow(sd, r, user.id),
  );
  const totals = await noticeAckTotals(c.env, rows);
  const buckets = Array.from({ length: ACK_TREND_BUCKETS }, (_, i) => {
    const start = new Date(windowStart + i * bucketMs);
    const end = new Date(windowStart + (i + 1) * bucketMs);
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      notices: 0,
      total: 0,
      acked: 0,
      pct: null as number | null,
    };
  });
  const summary = { days: ACK_TREND_DAYS, notices: 0, total: 0, acked: 0, pct: null as number | null };
  for (const r of rows) {
    const t = Date.parse(r.createdAt ?? r.created_at ?? "");
    if (Number.isNaN(t) || t < windowStart) continue;
    const idx = Math.min(ACK_TREND_BUCKETS - 1, Math.floor((t - windowStart) / bucketMs));
    const tot = totals.get(r.id) ?? { total: 0, acked: 0 };
    const b = buckets[idx];
    b.notices += 1;
    b.total += tot.total;
    b.acked += tot.acked;
    summary.notices += 1;
    summary.total += tot.total;
    summary.acked += tot.acked;
  }
  const pctOf = (acked: number, total: number) => (total > 0 ? Math.round((acked / total) * 100) : null);
  for (const b of buckets) b.pct = pctOf(b.acked, b.total);
  summary.pct = pctOf(summary.acked, summary.total);
  return c.json({ success: true, data: { days: ACK_TREND_DAYS, buckets, summary } });
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
  const [res, acks, grants, reminders] = await Promise.all([
    c.env.DB
      // company-scope: audience is per REPORT via target_company_ids + inTargetCompanies below; rows carry no company column.
      .prepare(`SELECT * FROM announcements WHERE is_active = 1 AND source IS NULL ORDER BY created_at DESC`)
      .all<AnnouncementRow>(),
    loadAllAcks(c.env),
    loadCompanyGrants(c.env),
    loadAllReminders(c.env),
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
    for (const u of reports) {
      if (!userCanSee(r, u.id, u.departmentId, u.positionId, u.division)) continue;
      if (!inTargetCompanies(grants, u.id, targets)) continue;
      if (ackedSet?.has(u.id)) continue;
      const state = pendingState(r, now, reminders.get(r.id)?.get(u.id) ?? null);
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
  // The same implementation the overdue cron runs (services/announcementEscalation.ts).
  const r = await escalatePending(c.env, ann, deptFilter);
  return c.json({ success: true, ...r });
});

// ============================================================
// POST / — create. Body validated server-side.
// ============================================================
// Run the four-language translation AFTER the response. The row is already
// written (translations NULL); translateAndStore fills the column when the
// reply lands and drops it if the text was edited meanwhile. Same
// waitUntil-with-floating-fallback shape as the banner cache fill above —
// c.executionCtx throws in the bare-Hono test harness.
function queueTranslation(
  c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  id: string,
  src: TranslationSource,
): void {
  const run = translateAndStore(c.env, id, src);
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    void run;
  }
}

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
  const reqDivisions = readDivisionTargets(body.targetDivisions ?? body.target_divisions);
  const reqExcluded = readIntArray(
    (body.excludedUserIds ?? body.excluded_user_ids) as string | number[] | null | undefined,
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
      divisions: reqDivisions,
    });
    if (!enforced.ok) {
      return c.json({ success: false, error: enforced.error }, 403);
    }
    effDeptIds = enforced.deptIds;
    effPositionIds = [];
    effUserIds = enforced.userIds;
    effCompanyIds = [];
  }

  const targetType = deriveTargetType(effDeptIds, effPositionIds, effUserIds, reqDivisions);
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
  // Translations are filled in AFTER the response (queueTranslation below):
  // the row is written with NULL and the FE shows the original text until the
  // background job lands. The old await here held "Posting…" for 40-100 s on
  // a rich notice and the owner's repeated clicks each inserted a row.

  await c.env.DB.prepare(
    `INSERT INTO announcements
       (id, title, body, body_html, is_active, expires_at, created_by, created_at,
        translations, attachments, media_layout, target_type,
        target_dept_ids, target_position_ids, target_user_ids,
        target_company_ids, category, require_ack, scheduled_at,
        target_divisions, excluded_user_ids${stampCo ? ", company_id" : ""})
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`,
  )
    .bind(
      id,
      title,
      text,
      bodyHtml,
      expiresAt,
      user?.id ?? null,
      nowIso,
      null,
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
      reqDivisions.length ? JSON.stringify(reqDivisions) : null,
      reqExcluded.length ? JSON.stringify(reqExcluded) : null,
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

  queueTranslation(c, id, { title, body: text, bodyHtml });

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
    "targetUserIds" in body ||
    "targetDivisions" in body ||
    "excludedUserIds" in body
  ) {
    const nextDivisions =
      "targetDivisions" in body
        ? readDivisionTargets(body.targetDivisions)
        : rowDivisions(existing);
    const nextExcluded =
      "excludedUserIds" in body
        ? readIntArray(body.excludedUserIds as string | number[] | null | undefined)
        : rowExcluded(existing);
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
        divisions: nextDivisions,
      });
      if (!enforced.ok) {
        return c.json({ success: false, error: enforced.error }, 403);
      }
      outDepts = enforced.deptIds;
      outPositions = [];
      outUsers = enforced.userIds;
    }
    sets.push("target_type = ?");
    binds.push(deriveTargetType(outDepts, outPositions, outUsers, nextDivisions));
    sets.push("target_dept_ids = ?");
    binds.push(outDepts.length ? JSON.stringify(outDepts) : null);
    sets.push("target_position_ids = ?");
    binds.push(outPositions.length ? JSON.stringify(outPositions) : null);
    sets.push("target_user_ids = ?");
    binds.push(outUsers.length ? JSON.stringify(outUsers) : null);
    sets.push("target_divisions = ?");
    binds.push(nextDivisions.length ? JSON.stringify(nextDivisions) : null);
    sets.push("excluded_user_ids = ?");
    binds.push(nextExcluded.length ? JSON.stringify(nextExcluded) : null);
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
    // The stored translation describes text that is about to change: clear
    // it with the edit (readers see the new original, never the old
    // translation) and refill it after the response — queueTranslation below.
    sets.push("translations = ?");
    binds.push(null);
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

  if (textChanged) {
    queueTranslation(c, id, { title: nextTitle, body: nextText, bodyHtml: nextHtml });
  }

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
  let departmentId: number | null = null;
  try {
    const body = (await c.req.json().catch(() => null)) as {
      scope?: unknown;
      departmentId?: unknown;
    } | null;
    if (body && body.scope === "all") scope = "all";
    if (body && body.departmentId != null) {
      const n = parseInt(String(body.departmentId), 10);
      if (Number.isFinite(n)) departmentId = n;
    }
  } catch {
    /* default */
  }

  // The audience (not every active user): the same roster the receipts show.
  const roster = audienceOf(ann, await loadRoster(c.env, readTargetCompanyIds(ann)));
  const ackedAtByUser = await loadAckMap(c.env, id);
  const now = new Date().toISOString();

  if (scope === "all") {
    // "Reset all receipts" (phone only since 2026-09-05): the whole notice
    // starts over — receipts cleared, notice-level stamp set, no per-person rows.
    await c.env.DB.prepare(
      "DELETE FROM announcement_acks WHERE announcement_id = ?",
    )
      .bind(id)
      .run();
    // company-scope: ONE notice by primary key, already scoped by getScopedAnnouncement (companyCanSee) above.
    await c.env.DB.prepare("UPDATE announcements SET reminded_at = ? WHERE id = ?")
      .bind(now, id)
      .run();
    await bumpConfigVersion(c.env, "banner");
    return c.json({ success: true, pendingCount: roster.length, scope, departmentId: null });
  }

  // Un-acked people, optionally only one department's (the drawer's
  // "Remind <Dept> pending", owner 2026-09-06).
  const pending = roster.filter(
    (u) => !ackedAtByUser.has(u.id) && (departmentId == null || u.departmentId === departmentId),
  );
  // Per-person rows carry the reminder (mig 20260906T0921): the banner re-pops
  // for exactly these people and the drawer paints exactly them "reminded".
  await recordReminders(c.env, id, pending.map((u) => u.id), c.get("user")?.id ?? null, now);
  if (departmentId == null) {
    // A whole-notice reminder keeps the notice-level stamp too, so a reader
    // outside the roster snapshot (joined since) still sees the re-pop.
    // company-scope: ONE notice by primary key, already scoped by getScopedAnnouncement (companyCanSee) above.
    await c.env.DB.prepare("UPDATE announcements SET reminded_at = ? WHERE id = ?")
      .bind(now, id)
      .run();
  }

  // The re-pop gate compares the reminder vs each user's ack — every cached
  // banner is now stale, orphan them all.
  await bumpConfigVersion(c.env, "banner");

  return c.json({ success: true, pendingCount: pending.length, scope, departmentId });
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
    !userCanSee(
      ann,
      user.id,
      user.department_id ?? null,
      user.position_id ?? null,
      await callerDivision(c.env, user.id),
    )
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
