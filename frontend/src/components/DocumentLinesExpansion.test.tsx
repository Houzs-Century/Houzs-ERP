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
  amountSen: 100000,
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
        coverage="ready"
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
        coverage="ready"
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
        coverage="ready"
        showAssignment
        lines={[line({ assignedSos: mrpOnly, sourceLinked: false })]}
      />,
    );
    expect(screen.getByText("~", { exact: false })).toBeTruthy();
    expect(container.querySelector('[title*="recomputed on every view"]')).toBeTruthy();
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

// ── Three chip identities (Decision, docs/modules/purchase-order.md 2026-08-06) ──
//
// "Soft until DO, hard from DO": only a delivered chip may dress as execution.
// A stored PO→SO link is procurement provenance — muted, "bought for", never
// the word "Locked" — and an MRP allocation is floating: dashed, live,
// recomputed on every view. These pins keep provenance from re-hardening into
// execution on any surface.
describe("Three chip identities — anchored / provenance / floating", () => {
  const anchored = { soDocNo: "SO-ANCH", deliveryDate: null, locked: true, source: "delivered" as const };
  const provenance = { soDocNo: "SO-PROV", deliveryDate: null, locked: true, source: "linked" as const };
  const floating = { soDocNo: "SO-FLOT", deliveryDate: null, locked: false, source: "mrp" as const };

  const chipFor = (container: HTMLElement, soDocNo: string): HTMLElement => {
    const hit = Array.from(container.querySelectorAll<HTMLElement>("[title]")).find((el) =>
      el.textContent?.includes(soDocNo),
    );
    if (!hit) throw new Error(`no chip for ${soDocNo}`);
    return hit;
  };

  it("renders the three treatments distinctly in the header cell", () => {
    const { container } = render(
      <AssignedSoCell assignments={[anchored, provenance, floating]} sourceLinked />,
    );
    const a = chipFor(container, "SO-ANCH");
    const p = chipFor(container, "SO-PROV");
    const f = chipFor(container, "SO-FLOT");
    // Anchored: solid accent tone, delivered wording — unchanged.
    expect(a.className).toContain("bg-surface-2");
    expect(a.className).not.toContain("border-dashed");
    expect(a.title).toContain("Delivered");
    // Provenance: muted tone, "bought for", and NEVER the word "Locked".
    expect(p.className).toContain("bg-surface-dim");
    expect(p.className).not.toContain("border-dashed");
    expect(p.title).toContain("Bought for SO-PROV");
    expect(p.title).toContain("procurement provenance, not the live assignment");
    expect(p.title).not.toMatch(/locked/i);
    // Floating: dashed border + the live-recompute warning.
    expect(f.className).toContain("border-dashed");
    expect(f.title).toContain("recomputed on every view");
    // The three tones are pairwise distinct.
    expect(a.className).not.toBe(p.className);
    expect(p.className).not.toBe(f.className);
    expect(f.className).not.toBe(a.className);
  });

  it("applies the same treatments in the drill-down assignment cell", () => {
    const { container } = render(
      <DocumentLinesExpansion
        isLoading={false}
        coverage="ready"
        showAssignment
        lines={[line({ assignedSos: [anchored, provenance, floating], sourceLinked: true })]}
      />,
    );
    expect(chipFor(container, "SO-ANCH").className).toContain("bg-surface-2");
    const p = chipFor(container, "SO-PROV");
    expect(p.className).toContain("bg-surface-dim");
    expect(p.title).toContain("procurement provenance");
    expect(p.title).not.toMatch(/locked/i);
    const f = chipFor(container, "SO-FLOT");
    expect(f.className).toContain("border-dashed");
    // Only the floating chip carries the "~" marker.
    expect(f.textContent).toContain("~");
    expect(p.textContent).not.toContain("~");
  });

  it("keeps the identities in the paired per-SO sub-table", () => {
    const { container } = render(
      <DocumentLinesExpansion
        isLoading={false}
        coverage="ready"
        showAssignment
        showDelivered
        lines={[line({ assignedSos: [provenance, floating], deliveredDos: [] })]}
      />,
    );
    const p = chipFor(container, "SO-PROV");
    expect(p.className).toContain("bg-surface-dim");
    expect(p.title).toContain("Bought for SO-PROV");
    expect(chipFor(container, "SO-FLOT").className).toContain("border-dashed");
  });

  it("a stored link without source metadata degrades to provenance, not execution", () => {
    // Older/cached payloads carry locked:true with no `source`. Reading that as
    // anchored would re-dress provenance as execution — the exact confusion the
    // Decision retires.
    const { container } = render(
      <AssignedSoCell assignments={[{ soDocNo: "SO-OLD", deliveryDate: null, locked: true }]} />,
    );
    const c = chipFor(container, "SO-OLD");
    expect(c.className).toContain("bg-surface-dim");
    expect(c.title).not.toMatch(/locked/i);
  });
});

