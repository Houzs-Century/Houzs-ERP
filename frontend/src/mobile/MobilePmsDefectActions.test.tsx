/* A rejected defect action must not disappear silently on the phone.
 *
 * Desktop toasts the failure (Projects.tsx saveAction -> toast?.error). Mobile's
 * catch was bare, holding only a comment about keeping the draft — so
 * someone could stamp a defect photo "Done", have the server refuse it, watch
 * the spinner stop, and walk away believing the defect was closed.
 *
 * This is REACHABLE, not theoretical: the canReview / canPurchase derivations
 * that decide whether the buttons render are re-derived on the client from
 * position_name / role_name regexes with no backend capability behind them, so
 * the button can appear for someone the server will refuse.
 *
 * FAILS ON THE PRE-FIX CODE: nothing was called, so the notify spy saw nothing.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { post, notify } = vi.hoisted(() => ({ post: vi.fn(), notify: vi.fn() }));
vi.mock("../api/client", () => ({ api: { post } }));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => notify }));

import { DefectActionsCtx, DefectFileActions } from "./MobilePmsDefectActions";

afterEach(cleanup);
beforeEach(() => {
  post.mockReset();
  notify.mockReset();
  notify.mockResolvedValue(undefined);
});

const reload = vi.fn();

function mount(canReview = true) {
  return render(
    <DefectActionsCtx.Provider value={{ actions: [], canReview, canPurchase: false, reload }}>
      <DefectFileActions att={{ id: 77 }} />
    </DefectActionsCtx.Provider>,
  );
}

/** Stamp "Done" and press Save — the exact sequence from the symptom. */
async function stampDone(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Done" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
}

describe("a defect action the server refuses", () => {
  test("SAYS SO — the operator is told, not left with a stopped spinner", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue(new Error("You don't have permission to do that."));
    mount();

    await stampDone(user);

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toMatchObject({ tone: "error" });
    // The server's own words reach the operator, not a generic shrug.
    expect(String(notify.mock.calls[0][0].body)).toContain("You don't have permission");
  });

  test("keeps the draft so the retry is one tap, not a re-type", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue(new Error("nope"));
    mount();

    await user.click(screen.getByRole("button", { name: "Done" }));
    await user.type(screen.getByPlaceholderText(/Add a remark/i), "cushion torn");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(notify).toHaveBeenCalled());
    // Draft survives the failure — the original comment's intent, preserved.
    expect((screen.getByPlaceholderText(/Add a remark/i) as HTMLTextAreaElement).value).toBe("cushion torn");
    expect(reload).not.toHaveBeenCalled();
  });

  test("a SUCCESSFUL save still clears the draft and reloads, and says nothing", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({});
    mount();

    await stampDone(user);

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(notify).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      "/api/projects/checklist/attachments/77/actions",
      { status: "done", remark: "" },
    );
  });
});
