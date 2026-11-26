import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { uploadAnnouncementAttachment } from "../lib/announcementAttachmentUpload";
import {
  ANNOUNCEMENT_FEED_KEY,
  announcementFeedKey,
} from "../components/useAnnouncementBanner";
import {
  Attachments,
  fmtSize,
  type AnnAttachment as Attachment,
  type AnnMediaLayout as MediaLayout,
  type PhotoLayout,
  type VideoLayout,
} from "./MobileAnnouncementMedia";
import { MobileVirtualList } from "./MobileVirtualList";
import { AnnouncementRichBody } from "../components/AnnouncementRichBody";
import { CATEGORY_META, docTypeForCategory, readCategory, requiresAcknowledgement } from "../components/announcementCategory";
import { AnnouncementRichEditor } from "../components/AnnouncementRichEditor";
import { richTextToPlain } from "../lib/announcementRichText";
import { useIdempotencyKey } from "../lib/idempotency";
import { useAuth } from "../auth/AuthContext";
import { isSalesDirectorUser } from "../auth/salesAccess";
import { formatDate } from "../lib/utils";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import { DateTimeField } from "../vendor/scm/components/DateTimeField";
import {
  ANNOUNCEMENT_STATUS_LABEL,
  announcementStatus,
} from "../lib/announcementStatus";
import {
  type AnnouncementTranslations,
  localizeAnnouncement,
  useMobileLang,
  useT,
} from "./mobileI18n";
import "./mobile.css";


type Announcement = {
  id: string;
  title: string;
  body: string;
  bodyHtml?: string | null;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string | null;
  createdBy: number | null;
  createdByName?: string | null;
  requireAck?: boolean | null;
  remindedAt: string | null;
  updatedAt: string | null;
  attachments: Attachment[];
  mediaLayout?: MediaLayout;
  targetType: string;
  targetDeptIds?: number[];
  targetPositionIds?: number[];
  targetUserIds?: number[];
  targetCompanyIds?: number[];
  category: string;
  source?: string | null;
  translations?: AnnouncementTranslations;
  approvalStatus?: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  rejectReason?: string | null;
  refNo?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  docType?: string | null;
};

const APPROVAL_CHIP: Record<"DRAFT" | "PENDING_APPROVAL" | "REJECTED", { label: string; bg: string; fg: string }> = {
  DRAFT: { label: "Draft", bg: "#eceee9", fg: "#767b6e" },
  PENDING_APPROVAL: { label: "Pending approval", bg: "#fff1d6", fg: "#8a5a00" },
  REJECTED: { label: "Rejected", bg: "#fbe4e1", fg: "#a3271b" },
};
function ApprovalChip({ ann }: { ann: Announcement }) {
  if (ann.voidedAt) return <span className="spill" style={{ background: "var(--hz-dk-surface-2, #eceee9)", color: "var(--hz-c-ink-muted)", textDecoration: "line-through" }}>Voided</span>;
  const s = ann.approvalStatus ?? "APPROVED";
  if (s === "APPROVED") return null;
  const c = APPROVAL_CHIP[s];
  return <span className="spill" style={{ background: c.bg, color: c.fg }}>{c.label}</span>;
}

type Company = { id: number; code: string; name: string };

type Dept = { id: number; name: string; code?: string | null };
type Position = { id: number; name: string; department_name?: string | null };
type UserRow = { id: number; name: string | null; email: string; status?: string | null };

type BannerResponse = {
  success?: boolean;
  data?: Announcement[];
  ackedIds?: string[];
};

type AcksResponse = {
  success?: boolean;
  data?: {
    total: number;
    ackedCount: number;
    acked: Array<{ id: number; name: string; email: string; ackedAt: string | null }>;
    pending: Array<{ id: number; name: string; email: string }>;
  };
};

const CATEGORY_LABEL: Record<string, string> = {
  GENERAL: "General",
  WARNING: "Warning",
  SOP: "SOP",
  LEARNING: "Learning",
};

const CAT_COLOR: Record<string, string> = {
  General: "#475569",
  HR: "#7a5c86",
  Operations: "#0e7490",
  Sales: "#15803d",
  Policy: "#b45309",
  Management: "#a16a2e",
  Warning: "#b45309",
  SOP: "#0e7490",
  Learning: "#7a5c86",
};

const catLabel = (a: Announcement) => CATEGORY_LABEL[a.category] ?? a.category ?? "General";
const catColor = (a: Announcement) => CAT_COLOR[catLabel(a)] ?? "#475569";

const dm = (d: string | null | undefined) => formatDate(d);

const byLine = (a: Announcement) => a.createdByName?.trim() || "Management";

function CatChip({ ann }: { ann: Announcement }) {
  const col = catColor(ann);
  return (
    <span className="spill" style={{ background: `${col}1f`, color: col }}>
      {catLabel(ann)}
    </span>
  );
}

function StatusChip({ ann }: { ann: Announcement }) {
  const status = announcementStatus(ann);
  if (status === "live") return null;
  return (
    <span className="spill" style={{ background: "var(--hz-dk-surface-2, #eceee9)", color: "var(--hz-c-ink-muted)" }}>
      {ANNOUNCEMENT_STATUS_LABEL[status]}
    </span>
  );
}

function companyScopeLabel(ids: number[] | undefined, companies: Company[]): string {
  const list = ids ?? [];
  if (companies.length === 0) return "";
  if (list.length === 0 || list.length >= companies.length) {
    return companies.length === 2 ? "Both" : "All";
  }
  return list.map((id) => companies.find((co) => co.id === id)?.code ?? `#${id}`).join(" / ");
}

function CompanyChip({ ann, companies }: { ann: Announcement; companies: Company[] }) {
  if (companies.length <= 1) return null;
  return (
    <span className="spill" style={{ background: "var(--hz-dk-surface-2, #eef1ec)", color: "#556052" }}>
      {companyScopeLabel(ann.targetCompanyIds, companies)}
    </span>
  );
}

