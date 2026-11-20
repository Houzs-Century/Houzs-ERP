/* HR · Employee edit modal (redesign stage 4). Opens on any employee click
 * (table, board, Overview). Read-only sample data for now; a two-column body of
 * Basic info / ERP account / Pay / Statutory / Permit (foreign) / Attendance.
 * Salary masked. */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fmtSen } from "../../vendor/shared/format";
import { formatDate } from "../../lib/utils";
import { POSITION, avatarColor, initials, type Emp } from "./hrSampleData";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

const fmtDate = (iso: string | null): string => (iso ? formatDate(iso) : "—");
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - new Date("2026-11-20").getTime()) / 86400000);
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">{title}</div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}
function Field({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-[11px] text-ink-muted">{label}</span>
      <span className="flex h-9 items-center rounded-md border border-border bg-surface-2 px-2.5 text-[12.5px] text-ink">{value}</span>
    </label>
  );
}
function StatRow({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border-subtle px-2.5 py-1.5">
      <span className="text-[12px] text-ink-secondary">{label}</span>
      {on
        ? <span className="rounded bg-synced-bg px-1.5 py-0.5 text-[10px] font-bold uppercase text-synced">Enrolled</span>
        : <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-muted">N/A</span>}
    </div>
  );
}

export function EmployeeEditModal({ emp, onClose }: { emp: Emp; onClose: () => void }) {
  const [showSalary, setShowSalary] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const p = POSITION[emp.position];
  const money = (sen: number) => (showSalary ? fmtSen(sen) : "RM ••••••");
  const permitDays = daysUntil(emp.permitExpiry);
  const todayPunch =
    emp.punch === "out" ? { t: "Not in", s: "text-err" } :
    emp.punch === "leave" ? { t: "On leave", s: "text-ink-muted" } :
    { t: `${emp.time} In · shift ${emp.shift}`, s: "text-ink" };
  // Sample 30-day attendance strip.
  const STRIP = Array.from({ length: 30 }, (_, i) => {
    const d = i + 1;
    if (d % 7 === 0 || d % 7 === 6) return "rest";
    if (d === 4 || d === 14) return "late";
    if (d === 20) return "leave";
    return "present";
  });
  const stripColor: Record<string, string> = { present: "bg-synced-bg", late: "bg-warning-bg", leave: "bg-surface-dim", absent: "bg-err-bg", rest: "bg-surface-2" };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-6" style={{ background: "rgba(17,20,15,.42)" }} onMouseDown={onClose}>
      <div
        className="my-6 flex max-h-[86vh] w-full max-w-[880px] animate-rise flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_24px_64px_-16px_rgba(17,20,15,.35)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span className={cx("flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full text-[18px] font-semibold text-white", avatarColor(emp.name))}>{initials(emp.name)}</span>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[11px] font-semibold text-accent">{emp.empNo}</div>
            <div className="truncate text-[18px] font-bold leading-tight text-ink">{emp.name}</div>
            <div className="mt-1 flex items-center gap-2">
              <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", p.soft, p.text)}><span className={cx("h-1.5 w-1.5 rounded-full", p.dot)} />{p.label}</span>
              {emp.status === "ACTIVE"
                ? <span className="text-[10px] font-bold uppercase tracking-wide text-synced">Active</span>
                : <span className="rounded bg-warning-bg px-1.5 py-0.5 text-[10px] font-bold uppercase text-warning-text">Probation</span>}
            </div>
          </div>
          <div className="hidden text-right sm:block">
            <div className="text-[10px] text-ink-muted">today</div>
            <div className={cx("font-mono text-[12.5px] font-semibold", todayPunch.s)}>{todayPunch.t}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink">✕</button>
        </div>

        {/* body */}
        <div className="thin-scroll grid flex-1 grid-cols-1 gap-x-6 gap-y-5 overflow-y-auto px-5 py-4 md:grid-cols-2">
          {/* left column */}
          <div className="flex flex-col gap-5">
            <Section title="Basic info">
              <Field label="Full name" value={emp.name} />
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Emp No" value={<span className="font-mono">{emp.empNo}</span>} />
                <Field label="Joined" value={fmtDate(emp.joined)} />
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Department" value="Operation Department" />
                <Field label="Position" value={p.label} />
              </div>
            </Section>

            <Section title="Statutory">
              <StatRow label="EPF (KWSP)" on={!emp.foreign} />
              <StatRow label="SOCSO (PERKESO)" on={true} />
              <StatRow label="EIS (SIP)" on={!emp.foreign} />
            </Section>

            <Section title="Attendance · Nov 2026">
              <div className="grid grid-cols-4 gap-2">
                {[{ l: "Present", n: 18, c: "text-synced" }, { l: "Late", n: 3, c: "text-time" }, { l: "Leave", n: 1, c: "text-ink-secondary" }, { l: "Absent", n: 0, c: "text-err" }].map((t) => (
                  <div key={t.l} className="rounded-lg border border-border-subtle px-2 py-2 text-center">
                    <div className={cx("text-[18px] font-bold leading-none", t.c)}>{t.n}</div>
                    <div className="mt-1 text-[10px] text-ink-muted">{t.l}</div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-1">
                {STRIP.map((s, i) => <span key={i} className={cx("h-4 w-4 rounded-sm", stripColor[s])} title={`Day ${i + 1}: ${s}`} />)}
              </div>
            </Section>
          </div>

          {/* right column */}
          <div className="flex flex-col gap-5">
            <Section title="ERP account">
              {emp.erp ? (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-ink-muted">Punches in with</div>
                    <div className="truncate font-mono text-[12.5px] font-semibold uppercase text-ink">{emp.erp}</div>
                  </div>
                  <button type="button" className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:bg-surface-2">Change</button>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-warning-text/30 bg-warning-bg px-3 py-2.5">
                  <div className="min-w-0 flex-1 text-[12px] font-semibold text-warning-text">Cannot punch in until linked</div>
                  <button type="button" className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-primary-ink">Link account</button>
                </div>
              )}
            </Section>

            <Section title="Pay">
              <Field
                label="Basic salary"
                value={
                  <span className="flex w-full items-center justify-between">
                    <span className="font-money">{money(emp.salarySen)}</span>
                    <button type="button" onClick={() => setShowSalary((v) => !v)} className="text-[11px] font-semibold text-primary">{showSalary ? "Hide" : "Show"}</button>
                  </span>
                }
              />
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Pay basis" value="Monthly + trip pay" />
                <Field label="Paid by" value="Bank transfer · Maybank" />
              </div>
            </Section>

            {emp.foreign && (
              <Section title="Permit & documents">
                <div className="flex items-center justify-between rounded-md border border-border-subtle px-2.5 py-2">
                  <div>
                    <div className="text-[12px] text-ink-secondary">Work permit</div>
                    <div className="text-[11px] text-ink-muted">Expires {fmtDate(emp.permitExpiry)}</div>
                  </div>
                  {permitDays != null && permitDays < 90
                    ? <span className="rounded-full bg-err-bg px-2 py-0.5 text-[10px] font-bold text-err">{permitDays}d left</span>
                    : <span className="rounded-full bg-synced-bg px-2 py-0.5 text-[10px] font-bold text-synced">OK</span>}
                </div>
                <div className="flex items-center justify-between rounded-md border border-border-subtle px-2.5 py-2">
                  <div>
                    <div className="text-[12px] text-ink-secondary">Passport</div>
                    <div className="text-[11px] text-ink-muted">Expires {fmtDate("2028-06-30")}</div>
                  </div>
                  <span className="rounded-full bg-synced-bg px-2 py-0.5 text-[10px] font-bold text-synced">OK</span>
                </div>
              </Section>
            )}
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <span className="text-[11.5px] text-ink-muted">Changes apply from next payroll run.</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-border bg-surface px-3.5 py-1.5 text-[12px] font-semibold text-ink-secondary hover:bg-surface-2">Cancel</button>
            <button type="button" className="rounded-md bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-primary-ink">Save changes</button>
          </div>
        </div>
      </div>
    </div>
  );
}
