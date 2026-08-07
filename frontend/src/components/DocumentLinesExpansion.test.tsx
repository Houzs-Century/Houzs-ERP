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
  CommittedBatchCell,
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

describe("Paired per-SO sub-table (2026-08-02 — one row per assigned SO)", () => {
  const assigned = [
    { soDocNo: "2990-SO-2606-021", deliveryDate: "2026-07-10", locked: true, source: "delivered" as const },
    { soDocNo: "2990-SO-2606-030", deliveryDate: "2026-09-15", locked: true, source: "linked" as const },
  ];
  const delivered = [
    { doNo: "2990-DO-2607-001", qty: 1, soDocNo: "2990-SO-2606-021" },
    { doNo: "2990-DO-2607-002", qty: 2, soDocNo: "2990-SO-2606-021" },
  ];

  it("pairs each delivered DO with ITS SO row and statuses the rest PENDING", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        showAssignment
        showDelivered
        lines={[line({ assignedSos: assigned, deliveredDos: delivered })]}
      />,
    );
    // Both SO rows render; the shipped one says DELIVERED, the future-dated
    // unshipped one says PENDING (never blank).
    expect(screen.getByText("2990-SO-2606-021")).toBeTruthy();
    expect(screen.getByText("2990-SO-2606-030")).toBeTruthy();
    expect(screen.getByText("DELIVERED")).toBeTruthy();
    expect(screen.getByText("PENDING")).toBeTruthy();
    // The multi-DO SO row shows EVERY qty (x1 allowed on multi-chip rows).
    expect(screen.getByText(/x1/)).toBeTruthy();
    expect(screen.getByText(/x2/)).toBeTruthy();
  });

  it("keeps a delivered DO visible even when its SO is not among the assignments", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        showAssignment
        showDelivered
        lines={[line({
          assignedSos: [assigned[0]],
          deliveredDos: [
            { doNo: "2990-DO-2607-001", qty: 1, soDocNo: "2990-SO-2606-021" },
            { doNo: "2990-DO-2607-099", qty: 1, soDocNo: "2990-SO-2606-777" },
          ],
        })]}
      />,
    );
    expect(screen.getByText("2990-DO-2607-099")).toBeTruthy();
    expect(screen.getByText("2990-SO-2606-777")).toBeTruthy();
  });
});

