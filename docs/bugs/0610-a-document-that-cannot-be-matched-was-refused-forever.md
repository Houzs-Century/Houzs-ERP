## A document that cannot be matched was refused forever [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** HC-SO-013394 has been HELD BACK since 2026-08-31. Its crash was
fixed (`0602`), the matcher was given a way through (`0607`), the line rule was
unified (`0608`) — and the document still could not be sent, because none of
those changed what happens when the operator simply saves it again.

Owner, on the button the screen tells him to press:

> 「不需要 match up line 啊，这个 button 都没必要用了」

He is right, and the reason is stronger than convenience: **two book lines carry
the same item code and the ERP line has no description to tell them apart, so no
matcher can EVER choose between them.** Refusing was not deferring the work to a
person; it was refusing permanently.

**Root cause (traced).** `composeEdit` threw `KeylessLineError` for any keyless
line, and the rebuild escape added by `0607` fired only when something had
already asked for a rebuild — `effOpts.rebuild`. Under `0608` that is set when
the line SET changes, so:

| what the operator does to 013394 | what happened |
| --- | --- |
| adds or removes a line | rebuild → the document goes in |
| **saves it with the same lines** | **refused, exactly as before** |

Nothing in the UI could ask for a rebuild either: `canRebuild` was returned by
`POST /autocount-outbox/relink-lines` and had no consumer anywhere in
`frontend/src`. So the feature existed and was unreachable — the shape CLAUDE.md
warns about, built by me in this same session.

**Fix.** A keyless document rebuilds instead of refusing, unless the rebuild is
BLOCKED:

```
if (effOpts.rebuild || !opts.rebuildBlocked) return { …, Rebuild: true };
```

The refusal exists to stop a keyless line being APPENDED as a duplicate. A
rebuild appends to nothing, so the hazard it guards against cannot occur — and
the alternative was a document no route could ever send.

**`rebuildBlocked` still wins, and that is the whole safety of this change.**
`shouldRebuild` already refuses when a purchase order was raised from the sales
order (`0609`), because `PODTL.FromSODtlKey` records WHICH sales line each
purchase line was raised for and reissuing keys would void it silently. That
refusal had to survive here too, so the condition is `!opts.rebuildBlocked`
rather than an unconditional rebuild. A blocked document still throws, and the
message still tells the reader what to do.

The host adds the second guard independently: it refuses a rebuild on a document
whose lines the BOOK says were transferred, read from `SODTL`/`PODTL` rather
than from anything the ERP believes.

**What this means for the stuck document.** HC-SO-013394 is a sales order with
no purchase order raised from it and nothing transferred, so on its next save it
rebuilds and goes across. **UNTESTED against the account book** — the host still
has to be rebuilt from `AcSyncService.cs`, which has not been compiled here.

**Verified.** `backend/tests/acRebuildDetails.test.ts` covers the escape and the
refusal's survival; `acLineRemovalIsUniform.test.ts` covers the rule. Backend
typecheck exit 0.

**Ref.** fix/autocount-line-order-is-stable, 2026-09-02.
