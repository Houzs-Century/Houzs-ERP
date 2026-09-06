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
import { CATEGORY_META, readCategory, requiresAcknowledgement } from "../components/announcementCategory";
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

// ---------------------------------------------------------------------------
// Mobile Announcements — list + detail + compose, wired to /api/announcements.
// Presentation is ported VERBATIM from the owner's UPDATED mobile design (Houzs
// Mobile.html #m-ann / #ann-detail / #ann-new + renderAnn / annAttBig /
// annReceipts / annAck) using the .hz-m design classes (.hdr .ey .card .spill
// .tinybtn .btn .actbar .fld .fld-l .fld-i).
//
// vs the previous version: NO cover image (dropped), attachments render INLINE
// (photo grid / video / PDF rows), the audience is HIDDEN from recipients,
// publishers see READ RECEIPTS (GET /:id/acks), and the detail has an explicit
// sticky "Got it — mark as read" acknowledgement bar wired to POST /:id/ack.
//
// The banner GET (/api/announcements/banner?scope=human) returns the
// HUMAN-authored notices THIS user is allowed to see (source IS NULL — no scan /
// service-case system notices, matching the desktop Announcements page; owner
// 2026-07-20) plus the ids they've already acked; we use it for the list so
// non-admins see their own feed and honest unread dots. Compose is gated on
// announcements.write and hits POST /api/announcements. No emoji.
// ---------------------------------------------------------------------------

// Attachment / rich-media layout-hint types (mig 0140) and the inline
// attachment renderer now live in MobileAnnouncementMedia, shared with the
// pop-up so both show the same media with the same Download affordance.
type Announcement = {
  id: string;
  title: string;
  body: string;
  /** Canonical rich fragment (lib/announcementRichText.ts) or null = plain;
   *  `body` is always its plain-text shadow. */
  bodyHtml?: string | null;
  isActive: boolean;
  /** ISO instant after which the notice stops being served to readers, or NULL
   *  for "never". The phone COMPOSED without ever sending this until
   *  2026-08-21, so every notice posted from a phone ran forever. */
  expiresAt: string | null;
  createdAt: string | null;
  createdBy: number | null;
  createdByName?: string | null;
  /** Per-notice "must acknowledge" flag (mig 2026-09); absent = category rule. */
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
  // Machine translations produced ONCE on POST by the backend
  // (lib/translate-announcement.ts) into en/ms/zh/bn, stored as a JSON blob on
  // the row. NULL/absent for notices posted before translation existed, for
  // rows whose translate call failed, and — deliberately — for `bn` on every
  // row written while the 4th language was still Burmese. Every consumer must
  // go through localizeAnnouncement(), which falls back to the ORIGINAL posted
  // text in all of those cases.
  translations?: AnnouncementTranslations;
  /** Approval workflow (mig 20260906T1509); absent = APPROVED. */
  approvalStatus?: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  rejectReason?: string | null;
  /** [DEPT]-ANN-[YYMM]-[NNNN], minted on approval. */
  refNo?: string | null;
};

const APPROVAL_CHIP: Record<"DRAFT" | "PENDING_APPROVAL" | "REJECTED", { label: string; bg: string; fg: string }> = {
  DRAFT: { label: "Draft", bg: "#eceee9", fg: "#767b6e" },
  PENDING_APPROVAL: { label: "Pending approval", bg: "#fff1d6", fg: "#8a5a00" },
  REJECTED: { label: "Rejected", bg: "#fbe4e1", fg: "#a3271b" },
};
/** The approval state before anything else: an unapproved notice has no
 *  audience yet, so Live / Hidden / Expired would be a claim about nothing. */
function ApprovalChip({ ann }: { ann: Announcement }) {
  const s = ann.approvalStatus ?? "APPROVED";
  if (s === "APPROVED") return null;
  const c = APPROVAL_CHIP[s];
  return <span className="spill" style={{ background: c.bg, color: c.fg }}>{c.label}</span>;
}

// Multi-company: the company-target selector + row chip only appear when
// /api/companies returns MORE THAN ONE company (mirrors the desktop rule).
type Company = { id: number; code: string; name: string };

// Audience-picker lookups. Dept + position come from the same core endpoints the
// desktop Announcements composer uses (/api/departments, /api/positions);
// user-level targeting reuses /api/users (gated by users.read). Every field
// optional so a leaner backend never crashes the picker.
type Dept = { id: number; name: string };
type Position = { id: number; name: string; department_name?: string | null };
type UserRow = { id: number; name: string | null; email: string; status?: string | null };

