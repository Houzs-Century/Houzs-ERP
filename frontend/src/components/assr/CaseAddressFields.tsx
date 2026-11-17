// The service case's address in the Sales Order's layout (owner 2026-11-17):
// Address line 1 / 2 + State / City / Postcode, with the SO / DO form's own
// my_localities cascade (address-cascade.ts + StatePicker + SearchableSelect +
// AddressPostcodeField): a postcode fills City and State, a state narrows the
// rest. Picking the case's SO No. fills all of it from the SO on the server.
// Lines 3 / 4 show only while an old case still holds text there (the free-text
// box mapped onto four lines), so nothing typed before is hidden.
//
// One component for the desktop case page and the phone; `classes` carries each
// host's control styling.
import { useEffect, useMemo, useState } from "react";
import { useLocalities, countryForState } from "../../vendor/scm/lib/localities-queries";
import {
  useAddressCascade, pickState, pickCity, pickPostcode, cityPlaceholder, postcodePlaceholder,
} from "../../vendor/scm/lib/address-cascade";
import { StatePicker } from "../../vendor/scm/components/StatePicker";
import { SearchableSelect } from "../../vendor/scm/components/SearchableSelect";
import { AddressPostcodeField } from "../../vendor/scm/components/AddressPostcodeField";
import { caseAddressPatch, seedCaseAddressForm, type CaseAddressForm } from "../../lib/assrCaseAddressForm";

export interface CaseAddressFieldsClasses {
  field: string;
  label: string;
  input: string;
  /** The postcode dropdown's wrapper + chevron (AddressPostcodeField). */
  selectWrap: string;
  chevron: string;
  actions: string;
  save: string;
  cancel: string;
  error: string;
}

const INPUT = "w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20";
const BTN = "rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-50";

/** The desktop case page's look (InlineEdit's label + input). */
export const CASE_ADDRESS_DESKTOP: CaseAddressFieldsClasses = {
  field: "block",
  label: "mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted",
  input: INPUT,
  selectWrap: "relative block",
  chevron: "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted",
  actions: "flex justify-end gap-2",
  save: `${BTN} border-primary bg-primary text-white`,
  cancel: `${BTN} border-border bg-surface text-ink-secondary`,
  error: "text-[11.5px] text-err",
};

/** The phone's look (the .st-fld / .cal-sel form controls MobileDoHeaderEdit uses). */
export const CASE_ADDRESS_MOBILE: CaseAddressFieldsClasses = {
  field: "st-fld",
  label: "st-fl",
  input: "cal-sel",
  selectWrap: "",
  chevron: "hidden",
  actions: "fld-row",
  save: "btn",
  cancel: "btn-ghost",
  error: "st-warn",
};

export function CaseAddressFields({ c, onSave, classes }: {
  c: Record<string, unknown>;
  onSave: (body: Record<string, string | null>) => Promise<void>;
  classes: CaseAddressFieldsClasses;
}) {
  const seed = useMemo(
    () => seedCaseAddressForm(c),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only when a stored address value changes
    [c.addr1, c.addr2, c.addr3, c.addr4, c.postcode, c.city, c.state],
  );
  const [form, setForm] = useState<CaseAddressForm>(seed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setForm(seed), [seed]);
  const set = (p: Partial<CaseAddressForm>) => setForm((f) => ({ ...f, ...p }));

  const loc = useLocalities();
  const rows = useMemo(() => loc.data ?? [], [loc.data]);
  const { cities, postcodes } = useAddressCascade(rows, form.state, form.city);
  const triple = { state: form.state, city: form.city, postcode: form.postcode };
  const withCurrent = (opts: string[], cur: string) => (cur && !opts.includes(cur) ? [cur, ...opts] : opts);
  const country = (form.state ? countryForState(rows, form.state) : null) ?? "Malaysia";
  const body = caseAddressPatch(seed, form);

  const save = async () => {
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the address.");
    } finally {
      setBusy(false);
    }
  };

  const line = (key: "addr1" | "addr2" | "addr3" | "addr4", label: string, placeholder: string) => (
    <label className={classes.field}>
      <span className={classes.label}>{label}</span>
      <input className={classes.input} aria-label={label} value={form[key]} placeholder={placeholder}
        onChange={(e) => set({ [key]: e.target.value })} />
    </label>
  );

  return (
    <>
      {line("addr1", "Address line 1", "Unit, street, area")}
      {line("addr2", "Address line 2", "Apt, floor, building (optional)")}
      {seed.addr3 !== "" && line("addr3", "Address line 3", "")}
      {seed.addr4 !== "" && line("addr4", "Address line 4", "")}
      <label className={classes.field}>
        <span className={classes.label}>State</span>
        <StatePicker value={form.state} placeholder="Pick state" selectClassName={classes.input}
          onChange={(next) => set(pickState(next))} />
      </label>
      <label className={classes.field}>
        <span className={classes.label}>City</span>
        <SearchableSelect className={classes.input} ariaLabel="City" value={form.city} disabled={loc.isLoading}
          placeholder={loc.isLoading ? "Loading…" : cityPlaceholder(form.state)}
          onChange={(next) => set(pickCity(rows, triple, next))}
          options={withCurrent(cities, form.city).map((v) => ({ value: v, label: v }))} />
      </label>
      <AddressPostcodeField
        country={country}
        value={form.postcode}
        onChange={(v) => set({ postcode: v })}
        onCascadePick={(next) => set(pickPostcode(rows, triple, next))}
        onResolve={(r) => set({ ...(form.addr1 ? {} : { addr1: r.address }), ...(r.state && r.city ? { state: r.state, city: r.city } : {}) })}
        postcodeChoices={withCurrent(postcodes, form.postcode)}
        placeholder={loc.isLoading ? "Loading…" : postcodePlaceholder(form.state, form.city)}
        disabled={loc.isLoading}
        classes={{ field: classes.field, label: classes.label, select: classes.input, input: classes.input, selectWrap: classes.selectWrap, chevron: classes.chevron }}
      />
      {error && <div className={classes.error} role="alert">{error}</div>}
      {body && (
        <div className={classes.actions}>
          <button type="button" className={classes.cancel} disabled={busy} onClick={() => { setForm(seed); setError(null); }}>Cancel</button>
          <button type="button" className={classes.save} disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save address"}
          </button>
        </div>
      )}
    </>
  );
}
