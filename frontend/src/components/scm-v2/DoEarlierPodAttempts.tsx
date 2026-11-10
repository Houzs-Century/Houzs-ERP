import { fmtDateTime } from "@2990s/shared";
import { PodPhotoAlbum } from "./PodPhotoAlbum";
import { doPodAttemptPhotoPaths, useDoPodAttempts, type DoPodAttempt } from "../../vendor/scm/lib/do-pod-attempts";

/* The proof of delivery an "Undo delivered" took off the order, kept so the
   driver's real POD cannot overwrite it (owner-approved 2026-11-10). Collapsed
   by default under the current POD; renders nothing when the order was never
   undone. Used by the desktop DO page and the phone's DO detail alike. */

export function earlierAttemptSummary(a: Pick<DoPodAttempt, "undone_at" | "undone_by_name" | "reason">): string {
  return `Earlier delivery attempt (undone on ${fmtDateTime(a.undone_at)} by ${a.undone_by_name || "unknown user"}: ${a.reason})`;
}

export function DoEarlierPodAttemptsList({ attempts, docNo, loadError }: {
  attempts: DoPodAttempt[] | undefined;
  docNo: string;
  loadError: string | null;
}) {
  if (loadError) {
    return <div role="alert" className="text-[12.5px] text-err">Earlier delivery attempts could not be loaded: {loadError}</div>;
  }
  if (!attempts?.length) return null;
  return (
    <div data-testid="do-earlier-pod-attempts" className="space-y-2">
      {attempts.map((a) => {
        const rows: Array<[string, string | null]> = [
          ["On the way", a.departure_at ? fmtDateTime(a.departure_at) : null],
          ["Arrived", a.arrival_at ? fmtDateTime(a.arrival_at) : null],
          ["Delivered", a.delivered_at ? fmtDateTime(a.delivered_at) : a.signed_at ? fmtDateTime(a.signed_at) : null],
        ];
        return (
          <details key={a.id} className="rounded-lg border border-border bg-surface p-3 shadow-stone">
            <summary className="cursor-pointer text-[12.5px] font-semibold text-ink">{earlierAttemptSummary(a)}</summary>
            <div className="mt-2">
              {rows.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between border-b border-border-subtle py-1.5 last:border-b-0">
                  <span className="text-[12.5px] text-ink-muted">{k}</span>
                  <span className="text-[13px] font-semibold tabular-nums text-ink">{v ?? "—"}</span>
                </div>
              ))}
              <div className="mt-2">
                <PodPhotoAlbum
                  paths={doPodAttemptPhotoPaths(a)}
                  fileStem={`POD-${docNo}-attempt-${a.attempt_no}`}
                  title={`${docNo} (earlier attempt ${a.attempt_no})`}
                  emptyText="No photos were taken that time."
                />
              </div>
              {a.signature_data && (
                <div className="mt-2">
                  <div className="text-[12.5px] text-ink-muted">Customer signature</div>
                  <img src={a.signature_data} alt={`Customer signature, earlier attempt ${a.attempt_no}`} className="max-h-24 rounded border border-border bg-white" />
                </div>
              )}
              {a.pod_lat != null && a.pod_lng != null && (
                <a className="mt-2 block text-[12.5px] text-accent underline" target="_blank" rel="noreferrer"
                  href={`https://www.google.com/maps?q=${a.pod_lat},${a.pod_lng}`}>Where that POD was taken</a>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export function DoEarlierPodAttempts({ doId, docNo }: { doId: string | null | undefined; docNo: string }) {
  const q = useDoPodAttempts(doId);
  return (
    <DoEarlierPodAttemptsList
      attempts={q.data}
      docNo={docNo}
      loadError={q.isError ? (q.error instanceof Error ? q.error.message : "unknown error") : null}
    />
  );
}
