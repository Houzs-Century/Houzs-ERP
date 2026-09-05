import { useMemo, useState } from "react";
import { Check, Minus, Search } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Department, TeamMember } from "../../types";
import type { Company } from "./announcementModel";

// ────────────────────────────────────────────────────────────────────────────
// AudiencePicker — the composer's three-column audience (design handoff
// 2026-09-04, screen 4): Company (single-select) · Dept / Role (checkbox rows
// that also focus column three) · People · <Dept> (checkbox rows).
//
// Owner feedback 2026-09-05 (first day on prod):
//   · people are grouped by DIVISION (users.division, mig 0021 — the same
//     free-text sub-grouping the org chart uses), each group with its own
//     tick-all box;
//   · a search box filters the people column by name / position / division;
//   · a person under a SELECTED department can be UNTICKED. The backend has
//     no exclusion list, so an untick is recorded here (`excludedUserIds`)
//     and resolved at post time by buildPostBody(): a department with
//     unticked people is expanded into its remaining members and sent as
//     targetUserIds. The trade-off — someone who joins that department after
//     posting is not added automatically — is stated in the summary line.
//   · names and department names wrap instead of truncating.
//
// What it produces maps onto the backend's existing targeting exactly:
// departments → targetDeptIds, people → targetUserIds (MIXED when both),
// company → targetCompanyIds, and "All staff" → no target at all (ALL_USERS).
// ────────────────────────────────────────────────────────────────────────────

export type AudienceValue = {
  /** null = every company (the backend stores NULL). */
  companyId: number | null;
  /** Explicit broadcast. Nothing else is read while it is on. */
  allStaff: boolean;
  deptIds: number[];
  userIds: number[];
  /** People unticked under a selected department (see header). */
  excludedUserIds: number[];
};

export const EMPTY_AUDIENCE: AudienceValue = {
  companyId: null,
  allStaff: false,
  deptIds: [],
  userIds: [],
  excludedUserIds: [],
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

/** Members of one department (primary or additional membership), active only. */
export function membersOf(users: TeamMember[], deptId: number | null): TeamMember[] {
  if (deptId == null) return [];
  return users.filter(
    (u) =>
      u.status === "active" &&
      (u.department_id === deptId || (u.department_ids ?? []).includes(deptId)),
  );
}

/** Excluded ids that still matter: members of a selected department. */
export function activeExclusions(v: AudienceValue, users: TeamMember[]): number[] {
  if (v.allStaff || v.excludedUserIds.length === 0 || v.deptIds.length === 0) return [];
  const members = new Set<number>();
  for (const id of v.deptIds) for (const u of membersOf(users, id)) members.add(u.id);
  return v.excludedUserIds.filter((id) => members.has(id));
}

/**
 * The people a selection reaches, resolved on the client. Only used when
 * something was unticked: the backend then receives this list instead of the
 * department ids.
 */
export function resolveRecipients(v: AudienceValue, users: TeamMember[]): number[] {
  const out = new Set<number>();
  for (const id of v.deptIds) for (const u of membersOf(users, id)) out.add(u.id);
  for (const id of v.userIds) out.add(id);
  for (const id of v.excludedUserIds) out.delete(id);
  return [...out];
}

/** Live summary line: "Warehouse + Operation · 2 unticked · Houzs Century". */
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
    const explicit = v.userIds.filter((id) => !v.excludedUserIds.includes(id));
    if (explicit.length) {
      const names = explicit.map((id) => {
        const u = users.find((x) => x.id === id);
        return u ? u.name || u.email : `#${id}`;
      });
      parts.push(names.length <= 2 ? names.join(", ") : `${names.length} people`);
    }
    const excluded = activeExclusions(v, users).length;
    if (excluded) parts.push(`${excluded} unticked`);
    who = parts.length ? parts.join(" · ") : "No recipients yet";
  }
  return company ? `${who} · ${company}` : who;
}

/** Division label for grouping; "" = the department's own (unnamed) group. */
function divisionOf(u: TeamMember): string {
  return (u.division ?? "").trim();
}

export type DivisionGroup = { division: string; members: TeamMember[] };

