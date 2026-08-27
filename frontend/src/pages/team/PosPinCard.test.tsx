// The 2990 tablet is the only door a showroom salesperson has, and a PIN is the
// whole credential. So the three things pinned here are the three that would
// cost a real person a shift:
//   · a FAILED status read must never render as "No PIN yet" — that invites an
//     admin to overwrite a working credential they cannot see;
//   · a member with no sales profile must be told so, not handed a box whose
//     write is refused with a message they never asked for;
//   · a save that just made someone POS-eligible must OPEN the box, because
//     that is the whole point of the change (the old screen had a button
//     nobody knew to press).
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const success = vi.fn();
const error = vi.fn();
const confirm = vi.fn();

vi.mock("../../api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ success, error }),
}));
vi.mock("../../hooks/useDialog", () => ({
  useDialog: () => ({ confirm: (...a: unknown[]) => confirm(...a) }),
}));

import { PosPinCard } from "./PosPinCard";

const READY_NO_PIN = {
  hasStaffRow: true,
  staffActive: true,
  positionSlug: "sales_executive",
  positionEligible: true,
  hasPin: false,
  updatedAt: null,
};

function mount(overrides: Partial<React.ComponentProps<typeof PosPinCard>> = {}) {
  return render(
    <PosPinCard
      userId={26}
      memberName="Adrian"
      canManage
      pendingSave={false}
      autoOpen={false}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  success.mockReset();
  error.mockReset();
  confirm.mockReset();
});
afterEach(cleanup);

describe("PosPinCard", () => {
  it("reads the status for the member it is showing", async () => {
    get.mockResolvedValue(READY_NO_PIN);
    mount();
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/pos/admin-pin-status/26"));
    expect(await screen.findByText("No PIN yet")).toBeTruthy();
  });

  it("says PIN set — and offers to remove it — when one is on file", async () => {
    get.mockResolvedValue({ ...READY_NO_PIN, hasPin: true, updatedAt: "2026-08-24" });
    mount();
    expect(await screen.findByText("PIN set")).toBeTruthy();
    expect(screen.getByText("Change PIN")).toBeTruthy();
    expect(screen.getByText("Remove PIN")).toBeTruthy();
  });

  it("a failed status read never reads as 'no PIN' and offers no box", async () => {
    get.mockRejectedValue(new Error("network"));
    mount();
    expect(await screen.findByText(/Could not check whether a PIN/)).toBeTruthy();
    expect(screen.queryByText("No PIN yet")).toBeNull();
    expect(screen.queryByText("Set PIN")).toBeNull();
  });

  it("tells the admin when the member has no sales profile yet", async () => {
    get.mockResolvedValue({ ...READY_NO_PIN, hasStaffRow: false });
    mount();
    expect(await screen.findByText(/no sales profile yet/)).toBeTruthy();
    expect(screen.queryByText("Set PIN")).toBeNull();
  });

  it("warns that an inactive sales profile will not appear on the tablet", async () => {
    get.mockResolvedValue({ ...READY_NO_PIN, staffActive: false });
    mount();
    expect(await screen.findByText(/will not list them/)).toBeTruthy();
    // Still settable — the profile may be re-activated; the warning is the point.
    expect(screen.getByText("Set PIN")).toBeTruthy();
  });

  it("posts a six-digit PIN and re-reads the status afterwards", async () => {
    get.mockResolvedValueOnce(READY_NO_PIN).mockResolvedValueOnce({
      ...READY_NO_PIN,
      hasPin: true,
    });
    post.mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(await screen.findByText("Set PIN"));
    const box = screen.getByLabelText("6-digit POS PIN") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "246813" } });
    fireEvent.click(screen.getByText("Set PIN"));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/pos/admin-set-pin/26", { pin: "246813" }),
    );
    expect(await screen.findByText("PIN set")).toBeTruthy();
  });

  it("refuses to send a short PIN — the button stays disabled", async () => {
    get.mockResolvedValue(READY_NO_PIN);
    mount();
    fireEvent.click(await screen.findByText("Set PIN"));
    const box = screen.getByLabelText("6-digit POS PIN") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "24" } });
    fireEvent.click(screen.getByText("Set PIN"));
    expect(post).not.toHaveBeenCalled();
  });

  it("strips anything that is not a digit rather than sending it", async () => {
    get.mockResolvedValue(READY_NO_PIN);
    mount();
    fireEvent.click(await screen.findByText("Set PIN"));
    const box = screen.getByLabelText("6-digit POS PIN") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "1a2b3c4d5e6f7" } });
    expect(box.value).toBe("123456");
  });

  it("opens the entry box on its own after a save that made the member eligible", async () => {
    get.mockResolvedValue(READY_NO_PIN);
    mount({ autoOpen: true });
    expect(await screen.findByLabelText("6-digit POS PIN")).toBeTruthy();
  });

  it("does NOT auto-open over an existing PIN", async () => {
    get.mockResolvedValue({ ...READY_NO_PIN, hasPin: true });
    mount({ autoOpen: true });
    await screen.findByText("PIN set");
    expect(screen.queryByLabelText("6-digit POS PIN")).toBeNull();
  });

  it("asks the admin to save the assignment before issuing a PIN", async () => {
    mount({ pendingSave: true });
    expect(await screen.findByText(/Save the assignment first/)).toBeTruthy();
    // No status read while the eligibility is only in the unsaved draft.
    expect(get).not.toHaveBeenCalled();
  });

  it("shows no controls to a reader who cannot manage members", async () => {
    get.mockResolvedValue(READY_NO_PIN);
    mount({ canManage: false });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText("Set PIN")).toBeNull();
  });

  it("confirms before clearing a PIN, and does nothing if the admin backs out", async () => {
    get.mockResolvedValue({ ...READY_NO_PIN, hasPin: true });
    confirm.mockResolvedValue(false);
    mount();
    fireEvent.click(await screen.findByText("Remove PIN"));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();
  });

  it("clears the PIN once the admin confirms", async () => {
    get.mockResolvedValue({ ...READY_NO_PIN, hasPin: true });
    confirm.mockResolvedValue(true);
    post.mockResolvedValue({ ok: true, cleared: true });
    mount();
    fireEvent.click(await screen.findByText("Remove PIN"));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/pos/admin-reset-pin/26"),
    );
  });

  it("surfaces a refused write instead of pretending it landed", async () => {
    get.mockResolvedValue(READY_NO_PIN);
    post.mockRejectedValue(new Error("A POS PIN only works for a Sales position"));
    mount();
    fireEvent.click(await screen.findByText("Set PIN"));
    fireEvent.change(screen.getByLabelText("6-digit POS PIN"), {
      target: { value: "111111" },
    });
    fireEvent.click(screen.getByText("Set PIN"));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("A POS PIN only works for a Sales position"),
    );
    expect(success).not.toHaveBeenCalled();
  });
});
