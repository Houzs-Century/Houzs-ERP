import { describe, expect, test } from "vitest";
import { ageTone, alertDetail, statusTone } from "./PosSyncStatusTab";
import { kindTone } from "./PosImportBackupTab";

const NOW = Date.parse("2026-10-24T04:00:00Z");

describe("Sync Status colouring", () => {
  test("a stamp is fresh, stale or old by age, and muted when missing", () => {
    expect(ageTone(null, NOW, 1, 24)).toBe("muted");
    expect(ageTone("2026-10-24T03:30:00Z", NOW, 1, 24)).toBe("ok");
    expect(ageTone("2026-10-24T01:00:00Z", NOW, 1, 24)).toBe("warn");
    expect(ageTone("2026-10-20T01:00:00Z", NOW, 1, 24)).toBe("bad");
  });
  test("status words map to the pill tones of the layout", () => {
    expect(statusTone("SYNCED")).toBe("ok");
    expect(statusTone("PENDING")).toBe("info");
    expect(statusTone("PENDING > 3D")).toBe("warn");
    expect(statusTone("DATA LOST")).toBe("bad");
    expect(statusTone("INACTIVE")).toBe("muted");
  });
  test("alert detail reads the watchdog's detail json", () => {
    expect(alertDetail({ type: "DATA_LOST", detail: { last_known_pending_count: 7, last_known_pending_sen: 123400 } })).toContain("7 bill(s)");
    expect(alertDetail({ type: "PENDING_STALE", detail: { pending_count: 2, pending_amount_sen: 5000, days_since_sync: 4 } })).toContain("4 day(s)");
    expect(alertDetail({ type: "EVENT_ENDED_PENDING", detail: { pending_count: 1, pending_amount_sen: 100, event_end: "2026-10-20", never_synced: true } })).toContain("never synced");
  });
  test("import preview kinds", () => {
    expect(kindTone("NEW")).toBe("ok");
    expect(kindTone("CONFLICT")).toBe("bad");
    expect(kindTone("INVALID")).toBe("warn");
  });
});