/** Members grouped by division, named divisions A→Z, the unnamed rest last. */
export function groupByDivision(members: TeamMember[]): DivisionGroup[] {
  const map = new Map<string, TeamMember[]>();
  for (const u of members) {
    const key = divisionOf(u);
    const list = map.get(key);
    if (list) list.push(u);
    else map.set(key, [u]);
  }
  const named = [...map.keys()].filter((k) => k !== "").sort((a, b) => a.localeCompare(b));
  const order = map.has("") ? [...named, ""] : named;
  return order.map((division) => ({
    division,
    members: [...(map.get(division) ?? [])].sort((a, b) =>
      (a.name || a.email || "").localeCompare(b.name || b.email || ""),
    ),
  }));
}

/** Case-insensitive match on name / email / position / division. */
export function personMatches(u: TeamMember, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [u.name, u.email, u.position_name, u.role_name, u.division]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .some((s) => s.toLowerCase().includes(needle));
}

const SUBHEAD = "border-b border-border bg-surface-2 px-[9px] py-[5px]";
const SUBHEAD_TEXT = "font-mono text-[9px] font-bold uppercase tracking-wider text-ink-muted";

function Box({ on, some }: { on: boolean; some?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-px grid h-[13px] w-[13px] shrink-0 place-items-center rounded-[3px] text-white",
        on || some ? "bg-primary" : "border border-border bg-surface",
      )}
    >
      {on ? <Check size={9} strokeWidth={3} /> : some ? <Minus size={9} strokeWidth={3} /> : null}
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
  const [query, setQuery] = useState("");
  const people = useMemo(() => membersOf(p.users, focusId), [p.users, focusId]);
  const groups = useMemo(
    () => groupByDivision(people.filter((u) => personMatches(u, query))),
    [people, query],
  );
  const hasDivisions = groups.some((g) => g.division !== "");
  const showCompany = !p.salesDirOnly && p.companies.length > 1;
  const locked = p.disabled === true;
  const deptOff = p.value.allStaff;
  const focusSelected = focusId != null && p.value.deptIds.includes(focusId);

  const set = (patch: Partial<AudienceValue>) => p.onChange({ ...p.value, ...patch });
  const toggleDept = (id: number) => {
    const on = p.value.deptIds.includes(id);
    if (on) {
      // Unticking a department forgets the people unticked under it (unless
      // another selected department still reaches them).
      const remaining = p.value.deptIds.filter((x) => x !== id);
      const stillReached = new Set<number>();
      for (const d of remaining) for (const u of membersOf(p.users, d)) stillReached.add(u.id);
      set({
        deptIds: remaining,
        excludedUserIds: p.value.excludedUserIds.filter((x) => stillReached.has(x)),
      });
    } else {
      set({ deptIds: [...p.value.deptIds, id] });
    }
    p.onFocusDept(id);
  };
  const isTicked = (id: number) =>
    p.value.userIds.includes(id) || (focusSelected && !p.value.excludedUserIds.includes(id));
  /** One click on a person: under a selected department it toggles the
   *  exclusion; otherwise it toggles the explicit pick. */
  const setPeople = (ids: number[], on: boolean) => {
    if (focusSelected) {
      const excluded = new Set(p.value.excludedUserIds);
      const explicit = new Set(p.value.userIds);
      for (const id of ids) {
        if (on) excluded.delete(id);
        else {
          excluded.add(id);
          explicit.delete(id);
        }
      }
      set({ excludedUserIds: [...excluded], userIds: [...explicit] });
    } else {
      const explicit = new Set(p.value.userIds);
      for (const id of ids) {
        if (on) explicit.add(id);
        else explicit.delete(id);
      }
      set({ userIds: [...explicit] });
    }
  };
  const togglePerson = (id: number) => setPeople([id], !isTicked(id));

  return (
    <div
      className={cn(
        "grid min-h-0 flex-1",
        showCompany
          ? "grid-cols-[136px_176px_minmax(0,1fr)]"
          : "grid-cols-[176px_minmax(0,1fr)]",
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
                  "break-words border-b border-border-subtle px-[9px] py-2 text-left text-[11.5px] font-semibold leading-[1.3]",
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
              "flex items-start gap-1.5 border-b border-border px-[9px] py-2 text-left text-[11.5px] font-semibold leading-[1.3]",
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
            const unticked = on ? membersOf(p.users, d.id).filter((u) => p.value.excludedUserIds.includes(u.id)).length : 0;
            return (
              <button
                key={d.id}
                type="button"
                disabled={locked || deptOff}
                onClick={() => toggleDept(d.id)}
                aria-pressed={on}
                className={cn(
                  "flex items-start gap-1.5 border-b border-border-subtle px-[9px] py-2 text-left text-[11.5px] font-semibold leading-[1.3] disabled:opacity-50",
                  focused && !deptOff
                    ? "bg-primary-soft text-primary-ink"
                    : "bg-surface text-ink-secondary hover:bg-surface-dim",
                )}
              >
                <Box on={on && unticked === 0} some={on && unticked > 0} />
                <span className="min-w-0 flex-1 break-words">
                  {d.name}
                  {unticked > 0 && (
                    <span className="ml-1 font-mono text-[9.5px] font-bold text-warning-text">−{unticked}</span>
                  )}
                </span>
                {!deptOff && (
                  <span
                    aria-hidden
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onFocusDept(d.id);
                    }}
                    className="shrink-0 rounded px-1 text-[9.5px] font-bold uppercase text-ink-muted hover:text-ink"
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
        <div className={cn(SUBHEAD, "sticky top-0 z-10 flex flex-col gap-1.5")}>
          <span className={cn(SUBHEAD_TEXT, "break-words")}>People · {focusDept?.name ?? "—"}</span>
          <label className="flex items-center gap-1.5 rounded border border-border bg-surface px-2 py-1">
            <Search size={11} className="shrink-0 text-ink-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, position, division"
              aria-label="Search people"
              className="w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-muted"
            />
          </label>
        </div>
        {people.length === 0 ? (
          <span className="px-[9px] py-2 text-[11px] text-ink-muted">
            {focusDept ? "Nobody in this department." : "Pick a department."}
          </span>
        ) : groups.length === 0 ? (
          <span className="px-[9px] py-2 text-[11px] text-ink-muted">
            Nobody in {focusDept?.name ?? "this department"} matches “{query.trim()}”.
          </span>
        ) : (
          groups.map((g) => {
            const ids = g.members.map((u) => u.id);
            const tickedCount = ids.filter((id) => isTicked(id)).length;
            const allOn = deptOff || tickedCount === ids.length;
            const someOn = !deptOff && tickedCount > 0 && tickedCount < ids.length;
            const label = g.division || (hasDivisions ? "No division" : null);
            return (
              <div key={g.division || "__no-division"} className="shrink-0">
                {label !== null && (
                  <button
                    type="button"
                    disabled={locked || deptOff}
                    onClick={() => setPeople(ids, !allOn)}
                    aria-pressed={allOn}
                    aria-label={`${label} — everyone`}
                    className="flex w-full items-center gap-1.5 border-b border-border bg-surface-dim px-[9px] py-[5px] text-left disabled:opacity-50"
                  >
                    <Box on={allOn} some={someOn} />
                    <span className="min-w-0 flex-1 break-words font-mono text-[9.5px] font-bold uppercase tracking-wider text-ink-secondary">
                      {label}
                    </span>
                    <span className="shrink-0 font-mono text-[9.5px] text-ink-muted">
                      {tickedCount}/{ids.length}
                    </span>
                  </button>
                )}
                {g.members.map((u) => {
                  const on = deptOff || isTicked(u.id);
                  const excluded = focusSelected && p.value.excludedUserIds.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      disabled={locked || deptOff}
                      onClick={() => togglePerson(u.id)}
                      aria-pressed={on}
                      title={
                        excluded
                          ? "Unticked — will not receive this notice"
                          : focusSelected
                            ? "Included through the department · click to untick"
                            : undefined
                      }
                      className={cn(
                        "flex w-full items-start gap-1.5 border-b border-border-subtle px-[9px] py-[7px] text-left disabled:opacity-50",
                        on ? "bg-primary-soft" : "bg-surface hover:bg-surface-dim",
                        excluded && "opacity-60",
                      )}
                    >
                      <Box on={on} />
                      <span className="flex min-w-0 flex-1 flex-col gap-px">
                        <span
                          className={cn(
                            "break-words text-[11.5px] font-semibold leading-[1.3] text-ink",
                            excluded && "line-through",
                          )}
                        >
                          {u.name || u.email}
                        </span>
                        <span className="break-words text-[10px] leading-[1.3] text-ink-muted">
                          {u.position_name ?? u.role_name}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
