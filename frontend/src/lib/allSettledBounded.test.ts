import { describe, expect, it } from "vitest";
import { allSettledBounded } from "./allSettledBounded";

describe("allSettledBounded", () => {
  it("never exceeds the requested concurrency and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const tasks = Array.from({ length: 8 }, (_, index) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return index;
    });

    const pending = allSettledBounded(tasks, 3);
    await Promise.resolve();
    expect(active).toBe(3);

    while (releases.length > 0 || active > 0) {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(peak).toBe(3);
    expect(await pending).toEqual(
      Array.from({ length: 8 }, (_, value) => ({ status: "fulfilled", value })),
    );
  });

  it("settles failures without preventing later tasks from running", async () => {
    const results = await allSettledBounded([
      async () => "first",
      async () => { throw new Error("nope"); },
      async () => "last",
    ], 2);

    expect(results[0]).toEqual({ status: "fulfilled", value: "first" });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: "last" });
  });

  it("uses one worker for an invalid concurrency value", async () => {
    const order: string[] = [];
    await allSettledBounded([
      async () => { order.push("a"); },
      async () => { order.push("b"); },
    ], Number.NaN);
    expect(order).toEqual(["a", "b"]);
  });
});
