
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { push_devices, users, roles, positions } from "../db/schema";
import { getSupabaseService } from "../db/supabase";
import { computeFleetReminders } from "../scm/routes/fleet-maintenance";
import { COMPLIANCE_DOC_LABELS, type ComplianceDocType } from "./fleet-status";
import { hasPermission, parsePermissions } from "./permissions";
import { positionGrantsWildcard } from "./positionPolicy";
import { todayMyt } from "../scm/lib/my-time";
import { apnsConfigured, sendApnsAlert } from "./apns";

const nowUtcText = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export type PushReminderRunResult = {
  reason?: string;
  attempted: number;
  sent: number;
  failed: number;
  deadTokens: number;
};

export async function runPushFleetReminders(env: Env): Promise<PushReminderRunResult> {
  const none: PushReminderRunResult = { attempted: 0, sent: 0, failed: 0, deadTokens: 0 };
  if (!apnsConfigured(env)) return { ...none, reason: "apns_not_configured" };

  const today = todayMyt();
  const db = getDb(env);

  const candidates = await db
    .select({
      deviceId: push_devices.id,
      token: push_devices.token,
      lastSentOn: push_devices.last_reminder_sent_on,
      userStatus: users.status,
      rolePermissions: roles.permissions,
      positionName: positions.name,
    })
    .from(push_devices)
    .innerJoin(users, eq(users.id, push_devices.user_id))
    .innerJoin(roles, eq(roles.id, users.role_id))
    .leftJoin(positions, eq(positions.id, users.position_id))
    .where(isNull(push_devices.disabled_at));

  const due = candidates.filter(
    (d) =>
      d.lastSentOn !== today &&
      d.userStatus === "active" &&
      (hasPermission(parsePermissions(d.rolePermissions), "fleet.read") ||
        positionGrantsWildcard(d.positionName ?? null)),
  );
  if (due.length === 0) return { ...none, reason: "no_due_devices" };

  const r = await computeFleetReminders(getSupabaseService(env));
  if (!r.ok) return { ...none, reason: `reminders_failed: ${r.reason}` };
  if (r.reminders.length === 0) return { ...none, reason: "nothing_actionable" };

  const top = r.reminders[0];
  const label = COMPLIANCE_DOC_LABELS[top.docType as ComplianceDocType] ?? top.docType;
  const days = top.daysRemaining;
  const urgency =
    days == null
      ? "needs attention"
      : days < 0
        ? `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`
        : days === 0
          ? "expires today"
          : `expires in ${days} day${days === 1 ? "" : "s"}`;
  const alert = {
    title: "Fleet reminders",
    body: `${r.reminders.length} fleet item${r.reminders.length === 1 ? "" : "s"} need attention. Most urgent: ${top.plate} ${label} ${urgency}.`,
  };

  let sent = 0;
  let failed = 0;
  const deadIds: number[] = [];
  for (const d of due) {
    const res = await sendApnsAlert(env, d.token, alert, { threadId: "fleet-reminders" });
    if (res.ok) {
      sent++;
      await db
        .update(push_devices)
        .set({ last_reminder_sent_on: today })
        .where(eq(push_devices.id, d.deviceId));
    } else {
      failed++;
      if (res.tokenDead) deadIds.push(d.deviceId);
      else
        await db
          .update(push_devices)
          .set({ last_error: res.reason })
          .where(eq(push_devices.id, d.deviceId));
    }
  }
  if (deadIds.length) {
    await db
      .update(push_devices)
      .set({ disabled_at: nowUtcText(), last_error: "token_dead" })
      .where(and(inArray(push_devices.id, deadIds), isNull(push_devices.disabled_at)));
  }
  return { attempted: due.length, sent, failed, deadTokens: deadIds.length };
}
