/* The bell's popover body, loaded the first time the bell opens (it was the
   documented next candidate for the always-loaded shell's gzip ceiling:
   frontend/scripts/check-bundle-size.mjs, INITIAL_JS_GZIP). */
import { useState } from "react";
import { Link } from "react-router-dom";
import { cn, relativeTime } from "../lib/utils";
import type { NotificationItem } from "../hooks/useNotifications";
import type { BannerAnnouncement } from "./useAnnouncementBanner";
import { CATEGORY_META, categoryOf, requiresAcknowledgement } from "./announcementCategory";


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

export default function BellPopover({
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
