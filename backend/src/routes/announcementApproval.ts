// ---------------------------------------------------------------------------
// Announcement approval + attachment-log routes — split out of
// routes/announcements.ts (which sits at its file-size ceiling). Mounted on the
// SAME prefix in src/index.ts, right after the main router, so the paths read
// as one API:
//
//   GET  /api/announcements/:id/files    — the attachment log (mig 20260907T0715)
//   POST /api/announcements/:id/submit   — DRAFT / REJECTED → PENDING_APPROVAL
//   POST /api/announcements/:id/approve  — PENDING_APPROVAL → APPROVED (+ ref no)
//   POST /api/announcements/:id/reject   — PENDING_APPROVAL → REJECTED, { reason }
//   POST /api/announcements/:id/void     — any submitted notice → voided, { reason }
//                                          (mig 20260907T1030; DELETE is drafts only)
//
// The transitions live in services/announcementApproval.ts; the policy and
// the log in services/announcementFiles.ts; the row helpers (scoped lookup,
// the Sales Director rule, the public shape) are the main router's, imported
// here so the two files can never disagree about them.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission, requirePermissionOrSalesDirector } from "../middleware/auth";
import { hasPermission } from "../services/permissions";
import {
  ApprovalError,
  APPROVE_PERMISSION,
  approveAnnouncement,
  rejectAnnouncement,
  submitForApproval,
  voidAnnouncement,
} from "../services/announcementApproval";
import {
  ATTACHMENT_REQUIRED_MESSAGE,
  attachmentRequiredForAnnouncements,
  listAttachmentLog,
} from "../services/announcementFiles";
import {
  actorOf,
  getScopedAnnouncement,
  normalizeAttachments,
  salesDirectorScope,
  sdBlockedFromRow,
  toPublic,
} from "./announcements";

const app = new Hono<{ Bindings: Env }>();

async function answerTransition(
  c: { env: Env; get: (k: string) => unknown; json: (b: unknown, s?: number) => Response },
  id: string,
  run: () => Promise<unknown>,
): Promise<Response> {
  try {
    await run();
  } catch (e) {
    if (e instanceof ApprovalError) return c.json({ success: false, error: e.message }, e.status);
    throw e;
  }
  const fresh = await getScopedAnnouncement(c, id);
  return c.json({ success: true, data: fresh ? toPublic(fresh) : null });
}

// GET /:id/files — the attachment log (mig 20260907T0715): who attached /
// removed which file and when. For the people who manage or approve the
// notice (a Sales Director on their own post); readers get the manifest only.
app.get("/:id/files", async (c) => {
  const user = c.get("user");
  const granted = user.permissions_set;
  const sd = salesDirectorScope(c);
  const allowed =
    hasPermission(granted, "*") ||
    hasPermission(granted, "announcements.write") ||
    hasPermission(granted, APPROVE_PERMISSION) ||
    sd.restricted;
  if (!allowed) return c.json({ success: false, error: "You don't have permission to do that." }, 403);
  const id = c.req.param("id");
  const existing = await getScopedAnnouncement(c, id);
  if (!existing || sdBlockedFromRow(sd, existing, user.id)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  return c.json({ success: true, data: await listAttachmentLog(c.env, id) });
});

app.post("/:id/submit", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const existing = await getScopedAnnouncement(c, id);
  if (!existing) return c.json({ success: false, error: "Announcement not found" }, 404);
  const user = c.get("user");
  if (sdBlockedFromRow(salesDirectorScope(c), existing, user.id)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  if (
    normalizeAttachments(existing.attachments ?? null).length === 0 &&
    (await attachmentRequiredForAnnouncements(c.env))
  ) {
    return c.json({ success: false, error: ATTACHMENT_REQUIRED_MESSAGE }, 400);
  }
  return answerTransition(c, id, () => submitForApproval(c.env, existing, actorOf(user)));
});

app.post("/:id/approve", requirePermission(APPROVE_PERMISSION), async (c) => {
  const id = c.req.param("id");
  const existing = await getScopedAnnouncement(c, id);
  if (!existing) return c.json({ success: false, error: "Announcement not found" }, 404);
  return answerTransition(c, id, () => approveAnnouncement(c.env, existing, actorOf(c.get("user"))));
});

// Void — the poster's door (write, or a Sales Director on their own post),
// the same people who could delete before mig 20260907T1030 took that away.
app.post("/:id/void", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const existing = await getScopedAnnouncement(c, id);
  if (!existing) return c.json({ success: false, error: "Announcement not found" }, 404);
  const user = c.get("user");
  if (sdBlockedFromRow(salesDirectorScope(c), existing, user.id)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  return answerTransition(c, id, () =>
    voidAnnouncement(c.env, existing, actorOf(user), String(body.reason ?? "")),
  );
});

app.post("/:id/reject", requirePermission(APPROVE_PERMISSION), async (c) => {
  const id = c.req.param("id");
  const existing = await getScopedAnnouncement(c, id);
  if (!existing) return c.json({ success: false, error: "Announcement not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  return answerTransition(c, id, () =>
    rejectAnnouncement(c.env, existing, actorOf(c.get("user")), String(body.reason ?? "")),
  );
});

export default app;
