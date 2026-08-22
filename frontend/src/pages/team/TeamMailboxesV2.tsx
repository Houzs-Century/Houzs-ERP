import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { useAuth } from "../../auth/AuthContext";
import { cn } from "../../lib/utils";
import { DataTable, type Column } from "../../components/DataTable";
import { StatCard } from "../../components/StatCard";
import { Badge } from "../../components/Badge";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { Panel, PanelSection } from "../../components/Panel";
import { SearchableSelect } from "../../vendor/scm/components/SearchableSelect";
import {
  fetchAddresses,
  patchAddress,
  createAddress,
  type MailAddress,
} from "../MailCenter/mail-actions";
import type { TeamMember, Department } from "../../types";
import { Eyebrow, SegmentedTabs, buildDeptNodes, FIELD_SELECT_CLS } from "./teamShared";

/* Mailboxes — design handoff screen 07, on the existing Mail Center data.
 * Personal mailboxes are tied to members, department mailboxes sit in their
 * own layer, and an ORPHANED mailbox (assigned member disabled, address
 * still active) is surfaced for resolution right on its row.
 *
 * The classic tab's access matrix + per-member scope tools stay at
 * /team?tab=mail; this screen is the directory-facing view. */

type ViewTab = "all" | "department" | "personal" | "orphaned";

type MailboxRow = MailAddress & {
  kind: "personal" | "department" | "unassigned";
  member: TeamMember | null;
  orphaned: boolean;
};

