# HANDOFF — sofa/bedframe alignment to the supplier listing

**Updated 2026-09-11 ~13:20Z — second round, on the owner's FULLER export.**
Read this top-to-bottom; it is written so a stranger can continue without the chat.

The owner handed over `houzs-century-ALL-SO-detail-with-CustomerPO-2026-09-11.xlsx`
(sha256 `b2b1561c…`), which is the 2026-09-10 export PLUS a **Customer PO column**
— on the older file our own new-style orders carried a SALES order number where
the PO belongs, so every one of them read as "PO not found". It is committed as
`backend/scripts/data/supplier-so-detail-2026-09-11.json.gz`; the 09-10 file is
deleted so there is one authority, not two.

---

## HOT — the live GR blocker being worked at handover (HC-SO-013503)

The owner hit a real GR failure and it exposed TWO systemic gaps. Finish this first.

**The document.** `HC-SO-013503` (customer MR CHAN) + its PO `HC-PO-2609-053`.
Build: `8030` sofa, three 35" pieces. Prod holds `1A(LHF)+1NA+1A(RHF)`. It should
be `1A(LHF)+1NA+L(RHF)` — the THIRD piece is a **lounger L(RHF)** (the taller box,
hatched on the right), not an arm. Owner confirmed in chat 2026-09-11:
「用今天的SO-013503 / Po2609-053 确定」.

**Why it was wrong (traced).** On 2026-09-10 the owner read this drawing HIMSELF
and gave `1A(LHF)+1NA+1A(RHF)` verbatim (was in `tv-direction.json`, key 926872,
`confidence: owner`). That dropped the lounger. On 2026-09-11, with the goods in
front of him for GR, he corrected it. The original drawing read + the mechanical
TV-mirror + the supplier + the physical goods ALL give `...+L(RHF)`.

**State of the fix (branch `fix/probe-received-col`, committed + pushed, NOT applied):**
- new file `backend/scripts/data/sofa-compartment-corrections-owner-not-in-file.json`
  — SO + PO entries, target `1A(LHF)+1NA+L(RHF)`, addressed by live line keys
  (SO 926872; PO 928403/928404/928405). Registered in `CORRECTION_FILES`.
- the superseded 926872 entries were REMOVED from `tv-direction.json` and
  `drawings.json` so one address carries one answer. Guard test: only the
  pre-existing 1ELT failure remains.
- **Dry-run run 34562298315:** SO **applies clean** (money held, 449000). PO is
  **REFUSED — "money would move" 273000→106000.** The PO carries money on more
  than one line, and the applier pairs rows BY CODE, so it reads the `1A(RHF)→
  L(RHF)` swap as remove+add and its money guard (correctly) refuses.

**THE NEXT STEP — do the PO as an IN-PLACE RENAME, not through the pair-by-code applier.**
The correct operation is: rename PO line `928404` `8030-1A(RHF)`→`8030-L(RHF)`
in place, keeping its price/qty/so_item_id. That moves NO money. `received=0`
(probe 34561370209) so no stock/lot to move; `8030-L(RHF)` SKU exists. Options:
  (a) apply the SO via the channel (`file=owner-not-in-file`, DOC=HC-SO-013503,
      apply=1) — it is clean; then rename the PO line surgically; OR
  (b) do BOTH SO and PO as surgical in-place renames (cleanest — the owner's
      change is literally "one piece is a lounger", i.e. a one-row code change).
  There is no in-place-rename tool yet. `repair-orphan-sofa-codes.mjs` /
  `repair-mislabelled-sofa-po-lines.mjs` re-file codes and are the closest
  precedents to copy for a gated (MODE/CONFIRM/fresh-verify/RE-RUN) one-row rename.
  After applying, re-run the probe (`probe-lounger-read-as-arm.yml` DOC=HC-SO-013503)
  to confirm both sides read `L(RHF)`, then the GR can be received.

**SYSTEMIC GAP 1 — re-check the owner's 2026-09-10 SELF-READ batch.** The wrong
value here was the owner's own 09-10 reading (confidence:owner in
`tv-direction.json`). If he mis-read one tall-box-lounger as an arm, others in
that same batch may carry the same error. Pull every `confidence: owner` entry
dated 2026-09-10 and re-verify against its drawing.

