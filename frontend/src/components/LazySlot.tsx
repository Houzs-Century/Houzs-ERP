import { Suspense, type ReactNode } from "react";
import { ChunkReloadBoundary } from "./RouteFallback";

/**
 * The ONE way to mount a `React.lazy` component in this tree: a scoped crash
 * boundary with the `<Suspense>` INSIDE it.
 *
 * WHY IT EXISTS, and why `<Suspense>` on its own is a defect here
 * --------------------------------------------------------------
 * A lazy chunk that 404s after a deploy throws on the render Suspense resumes.
 * Whatever error boundary is nearest ABOVE that point is what the operator ends
 * up staring at. With no local boundary the nearest one is main.tsx's top-level
 * ChunkReloadBoundary, which takes no `resetKey` — so once its automatic ladder
 * is spent, its panel replaces the ENTIRE app (sidebar, tab bar, everything) and
 * no amount of navigating or tapping clears it. The only way out is the panel's
 * own Reload button.
 *
 * With a scoped boundary the blast radius is the slot: the shell survives, and
 * moving to another route/tab changes `resetKey`, which clears the crash.
 *
 * The Suspense sits INSIDE the boundary on purpose — a boundary nested within
 * the Suspense would never see the failure, because the throw happens on the
 * render that Suspense resumes.
 *
 * ENFORCED, not just recommended: src/components/lazySlotAudit.test.ts parses
 * EVERY .tsx under src/ and fails if any `<Suspense>` has no scoped-boundary
 * ancestor in the same file. That is the class-level gate — the previous pass
 * shipped a gate that read one hardcoded path (MobileApp.tsx) and reported green
 * while AuthGate.tsx mounted the whole mobile shell from a bare `<Suspense>`.
 *
 * Callers that already carry their own keyed boundary (App.tsx's
 * RouteCrashBoundary around the route table, MobileApp's MobileCrashBoundary)
 * do not need this wrapper as well; the audit accepts any boundary that is
 * scoped by a `resetKey`.
 */
export function LazySlot({
  resetKey,
  fallback,
  children,
}: {
  /** Anything that changes when the operator moves away from this slot — a
   *  pathname, a tab name, a document id, the gate's current screen. A crash
   *  clears when it changes, so this is what makes the slot escapable. */
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}) {
  return (
    <ChunkReloadBoundary resetKey={resetKey}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ChunkReloadBoundary>
  );
}
