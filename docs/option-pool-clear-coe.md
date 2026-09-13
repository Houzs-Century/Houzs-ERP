# COE — clearing every option pool deleted the configuration on 421 Models

**Date:** 2026-09-13. **Severity:** high — production data changed wrongly on
both companies, found by the owner rather than by any check here.

---

## Trigger — what he actually saw

> 「为什么 2990 complaint 有些尺寸和 headrest 不见了」

Sizes and the headrest had gone from the pickers on the 2990 side. Earlier the
same day `open-model-option-pools` had run against production and cleared
`allowed_options` on **421 Models across both companies** — 379 on company 1,
42 on company 2.

The owner found it. Nothing in this repo did.

---

## Root cause, traced to the line

The script was written on ONE premise, stated in its own header: an
`allowed_options` pool is a **restriction**, so removing it means "offer
everything". Evidence for that premise was real and was read —
`SoLineCard`'s specials filter says so in as many words:

> the pool is now OPT-OUT … an EMPTY/absent pool ⇒ offer ALL active specials for
> the category

and `lib/allowed-options-check` only gates when the pool is non-empty.

That premise is **false for two of the nine keys it was applied to**, and the
code says so just as plainly, in a file the script never opened:

`backend/src/scm/routes/product-models.ts`, `PATCH /:id` ("Chairman 2026-06-01"):

> Modular's `allowed_options` is the **SINGLE source of truth for ON/OFF** —
> there is no separate per-SKU "Visible" toggle anymore. For size-keyed
> categories, mirror `allowed_options.sizes` onto each SKU's `pos_active`.

So for **MATTRESS** and **BEDFRAME**, `sizes` is not a filter over a master
list — it IS the record of which sizes that Model comes in. And MATTRESS
thickness has no other home at all: `allowed_options.mattress_thickness_cm`,
read by the generate-skus MATTRESS branch.

`ProductModelDetail.tsx` renders the Modular editor's ticked boxes FROM these
pools (`(allowed.sizes ?? []).map(...)`, `selected={allowed.compartments ?? []}`,
and the four height/gap pickers). A cleared Model therefore reads as "nothing
configured" — which is exactly what a person looking at Modular sees as missing.

**Population hit:** 203 MATTRESS and 123 BEDFRAME Models — the two categories
where `sizes` is the configuration — plus every Model's compartments, specials,
heights and gaps.

---

## What the audit RULED OUT

- **No SKU `pos_active` flag was flipped.** That mirror lives inside the PATCH
  route; the clear wrote straight to the table in SQL, so it never executed. The
  damage was the lost `allowed_options` content and nothing else. Worth stating
  because "sizes disappeared from the catalog" would otherwise read as a
  catalogue or stock problem and send the next person to the wrong table.
- **Not the sofa-fabric change.** That was a separate, earlier, deliberate
  opening (`docs/bugs/0842-...`), and it stays in force after the restore.
- **Not a 2990-only problem.** He noticed it there; company 1 lost 379 Models'
  pools to the same run.

---

## Fixes shipped

| PR | effect |
|---|---|
| #3764 | `restore-model-option-pools.mjs` + workflow, and the read-only `check-model-option-pools-vs-backup.mjs` |

**Restored and verified, with the runs:**

| run | result |
|---|---|
| staging plan | 421 Models differ from the backup — 379 on company 1, 42 on company 2 |
| staging apply | `APPLIED: 421` · `VERIFIED on a fresh connection: 421 Model(s) match the backup exactly, 1329 pool(s) back in place` |
| prod plan | same 421 / 379 / 42 |
| prod apply | `APPLIED: 421` · `VERIFIED … 1329 pool(s) back in place` |

Confirmed afterwards against the live staging API: **113 of 113** BEDFRAME and
**187 of 187** MATTRESS Models carry their `sizes` again.

The backup the clear wrote before touching anything is the only reason this was
a two-hour problem instead of a rebuild. It postdates the sofa-fabric opening,
so restoring did not re-restrict fabrics.

---

## Why the existing rules did not stop it

The owner asked this directly: *「你补全的规则不就是这个嘛？你补全了反而有 bugs？」*
It is the right question, and the honest answer is that **one rule was followed
in form and broken in substance, and no gate covers the gap.**

CLAUDE.md's first rule says: state the hypothesis, and **name the observation
that would REFUTE it**, then go and make that observation.

The hypothesis was "a pool is a restriction". The refuting observation would have
been "find a consumer that reads a pool as the SOURCE of a list rather than as a
filter over one" — a single `git grep` over the nine key names, which is how the
cause was found afterwards, in under a minute.

Instead the script **argued the premise in its own header** — eighty lines
setting out why clearing is safe, including a paragraph anticipating the owner's
objection about sizes — and then went looking only for evidence that agreed.
Confidence was manufactured by writing it down at length. The header reads as
diligence and functions as the opposite.

Two other rules were also available and not applied:

- *"Read the module guide before you work in a module."* The change was to
  `product_models`; `product-models.ts` is where the ON/OFF rule is written, and
  it was never opened.
- *"A root cause is a request for OPTIONS."* He was asked one question — clear
  all, clear some, or none — and the options were framed entirely in terms of
  restriction. He was never told that for two categories the pool is the data.
  He could not have chosen correctly from what he was given.

**The scale multiplied the error, and that was a choice too.** "Every company,
every category, every key" was written as thoroughness. A blast radius that wide
demanded proportionally more evidence, and got less.

---

## Lessons

1. **A premise that is TRUE at one consumer is a hypothesis about the others.**
   Before applying a rule to N keys, enumerate the consumers of all N. One grep.
2. **Writing the justification at length is not evidence.** A long header that
   argues a case is a signal to go and look for the counter-example, not a
   substitute for having looked.
3. **A pool that a screen RENDERS FROM is configuration, not a restriction.**
   The test is not what the pool is called, it is whether anything can rebuild
   its contents without it. `mattress_thickness_cm` could not.
4. **Present a destructive option with its true shape.** "Shall I clear the
   restrictions" and "shall I delete the per-model configuration for 326
   bedframes and mattresses" are different questions and only one of them was
   asked.
5. **The backup is what made this recoverable.** Keep writing it, keep refusing
   to proceed without it, and keep the restore statement beside the script.

---

## Still open — the owner's decision, properly framed this time

The problem he originally reported is real: a Model's pool stopped him picking a
fabric colour that exists. The fix for that is NOT "clear every pool", because
the same column holds two different things:

- a **restriction** — "do not offer this option for this Model" (fabrics,
  specials);
- a **configuration** — "this Model comes in these sizes / this thickness"
  (MATTRESS and BEDFRAME `sizes`, `mattress_thickness_cm`).

Three ways forward, with what each costs:

1. **Clear only the restriction-shaped keys** (`fabrics`, `specials`) and leave
   the configuration alone. Smallest change, solves the reported problem, leaves
   sizes and compartments as he configured them. **Recommended.**
2. **Split the column** so configuration and restriction stop sharing a home.
   Correct long-term, needs a migration and touches the Modular editor, the SKU
   generator and the POS catalogue read.
3. **Leave it as restored** and treat each unwanted restriction as it appears.
   No build cost; the fabric problem comes back the next time a Model is ticked
   too narrowly.

**Ref.** `docs/bugs/0855-clearing-every-option-pool-deleted-the-configuration-not-jus.md`,
PR #3764. The clear itself is `docs/bugs/0845-...` and PR #3752.