type BannerResponse = {
  success?: boolean;
  data?: Announcement[];
  ackedIds?: string[];
};

// Read-receipt roster from GET /:id/acks — shown to publishers only.
type AcksResponse = {
  success?: boolean;
  data?: {
    total: number;
    ackedCount: number;
    acked: Array<{ id: number; name: string; email: string; ackedAt: string | null }>;
    pending: Array<{ id: number; name: string; email: string }>;
  };
};

// Category chip colours mirror the design's ANN_CAT map. The backend stores an
// enum; the design's labels (HR/Operations/Sales/Policy/Management) are folded
// onto our enum plus keyed by the raw label so custom categories still colour.
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

// Numeric DD/MM/YYYY (owner standard) via the shared app formatter.
const dm = (d: string | null | undefined) => formatDate(d);

const byLine = (a: Announcement) => a.createdByName?.trim() || "Management";

// annCatChip() from the design — the pill badge, colour-tinted by category.
function CatChip({ ann }: { ann: Announcement }) {
  const col = catColor(ann);
  return (
    <span className="spill" style={{ background: `${col}1f`, color: col }}>
      {catLabel(ann)}
    </span>
  );
}

/* Hidden / Expired badge, from the SHARED rule (lib/announcementStatus.ts) the
   desktop row imports too — so the two surfaces can never disagree about what
   "Expired" means. Publisher-only: a reader is never served a hidden or expired
   notice, so a chip on their card could only ever say "Live". */
function StatusChip({ ann }: { ann: Announcement }) {
  const status = announcementStatus(ann);
  if (status === "live") return null;
  return (
    <span className="spill" style={{ background: "#eceee9", color: "#767b6e" }}>
      {ANNOUNCEMENT_STATUS_LABEL[status]}
    </span>
  );
}

// Company-scope label: empty target (or covering every company) = "Both"/"All";
// a subset lists the codes. Mirrors the desktop companyScopeLabel.
function companyScopeLabel(ids: number[] | undefined, companies: Company[]): string {
  const list = ids ?? [];
  if (companies.length === 0) return "";
  if (list.length === 0 || list.length >= companies.length) {
    return companies.length === 2 ? "Both" : "All";
  }
  return list.map((id) => companies.find((co) => co.id === id)?.code ?? `#${id}`).join(" / ");
}

// A neutral company-scope chip (multi-company only), styled like .spill.
function CompanyChip({ ann, companies }: { ann: Announcement; companies: Company[] }) {
  if (companies.length <= 1) return null;
  return (
    <span className="spill" style={{ background: "#eef1ec", color: "#556052" }}>
      {companyScopeLabel(ann.targetCompanyIds, companies)}
    </span>
  );
}

// annReceipts() — publisher-only read receipts from GET /:id/acks. Progress bar
// + roster (Read / Not read) + the two Remind actions (POST /:id/remind).
// Hides itself gracefully if the roster can't be loaded. Never renders NaN.
//
// WHY THE REMIND PATH LOOKS LIKE THIS. Until 2026-08-21 it was one line —
// `api.post(url).catch(() => {}); setReminded(true);` — with no confirm, no
// body and no error path. A 403 (a Sales Director reminding on someone else's
// notice) or a 404 produced the words "Reminder sent" on the button and nothing
// else anywhere: no toast, no console line, no retry. The publisher walked away
// believing the roster had been re-popped. That is this repo's most expensive
// defect shape — a refusal that reaches nobody — and it is why every mutation
// here confirms first and then reports the SERVER's own answer, exactly as the
// desktop page does (pages/Announcements.tsx remindUnacked / remindAll).
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

  /* One code path for both scopes. `scope` is REQUIRED, never defaulted here:
     the two actions mean very different things (re-pop for the un-acked vs WIPE
     every acknowledgement and re-pop for everyone), and a default would let a
     new caller pick the destructive one by omission. The backend defaults a
     missing body to "unacked", so sending the key explicitly is also what makes
     the "all" reset possible at all — the old call sent no body, which is why
     the phone had no reset. */
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
      // Report the SERVER's count, not our own arithmetic: the backend rebuilds
      // the roster from the active users of the targeted companies, so its
      // number is the one that is true.
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
      <div className="ey" style={{ color: "#767b6e", margin: "0 2px 8px" }}>Read receipts</div>
      <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 12, padding: "12px 13px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f" }}>Read {read} / {total}</span>
          <span style={{ fontSize: 11, color: "#9aa093" }}>{pct}%</span>
        </div>
        <div style={{ height: 6, borderRadius: 6, background: "#e3e6e0", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "#2f8a5b", borderRadius: 6 }} />
        </div>
        {rows.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderTop: "1px solid #eceee9" }}>
            <span style={{ flex: 1, fontSize: 12.5, color: "#11140f" }}>{p.name}</span>
            {p.read ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "#2f8a5b" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2f8a5b" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                Read
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "#9aa093" }}>Not read</span>
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

