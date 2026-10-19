import { describe, expect, it, vi } from "vitest";
import {
  agentFeature,
  aiUsageRow,
  buildAiUsageReport,
  costUsd,
  lastMonths,
  recordAi,
  recordAiError,
  recordAiResponse,
  usdToRm,
  type AiUsageTag,
  type EventAggRow,
} from "./aiUsage";
import { USD_TO_MYR_EST } from "./agent-console";
import type { Env } from "../types";

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const tag = { feature: "scan_so", model: "claude-sonnet-4-6", companyId: 1, userId: 7 };

describe("AI usage cost maths", () => {
  it("prices each token kind once at the Sonnet 4.6 rates", () => {
    expect(costUsd("claude-sonnet-4-6", { ...zero, inputTokens: 1_000_000 })).toBe(3);
    expect(costUsd("claude-sonnet-4-6", { ...zero, outputTokens: 1_000_000 })).toBe(15);
    expect(costUsd("claude-sonnet-4-6", { ...zero, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.3);
    expect(costUsd("claude-sonnet-4-6", { ...zero, cacheWriteTokens: 1_000_000 })).toBe(3.75);
  });

  it("prices an unknown model at the default model's rates", () => {
    expect(costUsd("some-future-model", { ...zero, inputTokens: 1_000_000 })).toBe(3);
  });

  it("converts with agent-console's rate", () => {
    expect(usdToRm(10)).toBeCloseTo(10 * USD_TO_MYR_EST);
  });
});

describe("aiUsageRow", () => {
  it("reads the usage block of a success", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      content: [],
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    });
    expect(aiUsageRow(tag, 200, body)).toEqual({
      feature: "scan_so", company_id: 1, user_id: 7, model: "claude-sonnet-4-6",
      input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40,
      ok: true, error: null, http_status: 200,
    });
  });

  it("records an HTTP error with its Anthropic error text", () => {
    const row = aiUsageRow(tag, 529, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    expect(row.ok).toBe(false);
    expect(row.error).toBe("overloaded_error: Overloaded");
    expect(row.http_status).toBe(529);
    expect(row.input_tokens).toBe(0);
  });

  it("records a thrown fetch with no status and a trimmed message", () => {
    const row = aiUsageRow(tag, null, new Error("x".repeat(900)));
    expect(row.ok).toBe(false);
    expect(row.http_status).toBeNull();
    expect(row.error!.length).toBe(500);
  });

  it("treats a non-JSON 200 as a failure", () => {
    const row = aiUsageRow(tag, 200, "<html>gateway</html>");
    expect(row.ok).toBe(false);
    expect(row.error).toBe("<html>gateway</html>");
  });
});

