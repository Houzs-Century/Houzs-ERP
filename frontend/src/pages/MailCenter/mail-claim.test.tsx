import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyMailboxNav } from "./mail-sidebar";
import { localPartProblem } from "./mail-claim";

const post = vi.fn(() => Promise.resolve({ ok: true }));
let department: { id: number; name: string } | null = null;
let request: { id: string; address: string; status: string; reason: string | null; createdAt: string } | null = null;

vi.mock("../../api/client", () => ({ api: { get: vi.fn(), post: (...a: unknown[]) => post(...(a as [])) } }));
vi.mock("../../lib/queryClient", () => ({ queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("../../hooks/useQuery", () => ({
  useQuery: (key: string) => ({
    data:
      key === "/api/mail-center/claim"
        ? {
            domain: "houzscentury.com",
            address: null,
            suggestion: "kelly.wong",
            department,
            request,
            departments: [
              { id: 1, name: "Sales Department" },
              { id: 10, name: "Finance Department" },
            ],
          }
        : { level: "personal", manage: false, myAddress: null, mailboxes: [], sendFrom: [] },
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  post.mockClear();
  request = null;
});

const nav = () => render(<MyMailboxNav folder="inbox" mailbox={null} unread={() => 0} drafts={0} onPick={vi.fn()} />);

describe("HC-0157 A claim my address", () => {
  it("someone in a department claims the suggested address in one click", async () => {
    department = { id: 1, name: "Sales Department" };
    nav();
    expect(screen.getByText("Department: Sales Department (from the Org Chart)")).toBeTruthy();
    fireEvent.click(screen.getByText("Ask for kelly.wong@houzscentury.com"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/mail-center/claim", { localPart: "kelly.wong", departmentId: null }));
  });

  it("someone with no department must pick one first, and a bad name is explained", async () => {
    department = null;
    nav();
    fireEvent.change(screen.getByLabelText("Address name"), { target: { value: "kelly..w" } });
    expect(screen.getByText(/2 to 40 letters or digits/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Address name"), { target: { value: "Kelly" } });
    const button = screen.getByText("Ask for kelly@houzscentury.com") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "10" } });
    fireEvent.click(button);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/mail-center/claim", { localPart: "kelly", departmentId: 10 }));
    expect(screen.getByText("An admin confirms your department.")).toBeTruthy();
  });

  it("matches the server's rule for the name", () => {
    for (const ok of ["kelly", "kelly.wong", "k-w_2"]) expect(localPartProblem(ok)).toBeNull();
    for (const bad of ["k", "kelly wong", ".kelly", "kelly-", "a..b", "x@y"]) expect(localPartProblem(bad)).not.toBeNull();
  });

  it("a waiting request shows instead of the form", () => {
    department = { id: 1, name: "Sales Department" };
    request = { id: "r1", address: "kelly@houzscentury.com", status: "requested", reason: null, createdAt: "2026-11-24" };
    nav();
    expect(screen.getByText("kelly@houzscentury.com")).toBeTruthy();
    expect(screen.getByText(/Waiting for an admin to approve it/)).toBeTruthy();
    expect(screen.queryByLabelText("Address name")).toBeNull();
  });

  it("a rejected request shows the reason above the form", () => {
    department = { id: 1, name: "Sales Department" };
    request = { id: "r1", address: "boss@houzscentury.com", status: "rejected", reason: "Use your own name", createdAt: "2026-11-24" };
    nav();
    expect(screen.getByText("boss@houzscentury.com was not approved: Use your own name. Pick another.")).toBeTruthy();
    expect(screen.getByLabelText("Address name")).toBeTruthy();
  });
});
