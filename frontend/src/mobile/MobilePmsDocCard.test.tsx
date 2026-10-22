/* The B2 big-preview document card (owner 2026-09-30) — structural pins.
 *
 * Three rules of the respec that must not drift:
 *   1. a document's files render as FULL-WIDTH previews with the file name
 *      chipped onto the media (no more thumbnail-grid tiles);
 *   2. Stock Out / Stock In transfer records are the one EXEMPT doc type and
 *      keep the compact row (name + View button);
 *   3. a defect file carries the Done / Replace review loop under its preview.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { fetchBlobUrl, post, patch, del, putBinary, notify } = vi.hoisted(() => ({
  fetchBlobUrl: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  putBinary: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: { fetchBlobUrl, post, patch, del, putBinary } }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 9, permissions: [] } }) }));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => notify }));
// The lightbox drags in portal/video machinery this structural test never
// opens; a stub keeps the render about the card itself.
vi.mock("../components/MediaLightbox", () => ({ MediaLightbox: () => null }));

import {
  SalesDocsCard,
  type ChecklistItem, type TaskAttachment, type DocTile,
  type NotifyFn, type PromptFn, type ConfirmFn,
} from "./MobilePmsDocCard";
import { DefectActionsCtx } from "./MobilePmsDefectActions";

afterEach(cleanup);
beforeEach(() => {
  // Pending forever → previews keep their placeholder; no blob URLs needed.
  fetchBlobUrl.mockReturnValue(new Promise(() => {}));
});

const item = (id: number, title: string): ChecklistItem => ({
  id, seq: id, title, role_label: null, due_date: null, status: "pending", section_id: null,
});
const att = (id: number, itemId: number, name: string, caption?: string): TaskAttachment => ({
  id, item_id: itemId, r2_key: `k/${id}.jpg`, file_name: name, mime_type: "image/jpeg", caption: caption ?? null,
});

const noop = vi.fn();
// Typed stubs, not `as never` casts — the card's dialog props keep their real
// signatures so a prop change here fails the test instead of sliding past it.
const notifyFn: NotifyFn = async () => {};
const promptFn: PromptFn = async () => null;
const confirmFn: ConfirmFn = async () => false;
const dialogs = {
  canTick: true,
  busy: false,
  setBusy: noop,
  notify: notifyFn,
  prompt: promptFn,
  confirm: confirmFn,
  reload: noop,
};

const TILES: DocTile[] = [
  { label: "Permit", match: /permit/i },
  { label: "Stock In Transfer Record", match: /^stock in transfer/i },
  { label: "Defect Item Setup", match: /^defect (list|item) setup/i },
];

function mount() {
  return render(
    <DefectActionsCtx.Provider value={{ actions: [], canReview: true, canPurchase: false, reload: noop }}>
      <SalesDocsCard
        tiles={TILES}
        checklist={[item(1, "Permit"), item(2, "Stock In Transfer Record"), item(3, "Defect Item Setup")]}
        attachments={[
          att(11, 1, "permit-2026.jpg", "valid until Sept"),
          att(12, 2, "stock-in.jpg"),
          att(13, 3, "defect.jpg", "Reason: torn cushion"),
        ]}
        {...dialogs}
      />
    </DefectActionsCtx.Provider>,
  );
}

describe("the B2 document card", () => {
  test("a document file is a full-width preview with its name chipped on, plus its remark", () => {
    mount();
    // The chip carries the file name; big previews have no per-file View button.
    expect(screen.getByText("permit-2026.jpg")).toBeTruthy();
    // The non-defect caption renders as the Remark strip.
    expect(screen.getByText(/valid until Sept/)).toBeTruthy();
  });

  test("Stock In keeps the COMPACT row — name + View, never a big preview", () => {
    mount();
    // Exactly one View button on the card: the stock record's.
    const views = screen.getAllByRole("button", { name: "View" });
    expect(views.length).toBe(1);
    expect(screen.getByText("stock-in.jpg")).toBeTruthy();
  });

  test("a defect file carries Done / Replace under its preview", () => {
    mount();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    // Its caption reaches every viewer via the defect remark strip.
    expect(screen.getByText(/torn cushion/)).toBeTruthy();
  });

  test("an editable document offers the upload path", () => {
    mount();
    // Permit + Defect get "+ Add more"; the stock row keeps its own controls.
    expect(screen.getAllByRole("button", { name: "+ Add more" }).length).toBeGreaterThanOrEqual(2);
  });
});
