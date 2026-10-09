/* One way to look at POD photos everywhere (owner, 2026-10-08: a job can carry
 * many photos and must not take many pages to open): a grid, a full-screen
 * viewer with previous / next and "n / total", and downloads. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchBlobUrl } = vi.hoisted(() => ({ fetchBlobUrl: vi.fn(async (p: string) => `blob:${p}`) }));
vi.mock("../../api/client", () => ({ api: { fetchBlobUrl } }));

import { PodPhotoAlbum } from "./PodPhotoAlbum";

const wrap = (paths: string[], emptyText?: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PodPhotoAlbum paths={paths} fileStem="POD-TEST" emptyText={emptyText} />
    </QueryClientProvider>,
  );

afterEach(() => { cleanup(); fetchBlobUrl.mockClear(); });

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
});
