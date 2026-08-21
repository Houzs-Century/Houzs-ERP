## The CO/SO helper twins: two had drifted, and the drifts are bounded by an asserted proof [low]

<!-- area: Sales orders + pricing -->

**Follow-up to the entry recorded with #2236, which left this open as an owner
decision. It did not need one — it needed the proof finishing.**

Three derivations existed in both `routes/mfg-sales-orders.ts` and its clone
`routes/consignment-orders.ts`:

| twin | verdict |
|---|---|
| `deriveSalesLocationFromState` | identical once formatting is normalised — a straight duplicate |
| `deriveCountryFromState` | the SO canonicalises the state before the lookup; the CO used the raw string |
| `snapshotUnitCostSen` | the SO wraps both the explicit value and the DB read in `senOrZero`; the CO did neither |

**Both drifts are bounded by assertions, where #2236 could only say "I could not
construct a differing case". The bound is stated honestly below — it is not
unconditional.**

*Country.* Both fall back to `'Malaysia'` on a miss, so they can only diverge if
the raw string and the canonicalised string hit DIFFERENT `my_localities` rows.
Measured: the **16** values `canonicalizeMyState` can produce (its
`CANONICAL_STATES` plus every `ALIAS_MAP` target) and the `state` values seeded
into `my_localities` under a country other than Malaysia (China + Singapore, mig
0181) share **ZERO** entries.

**That check alone was NOT sufficient, and the gap was found while reviving this
PR (2026-08-16).** It compares against the alias TARGETS (`Johor`); the
divergence can equally come from an alias KEY (`JOHOR`), which is not in that
set. A row `state = 'JOHOR', country = 'Singapore'` would make the CO's raw
lookup answer Singapore while the SO's canonicalised lookup answers Malaysia —
precisely the disagreement the consolidation is claimed not to have. The test
now also asserts the property that actually settles it: **every non-Malaysia
locality state is canonicalisation-STABLE** (`canonicalizeMyState(s) === s`), so
both implementations use an identical lookup key. Proven red by adding
`['BEIJING', 'Johor']` to `ALIAS_MAP` — the file goes to `1 failed | 6 passed`
and names `Beijing -> Johor (China)`.

**What is still NOT proven, and must not be read as if it were.** Both scans
read the SEEDED data in `src/db/migrations-pg`. `scm.my_localities` is also
writable at runtime — `routes/localities.ts` exposes POST / PATCH / DELETE, and
`state` and `country` are free-form strings on both (`z.string().trim().min(1)`),
gated only by `canWriteScmConfig`. So an operator-created row is outside what
these assertions can see, and CLAUDE.md's standing rule applies: a migration file
describes intent, the running system is the fact. Settling it needs a read-only
probe of the live table.

*Unit cost.* All three CO callsites already wrapped the argument in `Number(...)`
and `NaN > 0` is false; the DB side reads `mfg_products.cost_price_sen`, which is
`integer DEFAULT 0 NOT NULL` and can be neither null nor non-numeric. `Number(x)`
and `senOrZero(x)` agree on every value that column can hold.

**Fix.** All three move to `scm/lib/sales-doc-derive.ts`, keeping the Sales
Order's bodies **copied verbatim**. `backend/tests/salesDocDerive.test.ts` holds
the two proofs as assertions, because both are facts about OTHER files that can
change: seed a Singapore locality whose state is `Johor` and it goes red; drop a
`Number(...)` at a callsite and it goes red. Both proven red before being
trusted.

**A trap this hit, worth the entry on its own.** The first draft of the shared
module PARAPHRASED the bodies instead of copying them — it swapped the WP-KL
alias (`state === 'Wilayah Persekutuan Kuala Lumpur' ? 'Kuala Lumpur' : state`)
for `canonicalizeMyState`, and dropped `name` from a SELECT that
`warehouseLabel()` reads. Caught by re-reading the original before deleting it.
**Consolidating duplicates is only safe if the surviving copy is the one that
already ran** — a rewrite that looks equivalent is a new implementation with no
production history. The removal script now refuses unless the text it is about to
delete matches the shared module token-for-token.

`consignment-orders.ts` 2383 -> 2332, `mfg-sales-orders.ts` 12011 -> 11947.
Both ceilings follow.
