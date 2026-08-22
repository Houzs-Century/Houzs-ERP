// DeliveryOrderNewV2 — Theme C ("Ink & Petrol") design of the New Delivery
// Order form, matching the 2026-07-08 handoff prototype.
//
// Composition mirrors the DO detail V2 chrome (sticky header, section cards,
// same colour tokens) but every section is an editable form group. A DO is
// created by CONVERTING a Sales Order: when the user opens the page with
// ?fromSo=<SO-doc-no>, the SO detail hook prefills the customer, address,
// emergency contact, and — when it arrived from the line-level SO→DO picker
// (?fromPicks=1) — the picked LINES, variants and all, from the
// the scoped `doFromSoPicks` handoff. Editing an existing DO with ?edit=<id>
// prefills from the DO itself and SAVES IN PLACE (header PATCH + per-line
// add/update/delete diff) instead of minting a duplicate.
//
// Line items use the SHARED SoLineCard (the same component SO New / Edit
// mount) so bedframe (Fabrics / Gaps / Divan / Leg) + sofa (Fabrics / Seat /
// Leg) + Special Orders carry the correct taxonomy — no hand-rolled picker.
//
// Section order (matches the prototype):
//   1. Document flow — inline node card (5-node chain, current DO is brass)
//   2. Customer info    — name / phone / email / customer type / salesperson +
//                          Customer SO ref
//   3. Delivery address — line1/2 + state/city/postcode/sales location
//   4. Emergency contact — name / relationship / phone
//   5. Delivery info     — DO date / driver / vehicle / building type + venue /
//                          expected / customer delivery / note
//   6. Line items        — shared SoLineCard list
//
// Route: /scm/delivery-orders/new (App.tsx flips ScmDeliveryOrderNewV2 here).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight as ArrowRightIcon,
  Plus,
  X as XIcon,
  Save,
  CheckCircle2,
  RefreshCw,
  ShoppingCart,
} from "lucide-react";
import { Button } from "../../components/Button";
import {
  useCreateMfgDeliveryOrder,
  useMfgDeliveryOrderDetail,
  useUpdateMfgDeliveryOrderHeader,
  useAddMfgDeliveryOrderItem,
  useUpdateMfgDeliveryOrderItem,
  useDeleteMfgDeliveryOrderItem,
  useSoConversionSource,
  useDeliverableSoLinesForDoc,
} from "../../vendor/scm/lib/delivery-order-queries";
import { useIdempotencyKey } from "../../lib/idempotency";
import { readScmHandoff, removeScmHandoff } from "../../lib/scmHandoffStorage";
import { useSoDropdownOptions, optionsOrFallback } from "../../vendor/scm/lib/so-dropdown-options-queries";
import {
  SoLineCard,
  emptySoLine,
  type SoLineDraft,
} from "../../vendor/scm/components/SoLineCard";
import type { MfgProductRow } from "../../vendor/scm/lib/mfg-products-queries";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { notifyAcNotSent } from "../../vendor/scm/lib/ac-not-sent";
import { cn } from "../../lib/utils";
import { usePickableStaff } from "../../vendor/scm/lib/admin-queries";
import { useDebtorSearch, type DebtorSuggestion } from "../../vendor/scm/lib/sales-order-queries";
import { DebtorSuggestList } from "../../vendor/scm/components/DebtorSuggestList";
import { useDebouncedValue } from "../../vendor/scm/lib/hooks";
import { useStateWarehouseMappings } from "../../vendor/scm/lib/state-warehouse-queries";
import { splitE164, combineE164 } from "../../vendor/shared/phone";
import { DateField } from "../../vendor/scm/components/DateField";
import { fmtDate } from "../../vendor/shared/format";
import { warehouseLabel } from "../../vendor/scm/lib/warehouse-label";
import {
  seedFollowerVariants,
  seedableMasterVariants,
} from "../../vendor/scm/lib/so-variant-cascade";

// ─── Types ──────────────────────────────────────────────────────────────────

/* One DO line draft = the SHARED SoLineDraft (same variant taxonomy the SO
   uses) plus a stable React id and, in edit mode, the persisted item id used
   to diff add / update / delete against the loaded DO. */
type DoDraftLine = SoLineDraft & { rid: string; itemId?: string; soItemId?: string | null };

// ─── Helpers ────────────────────────────────────────────────────────────────

