// ----------------------------------------------------------------------------
// photoThumbs — shared thumbnail-key vocabulary + optional-thumb storage for
// the WO-7 image pipeline (client-side compression + thumbnails).
//
// CONTRACT (mirrored by frontend/src/lib/imagePipeline.ts):
//   - A thumbnail for R2 object `a/b/c.jpg` always lives at `a/b/c.jpg.thumb`
//     in the SAME bucket. Deterministic sibling key — no DB column required
//     (product_model_photos.thumb_key exists and is stamped where available,
//     but readers must never depend on it).
//   - Thumbs are OPTIONAL everywhere: every photo uploaded before this
//     shipped has no thumb, and old clients keep uploading without one.
//     Readers 404 on a missing thumb and the frontend falls back to the
//     original object.
//   - Thumbs are best-effort on write too: an invalid/oversized thumb part is
//     IGNORED (warn-logged), never a reason to fail the main photo upload.
// ----------------------------------------------------------------------------

import type { R2Bucket } from '@cloudflare/workers-types';

export const THUMB_SUFFIX = '.thumb';

/** Client thumbs render at ~400px and encode to a few tens of KB. Anything
 *  above this is not a thumbnail — refuse to store it under the thumb key. */
export const THUMB_MAX_BYTES = 1024 * 1024;

export function thumbKeyFor(key: string): string {
  return key + THUMB_SUFFIX;
}

export function isThumbKey(key: string): boolean {
  return key.endsWith(THUMB_SUFFIX) && key.length > THUMB_SUFFIX.length;
}

/** `a/b/c.jpg.thumb` -> `a/b/c.jpg`; non-thumb keys pass through unchanged.
 *  Lets read routes authorize a thumb request against its base object's row. */
export function baseKeyOf(key: string): string {
  return isThumbKey(key) ? key.slice(0, -THUMB_SUFFIX.length) : key;
}

/** True when this multipart part is a plausible client-generated thumbnail. */
export function isValidThumbPart(part: unknown): part is File {
  return (
    typeof part === 'object' &&
    part !== null &&
    part instanceof File &&
    part.size > 0 &&
    part.size <= THUMB_MAX_BYTES &&
    (part.type || '').toLowerCase().startsWith('image/')
  );
}

/**
 * Store an optional multipart `thumb` part at `<mainKey>.thumb`.
 * Never throws: the thumb is an optimization, and a failure to store it must
 * not fail (or roll back) the main photo upload it accompanies.
 * Returns the thumb key when stored, null otherwise.
 */
export async function putOptionalThumb(
  bucket: R2Bucket,
  part: unknown,
  mainKey: string,
  customMetadata?: Record<string, string>,
): Promise<string | null> {
  if (part === undefined || part === null) return null;
  if (!isValidThumbPart(part)) {
    console.warn(`[photo-thumbs] ignoring invalid thumb part for ${mainKey}`);
    return null;
  }
  const key = thumbKeyFor(mainKey);
  try {
    await bucket.put(key, await part.arrayBuffer(), {
      httpMetadata: { contentType: part.type },
      ...(customMetadata ? { customMetadata } : {}),
    });
    return key;
  } catch (e) {
    console.warn(
      `[photo-thumbs] thumb put failed for ${key}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/** Best-effort delete of a key's thumb sibling — call wherever the main
 *  object is deleted so thumbs never orphan. */
export async function deleteThumbFor(bucket: R2Bucket, mainKey: string): Promise<void> {
  await bucket.delete(thumbKeyFor(mainKey)).catch(() => {});
}
