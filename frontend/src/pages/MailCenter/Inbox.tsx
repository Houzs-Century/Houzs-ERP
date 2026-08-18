// ---------------------------------------------------------------------------
// Mail Center — shared inbox (3-pane Gmail/Outlook-like client + compose).
//
// Reads /api/mail-center/threads (list) + /api/mail-center/addresses (the
// mailbox sidebar) + /api/mail-center/labels (the colour catalogue). Bodies are
// rendered in the detail view; the list shows cleaned-text snippets only.
//
// LAYOUT:
//   • LEFT RAIL  — "New email" (opens ComposeDialog), the FOLDER list (Inbox /
//                  Starred / Sent / Archive / Drafts / Trash / All), a LABELS
//                  section (filter by DB label), the mailbox switcher (All +
//                  per-dept + per-person), then the search box.
//   • MIDDLE     — the thread list (<ThreadList>) with per-row checkbox + hover
//                  actions, plus a bulk action bar when rows are selected.
//   • RIGHT (lg+)— a reading pane embedding Thread.tsx for the selected thread
//                  (split mode only).
//
// FOLDERS vs API STATUS:
//   Inbox   → status=open (server filter)
//   Archive → status=closed (server filter, labelled "Archive")
//   Starred → ?starred=1 (server filter)
//   Trash   → ?status=trashed (server filter; excluded from every other view)
//   Sent    → fetched with status=all, narrowed client-side by hasOutbound
//   All     → fetched with status=all
//   Drafts  → local-only compose drafts (no backend draft table — mail-local.ts)
// Star / labels / trash / mark-unread are DB-backed (PATCH /threads/:id) and
// sync across users/devices. Only compose drafts remain local.
//
// GMAIL-STYLE VIEW TOGGLES (mail-prefs.ts, localStorage, surfaced via the "View"
// gear): density (compact / comfortable), reading-pane (split / full), category
// tabs (Primary / Notifications client-side split over the fetched rows).
// ---------------------------------------------------------------------------
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { cn } from "../../lib/utils";
import {
  subscribeActiveCompany,
  getActiveCompanySnapshot,
} from "../../lib/activeCompany";
import { ComposeDialog } from "./Compose";
import { MailThread } from "./Thread";
import {
  subscribe as subscribeLocal,
  getSnapshot as getLocalSnapshot,
  deleteDraft,
  hasQuarantinedLegacyDrafts,
  type MailDraft,
} from "./mail-local";
import {
  patchManyStatus,
  patchManyTrashed,
  patchManyUnread,
  patchManyAddLabel,
  patchThreadStatus,
  patchThreadStarred,
  patchThreadUnread,
  patchThreadTrashed,
  createLabel,
  updateLabel,
  deleteLabel,
  createDeptMailbox,
  fetchOutbox,
  fetchOutboxDetail,
  type OutboxRow,
  type OutboxCounts,
  type OutboxDetail,
} from "./mail-actions";
import {
  type MailLabel,
  LABEL_PALETTE,
  labelColorMap,
  colorForLabel,
  chipStyle,
} from "./mail-labels";
import {
  type MailViewPrefs,
  type MailDensity,
  type MailReadingPane,
  type MailCategory,
  classifyCategory,
  subscribePrefs,
  getPrefsSnapshot,
  setDensity,
  setReadingPane,
  setCategoryTabs,
} from "./mail-prefs";
import {
  Mail,
  Search,
  RefreshCw,
  Inbox as InboxIcon,
  ArrowDownLeft,
  ArrowUpRight,
  PenSquare,
  ChevronRight,
  Users,
  User as UserIcon,
  Check,
  Star,
  Send,
  Archive,
  Trash2,
  FileText,
  Layers,
  Tag,
  MailOpen,
  MailWarning,
  X,
  CheckCheck,
  Plus,
  Building2,
  Settings2,
  SlidersHorizontal,
  Bell,
  Rows3,
  Rows4,
  PanelRight,
  Square,
} from "lucide-react";
import { fmtDate, fmtDateTime, fmtTime as fmtClock } from "@2990s/shared";

type MailThreadRow = {
  id: string;
  mailboxAddress: string;
  subject: string;
  counterpartyEmail: string;
  counterpartyName: string;
  status: string;
  lastMessageAt: string;
  lastDirection: string;
  lastSnippet: string;
  messageCount: number;
  unread: boolean;
  starred: boolean;
  labels: string[];
  trashedAt: string | null;
  hasOutbound: boolean;
};

type MailAddress = {
  id: string;
  address: string;
  label: string;
  assignedDept: string | null;
  assignedUserName: string | null;
  active: boolean;
};

// Paginated /threads response (opt-in via ?page=&pageSize=). The bare-array
// shape is still used by the counts + trash-badge fetches.
type ThreadsPageResp = {
  threads: MailThreadRow[];
  total: number;
  hasMore: boolean;
  page: number;
  pageSize: number;
};

// Debounce a rapidly-changing value (the search box) so each keystroke doesn't
// fire a server round-trip — the list refetches 300ms after typing settles.
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

type MailboxFilter =
  | { kind: "all" }
  | { kind: "dept"; value: string }
  | { kind: "mailbox"; value: string };

type MailboxEntry =
  | { kind: "real"; address: MailAddress }
  | { kind: "missing"; address: string; dept: string };

type Folder =
  | "inbox"
  | "starred"
  | "sent"
  // Auto-sent system notices (the outbox_emails log) — Delivery Order /
  // Invoice / CN / PO notices the system sends from a noreply sender, so there
  // is no human "Sent" copy to read. Rendered by its own OutboxPanel, not the
  // thread list.
  | "autosent"
  | "archive"
  | "drafts"
  | "trash"
  | "all";

// Department LABELS used by the 5 shared department mailboxes (operation@ /
// sales@ / marketing@ / finance@ / hr@houzscentury.com). These MUST match the
// mailboxes' `assignedDept` strings exactly so the sidebar groups each shared
// mailbox under its department header (and rolls up its unread count).
const DEPT_PRIORITY = ["Operation", "Sales", "Marketing", "Finance", "HR"];
const UNASSIGNED_DEPT = "Other";

function deptRank(dept: string): number {
  const i = DEPT_PRIORITY.indexOf(dept);
  if (i !== -1) return i;
  if (dept === UNASSIGNED_DEPT) return DEPT_PRIORITY.length + 1;
  return DEPT_PRIORITY.length;
}

