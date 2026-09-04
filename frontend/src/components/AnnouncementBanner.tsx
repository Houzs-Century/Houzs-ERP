import { lazy } from "react";
import {
  Megaphone,
  AlertTriangle,
  ShieldCheck,
  BookOpen,
  Check,
  Play,
  Clock,
  BellOff,
  ArrowRight,
} from "lucide-react";
import { LazySlot } from "./LazySlot";
import { AnnouncementRichBody } from "./AnnouncementRichBody";
import { cn } from "../lib/utils";
import {
  bannerSecondaryKind,
  useAnnouncementBanner,
  type AnnouncementCategory,
  type BannerAnnouncement as Announcement,
} from "./useAnnouncementBanner";
import { fmtDate } from "../vendor/shared/format";

// Lazy so the media gallery (+ MediaLightbox + its icons) stays OUT of the
// initial bundle — the banner mounts at the app root, but most notices are
// text-only, so the media code only loads when a notice actually carries media.
const AnnouncementMedia = lazy(() =>
  import("./AnnouncementMedia").then((m) => ({ default: m.AnnouncementMedia })),
);

// ────────────────────────────────────────────────────────────────────────────
// AnnouncementBanner — the DESKTOP pop-up that surfaces the latest active
// announcement targeted at the current user, with a "Got it" ack button.
// Polls every 60s. Hidden when no announcement matches or when the user has
// already acknowledged it (and the office hasn't re-popped via Remind).
//
// This file is now PRESENTATION ONLY: the feed, the ack, the local-ack memo,
// the Remind re-pop rule and "which notice is current" live in
// useAnnouncementBanner, shared with the phone's pop-up (mobile/
// MobileAnnouncementPopup) so both shells answer "have I seen this?" the same
// way. Behaviour here is unchanged.
// ────────────────────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<AnnouncementCategory, string> = {
  GENERAL: "Notice",
  WARNING: "Warning",
  SOP: "SOP",
  LEARNING: "Learning",
};

// One colour per category (2026-07-09 redesign — GENERAL and SOP used to
// share brass): GENERAL=petrol, WARNING=red, SOP=brass, LEARNING=trend blue.
// All classes are static literals — Tailwind's content scan can't see
// runtime-composed names like `text-${accent}`, so never build them.
const CATEGORY_META: Record<
  AnnouncementCategory,
  {
    Icon: typeof Megaphone;
    bandCls: string;
    iconCls: string;
    labelCls: string; // category eyebrow above the title
    railCls: string; // 3px colour rail on the left edge
    primaryCls: string; // solid primary button
    primaryLabel: string;
    PrimaryIcon: typeof Check;
    secondaryLabel: string;
    SecondaryIcon: typeof Clock;
  }
> = {
  GENERAL: {
    Icon: Megaphone,
    bandCls: "border-primary/40 bg-primary/5",
    iconCls: "bg-primary/15 text-primary",
    labelCls: "text-primary",
    railCls: "bg-primary",
    primaryCls: "bg-primary text-white hover:bg-primary/90",
    primaryLabel: "Got it",
    PrimaryIcon: Check,
    secondaryLabel: "Remind later",
    SecondaryIcon: Clock,
  },
  WARNING: {
    Icon: AlertTriangle,
    bandCls: "border-err/40 bg-err/5",
    iconCls: "bg-err/15 text-err",
    labelCls: "text-err",
    railCls: "bg-err",
    primaryCls: "bg-err text-white hover:bg-err/90",
    primaryLabel: "Got it",
    PrimaryIcon: Check,
    secondaryLabel: "View details",
    SecondaryIcon: ArrowRight,
  },
  SOP: {
    Icon: ShieldCheck,
    bandCls: "border-accent/40 bg-accent-soft/40",
    iconCls: "bg-accent/15 text-accent",
    labelCls: "text-accent",
    railCls: "bg-accent",
    primaryCls: "bg-accent text-white hover:bg-accent/90",
    primaryLabel: "Acknowledge",
    PrimaryIcon: Check,
    secondaryLabel: "Read SOP",
    SecondaryIcon: ArrowRight,
  },
  LEARNING: {
    Icon: BookOpen,
    bandCls: "border-learning/40 bg-learning/5",
    iconCls: "bg-learning/15 text-learning",
    labelCls: "text-learning",
    railCls: "bg-learning",
    primaryCls: "bg-learning text-white hover:bg-learning/90",
    primaryLabel: "Watch",
    PrimaryIcon: Play,
    secondaryLabel: "Later",
    SecondaryIcon: BellOff,
  },
};

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return fmtDate(t);
}

