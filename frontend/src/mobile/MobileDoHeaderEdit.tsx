/* ------------------------------------------------------------------------- *
 * MobileDoHeaderEdit — edit a Delivery Order's HEADER on the phone.
 *
 * Owner 2026-09-12: mobile = FULL desktop parity, same permissions. Until this
 * screen the phone opened a DO read-only; the desktop's DeliveryOrderNewV2
 * (?edit=<id>) let staff change the customer, contact, address, emergency
 * contact, dates, driver / vehicle, note and sales location.
 *
 * ONE SHARED LOGIC LAYER. This file is presentation plus the mutation wiring:
 *   - what a loaded DO seeds, and the body the save sends:
 *     vendor/scm/lib/do-header-form.ts (the desktop edit calls the same two)
 *   - the save: useUpdateMfgDeliveryOrderHeader, the desktop's hook
 *   - which fields a Sales Invoice / Delivery Return freezes (owner ruling
 *     2026-09-14): vendor/shared/do-header-lock.ts, byte-identical to the module
 *     the server's PATCH refuses on
 *   - State / City / Postcode: address-cascade.ts + StatePicker +
 *     SearchableSelect + AddressPostcodeField, the SO / desktop DO widgets
 *   - the header-date -> line-date follow: line-delivery-date-cascade.ts
 *   - who may edit: canOperateDeliveryOrders (auth/salesAccess), the helper the
 *     desktop's Edit button uses; MobileApp only offers Edit when it passes too
 *   - refusals: the server's own sentence via NotifyDialog
 *
 * WHAT THIS SCREEN DOES NOT DO — stated so nobody reads it as parity:
 *   - line items (add / edit / delete a line, variants). Desktop edit does those
 *     on the same page; the phone has no DO line editor yet.
 * ------------------------------------------------------------------------- */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { canOperateDeliveryOrders } from "../auth/salesAccess";
import { invalidateMobileLists } from "./sharedInvalidate";
import {
  useMfgDeliveryOrderDetail,
  useUpdateMfgDeliveryOrderHeader,
  useUpdateMfgDeliveryOrderItem,
} from "../vendor/scm/lib/delivery-order-queries";
import {
  buildDoHeaderBody,
  seedDoHeaderForm,
  DO_HEADER_LOCKED_NOTICE,
  type DoHeaderForm,
} from "../vendor/scm/lib/do-header-form";
import { doHeaderLocked, isDoHeaderKeyLocked } from "../vendor/shared/do-header-lock";
import { cascadeLineDeliveryDate } from "../vendor/scm/lib/line-delivery-date-cascade";
import { usePickableStaff } from "../vendor/scm/lib/admin-queries";
import { useSoDropdownOptions, optionsOrFallback } from "../vendor/scm/lib/so-dropdown-options-queries";
import { useStateWarehouseMappings } from "../vendor/scm/lib/state-warehouse-queries";
import { warehouseLabel } from "../vendor/scm/lib/warehouse-label";
import { useLocalities, countryForState } from "../vendor/scm/lib/localities-queries";
import {
  useAddressCascade, pickState, pickCity, pickPostcode,
  cityPlaceholder, postcodePlaceholder,
} from "../vendor/scm/lib/address-cascade";
import { useDebtorSearch, type DebtorSuggestion } from "../vendor/scm/lib/sales-order-queries";
import { useDebouncedValue } from "../vendor/scm/lib/hooks";
import { DebtorSuggestList } from "../vendor/scm/components/DebtorSuggestList";
import { StatePicker } from "../vendor/scm/components/StatePicker";
import { SearchableSelect } from "../vendor/scm/components/SearchableSelect";
import { AddressPostcodeField } from "../vendor/scm/components/AddressPostcodeField";
import { PhoneInput } from "../vendor/scm/components/PhoneInput";
import { DateField } from "../vendor/scm/components/DateField";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { todayMyt } from "../vendor/scm/lib/dates";

type ItemRow = { id?: unknown; line_delivery_date?: unknown; line_delivery_date_overridden?: unknown };

const RELATIONSHIPS = ["Spouse", "Family", "Colleague", "Self"];
const BUILDING_TYPES = ["Landed", "High-rise (lift)", "High-rise (no lift)"];

