/* ----------------------------------------------------------------------------
   What a row may print — and, far more importantly, what it may NOT.

   WHAT THIS FILE IS FOR. The owner asked to print any document in a row's chain
   without leaving the list (2026-08-22). A chain entry is only honest when THREE
   things hold, and each of them reads correct while being wrong:

     1. The document must be FETCHABLE. A PDF is loaded by ADDRESS
        (`/delivery-orders-mfg/:id` is `.eq('id', id)`), and several rows carry a
        related document's NUMBER and no id. An entry built from one of those is
        a menu line that 404s — worse than a line that is not there.
     2. EVERY related document must be listed. A part-delivered order has three
        delivery orders; offering the first is the failure the DO No. column was
        built to avoid, and it is invisible in any screenshot with one delivery.
     3. A CAP must say what it hid. A silent truncation reads as "that's all of
        them", which is the same lie as (2) wearing a limit.

   So the assertions below are on the exact target list and the exact labels.
   Every one of them goes RED if its guard is deleted — checked by deleting each
   one, not by assuming.
   ---------------------------------------------------------------------------- */

import { describe, expect, test } from "vitest";
import {
  PRINT_CHAIN_MAX,
  printChainLabel,
  printChainOverflowLabel,
  salesOrderPrintChain,
  deliveryOrderPrintChain,
  salesInvoicePrintChain,
  deliveryReturnPrintChain,
  purchaseOrderPrintChain,
  grnPrintChain,
  purchaseInvoicePrintChain,
  purchaseReturnPrintChain,
  type PrintChain,
} from "./printChain";

/* What the operator would actually see in the menu, in order. `own` first,
   because that is the "Print" entry every list already had. */
const menuLabels = (c: PrintChain): string[] => [
  "Print",
  ...c.related.map(printChainLabel),
  ...c.hidden.map(printChainOverflowLabel),
];

describe("a related document with no ADDRESS builds no entry", () => {
  /* This is the crux. Each of these rows KNOWS a related document exists — it
     carries its number — and cannot fetch it. The menu must be silent, not
     hopeful. */

  test("a Sales Order whose delivery orders arrive as numbers only offers no DO print", () => {
    const chain = salesOrderPrintChain({
      doc_no: "HC-SO-2608-001",
      // The shape an older Worker sends: do_nos exists, do_refs does not.
      do_refs: null,
    });
    expect(menuLabels(chain)).toEqual(["Print"]);
  });

  test("a ref carrying a number but a null id is dropped, not rendered", () => {
    const chain = salesOrderPrintChain({
      doc_no: "HC-SO-2608-001",
      do_refs: [
        { id: "", docNo: "HC-DO-2608-003" },
        { id: "do-uuid-2", docNo: "HC-DO-2608-004" },
      ],
    });
    expect(menuLabels(chain)).toEqual(["Print", "Print Delivery Order HC-DO-2608-004"]);
  });

  test("the PO list's PRE-2026-07-31 bare-string GRN chip builds no entry", () => {
    /* `suppliers-queries.ts` documents why both wire shapes reach a live page:
       the SPA and the Worker deploy independently. A bare string is a number
       with no address. */
    const chain = purchaseOrderPrintChain({
      id: "po-uuid",
      po_number: "HC-PO-2608-010",
      transfer_to_grns: ["HC-GRN-2608-002", { id: "grn-uuid", grnNumber: "HC-GRN-2608-003" }],
    });
    expect(menuLabels(chain)).toEqual(["Print", "Print Goods Received HC-GRN-2608-003"]);
  });

  test("a Sales Invoice with a DO number but no delivery_order_id offers no DO print", () => {
    const chain = salesInvoicePrintChain({
      id: "si-uuid",
      invoice_number: "HC-SI-2608-007",
      delivery_order_id: null,
      do_number: "HC-DO-2608-003",
    });
    expect(menuLabels(chain)).toEqual(["Print"]);
  });
});

