import { ColumnsPanel } from "autocount-sync-frontend";

// Right-side columns drawer used by every DataTable list page (show/hide,
// drag-reorder). It renders through a portal as a FIXED inset-y-0 right-0
// z-50 sheet, so it escapes the grid card — pin with
// cfg.overrides.ColumnsPanel = { cardMode: "single", primaryStory: "SalesOrderColumns" }.
//
// The optional Custom Fields (UDF) section is NOT composed here: its
// CustomFieldsSection calls useDialog()/useToast(), whose DialogProvider /
// ToastProvider are bundle-internal contexts not re-exported from the entry —
// providing `udf` would throw at mount. Columns-only is the common state.

const SO_COLUMNS = [
  { key: "doc_no", label: "SO Number" },
  { key: "doc_date", label: "Order Date" },
  { key: "customer", label: "Customer" },
  { key: "salesperson", label: "Salesperson" },
  { key: "status", label: "Status" },
  { key: "warehouse", label: "Warehouse" },
  { key: "total", label: "Total (RM)" },
  { key: "balance", label: "Outstanding (RM)" },
  { key: "delivery_date", label: "Delivery Date" },
];

const PO_COLUMNS = [
  { key: "po_no", label: "PO Number" },
  { key: "supplier", label: "Supplier" },
  { key: "eta", label: "ETA" },
  { key: "status", label: "Status" },
  { key: "total", label: "Total (RM)" },
];

export const SalesOrderColumns = () => (
  <ColumnsPanel
    open
    onClose={() => {}}
    options={SO_COLUMNS}
    hidden={new Set(["warehouse", "balance"])}
    onToggle={() => {}}
    onResetVisibility={() => {}}
    onReorder={() => {}}
    onResetOrder={() => {}}
  />
);

export const AllVisible = () => (
  <ColumnsPanel
    open
    onClose={() => {}}
    options={PO_COLUMNS}
    hidden={new Set()}
    onToggle={() => {}}
    onResetVisibility={() => {}}
    onReorder={() => {}}
    onResetOrder={() => {}}
  />
);
