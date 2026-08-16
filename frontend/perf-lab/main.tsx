import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DataTable, type Column } from "../src/components/DataTable";
import { MobileVirtualList } from "../src/mobile/MobileVirtualList";
import { AutoCountSync } from "../src/pages/AutoCountSync";
import { MobileAutoCountSync } from "../src/mobile/MobileAutoCountSync";
import type { AcOutboxResponse, AcOutboxRow } from "../src/lib/autocountOutbox";
import {
  DataGrid,
  type DataGridColumn,
} from "../src/vendor/scm/components/DataGrid";
import "../src/vendor/design-system/tokens.css";
import "../src/index.css";
import "./perf-lab.css";

type Row = { id: number; name: string; detail: string };

const ROWS: Row[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: index + 1,
  name: `Order ${String(index + 1).padStart(5, "0")}`,
  detail: index % 2 === 0
    ? `Short detail ${index + 1}`
    : `Long detail ${index + 1}: two deterministic lines exercise variable-height card geometry.`,
}));

const dataTableColumns: Column<Row>[] = [
  { key: "name", label: "Order", getValue: (row) => row.name, render: (row) => row.name },
  { key: "detail", label: "Detail", getValue: (row) => row.detail, render: (row) => row.detail },
];

const dataGridColumns: DataGridColumn<Row>[] = [
  { key: "name", label: "Order", accessor: (row) => row.name, searchValue: (row) => row.name },
  { key: "detail", label: "Detail", accessor: (row) => row.detail, searchValue: (row) => row.detail },
];

function DataTableLab({ mobile = false }: { mobile?: boolean }) {
  return (
    <main data-scenario={mobile ? "data-table-mobile" : "data-table-desktop"}>
      <DataTable
        tableId={`perf-data-table-${mobile ? "mobile" : "desktop"}`}
        rows={ROWS}
        columns={dataTableColumns}
        getRowKey={(row) => row.id}
        mobileCard={{ primary: "name", cells: ["detail"] }}
      />
    </main>
  );
}

function DataGridLab() {
  return (
    <main data-scenario="data-grid">
      <DataGrid
        rows={ROWS}
        columns={dataGridColumns}
        storageKey="perf-data-grid"
        rowKey={(row) => String(row.id)}
      />
    </main>
  );
}

function MobileVirtualListLab() {
  return (
    <main data-scenario="mobile-virtual-list">
      <MobileVirtualList
        items={ROWS}
        getKey={(row) => row.id}
        estimateHeight={114}
        renderItem={(row, index) => (
          <article className={index % 2 === 0 ? "lab-card lab-card-short" : "lab-card lab-card-tall"}>
            <strong>{row.name}</strong>
            <p>{row.detail}</p>
          </article>
        )}
      />
    </main>
  );
}

const SEARCH_ROWS: Row[] = [
  { id: 1, name: "A only result", detail: "matches A, not A1" },
  { id: 2, name: "A1 exact result", detail: "matches A1" },
  { id: 3, name: "B result", detail: "matches B" },
];

