import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Department } from "../../types";
import { EMPTY_AUDIENCE } from "./AudiencePicker";
import { ComposerModal, buildPostBody, draftStorageKey, readDraft, type ComposerDraft } from "./ComposerModal";

/* ────────────────────────────────────────────────────────────────────────────
   ComposerModal — the wide composer (design handoff 2026-09-04, screen 4).
   Pins the request body it builds (targets, requireAck default, schedule,
   SOP never expires), the draft round-trip, and the rendered form's category
   → require-acknowledgement default and its guard against posting to nobody.
   ──────────────────────────────────────────────────────────────────────────── */

const { apiPost, toastError, toastSuccess } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("../../api/client", () => ({ api: { post: apiPost } }));
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ error: toastError, success: toastSuccess }),
}));
vi.mock("../../lib/announcementAttachmentUpload", () => ({
  uploadAnnouncementAttachment: vi.fn(),
}));
// The contenteditable editor needs execCommand; a plain textarea stands in.
vi.mock("../../components/AnnouncementRichEditor", () => ({
  AnnouncementRichEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Message" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock("../../vendor/scm/components/DateTimeField", () => ({
  DateTimeField: ({ value, onChange, "aria-label": label }: { value: string; onChange: (v: string) => void; "aria-label"?: string }) => (
    <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const base: Omit<ComposerDraft, "savedAt"> = {
  category: "WARNING",
  requireAck: true,
  title: "Shipping marks",
  html: "<p>Check <b>twice</b></p>",
  attachments: [],
  scheduledAt: "",
  expiresAt: "",
  audience: { ...EMPTY_AUDIENCE, deptIds: [2], userIds: [7], companyId: 1 },
  photoLayout: "",
  videoLayout: "1x1",
};

describe("buildPostBody", () => {
  it("maps departments / people / company onto the backend's targets and carries the flag + rich body", () => {
    const r = buildPostBody(base, false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toMatchObject({
      title: "Shipping marks",
      body: "Check twice",
      bodyHtml: "<p>Check <b>twice</b></p>",
      category: "WARNING",
      requireAck: true,
      targetDeptIds: [2],
      targetUserIds: [7],
      targetCompanyIds: [1],
    });
    expect(r.body.expiresAt).toBeUndefined();
    expect(r.body.scheduledAt).toBeUndefined();
  });

  it("divisions and unticked people ride as their own server-side targets (mig 20260906T0639)", () => {
    const users = [
      { id: 7, name: "A", email: "a@x", status: "active", department_id: 2, division: "Inbound" },
      { id: 8, name: "B", email: "b@x", status: "active", department_id: 2, division: "Outbound" },
      { id: 9, name: "C", email: "c@x", status: "active", department_id: 3 },
    ] as unknown as import("../../types").TeamMember[];
    // Division only + an explicit person + one unticked inside the division.
    const r = buildPostBody(
      {
        ...base,
        audience: {
          ...EMPTY_AUDIENCE,
          divisions: [{ deptId: 2, division: "Inbound" }],
          userIds: [9],
          excludedUserIds: [7, 8], // 8 is Outbound: not reached, so dropped
        },
      },
      false,
      users,
    );
    expect(r.ok && r.body.targetDeptIds).toBeUndefined();
    expect(r.ok && r.body.targetDivisions).toEqual([{ deptId: 2, division: "Inbound" }]);
    expect(r.ok && r.body.targetUserIds).toEqual([9]);
    expect(r.ok && r.body.excludedUserIds).toEqual([7]);
    // A division the selected department already implies is not repeated.
    const both = buildPostBody(
      { ...base, audience: { ...EMPTY_AUDIENCE, deptIds: [2], divisions: [{ deptId: 2, division: "Inbound" }] } },
      false,
      users,
    );
    expect(both.ok && both.body.targetDeptIds).toEqual([2]);
    expect(both.ok && both.body.targetDivisions).toBeUndefined();
    // A division alone is a valid audience.
    const only = buildPostBody(
      { ...base, audience: { ...EMPTY_AUDIENCE, divisions: [{ deptId: 2, division: "Inbound" }] } },
      false,
    );
    expect(only.ok).toBe(true);
    // Without the roster the exclusion list is passed through as given.
    const noRoster = buildPostBody({ ...base, audience: { ...base.audience, excludedUserIds: [7] } }, false);
    expect(noRoster.ok && noRoster.body.targetDeptIds).toEqual([2]);
    expect(noRoster.ok && noRoster.body.excludedUserIds).toEqual([7]);
  });

  it("All staff sends no target; nobody picked is refused; a Sales Director never sends a company", () => {
    const all = buildPostBody({ ...base, audience: { ...EMPTY_AUDIENCE, allStaff: true } }, false);
    expect(all.ok && all.body.targetDeptIds === undefined && all.body.targetUserIds === undefined).toBe(true);
    const none = buildPostBody({ ...base, audience: EMPTY_AUDIENCE }, false);
    expect(none.ok).toBe(false);
    const sd = buildPostBody(base, true);
    expect(sd.ok && sd.body.targetCompanyIds === undefined).toBe(true);
    expect(buildPostBody({ ...base, title: "  " }, false).ok).toBe(false);
  });

  it("schedule and hide-after become ISO instants; an SOP never carries an expiry", () => {
    const r = buildPostBody({ ...base, scheduledAt: "2026-09-06T08:00", expiresAt: "2026-09-30T18:00" }, false);
    expect(r.ok && typeof r.body.scheduledAt === "string" && (r.body.scheduledAt as string).endsWith("Z")).toBe(true);
    expect(r.ok && typeof r.body.expiresAt === "string").toBe(true);
    const sop = buildPostBody({ ...base, category: "SOP", expiresAt: "2026-09-30T18:00" }, false);
    expect(sop.ok && sop.body.expiresAt === undefined).toBe(true);
    expect(buildPostBody({ ...base, scheduledAt: "not a date" }, false).ok).toBe(false);
  });

  it("media layout hints ride only with the media actually attached", () => {
    const r = buildPostBody(
      { ...base, attachments: [{ r2Key: "k", name: "a.jpg", mime: "image/jpeg" }], photoLayout: "2" },
      false,
    );
    expect(r.ok && r.body.mediaLayout).toEqual({ photo: "2" });
    const none = buildPostBody({ ...base, photoLayout: "2" }, false);
    expect(none.ok && none.body.mediaLayout).toBeUndefined();
  });
});

describe("draft round-trip", () => {
  const values = new Map<string, string>();
  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads back what was saved and tolerates junk", () => {
    const key = draftStorageKey(5);
    expect(key).toBe("announcements:draft:u5");
    values.set(key, JSON.stringify({ ...base, savedAt: 123 }));
    expect(readDraft(key)).toMatchObject({ savedAt: 123, title: "Shipping marks", audience: { deptIds: [2] } });
    values.set(key, "{not json");
    expect(readDraft(key)).toBeNull();
    values.set(key, JSON.stringify({ category: "NOPE" }));
    expect(readDraft(key)).toBeNull();
  });
});

describe("ComposerModal (rendered)", () => {
  const values = new Map<string, string>();
  beforeEach(() => {
    values.clear();
    apiPost.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function mount() {
    const onPosted = vi.fn();
    const onClose = vi.fn();
    render(
      <ComposerModal
        users={[]}
        departments={[{ id: 2, name: "Warehouse" } as Department]}
        companies={[]}
        salesDirOnly={false}
        currentUserId={9}
        onClose={onClose}
        onPosted={onPosted}
      />,
    );
    return { onPosted, onClose };
  }

  it("Warning defaults to require-acknowledgement; Notice switches it off; SOP hides the expiry", () => {
    mount();
    const box = screen.getByLabelText("Require acknowledgement") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Notice" }));
    expect(box.checked).toBe(false);
    expect(screen.getByLabelText("Hide after")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "SOP" }));
    expect(box.checked).toBe(true);
    expect(screen.queryByLabelText("Hide after")).toBeNull();
  });

  it("refuses to post to nobody, posts once a department is picked, and clears the draft", async () => {
    apiPost.mockResolvedValue({ success: true });
    const { onPosted } = mount();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Post announcement" }));
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Pick at least one department"));
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Warehouse/ }));
    fireEvent.click(screen.getByRole("button", { name: "Post announcement" }));
    await waitFor(() => expect(onPosted).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith(
      "/api/announcements",
      expect.objectContaining({ title: "Hello", category: "WARNING", requireAck: true, targetDeptIds: [2] }),
    );
    expect(values.has("announcements:draft:u9")).toBe(false);
  });

  it("a schedule turns the primary into Schedule post and the audience summary is live", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "2026-09-06T08:00" } });
    expect(screen.getByRole("button", { name: "Schedule post" })).toBeTruthy();
    expect(screen.getByText("No recipients yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All staff" }));
    expect(screen.getByText("All staff", { selector: "span.text-ink" })).toBeTruthy();
  });
});
