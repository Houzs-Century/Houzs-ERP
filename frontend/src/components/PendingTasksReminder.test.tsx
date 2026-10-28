// The reminder modal's BEHAVIOUR, with the data hook mocked — what it shows,
// what it refuses to let you postpone, and that ✕-less dismissal is deliberate.
// The digest arithmetic itself is pinned separately in hooks/pendingDigest.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PendingDigest } from "../hooks/pendingDigest";

const acknowledge = vi.fn();
const postpone = vi.fn();
const armMyPendingFilter = vi.fn();
let state: { digest: PendingDigest | null; open: boolean };

vi.mock("../hooks/usePendingReminder", () => ({
  usePendingReminder: () => ({ ...state, acknowledge, postpone, armMyPendingFilter }),
}));

const { PendingTasksReminder } = await import("./PendingTasksReminder");

const digest = (over: Partial<PendingDigest> = {}): PendingDigest => ({
  total: 3,
  worst: "later",
  mustAcknowledge: false,
  groups: [{ tier: "later", events: [{ id: 1, name: "E" }], titles: [] }],
  ...over,
});

const show = () =>
  render(
    <MemoryRouter>
      <PendingTasksReminder />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  state = { digest: digest(), open: true };
});

describe("PendingTasksReminder", () => {
  it("renders nothing when there is nothing owed", () => {
    state = { digest: null, open: false };
    const { container } = show();
    expect(container.innerHTML).toBe("");
  });

  it("leads with the event count and lists the worst tier first", () => {
    state = {
      open: true,
      digest: digest({
        total: 26,
        worst: "past_event",
        mustAcknowledge: true,
        groups: [
          { tier: "past_event", events: [{ id: 1, name: "A" }, { id: 2, name: "B" }], titles: ["Stock In Transfer Record"] },
          { tier: "this_week", events: [{ id: 3, name: "C" }], titles: [] },
        ],
      }),
    };
    show();
    expect(screen.getByText(/26 events with work waiting/i)).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    // Worst first — an event that already finished must not sit below a future one.
    expect(items[0].textContent).toMatch(/already finished/i);
    expect(items[1].textContent).toMatch(/within 7 days/i);
    expect(screen.getByText(/Stock In Transfer Record/)).toBeTruthy();
  });

  it("refuses postponement once something has run past its event", () => {
    state = { open: true, digest: digest({ worst: "past_event", mustAcknowledge: true }) };
    show();
    expect(screen.queryByRole("button", { name: /remind later/i })).toBeNull();
    expect(screen.getByText(/requires acknowledgement/i)).toBeTruthy();
  });

  it("allows one postponement when nothing is urgent", () => {
    show();
    const later = screen.getByRole("button", { name: /remind later/i });
    fireEvent.click(later);
    expect(postpone).toHaveBeenCalledTimes(1);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("'Got it' acknowledges — that is what silences it until tomorrow", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /got it/i }));
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("tapping the body arms the My Pending filter before navigating", () => {
    show();
    fireEvent.click(screen.getByText(/events? with work waiting/i));
    // Order matters: arming after navigation would land on an unfiltered list.
    expect(armMyPendingFilter).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
});