export function MobileDoHeaderEdit({ id, onBack, onSaved }: {
  id: string;
  onBack: () => void;
  onSaved: () => void;
}) {
  const { user, can, pageAccess } = useAuth();
  const mayEdit = canOperateDeliveryOrders(user, can, pageAccess);
  const notify = useNotify();
  const qc = useQueryClient();

  const detailQ = useMfgDeliveryOrderDetail(mayEdit ? id : null);
  const updateHeader = useUpdateMfgDeliveryOrderHeader();
  const updateItem = useUpdateMfgDeliveryOrderItem();
  const staffQ = usePickableStaff({ onlySales: true });
  const salesStaff = useMemo(() => staffQ.data ?? [], [staffQ.data]);
  const customerTypeOpts = optionsOrFallback("customer_type", useSoDropdownOptions("customer_type").data);
  const stateWarehousesQ = useStateWarehouseMappings();

  const detail = detailQ.data as { deliveryOrder?: Record<string, unknown>; items?: ItemRow[] } | undefined;
  const doo = detail?.deliveryOrder;
  const locked = doHeaderLocked(doo);
  const lockedKey = (bodyKey: string) => isDoHeaderKeyLocked(bodyKey, locked);

  const [seed, setSeed] = useState<DoHeaderForm | null>(null);
  const [form, setForm] = useState<DoHeaderForm | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!doo || seed) return;
    const s = seedDoHeaderForm(doo, todayMyt());
    setSeed(s);
    setForm(s);
  }, [doo, seed]);
  const set = (patch: Partial<DoHeaderForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const loc = useLocalities();
  const locRows = useMemo(() => loc.data ?? [], [loc.data]);
  const { cities, postcodes } = useAddressCascade(locRows, form?.state ?? "", form?.city ?? "");
  const triple = form ? { state: form.state, city: form.city, postcode: form.postcode } : { state: "", city: "", postcode: "" };
  const withCurrent = (opts: string[], current: string) => (current && !opts.includes(current) ? [current, ...opts] : opts);

  const salesLocationOpts = useMemo(() => {
    const byValue = new Map<string, string>();
    for (const m of stateWarehousesQ.data?.mappings ?? []) {
      const w = m.warehouse;
      if (w?.code) byValue.set(w.code, warehouseLabel(w) ?? w.code);
    }
    if (form?.salesLocation && !byValue.has(form.salesLocation)) byValue.set(form.salesLocation, form.salesLocation);
    return [...byValue.entries()];
  }, [stateWarehousesQ.data, form?.salesLocation]);

  const debtorInputRef = useRef<HTMLInputElement>(null);
  const [showDebtorSuggest, setShowDebtorSuggest] = useState(false);
  const debounced = useDebouncedValue(form?.customerName ?? "", 200);
  const debtorQ = useDebtorSearch(debounced.trim().length >= 2 && !locked ? debounced.trim() : "");
  const debtorSuggestions: DebtorSuggestion[] = (debtorQ.data?.debtors ?? []).filter(
    (d) => (d.debtor_name ?? "").toLowerCase() !== (form?.customerName ?? "").trim().toLowerCase(),
  );

  if (!mayEdit) {
    return (
      <Shell onBack={onBack} title="Edit delivery order">
        <div className="st-warn" role="status">You can view delivery orders but you cannot edit delivery orders.</div>
      </Shell>
    );
  }
  if (!form || !seed) {
    return (
      <Shell onBack={onBack} title="Edit delivery order">
        <div role="status">{detailQ.isError ? "Could not load this delivery order." : "Loading…"}</div>
      </Shell>
    );
  }

  const save = async () => {
    if (!form.customerName.trim()) {
      await notify({ title: "Customer name is required.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      /* Lines first, then the header — the desktop edit's order. Only the lines
         still following the header move (the shared cascade). */
      if (form.customerDelDate !== seed.customerDelDate) {
        const rows = (detail?.items ?? []).map((it) => ({
          id: String(it.id ?? ""),
          lineDeliveryDate: it.line_delivery_date ? String(it.line_delivery_date).slice(0, 10) : null,
          lineDeliveryDateOverridden: it.line_delivery_date_overridden === true,
        }));
        const moved = cascadeLineDeliveryDate(rows, form.customerDelDate) ?? rows;
        await Promise.all(moved
          .filter((l, i) => l !== rows[i] && l.id)
          .map((l) => updateItem.mutateAsync({ id, itemId: l.id, lineDeliveryDate: l.lineDeliveryDate ?? "", lineDeliveryDateOverridden: false })));
      }
      await updateHeader.mutateAsync({ id, ...buildDoHeaderBody(form, salesStaff, { locked }) });
      invalidateMobileLists(qc);
      void notify({ title: "Delivery order updated" });
      onSaved();
    } catch (err) {
      await notify({
        title: "Couldn't save this delivery order",
        body: `${err instanceof Error && err.message ? err.message : "Something went wrong."} Your entries are still on this screen.`,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, control: React.ReactNode) => (
    <div className="st-fld" style={{ flex: "none" }}>
      <span className="st-fl">{label}</span>
      {control}
    </div>
  );
  const text = (label: string, key: keyof DoHeaderForm, bodyKey: string, extra: { placeholder?: string; inputMode?: "email" | "text" } = {}) =>
    field(label, (
      <input className="cal-sel" aria-label={label} value={form[key]} disabled={lockedKey(bodyKey)}
        inputMode={extra.inputMode} placeholder={extra.placeholder} onChange={(e) => set({ [key]: e.target.value } as Partial<DoHeaderForm>)} />
    ));
  const date = (label: string, key: keyof DoHeaderForm, bodyKey: string) =>
    field(label, <DateField fullWidth className="cal-sel" aria-label={label} value={form[key]} disabled={lockedKey(bodyKey)} onChange={(iso) => set({ [key]: iso } as Partial<DoHeaderForm>)} />);
  const choice = (label: string, key: keyof DoHeaderForm, bodyKey: string, opts: Array<[string, string]>) =>
    field(label, (
      <select className="cal-sel" aria-label={label} value={form[key]} disabled={lockedKey(bodyKey)} onChange={(e) => set({ [key]: e.target.value } as Partial<DoHeaderForm>)}>
        <option value="">—</option>
        {form[key] && !opts.some(([v]) => v === form[key]) && <option value={form[key]}>{form[key]}</option>}
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    ));
  const section = (t: string) => <div className="sc-sl"><span className="t">{t}</span><span className="ln" /></div>;
  const addrLocked = lockedKey("customerState");
  const country = (form.state ? countryForState(locRows, form.state) : null) ?? "Malaysia";

  return (
    <Shell onBack={onBack} title={`Edit ${String(doo?.do_number ?? "delivery order")}`}
      footer={
        <button className="btn" disabled={busy} style={{ opacity: busy ? 0.5 : 1 }} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      }>
      {locked && <div className="st-warn" role="status" style={{ flex: "none" }}>{DO_HEADER_LOCKED_NOTICE}</div>}

      {section("Customer")}
      {field("Customer name", (
        <>
          <input ref={debtorInputRef} className="cal-sel" aria-label="Customer name" value={form.customerName}
            disabled={lockedKey("debtorName")}
            onChange={(e) => { set({ customerName: e.target.value, debtorCode: "" }); setShowDebtorSuggest(true); }}
            onFocus={() => setShowDebtorSuggest(true)}
            onBlur={() => setTimeout(() => setShowDebtorSuggest(false), 150)} />
          <DebtorSuggestList anchorRef={debtorInputRef} open={showDebtorSuggest && !locked} suggestions={debtorSuggestions}
            onPick={(d) => { set({ debtorCode: d.debtor_code ?? "", customerName: d.debtor_name ?? "", ...(d.phone ? { phone: d.phone } : {}) }); setShowDebtorSuggest(false); }}
            classes={{ list: "z-50 m-0 max-h-[260px] list-none overflow-auto rounded-lg border border-border bg-surface py-1 text-[13px] shadow-lg", item: "cursor-pointer px-3 py-2 text-ink hover:bg-canvas", code: "text-[11px] text-ink-muted" }} />
        </>
      ))}
      {text("Customer SO ref", "customerSoRef", "customerSoNo", { placeholder: "Their PO / SO number" })}
      {field("Phone", <PhoneInput aria-label="Phone" value={form.phone} disabled={lockedKey("phone")} onChange={(v) => set({ phone: v })} />)}
      {text("Email", "email", "email", { inputMode: "email" })}
      {choice("Customer type", "customerType", "customerType", customerTypeOpts.map((o) => [o.value, o.label]))}
      {choice("Salesperson", "salespersonId", "salespersonId", salesStaff.map((s) => [s.id, `${s.name} (${s.staffCode})`]))}

      {section("Delivery address")}
      {text("Address line 1", "address1", "address1", { placeholder: "Unit, street, area" })}
      {text("Address line 2", "address2", "address2", { placeholder: "Apt, floor, building (optional)" })}
      {field("State", (
        <StatePicker compact value={form.state} disabled={addrLocked} placeholder="Pick state" selectClassName="cal-sel"
          onChange={(next) => {
            const code = stateWarehousesQ.data?.mappings.find((m) => m.state === next)?.warehouse?.code;
            set({ ...pickState(next), ...(code ? { salesLocation: code } : {}) });
          }} />
      ))}
      {field("City", (
        <SearchableSelect className="cal-sel" ariaLabel="City" value={form.city} disabled={lockedKey("city") || loc.isLoading}
          placeholder={loc.isLoading ? "Loading…" : cityPlaceholder(form.state)}
          onChange={(next) => set(pickCity(locRows, triple, next))}
          options={withCurrent(cities, form.city).map((v) => ({ value: v, label: v }))} />
      ))}
      {/* `.st-fld` grows (flex: 1) inside this column; the wrapper holds it to its content. */}
      <div style={{ flex: "none", display: "flex", flexDirection: "column" }}>
      <AddressPostcodeField
        country={country}
        value={form.postcode}
        onChange={(v) => set({ postcode: v })}
        onCascadePick={(next) => set(pickPostcode(locRows, triple, next))}
        onResolve={(r) => set({ address1: r.address, ...(r.state && r.city ? { state: r.state, city: r.city } : {}) })}
        postcodeChoices={withCurrent(postcodes, form.postcode)}
        placeholder={loc.isLoading ? "Loading…" : postcodePlaceholder(form.state, form.city)}
        disabled={lockedKey("postcode") || loc.isLoading}
        classes={{ field: "st-fld", label: "st-fl", select: "cal-sel", input: "cal-sel" }}
      />
      </div>
      {choice("Sales location", "salesLocation", "salesLocation", salesLocationOpts)}

      {section("Emergency contact")}
      {text("Emergency contact name", "ecName", "emergencyContactName")}
      {choice("Emergency contact relationship", "ecRelationship", "emergencyContactRelationship", RELATIONSHIPS.map((r) => [r, r]))}
      {field("Emergency contact phone", <PhoneInput aria-label="Emergency contact phone" value={form.ecPhone} disabled={lockedKey("emergencyContactPhone")} onChange={(v) => set({ ecPhone: v })} />)}

      {section("Delivery")}
      {date("DO date", "doDate", "doDate")}
      {text("Driver", "driver", "driverName")}
      {text("Vehicle", "vehicle", "vehicle", { placeholder: "Lorry plate no." })}
      {choice("Building type", "buildingType", "buildingType", BUILDING_TYPES.map((b) => [b, b]))}
      {text("Venue", "venue", "venue", { placeholder: "Residence / site" })}
      {date("Expected delivery", "expectedDate", "expectedDeliveryAt")}
      {date("Customer delivery date", "customerDelDate", "customerDeliveryDate")}
      {field("Note", (
        <textarea className="cal-sel" aria-label="Note" rows={3} value={form.note} disabled={lockedKey("note")}
          onChange={(e) => set({ note: e.target.value })} />
      ))}
    </Shell>
  );
}

function Shell({ onBack, title, children, footer }: {
  onBack: () => void; title: string; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">‹</span> Back</button>
          <span className="eyebrow">Delivery order · Edit</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">{title}</div>
        </div>
      </header>
      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40, display: "flex", flexDirection: "column", gap: 12 }}>
        {children}
      </div>
      {footer && <div className="actbar" style={{ display: "flex", gap: 10 }}>{footer}</div>}
    </div>
  );
}

export default MobileDoHeaderEdit;
