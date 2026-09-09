import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { cn, relativeTime } from "../lib/utils";
import { useNotifications, type NotificationItem } from "../hooks/useNotifications";
import {
  ANNOUNCEMENT_FEED_KEY,
  announcementFeedKey,
  useAnnouncementBanner,
  type BannerAnnouncement,
  type BannerResponse,
} from "./useAnnouncementBanner";
import { CATEGORY_META, categoryOf, requiresAcknowledgement } from "./announcementCategory";

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
      )}
    </div>
  );
}

type Tab = "all" | "ann" | "sys";

// The tag a system notice wears, from its source column.
function systemTag(source: string | null | undefined): string {
  switch (source) {
    case "scan":
      return "Scan";
    case "service_case":
      return "Service case";
    case "so_amendment":
    case "po_amendment":
      return "Amendment";
    case "ack_escalation":
      return "Team";
    default:
      return "System";
  }
}

const ROW = "grid grid-cols-[auto_1fr] gap-2.5 border-b border-border-subtle px-[15px] py-[11px]";

function BellPopover({
  feed,
  loadFailed,
  systemNotices,
  announcements,
  ackedIds,
  unreadCount,
  onMarkRead,
  onAck,
  onMarkAll,
  onNavigate,
  direction,
  align,
}: {
  feed: NotificationItem[];
  loadFailed: boolean;
  systemNotices: BannerAnnouncement[];
  announcements: BannerAnnouncement[];
  ackedIds: ReadonlySet<string>;
  unreadCount: number;
  onMarkRead: (a: BannerAnnouncement) => void;
  onAck: (a: BannerAnnouncement) => void;
  onMarkAll: () => void;
  onNavigate: () => void;
  direction: "up" | "down";
  align: "start" | "end";
}) {
  const [tab, setTab] = useState<Tab>("all");
  const annUnread = announcements.filter((a) => !ackedIds.has(a.id)).length;
  const sysUnread = systemNotices.length + feed.length;
  const showAnn = tab !== "sys";
  const showSys = tab !== "ann";
  const empty =
    (!showAnn || announcements.length === 0) && (!showSys || systemNotices.length + feed.length === 0);

  return (
    <div
      className={cn(
        "absolute z-40 flex w-[404px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-slab",
        "max-h-[min(760px,80vh)]",
        direction === "down" ? "top-full mt-2" : "bottom-full mb-2",
        align === "end" ? "right-0" : "left-0"
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-[15px] py-3">
        <span className="text-[13.5px] font-[680] text-ink">Notifications</span>
        {unreadCount > 0 && (
          <span className="rounded-full bg-err px-[7px] py-px font-money text-[10px] font-bold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
        <button
          type="button"
          onClick={onMarkAll}
          disabled={unreadCount === 0}
          className="ml-auto text-[11.5px] font-[650] text-primary hover:underline disabled:text-ink-muted disabled:no-underline"
        >
          Mark all read
        </button>
      </div>

      <div role="tablist" className="flex shrink-0 gap-1 border-b border-border bg-surface-2 px-2.5">
        {(
          [
            ["all", "All", annUnread + sysUnread],
            ["ann", "Announcements", annUnread],
            ["sys", "System", sysUnread],
          ] as Array<[Tab, string, number]>
        ).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "px-2 py-[9px] text-[11.5px] font-[650]",
              tab === id ? "text-primary" : "text-ink-muted hover:text-ink",
            )}
          >
            {label}
            {n > 0 && <span className="ml-1 font-money">{n}</span>}
          </button>
        ))}
      </div>

      <div className="thin-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        {empty && loadFailed ? (
          <div className="px-4 py-8 text-center text-[11px] text-ink-muted">
            <p className="font-semibold text-ink">We couldn't load your notifications.</p>
            <p className="mt-1">This is not the same as having none. Open Notifications to retry.</p>
          </div>
        ) : empty ? (
          <div className="px-4 py-8 text-center text-[11px] text-ink-muted">
            Nothing new. You're caught up.
          </div>
        ) : (
          <>
            {showAnn &&
              announcements.map((a) => {
                const meta = CATEGORY_META[categoryOf(a)];
                const unread = !ackedIds.has(a.id);
                const mandatory = requiresAcknowledgement(a);
                const who = a.createdByName?.trim();
                return (
                  <div key={a.id} className={cn(ROW, "shrink-0", unread ? "bg-primary-soft" : "bg-surface")}>
                    <span
                      className={cn(
                        "mt-1.5 h-[7px] w-[7px] rounded-full",
                        unread ? (mandatory ? "bg-err" : "bg-primary") : "bg-border",
                      )}
                    />
                    <div className="flex min-w-0 flex-col gap-[3px]">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "rounded-full px-[7px] py-px text-[9px] font-bold uppercase tracking-[.05em]",
                            meta.pillCls,
                          )}
                        >
                          {meta.label}
                        </span>
                        <span className="ml-auto font-mono text-[9.5px] text-ink-muted">
                          {relativeTime(a.createdAt)}
                        </span>
                      </div>
                      <Link
                        to={`/announcements?id=${encodeURIComponent(a.id)}`}
                        onClick={onNavigate}
                        className="text-[12.5px] font-[650] leading-[1.4] text-ink hover:text-primary"
                      >
                        {a.title}
                      </Link>
                      <span className="text-[11.5px] leading-[1.45] text-ink-secondary">
                        {who ? `${who} · ` : ""}
                        {unread ? (mandatory ? "requires acknowledgement" : "unread") : "confirmed"}
                      </span>
                      {unread && (
                        <button
                          type="button"
                          onClick={() => (mandatory ? onAck(a) : onMarkRead(a))}
                          className={cn(
                            "mt-[3px] self-start rounded-md px-2.5 py-[5px] text-[11px] font-bold",
                            mandatory
                              ? "bg-primary text-white hover:bg-primary/90"
                              : "border border-border bg-surface text-ink-secondary hover:bg-surface-dim",
                          )}
                        >
                          {mandatory ? "Acknowledge" : "Mark read"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

            {showSys &&
              systemNotices.map((a) => (
                <div key={a.id} className={cn(ROW, "shrink-0 bg-primary-soft")}>
                  <span className="mt-1.5 h-[7px] w-[7px] rounded-full bg-primary" />
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-full border border-border bg-surface-dim px-[7px] py-px text-[9px] font-bold uppercase tracking-[.05em] text-ink-muted">
                        {systemTag(a.source)}
                      </span>
                      {a.createdAt && (
                        <span className="ml-auto font-mono text-[9.5px] text-ink-muted" title={a.createdAt}>
                          {relativeTime(a.createdAt)}
                        </span>
                      )}
                    </div>
                    <span className="text-[12.5px] font-[650] leading-[1.4] text-ink">{a.title}</span>
                    {a.body && (
                      <span className="line-clamp-2 whitespace-pre-wrap text-[11.5px] leading-[1.45] text-ink-secondary">
                        {a.body}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onMarkRead(a)}
                      className="mt-[3px] self-start rounded-md border border-border bg-surface px-2.5 py-[5px] text-[11px] font-bold text-ink-secondary hover:bg-surface-dim"
                    >
                      Mark read
                    </button>
                  </div>
                </div>
              ))}

            {showSys &&
              feed.map((item) => (
                <Link
                  key={item.id}
                  to={`/projects/${item.project_id}`}
                  onClick={onNavigate}
                  className={cn(ROW, "shrink-0 bg-primary-soft transition-colors hover:bg-surface-dim")}
                >
                  <span className="mt-1.5 h-[7px] w-[7px] rounded-full bg-primary" />
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-full border border-border bg-surface-dim px-[7px] py-px text-[9px] font-bold uppercase tracking-[.05em] text-ink-muted">
                        Project
                      </span>
                      <span className="ml-auto font-mono text-[9.5px] text-ink-muted" title={item.created_at}>
                        {relativeTime(item.created_at)}
                      </span>
                    </div>
                    <span className="truncate text-[12.5px] font-[650] leading-[1.4] text-ink">
                      {item.project_name || "Project"}
                      {item.brand && (
                        <span className="ml-1.5 font-mono text-[9.5px] font-normal text-ink-muted">{item.brand}</span>
                      )}
                    </span>
                    <span className="truncate text-[11.5px] text-ink-secondary">{renderActivityLine(item)}</span>
                  </div>
                </Link>
              ))}
          </>
        )}
      </div>

      <div className="flex shrink-0 justify-center border-t border-border bg-surface-2 px-[15px] py-2.5">
        <Link
          to="/announcements"
          onClick={onNavigate}
          className="text-[11.5px] font-[650] text-primary hover:underline"
        >
          Open all announcements
        </Link>
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
