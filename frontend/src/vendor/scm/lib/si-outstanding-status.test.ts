import { describe, expect, it } from "vitest";
import { siIsCancelled, siOwesNothing } from "./si-outstanding";
import listSrc from "../../../pages/scm-v2/SalesInvoicesListV2.tsx?raw";

describe("which invoices count toward the money cards", () => {
  it("a cancelled or draft invoice owes nothing; only a cancelled one is worth nothing", () => {
    expect(siOwesNothing("CANCELLED")).toBe(true);
    expect(siOwesNothing("DRAFT")).toBe(true);
    expect(siOwesNothing("SENT")).toBe(false);
    expect(siOwesNothing("PAID")).toBe(false);
    expect(siIsCancelled("cancelled")).toBe(true);
    expect(siIsCancelled("DRAFT")).toBe(false);
    expect(siIsCancelled(null)).toBe(false);
  });

  it("the list's money cards skip cancelled rows and sum the same per-row figure as the column", () => {
    const money = listSrc.slice(listSrc.indexOf("const money = useMemo"), listSrc.indexOf("}, [visible.rows]);"));
    expect(money).toMatch(/if \(siIsCancelled\(r\.status\)\) continue;/);
    expect(money).toMatch(/outstandingSen \+= siOwesNothing\(r\.status\) \? 0 : siOutstandingSen\(/);
    expect(listSrc).toMatch(/const outstandingOf = \(r: SiRow\): number => siOwesNothing\(r\.status\) \? 0 :/);
  });
});
