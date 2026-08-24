import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileMailCenter } from "./MobileMailCenter";
import { LABEL_PALETTE } from "../pages/MailCenter/mail-labels";

const { apiGet, apiPost, apiPatch, queryData, authUser, toastError } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  queryData: new Map<string, unknown>(),
  authUser: { current: null as unknown },
  toastError: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch, fetchBlobUrl: vi.fn() },
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
  useToast: () => ({ success: vi.fn(), error: toastError, info: vi.fn() }),
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

// ---------------------------------------------------------------------------
// Four more phone-only gaps, same class as the three above: desktop IMPORTS a
// shared rule and the phone re-implemented the screen without it. Every
// assertion below is the desktop behaviour, read off the module desktop uses.
//
//   1. attachments  — Compose.tsx / Thread.tsx send `attachments`; the phone
//                     sent no such key and had no picker. The phone camera is
//                     the best attachment source in the business.
//   2. Cc / Bcc     — Compose.tsx sends both; the phone had neither field.
//   3. assign       — Thread.tsx writes assignedToUserId + assignedToName; the
//                     phone carried both fields in its type and never wrote them.
//   4. label filter — Inbox.tsx sets ?label=; the phone could APPLY a label and
//                     then had no way to list the threads carrying it.
// ---------------------------------------------------------------------------

// COUNTING TICKS HERE IS A RACE, AND CI LOSES IT. This helper used to be one
// `await new Promise(r => setTimeout(r, 0))`, and that blocked two frontend
// deploys on 2026-08-20 (runs 32398840395 and 32400244624) on commits that
// changed nothing under frontend/src — see docs/bugs.
//
// jsdom does not resolve a FileReader on the next macrotask. `_readFile` in
// jsdom/lib/jsdom/living/file-api/FileReader-impl.js schedules setImmediate,
// and fires `load` from a SECOND setImmediate scheduled inside the first. Node
// runs due timers BEFORE the check phase, and an immediate scheduled from
// within the check phase is deferred to the next turn — so `setTimeout(…, 0)`
// (clamped to 1ms) resolves ahead of that second immediate whenever the turn
// takes longer than the clamp. That is exactly what a loaded CI runner does,
// which is why this failed under parallelism and passed on a quiet laptop.
// Reproduced on this machine at roughly 3 failures in 14 isolated runs.
//
// So wait for the thing the read actually produces — the attachment chip for
// an accepted file, the refusal sentence for a rejected one — instead of for a
// number of ticks. `findBy*` retries until it is there and fails loudly if it
// never arrives, which is the assertion we want anyway: Send must not be
// clicked before the picked file has reached state.
function choosePickFile(name: string, type: string) {
  const input = screen.getByLabelText("Attach images or PDF files");
  fireEvent.change(input, { target: { files: [new File(["hello"], name, { type })] } });
}

/** Pick a file and wait for it to be ATTACHED — the chip carries a Remove
 *  control named after the file, and it appears only once the FileReader has
 *  resolved and `onFiles` has landed the base64 in state. */
async function pickFile(name: string, type: string) {
  choosePickFile(name, type);
  await screen.findByRole("button", { name: `Remove ${name}` });
}

describe("MobileMailCenter outbound attachments", () => {
  beforeEach(() => {
    queryData.clear();
    authUser.current = { id: 7, email: "zoe@houzs.test" };
    queryData.set("/api/mail-center/addresses", ALPHABETICAL_ADDRESSES);
    queryData.set(THREAD_DETAIL_KEY, threadDetail());
    apiGet.mockReset();
    apiGet.mockImplementation(async () => threadsPage());
    apiPost.mockReset();
    apiPost.mockImplementation(async () => ({ ok: true }));
    apiPatch.mockReset();
    toastError.mockReset();
  });

  afterEach(cleanup);

  it("sends a photo attached to a NEW email", async () => {
    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "customer@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "Site photo" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Write your email/), {
      target: { value: "See attached." },
    });
    await pickFile("sofa.jpg", "image/jpeg");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();

    const call = apiPost.mock.calls.find(([url]) => String(url) === "/api/mail-center/compose");
    const body = call?.[1] as Record<string, unknown>;
    expect(body).toBeTruthy();
    const attachments = body.attachments as { filename: string; contentBase64: string }[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("sofa.jpg");
    expect(attachments[0].contentBase64.length).toBeGreaterThan(0);
  });

  it("sends a photo attached to a REPLY", async () => {
    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByText("Quotation for 3 sofas"));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText(/Write your reply/), {
      target: { value: "Photo of the fabric." },
    });
    await pickFile("fabric.pdf", "application/pdf");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();

    const call = apiPost.mock.calls.find(([url]) => String(url).endsWith("/reply"));
    const body = call?.[1] as Record<string, unknown>;
    expect(body).toBeTruthy();
    const attachments = body.attachments as { filename: string; contentBase64: string }[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("fabric.pdf");
  });

  it("rejects a disallowed file in the SHARED rule's own words, and sends nothing", async () => {
    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await flush();

    choosePickFile(
      "quotation.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    // Verbatim from mail-attachments.ts — the same sentence the backend answers
    // with, which is the point of importing the rule instead of re-writing it.
    const wanted =
      "is not an allowed type. Only images and PDF files can be attached.";
    expect(
      await screen.findByText((text) => text.includes("quotation.docx") && text.includes(wanted)),
    ).toBeTruthy();
    // …and nothing was attached, so no Remove chip exists to send.
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });
});

