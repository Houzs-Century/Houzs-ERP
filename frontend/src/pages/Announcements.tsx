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
import { RegisterView } from "./announcements/RegisterView";
import { ComposerModal } from "./announcements/ComposerModal";
import {
  bucketInbox,
  isApproved,
  isVoided,
  receiptsCsv,
  type DocumentTypeOption,
  type AnnouncementFile,
  type AckSummary,
  type AcksData,
  type Announcement,
  type Company,
  type InboxFilter,
  type NameLookups,
} from "./announcements/announcementModel";

type CompaniesResponse = { companies?: Company[] };

type ListResponse = { success?: boolean; data?: Announcement[] };

type AcksResponse = { success?: boolean; data?: AcksData };
type SummaryResponse = { success?: boolean; data?: AckSummary };

// ────────────────────────────────────────────────────────────────────────────
// Page — three modes on one route: Reading (the inbox every signed-in user
// gets) and Manage (ack rates + drill-down, behind announcements.write) from
// the design handoff 2026-09-04, and Register (owner 2026-09-09: "memo — 放在
// Announcement 里面") — the department document register, open to every
// signed-in user like Reading, deep-linked as ?view=register. The selected
// notice is shared across Reading and Manage.
// ────────────────────────────────────────────────────────────────────────────
type Mode = "read" | "manage" | "register";

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
  const canApprove = can("announcements.approve");
  const canOpenManage = canWrite || canApprove;
  const currentUserId = user?.id ?? null;

  const listQ = useQuery<ListResponse>("/api/announcements", () => api.get("/api/announcements"));
  const items = useMemo(() => listQ.data?.data ?? [], [listQ.data]);
  const inboxItems = useMemo(() => items.filter((a) => isApproved(a) && !isVoided(a)), [items]);

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

  const banner = useAnnouncementBanner({ scope: "human" });

  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>(() => (searchParams.get("view") === "register" ? "register" : "read"));
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get("id"));
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");

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

  const canManage = useCallback(
    (a: Announcement) => canWrite && (!salesDirOnly || a.createdBy === currentUserId),
    [canWrite, salesDirOnly, currentUserId],
  );

  const receiptsEnabled = !!selected && canManage(selected);
  const receiptsQ = useQuery<AcksResponse>(
    `/api/announcements/${selected?.id ?? "-"}/acks`,
    () => api.get(`/api/announcements/${selected?.id}/acks`),
    [],
    { enabled: receiptsEnabled },
  );

  const filesQ = useQuery<{ data: AnnouncementFile[] }>(
    `/api/announcements/${selected?.id ?? "-"}/files`,
    () => api.get(`/api/announcements/${selected?.id}/files`),
    [],
    { enabled: !!selected && mode === "manage" && canOpenManage },
  );
  const docTypesQ = useQuery<{ data: DocumentTypeOption[] }>(
    "/api/document-types",
    () => api.get("/api/document-types"),
    [],
    { enabled: canWrite },
  );
  const attachmentRequired = (docTypesQ.data?.data ?? []).some((t) => t.code === "ANN" && t.attachmentRequired);

  const summaryQ = useQuery<SummaryResponse>(
    "/api/announcements/ack-summary",
    () => api.get("/api/announcements/ack-summary"),
    [],
    { enabled: canWrite && mode === "manage" },
  );
  const [drillDept, setDrillDept] = useState<string | null>(null);

  const [composerOpen, setComposerOpen] = useState(false);

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

  async function voidNotice(a: Announcement) {
    const reason = await dialog.prompt({
      title: "Void announcement",
      message: `"${a.title}" stops being shown to anyone and keeps its number${a.refNo ? ` (${a.refNo})` : ""}. This cannot be undone.`,
      placeholder: "Why it is being voided",
      confirmLabel: "Void",
      danger: true,
      required: true,
      multiline: true,
    });
    if (reason == null || !reason.trim()) return;
    try {
      await api.post(`/api/announcements/${a.id}/void`, { reason: reason.trim() });
      toast.success("Announcement voided");
      listQ.reload();
      summaryQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  }

  async function deleteNotice(a: Announcement) {
    const ok = await dialog.confirm({
      title: "Discard draft",
      message: `Discard the draft "${a.title}"? It was never submitted, so nothing else is affected.`,
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/announcements/${a.id}`);
      toast.success("Draft discarded");
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

  const modeToggle = (
    <div
      role="tablist"
      aria-label="Announcements mode"
      className="flex rounded-md border border-border bg-surface-2 p-[2px]"
    >
      {(
        [
          ["read", "Reading"],
          ...(canOpenManage ? [["manage", "Manage"]] : []),
          ["register", "Register"],
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
  );

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
          canWrite && mode !== "register" ? (
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
          attachmentRequired={attachmentRequired}
          docTypes={docTypesQ.data?.data ?? []}
          onClose={() => setComposerOpen(false)}
          onPosted={() => {
            listQ.reload();
            summaryQ.reload();
            setComposerOpen(false);
          }}
        />
      )}

      {mode === "read" ? (
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
      ) : mode === "manage" ? (
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
          files={filesQ.data?.data ?? null}
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
          onVoid={(a) => void voidNotice(a)}
        />
      ) : (
        <RegisterView docTypes={docTypesQ.data?.data ?? []} />
      )}
    </div>
  );
}
