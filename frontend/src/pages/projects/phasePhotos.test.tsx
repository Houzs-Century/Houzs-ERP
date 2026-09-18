/* Phase Photos on the project detail page: crew uploads grouped by phase, image
 * thumbnails through the authenticated blob fetch, and a delete that only
 * refreshes the grid when the server actually removed the file. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  toastError: vi.fn(),
  del: vi.fn(async (_path: string): Promise<unknown> => ({ ok: true })),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: async () => ({
        photos: [
          { id: 1, phase: "setup", r2_key: "p/1.jpg", content_type: "image/jpeg", caption: null, uploaded_by: 3, uploaded_by_name: "Ali", uploaded_at: "2026-08-01T10:00:00Z" },
          { id: 2, phase: "dismantle", r2_key: "p/2.pdf", content_type: "application/pdf", caption: null, uploaded_by: 4, uploaded_by_name: "Muthu", uploaded_at: "2026-08-05T10:00:00Z" },
          { id: 3, phase: "service", r2_key: "p/3.jpg", content_type: "image/jpeg", caption: null, uploaded_by: 4, uploaded_by_name: "Muthu", uploaded_at: "2026-08-06T10:00:00Z" },
        ],
      }),
      fetchBlobUrl: async () => "blob:thumb-1",
      del: (path: string) => h.del(path),
    },
  };
});
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ show: () => {}, success: () => {}, error: h.toastError, info: () => {}, warning: () => {} }),
}));
vi.mock("../../hooks/useDialog", () => ({
  useDialog: () => ({ confirm: async () => true, prompt: async () => null, alert: async () => {} }),
}));

import { PhasePhotosSection, PhotoGroup } from "./phasePhotos";

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PhasePhotosSection projectId={157} />
    </QueryClientProvider>,
  );
}

describe("PhotoGroup", () => {
  it("says so when a phase has no photos", () => {
    render(<PhotoGroup label="Setup" photos={[]} onChange={() => {}} />);
    expect(screen.getByText("Setup · 0")).toBeTruthy();
    expect(screen.getByText("No setup photos yet.")).toBeTruthy();
  });
});

describe("PhasePhotosSection", () => {
  it("groups setup and dismantle uploads and loads the image thumbnail", async () => {
    renderSection();
    expect(await screen.findByText("Setup · 1")).toBeTruthy();
    expect(screen.getByText("Dismantle · 1")).toBeTruthy();
    expect(screen.getByText("PDF")).toBeTruthy();
    await waitFor(() => expect(document.querySelector('img[src="blob:thumb-1"]')).toBeTruthy());
  });

  it("keeps the tile and says why when the delete is refused", async () => {
    h.del.mockRejectedValueOnce(new Error("You don't have permission to do that"));
    renderSection();
    await screen.findByText("Setup · 1");
    fireEvent.click(screen.getAllByTitle("Delete")[0]);
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith("You don't have permission to do that"));
    expect(h.del).toHaveBeenCalledWith("/api/projects/phase-photos/1");
    expect(screen.getByText("Setup · 1")).toBeTruthy();
  });
});
