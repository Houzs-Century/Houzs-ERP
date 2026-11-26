
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
