// Mail Center admin pieces kept out of MailboxesTab.tsx (owner 2026-11-21): the
// Org Chart cell, the access change log, and each mailbox's newest received mail.
import { Building2, Clock } from "lucide-react";
import { Badge } from "../components/Badge";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { ListSkeleton } from "../components/Skeleton";
import { fmtDateTime } from "../../../shared/src/vendor/shared/format";
import type { Department, TeamMember } from "../types";
import { fetchSyncStatus, type MailboxSync } from "./MailCenter/mail-actions";

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

const QUIET_DAYS = 3;

export function syncState(r: MailboxSync, now: number): "live" | "waiting" | "quiet" | "never" {
  if (r.pending) return "waiting";
  if (!r.lastInboundAt) return "never";
  return now - Date.parse(r.lastInboundAt) > QUIET_DAYS * 86_400_000 ? "quiet" : "live";
}

const SYNC_TONE = {
  live: { tone: "success", label: "Receiving", todo: null },
  waiting: { tone: "warning", label: "Waiting for Google", todo: "Add the address in Google Admin, then mark it added on Team, Mailboxes" },
  quiet: { tone: "warning", label: `No mail in ${QUIET_DAYS} days`, todo: "Check the account is still synced (alias of a synced account, or its own login)" },
  never: { tone: "error", label: "No mail yet", todo: "Not connected: make it an alias of a synced account, or connect its login" },
} as const;

export function MailboxConnection() {
  const q = useQuery<MailboxSync[]>("/api/mail-center/sync-status", () => fetchSyncStatus());
  const rows = q.data ?? [];
  const now = Date.now();
  const bad = rows.filter((r) => syncState(r, now) !== "live").length;
  return (
    <section>
      <p className="mb-3 max-w-[80ch] text-[12px] text-ink-muted">
        The newest mail each mailbox has received in the ERP. The ERP cannot look inside Gmail, so a mailbox that never
        received anything is shown as not connected.{rows.length > 0 ? ` ${bad} of ${rows.length} need attention.` : ""}
      </p>
      {q.loading && !q.data ? (
        <ListSkeleton rows={5} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-surface shadow-stone">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink">
                <th className="px-4 py-2.5">Mailbox</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Newest mail received</th>
                <th className="px-4 py-2.5 text-right">Threads</th>
                <th className="px-4 py-2.5">What to do</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = SYNC_TONE[syncState(r, now)];
                return (
                  <tr key={r.address} className="border-b border-border-subtle last:border-b-0">
                    <td className="px-4 py-2.5 text-[12.5px] font-semibold text-ink">{r.address}</td>
                    <td className="px-4 py-2.5"><Badge tone={st.tone} size="xs">{st.label}</Badge></td>
                    <td className="px-4 py-2.5 text-[12px] tabular-nums text-ink-secondary">{r.lastInboundAt ? fmtDateTime(r.lastInboundAt) : "never"}</td>
                    <td className="px-4 py-2.5 text-right text-[12px] tabular-nums text-ink-secondary">{r.threads}</td>
                    <td className="px-4 py-2.5 text-[12px] text-ink-muted">{st.todo ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
