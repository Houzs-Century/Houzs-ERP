import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoginsPayload } from "./LoginsPanel";

const state = vi.hoisted(() => ({ current: {} as { data?: unknown; loading: boolean; error: string | null } }));
vi.mock("../../hooks/useQuery", () => ({ useQuery: () => state.current }));
vi.mock("../../api/client", () => ({ api: { get: vi.fn() } }));

const { LoginsPanel } = await import("./LoginsPanel");

afterEach(cleanup);

const show = (data: LoginsPayload | undefined, error: string | null = null) => {
  state.current = { data, loading: false, error };
  render(<LoginsPanel />);
};

describe("LoginsPanel", () => {
  it("shows the totals, the verdict and both top lists", () => {
    show({
      ok: true,
      verdict: "critical",
      failed_24h: 42,
      failed_7d: 120,
      rate_limited_24h: 5,
      rate_limited_7d: 9,
      top_emails_24h: [
        { email: "boss@test.local", user_id: 3, failures: 31, last_attempt_at: new Date().toISOString() },
        { email: "nobody@test.local", user_id: null, failures: 11, last_attempt_at: new Date().toISOString() },
      ],
      top_ips_24h: [{ ip: "1.2.3.4", failures: 40, last_attempt_at: new Date().toISOString() }],
    });
    expect(screen.getByText("Critical")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.getByText("5 blocked by the rate limit")).toBeTruthy();
    expect(screen.getByText("boss@test.local")).toBeTruthy();
    expect(screen.getByText("user #3")).toBeTruthy();
    expect(screen.getByText("no such account")).toBeTruthy();
    expect(screen.getByText("1.2.3.4")).toBeTruthy();
  });

  it("says empty lists plainly", () => {
    show({ ok: true, verdict: "ok", failed_24h: 0, failed_7d: 0, rate_limited_24h: 0, rate_limited_7d: 0, top_emails_24h: [], top_ips_24h: [] });
    expect(screen.getByText("Normal")).toBeTruthy();
    expect(screen.getAllByText("No failed logins in the last 24 hours.")).toHaveLength(2);
  });

  it("shows the server's error instead of zeros", () => {
    show({ ok: false, error: "relation does not exist" });
    expect(screen.getByText("Could not load failed logins: relation does not exist.")).toBeTruthy();
  });
});
