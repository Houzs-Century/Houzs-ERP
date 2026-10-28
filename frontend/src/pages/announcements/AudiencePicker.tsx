import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Minus, Search } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Department, TeamMember } from "../../types";
import type { Company, DivisionTarget } from "./announcementModel";

// ────────────────────────────────────────────────────────────────────────────
// AudiencePicker — the composer's three-column audience (design handoff
// 2026-09-04, screen 4): Company (single-select) · Dept / Role · People.
//
// Owner decisions, 2026-09-05/06:
//   · DIVISION is the main unit of targeting ("按 Division 选择为主"): a
//     department such as Operation holds several divisions (users.division,
//     mig 0021 — the org chart's columns). The Dept column is a tree —
//     department rows with their divisions underneath — and each division is
//     a target of its own (`divisions`, stored server-side as
//     target_divisions, mig 20260906T0639, resolved at read time so someone
//     who joins the division later is in). Ticking the whole department
//     implies every division.
//   · The People column lists the focused department grouped by division;
//     a group's tick-all IS that division's target; a person reached through
//     a department / division can be UNTICKED (`excludedUserIds`, stored as
//     excluded_user_ids — the server leaves them out, whatever else targets
//     them). A person outside any selected group is an explicit pick.
//   · A search box filters the people column; names wrap, never truncate.
//
// What it produces maps onto the backend's targeting exactly:
// departments → targetDeptIds, divisions → targetDivisions, people →
// targetUserIds, unticked → excludedUserIds, company → targetCompanyIds, and
// "All staff" → no target at all (ALL_USERS).
// ────────────────────────────────────────────────────────────────────────────

export type AudienceValue = {
  /** null = every company (the backend stores NULL). */
  companyId: number | null;
  /** Explicit broadcast. Nothing else is read while it is on. */
  allStaff: boolean;
  deptIds: number[];
  /** Divisions targeted on their own (a selected department implies its divisions). */
  divisions: DivisionTarget[];
  userIds: number[];
  /** People unticked under a selected department / division (see header). */
  excludedUserIds: number[];
};

