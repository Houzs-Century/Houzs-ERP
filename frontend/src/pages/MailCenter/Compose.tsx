// ---------------------------------------------------------------------------
// Mail Center — Compose (start a NEW outbound conversation).
//
// The reply composer in Thread.tsx only replies inside an existing thread. This
// dialog lets the operator send a brand-new email to any address. It posts to
// POST /api/mail-center/compose, which creates the thread + first outbound
// message and SENDS via Resend (the Houzs sender derives the From from Branding).
//
// Rendered as a fixed-overlay card (the house way). Exposed as a named
// `ComposeDialog` (embedded from Inbox.tsx + Thread.tsx forward); a thin default
// export mounts it open over the inbox so a lazy import never explodes.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../hooks/useToast";
import { useBranding } from "../../hooks/useBranding";
import { saveDraft, deleteDraftBestEffort, type MailDraft } from "./mail-local";
import { pickDefaultFromAddress } from "./mail-from-default";
import {
  validateMailAttachments,
  decodedBase64Bytes,
  isAllowedMailAttachment,
  MAIL_ATTACH_MAX_COUNT,
  MAIL_ATTACH_MAX_TOTAL_BYTES,
} from "./mail-attachments";
import { Mail, Send, Loader2, X, Save, Paperclip } from "lucide-react";

// One picked file held in memory for the compose POST. contentBase64 is the RAW
// base64 (the `data:...;base64,` prefix is stripped on read) so it maps 1:1 onto
// the backend EmailAttachment shape.
type ComposeAttachment = {
  name: string;
  type: string;
  size: number; // decoded byte count (for the chip label + total cap)
  contentBase64: string;
};

// Human-readable file size for the chip label.
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type MailAddress = {
  id: string;
  address: string;
  label: string;
  active: boolean;
  // Served by GET /api/mail-center/addresses — the user this mailbox is assigned
  // to. Used to default the From to the logged-in user's own mailbox.
  assignedUserId?: string | number | null;
};

// Conservative single-@ shape check — mirrors the backend's EMAIL_RE.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* A typed recipient field -> a clean list. Mirrors recipientList() in
   backend/src/services/email.ts: comma or semicolon separated, trimmed,
   de-duplicated case-insensitively. The backend normalises again — this is for
   the inline validation, not a trust boundary. */
const parseRecipients = (raw: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const addr = part.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
};
const firstInvalid = (raw: string): string | null =>
  parseRecipients(raw).find((a) => !EMAIL_RE.test(a)) ?? null;

type ComposeResponse = {
  ok?: boolean;
  threadId?: string;
  messageId?: string;
  error?: string;
};

export type ComposeDialogProps = {
  open: boolean;
  onClose: () => void;
  // Fired after a successful send so the parent can refresh / show the thread.
  onSent?: (threadId: string) => void;
  // When resuming a saved draft (from the Drafts folder / Forward) the parent
  // passes it here so the form opens pre-filled. Drafts are local-only.
  initialDraft?: MailDraft | null;
};

