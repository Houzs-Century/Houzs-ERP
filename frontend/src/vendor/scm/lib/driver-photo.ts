// The office-maintained photo on an outsource driver (owner 2026-11-28). Mirrors
// lib/profilePicture.ts for a user avatar, pointed at the SCM drivers endpoint
// (GET/POST /api/scm/drivers/:id/photo), which stays behind the router's auth —
// so the photo is fetched as an authed blob, not a bare <img src>.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api/client";
import { prepareImageForUpload } from "../../../lib/imagePipeline";
import { PROFILE_PIC_MAX_BYTES, PROFILE_PIC_MAX_DIMENSION } from "../../../lib/profilePicture";

const photoPath = (id: string) => `/api/scm/drivers/${id}/photo`;

/**
 * The authed driver-photo blob as an object URL. `photoKey` carries the R2 key
 * (a Date.now()-prefixed string), so a fresh upload mints a new key and the new
 * photo appears without a reload; it also gates the fetch (no key, no request).
 * A failed fetch renders as "no photo" — the caller draws initials — but the
 * reason is kept so a caller can say something about it.
 */
export function useDriverPhotoUrl(
  driverId: string | null | undefined,
  photoKey: string | null | undefined,
): { src: string | null; error: string | null } {
  const enabled = !!driverId && !!photoKey;
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSrc(null);
      setError(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    const cacheKey = photoKey ? `?k=${encodeURIComponent(photoKey)}` : "";
    api
      .fetchBlobUrl(`${photoPath(String(driverId))}${cacheKey}`)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
        } else {
          url = u;
          setSrc(u);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSrc(null);
        setError((e as { message?: string } | null)?.message || "Photo unavailable");
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [driverId, enabled, photoKey]);

  return { src, error };
}

export type DriverPhotoWriter = {
  busy: boolean;
  upload: (rawFile: File) => Promise<string | null>;
};

/**
 * Upload one driver's photo. `onChanged` must refresh the driver list so the new
 * R2 key reaches the drawer, or the preview keeps showing the old blob. Returns
 * null on success, or a message to show the user on failure.
 */
export function useDriverPhoto(
  driverId: string | null,
  onChanged: () => Promise<void> | void,
): DriverPhotoWriter {
  const [busy, setBusy] = useState(false);

  const upload = useCallback(
    async (rawFile: File): Promise<string | null> => {
      if (!driverId) return "Save the driver first, then add a photo.";
      if (!rawFile.type.startsWith("image/")) return "Pick an image file";
      setBusy(true);
      try {
        const { file } = await prepareImageForUpload(rawFile, {
          maxDimension: PROFILE_PIC_MAX_DIMENSION,
          wantThumb: false,
        });
        if (file.size > PROFILE_PIC_MAX_BYTES) return "Image must be under 5 MB";
        await api.postBinary(
          `${photoPath(driverId)}?name=${encodeURIComponent(file.name)}`,
          file,
          file.type,
        );
        await onChanged();
        return null;
      } catch (e: unknown) {
        return (e as { message?: string } | null)?.message || "Upload failed";
      } finally {
        setBusy(false);
      }
    },
    [driverId, onChanged],
  );

  return { busy, upload };
}
