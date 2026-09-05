import { useMemo } from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Department, TeamMember } from "../../types";
import type { Company } from "./announcementModel";

// ────────────────────────────────────────────────────────────────────────────
// AudiencePicker — the composer's three-column audience (design handoff
// 2026-09-04, screen 4): Company (single-select) · Dept / Role (checkbox rows
// that also focus column three) · People · <Dept> (checkbox rows).
//
// What it produces maps onto the backend's existing targeting exactly:
// departments → targetDeptIds, people → targetUserIds (MIXED when both),
// company → targetCompanyIds, and "All staff" → no target at all (ALL_USERS).
// Inclusion only — the backend has no exclusion list, so a person's checkbox
// ADDS them; it cannot carve them out of a selected department.
// ────────────────────────────────────────────────────────────────────────────

export type AudienceValue = {
  /** null = every company (the backend stores NULL). */
  companyId: number | null;
  /** Explicit broadcast. Nothing else is read while it is on. */
  allStaff: boolean;
  deptIds: number[];
  userIds: number[];
};

export const EMPTY_AUDIENCE: AudienceValue = {
  companyId: null,
  allStaff: false,
  deptIds: [],
  userIds: [],
};

export type AudiencePickerProps = {
  value: AudienceValue;
  onChange: (next: AudienceValue) => void;
  /** Which department column three lists (deptKey string), null = first. */
  focusDeptId: number | null;
  onFocusDept: (id: number) => void;
  companies: Company[];
  departments: Department[];
  users: TeamMember[];
  /** A Sales-Director-only composer: no company column, no All staff — the
   *  department list is already server-scoped to their own department. */
  salesDirOnly: boolean;
  disabled?: boolean;
};

/** Live summary line: "Warehouse + Operation · Houzs Century". */
export function audienceSummary(
  v: AudienceValue,
  companies: Company[],
  departments: Department[],
  users: TeamMember[],
): string {
  const company =
    v.companyId == null
      ? companies.length > 1
        ? "All companies"
        : ""
      : companies.find((c) => c.id === v.companyId)?.name ?? `Company #${v.companyId}`;
  let who: string;
  if (v.allStaff) who = "All staff";
  else {
    const parts: string[] = [];
    if (v.deptIds.length) {
      parts.push(
        v.deptIds.map((id) => departments.find((d) => d.id === id)?.name ?? `Dept #${id}`).join(" + "),
      );
    }
    if (v.userIds.length) {
      const names = v.userIds.map((id) => {
        const u = users.find((x) => x.id === id);
        return u ? u.name || u.email : `#${id}`;
      });
      parts.push(names.length <= 2 ? names.join(", ") : `${names.length} people`);
    }
    who = parts.length ? parts.join(" · ") : "No recipients yet";
  }
  return company ? `${who} · ${company}` : who;
}

/** Members of one department (primary or additional membership), active only. */
export function membersOf(users: TeamMember[], deptId: number | null): TeamMember[] {
  if (deptId == null) return [];
  return users.filter(
    (u) =>
      u.status === "active" &&
      (u.department_id === deptId || (u.department_ids ?? []).includes(deptId)),
  );
}

const SUBHEAD = "border-b border-border bg-surface-2 px-[9px] py-[5px]";
const SUBHEAD_TEXT = "font-mono text-[9px] font-bold uppercase tracking-wider text-ink-muted";

function Box({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-[13px] w-[13px] shrink-0 place-items-center rounded-[3px] text-white",
        on ? "bg-primary" : "border border-border bg-surface",
      )}
    >
      {on && <Check size={9} strokeWidth={3} />}
    </span>
  );
}

