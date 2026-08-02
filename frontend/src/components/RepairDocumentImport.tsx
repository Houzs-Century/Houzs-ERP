// ----------------------------------------------------------------------------
// RepairDocumentImport — upload a workshop quotation / invoice, check what the
// reader made of it, then commit it as a work order.
//
// Owner, 2026-08-02: "这个模块需要具备 OCR 功能。用户把单据上传进去后，系统要能自动
// 识别并提取出上述所有需要的字段和资料".
//
// THE REVIEW IS THE PRODUCT, NOT THE UPLOAD. POST /scan-lorry-invoice/extract
// deliberately writes nothing (see its route header), so everything on this
// screen is editable and nothing exists until Confirm. Three checks are run
// FOR the operator rather than left for them to notice:
//
//   1. RECONCILIATION — the extracted lines summed against the grand total the
//      reader took from a different part of the page. A miss means a line was
//      dropped or misread, and it is the only signal that catches it: an
//      extraction short by one line looks completely normal.
//   2. PLATE — the document names a vehicle and this drawer is already scoped
//      to one. A mismatch is the wrong paper on the wrong lorry, which is a
//      cost booked against a vehicle that never had the repair.
//   3. CONFIDENCE + the reader's own warnings, surfaced verbatim.
//
// "NOT CHECKED" IS NOT "CHECKED AND FINE". When the document prints no grand
// total there is nothing to reconcile against; that renders as its own neutral
// state, never as a tick. Showing a green tick for an unperformed check is the
// failure mode this whole panel exists to prevent.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from "react";
import { Upload, X, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Button } from "./Button";
import { api } from "../api/client";
import { cn } from "../lib/utils";

const FIELD = "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-ink focus:border-primary focus:outline-none";
const LABEL = "mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

type Section = "PART" | "LABOUR";

type ExtractedLine = {
  section: Section;
  lineNo: number | null;
  name: string;
  partNo: string | null;
  uom: string | null;
  qty: number | null;
  unitPriceCenti: number | null;
  discountPct: number | null;
  amountCenti: number | null;
  lineCenti: number;
};

type ExtractResponse = {
  document: {
    docKind: "QUOTATION" | "INVOICE" | null;
    docNo: string | null;
    docDate: string | null;
    workshopName: string | null;
    workshopRegistrationNo: string | null;
    workshopAddress: string | null;
    workshopEmail: string | null;
    workshopPhone: string | null;
    advisor: string | null;
    plate: string | null;
    confidence: number | null;
    warnings: string[];
  };
  totals: { linesCenti: number; printedTotalCenti: number | null; reconciles: boolean | null; deltaCenti: number | null };
  lines: ExtractedLine[];
};

type Workshop = { id: string; code: string; name: string; registrationNo: string | null };

