import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { getAllEmailSettings, setSetting } from "../services/email";
import { audit } from "../services/audit";

const app = new Hono<{ Bindings: Env }>();

// ── Email channel toggles ────────────────────────────────────

app.get("/email", requirePermission("settings.manage"), async (c) => {
  const settings = await getAllEmailSettings(c.env);
  const hasKey = !!c.env.RESEND_API_KEY;
  return c.json({
    settings,
    has_api_key: hasKey,
    from: c.env.EMAIL_FROM || null,
    public_url: c.env.PUBLIC_APP_URL || null,
  });
});

app.patch("/email", requirePermission("settings.manage"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<Record<string, boolean>>();
  const ALLOWED = new Set([
    "email.enabled",
    "email.assr_survey",
    "email.assr_sla_escalation",
    "email.member_invite",
    "email.supplier_invite",
    "email.project_due_reminder",
    "email.password_reset",
    "email.delivery_order",
    "email.invoice",
    "email.document_report",
  ]);
  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED.has(k)) continue;
    if (typeof v !== "boolean") continue;
    await setSetting(c.env, k, { value: v }, user?.id ?? null);
    // Audit channel flips (esp. customer-facing) — tamper-evident WHO/WHAT/WHEN.
    await audit(c, {
      action: "settings.email_channel",
      entityType: "app_setting",
      entityId: k,
      summary: `${k} set to ${v ? "on" : "off"}`,
      meta: { key: k, value: v },
    });
  }
  const settings = await getAllEmailSettings(c.env);
  return c.json({ settings });
});

// ── Recent email log ─────────────────────────────────────────

app.get("/email/log", requirePermission("settings.manage"), async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
  const purpose = c.req.query("purpose");
  const status = c.req.query("status");
  const where: string[] = [];
  const binds: any[] = [];
  if (purpose) {
    where.push("purpose = ?");
    binds.push(purpose);
  }
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await c.env.DB.prepare(
    `SELECT id, purpose, ref_type, ref_id, to_addr, subject,
            status, provider_id, error, created_at
       FROM email_log
       ${whereSql}
      ORDER BY id DESC
      LIMIT ?`
  )
    .bind(...binds, limit)
    .all();
  return c.json({ data: rows.results ?? [] });
});

// ── Manual test send ─────────────────────────────────────────
// Lets an admin verify Resend setup without waiting for a real event.

app.post("/email/test", requirePermission("settings.manage"), async (c) => {
  const body = await c.req.json<{ to?: string }>();
  const to = (body.to || "").trim();
  if (!to || !to.includes("@")) return c.json({ error: "Valid 'to' required" }, 400);
  const { sendEmail } = await import("../services/email");
  const result = await sendEmail(c.env, {
    to,
    subject: "Houzs ERP — email test",
    html: `<p>This is a test email from Houzs ERP at ${new Date().toISOString()}.</p>
           <p>If you're reading this, Resend is wired up correctly.</p>`,
    purpose: "generic",
  });
  return c.json(result);
});

export default app;
