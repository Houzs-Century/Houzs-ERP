/* Does a sales-order line edit keep the cost the line carries?

   Owner 2026-11-20: an order costs the prices of its ORDER DATE, piece price
   and set price alike; only a later change to the product that moves its cost
   is costed at the change day. A new colour or fabric, the other side (LHF /
   RHF), a new selling price, discount or quantity are not such a change, so
   the line keeps its cost (a set price share included) instead of being
   re-costed at today's product cost, which differs once a cost has moved
   since the order (2990 raised its sofa costs on 2026-09-25).

   Anything else (another piece or model, a seat height, a leg, a paid option)
   is a product change: the caller re-costs the line at today's cost. A line
   carrying no cost is never "kept": it takes a cost like any new line.

   Both sides are compared after canonicalizeVariants, so `depth` and
   `seatHeight` for one height are the same thing. */

const isColourKey = (key: string): boolean => /^(fabric|colou?r)/i.test(key);

/** LHF and RHF are the two sides of one piece at one price. */
const sideless = (code: string): string => code.trim().toUpperCase().replace(/LHF|RHF/g, 'SIDE');

const canon = (v: unknown): string => {
  if (v == null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort()
    .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
};

export interface CostedLineShape {
  itemCode: string;
  /** canonicalizeVariants output */
  variants: Record<string, unknown>;
  unitCostSen: number;
}

export function lineEditKeepsCost(before: CostedLineShape, after: Omit<CostedLineShape, 'unitCostSen'>): boolean {
  if (!(Number(before.unitCostSen) > 0)) return false;
  if (sideless(before.itemCode) !== sideless(after.itemCode)) return false;
  const keys = new Set([...Object.keys(before.variants), ...Object.keys(after.variants)]);
  for (const key of keys) {
    if (isColourKey(key)) continue;
    if (canon(before.variants[key]) !== canon(after.variants[key])) return false;
  }
  return true;
}
