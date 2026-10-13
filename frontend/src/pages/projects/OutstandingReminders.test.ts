import { describe, it, expect } from "vitest";
import {
  distinctTasks,
  distinctOrganizers,
  dateRange,
  filterRows,
  ALL_ORGANIZERS,
  groupRows,
  groupLabel,
  buildGroupMessage,
  buildAllMessage,
  currentMonthMyt,
  monthOptions,
  type OutstandingRow,
} from "./OutstandingReminders";

function row(over: Partial<OutstandingRow> & { id: number }): OutstandingRow {
  return {
    title: "Filled Floorplan",
    status: "pending",
    review_status: null,
    due_date: "2026-10-02",
    overdue_days: 0,
    project_id: over.id,
    code: `C${over.id}`,
    name: `Event ${over.id}`,
    brand: "AKEMI",
    organizer: "BIGHOME",
    state: "Kuala Lumpur",
    venue: "MID VALLEY",
    booth_no: null,
    start_date: "2026-10-02",
    end_date: "2026-10-04",
    pic_name: null,
    owner_name: null,
    ...over,
  };
}

describe("distinctTasks", () => {
  it("returns unique titles sorted alphabetically", () => {
    const rows = [
      row({ id: 1, title: "Filled Floorplan" }),
      row({ id: 2, title: "Booth" }),
      row({ id: 3, title: "Filled Floorplan" }),
      row({ id: 4, title: "Agreement / Quotation" }),
    ];
    expect(distinctTasks(rows)).toEqual(["Agreement / Quotation", "Booth", "Filled Floorplan"]);
  });
});

describe("distinctOrganizers", () => {
  it("returns unique trimmed organizers sorted alphabetically, skipping blanks", () => {
    const rows = [
      row({ id: 1, organizer: "MYHOME" }),
      row({ id: 2, organizer: " BIGHOME " }),
      row({ id: 3, organizer: "MYHOME" }),
      row({ id: 4, organizer: null }),
      row({ id: 5, organizer: "  " }),
    ];
    expect(distinctOrganizers(rows)).toEqual(["BIGHOME", "MYHOME"]);
  });
});

describe("filterRows", () => {
  const all = { task: "__all__", status: "incomplete" as const, organizer: ALL_ORGANIZERS };
  const rows = [
    row({ id: 1, title: "Filled Floorplan", overdue_days: 3, organizer: "MYHOME" }),
    row({ id: 2, title: "Booth", overdue_days: 0, organizer: "REX" }),
    row({ id: 3, title: "Filled Floorplan", overdue_days: 0, organizer: " REX " }),
  ];

  it("filters by a specific task title", () => {
    expect(filterRows(rows, { ...all, task: "Filled Floorplan" }).map((r) => r.id)).toEqual([1, 3]);
  });

  it("keeps every task when set to All", () => {
    expect(filterRows(rows, all)).toHaveLength(3);
  });

  it("overdue-only drops rows that are not overdue", () => {
    expect(filterRows(rows, { ...all, status: "overdue" }).map((r) => r.id)).toEqual([1]);
  });

  it("narrows to one organizer, matching the trimmed value", () => {
    expect(filterRows(rows, { ...all, organizer: "REX" }).map((r) => r.id)).toEqual([2, 3]);
  });

  it("task + organizer combine", () => {
    expect(filterRows(rows, { ...all, task: "Filled Floorplan", organizer: "REX" }).map((r) => r.id)).toEqual([3]);
  });
});

describe("dateRange", () => {
  it("renders a two-day span, a same-day event, and a start-only event", () => {
    expect(dateRange("2026-10-31", "2026-11-02")).toBe("31 Oct – 2 Nov");
    expect(dateRange("2026-10-02", "2026-10-04")).toBe("2 Oct – 4 Oct");
    expect(dateRange("2026-10-05", "2026-10-05")).toBe("5 Oct");
    expect(dateRange("2026-10-05T00:00:00Z", null)).toBe("5 Oct");
    expect(dateRange(null, "2026-10-05")).toBe("");
  });
});

describe("groupLabel", () => {
  it("falls back to sentinels when the axis value is empty", () => {
    expect(groupLabel(row({ id: 1, organizer: null }), "organizer")).toBe("— No organizer —");
    expect(groupLabel(row({ id: 1, owner_name: "  " }), "owner")).toBe("— Unassigned —");
    expect(groupLabel(row({ id: 1, pic_name: null }), "pic")).toBe("— No PIC —");
  });
});

