// Mail Center access page pieces kept out of MailboxesTab.tsx (owner 2026-11-21):
// what the Org Chart gives each person, the personal mailboxes shared with them,
// the change log, and each mailbox's connection to Gmail.
import { useState } from "react";
import { Building2, Clock, Plus, ShieldCheck, X } from "lucide-react";
import { Badge } from "../components/Badge";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import { fmtDateTime } from "../vendor/shared/format";
import type { Department, TeamMember } from "../types";
import type { MailAddress, MailScopeLevel } from "./MailCenter/mail-actions";

/** The Org Chart department whose members read every mailbox (owner 2026-11-21, A). */
export const MANAGEMENT_DEPARTMENT = "management";

export function departmentIdsOf(u: TeamMember): number[] {
  const ids = u.department_ids?.length ? u.department_ids : u.department_id != null ? [u.department_id] : [];
  return [...new Set(ids)];
}

export function isManagement(u: TeamMember, departments: Department[]): boolean {
  const mgmt = departments.find((d) => d.name.trim().toLowerCase() === MANAGEMENT_DEPARTMENT);
  return !!mgmt && departmentIdsOf(u).includes(mgmt.id);
}

/** Management always reads the whole company; everyone else keeps the level set for them. */
export function effectiveLevel(u: TeamMember, departments: Department[], level: MailScopeLevel): MailScopeLevel {
  return isManagement(u, departments) ? "company" : level;
}

/** Why a department mailbox reaches this person without a tick, or null when only a tick would. */
export function autoReason(
  mb: MailAddress,
  u: TeamMember,
  level: MailScopeLevel,
): "company" | "department" | null {
  if (level === "company") return "company";
  if (level === "personal") return null;
  return mb.departmentId != null && departmentIdsOf(u).includes(mb.departmentId) ? "department" : null;
}

export function OrgChartCell({ u, departments }: { u: TeamMember; departments: Department[] }) {
  const names = departmentIdsOf(u)
    .map((id) => departments.find((d) => d.id === id)?.name)
    .filter((n): n is string => !!n);
  if (names.length === 0) return <span className="text-[11.5px] italic text-warning-text">No department</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((n) => (
        <span key={n} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-dim px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary">
          <Building2 size={10} />
          {n}
        </span>
      ))}
    </div>
  );
}

export function AutoTick({ reason }: { reason: "company" | "department" }) {
  return (
    <span
      title={reason === "company" ? "Whole company level" : "From the Org Chart department"}
      className="inline-flex h-4 w-4 items-center justify-center rounded-[4px] bg-primary/15 text-primary"
    >
      <ShieldCheck size={11} />
    </span>
  );
}

/** Personal mailboxes of colleagues shared with this person (cover, handover). */
export function PersonalShares({
  shared,
  options,
  editing,
  onAdd,
  onRemove,
}: {
  shared: MailAddress[];
  options: MailAddress[];
  editing: boolean;
  onAdd: (addressId: string) => void;
  onRemove: (addressId: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shared.map((a) => (
        <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 text-[10.5px] font-semibold text-warning-text" title={a.address}>
          {a.assignedUserName || a.address.split("@")[0]}
          {editing && (
            <button type="button" aria-label={`Stop sharing ${a.address}`} onClick={() => onRemove(a.id)} className="hover:text-ink">
              <X size={10} />
            </button>
          )}
        </span>
      ))}
      {shared.length === 0 && !editing && <span className="text-[11px] text-ink-muted">-</span>}
      {editing &&
        (picking ? (
          <select
            autoFocus
            aria-label="Share a colleague's mailbox"
            className="h-7 rounded-md border border-border bg-surface px-1.5 text-[11px] text-ink"
            value=""
            onChange={(e) => {
              if (e.target.value) onAdd(e.target.value);
              setPicking(false);
            }}
            onBlur={() => setPicking(false)}
          >
            <option value="">Pick a mailbox...</option>
            {options.map((a) => (
              <option key={a.id} value={a.id}>{a.assignedUserName || a.address}</option>
            ))}
          </select>
        ) : (
          <button type="button" onClick={() => setPicking(true)} className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[10.5px] text-ink-muted hover:text-ink">
            <Plus size={10} /> Add
          </button>
        ))}
    </div>
  );
}

