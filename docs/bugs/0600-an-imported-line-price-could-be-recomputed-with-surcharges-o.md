## An imported line price could be recomputed with surcharges on the plain line edit, while the amendment path protected it [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Asked whether ticking a PRICED special-order code onto 338 migrated
lines would change what those old orders bill, the owner answered with the rule
rather than the case:

> 「我们的 selling price 是根据我们 manually 填入的 不应该被这种影响 查看所有的
> 源代码 fix 掉」 … 「fabric 不需要」

The selling price is what a person typed. Neither the special-order surcharge nor
the fabric surcharge may move it.

**Root cause (traced).** The system already said this — on ONE of its two edit
paths.

`recomputeFromSnapshot` computes an authoritative selling price as
`effectiveBaseSen + chargeableSurchargesSen`, where the surcharges include
specials and fabric (`shared/mfg-pricing.ts`, the `unitPriceSen` sum). Two things
suppress it:

* `isMigratedTrust` — `trustOperatorSelling === 'including-zero'` forces
  `chargeableSurchargesSen = 0`;
* the final overwrite — a trusted caller's own price is persisted instead.

`so-revision.ts` derives `'including-zero'` from `soIsMigrated`
(`linked_ac_docno IS NOT NULL`), so the AMENDMENT path was protected. The plain
line PATCH called `erpLineTrust(...)`, which returned a bare `true` — and `true`
is NOT `'including-zero'`, so neither guard applied. The overwrite still saved a
line with a NON-ZERO stored price, but a line priced **0** fell through to the
computed figure, surcharges included.

That is not a rare corner: the module's own note records **10,856 of 13,909
migrated lines are priced 0**.

So one order could be told two different things about its own price depending on
which screen edited it. Same class as `docs/bugs/0269-*` and `docs/bugs/0598-*` —
two surfaces, two opinions — this time on money.

**Fix.** `erpLineTrust` takes `soIsMigrated` as a **required** parameter and
returns `'including-zero'` for an imported order, so the line PATCH now reaches
the same two guards the amendment path already had. Required rather than
optional, per CLAUDE.md: an optional flag lets a future call site silently keep
the unprotected answer, which is exactly how this gap survived.

The line PATCH reads the marker ONCE at the top of the handler, bound and
branched — a failed read returns 500 rather than defaulting to "not migrated",
because that default is the permissive direction.

**ADD is excluded, deliberately and by the caller.** A line typed today has no
AutoCount price to protect; `so-revision.ts` refuses `'including-zero'` on its own
ADD arm for the same reason, and both `POST /` and `POST /:docNo/items` pass
`false`.

**Test.** `src/scm/lib/erpLineTrustMigrated.test.ts` — the four answers pinned
apart, including one case asserting the migrated answer is NOT equal to the
native trusted one, because only `'including-zero'` switches off the chargeable
surcharge and an accidental collapse would silently undo this. The existing
`mfg-pricing-recompute.trust`/`.surcharge` suites stay green (22 tests).

**What this does NOT do.** It does not remove specials or fabric from the price
formula for NEW orders — there the surcharge is the intended behaviour and the
salesperson sees it while quoting. It stops a RECOMPUTE moving a price that was
already decided.

**UNTESTED against production.** No migrated line has been edited through the
patched path yet. The 338 priced special-order codes remain unstamped and are
still the owner's call — this change removes the price-movement risk from that
decision, it does not make it.

**Ref.** fix/manual-selling-price-wins, 2026-09-02.
