import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HubReportLine, hubReportText } from "./HubReportLine";

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

beforeEach(() => apiGet.mockReset());

const ago = (iso: string) => `at ${iso.slice(11, 16)}`;

describe("hubReportText", () => {
  it("says when it is not set up, without alarm", () => {
    expect(hubReportText({ ok: true, configured: false, last_success_at: null, last_failure_at: null, last_error: null }, ago)).toEqual({
      text: "Not set up on this system (IT Hub address or key missing), so nothing is sent",
      bad: false,
    });
  });

  it("shows the last send when the newest attempt went through", () => {
    expect(
      hubReportText(
        { ok: true, configured: true, last_success_at: "2026-11-08T10:05:00Z", last_failure_at: "2026-11-08T09:00:00Z", last_error: "x" },
        ago,
      ),
    ).toEqual({ text: "Last sent at 10:05, every 5 minutes", bad: false });
  });

  it("is bad news when the newest attempt failed, with the reason and the last good send", () => {
    expect(
      hubReportText(
        { ok: true, configured: true, last_success_at: "2026-11-08T09:00:00Z", last_failure_at: "2026-11-08T10:05:00Z", last_error: "hub answered HTTP 401" },
        ago,
      ),
    ).toEqual({ text: "Last attempt failed at 10:05: hub answered HTTP 401 · last sent at 09:00", bad: true });
  });

  it("is bad news when set up but never sent, or unreadable", () => {
    expect(hubReportText({ ok: true, configured: true, last_success_at: null, last_failure_at: null, last_error: null }, ago).bad).toBe(true);
    expect(hubReportText({ ok: false, configured: true, error: "db down" }, ago)).toEqual({ text: "Could not load (db down)", bad: true });
  });
});

describe("HubReportLine", () => {
  it("renders the line from /api/admin/health/hub-report", async () => {
    apiGet.mockResolvedValue({ ok: true, configured: false, last_success_at: null, last_failure_at: null, last_error: null });
    render(<HubReportLine />);
    expect(await screen.findByText("Health report to IT Hub")).toBeTruthy();
    expect(screen.getByText(/Not set up on this system/)).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith("/api/admin/health/hub-report");
  });
});
