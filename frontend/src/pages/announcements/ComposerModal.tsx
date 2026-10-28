import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, FileText, Film, Plus, X } from "lucide-react";
import { api } from "../../api/client";
import { AnnouncementRichBody } from "../../components/AnnouncementRichBody";
import {
  AnnouncementRichEditor,
  type RichEditorImage,
} from "../../components/AnnouncementRichEditor";
import type { PhotoLayout, VideoLayout } from "../../components/AnnouncementMedia";
import { useDialogOptional } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { uploadAnnouncementAttachment } from "../../lib/announcementAttachmentUpload";
import { newIdempotencyKey } from "../../lib/idempotency";
import { richTextToPlain } from "../../lib/announcementRichText";
import { cn } from "../../lib/utils";
import type { Department, TeamMember } from "../../types";
import { DateTimeField } from "../../vendor/scm/components/DateTimeField";
import {
  AudiencePicker,
  EMPTY_AUDIENCE,
  activeExclusions,
  audienceSummary,
  type AudienceValue,
} from "./AudiencePicker";
import { docTypeForCategory } from "../../components/announcementCategory";
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  categoryRequiresAck,
  type AnnouncementCategory,
  type Attachment,
  type DocumentTypeOption,
  type Company,
} from "./announcementModel";

// ────────────────────────────────────────────────────────────────────────────
// ComposerModal — the wide composer (design handoff 2026-09-04, screen 4):
// a 1060px card, editor column left (category pills, "Require
// acknowledgement", title, rich text, attachment strip with the schedule),
// the three-column AudiencePicker right, and a footer with Preview +
// Schedule post / Post announcement.
//
// The draft autosaves to localStorage (per user) so a half-written notice
// survives a closed modal or a reload; "Draft saved HH:mm" in the header is
// that stamp. Posting clears it.
//
// Recipients: departments + people (+ company) exactly as the backend targets
// them today; "All staff" is an explicit choice, never the accident of an
// empty picker (the old composer guarded the same way).
// ────────────────────────────────────────────────────────────────────────────

export type ComposerDraft = {
  savedAt: number;
  /** Document type code (mig 20260908T0300): ANN or e.g. MEMO. */
  docType: string;
  /** Numbered under (mig 20260909T0900): the department whose series the
   *  number is minted on; null = the submitter's own. */
  numberDeptId: number | null;
  category: AnnouncementCategory;
  requireAck: boolean;
  title: string;
  html: string;
  attachments: Attachment[];
  scheduledAt: string;
  expiresAt: string;
  audience: AudienceValue;
  photoLayout: PhotoLayout | "";
  videoLayout: VideoLayout;
  /** Minted when the draft is first written, sent with the post, cleared with
   *  the draft on success. A repeat of the SAME draft — after a hang, a
   *  reload, a second click — is answered by the server with the row the first
   *  request made (mig 20260907T0010), never a second one. Stable across
   *  edits on purpose: the retry that made nine copies on 2026-09-06 was one
   *  draft re-posted with small changes. */
  clientKey: string;
};

export function draftStorageKey(userId: number | null): string {
  return `announcements:draft:u${userId ?? 0}`;
}

export function readDraft(key: string): ComposerDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const d = parsed as Partial<ComposerDraft>;
    if (typeof d.savedAt !== "number") return null;
    return {
      savedAt: d.savedAt,
      docType: typeof d.docType === "string" && /^[A-Z]{2,4}$/.test(d.docType) ? d.docType : "ANN",
      numberDeptId: typeof d.numberDeptId === "number" && d.numberDeptId > 0 ? d.numberDeptId : null,
      category: CATEGORY_ORDER.includes(d.category as AnnouncementCategory)
        ? (d.category as AnnouncementCategory)
        : "WARNING",
      requireAck: typeof d.requireAck === "boolean" ? d.requireAck : true,
      title: typeof d.title === "string" ? d.title : "",
      html: typeof d.html === "string" ? d.html : "",
      attachments: Array.isArray(d.attachments) ? d.attachments : [],
      scheduledAt: typeof d.scheduledAt === "string" ? d.scheduledAt : "",
      expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : "",
      audience: {
        ...EMPTY_AUDIENCE,
        ...(d.audience ?? {}),
        // Drafts saved before 2026-09-05/06 have neither list.
        divisions: Array.isArray(d.audience?.divisions) ? d.audience.divisions : [],
        excludedUserIds: Array.isArray(d.audience?.excludedUserIds) ? d.audience.excludedUserIds : [],
      },
      photoLayout: d.photoLayout === "1" || d.photoLayout === "2" || d.photoLayout === "3" || d.photoLayout === "4" ? d.photoLayout : "",
      videoLayout: d.videoLayout === "1x2" ? "1x2" : "1x1",
      // A draft saved before 2026-09-07 has no key: mint one now, and the next
      // autosave makes it stable.
      clientKey: typeof d.clientKey === "string" && d.clientKey ? d.clientKey : newIdempotencyKey(),
    };
  } catch {
    return null;
  }
}

