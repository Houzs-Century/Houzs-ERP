import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./NotificationBell";

/* ────────────────────────────────────────────────────────────────────────────
   NotificationBell × system notices (owner 2026-08-08, "为什么一直有这个").

   Machine-generated notices (scan results, service-case assignments) no longer
   ride the pop-up banner — the desktop home for them is THIS bell, reading the
   /banner?scope=system slice the mobile bell already reads. These tests pin
   the delivery contract: an un-acked system notice is listed and counted, an
   acked one is neither, and Mark read records the same POST /:id/ack the other
   surfaces record and settles the row immediately.
   ──────────────────────────────────────────────────────────────────────────── */

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: { get: apiGet, post: apiPost },
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 505 } }),
}));

// The human slice rides the shared banner hook, which keeps its ack memo in
// localStorage under an identity-scoped key; no identity here keeps it inert
// so only the SYSTEM half is under test.
vi.mock("../lib/storageIdentity", () => ({ identityStorageKey: () => null }));

const SYSTEM_PAYLOAD = {
  success: true,
  data: [
    {
      id: "ann-case",
      title: "New service case ASSR/HC/2608/001",
      body: "A new service case has been created and assigned to your team.",
      createdAt: new Date().toISOString(),
      remindedAt: null,
      source: "service_case",
    },
    {
      id: "ann-acked",
      title: "Sales order saved",
      body: "Already read on the phone.",
      createdAt: new Date().toISOString(),
      remindedAt: null,
      source: "scan",
    },
  ],
  ackedIds: ["ann-acked"],
};

// Project-activity half of the bell — pinned to a known unread count so the
// combined badge is deterministic. The system half is what's under test.
vi.mock("../hooks/useNotifications", () => ({
  useNotifications: () => ({
    feed: [],
    unreadByProject: {},
    totalUnread: 3,
    loadFailed: false,
    reload: vi.fn(),
    markAllRead: vi.fn(async () => ({ ok: 0, failed: 0 })),
    pointsBalance: 0,
    giftingBalance: 0,
    currentStreak: 0,
  }),
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, ...props }: { children?: unknown } & Record<string, unknown>) => (
    <a {...(props as Record<string, never>)}>{children as never}</a>
  ),
}));

vi.mock("./Avatar", () => ({ Avatar: () => null }));

function renderBell() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <NotificationBell collapsed={false} />
    </QueryClientProvider>,
  );
}

describe("NotificationBell — system notices section", () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    // Route by slice: the SYSTEM slice carries the two notices; the HUMAN
    // slice (the Announcements tab, read through the shared hook) is empty.
    apiGet.mockImplementation((url: string) =>
      url.includes("scope=system")
        ? Promise.resolve(SYSTEM_PAYLOAD)
        : Promise.resolve({ success: true, data: [], ackedIds: [] }),
    );
    apiPost.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("asks for the BELL slice, lists un-acked system notices, and counts them into the badge", async () => {
    renderBell();

    // 3 project unread + 1 un-acked system notice = 4 on the pill.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Notifications · 4 unread" }),
      ).toBeTruthy(),
    );
    expect(apiGet).toHaveBeenCalledWith("/api/announcements/banner?scope=system");

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    // One unread entry point: tabs split announcements from system notices,
    // and a system row wears its source as the tag.
    expect(screen.getByRole("tab", { name: /System/ })).toBeTruthy();
    expect(screen.getByText("Service case")).toBeTruthy();
    expect(screen.getByText("New service case ASSR/HC/2608/001")).toBeTruthy();
    // The acked notice is settled — it must not resurface in the bell.
    expect(screen.queryByText("Sales order saved")).toBeNull();
  });

  it("Mark read acks the notice server-side and settles the row + badge immediately", async () => {
    renderBell();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Notifications · 4 unread" }),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    fireEvent.click(screen.getByRole("button", { name: /Mark read/ }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/announcements/ann-case/ack"),
    );
    // Row gone at once (locally settled, not a poll later)...
    expect(screen.queryByText("New service case ASSR/HC/2608/001")).toBeNull();
    // ...and the badge falls back to the project count alone.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Notifications · 3 unread" }),
      ).toBeTruthy(),
    );
  });
});
