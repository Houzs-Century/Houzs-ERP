/* POS Items > Add by category: the picker opens with the categories that
 * have items on ticked, says what each button will do, and sends only the
 * ticked categories to the backend. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../../api/client", () => ({
  api: { post: (...a: unknown[]) => post(...a), get: vi.fn(), patch: vi.fn(), del: vi.fn() },
  onForbidden: () => () => {},
}));

import { ToastProvider } from "../../hooks/useToast";
import { DialogProvider } from "../../hooks/useDialog";
import { PosBoothCategoriesDrawer } from "./PosBoothCategoriesDrawer";

const DRY = {
  dry_run: true,
  total_active: 2787,
  by_category: [
    { category: "SOFA", to_add: 10, active: 1000, off: 0, no_price: 800 },
    { category: "ACCESSORY", to_add: 20, active: 74, off: 2, no_price: 29 },
    { category: "DIFFUSER", to_add: 0, active: 39, off: 0, no_price: 0 },
  ],
};

function renderDrawer() {
  return render(
    <ToastProvider>
      <DialogProvider>
        <PosBoothCategoriesDrawer onClose={() => {}} onChanged={() => {}} />
      </DialogProvider>
    </ToastProvider>,
  );
}

afterEach(() => { cleanup(); post.mockReset(); });

describe("PosBoothCategoriesDrawer", () => {
  it("opens with the categories that have items on ticked and says what each button does", async () => {
    post.mockResolvedValue(DRY);
    renderDrawer();
    await screen.findByText("Accessory");
    expect(post).toHaveBeenCalledWith("/api/pos-admin/items/add-all", { dry_run: true });
    expect((screen.getByLabelText("Accessory") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Diffuser") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Sofa") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Add 30 item(s)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep only ticked (switch off 0)" })).toBeTruthy();
    expect(screen.getByText("1113 in POS stay on")).toBeTruthy();
  });

  it("adds only the ticked categories", async () => {
    post.mockResolvedValue(DRY);
    renderDrawer();
    await screen.findByText("Accessory");
    fireEvent.click(screen.getByLabelText("Diffuser"));
    fireEvent.click(screen.getByLabelText("Sofa"));
    fireEvent.click(screen.getByRole("button", { name: "Add 20 item(s)" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/pos-admin/items/add-all", { categories: ["ACCESSORY"] }));
  });

  it("keeps only the ticked categories after a confirm", async () => {
    post.mockResolvedValue(DRY);
    renderDrawer();
    await screen.findByText("Accessory");
    fireEvent.click(screen.getByLabelText("Sofa"));
    fireEvent.click(screen.getByRole("button", { name: "Keep only ticked (switch off 1000)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep only ticked" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/pos-admin/items/keep-categories", { categories: ["ACCESSORY", "DIFFUSER"] }));
  });
});
