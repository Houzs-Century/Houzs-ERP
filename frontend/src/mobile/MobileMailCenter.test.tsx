import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileMailCenter } from "./MobileMailCenter";

const { apiGet, apiPost, queryData, authUser } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  queryData: new Map<string, unknown>(),
  authUser: { current: null as unknown },
}));

vi.mock("../api/client", () => ({
  api: { get: apiGet, post: apiPost, patch: vi.fn(), fetchBlobUrl: vi.fn() },
}));

// Keyed by the useQuery cache key so a test can seed the addresses / labels /
// thread-detail reads independently. Anything unseeded answers [] — which is
// what the pagination suite below expects.
vi.mock("../hooks/useQuery", () => ({
  useQuery: (key: string) => ({
    data: queryData.has(key) ? queryData.get(key) : [],
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock("../vendor/scm/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: authUser.current, can: () => true, pageAccess: {} }),
}));

vi.mock("./MobileVirtualList", () => ({
  MobileVirtualList: ({ items, renderItem }: any) => (
    <div>{items.map((item: any, index: number) => renderItem(item, index))}</div>
  ),
}));

function thread(id: string, subject: string) {
  return {
    id,
    mailboxAddress: "sales@example.com",
    subject,
    counterpartyEmail: "customer@example.com",
    counterpartyName: "Customer",
    status: "open",
    lastMessageAt: "2026-07-20T08:00:00Z",
    lastDirection: "inbound",
    lastSnippet: `${subject} snippet`,
    messageCount: 1,
    unread: false,
    starred: false,
    labels: [],
    hasOutbound: false,
    createdAt: "2026-07-20T08:00:00Z",
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MobileMailCenter paginated search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryData.clear();
    authUser.current = null;
    apiGet.mockReset();
    apiGet.mockImplementation(async (url: string) => {
      const parsed = new URL(url, "https://houzs.test");
      const query = parsed.searchParams.get("q");
      const page = Number(parsed.searchParams.get("page"));
      if (query === "A1" && page === 2) {
        return { threads: [thread("51", "A1 result 51")], total: 51, page: 2, pageSize: 50, hasMore: false };
      }
      if (query === "A1") {
        return { threads: [thread("1", "A1 result 1")], total: 51, page: 1, pageSize: 50, hasMore: true };
      }
      return { threads: [thread("old", "Old inbox row")], total: 1, page: 1, pageSize: 50, hasMore: false };
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("searches on the server, hides stale rows immediately, and loads later pages", async () => {
    render(<MobileMailCenter />);
    await flush();

    expect(apiGet.mock.calls[0][0]).toContain("status=open");
    expect(apiGet.mock.calls[0][0]).toContain("page=1");
    expect(apiGet.mock.calls[0][0]).toContain("pageSize=50");
    expect(screen.getByText("Old inbox row")).toBeTruthy();

    const input = screen.getByRole("textbox", { name: "Search all mail" });
    fireEvent.change(input, { target: { value: "A1" } });
    expect(screen.queryByText("Old inbox row")).toBeNull();
    expect(screen.getAllByRole("status").some((status) => status.textContent?.includes("Searching"))).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await flush();

    const searchCall = apiGet.mock.calls.find(([url]) => String(url).includes("q=A1"));
    expect(searchCall?.[0]).toContain("page=1");
    expect(screen.getByText("A1 result 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Load more mail/ }));
    await flush();
    expect(apiGet.mock.calls.some(([url]) => String(url).includes("q=A1") && String(url).includes("page=2"))).toBe(true);
    expect(screen.getByText("A1 result 51")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The three defects below all shipped because nothing on this screen exercised
// compose, reply, the From default or the auto-sent log — the suite above
// covers pagination and search only. Desktop is the correct side in all three;
// each assertion here is the desktop behaviour, taken from the SAME shared
// module desktop uses.
// ---------------------------------------------------------------------------

// A mailbox list in the order the backend actually serves it:
// GET /api/mail-center/addresses is ORDER BY address ASC, so the alphabetically
// first entry is a department mailbox and the personal one is LAST. The whole
// point of the fixture is that "first in the list" and "belongs to this user"
// are different answers.
const ALPHABETICAL_ADDRESSES = [
  { id: "a1", address: "finance@houzs.test", label: "Finance", active: true, assignedUserId: null },
  { id: "a2", address: "hr@houzs.test", label: "HR", active: true, assignedUserId: null },
  { id: "a3", address: "zoe@houzs.test", label: "Zoe", active: true, assignedUserId: 7 },
];

const THREAD_DETAIL_KEY = "/api/mail-center/threads/:";

function threadDetail() {
  return {
    thread: thread("t1", "Quotation for 3 sofas"),
    messages: [
      {
        id: "m1",
        threadId: "t1",
        direction: "inbound",
        fromAddress: "customer@example.com",
        fromName: "Customer",
        toAddresses: ["sales@example.com"],
        ccAddresses: ["partner@example.com"],
        subject: "Quotation for 3 sofas",
        textBody: "Please quote.",
        htmlBody: "",
        sentAt: "",
        receivedAt: "2026-07-20T08:00:00Z",
        createdAt: "2026-07-20T08:00:00Z",
        attachments: [],
      },
    ],
  };
}

function threadsPage() {
  return { threads: [thread("t1", "Quotation for 3 sofas")], total: 1, page: 1, pageSize: 50, hasMore: false };
}

function fromPicker(): HTMLSelectElement {
  return screen.getByRole("combobox") as HTMLSelectElement;
}

describe("MobileMailCenter reply-all", () => {
  beforeEach(() => {
    queryData.clear();
    authUser.current = { id: 7, email: "zoe@houzs.test" };
    queryData.set("/api/mail-center/addresses", ALPHABETICAL_ADDRESSES);
    queryData.set(THREAD_DETAIL_KEY, threadDetail());
    apiGet.mockReset();
    apiGet.mockImplementation(async () => threadsPage());
    apiPost.mockReset();
    apiPost.mockImplementation(async () => ({ ok: true }));
  });

  afterEach(cleanup);

  async function openThreadAndReply(buttonName: "Reply" | "Reply all") {
    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByText("Quotation for 3 sofas"));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await flush();
    fireEvent.change(screen.getByPlaceholderText(/Write your reply/), {
      target: { value: "Sending our quote now." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    const call = apiPost.mock.calls.find(([url]) => String(url).endsWith("/reply"));
    expect(call).toBeTruthy();
    return call![1] as Record<string, unknown>;
  }

  it("posts replyAll:true when the operator tapped Reply all", async () => {
    const body = await openThreadAndReply("Reply all");
    expect(body.text).toBe("Sending our quote now.");
    expect(body.replyAll).toBe(true);
  });

  it("posts no replyAll key for a plain reply", async () => {
    const body = await openThreadAndReply("Reply");
    expect(body.text).toBe("Sending our quote now.");
    expect(body).not.toHaveProperty("replyAll");
  });
});

describe("MobileMailCenter compose From default", () => {
  beforeEach(() => {
    queryData.clear();
    apiGet.mockReset();
    apiGet.mockImplementation(async () => threadsPage());
    apiPost.mockReset();
    apiPost.mockImplementation(async () => ({ ok: true }));
  });

  afterEach(cleanup);

  it("defaults New email to the user's OWN mailbox, not the alphabetically first one", async () => {
    authUser.current = { id: 7, email: "zoe@houzs.test" };
    queryData.set("/api/mail-center/addresses", ALPHABETICAL_ADDRESSES);

    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await flush();

    expect(fromPicker().value).toBe("zoe@houzs.test");
  });

  it("defaults Forward to the user's OWN mailbox too", async () => {
    authUser.current = { id: 7, email: "zoe@houzs.test" };
    queryData.set("/api/mail-center/addresses", ALPHABETICAL_ADDRESSES);
    queryData.set(THREAD_DETAIL_KEY, threadDetail());

    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByText("Quotation for 3 sofas"));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await flush();

    expect(fromPicker().value).toBe("zoe@houzs.test");
  });

  it("sends from the user's own mailbox", async () => {
    authUser.current = { id: 7, email: "zoe@houzs.test" };
    queryData.set("/api/mail-center/addresses", ALPHABETICAL_ADDRESSES);

    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "customer@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "Your quotation" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Write your email/), {
      target: { value: "Attached." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();

    const call = apiPost.mock.calls.find(([url]) => String(url) === "/api/mail-center/compose");
    expect(call).toBeTruthy();
    expect((call![1] as Record<string, unknown>).fromAddress).toBe("zoe@houzs.test");
  });

  it("gives an alias-only member a usable From option", async () => {
    // No email_addresses row at all — the member's only sending identity is
    // users.email_alias, which the backend's canSendFrom accepts.
    authUser.current = { id: 9, email: "kris@login.test", email_alias: "kris@houzscentury.com" };
    queryData.set("/api/mail-center/addresses", []);

    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await flush();

    expect(screen.queryByText("No mailbox available")).toBeNull();
    expect(fromPicker().value).toBe("kris@houzscentury.com");
  });
});

describe("MobileMailCenter Auto-sent folder", () => {
  beforeEach(() => {
    queryData.clear();
    authUser.current = { id: 7, email: "zoe@houzs.test" };
    queryData.set("/api/mail-center/addresses", ALPHABETICAL_ADDRESSES);
    apiPost.mockReset();
    apiGet.mockReset();
    apiGet.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/mail-center/outbox")) {
        return {
          rows: [
            {
              id: "ob1",
              toAddress: "customer@example.com",
              subject: "Invoice INV-2608-011",
              status: "FAILED",
              attempts: 3,
              lastError: "550 mailbox unavailable",
              sentAt: null,
              createdAt: "2026-08-19T02:00:00Z",
              snippet: "Please find your invoice",
              attachmentNames: [],
            },
          ],
          counts: { sent: 12, failed: 1, pending: 0 },
          hasMore: false,
        };
      }
      return threadsPage();
    });
  });

  afterEach(cleanup);

  it("shows a FAILED auto-sent email with its failure reason", async () => {
    render(<MobileMailCenter />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Auto-sent" }));
    await flush();

    expect(apiGet.mock.calls.some(([url]) => String(url).includes("/api/mail-center/outbox"))).toBe(true);
    expect(screen.getByText("Invoice INV-2608-011")).toBeTruthy();
    expect(screen.getByText("customer@example.com")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("550 mailbox unavailable")).toBeTruthy();
  });
});
