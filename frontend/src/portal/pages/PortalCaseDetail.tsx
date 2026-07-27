import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Upload, Send, Package, Star, X, ChevronLeft, ChevronRight, Trash2, Clock, MessageSquare, ShieldCheck, Check, Play } from "lucide-react";
import { createPortal } from "react-dom";
import { portalApi } from "../portalApi";
import { prepareImageForUpload } from "../../lib/imagePipeline";
import {
  UploadDropZone,
  clipboardFiles,
  hoveredUploadZones,
  useStrayFileDropGuard,
} from "../../lib/uploadDropZone";
import { PortalFrame } from "../components/PortalFrame";
import { useDialog } from "../../hooks/useDialog";
import { formatDate, formatDateTime } from "../../lib/utils";
import type { PortalCaseDetail } from "../types";

const ALLOWED_EXT = ["jpg", "jpeg", "png", "webp"];
const MAX_SIZE = 10 * 1024 * 1024;

// Friendly customer-facing copy per stage. Each maps to one of the 5
// simplified tracker steps + a hero card headline / body / eyebrow.
// Keep this warm and human — customers see it, not internal staff.
const STAGE_COPY: Record<string, { step: 1 | 2 | 3 | 4 | 5; eyebrow: string; title: string; body: string }> = {
  pending_review:           { step: 1, eyebrow: "Request received", title: "Thanks — we've got your request", body: "A member of our team will pick this up shortly and confirm the next step." },
  under_verification:       { step: 2, eyebrow: "In progress",      title: "We're reviewing your request",     body: "Our team is assessing the reported issue. We'll message you once the next step is scheduled." },
  pending_solution:         { step: 2, eyebrow: "In progress",      title: "Choosing the best resolution",     body: "We're figuring out the best path forward — replace, repair, or on-site service. Update coming soon." },
  pending_supplier_pickup:  { step: 3, eyebrow: "In progress",      title: "With our service specialist",      body: "Your item is with our specialist for repair. We'll ping you as soon as it's back with us." },
  pending_item_ready:       { step: 4, eyebrow: "Nearly done",      title: "Final quality check",              body: "Your item is back with us and going through a final quality check before delivery." },
  pending_delivery_service: { step: 5, eyebrow: "On its way",       title: "Being delivered",                  body: "Your item is on its way back to you. We'll confirm a delivery window shortly." },
  completed:                { step: 5, eyebrow: "Completed",        title: "All done — thank you",             body: "Your service case has been closed. We'd love to hear how we did." },
};

// Human-readable resolution card content by resolution_method.
const RESOLUTION_COPY: Record<string, { title: string; charge: string; body: string }> = {
  replace_unit:            { title: "Replacement unit",             charge: "No charge — covered by warranty", body: "We'll replace your item with a new unit of the same model at no cost." },
  supplier_repair:         { title: "Specialist repair",             charge: "No charge — covered by warranty", body: "Our specialist will repair your item and return it to you once it clears QC." },
  field_service_own:       { title: "On-site service by our team",   charge: "No charge — covered by warranty", body: "Our team will come to you to fix the issue on site. We'll confirm the visit window." },
  field_service_supplier:  { title: "On-site service by specialist", charge: "No charge — covered by warranty", body: "Our specialist will visit you to fix the issue on site. We'll confirm the visit window." },
  return_visit:            { title: "Return to store",               charge: "No charge — covered by warranty", body: "Please bring the item back to our store. We'll get it sorted while you wait or arrange a return." },
};

const FRIENDLY_STEPS: Array<{ n: 1 | 2 | 3 | 4 | 5; label: string; note: string }> = [
  { n: 1, label: "Request received",  note: "Case logged with our team" },
  { n: 2, label: "Reviewing",         note: "Confirming the issue" },
  { n: 3, label: "Collect & repair",  note: "Pickup + service" },
  { n: 4, label: "Quality check",     note: "Final inspection" },
  { n: 5, label: "Ready & delivered", note: "Back with you" },
];

