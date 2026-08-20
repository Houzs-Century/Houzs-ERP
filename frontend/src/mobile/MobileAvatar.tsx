import { useRef } from "react";
import { useProfilePicUrl, useProfilePicture } from "../lib/profilePicture";
import { useToast } from "../hooks/useToast";

/* ---------------------------------------------------------------------------
 * MobileAvatar — the phone's profile photo, read and write.
 *
 * The desktop `components/Avatar` cannot simply be dropped in here: it is a
 * Tailwind component and the mobile shell is inline-styled `mobile.css`, and the
 * identity card's circle is a specific 58px teal/gold token. What MUST be shared
 * is the DATA path, not the paint — so both surfaces call `useProfilePicUrl` /
 * `useProfilePicture` from `lib/profilePicture.ts` and neither owns a second
 * copy of the endpoint, the compression settings, or the size limit.
 *
 * Two components, because the two gaps are separate:
 *   · MobileAvatar     — DISPLAY. Any user, photo or initials. Used by the
 *     identity card and the team roster, both of which drew initials
 *     unconditionally before, so a photo uploaded from a PC was invisible here.
 *   · MobileAvatarEditor — WRITE. The identity card's camera badge: a file input
 *     with `capture` so the phone offers its camera, plus Remove.
 * ------------------------------------------------------------------------- */

/** Same rule as the desktop `Avatar`: first + last initial, or the first two. */
export function avatarInitials(name?: string | null, email?: string | null): string {
  const src = (name || email || "").trim();
  if (!src) return "?";
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function MobileAvatar({
  userId, hasImage, name, email, size = 58, style,
}: {
  userId: number | string | null | undefined;
  /** The R2 key, or any truthy marker that this user has a photo. */
  hasImage?: boolean | string | null;
  name?: string | null;
  email?: string | null;
  size?: number;
  style?: React.CSSProperties;
}) {
  const { src } = useProfilePicUrl(userId, hasImage);
  const base: React.CSSProperties = {
    width: size, height: size, flex: "none", borderRadius: "50%", ...style,
  };

  // A failed photo read renders as initials — the honest fallback for a
  // decoration. `useProfilePicUrl` binds the reason rather than discarding it;
  // nothing here needs to say it out loud.
  if (src) {
    return (
      <img
        src={src}
        alt={name || email || "User"}
        style={{ ...base, objectFit: "cover" }}
        loading="lazy"
      />
    );
  }
  return (
    <span
      aria-label={name || email || "User"}
      style={{
        ...base,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: Math.round(size * 0.34), fontWeight: 800,
      }}
    >
      {avatarInitials(name, email)}
    </span>
  );
}

/**
 * The camera badge on the identity card. `onChanged` is the auth reload — the
 * new R2 key has to land on `user` or the circle keeps the old blob.
 */
export function MobileAvatarEditor({
  hasImage, onChanged,
}: {
  hasImage?: boolean | string | null;
  onChanged: () => Promise<void> | void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pic = useProfilePicture(onChanged);
  const toast = useToast();

  const run = async (fn: () => Promise<string | null>, ok: string) => {
    const err = await fn();
    if (err) toast.error(err);
    else toast.success(ok);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={pic.busy}
        aria-label="Change profile photo"
        style={{
          position: "absolute", right: -2, bottom: -2, width: 24, height: 24,
          borderRadius: "50%", border: "2px solid #15161a", background: "#d8a85a",
          color: "#15161a", display: "flex", alignItems: "center", justifyContent: "center",
          padding: 0, cursor: pic.busy ? "default" : "pointer", opacity: pic.busy ? 0.6 : 1,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        /* The phone's own camera, not just the gallery — the whole point of
           putting this on the device that has one. */
        capture="user"
        aria-label="Profile photo"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(() => pic.upload(f), "Profile picture updated");
        }}
      />
      {hasImage && !pic.busy && (
        <button
          type="button"
          onClick={() => void run(pic.remove, "Profile picture removed")}
          style={{
            position: "absolute", left: 0, bottom: -22, width: "100%", background: "none",
            border: "none", padding: 0, fontSize: 10, fontWeight: 700, color: "#d8a85a",
            fontFamily: "inherit", cursor: "pointer",
          }}
        >
          Remove
        </button>
      )}
    </>
  );
}
