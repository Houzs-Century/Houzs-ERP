import { useAnnouncementBanner, bannerSecondaryKind } from "../components/useAnnouncementBanner";
import { Attachments } from "./MobileAnnouncementMedia";
import { AnnouncementRichBody } from "../components/AnnouncementRichBody";
import { localizeAnnouncement, useMobileLang } from "./mobileI18n";
import { formatDate } from "../lib/utils";
import "./mobile.css";

// ---------------------------------------------------------------------------
// MobileAnnouncementPopup — the phone twin of the desktop AnnouncementBanner.
//
// The desktop shell has always thrown a new announcement in your face with an
// Acknowledge button; the phone showed NOTHING — no pop-up and (before this
// change) not even an unread dot, so a salesperson only learned a notice
// existed if they thought to walk into Profile > Announcements (owner
// 2026-07-21). This is that missing surface.
//
// All the decisions — which notice is current, the local-ack memo, the Remind
// re-pop rule, what the secondary button means — come from the SHARED
// useAnnouncementBanner hook, so the two shells can never disagree about
// "have I seen this?". Only the markup is mobile: the app's own bottom-sheet
// chrome from mobile.css (.sheet-bd / .sheet / .grab / .sheet-head / .sheet-x /
// .sheet-scroll / .sheet-foot), the same chrome the Menu, Day view and SKU
// picker sheets use.
//
// SCOPE = human posts only. The system half of the feed (scan results,
// service-case notices) already has its own phone surface — the bell inside
// Announcements plus the app-wide unread badge (owner 2026-07-20 B2) — and a
// scan notice is written to the SCANNER, so popping that scope would throw a
// full-screen sheet at the operator every time their own upload finished.
// The desktop pop-up is human-only too since owner 2026-08-08 (machine
// notices go to NotificationBell's System-notices section, never a modal).
// ---------------------------------------------------------------------------

const CAT_LABEL: Record<string, string> = {
  GENERAL: "General",
  WARNING: "Warning",
  SOP: "SOP",
  LEARNING: "Learning",
};
const CAT_COLOR: Record<string, string> = {
  GENERAL: "#475569",
  WARNING: "#b45309",
  SOP: "#0e7490",
  LEARNING: "#7a5c86",
};

export function MobileAnnouncementPopup({ onOpenList }: {
  onOpenList: () => void;
}) {
  const { current, mustAcknowledge, ack, dismissSession, hideForNavigation } =
    useAnnouncementBanner({ scope: "human" });
  const lang = useMobileLang();

  if (!current) return null;

  const category = current.category ?? "GENERAL";
  const col = CAT_COLOR[category] ?? CAT_COLOR.GENERAL;
  const loc = localizeAnnouncement(current, lang);
  const secondaryIsView = bannerSecondaryKind(category) === "view";

  const secondary = () => {
    if (secondaryIsView) {
      hideForNavigation(current);
      onOpenList();
      return;
    }
    dismissSession(current);
  };

  return (
    <div
      className="hz-m sheet-bd"
      role="dialog"
      aria-modal="true"
      aria-label="New announcement"
      // Backdrop tap dismisses for this session (re-surfaces next visit),
      // never acks — same rule as the desktop backdrop. Inert after the second
      // skip (owner 2026-08-08): only the acknowledge action remains.
      onClick={(e) => {
        if (e.target === e.currentTarget && !mustAcknowledge) dismissSession(current);
      }}
    >
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div style={{ minWidth: 0 }}>
            <div className="ey" style={{ color: col }}>{CAT_LABEL[category] ?? "Notice"}</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)", marginTop: 2, lineHeight: 1.3 }}>
              {loc.title}
            </div>
            {current.createdAt && (
              <div style={{ fontSize: 11, color: "var(--mut2)", marginTop: 4 }}>{formatDate(current.createdAt)}</div>
            )}
          </div>
          {!mustAcknowledge && (
            <button className="sheet-x" onClick={() => dismissSession(current)} aria-label="Dismiss">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          )}
        </div>
        <div className="sheet-scroll" style={{ gap: 12 }}>
          <AnnouncementRichBody html={loc.bodyHtml} text={loc.body} annId={current.id} style={{ fontSize: 13.5, lineHeight: 1.7, color: "var(--hz-c-ink-secondary)" }} />
          <Attachments ann={current} />
        </div>
        <footer className="sheet-foot">
          {/* After the second skip only the acknowledge action remains — the
              secondary slot turns into the why-line (owner 2026-08-08). */}
          {mustAcknowledge ? (
            <span style={{ flex: 1, fontSize: 11.5, fontWeight: 600, color: "var(--mut2)" }}>
              This notice requires acknowledgement
            </span>
          ) : (
            <button
              type="button"
              className="btn-ghost"
              style={{ flex: 1 }}
              onClick={secondary}
            >
              {secondaryIsView ? "View details" : "Later"}
            </button>
          )}
          <button
            type="button"
            className="btn"
            style={{ flex: 1 }}
            onClick={() => void ack(current)}
          >
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
}
