import { describe, expect, test } from "vitest";
import {
  INBOX_FILTERS,
  MANAGE_ONLY_FILTERS,
  ackRateBarCls,
  approvalOf,
  audienceLabel,
  bucketInbox,
  companyScopeLabel,
  docNo,
  filterManageRows,
  isApproved,
  isArchived,
  isPendingForMe,
  manageStats,
  manageStatus,
  requiresAck,
  type Announcement,
} from "./announcementModel";

/* ────────────────────────────────────────────────────────────────────────────
   announcementModel — the pure rules the redesigned Announcements page runs on
   (design handoff 2026-09-04). These pin the contracts the screens rely on:
   which categories block, that SOP never archives, the ack-rate thresholds,
   and how the inbox splits into pinned / recent / SOP Library.
   ──────────────────────────────────────────────────────────────────────────── */

const NOW = Date.parse("2026-09-05T09:00:00Z");

function ann(over: Partial<Announcement> & { id: string }): Announcement {
  return {
    title: over.id,
    body: "",
    isActive: true,
    expiresAt: null,
    createdAt: "2026-09-04T09:00:00Z",
    createdBy: 1,
    remindedAt: null,
    updatedAt: null,
    targetType: "ALL_USERS",
    category: "GENERAL",
    ...over,
  };
}

describe("requiresAck", () => {
  test("WARNING and SOP block by category; GENERAL and LEARNING never do", () => {
    expect(requiresAck({ category: "WARNING" })).toBe(true);
    expect(requiresAck({ category: "SOP" })).toBe(true);
    expect(requiresAck({ category: "GENERAL" })).toBe(false);
    expect(requiresAck({ category: "LEARNING" })).toBe(false);
    expect(requiresAck({})).toBe(false);
  });

  test("the per-notice flag wins over the category default once the backend sends it", () => {
    expect(requiresAck({ category: "WARNING", requireAck: false })).toBe(false);
    expect(requiresAck({ category: "GENERAL", requireAck: true })).toBe(true);
    expect(requiresAck({ category: "SOP", requireAck: null })).toBe(true);
  });
});

describe("isArchived", () => {
  test("hidden outranks everything; expiry archives every category except SOP", () => {
    const past = "2026-09-01T00:00:00Z";
    expect(isArchived(ann({ id: "a", isActive: false }), NOW)).toBe(true);
    expect(isArchived(ann({ id: "b", expiresAt: past }), NOW)).toBe(true);
    expect(isArchived(ann({ id: "c", expiresAt: past, category: "SOP" }), NOW)).toBe(false);
    expect(isArchived(ann({ id: "d", expiresAt: past, category: "SOP", isActive: false }), NOW)).toBe(true);
    expect(isArchived(ann({ id: "e", expiresAt: "2026-12-01T00:00:00Z" }), NOW)).toBe(false);
  });
});

describe("ack-rate thresholds", () => {
  test(">= 95 synced, >= 70 primary, otherwise warning", () => {
    expect(ackRateBarCls(100)).toBe("bg-synced");
    expect(ackRateBarCls(95)).toBe("bg-synced");
    expect(ackRateBarCls(94)).toBe("bg-primary");
    expect(ackRateBarCls(70)).toBe("bg-primary");
    expect(ackRateBarCls(69)).toBe("bg-warning-text");
  });

  test("manage status: awaiting > archived > escalated (< 70%) > complete", () => {
    const live = ann({ id: "x", category: "WARNING" });
    expect(manageStatus(live, { pendingForMe: true, pct: 100 }, NOW)).toBe("awaiting");
    expect(
      manageStatus(ann({ id: "y", isActive: false }), { pendingForMe: false, pct: 10 }, NOW),
    ).toBe("archived");
    expect(manageStatus(live, { pendingForMe: false, pct: 69 }, NOW)).toBe("escalated");
    expect(manageStatus(live, { pendingForMe: false, pct: 70 }, NOW)).toBe("complete");
    expect(manageStatus(live, { pendingForMe: false, pct: null }, NOW)).toBe("complete");
  });
});

