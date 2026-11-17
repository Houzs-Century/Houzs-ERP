import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { isPdfAttachment, openAssrAttachment } from "./assrAttachmentOpen";

describe("isPdfAttachment", () => {
  it("treats application/pdf as a PDF", () => {
    expect(isPdfAttachment("application/pdf")).toBe(true);
  });

  it("does not treat photos, videos or a missing type as a PDF", () => {
    expect(isPdfAttachment("image/jpeg")).toBe(false);
    expect(isPdfAttachment("video/mp4")).toBe(false);
    expect(isPdfAttachment(null)).toBe(false);
  });
});

describe("openAssrAttachment", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens a stored return DO PDF in a new tab", async () => {
    const tab = { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const fetchBlobUrl = vi.spyOn(api, "fetchBlobUrl").mockResolvedValue("blob:return-do");

    await openAssrAttachment("assr/1539/return_do_1-1794881444370.pdf", "application/pdf");

    expect(fetchBlobUrl).toHaveBeenCalledWith(
      "/api/assr/attachments/assr/1539/return_do_1-1794881444370.pdf",
      "application/pdf",
    );
    expect(tab.location.href).toBe("blob:return-do");
  });
});