describe("one-to-many is listed, never collapsed to the first", () => {
  const threeDos = [
    { id: "do-1", docNo: "HC-DO-2608-003" },
    { id: "do-2", docNo: "HC-DO-2608-004" },
    { id: "do-3", docNo: "HC-DO-2608-009" },
  ];

  test("a part-delivered Sales Order offers EVERY delivery order", () => {
    const chain = salesOrderPrintChain({ doc_no: "HC-SO-2608-001", do_refs: threeDos });
    expect(menuLabels(chain)).toEqual([
      "Print",
      "Print Delivery Order HC-DO-2608-003",
      "Print Delivery Order HC-DO-2608-004",
      "Print Delivery Order HC-DO-2608-009",
    ]);
  });

  test("each entry addresses ITS OWN document, not the first one's", () => {
    const chain = salesOrderPrintChain({ doc_no: "HC-SO-2608-001", do_refs: threeDos });
    expect(chain.related.map((t) => t.key)).toEqual(["do-1", "do-2", "do-3"]);
  });

  test("past the cap the remainder is ONE entry that says how many are hidden", () => {
    const many = Array.from({ length: PRINT_CHAIN_MAX + 3 }, (_, i) => ({
      id: `do-${i}`,
      docNo: `HC-DO-2608-${String(i).padStart(3, "0")}`,
    }));
    const chain = salesOrderPrintChain({ doc_no: "HC-SO-2608-001", do_refs: many });
    expect(chain.related).toHaveLength(PRINT_CHAIN_MAX);
    // The COUNT is the point: a cap the reader cannot see is a truncation.
    expect(chain.hidden).toEqual([{ doc: "do", count: 3 }]);
    expect(menuLabels(chain).at(-1)).toBe("+3 more Delivery Order — Open to print");
  });

  test("exactly at the cap nothing is hidden and no overflow entry appears", () => {
    const exact = Array.from({ length: PRINT_CHAIN_MAX }, (_, i) => ({ id: `do-${i}`, docNo: `DO-${i}` }));
    const chain = salesOrderPrintChain({ doc_no: "SO-1", do_refs: exact });
    expect(chain.hidden).toEqual([]);
    expect(menuLabels(chain)).toHaveLength(1 + PRINT_CHAIN_MAX);
  });

  test("an unaddressable ref does not consume one of the cap's slots", () => {
    /* Filtering AFTER the cap would let five numbers with no id push five real
       documents out of the menu — the row would print nothing and look full. */
    const refs = [
      ...Array.from({ length: PRINT_CHAIN_MAX }, (_, i) => ({ id: "", docNo: `GHOST-${i}` })),
      { id: "do-real", docNo: "HC-DO-2608-050" },
    ];
    const chain = salesOrderPrintChain({ doc_no: "SO-1", do_refs: refs });
    expect(menuLabels(chain)).toEqual(["Print", "Print Delivery Order HC-DO-2608-050"]);
  });
});

describe("the ADDRESS a target carries is the one its own endpoint takes", () => {
  /* A Sales Order is fetched by NUMBER and everything else by UUID. Swapping
     them compiles, reads fine, and 404s at the printer. */

  test("a Sales Order target is keyed by its document number", () => {
    const chain = salesOrderPrintChain({ doc_no: "HC-SO-2608-001" });
    expect(chain.own).toEqual({ doc: "so", docNo: "HC-SO-2608-001", key: "HC-SO-2608-001" });
  });

  test("a Delivery Order target is keyed by its uuid, and NAMED by its number", () => {
    const chain = deliveryOrderPrintChain({ id: "do-uuid", do_number: "HC-DO-2608-003" });
    expect(chain.own).toEqual({ doc: "do", docNo: "HC-DO-2608-003", key: "do-uuid" });
  });

  test("an upstream Sales Order reached from a Delivery Order is keyed by its number", () => {
    const chain = deliveryOrderPrintChain({
      id: "do-uuid", do_number: "HC-DO-2608-003", so_doc_no: "HC-SO-2608-001",
    });
    expect(chain.related).toEqual([
      { doc: "so", docNo: "HC-SO-2608-001", key: "HC-SO-2608-001" },
    ]);
  });
});

