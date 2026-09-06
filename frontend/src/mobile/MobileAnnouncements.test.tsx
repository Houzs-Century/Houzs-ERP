import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PromptProvider } from "../vendor/scm/components/PromptDialog";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* MobileAnnouncements — the phone's publisher surface.
 *
 * Three rules pinned here, one per defect the phone had:
 *
 *  1. A notice posted from a phone must be able to EXPIRE. Desktop sends
 *     `expiresAt`; mobile sent nothing and had no expiry control at all, so a
 *     phone-posted notice ran forever.
 *  2. A publisher must be able to RETRACT from the phone. Desktop has
 *     PATCH { isActive } and DELETE; mobile had neither, and its list read the
 *     READER feed (active + unexpired only), so a manager could not even SEE a
 *     notice they had hidden.
 *  3. "Reminder sent" must mean the server said so. Mobile fired
 *     `api.post(url).catch(() => {})` and flipped the label unconditionally —
 *     the button reported success on a 403. */

const { apiGet, apiPost, apiPatch, apiDel, authUser, confirmAnswer, notified } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDel: vi.fn(),
  authUser: {
    current: { id: 7, name: "Nick" } as { id: number; name: string } | null,
    can: { current: (_p: string) => true },
  },
  confirmAnswer: { current: true },
  notified: [] as Array<{ title: string; body?: unknown }>,
}));

vi.mock("../api/client", () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch, del: apiDel, put: vi.fn() },
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: authUser.current, can: (p: string) => authUser.can.current(p), pageAccess: {} }),
}));

vi.mock("../auth/salesAccess", () => ({ isSalesDirectorUser: () => false }));

vi.mock("../vendor/scm/components/ConfirmDialog", () => ({
  useConfirm: () => async () => confirmAnswer.current,
}));

vi.mock("../vendor/scm/components/NotifyDialog", () => ({
  useNotify: () => async (opts: { title: string; body?: unknown }) => {
    notified.push(opts);
  },
}));

vi.mock("./MobileVirtualList", () => ({
  MobileVirtualList: ({
    items,
    renderItem,
  }: {
    items: Array<{ id?: string }>;
    renderItem: (row: { id?: string }, index: number) => unknown;
  }) => (
    <div>
      {items.map((item, i) => (
        <div key={item.id ?? i}>{renderItem(item, i) as React.ReactNode}</div>
      ))}
    </div>
  ),
}));

vi.mock("./MobileAnnouncementMedia", () => ({
  Attachments: () => <div />,
  fmtSize: (n: number) => String(n),
}));

vi.mock("../lib/announcementAttachmentUpload", () => ({
  uploadAnnouncementAttachment: vi.fn(),
}));

import { MobileAnnouncements } from "./MobileAnnouncements";

/** A human notice row, shaped like the API's. */
type Row = Record<string, unknown> & { id: string; title: string; isActive: boolean };

function notice(over: Partial<Record<string, unknown>> = {}): Row {
  return {
    id: "a1",
    title: "Warehouse closed Friday",
    body: "No dispatch on Friday.",
    isActive: true,
    expiresAt: null,
    createdAt: "2026-08-14T02:00:00Z",
    createdBy: 7,
    createdByName: "Nick",
    remindedAt: null,
    updatedAt: null,
    attachments: [],
    targetType: "ALL_USERS",
    category: "GENERAL",
    source: null,
    ...over,
  };
}

function mountWith(rows: Row[]) {
  apiGet.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/announcements/banner?scope=human")) {
      return { success: true, data: rows.filter((r) => r.isActive && !r.expiresAt), ackedIds: [] };
    }
    if (url.startsWith("/api/announcements/banner?scope=system")) return { success: true, data: [], ackedIds: [] };
    if (url === "/api/announcements") return { success: true, data: rows };
    if (url.startsWith("/api/announcements/") && url.endsWith("/acks")) {
      return {
        success: true,
        data: {
          total: 3,
          ackedCount: 1,
          acked: [{ id: 1, name: "Ann", email: "a@x", ackedAt: "2026-08-14T03:00:00Z" }],
          pending: [{ id: 2, name: "Bee", email: "b@x" }, { id: 3, name: "Cee", email: "c@x" }],
        },
      };
    }
    if (url === "/api/departments") return { departments: [] };
    if (url === "/api/positions") return { positions: [] };
    if (url === "/api/users") return { users: [] };
    if (url === "/api/companies") return { companies: [{ id: 1, code: "HZ", name: "Houzs" }] };
    return {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PromptProvider>
        <MobileAnnouncements />
      </PromptProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiDel.mockReset();
  notified.length = 0;
  confirmAnswer.current = true;
  authUser.current = { id: 7, name: "Nick" };
  authUser.can.current = () => true;
  apiPost.mockResolvedValue({ success: true });
  apiPatch.mockResolvedValue({ success: true });
  apiDel.mockResolvedValue({ success: true });
});
afterEach(cleanup);

async function openCompose() {
  mountWith([]);
  await waitFor(() => expect(screen.getByText("New")).toBeTruthy());
  fireEvent.click(screen.getByText("New"));
  await waitFor(() => expect(screen.getByText("New announcement")).toBeTruthy());
}