function sortDepts(a: string, b: string): number {
  const ra = deptRank(a);
  const rb = deptRank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

/* Accepts an ISO string OR an epoch-millisecond number, because both reach it:
   thread rows carry ISO strings from the API, local drafts carry epoch numbers
   from localStorage. Callers used to normalise the number half themselves with
   `new Date(x).toISOString()`, which threw RangeError on a missing value and
   took the whole page down — the guard below was never reached. Widening the
   parameter is what lets every caller hand the raw value straight over and
   actually get the tolerant behaviour this function was written to provide. */
function fmtTime(iso: string | number | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  /* Today shows the clock, older rows show the date — one INBOX convention,
     but both halves come from the one rule rather than the OS locale. */
  return sameDay ? fmtClock(d) : fmtDate(d);
}

function senderLabel(t: MailThreadRow): string {
  const name = t.counterpartyName?.trim();
  if (name) return name;
  const email = t.counterpartyEmail?.trim();
  if (email) {
    const local = email.split("@")[0];
    return local || email;
  }
  return "(no sender)";
}

const PANE_QUERY = "(min-width: 1024px)";
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(PANE_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(PANE_QUERY);
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

function useLocalMail() {
  return useSyncExternalStore(subscribeLocal, getLocalSnapshot, getLocalSnapshot);
}

function useMailPrefs(): MailViewPrefs {
  return useSyncExternalStore(subscribePrefs, getPrefsSnapshot, getPrefsSnapshot);
}

function cleanSnippet(s: string): string {
  return (
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, " ")
      .replace(/\s+/g, " ")
      .trim() || "(no preview)"
  );
}

// ── ThreadList ───────────────────────────────────────────────────────────
export function ThreadList({
  threads,
  loading,
  activeId,
  folder,
  density,
  selectedIds,
  colorMap,
  onToggleSelect,
  onOpen,
  onInjectTest,
  onRowAction,
}: {
  threads: MailThreadRow[];
  loading: boolean;
  activeId: string | null;
  folder: Folder;
  density: MailDensity;
  selectedIds: Set<string>;
  colorMap: Map<string, string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onInjectTest: () => void;
  onRowAction: (action: RowAction, t: MailThreadRow) => void;
}) {
  if (loading) {
    return (
      <div role="status" aria-live="polite" className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
        <InboxIcon className="h-6 w-6 text-ink-muted/40" />
        <p className="text-xs font-medium text-ink-muted">Loading…</p>
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
        <InboxIcon className="h-6 w-6 text-ink-muted/40" />
        <p className="text-xs font-medium text-ink-muted">
          {emptyLabel(folder)}
        </p>
        {folder === "inbox" && (
          <>
            <p className="max-w-xs text-[11px] leading-snug text-ink-muted/70">
              Incoming mail syncs in automatically every few minutes. Mail is
              scoped to the active company — if a mailbox looks empty, check the
              company selector at the top right.
            </p>
            <button
              onClick={onInjectTest}
              className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
            >
              Inject a test email (verify inbox)
            </button>
          </>
        )}
      </div>
    );
  }

  const compact = density === "compact";
  // DOM windowing: the full (client-filtered) thread array is kept intact — only
  // the rows scrolled into view are mounted, so a fully-loaded inbox (LIMIT 300
  // from the server) keeps ~30 <li> nodes in the DOM instead of all 300. No-op
  // below WINDOW threshold, so short lists render byte-identically to before.
  return (
    <WindowedThreadUl
      count={threads.length}
      estimateHeight={compact ? 36 : 76}
      renderRow={(i) => {
        const t = threads[i];
        return compact ? (
          <CompactRow
            key={t.id}
            t={t}
            active={activeId === t.id}
            folder={folder}
            selected={selectedIds.has(t.id)}
            colorMap={colorMap}
            onToggleSelect={onToggleSelect}
            onOpen={onOpen}
            onRowAction={onRowAction}
          />
        ) : (
          <ComfortableRow
            key={t.id}
            t={t}
            active={activeId === t.id}
            folder={folder}
            selected={selectedIds.has(t.id)}
            colorMap={colorMap}
            onToggleSelect={onToggleSelect}
            onOpen={onOpen}
            onRowAction={onRowAction}
          />
        );
      }}
    />
  );
}

// ── Windowed <ul> for the thread list ─────────────────────────────────────────
// Mirrors MobileVirtualList / DataTable's proven window-scroll virtualization,
// adapted to a `<ul className="divide-y">` of `<li>` rows: a CAPTURING window
// scroll listener catches scroll from any ancestor, the visible slice is
// measured against the viewport, and two spacer <li>s reserve the off-screen
// height so the page scrollbar + divide-y borders behave exactly as before.
// Row height is measured from the FIRST rendered real row (`li[data-vrow]`) so
// the spacers track the actual row height. Caveat: thread rows are variable
// height (comfortable rows grow with label chips; compact rows are shorter), so
// the single measured height is an approximation — with many chip-heavy rows the
// spacer math can drift slightly, but overscan + re-measure on every scroll keep
// the visible window correct.
const THREAD_WINDOW_THRESHOLD = 40;
const THREAD_WINDOW_OVERSCAN = 8;
function WindowedThreadUl({
  count,
  renderRow,
  estimateHeight = 64,
  threshold = THREAD_WINDOW_THRESHOLD,
  overscan = THREAD_WINDOW_OVERSCAN,
}: {
  count: number;
  renderRow: (index: number) => React.ReactNode;
  estimateHeight?: number;
  threshold?: number;
  overscan?: number;
}) {
  const on = count > threshold;
  const ref = useRef<HTMLUListElement>(null);
  const rowH = useRef(estimateHeight);
  const [range, setRange] = useState({ start: 0, end: threshold * 2 });

  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const row = el.querySelector<HTMLElement>("li[data-vrow]");
      if (row && row.offsetHeight > 0) rowH.current = row.offsetHeight;
      const rh = rowH.current || estimateHeight;
      const top = el.getBoundingClientRect().top; // list top relative to viewport
      const first = Math.max(0, Math.floor(-top / rh) - overscan);
      const cnt = Math.ceil(window.innerHeight / rh) + overscan * 2;
      const last = Math.min(count, first + cnt);
      setRange((p) => (p.start === first && p.end === last ? p : { start: first, end: last }));
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
  }, [on, count, overscan, estimateHeight]);

  const start = on ? range.start : 0;
  const end = on ? Math.min(count, range.end) : count;
  const rh = rowH.current;
  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i++) rows.push(renderRow(i));

  return (
    <ul ref={ref} className="divide-y divide-border">
      {on && start > 0 && (
        <li aria-hidden style={{ height: start * rh, borderTopWidth: 0 }} />
      )}
      {rows}
      {on && end < count && (
        <li aria-hidden style={{ height: (count - end) * rh, borderTopWidth: 0 }} />
      )}
    </ul>
  );
}

type RowProps = {
  t: MailThreadRow;
  active: boolean;
  folder: Folder;
  selected: boolean;
  colorMap: Map<string, string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onRowAction: (action: RowAction, t: MailThreadRow) => void;
};

function RowLead({
  t,
  selected,
  onToggleSelect,
  onRowAction,
}: Pick<RowProps, "t" | "selected" | "onToggleSelect" | "onRowAction">) {
  const starred = t.starred;
  return (
    <>
      <label
        className="flex cursor-pointer items-center pl-3 pr-1"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(t.id)}
          aria-label={`Select conversation with ${senderLabel(t)}`}
          className="h-3.5 w-3.5 cursor-pointer rounded border-border text-primary focus:ring-primary/30"
        />
      </label>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRowAction(starred ? "unstar" : "star", t);
        }}
        aria-label={starred ? "Unstar" : "Star"}
        title={starred ? "Unstar" : "Star"}
        className="flex items-center px-1 text-ink-muted/40 hover:text-amber-500"
      >
        <Star className={cn("h-4 w-4", starred && "fill-amber-400 text-amber-500")} />
      </button>
    </>
  );
}

function RowActions({
  t,
  folder,
  onRowAction,
}: Pick<RowProps, "t" | "folder" | "onRowAction">) {
  const unread = t.unread;
  return (
    <div className="flex shrink-0 items-center gap-0.5 pr-2 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
      <RowIconButton
        title={unread ? "Mark as read" : "Mark as unread"}
        onClick={() => onRowAction(unread ? "read" : "unread", t)}
      >
        {unread ? <MailOpen className="h-4 w-4" /> : <MailWarning className="h-4 w-4" />}
      </RowIconButton>
      {folder !== "trash" &&
        (t.status === "closed" ? (
          <RowIconButton title="Move to Inbox" onClick={() => onRowAction("inbox", t)}>
            <InboxIcon className="h-4 w-4" />
          </RowIconButton>
        ) : (
          <RowIconButton title="Archive (mark done)" onClick={() => onRowAction("archive", t)}>
            <Archive className="h-4 w-4" />
          </RowIconButton>
        ))}
      {folder === "trash" ? (
        <RowIconButton title="Restore from Trash" onClick={() => onRowAction("restore", t)}>
          <RotateIcon />
        </RowIconButton>
      ) : (
        <RowIconButton title="Move to Trash" onClick={() => onRowAction("trash", t)}>
          <Trash2 className="h-4 w-4" />
        </RowIconButton>
      )}
    </div>
  );
}

