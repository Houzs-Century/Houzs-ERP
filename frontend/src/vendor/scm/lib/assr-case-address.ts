// A service case's address in the Sales Order's shape (owner 2026-11-17):
// address lines (assr_cases.addr1..addr4) + Postcode + City + State
// (public.assr_case_address, 1:1). ONE reader for every surface that prints it
// (case detail, My Cases, the printable, the crew job, the trip stop Last Mile
// shows, Delivery Planning), so they agree.
//
// Old cases hold the whole address in the lines ("1-G-9 Halaman Teratai /
// lebuh nipah 2 / 11900 Bayan Lepas") and may later gain a postcode / city /
// state too: a part the lines already name is NOT printed a second time.
//
// Byte-identical twin: frontend/src/vendor/scm/lib/assr-case-address.ts
// (assr-case-address.canonical.test.ts). No imports, so the two stay one file.

export const CASE_ADDRESS_KEYS = ['postcode', 'city', 'state'] as const;
export type CaseAddressKey = (typeof CASE_ADDRESS_KEYS)[number];

const MAX_LEN: Record<CaseAddressKey, number> = { postcode: 10, city: 80, state: 80 };
const LABEL: Record<CaseAddressKey, string> = { postcode: 'Postcode', city: 'City', state: 'State' };

export interface CaseAddressParts {
  addr1?: unknown;
  addr2?: unknown;
  addr3?: unknown;
  addr4?: unknown;
  postcode?: unknown;
  city?: unknown;
  state?: unknown;
}

const tidy = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s : null;
};

/** The refusal sentence for a PATCH / create body's postcode / city / state, or
 *  null when they are fine (absent, null, or short text). */
export function caseAddressError(body: Record<string, unknown>): string | null {
  for (const k of CASE_ADDRESS_KEYS) {
    if (!(k in body) || body[k] == null) continue;
    if (typeof body[k] !== 'string') return `${LABEL[k]} must be text.`;
    if ((body[k] as string).trim().length > MAX_LEN[k]) return `${LABEL[k]} is longer than ${MAX_LEN[k]} characters.`;
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = (text: string, part: string) =>
  new RegExp(`(^|[^A-Za-z0-9])${escapeRe(part)}($|[^A-Za-z0-9])`, 'i').test(text);

/** The address as printed lines, SO order: the street lines, then
 *  "<postcode> <city>", then the state. A postcode, city or state the street
 *  lines already carry is left out, so an old case never shows it twice. */
export function caseAddressLines(a: CaseAddressParts): string[] {
  const street = [a.addr1, a.addr2, a.addr3, a.addr4].map(tidy).filter((l): l is string => l != null);
  const text = street.join(' , ');
  const postcode = tidy(a.postcode);
  const city = tidy(a.city);
  const state = tidy(a.state);
  const town = [postcode && !names(text, postcode) ? postcode : null, city && !names(text, city) ? city : null]
    .filter(Boolean)
    .join(' ');
  const out = [...street];
  if (town) out.push(town);
  if (state && !names(`${text} , ${town}`, state)) out.push(state);
  return out;
}

/** caseAddressLines on one line, comma separated; null when there is nothing. */
export function formatCaseAddress(a: CaseAddressParts): string | null {
  const lines = caseAddressLines(a);
  return lines.length ? lines.join(', ') : null;
}

/** caseAddressLines in the four address cells a sheet / the account book has:
 *  past four lines the middle ones share line 3, so the state stays on line 4. */
export function caseAddressFourLines(a: CaseAddressParts): [string | null, string | null, string | null, string | null] {
  const l = caseAddressLines(a);
  const packed = l.length > 4 ? [l[0], l[1], l.slice(2, -1).join(', '), l[l.length - 1]] : l;
  return [packed[0] ?? null, packed[1] ?? null, packed[2] ?? null, packed[3] ?? null];
}

/** The first 5-6 digit run in the street lines: the postcode an old case's
 *  free text names ("11900 Bayan Lepas"), or null. */
export function postcodeInLines(a: Pick<CaseAddressParts, 'addr1' | 'addr2' | 'addr3' | 'addr4'>): string | null {
  for (const l of [a.addr1, a.addr2, a.addr3, a.addr4]) {
    const m = (tidy(l) ?? '').match(/\b\d{5,6}\b/);
    if (m) return m[0];
  }
  return null;
}
