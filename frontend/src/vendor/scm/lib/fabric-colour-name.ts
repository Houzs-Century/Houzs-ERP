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
      const rest = words.slice(i + 1).join(' ').replace(/^(?:-|:|#|\s)+/, '');
      const unwrapped = /^\((.*)\)$/.exec(rest)?.[1]?.trim() ?? rest;
      return unwrapped || null;
    }
    if (!code.startsWith(spelled)) break;
  }
  return text;
}

export const NO_COLOUR_NAME = 'no colour name';

export function fabricColourMeta(series: string, colourId: string, label: string | null | undefined): string {
  return [series, fabricColourName(colourId, label) ?? NO_COLOUR_NAME].filter(Boolean).join(' · ');
}
