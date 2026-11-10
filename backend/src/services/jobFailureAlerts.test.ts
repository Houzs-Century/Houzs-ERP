import { describe, expect, it } from "vitest";
import type { DB } from "../db/client";
import { readJobs, type JobRow } from "./healthMeasures";
import { JOB_CADENCE_MIN } from "./jobHealth";
import {
  JOB_ALERT_COOLDOWN_MS, jobAlertBody, jobAlertTitle, jobFromAlertTitle, pickJobAlerts,
} from "./jobFailureAlerts";

const NOW = Date.parse("2026-11-10T10:00:00Z");
const H = 3600_000;
const job = (name: string, verdict: JobRow["verdict"], reason = "Last run failed"): JobRow => ({
  job: name, cadence_min: 5, last_start: null, last_status: verdict === "critical" ? "error" : "ok", last_error: null,
  duration_ms: null, runs_24h: 0, failures_24h: 0, verdict, reason,
});

describe("alert dedupe", () => {
  it("a critical job with no alert yet is alerted; ok and warning jobs never are", () => {
    const jobs = [job("so-pull", "critical"), job("keepwarm", "ok"), job("po-pull", "warning", "No run recorded in the last 14 days")];
    expect(pickJobAlerts(jobs, new Map(), new Map(), NOW).map((j) => j.job)).toEqual(["so-pull"]);
  });

  it("still failing after the alert: no second alert, however long it lasts", () => {
    const lastOk = new Map([["so-pull", NOW - 30 * H]]);
    const lastAlert = new Map([["so-pull", NOW - 29 * H]]);
    expect(pickJobAlerts([job("so-pull", "critical")], lastOk, lastAlert, NOW)).toEqual([]);
    expect(pickJobAlerts([job("so-pull", "critical")], new Map(), lastAlert, NOW)).toEqual([]);
  });

  it("recovered and failed again: a new incident, alerted once the cool-down has passed", () => {
    const lastAlert = new Map([["so-pull", NOW - 8 * H]]);
    const lastOk = new Map([["so-pull", NOW - 2 * H]]);
    expect(pickJobAlerts([job("so-pull", "critical")], lastOk, lastAlert, NOW).map((j) => j.job)).toEqual(["so-pull"]);
  });

  it("a job that flaps inside the cool-down is not alerted again", () => {
    const lastAlert = new Map([["so-pull", NOW - JOB_ALERT_COOLDOWN_MS + 60_000]]);
    const lastOk = new Map([["so-pull", NOW - 10 * 60_000]]);
    expect(pickJobAlerts([job("so-pull", "critical")], lastOk, lastAlert, NOW)).toEqual([]);
  });

  it("the alert title carries the job name, so the next pass can read it back", () => {
    expect(jobFromAlertTitle(jobAlertTitle("mrp-snapshot"))).toBe("mrp-snapshot");
    expect(jobFromAlertTitle("Something else")).toBeNull();
  });

  it("the body scrubs credentials out of the last error", () => {
    const body = jobAlertBody({ ...job("so-pull", "critical"), last_error: "fetch https://host/x?key=abc123 failed token=sekret" });
    expect(body).not.toContain("abc123");
    expect(body).not.toContain("sekret");
    expect(body).toContain("Last run failed.");
  });
});

describe("job classification reuse", () => {
  /** A fake DB whose job_runs read returns these rows: what readJobs (the
   *  System Health panel's own read) sees. */
  const fakeDb = (rows: Array<Record<string, unknown>>) => ({ execute: async () => rows }) as unknown as DB;
  const run = (job: string, startedMinAgo: number, status: string) => ({
    job, started_at: new Date(NOW - startedMinAgo * 60_000).toISOString(), status, error: status === "error" ? "boom" : null,
    duration_ms: 100, runs_24h: 10, failures_24h: status === "error" ? 1 : 0, median_ms: 100, samples_7d: 50,
  });

  it("alerts exactly the jobs System Health marks critical: failed, missed and never-finished", async () => {
    const healthy = Object.keys(JOB_CADENCE_MIN).map((j) => run(j, 1, "ok"));
    const rows = healthy
      .filter((r) => !["so-pull", "mrp-snapshot", "stock-close", "keepwarm"].includes(r.job))
      .concat([
        run("so-pull", 2, "error"), // AutoCount pull: last run failed
        run("mrp-snapshot", 15 * 3 + 5, "ok"), // missed: 15-min job, last start 50 min ago
        run("stock-close", 27 * 60, "running"), // daily job that never finished
        run("keepwarm", 1, "running"), // running now: fine
      ]);
    const jobs = await readJobs(fakeDb(rows), NOW);
    const critical = jobs.filter((j) => j.verdict === "critical").map((j) => j.job).sort();
    expect(critical).toEqual(["mrp-snapshot", "so-pull", "stock-close"]);
    const alerted = pickJobAlerts(jobs, new Map(), new Map(), NOW).map((j) => j.job).sort();
    expect(alerted).toEqual(critical);
  });
});