describe("groupRows", () => {
  it("orders groups by pending count (desc) then name, and rows overdue-first", () => {
    const rows = [
      row({ id: 1, organizer: "MLE", overdue_days: 0, due_date: "2026-10-20" }),
      row({ id: 2, organizer: "BIGHOME", overdue_days: 0, due_date: "2026-10-10" }),
      row({ id: 3, organizer: "BIGHOME", overdue_days: 5, due_date: "2026-10-01" }),
      row({ id: 4, organizer: "BIGHOME", overdue_days: 0, due_date: "2026-10-05" }),
    ];
    const groups = groupRows(rows, "organizer");
    // BIGHOME (3 rows) before MLE (1 row)
    expect(groups.map((g) => g.label)).toEqual(["BIGHOME", "MLE"]);
    // within BIGHOME: overdue first (id 3), then by due date (id 4 @ 10-05, id 2 @ 10-10)
    expect(groups[0].rows.map((r) => r.id)).toEqual([3, 4, 2]);
  });
});

describe("buildGroupMessage", () => {
  it("renders a bold header with count and one dotted line per row", () => {
    const groups = groupRows(
      [
        row({ id: 1, organizer: "BIGHOME", title: "Filled Floorplan", overdue_days: 3, booth_no: "B31" }),
        row({ id: 2, organizer: "BIGHOME", title: "Filled Floorplan", overdue_days: 0, due_date: "2026-10-10" }),
      ],
      "organizer",
    );
    const msg = buildGroupMessage(groups[0]);
    expect(msg).toContain("*BIGHOME* (2)");
    expect(msg).toContain("🔴 Filled Floorplan — Event 1 · Booth B31 · overdue 3d");
    expect(msg).toContain("🟡 Filled Floorplan — Event 2 · due 2026-10-10");
  });
});

describe("buildAllMessage", () => {
  it("has a header naming the filter, every group, and a total footer", () => {
    const groups = groupRows(
      [
        row({ id: 1, organizer: "BIGHOME", overdue_days: 2 }),
        row({ id: 2, organizer: "MLE", overdue_days: 0 }),
      ],
      "organizer",
    );
    const msg = buildAllMessage(groups, {
      task: "Filled Floorplan",
      monthLabel: "Oct 2026",
      status: "incomplete",
      organizer: ALL_ORGANIZERS,
    });
    expect(msg).toContain("📋 Outstanding — Filled Floorplan · Oct 2026 · Incomplete");
    expect(msg).toContain("*BIGHOME* (1)");
    expect(msg).toContain("*MLE* (1)");
    expect(msg).toContain("Total: 2 tasks across 2 groups");
  });

  it("singularises the total for one task in one group", () => {
    const groups = groupRows([row({ id: 1, organizer: "BIGHOME" })], "organizer");
    const msg = buildAllMessage(groups, {
      task: "__all__",
      monthLabel: "All months",
      status: "overdue",
      organizer: ALL_ORGANIZERS,
    });
    expect(msg).toContain("📋 Outstanding — All tasks · All months · Overdue only");
    expect(msg).toContain("Total: 1 task across 1 group");
  });

  it("names the organizer in the header when narrowed to one", () => {
    const groups = groupRows([row({ id: 1, organizer: "MYHOME" })], "pic");
    const msg = buildAllMessage(groups, {
      task: "Filled Floorplan",
      monthLabel: "Oct 2026",
      status: "incomplete",
      organizer: "MYHOME",
    });
    expect(msg).toContain("📋 Outstanding — Filled Floorplan · MYHOME · Oct 2026 · Incomplete");
  });
});

describe("month helpers", () => {
  it("currentMonthMyt returns the Malaysia year-month", () => {
    // 2026-01-01 00:00 UTC is already 08:00 on 2026-01-01 in MYT.
    expect(currentMonthMyt(Date.parse("2026-01-01T00:00:00Z"))).toBe("2026-01");
    // 2026-01-31 20:00 UTC is 2026-02-01 04:00 MYT — rolls to the next month.
    expect(currentMonthMyt(Date.parse("2026-01-31T20:00:00Z"))).toBe("2026-02");
  });

  it("monthOptions leads with upcoming months and includes the current one", () => {
    const opts = monthOptions(Date.parse("2026-09-15T02:00:00Z"));
    expect(opts[0].value).toBe("2027-06"); // base Sep 2026, +9 months → Jun 2027
    expect(opts[opts.length - 1].value).toBe("2026-06"); // -3 months → Jun 2026
    expect(opts.some((o) => o.value === "2026-09")).toBe(true);
  });
});
