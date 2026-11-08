// The dashboard says when the fleet failed to load instead of showing an empty
// fleet, and draws each lorry's row with its plate and record link.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { current: null as unknown } }));
vi.mock("../../hooks/useQuery", () => ({ useQuery: () => state.current }));
vi.mock("../../api/client", () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } }));

import { FleetHealth } from "./FleetHealthDashboard";
import { OffRoadList } from "./OffRoadList";

const base = { loading: false, fetching: false, placeholder: false, reload: vi.fn() };
const lorry = {
  id: "l-1", plate: "VRH 9058", region: "KL", driverName: "Ali", vehicleType: "LORRY", model: "Isuzu", mileageKm: 120000, mileageDate: "2026-11-06",
  mileageSource: "reading", mileageFlagged: true, nextServiceKm: null, nextServiceDate: null, outOfService: false, outOfServiceReason: null, notes: null,
  status: "AVAILABLE", statusLabel: "Available", canDispatch: true, compliance: {}, planCount: 0, plansOverdue: 0, plansDueSoon: 0, nextPlan: null,
  lengthFt: 17, widthFt: 7, heightFt: 7,
};
const payload = {
  today: "2026-11-07",
  kpis: { expiredDocs: 0, expiring30: 0, expiring60: 0, expiring90: 0, serviceDue: 0, serviceOverdue: 0, activeBreakdowns: 0, complianceBlocked: 0, cantDispatch: 0, openWorkOrders: 0, fleetSize: 1, repairSpendThisMonthSen: null, costliestVehicle: null, costliestVehicleSen: null },
  statusCounts: { AVAILABLE: 1 },
  vehicles: [lorry],
};

afterEach(cleanup);

describe("Fleet Health dashboard", () => {
  it("a failed load says so and offers a retry, never 'No lorries in this view'", () => {
    state.current = { ...base, data: null, error: "Server error" };
    render(<MemoryRouter><FleetHealth /></MemoryRouter>);
    expect(screen.getByText(/Could not load the fleet: Server error/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/No lorries in this view/)).toBeNull();
  });

  it("lists each lorry with its plate linking to the record", () => {
    state.current = { ...base, data: payload, error: null };
    render(<MemoryRouter><FleetHealth /></MemoryRouter>);
    const link = screen.getAllByRole("link", { name: "VRH 9058" })[0];
    expect(link.getAttribute("href")).toBe("/fleet-health/l-1");
    expect(screen.getByText("Every lorry can go out")).toBeTruthy();
  });
});

describe("OffRoadList", () => {
  it("says so when the lorry was never off the road", () => {
    render(<OffRoadList windows={[]} today="2026-11-07" />);
    expect(screen.getByText("Never taken off the road.")).toBeTruthy();
  });
  it("shows each window with its reason, length and state", () => {
    render(<OffRoadList windows={[{ from: "2026-11-06", to: "2026-11-08", reason: "Gearbox" }]} today="2026-11-07" />);
    expect(screen.getByText("Gearbox")).toBeTruthy();
    expect(screen.getByText(/3 days/)).toBeTruthy();
    expect(screen.getByText("Off the road now")).toBeTruthy();
  });
});
