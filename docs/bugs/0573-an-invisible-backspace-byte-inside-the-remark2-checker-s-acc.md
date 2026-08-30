## An invisible backspace byte inside the remark2 checker's ACC regex manufactured 59 false ERP-ahead orders [medium]

**Symptom.** Owner, 2026-08-30: "不可以超前…一定要全部对齐…查看这个75张是多了
什么". The bidirectional matrix reported 75 ERP-ahead orders, many printing the
impossible shape `book="MATTRESS/ACC" erp-extra:{accessory}` — the book PLAINLY
claims ACC yet the checker counted accessory as our unilateral claim.

**Root cause (traced, char-code level).** `check-remark2-vs-status.mjs`'s
claimSet held `if (/\x08ACC/.test(t))` — a LITERAL backspace byte (0x08)
embedded before ACC in the regex, requiring a backspace character in the remark
text, which no remark ever contains. Every renderer on the way disguised it:
plain print swallowed it (`/ACC/`), JSON.stringify showed `\bACC` (reading as a
deliberate word-boundary), and only `charCodeAt` ended the argument:
`47,8,65,67,67,47`. Proven by verbatim-function reproduction: the captured
branch code returned `claimSet("ACC") -> {}` locally. So the book's ACC
shorthand was NEVER recognized since the bidirectional block was written —
CLAUDE.md's "a checker that cannot match reports a clean run" class, in the
inverse direction: a pattern that cannot match manufactured DIFFERENCES.

**Fix.** The byte replaced with plain `/ACC/` (the CATEGORY gate already
guarantees the string is only MATTRESS/BEDFRAME/ACC tokens). Same run, same
data, one byte changed: agree 2,548 → 2,591 (+43), ERP-ahead 75 → 16 (−59),
mixed 7 → 0, book-claims-more 87 → 110 (claims now fully read), ALGO-SUSPECT
still 0, and the book-side attribution drawers unchanged (that path never used
the broken regex). The remaining 16 ERP-ahead are per-line attributed by the
new lighting-source audit (34 delivered / 15 pooled-with-stock-on-shelf /
5 own-PO-received, RED 0) with causes 13 book-still-blank + 3 book-says-other.
The debug prints (claim class, char codes) stay in the SAYS-OTHER output —
they are exactly what catches this class instantly next time.

**Ref.** diag/erp-ahead-audit, 2026-08-30.
