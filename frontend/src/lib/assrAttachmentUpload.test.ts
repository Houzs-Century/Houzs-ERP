import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom (25.x) does not implement Blob#arrayBuffer, which the module under
// test calls on the prepared File. Polyfill via FileReader for the suite.
beforeAll(() => {
  if (typeof Blob.prototype.arrayBuffer !== "function") {
    Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as ArrayBuffer);
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(this);
      });
    };
  }
});

// Mock the low-level client (network) and the pipeline (canvas) so the test
// drives ONLY this module's contract: main PUT first, optional thumb PUT
// second, thumb failure non-fatal.
vi.mock("../api/client", () => ({
  api: { putBinary: vi.fn() },
}));
vi.mock("./imagePipeline", () => ({
  prepareImageForUpload: vi.fn(),
}));

import { api } from "../api/client";
import { prepareImageForUpload } from "./imagePipeline";
import { uploadAssrAttachment } from "./assrAttachmentUpload";

const putBinary = api.putBinary as unknown as ReturnType<typeof vi.fn>;
const prepare = prepareImageForUpload as unknown as ReturnType<typeof vi.fn>;

const asFile = (name: string, type: string) => new File([new Uint8Array(8)], name, { type });

beforeEach(() => {
  putBinary.mockReset();
  prepare.mockReset();
});

describe("uploadAssrAttachment", () => {
  it("uploads the prepared file, then its thumb under the returned key", async () => {
    const main = asFile("photo.webp", "image/webp");
    const thumb = asFile("photo.webp", "image/webp");
    prepare.mockResolvedValue({ file: main, thumb, compressed: true });
    putBinary
      .mockResolvedValueOnce({ id: 7, key: "assr/12/evidence-x.webp" })
      .mockResolvedValueOnce({ ok: true });

    const res = await uploadAssrAttachment(12, asFile("photo.jpg", "image/jpeg"), "evidence");

    expect(res).toEqual({ id: 7, key: "assr/12/evidence-x.webp" });
    expect(putBinary).toHaveBeenCalledTimes(2);
    expect(putBinary.mock.calls[0][0]).toBe(
      "/api/assr/12/attachments?category=evidence&ext=webp&name=photo.webp",
    );
    expect(putBinary.mock.calls[1][0]).toBe(
      "/api/assr/12/attachments/thumb?key=assr%2F12%2Fevidence-x.webp",
    );
  });

  it("skips the thumb leg when the pipeline produced none (video/PDF/fallback)", async () => {
    const vid = asFile("clip.mp4", "video/mp4");
    prepare.mockResolvedValue({ file: vid, thumb: null, compressed: false });
    putBinary.mockResolvedValueOnce({ id: 9, key: "assr/12/evidence-y.mp4" });

    await uploadAssrAttachment(12, vid, "evidence");
    expect(putBinary).toHaveBeenCalledTimes(1);
  });

  it("still resolves when the thumb PUT fails - the attachment is already saved", async () => {
    const main = asFile("p.webp", "image/webp");
    prepare.mockResolvedValue({ file: main, thumb: main, compressed: true });
    putBinary
      .mockResolvedValueOnce({ id: 3, key: "assr/5/complaint-z.webp" })
      .mockRejectedValueOnce(new Error("thumb 500"));

    const res = await uploadAssrAttachment(5, main, "complaint");
    expect(res.id).toBe(3);
  });

  it("propagates a MAIN upload failure - never pretends a failed save worked", async () => {
    prepare.mockResolvedValue({ file: asFile("p.jpg", "image/jpeg"), thumb: null, compressed: false });
    putBinary.mockRejectedValueOnce(new Error("413"));
    await expect(uploadAssrAttachment(5, asFile("p.jpg", "image/jpeg"), "evidence")).rejects.toThrow("413");
  });
});
