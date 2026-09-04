import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Megaphone,
  Send,
  Trash2,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  BellRing,
  Users as UsersIcon,
  Paperclip,
  Plus,
  X,
  ImageIcon,
  Video,
  FileText,
  File as FileIcon,
  AlertTriangle,
  BookOpen,
  ShieldCheck,
  Globe,
  Building2,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { uploadAnnouncementAttachment } from "../lib/announcementAttachmentUpload";
import { useAuth } from "../auth/AuthContext";
import { isSalesDirectorUser } from "../auth/salesAccess";
import { cn, relativeTime } from "../lib/utils";
import type { TeamMember, Department, Position } from "../types";
import {
  AnnouncementMedia,
  type PhotoLayout,
  type VideoLayout,
  type AnnMediaLayout,
} from "../components/AnnouncementMedia";
import { fmtDateTime } from "../vendor/shared/format";
import { DateTimeField } from "../vendor/scm/components/DateTimeField";
import { AnnouncementRichBody } from "../components/AnnouncementRichBody";
import { AnnouncementRichEditor } from "../components/AnnouncementRichEditor";
import { richTextToPlain } from "../lib/announcementRichText";
import {
  ANNOUNCEMENT_STATUS_LABEL,
  announcementStatus,
} from "../lib/announcementStatus";

// ────────────────────────────────────────────────────────────────────────────
// Domain types — mirrors backend/src/routes/announcements.ts public shape.
// ────────────────────────────────────────────────────────────────────────────
type Attachment = {
  r2Key: string;
  name: string;
  mime: string;
  size?: number;
};

type TargetType =
  | "ALL_USERS"
  | "DEPARTMENT_IDS"
  | "POSITION_IDS"
  | "USER_IDS"
  | "MIXED";

type AnnouncementCategory = "GENERAL" | "WARNING" | "SOP" | "LEARNING";

type Announcement = {
  id: string;
  title: string;
  body: string;
  /** Canonical rich fragment, or null for a plain notice (see
   *  lib/announcementRichText.ts). `body` is always its plain-text shadow. */
  bodyHtml?: string | null;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string | null;
  createdBy: number | null;
  remindedAt: string | null;
  updatedAt: string | null;
  attachments?: Attachment[];
  mediaLayout?: AnnMediaLayout;
  targetType?: TargetType;
  targetDeptIds?: number[];
  targetPositionIds?: number[];
  targetUserIds?: number[];
  targetCompanyIds?: number[];
  category?: AnnouncementCategory;
};

type Company = { id: number; code: string; name: string };
type CompaniesResponse = { companies?: Company[] };

type ListResponse = { success?: boolean; data?: Announcement[] };

type AckedUser = {
  id: number;
  name: string;
  email: string;
  ackedAt: string | null;
};
type PendingUser = { id: number; name: string; email: string };
type AcksResponse = {
  success?: boolean;
  data?: {
    total: number;
    ackedCount: number;
    acked: AckedUser[];
    pending: PendingUser[];
  };
};

// ────────────────────────────────────────────────────────────────────────────
// Constants — category metadata mirrors Hookka's ANNOUNCEMENT_CATEGORIES.
// ────────────────────────────────────────────────────────────────────────────
const CATEGORY_ORDER: AnnouncementCategory[] = [
  "GENERAL",
  "WARNING",
  "SOP",
  "LEARNING",
];
const CATEGORY_META: Record<
  AnnouncementCategory,
  {
    label: string;
    icon: typeof Megaphone;
    pillCls: string;
  }
> = {
  GENERAL: {
    label: "General",
    icon: Megaphone,
    pillCls: "bg-surface-dim text-ink-secondary border-border",
  },
  WARNING: {
    label: "Warning",
    icon: AlertTriangle,
    pillCls: "bg-err/10 text-err border-err/30",
  },
  SOP: {
    label: "SOP",
    icon: ShieldCheck,
    pillCls: "bg-accent/10 text-accent border-accent/30",
  },
  LEARNING: {
    label: "Learning",
    icon: BookOpen,
    pillCls: "bg-primary/10 text-primary border-primary/30",
  },
};

function attachmentKind(mime: string): "image" | "video" | "pdf" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

const fmtTimestamp = fmtDateTime;

function CategoryBadge({ category }: { category: AnnouncementCategory }) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider",
        meta.pillCls,
      )}
    >
      <Icon size={11} />
      {meta.label}
    </span>
  );
}

