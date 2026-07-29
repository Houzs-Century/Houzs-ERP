// ---------------------------------------------------------------------------
// Mail Center admin — the "Mailboxes" tab inside User Management (Team.tsx).
//
// Three regions, mirroring Hookka's "Mailbox Access" tab but built on Houzs
// primitives (api client, useQuery, useToast, useDialog — no window.*):
//
//   A. Address list + "New mailbox" modal — assign an address to a PERSON
//      (a user) or a DEPARTMENT (a shared mailbox, by dept NAME). Edit a row to
//      reassign / relabel / toggle active.
//   B. Access matrix — users × shared mailboxes, checkboxes, Edit→Save (no
//      naked edits): the draft diffs against the server then fires POST/DELETE
//      /access per change.
//   C. View-level column — per-user personal / department / company, part of
//      the SAME Edit→Save draft, with an optimistic savedLevels guard so a
//      stale read-after-write doesn't snap the select back.
//
// Gated by the parent on can("mail_center.manage"); the backend re-checks
// isMailAdmin on every endpoint. userId is a NUMBER in Houzs (users.id serial);
// the dept picker sends the dept NAME (assigned_dept is string-matched).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from "react";
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
import { EmptyState } from "../components/EmptyState";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { useBranding } from "../hooks/useBranding";
import { cn } from "../lib/utils";
import type { TeamMember, Department } from "../types";
import {
  fetchAddresses,
  createAddress,
  patchAddress,
  fetchAccess,
  grantAccess,
  revokeAccess,
  fetchScopeLevels,
  setScopeLevel,
  type MailAddress,
  type MailScopeLevel,
} from "./MailCenter/mail-actions";

const inputCls =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
const labelCls =
  "mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

const SCOPE_LEVELS: { value: MailScopeLevel; label: string }[] = [
  { value: "personal", label: "L1 · Personal" },
  { value: "department", label: "L2 · Department" },
  { value: "company", label: "L3 · Company" },
];

// A grant key for the draft Map — `${addressId}::${userId}`.
function grantKey(addressId: string, userId: number): string {
  return `${addressId}::${userId}`;
}