export function TeamMailboxesV2() {
  const { can } = useAuth();
  const canManage = can("mail_center.manage");
  const toast = useToast();
  const dialog = useDialog();

  const addresses = useQuery<MailAddress[]>("/api/mail-center/addresses?manage=1", () =>
    fetchAddresses(),
  );
  const members = useQuery<{ users: TeamMember[] }>("/api/users", () =>
    api.get("/api/users"),
  );
  const depts = useQuery<{ departments: Department[] }>(
    "/api/departments",
    () => api.get("/api/departments"),
    [],
    { staleTime: 60_000 },
  );

  const users = useMemo(() => members.data?.users ?? [], [members.data]);
  const departments = depts.data?.departments ?? [];
  const { nodes } = useMemo(() => buildDeptNodes(users, departments), [users, departments]);

  const [tab, setTab] = useState<ViewTab>("all");
  const [managing, setManaging] = useState<MailboxRow | null>(null);
  const [creating, setCreating] = useState(false);

  const rows: MailboxRow[] = useMemo(() => {
    const byId = new Map(users.map((u) => [u.id, u]));
    return (addresses.data ?? []).map((a) => {
      const member = a.assignedUserId != null ? byId.get(a.assignedUserId) ?? null : null;
      const kind: MailboxRow["kind"] =
        a.assignedUserId != null ? "personal" : a.assignedDept ? "department" : "unassigned";
      return {
        ...a,
        kind,
        member,
        orphaned:
          a.active &&
          a.assignedUserId != null &&
          (member == null || member.status === "disabled"),
      };
    });
  }, [addresses.data, users]);

  const counts = useMemo(
    () => ({
      personal: rows.filter((r) => r.kind === "personal").length,
      department: rows.filter((r) => r.kind === "department").length,
      unassigned: rows.filter((r) => r.kind === "unassigned").length,
      orphaned: rows.filter((r) => r.orphaned).length,
    }),
    [rows],
  );

  const visible = useMemo(() => {
    let list = rows;
    if (tab === "department") list = rows.filter((r) => r.kind === "department");
    else if (tab === "personal") list = rows.filter((r) => r.kind === "personal");
    else if (tab === "orphaned") list = rows.filter((r) => r.orphaned);
    return [...list].sort((a, b) => {
      if (a.orphaned !== b.orphaned) return a.orphaned ? -1 : 1;
      return a.address.localeCompare(b.address);
    });
  }, [rows, tab]);

  const domains = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const domain = "@" + (r.address.split("@")[1] ?? "");
      m.set(domain, (m.get(domain) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  async function closeMailbox(row: MailboxRow) {
    if (
      !(await dialog.confirm({
        message: `Close ${row.address}? It stops receiving mail; existing threads stay readable.`,
        tone: "danger",
        confirmLabel: "Close mailbox",
      }))
    )
      return;
    try {
      await patchAddress(row.id, { active: false });
      toast.success(`${row.address} closed`);
      addresses.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not close the mailbox");
    }
  }

  /* Mail Center stores the department as a free-text NAME ("Operation"),
     while departments carry fuller names ("Operation Department") — match
     loosely in both directions, the same contains-rule the backend's
     ?department= filter uses. */
  const deptNode = (deptName: string | undefined) => {
    if (!deptName) return null;
    const q = deptName.trim().toLowerCase();
    return (
      nodes.find((n) => {
        const full = n.dept.name.trim().toLowerCase();
        return full === q || full.includes(q) || q.includes(full);
      }) ?? null
    );
  };
  const deptLeadName = (deptName: string | undefined): string | null => {
    const node = deptNode(deptName);
    return node?.lead ? node.lead.name || node.lead.email : null;
  };

  const columns: Column<MailboxRow>[] = useMemo(
    () => [
      {
        key: "address",
        label: "Address",
        width: "230px",
        render: (r) => (
          <span
            className={cn(
              "truncate font-mono text-[12.5px]",
              r.orphaned ? "text-err" : "text-ink",
            )}
          >
            {r.address}
          </span>
        ),
        getValue: (r) => r.address,
      },
      {
        key: "type",
        label: "Type",
        width: "118px",
        render: (r) =>
          r.orphaned ? (
            <Badge tone="error">Orphaned</Badge>
          ) : r.kind === "department" ? (
            <Badge tone="accent">Department</Badge>
          ) : r.kind === "personal" ? (
            <Badge tone="neutral">Personal</Badge>
          ) : (
            <Badge tone="warning">Unassigned</Badge>
          ),
        getValue: (r) => (r.orphaned ? "Orphaned" : r.kind),
      },
      {
        key: "recipients",
        label: "Recipients",
        render: (r) => {
          if (r.orphaned)
            return (
              <span className="truncate text-[12px] text-err">
                {r.member
                  ? `${r.member.name || r.member.email} was disabled — mailbox is still receiving mail`
                  : "Assigned member no longer exists — mailbox is still receiving mail"}
              </span>
            );
          if (r.kind === "department") {
            const node = deptNode(r.assignedDept);
            return (
              <span className="truncate text-[12px] text-ink-secondary">
                {r.assignedDept}
                {node ? ` · ${node.counts.visible} people (synced with department)` : ""}
              </span>
            );
          }
          if (r.member)
            return (
              <span className="flex min-w-0 items-center gap-2">
                <Avatar
                  userId={r.member.id}
                  hasImage={r.member.profile_pic_r2_key}
                  name={r.member.name ?? r.member.email}
                  size={20}
                />
                <span className="truncate text-[12px] text-ink-secondary">
                  {r.member.name || r.member.email}
                </span>
              </span>
            );
          return <span className="text-[12px] text-ink-muted">—</span>;
        },
        getValue: (r) =>
          r.kind === "department"
            ? r.assignedDept ?? ""
            : r.member?.name ?? r.assignedUserName ?? "",
        disableSort: true,
      },
      {
        key: "owner",
        label: "Owner",
        width: "140px",
        render: (r) => {
          const owner =
            r.kind === "department"
              ? deptLeadName(r.assignedDept)
              : r.member?.name ?? r.assignedUserName ?? null;
          return (
            <span className={cn("truncate text-[12.5px]", owner ? "text-ink" : "text-err")}>
              {owner ?? "Unassigned"}
            </span>
          );
        },
        getValue: (r) =>
          (r.kind === "department"
            ? deptLeadName(r.assignedDept)
            : r.member?.name ?? r.assignedUserName) ?? "Unassigned",
      },
      {
        key: "status",
        label: "Status",
        width: "100px",
        render: (r) =>
          r.orphaned ? (
            <Badge tone="error">Needs action</Badge>
          ) : r.active ? (
            <Badge tone="success">Active</Badge>
          ) : (
            <Badge tone="neutral">Closed</Badge>
          ),
        getValue: (r) => (r.orphaned ? "Needs action" : r.active ? "Active" : "Closed"),
      },
      {
        key: "actions",
        label: "",
        width: "150px",
        disableSort: true,
        disableFilter: true,
        render: (r) =>
          canManage ? (
            <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
              {r.orphaned ? (
                <>
                  <Button variant="ghost" onClick={() => setManaging(r)}>
                    Transfer
                  </Button>
                  <Button variant="secondary" onClick={() => closeMailbox(r)}>
                    Close
                  </Button>
                </>
              ) : (
                <Button variant="ghost" onClick={() => setManaging(r)}>
                  Manage
                </Button>
              )}
            </div>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canManage, nodes],
  );

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Personal mailboxes"
          value={counts.personal}
          subtitle="Tied to a member account"
          onClick={() => setTab("personal")}
          active={tab === "personal"}
        />
        <StatCard
          label="Department mailboxes"
          value={counts.department}
          subtitle="By department & function"
          onClick={() => setTab("department")}
          active={tab === "department"}
        />
        <StatCard
          label="Unassigned"
          value={counts.unassigned}
          subtitle="No member or department attached"
          tone={counts.unassigned > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Orphaned mailboxes"
          value={counts.orphaned}
          subtitle="Member disabled but still receiving mail"
          tone={counts.orphaned > 0 ? "error" : "default"}
          onClick={() => setTab("orphaned")}
          active={tab === "orphaned"}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SegmentedTabs<ViewTab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "all", label: "All mailboxes" },
            { value: "department", label: `Department ${counts.department}` },
            { value: "personal", label: `Personal ${counts.personal}` },
            ...(counts.orphaned > 0
              ? [{ value: "orphaned" as const, label: `Orphaned ${counts.orphaned}` }]
              : []),
          ]}
        />
        <div className="flex items-center gap-2">
          <Link
            to="/team?tab=mail"
            className="text-[12px] text-primary hover:underline"
            title="Access matrix and per-member mail visibility"
          >
            Access matrix & visibility →
          </Link>
          {canManage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              + New Mailbox
            </Button>
          )}
        </div>
      </div>

      <DataTable<MailboxRow>
        tableId="team-mailboxes"
        columns={columns}
        rows={addresses.loading ? null : visible}
        loading={addresses.loading}
        error={addresses.error ? "Couldn't load mailboxes." : undefined}
        emptyLabel="No mailboxes in this view."
        getRowKey={(r) => r.id}
        getRowClassName={(r) => (r.orphaned ? "bg-err-bg" : "")}
        exportName="team-mailboxes"
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
          <Eyebrow>Domains</Eyebrow>
          <div className="mt-3 flex flex-col gap-2 text-[12.5px]">
            {domains.map(([domain, n]) => (
              <div key={domain} className="flex items-center justify-between">
                <span className="font-mono text-[12px] text-ink">{domain}</span>
                <span className="text-ink-secondary">
                  {n} mailbox{n === 1 ? "" : "es"}
                </span>
              </div>
            ))}
            <p className="mb-0 mt-1 text-[11.5px] leading-relaxed text-ink-muted">
              Mail arrives through the read-only sync — creating a mailbox here
              registers it in the ERP; the address itself is provisioned in Google
              Workspace.
            </p>
          </div>
        </div>
        {counts.orphaned > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-accent bg-warning-bg p-4">
            <Badge tone="accent">Heads up</Badge>
            <p className="mb-0 text-[12.5px] leading-relaxed text-warning-text">
              {counts.orphaned} mailbox{counts.orphaned === 1 ? " is" : "es are"} still
              active for a disabled member. Transfer each one to a teammate or close it —
              disabling a member doesn't close their mailbox automatically yet.
            </p>
          </div>
        )}
      </div>

      {managing && (
        <MailboxManagePanel
          row={managing}
          users={users}
          departments={departments}
          onClose={() => setManaging(null)}
          onSaved={() => addresses.reload()}
        />
      )}
      {creating && (
        <MailboxCreatePanel
          users={users}
          departments={departments}
          onClose={() => setCreating(false)}
          onSaved={() => addresses.reload()}
        />
      )}
    </div>
  );
}

