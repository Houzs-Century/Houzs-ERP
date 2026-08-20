## The cutover stock import dropped every NEGATIVE AutoCount balance row, leaving the ERP permanently higher [low]

**Symptom** - the stock truth check reported `VERDICT BALANCE: DIVERGES` on 35
cells / +104 units against live AutoCount, which read as phantom stock. Most of
it turned out to be AutoCount trading on after the cutover, but 6 cells / 13
units did not reconcile to any AutoCount movement.

**Root cause (traced, not guessed)** - `import-ac-stock-balance.mjs:129` sorts
each cell into `plan` or `negs` by the sign of the delta, and `:137` decides what
is actually written:

```js
(delta > 0 ? plan : negs).push({ ... });
const todo = NEG ? [...plan, ...negs] : plan;
```

The cutover ran WITHOUT `NEG`, so every negative delta was logged and discarded.
Where an AutoCount item carries a negative on-hand at a location, the ERP kept
the positive contributor's full quantity and never subtracted the negative one.
It is invisible in the check's existing AC-NEGATIVE bucket because that bucket
only fires when the MAPPED TOTAL is negative - here a negative row is folded
together with a positive one under a many-to-one item mapping, so the total
stays positive and the negative is silently absorbed.

Verified per cell against live AutoCount over read-only ODBC. In every one the
unaccounted amount equals exactly the magnitude of the dropped negative row:

```
SQUARE PILLOW  @ KL  ERP 46 vs AC 38  (+8)  RDS-SQUARE PILLOW @ KL carries +8 AND -8
HILTON (A)-(Q) @ KL  ERP  4 vs AC  3  (+1)  NB-KHJ50(Q)  @ KL = -1
FENRIR-(Q)     @ PG  ERP  2 vs AC  1  (+1)  HOK-1005 (Q) @ PG = -1
VICTORIA-(K)   @ KL  ERP  1 vs AC  0  (+1)  NB-KHJ21(K)  @ KL = -1
REGAL (A)-(Q)  @ PG  ERP  3 vs AC  2  (+1)  NB-NH36 (Q)  @ PG = -1
ELEGANT (A)-(Q)@ KL  ERP  3 vs AC  2  (+1)  NB-KHJ33(Q)  @ KL = -1
```

8 + 1 + 1 + 1 + 1 + 1 = 13, which is the whole unexplained bucket. Nothing else
in the stock balance is unaccounted for.

**Fix** - NOT repaired here; this lane measures only. The check now separates
divergence AutoCount caused from divergence we caused, so the 13 units are
visible as their own bucket instead of buried under +104. Whoever repairs it
should decide with the owner whether a negative AutoCount on-hand should even be
represented - the ERP ledger cannot hold one, which is why it was skipped in the
first place.

**Ref** - prod run 31452269844 (read-only), 2026-08-11.
