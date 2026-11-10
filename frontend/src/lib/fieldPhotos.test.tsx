/* Field photos upload the moment they are picked, so a driver never loses them
   to a page reload or a dropped signal at Complete. Pinned here: the per-photo
   state machine (queued -> uploading -> done | failed -> retry), one upload at
   a time, Complete refused while anything is in flight or failed, and no
   silent cap. */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  admit, completionGate, fieldPhotosReducer, nextToUpload, useFieldPhotos, type FieldPhoto, type FieldPhotoRestore, type RestoreState,
} from "./fieldPhotos";

const OFF: RestoreState = { phase: "off" };

vi.mock("./photoStamp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./photoStamp")>()),
  stampNow: vi.fn(async () => ({ at: new Date("2026-11-08T06:00:00Z"), source: "server" as const })),
  stampPhoto: vi.fn(async (f: File) => new File([f], "stamped.jpg", { type: "image/jpeg" })),
}));

const jpg = (name: string) => new File(["x"], name, { type: "image/jpeg" });
const photo = (id: string, status: FieldPhoto["status"], key: string | null = null): FieldPhoto => ({
  id, file: jpg(`${id}.jpg`), stamped: false, previewUrl: null, status, key, sessionId: key ? `s-${id}` : null, error: null,
});

describe("fieldPhotosReducer", () => {
  it("walks queued -> uploading -> done", () => {
    let s = fieldPhotosReducer([], { type: "add", photos: [photo("a", "queued")] });
    s = fieldPhotosReducer(s, { type: "start", id: "a" });
    expect(s[0]?.status).toBe("uploading");
    s = fieldPhotosReducer(s, { type: "done", id: "a", key: "slips/a", sessionId: "s-a" });
    expect(s[0]).toMatchObject({ status: "done", key: "slips/a" });
  });

  it("a failed photo goes back to the queue on retry, with its error cleared", () => {
    let s = fieldPhotosReducer([photo("a", "uploading")], { type: "failed", id: "a", error: "offline" });
    expect(s[0]).toMatchObject({ status: "failed", error: "offline" });
    s = fieldPhotosReducer(s, { type: "retry", id: "a" });
    expect(s[0]).toMatchObject({ status: "queued", error: null });
  });

  it("retry does nothing to a photo that did not fail", () => {
    const s = fieldPhotosReducer([photo("a", "done", "k")], { type: "retry", id: "a" });
    expect(s[0]?.status).toBe("done");
  });

  it("a result arriving for a removed photo is ignored", () => {
    let s = fieldPhotosReducer([photo("a", "uploading")], { type: "remove", id: "a" });
    s = fieldPhotosReducer(s, { type: "done", id: "a", key: "k", sessionId: null });
    expect(s).toEqual([]);
  });
});

describe("nextToUpload", () => {
  it("uploads one at a time", () => {
    expect(nextToUpload([photo("a", "uploading"), photo("b", "queued")])).toBeNull();
    expect(nextToUpload([photo("a", "done"), photo("b", "queued")])?.id).toBe("b");
    expect(nextToUpload([photo("a", "failed")])).toBeNull();
  });
});

describe("completionGate", () => {
  it("refuses while a photo is still uploading, and says so", () => {
    const g = completionGate([photo("a", "done", "k1"), photo("b", "uploading")], "none", OFF);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/1 photo is still uploading/);
  });

  it("refuses while a photo failed, and names Retry / Remove", () => {
    const g = completionGate([photo("a", "done", "k1"), photo("b", "failed"), photo("c", "failed")], "none", OFF);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/2 photos did not upload. Tap Retry, or Remove them/);
  });

  it("refuses with the screen's own message when there are no photos", () => {
    expect(completionGate([], "Take a POD photo first.", OFF)).toEqual({ ok: false, reason: "Take a POD photo first." });
  });

  it("sends only the keys of uploaded photos, in order", () => {
    expect(completionGate([photo("a", "done", "k1"), photo("b", "done", "k2")], "none", OFF)).toEqual({ ok: true, keys: ["k1", "k2"] });
  });
});

describe("admit", () => {
  it("says how many were left out instead of cutting silently", () => {
    expect(admit(8, 4, 10)).toEqual({ take: 2, message: "At most 10 photos per job. 2 photos were not added." });
    expect(admit(0, 3, 10)).toEqual({ take: 3, message: null });
  });
});