// Resolve the company-scope of a notice to a compact chip label. Empty target
// (or one covering every company) = "Both"/"All"; a subset lists the codes.
function companyScopeLabel(
  ids: number[] | undefined,
  companies: Company[],
): string {
  const list = ids ?? [];
  if (companies.length === 0) return "";
  if (list.length === 0 || list.length >= companies.length) {
    return companies.length === 2 ? "Both" : "All companies";
  }
  return list
    .map((id) => companies.find((co) => co.id === id)?.code ?? `#${id}`)
    .join(" / ");
}

// A small company-scope chip shown on each row (multi-company only).
function CompanyBadge({
  ids,
  companies,
}: {
  ids: number[] | undefined;
  companies: Company[];
}) {
  if (companies.length <= 1) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-dim px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-secondary">
      <Building2 size={11} />
      {companyScopeLabel(ids, companies)}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────
export function Announcements() {
  const { can, user } = useAuth();
  const toast = useToast();
  // A Sales Director may compose (owner rule 2026-07-15) even though their
  // POSITION carries no announcements.* permission — code-keyed off the org
  // chart, mirroring the backend requirePermissionOrSalesDirector admittance.
  // `salesDirOnly` = admitted purely as a Sales Director (no full grant): their
  // composer is constrained to the Sales department / a specific salesperson.
  const isSalesDir = isSalesDirectorUser(user);
  const canWrite = can("announcements.write") || isSalesDir;
  const salesDirOnly = isSalesDir && !can("announcements.write");

  // NOTE: this fetch is unbounded (no LIMIT/pagination) — the backend returns
  // every announcement. Capping it server-side is a separate follow-up; the DOM
  // list below is windowed so a large payload no longer freezes rendering.
  const listQ = useQuery<ListResponse>("/api/announcements", () => api.get("/api/announcements"));
  const items = listQ.data?.data ?? [];

  // Lookups for the audience pickers + the "To: …" pill resolver. All three sit
  // behind users.read on the backend, which a plain reader does not hold — and
  // since 2026-07-21 this page is open to EVERY authed user, so firing them
  // unconditionally would mean three guaranteed 403s (times TanStack's retries)
  // on every ordinary staffer's page load. Off, not hidden: `enabled: canWrite`
  // means the requests are never made. Nothing is lost — a 403 resolves to the
  // same empty array these consumers already fall back to, so the "To: …" pill
  // renders identically either way, and only a writer has a picker to fill.
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
  // Multi-company: the company-target selector + row chip only appear when the
  // companies master returns MORE THAN ONE company (mirrors the top-bar
  // CompanySwitcher no-op rule). Single-company Houzs shows neither.
  const companiesQ = useQuery<CompaniesResponse>("/api/companies", () =>
    api.get("/api/companies"),
  );

  const users = usersQ.data?.users ?? [];
  const depts = deptsQ.data?.departments ?? [];
  const positions = positionsQ.data?.positions ?? [];
  const companies = companiesQ.data?.companies ?? [];

  // Owner rule 2026-07-18: Create is a BUTTON, not an always-open form. The
  // composer now lives behind a modal opened from the header CTA — the page
  // opens on the history list, which is the primary surface.
  const [composerOpen, setComposerOpen] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-5">
      <PageHeader
        eyebrow="Workspace · Communications"
        title="Announcements"
        description="Post office-wide notices and track who has acknowledged them."
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
        <ComposerModal onClose={() => setComposerOpen(false)}>
          <Composer
            users={users}
            departments={depts}
            positions={positions}
            companies={companies}
            salesDirOnly={salesDirOnly}
            onPosted={() => {
              listQ.reload();
              setComposerOpen(false);
            }}
            onCancel={() => setComposerOpen(false)}
          />
        </ComposerModal>
      )}

      <section className="flex flex-col gap-2.5">
        <h2 className="flex items-center gap-2 px-1 text-[12.5px] font-semibold uppercase tracking-wider text-ink-secondary">
          <Megaphone size={13} />
          Posted Announcements
          <span className="text-ink-muted">({items.length})</span>
        </h2>
        {listQ.loading ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-[12px] text-ink-muted">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-10 text-center text-[12px] text-ink-muted">
            Nothing posted yet.
          </div>
        ) : (
          <PostedList
            items={items}
            users={users}
            departments={depts}
            positions={positions}
            companies={companies}
            canWrite={canWrite}
            salesDirOnly={salesDirOnly}
            currentUserId={user?.id ?? null}
            onChanged={() => listQ.reload()}
            toast={toast}
          />
        )}
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Posted list — window-scroll virtualized so a 10x announcement volume keeps
// only the visible rows (plus overscan) in the DOM instead of freezing on a
// full unvirtualized render. Mirrors the mobile MobileVirtualList technique:
// a CAPTURING window scroll listener (scroll events don't bubble up from the
// scroll container), the visible slice measured from the list's viewport
// position, and top/bottom spacer <li>s reserving the off-screen height so the
// scrollbar behaves normally. Row height is sampled from a real rendered row.
//
// Gated: below THRESHOLD rows this renders every row exactly as the old plain
// `.map` did — byte-identical for the small lists that are the common case.
//
// Heads-up on drift: announcement rows are variable-height (body length,
// attachment chips, and especially an expanded read-receipt roster), so a
// single sampled row height is only an estimate. We re-sample the first visible
// row on every scroll frame, which keeps the spacers locally accurate; residual
// drift only affects the scrollbar thumb position on very tall/expanded rows and
// self-corrects as you scroll. Overscan (8) hides the small-slice pop-in.
// ────────────────────────────────────────────────────────────────────────────
const POSTED_THRESHOLD = 40;
const POSTED_OVERSCAN = 8;
const POSTED_GAP = 10; // matches the <ul> `gap-2.5` (0.625rem = 10px)

