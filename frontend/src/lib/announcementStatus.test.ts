import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_STATUS_LABEL,
  announcementExpired,
  announcementStatus,
} from "./announcementStatus";

const NOW = Date.parse("2026-08-21T00:00:00Z");

describe("announcementStatus", () => {
  it("calls an active, never-expiring notice live", () => {
    expect(announcementStatus({ isActive: true, expiresAt: null }, NOW)).toBe("live");
    expect(announcementStatus({ isActive: true }, NOW)).toBe("live");
  });

  it("calls a past expiry expired", () => {
    expect(announcementStatus({ isActive: true, expiresAt: "2026-08-20T23:59:59Z" }, NOW)).toBe("expired");
  });

  it("treats the boundary instant as already expired, like the backend does", () => {
    // backend/src/routes/announcements.ts `notExpired` is the authority; a UI
    // that said "Live" here would badge a notice the server no longer serves.
    expect(announcementExpired({ isActive: true, expiresAt: "2026-08-21T00:00:00Z" }, NOW)).toBe(true);
  });

  it("hidden outranks expired", () => {
    expect(
      announcementStatus({ isActive: false, expiresAt: "2026-08-20T00:00:00Z" }, NOW),
    ).toBe("hidden");
  });

  it("does not guess 'expired' from an unparseable stamp", () => {
    expect(announcementExpired({ isActive: true, expiresAt: "not a date" }, NOW)).toBe(false);
    expect(announcementStatus({ isActive: true, expiresAt: "" }, NOW)).toBe("live");
  });

  it("labels every status", () => {
    expect(ANNOUNCEMENT_STATUS_LABEL.live).toBe("Live");
    expect(ANNOUNCEMENT_STATUS_LABEL.hidden).toBe("Hidden");
    expect(ANNOUNCEMENT_STATUS_LABEL.expired).toBe("Expired");
  });
});
