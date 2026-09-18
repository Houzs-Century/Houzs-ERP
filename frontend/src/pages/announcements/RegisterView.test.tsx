// Register mode — the department document register (owner 2026-09-09).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../../api/client", () => ({ api: { get: apiGet, post: apiPost, putBinary: apiPut, downloadFile: download } }));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ can: (k: string) => (k === "memos.manage" ? authState.canManage : false), user: authState.user }),
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: toastSuccess, error: vi.fn() }) }));
vi.mock("../../hooks/useDialog", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true), prompt: vi.fn(async () => promptAnswer.value) }),
}));
vi.mock("../../hooks/useQuery", async () => {
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

import { RegisterView } from "./RegisterView";

const ROWS = [
  { id: "memo-1", refNo: "OPS-MEMO-2609-0001", title: "Forklift keys", departmentId: 7, departmentName: "Operation", deptCode: "OPS", docType: "MEMO", memoDate: "2026-09-09", notes: null, file: { name: "Memo.pdf", mime: "application/pdf", size: 2048 }, createdBy: 606, createdByName: "Wira", createdAt: "2026-09-09T02:00:00Z", voidedBy: null, voidedByName: null, voidedAt: null, voidReason: null },
  { id: "memo-2", refNo: "HR-SOP-2609-0001", title: "Leave policy", departmentId: 8, departmentName: "Human Resources", deptCode: "HR", docType: "SOP", memoDate: "2026-09-08", notes: null, file: null, createdBy: 608, createdByName: "Hana", createdAt: "2026-09-08T02:00:00Z", voidedBy: 700, voidedByName: "Adam", voidedAt: "2026-09-09T01:00:00Z", voidReason: "Superseded." },
];
const TYPES = [
  { code: "ANN", label: "Announcement", attachmentRequired: false },
  { code: "MEMO", label: "Memo", attachmentRequired: false },
  { code: "SOP", label: "Standard operating procedure", attachmentRequired: true },
  { code: "WARN", label: "Warning", attachmentRequired: false },
];

function seed() {
  apiGet.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/memos")) return { data: ROWS };
    if (url.startsWith("/api/document-refs/next")) {
      const type = /typeCode=([A-Z]+)/.exec(url)?.[1] ?? "MEMO";
      return { data: { refNo: `OPS-${type}-2609-${type === "MEMO" ? "0002" : "0001"}` } };
    }
    if (url === "/api/departments") return { departments: [{ id: 7, name: "Operation", code: "OPS" }, { id: 8, name: "Human Resources", code: "HR" }, { id: 9, name: "Canteen", code: null }] };
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

describe("Register mode", () => {
  it("lists the register: numbers with their type, a voided row struck through with its reason, the file as a download", async () => {
    seed();
    render(<RegisterView docTypes={TYPES} />);
    await waitFor(() => expect(screen.getByText("OPS-MEMO-2609-0001")).toBeTruthy());
    // The default list asks the server for live rows only.
    expect(apiGet).toHaveBeenCalledWith("/api/memos?includeVoided=0");
    expect(screen.getByText("SOP").getAttribute("title")).toBe("Standard operating procedure");
    expect(screen.getByText(/Voided by Adam/).textContent).toContain("Superseded.");
    fireEvent.click(screen.getByRole("button", { name: /Memo.pdf/ }));
    expect(download).toHaveBeenCalledWith("/api/memos/memo-1/file", "Memo.pdf");
    // Void… only on the caller's own live document.
    expect(screen.getAllByRole("button", { name: "Void…" })).toHaveLength(1);
    // The type filter rides the request; ANN is never offered.
    const typeFilter = screen.getByLabelText("Filter by type") as HTMLSelectElement;
    expect([...typeFilter.options].map((o) => o.value)).toEqual(["", "MEMO", "SOP", "WARN"]);
    fireEvent.change(typeFilter, { target: { value: "SOP" } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/memos?includeVoided=0&docType=SOP"));
  });

  it("a plain user registers for their own department only; the type rides the POST and the toast carries the number", async () => {
    seed();
    apiPost.mockResolvedValue({ data: { ...ROWS[0], refNo: "OPS-WARN-2609-0001", docType: "WARN" } });
    render(<RegisterView docTypes={TYPES} />);
    await waitFor(() => expect(screen.getByText("OPS-MEMO-2609-0001")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Register a document/ }));
    const dept = screen.getByLabelText("Department") as HTMLSelectElement;
    expect(dept.disabled).toBe(true);
    expect(dept.options).toHaveLength(1);
    expect(dept.value).toBe("7");
    const type = screen.getByLabelText("Document type") as HTMLSelectElement;
    expect(type.value).toBe("MEMO");
    // The next number follows the picked type — a preview, from the server.
    await waitFor(() => expect(screen.getByTestId("ref-no-preview").textContent).toContain("OPS-MEMO-2609-0002"));
    fireEvent.change(type, { target: { value: "WARN" } });
    await waitFor(() => expect(screen.getByTestId("ref-no-preview").textContent).toContain("OPS-WARN-2609-0001"));
    fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Late again" } });
    fireEvent.change(screen.getByLabelText("Document date"), { target: { value: "10/09/2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Register & number" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/memos", expect.objectContaining({ title: "Late again", docType: "WARN", departmentId: 7, memoDate: "2026-09-10" })));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Registered as OPS-WARN-2609-0001"));
  });

  it("a type whose policy demands a file holds Register until one is uploaded; a manager picks any department, a department without a code is refused before posting", async () => {
    seed();
    authState.canManage = true;
    render(<RegisterView docTypes={TYPES} />);
    await waitFor(() => expect(screen.getByText("OPS-MEMO-2609-0001")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Register a document/ }));
    const dept = screen.getByLabelText("Department") as HTMLSelectElement;
    expect(dept.disabled).toBe(false);
    expect(dept.options).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Forklift SOP" } });
    fireEvent.change(screen.getByLabelText("Document type"), { target: { value: "SOP" } });
    expect(screen.getByText(/must carry its file/)).toBeTruthy();
    const register = screen.getByRole("button", { name: "Register & number" }) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Document type"), { target: { value: "MEMO" } });
    expect(register.disabled).toBe(false);
    fireEvent.change(dept, { target: { value: "9" } });
    expect(screen.getByText(/Canteen has no department code yet/)).toBeTruthy();
    expect(register.disabled).toBe(true);
    // The manager may void anyone's live document.
    expect(screen.getAllByRole("button", { name: "Void…" })).toHaveLength(1);
  });

  it("Void… asks a reason and posts it", async () => {
    seed();
    apiPost.mockResolvedValue({ data: ROWS[0] });
    render(<RegisterView docTypes={TYPES} />);
    await waitFor(() => expect(screen.getByText("OPS-MEMO-2609-0001")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Void…" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/memos/memo-1/void", { reason: "Issued in error." }));
  });
});
