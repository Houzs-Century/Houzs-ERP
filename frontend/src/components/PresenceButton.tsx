import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowUpRight, Users } from "lucide-react";
import { usePresence } from "../hooks/usePresence";
import { labelForPath } from "../lib/routeLabels";
import { cn } from "../lib/utils";
import type { ActiveMember } from "../types";

/**
 * "Who's online" — compact header control (owner design iteration 2026-07-27,
 * screenshot round 3: "应该是这样的").
 *
 * A 36px Users button between the global search and the bell. Popover:
 * petrol "Team activity" header with a solid-green "N online" chip and a
 * pale "M away" chip; an ACTIVE NOW list whose rows deep-link to the page
 * each teammate is on (the 60s heartbeat reports the tab's pathname); an
 * AWAY list (quiet 2–15 min, tab hidden/idle) that is informational only;
 * and a footer with the idle rule + Manage access → /team.
 * The current user is excluded (the profile chip shows your own state).
 *
 * Data rides the existing usePresence singleton — mounting this adds ZERO
 * requests (PresencePanel in the sidebar shares the same poll).
 */

const AVATAR_BG = ["bg-primary", "bg-primary-ink", "bg-ink-secondary"];

/* Path tails that read as document numbers ("SO-2990-2607-022") get shown
   after the page label — real doc-in-path routes only; ULID-ish or numeric
   ids stay hidden. */
const DOC_TAIL = /^[A-Z]{2,4}-[A-Z0-9][A-Z0-9-]{3,}$/i;

