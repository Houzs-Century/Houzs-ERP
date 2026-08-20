import { useMemo, useState } from "react";
import { api } from "../api/client";
import { relativeTime, parseDate, todayInAppTz } from "../lib/utils";
import {
  useNotifications,
  type NotificationItem,
} from "../hooks/useNotifications";
import "./mobile.css";

// Activity-type -> icon tile (matches the design's inboxRow icon slot). The
// feed is project-activity notifications, so the icon is derived from the row's
// action rather than a stored type. Falls back to a neutral bell.
function ActivityIcon({ action }: { action: string }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "#16695f", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (action) {
    case "stage_change":
      return <svg {...common}><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>;
    case "created":
      return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
    case "checklist_status":
    case "checklist_add":
    case "checklist_remove":
      return <svg {...common}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>;
    case "finance_edit":
      return <svg {...common}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>;
    case "archived":
    case "restored":
      return <svg {...common}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></svg>;
    case "note":
      return <svg {...common}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></svg>;
    default:
      return <svg {...common}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>;
  }
}

/** One-line summary of an activity row. Mirrors the desktop Notifications
 *  page copy so the two surfaces read identically. */
function activityLine(a: NotificationItem): string {
  const who = a.user_name ? `${a.user_name} · ` : "";
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

/**
 * Mobile Inbox (notifications feed). Presentation ported VERBATIM from the
 * owner's mobile design prototype (`#inbox` section + `renderInbox`) using the
 * design system classes now in mobile.css (`.hdr` `.ey` `.card` `.scroll`),
 * wired to the shared NotificationsProvider — the same unread activity rows the
 * desktop bell popover and /notifications page show.
 *
 * "Mark all read" mirrors the desktop chat behaviour: there is no bulk
 * endpoint, so we POST /api/projects/:id/read for every project that still
 * carries an unread count (the same call ProjectChat makes on mount), then
 * reload the feed.
 */
export function MobileInbox({
  onOpen,
  onBack,
}: {
  onOpen?: (item: NotificationItem) => void;
  onBack?: () => void;
}) {
  /* `unreadByProject` still drives each row's unread dot — only the mark-read
     LOOP moved to the provider, not the read of who is unread. */
  const { feed, totalUnread, unreadByProject, loadFailed, reload, markAllRead } = useNotifications();
  const [marking, setMarking] = useState(false);

  const { today, earlier } = useMemo(() => {
    const t = todayInAppTz();
    const isToday = (iso: string) => {
      const d = parseDate(iso);
      if (!d) return false;
      return (
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kuala_Lumpur",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(d) === t
      );
    };
    const today: NotificationItem[] = [];
    const earlier: NotificationItem[] = [];
    for (const item of feed) (isToday(item.created_at) ? today : earlier).push(item);
    return { today, earlier };
  }, [feed]);

  /* The LOOP moved to useNotifications (`markAllRead`) so the desktop
     Notifications page can perform the same action instead of having no write
     at all. This screen keeps only its own busy flag and its own way of saying
     it went wrong.

     It used to end each request with `.catch(() => {})`. A bulk mark-read that
     failed for every project then looked exactly like one that worked — the
     spinner stopped, the feed reloaded, and the badge simply stayed up with no
     explanation. The shared action returns counts; this is what renders them. */
  const [markError, setMarkError] = useState<string | null>(null);
  const markAll = async () => {
    if (marking) return;
    setMarking(true);
    setMarkError(null);
    try {
      const { ok, failed } = await markAllRead();
      if (failed > 0) {
        setMarkError(
          ok > 0
            ? `Marked ${ok}, but ${failed} couldn't be marked read. Pull to refresh and try again.`
            : "Couldn't mark these read. Pull to refresh and try again.",
        );
      }
    } catch (e) {
      setMarkError(e instanceof Error ? e.message : "Couldn't mark these read.");
    } finally {
      setMarking(false);
    }
  };

  // Designer feed layout (#inbox / renderInbox): an "Activity / Inbox" header
  // with a bordered "Mark all read" pill (check icon), then Today / Earlier
  // groups where each group is ONE card and rows are divider-separated — a
  // leading unread dot, an activity-type icon tile, the title, a one-line body,
  // and the relative time. Wired to the shared notifications feed + bulk
  // mark-read.
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        {onBack && (
          <button onClick={onBack} className="back" style={{ marginBottom: 7 }}>
            <span className="chev">{"‹"}</span> Menu
          </button>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div className="eyebrow">Activity</div>
            <div className="scr-title">Inbox</div>
          </div>
          <button
            onClick={markAll}
            disabled={marking || totalUnread === 0}
            style={{
              display: "flex", alignItems: "center", gap: 5, height: 34, padding: "0 12px",
              border: "1px solid #d6d9d2", borderRadius: 9, background: "#f4f6f3", color: "#414539",
              fontFamily: "inherit", fontSize: 12, fontWeight: 700,
              cursor: marking || totalUnread === 0 ? "default" : "pointer",
              opacity: totalUnread === 0 ? 0.5 : 1,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            {marking ? "Marking…" : "Mark all read"}
          </button>
        </div>
        {markError && (
          <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.35, color: "var(--red, #b23a3a)" }}>
            {markError}
          </div>
        )}
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {feed.length === 0 && loadFailed ? (
          /* An empty feed we FAILED to load is not an empty feed. Telling the
             user they are all caught up when we never got an answer is the most
             damaging sentence on this screen — it is the one they read to decide
             whether anything needs them. */
          <div className="empty">
            <div className="empty-t">We couldn't load your notifications.</div>
            <div className="empty-s">This is not the same as having none. Pull down to try again.</div>
          </div>
        ) : feed.length === 0 ? (
          <div className="empty">
            <div className="empty-t">You're all caught up.</div>
            <div className="empty-s">New activity shows up here.</div>
          </div>
        ) : (
          <>
            {today.length > 0 && (
              <div>
                <div className="ey" style={{ color: "#767b6e", margin: "0 2px 9px" }}>Today</div>
                <div className="card" style={{ overflow: "hidden", marginBottom: 14 }}>
                  {today.map((item, i) => (
                    <Row key={item.id} item={item} first={i === 0} unread={(unreadByProject[item.project_id] ?? 0) > 0} onOpen={onOpen} />
                  ))}
                </div>
              </div>
            )}
            {earlier.length > 0 && (
              <div>
                <div className="ey" style={{ color: "#767b6e", margin: "0 2px 9px" }}>Earlier</div>
                <div className="card" style={{ overflow: "hidden" }}>
                  {earlier.map((item, i) => (
                    <Row key={item.id} item={item} first={i === 0} unread={(unreadByProject[item.project_id] ?? 0) > 0} onOpen={onOpen} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  item, first, unread, onOpen,
}: {
  item: NotificationItem;
  first: boolean;
  unread: boolean;
  onOpen?: (item: NotificationItem) => void;
}) {
  const title = item.project_name || item.project_code || "Project";
  return (
    <button
      onClick={() => onOpen?.(item)}
      style={{
        display: "flex", alignItems: "center", gap: 11, width: "100%", textAlign: "left",
        background: "none", border: "none", borderTop: first ? "none" : "1px solid #e3e6e0",
        padding: "11px 13px", cursor: onOpen ? "pointer" : "default", fontFamily: "inherit",
      }}
    >
      <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: "#b23a3a", visibility: unread ? "visible" : "hidden" }} />
      <span style={{ width: 32, height: 32, flex: "none", borderRadius: 9, background: "#f4f6f3", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <ActivityIcon action={item.action} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: unread ? 800 : 600, color: "#11140f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
          {item.brand && (
            <span className="money" style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 400, color: "#9aa093" }}>{item.brand}</span>
          )}
        </span>
        <span style={{ display: "block", fontSize: 11.5, color: "#767b6e", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {activityLine(item)}
        </span>
      </span>
      <span className="money" style={{ fontSize: 10, color: "#9aa093", flex: "none" }} title={item.created_at}>
        {relativeTime(item.created_at)}
      </span>
    </button>
  );
}