function SearchLab() {
  const [query, setQuery] = useState("A");
  const [resultQuery, setResultQuery] = useState("A");
  const [searching, setSearching] = useState(false);

  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    setSearching(true);
  }, []);

  // The lab owns only the controlled-page boundary: new input becomes pending
  // immediately, and the test settles it explicitly like a server response.
  // Request cancellation/race ordering stays covered by the production hooks'
  // Vitest suites; this browser contract proves DataTable never relabels the
  // previous settled rows while their replacement is pending.
  const settleSearch = useCallback(() => {
    setResultQuery(query);
    setSearching(false);
  }, [query]);

  const rows = useMemo(() => {
    const normalized = resultQuery.trim().toLowerCase();
    if (normalized === "a1") return SEARCH_ROWS.filter((row) => row.name.startsWith("A1"));
    if (normalized === "a") return SEARCH_ROWS.filter((row) => row.name.startsWith("A"));
    return SEARCH_ROWS.filter((row) => row.name.toLowerCase().includes(normalized));
  }, [resultQuery]);

  return (
    <main
      data-scenario="search"
      data-query={query}
      data-result-query={resultQuery}
      data-searching={String(searching)}
    >
      <DataTable
        tableId="perf-search"
        rows={rows}
        columns={dataTableColumns}
        getRowKey={(row) => row.id}
        search={{
          value: query,
          onChange: changeQuery,
          debounceMs: 0,
          searching,
          scope: "server",
          totalRecords: rows.length,
        }}
      />
      <button type="button" data-settle-search onClick={settleSearch}>Settle search</button>
    </main>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// AutoCount Sync at the size the owner asked about — "如果我有一千个 sales order
// 的时候，我不是完蛋？" This is the only harness in the repo that answers that
// with a NUMBER: the real page, the real rows, at a real row count, in a real
// browser. `?scenario=autocount-sync&rows=400` renders the desktop page;
// `&surface=mobile` renders the phone twin. Measure with
//   document.querySelectorAll("[data-ac-row]")[i].getBoundingClientRect().height
//
// The network is stubbed at `fetch` rather than by aliasing the api client:
// everything above fetch — the cache, the headers, the error path — is then the
// REAL code, so a row height measured here is a row height the app produces.
const AC_ROWS = Number(new URLSearchParams(window.location.search).get("rows") ?? 400);

function acRows(total: number): AcOutboxRow[] {
  return Array.from({ length: total }, (_, i) => {
    const base = {
      id: `ob-${i}`,
      doc_id: null,
      remedy: null,
      ac_doc_no: null,
      created_at: "2026-08-15T00:00:00.000Z",
      updated_at: "2026-08-15T00:00:00.000Z",
      sent_at: null as string | null,
      attempts: 0,
    };
    if (i % 5 === 1) {
      return {
        ...base,
        op: "so_to_do",
        doc_type: "DO",
        doc_no: `HC-DO-2608-${String(i).padStart(4, "0")}`,
        status: "skipped",
        state: "skipped",
        reason: "refused, nothing sent (MissingLocationError): line 2 carries no warehouse",
        reason_kind: "missing-location",
        needs_attention: true,
        can_requeue: false,
      };
    }
    if (i % 5 === 2) {
      return {
        ...base,
        op: "create_so",
        doc_type: "SO",
        doc_no: `HC-SO-2608-${String(i).padStart(4, "0")}`,
        status: "failed",
        state: "failed",
        attempts: 6,
        reason: "Gave up after 6 attempts. Last error: FK_SO_SalesAgent",
        reason_kind: null,
        needs_attention: true,
        can_requeue: true,
      };
    }
    return {
      ...base,
      op: "create_so",
      doc_type: "SO",
      doc_no: `HC-SO-2608-${String(i).padStart(4, "0")}`,
      status: "sent",
      state: "sent",
      ac_doc_no: `SO-${String(i).padStart(5, "0")}`,
      sent_at: "2026-08-15T01:00:00.000Z",
      reason: null,
      reason_kind: null,
      needs_attention: false,
      can_requeue: false,
    };
  });
}

function acPayload(total: number): AcOutboxResponse {
  const rows = acRows(total);
  const failed = rows.filter((r) => r.state === "failed").length;
  const skipped = rows.filter((r) => r.state === "skipped").length;
  return {
    writeback: { value: "1", on: true, scope: "1" },
    counts: {
      pending: 0,
      sent: rows.length - failed - skipped,
      failed,
      skipped,
      requeued: 0,
      attention: failed + skipped,
      total: rows.length,
    },
    oldest_pending: null,
    rows,
    truncated: false,
    meta: { max_attempts: 6, state_meaning: {}, skip_kinds: [] },
  };
}

function stubTheQueue(total: number) {
  const body = acPayload(total);
  const real = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/scm/autocount-outbox")) {
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }
    return real(input as RequestInfo, init);
  }) as typeof window.fetch;
}

function AutoCountSyncLab({ mobile }: { mobile: boolean }) {
  const client = useMemo(() => new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }), []);
  return (
    <main
      data-scenario={mobile ? "autocount-sync-mobile" : "autocount-sync"}
      style={mobile ? { height: "100vh" } : undefined}
    >
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/autocount-sync?state=all"]}>
          {mobile ? <MobileAutoCountSync onBack={() => {}} /> : <AutoCountSync />}
        </MemoryRouter>
      </QueryClientProvider>
    </main>
  );
}

function App() {
  const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "health";
  if (scenario === "data-table-desktop") return <DataTableLab />;
  if (scenario === "data-table-mobile") return <DataTableLab mobile />;
  if (scenario === "data-grid") return <DataGridLab />;
  if (scenario === "mobile-virtual-list") return <MobileVirtualListLab />;
  if (scenario === "search") return <SearchLab />;
  if (scenario === "autocount-sync") {
    return <AutoCountSyncLab mobile={new URLSearchParams(window.location.search).get("surface") === "mobile"} />;
  }
  return <main data-scenario="health">ready</main>;
}

if (new URLSearchParams(window.location.search).get("scenario") === "autocount-sync") {
  stubTheQueue(AC_ROWS);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
