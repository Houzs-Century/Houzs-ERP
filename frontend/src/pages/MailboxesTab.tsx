// ---------------------------------------------------------------------------
// Mail Center admin — the "Mailboxes" tab inside User Management (Team.tsx).
//
// Three subpages (owner 2026-11-21), ?mail= in the URL:
//   Mailboxes        - what to act on (address requests, Google Admin steps), the address list, "New mailbox", edit a row.
//   Gmail connection - newest mail each mailbox has received.
//   Access           - each person's level and ticks (mail-access-levels.tsx).
//
// Gated by the parent on can("mail_center.manage"); the backend re-checks
// isMailAdmin on every endpoint. userId is a NUMBER in Houzs (users.id serial);
// the dept picker sends the dept NAME (assigned_dept is string-matched).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from "react";
import { MailClaimRequests } from "./team/MailClaimRequests";
import { MailHostPending } from "./team/MailHostPending";
import { MailHostRemove } from "./team/MailHostRemove";
import {
  Plus,
  Mail,
  Pencil,
  X,
  Check,
  Users as UsersIcon,
  Building2,
  Loader2,
} from "lucide-react";
import { Button } from "../components/Button";
import { Panel, PanelSection } from "../components/Panel";
import { Badge } from "../components/Badge";
import { DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { useBranding } from "../hooks/useBranding";
import { cn } from "../lib/utils";
import type { TeamMember, Department } from "../types";
import { useSearchParams } from "react-router-dom";
import {
  fetchAddresses,
  createAddress,
  patchAddress,
  type MailAddress,
} from "./MailCenter/mail-actions";
import { AccessChangeLog, MailboxConnection } from "./mail-access-parts";
import { AccessLevels } from "./mail-access-levels";

/* Three subpages (owner 2026-11-21); the open one is in the URL (?mail=). */
const SUBPAGES = [
  { id: "mailboxes", title: "Mailboxes" },
  { id: "connection", title: "Gmail connection" },
  { id: "access", title: "Access" },
] as const;
type Subpage = (typeof SUBPAGES)[number]["id"];

const inputCls =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
const labelCls =
  "mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

export function MailboxesTab() {
  const addressesQ = useQuery<MailAddress[]>("mailboxes-addresses", () => fetchAddresses());
  const membersQ = useQuery<{ users: TeamMember[] }>("/api/users", () =>
    api.get("/api/users"),
  );
  const deptsQ = useQuery<{ departments: Department[] }>("/api/departments", () =>
    api.get("/api/departments"),
  );

  const addresses = addressesQ.data ?? [];
  const users = useMemo(
    () =>
      (membersQ.data?.users ?? [])
        .filter((u) => u.status === "active")
        .slice()
        .sort((a, b) =>
          (a.name || a.email).localeCompare(b.name || b.email),
        ),
    [membersQ.data],
  );

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MailAddress | null>(null);

  const [params, setParams] = useSearchParams();
  const sub: Subpage = SUBPAGES.some((p) => p.id === params.get("mail")) ? (params.get("mail") as Subpage) : "mailboxes";
  function openSub(key: Subpage) {
    const next = new URLSearchParams(params);
    if (key === "mailboxes") next.delete("mail");
    else next.set("mail", key);
    setParams(next, { replace: true });
  }

  function reloadAddresses() {
    addressesQ.reload();
  }

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Mail Center" className="flex flex-wrap gap-1 border-b border-border">
        {SUBPAGES.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={sub === p.id}
            onClick={() => openSub(p.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-[12.5px] font-semibold transition-colors",
              sub === p.id ? "border-primary text-ink" : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {p.title}
          </button>
        ))}
      </div>

      {sub === "mailboxes" && (
      <section>
        <div className="mb-4 flex flex-col gap-3 empty:hidden">
          <MailClaimRequests />
          <MailHostPending />
          <MailHostRemove />
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="h-px w-5 bg-accent" />
          <h2 className="text-[10px] font-bold uppercase tracking-brand text-accent">
            Mailboxes ({addresses.length})
          </h2>
          <div className="ml-auto">
            <Button
              variant="brass"
              icon={<Plus size={14} />}
              onClick={() => setCreating(true)}
            >
              New mailbox
            </Button>
          </div>
        </div>

        {addressesQ.loading && !addressesQ.data ? (
          <ListSkeleton rows={4} />
        ) : addresses.length === 0 ? (
          <EmptyState
            compact
            message="No mailboxes yet. Create one to assign an address to a person or a department."
          />
        ) : (
          <DataTable<MailAddress>
            tableId="mailboxes"
            exportName="mailboxes"
            exportXlsx
            columns={[
              {
                key: "address", label: "Address", getValue: (a) => a.address,
                render: (a) => (
                  <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                    <Mail size={13} className="shrink-0 text-ink-muted" />
                    {a.address}
                  </span>
                ),
              },
              { key: "label", label: "Label", getValue: (a) => a.label, render: (a) => a.label || "—" },
              {
                key: "assigned", label: "Assigned to",
                getValue: (a) => (a.assignedUserId != null ? a.assignedUserName || `User #${a.assignedUserId}` : a.assignedDept || "Unassigned"),
                render: (a) => (a.assignedUserId != null ? (
                  <span className="inline-flex items-center gap-1.5">
                    <UsersIcon size={12} className="text-ink-muted" />
                    {a.assignedUserName || `User #${a.assignedUserId}`}
                  </span>
                ) : a.assignedDept ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Building2 size={12} className="text-ink-muted" />
                    {a.assignedDept}
                    <Badge tone="neutral" size="xs">Shared</Badge>
                  </span>
                ) : (
                  <span className="text-ink-muted">Unassigned</span>
                )),
              },
              { key: "position", label: "Position", getValue: (a) => a.assignedPosition ?? "", render: (a) => a.assignedPosition || "—" },
              {
                key: "status", label: "Status", getValue: (a) => (a.active ? "Active" : "Inactive"),
                render: (a) => <Badge tone={a.active ? "success" : "neutral"} size="xs">{a.active ? "Active" : "Inactive"}</Badge>,
              },
              {
                key: "actions", label: "", exportLabel: "Actions", align: "right",
                render: (a) => (
                  <button
                    type="button"
                    onClick={() => setEditing(a)}
                    title="Edit mailbox"
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                ),
              },
            ]}
            rows={addresses}
            getRowKey={(a) => a.id}
          />
        )}
      </section>
      )}

      {sub === "connection" && <MailboxConnection />}

      {sub === "access" && (
        <>
          <AccessLevels
            addresses={addresses}
            users={users}
            departments={deptsQ.data?.departments ?? []}
            loading={addressesQ.loading || membersQ.loading}
          />
          <AccessChangeLog />
        </>
      )}

      {creating && (
        <NewMailboxModal
          users={users}
          departments={deptsQ.data?.departments ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reloadAddresses();
          }}
        />
      )}

      {editing && (
        <EditMailboxPanel
          address={editing}
          users={users}
          departments={deptsQ.data?.departments ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reloadAddresses();
          }}
        />
      )}
    </div>
  );
}

