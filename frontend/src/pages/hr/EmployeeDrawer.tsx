/* The add / edit drawer of Employee Master (from Hookka's employee-drawer.tsx).
 * A salary change asks for the date it takes effect and lands in the salary
 * history, so an older month is never re-priced. Read-only for holders of
 * hr.employees.read alone. */
import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "../../api/client";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { DateField } from "../../vendor/scm/components/DateField";
import { SearchableSelect, type SearchableSelectOption } from "../../vendor/scm/components/SearchableSelect";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { cn, formatDate } from "../../lib/utils";
import { todayMY } from "../../vendor/shared/format";
import {
  EMPLOYEE_STATUSES,
  MALAYSIAN_BANKS,
  PAYMENT_METHODS,
  TAX_CATEGORIES,
  TAX_RESIDENCIES,
  emptyEmployeeInput,
  employeeInputProblem,
  type EmployeeInput,
  type EmployeeStatus,
  type PaymentMethod,
  type TaxCategory,
  type TaxResidency,
} from "../../vendor/shared/hr-employee";
import { Field, Toggle, dangerBtn, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, fmtRm, rmFromSen, senFromRm, useEmployeeOptions, useSalaryHistory, type Employee } from "./hrApi";

type Draft = Omit<EmployeeInput, "basicSalarySen" | "dailyRateSen" | "workingHoursPerDay" | "workingDaysPerMonth" | "otMultiplier" | "taxChildReliefSen"> & {
  basicSalary: string;
  dailyRate: string;
  workingHoursPerDay: string;
  workingDaysPerMonth: string;
  otMultiplier: string;
  taxChildRelief: string;
};

const toDraft = (e: EmployeeInput): Draft => ({
  ...e,
  basicSalary: rmFromSen(e.basicSalarySen),
  dailyRate: rmFromSen(e.dailyRateSen),
  workingHoursPerDay: String(e.workingHoursPerDay),
  workingDaysPerMonth: String(e.workingDaysPerMonth),
  otMultiplier: String(e.otMultiplier),
  taxChildRelief: e.taxChildReliefSen == null ? "" : rmFromSen(e.taxChildReliefSen),
});

const fromDraft = (d: Draft): EmployeeInput => {
  const { basicSalary, dailyRate, taxChildRelief, ...rest } = d;
  return {
    ...rest,
    empNo: d.empNo.trim().toUpperCase(),
    name: d.name.trim(),
    resignedOn: d.status === "RESIGNED" ? d.resignedOn : "",
    basicSalarySen: senFromRm(basicSalary),
    dailyRateSen: senFromRm(dailyRate),
    workingHoursPerDay: Number(d.workingHoursPerDay),
    workingDaysPerMonth: Number(d.workingDaysPerMonth),
    otMultiplier: Number(d.otMultiplier),
    bankName: d.paymentMethod === "CASH" ? "" : d.bankName,
    bankAccount: d.paymentMethod === "CASH" ? "" : d.bankAccount.trim(),
    taxResidency: d.pcbEnabled ? d.taxResidency : null,
    taxCategory: d.pcbEnabled ? d.taxCategory : null,
    taxChildReliefSen: d.pcbEnabled && taxChildRelief.trim() ? senFromRm(taxChildRelief) : null,
  };
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border-subtle p-3">
      <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">{title}</h3>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">{children}</div>
    </section>
  );
}

