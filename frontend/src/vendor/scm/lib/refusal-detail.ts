import { normaliseTypographicQuotes } from '../../../../../shared/src/vendor/shared/mfg-pricing';

const FIELD_LABEL: Record<string, string | undefined> = {
  fabric:       'Fabric',
  gap:          'Gap',
  divan_height: 'Divan Height',
  leg_height:   'Leg Height',
  seat_size:    'Seat Size',
  total_height: 'Total Height',
  size_code:    'Size',
  compartment:  'Compartment',
  specials:     'Special Order',
};

const FROM_THE_ITEM_CODE: Record<string, string | undefined> = {
  size_code:   'the item code',
  compartment: 'the item code and the sofa build',
};

const MAX_LISTED = 20;

const readOut = (values: string[]): string => {
  const shown = values.slice(0, MAX_LISTED);
  const tail = values.length - shown.length;
  const joined = shown.length <= 1
    ? (shown[0] ?? '')
    : `${shown.slice(0, -1).join(', ')} or ${shown[shown.length - 1]}`;
  return tail > 0 ? `${joined} (and ${tail} more)` : joined;
};

const forDisplay = (values: string[]): string[] => {
  const out: string[] = [];
  for (const v of values) {
    const folded = normaliseTypographicQuotes(String(v)).trim();
    if (folded && !out.includes(folded)) out.push(folded);
  }
  return out;
};

type RefusalBody = {
  field?:   unknown;
  value?:   unknown;
  allowed?: unknown;
  derivedFrom?: unknown;
};

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const strArray = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [];

/** Compose the operator's sentence, or null when the body cannot be said
 *  honestly — in which case the caller keeps its existing generic message.
 *
 *  Returns null when there is no `field`+`value` pair or no non-empty pool.
 *  That exclusion is deliberate rather than lazy: `invalid_variant_key` ships
 *  `{key, allowed}` where `allowed` is a list of camelCase WIRE KEYS, and
 *  reading those out to a salesperson breaks the same rule this file exists to
 *  keep. A refusal that names only a set, without naming what was rejected,
 *  cannot be turned into a sentence — so it stays generic. */
export function describeRefusal(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as RefusalBody;

  const field = str(body.field);
  const value = normaliseTypographicQuotes(str(body.value)).trim();
  const allowed = forDisplay(strArray(body.allowed));
  if (!field || !value || allowed.length === 0) return null;

  const label = FIELD_LABEL[field] ?? null;
  const list = readOut(allowed);

  const parts = Array.isArray(body.derivedFrom)
    ? (body.derivedFrom as unknown[])
        .filter((p): p is { field?: unknown; value?: unknown } => !!p && typeof p === 'object')
        .map((p) => ({
          label: FIELD_LABEL[str(p.field)] ?? null,
          value: normaliseTypographicQuotes(str(p.value)).trim(),
        }))
        .filter((p) => p.label !== null) as Array<{ label: string; value: string }>
    : null;

  if (parts && parts.length > 0 && label) {
    const names = readOut(parts.map((p) => p.label));
    const filled = parts.filter((p) => p.value);
    const sum = filled.length > 0
      ? ` (${filled.map((p) => `${p.label} ${p.value}`).join(' + ')})`
      : '';
    return (
      `${label} works out to ${value}${sum}, which this model doesn't offer. `
      + `There is no ${label} box on the line — change ${names} `
      + `so they add up to one of ${list}.`
    );
  }

  const source = FROM_THE_ITEM_CODE[field];
  if (source && label) {
    return (
      `This item is ${label} ${value}, which this model doesn't offer. `
      + `${label} comes from ${source}, not a box on the line — pick a different item. `
      + `This model offers ${list}.`
    );
  }

  if (label) {
    return `${label} ${value} isn't offered on this model. Pick one of ${list}.`;
  }

  return `${value} isn't one of the values this model offers. Pick one of ${list}.`;
}
