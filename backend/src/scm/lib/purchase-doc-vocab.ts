
/** Currencies a purchase document may be raised in.
 *
 * CNY joined the set on 2026-09-07 (migration 20260907T2330). It is the same
 * currency as the pre-existing RMB under its ISO 4217 code, and it is here
 * because the AutoCount book states CNY on 22 of its 9,408 purchase orders and
 * the migrated one (`HC-PO-009335`) must be able to say so. Without this entry
 * the PO create/patch route answers `invalid_currency` (400) on its own
 * migrated row, so a repaired document could not afterwards be edited.
 *
 * Both codes are accepted rather than one being translated into the other: the
 * migration copies the book's value and never computes one. */
export const VALID_CURRENCIES: ReadonlySet<string> = new Set(['MYR', 'RMB', 'CNY', 'USD', 'SGD']);

/** What a purchase line may be FOR. `mfg_product` is a catalog SKU; `fabric` is
 *  a fabric series; `raw` is an uncatalogued raw material bought by description. */
export const VALID_KINDS: ReadonlySet<string> = new Set(['mfg_product', 'fabric', 'raw']);
