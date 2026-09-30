/* PMS document cards — the mobile per-document big-preview layout.
 *
 * Lifted out of MobilePMS.tsx (that file sits at its size ceiling) together
 * with the shared checklist/attachment types and small helpers both files use.
 * This module is a LEAF: it never imports from MobilePMS.tsx, so there is no
 * import cycle — MobilePMS imports everything it shares from here.
 *
 * Layout is the owner's pick "B2 · Preview besar" (2026-09-30): every document
 * card lists its files as FULL-WIDTH previews — the photo large enough to read
 * (defect evidence), the file name chipped onto the image, the per-photo
 * remark ("Reason:") below it, and the action buttons under that. Applies to
 * every doc tile for every cohort; the Stock Out / Stock In transfer records
 * are the one deliberate exception and keep their compact thumbnail rows.
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { api } from "../api/client";
import { MediaLightbox, type MediaItem } from "../components/MediaLightbox";
import { useAuth } from "../auth/AuthContext";
import { holdsChecklistApproval } from "../auth/projectAccess";
import { isReviewableTitle } from "../vendor/scm/lib/pms-reviewable-titles";
import { DefectFileActions } from "./MobilePmsDefectActions";

// ── Shared checklist types (moved from MobilePMS.tsx) ──
export type ChecklistItem = {
  id: number;
  seq: number;
  title: string;
  role_label: string | null;
  due_date: string | null;
  status: string | null; // pending | done | na | blocked | review | rejected | amended
  section_id: number | null;
  owner_name?: string | null;
  required_perm?: string | null;
  // mig 090 — payment / deposit rows render as multi-state pills instead of a
  // done/pending tick. pill_value stored via the standard checklist PATCH.
  pill_kind?: string | null; // "rental_payment" | "security_deposit" | null
  pill_value?: string | null; // none | unpaid | fully_paid | refunded
  review_status?: string | null; // drives the approve/reject gate
  notes?: string | null; // item-level remark (Deco/Coffee Table, Weekend Activity)
};

// Per-task attachment (mig 050). Grouped by item_id.
export type TaskAttachment = {
  id: number;
  item_id: number;
  r2_key: string;
  file_name: string | null;
  mime_type: string | null;
  uploader_name?: string | null;
  uploaded_at?: string | null;
  archived_at?: string | null;
  caption?: string | null;
};

// Dialog-hook signatures shared across the PMS screens.
export type NotifyFn = (o: { title: string; body?: ReactNode; tone?: "info" | "error" }) => Promise<void>;
export type ConfirmFn = (o: { title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;
export type PromptFn = (o: { title: string; body?: ReactNode; defaultValue?: string; placeholder?: string; confirmLabel?: string; validate?: (v: string) => string | null }) => Promise<string | null>;
export type SetBusy = Dispatch<SetStateAction<boolean>>;

// ── Small shared helpers (moved from MobilePMS.tsx) ──
// Best-effort content type from an R2 key's extension — some payloads
// (finance lines, phase photos) don't carry a stored mime type, and the
// lightbox needs one to decide between inline <img>/<video> and a
// download tile.
export const mimeFromKey = (key: string): string | null => {
  const m = /\.([a-z0-9]+)$/i.exec(key);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "heic"].includes(ext)) return `image/${ext === "jpg" ? "jpeg" : ext}`;
  if (["mp4", "webm"].includes(ext)) return `video/${ext}`;
  if (ext === "mov") return "video/quicktime";
  if (ext === "pdf") return "application/pdf";
  return null;
};

export function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Role-badge colours mirror the design's PROJ_TASKS palette, keyed by the
// checklist item's `role_label` (BD / PURCHASER / DRIVER / SALES PIC …).
const ROLE_COLOR: Record<string, string> = {
  BD: "#7a5c86",
  PURCHASER: "#a16a2e",
  DRIVER: "#2a6f9e",
  "SALES PIC": "#16695f",
  SALES: "#16695f",
  LOGISTIC: "#2f8a5b",
  // Shared sales+driver deliverables (the Defect List pair, owner 2026-07-29).
  "SALES PIC & DRIVER": "#16695f",
};
export const roleColor = (label: string) => ROLE_COLOR[label.toUpperCase()] ?? "#767b6e";
// Owner 2026-07-15: badges should read sentence-case ("Purchaser", "Driver",
// "Sales PIC") instead of shouting all-caps — but keep genuine acronyms
// (BD, PIC) uppercase, matching how the app writes them elsewhere.
const ROLE_ACRONYMS = new Set(["BD", "PIC", "PO", "DO", "PPE", "3D", "2D"]);
export const formatRoleLabel = (label: string): string =>
  label
    .trim()
    .split(/\s+/)
    .map((w) => (ROLE_ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
// Owner 2026-07-29: a combined role_label ("SALES PIC & DRIVER") renders as
// SEPARATE badges — one per role, each in its own colour — never one merged tag.
export const roleLabelParts = (label: string): string[] =>
  label.split("&").map((s) => s.trim()).filter(Boolean);

// Auth'd blob-URL thumbnail for an R2 attachment key.
export function R2Thumb({ r2Key, style }: { r2Key: string; style?: CSSProperties }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    api.fetchBlobUrl(`/api/projects/attachments/${r2Key}`)
      .then((u) => { if (live) { made = u; setUrl(u); } else URL.revokeObjectURL(u); })
      // Preview only — a failed fetch keeps the hatched placeholder; the
      // full-size viewer surfaces the real error when the file is opened.
      .catch(() => { if (live) setUrl(null); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [r2Key]);
  if (!url) return <div className="ph" style={style} />;
  return <img src={url} alt="" style={{ ...style, objectFit: "cover", display: "block" }} />;
}

// One confirm-guarded checklist-attachment delete, shared by the doc cards and
// the Floor-Plans card so both keep exactly one remove path.
export async function removeChecklistAttachment(
  att: { id: number; file_name?: string | null },
  o: { confirm?: ConfirmFn; notify: NotifyFn; setBusy: SetBusy; reload: () => void },
): Promise<void> {
  if (o.confirm && !(await o.confirm({ title: `Remove ${att.file_name || "this file"}?`, confirmLabel: "Remove", danger: true }))) return;
  o.setBusy(true);
  try {
    await api.del(`/api/projects/checklist/attachments/${att.id}`);
    o.reload();
  } catch (e) {
    await o.notify({ title: "Remove failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
  } finally {
    o.setBusy(false);
  }
}

// ── The B2 full-width file preview ──
// Image files render large (tap → lightbox) with the file name chipped onto
// the photo; PDFs/videos keep a short hatched block with the same chip. The
// optional × (top-right) is the editor's remove — confirm-guarded by the
// caller via removeChecklistAttachment.
export function BigFilePreview({
  media, onOpen, onRemove, busy, height = 200,
}: {
  media: MediaItem;
  onOpen: () => void;
  onRemove?: () => void;
  busy?: boolean;
  height?: number;
}) {
  const isImage = /^image\//.test(media.content_type ?? "");
  const name = media.caption || "File";
  return (
    <div style={{ position: "relative" }}>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
        style={{ cursor: "pointer" }}
      >
        {isImage ? (
          <R2Thumb r2Key={media.r2_key} style={{ width: "100%", height, borderRadius: 10, border: "1px solid #e3e6e0" }} />
        ) : (
          <div className="ph" style={{ height: 92, borderRadius: 10, border: "1px solid #e3e6e0", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "#767b6e", background: "rgba(255,255,255,.85)", border: "1px solid #d6d9d2", borderRadius: 7, padding: "3px 9px" }}>
              {(media.content_type === "application/pdf" ? "PDF" : "FILE")} · tap to view
            </span>
          </div>
        )}
      </div>
      <span
        style={{
          position: "absolute", left: 8, bottom: 8, maxWidth: "72%",
          background: "rgba(17,20,15,.72)", color: "#fff", fontSize: 10, fontWeight: 600,
          padding: "3px 9px", borderRadius: 7, overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap", pointerEvents: "none",
        }}
      >
        {name}
      </span>
      {onRemove && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Remove ${name}`}
          title="Remove file"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{
            position: "absolute", top: 6, right: 6, width: 24, height: 24,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(17,20,15,.62)", color: "#fff", border: "none",
            borderRadius: 12, cursor: "pointer", padding: 0,
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </div>
  );
}

// Upload glyph — owner 2026-09-30: every task the viewer may edit must SHOW
// its upload affordance, icon included, so the button reads as an action and
// an editable doc is never mistaken for a view-only one.
export function UploadGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }} aria-hidden="true">
      <path d="M12 16V4m0 0 4 4m-4-4-4 4" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

// The mockup's "Reason:" strip — a per-photo remark under its preview.
export function RemarkStrip({ label = "Remark", text }: { label?: string; text: string }) {
  return (
    <div style={{ background: "#faf9f5", borderLeft: "3px solid #d8a85a", borderRadius: 7, padding: "7px 10px", fontSize: 11.5, lineHeight: 1.45, color: "#414539", marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      <b style={{ color: "#a16a2e" }}>{label}:</b> {text}
    </div>
  );
}

// ── Doc tiles (owner 2026-07-17, re-specced 2026-09-30 to the B2 layout) ──
export type DocTile = {
  label: string;
  match: RegExp;
  salesPicOnly?: boolean;
  /** Pin to the DRIVER-badged variant when a title exists in two roles. */
  driverOnly?: boolean;
  remarkTile?: boolean;
  /** Owner 2026-07-21 (crew Decoration): the item's remark AND its files,
   *  files view/download-only. */
  remarkWithFiles?: boolean;
  requirePhotoRemark?: boolean;
  /** Kept for call-site compatibility — every block is full-width in the B2
   *  stacked layout, so these two are no longer read. */
  fullWidth?: boolean;
  mediaH?: number;
  /** Owner 2026-07-17: BD-owned items — sales VIEW + DOWNLOAD only, no
   *  edit/upload/remove from this card. */
  readOnly?: boolean;
};

