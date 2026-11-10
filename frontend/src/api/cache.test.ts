import { describe, expect, test } from "vitest";
import { getCached, invalidateForMutation, setCached } from "./cache";

describe("a write clears what reads it back", () => {
  test("a changed bill reference clears the Books not complete report", () => {
    setCached("/api/projects/data-gaps", { stale: true });
    invalidateForMutation("/api/project-sales-bills/12/rename-ref");
    expect(getCached("/api/projects/data-gaps")).toBeUndefined();
  });
  test("a write elsewhere leaves it cached", () => {
    setCached("/api/projects/data-gaps", { stale: false });
    invalidateForMutation("/api/fleet/12");
    expect(getCached("/api/projects/data-gaps")).toEqual({ stale: false });
  });
});

describe("an in-flight read is joined until it settles", () => {
  test("an older read settling does not drop the newer read that replaced it", async () => {
    const { getInflight, invalidate, setInflight } = await import("./cache");
    const key = "/api/scm/inflight-probe#co=1";
    let settleOld!: () => void;
    const older = new Promise<void>((r) => { settleOld = r; });
    setInflight(key, older);
    invalidate("/api/scm/inflight-probe");
    const newer = new Promise<void>(() => {});
    setInflight(key, newer);
    settleOld();
    await older;
    await Promise.resolve();
    expect(getInflight(key)).toBe(newer);
  });

  test("a read that settles clears its own entry", async () => {
    const { getInflight, setInflight } = await import("./cache");
    const key = "/api/scm/inflight-probe-2#co=1";
    const p = Promise.resolve("x");
    setInflight(key, p);
    await p;
    await Promise.resolve();
    expect(getInflight(key)).toBeUndefined();
  });
});
