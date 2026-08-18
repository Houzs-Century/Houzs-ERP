import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { MobileVirtualList } from "./MobileVirtualList";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useDebouncedValue } from "../vendor/scm/lib/hooks";
import { formatDate } from "../lib/utils";
import { SearchScopeHint } from "../components/SearchScopeHint";
import "./mobile.css";
import { fmtDate, fmtDateTime, fmtTime as fmtClock } from "../vendor/shared/format";

// Mobile Mail Center — the email client, wired to /api/mail-center. Kept at
// desktop feature parity (MailCenter/Inbox.tsx + Thread.tsx) minus the desktop-
// only split reading pane (single-column push nav is correct for mobile).
//   List:   GET /api/mail-center/threads  (?status= / ?starred=1 / ?mailbox= / ?q=)
//           GET /api/mail-center/addresses (mailbox switcher + compose From)
//           GET /api/mail-center/labels    (label catalogue: name + colour)
//   Reader: GET /api/mail-center/threads/:id  ({ thread, messages[] })  — marks read
//   Send:   POST /api/mail-center/threads/:id/reply  (reply / reply-all)
//           POST /api/mail-center/compose             (new / forward)
//   Mutate: PATCH /api/mail-center/threads/:id  { starred | status:"open"|"closed"
//                                                | trashed | unread | labels }
//   Labels: POST /api/mail-center/labels { name, color } (create-if-new on apply)
//   Attach: GET /api/mail-center/attachments/:id (authed stream -> blob URL)
//
// Presentation is a verbatim port of the owner's mobile design (Houzs Mobile.html
// #m-mail / #mail-thread / #mail-compose) using the .hz-m design classes
// (.hdr .ey .card .avatar .spill .sochip .cal-sel .tinybtn .so-card .so-hd .so-ti
// .so-bd .fld .fld-l .fld-i .actbar .btn .scroll .rbadge). All data + actions are
// unchanged from the live wiring.
//
// Folder -> backend query (mirrors the desktop MailCenter/Inbox mapping):
//   Inbox   -> status=open
//   Starred -> starred=1
//   Sent    -> status=all, narrowed client-side by hasOutbound
//   Drafts  -> local-only on desktop (no backend draft table); shown as empty
//   Archive -> status=closed
//   Trash   -> status=trashed

type Thread = {
  id: string;
  mailboxAddress: string;
  subject: string;
  counterpartyEmail: string;
  counterpartyName: string;
  status: string;
  assignedToUserId?: number | null;
  assignedToName?: string | null;
  lastMessageAt: string;
  lastDirection: string;
  lastSnippet: string;
  messageCount: number;
  unread: boolean;
  starred: boolean;
  labels: string[];
  hasOutbound: boolean;
  createdAt: string;
  trashedAt?: string | null;
};

type Attachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId?: string;
  url: string;
};

type MailLabel = { id: string; name: string; color: string };

type ThreadsPage = {
  threads: Thread[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

type Message = {
  id: string;
  threadId: string;
  direction: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  sentAt: string;
  receivedAt: string;
  createdAt: string;
  attachments?: Attachment[];
};

type ThreadDetail = { thread: Thread; messages: Message[] };

type MailAddress = {
  id: string;
  address: string;
  label: string;
  active: boolean;
};

type Folder = "inbox" | "starred" | "sent" | "drafts" | "archive" | "trash";
type ComposeMode = "new" | "reply" | "replyall" | "forward";

// Folder order mirrors the prototype (Inbox · Starred · Sent · Drafts ·
// Archive); Trash is an extra live-only folder kept at the end.
const FOLDERS: [Folder, string][] = [
  ["inbox", "Inbox"],
  ["starred", "Starred"],
  ["sent", "Sent"],
  ["drafts", "Drafts"],
  ["archive", "Archive"],
  ["trash", "Trash"],
];

// Deterministic avatar colour + initials, matching the design's mailAv/mailIni.
const AV_COLORS = ["#16695f", "#a16a2e", "#2a6f9e", "#7a5c86", "#b45309", "#0e7490"];
const avColor = (s: string) => AV_COLORS[(s || "?").charCodeAt(0) % AV_COLORS.length];
const initials = (s: string) =>
  (s || "?")
    .trim()
    .split(/\s+/)
    .map((w) => w[0] || "")
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

// Label chip colours (from the design's MAIL_LB map). Unknown labels fall back
// to a neutral tone so a new label never crashes the row.
const LABEL_COLORS: Record<string, [string, string]> = {
  Sales: ["#e2f0e9", "#15803D"],
  Supplier: ["#f6efd9", "#B45309"],
  Finance: ["#e4ecf8", "#1D4ED8"],
  Urgent: ["#f8eaea", "#B91C1C"],
  Service: ["#e0f0f4", "#0E7490"],
};
const labelColor = (l: string): [string, string] => LABEL_COLORS[l] ?? ["#eef0ec", "#414539"];

// Catalogue-aware chip colours: a DB label carries a solid dot colour, which we
// render as a tinted pill (label text over a soft wash). Falls back to the
// static map, then a neutral tone, so an unknown label never crashes a row.
function chipColors(label: string, catalog: Map<string, string>): [string, string] {
  const solid = catalog.get(label.toLowerCase());
  if (solid) return [`${solid}1f`, solid];
  return labelColor(label);
}

// List-row time: HH:mm today, "Yesterday", else numeric DD/MM/YYYY (owner
// standard — desktop-parity numeric dates, never short-month names).
const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(+d)) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return fmtClock(d);
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return fmtDate(d);
};

