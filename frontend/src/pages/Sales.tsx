import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, CheckSquare, Send, Settings as SettingsIcon, X, Check, Clock } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { TabStrip } from "../components/TabStrip";
import { Panel, PanelSection } from "../components/Panel";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useUdf, type UdfField, type UdfFieldType } from "../hooks/useUdf";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api } from "../api/client";
import { formatPhone } from "../vendor/shared/phone";
import { useAuth } from "../auth/AuthContext";
import { usePageAccess } from "../auth/PageGuard";
import { formatCurrency, formatDate, formatDateTime, cn, todayInAppTz } from "../lib/utils";
import { parseMoneyToSen, parseQuantity, senToRm, scaledToQuantity } from "../lib/money";
import { DataTable, type Column } from "../components/DataTable";
import { SearchProgress } from "../components/SearchProgress";
import { EmptyState } from "../components/EmptyState";
import { Pagination } from "../components/Pagination";
import { useDebouncedSearchTerm, useSearchResultTransition } from "../hooks/useServerSearch";
import { DateField } from "../vendor/scm/components/DateField";

const SALES_FILTER_KEYS = ["status", "search", "date_from", "date_to", "view"] as const;

// ── Types ─────────────────────────────────────────────────────

export type EntryStatus = "draft" | "submitted" | "pushed" | "void";

// A queued edit awaiting Director approval (sales_entry_change_requests).
type ChangeRequest = {
  id: number;
  entry_id: number;
  summary: string | null;
  status: string;
  created_at: string;
  doc_no: string | null;
  customer_name: string | null;
  entry_status: EntryStatus;
  requested_by_name: string | null;
};

export type PaymentType = "cash" | "card_cc" | "card_db" | "epp" | "cheque" | "online";

export const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  cash: "Cash",
  card_cc: "Credit Card",
  card_db: "Debit Card",
  epp: "EPP",
  cheque: "Cheque",
  online: "Online Transfer",
};

export interface SalesEntry {
  id: number;
  doc_no: string | null;
  project_id: number | null;
  project_code: string | null;
  project_name: string | null;
  ref_no: string | null;
  customer_name: string;
  customer_code: string | null;
  customer_address: string | null;
  customer_address_2: string | null;
  customer_postcode: string | null;
  customer_state: string | null;
  customer_phone: string | null;
  customer_phone_2: string | null;
  customer_email: string | null;
  amount: number;
  deposit_amount: number | null;
  deposit_payment_type: PaymentType | null;
  currency: string;
  occurred_at: string;
  /* NOT the Sales Order's Processing Date. This is a plain date on a
     `sales_entries` row — the legacy native Sales module's own document, which
     has no SO row and none of the SCM Processing-Date rules (no deposit gate, no
     elapsed-date lock, no remove-permission, no stock allocation). The SCM SO's
     Processing Date has exactly ONE storage, scm.mfg_sales_orders.internal_expected_dd;
     never coalesce or unify the two. The name is kept only because renaming it
     would silently drop the field from already-queued sales change requests —
     the full reasoning is on SO_FORM_TEXT_FIELDS in backend/src/routes/sales.ts. */
  processing_date: string | null;
  delivery_date: string | null;
  status_2: string | null;
  venue: string | null;
  warehouse: string | null;
  branding: string | null;
  po_doc_no: string | null;
  payment_status: string | null;
  source: string | null;
  remarks: string | null;
  notes: string | null;
  status: EntryStatus;
  autocount_doc_no: string | null;
  autocount_doc_type: string | null;
  pushed_at: string | null;
  push_error: string | null;
  sales_person_id: number | null;
  sales_person_name: string | null;
  sales_person_email: string | null;
  created_by: number;
  created_by_name: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SalesItemLine {
  id?: number;
  line_no?: number;
  item_code: string;
  item_description: string;
  remarks: string;
  qty: string;
  unit_price: string;
  amount: string;
  group_tag: string;
}

export interface SalesPaymentLine {
  id?: number;
  paid_at: string;
  payment_method: PaymentType | "";
  amount: string;
  account_sheet: string;
  approval_code: string;
  collected_by: string;
}

interface ListResponse {
  data: SalesEntry[];
  page: number;
  per_page: number;
  total: number;
  totals: {
    amount: number;
    count: number;
    by_status: { draft: number; submitted: number; pushed: number };
    // Mig 064 (quick-log workflow) — count of draft rows still
    // sitting on the "(quick log)" sentinel customer_name. Drives the
    // badge on the Quick Logs tab.
    quick_log_pending?: number;
  };
}

export const STATUS_BADGE: Record<EntryStatus, { label: string; cls: string }> = {
  draft:     { label: "Draft",     cls: "bg-bg text-ink-muted border border-border" },
  submitted: { label: "Submitted", cls: "bg-amber-100 text-amber-800" },
  pushed:    { label: "Pushed",    cls: "bg-synced/15 text-synced" },
  void:      { label: "Void",      cls: "bg-err/10 text-err" },
};

// ── Page ──────────────────────────────────────────────────────

export function Sales() {
  const { user: me } = useAuth();
  const salesAccess = usePageAccess("sales");
  const toast = useToast();
  const dialog = useDialog();
  // Page-access model (mig 073): "full" = manage/void/push; "partial"
  // = own entries only, no manage. The route's <PageGuard> already
  // rejected "none", so writes are always allowed here.
  const canManage = salesAccess === "full";
  const canWrite = salesAccess !== "none";

  // Filter state lives in the URL — `?status=draft&search=abc` —
  // mirrored to localStorage via useStickyFilters so navbar away-and-back
  // restores the last view. Bookmark / share / refresh / back-button all
  // work because the URL itself is the source of truth.
  const [params, setParams] = useStickyFilters("sales", SALES_FILTER_KEYS);
  // ?view= drives the tab selector. "quicklogs" narrows to drafts on
  // the QUICK_LOG_SENTINEL; "all" (default) is the existing list with
  // quick-logs excluded so the dedicated tab owns those rows.
  const view =
    params.get("view") === "quicklogs"
      ? "quicklogs"
      : params.get("view") === "approvals" && canManage
        ? "approvals"
        : "all";
  const status = view === "quicklogs" ? "draft" : params.get("status") || "";
  const search = params.get("search") || "";
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);
  const dateFrom = params.get("date_from") || "";
  const dateTo = params.get("date_to") || "";

  function patchParams(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

  const [editing, setEditing] = useState<SalesEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);

