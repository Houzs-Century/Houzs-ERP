
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