export const SALES_DOC_TILES: ReadonlyArray<DocTile> = [
  { label: "Weekend Activity", match: /^weekend/i, remarkTile: true, readOnly: true },
  { label: "Permit", match: /permit/i, readOnly: true },
  { label: "Decoration", match: /^deco/i, readOnly: true, remarkWithFiles: true },
  { label: "Setup Image", match: /^setup image/i, salesPicOnly: true },
  // Defect List split (owner 2026-07-29): Setup + Dismantle variants, both
  // shared with the driver crew ("SALES PIC & DRIVER") and both keeping the
  // compulsory per-photo remark.
  { label: "Defect Item Setup", match: /^defect (list|item) setup/i, requirePhotoRemark: true },
  { label: "Defect Item Dismantle", match: /^defect (list|item) dismantle/i, requirePhotoRemark: true },
  { label: "Event Complete Image", match: /^event complete image/i },
];

// Match BOTH title families — live rows are "Defect Item …", not
// "Defect List …" (BUG-HISTORY 2026-08-07: the narrow match hid the buttons).
export const isDefectTile = (t: { item?: ChecklistItem | null }): boolean =>
  /^defect (list|item)/i.test((t.item?.title ?? "").trim());

// Stock Out / Stock In transfer records are the one doc type EXEMPT from the
// B2 big-preview layout (owner 2026-09-30: "stock out in ... remain same") —
// they keep the compact thumbnail + name + View row.
const isStockTransferTitle = (title: string | null | undefined): boolean =>
  /^stock\s*(in|out)\s*transfer/i.test((title ?? "").trim());