// Message-bubble time: numeric DD/MM/YYYY + HH:mm.
const fmtMsgTime = (m: Message): string => {
  const iso = m.direction === "outbound" ? m.sentAt || m.createdAt : m.receivedAt || m.createdAt;
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(+d)) return "";
  return fmtDateTime(d);
};

const fmtBytes = (n: number): string => {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/** Mail Center — folders, mailbox switcher, search, thread reader + compose. */
export function MobileMailCenter({ onBack }: { onBack?: () => void }) {
  const [folder, setFolder] = useState<Folder>("inbox");
  const [mailbox, setMailbox] = useState<string>("all"); // "all" or an address
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [compose, setCompose] = useState<{ mode: ComposeMode } | null>(null);

  // Mailbox switcher options (scope-bound by the backend) + the label catalogue
  // (name -> colour) so chips render in their managed colours.
  const { data: addresses } = useQuery<MailAddress[]>("/api/mail-center/addresses", () => api.get("/api/mail-center/addresses"), []);
  const activeAddresses = useMemo(() => (addresses ?? []).filter((a) => a.active), [addresses]);
  const { data: labelCatalog } = useQuery<MailLabel[]>("/api/mail-center/labels", () => api.get("/api/mail-center/labels"), []);
  const colorMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of labelCatalog ?? []) if (l.color) m.set((l.name ?? "").toLowerCase(), l.color);
    return m;
  }, [labelCatalog]);

  // Mobile uses the backend's existing paginated search contract, just like
  // desktop. The previous bare-array request was capped at 300 rows and then
  // filtered locally, so mail #301 could never be found from this screen.
  const LIST_PAGE_SIZE = 50;
  const debouncedQ = useDebouncedValue(q, 300);
  const listQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (folder === "inbox") params.set("status", "open");
    else if (folder === "archive") params.set("status", "closed");
    else if (folder === "starred") params.set("starred", "1");
    else if (folder === "sent") params.set("sent", "1");
    else if (folder === "trash") params.set("status", "trashed");
    if (mailbox !== "all") params.set("mailbox", mailbox);
    const needle = debouncedQ.trim();
    if (needle) params.set("q", needle);
    return params.toString();
  }, [folder, mailbox, debouncedQ]);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsQuery, setThreadsQuery] = useState("");
  const [listTotal, setListTotal] = useState(0);
  const [listPage, setListPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const listGenerationRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const reload = () => setReloadKey((key) => key + 1);

  useEffect(() => {
    const generation = ++listGenerationRef.current;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    setLoadingMore(false);
    setLoadMoreError(null);
    if (folder === "drafts") {
      setThreads([]);
      setListTotal(0);
      setHasMore(false);
      setLoading(false);
      setError(null);
      return;
    }

    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams(listQuery);
    params.set("page", "1");
    params.set("pageSize", String(LIST_PAGE_SIZE));
    void api
      .get<ThreadsPage>(`/api/mail-center/threads?${params.toString()}`, {
        signal: ctrl.signal,
      })
      .then((data) => {
        if (ctrl.signal.aborted || generation !== listGenerationRef.current) return;
        setThreads(Array.isArray(data.threads) ? data.threads : []);
        setThreadsQuery(listQuery);
        setListTotal(Number(data.total ?? 0));
        setListPage(1);
        setHasMore(!!data.hasMore);
      })
      .catch((reason) => {
        if (ctrl.signal.aborted || generation !== listGenerationRef.current) return;
        setThreads([]);
        setThreadsQuery(listQuery);
        setListTotal(0);
        setHasMore(false);
        setError(reason instanceof Error ? reason.message : "Couldn't load mail.");
      })
      .finally(() => {
        if (!ctrl.signal.aborted && generation === listGenerationRef.current) {
          setLoading(false);
        }
      });

    return () => {
      ctrl.abort();
      loadMoreAbortRef.current?.abort();
    };
  }, [folder, listQuery, reloadKey]);

  const loadMore = async () => {
    if (loadingMore || loadMoreAbortRef.current || !hasMore || folder === "drafts") return;
    const generation = listGenerationRef.current;
    const ctrl = new AbortController();
    loadMoreAbortRef.current = ctrl;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const nextPage = listPage + 1;
      const params = new URLSearchParams(listQuery);
      params.set("page", String(nextPage));
      params.set("pageSize", String(LIST_PAGE_SIZE));
      const data = await api.get<ThreadsPage>(
        `/api/mail-center/threads?${params.toString()}`,
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || generation !== listGenerationRef.current) return;
      setThreads((previous) => [
        ...previous,
        ...(Array.isArray(data.threads) ? data.threads : []),
      ]);
      setListTotal(Number(data.total ?? 0));
      setListPage(nextPage);
      setHasMore(!!data.hasMore);
    } catch (reason) {
      if (ctrl.signal.aborted || generation !== listGenerationRef.current) return;
      setLoadMoreError(reason instanceof Error ? reason.message : "Couldn't load more mail.");
    } finally {
      if (loadMoreAbortRef.current === ctrl) {
        loadMoreAbortRef.current = null;
        setLoadingMore(false);
      }
    }
  };

  const searching =
    folder !== "drafts" && q.trim().length > 0 &&
    (q.trim() !== debouncedQ.trim() || loading);
  const listBusy =
    folder !== "drafts" && (loading || searching || threadsQuery !== listQuery);

  if (openId) {
    return (
      <MailThread
        threadId={openId}
        colorMap={colorMap}
        catalog={labelCatalog ?? []}
        onBack={() => {
          setOpenId(null);
          reload();
        }}
        onCompose={(mode) => setCompose({ mode })}
        composeFor={compose}
        clearCompose={() => setCompose(null)}
        onSent={() => {
          setCompose(null);
          reload();
        }}
        addresses={activeAddresses}
      />
    );
  }

  if (compose) {
    return (
      <MailCompose
        mode={compose.mode}
        addresses={activeAddresses}
        onClose={() => setCompose(null)}
        onSent={() => {
          setCompose(null);
          reload();
        }}
      />
    );
  }

  // Designer list layout (#m-mail): a "Menu" (hamburger + label, left) that
  // returns to the module menu via onBack + a "New" pencil button (right) that
  // opens compose, then the "Mail Center" title below, the mailbox switcher, a
  // search bar and the horizontal folder chip strip. Rows are avatar + name /
  // subject / snippet / labels with a trailing unread dot. NO compose FAB — the
  // "New" header button is the single compose entry point (matches the design).
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
          {onBack ? (
            <span onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#16695f", cursor: "pointer" }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
              Menu
            </span>
          ) : <span />}
          <button
            onClick={() => setCompose({ mode: "new" })}
            className="tinybtn"
            style={{ background: "#16695f", borderColor: "#16695f", color: "#fff", display: "flex", alignItems: "center", gap: 5 }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            New
          </button>
        </div>
        <div className="scr-title" style={{ marginBottom: 9 }}>Mail Center</div>

        <select
          value={mailbox}
          onChange={(e) => setMailbox(e.target.value)}
          className="cal-sel"
          style={{ marginBottom: 9 }}
        >
          <option value="all">All mailboxes</option>
          {activeAddresses.map((a) => (
            <option key={a.id} value={a.address}>
              {a.address}
            </option>
          ))}
        </select>

        <div className="searchbar" style={{ marginBottom: 9 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--mut2)" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search mail &middot; sender &middot; subject"
            aria-label="Search all mail"
          />
          {searching && (
            <span role="status" aria-live="polite" style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: "#16695f", whiteSpace: "nowrap" }}>
              Searching…
            </span>
          )}
        </div>
        <SearchScopeHint
          scope="server"
          searching={searching}
          countPending={loading || Boolean(error) || threadsQuery !== listQuery}
          resultCount={listTotal}
          term={q}
          className="-mt-1 mb-2 px-1"
        />

        <div className="chips" style={{ display: "flex", gap: 7, overflowX: "auto" }}>
          {FOLDERS.map(([f, label]) => (
            <button key={f} className={"chip" + (folder === f ? " on" : "")} onClick={() => setFolder(f)}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: "11px 12px" }}>
        {listBusy && <Muted>{searching ? `Searching for “${q.trim()}”…` : "Loading…"}</Muted>}
        {!listBusy && error && <Muted tone="error">Couldn't load mail. {error}</Muted>}
        {!listBusy && !error && folder === "drafts" && (
          <div className="empty">
            <div className="empty-t">No drafts here</div>
            <div className="empty-s">Drafts are kept on the desktop app only.</div>
          </div>
        )}
        {!listBusy && !error && folder !== "drafts" && threads.length === 0 && (
          <div className="empty">
            <div className="empty-t">No messages</div>
            <div className="empty-s">{folder === "trash" ? "Trash is empty." : `Nothing in ${folder}.`}</div>
          </div>
        )}
        {!listBusy && !error && folder !== "drafts" && threads.length > 0 && (
          <>
            <MobileVirtualList
              items={threads}
              getKey={(t) => t.id}
              estimateHeight={74}
              gap={8}
              renderItem={(t) => (
                <ThreadRow key={t.id} t={t} colorMap={colorMap} onOpen={() => setOpenId(t.id)} />
              )}
            />
            {hasMore && (
              <div style={{ padding: "14px 0 4px", textAlign: "center" }}>
                <button
                  type="button"
                  className="tinybtn"
                  onClick={loadMore}
                  disabled={loadingMore}
                  aria-label={`Load more mail. ${threads.length} of ${listTotal} loaded.`}
                >
                  {loadingMore ? "Loading…" : `Load more (${threads.length} of ${listTotal})`}
                </button>
              </div>
            )}
            {loadMoreError && (
              <div role="alert" style={{ padding: "10px 12px", textAlign: "center", fontSize: 11.5, color: "var(--red)" }}>
                Couldn't load more mail. Please try again.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Designer list row (#m-mail / renderMail): a leading counterparty AVATAR
// (deterministic colour + initials), the name + star + received time, the
// subject (bold when unread) with the thread message count, a one-line snippet,
// label chips, and a TRAILING teal unread dot. The unread border tint + weight
// come from the live thread.unread. Star + reply direction stay from the wiring.
function ThreadRow({ t, colorMap, onOpen }: { t: Thread; colorMap: Map<string, string>; onOpen: () => void }) {
  const who = t.counterpartyName || t.counterpartyEmail || "(unknown)";
  return (
    <div
      onClick={onOpen}
      style={{ display: "flex", gap: 11, background: "#fff", border: `1px solid ${t.unread ? "#bcdcd7" : "#e3e6e0"}`, borderRadius: 13, padding: "11px 12px", cursor: "pointer" }}
    >
      <div style={{ width: 38, height: 38, flex: "none", borderRadius: "50%", background: avColor(who), color: "#fff", fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {initials(who)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: t.unread ? 800 : 600, color: "#11140f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{who}</span>
          {t.starred && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#d8a85a" stroke="#d8a85a" strokeWidth="1.5" style={{ flex: "none" }}>
              <path d="M12 2l3 6 6 .9-4.5 4.3 1 6-5.5-3-5.5 3 1-6L3 8.9 9 8Z" />
            </svg>
          )}
          <span className="money" style={{ fontSize: 10, color: "#9aa093", flex: "none", whiteSpace: "nowrap" }}>{fmtTime(t.lastMessageAt)}</span>
        </div>
        <div style={{ fontSize: 12.5, fontWeight: t.unread ? 700 : 500, color: "#11140f", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t.lastDirection === "outbound" ? "You: " : ""}
          {t.subject}
          {t.messageCount > 1 && <span style={{ color: "#9aa093", fontWeight: 600 }}> ({t.messageCount})</span>}
        </div>
        <div style={{ fontSize: 11.5, color: "#767b6e", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.lastSnippet}</div>
        {t.labels.length > 0 && (
          <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
            {t.labels.map((l) => {
              const [bg, fg] = chipColors(l, colorMap);
              return (
                <span key={l} className="rbadge" style={{ background: bg, color: fg }}>
                  {l}
                </span>
              );
            })}
          </div>
        )}
      </div>
      {t.unread && <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: "#16695f", marginTop: 6 }} />}
    </div>
  );
}

function MailThread({
  threadId,
  colorMap,
  catalog,
  onBack,
  onCompose,
  composeFor,
  clearCompose,
  onSent,
  addresses,
}: {
  threadId: string;
  colorMap: Map<string, string>;
  catalog: MailLabel[];
  onBack: () => void;
  onCompose: (mode: ComposeMode) => void;
  composeFor: { mode: ComposeMode } | null;
  clearCompose: () => void;
  onSent: () => void;
  addresses: MailAddress[];
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const { data, loading, error, reload } = useQuery<ThreadDetail>("/api/mail-center/threads/:",
    () => api.get(`/api/mail-center/threads/${threadId}`),
    [threadId],
  );

  const thread = data?.thread;
  const messages = data?.messages ?? [];

  // Reply / reply-all reuse the same in-thread reply endpoint. Forward starts a
  // new conversation (compose) with a prefilled subject/body.
  if (composeFor && (composeFor.mode === "reply" || composeFor.mode === "replyall")) {
    return (
      <MailReply
        thread={thread}
        onClose={clearCompose}
        onSent={() => {
          clearCompose();
          reload();
          onSent();
        }}
        addresses={addresses}
      />
    );
  }
  if (composeFor && composeFor.mode === "forward") {
    return (
      <MailCompose
        mode="forward"
        addresses={addresses}
        seed={buildForwardSeed(thread, messages)}
        onClose={clearCompose}
        onSent={() => {
          clearCompose();
          onSent();
        }}
      />
    );
  }

  const trashed = thread?.trashedAt != null;
  const closed = thread?.status === "closed";

  const patch = async (body: Record<string, unknown>, ok: string, err: string) => {
    if (!thread || busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/mail-center/threads/${thread.id}`, body);
      toast.success(ok);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : err);
    } finally {
      setBusy(false);
    }
  };

  const toggleStar = () =>
    patch({ starred: !thread?.starred }, thread?.starred ? "Star removed." : "Starred.", "Couldn't update star.");

  const archive = () =>
    closed
      ? patch({ status: "open" }, "Moved to Inbox.", "Couldn't move to Inbox.")
      : patch({ status: "closed" }, "Archived.", "Couldn't archive.");

  const markUnread = () => patch({ unread: true }, "Marked as unread.", "Couldn't update.");

  const trash = async () => {
    if (!thread || busy) return;
    if (trashed) {
      await patch({ trashed: false }, "Restored from Trash.", "Couldn't restore.");
      return;
    }
    const okConfirm = await confirm({
      title: "Move to Trash?",
      body: "This conversation moves to the Trash folder. You can restore it from there.",
      confirmLabel: "Move to Trash",
      danger: true,
    });
    if (!okConfirm) return;
    await patch({ trashed: true }, "Moved to Trash.", "Couldn't move to Trash.");
    onBack();
  };

  const chips = thread?.labels ?? [];
  const applyLabel = async (name: string) => {
    if (!thread || busy) return;
    const clean = name.trim();
    if (!clean || chips.some((l) => l.toLowerCase() === clean.toLowerCase())) {
      setLabelOpen(false);
      return;
    }
    setBusy(true);
    try {
      // Create the catalogue entry first if it is a brand-new name, so the chip
      // gets a managed colour (matches the desktop add-label flow).
      if (!colorMap.has(clean.toLowerCase())) {
        try {
          await api.post("/api/mail-center/labels", { name: clean, color: "#16695f" });
        } catch {
          /* non-fatal — the thread label still applies */
        }
      }
      await api.patch(`/api/mail-center/threads/${thread.id}`, { labels: [...chips, clean] });
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add label.");
    } finally {
      setBusy(false);
      setLabelOpen(false);
    }
  };
  const removeLabel = async (name: string) => {
    if (!thread || busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/mail-center/threads/${thread.id}`, {
        labels: chips.filter((l) => l.toLowerCase() !== name.toLowerCase()),
      });
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove label.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button onClick={onBack} className="back">
            <span className="chev">&#8249;</span> Mail
          </button>
          {thread && (
            <div style={{ display: "flex", gap: 7 }}>
              <button onClick={toggleStar} disabled={busy} className="tinybtn" style={thread.starred ? { color: "#d8a85a" } : undefined}>
                {thread.starred ? "★ Starred" : "☆ Star"}
              </button>
              <button onClick={archive} disabled={busy} className="tinybtn">
                {closed ? "Move to Inbox" : "Archive"}
              </button>
            </div>
          )}
        </div>
        {thread && (
          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", marginTop: 8, lineHeight: 1.2, letterSpacing: "-.01em" }}>{thread.subject}</div>
        )}

        {thread && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7, alignItems: "center" }}>
            {chips.map((l) => {
              const [bg, fg] = chipColors(l, colorMap);
              return (
                <span key={l} className="spill" style={{ display: "inline-flex", alignItems: "center", gap: 5, background: bg, color: fg }}>
                  {l}
                  <span
                    role="button"
                    aria-label={`Remove label ${l}`}
                    onClick={() => !busy && removeLabel(l)}
                    style={{ cursor: busy ? "default" : "pointer", opacity: 0.75, fontSize: 12, lineHeight: 1 }}
                  >
                    &times;
                  </span>
                </span>
              );
            })}
            <button
              onClick={() => setLabelOpen(true)}
              disabled={busy}
              className="tinybtn"
              style={{ borderStyle: "dashed", height: 22, padding: "0 9px" }}
            >
              + Label
            </button>
            <button onClick={markUnread} disabled={busy} className="tinybtn" style={{ height: 22, padding: "0 9px" }}>
              Mark unread
            </button>
            <button
              onClick={trash}
              disabled={busy}
              className="tinybtn"
              style={{ height: 22, padding: "0 9px", background: "#fbf1f0", borderColor: "#e3c4c1", color: "#b23a3a" }}
            >
              {trashed ? "Restore" : "Trash"}
            </button>
          </div>
        )}
      </header>

      <div className="scroll" style={{ padding: 14 }}>
        {loading && <Muted>Loading&#8230;</Muted>}
        {!loading && error && <Muted tone="error">Couldn't load this thread. {error}</Muted>}
        {!loading && !error && messages.length === 0 && <Muted>No messages in this thread.</Muted>}
        {!loading &&
          !error &&
          messages.map((m) => <MessageBubble key={m.id} m={m} />)}
      </div>

      {thread && (
        <footer className="actbar">
          <div style={{ display: "flex", gap: 7 }}>
            <button onClick={() => onCompose("reply")} className="btn" style={{ flex: 1, fontSize: 13.5, padding: "13px 6px" }}>
              Reply
            </button>
            <button
              onClick={() => onCompose("replyall")}
              className="btn"
              style={{ flex: 1, fontSize: 13.5, padding: "13px 6px", background: "#fff", color: "#16695f", border: "1.5px solid #16695f" }}
            >
              Reply all
            </button>
            <button
              onClick={() => onCompose("forward")}
              className="btn"
              style={{ flex: 1, fontSize: 13.5, padding: "13px 6px", background: "#fff", color: "#16695f", border: "1.5px solid #16695f" }}
            >
              Forward
            </button>
          </div>
        </footer>
      )}

      {labelOpen && (
        <LabelPicker
          catalog={catalog}
          applied={chips}
          onPick={applyLabel}
          onClose={() => setLabelOpen(false)}
        />
      )}
    </div>
  );
}

// Bottom-sheet label picker — apply an existing catalogue label (or type a new
// one). Applying is a single PATCH of the thread's label set. Colour-manager
// CRUD is desktop-only; here we display + apply/remove, per the mobile scope.
function LabelPicker({
  catalog,
  applied,
  onPick,
  onClose,
}: {
  catalog: MailLabel[];
  applied: string[];
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState("");
  const appliedLc = new Set(applied.map((l) => l.toLowerCase()));
  const available = catalog.filter((l) => !appliedLc.has((l.name ?? "").toLowerCase()));
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "flex-end" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="hz-m so-card"
        style={{ width: "100%", borderTopLeftRadius: 18, borderTopRightRadius: 18, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, padding: "16px 16px calc(env(safe-area-inset-bottom) + 18px)", maxHeight: "70vh", overflowY: "auto", marginBottom: 0 }}
      >
        <div className="eyebrow" style={{ marginBottom: 3 }}>Labels</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)", marginBottom: 12 }}>Add label</div>
        {available.length === 0 && <Muted>No other labels. Type one below.</Muted>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 14 }}>
          {available.map((l) => (
            <button
              key={l.id}
              onClick={() => onPick(l.name)}
              className="tinybtn"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px", background: "#fff", fontSize: 12.5 }}
            >
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: l.color || "#767b6e", flex: "none" }} />
              {l.name}
            </button>
          ))}
        </div>
        <label className="fld" style={{ flexDirection: "row", gap: 8, alignItems: "stretch" }}>
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="New label&#8230;"
            className="fld-i"
            style={{ flex: 1 }}
          />
          <button
            onClick={() => custom.trim() && onPick(custom.trim())}
            disabled={!custom.trim()}
            className="btn"
            style={{ width: "auto", padding: "0 18px", opacity: custom.trim() ? 1 : 0.55 }}
          >
            Add
          </button>
        </label>
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: Message }) {
  const out = m.direction === "outbound";
  const who = out ? m.fromName || "You" : m.fromName || m.fromAddress || "Sender";
  const atts = m.attachments ?? [];
  // Prefer real HTML (htmlBody, or a textBody that is actually HTML) rendered in
  // a sandboxed iframe; fall back to escaped plain text otherwise. Mirrors the
  // desktop Thread.tsx rawHtml/plain split.
  const rawHtml = m.htmlBody?.trim() || (looksLikeHtml(m.textBody) ? (m.textBody || "").trim() : "");
  const plain = rawHtml ? "" : m.textBody?.trim() || stripHtml(m.htmlBody);
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
      <div style={{ width: 34, height: 34, flex: "none", borderRadius: "50%", background: out ? "#15161a" : avColor(who), color: "#fff", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {initials(who)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f" }}>{who}</span>
          {!out && m.fromAddress && (
            <span style={{ fontSize: 10, color: "#9aa093", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.fromAddress}</span>
          )}
          <span style={{ fontSize: 10, color: "#9aa093", marginLeft: "auto", flex: "none" }}>{fmtMsgTime(m)}</span>
        </div>
        {rawHtml ? (
          <div style={{ background: out ? "#e1efed" : "#f4f6f3", borderRadius: 11, padding: "6px 8px", marginTop: 5 }}>
            <HtmlBody html={rawHtml} attachments={atts} />
          </div>
        ) : (
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "#414539", marginTop: 5, background: out ? "#e1efed" : "#f4f6f3", borderRadius: 11, padding: "11px 12px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {plain || "(empty)"}
          </div>
        )}
        {atts.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {atts.map((a) => (
              <AttachmentChip key={a.id} a={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Render an email's HTML in a sandboxed iframe (sandbox="" — no scripts, no
// same-origin), auto-sizing to content on load. Inline images referenced by
// cid: are rewritten to authed blob: URLs resolved from the message's
// attachments (contentId), matching the desktop reader. Anything that can't be
// resolved falls back to the untouched HTML.
function HtmlBody({ html, attachments }: { html: string; attachments: Attachment[] }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [doc, setDoc] = useState<string>(() => emailSrcDoc(html));

  const inlineImgs = useMemo(
    () => attachments.filter((a) => a.contentId && /^image\//i.test(a.contentType || "")),
    [attachments],
  );

  useEffect(() => {
    let revoked = false;
    const made: string[] = [];
    (async () => {
      let out = html;
      if (inlineImgs.length > 0 && /cid:/i.test(html)) {
        for (const a of inlineImgs) {
          const cid = (a.contentId || "").replace(/^<|>$/g, "");
          if (!cid) continue;
          try {
            const url = await api.fetchBlobUrl(a.url);
            if (revoked) {
              URL.revokeObjectURL(url);
              return;
            }
            made.push(url);
            // Replace every cid:<id> reference (quoted or not) with the blob URL.
            const esc = cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            out = out.replace(new RegExp(`cid:${esc}`, "gi"), url);
          } catch {
            /* leave the cid reference as-is; the image just won't load */
          }
        }
      }
      if (!revoked) setDoc(emailSrcDoc(out));
    })();
    return () => {
      revoked = true;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [html, inlineImgs]);

  return (
    <iframe
      ref={frameRef}
      title="Email"
      // allow-same-origin (NOT allow-scripts) — scripts stay blocked, but the
      // frame can be measured on load so it auto-sizes to its content.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      style={{ width: "100%", border: "none", background: "transparent", minHeight: 60 }}
      onLoad={(e) => {
        try {
          const d = e.currentTarget.contentWindow?.document;
          if (d) e.currentTarget.style.height = `${Math.min(d.body.scrollHeight + 16, 4000)}px`;
        } catch {
          /* keep the min height if measurement is blocked */
        }
      }}
    />
  );
}

function AttachmentChip({ a }: { a: Attachment }) {
  const toast = useToast();
  const open = async () => {
    try {
      // Attachments are served through an authed stream route, not a public URL.
      const url = await api.fetchBlobUrl(a.url);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't open attachment.");
    }
  };
  return (
    <div
      onClick={open}
      style={{ border: "1px solid #e3e6e0", borderRadius: 11, padding: "10px 12px", display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 8 12 17a4 4 0 0 1-6-6l9-9a3 3 0 0 1 4 4l-9 9" />
      </svg>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: "#11140f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.filename}</span>
      {a.sizeBytes > 0 && <span style={{ fontSize: 10.5, color: "#9aa093", flex: "none" }}>{fmtBytes(a.sizeBytes)}</span>}
      <span style={{ fontSize: 11, fontWeight: 700, color: "#a16a2e", flex: "none" }}>Download</span>
    </div>
  );
}

/** Reply / reply-all — POST /api/mail-center/threads/:id/reply. The backend
 *  addresses the counterparty and prefixes Re: itself; the From defaults to the
 *  thread's mailbox but can be overridden with a mailbox in scope. */
function MailReply({
  thread,
  onClose,
  onSent,
  addresses,
}: {
  thread: Thread | undefined;
  onClose: () => void;
  onSent: () => void;
  addresses: MailAddress[];
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [from, setFrom] = useState(thread?.mailboxAddress || "");
  const [sending, setSending] = useState(false);
  const subject = /^re:/i.test(thread?.subject ?? "") ? thread?.subject ?? "" : `Re: ${thread?.subject ?? ""}`;

  const send = async () => {
    if (!thread) return;
    if (!text.trim()) {
      toast.error("Message body is empty.");
      return;
    }
    setSending(true);
    try {
      await api.post(`/api/mail-center/threads/${thread.id}/reply`, {
        text: text.trim(),
        fromAddress: from || undefined,
      });
      toast.success("Reply sent.");
      onSent();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send reply.");
    } finally {
      setSending(false);
    }
  };

  return (
    <ComposeShell title="Reply" onClose={onClose} onSend={send} sending={sending}>
      <label className="fld">
        <span className="fld-l">To</span>
        <input className="fld-i" value={thread?.counterpartyName || thread?.counterpartyEmail || "—"} disabled readOnly />
      </label>
      <FromPicker addresses={addresses} value={from} onChange={setFrom} />
      <label className="fld">
        <span className="fld-l">Subject</span>
        <input className="fld-i" value={subject} disabled readOnly />
      </label>
      <label className="fld">
        <span className="fld-l">Message</span>
        <textarea className="fld-i" value={text} onChange={(e) => setText(e.target.value)} rows={8} style={{ resize: "none" }} placeholder="Write your reply&#8230;" />
      </label>
    </ComposeShell>
  );
}

/** New / Forward — POST /api/mail-center/compose. Requires fromAddress, to,
 *  subject and body. Forward seeds subject + quoted body but leaves To blank. */
function MailCompose({
  mode,
  addresses,
  seed,
  onClose,
  onSent,
}: {
  mode: ComposeMode;
  addresses: MailAddress[];
  seed?: { subject: string; body: string };
  onClose: () => void;
  onSent: () => void;
}) {
  const toast = useToast();
  const [to, setTo] = useState("");
  const [from, setFrom] = useState(addresses[0]?.address ?? "");
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [text, setText] = useState(seed?.body ?? "");
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!from) {
      toast.error("Choose a mailbox to send from.");
      return;
    }
    if (!to.trim()) {
      toast.error("Enter a recipient.");
      return;
    }
    if (!subject.trim()) {
      toast.error("Enter a subject.");
      return;
    }
    if (!text.trim()) {
      toast.error("Message body is empty.");
      return;
    }
    setSending(true);
    try {
      await api.post("/api/mail-center/compose", {
        fromAddress: from,
        to: to.trim(),
        subject: subject.trim(),
        text: text.trim(),
      });
      toast.success("Email sent.");
      onSent();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send email.");
    } finally {
      setSending(false);
    }
  };

  return (
    <ComposeShell title={mode === "forward" ? "Forward" : "New email"} onClose={onClose} onSend={send} sending={sending}>
      <FromPicker addresses={addresses} value={from} onChange={setFrom} />
      <label className="fld">
        <span className="fld-l">To</span>
        <input className="fld-i" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" />
      </label>
      <label className="fld">
        <span className="fld-l">Subject</span>
        <input className="fld-i" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
      </label>
      <label className="fld">
        <span className="fld-l">Message</span>
        <textarea className="fld-i" value={text} onChange={(e) => setText(e.target.value)} rows={8} style={{ resize: "none" }} placeholder="Write your email&#8230;" />
      </label>
    </ComposeShell>
  );
}

function FromPicker({ addresses, value, onChange }: { addresses: MailAddress[]; value: string; onChange: (v: string) => void }) {
  return (
    <label className="fld">
      <span className="fld-l">From</span>
      <select className="fld-i" value={value} onChange={(e) => onChange(e.target.value)}>
        {addresses.length === 0 && <option value="">No mailbox available</option>}
        {addresses.map((a) => (
          <option key={a.id} value={a.address}>
            {a.address}
          </option>
        ))}
      </select>
    </label>
  );
}

function ComposeShell({
  title,
  onClose,
  onSend,
  sending,
  children,
}: {
  title: string;
  onClose: () => void;
  onSend: () => void;
  sending: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <div className="eyebrow">Compose</div>
            <div className="scr-title">{title}</div>
          </div>
          <span onClick={onClose} style={{ fontSize: 24, color: "var(--mut)", cursor: "pointer", lineHeight: 1 }}>
            &times;
          </span>
        </div>
      </header>
      <div className="scroll" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        {children}
      </div>
      <footer className="actbar">
        <button onClick={onSend} disabled={sending} className="btn" style={{ opacity: sending ? 0.6 : 1 }}>
          {sending ? "Sending…" : "Send"}
        </button>
      </footer>
    </div>
  );
}

function Muted({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div style={{ textAlign: "center", fontSize: 12, color: tone === "error" ? "var(--red)" : "var(--mut2)", padding: "30px 0" }}>{children}</div>
  );
}

// True when a string carries real HTML markup (so a textBody that is actually
// HTML still renders in the iframe). Ported from the desktop Thread.tsx.
function looksLikeHtml(s: string | undefined): boolean {
  return /<(?:!doctype|html|body|head|div|table|tr|td|p|br|span|a|img|style|font|center|ul|ol|li|h[1-6])[\s>/]/i.test(
    s || "",
  );
}

// Wrap raw email HTML in a self-contained document with a responsive base style
// and a new-tab base target, injected into the existing <head> when present.
// Ported from the desktop Thread.tsx emailSrcDoc.
function emailSrcDoc(rawHtml: string): string {
  const inject = `<base target="_blank"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:10px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#11140f;word-break:break-word;overflow-x:hidden;background:transparent}img{max-width:100%;height:auto}table{max-width:100%}</style>`;
  if (/<head[^>]*>/i.test(rawHtml)) return rawHtml.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  if (/<html[^>]*>/i.test(rawHtml)) return rawHtml.replace(/<html([^>]*)>/i, `<html$1><head>${inject}</head>`);
  return `<!doctype html><html><head>${inject}</head><body>${rawHtml}</body></html>`;
}

// Strip HTML to a readable plain-text fallback when a message has no textBody.
function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Forward seed: Fwd: subject + a quoted transcript of the thread. To stays blank
// so the user picks a new recipient (compose requires a valid To).
function buildForwardSeed(thread: Thread | undefined, messages: Message[]): { subject: string; body: string } {
  const base = thread?.subject ?? "";
  const subject = /^fwd:/i.test(base) ? base : `Fwd: ${base}`;
  const quoted = messages
    .map((m) => {
      const who = m.direction === "outbound" ? m.fromName || "You" : m.fromName || m.fromAddress || "Sender";
      const when = fmtMsgTime(m);
      const body = m.textBody || stripHtml(m.htmlBody);
      return `On ${when}, ${who} wrote:\n${body}`;
    })
    .join("\n\n---\n\n");
  const body = `\n\n---------- Forwarded message ----------\n${quoted}`;
  return { subject, body };
}
