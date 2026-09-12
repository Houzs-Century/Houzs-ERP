## The discount percentage was a mode to pick instead of something to type [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-12, on a Purchase Order line:

> 它的 percentage 不应该是用打的吗？为什么是选的 … 就是 1000 / 25% 这样不需要
> 特别去选

and again: 「我要的是可以直接 typing by amount 或者 by percentage，并且它的
front end 你要看一下怎么去设计，要好看的」.

**Root cause (traced).** Not a defect — a design answered one step short. The
RM/% control shipped on 2026-09-11 (`docs/bugs/0803-*.md`) as a **toggle
button** beside the field: `DiscountInput.tsx` held `mode: 'rm' | 'pct'` and
rendered `MoneyInput` or a percent input depending on it, with a button to
switch. Typing `25%` into the RM side did nothing — the keystroke the operator
reaches for first was not the one the field accepted, so every percentage cost a
click first. Six purchase-side call sites carried it; the sales-side surfaces
(SO, DO, PI, SI) have no discount input at all, which is the separate half of
P1 in the parity plan and is NOT in this change.

**Fix.** One field. What was typed decides which unit it was:

- `readDiscountEntry(raw, baseSen)` — exported and unit-tested on its own,
  because "amount or percentage" IS the feature: `1000` and `RM 1,000` are an
  amount, `25%` / `12.5 %` a percentage resolved against qty x unit price,
  `120%` clamps to the line total (mirrors mig 0241's `CHECK 0..100`), a
  percentage with **no base** is `invalid` rather than a silent zero, and a typo
  commits nothing.
- The hint under the field always shows the OTHER unit — `= RM 250.00` while a
  percentage is being typed, `= 25% of RM 1000.00` at rest on a stored amount —
  so a person negotiating on the phone is told both without arithmetic.
- The toggle button is gone. `onCommit` still hands back **sen** and the
  percentage is still not persisted (owner ruling 2026-09-11, unchanged: no
  `_pct` companion exists on any of the 11 discount tables), so all six call
  sites are untouched by this change.

Pinned by `DiscountInput.test.tsx` — 13 cases, six over the pure reader.
Proved RED first: every one of the 13 fails against the pre-change component
(`git checkout origin/main -- DiscountInput.tsx`, then vitest), then GREEN.
`npm --prefix frontend run typecheck` (`tsc -b`) clean.

**Ref.** feat/discount-typed-amount-or-percent, 2026-09-12.