const money = (centi: number | null | undefined): string =>
  centi == null ? "—" : `RM${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const errText = (e: unknown): string => (e instanceof Error ? e.message : "Something went wrong.");

/** Editable row state — every extracted value is a starting point, not a fact. */
export type RowState = ExtractedLine & { drop: boolean };

/** Editing qty / unit price / discount CLEARS the printed amount.
 *
 *  The printed figure wins by default because the vendor's rounding is theirs
 *  (see workOrderLineCenti, services/fleet-status.ts). But the moment the
 *  operator corrects one of ITS INPUTS they are overriding the document, and
 *  keeping the old printed total would freeze the line at a number they just
 *  disagreed with — correct a misread RM5,600 to RM6,500 and nothing moves.
 *
 *  Dropping / renaming / re-sectioning a line does NOT override it: none of
 *  those change what the line costs. */
const OVERRIDES_PRINTED: ReadonlyArray<keyof RowState> = ["qty", "unitPriceCenti", "discountPct"];

export function applyRowEdit(row: RowState, patch: Partial<RowState>): RowState {
  const overrides = OVERRIDES_PRINTED.some((k) => k in patch);
  const next: RowState = { ...row, ...patch, ...(overrides ? { amountCenti: null } : {}) };
  next.lineCenti = next.amountCenti != null
    ? Math.max(0, Math.round(next.amountCenti))
    : Math.max(0, Math.round((next.qty ?? 0) * (next.unitPriceCenti ?? 0) * (1 - (next.discountPct ?? 0) / 100)));
  return next;
}

export function RepairDocumentImport({ vehicleId, plate, onDone, onCancel }: {
  vehicleId: string;
  /** The lorry this drawer is open on, for the plate cross-check. */
  plate: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  /* Not every workshop sends a document you can scan. Owner, 2026-08-03: "如果我
     要 manually 填写的话呢? 有些它是没有 OCR 的". Manual entry is the SAME editor
     with an empty starting state, not a second form — two forms over one shape
     drift, and everything mig 0241 added (workshop link, document number,
     advisor, per-line UOM / discount / PART-vs-LABOUR) only ever existed here. */
  const [manual, setManual] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<ExtractResponse | null>(null);

  // Header, editable after extraction.
  const [docNo, setDocNo] = useState("");
  const [docKind, setDocKind] = useState<"QUOTATION" | "INVOICE">("QUOTATION");
  const [docDate, setDocDate] = useState("");
  const [advisor, setAdvisor] = useState("");
  const [problem, setProblem] = useState("");
  const [workshopId, setWorkshopId] = useState("");
  const [rows, setRows] = useState<RowState[]>([]);
  const [saving, setSaving] = useState(false);

  const [workshopList, setWorkshopList] = useState<Workshop[]>([]);
  const [creatingWorkshop, setCreatingWorkshop] = useState(false);
  const [newWorkshopName, setNewWorkshopName] = useState("");

  const loadWorkshops = async () => {
    try {
      const r = await api.get<{ workshops: Workshop[] }>("/api/fleet-maintenance/workshops");
      setWorkshopList(r.workshops ?? []);
      return r.workshops ?? [];
    } catch { return []; }
  };

  const pick = () => fileRef.current?.click();

  const blankRow = (section: "PART" | "LABOUR"): RowState => ({
    section, lineNo: null, name: "", partNo: null, uom: null,
    qty: 1, unitPriceCenti: null, discountPct: null, amountCenti: null,
    lineCenti: 0, drop: false,
  });

  const startManual = () => {
    setManual(true);
    setRows([blankRow("PART")]);
    setProblem("Workshop repair");
    void loadWorkshops();
  };

  /* Also reachable from an OCR review: the reconciliation banner tells you a
     line was missed, and before this there was no way to put it back. */
  const addRow = (section: "PART" | "LABOUR") => setRows((prev) => [...prev, blankRow(section)]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  const onFile = async (file: File | null) => {
    if (!file || reading) return;
    setReading(true); setErr(null); setRes(null);
    try {
      /* api.uploadFile allows 120s — the reader's own ceiling is 110s, so a
         slow document surfaces the reader's message, not a client timeout. */
      const r = await api.uploadFile<ExtractResponse>("/api/scm/scan-lorry-invoice/extract", file);
      setRes(r);
      setDocNo(r.document.docNo ?? "");
      setDocKind(r.document.docKind ?? "QUOTATION");
      setDocDate(r.document.docDate ?? "");
      setAdvisor(r.document.advisor ?? "");
      setProblem(r.document.docNo ? `Workshop ${r.document.docKind === "INVOICE" ? "invoice" : "quotation"} ${r.document.docNo}` : "Workshop repair");
      setRows(r.lines.map((l) => ({ ...l, drop: false })));

      /* Pre-select the workshop only on an UNAMBIGUOUS match — SSM first,
         then an exact name. A fuzzy guess here silently attributes a repair
         to the wrong vendor, and the operator would have no reason to look. */
      const list = await loadWorkshops();
      const ssm = r.document.workshopRegistrationNo?.trim();
      const nm = r.document.workshopName?.trim().toUpperCase();
      const hit = (ssm && list.find((w) => w.registrationNo?.trim() === ssm))
        || (nm && list.find((w) => w.name.trim().toUpperCase() === nm))
        || null;
      setWorkshopId(hit ? hit.id : "");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const kept = rows.filter((r) => !r.drop);
  const keptTotal = kept.reduce((s, r) => s + r.lineCenti, 0);
  const printed = res?.totals.printedTotalCenti ?? null;

  /* Recomputed from the CURRENT rows, not the response — the operator may have
     dropped or edited a line, and a banner that still describes the original
     extraction would be worse than none. */
  const liveReconcile: boolean | null = printed == null ? null : Math.abs(keptTotal - printed) <= Math.max(1, kept.length);

  const plateMismatch = useMemo(() => {
    const a = (res?.document.plate ?? "").replace(/\s+/g, "").toUpperCase();
    const b = (plate ?? "").replace(/\s+/g, "").toUpperCase();
    return a && b && a !== b ? { doc: a, lorry: b } : null;
  }, [res, plate]);

  const setRow = (i: number, patch: Partial<RowState>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? applyRowEdit(r, patch) : r)));

  const createWorkshop = async () => {
    if (!res?.document.workshopName || creatingWorkshop) return;
    setCreatingWorkshop(true); setErr(null);
    try {
      const d = res.document;
      const made = await api.post<{ id: string; code: string }>("/api/fleet-maintenance/workshops", {
        name: d.workshopName,
        registrationNo: d.workshopRegistrationNo ?? undefined,
        officePhone: d.workshopPhone ?? undefined,
        email: d.workshopEmail ?? undefined,
        address: d.workshopAddress ?? undefined,
      });
      await loadWorkshops();
      setWorkshopId(made.id);
    } catch (e) { setErr(errText(e)); } finally { setCreatingWorkshop(false); }
  };

  const createNamedWorkshop = async () => {
    const name = newWorkshopName.trim();
    if (!name || creatingWorkshop) return;
    setCreatingWorkshop(true); setErr(null);
    try {
      const made = await api.post<{ id: string; code: string }>("/api/fleet-maintenance/workshops", { name });
      await loadWorkshops();
      setWorkshopId(made.id);
      setNewWorkshopName("");
    } catch (e) { setErr(errText(e)); } finally { setCreatingWorkshop(false); }
  };

  const confirm = async () => {
    if (saving || kept.length === 0) return;
    setSaving(true); setErr(null);
    try {
      const wo = await api.post<{ id: string }>(`/api/fleet-maintenance/vehicles/${vehicleId}/work-orders`, {
        problem: problem.trim() || "Workshop repair",
        workshopId: workshopId || undefined,
        workshop: workshopId ? undefined : res?.document.workshopName ?? undefined,
        [docKind === "INVOICE" ? "invoiceNo" : "quotationNo"]: docNo.trim() || undefined,
        advisor: advisor.trim() || undefined,
        documentDate: docDate || undefined,
        /* labour rides the LINES, so the header scalar must stay 0 or the
           total counts it twice (the route 409s if it is not). */
        labourCenti: 0,
      });
      /* Sequential on purpose: the LABOUR guard reads the header, and the
         error that matters ("line 7 was rejected") is unreadable if six
         requests fail at once. */
      for (const r of kept) {
        await api.post(`/api/fleet-maintenance/work-orders/${wo.id}/parts`, {
          section: r.section,
          lineNo: r.lineNo ?? undefined,
          name: r.name || "(no description)",
          partNo: r.partNo ?? undefined,
          uom: r.uom ?? undefined,
          qty: r.qty ?? 1,
          unitPriceCenti: r.unitPriceCenti ?? 0,
          discountPct: r.discountPct ?? 0,
          amountCenti: r.amountCenti ?? undefined,
        });
      }
      onDone();
    } catch (e) { setErr(errText(e)); } finally { setSaving(false); }
  };

  // ── Upload state ──────────────────────────────────────────────────────────
  if (!res && !manual) {
    return (
      <div className="rounded-lg border border-border bg-surface p-3">
        <input
          ref={fileRef} type="file" className="hidden"
          accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
          onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
        />
        <p className="text-[11.5px] text-ink-secondary">
          Upload the workshop&rsquo;s quotation or invoice. A PDF is read directly — no need to photograph it.
          Nothing is saved until you review what was read and confirm.
        </p>
        {err && <div className="mt-2 rounded-md border border-err/30 bg-err/10 px-2.5 py-1.5 text-[11px] text-err">{err}</div>}
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={pick} disabled={reading}>
            <Upload size={14} /> {reading ? "Reading the document…" : "Choose a document"}
          </Button>
          <Button variant="secondary" onClick={startManual} disabled={reading}>
            Enter it by hand
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={reading}>Cancel</Button>
        </div>
      </div>
    );
  }

  const d = res?.document ?? null;
  const lowConfidence = d?.confidence != null && d.confidence < 0.6;

  // ── Review state ──────────────────────────────────────────────────────────
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-ink">{res ? "Check what was read" : "Enter the workshop document"}</div>
          <div className="text-[11px] text-ink-muted">
            {res ? "Every field is editable. Nothing is saved until you confirm." : "Type it the way the workshop wrote it. Nothing is saved until you confirm."}
          </div>
        </div>
        <button type="button" onClick={onCancel} className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink" aria-label="Cancel">
          <X size={15} />
        </button>
      </div>

      {/* The three checks, most alarming first. */}
      {plateMismatch && (
        <Banner tone="crit" icon={<AlertTriangle size={14} />}>
          This document is for <strong>{plateMismatch.doc}</strong>, but you are on <strong>{plateMismatch.lorry}</strong>.
          Booking it here puts the cost on a lorry that did not have the repair.
        </Banner>
      )}

      {liveReconcile === false && (
        <Banner tone="crit" icon={<AlertTriangle size={14} />}>
          The lines add up to <strong>{money(keptTotal)}</strong> but the document prints <strong>{money(printed)}</strong>
          {" "}— a gap of <strong>{money(Math.abs(keptTotal - (printed ?? 0)))}</strong>. A line was probably missed or misread.
        </Banner>
      )}
      {liveReconcile === true && (
        <Banner tone="ok" icon={<CheckCircle2 size={14} />}>
          The lines match the {money(printed)} printed on the document.
        </Banner>
      )}
      {res && liveReconcile === null && (
        <Banner tone="info" icon={<Info size={14} />}>
          The document prints no grand total, so there is nothing to check the lines against. The {money(keptTotal)} below is
          the sum of what was read, not a figure anyone verified.
        </Banner>
      )}

      {lowConfidence && (
        <Banner tone="warn" icon={<AlertTriangle size={14} />}>
          The reader was unsure about this document ({Math.round((d.confidence ?? 0) * 100)}% confident). Read every line.
        </Banner>
      )}
      {d && d.warnings.length > 0 && (
        <Banner tone="warn" icon={<Info size={14} />}>
          <ul className="list-disc space-y-0.5 pl-4">{d.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Banner>
      )}

      {/* Workshop */}
      <div className="rounded-md border border-border bg-surface-2/30 p-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Workshop</div>
        {d && (
          <>
            <div className="mt-1 text-[12px] text-ink">{d.workshopName ?? "— not read —"}</div>
            <div className="text-[11px] text-ink-muted">
              {[d.workshopRegistrationNo && `SSM ${d.workshopRegistrationNo}`, d.workshopPhone, d.workshopEmail].filter(Boolean).join(" · ") || "no particulars read"}
            </div>
            {d.workshopAddress && <div className="text-[11px] text-ink-muted">{d.workshopAddress}</div>}
          </>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select className={cn(FIELD, "max-w-[280px]")} value={workshopId} onChange={(e) => setWorkshopId(e.target.value)}>
            <option value="">Not linked — keep the name as text</option>
            {workshopList.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
          </select>
          {!workshopId && d?.workshopName && (
            <Button variant="secondary" onClick={createWorkshop} disabled={creatingWorkshop}>
              {creatingWorkshop ? "Registering…" : "Register this workshop"}
            </Button>
          )}
        </div>
        {!res && !workshopId && (
          /* With no document there is nothing to read a workshop OUT of, so the
             only way to link one that is not on file yet is to name it here. */
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div>
              <label className={LABEL}>New workshop</label>
              <input className={cn(FIELD, "min-w-[200px]")} value={newWorkshopName} onChange={(e) => setNewWorkshopName(e.target.value)} placeholder="Workshop name" />
            </div>
            <Button variant="secondary" onClick={createNamedWorkshop} disabled={creatingWorkshop || !newWorkshopName.trim()}>
              {creatingWorkshop ? "Registering…" : "Register"}
            </Button>
          </div>
        )}
        {!workshopId && (
          <p className="mt-1.5 text-[10.5px] text-ink-muted">
            Unlinked repairs still save, but their cost cannot be totalled per workshop.
          </p>
        )}
      </div>

      {/* Header */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div>
          <label className={LABEL}>Document</label>
          <select className={FIELD} value={docKind} onChange={(e) => setDocKind(e.target.value as "QUOTATION" | "INVOICE")}>
            <option value="QUOTATION">Quotation</option>
            <option value="INVOICE">Invoice</option>
          </select>
        </div>
        <div>
          <label className={LABEL}>Number</label>
          <input className={FIELD} value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="e.g. WJO00403" />
        </div>
        <div>
          <label className={LABEL}>Document date</label>
          <input type="date" className={FIELD} value={docDate} onChange={(e) => setDocDate(e.target.value)} />
        </div>
        <div>
          <label className={LABEL}>Advisor</label>
          <input className={FIELD} value={advisor} onChange={(e) => setAdvisor(e.target.value)} placeholder="theirs, not ours" />
        </div>
      </div>
      <div>
        <label className={LABEL}>What was done</label>
        <input className={FIELD} value={problem} onChange={(e) => setProblem(e.target.value)} />
      </div>

      {/* Lines */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[860px] text-[11.5px]">
          <thead>
            <tr className="bg-surface-2/50 text-left text-[10px] uppercase tracking-brand text-ink-muted">
              <th className="px-2 py-1.5 font-semibold">{res ? "Keep" : ""}</th>
              <th className="px-2 py-1.5 font-semibold">#</th>
              <th className="px-2 py-1.5 font-semibold">Description</th>
              <th className="px-2 py-1.5 font-semibold">UOM</th>
              <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
              <th className="px-2 py-1.5 text-right font-semibold">Unit (RM)</th>
              <th className="px-2 py-1.5 text-right font-semibold">Disc %</th>
              <th className="px-2 py-1.5 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          {(["PART", "LABOUR"] as const).map((section) => {
            const idx = rows.map((r, i) => [r, i] as const).filter(([r]) => r.section === section);
            if (idx.length === 0) return null;
            return (
              <tbody key={section}>
                <tr>
                  <td colSpan={8} className="bg-surface-2/30 px-2 py-1 text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                    {section === "PART" ? "Part charges" : "Labour charges"}
                  </td>
                </tr>
                {idx.map(([r, i]) => (
                  <tr key={i} className={cn("border-t border-border", r.drop && "opacity-40")}>
                    <td className="px-2 py-1">
                      {/* Typed by hand, so there is no extraction to compare
                          against — a wrong line is deleted, not struck out. */}
                      {res ? (
                        <input type="checkbox" checked={!r.drop} onChange={(e) => setRow(i, { drop: !e.target.checked })} />
                      ) : (
                        <button type="button" onClick={() => removeRow(i)} className="rounded p-0.5 text-ink-muted hover:bg-surface-2 hover:text-err" aria-label="Remove line">
                          <X size={13} />
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-1 text-ink-muted">{r.lineNo ?? "—"}</td>
                    <td className="px-2 py-1">
                      <input className={cn(FIELD, "min-w-[220px]")} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} />
                    </td>
                    <td className="px-2 py-1">
                      <input className={cn(FIELD, "w-[70px]")} value={r.uom ?? ""} onChange={(e) => setRow(i, { uom: e.target.value.toUpperCase() || null })} />
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" step="0.01" className={cn(FIELD, "w-[76px] text-right")} value={r.qty ?? ""} onChange={(e) => setRow(i, { qty: e.target.value === "" ? null : Number(e.target.value) })} />
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" step="0.01" className={cn(FIELD, "w-[96px] text-right")}
                        value={r.unitPriceCenti == null ? "" : r.unitPriceCenti / 100}
                        onChange={(e) => setRow(i, { unitPriceCenti: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100) })} />
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" step="0.01" min="0" max="100" className={cn(FIELD, "w-[72px] text-right")}
                        value={r.discountPct ?? ""}
                        onChange={(e) => setRow(i, { discountPct: e.target.value === "" ? null : Number(e.target.value) })} />
                    </td>
                    <td className="px-2 py-1 text-right font-medium tabular-nums text-ink">{money(r.lineCenti)}</td>
                  </tr>
                ))}
              </tbody>
            );
          })}
          <tfoot>
            <tr className="border-t-2 border-border bg-surface-2/40">
              <td colSpan={7} className="px-2 py-1.5 text-right text-[11px] font-semibold uppercase tracking-brand text-ink-secondary">
                {kept.length} of {rows.length} lines
              </td>
              <td className="px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-ink">{money(keptTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* A missed line used to be unrecoverable: the reconciliation banner told
          you one was short and then offered no way to put it back. */}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => addRow("PART")}>Add a part line</Button>
        <Button variant="secondary" onClick={() => addRow("LABOUR")}>Add a labour line</Button>
      </div>

      {err && <div className="rounded-md border border-err/30 bg-err/10 px-2.5 py-1.5 text-[11px] text-err">{err}</div>}

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={confirm} disabled={saving || kept.length === 0}>
          {saving ? "Saving…" : `Create work order (${money(keptTotal)})`}
        </Button>
        <Button variant="secondary" onClick={() => { setRes(null); setManual(false); setRows([]); setErr(null); }} disabled={saving}>
          {res ? "Read a different document" : "Start over"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

function Banner({ tone, icon, children }: { tone: "crit" | "warn" | "ok" | "info"; icon: React.ReactNode; children: React.ReactNode }) {
  const cls = tone === "crit" ? "border-err/30 bg-err/10 text-err"
    : tone === "warn" ? "border-warning-text/30 bg-warning-text/10 text-warning-text"
    : tone === "ok" ? "border-ok/30 bg-ok/10 text-ok"
    : "border-border bg-surface-2/50 text-ink-secondary";
  return (
    <div className={cn("flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11.5px]", cls)}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div>{children}</div>
    </div>
  );
}

export default RepairDocumentImport;
