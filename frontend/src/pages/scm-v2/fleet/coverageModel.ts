// Coverage & Fleet, Residence rules / Regions / Places (owner 2026-11-07): the pure rules
// behind the cards, so the screens only render.
import type { StateRegions } from "../../../vendor/scm/lib/delivery-planning-regions-queries";
import type { SavedLocationRow } from "../../../vendor/scm/lib/saved-locations-queries";

/** A residence rule's delivery window in words; a blank side means no limit. */
export function windowLabel(earliest: string | null, latest: string | null): string {
  if (!earliest && !latest) return "Any time";
  if (earliest && latest) return `${earliest} to ${latest}`;
  return earliest ? `From ${earliest}` : `Until ${latest}`;
}

/* Spelling variants of one state collapse to one label, so a region's areas read cleanly. */
const AREA_LABEL: Record<string, string> = {
  "kuala lumpur": "Kuala Lumpur", "wp kuala lumpur": "Kuala Lumpur", "w p kuala lumpur": "Kuala Lumpur",
  "pulau pinang": "Penang", penang: "Penang",
  melaka: "Melaka", malacca: "Melaka",
  labuan: "Labuan", "wp labuan": "Labuan", "w p labuan": "Labuan",
};
const prettyArea = (s: string): string => AREA_LABEL[s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim()] ?? s;

/** Which states fall under each region code, from the live state-to-region mapping. */
export function areasByRegionCode(states: readonly StateRegions[]): Record<string, string[]> {
  const byCode: Record<string, Set<string>> = {};
  for (const s of states) for (const code of s.regionCodes) (byCode[code] ??= new Set<string>()).add(prettyArea(s.stateKey));
  return Object.fromEntries(Object.entries(byCode).map(([code, set]) => [code, [...set].sort()]));
}

/** A saved location's address on one line. */
export const placeAddress = (r: Pick<SavedLocationRow, "address1" | "address2" | "city" | "postcode" | "state">): string =>
  [r.address1, r.address2, [r.postcode, r.city].filter(Boolean).join(" "), r.state].filter(Boolean).join(", ");

/** A case-blind search over some words. */
export const hit = (q: string, ...words: Array<string | null | undefined>): boolean => {
  const s = q.trim().toLowerCase();
  return !s || words.join(" ").toLowerCase().includes(s);
};
