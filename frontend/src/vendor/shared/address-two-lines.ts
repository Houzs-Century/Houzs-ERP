/* Every address form shows TWO lines, then Postcode / City / State (owner
   2026-11-18: "standardise the whole system like the Sales Order: two lines
   only"). The tables keep address3 / address4 — the account book's four-line
   format, prints and old imports still read them — so a record an old form or
   the cutover filled can still hold text there. A form must never hide it:
   Address line 2 SHOWS whatever lines 3 / 4 hold, and saving line 2 writes the
   whole of it to line 2 and clears 3 / 4.

   A line 3 / 4 that only repeats the record's own postcode, city or state
   ("11900 Bayan Lepas" beside Postcode 11900 / City Bayan Lepas) is not shown
   twice: those fields already say it.

   ONE rule, two copies: backend/src/scm/shared is the original and
   frontend/src/vendor/shared its byte-identical twin (check-shared-mirrors.mjs).
   The data fold (backend/scripts/fold-address-lines.mjs) reads it too. */

export type AddressTown = {
  postcode: string | null | undefined;
  city: string | null | undefined;
  state: string | null | undefined;
};

const tidy = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const words = (s: string | null | undefined): string[] =>
  tidy(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '');

/** True when the text says nothing the postcode / city / state do not already say. */
export function repeatsTown(line: string | null | undefined, town: AddressTown): boolean {
  const said = new Set([...words(town.postcode), ...words(town.city), ...words(town.state)]);
  return words(line).every((w) => said.has(w));
}

/** The text of lines 3 / 4 that a form has to show, in order. */
export function extraAddressText(
  line3: string | null | undefined,
  line4: string | null | undefined,
  town: AddressTown,
): string[] {
  return [tidy(line3), tidy(line4)].filter((l) => l !== '' && !repeatsTown(l, town));
}

/** What Address line 2 shows: line 2, then lines 3 / 4 (", " joined). With
 *  nothing in 3 / 4 it is line 2 exactly as stored, so the input being typed
 *  into keeps its trailing space. */
export function addressLineTwoView(
  line2: string | null | undefined,
  line3: string | null | undefined,
  line4: string | null | undefined,
  town: AddressTown,
): string {
  const extra = extraAddressText(line3, line4, town);
  if (extra.length === 0) return line2 ?? '';
  return [tidy(line2), ...extra].filter((l) => l !== '').join(', ');
}

/** True when a record still holds text in line 3 or 4 (shown or repeated). */
export const hasLegacyLines = (line3: string | null | undefined, line4: string | null | undefined): boolean =>
  tidy(line3) !== '' || tidy(line4) !== '';