function Receipts({ ann }: { ann: Announcement }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const { data } = useQuery({
    queryKey: ["announcement-acks", ann.id],
    queryFn: () => api.get<AcksResponse>(`/api/announcements/${encodeURIComponent(ann.id)}/acks`),
    staleTime: 15_000,
  });
  const [busy, setBusy] = useState(false);

  const r = data?.data;
  if (!r) return null;
  const total = r.total ?? 0;
  const read = r.ackedCount ?? 0;
  const pct = total > 0 ? Math.round((read / total) * 100) : 0;
  const rows = [
    ...r.acked.map((p) => ({ id: `a-${p.id}`, name: p.name || p.email || "—", read: true })),
    ...r.pending.map((p) => ({ id: `p-${p.id}`, name: p.name || p.email || "—", read: false })),
  ];
  const unread = Math.max(total - read, 0);

  const remind = async (scope: "unacked" | "all") => {
    if (busy) return;
    const ok = await confirm(
      scope === "all"
        ? {
            title: "Reset all read-receipts",
            body: `Wipe acknowledgements and re-pop for ALL ${total} active user${total === 1 ? "" : "s"}? Everyone, including those who already acknowledged, will see it again.`,
            confirmLabel: "Reset and remind",
            danger: true,
          }
        : {
            title: "Send reminder",
            body: `Re-pop the notice for ${unread} un-acknowledged user${unread === 1 ? "" : "s"}? Anyone who already tapped Got it is unaffected.`,
            confirmLabel: "Remind",
          },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.post<{ pendingCount?: number }>(
        `/api/announcements/${encodeURIComponent(ann.id)}/remind`,
        { scope },
      );
      const n = res.pendingCount ?? 0;
      await notify({
        title: scope === "all" ? "Read-receipts reset" : "Reminder sent",
        body: `It will re-pop for ${n} user${n === 1 ? "" : "s"}.`,
      });
      void qc.invalidateQueries({ queryKey: ["announcement-acks", ann.id] });
      void qc.invalidateQueries({ queryKey: ANNOUNCEMENT_FEED_KEY });
    } catch (e) {
      await notify({
        title: "Reminder NOT sent",
        body: e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Please try again.",
        tone: "error",
      });
    }
    setBusy(false);
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div className="ey" style={{ color: "var(--hz-c-ink-muted)", margin: "0 2px 8px" }}>Read receipts</div>
      <div style={{ background: "var(--hz-c-surface)", border: "1px solid var(--hz-c-border-subtle)", borderRadius: 12, padding: "12px 13px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--hz-c-ink)" }}>Read {read} / {total}</span>
          <span style={{ fontSize: 11, color: "var(--hz-c-ink-soft)" }}>{pct}%</span>
        </div>
        <div style={{ height: 6, borderRadius: 6, background: "var(--hz-c-surface-dim)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "#2f8a5b", borderRadius: 6 }} />
        </div>
        {rows.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderTop: "1px solid #eceee9" }}>
            <span style={{ flex: 1, fontSize: 12.5, color: "var(--hz-c-ink)" }}>{p.name}</span>
            {p.read ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "var(--hz-c-synced)" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2f8a5b" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                Read
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "var(--hz-c-ink-soft)" }}>Not read</span>
            )}
          </div>
        ))}
        {unread > 0 && (
          <button
            onClick={() => void remind("unacked")}
            disabled={busy}
            className="tinybtn"
            style={{ marginTop: 10, width: "100%", padding: 9, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}
          >
            {`Remind ${unread} who haven't read`}
          </button>
        )}
        {total > 0 && (
          <button
            onClick={() => void remind("all")}
            disabled={busy}
            className="tinybtn"
            style={{ marginTop: 8, width: "100%", padding: 9, color: "var(--red)", opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}
          >
            Reset all read-receipts and re-pop
          </button>
        )}
      </div>
    </div>
  );
}

const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "GENERAL", label: "General" },
  { value: "WARNING", label: "Warning" },
  { value: "SOP", label: "SOP" },
  { value: "LEARNING", label: "Learning" },
];

type Bucket = "ALL" | "DEPT" | "POSITION" | "USER";
const BUCKETS: Array<{ value: Bucket; label: string }> = [
  { value: "ALL", label: "All staff" },
  { value: "DEPT", label: "Departments" },
  { value: "POSITION", label: "Positions" },
  { value: "USER", label: "People" },
];

