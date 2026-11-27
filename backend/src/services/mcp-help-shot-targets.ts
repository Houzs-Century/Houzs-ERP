import { HOWTO_GUIDES } from "./mcp-howto-guides";
import { SCREENS } from "./mcp-screen-map";

/** One page to photograph and the labels to box on it. */
export type HelpShotTarget = { page: string; labels: string[] };

/** Every linkable page of the screen map and of the how-to steps, with its labels (guide highlights first). */
export function helpShotTargets(): HelpShotTarget[] {
  const byPage = new Map<string, Set<string>>();
  const add = (page: string, label: string | null) => {
    if (page.includes(":")) return;
    const set = byPage.get(page) ?? new Set<string>();
    if (label) set.add(label);
    byPage.set(page, set);
  };
  for (const g of HOWTO_GUIDES) for (const s of g.steps) if (s.page) add(s.page, s.highlight);
  for (const s of SCREENS) {
    add(s.path, null);
    for (const a of s.actions) add(s.path, a.label);
    for (const t of s.tabs) add(s.path, t);
  }
  return [...byPage.entries()].map(([page, labels]) => ({ page, labels: [...labels] })).filter((t) => t.labels.length);
}
