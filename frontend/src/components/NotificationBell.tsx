import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { cn, relativeTime } from "../lib/utils";
import { useNotifications, type NotificationItem } from "../hooks/useNotifications";
import { Avatar } from "./Avatar";

interface Props {
  collapsed: boolean;
  /** Where the popover should appear relative to the bell button.
   *  "down" anchors the popover below the button (top navbar usage);
   *  "up" anchors it above (sidebar usage, where the bell sits near
   *  the bottom of the screen). Defaults to "down". */
  direction?: "up" | "down";
  /** Horizontal edge the popover aligns to. "end" is the right side
   *  of the button (top-navbar — prevents overflow off the right edge
   *  of the viewport). Defaults to "start". */
  align?: "start" | "end";
  /** Button palette. "sidebar" (default) keeps the dark-slab colours the
   *  sidebar has always used; "navbar" is the light top-chrome variant
   *  (2b redesign): ink icon on a quiet surface-2 hover. */
  tone?: "sidebar" | "navbar";
  /** Unread affordance. "count" (default) renders the numeric pill;
   *  "dot" renders the 2b red presence-style dot — the popover still
   *  carries the numbers, the chrome stays quiet. */
  unread?: "count" | "dot";
}

/**
 * Notification bell + popover. Click opens a list of the latest
 * activity on the user's projects. Visible count is the per-project
 * unread aggregate, capped at 99+. Polls itself via the shared
 * NotificationsProvider — this component is display-only.
 */
export function NotificationBell({
  collapsed,
  direction = "down",
  align = "start",
  tone = "sidebar",
  unread = "count",
}: Props) {
  const { feed, totalUnread } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const countLabel = totalUnread > 99 ? "99+" : String(totalUnread);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${totalUnread ? ` · ${countLabel} unread` : ""}`}
        title="Notifications"
        className={cn(
          "relative inline-flex items-center rounded-md transition-colors",
          // Navbar tone: the same boxed tile as PresenceButton (owner
          // 2026-07-27, "通知button要和who online button UI 一样") — bordered
          // rest state, petrol-soft when its popover is open.
          tone === "navbar"
            ? open
              ? "border border-primary bg-primary-soft text-primary-ink focus:outline-none focus:ring-2 focus:ring-primary/40"
              : "border border-border bg-surface text-ink-secondary hover:border-border-strong hover:bg-surface-dim focus:outline-none focus:ring-2 focus:ring-primary/40"
            : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-accent",
          collapsed ? "h-9 w-9 justify-center" : "h-9 w-full gap-2 px-3"
        )}
      >
        <Bell size={16} />
        {!collapsed && (
          <span className="flex-1 text-left text-[12px] font-medium">
            Notifications
          </span>
        )}
        {totalUnread > 0 &&
          (unread === "dot" ? (
            // 2b: a quiet presence-style dot — the count lives in the
            // aria-label and the popover, not the chrome.
            <span className="absolute right-1.5 top-1.5 h-[7px] w-[7px] rounded-full bg-err ring-[1.5px] ring-surface" />
          ) : (
            <span
              className={cn(
                "flex items-center justify-center rounded-full bg-err font-mono text-[9px] font-bold text-white shadow-sm",
                collapsed
                  ? "absolute right-1.5 top-1.5 h-4 min-w-[16px] px-1"
                  : "h-4 min-w-[18px] px-1"
              )}
            >
              {countLabel}
            </span>
          ))}
      </button>

      {open && (
        <BellPopover
          feed={feed}
          onNavigate={() => setOpen(false)}
          direction={direction}
          align={align}
        />
      )}
    </div>
  );
}

function BellPopover({
  feed,
  onNavigate,
  direction,
  align,
}: {
  feed: NotificationItem[];
  onNavigate: () => void;
  direction: "up" | "down";
  align: "start" | "end";
}) {
  return (
    <div
      className={cn(
        "absolute z-40 w-[320px] overflow-hidden rounded-md border border-border bg-surface shadow-slab",
        "max-h-[70vh] flex flex-col",
        direction === "down" ? "top-full mt-2" : "bottom-full mb-2",
        align === "end" ? "right-0" : "left-0"
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
          Unread
        </span>
        {feed.length > 0 && (
          <span className="font-mono text-[10px] text-ink-muted">
            {feed.length}
          </span>
        )}
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto">
        {feed.length === 0 ? (
          <div className="px-4 py-8 text-center text-[11px] text-ink-muted">
            Nothing new. You're caught up.
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {feed.map((item) => (
              <li key={item.id}>
                <Link
                  to={`/projects/${item.project_id}`}
                  onClick={onNavigate}
                  className="flex gap-2.5 px-3 py-2 transition-colors hover:bg-bg/50"
                >
                  <Avatar
                    userId={item.user_id}
                    hasImage={item.user_profile_pic_r2_key}
                    name={item.user_name}
                    email={item.user_email}
                    size={28}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[11.5px] font-semibold text-ink">
                        {item.project_name || "Project"}
                        {item.brand && (
                          <span className="ml-1.5 font-mono text-[9.5px] font-normal text-ink-muted">
                            {item.brand}
                          </span>
                        )}
                      </span>
                      <span
                        className="shrink-0 font-mono text-[9.5px] text-ink-muted"
                        title={item.created_at}
                      >
                        {relativeTime(item.created_at)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-ink-secondary">
                      {renderActivityLine(item)}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

    </div>
  );
}

/** One-line summary of an activity row. Mirrors the chat system-row
 *  copy, just flattened for the bell. */
function renderActivityLine(a: NotificationItem): string {
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
    case "checklist_add":
      return `${who}Added a checklist item`;
    case "checklist_remove":
      return `${who}Removed a checklist item`;
    case "finance_edit":
      return `${who}Updated finance`;
    case "archived":
      return `${who}Archived the project`;
    case "restored":
      return `${who}Restored the project`;
    default:
      return `${who}${a.action}${a.note ? ` · ${a.note}` : ""}`;
  }
}
