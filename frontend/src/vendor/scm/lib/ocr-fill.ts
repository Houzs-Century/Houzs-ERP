/* What the bill reader FILLS goes in upper case (owner 2026-09-08: 帮我 fill
   data 时默认全部大写 — his own typing is left alone: 打字不需要先). One home
   for every form the reader pre-fills — the voucher and the AP invoice — so
   the two never disagree on it. Null and blank stay what they are; a name the
   operator saved before (vendor memory) is not the reader's and keeps its
   casing at the caller. */
export const upperFill = (s: string | null | undefined): string | null => {
  const t = String(s ?? '').trim();
  return t === '' ? null : t.toUpperCase();
};
