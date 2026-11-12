/* The phone inbox row: clock for today, "Yesterday", else the date — on the
   Malaysian calendar. At 01:30 on 10 Nov (Malaysia) a message from 23:30 on
   the 9th is "Yesterday", even when the phone's clock zone is UTC. */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { apiGet, lastAt } = vi.hoisted(() => ({ apiGet: vi.fn(), lastAt: { current: "" } }));

vi.mock("../api/client", () => ({ api: { get: apiGet, post: vi.fn(), patch: vi.fn(), fetchBlobUrl: vi.fn() } }));
vi.mock("../hooks/useQuery", () => ({ useQuery: () => ({ data: [], loading: false, error: null, reload: vi.fn() }) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: null, can: () => true, pageAccess: {} }) }));
vi.mock("./MobileVirtualList", () => ({
  MobileVirtualList: ({ items, renderItem }: { items: unknown[]; renderItem: (item: unknown, i: number) => ReactNode }) => <div>{items.map((item, i) => renderItem(item, i))}</div>,
}));

import { MobileMailCenter } from "./MobileMailCenter";

const thread = (at: string) => ({
  id: "t1", mailboxAddress: "sales@example.com", subject: "Quote request", counterpartyEmail: "c@example.com",
  counterpartyName: "Customer", status: "open", lastMessageAt: at, lastDirection: "inbound", lastSnippet: "snippet",
  messageCount: 1, unread: false, starred: false, labels: [], hasOutbound: false, attachmentCount: 0, attachments: [], createdAt: at,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T17:30:00Z")); // 01:30 on 10 Nov in Malaysia
  apiGet.mockReset();
  apiGet.mockImplementation(async () => ({ threads: [thread(lastAt.current)], total: 1, page: 1, pageSize: 50, hasMore: false }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function mount(at: string) {
  lastAt.current = at;
  render(<MobileMailCenter />);
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  await screen.findByText("Quote request");
}

describe("phone inbox row time judges today by the Malaysian day", () => {
  it("23:30 on the 9th (Malaysia) reads Yesterday at 01:30 on the 10th", async () => {
    await mount("2026-11-09T15:30:00Z");
    expect(screen.getByText("Yesterday")).toBeTruthy();
    expect(screen.queryByText("23:30")).toBeNull();
  });

  it("00:10 on the 10th (Malaysia) is today's and shows its clock", async () => {
    await mount("2026-11-09T16:10:00Z");
    expect(screen.getByText("00:10")).toBeTruthy();
  });

  it("23:30 on the 8th (Malaysia) shows its date", async () => {
    await mount("2026-11-08T15:30:00Z");
    expect(screen.getByText("2026/11/08")).toBeTruthy();
  });
});
