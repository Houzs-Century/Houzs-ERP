/**
 * An address line for display, with each fact once. A feed address is the job's
 * own lines followed by its City, Postcode and State; when the lines already
 * carry those (a typed "47000 SUNGAI BULOH"), the Last Mile drawer showed
 * "…, 47000 SUNGAI BULOH., Sungai Buloh, 47000, Selangor".
 *
 * Rules: split on commas, drop empty parts (the ",," a blank line leaves), drop a
 * part whose text already appears, as whole words, in the parts kept before it,
 * and trim a trailing period off every part but the last. Display only: what is
 * stored is never rewritten.
 */
export function addressOnce(address: string | null | undefined): string {
  if (!address) return '';
  const parts = address.split(',').map((p) => p.trim()).filter((p) => p !== '');
  const kept: string[] = [];
  for (const part of parts) {
    const needle = norm(part.replace(/\.+$/, ''));
    if (needle && kept.length > 0 && containsWords(norm(kept.join(' ')), needle)) continue;
    kept.push(part);
  }
  return kept.map((p, i) => (i < kept.length - 1 ? p.replace(/\.+$/, '') : p)).join(', ');
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const containsWords = (haystack: string, needle: string) =>
  ` ${haystack} `.includes(` ${needle} `);
