import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isCompressibleImage,
  loadThumbFirst,
  prepareImageForUpload,
  THUMB_KEY_SUFFIX,
  thumbUrlFor,
} from "./imagePipeline";

// ---------------------------------------------------------------------------
// Environment stubs. jsdom ships neither createImageBitmap nor a real canvas
// 2d context, which conveniently IS the graceful-fallback environment; the
// happy-path tests stub both.
// ---------------------------------------------------------------------------

function fileOfSize(bytes: number, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function stubBitmap(width: number, height: number) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

/** Stub document.createElement("canvas") with a canvas whose toBlob yields
 *  blobs from `plan` in call order. Non-canvas tags pass through. */
function stubCanvas(plan: Array<{ type: string; size: number } | null>) {
  let call = 0;
  const real = document.createElement.bind(document);
  return vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") return real(tag);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (cb: (b: Blob | null) => void, requestedType: string) => {
        const step = plan[Math.min(call, plan.length - 1)];
        call += 1;
        if (step === null) {
          cb(null);
          return;
        }
        // Mirror the real API: an unsupported requested type silently falls
        // back to PNG. The plan's `type` is what the "browser" produces.
        void requestedType;
        cb(new Blob([new Uint8Array(step.size)], { type: step.type }));
      },
    };
    return canvas as unknown as HTMLElement;
  }) as typeof document.createElement);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("thumb key vocabulary", () => {
  it("appends the deterministic sibling suffix", () => {
    expect(thumbUrlFor("/api/assr/attachments/assr/12/evidence.jpg")).toBe(
      "/api/assr/attachments/assr/12/evidence.jpg" + THUMB_KEY_SUFFIX,
    );
    expect(THUMB_KEY_SUFFIX).toBe(".thumb");
  });
});

describe("isCompressibleImage", () => {
  it("accepts photo formats and rejects vectors/animations/docs", () => {
    expect(isCompressibleImage(fileOfSize(10, "a.jpg", "image/jpeg"))).toBe(true);
    expect(isCompressibleImage(fileOfSize(10, "a.png", "image/png"))).toBe(true);
    expect(isCompressibleImage(fileOfSize(10, "a.heic", "image/heic"))).toBe(true);
    expect(isCompressibleImage(fileOfSize(10, "a.gif", "image/gif"))).toBe(false);
    expect(isCompressibleImage(fileOfSize(10, "a.svg", "image/svg+xml"))).toBe(false);
    expect(isCompressibleImage(fileOfSize(10, "a.pdf", "application/pdf"))).toBe(false);
  });
});

describe("prepareImageForUpload — graceful fallback", () => {
  it("passes non-images through untouched", async () => {
    const pdf = fileOfSize(1000, "slip.pdf", "application/pdf");
    const out = await prepareImageForUpload(pdf);
    expect(out.file).toBe(pdf);
    expect(out.thumb).toBeNull();
    expect(out.compressed).toBe(false);
  });

  it("returns the original when createImageBitmap is unavailable (jsdom)", async () => {
    const jpg = fileOfSize(6 * 1024 * 1024, "photo.jpg", "image/jpeg");
    const out = await prepareImageForUpload(jpg);
    expect(out.file).toBe(jpg);
    expect(out.thumb).toBeNull();
    expect(out.compressed).toBe(false);
  });

  it("returns the original when decode fails", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("undecodable")));
    const heic = fileOfSize(4 * 1024 * 1024, "photo.heic", "image/heic");
    const out = await prepareImageForUpload(heic);
    expect(out.file).toBe(heic);
    expect(out.compressed).toBe(false);
  });
});

