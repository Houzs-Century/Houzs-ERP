import { describe, expect, it } from "vitest";
import { byStr } from "./mobile-list-compare";

/* B33 (sister: Hookka #289): the comparer is hoisted to one collator. The order
   must be exactly what the per-call localeCompare produced. */
const perCall = (a: unknown, b: unknown) =>
  String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });

function rows(n: number): unknown[] {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const words = ["SO", "so", "DO", "Ária", "apple", "Zebra", "ＡＢ", "沙发", "", "-", "10", "9"];
  const out: unknown[] = [null, undefined, 0, 12, "￿"];
  for (let i = 0; i < n; i++) {
    out.push(`${words[Math.floor(rnd() * words.length)]}-${Math.floor(rnd() * 3000)}${rnd() < 0.3 ? " b" : ""}`);
  }
  return out;
}

describe("byStr", () => {
  it("sorts numbers inside text by value", () => {
    expect(["SO-10", "SO-2", "SO-1"].sort(byStr)).toEqual(["SO-1", "SO-2", "SO-10"]);
  });

  it("gives the same sign as the per-call localeCompare on every pair", () => {
    const xs = rows(400);
    for (const a of xs) for (const b of xs) expect(Math.sign(byStr(a, b))).toBe(Math.sign(perCall(a, b)));
  });

  it("sorts 3,000 rows into the same order as before", () => {
    const xs = rows(3000);
    expect([...xs].sort(byStr)).toEqual([...xs].sort(perCall));
  });
});
