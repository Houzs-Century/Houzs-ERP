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
// `&state=` and `&docType=` put the DESKTOP page into a filter (the phone has no
// router and starts on Needs attention, as the app does — click a chip). The
// stub narrows its rows by `state` exactly as the route does, so a filter in the
// lab shows what the same filter shows in the app. `&rows=10&state=sent` is the
// screen the four repeated HC-SO-2608-002 sends below were taken from.
//
// The network is stubbed at `fetch` rather than by aliasing the api client:
// everything above fetch — the cache, the headers, the error path — is then the
// REAL code, so a row height measured here is a row height the app produces.
const AC_ROWS = Number(new URLSearchParams(window.location.search).get("rows") ?? 400);

/**
 * THE SCREEN THE OWNER READ, 2026-08-16: *"为什么在 AutoCount 里面一张 Sales Order
 * 会出现两次呢?"*
 *
 * Under **In AutoCount → Sales orders** he had SIX rows and `HC-SO-2608-002` was
 * FOUR of them — three "Change to the sales order" at 16/08 4:30-4:31pm and the
 * original "New sales order" at 15/08 1:25am. `AED_HOUZS` holds exactly one
 * `HC-SO-2608-002`; nothing was duplicated. `scm.autocount_outbox` is
 * append-only and writes one row per intended operation, so an ordinary document
 * that is created and then edited three times is four rows for good.
 *
 * These four are prepended to every lab run, so the repetition is in the fixture
 * whatever `?rows=` says. `?scenario=autocount-sync&rows=10&state=sent` puts six
 * sales orders in AutoCount on screen — his six — and they must render as THREE
 * cards.
 *
 * Timestamps are DESCENDING, matching the route's `created_at` order, because
 * that ordering is what decides which send draws the card.
 */
