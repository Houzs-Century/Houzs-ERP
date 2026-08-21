// Fleet Health — a refused write must reach the person who made it.
//
// WHY THIS FILE EXISTS. Six write actions in FleetHealth.tsx swallowed their
// own rejection under the comment `/* surfaced on reload */`. That comment is
// a claim, and it is false in the way that matters: nothing reloads. The
// caller's `onChanged()` refetch runs only INSIDE the try, after the await, so
// a refusal skips it — the page never refetches, never re-renders, and never
// says anything.
//
// The breakdown status dropdown is the sharpest case. It is a controlled
// `<select value={b.status}>`. React only pushes a controlled value back into
// the DOM when a render happens; on failure nothing changes, so no render
// happens, so the browser keeps showing the option the operator just picked.
// The row reads "Resolved" while the server refused it and the lorry is still
// grounded in the database.
//
// These tests assert the CONTRACT, not the markup: after a refused write the
// screen says so. They fail on the pre-fix tree.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, apiPatch, apiDel } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDel: vi.fn(),
}));
vi.mock("../api/client", () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch, del: apiDel },
}));

import {
  BreakdownSection,
  WorkOrdersSection,
  ComponentsSection,
  type BreakdownView,
  type WorkOrderView,
  type ComponentView,
} from "./FleetHealth";

afterEach(cleanup);
/* Braces, not a concise arrow — a mock returned from beforeEach is treated as
   that test's teardown and fires the mock after every test. */
beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiDel.mockReset();
});

const breakdown = (over: Partial<BreakdownView> = {}): BreakdownView => ({
  id: "bd-1",
  caseNo: "BD-0001",
  occurredAt: "2026-08-20T02:00:00.000Z",
  gpsLat: null,
  gpsLng: null,
  faultType: "Tyre burst",
  severity: "MAJOR",
  stillDrivable: false,
  mediaRefs: [],
  driverDescription: null,
  towingCompany: null,
  towingCostSen: null,
  workshop: null,
  breakdownStart: "2026-08-20T02:00:00.000Z",
  recoveryTime: null,
  affectedTripId: null,
  status: "OPEN",
  grounding: true,
  downtimeHours: null,
  notes: null,
  ...over,
});

const workOrder = (over: Partial<WorkOrderView> = {}): WorkOrderView => ({
  id: "wo-1",
  woNo: "WO-0001",
  status: "REPORTED",
  statusLabel: "Reported",
  open: true,
  nextStates: ["DIAGNOSED"],
  problem: "Tyre burst",
  diagnosis: null,
  workshop: "Ah Seng Tyre",
  quotationNo: null,
  invoiceNo: null,
  labourSen: 0,
  outsideServiceSen: 0,
  towingSen: 0,
  taxSen: 0,
  totalSen: 0,
  warrantyUntil: null,
  reportedAt: "2026-08-20T02:00:00.000Z",
  estComplete: null,
  actualComplete: null,
  breakdownCaseId: null,
  componentId: null,
  notes: null,
  parts: [],
  ...over,
});

const component = (over: Partial<ComponentView> = {}): ComponentView => ({
  id: "cp-1",
  componentType: "TYRE",
  componentTypeLabel: "Tyre",
  position: "FL",
  positionLabel: "Front Left",
  brand: "Michelin",
  model: null,
  size: null,
  serial: null,
  fittedDate: "2026-01-01",
  fittedKm: 1000,
  purchasePriceSen: 45000,
  treadDepth: null,
  removedDate: null,
  removedKm: null,
  warrantyUntil: null,
  status: "ACTIVE",
  notes: null,
  kmUsed: null,
  costPerKmSen: null,
  events: [],
  underWarranty: null,
  ...over,
});

/** Every refusal the fleet routes actually answer with. */
const refused = () => Promise.reject(new Error("illegal_transition"));

describe("a refused Fleet Health write is said out loud", () => {
  it("breakdown status: a refused PATCH does not leave the row reading Resolved in silence", async () => {
    apiPatch.mockImplementation(refused);
    const onChanged = vi.fn();
    render(<BreakdownSection vehicleId="v-1" breakdowns={[breakdown()]} onChanged={onChanged} />);

    await userEvent.selectOptions(screen.getByRole("combobox"), "RESOLVED");

    expect(apiPatch).toHaveBeenCalledTimes(1);
    // It failed, so the parent must NOT have been told anything changed …
    expect(onChanged).not.toHaveBeenCalled();
    // … and the operator must be told, rather than left reading "Resolved".
    expect(await screen.findByText(/not allowed from the current state/i)).toBeTruthy();
  });

  it("work-order step: a refused transition says so instead of doing nothing", async () => {
    apiPost.mockImplementation(refused);
    render(
      <WorkOrdersSection
        vehicleId="v-1"
        plate="WXY 1234"
        workOrders={[workOrder()]}
        breakdowns={[]}
        onChanged={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /diagnosed/i }));

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/not allowed from the current state/i)).toBeTruthy();
  });

  it("work-order part: a refused add says so instead of leaving the cost unrecorded", async () => {
    apiPost.mockImplementation(refused);
    render(
      <WorkOrdersSection
        vehicleId="v-1"
        plate="WXY 1234"
        workOrders={[workOrder()]}
        breakdowns={[]}
        onChanged={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /add part/i }));
    await userEvent.type(screen.getByPlaceholderText("Name"), "Tyre 11R22.5");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/could not save|not allowed/i)).toBeTruthy();
  });

  it("component removal: a refused PATCH says so instead of leaving the tyre fitted", async () => {
    apiPatch.mockImplementation(refused);
    render(
      <ComponentsSection
        vehicleId="v-1"
        currentKm={12000}
        components={[component()]}
        onChanged={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /remove/i }));

    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/could not save|not allowed/i)).toBeTruthy();
  });
});
