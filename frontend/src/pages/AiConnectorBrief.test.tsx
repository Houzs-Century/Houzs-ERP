import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("../api/client", () => ({ api }));

import { BRIEF_TIMES, BriefEmails, type BriefView } from "./AiConnectorBrief";

const THRESHOLDS = { soOverdueMinRm: 5000, poOverdueMinRm: 5000, newlyOverdueDays: 2, slaNewlyPastHours: 24, stockNegative: true, repeatAfterDays: 7, maxLinesPerEmail: 15, batchPerRun: 10, runBudgetMs: 120000 };
const view = (over: Partial<BriefView> = {}): BriefView => ({
  allowed: true,
  email: "owner@erp.test",
  prefs: { briefEnabled: false, time: "08:00", days: "weekdays", alertsEnabled: false },
  lastBriefDay: null,
  schedule: { brief: "Checked every 15 minutes.", alerts: "Checked every 30 minutes." },
  ...over,
});

beforeEach(() => {
  api.get.mockResolvedValue(view());
  api.put.mockImplementation(async (_p: string, body: BriefView["prefs"]) => view({ prefs: body }));
  api.post.mockResolvedValue({ ok: true, sentTo: "owner@erp.test", items: 3 });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AI Connector: email me (brief + alerts)", () => {
  it("offers every quarter hour of the day", () => {
    expect(BRIEF_TIMES).toHaveLength(96);
    expect(BRIEF_TIMES[32]).toBe("08:00");
    expect(BRIEF_TIMES.at(-1)).toBe("23:45");
  });

  it("opts in with a time and days, and saves only what changed", async () => {
    render(<BriefEmails />);
    const brief = (await screen.findByRole("checkbox", { name: "Morning brief email" })) as HTMLInputElement;
    expect(brief.checked).toBe(false);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(brief);
    fireEvent.change(screen.getByLabelText("Time (Malaysia)"), { target: { value: "07:30" } });
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "daily" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/mcp-admin/me/brief", { briefEnabled: true, time: "07:30", days: "daily", alertsEnabled: false }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("sends a test brief and shows a refusal in plain words", async () => {
    render(<BriefEmails />);
    fireEvent.click(await screen.findByRole("button", { name: "Send me a test brief now" }));
    expect(await screen.findByText("Test brief sent to owner@erp.test.")).toBeTruthy();
    api.post.mockRejectedValueOnce(new Error("A test brief was sent in the last 5 minutes. Check your inbox."));
    fireEvent.click(screen.getByRole("button", { name: "Send me a test brief now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("last 5 minutes");
  });

  it("shows admins the thresholds read-only, and staff without access no switches", async () => {
    api.get.mockResolvedValueOnce(view({ thresholds: THRESHOLDS }));
    render(<BriefEmails />);
    expect(await screen.findByText("Alert thresholds (admin view, read-only)")).toBeTruthy();
    expect(screen.getAllByText("RM 5,000")).toHaveLength(2);
    cleanup();
    api.get.mockResolvedValueOnce(view({ allowed: false }));
    render(<BriefEmails />);
    expect(await screen.findByText("Available once AI Connector is turned on for you.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
