## A retired tombstone row hid the live fabric it had been merged into, and only on the computer [high]

**Symptom.** Owner 2026-09-11, on an amendment to `HC-SO-013497`:
「为什么还是找不到HR805-90」 — the picker offered `HR805-40 / -31 / -20 / -30 /
-09` and not `-90`, on a line that already carries `HR805-90`. `-10` was missing
too. On a PHONE the same fabric was pickable.

**Root cause (traced).** `scm.fabric_trackings` is keyed by `id`, not by
`fabric_code`, and **21 codes carry TWO rows for the same code** — one active
beside one retired, usually a plain id next to a `FABRIC_`-prefixed twin:

```
FABRIC_HR805-90  HR805-90  is_active=true
HR805-90         HR805-90  is_active=false   "FABRIC [merged into HR805-90 on 2026-08-11]"
AVANI_01         AVANI-01  is_active=true
AVANI-01         AVANI-01  is_active=false   "AVANI-01 [merged into AVANI-01 on 2026-08-11]"
```

`SoLineCard` built its hidden set from the retired ROWS alone —
`fabrics.filter(f => f.is_active === false).map(f => f.fabric_code)` — so **the
dead twin hid the live fabric**. MEASURED on production: the filter hid **21**
active colours and **all 21 were hidden WRONGLY** (an active row exists for every
one). Zero legitimate hides. The filter was doing nothing but harm.

`MobileNewSO`'s fabric sheet has no such filter, so the same fabric was pickable
on a phone and missing on a computer — which is how the owner found it.

**The data is NOT the defect, and was not changed.** All 21 pairs differ only in
`fabric_description`; price, stock-on-hand, PO-outstanding and supplier are
identical (and zero) on both rows. The retired rows are deliberate TOMBSTONES
from a de-duplication pass on 2026-08-11 — the same day, and the same hand, as
the `GARFIELD ` library merge in docs/bugs/0817 — kept on purpose ("merged into
… not deleted"). Deleting somebody's audit trail to work around a filter asking
the wrong question would be the wrong repair.

**Fix.** The rule moved to `GET /fabric-colours` and is asked **per CODE**: a code
is retired only when NO active row carries it. `retiredByCode(rows, codeField,
activeField)` serves both tables — `fabric_trackings` by `fabric_code`/`is_active`
and `fabric_library` by `id`/`active` (0817's rule is now one call into it).

- It lives on the SERVER, not in the two clients, for the reason the owner gave:
  「它只要有启用，就有打开」, one rule. The desktop no longer filters and the
  mobile sheet gets the rule for free — no extra fetch on a phone, and no way for
  the two surfaces to disagree again.
- An unreadable stock register degrades to the OLD behaviour (every active
  colour), never to an empty picker.
- 19 cases pinned, including the production rows verbatim and one that keeps the
  OLD per-ROW computation beside the new one as an executable contrast.

**THE SAME MISTAKE, THREE TABLES, ONE DAY.** This is the third instance:
`allowed_options.fabrics` compared a colour against a series (0814),
`fabric_library.active` let a retired whitespace twin retire its live sibling
(0817), and `fabric_trackings.is_active` let a retired tombstone hide the live
row it was merged into (this one). The shape every time: **a flag asked PER ROW
when the question is about a CODE.** Where a table is keyed by something other
than the code people think in, `count(*) > 1` per code is the first thing to
measure.

**Ref.** `fix/inactive-code-poisoned-by-duplicate`, 2026-09-11.
