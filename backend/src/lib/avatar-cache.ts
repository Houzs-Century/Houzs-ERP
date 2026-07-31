/**
 * Cache policy for GET /api/users/:id/profile-pic.
 *
 * Extracted so the one invariant that makes a year-long TTL safe is stated in
 * a testable place instead of inline in the handler: we may only promise
 * immutability when the REQUEST URL provably names the bytes we are returning.
 *
 * Avatar.tsx appends the R2 key as `?k=`, and keys carry a Date.now() prefix
 * (`user/<id>/<ts>-<name>`), so a replaced avatar mints a new key and therefore
 * a new URL. The old URL is never requested again, which is why pinning it
 * cannot serve a stale face.
 *
 * When `k` is missing or does not match, the URL is NOT a unique name for the
 * object — freezing it would pin the wrong image — so it keeps the short TTL.
 */
export const AVATAR_CACHE_VERSIONED = "private, max-age=31536000, immutable";
export const AVATAR_CACHE_UNVERSIONED = "private, max-age=300";

export function avatarCacheControl(
  requestedKey: string | null | undefined,
  currentKey: string | null | undefined,
): string {
  // An absent current key cannot be matched by anything — guard explicitly so
  // two undefineds can never compare equal into the immutable branch.
  if (!currentKey || !requestedKey) return AVATAR_CACHE_UNVERSIONED;
  return requestedKey === currentKey
    ? AVATAR_CACHE_VERSIONED
    : AVATAR_CACHE_UNVERSIONED;
}
