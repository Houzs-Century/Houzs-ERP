// Settings → Documents: the document-type registry with its
// "attachment required before submit" switch (owner 2026-09-06).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPatch, apiPost, canValue, toastSuccess } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
  canValue: { value: true },
  toastSuccess: vi.fn(),
}));
vi.mock("../../api/client", () => ({ api: { get: apiGet, patch: apiPatch, post: apiPost } }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => canValue.value }) }));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: toastSuccess, error: vi.fn() }) }));
vi.mock("../../hooks/useQuery", async () => {
  const React = await import("react");
  return {
    useQuery: (_key: string, fn: () => Promise<unknown>) => {
      const [state, setState] = React.useState<{ data: unknown; loading: boolean }>({ data: null, loading: true });
      const load = React.useCallback(() => void fn().then((d) => setState({ data: d, loading: false })), [fn]);
      React.useEffect(() => {
        load();
      }, []);
      return { ...state, error: null, fetching: false, placeholder: false, reload: load };
    },
  };
});

import { DocumentTypesTab } from "./DocumentTypesTab";

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPost.mockReset();
  toastSuccess.mockReset();
  canValue.value = true;
});

function seed() {
  apiGet.mockResolvedValue({
    data: [
      { code: "ANN", label: "Announcement", attachmentRequired: false, isActive: true },
      { code: "SOP", label: "Procedure", attachmentRequired: true, isActive: false },
    ],
  });
}

describe("DocumentTypesTab", () => {
  it("lists the registry and flips the attachment policy with a PATCH", async () => {
    seed();
    apiPatch.mockResolvedValue({ success: true });
    render(<DocumentTypesTab />);
    await waitFor(() => expect(screen.getByText("Announcement")).toBeTruthy());
    const ann = screen.getByLabelText("Attachment required for Announcement") as HTMLInputElement;
    expect(ann.checked).toBe(false);
    expect((screen.getByLabelText("Attachment required for Procedure") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(ann);
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith("/api/document-types/ANN", { attachmentRequired: true }));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("attachment is now required"));
  });

  it("without settings.manage the switches are disabled and New type is absent", async () => {
    seed();
    canValue.value = false;
    render(<DocumentTypesTab />);
    await waitFor(() => expect(screen.getByText("Announcement")).toBeTruthy());
    expect((screen.getByLabelText("Attachment required for Announcement") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /New type/ })).toBeNull();
  });

  it("New type validates the 2–4 letter code and POSTs", async () => {
    seed();
    apiPost.mockResolvedValue({ success: true });
    render(<DocumentTypesTab />);
    await waitFor(() => expect(screen.getByText("Announcement")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /New type/ }));
    fireEvent.change(screen.getByLabelText("Type code"), { target: { value: "memo1" } });
    fireEvent.change(screen.getByLabelText("Type label"), { target: { value: "Memo" } });
    expect((screen.getByRole("button", { name: "Add type" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type code"), { target: { value: "memo" } });
    fireEvent.click(screen.getByRole("button", { name: "Add type" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/document-types", { code: "MEMO", label: "Memo" }));
  });
});
