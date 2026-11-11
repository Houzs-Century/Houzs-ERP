import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PickedAttachmentChip } from "./PickedAttachmentChip";
import type { OutboundAttachment } from "./mail-attach-files";

function attachment(name: string, type: string): OutboundAttachment {
  return { name, type, size: 12, contentBase64: btoa("file content") };
}

const createObjectUrl = vi.fn(() => "blob:preview-1");
const revokeObjectUrl = vi.fn();

beforeEach(() => {
  createObjectUrl.mockClear();
  revokeObjectUrl.mockClear();
  URL.createObjectURL = createObjectUrl;
  URL.revokeObjectURL = revokeObjectUrl;
});

afterEach(cleanup);

describe("picked attachment chip", () => {
  it("opens a picked PDF in a new tab before it is sent", () => {
    render(<PickedAttachmentChip file={attachment("PO-2611-136-R1.pdf", "application/pdf")} isDisabled={false} onRemove={() => {}} />);
    const link = screen.getByRole("link", { name: /PO-2611-136-R1\.pdf/ });
    expect(link.getAttribute("href")).toBe("blob:preview-1");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("shows a thumbnail for a picked photo", () => {
    const { container } = render(
      <PickedAttachmentChip file={attachment("site.jpg", "image/jpeg")} isDisabled={false} onRemove={() => {}} />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview-1");
  });

  it("does not open types that could run script, like SVG", () => {
    render(<PickedAttachmentChip file={attachment("logo.svg", "image/svg+xml")} isDisabled={false} onRemove={() => {}} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("frees the preview when the chip is removed", () => {
    const onRemove = vi.fn();
    const { unmount } = render(
      <PickedAttachmentChip file={attachment("quote.pdf", "application/pdf")} isDisabled={false} onRemove={onRemove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove quote.pdf" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:preview-1");
  });
});
