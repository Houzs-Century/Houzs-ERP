import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ManageView, type ManageViewProps } from "./ManageView";
import type { AcksData, Announcement } from "./announcementModel";

/* ────────────────────────────────────────────────────────────────────────────
   ManageView — the poster's view (design handoff 2026-09-04, screen 2). Pins
   the stat strip, the ack-rate column with its thresholds and statuses, the
   two-level drill-down (notice → department → person) and the two actions.
   ──────────────────────────────────────────────────────────────────────────── */

function ann(over: Partial<Announcement> & { id: string }): Announcement {
  return {
    title: over.id,
    body: "",
    isActive: true,
    expiresAt: null,
    createdAt: "2026-09-04T09:00:00Z",
    createdBy: 1,
    createdByName: "Lee Wei",
    remindedAt: null,
    updatedAt: null,
    targetType: "ALL_USERS",
    category: "GENERAL",
    ...over,
  };
}

const ITEMS: Announcement[] = [
  ann({ id: "warn", title: "Shipping marks", category: "WARNING" }),
  ann({ id: "sop", title: "PO Amendment", category: "SOP" }),
  ann({ id: "old", title: "Power shutdown", expiresAt: "2026-01-01T00:00:00Z" }),
];

const RECEIPTS: AcksData = {
  total: 6,
  ackedCount: 3,
  acked: [
    { id: 5, name: "Ahmad Faizal", email: "a@x", departmentId: 2, departmentName: "Warehouse", positionName: "Storekeeper", ackedAt: "2026-09-04T10:00:00Z" },
    { id: 6, name: "Wong Kah Seng", email: "w@x", departmentId: 1, departmentName: "Sales", positionName: "Sales Director", ackedAt: "2026-09-04T10:00:00Z" },
    { id: 7, name: "Farah Nadia", email: "f@x", departmentId: 3, departmentName: "Finance", positionName: "Account Executive", ackedAt: null },
  ],
  pending: [
    { id: 1, name: "Tan Boon Hooi", email: "t@x", departmentId: 2, departmentName: "Warehouse", positionName: "Warehouse Supervisor", state: "overdue" },
    { id: 2, name: "Siti Aminah", email: "s@x", departmentId: 2, departmentName: "Warehouse", positionName: "Storekeeper", state: "reminded" },
    { id: 3, name: "Cheah Mei Ling", email: "c@x", departmentId: 1, departmentName: "Sales", positionName: "Sales Executive", state: "pending" },
  ],
  byDepartment: [
    { id: 3, name: "Finance", total: 1, acked: 1, pending: 0 },
    { id: 1, name: "Sales", total: 2, acked: 1, pending: 1 },
    { id: 2, name: "Warehouse", total: 3, acked: 1, pending: 2 },
  ],
  remindedAt: null,
  overdueAfterHours: 48,
};

function props(over: Partial<ManageViewProps> = {}): ManageViewProps {
  return {
    items: ITEMS,
    loading: false,
    summary: { warn: { total: 150, acked: 98 }, sop: { total: 70, acked: 32 }, old: { total: 150, acked: 145 } },
    addressedIds: new Set(["warn", "sop", "old"]),
    ackedIds: new Set(["sop"]),
    currentUserId: 1,
    lookups: {},
    selectedId: "warn",
    onSelect: vi.fn(),
    filter: "all",
    onFilter: vi.fn(),
    search: "",
    onSearch: vi.fn(),
    receipts: RECEIPTS,
    receiptsLoading: false,
    drillDept: null,
    onDrill: vi.fn(),
    onRemindPending: vi.fn(),
    onRemindDept: vi.fn(),
    onEscalate: vi.fn(),
    onToggleHidden: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
}

describe("ManageView", () => {
  it("stat strip: awaiting me, live notices, average rate and escalated count", () => {
    render(<ManageView {...props()} />);
    const stat = (label: string) =>
      String(screen.getByText(label, { selector: "span.font-mono" }).parentElement!.textContent);
    // warn is pending for me (sop acked); old is archived; live = warn + sop;
    // avg of 65% and 46% = 56% (rounded); both live rows sit under 70%.
    expect(stat("Awaiting you")).toContain("1");
    expect(stat("Live notices")).toContain("2");
    expect(stat("Avg. ack rate")).toContain("56%");
    expect(stat("Overdue · escalated")).toContain("2");
  });

  it("table rows carry the ack rate, the threshold colour and the status", () => {
    render(<ManageView {...props()} />);
    expect(screen.getByText("65%")).toBeTruthy();
    expect(screen.getByText("46%")).toBeTruthy();
    expect(screen.getByText("97%")).toBeTruthy();
    expect(screen.getByText("Awaiting you", { selector: "td span" })).toBeTruthy();
    expect(screen.getByText("Escalated")).toBeTruthy();
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByText("Showing 3 of 3")).toBeTruthy();
  });

  it("filter pills narrow the table; a row click selects it", () => {
    const p = props({ filter: "SOP" });
    render(<ManageView {...p} />);
    expect(screen.getByText("Showing 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByText("PO Amendment"));
    expect(p.onSelect).toHaveBeenCalledWith("sop");
    fireEvent.click(screen.getByRole("button", { name: "Posted by me" }));
    expect(p.onFilter).toHaveBeenCalledWith("mine");
  });

  it("drawer: department buckets, the first one open, its people with state pills", () => {
    const p = props();
    render(<ManageView {...p} />);
    expect(screen.getByText("3 / 6 confirmed")).toBeTruthy();
    expect(screen.getByText("Finance · pending")).toBeTruthy();
    expect(screen.getByText("0 people")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Warehouse 1 \/ 3/ }));
    expect(p.onDrill).toHaveBeenCalledWith("2");
  });

  it("drill-down switches departments and lists pending before confirmed", () => {
    const p = props({ drillDept: "2" });
    render(<ManageView {...p} />);
    expect(screen.getByText("Warehouse · pending")).toBeTruthy();
    expect(screen.getByText("2 people")).toBeTruthy();
    expect(screen.getByText("overdue")).toBeTruthy();
    expect(screen.getByText("reminded")).toBeTruthy();
    expect(screen.getByText("confirmed")).toBeTruthy();
    expect(screen.queryByText("Cheah Mei Ling")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Remind all pending/ }));
    expect(p.onRemindPending).toHaveBeenCalledWith(expect.objectContaining({ id: "warn" }));
    fireEvent.click(screen.getByRole("button", { name: "Notify their supervisors" }));
    expect(p.onEscalate).toHaveBeenCalledWith(expect.objectContaining({ id: "warn" }), 2, "Warehouse");
    fireEvent.click(screen.getByRole("button", { name: /Remind Warehouse pending/ }));
    expect(p.onRemindDept).toHaveBeenCalledWith(expect.objectContaining({ id: "warn" }), 2, "Warehouse");
  });

  it("without a summary the rates read as loading and the escalated count as unknown", () => {
    render(<ManageView {...props({ summary: null })} />);
    expect(screen.getAllByText("…").length).toBeGreaterThan(0);
    expect(screen.getByText("Overdue · escalated").parentElement!.textContent).toContain("—");
  });
});