/**
 * The request body for POST /api/announcements, or an error to show.
 *
 * `users` is the roster the picker showed; it is consulted only to drop an
 * unticked id that no selected department / division reaches any more (the
 * server would store it harmlessly, but the receipt is cleaner without it).
 * Divisions and exclusions are the server's own columns (mig 20260906T0639);
 * nothing is expanded client-side, so a person who joins a targeted
 * department or division after posting is included.
 */
export function buildPostBody(
  d: Omit<ComposerDraft, "savedAt">,
  salesDirOnly: boolean,
  users: TeamMember[] = [],
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const title = d.title.trim();
  if (!title) return { ok: false, error: "Title is required" };
  const a = d.audience;
  if (!a.allStaff && a.deptIds.length === 0 && a.divisions.length === 0 && a.userIds.length === 0) {
    return {
      ok: false,
      error: salesDirOnly
        ? "Pick your department, a division of it, or at least one salesperson."
        : "Pick at least one department, division or person, or choose All staff.",
    };
  }
  const body: Record<string, unknown> = {
    title,
    body: richTextToPlain(d.html),
    bodyHtml: d.html,
    docType: d.docType,
    numberDeptId: d.numberDeptId,
    category: d.category,
    requireAck: d.requireAck,
    attachments: d.attachments,
    clientKey: d.clientKey,
  };
  if (!a.allStaff) {
    if (a.deptIds.length) body.targetDeptIds = a.deptIds;
    // Divisions the department selection already implies are not repeated.
    const divisions = a.divisions.filter((x) => !a.deptIds.includes(x.deptId));
    if (divisions.length) body.targetDivisions = divisions;
    if (a.userIds.length) body.targetUserIds = a.userIds;
    const excluded = users.length ? activeExclusions(a, users) : a.excludedUserIds;
    if (excluded.length) body.excludedUserIds = excluded;
  }
  if (!salesDirOnly && a.companyId != null) body.targetCompanyIds = [a.companyId];
  if (d.scheduledAt) {
    const t = Date.parse(d.scheduledAt);
    if (Number.isNaN(t)) return { ok: false, error: "The schedule date is not valid" };
    body.scheduledAt = new Date(t).toISOString();
  }
  // SOP never expires — the SOP Library is permanent — so an expiry is only
  // sent for the other categories.
  if (d.expiresAt && d.category !== "SOP") {
    const t = Date.parse(d.expiresAt);
    if (Number.isNaN(t)) return { ok: false, error: "The hide-after date is not valid" };
    body.expiresAt = new Date(t).toISOString();
  }
  const hasPhotos = d.attachments.some((x) => x.mime.startsWith("image/"));
  const hasVideos = d.attachments.some((x) => x.mime.startsWith("video/"));
  const mediaLayout: { photo?: PhotoLayout; video?: VideoLayout } = {};
  if (hasPhotos && d.photoLayout) mediaLayout.photo = d.photoLayout;
  if (hasVideos) mediaLayout.video = d.videoLayout;
  if (mediaLayout.photo || mediaLayout.video) body.mediaLayout = mediaLayout;
  return { ok: true, body };
}

export type ComposerModalProps = {
  users: TeamMember[];
  departments: Department[];
  companies: Company[];
  salesDirOnly: boolean;
  currentUserId: number | null;
  /** Settings → Documents says the ANN type needs a file before submit
   *  (mig 20260907T0715). Submit is held until one is attached; Save draft is
   *  not. The server enforces the same rule. Superseded per type by
   *  `docTypes` when that is given. */
  attachmentRequired?: boolean;
  /** The registered document types (GET /api/document-types, active only).
   *  With more than one, the composer offers a Type row — Announcement / Memo
   *  — and the pick is the [TYPE] segment of the reference number (mig
   *  20260908T0300). Each type carries its own attachment policy. */
  docTypes?: DocumentTypeOption[];
  onClose: () => void;
  onPosted: () => void;
};

