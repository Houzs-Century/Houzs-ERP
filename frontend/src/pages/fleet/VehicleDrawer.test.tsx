// The quick-look drawer for a Compliance Blocked lorry names the document that
// grounds it. GET /vehicles/:id keeps each type's renewals BESIDE the lorry, not
// on it as the board row does, and reading vehicle.compliance crashed the page.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { current: null as unknown } }));
vi.mock("../../hooks/useQuery", () => ({ useQuery: () => state.current }));
vi.mock("../../api/client", () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } }));

import { VehicleDrawer } from "../FleetHealth";

const doc = (over: Record<string, unknown>) => ({
  id: null, docType: "PUSPAKOM", documentRef: null, issueDate: "2026-11-01", expiryDate: "2027-11-01", costSen: null, owner: null,
  result: null, reinspectionDeadline: null, notes: null, daysRemaining: 360, reminderLevel: "OK", tone: "ok", files: [], ...over,
});
const empty = { currentId: null, flatExpiry: null, history: [] };
// The vehicle object exactly as the endpoint sends it: no `compliance` key.
const vehicle = {
  id: "l-1", plate: "VKL 3321", region: "WH-KL", driverName: null, vehicleType: "LORRY_17FT", model: "Isuzu", mileageKm: 84250, mileageDate: "2026-11-26",
  mileageSource: "reading", mileageFlagged: false, nextServiceKm: null, nextServiceDate: null, lastServiceWorkshop: null, outOfService: false,
  outOfServiceReason: null, notes: null, status: "COMPLIANCE_BLOCKED", statusLabel: "Compliance Blocked", canDispatch: false, isInternal: true,
};
const payload = (compliance: Record<string, unknown>) => ({
  vehicle,
  compliance: { PUSPAKOM: empty, ROAD_TAX: empty, INSURANCE: empty, GERAN: empty, ...compliance },
  plans: [], planComponents: [], mileage: [], maintenanceWindows: [], breakdowns: [], workOrders: [], components: [],
});
const open = (data: unknown) => {
  state.current = { loading: false, fetching: false, placeholder: false, reload: vi.fn(), error: null, data };
  render(<MemoryRouter><VehicleDrawer id="l-1" onClose={() => {}} /></MemoryRouter>);
};

afterEach(cleanup);

describe("VehicleDrawer for a Compliance Blocked lorry", () => {
  it("names the failed PUSPAKOM from the current renewal, not an older pass", () => {
    open(payload({
      PUSPAKOM: {
        currentId: "d-new", flatExpiry: null,
        history: [doc({ id: "d-new", result: "FAIL" }), doc({ id: "d-old", result: "PASS", issueDate: "2025-11-01", expiryDate: "2026-11-01" })],
      },
    }));
    expect(screen.getByText("PUSPAKOM failed")).toBeTruthy();
  });

  it("names an expired road tax", () => {
    open(payload({
      ROAD_TAX: { currentId: "r-1", flatExpiry: null, history: [doc({ id: "r-1", docType: "ROAD_TAX", expiryDate: "2026-11-20", daysRemaining: -6, reminderLevel: "EXPIRED" })] },
    }));
    expect(screen.getByText("Road Tax / LKM expired")).toBeTruthy();
  });

  it("blocked only by a legacy expiry column (no vault row) still opens, with the plain reason", () => {
    open(payload({ ROAD_TAX: { currentId: null, flatExpiry: "2026-11-20", history: [] } }));
    expect(screen.getByText("Compliance blocked")).toBeTruthy();
  });
});