// Which id-bucket a notice targets. ALL = everyone (back-compat default); the
// other three map 1:1 to the backend's targetDeptIds / targetPositionIds /
// targetUserIds. Mirrors the desktop composer's Bucket.
type Bucket = "ALL" | "DEPT" | "POSITION" | "USER";
const BUCKETS: Array<{ value: Bucket; label: string }> = [
  { value: "ALL", label: "All staff" },
  { value: "DEPT", label: "Departments" },
  { value: "POSITION", label: "Positions" },
  { value: "USER", label: "People" },
];

export function MobileAnnouncements({ onBack }: { onBack?: () => void }) {
  const { can, user } = useAuth();
  // Reader's chosen portal language — drives which stored translation each
  // notice renders. localizeAnnouncement() falls back to the original text.
  const lang = useMobileLang();
  // A Sales Director may compose (owner rule 2026-07-15) even without the
  // announcements.* permission — code-keyed off the org chart, mirroring the
  // backend requirePermissionOrSalesDirector admittance. `salesDirOnly` =
  // admitted purely as a Sales Director: their composer is constrained to the
  // Sales department / a specific salesperson (backend enforces).
  const isSalesDir = isSalesDirectorUser(user);
  const canCreate = can("announcements.write") || isSalesDir;
  const salesDirOnly = isSalesDir && !can("announcements.write");
  // The approval desk (mig 20260906T1509): Approve / Reject on the phone too.
  // An approver without write reads the ledger (the queue is in it).
  const canApprove = can("announcements.approve");
  const seesLedger = canCreate || canApprove;
  const qc = useQueryClient();

  const [view, setView] = useState<"list" | "detail" | "compose" | "notifications">("list");
  // Design handoff 2026-09-04 (screen 7): Needs you · All · SOP. "Needs you" =
  // mandatory + addressed to me + unacked, the same rule the desktop inbox and
  // the pop-up apply (announcementCategory.requiresAcknowledgement).
  const [filter, setFilter] = useState<"pending" | "all" | "sop">("all");
  const [ackingId, setAckingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Which surface the open notice was tapped from, so Detail's back returns there.
  const [openFrom, setOpenFrom] = useState<"list" | "notifications">("list");

  const { data, isLoading, error } = useQuery({
    // Human-authored posts only — the persistent list mirrors the desktop
    // Announcements page (source IS NULL). System scan / service-case notices
    // are excluded here (owner 2026-07-20).
    queryKey: announcementFeedKey("human"),
    queryFn: () => api.get<BannerResponse>("/api/announcements/banner?scope=human"),
    staleTime: 30_000,
  });
  /* PUBLISHER LEDGER — GET /api/announcements, the same endpoint the desktop
     page reads. Fetched ONLY for publishers, and it is what the list renders
     for them.

     WHY, and what it changes. The query above is the READER feed
     (/banner?scope=human), which the backend filters to active AND not-expired
     (announcements.ts isActiveFlag + notExpired). The phone showed nothing
     else, so a manager who hid or expired a notice could not see it on their
     phone at all — no badge, no way back, nothing to press. The nuance worth
     stating because it is NOT symmetric: the banner feed does return a Sales
     Director their OWN inactive/expired posts, so an SD saw theirs while a full
     announcements.write manager saw none of theirs. The ledger removes that
     split — both cohorts now read the surface that shows the whole picture.

     Deliberately its own query key: ANNOUNCEMENT_FEED_KEY is shared with the
     pop-up and the unread badge, which must stay READER-scoped. */
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

  // Audience-picker lookups — fetched only for publishers (they gate the
  // compose/edit UI). retry:false so a 403 on /api/users just yields [] and the
  // People bucket hides itself, rather than crashing or spamming retries.
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
  // Companies drive the compose selector + the list/detail chip — fetched for
  // everyone (cheap, cached). Empty/one company hides both controls.
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
  // Publishers read the ledger (everything, incl. hidden + expired); everyone
  // else reads their own feed. One expression so the two cannot diverge.
  const list = seesLedger ? (ledgerQ.data?.data ?? []) : readerList;
  const listLoading = seesLedger ? ledgerQ.isLoading : isLoading;
  const listError = seesLedger ? ledgerQ.error : error;
  const systemList = systemQ.data?.data ?? [];
  /* Which ids are in the READER feed. An unread dot is a statement about the
     signed-in person's own inbox, so it may only be drawn for a notice that is
     actually being served to them — otherwise every hidden / expired /
     other-audience row in a publisher's ledger would sprout a green "unread"
     dot that nobody can ever clear. */
  const readerIds = useMemo(
    () => new Set(readerList.map((a) => a.id)),
    [readerList],
  );
  // acked ids from BOTH banners; locally-acked ids clear the dot without a refetch.
  const [localAcked, setLocalAcked] = useState<Set<string>>(new Set());
  const ackedIds = useMemo(() => {
    const s = new Set<string>([...(data?.ackedIds ?? []), ...(systemQ.data?.ackedIds ?? [])]);
    for (const id of localAcked) s.add(id);
    return s;
  }, [data?.ackedIds, systemQ.data?.ackedIds, localAcked]);
  // Unread system notices drive the header bell badge.
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

  // Acknowledge from the card, without opening the notice. Same POST the
  // detail's bar and the desktop use; same optimistic-with-reconcile trade.
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

  /* Every write on this screen (publish, hide/show, delete, remind) must bust
     BOTH surfaces: the publisher ledger it renders from, and the reader feed
     shared with the pop-up and the unread badge. */
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
        // Read-receipts for any human notice this user can compose (matches the
        // desktop: a dept/person-targeted notice has a meaningful roster too). A
        // system per-user notice (any source — scan / service-case) is excluded:
        // it targets one person, so "who read it" is meaningless. The Receipts
        // panel hides itself when the roster can't be loaded (e.g. a Sales
        // Director opening a notice they didn't author — the backend 404s).
        canReceipts={canCreate && !open.source}
        /* Mirrors the desktop row's canManage: a full announcements.write
           manager may act on any human notice; a Sales-Director-only publisher
           may act on their OWN posts, which is exactly what the backend's
           sdBlockedFromRow enforces on PATCH / DELETE / remind. A system
           (scan / service-case) notice is nobody's to retract. */
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

  // Notification bell surface — the system scan / service-case notices the list
  // excludes (owner B2). Reuses the same NoticeCard + Detail + ack as the list,
  // so nothing new is styled; only the source differs (scope=system feed).
  if (view === "notifications") {
    return (
      <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
        <header className="hdr">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
            <span onClick={() => setView("list")} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#16695f", cursor: "pointer" }}>
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

  // Designer list layout (#m-ann): a header row with a hamburger "Menu" (returns
  // to the module menu via onBack) on the left and the "New" compose button on
  // the right, then the "Announcements" title below. Cards (renderAnn) are
  // buttons: a category-tinted speaker-icon tile, the title + green unread dot,
  // a category chip + byline (publisher · date), and an attachment count. The
  // category chip + attachment count come from the live wiring.
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
          {onBack ? (
            <span onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#16695f", cursor: "pointer" }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
              Menu
            </span>
          ) : <span />}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Notification bell — the system scan / service-case notices the list
                excludes live here so they still reach phone users (owner B2). */}
            <button
              onClick={() => setView("notifications")}
              aria-label={systemUnread > 0 ? `Notifications, ${systemUnread} unread` : "Notifications"}
              className="tinybtn"
              style={{ position: "relative", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", padding: "6px 9px" }}
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
                  background: on ? "var(--brand)" : "#fff",
                  color: on ? "#fff" : "#414539",
                  border: on ? "1px solid var(--brand)" : "1px solid #d6d9d2",
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

// One notice row — shared by the human LIST and the system-notice bell view so
// both render identically (owner B2). Lifted verbatim from the list's row: a
// category-tinted speaker tile, the title + green unread dot, category +
// company chips + byline, and an attachment count.
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
  /** Pending for THIS reader: the category CTA acknowledges in place (44px,
   *  the hard minimum) beside a "Read full" that opens the notice. */
  inlineAck?: { label: string; acking: boolean; onAck: () => void };
  /** Acknowledged by this reader — the card says so instead of offering a CTA. */
  confirmed?: boolean;
  /** REQUIRED, not optional: the caller has to say whether this row is being
   *  shown to a publisher (ledger — badge Hidden/Expired) or to a reader (feed
   *  — nothing to badge). An optional flag would default the publisher list
   *  back to unbadged, which is the state this fix exists to end. */
  showStatus: boolean;
  lang: Parameters<typeof localizeAnnouncement>[1];
  companies: Company[];
  onOpen: () => void;
}) {
  const na = (a.attachments ?? []).length;
  const col = catColor(a);
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 10, background: "#fff", border: `1px solid ${unread ? "#bcdcd7" : "#e3e6e0"}`, borderLeft: inlineAck ? `3px solid ${col}` : undefined, borderRadius: 13, padding: "12px 13px", fontFamily: "inherit" }}
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
          <span className="ann-row-title" style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: unread ? 800 : 700, color: "#11140f", lineHeight: 1.25 }}>{localizeAnnouncement(a, lang).title}</span>
          {unread && <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: "#16695f" }} />}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5, flexWrap: "wrap" }}>
          <CatChip ann={a} />
          {showStatus && <ApprovalChip ann={a} />}
          {showStatus && <StatusChip ann={a} />}
          <CompanyChip ann={a} companies={companies} />
          <span style={{ fontSize: 11, color: "#767b6e" }}>{byLine(a)} · {dm(a.createdAt)}</span>
        </span>
        {na > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 6, fontSize: 10.5, color: "#9aa093" }}>
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
          style={{ width: 104, height: 44, borderRadius: 10, border: "1px solid #d6d9d2", background: "#fff", color: "#414539", fontSize: 12.5, fontWeight: 650, fontFamily: "inherit", cursor: "pointer" }}
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
  /** May this caller hide / show / delete THIS notice. REQUIRED — a default
   *  would decide a permission by omission. */
  canManage: boolean;
  /** announcements.approve: Approve / Reject while the notice is pending. */
  canApprove: boolean;
  acked: boolean;
  onAcked: () => void;
  /** A write landed and the row changed: bust both feeds. */
  onChanged: () => void;
  /** The notice no longer exists: bust both feeds and leave this screen. */
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

  /* APPROVAL (mig 20260906T1509) — the same three transitions the desktop
     drawer has. Each reports the server's answer; the approve toast carries
     the reference number the server minted. */
  const transition = async (
    action: "submit" | "approve" | "reject",
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
        title: action === "approve" ? "Could not approve it" : action === "reject" ? "Could not reject it" : "Could not submit it",
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

  /* RETRACTION — hide/show + delete, the two publisher actions the phone did
     not have at all. Both report the server's refusal: this file's Remind
     button used to swallow one and claim success, and that shape is the reason
     these are written out rather than fired and forgotten. */
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

  const remove = async () => {
    if (managing) return;
    const ok = await confirm({
      title: "Delete announcement",
      body: `Permanently delete "${ann.title}"? Read-receipts go with it. This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setManaging(true);
    try {
      await api.del(`/api/announcements/${encodeURIComponent(ann.id)}`);
      onRemoved();
      await notify({ title: "Announcement deleted", body: `"${ann.title}" is gone.` });
    } catch (e) {
      await notify({
        title: "Could not delete it",
        body: e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Please try again.",
        tone: "error",
      });
      setManaging(false);
    }
  };

  const lang = useMobileLang();
  const t = useT();
  const loc = localizeAnnouncement(ann, lang);
  // Reader-driven escape hatch back to the author's own words. Reset whenever
  // the language changes so switching language never leaves you stuck looking
  // at the original with a "Show translation" button you didn't ask for.
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

  // Designer detail layout (#ann-detail): the header holds ONLY the back link;
  // the category chip + date, title, byline ("Posted by …") and body all render
  // in the scroll body (body not boxed in a card), then inline attachments,
  // publisher-only read receipts, and a sticky "Got it" ack bar.
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
          {(canManage || canApprove) && <ApprovalChip ann={ann} />}
          {canManage && approval === "APPROVED" && <StatusChip ann={ann} />}
          <CompanyChip ann={ann} companies={companies} />
          <span style={{ fontSize: 11, color: "#9aa093", alignSelf: "center" }}>{dm(ann.createdAt)}</span>
        </div>
        <div id="ann-d-title" style={{ fontSize: 21, fontWeight: 800, color: "#11140f", lineHeight: 1.25 }}>{shown.title}</div>
        <div id="ann-d-by" style={{ fontSize: 11.5, color: "#767b6e", marginTop: 6 }}>
          {ann.refNo ? `${ann.refNo} · ` : ""}Posted by {byLine(ann)}
        </div>
        {approval === "REJECTED" && ann.rejectReason && (canManage || canApprove) && (
          <div style={{ fontSize: 12, color: "#a3271b", marginTop: 6 }}>Sent back: {ann.rejectReason}</div>
        )}
        {/* When it stops showing — stated on the phone as well as the desktop,
            because "why is this still up" is a question the publisher asks from
            wherever they happen to be. */}
        {canManage && ann.expiresAt && (
          <div style={{ fontSize: 11, color: "#767b6e", marginTop: 3 }}>
            {status === "expired" ? "Hidden automatically on " : "Hides automatically on "}
            {dm(ann.expiresAt)}
          </div>
        )}

        {/* ---- Translation disclosure -------------------------------------
            A machine translation of a WORKPLACE notice must never masquerade
            as the author's own words: a mistranslated safety or pay notice is
            worse than an untranslated one. So whenever the text above is
            machine-produced we say so, and give a one-tap toggle back to the
            original the author actually wrote.
            When the reader chose a language this notice has no translation
            for, we say THAT too rather than silently serving English and
            leaving them to wonder whether they missed something. */}
        {loc.isTranslated && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, color: "#767b6e", background: "#f4f6f3", border: "1px solid #e3e6e0", borderRadius: 999, padding: "4px 9px", lineHeight: 1.5 }}>
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
          <div style={{ fontSize: 10.5, color: "#9aa093", marginTop: 10, lineHeight: 1.6 }}>
            {t("ann.noTranslation")}
          </div>
        )}

        <AnnouncementRichBody id="ann-d-body" html={shown.bodyHtml} text={shown.body} annId={ann.id} style={{ fontSize: 13.5, lineHeight: 1.7, color: "#414539", marginTop: 14 }} />
        <div id="ann-d-atts" style={{ marginTop: 16 }}>
          <Attachments ann={ann} />
        </div>
        {approval === "PENDING_APPROVAL" && canApprove && (
          <div id="ann-d-approval" style={{ marginTop: 18 }}>
            <div className="ey" style={{ color: "#767b6e", margin: "0 2px 8px" }}>Approval</div>
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
          <div style={{ fontSize: 12, color: "#767b6e", marginTop: 18 }}>
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
            <div className="ey" style={{ color: "#767b6e", margin: "0 2px 8px" }}>Publisher</div>
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
                disabled={managing}
                className="tinybtn"
                style={{ flex: 1, padding: 9, color: "var(--red)", opacity: managing ? 0.6 : 1, cursor: managing ? "default" : "pointer" }}
              >
                Delete
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

// Compose (create) an announcement. Audience targeting is real: dept +
// position always available; People (user ids) only when /api/users is readable.
function Compose({
  lookups,
  salesDirOnly,
  onClose,
  onPublished,
}: {
  lookups: Lookups;
  /** Composer opened by a Sales-Director-only caller: audience is constrained
   *  to the whole Sales department OR a specific salesperson in it (owner rule).
   *  The dept / user lookups are already server-scoped to their department. */
  salesDirOnly: boolean;
  onClose: () => void;
  onPublished: () => void;
}) {
  const { user } = useAuth();

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(CATEGORY_OPTIONS[0].value);
  const [bucket, setBucket] = useState<Bucket>(salesDirOnly ? "DEPT" : "ALL");
  // Company target: "ALL" = every company (Both — sends no target, NULL = all);
  // a company id = that company only. Default "ALL". Only shown when >1 company.
  const [companyPick, setCompanyPick] = useState<"ALL" | number>("ALL");
  const [selDepts, setSelDepts] = useState<Set<number>>(new Set());
  const [selPositions, setSelPositions] = useState<Set<number>>(new Set());
  const [selUsers, setSelUsers] = useState<Set<number>>(new Set());
  const [userSearch, setUserSearch] = useState("");
  const [body, setBody] = useState("");
  /* Wall-clock "YYYY-MM-DDTHH:mm" — DateTimeField's own wire shape, shared with
     the desktop composer. Empty = never expires, which is the backend default
     and the pre-2026-08-21 mobile behaviour, so leaving the field alone changes
     nothing for anyone. */
  const [expiresAt, setExpiresAt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  // Rich-media layout hint (mig 0140). "" photo = auto (derive from count);
  // video defaults to a 1x1 square. Only surfaced when the media is attached.
  const [photoLayout, setPhotoLayout] = useState<PhotoLayout | "">("");
  const [videoLayout, setVideoLayout] = useState<VideoLayout>("1x1");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // One key per opened composer (the phone keeps no draft): a retry of this
  // sheet's post — double tap, "Couldn't save" then Publish again — is
  // answered by the server with the row the first request made, never a
  // second one (mig 20260907T0010; the desktop composer keys its draft).
  const clientKey = useIdempotencyKey();

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

  // Sales Director: default the "Sales Department" bucket to their own
  // department (the lookups already return only it), so posting with no manual
  // pick still targets the whole Sales dept + satisfies the DEPT validation.
  // Seeded once so a later deselect isn't fought.
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
    setErr(null);
    setSaving(true);
    try {
      // Two-step upload manifest: PUT each file to the 'compose' scope, collect
      // {r2Key, mime} entries. A failed upload is skipped rather than blocking.
      // WO-7: shared pipeline — compresses images + uploads their thumbs.
      const uploaded: Attachment[] = [];
      for (const f of files) {
        try {
          const manifest = await uploadAnnouncementAttachment(f);
          if (manifest?.r2Key) {
            uploaded.push({ r2Key: manifest.r2Key, name: manifest.name, mime: manifest.mime, size: manifest.size });
          }
        } catch {
          /* skip this file; publish the rest. */
        }
      }

      // Real audience targeting — one bucket at a time (mirrors desktop). ALL
      // sends no target arrays (backend derives ALL_USERS). Empty arrays on a
      // non-selected bucket keep the other buckets from being wiped on edit.
      // Rich body (same editor as the desktop composer): `bodyHtml` is the
      // canonical fragment, `body` its plain shadow; the server re-derives the
      // latter and stores NULL html when nothing was actually formatted.
      const payload: Record<string, unknown> = {
        title: t,
        body: richTextToPlain(body),
        bodyHtml: body,
        category,
        clientKey,
      };
      if (bucket === "DEPT") payload.targetDeptIds = Array.from(selDepts);
      if (bucket === "POSITION") payload.targetPositionIds = Array.from(selPositions);
      if (bucket === "USER") payload.targetUserIds = Array.from(selUsers);
      // Company target: a single company sends [id]; "Both"/ALL omits the field
      // (backend stores NULL = all companies).
      if (companyPick !== "ALL") payload.targetCompanyIds = [companyPick];
      /* Expiry, sent EXACTLY as the desktop composer sends it
         (pages/Announcements.tsx): a local wall-clock value converted to an ISO
         instant, and the key omitted entirely when blank so the row keeps NULL
         = never. Mobile sent this key on no path at all until 2026-08-21, which
         is why a notice posted from a phone could not be given an end date and
         then could not be taken down from the phone either. */
      if (expiresAt) payload.expiresAt = new Date(expiresAt).toISOString();
      payload.attachments = uploaded;
      // Media layout — only hints for media actually uploaded. Empty photo pick
      // stays absent so the renderer derives a count default.
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
  // Sales Director: only two audiences — the whole Sales department, or a
  // specific salesperson in it. Everyone else keeps the full bucket set.
  const baseBuckets: Array<{ value: Bucket; label: string }> = salesDirOnly
    ? [
        { value: "DEPT", label: "Sales Department" },
        { value: "USER", label: "Specific salesperson" },
      ]
    : BUCKETS;
  // People bucket only offered when the directory is readable.
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
        <div style={{ display: "flex", alignItems: "flex-start", gap: 9, background: "#f3ece0", border: "1px solid #e8dcc5", borderRadius: 11, padding: "10px 11px", marginBottom: 14 }}>
          <svg width="15" height="15" style={{ flex: "none", marginTop: 1 }} viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z" /></svg>
          <div style={{ fontSize: 11, color: "#5a3a14", lineHeight: 1.5 }}>
            <b>Publishing rights:</b> Management, HR &amp; department leads. You're posting as <b>{poster}</b>. Every notice goes live only once an approver signs it off.
          </div>
        </div>

        <label className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Category</span>
          <select className="fld-i" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

        {/* Company target — only when more than one company exists. Hidden for
            a Sales Director (they post within their own department only). */}
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
                    style={{ padding: "7px 13px", background: on ? "var(--brand)" : "#fff", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Audience targeting — bucket selector + the matching id picker. */}
        <div className="fld-l" style={{ margin: "0 2px 7px" }}>Send to</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
          {buckets.map((b) => {
            const on = bucket === b.value;
            return (
              <button
                key={b.value}
                onClick={() => setBucket(b.value)}
                className="tinybtn"
                style={{ padding: "7px 13px", background: on ? "var(--brand)" : "#fff", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}
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
        <div style={{ fontSize: 10.5, color: "#9aa093", margin: "8px 2px 12px" }}>
          {bucket === "ALL"
            ? "Everyone sees this announcement."
            : "Only the people you pick see it — the audience isn't shown to recipients."}
        </div>

        <label className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Title</span>
          <input className="fld-i" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Announcement title" maxLength={200} />
        </label>
        {/* A div, not a <label>: a contenteditable box is not labelable, so a
            label wrapper would only steal the first tap. */}
        <div className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Body</span>
          <AnnouncementRichEditor value={body} onChange={setBody} placeholder="Write the announcement…" minHeight={120} disabled={saving} />
        </div>

        {/* Expiry — the same control and the same label as the desktop
            composer, and the SHARED DateTimeField rather than a native
            datetime-local, so the date half stays DD/MM/YYYY on a phone whose
            OS is not day-first. Optional by design: blank = never expires. */}
        <div className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Hide automatically after</span>
          <DateTimeField
            fullWidth
            aria-label="Hide automatically after"
            className="fld-i"
            value={expiresAt}
            onChange={setExpiresAt}
          />
          <span style={{ fontSize: 10.5, color: "#9aa093", marginTop: 5 }}>
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
        <div style={{ fontSize: 10.5, color: "#9aa093", marginTop: 8 }}>
          Attach photos, video or PDF — recipients view them inline and tap to download.
        </div>

        {files.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #e3e6e0", borderRadius: 9, padding: "7px 10px" }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "#11140f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                <span style={{ fontSize: 10.5, color: "#9aa093" }}>{fmtSize(f.size)}</span>
                <span onClick={() => removeFile(i)} style={{ fontSize: 16, color: "#b23a3a", cursor: "pointer", lineHeight: 1 }}>×</span>
              </div>
            ))}
          </div>
        )}

        {/* Layout hints — mirror the desktop composer. Only shown for the media
            actually attached. */}
        {(hasPhotos || hasVideos) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 12, background: "#fff", border: "1px solid var(--line)", borderRadius: 11, padding: "11px 12px" }}>
            {hasPhotos && (
              <div>
                <div className="fld-l" style={{ marginBottom: 6 }}>Photo layout</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["", "1", "2", "3", "4"] as Array<PhotoLayout | "">).map((val) => {
                    const on = photoLayout === val;
                    return (
                      <button key={val || "auto"} onClick={() => setPhotoLayout(val)} className="tinybtn" style={{ padding: "6px 12px", background: on ? "var(--brand)" : "#fff", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}>
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
                      <button key={val} onClick={() => setVideoLayout(val)} className="tinybtn" style={{ padding: "6px 12px", background: on ? "var(--brand)" : "#fff", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}>
                        {val === "1x1" ? "1 x 1 (square)" : "1 x 2 (portrait)"}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {err && <div style={{ fontSize: 12, color: "#b23a3a", marginTop: 10 }}>{err}</div>}
      </div>

      <footer className="actbar">
        <button onClick={publish} disabled={saving} className="btn" style={{ cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Submit for approval"}
        </button>
      </footer>
    </div>
  );
}

// A scrollable, bordered checkbox list used by every audience picker.
function PickerBox({ empty, children }: { empty: string | null; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 12, maxHeight: 220, overflowY: "auto" }}>
      {empty ? (
        <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "18px 0" }}>{empty}</div>
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
        {sub && <span style={{ display: "block", fontSize: 10.5, color: "#9aa093", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</span>}
      </span>
    </label>
  );
}
