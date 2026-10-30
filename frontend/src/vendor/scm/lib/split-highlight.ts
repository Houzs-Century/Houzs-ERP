// split-highlight — split a display string into matched / unmatched segments so
// a search picker can wrap the matched text in a <mark>. Case-insensitive, every
// occurrence; the query matches literally (indexOf, so no regex escaping). Pure,
// so it is unit-tested without a DOM.

export type HighlightSegment = { text: string; hit: boolean };

export function splitHighlight(text: string, query: string): HighlightSegment[] {
  if (!text) return [];
  const q = query.trim();
  if (!q) return [{ text, hit: false }];
  const lowText = text.toLowerCase();
  const lowQ = q.toLowerCase();
  const out: HighlightSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const at = lowText.indexOf(lowQ, i);
    if (at < 0) {
      out.push({ text: text.slice(i), hit: false });
      break;
    }
    if (at > i) out.push({ text: text.slice(i, at), hit: false });
    out.push({ text: text.slice(at, at + lowQ.length), hit: true });
    i = at + lowQ.length;
  }
  return out;
}
