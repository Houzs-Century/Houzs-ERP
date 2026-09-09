## The raw column count printed the new rule's answer under the old rule's label [low]

**Symptom.** Two read-only checks were dispatched against production within a
minute of each other on 2026-09-08 and disagreed about the same number:

```
check-so-open-for-new     run 34222087196
  (raw `linked_ac_docno IS NOT NULL` count, which is NOT the predicate: 2882 of 2883)

check-so-migrated-shape   run 34222090288
  linked_ac_docno IS NOT NULL — the OLD predicate's "migrated": 2883
  linked_ac_docno IS NULL     — the OLD predicate's "new":      0
```

The census is right: 2,883 of 2,883 company-1 sales orders carry the column. The
other line is the count by the NEW rule (2,882 came FROM AutoCount) wearing the
OLD rule's label.

**Root cause (traced).** One line, in the fix that had just landed for
`docs/bugs/0716`:

```js
const linked = headers.length - native.length;   // native = NOT migrated by the NEW rule
log(`(raw \`linked_ac_docno IS NOT NULL\` count ... ${linked} of ${headers.length})`);
```

`native` is `headers.filter((r) => !soIsMigratedShape(...))`, so `headers.length
- native.length` is the count of documents that came FROM AutoCount. Subtracting
the new rule's complement can only ever give the new rule's answer. The line was
added specifically so a reader could compare this check's output against the old
runs — which is exactly the comparison it made wrong.

**It was found by running both checks and reading them side by side**, which is
the only reason a one-line discrepancy in a parenthesis was noticed at all.

**Fix.** Count the column:

```js
const linked = headers.filter((r) => r.linked_ac_docno != null).length;
```

**Lesson, and it is the smaller sibling of 0716's.** A number derived from the
NEW definition can never carry the OLD definition's label, however the sentence
is worded. If a line exists to let somebody compare two definitions, it has to
compute BOTH of them from their own definitions — a subtraction between them is
a third thing that looks like either.

**Ref.** fix/openfornew-raw-label, 2026-09-08. Follows
`docs/bugs/0716-the-check-that-proves-new-orders-save-counted-them-the-way-t.md`.
