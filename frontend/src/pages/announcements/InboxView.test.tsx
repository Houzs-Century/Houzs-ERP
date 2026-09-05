import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InboxView, type InboxViewProps } from "./InboxView";
import type { Announcement } from "./announcementModel";

/* ────────────────────────────────────────────────────────────────────────────
   InboxView — the reading mode of /announcements (design handoff 2026-09-04).
   Pins the three-group list (Needs your confirmation / Recent / SOP Library),
   the reading pane's acknowledge bar (only for a notice pending for ME), the
   one-postponement rule on that bar, and that the read-receipts card is a
   writer-only affordance.
   ──────────────────────────────────────────────────────────────────────────── */

vi.mock("../../components/AnnouncementMedia", () => ({
  AnnouncementMedia: () => <div data-testid="media" />,
}));

function ann(over: Partial<Announcement> & { id: string }): Announcement {
  return {
    title: over.id,
    body: "body of " + over.id,
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
  ann({ id: "warn", title: "Shipping marks must be double-checked", category: "WARNING" }),
  ann({
    id: "sop",
    title: "Bin transfer freeze rules",
    category: "SOP",
    targetType: "DEPARTMENT_IDS",
    targetDeptIds: [2],
    targetDeptNames: ["Warehouse"],
  }),
  ann({ id: "notice", title: "Mid-Autumn holiday schedule", category: "GENERAL" }),
];

function props(over: Partial<InboxViewProps> = {}): InboxViewProps {
  return {
    items: ITEMS,
    loading: false,
    addressedIds: new Set(["warn", "sop", "notice"]),
    ackedIds: new Set(["sop"]),
    currentUserId: 1,
    companies: [],
    lookups: {},
    selectedId: "warn",
    onSelect: vi.fn(),
    filter: "all",
    onFilter: vi.fn(),
    search: "",
    onSearch: vi.fn(),
    canManage: () => false,
    canPostpone: () => true,
    onAck: vi.fn(),
    onPostpone: vi.fn(),
    onOpenManage: vi.fn(),
    onRemindPending: vi.fn(),
    onHide: vi.fn(),
    receipts: null,
    receiptsLoading: false,
    ...over,
  };
}

describe("InboxView", () => {
  it("splits the list into the pinned group, Recent and the SOP Library by department", () => {
    render(<InboxView {...props()} />);
    expect(screen.getByText("Needs your confirmation")).toBeTruthy();
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.getByText("SOP Library · never expires")).toBeTruthy();
    expect(screen.getByText("Warehouse")).toBeTruthy();
    expect(screen.getByText("Needs you 1")).toBeTruthy();
    // The acknowledged SOP sits in the library, not in Recent.
    expect(screen.getByText("Bin transfer freeze rules")).toBeTruthy();
    // The read notice carries its Confirmed / Unread status pill.
    expect(screen.getByText("Unread")).toBeTruthy();
  });

  it("shows the acknowledge bar for a pending notice and records the category CTA", () => {
    const p = props();
    render(<InboxView {...p} />);
    expect(screen.getByText("This notice requires acknowledgement")).toBeTruthy();
    expect(screen.getByText("must acknowledge", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(p.onAck).toHaveBeenCalledWith(expect.objectContaining({ id: "warn" }));
    fireEvent.click(screen.getByRole("button", { name: "Remind later" }));
    expect(p.onPostpone).toHaveBeenCalledWith(expect.objectContaining({ id: "warn" }));
  });

  it("drops Remind later once the postponement is spent, and the whole bar once acknowledged", () => {
    const { rerender } = render(<InboxView {...props({ canPostpone: () => false })} />);
    expect(screen.queryByRole("button", { name: "Remind later" })).toBeNull();
    expect(screen.getByRole("button", { name: "Got it" })).toBeTruthy();
    rerender(<InboxView {...props({ ackedIds: new Set(["sop", "warn"]) })} />);
    expect(screen.queryByText("This notice requires acknowledgement")).toBeNull();
    expect(screen.queryByText("Needs your confirmation")).toBeNull();
  });

  it("renders the read-receipts card only for a manager, with the confirmed count", () => {
    const p = props({
      canManage: () => true,
      receipts: { total: 150, ackedCount: 98 },
    });
    render(<InboxView {...p} />);
    expect(screen.getByText("98 / 150 confirmed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in Manage" }));
    expect(p.onOpenManage).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remind pending" }));
    expect(p.onRemindPending).toHaveBeenCalled();
  });

  it("selecting a row reports its id; filter pills report the filter", () => {
    const p = props();
    render(<InboxView {...p} />);
    fireEvent.click(screen.getByText("Mid-Autumn holiday schedule"));
    expect(p.onSelect).toHaveBeenCalledWith("notice");
    fireEvent.click(screen.getByRole("button", { name: "Learning" }));
    expect(p.onFilter).toHaveBeenCalledWith("LEARNING");
    const search = screen.getByLabelText("Search announcements");
    fireEvent.change(search, { target: { value: "holiday" } });
    expect(p.onSearch).toHaveBeenCalledWith("holiday");
  });

  it("a notice not addressed to me shows no status pill and no acknowledge bar", () => {
    render(
      <InboxView
        {...props({
          addressedIds: new Set(["sop"]),
          ackedIds: new Set(),
          selectedId: "notice",
        })}
      />,
    );
    expect(screen.queryByText("Unread")).toBeNull();
    expect(screen.queryByText("This notice requires acknowledgement")).toBeNull();
    const recent = screen.getByText("Recent").parentElement as HTMLElement;
    expect(within(recent).getByText("Recent")).toBeTruthy();
  });
});
