## The supplier sofa proposer counted the documents it could not correct and never named them [high]

**Symptom.** The owner, 2026-09-14, on `HC-PO-010087`: 「为什么又有一张单不 tally
呢？」 — and then, told why: 「那这些都要处理吧 要不然之后又跑出来」.

`HC-PO-010087` was not new. It had sat in a skip bucket of
`propose-supplier-sofa-corrections.mjs` since 2026-09-10, and so had others. Each
time one was found by some other route it read as a fresh defect.

**Root cause (traced to the lines).** The proposer skips a supplier document
into one of several buckets it cannot correct, and printed each as a COUNT:

```
   WE AMENDED IT AFTER THEIR CUT      1
   build not identified by one key    5
      of those, no sales order found  0
      sales order found but KEYLESS   0
```

The documents were collected for some (`amendedList`) and not printed, and not
collected at all for the rest (`stats.ambiguousKey += 1; continue;`). A count
with no names is a backlog nobody can work. Production run 34798747831 on
2026-09-14 still read exactly this: 5 unnamed "not identified by one key", 1
unnamed amended.

**A second invisibility of the same family.** A row with NO book line key sitting
beside keyed rows of the same build is never selected by a correction addressed
by that key — so it is never matched and never removed. `HC-PO-010041` carried
two duplicate pieces (`9058-1A(RHF)`, `9058-1NA`, added 2026-09-10 with no key
and no sales link) while its own correction entry reported nothing to do,
because the three keyed rows already matched.

> **CORRECTED 2026-09-15 — the two sentences above name the wrong pair.** Read-only
> probe run 34878571364: the rows added 2026-09-10 17:44Z (`line_no` NULL,
> `so_item_id` NULL) DO carry key `914330`; the KEYLESS pair is lines 2 and 3,
> added 2026-09-07, and those are the ones dedicated to `HC-SO-013312`. The
> mechanism is the reverse of "never removed": the key selected line 1 alone,
> so apply run 34507126629 read 1NA and 1A(RHF) as missing and INSERTED the
> duplicates. Deleting "the keyless rows" as written here would have removed the
> dedicated lines. The duplicates were removed by
> `remove-duplicate-sofa-po-rows-2026-09-15.mjs`, and the kept pair given the
> build's key, so a key-addressed re-run cannot add them again.

**Fix.** Every skip bucket keeps and prints its documents with the reason — the
amended PO with its amendment number, status and date; each "not identified by
one key" PO with ours and the supplier's pieces side by side and why it could not
be addressed; each no-sales-order and keyless-sales-order PO. And a new line
names every purchase order carrying keyless rows beside a keyed build, which is
the class a key-addressed correction cannot reach.

This does not correct those documents; it makes it impossible for them to be
forgotten, which is what let them come back.

**Ref.** fix/proposer-names-every-skip, 2026-09-14. Related:
`docs/bugs/0845-the-options-census-read-only-half-…` (a checker that could not
see part of its input).
