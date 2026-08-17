import { type ReactNode } from "react";
import { LazySlot } from "../components/LazySlot";

/**
 * Mobile's equivalent of the desktop RouteCrashBoundary, and it exists because
 * the desktop one cannot be reused: RouteCrashBoundary keys on
 * useLocation().pathname, and MobileApp deliberately keeps `tab`/`screen` OUT of
 * the URL, so on mobile that key never changes and a caught error would never
 * clear.
 *
 * Without a boundary here at all, a failed lazy screen import bubbles to the
 * top-level ChunkReloadBoundary in main.tsx, which has no resetKey — so once its
 * automatic recovery is spent, the panel replaces the WHOLE app, tab bar
 * included, and no amount of tapping brings it back. The operator's only way out
 * is the panel's own Reload button. Scoped here instead, the tab bar survives and
 * moving to another tab clears the crash, which is exactly what the desktop
 * shell has done since 2026-07-13 ("整个 system 都崩溃掉了").
 *
 * It is a thin naming layer over LazySlot, which owns the boundary/Suspense
 * pairing (including why the Suspense must sit INSIDE the boundary) for the
 * whole tree. Kept as its own name because the mobile shell's call sites read
 * better for it and its resetKey rule is specific: state, never the URL.
 */
export function MobileCrashBoundary({
  resetKey,
  fallback,
  children,
}: {
  /** Derived from MobileApp's own `tab`/`screen` state, never from the URL. */
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}) {
  return (
    <LazySlot resetKey={resetKey} fallback={fallback}>
      {children}
    </LazySlot>
  );
}
