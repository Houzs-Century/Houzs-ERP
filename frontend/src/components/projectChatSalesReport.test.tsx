/* The chat's sales-report layer (owner 2026-10-14). Pinned: for the three who
   report, a bill message is marked as counted (or not), a summary offers its
   Total for Total Sales and its days when they do not add up, any message can
   be voided (the endpoint is called and the chat drops it); after a post, a
   bill message triggers the wrong-event notice, a summary whose days add up
   sets Total Sales, and one whose days do not is refused with both figures.
   Nobody else sees any of it. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi, beforeEach } from "vitest";

const post = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => ({ ok: true }));
const patch = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => ({ ok: true }));
vi.mock("../api/client", () => ({ api: { post: (p: string, b: unknown) => post(p, b), patch: (p: string, b: unknown) => patch(p, b) } }));

let me: { id: number; email: string; position_name: string; position_id: number | null; project_finance_viewer?: boolean } =
  { id: 7, email: "ummuaimanlm@gmail.com", position_name: "Operation Executive", position_id: null };
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: me, can: () => true }) }));
vi.mock("../hooks/useDialog", () => ({ useDialog: () => ({ confirm: async () => true }) }));
const invalidate = vi.fn();
vi.mock("../hooks/useProjectSalesBills", () => ({
  useProjectSalesBills: () => ({
    data: { report_activity_ids: [11] }, loading: false, fetching: false, placeholder: false, error: null, reload: () => {},
  }),
  useInvalidateProjectSalesBills: () => invalidate,
}));

const { useChatSalesReport } = await import("./projectChatSalesReport");

type Msg = { id: number; action: string; note: string | null };

function Harness({ messages, onVoided, onTotalSet, sendNote }: { messages: Msg[]; onVoided: (id: number) => void; onTotalSet: () => void; sendNote?: string }) {
  const toast = { success: vi.fn(), error: toastError, info: vi.fn() } as unknown as Parameters<typeof useChatSalesReport>[0]["toast"];
  const r = useChatSalesReport({ projectId: 2259, toast, onTotalSet, onVoided });
  return (
    <div>
      {messages.map((m) => <div key={m.id} data-testid={`msg-${m.id}`}>{r.footerFor(m)}</div>)}
      {sendNote && <button onClick={() => void r.afterSend(sendNote)}>send</button>}
    </div>
  );
}
const toastError = vi.fn();

const BILLS = "10/10\n1. HC13162 RM1999 Ethan\n2. HC13163 RM4172 + 710(T) Ethan";
const SUMMARY_BAD = "JB @ Sutera Mall 9-11/10\n9/10:RM10,500\n10/10:RM37,865+2883\nTotal RM48,185+2883";
const SUMMARY_OK = "Homedec@Zanotti 2-4/10\n2/10 - RM6288\n3/10 - RM8888\n4/10 - RM8538+150(D)\nTotal- RM23,714+150(D";

beforeEach(() => {
  post.mockClear(); patch.mockClear(); invalidate.mockClear(); toastError.mockClear();
  me = { id: 7, email: "ummuaimanlm@gmail.com", position_name: "Operation Executive", position_id: null };
});

describe("the footer under each message", () => {
  test("a counted bill message, a summary with days that do not add up, and Void on every message", async () => {
    const onVoided = vi.fn();
    const onTotalSet = vi.fn();
    render(<Harness
      messages={[{ id: 11, action: "note", note: BILLS }, { id: 12, action: "note", note: SUMMARY_BAD }, { id: 13, action: "note", note: "ok noted" }, { id: 14, action: "pic_change", note: null }]}
      onVoided={onVoided} onTotalSet={onTotalSet}
    />);
    expect(screen.getByTestId("msg-11").textContent).toContain("In sales report · 2 bills · RM 6,171.00");
    expect(screen.getByTestId("msg-12").textContent).toContain("Set Total Sales = RM 48,185.00");
    expect(screen.getByTestId("msg-12").textContent).toContain("Days add up to RM 48,365.00 — use this");
    expect(screen.getByTestId("msg-13").textContent).toBe("Void");
    expect(screen.getByTestId("msg-14").textContent).toBe("");

    fireEvent.click(screen.getByText("Days add up to RM 48,365.00 — use this"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/projects/2259/finance", { total_sales: 48365 }));
    expect(onTotalSet).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("msg-13").querySelector("button")!);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/project-sales-bills/2259/void/13", {}));
    expect(onVoided).toHaveBeenCalledWith(13);
    expect(invalidate).toHaveBeenCalled();
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

  test("a summary whose days add up sets Total Sales at once", async () => {
    const onTotalSet = vi.fn();
    render(<Harness messages={[]} onVoided={() => {}} onTotalSet={onTotalSet} sendNote={SUMMARY_OK} />);
    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/projects/2259/finance", { total_sales: 23714 }));
    expect(onTotalSet).toHaveBeenCalled();
  });

  test("a summary whose days do not add up is not set, and says both figures", async () => {
    render(<Harness messages={[]} onVoided={() => {}} onTotalSet={() => {}} sendNote={SUMMARY_BAD} />);
    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(patch).not.toHaveBeenCalled();
    expect(String(toastError.mock.calls[0]![0])).toContain("RM 48,365.00");
    expect(String(toastError.mock.calls[0]![0])).toContain("RM 48,185.00");
  });
});