const EYEBROW = "font-mono text-[10px] font-bold uppercase tracking-wider";
const FIELD_CLS =
  "h-9 rounded-md border border-border bg-surface px-2.5 text-[12px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ComposerModal(p: ComposerModalProps) {
  const toast = useToast();
  // Optional: the Link button needs the app's prompt dialog; a bare mount
  // (unit test) has no provider and simply gets no Link button.
  const dialog = useDialogOptional();
  const storageKey = draftStorageKey(p.currentUserId);
  const restored = useMemo(() => readDraft(storageKey), [storageKey]);

  const [docType, setDocType] = useState<string>(restored?.docType ?? "ANN");
  const typeOptions = useMemo(() => p.docTypes ?? [], [p.docTypes]);
  // The type follows the category (docTypeForCategory, owner 2026-09-09)
  // until the writer picks one by hand; a restored draft keeps what it saved.
  const [typeTouched, setTypeTouched] = useState<boolean>(restored != null);
  const [typeOpen, setTypeOpen] = useState(false);
  // Numbered under (owner 2026-09-09: 需要可以选部门): the department whose
  // series the number is minted on — a director composing on a department's
  // behalf picks it; empty = the submitter's own department.
  const [numberDeptId, setNumberDeptId] = useState<number | null>(restored?.numberDeptId ?? null);
  const numberDept = numberDeptId == null ? null : (p.departments.find((d) => d.id === numberDeptId) ?? null);
  const numberDeptCode = numberDept?.code ?? null;
  // The number this notice gets on approval — the next on the submitter's
  // department series for the picked type (owner 2026-09-09: 需要显示目前档案
  // 号码), whether it goes to one department or all staff. A preview from
  // GET /api/document-refs/next: nothing is claimed by looking, so two
  // composers see the same number until one is approved.
  const [nextRef, setNextRef] = useState<{ refNo: string | null; reason: string | null }>({ refNo: null, reason: null });
  useEffect(() => {
    if (numberDeptId != null && !numberDeptCode) {
      setNextRef({ refNo: null, reason: `${numberDept?.name ?? "That department"} has no department code yet, so a notice cannot be numbered under it. Set one under Team → Departments.` });
      return;
    }
    const gone = new AbortController();
    void (async () => {
      try {
        const r = await api.get<{ data?: { refNo?: string } | null; reason?: string }>(
          `/api/document-refs/next?typeCode=${encodeURIComponent(docType)}${numberDeptCode ? `&deptCode=${encodeURIComponent(numberDeptCode)}` : ""}`,
        );
        if (gone.signal.aborted) return;
        const refNo = r.data?.refNo ?? null;
        setNextRef({ refNo, reason: refNo ? null : (r.reason ?? null) });
      } catch {
        if (!gone.signal.aborted) setNextRef({ refNo: null, reason: null });
      }
    })();
    return () => gone.abort();
  }, [docType, numberDeptId, numberDeptCode, numberDept?.name]);
  const [category, setCategory] = useState<AnnouncementCategory>(restored?.category ?? "WARNING");
  const [requireAck, setRequireAck] = useState<boolean>(restored?.requireAck ?? true);
  const [title, setTitle] = useState(restored?.title ?? "");
  const [html, setHtml] = useState(restored?.html ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>(restored?.attachments ?? []);
  const [scheduledAt, setScheduledAt] = useState(restored?.scheduledAt ?? "");
  const [expiresAt, setExpiresAt] = useState(restored?.expiresAt ?? "");
  const [audience, setAudience] = useState<AudienceValue>(restored?.audience ?? EMPTY_AUDIENCE);
  const [photoLayout, setPhotoLayout] = useState<PhotoLayout | "">(restored?.photoLayout ?? "");
  const [videoLayout, setVideoLayout] = useState<VideoLayout>(restored?.videoLayout ?? "1x1");
  // One key per draft (see ComposerDraft.clientKey). A restored draft keeps
  // the key it was saved with, so the post after a reload is the same post.
  const [clientKey] = useState(() => restored?.clientKey ?? newIdempotencyKey());
  const [focusDept, setFocusDept] = useState<number | null>(restored?.audience.deptIds[0] ?? null);
  const [savedAt, setSavedAt] = useState<number | null>(restored?.savedAt ?? null);
  const [preview, setPreview] = useState(false);
  const [posting, setPosting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Object URLs for images picked THIS session (an uploaded key cannot be
  // streamed back before the notice exists). Revoked on unmount.
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>({});
  useEffect(
    () => () => {
      for (const url of Object.values(localPreviews)) URL.revokeObjectURL(url);
    },
    [],
  );

  // A Sales Director's picker is already scoped to their department; seed it
  // once so posting with no manual pick still targets the whole department.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!p.salesDirOnly || seededRef.current || p.departments.length === 0) return;
    seededRef.current = true;
    setAudience((a) =>
      a.deptIds.length || a.userIds.length ? a : { ...a, deptIds: p.departments.map((d) => d.id) },
    );
  }, [p.salesDirOnly, p.departments]);

  // Autosave (debounced). Skipped while the form is pristine so an opened-and-
  // closed composer never leaves an empty draft behind.
  const draft = useMemo<Omit<ComposerDraft, "savedAt">>(
    () => ({
      docType,
      numberDeptId,
      category,
      requireAck,
      title,
      html,
      attachments,
      scheduledAt,
      expiresAt,
      audience,
      photoLayout,
      videoLayout,
      clientKey,
    }),
    [docType, numberDeptId, category, requireAck, title, html, attachments, scheduledAt, expiresAt, audience, photoLayout, videoLayout, clientKey],
  );
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const pristine =
      !title.trim() && !html.trim() && attachments.length === 0 && !audience.allStaff &&
      audience.deptIds.length === 0 && audience.userIds.length === 0;
    if (pristine) return;
    const t = window.setTimeout(() => {
      const now = Date.now();
      try {
        localStorage.setItem(storageKey, JSON.stringify({ ...draft, savedAt: now }));
        setSavedAt(now);
      } catch {
        /* storage full / private mode: the draft simply is not remembered */
      }
    }, 800);
    return () => window.clearTimeout(t);
  }, [draft, storageKey, title, html, attachments.length, audience]);

  // Esc closes; the page behind stays put.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") p.onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [p.onClose]);

  function pickCategory(c: AnnouncementCategory) {
    setCategory(c);
    setRequireAck(categoryRequiresAck(c));
    if (c === "SOP") setExpiresAt("");
  }
  useEffect(() => {
    if (typeTouched) return;
    setDocType(docTypeForCategory(category, typeOptions));
  }, [category, typeTouched, typeOptions]);

  const onPickFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        try {
          const res = await uploadAnnouncementAttachment(f);
          const att: Attachment = { r2Key: res.r2Key, name: res.name, mime: res.mime, size: res.size };
          setAttachments((prev) => [...prev, att]);
          if (f.type.startsWith("image/")) {
            const url = URL.createObjectURL(f);
            setLocalPreviews((prev) => ({ ...prev, [res.r2Key]: url }));
          }
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Upload failed");
          break;
        }
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [toast]);

  // An image placed INSIDE the text: uploaded like any attachment (so it is
  // in the manifest the serve route authorises against), then handed back to
  // the editor as {key, local preview}. The editor stores only the key.
  const onInsertImage = useCallback(
    async (file: File): Promise<RichEditorImage | null> => {
      if (!file.type.startsWith("image/")) {
        toast.error("Only an image can be placed in the text");
        return null;
      }
      setUploading(true);
      try {
        const res = await uploadAnnouncementAttachment(file);
        const att: Attachment = { r2Key: res.r2Key, name: res.name, mime: res.mime, size: res.size };
        setAttachments((prev) => [...prev, att]);
        const url = URL.createObjectURL(file);
        setLocalPreviews((prev) => ({ ...prev, [res.r2Key]: url }));
        return { key: res.r2Key, src: url };
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Upload failed");
        return null;
      } finally {
        setUploading(false);
      }
    },
    [toast],
  );
  const imageSrc = useCallback((key: string) => localPreviews[key], [localPreviews]);
  const onPromptLink = useMemo(
    () =>
      dialog
        ? (current: string) =>
            dialog.prompt({
              title: "Link address",
              message: "A web address (https://…) or an email address.",
              placeholder: "https://example.com or name@company.com",
              defaultValue: current,
              confirmLabel: "Add link",
              required: true,
            })
        : undefined,
    [dialog],
  );

  // Approval workflow (mig 20260906T1509): a notice is submitted, not posted —
  // it goes live when an approver signs it off. `asDraft` parks it in Manage
  // without ringing the approvers' bell.
  //
  // A ref, not only the `posting` state: two clicks inside one event loop turn
  // see the same stale state and both get through. The server's client key
  // would still collapse them into one row; this keeps the second request
  // from being sent at all.
  const postingRef = useRef(false);
  async function post(opts: { asDraft?: boolean } = {}) {
    if (postingRef.current) return;
    const built = buildPostBody(draft, p.salesDirOnly, p.users);
    if (!built.ok) {
      toast.error(built.error);
      return;
    }
    postingRef.current = true;
    setPosting(true);
    try {
      const res = await api.post<{ duplicate?: boolean }>(
        "/api/announcements",
        opts.asDraft ? { ...built.body, draft: true } : built.body,
      );
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* nothing to clear */
      }
      // `duplicate`: this draft had already been submitted (the earlier request
      // answered after the page gave up on it). The server returned that row
      // and made no second one — say so, so the author edits it under Manage
      // rather than submitting again.
      toast.success(
        res.duplicate
          ? "This notice was already submitted — no second copy was made"
          : opts.asDraft
            ? "Draft saved — find it under Manage"
            : scheduledAt
              ? "Submitted for approval — it is scheduled once approved"
              : "Submitted for approval",
      );
      p.onPosted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to post");
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  }

  const summary = audienceSummary(audience, p.companies, p.departments, p.users);
  const hasPhotos = attachments.some((a) => a.mime.startsWith("image/"));
  const hasVideos = attachments.some((a) => a.mime.startsWith("video/"));
  const canPost = !posting && !uploading && title.trim().length > 0;
  const pickedType = typeOptions.find((t) => t.code === docType);
  const typeNeedsFile = pickedType ? pickedType.attachmentRequired : p.attachmentRequired === true;
  const missingAttachment = typeNeedsFile && attachments.length === 0;
  const canSubmit = canPost && !missingAttachment;
  const meta = CATEGORY_META[category];

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/30 p-6 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="New announcement"
      onMouseDown={p.onClose}
    >
      <div
        className="my-2 flex max-h-[calc(100dvh-3rem)] w-full max-w-[1280px] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-slab"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-3.5">
          <span className="text-[15px] font-[680] text-ink">New announcement</span>
          {savedAt != null && (
            <span className="rounded-full border border-border bg-surface-dim px-2 py-[2px] font-mono text-[9.5px] text-ink-muted">
              Draft saved {fmtClock(savedAt)}
            </span>
          )}
          <button
            type="button"
            onClick={p.onClose}
            aria-label="Close"
            className="ml-auto rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_520px]">
          {/* ── Editor column ─────────────────────────────────────────── */}
          <div className="flex min-h-0 flex-col gap-3.5 overflow-auto border-r border-border px-[18px] py-4">
            <div className="flex flex-wrap items-center gap-2">
              {CATEGORY_ORDER.map((c) => {
                const m = CATEGORY_META[c];
                const on = c === category;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => pickCategory(c)}
                    aria-pressed={on}
                    className={cn(
                      "rounded-full border px-3 py-[5px] text-[11.5px] font-[650]",
                      on ? cn(m.pillCls, "border-transparent") : "border-border bg-surface text-ink-secondary hover:bg-surface-dim",
                    )}
                  >
                    {m.label}
                  </button>
                );
              })}
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11.5px] font-semibold text-ink-secondary">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={requireAck}
                  onChange={(e) => setRequireAck(e.target.checked)}
                />
                <span
                  aria-hidden
                  className={cn(
                    "grid h-[15px] w-[15px] place-items-center rounded text-white",
                    requireAck ? "bg-primary" : "border border-border bg-surface",
                  )}
                >
                  {requireAck && <Check size={10} strokeWidth={3} />}
                </span>
                Require acknowledgement
              </label>
            </div>
            {/* Numbering (owner 2026-09-09): the family the number is minted as
                (follows the category until picked by hand), the department it
                is minted under, and the number itself, previewed. */}
            <div className="flex flex-wrap items-center gap-2" data-testid="numbering-row">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Numbered as</span>
              <span
                className="rounded-full border border-border bg-surface-dim px-2.5 py-[3px] text-[11.5px] font-[650] text-ink"
                data-testid="numbering-type"
              >
                {pickedType?.label ?? docType}
                <span className="ml-1 font-mono text-[10px] opacity-70">{docType}</span>
              </span>
              {typeOptions.length > 1 && (
                <button
                  type="button"
                  onClick={() => setTypeOpen((v) => !v)}
                  aria-expanded={typeOpen}
                  className="text-[11.5px] font-semibold text-primary hover:underline"
                >
                  {typeOpen ? "Done" : "Change type"}
                </button>
              )}
              <label htmlFor="composer-number-dept" className="ml-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                under
              </label>
              <select
                id="composer-number-dept"
                aria-label="Numbered under"
                className={cn(FIELD_CLS, "min-w-[240px]")}
                value={numberDeptId ?? ""}
                onChange={(e) => setNumberDeptId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">My department</option>
                {p.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.code ? ` (${d.code})` : " — no code"}
                  </option>
                ))}
              </select>
            </div>
            {typeOpen && typeOptions.length > 1 && (
              <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Document type">
                {typeOptions.map((t) => {
                  const on = t.code === docType;
                  return (
                    <button
                      key={t.code}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => {
                        setTypeTouched(true);
                        setDocType(t.code);
                      }}
                      className={cn(
                        "rounded-full border px-3 py-[5px] text-[11.5px] font-[650]",
                        on ? "border-transparent bg-ink text-white" : "border-border bg-surface text-ink-secondary hover:bg-surface-dim",
                      )}
                    >
                      {t.label}
                      <span className="ml-1 font-mono text-[10px] opacity-70">{t.code}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {(nextRef.refNo || nextRef.reason) && (
              <p className="text-[11.5px] text-ink-secondary" data-testid="ref-no-preview">
                {nextRef.refNo ? (
                  <>
                    Number on approval: <span className="font-mono font-semibold text-ink">{nextRef.refNo}</span> · the next on {numberDept ? `${numberDept.name}'s` : "your department's"} {docType} series this month
                  </>
                ) : (
                  nextRef.reason
                )}
              </p>
            )}

            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="What's the announcement?"
              aria-label="Title"
              className="h-[42px] rounded-md border border-border bg-surface px-3 text-[15px] font-[650] text-ink outline-none placeholder:font-normal placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
            />

            {preview ? (
              <div className="flex min-h-[280px] flex-col gap-3 rounded-md border border-border bg-bg p-4">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex rounded-full px-[9px] py-[3px] text-[10.5px] font-bold uppercase tracking-[.06em]",
                      meta.pillCls,
                    )}
                  >
                    {meta.label}
                    {requireAck && " · must acknowledge"}
                  </span>
                  <span className="text-[11px] text-ink-muted">To: {summary}</span>
                </div>
                <span className="text-[22px] font-[680] leading-[1.25] text-ink">
                  {title.trim() || "Untitled"}
                </span>
                <AnnouncementRichBody
                  html={html}
                  text={richTextToPlain(html)}
                  imageSrc={imageSrc}
                  className="text-[14px] leading-[1.75] text-ink-secondary"
                />
              </div>
            ) : (
              <AnnouncementRichEditor
                value={html}
                onChange={setHtml}
                placeholder="Write the notice. Headings, highlight, links, tables and images are in the toolbar."
                minHeight={280}
                disabled={posting}
                onPromptLink={onPromptLink}
                onInsertImage={onInsertImage}
                imageSrc={imageSrc}
              />
            )}

            <div className="flex flex-wrap items-start gap-2.5">
              {attachments.map((a, i) => {
                const url = localPreviews[a.r2Key];
                return (
                  <div
                    key={a.r2Key + i}
                    className="group relative h-12 w-16 overflow-hidden rounded-md border border-border bg-surface-dim"
                    title={a.name}
                  >
                    {url ? (
                      <img src={url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-ink-muted">
                        {a.mime.startsWith("video/") ? <Film size={13} /> : <FileText size={13} />}
                        <span className="w-full truncate text-center text-[8.5px]">{a.name}</span>
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      aria-label={`Remove ${a.name}`}
                      className="absolute right-0.5 top-0.5 hidden rounded-full bg-ink/70 p-0.5 text-white group-hover:block"
                    >
                      <X size={9} />
                    </button>
                  </div>
                );
              })}
              {missingAttachment && (
                <span className="self-center text-[11px] font-[650] text-warning-text" data-testid="attachment-required-hint">
                  An attachment is required before submit
                </span>
              )}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="h-12 w-16 rounded-md border border-border bg-surface text-[11px] font-[650] text-ink-secondary hover:bg-surface-dim disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-0.5">
                  <Plus size={11} />
                  {uploading ? "…" : "Add"}
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,video/*,application/pdf"
                onChange={(e) => void onPickFiles(e.target.files)}
                className="hidden"
              />
              <div className="ml-auto flex flex-col items-end gap-1.5 text-[11px] text-ink-muted">
                <label className="flex items-center gap-1.5">
                  Schedule:
                  <DateTimeField aria-label="Schedule" value={scheduledAt} onChange={setScheduledAt} className={FIELD_CLS} />
                </label>
                {category !== "SOP" && (
                  <label className="flex items-center gap-1.5">
                    Hide after:
                    <DateTimeField aria-label="Hide after" value={expiresAt} onChange={setExpiresAt} className={FIELD_CLS} />
                  </label>
                )}
              </div>
            </div>

            {(hasPhotos || hasVideos) && (
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-secondary">
                {hasPhotos && (
                  <span className="flex items-center gap-1">
                    <span className="mr-1 font-semibold">Photo layout</span>
                    {(["", "1", "2", "3", "4"] as Array<PhotoLayout | "">).map((v) => (
                      <button
                        key={v || "auto"}
                        type="button"
                        onClick={() => setPhotoLayout(v)}
                        aria-pressed={photoLayout === v}
                        className={cn(
                          "rounded-md border px-2 py-0.5 font-semibold",
                          photoLayout === v ? "border-primary bg-primary-soft text-primary-ink" : "border-border bg-surface",
                        )}
                      >
                        {v || "Auto"}
                      </button>
                    ))}
                  </span>
                )}
                {hasVideos && (
                  <span className="flex items-center gap-1">
                    <span className="mr-1 font-semibold">Video</span>
                    {(["1x1", "1x2"] as VideoLayout[]).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setVideoLayout(v)}
                        aria-pressed={videoLayout === v}
                        className={cn(
                          "rounded-md border px-2 py-0.5 font-semibold",
                          videoLayout === v ? "border-primary bg-primary-soft text-primary-ink" : "border-border bg-surface",
                        )}
                      >
                        {v}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* ── Audience column ───────────────────────────────────────── */}
          <div className="flex min-h-0 flex-col">
            <div className="flex flex-col gap-[3px] border-b border-border px-4 py-3">
              <span className={cn(EYEBROW, "text-ink-secondary")}>Audience</span>
              <span className="text-[12.5px] font-[650] text-ink">{summary}</span>
            </div>
            <div className="flex min-h-[300px] flex-1 flex-col overflow-hidden">
              <AudiencePicker
                value={audience}
                onChange={setAudience}
                focusDeptId={focusDept}
                onFocusDept={setFocusDept}
                companies={p.companies}
                departments={p.departments}
                users={p.users}
                salesDirOnly={p.salesDirOnly}
                disabled={posting}
              />
            </div>
            <div className="flex flex-col gap-[9px] border-t border-border bg-surface-2 px-4 py-[11px]">
              <span className="text-[11px] text-ink-secondary">
                {activeExclusions(audience, p.users).length > 0
                  ? "Unticked people are left out. Everyone else resolves at post time — someone who joins a picked department or division later is included. Overdue acknowledgements escalate to each person's supervisor. Nothing is served until an approver signs it off."
                  : "Recipients resolve at post time — a department or division picks up new members automatically. Overdue acknowledgements escalate to each person's supervisor. Nothing is served until an approver signs it off."}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPreview((v) => !v)}
                  aria-pressed={preview}
                  className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-[650] text-ink-secondary hover:bg-surface-dim"
                >
                  {preview ? "Edit" : "Preview"}
                </button>
                <button
                  type="button"
                  onClick={() => void post({ asDraft: true })}
                  disabled={!canPost}
                  className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-[650] text-ink-secondary hover:bg-surface-dim disabled:opacity-50"
                >
                  Save draft
                </button>
                <button
                  type="button"
                  onClick={() => void post()}
                  disabled={!canSubmit}
                  title={missingAttachment ? "Attach a file first — this notice type requires one" : undefined}
                  className="flex-1 rounded-md bg-primary px-3 py-2 text-[12px] font-bold text-white hover:bg-primary/90 disabled:opacity-50"
                >
                  {posting ? "Submitting…" : scheduledAt ? "Submit scheduled post" : "Submit for approval"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