**SYSTEMIC GAP 2 — the supplier export is INCOMPLETE.** `HC-PO-2609-053` (supplier
PO ref `R04533/ZNT6330`) is NOT in `supplier-so-detail-2026-09-10.xlsx` at all.
So "aligned to the supplier file" is NOT "all POs correct" — a whole population of
proceeded orders is outside that file (esp. new `HC-PO-2609-0xx` with non-standard
refs). Build a check that lists proceeded sofa POs with NO supplier-export match
AND still-to-receive, and work them from drawings — that is the real remaining
GR-risk surface, and it is what my earlier "80 not-found = ignore" wrongly buried.

> **GAP 2 IS NOW BUILT — see §0b.** `check-supplier-listing-vs-erp` ends with a
> per-supplier reverse pass, and on production it names `HC-PO-2609-053` among 9
> Hookka orders and 1 Ohana one. It also settles the export question above: the
> owner's 2026-09-11 file (with the Customer PO column) still does not carry that
> document, and the reason is not the ref format — the 4 Hookka POs raised the
> same day ARE in it. GAP 1 (re-check the 09-10 self-read batch) is still open.

---

## 0. 「现在去做 GR 行不行？」 — the answer, re-measured on the fuller file

**PROVEN, read-only against production 2026-09-11 (`check-supplier-listing-vs-erp`,
GROUPS=SOFA, after apply run 34557669854 landed VERIFY OK):**

| bucket | count | what it means |
|---|---|---|
| supplier sofa documents compared | 144 | the 09-10 file saw 139 |
| agree on pieces, order AND variants | 10 | done |
| **DIFFERENT PIECES** | **4** | the only "costs money" bucket — §2 |
| same pieces, different ORDER | 15 | direction only; does NOT block a GR |
| same build, **leg height blank on our side** | 35 docs / **68 lines** | §3 |
| our purchase order not found | 79 | §2b — NOT work, and now classified |
| purchase order has no sofa line | 1 | HC-PO-010087 |

