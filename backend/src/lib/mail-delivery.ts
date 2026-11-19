import type { Env } from "../types";
import { postPersonalNotice } from "../services/personalNotice";
import { fetchResendEmail } from "./mail-threading";

export type DeliveryStatus = "queued" | "failed" | "delivered" | "opened" | "bounced" | null;

const DELIVERY_WINDOW_MILLISECONDS = 3 * 86_400_000;
export const DELIVERY_REFRESH_LIMIT = 20;
const OPENED_EVENTS = ["opened", "clicked"];
const DELIVERED_EVENTS = ["delivered", "complained"];
const NOT_SENT_EVENTS = ["failed", "canceled"];
export const FINAL_DELIVERY_EVENTS = [...OPENED_EVENTS, ...NOT_SENT_EVENTS, "complained", "bounced"];

export function deliveryStatus(outboxStatus: string | null, providerEvent: string | null): DeliveryStatus {
  if (outboxStatus === "pending") return "queued";
  if (outboxStatus === "failed") return "failed";
  if (providerEvent === "bounced") return "bounced";
  if (providerEvent && NOT_SENT_EVENTS.includes(providerEvent)) return "failed";
  if (providerEvent && OPENED_EVENTS.includes(providerEvent)) return "opened";
  if (providerEvent && DELIVERED_EVENTS.includes(providerEvent)) return "delivered";
  return null;
}

interface PendingDeliveryRow {
  id: string;
  provider_id: string;
  subject: string | null;
  to_addresses: string | null;
  sent_by_user_id: number | null;
  delivery_status: string | null;
}

export interface DeliveryRefreshRun {
  checked: number;
  changed: number;
  bounced: number;
  unreachable: number;
}

function recipientsOf(toAddresses: string | null): string {
  try {
    const parsed: unknown = JSON.parse(toAddresses ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String).join(", ") : "";
  } catch {
    return "";
  }
}

async function noticeBounce(env: Env, row: PendingDeliveryRow): Promise<void> {
  const subject = (row.subject ?? "").trim() || "(no subject)";
  const recipients = recipientsOf(row.to_addresses);
  await postPersonalNotice(env, {
    userIds: [row.sent_by_user_id],
    category: "WARNING",
    title: `Email bounced: ${subject}`,
    body: `Your email${recipients ? ` to ${recipients}` : ""} could not be delivered. Check the address in Mail Center and send it again.`,
    source: "mail_bounce",
  });
}

export async function refreshOutboundDelivery(
  db: D1Database,
  env: Env,
  limit: number,
  now: number,
): Promise<DeliveryRefreshRun> {
  const run: DeliveryRefreshRun = { checked: 0, changed: 0, bounced: 0, unreachable: 0 };
  const finalPlaceholders = FINAL_DELIVERY_EVENTS.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT m.id, COALESCE(m.provider_message_id, o.provider_id) AS provider_id,
              m.subject, m.to_addresses, m.sent_by_user_id, m.delivery_status
         FROM email_messages m
         LEFT JOIN email_outbox o ON o.id = m.outbox_id
        WHERE m.direction = 'outbound' AND m.created_at >= ?
          AND COALESCE(m.provider_message_id, o.provider_id) IS NOT NULL
          AND (m.delivery_status IS NULL OR m.delivery_status NOT IN (${finalPlaceholders}))
        ORDER BY m.delivery_status_at ASC NULLS FIRST, m.created_at DESC LIMIT ?`,
    )
    .bind(new Date(now - DELIVERY_WINDOW_MILLISECONDS).toISOString(), ...FINAL_DELIVERY_EVENTS, limit)
    .all<PendingDeliveryRow>();
  const askedAt = new Date(now).toISOString();
  for (const row of rows.results) {
    run.checked++;
    const state = await fetchResendEmail(env, row.provider_id);
    const lastEvent = state?.lastEvent ?? row.delivery_status;
    await db
      .prepare(
        `UPDATE email_messages
            SET delivery_status = ?, delivery_status_at = ?,
                message_id = COALESCE(message_id, ?), provider_message_id = COALESCE(provider_message_id, ?)
          WHERE id = ?`,
      )
      .bind(lastEvent, askedAt, state?.messageId ?? null, row.provider_id, row.id)
      .run();
    if (!state?.lastEvent) {
      run.unreachable++;
      continue;
    }
    if (state.lastEvent === row.delivery_status) continue;
    run.changed++;
    if (state.lastEvent === "bounced") {
      run.bounced++;
      await noticeBounce(env, row);
    }
  }
  return run;
}
