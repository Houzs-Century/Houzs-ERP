/**
 * Supplier Portal — service request view.
 *
 * Card-based layout matching PortalCaseDetail (customer portal) so the
 * two portals feel like the same shell. Sections top→bottom:
 *   - Header: ASSR no + stage pill + supplier name + dates + PO/Ref
 *   - Items under service
 *   - Reported issue
 *   - Goods Returned Note (read-only, from Houzs)
 *   - Service Note (editable, supplier owns)
 *   - Photos & evidence (Service issue + Operation QC checked)
 *   - Add a remark (one-off messages, fire-and-forget to Houzs)
 *   - Update job status (Picked up / Repair complete / Returned)
 *
 * Auth: token in URL (/portal/supplier/:token). No localStorage —
 * link IS the auth, matching the customer portal model.
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Package, Printer, Trash2, Upload } from "lucide-react";
import { portalApi } from "../portalApi";
import { prepareImageForUpload } from "../../lib/imagePipeline";
import { UploadDropZone, useStrayFileDropGuard } from "../../lib/uploadDropZone";
import { PortalFrame } from "../components/PortalFrame";
import { StatusPill } from "../components/StatusPill";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { ASSR_STAGE_LABEL } from "../../vendor/scm/lib/assr-stage-labels";
import { useDialog } from "../../hooks/useDialog";
import { PrintPreviewModal, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PortalStatusColor } from "../types";
import { fmtDate } from "../../vendor/shared/format";

const ALLOWED_EXT = ["jpg", "jpeg", "png", "webp"];
const MAX_SIZE = 10 * 1024 * 1024;

// ── Types (mirror backend supplierPortal.ts response) ──────────────

type SupplierCase = {
  case: {
    id: number;
    assr_no: string;
    stage: string;
    complained_date: string | null;
    complaint_issue: string | null;
    issue_category: string | null;
    resolution_method: string | null;
    service_category: string | null;
    po_no: string | null;
    ref_no: string | null;
    addr1: string | null;
    addr4: string | null;
    location: string | null;
    customer_name: string | null;
    supplier_pickup_at: string | null;
    items_ready_at: string | null;
    do_date: string | null;
    delivery_order: string | null;
    creditor_code: string | null;
    stage_entered_at: string | null;
    stage_target_days: number | null;
    // Mig 106 — the supplier owns supplier_service_note; goods_returned_note
    // is read-only for them (surfaced so they know what came in).
    supplier_service_note: string | null;
    goods_returned_note: string | null;
    // Mig 108 — Accept job + Submit quote (design handoff).
    supplier_accepted_at: string | null;
    supplier_quote_labour: number | null;
    supplier_quote_materials: number | null;
    supplier_quote_at: string | null;
  };
  supplier_name: string | null;
  items: Array<{
    id: number;
    item_code: string;
    item_description: string | null;
    qty: number | null;
  }>;
  attachments: Array<{
    id: number;
    category: string;
    file_name: string | null;
    content_type: string | null;
    created_at: string;
  }>;
  stage_history: Array<{
    id: number;
    stage: string;
    entered_at: string;
    exited_at: string | null;
    target_days: number | null;
    status: string | null;
    skipped: number;
    skip_reason: string | null;
  }>;
};

const STAGE_LABEL: Record<string, string> = {
  pending_review: "Review",
  under_verification: "Verification",
  pending_solution: "Solution",
  pending_supplier_pickup: "Pickup / Return",
  pending_item_ready: "Pending Item Ready",
  pending_delivery_service: "Delivery / Service",
  completed: "Completed",
  // Read, not retyped. This exact string had six hand-written homes and the
  // customer portal's copy — the only one a customer reads — had none at all
  // and printed the raw slug. (The rows ABOVE are this screen's short pill
  // vocabulary, a different question, and still a hand-written copy shared
  // with the other pill screens — see BUG-HISTORY, not yet unified.)
  voided: ASSR_STAGE_LABEL.voided,
};

// Map stage → StatusPill palette so the supplier header uses the
// same visual vocabulary as the customer portal (server-side
// `status_color` isn't returned on the supplier endpoint).
const STAGE_COLOR: Record<string, PortalStatusColor> = {
  pending_review: "grey",
  under_verification: "amber",
  pending_solution: "amber",
  pending_supplier_pickup: "violet",
  pending_item_ready: "violet",
  pending_delivery_service: "blue",
  completed: "green",
};

// Read-only 5-step job progress (set by Houzs, never by the supplier).
// Internal 9 stages collapse into the supplier-facing buckets.
const SUPPLIER_STEPS = [
  "Inspection",
  "Pickup",
  "Service in progress",
  "Ready to send to warehouse",
  "Done",
] as const;

function supplierStepFor(cs: { stage: string; items_ready_at: string | null }): number {
  switch (cs.stage) {
    case "completed":
    case "pending_delivery_service":
      return 5;
    case "pending_item_ready":
      return cs.items_ready_at ? 4 : 3;
    case "pending_supplier_pickup":
    // Retired stage (mig 0110) — legacy alias for mid-flight links.
    case "pending_item_pickup":
      return 2;
    default:
      return 1;
  }
}


// ── Page ───────────────────────────────────────────────────────────

export function PortalSupplierCasePage() {
  const { token = "" } = useParams();
  const nav = useNavigate();
  const dialog = useDialog();
  /* Declared up here, above the loading / error early returns, so the hook
     count is stable — the Print preview it drives renders far below. */
  const print = usePrintPreview(() => window.print());

  const [data, setData] = useState<SupplierCase | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [quoteLabour, setQuoteLabour] = useState("");
  const [quoteMaterials, setQuoteMaterials] = useState("");
  const [submittingQuote, setSubmittingQuote] = useState(false);
  const [remark, setRemark] = useState("");
  const [savingRemark, setSavingRemark] = useState(false);
  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);
  // Mig 106 — supplier-owned service record. Draft lives in local
  // state until they press Save; last saved value is echoed back from
  // the API on reload.
  const [serviceNoteDraft, setServiceNoteDraft] = useState("");
  const [savingServiceNote, setSavingServiceNote] = useState(false);

  async function load() {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const d = await portalApi.get<SupplierCase>("/api/supplier-portal/case", token);
      setData(d);
    } catch (e: any) {
      setErr(e?.message || "Couldn't load case");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [token]);

  // Keep the service-note textarea in sync with what the API returned.
  // Only overwrite the draft when the incoming value differs from what
  // we last had — protects the supplier from losing an unsaved edit if
  // another tab reload lands mid-typing.
  useEffect(() => {
    const incoming = data?.case?.supplier_service_note ?? "";
    setServiceNoteDraft((prev) => (prev === "" ? incoming : prev));
  }, [data?.case?.supplier_service_note]);

  async function acceptJob() {
    setAccepting(true);
    try {
      await portalApi.post("/api/supplier-portal/accept", token);
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to accept job");
    } finally {
      setAccepting(false);
    }
  }

  async function submitQuote() {
    const labour = parseFloat(quoteLabour || "0");
    const materials = parseFloat(quoteMaterials || "0");
    if (!Number.isFinite(labour) || labour < 0 || !Number.isFinite(materials) || materials < 0) {
      setErr("Quote amounts must be numbers ≥ 0");
      return;
    }
    setSubmittingQuote(true);
    setErr(null);
    try {
      await portalApi.post("/api/supplier-portal/quote", token, { labour, materials });
      setQuoteLabour("");
      setQuoteMaterials("");
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to submit quote");
    } finally {
      setSubmittingQuote(false);
    }
  }

  async function postRemark() {
    const note = remark.trim();
    if (!note) return;
    setSavingRemark(true);
    try {
      await portalApi.post("/api/supplier-portal/remarks", token, { note });
      setRemark("");
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to post remark");
    } finally {
      setSavingRemark(false);
    }
  }

  async function saveServiceNote() {
    setSavingServiceNote(true);
    try {
      await portalApi.put("/api/supplier-portal/service-note", token, {
        note: serviceNoteDraft,
      });
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to save service note");
    } finally {
      setSavingServiceNote(false);
    }
  }

  // Two upload slots render side by side, so pasted files are routed by
  // the hovered dropzone (no document-wide paste here); this guard only
  // keeps a missed drop from navigating the SPA to the file.
  useStrayFileDropGuard();

  // Upload a photo into one of the two PictureBlock slots. Category
  // maps to the existing assr_attachments CHECK constraint:
  //   evidence   → "Service Issue" slot
  //   completion → "Operation QC Checked" slot
  async function uploadPhoto(raw: File, category: "evidence" | "completion") {
    if (!ALLOWED_EXT.includes((raw.name.split(".").pop() || "").toLowerCase())) {
      setErr(`Unsupported file type: .${(raw.name.split(".").pop() || "").toLowerCase()}`);
      return;
    }
    setUploadingSlot(category);
    setErr(null);
    try {
      // WO-7 — suppliers shoot these on phones; compress before the 10 MB
      // gate. The prepared name carries the re-encoded ext (webp allowed).
      const { file: f } = await prepareImageForUpload(raw, { wantThumb: false });
      if (f.size > MAX_SIZE) {
        setErr("File exceeds 10 MB");
        setUploadingSlot(null);
        return;
      }
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      const buf = await f.arrayBuffer();
      await portalApi.putBinary(
        `/api/supplier-portal/attachments?ext=${ext}&category=${category}&name=${encodeURIComponent(f.name)}`,
        token,
        buf,
        f.type || "image/jpeg"
      );
      await load();
    } catch (e: any) {
      setErr(e?.message || "Upload failed");
    } finally {
      setUploadingSlot(null);
    }
  }

  // Multi-file entry for drop / paste (the picker forwards a single file
  // through here too) — sequential so uploadingSlot stays honest.
  async function uploadPhotos(raws: File[], category: "evidence" | "completion") {
    for (const raw of raws) await uploadPhoto(raw, category);
  }

  async function archivePhoto(attId: number) {
    if (!(await dialog.confirm({ message: "Remove this photo?", danger: true }))) return;
    try {
      await portalApi.post(`/api/supplier-portal/attachments/${attId}/archive`, token);
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to remove");
    }
  }

  if (loading) {
    return (
      <PortalFrame>
        <SupplierCaseSkeleton />
      </PortalFrame>
    );
  }
  if (err && !data) {
    return (
      <PortalFrame>
        <div className="mx-auto max-w-4xl px-4 py-8 text-center">
          <div className="mb-2 text-[15px] font-semibold text-err">Unavailable</div>
          <div className="mb-4 text-[13px] text-ink-secondary">{err}</div>
          <Button variant="secondary" onClick={() => load()}>
            Reload
          </Button>
        </div>
      </PortalFrame>
    );
  }
  if (!data) return null;

  const cs = data.case;
  const stageLabel = STAGE_LABEL[cs.stage] || cs.stage;

  const stageColor = STAGE_COLOR[cs.stage] ?? "grey";
  const currentStep = supplierStepFor(cs);
  // "Your due date" = current stage's entry + its SLA target. Soft
  // guidance only — the supplier can't see any other SLA machinery.
  const dueDate = (() => {
    if (!cs.stage_entered_at || cs.stage_target_days == null) return null;
    const d = new Date(cs.stage_entered_at.endsWith("Z") ? cs.stage_entered_at : cs.stage_entered_at + "Z");
    if (isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + cs.stage_target_days);
    return d.toISOString();
  })();
  const quoteTotal = (cs.supplier_quote_labour ?? 0) + (cs.supplier_quote_materials ?? 0);

  return (
    <PortalFrame>
      {/* Header — assr_no + stage pill + supplier name on the left;
          due date + Accept job on the right (per design). */}
      <div className="rounded-lg border border-border bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-lg font-bold">{cs.assr_no}</span>
              <StatusPill color={stageColor} label={stageLabel} />
            </div>
            {(data.supplier_name || cs.creditor_code) && (
              <div className="mt-1 text-[13px] font-semibold text-ink">
                {data.supplier_name || cs.creditor_code}
              </div>
            )}
            <div className="mt-1 text-[12px] text-ink-muted">
              Reported {fmtDate(cs.complained_date)}
              {cs.po_no && <> · PO <span className="font-mono text-ink">{cs.po_no}</span></>}
              {cs.supplier_pickup_at && cs.supplier_pickup_at !== "—" && <> · Picked up {fmtDate(cs.supplier_pickup_at)}</>}
              {cs.items_ready_at && cs.items_ready_at !== "—" && <> · Ready {fmtDate(cs.items_ready_at)}</>}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
              Your due date
            </div>
            <div className="mt-1 font-serif text-[20px] font-semibold leading-none text-ink">
              {dueDate ? fmtDate(dueDate) : "—"}
            </div>
            {cs.supplier_accepted_at ? (
              <span className="mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-synced/15 px-3.5 text-[12px] font-bold text-synced">
                ✓ Job accepted
              </span>
            ) : cs.stage !== "completed" ? (
              <Button
                variant="primary"
                onClick={acceptJob}
                disabled={accepting}
                className="mt-2.5 h-9 px-4 text-[12.5px]"
              >
                {accepting ? "Accepting…" : "✓ Accept job"}
              </Button>
            ) : null}
          </div>
        </div>
        {(cs.ref_no || cs.service_category) && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2.5 text-[11px] text-ink-muted">
            {cs.ref_no && <span>Ref: <span className="font-mono text-ink">{cs.ref_no}</span></span>}
            {cs.service_category && <span>Category: <span className="text-ink">{cs.service_category}</span></span>}
          </div>
        )}
      </div>

      {/* Job progress — READ-ONLY, set by Houzs. Replaces the old
          "Update job status" buttons (design: supplier can't advance
          the workflow; their levers are quote / note / photos). */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[13px] font-bold text-ink">Job progress</h2>
          <span className="font-mono text-[10px] text-ink-muted">read-only · set by Houzs</span>
        </div>
        <div className="flex items-start">
          {SUPPLIER_STEPS.map((label, i) => {
            const n = i + 1;
            const done = n < currentStep;
            const active = n === currentStep;
            const isLast = i === SUPPLIER_STEPS.length - 1;
            return (
              <div key={label} className={`flex items-start ${isLast ? "" : "flex-1"}`}>
                <div className="flex w-[72px] shrink-0 flex-col items-center sm:w-[88px]">
                  <span
                    className={
                      "inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold " +
                      (done
                        ? "bg-primary text-white"
                        : active
                        ? "bg-[#c79a5a] text-white ring-4 ring-[#c79a5a]/20"
                        : "border border-border-subtle bg-surface text-ink-muted")
                    }
                  >
                    {done ? "✓" : n}
                  </span>
                  <span
                    className={
                      "mt-2 text-center font-mono text-[8.5px] font-semibold uppercase leading-tight tracking-wide " +
                      (active ? "text-ink" : done ? "text-ink-secondary" : "text-ink-muted")
                    }
                  >
                    {label}
                  </span>
                </div>
                {!isLast && (
                  <span
                    className={"mt-3.5 h-0.5 flex-1 rounded " + (done ? "bg-primary/60" : "bg-border-subtle")}
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Items under service */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Items under service
        </h2>
        {data.items.length === 0 ? (
          <div className="text-[12px] text-ink-muted">No items recorded.</div>
        ) : (
          <ul className="space-y-2">
            {data.items.map((it) => (
              <li key={it.id} className="flex items-center gap-3 text-[13px]">
                <Package size={14} className="text-ink-muted" />
                <span className="font-mono text-[11px]">{it.item_code}</span>
                <span className="flex-1 truncate text-ink-secondary">{it.item_description || ""}</span>
                {it.qty != null && <span className="text-[11px] text-ink-muted">× {it.qty}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Reported issue */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Reported issue
        </h2>
        <div className="whitespace-pre-line text-sm">{cs.complaint_issue || "—"}</div>
        {(cs.issue_category || cs.service_category) && (
          <div className="mt-2 text-[11px] text-ink-muted">
            Category: {cs.issue_category || cs.service_category}
          </div>
        )}
      </section>

      {/* Submit your quote — labour + materials (RM). Houzs reviews
          before the customer sees any price. Warranty cases may be 0. */}
      {cs.stage !== "completed" && (
        <section className="mt-5 rounded-lg border border-border bg-surface p-5">
          <h2 className="text-[13.5px] font-bold text-ink">Submit your quote</h2>
          <p className="mb-4 mt-0.5 text-[12px] text-ink-muted">
            Labour + materials. Houzs reviews before the customer sees a final price.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                Labour (RM)
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={quoteLabour}
                onChange={(e) => setQuoteLabour(e.target.value)}
                placeholder={cs.supplier_quote_labour != null ? cs.supplier_quote_labour.toFixed(2) : "0.00"}
                className="w-full rounded-md border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                Materials (RM)
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={quoteMaterials}
                onChange={(e) => setQuoteMaterials(e.target.value)}
                placeholder={cs.supplier_quote_materials != null ? cs.supplier_quote_materials.toFixed(2) : "0.00"}
                className="w-full rounded-md border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              onClick={submitQuote}
              disabled={submittingQuote || (quoteLabour === "" && quoteMaterials === "")}
              className="h-10 px-4 text-[13px]"
            >
              {submittingQuote ? "Submitting…" : "Submit quote"}
            </Button>
            <span className="text-[12px] text-ink-muted">Warranty case — quote may be RM 0</span>
          </div>
          {cs.supplier_quote_at && (
            <div className="mt-3 rounded-md bg-synced/10 px-3 py-2 text-[12px] font-semibold text-synced">
              Quote on file: labour RM {(cs.supplier_quote_labour ?? 0).toFixed(2)} + materials RM{" "}
              {(cs.supplier_quote_materials ?? 0).toFixed(2)} = RM {quoteTotal.toFixed(2)} · sent{" "}
              {fmtDate(cs.supplier_quote_at)} — resubmit to replace.
            </div>
          )}
        </section>
      )}

      {/* Goods Returned Note — read-only, from Houzs */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Goods Returned Note <span className="ml-1 normal-case tracking-normal text-ink-muted/70">from Houzs</span>
        </h2>
        <div className="whitespace-pre-line text-sm">
          {cs.goods_returned_note?.trim() || (
            <span className="text-ink-muted">Houzs hasn't attached a send-out note for this job yet.</span>
          )}
        </div>
      </section>

      {/* Service Note — editable, supplier owns */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Service Note
        </h2>
        <textarea
          value={serviceNoteDraft}
          onChange={(e) => setServiceNoteDraft(e.target.value)}
          rows={4}
          placeholder="What was serviced, findings, parts changed — saved with the case."
          className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          maxLength={2000}
        />
        <div className="mt-2 flex items-center justify-between">
          <span aria-live="polite" className="text-[10px] text-ink-muted">
            {serviceNoteDraft.length}/2000
          </span>
          <Button
            variant="primary"
            onClick={saveServiceNote}
            disabled={
              savingServiceNote ||
              serviceNoteDraft.trim() === (cs.supplier_service_note ?? "").trim()
            }
            className="h-8 px-3 text-[11px]"
          >
            {savingServiceNote ? "Saving…" : "Save service note"}
          </Button>
        </div>
      </section>

      {/* Photos — Service Issue + Operation QC Checked */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Photos &amp; evidence
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PictureBlock
            title="Service issue"
            subtitle="How the item arrived"
            category="evidence"
            token={token}
            attachments={data.attachments.filter((a) => a.category === "evidence")}
            uploading={uploadingSlot === "evidence"}
            onUpload={(files) => void uploadPhotos(files, "evidence")}
            onArchive={archivePhoto}
          />
          <PictureBlock
            title="Operation QC checked"
            subtitle="Repair result / final QC"
            category="completion"
            token={token}
            attachments={data.attachments.filter((a) => a.category === "completion")}
            uploading={uploadingSlot === "completion"}
            onUpload={(files) => void uploadPhotos(files, "completion")}
            onArchive={archivePhoto}
          />
        </div>
        <div className="mt-3 text-[10px] text-ink-muted">
          JPG / PNG / WEBP · up to 10 MB each.
        </div>
      </section>

      {/* Remarks — one-off messages */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Add a remark
        </h2>
        <textarea
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
          rows={3}
          placeholder="One-off message sent to Houzs Operations on submit."
          className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          maxLength={2000}
        />
        <div className="mt-2 flex items-center justify-between">
          <span aria-live="polite" className="text-[10px] text-ink-muted">
            {remark.length}/2000
          </span>
          <Button
            variant="primary"
            onClick={postRemark}
            disabled={!remark.trim() || savingRemark}
            className="h-8 px-3 text-[11px]"
          >
            {savingRemark ? "Sending…" : "Send remark"}
          </Button>
        </div>
      </section>

      {/* Progress note — the stage is advanced by Houzs, not the
          supplier (replaces the old "Update job status" buttons). */}
      <section className="mt-5 flex items-center gap-3 rounded-lg border border-border bg-bg/60 p-4 print:hidden">
        <span className="shrink-0 text-[15px] text-ink-muted" aria-hidden>ⓘ</span>
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">
          The <b>stage is advanced by Houzs</b>, not the supplier. Your job here is to{" "}
          <b>upload photos</b> and <b>update the service note</b> — Houzs moves the case
          forward and verifies completion.
        </p>
      </section>

      {/* Footer actions */}
      <div className="mt-5 flex flex-col items-stretch justify-center gap-2 sm:flex-row sm:items-center sm:gap-3 print:hidden">
        <Button variant="secondary" onClick={print.openPreview} icon={<Printer size={14} />}>
          Print
        </Button>
        <Button variant="ghost" onClick={() => nav(-1)} icon={<ArrowLeft size={14} />}>
          Back
        </Button>
      </div>
      {/* The same Print preview the ERP's documents open. This page prints
          itself (no jspdf document behind it), so Print is the only exit. */}
      <PrintPreviewModal
        open={print.open}
        onClose={print.close}
        docTitle="Service Case"
        docNo={cs.assr_no}
        rows={[
          { label: "Supplier", value: data.supplier_name || cs.creditor_code || "—" },
          { label: "Stage", value: stageLabel },
          { label: "Photos", value: `${data.attachments.length} attached` },
        ]}
        onPrint={print.handlers.onPrint}
      />

      {err && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-sm text-err print:hidden">
          <span>{err}</span>
          <Button variant="ghost" onClick={() => load()} className="h-7 px-2 text-[11px]">
            Reload
          </Button>
        </div>
      )}
    </PortalFrame>
  );
}

// ── Building blocks ────────────────────────────────────────────────

function PictureBlock({
  title,
  subtitle,
  category,
  token,
  attachments,
  uploading,
  onUpload,
  onArchive,
}: {
  title: string;
  subtitle?: string;
  category: "evidence" | "completion";
  token: string;
  attachments: SupplierCase["attachments"];
  uploading: boolean;
  onUpload: (files: File[]) => void;
  onArchive: (attId: number) => void;
}) {
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) onUpload([f]);
  }

  return (
    <div>
      <UploadDropZone disabled={uploading} onFiles={onUpload}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink">
            {title}
          </div>
          {subtitle && (
            <div className="text-[10px] text-ink-muted">{subtitle}</div>
          )}
        </div>
        <label
          className={`inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink hover:border-accent/40 print:hidden ${
            uploading ? "pointer-events-none opacity-50" : ""
          }`}
          aria-label={`Attach photo for ${title}`}
        >
          <Upload size={11} /> {uploading ? "Uploading…" : "Attach"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="hidden"
            onChange={onFile}
            disabled={uploading}
          />
        </label>
      </div>
      {attachments.length === 0 ? (
        <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border/60 bg-bg/30 text-[11px] text-ink-muted">
          No photo yet
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {attachments.map((a) => (
            <SupplierPhoto
              key={a.id}
              token={token}
              attId={a.id}
              label={category === "evidence" ? "Service issue" : "QC checked"}
              onRemove={() => onArchive(a.id)}
            />
          ))}
        </div>
      )}
      </UploadDropZone>
    </div>
  );
}

function SupplierPhoto({
  token,
  attId,
  label,
  onRemove,
}: {
  token: string;
  attId: number;
  label: string;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let localUrl: string | null = null;
    portalApi
      .fetchBlobUrl(`/api/supplier-portal/attachments/${attId}`, token)
      .then((u) => {
        if (revoked) {
          URL.revokeObjectURL(u);
        } else {
          localUrl = u;
          setUrl(u);
        }
      })
      .catch(() => {});
    return () => {
      revoked = true;
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [attId, token]);

  return (
    <div className="group relative">
      <div className="block w-full overflow-hidden rounded-md border border-border bg-bg">
        {url ? (
          <img src={url} alt={label} className="h-20 w-full object-cover sm:h-24" />
        ) : (
          <div className="h-20 w-full animate-pulse bg-ink-muted/10 sm:h-24" />
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 rounded-full bg-ink/75 p-1 text-white opacity-0 transition-opacity hover:bg-err focus:opacity-100 group-hover:opacity-100 print:hidden"
        title="Remove this photo"
        aria-label="Remove this photo"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

function SupplierCaseSkeleton() {
  // Placeholder shapes match the card sections of the real page so the
  // load-in doesn't jump.
  return (
    <>
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="mt-5 h-32 w-full rounded-lg" />
      <Skeleton className="mt-5 h-28 w-full rounded-lg" />
      <Skeleton className="mt-5 h-40 w-full rounded-lg" />
      <Skeleton className="mt-5 h-40 w-full rounded-lg" />
    </>
  );
}

