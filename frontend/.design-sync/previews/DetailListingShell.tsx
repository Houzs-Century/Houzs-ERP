import { useEffect, useRef } from "react";
import { DetailListingShell, MemoryRouter } from "autocount-sync-frontend";
import * as DS from "autocount-sync-frontend";

// Shared L2 (Detail Listing) report shell — DO / SI / DR pages are this shell
// plus column definitions and a query hook. The hook is a PROP, so no
// react-query provider is needed: we hand it a canned UseQueryResult.
//
// BLOCKER (today): the shell calls useNotify() at mount, whose NotifyProvider
// is a bundle-internal context (src/vendor/scm/components/NotifyDialog.tsx)
// NOT re-exported from .design-sync/entry.tsx — and a source-bundled copy
// would be a different context instance, so it cannot be supplied from here.
// Fix: add `export { NotifyProvider } from '../src/vendor/scm/components/NotifyDialog';`
// to entry.tsx and rebuild — this preview then lights up automatically (the
// guard below reads the export off the bundle namespace at runtime).
//
// The shell is a full report page (filters + KPI strip + DataGrid) — far
// wider than a grid cell. Suggest cfg.overrides.DetailListingShell =
// { cardMode: "single", primaryStory: "DeliveryOrderListing" }.

const NotifyProvider = (DS as any).NotifyProvider;

// ── Canned rows: DO Detail Listing (one row per line, doc header
//    denormalised on) — balance_centi is the DOC-level balance repeated per
//    row, matching the server flatten step. ─────────────────────────────────
const ROWS = [
  {
    id: "r1", doc_no: "DO-2606-0114", line_date: "2026-06-18",
    debtor_code: "300-S0022", debtor_name: "Sunway Geo Residences — Tower B",
    item_code: "PAN-CSPU24XKH", description: "Panasonic 2.5HP X-Premium Inverter — indoor unit",
    qty: 4, unit_price_centi: 319000, total_centi: 1276000, balance_centi: 0, status: "Transferred",
  },
  {
    id: "r2", doc_no: "DO-2606-0114", line_date: "2026-06-18",
    debtor_code: "300-S0022", debtor_name: "Sunway Geo Residences — Tower B",
    item_code: "PAN-CUPU24XKH", description: "Panasonic 2.5HP X-Premium Inverter — outdoor unit",
    qty: 4, unit_price_centi: 214000, total_centi: 856000, balance_centi: 0, status: "Transferred",
  },
  {
    id: "r3", doc_no: "DO-2606-0117", line_date: "2026-06-21",
    debtor_code: "300-K0105", debtor_name: "Kiara Designer Suites Mgmt",
    item_code: "COP-16MM", description: "Copper piping 16mm insulated (per metre)",
    qty: 60, unit_price_centi: 3850, total_centi: 231000, balance_centi: 489000, status: "Partial",
  },
  {
    id: "r4", doc_no: "DO-2606-0117", line_date: "2026-06-21",
    debtor_code: "300-K0105", debtor_name: "Kiara Designer Suites Mgmt",
    item_code: "PAN-CSU10XKH", description: "Panasonic 1.0HP Standard Inverter",
    qty: 2, unit_price_centi: 129000, total_centi: 258000, balance_centi: 489000, status: "Partial",
  },
  {
    id: "r5", doc_no: "DO-2606-0121", line_date: "2026-06-24",
    debtor_code: "300-H0031", debtor_name: "Houzs Century — Ampang Showroom",
    item_code: "WM-BRKT-24", description: "Wall mount bracket set, 24k BTU",
    qty: 6, unit_price_centi: 8500, total_centi: 51000, balance_centi: 0, status: "Transferred",
  },
];

// Canned TanStack-shaped result — the shell only reads .data and .isFetching.
const useCannedDoListing = (_filters: unknown) =>
  ({
    data: { rows: ROWS },
    isFetching: false,
    isLoading: false,
    isError: false,
    error: null,
    status: "success",
    refetch: () => {},
  }) as any;

