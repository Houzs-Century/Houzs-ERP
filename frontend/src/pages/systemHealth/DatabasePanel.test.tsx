import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DatabasePanel, formatBytes, type DatabaseHealth } from "./DatabasePanel";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../../api/client", () => ({ api: { get: apiGet } }));
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

const PAYLOAD: DatabaseHealth = {
  ok: true,
  checkedAt: "2026-10-05T02:00:00Z",
  limitedVisibility: true,
  visibilityNote: "May not look inside 3 other session(s).",
  longTransactions: {
    ok: true,
    value: 1,
    limit: null,
    threshold: "over 30 s",
    verdict: "critical",
    sessions: [{ seconds: 420, state: "idle in transaction", waitEventType: null, query: "UPDATE orders SET x = 1" }],
  },
  lockWaits: { ok: false, error: "canceling statement due to statement timeout" },
  connections: { ok: true, value: 45, limit: 60, threshold: "70%", verdict: "warning", maxConnections: 60, poolerCap: 60 },
  databaseSize: {
    ok: true,
    value: 2 * 1024 ** 3,
    limit: null,
    threshold: "info",
    verdict: "ok",
    largestTables: [{ name: "public.audit_events", bytes: 512 * 1024 ** 2 }],
  },
  tempFiles: { ok: true, value: 0, limit: null, threshold: "info", verdict: "ok", tempFiles: 0, statsReset: null },
};

describe("DatabasePanel", () => {
  it("shows each verdict, the limit, the failed metric and the visibility note", async () => {
    apiGet.mockResolvedValue(PAYLOAD);
    render(<DatabasePanel />);

    expect(await screen.findByText("Critical")).toBeTruthy();
    expect(screen.getByText("Warning")).toBeTruthy();
    expect(screen.getByText("/ 60")).toBeTruthy();
    expect(screen.getByText(/statement timeout/)).toBeTruthy();
    expect(screen.getByText(/3 other session/)).toBeTruthy();
    expect(screen.getByText("UPDATE orders SET x = 1")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith("/api/admin/health/database");
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
  });
});
