import { useEffect, useRef } from "react";
import { useNotifications, useNotificationsTick, type NotificationItem } from "../hooks/useNotifications";
import {
  HOUZS_COMPANY_CODE,
  getBrandingCache,
  getBrandingCompanyCode,
  shortCompanyName,
} from "../lib/branding";
import { isBrowserPushEnabled } from "../lib/browserNotificationPreference";

/**
 * Invisible component mounted near the root. Watches the shared
 * notifications feed; when a new item appears and the user has
 * opted in to browser push, fires a native Notification() banner.
 * Seeds its seen-set from the current feed on first mount so you
 * don't get spammed with a backlog when first enabling the toggle.
 */
export function BrowserPushSink() {
  const { feed } = useNotifications();
  const lastTick = useNotificationsTick();
  const seenRef = useRef<Set<number>>(new Set());
  const primedRef = useRef(false);

  useEffect(() => {
    if (!primedRef.current && lastTick > 0) {
      primedRef.current = true;
      for (const item of feed) seenRef.current.add(item.id);
      return;
    }
    if (!isBrowserPushEnabled()) {
      for (const item of feed) seenRef.current.add(item.id);
      return;
    }
    for (const item of feed) {
      if (seenRef.current.has(item.id)) continue;
      seenRef.current.add(item.id);
      fireNotification(item);
    }
  }, [lastTick, feed]);

  return null;
}

function fireNotification(a: NotificationItem) {
  try {
    const title =
      a.project_name ||
      (getBrandingCompanyCode() === HOUZS_COMPANY_CODE
        ? "Houzs ERP"
        : `${shortCompanyName(getBrandingCache().companyName)} ERP`);
    const body = summarise(a);
    const tag = `houzs-${a.project_id}-${a.id}`;
    const n = new Notification(title, {
      body,
      tag,
      icon: "/logo-mark.png",
    });
    n.onclick = () => {
      window.focus();
      if (a.project_id) {
        window.location.href = `/projects/${a.project_id}`;
      }
      n.close();
    };
  } catch {
  }
}

function summarise(a: NotificationItem): string {
  const who = a.user_name ? `${a.user_name}: ` : "";
  switch (a.action) {
    case "note":
      return `${who}${a.note || "…"}`;
    case "stage_change":
      return `${who}Stage ${a.from_value || "?"} → ${a.to_value || "?"}`;
    case "created":
      return `${who}Created the project`;
    case "checklist_status":
      return `${who}${a.note || "Updated checklist"}`;
    case "finance_edit":
      return `${who}Updated finance`;
    default:
      return `${who}${a.action}${a.note ? ` · ${a.note}` : ""}`;
  }
}
