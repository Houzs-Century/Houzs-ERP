import { lazy, Suspense } from "react";
import { useLocation } from "react-router-dom";

const HighlightFromUrl = lazy(() => import("./HighlightFromUrl").then((m) => ({ default: m.HighlightFromUrl })));

/** Loads the ?highlight= helper only when the URL asks for it, so it costs nothing on every other page load. */
export function HighlightSlot() {
  const { search } = useLocation();
  if (!search.includes("highlight=")) return null;
  return (
    <Suspense fallback={null}>
      <HighlightFromUrl />
    </Suspense>
  );
}
