import { useState, useEffect } from "react";
import { Trash2, FileText, ImageOff, Play } from "lucide-react";
import { PanelSection } from "../../components/Panel";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { MediaLightbox } from "../../components/MediaLightbox";
import { formatTimestamp } from "../../lib/utils";

// ── Phase Photos — crew-uploaded evidence panel (read-only office side) ──

export interface PhasePhoto {
  id: number;
  phase: "setup" | "dismantle" | "service" | "schedule";
  r2_key: string;
  content_type: string | null;
  caption: string | null;
  uploaded_by: number | null;
  uploaded_by_name: string | null;
  uploaded_at: string;
}

export function PhasePhotosSection({ projectId }: { projectId: number }) {
  const photos = useQuery<{ photos: PhasePhoto[] }>("/api/projects/:/phase-photos",
    () => api.get(`/api/projects/${projectId}/phase-photos`),
    [projectId]
  );
  const setup = (photos.data?.photos ?? []).filter((p) => p.phase === "setup");
  const dismantle = (photos.data?.photos ?? []).filter((p) => p.phase === "dismantle");

  return (
    <PanelSection title="Phase Photos" muted>
      <div className="text-[11px] text-ink-muted">
        Uploaded by setup / dismantle crew from the Driver App.
      </div>
      <PhotoGroup label="Setup" photos={setup} onChange={() => photos.reload()} />
      <PhotoGroup label="Dismantle" photos={dismantle} onChange={() => photos.reload()} />
    </PanelSection>
  );
}

export function PhotoGroup({
  label,
  photos,
  onChange,
}: {
  label: string;
  photos: PhasePhoto[];
  onChange: () => void;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  return (
    <div className="mt-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {label} · {photos.length}
      </div>
      {photos.length === 0 ? (
        <div className="text-[12px] text-ink-muted">No {label.toLowerCase()} photos yet.</div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
          {photos.map((p, i) => (
            <PhasePhotoThumb
              key={p.id}
              photo={p}
              onOpen={() => setLightboxIndex(i)}
              onDeleted={onChange}
            />
          ))}
        </div>
      )}
      {lightboxIndex !== null && (
        <MediaLightbox
          items={photos}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          baseUrl="/api/projects/attachments"
          badge={label}
        />
      )}
    </div>
  );
}

function PhasePhotoThumb({
  photo,
  onOpen,
  onDeleted,
}: {
  photo: PhasePhoto;
  onOpen: () => void;
  onDeleted: () => void;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const isImage = (photo.content_type || "").startsWith("image/");
  const isVideo = (photo.content_type || "").startsWith("video/");
  const [url, setUrl] = useState<string | null>(null);
  // A thumbnail that fails to load used to render an empty grey square,
  // indistinguishable from one still loading and from a photo that isn't there.
  // Keep the reason: the tile shows a broken-image state and the tooltip carries
  // the plain-language message (api.client throws HttpError whose `.message` is
  // already humanHttpMessage — a 403 reads "You don't have permission to do
  // that", not a status dump).
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    let revoke: string | null = null;
    setLoadError(null);
    api
      .fetchBlobUrl(`/api/projects/attachments/${photo.r2_key}`)
      .then((u) => {
        revoke = u;
        setUrl(u);
      })
      .catch((e: unknown) => {
        setLoadError(
          e instanceof Error && e.message ? e.message : "This preview couldn't be loaded.",
        );
      });
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [photo.r2_key, isImage]);

  const extLabel = (() => {
    const m = photo.r2_key.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toUpperCase() : "FILE";
  })();

  // Compact card: thumb fills the cell; uploader + delete sit in a tiny
  // hover-revealed strip so the grid reads as a dense gallery rather
  // than a stack of metadata cards. Lightbox surfaces the full caption
  // + uploader, so this surface stays terse on purpose.
  return (
    <div className="group relative overflow-hidden rounded-md border border-border bg-surface">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open preview"
        title={
          [photo.caption, photo.uploaded_by_name, formatTimestamp(photo.uploaded_at)]
            .filter(Boolean)
            .join(" · ")
        }
        className="block w-full"
      >
        <div className="aspect-square bg-bg">
          {isImage ? (
            url ? (
              <img src={url} alt={photo.caption || ""} className="h-full w-full object-cover" />
            ) : loadError ? (
              <div
                className="flex h-full w-full flex-col items-center justify-center gap-0.5 p-1 text-center"
                title={loadError}
              >
                <ImageOff size={18} className="text-err" />
                <div className="text-[8px] font-semibold uppercase tracking-wide text-err">
                  Failed
                </div>
              </div>
            ) : (
              <div className="h-full w-full" />
            )
          ) : isVideo ? (
            <div className="relative flex h-full w-full items-center justify-center bg-ink/90">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 shadow-md">
                <Play size={13} className="ml-0.5 text-ink" fill="currentColor" />
              </div>
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[7px] font-bold uppercase tracking-wider text-white">
                {extLabel}
              </span>
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 p-1 text-center">
              <FileText size={18} className="text-ink-secondary" />
              <div className="text-[8px] font-semibold uppercase tracking-wide text-ink-muted">
                {extLabel}
              </div>
            </div>
          )}
        </div>
      </button>
      {/* Uploader strip — single line at the bottom edge, very small.
          Stays visible (not hover-gated) so a glance reads "who took
          this" without opening the lightbox. */}
      <div className="flex items-center justify-between gap-1 border-t border-border-subtle bg-bg/40 px-1.5 py-0.5">
        <span className="truncate text-[9px] text-ink-secondary" title={photo.uploaded_by_name || "Unknown"}>
          {photo.uploaded_by_name || "—"}
        </span>
        <button
          className="rounded p-0.5 text-ink-muted opacity-0 transition-opacity hover:bg-err/10 hover:text-err group-hover:opacity-100"
          title="Delete"
          onClick={async (e) => {
            e.stopPropagation();
            const ok = await dialog.confirm({
              title: "Delete this file?",
              message:
                photo.caption ||
                photo.uploaded_by_name
                  ? `Uploaded by ${photo.uploaded_by_name || "Unknown"}. This can't be undone.`
                  : "This can't be undone.",
              confirmLabel: "Delete",
              danger: true,
            });
            if (!ok) return;
            // The refresh must not run unless the delete actually happened.
            // It used to be `.catch(() => {})` followed by an unconditional
            // onDeleted(): a denied or failed delete re-rendered the grid with
            // the file still in it and said nothing, so the operator read the
            // reappearing tile as the UI being slow and clicked again.
            try {
              await api.del(`/api/projects/phase-photos/${photo.id}`);
            } catch (e) {
              toast.error((e as { message?: string } | null)?.message || "Couldn't delete this file. It is still there — please try again.");
              return;
            }
            onDeleted();
          }}
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}
