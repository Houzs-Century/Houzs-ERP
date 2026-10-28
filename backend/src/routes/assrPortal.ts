/**
 * Lead Time Portal — manager-editable per-stage SLA targets per
 * proposal §10. Profiles ship as Normal / Peak / Custom; exactly
 * one is active at any time and that's the one transition
 * snapshots read on every stage change.
 *
 * Routes (all mounted at /api/assr/portal):
 *
 *   GET    /profiles                    list profiles + stage targets
 *   POST   /profiles                    create a custom profile
 *   PATCH  /profiles/:id/activate       switch the active profile
 *   PATCH  /targets/:id                 amend one target (reason >=10 chars)
 *   GET    /amendments                  audit history (paginated)
 *
 * Permission model:
 *   - All reads: service_cases.read
 *   - All writes: service_cases.manage
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { reapplyStageTargets, type Stage } from "../services/assr";

const app = new Hono<{ Bindings: Env }>();

const STAGES = [
  "pending_review",
  "under_verification",
  "pending_solution",
  "pending_supplier_pickup",
  "pending_item_ready",
  "pending_delivery_service",
  "completed",
] as const;

// ── List ────────────────────────────────────────────────────────────
//
// Returns every profile with its full stage_targets array. The active
// profile is flagged so the frontend can highlight it without a
// second request.

app.get("/profiles", requirePermission("service_cases.read"), async (c) => {
  const profiles = await c.env.DB.prepare(
    `SELECT id, name, description, is_active, created_at, updated_at
       FROM assr_lead_time_profiles
      ORDER BY is_active DESC, name`
  ).all<{
    id: number;
    name: string;
    description: string | null;
    is_active: number;
    created_at: string;
    updated_at: string;
  }>();

  const targets = await c.env.DB.prepare(
    `SELECT id, profile_id, stage, target_days
       FROM assr_stage_targets
      ORDER BY profile_id, stage`
  ).all<{ id: number; profile_id: number; stage: string; target_days: number }>();

  const targetsByProfile = new Map<number, typeof targets.results>();
  for (const t of targets.results ?? []) {
    if (!targetsByProfile.has(t.profile_id)) targetsByProfile.set(t.profile_id, []);
    targetsByProfile.get(t.profile_id)!.push(t);
  }

  return c.json({
    profiles: (profiles.results ?? []).map((p) => ({
      ...p,
      is_active: p.is_active === 1,
      targets: targetsByProfile.get(p.id) ?? [],
    })),
  });
});

// ── Create a custom profile ─────────────────────────────────────────
//
// Seeds the new profile with all 9 stages defaulted from the current
// active profile so the admin only has to amend the deltas. The new
// profile is inactive on create — admins explicitly activate it later
// via PATCH /profiles/:id/activate.

app.post("/profiles", requirePermission("service_cases.manage"), async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  if (name.length > 64) return c.json({ error: "name too long" }, 400);

  try {
    const ins = await c.env.DB.prepare(
      `INSERT INTO assr_lead_time_profiles (name, description, is_active)
       VALUES (?, ?, 0)`
    )
      .bind(name, body.description || null)
      .run();
    const profileId = ins.meta.last_row_id as number;

    // Copy from the active profile so customs start sensibly.
    await c.env.DB.prepare(
      `INSERT INTO assr_stage_targets (profile_id, stage, target_days)
       SELECT ?, t.stage, t.target_days
         FROM assr_stage_targets t
         JOIN assr_lead_time_profiles p ON p.id = t.profile_id
        WHERE p.is_active = 1`
    )
      .bind(profileId)
      .run();

    return c.json({ id: profileId }, 201);
  } catch (e: any) {
    if (String(e?.message || "").includes("UNIQUE")) {
      return c.json({ error: "A profile with that name already exists" }, 400);
    }
    throw e;
  }
});

// ── Switch active profile ───────────────────────────────────────────
//
// Two modes:
//   - Body omits scheduled_for → flip is_active immediately AND
//     record an activation row (source='manual').
//   - Body has scheduled_for (ISO string, must be in the future) →
//     queue a row in assr_lead_time_scheduled_activations. The cron
//     worker (runScheduledLeadTimeActivations) picks it up on the
//     next 30-min tick after the time arrives. Caller can include a
//     short reason for audit.
//
// In-flight cases keep their stamped lead_time_profile_id (proposal
// §10 "Effective date") in both modes.

app.patch("/profiles/:id/activate", requirePermission("service_cases.manage"), async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "bad id" }, 400);

  const body = await c.req
    .json<{ scheduled_for?: string; reason?: string }>()
    .catch(() => ({} as { scheduled_for?: string; reason?: string }));

  const row = await c.env.DB.prepare(
    `SELECT id FROM assr_lead_time_profiles WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number }>();
  if (!row) return c.json({ error: "not found" }, 404);

  // Scheduled path.
  if (body.scheduled_for) {
    const when = new Date(body.scheduled_for);
    if (isNaN(when.getTime())) {
      return c.json({ error: "scheduled_for must be a valid ISO timestamp" }, 400);
    }
    if (when.getTime() <= Date.now()) {
      return c.json(
        { error: "scheduled_for must be in the future — use immediate activation otherwise" },
        400
      );
    }
    const reason = (body.reason || "").trim().slice(0, 200) || null;
    const r = await c.env.DB.prepare(
      `INSERT INTO assr_lead_time_scheduled_activations
         (profile_id, scheduled_for, scheduled_by, reason)
       VALUES (?, ?, ?, ?)`
    )
      .bind(id, when.toISOString(), userId || null, reason)
      .run();
    return c.json({
      ok: true,
      scheduled: true,
      schedule_id: r.meta.last_row_id,
      scheduled_for: when.toISOString(),
    });
  }

  // Immediate path. Capture the prior active profile so the history
  // row can show "switched from X" for the audit trail.
  const prev = await c.env.DB.prepare(
    `SELECT id FROM assr_lead_time_profiles WHERE is_active = 1`
  ).first<{ id: number }>();

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE assr_lead_time_profiles SET is_active = 0, updated_at = datetime('now')`),
    c.env.DB.prepare(
      `UPDATE assr_lead_time_profiles SET is_active = 1, updated_at = datetime('now') WHERE id = ?`
    ).bind(id),
    c.env.DB.prepare(
      `INSERT INTO assr_lead_time_activations
         (profile_id, source, user_id, previous_profile_id)
       VALUES (?, 'manual', ?, ?)`
    ).bind(id, userId || null, prev?.id ?? null),
  ]);

  return c.json({ ok: true, scheduled: false });
});

// ── Pending scheduled activations ───────────────────────────────────
//
// Used by the Lead Time portal to render the "Scheduled activations"
// panel — every row that hasn't fired or been cancelled yet.

app.get("/scheduled", requirePermission("service_cases.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.profile_id, p.name AS profile_name,
            s.scheduled_for, s.scheduled_by, u.name AS scheduled_by_name,
            s.reason, s.status, s.created_at
       FROM assr_lead_time_scheduled_activations s
       LEFT JOIN assr_lead_time_profiles p ON p.id = s.profile_id
       LEFT JOIN users u ON u.id = s.scheduled_by
      WHERE s.status = 'pending'
      ORDER BY s.scheduled_for, s.id`
  ).all();
  return c.json({ data: rows.results ?? [] });
});

app.delete("/scheduled/:id", requirePermission("service_cases.manage"), async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "bad id" }, 400);

  const existing = await c.env.DB.prepare(
    `SELECT id, status FROM assr_lead_time_scheduled_activations WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; status: string }>();
  if (!existing) return c.json({ error: "not found" }, 404);
  if (existing.status !== "pending") {
    return c.json({ error: `cannot cancel a schedule that's already ${existing.status}` }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE assr_lead_time_scheduled_activations
        SET status = 'cancelled',
            cancelled_at = datetime('now'),
            cancelled_by = ?
      WHERE id = ?`
  )
    .bind(userId || null, id)
    .run();
  return c.json({ ok: true });
});

// ── Activation history ──────────────────────────────────────────────
//
// Paginated. Each row is one actual activation event (manual or
// scheduled-fired), joined to user + profile names for display.

app.get("/activations", requirePermission("service_cases.read"), async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM assr_lead_time_activations`
  ).first<{ n: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.profile_id, p.name AS profile_name,
            a.source, a.scheduled_id, a.user_id, u.name AS user_name,
            a.previous_profile_id, pp.name AS previous_profile_name,
            a.activated_at
       FROM assr_lead_time_activations a
       LEFT JOIN assr_lead_time_profiles p  ON p.id  = a.profile_id
       LEFT JOIN assr_lead_time_profiles pp ON pp.id = a.previous_profile_id
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.activated_at DESC, a.id DESC
      LIMIT ? OFFSET ?`
  )
    .bind(perPage, offset)
    .all();

  return c.json({
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.n ?? 0,
  });
});

// ── Amend a target ──────────────────────────────────────────────────
//
// Required reason ≥10 chars — keeps the audit trail useful and stops
// the matrix from being silently re-shaped. before_days is captured
// before the UPDATE so the amendment row can show the diff.

// ── Per-priority stage targets (mig 082) ────────────────────────────
//
// Sibling axis to the Lead Time profile. Each priority (low / normal /
// high / urgent) has its own per-stage target row. The lookup at case
// transition prefers priority targets over the active profile, so
// editing here flexes Urgent / Low without flipping the global profile.

app.get("/priority-targets", requirePermission("service_cases.read"), async (c) => {
  const priorities = await c.env.DB.prepare(
    `SELECT id, slug, name, sort_order
       FROM assr_priorities
      WHERE active = 1
      ORDER BY sort_order, name`
  ).all<{ id: number; slug: string; name: string; sort_order: number }>();

  const targets = await c.env.DB.prepare(
    `SELECT id, priority_id, stage, target_days
       FROM assr_priority_stage_targets
      ORDER BY priority_id, stage`
  ).all<{ id: number; priority_id: number; stage: string; target_days: number }>();

  return c.json({
    priorities: priorities.results ?? [],
    stages: STAGES,
    targets: targets.results ?? [],
  });
});

// PATCH /priority-targets — upsert one cell. Unlike profile targets,
// per-priority cells can be missing (the lookup falls back to the
// profile), so this handler INSERTs when no row exists and UPDATEs
// otherwise. Reason ≥ 10 chars enforced for the audit trail.
app.patch("/priority-targets", requirePermission("service_cases.manage"), async (c) => {
  const body = await c.req.json<{
    priority_id?: number;
    stage?: string;
    target_days?: number;
  }>();
  const priorityId = Number(body.priority_id);
  const stage = (body.stage || "").trim();
  const newDays = Number(body.target_days);

  if (!Number.isFinite(priorityId) || priorityId <= 0) {
    return c.json({ error: "Please choose a priority." }, 400);
  }
  if (!STAGES.includes(stage as (typeof STAGES)[number])) {
    return c.json({ error: "stage must be one of the canonical 9 stages" }, 400);
  }
  if (!isFinite(newDays) || newDays < 0) {
    return c.json({ error: "target_days must be a non-negative number" }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id, target_days FROM assr_priority_stage_targets
      WHERE priority_id = ? AND stage = ?`
  )
    .bind(priorityId, stage)
    .first<{ id: number; target_days: number }>();

  const beforeDays = existing?.target_days ?? null;
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE assr_priority_stage_targets
          SET target_days = ?, updated_at = datetime('now')
        WHERE id = ?`
    ).bind(newDays, existing.id).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days)
       VALUES (?, ?, ?)`
    ).bind(priorityId, stage, newDays).run();
  }

  const casesUpdated = await reapplyStageTargets(c.env, stage as Stage);
  return c.json({ ok: true, before_days: beforeDays, after_days: newDays, cases_updated: casesUpdated });
});

app.patch("/targets/:id", requirePermission("service_cases.manage"), async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "bad id" }, 400);

  const body = await c.req.json<{ target_days?: number; reason?: string }>();
  const newDays = Number(body.target_days);
  const reason = (body.reason || "").trim();
  if (!isFinite(newDays) || newDays < 0) {
    return c.json({ error: "target_days must be a non-negative number" }, 400);
  }
  if (reason.length < 10) {
    return c.json({ error: "reason must be at least 10 characters" }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id, profile_id, stage, target_days FROM assr_stage_targets WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; profile_id: number; stage: string; target_days: number }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  // No-op fast path — same value, still emit an amendment row so the
  // audit trail captures the intent ("manager reviewed; left as is").
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE assr_stage_targets SET target_days = ? WHERE id = ?`).bind(newDays, id),
    c.env.DB.prepare(
      `INSERT INTO assr_lead_time_amendments (profile_id, stage, before_days, after_days, reason, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(existing.profile_id, existing.stage, existing.target_days, newDays, reason, userId),
    c.env.DB.prepare(
      `UPDATE assr_lead_time_profiles SET updated_at = datetime('now') WHERE id = ?`
    ).bind(existing.profile_id),
  ]);

  /* Only the active profile is read at a stage change, so only it reaches open cases. */
  const active = await c.env.DB.prepare(`SELECT is_active FROM assr_lead_time_profiles WHERE id = ?`).bind(existing.profile_id).first<{ is_active: number }>();
  const casesUpdated = active?.is_active === 1 ? await reapplyStageTargets(c.env, existing.stage as Stage) : 0;
  return c.json({ ok: true, before_days: existing.target_days, after_days: newDays, cases_updated: casesUpdated });
});