**Two of the four "different pieces" the 09-10 round reported were never
different** — the supplier writes `CSL`, our catalogue mints `CONSOLE`, and the
CHECKER did not know it (PR #3613 fixed the correction FILES, not the reader).
That is now fixed in code (`SOFA_PIECE_ALIAS` in `lib/parse-sofa.mjs`), together
with two documents that differed on the inch mark alone (`1` vs `1"`), so the
table above is the real divergence. Bug ledger `docs/bugs/0807`.

**So: sofa GR is safe on pieces except the 4 in §2.** The blank leg heights do
not block a receipt — they make the paperwork understate the spec — and they are
now fillable by tool, but only where it is safe (§3).

---

## 0b. THE MISS THE OWNER FOUND — and the check that would have caught it

Owner, 2026-09-11: *"做完之后我发现又有一张单是没有的 — SO-013503 / PO-2609-053"*.

`HC-PO-2609-053` (raised 2026-09-10, three 8030 compartments, supplier HOOKKA
INDUSTRIES) **is not in the supplier's export at all**. Nothing was wrong with our
alignment: every check we had walked the SUPPLIER's documents and asked whether we
hold them, so a purchase order of OURS that they do not hold was invisible by
construction.

`check-supplier-listing-vs-erp` now ends with **THE OTHER DIRECTION**, per
supplier. Measured on production, our 167 sofa purchase orders across 9 suppliers:

| supplier | in this listing | NOT in it |
|---|---|---|
| OHANA STUDIO MARKETING | 59 | **1** — HC-PO-009554 (2026-08-28, RECEIVED) |
| HOOKKA INDUSTRIES | 4 | **9** — 2609-043/044/045/046/**053**/054/062/063/064, all raised 09-10 or 09-11 |
| HOOKKA MANUFACTURING | 1 | 0 |
| ARMANI (32), DORSETTLOFT (56), RED SOFA (2), TODERN (1), LAVEO (1), T.H.L. (1) | 0 | this file is not their book — out of its scope |

**The 10 on the chase list are a question for the supplier, not a repair here:**
either they have not keyed those orders in yet, or they never received them. Until
they are in their book, nothing can say whether what they build will match what we
ordered. Ohana's single one (HC-PO-009554) is already RECEIVED, so it is the older
kind of gap; the nine Hookka ones are all two days old.

**Also found the same way — 2 orders the supplier BUILT that our ERP has no
purchase order for at all** (the customer order is here, CONFIRMED, not proceeded):

- `HC-SO-012062` (ZNT6709, supplier SO-2605-273, `5535-L(LHF)+5535-2A(RHF)`, leg 1")
- `HC-SO-012343` (ZNT6009, supplier SO-2604-265, `5530-L(LHF)+5530-2A(RHF)`, leg 6")
  — and **ours is the MIRROR**: we hold `9028-L(RHF)+9028-2A(LHF)`. The supplier is
  the authority on a proceeded order, so ours is the one that is wrong.

Both need the owner: raise the missing purchase order, or say they are pre-cutover
and closed. The other 77 not-found references are neither — see §2b.

---

## 1. What is DONE and LANDED

| item | evidence |
|---|---|
| First production apply of the whole line of work — 293 builds, 774 lines updated, 9 added, 0 money moved, VERIFY OK | apply run **34507126629**, 2026-09-10 |
| 4 TV-round mirror fixes (HC-SO-012368/-012760/-013075/-013239) | in that run |
| **CSL = CONSOLE** — supplier writes `CSL`, our catalogue mints `CONSOLE`; 4 supplier-listing entries + others remapped across 3 data files | **PR #3613, MERGED 03:01Z**. On `main`: 0 CSL / 4 CONSOLE entries |
| **Bedframe check: compare div/gap/leg as NUMBERS not strings** — the inch mark `"` was faking 296 diffs | **PR #3614, MERGED 03:03Z** |

---

## 2. Sofa divergence — the 09-10 reading, kept for its itemisation

> **Superseded by §0 for the COUNTS** (that run predates both the CSL fold and the
> fuller export). What is still current here is the itemisation of the piece
> differences below. Of the four, `HC-PO-009986` and `HC-PO-010145` turned out NOT
> to be piece differences at all — CSL is CONSOLE — and they now sit in the
> direction bucket. The two that survive are `HC-PO-010086` and `HC-PO-010041`,
> joined by two the fuller export brought in: `HC-PO-2609-051` (supplier
> `1A(LHF)+1A(RHF)+1A(LHF)+1NA+1A(RHF)`, ours `1A(RHF)+1NA+2S+1A(LHF)`) and
> `HC-PO-009989` (supplier `1S+1S`, ours `1S`, 2 already received).

139 supplier sofa documents compared:

| bucket | count | what it means / action |
|---|---|---|
| agree fully | 6 | done |
| DIFFERENT PIECES | 4 | see below |
| same pieces, DIFFERENT ORDER | 13 | direction only — does not block GR |
| same build, DIFFERENT VARIANTS | 35 | **leg height blank on our side — see §3** |
| our PO not found | 80 | all below the migration floor (PO-009122) or another supplier — IGNORE per owner |
| PO has no sofa line | 1 | — |

**The 4 DIFFERENT PIECES, itemised:**

- `HC-PO-009986` — supplier `1A(LHF)+1NA+CSL+1A(RHF)`, ours `1A(LHF)+1A(RHF)+CONSOLE+1NA`.
  **Same multiset once CSL=CONSOLE** — only order differs. **Resolved by the
  re-apply** (§4). Not a real piece difference; the check ran before #3613.
- `HC-PO-010145` — supplier `1A(LHF)+CSL+1A(RHF)`, ours `CONSOLE+1A(RHF)+1A(LHF)`.
  Same — CSL=CONSOLE, order only. **Resolved by re-apply.**
- `HC-PO-010086` — supplier `1A(LHF)+1A(RHF)`, ours `2S`. **GENUINELY different**
  (two single arms vs one 2-seater). Needs the owner or a photo. HELD.
- `HC-PO-010041` — supplier `L(LHF)+1NA+1A(RHF)` (3 pieces), ours
  `1A(RHF)+L(LHF)+1A(RHF)+1NA+1NA` (5 pieces). **GENUINELY different — ours has
  extra pieces.** This doc had 3 conflicting earlier readings; the supplier is
  the authority. Needs supersede-by-hand + re-apply, OR owner confirmation. HELD.

---

## 2b. THE 79 "our purchase order not found" — classified, not waved away

The 09-10 round wrote these off as "all below the migration floor (PO-009122) or
another supplier". **There is no floor.** The check was printing a TEXT min/max
over mixed document shapes (`HC-PO-2609-001` sorts before `PO-000254`) and it was
being read as one. Our AutoCount numbers are SPARSE — we hold 574 of the 9,917
between the lowest and the highest — because the cutover took OUTSTANDING
documents only, whatever their number.

Re-measured 2026-09-11: of the 79, **0 are below our lowest, 77 sit INSIDE our
span, 1 is another company (2990-PO-2607-018, out of scope per the owner's ruling)
and 1 is unreadable (`EXPO-007767`)**.

**The evidence that the 77 are still not work:** for 77 of the 79, neither the
purchase order NOR the customer's sales order is in our ERP — the whole
transaction predates the cutover and was closed when we cut over. The exception is
the 2 in §0b, where the customer order IS here; those two are real.

## 3. THE LEG-HEIGHT GAP — why the correction files could not land it

> **Answered by §10.** The diagnosis below (the applier cannot identify the line)
> is right and still worth reading, but the conclusion — re-run the applier — was
> wrong: the corrections channel addresses a BUILD, and a leg is a per-LINE fact
> the supplier's own export already carries line-for-line. §10 is the tool that
> uses it, and it also explains why 40 of the 68 lines must NOT be filled.

**Symptom:** 35 documents show `leg height: supplier "6" vs ours ""`.

**Traced, not guessed:**
- The supplier's leg IS in `desc2` as `"leg:6inch / Nylon Fabric"`;
  `parseSofa()` reads it correctly → `leg: 6` (verified locally 2026-09-11).
- The correction entries for these DO exist with the leg value — e.g.
  `HC-PO-008192` is in `sofa-compartment-corrections-supplier-listing.json` as
  `{pieces:[1A(LHF),2A(RHF)], leg:"6"}` (verified locally).
- **They did not land because the APPLIER could not identify or was refused on
  the line**, per the apply run **34507126629** log — the reasons are per-doc and
  already printed there, e.g.:
  - `HC-PO-008192: matched the account book's own line key 759694 — the two
    builds on this document cannot be told apart by their text` (two builds share
    one document; ambiguous).
  - many `no line matches "<text>" — skipped, the build is not on this document`
    (text/normalisation mismatch between the correction's expected text and the
    live line).
  - a few `REFUSED — ... moved stock` / `piece SKU not minted: 8030-CSL`
    (the last now fixed by #3613).

**What to do (next person):**
1. **Re-run the apply first (§4)** now that CSL=CONSOLE is on main — this alone
   clears the `8030-CSL` refusals and the two CSL piece-docs, and may re-land
   some leg writes.
2. Then re-run the read-only check (run the workflow in §7) and see how many of
   the 35 remain.
3. For those that remain: the blocker is **line identification**, not the data.
   The correction addresses builds by `lineKeys` (AutoCount DtlKey) or by text.
   Where a document carries **two builds under one DtlKey** (008192), the applier
   cannot tell them apart and refuses — correct by design. These need either a
   finer key, or an owner decision on which line is which. Do **not** loosen the
   matcher to force it (that is the exact failure `docs/bugs/0779` records).
4. A leg-only write does not move stock, so on a build whose ONLY difference is
   leg height, the applier should write it even where stock is received — confirm
   this against the applier's refusal rule before assuming it.

---

## 4. THE RE-APPLY — DONE (run 34557669854, 2026-09-11)

CSL=CONSOLE is on `main`. A re-apply is idempotent (per-build transactions,
RE-RUN header) — the 293 already-applied builds are inert; the console builds and
anything newly writable land.

- **Dry-run run 34557078481 (apply=0, prod) — CLEAN**: builds touched 289,
  lines updated 784, added 1, **piece-SKU-not-minted 0** (was 6 — CSL now mints
  as CONSOLE), **0 money moved**, refusals all by-design (19 real-stock, 3
  downstream, 1 seat).
- **APPLY run 34557669854 (apply=1, prod) FINISHED — `VERIFY OK — 245 entries over
  237 document(s), piece multiset and both money columns · 47 superseded by a later
  ruling`.** 34m21s, no VERIFY FAILED. The CSL builds landed as CONSOLE; what it
  did NOT fix is the CHECKER, which is why §0 had to be re-measured after
  `docs/bugs/0807`.
- **To re-apply later** (Actions → "Apply sofa compartment + seat-size corrections" → Run):
  - `target=prod`, `apply=1`, `confirm=I HAVE REVIEWED THE DRY-RUN`
  - or CLI:
    ```
    gh workflow run apply-sofa-compartment-corrections.yml --ref main \
      -f target=prod -f apply=1 -f confirm="I HAVE REVIEWED THE DRY-RUN"
    ```
- After it finishes, read the tail for `VERIFIED` / any `VERIFY FAILED`, then
  re-run the read-only check (§7) to confirm the CSL docs dropped out.

---

## 5. BEDFRAME — TRUE count now measured (run 34557687404, post-#3614, prod)

828 supplier bedframe documents:

| bucket | count | note |
|---|---|---|
| out of scope (no PO here) | 524 | below floor / other supplier — ignore |
| **SIZES DIFFER** | 3 | see below |
| div/gap/leg DIFFER | 19 | ~half are values SWAPPED between the two beds on one PO — a pairing artefact, not a real spec diff |
| agree | 282 | (92 carry SPECIAL free text — not a variant) |

**The 3 size diffs:**
- `HC-PO-009933` supplier `(153X200)+(153X200)` vs ours `(SP)+(SP)` [1 received] —
  likely the SAME bed with different size NOTATION (cm vs "SP"). Judgment call.
- `HC-PO-009990` supplier `(Q)+(Q)+(K)` vs ours `(Q)+(SP)+(Q)` [3 received] —
  **genuinely different** (a K and a SP where the other side has Q). Owner call.
- `HC-PO-010115` supplier `(200X200)` vs ours `(SK)` — likely same (200×200 = super
  king), notation only. Judgment call.

**The 19 div/gap/leg diffs** split into: real gaps where OURS is blank (008506,
009702, 009867, 009932, 009956, 009973, 010153) — fill from supplier; and
values SWAPPED between two same-size beds on one doc (008887, 009709, 009722,
009899, 009924, 010004, 010013, 010102) — since a bedframe line is a whole
independent bed and order carries no meaning, these may be false pairing diffs,
NOT real differences. Verify a couple before treating them as work.

**Bedframe is a SMALL job.** There is no bedframe proposer/apply channel yet;
building one mirrors the sofa channel (proposer → `apply-*`), but for ~3 real
size + ~7 real leg/gap gaps it may be faster to correct by hand in the ERP.
Owner's call on whether bedframe GR needs unblocking now.

---

## 6. STILL OPEN (not started or blocked)

- **11 already-received-stock builds** — owner said 「你也一起改掉」. Changing an
  item_code under received stock strands the lot; the applier refuses it by rule.
  This needs a **stock-aware tool** that moves GRN line + inventory_lots +
  inventory_movements + paperwork together, atomically. NOT built. Do
  MEASURE-first → plan → show owner → apply. Highest-risk item; do not blind-change.
- **Different-supplier proceeded docs** — the "not found" bucket splits into
  (a) below-floor delivered orders (ignore) and (b) proceeded POs from ANOTHER
  supplier. (b) needs that supplier's own photos, read by the TV rule, then
  backfilled. Waiting on owner/other-supplier photos.
- **Accessory (66 rows)** — never compared. Build the equivalent check.
- **Square pillow custom-vs-random colour** — not touched.
- **2 genuine sofa piece diffs** (HC-PO-010086, 010041) — §2, owner call.
- **51 not-proceeded sofas with NO drawing** + **13 undecided drawings** — wait
  for proceed or ask the customer.
- Older backlog: I-000213 invoice (RM 2,549), AutoCount payments since the cut,
  42+21 stock-quantity cells.

## 7. Read-only check to re-run any time (safe, prod, no writes)

```
gh workflow run check-supplier-listing-vs-erp.yml --ref main -f target=prod -f groups=SOFA
```
Then: `gh run view <id> --log | grep "::notice::"` for the buckets.

## 8. Rulings that govern this work (all in session memory)

| ruling | effect |
|---|---|
| supplier is the authority (proceeded orders) | correct OURS to match, no asking |
| unless we amended after their cut (`scm.po_amendments`, REQUESTED counts) | ours is newer; excluded |
| a PO below the migration floor (PO-009122) | old delivered order; ignore |
| a plain REVERSAL = the SAME sofa (`sameSofa`) | not a difference |
| CSL = CONSOLE | supplier's `CSL` is our `CONSOLE`; no `8030-CSL` SKU should exist |
| proceeded + not in listing = ANOTHER supplier | needs their own photos |
| received-stock builds — 「你也一起改掉」 | change them too, but via a stock-aware tool |

## 9. Do NOT fix — assigned elsewhere

- `so-revision.ts:694` — `applySoAmendment` updates item_code, not description.
- `so-revision.ts:1386` — `reviseBoundPo` writes neither item_code nor
  material_name to the bound PO.


---

## 10. THE LEG BACKFILL — shipped as a tool, and why it fills only 28 of 68

`backend/scripts/apply-supplier-sofa-leg.mjs` (+ workflow **"Fill sofa leg height
from the supplier listing"**, + unit tests) writes the supplier's stated leg onto
BOTH our purchase line and its sales line. DRY-RUN by default; `apply=1` needs
`confirm = FILL THE SUPPLIER LEG HEIGHTS`; an APPLY re-reads every line it wrote
on a FRESH connection and prints VERIFY OK / VERIFY FAILED.

**Dry-run against production 2026-09-11: 28 lines over 15 purchase orders TO
FILL, 40 lines over 22 purchase orders HELD.**

**Why the 40 are held, and why that is not timidity.** A sofa's leg height is part
of its INVENTORY IDENTITY — `computeVariantKey` emits `legheight=…` for a sofa —
and of every sofa lot on production, not one carries a leg segment. So writing a
leg onto a line whose goods are already IN moves that line to a stock bucket no
lot has ever been stored under. That is exactly `docs/bugs/0722`: three delivery
orders shipped on "Ship anyway" against an invented `legheight=default`, consumed
no lot and carried no COGS — repaired only yesterday by PR #3624. The gate is
therefore the defect, not caution: a line is filled only while NOTHING has been
keyed off its blank identity (no receipt, no GRN line, no DO line, no allocated
stock). Every held line is printed with which of those pins it.

**To finish the other 40** you need a stock-aware tool that moves the lot,
balance, movement and allocation rows to the new key in the same transaction as
the line — the same tool §6 already owes for the 11 received-stock builds. Do
MEASURE-first → plan → show the owner → apply. Do NOT "just fill them".

## 11. What this round did NOT touch

- The **4 different-piece documents** (§2) — still the owner's call.
- The **15 direction-only documents** — cosmetic; 9 of them carry received stock,
  so correcting the order means touching received lines.
- **Bedframe and accessory** — the owner narrowed this round to sofa
  (「针对 sofa alignment 的就行了」, 2026-09-11).
- The **GRN side**: `check-sofa-chain-alignment` (run 34563508136) shows the
  PO→GRN leg is clean on codes and variants — 0 code mismatches, 0 variant
  mismatches over 654 linked pairs; its 17 build-level differences are partial
  receipts and split deliveries, not disagreements. Nothing to repair there.
