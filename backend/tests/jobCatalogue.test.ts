// Lives in tests/ because it reads the source tree, and backend/src is
// typechecked against the Workers runtime where node:fs does not exist.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOB_CADENCE_MIN } from "../src/services/jobHealth";

describe("JOB_CADENCE_MIN", () => {
  it("names exactly the jobs scheduled() tracks, so none reads as missed or never run", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const tracked = [...src.matchAll(/track\("([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
    expect(tracked).toEqual(Object.keys(JOB_CADENCE_MIN).sort());
  });
});
