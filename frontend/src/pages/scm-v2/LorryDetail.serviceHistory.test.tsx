// HC-0031: ONE service history. New repairs are recorded as Fleet Health work
// orders; the Coverage & Fleet drawer no longer opens a second "Add record"
// form, it points to Fleet Health and keeps any older record readable.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
vi.mock("../../vendor/scm/lib/lorries-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/lorries-queries")>()),
  useUpdateLorry: () => idle,
  useDeleteLorryServiceRecord: () => idle,
  useUploadServiceInvoice: () => idle,
  useLorryServiceRecords: () => ({
    isLoading: false,
    data: [{ id: "r1", lorry_id: "L1", service_date: "2026-07-01", description: "Engine oil", workshop: null, cost_sen: 0, odometer_km: null, next_service_date: null, next_service_km: null, notes: null, invoice_key: null, invoice_name: null }],
  }),
}));
vi.mock("../../vendor/scm/lib/inventory-queries", () => ({ useWarehouses: () => ({ data: [] }) }));
vi.mock("../../vendor/scm/lib/threepl-companies-queries", () => ({ useThreePLCompanies: () => ({ data: [] }) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));

import { LorryDetail } from "./LorryDetail";
import type { LorryRow } from "../../vendor/scm/lib/lorries-queries";

afterEach(cleanup);

const lorry = (over: Partial<LorryRow> = {}) => ({ id: "L1", plate: "VPC9058", type: "LORRY_21FT", is_internal: true, ...over }) as LorryRow;

describe("LorryDetail service history (HC-0031)", () => {
  it("points an in-house lorry to Fleet Health instead of a second add form", () => {
    render(<MemoryRouter><LorryDetail lorry={lorry()} onClose={() => {}} /></MemoryRouter>);
    expect(screen.queryByText("Add record")).toBeNull();
    expect(screen.getByText("Record repairs in Fleet Health").getAttribute("href")).toBe("/fleet-health/L1");
    expect(screen.getByText(/Engine oil/)).toBeTruthy();
  });

  it("an outsourced lorry gets no Fleet Health link (Fleet Health tracks in-house lorries)", () => {
    render(<MemoryRouter><LorryDetail lorry={lorry({ is_internal: false })} onClose={() => {}} /></MemoryRouter>);
    expect(screen.queryByText("Record repairs in Fleet Health")).toBeNull();
  });
});