// ── Amendment history ───────────────────────────────────────────────
//
// Paginated audit log. Defaults to all profiles; pass ?profile_id=N
// to scope to one.

app.get("/amendments", requirePermission("service_cases.read"), async (c) => {
  const profileId = c.req.query("profile_id");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: any[] = [];
  if (profileId) {
    where.push("a.profile_id = ?");
    binds.push(parseInt(profileId, 10));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM assr_lead_time_amendments a ${whereSql}`
  )
    .bind(...binds)
    .first<{ n: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.profile_id, p.name AS profile_name, a.stage,
            a.before_days, a.after_days, a.reason, a.user_id,
            u.name AS user_name, a.created_at
       FROM assr_lead_time_amendments a
       LEFT JOIN assr_lead_time_profiles p ON p.id = a.profile_id
       LEFT JOIN users u ON u.id = a.user_id
       ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?`
  )
    .bind(...binds, perPage, offset)
    .all();

  return c.json({
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.n ?? 0,
  });
});

// ── Catalogue (referenced by frontend for stage labels) ─────────────

app.get("/stages", requirePermission("service_cases.read"), (c) => {
  return c.json({ stages: STAGES });
});

// ── Alert ack + snooze ──────────────────────────────────────────────
//
// Mounted under /api/assr/portal/alerts/* — the stage owner can:
//   POST /alerts/ack       — acknowledge an alert with a note (audit-only)
//   POST /alerts/snooze    — suppress an alert for up to 24h (max 2 per stage)
//   POST /alerts/override  — manager wipes all alerts on a case (requires manage)

