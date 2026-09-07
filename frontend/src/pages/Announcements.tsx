import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { isSalesDirectorUser } from "../auth/salesAccess";
import { cn } from "../lib/utils";
import type { TeamMember, Department, Position } from "../types";
import { useAnnouncementBanner } from "../components/useAnnouncementBanner";
import { InboxView } from "./announcements/InboxView";
import { ManageView } from "./announcements/ManageView";
import { ComposerModal } from "./announcements/ComposerModal";
import {
  bucketInbox,
  isApproved,
  receiptsCsv,
  type AckSummary,
  type AcksData,
  type Announcement,
  type Company,
  type InboxFilter,
  type NameLookups,
} from "./announcements/announcementModel";

// ────────────────────────────────────────────────────────────────────────────
// Domain types — the notice itself lives in announcements/announcementModel.ts
// (mirrors backend/src/routes/announcements.ts public shape); only the
// read-receipt payload is local to this file.
// ────────────────────────────────────────────────────────────────────────────
type CompaniesResponse = { companies?: Company[] };

type ListResponse = { success?: boolean; data?: Announcement[] };

type AcksResponse = { success?: boolean; data?: AcksData };
type SummaryResponse = { success?: boolean; data?: AckSummary };

// ────────────────────────────────────────────────────────────────────────────
// Page — two modes on one route (design handoff 2026-09-04): Reading (the
// inbox every signed-in user gets) and Manage (ack rates + drill-down, behind
// announcements.write). The selected notice is shared across both.
// ────────────────────────────────────────────────────────────────────────────
type Mode = "read" | "manage";

