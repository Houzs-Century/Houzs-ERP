// ---------------------------------------------------------------------------
// Mail Center — thread detail (reply + resolve/reopen + assign).
//
// Renders a conversation's messages. HTML bodies render inside a SANDBOXED
// iframe (no allow-scripts); plain text renders as an escaped text node. Adds an
// in-ERP reply composer (POST .../reply, sent via Resend) and a resolve/reopen
// control (PATCH .../:id status).
//
// DUAL-MODE: this same component powers BOTH
//   • the standalone /mail-center/:id route  (id from useParams), and
//   • the desktop reading pane embedded inside Inbox.tsx (id passed as a prop,
//     embedded=true to drop the page wrapper + the "Back to inbox" button).
//
// Attachment chips point at the authed streaming route
// GET /api/mail-center/attachments/:id (fetched via api.fetchBlobUrl, which
// attaches the bearer) rather than a signed URL.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { useBranding } from "../../hooks/useBranding";
import { cn } from "../../lib/utils";
import { pickDefaultFromAddress } from "./mail-from-default";
import {
  MAIL_ATTACH_MAX_COUNT,
  MAIL_ATTACH_MAX_TOTAL_BYTES,
} from "./mail-attachments";
// Shared with desktop Compose and the phone — one pick → read → validate rule.
import {
  pickMailAttachments,
  attachmentPayload,
  humanSize,
  type OutboundAttachment,
} from "./mail-attach-files";
import {
  patchThreadStarred,
  patchThreadLabels,
  patchThreadUnread,
  patchThreadTrashed,
  patchThreadAssignment,
  patchThreadStatus,
  createLabel,
} from "./mail-actions";
import {
  type MailLabel,
  LABEL_PALETTE,
  labelColorMap,
  colorForLabel,
  chipStyle,
} from "./mail-labels";
import { ComposeDialog } from "./Compose";
import {
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  Send,
  Reply,
  Forward,
  Archive,
  Inbox,
  Loader2,
  UserPlus,
  Check,
  Star,
  Trash2,
  MailWarning,
  Tag,
  X,
  Plus,
  Paperclip,
} from "lucide-react";
import { fmtDateTime } from "../../vendor/shared/format";

type UserOption = {
  id: number;
  email: string;
  name: string | null;
};

// One attachment served on a message. We resolve a blob: URL on demand via the
// authed route (no signed URL). sizeBytes is the byte count for the "(size)" hint.
type MailAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId?: string;
};

type MailMessage = {
  id: string;
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
  attachments?: MailAttachment[];
};

type MailThread = {
  id: string;
  mailboxAddress: string;
  subject: string;
  counterpartyEmail: string;
  counterpartyName: string;
  status: string;
  assignedToUserId?: string | number;
  assignedToName?: string;
  starred: boolean;
  labels: string[];
  trashedAt: string | null;
};

type ThreadDetail = {
  thread: MailThread;
  messages: MailMessage[];
};

type MailAddress = {
  id: string;
  address: string;
  label: string;
  active: boolean;
  assignedUserId?: string | number | null;
};

const fmtFull = fmtDateTime;

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function isImageAttachment(a: MailAttachment): boolean {
  return /^image\//i.test(a.contentType || "");
}

// Strip HTML to readable text as a fallback when a message has no plain-text
// part. Never rendered as HTML — output is escaped by React as a text node.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type MailThreadProps = {
  id?: string;
  embedded?: boolean;
};

