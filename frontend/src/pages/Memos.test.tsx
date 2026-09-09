// Memos — the department memo register (owner 2026-09-08).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, apiPut, download, authState, promptAnswer, toastSuccess } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  download: vi.fn(),
  authState: { canManage: false, user: { id: 606, department_id: 7, department_name: "Operation" } as { id: number; department_id: number | null; department_name: string | null } },
  promptAnswer: { value: "Issued in error." as string | null },
  toastSuccess: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: { get: apiGet, post: apiPost, putBinary: apiPut, downloadFile: download } }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ can: (k: string) => (k === "memos.manage" ? authState.canManage : false), user: authState.user }),
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => ({ success: toastSuccess, error: vi.fn() }) }));
vi.mock("../hooks/useDialog", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true), prompt: vi.fn(async () => promptAnswer.value) }),
}));
vi.mock("../hooks/useQuery", async () => {
  const React = await import("react");
  return {
    useQuery: (key: string, fn: () => Promise<unknown>) => {
      const [state, setState] = React.useState<{ data: unknown; loading: boolean }>({ data: null, loading: true });
      const load = React.useCallback(() => void fn().then((d) => setState({ data: d, loading: false })), [fn]);
      React.useEffect(() => {
        load();
      }, [key]);
      return { ...state, error: null, fetching: false, placeholder: false, reload: load };
    },
  };
});
vi.mock("../components/Layout", () => ({
  PageHeader: (p: { title: string; primaryAction?: ReactNode }) => (
    <div>
      <h1>{p.title}</h1>
      {p.primaryAction}
    </div>
  ),
}));

import { Memos } from "./Memos";

const MEMOS = [
  { id: "memo-1", refNo: "OPS-MEMO-2609-0001", title: "Forklift keys", departmentId: 7, departmentName: "Operation", deptCode: "OPS", memoDate: "2026-09-09", notes: null, file: { name: "Memo.pdf", mime: "application/pdf", size: 2048 }, createdBy: 606, createdByName: "Wira", createdAt: "2026-09-09T02:00:00Z", voidedBy: null, voidedByName: null, voidedAt: null, voidReason: null },
  { id: "memo-2", refNo: "HR-MEMO-2609-0001", title: "Leave policy", departmentId: 8, departmentName: "Human Resources", deptCode: "HR", memoDate: "2026-09-08", notes: null, file: null, createdBy: 608, createdByName: "Hana", createdAt: "2026-09-08T02:00:00Z", voidedBy: 700, voidedByName: "Adam", voidedAt: "2026-09-09T01:00:00Z", voidReason: "Superseded." },
];

function seed() {
  apiGet.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/memos")) return { data: MEMOS };
    if (url === "/api/departments") return { departments: [{ id: 7, name: "Operation", code: "OPS" }, { id: 8, name: "Human Resources", code: "HR" }, { id: 9, name: "Canteen", code: null }] };
    if (url === "/api/document-types") return { data: [{ code: "ANN", label: "Announcement", attachmentRequired: false }, { code: "MEMO", label: "Memo", attachmentRequired: false }] };
    return {};
  });
}

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
  download.mockReset();
  toastSuccess.mockReset();
  authState.canManage = false;
  promptAnswer.value = "Issued in error.";
});

describe("Memos register", () => {
  it("lists the register: numbers, a voided row struck through with its reason, the file as a download", async () => {
    seed();
    render(<Memos />);
    await waitFor(() => expect(screen.getByText("OPS-MEMO-2609-0001")).toBeTruthy());
    // The default list asks the server for live rows only.
    expect(apiGet).toHaveBeenCalledWith("/api/memos?includeVoided=0");
    expect(screen.getByText(/Voided by Adam/).textContent).toContain("Superseded.");
    fireEvent.click(screen.getByRole("button", { name: /Memo.pdf/ }));
    expect(download).toHaveBeenCalledWith("/api/memos/memo-1/file", "Memo.pdf");
    // Void… only on the caller's own live memo.
    expect(screen.getAllByRole("button", { name: "Void…" })).toHaveLength(1);
  });

  it("a plain user registers for their own department only; Register posts and toasts the number", async () => {
    seed();
    apiPost.mockResolvedValue({ data: { ...MEMOS[0], refNo: "OPS-MEMO-2609-0002" } });
    render(<Memos />);
    await waitFor(() => expect(screen.getByText("OPS-MEMO-2609-0001")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /New memo/ }));
    const dept = screen.getByLabelText("Department") as HTMLSelectElement;
    expect(dept.disabled).toBe(true);
    expect(dept.options).toHaveLength(1);
    expect(dept.value).toBe("7");
    fireEvent.change(screen.getByLabelText("Memo title"), { target: { value: "Forklift keys v2" } });
    fireEvent.change(screen.getByLabelText("Memo date"), { target: { value: "10/09/2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Register & number" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/memos", expect.objectContaining({ title: "Forklift keys v2", departmentId: 7, memoDate: "2026-09-10" })));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Registered as OPS-MEMO-2609-0002"));
  });

  it("a memo manager picks any department; a department without a code is refused before posting", async () => {
    seed();
    authState.canManage = true;
    render(<Memos />);
    await waitFor(() => expect(screen.getByText("OPS-MEMO-2609-0001")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /New memo/ }));
    const dept = screen.getByLabelText("Department") as HTMLSelectElement;
    expect(dept.disabled).toBe(false);
    expect(dept.options).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Memo title"), { target: { value: "Canteen hours" } });
    fireEvent.change(dept, { target: { value: "9" } });
    expect(screen.getByText(/Canteen has no department code yet/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Register & number" }) as HTMLButtonElement).disabled).toBe(true);
    // The manager may void anyone's live memo.
    expect(screen.getAllByRole("button", { name: "Void…" })).toHaveLength(1);
  });

  it("Void… asks a reason and posts it", async () => {
    seed();
    apiPost.mockResolvedValue({ data: MEMOS[0] });
    render(<Memos />);
    await waitFor(() => expect(screen.getByText("OPS-MEMO-2609-0001")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Void…" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/memos/memo-1/void", { reason: "Issued in error." }));
  });
});