describe("useFieldPhotos", () => {
  it("uploads each photo on pick (stamped), retries a failure, and gates Complete", async () => {
    const upload = vi.fn<(f: File) => Promise<{ r2Key: string }>>()
      .mockResolvedValueOnce({ r2Key: "slips/1" })
      .mockRejectedValueOnce(new Error("No signal"))
      .mockResolvedValueOnce({ r2Key: "slips/2" });
    const { result } = renderHook(() => useFieldPhotos({ stampLabel: "DO-2611-0001", max: 10, upload, restore: null }));

    act(() => result.current.add([jpg("a.jpg"), jpg("b.jpg")]));
    // Complete is blocked the moment photos are picked, before any upload ends.
    expect(result.current.gate("none").ok).toBe(false);

    await waitFor(() => expect(result.current.photos.map((p) => p.status)).toEqual(["done", "failed"]));
    expect(upload).toHaveBeenCalledTimes(2);
    // The stamped copy is what was uploaded, not the raw file.
    expect(upload.mock.calls[0]?.[0].name).toBe("stamped.jpg");
    expect(result.current.photos[1]?.error).toBe("No signal");
    const blocked = result.current.gate("none");
    expect(blocked.ok).toBe(false);

    act(() => result.current.retry(result.current.photos[1]!.id));
    await waitFor(() => expect(result.current.photos.map((p) => p.status)).toEqual(["done", "done"]));
    expect(upload).toHaveBeenCalledTimes(3);
    expect(result.current.gate("none")).toEqual({ ok: true, keys: ["slips/1", "slips/2"] });
  });

  it("does not stamp when the label is null (office uploads)", async () => {
    const upload = vi.fn(async () => ({ r2Key: "slips/x" }));
    const { result } = renderHook(() => useFieldPhotos({ stampLabel: null, max: 10, upload, restore: null }));
    act(() => result.current.add([jpg("raw.jpg")]));
    await waitFor(() => expect(result.current.photos[0]?.status).toBe("done"));
    expect((upload.mock.calls[0] as unknown as [File])[0].name).toBe("raw.jpg");
  });

  it("refuses a non-photo file and over-the-limit picks with a visible notice", () => {
    const upload = vi.fn(async () => ({ r2Key: "slips/x" }));
    const { result } = renderHook(() => useFieldPhotos({ stampLabel: null, max: 1, upload, restore: null }));
    act(() => result.current.add([new File(["%PDF"], "a.pdf", { type: "application/pdf" }), jpg("a.jpg"), jpg("b.jpg")]));
    expect(result.current.photos).toHaveLength(1);
    expect(result.current.notice).toMatch(/1 file is not a JPEG, PNG or WebP photo/);
    expect(result.current.notice).toMatch(/At most 1 photos per job. 1 photo was not added./);
  });

  it("a removed photo leaves Complete with the rest", async () => {
    const upload = vi.fn<(f: File) => Promise<{ r2Key: string }>>()
      .mockResolvedValueOnce({ r2Key: "slips/1" })
      .mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useFieldPhotos({ stampLabel: null, max: 10, upload, restore: null }));
    act(() => result.current.add([jpg("a.jpg"), jpg("b.jpg")]));
    await waitFor(() => expect(result.current.photos[1]?.status).toBe("failed"));
    act(() => result.current.remove(result.current.photos[1]!.id));
    expect(result.current.gate("none")).toEqual({ ok: true, keys: ["slips/1"] });
  });
});

describe("completionGate while the photos already uploaded are being looked up", () => {
  it("waits while the re-list is loading, so a job is not completed without them", () => {
    const g = completionGate([photo("a", "done", "k1")], "none", { phase: "loading" });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/Checking for photos you already uploaded/);
  });

  it("refuses after a failed re-list, naming the reason and both ways out", () => {
    const g = completionGate([photo("a", "done", "k1")], "none", { phase: "failed", error: "No signal" });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/\(No signal\)\. Tap Check again, or Continue without them/);
  });

  it("lets Complete through once the crew chose to continue without them", () => {
    expect(completionGate([photo("a", "done", "k1")], "none", { phase: "skipped" })).toEqual({ ok: true, keys: ["k1"] });
  });
});

describe("fieldPhotosReducer restore", () => {
  it("puts back re-listed photos first, without duplicating one the screen already holds", () => {
    const s = fieldPhotosReducer([photo("a", "done", "k1")], { type: "restore", photos: [photo("x", "done", "k1"), photo("y", "done", "k0")] });
    expect(s.map((p) => p.key)).toEqual(["k0", "k1"]);
  });
});

function fakeRestore(over: Partial<FieldPhotoRestore> = {}): FieldPhotoRestore & { list: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn> } {
  return {
    key: "job:project:P-1:setup",
    list: vi.fn(async () => [{ uploadSessionId: "s1", r2Key: "slips/old-1" }, { uploadSessionId: "s2", r2Key: "slips/old-2" }]),
    preview: vi.fn(async (id: string) => `blob:${id}`),
    discard: vi.fn(async () => {}),
    ...over,
  } as FieldPhotoRestore & { list: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn> };
}

