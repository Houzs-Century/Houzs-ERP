// A PMS remark that did not save must not look exactly like one that did.
//
// WHY THIS FILE EXISTS. Both remark boxes on the phone save on BLUR and
// swallowed the failure whole:
//
//   } catch {
//     /* keep the text so the user can retry on next blur */
//   }
//
// The comment names a retry that will not happen. Blur has already occurred by
// then — the person has tapped away and moved on — and the textarea still shows
// exactly what they typed, so the screen is indistinguishable from a successful
// save. Leaving the page loses it.
//
// AttachRemark is the per-photo caption (PATCH /checklist/attachments/:id) and
// ItemRemark is the item-level note (PATCH /checklist/:id) — the sales PIC's
// Setup Image / Defect List / Event Complete notes.
//
// These tests assert the CONTRACT: after a refused blur-save the box says it did
// not save. They fail on the pre-fix tree.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, apiPatch, apiDel } = vi.hoisted(() => ({
  apiGet: vi.fn(), apiPost: vi.fn(), apiPatch: vi.fn(), apiDel: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: { get: apiGet, post: apiPost, patch: apiPatch, del: apiDel } }));

import { AttachRemark, ItemRemark } from "./MobilePMS";

afterEach(cleanup);
beforeEach(() => { apiGet.mockReset(); apiPost.mockReset(); apiPatch.mockReset(); apiDel.mockReset(); });

const att = { id: 7, item_id: 3, r2_key: "k", file_name: "setup.jpg", mime_type: "image/jpeg", caption: "" };
const item = { id: 3, seq: 1, title: "Setup Image", role_label: null, due_date: null, status: "pending", section_id: null, notes: "" };

describe("a PMS remark that the server refused says so", () => {
  it("the photo caption does not look saved when the PATCH failed", async () => {
    apiPatch.mockRejectedValue(new Error("403"));
    render(<AttachRemark att={att} canEdit />);

    const box = screen.getByPlaceholderText(/add remark/i);
    await userEvent.type(box, "Backdrop went up late");
    await userEvent.tab(); // blur — this is the save

    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/not saved/i)).toBeTruthy();
  });

  it("the item remark does not look saved when the PATCH failed", async () => {
    apiPatch.mockRejectedValue(new Error("403"));
    render(<ItemRemark it={item} canEdit />);

    const box = screen.getByPlaceholderText(/add remark/i);
    await userEvent.type(box, "Two chairs missing");
    await userEvent.tab();

    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/not saved/i)).toBeTruthy();
  });

  it("says nothing when the save SUCCEEDS", async () => {
    apiPatch.mockResolvedValue({});
    render(<AttachRemark att={att} canEdit />);

    await userEvent.type(screen.getByPlaceholderText(/add remark/i), "All good");
    await userEvent.tab();

    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/not saved/i)).toBeNull();
  });
});