export function EmployeeDrawer({ employee, canManage, onClose, onSaved }: { employee: Employee | null; canManage: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const dialog = useDialog();
  const isNew = employee === null;
  const today = todayMY();
  const options = useEmployeeOptions(true);
  const history = useSalaryHistory(employee?.id ?? null);
  const [d, setD] = useState<Draft>(() => toDraft(employee ?? emptyEmployeeInput(today)));
  const [empNoTouched, setEmpNoTouched] = useState(!isNew);
  const [salaryFrom, setSalaryFrom] = useState(today);
  const [salaryNote, setSalaryNote] = useState("");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const ro = !canManage;

  const nextNo = options.data?.nextEmpNo;
  const empNo = !empNoTouched && isNew && nextNo ? (d.isOutsource ? nextNo.outsource : nextNo.staff) : d.empNo;
  const input = fromDraft({ ...d, empNo });
  const problem = employeeInputProblem(input);
  const salaryChanged = !isNew && input.basicSalarySen !== employee.basicSalarySen;
  const accounts = options.data?.accounts ?? [];
  const pickAccount = (raw: string) => {
    const id = raw ? Number(raw) : null;
    const a = accounts.find((x) => x.id === id);
    setD((p) => ({
      ...p,
      userId: id,
      name: p.name || a?.name || "",
      phone: p.phone || a?.phone || "",
      departmentId: p.departmentId ?? a?.department_id ?? null,
      position: p.position || a?.position || "",
    }));
  };
  const linkedElsewhere = useMemo(
    () => new Set(accounts.filter((a) => a.linkedEmpNo && a.linkedEmpNo !== employee?.empNo).map((a) => a.id)),
    [accounts, employee?.empNo],
  );
  /* Nico 2026-10-27: too many accounts to scroll, so type to search. Accounts
     another employee already uses stay listed, under their own heading. */
  const accountOptions = useMemo<SearchableSelectOption[]>(() => {
    const label = (a: (typeof accounts)[number]) => `${a.name ?? a.email}${a.position ? ` · ${a.position}` : ""}`;
    const current = d.userId != null && !accounts.some((a) => a.id === d.userId) ? [{ value: String(d.userId), label: employee?.userName ?? employee?.userEmail ?? `Account #${d.userId}` }] : [];
    return [
      { value: "", label: "Not linked (cannot punch in)" },
      ...current,
      ...accounts.filter((a) => !linkedElsewhere.has(a.id)).map((a) => ({ value: String(a.id), label: label(a) })),
      ...accounts.filter((a) => linkedElsewhere.has(a.id)).map((a) => ({ value: String(a.id), label: `${label(a)} (${a.linkedEmpNo})`, group: "Already an employee" })),
    ];
  }, [accounts, linkedElsewhere, d.userId, employee?.userName, employee?.userEmail]);

  async function save() {
    if (problem) {
      toast.error(problem);
      return;
    }
    if (salaryChanged && !/^\d{4}-\d{2}-\d{2}$/.test(salaryFrom)) {
      toast.error("Pick the date the new salary takes effect.");
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        await api.post(`${HR}/employees`, input);
      } else {
        await api.patch(`${HR}/employees/${employee.id}`, { ...input, ...(salaryChanged ? { salaryEffectiveFrom: salaryFrom, salaryNote } : {}) });
      }
      toast.success(isNew ? `${input.empNo} ${input.name} added` : `${input.empNo} saved`);
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not save the employee."));
    } finally {
      setSaving(false);
    }
  }

  async function deactivate() {
    if (!employee) return;
    const ok = await dialog.confirm({
      title: `Deactivate ${employee.empNo} ${employee.name}?`,
      message: "They drop off the active list and can no longer punch in. Their records stay; set them Active again any time.",
      confirmLabel: "Deactivate",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${HR}/employees/${employee.id}`);
      toast.success(`${employee.empNo} deactivated`);
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not deactivate the employee."));
    }
  }

  async function removeSalaryRow(id: number, label: string) {
    if (!employee) return;
    const ok = await dialog.confirm({ title: `Remove the salary from ${label}?`, message: "The salary before it applies from that date again.", confirmLabel: "Remove", tone: "danger" });
    if (!ok) return;
    try {
      await api.del(`${HR}/employees/${employee.id}/salary-history/${id}`);
      toast.success("Salary row removed");
      history.reload();
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not remove the salary row."));
    }
  }

  return (
    <ResizableDrawer
      onClose={onClose}
      title={isNew ? "Add employee" : <span><span className="font-mono">{employee.empNo}</span> {employee.name}</span>}
      subtitle={ro ? "Read-only: changing employees needs Manage employees." : "Employee Master: pay basis, how they are paid, statutory."}
      storageKey="hr-employee-drawer"
      defaultWidth={620}
      footer={
        <div className="flex items-center gap-2">
          {!isNew && canManage && employee.status !== "INACTIVE" && (
            <button type="button" className={dangerBtn} onClick={() => void deactivate()}>
              Deactivate
            </button>
          )}
          <span className="ml-auto text-[10.5px] text-err">{canManage ? problem : null}</span>
          <button type="button" className={ghostBtn} onClick={onClose}>
            {ro ? "Close" : "Cancel"}
          </button>
          {canManage && (
            <button type="button" className={primaryBtn} disabled={saving || !!problem} onClick={() => void save()}>
              {saving ? "Saving..." : isNew ? "Add" : "Save"}
            </button>
          )}
        </div>
      }
    >
      <fieldset disabled={ro} className="space-y-3 p-3">
        <Section title="Details">
          <Field label="ERP account" hint="The account they punch in / out with on the phone." className="col-span-2 max-sm:col-span-1">
            <SearchableSelect
              className={inputCls}
              ariaLabel="ERP account"
              placeholder="Type a name to search"
              disabled={ro}
              value={d.userId == null ? "" : String(d.userId)}
              options={accountOptions}
              onChange={(v) => {
                const taken = v ? accounts.find((a) => String(a.id) === v && linkedElsewhere.has(a.id)) : undefined;
                if (taken) toast.error(`${taken.name ?? taken.email} is already linked to ${taken.linkedEmpNo}.`);
                else pickAccount(v);
              }}
            />
          </Field>
          <Field label="Employee No" hint={isNew ? "Next free number; type over it if you keep your own." : undefined}>
            <input
              className={cn(inputCls, "font-mono")}
              value={empNo}
              onChange={(e) => {
                setEmpNoTouched(true);
                set("empNo", e.target.value.toUpperCase());
              }}
            />
          </Field>
          <Field label="Name">
            <input className={inputCls} value={d.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Department">
            <select className={inputCls} value={d.departmentId ?? ""} onChange={(e) => set("departmentId", e.target.value ? Number(e.target.value) : null)}>
              <option value="">--</option>
              {(options.data?.departments ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Position">
            <input className={inputCls} value={d.position} onChange={(e) => set("position", e.target.value)} placeholder="Driver, Helper, Storekeeper" />
          </Field>
          <Field label="Phone">
            <input className={inputCls} value={d.phone} onChange={(e) => set("phone", e.target.value)} inputMode="tel" />
          </Field>
          <Field label="Nationality">
            <input className={inputCls} value={d.nationality} onChange={(e) => set("nationality", e.target.value)} />
          </Field>
          <Field label="IC number">
            <input className={inputCls} value={d.icNumber} onChange={(e) => set("icNumber", e.target.value)} />
          </Field>
          <Field label="Passport number">
            <input className={inputCls} value={d.passportNumber} onChange={(e) => set("passportNumber", e.target.value)} />
          </Field>
          <Field label="Join date">
            <DateField fullWidth value={d.joinDate} onChange={(iso) => set("joinDate", iso)} aria-label="Join date" />
          </Field>
          <Field label="Status">
            <select
              className={inputCls}
              value={d.status}
              onChange={(e) => {
                const status = e.target.value as EmployeeStatus;
                setD((p) => ({ ...p, status, resignedOn: status === "RESIGNED" ? p.resignedOn || today : "" }));
              }}
            >
              {EMPLOYEE_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          {d.status === "RESIGNED" && (
            <Field label="Resigned on">
              <DateField fullWidth value={d.resignedOn} onChange={(iso) => set("resignedOn", iso)} aria-label="Resigned on" />
            </Field>
          )}
        </Section>

        <Section title="Pay">
          <div className="col-span-2 max-sm:col-span-1">
            <Toggle
              checked={d.isOutsource}
              onChange={(v) => setD((p) => ({ ...p, isOutsource: v, payMode: v ? "DAILY" : "MONTHLY" }))}
              label="Outsourced"
              hint="Numbered OSC-### and normally paid per day."
            />
          </div>
          <Field label="Pay basis">
            <select className={inputCls} value={d.payMode} onChange={(e) => set("payMode", e.target.value as Draft["payMode"])}>
              <option value="MONTHLY">Monthly salary</option>
              <option value="DAILY">Per day worked</option>
            </select>
          </Field>
          {d.payMode === "DAILY" ? (
            <Field label="Rate per day (RM)" hint="Paid for each day they work.">
              <input className={inputCls} value={d.dailyRate} onChange={(e) => set("dailyRate", e.target.value)} inputMode="decimal" />
            </Field>
          ) : (
            <Field label="Basic salary (RM)">
              <input className={inputCls} value={d.basicSalary} onChange={(e) => set("basicSalary", e.target.value)} inputMode="decimal" />
            </Field>
          )}
          {salaryChanged && (
            <>
              <Field label="New salary takes effect from" hint={`Was ${fmtRm(employee.basicSalarySen)}. Months before this date keep the old salary.`}>
                <DateField fullWidth value={salaryFrom} onChange={setSalaryFrom} aria-label="New salary takes effect from" />
              </Field>
              <Field label="Reason (optional)">
                <input className={inputCls} value={salaryNote} onChange={(e) => setSalaryNote(e.target.value)} placeholder="Annual increment" />
              </Field>
            </>
          )}
          <Field label="Days / month" hint="The divisor for the day rate.">
            <input className={inputCls} value={d.workingDaysPerMonth} onChange={(e) => set("workingDaysPerMonth", e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Hours / day" hint="Excluding lunch. 7.5 is fine.">
            <input className={inputCls} value={d.workingHoursPerDay} onChange={(e) => set("workingHoursPerDay", e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="OT multiplier" hint="Weekday overtime. Sunday and public holiday follow the Pay Rules.">
            <input className={inputCls} value={d.otMultiplier} onChange={(e) => set("otMultiplier", e.target.value)} inputMode="decimal" />
          </Field>
        </Section>

        <Section title="How they are paid">
          <Field label="Method">
            <select className={inputCls} value={d.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value as PaymentMethod)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          {d.paymentMethod !== "CASH" && (
            <>
              <Field label="Bank">
                <select className={inputCls} value={d.bankName} onChange={(e) => set("bankName", e.target.value)}>
                  <option value="">--</option>
                  {d.bankName && !MALAYSIAN_BANKS.includes(d.bankName) && <option value={d.bankName}>{d.bankName}</option>}
                  {MALAYSIAN_BANKS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Account number" className="col-span-2 max-sm:col-span-1">
                <input className={cn(inputCls, "font-mono")} value={d.bankAccount} onChange={(e) => set("bankAccount", e.target.value)} inputMode="numeric" />
              </Field>
            </>
          )}
        </Section>

        <Section title="Statutory">
          {(
            [
              ["epfEnabled", "EPF"],
              ["socsoEnabled", "SOCSO"],
              ["eisEnabled", "EIS"],
              ["pcbEnabled", "PCB (income tax)"],
            ] as const
          ).map(([k, label]) => (
            <Toggle key={k} checked={d[k]} onChange={(v) => set(k, v)} label={label} />
          ))}
        </Section>

        {d.pcbEnabled && (
          <Section title="PCB tax declaration">
            <Field label="Tax residency">
              <select className={inputCls} value={d.taxResidency ?? ""} onChange={(e) => set("taxResidency", (e.target.value || null) as TaxResidency | null)}>
                <option value="">Not declared</option>
                {TAX_RESIDENCIES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Marital category">
              <select className={inputCls} value={d.taxCategory ?? ""} onChange={(e) => set("taxCategory", (e.target.value || null) as TaxCategory | null)}>
                <option value="">Not declared</option>
                {TAX_CATEGORIES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Annual child relief (RM)" className="col-span-2 max-sm:col-span-1">
              <input className={inputCls} value={d.taxChildRelief} onChange={(e) => set("taxChildRelief", e.target.value)} inputMode="decimal" />
            </Field>
          </Section>
        )}
      </fieldset>

      {!isNew && (
        <section className="mx-3 mb-3 rounded-md border border-border-subtle p-3">
          <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Salary history</h3>
          {history.loading && !history.data && <div className="text-[11px] text-ink-muted">Loading...</div>}
          {history.error && <div className="text-[11px] text-err">{history.error}</div>}
          {history.data && history.data.history.length === 0 && <div className="text-[11px] text-ink-muted">No salary on record.</div>}
          <ul className="space-y-1">
            {(history.data?.history ?? []).map((h, _i, list) => (
              <li key={h.id} className="flex items-center gap-2 rounded bg-bg/50 px-2 py-1 text-[11.5px]">
                <span className="w-24 font-mono">{formatDate(h.effectiveFrom)}</span>
                <span className="font-mono font-semibold">{fmtRm(h.basicSalarySen)}</span>
                {h.effectiveFrom > today && <span className="text-[10.5px] text-accent">starts later</span>}
                {h.note && <span className="truncate text-[10.5px] text-ink-muted">{h.note}</span>}
                {canManage && list.length > 1 && (
                  <button
                    type="button"
                    className="ml-auto text-ink-muted hover:text-err"
                    aria-label={`Remove the salary from ${h.effectiveFrom}`}
                    onClick={() => void removeSalaryRow(h.id, formatDate(h.effectiveFrom))}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </ResizableDrawer>
  );
}