describe("useFieldPhotos after a page reload", () => {
  it("re-lists the photos already uploaded for this stop and completes with them", async () => {
    const upload = vi.fn(async () => ({ r2Key: "slips/new", uploadSessionId: "s3" }));
    const restore = fakeRestore();
    // A fresh mount is exactly what a reload produces: nothing in memory.
    const { result } = renderHook(() => useFieldPhotos({ stampLabel: null, max: 10, upload, restore }));
    expect(result.current.restore.phase).toBe("loading");
    expect(result.current.gate("none").ok).toBe(false);

    await waitFor(() => expect(result.current.restore.phase).toBe("done"));
    expect(result.current.photos.map((p) => [p.status, p.key])).toEqual([["done", "slips/old-1"], ["done", "slips/old-2"]]);
    await waitFor(() => expect(result.current.photos[0]?.previewUrl).toBe("blob:s1"));
    expect(upload).not.toHaveBeenCalled();

    act(() => result.current.add([jpg("c.jpg")]));
    await waitFor(() => expect(result.current.photos[2]?.status).toBe("done"));
    expect(result.current.gate("none")).toEqual({ ok: true, keys: ["slips/old-1", "slips/old-2", "slips/new"] });
    expect(restore.list).toHaveBeenCalledTimes(1);
  });

  it("removing an uploaded photo tells the server, so it does not come back", async () => {
    const upload = vi.fn(async () => ({ r2Key: "slips/new", uploadSessionId: "s3" }));
    const restore = fakeRestore();
    const { result } = renderHook(() => useFieldPhotos({ stampLabel: null, max: 10, upload, restore }));
    await waitFor(() => expect(result.current.photos).toHaveLength(2));
    act(() => result.current.remove(result.current.photos[0]!.id));
    expect(restore.discard).toHaveBeenCalledWith("s1");
    act(() => result.current.add([jpg("c.jpg")]));
    await waitFor(() => expect(result.current.photos[1]?.status).toBe("done"));
    act(() => result.current.remove(result.current.photos[1]!.id));
    expect(restore.discard).toHaveBeenLastCalledWith("s3");
  });

  it("says so when the server could not be told about a removal", async () => {
    const restore = fakeRestore({ discard: vi.fn(async () => { throw new Error("No signal"); }) });
    const { result } = renderHook(() => useFieldPhotos({ stampLabel: null, max: 10, upload: vi.fn(), restore }));
    await waitFor(() => expect(result.current.photos).toHaveLength(2));
    act(() => result.current.remove(result.current.photos[0]!.id));
    await waitFor(() => expect(result.current.notice).toMatch(/server was not told \(No signal\)/));
  });

  it("a failed re-list blocks Complete until Check again succeeds or the crew continues without it", async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error("No signal"))
      .mockResolvedValueOnce([{ uploadSessionId: "s1", r2Key: "slips/old-1" }]);
    const restore = fakeRestore({ list });
    const { result } = renderHook(() => useFieldPhotos({ stampLabel: null, max: 10, upload: vi.fn(), restore }));
    await waitFor(() => expect(result.current.restore).toEqual({ phase: "failed", error: "No signal" }));
    expect(result.current.gate("none").ok).toBe(false);

    act(() => result.current.retryRestore());
    await waitFor(() => expect(result.current.restore.phase).toBe("done"));
    expect(result.current.gate("none")).toEqual({ ok: true, keys: ["slips/old-1"] });
  });

  it("Continue without them unblocks Complete after a failed re-list", async () => {
    const restore = fakeRestore({ list: vi.fn(async () => { throw new Error("502"); }) });
    const upload = vi.fn(async () => ({ r2Key: "slips/new", uploadSessionId: "s3" }));
    const { result } = renderHook(() => useFieldPhotos({ stampLabel: null, max: 10, upload, restore }));
    await waitFor(() => expect(result.current.restore.phase).toBe("failed"));
    act(() => result.current.add([jpg("c.jpg")]));
    await waitFor(() => expect(result.current.photos[0]?.status).toBe("done"));
    expect(result.current.gate("none").ok).toBe(false);
    act(() => result.current.skipRestore());
    expect(result.current.gate("none")).toEqual({ ok: true, keys: ["slips/new"] });
  });

  it("does not ask the server when the screen passes no restore", () => {
    const { result } = renderHook(() => useFieldPhotos({ stampLabel: null, max: 10, upload: vi.fn(), restore: null }));
    expect(result.current.restore.phase).toBe("off");
    expect(result.current.gate("none")).toEqual({ ok: false, reason: "none" });
  });
});
