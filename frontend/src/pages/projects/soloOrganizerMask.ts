// The project label a Sales Order shows — with a solo roadshow's organizer
// (the mall management) masked for everyone outside the BD tier.
//
// Owner 2026-09-18, on the New Sales Order panel showing
// "2026-09-REX-KL-MID-VALLEY-AKEMI · Kuala Lumpur [AKEMI] REX @ MID VALLEY":
//   "for exhibition okay can see organizer but solo roadshow dont mention mall
//    mgt or name organizer change to 'solo'"
//   "mgt mall or name organizer for solo roadshow give permission to BD, owner,
//    weisiang only can see, others only show solo"
//
// WHY THE NAME CARRIES IT AT ALL. Since 2026-08-17 a solo event's stored name
// fills the organizer slot with the picked organizer (projectHelpers
// composeDefaultProjectName: "SOLO" appears only when none is chosen), so the
// calendar and the Excel agree. The stored name is NOT changed here — this is
// what one screen prints.
//
// THE CODE IS DROPPED, NOT REWRITTEN, in the masked label: on the live database
// 2026-09-18, 45 of 284 solo projects have a code without "-SOLO-" (older codes
// carry the organizer slug), and a half-masked label is worse than a short one.
//
// PURE on purpose — the caller passes `canSeeOrganizer`
// (auth/salesAccess.canSeeSoloOrganizer) so this is testable with no auth mock.

export interface SoloMaskProject {
  code?: string | null;
  name: string;
  organizer?: string | null;
  venue?: string | null;
  event_type_name?: string | null;
  event_type_slug?: string | null;
}

export const SOLO_ORGANIZER_MASK = "SOLO";

/** Solo roadshow? Slug first (the stable key), name as the fallback — the
 *  project LIST and DETAIL payloads carry `event_type_name`, not the slug. */
export const isSoloEvent = (p: Pick<SoloMaskProject, "event_type_name" | "event_type_slug">): boolean =>
  /^solo\b/i.test((p.event_type_slug || p.event_type_name || "").trim());

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "STATE [BRAND] <organizer> @ VENUE" -> "STATE [BRAND] SOLO @ VENUE".
 *  Three tries, most structural first, and NEVER the unmasked name back:
 *    1. the title shape — 283 of 284 live solo names match it, including the
 *       192 whose `organizer` column is empty while the name still has a slot;
 *    2. the organizer string itself, wherever it sits;
 *    3. "SOLO @ venue" — a name of some other shape cannot be trusted to hide
 *       anything, so it is replaced rather than passed through. */
export function maskSoloOrganizer(p: SoloMaskProject): string {
  const name = (p.name || "").trim();
  const shaped = /^(.*?\]\s*)(.+?)(\s+@\s+.*)$/.exec(name);
  if (shaped) return `${shaped[1]}${SOLO_ORGANIZER_MASK}${shaped[3]}`;
  const organizer = (p.organizer || "").trim();
  if (organizer && name.toLowerCase().includes(organizer.toLowerCase())) {
    return name.replace(new RegExp(escapeRe(organizer), "ig"), SOLO_ORGANIZER_MASK);
  }
  const venue = (p.venue || "").trim();
  return venue ? `${SOLO_ORGANIZER_MASK} @ ${venue}` : SOLO_ORGANIZER_MASK;
}

/** The project's NAME as this viewer may read it. Exhibitions are untouched.
 *  Owner 2026-09-18 (second ask, on the project page header reading
 *  "Selangor [ZANOTTI] KAI HAO (KL, CHEN) @ AEON BIG PUCHONG"): "title inside
 *  project also ... other user only show solo for all solo roadshow" — so the
 *  same rule now labels the project page and the project list, not only the
 *  Sales Order panel. */
export const shownProjectName = (p: SoloMaskProject, canSeeOrganizer: boolean): string =>
  (isSoloEvent(p) && !canSeeOrganizer ? maskSoloOrganizer(p) : p.name);

/** The ORGANIZER field as this viewer may read it: SOLO on a masked solo event. */
export const shownOrganizer = (p: SoloMaskProject, canSeeOrganizer: boolean): string | null =>
  (isSoloEvent(p) && !canSeeOrganizer ? SOLO_ORGANIZER_MASK : (p.organizer ?? null));

/** True when this viewer reads this project masked — the edit form uses it to
 *  hold the Name and Organizer fields read-only, so a masked value is never
 *  typed over the stored one. */
export const isSoloMasked = (p: SoloMaskProject, canSeeOrganizer: boolean): boolean =>
  isSoloEvent(p) && !canSeeOrganizer;

/** The Sales Order picker's option text — the same rule under its first name. */
export const salesOrderProjectName = shownProjectName;

/** The locked "Project" field of the Sales Order panel: "code · name", or the
 *  masked name alone (see the header for why the code goes). */
export function salesOrderProjectLabel(p: SoloMaskProject, canSeeOrganizer: boolean): string {
  if (isSoloEvent(p) && !canSeeOrganizer) return maskSoloOrganizer(p);
  return p.code ? `${p.code} · ${p.name}` : p.name;
}
