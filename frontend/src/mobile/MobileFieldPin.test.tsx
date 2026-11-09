import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
const prompt = vi.fn();
const confirm = vi.fn();
const notify = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    del: (...a: unknown[]) => del(...a),
  },
}));
vi.mock("../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => prompt }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => confirm }));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => notify }));

import { MobileFieldPin } from "./MobileFieldPin";

const status = (over: Record<string, unknown> = {}) => ({
  eligible: true, reason: "ok", login: "EMP-0042", hasPin: false, locked: false, lockedUntil: null, setAt: null, ...over,
});

beforeEach(() => [get, post, del, prompt, confirm, notify].forEach((f) => f.mockReset()));
afterEach(cleanup);

describe("MobileFieldPin — same endpoints and rules as the desktop card", () => {
  it("sets a PIN through the prompt", async () => {
    get.mockResolvedValue(status());
    prompt.mockResolvedValue(" 482913 ");
    post.mockResolvedValue({ ok: true, login: "EMP-0042" });
    render(<MobileFieldPin userId={42} memberName="Ali" />);
    fireEvent.click(await screen.findByRole("button", { name: "Set PIN" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/field-pin/42", { pin: "482913" }));
  });

  it("renders nothing for an office member with no PIN", async () => {
    get.mockResolvedValue(status({ eligible: false, reason: "not_crew_title" }));
    const { container } = render(<MobileFieldPin userId={42} memberName="Ali" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("a failed read is not shown as 'No PIN yet'", async () => {
    get.mockRejectedValue(new Error("x"));
    render(<MobileFieldPin userId={42} memberName="Ali" />);
    expect(await screen.findByText(/Could not check the crew PIN/)).toBeTruthy();
    expect(screen.queryByText(/No PIN yet/)).toBeNull();
  });

  it("removes a PIN after confirmation", async () => {
    get.mockResolvedValue(status({ hasPin: true, locked: true }));
    confirm.mockResolvedValue(true);
    del.mockResolvedValue({ ok: true });
    render(<MobileFieldPin userId={42} memberName="Ali" />);
    expect(await screen.findByText(/Locked after too many wrong PINs/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove PIN" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/field-pin/42"));
  });
});
