import { describe, expect, test } from "vitest";
import { afterWrongPin, findCashierById, fmtMyt, freshLock, lockedFor, loginTiles, syncTone } from "./loginRules";
import type { BundleCashier } from "./types";

const c = (code: string, role: BundleCashier["role"] = "PARTTIME"): BundleCashier => ({ id: Number(code.slice(1)), code, name: `Name ${code}`, role, pin_hash: "x$y", max_discount_pct: 0 });

describe("loginRules", () => {
  test("eight tiles, supervisors first, the rest behind Type ID", () => {
    const all = [c("C09"), c("C01"), c("C02", "SUPERVISOR"), c("C03"), c("C04"), c("C05"), c("C06"), c("C07"), c("C08")];
    const { tiles, overflow } = loginTiles(all);
    expect(tiles.map((t) => t.code)).toEqual(["C02", "C01", "C03", "C04", "C05", "C06", "C07", "C08"]);
    expect(overflow.map((t) => t.code)).toEqual(["C09"]);
    expect(findCashierById(all, " c09 ")?.code).toBe("C09");
    expect(findCashierById(all, "name c03")?.code).toBe("C03");
    expect(findCashierById(all, "zzz")).toBeNull();
  });

  test("five wrong PINs lock for 30 s, then the count starts over", () => {
    let s = freshLock();
    for (let i = 0; i < 4; i++) s = afterWrongPin(s, 1000);
    expect(s.failures).toBe(4);
    expect(lockedFor(s, 1000)).toBe(0);
    s = afterWrongPin(s, 1000);
    expect(s.failures).toBe(0);
    expect(lockedFor(s, 1000)).toBe(30);
    expect(lockedFor(s, 16_000)).toBe(15);
    expect(lockedFor(s, 31_001)).toBe(0);
  });

  test("last sync colour", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    expect(syncTone(null, now)).toBe("none");
    expect(syncTone("2026-10-14T01:00:00Z", now)).toBe("green");
    expect(syncTone("2026-10-12T12:00:00Z", now)).toBe("amber");
    expect(syncTone("2026-10-10T11:00:00Z", now)).toBe("red");
  });

  test("Malaysia time formatting", () => {
    expect(fmtMyt("2026-10-14T13:31:00Z")).toBe("14/10/2026 09:31 PM");
    expect(fmtMyt("2026-10-14T16:05:00Z")).toBe("15/10/2026 12:05 AM");
    expect(fmtMyt(null)).toBe("--");
  });
});