const AC_REPEATED_SENDS: AcOutboxRow[] = [
  { op: "edit", createdAt: "2026-08-16T08:31:40.000Z", sentAt: "2026-08-16T08:31:55.000Z" },
  { op: "edit", createdAt: "2026-08-16T08:31:05.000Z", sentAt: "2026-08-16T08:31:20.000Z" },
  { op: "edit", createdAt: "2026-08-16T08:30:12.000Z", sentAt: "2026-08-16T08:30:30.000Z" },
  { op: "create_so", createdAt: "2026-08-14T17:25:00.000Z", sentAt: "2026-08-14T17:25:18.000Z" },
].map((s, i) => ({
  id: `ob-dup-${i}`,
  op: s.op,
  doc_type: "SO",
  doc_no: "HC-SO-2608-002",
  doc_id: null,
  status: "sent",
  state: "sent",
  attempts: 0,
  reason: null,
  reason_kind: null,
  remedy: null,
  needs_attention: false,
  can_requeue: false,
  /* The server offers "Send now" only on a row that is still WAITING and has
     tries left (acRowCanSendNow, backend scm/lib/autocount-outbox-status.ts).
     These four are SENT, so false is what the route would publish for them. */
  can_send_now: false,
  ac_doc_no: "SO-00002",
  created_at: s.createdAt,
  updated_at: s.sentAt,
  sent_at: s.sentAt,
}));

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
        op: "so_to_do",
        doc_type: "DO",
        doc_no: `HC-DO-2608-${String(i).padStart(4, "0")}`,
        status: "failed",
        state: "failed",
        attempts: 6,
        /* THE WALL, verbatim. AcSyncService started appending the account book's
           own numbers per line on 2026-08-16 and the owner read the result on
           the live page. The lab has to carry the real string or it measures a
           row nobody has. */
        reason:
          "Gave up after 6 attempts. Last error: Invalid transfer item. || source SO lines as the "
          + "book holds them: 905348 on SO HC-SO-2608-002 [AK-ULTIMATE MATT (K)] Qty=1.00000000 "
          + "TransferedQty=0.00000000 Transferable=T docCancelled=F outstanding=1.00000000; "
          + "905349 on SO HC-SO-2608-002 [HOK-1013 (K)] Qty=1.00000000 TransferedQty=0.00000000 "
          + "Transferable=T docCancelled=F outstanding=1.00000000",
        reason_kind: null,
        needs_attention: true,
        can_requeue: true,
      };
    }
    if (i % 5 === 3) {
      return {
        ...base,
        op: "do_to_iv",
        doc_type: "IV",
        doc_no: `HC-IV-2608-${String(i).padStart(4, "0")}`,
        status: "skipped",
        state: "skipped",
        /* THE SENTENCE AS THE QUEUE STILL HOLDS IT. recordParentlessCreate no
           longer writes the SDK method name, and scm.autocount_outbox is
           append-only — every row written before that change keeps it, so this
           is what the page has to cope with, not what the writer now produces. */
        reason:
          "created with no source delivery order, so there is no source document to transfer "
          + "from. AutoCount builds a DO / GRN / Invoice only by transferring a source document's "
          + "lines (AddPartialTransferDetail is the SDK's only primitive), so this document "
          + "cannot be created in the account book at all and will stay ERP-only.",
        reason_kind: "no-source-document",
        needs_attention: true,
        can_requeue: false,
      };
    }
    if (i % 5 === 4) {
      return {
        ...base,
        op: "so_to_do",
        doc_type: "DO",
        /* Deliberately the SAME two document numbers, repeatedly: his live page
           had HC-DO-2608-001 and -002 each appearing twice, which is what makes
           a list of history read as a list of problems. */
        doc_no: `HC-DO-2608-00${(i % 2) + 1}`,
        status: "skipped",
        state: "requeued",
        reason:
          "[re-queued 2026-08-16T02:00:00.000Z -> outbox ob-x] refused, nothing sent "
          + "(ItemCodeError): 9028-1S resolves to no single AutoCount item",
        reason_kind: "item-code",
        needs_attention: false,
        can_requeue: false,
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
  const rows = [...AC_REPEATED_SENDS, ...acRows(total)];
  /* COUNTS ARE DOCUMENTS, because the route's are. A lab whose counts were rows
     would render a page that agrees with itself and disagrees with production —
     which is the defect this fixture exists to reproduce, not to hide. Distinct
     `doc_type + doc_no`, the same key acGroupByDocument and the backend's
     acDocKey use. */
  const docsWhere = (p: (r: AcOutboxRow) => boolean): number =>
    new Set(rows.filter(p).map((r) => `${r.doc_type}/${r.doc_no}`)).size;
  const failed = docsWhere((r) => r.state === "failed");
  const skipped = docsWhere((r) => r.state === "skipped");
  return {
    writeback: { value: "1", on: true, scope: "1" },
    counts: {
      pending: docsWhere((r) => r.state === "pending"),
      sent: docsWhere((r) => r.state === "sent"),
      failed,
      skipped,
      requeued: docsWhere((r) => r.state === "requeued"),
      /* Re-queued rows are NOT attention — their documents went through under a
         newer row. Counting them here is the phantom-failure bug #2189 left
         behind, and the lab must not reproduce a shape the server cannot send. */
      attention: docsWhere((r) => r.state === "failed" || r.state === "skipped"),
      total: docsWhere(() => true),
    },
    oldest_pending: null,
    rows,
    truncated: false,
    counts_complete: true,
    meta: { max_attempts: 6, state_meaning: {}, skip_kinds: [] },
  };
}

/**
 * The route's own state narrowing, so `&state=sent` in the lab shows what
 * `?state=sent` shows in the app.
 *
 * The stub used to answer every request with every row, which was harmless while
 * nothing on the page depended on the filter and is not harmless now: the six
 * rows the owner counted were under a FILTER, and a lab that cannot be put into
 * that filter cannot reproduce his screen. The counts stay whole-company, as the
 * route's do.
 */
function acRowsForState(rows: AcOutboxRow[], state: string): AcOutboxRow[] {
  switch (state) {
    case "attention": return rows.filter((r) => r.needs_attention);
    case "pending": return rows.filter((r) => r.state === "pending");
    case "sent": return rows.filter((r) => r.state === "sent");
    case "failed": return rows.filter((r) => r.state === "failed");
    case "skipped": return rows.filter((r) => r.state === "skipped");
    case "requeued": return rows.filter((r) => r.state === "requeued");
    default: return rows;
  }
}

function stubTheQueue(total: number) {
  const body = acPayload(total);
  const real = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/scm/autocount-outbox")) {
      const state = new URL(url, window.location.origin).searchParams.get("state") ?? "all";
      const answer = { ...body, rows: acRowsForState(body.rows, state) };
      return Promise.resolve(new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }
    return real(input as RequestInfo, init);
  }) as typeof window.fetch;
}

/**
 * `&state=` and `&docType=` are handed to the page, so the lab can be put into
 * the exact filter a screenshot was taken in. Defaults to `all`, which is what
 * this harness measured before either was readable.
 */
function acLabEntry(): string {
  const lab = new URLSearchParams(window.location.search);
  const p = new URLSearchParams({ state: lab.get("state") ?? "all" });
  const docType = lab.get("docType");
  if (docType) p.set("docType", docType);
  return `/autocount-sync?${p.toString()}`;
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
        <MemoryRouter initialEntries={[acLabEntry()]}>
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
