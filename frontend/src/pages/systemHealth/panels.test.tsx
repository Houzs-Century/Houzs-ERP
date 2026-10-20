import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobsPanel } from "./JobsPanel";
import { QueuesPanel } from "./QueuesPanel";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../../api/client", () => ({ api: { get: apiGet } }));
// A minimal useQuery: fetch once on mount.
vi.mock("../../hooks/useQuery", async () => {
  const React = await import("react");
  return {
    useQuery: (_key: string, fn: () => Promise<unknown>) => {
      const [data, setData] = React.useState<unknown>(null);
      React.useEffect(() => {
        void fn().then(setData);
      }, []);
      return { data, loading: data === null, error: null, fetching: false, placeholder: false, reload: () => {} };
    },
  };
});

beforeEach(() => apiGet.mockReset());

describe("JobsPanel", () => {
  it("shows one row per job with its verdict pill", async () => {
    apiGet.mockResolvedValue({
      ok: true,
      data: [
        { job: "email-outbox", cadence_min: 5, last_start: "2026-10-05T09:58:00Z", last_status: "ok", last_error: null,
          duration_ms: 1200, runs_24h: 288, failures_24h: 0, verdict: "ok", reason: "" },
        { job: "sla", cadence_min: 1440, last_start: "2026-10-05T02:00:00Z", last_status: "error", last_error: "boom",
          duration_ms: 50, runs_24h: 1, failures_24h: 1, verdict: "critical", reason: "Last run failed" },
      ],
    });
    render(<JobsPanel />);
    expect(await screen.findByText("email-outbox")).toBeTruthy();
    expect(screen.getByText("Critical")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("2 jobs · 1 need attention")).toBeTruthy();
  });

  it("says so when the endpoint reports a failure", async () => {
    apiGet.mockResolvedValue({ ok: false, error: "db down", data: [] });
    render(<JobsPanel />);
    expect(await screen.findByText("Could not load background jobs: db down.")).toBeTruthy();
  });
});

describe("QueuesPanel", () => {
  it("shows each queue, a per-queue read failure, and the failed slip scan count", async () => {
    apiGet.mockResolvedValue({
      ok: true,
      queues: [
        { name: "email_outbox", label: "Email outbox", ok: true, waiting: 3, failed: 0, oldest_waiting_min: 45,
          verdict: "warning", reason: "Oldest waiting item is 45 min old" },
        { name: "scan_jobs", label: "Document scans (OCR)", ok: false, error: "timeout" },
      ],
      failed_slip_scans: { ok: true, count_7d: 2 },
    });
    render(<QueuesPanel />);
    expect(await screen.findByText("Email outbox")).toBeTruthy();
    expect(screen.getByText("Warning")).toBeTruthy();
    expect(screen.getByText("45 min")).toBeTruthy();
    expect(screen.getByText("Could not read: timeout")).toBeTruthy();
    expect(screen.getByText("Failed order-slip scans, 7 days: 2")).toBeTruthy();
  });
});
