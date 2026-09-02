## Rebuilding any unmatchable document went further than the rule [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Eight behavioural tests of the keyless-line guard were red and nobody
knew, because the suite was not run after the change that broke them. Among them:
"a keyless line REFUSES the whole edit rather than appending a duplicate", "one
keyless line among many still refuses — a partial edit is not offered", "a
cancelled line with NO key is refused".

**Root cause (traced).** `docs/bugs/0610-a-document-that-cannot-be-matched-was-refused-forever.md`
replaced the keyless refusal with a rebuild for ANY document that was not blocked.
Its reasoning was sound as far as it went — a rebuild appends to nothing, so the
duplicate hazard cannot occur — but it did not weigh what a rebuild COSTS: every
AutoCount line key on the document is destroyed and reissued. That is a large
price for the routine case it also swept up, which is a legacy line whose key was
simply never backfilled and whose correct answer is to backfill it and keep every
downstream link intact.

It also went further than the owner's own rule, which is about the line SET:

> 如果只是 edit SKU、换东西或者添加 variants 等等，我们就直接照现在的模式去做。那如果
> 我们有 delete line、add line 导致了它的 line 不平整了，我们就整张重建

A plain edit of a keyless line changes no line set, so under that sentence it does
not rebuild.

**Fix.** The escape is now an EARNED rebuild only — the line set changed, or a
caller asked — and it still has to be permissible for the document type
(`docs/bugs/0611-a-converted-document-could-be-rebuilt-which-destroys-its-tra.md`).
A plain edit of a keyless line refuses as it did before, and all eight guards are
green again.

**What this means for the held-back sales order, stated honestly.** Its own
history is a line DELETED and a line ADDED — the owner's words, 2026-08-31 — which
is a line-set change and therefore rebuilds. What it does NOT do any more is
rebuild on a bare re-save that changes nothing, and whether that leaves it stuck
depends on what its outbox row actually carries. **UNKNOWN** until that row is
read; it is being measured by a read-only production check.

**The process failure is the finding.** The change that broke these eight was
written, typechecked, committed and pushed without the suite being run — and the
three tests that WERE run were the three written alongside it. A new test passing
says nothing about the old ones. Run the suite for the AREA, not for the change.

**Ref.** fix/autocount-line-order-is-stable, 2026-09-02.