describe("bucketInbox", () => {
  const warn = ann({ id: "warn", category: "WARNING", createdBy: 7 });
  const sopPending = ann({
    id: "sop-new",
    category: "SOP",
    targetType: "DEPARTMENT_IDS",
    targetDeptIds: [3],
    targetDeptNames: ["Operation"],
  });
  const sopOld = ann({
    id: "sop-old",
    category: "SOP",
    expiresAt: "2026-01-01T00:00:00Z",
    targetType: "DEPARTMENT_IDS",
    targetDeptIds: [2],
    targetDeptNames: ["Sales"],
  });
  const notice = ann({ id: "notice", category: "GENERAL", createdBy: 7 });
  const learning = ann({ id: "learn", category: "LEARNING", createdBy: 9 });
  const expiredNotice = ann({ id: "gone", category: "GENERAL", expiresAt: "2026-01-01T00:00:00Z" });
  const notForMe = ann({ id: "theirs", category: "WARNING", targetType: "USER_IDS", targetUserIds: [99] });
  const scheduled = ann({ id: "later", category: "WARNING", scheduledAt: "2026-09-06T08:00:00Z" });
  const items = [warn, sopPending, sopOld, notice, learning, expiredNotice, notForMe, scheduled];
  const addressed = new Set(["warn", "sop-new", "sop-old", "notice", "learn", "gone", "later"]);

  test("pinned = mandatory + addressed to me + unacked; SOP always lives in the library; expired notices drop out", () => {
    const b = bucketInbox({
      items,
      addressedIds: addressed,
      ackedIds: new Set(["sop-old"]),
      currentUserId: 7,
      filter: "all",
      search: "",
      now: NOW,
    });
    expect(b.pending.map((a) => a.id)).toEqual(["warn", "sop-new"]);
    expect(b.recent.map((a) => a.id)).toEqual(["notice", "learn", "theirs"]);
    expect(b.sopGroups).toEqual([{ dept: "Sales", items: [sopOld] }]);
    expect(b.sopCount).toBe(1);
  });

  test("acknowledging moves a pinned notice: a WARNING joins Recent, an SOP joins its department in the library", () => {
    const b = bucketInbox({
      items,
      addressedIds: addressed,
      ackedIds: new Set(["warn", "sop-new", "sop-old"]),
      currentUserId: 7,
      filter: "all",
      search: "",
      now: NOW,
    });
    expect(b.pending).toEqual([]);
    expect(b.recent[0].id).toBe("warn");
    expect(b.sopGroups.map((g) => g.dept)).toEqual(["Operation", "Sales"]);
  });

  test("pending is mandatory + addressed + unacked; a notice outside my audience is never pending", () => {
    expect(isPendingForMe(warn, addressed, new Set(), NOW)).toBe(true);
    expect(isPendingForMe(warn, addressed, new Set(["warn"]), NOW)).toBe(false);
    expect(isPendingForMe(notForMe, addressed, new Set(), NOW)).toBe(false);
    expect(isPendingForMe(notice, addressed, new Set(), NOW)).toBe(false);
    expect(isPendingForMe(scheduled, addressed, new Set(), NOW)).toBe(false);
  });

  test("filter pills touch the Recent group only; Needs you empties it; Posted by me keys on createdBy", () => {
    const base = { items, addressedIds: addressed, ackedIds: new Set(["sop-old"]), currentUserId: 7, search: "", now: NOW };
    expect(bucketInbox({ ...base, filter: "pending" }).recent).toEqual([]);
    expect(bucketInbox({ ...base, filter: "pending" }).pending.length).toBe(2);
    expect(bucketInbox({ ...base, filter: "LEARNING" }).recent.map((a) => a.id)).toEqual(["learn"]);
    expect(bucketInbox({ ...base, filter: "mine" }).recent.map((a) => a.id)).toEqual(["notice"]);
    expect(bucketInbox({ ...base, filter: "SOP" }).sopGroups.length).toBe(1);
  });

  test("search matches title, body and author across every group", () => {
    const b = bucketInbox({
      items: [
        ann({ id: "t", title: "Shipping marks", category: "WARNING" }),
        ann({ id: "b", body: "the shipping schedule" }),
        ann({ id: "a", createdByName: "Shipping Lee", category: "SOP" }),
        ann({ id: "n", title: "Holiday" }),
      ],
      addressedIds: new Set(["t", "b", "a", "n"]),
      ackedIds: new Set(["a"]),
      currentUserId: 1,
      filter: "all",
      search: "SHIP",
      now: NOW,
    });
    expect(b.pending.map((a) => a.id)).toEqual(["t"]);
    expect(b.recent.map((a) => a.id)).toEqual(["b"]);
    expect(b.sopCount).toBe(1);
  });
});

