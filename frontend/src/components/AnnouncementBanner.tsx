import { lazy } from "react";
import { LazySlot } from "./LazySlot";
import { cn, relativeTime } from "../lib/utils";
import {
  useAnnouncementBanner,
  type BannerAnnouncement as Announcement,
} from "./useAnnouncementBanner";
import { CATEGORY_META, categoryOf } from "./announcementCategory";

const AnnouncementMedia = lazy(() =>
  import("./AnnouncementMedia").then((m) => ({ default: m.AnnouncementMedia })),
);
const AnnouncementRichBody = lazy(() =>
  import("./AnnouncementRichBody").then((m) => ({ default: m.AnnouncementRichBody })),
);

// ────────────────────────────────────────────────────────────────────────────
// AnnouncementBanner — the DESKTOP mandatory-acknowledgement modal (design
// handoff 2026-09-04, screen 3). Pops ONLY for a notice that requires
// acknowledgement (WARNING / SOP, or the per-notice flag) and only while it is
// unacknowledged; GENERAL and LEARNING never block — they are read and
// acknowledged inline in the inbox, the dashboard stack and the bell.
//
// Escape rule: the first appearance offers "Remind later" with the note "You
// can postpone once"; after that single postponement the secondary button is
// gone and the note reads "This notice requires acknowledgement" (one skip,
// superseding #1728's two — see announcementLocalAcks.MAX_ANNOUNCEMENT_SKIPS).
//
// This file is PRESENTATION ONLY: the feed, the ack, the local-ack memo, the
// Remind re-pop rule, the postponement budget and "which notice is current"
// live in useAnnouncementBanner, shared with the phone's pop-up (mobile/
// MobileAnnouncementPopup) so both shells answer "have I seen this?" the same
// way. Category colours and CTA wording come from announcementCategory.ts,
// shared with every other announcement surface.
// ────────────────────────────────────────────────────────────────────────────

export function AnnouncementBanner() {
  // HUMAN posts only (owner 2026-08-08, "为什么一直有这个"). Machine notices
  // are bell material: they surface in NotificationBell instead, matching the
  // phone (whose pop-up has been human-only since owner 2026-07-20 B2).
  const {
    current,
    pendingCount,
    pendingIndex,
    mustAcknowledge,
    ack,
    dismissSession,
  } = useAnnouncementBanner({ scope: "human" });

  if (!current) return null;

  const category = categoryOf(current);
  const meta = CATEGORY_META[category];
  const Icon = meta.Icon;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="status"
      aria-live="polite"
    >
      {mustAcknowledge ? (
        <div className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]" />
      ) : (
        <button
          type="button"
          aria-label="Remind later"
          onClick={() => dismissSession(current)}
          className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[1px]"
        />
      )}
      <div
        className={cn(
          "relative w-full max-w-[520px] overflow-hidden rounded-2xl border bg-surface shadow-slab",
          meta.borderCls,
        )}
      >
        <span className={cn("absolute left-0 top-0 h-[3px] w-full", meta.railCls)} />
        <div className="max-h-[85vh] overflow-y-auto p-[22px]">
          <div className="mb-2.5 flex items-center gap-2.5">
            <div
              className={cn(
                "grid h-8 w-8 shrink-0 place-items-center rounded-full",
                meta.chipCls,
              )}
            >
              <Icon size={16} />
            </div>
            <span
              className={cn(
                "text-[10px] font-bold uppercase tracking-[.08em]",
                meta.textCls,
              )}
            >
              {meta.label}
            </span>
            {current.createdAt && (
              <>
                <span className="h-[3px] w-[3px] rounded-full bg-border" />
                <span className="font-mono text-[11px] text-ink-secondary">
                  {relativeTime(current.createdAt)}
                  {current.createdByName && ` · ${current.createdByName}`}
                </span>
              </>
            )}
            {pendingCount > 1 && (
              <span className="ml-auto rounded-full border border-border bg-surface-dim px-2 py-[2px] font-mono text-[9.5px] text-ink-muted">
                {pendingIndex} of {pendingCount} pending
              </span>
            )}
          </div>

          <div className="text-[16px] font-[680] leading-[1.35] text-ink">
            {current.title}
          </div>
          {current.bodyHtml ? (
            <LazySlot
              resetKey={`ann-rich:${current.id}`}
              fallback={
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-[1.7] text-ink-secondary">
                  {current.body}
                </p>
              }
            >
              <AnnouncementRichBody
                html={current.bodyHtml}
                text={current.body}
                annId={current.id}
                className="mt-2 text-[13px] leading-[1.7] text-ink-secondary"
              />
            </LazySlot>
          ) : (
            current.body && (
              <p className="mt-2 whitespace-pre-wrap text-[13px] leading-[1.7] text-ink-secondary">
                {current.body}
              </p>
            )
          )}
          {current.attachments && current.attachments.length > 0 && (
            <LazySlot resetKey={`ann-media:${current.id}`} fallback={null}>
              <AnnouncementMedia
                annId={current.id}
                attachments={current.attachments}
                layout={current.mediaLayout ?? null}
                className="mt-3.5"
              />
            </LazySlot>
          )}
          <div className="mt-[18px] flex items-center gap-2.5">
            <span className="text-[11px] font-semibold text-ink-secondary">
              {mustAcknowledge
                ? "This notice requires acknowledgement"
                : "You can postpone once"}
            </span>
            <div className="ml-auto flex gap-2">
              {!mustAcknowledge && (
                <button
                  type="button"
                  onClick={() => dismissSession(current)}
                  className="inline-flex h-9 items-center rounded-lg border border-border bg-surface px-3.5 text-[13px] font-[650] text-ink-secondary hover:bg-surface-dim hover:text-ink"
                >
                  Remind later
                </button>
              )}
              <button
                type="button"
                onClick={() => void ack(current)}
                className={cn(
                  "inline-flex h-9 items-center rounded-lg px-4 text-[13px] font-bold",
                  meta.solidCls,
                )}
              >
                {meta.ctaLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { Announcement as BannerNotice };
