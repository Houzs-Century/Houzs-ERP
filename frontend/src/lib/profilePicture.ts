// ---------------------------------------------------------------------------
// profilePicture — the profile-photo read and write paths, once.
//
// WHY THIS FILE EXISTS. Upload and delete lived inside `pages/Profile.tsx`
// (uploadPic / removePic) and the blob read lived inside `components/Avatar.tsx`.
// Both are desktop files, and `frontend/src/mobile/` contained no reference to
// `profile_pic` at all — so the ONE device with a camera could neither upload a
// photo nor display one that had been uploaded from a PC.
//
// Two hooks, because they are two different gaps:
//   · useProfilePicUrl  — the READ. Fetches the authed blob and hands back an
//     object URL, revoking it on unmount / key change. Used by the desktop
//     `Avatar` and by the mobile identity card.
//   · useProfilePicture — the WRITE. Compress → weigh → PUT, and the delete.
//
// THE LIMITS ARE NOT RE-TYPED. `maxDimension: 1000` and the 5 MB refusal are the
// desktop's own numbers, and they now exist in exactly one place, so the phone
// cannot drift permissive. Avatars render small; compression also absorbs what
// used to be a hard rejection of ordinary phone shots.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { prepareImageForUpload } from "./imagePipeline";

/** Avatars render small; 1000px is generous. Shared by every upload surface. */
export const PROFILE_PIC_MAX_DIMENSION = 1000;
/** Weighed AFTER compression, so this refuses what we would actually send. */
export const PROFILE_PIC_MAX_BYTES = 5 * 1024 * 1024;

// ── READ ────────────────────────────────────────────────────────────────────

/**
 * The authed profile-photo blob for one user, as an object URL.
 *
 * `hasImage` is the R2 key (or any truthy marker). R2 keys carry a Date.now()
 * prefix, so a fresh upload yields a new key — passing it through as a
 * cache-buster is what makes the new photo appear without a reload.
 *
 * A failed fetch renders as "no photo", which is the honest fallback for a
 * decoration: the caller draws initials. The reason is BOUND rather than
 * discarded (`Avatar.tsx` used to end this promise with a bare
 * `.catch(() => {})`, one of the sites `audit:swallowed-reads` counts) so a
 * caller that wants to say something about it can.
 */
export function useProfilePicUrl(
  userId: number | string | null | undefined,
  hasImage?: boolean | string | null,
): { src: string | null; error: string | null } {
  const enabled = !!userId && !!hasImage;
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
    const cacheKey = typeof hasImage === "string" ? `?k=${encodeURIComponent(hasImage)}` : "";
    api
      .fetchBlobUrl(`/api/users/${userId}/profile-pic${cacheKey}`)
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
  }, [userId, enabled, hasImage]);

  return { src, error };
}

// ── WRITE ───────────────────────────────────────────────────────────────────

export type ProfilePictureWriter = {
  busy: boolean;
  /** @returns null on success, else a sentence to show the operator. */
  upload: (rawFile: File) => Promise<string | null>;
  /** @returns null on success, else a sentence to show the operator. */
  remove: () => Promise<string | null>;
};

/**
 * Upload / delete the CALLER'S OWN photo (`/api/users/me/profile-pic`).
 *
 * `onChanged` is the auth reload — the new R2 key has to reach `user` or every
 * `<Avatar>` on screen keeps rendering the old blob.
 */
export function useProfilePicture(onChanged: () => Promise<void> | void): ProfilePictureWriter {
  const [busy, setBusy] = useState(false);

  const upload = useCallback(
    async (rawFile: File): Promise<string | null> => {
      if (!rawFile.type.startsWith("image/")) return "Pick an image file";
      setBusy(true);
      try {
        const { file } = await prepareImageForUpload(rawFile, {
          maxDimension: PROFILE_PIC_MAX_DIMENSION,
          wantThumb: false,
        });
        if (file.size > PROFILE_PIC_MAX_BYTES) return "Image must be under 5 MB";
        await api.putBinary(
          `/api/users/me/profile-pic?name=${encodeURIComponent(file.name)}`,
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
    [onChanged],
  );

  const remove = useCallback(async (): Promise<string | null> => {
    setBusy(true);
    try {
      await api.del("/api/users/me/profile-pic");
      await onChanged();
      return null;
    } catch (e: unknown) {
      return (e as { message?: string } | null)?.message || "Something went wrong. Please try again.";
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  return { busy, upload, remove };
}
