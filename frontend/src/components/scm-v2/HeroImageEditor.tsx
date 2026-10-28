// ----------------------------------------------------------------------------
// HeroImageEditor — category hero image with a draggable focal-point.
//
// Backend endpoints (all live; PUBLIC_ASSETS R2 binding wired since 2026-06-18):
//   POST   /scm/admin/categories/:id/hero-image   raw image body, content-type
//                                                 drives format; writes to the
//                                                 PUBLIC_ASSETS R2 bucket and
//                                                 sets scm.categories.hero_image_key
//   DELETE /scm/admin/categories/:id/hero-image   removes the R2 object and
//                                                 nulls hero_image_key/focal/alt
//   GET    /scm/categories/:id/hero-meta          { url, focal_x, focal_y, alt }
//   PATCH  /scm/categories/:id/hero-meta          { focal_x, focal_y, alt }
//   GET    /scm/categories/:id/hero-blob          streams the R2 blob. Loaded
//                                                 via <img src>; the browser's
//                                                 session cookie carries the
//                                                 /api/scm auth (the route
//                                                 lives under the same gated
//                                                 tree — not truly public).
//
// The classifyLoadError-driven "not wired" fallback state is kept for defense
// in depth: if the binding is ever unbound or the bucket is missing, the
// hero-meta load surfaces a clear setup-notes UI instead of a blank crash.
//
// Layout (Final F4):
//   · 16:7 preview area with a draggable crosshair (gold ring) at focal x,y
//   · Replace / Remove buttons above
//   · Aspect preset row (16:7 / 4:3 / 1:1) — selected = primary-soft
//   · Alt-text field
//   · "Setup notes" link in the section header (shared infra-dep pattern)
//   · "Apply cover" CTA
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  Crosshair,
  ImageUp,
  Loader2,
  RotateCw,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "../Button";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { cn } from "../../lib/utils";
import { classifyLoadError, errMsg } from "./PhotoGallery";

// ── Types ───────────────────────────────────────────────────────────────────

export type HeroMeta = {
  url: string | null;
  focal_x: number; // 0–1
  focal_y: number; // 0–1
  alt: string;
};

type Aspect = "16/7" | "4/3" | "1/1";
const ASPECTS: Array<{ key: Aspect; label: string; css: string; aspect: string }> = [
  { key: "16/7", label: "16 : 7", css: "16/7", aspect: "16 / 7" },
  { key: "4/3", label: "4 : 3", css: "4/3", aspect: "4 / 3" },
  { key: "1/1", label: "1 : 1", css: "1/1", aspect: "1 / 1" },
];

const MAX_BYTES = 4 * 1024 * 1024; // hero endpoint caps at 4 MB
const ACCEPT = "image/jpeg,image/png";
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// ── Component ───────────────────────────────────────────────────────────────

