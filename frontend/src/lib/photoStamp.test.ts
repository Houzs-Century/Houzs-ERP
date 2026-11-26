import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLOCK_TTL_MS, resetStampClock, stampLines, stampNow, stampPhoto } from "./photoStamp";

const res = (date: string | null) => ({ headers: { get: (n: string) => (n === "Date" ? date : null) } });

describe("stampNow", () => {
  beforeEach(() => resetStampClock());

  it("uses the server's Date header, not the phone clock", async () => {
    const phone = Date.parse("2026-11-07T06:00:00Z");
    const clock = await stampNow(async () => res("Sun, 08 Nov 2026 06:00:00 GMT"), () => phone);
    expect(clock.source).toBe("server");
    expect(clock.at.toISOString()).toBe("2026-11-08T06:00:00.000Z");
  });

  it("asks the server once per few minutes, then again after the TTL", async () => {
    let phone = Date.parse("2026-11-08T06:00:00Z");
    const fetcher = vi.fn(async () => res("Sun, 08 Nov 2026 06:00:10 GMT"));
    await stampNow(fetcher, () => phone);
    phone += 60_000;
    const again = await stampNow(fetcher, () => phone);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(again.at.toISOString()).toBe("2026-11-08T06:01:10.000Z");
    phone += CLOCK_TTL_MS + 1;
    await stampNow(fetcher, () => phone);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back to the phone clock, marked as such, when the server cannot be read", async () => {
    const phone = Date.parse("2026-11-08T06:00:00Z");
    const offline = await stampNow(async () => { throw new Error("offline"); }, () => phone);
    expect(offline).toEqual({ at: new Date(phone), source: "device" });
    const hidden = await stampNow(async () => res(null), () => phone);
    expect(hidden.source).toBe("device");
  });
});

describe("stampLines", () => {
  it("prints the job number and the Malaysia date and time", () => {
    expect(stampLines("DO-2611-0042", { at: new Date("2026-11-07T22:30:00Z"), source: "server" }))
      .toEqual(["DO-2611-0042", "2026/11/08 06:30"]);
  });

  it("marks the phone's own clock", () => {
    expect(stampLines("SETUP", { at: new Date("2026-11-08T02:05:00Z"), source: "device" })[1]).toBe("2026/11/08 10:05 (phone time)");
  });

  it("drops an empty label", () => {
    expect(stampLines(null, { at: new Date("2026-11-08T02:05:00Z"), source: "server" })).toEqual(["2026/11/08 10:05"]);
  });
});

describe("stampPhoto", () => {
  it("passes a file the browser cannot draw through unchanged", async () => {
    const f = new File(["x"], "a.jpg", { type: "image/jpeg" });
    expect(await stampPhoto(f, ["DO-1"])).toBe(f);
    const pdf = new File(["%PDF"], "a.pdf", { type: "application/pdf" });
    expect(await stampPhoto(pdf, ["DO-1"])).toBe(pdf);
  });
});
