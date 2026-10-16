import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { PodPhotoAlbum } from "../../components/scm-v2/PodPhotoAlbum";

/* The delivery run of this transfer, as the crew recorded it (owner,
   2026-10-08: a Transfer job is record-only, and the record shows on the
   Stock Transfer). Nothing here moves stock — the transfer posted on creation. */

type Progress = {
  source_id: string; departed_at: string | null; arrived_at: string | null; completed_at: string | null;
  departed_by: number | null; arrived_by: number | null; completed_by: number | null;
  pod_photo_keys: string[] | null; pod_notes: string | null;
};
type Resp = {
  jobs: Array<{ id: string; dp_no: string | null; status: string | null; requested_date: string | null }>;
  progress: Progress[];
  people: Record<string, string>;
};

const when = (iso: string | null, by: number | null, people: Record<string, string>) =>
  iso
    ? `${new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}${by != null && people[String(by)] ? ` · ${people[String(by)]}` : ""}`
    : "—";

export function StockTransferPodSection({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["stock-transfer-delivery-pod", id],
    queryFn: () => authedFetch<Resp>(`/stock-transfers/${encodeURIComponent(id)}/delivery-pod`),
    staleTime: 30_000,
  });
  if (q.isPending) return null;
  if (q.error) return <div className="rounded-lg border border-border p-4 text-[12.5px] text-red-600">Delivery record could not load: {(q.error as Error).message}</div>;
  if (!q.data.jobs.length) return null;

  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Delivery run · proof of delivery</div>
      {q.data.jobs.map((j) => {
        const p = q.data.progress.find((x) => x.source_id === j.id);
        const photos = p?.pod_photo_keys ?? [];
        return (
          <div key={j.id} className="mb-3 last:mb-0">
            <div className="mb-1 text-[13px] font-semibold text-ink">{j.dp_no ?? "Transfer job"} · {j.status ?? "—"}</div>
            {[["On the way", p?.departed_at ?? null, p?.departed_by ?? null], ["Arrived", p?.arrived_at ?? null, p?.arrived_by ?? null],
              ["Completed", p?.completed_at ?? null, p?.completed_by ?? null]].map(([k, at, by]) => (
              <div key={k as string} className="flex justify-between border-b border-border-subtle py-1.5 text-[12.5px] last:border-b-0">
                <span className="text-ink-muted">{k as string}</span>
                <span className="font-semibold text-ink">{when(at as string | null, by as number | null, q.data.people)}</span>
              </div>
            ))}
            {p?.pod_notes && <div className="mt-1 text-[12.5px] text-ink">Note: {p.pod_notes}</div>}
            <div className="mt-2">
              <PodPhotoAlbum
                paths={photos.map((_, n) => `/api/scm/stock-transfers/${encodeURIComponent(id)}/delivery-pod/${j.id}/photo/${n}`)}
                fileStem={`POD-${j.dp_no ?? "transfer"}`}
                emptyText="No POD photo yet."
              />
            </div>
          </div>
        );
      })}
    </section>
  );
}
