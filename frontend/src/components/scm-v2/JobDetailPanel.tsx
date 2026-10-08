import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { uploadSlipFull, ALLOWED_SLIP_MIMES } from "../../vendor/scm/lib/slip";
import {
  jobKey, jobRefOf, LEG_LABEL, detailRows, str, hm, type JobRef, type JobResponse,
} from "../../vendor/scm/lib/delivery-job";
import { PodPhotoAlbum } from "./PodPhotoAlbum";
import { DoProofOfDeliveryCard, type DoPodFields } from "../../pages/scm-v2/DoProofOfDeliveryCard";

/* The right-hand panel a single click opens on Delivery Planning, DP Orders,
   Date / Time Arrangement and Last Mile (owner, 2026-10-08): what the job is,
   who runs it, the On the way / Arrived / Completed timeline with who tapped,
   every POD photo, and a way to the job's own document. The office can also
   upload the POD for a crew that could not (complete on behalf, or add photos).
   A double-click on the row still goes straight to the document. */

export type JobPanelTarget =
  | { kind: "job"; ref: JobRef; title: string | null }
  | { kind: "so"; soDocNo: string; doId: string | null; title: string | null };

/** What a board row opens: its job, or its sales order + latest DO. */
export function panelTargetOf(o: {
  row_type?: string | null; so_doc_no: string; dp_job_type?: string | null; assr_id?: number | null;
  job_kind?: string | null; debtor_name?: string | null; delivery_orders?: Array<{ id: string }> | null;
}): JobPanelTarget {
  const ref = jobRefOf(o);
  if (ref) return { kind: "job", ref, title: o.debtor_name ?? null };
  const dos = o.delivery_orders ?? [];
  return { kind: "so", soDocNo: o.so_doc_no, doId: dos.length ? dos[dos.length - 1]!.id : null, title: o.debtor_name ?? null };
}

/** Where a board row's double-click goes: its document, or null (open the panel). */
export function rowDocumentPath(o: Parameters<typeof panelTargetOf>[0]): string | null {
  const ref = jobRefOf(o);
  return ref ? jobDocumentPath(ref, null) : `/scm/sales-orders/${o.so_doc_no}`;
}

const jobApiPath = (r: JobRef) =>
  `/delivery-jobs/${r.sourceType}/${encodeURIComponent(r.sourceId)}/${encodeURIComponent(r.leg)}`;

/** The document a job belongs to, for "Open document" and the row double-click. */
export function jobDocumentPath(r: JobRef, ctx?: Record<string, unknown> | null): string | null {
  if (r.sourceType === "project") return `/projects/${r.sourceId}`;
  if (r.sourceType === "assr") return `/assr/${r.sourceId}`;
  if (r.leg === "TRANSFER" && ctx?.stock_transfer_id) return `/scm/stock-transfers/${String(ctx.stock_transfer_id)}`;
  if (r.leg === "LORRY_SERVICE" && ctx?.lorry_id) return `/fleet-health/${String(ctx.lorry_id)}`;
  return null;
}

export function JobDetailPanel({ target, onClose }: { target: JobPanelTarget | null; onClose: () => void }) {
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);
  if (!target) return null;
  return (
    <div className="fixed inset-0 z-[900] flex justify-end bg-black/20" onClick={onClose}>
      <aside role="dialog" aria-label="Job detail" onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-[440px] flex-col overflow-y-auto border-l border-border bg-surface p-5 shadow-stone">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              {target.kind === "job" ? LEG_LABEL[target.ref.leg] ?? target.ref.leg : "Delivery order"}
            </div>
            <div className="truncate text-[17px] font-semibold text-ink">{target.title ?? "—"}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded border border-border px-2 py-1 text-[12.5px] text-ink-muted">Close</button>
        </div>
        {target.kind === "job" ? <JobBody key={jobKey(target.ref)} jobRef={target.ref} /> : <SoBody soDocNo={target.soDocNo} doId={target.doId} />}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-lg border border-border p-4">
      <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border-subtle py-1.5 last:border-b-0">
      <span className="text-[12.5px] text-ink-muted">{k}</span>
      <span className={`text-right text-[13px] ${v ? "font-semibold text-ink" : "text-ink-muted"}`}>{v ?? "—"}</span>
    </div>
  );
}

