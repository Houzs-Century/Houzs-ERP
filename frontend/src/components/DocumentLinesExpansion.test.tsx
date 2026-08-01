// Three owner defects on the SCM document-list chips (2026-08-01), pinned so
// they cannot creep back:
//
//   1. A Delivered chip must NOT print "x1" — the chip already names one DO, so
//      the multiplier only earns its place above 1.
//   2. The "MRP guess · not linked" CAPTION is gone, but the fact it stated is
//      not: an unlinked assignment must still say so in the chip's tooltip, and
//      the floating chip must still carry its "~".
//   3. A Source PO chip is the stored batch_no VERBATIM. This suite asserts the
//      exact strings render unchanged, because "unifying" the company prefix
//      would rename evidence on the batch -> lot -> COGS trail.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssignedSoCell,
  DeliveredCell,
  DocumentLinesExpansion,
  sourcePoTitle,
  type DocumentDrillLine,
} from "./DocumentLinesExpansion";

afterEach(cleanup);

const line = (over: Partial<DocumentDrillLine> = {}): DocumentDrillLine => ({
  itemGroup: "mattress",
  code: "MAT-001",
  description: "Mattress",
  description2: null,
  variants: null,
  qty: 1,
  amountCenti: 100000,
  ...over,
});

describe("Delivered chips — no x1", () => {
  it("omits the multiplier for a single unit", () => {
    render(<DeliveredCell dos={[{ doNo: "2990-DO-2607-022", qty: 1 }]} />);
    expect(screen.getByText("2990-DO-2607-022")).toBeTruthy();
    expect(screen.queryByText(/x1/)).toBeNull();
  });

  it("still shows the multiplier above one", () => {
    render(<DeliveredCell dos={[{ doNo: "2990-DO-2607-024", qty: 3 }]} />);
    expect(screen.getByText(/x3/)).toBeTruthy();
  });

  it("applies the same rule inside the drill-down", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        showDelivered
        lines={[line({ deliveredDos: [{ doNo: "2990-DO-2607-022", qty: 1 }] })]}
      />,
    );
    expect(screen.getByText("2990-DO-2607-022")).toBeTruthy();
    expect(screen.queryByText(/x1/)).toBeNull();
  });
});

describe("Assigned SO — the caption is gone, the warning is not", () => {
  const mrpOnly = [{ soDocNo: "2990-SO-2607-010", deliveryDate: null, locked: false }];

  it("prints no MRP-guess caption in the drill-down", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        showAssignment
        lines={[line({ assignedSos: mrpOnly, sourceLinked: false })]}
      />,
    );
    expect(screen.queryByText(/MRP guess/i)).toBeNull();
    expect(screen.queryByText(/not linked/i)).toBeNull();
  });

  it("keeps the floating marker and the tooltip that replaced the caption", () => {
    const { container } = render(
      <DocumentLinesExpansion
        isLoading={false}
        showAssignment
        lines={[line({ assignedSos: mrpOnly, sourceLinked: false })]}
      />,
    );
    expect(screen.getByText("~", { exact: false })).toBeTruthy();
    expect(container.querySelector('[title*="MRP guess"]')).toBeTruthy();
  });

  it("says so in the tooltip when a non-floating chip has no stored link", () => {
    const { container } = render(
      <AssignedSoCell
        assignments={[{ soDocNo: "SO-2607-004", deliveryDate: null, locked: true }]}
        sourceLinked={false}
      />,
    );
    expect(screen.queryByText(/MRP guess · not linked/)).toBeNull();
    expect(container.querySelector('[title*="MRP allocation"]')).toBeTruthy();
  });
});

describe("Source PO chips render the stored doc number verbatim", () => {
  it("leaves both company namespaces exactly as stored", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        showSourcePo
        lines={[line({ sourcePos: ["2990-PO-2606-003", "PO-2607-002"] })]}
      />,
    );
    expect(screen.getByText("2990-PO-2606-003")).toBeTruthy();
    expect(screen.getByText("PO-2607-002")).toBeTruthy();
    // The bare one must NOT acquire a prefix: a `2990-PO-2607-002` may be a
    // different, real purchase order.
    expect(screen.queryByText("2990-PO-2607-002")).toBeNull();
  });

  it("explains the prefix rather than changing it", () => {
    expect(sourcePoTitle("2990-PO-2606-003")).toContain("2990-");
    expect(sourcePoTitle("PO-2607-002")).toContain("base company");
  });
});
