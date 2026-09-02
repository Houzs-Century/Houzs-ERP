/* The plan-tile remove control — the phone half of the owner's 2026-08-24
 * complaint ("display floorplan i cant remove existing file using mobile").
 *
 * Three properties this pins, each of which the tile would look correct
 * without:
 *
 *   1. The x actually calls DELETE on the checklist-attachment endpoint the
 *      tasklist chip and the stock-transfer row already use, and reloads. A
 *      chip that renders and deletes nothing is indistinguishable from a
 *      working one until someone reopens the event.
 *   2. The click does NOT bubble. The whole tile is a role="button" that opens
 *      the lightbox, so a chip without stopPropagation removes the file AND
 *      opens the viewer — or, if the confirm is declined, only opens the viewer
 *      while the user believes they cancelled a delete.
 *   3. A refusal REACHES the operator. CLAUDE.md: "a failure that reaches
 *      nobody is worse than a crash".
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { del } = vi.hoisted(() => ({ del: vi.fn() }));
vi.mock("../api/client", () => ({ api: { del } }));

import { PlanFileChips } from "./MobilePmsPlanFileChips";

const notify = vi.fn();
const reload = vi.fn();
const setBusy = vi.fn();
const tileTap = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  del.mockReset();
  del.mockResolvedValue(undefined);
  notify.mockReset();
  notify.mockResolvedValue(undefined);
  reload.mockReset();
  setBusy.mockReset();
  tileTap.mockReset();
});

/** The chips as they are actually mounted: inside the tile that opens the
 *  lightbox on tap. */
function mount(confirm?: (o: { title: string }) => Promise<boolean>) {
  return render(
    <div role="button" tabIndex={0} onClick={tileTap}>
      <PlanFileChips
        files={[{ id: 77, file_name: "booth-v2.pdf" }]}
        busy={false}
        setBusy={setBusy}
        confirm={confirm}
        notify={notify}
        reload={reload}
      />
    </div>,
  );
}

describe("PlanFileChips", () => {
  test("renders nothing at all when the tile has no task attachments", () => {
    const { container } = render(
      <PlanFileChips files={[]} busy={false} setBusy={setBusy} notify={notify} reload={reload} />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("the x DELETEs the attachment and reloads, without opening the lightbox", async () => {
    const user = userEvent.setup();
    mount(() => Promise.resolve(true));

    expect(screen.getByText("booth-v2.pdf")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove booth-v2.pdf" }));

    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/projects/checklist/attachments/77"));
    expect(reload).toHaveBeenCalled();
    expect(tileTap).not.toHaveBeenCalled();
  });

  test("a declined confirm removes nothing — and still does not open the lightbox", async () => {
    const user = userEvent.setup();
    mount(() => Promise.resolve(false));

    await user.click(screen.getByRole("button", { name: "Remove booth-v2.pdf" }));

    await waitFor(() => expect(tileTap).not.toHaveBeenCalled());
    expect(del).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("a server refusal reaches the operator instead of stopping silently", async () => {
    const user = userEvent.setup();
    del.mockRejectedValue(new Error("Forbidden"));
    mount(() => Promise.resolve(true));

    await user.click(screen.getByRole("button", { name: "Remove booth-v2.pdf" }));

    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0][0]).toMatchObject({ title: "Remove failed", tone: "error" });
    expect(reload).not.toHaveBeenCalled();
    // Busy must be released, or the whole card stays disabled after one failure.
    expect(setBusy).toHaveBeenLastCalledWith(false);
  });
});
