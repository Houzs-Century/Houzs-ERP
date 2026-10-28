import { useProfilePicUrl } from "../lib/profilePicture";
import { cn } from "../lib/utils";

interface Props {
  userId: number | null | undefined;
  /** R2 key (or any truthy marker that the user has a picture). */
  hasImage?: boolean | string | null;
  name?: string | null;
  email?: string | null;
  size?: number;
  className?: string;
  /** Add a thin brass ring around the circle — used in podium / chips. */
  ring?: boolean;
  /** "circle" (default) or "square" (rounded-rect) — square is used by the
   *  departmental org chart, which mirrors a photo-ID card layout. */
  shape?: "circle" | "square";
}

function initialsFor(name?: string | null, email?: string | null): string {
  const src = (name || email || "").trim();
  if (!src) return "?";
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  userId,
  hasImage,
  name,
  email,
  size = 32,
  className,
  ring,
  shape = "circle",
}: Props) {
  const shapeCls = shape === "square" ? "rounded-md" : "rounded-full";
  /* The fetch + object-URL lifetime moved to `lib/profilePicture` so the mobile
     identity card reads the same photo through the same path. It also BINDS the
     failure reason, which this used to end with a bare `.catch(() => {})` — one
     of the sites `audit:swallowed-reads` counts. The render is unchanged: no
     photo still means initials. */
  const { src } = useProfilePicUrl(userId, hasImage);

  const dim = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  const ringCls = ring ? "ring-2 ring-accent/40 ring-offset-2 ring-offset-bg" : "";

  if (src) {
    return (
      <img
        src={src}
        alt={name || email || "User"}
        style={dim}
        className={cn(shapeCls, "object-cover shrink-0", ringCls, className)}
        loading="lazy"
      />
    );
  }
  return (
    <div
      style={dim}
      className={cn(
        shapeCls,
        "grid place-items-center bg-accent/15 text-accent font-semibold uppercase shrink-0 select-none",
        ringCls,
        className,
      )}
      aria-label={name || email || "User"}
    >
      {initialsFor(name, email)}
    </div>
  );
}
