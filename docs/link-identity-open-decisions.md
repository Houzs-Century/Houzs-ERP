# Key-without-identity: the three that are DECISIONS, not typos

`docs/bugs/0672` named twenty link sites. Fourteen were open when this sweep
started. Eleven of them had one right answer and are fixed and guarded
(`0682`, `0683`, `0684`). **Three do not**, because each turns on the same
question — *what should happen when identity CANNOT be established?* — and the
answer costs something either way.

Each is written below as: what the code does now, what it costs, two or three
options with their consequences, and **a recommendation**. The owner decides;
none of them is blocked.

**The standing default, for reference.** `migration-copy-never-compute`: a
migration reads the book's own value and never infers one. A missing link is
visible and recoverable; a wrong one lights the wrong stock and reads as
correct. Every recommendation below starts from that and says where it departs.

---

## 1. Site 6 — the migrated delivery-note writer pairs by ROW ORDER

`backend/scripts/lib/migrated-do-writer.mjs:145`, `targets = [cands[used]]`.

**What it does.** `buildMigratedDoPlan` consumes candidate sales-order lines in
ERP `line_no` order against the AutoCount export's row order. It asserts the
document and the item code, and nothing else.

**What it costs.** When one sales order carries two lines of the SAME code in
DIFFERENT colours — one sofa model in two fabrics, the ordinary case — and the
two orderings disagree, the result is an EXACT SWAP. And because the writer
copies `variants` from whichever SO line it paired with, the delivery line
inherits the other line's colour. This is the mechanism behind `DO-011505` and
`DO-011478`, the two documents `0672` records as instance 2 (their rows are
owned by another agent and untouched here).

**Why it is not a one-line guard.** The book carries no line-level key on these
documents. There is nothing to compare the pairing against — which is exactly
why it fell back to position in the first place.

| option | consequence |
|---|---|
| **A. Pair on (code, colour), refuse the rest** | Two lines that differ in colour pair correctly. Two lines identical in code AND colour are indistinguishable, and pairing them either way is harmless because the rows are the same thing. Anything left unpairable is written with NO link and listed. Cost: some delivery lines carry no `so_item_id` and someone links them by hand. |
| **B. Keep positional pairing, refuse only the ambiguous groups** | Fewer unlinked lines than A. But it keeps position as the primary rule, so the next colour swap is still possible wherever a group has two same-code lines and the orders disagree — the failure this option is meant to prevent. |
| **C. Leave as is, add a detector** | Nothing to re-run, no coverage lost. The swaps keep being created and are found afterwards, which is how the two known ones were found. |

**RECOMMENDED: A.** The colour is present on both sides and is the thing that
actually differs, so it is real identity rather than a proxy for it. A delivery
line with no `so_item_id` is a coverage gap the existing unlinked-line guards
already report and the repair scripts already fill; a delivery line carrying
another line's FABRIC is a wrong colour on the customer's delivery note and on
the stock that gets picked. The trade is a visible gap against a silent error,
and that is the trade the standing default already settles.

**Not recommended: C**, because it is what we have, and it produced the two
documents.

---

## 2. Site 10 — a photograph when the book gives no line key

`backend/scripts/import-so-line-photos.mjs`, `backend/scripts/import-po-line-photos.mjs`.

**What it does now.** The DtlKey branch answers correctly whenever the ERP knows
the key — that is bug `0624`'s fix and it is not in question. The FALLBACK, for
lines carrying no key at all (244 SO lines at the time `0624` was written), finds
ERP rows by `(document, item code)` or by the sofa model and takes the first.

**What it costs.** Two lines of one model in two fabrics both match, and the
photograph goes to whichever sorted first. For a build's compartments taking the
first IS the owner's rule (2026-08-10, 「每个 SKU 的照片都一样,留第一个就可以
了」). For two fabrics it is a guess, and from inside the fallback the two cases
are indistinguishable.

**Changed here regardless of the decision:** the ambiguous groups are now
COUNTED and each is logged with the candidates' variants, so the size of this is
a number instead of an assumption. Behaviour is unchanged.

| option | consequence |
|---|---|
| **A. Keep taking the first, keep the count** | No photograph is ever lost. Some land on the wrong fabric line of a two-fabric order, at the rate the new counter now reports. |
| **B. Refuse the ambiguous groups** | No photograph lands on the wrong line. Those photographs are not attached at all — and a sofa without a picture is a real operational cost, because the picture is how the floor knows what to build. |
| **C. Attach to EVERY candidate in the group** | Nothing is lost and nothing is wrong-only. It duplicates, which is exactly what `prune-duplicate-sofa-photos.mjs` was written to undo, and it breaks the owner's stated rule. |

**RECOMMENDED: A, plus read the count first.** This is the one place where the
standing default should NOT be followed blind, because the asset is a photograph
rather than a quantity: a photo on the wrong line of the SAME order is visible
to a person who opens the order, self-correcting, and moves no stock and no
money. Losing it is worse. **But the number decides:** if the new counter comes
back near zero this is settled for free, and if it comes back large, B for the
specific documents it names is cheap. Run either photo importer in its dry-run
mode to get the number — nothing is written.

**Not recommended: C**, which the owner already ruled against.

---

## 3. Site 17 — `fabric_colours` read without `active`

13 call sites in 12 scripts. **Already raised as `docs/bugs/0669` and DEFERRED
by the owner.** It is listed here only so the sweep's ledger is complete; this
work did not re-open it and no decision is being asked for again.

The one thing worth adding: `scripts/lib/fabric-colour-match.mjs` already
follows a superseded row to its live replacement (`live()`), and
`propose-sofa-colour-matches.mjs` already prints `*** THIS ROW IS SUPERSEDED ***`
and what the matcher would have answered without `active`. So the mechanism to
act on 0669 exists whenever the owner wants it.

---

## What was NOT a decision, and is already done

| site | file | now |
|---|---|---|
| 4 | `import-ac-so-linked-pos.mjs` | binds only when the book's sales line names the same product; refusals counted |
| 5 | `open-5526-model.mjs` | every follow-on `UPDATE` names the OLD code; rows that do not state it are left alone and counted |
| 7 | `backfill-ac-line-keys.mjs` | a bucket whose ERP code maps back to several AutoCount products is refused, not zipped |
| 8 | `backfill-photo-urls-from-keys.mjs` | a `(doc, DtlKey)` group holding two models is refused |
| 9 | `lib/line-photo-keys.mjs` | same, in `planRepoint` |
| 11 | `lib/so-line-relink.ts` | the bucket is `(code, colour)`, not code |
| 12 | `lib/autocount-line-keys.ts` | all three of `persistLineKeys`' defences, including a blank refusing |
| 13 | `shared/po-transfer-shape.ts` | identity is a refusal, falling back to `create` |
| 15 | 12 route bind points | `link_material_mismatch` 409 |
| 16 | `lib/fabric-colour-match.mjs` | a bare number's assumed PC series rides the result as `assumedSeries` and can never read HIGH |
| 20 | `audit-mrp-pairing.mjs` | the item-code detector no longer skips fully received lines |
