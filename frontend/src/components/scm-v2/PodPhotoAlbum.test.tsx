/* One way to look at POD photos everywhere (owner, 2026-10-08: a job can carry
 * many photos and must not take many pages to open): a grid, a full-screen
 * viewer with previous / next and "n / total", and downloads. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchBlobUrl, fetchBlobWithTime, makePodPhotosPdf, deliverPdfBlob } = vi.hoisted(() => ({
  fetchBlobUrl: vi.fn(async (p: string) => `blob:${p}`),
  fetchBlobWithTime: vi.fn(async () => ({ blob: new Blob(["x"]), storedAt: null })),
  makePodPhotosPdf: vi.fn(),
  deliverPdfBlob: vi.fn(),
}));
vi.mock("../../api/client", () => ({ api: { fetchBlobUrl, fetchBlobWithTime } }));
vi.mock("../../vendor/scm/lib/pod-photos-pdf", () => ({ makePodPhotosPdf }));
vi.mock("../../vendor/scm/lib/pdf-common", () => ({ deliverPdfBlob }));

import { PodPhotoAlbum } from "./PodPhotoAlbum";

const wrap = (paths: string[], emptyText?: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PodPhotoAlbum paths={paths} fileStem="POD-TEST" title="DO-2611-004" emptyText={emptyText} />
    </QueryClientProvider>,
  );

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("PodPhotoAlbum", () => {
  it("shows every photo as a thumbnail with the count", async () => {
    wrap(["/p/0", "/p/1", "/p/2"]);
    expect(screen.getByText("3 photos")).toBeTruthy();
    await waitFor(() => expect(screen.getByAltText("POD photo 3")).toBeTruthy());
    expect(fetchBlobUrl).toHaveBeenCalledTimes(3);
  });

  it("opens the viewer on a photo, steps with the arrows and the keyboard, wraps, and closes on Escape", async () => {
    wrap(["/p/0", "/p/1", "/p/2"]);
    await waitFor(() => expect(screen.getByAltText("POD photo 1")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Open photo 2 of 3"));
    expect(screen.getByText("2 / 3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next photo"));
    expect(screen.getByText("3 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("3 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says so when there is nothing, and fetches nothing", () => {
    wrap([], "No photo yet.");
    expect(screen.getByText("No photo yet.")).toBeTruthy();
    expect(fetchBlobUrl).not.toHaveBeenCalled();
  });

  it("makes one PDF of every photo under the document number and downloads it on a desktop", async () => {
    makePodPhotosPdf.mockImplementation(async (o: { onProgress: (d: number, t: number) => void; fetchPhoto: (p: string) => Promise<unknown> }) => {
      o.onProgress(2, 3);
      await o.fetchPhoto("/p/0");
      return { blob: new Blob(["%PDF"], { type: "application/pdf" }), filename: "DO-2611-004 POD photos.pdf", skipped: 0 };
    });
    wrap(["/p/0", "/p/1", "/p/2"]);
    fireEvent.click(screen.getByText("Download PDF"));
    await waitFor(() => expect(deliverPdfBlob).toHaveBeenCalledTimes(1));
    expect(makePodPhotosPdf).toHaveBeenCalledWith(expect.objectContaining({ title: "DO-2611-004", paths: ["/p/0", "/p/1", "/p/2"] }));
    expect(fetchBlobWithTime).toHaveBeenCalledWith("/p/0");
    expect(deliverPdfBlob.mock.calls[0]?.[1]).toBe("DO-2611-004 POD photos.pdf");
    expect(deliverPdfBlob.mock.calls[0]?.[2]).toBe("save");
    await waitFor(() => expect(screen.getByText("Download PDF")).toBeTruthy());
  });

  it("says so when the PDF cannot be made, instead of doing nothing", async () => {
    makePodPhotosPdf.mockRejectedValue(new Error("None of the photos could be read, so there is nothing to put in the PDF."));
    wrap(["/p/0"]);
    fireEvent.click(screen.getByText("Download PDF"));
    expect((await screen.findByRole("alert")).textContent).toContain("None of the photos could be read");
    expect(deliverPdfBlob).not.toHaveBeenCalled();
  });

  it("on a phone hands the PDF to the share sheet (WhatsApp) instead of downloading it", async () => {
    makePodPhotosPdf.mockResolvedValue({ blob: new Blob(["%PDF"], { type: "application/pdf" }), filename: "DO-2611-004 POD photos.pdf", skipped: 0 });
    const share = vi.fn(async () => {});
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)" }));
    Object.assign(navigator, { canShare: () => true, share });
    try {
      wrap(["/p/0"]);
      fireEvent.click(screen.getByText("Download PDF"));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      const arg = (share.mock.calls[0] as unknown as [{ files: File[] }])[0];
      expect(arg.files[0]?.name).toBe("DO-2611-004 POD photos.pdf");
      expect(deliverPdfBlob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      Object.assign(navigator, { canShare: undefined, share: undefined });
    }
  });
});