describe("approval workflow (mig 20260906T1509)", () => {
  test("absent = approved; the number is the ref no once minted, the id before", () => {
    const legacy = ann({ id: "ann-old" });
    expect(approvalOf(legacy)).toBe("APPROVED");
    expect(isApproved(legacy)).toBe(true);
    expect(docNo(legacy)).toBe("ANN-OLD");
    expect(docNo(ann({ id: "ann-new", refNo: "OPS-ANN-2609-0001" }))).toBe("OPS-ANN-2609-0001");
    expect(docNo(ann({ id: "ann-new", refNo: "  " }))).toBe("ANN-NEW");
  });

  test("manage status: the approval state outranks awaiting / the ack rate", () => {
    const opts = { pendingForMe: true, pct: 10 };
    expect(manageStatus(ann({ id: "a", approvalStatus: "DRAFT" }), opts, NOW)).toBe("draft");
    expect(manageStatus(ann({ id: "b", approvalStatus: "PENDING_APPROVAL" }), opts, NOW)).toBe("pending_approval");
    expect(manageStatus(ann({ id: "c", approvalStatus: "REJECTED" }), opts, NOW)).toBe("rejected");
    expect(manageStatus(ann({ id: "d", approvalStatus: "APPROVED" }), opts, NOW)).toBe("awaiting");
  });

  test("the approval filter is the pending queue; stats count it and exclude it from live", () => {
    const items = [
      ann({ id: "live", category: "WARNING" }),
      ann({ id: "q1", approvalStatus: "PENDING_APPROVAL" }),
      ann({ id: "q2", approvalStatus: "PENDING_APPROVAL" }),
      ann({ id: "r", approvalStatus: "REJECTED" }),
    ];
    const rows = filterManageRows({ items, filter: "approval", search: "", addressedIds: new Set(), ackedIds: new Set(), currentUserId: 1, now: NOW });
    expect(rows.map((a) => a.id)).toEqual(["q1", "q2"]);
    const stats = manageStats(items, null, new Set(), new Set(), NOW);
    expect(stats.pendingApproval).toBe(2);
    expect(stats.liveNotices).toBe(1);
    expect(MANAGE_ONLY_FILTERS.has("approval")).toBe(true);
    expect(INBOX_FILTERS.some((f) => f.id === "approval")).toBe(true);
  });
});

describe("labels", () => {
  test("audienceLabel prefers server-resolved names and never invents a person's name", () => {
    expect(audienceLabel(ann({ id: "a" }))).toBe("All staff");
    expect(
      audienceLabel(
        ann({ id: "b", targetType: "DEPARTMENT_IDS", targetDeptIds: [1, 2], targetDeptNames: ["Warehouse", "Operation"] }),
      ),
    ).toBe("Warehouse + Operation");
    expect(
      audienceLabel(ann({ id: "c", targetType: "USER_IDS", targetUserIds: [4, 5] })),
    ).toBe("2 people");
    expect(
      audienceLabel(ann({ id: "d", targetType: "USER_IDS", targetUserIds: [4] }), {
        users: new Map([[4, "Siti Aminah"]]),
      }),
    ).toBe("Siti Aminah");
  });

  test("companyScopeLabel: empty or full = Both, a subset lists codes", () => {
    const cos = [
      { id: 1, code: "HC", name: "Houzs Century" },
      { id: 2, code: "2990", name: "2990" },
    ];
    expect(companyScopeLabel([], cos)).toBe("Both");
    expect(companyScopeLabel([1, 2], cos)).toBe("Both");
    expect(companyScopeLabel([2], cos)).toBe("2990");
    expect(companyScopeLabel([1], [])).toBe("");
  });
});
