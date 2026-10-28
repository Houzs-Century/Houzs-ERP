import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { cn } from "../lib/utils";
import { LazySlot } from "./LazySlot";
import { useNotifications } from "../hooks/useNotifications";
import {
  ANNOUNCEMENT_FEED_KEY,
  announcementFeedKey,
  useAnnouncementBanner,
  type BannerAnnouncement,
  type BannerResponse,
} from "./useAnnouncementBanner";
import { requiresAcknowledgement } from "./announcementCategory";

// Loaded on the first open, so the popover's code is not in the always-loaded shell.
const BellPopover = lazy(() => import("./NotificationBellPopover"));

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
 * Notification bell + popover — ONE unread entry point (design handoff
 * 2026-09-04, screen 6). Announcements and system notices live together, with
 * tabs to separate them:
 *
 *   · Announcements — the human feed (`/banner?scope=human`, the slice the
 *     modal and the inbox read, through the same hook). An unread row is one
 *     the reader has not acknowledged; a mandatory one carries an inline
 *     Acknowledge, the others a Mark read — both the same POST /:id/ack.
 *   · System — the machine notices (`?scope=system`: scan results,
 *     service-case assignments, amendment approvals, team escalations) plus
 *     the per-project activity feed from NotificationsProvider. Machine
 *     notices never pop a banner (owner 2026-08-08); this is their home.
 *
 * The badge is every unread across the three sources, capped at 99+.
 */
export function NotificationBell({
  collapsed,
  direction = "down",
  align = "start",
  tone = "sidebar",
}: Props) {
  const { feed, totalUnread, loadFailed, markAllRead } = useNotifications();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // The BELL slice of the announcements feed: machine notices targeted at this
  // user (source NOT NULL). Shares announcementFeedKey with every other reader
  // of this slice, so however many bells are mounted it is fetched once. 3 min:
  // the backend caches the banner per-user for 5 min. Silent by design: a
  // failed poll leaves `data` undefined — an empty section, never an error
  // state in the chrome.
  const { data: systemFeed } = useQuery({
    queryKey: announcementFeedKey("system"),
    queryFn: () =>
      api.get<BannerResponse>("/api/announcements/banner?scope=system"),
    staleTime: 180_000,
    refetchInterval: 180_000,
    enabled: !!user?.id,
  });

  // The HUMAN slice through the shared hook — same cache entry as the modal
  // and the inbox, same ack, same "have I seen this" answer.
  const human = useAnnouncementBanner({ scope: "human" });

  // Server acks + ids acked from THIS popover, so Mark read clears the row (and
  // the badge) instantly instead of a poll later. Session-lifetime only; the
  // server ack is what persists.
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

  const humanUnread = useMemo(
    () => human.notices.filter((a) => !human.ackedIds.has(a.id)),
    [human.notices, human.ackedIds],
  );
  const combinedUnread = totalUnread + systemNotices.length + humanUnread.length;

  // "Mark all read": every unread system notice, every unread NON-mandatory
  // announcement, and the project activity feed. A mandatory notice is never
  // swept — its acknowledgement is an explicit, recorded click.
  const markAll = useCallback(async () => {
    for (const a of systemNotices) void markRead(a);
    for (const a of humanUnread) if (!requiresAcknowledgement(a)) void human.ack(a);
    await markAllRead();
  }, [systemNotices, humanUnread, markRead, human, markAllRead]);

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
        // Unmounted when the bell closes, so a failed load clears on the next open.
        <LazySlot resetKey="notification-bell" fallback={null}>
        <BellPopover
          feed={feed}
          loadFailed={loadFailed}
          systemNotices={systemNotices}
          announcements={human.notices}
          ackedIds={human.ackedIds}
          unreadCount={combinedUnread}
          onMarkRead={markRead}
          onAck={(a) => void human.ack(a)}
          onMarkAll={() => void markAll()}
          onNavigate={() => setOpen(false)}
          direction={direction}
          align={align}
        />
        </LazySlot>
      )}
    </div>
  );
}
