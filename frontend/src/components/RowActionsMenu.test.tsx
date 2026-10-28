import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { RowActionsMenu } from "./RowActionsMenu";

/* ────────────────────────────────────────────────────────────────────────────
   RowActionsMenu side-flip.

   Layout's <main> carries `overflow-x-hidden`, so the default right-aligned
   panel is CUT — not merely overflowed — when the trigger sits closer to the
   content's left edge than the panel is wide. Project Maintenance's picker rows
   are exactly that case (owner 2026-09-04: "once i click three dot it will open
   on left side and cant see fully").

   jsdom reports every rect as zeroes, so both the trigger and the clipping
   ancestor are stubbed per case. What is pinned is the DECISION, which is the
   part that was wrong — not pixel layout, which jsdom cannot answer anyway.
   ──────────────────────────────────────────────────────────────────────────── */

const ITEMS = [{ icon: Trash2, label: "Remove", onClick: () => {}, danger: true }];

/** Render inside a clipping ancestor whose left edge is `clipLeft`, with the
 *  trigger's right edge at `triggerRight`. */
function renderAt(clipLeft: number, triggerRight: number) {
  render(
    <div style={{ overflowX: "hidden" }} data-testid="clipper">
      <RowActionsMenu items={ITEMS} />
    </div>,
  );
  const clipper = screen.getByTestId("clipper");
  vi.spyOn(clipper, "getBoundingClientRect").mockReturnValue({
    left: clipLeft, right: 1200, top: 0, bottom: 40, width: 1200 - clipLeft, height: 40, x: clipLeft, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  // getComputedStyle in jsdom does report the inline overflowX, so the walk
  // finds this node; only the rect needs stubbing. The wrapper is the
  // component's own `relative` div — grab it by structure, NOT by a loose
  // selector: an unstubbed rect reads (0,0), which flips, so a mis-targeted
  // stub makes the flip case pass for the wrong reason.
  const wrap = clipper.firstElementChild as HTMLElement;
  vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue({
    left: triggerRight - 28, right: triggerRight, top: 0, bottom: 28, width: 28, height: 28,
    x: triggerRight - 28, y: 0, toJSON: () => ({}),
  } as DOMRect);
  return screen.getByRole("button", { name: /row actions/i });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RowActionsMenu", () => {
  it("flips to open RIGHTWARD when the clipping ancestor would cut the panel", async () => {
    // Content starts at 270 (the sidebar ends there); trigger sits at 354, so
    // only 84px of room on the left and the panel is 176px wide.
    const trigger = renderAt(270, 354);
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(menu.getAttribute("data-flipped")).toBe("right"));
    expect(menu.className).toContain("left-0");
    expect(menu.className).not.toContain("right-0");
  });

  it("keeps the default right-aligned panel when there IS room", async () => {
    // Same clipper, but the trigger is far from the left edge.
    const trigger = renderAt(270, 900);
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(menu.className).toContain("right-0"));
    expect(menu.getAttribute("data-flipped")).toBeNull();
  });

  it("still fires the item's onClick and closes", async () => {
    const onClick = vi.fn();
    render(<RowActionsMenu items={[{ icon: Trash2, label: "Remove", onClick }]} />);
    fireEvent.click(screen.getByRole("button", { name: /row actions/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /remove/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
