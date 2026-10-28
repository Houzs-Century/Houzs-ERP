import { useState } from "react";
import { Link } from "react-router-dom";
import { Bell, CheckCheck, RotateCcw } from "lucide-react";
import { relativeTime } from "../lib/utils";
import { useNotifications, type NotificationItem } from "../hooks/useNotifications";
import { Avatar } from "../components/Avatar";

/**
 * Notifications page. The mobile Inbox tab and the desktop bell's "view
 * all" both land here. Renders the shared NotificationsProvider feed (the
 * same activity rows the bell popover shows) as a full-screen list, so
 * tapping Inbox opens a real screen instead of a 404.
 *
 * Each row links to its project, mirroring the bell popover.
 *
 * NO LONGER DISPLAY-ONLY. "Mark all read" existed only on the phone
 * (MobileInbox), so the same feed could be cleared from a handset and not from
 * a desk — the desktop page carried Reload and no write at all. The action is
 * the SHARED `markAllRead` on the notifications provider, not a second copy of
 * the mobile loop.
 */
export function Notifications() {
  const { feed, totalUnread, loadFailed, reload, markAllRead } = useNotifications();
  const [marking, setMarking] = useState(false);
  /* The shared action reports how many projects refused instead of swallowing
     them; this is the surface that renders it. Silence here would be the exact
     bug the mobile version had. */
  const [markError, setMarkError] = useState<string | null>(null);

  const onMarkAll = async () => {
    if (marking || totalUnread === 0) return;
    setMarking(true);
    setMarkError(null);
    try {
      const { ok, failed } = await markAllRead();
      if (failed > 0) {
        setMarkError(
          ok > 0
            ? `Marked ${ok}, but ${failed} couldn't be marked read. Try again.`
            : "Couldn't mark these read. Try again.",
        );
      }
    } catch (e) {
      setMarkError(e instanceof Error ? e.message : "Couldn't mark these read.");
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-accent-soft/60 text-accent">
            <Bell size={17} strokeWidth={2.2} />
          </span>
          <div>
            <h1 className="font-display text-[18px] font-extrabold leading-tight text-ink">
              Notifications
            </h1>
            <p className="text-[11.5px] text-ink-muted">
              {loadFailed && feed.length === 0
                ? "Couldn't load"
                : totalUnread > 0
                ? `${totalUnread > 99 ? "99+" : totalUnread} unread`
                : "You're caught up"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Desktop parity with the mobile Inbox pill. Disabled — never hidden
              — at zero unread, so the capability stays discoverable. */}
          <button
            type="button"
            onClick={() => void onMarkAll()}
            disabled={marking || totalUnread === 0}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-default disabled:opacity-50 disabled:hover:border-border disabled:hover:text-ink-secondary"
          >
            <CheckCheck size={14} />
            {marking ? "Marking…" : "Mark all read"}
          </button>
          <button
            type="button"
            onClick={() => reload()}
            aria-label="Refresh notifications"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface text-ink-muted transition-colors hover:border-accent/40 hover:text-accent"
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </header>

      {markError && (
        <p className="rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-ink">
          {markError}
        </p>
      )}

      {feed.length === 0 && loadFailed ? (
        /* An empty feed we FAILED to load is NOT an empty feed. Telling someone
           they're caught up when we never got an answer is the most misleading
           thing this screen can say — it's the one people read to decide whether
           anything needs them. Mirror the mobile inbox, which already keeps
           these two states apart (see MobileInbox.tsx + useNotifications
           loadFailed). */
        <div className="rounded-lg border border-err/30 bg-err/5 px-4 py-12 text-center shadow-stone">
          <p className="text-[12.5px] font-semibold text-ink">
            We couldn't load your notifications.
          </p>
          <p className="mt-1 text-[11.5px] text-ink-muted">
            This isn't the same as having none. Try again.
          </p>
          <button
            type="button"
            onClick={() => reload()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
          >
            <RotateCcw size={13} />
            Retry
          </button>
        </div>
      ) : feed.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface px-4 py-12 text-center text-[12px] text-ink-muted shadow-stone">
          Nothing new. You're caught up.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {feed.map((item) => (
            <li key={item.id}>
              <Link
                to={`/projects/${item.project_id}`}
                className="flex gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 shadow-stone transition-colors hover:border-accent/40 hover:bg-bg/40"
              >
                <Avatar
                  userId={item.user_id}
                  hasImage={item.user_profile_pic_r2_key}
                  name={item.user_name}
                  email={item.user_email}
                  size={32}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12.5px] font-semibold text-ink">
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
                  <div className="mt-0.5 text-[12px] text-ink-secondary">
                    {renderActivityLine(item)}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One-line summary of an activity row. Mirrors the bell popover copy. */
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
