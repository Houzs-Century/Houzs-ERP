# Sofa compartment rulings — the owner, 2026-09-08

**These are the owner's OWN words on his OWN drawings, given while reviewing the
one-page report of sofas whose book text does not settle the build.** They are
the authority. Nothing here was inferred from the text, and nothing here may be
"corrected" by a later parser run: when the book's words and the owner's drawing
disagree, `docs/staff-reported-flow-2026-09-08.md` records that **the drawing
wins**, per his ruling on `SO-013475` this morning.

Each row is a PER-DOCUMENT override. The decoder's rules are NOT changed by any
of them.

| document | model | what the book's words say | what the ERP held | **THE OWNER'S RULING** |
|---|---|---|---|---|
| `HC-SO-013327` | `DSL-8069` | `Size:24"/Col:BO315-7 Peach/Bottom wrap nylon/Seater depth +1"` — no build stated | `1A(LHF)` + `2A(RHF)` + `1NA` | **`1AL + 2AR + 1BR`** |
| `HC-SO-011099` | `HOK-5530` (aliases to 9028) | `2S / colour :BO315-4` | `1A(LHF)` + `1A(RHF)` | **`2S`** |
| `HC-SO-010209` | `9058` | words decode to `2A(LHF)` + `L(RHF)` | `1A(LHF)` + `1NA` + `1A(RHF)` | **`1AL + 1NA + 1L(R)`** |

## How to read his notation, and what to do when it is not obvious

He writes in the shorthand of the order slip, not in ERP piece codes. `1AL` is
the one-seat arm on the LEFT, `2AR` the two-seat arm on the RIGHT, `1L(R)` the
one-seat chaise L on the right. **`1BR` on `HC-SO-013327` is the one that is not
obvious** — it is not a piece code this repo already emits, and the ERP held
`1NA` in that position. **Resolve it against the drawing and the model's own
compartment catalogue before writing anything, and if it still does not resolve,
ASK HIM — do not map it to the nearest-looking code.** Writing the wrong piece is
the failure this whole page exists to prevent.

## Two of these are NOT new defects, and the distinction matters

`HC-SO-011099` and `HC-SO-010209` were both decided from the same drawings in
August, and `HC-SO-010209` **is already delivered**. So the ERP's value did not
drift — it was read off the slip once, and he is now reading the same slip again
and correcting it. Treat these as a corrected reading, not as a regression, and
say so wherever the change is recorded.

## Standing rules these sit under

- 「一律跟账本。除了sofa compartment而已啊」 — the book decides everything EXCEPT
  the sofa build, which is his.
- 「都要跟Autocount一样」 (2026-09-08) — every other axis matches the book.
- The drawing beats the book's words when they disagree (`SO-013475`, this
  morning) — and it is a per-document override, never a change to the rule.

**More rulings are expected: he is going through the report card by card.**
Append them here as they arrive, with his words quoted exactly.

---

## What was WRITTEN, and what was not — `fix/apply-sofa-rulings`, 2026-09-08

Two of the three are in production. The third is parked with his answer intact.

| document | his ruling | ERP now holds | run |
| --- | --- | --- | --- |
| `HC-SO-013327` | `1AL + 2AR + 1BR` | **`1A(LHF)+2A(RHF)+1B(RHF)`** | apply `34221548817` |
| `HC-PO-010081` (its purchase order) | same build | **`1A(LHF)+2A(RHF)+1B(RHF)`** | carried in the same run; re-run `34221653216` confirms all three pieces `keep` |
| `HC-SO-010209` | `1AL + 1NA + 1L(R)` | **`1A(LHF)+1NA+L(RHF)`** | apply `34221462031` |
| `HC-SO-011099` | `2S` | `1A(LHF)+1A(RHF)` — **NOT written** | held, see below |

Each apply re-read its document on a fresh connection and asserted the piece
multiset and BOTH money columns; money did not move on any of them
(`460000/460000`, `388800/388800`, `0/0`).

### `1BR` resolved, and it did NOT need him again

The open question this page raised — *"`1BR` is the one that is not obvious ...
if it still does not resolve, ASK HIM"* — was answered without a second
interruption:

- **His own words settle the piece.** Asked what `1BR` meant he answered
  **`1B（RHF）`**.
- **`B` is the decoder's own vocabulary, not an invented code.**
  `scripts/lib/parse-sofa.mjs:609` emits `nB(LHF|RHF)` for the `B` token, and
  `8069-1B(LHF)` is already the lead piece of `HC-SO-013329` in the same
  corrections file.
