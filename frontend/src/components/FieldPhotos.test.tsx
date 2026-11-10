/* The field-photo block: on a phone the add tile offers the camera OR the photo
   library (iPhone `capture` alone forces the camera, so a photo already taken
   could not be picked), "Take another" after a shot, and a failed photo shows
   Retry and Remove. */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldPhotos } from "./FieldPhotos";
import type { FieldPhoto, FieldPhotosApi } from "../lib/fieldPhotos";

const photo = (id: string, status: FieldPhoto["status"], error: string | null = null): FieldPhoto => ({
  id, file: new File(["x"], `${id}.jpg`, { type: "image/jpeg" }), stamped: true, previewUrl: null, status, key: null, sessionId: null, error,
});
const api = (photos: FieldPhoto[], restore: FieldPhotosApi["restore"] = { phase: "off" }): FieldPhotosApi => ({
  photos, max: 10, notice: null, restore, retryRestore: vi.fn(), skipRestore: vi.fn(),
  add: vi.fn(), retry: vi.fn(), remove: vi.fn(), clear: vi.fn(), gate: vi.fn(),
});
const touch = (coarse: boolean) => {
  window.matchMedia = ((q: string) => ({ matches: coarse && q.includes("coarse") })) as unknown as typeof window.matchMedia;
};

afterEach(() => vi.restoreAllMocks());

describe("FieldPhotos", () => {
  it("camera input captures, library input does not and takes several", () => {
    const { container } = render(<FieldPhotos api={api([])} disabled={false} title="POD photos" />);
    const camera = container.querySelector('[data-testid="field-photos-camera"]');
    const library = container.querySelector('[data-testid="field-photos-library"]');
    expect(camera?.getAttribute("capture")).toBe("environment");
    expect(library?.hasAttribute("capture")).toBe(false);
    expect(library?.hasAttribute("multiple")).toBe(true);
  });

  it("on a phone, Add offers Take photo or the library; after a shot, Take another", () => {
    touch(true);
    const a = api([]);
    const { container } = render(<FieldPhotos api={a} disabled={false} title="POD photos" />);
    fireEvent.click(screen.getByText("Add photos"));
    expect(screen.getByText("Take photo")).toBeTruthy();
    expect(screen.getByText("From photo library (pick several)")).toBeTruthy();

    const camera = container.querySelector('[data-testid="field-photos-camera"]') as HTMLInputElement;
    fireEvent.change(camera, { target: { files: [new File(["x"], "shot.jpg", { type: "image/jpeg" })] } });
    expect(a.add).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Take another")).toBeTruthy();
    expect(screen.getByText(/Photo added/)).toBeTruthy();
  });

  it("shows each photo's state, with Retry on a failed one and the reason", () => {
    touch(false);
    const a = api([photo("a", "done"), photo("b", "uploading"), photo("c", "failed", "No signal")]);
    render(<FieldPhotos api={a} disabled={false} title="POD photos" />);
    expect(screen.getByText("Uploaded")).toBeTruthy();
    expect(screen.getByText("Uploading…")).toBeTruthy();
    expect(screen.getByText("Photo 3: No signal")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(a.retry).toHaveBeenCalledWith("c");
    fireEvent.click(screen.getByLabelText("Remove photo 1"));
    expect(a.remove).toHaveBeenCalledWith("a");
  });

  it("while completing, nothing can be removed or retried", () => {
    render(<FieldPhotos api={api([photo("c", "failed", "x")])} disabled title="POD photos" />);
    expect(screen.queryByText("Retry")).toBeNull();
    expect(screen.queryByLabelText("Remove photo 1")).toBeNull();
  });

  it("after a reload, says it is checking for photos already uploaded", () => {
    render(<FieldPhotos api={api([], { phase: "loading" })} disabled={false} title="POD photos" />);
    expect(screen.getByText(/Checking for photos you already uploaded/)).toBeTruthy();
  });

  it("a failed re-list names the reason and offers Check again / Continue without them", () => {
    const a = api([], { phase: "failed", error: "No signal" });
    render(<FieldPhotos api={a} disabled={false} title="POD photos" />);
    expect(screen.getByRole("alert").textContent).toMatch(/\(No signal\)/);
    fireEvent.click(screen.getByText("Check again"));
    expect(a.retryRestore).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Continue without them"));
    expect(a.skipRestore).toHaveBeenCalled();
  });
});
