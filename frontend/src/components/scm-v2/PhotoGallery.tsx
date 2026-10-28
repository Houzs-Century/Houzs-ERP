// ----------------------------------------------------------------------------
// PhotoGallery — multi-photo grid for product models. The backend SHIPPED; all
// four endpoints are live (backend/src/scm/routes/product-models.ts:997-1102,
// migration 0060 scm.product_model_photos), mounted at scm/index.ts:154:
//
//   GET    /scm/product-models/:id/photos          → { photos: PhotoRow[] }
//   POST   /scm/product-models/:id/photos          (multipart `file`) → { photo }
//   DELETE /scm/product-models/:id/photos/:photoId
//   PATCH  /scm/product-models/:id/photos/:photoId (body: { is_primary?, order? })
//
// The R2 bucket is bound too (SO_ITEM_PHOTOS -> houzs-erp, prod + staging, keys
// under product-model-photos/). So a 404 or a 500 photo_bucket_not_configured
// here is a REGRESSION to debug, NOT the expected pre-backend state this header
// used to describe — start at the route + the binding, not at this component.
// The "Not yet wired · Setup notes" treatment is retained as the failure state.
//
// Layout (Final design · Batch 2 gallery variant):
//   · Dashed primary drop zone — drag-and-drop OR click to choose files
//   · Thumbnail grid below — Primary badge on the marked photo, hover actions
//     (Set primary / Delete / move up / move down), in-progress tile with an
//     accent-bright progress bar, error tile with retry
//   · Mobile: "Take photo" / "From library" buttons at top, 2-col grid
//
// Pricing rule of thumb: ≤5MB per file, JPG / PNG / WebP. Server is the final
// gate; the client cap is just to keep the UX honest.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Camera,
  Check,
  ImagePlus,
  ImageUp,
  Loader2,
  RotateCw,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "../Button";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
/* Set-primary, delete and reorder all invalidated on success and said nothing on
   failure — the same shape as the fabric grid the owner reported as "I press it
   and nothing happens". Inline mutations, so the first sweep could not resolve
   them by name; they surfaced once the checker learned to read the component
   they live in. */
import { writeFailed } from "../../vendor/scm/lib/mutation-error";
import { cn } from "../../lib/utils";
import { prepareImageForUpload } from "../../lib/imagePipeline";

// ── Types ───────────────────────────────────────────────────────────────────

export type PhotoRow = {
  id: string;
  key: string;
  url: string;
  /** WO-7 — proxy URL of the `.thumb` sibling; null for photos uploaded
   *  before thumbnails shipped. Grid renders it first, full url on error. */
  thumbUrl?: string | null;
  is_primary: boolean;
  order: number;
};

type UploadState =
  | { phase: "queued" }
  | { phase: "uploading"; progress: number }
  | { phase: "error"; message: string };

