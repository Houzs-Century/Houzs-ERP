/* What a column means, shown when its header is hovered (owner 2026-09-27).
   One file, keyed by table id then column key, so the wording can be read and
   corrected in one place. Only columns a reader could misread belong here; a
   column's own `description` (Column.description) wins over this list. Each
   line states what the code computes, not what the column is hoped to mean. */

const PO_ASSIGNED_SO =
  "The Sales Order(s) this purchase is for. A dashed ~ chip is an MRP guess, not a stored link.";
const SOURCE_PO =
  "The Purchase Order the goods came from. STOCK ADJ: the goods entered through a stock adjustment, not a PO.";
const FAIR_MARGIN = "(Revenue − cost) ÷ revenue.";

const DESCRIPTIONS: Partial<Record<string, Record<string, string>>> = {
  "sales-orders-v2": {
    doc_no: "The AutoCount document number when the order came from AutoCount, otherwise the ERP number.",
    erp_doc_no: "The ERP's own document number.",
    status: "Document status, with delivery progress: Partially Delivered, Delivered, Invoiced, Delivery Return; (On Hold) when held.",
    paid: "Total of the payments recorded on this order.",
    balance: "Order total minus payments received. Amber: delivered in full but still owing. Red: more was collected than the total.",
    deposit_sen: "The deposit amount recorded on the order.",
    customer_delivery_date: "The customer's delivery date. Red: passed and not yet delivered.",
  },
  "sales-invoices-v2": {
    due_date: "Payment due date. Red: passed and not paid.",
    outstanding: "Total minus payments, minus the deposit already paid on the Sales Order.",
    so_deposit: "The deposit paid on the source Sales Order, counted against this invoice.",
    paid: "Payments recorded on this invoice.",
    source_pos: SOURCE_PO,
    total_cost_sen: "Cost of the goods on this invoice.",
    total_margin_sen: "Invoice total minus Total Cost.",
    margin_pct_basis: "Margin ÷ invoice total.",
  },
  "purchase-invoices-v2": {
    due_date: "Payment due date. Red: passed with money still owed.",
    outstanding: "Total minus payments made. Cleared when fully paid.",
    vs_po: "How this invoice's prices compare with the Purchase Order's.",
    local_total: "Total converted to ringgit at the invoice's exchange rate.",
    assigned_so: PO_ASSIGNED_SO,
    delivered: "Delivery Orders that shipped the goods of this invoice's Purchase Order, with quantity.",
  },
  "purchase-orders-v2": {
    expected: "Expected arrival date. Red: passed while goods are still to come.",
    assigned_so: PO_ASSIGNED_SO,
    delivered: "Delivery Orders that shipped this Purchase Order's goods, with quantity.",
  },
  "delivery-orders-v2": {
    do_date: "The document date. For a DO from AutoCount this is AutoCount's DocDate.",
    delivery_date: "The date the customer wants the goods delivered.",
    source_pos: SOURCE_PO,
    invoiced_si_nos: "The Sales Invoice(s) this DO was billed on.",
  },
  "fair-report-so": {
    soCost: "Cost estimated when the order was placed.",
    margin: FAIR_MARGIN,
    balance: "Amount not yet paid.",
    pending: "Has paid no more than the deposit and still owes money.",
  },
  "fair-report-do": {
    soCost: "Cost estimated when the order was placed.",
    doCost: "Cost frozen at delivery (FIFO). Legacy: delivered before FIFO costing.",
    delta: "DO cost minus SO cost. Positive: the cost rose by delivery.",
    drift: "DO margin minus SO margin, in percentage points.",
  },
  "fair-report-pnl": {
    soCost: "Cost estimated when the order was placed.",
    doCost: "Cost frozen at delivery (FIFO).",
    siCost: "Landed cost once the supplier invoice is in.",
    cogs: "The most advanced cost available: SI cost, else DO cost, else SO cost. The tag says which.",
    gross: "Revenue minus COGS.",
    margin: FAIR_MARGIN,
  },
  "fair-report-invoice": {
    siCost: "Landed cost once the supplier invoice is in.",
    margin: FAIR_MARGIN,
  },
};

export function columnDescription(tableId: string | undefined, key: string): string | undefined {
  return tableId ? DESCRIPTIONS[tableId]?.[key] : undefined;
}
