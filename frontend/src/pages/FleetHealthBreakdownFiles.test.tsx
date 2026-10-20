// A breakdown / incident case keeps the scene photos and videos.
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { putBinary, del, fetchBlobUrl } = vi.hoisted(() => ({ putBinary: vi.fn(), del: vi.fn(), fetchBlobUrl: vi.fn() }));
vi.mock("../api/client", () => ({ api: { putBinary, del, fetchBlobUrl } }));

import { BreakdownFiles, mediaLabel } from "./FleetHealthBreakdownFiles";

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("BreakdownFiles", () => {
  it("names a new file by its key and an old mobile slip as the driver's photo", () => {
    expect(mediaLabel("fleet/breakdowns/b1/1700-scene.mp4")).toBe("scene.mp4");
    expect(mediaLabel("slips/2026/10/abc.jpg")).toBe("Driver photo");
  });

  it("opens the old mobile photo through the case's own file route", async () => {
    fetchBlobUrl.mockResolvedValue("blob:x");
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    render(<BreakdownFiles caseId="b1" refs={["slips/2026/10/abc.jpg"]} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByText("Driver photo"));
    await waitFor(() => expect(fetchBlobUrl).toHaveBeenCalledWith("/api/fleet-breakdown-files/b1/file?key=slips%2F2026%2F10%2Fabc.jpg"));
    openSpy.mockRestore();
  });

  it("uploads a photo and a video one at a time", async () => {
    putBinary.mockResolvedValue({});
    const onChanged = vi.fn();
    render(<BreakdownFiles caseId="b1" refs={[]} onChanged={onChanged} />);
    const a = new File(["a"], "scene.jpg", { type: "image/jpeg" });
    const b = new File(["b"], "clip.MOV", { type: "video/quicktime" });
    fireEvent.change(screen.getByLabelText("Attach photos or videos"), { target: { files: [a, b] } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(putBinary.mock.calls.map((c) => c[0])).toEqual([
      "/api/fleet-breakdown-files/b1?ext=jpg&name=scene.jpg",
      "/api/fleet-breakdown-files/b1?ext=mov&name=clip.MOV",
    ]);
  });

  it("refuses a video over 50 MB before sending it", async () => {
    render(<BreakdownFiles caseId="b1" refs={[]} onChanged={vi.fn()} />);
    const big = new File(["x"], "long.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: 51 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("Attach photos or videos"), { target: { files: [big] } });
    expect(await screen.findByText("long.mp4: a video can be at most 50 MB.")).toBeTruthy();
    expect(putBinary).not.toHaveBeenCalled();
  });

  it("removes a file by its key", async () => {
    del.mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(<BreakdownFiles caseId="b1" refs={["fleet/breakdowns/b1/1-scene.jpg"]} onChanged={onChanged} />);
    fireEvent.click(screen.getByLabelText("Remove scene.jpg"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(del).toHaveBeenCalledWith("/api/fleet-breakdown-files/b1?key=fleet%2Fbreakdowns%2Fb1%2F1-scene.jpg");
  });
});
