import { afterEach, describe, expect, it, vi } from "vitest";

const authedFetch = vi.fn();
vi.mock("./authed-fetch", () => ({ authedFetch: (...a: unknown[]) => authedFetch(...a) }));

import { armLorryDayScanToken, armRegionDayScanToken } from "./packing-scan-token-arm";

afterEach(() => authedFetch.mockReset());

describe("armLorryDayScanToken", () => {
  it("asks for the sheet's token with its plate, date and printed DO ids in order", async () => {
    authedFetch.mockResolvedValue({ scanToken: "k7m2n9p4q8" });
    const token = await armLorryDayScanToken({ lorryPlate: " VJK 8821 ", deliveryDate: "2026-11-28", doIds: ["b", "a"] });
    expect(token).toBe("k7m2n9p4q8");
    const url = String(authedFetch.mock.calls[0]![0]);
    expect(url.startsWith("/trips/lorry-day-scan-token?")).toBe(true);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("plate")).toBe("VJK 8821");
    expect(q.get("date")).toBe("2026-11-28");
    expect(q.get("doIds")).toBe("b,a");
  });

  it("returns null (no QR) when the sheet has no plate or no DOs, without asking", async () => {
    expect(await armLorryDayScanToken({ lorryPlate: "", deliveryDate: "2026-11-28", doIds: ["a"] })).toBeNull();
    expect(await armLorryDayScanToken({ lorryPlate: "VJK 8821", deliveryDate: "2026-11-28", doIds: [] })).toBeNull();
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it("returns null when the server refuses", async () => {
    authedFetch.mockRejectedValue(new Error("404"));
    expect(await armLorryDayScanToken({ lorryPlate: "VJK 8821", deliveryDate: "2026-11-28", doIds: ["a"] })).toBeNull();
  });
});

describe("armRegionDayScanToken", () => {
  it("asks for the region sheet's token with its region key, date and printed DO ids in order", async () => {
    authedFetch.mockResolvedValue({ scanToken: "r7m2n9p4q8" });
    const token = await armRegionDayScanToken({ region: " KL ", deliveryDate: "2026-11-28", doIds: ["b", "a"] });
    expect(token).toBe("r7m2n9p4q8");
    const url = String(authedFetch.mock.calls[0]![0]);
    expect(url.startsWith("/trips/region-day-scan-token?")).toBe(true);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("region")).toBe("KL");
    expect(q.get("doIds")).toBe("b,a");
  });

  it("returns null without asking for no region, no DOs, or more than 60 DOs", async () => {
    expect(await armRegionDayScanToken({ region: "", deliveryDate: "2026-11-28", doIds: ["a"] })).toBeNull();
    expect(await armRegionDayScanToken({ region: "KL", deliveryDate: "2026-11-28", doIds: [] })).toBeNull();
    const many = Array.from({ length: 61 }, (_, i) => `d${i}`);
    expect(await armRegionDayScanToken({ region: "KL", deliveryDate: "2026-11-28", doIds: many })).toBeNull();
    expect(authedFetch).not.toHaveBeenCalled();
  });
});
