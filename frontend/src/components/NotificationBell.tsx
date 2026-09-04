import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, Megaphone } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { cn, relativeTime } from "../lib/utils";
import { useNotifications, type NotificationItem } from "../hooks/useNotifications";
import {
  ANNOUNCEMENT_FEED_KEY,
  announcementFeedKey,
  type BannerAnnouncement,
  type BannerResponse,
} from "./useAnnouncementBanner";
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
}

/**
 * Notification bell + popover. Click opens the machine-generated SYSTEM
 * notices (scan results, service-case assignments — the announcements feed's
 * bell slice) followed by the latest activity on the user's projects. Visible
 * count is system notices + the per-project unread aggregate, capped at 99+.
 * The project half polls via the shared NotificationsProvider; the system half
 * rides the announcements feed query below.
 *
 * The system section is the desktop home for machine notices (owner
 * 2026-08-08, "为什么一直有这个"): they used to ride the pop-up banner, where
 * a routine "New service case ASSR/…" card interrupted everyone it targeted —
 * and, under the two-skips-then-mandatory-ack rule (#1728), eventually refused
 * to leave. The phone's twin is the bell inside the Announcements screen; both
 * read the same ?scope=system slice and the same ack.
 */
export function NotificationBell({
  collapsed,
  direction = "down",
  align = "start",
  tone = "sidebar",
}: Props) {
  const { feed, totalUnread, loadFailed } = useNotifications();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // The BELL slice of the announcements feed: machine notices targeted at this
  // user (source NOT NULL — scan / service-case). Shares announcementFeedKey
  // with every other reader of this slice, so however many bells are mounted
  // (top navbar + the sidebar's mobile-drawer copy) it is fetched once. 30s,
  // the notifications cadence. Silent by design: a failed poll leaves `data`
  // undefined — an empty section, never an error state in the chrome.
  const { data: systemFeed } = useQuery({
    queryKey: announcementFeedKey("system"),
    queryFn: () =>
      api.get<BannerResponse>("/api/announcements/banner?scope=system"),
    // 3 min, not 30s: the bell is not real-time chat, and the backend caches the
    // banner per-user for 5 min, so this lands mostly on hits and cuts call volume.
    staleTime: 180_000,
    refetchInterval: 180_000,
    enabled: !!user?.id,
  });

  // Server acks + ids acked from THIS popover, so Mark read clears the row (and
  // the badge) instantly instead of a poll later — the mobile bell's localAcked
  // idiom. Session-lifetime only; the server ack is what persists.
  const [ackedHere, setAckedHere] = useState<Set<string>>(new Set());
  const systemNotices = useMemo(() => {
    const acked = new Set([...(systemFeed?.ackedIds ?? []), ...ackedHere]);
    return (systemFeed?.data ?? []).filter((a) => !acked.has(a.id));
  }, [systemFeed, ackedHere]);

  const markRead = useCallback(
    async (a: BannerAnnouncement) => {
      setAckedHere((prev) => new Set(prev).add(a.id));
      try {
        await api.post(`/api/announcements/${a.id}/ack`);
      } catch {
        // silent-write-ok: OPTIMISTIC WITH RECONCILE, deliberately. The local
        // hide stands for this session and the next poll re-surfaces the notice
        // if the server never got the ack, so the screen self-corrects rather
        // than trapping the reader behind a failing request. NOTE for whoever
        // revisits this: the publisher's read-receipt list is the record, and
        // it does NOT self-correct. Whether a compulsory notice should refuse
        // to dismiss on a failed ack is the owner's call, not this file's.
      }
      // Same invalidation the pop-up's ack performs — every consumer of the
      // feed namespace (mobile badge, mobile bell) drops the notice at once.
      void qc.invalidateQueries({ queryKey: ANNOUNCEMENT_FEED_KEY });
    },
    [qc],
  );

  const combinedUnread = totalUnread + systemNotices.length;

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

  const countLabel = combinedUnread > 99 ? "99+" : String(combinedUnread);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${combinedUnread ? ` · ${countLabel} unread` : ""}`}
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
        {/* Always the NUMBER. The top navbar carried a quiet 2b dot until
            2026-09-02, when amendment approvals started landing here: a dot
            tells you something arrived, a count tells you how much is waiting
            for your signature, and that difference is the reason the channel
            exists. Owner: "需要有红色号码 notice". */}
        {combinedUnread > 0 && (
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
        )}
      </button>

      {open && (
        <BellPopover
          feed={feed}
          loadFailed={loadFailed}
          systemNotices={systemNotices}
          onMarkRead={markRead}
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
  loadFailed,
  systemNotices,
  onMarkRead,
  onNavigate,
  direction,
  align,
}: {
  feed: NotificationItem[];
  loadFailed: boolean;
  systemNotices: BannerAnnouncement[];
  onMarkRead: (a: BannerAnnouncement) => void;
  onNavigate: () => void;
  direction: "up" | "down";
  align: "start" | "end";
}) {
  const total = systemNotices.length + feed.length;
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
        {total > 0 && (
          <span className="font-mono text-[10px] text-ink-muted">{total}</span>
        )}
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto">
        {/* System notices first — the actionable per-user machine notices
            (scan results, service-case assignments). No navigation target:
            the desktop Announcements page lists human posts only, so the row
            carries the full body and settles in place via Mark read (the same
            ack the mobile bell records). */}
        {systemNotices.length > 0 && (
          <div className="border-b border-border-subtle">
            <div className="px-3 pb-1 pt-2 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
              System notices
            </div>
            <ul className="divide-y divide-border-subtle">
              {systemNotices.map((a) => (
                <li key={a.id} className="flex gap-2.5 px-3 py-2">
                  <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <Megaphone size={13} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[11.5px] font-semibold text-ink">
                        {a.title}
                      </span>
                      {a.createdAt && (
                        <span
                          className="shrink-0 font-mono text-[9.5px] text-ink-muted"
                          title={a.createdAt}
                        >
                          {relativeTime(a.createdAt)}
                        </span>
                      )}
                    </div>
                    {a.body && (
                      <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[11px] text-ink-secondary">
                        {a.body}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => onMarkRead(a)}
                      className="mt-1 inline-flex items-center gap-1 text-[10.5px] font-semibold text-primary hover:underline"
                    >
                      <Check size={11} />
                      Mark read
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* THREE consumers read useNotifications(); TWO of them consulted
            `loadFailed` before rendering a reassuring empty state and this one
            did not — the same rule-at-N-call-sites-present-at-N-minus-1 shape
            the rest of this branch is about. The hook's own contract says
            consumers MUST consult it (hooks/useNotifications.tsx), because
            `feed: []` after a failed poll means "we don't know", not "there is
            nothing". This popover is the fastest surface in the app for
            deciding whether anything needs you, and on a failed poll it said
            you were caught up. */}
        {total === 0 && loadFailed ? (
          <div className="px-4 py-8 text-center text-[11px] text-ink-muted">
            <p className="font-semibold text-ink">We couldn't load your notifications.</p>
            <p className="mt-1">This is not the same as having none. Open Notifications to retry.</p>
          </div>
        ) : total === 0 ? (
          <div className="px-4 py-8 text-center text-[11px] text-ink-muted">
            Nothing new. You're caught up.
          </div>
        ) : feed.length === 0 ? null : (
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