function PostedList({
  items,
  users,
  departments,
  positions,
  companies,
  canWrite,
  salesDirOnly,
  currentUserId,
  onChanged,
  toast,
}: {
  items: Announcement[];
  users: TeamMember[];
  departments: Department[];
  positions: Position[];
  companies: Company[];
  canWrite: boolean;
  salesDirOnly: boolean;
  currentUserId: number | null;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const on = items.length > POSTED_THRESHOLD;
  const ref = useRef<HTMLUListElement>(null);
  const rowH = useRef(180); // rough first-paint estimate incl. gap; re-measured
  const [range, setRange] = useState({ start: 0, end: POSTED_THRESHOLD * 2 });

  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      // Sample the first real (non-spacer) row so the spacers can't drift.
      const row = el.querySelector<HTMLElement>("li:not([aria-hidden])");
      if (row && row.offsetHeight > 0) rowH.current = row.offsetHeight + POSTED_GAP;
      const rh = rowH.current || 180;
      const top = el.getBoundingClientRect().top; // list top relative to viewport
      const first = Math.max(0, Math.floor(-top / rh) - POSTED_OVERSCAN);
      const count = Math.ceil(window.innerHeight / rh) + POSTED_OVERSCAN * 2;
      const last = Math.min(items.length, first + count);
      setRange((p) =>
        p.start === first && p.end === last ? p : { start: first, end: last },
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
  }, [on, items.length]);

  const start = on ? range.start : 0;
  const end = on ? Math.min(items.length, range.end) : items.length;
  const rh = rowH.current;

  return (
    <ul ref={ref} className="flex flex-col gap-2.5">
      {on && start > 0 && (
        <li aria-hidden style={{ height: Math.max(0, start * rh - POSTED_GAP) }} />
      )}
      {items.slice(start, end).map((a) => (
        <AnnouncementRow
          key={a.id}
          announcement={a}
          users={users}
          departments={departments}
          positions={positions}
          companies={companies}
          canWrite={canWrite}
          salesDirOnly={salesDirOnly}
          currentUserId={currentUserId}
          onChanged={onChanged}
          toast={toast}
        />
      ))}
      {on && end < items.length && (
        <li
          aria-hidden
          style={{ height: Math.max(0, (items.length - end) * rh - POSTED_GAP) }}
        />
      )}
    </ul>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Composer — top-of-page create form.
// ────────────────────────────────────────────────────────────────────────────
type Bucket = "ALL" | "DEPT" | "POSITION" | "USER";

function Composer({
  users,
  departments,
  positions,
  companies,
  salesDirOnly,
  onPosted,
  onCancel,
}: {
  users: TeamMember[];
  departments: Department[];
  positions: Position[];
  companies: Company[];
  /** Composer opened by a Sales-Director-only caller: audience is constrained
   *  to the whole Sales department OR a specific salesperson in it (owner rule).
   *  The department / user lookups are already server-scoped to their dept. */
  salesDirOnly: boolean;
  onPosted: () => void;
  onCancel?: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  // The message as the canonical rich fragment (lib/announcementRichText.ts);
  // "" when the box is empty. The plain-text `body` is derived from it at post
  // time — and re-derived server-side, which is the copy that counts.
  const [text, setText] = useState("");
  const [category, setCategory] = useState<AnnouncementCategory>("GENERAL");
  const [bucket, setBucket] = useState<Bucket>(salesDirOnly ? "DEPT" : "ALL");
  // Company target: "ALL" = every company (Both — sends no target, NULL = all);
  // a company id = that company only. Default "ALL" so an untargeted notice
  // reaches everyone. Only rendered when >1 company exists.
  const [companyPick, setCompanyPick] = useState<"ALL" | number>("ALL");
  const [selectedDepts, setSelectedDepts] = useState<Set<number>>(new Set());
  const [selectedPositions, setSelectedPositions] = useState<Set<number>>(
    new Set(),
  );
  const [selectedUsers, setSelectedUsers] = useState<Set<number>>(new Set());
  const [userSearch, setUserSearch] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Rich-media layout hint (mig 0140). "" photo layout = auto (derive from
  // count); a video defaults to a 1x1 square. Only surfaced when the matching
  // media is actually attached.
  const [photoLayout, setPhotoLayout] = useState<PhotoLayout | "">("");
  const [videoLayout, setVideoLayout] = useState<VideoLayout>("1x1");
  const [posting, setPosting] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    const active = users.filter((u) => u.status === "active");
    if (!q) return active;
    return active.filter(
      (u) =>
        (u.name ?? "").toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q),
    );
  }, [users, userSearch]);

  // Sales Director: default the "Sales Department" bucket to their own
  // department (the lookups already return only it), so posting with no manual
  // pick still targets the whole Sales dept. Seeded once so a later deselect
  // isn't fought.
  const seededDeptRef = useRef(false);
  useEffect(() => {
    if (
      salesDirOnly &&
      !seededDeptRef.current &&
      bucket === "DEPT" &&
      departments.length > 0
    ) {
      seededDeptRef.current = true;
      setSelectedDepts(new Set(departments.map((d) => d.id)));
    }
  }, [salesDirOnly, bucket, departments]);

  const onPickFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploadErr(null);
      const next: Attachment[] = [];
      for (const f of Array.from(files)) {
        try {
          // WO-7: shared pipeline — compresses images + uploads their thumbs.
          const res = await uploadAnnouncementAttachment(f);
          next.push({
            r2Key: res.r2Key,
            name: res.name,
            mime: res.mime,
            size: res.size,
          });
        } catch (e: any) {
          setUploadErr(e?.message || "Upload failed");
          break;
        }
      }
      if (next.length) setAttachments((prev) => [...prev, ...next]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [],
  );

  function toggleSet(set: Set<number>, id: number): Set<number> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  function pickBucket(b: Bucket) {
    setBucket(b);
    if (b === "ALL") {
      setSelectedDepts(new Set());
      setSelectedPositions(new Set());
      setSelectedUsers(new Set());
    }
  }

  async function post() {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      toast.error("Title is required");
      return;
    }
    // A specific-audience bucket with nothing picked posts an EMPTY target
    // array, which the backend treats as ALL_USERS — silently broadcasting a
    // dept/position/person-scoped notice to everyone. Refuse it (the mobile
    // composer already guards this; see MobileAnnouncements.tsx). Choosing
    // "All users" is the explicit path to everyone.
    if (bucket === "DEPT" && selectedDepts.size === 0) {
      toast.error("Pick at least one department, or choose All users.");
      return;
    }
    if (bucket === "POSITION" && selectedPositions.size === 0) {
      toast.error("Pick at least one position, or choose All users.");
      return;
    }
    if (bucket === "USER" && selectedUsers.size === 0) {
      toast.error("Pick at least one person, or choose All users.");
      return;
    }
    setPosting(true);
    try {
      const body: Record<string, unknown> = {
        title: cleanTitle,
        body: richTextToPlain(text),
        bodyHtml: text,
        category,
        attachments,
      };
      if (bucket === "DEPT") body.targetDeptIds = Array.from(selectedDepts);
      if (bucket === "POSITION")
        body.targetPositionIds = Array.from(selectedPositions);
      if (bucket === "USER") body.targetUserIds = Array.from(selectedUsers);
      // Company target: a single company sends [id]; "Both"/ALL omits the field
      // (backend stores NULL = all companies).
      if (companyPick !== "ALL") body.targetCompanyIds = [companyPick];
      if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
      // Media layout — only send hints for media actually attached; an empty
      // photo pick stays absent so the renderer derives a count default.
      const hasPhotos = attachments.some((a) => a.mime.startsWith("image/"));
      const hasVideos = attachments.some((a) => a.mime.startsWith("video/"));
      const mediaLayout: { photo?: PhotoLayout; video?: VideoLayout } = {};
      if (hasPhotos && photoLayout) mediaLayout.photo = photoLayout;
      if (hasVideos) mediaLayout.video = videoLayout;
      if (mediaLayout.photo || mediaLayout.video) body.mediaLayout = mediaLayout;
      await api.post("/api/announcements", body);
      // Reset.
      setTitle("");
      setText("");
      setCategory("GENERAL");
      setBucket("ALL");
      setCompanyPick("ALL");
      setSelectedDepts(new Set());
      setSelectedPositions(new Set());
      setSelectedUsers(new Set());
      setExpiresAt("");
      setAttachments([]);
      setPhotoLayout("");
      setVideoLayout("1x1");
      toast.success("Announcement posted");
      onPosted();
    } catch (e: any) {
      toast.error(e?.message || "Failed to post");
    } finally {
      setPosting(false);
    }
  }

  const canPost = !posting && title.trim().length > 0;
  const hasPhotos = attachments.some((a) => a.mime.startsWith("image/"));
  const hasVideos = attachments.some((a) => a.mime.startsWith("video/"));
  const companyOptions: Array<["ALL" | number, string]> = [
    ["ALL", "Both"],
    ...companies.map((co) => [co.id, co.name] as ["ALL" | number, string]),
  ];

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
        <Megaphone size={14} className="text-ink-muted" />
        <div className="text-[12px] font-bold uppercase tracking-wider text-ink-secondary">
          New Announcement
        </div>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="What's the announcement?"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
            Message
          </label>
          <AnnouncementRichEditor
            value={text}
            onChange={setText}
            placeholder="Add the details (optional)"
            disabled={posting}
          />
        </div>

        {/* Attachments */}
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
              Attachments
            </label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
            >
              <Paperclip size={11} />
              Attach files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/*,application/pdf"
              onChange={(e) => onPickFiles(e.target.files)}
              className="hidden"
            />
          </div>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a, i) => {
                const Icon =
                  attachmentKind(a.mime) === "image"
                    ? ImageIcon
                    : attachmentKind(a.mime) === "video"
                    ? Video
                    : attachmentKind(a.mime) === "pdf"
                    ? FileText
                    : FileIcon;
                return (
                  <span
                    key={a.r2Key + i}
                    className="inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-border bg-surface-dim px-2 py-0.5 text-[11px] text-ink"
                  >
                    <Icon size={11} className="shrink-0 text-ink-muted" />
                    <span className="truncate">{a.name}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setAttachments((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="ml-1 rounded-full p-0.5 text-ink-muted hover:bg-surface hover:text-err"
                      aria-label="Remove"
                    >
                      <X size={10} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {uploadErr && (
            <p className="mt-1 text-[11px] text-err">{uploadErr}</p>
          )}

          {/* Layout hints — only shown for the media actually attached. Photos
              get a 1 / 2 / 3 / 4 arrangement (Auto derives from the count);
              a video gets a 1x1 square or 1x2 portrait block. */}
          {(hasPhotos || hasVideos) && (
            <div className="mt-2.5 flex flex-col gap-2 rounded-md border border-border-subtle bg-surface-dim p-2.5">
              {hasPhotos && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
                    Photo layout
                  </span>
                  {(
                    [
                      ["", "Auto"],
                      ["1", "1"],
                      ["2", "2"],
                      ["3", "3"],
                      ["4", "4"],
                    ] as Array<[PhotoLayout | "", string]>
                  ).map(([val, label]) => {
                    const selected = photoLayout === val;
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setPhotoLayout(val)}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-[11.5px] font-semibold transition-colors",
                          selected
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
              {hasVideos && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
                    Video layout
                  </span>
                  {(
                    [
                      ["1x1", "1 x 1 (square)"],
                      ["1x2", "1 x 2 (portrait)"],
                    ] as Array<[VideoLayout, string]>
                  ).map(([val, label]) => {
                    const selected = videoLayout === val;
                    return (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setVideoLayout(val)}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-[11.5px] font-semibold transition-colors",
                          selected
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Company target — only when more than one company exists. Hidden for
            a Sales Director (they post within their own department only). */}
        {companies.length > 1 && !salesDirOnly && (
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
              Company
            </label>
            <div className="flex flex-wrap gap-1.5">
              {companyOptions.map(([key, label]) => {
                const selected = companyPick === key;
                return (
                  <button
                    key={String(key)}
                    type="button"
                    onClick={() => setCompanyPick(key)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                      selected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                    )}
                  >
                    <Building2 size={12} />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Category */}
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
            Category
          </label>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORY_ORDER.map((c) => {
              const m = CATEGORY_META[c];
              const Icon = m.icon;
              const selected = category === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                    selected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                  )}
                >
                  <Icon size={12} />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Recipients */}
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
            Recipients
          </label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(
              salesDirOnly
                ? ([
                    ["DEPT", "Sales Department", UsersIcon],
                    ["USER", "Specific salesperson", UsersIcon],
                  ] as Array<[Bucket, string, typeof Globe]>)
                : ([
                    ["ALL", "All users", Globe],
                    ["DEPT", "Departments", UsersIcon],
                    ["POSITION", "Positions", ShieldCheck],
                    ["USER", "Specific people", UsersIcon],
                  ] as Array<[Bucket, string, typeof Globe]>)
            ).map(([key, label, Icon]) => {
              const selected = bucket === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => pickBucket(key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                    selected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                  )}
                >
                  <Icon size={12} />
                  {label}
                </button>
              );
            })}
          </div>

          {bucket === "DEPT" && (
            <div className="rounded-md border border-border bg-surface-dim p-2.5">
              <div className="flex flex-wrap gap-1.5">
                {departments.length === 0 ? (
                  <span className="text-[11.5px] text-ink-muted">
                    No departments
                  </span>
                ) : (
                  departments.map((d) => {
                    const on = selectedDepts.has(d.id);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() =>
                          setSelectedDepts((prev) => toggleSet(prev, d.id))
                        }
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold transition-colors",
                          on
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                        )}
                      >
                        {d.name}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {bucket === "POSITION" && (
            <div className="rounded-md border border-border bg-surface-dim p-2.5">
              <div className="flex flex-wrap gap-1.5">
                {positions.length === 0 ? (
                  <span className="text-[11.5px] text-ink-muted">
                    No positions
                  </span>
                ) : (
                  positions.map((p) => {
                    const on = selectedPositions.has(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() =>
                          setSelectedPositions((prev) =>
                            toggleSet(prev, p.id),
                          )
                        }
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold transition-colors",
                          on
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                        )}
                      >
                        {p.name}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {bucket === "USER" && (
            <div className="rounded-md border border-border bg-surface-dim p-2.5">
              <input
                type="text"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="mb-2 h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <div className="max-h-48 overflow-auto rounded border border-border bg-surface">
                {filteredUsers.length === 0 ? (
                  <div className="px-2.5 py-2 text-[11.5px] text-ink-muted">
                    No matching users.
                  </div>
                ) : (
                  filteredUsers.map((u) => {
                    const on = selectedUsers.has(u.id);
                    return (
                      <label
                        key={u.id}
                        className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-surface-dim"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setSelectedUsers((prev) => toggleSet(prev, u.id))
                          }
                        />
                        <span className="truncate">
                          {u.name || u.email}
                          {u.email && u.name && (
                            <span className="ml-1 text-ink-muted">
                              · {u.email}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
            Hide automatically after
          </label>
          <DateTimeField
            aria-label="Hide automatically after"
            value={expiresAt}
            onChange={setExpiresAt}
            className="h-10 rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel} disabled={posting}>
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            onClick={post}
            disabled={!canPost}
            icon={<Send size={13} />}
          >
            {posting ? "Posting…" : "Post Announcement"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ComposerModal — the create form lives behind this overlay (owner 2026-07-18:
// "Create should be a Button"). A centred, scrollable panel; the backdrop and
// the X both close it. Rendered via a portal so it escapes the page's max-w
// column and stacking context.
// ────────────────────────────────────────────────────────────────────────────
function ComposerModal({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/30 p-4 backdrop-blur-[1px] sm:p-6"
      role="dialog"
      aria-modal="true"
      onMouseDown={onClose}
    >
      <div
        className="relative my-4 w-full max-w-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute -top-2 right-0 z-10 -translate-y-full rounded-full border border-border bg-surface p-1.5 text-ink-secondary shadow-stone hover:text-ink sm:-right-2"
        >
          <X size={16} />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// One row in the Posted list.
// ────────────────────────────────────────────────────────────────────────────
function AnnouncementRow({
  announcement: a,
  users,
  departments,
  positions,
  companies,
  canWrite,
  salesDirOnly,
  currentUserId,
  onChanged,
  toast,
}: {
  announcement: Announcement;
  users: TeamMember[];
  departments: Department[];
  positions: Position[];
  companies: Company[];
  canWrite: boolean;
  salesDirOnly: boolean;
  currentUserId: number | null;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  // A Sales Director can manage (hide / delete / remind / view receipts) ONLY
  // the posts they authored — the backend enforces the same ownership. Full
  // announcers manage every row. This keeps the affordances off notices an SD
  // can see (their audience feed) but can't act on.
  const canManage =
    canWrite && (!salesDirOnly || a.createdBy === currentUserId);
  const dialog = useDialog();
  const [acksOpen, setAcksOpen] = useState(false);
  const [acks, setAcks] = useState<AcksResponse["data"] | null>(null);
  const [acksLoading, setAcksLoading] = useState(false);

  /* Hidden / Expired / Live comes from the SHARED rule, imported — not
     re-derived here — so the phone's badges can never disagree with these.
     See lib/announcementStatus.ts for why that mattered. */
  const status = announcementStatus(a);
  const expired = status === "expired";
  const statusText = ANNOUNCEMENT_STATUS_LABEL[status];
  const statusCls = !a.isActive
    ? "bg-surface-dim text-ink-muted border-border"
    : expired
    ? "bg-surface-dim text-ink-muted border-border"
    : "bg-synced/10 text-synced border-synced/30";

  const audienceLabel = useMemo(() => {
    const t = a.targetType ?? "ALL_USERS";
    if (t === "ALL_USERS") return "Everyone";
    const parts: string[] = [];
    const deptMap = new Map(departments.map((d) => [d.id, d.name]));
    const posMap = new Map(positions.map((p) => [p.id, p.name]));
    const userMap = new Map(users.map((u) => [u.id, u.name || u.email]));
    if (a.targetDeptIds?.length) {
      parts.push(
        `Departments: ${a.targetDeptIds
          .map((id) => deptMap.get(id) ?? `#${id}`)
          .join(", ")}`,
      );
    }
    if (a.targetPositionIds?.length) {
      parts.push(
        `Positions: ${a.targetPositionIds
          .map((id) => posMap.get(id) ?? `#${id}`)
          .join(", ")}`,
      );
    }
    if (a.targetUserIds?.length) {
      parts.push(
        `People: ${a.targetUserIds
          .map((id) => userMap.get(id) ?? `#${id}`)
          .join(", ")}`,
      );
    }
    return parts.length ? parts.join(" · ") : "—";
  }, [a, departments, positions, users]);

  async function loadAcks() {
    setAcksLoading(true);
    try {
      const r = await api.get<AcksResponse>(`/api/announcements/${a.id}/acks`);
      setAcks(r.data ?? null);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load read receipts");
    } finally {
      setAcksLoading(false);
    }
  }

  function toggleAcksPanel() {
    const next = !acksOpen;
    setAcksOpen(next);
    if (next) void loadAcks();
  }

  async function toggleActive() {
    try {
      await api.patch(`/api/announcements/${a.id}`, { isActive: !a.isActive });
      toast.success(a.isActive ? "Announcement hidden" : "Announcement shown");
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function doDelete() {
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
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "Failed to delete");
    }
  }

  async function remindUnacked() {
    const pending = acks?.pending.length ?? 0;
    const ok = await dialog.confirm({
      title: "Send reminder",
      message: `Re-pop the banner for ${pending} un-acknowledged user${
        pending === 1 ? "" : "s"
      }? Anyone who already tapped Got it will be unaffected.`,
      confirmLabel: "Remind",
    });
    if (!ok) return;
    try {
      const r = await api.post<{ pendingCount: number }>(
        `/api/announcements/${a.id}/remind`,
        { scope: "unacked" },
      );
      toast.success(
        `Reminder set — will re-pop for ${r.pendingCount} user${
          r.pendingCount === 1 ? "" : "s"
        }`,
      );
      onChanged();
      void loadAcks();
    } catch (e: any) {
      toast.error(e?.message || "Failed to remind");
    }
  }

  async function remindAll() {
    const total = acks?.total ?? 0;
    const ok = await dialog.confirm({
      title: "Reset all read-receipts",
      message: `Wipe acknowledgements and re-pop for ALL ${total} active user${
        total === 1 ? "" : "s"
      }? Everyone (including those who already acknowledged) will see the popup again.`,
      confirmLabel: "Reset and remind",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.post<{ pendingCount: number }>(
        `/api/announcements/${a.id}/remind`,
        { scope: "all" },
      );
      toast.success(
        `Reset — banner re-pops for ${r.pendingCount} user${
          r.pendingCount === 1 ? "" : "s"
        }`,
      );
      onChanged();
      void loadAcks();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reset");
    }
  }

  return (
    <li className="rounded-lg border border-border bg-surface p-3.5 shadow-stone">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <CategoryBadge category={a.category ?? "GENERAL"} />
            <CompanyBadge ids={a.targetCompanyIds} companies={companies} />
            <span className="truncate text-[14px] font-semibold text-ink">
              {a.title}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                statusCls,
              )}
            >
              {statusText}
            </span>
          </div>
          <AnnouncementRichBody
            html={a.bodyHtml}
            text={a.body}
            className="text-[12.5px] text-ink-secondary"
          />

          {a.attachments && a.attachments.length > 0 && (
            <AnnouncementMedia
              annId={a.id}
              attachments={a.attachments}
              layout={a.mediaLayout ?? null}
              className="mt-2 max-w-md"
            />
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-dim px-2 py-0.5">
              {a.targetType === "ALL_USERS" ? (
                <Globe size={10} />
              ) : (
                <UsersIcon size={10} />
              )}
              To: {audienceLabel}
            </span>
            <span>
              Posted {a.createdAt ? relativeTime(a.createdAt) : "—"}
              {a.expiresAt && ` · hides ${relativeTime(a.expiresAt)}`}
              {a.remindedAt && ` · reminded ${relativeTime(a.remindedAt)}`}
            </span>
          </div>

          {canManage && (
            <button
              type="button"
              onClick={toggleAcksPanel}
              className="mt-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface-dim px-2 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
            >
              {acksOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <UsersIcon size={11} />
              {acks
                ? `Read ${acks.ackedCount} of ${acks.total}`
                : "Read receipts"}
            </button>
          )}

          {acksOpen && (
            <div className="mt-2 rounded-md border border-border bg-surface-dim p-2.5">
              {acksLoading ? (
                <div className="text-[11.5px] text-ink-muted">Loading…</div>
              ) : !acks ? (
                <div className="text-[11.5px] text-ink-muted">No data.</div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded border border-border bg-surface p-2">
                    <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-secondary">
                      Acknowledged ({acks.acked.length})
                    </div>
                    {acks.acked.length === 0 ? (
                      <div className="text-[11.5px] text-ink-muted">
                        Nobody yet.
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-0.5 text-[11.5px]">
                        {acks.acked.map((u) => (
                          <li key={u.id} className="flex justify-between gap-2">
                            <span className="truncate">
                              {u.name || u.email}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                              {u.ackedAt ? relativeTime(u.ackedAt) : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="rounded border border-border bg-surface p-2">
                    <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-secondary">
                      Not yet ({acks.pending.length})
                    </div>
                    {acks.pending.length === 0 ? (
                      <div className="text-[11.5px] text-ink-muted">
                        Everybody acknowledged.
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-0.5 text-[11.5px]">
                        {acks.pending.map((u) => (
                          <li key={u.id} className="truncate">
                            {u.name || u.email}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
              {canManage && acks && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {acks.pending.length > 0 && (
                    <button
                      type="button"
                      onClick={remindUnacked}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
                    >
                      <BellRing size={11} />
                      Remind un-acknowledged ({acks.pending.length})
                    </button>
                  )}
                  {acks.total > 0 && (
                    <button
                      type="button"
                      onClick={remindAll}
                      className="inline-flex items-center gap-1 rounded-md border border-err/30 bg-surface px-2.5 py-1 text-[11px] font-semibold text-err hover:bg-err/5"
                    >
                      <BellRing size={11} />
                      Remind all ({acks.total})
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-1.5 md:shrink-0">
            <button
              type="button"
              onClick={toggleActive}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
              title={fmtTimestamp(a.updatedAt)}
            >
              {a.isActive ? <EyeOff size={11} /> : <Eye size={11} />}
              {a.isActive ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              onClick={doDelete}
              className="inline-flex items-center gap-1 rounded-md border border-err/30 bg-surface px-2.5 py-1 text-[11px] font-semibold text-err hover:bg-err/5"
            >
              <Trash2 size={11} />
              Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
