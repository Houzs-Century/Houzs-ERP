/* A master address (supplier, warehouse, 3PL company, project venue) must carry
   a postcode when it is in Malaysia or Singapore (owner 2026-11-19: 主档
   Postcode 改必填). The postcode fills City and State and is what Last Mile and
   the driver pay read; a foreign supplier is skipped (owner: 国外的就算了吧).
   ONE rule, two copies: backend/src/scm/shared is the original and
   frontend/src/vendor/shared its byte-identical twin (check-shared-mirrors.mjs). */

/** Blank country = Malaysia (every form defaults to it). */
export function masterNeedsPostcode(country: string | null | undefined): boolean {
  const c = (country ?? '').trim().toLowerCase();
  return c === '' || c === 'malaysia' || c === 'my' || c === 'singapore' || c === 'sg';
}

/** The refusal a form and a route both show. */
export const MASTER_POSTCODE_MESSAGE = 'Postcode is required for an address in Malaysia or Singapore.';

/** Null when the postcode may be saved, else the message. `postcode` is the
 *  value the row will hold after the save. */
export function masterPostcodeError(country: string | null | undefined, postcode: string | null | undefined): string | null {
  if (!masterNeedsPostcode(country)) return null;
  return (postcode ?? '').trim() === '' ? MASTER_POSTCODE_MESSAGE : null;
}