function MailboxManagePanel({
  row,
  users,
  departments,
  onClose,
  onSaved,
}: {
  row: MailboxRow;
  users: TeamMember[];
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState(row.label);
  const [assign, setAssign] = useState(() =>
    row.assignedUserId != null
      ? `u:${row.assignedUserId}`
      : row.assignedDept
        ? `d:${row.assignedDept}`
        : "none",
  );
  const [active, setActive] = useState(row.active);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const patch: Parameters<typeof patchAddress>[1] = {
        label: label.trim() || undefined,
        active,
      };
      if (assign === "none") {
        patch.assignedUserId = null;
        patch.assignedDept = null;
        patch.assignedUserName = null;
      } else if (assign.startsWith("u:")) {
        const u = users.find((x) => x.id === Number(assign.slice(2)));
        patch.assignedUserId = u?.id ?? null;
        patch.assignedUserName = u?.name ?? u?.email ?? null;
        patch.assignedDept = null;
      } else if (assign.startsWith("d:")) {
        patch.assignedDept = assign.slice(2);
        patch.assignedUserId = null;
        patch.assignedUserName = null;
      }
      await patchAddress(row.id, patch);
      toast.success(`${row.address} updated`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the mailbox");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title={row.address}
      subtitle={row.orphaned ? "Orphaned — pick a new home for this mailbox" : "Mailbox settings"}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Assignment">
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-[11.5px] text-ink-muted">Label</div>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <div className="text-[11.5px] text-ink-muted">Assigned to</div>
            <div className="mt-1">
              <SearchableSelect
                className={FIELD_SELECT_CLS}
                value={assign}
                onChange={setAssign}
                options={[
                  { value: "none", label: "Unassigned" },
                  ...departments.map((d) => ({
                    value: `d:${d.name}`,
                    label: `Department · ${d.name}`,
                  })),
                  ...users
                    .filter((u) => u.status !== "disabled")
                    .map((u) => ({
                      value: `u:${u.id}`,
                      label: u.name ? `${u.name} (${u.email})` : u.email,
                    })),
                ]}
              />
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-secondary">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            Active — receives mail
          </label>
        </div>
      </PanelSection>
    </Panel>
  );
}

function MailboxCreatePanel({
  users,
  departments,
  onClose,
  onSaved,
}: {
  users: TeamMember[];
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [assign, setAssign] = useState("none");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!address.trim().includes("@") || busy) return;
    setBusy(true);
    try {
      const input: Parameters<typeof createAddress>[1] = { label: label.trim() || undefined };
      if (assign.startsWith("u:")) {
        const u = users.find((x) => x.id === Number(assign.slice(2)));
        input.assignedUserId = u?.id ?? null;
        input.assignedUserName = u?.name ?? u?.email;
      } else if (assign.startsWith("d:")) {
        input.assignedDept = assign.slice(2);
      }
      await createAddress(address.trim(), input);
      toast.success(`${address.trim()} created`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the mailbox");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title="New Mailbox"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={busy || !address.trim().includes("@")}
          >
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Mailbox">
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-[11.5px] text-ink-muted">Address</div>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="name@houzscentury.com"
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-[12.5px] text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <div className="text-[11.5px] text-ink-muted">Label</div>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Operations shared inbox"
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <div className="text-[11.5px] text-ink-muted">Assigned to</div>
            <div className="mt-1">
              <SearchableSelect
                className={FIELD_SELECT_CLS}
                value={assign}
                onChange={setAssign}
                options={[
                  { value: "none", label: "Unassigned" },
                  ...departments.map((d) => ({
                    value: `d:${d.name}`,
                    label: `Department · ${d.name}`,
                  })),
                  ...users
                    .filter((u) => u.status !== "disabled")
                    .map((u) => ({
                      value: `u:${u.id}`,
                      label: u.name ? `${u.name} (${u.email})` : u.email,
                    })),
                ]}
              />
            </div>
          </div>
        </div>
      </PanelSection>
    </Panel>
  );
}