describe("prepareImageForUpload — compression", () => {
  it("re-encodes a large jpeg to a smaller webp and generates a thumb", async () => {
    const cib = vi.fn().mockResolvedValue(stubBitmap(4000, 3000));
    vi.stubGlobal("createImageBitmap", cib);
    // Call 1 = main webp (600 KB), call 2 = thumb webp (20 KB).
    stubCanvas([
      { type: "image/webp", size: 600 * 1024 },
      { type: "image/webp", size: 20 * 1024 },
    ]);

    const jpg = fileOfSize(6 * 1024 * 1024, "IMG_0042.jpg", "image/jpeg");
    const out = await prepareImageForUpload(jpg);

    // EXIF orientation must be requested from the decoder — canvas re-encode
    // strips the EXIF tag, so the pixels have to be upright already.
    expect(cib).toHaveBeenCalledWith(jpg, { imageOrientation: "from-image" });
    expect(out.compressed).toBe(true);
    expect(out.file.type).toBe("image/webp");
    expect(out.file.name).toBe("IMG_0042.webp");
    expect(out.file.size).toBe(600 * 1024);
    expect(out.thumb).not.toBeNull();
    expect(out.thumb!.type).toBe("image/webp");
    expect(out.thumb!.size).toBe(20 * 1024);
  });

  it("falls back to jpeg when the browser cannot encode webp", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(stubBitmap(4000, 3000)));
    // Each render tries webp first (browser answers png = unsupported), then
    // jpeg. Main: png, jpeg(500 KB). Thumb: png, jpeg(18 KB).
    stubCanvas([
      { type: "image/png", size: 5 * 1024 * 1024 },
      { type: "image/jpeg", size: 500 * 1024 },
      { type: "image/png", size: 100 * 1024 },
      { type: "image/jpeg", size: 18 * 1024 },
    ]);

    const jpg = fileOfSize(6 * 1024 * 1024, "photo.jpg", "image/jpeg");
    const out = await prepareImageForUpload(jpg);
    expect(out.compressed).toBe(true);
    expect(out.file.type).toBe("image/jpeg");
    expect(out.thumb!.type).toBe("image/jpeg");
  });

  it("never converts a png to jpeg (alpha would flatten) - keeps the original", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(stubBitmap(3000, 2000)));
    // webp unsupported (browser falls back to png) on every encode attempt.
    stubCanvas([{ type: "image/png", size: 2 * 1024 * 1024 }]);

    const png = fileOfSize(4 * 1024 * 1024, "shot.png", "image/png");
    const out = await prepareImageForUpload(png);
    expect(out.file).toBe(png);
    expect(out.compressed).toBe(false);
    expect(out.thumb).toBeNull();
  });

  it("keeps the original when the re-encode comes out larger", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(stubBitmap(2400, 1800)));
    // Main webp LARGER than the source; thumb still small and useful.
    stubCanvas([
      { type: "image/webp", size: 900 * 1024 },
      { type: "image/webp", size: 15 * 1024 },
    ]);

    const jpg = fileOfSize(700 * 1024, "tight.jpg", "image/jpeg");
    const out = await prepareImageForUpload(jpg);
    expect(out.file).toBe(jpg);
    expect(out.compressed).toBe(false);
    expect(out.thumb!.size).toBe(15 * 1024);
  });

  it("skips the re-encode for small in-budget jpegs but still makes the thumb", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(stubBitmap(1200, 900)));
    stubCanvas([{ type: "image/webp", size: 10 * 1024 }]);

    const jpg = fileOfSize(300 * 1024, "small.jpg", "image/jpeg");
    const out = await prepareImageForUpload(jpg);
    expect(out.file).toBe(jpg);
    expect(out.compressed).toBe(false);
    expect(out.thumb!.size).toBe(10 * 1024);
  });
});

describe("loadThumbFirst — the both-directions fallback", () => {
  it("uses the thumb when it loads (new photos)", async () => {
    const fetchUrl = vi.fn().mockResolvedValue("blob:thumb");
    const out = await loadThumbFirst(fetchUrl, "/api/x/key.jpg");
    expect(out).toBe("blob:thumb");
    expect(fetchUrl).toHaveBeenCalledTimes(1);
    expect(fetchUrl).toHaveBeenCalledWith("/api/x/key.jpg.thumb");
  });

  it("falls back to the original when the thumb 404s (pre-thumb photos)", async () => {
    const fetchUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error("404"))
      .mockResolvedValueOnce("blob:full");
    const out = await loadThumbFirst(fetchUrl, "/api/x/key.jpg");
    expect(out).toBe("blob:full");
    expect(fetchUrl).toHaveBeenNthCalledWith(1, "/api/x/key.jpg.thumb");
    expect(fetchUrl).toHaveBeenNthCalledWith(2, "/api/x/key.jpg");
  });

  it("skips the thumb tier entirely when preferThumb=false", async () => {
    const fetchUrl = vi.fn().mockResolvedValue("blob:full");
    await loadThumbFirst(fetchUrl, "/api/x/key.jpg", false);
    expect(fetchUrl).toHaveBeenCalledTimes(1);
    expect(fetchUrl).toHaveBeenCalledWith("/api/x/key.jpg");
  });

  it("propagates a failure of the ORIGINAL - never hides a real failed read", async () => {
    const fetchUrl = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(loadThumbFirst(fetchUrl, "/api/x/key.jpg")).rejects.toThrow("network down");
  });
});
