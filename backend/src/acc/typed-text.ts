// ----------------------------------------------------------------------------
// typed-text — what a person types into a Finance document is kept in UPPER CASE
// (owner 2026-11-09: 「可以默认区别自动大写吗？不然感觉有些大写，有些小写，主要是finance
// 模块，这点可以确定」 → 做).
//
// The document tables upper-case their typed columns themselves (migration
// 20261109T1500_acc_finance_text_upper_case.sql, trigger scm.upper_typed_text). A
// hand-written journal is the exception: the journal tables also carry the words every
// other document writes when it posts, and some of those are read back as written
// (acc/payment-drift.ts), so a manual journal's narration and line notes are
// upper-cased here, by the two routes that write them (create and edit).
// ----------------------------------------------------------------------------

/** A typed value in upper case; null stays null. */
export const upperTyped = (v: string | null): string | null => (v == null ? null : v.toUpperCase());

/** A party's name as a grouping key: the same party typed in two casings is one party. */
export const partyNameKey = (name: string | null | undefined): string | null => {
  const t = String(name ?? '').trim();
  return t === '' ? null : t.toUpperCase();
};
