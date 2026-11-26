export function zeroPriceClaim(
  unitPriceSen: number,
  authored: boolean,
): { zeroPriceIntended?: true } {
  return unitPriceSen === 0 && authored ? { zeroPriceIntended: true } : {};
}

/* HC-0095: is the text in a price box an AUTHORED price? A blank (or "-", ".")
 * box is mid-edit, not a typed 0: `Number('')` is 0, and reading it as authored
 * claimed RM 0 on the line, so an emptied box billed the line RM 0. A typed
 * "0" / "0.00" is still authored. */
export const priceBoxAuthored = (text: string): boolean => {
  const t = text.replace(/,/g, '').trim();
  return t !== '' && Number.isFinite(Number(t));
};

/* HC-0198: a blank / untyped Unit Price is "no price", so the server saves the
 * catalogue base PLUS the director-set variant surcharges (divan, leg, specials).
 * A typed 0 (`authored`) saves RM 0 and a typed price is never topped up. Sofas
 * are priced from their modules server-side, so the client cannot preview them.
 * The editor adds this to the line total so the screen shows what will be saved. */
export const unpricedExtraSen = (
  unitPriceSen: number,
  authored: boolean,
  extraSen: number,
  isSofa: boolean,
): number => (unitPriceSen === 0 && !authored && !isSofa ? extraSen : 0);
