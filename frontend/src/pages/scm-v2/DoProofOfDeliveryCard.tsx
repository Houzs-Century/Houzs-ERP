import { PodPhotoAlbum } from "../../components/scm-v2/PodPhotoAlbum";
import { DO_DELIVERED_STATUSES } from "../../vendor/scm/lib/delivery-stop-status";

/* The delivery run as the crew recorded it, on the DO itself (owner,
   2026-10-08: what the driver does on the phone must be visible on the DO):
   On the way, Arrived, Delivered, the POD photo, the customer signature and
   where the POD was taken. Times are the server's, stamped when the crew
   tapped. */

export type DoPodFields = {
  id: string;
  status?: string | null;
  departure_at?: string | null;
  arrival_at?: string | null;
  delivered_at?: string | null;
  pod_r2_key?: string | null;
  pod_photo_keys?: string[] | null;
  signature_data?: string | null;
  pod_lat?: number | null;
  pod_lng?: number | null;
};

const when = (iso: string | null | undefined): string | null =>
  iso
    ? new Date(iso).toLocaleString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : null;

/** True once the customer has the goods (the run-sheet's POD flips DELIVERED). */
export const doIsDelivered = (h: DoPodFields): boolean =>
  DO_DELIVERED_STATUSES.includes((h.status ?? "").toUpperCase()) || !!h.delivered_at;

export function DoProofOfDeliveryCard({ h }: { h: DoPodFields }) {
  // Every photo the POD carries; a DO closed before multi-photo has just pod_r2_key.
  const count = h.pod_photo_keys?.length ? h.pod_photo_keys.length : h.pod_r2_key ? 1 : 0;
  const paths = Array.from({ length: count }, (_, n) => `/api/scm/delivery-orders-mfg/${encodeURIComponent(h.id)}/pod-photo/${n}`);
  const rows: Array<[string, string | null]> = [
    ["On the way", when(h.departure_at)],
    ["Arrived", when(h.arrival_at)],
    ["Delivered", when(h.delivered_at) ?? (doIsDelivered(h) ? "Delivered" : null)],
  ];
  const hasAny = rows.some(([, v]) => v) || count > 0 || !!h.signature_data;

  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Proof of delivery</div>
      {!hasAny && <div className="text-[12.5px] text-ink-muted">Nothing recorded yet. The crew records it from the phone run-sheet.</div>}
      {hasAny && (
        <>
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between border-b border-border-subtle py-2 last:border-b-0">
              <span className="text-[12.5px] text-ink-muted">{k}</span>
              <span className={v ? "text-[13px] font-semibold tabular-nums text-ink" : "text-[13px] font-semibold text-ink-muted"}>{v ?? "—"}</span>
            </div>
          ))}
          {count > 0 && (
            <div className="mt-3">
              <PodPhotoAlbum paths={paths} fileStem={`POD-${h.id.slice(0, 8)}`} />
            </div>
          )}
          {h.signature_data && (
            <div className="mt-2">
              <div className="text-[12.5px] text-ink-muted">Customer signature</div>
              <img src={h.signature_data} alt="Customer signature" className="max-h-24 rounded border border-border bg-white" />
            </div>
          )}
          {h.pod_lat != null && h.pod_lng != null && (
            <a className="mt-2 block text-[12.5px] text-accent underline" target="_blank" rel="noreferrer"
              href={`https://www.google.com/maps?q=${h.pod_lat},${h.pod_lng}`}>Where the POD was taken</a>
          )}
        </>
      )}
    </div>
  );
}