describe("recorder never throws into the caller", () => {
  const env = { DATABASE_URL: "" } as unknown as Env;
  const full: AiUsageTag = { env, ...tag, waitUntil: null };

  it("leaves the caller's body readable and resolves", async () => {
    const resp = new Response(JSON.stringify({ usage: { input_tokens: 1 } }), { status: 200 });
    await expect(recordAiResponse(full, resp)).resolves.toBeUndefined();
    expect(await resp.json()).toEqual({ usage: { input_tokens: 1 } });
  });

  it("survives a response-like mock with no clone() and a throwing waitUntil", async () => {
    const waitUntil = vi.fn(() => { throw new Error("no ctx"); });
    await expect(recordAiResponse({ ...full, waitUntil }, { status: 200 } as Response)).resolves.toBeUndefined();
    await expect(recordAiError({ ...full, waitUntil }, new Error("boom"))).resolves.toBeUndefined();
  });

  it("hands the write to waitUntil when there is one", async () => {
    const waitUntil = vi.fn();
    await recordAiError({ ...full, waitUntil }, new Error("boom"));
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});

describe("recordAi", () => {
  // A stub env.DB: the recorder must write through the invocation's own client
  // (one per request / cron run), never open its own.
  function stubEnv() {
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    const env = { DATABASE_URL: "postgres://stub", DB: { prepare } } as unknown as Env;
    return { env, prepare, bind };
  }

  it("returns the caller's response untouched and writes one row through the invocation's DB", async () => {
    const { env, prepare, bind } = stubEnv();
    const resp = new Response(JSON.stringify({ model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 7 } }), { status: 200 });
    const out = await recordAi({ env, ...tag, waitUntil: null }, Promise.resolve(resp));
    expect(out).toBe(resp);
    expect(await out.json()).toMatchObject({ usage: { input_tokens: 5 } });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toMatch(/INSERT INTO public\.ai_usage_events/);
    expect(bind).toHaveBeenCalledWith("scan_so", 1, 7, "claude-sonnet-4-6", 5, 7, 0, 0, true, null, 200);
  });

  it("rethrows a failed fetch after recording it once", async () => {
    const { env, prepare, bind } = stubEnv();
    const boom = new TypeError("network down");
    await expect(recordAi({ env, ...tag, waitUntil: null }, Promise.reject(boom))).rejects.toBe(boom);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(bind.mock.calls[0]).toEqual(["scan_so", 1, 7, "claude-sonnet-4-6", 0, 0, 0, 0, false, "TypeError: network down", null]);
  });

  it("a failed insert is swallowed, not thrown", async () => {
    const env = { DATABASE_URL: "postgres://stub", DB: { prepare: () => { throw new Error("db down"); } } } as unknown as Env;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resp = new Response("{}", { status: 200 });
    await expect(recordAi({ env, ...tag, waitUntil: null }, Promise.resolve(resp))).resolves.toBe(resp);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("month bucketing", () => {
  it("lists MYT months oldest first", () => {
    expect(lastMonths(new Date("2026-10-05T00:00:00Z"), 3)).toEqual(["2026-08", "2026-09", "2026-10"]);
  });

  it("uses the MYT month, not UTC, across the year end", () => {
    // 16:30 UTC on 31 Dec is already 1 Jan in Malaysia.
    expect(lastMonths(new Date("2026-12-31T16:30:00Z"), 2)).toEqual(["2026-12", "2027-01"]);
  });
});

describe("buildAiUsageReport", () => {
  const ev = (month: string, feature: string, companyId: number | null, inputTokens: number): EventAggRow => ({
    month, feature, companyId, companyName: companyId ? `Co ${companyId}` : null,
    model: "claude-sonnet-4-6", calls: 2, failures: 1, ...zero, inputTokens,
  });

  it("back-fills agents from agent_runs only before the first recorded month", () => {
    const report = buildAiUsageReport({
      months: ["2026-08", "2026-09", "2026-10"],
      // 2026-09-30 17:00 UTC = 1 Oct MYT, so October is the first recorded month.
      firstRecordedAt: "2026-09-30T17:00:00.000Z",
      events: [ev("2026-10", "scan_so", 1, 1_000_000), ev("2026-10", "agent:delivery", null, 0)],
      agentRuns: [
        { month: "2026-08", agent: "delivery-run", runs: 3, tokensIn: 1_000_000, tokensOut: 0 },
        { month: "2026-09", agent: "pms-brief", runs: 1, tokensIn: 0, tokensOut: 1_000_000 },
        // Same month as the first event: must NOT be added on top of events.
        { month: "2026-10", agent: "delivery-run", runs: 9, tokensIn: 5_000_000, tokensOut: 0 },
      ],
    });
    const [aug, sep, oct] = report.months;

    expect(aug.partial).toBe(true);
    expect(aug.note).toMatch(/Only agents/);
    expect(aug.features).toEqual([
      { feature: "agent:delivery", calls: 3, failures: 0, rm: 14.1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(aug.totalRm).toBe(14.1);
    expect(sep.features[0].feature).toBe("agent:pms");
    expect(sep.totalRm).toBe(70.5);

    expect(oct.partial).toBe(true);
    expect(oct.note).toBe("Recording started on 2026-10-01; earlier calls this month are not counted.");
    expect(oct.totalRm).toBe(14.1);
    expect(oct.features.map((f) => f.feature)).toEqual(["scan_so", "agent:delivery"]);
    expect(oct.companies).toEqual([
      { companyId: 1, companyName: "Co 1", rm: 14.1 },
      { companyId: null, companyName: null, rm: 0 },
    ]);
  });

  it("marks every month partial when nothing was recorded yet", () => {
    const report = buildAiUsageReport({ months: ["2026-09", "2026-10"], firstRecordedAt: null, events: [], agentRuns: [] });
    expect(report.months.every((m) => m.partial && m.totalRm === 0)).toBe(true);
  });

  it("a fully recorded month is not partial and sums features", () => {
    const report = buildAiUsageReport({
      months: ["2026-11"],
      firstRecordedAt: "2026-10-02T00:00:00.000Z",
      events: [ev("2026-11", "scan_so", 1, 1_000_000), ev("2026-11", "scan_so", 2, 1_000_000)],
      agentRuns: [],
    });
    const [nov] = report.months;
    expect(nov.partial).toBe(false);
    expect(nov.note).toBeNull();
    expect(nov.features).toHaveLength(1);
    expect(nov.features[0]).toMatchObject({ calls: 4, failures: 2, rm: 28.2 });
  });

  it("names agent features the same way as the live recorder", () => {
    expect(agentFeature("DELIVERY")).toBe("agent:delivery");
  });
});