export function ComposeDialog({
  open,
  onClose,
  onSent,
  initialDraft = null,
}: ComposeDialogProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const branding = useBranding();
  const { data: addresses } = useQuery<MailAddress[]>("/api/mail-center/addresses",
    () => api.get("/api/mail-center/addresses"),
    [],
  );

  // The signed-in member's OWN outward alias (users.email_alias), e.g.
  // lim@houzscentury.com. With the free-alias model this is the member's personal
  // sending identity. It may not appear in the scoped /addresses list (that lists
  // shared/dept mailboxes), so we splice it into the From options ourselves.
  const ownAlias = (user?.email_alias ?? "").trim().toLowerCase();

  const activeAddresses = useMemo(() => {
    const list = (addresses ?? []).filter((a) => a.active);
    // Prepend the member's own alias as a first-class From option when it's not
    // already represented in the scoped address list (case-insensitive).
    if (
      ownAlias &&
      !list.some((a) => (a.address ?? "").toLowerCase() === ownAlias)
    ) {
      return [
        {
          id: `own-alias:${ownAlias}`,
          address: ownAlias,
          label: "My email",
          active: true,
          assignedUserId: user?.id ?? null,
        } as MailAddress,
        ...list,
      ];
    }
    return list;
  }, [addresses, ownAlias, user?.id]);

  // The mailbox that belongs to the logged-in user. Prefer the member's own alias
  // (their personal sending identity); else fall back to the assigned/granted
  // mailbox match. "" when the user owns no listed mailbox → fall back below.
  const userDefaultFrom = useMemo(
    () => ownAlias || pickDefaultFromAddress(activeAddresses, user),
    [activeAddresses, user, ownAlias],
  );

  // Explicit From override the operator picked (empty = follow the default).
  const [fromOverride, setFromOverride] = useState("");
  const [to, setTo] = useState("");
  /* Cc/Bcc start hidden — most mail is to one person, and two empty fields on
     every compose is the cost of a feature used sometimes. */
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCopies, setShowCopies] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [touchedTo, setTouchedTo] = useState(false);
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<ComposeAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);

  // Reset the form each time the dialog is freshly opened. The From override is
  // preserved across opens (operator's last chosen mailbox). When resuming a
  // draft, seed the fields (and the From) from it instead.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTo(initialDraft?.to ?? "");
      setSubject(initialDraft?.subject ?? "");
      setBody(initialDraft?.body ?? "");
      setDraftId(initialDraft?.id ?? null);
      setTouchedTo(false);
      setSending(false);
      setFiles([]);
      setAttachError(null);
    }
    wasOpen.current = open;
  }, [open, initialDraft]);

  if (!open) return null;

  const noMailbox = activeAddresses.length === 0;
  const onlyOneMailbox = activeAddresses.length === 1;
  // Effective From, derived: the operator's explicit pick wins; otherwise, when
  // resuming a draft, the draft's saved sender; then the logged-in user's OWN
  // mailbox; then the first active mailbox. Each candidate must still be a valid
  // active address to be honoured.
  const draftFrom =
    draftId && initialDraft?.id === draftId ? initialDraft.fromAddress : "";
  const fromAddress =
    (fromOverride &&
      activeAddresses.some((a) => a.address === fromOverride) &&
      fromOverride) ||
    (draftFrom &&
      activeAddresses.some((a) => a.address === draftFrom) &&
      draftFrom) ||
    userDefaultFrom ||
    activeAddresses[0]?.address ||
    "";
  const toList = parseRecipients(to);
  const ccList = parseRecipients(cc);
  const bccList = parseRecipients(bcc);
  const toValid = toList.length > 0 && !firstInvalid(to);
  const toError = touchedTo && to.trim().length > 0 && !toValid;
  const copyError = firstInvalid(cc) ?? firstInvalid(bcc);
  const canSend =
    !sending &&
    !noMailbox &&
    !!fromAddress &&
    toValid &&
    subject.trim().length > 0 &&
    body.trim().length > 0;
  const canSaveDraft =
    !sending &&
    !noMailbox &&
    (to.trim().length > 0 ||
      subject.trim().length > 0 ||
      body.trim().length > 0);

  function handleSaveDraft() {
    if (!canSaveDraft) return;
    const id = draftId ?? crypto.randomUUID();
    try {
      saveDraft({
        id,
        to: to.trim(),
        subject: subject.trim(),
        body,
        fromAddress,
        updatedAt: Date.now(),
      });
      toast.success("Draft saved.");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Draft could not be saved. Please try again.");
    }
  }

  // Read one file → raw base64 (strip the `data:<mime>;base64,` prefix).
  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  async function handlePickFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;
    setAttachError(null);

    const rejected = picked.filter((f) => !isAllowedMailAttachment(f.name));
    if (rejected.length > 0) {
      setAttachError(
        `"${rejected[0].name}" is not an allowed type. Only images and PDF files can be attached.`,
      );
      return;
    }

    // Pre-check RAW file sizes BEFORE decoding so an oversized file never gets
    // fully read into memory first (a huge phone photo can hang a low-RAM tab).
    const existingBytes = files.reduce((sum, f) => sum + f.size, 0);
    const pickedRawBytes = picked.reduce((sum, f) => sum + f.size, 0);
    if (existingBytes + pickedRawBytes > MAIL_ATTACH_MAX_TOTAL_BYTES) {
      setAttachError(
        `Attachments exceed the ${humanSize(MAIL_ATTACH_MAX_TOTAL_BYTES)} limit.`,
      );
      return;
    }

    let read: ComposeAttachment[];
    try {
      read = await Promise.all(
        picked.map(async (f) => {
          const contentBase64 = await readFileAsBase64(f);
          return {
            name: f.name,
            type: f.type,
            size: decodedBase64Bytes(contentBase64),
            contentBase64,
          };
        }),
      );
    } catch {
      setAttachError("Couldn't read one of the files. Please try again.");
      return;
    }

    const next = [...files, ...read];
    const check = validateMailAttachments(
      next.map((f) => ({ filename: f.name, contentBase64: f.contentBase64 })),
    );
    if (!check.ok) {
      setAttachError(check.error ?? "Invalid attachments.");
      return;
    }
    setFiles(next);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setAttachError(null);
  }

  const totalAttachBytes = files.reduce((sum, f) => sum + f.size, 0);

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      const payload = await api.post<ComposeResponse>(
        "/api/mail-center/compose",
        {
          fromAddress,
          to: toList,
          ...(ccList.length ? { cc: ccList } : {}),
          ...(bccList.length ? { bcc: bccList } : {}),
          subject: subject.trim(),
          text: body,
          ...(files.length > 0
            ? {
                attachments: files.map((f) => ({
                  filename: f.name,
                  contentBase64: f.contentBase64,
                })),
              }
            : {}),
        },
      );
      if (!payload?.ok) {
        // payload.error can be a raw provider string (Resend/Brevo) — never show
        // it to the user; a single plain sentence covers every send failure.
        toast.error("Failed to send email. Please try again.");
        return;
      }
      toast.success("Email sent.");
      if (draftId) deleteDraftBestEffort(draftId);
      onClose();
      if (payload.threadId) {
        onSent?.(payload.threadId);
        navigate(`/mail-center/${payload.threadId}`);
      }
    } catch (e: any) {
      toast.error(
        e?.message
          ? String(e.message).replace(/^\d+:\s*/, "")
          : "Failed to send email. Check your connection and try again.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      <div
        className="fixed inset-0 bg-ink/40 backdrop-blur-sm"
        onClick={() => {
          if (!sending) onClose();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Compose new email"
        className="relative mx-4 flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface shadow-slab"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold text-ink">New email</h3>
          </div>
          <button
            onClick={() => {
              if (!sending) onClose();
            }}
            aria-label="Close"
            className="rounded-md p-1 text-ink-muted transition hover:bg-surface-dim hover:text-ink disabled:opacity-50"
            disabled={sending}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {noMailbox ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              You have no mailbox assigned, so there is no address to send from.
              Ask an admin to assign one in User Management.
            </div>
          ) : (
            <>
              {/* From */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-ink-muted">From</label>
                {onlyOneMailbox ? (
                  <div className="flex h-9 items-center rounded-md border border-border bg-surface-dim px-3 text-sm text-ink">
                    {activeAddresses[0].label
                      ? `${activeAddresses[0].label} · ${activeAddresses[0].address}`
                      : activeAddresses[0].address}
                  </div>
                ) : (
                  <select
                    value={fromAddress}
                    onChange={(e) => setFromOverride(e.target.value)}
                    disabled={sending}
                    className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {activeAddresses.map((a) => (
                      <option key={a.id} value={a.address}>
                        {a.label ? `${a.label} · ${a.address}` : a.address}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* To — a LIST. `type="email"` is deliberately not used: the browser
                  rejects a comma-separated value outright, which is what made
                  this field single-recipient in the first place. */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-ink-muted">To</label>
                  {!showCopies && (
                    <button
                      type="button"
                      onClick={() => setShowCopies(true)}
                      className="text-[11px] font-medium text-primary hover:underline"
                    >
                      Cc / Bcc
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  onBlur={() => setTouchedTo(true)}
                  placeholder="customer@example.com, someone@else.com"
                  disabled={sending}
                  aria-invalid={toError}
                  className={
                    "h-10 w-full rounded-md border bg-surface px-3 text-[13px] text-ink outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60 " +
                    (toError
                      ? "border-err focus:border-err"
                      : "border-border focus:border-primary")
                  }
                />
                {toError && (
                  <p className="text-[11px] text-err">
                    {firstInvalid(to)
                      ? `Not a valid email address: ${firstInvalid(to)}`
                      : "Enter a valid email address."}
                  </p>
                )}
                {toList.length > 1 && !toError && (
                  <p className="text-[11px] text-ink-muted">
                    {toList.length} recipients. Separate them with a comma.
                  </p>
                )}
              </div>

              {/* Cc / Bcc — one send carrying everyone, never one send each. */}
              {showCopies && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-ink-muted">Cc</label>
                    <input
                      type="text"
                      value={cc}
                      onChange={(e) => setCc(e.target.value)}
                      placeholder="visible to everyone"
                      disabled={sending}
                      className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-ink-muted">Bcc</label>
                    <input
                      type="text"
                      value={bcc}
                      onChange={(e) => setBcc(e.target.value)}
                      placeholder="hidden from the others"
                      disabled={sending}
                      className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                  </div>
                  {copyError && (
                    <p className="text-[11px] text-err sm:col-span-2">
                      Not a valid email address: {copyError}
                    </p>
                  )}
                </div>
              )}

              {/* Subject */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-ink-muted">
                  Subject
                </label>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject"
                  disabled={sending}
                  className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                />
              </div>

              {/* Body */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-ink-muted">
                  Message
                </label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={8}
                  placeholder="Write your message…"
                  disabled={sending}
                  className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>

              {/* Attachments — removable chips. Images + PDF only, ≤10 files,
                  ≤5 MB total (mirrors the backend cap in mail-attachments.ts). */}
              {files.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-ink-muted">
                    Attachments ({files.length}/{MAIL_ATTACH_MAX_COUNT} ·{" "}
                    {humanSize(totalAttachBytes)} of{" "}
                    {humanSize(MAIL_ATTACH_MAX_TOTAL_BYTES)})
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {files.map((f, i) => (
                      <span
                        key={`${f.name}-${i}`}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-dim py-1 pl-2 pr-1 text-xs text-ink"
                      >
                        <Paperclip className="h-3 w-3 shrink-0 text-ink-muted" />
                        <span className="truncate">{f.name}</span>
                        <span className="shrink-0 text-ink-muted">
                          {humanSize(f.size)}
                        </span>
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
              {attachError && (
                <p className="text-[11px] text-err">{attachError}</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-border bg-surface-dim px-4 py-3">
          <p className="text-[11px] text-ink-muted">
            {noMailbox
              ? ""
              : `Sent from ${fromAddress || branding.companyName}.`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (!sending) onClose();
              }}
              disabled={sending}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
            {!noMailbox && (
              <>
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
                <button
                  disabled={!canSaveDraft}
                  onClick={handleSaveDraft}
                  title="Save this email as a local draft"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  Save draft
                </button>
              </>
            )}
            <button
              disabled={!canSend}
              onClick={handleSend}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-1.5 text-[12px] font-bold text-white hover:bg-primary-ink disabled:opacity-50"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Thin default export — Compose is only ever a modal over the inbox, but a lazy
// import path that lands here still renders something coherent.
export default function ComposePage() {
  const navigate = useNavigate();
  return <ComposeDialog open onClose={() => navigate("/mail-center")} />;
}
