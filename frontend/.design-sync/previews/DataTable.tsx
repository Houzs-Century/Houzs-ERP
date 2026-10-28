import { useState } from "react";
import { DataTable, Badge } from "autocount-sync-frontend";

// The workhorse list table — every module's index page (SOs, POs, ASSR
// cases, deliveries) renders through it. Toolbar (search / export /
// columns), sortable headers, zebra rows, opt-in group-by and drill-down.
// Persists prefs per `tableId`, so each story uses a distinct id.

interface SoRow {
  doc_no: string;
  customer: string;
  date: string;
  amount: number;
  status: string;
  items: string[];
}

const SO_ROWS: SoRow[] = [
  {
    doc_no: "SO-2990-0417",
    customer: "Tan Wei Ming",
    date: "02 Jul 2026",
    amount: 6180,
    status: "Synced",
    items: ["Panasonic 2.5HP Inverter × 2", "Copper piping kit 15ft × 2"],
  },
  {
    doc_no: "SO-2990-0418",
    customer: "Puteri Homes Sdn Bhd",
    date: "03 Jul 2026",
    amount: 12450,
    status: "Pending",
    items: ["Daikin 1.0HP Wall-Mounted × 4", "Installation — Bandar Puteri"],
  },
  {
    doc_no: "SO-2990-0421",
    customer: "Lim & Sons Trading",
    date: "04 Jul 2026",
    amount: 2990,
    status: "Synced",
    items: ["Acson 1.5HP Non-Inverter × 1"],
  },
  {
    doc_no: "SO-2990-0423",
    customer: "Nurul Aina",
    date: "05 Jul 2026",
    amount: 8340,
    status: "Partial",
    items: ["Marble Dining Table 1.8m × 1", "Dining Chair (Walnut) × 6"],
  },
  {
    doc_no: "SO-2990-0425",
    customer: "Bandar Puteri Cafe",
    date: "07 Jul 2026",
    amount: 4760,
    status: "Pending",
    items: ["Midea 2.0HP Ceiling Cassette × 1"],
  },
  {
    doc_no: "SO-2990-0426",
    customer: "Wong Interior Design",
    date: "08 Jul 2026",
    amount: 21900,
    status: "Draft",
    items: ["L-Shape Sofa (Fabric, Grey) × 2", "Coffee Table Set × 2"],
  },
  {
    doc_no: "SO-2990-0428",
    customer: "Ahmad Faizal",
    date: "09 Jul 2026",
    amount: 1899,
    status: "Cancelled",
    items: ["Khind Tower Fan × 3"],
  },
];

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "error"> = {
  Synced: "success",
  Pending: "warning",
  Partial: "warning",
  Draft: "neutral",
  Cancelled: "error",
};

const rm = (n: number) =>
  `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;

function soColumns() {
  return [
    {
      key: "doc_no",
      label: "Doc No",
      width: "130px",
      className: "font-mono text-[12px]",
      render: (r: SoRow) => r.doc_no,
      getValue: (r: SoRow) => r.doc_no,
    },
    {
      key: "customer",
      label: "Customer",
      render: (r: SoRow) => r.customer,
      getValue: (r: SoRow) => r.customer,
    },
    {
      key: "date",
      label: "Doc Date",
      width: "110px",
      render: (r: SoRow) => r.date,
      getValue: (r: SoRow) => r.date,
    },
    {
      key: "amount",
      label: "Total",
      width: "120px",
      align: "right" as const,
      className: "font-money font-semibold",
      render: (r: SoRow) => rm(r.amount),
      getValue: (r: SoRow) => r.amount,
    },
    {
      key: "status",
      label: "Status",
      width: "110px",
      filterable: true,
      render: (r: SoRow) => (
        <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>
      ),
      getValue: (r: SoRow) => r.status,
    },
  ];
}

export const SalesOrders = () => {
  const [q, setQ] = useState("");
  const shown = SO_ROWS.filter((r) =>
    (r.doc_no + r.customer).toLowerCase().includes(q.toLowerCase())
  );
  return (
    <div className="w-[54rem]">
      <DataTable
        tableId="prev-so"
        caption="Sales Orders"
        exportName="sales-orders"
        columns={soColumns()}
        rows={shown}
        getRowKey={(r: SoRow) => r.doc_no}
        onRowClick={() => {}}
        search={{ value: q, onChange: setQ, placeholder: "Search doc no or customer…" }}
      />
    </div>
  );
};

export const GroupedByStatus = () => (
  <div className="w-[54rem]">
    <DataTable
      tableId="prev-so-grouped"
      caption="Sales Orders"
      columns={soColumns()}
      rows={SO_ROWS}
      getRowKey={(r: SoRow) => r.doc_no}
      groupBy={{ key: "status" }}
    />
  </div>
);

export const ExpandableRows = () => (
  <div className="w-[54rem]">
    <DataTable
      tableId="prev-so-expand"
      caption="Sales Orders"
      columns={soColumns()}
      rows={SO_ROWS.slice(0, 4)}
      getRowKey={(r: SoRow) => r.doc_no}
      expandable={{
        render: (r: SoRow) => (
          <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-ink-secondary">
            {r.items.map((it) => (
              <li key={it}>{it}</li>
            ))}
          </ul>
        ),
      }}
    />
  </div>
);

export const LoadingState = () => (
  <div className="w-[54rem]">
    <DataTable
      tableId="prev-so-loading"
      caption="Sales Orders"
      columns={soColumns()}
      rows={null}
      loading
      getRowKey={(r: SoRow) => r.doc_no}
    />
  </div>
);

export const EmptyState = () => (
  <div className="w-[54rem]">
    <DataTable
      tableId="prev-so-empty"
      caption="Sales Orders"
      columns={soColumns()}
      rows={[]}
      emptyLabel="No sales orders match the current filters"
      getRowKey={(r: SoRow) => r.doc_no}
    />
  </div>
);
