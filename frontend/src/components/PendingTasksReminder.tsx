import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";
import { usePendingReminder } from "../hooks/usePendingReminder";
import type { DigestTier } from "../hooks/pendingDigest";

/** Daily pending-work reminder (owner 2026-09-09: "better keluar macam
 *  [announcement] utk mobile and pc pms becoz now a lot pending task").
 *
 *  Wears the announcement modal's clothes ON PURPOSE — same red WARNING
 *  treatment, same two buttons ("Got it" / "Remind later"), same rule that ✕ is
 *  NOT an acknowledgement — so staff already know what it wants from them.
 *
 *  It does NOT go through the announcement feed: that feed is human posts only,
 *  by the owner's own 2026-07-20 and 2026-08-08 decisions, and this is machine
 *  generated. Keeping it a separate component honours both instructions.
 *
 *  ONE modal for both shells: mounted beside AnnouncementBanner on the desktop
 *  and inside the phone shell, so the two surfaces cannot drift apart.
 */

const TIER_COPY: Record<DigestTier, { lead: string; tone: string }> = {
  past_event: {
    lead: "already finished — work still not done",
    tone: "text-err font-bold",
  },
  this_week: {
    lead: "happening within 7 days",
    tone: "text-err",
  },
  later: {
    lead: "still waiting on you",
    tone: "text-ink-secondary",
  },
};

export function PendingTasksReminder() {
  const navigate = useNavigate();
  const { digest, open, acknowledge, postpone, armMyPendingFilter } = usePendingReminder();

  if (!open || !digest) return null;

  const openList = () => {
    armMyPendingFilter();
    acknowledge();
    navigate("/projects");
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pending work reminder"
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-err/40 bg-surface shadow-slab">
        <div className="flex items-center gap-2 bg-err-bg px-4 py-3 text-err">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="text-[11px] font-bold uppercase tracking-wider">Pending work</span>
        </div>

        {/* The body is the CTA — tapping anywhere on it opens the filtered list,
            which is why there is no third button (owner: "guna je same button"). */}
        <button
          type="button"
          onClick={openList}
          className="block w-full px-4 py-3 text-left hover:bg-primary-soft/30"
        >
          <div className="text-[13px] font-semibold text-ink">
            You have {digest.total} event{digest.total === 1 ? "" : "s"} with work waiting
          </div>
          <ul className="mt-2 space-y-1">
            {digest.groups.map((g) => (
              <li key={g.tier} className={cn("text-[12px]", TIER_COPY[g.tier].tone)}>
                {g.events.length} {TIER_COPY[g.tier].lead}
                {g.titles.length > 0 && (
                  <span className="block text-[10.5px] text-ink-muted">
                    {g.titles.slice(0, 3).join(" · ")}
                    {g.titles.length > 3 ? ` +${g.titles.length - 3} more` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2 text-[10.5px] font-semibold text-accent">Tap to view the list</div>
        </button>

        <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-4 py-2.5">
          <span className="text-[10px] text-ink-muted">
            {digest.mustAcknowledge
              ? "This reminder requires acknowledgement"
              : "You can postpone once"}
          </span>
          <div className="flex gap-1.5">
            {/* Postponing is refused once something has already run past its
                event, or runs this week — the escalation the owner asked for
                ("bg nmpk beza sikit"). */}
            {!digest.mustAcknowledge && (
              <button
                type="button"
                onClick={postpone}
                className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
              >
                Remind later
              </button>
            )}
            <button
              type="button"
              onClick={acknowledge}
              className="rounded-md bg-err px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
