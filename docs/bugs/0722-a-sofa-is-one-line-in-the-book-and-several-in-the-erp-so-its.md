## A sofa is one line in the book and several in the ERP, so its key was sent twice [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Two delivery orders — `HC-DO-2609-004` and `HC-DO-2609-009` — were
refused with a sentence that describes a different fault than the one they had:

> of 3 line key(s) given, only 2 exist on a SO - refusing to transfer a set the
> book does not recognise

They were the last two of the ten stuck documents; the other eight went into the
account book once the transfer used AutoCount's documented call
(`docs/bugs/0716`). These two never had that fault.

**Root cause — nothing was missing, and the sentence is why nobody saw it.**

`readConvertSourceKeys` built the key list ONE ENTRY PER ERP LINE. AutoCount
holds a sofa as a single line; the ERP decomposes it into a line per piece, and
every piece correctly carries that one line's `DtlKey`. So the payload was

```
DtlKeys: [901830, 901830, 901831]
```

and the host's `KeysBySourceDoc` compared the ROW COUNT the book returned (2)
against the ARRAY LENGTH it was handed (3) and threw. All three keys are real;
two are the same one.

**Measured, not inferred.** The probe named the keys — nothing else could,
because `KeysBySourceDoc` throws before the host's per-key dump ever runs:

```
HC-DO-2609-004  sent 3 key(s): 901830, 901831, 901830
    key 901830  ERP rows holding it - SO 2 / DO 0 / PO 0 / GR 0
```

and `sqlcmd` against `AED_HOUZS` said what those keys are:

```
SO-013224   901830  HOK-5535 SOFA      Qty 1
            901831  HOK-LONG PILLOW    Qty 3
SO-012563   856404  AMN-SF9028 SOFA    Qty 1
            856405  AMN-SQUARE PILLOW  Qty 3
```

**The duplicated key is the SOFA in both cases.** This is not a data defect —
the decomposition is deliberate and documented
(`docs/autocount-integration-map.md` §4.2).

**Two wrong answers were given to the owner before this one, and both were
retracted the moment something was measured:** first that a source line carried a
key the book had dropped, then that the ERP had added a line AutoCount never
received. The book's own rows refuted both.

**Fix.**

* **Merge by KEY, first-seen order.** Several ERP lines claiming one book line
  send that key once.
* **A shared key NEVER carries a quantity.** The two sides count in different
  units — the ERP's pieces each say 1, the book's sofa says 1 sofa — so summing
  would send 2 against a line of 1, an over-transfer of a licensed account book.
  Whole, no quantity is needed: the service moves each named line's outstanding.
* **A part-shipped sofa is REFUSED, not approximated.** "Two of the three pieces"
  has no shape in a document holding one line of one unit.
* **The untaken siblings are read**, because the taken set cannot see them: a
  delivery shipping one of two pieces sees the key once and looks 1:1. The read
  needs no parent predicate — a `DtlKey` identifies one line of one document, so
  every ERP row carrying it belongs to that same book line.
* The 1:1 case is untouched: a genuine part-quantity shipment still sends
  `Details[]` exactly as before.

**THE OWNER'S RULING, 2026-09-08 — option C.** Asked how a part-shipped sofa
should behave, he chose: **the sofa's own line waits for the delivery that
completes it while every other line on the document goes on time**, and
completeness is judged on the sofa's own pieces only — 「C 除了accessories 不看
就看sofa」, so a pillow still in the warehouse does not hold the sofa back. That
is NOT BUILT YET; the refusal above is what stands in for it, and it is loud and
recoverable rather than quiet and wrong.

**Verified.**

* `autocount-convert-lines.test.ts` — 4 new tests: the shared key is sent once
  and in first-seen order; no quantity rides with it; a part-shipped sofa is
  refused; and a document with no shared key still sends its quantities.
* `autocount-convert-lines.test.ts` + `autocount-outbox.test.ts` +
  `autocount-convert-payload.contract.test.ts` — **142 passed**.
* `npm --prefix backend run typecheck` clean.

**UNTESTED against the live book.** The two documents have not been re-sent under
this build.

**No host deploy is needed** — this is the ERP side. That is worth noting because
the previous fix in this chain was not.

**The lesson.** The host's message counted rows against array length and reported
the difference as "does not exist". A count cannot tell a missing key from a
repeated one, and the wording chose one of those and stated it as fact — which
sent two investigations after a line that was never lost. **A diagnostic that
names a cause must be able to distinguish it from its neighbours, or it should
report the measurement and let the reader name the cause.**

**Ref.** fix/sofa-shares-one-book-line, 2026-09-08. Follows
`docs/bugs/0716-every-so-to-do-transfer-used-an-undocumented-autocount-call.md`.
