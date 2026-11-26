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
  CLAUDE_MODEL as TRANSLATE_MODEL,
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
import {resolveNumberDept,  APPROVE_PERMISSION, recordSubmission, type Actor } from "../services/announcementApproval";
import {
  ATTACHMENT_REQUIRED_MESSAGE,
  attachmentRequiredForType,
  resolveDocType,
  syncAttachmentLog,
} from "../services/announcementFiles";
import {
  audienceOf,
  callerDivision,
  categoryRequiresAck,
  deliverableNow,
  divisionEq,
  isVoided,
  readApprovalStatus,
  readNumberDept, readDocType,
  isActiveFlag,
  laterOf,
  loadAckMap,
  loadRoster,
  loadUserReminders,
  notExpired,
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
  type AnnouncementRow,
  type DivisionTarget,
  type MediaLayout,
  type PhotoLayout,
  type TargetType,
  type VideoLayout,
} from "../lib/announcementAudience";

const app = new Hono<{ Bindings: Env }>();






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


export function normalizeAttachments(raw: unknown): AnnouncementAttachment[] {
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


function deriveTargetType(
  deptIds: number[],
  positionIds: number[],
  userIds: number[],
  divisions: DivisionTarget[] = [],
): TargetType {
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

export function toPublic(r: AnnouncementRow) {
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
    approvalStatus: readApprovalStatus(r),
    submittedBy: r.submittedBy ?? r.submitted_by ?? null,
    submittedAt: r.submittedAt ?? r.submitted_at ?? null,
    reviewedBy: r.reviewedBy ?? r.reviewed_by ?? null,
    reviewedAt: r.reviewedAt ?? r.reviewed_at ?? null,
    rejectReason: r.rejectReason ?? r.reject_reason ?? null,
    refNo: r.refNo ?? r.ref_no ?? null,
    voidedBy: r.voidedBy ?? r.voided_by ?? null,
    voidedAt: r.voidedAt ?? r.voided_at ?? null,
    voidReason: r.voidReason ?? r.void_reason ?? null,
    docType: readDocType(r),
    numberDeptId: readNumberDept(r),
    source: (r.source ?? null) as string | null,
  };
}

type PublicAnnouncement = ReturnType<typeof toPublic> & {
  createdByName?: string | null;
  targetDeptNames?: string[];
  targetDivisionNames?: string[];
};

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

export async function getScopedAnnouncement(
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


export function companyCanSee(r: AnnouncementRow, allowed: number[] | undefined): boolean {
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

export function salesDirectorScope(c: { get: (k: string) => unknown }): SdScope {
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

export function sdBlockedFromRow(scope: SdScope, row: AnnouncementRow, userId: number | null): boolean {
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
  const user = c.get("user");
  if (!user || !user.id) {
    return c.json({ success: false, error: "Your session has expired. Please sign in again." }, 401);
  }
  const res = await c.env.DB
    .prepare(
      `SELECT * FROM announcements WHERE source IS NULL ORDER BY created_at DESC`,
    )
    .all<AnnouncementRow>();
  const allowed = allowedCompanyIds(c);
  const granted = user.permissions_set ?? user.permissions ?? [];
  const isManager =
    hasPermission(granted, "*") ||
    hasPermission(granted, "announcements.write") ||
    hasPermission(granted, APPROVE_PERMISSION);
  const sd = salesDirectorScope(c);
  const visible = (res.results ?? []).filter((r) => companyCanSee(r, allowed));
  const rows = isManager
    ? visible
    : await (async () => {
        const division = await callerDivision(c.env, user.id);
        return visible.filter((r) => {
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
  const bannerScope: BannerScope = systemOnly ? "system" : "human";

  const bannerVersion = await configCacheVersion(c.env, "banner");
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
    const remindedAt = laterOf(r.remindedAt ?? r.reminded_at ?? null, myReminders.get(r.id) ?? null);
    if (isRemindedSince(remindedAt, ackedAt)) continue;
    ackedIds.push(r.id);
  }

  const payload = {
    success: true,
    data: (await withNames(c.env, active)).map((p) => ({
      ...p,
      remindedAt: laterOf(p.remindedAt, myReminders.get(p.id) ?? null),
    })),
    ackedIds,
  };
  if (cacheKey) {
    const fill = (async () => {
      try {
        await c.env.SESSION_CACHE?.put(cacheKey, JSON.stringify(payload), {
          expirationTtl: CONFIG_CACHE_TTL_SECONDS.banner,
        });
      } catch {
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




const CLIENT_KEY_RE = /^[A-Za-z0-9._-]{8,64}$/;
function readClientKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return CLIENT_KEY_RE.test(s) ? s : null;
}

async function findByClientKey(
  env: Env,
  userId: number,
  clientKey: string,
): Promise<AnnouncementRow | null> {
  // company-scope: keyed by the AUTHOR, not the tenant — a retry must find
  // the row the first request made whatever company context it arrives in,
  // and (created_by, client_key) is unique across the table.
  return env.DB.prepare(
    "SELECT * FROM announcements WHERE created_by = ? AND client_key = ? LIMIT 1",
  )
    .bind(userId, clientKey)
    .first<AnnouncementRow>();
}

function queueTranslation(
  c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  id: string,
  src: TranslationSource,
): void {
  const run = translateAndStore(c.env, id, src,
    { env: c.env, feature: "announcement_translate", model: TRANSLATE_MODEL, companyId: null, userId: null, waitUntil: null });
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
  // Idempotent create (mig 20260907T0010): the composer's draft carries a key
  // minted when the draft is first saved and cleared with it on success. A
  // repeat of the same draft — after a hang, a reload, a second click — is
  // answered with the row the first request made, never a second one
  // (docs/bugs/0651: nine copies of one notice on 2026-09-06).
  const clientKey = readClientKey(body.clientKey);
  const keyOwner = clientKey ? user.id : null;
  if (clientKey && keyOwner != null) {
    const dup = await findByClientKey(c.env, keyOwner, clientKey);
    if (dup) return c.json({ success: true, data: toPublic(dup), duplicate: true }, 201);
  }
  const attachments = normalizeAttachments(body.attachments);
  const rawHtml = body.bodyHtml ?? body.body_html;
  const rich = readBodyHtml(rawHtml, attachments.map((a) => a.r2Key));
  if (rich.error) return c.json({ success: false, error: rich.error }, 400);
  const bodyHtml = rich.html;
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
  const reqCompanyIds = readIntArray(
    (body.targetCompanyIds ?? body.target_company_ids) as
      | string
      | number[]
      | null
      | undefined,
  );

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
  const requireAck =
    typeof body.requireAck === "boolean" ? body.requireAck : categoryRequiresAck(category);
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
  const companyId = activeCompanyId(c);
  const stampCo = companyId != null;
  const asDraft = body.draft === true;
  const initialStatus = asDraft ? "DRAFT" : "PENDING_APPROVAL";
  const docTypeRes = await resolveDocType(c.env, body.docType);
  if ("error" in docTypeRes) return c.json({ success: false, error: docTypeRes.error }, 400);
  const docType = docTypeRes.code;
  const numberDept = await resolveNumberDept(c.env, body.numberDeptId);
  if ("error" in numberDept) return c.json({ success: false, error: numberDept.error }, 400);
  if (!asDraft && attachments.length === 0 && (await attachmentRequiredForType(c.env, docType))) {
    return c.json({ success: false, error: ATTACHMENT_REQUIRED_MESSAGE }, 400);
  }

  const stampKey = keyOwner != null;
  const insert = c.env.DB.prepare(
    `INSERT INTO announcements
       (id, title, body, body_html, is_active, expires_at, created_by, created_at,
        translations, attachments, media_layout, target_type,
        target_dept_ids, target_position_ids, target_user_ids,
        target_company_ids, category, require_ack, scheduled_at,
        target_divisions, excluded_user_ids,
        approval_status, submitted_by, submitted_at, doc_type${stampCo ? ", company_id" : ""}${stampKey ? ", client_key" : ""})
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""}${stampKey ? ", ?" : ""})`,
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
      initialStatus,
      asDraft ? null : user?.id ?? null,
      asDraft ? null : nowIso,
      docType,
      ...(stampCo ? [companyId] : []),
      ...(stampKey ? [clientKey] : []),
    );
  try {
    await insert.run();
  } catch (e) {
    if (stampKey) {
      const dup = await findByClientKey(c.env, keyOwner, clientKey as string);
      if (dup) return c.json({ success: true, data: toPublic(dup), duplicate: true }, 201);
    }
    throw e;
  }
  if (numberDept.id != null) {
    // company-scope: the row just inserted, by primary key. A separate UPDATE so an older mirror without the column is untouched by a plain post.
    await c.env.DB.prepare("UPDATE announcements SET number_dept_id = ? WHERE id = ?").bind(numberDept.id, id).run();
  }

  const row = await c.env.DB.prepare(
    "SELECT * FROM announcements WHERE id = ?",
  )
    .bind(id)
    .first<AnnouncementRow>();

  await bumpConfigVersion(c.env, "banner");

  queueTranslation(c, id, { title, body: text, bodyHtml });

  if (row && attachments.length > 0) await syncAttachmentLog(c.env, id, attachments, actorOf(user));

  if (row && !asDraft) await recordSubmission(c.env, row, actorOf(user));


  return c.json({ success: true, data: row ? toPublic(row) : null }, 201);
});

/** The audit / notice actor for the signed-in user (POST, PATCH and the
 *  approval router share it). */
export function actorOf(user: AuthUser | undefined): Actor {
  return { id: user?.id ?? null, email: user?.email ?? null, name: user?.name ?? null };
}

app.patch("/:id", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const existing = await getScopedAnnouncement(c, id);
  if (!existing) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
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
  if ("mediaLayout" in body || "media_layout" in body) {
    const nextLayout = readMediaLayout(body.mediaLayout ?? body.media_layout);
    sets.push("media_layout = ?");
    binds.push(nextLayout ? JSON.stringify(nextLayout) : null);
  }
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
  if ("targetCompanyIds" in body || "target_company_ids" in body) {
    const nextCompanies = readIntArray(
      (body.targetCompanyIds ?? body.target_company_ids) as
        | string
        | number[]
        | null
        | undefined,
    );
    if (sd.restricted && nextCompanies.length > 0) {
      return c.json(
        { success: false, error: "A Sales Director cannot choose a company target." },
        403,
      );
    }
    sets.push("target_company_ids = ?");
    binds.push(nextCompanies.length ? JSON.stringify(nextCompanies) : null);
  }
  if ("docType" in body) {
    if (readApprovalStatus(existing) === "APPROVED") {
      return c.json({ success: false, error: "The document type of a published notice cannot change." }, 409);
    }
    const res = await resolveDocType(c.env, body.docType);
    if ("error" in res) return c.json({ success: false, error: res.error }, 400);
    sets.push("doc_type = ?");
    binds.push(res.code);
  }
  if ("numberDeptId" in body) {
    if (readApprovalStatus(existing) === "APPROVED") {
      return c.json({ success: false, error: "The numbering department of a published notice cannot change." }, 409);
    }
    const nd = await resolveNumberDept(c.env, body.numberDeptId);
    if ("error" in nd) return c.json({ success: false, error: nd.error }, 400);
    sets.push("number_dept_id = ?");
    binds.push(nd.id);
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

  await bumpConfigVersion(c.env, "banner");

  if ("attachments" in body) await syncAttachmentLog(c.env, id, nextAttachments, actorOf(c.get("user")));

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

app.post("/:id/remind", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const ann = await getScopedAnnouncement(c, id);
  if (!ann) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  if (sdBlockedFromRow(salesDirectorScope(c), ann, c.get("user")?.id ?? null)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  if (isVoided(ann)) {
    return c.json({ success: false, error: "A voided announcement cannot be reminded." }, 409);
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
  }

  const roster = audienceOf(ann, await loadRoster(c.env, readTargetCompanyIds(ann)));
  const ackedAtByUser = await loadAckMap(c.env, id);
  const now = new Date().toISOString();

  if (scope === "all") {
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
  await recordReminders(c.env, id, pending.map((u) => u.id), c.get("user")?.id ?? null, now);
  if (departmentId == null) {
    // A whole-notice reminder keeps the notice-level stamp too, so a reader
    // outside the roster snapshot (joined since) still sees the re-pop.
    // company-scope: ONE notice by primary key, already scoped by getScopedAnnouncement (companyCanSee) above.
    await c.env.DB.prepare("UPDATE announcements SET reminded_at = ? WHERE id = ?")
      .bind(now, id)
      .run();
  }

  await bumpConfigVersion(c.env, "banner");

  return c.json({ success: true, pendingCount: pending.length, scope, departmentId });
});

app.delete("/:id", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const existing = await getScopedAnnouncement(c, id);
  if (!existing) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  if (sdBlockedFromRow(salesDirectorScope(c), existing, c.get("user")?.id ?? null)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  // Drafts only (mig 20260907T1030, owner: 不可以删只可以 cancel): a submitted
  // notice is voided (POST /:id/void) and keeps its row, receipts and number.
  // The database trigger refuses the same thing underneath.
  if (readApprovalStatus(existing) !== "DRAFT") {
    return c.json(
      { success: false, error: "A submitted announcement is voided, not deleted — use Void and give a reason." },
      409,
    );
  }
  await c.env.DB.prepare("DELETE FROM announcements WHERE id = ?")
    .bind(id)
    .run();
  await c.env.DB.prepare(
    "DELETE FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
    .run();
  await bumpConfigVersion(c.env, "banner");
  return c.json({ success: true });
});

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
  const annCompanyId = row.companyId ?? row.company_id ?? null;
  const stampCo = annCompanyId != null;
  await c.env.DB.prepare(
    `INSERT INTO announcement_acks (announcement_id, user_id, acked_at${stampCo ? ", company_id" : ""})
     VALUES (?, ?, ?${stampCo ? ", ?" : ""})
     ON CONFLICT (announcement_id, user_id) DO NOTHING`,
  )
    .bind(id, user.id, new Date().toISOString(), ...(stampCo ? [annCompanyId] : []))
    .run();
  await bustBannerForUser(c.env, user.id);
  return c.json({ success: true, acked: true });
});

app.put(
  "/:id/attachments/upload",
  requirePermissionOrSalesDirector("announcements.write"),
  async (c) => {
    const id = c.req.param("id");
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

app.put(
  "/:id/attachments/upload-thumb",
  requirePermissionOrSalesDirector("announcements.write"),
  async (c) => {
    const key = c.req.query("key") || "";
    if (!key.startsWith("announcements/") || isThumbKey(key)) {
      return c.json({ error: "forbidden key" }, 403);
    }
    const contentType = (c.req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
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

app.get("/:id/attachments/:key{.+}", async (c) => {
  const user = c.get("user");
  if (!user || !user.id) return c.json({ error: "Your session has expired. Please sign in again." }, 401);

  const id = c.req.param("id");
  const key = c.req.param("key");
  if (!key.startsWith("announcements/")) {
    return c.json({ error: "forbidden key" }, 403);
  }

  const ann = await getScopedAnnouncement(c, id);
  if (!ann) return c.json({ error: "Not found" }, 404);

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

  const requestedBase = isThumbKey(key) ? baseKeyOf(key) : key;
  const belongs = normalizeAttachments(ann.attachments ?? null).some(
    (a) => a.r2Key === requestedBase,
  );
  if (!belongs) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
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