// Reviewer's Defect-list card (owner 2026-09-15). readOnly — reviewers stamp,
// never upload; isDefectTile still renders the file list + actions.
export const DEFECT_REVIEW_TILES: ReadonlyArray<DocTile> = [
  { label: "Defect Item Setup", match: /^defect (list|item) setup/i, readOnly: true },
  { label: "Defect Item Dismantle", match: /^defect (list|item) dismantle/i, readOnly: true },
];

export const CREW_DOC_TILES: ReadonlyArray<DocTile> = [
  // Owner 2026-07-22: Stock Out + Blank Floorplan tiles removed (floorplan
  // lives in the Floor plans & layout card below).
  { label: "Permit", match: /permit/i, readOnly: true },
  { label: "Decoration", match: /^deco/i, readOnly: true, remarkWithFiles: true },
  // Defect pair (owner 2026-07-29): crew EDIT, compulsory remark per photo.
  { label: "Defect Item Setup", match: /^defect (list|item) setup/i, requirePhotoRemark: true },
  { label: "Defect Item Dismantle", match: /^defect (list|item) dismantle/i, requirePhotoRemark: true },
];

// ── Document review (Approve / Reject) — shared by the doc cards ──
// The rule now lives in pms-reviewable-titles.ts, shared with desktop, which
// used to test a Set of EXACT titles — so a suffixed row got this workflow here
// and no review controls at all on the PC.

