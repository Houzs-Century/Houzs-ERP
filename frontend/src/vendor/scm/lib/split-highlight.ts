
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
