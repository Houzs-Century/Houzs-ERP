import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { JobRow, QueueRow } from "./healthMeasures";

// No database in the light suite: getDb throws, so the measuring side reports
// every part as "could not be checked", which is itself the behaviour under test.
vi.mock("../db/client", () => ({
  getDb: () => {
    throw new Error("no database in tests");
  },
}));

const {
  HEALTH_HUB_JOB,
  aiCheck,
  aiFailureReason,
  buildHealthReport,
  emailCheck,
  healthProblems,
  jobsCheck,
  queuesCheck,
  sendHealthReportToHub,
} = await import("./healthHub");
const { hubTarget } = await import("./itHub");

const NOW = Date.parse("2026-11-08T10:00:00Z");

const job = (over: Partial<JobRow>): JobRow => ({
  job: "so-pull",
  cadence_min: 5,
  last_start: "2026-11-08T09:58:00.000Z",
  last_status: "ok",
  last_error: null,
  duration_ms: 100,
  runs_24h: 288,
  failures_24h: 0,
  verdict: "ok",
  reason: "",
  ...over,
});

const queue = (over: Partial<Extract<QueueRow, { ok: true }>>): QueueRow => ({
  name: "autocount_outbox",
  label: "AutoCount write-back",
  ok: true,
  waiting: 0,
  failed: 0,
  oldest_waiting_min: null,
  verdict: "ok",
  reason: "",
  ...over,
});

const ENV_OK = {
  IT_HUB_URL: "https://hub.example/",
  IT_HUB_AI_USAGE_COMPANY: "houzs",
  IT_HUB_API_KEY_HOUZS: " hub-key ",
} as unknown as Env;

describe("hubTarget", () => {
  it("needs the address, a valid company code and that company's key", () => {
    expect(hubTarget({} as Env)).toBeNull();
    expect(hubTarget({ IT_HUB_URL: "https://hub.example" } as Env)).toBeNull();
    expect(hubTarget({ IT_HUB_URL: "https://hub.example", IT_HUB_AI_USAGE_COMPANY: "HOUZS" } as Env)).toBeNull();
    expect(hubTarget({ IT_HUB_URL: "https://hub.example", IT_HUB_AI_USAGE_COMPANY: "../X", IT_HUB_API_KEY_X: "k" } as unknown as Env)).toBeNull();
    expect(hubTarget(ENV_OK)).toEqual({ base: "https://hub.example", key: "hub-key" });
  });
});

describe("emailCheck", () => {
  const outbox = (over: Partial<Extract<QueueRow, { ok: true }>>) => queue({ name: "email_outbox", label: "Email outbox", ...over });

  it("is red without the mail key, whatever the queue says", () => {
    expect(emailCheck(outbox({}), false)).toMatchObject({ key: "email", status: "critical", value: "No key" });
  });

  it("uses the Waiting queues verdict for the backlog", () => {
    expect(emailCheck(outbox({ waiting: 2 }), true)).toMatchObject({ status: "ok", value: "OK", summary: "2 waiting, 0 failed in 24h" });
    expect(
      emailCheck(outbox({ waiting: 7, oldest_waiting_min: 45, verdict: "warning", reason: "Oldest waiting item is 45 min old" }), true),
    ).toMatchObject({ status: "warning", value: "7", summary: "Oldest waiting item is 45 min old" });
  });

  it("says when the outbox could not be read", () => {
    expect(emailCheck({ name: "email_outbox", label: "Email outbox", ok: false, error: "boom" }, true)).toMatchObject({ status: "critical", summary: "Could not be checked." });
    expect(emailCheck(undefined, true).status).toBe("critical");
  });
});

describe("jobsCheck", () => {
  it("is green when every job is on time", () => {
    expect(jobsCheck([job({}), job({ job: "keepwarm" })])).toMatchObject({ status: "ok", value: "Running", summary: "2 jobs on time" });
  });

  it("names critical jobs first, then warnings, and leaves its own job out", () => {
    const c = jobsCheck([
      job({ job: "po-pull", verdict: "warning", reason: "1 failed run(s) in 24h; last run ok" }),
      job({ job: "so-pull", verdict: "critical", reason: "Last run failed" }),
      job({ job: HEALTH_HUB_JOB, verdict: "critical", reason: "Last run failed" }),
    ]);
    expect(c).toMatchObject({ status: "critical", value: "2 of 2", summary: "so-pull: Last run failed", detail: "po-pull: 1 failed run(s) in 24h; last run ok" });
  });
});

describe("queuesCheck", () => {
  it("ignores the email outbox, which has its own card", () => {
    const c = queuesCheck([
      queue({ name: "email_outbox", label: "Email outbox", verdict: "critical", reason: "old" }),
      queue({ waiting: 3 }),
    ]);
    expect(c).toMatchObject({ status: "ok", summary: "3 waiting across 1 queue" });
  });

  it("turns red for a critical or unreadable queue", () => {
    expect(queuesCheck([queue({ verdict: "warning", reason: "2 failed or dead" })])).toMatchObject({ status: "warning", summary: "AutoCount write-back: 2 failed or dead" });
    expect(queuesCheck([{ name: "scan_jobs", label: "Document scans (OCR)", ok: false, error: "x" }])).toMatchObject({ status: "critical", summary: "Document scans (OCR): could not be checked" });
  });
});