// After uploading to a reviewable doc, auto-submit it so the approver's
// Approve/Reject (re)appear — desktop does exactly this (Projects.tsx upload →
// onReview("submit")). Non-perm reviewables (3D/2D/Display/Exchange) depend on
// this: their gate needs review_status=pending_review, which nothing else sets.
// Non-fatal: a failed submit only delays the amber PENDING badge.
export async function autoSubmitReviewable(itemId: number, title: string | null | undefined): Promise<void> {
  if (!isReviewableTitle(title)) return;
  try {
    await api.post(`/api/projects/checklist/${itemId}/review`, { action: "submit" });
  } catch {
    /* silent-write-ok: the UPLOAD already succeeded and is on screen. This
       only delays the amber PENDING badge, and the approver can still submit
       via re-upload, so there is nothing for the uploader to act on. */
  }
}

// Whether to show Approve/Reject on a document tile — desktop-parity gate
// (pages/Projects.tsx DocRow): once a file exists, a holder of the item's
// approval permission decides a still-open gated doc; an un-permed reviewable
// keeps the submit-then-review flow (any viewer, while a review is pending).
// canApprove = wildcard-free: an explicit approval key is required for the four
// EXPLICIT_APPROVAL_KEYS, but a non-perm reviewable is open to any viewer.
export function checklistReviewVisible(
  permissions: readonly string[] | null | undefined,
  item: ChecklistItem | undefined,
  hasFiles: boolean,
): boolean {
  if (!item || !hasFiles) return false;
  const reviewStatus = (item.review_status ?? "").toLowerCase();
  const canApprove = !item.required_perm || holdsChecklistApproval(permissions, item.required_perm);
  const awaitingReview = reviewStatus === "pending_review" || reviewStatus === "amended";
  // Owner 2026-07-31 (final): on a gated document the approver ALWAYS keeps
  // Approve / Reject once a file exists — including one already approved — so a
  // decision can be reviewed or reversed at any time. (Previously the buttons
  // vanished the moment it was approved, which read as "the feature is
  // missing": on prod all 248 3D Designs were approved, so no event showed
  // them.) The current decision still rides the tile as its APPROVED /
  // REJECTED / PENDING badge, and every click is logged to the comment
  // history, so reversals stay auditable. `status`/`awaitingReview` are no
  // longer part of this arm — the permission alone decides.
  if (item.required_perm) return canApprove;
  const reviewable = isReviewableTitle(item.title);
  return reviewable && awaitingReview && canApprove;
}

