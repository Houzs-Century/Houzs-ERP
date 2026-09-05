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
import { richTextToPlain } from "../../lib/announcementRichText";
import { cn } from "../../lib/utils";
import type { Department, TeamMember } from "../../types";
import { DateTimeField } from "../../vendor/scm/components/DateTimeField";
import {
  AudiencePicker,
  EMPTY_AUDIENCE,
  activeExclusions,
  audienceSummary,
  resolveRecipients,
  type AudienceValue,
} from "./AudiencePicker";
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  categoryRequiresAck,
  type AnnouncementCategory,
  type Attachment,
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
        // Drafts saved before 2026-09-05 have no exclusion list.
        excludedUserIds: Array.isArray(d.audience?.excludedUserIds) ? d.audience.excludedUserIds : [],
      },
      photoLayout: d.photoLayout === "1" || d.photoLayout === "2" || d.photoLayout === "3" || d.photoLayout === "4" ? d.photoLayout : "",
      videoLayout: d.videoLayout === "1x2" ? "1x2" : "1x1",
    };
  } catch {
    return null;
  }
}

/**
 * The request body for POST /api/announcements, or an error to show.
 *
 * `users` is the roster the picker showed. It is only consulted when someone
 * was unticked under a selected department: the backend has no exclusion
 * list, so that department is expanded here into its remaining members and
 * sent as targetUserIds (owner ask 2026-09-05, "people 那边要可以 untick").
 */
export function buildPostBody(
  d: Omit<ComposerDraft, "savedAt">,
  salesDirOnly: boolean,
  users: TeamMember[] = [],
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const title = d.title.trim();
  if (!title) return { ok: false, error: "Title is required" };
  const a = d.audience;
  if (!a.allStaff && a.deptIds.length === 0 && a.userIds.length === 0) {
    return {
      ok: false,
      error: salesDirOnly
        ? "Pick your department or at least one salesperson."
        : "Pick at least one department or person, or choose All staff.",
    };
  }
  const body: Record<string, unknown> = {
    title,
    body: richTextToPlain(d.html),
    bodyHtml: d.html,
    category: d.category,
    requireAck: d.requireAck,
    attachments: d.attachments,
  };
  if (!a.allStaff) {
    if (activeExclusions(a, users).length > 0) {
      const ids = resolveRecipients(a, users);
      if (ids.length === 0) {
        return { ok: false, error: "Everyone in the picked departments is unticked — nobody would receive this." };
      }
      body.targetUserIds = ids;
    } else {
      if (a.deptIds.length) body.targetDeptIds = a.deptIds;
      if (a.userIds.length) body.targetUserIds = a.userIds;
    }
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
    }),
    [category, requireAck, title, html, attachments, scheduledAt, expiresAt, audience, photoLayout, videoLayout],
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

  async function post() {
    const built = buildPostBody(draft, p.salesDirOnly, p.users);
    if (!built.ok) {
      toast.error(built.error);
      return;
    }
    setPosting(true);
    try {
      await api.post("/api/announcements", built.body);
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* nothing to clear */
      }
      toast.success(scheduledAt ? "Announcement scheduled" : "Announcement posted");
      p.onPosted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to post");
    } finally {
      setPosting(false);
    }
  }

  const summary = audienceSummary(audience, p.companies, p.departments, p.users);
  const hasPhotos = attachments.some((a) => a.mime.startsWith("image/"));
  const hasVideos = attachments.some((a) => a.mime.startsWith("video/"));
  const canPost = !posting && !uploading && title.trim().length > 0;
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
                  ? "Unticked people are left out by naming the rest of the department individually — someone who joins that department later is not added. Overdue acknowledgements escalate to each person's supervisor."
                  : "Recipients resolve at post time. Overdue acknowledgements escalate to each person's supervisor."}
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
                  onClick={() => void post()}
                  disabled={!canPost}
                  className="flex-1 rounded-md bg-primary px-3 py-2 text-[12px] font-bold text-white hover:bg-primary/90 disabled:opacity-50"
                >
                  {posting ? "Posting…" : scheduledAt ? "Schedule post" : "Post announcement"}
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