// ── PR-3: the coverage wire's PARALLEL provenance slot, rendered side by side ──
//
// The wire now carries `provenance` (layer-b stored-origin SOs) beside the
// precedence winner in `assignments`. Rendering rule: AFTER the precedence
// chips, ALSO render muted "bought for" chips for provenance SOs not already
// shown (dedupe by soDocNo). The case this exists for: the floating allocator
// re-assigned (dashed chips) while the stored links remain — after an SO
// amendment both truths must be visible. Additive and optional: no provenance
// field → exactly the pre-PR-3 rendering.
describe("Provenance slot beside execution (PR-3)", () => {
  const floating = { soDocNo: "SO-FLOT", deliveryDate: null, locked: false, source: "mrp" as const };
  const bought = { soDocNo: "SO-PROV", deliveryDate: "2026-09-01", locked: true, source: "linked" as const };

  const chipFor = (container: HTMLElement, soDocNo: string): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>("[title]")).filter((el) =>
      el.textContent?.includes(soDocNo),
    );

  it("floating won + provenance present: both chip kinds render in the drill-down cell", () => {
    const { container } = render(
      <DocumentLinesExpansion
        isLoading={false}
        coverage="ready"
        showAssignment
        lines={[line({ assignedSos: [floating], provenance: [bought] })]}
      />,
    );
    const f = chipFor(container, "SO-FLOT");
    expect(f).toHaveLength(1);
    expect(f[0].className).toContain("border-dashed");
    expect(f[0].textContent).toContain("~");
    const p = chipFor(container, "SO-PROV");
    expect(p).toHaveLength(1);
    expect(p[0].className).toContain("bg-surface-dim");
    expect(p[0].title).toContain("Bought for SO-PROV");
    expect(p[0].title).toContain("procurement provenance, not the live assignment");
    expect(p[0].title).not.toMatch(/locked/i);
    expect(p[0].textContent).not.toContain("~");
  });

  it("renders both truths in the paired per-SO sub-table, without an execution status on the provenance row", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        coverage="ready"
        showAssignment
        showDelivered
        lines={[line({ assignedSos: [floating], deliveredDos: [], provenance: [bought] })]}
      />,
    );
    expect(screen.getByText("SO-FLOT")).toBeTruthy();
    expect(screen.getByText("SO-PROV")).toBeTruthy();
    // Exactly ONE status pill — the floating assignment's PENDING. Provenance
    // is not the live assignment, so it carries no DELIVERED/PENDING verdict.
    expect(screen.getAllByText(/DELIVERED|PENDING/)).toHaveLength(1);
  });

  it("renders both slots in the header AssignedSoCell", () => {
    const { container } = render(
      <AssignedSoCell assignments={[floating]} provenance={[bought]} />,
    );
    expect(chipFor(container, "SO-FLOT")[0].className).toContain("border-dashed");
    const p = chipFor(container, "SO-PROV");
    expect(p).toHaveLength(1);
    expect(p[0].className).toContain("bg-surface-dim");
    expect(p[0].title).toContain("Bought for SO-PROV");
  });

  it("stored origin won: the slots are identical and NOTHING extra renders (dedupe by soDocNo)", () => {
    const stored = { soDocNo: "SO-SAME", deliveryDate: null, locked: true, source: "linked" as const };
    const { container } = render(
      <DocumentLinesExpansion
        isLoading={false}
        coverage="ready"
        showAssignment
        lines={[line({ assignedSos: [stored], provenance: [stored] })]}
      />,
    );
    expect(chipFor(container, "SO-SAME")).toHaveLength(1);
  });

  it("no provenance field (older backend): exactly today's rendering", () => {
    const { container } = render(
      <DocumentLinesExpansion
        isLoading={false}
        coverage="ready"
        showAssignment
        lines={[line({ assignedSos: [floating] })]}
      />,
    );
    // One chip, dashed — and no muted provenance chip anywhere.
    expect(container.querySelectorAll("[title]")).toHaveLength(1);
    expect(container.querySelector('[title*="Bought for"]')).toBeNull();
  });

  it("provenance chips never flip to the no-stored-link wording even when the line's sourceLinked is false", () => {
    // sourceLinked=false describes the ASSIGNMENT slot (an MRP guess with no
    // link behind it). The provenance chip exists precisely BECAUSE a stored
    // origin names it — it must keep the "bought for" words.
    const { container } = render(
      <DocumentLinesExpansion
        isLoading={false}
        coverage="ready"
        showAssignment
        lines={[line({ assignedSos: [floating], sourceLinked: false, provenance: [bought] })]}
      />,
    );
    const p = chipFor(container, "SO-PROV");
    expect(p[0].title).toContain("Bought for SO-PROV");
    expect(p[0].title).not.toContain("no stored link");
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
        coverage="ready"
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
        coverage="ready"
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
        coverage="ready"
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
        coverage="ready"
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
      <DocumentLinesExpansion isLoading={false}
        coverage="ready" showAssignment showDelivered lines={[acc()]} />,
    );
    expect(screen.getByText(/8 orders/)).toBeTruthy();
    expect(screen.getByText(/9 deliveries/)).toBeTruthy();
    // Not one of the individual documents.
    expect(screen.queryByText("2990-SO-2606-020")).toBeNull();
    expect(screen.queryByText("2990-DO-2607-010")).toBeNull();
  });

  it("points at where the real trail lives", () => {
    render(
      <DocumentLinesExpansion isLoading={false}
        coverage="ready" showAssignment showDelivered lines={[acc()]} />,
    );
    expect(screen.getByText(/see Stock Movement/)).toBeTruthy();
  });

  it("singularises one order and one delivery", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        coverage="ready"
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
        coverage="ready"
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
      <DocumentLinesExpansion isLoading={false}
        coverage="ready" showAssignment showDelivered lines={[acc({ itemGroup: "ACCESSORY" })]} />,
    );
    expect(screen.getByText(/8 orders/)).toBeTruthy();
  });

  it("an accessory with no assignment still reads as stock, not as a blank", () => {
    render(
      <DocumentLinesExpansion
        isLoading={false}
        coverage="ready"
        showAssignment
        showDelivered
        lines={[acc({ assignedSos: [], deliveredDos: [] })]}
      />,
    );
    expect(screen.queryByText(/see Stock Movement/)).toBeNull();
  });

  it("collapses on an assignment-only view too (no Delivered column)", () => {
    render(<DocumentLinesExpansion isLoading={false}
        coverage="ready" showAssignment lines={[acc()]} />);
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