- **`8069-1B(RHF)` EXISTS as a product.** Proven by the apply itself: the
  piece-SKU gate refuses a build whose target is not minted, and the run planned
  and wrote this one (`piece SKU not minted 0`).

### `1L(R)` is the chaise, written `L(RHF)` with NO count prefix

His slip shorthand carries a count (`1L`); the ERP's code for the chaise does
not. `parse-sofa.mjs:602` emits `L(LHF)`/`L(RHF)`, and `:545`/`:557` fold a `1L`
standing beside other pieces into ONE chaise. So `1L(R)` is `L(RHF)`, and a
minted `1L(RHF)` was never invented to match the spelling.

### `HC-SO-011099` is NOT written, and his ruling is not in doubt

The build collapses two rows into one, and the sales order's dropped row is the
dedication target of a line on `HC-PO-009882`, so the write is refused. Writing
only the purchase-order half WOULD have succeeded and is exactly why it must not
run: the factory's document would say `2S` while the customer's still said
`1A(LHF)+1A(RHF)`. The ruling now sits in the corrections file's `_held` list,
printed on every run so it cannot be mistaken for done. Full trace and what a fix
must do: `docs/bugs/0719`.

### The two in production, and what the factory holds

`HC-SO-013327` and `HC-SO-011099` are `IN_PRODUCTION`; `HC-SO-010209` is already
delivered. Inside the ERP the sales order and its purchase order now state the
SAME build for `HC-SO-013327` — they were corrected together and the chain audit
did not move. What the ERP cannot fix is the paper already at the factory: that
purchase order was raised before the ruling, so it states the old build. That is
a separate action for the owner and it is named in the PR rather than buried.

### These were corrected READINGS, not regressions

`HC-SO-010209` and `HC-SO-011099` were decided from the same drawings in August.
The ERP's value never drifted — he re-read his own slips and changed his answer.
Every `why` in the corrections files says so, so nobody logs a fault that never
happened.

### The report can no longer show him a question he has answered

`docs/bugs/0714-the-reconcile-reports-a-sofa-the-owner-has-already-ruled-on.md` is fixed in the same PR: the reconcile now reads these
corrections files and reports a written ruling as **`RULED`**, its own column,
never folded into `AGREE`. A ruling that has NOT been written stays `DIFFER` and
names the answer it is failing to match.

---

# ROUND 2 — he read his own slips one by one and gave SIXTEEN answers

**「所以全部答案我都给你了」** and **「给你全部了 然后你也可以用description2验证你自己的
答案看是不是对的」** — 2026-09-08. He was annoyed while doing it (**「为什么这种你也不懂
呢？」**) because most of what had been escalated to him was readable. The rules he gave
alongside the answers are below, and they are the point: **they exist so this class never
comes back to him.**

Sixteen builds on **fifteen** documents (`HC-SO-004709` and `HC-SO-012827` each hold two
sofas). All fifteen were in the tally's *cannot be compared* list on run
**`34233001504`** — the book's own text does not state a build, so his drawing was the
only source.

| document | his words, verbatim | written as | seat |
|---|---|---|---|
| `HC-SO-012108` | 「这个是8030 / 1AL+1NA+LR 35寸」 | `1A(LHF)+1NA+L(RHF)` model 8030 | 35 |
| `HC-SO-004709` ① | 「一个是2s 35" 要left wooden arm」 | `2S` model 5527 | 35 |
| `HC-SO-004709` ② | 「一个是1s 30寸」 | `1S` model R819 | 30 |
| `HC-SO-008683` | 「2AL+C+2NA30寸」 | `2A(LHF)+CNR+2NA` model 7233 | 30 |
| `HC-SO-010121` | 「第二个是1AL+1NA+1AR 32寸」 | `1A(LHF)+1NA+1A(RHF)` model 8051 | **not written — see below** |
| `HC-SO-011158` | 「第一个是1AL+C+1NA+1AR」 | `1A(LHF)+CNR+1NA+1A(RHF)` model 9050 | — |
| `HC-SO-011268` | 「第二个是2AL+1AR」 | `2A(LHF)+1A(RHF)` model 9028 | 28 |
| `HC-SO-011434` | 「1BL+1BR」 | `1B(LHF)+1B(RHF)` model 9058 | 32 |
| `HC-SO-011447` | 「然后1AL+C+1NA+1AR」 | `1A(LHF)+CNR+1NA+1A(RHF)` model 9058 | — |
| `HC-SO-011454` | 「这个是1AL+C+1NA+1AR」 | `1A(LHF)+CNR+1NA+1A(RHF)` model 9058 | — |
| `HC-SO-011455` | 「第二个是1AL+C+2AR」 | `1A(LHF)+CNR+2A(RHF)` model 9050 | — |
| `HC-SO-011601` | 「第一个是corner 你也应该懂的 32寸seat」 | **NOT WRITTEN — partial, see below** | 32 |
| `HC-SO-011657` | 「第二个是stool」 | `STOOL` model 9838 — **blocked, see below** | — |
| `HC-SO-012026` | 「1AL+1NA+1NA+C+1AR」 | `1A(LHF)+1NA+1NA+CNR+1A(RHF)` model 9058 | — |
| `HC-SO-012827` ① | 「第二个是1AL+1NA+1AR+1s」 | `1A(LHF)+1NA+1A(RHF)` model 8030 | 35 |
| `HC-SO-012827` ② | 「…+1s」 (the separate chair) | `1S` model 8030 | 35 |
| `HC-SO-012947` | 「L（LHF）+2AR」 | `L(LHF)+2A(RHF)` model 9058 | — |