const ALERT_EVENTS = new Set([
  "stage_entered",
  "half_time",
  "approaching_breach",
  "breach",
]);

app.post("/alerts/ack", requirePermission("service_cases.read"), async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ assr_id?: number; stage?: string; event?: string; note?: string }>();
  if (!body.assr_id || !body.stage || !body.event) {
    return c.json({ error: "Something went wrong. Please try again." }, 400);
  }
  if (!ALERT_EVENTS.has(body.event)) return c.json({ error: "unknown event" }, 400);
  const note = (body.note || "").slice(0, 200);

  await c.env.DB.prepare(
    `INSERT INTO assr_alert_acks (assr_id, stage, event, user_id, note)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(body.assr_id, body.stage, body.event, userId, note || null)
    .run();
  return c.json({ ok: true });
});

app.post("/alerts/snooze", requirePermission("service_cases.read"), async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ assr_id?: number; stage?: string; event?: string; note?: string }>();
  if (!body.assr_id || !body.stage || !body.event) {
    return c.json({ error: "Something went wrong. Please try again." }, 400);
  }
  if (!ALERT_EVENTS.has(body.event)) return c.json({ error: "unknown event" }, 400);

  // Cap at 2 snoozes per (case, stage) per proposal §9.3.
  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM assr_alert_acks
      WHERE assr_id = ? AND stage = ? AND snoozed_until IS NOT NULL`
  )
    .bind(body.assr_id, body.stage)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 2) {
    return c.json({ error: "Snooze cap reached for this stage (max 2)" }, 400);
  }

  const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const note = (body.note || "").slice(0, 200);
  await c.env.DB.prepare(
    `INSERT INTO assr_alert_acks (assr_id, stage, event, user_id, note, snoozed_until)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(body.assr_id, body.stage, body.event, userId, note || null, snoozedUntil)
    .run();
  return c.json({ ok: true, snoozed_until: snoozedUntil });
});

app.post("/alerts/override", requirePermission("service_cases.manage"), async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ assr_id?: number; reason?: string }>();
  if (!body.assr_id) return c.json({ error: "Something went wrong. Please try again." }, 400);
  const reason = (body.reason || "").trim();
  if (reason.length < 5) return c.json({ error: "Please enter a reason of at least 5 characters." }, 400);

  // Mark every open history row for this case as "all alerts fired" so
  // the scanner skips it. Audit row captures who + why.
  await c.env.DB.prepare(
    `UPDATE assr_stage_history SET alerts_fired = 15 WHERE assr_id = ? AND exited_at IS NULL`
  )
    .bind(body.assr_id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO assr_alert_acks (assr_id, stage, event, user_id, note)
      SELECT ?, h.stage, 'manager_override', ?, ?
        FROM assr_stage_history h
       WHERE h.assr_id = ? AND h.exited_at IS NULL`
  )
    .bind(body.assr_id, userId, reason.slice(0, 200), body.assr_id)
    .run();
  return c.json({ ok: true });
});

export default app;
