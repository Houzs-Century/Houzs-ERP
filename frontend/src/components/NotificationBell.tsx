import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { cn } from "../lib/utils";
import { useVisiblePoll } from "../lib/visiblePoll";
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

const BellPopover = lazy(() => import("./NotificationBellPopover"));

interface Props {
  collapsed: boolean;
  direction?: "up" | "down";
  align?: "start" | "end";
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

  const { data: systemFeed } = useQuery({
    queryKey: announcementFeedKey("system"),
    queryFn: () =>
      api.get<BannerResponse>("/api/announcements/banner?scope=system"),
    staleTime: 180_000,
    enabled: !!user?.id,
  });
  useVisiblePoll(announcementFeedKey("system"), 180_000, !!user?.id);

  const human = useAnnouncementBanner({ scope: "human" });

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
      void qc.invalidateQueries({ queryKey: ANNOUNCEMENT_FEED_KEY });
    },
    [qc],
  );

  const humanUnread = useMemo(
    () => human.notices.filter((a) => !human.ackedIds.has(a.id)),
    [human.notices, human.ackedIds],
  );
  const combinedUnread = totalUnread + systemNotices.length + humanUnread.length;

  const markAll = useCallback(async () => {
    for (const a of systemNotices) void markRead(a);
    for (const a of humanUnread) if (!requiresAcknowledgement(a)) void human.ack(a);
    await markAllRead();
  }, [systemNotices, humanUnread, markRead, human, markAllRead]);

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