describe("an MRP allocation is a guess, and a guess is not a document link", () => {
  /* `OriginAssignment.source` distinguishes a STORED link from a live MRP
     projection. Reading one as a binding is the 2026-07-29 incident, so only
     'linked' and 'delivered' become entries — and a row from a backend that
     does not send `source` at all becomes none, which is the stricter way to be
     wrong. */

  test("an mrp-sourced assigned SO builds no entry", () => {
    const chain = purchaseOrderPrintChain({
      id: "po-uuid", po_number: "HC-PO-2608-010",
      assigned_sos: [{ soDocNo: "HC-SO-2608-001", source: "mrp" }],
    });
    expect(menuLabels(chain)).toEqual(["Print"]);
  });

  test("an assigned SO with NO source at all builds no entry", () => {
    const chain = grnPrintChain({
      id: "grn-uuid", grn_number: "HC-GRN-2608-003",
      assigned_sos: [{ soDocNo: "HC-SO-2608-001" }],
    });
    expect(menuLabels(chain)).toEqual(["Print"]);
  });

  test("a stored link and a delivered fact both DO build one", () => {
    const chain = grnPrintChain({
      id: "grn-uuid", grn_number: "HC-GRN-2608-003",
      assigned_sos: [
        { soDocNo: "HC-SO-2608-001", source: "linked" },
        { soDocNo: "HC-SO-2608-002", source: "delivered" },
        { soDocNo: "HC-SO-2608-003", source: "mrp" },
      ],
    });
    expect(menuLabels(chain)).toEqual([
      "Print",
      "Print Sales Order HC-SO-2608-001",
      "Print Sales Order HC-SO-2608-002",
    ]);
  });

  test("one Sales Order named twice is offered once", () => {
    const chain = grnPrintChain({
      id: "grn-uuid", grn_number: "HC-GRN-2608-003",
      assigned_sos: [
        { soDocNo: "HC-SO-2608-001", source: "linked" },
        { soDocNo: "HC-SO-2608-001", source: "delivered" },
      ],
    });
    expect(menuLabels(chain)).toEqual(["Print", "Print Sales Order HC-SO-2608-001"]);
  });
});

describe("the words are TRANSFER_DOC's, not a thirteenth spelling", () => {
  /* The repo has already paid for hand-written document names — five spellings
     of one lineage column header (transfer-vocabulary.ts). These assertions are
     on the FULL names, so an abbreviation in a label fails here. */
  test.each([
    ["so", "Print Sales Order X-1"],
    ["do", "Print Delivery Order X-1"],
    ["si", "Print Sales Invoice X-1"],
    ["dr", "Print Delivery Return X-1"],
    ["po", "Print Purchase Order X-1"],
    ["grn", "Print Goods Received X-1"],
    ["pi", "Print Purchase Invoice X-1"],
    ["pr", "Print Purchase Return X-1"],
  ] as const)("%s is labelled %s", (doc, expected) => {
    expect(printChainLabel({ doc, docNo: "X-1", key: "k" })).toBe(expected);
  });
});