export function AudiencePicker(p: AudiencePickerProps) {
  const firstDeptId = p.departments.length > 0 ? p.departments[0].id : null;
  const focusId =
    p.focusDeptId != null && p.departments.some((d) => d.id === p.focusDeptId)
      ? p.focusDeptId
      : firstDeptId;
  const focusDept = p.departments.find((d) => d.id === focusId) ?? null;
  const people = useMemo(() => membersOf(p.users, focusId), [p.users, focusId]);
  const showCompany = !p.salesDirOnly && p.companies.length > 1;
  const locked = p.disabled === true;
  const deptOff = p.value.allStaff;

  const set = (patch: Partial<AudienceValue>) => p.onChange({ ...p.value, ...patch });
  const toggleDept = (id: number) => {
    const on = p.value.deptIds.includes(id);
    set({ deptIds: on ? p.value.deptIds.filter((x) => x !== id) : [...p.value.deptIds, id] });
    p.onFocusDept(id);
  };
  const togglePerson = (id: number) => {
    const on = p.value.userIds.includes(id);
    set({ userIds: on ? p.value.userIds.filter((x) => x !== id) : [...p.value.userIds, id] });
  };

  return (
    <div
      className={cn(
        "grid min-h-0 flex-1",
        showCompany ? "grid-cols-[1fr_1fr_1.15fr]" : "grid-cols-[1fr_1.15fr]",
      )}
    >
      {showCompany && (
        <div className="flex min-h-0 flex-col overflow-auto border-r border-border">
          <div className={SUBHEAD}>
            <span className={SUBHEAD_TEXT}>Company</span>
          </div>
          {[
            { id: null as number | null, label: "All companies" },
            ...p.companies.map((c) => ({ id: c.id as number | null, label: c.name })),
          ].map((c) => {
            const on = p.value.companyId === c.id;
            return (
              <button
                key={c.id ?? "all"}
                type="button"
                disabled={locked}
                onClick={() => set({ companyId: c.id })}
                aria-pressed={on}
                className={cn(
                  "border-b border-border-subtle px-[9px] py-2 text-left text-[11.5px] font-semibold",
                  on ? "bg-primary-soft text-primary-ink" : "bg-surface text-ink-secondary hover:bg-surface-dim",
                )}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex min-h-0 flex-col overflow-auto border-r border-border">
        <div className={SUBHEAD}>
          <span className={SUBHEAD_TEXT}>Dept / Role</span>
        </div>
        {!p.salesDirOnly && (
          <button
            type="button"
            disabled={locked}
            onClick={() => set({ allStaff: !p.value.allStaff })}
            aria-pressed={p.value.allStaff}
            className={cn(
              "flex items-center gap-1.5 border-b border-border px-[9px] py-2 text-left text-[11.5px] font-semibold",
              p.value.allStaff ? "bg-primary-soft text-primary-ink" : "bg-surface text-ink hover:bg-surface-dim",
            )}
          >
            <Box on={p.value.allStaff} />
            All staff
          </button>
        )}
        {p.departments.length === 0 ? (
          <span className="px-[9px] py-2 text-[11px] text-ink-muted">No departments</span>
        ) : (
          p.departments.map((d) => {
            const on = p.value.deptIds.includes(d.id);
            const focused = d.id === focusId;
            return (
              <button
                key={d.id}
                type="button"
                disabled={locked || deptOff}
                onClick={() => toggleDept(d.id)}
                aria-pressed={on}
                className={cn(
                  "flex items-center gap-1.5 border-b border-border-subtle px-[9px] py-2 text-left text-[11.5px] font-semibold disabled:opacity-50",
                  focused && !deptOff
                    ? "bg-primary-soft text-primary-ink"
                    : "bg-surface text-ink-secondary hover:bg-surface-dim",
                )}
              >
                <Box on={on} />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                {!deptOff && (
                  <span
                    aria-hidden
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onFocusDept(d.id);
                    }}
                    className="rounded px-1 text-[9.5px] font-bold uppercase text-ink-muted hover:text-ink"
                  >
                    people
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      <div className="flex min-h-0 flex-col overflow-auto">
        <div className={SUBHEAD}>
          <span className={SUBHEAD_TEXT}>People · {focusDept?.name ?? "—"}</span>
        </div>
        {people.length === 0 ? (
          <span className="px-[9px] py-2 text-[11px] text-ink-muted">
            {focusDept ? "Nobody in this department." : "Pick a department."}
          </span>
        ) : (
          people.map((u) => {
            const on = p.value.userIds.includes(u.id);
            const viaDept = deptOff || (focusId != null && p.value.deptIds.includes(focusId));
            return (
              <button
                key={u.id}
                type="button"
                disabled={locked || deptOff}
                onClick={() => togglePerson(u.id)}
                aria-pressed={on}
                title={viaDept && !on ? "Already included through the department" : undefined}
                className={cn(
                  "flex items-center gap-1.5 border-b border-border-subtle px-[9px] py-[7px] text-left disabled:opacity-50",
                  on ? "bg-primary-soft" : "bg-surface hover:bg-surface-dim",
                )}
              >
                <Box on={on || viaDept} />
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="truncate text-[11.5px] font-semibold text-ink">{u.name || u.email}</span>
                  <span className="truncate text-[10px] text-ink-muted">{u.position_name ?? u.role_name}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
