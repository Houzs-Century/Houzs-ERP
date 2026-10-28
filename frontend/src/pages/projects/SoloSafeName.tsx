// The React edge of soloOrganizerMask.ts — a hook and a text component, so a
// render site can print a project's name without threading the viewer through
// props. Projects.tsx and MobilePMS.tsx both sit at their file-size ceilings;
// `{r.name}` -> `<SoloSafeName p={r} />` is an in-place swap.
import { useAuth } from "../../auth/AuthContext";
import { canSeeSoloOrganizer } from "../../auth/salesAccess";
import { shownProjectName, type SoloMaskProject } from "./soloOrganizerMask";

// Re-exported so a file at its size ceiling (MobilePMS.tsx) reaches the whole
// solo-mask surface through ONE import statement.
export {
  shownProjectName,
  shownOrganizer,
  isSoloMasked,
  maskSoloOrganizer,
  SOLO_ORGANIZER_MASK,
  type SoloMaskProject,
} from "./soloOrganizerMask";

/** May the signed-in viewer read a solo roadshow's organizer? */
export function useCanSeeSoloOrganizer(): boolean {
  return canSeeSoloOrganizer(useAuth().user);
}

/** A project's name as the signed-in viewer may read it. `format` is for a
 *  site that restyles the text (the mobile header title-cases it) — it runs
 *  AFTER the mask, so it can never restyle the organizer back in. */
export function SoloSafeName({
  p,
  format,
  fallback = "—",
}: {
  p: SoloMaskProject | null | undefined;
  format?: (name: string) => string;
  fallback?: string;
}) {
  const canSee = useCanSeeSoloOrganizer();
  if (!p?.name) return <>{fallback}</>;
  const name = shownProjectName(p, canSee);
  return <>{format ? format(name) : name}</>;
}