describe("STOCK tag — no assignment means surplus stock, not missing data (2026-08-02)", () => {
  it("renders STOCK in the header cell when emptyMeans=stock", () => {
    render(<AssignedSoCell assignments={[]} emptyMeans="stock" />);
    expect(screen.getByText("STOCK")).toBeTruthy();
  });

  it("keeps the dash for sales surfaces (default)", () => {
    render(<AssignedSoCell assignments={[]} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("STOCK")).toBeNull();
  });

  it("renders STOCK on an unassigned drill line (paired mode)", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        showAssignment
        showDelivered
        lines={[line({ assignedSos: [], deliveredDos: [] })]}
      />,
    );
    expect(screen.getByText("STOCK")).toBeTruthy();
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

// ── Accessories do not list their orders on a purchase document ──────────────
//
// Owner, 2026-08-04, on a GRN line for NTYR MEMORY CONTOUR PILLOW that had grown
// eight SO/DO rows of its own: "因为我的枕头进 500 粒，然后分配的话，它整个的
// listing 会太长了 … 关于整个 accessories 它不需要显示出来，没关系的。不过，你的
// Stock Movement Control 那边一定要有这个".
//
// The list goes; the COUNTS stay. A blank assignment cell would read as "this
// stock is unassigned", and a document under-stating its own linkage is the
// ambiguity behind the duplicate-delivery incident (docs/unlinked-line-duplicate-coe.md).
describe("Accessory lines collapse their per-order list", () => {
  const eightOrders = Array.from({ length: 8 }, (_, i) => ({
    soDocNo: `2990-SO-2606-0${20 + i}`,
    deliveryDate: "2026-07-13",
    locked: true,
  }));
  const nineDos = Array.from({ length: 9 }, (_, i) => ({
    doNo: `2990-DO-2607-0${10 + i}`,
    qty: 2,
  }));

  const acc = (over = {}) =>
    line({ itemGroup: "accessory", code: "NTYR-PILLOW", assignedSos: eightOrders, deliveredDos: nineDos, ...over });

  it("shows counts instead of eight SO chips, on the paired purchase view", () => {
    render(
      <DocumentLinesExpansion isLoading={false} showAssignment showDelivered lines={[acc()]} />,
    );
    expect(screen.getByText(/8 orders/)).toBeTruthy();
    expect(screen.getByText(/9 deliveries/)).toBeTruthy();
    // Not one of the individual documents.
    expect(screen.queryByText("2990-SO-2606-020")).toBeNull();
    expect(screen.queryByText("2990-DO-2607-010")).toBeNull();
  });

  it("points at where the real trail lives", () => {
    render(
      <DocumentLinesExpansion isLoading={false} showAssignment showDelivered lines={[acc()]} />,
    );
    expect(screen.getByText(/see Stock Movement/)).toBeTruthy();
  });

  it("singularises one order and one delivery", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        showAssignment
        showDelivered
        lines={[acc({ assignedSos: eightOrders.slice(0, 1), deliveredDos: nineDos.slice(0, 1) })]}
      />,
    );
    expect(screen.getByText(/1 order · 1 delivery/)).toBeTruthy();
  });

  it("leaves a NON-accessory line listing every order, unchanged", () => {
    // The whole point is that this is an accessory-only rule. A mattress line
    // on the same GRN must still name its orders.
    render(
      <DocumentLinesExpansion
        isLoading={false}
        showAssignment
        showDelivered
        lines={[line({ itemGroup: "mattress", assignedSos: eightOrders.slice(0, 2), deliveredDos: nineDos.slice(0, 2) })]}
      />,
    );
    expect(screen.getByText("2990-SO-2606-020")).toBeTruthy();
    expect(screen.queryByText(/see Stock Movement/)).toBeNull();
  });

  it("matches the group case-insensitively", () => {
    render(
      <DocumentLinesExpansion isLoading={false} showAssignment showDelivered lines={[acc({ itemGroup: "ACCESSORY" })]} />,
    );
    expect(screen.getByText(/8 orders/)).toBeTruthy();
  });

  it("an accessory with no assignment still reads as stock, not as a blank", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        showAssignment
        showDelivered
        lines={[acc({ assignedSos: [], deliveredDos: [] })]}
      />,
    );
    expect(screen.queryByText(/see Stock Movement/)).toBeNull();
  });

  it("collapses on an assignment-only view too (no Delivered column)", () => {
    render(<DocumentLinesExpansion isLoading={false} showAssignment lines={[acc()]} />);
    expect(screen.getByText(/8 orders/)).toBeTruthy();
    expect(screen.queryByText("2990-SO-2606-020")).toBeNull();
  });
});

describe("Committed batch — the hard-from-DO anchor (mig 0230, Decision 2026-08-06)", () => {
  // The DO detail surfaces `delivery_order_items.committed_po_batch_no`: which
  // incoming PO batch a ship-before-arrival line committed to at DO creation.
  // ANCHORED identity — solid chip, never dashed, no "~" — because it is a
  // stored fact, not a floating MRP allocation.

  it("renders the anchored solid chip with the hard-from-DO tooltip when present", () => {
    const { container } = render(<CommittedBatchCell poNo="2990-PO-2607-014" />);
    const chip = screen.getByText("2990-PO-2607-014") as HTMLElement;
    expect(chip).toBeTruthy();
    // Anchored tone: solid border + surface fill + accent ink — and NOT the
    // floating dashed treatment.
    expect(chip.className).toContain("bg-surface-2");
    expect(chip.className).toContain("text-accent-ink");
    expect(chip.className).not.toContain("border-dashed");
    expect(container.textContent).not.toContain("~");
    // Tooltip states the anchor: committed at DO creation — hard from DO.
    expect(chip.title).toMatch(/committed/i);
    expect(chip.title).toMatch(/when the Delivery Order was created/i);
    expect(chip.title).toMatch(/hard from DO/);
    // The batch number renders VERBATIM (company-prefix namespacing rule).
    expect(chip.textContent).toBe("2990-PO-2607-014");
    // The cell labels itself so a bare PO chip cannot be misread as Source PO.
    expect(screen.getByText(/Committed PO/i)).toBeTruthy();
  });

  it("renders NOTHING when the line never committed (no dash clutter)", () => {
    const empty = render(<CommittedBatchCell poNo={null} />);
    expect(empty.container.firstChild).toBeNull();
    cleanup();
    const absent = render(<CommittedBatchCell />);
    expect(absent.container.firstChild).toBeNull();
  });
});