export function MailThread({ id: idProp, embedded = false }: MailThreadProps = {}) {
  const params = useParams<{ id: string }>();
  const id = idProp ?? params.id;
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();
  const { user } = useAuth();
  const branding = useBranding();
  const url = id ? `/api/mail-center/threads/${id}` : null;

  const { data, loading, error, reload } = useQuery<ThreadDetail>("mail-center-thread",
    () => api.get(url!),
    [url],
  );

  // Users for the Assign dropdown. Envelope is { users: [] } (see routes/users).
  const { data: usersResp } = useQuery<{ users: UserOption[] }>("/api/users",
    () => api.get("/api/users"),
    [],
  );
  const users = usersResp?.users ?? [];
  // Label catalogue (name → colour) for chip colours + the add-label menu.
  const { data: labelCatalog } = useQuery<MailLabel[]>("/api/mail-center/labels",
    () => api.get("/api/mail-center/labels"),
    [],
  );
  const colorMap = labelColorMap(labelCatalog ?? []);

  // Our mailboxes (for the reply From picker) + the current user (so the From
  // defaults to THEIR own mailbox).
  const { data: addresses } = useQuery<MailAddress[]>("/api/mail-center/addresses",
    () => api.get("/api/mail-center/addresses"),
    [],
  );
  const activeAddresses = useMemo(
    () => (addresses ?? []).filter((a) => a.active),
    [addresses],
  );

  const thread = data?.thread;
  const messages = data?.messages ?? [];

  const [replyText, setReplyText] = useState("");
  /* Reply-all. Off by default: replying to everyone who was Cc'd is sometimes
     right and sometimes an embarrassment, so it is a deliberate choice each
     time rather than a remembered preference. The backend rebuilds the list
     from the newest inbound message's To + Cc, minus our own mailbox. */
  const [replyAll, setReplyAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [forwardOpen, setForwardOpen] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const [fromOverride, setFromOverride] = useState("");
  const [files, setFiles] = useState<OutboundAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const userDefaultFrom = useMemo(
    () => pickDefaultFromAddress(activeAddresses, user),
    [activeAddresses, user],
  );
  const threadMailbox = thread?.mailboxAddress ?? "";
  const replyFrom =
    (fromOverride &&
      (activeAddresses.some((a) => a.address === fromOverride) ||
        fromOverride === threadMailbox) &&
      fromOverride) ||
    userDefaultFrom ||
    threadMailbox ||
    activeAddresses[0]?.address ||
    "";

  const starred = thread?.starred ?? false;
  const trashed = thread?.trashedAt != null;
  const chips = thread?.labels ?? [];

  async function handleToggleStar() {
    if (!id || mutating) return;
    setMutating(true);
    try {
      const ok = await patchThreadStarred(id, !starred);
      if (ok) reload();
      else toast.error("Couldn't update. Please try again.");
    } finally {
      setMutating(false);
    }
  }

  async function handleTrash() {
    if (!id || mutating) return;
    if (trashed) {
      setMutating(true);
      try {
        const ok = await patchThreadTrashed(id, false);
        if (ok) reload();
        toast[ok ? "info" : "error"](
          ok ? "Restored from Trash." : "Couldn't restore. Please try again.",
        );
      } finally {
        setMutating(false);
      }
      return;
    }
    const confirmed = await dialog.confirm({
      title: "Move to Trash?",
      message:
        "This conversation moves to the Trash folder. You can restore it from there.",
      confirmLabel: "Move to Trash",
      tone: "danger",
    });
    if (!confirmed) return;
    setMutating(true);
    try {
      const ok = await patchThreadTrashed(id, true);
      if (ok) {
        toast.info("Moved to Trash.");
        if (!embedded) navigate("/mail-center");
        else reload();
      } else {
        toast.error("Couldn't move to Trash. Please try again.");
      }
    } finally {
      setMutating(false);
    }
  }

  async function handleMarkUnread() {
    if (!id || mutating) return;
    setMutating(true);
    try {
      const ok = await patchThreadUnread(id, true);
      toast[ok ? "success" : "error"](
        ok ? "Marked as unread." : "Couldn't update. Please try again.",
      );
    } finally {
      setMutating(false);
    }
  }

  async function handleAddLabel() {
    if (!id || mutating) return;
    const clean = newLabel.trim();
    if (!clean) return;
    if (chips.some((l) => l.toLowerCase() === clean.toLowerCase())) {
      setNewLabel("");
      return;
    }
    setMutating(true);
    try {
      if (!colorMap.has(clean.toLowerCase())) {
        await createLabel(clean, LABEL_PALETTE[0].value);
      }
      const ok = await patchThreadLabels(id, [...chips, clean]);
      if (ok) {
        setNewLabel("");
        reload();
      } else toast.error("Couldn't add label. Please try again.");
    } finally {
      setMutating(false);
    }
  }

  function focusReply() {
    const el = replyRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus({ preventScroll: true });
  }

  async function handleRemoveLabel(label: string) {
    if (!id || mutating) return;
    const next = chips.filter((l) => l.toLowerCase() !== label.toLowerCase());
    setMutating(true);
    try {
      const ok = await patchThreadLabels(id, next);
      if (ok) reload();
      else toast.error("Couldn't remove label. Please try again.");
    } finally {
      setMutating(false);
    }
  }

  async function handlePickFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;
    setAttachError(null);
    const result = await pickMailAttachments(picked, files);
    if (!result.ok) {
      setAttachError(result.error);
      return;
    }
    setFiles(result.files);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setAttachError(null);
  }

  const totalAttachBytes = files.reduce((sum, f) => sum + f.size, 0);

  async function handleSend() {
    if (!url || sending) return;
    const text = replyText.trim();
    if (!text) return;
    setSending(true);
    try {
      await api.post(`${url}/reply`, {
        text,
        ...(replyAll ? { replyAll: true } : {}),
        ...(replyFrom ? { fromAddress: replyFrom } : {}),
        ...(files.length > 0 ? { attachments: attachmentPayload(files) } : {}),
      });
      setReplyText("");
      setReplyAll(false);
      setFiles([]);
      setAttachError(null);
      toast.success("Reply sent.");
      reload();
    } catch (e: any) {
      toast.error(
        e?.message
          ? String(e.message).replace(/^\d+:\s*/, "")
          : "Failed to send reply. Check your connection and try again.",
      );
    } finally {
      setSending(false);
    }
  }

  async function handleSetStatus(status: "open" | "closed") {
    if (!id || updatingStatus) return;
    setUpdatingStatus(true);
    try {
      const ok = await patchThreadStatus(id, status);
      if (!ok) {
        toast.error("Failed to update status. Please try again.");
        return;
      }
      toast.success(status === "closed" ? "Archived." : "Moved to Inbox.");
      reload();
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function handleAssign(userId: string) {
    if (!id || assigning) return;
    const picked = users.find((u) => String(u.id) === userId);
    const assignedToUserId = userId ? Number(userId) : null;
    const assignedToName = picked ? picked.name || picked.email : null;
    setAssigning(true);
    try {
      const ok = await patchThreadAssignment(
        id,
        assignedToUserId,
        assignedToName,
      );
      if (!ok) {
        toast.error("Failed to assign. Please try again.");
        return;
      }
      toast.success(
        assignedToName ? `Assigned to ${assignedToName}.` : "Assignment cleared.",
      );
      reload();
    } finally {
      setAssigning(false);
    }
  }

  const isClosed = thread?.status === "closed";

  return (
    <div className={cn("space-y-4", !embedded && "mx-auto max-w-3xl")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {!embedded ? (
          <button
            onClick={() => navigate("/mail-center")}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-semibold text-ink-secondary hover:bg-surface-dim hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to inbox
          </button>
        ) : (
          <span />
        )}
        {thread && (
          <div className="flex flex-wrap items-center gap-1.5">
            <ToolbarButton onClick={focusReply} title="Reply to this conversation" primary>
              <Reply className="h-4 w-4" />
              Reply
            </ToolbarButton>
            <ToolbarButton onClick={() => setForwardOpen(true)} title="Forward as a new email">
              <Forward className="h-4 w-4" />
              Forward
            </ToolbarButton>
            <ToolbarButton
              onClick={handleToggleStar}
              disabled={mutating}
              title={starred ? "Unstar" : "Star"}
              className={cn(starred && "text-accent")}
            >
              <Star className={cn("h-4 w-4", starred && "fill-amber-400 text-amber-500")} />
              {starred ? "Starred" : "Star"}
            </ToolbarButton>
            <ToolbarButton onClick={handleMarkUnread} disabled={mutating} title="Mark as unread">
              <MailWarning className="h-4 w-4" />
              Unread
            </ToolbarButton>
            {isClosed ? (
              <ToolbarButton onClick={() => handleSetStatus("open")} disabled={updatingStatus}>
                {updatingStatus ? <Loader2 className="h-4 w-4 animate-spin" /> : <Inbox className="h-4 w-4" />}
                Move to Inbox
              </ToolbarButton>
            ) : (
              <ToolbarButton onClick={() => handleSetStatus("closed")} disabled={updatingStatus} title="Archive (mark done)">
                {updatingStatus ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                Archive
              </ToolbarButton>
            )}
            <ToolbarButton
              onClick={handleTrash}
              disabled={mutating}
              title={trashed ? "Restore from Trash" : "Move to Trash"}
              className={cn(trashed && "text-accent")}
            >
              <Trash2 className="h-4 w-4" />
              {trashed ? "Restore" : "Trash"}
            </ToolbarButton>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}

      {!thread && loading && (
        <p className="py-12 text-center text-sm text-ink-muted">Loading…</p>
      )}

      {!thread && !loading && !error && (
        <p className="py-12 text-center text-sm text-ink-muted">Thread not found.</p>
      )}

      {thread && (
        <>
          {/* Subject header */}
          <div className="space-y-2 border-b border-border pb-3">
            <h1 className="text-xl font-semibold leading-snug text-ink">
              {thread.subject || "(no subject)"}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span>
                with{" "}
                <strong className="text-ink/90">
                  {thread.counterpartyName || thread.counterpartyEmail || "(unknown sender)"}
                </strong>
                {thread.counterpartyName && thread.counterpartyEmail && (
                  <span className="text-ink-muted/80"> &lt;{thread.counterpartyEmail}&gt;</span>
                )}
              </span>
              {thread.mailboxAddress && (
                <span className="rounded-full bg-surface-dim px-2 py-0.5 text-[10px] text-ink-secondary">
                  {thread.mailboxAddress}
                </span>
              )}
              {thread.status === "closed" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                  <Check className="h-3 w-3" />
                  Archived
                </span>
              )}
              {starred && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
                  <Star className="h-3 w-3 fill-amber-400 text-amber-500" />
                  Starred
                </span>
              )}
              {thread.assignedToName && (
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-dim px-2 py-0.5 text-[10px] text-ink-secondary">
                  <UserPlus className="h-3 w-3" />
                  {thread.assignedToName}
                </span>
              )}
            </div>

            {/* Labels */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                <Tag className="h-3.5 w-3.5" />
                Labels
              </span>
              {chips.map((l) => {
                const color = colorForLabel(l, colorMap);
                return (
                  <span
                    key={l}
                    style={chipStyle(color)}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ring-black/5"
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
                    {l}
                    <button
                      type="button"
                      onClick={() => handleRemoveLabel(l)}
                      disabled={mutating}
                      aria-label={`Remove label ${l}`}
                      className="opacity-70 hover:opacity-100 disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
              <div className="flex items-center gap-1">
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddLabel();
                    }
                  }}
                  placeholder="Add label…"
                  className="h-7 w-28 rounded-md border border-border bg-surface px-2 text-xs text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
                <button
                  disabled={!newLabel.trim() || mutating}
                  onClick={handleAddLabel}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-xs font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </button>
              </div>
            </div>

            {/* Assign */}
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                <UserPlus className="h-3.5 w-3.5" />
                Assign to
              </label>
              <div className="relative">
                <select
                  value={thread.assignedToUserId != null ? String(thread.assignedToUserId) : ""}
                  onChange={(e) => handleAssign(e.target.value)}
                  disabled={assigning || users.length === 0}
                  className="h-8 rounded-md border border-border bg-surface px-2 pr-7 text-xs text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.name || u.email}
                    </option>
                  ))}
                </select>
                {assigning && (
                  <Loader2 className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-ink-muted" />
                )}
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="space-y-3">
            {messages.map((m) => {
              const outbound = m.direction === "outbound";
              const rawHtml =
                m.htmlBody?.trim() ||
                (looksLikeHtml(m.textBody) ? (m.textBody || "").trim() : "");
              const plain = rawHtml ? "" : m.textBody?.trim() || htmlToText(m.htmlBody || "");
              const senderName = m.fromName || m.fromAddress;
              const initial = (senderName || "?").trim().charAt(0).toUpperCase();
              return (
                <div
                  key={m.id}
                  className={cn(
                    "rounded-xl border bg-surface p-4 shadow-sm",
                    outbound ? "border-accent/30 bg-accent-soft/40" : "border-border",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                        outbound ? "bg-accent text-white" : "bg-surface-dim text-ink/70",
                      )}
                    >
                      {initial}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-ink">{senderName}</span>
                            {outbound ? (
                              <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-accent" />
                            ) : (
                              <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                            )}
                          </div>
                          <p className="truncate text-xs text-ink-muted">&lt;{m.fromAddress}&gt;</p>
                        </div>
                        <span className="shrink-0 text-xs text-ink-muted">
                          {fmtFull(m.sentAt || m.createdAt)}
                        </span>
                      </div>
                      {m.toAddresses.length > 0 && (
                        <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                          To: {m.toAddresses.join(", ")}
                        </p>
                      )}
                      {rawHtml ? (
                        <iframe
                          title="Email"
                          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                          srcDoc={emailSrcDoc(rawHtml)}
                          className="mt-2 w-full border-t border-border/60 bg-white"
                          style={{ minHeight: 80 }}
                          onLoad={(e) => {
                            try {
                              const d = e.currentTarget.contentWindow?.document;
                              if (d)
                                e.currentTarget.style.height = `${Math.min(
                                  d.body.scrollHeight + 24,
                                  4000,
                                )}px`;
                            } catch {
                              /* cross-origin guard — keep the min height */
                            }
                          }}
                        />
                      ) : (
                        <pre className="mt-2 whitespace-pre-wrap break-words border-t border-border/60 pt-2 font-sans text-sm leading-relaxed text-ink/90">
                          {plain || "(empty)"}
                        </pre>
                      )}

                      {(m.attachments?.length ?? 0) > 0 && (
                        <div className="mt-3 border-t border-border/60 pt-2">
                          <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-ink-muted">
                            <Paperclip className="h-3 w-3" />
                            {m.attachments!.length} attachment
                            {m.attachments!.length === 1 ? "" : "s"}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {m.attachments!.map((a) => (
                              <AttachmentChip key={a.id} att={a} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {messages.length === 0 && !loading && (
              <p className="py-8 text-center text-sm text-ink-muted">
                No messages in this thread yet.
              </p>
            )}
          </div>

          {/* Reply composer */}
          <div className="rounded-xl border border-accent/30 bg-surface p-4 shadow-sm">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
                <div className="flex items-center gap-1.5">
                  <Send className="h-3.5 w-3.5 text-accent" />
                  <p className="text-sm font-semibold text-ink">Reply</p>
                </div>
                <span className="text-xs text-ink-muted">
                  To {thread.counterpartyName || thread.counterpartyEmail || "(unknown sender)"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs font-medium text-ink-muted">From</label>
                {activeAddresses.length > 1 ? (
                  <select
                    value={replyFrom}
                    onChange={(e) => setFromOverride(e.target.value)}
                    disabled={sending}
                    className="h-8 max-w-full rounded-md border border-border bg-surface px-2 text-xs text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {threadMailbox &&
                      !activeAddresses.some((a) => a.address === threadMailbox) && (
                        <option value={threadMailbox}>{threadMailbox}</option>
                      )}
                    {activeAddresses.map((a) => (
                      <option key={a.id} value={a.address}>
                        {a.label ? `${a.label} · ${a.address}` : a.address}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xs text-ink/90">
                    {replyFrom || branding.companyName}
                  </span>
                )}
              </div>
              <textarea
                ref={replyRef}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={6}
                placeholder="Type your reply…"
                disabled={sending}
                className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
              />

              {files.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-ink-muted">
                    Attachments ({files.length}/{MAIL_ATTACH_MAX_COUNT} ·{" "}
                    {humanSize(totalAttachBytes)} of {humanSize(MAIL_ATTACH_MAX_TOTAL_BYTES)})
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {files.map((f, i) => (
                      <span
                        key={`${f.name}-${i}`}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-dim py-1 pl-2 pr-1 text-xs text-ink"
                      >
                        <Paperclip className="h-3 w-3 shrink-0 text-ink-muted" />
                        <span className="truncate">{f.name}</span>
                        <span className="shrink-0 text-ink-muted">{humanSize(f.size)}</span>
                        <button
                          type="button"
                          onClick={() => removeFile(i)}
                          disabled={sending}
                          aria-label={`Remove ${f.name}`}
                          className="shrink-0 rounded p-0.5 text-ink-muted transition hover:bg-surface hover:text-ink disabled:opacity-50"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {attachError && <p className="text-[11px] text-err">{attachError}</p>}

              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-ink-muted">
                  Sent from {replyFrom || branding.companyName}.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,application/pdf"
                    multiple
                    className="hidden"
                    onChange={handlePickFiles}
                  />
                  <button
                    disabled={sending}
                    onClick={() => fileInputRef.current?.click()}
                    title="Attach images or PDF files (max 10 files, 5 MB total)"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
                  >
                    <Paperclip className="h-4 w-4" />
                    Attach
                  </button>
                  {/* Reply-all. Until now a reply went to ONE address and there
                      was no way to add anyone — an email that Cc'd three people
                      was answered to one of them, silently. */}
                  <label
                    title="Also reply to everyone who was on the last message, except this mailbox"
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink"
                  >
                    <input
                      type="checkbox"
                      checked={replyAll}
                      disabled={sending}
                      onChange={(e) => setReplyAll(e.target.checked)}
                    />
                    Reply all
                  </label>
                  <button
                    disabled={sending || !replyText.trim()}
                    onClick={handleSend}
                    className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-1.5 text-[12px] font-bold text-white hover:bg-primary-ink disabled:opacity-50"
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {replyAll ? "Send to all" : "Send reply"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Forward — reuses the compose flow (POST /compose). */}
      {thread && (
        <ComposeDialog
          open={forwardOpen}
          onClose={() => setForwardOpen(false)}
          initialDraft={{
            id: `fwd-${thread.id}`,
            to: "",
            subject: forwardSubject(thread.subject),
            body: forwardBody(thread, messages),
            fromAddress: thread.mailboxAddress || "",
            updatedAt: 0,
          }}
        />
      )}
    </div>
  );
}

// Default export for the lazy route.
export default MailThread;

// A toolbar button used in the detail header. `primary` paints the brand tone.
function ToolbarButton({
  onClick,
  disabled,
  title,
  primary,
  className,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition disabled:opacity-50",
        primary
          ? "border border-primary bg-primary text-white hover:bg-primary-ink"
          : "border border-border bg-surface text-ink-secondary hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

// One attachment chip — resolves the authed blob: URL on mount (api.fetchBlobUrl
// attaches the bearer; <img>/<a> can't). Image types render a thumbnail; others
// render a download pill. While loading / on failure, a quiet disabled chip.
function AttachmentChip({ att }: { att: MailAttachment }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let made = "";
    api
      .fetchBlobUrl(`/api/mail-center/attachments/${att.id}`)
      .then((u) => {
        if (revoked) {
          URL.revokeObjectURL(u);
          return;
        }
        made = u;
        setBlobUrl(u);
      })
      .catch(() => setFailed(true));
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [att.id]);

  const sizeHint = att.sizeBytes > 0 ? ` (${formatBytes(att.sizeBytes)})` : "";

  if (failed || (!blobUrl && false)) {
    return (
      <span
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-dim/60 px-2.5 py-1 text-xs text-ink-muted"
        title={`${att.filename} (unavailable)`}
      >
        <Paperclip className="h-3 w-3 shrink-0" />
        <span className="truncate">{att.filename}</span>
        {att.sizeBytes > 0 && (
          <span className="shrink-0 text-[10px]">({formatBytes(att.sizeBytes)})</span>
        )}
      </span>
    );
  }

  if (isImageAttachment(att) && blobUrl) {
    return (
      <a
        href={blobUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`${att.filename}${sizeHint}`}
        className="group relative block overflow-hidden rounded-md border border-border bg-white"
      >
        <img
          src={blobUrl}
          alt={att.filename}
          loading="lazy"
          className="h-20 w-20 object-cover transition-opacity group-hover:opacity-90"
        />
        <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
          {att.filename}
        </span>
      </a>
    );
  }

  return (
    <a
      href={blobUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-dim/40 px-2.5 py-1 text-xs text-ink/90 transition-colors hover:bg-surface-dim",
        !blobUrl && "pointer-events-none opacity-60",
      )}
      title={att.filename}
    >
      <Paperclip className="h-3 w-3 shrink-0 text-ink-muted" />
      <span className="truncate">{att.filename}</span>
      {att.sizeBytes > 0 && (
        <span className="shrink-0 text-[10px] text-ink-muted">({formatBytes(att.sizeBytes)})</span>
      )}
    </a>
  );
}

// "Fwd: <subject>" without double-prefixing an already-forwarded subject.
function forwardSubject(subject: string): string {
  const s = subject || "(no subject)";
  return /^fwd:/i.test(s) ? s : `Fwd: ${s}`;
}

function looksLikeHtml(s: string | undefined): boolean {
  return /<(?:!doctype|html|body|head|div|table|tr|td|p|br|span|a|img|style|font|center|ul|ol|li|h[1-6])[\s>/]/i.test(
    s || "",
  );
}

function emailSrcDoc(rawHtml: string): string {
  const inject = `<base target="_blank"><meta charset="utf-8"><style>html,body{margin:0;padding:10px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#1f1d1b;word-break:break-word;overflow-x:hidden}img{max-width:100%;height:auto}table{max-width:100%}</style>`;
  if (/<head[^>]*>/i.test(rawHtml))
    return rawHtml.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  if (/<html[^>]*>/i.test(rawHtml))
    return rawHtml.replace(/<html([^>]*)>/i, `<html$1><head>${inject}</head>`);
  return `<!doctype html><html><head>${inject}</head><body>${rawHtml}</body></html>`;
}

// Build a quoted forward body from the conversation's messages (newest first),
// each prefixed with a small header line. Plain text only — never raw HTML.
function forwardBody(thread: MailThread, messages: MailMessage[]): string {
  const lines: string[] = ["", "---------- Forwarded message ----------"];
  const ordered = messages
    .slice()
    .sort((a, b) => (b.sentAt || b.createdAt || "").localeCompare(a.sentAt || a.createdAt || ""));
  for (const m of ordered) {
    const who = m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress;
    const when = fmtFull(m.sentAt || m.createdAt);
    const body = m.textBody?.trim() || htmlToText(m.htmlBody || "");
    lines.push("");
    lines.push(`From: ${who}`);
    if (when) lines.push(`Date: ${when}`);
    if (m.subject) lines.push(`Subject: ${m.subject}`);
    lines.push("");
    lines.push(body || "(empty)");
    lines.push("");
    lines.push("--");
  }
  return lines.join("\n");
}