describe("aiCheck", () => {
  const stats = (over: Partial<{ lastSuccessAt: string | null; lastFailureAt: string | null; attempts24h: number; failures24h: number }>) => ({
    lastSuccessAt: "2026-11-08T09:50:00.000Z",
    lastFailureAt: null,
    attempts24h: 10,
    failures24h: 0,
    ...over,
  });

  it("is red without the Anthropic key", () => {
    expect(aiCheck(stats({}), [], false, NOW)).toMatchObject({ status: "critical", value: "No key" });
  });

  it("is idle with no calls", () => {
    expect(aiCheck(stats({ attempts24h: 0, lastSuccessAt: null }), [], true, NOW)).toMatchObject({ status: "ok", value: "Idle" });
  });

  it("is working when the newest call succeeded, even after earlier failures", () => {
    const c = aiCheck(
      stats({ failures24h: 1, lastFailureAt: "2026-11-08T08:00:00.000Z" }),
      [{ feature: "scan_so", model: "claude-sonnet-4-6", total: 10, failed: 1, latestOk: true, latestStatus: 200, latestError: null }],
      true,
      NOW,
    );
    expect(c).toMatchObject({ status: "ok", value: "Working", summary: "10 calls in 24h, 1 failed but working since", detail: "Models: claude-sonnet-4-6" });
  });

  it("names the failing feature and model with the reason, as the Services panel judges it", () => {
    const c = aiCheck(
      stats({ failures24h: 3, lastFailureAt: "2026-11-08T09:55:00.000Z" }),
      [
        { feature: "scan_so", model: "claude-sonnet-4-6", total: 5, failed: 3, latestOk: false, latestStatus: 401, latestError: "unauthorized" },
        { feature: "assistant", model: "claude-opus-4-6", total: 5, failed: 0, latestOk: true, latestStatus: 200, latestError: null },
      ],
      true,
      NOW,
    );
    expect(c).toMatchObject({
      status: "critical",
      value: "Problem",
      summary: "scan_so, claude-sonnet-4-6: 3 of 5 failed in 24h. Key wrong, expired or not allowed",
    });
  });
});

describe("aiFailureReason", () => {
  it("maps the statuses the sisters map", () => {
    expect(aiFailureReason(403)).toBe("Key wrong, expired or not allowed");
    expect(aiFailureReason(404)).toBe("Model not available");
    expect(aiFailureReason(429)).toBe("Rate limit reached");
    expect(aiFailureReason(529)).toBe("Anthropic overloaded");
    expect(aiFailureReason(502)).toBe("Anthropic error 502");
    expect(aiFailureReason(null)).toBe("Could not reach Anthropic");
  });
});

describe("healthProblems", () => {
  it("merges failed AI calls and failed jobs, newest first, with secrets scrubbed", () => {
    const p = healthProblems(
      [{ at: "2026-11-08T09:00:00.000Z", feature: "scan_so", model: "m", status: null, error: "fetch https://x.example/v1?key=abc failed" }],
      [
        job({ job: "so-pull", last_status: "error", last_start: "2026-11-08T09:30:00.000Z", last_error: "token=abcdef boom" }),
        job({ job: HEALTH_HUB_JOB, last_status: "error", last_start: "2026-11-08T09:59:00.000Z" }),
        job({ job: "keepwarm" }),
      ],
    );
    expect(p).toEqual([
      { at: "2026-11-08T09:30:00.000Z", what: "Background job failed", where: "so-pull", error: "token=[redacted] boom" },
      { at: "2026-11-08T09:00:00.000Z", what: "AI call failed", where: "scan_so, m", error: "fetch https://x.example/v1?[redacted] failed" },
    ]);
  });
});

describe("buildHealthReport", () => {
  const db = { ok: true, latency_ms: 4 };
  const card = (status: "ok" | "warning" | "critical") => ({ key: status, label: status, value: "", status, summary: "" });

  it("is ok only with a live database and no red card", () => {
    expect(buildHealthReport({ nowMs: NOW, db, checks: [card("ok"), card("warning")], problems: [], counts: {} }).ok).toBe(true);
    expect(buildHealthReport({ nowMs: NOW, db, checks: [card("critical")], problems: [], counts: {} }).ok).toBe(false);
    expect(buildHealthReport({ nowMs: NOW, db: { ok: false, latency_ms: 1, error: "x" }, checks: [], problems: [], counts: {} }).ok).toBe(false);
  });

  it("has exactly the sisters' top-level shape", () => {
    const r = buildHealthReport({ nowMs: NOW, db, checks: [], problems: [], counts: { ai_calls_24h: 1 } });
    expect(Object.keys(r).sort()).toEqual(["checks", "counts", "db", "ok", "problems", "time"]);
    expect(r.time).toBe("2026-11-08T10:00:00.000Z");
  });
});

describe("sendHealthReportToHub", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends nothing and throws nothing when the hub is not set up", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(sendHealthReportToHub({} as Env, NOW)).resolves.toEqual({ sent: false });
    await expect(sendHealthReportToHub({ IT_HUB_URL: "https://hub.example" } as Env, NOW)).resolves.toEqual({ sent: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to /api/v1/sys/health with the company key, and a dead database is a red report, not a missing one", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await sendHealthReportToHub({ ...ENV_OK, RESEND_API_KEY: "x", ANTHROPIC_API_KEY: "y" } as Env, NOW);
    expect(r).toEqual({ sent: true, ok: false, checks: 4 });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hub.example/api/v1/sys/health");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer hub-key");
    const body = JSON.parse(String(init.body));
    expect(body.db).toEqual({ ok: false, latency_ms: expect.any(Number), error: "Did not answer a live query" });
    expect(body.checks.map((c: { key: string; status: string }) => `${c.key}:${c.status}`)).toEqual([
      "email:critical",
      "queues:critical",
      "jobs:critical",
      "ai:critical",
    ]);
    expect(JSON.stringify(body)).not.toContain("no database in tests");
  });

  it("throws when the hub refuses, so the job run records the failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(sendHealthReportToHub(ENV_OK, NOW)).rejects.toThrow("hub answered HTTP 401");
  });
});
