import { useEffect, useState } from "react";

/**
 * True below the `sm` breakpoint. The one source of "is this a phone" for the
 * table components — DataTable renders cards instead of a grid, and the columns
 * drawer becomes a bottom sheet, so both must agree on the same pixel.
 *
 * Extracted from DataTable so the drawer can read it without importing the
 * table (which imports the drawer — a cycle).
 */
export const SMALL_VIEWPORT_QUERY = "(max-width: 639px)";

export function readSmallViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.(SMALL_VIEWPORT_QUERY).matches ?? window.innerWidth < 640;
}

export function useSmallViewport(): boolean {
  const [small, setSmall] = useState(readSmallViewport);

  useEffect(() => {
    const media = window.matchMedia?.(SMALL_VIEWPORT_QUERY);
    const update = () => setSmall(media?.matches ?? window.innerWidth < 640);
    update();

    if (media?.addEventListener) {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }

    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return small;
}
