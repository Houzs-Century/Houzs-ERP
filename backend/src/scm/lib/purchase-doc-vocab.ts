/* Vocabulary shared by the two purchase documents — the Purchase Order
 * (`routes/mfg-purchase-orders.ts`) and the Purchase Consignment Order
 * (`routes/purchase-consignment-orders.ts`).
 *
 * WHY ONLY TWO OF THE THREE SETS ARE HERE. Both routers declared three
 * same-named constants: `VALID_CURRENCIES`, `VALID_KINDS` and `VALID_STATUSES`.
 * The first two were IDENTICAL. The third is not, and never was:
 *
 *     PO  : DRAFT, SUBMITTED, PARTIALLY_RECEIVED, RECEIVED, CANCELLED
 *     PCO :        SUBMITTED, PARTIALLY_RECEIVED, RECEIVED, CANCELLED
 *
 * A PCO has no draft state. That difference is deliberate and neither file said
 * so — it sat between two constants that WERE copies, under the same name, which
 * is the arrangement that makes a real difference read as an oversight (and an
 * oversight read as a real difference).
 *
 * So `VALID_STATUSES` stays LOCAL to each router, with a comment naming the
 * other, and `backend/tests/purchaseDocVocab.test.ts` asserts the two sets
 * differ by exactly `DRAFT`. Harmonising them fails that test rather than
 * quietly giving a PCO a draft state or taking the PO's away.
 */

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