function JobBody({ jobRef }: { jobRef: JobRef }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const base = jobApiPath(jobRef);
  const q = useQuery({ queryKey: ["delivery-job", jobKey(jobRef)], queryFn: () => authedFetch<JobResponse>(base), staleTime: 15_000 });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (q.isPending) return <div className="text-[12.5px] text-ink-muted">Loading…</div>;
  if (q.error) return <div className="text-[12.5px] text-red-600">{(q.error as Error).message}</div>;
  const { context: ctx, progress: p, people = {} } = q.data;
  const who = (id: unknown) => (id == null ? null : people[String(id)] ?? `User ${String(id)}`);
  const when = (at: string | null | undefined, by: unknown) => (at ? `${hm(at)}${who(by) ? ` · ${who(by)}` : ""}` : null);
  const photos = p?.pod_photo_keys ?? [];
  const docPath = jobDocumentPath(jobRef, ctx);
  const done = !!p?.completed_at;

  const upload = async () => {
    if (!files.length) { setError("Choose at least one photo."); return; }
    setBusy(true); setError(null);
    try {
      const keys: string[] = [];
      for (const f of files) keys.push((await uploadSlipFull({ file: f })).r2Key);
      await authedFetch(`${base}/${done ? "add-photos" : "complete"}`, {
        method: "POST",
        body: JSON.stringify(done ? { photoKeys: keys } : { photoKeys: keys, notes: "Completed by the office" }),
      });
      setFiles([]);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["delivery-job", jobKey(jobRef)] }),
        qc.invalidateQueries({ queryKey: ["delivery-job-progress"] }),
      ]);
    } catch (e) {
      setError((e as Error).message || "Upload failed. Nothing was saved; try again.");
    } finally { setBusy(false); }
  };

  return (
    <>
      {docPath && (
        <button type="button" onClick={() => navigate(docPath)}
          className="mb-4 w-full rounded-md border border-border py-2 text-[13px] font-semibold text-accent">
          Open {jobRef.sourceType === "project" ? "project" : jobRef.sourceType === "assr" ? "service case" : jobRef.leg === "TRANSFER" ? "stock transfer" : "lorry record"} →
        </button>
      )}
      <Section title="Job">
        {detailRows(ctx).map(([k, v]) => <Row key={k} k={k} v={v} />)}
        {Array.isArray(ctx.lines) && ctx.lines.length > 0 && (
          <div className="mt-2 text-[12.5px] text-ink-muted">{ctx.lines.length} item line{ctx.lines.length === 1 ? "" : "s"} on the transfer</div>
        )}
      </Section>
      <Section title="Timeline">
        <Row k="On the way" v={when(p?.departed_at, p?.departed_by)} />
        <Row k="Arrived" v={when(p?.arrived_at, p?.arrived_by)} />
        <Row k="Completed" v={when(p?.completed_at, p?.completed_by)} />
        {str(p?.pod_notes) && <div className="mt-2 text-[12.5px] text-ink">Note: {str(p?.pod_notes)}</div>}
        {p?.pod_lat != null && p.pod_lng != null && (
          <a className="mt-2 block text-[12.5px] text-accent underline" target="_blank" rel="noreferrer"
            href={`https://www.google.com/maps?q=${p.pod_lat},${p.pod_lng}`}>Where the POD was taken</a>
        )}
      </Section>
      <Section title="Proof of delivery">
        <PodPhotoAlbum
          paths={photos.map((_, n) => `/api/scm${base}/photo/${n}`)}
          fileStem={`POD-${String(ctx.ref ?? jobRef.leg)}`}
          emptyText="No photo yet. The crew uploads it from the phone, or upload it here."
        />
        <div className="mt-3 border-t border-border-subtle pt-3">
          <div className="mb-1 text-[12.5px] text-ink-muted">{done ? "Add more photos" : "Upload the POD for the crew (completes the job)"}</div>
          <input type="file" multiple accept={ALLOWED_SLIP_MIMES.filter((m) => m.startsWith("image/")).join(",")}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))} className="text-[12.5px]" />
          <button type="button" disabled={busy || !files.length} onClick={upload}
            className="mt-2 w-full rounded-md bg-accent py-2 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy ? "Uploading…" : done ? `Add ${files.length || ""} photo${files.length === 1 ? "" : "s"}` : "Upload and complete"}
          </button>
          {error && <div className="mt-2 text-[12.5px] text-red-600">{error}</div>}
        </div>
      </Section>
    </>
  );
}

function SoBody({ soDocNo, doId }: { soDocNo: string; doId: string | null }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["mfg-delivery-order-detail", doId],
    queryFn: () => authedFetch<{ deliveryOrder: DoPodFields & { do_number?: string | null } }>(`/delivery-orders-mfg/${doId}`),
    enabled: !!doId, staleTime: 15_000,
  });
  return (
    <>
      <div className="mb-4 flex gap-2">
        <button type="button" onClick={() => navigate(`/scm/sales-orders/${soDocNo}`)}
          className="flex-1 rounded-md border border-border py-2 text-[13px] font-semibold text-accent">Open sales order →</button>
        {doId && (
          <button type="button" onClick={() => navigate(`/scm/delivery-orders/${doId}`)}
            className="flex-1 rounded-md border border-border py-2 text-[13px] font-semibold text-accent">Open delivery order →</button>
        )}
      </div>
      {!doId && <div className="text-[12.5px] text-ink-muted">No delivery order yet — the POD is recorded on the DO once it is cut.</div>}
      {doId && q.isPending && <div className="text-[12.5px] text-ink-muted">Loading…</div>}
      {doId && q.error && <div className="text-[12.5px] text-red-600">{(q.error as Error).message}</div>}
      {q.data && <DoProofOfDeliveryCard h={q.data.deliveryOrder} />}
    </>
  );
}
