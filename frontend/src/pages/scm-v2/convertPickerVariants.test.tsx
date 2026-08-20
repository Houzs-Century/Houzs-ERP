/* "只要有 variants 的，你就应该要显示 variants" — owner, 2026-08-19.
 *
 * A sofa model decomposes into MODULES that share a model name: 9028-1A(LHF),
 * 9028-1A(RHF), 9028-1NA. On a picker that prints only the material name, those
 * are three identical-looking rows, and the operator ticking one of them is
 * guessing. The line's fabric code / seat height / leg height is the only thing
 * that tells them apart, and every one of them already rides in on the read.
 *
 * These mount the REAL pickers with only their data hook faked and assert what
 * the operator SEES — not that a component is imported, which is exactly the
 * half-fix this file exists to keep out: `VariantDescription` over a row whose
 * endpoint never selected `variants` renders nothing and looks identical to a
 * missing component.
 *
 * FAILS ON THE PRE-FIX CODE: both pickers rendered `r.materialName` alone.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { pcOrderLines, pcReceiveLines } = vi.hoisted(() => ({
  pcOrderLines: vi.fn(),
  pcReceiveLines: vi.fn(),
}));

vi.mock("../../vendor/scm/lib/purchase-consignment-receive-queries", () => ({
  useOutstandingPcOrderLines: pcOrderLines,
}));
vi.mock("../../vendor/scm/lib/purchase-consignment-return-queries", () => ({
  useReturnablePcReceiveLines: pcReceiveLines,
}));

import { PurchaseConsignmentReceiveFromOrder } from "./PurchaseConsignmentReceiveFromOrder";
import { PurchaseConsignmentReturnFromReceive } from "./PurchaseConsignmentReturnFromReceive";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const loaded = (rows: unknown[]) => ({ data: rows, isLoading: false, isError: false });

/* The variant bag a sofa module carries on a consignment line: fabric code +
   colour, seat height, leg height. buildVariantSummary renders it as
   `PC151-01 Pearl / SEAT 24" / LEG 6"`. */
const SOFA_VARIANTS = {
  fabricCode: "PC151-01",
  colourLabel: "Pearl",
  seatHeight: '24"',
  legHeight: '6"',
};

/* Two modules of ONE sofa model. Same material name on purpose — that is the
   whole point: without the variant line these two rows are indistinguishable. */
const lhf = (over: Record<string, unknown> = {}) => ({
  itemCode: "9028-1A(LHF)",
  materialName: "9028 SOFA",
  itemGroup: "sofa",
  description: null,
  variants: SOFA_VARIANTS,
  supplierId: "sup-1",
  supplierName: "HOOKKA INDUSTRIES SDN. BHD.",
  materialKind: "mfg_product",
  supplierSku: null,
  uom: "UNIT",
  unitPriceSen: 0,
  ...over,
});

describe("PC Receive ← PC Order picker", () => {
  it("shows each module's variant summary, not just the shared material name", () => {
    pcOrderLines.mockReturnValue(loaded([
      {
        ...lhf(),
        orderItemId: "oi-1",
        purchaseConsignmentOrderId: "pco-1",
        pcNumber: "HC-PC-2608-001",
        ordered: 2, received: 0, outstanding: 2,
      },
      {
        ...lhf({ itemCode: "9028-1A(RHF)", variants: { ...SOFA_VARIANTS, seatHeight: '28"' } }),
        orderItemId: "oi-2",
        purchaseConsignmentOrderId: "pco-1",
        pcNumber: "HC-PC-2608-001",
        ordered: 1, received: 0, outstanding: 1,
      },
    ]));

    render(
      <MemoryRouter initialEntries={["/scm/purchase-consignment-receive/from-pc-order"]}>
        <PurchaseConsignmentReceiveFromOrder />
      </MemoryRouter>,
    );

    // The shared name is on both rows and therefore identifies neither.
    expect(screen.getAllByText("9028 SOFA").length).toBe(2);
    // The variant summaries are what tell the two modules apart.
    expect(screen.getByText('PC151-01 Pearl / SEAT 24" / LEG 6"')).toBeTruthy();
    expect(screen.getByText('PC151-01 Pearl / SEAT 28" / LEG 6"')).toBeTruthy();
  });
});

describe("PC Return ← PC Receive picker", () => {
  it("shows the received module's variant summary on the row being returned", () => {
    pcReceiveLines.mockReturnValue(loaded([
      {
        ...lhf(),
        receiveItemId: "ri-1",
        pcReceiveId: "pcr-1",
        receiveNumber: "HC-PCR-2608-001",
        accepted: 2, returned: 0, remaining: 2,
      },
    ]));

    render(
      <MemoryRouter initialEntries={["/scm/purchase-consignment-return/from-pc-receive"]}>
        <PurchaseConsignmentReturnFromReceive />
      </MemoryRouter>,
    );

    expect(screen.getByText("9028 SOFA")).toBeTruthy();
    expect(screen.getByText('PC151-01 Pearl / SEAT 24" / LEG 6"')).toBeTruthy();
  });
});
