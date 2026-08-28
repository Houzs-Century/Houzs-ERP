import type { ReactNode } from "react";
import type { TeamMember, Department } from "../../types";
import { cn } from "../../lib/utils";

/* Shared model + small UI pieces for the redesigned Team screens
 * (Directory / Member Profile / Invite / Org Chart / Departments /
 * Mailboxes — design handoff "ERP Team模块重整", 2026-08).
 *
 * Everything here is DERIVED from the existing /api/users +
 * /api/departments payloads — the redesign introduces no new columns.
 * Where the design assumed data the schema doesn't have (department
 * lead, teams-as-entities, headcount targets), the mapping is:
 *   design "Team"        → users.division (free-text sub-grouping)
 *   design "Lead"        → derived: the department member most others
 *                          in the department report to (see deriveDeptLead)
 *   design "EMP-xxxx"    → derived from the user id with the same formula
 *                          the scm.staff sync trigger uses (mig 0066)
 *   design "headcount N" → not available; screens show live counts only
 */

/** Employee code, matching scm.staff.staff_code = 'EMP-' || lpad(id, 4, '0'). */
export function empCode(userId: number): string {
  return "EMP-" + String(userId).padStart(4, "0");
}

/** Members whose PRIMARY department is `deptId` — mirrors the backend's
 *  member_count semantics (primary only, so tree counts match the API). */
export function inPrimaryDept(u: TeamMember, deptId: number | null): boolean {
  return u.department_id === deptId;
}

export type DeptCounts = {
  active: number;
  invited: number;
  disabled: number;
  /** active + invited — what the tree shows (disabled excluded). */
  visible: number;
};

export function countByStatus(members: TeamMember[]): DeptCounts {
  let active = 0;
  let invited = 0;
  let disabled = 0;
  for (const m of members) {
    if (m.status === "active") active++;
    else if (m.status === "invited") invited++;
    else disabled++;
  }
  return { active, invited, disabled, visible: active + invited };
}

export type DivisionNode = { name: string; counts: DeptCounts };

export type DeptNode = {
  dept: Department;
  counts: DeptCounts;
  divisions: DivisionNode[];
  lead: TeamMember | null;
  /** true when `lead` is the department's EXPLICITLY chosen lead
   *  (dept.lead_user_id), false when it was derived from manager_id. */
  leadIsChosen: boolean;
};

/** The division string, normalised: trimmed, empty → null. */
export function divisionOf(u: TeamMember): string | null {
  const d = (u.division ?? "").trim();
  return d ? d : null;
}

/**
 * Derived department lead — the schema has no lead column, so the lead is
 * inferred: the ACTIVE department member the most OTHER department members
 * report to (users.manager_id). Ties break toward total direct reports
 * anywhere, then earliest join. No internal reports → no lead (null), which
 * is what the red "No lead" states key off.
 */
export function deriveDeptLead(
  deptMembers: TeamMember[],
  allMembers: TeamMember[],
): TeamMember | null {
  const inDeptIds = new Set(deptMembers.map((m) => m.id));
  const internalReports = new Map<number, number>();
  for (const m of deptMembers) {
    if (m.manager_id != null && inDeptIds.has(m.manager_id)) {
      internalReports.set(m.manager_id, (internalReports.get(m.manager_id) ?? 0) + 1);
    }
  }
  if (internalReports.size === 0) return null;
  const totalReports = new Map<number, number>();
  for (const m of allMembers) {
    if (m.manager_id != null)
      totalReports.set(m.manager_id, (totalReports.get(m.manager_id) ?? 0) + 1);
  }
  const candidates = deptMembers.filter(
    (m) => m.status === "active" && internalReports.has(m.id),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const byInternal =
      (internalReports.get(b.id) ?? 0) - (internalReports.get(a.id) ?? 0);
    if (byInternal !== 0) return byInternal;
    const byTotal = (totalReports.get(b.id) ?? 0) - (totalReports.get(a.id) ?? 0);
    if (byTotal !== 0) return byTotal;
    return (a.joined_at ?? "9999").localeCompare(b.joined_at ?? "9999");
  });
  return candidates[0];
}