  // Fixed page size, matching the /api/sales/entries server default. Page is a
  // transient cursor kept in local state (not the URL — it's not a shareable
  // filter) and resets to 1 whenever the active filters change.
  const PER_PAGE = 50;
  const [page, setPage] = useState(1);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (debouncedSearch) p.set("search", debouncedSearch);
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    // Quick Logs tab → only quick-log rows.
    // All tab → exclude quick-logs (the dedicated tab owns them).
    if (view === "quicklogs") p.set("quick_log", "1");
    else p.set("quick_log", "0");
    return p.toString();
  }, [status, debouncedSearch, dateFrom, dateTo, view]);

  // qs is filter-only (page excluded) so a filter change lands here → page 1.
  useEffect(() => {
    setPage(1);
  }, [qs]);

  const list = useQuery<ListResponse>("/api/sales/entries?:",
    (signal) => {
      const p = new URLSearchParams(qs);
      p.set("page", String(page));
      p.set("per_page", String(PER_PAGE));
      return api.get(`/api/sales/entries?${p.toString()}`, { signal });
    },
    [qs, page]
  );
  const searchTransition = useSearchResultTransition({
    inputTerm: search,
    requestTerm: debouncedSearch,
    isFetching: list.fetching,
    isPlaceholderData: list.placeholder,
    hasData: list.data !== null,
    hasError: Boolean(list.error),
  });
  // Pending edit-approval queue (managers only). Drives the Approvals tab +
  // its badge; reps don't see this surface.
  const approvals = useQuery<{ requests: ChangeRequest[] }>("/api/sales/entries/change-requests?status=pending",
    () =>
      canManage
        ? api.get(`/api/sales/entries/change-requests?status=pending`)
        : Promise.resolve({ requests: [] }),
    [canManage]
  );
  const udf = useUdf("sales_entries");

  async function submitEntry(e: SalesEntry) {
    try {
      await api.post(`/api/sales/entries/${e.id}/submit`);
      toast.success(`Submitted — ${e.customer_name}`);
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong. Please try again.");
    }
  }
  async function voidEntry(e: SalesEntry) {
    if (!(await dialog.confirm(`Void sale for ${e.customer_name}?`))) return;
    try {
      await api.post(`/api/sales/entries/${e.id}/void`);
      toast.success("Voided");
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong. Please try again.");
    }
  }
  async function deleteEntry(e: SalesEntry) {
    if (!(await dialog.confirm(`Delete draft for ${e.customer_name}?`))) return;
    try {
      await api.del(`/api/sales/entries/${e.id}`);
      toast.success("Deleted");
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong. Please try again.");
    }
  }

  const columns: Column<SalesEntry>[] = [
    {
      key: "occurred_at",
      label: "Date",
      getValue: (e) => e.occurred_at,
      render: (e) => (
        <span className="font-mono text-ink-secondary">{formatDate(e.occurred_at)}</span>
      ),
    },
    {
      key: "customer",
      label: "Customer",
      getValue: (e) => e.customer_name,
      render: (e) =>
        e.customer_name === "(quick log)" ? (
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-warning-bg px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-warning-text">
              Quick log
            </span>
            {canWrite && (
              <button
                onClick={() => setEditing(e)}
                className="text-[11px] font-semibold text-accent hover:underline"
                title="Open this draft and fill in the customer details"
              >
                Complete
              </button>
            )}
          </div>
        ) : (
          <span
            className="inline-flex items-baseline gap-1.5"
            title={
              e.customer_phone
                ? `${e.customer_name} · ${formatPhone(e.customer_phone)}`
                : e.customer_name
            }
          >
            <span className="font-semibold text-ink">{e.customer_name}</span>
            {e.customer_phone && (
              <span className="font-mono text-[10px] text-ink-muted">
                · {formatPhone(e.customer_phone)}
              </span>
            )}
          </span>
        ),
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      getValue: (e) => e.amount,
      render: (e) => (
        <span className="font-mono font-semibold">{formatCurrency(e.amount)}</span>
      ),
    },
    {
      key: "project_code",
      label: "Project",
      getValue: (e) => e.project_code ?? "",
      render: (e) => (
        <span className="font-mono text-[11px] text-ink-secondary">
          {e.project_code || "—"}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      getValue: (e) => e.status,
      render: (e) => {
        const badge = STATUS_BADGE[e.status];
        return (
          <span
            className={cn(
              "inline-flex rounded-full px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider",
              badge.cls,
            )}
          >
            {badge.label}
          </span>
        );
      },
    },
    {
      key: "created_by",
      label: "By",
      getValue: (e) => e.created_by_name ?? e.created_by_email ?? "",
      render: (e) => (
        <span className="text-[11px] text-ink-muted">
          {e.created_by_name || e.created_by_email || "—"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (e) => {
        const isMine = e.created_by === me?.id;
        // Reps may edit their own draft OR submitted entries — a submitted-entry
        // edit is routed to the Director approval queue by the backend (202).
        const canEdit =
          canManage || (isMine && (e.status === "draft" || e.status === "submitted"));
        const needsApproval = !canManage && isMine && e.status === "submitted";
        const canSubmit = canEdit && e.status === "draft";
        return (
          <div className="flex items-center justify-end gap-0.5">
            {view === "quicklogs" && canEdit && (
              <button
                onClick={() => setEditing(e)}
                className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft px-2 py-1 text-[10.5px] font-semibold text-accent hover:bg-accent hover:text-white"
                title="Open this draft and fill in the customer details"
              >
                <Pencil size={11} /> Complete
              </button>
            )}
            {view !== "quicklogs" && canSubmit && (
              <button
                onClick={() => submitEntry(e)}
                className="rounded p-1.5 text-ink-muted hover:bg-accent-soft hover:text-accent"
                title="Submit"
              >
                <CheckSquare size={13} />
              </button>
            )}
            {view !== "quicklogs" && canEdit && (
              <button
                onClick={() => setEditing(e)}
                className="rounded p-1.5 text-ink-muted hover:bg-surface-dim hover:text-ink"
                title={needsApproval ? "Edit (changes need Director approval)" : "Edit"}
              >
                <Pencil size={13} />
              </button>
            )}
            {canManage && e.status === "submitted" && (
              <button
                onClick={() => submitEntry(e)}
                className="rounded p-1.5 text-ink-muted hover:bg-accent-soft hover:text-accent"
                title="Push to AutoCount"
                disabled
              >
                <Send size={13} />
              </button>
            )}
            {canManage && e.status !== "void" && (
              <button
                onClick={() => voidEntry(e)}
                className="rounded p-1.5 text-ink-muted hover:bg-err/10 hover:text-err"
                title="Void"
              >
                <X size={13} />
              </button>
            )}
            {canEdit && e.status === "draft" && (
              <button
                onClick={() => deleteEntry(e)}
                className="rounded p-1.5 text-ink-muted hover:bg-err/10 hover:text-err"
                title="Delete"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Income"
        title="Sales"
        description="Log customer sales here. Fields are customisable — admins can add extras via the settings gear. Drafts can be edited freely; submitted entries lock for review and will push to AutoCount once the integration is enabled."
        secondaryActions={
          canManage
            ? [
                {
                  icon: SettingsIcon,
                  label: "Fields",
                  onClick: () => setFieldsOpen(true),
                },
              ]
            : undefined
        }
        primaryAction={
          canWrite ? (
            <Button
              variant="brass"
              icon={<Plus size={14} />}
              onClick={() => setCreating(true)}
            >
              New Sale
            </Button>
          ) : undefined
        }
      />

      {/* Summary tiles */}
      <div className="mb-4 grid grid-cols-2 divide-x divide-border-subtle overflow-hidden rounded-md border border-border bg-surface shadow-stone sm:grid-cols-4">
        <Tile label="Total" value={formatCurrency(list.data?.totals.amount ?? 0)} />
        <Tile label="Entries" value={String(list.data?.totals.count ?? 0)} />
        <Tile
          label="Drafts"
          value={String(list.data?.totals.by_status.draft ?? 0)}
        />
        <Tile
          label="Pushed"
          value={String(list.data?.totals.by_status.pushed ?? 0)}
          tone="ok"
        />
      </div>

      {/* Tabs — All Sales vs the dedicated Quick Logs queue. The
          quick_log_pending count comes back on every list response
          (computed independently of the current filter), so the
          badge stays live whichever view is active. */}
      <TabStrip
        value={view}
        onChange={(v) => patchParams({ view: v === "all" ? "" : v })}
        options={[
          { value: "all", label: "All Sales" },
          {
            value: "quicklogs",
            label: "Quick Logs",
            count: list.data?.totals.quick_log_pending ?? 0,
          },
          ...(canManage
            ? [
                {
                  value: "approvals",
                  label: "Approvals",
                  count: approvals.data?.requests.length ?? 0,
                },
              ]
            : []),
        ]}
      />

      {view === "approvals" ? (
        <ApprovalsView
          requests={approvals.data?.requests ?? null}
          loading={approvals.loading}
          onChanged={() => {
            approvals.reload();
            list.reload();
          }}
        />
      ) : (
      <>
      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {view === "all" && (
          <select
            value={status}
            onChange={(e) => patchParams({ status: e.target.value })}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="pushed">Pushed</option>
            <option value="void">Void</option>
          </select>
        )}
        <DateField
          fullWidth
          value={dateFrom}
          onChange={(iso) => patchParams({ date_from: iso })}
          title="From"
          className="h-8 rounded-md border border-border bg-surface px-2 text-[11px]"
        />
        <span className="text-[10px] text-ink-muted">→</span>
        <DateField
          fullWidth
          value={dateTo}
          onChange={(iso) => patchParams({ date_to: iso })}
          title="To"
          className="h-8 rounded-md border border-border bg-surface px-2 text-[11px]"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => patchParams({ search: e.target.value })}
          placeholder="Search customer / phone / ref no…"
          className="h-8 flex-1 min-w-[200px] max-w-[320px] rounded-md border border-border bg-surface px-3 text-[11px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        <SearchProgress active={searchTransition.isSearching} label={searchTransition.statusText} />
        {(status || search || dateFrom || dateTo) && (
          <button
            onClick={() =>
              patchParams({ status: "", search: "", date_from: "", date_to: "" })
            }
            className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
          >
            Clear
          </button>
        )}
      </div>

      {/* List */}
      {list.data && list.data.data.length === 0 && !list.loading && !searchTransition.resultsAreStale ? (
        <EmptyState
          message={
            view === "quicklogs"
              ? "Inbox zero — no quick logs are waiting for completion."
              : "No sales logged yet."
          }
          cta={
            view === "quicklogs"
              ? undefined
              : canWrite
              ? { label: "Add your first entry", onClick: () => setCreating(true) }
              : undefined
          }
        />
      ) : (
        <DataTable
          tableId="sales"
          columns={columns}
          rows={list.data?.data ?? null}
          loading={list.loading || searchTransition.isSearching}
          error={list.error}
          getRowKey={(e) => e.id}
          exportName="sales"
        />
      )}
      {list.data && !searchTransition.resultsAreStale && (
        <Pagination
          page={page}
          perPage={PER_PAGE}
          total={list.data.total}
          onPageChange={setPage}
        />
      )}
      </>
      )}

      {creating && (
        <EntryPanel
          mode="create"
          udfFields={udf.fields}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            list.reload();
          }}
        />
      )}
      {editing && (
        <EntryPanel
          mode="edit"
          entry={editing}
          udfFields={udf.fields}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
      {fieldsOpen && (
        <FieldConfigPanel
          udf={udf}
          onClose={() => setFieldsOpen(false)}
        />
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "err" | "default";
}) {
  return (
    <div className="px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono text-[14px] font-bold leading-tight",
          tone === "ok" && "text-synced",
          tone === "err" && "text-err",
          (!tone || tone === "default") && "text-ink"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ── Entry create/edit panel ──────────────────────────────────

export function EntryPanel({
  mode,
  entry,
  udfFields,
  onClose,
  onSaved,
  lockedProjectId,
  lockedProjectLabel,
}: {
  mode: "create" | "edit";
  entry?: SalesEntry;
  udfFields: UdfField[];
  onClose: () => void;
  onSaved: () => void;
  /** When set, the project picker is replaced by a read-only label and
   *  every saved entry is force-linked to this project. Used by the
   *  in-project Sales section so reps can't accidentally re-target an
   *  entry to a different exhibition. */
  lockedProjectId?: number;
  lockedProjectLabel?: string;
}) {
  const toast = useToast();
  const auth = useAuth();
  const today = todayInAppTz();
  // Quick-log rows carry the literal "(quick log)" sentinel in
  // customer_name. Strip it so the rep sees an empty input and types
  // a real name into it; the gating below blocks Save & submit until
  // they do.
  const isQuickLog = entry?.customer_name === "(quick log)";
  // ── Header
  const [docNo] = useState(entry?.doc_no || "");
  const [orderDate, setOrderDate] = useState(
    entry?.occurred_at?.slice(0, 10) || today,
  );
  const [processingDate, setProcessingDate] = useState(
    entry?.processing_date?.slice(0, 10) || today,
  );
  const [deliveryDate, setDeliveryDate] = useState(
    entry?.delivery_date?.slice(0, 10) || "",
  );
  const [status1, setStatus1] = useState(entry?.status === "draft" ? "" : (entry?.status as string) || "");
  const [status2, setStatus2] = useState(entry?.status_2 || "MATTRESS/ACC");
  // ── Customer
  const [customerName, setCustomerName] = useState(
    isQuickLog ? "" : entry?.customer_name || "",
  );
  const [customerAddress, setCustomerAddress] = useState(entry?.customer_address || "");
  const [customerAddress2, setCustomerAddress2] = useState(entry?.customer_address_2 || "");
  const [customerPostcode, setCustomerPostcode] = useState(entry?.customer_postcode || "");
  const [customerState, setCustomerState] = useState(entry?.customer_state || "");
  const [customerPhone, setCustomerPhone] = useState(entry?.customer_phone || "");
  const [customerPhone2, setCustomerPhone2] = useState(entry?.customer_phone_2 || "");
  const [customerEmail, setCustomerEmail] = useState(entry?.customer_email || "");
  const [venue, setVenue] = useState(entry?.venue || "");
  const [warehouse, setWarehouse] = useState(entry?.warehouse || "KL");
  const [refNo, setRefNo] = useState(entry?.ref_no || "");
  const [source, setSource] = useState(entry?.source || "External");
  // ── Right column
  const [salesPersonId, setSalesPersonId] = useState<string>(
    entry?.sales_person_id != null
      ? String(entry.sales_person_id)
      : auth.user?.id
      ? String(auth.user.id)
      : ""
  );
  const [branding, setBranding] = useState(entry?.branding || "");
  const [customerCode, setCustomerCode] = useState(entry?.customer_code || "");
  const [poDocNo, setPoDocNo] = useState(entry?.po_doc_no || "");
  const [paymentStatus, setPaymentStatus] = useState(entry?.payment_status || "Unchecked");
  const [notes, setNotes] = useState(entry?.notes || "");
  // ── Items / payments / footer
  const [items, setItems] = useState<SalesItemLine[]>([]);
  const [payments, setPayments] = useState<SalesPaymentLine[]>([]);
  const [remarks, setRemarks] = useState(entry?.remarks || "");
  // ── Misc
  const [currency, setCurrency] = useState(entry?.currency || "MYR");
  const [projectId, setProjectId] = useState<string>(
    lockedProjectId
      ? String(lockedProjectId)
      : entry?.project_id ? String(entry.project_id) : ""
  );
  const [custom, setCustom] = useState<Record<string, string>>({});
  // Full edit history (sales_entry_activity) — who created/edited this entry, when.
  const [activity, setActivity] = useState<
    { id: number; action: string; user_name: string | null; created_at: string }[]
  >([]);
  const [busy, setBusy] = useState(false);

  // Sales-person picker. Defaults to the logged-in user (admins keying
  // an entry on behalf of a rep change this). Falls back gracefully if
  // /api/users is forbidden for the role — the picker simply hides.
  const usersQ = useQuery<{ users: Array<{ id: number; name: string | null; email: string }> }>("/api/users#tolerant",
    () => api.get<{ users: Array<{ id: number; name: string | null; email: string }> }>("/api/users").catch(() => ({ users: [] }))
  );

  // Brand list — same source the projects + sales-team modules use.
  type BrandRow = { id: number; name: string; hex_color: string | null };
  const brandsQ = useQuery<{ data: BrandRow[] }>("/api/projects/brands?full=1",
    () =>
      api
        .get<{ data: BrandRow[] }>("/api/projects/brands?full=1")
        .catch<{ data: BrandRow[] }>(() => ({ data: [] })),
  );

  // Hydrate custom field values, items, payments if editing.
  useEffect(() => {
    if (mode !== "edit" || !entry) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get<{
          entry: SalesEntry;
          custom: Record<string, string | null>;
          items?: any[];
          payments?: any[];
          activity?: any[];
        }>(`/api/sales/entries/${entry.id}`);
        if (cancelled) return;
        if (Array.isArray(r.activity)) setActivity(r.activity);
        const initial: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.custom || {})) {
          if (v != null) initial[k] = v;
        }
        setCustom(initial);
        if (Array.isArray(r.items) && r.items.length > 0) {
          setItems(
            r.items.map((it) => ({
              id: it.id,
              line_no: it.line_no ?? 0,
              item_code: it.item_code ?? "",
              item_description: it.item_description ?? "",
              remarks: it.remarks ?? "",
              qty: it.qty != null ? String(it.qty) : "1",
              unit_price: it.unit_price != null ? String(it.unit_price) : "0",
              amount: it.amount != null ? String(it.amount) : "0",
              group_tag: it.group_tag ?? "",
            })),
          );
        }
        if (Array.isArray(r.payments) && r.payments.length > 0) {
          setPayments(
            r.payments.map((p) => ({
              id: p.id,
              paid_at: p.paid_at?.slice(0, 10) ?? today,
              payment_method: (p.payment_method as PaymentType) ?? "",
              amount: p.amount != null ? String(p.amount) : "",
              account_sheet: p.account_sheet ?? "",
              approval_code: p.approval_code ?? "",
              collected_by: p.collected_by ?? "",
            })),
          );
        }
      } catch {
        // silent — form already usable with the row we have
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, entry]);

  /* Live totals derived from items + payments. These run through the SAME
     parser the save does, so the figure on screen and the figure that gets
     written can never come from two different opinions about what "1,200"
     means — the disagreement fx-rate.ts was written to end. An unreadable
     amount contributes nothing here AND blocks the save below, so the total
     is never a confident number standing on a value nobody could read. */
  const itemsTotal = useMemo(() => {
    let sen = 0;
    for (const it of items) {
      const a = parseMoneyToSen(it.amount);
      if (a.ok) sen += a.sen;
    }
    return senToRm(sen);
  }, [items]);
  const paidTotal = useMemo(() => {
    let sen = 0;
    for (const p of payments) {
      const a = parseMoneyToSen(p.amount);
      if (a.ok) sen += a.sen;
    }
    return senToRm(sen);
  }, [payments]);
  const balance = Math.max(0, itemsTotal - paidTotal);

  // Minimal project picker — fetches only recent projects. Free text
  // fallback not shown; pic_id wiring on projects means reps already see
  // only their PIC's projects here. Fires even when locked — harmless
  // and avoids a conditional hook call.
  const projectsQ = useQuery<{ data: Array<{ id: number; code: string; name: string }> }>("/api/projects?per_page=200",
    () => api.get("/api/projects?per_page=200")
  );

  async function submit(thenSubmit: boolean) {
    if (!customerName.trim() && !isQuickLog) {
      toast.error("Customer name is required");
      return;
    }
    /* MONEY GUARD (owner ruling 2026-07-19 "打错价钱肯定是要警告啊"; HOOKKA
       BUG-2026-06-11-002). Every amount is parsed BEFORE anything is sent, and
       a value we cannot read stops the save with a sentence naming the field.
       What this replaced was `parseFloat(x) || 0`, which booked an unreadable
       price as RM 0.00, and a filter on `parseFloat(amount) > 0`, which made an
       unreadable PAYMENT vanish from the entry entirely. Both were silent: the
       entry saved, looked normal, and the money was simply gone. Nothing is
       coerced here — see lib/money.ts for what is accepted and what is refused. */
    const problems: string[] = [];

    const parsedItems = items.map((it, idx) => {
      const line = it.line_no ?? idx + 1;
      const qty = parseQuantity(it.qty, `Quantity on line ${line}`);
      const unitPrice = parseMoneyToSen(it.unit_price, `Unit price on line ${line}`);
      const amount = parseMoneyToSen(it.amount, `Amount on line ${line}`);
      for (const r of [qty, unitPrice, amount]) if (!r.ok) problems.push(r.message);
      return { it, line, qty, unitPrice, amount };
    });

    const parsedPayments = payments.map((p, idx) => {
      const amount = parseMoneyToSen(p.amount, `Payment amount on row ${idx + 1}`);
      /* An untouched row that was added and never filled is not a problem — it
         is just an empty row, and it gets dropped below exactly as before. */
      const untouched = !p.payment_method && (amount.ok && amount.empty);
      if (!untouched && !amount.ok) problems.push(amount.message);
      /* A real amount with no method chosen used to be dropped by the old
         `p.payment_method && ...` filter, so the payment silently disappeared.
         Same family of loss, so it is reported the same way. */
      if (!untouched && amount.ok && amount.sen > 0 && !p.payment_method) {
        problems.push(`Choose a payment method for the payment on row ${idx + 1}.`);
      }
      return { p, amount };
    });

    if (problems.length > 0) {
      // De-duplicated so three bad lines with the same mistake read as one
      // instruction rather than a wall of repeats.
      toast.error(Array.from(new Set(problems)).join("\n"));
      return;
    }

    // Total derived from items if any; else 0 (lets users save a draft
    // header before keying lines).
    const amt = items.length > 0 ? itemsTotal : 0;
    setBusy(true);
    try {
      const itemsPayload = parsedItems
        .filter(({ it, amount }) => it.item_code.trim() || it.item_description.trim() || (amount.ok && amount.sen > 0))
        .map(({ it, line, qty, unitPrice, amount }) => ({
          line_no: line,
          item_code: it.item_code.trim() || null,
          item_description: it.item_description.trim() || null,
          remarks: it.remarks.trim() || null,
          qty: qty.ok ? scaledToQuantity(qty.sen) : 0,
          unit_price: unitPrice.ok ? senToRm(unitPrice.sen) : 0,
          amount: amount.ok ? senToRm(amount.sen) : 0,
          group_tag: it.group_tag.trim() || null,
        }));
      const paymentsPayload = parsedPayments
        .filter(({ p, amount }) => p.payment_method && amount.ok && amount.sen > 0)
        .map(({ p, amount }) => ({
          paid_at: p.paid_at,
          payment_method: p.payment_method,
          amount: amount.ok ? senToRm(amount.sen) : 0,
          account_sheet: p.account_sheet.trim() || null,
          approval_code: p.approval_code.trim() || null,
          collected_by: p.collected_by.trim() || null,
        }));
      const body: any = {
        project_id: projectId ? parseInt(projectId, 10) : null,
        ref_no: refNo.trim() || null,
        customer_name: isQuickLog && !customerName.trim() ? "" : customerName.trim(),
        customer_code: customerCode.trim() || null,
        customer_address: customerAddress.trim() || null,
        customer_address_2: customerAddress2.trim() || null,
        customer_postcode: customerPostcode.trim() || null,
        customer_state: customerState.trim() || null,
        customer_phone: customerPhone.trim() || null,
        customer_phone_2: customerPhone2.trim() || null,
        customer_email: customerEmail.trim() || null,
        amount: amt,
        sales_person_id: salesPersonId ? parseInt(salesPersonId, 10) : null,
        currency: currency.trim() || "MYR",
        occurred_at: orderDate,
        processing_date: processingDate || null,
        delivery_date: deliveryDate || null,
        status_2: status2.trim() || null,
        venue: venue.trim() || null,
        warehouse: warehouse.trim() || null,
        branding: branding.trim() || null,
        po_doc_no: poDocNo.trim() || null,
        payment_status: paymentStatus.trim() || null,
        source: source.trim() || null,
        remarks: remarks.trim() || null,
        notes: notes.trim() || null,
        custom,
        items: itemsPayload,
        payments: paymentsPayload,
      };
      if (status1.trim()) body.status = status1.trim();
      let id: number;
      if (mode === "create") {
        const r = await api.post<{ id: number; doc_no: string }>("/api/sales/entries", body);
        id = r.id;
        toast.success(`Created ${r.doc_no}`);
      } else if (entry) {
        const res = await api.patch<{ queued?: boolean }>(
          `/api/sales/entries/${entry.id}`,
          body,
        );
        id = entry.id;
        if (res?.queued) {
          toast.success(`Change sent to your Sales Director for approval`);
          onSaved();
          return;
        }
        toast.success(`Updated ${entry.doc_no || customerName}`);
      } else {
        return;
      }
      if (thenSubmit) {
        try {
          await api.post(`/api/sales/entries/${id}/submit`);
        } catch (e: any) {
          toast.error(e?.message || "Saved but could not submit");
        }
      }
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // ── Item / payment line helpers
  function addItem() {
    setItems((prev) => [
      ...prev,
      {
        line_no: prev.length + 1,
        item_code: "",
        item_description: "",
        remarks: "",
        qty: "1",
        unit_price: "0",
        amount: "0",
        group_tag: "",
      },
    ]);
  }
  function updateItem(idx: number, patch: Partial<SalesItemLine>) {
    setItems((prev) => {
      const next = [...prev];
      const merged = { ...next[idx], ...patch };
      /* Auto-recompute amount when qty / unit_price change unless the user is
         typing into the amount field directly.

         When either input cannot be read we LEAVE the amount alone instead of
         writing "0.00" over it. The old `|| 0` did the opposite: a half-typed
         or pasted price stamped a confident RM 0.00 into the amount box, which
         then went to the server as the line total. Leaving the previous amount
         standing keeps the mistake visible and lets submit() name the field
         that is actually wrong. */
      if ("qty" in patch || "unit_price" in patch) {
        const q = parseQuantity(merged.qty);
        const u = parseMoneyToSen(merged.unit_price);
        if (q.ok && u.ok) {
          // Integer sen throughout: qty is scaled by 1000, price by 100, so the
          // product is scaled by 100000 and rounds back to sen exactly once.
          const amountSen = Math.round((q.sen * u.sen) / 1000);
          merged.amount = senToRm(amountSen).toFixed(2);
        }
      }
      next[idx] = merged;
      return next;
    });
  }
  function removeItem(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }
  function addPayment() {
    setPayments((prev) => [
      ...prev,
      {
        paid_at: today,
        payment_method: "" as PaymentType | "",
        amount: "",
        account_sheet: "",
        approval_code: "",
        collected_by: "",
      },
    ]);
  }
  function updatePayment(idx: number, patch: Partial<SalesPaymentLine>) {
    setPayments((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }
  function removePayment(idx: number) {
    setPayments((prev) => prev.filter((_, i) => i !== idx));
  }

  const headerStatus = (status1 || "Unchecked").toUpperCase();
  const fmtMoney = (n: number) => `RM ${n.toFixed(2)}`;
  const inputCls =
    "h-9 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:bg-bg/40 disabled:text-ink-muted";
  const selectCls = inputCls + " appearance-none";

  return (
    <Panel
      open
      onClose={onClose}
      title={
        <div className="flex items-baseline gap-2">
          <span className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
            {mode === "create" ? "New Customer" : (entry?.customer_name || "Edit Customer")}
          </span>
          <span className="text-[11px] text-ink-secondary">Sales Order</span>
          <span className="rounded-md bg-bg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
            {headerStatus}
          </span>
        </div>
      }
      subtitle={
        <span className="font-mono text-[11px] text-ink-muted">
          {docNo || (mode === "create" ? "(auto on save)" : "—")} · External ·{" "}
          {entry?.created_at ? formatDate(entry.created_at) : "just now"}
        </span>
      }
      width={1100}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-mono text-[11px] text-ink-muted">
            {items.length} line{items.length === 1 ? "" : "s"} ·{" "}
            <span className="text-ink">Total: <span className="font-bold">{fmtMoney(itemsTotal)}</span></span> ·{" "}
            <span className="text-ink">Paid: <span className="font-bold">{fmtMoney(paidTotal)}</span></span> ·{" "}
            <span className="text-ink">Balance: <span className="font-bold">{fmtMoney(balance)}</span></span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              onClick={() => submit(false)}
              disabled={busy || (!customerName.trim() && !isQuickLog)}
            >
              {busy ? "Saving…" : "Update Details"}
            </Button>
            <button
              onClick={onClose}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] text-ink-secondary hover:border-accent/40"
            >
              Cancel
            </button>
            <Button
              variant="ghost"
              onClick={() =>
                toast.info("AutoCount push lands in a follow-up slice")
              }
              disabled={busy}
            >
              Sales Order
            </Button>
          </div>
        </div>
      }
    >
      {/* Two-column header grid mirrors the boss mockup. */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 lg:grid-cols-2">
        {/* Left column */}
        <div className="space-y-3">
          <Field label="Order Date">
            <DateField fullWidth value={orderDate} onChange={(iso) => setOrderDate(iso)} className={inputCls}/>
          </Field>
          <Field label="Processing Date">
            <DateField
              fullWidth
              value={processingDate}
              onChange={(iso) => setProcessingDate(iso)}
              className={inputCls}
            />
          </Field>
          <Field label="Delivery Date">
            <DateField
              fullWidth
              value={deliveryDate}
              onChange={(iso) => setDeliveryDate(iso)}
              className={inputCls}
              placeholder="—"
            />
          </Field>
          <Field label="Status">
            <input value={status1} onChange={(e) => setStatus1(e.target.value)} placeholder="—" className={inputCls} />
          </Field>
          <Field label="Status 2">
            <input value={status2} onChange={(e) => setStatus2(e.target.value)} placeholder="MATTRESS/ACC" className={inputCls} />
          </Field>
          <Field label="Name">
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Customer name" className={inputCls} autoFocus />
          </Field>
          <Field label="Address">
            <input value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} placeholder="Street address" className={inputCls} />
          </Field>
          <Field label="Address 2">
            <input value={customerAddress2} onChange={(e) => setCustomerAddress2(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Postcode">
            <input value={customerPostcode} onChange={(e) => setCustomerPostcode(e.target.value)} placeholder="47180" className={inputCls} inputMode="numeric" />
          </Field>
          <Field label="State">
            <select value={customerState} onChange={(e) => setCustomerState(e.target.value)} className={selectCls}>
              <option value="">— select —</option>
              {STATE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Contact No">
            <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="+60..." inputMode="tel" className={inputCls} />
          </Field>
          <Field label="Contact No 2">
            <input value={customerPhone2} onChange={(e) => setCustomerPhone2(e.target.value)} inputMode="tel" className={inputCls} />
          </Field>
          <Field label="Email">
            <input value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} type="email" className={inputCls} />
          </Field>
          <Field label="Venue">
            <input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Fair / Mall name" className={inputCls} />
          </Field>
          <Field label="Warehouse">
            <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} className={selectCls}>
              {WAREHOUSE_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reference">
            <input value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="e.g. HC14087" className={inputCls + " font-mono"} />
          </Field>
          <Field label="Source">
            <select value={source} onChange={(e) => setSource(e.target.value)} className={selectCls}>
              {SOURCE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {/* Right column */}
        <div className="space-y-3">
          <Field label="Salesperson">
            <select value={salesPersonId} onChange={(e) => setSalesPersonId(e.target.value)} className={selectCls}>
              <option value="">— me —</option>
              {(usersQ.data?.users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Branding">
            <select value={branding} onChange={(e) => setBranding(e.target.value)} className={selectCls}>
              <option value="">— select —</option>
              {(brandsQ.data?.data ?? []).map((b) => (
                <option key={b.id} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Debtor Code">
            <input value={customerCode} onChange={(e) => setCustomerCode(e.target.value)} placeholder="300-C001" className={inputCls + " font-mono"} />
          </Field>
          <Field label="PO Doc No.">
            <input value={poDocNo} onChange={(e) => setPoDocNo(e.target.value)} className={inputCls + " font-mono"} />
          </Field>
          <Field label="Payment Status">
            <select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} className={selectCls}>
              {PAYMENT_STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className={inputCls + " min-h-[70px] resize-y py-2"}
              placeholder="Anything the accounts team should know"
            />
          </Field>
          {/* Project picker — preserved (locked or selectable). Keeps the
              quick-log + in-project flow working even though the boss
              mockup doesn't show this field. */}
          <Field label="Project">
            {lockedProjectId ? (
              <div className="flex h-9 items-center rounded-md border border-border bg-bg/40 px-3 text-[12px] text-ink-secondary">
                {lockedProjectLabel || `Project #${lockedProjectId}`}
              </div>
            ) : (
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={selectCls}>
                <option value="">— none —</option>
                {(projectsQ.data?.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Currency">
            <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className={inputCls + " font-mono uppercase"} />
          </Field>
        </div>
      </div>

      {/* Items section */}
      <div className="mt-6 rounded-md border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Items</h3>
          <button
            type="button"
            onClick={addItem}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
          >
            + Add Line
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <thead className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
              <tr>
                <th className="px-2 py-1.5 text-left font-semibold">No</th>
                <th className="px-2 py-1.5 text-left font-semibold">Item</th>
                <th className="px-2 py-1.5 text-left font-semibold">Remarks</th>
                <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
                <th className="px-2 py-1.5 text-right font-semibold">Unit Price</th>
                <th className="px-2 py-1.5 text-right font-semibold">Amount</th>
                <th className="px-2 py-1.5 text-left font-semibold">Group</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-[11px] text-ink-muted">
                    No lines yet — click "+ Add Line" to add one.
                  </td>
                </tr>
              )}
              {items.map((it, idx) => (
                <tr key={idx}>
                  <td className="px-2 py-1.5 text-ink-muted">{idx + 1}</td>
                  <td className="px-2 py-1.5">
                    <input
                      value={it.item_code}
                      onChange={(e) => updateItem(idx, { item_code: e.target.value })}
                      placeholder="Click to select / type to search…"
                      className="h-7 w-full rounded border border-transparent bg-transparent px-2 text-[11.5px] outline-none focus:border-border focus:bg-surface"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={it.remarks}
                      onChange={(e) => updateItem(idx, { remarks: e.target.value })}
                      placeholder="Type remarks…"
                      className="h-7 w-full rounded border border-transparent bg-transparent px-2 text-[11.5px] outline-none focus:border-border focus:bg-surface"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      step="any"
                      value={it.qty}
                      onChange={(e) => updateItem(idx, { qty: e.target.value })}
                      className="h-7 w-16 rounded border border-border bg-surface px-2 text-right text-[11.5px]"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      step="0.01"
                      value={it.unit_price}
                      onChange={(e) => updateItem(idx, { unit_price: e.target.value })}
                      className="h-7 w-24 rounded border border-border bg-surface px-2 text-right text-[11.5px]"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono font-bold">
                    <input
                      type="number"
                      step="0.01"
                      value={it.amount}
                      onChange={(e) => updateItem(idx, { amount: e.target.value })}
                      className="h-7 w-24 rounded border border-transparent bg-transparent px-2 text-right text-[11.5px] outline-none focus:border-border focus:bg-surface"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={it.group_tag}
                      onChange={(e) => updateItem(idx, { group_tag: e.target.value })}
                      placeholder="MATTRESS"
                      className="h-7 w-24 rounded border border-transparent bg-transparent px-2 text-[10px] font-bold uppercase outline-none focus:border-border focus:bg-surface"
                    />
                  </td>
                  <td className="px-1 py-1.5">
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      title="Remove line"
                      className="text-ink-muted hover:text-err"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length > 0 && (
                <tr className="font-bold">
                  <td colSpan={5} className="px-2 py-1.5 text-right text-ink">Subtotal</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(itemsTotal)}</td>
                  <td colSpan={2} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Remarks */}
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field label="Remarks">
          <input value={remarks} onChange={(e) => setRemarks(e.target.value)} className={inputCls} placeholder="—" />
        </Field>
        <Field label="Total">
          <div className="flex h-9 items-center rounded-md border border-border bg-bg/40 px-3 font-mono text-[13px] font-bold text-ink">
            {fmtMoney(itemsTotal)}
          </div>
        </Field>
      </div>

      {/* Payments section */}
      <div className="mt-6 rounded-md border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Payments</h3>
          <button
            type="button"
            onClick={addPayment}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
          >
            + Add Payment
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <thead className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
              <tr>
                <th className="px-2 py-1.5 text-left font-semibold">Date</th>
                <th className="px-2 py-1.5 text-left font-semibold">Payment Method</th>
                <th className="px-2 py-1.5 text-right font-semibold">Amount</th>
                <th className="px-2 py-1.5 text-left font-semibold">Account Sheet</th>
                <th className="px-2 py-1.5 text-left font-semibold">Approval Code</th>
                <th className="px-2 py-1.5 text-left font-semibold">Collected By</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {payments.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-[11px] text-ink-muted">
                    No payments recorded yet · click "Add Payment" to log a deposit
                  </td>
                </tr>
              )}
              {payments.map((p, idx) => (
                <tr key={idx}>
                  <td className="px-2 py-1.5">
                    <DateField
                      fullWidth
                      value={p.paid_at}
                      onChange={(iso) => updatePayment(idx, { paid_at: iso })}
                      className="h-7 rounded border border-border bg-surface px-2 text-[11.5px]"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      value={p.payment_method}
                      onChange={(e) => updatePayment(idx, { payment_method: e.target.value as PaymentType })}
                      className="h-7 rounded border border-border bg-surface px-2 text-[11.5px]"
                    >
                      <option value="">—</option>
                      {(Object.keys(PAYMENT_TYPE_LABEL) as PaymentType[]).map((k) => (
                        <option key={k} value={k}>
                          {PAYMENT_TYPE_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      step="0.01"
                      value={p.amount}
                      onChange={(e) => updatePayment(idx, { amount: e.target.value })}
                      className="h-7 w-24 rounded border border-border bg-surface px-2 text-right text-[11.5px]"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={p.account_sheet}
                      onChange={(e) => updatePayment(idx, { account_sheet: e.target.value })}
                      className="h-7 w-full rounded border border-transparent bg-transparent px-2 text-[11.5px] outline-none focus:border-border focus:bg-surface"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={p.approval_code}
                      onChange={(e) => updatePayment(idx, { approval_code: e.target.value })}
                      className="h-7 w-full rounded border border-transparent bg-transparent px-2 text-[11.5px] outline-none focus:border-border focus:bg-surface"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={p.collected_by}
                      onChange={(e) => updatePayment(idx, { collected_by: e.target.value })}
                      className="h-7 w-full rounded border border-transparent bg-transparent px-2 text-[11.5px] outline-none focus:border-border focus:bg-surface"
                    />
                  </td>
                  <td className="px-1 py-1.5">
                    <button
                      type="button"
                      onClick={() => removePayment(idx)}
                      title="Remove payment"
                      className="text-ink-muted hover:text-err"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
              {payments.length > 0 && (
                <>
                  <tr className="text-[11px]">
                    <td colSpan={2} className="px-2 py-1.5 text-right text-ink-secondary">Deposit Paid</td>
                    <td className="px-2 py-1.5 text-right font-mono font-bold">{fmtMoney(paidTotal)}</td>
                    <td colSpan={4} />
                  </tr>
                  <tr className="text-[11px]">
                    <td colSpan={2} className="px-2 py-1.5 text-right text-ink-secondary">Balance</td>
                    <td className="px-2 py-1.5 text-right font-mono font-bold text-synced">{fmtMoney(balance)}</td>
                    <td colSpan={4} />
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {udfFields.length > 0 && (
        <PanelSection title="Extra fields">
          {udfFields
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((f) => (
              <DynamicField
                key={f.key}
                field={f}
                value={custom[f.key] ?? ""}
                onChange={(v) =>
                  setCustom((prev) => {
                    const next = { ...prev };
                    if (v === "" || v == null) delete next[f.key];
                    else next[f.key] = v;
                    return next;
                  })
                }
              />
            ))}
        </PanelSection>
      )}

      {/* Edit history (sales_entry_activity) — who created / edited this entry, when. */}
      {mode === "edit" && activity.length > 0 && (
        <PanelSection title={`Edit history (${activity.length})`}>
          <div className="space-y-1 font-mono text-[11px]">
            {activity.map((a) => {
              const label =
                a.action === "created"
                  ? "Created by"
                  : a.action === "submitted"
                    ? "Submitted by"
                    : a.action === "unsubmitted"
                      ? "Unsubmitted by"
                      : a.action === "voided"
                        ? "Voided by"
                        : a.action === "pushed"
                          ? "Pushed by"
                          : "Edited by";
              return (
                <div key={a.id} className="flex items-center gap-2 text-ink-secondary">
                  <span className="w-28 shrink-0 font-semibold text-ink">{label}</span>
                  <span className="flex-1 truncate">{a.user_name || "Unknown"}</span>
                  <span className="shrink-0 text-ink-muted">{formatDateTime(a.created_at)}</span>
                </div>
              );
            })}
          </div>
        </PanelSection>
      )}
    </Panel>
  );
}

// ── Field shell — icon-prefixed label like the boss mockup ─
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-3">
      <label className="text-right text-[11px] font-semibold text-ink-secondary">
        {label}
      </label>
      <div>{children}</div>
    </div>
  );
}

// ── Static option lists (V1 — promote to lookup tables later) ───
const STATE_OPTIONS = [
  "Selangor",
  "Kuala Lumpur",
  "Putrajaya",
  "Johor",
  "Penang",
  "Perak",
  "Pahang",
  "Kedah",
  "Kelantan",
  "Terengganu",
  "Negeri Sembilan",
  "Melaka",
  "Perlis",
  "Sabah",
  "Sarawak",
  "Labuan",
  "Singapore",
];
const WAREHOUSE_OPTIONS = ["KL", "JB", "PG", "SBH", "SWK", "SG"];
const SOURCE_OPTIONS = ["External", "Walk-in", "Online", "Referral", "Event"];
const PAYMENT_STATUS_OPTIONS = ["Unchecked", "Partial", "Paid", "Refunded"];

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
      {children}
    </label>
  );
}

function DynamicField({
  field,
  value,
  onChange,
}: {
  field: UdfField;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label>{field.label}</Label>
      {field.type === "text" && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
        />
      )}
      {field.type === "number" && (
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
        />
      )}
      {field.type === "date" && (
        <DateField
          fullWidth
          value={value}
          onChange={(iso) => onChange(iso)}
          className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
        />
      )}
      {field.type === "select" && (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full appearance-none rounded-md border border-border bg-surface px-3 text-[13px]"
        >
          <option value="">— select —</option>
          {(field.options || []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}
      {field.type === "checkbox" && (
        <label className="mt-1 inline-flex items-center gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={value === "1" || value === "true"}
            onChange={(e) => onChange(e.target.checked ? "1" : "")}
            className="h-4 w-4 accent-accent"
          />
          Yes
        </label>
      )}
    </div>
  );
}

// ── Field configuration panel (admin-only) ───────────────────

function FieldConfigPanel({
  udf,
  onClose,
}: {
  udf: ReturnType<typeof useUdf>;
  onClose: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<UdfFieldType>("text");
  const [newOptions, setNewOptions] = useState("");
  const [busy, setBusy] = useState(false);

  async function addField() {
    const key = newKey.trim().toLowerCase();
    const label = newLabel.trim();
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) {
      toast.error("Key must be snake_case, start with a letter");
      return;
    }
    if (!label) {
      toast.error("Label is required");
      return;
    }
    const opts =
      newType === "select"
        ? newOptions
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    if (newType === "select" && (!opts || opts.length === 0)) {
      toast.error("Add at least one option");
      return;
    }
    setBusy(true);
    try {
      await udf.addField({ key, label, type: newType, options: opts });
      setNewKey("");
      setNewLabel("");
      setNewOptions("");
      setNewType("text");
      toast.success(`Added "${label}"`);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeField(key: string, label: string) {
    if (
      !(await dialog.confirm(
        `Delete field "${label}"? Values on existing entries will also be removed.`
      ))
    )
      return;
    try {
      await udf.deleteField(key);
      toast.success(`Removed "${label}"`);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title="Sales Fields"
      subtitle="Control what extra information reps are asked for"
      width={440}
    >
      <PanelSection title={`Existing fields (${udf.fields.length})`}>
        {udf.fields.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-bg/40 px-3 py-4 text-center text-[11px] text-ink-muted">
            No extra fields configured. The form will only ask for the
            built-in customer / amount / date / project / notes.
          </div>
        ) : (
          <div className="space-y-1.5">
            {udf.fields
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((f) => (
                <div
                  key={f.key}
                  className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold text-ink">
                      {f.label}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                      {f.key} · {f.type}
                      {f.type === "select" && f.options && (
                        <> · [{f.options.join(", ")}]</>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => removeField(f.key, f.label)}
                    className="rounded p-1.5 text-ink-muted hover:bg-err/10 hover:text-err"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
          </div>
        )}
      </PanelSection>

      <PanelSection title="Add field">
        <div>
          <Label>Key (snake_case)</Label>
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.toLowerCase())}
            placeholder="e.g. po_number"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-[12px]"
          />
        </div>
        <div>
          <Label>Label</Label>
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g. Customer PO Number"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
          />
        </div>
        <div>
          <Label>Type</Label>
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as UdfFieldType)}
            className="h-10 w-full appearance-none rounded-md border border-border bg-surface px-3 text-[13px]"
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="select">Select (dropdown)</option>
            <option value="checkbox">Checkbox (yes/no)</option>
          </select>
        </div>
        {newType === "select" && (
          <div>
            <Label>Options (comma-separated)</Label>
            <input
              value={newOptions}
              onChange={(e) => setNewOptions(e.target.value)}
              placeholder="Cash, Card, Bank transfer"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
            />
          </div>
        )}
        <div className="pt-1">
          <Button variant="brass" onClick={addField} disabled={busy} className="w-full">
            {busy ? "Adding…" : "Add field"}
          </Button>
        </div>
      </PanelSection>
    </Panel>
  );
}

// ── Approvals queue (Director) ───────────────────────────────
// Pending edit-approval requests: each parked rep edit shows what it touches;
// Approve re-applies it to the entry, Reject discards it.
function ApprovalsView({
  requests,
  loading,
  onChanged,
}: {
  requests: ChangeRequest[] | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);

  async function decide(req: ChangeRequest, action: "approve" | "reject") {
    setBusyId(req.id);
    try {
      await api.post(`/api/sales/entries/change-requests/${req.id}/${action}`);
      toast.success(
        action === "approve"
          ? `Approved — ${req.doc_no || req.customer_name || "entry"} updated`
          : "Change rejected",
      );
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading && !requests) {
    return <div className="py-10 text-center text-[12px] text-ink-muted">Loading…</div>;
  }
  if (!requests || requests.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center text-[12px] text-ink-muted shadow-stone">
        No edits are waiting for approval.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {requests.map((req) => (
        <div
          key={req.id}
          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-stone"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
              <Clock size={13} className="shrink-0 text-amber-500" />
              <span className="truncate">
                {req.doc_no || "—"} · {req.customer_name || "Unknown customer"}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-ink-muted">
              {req.requested_by_name || "A rep"} wants to change:{" "}
              <span className="text-ink">{req.summary || "(no fields)"}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              disabled={busyId === req.id}
              onClick={() => decide(req, "reject")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-semibold text-ink-muted hover:border-err/40 hover:bg-err/10 hover:text-err disabled:opacity-50"
            >
              <X size={12} /> Reject
            </button>
            <button
              disabled={busyId === req.id}
              onClick={() => decide(req, "approve")}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
            >
              <Check size={12} /> Approve
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
