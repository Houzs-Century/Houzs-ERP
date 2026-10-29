/* Copy as new (HC-0149): a PWP reward line is only valid with its single-use code
   (variants.pwp + variants.pwpCode). The code is USED on the source order, so copying
   the line makes the server refuse the whole save (409 pwp_code_rejected). A fresh
   line without a code would reprice at full price while keeping the PWP price here,
   so the reward line is left out of the copy; the operator re-applies PWP with a code. */
export const isPwpRewardLine = (it: { variants?: unknown }): boolean => {
  const v = (it.variants ?? {}) as { pwp?: unknown; pwpCode?: unknown };
  return Boolean(v.pwp) || String(v.pwpCode ?? '').trim() !== '';
};

export const withoutPwpRewardLines = <T extends { variants?: unknown }>(items: T[]): T[] =>
  items.filter((it) => !isPwpRewardLine(it));