/** Build the department tree the Directory rail + Departments cards render. */
export function buildDeptNodes(
  members: TeamMember[],
  departments: Department[],
): { nodes: DeptNode[]; noDept: DeptCounts } {
  const sorted = [...departments].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
  );
  const nodes: DeptNode[] = sorted.map((dept) => {
    const deptMembers = members.filter((m) => inPrimaryDept(m, dept.id));
    const byDivision = new Map<string, TeamMember[]>();
    for (const m of deptMembers) {
      const div = divisionOf(m);
      if (!div) continue;
      const list = byDivision.get(div) ?? [];
      list.push(m);
      byDivision.set(div, list);
    }
    const divisions: DivisionNode[] = [...byDivision.entries()]
      .map(([name, ms]) => ({ name, counts: countByStatus(ms) }))
      .sort((a, b) => b.counts.visible - a.counts.visible || a.name.localeCompare(b.name));
    // The REAL lead (dept.lead_user_id, mig-pg 0331) wins over the derived one:
    // an explicit choice beats an inference. Falls back to deriveDeptLead only
    // when no lead is set, or when the chosen person is no longer a member — so
    // the red "No lead" state still keys off "nobody, derived or chosen".
    const chosenLead =
      dept.lead_user_id != null
        ? members.find((m) => m.id === dept.lead_user_id) ?? null
        : null;
    return {
      dept,
      counts: countByStatus(deptMembers),
      divisions,
      lead: chosenLead ?? deriveDeptLead(deptMembers, members),
      leadIsChosen: chosenLead != null,
    };
  });
  const noDept = countByStatus(members.filter((m) => m.department_id == null));
  return { nodes, noDept };
}

/** Needs-attention counters for the Directory rail. */
export function attentionCounts(members: TeamMember[]) {
  return {
    pending: members.filter((m) => m.status === "invited").length,
    neverLoggedIn: members.filter(
      (m) => m.status === "active" && !m.last_login_at,
    ).length,
    disabled: members.filter((m) => m.status === "disabled").length,
  };
}

/** Status → Badge mapping, used identically on every redesigned screen. */
export function statusBadgeProps(status: TeamMember["status"]): {
  tone: "success" | "warning" | "error";
  label: string;
} {
  if (status === "active") return { tone: "success", label: "Active" };
  if (status === "invited") return { tone: "warning", label: "Pending" };
  return { tone: "error", label: "Disabled" };
}

/** Company membership: an empty grant set fail-opens to ALL companies
 *  (companyContext semantics), so it counts as "in every company". */
export function inCompany(u: TeamMember, companyId: number): boolean {
  return !u.company_ids || u.company_ids.length === 0 || u.company_ids.includes(companyId);
}

/** Mirror of the backend's resolveDefaultRoleId (routes/users.ts) — the
 *  invite endpoint requires a role_id but the redesigned flow has no Role
 *  picker (position drives access; owner: "删了role"). */
export function defaultRoleId(
  roles: Array<{ id: number; name: string; is_system: boolean; permissions: string[] }>,
): number | null {
  if (roles.length === 0) return null;
  const sorted = [...roles].sort((a, b) => a.id - b.id);
  const preview = sorted.find(
    (r) => r.name.trim().toLowerCase() === "position preview",
  );
  const zeroPerm = sorted.find((r) => !r.is_system && r.permissions.length === 0);
  const nonSystem = sorted.find((r) => !r.is_system);
  return (preview ?? zeroPerm ?? nonSystem ?? sorted[0]).id;
}

/** Form-row chrome for SearchableSelect (it styles its own input from
 *  className) — matches the plain <input> fields beside it. */
export const FIELD_SELECT_CLS =
  "h-[38px] w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary";

// ──────────────────────────────────────────────────────────
// Segmented tab switcher — the design's inset pill strip
// (bg-surface-2 track, active segment lifts on bg-surface).
// Used for the Profile sub-tabs and the Mailboxes view tabs.
// ──────────────────────────────────────────────────────────

export type SegmentOption<V extends string> = {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
};

export function SegmentedTabs<V extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: V;
  onChange: (next: V) => void;
  options: SegmentOption<V>[];
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "flex w-max items-center gap-1 rounded-md bg-surface-2 p-1",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => !o.disabled && onChange(o.value)}
            className={cn(
              "rounded px-3 py-1 text-[12px] transition-colors duration-fast",
              active
                ? "bg-surface font-semibold text-ink shadow-stone"
                : o.disabled
                  ? "cursor-not-allowed text-ink-muted"
                  : "text-ink-secondary hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Mono uppercase eyebrow label — the design's section/eyebrow treatment. */
export function Eyebrow({
  children,
  tone = "muted",
  className,
}: {
  children: ReactNode;
  tone?: "muted" | "accent";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "font-mono text-[10px] uppercase tracking-wider",
        tone === "accent" ? "text-accent" : "text-ink-muted",
        className,
      )}
    >
      {children}
    </div>
  );
}
