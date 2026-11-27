
import { DO_SPEC_LOCKED_MESSAGE, doSpecLocked } from '../../vendor/shared/do-spec-lock';
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight as ArrowRightIcon,
  X as XIcon,
  Save,
  CheckCircle2,
  RefreshCw,
  ShoppingCart,
} from "lucide-react";
import { Button } from "../../components/Button";
import { AddLineButton } from "../../vendor/scm/components/AddLineButton";
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
import { cascadeLineDeliveryDate } from "../../vendor/scm/lib/line-delivery-date-cascade";
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
import { useLocalities, countryForState } from "../../vendor/scm/lib/localities-queries";
import {
  useAddressCascade, pickState, pickCity, pickPostcode,
  cityPlaceholder, postcodePlaceholder,
} from "../../vendor/scm/lib/address-cascade";
import { StatePicker } from "../../vendor/scm/components/StatePicker";
import { SearchableSelect } from "../../vendor/scm/components/SearchableSelect";
import { AddressPostcodeField } from "../../vendor/scm/components/AddressPostcodeField";
import { sortByText } from "../../vendor/scm/lib/sort-options";

const ADDRESS_SELECT_CLS =
  "h-10 w-full rounded-lg border border-border bg-surface px-3 pr-8 text-[13.5px] text-ink outline-none focus:border-primary";
import { splitE164, combineE164 } from "../../../../shared/src/vendor/shared/phone";
import { DateField } from "../../vendor/scm/components/DateField";
import { fmtDate } from "../../../../shared/src/vendor/shared/format";
import { warehouseLabel } from "../../vendor/scm/lib/warehouse-label";
import { buildDoHeaderBody, seedDoHeaderForm, DO_HEADER_LOCKED_NOTICE } from "../../vendor/scm/lib/do-header-form";
import { doHeaderLocked, isDoHeaderKeyLocked } from "../../vendor/shared/do-header-lock";
import { lineDiscountShare } from "../../vendor/shared/line-discount-share";
import { afterCreatePath, sourceDocPath } from "../../lib/returnToSource";
import {
  seedFollowerVariants,
  seedableMasterVariants,
} from "../../vendor/scm/lib/so-variant-cascade";
import { todayMyt } from "../../vendor/scm/lib/dates";
import { FormTouchScope } from "../../components/FormTouchScope";
import { useFormTouched, useLeaveGuard } from "../../hooks/useLeaveGuard";


type DoDraftLine = SoLineDraft & { rid: string; itemId?: string; soItemId?: string | null };


const isoToDmy = fmtDate;