His shorthand maps `AL`→`A(LHF)`, `AR`→`A(RHF)`, `BL`→`B(LHF)`, `BR`→`B(RHF)`,
`LR`→`L(RHF)`, `C`→`CNR`, `2s`→`2S`. The chaise carries **no count prefix** in the ERP,
so `LR` is `L(RHF)` and not `1L(RHF)`.

## His reading rules — these are the durable part

Apply them; **do not ask him again.**

- **Three boxes inside ONE outline = `2+1`. Three boxes drawn SEPARATELY = `1+1+1`.**
  His own discriminator (`HC-SO-010458`, `HC-SO-011114` = `2+1`; `HC-SO-013475` = `1+1+1`).
- **The piece AT THE TURN of an L is a CORNER.** A chaise (`L`) runs OUT from the turn.
- **A deeper box is NOT automatically a chaise** — he ruled `HC-SO-011268`'s deeper right
  box `1AR`.
- **No arm drawn ≠ `NA`** — `HC-SO-011158`'s slip draws no arms at all and he put arms at
  both ends. **No hatching decides nothing** (`HC-SO-011455`).
- **No seat size written ≠ undecidable** — `011158`, `011447`, `012026` had none and he
  ruled them anyway.
- **Numbers inside the boxes may be WIDTHS, not seat depth** — `HC-SO-008683`'s `70"`/`53"`
  are widths; the seat is 30.
- **A note about the ARM REST is not a statement about the piece** — `011454` says
  `arm rest take off` and he still ruled arms at both ends.
- **A backrest note is not a model change** — `012108` (`back rest change to 9058`, model
  stays 8030) and `012947` (`backrest change 9028`, model stays 9058). Seen twice.
- **`tbc side` on a slip is not unanswerable** — `012947` says it and the drawing still
  told him the chaise is on the left.
- **Not every sofa slip is a sofa** — `011657` is a 6ft x 3ft box labelled
  `umbrella fabric cover`; it is a STOOL.
- **A notation the decoder does not know (`2G1F`, `3S`, `B`, `R`) is a decoder gap, not a
  question for him.**
- **Where the slip's model and the book's item code disagree, the SKU axis follows the
  book** — `011434`: slip `9028`, book `DSL-9058` → the book.
- **`5535` is its own model and is NEVER aliased.**
  `SOFA_MODEL_ALIAS = { 5530: 9028, 5536: 9058, 5537: 8030, 5540: 8030 }`.

## Where his answer and the book disagree — and what wins

「一律跟账本。除了sofa compartment而已啊」 — the book decides everything **except** the
sofa build.

- **`HC-SO-004709` ①: the book says `3S(35")`, he ruled `2S`. HIS ANSWER STANDS.** Do not
  "correct" it back to the book — the compartment axis is his.
- **`HC-SO-008683`: the decoder's own `2G1F` rule gives `2A(LHF)+CNR+1A(RHF)`, he ruled
  `2NA` for the third piece. HIS ANSWER STANDS** — and it is a per-document override, **not**
  a change to the `2G1F` rule.
- **`HC-SO-010121` is the one exception, and it is deliberate.** He said **32寸**; the book
  says **31 inch**. Seat is *not* a compartment, so by his own rule the book wins and the
  seat was **left alone**. Writing 32 would also have opened a fresh difference on an axis
  that reads 0 across all 2,882 documents. **If the drawing really says 32, then the BOOK is
  what needs correcting** — that is a book edit, not an ERP one. **One sentence from him
  settles it.**

## `HC-SO-011601` is NOT written — his answer is partial, not unclear

