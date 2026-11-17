/* The bank side of a Merchant Recon confirm (owner 2026-11-17: 他应该和 merchant 一样
   我只要对一边). A confirm that leaves a report fully accounted for lets the bank's
   credit for it match itself on the server (accounting-bank
   applyMerchantAgreedMatches); the reply says what happened there. */

/** The bank credits matched by themselves, why any was left for a person, or
    that the bank side could not be read. */
export type BankFollows = { matched: number; jeNos: string[]; left: string[] } | { error: string };

/** The bank side of a confirm, said in a line — null when there is nothing to say. */
export const bankFollowsText = (b: BankFollows | undefined): string | null => {
  if (!b) return null;
  if ('error' in b) return `The bank side could not be checked (${b.error}). Match its credit on the bank screen.`;
  const said = [
    b.matched > 0 ? `The bank's credit for it matched itself${b.jeNos.length > 0 ? ` (${b.jeNos.join(', ')})` : ''}.` : null,
    b.left.length > 0 ? `Left for you on the bank screen: ${b.left.join('; ')}.` : null,
  ].filter(Boolean);
  return said.length > 0 ? said.join(' ') : null;
};