export function MailboxesTab() {
  // ── Data ──────────────────────────────────────────────────────────────
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

  // New-mailbox modal + edit-row panel.
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MailAddress | null>(null);

  function reloadAddresses() {
    addressesQ.reload();
  }

  return (
    <div className="space-y-8">
      {/* Region A — address list */}
      <section>
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
          <div className="overflow-hidden rounded-md border border-border bg-surface shadow-stone">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink">
                  <th className="px-4 py-2.5">Address</th>
                  <th className="px-4 py-2.5">Label</th>
                  <th className="px-4 py-2.5">Assigned to</th>
                  <th className="px-4 py-2.5">Position</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right" />
                </tr>
              </thead>
              <tbody>
                {addresses.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-border-subtle last:border-b-0"
                  >
                    <td className="px-4 py-3 text-[12.5px] font-semibold text-ink">
                      <span className="inline-flex items-center gap-1.5">
                        <Mail size={13} className="shrink-0 text-ink-muted" />
                        {a.address}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[12px] text-ink-secondary">
                      {a.label || "—"}
                    </td>
                    <td className="px-4 py-3 text-[12px] text-ink-secondary">
                      {a.assignedUserId != null ? (
                        <span className="inline-flex items-center gap-1.5">
                          <UsersIcon size={12} className="text-ink-muted" />
                          {a.assignedUserName || `User #${a.assignedUserId}`}
                        </span>
                      ) : a.assignedDept ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Building2 size={12} className="text-ink-muted" />
                          {a.assignedDept}
                          <Badge tone="neutral" size="xs">
                            Shared
                          </Badge>
                        </span>
                      ) : (
                        <span className="text-ink-muted">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[12px] text-ink-secondary">
                      {a.assignedPosition || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={a.active ? "success" : "neutral"} size="xs">
                        {a.active ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setEditing(a)}
                        title="Edit mailbox"
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                      >
                        <Pencil size={12} /> Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Region B + C — access matrix + view levels */}
      <AccessMatrix
        addresses={addresses}
        users={users}
        loading={
          addressesQ.loading || membersQ.loading
        }
      />

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

// ── Region A modal: create a new mailbox (Person / Department) ─────────────
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
  // The verified company domain (e.g. houzscentury.com) — derived from Branding
  // so the address suggestion + the @-suffix hint track Settings.
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

  // Suggest a sensible local-part: person → their login local-part; dept → a
  // slug of the dept name. Only fills when the field is still empty.
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
        // Department shared mailbox — send the dept NAME (string-matched
        // server-side), a label, and NO user.
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
          {/* Person / Department toggle */}
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

// ── Region A edit panel: reassign / relabel / toggle active ────────────────
// Address is immutable after create (the backend PATCH can't rename), so the
// address field is shown read-only.
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
  // Keep the same person-vs-dept shape the row already has; an admin reassigns
  // within that shape (changing kind entirely is rare — recreate instead).
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
              {/* Preserve a current dept value not in the live list. */}
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

// ── Region B + C: access matrix (users × shared mailboxes) + view levels ───
// Row (user) windowing: past this many rows the matrix mounts only the user
// rows scrolled into view (mirrors DataTable's tbody windowing) so an
// O(users × mailboxes) checkbox grid doesn't put every row in the DOM at once.
// No-op below the threshold, so a normal-sized team renders byte-identically.
const MATRIX_ROW_THRESHOLD = 40;
const MATRIX_ROW_OVERSCAN = 10;
const MATRIX_ROW_ESTIMATE = 41; // px; corrected at runtime from a real row

function AccessMatrix({
  addresses,
  users,
  loading,
}: {
  addresses: MailAddress[];
  users: TeamMember[];
  loading: boolean;
}) {
  const toast = useToast();
  const dialog = useDialog();

  const accessQ = useQuery<{ addressId: string; userId: number }[]>("mailboxes-access", () =>
    fetchAccess(),
  );
  const levelsQ = useQuery<{ userId: number; level: MailScopeLevel }[]>("mailboxes-scope-levels", () =>
    fetchScopeLevels(),
  );

  // Shared mailboxes = active addresses with NO assigned user (department / role
  // mailboxes). A user's OWN personal mailbox isn't a column here.
  const sharedMailboxes = useMemo(
    () =>
      addresses.filter((a) => a.active && a.assignedUserId == null),
    [addresses],
  );

  // Server grant set, as keys.
  const serverGrants = useMemo(() => {
    const s = new Set<string>();
    for (const g of accessQ.data ?? []) s.add(grantKey(g.addressId, g.userId));
    return s;
  }, [accessQ.data]);

  // Server levels, by user. Absent ⇒ personal.
  const serverLevels = useMemo(() => {
    const m = new Map<number, MailScopeLevel>();
    for (const l of levelsQ.data ?? []) m.set(l.userId, l.level);
    return m;
  }, [levelsQ.data]);

  // Optimistic overlay so a stale read-after-write doesn't snap the select back
  // (the documented "set Company → Save → jumps to Personal" bug).
  const [savedLevels, setSavedLevels] = useState<Map<number, MailScopeLevel>>(
    new Map(),
  );
  function levelOf(userId: number): MailScopeLevel {
    return savedLevels.get(userId) ?? serverLevels.get(userId) ?? "personal";
  }

  // ── Edit→Save draft (no naked edits) ──────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [busy, setBusy] = useState(false);
  // Draft grant set (keys) + draft levels, seeded from server on entering edit.
  const [draftGrants, setDraftGrants] = useState<Set<string>>(new Set());
  const [draftLevels, setDraftLevels] = useState<Map<number, MailScopeLevel>>(
    new Map(),
  );

  function enterEdit() {
    setDraftGrants(new Set(serverGrants));
    const lv = new Map<number, MailScopeLevel>();
    for (const u of users) lv.set(u.id, levelOf(u.id));
    setDraftLevels(lv);
    setEditMode(true);
  }
  function cancelEdit() {
    setEditMode(false);
    setDraftGrants(new Set());
    setDraftLevels(new Map());
  }

  function toggleGrant(addressId: string, userId: number) {
    const k = grantKey(addressId, userId);
    setDraftGrants((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }
  function setDraftLevel(userId: number, level: MailScopeLevel) {
    setDraftLevels((prev) => {
      const next = new Map(prev);
      next.set(userId, level);
      return next;
    });
  }

  async function save() {
    // Diff draft ↔ server for grants.
    const toGrant: { addressId: string; userId: number }[] = [];
    const toRevoke: { addressId: string; userId: number }[] = [];
    for (const mb of sharedMailboxes) {
      for (const u of users) {
        const k = grantKey(mb.id, u.id);
        const want = draftGrants.has(k);
        const have = serverGrants.has(k);
        if (want && !have) toGrant.push({ addressId: mb.id, userId: u.id });
        if (!want && have) toRevoke.push({ addressId: mb.id, userId: u.id });
      }
    }
    // Diff levels.
    const levelChanges: { userId: number; level: MailScopeLevel }[] = [];
    for (const u of users) {
      const want = draftLevels.get(u.id) ?? "personal";
      const have = levelOf(u.id);
      if (want !== have) levelChanges.push({ userId: u.id, level: want });
    }

    if (
      toGrant.length === 0 &&
      toRevoke.length === 0 &&
      levelChanges.length === 0
    ) {
      setEditMode(false);
      return;
    }

    const changeCount = toGrant.length + toRevoke.length + levelChanges.length;
    if (
      !(await dialog.confirm({
        title: "Save mailbox access?",
        message: `Apply ${changeCount} change${changeCount === 1 ? "" : "s"} to shared-mailbox access and view levels?`,
        confirmLabel: "Save",
      }))
    )
      return;

    setBusy(true);
    try {
      const ops: Promise<unknown>[] = [
        ...toGrant.map((g) => grantAccess(g.addressId, g.userId)),
        ...toRevoke.map((g) => revokeAccess(g.addressId, g.userId)),
        ...levelChanges.map((l) => setScopeLevel(l.userId, l.level)),
      ];
      const results = await Promise.allSettled(ops);
      const failed = results.filter((r) => r.status === "rejected").length;
      // Optimistically remember the levels we just set so the select doesn't
      // snap back on the stale GET.
      if (levelChanges.length) {
        setSavedLevels((prev) => {
          const next = new Map(prev);
          for (const l of levelChanges) next.set(l.userId, l.level);
          return next;
        });
      }
      if (failed === 0) {
        toast.success(`Saved ${changeCount} change${changeCount === 1 ? "" : "s"}`);
      } else {
        toast.error(`Saved with ${failed} failure(s) — re-check the matrix`);
      }
      setEditMode(false);
      accessQ.reload();
      levelsQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const granted = (addressId: string, userId: number): boolean => {
    const k = grantKey(addressId, userId);
    return editMode ? draftGrants.has(k) : serverGrants.has(k);
  };
  const userLevel = (userId: number): MailScopeLevel =>
    editMode ? draftLevels.get(userId) ?? "personal" : levelOf(userId);

  // ── Row windowing (page-scroll-preserving) ────────────────────────────────
  // A capturing window scroll listener catches scroll from any ancestor; the
  // tbody is measured against the viewport and only the visible slice of user
  // rows renders, bracketed by two spacer <tr>s that reserve the off-screen
  // height. Checkbox / select state lives in React state (draftGrants /
  // draftLevels, keyed by ids), so a windowed row that scrolls out and back
  // renders with identical checked state + onChange — no DOM state is lost.
  const matrixReady = !loading && !accessQ.loading && !levelsQ.loading;
  const canVirtualize = matrixReady && users.length > MATRIX_ROW_THRESHOLD;
  const totalCols = 2 + sharedMailboxes.length; // Member + View level + mailboxes
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const rowHeightRef = useRef(MATRIX_ROW_ESTIMATE);
  const [winRange, setWinRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: MATRIX_ROW_THRESHOLD * 2,
  });
  useEffect(() => {
    if (!canVirtualize) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = tbodyRef.current;
      if (!el) return;
      const firstRow = el.querySelector<HTMLElement>("tr[data-vrow]");
      if (firstRow && firstRow.offsetHeight > 0)
        rowHeightRef.current = firstRow.offsetHeight;
      const rh = rowHeightRef.current || MATRIX_ROW_ESTIMATE;
      const top = el.getBoundingClientRect().top;
      const first = Math.max(0, Math.floor(-top / rh) - MATRIX_ROW_OVERSCAN);
      const count = Math.ceil(window.innerHeight / rh) + MATRIX_ROW_OVERSCAN * 2;
      const last = Math.min(users.length, first + count);
      setWinRange((prev) =>
        prev.start === first && prev.end === last ? prev : { start: first, end: last },
      );
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [canVirtualize, users.length]);
  const vStart = canVirtualize ? winRange.start : 0;
  const vEnd = canVirtualize ? Math.min(users.length, winRange.end) : users.length;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="h-px w-5 bg-accent" />
        <h2 className="text-[10px] font-bold uppercase tracking-brand text-accent">
          Shared mailbox access &amp; view levels
        </h2>
        <div className="ml-auto flex items-center gap-2">
          {editMode ? (
            <>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={busy}
                className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-2.5 py-1 text-[11px] font-bold text-white hover:bg-primary-ink disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Check size={12} />
                )}
                Save
              </button>
            </>
          ) : (
            <Button
              variant="ghost"
              icon={<Pencil size={13} />}
              onClick={enterEdit}
              disabled={users.length === 0}
            >
              Edit access
            </Button>
          )}
        </div>
      </div>

      {loading || accessQ.loading || levelsQ.loading ? (
        <ListSkeleton rows={5} />
      ) : users.length === 0 ? (
        <EmptyState compact message="No active members to grant access to." />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-surface shadow-stone">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink">
                <th className="sticky left-0 z-10 bg-surface-dim px-4 py-2.5">
                  Member
                </th>
                <th className="px-4 py-2.5">View level</th>
                {sharedMailboxes.map((mb) => (
                  <th
                    key={mb.id}
                    className="px-3 py-2.5 text-center"
                    title={mb.address}
                  >
                    <div className="font-semibold normal-case text-ink-secondary">
                      {mb.label || mb.address.split("@")[0]}
                    </div>
                    <div className="font-normal normal-case text-ink-muted">
                      {mb.address}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody ref={tbodyRef}>
              {canVirtualize && vStart > 0 && (
                <tr aria-hidden>
                  <td
                    colSpan={totalCols}
                    style={{ height: vStart * rowHeightRef.current, padding: 0, border: 0 }}
                  />
                </tr>
              )}
              {users.slice(vStart, vEnd).map((u) => (
                <tr
                  key={u.id}
                  data-vrow=""
                  className="border-b border-border-subtle last:border-b-0"
                >
                  <td className="sticky left-0 z-10 bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink">
                    {u.name || u.email}
                  </td>
                  <td className="px-4 py-2.5">
                    {editMode ? (
                      <select
                        value={userLevel(u.id)}
                        onChange={(e) =>
                          setDraftLevel(u.id, e.target.value as MailScopeLevel)
                        }
                        disabled={busy}
                        className="h-8 cursor-pointer rounded-md border border-border bg-surface px-2 text-[11.5px] text-ink outline-none hover:border-accent/50 focus:border-primary"
                      >
                        {SCOPE_LEVELS.map((l) => (
                          <option key={l.value} value={l.value}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge tone="neutral" size="xs">
                        {SCOPE_LEVELS.find((l) => l.value === userLevel(u.id))
                          ?.label ?? userLevel(u.id)}
                      </Badge>
                    )}
                  </td>
                  {sharedMailboxes.map((mb) => {
                    const on = granted(mb.id, u.id);
                    return (
                      <td key={mb.id} className="px-3 py-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!editMode || busy}
                          onChange={() => toggleGrant(mb.id, u.id)}
                          aria-label={`${u.name || u.email} access to ${mb.address}`}
                          className="h-4 w-4 cursor-pointer accent-[#a16a2e] disabled:cursor-default disabled:opacity-60"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {canVirtualize && vEnd < users.length && (
                <tr aria-hidden>
                  <td
                    colSpan={totalCols}
                    style={{
                      height: (users.length - vEnd) * rowHeightRef.current,
                      padding: 0,
                      border: 0,
                    }}
                  />
                </tr>
              )}
            </tbody>
          </table>
          {sharedMailboxes.length === 0 && (
            <div className="px-4 py-6 text-center text-[12px] text-ink-muted">
              No shared (department) mailboxes yet. Create one above with "Assign
              to → Department" to grant per-member access here. View levels still
              apply.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