async function openDetail(rows: Row[]) {
  mountWith(rows);
  await waitFor(() => expect(screen.getByText(rows[0].title)).toBeTruthy());
  fireEvent.click(screen.getByText(rows[0].title));
  await waitFor(() => expect(screen.getByText(/Posted by/)).toBeTruthy());
}

describe("MobileAnnouncements — a phone-posted notice can expire", () => {
  it("offers an expiry control on the composer", async () => {
    await openCompose();
    // Both halves of the shared DateTimeField: an expiry the operator can set
    // to a day AND a time, not a bare date the backend would read as midnight.
    expect(screen.getByLabelText(/Hide automatically after date/i)).toBeTruthy();
    expect(screen.getByLabelText(/Hide automatically after time/i)).toBeTruthy();
  });

  it("sends expiresAt as an ISO string when one is picked", async () => {
    await openCompose();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Stock take" } });
    // DateField's visible box is a DD/MM/YYYY text input (owner-locked format);
    // the time half is a native <input type="time">.
    fireEvent.change(screen.getByLabelText(/Hide automatically after date/i), {
      target: { value: "01/09/2026" },
    });
    fireEvent.change(screen.getByLabelText(/Hide automatically after time/i), {
      target: { value: "18:00" },
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/Submit for approval/));
    });

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [url, payload] = apiPost.mock.calls.find((c) => c[0] === "/api/announcements")!;
    expect(url).toBe("/api/announcements");
    const sent = (payload ?? {}) as Record<string, unknown>;
    expect(typeof sent.expiresAt).toBe("string");
    expect(Date.parse(String(sent.expiresAt))).toBe(
      new Date("2026-09-01T18:00").getTime(),
    );
  });
});

describe("MobileAnnouncements — a publisher can retract from the phone", () => {
  it("lists the publisher's own hidden notice, badged", async () => {
    mountWith([notice({ id: "hid", title: "Old policy", isActive: false })]);
    await waitFor(() => expect(screen.getByText("Old policy")).toBeTruthy());
    expect(screen.getByText("Hidden")).toBeTruthy();
  });

  it("badges an expired notice rather than hiding it from its author", async () => {
    mountWith([notice({ id: "exp", title: "Chinese New Year", expiresAt: "2026-01-01T00:00:00Z" })]);
    await waitFor(() => expect(screen.getByText("Chinese New Year")).toBeTruthy());
    expect(screen.getByText("Expired")).toBeTruthy();
  });

  it("hides a live notice with PATCH { isActive: false }", async () => {
    await openDetail([notice()]);
    await act(async () => {
      fireEvent.click(screen.getByText("Hide"));
    });
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith("/api/announcements/a1", { isActive: false }));
  });

  it("deletes only after a confirm, and reports a refusal", async () => {
    confirmAnswer.current = false;
    await openDetail([notice()]);
    await act(async () => {
      fireEvent.click(screen.getByText("Delete"));
    });
    expect(apiDel).not.toHaveBeenCalled();

    confirmAnswer.current = true;
    apiDel.mockRejectedValueOnce(new Error("403: Announcement not found"));
    await act(async () => {
      fireEvent.click(screen.getByText("Delete"));
    });
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith("/api/announcements/a1"));
    await waitFor(() => expect(notified.some((n) => /403|not found/i.test(String(n.body)))).toBe(true));
  });
});

describe("MobileAnnouncements — Remind tells the truth", () => {
  it("confirms first, then reports the server's own count", async () => {
    apiPost.mockResolvedValue({ success: true, pendingCount: 2, scope: "unacked" });
    await openDetail([notice()]);
    await waitFor(() => expect(screen.getByText(/Remind 2 who haven't read/)).toBeTruthy());

    confirmAnswer.current = false;
    await act(async () => {
      fireEvent.click(screen.getByText(/Remind 2 who haven't read/));
    });
    expect(apiPost).not.toHaveBeenCalledWith(
      "/api/announcements/a1/remind",
      expect.anything(),
    );

    confirmAnswer.current = true;
    await act(async () => {
      fireEvent.click(screen.getByText(/Remind 2 who haven't read/));
    });
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/announcements/a1/remind", { scope: "unacked" }),
    );
    await waitFor(() => expect(notified.some((n) => String(n.body).includes("2"))).toBe(true));
  });

  it("does NOT claim success when the server refused", async () => {
    await openDetail([notice()]);
    await waitFor(() => expect(screen.getByText(/Remind 2 who haven't read/)).toBeTruthy());
    apiPost.mockRejectedValueOnce(new Error("403: Only the author may remind"));

    await act(async () => {
      fireEvent.click(screen.getByText(/Remind 2 who haven't read/));
    });

    await waitFor(() => expect(notified.some((n) => /403|author/i.test(String(n.body)))).toBe(true));
    // The label must NOT have flipped to a success claim.
    expect(screen.queryByText("Reminder sent")).toBeNull();
    expect(screen.getByText(/Remind 2 who haven't read/)).toBeTruthy();
  });

  it("offers the scope:'all' reset desktop has", async () => {
    apiPost.mockResolvedValue({ success: true, pendingCount: 3, scope: "all" });
    await openDetail([notice()]);
    await waitFor(() => expect(screen.getByText(/Reset all read-receipts/i)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText(/Reset all read-receipts/i));
    });
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/announcements/a1/remind", { scope: "all" }),
    );
  });
});
