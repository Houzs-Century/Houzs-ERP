import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueries } from "@tanstack/react-query";
import { api } from "../../api/client";

/* One way to look at proof-of-delivery photos everywhere they show (DO page,
   job panel, Stock Transfer, work order, phone): a thumbnail grid, and a
   full-screen viewer with previous / next (arrow keys too), "n / total", a
   download for the photo in view and one for all of them (owner, 2026-10-08:
   a job can carry many photos and must not take many pages to open).

   `paths` are API paths that each return one image (auth-protected, so they
   are fetched as blobs). */
export function PodPhotoAlbum({ paths, fileStem, emptyText }: {
  paths: string[];
  /** Download file names: `${fileStem}-1.jpg`, … */
  fileStem: string;
  emptyText?: string;
}) {
  const blobs = useQueries({
    queries: paths.map((p) => ({
      queryKey: ["pod-photo-blob", p],
      queryFn: () => api.fetchBlobUrl(p),
      staleTime: 10 * 60_000,
    })),
  });
  const [open, setOpen] = useState<number | null>(null);
  const total = paths.length;
  const step = useCallback((d: number) => setOpen((i) => (i == null ? i : (i + d + total) % total)), [total]);

  useEffect(() => {
    if (open == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step]);

  const save = (i: number) => {
    const url = blobs[i]?.data;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileStem}-${i + 1}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const saveAll = async () => {
    for (let i = 0; i < total; i++) {
      save(i);
      await new Promise((r) => setTimeout(r, 250)); // browsers drop back-to-back downloads
    }
  };

  if (!total) return emptyText ? <div className="text-[12.5px] text-ink-muted">{emptyText}</div> : null;
  const loaded = blobs.filter((b) => b.data).length;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12.5px] text-ink-muted">{total} photo{total === 1 ? "" : "s"}</span>
        <button type="button" onClick={saveAll} disabled={loaded < total}
          className="text-[12.5px] font-semibold text-accent underline disabled:opacity-50">
          Download all
        </button>
      </div>
      <div className="grid max-w-[420px] grid-cols-3 gap-2">
        {blobs.map((b, i) => (
          <button key={paths[i]} type="button" onClick={() => setOpen(i)} aria-label={`Open photo ${i + 1} of ${total}`}
            className="relative aspect-square overflow-hidden rounded border border-border bg-surface-dim">
            {b.data && <img src={b.data} alt={`POD photo ${i + 1}`} className="h-full w-full object-cover" />}
            {b.isPending && <span className="absolute inset-0 grid place-items-center text-[11px] text-ink-muted">Loading…</span>}
            {b.error && <span className="absolute inset-0 grid place-items-center p-1 text-center text-[11px] text-red-600">Could not load</span>}
          </button>
        ))}
      </div>

      {/* Portalled to <body>: inside a card or a sticky aside, position:fixed is
          clipped by the ancestor and the table header painted over the viewer. */}
      {open != null && createPortal(
        <div role="dialog" aria-modal="true" aria-label="POD photo viewer"
          className="fixed inset-0 z-[2000] flex flex-col bg-black/90" onClick={() => setOpen(null)}>
          <div className="flex items-center justify-between px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
            <span className="text-sm tabular-nums">{open + 1} / {total}</span>
            <div className="flex gap-3">
              <button type="button" onClick={() => save(open)} className="rounded bg-white/15 px-3 py-1.5 text-sm">Download</button>
              <button type="button" onClick={saveAll} className="rounded bg-white/15 px-3 py-1.5 text-sm">Download all</button>
              <button type="button" onClick={() => setOpen(null)} aria-label="Close" className="rounded bg-white/15 px-3 py-1.5 text-sm">Close</button>
            </div>
          </div>
          <div className="relative flex flex-1 items-center justify-center px-12 pb-6">
            {total > 1 && (
              <button type="button" aria-label="Previous photo" onClick={(e) => { e.stopPropagation(); step(-1); }}
                className="absolute left-2 rounded-full bg-white/15 px-3 py-2 text-2xl text-white">‹</button>
            )}
            {blobs[open]?.data
              ? <img src={blobs[open]!.data} alt={`POD photo ${open + 1}`} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
              : <span className="text-white/70">Loading…</span>}
            {total > 1 && (
              <button type="button" aria-label="Next photo" onClick={(e) => { e.stopPropagation(); step(1); }}
                className="absolute right-2 rounded-full bg-white/15 px-3 py-2 text-2xl text-white">›</button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