export function HeroImageEditor({
  categoryId,
  categoryName,
  onClose,
}: {
  categoryId: string;
  categoryName?: string;
  onClose?: () => void;
}) {
  const qc = useQueryClient();

  // Fetch the saved hero meta. Endpoint shape (expected):
  //   GET /scm/categories/:id/hero-meta → { url, focal_x, focal_y, alt }
  // Until backend ships the meta route we fall back to "blob URL only" (a
  // GET /hero-image with no focal/alt) which still lets the operator upload +
  // see the existing image.
  const metaQ = useQuery({
    queryKey: ["category-hero-meta", categoryId],
    queryFn: async (): Promise<HeroMeta> => {
      try {
        const r = await authedFetch<HeroMeta>(`/categories/${categoryId}/hero-meta`);
        return {
          url: r.url ?? null,
          focal_x: typeof r.focal_x === "number" ? clamp01(r.focal_x) : 0.5,
          focal_y: typeof r.focal_y === "number" ? clamp01(r.focal_y) : 0.5,
          alt: r.alt ?? "",
        };
      } catch (e) {
        // Surface the classification so the page can render the right state.
        throw e;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
  const metaStatus = metaQ.error ? classifyLoadError(metaQ.error) : "ok";

  // Local working copy (so the operator can drag the crosshair / edit alt
  // even when backend hasn't shipped yet).
  const [focal, setFocal] = useState({ x: 0.5, y: 0.5 });
  const [alt, setAlt] = useState("");
  const [aspect, setAspect] = useState<Aspect>("16/7");
  const [showSetup, setShowSetup] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (metaQ.data) {
      setFocal({ x: metaQ.data.focal_x, y: metaQ.data.focal_y });
      setAlt(metaQ.data.alt);
    }
  }, [metaQ.data]);

  useEffect(() => {
    if (!pendingFile) {
      setPendingPreview(null);
      return;
    }
    const url = URL.createObjectURL(pendingFile);
    setPendingPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  // The image url shown in the preview: pending upload wins, then saved hero.
  const previewUrl = pendingPreview || metaQ.data?.url || null;

  // Mutations
  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      // Raw body upload — backend POST /:id/hero-image expects content-type:
      // image/jpeg|png + raw arrayBuffer in the body. authedFetch treats a
      // non-FormData/non-string body as a passthrough and stamps the
      // content-type from the file.
      const buf = await file.arrayBuffer();
      return authedFetch<{ ok: true; key: string }>(
        `/admin/categories/${categoryId}/hero-image`,
        {
          method: "POST",
          body: buf,
          headers: { "content-type": file.type },
        },
      );
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["category-hero-meta", categoryId] }),
  });
  const deleteMut = useMutation({
    mutationFn: () =>
      authedFetch<{ ok: true }>(`/admin/categories/${categoryId}/hero-image`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["category-hero-meta", categoryId] }),
  });
  const patchMetaMut = useMutation({
    mutationFn: (body: { focal_x: number; focal_y: number; alt: string }) =>
      authedFetch<{ ok: true }>(`/categories/${categoryId}/hero-meta`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["category-hero-meta", categoryId] }),
  });

  const applyCover = async () => {
    setUploadError(null);
    try {
      if (pendingFile) {
        await uploadMut.mutateAsync(pendingFile);
        setPendingFile(null);
      }
      await patchMetaMut.mutateAsync({
        focal_x: focal.x,
        focal_y: focal.y,
        alt: alt.trim(),
      });
    } catch (e) {
      setUploadError(errMsg(e));
    }
  };

  const removeCover = async () => {
    setUploadError(null);
    try {
      await deleteMut.mutateAsync();
      setPendingFile(null);
      setFocal({ x: 0.5, y: 0.5 });
      setAlt("");
    } catch (e) {
      setUploadError(errMsg(e));
    }
  };

  const pickFile = (f: File) => {
    setUploadError(null);
    if (!/^image\/(jpeg|png)$/.test(f.type)) {
      setUploadError(`Unsupported type ${f.type || "—"} — use JPG or PNG`);
      return;
    }
    if (f.size > MAX_BYTES) {
      setUploadError(
        `Too large (${(f.size / (1024 * 1024)).toFixed(1)} MB, max 4 MB)`,
      );
      return;
    }
    setPendingFile(f);
  };

  const aspectCss = ASPECTS.find((a) => a.key === aspect)!.aspect;

  // Drag the crosshair
  const previewRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const onDragStart = (e: React.PointerEvent) => {
    if (!previewUrl) return;
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    moveFocal(e);
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    moveFocal(e);
  };
  const onDragEnd = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };
  const moveFocal = (e: React.PointerEvent) => {
    const el = previewRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clamp01((e.clientX - rect.left) / rect.width);
    const y = clamp01((e.clientY - rect.top) / rect.height);
    setFocal({ x, y });
  };

  const isSavePending = uploadMut.isPending || patchMetaMut.isPending;
  const showOverlay = metaStatus === "not-configured";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Category hero {categoryName && <span className="text-ink-muted">· {categoryName}</span>}
          </div>
          <h2 className="mt-1 font-display text-[16px] font-extrabold tracking-tight text-ink">
            Cover image &amp; focal point
          </h2>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">
            Drag the gold crosshair to set the focal point — it controls the
            CSS <span className="font-money">object-position</span> wherever the
            cover is cropped (banner / hero on the front page, grid card,
            mobile tile).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowSetup((v) => !v)}
            aria-expanded={showSetup}
            className="text-[12px] font-semibold text-primary underline underline-offset-[3px] decoration-primary/40 hover:text-primary-ink hover:decoration-primary"
          >
            Setup notes
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-[11px] font-semibold text-ink-muted hover:text-ink"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {showSetup && (
        <div className="rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-[12px] text-primary-ink">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-primary">
            Setup notes · Category hero
          </div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            <li>
              Bucket: <span className="font-money">PUBLIC_ASSETS</span> R2 — needs binding in{" "}
              <span className="font-money">backend/wrangler.toml</span>.
            </li>
            <li>
              Backend column extension:{" "}
              <span className="font-money">categories.hero_focal_x / hero_focal_y / hero_alt</span>{" "}
              — coming with BACKEND-CHECKLIST A2.
            </li>
            <li>
              Endpoint:{" "}
              <span className="font-money">
                PATCH /categories/:id/hero-meta {"{ focal_x, focal_y, alt }"}
              </span>{" "}
              — coming with the same PR.
            </li>
          </ul>
          <p className="mt-2 text-[11px] text-ink-secondary">
            Existing <span className="font-money">POST/GET/DELETE /:id/hero-image</span> handlers
            work as soon as <span className="font-money">PUBLIC_ASSETS</span> is bound.
          </p>
        </div>
      )}

      {/* Error banner (upload failure / not-configured) */}
      {(uploadError ||
        metaStatus === "error" ||
        uploadMut.isError ||
        patchMetaMut.isError ||
        deleteMut.isError) &&
        !showOverlay && (
          <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
            <div className="flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <div>
                {uploadError ||
                  errMsg(
                    uploadMut.error ||
                      patchMetaMut.error ||
                      deleteMut.error ||
                      metaQ.error,
                  )}
              </div>
            </div>
          </div>
        )}

      {/* Aspect presets */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Aspect
        </span>
        <div className="inline-flex overflow-hidden rounded-md border border-border bg-surface">
          {ASPECTS.map((a) => {
            const isOn = aspect === a.key;
            return (
              <button
                key={a.key}
                type="button"
                onClick={() => setAspect(a.key)}
                className={cn(
                  "px-3 py-1 text-[11px] font-semibold transition-colors",
                  isOn
                    ? "bg-primary-soft text-primary-ink"
                    : "text-ink-secondary hover:text-primary",
                )}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Preview area */}
      <div
        ref={previewRef}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className={cn(
          "relative overflow-hidden rounded-xl border-2 border-dashed border-border-strong bg-surface-2 select-none",
          previewUrl ? "cursor-crosshair" : "cursor-pointer",
        )}
        style={{ aspectRatio: aspectCss }}
        onClick={() => {
          if (!previewUrl) fileInputRef.current?.click();
        }}
      >
        {metaQ.isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-dim">
            <Loader2 size={20} className="animate-spin text-ink-muted" />
          </div>
        )}

        {previewUrl && (
          <img
            src={previewUrl}
            alt={alt || ""}
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            style={{
              objectPosition: `${(focal.x * 100).toFixed(1)}% ${(focal.y * 100).toFixed(1)}%`,
            }}
            draggable={false}
          />
        )}

        {!previewUrl && !metaQ.isLoading && metaStatus !== "not-configured" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-white">
              <Upload size={18} />
            </div>
            <div className="mt-2 text-[12.5px] font-semibold text-primary-ink">
              Drop image or click to choose
            </div>
            <div className="mt-0.5 text-[10.5px] text-ink-muted">
              JPG / PNG · ≤ 4 MB
            </div>
          </div>
        )}

        {previewUrl && (
          // Focal crosshair — gold ring with hairlines.
          <div
            className="pointer-events-none absolute"
            style={{
              left: `${(focal.x * 100).toFixed(1)}%`,
              top: `${(focal.y * 100).toFixed(1)}%`,
              transform: "translate(-50%, -50%)",
            }}
            aria-hidden
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-accent-bright bg-accent/20 ring-2 ring-ink/30">
              <Crosshair size={16} className="text-accent-bright drop-shadow" />
            </div>
          </div>
        )}

        {/* Hairline guides for clarity at edge focal points */}
        {previewUrl && (
          <>
            <div
              className="pointer-events-none absolute top-0 h-full w-px bg-accent-bright/50"
              style={{ left: `${(focal.x * 100).toFixed(1)}%` }}
              aria-hidden
            />
            <div
              className="pointer-events-none absolute left-0 h-px w-full bg-accent-bright/50"
              style={{ top: `${(focal.y * 100).toFixed(1)}%` }}
              aria-hidden
            />
          </>
        )}

        {/* Not-configured overlay */}
        {showOverlay && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-surface/70 to-surface/95 px-6 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-amber-300 bg-warning-bg text-warning-text">
              <ImageUp size={18} />
            </div>
            <div className="mt-2 text-[13.5px] font-bold text-ink">
              Category hero not yet wired
            </div>
            <p className="mt-1 max-w-[360px] text-[11.5px] leading-relaxed text-ink-muted">
              Needs <span className="font-money text-accent">PUBLIC_ASSETS</span> R2
              binding and the focal+alt meta endpoint. See{" "}
              <span className="font-money">BACKEND-CHECKLIST · A2</span>.
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <Button variant="primary" onClick={() => setShowSetup(true)}>
                Setup notes
              </Button>
              <Button
                variant="secondary"
                icon={<RotateCw size={14} />}
                onClick={() => metaQ.refetch()}
              >
                Retry
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Replace / Remove */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pickFile(f);
            e.target.value = "";
          }}
        />
        <Button
          variant="secondary"
          icon={<ImageUp size={14} />}
          onClick={() => fileInputRef.current?.click()}
        >
          {previewUrl ? "Replace image" : "Choose image"}
        </Button>
        {previewUrl && (
          <Button
            variant="danger"
            icon={<Trash2 size={14} />}
            onClick={removeCover}
            disabled={deleteMut.isPending}
          >
            {deleteMut.isPending ? "Removing…" : "Remove"}
          </Button>
        )}
        <div className="ml-auto font-money text-[10.5px] text-ink-muted">
          Focal {(focal.x * 100).toFixed(0)}% · {(focal.y * 100).toFixed(0)}%
        </div>
      </div>

      {/* Alt text */}
      <label className="block">
        <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Alt text
        </span>
        <input
          type="text"
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          placeholder="Describe the image for screen readers — e.g. 'Living-room leather modular sofa display'"
          className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          maxLength={200}
        />
        <div className="mt-1 text-[10px] text-ink-muted">{alt.length} / 200</div>
      </label>

      {/* Apply CTA */}
      <div className="flex items-center justify-end gap-2">
        {patchMetaMut.isSuccess && !isSavePending && (
          <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-primary">
            <Check size={12} /> Saved
          </span>
        )}
        <Button
          variant="primary"
          onClick={applyCover}
          disabled={isSavePending || (!pendingFile && !metaQ.data?.url)}
          icon={
            isSavePending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Check size={14} />
            )
          }
        >
          {isSavePending ? "Saving…" : "Apply cover"}
        </Button>
      </div>
    </div>
  );
}
