/* Owner 2026-10-26: the setup / dismantle Window read "26/10, 10:00" - day and
   month swapped against the app's date rule, and no end time. */
import { describe, expect, it } from "vitest";
import { detailRows, windowLabel } from "./delivery-job";

describe("job Window", () => {
  it("uses the app date-time format, and the end time on the same day", () => {
    expect(windowLabel("2026-10-26T02:00:00Z", "2026-10-26T10:00:00Z")).toBe("2026/10/26 10:00 – 18:00");
    expect(windowLabel("2026-10-26T02:00:00Z", "2026-10-27T05:00:00Z")).toBe("2026/10/26 10:00 – 2026/10/27 13:00");
    expect(windowLabel("2026-10-26T02:00:00Z", null)).toBe("2026/10/26 10:00");
  });
  it("is what a dismantle job shows", () => {
    const rows = detailRows({ kind: "DISMANTLE", window_start: "2026-10-26T02:00:00Z", window_end: "2026-10-26T10:00:00Z" });
    expect(rows.find(([k]) => k === "Window")?.[1]).toBe("2026/10/26 10:00 – 18:00");
  });
});