export function Announcements() {
  const { can, user } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  // A Sales Director may compose (owner rule 2026-07-15) even though their
  // POSITION carries no announcements.* permission — code-keyed off the org
  // chart, mirroring the backend requirePermissionOrSalesDirector admittance.
  // `salesDirOnly` = admitted purely as a Sales Director (no full grant): their
  // composer is constrained to the Sales department / a specific salesperson,
  // and they manage only the notices they authored.
  const isSalesDir = isSalesDirectorUser(user);
  const canWrite = can("announcements.write") || isSalesDir;
  const salesDirOnly = isSalesDir && !can("announcements.write");
  // The approval desk (mig 20260906T1509): Approve / Reject in Manage. Held by
  // a role, so the owner re-points it without a code change. An approver
  // without announcements.write still gets the Manage table (the queue lives
  // there) but none of the poster's actions.
  const canApprove = can("announcements.approve");
  const canOpenManage = canWrite || canApprove;
  const currentUserId = user?.id ?? null;

  // NOTE: this fetch is unbounded (no LIMIT/pagination) — the backend returns
  // every announcement. Capping it server-side is a separate follow-up.
  const listQ = useQuery<ListResponse>("/api/announcements", () => api.get("/api/announcements"));
  const items = useMemo(() => listQ.data?.data ?? [], [listQ.data]);
  // The reading inbox holds only what readers are served: a manager's own
  // pending / draft / rejected rows belong in Manage, not in their inbox.
  const inboxItems = useMemo(() => items.filter(isApproved), [items]);

  // Lookups for the audience pickers + the "To: …" resolver. All three sit
  // behind users.read on the backend, which a plain reader does not hold — and
  // since 2026-07-21 this page is open to EVERY authed user, so firing them
  // unconditionally would mean three guaranteed 403s on every ordinary
  // staffer's page load. Off, not hidden: `enabled: canWrite` means the
  // requests are never made. A reader's "To:" label falls back to the
  // server-resolved department names / counts (see audienceLabel).
  const usersQ = useQuery<{ users: TeamMember[] }>("/api/users", () => api.get("/api/users"), [], {
    enabled: canWrite,
  });
  const deptsQ = useQuery<{ departments: Department[] }>(
    "/api/departments",
    () => api.get("/api/departments"),
    [],
    { enabled: canWrite },
  );
  const positionsQ = useQuery<{ positions: Position[] }>(
    "/api/positions",
    () => api.get("/api/positions"),
    [],
    { enabled: canWrite },
  );
  // Multi-company: the company-target selector + scope chip only appear when
  // the companies master returns MORE THAN ONE company (mirrors the top-bar
  // CompanySwitcher no-op rule). Single-company Houzs shows neither.
  const companiesQ = useQuery<CompaniesResponse>("/api/companies", () =>
    api.get("/api/companies"),
  );

  const users = usersQ.data?.users ?? [];
  const depts = deptsQ.data?.departments ?? [];
  const positions = positionsQ.data?.positions ?? [];
  const companies = companiesQ.data?.companies ?? [];

  const lookups = useMemo<NameLookups>(
    () => ({
      departments: new Map(depts.map((d) => [d.id, d.name])),
      positions: new Map(positions.map((p) => [p.id, p.name])),
      users: new Map(users.map((u) => [u.id, u.name || u.email])),
    }),
    [depts, positions, users],
  );

  // What is addressed to me / what I have acked — the SAME
  // answers the mandatory modal at the app root computes, from the same
  // shared cache entry, so the inbox can never disagree with the modal.
  const banner = useAnnouncementBanner({ scope: "human" });

  // ?id=<notice> deep link (the dashboard stack's "View details" / the bell):
  // read once at mount, then the page owns the selection.
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>("read");
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get("id"));
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");

  // Default selection once the list lands: the first notice waiting on me,
  // else the newest one. Never overrides a choice the reader already made.
  useEffect(() => {
    if (selectedId && items.some((a) => a.id === selectedId)) return;
    if (items.length === 0) return;
    const b = bucketInbox({
      items,
      addressedIds: banner.addressedIds,
      ackedIds: banner.ackedIds,
      currentUserId,
      filter: "all",
      search: "",
    });
    const first = b.pending.length > 0 ? b.pending[0] : b.recent.length > 0 ? b.recent[0] : items[0];
    setSelectedId(first.id);
  }, [items, selectedId, banner.addressedIds, banner.ackedIds, currentUserId]);

  const selected = selectedId ? items.find((a) => a.id === selectedId) ?? null : null;

  // A Sales Director can manage (hide / delete / remind / view receipts) ONLY
  // the posts they authored — the backend enforces the same ownership. Full
  // announcers manage every row.
  const canManage = useCallback(
    (a: Announcement) => canWrite && (!salesDirOnly || a.createdBy === currentUserId),
    [canWrite, salesDirOnly, currentUserId],
  );

  // Read receipts for the selected notice — writers only (the endpoint is
  // gated on announcements.write; a reader never fires it).
  const receiptsEnabled = !!selected && canManage(selected);
  const receiptsQ = useQuery<AcksResponse>(
    `/api/announcements/${selected?.id ?? "-"}/acks`,
    () => api.get(`/api/announcements/${selected?.id}/acks`),
    [],
    { enabled: receiptsEnabled },
  );

  // Manage mode: one ack-rate map for the whole table, fetched only while the
  // mode is open and only for a writer (the endpoint is write-gated).
  const summaryQ = useQuery<SummaryResponse>(
    "/api/announcements/ack-summary",
    () => api.get("/api/announcements/ack-summary"),
    [],
    { enabled: canWrite && mode === "manage" },
  );
  const [drillDept, setDrillDept] = useState<string | null>(null);

  const [composerOpen, setComposerOpen] = useState(false);

  // "Notify their supervisors": one system notice per supervisor of the
  // pending people in the open department (manual escalation; the automatic
  // overdue job is a separate follow-up).
  async function escalate(a: Announcement, departmentId: number | null, departmentName: string) {
    const ok = await dialog.confirm({
      title: "Notify their supervisors",
      message: `Send each supervisor of the pending people in ${departmentName} a notice naming who has not acknowledged "${a.title}"?`,
      confirmLabel: "Notify",
    });
    if (!ok) return;
    try {
      const r = await api.post<{ supervisors: number; people: number; unsupervised: number }>(
        `/api/announcements/${a.id}/escalate`,
        departmentId == null ? {} : { departmentId },
      );
      toast.success(
        r.supervisors === 0
          ? "Nobody pending here has a supervisor on the org chart."
          : `Notified ${r.supervisors} supervisor${r.supervisors === 1 ? "" : "s"} about ${r.people} ${r.people === 1 ? "person" : "people"}${r.unsupervised ? ` (${r.unsupervised} without a supervisor)` : ""}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to notify");
    }
  }

  // "Export receipts": the selected notice's roster as CSV, built client-side
  // from the receipts already loaded for the drawer.
  function exportReceipts() {
    const a = selected;
    const acks = receiptsQ.data?.data;
    if (!a || !acks) {
      toast.error("Select a notice with loaded read receipts first");
      return;
    }
    const blob = new Blob([receiptsCsv(a, acks)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `receipts-${a.id}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function remindPending(
    a: Announcement,
    dept?: { id: number | null; name: string },
  ) {
    const pending = dept
      ? (receiptsQ.data?.data?.byDepartment?.find((d) => d.id === dept.id)?.pending ?? 0)
      : (receiptsQ.data?.data?.pending.length ?? 0);
    const ok = await dialog.confirm({
      title: dept ? `Remind ${dept.name}` : "Send reminder",
      message: `Re-pop the notice for ${pending} un-acknowledged user${
        pending === 1 ? "" : "s"
      }${dept ? ` in ${dept.name}` : ""}? Anyone who already acknowledged is unaffected.`,
      confirmLabel: "Remind",
    });
    if (!ok) return;
    try {
      const r = await api.post<{ pendingCount: number }>(
        `/api/announcements/${a.id}/remind`,
        dept ? { scope: "unacked", departmentId: dept.id } : { scope: "unacked" },
      );
      toast.success(
        `Reminder set — will re-pop for ${r.pendingCount} user${r.pendingCount === 1 ? "" : "s"}`,
      );
      listQ.reload();
      receiptsQ.reload();
      summaryQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remind");
    }
  }

  async function deleteNotice(a: Announcement) {
    const ok = await dialog.confirm({
      title: "Delete announcement",
      message: `Permanently delete "${a.title}"? Read-receipts will also be removed. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/announcements/${a.id}`);
      toast.success("Announcement deleted");
      setSelectedId(null);
      listQ.reload();
      summaryQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  async function submitNotice(a: Announcement) {
    try {
      await api.post(`/api/announcements/${a.id}/submit`, {});
      toast.success("Submitted for approval");
      listQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  }

  async function approveNotice(a: Announcement) {
    try {
      const r = await api.post<{ data?: { refNo?: string | null } | null }>(
        `/api/announcements/${a.id}/approve`,
        {},
      );
      const ref = r.data?.refNo;
      toast.success(ref ? `Approved and published as ${ref}` : "Approved and published");
      listQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  }

  async function rejectNotice(a: Announcement) {
    const reason = await dialog.prompt({
      title: "Reject announcement",
      message: `"${a.title}" goes back to its author with your reason. They can edit it and submit it again.`,
      placeholder: "What needs to change",
      confirmLabel: "Reject",
      danger: true,
      required: true,
      multiline: true,
    });
    if (reason == null || !reason.trim()) return;
    try {
      await api.post(`/api/announcements/${a.id}/reject`, { reason: reason.trim() });
      toast.success("Sent back to the author");
      listQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  }

  async function toggleHidden(a: Announcement) {
    try {
      await api.patch(`/api/announcements/${a.id}`, { isActive: !a.isActive });
      toast.success(a.isActive ? "Announcement hidden" : "Announcement shown");
      listQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  }

  const modeToggle = canOpenManage ? (
    <div
      role="tablist"
      aria-label="Announcements mode"
      className="flex rounded-md border border-border bg-surface-2 p-[2px]"
    >
      {(
        [
          ["read", "Reading"],
          ["manage", "Manage"],
        ] as Array<[Mode, string]>
      ).map(([m, label]) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          onClick={() => setMode(m)}
          className={cn(
            "rounded-[5px] px-3.5 py-1.5 text-[12px] font-[650]",
            mode === m ? "bg-primary text-white" : "text-ink-secondary hover:text-ink",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  ) : undefined;

  return (
    <div className="flex w-full flex-col">
      <PageHeader
        eyebrow="Workspace · Communications"
        title="Announcements"
        titleSize="sm"
        dense
        actions={
          <div className="flex items-center gap-2.5">
            {modeToggle}
            {canWrite && mode === "manage" && (
              <Button variant="secondary" onClick={exportReceipts}>
                Export receipts
              </Button>
            )}
          </div>
        }
        primaryAction={
          canWrite ? (
            <Button
              variant="primary"
              onClick={() => setComposerOpen(true)}
              icon={<Plus size={14} />}
            >
              New announcement
            </Button>
          ) : undefined
        }
      />

      {canWrite && composerOpen && (
        <ComposerModal
          users={users}
          departments={depts}
          companies={companies}
          salesDirOnly={salesDirOnly}
          currentUserId={currentUserId}
          onClose={() => setComposerOpen(false)}
          onPosted={() => {
            listQ.reload();
            summaryQ.reload();
            setComposerOpen(false);
          }}
        />
      )}

      {mode === "read" ? (
        /* Breaks out of the page gutters (same negative margins as the sticky
           PageHeader) so the two panes run edge to edge, and fills the viewport
           below the pinned header — each pane scrolls itself. The bottom
           margin cancels the layout's own page padding. */
        <InboxView
          className="-mx-3 -mb-[calc(10rem+env(safe-area-inset-bottom))] h-[calc(100dvh-var(--page-header-offset,120px)-1.5rem)] min-h-[480px] sm:-mx-4 lg:-mx-4 lg:-mb-10"
          items={inboxItems}
          loading={listQ.loading}
          addressedIds={banner.addressedIds}
          ackedIds={banner.ackedIds}
          currentUserId={currentUserId}
          companies={companies}
          lookups={lookups}
          selectedId={selectedId}
          onSelect={setSelectedId}
          filter={filter}
          onFilter={setFilter}
          search={search}
          onSearch={setSearch}
          canManage={canManage}
          canPostpone={banner.canPostpone}
          onAck={(a) => {
            // The receipts card is the poster's record; refresh it once the ack
            // has been posted so a manager acking their own notice sees +1.
            void banner.ack(a).then(() => {
              if (receiptsEnabled) receiptsQ.reload();
            });
          }}
          onPostpone={banner.dismissSession}
          onOpenManage={() => setMode("manage")}
          onRemindPending={(a) => void remindPending(a)}
          onHide={(a) => void toggleHidden(a)}
          receipts={receiptsQ.data?.data ?? null}
          receiptsLoading={receiptsQ.loading}
        />
      ) : (
        <ManageView
          className="-mx-3 -mb-[calc(10rem+env(safe-area-inset-bottom))] h-[calc(100dvh-var(--page-header-offset,120px)-1.5rem)] min-h-[560px] sm:-mx-4 lg:-mx-4 lg:-mb-10"
          items={items}
          loading={listQ.loading}
          summary={summaryQ.data?.data ?? null}
          addressedIds={banner.addressedIds}
          ackedIds={banner.ackedIds}
          currentUserId={currentUserId}
          lookups={lookups}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setDrillDept(null);
          }}
          filter={filter}
          onFilter={setFilter}
          search={search}
          onSearch={setSearch}
          receipts={receiptsQ.data?.data ?? null}
          receiptsLoading={receiptsQ.loading}
          drillDept={drillDept}
          onDrill={setDrillDept}
          onRemindPending={(a) => void remindPending(a)}
          onRemindDept={(a, deptId, deptName) => void remindPending(a, { id: deptId, name: deptName })}
          onEscalate={(a, deptId, deptName) => void escalate(a, deptId, deptName)}
          onToggleHidden={(a) => void toggleHidden(a)}
          onDelete={(a) => void deleteNotice(a)}
          canWrite={canWrite}
          canApprove={canApprove}
          onSubmit={(a) => void submitNotice(a)}
          onApprove={(a) => void approveNotice(a)}
          onReject={(a) => void rejectNotice(a)}
        />
      )}
    </div>
  );
}
