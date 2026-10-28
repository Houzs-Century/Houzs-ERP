// The service-case detail view renders SEVERAL upload targets at once, so a
// pasted screenshot must land in the zone the user is pointing at — never in
// a sibling slot (wrong category on a customer-visible record) and never
// twice. This suite pins the routing rules: hover claims a paste, non-hover
// ignores it, disabled/unmounted zones can't claim, and drops bypassing the
// file picker still get the picker's type filter.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UploadDropZone,
  acceptedUploadFiles,
  clipboardFiles,
  hoveredUploadZones,
  useStrayFileDropGuard,
} from "./uploadDropZone";

afterEach(cleanup);
beforeEach(() => hoveredUploadZones.clear());

const asFile = (name: string, type: string) => new File([new Uint8Array(4)], name, { type });

/** Build a dispatchable paste event carrying file (and/or string) items —
 *  jsdom has no DataTransfer constructor, so fake the items list. */
function pasteEvent(files: File[], withText = false): ClipboardEvent {
  const e = new Event("paste", { bubbles: true, cancelable: true }) as any;
  const items = files.map((f) => ({ kind: "file", getAsFile: () => f }));
  if (withText) items.push({ kind: "string", getAsFile: () => null } as any);
  e.clipboardData = { items };
  return e as ClipboardEvent;
}

describe("clipboardFiles", () => {
  it("keeps a named clipboard file as-is and skips string items", () => {
    const f = asFile("shot.png", "image/png");
    const out = clipboardFiles(pasteEvent([f], true));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(f);
  });

  it("synthesizes a name from the MIME for nameless blobs (screenshot paste)", () => {
    const out = clipboardFiles(pasteEvent([asFile("", "image/jpeg"), asFile("", "image/png")]));
    expect(out.map((f) => f.name.split(".").pop())).toEqual(["jpg", "png"]);
    expect(out[0].name.startsWith("pasted-")).toBe(true);
  });

  it("returns [] for text-only pastes and missing clipboardData", () => {
    expect(clipboardFiles(pasteEvent([], true))).toEqual([]);
    expect(clipboardFiles(new Event("paste") as ClipboardEvent)).toEqual([]);
  });
});

describe("acceptedUploadFiles", () => {
  it("mirrors the picker accept list and toasts each reject", () => {
    const toast = { error: vi.fn() };
    const ok = [
      asFile("a.png", "image/png"),
      asFile("b.mp4", "video/mp4"),
      asFile("c.pdf", "application/pdf"),
    ];
    const bad = asFile("evil.exe", "application/x-msdownload");
    expect(acceptedUploadFiles([...ok, bad], toast)).toEqual(ok);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][0]).toContain("evil.exe");
  });

  it("falls back to the extension when the OS gave no MIME type", () => {
    const toast = { error: vi.fn() };
    expect(acceptedUploadFiles([asFile("photo.HEIC", ""), asFile("run.bat", "")], toast)).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

describe("UploadDropZone", () => {
  it("routes a drop to onFiles and shows the active style only mid-drag", () => {
    const onFiles = vi.fn();
    const { container } = render(<UploadDropZone onFiles={onFiles}>slot</UploadDropZone>);
    const zone = container.firstElementChild as HTMLElement;
    const f = asFile("a.png", "image/png");

    fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"], files: [] } });
    expect(zone.className).toContain("border-accent");
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [f] } });
    expect(zone.className).not.toContain("border-accent");
    expect(onFiles).toHaveBeenCalledWith([f]);
  });

  it("clears the active style when the drag leaves for an outside node", () => {
    const { container } = render(<UploadDropZone onFiles={vi.fn()}>slot</UploadDropZone>);
    const zone = container.firstElementChild as HTMLElement;
    fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"], files: [] } });
    fireEvent.dragLeave(zone, { relatedTarget: document.body });
    expect(zone.className).not.toContain("border-accent");
  });

  it("claims a file paste only while hovered, and prevents its default", () => {
    const onFiles = vi.fn();
    const { container } = render(<UploadDropZone onFiles={onFiles}>slot</UploadDropZone>);
    const zone = container.firstElementChild as HTMLElement;
    const f = asFile("shot.png", "image/png");

    // Not hovered — paste passes through untouched.
    const miss = pasteEvent([f]);
    document.dispatchEvent(miss);
    expect(onFiles).not.toHaveBeenCalled();
    expect(miss.defaultPrevented).toBe(false);

    // Hovered — paste is claimed. (React synthesizes onMouseEnter from
    // native mouseover, so that's what we fire.)
    fireEvent.mouseOver(zone);
    expect(hoveredUploadZones.size).toBe(1);
    const hit = pasteEvent([f]);
    document.dispatchEvent(hit);
    expect(onFiles).toHaveBeenCalledWith([f]);
    expect(hit.defaultPrevented).toBe(true);

    // Un-hovered again — back to pass-through.
    fireEvent.mouseOut(zone);
    expect(hoveredUploadZones.size).toBe(0);
  });

  it("routes a paste to the hovered zone, not its siblings", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { container } = render(
      <>
        <UploadDropZone onFiles={first}>one</UploadDropZone>
        <UploadDropZone onFiles={second}>two</UploadDropZone>
      </>,
    );
    const zones = container.querySelectorAll(":scope > div");
    fireEvent.mouseOver(zones[1] as HTMLElement);
    document.dispatchEvent(pasteEvent([asFile("a.png", "image/png")]));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("ignores pastes while disabled, and text-only pastes entirely", () => {
    const onFiles = vi.fn();
    const { container } = render(
      <UploadDropZone onFiles={onFiles} disabled>
        slot
      </UploadDropZone>,
    );
    const zone = container.firstElementChild as HTMLElement;
    fireEvent.mouseOver(zone);
    document.dispatchEvent(pasteEvent([asFile("a.png", "image/png")]));
    expect(onFiles).not.toHaveBeenCalled();

    const textOnly = pasteEvent([], true);
    document.dispatchEvent(textOnly);
    expect(textOnly.defaultPrevented).toBe(false);
  });

  it("drops its registry entry on unmount even if the pointer never left", () => {
    const onFiles = vi.fn();
    const { container, unmount } = render(<UploadDropZone onFiles={onFiles}>slot</UploadDropZone>);
    fireEvent.mouseOver(container.firstElementChild as HTMLElement);
    expect(hoveredUploadZones.size).toBe(1);
    unmount();
    // A stale entry here would suppress the detail view's paste hint forever.
    expect(hoveredUploadZones.size).toBe(0);
    document.dispatchEvent(pasteEvent([asFile("a.png", "image/png")]));
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe("useStrayFileDropGuard", () => {
  function Guarded() {
    useStrayFileDropGuard();
    return null;
  }

  const dragEvent = (type: string, types: string[]): Event => {
    const e = new Event(type, { bubbles: true, cancelable: true }) as any;
    e.dataTransfer = { types };
    return e;
  };

  it("blocks stray FILE drops (which would navigate the SPA away) but not text drags", () => {
    const { unmount } = render(<Guarded />);
    const fileDrop = dragEvent("drop", ["Files"]);
    document.dispatchEvent(fileDrop);
    expect(fileDrop.defaultPrevented).toBe(true);

    const textDrop = dragEvent("drop", ["text/plain"]);
    document.dispatchEvent(textDrop);
    expect(textDrop.defaultPrevented).toBe(false);

    unmount();
    const afterUnmount = dragEvent("drop", ["Files"]);
    document.dispatchEvent(afterUnmount);
    expect(afterUnmount.defaultPrevented).toBe(false);
  });
});
