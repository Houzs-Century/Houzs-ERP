import { describe, expect, it } from "vitest";
import { classifyJob, classifyQueue, missedAfterMin, type JobFacts } from "./jobHealth";

const NOW = Date.parse("2026-10-05T10:00:00Z");
const minAgo = (m: number) => NOW - m * 60000;
const base: JobFacts = {
  cadenceMin: 5,
  lastStartMs: minAgo(2),
  lastStatus: "ok",
  lastDurationMs: 1000,
  median7dMs: 1000,
  samples7d: 100,
  failures24h: 0,
  nowMs: NOW,
};

describe("classifyJob", () => {
  it("is ok for a recent, normal, successful run", () => {
    expect(classifyJob(base).verdict).toBe("ok");
  });

  it("is critical when the last run failed, whatever else holds", () => {
    expect(classifyJob({ ...base, lastStatus: "error" }).verdict).toBe("critical");
  });

  it("is critical when a 5-minute job has not started for more than 12.5 minutes", () => {
    expect(classifyJob({ ...base, lastStartMs: minAgo(12) }).verdict).toBe("ok");
    expect(classifyJob({ ...base, lastStartMs: minAgo(13) }).verdict).toBe("critical");
  });

  it("gives a daily job 26 hours before it is missed", () => {
    const daily = { ...base, cadenceMin: 1440 };
    expect(missedAfterMin(1440)).toBe(26 * 60);
    expect(classifyJob({ ...daily, lastStartMs: minAgo(25 * 60) }).verdict).toBe("ok");
    expect(classifyJob({ ...daily, lastStartMs: minAgo(27 * 60) }).verdict).toBe("critical");
  });

  it("treats a run stuck at running past the missed window as critical, not before", () => {
    expect(classifyJob({ ...base, lastStatus: "running", lastStartMs: minAgo(3) }).verdict).toBe("ok");
    const stuck = classifyJob({ ...base, lastStatus: "running", lastStartMs: minAgo(20) });
    expect(stuck.verdict).toBe("critical");
    expect(stuck.reason).toMatch(/never finished/);
  });

  it("never applies the missed rule to a job outside the catalogue", () => {
    expect(classifyJob({ ...base, cadenceMin: null, lastStartMs: minAgo(10_000) }).verdict).toBe("ok");
  });

  it("warns on a slow run only with at least 20 samples and over 3x the median", () => {
    expect(classifyJob({ ...base, lastDurationMs: 3001 }).verdict).toBe("warning");
    expect(classifyJob({ ...base, lastDurationMs: 3000 }).verdict).toBe("ok");
    expect(classifyJob({ ...base, lastDurationMs: 9000, samples7d: 19 }).verdict).toBe("ok");
  });

  it("warns when a run failed in 24h but the last one was ok", () => {
    expect(classifyJob({ ...base, failures24h: 2 })).toEqual({
      verdict: "warning",
      reason: "2 failed run(s) in 24h; last run ok",
    });
  });

  it("warns when a catalogued job has no run recorded", () => {
    expect(classifyJob({ ...base, lastStartMs: null, lastStatus: null }).verdict).toBe("warning");
  });
});

describe("classifyQueue", () => {
  it("is ok when nothing waits long and nothing failed", () => {
    expect(classifyQueue({ oldestWaitingMin: null, failed: 0 }).verdict).toBe("ok");
    expect(classifyQueue({ oldestWaitingMin: 30, failed: 0 }).verdict).toBe("ok");
  });

  it("warns past 30 minutes and is critical past 2 hours", () => {
    expect(classifyQueue({ oldestWaitingMin: 31, failed: 0 }).verdict).toBe("warning");
    expect(classifyQueue({ oldestWaitingMin: 121, failed: 0 }).verdict).toBe("critical");
  });

  it("warns on any failed or dead item", () => {
    expect(classifyQueue({ oldestWaitingMin: 1, failed: 1 }).verdict).toBe("warning");
  });
});
