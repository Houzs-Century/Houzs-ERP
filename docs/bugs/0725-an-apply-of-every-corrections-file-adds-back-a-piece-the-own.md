## An apply of every corrections file adds back a piece the owner removed a round later [high]

<!-- status: open -->

<!-- area: AutoCount sync + write-back -->

**白话.** `HC-SO-012929` 那张沙发，老板八月看图说是三件，九月再看同一张图，说少一件，
把那件拿掉了。ERP 现在是他九月的答案，是对的。**但是八月那笔记录还留着** —— 如果有人
一次过跑全部修正档，程式会先照八月的把那件加回去。**读报告的那边已经改成「以最新的
为准」，写资料的那边还没有。** 一个说最新的算，一个照顺序全跑一遍，两边不一样。

**Symptom.** Dry-run `34243523350`, over every corrections file, plans BOTH of
these on one document:

```
line 228:  HC-SO-012929  [sofa-compartment-corrections-2026-08.json]
             9028  1A(LHF)+2A(RHF)  ->  1S+1A(LHF)+2A(RHF)
             add    1S
line 444:  HC-SO-012929  [sofa-compartment-corrections-2026-09.json]
             9028  1A(LHF)+2A(RHF)  ->  1A(LHF)+2A(RHF)
```

The ERP holds `1A(LHF)+2A(RHF)`, which is the owner's SEPTEMBER answer and is
correct. The August entry is superseded and still live, so an unscoped apply
INSERTS the `1S` he removed.

**Root cause (traced, and it is a half-finished fix rather than a new fault).**
`lib/sofa-rulings.mjs` — the READER — was taught on 2026-09-08 that the newest
ruling wins, and its own comment says why:

> THE NEWEST RULING IS THE RULING. Two entries can match one build — he re-reads
> a slip and corrects himself, and the later file carries the correction. So the
> LAST match wins, not the first.

`apply-sofa-compartment-corrections.mjs` — the WRITER — has no such rule. It
loops `DATA.builds` in load order and applies each in turn, so for a document
ruled twice it applies BOTH, oldest first. The two halves of the same lane now
disagree about what the owner's answer is, which is `docs/bugs/0708`'s class
exactly: two tools answering the same question differently.

**Why the second entry does not simply undo the first, and why that is not a
defence.** It might: the September pass re-reads the document, finds three rows
where its build wants two, and the surplus row would be deleted if nothing
points at it. That is UNVERIFIED — no run has been made that applies both in
sequence — and it is the wrong thing to rely on either way. It depends on
`splitBuildCopies` reading three rows as one sofa rather than refusing them as
an uneven division, on the inserted row not being the one paired to a target
piece, and on the delete not being blocked. A correct end state reached by two
opposite writes is not a correct process, and the intermediate state is written
to production.

**What has been done about it in the meantime.** Nothing in the data was
changed by this lane — the August entry is another lane's record and deleting
someone else's evidence mid-cutover is worse than the hazard. Instead **every
apply dispatched from `fix/so-last-6-and-gr-transpose` is scoped with `DOC=`**
to the single document it is correcting, so no run of this lane's touches
`HC-SO-012929` at all.

**What a fix must do.** Give the writer the reader's rule: before applying,
collapse `DATA.builds` to ONE build per (document, address) — where the address
is the `desc2Match` or the `lineKeys` — keeping the LAST, exactly as
`makeSofaRulingLookup` does. It must be the same rule in both places and ideally
the same function, because the reason this happened is that it was written twice.
Until then, `FILE=` and `DOC=` are the only safe way to run it, and an unscoped
apply must not be dispatched.

**Ref.** Found while dry-running `fix/so-last-6-and-gr-transpose`, 2026-09-08.
Dry-run `34243523350`, lines 228 and 444.