const rm = (centi: number) =>
  (centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const buildColumns = (state: {
  checked: Record<string, boolean>;
  onToggle: (id: string) => void;
}) =>
  [
    {
      key: "sel", label: "", exportLabel: "Selected", width: 36,
      accessor: (r: any) => (
        <input
          type="checkbox"
          checked={!!state.checked[r.id]}
          onChange={() => state.onToggle(r.id)}
          aria-label={`Select ${r.doc_no}`}
        />
      ),
    },
    { key: "doc_no", label: "Doc No", width: 120, accessor: (r: any) => <span className="font-mono">{r.doc_no}</span> },
    { key: "line_date", label: "Date", width: 96, accessor: (r: any) => r.line_date },
    { key: "debtor_name", label: "Debtor", width: 220, accessor: (r: any) => r.debtor_name },
    { key: "item_code", label: "Item Code", width: 130, accessor: (r: any) => <span className="font-mono">{r.item_code}</span> },
    { key: "description", label: "Description", width: 280, accessor: (r: any) => r.description },
    { key: "qty", label: "Qty", width: 60, align: "right" as const, accessor: (r: any) => r.qty },
    { key: "unit_price", label: "U/Price", width: 96, align: "right" as const, accessor: (r: any) => <span className="font-money">{rm(r.unit_price_centi)}</span> },
    { key: "total", label: "Total (RM)", width: 110, align: "right" as const, accessor: (r: any) => <span className="font-money">{rm(r.total_centi)}</span> },
    { key: "balance", label: "Balance (RM)", width: 110, align: "right" as const, accessor: (r: any) => <span className="font-money">{rm(r.balance_centi)}</span> },
    { key: "status", label: "Status", width: 100, accessor: (r: any) => r.status },
  ] as any[];

// Rows/KPIs only render after the operator presses Inquiry (internal state) —
// press it for them once the shell has mounted.
function AutoInquiry({ hostRef }: { hostRef: { current: HTMLDivElement | null } }) {
  useEffect(() => {
    const t = setTimeout(() => {
      const btn = Array.from(hostRef.current?.querySelectorAll("button") ?? []).find(
        (b) => b.textContent?.trim() === "Inquiry",
      );
      btn?.click();
    }, 50);
    return () => clearTimeout(t);
  }, [hostRef]);
  return null;
}

const Live = ({ path, autoRun }: { path: string; autoRun: boolean }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  return (
    <NotifyProvider>
      <MemoryRouter initialEntries={[path]}>
        <div ref={hostRef} className="w-full min-w-[860px]">
          {autoRun && <AutoInquiry hostRef={hostRef} />}
          <DetailListingShell
            title="Delivery Order Detail Listing"
            storageKey="ds-preview-do-detail-listing"
            docNoPlaceholder="DO-2606-0114"
            useDetailQuery={useCannedDoListing}
            buildColumns={buildColumns}
            hideKpis={{ cost: true, margin: true }}
            kpiLabels={{ revenue: "Delivered Value", outstanding: "Undelivered Balance" }}
          />
        </div>
      </MemoryRouter>
    </NotifyProvider>
  );
};

// Honest placeholder until NotifyProvider is re-exported from the entry.
const Blocked = () => (
  <div className="w-[28rem] rounded-lg border border-dashed border-border-strong bg-surface p-4 shadow-stone">
    <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-accent">
      Preview blocked · provider missing
    </div>
    <div className="mt-1 text-[13px] font-semibold text-ink">
      DetailListingShell needs NotifyProvider
    </div>
    <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
      useNotify() throws without the bundle's own NotifyProvider. Re-export it
      from .design-sync/entry.tsx (src/vendor/scm/components/NotifyDialog) and
      rebuild — this preview then renders the live report shell.
    </p>
  </div>
);

const Story = (props: { path: string; autoRun: boolean }) =>
  NotifyProvider ? <Live {...props} /> : <Blocked />;

export const DeliveryOrderListing = () => (
  <Story path="/scm/reports/do-detail-listing" autoRun />
);
export const OutstandingOnly = () => (
  <Story path="/scm/reports/do-detail-listing?outstanding=1" autoRun />
);
export const BeforeInquiry = () => (
  <Story path="/scm/reports/do-detail-listing" autoRun={false} />
);
