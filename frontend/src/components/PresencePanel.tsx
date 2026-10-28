import { useState } from "react";
import { Circle } from "lucide-react";
import { usePresence } from "../hooks/usePresence";
import { cn } from "../lib/utils";

interface Props {
  /** When the sidebar is collapsed, render a tighter icon-only version. */
  collapsed: boolean;
}

/**
 * "Who's here right now" indicator for the sidebar.
 *
 * - Expanded sidebar → small section with a green dot, "X online" label,
 *   and an avatar stack of up to 4 initials. Hovering reveals a card
 *   listing every active member with their role.
 * - Collapsed sidebar → just the count badge with a green dot.
 */
export function PresencePanel({ collapsed }: Props) {
  const { members, loading } = usePresence();
  const [hover, setHover] = useState(false);

  if (loading || members.length === 0) {
    // Don't show anything until we have data — avoids a flash of "0 online".
    return null;
  }

  const visible = members.slice(0, 4);
  const overflow = Math.max(0, members.length - visible.length);

  return (
    <div
      className={cn(
        "relative border-t border-sidebar-border",
        collapsed ? "px-2 py-3" : "px-5 py-3"
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {collapsed ? (
        <div className="flex flex-col items-center gap-1">
          <div className="relative">
            <Circle
              size={6}
              fill="currentColor"
              className="text-synced"
              strokeWidth={0}
            />
          </div>
          <span className="font-mono text-[10px] font-semibold text-sidebar-ink">
            {members.length}
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-synced/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-synced" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
                {members.length} Online
              </span>
            </div>
          </div>
          <div className="mt-2 flex -space-x-2">
            {visible.map((m) => (
              <Avatar key={m.id} initials={initialsOf(m)} title={displayName(m)} />
            ))}
            {overflow > 0 && (
              <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-sidebar bg-sidebar-active text-[9px] font-bold text-accent-ink">
                +{overflow}
              </div>
            )}
          </div>
        </>
      )}

      {/* Hover popover — full active list */}
      {hover && !collapsed && (
        <div className="absolute bottom-full left-3 right-3 z-20 mb-2 overflow-hidden rounded-md border border-border bg-surface shadow-slab">
          <div className="border-b border-border-subtle bg-surface-dim/60 px-3 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
              Active Now
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {members.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2.5 border-b border-border-subtle px-3 py-2 last:border-b-0"
              >
                <Avatar initials={initialsOf(m)} title="" small />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-ink">
                    {displayName(m)}
                    {m.is_self && (
                      <span className="ml-1 text-[9px] font-medium uppercase tracking-wider text-ink-muted">
                        you
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[10px] text-ink-muted">
                    {m.role_name}
                  </div>
                </div>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-synced" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Avatar({
  initials,
  title,
  small,
}: {
  initials: string;
  title: string;
  small?: boolean;
}) {
  return (
    <div
      title={title}
      className={cn(
        "flex items-center justify-center rounded-full bg-sidebar-active font-bold uppercase text-accent-ink shadow-[inset_0_0_0_1px_rgba(161,106,46,0.25)]",
        small ? "h-6 w-6 text-[9px]" : "h-7 w-7 border-2 border-sidebar text-[10px]"
      )}
    >
      {initials}
    </div>
  );
}

function initialsOf(m: { name: string | null; email: string }): string {
  const source = m.name || m.email;
  // "Jane Doe" → "JD"; "jane@x.com" → "JA"
  const parts = source.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function displayName(m: { name: string | null; email: string }): string {
  return m.name || m.email.split("@")[0];
}
