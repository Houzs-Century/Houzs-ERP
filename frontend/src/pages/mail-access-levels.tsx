// Team > Mail Center > Access (owner 2026-11-21): two layers per person.
//   1. the level: L1 Personal, L2 Department, L3 Company;
//   2. what the level lets an admin tick: L1 = colleagues in the same department,
//      L2 = other departments, L3 = nothing (the whole company).
// The person's departments always come from the Org Chart.
import { useMemo, useState } from "react";
import { Building2, Check, Loader2, Pencil, ShieldCheck } from "lucide-react";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Panel, PanelSection } from "../components/Panel";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { cn } from "../lib/utils";
import type { Department, TeamMember } from "../types";
import {
  DEFAULT_MAIL_SCOPE_LEVEL,
  fetchAccess,
  fetchScopeDepartments,
  fetchScopeLevels,
  grantAccess,
  revokeAccess,
  setScopeDepartments,
  setScopeLevel,
  type MailAddress,
  type MailScopeLevel,
} from "./MailCenter/mail-actions";
import { departmentIdsOf, isManagement, OrgChartCell } from "./mail-access-parts";

export type LevelGroup = "department" | "department_all" | "company";

export const LEVELS: { value: LevelGroup; short: string; name: string; help: string }[] = [
  {
    value: "department",
    short: "L1",
    name: "Personal",
    help: "Their own mailbox and their department's shared mailbox. You can tick colleagues in the same department.",
  },
  {
    value: "department_all",
    short: "L2",
    name: "Department",
    help: "Every mailbox in their department, colleagues included. You can tick other departments to open them the same way.",
  },
  { value: "company", short: "L3", name: "Company", help: "Every mailbox in the company. Nothing to tick." },
];

/** 'personal' is the older own-only setting; it shows as L1. */
export function levelGroup(level: MailScopeLevel): LevelGroup {
  return level === "personal" ? "department" : level;
}

export function levelLabel(level: MailScopeLevel): string {
  const l = LEVELS.find((x) => x.value === levelGroup(level))!;
  return `${l.short} · ${l.name}${level === "personal" ? " (no department mailbox)" : ""}`;
}

/** L1 choices: own mailboxes of colleagues who share a department with `u`. */
export function colleagueMailboxes(u: TeamMember, users: TeamMember[], addresses: MailAddress[]): MailAddress[] {
  const mine = new Set(departmentIdsOf(u));
  const mates = new Set(
    users.filter((o) => o.id !== u.id && departmentIdsOf(o).some((d) => mine.has(d))).map((o) => o.id),
  );
  return addresses.filter((a) => a.active && a.assignedUserId != null && mates.has(a.assignedUserId));
}

/** Department mailboxes that reach `u` through their own departments (no tick). */
export function ownDepartmentMailboxes(u: TeamMember, addresses: MailAddress[]): MailAddress[] {
  const mine = new Set(departmentIdsOf(u));
  return addresses.filter((a) => a.active && a.assignedUserId == null && a.departmentId != null && mine.has(a.departmentId));
}

/** A grant the person already has without it (their own mailbox, or a department
 *  mailbox of their own departments). Older data carries many; they are not shown. */
export function isRedundantGrant(a: MailAddress, u: TeamMember): boolean {
  if (a.assignedUserId === u.id) return true;
  return a.assignedUserId == null && a.departmentId != null && departmentIdsOf(u).includes(a.departmentId);
}

export type AccessDraft = { level: MailScopeLevel; grants: Set<string>; departments: Set<number> };

export type AccessPlan = {
  level: MailScopeLevel | null;
  grant: string[];
  revoke: string[];
  departments: number[] | null;
};

/** What Save must send: only the differences, and an L2 tick list cleared when leaving L2. */
export function planAccessSave(before: AccessDraft, after: AccessDraft): AccessPlan {
  const sameGroup = levelGroup(before.level) === levelGroup(after.level);
  const level = sameGroup ? null : after.level;
  const grant = [...after.grants].filter((g) => !before.grants.has(g));
  const revoke = [...before.grants].filter((g) => !after.grants.has(g));
  const wantDepts = levelGroup(after.level) === "department_all" ? after.departments : new Set<number>();
  const deptsChanged =
    wantDepts.size !== before.departments.size || [...wantDepts].some((d) => !before.departments.has(d));
  return { level, grant, revoke, departments: deptsChanged ? [...wantDepts].sort((a, b) => a - b) : null };
}

function name(a: MailAddress): string {
  return a.assignedUserName || a.label || a.address.split("@")[0];
}

function Chip({ auto, children, title }: { auto?: boolean; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
        auto ? "bg-primary/10 text-primary" : "bg-warning-bg text-warning-text",
      )}
    >
      {auto && <ShieldCheck size={10} />}
      {children}
    </span>
  );
}

