## The by-SKU variant exemptions reached the app and not the audits, and one of them reached the audits and not the app [medium]

**Symptom** — the same rule gave four different answers depending on which
program you asked.

- `check-so-noncatalog-lines.mjs` reported every DIVAN ONLY, ADJUSTABLE, (S+S),
  DOUBLE DECKER, DDB and CONSOLE line as missing variants it cannot have.
- `cross-fill-so-po-variants.mjs` judged adjustable / double-decker frames
  incomplete for want of a Divan Height and a Leg Height they do not have.
- `check-cutover-metrics.mjs` filtered divanless frames correctly and then
  printed "divan+leg" in the reason string anyway.
- And the opposite direction: a sofa CONSOLE / CT line was exempt from Seat
  Height **in the audit** and not in the app, so the SO gate operators actually
  hit still demanded a seat height from a console table.

**Root cause, traced not guessed** — the TypeScript half of this was already
closed and stayed closed. `itemCode` is a REQUIRED parameter of
`missingVariantAxes` / `missingConfirmVariantAxes` (PR #1763's follow-up, the
worked example under **BUG CLASS optional-param-noop** below), so `tsc` names
any call site that forgets it. Verified rather than assumed: all eleven
non-test TS/TSX call sites pass a real code, and the two indirect layers
(`findIncompleteVariantLines`'s `SoLineForVariantCheck.itemCode`,
`adjustmentIncreaseErrors`'s 4th parameter) type it non-optional too.

The holes were all in `.mjs`, and that is not a coincidence: a plain-node audit
script pays no compiler tax for re-typing the rule, so three of them had.
`check-so-noncatalog-lines.mjs` carried a **fifth hand-copy** of the axes table
whose helper had no `itemCode` parameter at all — under a header saying "keep
these three constants in lock-step with the source" — while the real item code
sat unused at the call site one line above.

`scripts/lib/variant-axes.mjs` exists to prevent exactly this and its header
claims "the copy cannot drift". It had drifted: it grew an `isSeatlessPiece`
exemption (owner 2026-08-11, "有些 sku 是没有的", with AutoCount PO-009553 as
the evidence) that the TypeScript rule never got. `variantAxesMirror.test.ts`
compares the two implementations, and it passed the whole time — its code list
held no CONSOLE or CT case, so the two were only ever compared on inputs where
they already agreed. **A mirror test is only as wide as its corpus.**

**Fix** — `isSeatlessPiece` ported into `so-variant-rule.ts` and its vendored
frontend twin, so the exemption reaches the gate operators hit; the mirror
test's code list now carries `8030-CONSOLE`, `9028-CT`, `HOK-CONSOLE (L)`,
`8030-CT01` **and the near-misses that must NOT be exempt** (`CONSOLE-1A`,
`CT-2A`, `8030-CTRL`, `8030-CONSOLIDATED`). `missingConfirmVariantAxes` +
`isColourKiv` added to the `.mjs` mirror and pinned by the same test, so
`check-so-noncatalog-lines.mjs` imports the rule instead of re-typing it and
passes the real `code`. `cross-fill-so-po-variants.mjs` and
`check-cutover-metrics.mjs` import both predicates instead of their local
copies, and the latter's reason string now applies the same divanless guard its
filter does. `tests/variantExemptionCallSites.test.ts` is the new check: no
script may re-type an exemption pattern, every completeness script must import
the mirror, and no call may pass two arguments.

**Two stale comments, corrected while here.** `missingConfirmVariantAxes`'s
docblock claimed "desktop, mobile and the backend confirm gate all read THIS so
the rule cannot drift" and the frontend test header said the same, while #2072
had removed variants from the confirm gate entirely — the function had ZERO
production callers. `docs/modules/sales-order.md` recorded that and deliberately
left the source comments alone, being a docs-only diff; this is that follow-up.
The function now has one honest consumer, the audit mirror.

**Ref** — 2026-08-14, this PR.
