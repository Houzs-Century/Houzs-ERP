/* The Sabah/Sarawak defect cleaning stage (owner 2026-10-12/13).
 *
 * Pins the three gates that decide whether the stage shows and who can act:
 *   - only a Defect Item in Sabah/Sarawak shows it at all;
 *   - BD/owner get the "Cleaning done" toggle; everyone else gets a read-only
 *     "Cleaned" chip (and nothing while it is not yet cleaned);
 *   - the toggle POSTs done / none to the item's defect-cleaning endpoint.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../../api/client", () => ({ api: { post } }));

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../../auth/AuthContext", () => ({ useAuth }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }) }));

import { DefectCleaning, isEastMalaysiaState, showsDefectCleaning } from "./DefectCleaning";
import type { ChecklistItem } from "./types";

const item = (over: Partial<ChecklistItem> = {}): ChecklistItem =>
  ({ id: 9, title: "Defect Item Setup", cleaning_status: null, ...over }) as ChecklistItem;

const bd = { id: 7, role_name: "BD Exec", position_name: "Operation Executive", email: "u@x.my", permissions: [] };
const sales = { id: 2, role_name: "Sales Person", position_name: "Sales Executive", email: "s@x.my", permissions: [] };

afterEach(cleanup);
beforeEach(() => { post.mockReset(); post.mockResolvedValue({}); useAuth.mockReset(); toastError.mockReset(); });

describe("isEastMalaysiaState / showsDefectCleaning", () => {
  test("only Sabah and Sarawak are east-Malaysia", () => {
    expect(isEastMalaysiaState("Sabah")).toBe(true);
    expect(isEastMalaysiaState("sarawak")).toBe(true);
    expect(isEastMalaysiaState("Selangor")).toBe(false);
    expect(isEastMalaysiaState(null)).toBe(false);
  });
  test("only a Defect Item in those states shows the stage", () => {
    expect(showsDefectCleaning(item(), "Sabah")).toBe(true);
    expect(showsDefectCleaning(item({ title: "Permit" }), "Sabah")).toBe(false);
    expect(showsDefectCleaning(item(), "Selangor")).toBe(false);
  });
});

describe("DefectCleaning component", () => {
  test("renders nothing outside Sabah/Sarawak", () => {
    useAuth.mockReturnValue({ user: bd });
    const { container } = render(<DefectCleaning item={item()} projectId={1} projectState="Selangor" onChanged={() => {}} />);
    expect(container.textContent).toBe("");
  });

  test("BD gets a 'Cleaning done' button that POSTs done", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    useAuth.mockReturnValue({ user: bd });
    render(<DefectCleaning item={item()} projectId={1} projectState="Sabah" onChanged={onChanged} />);
    const btn = screen.getByRole("button", { name: /Cleaning done/i });
    await user.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/projects/1/checklist/9/defect-cleaning", { status: "done" }));
    expect(onChanged).toHaveBeenCalled();
  });

  test("BD on an already-cleaned item can undo (POSTs none)", async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue({ user: bd });
    render(<DefectCleaning item={item({ cleaning_status: "done" })} projectId={1} projectState="Sarawak" onChanged={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Cleaned/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/projects/1/checklist/9/defect-cleaning", { status: "none" }));
  });

  test("a non-BD viewer sees the Cleaned chip but NO button when done", () => {
    useAuth.mockReturnValue({ user: sales });
    render(<DefectCleaning item={item({ cleaning_status: "done" })} projectId={1} projectState="Sabah" onChanged={() => {}} />);
    expect(screen.getByText(/Cleaned/i)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a non-BD viewer sees nothing while it is not yet cleaned", () => {
    useAuth.mockReturnValue({ user: sales });
    const { container } = render(<DefectCleaning item={item()} projectId={1} projectState="Sabah" onChanged={() => {}} />);
    expect(container.textContent).toBe("");
  });

  test("a refused save reaches the operator (toast) and does not reload", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    post.mockRejectedValue(new Error("You don't have permission."));
    useAuth.mockReturnValue({ user: bd });
    render(<DefectCleaning item={item()} projectId={1} projectState="Sabah" onChanged={onChanged} />);
    await user.click(screen.getByRole("button", { name: /Cleaning done/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toContain("You don't have permission");
    expect(onChanged).not.toHaveBeenCalled();
  });
});