function initialsOf(m: ActiveMember): string {
  const src = m.name?.trim() || m.email;
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/* last_seen_at is SQLite "YYYY-MM-DD HH:MM:SS" in UTC with no marker. */
function minutesSince(lastSeenAt: string): number | null {
  const t = Date.parse(lastSeenAt.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / 60_000);
}

function sinceLabel(lastSeenAt: string): string {
  const mins = minutesSince(lastSeenAt);
  if (mins === null) return "";
  return mins <= 1 ? "now" : `${mins}m`;
}

function idleLabel(lastSeenAt: string): string {
  const mins = minutesSince(lastSeenAt);
  return mins === null ? "" : `${Math.max(mins, 2)}m idle`;
}

function whereLabel(m: ActiveMember): string {
  if (!m.last_path) return m.role_name;
  const label = labelForPath(m.last_path);
  const tail = m.last_path.split("/").filter(Boolean).pop() ?? "";
  return DOC_TAIL.test(tail) ? `${label} · ${tail.toUpperCase()}` : label;
}

export function PresenceButton() {
  const { members, away, loading } = usePresence();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const online = members.filter((m) => !m.is_self);
  const awayList = away.filter((m) => !m.is_self);

  // Close on outside click (same idiom as NotificationBell).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Esc closes and hands focus back to the button.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Route change closes (a row click navigates; so can anything else).
  useEffect(() => {
    setOpen(false);
  }, [location.key]);

  const goTo = (m: ActiveMember) => {
    if (!m.last_path) return;
    setOpen(false);
    navigate(m.last_path);
  };

  return (
    <div ref={wrapRef} className="group relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`${online.length} teammates online`}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-md border transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40",
          open
            ? "border-primary bg-primary-soft"
            : "border-border bg-surface hover:border-border-strong hover:bg-surface-dim"
        )}
      >
        <Users
          size={16}
          className={open ? "text-primary-ink" : "text-ink-secondary"}
        />
        {!loading && online.length > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-synced px-1 font-mono text-[10px] font-semibold text-white ring-2 ring-surface">
            {online.length}
          </span>
        )}
      </button>

      {/* Hover tooltip — closed state only; CSS-delayed, no JS timer. */}
      {!open && (
        <span className="pointer-events-none absolute right-0 top-11 z-20 whitespace-nowrap rounded-md bg-ink px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-white opacity-0 shadow-slab transition-opacity delay-[400ms] group-hover:opacity-100">
          {online.length} teammates online
        </span>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Team activity"
          className="absolute right-0 top-11 z-20 w-[360px] overflow-hidden rounded-lg border border-border bg-surface shadow-slab animate-fade-in"
        >
          {/* Header — title + online/away chips */}
          <div className="flex items-center justify-between bg-primary px-4 py-3.5">
            <span className="font-mono text-[11px] uppercase tracking-wider text-white">
              Team activity
            </span>
            <span className="flex items-center gap-1.5">
              <span className="flex items-center gap-1.5 rounded-full bg-synced py-0.5 pl-1.5 pr-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white">
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
                {online.length} online
              </span>
              {awayList.length > 0 && (
                <span className="flex items-center gap-1.5 rounded-full bg-surface-dim py-0.5 pl-1.5 pr-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
                  <span className="h-1.5 w-1.5 rounded-full bg-ink-muted" />
                  {awayList.length} away
                </span>
              )}
            </span>
          </div>

          {loading && online.length === 0 && awayList.length === 0 ? (
            <div className="space-y-2 px-4 py-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-md bg-surface-dim" />
              ))}
            </div>
          ) : online.length === 0 && awayList.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <Users size={20} className="mx-auto text-ink-muted" />
              <div className="mt-2 text-[13px] text-ink-secondary">
                No one else is here right now
              </div>
            </div>
          ) : (
            <>
              {online.length > 0 && (
                <>
                  <div className="px-4 pb-1.5 pt-3">
                    <span className="rounded-full bg-synced-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-synced">
                      Active now
                    </span>
                  </div>
                  <div className="px-1.5 pb-1.5">
                    {online.map((m) => (
                      <div
                        key={m.id}
                        role={m.last_path ? "button" : undefined}
                        tabIndex={m.last_path ? 0 : undefined}
                        onClick={() => goTo(m)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") goTo(m);
                        }}
                        className={cn(
                          "group/row flex items-center gap-3 rounded-md px-2.5 py-2",
                          m.last_path
                            ? "cursor-pointer hover:bg-surface-dim"
                            : "cursor-default"
                        )}
                      >
                        <span className="relative shrink-0">
                          <span
                            className={cn(
                              "flex h-[30px] w-[30px] items-center justify-center rounded-md font-mono text-[10px] font-semibold text-white",
                              AVATAR_BG[m.id % AVATAR_BG.length]
                            )}
                          >
                            {initialsOf(m)}
                          </span>
                          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-synced ring-2 ring-surface" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-ink">
                            {m.name || m.email}
                          </span>
                          <span className="block truncate text-[11px] text-ink-muted">
                            {whereLabel(m)}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-synced">
                          {m.last_path ? (
                            <>
                              <span className="group-hover/row:hidden">
                                {sinceLabel(m.last_seen_at)}
                              </span>
                              <ArrowUpRight
                                size={14}
                                className="hidden text-primary group-hover/row:block"
                              />
                            </>
                          ) : (
                            sinceLabel(m.last_seen_at)
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {awayList.length > 0 && (
                <>
                  <div className="border-t border-border-subtle px-4 pb-1.5 pt-2.5">
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                      Away
                    </span>
                  </div>
                  <div className="px-1.5 pb-1.5">
                    {awayList.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center gap-3 rounded-md px-2.5 py-2 hover:bg-surface-2"
                      >
                        <span className="relative shrink-0">
                          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-md border border-border bg-surface-dim font-mono text-[10px] font-semibold text-ink-secondary">
                            {initialsOf(m)}
                          </span>
                          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-muted bg-surface" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-ink-secondary">
                            {m.name || m.email}
                          </span>
                          <span className="block truncate text-[11px] text-ink-muted">
                            {whereLabel(m)}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                          {idleLabel(m.last_seen_at)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {/* Footer — idle rule + team admin */}
          <div className="flex items-center justify-between border-t border-border-subtle bg-surface-2 px-4 py-2.5">
            <span className="text-[11px] text-ink-muted">
              Away after 2 min quiet · gone after 15
            </span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate("/team");
              }}
              className="font-mono text-[10px] uppercase tracking-wider text-primary hover:text-primary-ink"
            >
              Manage access
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
