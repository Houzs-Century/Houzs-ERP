/* The postcode written inside an address, found the way the backend finds it
   (backend/src/scm/lib/postcode-from-address.ts): a standalone five-digit
   number counts only when my_localities knows it, and two known ones in the
   same address are ambiguous, so none is taken. The DP forms use it to show
   the operator the postcode a supplier like HOOKKA keeps only in its address
   ("..., 47000 SUNGAI BULOH."), before the server fills the same value. */
import type { LocalityRow } from './localities-queries';

/** Which DP job types need a postcode: the shared rule, re-exported under the
 *  name the DP forms use. */
export { POSTCODE_REQUIRED_JOB_TYPES as DP_POSTCODE_REQUIRED_JOB_TYPES } from '../../shared/dp-postcode-rule';

export const postcodeCandidates = (...texts: ReadonlyArray<string | null | undefined>): string[] => {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').match(/(?<!\d)\d{5}(?!\d)/g) ?? []) out.add(m);
  return [...out];
};

/** The one known postcode in the texts, or null (none, or more than one). */
export const knownPostcodeInText = (
  rows: readonly LocalityRow[],
  texts: ReadonlyArray<string | null | undefined>,
): string | null => {
  const known = new Set(rows.map((r) => r.postcode));
  const hits = postcodeCandidates(...texts).filter((p) => known.has(p));
  return hits.length === 1 ? hits[0] : null;
};
