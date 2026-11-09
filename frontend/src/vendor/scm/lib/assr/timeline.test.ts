import { describe, expect, test } from "vitest";
import { buildCaseTimeline, prettifyStorageKeys, type TimelineActivity, type TimelineOptions } from "./timeline";

let nextId = 1;
const activity = (action: string, created_at: string, extra: Partial<TimelineActivity> = {}): TimelineActivity => ({
  id: nextId++,
  created_at,
  action,
  category: null,
  source: null,
  source_channel: null,
  from_value: null,
  to_value: null,
  note: null,
  user_name: "Farra",
  ...extra,
});

const keyUpdates: TimelineOptions = { filter: "all", shouldShowDetails: false, salesAgent: null, userNames: new Map() };

describe("buildCaseTimeline", () => {
  test("lists rows oldest first even when the API sends newest first", () => {
    const newestFirst = [
      activity("stage_change", "2026-10-22T03:20:00Z", { to_value: "pending_supplier_pickup" }),
      activity("created", "2026-10-20T02:15:00Z", { note: "Backrest bracket obstructing the zipper" }),
    ];

    const { rows } = buildCaseTimeline(newestFirst, keyUpdates);

    expect(rows.map((row) => row.status?.label)).toEqual(["Case Created", "Pickup / Return"]);
    expect(rows[0].remarks).toBe("Backrest bracket obstructing the zipper");
  });

  test("hides system detail rows by default and counts them", () => {
    const entries = [
      activity("created", "2026-10-20T02:15:00Z"),
      activity("field_change", "2026-10-20T02:16:00Z", { note: "Phone changed" }),
      activity("item_remark", "2026-10-20T02:17:00Z", { note: "Remark edited" }),
      activity("note", "2026-10-20T02:18:00Z", { note: "Called customer", category: "service" }),
    ];

    const timeline = buildCaseTimeline(entries, keyUpdates);

    expect(timeline.rows.map((row) => row.remarks)).toEqual(["", "Called customer"]);
    expect(timeline.hiddenCount).toBe(2);
  });

  test("shows every row when details are switched on", () => {
    const entries = [activity("created", "2026-10-20T02:15:00Z"), activity("field_change", "2026-10-20T02:16:00Z", { note: "Phone changed" })];

    const timeline = buildCaseTimeline(entries, { ...keyUpdates, shouldShowDetails: true });

    expect(timeline.rows).toHaveLength(2);
    expect(timeline.rows[1]).toMatchObject({ status: null, remarks: "Phone changed" });
    expect(timeline.hiddenCount).toBe(0);
  });

  test("merges back-to-back uploads by one person on one day into a single row", () => {
    const entries = [
      activity("attachment_added", "2026-10-22T03:00:00Z", { to_value: "a.jpg" }),
      activity("field_change", "2026-10-22T03:01:00Z"),
      activity("attachment_added", "2026-10-22T03:02:00Z", { to_value: "b.JPG" }),
      activity("attachment_added", "2026-10-22T03:03:00Z", { to_value: "c.mp4" }),
    ];

    const { rows } = buildCaseTimeline(entries, keyUpdates);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: entries[0].id,
      at: "2026-10-22T03:00:00Z",
      remarks: "2 photos, 1 video uploaded",
      status: { label: "Files Uploaded" },
      isArchivable: false,
    });
  });

  test("starts a new upload row when the uploader changes", () => {
    const entries = [
      activity("attachment_added", "2026-10-22T03:00:00Z", { to_value: "a.jpg" }),
      activity("customer_upload", "2026-10-22T03:05:00Z", { to_value: "42", note: "b.jpg", source: "customer", user_name: null }),
    ];

    const { rows } = buildCaseTimeline(entries, keyUpdates);

    expect(rows.map((row) => [row.by, row.remarks])).toEqual([
      ["Farra", "1 photo uploaded"],
      ["Customer", "1 photo uploaded"],
    ]);
  });

  test("reads the file name from the note when the portal stores the attachment id", () => {
    const entries = [
      activity("supplier_upload", "2026-10-22T03:00:00Z", { to_value: "7", note: "crack.webp", source_channel: "supplier_portal", user_name: null }),
      activity("supplier_upload", "2026-10-22T03:01:00Z", { to_value: "8", note: "crack.mov", source_channel: "supplier_portal", user_name: null }),
    ];

    const { rows } = buildCaseTimeline(entries, keyUpdates);

    expect(rows).toEqual([expect.objectContaining({ by: "Supplier", remarks: "1 photo, 1 video uploaded" })]);
  });

  test("keeps staff documents of different types in separate rows", () => {
    const entries = [
      activity("attachment_added", "2026-10-25T02:00:00Z", { to_value: "a.jpg", note: "Added evidence attachment (a.jpg)" }),
      activity("attachment_added", "2026-10-25T02:01:00Z", { to_value: "pod.pdf", note: "Added delivery_pod attachment (pod.pdf)" }),
    ];

    const { rows } = buildCaseTimeline(entries, keyUpdates);

    expect(rows.map((row) => row.remarks)).toEqual(["1 photo uploaded (evidence)", "1 file uploaded (delivery pod)"]);
  });

  test("folds Google Form photo imports into the upload row", () => {
    const entries = [
      activity("note", "2026-10-22T03:00:00Z", { note: "Photo migrated from Google Form history: sofa.jpg [gdrive:1]" }),
      activity("note", "2026-10-22T03:00:01Z", { note: "Photo migrated from Google Form history [gdrive:2]" }),
    ];

    const { rows } = buildCaseTimeline(entries, keyUpdates);

    expect(rows).toEqual([expect.objectContaining({ remarks: "2 photos uploaded", status: { label: "Photos Uploaded", tone: "blue" } })]);
  });

  test("filters by audience before hiding details", () => {
    const entries = [
      activity("note", "2026-10-20T02:15:00Z", { category: "customer", note: "Customer note" }),
      activity("note", "2026-10-20T02:16:00Z", { category: "service", note: "Internal note" }),
      activity("field_change", "2026-10-20T02:17:00Z", { category: "customer" }),
    ];

    const timeline = buildCaseTimeline(entries, { ...keyUpdates, filter: "customer" });

    expect(timeline.rows.map((row) => row.remarks)).toEqual(["Customer note"]);
    expect(timeline.hiddenCount).toBe(1);
  });

  test("names comment rows by audience and lets them be archived", () => {
    const { rows } = buildCaseTimeline([activity("customer_comment", "2026-10-20T02:15:00Z", { note: "When?", source: "customer" })], keyUpdates);

    expect(rows[0]).toMatchObject({ by: "Customer", status: { label: "Customer Comment", tone: "grey" }, isArchivable: true });
  });
});

describe("prettifyStorageKeys", () => {
  test("swaps storage keys for the kind of file", () => {
    expect(prettifyStorageKeys("Added photo attachment (0f8e2c1a-1111-2222-3333-444455556666.mov)")).toBe("Added photo attachment (video)");
  });
});