const newDoLine = (deliveryDate: string | null = null): DoDraftLine => ({
  ...emptySoLine(),
  lineDeliveryDate: deliveryDate,
  lineDeliveryDateOverridden: false,
  rid: `dl${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});


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
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      className="w-full resize-y disabled:opacity-50 rounded-lg border border-border bg-surface px-3 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)]"
    />
  );
}

function SelectInput({
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-10 w-full appearance-none disabled:opacity-50 rounded-lg border border-border bg-surface px-3 pr-8 text-[13.5px] text-ink outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)]"
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
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
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
        disabled={disabled}
      />
    </div>
  );
}


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


export function DeliveryOrderNewV2() {
  const navigate = useNavigate();
  const { touched: formTouched, markTouched } = useFormTouched();
  const { allowLeave } = useLeaveGuard(formTouched, null);
  const [params] = useSearchParams();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const staffQ = usePickableStaff({ onlySales: true });
  const salesStaff = staffQ.data ?? [];
  const stateWarehousesQ = useStateWarehouseMappings();

  useSetBreadcrumbs([
    { label: "Delivery Orders", to: "/scm/delivery-orders" },
    { label: "New" },
  ]);

  const fromSoParam = params.get("fromSo") ?? params.get("so") ?? "";
  const fromPicks = params.get("fromPicks") === "1";
  const editId = params.get("edit") ?? "";

  const [soDocNo, setSoDocNo] = useState<string>(fromSoParam);
  const soSource = useSoConversionSource(soDocNo || null);
  /* In edit mode the SO doc no. is the DO's own, seeded on load, so it cannot
     be the trigger: only an explicit "Pull from SO" appends lines (HC-0146). */
  const [editPullDoc, setEditPullDoc] = useState<string | null>(null);
  const soLines = useDeliverableSoLinesForDoc(
    editId ? editPullDoc : soDocNo && !fromPicks ? soDocNo : null,
  );
  const doDetail = useMfgDeliveryOrderDetail(editId || null);
  /* Owner ruling 2026-09-14: a live SI / DR locks the header's customer, address,
     contact and commercial fields. ONE rule (vendor/shared/do-header-lock.ts), the
     server's own; `lk(bodyKey)` disables exactly what the PATCH would refuse. */
  const headerLocked = !!editId && doHeaderLocked((doDetail.data as { deliveryOrder?: { has_children?: unknown } } | undefined)?.deliveryOrder);
  const lk = (bodyKey: string) => isDoHeaderKeyLocked(bodyKey, headerLocked);
  /* Owner 2026-11-10 (shared/do-spec-lock.ts): once shipped, a saved line keeps
     its product and spec. The card disables those fields and says why; the save
     never sends them, so a qty edit cannot re-bucket the line. */
  const specLockedReason = editId && doSpecLocked((doDetail.data as { deliveryOrder?: { status?: string | null } } | undefined)?.deliveryOrder?.status ?? null)
    ? DO_SPEC_LOCKED_MESSAGE : null;
  const createDo = useCreateMfgDeliveryOrder();
  const idemKey = useIdempotencyKey();
  const updateHeader = useUpdateMfgDeliveryOrderHeader();
  const addItem = useAddMfgDeliveryOrderItem();
  const updateItem = useUpdateMfgDeliveryOrderItem();
  const deleteItem = useDeleteMfgDeliveryOrderItem();

  const [customerName, setCustomerName] = useState("");
  const [debtorCode, setDebtorCode] = useState("");
  const [customerSoRef, setCustomerSoRef] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [customerType, setCustomerType] = useState("");
  const customerTypeOpts = optionsOrFallback("customer_type", useSoDropdownOptions("customer_type").data);
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
  const [doDate, setDoDate] = useState(todayMyt());
  const [driver, setDriver] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [buildingType, setBuildingType] = useState("");
  const [venue, setVenue] = useState("");
  /* Carried, never typed: the SO's brand rides onto the DO the way /from-sos
     carries it. The form had no field for it, so every DO raised here shipped
     with branding NULL while its order named one (docs/bugs/0723). */
  const [branding, setBranding] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [customerDelDate, setCustomerDelDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DoDraftLine[]>(() => [newDoLine()]);
  const [soPickerOpen, setSoPickerOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [asDraft, setAsDraft] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

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

  const loc = useLocalities();
  const locRows = useMemo(() => loc.data ?? [], [loc.data]);
  const { cities, postcodes } = useAddressCascade(locRows, state, city);
  const applyTriple = (next: { state: string; city: string; postcode: string }) => {
    setState(next.state); setCity(next.city); setPostcode(next.postcode);
  };
  const onStatePick = (next: string) => {
    applyTriple(pickState(next));
    const code = stateWarehousesQ.data?.mappings.find((m) => m.state === next)?.warehouse?.code;
    if (code) setSalesLocation(code);
  };
  const withCurrent = (opts: string[], current: string): string[] =>
    (current && !opts.includes(current) ? [current, ...opts] : opts);
  const country = (state ? countryForState(locRows, state) : null) ?? "Malaysia";

  const [stashSeeded, setStashSeeded] = useState(false);
  const [editSeeded, setEditSeeded] = useState(false);
  const originalLinesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1900);
    return () => clearTimeout(t);
  }, [flash]);

  const toDoItemBody = (l: DoDraftLine) => ({
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
    lineDeliveryDate: l.lineDeliveryDate ?? "",
    lineDeliveryDateOverridden: l.lineDeliveryDateOverridden ?? false,
  });

  /* Header -> line delivery-date cascade. The SALES ORDER has had this since
     PR-E (SalesOrderNew.tsx: the same effect, same three guards); the DELIVERY
     ORDER never got it, so changing "Customer delivery date" on the header left
     every line on its old date and the operator had to retype all ten. Owner
     2026-09-11, looking at a DO whose header read 24/09 and whose ten lines all
     read 19/09: 「如果我上面customer delivery date 更改下面不能自动跟吗」.

     A line the operator typed by hand is NEVER moved: SoLineCard sets
     `lineDeliveryDateOverridden` the moment its date field is edited (that flag
     exists for exactly this, and the comment on the payload builder below has
     promised this cascade since 0807 without one existing). */
  useEffect(() => {
    setLines((prev) => cascadeLineDeliveryDate(prev, customerDelDate) ?? prev);
  }, [customerDelDate]);

  useEffect(() => {
    if (!fromPicks || stashSeeded) return;
    setStashSeeded(true);
    const stash = readScmHandoff<Array<Record<string, unknown>>>("doFromSoPicks") ?? [];
    removeScmHandoff("doFromSoPicks");
    if (Array.isArray(stash) && stash.length > 0) {
      setLines(
        stash.map((s) => ({
          /* Owner ruling 2026-09-11: DO delivery date DEFAULTS to the SO's.
             `customerDelDate` was pre-filled from the SO by the header
             effect above, so seeding line dates from it lands the SO's date
             on every line — the operator can override per line. */
          ...newDoLine(customerDelDate || null),
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
    setBranding(so.branding ?? "");
    /* The customer's date is the SO's; /from-sos copies it and falls back to
       it for expected_delivery_at. Left unseeded, both dates reached the DO as
       NULL unless the operator retyped them (docs/bugs/0723). Expected-at stays
       the operator's own field: blank posts as null and the server falls back
       to the customer date, exactly as /from-sos does. */
    setCustomerDelDate((so.customerDeliveryDate ?? "").slice(0, 10));
    /* Owner 2026-11-27: the DO date stays TODAY (the useState initial); the
       delivery date is the planned one (/so-source sends amended ?? customer). */
    setFlash(`Prefilled from ${soDocNo}`);
  }, [soSource.data, soDocNo, editId]);


  const soRowToLine = (it: NonNullable<typeof soLines.data>[number]): DoDraftLine => ({
    /* Owner ruling 2026-09-11: default the line delivery date to the
       SO's, same as the ?fromPicks= path above. */
    ...newDoLine(customerDelDate || null),
    soItemId: it.soItemId,
    itemCode: it.itemCode,
    itemGroup: it.itemGroup ?? "others",
    description: it.description ?? "",
    uom: it.uom ?? "UNIT",
    qty: it.remaining,
    unitPriceSen: it.unitPriceSen,
    discountSen: lineDiscountShare(it.discountSen, it.qty, it.qty - it.remaining, it.remaining),
    unitCostSen: it.unitCostSen,
    variants:
      it.variants && typeof it.variants === "object"
        ? (it.variants as Record<string, unknown>)
        : {},
    remark: "",
  });

  useEffect(() => {
    if (editId || fromPicks) return;
    const rows = soLines.data;
    if (!rows || rows.length === 0) return;
    setLines(rows.map(soRowToLine));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soLines.data, editId, fromPicks]);

  useEffect(() => {
    if (!editId || !editPullDoc || !soLines.data) return;
    const items = (doDetail.data as { items?: Array<{ so_item_id?: string | null }> } | undefined)?.items ?? [];
    const taken = new Set<string>(items.map((it) => it.so_item_id ?? "").filter(Boolean));
    for (const l of lines) if (l.soItemId) taken.add(l.soItemId);
    const fresh = soLines.data.filter((it) => !taken.has(it.soItemId));
    if (fresh.length === 0) {
      void notify({
        title: `No lines added from ${editPullDoc}.`,
        body: `The undelivered lines found on ${editPullDoc} (${soLines.data.length}) are all on this delivery order. A wrong SO number, or lines on another draft delivery order, would also show this. Open the sales order to check its deliveries.`,
        tone: "error",
      });
    } else {
      setLines((prev) => [...prev.filter((l) => l.itemId || l.itemCode.trim()), ...fresh.map(soRowToLine)]);
      setFlash(`Added ${fresh.length} line${fresh.length === 1 ? "" : "s"} from ${editPullDoc}`);
    }
    setEditPullDoc(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soLines.data, editId, editPullDoc]);

  useEffect(() => {
    if (!editId || editSeeded) return;
    const doo = (doDetail.data as { deliveryOrder?: Record<string, unknown> } | undefined)?.deliveryOrder;
    if (!doo) return;
    setEditSeeded(true);
    const f = seedDoHeaderForm(doo, todayMyt());
    setCustomerName(f.customerName); setDebtorCode(f.debtorCode); setCustomerSoRef(f.customerSoRef);
    setPhone(f.phone); setEmail(f.email); setCustomerType(f.customerType); setSalespersonId(f.salespersonId);
    setAddr1(f.address1); setAddr2(f.address2); setState(f.state); setCity(f.city); setPostcode(f.postcode);
    setSalesLocation(f.salesLocation); setEcName(f.ecName); setEcRelationship(f.ecRelationship); setEcPhone(f.ecPhone);
    setDoDate(f.doDate); setDriver(f.driver); setVehicle(f.vehicle); setBuildingType(f.buildingType);
    setVenue(f.venue); setBranding(f.branding); setExpectedDate(f.expectedDate); setCustomerDelDate(f.customerDelDate);
    setNote(f.note);
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

  const totalQty = useMemo(
    () => lines.reduce((sum, l) => sum + (Number.isFinite(l.qty) ? l.qty : 0), 0),
    [lines]
  );

  const inheritVariantsByCategory = useMemo(
    () => seedableMasterVariants(
      lines.map((l) => ({
        category: l.itemGroup ?? "",
        variants: (l.variants ?? {}) as Record<string, unknown>,
      })),
      /* NULL = every category, i.e. UNCHANGED. A Delivery Order only ever
         SEEDS (the header above says it never follows afterwards, and whether
         it should is an owner decision). The 2026-09-09 sofa-only ruling was
         about Sales Orders; applying it here would be a second quiet decision
         on a document nobody asked about. Required parameter, visible answer. */
      null,
    ),
    [lines]
  );

  const addLine = () => {
    setLines((prev) => [...prev, newDoLine(customerDelDate || null)]);
  };
  const removeLine = (rid: string) => {
    setLines((prev) => prev.filter((l) => l.rid !== rid));
  };
  const updateLine = (rid: string, patch: Partial<SoLineDraft>) => {
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  };
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

  const buildHeaderBody = () => buildDoHeaderBody({
    customerName, debtorCode, customerSoRef, phone, email, customerType, salespersonId,
    address1: addr1, address2: addr2, state, city, postcode, salesLocation,
    ecName, ecRelationship, ecPhone, doDate, driver, vehicle, buildingType, venue, branding,
    expectedDate, customerDelDate, note,
  }, salesStaff, { locked: headerLocked });

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
      allowLeave();
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
      { ...buildBody(), idempotencyKey: idemKey, asDraft: draft || undefined, status: draft ? "DRAFT" : "LOADED" },
      {
        onSuccess: async (res) => {
          setFlash(draft ? "Saved as draft" : "Delivery order created");
          await notifyAcNotSent(notify, res, "Delivery order");
          allowLeave();
          if (res?.id) {
            navigate(afterCreatePath(`/scm/delivery-orders/${res.id}`, sourceDocPath.salesOrder(fromSoParam)));
          } else {
            navigate("/scm/delivery-orders");
          }
        },
        onError: (err) => {
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
      const currentIds = new Set(
        lines.filter((l) => l.itemId).map((l) => l.itemId as string)
      );
      const removed = [...originalLinesRef.current.keys()].filter(
        (id) => !currentIds.has(id)
      );

      const ops: Array<Promise<unknown>> = [];
      const added: Array<ReturnType<typeof toDoItemBody>> = [];
      for (const itemId of removed) {
        ops.push(deleteItem.mutateAsync({ id: editId, itemId }));
      }
      for (const l of current) {
        const body = toDoItemBody(l);
        if (l.itemId) {
          const orig = originalLinesRef.current.get(l.itemId);
          if (orig !== JSON.stringify(body)) {
            const send: Record<string, unknown> = { ...body };
            if (specLockedReason) { delete send.itemCode; delete send.itemGroup; delete send.variants; }
            ops.push(updateItem.mutateAsync({ id: editId, itemId: l.itemId, ...send }));
          }
        } else {
          added.push(body);
        }
      }
      if (added.length > 0) ops.push(addItem.mutateAsync({ id: editId, items: added }));
      await Promise.all(ops);
      await updateHeader.mutateAsync({ id: editId, ...buildHeaderBody() });
      setFlash("Delivery order updated");
      allowLeave();
      navigate(`/scm/delivery-orders/${editId}`);
    } catch (err) {
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
    <FormTouchScope onTouch={markTouched}>
    <div className="pb-20">
      {/* Sticky form header + document flow.
          Owner 2026-08-03: the flow strip is frozen WITH the action bar, so the
          operator can see which SO this DO hangs off (and reach Create/Cancel)
          from anywhere down a long form. Keep them in ONE sticky box — two
          stacked sticky boxes would each pin at top:0 and overlap. */}
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
          {headerLocked && (
            <div role="status" className="mt-3 rounded-md border border-warning-text/25 bg-warning-bg px-3.5 py-2.5 text-[12.5px] text-warning-text">
              {DO_HEADER_LOCKED_NOTICE}
            </div>
          )}
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

        <div className="mt-4">
          <DocumentFlowStrip soDocNo={soDocNo || null} />
        </div>
      </div>

      <div className="flex flex-col gap-5 py-6">
        <SectionCard title="Customer info">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_340px]">
            <div>
              <Label text="Customer name" required />
              <input
                ref={debtorInputRef}
                disabled={lk("debtorName")}
                value={customerName}
                onChange={(e) => { setCustomerName(e.target.value); setDebtorCode(""); setShowDebtorSuggest(true); }}
                onFocus={() => setShowDebtorSuggest(true)}
                onBlur={() => setTimeout(() => setShowDebtorSuggest(false), 150)}
                placeholder="e.g. Lim Mei Hua"
                className={cn(
                  "h-10 w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-muted",
                  "focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)] disabled:opacity-50",
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
              <Label text="Ref No." />
              <TextInput
                value={customerSoRef}
                onChange={setCustomerSoRef}
                disabled={lk("customerSoNo")}
                placeholder="Their PO / SO number"
              />
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <Label text="Phone" required />
              <PhoneInput value={phone} onChange={setPhone} disabled={lk("phone")} />
            </div>
            <div>
              <Label text="Email" />
              <TextInput
                value={email}
                onChange={setEmail}
                disabled={lk("email")}
                placeholder="customer@example.com"
              />
            </div>
            <div>
              <Label text="Customer type" />
              <SelectInput
                value={customerType}
                onChange={setCustomerType}
                disabled={lk("customerType")}
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

        <SectionCard title="Delivery address">
          <div className="flex flex-col gap-4">
            <div>
              <Label text="Address line 1" />
              <TextInput
                value={addr1}
                onChange={setAddr1}
                disabled={lk("address1")}
                placeholder="Unit, street, area"
              />
            </div>
            <div>
              <Label text="Address line 2" />
              <TextInput
                value={addr2}
                onChange={setAddr2}
                disabled={lk("address2")}
                placeholder="Apt, floor, building (optional)"
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div>
                <Label text="State" />
                <StatePicker
                  value={state}
                  onChange={onStatePick}
                  disabled={lk("customerState")}
                  selectClassName={ADDRESS_SELECT_CLS}
                />
              </div>
              <div>
                <Label text="City" />
                <SearchableSelect
                  className={ADDRESS_SELECT_CLS}
                  value={city}
                  onChange={(next) => applyTriple(pickCity(locRows, { state, city, postcode }, next))}
                  disabled={loc.isLoading || lk("city")}
                  placeholder={loc.isLoading ? "Loading…" : cityPlaceholder(state)}
                  options={withCurrent(sortByText(cities), city).map((v) => ({ value: v, label: v }))}
                />
              </div>
              <AddressPostcodeField
                country={country}
                value={postcode}
                onChange={setPostcode}
                onCascadePick={(next) => applyTriple(pickPostcode(locRows, { state, city, postcode }, next))}
                onResolve={(r) => { setAddr1(r.address); if (r.state && r.city) { setState(r.state); setCity(r.city); } }}
                postcodeChoices={withCurrent(postcodes, postcode)}
                placeholder={loc.isLoading ? "Loading…" : postcodePlaceholder(state, city)}
                disabled={loc.isLoading || lk("postcode")}
                classes={{
                  field: "block",
                  label: "mb-1.5 block font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted",
                  select: ADDRESS_SELECT_CLS,
                  selectWrap: "relative block",
                  chevron: "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted",
                  input: ADDRESS_SELECT_CLS,
                }}
              />
              <div>
                <Label text="Sales location" />
                <SelectInput
                  value={salesLocation}
                  onChange={setSalesLocation}
                  disabled={lk("salesLocation")}
                  placeholder="—"
                  options={salesLocationOpts}
                />
              </div>
            </div>
          </div>
        </SectionCard>

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
                disabled={lk("emergencyContactName")}
                placeholder="e.g. Lim Mei Hua"
              />
            </div>
            <div>
              <Label text="Relationship" />
              <SelectInput
                value={ecRelationship}
                onChange={setEcRelationship}
                disabled={lk("emergencyContactRelationship")}
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
              <PhoneInput value={ecPhone} onChange={setEcPhone} disabled={lk("emergencyContactPhone")} />
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Delivery info">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <Label text="DO date" />
              <TextInput
                value={doDate}
                onChange={setDoDate}
                disabled={lk("doDate")}
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
                disabled={lk("buildingType")}
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
                disabled={lk("venue")}
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
                disabled={lk("customerDeliveryDate")}
                type="date"
              />
            </div>
          </div>
          <div className="mt-4">
            <Label text="Note" />
            <TextArea
              value={note}
              onChange={setNote}
              disabled={lk("note")}
              placeholder="Internal notes — visible on the DO detail page only"
            />
          </div>
        </SectionCard>

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
                variantsRequired={false}
                specLockedReason={line.itemId ? specLockedReason : null}
                lineDateLocked={false}
                seedSofaLegDefault={false}
                attachOptions={null}
              />
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <AddLineButton variant="ghost" onClick={addLine} />
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

      <FromSoPickerModal
        open={soPickerOpen}
        onClose={() => setSoPickerOpen(false)}
        onPick={(docNo) => {
          if (editId) setEditPullDoc(docNo);
          else setSoDocNo(docNo);
          setSoPickerOpen(false);
        }}
        currentValue={soDocNo}
      />

      {flash && (
        <div className="fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-lg bg-sidebar px-4 py-2.5 text-[13px] font-semibold text-white shadow-slab">
          {flash}
        </div>
      )}
    </div>
    </FormTouchScope>
  );
}

void ArrowRightIcon;
void ShoppingCart;
void isoToDmy;

export default DeliveryOrderNewV2;