「第一个是corner 你也应该懂的 32寸seat」 names **the piece at the turn** and **the seat**.
It does not name the rest of the build, and the book's Desc2 for `SO-011601`
(DtlKey `802011`, `AMN-SF9050 SOFA`) is just `bottom wrap to Nilon` — no build at all.
Inventing the remaining pieces around a corner he did name is precisely the failure this
page exists to prevent, so **nothing was written**. This is the ONE document from this round
that still needs him, and it needs **one line**, not a re-reading of everything.

## `HC-SO-012827` needed a new way to address a line

The book wrote its two sofas so that **one Desc2 is a substring of the other**:

```
DtlKey 873100   "3 seater  35 inch  color modenza 07 silver  Nilon bottom"
DtlKey 873101   "35 inch  color modenza 07 silver  Nilon bottom"
```

No `desc2Match` can address the shorter line alone — every candidate reaches both and the
matcher refuses as `ambiguous`, **correctly**. Choosing by position, or by "the shorter
text", is the transposition class `docs/bugs/0690` names.

So the corrections file now accepts **`lineKeys`** — the account book's **own `DtlKey`**,
already carried on `scm.mfg_sales_order_items.linked_ac_dtlkey`. It is identity, not
resemblance. It **never falls back to the text**: a key the document does not carry is
`none`, because quietly matching by text instead is the exact bug the mode was added to
prevent. Mode and tests: `backend/scripts/lib/sofa-desc2-match.mjs`.

**The containment only bites the SHORTER line, and the dry run proved which half needs
what.** `3 seater` is carried by DtlKey 873100 and by nothing else on the document, so the
three-seater is addressed by plain text. The single chair has no such needle and is
addressed by its line key. And the prod dry run (`34234942367`) showed why that split is not
merely tidy: **the ERP does not carry line key `873100` at all** — of this document's four
sofa lines only `873101` is stamped — so the key could not have addressed the three-seater
even if it were preferred. That unstamped line is a finding in its own right:
`docs/cutover-sofa-line-keys-2026-09-08.md` records that a sales order holding a line with
no AutoCount line key is **uneditable for staff**, and this is one of them.

## The decoder vocabulary was NOT the problem — measured, not assumed

The brief for this lane predicted that teaching the decoder the `R` (recliner) and `B`
tokens would close a large slice of the pile "with no drawing-reading at all", on a count of
**305 book rows** containing them. **That was checked before any code was written, and it is
wrong in the direction that matters: those rows already decode.**

```
parseSofa("1R+2R+3R", 9028, recl)      -> 1A(R)(LHF), 2A(RHF), 1A(R)(LHF), 2A(RHF)
parseSofa("1B+1B", 8069)               -> 1B(LHF), 1B(RHF)
parseSofa("1B+C+2R", 9058, recl)       -> 1B(LHF), CNR, 2A(RHF)
parseSofa("2A(LHF)+1B(RHF)", 8069)     -> 2A(LHF), 1B(RHF)
parseSofa('2R(30")+C.Table+1R(22")')   -> 2A(LHF), CNR, 1A(R)(RHF)
```

`parse-sofa.mjs` already emits `A`, `NA`, `L`, `CNR`, `B`, `R`, `P`, `Console`, `CT` and
`STOOL`. Running the decoder over **every sofa line of the 45 unreadable documents** gives:

| | lines |
|---|---|
| decode today | 6 |
| fail on an unknown TOKEN | **4** |
| fail because **the book states no build at all** | **47** |

The four unknown tokens are `2G1FCLR`, `1INCH`, `3SEATERCOLORMODENZA07SILVERNILON` and
`NOSTICHINGBETTWENTWOSEAT` — every one a phrase **glued to its neighbour**, not a missing
piece type. And `2G1FCLR`'s document (`HC-SO-008683`) is one he ruled anyway, **against**
what the decoder would have produced.

**So the pile is not a vocabulary gap. It is 47 lines where the account book simply does not
say what the build is** — which is exactly what the verdict has been reporting: *"the
account book's own text does not say what the build is, so your drawing is the only
source."* No decoder change was made in this round, because none would have closed a single
document.


## `HC-SO-011657` is blocked on a product that does not exist yet

His answer is not in doubt and is written into the corrections file. The prod dry run
(`34234942367`) refused it for one reason:

```
HC-SO-011657: REFUSED - piece SKU not minted: 9838-STOOL
```

`9838-STOOL` simply is not in `scm.products`. Minting a product code is a **catalogue**
change, not a compartment correction, so this lane did not do it unilaterally. It needs one
action from whoever owns the product list; after that this entry applies unchanged, with **no
re-reading and nothing more from him**.
