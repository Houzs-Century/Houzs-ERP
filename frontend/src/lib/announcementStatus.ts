/* ---------------------------------------------------------------------------
 * announcementStatus — is this notice LIVE, HIDDEN or EXPIRED?
 *
 * WHY THIS IS A SHARED MODULE AND NOT TWO COPIES. The phone and the desktop
 * page are one product (CLAUDE.md, "Desktop and mobile are one product"), and
 * this repo's most expensive recurring defect is a rule that exists on one
 * surface and was re-derived — or simply never written — on the other. The
 * announcements pair had BOTH halves of that: desktop badged Hidden/Expired
 * from an inline expression in its row component, and the phone had ZERO
 * references to expiry anywhere in the file, so a notice a manager had hidden
 * was invisible to them on their own phone.
 *
 * Two rules the callers must not re-derive:
 *
 *   1. `isActive === false` OUTRANKS expiry. A notice both hidden and expired
 *      reads "Hidden", because hidden is the thing a person did and expiry is
 *      the thing that happened. Desktop has always ordered it this way.
 *   2. Expiry is `expiresAt <= now`, i.e. the boundary instant is ALREADY
 *      expired — matching the backend's own `notExpired` in
 *      `backend/src/routes/announcements.ts`, which is what decides whether a
 *      reader is served the notice at all. A UI that drew the boundary one
 *      microsecond the other way would badge a notice "Live" that the server
 *      had already stopped delivering.
 * ------------------------------------------------------------------------- */

export type AnnouncementStatus = "live" | "hidden" | "expired";

/** The two fields this rule reads. Both surfaces' row types are wider. */
export type AnnouncementStatusInput = {
  isActive: boolean;
  expiresAt?: string | null;
};

/** True once the expiry instant has been reached. NULL/absent = never expires. */
export function announcementExpired(
  a: AnnouncementStatusInput,
  now: number = Date.now(),
): boolean {
  const raw = a.expiresAt;
  if (raw == null || raw === "") return false;
  const t = Date.parse(raw);
  // An unparseable stamp is NOT treated as expired: the honest reading of a
  // value we cannot understand is "we do not know", and guessing "expired"
  // would take a live notice off the reader's screen on a parse bug.
  return Number.isFinite(t) && t <= now;
}

export function announcementStatus(
  a: AnnouncementStatusInput,
  now: number = Date.now(),
): AnnouncementStatus {
  if (!a.isActive) return "hidden";
  return announcementExpired(a, now) ? "expired" : "live";
}

/** The words both surfaces show. Changing one changes both, which is the point. */
export const ANNOUNCEMENT_STATUS_LABEL: Record<AnnouncementStatus, string> = {
  live: "Live",
  hidden: "Hidden",
  expired: "Expired",
};