export function AccessLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[11px] text-ink-muted">
      <span className="inline-flex items-center gap-1.5"><AutoTick reason="department" /> From the Org Chart or the level - change it there</span>
      <span className="inline-flex items-center gap-1.5"><input type="checkbox" checked readOnly className="h-3.5 w-3.5 accent-[#a16a2e]" /> Shared by an admin (cross-department)</span>
      <span className="inline-flex items-center gap-1.5"><span className="rounded-full bg-warning-bg px-1.5 text-[10px] font-semibold text-warning-text">Name</span> Colleague's mailbox shared - its owner is told</span>
      <span>Management department reads the whole company.</span>
    </div>
  );
}

export type AccessChange = { at: string; by: string; who: string; change: string };

export function AccessChangeLog() {
  const q = useQuery<AccessChange[]>("/api/mail-center/access/changes", () => api.get("/api/mail-center/access/changes"));
  const rows = q.data ?? [];
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <span className="h-px w-5 bg-accent" />
        <h2 className="text-[10px] font-bold uppercase tracking-brand text-accent">Access changes</h2>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-surface shadow-stone">
        {rows.length === 0 ? (
          <p className="px-4 py-4 text-[12px] text-ink-muted">No changes yet.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {rows.map((r, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2 text-[12.5px]">
                <span className="inline-flex items-center gap-1 text-[11px] tabular-nums text-ink-muted"><Clock size={11} />{fmtDateTime(r.at)}</span>
                <span className="font-semibold text-ink">{r.by}</span>
                <span className="text-ink-secondary">{r.change}</span>
                <span className="text-ink-muted">for {r.who}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export type MailboxSync = {
  address: string;
  status: "live" | "waiting" | "failing";
  lastPulledAt: string | null;
  lastPulledLabel: string;
  threads: number;
  note: string | null;
};

const SYNC_TONE: Record<MailboxSync["status"], { tone: "success" | "warning" | "error"; label: string }> = {
  live: { tone: "success", label: "Connected" },
  waiting: { tone: "warning", label: "Waiting for Google" },
  failing: { tone: "error", label: "Cannot read" },
};

export function MailboxConnection() {
  const q = useQuery<MailboxSync[]>("/api/mail-center/sync-status", () => api.get("/api/mail-center/sync-status"));
  const rows = q.data ?? [];
  const bad = rows.filter((r) => r.status !== "live").length;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="h-px w-5 bg-accent" />
        <h2 className="text-[10px] font-bold uppercase tracking-brand text-accent">Gmail connection</h2>
        <span className="text-[11px] text-ink-muted">
          New mail arrives within seconds; every mailbox is also checked every 5 minutes.
          {bad > 0 ? ` ${bad} of ${rows.length} need attention.` : ""}
        </span>
      </div>
      <div className="overflow-x-auto rounded-md border border-border bg-surface shadow-stone">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink">
              <th className="px-4 py-2.5">Mailbox</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Last mail pulled</th>
              <th className="px-4 py-2.5 text-right">Threads</th>
              <th className="px-4 py-2.5">What to do</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.address} className="border-b border-border-subtle last:border-b-0">
                <td className="px-4 py-2.5 text-[12.5px] font-semibold text-ink">{r.address}</td>
                <td className="px-4 py-2.5"><Badge tone={SYNC_TONE[r.status].tone} size="xs">{SYNC_TONE[r.status].label}</Badge></td>
                <td className={cn("px-4 py-2.5 text-[12px] tabular-nums", r.status === "live" ? "text-ink-secondary" : "text-err")}>{r.lastPulledLabel}</td>
                <td className="px-4 py-2.5 text-right text-[12px] tabular-nums text-ink-secondary">{r.threads}</td>
                <td className="px-4 py-2.5 text-[12px] text-ink-muted">{r.note ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