function NewMailboxModal({
  users,
  departments,
  onClose,
  onCreated,
}: {
  users: TeamMember[];
  departments: Department[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const branding = useBranding();
  const domain = useMemo(() => {
    const fromEmail = (branding.email || "").split("@")[1];
    return (fromEmail || "houzscentury.com").trim().toLowerCase();
  }, [branding.email]);

  const [kind, setKind] = useState<"person" | "dept">("person");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [userId, setUserId] = useState<number | "">("");
  const [dept, setDept] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedUser = users.find((u) => u.id === userId);

  function suggestFor(localPart: string) {
    if (address.trim()) return;
    const clean = localPart.toLowerCase().replace(/[^a-z0-9._-]+/g, "");
    if (clean) setAddress(`${clean}@${domain}`);
  }

  const addrTrim = address.trim().toLowerCase();
  const addrValid =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addrTrim) &&
    addrTrim.endsWith(`@${domain}`);
  const canSave =
    !busy &&
    addrValid &&
    (kind === "person" ? userId !== "" : dept.trim().length > 0);

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      if (kind === "person" && selectedUser) {
        await createAddress(addrTrim, {
          assignedUserId: selectedUser.id,
          assignedUserName: selectedUser.name || selectedUser.email,
          label: label.trim() || undefined,
        });
      } else {
        await createAddress(addrTrim, {
          assignedDept: dept,
          label: label.trim() || `${dept} Team`,
        });
      }
      toast.success(`Mailbox ${addrTrim} created`);
      onCreated();
    } catch (e: any) {
      const msg = String(e?.message || "").replace(/^\d+:\s*/, "");
      toast.error(msg || "Couldn't create mailbox");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      <div
        className="fixed inset-0 bg-ink/40 backdrop-blur-sm"
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New mailbox"
        className="relative mx-4 flex max-h-[90vh] w-full max-w-md flex-col rounded-xl border border-border bg-surface shadow-slab"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold text-ink">New mailbox</h3>
          </div>
          <button
            onClick={() => {
              if (!busy) onClose();
            }}
            aria-label="Close"
            disabled={busy}
            className="rounded-md p-1 text-ink-muted transition hover:bg-surface-dim hover:text-ink disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div>
            <label className={labelCls}>Assign to</label>
            <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
              <button
                type="button"
                onClick={() => setKind("person")}
                disabled={busy}
                className={cn(
                  "inline-flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-semibold transition-colors",
                  kind === "person"
                    ? "bg-accent-soft text-accent"
                    : "text-ink-muted hover:text-ink",
                )}
              >
                <UsersIcon size={13} /> Person
              </button>
              <button
                type="button"
                onClick={() => setKind("dept")}
                disabled={busy}
                className={cn(
                  "inline-flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-semibold transition-colors",
                  kind === "dept"
                    ? "bg-accent-soft text-accent"
                    : "text-ink-muted hover:text-ink",
                )}
              >
                <Building2 size={13} /> Department
              </button>
            </div>
            <div className="mt-1 text-[10px] text-ink-muted">
              {kind === "person"
                ? "A personal mailbox for one member — defaults their reply From."
                : "A shared department mailbox — grant access below once created."}
            </div>
          </div>

          {kind === "person" ? (
            <div>
              <label className={labelCls}>Member</label>
              <select
                value={userId}
                disabled={busy}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : "";
                  setUserId(id);
                  const u = users.find((x) => x.id === id);
                  if (u) {
                    const local = (u.email || "").split("@")[0] || u.name || "";
                    suggestFor(local);
                  }
                }}
                className={inputCls}
              >
                <option value="">— Pick a member —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.email}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className={labelCls}>Department</label>
              <select
                value={dept}
                disabled={busy}
                onChange={(e) => {
                  setDept(e.target.value);
                  if (e.target.value) {
                    suggestFor(e.target.value.split(" ")[0]);
                    if (!label.trim()) setLabel(`${e.target.value} Team`);
                  }
                }}
                className={inputCls}
              >
                <option value="">— Pick a department —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
              <div className="mt-1 text-[10px] text-ink-muted">
                Stored as the department name — members in that department (at L2)
                and anyone you grant access can read it.
              </div>
            </div>
          )}

          <div>
            <label className={labelCls}>Address</label>
            <input
              type="email"
              value={address}
              disabled={busy}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={`name@${domain}`}
              className={inputCls}
            />
            {address.trim() && !addrValid && (
              <div className="mt-1 text-[10px] text-err">
                Must be a valid address ending in @{domain}.
              </div>
            )}
          </div>

          <div>
            <label className={labelCls}>Label (optional)</label>
            <input
              type="text"
              value={label}
              disabled={busy}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={
                kind === "dept" ? "e.g. Sales Team" : "e.g. Lim Wei Siang"
              }
              className={inputCls}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-dim px-4 py-3">
          <button
            onClick={() => {
              if (!busy) onClose();
            }}
            disabled={busy}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-1.5 text-[12px] font-bold text-white hover:bg-primary-ink disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function EditMailboxPanel({
  address,
  users,
  departments,
  onClose,
  onSaved,
}: {
  address: MailAddress;
  users: TeamMember[];
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState(address.label || "");
  const [position, setPosition] = useState(address.assignedPosition || "");
  const isPerson = address.assignedUserId != null;
  const [userId, setUserId] = useState<number | "">(
    address.assignedUserId ?? "",
  );
  const [dept, setDept] = useState(address.assignedDept || "");
  const [active, setActive] = useState(address.active);
  const [busy, setBusy] = useState(false);

  async function save() {
    const patch: Parameters<typeof patchAddress>[1] = {};
    if ((label.trim() || null) !== (address.label || null))
      patch.label = label.trim();
    if ((position.trim() || null) !== (address.assignedPosition || null))
      patch.assignedPosition = position.trim() || null;
    if (active !== address.active) patch.active = active;
    if (isPerson) {
      if ((userId || null) !== (address.assignedUserId ?? null)) {
        const u = users.find((x) => x.id === userId);
        patch.assignedUserId = userId === "" ? null : (userId as number);
        patch.assignedUserName = u ? u.name || u.email : null;
      }
    } else {
      if ((dept.trim() || null) !== (address.assignedDept || null))
        patch.assignedDept = dept.trim() || null;
    }

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await patchAddress(address.id, patch);
      toast.success(`Saved ${address.address}`);
      onSaved();
    } catch (e: any) {
      const msg = String(e?.message || "").replace(/^\d+:\s*/, "");
      toast.error(msg || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title={address.address}
      subtitle="Edit mailbox"
      width={420}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-1.5 text-[12px] font-bold text-white hover:bg-primary-ink disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save
          </button>
        </div>
      }
    >
      <PanelSection title="Mailbox">
        <div>
          <label className={labelCls}>Address</label>
          <input
            type="text"
            value={address.address}
            readOnly
            className={cn(inputCls, "bg-surface-dim text-ink-muted")}
          />
          <div className="mt-1 text-[10px] text-ink-muted">
            The address can't be renamed — recreate to change it.
          </div>
        </div>
        <div>
          <label className={labelCls}>Label</label>
          <input
            type="text"
            value={label}
            disabled={busy}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Display label (optional)"
            className={inputCls}
          />
        </div>
      </PanelSection>

      <PanelSection title="Assignment">
        {isPerson ? (
          <div>
            <label className={labelCls}>Member</label>
            <select
              value={userId}
              disabled={busy}
              onChange={(e) =>
                setUserId(e.target.value ? Number(e.target.value) : "")
              }
              className={inputCls}
            >
              <option value="">— Unassigned —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className={labelCls}>Department</label>
            <select
              value={dept}
              disabled={busy}
              onChange={(e) => setDept(e.target.value)}
              className={inputCls}
            >
              <option value="">— None —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.name}>
                  {d.name}
                </option>
              ))}
              {dept &&
                !departments.some((d) => d.name === dept) && (
                  <option value={dept}>{dept}</option>
                )}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls}>Position (optional)</label>
          <input
            type="text"
            value={position}
            disabled={busy}
            onChange={(e) => setPosition(e.target.value)}
            placeholder="e.g. Sales"
            className={inputCls}
          />
        </div>
      </PanelSection>

      <PanelSection title="Status">
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="text-[12.5px] text-ink">Active</span>
          <input
            type="checkbox"
            checked={active}
            disabled={busy}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-[#a16a2e]"
          />
        </label>
        <div className="text-[10px] text-ink-muted">
          Inactive mailboxes stop receiving + sending and disappear from members'
          scope. No hard delete.
        </div>
      </PanelSection>
    </Panel>
  );
}