export const EMPTY_AUDIENCE: AudienceValue = {
  companyId: null,
  allStaff: false,
  deptIds: [],
  divisions: [],
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

/** Division label for grouping; "" = the department's own (unnamed) group. */
function divisionOf(u: TeamMember): string {
  return (u.division ?? "").trim();
}

function sameDivision(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function hasDivision(list: DivisionTarget[], deptId: number, division: string): boolean {
  return list.some((d) => d.deptId === deptId && sameDivision(d.division, division));
}

/** The distinct division names inside a department, A→Z (from its members). */
export function divisionsOf(users: TeamMember[], deptId: number): string[] {
  const seen = new Map<string, string>();
  for (const u of membersOf(users, deptId)) {
    const d = divisionOf(u);
    if (d && !seen.has(d.toLowerCase())) seen.set(d.toLowerCase(), d);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Members of one division of a department (primary department only — that
 *  is how the server matches a division target). */
export function membersOfDivision(users: TeamMember[], deptId: number, division: string): TeamMember[] {
  return users.filter(
    (u) => u.status === "active" && u.department_id === deptId && sameDivision(divisionOf(u), division),
  );
}

/** Everyone a selection reaches through a department or division target. */
function reachedByGroups(v: AudienceValue, users: TeamMember[]): Set<number> {
  const out = new Set<number>();
  for (const id of v.deptIds) for (const u of membersOf(users, id)) out.add(u.id);
  for (const d of v.divisions) for (const u of membersOfDivision(users, d.deptId, d.division)) out.add(u.id);
  return out;
}

/** Excluded ids that still matter: people a selected department / division reaches. */
export function activeExclusions(v: AudienceValue, users: TeamMember[]): number[] {
  if (v.allStaff || v.excludedUserIds.length === 0) return [];
  const reached = reachedByGroups(v, users);
  return v.excludedUserIds.filter((id) => reached.has(id));
}

/** Live summary line: "Operation › Driver Team + Sales · 2 unticked · Houzs Century". */
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
  const deptName = (id: number) => departments.find((d) => d.id === id)?.name ?? `Dept #${id}`;
  let who: string;
  if (v.allStaff) who = "All staff";
  else {
    const parts: string[] = [];
    // Divisions of one department read as "Operation › Driver Team + Attendant KL".
    const byDept = new Map<number, string[]>();
    for (const d of v.divisions) {
      if (v.deptIds.includes(d.deptId)) continue;
      byDept.set(d.deptId, [...(byDept.get(d.deptId) ?? []), d.division]);
    }
    const groups = [
      ...v.deptIds.map(deptName),
      ...[...byDept.entries()].map(([id, divs]) => `${deptName(id)} › ${divs.join(" + ")}`),
    ];
    if (groups.length) parts.push(groups.join(" + "));
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
  const [open, setOpen] = useState<Set<number>>(() => new Set(focusId != null ? [focusId] : []));
  // The focused department's tree is always open.
  useEffect(() => {
    if (focusId == null) return;
    setOpen((prev) => (prev.has(focusId) ? prev : new Set([...prev, focusId])));
  }, [focusId]);
  const people = useMemo(() => membersOf(p.users, focusId), [p.users, focusId]);
  const groups = useMemo(
    () => groupByDivision(people.filter((u) => personMatches(u, query))),
    [people, query],
  );
  const hasDivisions = groups.some((g) => g.division !== "");
  const showCompany = !p.salesDirOnly && p.companies.length > 1;
  const locked = p.disabled === true;
  const deptOff = p.value.allStaff;
  const reached = useMemo(() => reachedByGroups(p.value, p.users), [p.value, p.users]);

  const set = (patch: Partial<AudienceValue>) => p.onChange({ ...p.value, ...patch });
  /** Exclusions that no selected group reaches any more are forgotten. */
  const pruneExclusions = (next: AudienceValue): AudienceValue => {
    const r = reachedByGroups(next, p.users);
    return { ...next, excludedUserIds: next.excludedUserIds.filter((id) => r.has(id)) };
  };
  const toggleDept = (id: number) => {
    const on = p.value.deptIds.includes(id);
    const next = { ...p.value, deptIds: on ? p.value.deptIds.filter((x) => x !== id) : [...p.value.deptIds, id] };
    p.onChange(pruneExclusions(next));
    p.onFocusDept(id);
  };
  const toggleDivision = (deptId: number, division: string) => {
    const on = hasDivision(p.value.divisions, deptId, division);
    const next = {
      ...p.value,
      divisions: on
        ? p.value.divisions.filter((d) => !(d.deptId === deptId && sameDivision(d.division, division)))
        : [...p.value.divisions, { deptId, division }],
    };
    p.onChange(pruneExclusions(next));
    p.onFocusDept(deptId);
  };
  const isTicked = (id: number) =>
    p.value.userIds.includes(id) || (reached.has(id) && !p.value.excludedUserIds.includes(id));
  /** One click on a person: reached through a group → toggle the exclusion;
   *  otherwise → toggle the explicit pick. */
  const setPeople = (ids: number[], on: boolean) => {
    const excluded = new Set(p.value.excludedUserIds);
    const explicit = new Set(p.value.userIds);
    for (const id of ids) {
      if (reached.has(id)) {
        if (on) excluded.delete(id);
        else {
          excluded.add(id);
          explicit.delete(id);
        }
      } else if (on) explicit.add(id);
      else explicit.delete(id);
    }
    set({ excludedUserIds: [...excluded], userIds: [...explicit] });
  };
  const togglePerson = (id: number) => setPeople([id], !isTicked(id));

  return (
    <div
      className={cn(
        "grid min-h-0 flex-1",
        showCompany
          ? "grid-cols-[136px_200px_minmax(0,1fr)]"
          : "grid-cols-[200px_minmax(0,1fr)]",
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
          <span className={SUBHEAD_TEXT}>Dept / Division</span>
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
            const divisions = divisionsOf(p.users, d.id);
            const ownDivisions = p.value.divisions.filter((x) => x.deptId === d.id).length;
            const unticked = membersOf(p.users, d.id).filter(
              (u) => reached.has(u.id) && p.value.excludedUserIds.includes(u.id),
            ).length;
            const some = !on && ownDivisions > 0;
            const expanded = open.has(d.id);
            return (
              <div key={d.id} className="border-b border-border-subtle">
                <div
                  className={cn(
                    "flex items-stretch",
                    focused && !deptOff
                      ? "bg-primary-soft text-primary-ink"
                      : "bg-surface text-ink-secondary hover:bg-surface-dim",
                  )}
                >
                  <button
                    type="button"
                    disabled={locked || deptOff}
                    onClick={() => toggleDept(d.id)}
                    aria-pressed={on}
                    className="flex min-w-0 flex-1 items-start gap-1.5 px-[9px] py-2 text-left text-[11.5px] font-semibold leading-[1.3] disabled:opacity-50"
                  >
                    <Box on={on && unticked === 0} some={(on && unticked > 0) || some} />
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
                  {divisions.length > 0 && (
                    <button
                      type="button"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${d.name} divisions`}
                      aria-expanded={expanded}
                      onClick={() =>
                        setOpen((prev) => {
                          const next = new Set(prev);
                          if (next.has(d.id)) next.delete(d.id);
                          else next.add(d.id);
                          return next;
                        })
                      }
                      className="shrink-0 px-1.5 text-ink-muted hover:text-ink"
                    >
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                  )}
                </div>
                {expanded &&
                  divisions.map((division) => {
                    const picked = hasDivision(p.value.divisions, d.id, division);
                    const members = membersOfDivision(p.users, d.id, division);
                    const divUnticked = members.filter((u) => p.value.excludedUserIds.includes(u.id)).length;
                    const implied = on;
                    const ticked = implied || picked;
                    return (
                      <button
                        key={division}
                        type="button"
                        disabled={locked || deptOff || implied}
                        onClick={() => toggleDivision(d.id, division)}
                        aria-pressed={ticked}
                        aria-label={`${d.name} › ${division}`}
                        title={implied ? "Included — the whole department is selected" : undefined}
                        className={cn(
                          "flex w-full items-start gap-1.5 py-[6px] pl-[26px] pr-[9px] text-left text-[11px] font-semibold leading-[1.3] disabled:opacity-60",
                          ticked ? "bg-primary-soft/60 text-primary-ink" : "bg-surface text-ink-secondary hover:bg-surface-dim",
                        )}
                      >
                        <Box on={ticked && divUnticked === 0} some={ticked && divUnticked > 0} />
                        <span className="min-w-0 flex-1 break-words">{division}</span>
                        <span className="shrink-0 font-mono text-[9.5px] text-ink-muted">{members.length}</span>
                      </button>
                    );
                  })}
              </div>
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
            const label = g.division || (hasDivisions ? "No division" : null);
            const deptOn = focusId != null && p.value.deptIds.includes(focusId);
            const divisionOn = focusId != null && g.division !== "" && hasDivision(p.value.divisions, focusId, g.division);
            const groupOn = deptOff || deptOn || divisionOn;
            const allOn = deptOff || tickedCount === ids.length;
            const someOn = !deptOff && tickedCount > 0 && tickedCount < ids.length;
            // A named division's tick-all IS the division target; the unnamed
            // rest can only be picked person by person (explicit ids).
            const onGroupClick = () => {
              if (focusId == null) return;
              if (g.division !== "") {
                if (deptOn) return; // implied by the department
                if (divisionOn && tickedCount < ids.length) {
                  // Some were unticked: re-tick them all first.
                  setPeople(ids, true);
                  return;
                }
                toggleDivision(focusId, g.division);
              } else {
                setPeople(ids, !allOn);
              }
            };
            return (
              <div key={g.division || "__no-division"} className="shrink-0">
                {label !== null && (
                  <button
                    type="button"
                    disabled={locked || deptOff || (g.division !== "" && deptOn)}
                    onClick={onGroupClick}
                    aria-pressed={groupOn || allOn}
                    aria-label={`${label} — everyone`}
                    title={
                      g.division !== "" && deptOn
                        ? "Included — the whole department is selected"
                        : g.division !== ""
                          ? "Target this division (new members are included automatically)"
                          : undefined
                    }
                    className="flex w-full items-center gap-1.5 border-b border-border bg-surface-dim px-[9px] py-[5px] text-left disabled:opacity-60"
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
                  const viaGroup = reached.has(u.id);
                  const excluded = viaGroup && p.value.excludedUserIds.includes(u.id);
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
                          : viaGroup
                            ? "Included through the department / division · click to untick"
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