export function AnnouncementBanner() {
  // HUMAN posts only (owner 2026-08-08, "为什么一直有这个"). This pop-up used
  // to take the unscoped feed — human posts AND the machine scan/service-case
  // notices — so every "New service case ASSR/…" threw a modal card, and under
  // the two-skips-then-mandatory-ack rule (#1728) that modal eventually
  // refused to leave. Machine notices are bell material: they surface in
  // NotificationBell's System-notices section instead, matching the phone
  // (whose pop-up has been human-only since owner 2026-07-20 B2).
  const { current, mustAcknowledge, ack, dismissSession } = useAnnouncementBanner({
    scope: "human",
  });

  if (!current) return null;

  // Secondary action per category: WARNING "View details" / SOP "Read SOP"
  // jump to the announcements page; GENERAL "Remind later" / LEARNING "Later"
  // hide the notice for this session only (no ack recorded, so it re-surfaces
  // on the next visit). Plain location.assign, not useNavigate — the banner
  // also renders router-less in design-sync previews (.design-sync/previews/
  // AnnouncementBanner.tsx mounts it under <AuthProvider> ALONE), and
  // useNavigate() throws outside a <Router>. That is a hard constraint, not a
  // leftover: swapping it for client-side navigation would crash the preview
  // build, so this one CTA stays a full page load.
  //
  // The jump carries NO permission check on purpose. It used to send anyone
  // without announcements.read (i.e. every ordinary salesperson) to a Forbidden
  // page, because this pop-up rides /banner — which is ungated — while the page
  // behind the button was gated on the ADMIN verb. The fix was to open the page
  // (owner 2026-07-21: readable by EVERY active user), so there is no longer a
  // capability that can fail here: the banner only renders for a signed-in user
  // (reload() returns early without one), and a signed-in user can now open
  // /announcements. A `can(...)` guard on this button would either be dead code
  // or re-create the exact 403 it was added to prevent.
  //
  // dismissSession now comes from useAnnouncementBanner (destructured above) —
  // the session-dismiss set moved into the shared hook so the phone sheet gets
  // the same behaviour; the local copy that used to live here was removed with
  // its setDismissedThisSession state.
  function secondary(a: Announcement) {
    const cat = a.category ?? "GENERAL";
    if (bannerSecondaryKind(cat) === "view") {
      window.location.assign("/announcements");
      return;
    }
    dismissSession(a);
  }

  const category = current.category ?? "GENERAL";
  const meta = CATEGORY_META[category];
  const Icon = meta.Icon;
  const { PrimaryIcon, SecondaryIcon } = meta;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="status"
      aria-live="polite"
    >
      {/* Backdrop — click dismisses for this session (re-surfaces next visit),
          never acks. A dedicated button keeps it keyboard-reachable. After the
          second skip (owner 2026-08-08) every dismiss affordance goes away, so
          the backdrop degrades to inert dimming. */}
      {mustAcknowledge ? (
        <div className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]" />
      ) : (
        <button
          type="button"
          aria-label="Dismiss notice"
          onClick={() => dismissSession(current)}
          className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[1px]"
        />
      )}
      {/* Centred notice card */}
      <div
        className={cn(
          "relative w-full max-w-md overflow-hidden rounded-2xl border bg-surface shadow-slab",
          meta.bandCls,
        )}
      >
        {/* colour rail across the top edge */}
        <span className={cn("absolute left-0 top-0 h-[3px] w-full", meta.railCls)} />
        <div className="max-h-[85vh] overflow-y-auto p-5">
          <div className="mb-2 flex items-center gap-2.5">
            <div
              className={cn(
                "grid h-8 w-8 shrink-0 place-items-center rounded-full",
                meta.iconCls,
              )}
            >
              <Icon size={16} />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "text-[10px] font-bold uppercase tracking-wide",
                  meta.labelCls,
                )}
              >
                {CATEGORY_LABEL[category]}
              </span>
              {current.createdAt && (
                <>
                  <span className="h-[3px] w-[3px] rounded-full bg-border" />
                  <span className="font-mono text-[11px] text-ink-secondary">
                    {relativeTime(current.createdAt)}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="text-[15px] font-semibold leading-snug text-ink">
            {current.title}
          </div>
          <AnnouncementRichBody
            html={current.bodyHtml}
            text={current.body}
            className="mt-1 text-[13px] leading-relaxed text-ink-secondary"
          />
          {/* Scoped, not bare: App.tsx renders <AnnouncementBanner /> TEN lines
              ABOVE the RouteCrashBoundary that wraps the route table, so a
              failed media chunk here had no boundary between it and main.tsx's
              unkeyed top-level one — it took the whole app down over whatever
              form the operator had open. Keyed on the notice id: acknowledging
              or skipping to the next notice clears it. */}
          {current.attachments && current.attachments.length > 0 && (
            <LazySlot resetKey={`ann-media:${current.id}`} fallback={null}>
              <AnnouncementMedia
                annId={current.id}
                attachments={current.attachments}
                layout={current.mediaLayout ?? null}
                className="mt-3"
              />
            </LazySlot>
          )}
          <div className="mt-4 flex items-center justify-end gap-2">
            {/* After the second skip only the acknowledge action remains — the
                secondary slot turns into the why-line (owner 2026-08-08). */}
            {mustAcknowledge ? (
              <span className="mr-auto text-[11px] font-medium text-ink-secondary">
                This notice requires acknowledgement
              </span>
            ) : (
              <button
                type="button"
                onClick={() => secondary(current)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3.5 text-[13px] font-semibold text-ink-secondary hover:bg-surface-dim hover:text-ink"
              >
                <SecondaryIcon size={14} />
                {meta.secondaryLabel}
              </button>
            )}
            <button
              type="button"
              onClick={() => void ack(current)}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-lg px-4 text-[13px] font-semibold",
                meta.primaryCls,
              )}
            >
              <PrimaryIcon size={14} />
              {meta.primaryLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
