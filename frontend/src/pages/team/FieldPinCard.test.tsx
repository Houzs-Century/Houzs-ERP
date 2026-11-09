// Crew PIN card: what an admin can and cannot do, and the one failure that
// costs a real person a shift — a failed status read must never look like "no
// PIN", or the admin overwrites a PIN the crew member is using.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
const success = vi.fn();
const error = vi.fn();
const confirm = vi.fn();

vi.mock("../../api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    del: (...a: unknown[]) => del(...a),
  },
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success, error }) }));
vi.mock("../../hooks/useDialog", () => ({ useDialog: () => ({ confirm: (...a: unknown[]) => confirm(...a) }) }));

import { FieldPinCard } from "./FieldPinCard";

const status = (over: Record<string, unknown> = {}) => ({
  eligible: true,
  reason: "ok",
  login: "EMP-0042",
  hasPin: false,
  locked: false,
  lockedUntil: null,
  setAt: null,
  ...over,
});

const mount = () => render(<FieldPinCard userId={42} memberName="Ali" />);

beforeEach(() => {
  [get, post, del, success, error, confirm].forEach((f) => f.mockReset());
});
afterEach(cleanup);

describe("FieldPinCard", () => {
  it("shows the staff code and sets a PIN", async () => {
    get.mockResolvedValue(status());
    post.mockResolvedValue({ ok: true, login: "EMP-0042" });
    mount();
    expect(await screen.findByText("EMP-0042")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set PIN" }));
    fireEvent.change(screen.getByLabelText("New 6-digit crew PIN"), { target: { value: "48a2913" } });
    fireEvent.click(screen.getByRole("button", { name: "Set PIN" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/field-pin/42", { pin: "482913" }));
    expect(success).toHaveBeenCalledWith(expect.stringContaining("EMP-0042"));
  });

  it("renders nothing for an office member with no PIN", async () => {
    get.mockResolvedValue(status({ eligible: false, reason: "not_crew_title" }));
    const { container } = mount();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("a failed read says so and offers no Set PIN", async () => {
    get.mockRejectedValue(new Error("boom"));
    mount();
    expect(await screen.findByText(/Could not check the crew PIN/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set PIN" })).toBeNull();
  });

  it("explains a locked PIN and lets the admin remove it", async () => {
    get.mockResolvedValue(status({ hasPin: true, locked: true, lockedUntil: "2026-11-10T00:15:00Z" }));
    confirm.mockResolvedValue(true);
    del.mockResolvedValue({ ok: true });
    mount();
    expect(await screen.findByText("Locked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove PIN" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/field-pin/42"));
  });

  it("an ineligible member who still holds a PIN can only have it removed", async () => {
    get.mockResolvedValue(status({ eligible: false, reason: "not_crew_title", hasPin: true }));
    mount();
    expect(await screen.findByText(/not a Driver \/ Helper Title/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Set/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove PIN" })).toBeTruthy();
  });

  it("shows the server's refusal when a set fails", async () => {
    get.mockResolvedValue(status());
    post.mockRejectedValue(new Error("That PIN is too easy to guess (a run of digits)."));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Set PIN" }));
    fireEvent.change(screen.getByLabelText("New 6-digit crew PIN"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Set PIN" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("That PIN is too easy to guess (a run of digits)."));
  });
});
