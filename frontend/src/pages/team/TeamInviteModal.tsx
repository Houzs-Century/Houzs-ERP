import { useEffect, useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { cn } from "../../lib/utils";
import { Panel } from "../../components/Panel";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { SearchableSelect } from "../../vendor/scm/components/SearchableSelect";
import { PhoneInput } from "../../vendor/scm/components/PhoneInput";
import type { TeamMember, Department, Position, Role } from "../../types";
import { defaultRoleId, deriveDeptLead, divisionOf, Eyebrow, FIELD_SELECT_CLS } from "./teamShared";

/* Invite Member — design handoff screen 03. One centered modal: person &
 * email, an assignment summary prefilled from the Directory's current
 * department (editable in place via "Change"), and a position chip picker.
 * Assignment and position are set BEFORE sending, not patched afterward.
 *
 * The design's "Bulk paste" and "Import from AutoCount" input modes have no
 * backend today (invites are one POST each) — the tabs render disabled as
 * placeholders for that follow-up. The role concept stays hidden: a baseline
 * role is auto-assigned (mirror of the backend's resolveDefaultRoleId);
 * access follows the chosen position. */

type CompanyOpt = { id: number; code: string; name: string };

type SendResult = {
  email: string;
  invite_url?: string;
  email_sent?: boolean;
  activated: boolean;
};

const inputCls =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary disabled:bg-surface-2 disabled:text-ink-muted";

export function TeamInviteModal({
  open,
  onClose,
  departments,
  positions,
  roles,
  members,
  companies,
  salesDirScoped = false,
  presetDeptId,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  departments: Department[];
  positions: Position[];
  roles: Role[];
  members: TeamMember[];
  companies: CompanyOpt[];
  salesDirScoped?: boolean;
  /** Department the Directory is currently scoped to — prefills Assignment. */
  presetDeptId: number | null;
  onInvited: () => void;
}) {
  const toast = useToast();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [deptId, setDeptId] = useState<number | null>(presetDeptId);
  const [division, setDivision] = useState("");
  const [managerId, setManagerId] = useState<number | null>(null);
  const [positionId, setPositionId] = useState<number | null>(null);
  const [companyIds, setCompanyIds] = useState<number[]>([]);
  const [editingAssignment, setEditingAssignment] = useState(false);
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SendResult | null>(null);

  const multiCompany = companies.length > 1;

  // Re-seed from the Directory context each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setName("");
    setEmail("");
    setPhone("");
    setDeptId(presetDeptId);
    setDivision("");
    setPositionId(null);
    setCompanyIds(companies.length ? [companies[0].id] : []);
    setWithPassword(false);
    setPassword("");
    setSent(null);
    setEditingAssignment(false);
    const dept = presetDeptId != null ? presetDeptId : null;
    const deptMembers = members.filter((m) => m.department_id === dept);
    setManagerId(dept != null ? deriveDeptLead(deptMembers, members)?.id ?? null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dept = departments.find((d) => d.id === deptId) ?? null;
  const manager = members.find((m) => m.id === managerId) ?? null;
  const deptPositions = useMemo(
    () =>
      positions.filter(
        (p) => p.active && (p.department_id == null || p.department_id === deptId),
      ),
    [positions, deptId],
  );
  const position = positions.find((p) => p.id === positionId) ?? null;
  const divisionSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const m of members) {
      if (m.department_id !== deptId) continue;
      const d = divisionOf(m);
      if (d) set.add(d);
    }
    return [...set].sort();
  }, [members, deptId]);

  const canSend = email.trim().includes("@") && !sending;

  async function send() {
    if (!canSend) return;
    const roleId = defaultRoleId(roles);
    if (roleId == null && !salesDirScoped) {
      toast.error("No role available to assign — create a baseline role first.");
      return;
    }
    setSending(true);
    try {
      const res = await api.post<{
        invite_url?: string;
        email_sent?: boolean;
      }>("/api/users/invite", {
        email: email.trim(),
        name: name.trim() || undefined,
        phone: phone.trim() || undefined,
        department_id: deptId,
        position_id: positionId,
        manager_id: managerId,
        ...(roleId != null ? { role_id: roleId } : {}),
        ...(multiCompany && companyIds.length ? { company_ids: companyIds } : {}),
        ...(withPassword && password ? { password } : {}),
      });
      // Division isn't part of the invite payload — set it on the placeholder
      // user row the invite just created, so the member lands in their team.
      if (division.trim()) {
        try {
          const fresh = await api.get<{ users: TeamMember[] }>("/api/users");
          const created = fresh.users.find(
            (u) => u.email.toLowerCase() === email.trim().toLowerCase(),
          );
          if (created) await api.patch(`/api/users/${created.id}`, { division: division.trim() });
        } catch {
          toast.error(
            `Invite sent, but the team "${division.trim()}" wasn't saved — set it on the member's profile.`,
          );
        }
      }
      setSent({
        email: email.trim(),
        invite_url: res.invite_url,
        email_sent: res.email_sent,
        activated: withPassword && !!password,
      });
      onInvited();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the invite");
    } finally {
      setSending(false);
    }
  }

  /* Company is a first-class choice on every invite (owner 2026-08-21:
     "需要加上houzs century或者 2990 或者both") — the chips toggle, both on =
     member acts in both companies. Always visible, not tucked behind Change. */
  const companyChips =
    multiCompany && !salesDirScoped ? (
      companies.map((c) => {
        const on = companyIds.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            className={cn(
              "rounded-md border px-2.5 py-1 text-[12.5px] transition-colors",
              on
                ? "border-primary bg-primary-soft font-medium text-primary-ink"
                : "border-border bg-surface text-ink-secondary hover:border-border-strong",
            )}
            onClick={() =>
              setCompanyIds((ids) =>
                on ? ids.filter((id) => id !== c.id) : [...ids, c.id],
              )
            }
            title={on ? "Member acts in this company — click to remove" : "Click to add this company"}
          >
            {c.name}
          </button>
        );
      })
    ) : (
      <span className="rounded-md border border-border bg-surface px-2.5 py-1">
        {companies[0]?.name ?? "Houzs Century"}
      </span>
    );

  const assignmentChips = (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink">
      {companyChips}
      <span className="text-ink-muted">›</span>
      <span className="rounded-md border border-border bg-surface px-2.5 py-1">
        {dept?.name ?? "No department"}
      </span>
      {division.trim() && (
        <>
          <span className="text-ink-muted">›</span>
          <span className="rounded-md border border-border bg-surface px-2.5 py-1">
            {division.trim()}
          </span>
        </>
      )}
      <span className="ml-2 text-ink-muted">Reports to</span>
      <span className="rounded-md border border-border bg-surface px-2.5 py-1">
        {manager ? manager.name || manager.email : "—"}
      </span>
    </div>
  );

  return (
    <Panel
      open={open}
      onClose={onClose}
      centered
      width={720}
      title={
        <span className="font-serif text-[20px] font-semibold text-ink">Invite Member</span>
      }
      subtitle="Assignment and position are set before the invite goes out"
      footer={
        sent ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSent(null)}>
              Invite another
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!canSend} onClick={send}>
              {sending ? "Sending…" : withPassword && password ? "Create member" : "Send invite"}
            </Button>
          </div>
        )
      }
    >
      {sent ? (
        <div className="flex flex-col gap-4 p-1">
          <div className="rounded-lg border border-primary bg-primary-soft p-4">
            <div className="text-[13px] font-semibold text-primary-ink">
              {sent.activated
                ? `Account created for ${sent.email}`
                : `Invitation ${sent.email_sent ? "emailed" : "created"} for ${sent.email}`}
            </div>
            <p className="mb-0 mt-1 text-[12px] leading-relaxed text-primary-ink">
              {sent.activated
                ? "The member can sign in right away with the password you set."
                : sent.email_sent
                  ? "They'll receive a link to set their password. You can also share the link directly."
                  : "Email didn't go out automatically — share the invite link below directly."}
            </p>
          </div>
          {sent.invite_url && (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={sent.invite_url}
                className={cn(inputCls, "flex-1 bg-surface-2 font-mono text-[11.5px]")}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="secondary"
                icon={<Copy size={14} />}
                onClick={() => {
                  void navigator.clipboard.writeText(sent.invite_url!);
                  toast.success("Invite link copied");
                }}
              >
                Copy
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-1">
          {/* Input modes — Single works today; the other two await backend. */}
          <div className="flex w-max items-center gap-1 rounded-md bg-surface-2 p-1">
            <span className="rounded bg-surface px-3 py-1 text-[12px] font-semibold text-ink shadow-stone">
              Single
            </span>
            <span
              className="cursor-not-allowed px-3 py-1 text-[12px] text-ink-muted"
              title="Bulk invites aren't wired up yet"
            >
              Bulk paste
            </span>
            <span
              className="cursor-not-allowed px-3 py-1 text-[12px] text-ink-muted"
              title="AutoCount staff import isn't wired up yet"
            >
              Import from AutoCount
            </span>
          </div>

          <div className="grid gap-x-5 gap-y-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div>
              <div className="text-[11.5px] text-ink-muted">Name</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                className={cn(inputCls, "mt-1")}
              />
            </div>
            <div>
              <div className="text-[11.5px] text-ink-muted">Employee ID</div>
              <div className="mt-1 rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[12.5px] text-ink-muted">
                Assigned automatically (EMP-…)
              </div>
            </div>
            <div>
              <div className="text-[11.5px] text-ink-muted">Login email</div>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@houzscentury.com"
                type="email"
                className={cn(inputCls, "mt-1 font-mono text-[12.5px]")}
              />
            </div>
            <div>
              <div className="text-[11.5px] text-ink-muted">Phone</div>
              <PhoneInput
                value={phone}
                onChange={setPhone}
                placeholder="12-345 6789 (optional)"
                className={cn(inputCls, "mt-1")}
              />
            </div>
          </div>

          {/* Assignment — prefilled from the Directory's selected department. */}
          <div className="rounded-md border border-border-subtle bg-surface-2 p-4">
            <div className="flex items-center justify-between">
              <Eyebrow>Assignment{presetDeptId != null ? " (prefilled from Directory)" : ""}</Eyebrow>
              <button
                className="text-[12px] text-primary hover:underline"
                onClick={() => setEditingAssignment((v) => !v)}
              >
                {editingAssignment ? "Done" : "Change"}
              </button>
            </div>
            {assignmentChips}
            {editingAssignment && (
              <div className="mt-3 grid gap-x-5 gap-y-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
                {/* Company chips live in the summary row above (always visible)
                    — the edit area only carries the fields that need pickers. */}
                <div>
                  <div className="text-[11.5px] text-ink-muted">Department</div>
                  <div className="mt-1">
                    <SearchableSelect
                      className={FIELD_SELECT_CLS}
                      value={deptId == null ? "none" : String(deptId)}
                      onChange={(v) => {
                        const next = v === "none" ? null : Number(v);
                        setDeptId(next);
                        setPositionId(null);
                        const deptMembers = members.filter((m) => m.department_id === next);
                        setManagerId(
                          next != null ? deriveDeptLead(deptMembers, members)?.id ?? null : null,
                        );
                      }}
                      options={[
                        { value: "none", label: "No department" },
                        ...departments.map((d) => ({ value: String(d.id), label: d.name })),
                      ]}
                      disabled={salesDirScoped}
                    />
                  </div>
                </div>
                <div>
                  <div className="text-[11.5px] text-ink-muted">Team</div>
                  <input
                    list="invite-divisions"
                    value={division}
                    onChange={(e) => setDivision(e.target.value)}
                    placeholder="e.g. Driver Fleet (optional)"
                    className={cn(inputCls, "mt-1")}
                  />
                  <datalist id="invite-divisions">
                    {divisionSuggestions.map((d) => (
                      <option key={d} value={d} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <div className="text-[11.5px] text-ink-muted">Reports to</div>
                  <div className="mt-1">
                    <SearchableSelect
                      className={FIELD_SELECT_CLS}
                      value={managerId == null ? "none" : String(managerId)}
                      onChange={(v) => setManagerId(v === "none" ? null : Number(v))}
                      options={[
                        { value: "none", label: "No manager (top level)" },
                        ...members
                          .filter((m) => m.status === "active")
                          .map((m) => ({
                            value: String(m.id),
                            label: m.department_name
                              ? `${m.name || m.email} · ${m.department_name}`
                              : m.name || m.email,
                          }))
                          .sort((a, b) => a.label.localeCompare(b.label)),
                      ]}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Position — drives page access; role stays a hidden baseline. */}
          <div className="rounded-md border border-border-subtle bg-surface-2 p-4">
            <Eyebrow>Position</Eyebrow>
            {deptPositions.length === 0 ? (
              <p className="mb-0 mt-2 text-[12px] text-ink-muted">
                {deptId == null
                  ? "Pick a department first — positions are department-scoped."
                  : "This department has no positions yet."}
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {deptPositions.map((p) => {
                  const on = positionId === p.id;
                  return (
                    <button
                      key={p.id}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-[12.5px] transition-colors",
                        on
                          ? "border-primary bg-primary-soft font-medium text-primary-ink"
                          : "border-border bg-surface text-ink-secondary hover:border-border-strong",
                      )}
                      onClick={() => setPositionId(on ? null : p.id)}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="mb-0 mt-2.5 text-[11.5px] text-ink-secondary">
              {position
                ? `${position.name}: menu and page access follow this position's policy.`
                : "No position — the member starts with baseline access only."}
              {positionId == null && deptPositions.length > 0 && (
                <Badge tone="warning" className="ml-2">
                  No pages
                </Badge>
              )}
            </p>
          </div>

          {/* Optional direct-create: set a password now → active account. */}
          <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-secondary">
              <input
                type="checkbox"
                checked={withPassword}
                onChange={(e) => setWithPassword(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              Set a password now — creates the account active, no invite email
            </label>
            {withPassword && (
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Initial password (member can change it later)"
                className={cn(inputCls, "max-w-[340px] font-mono text-[12.5px]")}
              />
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
