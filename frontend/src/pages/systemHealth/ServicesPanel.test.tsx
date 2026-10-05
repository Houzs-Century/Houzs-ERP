import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServicesPanel, type ServiceRow } from "./ServicesPanel";

const { state } = vi.hoisted(() => ({ state: { data: null as unknown } }));

vi.mock("../../api/client", () => ({ api: { get: vi.fn() } }));
vi.mock("../../hooks/useQuery", () => ({
  useQuery: () => ({ data: state.data, loading: false, fetching: false, placeholder: false, error: null, reload: vi.fn() }),
}));

const row = (over: Partial<ServiceRow>): ServiceRow => ({
  key: "x", name: "X", status: "ok", ok: true, note: null,
  last_success_at: null, last_failure_at: null, last_error: null,
  attempts_24h: 0, failures_24h: 0, ...over,
});

describe("ServicesPanel", () => {
  it("shows one row per service with its pill, counts and error", () => {
    state.data = {
      ok: true,
      time: "2026-10-05T12:00:00Z",
      services: [
        row({ key: "email", name: "Email (Resend)", status: "critical", note: "last attempt failed", last_error: "resend 401", attempts_24h: 9, failures_24h: 3 }),
        row({ key: "ai", name: "AI (Anthropic)", status: "not_tracked_yet", attempts_24h: null, failures_24h: null }),
        row({ key: "wa", name: "WhatsApp (Seampify)", status: "unknown", ok: false, error: "timeout" }),
      ],
    };
    render(<ServicesPanel />);
    expect(screen.getByText("Email (Resend)")).toBeTruthy();
    expect(screen.getByText("Critical")).toBeTruthy();
    expect(screen.getByText("3 / 9")).toBeTruthy();
    expect(screen.getByText("last attempt failed · resend 401")).toBeTruthy();
    expect(screen.getByText("Not tracked")).toBeTruthy();
    expect(screen.getByText("Could not read: timeout")).toBeTruthy();
  });
});