describe("MobileMailCenter Cc / Bcc", () => {
  beforeEach(() => {
    queryData.clear();
    authUser.current = { id: 7, email: "zoe@houzs.test" };
    queryData.set("/api/mail-center/addresses", ALPHABETICAL_ADDRESSES);
    apiGet.mockReset();
    apiGet.mockImplementation(async () => threadsPage());
    apiPost.mockReset();
    apiPost.mockImplementation(async () => ({ ok: true }));
    toastError.mockReset();
  });

  afterEach(cleanup);

  it("sends the copied recipients the operator typed", async () => {
    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /Cc \/ Bcc/ }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "customer@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("cc@example.com"), {
      target: { value: "manager@houzs.test, ops@houzs.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("bcc@example.com"), {
      target: { value: "audit@houzs.test" },
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
    const body = call?.[1] as Record<string, unknown>;
    expect(body).toBeTruthy();
    expect(body.cc).toEqual(["manager@houzs.test", "ops@houzs.test"]);
    expect(body.bcc).toEqual(["audit@houzs.test"]);
  });

  it("names the bad copied address instead of sending it", async () => {
    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Cc \/ Bcc/ }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "customer@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("cc@example.com"), {
      target: { value: "not-an-address" },
    });
    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "Your quotation" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Write your email/), {
      target: { value: "Attached." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();

    expect(
      apiPost.mock.calls.some(([url]) => String(url) === "/api/mail-center/compose"),
    ).toBe(false);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("not-an-address"));
  });
});

describe("MobileMailCenter assign to a colleague", () => {
  beforeEach(() => {
    queryData.clear();
    authUser.current = { id: 7, email: "zoe@houzs.test" };
    queryData.set("/api/mail-center/addresses", ALPHABETICAL_ADDRESSES);
    queryData.set(THREAD_DETAIL_KEY, threadDetail());
    queryData.set("/api/users", {
      users: [
        { id: 3, name: "Kris Tan", email: "kris@houzs.test" },
        { id: 4, name: "", email: "ops@houzs.test" },
      ],
    });
    apiGet.mockReset();
    apiGet.mockImplementation(async () => threadsPage());
    apiPatch.mockReset();
    apiPatch.mockImplementation(async () => ({ ok: true }));
    toastError.mockReset();
  });

  afterEach(cleanup);

  async function openThreadAndAssign(value: string) {
    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByText("Quotation for 3 sofas"));
    await flush();
    fireEvent.change(screen.getByLabelText("Assign to"), { target: { value } });
    await flush();
  }

  it("writes BOTH the id and the display name, the way desktop does", async () => {
    await openThreadAndAssign("3");
    const call = apiPatch.mock.calls.find(([url]) =>
      String(url).startsWith("/api/mail-center/threads/"),
    );
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({ assignedToUserId: 3, assignedToName: "Kris Tan" });
  });

  it("clears the assignment when Unassigned is picked", async () => {
    await openThreadAndAssign("");
    const call = apiPatch.mock.calls.find(([url]) =>
      String(url).startsWith("/api/mail-center/threads/"),
    );
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({ assignedToUserId: null, assignedToName: null });
  });

  it("says so when the assignment is refused", async () => {
    apiPatch.mockRejectedValue(new Error("403 forbidden"));
    await openThreadAndAssign("3");
    expect(toastError).toHaveBeenCalled();
  });
});

describe("MobileMailCenter label filter", () => {
  beforeEach(() => {
    queryData.clear();
    authUser.current = { id: 7, email: "zoe@houzs.test" };
    queryData.set("/api/mail-center/addresses", ALPHABETICAL_ADDRESSES);
    queryData.set("/api/mail-center/labels", [
      { id: "l1", name: "Urgent", color: "#B91C1C", createdAt: "" },
    ]);
    queryData.set(THREAD_DETAIL_KEY, threadDetail());
    apiGet.mockReset();
    apiGet.mockImplementation(async () => threadsPage());
    apiPost.mockReset();
    apiPost.mockImplementation(async () => ({ ok: true }));
    apiPatch.mockReset();
    apiPatch.mockImplementation(async () => ({ ok: true }));
    toastError.mockReset();
  });

  afterEach(cleanup);

  it("lists only the threads carrying the label the operator tapped", async () => {
    render(<MobileMailCenter />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Urgent" }));
    await flush();

    expect(apiGet.mock.calls.some(([url]) => String(url).includes("label=Urgent"))).toBe(true);
  });

  it("tapping the same label again drops the filter", async () => {
    render(<MobileMailCenter />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Urgent" }));
    await flush();
    apiGet.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Urgent" }));
    await flush();

    expect(apiGet.mock.calls.length).toBeGreaterThan(0);
    expect(apiGet.mock.calls.every(([url]) => !String(url).includes("label="))).toBe(true);
  });

  it("creates a new label in a colour the backend will actually keep", async () => {
    render(<MobileMailCenter />);
    await flush();
    fireEvent.click(screen.getByText("Quotation for 3 sofas"));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Label/ }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText(/New label/), {
      target: { value: "Escalate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await flush();

    const call = apiPost.mock.calls.find(([url]) => String(url) === "/api/mail-center/labels");
    expect(call).toBeTruthy();
    // normalizeColor() on the backend maps anything outside its nine-entry
    // allow-list to the brand brown, so a colour off that list comes BACK
    // different from the one the picker showed while creating it.
    expect((call![1] as Record<string, unknown>).color).toBe(LABEL_PALETTE[0].value);
  });
});