function CompactRow({
  t,
  active,
  folder,
  selected,
  colorMap,
  onToggleSelect,
  onOpen,
  onRowAction,
}: RowProps) {
  const unread = t.unread;
  const chips = t.labels;
  return (
    <li
      data-vrow=""
      className={cn(
        "group relative flex items-center border-l-2 transition",
        active
          ? "border-accent bg-accent-soft/80"
          : selected
            ? "border-accent/60 bg-accent-soft/50"
            : unread
              ? "border-accent/60 bg-accent-soft/50"
              : "border-transparent hover:bg-surface-dim/50",
      )}
    >
      <RowLead t={t} selected={selected} onToggleSelect={onToggleSelect} onRowAction={onRowAction} />
      <span className="flex w-3 shrink-0 items-center justify-center">
        {unread && <span className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" />}
      </span>
      <button
        onClick={() => onOpen(t.id)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 pr-2 text-left"
      >
        <span
          className={cn(
            "w-32 shrink-0 truncate text-sm sm:w-40",
            unread ? "font-semibold text-ink" : "font-medium text-ink/80",
          )}
        >
          {senderLabel(t)}
        </span>
        {chips.length > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            {chips.slice(0, 3).map((l) => (
              <span
                key={l}
                title={l}
                className="h-2 w-2 rounded-full ring-1 ring-inset ring-black/10"
                style={{ backgroundColor: colorForLabel(l, colorMap) }}
                aria-hidden="true"
              />
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className={cn(unread ? "text-ink" : "text-ink/70")}>
            {t.subject || "(no subject)"}
          </span>
          {t.messageCount > 1 && <span className="text-ink-muted"> ({t.messageCount})</span>}
          {t.lastSnippet && (
            <span className="text-ink-muted/70">{" — "}{cleanSnippet(t.lastSnippet)}</span>
          )}
        </span>
      </button>
      <span className="shrink-0 px-2 text-xs text-ink-muted group-hover:hidden group-focus-within:hidden">
        {fmtTime(t.lastMessageAt)}
      </span>
      <div className="hidden group-hover:flex group-focus-within:flex">
        <RowActions t={t} folder={folder} onRowAction={onRowAction} />
      </div>
    </li>
  );
}

function ComfortableRow({
  t,
  active,
  folder,
  selected,
  colorMap,
  onToggleSelect,
  onOpen,
  onRowAction,
}: RowProps) {
  const unread = t.unread;
  const chips = t.labels;
  return (
    <li
      data-vrow=""
      className={cn(
        "group relative flex items-stretch border-l-2 transition",
        active
          ? "border-accent bg-accent-soft/80"
          : selected
            ? "border-accent/60 bg-accent-soft/50"
            : unread
              ? "border-accent/60 bg-accent-soft/40"
              : "border-transparent hover:bg-surface-dim/50",
      )}
    >
      <RowLead t={t} selected={selected} onToggleSelect={onToggleSelect} onRowAction={onRowAction} />
      <button
        onClick={() => onOpen(t.id)}
        className="flex min-w-0 flex-1 items-start gap-2 py-3 pr-2 text-left"
      >
        <div className="mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center">
          {unread ? (
            <span className="h-2.5 w-2.5 rounded-full bg-primary" />
          ) : t.lastDirection === "outbound" ? (
            <ArrowUpRight className="h-3.5 w-3.5 text-ink-muted/50" />
          ) : (
            <ArrowDownLeft className="h-3.5 w-3.5 text-ink-muted/50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={cn("truncate text-sm", unread ? "font-semibold text-ink" : "font-medium text-ink/90")}>
              {senderLabel(t)}
            </span>
            <span className="shrink-0 text-xs text-ink-muted">{fmtTime(t.lastMessageAt)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cn("truncate text-sm", unread ? "text-ink" : "text-ink-muted")}>
              {t.subject}
            </span>
            {t.messageCount > 1 && (
              <span className="shrink-0 text-xs text-ink-muted">({t.messageCount})</span>
            )}
          </div>
          {t.lastSnippet && (
            <p className="truncate text-xs text-ink-muted/80">{cleanSnippet(t.lastSnippet)}</p>
          )}
          {chips.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {chips.map((l) => {
                const color = colorForLabel(l, colorMap);
                return (
                  <span
                    key={l}
                    style={chipStyle(color)}
                    className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ring-black/5"
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
                    {l}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div className="ml-1 flex shrink-0 flex-col items-end gap-1">
          {t.mailboxAddress && (
            <span className="max-w-[150px] truncate rounded-full bg-surface-dim px-1.5 py-0.5 text-[10px] text-ink-secondary">
              {t.mailboxAddress}
            </span>
          )}
          {t.status === "closed" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <Check className="h-3 w-3" />
              Archived
            </span>
          )}
        </div>
      </button>
      <RowActions t={t} folder={folder} onRowAction={onRowAction} />
    </li>
  );
}

type RowAction =
  | "star"
  | "unstar"
  | "read"
  | "unread"
  | "archive"
  | "inbox"
  | "trash"
  | "restore";

function RowIconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-1.5 text-ink-muted/70 transition hover:bg-surface-dim hover:text-ink"
    >
      {children}
    </button>
  );
}

function RotateIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function emptyLabel(folder: Folder): string {
  switch (folder) {
    case "starred":
      return "No starred mail";
    case "sent":
      return "No sent mail";
    case "archive":
      return "Nothing archived";
    case "drafts":
      return "No drafts";
    case "trash":
      return "Trash is empty";
    case "all":
      return "No mail";
    default:
      return "No mail yet";
  }
}

// ── Drafts list ────────────────────────────────────────────────────────────
function DraftsList({
  drafts,
  legacyFound,
  onResume,
  onDiscard,
}: {
  drafts: MailDraft[];
  legacyFound: boolean;
  onResume: (d: MailDraft) => void;
  onDiscard: (d: MailDraft) => void;
}) {
  const legacyNotice = legacyFound ? (
    <div role="status" className="m-3 rounded-md border border-warning-text/30 bg-warning-bg px-3 py-2 text-[11px] leading-relaxed text-warning-text">
      This device contains older drafts whose user and company ownership cannot be verified. They are retained but not shown or assigned automatically. Recovery requires an owner decision.
    </div>
  ) : null;
  if (drafts.length === 0) {
    return (
      <>
        {legacyNotice}
        <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
          <FileText className="h-6 w-6 text-ink-muted/40" />
          <p className="text-xs font-medium text-ink-muted">No drafts</p>
          <p className="max-w-xs text-[11px] leading-snug text-ink-muted/70">
            Start a new email and choose "Save draft" to keep it here. Drafts are
            stored on this device only.
          </p>
        </div>
      </>
    );
  }
  return (
    <>
      {legacyNotice}
      <ul className="divide-y divide-border">
        {drafts.map((d) => (
        <li key={d.id} className="group flex items-stretch hover:bg-surface-dim/50">
          <button
            onClick={() => onResume(d)}
            className="flex min-w-0 flex-1 items-start gap-2 px-4 py-3 text-left"
          >
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted/60" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-ink/90">
                  {d.subject?.trim() || "(no subject)"}
                </span>
                <span className="shrink-0 text-xs text-ink-muted">
                  {fmtTime(d.updatedAt)}
                </span>
              </div>
              <p className="truncate text-xs text-ink-muted">To {d.to?.trim() || "—"}</p>
              {d.body && <p className="truncate text-xs text-ink-muted/80">{d.body}</p>}
            </div>
          </button>
          <div className="flex shrink-0 items-center pr-2 opacity-0 transition group-hover:opacity-100">
            <RowIconButton title="Discard draft" onClick={() => onDiscard(d)}>
              <Trash2 className="h-4 w-4" />
            </RowIconButton>
          </div>
        </li>
        ))}
      </ul>
    </>
  );
}

export function MailInbox() {
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const toast = useToast();
  const dialog = useDialog();
  const { can } = useAuth();
  const local = useLocalMail();
  const prefs = useMailPrefs();
  const splitView = prefs.readingPane === "split";
  const [category, setCategory] = useState<MailCategory>("all");
  // Admin (the owner wildcard or the mail-center.manage grant) can provision a
  // missing canonical department mailbox.
  const isAdmin = can("mail_center.manage");

  const [q, setQ] = useState("");
  const [folder, setFolder] = useState<Folder>("inbox");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [filter, setFilter] = useState<MailboxFilter>({ kind: "all" });
  const [composeOpen, setComposeOpen] = useState(false);
  const [resumeDraft, setResumeDraft] = useState<MailDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [labelManagerOpen, setLabelManagerOpen] = useState(false);

  const apiStatus: "open" | "closed" | "trashed" | "all" =
    folder === "inbox"
      ? "open"
      : folder === "archive"
        ? "closed"
        : folder === "trash"
          ? "trashed"
          : "all";

  // COUNTS / AGGREGATES query — feeds the left-rail unread badges, the Starred
  // and Trash counts, and the label union. Scoped to the folder's status + the
  // selected mailbox (same shape as before). The MAIN thread list no longer
  // reads this array; it has its own server-filtered + paginated fetch (below),
  // so nothing past the first page is lost to Starred/Sent/label/search.
  const countsParams = new URLSearchParams();
  if (apiStatus !== "all") countsParams.set("status", apiStatus);
  if (filter.kind === "mailbox") countsParams.set("mailbox", filter.value);
  const countsUrl = `/api/mail-center/threads${countsParams.toString() ? `?${countsParams.toString()}` : ""}`;
  const {
    data: threads,
    loading: countsLoading,
    error: countsError,
    reload: reloadCounts,
  } = useQuery<MailThreadRow[]>("mail-center-counts", () => api.get(countsUrl), [countsUrl], {
    // Folder / filter switch keeps the current counts on screen while the next
    // folder loads instead of flashing empty badges.
    keepPreviousData: true,
  });
  const { data: addresses } = useQuery<MailAddress[]>("/api/mail-center/addresses",
    () => api.get("/api/mail-center/addresses"),
    [],
  );
  const { data: labelCatalog } = useQuery<MailLabel[]>("/api/mail-center/labels",
    () => api.get("/api/mail-center/labels"),
    [],
  );
  // Dedicated trashed fetch — drives the Trash folder badge from ANY folder.
  const trashCountUrl = `/api/mail-center/threads?status=trashed${
    filter.kind === "mailbox" ? `&mailbox=${encodeURIComponent(filter.value)}` : ""
  }`;
  const { data: trashedThreads } = useQuery<MailThreadRow[]>("mail-center-trash-count",
    () => api.get(trashCountUrl),
    [trashCountUrl],
  );

  const activeAddresses = useMemo(
    () => (addresses ?? []).filter((a) => a.active),
    [addresses],
  );

  const deptGroups = useMemo(() => {
    const byDept = new Map<string, MailAddress[]>();
    for (const a of activeAddresses) {
      const dept = (a.assignedDept ?? "").trim() || UNASSIGNED_DEPT;
      const arr = byDept.get(dept);
      if (arr) arr.push(a);
      else byDept.set(dept, [a]);
    }
    return Array.from(byDept.entries())
      .map(([dept, mailboxes]) => ({
        dept,
        mailboxes: mailboxes
          .slice()
          .sort((x, y) =>
            (x.assignedUserName || x.address || "").localeCompare(
              y.assignedUserName || y.address || "",
            ),
          ),
      }))
      .sort((a, b) => sortDepts(a.dept, b.dept));
  }, [activeAddresses]);

  const addressesByDept = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const g of deptGroups) {
      m.set(g.dept, new Set(g.mailboxes.map((a) => a.address)));
    }
    return m;
  }, [deptGroups]);

  // Department buckets (≠ "Other"). Canonical shared mailboxes are derived from
  // the branding domain so a Support/Finance/HR placeholder always shows.
  const departmentGroups = useMemo(() => {
    const real = new Map<string, MailAddress[]>();
    for (const g of deptGroups) {
      if (g.dept === UNASSIGNED_DEPT) continue;
      real.set(g.dept, g.mailboxes);
    }
    const deptNames = new Set<string>(real.keys());
    for (const c of DEPT_PRIORITY) deptNames.add(c);

    const groups: { dept: string; entries: MailboxEntry[] }[] = [];
    for (const dept of Array.from(deptNames).sort(sortDepts)) {
      const existing = real.get(dept) ?? [];
      const entries: MailboxEntry[] = existing.map((address) => ({ kind: "real", address }));
      groups.push({ dept, entries });
    }
    return groups;
  }, [deptGroups]);

  const personalMailboxes = useMemo(() => {
    const other = deptGroups.find((g) => g.dept === UNASSIGNED_DEPT);
    return other?.mailboxes ?? [];
  }, [deptGroups]);

  // ── Server-filtered + paginated thread list ──────────────────────────────
  // The visible list is fetched with EVERY narrowing applied in SQL — folder
  // status, Starred, Sent, the dept mailbox set, the label filter, and the
  // (debounced) search box — then paged in with "Load more". Nothing is filtered
  // client-side over a truncated array, so a match on thread #900 is reachable.
  // Drafts (local) and Auto-sent (its own OutboxPanel) don't use this fetch.
  const LIST_PAGE_SIZE = 50;
  const debouncedQ = useDebouncedValue(q, 300);
  const activeCompanyId = useSyncExternalStore(
    subscribeActiveCompany,
    getActiveCompanySnapshot,
    getActiveCompanySnapshot,
  );
  const usesThreadList = folder !== "drafts" && folder !== "autosent";

  const listQueryStr = useMemo(() => {
    const p = new URLSearchParams();
    if (apiStatus !== "all") p.set("status", apiStatus);
    if (folder === "starred") p.set("starred", "1");
    if (folder === "sent") p.set("sent", "1");
    if (filter.kind === "mailbox") p.set("mailbox", filter.value);
    if (filter.kind === "dept") {
      const addrs = addressesByDept.get(filter.value);
      // A dept with no mailboxes must return NOTHING, never everything — send a
      // sentinel that matches no address rather than omitting the filter.
      p.set(
        "mailboxes",
        addrs && addrs.size ? Array.from(addrs).join(",") : "__none__",
      );
    }
    if (labelFilter) p.set("label", labelFilter);
    const needle = debouncedQ.trim();
    if (needle) p.set("q", needle);
    return p.toString();
  }, [apiStatus, folder, filter, addressesByDept, labelFilter, debouncedQ]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [listQueryStr]);

  const [listRows, setListRows] = useState<MailThreadRow[]>([]);
  const [listRowsQuery, setListRowsQuery] = useState("");
  const [listTotal, setListTotal] = useState(0);
  const [listPage, setListPage] = useState(1);
  const [listHasMore, setListHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listReloadKey, setListReloadKey] = useState(0);
  const listGenerationRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const generation = ++listGenerationRef.current;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    setListLoadingMore(false);
    if (!usesThreadList) {
      setListRows([]);
      setListTotal(0);
      setListHasMore(false);
      setListLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setListLoading(true);
    (async () => {
      try {
        const p = new URLSearchParams(listQueryStr);
        p.set("page", "1");
        p.set("pageSize", String(LIST_PAGE_SIZE));
        const data = await api.get<ThreadsPageResp>(
          `/api/mail-center/threads?${p.toString()}`,
          { signal: ctrl.signal },
        );
        if (ctrl.signal.aborted || generation !== listGenerationRef.current) return;
        setListRows(Array.isArray(data.threads) ? data.threads : []);
        setListRowsQuery(listQueryStr);
        setListTotal(Number(data.total ?? 0));
        setListHasMore(!!data.hasMore);
        setListPage(1);
        setListError(null);
      } catch {
        if (ctrl.signal.aborted || generation !== listGenerationRef.current) return;
        setListRows([]);
        setListRowsQuery(listQueryStr);
        setListTotal(0);
        setListHasMore(false);
        setListError("Couldn't load mail. Please try again.");
      } finally {
        if (!ctrl.signal.aborted && generation === listGenerationRef.current) {
          setListLoading(false);
        }
      }
    })();
    return () => {
      ctrl.abort();
      loadMoreAbortRef.current?.abort();
    };
    // listReloadKey / activeCompanyId force a refetch on mutation + company switch.
  }, [usesThreadList, listQueryStr, listReloadKey, activeCompanyId]);

  async function loadMoreThreads() {
    if (listLoadingMore || loadMoreAbortRef.current || !listHasMore) return;
    const generation = listGenerationRef.current;
    const ctrl = new AbortController();
    loadMoreAbortRef.current = ctrl;
    setListLoadingMore(true);
    try {
      const nextPage = listPage + 1;
      const p = new URLSearchParams(listQueryStr);
      p.set("page", String(nextPage));
      p.set("pageSize", String(LIST_PAGE_SIZE));
      const data = await api.get<ThreadsPageResp>(
        `/api/mail-center/threads?${p.toString()}`,
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || generation !== listGenerationRef.current) return;
      setListRows((prev) => [
        ...prev,
        ...(Array.isArray(data.threads) ? data.threads : []),
      ]);
      setListTotal(Number(data.total ?? 0));
      setListHasMore(!!data.hasMore);
      setListPage(nextPage);
      setListError(null);
    } catch {
      if (ctrl.signal.aborted || generation !== listGenerationRef.current) return;
      setListError("Couldn't load more mail. Please try again.");
    } finally {
      if (loadMoreAbortRef.current === ctrl) {
        loadMoreAbortRef.current = null;
        setListLoadingMore(false);
      }
    }
  }

  // Refresh BOTH the aggregates query and the paginated list — a mutation
  // changes the badges AND the rows (and may drop a row out of the current view).
  function reloadAll() {
    reloadCounts();
    setListReloadKey((k) => k + 1);
  }
  const loading = listLoading || countsLoading;
  const error = listError ?? countsError;
  const listSearching =
    usesThreadList && q.trim().length > 0 &&
    (q.trim() !== debouncedQ.trim() || listLoading);
  const listBusy =
    usesThreadList &&
    (listLoading || q.trim() !== debouncedQ.trim() || listRowsQuery !== listQueryStr);

  // The server already narrowed the list; the only remaining client split is the
  // optional Primary/Notifications category tab over the loaded pages.
  const categoryBase = listRows;

  const categoryCounts = useMemo(() => {
    let primary = 0;
    let notifications = 0;
    for (const t of categoryBase) {
      if (classifyCategory(t.counterpartyEmail) === "notifications") notifications++;
      else primary++;
    }
    return { all: categoryBase.length, primary, notifications };
  }, [categoryBase]);

  const visible = useMemo(() => {
    if (!prefs.categoryTabs || category === "all") return categoryBase;
    return categoryBase.filter((t) => classifyCategory(t.counterpartyEmail) === category);
  }, [categoryBase, category, prefs.categoryTabs]);
  const interactiveVisible = listBusy ? [] : visible;

  const liveThreads = useMemo(
    () => (threads ?? []).filter((t) => !t.trashedAt),
    [threads],
  );

  const folderCounts = useMemo(() => {
    const inboxUnread = liveThreads.filter((t) => t.status === "open" && t.unread).length;
    return {
      inboxUnread,
      starred: liveThreads.filter((t) => t.starred).length,
      trash: (trashedThreads ?? []).length,
    };
  }, [liveThreads, trashedThreads]);

  const unreadCount = liveThreads.filter((t) => t.unread).length;

  const unreadByMailbox = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of liveThreads) {
      if (!t.unread) continue;
      m.set(t.mailboxAddress, (m.get(t.mailboxAddress) ?? 0) + 1);
    }
    return m;
  }, [liveThreads]);

  const unreadByDept = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of deptGroups) {
      let n = 0;
      for (const a of g.mailboxes) n += unreadByMailbox.get(a.address) ?? 0;
      m.set(g.dept, n);
    }
    return m;
  }, [deptGroups, unreadByMailbox]);

  const colorMap = useMemo(() => labelColorMap(labelCatalog ?? []), [labelCatalog]);

  const labels = useMemo(() => {
    const names = new Map<string, string>();
    for (const l of labelCatalog ?? []) names.set((l.name ?? "").toLowerCase(), l.name);
    for (const t of liveThreads) {
      for (const l of t.labels) {
        if (!names.has(l.toLowerCase())) names.set(l.toLowerCase(), l);
      }
    }
    return Array.from(names.values())
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, color: colorForLabel(name, colorMap) }));
  }, [labelCatalog, liveThreads, colorMap]);
  const drafts = local.drafts;

  const selectedArr = useMemo(
    () => interactiveVisible.filter((t) => selectedIds.has(t.id)),
    [interactiveVisible, selectedIds],
  );
  const selectedVisibleIds = useMemo(
    () => new Set(selectedArr.map((t) => t.id)),
    [selectedArr],
  );
  const selectedCount = selectedArr.length;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds(new Set(interactiveVisible.map((t) => t.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function openThread(id: string) {
    if (isDesktop && splitView) {
      setSelectedId(id);
    } else {
      navigate(`/mail-center/${id}`);
    }
  }

  async function onRowAction(action: RowAction, t: MailThreadRow) {
    switch (action) {
      case "star": {
        const ok = await patchThreadStarred(t.id, true);
        if (ok) reloadAll();
        else toast.error("Couldn't star. Please try again.");
        break;
      }
      case "unstar": {
        const ok = await patchThreadStarred(t.id, false);
        if (ok) reloadAll();
        else toast.error("Couldn't unstar. Please try again.");
        break;
      }
      case "read": {
        const ok = await patchThreadUnread(t.id, false);
        if (ok) reloadAll();
        else toast.error("Couldn't update. Please try again.");
        break;
      }
      case "unread": {
        const ok = await patchThreadUnread(t.id, true);
        if (ok) reloadAll();
        toast[ok ? "success" : "error"](
          ok ? "Marked as unread." : "Couldn't update. Please try again.",
        );
        break;
      }
      case "archive": {
        const ok = await patchThreadStatus(t.id, "closed");
        if (ok) reloadAll();
        toast[ok ? "success" : "error"](ok ? "Archived." : "Couldn't archive. Please try again.");
        break;
      }
      case "inbox": {
        const ok = await patchThreadStatus(t.id, "open");
        if (ok) reloadAll();
        toast[ok ? "success" : "error"](ok ? "Moved to Inbox." : "Couldn't move. Please try again.");
        break;
      }
      case "trash": {
        const ok = await patchThreadTrashed(t.id, true);
        if (ok) {
          if (selectedId === t.id) setSelectedId(null);
          reloadAll();
          toast.info("Moved to Trash.");
        } else {
          toast.error("Couldn't move to Trash. Please try again.");
        }
        break;
      }
      case "restore": {
        const ok = await patchThreadTrashed(t.id, false);
        if (ok) reloadAll();
        toast[ok ? "info" : "error"](
          ok ? "Restored from Trash." : "Couldn't restore. Please try again.",
        );
        break;
      }
    }
  }

  async function bulkStatus(status: "open" | "closed") {
    const ids = selectedArr.map((t) => t.id);
    if (ids.length === 0) return;
    const ok = await patchManyStatus(ids, status);
    const verb = status === "closed" ? "archived" : "moved to Inbox";
    if (ok === ids.length) toast.success(`${ok} ${verb}.`);
    else if (ok > 0) toast.warning(`${ok} of ${ids.length} ${verb}.`);
    else toast.error("Couldn't update. Please try again.");
    clearSelection();
    reloadAll();
  }

  async function bulkRead(value: boolean) {
    const ids = selectedArr.map((t) => t.id);
    if (ids.length === 0) return;
    const ok = await patchManyUnread(ids, value);
    const verb = value ? "unread" : "read";
    if (ok === ids.length) toast.success(`${ok} marked as ${verb}.`);
    else if (ok > 0) toast.warning(`${ok} of ${ids.length} marked as ${verb}.`);
    else toast.error("Couldn't update. Please try again.");
    clearSelection();
    reloadAll();
  }

  async function bulkTrash() {
    const ids = selectedArr.map((t) => t.id);
    if (ids.length === 0) return;
    const confirmed = await dialog.confirm({
      title: `Move ${ids.length} ${ids.length === 1 ? "conversation" : "conversations"} to Trash?`,
      message: "They'll move to the Trash folder. You can restore them from there.",
      confirmLabel: "Move to Trash",
      tone: "danger",
    });
    if (!confirmed) return;
    const ok = await patchManyTrashed(ids, true);
    if (selectedId && ids.includes(selectedId)) setSelectedId(null);
    if (ok === ids.length) toast.info(`${ok} moved to Trash.`);
    else if (ok > 0) toast.warning(`${ok} of ${ids.length} moved to Trash.`);
    else toast.error("Couldn't move to Trash. Please try again.");
    clearSelection();
    reloadAll();
  }

  async function bulkApplyLabel(name: string) {
    const clean = name.trim();
    if (!clean) return;
    const items = selectedArr.map((t) => ({ id: t.id, labels: t.labels }));
    if (items.length === 0) return;
    if (!colorMap.has(clean.toLowerCase())) {
      await createLabel(clean, LABEL_PALETTE[0].value);
    }
    const ok = await patchManyAddLabel(items, clean);
    if (ok === items.length) toast.success(`Labeled ${ok} as "${clean}".`);
    else if (ok > 0) toast.warning(`Labeled ${ok} of ${items.length}.`);
    else toast.error("Couldn't label. Please try again.");
    clearSelection();
    reloadAll();
  }

  async function injectTest() {
    try {
      await api.post("/api/mail-center/test-inject");
    } catch {
      /* ignore — reload just shows nothing changed */
    }
    reloadAll();
  }

  async function setupDeptMailbox(address: string, dept: string) {
    const confirmed = await dialog.confirm({
      title: `Set up ${address}?`,
      message: `Creates the shared ${dept} mailbox so the team can receive and reply from it. You can grant people access in User Management.`,
      confirmLabel: "Set up mailbox",
    });
    if (!confirmed) return;
    const id = await createDeptMailbox(address, dept, `${dept} Team`);
    if (id !== null) {
      toast.success(`${address} is ready.`);
      setFilter({ kind: "mailbox", value: address });
    } else {
      toast.error("Couldn't set up the mailbox. Please try again.");
    }
  }

  const composeDisabled = activeAddresses.length === 0;
  const allVisibleSelected = interactiveVisible.length > 0 && selectedCount >= interactiveVisible.length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Mail className="h-6 w-6 text-accent" />
          <div>
            <h1 className="font-display text-xl font-bold leading-tight text-ink">Mail Center</h1>
            <p className="text-xs text-ink-muted">
              Shared inbox · all customer email in one place
              {unreadCount > 0 ? ` · ${unreadCount} unread` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ViewSettingsMenu prefs={prefs} />
          <button
            onClick={() => reloadAll()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}

      {/* Search — at the TOP (Gmail-style), full-width above the 3-pane grid.
          Was previously buried at the bottom of the left rail, below the whole
          folder list. */}
      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search mail…"
          aria-label="Search all mail"
          className={cn(
            "h-10 w-full rounded-md border border-border bg-surface pl-8 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20",
            listSearching ? "pr-24" : "pr-3",
          )}
        />
        {listSearching && (
          <span
            role="status"
            aria-live="polite"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-medium text-primary"
          >
            Searching…
          </span>
        )}
      </div>

      <div
        className={cn(
          "grid grid-cols-1 gap-4 md:grid-cols-[210px_minmax(0,1fr)]",
          splitView && "lg:grid-cols-[230px_minmax(360px,400px)_minmax(0,1fr)]",
        )}
      >
        {/* LEFT RAIL */}
        <aside className="space-y-3">
          <button
            onClick={() => {
              setResumeDraft(null);
              setComposeOpen(true);
            }}
            disabled={composeDisabled}
            title={
              composeDisabled
                ? "No mailbox assigned — ask an admin to assign an address"
                : "Write a new email"
            }
            className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-primary bg-primary py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-primary-ink disabled:opacity-50"
          >
            <PenSquare className="h-4 w-4" />
            New email
          </button>
          {composeDisabled && (
            <p className="text-[11px] leading-snug text-ink-muted">
              No mailbox assigned yet — "New email" unlocks once an admin assigns
              you an address.
            </p>
          )}

          {/* FOLDERS */}
          <nav className="space-y-0.5">
            <FolderItem icon={InboxIcon} label="Inbox" active={folder === "inbox"} badge={folderCounts.inboxUnread}
              onClick={() => { setFolder("inbox"); setLabelFilter(null); }} />
            <FolderItem icon={Star} label="Starred" active={folder === "starred"} badge={folderCounts.starred} badgeTone="muted"
              onClick={() => { setFolder("starred"); setLabelFilter(null); }} />
            <FolderItem icon={Send} label="Sent" active={folder === "sent"}
              onClick={() => { setFolder("sent"); setLabelFilter(null); }} />
            <FolderItem icon={Bell} label="Auto-sent" active={folder === "autosent"}
              onClick={() => { setFolder("autosent"); setLabelFilter(null); }} />
            <FolderItem icon={Archive} label="Archive" active={folder === "archive"}
              onClick={() => { setFolder("archive"); setLabelFilter(null); }} />
            <FolderItem icon={FileText} label="Drafts" active={folder === "drafts"} badge={drafts.length} badgeTone="muted"
              onClick={() => { setFolder("drafts"); setLabelFilter(null); }} />
            <FolderItem icon={Trash2} label="Trash" active={folder === "trash"} badge={folderCounts.trash} badgeTone="muted"
              onClick={() => { setFolder("trash"); setLabelFilter(null); }} />
            <FolderItem icon={Layers} label="All mail" active={folder === "all"}
              onClick={() => { setFolder("all"); setLabelFilter(null); }} />
          </nav>

          {/* LABELS */}
          <div className="space-y-0.5">
            <div className="flex items-center justify-between px-3 pb-0.5 pt-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted/70">Labels</p>
              <button
                type="button"
                onClick={() => setLabelManagerOpen(true)}
                title="Manage labels"
                aria-label="Manage labels"
                className="rounded p-0.5 text-ink-muted/60 transition hover:bg-surface-dim hover:text-ink"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {labels.length === 0 ? (
              <button
                type="button"
                onClick={() => setLabelManagerOpen(true)}
                className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-ink-muted/70 transition hover:bg-surface-dim"
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Create a label</span>
              </button>
            ) : (
              labels.map((l) => (
                <button
                  key={l.name}
                  onClick={() => setLabelFilter(labelFilter === l.name ? null : l.name)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition",
                    labelFilter === l.name
                      ? "bg-accent-soft font-medium text-primary-ink"
                      : "text-ink/80 hover:bg-surface-dim",
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
                    style={{ backgroundColor: l.color }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{l.name}</span>
                </button>
              ))
            )}
          </div>

          {/* MAILBOX SWITCHER */}
          <div className="space-y-0.5 border-t border-border/60 pt-2">
            <p className="px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted/70">
              Mailboxes
            </p>
            <MailboxItem
              label="All mailboxes"
              active={filter.kind === "all"}
              unread={unreadCount}
              onClick={() => setFilter({ kind: "all" })}
            />
            <p className="flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted/70">
              <Building2 className="h-3 w-3" />
              Departments
            </p>
            {departmentGroups.map((g) => (
              <DeptGroup
                key={g.dept}
                dept={g.dept}
                entries={g.entries}
                filter={filter}
                isAdmin={isAdmin}
                unreadByMailbox={unreadByMailbox}
                unreadForDept={unreadByDept.get(g.dept) ?? 0}
                onSelectDept={() => setFilter({ kind: "dept", value: g.dept })}
                onSelectMailbox={(address) => setFilter({ kind: "mailbox", value: address })}
                onSetupMailbox={setupDeptMailbox}
              />
            ))}
            {personalMailboxes.length > 0 && (
              <>
                <p className="flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted/70">
                  <UserIcon className="h-3 w-3" />
                  Other
                </p>
                <div className="space-y-0.5">
                  {personalMailboxes.map((a) => (
                    <PersonItem
                      key={a.id}
                      label={a.assignedUserName || a.address}
                      title={a.address}
                      active={filter.kind === "mailbox" && filter.value === a.address}
                      unread={unreadByMailbox.get(a.address) ?? 0}
                      onClick={() => setFilter({ kind: "mailbox", value: a.address })}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </aside>

        {/* MIDDLE+RIGHT — "Auto-sent" renders the read-only outbox panel across
            the content area; every other folder keeps the thread list (+ the
            split reading pane). The left rail stays mounted either way. */}
        {folder === "autosent" ? (
          // Only span cols 2-3 when the 3-col SPLIT grid is active; in the 2-col
          // grid a col-span-2 has no col 3 to land in and would wrap the panel.
          <div className={cn("min-w-0", splitView && "lg:col-span-2")}>
            <OutboxPanel q={q} />
          </div>
        ) : (
          <>
        {/* MIDDLE */}
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          {prefs.categoryTabs && folder !== "drafts" && (
            <CategoryTabs active={category} counts={categoryCounts} onSelect={setCategory} />
          )}

          {!listBusy && folder !== "drafts" && interactiveVisible.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-dim/30 px-3 py-1.5">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  aria-label="Select all"
                  onChange={() => (allVisibleSelected ? clearSelection() : selectAllVisible())}
                  className="h-3.5 w-3.5 cursor-pointer rounded border-border text-primary focus:ring-primary/30"
                />
                {selectedCount > 0 ? `${selectedCount} selected` : "Select"}
              </label>
              <span className="text-[11px] text-ink-muted/70">
                {/* Server total across the active filters (not just what's
                    loaded). Falls back to the loaded count for Drafts. */}
                {listTotal} {listTotal === 1 ? "conversation" : "conversations"}
              </span>
            </div>
          )}

          {!listBusy && selectedCount > 0 && folder !== "drafts" && (
            <BulkBar
              count={selectedCount}
              folder={folder}
              labels={labels}
              onArchive={() => bulkStatus("closed")}
              onInbox={() => bulkStatus("open")}
              onRead={() => bulkRead(false)}
              onUnread={() => bulkRead(true)}
              onTrash={bulkTrash}
              onApplyLabel={bulkApplyLabel}
              onClear={clearSelection}
            />
          )}

          {folder === "drafts" ? (
            <DraftsList
              drafts={drafts}
              legacyFound={hasQuarantinedLegacyDrafts()}
              onResume={(d) => {
                setResumeDraft(d);
                setComposeOpen(true);
              }}
              onDiscard={(d) => {
                try {
                  deleteDraft(d.id);
                  toast.success("Draft discarded.");
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Draft could not be discarded. Please try again.");
                }
              }}
            />
          ) : (
            <>
              <ThreadList
                threads={interactiveVisible}
                loading={listBusy}
                activeId={isDesktop && splitView ? selectedId : null}
                folder={folder}
                density={prefs.density}
                selectedIds={selectedVisibleIds}
                colorMap={colorMap}
                onToggleSelect={toggleSelect}
                onOpen={openThread}
                onInjectTest={injectTest}
                onRowAction={onRowAction}
              />
              {/* Server-side pagination: pull the next page in place. The
                  windowed <ul> keeps the DOM light as the array grows. */}
              {!listBusy && listHasMore && (
                <div className="border-t border-border bg-surface-dim/20 p-3 text-center">
                  <button
                    type="button"
                    onClick={loadMoreThreads}
                    disabled={listLoadingMore}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary transition hover:text-ink disabled:opacity-50"
                  >
                    {listLoadingMore
                      ? "Loading…"
                      : `Load more (${listRows.length} of ${listTotal})`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* RIGHT — reading pane (lg+ only, split mode only) */}
        {splitView && (
          <div className="hidden min-w-0 lg:block">
            {selectedId ? (
              <div className="min-w-0 rounded-xl border border-border bg-surface p-4">
                <MailThread key={selectedId} id={selectedId} embedded />
              </div>
            ) : (
              <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-2 px-6 text-center">
                <Mail className="h-8 w-8 text-ink-muted/30" />
                <p className="text-sm text-ink-muted">Select a conversation to read it here</p>
              </div>
            )}
          </div>
        )}
          </>
        )}
      </div>

      <LabelManagerDialog
        open={labelManagerOpen}
        labels={labelCatalog ?? []}
        onClose={() => setLabelManagerOpen(false)}
        onChanged={reloadAll}
      />

      <ComposeDialog
        open={composeOpen}
        initialDraft={resumeDraft}
        onClose={() => {
          setComposeOpen(false);
          setResumeDraft(null);
        }}
        onSent={(threadId) => {
          reloadAll();
          if (isDesktop && splitView) setSelectedId(threadId);
        }}
      />
    </div>
  );
}

export default MailInbox;

// ── Auto-sent panel (outbox) ─────────────────────────────────────────────────
// Read-only view of the system's auto-sent customer notices (Delivery Order
// dispatched, Invoice, etc.) — the emails that go out from a noreply sender so
// there is no human "Sent" copy to read. Lists the org's sent log newest-first
// with a per-row status, and opens the full body (+ recipient / time / failure
// reason / attachment names) in a modal. Data via fetchOutbox / fetchOutboxDetail.
function outboxStatusTone(status: string): string {
  switch (status.toUpperCase()) {
    case "SENT":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200";
    case "FAILED":
      return "bg-err-bg text-err ring-1 ring-inset ring-err/20";
    default:
      return "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200"; // PENDING
  }
}

function outboxStatusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case "SENT":
      return "Sent";
    case "FAILED":
      return "Failed";
    default:
      return "Pending";
  }
}

const fmtMailTime = fmtDateTime;

// One outbox page. The backend caps at 200/page and returns `hasMore` when a
// full page came back; the "Load more" button pulls the next offset so entries
// past the first page are reachable (previously the response's `hasMore` was
// ignored, so only the first 60 were ever visible).
const OUTBOX_PAGE = 60;

function OutboxPanel({ q }: { q: string }) {
  const [items, setItems] = useState<OutboxRow[]>([]);
  const [counts, setCounts] = useState<OutboxCounts>({
    sent: 0,
    failed: 0,
    pending: 0,
  });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const needle = q.trim();

  useEffect(() => {
    // No synchronous setState in the effect body — `loading` starts true for
    // the first load; reloads flip it true in the trigger handlers (filter
    // chip / refresh button). Each filter/search/refresh resets to page 1.
    let alive = true;
    (async () => {
      try {
        const data = await fetchOutbox({
          status: statusFilter || undefined,
          q: needle || undefined,
          limit: OUTBOX_PAGE,
        });
        if (!alive) return;
        setErr(null);
        setItems(Array.isArray(data.rows) ? data.rows : []);
        if (data.counts) setCounts(data.counts);
        setHasMore(!!data.hasMore);
      } catch {
        if (alive) {
          setErr("Couldn't load sent emails.");
          setItems([]);
          setHasMore(false);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [statusFilter, needle, reloadKey]);

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchOutbox({
        status: statusFilter || undefined,
        q: needle || undefined,
        limit: OUTBOX_PAGE,
        offset: items.length,
      });
      setItems((prev) => [
        ...prev,
        ...(Array.isArray(data.rows) ? data.rows : []),
      ]);
      if (data.counts) setCounts(data.counts);
      setHasMore(!!data.hasMore);
      setErr(null);
    } catch {
      setErr("Couldn't load more sent emails.");
    } finally {
      setLoadingMore(false);
    }
  }

  const filters: { v: string; l: string }[] = [
    { v: "", l: "All" },
    { v: "SENT", l: "Sent" },
    { v: "FAILED", l: "Failed" },
    { v: "PENDING", l: "Pending" },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      {/* Header + status roll-up */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-dim/30 px-3 py-2">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-accent" />
          <div>
            <p className="text-sm font-semibold leading-tight text-ink">
              Auto-sent emails
            </p>
            <p className="text-[11px] text-ink-muted">
              Notices the system sent to customers — Delivery Order, Invoice,
              etc. (from noreply)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
            {counts.sent} sent
          </span>
          {counts.failed > 0 && (
            <span className="rounded-full bg-err-bg px-2 py-0.5 font-semibold text-err ring-1 ring-inset ring-err/20">
              {counts.failed} failed
            </span>
          )}
          {counts.pending > 0 && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
              {counts.pending} pending
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setReloadKey((k) => k + 1);
            }}
            className="ml-1 rounded p-1 text-ink-muted transition hover:bg-surface-dim hover:text-ink"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Status filter chips */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
        {filters.map((f) => (
          <button
            key={f.v || "all"}
            type="button"
            onClick={() => {
              if (statusFilter === f.v) return;
              setLoading(true);
              setStatusFilter(f.v);
            }}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[11px] font-medium transition",
              statusFilter === f.v
                ? "bg-accent-soft text-primary-ink"
                : "text-ink-muted hover:bg-surface-dim",
            )}
          >
            {f.l}
          </button>
        ))}
      </div>

      {err && <div className="px-3 py-2 text-sm text-err">{err}</div>}

      {loading && items.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-ink-muted">
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
          <Bell className="h-6 w-6 text-ink-muted/40" />
          <p className="text-sm text-ink-muted">
            No auto-sent emails {statusFilter || needle ? "in this filter" : "yet"}.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                onClick={() => setOpenId(it.id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface-dim/50"
              >
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                    outboxStatusTone(it.status),
                  )}
                >
                  {outboxStatusLabel(it.status)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {it.toAddress || "(no recipient)"}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-muted">
                      {fmtMailTime(it.sentAt || it.createdAt)}
                    </span>
                  </span>
                  <span className="block truncate text-xs text-ink-muted">
                    {it.subject}
                    {it.snippet && (
                      <span className="text-ink-muted/70">
                        {" — "}
                        {it.snippet}
                      </span>
                    )}
                    {it.attachmentNames.length > 0 && (
                      <span className="ml-1 text-ink-muted/70">
                        · {it.attachmentNames.length} attachment
                        {it.attachmentNames.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                  {it.status === "FAILED" && it.lastError && (
                    <span className="block truncate text-[11px] text-err">
                      {it.lastError}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasMore && items.length > 0 && (
        <div className="border-t border-border px-3 py-2 text-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary transition hover:text-ink disabled:opacity-50"
          >
            {loadingMore && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {openId && (
        <OutboxReaderModal id={openId} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

function OutboxReaderModal({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<OutboxDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // No synchronous setState in the effect body; `loading` starts true and the
    // modal mounts once per id, so the fetch just flips it false when done.
    let alive = true;
    (async () => {
      try {
        const j = await fetchOutboxDetail(id);
        if (alive && j) setData(j);
      } catch {
        /* leave data null — body shows "(no content)" */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Auto-sent email"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-slab"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-ink">
              {data?.subject ?? "…"}
            </p>
            <p className="truncate text-xs text-ink-muted">
              To: {data?.toAddress ?? ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-muted transition hover:bg-surface-dim hover:text-ink"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {data && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-dim/20 px-5 py-2 text-xs">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-semibold",
                outboxStatusTone(data.status),
              )}
            >
              {outboxStatusLabel(data.status)}
            </span>
            {data.sentAt ? (
              <span className="text-ink-muted">Sent {fmtMailTime(data.sentAt)}</span>
            ) : (
              <span className="text-ink-muted">
                Queued {fmtMailTime(data.createdAt)}
              </span>
            )}
            {data.attempts > 0 && (
              <span className="text-ink-muted">
                · {data.attempts} attempt{data.attempts === 1 ? "" : "s"}
              </span>
            )}
            {data.attachmentNames.length > 0 && (
              <span className="text-ink-muted">
                · {data.attachmentNames.join(", ")}
              </span>
            )}
          </div>
        )}

        {data?.status === "FAILED" && data.lastError && (
          <div className="border-b border-err/20 bg-err-bg px-5 py-2 text-xs text-err">
            Error: {data.lastError}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="px-5 py-10 text-center text-sm text-ink-muted">
              Loading…
            </div>
          ) : data?.bodyHtml ? (
            // Sandboxed iframe — renders the exact email the customer received,
            // with no script/same-origin access (own templates, but sandbox
            // keeps it safe regardless).
            <iframe
              title="email body"
              sandbox=""
              className="h-[60vh] w-full border-0 bg-white"
              srcDoc={data.bodyHtml}
            />
          ) : (
            <pre className="whitespace-pre-wrap px-5 py-4 text-sm text-ink">
              {data?.bodyText || "(no content)"}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Category tabs ───────────────────────────────────────────────────────────
function CategoryTabs({
  active,
  counts,
  onSelect,
}: {
  active: MailCategory;
  counts: { all: number; primary: number; notifications: number };
  onSelect: (c: MailCategory) => void;
}) {
  const tabs: {
    id: MailCategory;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count: number;
  }[] = [
    { id: "all", label: "All", icon: InboxIcon, count: counts.all },
    { id: "primary", label: "Primary", icon: UserIcon, count: counts.primary },
    { id: "notifications", label: "Notifications", icon: Bell, count: counts.notifications },
  ];
  return (
    <div className="flex items-stretch gap-0.5 border-b border-border bg-surface-dim/20 px-1">
      {tabs.map((t) => {
        const on = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition",
              on ? "border-primary text-primary-ink" : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            <span>{t.label}</span>
            {t.count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  on ? "bg-accent-soft text-primary-ink" : "bg-surface-dim text-ink-muted",
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── View settings menu ───────────────────────────────────────────────────────
function ViewSettingsMenu({ prefs }: { prefs: MailViewPrefs }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="View settings"
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink"
      >
        <SlidersHorizontal className="h-4 w-4" />
        View
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-64 rounded-md border border-border bg-surface p-3 text-left shadow-slab"
        >
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted/70">Density</p>
          <div className="mb-3 grid grid-cols-2 gap-1">
            <SegButton icon={Rows4} label="Compact" active={prefs.density === "compact"} onClick={() => setDensity("compact")} />
            <SegButton icon={Rows3} label="Comfortable" active={prefs.density === "comfortable"} onClick={() => setDensity("comfortable")} />
          </div>
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted/70">Reading pane</p>
          <div className="mb-3 grid grid-cols-2 gap-1">
            <SegButton icon={PanelRight} label="Split" active={prefs.readingPane === "split"} onClick={() => setReadingPane("split")} />
            <SegButton icon={Square} label="No split" active={prefs.readingPane === "full"} onClick={() => setReadingPane("full")} />
          </div>
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted/70">Category tabs</p>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs.categoryTabs}
            onClick={() => setCategoryTabs(!prefs.categoryTabs)}
            className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink/80 transition hover:bg-surface-dim"
          >
            <span className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-ink-muted/60" />
              Show Primary / Notifications
            </span>
            <span
              className={cn(
                "flex h-4 w-7 items-center rounded-full px-0.5 transition",
                prefs.categoryTabs ? "bg-primary" : "bg-ink-muted/30",
              )}
            >
              <span className={cn("h-3 w-3 rounded-full bg-white transition-transform", prefs.categoryTabs && "translate-x-3")} />
            </span>
          </button>
          <p className="mt-2 px-1 text-[10px] leading-snug text-ink-muted/70">
            These choices are saved on this browser.
          </p>
        </div>
      )}
    </div>
  );
}

function SegButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition",
        active ? "border-accent/40 bg-accent-soft text-primary-ink" : "border-border bg-surface text-ink/70 hover:bg-surface-dim",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

// ── Folder row ──────────────────────────────────────────────────────────────
function FolderItem({
  icon: Icon,
  label,
  active,
  badge,
  badgeTone = "accent",
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  badge?: number;
  badgeTone?: "accent" | "muted";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition",
        active ? "bg-accent-soft font-semibold text-primary-ink" : "text-ink/80 hover:bg-surface-dim",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-ink-muted/60")} />
        <span className="truncate">{label}</span>
      </span>
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            badgeTone === "accent"
              ? active
                ? "bg-primary/20 text-primary-ink"
                : "bg-accent-soft text-primary-ink"
              : active
                ? "bg-primary/20 text-primary-ink"
                : "bg-surface-dim text-ink-muted",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// ── Bulk action bar ─────────────────────────────────────────────────────────
function BulkBar({
  count,
  folder,
  labels,
  onArchive,
  onInbox,
  onRead,
  onUnread,
  onTrash,
  onApplyLabel,
  onClear,
}: {
  count: number;
  folder: Folder;
  labels: { name: string; color: string }[];
  onArchive: () => void;
  onInbox: () => void;
  onRead: () => void;
  onUnread: () => void;
  onTrash: () => void;
  onApplyLabel: (name: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-primary/30 bg-accent-soft/70 px-3 py-2">
      <span className="mr-1 text-xs font-medium text-primary-ink">{count} selected</span>
      {folder === "archive" ? (
        <BulkButton icon={InboxIcon} label="Move to Inbox" onClick={onInbox} />
      ) : folder !== "trash" ? (
        <BulkButton icon={Archive} label="Archive" onClick={onArchive} />
      ) : null}
      <BulkButton icon={MailOpen} label="Read" onClick={onRead} />
      <BulkButton icon={MailWarning} label="Unread" onClick={onUnread} />
      <BulkLabelMenu labels={labels} onApplyLabel={onApplyLabel} />
      {folder !== "trash" && <BulkButton icon={Trash2} label="Trash" onClick={onTrash} />}
      <button
        onClick={onClear}
        className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-primary-ink transition hover:bg-primary/15"
      >
        <X className="h-3.5 w-3.5" />
        Clear
      </button>
    </div>
  );
}

function BulkLabelMenu({
  labels,
  onApplyLabel,
}: {
  labels: { name: string; color: string }[];
  onApplyLabel: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function apply(name: string) {
    const clean = name.trim();
    if (!clean) return;
    onApplyLabel(clean);
    setDraft("");
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-surface px-2 py-1 text-xs font-medium text-primary-ink transition hover:bg-primary/15"
      >
        <Tag className="h-3.5 w-3.5" />
        Label
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-20 mt-1 w-52 rounded-md border border-border bg-surface p-1 shadow-slab">
          <div className="max-h-48 overflow-y-auto">
            {labels.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-ink-muted">No labels yet — type one below.</p>
            ) : (
              labels.map((l) => (
                <button
                  key={l.name}
                  type="button"
                  role="menuitem"
                  onClick={() => apply(l.name)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-ink/80 transition hover:bg-surface-dim"
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10" style={{ backgroundColor: l.color }} aria-hidden="true" />
                  <span className="truncate">{l.name}</span>
                </button>
              ))
            )}
          </div>
          <div className="mt-1 flex items-center gap-1 border-t border-border/60 pt-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  apply(draft);
                }
              }}
              placeholder="New label…"
              className="h-7 flex-1 rounded-md border border-border bg-surface px-2 text-xs text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <button
              disabled={!draft.trim()}
              onClick={() => apply(draft)}
              className="inline-flex h-7 items-center rounded-md border border-border bg-surface px-2 text-xs font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BulkButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-surface px-2 py-1 text-xs font-medium text-primary-ink transition hover:bg-primary/15"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

// ── Mailbox switcher rows ───────────────────────────────────────────────────
function MailboxItem({
  label,
  title,
  active,
  unread,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  unread: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition",
        active ? "bg-accent-soft font-medium text-primary-ink" : "text-ink/80 hover:bg-surface-dim",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <CheckCheck className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-ink-muted/60")} />
        <span className="truncate">{label}</span>
      </span>
      {unread > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            active ? "bg-primary/20 text-primary-ink" : "bg-surface-dim text-ink-muted",
          )}
        >
          {unread}
        </span>
      )}
    </button>
  );
}

function DeptGroup({
  dept,
  entries,
  filter,
  isAdmin,
  unreadByMailbox,
  unreadForDept,
  onSelectDept,
  onSelectMailbox,
  onSetupMailbox,
}: {
  dept: string;
  entries: MailboxEntry[];
  filter: MailboxFilter;
  isAdmin: boolean;
  unreadByMailbox: Map<string, number>;
  unreadForDept: number;
  onSelectDept: () => void;
  onSelectMailbox: (address: string) => void;
  onSetupMailbox: (address: string, dept: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const deptActive = filter.kind === "dept" && filter.value === dept;
  const realCount = entries.filter((e) => e.kind === "real").length;

  return (
    <div>
      <div
        className={cn(
          "flex w-full items-center gap-1 rounded-md pr-2 text-sm transition",
          deptActive ? "bg-accent-soft font-medium text-primary-ink" : "text-ink/80 hover:bg-surface-dim",
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? `Collapse ${dept}` : `Expand ${dept}`}
          aria-expanded={expanded}
          className="flex shrink-0 items-center justify-center rounded p-1 text-ink-muted/70 hover:text-ink"
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
        </button>
        <button
          type="button"
          onClick={onSelectDept}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 py-2 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Users className={cn("h-4 w-4 shrink-0", deptActive ? "text-primary" : "text-ink-muted/60")} />
            <span className="truncate font-medium">{dept}</span>
            <span className="shrink-0 text-[11px] font-normal text-ink-muted/70">{realCount}</span>
          </span>
          {unreadForDept > 0 && (
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                deptActive ? "bg-primary/20 text-primary-ink" : "bg-surface-dim text-ink-muted",
              )}
            >
              {unreadForDept}
            </span>
          )}
        </button>
      </div>

      {expanded && (
        <div className="ml-3 space-y-0.5 border-l border-border/60 pl-2">
          {entries.length === 0 && (
            <p className="px-2 py-1.5 text-[11px] italic text-ink-muted/50">No mailbox yet</p>
          )}
          {entries.map((e) => {
            if (e.kind === "missing") {
              return (
                <MissingMailboxItem
                  key={e.address}
                  address={e.address}
                  canSetup={isAdmin}
                  onSetup={() => onSetupMailbox(e.address, e.dept)}
                />
              );
            }
            const a = e.address;
            const mailboxActive = filter.kind === "mailbox" && filter.value === a.address;
            const shared = !(a.assignedUserName ?? "").trim();
            return (
              <PersonItem
                key={a.id}
                label={a.assignedUserName || a.address}
                title={a.address}
                active={mailboxActive}
                shared={shared}
                unread={unreadByMailbox.get(a.address) ?? 0}
                onClick={() => onSelectMailbox(a.address)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function MissingMailboxItem({
  address,
  canSetup,
  onSetup,
}: {
  address: string;
  canSetup: boolean;
  onSetup: () => void;
}) {
  if (!canSetup) {
    return (
      <div
        title={`${address} — not set up yet`}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-muted/50"
      >
        <Mail className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{address}</span>
        <span className="ml-auto shrink-0 text-[10px] italic">not set up</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onSetup}
      title={`Set up the shared mailbox ${address}`}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink-muted/70 transition hover:bg-surface-dim hover:text-ink"
    >
      <Mail className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{address}</span>
      <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">
        <Plus className="h-2.5 w-2.5" />
        Set up
      </span>
    </button>
  );
}

function PersonItem({
  label,
  title,
  active,
  unread,
  shared = false,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  unread: number;
  shared?: boolean;
  onClick: () => void;
}) {
  const Icon = shared ? Users : UserIcon;
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition",
        active ? "bg-accent-soft font-medium text-primary-ink" : "text-ink/75 hover:bg-surface-dim",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-primary" : "text-ink-muted/50")} />
        <span className="truncate">{label}</span>
      </span>
      {unread > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            active ? "bg-primary/20 text-primary-ink" : "bg-surface-dim text-ink-muted",
          )}
        >
          {unread}
        </span>
      )}
    </button>
  );
}

// ── Label manager dialog ─────────────────────────────────────────────────────
function LabelManagerDialog({
  open,
  labels,
  onClose,
  onChanged,
}: {
  open: boolean;
  labels: MailLabel[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(LABEL_PALETTE[0].value);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function handleCreate() {
    const clean = newName.trim();
    if (!clean || busy) return;
    if (labels.some((l) => l.name.toLowerCase() === clean.toLowerCase())) {
      toast.error("A label with that name already exists.");
      return;
    }
    setBusy(true);
    try {
      const ok = await createLabel(clean, newColor);
      if (ok) {
        setNewName("");
        setNewColor(LABEL_PALETTE[0].value);
        toast.success("Label created.");
        onChanged();
      } else {
        toast.error("Couldn't create the label. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRecolor(id: string, color: string) {
    setBusy(true);
    try {
      const ok = await updateLabel(id, { color });
      if (ok) onChanged();
      else toast.error("Couldn't update the colour. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(id: string, name: string, prev: string) {
    const clean = name.trim();
    if (!clean || clean === prev) return;
    if (labels.some((l) => l.id !== id && l.name.toLowerCase() === clean.toLowerCase())) {
      toast.error("A label with that name already exists.");
      return;
    }
    setBusy(true);
    try {
      const ok = await updateLabel(id, { name: clean });
      if (ok) {
        toast.success("Label renamed.");
        onChanged();
      } else toast.error("Couldn't rename the label. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    const confirmed = await dialog.confirm({
      title: `Delete "${name}"?`,
      message: "The label is removed from every conversation that carries it. This can't be undone.",
      confirmLabel: "Delete label",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const ok = await deleteLabel(id);
      if (ok) {
        toast.success("Label deleted.");
        onChanged();
      } else toast.error("Couldn't delete the label. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Manage labels"
        className="relative mx-4 flex max-h-[90vh] w-full max-w-md flex-col rounded-xl border border-border bg-surface shadow-slab"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold text-ink">Manage labels</h3>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-muted transition hover:bg-surface-dim hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div className="space-y-2 rounded-md border border-border bg-surface-dim p-3">
            <label className="text-xs font-medium text-ink-muted">New label</label>
            <div className="flex items-center gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCreate();
                  }
                }}
                placeholder="Label name"
                className="h-8 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <button
                disabled={!newName.trim() || busy}
                onClick={handleCreate}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-primary bg-primary px-2.5 text-white hover:bg-primary-ink disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </button>
            </div>
            <ColorSwatches value={newColor} onPick={setNewColor} />
          </div>

          {labels.length === 0 ? (
            <p className="px-1 py-2 text-center text-xs text-ink-muted">
              No labels yet. Create one above to colour-code conversations.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {labels
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((l) => (
                  <LabelManagerRow
                    key={`${l.id}:${l.name}`}
                    label={l}
                    busy={busy}
                    onRecolor={handleRecolor}
                    onRename={handleRename}
                    onDelete={handleDelete}
                  />
                ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function LabelManagerRow({
  label,
  busy,
  onRecolor,
  onRename,
  onDelete,
}: {
  label: MailLabel;
  busy: boolean;
  onRecolor: (id: string, color: string) => void;
  onRename: (id: string, name: string, prev: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const [name, setName] = useState(label.name);
  const [editingColor, setEditingColor] = useState(false);
  const color = label.color || LABEL_PALETTE[0].value;

  return (
    <li className="relative flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
      <button
        type="button"
        onClick={() => setEditingColor((v) => !v)}
        title="Change colour"
        aria-label="Change colour"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-surface-dim"
      >
        <span className="h-3.5 w-3.5 rounded-full ring-1 ring-inset ring-black/10" style={{ backgroundColor: color }} />
      </button>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => onRename(label.id, name, label.name)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        disabled={busy}
        className="h-7 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        aria-label={`Rename ${label.name}`}
      />
      <button
        type="button"
        onClick={() => onDelete(label.id, label.name)}
        disabled={busy}
        title="Delete label"
        aria-label={`Delete ${label.name}`}
        className="rounded p-1 text-ink-muted/70 transition hover:bg-surface-dim hover:text-err disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      {editingColor && (
        <div className="absolute left-2 top-full z-10 mt-1 rounded-md border border-border bg-surface p-2 shadow-slab">
          <ColorSwatches
            value={color}
            onPick={(c2) => {
              onRecolor(label.id, c2);
              setEditingColor(false);
            }}
          />
        </div>
      )}
    </li>
  );
}

function ColorSwatches({
  value,
  onPick,
}: {
  value: string;
  onPick: (color: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {LABEL_PALETTE.map((c2) => {
        const active = c2.value.toUpperCase() === (value || "").toUpperCase();
        return (
          <button
            key={c2.value}
            type="button"
            onClick={() => onPick(c2.value)}
            title={c2.name}
            aria-label={c2.name}
            aria-pressed={active}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full ring-1 ring-inset ring-black/10 transition",
              active && "ring-2 ring-offset-1 ring-ink",
            )}
            style={{ backgroundColor: c2.value }}
          >
            {active && <Check className="h-3.5 w-3.5 text-white" />}
          </button>
        );
      })}
    </div>
  );
}