const todayIso = (): string => {
  const d = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

const isoToDmy = fmtDate;

/* Fresh empty DO line — the shared empty SO line + a stable rid so the local
   list can add / edit / diff inline (mirrors SalesOrderNew.newLine). */
const newDoLine = (deliveryDate: string | null = null): DoDraftLine => ({
  ...emptySoLine(),
  lineDeliveryDate: deliveryDate,
  lineDeliveryDateOverridden: false,
  rid: `dl${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});

// ─── Section card shell ────────────────────────────────────────────────────

function SectionCard({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="inline-block h-3.5 w-1 rounded-sm bg-primary" />
          <span className="font-mono text-[11px] font-bold uppercase tracking-brand text-ink">
            {title}
          </span>
        </div>
        {actions && (
          <div className="text-[11.5px] text-ink-muted">{actions}</div>
        )}
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

// ─── Form field ────────────────────────────────────────────────────────────

function Label({
  text,
  required,
}: {
  text: string;
  required?: boolean;
}) {
  return (
    <div className="mb-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
      {text}
      {required && <span className="ml-1 text-err">*</span>}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
  disabled?: boolean;
}) {
/* type="date" routes to DateField, not to a native date input: the native
   one renders in the OPERATING SYSTEM's locale, so the same field read
   DD/MM/YYYY on one machine and MM/DD/YYYY on another. Same ISO contract
   in and out. */
  if (type === "date") {
    return (
      <DateField value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} className={className} fullWidth/>
    );
  }
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        "h-10 w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-muted",
        "focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)]",
        "disabled:opacity-50",
        className
      )}
    />
  );
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 2,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)]"
    />
  );
}

function SelectInput({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full appearance-none rounded-lg border border-border bg-surface px-3 pr-8 text-[13.5px] text-ink outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)]"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted">
        ▾
      </span>
    </div>
  );
}

function PhoneInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  // The prefix box owns the country code, so the input holds only the national
  // digits. Seeded values arrive E.164 ("+60169691009"); showing them verbatim
  // rendered a double "+60 +60169691009". splitE164 strips the code for display,
  // combineE164 puts it back into storage form, so the stored value stays E.164
  // and the submit path is unchanged.
  const national = splitE164(value).national;
  return (
    <div className="flex items-stretch gap-1.5">
      <div className="inline-flex h-10 w-[86px] shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-[12px] font-semibold text-ink-secondary">
        MY +60
      </div>
      <TextInput
        value={national}
        onChange={(v) => onChange(combineE164("60", v))}
        placeholder={placeholder || "11-6155 6133"}
        className="flex-1"
      />
    </div>
  );
}

// ─── Document flow inline card (matches the detail Relationship Map modal
// layout scaled down for the form page's inline treatment) ─────────────────

function DocumentFlowStrip({ soDocNo }: { soDocNo: string | null }) {
  const nodes: Array<{
    type: string;
    doc: string;
    meta: string;
    state: "done" | "current" | "pending";
  }> = [
    {
      type: "Customer PO",
      doc: soDocNo ? "Linked to SO" : "Not linked",
      meta: soDocNo ? "" : "—",
      state: soDocNo ? "done" : "pending",
    },
    {
      type: "Sales Order",
      doc: soDocNo || "Not linked",
      meta: soDocNo ? "Source doc" : "—",
      state: soDocNo ? "done" : "pending",
    },
    {
      type: "Delivery Order",
      doc: "This DO",
      meta: "Draft",
      state: "current",
    },
    {
      type: "GRN",
      doc: "Not created",
      meta: "After delivery",
      state: "pending",
    },
    {
      type: "Sales Invoice",
      doc: "Not created",
      meta: "On completion",
      state: "pending",
    },
  ];

  return (
    <SectionCard
      title="Document flow"
      actions={<span>PO → SO → DO → GRN → Invoice</span>}
    >
      <div className="flex items-stretch gap-0 overflow-x-auto pb-1">
        {nodes.map((n, i) => {
          const cur = n.state === "current";
          const done = n.state === "done";
          const last = i === nodes.length - 1;
          return (
            <div
              key={n.type}
              className="flex flex-1 items-center"
              style={{ minWidth: 160 }}
            >
              <div
                className={cn(
                  "flex-1 rounded-xl px-3.5 py-3",
                  cur
                    ? "border-2 border-accent bg-accent-soft"
                    : done
                      ? "border border-primary/30 bg-primary-soft"
                      : "border border-border bg-surface-2"
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                      cur
                        ? "bg-accent text-white"
                        : done
                          ? "bg-primary text-white"
                          : "border border-border-strong bg-surface"
                    )}
                  >
                    {cur ? "◉" : done ? "✓" : ""}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-[9px] font-bold uppercase tracking-brand",
                      cur ? "text-accent-ink" : done ? "text-primary-ink" : "text-ink-muted"
                    )}
                  >
                    {n.type}
                  </span>
                </div>
                <div
                  className={cn(
                    "mt-2 truncate font-mono text-[12.5px] font-bold",
                    cur ? "text-accent-ink" : done ? "text-primary-ink" : "text-ink-muted"
                  )}
                >
                  {n.doc}
                </div>
                <div
                  className={cn(
                    "mt-0.5 truncate text-[11px]",
                    cur ? "text-accent-ink/80" : "text-ink-muted"
                  )}
                >
                  {n.meta}
                </div>
              </div>
              {!last && (
                <span
                  className={cn(
                    "shrink-0 px-2 text-[16px]",
                    done ? "text-primary" : "text-border-strong"
                  )}
                >
                  →
                </span>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─── From SO picker modal ──────────────────────────────────────────────────

function FromSoPickerModal({
  open,
  onClose,
  onPick,
  currentValue,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (soDocNo: string) => void;
  currentValue: string | null;
}) {
  const [value, setValue] = useState(currentValue ?? "");
  useEffect(() => {
    if (open) setValue(currentValue ?? "");
  }, [open, currentValue]);

  // Portal to <body> so `fixed` positioning latches to the viewport instead of
  // getting trapped inside an ancestor with `transform` / `filter` /
  // `will-change` (the Layout's overflow-hidden main pane triggers this on
  // mobile browsers).
  return createPortal(
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={cn(
          "fixed inset-0 z-[80] bg-ink/45 backdrop-blur-[1px] transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pull lines from a Sales Order"
        className={cn(
          "fixed left-1/2 top-[10vh] z-[81] flex w-[calc(100%-32px)] max-w-[440px] -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-surface shadow-slab transition-all duration-200",
          open ? "scale-100 opacity-100" : "pointer-events-none scale-[.97] opacity-0"
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="text-[15px] font-bold text-ink">From Sales Order</div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-muted hover:text-ink"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>
        <div className="p-5">
          <Label text="SO doc no." />
          <TextInput
            value={value}
            onChange={setValue}
            placeholder="SO-2607-009"
          />
          <div className="mt-1.5 text-[11.5px] text-ink-muted">
            Enter a Sales Order doc no. to prefill customer + lines from that SO.
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-2 px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<RefreshCw size={14} />}
            onClick={() => {
              if (value.trim()) onPick(value.trim());
            }}
          >
            Pull from SO
          </Button>
        </div>
      </div>
    </>,
    document.body
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export function DeliveryOrderNewV2() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  /* This page carried seven window.alert/confirm calls, two of which
     concatenated a raw error message into an OS-chrome box. The house dialog
     system is the standing rule for anything that reports an error. (Plain
     confirmation window.confirm's survive on a handful of other screens —
     clean copy, no error text — left for a dedicated dialog sweep.) */
  const askConfirm = useConfirm();
  const notify = useNotify();
  // Sales staff for the Salesperson picker (id-keyed, same source as the SO
  // form). We store the id (a Code), not the name string, so the DO matches SO/SI.
  const staffQ = usePickableStaff({ onlySales: true });
  const salesStaff = staffQ.data ?? [];
  // Populate the Sales-location picker from the real warehouse list (not hardcoded demos).
  const stateWarehousesQ = useStateWarehouseMappings();

  useSetBreadcrumbs([
    { label: "Delivery Orders", to: "/scm/delivery-orders" },
    { label: "New" },
  ]);

  const fromSoParam = params.get("fromSo") ?? params.get("so") ?? "";
  const fromPicks = params.get("fromPicks") === "1";
  const editId = params.get("edit") ?? "";

  const [soDocNo, setSoDocNo] = useState<string>(fromSoParam);
  /* The converter's OWN read of the source SO — cross-company, same columns and
     same mapping as POST /from-sos. Replaces useMfgSalesOrderDetail, which is
     company-scoped and 404'd for a mirrored 2990- SO, silently blanking every
     header field while the "Converted from" badge kept rendering. */
  const soSource = useSoConversionSource(soDocNo || null);
  /* Lines fallback for a bare ?fromSo= (no line-picker stash). Also cross-company,
     and semantically the right set: what is still UNDELIVERED on that SO. */
  const soLines = useDeliverableSoLinesForDoc(
    !editId && soDocNo && !fromPicks ? soDocNo : null,
  );
  const doDetail = useMfgDeliveryOrderDetail(editId || null);
  const createDo = useCreateMfgDeliveryOrder();
  /* One key for the one DO this page is open to raise (lib/idempotency.ts).
     This is the ROUTED desktop DO create (App.tsx:543 → /scm/delivery-orders/
     new); the V1 page above shares the same hook and mints its own key — a hook
     is not a call site, and protecting only one caller of a shared hook protects
     nobody who uses the other.

     Route-level form, navigates to the DO detail (or the list) on success, so
     the MOUNT is exactly one DO. Unused by the editId branch below, which
     PATCHes one existing DO and cannot duplicate. */
  const idemKey = useIdempotencyKey();
  const updateHeader = useUpdateMfgDeliveryOrderHeader();
  const addItem = useAddMfgDeliveryOrderItem();
  const updateItem = useUpdateMfgDeliveryOrderItem();
  const deleteItem = useDeleteMfgDeliveryOrderItem();

  // ── Form state ─────────────────────────────────────────────────────
  const [customerName, setCustomerName] = useState("");
  // The customer's CODE, captured by the debtor picker (like SO/SI). The name is
  // the human label beside it; the code is what the DO now stores.
  const [debtorCode, setDebtorCode] = useState("");
  const [customerSoRef, setCustomerSoRef] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [customerType, setCustomerType] = useState("");
  // Customer type from the live maintenance catalog (same as SO), not hardcoded.
  const customerTypeOpts = optionsOrFallback("customer_type", useSoDropdownOptions("customer_type").data);
  // Salesperson stored by ID (a Code), not a free-text name — matches SO/SI.
  const [salespersonId, setSalespersonId] = useState("");
  const [addr1, setAddr1] = useState("");
  const [addr2, setAddr2] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [salesLocation, setSalesLocation] = useState("");
  const [ecName, setEcName] = useState("");
  const [ecRelationship, setEcRelationship] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [doDate, setDoDate] = useState(todayIso());
  const [driver, setDriver] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [buildingType, setBuildingType] = useState("");
  const [venue, setVenue] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [customerDelDate, setCustomerDelDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DoDraftLine[]>(() => [newDoLine()]);
  const [soPickerOpen, setSoPickerOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [asDraft, setAsDraft] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  // Sales-location options come from the real state->warehouse mappings (each maps
  // to a warehouse code), not the two hardcoded demo rows the field used to carry —
  // those never matched the prefilled warehouse code, so a carried value rendered
  // as the empty placeholder. Keep any already-set value visible even if it is not
  // in the mapping list.
  const salesLocationOpts = useMemo(() => {
    const byValue = new Map<string, { value: string; label: string }>();
    for (const m of stateWarehousesQ.data?.mappings ?? []) {
      const w = m.warehouse;
      if (w?.code) byValue.set(w.code, { value: w.code, label: warehouseLabel(w) ?? w.code });
    }
    if (salesLocation && !byValue.has(salesLocation)) {
      byValue.set(salesLocation, { value: salesLocation, label: salesLocation });
    }
    return Array.from(byValue.values());
  }, [stateWarehousesQ.data, salesLocation]);

  // One-shot seed guards + the original-line signatures used to diff an edit.
  const [stashSeeded, setStashSeeded] = useState(false);
  const [editSeeded, setEditSeeded] = useState(false);
  const originalLinesRef = useRef<Map<string, string>>(new Map());

  // Flash toast
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1900);
    return () => clearTimeout(t);
  }, [flash]);

  // ── Item body — the shared shape create-items + add/update-item all send.
  const toDoItemBody = (l: DoDraftLine) => ({
    // Carry the SO line id so the backend links the DO line to its SO line —
    // the key the remaining-qty guard, the sofa batch guard and the drop-ship
    // batch stamping all resolve on. Dropping it made every SO-sourced sofa DO
    // that needs drop-ship hard-block (offenders resolved soItemId=null -> no PO).
    soItemId: l.soItemId ?? null,
    itemCode: l.itemCode,
    itemGroup: l.itemGroup,
    description: l.description,
    uom: l.uom,
    qty: l.qty,
    unitPriceSen: l.unitPriceSen,
    discountSen: l.discountSen,
    unitCostSen: l.unitCostSen,
    variants: l.variants,
    remark: l.remark,
    deliveryDate: l.lineDeliveryDate ?? "",
  });

  // ── SO→DO line stash (from the line-level picker) ──────────────────
  // DeliveryOrderFromSo stashes the picked SO lines — variants and all — under
  // `doFromSoPicks` and navigates here with ?fromPicks=1. Seed the line editors
  // from that stash so fabric / gaps / divan / leg / seat / specials survive the
  // hand-off (the old code re-prefilled variants:[] from the raw SO items and
  // dropped them). One-shot + consumed so a refresh starts clean.
  useEffect(() => {
    if (!fromPicks || stashSeeded) return;
    setStashSeeded(true);
    const stash = readScmHandoff<Array<Record<string, unknown>>>("doFromSoPicks") ?? [];
    removeScmHandoff("doFromSoPicks");
    if (Array.isArray(stash) && stash.length > 0) {
      setLines(
        stash.map((s) => ({
          ...newDoLine(null),
          soItemId: s.soItemId ? String(s.soItemId) : null,
          itemCode: String(s.itemCode ?? ""),
          itemGroup: String(s.itemGroup ?? "others"),
          description: String(s.description ?? ""),
          uom: String(s.uom ?? "UNIT"),
          qty: Number(s.qty ?? 1),
          unitPriceSen: Number(s.unitPriceSen ?? 0),
          discountSen: Number(s.discountSen ?? 0),
          unitCostSen: Number(s.unitCostSen ?? 0),
          variants:
            s.variants && typeof s.variants === "object"
              ? (s.variants as Record<string, unknown>)
              : {},
          remark: "",
        }))
      );
    }
  }, [fromPicks, stashSeeded]);

  // ── Prefill customer/delivery header from the SO (when converting) ─────
  // Reads the converter's own cross-company soSource (see the hook above), NOT
  // the company-scoped SO detail — otherwise a 2990-mirrored SO converted while
  // browsing as Houzs 404s and every customer field stays blank. Skipped in edit
  // mode — an existing DO prefills from itself, not from its parent SO.
  // Customer-name typeahead → captures the debtor CODE on pick (SO's pattern).
  const [showDebtorSuggest, setShowDebtorSuggest] = useState(false);
  const debtorInputRef = useRef<HTMLInputElement>(null);
  const debouncedCustomer = useDebouncedValue(customerName, 200);
  const debtorQ = useDebtorSearch(
    debouncedCustomer.trim().length >= 2 ? debouncedCustomer.trim() : "",
  );
  const debtorSuggestions: DebtorSuggestion[] = (debtorQ.data?.debtors ?? []).filter(
    (d) => (d.debtor_name ?? "").toLowerCase() !== customerName.trim().toLowerCase(),
  );
  const applyDebtorSuggestion = (d: DebtorSuggestion) => {
    setDebtorCode(d.debtor_code ?? "");
    setCustomerName(d.debtor_name ?? "");
    if (d.phone) setPhone(d.phone);
    setShowDebtorSuggest(false);
  };

  useEffect(() => {
    if (editId) return;
    const so = soSource.data?.source;
    if (!so || !soDocNo) return;
    /* `?? ""` here is a WRITE into a form field, not a cover for an unread value:
       soSource has already distinguished "absent at the source" (null, and named
       in `missing` below) from "we could not read the SO" (the query errors, and
       the banner says so). An empty input is the honest rendering of a field the
       source order genuinely does not carry. */
    setCustomerName(so.customerName ?? "");
    setDebtorCode(so.debtorCode ?? "");
    setCustomerSoRef(so.customerSoRef ?? "");
    setPhone(so.phone ?? "");
    setEmail(so.email ?? "");
    setCustomerType(so.customerType ?? "");
    setSalespersonId(so.salespersonId ?? "");
    setAddr1(so.address1 ?? "");
    setAddr2(so.address2 ?? "");
    setState(so.customerState ?? "");
    setCity(so.city ?? "");
    setPostcode(so.postcode ?? "");
    setSalesLocation(so.salesLocation ?? "");
    setBuildingType(so.buildingType ?? "");
    setVenue(so.venue ?? "");
    setFlash(`Prefilled from ${soDocNo}`);
  }, [soSource.data, soDocNo, editId]);

  /* The old raw-UUID-in-the-salesperson-field hazard is gone: the field is now a
     SELECT keyed on salespersonId, so a uuid can never leak into a name string
     the way the free-text input allowed. `agent` (legacy name) is derived from
     the picked staff on submit, never typed. */

  // Lines fallback — only when the line-level picker didn't hand a stash over.
  // Sourced from the SO's still-undeliverable remainder (cross-company, same as
  // the header), so a bare ?fromSo= on a mirrored 2990 SO carries its lines too.
  useEffect(() => {
    if (editId || fromPicks) return;
    const rows = soLines.data;
    if (!rows || rows.length === 0) return;
    setLines(
      rows.map((it) => ({
        ...newDoLine(null),
        soItemId: it.soItemId,
        itemCode: it.itemCode,
        itemGroup: it.itemGroup ?? "others",
        description: it.description ?? "",
        uom: it.uom ?? "UNIT",
        qty: it.remaining,
        unitPriceSen: it.unitPriceSen,
        discountSen: it.discountSen,
        unitCostSen: it.unitCostSen,
        variants:
          it.variants && typeof it.variants === "object"
            ? (it.variants as Record<string, unknown>)
            : {},
        remark: "",
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soLines.data, editId, fromPicks]);

  // ── Prefill from DO detail (when editing) ──────────────────────────
  // Seeds header + lines (with their persisted item id) once, and snapshots
  // each line's signature so the Save can diff add / update / delete.
  useEffect(() => {
    if (!editId || editSeeded) return;
    const doo = (doDetail.data as { deliveryOrder?: Record<string, unknown> } | undefined)?.deliveryOrder;
    if (!doo) return;
    setEditSeeded(true);
    setCustomerName(String(doo.debtor_name ?? ""));
    setDebtorCode(String(doo.debtor_code ?? ""));
    setCustomerSoRef(String((doo.customer_so_no ?? doo.po_doc_no ?? doo.ref ?? "") as string));
    setPhone(String(doo.phone ?? ""));
    setEmail(String(doo.email ?? ""));
    setCustomerType(String((doo.customer_type ?? "") as string));
    setSalespersonId(String(doo.salesperson_id ?? ""));
    setAddr1(String(doo.address1 ?? ""));
    setAddr2(String(doo.address2 ?? ""));
    setState(String(doo.customer_state ?? ""));
    setCity(String(doo.city ?? ""));
    setPostcode(String(doo.postcode ?? ""));
    setSalesLocation(String(doo.sales_location ?? ""));
    setEcName(String((doo.emergency_contact_name ?? "") as string));
    setEcRelationship(String((doo.emergency_contact_relationship ?? "") as string));
    setEcPhone(String((doo.emergency_contact_phone ?? "") as string));
    setDoDate(String(doo.do_date ?? todayIso()).slice(0, 10));
    setDriver(String((doo.driver_name ?? "") as string));
    setVehicle(String(doo.vehicle ?? ""));
    setBuildingType(String(doo.building_type ?? ""));
    setVenue(String(doo.venue ?? ""));
    setExpectedDate(String((doo.expected_delivery_at ?? "") as string).slice(0, 10));
    setCustomerDelDate(String((doo.customer_delivery_date ?? "") as string).slice(0, 10));
    setNote(String((doo.note ?? doo.notes ?? "") as string));
    setSoDocNo(String((doo.so_doc_no ?? "") as string));

    const items = (doDetail.data as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
    const seeded: DoDraftLine[] = items.map((it) => {
      const line: DoDraftLine = {
        ...newDoLine(
          String((it.delivery_date ?? it.line_delivery_date ?? "") as string).slice(0, 10) || null
        ),
        itemId: String(it.id ?? ""),
        itemCode: String(it.item_code ?? ""),
        itemGroup: String(it.item_group ?? "others"),
        description: String(it.description ?? ""),
        uom: String(it.uom ?? "UNIT"),
        qty: Number(it.qty ?? 1),
        unitPriceSen: Number(it.unit_price_sen ?? 0),
        discountSen: Number(it.discount_sen ?? 0),
        unitCostSen: Number(it.unit_cost_sen ?? 0),
        variants:
          it.variants && typeof it.variants === "object"
            ? (it.variants as Record<string, unknown>)
            : {},
        remark: String(it.remark ?? ""),
      };
      return line;
    });
    if (seeded.length > 0) {
      setLines(seeded);
      const sigs = new Map<string, string>();
      for (const l of seeded) {
        if (l.itemId) sigs.set(l.itemId, JSON.stringify(toDoItemBody(l)));
      }
      originalLinesRef.current = sigs;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doDetail.data, editId, editSeeded]);

  // ── Totals ─────────────────────────────────────────────────────────
  const totalQty = useMemo(
    () => lines.reduce((sum, l) => sum + (Number.isFinite(l.qty) ? l.qty : 0), 0),
    [lines]
  );

  // ── Sofa-set inherit — first line per category seeds followers on pick.
  //    The rule lives in vendor/scm/lib/so-variant-cascade, which is also
  //    where the never-inherited keys are named: a fresh line must not take
  //    the master's `buildKey` (that forges a sofa compartment on an
  //    unrelated line — free-gift trigger + PDF grouping) or its `remark`.
  //    This page seeds ONLY; unlike the SO pages it does not run the live
  //    cascade afterwards, and whether a delivery-order line should follow
  //    line 1 at all is an owner decision, not a defect to fix quietly. ──
  const inheritVariantsByCategory = useMemo(
    () => seedableMasterVariants(
      lines.map((l) => ({
        category: l.itemGroup ?? "",
        variants: (l.variants ?? {}) as Record<string, unknown>,
      })),
    ),
    [lines]
  );

  // ── Line ops ───────────────────────────────────────────────────────
  const addLine = () => {
    setLines((prev) => [...prev, newDoLine(customerDelDate || null)]);
  };
  const removeLine = (rid: string) => {
    setLines((prev) => prev.filter((l) => l.rid !== rid));
  };
  const updateLine = (rid: string, patch: Partial<SoLineDraft>) => {
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  };
  // Desktop multi-add parity — SoLineCard commits the first pick to its own
  // line and hands the rest here as fresh lines (same as SalesOrderNew).
  const addProducts = (rows: MfgProductRow[]) => {
    if (rows.length === 0) return;
    setLines((prev) => [
      ...prev,
      ...rows.map((p) => {
        const category = p.category.toLowerCase();
        const inherited = inheritVariantsByCategory[category];
        return {
          ...newDoLine(customerDelDate || null),
          itemCode: p.code,
          itemGroup: category,
          description: p.name,
          unitPriceSen: p.sell_price_sen ?? 0,
          variants: seedFollowerVariants(inherited),
        };
      }),
    ]);
  };

  // ── Submit — create ────────────────────────────────────────────────
  const buildHeaderBody = () => ({
    debtorName: customerName,
    debtorCode: debtorCode || undefined,
    phone,
    email,
    customerType,
    salespersonId: salespersonId || undefined,
    // Legacy name column, derived from the picked staff — never typed.
    agent: salesStaff.find((s) => s.id === salespersonId)?.name ?? "",
    address1: addr1,
    address2: addr2,
    customerState: state,
    city,
    postcode,
    salesLocation,
    emergencyContactName: ecName,
    emergencyContactRelationship: ecRelationship,
    emergencyContactPhone: ecPhone,
    doDate,
    driverName: driver,
    vehicle,
    buildingType,
    venue,
    expectedDeliveryAt: expectedDate,
    customerDeliveryDate: customerDelDate,
    note,
    customerSoNo: customerSoRef,
  });

  const validLines = () => lines.filter((l) => l.itemCode.trim() || l.description.trim());

  const buildBody = () => ({
    soDocNo: soDocNo || undefined,
    ...buildHeaderBody(),
    items: validLines().map(toDoItemBody),
  });

  const goCancel = async () => {
    if (await askConfirm({
      title: "Discard this delivery order?",
      body: "Nothing has been saved yet. Anything you have entered on this screen will be lost.",
      confirmLabel: "Discard",
      danger: true,
    })) {
      navigate("/scm/delivery-orders");
    }
  };
  const goList = () => navigate("/scm/delivery-orders");

  const doCreate = (draft: boolean) => {
    if (!customerName.trim()) {
      void notify({ title: "Customer name is required.", tone: "error" });
      return;
    }
    if (validLines().length === 0) {
      void notify({ title: 'Add at least one line item before saving.', tone: "error" });
      return;
    }
    setAsDraft(draft);
    createDo.mutate(
      /* asDraft is the ONLY field the create route reads to park a DO
         (`body.asDraft === true ? 'DRAFT' : 'LOADED'`); the `status` below is
         ignored by it. Sending only `status` shipped the DO: stock deducted and
         the SO synced delivered, while the flash said "Saved as draft". The
         unrouted V1 page had this right (DeliveryOrderNew.tsx:294) and this one
         never got it. The `status` value here has always been inert; since
         2026-08-22 the server independently agrees with what it asks for. */
      { ...buildBody(), idempotencyKey: idemKey, asDraft: draft || undefined, status: draft ? "DRAFT" : "LOADED" },
      {
        onSuccess: async (res) => {
          setFlash(draft ? "Saved as draft" : "Delivery order created");
          /* THE ACCOUNTS MAY HAVE IT WITHOUT ALL OF IT. A DO raised from a
             sales order is TRANSFERRED into AutoCount, and the transfer route
             applies a narrower set of header fields than an edit does — so the
             book can hold this delivery order with no reference and no date of
             its own. Said here, BEFORE the navigation, for the reason
             PurchaseOrderNew records: a route change tears the dialog down.
             Never blocks; the DO exists and the goods have gone. */
          await notifyAcNotSent(notify, res, "Delivery order");
          if (res?.id) {
            navigate(`/scm/delivery-orders/${res.id}`);
          } else {
            navigate("/scm/delivery-orders");
          }
        },
        onError: (err) => {
          /* authedFetch has already run the response through humanApiError, so
             this arrives as a plain sentence; re-mapping it here would be a
             second copy of that rule. The reassurance about the entered data is
             the part the operator actually needs — this create carries an
             idempotency key, so trying again is safe. */
          void notify({
            title: "Couldn't create this delivery order",
            body: `${err instanceof Error ? err.message : "Something went wrong."} Nothing was saved and your entries are still on this screen — please try again.`,
            tone: "error",
          });
          setAsDraft(false);
        },
      }
    );
  };

  // ── Submit — in-place edit (header PATCH + per-line add/update/delete) ─
  const doSaveEdit = async () => {
    if (!editId) return;
    if (!customerName.trim()) {
      void notify({ title: "Customer name is required.", tone: "error" });
      return;
    }
    const current = validLines();
    if (current.length === 0) {
      void notify({ title: 'Add at least one line item before saving.', tone: "error" });
      return;
    }
    setSavingEdit(true);
    try {
      // Diff the loaded DO's lines against the current editor state.
      const currentIds = new Set(
        lines.filter((l) => l.itemId).map((l) => l.itemId as string)
      );
      const removed = [...originalLinesRef.current.keys()].filter(
        (id) => !currentIds.has(id)
      );

      const ops: Array<Promise<unknown>> = [];
      for (const itemId of removed) {
        ops.push(deleteItem.mutateAsync({ id: editId, itemId }));
      }
      for (const l of current) {
        const body = toDoItemBody(l);
        if (l.itemId) {
          const orig = originalLinesRef.current.get(l.itemId);
          if (orig !== JSON.stringify(body)) {
            ops.push(updateItem.mutateAsync({ id: editId, itemId: l.itemId, ...body }));
          }
        } else {
          ops.push(addItem.mutateAsync({ id: editId, ...body }));
        }
      }
      // Lines first, then the header — mirrors SalesOrderDetail.saveEdit so a
      // header guard that reads the live line rows sees the fresh variants.
      await Promise.all(ops);
      await updateHeader.mutateAsync({ id: editId, ...buildHeaderBody() });
      setFlash("Delivery order updated");
      navigate(`/scm/delivery-orders/${editId}`);
    } catch (err) {
      /* NOT the same message as the create path. This save is a batch of line
         add/update/delete calls followed by the header PATCH, so a failure part
         way through means SOME line changes may already have landed. Telling the
         operator "try again" would be a confident lie about a state we did not
         verify — they must look before they re-save. */
      void notify({
        title: "Couldn't finish saving this delivery order",
        body: `${err instanceof Error ? err.message : "Something went wrong."} Some of your line changes may already have saved and some may not. Please refresh and check the delivery order before saving again.`,
        tone: "error",
      });
    } finally {
      setSavingEdit(false);
    }
  };

  const primarySubmit = () => (editId ? doSaveEdit() : doCreate(false));
  const secondarySubmit = () => (editId ? doSaveEdit() : doCreate(true));

  const submitting = createDo.isPending || savingEdit;

  return (
    <div className="pb-20">
      {/* Sticky form header + document flow.
          Owner 2026-08-03: the flow strip is frozen WITH the action bar, so the
          operator can see which SO this DO hangs off (and reach Create/Cancel)
          from anywhere down a long form. Keep them in ONE sticky box — two
          stacked sticky boxes would each pin at top:0 and overlap. */}
      {/* top-12 / lg:top-[52px] z-20 is the house offset for a page-level sticky
          (Layout.tsx, DetailLayout, AmendmentDetailV2, PoAmendmentDetailV2): the
          workspace tab strip in TopNavbar is itself `sticky top-0 z-30 h-[52px]`
          inside this same scroll container. This box was `top-0 z-10`, so it
          parked UNDER that strip and the strip painted over its first 52px —
          exactly the title row and the Cancel / Save as Draft / Create buttons.
          Freezing more content only made that clearer. */}
      <div className="sticky top-12 lg:top-[52px] z-20 -mx-4 border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              onClick={goList}
              aria-label="Back to Delivery Orders"
              className="mt-0.5 inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-semibold text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={14} /> Delivery Orders
            </button>
            <div className="min-w-0">
              <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                {editId ? "Edit Delivery Order" : "New Delivery Order"}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-secondary">
                <span>{editId ? "Editing · changes save in place" : "Draft · not yet saved"}</span>
                {soDocNo && (
                  <>
                    <span className="text-border-strong">·</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-accent-ink">
                      ⇄ Converted from{" "}
                      <b className="font-mono">{soDocNo}</b>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* THE FORM MUST NEVER LOOK FRESH WHEN IT IS ACTUALLY BROKEN.
              The badge above renders off the ?fromSo= STRING, so it kept saying
              "Converted from 2990-SO-2606-002" over a form whose every field was
              blank because the source read had 404'd. These two states now say
              which one they are. */}
          {!editId && soDocNo && soSource.isError && (
            <div
              role="alert"
              className="mt-3 rounded-md border border-err/40 bg-err-bg px-3.5 py-2.5 text-[12.5px] text-err"
            >
              <b>Could not read {soDocNo}.</b> Nothing has been copied across, so
              the fields below are blank — they are NOT the customer's details.
              Do not retype them by hand. Reload, or pick the sales order again.
            </div>
          )}
          {!editId && soDocNo && !soSource.isError && (soSource.data?.missing?.length ?? 0) > 0 && (
            <div
              role="status"
              className="mt-3 rounded-md border border-warning-text/25 bg-warning-bg px-3.5 py-2.5 text-[12.5px] text-warning-text"
            >
              <b>{soDocNo} does not carry:</b> {soSource.data?.missing.join(", ")}.
              These fields are blank because the sales order has no value for
              them — fill them in from the customer, not from memory.
            </div>
          )}
          {/* Right actions — no-wrap */}
          <div className="flex flex-shrink-0 flex-nowrap items-center gap-2">
            <Button
              variant="ghost"
              icon={<RefreshCw size={14} />}
              onClick={() => setSoPickerOpen(true)}
              className="whitespace-nowrap"
            >
              From Sales Order
            </Button>
            <Button
              variant="ghost"
              icon={<XIcon size={14} />}
              onClick={goCancel}
              className="whitespace-nowrap"
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              icon={<Save size={14} />}
              onClick={secondarySubmit}
              disabled={submitting}
              className="whitespace-nowrap"
            >
              {editId
                ? savingEdit
                  ? "Saving…"
                  : "Save changes"
                : asDraft && submitting
                  ? "Saving…"
                  : "Save as Draft"}
            </Button>
            <Button
              variant="primary"
              icon={<CheckCircle2 size={14} />}
              onClick={primarySubmit}
              disabled={submitting}
              className="whitespace-nowrap"
            >
              {editId
                ? savingEdit
                  ? "Saving…"
                  : "Save changes"
                : !asDraft && submitting
                  ? "Creating…"
                  : "Create Delivery Order"}
            </Button>
          </div>
        </div>

        {/* Document flow — frozen with the header (see note above) */}
        <div className="mt-4">
          <DocumentFlowStrip soDocNo={soDocNo || null} />
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-5 py-6">
        {/* Customer info */}
        <SectionCard title="Customer info">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_340px]">
            <div>
              <Label text="Customer name" required />
              <input
                ref={debtorInputRef}
                value={customerName}
                onChange={(e) => { setCustomerName(e.target.value); setDebtorCode(""); setShowDebtorSuggest(true); }}
                onFocus={() => setShowDebtorSuggest(true)}
                onBlur={() => setTimeout(() => setShowDebtorSuggest(false), 150)}
                placeholder="e.g. Lim Mei Hua"
                className={cn(
                  "h-10 w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-muted",
                  "focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)]",
                )}
              />
              <DebtorSuggestList
                anchorRef={debtorInputRef}
                open={showDebtorSuggest}
                suggestions={debtorSuggestions}
                onPick={applyDebtorSuggestion}
                classes={{
                  list: "z-50 m-0 max-h-[260px] list-none overflow-auto rounded-lg border border-border bg-surface py-1 text-[13px] shadow-lg",
                  item: "cursor-pointer px-3 py-1.5 text-ink hover:bg-canvas",
                  code: "text-[11px] text-ink-muted",
                }}
              />
            </div>
            <div>
              <Label text="Customer SO ref" />
              <TextInput
                value={customerSoRef}
                onChange={setCustomerSoRef}
                placeholder="Their PO / SO number"
              />
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <Label text="Phone" required />
              <PhoneInput value={phone} onChange={setPhone} />
            </div>
            <div>
              <Label text="Email" />
              <TextInput
                value={email}
                onChange={setEmail}
                placeholder="customer@example.com"
              />
            </div>
            <div>
              <Label text="Customer type" />
              <SelectInput
                value={customerType}
                onChange={setCustomerType}
                placeholder="—"
                options={customerTypeOpts}
              />
            </div>
            <div>
              <Label text="Salesperson" />
              <SelectInput
                value={salespersonId}
                onChange={setSalespersonId}
                placeholder="—"
                options={salesStaff.map((s) => ({ value: s.id, label: `${s.name} (${s.staffCode})` }))}
              />
            </div>
          </div>
        </SectionCard>

        {/* Delivery address */}
        <SectionCard title="Delivery address">
          <div className="flex flex-col gap-4">
            <div>
              <Label text="Address line 1" />
              <TextInput
                value={addr1}
                onChange={setAddr1}
                placeholder="Unit, street, area"
              />
            </div>
            <div>
              <Label text="Address line 2" />
              <TextInput
                value={addr2}
                onChange={setAddr2}
                placeholder="Apt, floor, building (optional)"
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div>
                <Label text="State" />
                <TextInput
                  value={state}
                  onChange={setState}
                  placeholder="Pick state"
                />
              </div>
              <div>
                <Label text="City" />
                <TextInput
                  value={city}
                  onChange={setCity}
                  placeholder="Pick city"
                />
              </div>
              <div>
                <Label text="Postcode" />
                <TextInput
                  value={postcode}
                  onChange={setPostcode}
                  placeholder="Pick postcode"
                />
              </div>
              <div>
                <Label text="Sales location" />
                <SelectInput
                  value={salesLocation}
                  onChange={setSalesLocation}
                  placeholder="—"
                  options={salesLocationOpts}
                />
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Emergency contact */}
        <SectionCard
          title="Emergency contact"
          actions={
            <span>Used only if we cannot reach the customer on delivery day</span>
          }
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <Label text="Contact name" />
              <TextInput
                value={ecName}
                onChange={setEcName}
                placeholder="e.g. Lim Mei Hua"
              />
            </div>
            <div>
              <Label text="Relationship" />
              <SelectInput
                value={ecRelationship}
                onChange={setEcRelationship}
                placeholder="—"
                options={[
                  { value: "Spouse", label: "Spouse" },
                  { value: "Family", label: "Family" },
                  { value: "Colleague", label: "Colleague" },
                  { value: "Self", label: "Self (customer)" },
                ]}
              />
            </div>
            <div>
              <Label text="Phone" />
              <PhoneInput value={ecPhone} onChange={setEcPhone} />
            </div>
          </div>
        </SectionCard>

        {/* Delivery info */}
        <SectionCard title="Delivery info">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <Label text="DO date" />
              <TextInput
                value={doDate}
                onChange={setDoDate}
                type="date"
              />
            </div>
            <div>
              <Label text="Driver" />
              <TextInput
                value={driver}
                onChange={setDriver}
                placeholder="Pick driver…"
              />
            </div>
            <div>
              <Label text="Vehicle" />
              <TextInput
                value={vehicle}
                onChange={setVehicle}
                placeholder="Lorry plate no."
              />
            </div>
            <div>
              <Label text="Building type" />
              <SelectInput
                value={buildingType}
                onChange={setBuildingType}
                placeholder="—"
                options={[
                  { value: "Landed", label: "Landed" },
                  { value: "High-rise (lift)", label: "High-rise (lift)" },
                  { value: "High-rise (no lift)", label: "High-rise (no lift)" },
                ]}
              />
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <Label text="Venue" />
              <TextInput
                value={venue}
                onChange={setVenue}
                placeholder="Residence / site"
              />
            </div>
            <div>
              <Label text="Expected delivery" />
              <TextInput
                value={expectedDate}
                onChange={setExpectedDate}
                type="date"
              />
            </div>
            <div>
              <Label text="Customer delivery date" />
              <TextInput
                value={customerDelDate}
                onChange={setCustomerDelDate}
                type="date"
              />
            </div>
          </div>
          <div className="mt-4">
            <Label text="Note" />
            <TextArea
              value={note}
              onChange={setNote}
              placeholder="Internal notes — visible on the DO detail page only"
            />
          </div>
        </SectionCard>

        {/* Line items — shared SoLineCard (bedframe / sofa / specials taxonomy) */}
        <SectionCard
          title={`Line items · ${lines.length}`}
          actions={<span>Pick a product, then set its variant</span>}
        >
          <div className="flex flex-col gap-3">
            {lines.map((line, idx) => (
              <SoLineCard
                key={line.rid}
                index={idx}
                draft={line}
                onChange={(patch) => updateLine(line.rid, patch)}
                onRemove={() => removeLine(line.rid)}
                canRemove={lines.length > 1}
                inheritVariantsByCategory={inheritVariantsByCategory}
                onAddProducts={addProducts}
                /* A DO delivers items already specified on the SO, so the
                   category-mandatory variants are NOT re-required here (they
                   ride in from the SO stash / DO detail). */
                variantsRequired={false}
              />
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              onClick={addLine}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-border-strong bg-surface px-4 text-[13px] font-semibold text-primary-ink hover:border-primary/60 hover:bg-primary-soft"
            >
              <Plus size={14} /> Add line
            </button>
            <div className="text-right">
              <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Total items
              </div>
              <div className="mt-0.5 font-money text-[18px] font-bold text-ink">
                {totalQty}
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Bottom action strip — mirrors sticky header, for tall pages */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="text-[11.5px] text-ink-muted">
            {lines.length} line{lines.length === 1 ? "" : "s"} · {totalQty} unit
            {totalQty === 1 ? "" : "s"}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<Save size={14} />}
              onClick={secondarySubmit}
              disabled={submitting}
            >
              {editId ? "Save changes" : "Save as Draft"}
            </Button>
            <Button
              variant="primary"
              icon={<CheckCircle2 size={14} />}
              onClick={primarySubmit}
              disabled={submitting}
            >
              {editId ? "Save changes" : "Create Delivery Order"}
            </Button>
          </div>
        </div>
      </div>

      {/* From SO picker modal */}
      <FromSoPickerModal
        open={soPickerOpen}
        onClose={() => setSoPickerOpen(false)}
        onPick={(docNo) => {
          setSoDocNo(docNo);
          setSoPickerOpen(false);
        }}
        currentValue={soDocNo}
      />

      {/* Flash toast */}
      {flash && (
        <div className="fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-lg bg-sidebar px-4 py-2.5 text-[13px] font-semibold text-white shadow-slab">
          {flash}
        </div>
      )}
    </div>
  );
}

// Unused imports guard — reference the icons that may not appear in every code
// path so a future drift doesn't leave them dangling.
void ArrowRightIcon;
void ShoppingCart;
void isoToDmy;

export default DeliveryOrderNewV2;