// The Approve / Reject button pair + review handler, shared by the doc cards.
// Reject requires a reason (prompt); both POST /checklist/:id/review (the
// endpoint re-checks the approval permission server-side → 403s a non-holder).
export function ReviewButtons({
  item, busy, setBusy, prompt, notify, reload,
}: {
  item: ChecklistItem;
  busy: boolean;
  setBusy: SetBusy;
  prompt: PromptFn;
  notify: NotifyFn;
  reload: () => void;
}) {
  const review = async (action: "approve" | "reject") => {
    const body: Record<string, unknown> = { action };
    if (action === "reject") {
      const reason = await prompt({ title: `Reject "${item.title}"?`, placeholder: "Reason (required)", validate: (v) => (v.trim() ? null : "A reason is required.") });
      if (reason == null || !reason.trim()) return;
      body.reason = reason.trim();
    }
    setBusy(true);
    try {
      await api.post(`/api/projects/checklist/${item.id}/review`, body);
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  // Toggle (owner 2026-08-10): show only the button that REVERSES the current
  // decision. Approve hidden once approved (Reject stays, to re-open); Reject
  // hidden once rejected (Approve stays, to approve the fix). The status itself
  // stays visible via the ReviewBadge next to these buttons.
  const rs = (item.review_status ?? "").toLowerCase();
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
      {rs !== "approved" && (
        <button className="tinybtn" style={{ flex: 1, background: "#e2f0e9", borderColor: "#bcdcd7", color: "#2f8a5b" }} disabled={busy} onClick={(e) => { e.stopPropagation(); void review("approve"); }}>Approve</button>
      )}
      {rs !== "rejected" && (
        <button className="tinybtn" style={{ flex: 1, background: "#f7e7e5", borderColor: "#e6c9c6", color: "#a13a34" }} disabled={busy} onClick={(e) => { e.stopPropagation(); void review("reject"); }}>Reject</button>
      )}
    </div>
  );
}

// Small review-decision badge (green approved / red rejected / amber pending),
// shared by the doc cards. Renders nothing when there's no decision yet.
// Owner 2026-07-31: "cant see which one not approve yet". A reviewable doc that
// carries a file but has NO decision yet (review_status NULL — uploaded before
// auto-submit existed, or never submitted) used to render NO badge at all, so
// approved and un-approved documents looked identical on the tile. Pass
// `item`+`hasFiles` and it now says NOT APPROVED instead of staying blank.
// Nothing shows on an empty document — there is nothing to approve yet.
export function ReviewBadge({
  reviewStatus, item, hasFiles,
}: {
  reviewStatus: string | null | undefined;
  item?: ChecklistItem;
  hasFiles?: boolean;
}) {
  const rs = (reviewStatus ?? "").toLowerCase();
  if (!rs) {
    const reviewable = !!item && (!!item.required_perm || isReviewableTitle(item.title));
    const approvedByStatus = (item?.status ?? "").toLowerCase() === "done";
    if (!reviewable || !hasFiles || approvedByStatus) return null;
    return <span className="rbadge" style={{ background: "#f6efd9", color: "#6e4d12" }}>NOT APPROVED</span>;
  }
  return (
    <span className="rbadge" style={{
      background: rs === "approved" ? "#e2f0e9" : rs === "rejected" ? "#f7e7e5" : "#f6efd9",
      color: rs === "approved" ? "#2f8a5b" : rs === "rejected" ? "#a13a34" : "#6e4d12",
    }}>{humanize(rs).toUpperCase()}</span>
  );
}

// ── The document card (owner's B2 layout, 2026-09-30, all cohorts) ──
// Each matched checklist doc renders as a full-width block: header (name,
// file count, role chips, review badge), then every file as a BigFilePreview
// with its remark and actions below — defect files carry the Done / Replace
// review loop (DefectFileActions), stock transfer records keep the compact
// row style, remark docs (Weekend Activity) stay a tap-to-edit remark box.
export function SalesDocsCard({
  checklist, attachments, canTick, busy, setBusy, notify, prompt, confirm, reload,
  tiles: tileDefs = SALES_DOC_TILES,
  title = "Setup & Dismantle documents",
  showRoleTags = false,
  bare = false,
}: {
  checklist?: ChecklistItem[];
  attachments?: TaskAttachment[];
  canTick: boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  prompt: PromptFn;
  confirm: ConfirmFn;
  reload: () => void;
  /** Tile set — defaults to the sales set; crew pass CREW_DOC_TILES. */
  tiles?: ReadonlyArray<DocTile>;
  title?: string;
  /** Owner 2026-07-23: show each task's role chip (DRIVER / SALES PIC / …) on
   *  the block — for oversight viewers (mgt, BD, owner, SD, logistic). */
  showRoleTags?: boolean;
  /** Render the blocks WITHOUT the collapsible card shell — used to embed the
   *  Agreement/Quotation block inside the Team card, below the PIC name
   *  (owner 2026-09-30: "quotation move below PIC name"). */
  bare?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pendingRef = useRef<{ itemId: number; title: string | null; caption?: string } | null>(null);
  const [view, setView] = useState<{ items: MediaItem[]; idx: number } | null>(null);
  // Approve/Reject on the doc blocks (owner 2026-07-29). The tasklist that used
  // to carry these is gone on mobile, so a reviewable doc (Agreement/Quotation,
  // Stock Out/In, 3D/2D Design, Display Floorplan, Exchange List) had no way to
  // be approved on a phone. Gate + endpoint match the desktop DocRow exactly
  // (shared checklistReviewVisible / ReviewButtons); user drives the perm check.
  const { user } = useAuth();
  // Owner 2026-09-03: every user may remove a file from THEIR OWN task, so this
  // follows the card's own edit right instead of projects.manage. Each use site
  // already ANDs `!t.readOnly`, which is what marks a block as not this
  // cohort's to work on.
  const canDeleteFiles = canTick;

  const tiles = tileDefs.map((t) => {
    const item = (checklist ?? []).find(
      (it) =>
        t.match.test((it.title || "").trim()) &&
        (!t.salesPicOnly || (it.role_label ?? "").trim().toUpperCase() === "SALES PIC") &&
        (!t.driverOnly || (it.role_label ?? "").trim().toUpperCase() === "DRIVER")
    );
    const atts = item
      ? (attachments ?? []).filter((a) => !a.archived_at && a.item_id === item.id)
      : [];
    const files = atts.map((a): MediaItem => ({
      r2_key: a.r2_key,
      content_type: a.mime_type ?? mimeFromKey(a.r2_key),
      caption: a.file_name,
    }));
    return { ...t, item, atts, files };
  }).filter((t) => t.item);

  if (tiles.length === 0) return null;

  const doneCount = tiles.filter((t) =>
    t.remarkTile ? !!(t.item?.notes ?? "").trim()
    : t.remarkWithFiles ? (t.files.length > 0 || !!(t.item?.notes ?? "").trim())
    : t.files.length > 0
  ).length;

  const startUpload = async (t: (typeof tiles)[number]) => {
    if (!t.item || t.readOnly) return;
    let caption: string | undefined;
    if (t.requirePhotoRemark) {
      const remark = await prompt({
        title: "Remark for this photo",
        placeholder: "e.g. scratch on left armrest",
        validate: (v) => (v.trim() ? null : "Please write a remark before uploading."),
      });
      if (remark == null || !remark.trim()) return;
      caption = remark.trim();
    }
    pendingRef.current = { itemId: t.item.id, title: t.item.title, caption };
    fileRef.current?.click();
  };

  const upload = async (file: File) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    if (file.size > 10 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 10MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const capParam = pending.caption ? `&caption=${encodeURIComponent(pending.caption)}` : "";
      await api.putBinary(
        `/api/projects/checklist/${pending.itemId}/attachments?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(file.name)}${capParam}`,
        buf,
        file.type || "application/octet-stream",
      );
      // Reviewable docs auto-submit so the approver's Approve/Reject appear (desktop parity).
      await autoSubmitReviewable(pending.itemId, pending.title);
      reload();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const editRemark = async (t: (typeof tiles)[number]) => {
    if (!t.item || !canTick) return;
    const val = await prompt({
      title: `Remark — ${t.label}`,
      placeholder: "Write the remark…",
      defaultValue: t.item.notes ?? "",
    });
    if (val == null) return;
    setBusy(true);
    try {
      await api.patch(`/api/projects/checklist/${t.item.id}`, { notes: val.trim() });
      reload();
    } catch (e) {
      await notify({ title: "Save failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  // The remark face (Weekend Activity, Decoration) — tap edits when this
  // cohort owns it, otherwise surfaces the full text (the box clamps).
  const openRemark = async (t: (typeof tiles)[number]) => {
    if (canTick && !t.readOnly) { await editRemark(t); return; }
    const txt = (t.item?.notes ?? "").trim();
    await notify(txt
      ? { title: t.label, body: txt }
      : { title: t.label, body: "No remark has been written yet.", tone: "info" });
  };

  const body = (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {tiles.map((t) => {
          const hasContent = t.remarkTile ? !!(t.item?.notes ?? "").trim()
            : t.remarkWithFiles ? (t.files.length > 0 || !!(t.item?.notes ?? "").trim())
            : t.files.length > 0;
          // Review state (desktop parity) — shared gate + badge + buttons.
          const rItem = t.item!;
          const canReview = checklistReviewVisible(user?.permissions, rItem, t.files.length > 0);
          const editable = canTick && !t.readOnly;
          const remarkText = (t.item?.notes ?? "").trim();
          const isDefect = isDefectTile(t);
          const compactRows = isStockTransferTitle(t.item?.title);
          return (
            <div key={t.label} style={{ border: "1px solid #d6d9d2", borderRadius: 12, background: "#fff", padding: "10px 11px", display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Block header — name · count badge · role chips · review badge */}
              <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#11140f", marginRight: "auto" }}>{t.label}</span>
                {/* Owner 2026-07-23: oversight viewers (mgt/BD/owner/SD/
                    logistic) see WHO owns each deliverable — the task's
                    role chip, same colours as the old tasklist rows. */}
                {showRoleTags && (t.item?.role_label ?? "").trim() && roleLabelParts(t.item!.role_label!).map((part) => (
                  <span key={part} className="rbadge" style={{ background: `${roleColor(part)}1f`, color: roleColor(part) }}>
                    {formatRoleLabel(part)}
                  </span>
                ))}
                {/* Review decision (owner 2026-07-29): green approved ·
                    red rejected · amber pending — travels with the block. */}
                <ReviewBadge reviewStatus={rItem.review_status} item={rItem} hasFiles={t.files.length > 0} />
                <span className="rbadge" style={{ background: hasContent ? "#e2f0e9" : "#f0f1ed", color: hasContent ? "#2f8a5b" : "#9aa093" }}>
                  {t.remarkTile || (t.remarkWithFiles && t.files.length === 0)
                    ? (hasContent ? "DONE" : "NONE")
                    : (hasContent ? `${t.files.length} FILE${t.files.length === 1 ? "" : "S"}` : "NONE")}
                </span>
              </div>

              {/* Remark face (Weekend Activity / Decoration) */}
              {(t.remarkTile || t.remarkWithFiles) && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (!busy) void openRemark(t); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!busy) void openRemark(t); } }}
                  style={{ background: "#faf9f5", border: "1px solid #eceee9", borderRadius: 9, padding: "8px 10px", fontSize: 11.5, lineHeight: 1.45, color: remarkText ? "#414539" : "#9aa093", cursor: "pointer", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                >
                  {remarkText || (editable && t.remarkTile ? "Tap to write the remark…" : "No remark yet.")}
                </div>
              )}

              {/* Files. Stock Out/In transfer records keep the COMPACT row
                  (owner 2026-09-30: "stock out in ... remain same"); everything
                  else gets the B2 full-width preview + remark + actions. */}
              {!t.remarkTile && compactRows && t.atts.map((a, i) => (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span
                    role="button"
                    onClick={() => setView({ items: t.files, idx: i })}
                    style={{ flex: "none", width: 54, height: 44, borderRadius: 7, overflow: "hidden", border: "1px solid #e3e6e0", cursor: "pointer", display: "block" }}
                  >
                    {/^image\//.test(t.files[i]?.content_type ?? "")
                      ? <R2Thumb r2Key={a.r2_key} style={{ width: 54, height: 44 }} />
                      : <span className="ph" style={{ display: "block", width: 54, height: 44 }} />}
                  </span>
                  <span style={{ flex: 1, minWidth: 80, fontSize: 11, color: "#414539" }}>{a.file_name || "Record"}</span>
                  <button type="button" className="tinybtn" onClick={() => setView({ items: t.files, idx: i })}>View</button>
                  {editable && canDeleteFiles && (
                    <button
                      type="button"
                      className="tinybtn"
                      disabled={busy}
                      aria-label={`Remove ${a.file_name || "record"}`}
                      style={{ color: "#a13a34" }}
                      onClick={() => void removeChecklistAttachment(a, { confirm, notify, setBusy, reload })}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {!t.remarkTile && !compactRows && t.atts.map((a, i) => (
                <div key={a.id}>
                  <BigFilePreview
                    media={t.files[i]}
                    busy={busy}
                    onOpen={() => setView({ items: t.files, idx: i })}
                    onRemove={editable && canDeleteFiles
                      ? () => void removeChecklistAttachment(a, { confirm, notify, setBusy, reload })
                      : undefined}
                  />
                  {/* Per-photo remark. Defect photos carry theirs (Model/
                      Reason) inside DefectFileActions, which also brings the
                      Done/Replace loop + timeline. */}
                  {isDefect ? (
                    <DefectFileActions att={{ id: a.id, r2_key: a.r2_key, content_type: t.files[i]?.content_type, caption: a.caption }} wide />
                  ) : (
                    (a.caption ?? "").trim() && <RemarkStrip text={(a.caption ?? "").trim()} />
                  )}
                </div>
              ))}

              {/* Empty state — a slim tap target instead of the old hatched
                  thumbnail, so "nothing here yet" stays obvious. */}
              {!t.remarkTile && !t.remarkWithFiles && t.atts.length === 0 && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (busy) return; if (editable) { void startUpload(t); } else { void notify({ title: `${t.label} not uploaded`, body: "Nothing has been uploaded here yet.", tone: "info" }); } }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } }}
                  style={{ border: "1px dashed #d6d9d2", borderRadius: 9, padding: "13px 10px", textAlign: "center", fontSize: 11, color: "#9aa093", cursor: "pointer" }}
                >
                  {editable ? "No file yet — tap to upload" : "No file yet"}
                </div>
              )}

              {editable && !t.remarkTile && (
                <button className="tinybtn" style={{ width: "100%", padding: "8px 9px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }} disabled={busy} onClick={() => void startUpload(t)}>
                  <UploadGlyph />
                  {t.files.length ? "+ Add more" : "Upload"}
                </button>
              )}

              {/* N/A — no defect (owner 2026-07-29): sales PIC + driver mark a
                  defect list N/A when nothing is defective. Tap again undoes. */}
              {isDefect && t.item && editable && (
                <button
                  className="tinybtn"
                  style={{ width: "100%", background: t.item.status === "na" ? "#f4f6f3" : "#fff", color: "#767b6e" }}
                  disabled={busy}
                  onClick={async () => {
                    const next = t.item!.status === "na" ? "pending" : "na";
                    setBusy(true);
                    try {
                      await api.post(`/api/projects/checklist/${t.item!.id}/status`, { status: next });
                      reload();
                    } catch (e) {
                      await notify({ title: "Failed to update", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t.item.status === "na" ? "Marked N/A — tap to undo" : "N/A — no defect"}
                </button>
              )}

              {/* Approve / Reject — shown to a holder of this doc's approval
                  permission (server re-checks). Renders even on a read-only
                  block: the approver often isn't the uploader. */}
              {canReview && (
                <ReviewButtons item={rItem} busy={busy} setBusy={setBusy} prompt={prompt} notify={notify} reload={reload} />
              )}
            </div>
          );
        })}
      </div>
      <input ref={fileRef} type="file" accept="image/*,.pdf,.mp4,.mov,.webm" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
      {view && (
        <MediaLightbox
          items={view.items}
          index={view.idx}
          onChange={(i) => setView((v) => (v ? { ...v, idx: i } : v))}
          onClose={() => setView(null)}
          baseUrl="/api/projects/attachments"
          badge="Document"
        />
      )}
    </>
  );

  if (bare) return <div style={{ marginBottom: 10 }}>{body}</div>;

  return (
    <details className="pacc" open>
      <summary>
        <span className="psec-t">{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: "#9aa093" }}>{doneCount}/{tiles.length}</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">{body}</div>
    </details>
  );
}
