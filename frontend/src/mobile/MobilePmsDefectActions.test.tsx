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

async function stampDone(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Done Clean" }));
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
    expect(String(notify.mock.calls[0][0].body)).toContain("You don't have permission");
  });

  test("keeps the draft so the retry is one tap, not a re-type", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue(new Error("nope"));
    mount();

    await user.click(screen.getByRole("button", { name: "Done Clean" }));
    await user.type(screen.getByPlaceholderText(/Add a remark/i), "cushion torn");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(notify).toHaveBeenCalled());
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
      { status: "done_clean", remark: "" },
    );
  });
});

// Owner 2026-09-28: the defect Model + Reason must be readable by EVERY viewer
// on mobile — the bug was that the caption rendered only in the hidden tasklist,
// so nobody on the card view (Shukor included) could see it. These pin that the
// remark shows regardless of review/purchase rights.
describe("the photo's Model + Reason are shown to every viewer", () => {
  const withCaption = (caption: string, canReview = false) =>
    render(
      <DefectActionsCtx.Provider value={{ actions: [], canReview, canPurchase: false, reload }}>
        <DefectFileActions att={{ id: 5, caption }} />
      </DefectActionsCtx.Provider>,
    );

  test("a structured caption renders both labelled lines even with NO review rights", () => {
    withCaption("Model: AKEMI Elevation\nReason: Dented corner", false);
    expect(screen.getByText("Model:")).toBeDefined();
    expect(screen.getByText(/AKEMI Elevation/)).toBeDefined();
    expect(screen.getByText("Reason:")).toBeDefined();
    expect(screen.getByText(/Dented corner/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Done Clean" })).toBeNull();
  });

  test("a legacy free-text caption still reads out (as the reason)", () => {
    withCaption("Elevation", false);
    expect(screen.getByText(/Elevation/)).toBeDefined();
  });
});
