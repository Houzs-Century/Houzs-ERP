import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn(), del: vi.fn() } }));
vi.mock("../api/client", () => ({ api }));

import { AiConnector } from "./AiConnector";

const ME = { allowed: true, isAdmin: true, pendingRequest: null, connectorUrl: "https://erp.test/api/mcp", apps: [] };
const overview = (actionsEnabled: boolean) => ({
  connectorUrl: "https://erp.test/api/mcp",
  actionsEnabled,
  actionSwitches: { mailReply: replyOn, note: false },
  stats: { connectedPeople: 0, callsToday: 2, refusedToday: 0, waiting: 0 },
  requests: [],
  connected: [],
  allowed: [],
  calls: [{ id: "k1", userId: 3, name: "Adrian", app: "Claude", tool: "propose_email", target: 'propose email to a@b.test: "Quote"', status: 200, ok: true, note: "", ms: 40, at: "2026-11-26T02:00:00Z" }],
  staff: [],
});

let on = false;
let replyOn = false;
beforeEach(() => {
  on = false;
  replyOn = false;
  api.get.mockImplementation(async (path: string) => {
    if (path === "/api/mcp-admin/me") return ME;
    if (path === "/api/mcp-admin/admin/overview") return overview(on);
    throw new Error(`unexpected ${path}`);
  });
  api.post.mockImplementation(async (path: string, body: { enabled?: boolean; kind?: string }) => {
    if (path === "/api/mcp-admin/admin/actions" && body.kind === "mail_reply") replyOn = body.enabled === true;
    else if (path === "/api/mcp-admin/admin/actions") on = body.enabled === true;
    return { ok: true };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AI Connector admin: AI actions switch", () => {
  it("starts OFF, turns on with the admin's click, and lists actions under Recent lookups", async () => {
    render(<AiConnector />);
    const box = (await screen.findByRole("checkbox", { name: "Allow AI actions (meetings, email)" })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText("Off: connected AIs can only read.")).toBeTruthy();
    expect(screen.getByText(/propose_email/)).toBeTruthy();

    fireEvent.click(box);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/mcp-admin/admin/actions", { enabled: true }));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: "Allow AI actions (meetings, email)" }) as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText(/On: connected AIs may propose/)).toBeTruthy();
  });

  it("each new action has its own switch, OFF by default", async () => {
    render(<AiConnector />);
    const reply = (await screen.findByRole("checkbox", { name: "Reply to Mail Center emails" })) as HTMLInputElement;
    const note = screen.getByRole("checkbox", { name: "Add notes to service cases" }) as HTMLInputElement;
    expect(reply.checked).toBe(false);
    expect(note.checked).toBe(false);
    fireEvent.click(reply);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/mcp-admin/admin/actions", { kind: "mail_reply", enabled: true }));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: "Reply to Mail Center emails" }) as HTMLInputElement).checked).toBe(true));
    expect((screen.getByRole("checkbox", { name: "Allow AI actions (meetings, email)" }) as HTMLInputElement).checked).toBe(false);
  });
});