export function AccessLevels({
  addresses,
  users,
  departments,
  loading,
}: {
  addresses: MailAddress[];
  users: TeamMember[];
  departments: Department[];
  loading: boolean;
}) {
  const accessQ = useQuery("mailboxes-access", () => fetchAccess());
  const levelsQ = useQuery("mailboxes-scope-levels", () => fetchScopeLevels());
  const deptQ = useQuery("mailboxes-scope-departments", () => fetchScopeDepartments());
  const [editing, setEditing] = useState<TeamMember | null>(null);

  const levelOf = (userId: number): MailScopeLevel =>
    levelsQ.data?.find((l) => l.userId === userId)?.level ?? DEFAULT_MAIL_SCOPE_LEVEL;
  const grantsOf = (userId: number) =>
    new Set((accessQ.data ?? []).filter((g) => g.userId === userId).map((g) => g.addressId));
  const deptsOf = (userId: number) =>
    new Set((deptQ.data ?? []).filter((d) => d.userId === userId).map((d) => d.departmentId));
  const deptName = (id: number) => departments.find((d) => d.id === id)?.name ?? `#${id}`;
  const byId = useMemo(() => new Map(addresses.map((a) => [a.id, a])), [addresses]);

  if (loading || accessQ.loading || levelsQ.loading || deptQ.loading) return <ListSkeleton rows={5} />;
  if (users.length === 0) return <EmptyState compact message="No active members." />;

  return (
    <section>
      <p className="mb-3 max-w-[80ch] text-[12px] text-ink-muted">
        Set each person's level first, then tick what that level allows. Departments come from the Org Chart - change
        them there. Management reads the whole company.
      </p>
      <div className="overflow-x-auto rounded-md border border-border bg-surface shadow-stone">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink">
              <th className="px-4 py-2.5">Member</th>
              <th className="px-4 py-2.5">Org Chart</th>
              <th className="px-4 py-2.5">Level</th>
              <th className="px-4 py-2.5">Can also read</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const mgmt = isManagement(u, departments);
              const level = levelOf(u.id);
              const group = mgmt ? "company" : levelGroup(level);
              const grants = [...grantsOf(u.id)]
                .map((id) => byId.get(id))
                .filter((a): a is MailAddress => !!a && !isRedundantGrant(a, u));
              return (
                <tr key={u.id} className="border-b border-border-subtle last:border-b-0">
                  <td className="px-4 py-2.5 text-[12.5px] font-semibold text-ink">{u.name || u.email}</td>
                  <td className="px-4 py-2.5"><OrgChartCell u={u} departments={departments} /></td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    <Badge tone={group === "company" ? "accent" : "neutral"} size="xs">
                      {mgmt ? "L3 · Company (Management)" : levelLabel(level)}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {group === "company" ? (
                        <span className="text-[11.5px] text-ink-secondary">Every mailbox</span>
                      ) : (
                        <>
                          {group === "department_all" &&
                            [...deptsOf(u.id)].map((d) => <Chip key={d}>{deptName(d)} (whole)</Chip>)}
                          {grants.map((a) => <Chip key={a.id} title={a.address}>{name(a)}</Chip>)}
                          {group === "department" && grants.length === 0 && (
                            <span className="text-[11px] text-ink-muted">-</span>
                          )}
                          {group === "department_all" && deptsOf(u.id).size === 0 && grants.length === 0 && (
                            <span className="text-[11px] text-ink-muted">Own department only</span>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(u)}
                      disabled={mgmt}
                      title={mgmt ? "Management reads the whole company - change it in the Org Chart" : "Edit access"}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Pencil size={12} /> Edit
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5 text-[11px] text-ink-muted">
          <span className="inline-flex items-center gap-1.5"><Chip>Name</Chip> ticked by an admin - a colleague is told when their mailbox is opened</span>
        </div>
      </div>
      {editing && (
        <AccessEditPanel
          u={editing}
          users={users}
          addresses={addresses}
          departments={departments}
          before={{ level: levelOf(editing.id), grants: grantsOf(editing.id), departments: deptsOf(editing.id) }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            accessQ.reload();
            levelsQ.reload();
            deptQ.reload();
          }}
        />
      )}
    </section>
  );
}

function Tick({
  checked,
  onChange,
  disabled,
  label,
  sub,
}: {
  checked: boolean;
  onChange: () => void;
  disabled: boolean;
  label: string;
  sub?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-dim">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} className="h-4 w-4 accent-[#a16a2e]" />
      <span className="min-w-0">
        <span className="block text-[12.5px] text-ink">{label}</span>
        {sub && <span className="block truncate text-[10.5px] text-ink-muted">{sub}</span>}
      </span>
    </label>
  );
}

function Included({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-[4px] bg-primary/15 text-primary"><ShieldCheck size={11} /></span>
      <span className="min-w-0">
        <span className="block text-[12.5px] text-ink">{label}</span>
        <span className="block text-[10.5px] text-ink-muted">{sub}</span>
      </span>
    </div>
  );
}

export function AccessEditPanel({
  u,
  users,
  addresses,
  departments,
  before,
  onClose,
  onSaved,
}: {
  u: TeamMember;
  users: TeamMember[];
  addresses: MailAddress[];
  departments: Department[];
  before: AccessDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [level, setLevel] = useState<MailScopeLevel>(before.level);
  const [grants, setGrants] = useState<Set<string>>(new Set(before.grants));
  const [depts, setDepts] = useState<Set<number>>(new Set(before.departments));
  const [busy, setBusy] = useState(false);
  const group = levelGroup(level);
  const mine = departmentIdsOf(u);
  const colleagues = colleagueMailboxes(u, users, addresses);
  const ownShared = ownDepartmentMailboxes(u, addresses);
  const earlier = [...grants, ...before.grants]
    .filter((id, i, all) => all.indexOf(id) === i && !colleagues.some((c) => c.id === id))
    .map((id) => addresses.find((a) => a.id === id))
    .filter((a): a is MailAddress => !!a && !isRedundantGrant(a, u));
  const plan = planAccessSave(before, { level, grants, departments: depts });
  const dirty = plan.level != null || plan.grant.length + plan.revoke.length > 0 || plan.departments != null;

  const flip = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    return next;
  };

  async function save() {
    setBusy(true);
    const ops: Promise<unknown>[] = [
      ...(plan.level ? [setScopeLevel(u.id, plan.level)] : []),
      ...(plan.departments ? [setScopeDepartments(u.id, plan.departments)] : []),
      ...plan.grant.map((id) => grantAccess(id, u.id)),
      ...plan.revoke.map((id) => revokeAccess(id, u.id)),
    ];
    const failed = (await Promise.allSettled(ops)).filter((r) => r.status === "rejected").length;
    setBusy(false);
    if (failed > 0) {
      toast.error(`${failed} of ${ops.length} changes failed - open it again to check`);
      return;
    }
    toast.success("Access saved");
    onSaved();
  }

  return (
    <Panel
      open
      onClose={onClose}
      dirty={dirty}
      onAttemptClose={onClose}
      title={u.name || u.email}
      subtitle="Mail access"
      width={460}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-1.5 text-[12px] font-bold text-white hover:bg-primary-ink disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save
          </button>
        </div>
      }
    >
      <PanelSection title="Org Chart">
        <OrgChartCell u={u} departments={departments} />
        {mine.length === 0 && (
          <p className="text-[11px] text-warning-text">No department yet: put them in one in the Org Chart first.</p>
        )}
      </PanelSection>

      <PanelSection title="1. Level">
        <div role="radiogroup" aria-label="Level" className="space-y-2">
          {LEVELS.map((l) => (
            <label
              key={l.value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-md border px-3 py-2.5",
                group === l.value ? "border-primary bg-primary/5" : "border-border hover:border-accent/40",
              )}
            >
              <input
                type="radio"
                name="mail-level"
                checked={group === l.value}
                disabled={busy}
                onChange={() => setLevel(l.value)}
                className="mt-0.5 accent-[#1d5c52]"
              />
              <span>
                <span className="block text-[12.5px] font-bold text-ink">{l.short} · {l.name}</span>
                <span className="block text-[11px] text-ink-muted">{l.help}</span>
              </span>
            </label>
          ))}
        </div>
      </PanelSection>

      {group === "department" && (
        <PanelSection title="2. Colleagues they can read">
          {ownShared.map((a) => <Included key={a.id} label={a.address} sub="Department mailbox - included" />)}
          {colleagues.length === 0 ? (
            <p className="px-2 text-[11.5px] text-ink-muted">No colleague in the same department has a mailbox.</p>
          ) : (
            colleagues.map((a) => (
              <Tick key={a.id} checked={grants.has(a.id)} disabled={busy} onChange={() => setGrants(flip(grants, a.id))} label={name(a)} sub={a.address} />
            ))
          )}
        </PanelSection>
      )}

      {group === "department_all" && (
        <PanelSection title="2. Departments they can read">
          {departments
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((d) =>
              mine.includes(d.id) ? (
                <Included key={d.id} label={d.name} sub="Their own department - included" />
              ) : (
                <Tick key={d.id} checked={depts.has(d.id)} disabled={busy} onChange={() => setDepts(flip(depts, d.id))} label={d.name} sub="Department mailbox and every member's mailbox" />
              ),
            )}
        </PanelSection>
      )}

      {group === "company" && (
        <PanelSection title="2. Nothing to tick">
          <p className="inline-flex items-center gap-1.5 text-[12px] text-ink-secondary">
            <Building2 size={13} /> Reads every mailbox in the company.
          </p>
        </PanelSection>
      )}

      {group !== "company" && earlier.length > 0 && (
        <PanelSection title="Shared with them earlier">
          {earlier.map((a) => (
            <Tick key={a.id} checked={grants.has(a.id)} disabled={busy} onChange={() => setGrants(flip(grants, a.id))} label={name(a)} sub={`${a.address} - untick to stop sharing`} />
          ))}
        </PanelSection>
      )}
    </Panel>
  );
}