describe("every list's chain, from the fields its rows actually carry", () => {
  test("Sales Order: its delivery orders and its sales invoices", () => {
    const chain = salesOrderPrintChain({
      doc_no: "HC-SO-2608-001",
      do_refs: [{ id: "do-1", docNo: "HC-DO-2608-003" }],
      si_refs: [{ id: "si-1", docNo: "HC-SI-2608-007" }],
    });
    expect(menuLabels(chain)).toEqual([
      "Print",
      "Print Delivery Order HC-DO-2608-003",
      "Print Sales Invoice HC-SI-2608-007",
    ]);
  });

  /* Its Sales Order and nothing downstream: the DO list payload carries its
     invoices and returns as NUMBERS with no id, and that gap is recorded rather
     than papered over — see the comment on DoChainRow and §8b. */
  test("Delivery Order: its Sales Order, and no downstream entry it cannot fetch", () => {
    const chain = deliveryOrderPrintChain({
      id: "do-1", do_number: "HC-DO-2608-003", so_doc_no: "HC-SO-2608-001",
    });
    expect(menuLabels(chain)).toEqual(["Print", "Print Sales Order HC-SO-2608-001"]);
  });

  test("Sales Invoice: its Sales Order and the Delivery Order it was raised from", () => {
    const chain = salesInvoicePrintChain({
      id: "si-1", invoice_number: "HC-SI-2608-007",
      so_doc_no: "HC-SO-2608-001", delivery_order_id: "do-1", do_number: "HC-DO-2608-003",
    });
    expect(menuLabels(chain)).toEqual([
      "Print",
      "Print Sales Order HC-SO-2608-001",
      "Print Delivery Order HC-DO-2608-003",
    ]);
  });

  test("Delivery Return: its Sales Order and its Delivery Order", () => {
    const chain = deliveryReturnPrintChain({
      id: "dr-1", return_number: "HC-DR-2608-002",
      so_doc_no: "HC-SO-2608-001", delivery_order_id: "do-1", do_doc_no: "HC-DO-2608-003",
    });
    expect(menuLabels(chain)).toEqual([
      "Print",
      "Print Sales Order HC-SO-2608-001",
      "Print Delivery Order HC-DO-2608-003",
    ]);
  });

  test("Purchase Order: the SOs it is bound to, and the GRNs it was received into", () => {
    const chain = purchaseOrderPrintChain({
      id: "po-1", po_number: "HC-PO-2608-010",
      assigned_sos: [{ soDocNo: "HC-SO-2608-001", source: "linked" }],
      transfer_to_grns: [{ id: "grn-1", grnNumber: "HC-GRN-2608-003" }],
    });
    expect(menuLabels(chain)).toEqual([
      "Print",
      "Print Sales Order HC-SO-2608-001",
      "Print Goods Received HC-GRN-2608-003",
    ]);
  });

  test("GRN: its Purchase Order", () => {
    const chain = grnPrintChain({
      id: "grn-1", grn_number: "HC-GRN-2608-003",
      purchase_order: { id: "po-1", po_number: "HC-PO-2608-010" },
    });
    expect(menuLabels(chain)).toEqual(["Print", "Print Purchase Order HC-PO-2608-010"]);
  });

  test("Purchase Invoice: its Purchase Order and its GRN", () => {
    const chain = purchaseInvoicePrintChain({
      id: "pi-1", invoice_number: "HC-PI-2608-004",
      purchase_order: { id: "po-1", po_number: "HC-PO-2608-010" },
      grn: { id: "grn-1", grn_number: "HC-GRN-2608-003" },
    });
    expect(menuLabels(chain)).toEqual([
      "Print",
      "Print Purchase Order HC-PO-2608-010",
      "Print Goods Received HC-GRN-2608-003",
    ]);
  });

  test("Purchase Return: its Purchase Order and its GRN", () => {
    const chain = purchaseReturnPrintChain({
      id: "pr-1", return_number: "HC-PR-2608-001",
      purchase_order: { id: "po-1", po_number: "HC-PO-2608-010" },
      grn: { id: "grn-1", grn_number: "HC-GRN-2608-003" },
    });
    expect(menuLabels(chain)).toEqual([
      "Print",
      "Print Purchase Order HC-PO-2608-010",
      "Print Goods Received HC-GRN-2608-003",
    ]);
  });

  test("a row with nothing around it offers exactly one entry, and it is 'Print'", () => {
    // The stray-separator case: an empty chain must not produce an empty group.
    expect(menuLabels(purchaseReturnPrintChain({ id: "pr-1", return_number: "HC-PR-2608-001" })))
      .toEqual(["Print"]);
  });
});