type PendingUpload = {
  rid: string;
  file: File;
  state: UploadState;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = "image/jpeg,image/png,image/webp";

type LoadStatus = "ok" | "not-configured" | "error";

function classifyLoadError(err: unknown): LoadStatus {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  // 501 / 500 not_configured / 404 endpoint-missing — all "backend not ready"
  // The 404 path catches both the raw "not_found" body and humanApiError()'s
  // formatted "could no longer be found" phrasing.
  if (
    /\b501\b|\b404\b|not[_\s-]?configured|not[_\s-]?found|could no longer be found/i.test(
      msg,
    )
  ) {
    return "not-configured";
  }
  return "error";
}

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";

const newRid = () => `u${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ── Component ───────────────────────────────────────────────────────────────

export function PhotoGallery({
  modelId,
  modelName,
}: {
  modelId: string;
  modelName?: string;
}) {
  const qc = useQueryClient();

  // List query
  const photosQ = useQuery({
    queryKey: ["product-model-photos", modelId],
    queryFn: () =>
      authedFetch<{ photos: PhotoRow[] }>(
        `/product-models/${modelId}/photos`,
      ).then((r) =>
        [...r.photos].sort((a, b) => {
          // Primary first, then by order asc, then by id for determinism.
          if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
          if (a.order !== b.order) return a.order - b.order;
          return a.id.localeCompare(b.id);
        }),
      ),
    enabled: Boolean(modelId),
    staleTime: 60_000,
    retry: false,
  });

  const loadStatus: LoadStatus = photosQ.error
    ? classifyLoadError(photosQ.error)
    : "ok";

  // Mutations
  const setPrimaryMut = useMutation({
    mutationFn: ({ photoId }: { photoId: string }) =>
      authedFetch<{ ok: true }>(
        `/product-models/${modelId}/photos/${photoId}`,
        { method: "PATCH", body: JSON.stringify({ is_primary: true }) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["product-model-photos", modelId] }),
    onError: writeFailed,
  });

  const deleteMut = useMutation({
    mutationFn: ({ photoId }: { photoId: string }) =>
      authedFetch<{ ok: true }>(
        `/product-models/${modelId}/photos/${photoId}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["product-model-photos", modelId] }),
    onError: writeFailed,
  });

  const reorderMut = useMutation({
    mutationFn: ({ photoId, order }: { photoId: string; order: number }) =>
      authedFetch<{ ok: true }>(
        `/product-models/${modelId}/photos/${photoId}`,
        { method: "PATCH", body: JSON.stringify({ order }) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["product-model-photos", modelId] }),
    onError: writeFailed,
  });

  // Pending uploads (in-flight, kept locally so the UI shows progress tiles
  // BEFORE the photos query refetches).
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Drag-and-drop
  const [dragActive, setDragActive] = useState(false);
  const dragEnterCount = useRef(0);

  // Setup-notes disclosure
  const [showSetup, setShowSetup] = useState(false);

  // Upload pipeline
  const startUpload = async (file: File, rid: string) => {
    setPending((prev) =>
      prev.map((p) =>
        p.rid === rid ? { ...p, state: { phase: "uploading", progress: 0 } } : p,
      ),
    );
    // WO-7 — downscale/re-encode + generate the thumbnail client-side.
    // Falls back to the original file (no thumb part) when unavailable.
    const prepared = await prepareImageForUpload(file);
    if (prepared.file.size > MAX_BYTES) {
      // Compression could not bring it under the server's 5 MB gate —
      // fail here with a clear message instead of burning the upload.
      setPending((prev) =>
        prev.map((p) =>
          p.rid === rid
            ? { ...p, state: { phase: "error", message: "Still over 5 MB after compression - use a smaller image" } }
            : p,
        ),
      );
      return;
    }
    const fd = new FormData();
    fd.append("file", prepared.file);
    if (prepared.thumb) fd.append("thumb", prepared.thumb);
    try {
      await authedFetch<{ photo: PhotoRow }>(
        `/product-models/${modelId}/photos`,
        { method: "POST", body: fd },
      );
      // Success — remove pending tile and refetch the gallery.
      setPending((prev) => prev.filter((p) => p.rid !== rid));
      qc.invalidateQueries({ queryKey: ["product-model-photos", modelId] });
    } catch (e) {
      setPending((prev) =>
        prev.map((p) =>
          p.rid === rid ? { ...p, state: { phase: "error", message: errMsg(e) } } : p,
        ),
      );
    }
  };

  const queueFiles = (files: FileList | File[]) => {
    const arr = Array.from(files);
    const accepted: PendingUpload[] = [];
    for (const f of arr) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) {
        accepted.push({
          rid: newRid(),
          file: f,
          state: { phase: "error", message: `Unsupported type ${f.type || "—"}` },
        });
        continue;
      }
      // WO-7 — startUpload compresses before sending, so a raw phone photo
      // over the server's 5 MB gate is fine now. Keep only a decode-sanity
      // ceiling; the post-compression size is enforced in startUpload.
      if (f.size > 25 * 1024 * 1024) {
        accepted.push({
          rid: newRid(),
          file: f,
          state: {
            phase: "error",
            message: `Too large (${(f.size / (1024 * 1024)).toFixed(1)} MB, max 25 MB)`,
          },
        });
        continue;
      }
      accepted.push({ rid: newRid(), file: f, state: { phase: "queued" } });
    }
    setPending((prev) => [...prev, ...accepted]);
    for (const p of accepted) {
      if (p.state.phase === "queued") void startUpload(p.file, p.rid);
    }
  };

  const retryUpload = (rid: string) => {
    const p = pending.find((x) => x.rid === rid);
    if (!p) return;
    void startUpload(p.file, rid);
  };
  const dropPending = (rid: string) =>
    setPending((prev) => prev.filter((p) => p.rid !== rid));
  const retryAll = () => {
    for (const p of pending) {
      if (p.state.phase === "error") {
        if (/Too large|Unsupported/i.test(p.state.message)) continue;
        void startUpload(p.file, p.rid);
      }
    }
  };

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragEnterCount.current += 1;
    if (dragEnterCount.current === 1) setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragEnterCount.current -= 1;
    if (dragEnterCount.current <= 0) {
      dragEnterCount.current = 0;
      setDragActive(false);
    }
  };
  const onDragOver = (e: React.DragEvent) => e.preventDefault();
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragEnterCount.current = 0;
    setDragActive(false);
    if (e.dataTransfer?.files?.length) queueFiles(e.dataTransfer.files);
  };

  // Local preview URLs for pending uploads
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const p of pending) next[p.rid] = URL.createObjectURL(p.file);
    setPreviewUrls(next);
    return () => {
      Object.values(next).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [pending]);

  const photos = photosQ.data ?? [];
  const hasAnyError = pending.some((p) => p.state.phase === "error");
  const reorderableCount = photos.length;

  // Move helpers (uses PATCH `order` — the backend is expected to insert/swap
  // with adjacent neighbour and renumber consistently).
  const moveUp = (photo: PhotoRow, idx: number) => {
    if (idx === 0) return;
    reorderMut.mutate({ photoId: photo.id, order: Math.max(0, photo.order - 1) });
  };
  const moveDown = (photo: PhotoRow, idx: number) => {
    if (idx === reorderableCount - 1) return;
    reorderMut.mutate({ photoId: photo.id, order: photo.order + 1 });
  };

  return (
    <section
      aria-label="Model photos"
      className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-stone sm:p-5"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Model photos
          </div>
          <h2 className="mt-1 font-display text-[15px] font-extrabold tracking-tight text-ink">
            Gallery {modelName && <span className="text-ink-muted">· {modelName}</span>}
          </h2>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">
            Drag &amp; drop or choose files. JPG / PNG / WebP, ≤ 5 MB each. The
            primary photo is shown wherever this model is referenced (SO
            configurator, catalogue, picker).
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowSetup((v) => !v)}
          aria-expanded={showSetup}
          className="text-[12px] font-semibold text-primary underline underline-offset-[3px] decoration-primary/40 hover:text-primary-ink hover:decoration-primary"
        >
          Setup notes
        </button>
      </div>

      {showSetup && (
        <div className="rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-[12px] text-primary-ink">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-primary">
            Setup notes · Product-model gallery
          </div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            <li>
              Bucket: <span className="font-money">SO_ITEM_PHOTOS</span> R2 (shared with SO
              line photos — already bound in <span className="font-money">backend/wrangler.toml</span>).
            </li>
            <li>
              Backend table:{" "}
              <span className="font-money">product_model_photos (id, model_id, key, order, is_primary)</span>{" "}
              — not yet created.
            </li>
            <li>
              Endpoints:{" "}
              <span className="font-money">GET/POST/DELETE/PATCH /product-models/:id/photos[/:photoId]</span>{" "}
              — coming with BACKEND-CHECKLIST A1.
            </li>
          </ul>
          <p className="mt-2 text-[11px] text-ink-secondary">
            Until then, this gallery shows the "Not yet wired" state and accepts no uploads.
          </p>
        </div>
      )}

      {/* Loading */}
      {photosQ.isLoading && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton aspect-square rounded-lg" />
          ))}
        </div>
      )}

      {/* Not configured */}
      {loadStatus === "not-configured" && !photosQ.isLoading && (
        <NotConfiguredPanel
          onRetry={() => photosQ.refetch()}
          onOpenSetup={() => setShowSetup(true)}
        />
      )}

      {/* Generic load error */}
      {loadStatus === "error" && !photosQ.isLoading && (
        <div className="rounded-lg border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-semibold">Couldn't load photos</div>
              <div className="mt-0.5 text-[11px] opacity-90">{errMsg(photosQ.error)}</div>
            </div>
            <Button
              variant="secondary"
              icon={<RotateCw size={12} />}
              onClick={() => photosQ.refetch()}
            >
              Retry
            </Button>
          </div>
        </div>
      )}

      {/* Drop zone + grid (only when load succeeded) */}
      {loadStatus === "ok" && !photosQ.isLoading && (
        <>
          {/* Pending-uploads error banner */}
          {hasAnyError && (
            <div className="flex items-center justify-between rounded-md border border-err/40 bg-err/5 p-2.5 text-[12px] text-err">
              <span>
                Some uploads failed. Tap a tile to retry, or try them all at once.
              </span>
              <button
                type="button"
                onClick={retryAll}
                className="ml-3 inline-flex items-center gap-1 rounded-md border border-err/40 bg-surface px-2 py-1 text-[11px] font-semibold text-err hover:bg-err/10"
              >
                <RotateCw size={11} /> Retry all
              </button>
            </div>
          )}

          {/* Drop zone */}
          <div
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={onDragOver}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors",
              dragActive
                ? "border-primary bg-primary-soft"
                : "border-primary/30 bg-primary-soft/40 hover:border-primary/60 hover:bg-primary-soft",
            )}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-white">
              <Upload size={18} />
            </div>
            <div className="mt-2 text-[12.5px] font-semibold text-primary-ink">
              Drop photos here or tap to choose
            </div>
            <div className="mt-0.5 text-[10.5px] text-ink-muted">
              JPG / PNG / WebP · ≤ 5 MB each
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2 sm:hidden">
              <Button
                variant="primary"
                icon={<Camera size={14} />}
                onClick={(e) => {
                  e.stopPropagation();
                  cameraInputRef.current?.click();
                }}
              >
                Take photo
              </Button>
              <Button
                variant="secondary"
                icon={<ImagePlus size={14} />}
                onClick={(e) => {
                  e.stopPropagation();
                  fileInputRef.current?.click();
                }}
              >
                From library
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) queueFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) queueFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {/* Grid */}
          {photos.length === 0 && pending.length === 0 ? (
            <div className="rounded-md border border-border bg-surface-2 px-3 py-6 text-center text-[12px] text-ink-muted">
              No photos yet — drop one above to start.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {photos.map((p, idx) => (
                <PhotoTile
                  key={p.id}
                  photo={p}
                  idx={idx}
                  total={photos.length}
                  busy={
                    (setPrimaryMut.isPending && setPrimaryMut.variables?.photoId === p.id) ||
                    (deleteMut.isPending && deleteMut.variables?.photoId === p.id) ||
                    (reorderMut.isPending && reorderMut.variables?.photoId === p.id)
                  }
                  onSetPrimary={() => setPrimaryMut.mutate({ photoId: p.id })}
                  onDelete={() => deleteMut.mutate({ photoId: p.id })}
                  onMoveUp={() => moveUp(p, idx)}
                  onMoveDown={() => moveDown(p, idx)}
                />
              ))}
              {pending.map((p) => (
                <PendingTile
                  key={p.rid}
                  upload={p}
                  previewUrl={previewUrls[p.rid]}
                  onRetry={() => retryUpload(p.rid)}
                  onDismiss={() => dropPending(p.rid)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Tile components ─────────────────────────────────────────────────────────

function PhotoTile({
  photo,
  idx,
  total,
  busy,
  onSetPrimary,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  photo: PhotoRow;
  idx: number;
  total: number;
  busy: boolean;
  onSetPrimary: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  /* WO-7 — render the light `.thumb` sibling in the grid and fall back to
     the full image when it errors (photos uploaded before thumbnails
     shipped have no thumb object; the proxy 404s and onError fires). */
  const [useFull, setUseFull] = useState(!photo.thumbUrl);
  const src = !useFull && photo.thumbUrl ? photo.thumbUrl : photo.url;
  return (
    <div className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-surface-2 shadow-stone">
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        loading="lazy"
        onError={() => {
          if (!useFull) setUseFull(true);
        }}
      />
      {photo.is_primary && (
        <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-brand text-white">
          <Star size={10} /> Primary
        </span>
      )}
      <div
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink/50 opacity-0 transition-opacity",
          "group-hover:opacity-100 focus-within:opacity-100",
          busy && "opacity-100",
        )}
      >
        {busy ? (
          <Loader2 size={20} className="animate-spin text-white" />
        ) : (
          <>
            {!photo.is_primary && (
              <button
                type="button"
                onClick={onSetPrimary}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-primary-ink"
              >
                <Star size={11} /> Set primary
              </button>
            )}
            <div className="flex gap-1">
              <IconAction
                onClick={onMoveUp}
                disabled={idx === 0}
                label="Move up"
                icon={<ArrowUp size={12} />}
              />
              <IconAction
                onClick={onMoveDown}
                disabled={idx === total - 1}
                label="Move down"
                icon={<ArrowDown size={12} />}
              />
              <IconAction
                onClick={onDelete}
                label="Delete"
                icon={<Trash2 size={12} />}
                tone="danger"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function IconAction({
  onClick,
  disabled,
  label,
  icon,
  tone,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  icon: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md border bg-surface text-ink-secondary transition-colors",
        tone === "danger"
          ? "border-err/40 hover:bg-err/10 hover:text-err"
          : "border-border hover:border-primary/50 hover:bg-primary-soft hover:text-primary",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      {icon}
    </button>
  );
}

function PendingTile({
  upload,
  previewUrl,
  onRetry,
  onDismiss,
}: {
  upload: PendingUpload;
  previewUrl?: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const isError = upload.state.phase === "error";
  return (
    <div
      className={cn(
        "relative aspect-square overflow-hidden rounded-lg border bg-surface-2 shadow-stone",
        isError ? "border-err/60" : "border-border",
      )}
    >
      {previewUrl && (
        <img
          src={previewUrl}
          alt=""
          className={cn(
            "h-full w-full object-cover",
            isError ? "grayscale" : "opacity-90",
          )}
        />
      )}
      <div
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-2 px-2 text-center",
          isError ? "bg-err/30" : "bg-ink/30",
        )}
      >
        {isError ? (
          <>
            <AlertCircle size={20} className="text-white" />
            <div className="text-[10.5px] font-semibold text-white">
              {upload.state.phase === "error" && upload.state.message}
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-err hover:bg-surface-dim"
              >
                <RotateCw size={11} /> Retry
              </button>
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss"
                className="flex h-6 w-6 items-center justify-center rounded-md bg-surface text-ink-secondary hover:bg-surface-dim"
              >
                <X size={11} />
              </button>
            </div>
          </>
        ) : (
          <>
            <Loader2 size={20} className="animate-spin text-white" />
            <div className="w-full px-4">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface/30">
                <div
                  className="h-full animate-pulse bg-accent-bright"
                  style={{
                    width:
                      upload.state.phase === "uploading"
                        ? `${Math.max(10, upload.state.progress * 100)}%`
                        : "30%",
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Not-configured panel ────────────────────────────────────────────────────

function NotConfiguredPanel({
  onRetry,
  onOpenSetup,
}: {
  onRetry: () => void;
  onOpenSetup: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-5 py-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[10px] border border-amber-300 bg-warning-bg text-warning-text">
        <ImageUp size={20} />
      </div>
      <div className="mt-3 text-[14px] font-bold text-ink">
        Photo gallery not yet wired
      </div>
      <p className="mx-auto mt-1.5 max-w-[420px] text-[12px] leading-relaxed text-ink-muted">
        The multi-photo endpoint isn't live yet. The single legacy photo above
        is unaffected. See <span className="font-money">BACKEND-CHECKLIST · A1</span>.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" onClick={onOpenSetup}>
          Setup notes
        </Button>
        <Button
          variant="secondary"
          icon={<RotateCw size={14} />}
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    </div>
  );
}

/* Re-export the helper so HeroImageEditor (sibling file) can share the same
   classification + error-format conventions without re-defining them. Keeps
   the "what counts as not-configured" rule in one place. */
export { classifyLoadError, errMsg };
