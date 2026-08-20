## My own matcher reported "10 of 10 missing" on ten functions that were all there [low]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Not a repo defect — a verification defect, and the third of the same kind in
one session, which is why it is worth an entry rather than a shrug.**

`docs/modules/sales-order.md` carries a table of twelve helpers that must each
take a `companyId`, because `mfg_products.code` is not unique across companies.
That is a real cross-company leak if any of them lost it, so it is exactly the
kind of list worth checking mechanically.

The check reported **10 of 10 not found**. Every one of them exists:

```
export async function loadProductByCode(sb: any, code: string, companyId: ...)
```

**Root cause.** The matcher was a `RegExp` built from a template literal inside a
heredoc'd script. The backslash escapes did not survive the layers — the
constructed source came out as
`(export )?(async )?function loadProductByCodes*[:=]`: the `` had vanished
entirely and `\s` had become a literal `s`. The regex could not match anything,
so it matched nothing, so it reported nothing found.

**Had the claim been the opposite shape, this would have read as a clean pass.**
That is the failure `CLAUDE.md` records as "a checker that cannot match reports a
clean run", arriving here through escaping rather than through a lost `` in
source — and this session has now hit it three times (a `` eaten by a shell in
an earlier red proof, backticks eaten by `git commit -m`, and this).

**The rule that actually works, and it is not "escape more carefully":** in a
script that has to travel through a shell, do not use regex escapes at all.
`line.includes('function ' + fn + '(')` cannot be mangled by a layer it passes
through. The rewritten check found all twelve, and it carries a self-guard —
if EVERY entry comes back missing it exits 2 and refuses to report, because a
whole population going missing at once is a broken matcher, not a finding.

**Result after the fix:** all twelve helpers take a `companyId`. The guide's
table is correct.

**Ref.** 2026-08-15, module-guide verification of `sales-order.md`.
