import { useLocation } from "react-router-dom";
import { lazyPage } from "../lib/lazyPage";
import { LazySlot } from "./LazySlot";

const HighlightFromUrl = lazyPage(() => import("./HighlightFromUrl").then((m) => ({ default: m.HighlightFromUrl })));

/** Loads the ?highlight= helper only when the URL asks for it, so it costs nothing on every other page load. */
export function HighlightSlot() {
  const { search } = useLocation();
  if (!search.includes("highlight=")) return null;
  return (
    <LazySlot resetKey="highlight" fallback={null}>
      <HighlightFromUrl />
    </LazySlot>
  );
}
