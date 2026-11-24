import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailHostPending } from "./MailHostPending";

const patch = vi.fn(() => Promise.resolve({ ok: true }));
const post = vi.fn(() => Promise.resolve({ ok: true }));
const reload = vi.fn();

vi.mock("../../api/client", () => ({
  api: { get: vi.fn(), patch: (...a: unknown[]) => patch(...(a as [])), post: (...a: unknown[]) => post(...(a as [])) },
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../hooks/useQuery", () => ({
  useQuery: () => ({
    data: [{ id: "a1", address: "gan@houzscentury.com", name: "Gan", createdAt: "2026-11-23", userId: 5, requestedDepartment: null }],
    loading: false,
    error: null,
    reload,
  }),
}));

afterEach(() => {
  cleanup();
  patch.mockClear();
  post.mockClear();
});

describe("Waiting to be added in Google Workspace", () => {
  it("turns an address off only after the second, named click", async () => {
    render(<MailHostPending />);
    fireEvent.click(screen.getByText("Turn off"));
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Turn off gan@houzscentury.com"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/mail-center/addresses/a1", { active: false }));
  });

  it("Keep it backs out without changing anything", () => {
    render(<MailHostPending />);
    fireEvent.click(screen.getByText("Turn off"));
    fireEvent.click(screen.getByText("Keep it"));
    expect(screen.getByText("Mark added")).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });
});