export function MobileAnnouncements({ onBack }: { onBack?: () => void }) {
  const { can, user } = useAuth();
  const lang = useMobileLang();
  // A Sales Director may compose (owner rule 2026-07-15) even without the
  // announcements.* permission — code-keyed off the org chart, mirroring the
  // backend requirePermissionOrSalesDirector admittance. `salesDirOnly` =
  // admitted purely as a Sales Director: their composer is constrained to the
  // Sales department / a specific salesperson (backend enforces).
  const isSalesDir = isSalesDirectorUser(user);
  const canCreate = can("announcements.write") || isSalesDir;
  const salesDirOnly = isSalesDir && !can("announcements.write");
  const canApprove = can("announcements.approve");
  const seesLedger = canCreate || canApprove;
  const qc = useQueryClient();

  const [view, setView] = useState<"list" | "detail" | "compose" | "notifications">("list");
  const [filter, setFilter] = useState<"pending" | "all" | "sop">("all");
  const [ackingId, setAckingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openFrom, setOpenFrom] = useState<"list" | "notifications">("list");

  const { data, isLoading, error } = useQuery({
    // Human-authored posts only — the persistent list mirrors the desktop
    // Announcements page (source IS NULL). System scan / service-case notices
    // are excluded here (owner 2026-07-20).
    queryKey: announcementFeedKey("human"),
    queryFn: () => api.get<BannerResponse>("/api/announcements/banner?scope=human"),
    staleTime: 30_000,
  });
  const ledgerQ = useQuery({
    queryKey: ["mobile-ann-ledger"],
    queryFn: () => api.get<BannerResponse>("/api/announcements"),
    enabled: seesLedger,
    staleTime: 30_000,
  });
  // System notices (scan / service-case) — the ACTIONABLE per-user notices the
  // list above excludes. Surfaced via the header bell so they still reach phone
  // users (owner 2026-07-20 B2). Same /banner shape + ack model as the list.
  const systemQ = useQuery({
    queryKey: announcementFeedKey("system"),
    queryFn: () => api.get<BannerResponse>("/api/announcements/banner?scope=system"),
    staleTime: 30_000,
  });

  const deptsQ = useQuery({
    queryKey: ["mobile-ann-depts"],
    queryFn: () => api.get<{ departments: Dept[] }>("/api/departments"),
    enabled: canCreate,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const positionsQ = useQuery({
    queryKey: ["mobile-ann-positions"],
    queryFn: () => api.get<{ positions: Position[] }>("/api/positions"),
    enabled: canCreate,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const usersQ = useQuery({
    queryKey: ["mobile-ann-users"],
    queryFn: () => api.get<{ users: UserRow[] }>("/api/users"),
    enabled: canCreate,
    staleTime: 60_000,
    retry: false,
  });
  const companiesQ = useQuery({
    queryKey: ["mobile-ann-companies"],
    queryFn: () => api.get<{ companies: Company[] }>("/api/companies"),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const companies = companiesQ.data?.companies ?? [];
  const lookups = {
    depts: deptsQ.data?.departments ?? [],
    positions: positionsQ.data?.positions ?? [],
    users: (usersQ.data?.users ?? []).filter((u) => (u.status ?? "active") === "active"),
    usersDenied: !!usersQ.error,
    companies,
  };

  const readerList = data?.data ?? [];
  const list = seesLedger ? (ledgerQ.data?.data ?? []) : readerList;
  const listLoading = seesLedger ? ledgerQ.isLoading : isLoading;
  const listError = seesLedger ? ledgerQ.error : error;
  const systemList = systemQ.data?.data ?? [];
  const readerIds = useMemo(
    () => new Set(readerList.map((a) => a.id)),
    [readerList],
  );
  const [localAcked, setLocalAcked] = useState<Set<string>>(new Set());
  const ackedIds = useMemo(() => {
    const s = new Set<string>([...(data?.ackedIds ?? []), ...(systemQ.data?.ackedIds ?? [])]);
    for (const id of localAcked) s.add(id);
    return s;
  }, [data?.ackedIds, systemQ.data?.ackedIds, localAcked]);
  const systemUnread = systemList.reduce((n, a) => (ackedIds.has(a.id) ? n : n + 1), 0);

  const open = [...list, ...systemList].find((a) => a.id === openId) ?? null;

  const isPendingForMe = (a: Announcement) =>
    readerIds.has(a.id) && !ackedIds.has(a.id) && requiresAcknowledgement({ category: readCategory(a.category), requireAck: a.requireAck ?? null });
  const pendingCount = list.reduce((n, a) => (isPendingForMe(a) ? n + 1 : n), 0);
  const shownList =
    filter === "pending"
      ? list.filter(isPendingForMe)
      : filter === "sop"
        ? list.filter((a) => readCategory(a.category) === "SOP")
        : list;

  const ackInline = async (a: Announcement) => {
    if (ackingId) return;
    setAckingId(a.id);
    try {
      await api.post(`/api/announcements/${encodeURIComponent(a.id)}/ack`);
    } catch {
      /* silent-write-ok: OPTIMISTIC WITH RECONCILE — see Detail.ack above. */
    }
    setLocalAcked((prev) => new Set(prev).add(a.id));
    setAckingId(null);
    refreshFeeds();
  };

  const refreshFeeds = () => {
    void qc.invalidateQueries({ queryKey: ANNOUNCEMENT_FEED_KEY });
    void qc.invalidateQueries({ queryKey: ["mobile-ann-ledger"] });
  };

  const markAcked = (id: string) => {
    setLocalAcked((prev) => new Set(prev).add(id));
    qc.invalidateQueries({ queryKey: ["announcement-acks", id] });
  };

  if (view === "compose" && canCreate) {
    return (
      <Compose
        lookups={lookups}
        salesDirOnly={salesDirOnly}
        onClose={() => setView("list")}
        onPublished={() => {
          refreshFeeds();
          setView("list");
        }}
      />
    );
  }

  if (view === "detail" && open) {
    return (
      <Detail
        ann={open}
        companies={companies}
        canReceipts={canCreate && !open.source}
        canManage={canCreate && !open.source && (!salesDirOnly || open.createdBy === (user?.id ?? null))}
        canApprove={canApprove && !open.source}
        acked={ackedIds.has(open.id)}
        onAcked={() => markAcked(open.id)}
        onChanged={refreshFeeds}
        onRemoved={() => { refreshFeeds(); setOpenId(null); setView(openFrom); }}
        onBack={() => setView(openFrom)}
      />
    );
  }

  if (view === "notifications") {
    return (
      <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
        <header className="hdr">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
            <span onClick={() => setView("list")} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--hz-c-primary)", cursor: "pointer" }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
              Announcements
            </span>
            <span />
          </div>
          <div className="scr-title">Notifications</div>
        </header>
        <div className="scroll hz-scroll" style={{ padding: 12, paddingBottom: 120 }}>
          {systemQ.isLoading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
          {systemQ.error && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn't load notifications. Pull to retry.</div>}
          {!systemQ.isLoading && !systemQ.error && (
            systemList.length > 0 ? (
              <MobileVirtualList
                items={systemList}
                getKey={(a) => a.id}
                estimateHeight={72}
                gap={9}
                renderItem={(a) => (
                  <NoticeCard
                    a={a}
                    unread={!ackedIds.has(a.id)}
                    showStatus={false}
                    lang={lang}
                    companies={companies}
                    onOpen={() => {
                      setOpenId(a.id);
                      setOpenFrom("notifications");
                      setView("detail");
                    }}
                  />
                )}
              />
            ) : (
              <div className="empty">
                <div className="empty-t">You're all caught up</div>
                <div className="empty-s">New service cases and scan results appear here.</div>
              </div>
            )
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
          {onBack ? (
            <span onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--hz-c-primary)", cursor: "pointer" }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
              Menu
            </span>
          ) : <span />}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => setView("notifications")}
              aria-label={systemUnread > 0 ? `Notifications, ${systemUnread} unread` : "Notifications"}
              className="tinybtn"
              style={{ position: "relative", background: "var(--hz-c-surface)", display: "flex", alignItems: "center", justifyContent: "center", padding: "6px 9px" }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
              {systemUnread > 0 && (
                <span style={{ position: "absolute", top: -5, right: -5, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 9, background: "var(--red)", color: "#fff", fontSize: 10, fontWeight: 800, lineHeight: "16px", textAlign: "center", boxSizing: "border-box" }}>
                  {systemUnread > 9 ? "9+" : systemUnread}
                </span>
              )}
            </button>
            {canCreate && (
              <button onClick={() => setView("compose")} className="tinybtn" style={{ background: "var(--brand)", borderColor: "var(--brand)", color: "#fff", display: "flex", alignItems: "center", gap: 5 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
                New
              </button>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="scr-title">Announcements</div>
          {pendingCount > 0 && (
            <span aria-label={`${pendingCount} pending`} style={{ borderRadius: 999, background: "var(--red)", color: "#fff", padding: "2px 9px", fontSize: 11, fontWeight: 700 }}>
              {pendingCount}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", marginTop: 10 }}>
          {(
            [
              ["pending", pendingCount > 0 ? `Needs you ${pendingCount}` : "Needs you"],
              ["all", "All"],
              ["sop", "SOP"],
            ] as Array<["pending" | "all" | "sop", string]>
          ).map(([id, label]) => {
            const on = filter === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                aria-pressed={on}
                style={{
                  borderRadius: 999,
                  padding: "6px 13px",
                  fontSize: 12,
                  fontWeight: on ? 650 : 600,
                  whiteSpace: "nowrap",
                  fontFamily: "inherit",
                  cursor: "pointer",
                  background: on ? "var(--brand)" : "var(--hz-c-surface)",
                  color: on ? "#fff" : "var(--hz-c-ink-secondary)",
                  border: on ? "1px solid var(--brand)" : "1px solid var(--hz-c-border)",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 12, paddingBottom: 120 }}>
        {listLoading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {listError && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn't load announcements. Pull to retry.</div>}
        {!listLoading && !listError && (
          <>
            {shownList.length > 0 && (
              <MobileVirtualList
                items={shownList}
                getKey={(a) => a.id}
                estimateHeight={72}
                gap={9}
                renderItem={(a) => (
                  <NoticeCard
                    a={a}
                    unread={readerIds.has(a.id) && !ackedIds.has(a.id)}
                    showStatus={seesLedger}
                    lang={lang}
                    companies={companies}
                    onOpen={() => {
                      setOpenId(a.id);
                      setOpenFrom("list");
                      setView("detail");
                    }}
                    inlineAck={
                      isPendingForMe(a)
                        ? { label: CATEGORY_META[readCategory(a.category)].ctaLabel, acking: ackingId === a.id, onAck: () => void ackInline(a) }
                        : undefined
                    }
                    confirmed={readerIds.has(a.id) && ackedIds.has(a.id)}
                  />
                )}
              />
            )}
            {!shownList.length && (
              <div className="empty">
                <div className="empty-t">{filter === "pending" ? "Nothing needs you" : filter === "sop" ? "No SOPs yet" : "No announcements yet"}</div>
                <div className="empty-s">{filter === "pending" ? "Every mandatory notice is acknowledged." : "Notices from HQ will appear here."}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NoticeCard({
  a,
  unread,
  showStatus,
  lang,
  companies,
  onOpen,
  inlineAck,
  confirmed,
}: {
  a: Announcement;
  unread: boolean;
  inlineAck?: { label: string; acking: boolean; onAck: () => void };
  confirmed?: boolean;
  showStatus: boolean;
  lang: Parameters<typeof localizeAnnouncement>[1];
  companies: Company[];
  onOpen: () => void;
}) {
  const na = (a.attachments ?? []).length;
  const col = catColor(a);
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 10, background: "var(--hz-c-surface)", border: `1px solid ${unread ? "#bcdcd7" : "#e3e6e0"}`, borderLeft: inlineAck ? `3px solid ${col}` : undefined, borderRadius: 13, padding: "12px 13px", fontFamily: "inherit" }}
    >
    <button
      onClick={onOpen}
      style={{ display: "flex", alignItems: "flex-start", gap: 11, width: "100%", textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}
    >
      <span style={{ width: 36, height: 36, flex: "none", borderRadius: 10, background: `${col}1f`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={col} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z" /><path d="M16 8a4 4 0 0 1 0 8" /></svg>
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="ann-row-title" style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: unread ? 800 : 700, color: "var(--hz-c-ink)", lineHeight: 1.25 }}>{localizeAnnouncement(a, lang).title}</span>
          {unread && <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: "var(--hz-c-primary)" }} />}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5, flexWrap: "wrap" }}>
          <CatChip ann={a} />
          {showStatus && <ApprovalChip ann={a} />}
          {showStatus && <StatusChip ann={a} />}
          <CompanyChip ann={a} companies={companies} />
          <span style={{ fontSize: 11, color: "var(--hz-c-ink-muted)" }}>{byLine(a)} · {dm(a.createdAt)}</span>
        </span>
        {na > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 6, fontSize: 10.5, color: "var(--hz-c-ink-soft)" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8 12 17a4 4 0 0 1-6-6l9-9a3 3 0 0 1 4 4l-9 9" /></svg>
            {na} attachment{na > 1 ? "s" : ""}
          </span>
        )}
      </span>
    </button>
    {inlineAck && (
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={inlineAck.onAck}
          disabled={inlineAck.acking}
          style={{ flex: 1, height: 44, borderRadius: 10, border: "none", background: col, color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: inlineAck.acking ? "default" : "pointer", opacity: inlineAck.acking ? 0.6 : 1 }}
        >
          {inlineAck.acking ? "Marking…" : inlineAck.label}
        </button>
        <button
          type="button"
          onClick={onOpen}
          style={{ width: 104, height: 44, borderRadius: 10, border: "1px solid var(--hz-c-border)", background: "var(--hz-c-surface)", color: "var(--hz-c-ink-secondary)", fontSize: 12.5, fontWeight: 650, fontFamily: "inherit", cursor: "pointer" }}
        >
          Read full
        </button>
      </div>
    )}
    {!inlineAck && confirmed && (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 650, color: "var(--green)" }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        Confirmed
      </span>
    )}
    </div>
  );
}

function Detail({
  ann,
  companies,
  canReceipts,
  canManage,
  canApprove,
  acked,
  onAcked,
  onChanged,
  onRemoved,
  onBack,
}: {
  ann: Announcement;
  companies: Company[];
  canReceipts: boolean;
  canManage: boolean;
  canApprove: boolean;
  acked: boolean;
  onAcked: () => void;
  onChanged: () => void;
  onRemoved: () => void;
  onBack: () => void;
}) {
  const [localAck, setLocalAck] = useState(acked);
  const [acking, setAcking] = useState(false);
  const [managing, setManaging] = useState(false);
  const confirm = useConfirm();
  const notify = useNotify();
  const promptFor = usePrompt();
  const isAcked = acked || localAck;
  const status = announcementStatus(ann);
  const approval = ann.approvalStatus ?? "APPROVED";

  const transition = async (
    action: "submit" | "approve" | "reject" | "void",
    body: Record<string, unknown>,
    done: (data: { refNo?: string | null } | null) => { title: string; body: string },
  ) => {
    if (managing) return;
    setManaging(true);
    try {
      const r = await api.post<{ data?: { refNo?: string | null } | null }>(
        `/api/announcements/${encodeURIComponent(ann.id)}/${action}`,
        body,
      );
      onChanged();
      await notify(done(r.data ?? null));
    } catch (e) {
      await notify({
        title:
          action === "approve"
            ? "Could not approve it"
            : action === "reject"
              ? "Could not reject it"
              : action === "void"
                ? "Could not void it"
                : "Could not submit it",
        body: e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Please try again.",
        tone: "error",
      });
    }
    setManaging(false);
  };
  const submit = () =>
    transition("submit", {}, () => ({ title: "Submitted for approval", body: "It goes live once an approver signs it off." }));
  const approve = () =>
    transition("approve", {}, (d) => ({
      title: "Approved and published",
      body: d?.refNo ? `Reference ${d.refNo}. It is live for its audience now.` : "It is live for its audience now.",
    }));
  const reject = async () => {
    if (managing) return;
    const reason = await promptFor({
      title: "Reject announcement",
      body: "It goes back to its author with your reason. They can edit it and submit it again.",
      placeholder: "What needs to change",
      confirmLabel: "Reject",
      multiline: true,
      validate: (v) => (v.trim() ? null : "A reason is required."),
    });
    if (reason == null || !reason.trim()) return;
    await transition("reject", { reason: reason.trim() }, () => ({ title: "Sent back to the author", body: "They have been told why." }));
  };

  const setActive = async (next: boolean) => {
    if (managing) return;
    setManaging(true);
    try {
      await api.patch(`/api/announcements/${encodeURIComponent(ann.id)}`, { isActive: next });
      onChanged();
      await notify({
        title: next ? "Announcement shown" : "Announcement hidden",
        body: next
          ? "It is being served to its audience again."
          : "Nobody will be served it until you show it again.",
      });
    } catch (e) {
      await notify({
        title: next ? "Could not show it" : "Could not hide it",
        body: e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Please try again.",
        tone: "error",
      });
    }
    setManaging(false);
  };

  const isDraft = (ann.approvalStatus ?? "APPROVED") === "DRAFT";
  const remove = async () => {
    if (managing) return;
    if (!isDraft) {
      const reason = await promptFor({
        title: "Void announcement",
        body: `"${ann.title}" stops being shown to anyone and keeps its number. This cannot be undone.`,
        placeholder: "Why it is being voided",
        confirmLabel: "Void",
        multiline: true,
        validate: (v) => (v.trim() ? null : "A reason is required."),
      });
      if (reason == null || !reason.trim()) return;
      await transition("void", { reason: reason.trim() }, () => ({ title: "Announcement voided", body: "It is no longer shown to anyone." }));
      return;
    }
    const ok = await confirm({
      title: "Discard draft",
      body: `Discard the draft "${ann.title}"? It was never submitted.`,
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
    setManaging(true);
    try {
      await api.del(`/api/announcements/${encodeURIComponent(ann.id)}`);
      onRemoved();
      await notify({ title: "Draft discarded", body: `"${ann.title}" is gone.` });
    } catch (e) {
      await notify({
        title: "Could not discard it",
        body: e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Please try again.",
        tone: "error",
      });
      setManaging(false);
    }
  };

  const lang = useMobileLang();
  const t = useT();
  const loc = localizeAnnouncement(ann, lang);
  const [showOriginal, setShowOriginal] = useState(false);
  useEffect(() => { setShowOriginal(false); }, [lang, ann.id]);
  const shown = showOriginal
    ? { title: ann.title, body: ann.body, bodyHtml: ann.bodyHtml ?? null }
    : { title: loc.title, body: loc.body, bodyHtml: loc.bodyHtml };

  const ack = async () => {
    if (isAcked || acking) return;
    setAcking(true);
    try {
      await api.post(`/api/announcements/${encodeURIComponent(ann.id)}/ack`);
    } catch {
      /* silent-write-ok: OPTIMISTIC WITH RECONCILE — same trade as the desktop
         banner (components/useAnnouncementBanner.ts). The tap is reflected so a
         failing server cannot strand the reader on a must-acknowledge notice;
         the feed reconciles on the next load. The read-receipt list does not. */
    }
    setLocalAck(true);
    setAcking(false);
    onAcked();
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center" }}>
          <button onClick={onBack} className="back">
            <span className="chev">‹</span> Announcements
          </button>
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        <div id="ann-d-meta" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
          <CatChip ann={ann} />
          {ann.docType && ann.docType !== "ANN" && <span className="spill" style={{ background: "var(--hz-dk-surface-2, #eceee9)", color: "#4b5046" }}>{ann.docType}</span>}
          {(canManage || canApprove) && <ApprovalChip ann={ann} />}
          {canManage && approval === "APPROVED" && <StatusChip ann={ann} />}
          <CompanyChip ann={ann} companies={companies} />
          <span style={{ fontSize: 11, color: "var(--hz-c-ink-soft)", alignSelf: "center" }}>{dm(ann.createdAt)}</span>
        </div>
        <div id="ann-d-title" style={{ fontSize: 21, fontWeight: 800, color: "var(--hz-c-ink)", lineHeight: 1.25 }}>{shown.title}</div>
        <div id="ann-d-by" style={{ fontSize: 11.5, color: "var(--hz-c-ink-muted)", marginTop: 6 }}>
          {ann.refNo ? `${ann.refNo} · ` : ""}Posted by {byLine(ann)}
        </div>
        {approval === "REJECTED" && ann.rejectReason && (canManage || canApprove) && (
          <div style={{ fontSize: 12, color: "#a3271b", marginTop: 6 }}>Sent back: {ann.rejectReason}</div>
        )}
        {ann.voidedAt && (canManage || canApprove) && (
          <div style={{ fontSize: 12, color: "var(--hz-c-ink-muted)", marginTop: 6 }}>Voided: {ann.voidReason ?? "no reason recorded"}</div>
        )}
        {canManage && ann.expiresAt && (
          <div style={{ fontSize: 11, color: "var(--hz-c-ink-muted)", marginTop: 3 }}>
            {status === "expired" ? "Hidden automatically on " : "Hides automatically on "}
            {dm(ann.expiresAt)}
          </div>
        )}

        {loc.isTranslated && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, color: "var(--hz-c-ink-muted)", background: "var(--hz-c-surface-2)", border: "1px solid var(--hz-c-border-subtle)", borderRadius: 999, padding: "4px 9px", lineHeight: 1.5 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#767b6e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" /></svg>
              {t("ann.autoTranslated")}
            </span>
            <button
              type="button"
              className="tinybtn"
              onClick={() => setShowOriginal((v) => !v)}
            >
              {showOriginal ? t("ann.showTranslated") : t("ann.showOriginal")}
            </button>
          </div>
        )}
        {!loc.isTranslated && lang !== "en" && (
          <div style={{ fontSize: 10.5, color: "var(--hz-c-ink-soft)", marginTop: 10, lineHeight: 1.6 }}>
            {t("ann.noTranslation")}
          </div>
        )}

        <AnnouncementRichBody id="ann-d-body" html={shown.bodyHtml} text={shown.body} annId={ann.id} style={{ fontSize: 13.5, lineHeight: 1.7, color: "var(--hz-c-ink-secondary)", marginTop: 14 }} />
        <div id="ann-d-atts" style={{ marginTop: 16 }}>
          <Attachments ann={ann} />
        </div>
        {approval === "PENDING_APPROVAL" && canApprove && (
          <div id="ann-d-approval" style={{ marginTop: 18 }}>
            <div className="ey" style={{ color: "var(--hz-c-ink-muted)", margin: "0 2px 8px" }}>Approval</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => void approve()}
                disabled={managing}
                className="btn"
                style={{ flex: 1, padding: 9, opacity: managing ? 0.6 : 1, cursor: managing ? "default" : "pointer" }}
              >
                Approve &amp; publish
              </button>
              <button
                onClick={() => void reject()}
                disabled={managing}
                className="tinybtn"
                style={{ flex: 1, padding: 9, color: "var(--red)", opacity: managing ? 0.6 : 1, cursor: managing ? "default" : "pointer" }}
              >
                Reject…
              </button>
            </div>
          </div>
        )}
        {approval === "PENDING_APPROVAL" && !canApprove && canManage && (
          <div style={{ fontSize: 12, color: "var(--hz-c-ink-muted)", marginTop: 18 }}>
            Waiting for an approver. Nobody is served it until it is approved.
          </div>
        )}
        {(approval === "DRAFT" || approval === "REJECTED") && canManage && (
          <div id="ann-d-submit" style={{ marginTop: 18 }}>
            <button
              onClick={() => void submit()}
              disabled={managing}
              className="btn"
              style={{ width: "100%", padding: 9, opacity: managing ? 0.6 : 1, cursor: managing ? "default" : "pointer" }}
            >
              Submit for approval
            </button>
          </div>
        )}
        {canManage && (
          <div id="ann-d-manage" style={{ marginTop: 18 }}>
            <div className="ey" style={{ color: "var(--hz-c-ink-muted)", margin: "0 2px 8px" }}>Publisher</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => void setActive(!ann.isActive)}
                disabled={managing}
                className="tinybtn"
                style={{ flex: 1, padding: 9, opacity: managing ? 0.6 : 1, cursor: managing ? "default" : "pointer" }}
              >
                {ann.isActive ? "Hide" : "Show"}
              </button>
              <button
                onClick={() => void remove()}
                disabled={managing || !!ann.voidedAt}
                className="tinybtn"
                style={{ flex: 1, padding: 9, color: "var(--red)", opacity: managing || ann.voidedAt ? 0.6 : 1, cursor: managing ? "default" : "pointer" }}
              >
                {ann.voidedAt ? "Voided" : isDraft ? "Discard draft" : "Void…"}
              </button>
            </div>
          </div>
        )}
        {canReceipts && (
          <div id="ann-d-receipts" style={{ marginTop: 18 }}>
            <Receipts ann={ann} />
          </div>
        )}
      </div>

      <footer className="actbar" id="ann-d-ackbar">
        {isAcked ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, fontSize: 13, fontWeight: 700, color: "var(--green)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            You acknowledged this
          </div>
        ) : (
          <button onClick={ack} disabled={acking} className="btn" style={{ cursor: acking ? "default" : "pointer", opacity: acking ? 0.6 : 1 }}>
            {acking ? "Marking…" : "Got it — mark as read"}
          </button>
        )}
      </footer>
    </div>
  );
}

type Lookups = { depts: Dept[]; positions: Position[]; users: UserRow[]; usersDenied: boolean; companies: Company[] };

function Compose({
  lookups,
  salesDirOnly,
  onClose,
  onPublished,
}: {
  lookups: Lookups;
  salesDirOnly: boolean;
  onClose: () => void;
  onPublished: () => void;
}) {
  const { user } = useAuth();

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(CATEGORY_OPTIONS[0].value);
  const [docType, setDocType] = useState("ANN");
  const docTypesQ = useQuery({
    queryKey: ["document-types"],
    queryFn: () => api.get<{ data: Array<{ code: string; label: string; attachmentRequired: boolean }> }>("/api/document-types"),
    staleTime: 300_000,
  });
  const docTypeOptions = useMemo(() => docTypesQ.data?.data ?? [], [docTypesQ.data]);
  // The type follows the category (docTypeForCategory, owner 2026-09-09)
  // until the writer picks one by hand — the same rule the desktop applies.
  const [typeTouched, setTypeTouched] = useState(false);
  useEffect(() => {
    if (typeTouched) return;
    setDocType(docTypeForCategory(readCategory(category), docTypeOptions));
  }, [category, typeTouched, docTypeOptions]);
  const [numberDeptId, setNumberDeptId] = useState<number | null>(null);
  const [bucket, setBucket] = useState<Bucket>(salesDirOnly ? "DEPT" : "ALL");
  const [companyPick, setCompanyPick] = useState<"ALL" | number>("ALL");
  const [selDepts, setSelDepts] = useState<Set<number>>(new Set());
  const [selPositions, setSelPositions] = useState<Set<number>>(new Set());
  const [selUsers, setSelUsers] = useState<Set<number>>(new Set());
  const [userSearch, setUserSearch] = useState("");
  const [body, setBody] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [photoLayout, setPhotoLayout] = useState<PhotoLayout | "">("");
  const [videoLayout, setVideoLayout] = useState<VideoLayout>("1x1");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const clientKey = useIdempotencyKey();

  const numberDept = numberDeptId == null ? null : (lookups.depts.find((d) => d.id === numberDeptId) ?? null);
  const numberDeptCode = numberDept?.code ?? null;
  const nextQ = useQuery({
    queryKey: ["document-refs-next", docType, numberDeptCode],
    queryFn: () =>
      api.get<{ data?: { refNo?: string } | null; reason?: string }>(
        `/api/document-refs/next?typeCode=${encodeURIComponent(docType)}${numberDeptCode ? `&deptCode=${encodeURIComponent(numberDeptCode)}` : ""}`,
      ),
    enabled: numberDeptId == null || !!numberDeptCode,
    staleTime: 10_000,
  });
  const nextRefNo = nextQ.data?.data?.refNo ?? null;
  const nextReason =
    numberDeptId != null && !numberDeptCode
      ? `${numberDept?.name ?? "That department"} has no department code yet, so a notice cannot be numbered under it. Set one under Team → Departments.`
      : nextQ.data && !nextRefNo
        ? (nextQ.data.reason ?? null)
        : null;
  const pickedType = docTypeOptions.find((t) => t.code === docType) ?? null;
  const missingAttachment = !!pickedType?.attachmentRequired && files.length === 0;

  const hasPhotos = files.some((f) => (f.type || "").startsWith("image/"));
  const hasVideos = files.some((f) => (f.type || "").startsWith("video/"));

  const addFiles = (picked: FileList | null) => {
    if (!picked || !picked.length) return;
    setFiles((prev) => [...prev, ...Array.from(picked)]);
  };
  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const toggle = (set: Set<number>, id: number): Set<number> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return lookups.users;
    return lookups.users.filter(
      (u) => (u.name ?? "").toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q),
    );
  }, [lookups.users, userSearch]);

  const seededDeptRef = useRef(false);
  useEffect(() => {
    if (
      salesDirOnly &&
      !seededDeptRef.current &&
      bucket === "DEPT" &&
      lookups.depts.length > 0
    ) {
      seededDeptRef.current = true;
      setSelDepts(new Set(lookups.depts.map((d) => d.id)));
    }
  }, [salesDirOnly, bucket, lookups.depts]);

  const publish = async () => {
    if (saving) return;
    const t = title.trim();
    if (!t) {
      setErr("Title is required.");
      return;
    }
    if (bucket === "DEPT" && selDepts.size === 0) { setErr("Pick at least one department, or choose All staff."); return; }
    if (bucket === "POSITION" && selPositions.size === 0) { setErr("Pick at least one position, or choose All staff."); return; }
    if (bucket === "USER" && selUsers.size === 0) { setErr("Pick at least one person, or choose All staff."); return; }
    if (missingAttachment) { setErr(`A ${pickedType.label} must carry its file (Settings → Documents). Attach one first.`); return; }
    setErr(null);
    setSaving(true);
    try {
      const uploaded: Attachment[] = [];
      for (const f of files) {
        try {
          const manifest = await uploadAnnouncementAttachment(f);
          if (manifest?.r2Key) {
            uploaded.push({ r2Key: manifest.r2Key, name: manifest.name, mime: manifest.mime, size: manifest.size });
          }
        } catch {
        }
      }

      const payload: Record<string, unknown> = {
        title: t,
        body: richTextToPlain(body),
        bodyHtml: body,
        docType,
        category,
        clientKey,
        ...(numberDeptId != null ? { numberDeptId } : {}),
      };
      if (bucket === "DEPT") payload.targetDeptIds = Array.from(selDepts);
      if (bucket === "POSITION") payload.targetPositionIds = Array.from(selPositions);
      if (bucket === "USER") payload.targetUserIds = Array.from(selUsers);
      if (companyPick !== "ALL") payload.targetCompanyIds = [companyPick];
      if (expiresAt) payload.expiresAt = new Date(expiresAt).toISOString();
      payload.attachments = uploaded;
      const upPhotos = uploaded.some((a) => (a.mime || "").startsWith("image/"));
      const upVideos = uploaded.some((a) => (a.mime || "").startsWith("video/"));
      const mediaLayout: { photo?: PhotoLayout; video?: VideoLayout } = {};
      if (upPhotos && photoLayout) mediaLayout.photo = photoLayout;
      if (upVideos) mediaLayout.video = videoLayout;
      if (mediaLayout.photo || mediaLayout.video) payload.mediaLayout = mediaLayout;
      await api.post("/api/announcements", payload);
      onPublished();
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Couldn't save. Try again.");
      setSaving(false);
    }
  };

  const poster = user?.name?.trim() || "your account";
  const baseBuckets: Array<{ value: Bucket; label: string }> = salesDirOnly
    ? [
        { value: "DEPT", label: "Sales Department" },
        { value: "USER", label: "Specific salesperson" },
      ]
    : BUCKETS;
  const buckets = lookups.usersDenied
    ? baseBuckets.filter((b) => b.value !== "USER")
    : baseBuckets;
  const companyOptions: Array<["ALL" | number, string]> = [
    ["ALL", "Both"],
    ...lookups.companies.map((co) => [co.id, co.name] as ["ALL" | number, string]),
  ];

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <div className="eyebrow">Compose</div>
            <div className="scr-title">New announcement</div>
          </div>
          <span onClick={onClose} style={{ fontSize: 24, color: "var(--mut)", cursor: "pointer", lineHeight: 1 }}>×</span>
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 9, background: "var(--hz-c-accent-soft)", border: "1px solid #e8dcc5", borderRadius: 11, padding: "10px 11px", marginBottom: 14 }}>
          <svg width="15" height="15" style={{ flex: "none", marginTop: 1 }} viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z" /></svg>
          <div style={{ fontSize: 11, color: "var(--hz-c-accent-ink)", lineHeight: 1.5 }}>
            <b>Publishing rights:</b> Management, HR &amp; department leads. You're posting as <b>{poster}</b>. Every notice goes live only once an approver signs it off.
          </div>
        </div>

        <label className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Category</span>
          <select className="fld-i" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {/* Numbering (owner 2026-09-09): the family the number is minted as
            (follows the category until picked by hand), the department it is
            minted under, the number itself (previewed), and the picked type's
            attachment policy. Mirrors the desktop composer. */}
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <label className="fld" style={{ flex: 1, minWidth: 0 }}>
            <span className="fld-l">Numbered as</span>
            <select
              className="fld-i"
              value={docType}
              onChange={(e) => {
                setTypeTouched(true);
                setDocType(e.target.value);
              }}
              aria-label="Document type"
              disabled={docTypeOptions.length <= 1}
            >
              {docTypeOptions.length === 0 && <option value={docType}>{docType}</option>}
              {docTypeOptions.map((t) => <option key={t.code} value={t.code}>{t.label} ({t.code})</option>)}
            </select>
          </label>
          <label className="fld" style={{ flex: 1, minWidth: 0 }}>
            <span className="fld-l">Numbered under</span>
            <select
              className="fld-i"
              value={numberDeptId ?? ""}
              onChange={(e) => setNumberDeptId(e.target.value ? Number(e.target.value) : null)}
              aria-label="Numbered under"
            >
              <option value="">My department</option>
              {lookups.depts.map((d) => <option key={d.id} value={d.id}>{d.name}{d.code ? ` (${d.code})` : " — no code"}</option>)}
            </select>
          </label>
        </div>
        {(nextRefNo || nextReason) && (
          <div style={{ fontSize: 11.5, color: "#5b6159", margin: "0 2px 12px", lineHeight: 1.45 }} data-testid="ref-no-preview">
            {nextRefNo ? (
              <>Number on approval: <b style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", color: "var(--ink)" }}>{nextRefNo}</b></>
            ) : (
              nextReason
            )}
          </div>
        )}
        {missingAttachment && (
          <div style={{ fontSize: 11.5, color: "var(--hz-c-accent)", margin: "0 2px 12px", lineHeight: 1.45 }} data-testid="attachment-required-hint">
            A {pickedType.label} must carry its file (Settings → Documents) — attach one below before submitting.
          </div>
        )}

        {lookups.companies.length > 1 && !salesDirOnly && (
          <>
            <div className="fld-l" style={{ margin: "0 2px 7px" }}>Company</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
              {companyOptions.map(([key, label]) => {
                const on = companyPick === key;
                return (
                  <button
                    key={String(key)}
                    onClick={() => setCompanyPick(key)}
                    className="tinybtn"
                    style={{ padding: "7px 13px", background: on ? "var(--brand)" : "var(--hz-c-surface)", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="fld-l" style={{ margin: "0 2px 7px" }}>Send to</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
          {buckets.map((b) => {
            const on = bucket === b.value;
            return (
              <button
                key={b.value}
                onClick={() => setBucket(b.value)}
                className="tinybtn"
                style={{ padding: "7px 13px", background: on ? "var(--brand)" : "var(--hz-c-surface)", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}
              >
                {b.label}
              </button>
            );
          })}
        </div>

        {bucket === "DEPT" && (
          <PickerBox empty={lookups.depts.length === 0 ? "No departments" : null}>
            {lookups.depts.map((d) => (
              <CheckRow key={d.id} label={d.name} checked={selDepts.has(d.id)} onToggle={() => setSelDepts((s) => toggle(s, d.id))} />
            ))}
          </PickerBox>
        )}
        {bucket === "POSITION" && (
          <PickerBox empty={lookups.positions.length === 0 ? "No positions" : null}>
            {lookups.positions.map((p) => (
              <CheckRow
                key={p.id}
                label={p.name}
                sub={p.department_name ?? undefined}
                checked={selPositions.has(p.id)}
                onToggle={() => setSelPositions((s) => toggle(s, p.id))}
              />
            ))}
          </PickerBox>
        )}
        {bucket === "USER" && (
          <>
            <input
              className="fld-i"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Search people…"
              style={{ marginBottom: 8 }}
            />
            <PickerBox empty={filteredUsers.length === 0 ? "No people" : null}>
              {filteredUsers.map((u) => (
                <CheckRow
                  key={u.id}
                  label={u.name || u.email.split("@")[0]}
                  sub={u.email}
                  checked={selUsers.has(u.id)}
                  onToggle={() => setSelUsers((s) => toggle(s, u.id))}
                />
              ))}
            </PickerBox>
          </>
        )}
        <div style={{ fontSize: 10.5, color: "var(--hz-c-ink-soft)", margin: "8px 2px 12px" }}>
          {bucket === "ALL"
            ? "Everyone sees this announcement."
            : "Only the people you pick see it — the audience isn't shown to recipients."}
        </div>

        <label className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Title</span>
          <input className="fld-i" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Announcement title" maxLength={200} />
        </label>
        <div className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Body</span>
          <AnnouncementRichEditor value={body} onChange={setBody} placeholder="Write the announcement…" minHeight={120} disabled={saving} />
        </div>

        <div className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Hide automatically after</span>
          <DateTimeField
            fullWidth
            aria-label="Hide automatically after"
            className="fld-i"
            value={expiresAt}
            onChange={setExpiresAt}
          />
          <span style={{ fontSize: 10.5, color: "var(--hz-c-ink-soft)", marginTop: 5 }}>
            Leave empty and it stays up until you hide it.
          </span>
        </div>

        <div className="fld-l" style={{ margin: "6px 0 7px" }}>Attachments</div>
        <div style={{ display: "flex", gap: 9 }}>
          <label className="tinybtn" style={{ flex: 1, padding: 11, textAlign: "center", cursor: "pointer" }}>
            + Photo / Video
            <input type="file" accept="image/*,video/*" multiple style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </label>
          <label className="tinybtn" style={{ flex: 1, padding: 11, textAlign: "center", cursor: "pointer" }}>
            + Document
            <input type="file" accept="application/pdf,.pdf" multiple style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--hz-c-ink-soft)", marginTop: 8 }}>
          Attach photos, video or PDF — recipients view them inline and tap to download.
        </div>

        {files.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--hz-c-border-subtle)", borderRadius: 9, padding: "7px 10px" }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--hz-c-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                <span style={{ fontSize: 10.5, color: "var(--hz-c-ink-soft)" }}>{fmtSize(f.size)}</span>
                <span onClick={() => removeFile(i)} style={{ fontSize: 16, color: "var(--hz-c-err)", cursor: "pointer", lineHeight: 1 }}>×</span>
              </div>
            ))}
          </div>
        )}

        {(hasPhotos || hasVideos) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 12, background: "var(--hz-c-surface)", border: "1px solid var(--line)", borderRadius: 11, padding: "11px 12px" }}>
            {hasPhotos && (
              <div>
                <div className="fld-l" style={{ marginBottom: 6 }}>Photo layout</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["", "1", "2", "3", "4"] as Array<PhotoLayout | "">).map((val) => {
                    const on = photoLayout === val;
                    return (
                      <button key={val || "auto"} onClick={() => setPhotoLayout(val)} className="tinybtn" style={{ padding: "6px 12px", background: on ? "var(--brand)" : "var(--hz-c-surface)", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}>
                        {val === "" ? "Auto" : val}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {hasVideos && (
              <div>
                <div className="fld-l" style={{ marginBottom: 6 }}>Video layout</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["1x1", "1x2"] as VideoLayout[]).map((val) => {
                    const on = videoLayout === val;
                    return (
                      <button key={val} onClick={() => setVideoLayout(val)} className="tinybtn" style={{ padding: "6px 12px", background: on ? "var(--brand)" : "var(--hz-c-surface)", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}>
                        {val === "1x1" ? "1 x 1 (square)" : "1 x 2 (portrait)"}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {err && <div style={{ fontSize: 12, color: "var(--hz-c-err)", marginTop: 10 }}>{err}</div>}
      </div>

      <footer className="actbar">
        <button onClick={publish} disabled={saving || missingAttachment} className="btn" style={{ cursor: saving || missingAttachment ? "default" : "pointer", opacity: saving || missingAttachment ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Submit for approval"}
        </button>
      </footer>
    </div>
  );
}

function PickerBox({ empty, children }: { empty: string | null; children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--hz-c-surface)", border: "1px solid var(--line)", borderRadius: 12, maxHeight: 220, overflowY: "auto" }}>
      {empty ? (
        <div style={{ textAlign: "center", color: "var(--hz-c-ink-soft)", fontSize: 12, padding: "18px 0" }}>{empty}</div>
      ) : (
        children
      )}
    </div>
  );
}

function CheckRow({ label, sub, checked, onToggle }: { label: string; sub?: string; checked: boolean; onToggle: () => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", cursor: "pointer", borderTop: "1px solid #eceee9" }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ width: 18, height: 18, accentColor: "var(--brand)", flex: "none" }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {sub && <span style={{ display: "block", fontSize: 10.5, color: "var(--hz-c-ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</span>}
      </span>
    </label>
  );
}