export function PortalCaseDetailPage() {
  const dialog = useDialog();
  const { token = "" } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<PortalCaseDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [approving, setApproving] = useState(false);
  const commentBoxRef = useRef<HTMLTextAreaElement | null>(null);

  const focusCommentBox = useCallback(() => {
    const el = commentBoxRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => el.focus({ preventScroll: true }), 350);
  }, []);

  async function load() {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const d = await portalApi.get<PortalCaseDetail>("/api/portal/case", token);
      setData(d);
    } catch (e: any) {
      if (e?.status === 401) setExpired(true);
      else setErr(e?.message || "Couldn't load case");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [token]);

  async function postComment() {
    if (!comment.trim()) return;
    setPosting(true);
    try {
      await portalApi.post("/api/portal/case/comments", token, { text: comment.trim() });
      setComment("");
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to post");
    } finally {
      setPosting(false);
    }
  }

  async function archiveComment(actId: number) {
    if (!await dialog.confirm("Remove this comment?")) return;
    try {
      await portalApi.post(`/api/portal/case/comments/${actId}/archive`, token);
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to remove");
    }
  }

  async function approveResolution(resolutionTitle: string) {
    if (approving) return;
    if (!await dialog.confirm(`Approve the proposed resolution: "${resolutionTitle}"?`)) return;
    setApproving(true);
    try {
      await portalApi.post("/api/portal/case/comments", token, {
        text: `✅ Customer approved: ${resolutionTitle}`,
      });
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to send approval");
    } finally {
      setApproving(false);
    }
  }

  async function archivePhoto(attId: number) {
    if (!await dialog.confirm("Remove this photo?")) return;
    try {
      await portalApi.post(`/api/portal/case/attachments/${attId}/archive`, token);
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to remove");
    }
  }

  async function uploadFiles(raws: File[]) {
    if (uploading || raws.length === 0) return;
    setUploading(true);
    setErr(null);
    try {
      for (const raw of raws) {
        const rawExt = (raw.name.split(".").pop() || "").toLowerCase();
        if (!ALLOWED_EXT.includes(rawExt)) {
          setErr(`Unsupported file type: .${rawExt}`);
          continue;
        }
        // WO-7 — customers upload straight from their phone camera roll, so
        // compress photos before the 10 MB gate. The prepared file's name
        // carries the re-encoded extension (webp is in ALLOWED_EXT).
        const { file: f } = await prepareImageForUpload(raw, { wantThumb: false });
        if (f.size > MAX_SIZE) { setErr("File exceeds 10 MB"); continue; }
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        const buf = await f.arrayBuffer();
        await portalApi.putBinary(
          `/api/portal/case/attachments?ext=${ext}&name=${encodeURIComponent(f.name)}`,
          token,
          buf,
          f.type || "image/jpeg"
        );
      }
      await load();
    } catch (e: any) {
      setErr(e?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.files?.[0];
    e.target.value = "";
    if (raw) await uploadFiles([raw]);
  }

  // Drop / paste to upload. This page has exactly ONE upload target, so a
  // screenshot paste anywhere lands in Photos & evidence; the dropzone's own
  // hover-paste still wins when the pointer is over it (registry check keeps
  // the two listeners from double-firing in either registration order).
  useStrayFileDropGuard();
  const uploadFilesRef = useRef(uploadFiles);
  useEffect(() => {
    uploadFilesRef.current = uploadFiles;
  });
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || hoveredUploadZones.size > 0) return;
      const files = clipboardFiles(e);
      if (files.length === 0) return;
      e.preventDefault();
      void uploadFilesRef.current(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  if (expired) {
    return (
      <PortalFrame>
        <div className="mx-auto max-w-sm py-8 text-center">
          <div className="mb-2 text-lg font-semibold">Link Expired</div>
          <div className="text-sm text-ink-secondary">
            This tracking link is no longer valid. Please use the tracking page to
            re-verify your case, or ask Houzs Century for a fresh link.
          </div>
          <button
            onClick={() => nav("/track")}
            className="mt-6 rounded-md bg-accent px-5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-white"
          >
            Track a case
          </button>
        </div>
      </PortalFrame>
    );
  }

  if (loading) {
    return <PortalFrame><div className="py-10 text-center text-ink-muted">Loading case…</div></PortalFrame>;
  }

  if (err && !data) {
    return (
      <PortalFrame>
        <div className="py-8 text-center">
          <div className="mb-2 text-lg font-semibold text-err">Unavailable</div>
          <div className="text-sm text-ink-secondary">{err}</div>
        </div>
      </PortalFrame>
    );
  }
  if (!data) return <PortalFrame><div /></PortalFrame>;

  const { case: cs, items, attachments, timeline } = data;
  // Sales tokens get the salesperson variant; staff-issued customer
  // links behave exactly like customer ones. `selfSource` is the
  // source value this viewer's own posts carry.
  const isSales = data.viewer === "sales";
  const selfSource = isSales ? "sales" : "customer";
  const stageCopy = STAGE_COPY[cs.stage] ?? STAGE_COPY.pending_review;
  const currentStep = stageCopy.step;
  const resolution = cs.resolution_method ? RESOLUTION_COPY[cs.resolution_method] : null;
  const alreadyApproved = timeline.some(
    (t) => t.source === "customer" && (t.note || "").startsWith("✅ Customer approved"),
  );
  const productHeadline = items[0]?.item_description || items[0]?.item_code || cs.category || "Service case";

  return (
    <PortalFrame>
      <div className="mx-auto flex max-w-md flex-col gap-4 px-1 py-1 sm:px-0">

        {/* Customer header card — the case at a glance (Nick: make the
            item + issue the clear focal point). Item headline + ASSR no,
            with the reported issue right underneath (clamped; the full
            text + category stay in the Reported issue section below).
            The sales view has its own reference card instead. */}
        {!isSales && (
          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-accent-soft to-accent/25 text-accent shadow-stone">
                <Package size={22} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-bold leading-tight text-ink">{productHeadline}</div>
                <div className="mt-0.5 font-mono text-[11px] text-ink-muted">{cs.assr_no}</div>
              </div>
            </div>
            {cs.complaint_issue && (
              <div className="mt-3 border-t border-border-subtle pt-3">
                <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Reported issue
                </div>
                <div className="line-clamp-3 whitespace-pre-line text-[13px] leading-relaxed text-ink">
                  {cs.complaint_issue}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Sales header: the case-reference card — the numbers a
            salesperson cross-references against their own orders.
            Customer tokens never receive doc_no / ref_no. */}
        {isSales && (
          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-[15px] font-bold leading-tight text-ink">
                {cs.customer_name || cs.assr_no}
              </div>
              <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-primary">
                Sales view
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {(
                [
                  { label: "ASSR No", value: cs.assr_no },
                  { label: "Customer", value: cs.customer_name, plain: true },
                  { label: "SO No", value: cs.doc_no },
                  { label: "Ref No", value: cs.ref_no },
                ] as Array<{ label: string; value?: string | null; plain?: boolean }>
              ).map((f) => (
                <div key={f.label} className="min-w-0">
                  <div className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    {f.label}
                  </div>
                  <div
                    className={
                      "truncate text-[12.5px] text-ink " + (f.plain ? "font-medium" : "font-mono")
                    }
                    title={f.value || undefined}
                  >
                    {f.value || "—"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Status hero — black card. Friendly copy per stage; NO SLA
            countdown, only a soft "expected update by" date chip. */}
        <div className="relative overflow-hidden rounded-2xl bg-[#13201c] p-6 text-white shadow-stone">
          <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[.14em] text-[#c79a5a]">
            {stageCopy.eyebrow}
          </div>
          <div className="font-serif text-[22px] font-semibold leading-tight sm:text-[24px]">
            {stageCopy.title}
          </div>
          <div className="mt-3 text-[13px] leading-relaxed text-white/70">
            {stageCopy.body}
          </div>
          {cs.expected_resolution_at && cs.stage !== "completed" && (
            <div className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-[12px] text-white/90">
              <Clock size={13} />
              <span>Expected update by <b className="text-white">{formatDate(cs.expected_resolution_at)}</b></span>
            </div>
          )}
        </div>

        {/* Sales variant: the real 9-stage progress with entry dates —
            salespeople answer customer questions, so they see the
            internal stage names, not the softened 5-step summary. */}
        {isSales && data.stages ? (
          <div className="rounded-2xl border border-border bg-surface p-5">
            <div className="mb-4 text-[13px] font-bold text-ink">Case progress</div>
            <div className="space-y-0">
              {data.stages.map((s, i) => {
                const isLast = i === data.stages!.length - 1;
                return (
                  <div key={s.stage} className="flex gap-3.5 pb-3.5">
                    <div className="flex flex-col items-center">
                      <span
                        className={
                          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold " +
                          (s.done
                            ? "bg-primary text-white"
                            : s.current
                            ? "bg-[#c79a5a] text-white ring-4 ring-[#c79a5a]/20"
                            : "border border-border-subtle bg-surface text-ink-muted")
                        }
                      >
                        {s.done ? <Check size={12} strokeWidth={3} /> : i + 1}
                      </span>
                      {!isLast && (
                        <span
                          className={"mt-1 h-full w-px flex-1 " + (s.done ? "bg-primary/50" : "bg-border-subtle")}
                          aria-hidden
                        />
                      )}
                    </div>
                    <div className="flex flex-1 items-baseline justify-between gap-2 pt-0.5">
                      <div
                        className={
                          "text-[13.5px] leading-tight " +
                          (s.done ? "font-semibold text-ink-secondary" : s.current ? "font-bold text-ink" : "font-medium text-ink-muted")
                        }
                      >
                        {s.label}
                      </div>
                      {s.entered_at && (
                        <div className="shrink-0 font-mono text-[10.5px] text-ink-muted">{formatDate(s.entered_at)}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
        <div className="rounded-2xl border border-border bg-surface p-5">
          <div className="mb-4 text-[13px] font-bold text-ink">Your request</div>
          <div className="space-y-0">
            {FRIENDLY_STEPS.map((s, i) => {
              const done = s.n < currentStep;
              const active = s.n === currentStep;
              const isLast = i === FRIENDLY_STEPS.length - 1;
              return (
                <div key={s.n} className="flex gap-3.5 pb-4">
                  <div className="flex flex-col items-center">
                    <span
                      className={
                        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold " +
                        (done
                          ? "bg-primary text-white"
                          : active
                          ? "bg-[#c79a5a] text-white ring-4 ring-[#c79a5a]/20"
                          : "border border-border-subtle bg-surface text-ink-muted")
                      }
                    >
                      {done ? <Check size={12} strokeWidth={3} /> : s.n}
                    </span>
                    {!isLast && (
                      <span
                        className={"mt-1 h-full w-px flex-1 " + (done ? "bg-primary/50" : "bg-border-subtle")}
                        aria-hidden
                      />
                    )}
                  </div>
                  <div className="pt-0.5">
                    <div
                      className={
                        "text-[14px] leading-tight " +
                        (done ? "font-semibold text-ink-secondary" : active ? "font-bold text-ink" : "font-medium text-ink-muted")
                      }
                    >
                      {s.label}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-ink-muted">{s.note}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        )}

        {/* Proposed resolution — appears only after our team picks a
            resolution method. Customer can Approve (posts a marker
            comment) or Ask a question (focuses the message box below). */}
        {resolution && (
          <div className="rounded-2xl border border-border bg-surface p-5 shadow-stone">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[13px] font-bold text-ink">Proposed resolution</div>
              <span
                className={
                  "rounded-md px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-brand " +
                  (alreadyApproved
                    ? "bg-synced/15 text-synced"
                    : "bg-accent-soft text-accent")
                }
              >
                {alreadyApproved ? "Approved" : "Awaiting your reply"}
              </span>
            </div>
            <div className="text-[15px] font-bold text-ink">{resolution.title}</div>
            <div className="mt-1 text-[13px] font-semibold text-synced">{resolution.charge}</div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{resolution.body}</div>
            {!alreadyApproved && cs.stage !== "completed" && !isSales && (
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => approveResolution(resolution.title)}
                  disabled={approving}
                  className="flex h-11 flex-1 items-center justify-center rounded-xl bg-primary text-[13.5px] font-bold text-white shadow-stone disabled:opacity-60"
                >
                  {approving ? "Sending…" : "Approve"}
                </button>
                <button
                  onClick={focusCommentBox}
                  className="flex h-11 flex-1 items-center justify-center rounded-xl border border-border bg-surface text-[13.5px] font-bold text-ink"
                >
                  Ask a question
                </button>
              </div>
            )}
          </div>
        )}

        {/* Contact row — Message scrolls & focuses the comment textarea
            further down. (Call button removed with the phone channel,
            Nick 2026-07-06 — email/portal messages are the channels.) */}
        <div className="flex gap-2">
          <button
            onClick={focusCommentBox}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-surface text-[13px] font-semibold text-ink"
          >
            <MessageSquare size={14} /> Message
          </button>
        </div>

        {/* Divider before the detail sections — items / issue / photos
            / updates / message box. Kept below the primary hero so the
            page reads clean above the fold. */}
        <div className="mt-1 h-px w-full bg-border-subtle" />

        {/* Items */}
        <section className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Items under service
          </h2>
          {items.length === 0 ? (
            <div className="text-[12px] text-ink-muted">No items recorded.</div>
          ) : (
            <ul className="space-y-2">
              {items.map((it) => (
                <li key={it.id} className="flex items-center gap-3 text-[13px]">
                  <Package size={14} className="text-ink-muted" />
                  <span className="font-mono text-[11px]">{it.item_code}</span>
                  <span className="flex-1 truncate text-ink-secondary">{it.item_description || ""}</span>
                  {it.qty && <span className="text-[11px] text-ink-muted">× {it.qty}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Reported issue */}
        <section className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Reported issue
          </h2>
          <div className="whitespace-pre-line text-sm text-ink">{cs.complaint_issue || "—"}</div>
          {cs.category && (
            <div className="mt-2 text-[11px] text-ink-muted">Category: {cs.category}</div>
          )}
        </section>

        {/* Photos */}
        <section className="rounded-2xl border border-border bg-surface p-5">
          <UploadDropZone disabled={uploading} onFiles={(files) => void uploadFiles(files)}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Photos &amp; evidence
            </h2>
            <label className={`inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-semibold text-ink hover:border-accent/40 ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
              <Upload size={11} /> {uploading ? "Uploading…" : "Upload photo"}
              <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden" onChange={onFile} disabled={uploading} />
            </label>
          </div>
          {attachments.length === 0 ? (
            <div className="text-[12px] text-ink-muted">No photos yet.</div>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {attachments.map((a, i) => (
                <PortalPhoto
                  key={a.id}
                  token={token}
                  attId={a.id}
                  label={a.category}
                  contentType={a.content_type}
                  mine={a.source === selfSource}
                  onClick={() => setLightboxIndex(i)}
                  onRemove={
                    a.source === selfSource && cs.stage !== "completed"
                      ? () => archivePhoto(a.id)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          <div className="mt-2 text-[10px] text-ink-muted">
            JPG / PNG / WEBP · up to 10 MB each · drag &amp; drop or paste (Ctrl+V) supported.
          </div>
          </UploadDropZone>
        </section>

        {/* Updates (timeline) */}
        <section className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Updates
          </h2>
          <ul className="space-y-3">
            {timeline.map((t) => (
              <li key={t.id} className="group border-l-2 border-border pl-3 text-[13px]">
                <div className="flex items-center gap-2 text-[11px] text-ink-muted">
                  <span>{formatDateTime(t.at)}</span>
                  {t.source === selfSource && t.action.endsWith("_comment") && cs.stage !== "completed" && (
                    <button
                      onClick={() => archiveComment(t.id)}
                      className="ml-auto rounded p-0.5 opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
                      title="Remove this comment"
                      aria-label="Remove this comment"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
                <div>
                  {t.source === selfSource && (
                    <span className="mr-1 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent">
                      You
                    </span>
                  )}
                  {isSales && t.source === "customer" && (
                    <span className="mr-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
                      Customer
                    </span>
                  )}
                  {t.label}
                </div>
                {t.note && <div className="mt-1 whitespace-pre-line text-ink-secondary">{t.note}</div>}
              </li>
            ))}
            {timeline.length === 0 && (
              <li className="text-[12px] text-ink-muted">No updates yet.</li>
            )}
          </ul>
        </section>

        {/* Message / question box (the "Message" and "Ask a question"
            buttons above scroll & focus this textarea). */}
        {cs.stage !== "completed" && (
          <section className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Message the team
            </h2>
            <textarea
              ref={commentBoxRef}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="Ask a question or share an update…"
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              maxLength={2000}
            />
            <div className="mt-2 flex items-center justify-end">
              <button
                onClick={postComment}
                disabled={!comment.trim() || posting}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-white disabled:opacity-50"
              >
                <Send size={11} /> {posting ? "Sending…" : "Send"}
              </button>
            </div>
          </section>
        )}

        {/* Completed-case satisfaction summary */}
        {cs.stage === "completed" && cs.satisfaction_rating && (
          <section className="rounded-2xl border border-border bg-surface p-5 text-center">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Thanks for your feedback
            </div>
            <div className="inline-flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star
                  key={n}
                  size={20}
                  className={n <= (cs.satisfaction_rating ?? 0) ? "fill-amber-400 text-amber-400" : "text-ink-muted/40"}
                />
              ))}
            </div>
          </section>
        )}

        {err && (
          <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-sm text-err">
            {err}
          </div>
        )}

        {/* Secure link footer */}
        <div className="mt-2 flex items-center justify-center gap-1.5 text-center text-[10.5px] leading-relaxed text-ink-muted">
          <ShieldCheck size={12} className="text-ink-muted" />
          <span>Secure link · no login needed · only you can see this page.</span>
        </div>

      </div>

      {lightboxIndex !== null && attachments[lightboxIndex] && (
        <Lightbox
          attachments={attachments}
          token={token}
          index={lightboxIndex}
          selfSource={selfSource}
          onChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </PortalFrame>
  );
}

function PortalPhoto({ token, attId, label, contentType, mine, onClick, onRemove }: {
  token: string;
  attId: number;
  label: string;
  contentType?: string | null;
  mine: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}) {
  const isVideo = (contentType || "").startsWith("video/");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (isVideo) return; // the tile shows a play badge — no bytes needed
    let revoked = false;
    portalApi
      .fetchBlobUrl(`/api/portal/case/attachments/${attId}`, token)
      .then((u) => { if (!revoked) setUrl(u); })
      .catch(() => {});
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attId, isVideo]);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        className="block w-full overflow-hidden rounded-md border border-border bg-bg text-left transition-all hover:border-accent/50 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
        aria-label={isVideo ? `Play ${label} video` : `View ${label} photo full-size`}
      >
        {isVideo ? (
          <div className="flex h-24 w-full flex-col items-center justify-center gap-1 bg-ink/80 text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20">
              <Play size={13} className="ml-0.5" />
            </span>
            <span className="text-[9px] font-semibold uppercase tracking-wider">Video</span>
          </div>
        ) : url ? (
          <img
            src={url}
            alt={label}
            className="h-24 w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="h-24 w-full animate-pulse bg-ink-muted/10" />
        )}
        <div className="flex items-center justify-between px-1.5 py-1 text-[9px] uppercase tracking-wider text-ink-muted">
          <span>{label}</span>
          {mine && <span className="text-accent">You</span>}
        </div>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="absolute right-1 top-1 rounded-full bg-ink/75 p-1 text-white opacity-0 transition-opacity hover:bg-err group-hover:opacity-100 focus:opacity-100"
          title="Remove this photo"
          aria-label="Remove this photo"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}

// ── Full-screen lightbox ─────────────────────────────────────
// Loads the currently-selected attachment at full resolution in a
// portal-ed overlay. Supports keyboard nav (←/→/Esc), clicking the
// backdrop to close, and swipe-like prev/next buttons on mobile.
function Lightbox({
  attachments,
  token,
  index,
  selfSource,
  onChange,
  onClose,
}: {
  attachments: PortalCaseDetail["attachments"];
  token: string;
  index: number;
  selfSource: string;
  onChange: (i: number) => void;
  onClose: () => void;
}) {
  const att = attachments[index];
  const [url, setUrl] = useState<string | null>(null);

  const go = useCallback(
    (delta: number) => {
      const next = (index + delta + attachments.length) % attachments.length;
      onChange(next);
    },
    [index, attachments.length, onChange]
  );

  // Keyboard handlers
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Load the current attachment as a blob URL
  useEffect(() => {
    setUrl(null);
    let revoked = false;
    portalApi
      .fetchBlobUrl(`/api/portal/case/attachments/${att.id}`, token)
      .then((u) => { if (!revoked) setUrl(u); })
      .catch(() => {});
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.id]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      {/* Top bar */}
      <div
        className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 px-4 py-3 text-white sm:px-6 sm:py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 text-[11px] uppercase tracking-[2pt]">
          <span className="rounded-full border border-white/30 px-2 py-0.5 font-semibold">
            {att.category}
          </span>
          {att.source === selfSource && (
            <span className="rounded-full bg-accent/90 px-2 py-0.5 font-semibold text-white">
              You
            </span>
          )}
          <span className="font-mono text-[10px] text-white/60">
            {index + 1} / {attachments.length}
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <X size={18} />
        </button>
      </div>

      {/* Prev / next (only when there's more than 1 photo) */}
      {attachments.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); go(-1); }}
            aria-label="Previous photo"
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:left-6"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); go(1); }}
            aria-label="Next photo"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:right-6"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      {/* Media */}
      <div
        className="relative flex max-h-[90vh] max-w-[92vw] items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          (att.content_type || "").startsWith("video/") ? (
            <video
              src={url}
              controls
              autoPlay
              playsInline
              className="max-h-[88vh] max-w-[92vw] rounded shadow-2xl"
            />
          ) : (
            <img
              src={url}
              alt={att.file_name || att.category}
              className="max-h-[88vh] max-w-[92vw] select-none object-contain shadow-2xl"
              draggable={false}
            />
          )
        ) : (
          <div className="flex h-64 w-64 items-center justify-center rounded bg-white/5 text-white/60">
            Loading…
          </div>
        )}
      </div>

      {/* Caption / filename */}
      {att.file_name && (
        <div
          className="absolute inset-x-0 bottom-0 px-4 py-3 text-center text-[11px] text-white/70 sm:py-4"
          onClick={(e) => e.stopPropagation()}
        >
          {att.file_name}
        </div>
      )}
    </div>,
    document.body
  );
}
