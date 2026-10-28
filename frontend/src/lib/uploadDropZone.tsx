// ----------------------------------------------------------------------------
// Drop / paste upload plumbing for attachment slots.
//
// A detail view can render several upload targets at once (e.g. the service
// case's Photos card plus one milestone slot per stage row), so pasted files
// must be ROUTED rather than grabbed document-wide: the zone under the
// pointer claims the clipboard files; everywhere else the paste is left
// alone so a caller can show a hint instead of silently dropping it in a
// surprising category. Drag & drop is per-zone naturally.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./utils";

/** Extract pasted file blobs, synthesizing a name for nameless clipboard
 *  files (e.g. a Windows/macOS screenshot paste) so downstream extension
 *  checks work. Returns [] for text pastes. */
export function clipboardFiles(e: ClipboardEvent): File[] {
  if (!e.clipboardData) return [];
  const files: File[] = [];
  for (const item of Array.from(e.clipboardData.items)) {
    if (item.kind !== "file") continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    if (blob.name && blob.name.includes(".")) {
      files.push(blob);
    } else {
      const sub = (blob.type.split("/")[1] || "bin").toLowerCase();
      const ext = sub === "jpeg" ? "jpg" : sub;
      files.push(new File([blob], `pasted-${Date.now()}.${ext}`, { type: blob.type }));
    }
  }
  return files;
}

/** Mirror of the attachment inputs' accept list (image/*, mp4/mov/webm
 *  video, PDF) — drops and pastes bypass the file picker's filter, so
 *  re-check here. Size limits stay server-enforced, exactly like picker
 *  uploads. Rejected files are reported through `toast.error`. */
export function acceptedUploadFiles(
  files: File[],
  toast: { error: (m: string) => void },
): File[] {
  const VIDEO_OR_PDF = new Set(["video/mp4", "video/quicktime", "video/webm", "application/pdf"]);
  const EXT_FALLBACK = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "mp4", "mov", "webm", "pdf"]);
  return files.filter((f) => {
    const t = (f.type || "").toLowerCase();
    const ok = t
      ? t.startsWith("image/") || VIDEO_OR_PDF.has(t)
      : EXT_FALLBACK.has(f.name.split(".").pop()?.toLowerCase() || "");
    if (!ok) toast.error(`${f.name}: unsupported type`);
    return ok;
  });
}

// Zones currently under the pointer. A view's fallback paste listener
// consults this to know whether a zone is about to claim the paste —
// listener order between parent and children isn't stable across
// re-mounts, so a shared registry beats event ordering.
export const hoveredUploadZones = new Set<object>();

/** Wraps an upload target so files can be dropped onto it, or pasted
 *  (Ctrl+V) while the pointer hovers it. Purely additive — the wrapped
 *  file-input flow keeps working unchanged. */
export function UploadDropZone({
  onFiles,
  disabled,
  className,
  children,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [dragActive, setDragActive] = useState(false);
  const zoneId = useRef({});
  const latest = useRef({ onFiles, disabled });
  useEffect(() => {
    latest.current = { onFiles, disabled };
  });
  useEffect(() => {
    const id = zoneId.current;
    const onPaste = (e: ClipboardEvent) => {
      // defaultPrevented = another zone (nested/overlap) already took it.
      if (latest.current.disabled || e.defaultPrevented) return;
      if (!hoveredUploadZones.has(id)) return;
      const files = clipboardFiles(e);
      if (files.length === 0) return;
      e.preventDefault();
      latest.current.onFiles(files);
    };
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("paste", onPaste);
      hoveredUploadZones.delete(id);
    };
  }, []);
  return (
    <div
      title="Drop files here, or hover and press Ctrl+V to paste"
      onMouseEnter={() => hoveredUploadZones.add(zoneId.current)}
      onMouseLeave={() => hoveredUploadZones.delete(zoneId.current)}
      onDragOver={(e) => {
        if (disabled) return;
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          if (!dragActive) setDragActive(true);
        }
      }}
      onDragLeave={(e) => {
        // Ignore leave events triggered by entering a child node.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        if (disabled) return;
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
      className={cn(
        "-m-1.5 rounded-md border border-dashed p-1.5 transition-colors",
        dragActive ? "border-accent bg-accent-soft/30" : "border-transparent",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** While mounted, stop a file drop that misses an upload zone from
 *  navigating the SPA away to the dropped file. */
export function useStrayFileDropGuard() {
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    document.addEventListener("dragover", block);
    document.addEventListener("drop", block);
    return () => {
      document.removeEventListener("dragover", block);
      document.removeEventListener("drop", block);
    };
  }, []);
}
