import { afterEach, describe, expect, it, vi } from "vitest";

const authedFetch = vi.fn();
vi.mock("./authed-fetch", () => ({ authedFetch: (...a: unknown[]) => authedFetch(...a) }));

import { armLorryDayScanToken } from "./packing-scan-token-arm";

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
