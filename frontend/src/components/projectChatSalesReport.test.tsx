/* The chat's sales-report layer (owner 2026-10-14). Pinned: for the three who
   report, a bill message is marked as counted (or not), a summary offers its
   Total line for Total Sales (its days shown when they differ, never used),
   any message can be voided (the endpoint is called and the chat drops it) and
   voiding the summary Total Sales came from puts back the latest one left;
   after a post, a bill message triggers the wrong-event notice and a summary
   sets Total Sales to its Total line. Nobody else sees any of it. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi, beforeEach } from "vitest";

const post = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => ({ ok: true }));
const patch = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => ({ ok: true }));
const get = vi.fn<(path: string) => Promise<unknown>>(async () => ({}));
vi.mock("../api/client", () => ({
  api: {
    post: (p: string, b: unknown) => post(p, b),
    patch: (p: string, b: unknown) => patch(p, b),
    get: (p: string) => get(p),
  },
}));

let me: { id: number; email: string; position_name: string; position_id: number | null; project_finance_viewer?: boolean } =
  { id: 7, email: "ummuaimanlm@gmail.com", position_name: "Operation Executive", position_id: null };
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: me, can: () => true }) }));
vi.mock("../hooks/useDialog", () => ({ useDialog: () => ({ confirm: async () => true }) }));
const invalidate = vi.fn();
let totalSalesRm: number | null = null;
vi.mock("../hooks/useProjectSalesBills", () => ({
  useProjectSalesBills: () => ({
    data: { report_activity_ids: [11], total_sales_rm: totalSalesRm }, loading: false, fetching: false, placeholder: false, error: null, reload: () => {},
  }),
  useInvalidateProjectSalesBills: () => invalidate,
}));

const { useChatSalesReport } = await import("./projectChatSalesReport");

type Msg = { id: number; action: string; note: string | null };

const toastError = vi.fn();
const toastSuccess = vi.fn();
function Harness({ messages, onVoided, onTotalSet, sendNote }: { messages: Msg[]; onVoided: (id: number) => void; onTotalSet: () => void; sendNote?: string }) {
  const toast = { success: toastSuccess, error: toastError, info: vi.fn() } as unknown as Parameters<typeof useChatSalesReport>[0]["toast"];
  const r = useChatSalesReport({ projectId: 2259, toast, onTotalSet, onVoided });
  return (
    <div>
      {messages.map((m) => <div key={m.id} data-testid={`msg-${m.id}`}>{r.footerFor(m)}</div>)}
      {sendNote && <button onClick={() => void r.afterSend(sendNote)}>send</button>}
    </div>
  );
}

const BILLS = "10/10\n1. HC13162 RM1999 Ethan\n2. HC13163 RM4172 + 710(T) Ethan";
const SUMMARY_BAD = "JB @ Sutera Mall 9-11/10\n9/10:RM10,500\n10/10:RM37,865+2883\nTotal RM48,185+2883";
const SUMMARY_OK = "Homedec@Zanotti 2-4/10\n2/10 - RM6288\n3/10 - RM8888\n4/10 - RM8538+150(D)\nTotal- RM23,714+150(D";

beforeEach(() => {
  post.mockClear(); patch.mockClear(); get.mockClear(); invalidate.mockClear(); toastError.mockClear(); toastSuccess.mockClear();
  me = { id: 7, email: "ummuaimanlm@gmail.com", position_name: "Operation Executive", position_id: null };
  totalSalesRm = null;
});

describe("the footer under each message", () => {
  test("a counted bill message, a summary's Total line with its days shown, and Void on every message", async () => {
    const onVoided = vi.fn();
    const onTotalSet = vi.fn();
    render(<Harness
      messages={[{ id: 11, action: "note", note: BILLS }, { id: 12, action: "note", note: SUMMARY_BAD }, { id: 13, action: "note", note: "ok noted" }, { id: 14, action: "pic_change", note: null }]}
      onVoided={onVoided} onTotalSet={onTotalSet}
    />);
    expect(screen.getByTestId("msg-11").textContent).toContain("In sales report · 2 bills · RM 6,171.00");
    expect(screen.getByTestId("msg-12").textContent).toContain("Set Total Sales = RM 48,185.00");
    expect(screen.getByTestId("msg-12").textContent).toContain("days add up to RM 48,365.00");
    /* The days are shown, never offered as the figure. */
    expect(screen.queryByText(/use this/)).toBeNull();
    expect(screen.getByTestId("msg-13").textContent).toBe("Void");
    expect(screen.getByTestId("msg-14").textContent).toBe("");

    fireEvent.click(screen.getByText("Set Total Sales = RM 48,185.00"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/projects/2259/finance", { total_sales: 48185 }));
    expect(onTotalSet).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("msg-13").querySelector("button")!);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/project-sales-bills/2259/void/13", {}));
    expect(onVoided).toHaveBeenCalledWith(13);
    expect(invalidate).toHaveBeenCalled();
  });

  test("voiding the summary Total Sales came from puts back the latest summary left, or empties it", async () => {
    totalSalesRm = 48185;
    get.mockResolvedValueOnce({ summary: { activity_id: 9, total_sen: 3352300, days_sen: 3352300, created_at: null } });
    const onTotalSet = vi.fn();
    const { unmount } = render(<Harness messages={[{ id: 12, action: "note", note: SUMMARY_BAD }]} onVoided={() => {}} onTotalSet={onTotalSet} />);
    fireEvent.click(screen.getByText("Void"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/projects/2259/finance", { total_sales: 33523 }));
    expect(post).toHaveBeenCalledWith("/api/project-sales-bills/2259/void/12", {});
    unmount();

    patch.mockClear();
    get.mockResolvedValueOnce({ summary: null });
    render(<Harness messages={[{ id: 12, action: "note", note: SUMMARY_BAD }]} onVoided={() => {}} onTotalSet={() => {}} />);
    fireEvent.click(screen.getByText("Void"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/projects/2259/finance", { total_sales: null }));
  });

  test("voiding a summary that is not where Total Sales came from leaves Total Sales alone", async () => {
    totalSalesRm = 99999;
    render(<Harness messages={[{ id: 12, action: "note", note: SUMMARY_BAD }]} onVoided={() => {}} onTotalSet={() => {}} />);
    fireEvent.click(screen.getByText("Void"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/project-sales-bills/2259/void/12", {}));
    expect(get).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  test("a bill message that does not count is marked so", () => {
    render(<Harness messages={[{ id: 99, action: "note", note: BILLS }]} onVoided={() => {}} onTotalSet={() => {}} />);
    expect(screen.getByTestId("msg-99").textContent).toContain("Not counted · 2 bills");
  });

  test("someone who does not report sees nothing", () => {
    me = { id: 8, email: "rep@houzs.com", position_name: "Sales Executive", position_id: 3 };
    render(<Harness messages={[{ id: 11, action: "note", note: BILLS }, { id: 12, action: "note", note: SUMMARY_BAD }]} onVoided={() => {}} onTotalSet={() => {}} />);
    expect(screen.getByTestId("msg-11").textContent).toBe("");
    expect(screen.getByTestId("msg-12").textContent).toBe("");
  });
});

describe("after a post", () => {
  test("a bill message re-reads the report and sends the wrong-event notice", async () => {
    render(<Harness messages={[]} onVoided={() => {}} onTotalSet={() => {}} sendNote={BILLS} />);
    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/project-sales-bills/2259/notify", {}));
    expect(invalidate).toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  test("a summary sets Total Sales to its Total line at once", async () => {
    const onTotalSet = vi.fn();
    render(<Harness messages={[]} onVoided={() => {}} onTotalSet={onTotalSet} sendNote={SUMMARY_OK} />);
    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/projects/2259/finance", { total_sales: 23714 }));
    expect(onTotalSet).toHaveBeenCalled();
  });

  test("a summary whose days differ still sets its Total line, and says what the days add up to", async () => {
    render(<Harness messages={[]} onVoided={() => {}} onTotalSet={() => {}} sendNote={SUMMARY_BAD} />);
    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/projects/2259/finance", { total_sales: 48185 }));
    expect(String(toastSuccess.mock.calls[0]![0])).toContain("RM 48,185.00");
    expect(String(toastSuccess.mock.calls[0]![0])).toContain("RM 48,365.00");
  });
});
