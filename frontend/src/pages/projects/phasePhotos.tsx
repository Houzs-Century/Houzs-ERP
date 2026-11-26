import { useState, useEffect } from "react";
import { Trash2, FileText, ImageOff, Play } from "lucide-react";
import { PanelSection } from "../../components/Panel";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { MediaLightbox } from "../../components/MediaLightbox";
import { formatTimestamp } from "../../lib/utils";


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
