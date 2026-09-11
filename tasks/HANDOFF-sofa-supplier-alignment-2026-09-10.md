# HANDOFF — sofa/bedframe alignment to the supplier listing

**Updated 2026-09-11 ~03:10Z, at the owner's request to swap this to another person.**
Read this top-to-bottom; it is written so a stranger can continue without the chat.

---

## 0. The one question the owner keeps asking: 「现在去做 GR 行不行？」

**PROVEN, plain answer (run 34556640759, read-only, prod, 2026-09-11 03:00Z):**

- **Sofa COMPARTMENTS (pieces) are aligned.** Of 139 supplier sofa documents,
  only **4** still differ on pieces, and **2 of those 4 are just the word CSL vs
  CONSOLE** (same part — see §2), now fixed on `main` and waiting for one
  re-apply. So GR on sofa **pieces** is safe for the vast majority today.
- **Sofa SPEC (leg height) is NOT fully aligned.** **35** documents show the
  supplier's leg height (mostly `6`, some `1`/`2` inch) while OUR line is
  **blank**. If your GR checks leg height as part of the spec, those 35 will
  still look wrong. The corrections for these EXIST in our files but did not land
  — see §3 for exactly why and what to do.
- **Direction (line order):** 13 documents list the same pieces in a different
  order. This does **not** change item codes or quantities, so it does **not**
  block a GR; it is cosmetic ordering. Most are already-received stock anyway.

**So: sofa GR is safe on pieces now; the remaining blocker a receiver will see
is the blank leg-height on those 35 docs.** Bedframe/accessory GR is NOT yet
aligned (§5, §6).

---

## 1. What is DONE and LANDED

| item | evidence |
|---|---|
| First production apply of the whole line of work — 293 builds, 774 lines updated, 9 added, 0 money moved, VERIFY OK | apply run **34507126629**, 2026-09-10 |
| 4 TV-round mirror fixes (HC-SO-012368/-012760/-013075/-013239) | in that run |
| **CSL = CONSOLE** — supplier writes `CSL`, our catalogue mints `CONSOLE`; 4 supplier-listing entries + others remapped across 3 data files | **PR #3613, MERGED 03:01Z**. On `main`: 0 CSL / 4 CONSOLE entries |
| **Bedframe check: compare div/gap/leg as NUMBERS not strings** — the inch mark `"` was faking 296 diffs | **PR #3614, MERGED 03:03Z** |

---

## 2. Current PROVEN sofa divergence (run 34556640759, prod, SOFA only)

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

## 3. THE LEG-HEIGHT GAP — the 35, why they did not land, and the fix (MOST IMPORTANT REMAINING SOFA WORK)

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

## 4. THE RE-APPLY — ready NOW, do this first

CSL=CONSOLE is on `main`. A re-apply is idempotent (per-build transactions,
RE-RUN header) — the 293 already-applied builds are inert; the console builds and
anything newly writable land.

- **Dry-run run 34557078481 (apply=0, prod) — CLEAN**: builds touched 289,
  lines updated 784, added 1, **piece-SKU-not-minted 0** (was 6 — CSL now mints
  as CONSOLE), **0 money moved**, refusals all by-design (19 real-stock, 3
  downstream, 1 seat).
- **APPLY dispatched 03:14Z: run 34557669854 (apply=1, prod).** [status folded in
  below once VERIFY is read — check `gh run view 34557669854 --log | grep VERIF`.]
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
