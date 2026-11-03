/* The colour NAME a fabric picker shows under the code.

   fabric_colours.label is not one shape. The Fabric Tracking mirror stores the
   words after the code ("NICCA-04 OLIVE" -> "OLIVE") and falls back to the code
   itself when the description has no name; repair scripts inserted labels that
   repeat the code ("NICCA-02 OAT GLOW", "GD2502#14 SILVER"). Listed together
   the pickers read "NICCA · OLIVE", "NICCA · NICCA-07", "NICCA · NICCA-02 OAT
   GLOW" - the code twice on some rows and no name on others.

   So the code is stripped off the front when the leading words spell it
   (punctuation ignored), and a label that is only the code returns null: the
   colour has no name yet, and the place to give it one is its Fabric Tracking
   description. */
const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function fabricColourName(colourId: string, label: string | null | undefined): string | null {
  const text = (label ?? '').trim();
  const code = alnum(colourId);
  if (!text || !code) return text || null;
  if (alnum(text) === code) return null;

  const words = text.split(/\s+/);
  let spelled = '';
  for (let i = 0; i < words.length - 1; i++) {
    spelled += alnum(words[i]!);
    if (spelled === code) {
      const rest = words.slice(i + 1).join(' ').replace(/^[-:#\s]+/, '');
      const unwrapped = /^\((.*)\)$/.exec(rest)?.[1]?.trim() ?? rest;
      return unwrapped || null;
    }
    if (!code.startsWith(spelled)) break;
  }
  return text;
}

export const NO_COLOUR_NAME = 'no colour name';

/* "SERIES · NAME" for the picker's second line; a nameless colour says so
   rather than repeating the code the first line already shows. */
export function fabricColourMeta(series: string, colourId: string, label: string | null | undefined): string {
  return [series, fabricColourName(colourId, label) ?? NO_COLOUR_NAME].filter(Boolean).join(' · ');
}
