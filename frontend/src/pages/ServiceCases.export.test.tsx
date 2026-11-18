/* HC-0244: with the Supplier funnel set, Export on the Service Cases list wrote
   every case. The list already holds every case the filters match, so Export
   writes the rows the table shows, funnels included. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadCSV } from "../lib/csv";

vi.mock("../lib/csv", async (orig) => ({
  ...(await orig<typeof import("../lib/csv")>()),
  downloadCSV: vi.fn(),
}));
vi.mock("../auth/AuthContext", async (orig) => ({
  ...(await orig<typeof import("../auth/AuthContext")>()),
  useAuth: () => ({ user: { id: 1, permissions: [] }, can: () => true }),
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../hooks/useDialog", () => ({ useDialog: () => ({ confirm: vi.fn() }) }));

const casesPage = {
  data: [
    { id: 1, assr_no: "ASSR/2611-001", stage: "pending_item_ready", creditor_name: "HOOKKA INDUSTRIES SDN. BHD." },
    { id: 2, assr_no: "ASSR/2611-002", stage: "pending_item_ready", creditor_name: "FADECO REFORM INDUSTRIES SDN. BHD." },
    { id: 3, assr_no: "ASSR/2611-003", stage: "pending_item_ready", creditor_name: "HOOKKA INDUSTRIES SDN. BHD." },
  ],
  total: 3,
  page: 1,
  per_page: 3,
};
const idle = { loading: false, error: null, fetching: false, placeholder: false, reload: () => undefined };
vi.mock("../hooks/useQuery", () => ({
  useQuery: (key: string) => ({ ...idle, data: key === "assr-list" ? casesPage : null }),
}));

import { ServiceCases } from "./ServiceCases";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(downloadCSV).mockClear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
  const supplierFunnel = JSON.stringify({ creditor_name: ["HOOKKA INDUSTRIES SDN. BHD."] });
  window.history.replaceState(null, "", `/assr?view=cases&cf.assr=${encodeURIComponent(supplierFunnel)}`);
});
afterEach(cleanup);

describe("Service Cases export", () => {
  it("writes only the cases of the supplier picked in the funnel", () => {
    render(
      <MemoryRouter initialEntries={["/assr?view=cases"]}>
        <ServiceCases />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Export$/ }));
    const written = String(vi.mocked(downloadCSV).mock.calls[0]?.[1] ?? "");
    expect(written).toContain("ASSR/2611-001");
    expect(written).toContain("ASSR/2611-003");
    expect(written).not.toContain("FADECO");
  });
});
