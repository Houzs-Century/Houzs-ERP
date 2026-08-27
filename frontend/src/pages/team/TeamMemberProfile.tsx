import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LogIn } from "lucide-react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { relativeTime, cn } from "../../lib/utils";
import { fmtDate } from "../../vendor/shared/format";
import { formatPhone } from "../../vendor/shared/phone";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { Badge } from "../../components/Badge";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { SearchableSelect } from "../../vendor/scm/components/SearchableSelect";
import { managerOptions } from "./orgChartPickers";
import { PosPinCard } from "./PosPinCard";
import { showsPosPinCard } from "./posPinEligibility";
import type { TeamMember, Department, Position, Role } from "../../types";
import { empCode, statusBadgeProps, divisionOf, Eyebrow, SegmentedTabs, FIELD_SELECT_CLS } from "./teamShared";

/* Member Profile — design handoff screen 02. Right-side drawer opened from a
 * Directory row: identity card fixed left, editable Assignment + read-only
 * Permissions + Activity Log right. Assignment edits are inline (selects),
 * saved in one PATCH. */

type ProfileTab = "details" | "permissions" | "activity";

type CompanyOpt = { id: number; code: string; name: string };

type ActivityRow = {
  id: number;
  created_at: string;
  actor_email: string | null;
  action: string;
  summary: string | null;
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11.5px] text-ink-muted">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export function TeamMemberProfile({
  member,
  members,
  departments,
  positions,
  roles,
  companies,
  canManage,
  canImpersonate,
  onLoginAs,
  onClose,
  onChanged,
}: {
  member: TeamMember;
  members: TeamMember[];
  departments: Department[];
  positions: Position[];
  roles: Role[];
  companies: CompanyOpt[];
  canManage: boolean;
  canImpersonate: boolean;
  onLoginAs: (u: TeamMember) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [tab, setTab] = useState<ProfileTab>("details");
  const [saving, setSaving] = useState(false);

  // Assignment draft — starts from the live row, saved as one PATCH diff.
  const [draft, setDraft] = useState(() => ({
    department_id: member.department_id,
    division: divisionOf(member) ?? "",
    position_id: member.position_id,
    manager_id: member.manager_id,
    company_ids: member.company_ids ?? [],
  }));

  const dirty =
    draft.department_id !== member.department_id ||
    (draft.division.trim() || null) !== divisionOf(member) ||
    draft.position_id !== member.position_id ||
    draft.manager_id !== member.manager_id ||
    JSON.stringify([...draft.company_ids].sort()) !==
      JSON.stringify([...(member.company_ids ?? [])].sort());

  const multiCompany = companies.length > 1;
  const role = roles.find((r) => r.id === member.role_id) ?? null;
  const status = statusBadgeProps(member.status);

  /* POS Access. The 2990 tablet needs a 6-digit PIN, and the combination that
     calls for one — 2990's Home + a Sales title — is decided by the two fields
     directly above this card, so the DRAFT drives whether it shows and the
     SAVED row drives whether the PIN endpoints will accept a write. */
  const draftPositionSlug =
    positions.find((p) => p.id === draft.position_id)?.slug ?? null;
  const savedPositionSlug =
    positions.find((p) => p.id === member.position_id)?.slug ?? null;
  const showPosPin = showsPosPinCard({
    companyIds: draft.company_ids,
    companies,
    positionSlug: draftPositionSlug,
  });
  const posPinSaved = showsPosPinCard({
    companyIds: member.company_ids ?? [],
    companies,
    positionSlug: savedPositionSlug,
  });
  /* Set by a save that turned POS eligibility ON — the card then opens its own
     entry box, which is what makes the PIN impossible to miss the first time a
     salesperson is given 2990 access. */
  const [pinPrompt, setPinPrompt] = useState(false);

  const deptPositions = useMemo(
    () =>
      positions.filter(
        (p) =>
          p.active &&
          (p.department_id == null || p.department_id === draft.department_id),
      ),
    [positions, draft.department_id],
  );

  const divisionSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const m of members) {
      if (m.department_id !== draft.department_id) continue;
      const d = divisionOf(m);
      if (d) set.add(d);
    }
    return [...set].sort();
  }, [members, draft.department_id]);

  const activity = useQuery<{ activity: ActivityRow[] }>(
    `/api/users/${member.id}/activity`,
    () => api.get(`/api/users/${member.id}/activity`),
    [member.id],
    { enabled: tab === "activity" },
  );

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      if (draft.department_id !== member.department_id)
        patch.department_id = draft.department_id;
      if ((draft.division.trim() || null) !== divisionOf(member))
        patch.division = draft.division.trim() || null;
      if (draft.position_id !== member.position_id) patch.position_id = draft.position_id;
      if (draft.manager_id !== member.manager_id) patch.manager_id = draft.manager_id;
      if (
        JSON.stringify([...draft.company_ids].sort()) !==
        JSON.stringify([...(member.company_ids ?? [])].sort())
      )
        patch.company_ids = draft.company_ids;
      await api.patch(`/api/users/${member.id}`, patch);
      toast.success("Assignment saved");
      // Eligibility that was NOT there before this save is the moment an admin
      // needs the PIN box — anything else would leave it to them to remember.
      if (showPosPin && !posPinSaved) setPinPrompt(true);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save changes");
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus() {
    if (member.status === "disabled") {
      if (!(await dialog.confirm(`Re-enable ${member.name || member.email}?`))) return;
      try {
        await api.patch(`/api/users/${member.id}`, { status: "active" });
        toast.success("Account re-enabled");
        onChanged();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not enable the account");
      }
      return;
    }
    const reason = await dialog.prompt({
      title: "Disable account",
      message: `Disable ${member.name || member.email}? They lose access immediately; the account can be re-enabled later.`,
      confirmLabel: "Disable",
      tone: "danger",
    });
    if (reason === null) return;
    try {
      await api.patch(`/api/users/${member.id}`, {
        status: "disabled",
        status_reason: reason.trim() || null,
      });
      toast.success("Account disabled");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not disable the account");
    }
  }

  async function attemptClose() {
    if (dirty && !(await dialog.confirm("Discard unsaved assignment changes?"))) return;
    onClose();
  }

  return (
    <ResizableDrawer
      onClose={attemptClose}
      storageKey="team:profile-drawer"
      defaultWidth={920}
      minWidth={560}
      maxWidth={1100}
      ariaLabel={`Member profile — ${member.name || member.email}`}
      title={
        <span className="flex items-center gap-2 text-[13px]">
          <span className="text-ink-secondary">Team</span>
          <span className="text-ink-muted">/</span>
          <span className="text-ink-secondary">{member.department_name ?? "No department"}</span>
          <span className="text-ink-muted">/</span>
          <span className="font-semibold text-ink">{member.name || member.email}</span>
        </span>
      }
      headerActions={
        <div className="flex items-center gap-2">
          {canImpersonate && canManage && member.status === "active" && (
            <Button variant="ghost" icon={<LogIn size={14} />} onClick={() => onLoginAs(member)}>
              Log in as
            </Button>
          )}
          {canManage && (
            <Button variant="secondary" onClick={toggleStatus}>
              {member.status === "disabled" ? "Enable account" : "Disable account"}
            </Button>
          )}
          {canManage && (
            <Button variant="primary" disabled={!dirty || saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      }
    >
      <div className="grid gap-5 p-5" style={{ gridTemplateColumns: "272px 1fr" }}>
        {/* ── Identity card ── */}
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-surface p-5 shadow-stone">
            <div className="flex items-center gap-3">
              <Avatar
                userId={member.id}
                hasImage={member.profile_pic_r2_key}
                name={member.name ?? member.email}
                size={56}
              />
              <div className="min-w-0">
                <div className="truncate font-serif text-[20px] font-semibold text-ink">
                  {member.name || member.email}
                </div>
                <div className="font-mono text-[11px] text-ink-muted">{empCode(member.id)}</div>
                <div className="mt-1.5">
                  <Badge tone={status.tone}>{status.label}</Badge>
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2 border-t border-border-subtle pt-4 text-[12.5px]">
              <div className="flex justify-between gap-3">
                <span className="text-ink-muted">Email</span>
                <span className="truncate font-mono text-[11.5px] text-ink">{member.email}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-ink-muted">Phone</span>
                <span className="font-mono text-[11.5px] text-ink">
                  {member.phone ? formatPhone(member.phone) : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-ink-muted">Joined</span>
                <span className="font-money text-[11.5px] text-ink">
                  {member.joined_at ? fmtDate(member.joined_at) : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-ink-muted">Last login</span>
                <span
                  className={cn(
                    "font-mono text-[11.5px]",
                    member.last_login_at ? "text-ink" : "text-err",
                  )}
                >
                  {member.last_login_at ? relativeTime(member.last_login_at) : "never"}
                </span>
              </div>
            </div>
          </div>

          {member.status === "active" && !member.last_login_at && (
            <div className="rounded-lg border border-accent bg-warning-bg p-4">
              <Eyebrow className="text-warning-text">Reminder</Eyebrow>
              <p className="mb-0 mt-1 text-[12px] leading-relaxed text-warning-text">
                This account has never been signed in. Confirm whether this member needs
                access — otherwise disable it to free the seat.
              </p>
            </div>
          )}
          {member.status === "disabled" && member.status_reason && (
            <div className="rounded-lg border border-err bg-err-bg p-4">
              <Eyebrow className="text-err">Disabled</Eyebrow>
              <p className="mb-0 mt-1 text-[12px] leading-relaxed text-err">
                {member.status_reason}
              </p>
            </div>
          )}
        </div>

        {/* ── Right column: sub-tabs + panels ── */}
        <div className="flex min-w-0 flex-col gap-4">
          <SegmentedTabs<ProfileTab>
            value={tab}
            onChange={setTab}
            options={[
              { value: "details", label: "Details & Assignment" },
              { value: "permissions", label: "Permissions" },
              { value: "activity", label: "Activity Log" },
            ]}
          />

          {tab === "details" && (
            <div className="rounded-lg border border-border bg-surface shadow-stone">
              <div className="border-b border-border-subtle px-5 py-3">
                <Eyebrow>Assignment</Eyebrow>
              </div>
              <div className="grid gap-x-6 gap-y-4 p-5" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <Field label="Company">
                  {multiCompany && canManage ? (
                    <div className="flex flex-wrap gap-1.5 py-1">
                      {companies.map((c) => {
                        const on = draft.company_ids.includes(c.id);
                        return (
                          <button
                            key={c.id}
                            className={cn(
                              "rounded-md border px-2.5 py-1 text-[12.5px] transition-colors",
                              on
                                ? "border-primary bg-primary-soft font-medium text-primary-ink"
                                : "border-border bg-surface text-ink-secondary hover:border-border-strong",
                            )}
                            onClick={() =>
                              setDraft((d) => ({
                                ...d,
                                company_ids: on
                                  ? d.company_ids.filter((id) => id !== c.id)
                                  : [...d.company_ids, c.id],
                              }))
                            }
                          >
                            {c.name}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink">
                      {(member.company_ids?.length
                        ? companies.filter((c) => member.company_ids!.includes(c.id))
                        : companies
                      )
                        .map((c) => c.name)
                        .join(", ") || "All companies"}
                    </div>
                  )}
                </Field>
                <Field label="Department">
                  <SearchableSelect
                    className={FIELD_SELECT_CLS}
                    value={draft.department_id == null ? "none" : String(draft.department_id)}
                    onChange={(v) =>
                      setDraft((d) => ({
                        ...d,
                        department_id: v === "none" ? null : Number(v),
                        position_id: null,
                      }))
                    }
                    options={[
                      { value: "none", label: "No department" },
                      ...departments.map((dep) => ({ value: String(dep.id), label: dep.name })),
                    ]}
                    disabled={!canManage}
                  />
                </Field>
                <Field label="Team">
                  <input
                    list={`team-divisions-${member.id}`}
                    value={draft.division}
                    onChange={(e) => setDraft((d) => ({ ...d, division: e.target.value }))}
                    disabled={!canManage}
                    placeholder="e.g. Driver Fleet"
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary disabled:bg-surface-2 disabled:text-ink-muted"
                  />
                  <datalist id={`team-divisions-${member.id}`}>
                    {divisionSuggestions.map((d) => (
                      <option key={d} value={d} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Title">
                  <SearchableSelect
                    className={FIELD_SELECT_CLS}
                    value={draft.position_id == null ? "none" : String(draft.position_id)}
                    onChange={(v) =>
                      setDraft((d) => ({ ...d, position_id: v === "none" ? null : Number(v) }))
                    }
                    options={[
                      { value: "none", label: "No position" },
                      ...deptPositions.map((p) => ({ value: String(p.id), label: p.name })),
                    ]}
                    disabled={!canManage}
                  />
                </Field>
                <Field label="Reports to">
                  <div className="flex items-center gap-2">
                    {draft.manager_id != null && (
                      <Avatar
                        userId={draft.manager_id}
                        name={
                          members.find((m) => m.id === draft.manager_id)?.name ?? undefined
                        }
                        size={20}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <SearchableSelect
                        className={FIELD_SELECT_CLS}
                        value={draft.manager_id == null ? "none" : String(draft.manager_id)}
                        onChange={(v) =>
                          setDraft((d) => ({ ...d, manager_id: v === "none" ? null : Number(v) }))
                        }
                        options={[
                          { value: "none", label: "No manager (top level)" },
                          ...managerOptions(member, members),
                        ]}
                        disabled={!canManage}
                      />
                    </div>
                  </div>
                </Field>
              </div>
            </div>
          )}

          {tab === "details" && showPosPin && (
            <PosPinCard
              userId={member.id}
              memberName={member.name || member.email}
              canManage={canManage}
              pendingSave={!posPinSaved}
              autoOpen={pinPrompt}
            />
          )}

          {tab === "permissions" && (
            <div className="rounded-lg border border-border bg-surface shadow-stone">
              <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
                <Eyebrow>Permissions</Eyebrow>
                <Link to="/team?tab=roles" className="text-[12px] text-primary hover:underline">
                  Manage definitions in Roles →
                </Link>
              </div>
              <div className="flex flex-col gap-3 p-5">
                <div className="flex items-center justify-between gap-3 rounded-md border border-primary bg-primary-soft px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-primary-ink">
                      {role?.name ?? member.role_name}
                    </div>
                    <div className="truncate text-[11.5px] text-primary-ink">
                      {role?.description ||
                        (role
                          ? `${role.permissions.length} permission${role.permissions.length === 1 ? "" : "s"} granted`
                          : "Role details unavailable")}
                    </div>
                  </div>
                  <Badge tone="accent">Current role</Badge>
                </div>
                <div className="flex items-center justify-between px-1 text-[12.5px] text-ink-secondary">
                  <span>Position</span>
                  <span className="text-ink">{member.position_name ?? "—"}</span>
                </div>
                <div className="flex items-center justify-between px-1 text-[12.5px] text-ink-secondary">
                  <span>Visible companies</span>
                  <span className="text-ink">
                    {member.company_ids?.length
                      ? companies
                          .filter((c) => member.company_ids!.includes(c.id))
                          .map((c) => c.name)
                          .join(", ")
                      : "All companies"}
                  </span>
                </div>
                <p className="mb-0 mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                  Page access follows the member's position; the role adds action
                  permissions on top. This profile only shows the assignment —
                  definitions live in Roles.
                </p>
              </div>
            </div>
          )}

          {tab === "activity" && (
            <div className="rounded-lg border border-border bg-surface shadow-stone">
              <div className="border-b border-border-subtle px-5 py-3">
                <Eyebrow>Activity Log</Eyebrow>
              </div>
              {activity.loading ? (
                <div className="p-5 text-[12.5px] text-ink-muted">Loading activity…</div>
              ) : (activity.data?.activity ?? []).length === 0 ? (
                <div className="p-5 text-[12.5px] text-ink-muted">
                  No recorded activity for this member yet.
                </div>
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {(activity.data?.activity ?? []).slice(0, 50).map((row) => (
                    <li
                      key={row.id}
                      className="flex items-baseline justify-between gap-3 border-b border-border-subtle px-5 py-2.5 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <span className="font-mono text-[11px] text-ink-secondary">
                          {row.action}
                        </span>
                        {row.summary && (
                          <span className="ml-2 text-[12px] text-ink-muted">{row.summary}</span>
                        )}
                      </div>
                      <span className="flex-none font-mono text-[10.5px] text-ink-muted">
                        {relativeTime(row.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </ResizableDrawer>
  );
}
