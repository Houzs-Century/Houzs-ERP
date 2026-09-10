## MRP shows no supplier on a line whose product IS bound [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 老板 2026-09-10：同一张单 HC-SO-013497，四个 9058 沙发件、同一款布，供应商
那一栏有两行写着 HOOKKA INDUSTRIES，另外两行是空的。空的那行没办法从计划页开采购单。

真正的原因跟 9058 一点关系都没有。我们的产品编号里有两个是「5 寸」写成 `5"` 的床褥
（`DUNLOPILLO GENERASI 5" MATT (S)` 和 `(SS)`）。系统一次去问一批产品的供应商，那个
引号会把整串问题从中间截断 —— **排在这两个编号後面的所有产品，问了等於没问，而且系统
不会报错，只会安静地回一个空答案。** 9058-1NA 刚好排在後面，所以它的供应商就不见了。

量出来的规模：一次计划里 **38 个产品编号**的供应商整批掉了，其中 13 个是缺货、要开
采购单的行。同一个毛病也解释了 `docs/bugs/0777` 里当时查不出来的那 8 个配件编号。

修法：改成我们自己按 PostgREST 的规矩把引号转义好再送出去。没有引号的编号，送出去的
字串跟以前一模一样，所以本来正常的都不会被动到。

**Symptom.** The owner, 2026-09-10, with the plan screen open. On
`HC-SO-013497` all four pieces are 9058 with the same fabric, and the supplier
column disagrees line by line:

```
9058-L(LHF)  · HR805-90 / SEAT 30 / SPECIAL: ...  -> HOOKKA INDUSTRIES
9058-1NA     · HR805-90 / SEAT 30                 -> — none —
9058-1NA     · HR805-90 / SEAT 30                 -> — none —
9058-1A(RHF) · HR805-90 / SEAT 30                 -> HOOKKA INDUSTRIES
```

His own screens prove the data is there: the supplier page lists `9058-1NA`
bound to HOOKKA INDUSTRIES with supplier SKU `5536-1NA`, and the purchase-order
picker resolves a bound SKU to its supplier and says *"264 item(s) bound to this
supplier"*. 「这不就是说这个 item 有什么 Supplier 吗？」

**Consequence, and why this is high:** a `— none —` row cannot be turned into a
purchase order from the plan. The buyer has to leave the page and raise it by
hand, or the line waits.

---

### Root cause — traced, 2026-09-10. It is the URL, not the query

`@supabase/postgrest-js` 2.108.2 serialises `.in()` like this
(`node_modules/@supabase/postgrest-js/dist/index.cjs`, verbatim):

```js
const PostgrestReservedCharsRegexp = new RegExp("[,()]");
in(column, values) {
  const cleanedValues = Array.from(new Set(values)).map((s) => {
    if (typeof s === "string" && PostgrestReservedCharsRegexp.test(s)) return `"${s}"`;
    else return `${s}`;
  }).join(",");
  this.url.searchParams.append(column, `in.(${cleanedValues})`);
```

**It quotes and it never escapes.** PostgREST's own grammar
(docs.postgrest.org/en/v12/references/api/url_grammar.html) requires the
opposite: *"If the value filtered by the `in` operator has a double quote (`"`),
you can escape it using a backslash. A backslash itself can be used with a
double backslash."*

So a value carrying a `"` is wrapped in quotes that its own `"` then closes
early, and the **first `)` after that closes the whole `in.(` list**. Every value
after it in the same batch never becomes a predicate value — and the request
still answers **200**. Nothing anywhere reports a short read.

Two item codes in company 1's open demand carry an inch mark. A mattress
catalogue names its products by depth:

```
DUNLOPILLO GENERASI 5" MATT (S)
DUNLOPILLO GENERASI 5" MATT (SS)
```

`computeMrp` reads its supplier bindings for the whole demand code list, batched
~50 codes at a time by `chunkIn` — so each of those two codes silently emptied
the rest of its own batch.

#### The measurement — production run 34457477642, 2026-09-10

The evidence is `scm.mrp_snapshots.result`: the FROZEN output of `computeMrp`,
written by the Worker through the real PostgREST transport every ~15 minutes, so
its `sofaSets[].suppliers` is literally what `suppliersByCode` produced. Reading
it needs no PostgREST credential, which this repository deliberately does not
hold. (`docs/bugs/0777` settled its own question the same way.) Snapshot computed
2026-09-10 08:30 UTC, 683 skus / 352 sofa sets.

The reported document, as the engine actually left it:

```
HC-SO-013497  9058-1A(RHF)  [HR805-90 / SEAT 30]  qty 1  SHORT 1
    suppliers the engine attached: 5  -> ARMANI | DORSETTLOFT | HOOKKA INDUSTRIES | HOOKKA MANUFACTURING | OHANA
HC-SO-013497  9058-1NA      [HR805-90 / SEAT 30]  qty 1  SHORT 1
    suppliers the engine attached: 0
HC-SO-013497  9058-1NA      [HR805-90 / SEAT 30]  qty 1  SHORT 1
    suppliers the engine attached: 0
HC-SO-013497  9058-L(LHF)   [... / SPECIAL: 8030 back rest ...]  qty 1  SHORT 1
    suppliers the engine attached: 5  -> ARMANI | DORSETTLOFT | HOOKKA INDUSTRIES | HOOKKA MANUFACTURING | OHANA
HC-SO-013495  9058-1S       [SPECIAL: 8030 back rest ...]  qty 1  SHORT 1
    suppliers the engine attached: 0
```

Across the whole planning run:

```
item codes in the snapshot: 299
  every binding attached (mn = mx = bindings):        245
  LOST — bindings exist, NONE attached:               38
  PARTIAL — some attached, fewer than exist:          0
  SPLIT — one code, different counts on its own rows: 0
  STALE — more attached than the table now holds:     0
  legitimately unbound (0 bindings, 0 attached):      16
```

All-or-nothing per code, never partial — which already rules out a truncation.
And the losses sit exactly where the unserialisable codes sit:

```
codes whose value CANNOT be serialised by .in() (contain " or \): 2
  [79]  batch 1, position 29  "DUNLOPILLO GENERASI 5\" MATT (S)"
  [174] batch 3, position 24  "DUNLOPILLO GENERASI 5\" MATT (SS)"

batch  codes  bound  LOST  attached  first unserialisable value at position
     0     43     42     0        42       —
     1     43     43    18        25      29
     2     37     34     2        32       —
     3     33     31    15        16      24
     4     33     31     3        28       —
     5     24     23     0        23       —
     6     21     21     0        21       —
     7     25     22     0        22       —
     8     18     16     0        16       —
     9     13     13     0        13       —
    10      8      7     0         7       —
    11      1      0     0         0       —

LOST codes located: 38
  of those, in a batch carrying an unserialisable value: 33
  of those, POSITIONED AFTER that value in the batch:    31
codes that KEPT their suppliers while positioned after one: 0
```

**Not one code positioned after an inch-marked value kept its suppliers, and
every batch without one lost nothing.** The two batches that carry one lost 18 of
43 and 15 of 31 — which is what the remaining slots after position 29 of 50 and
position 24 of 50 come to. The residual 5 are the probe's own stated
approximation: it cannot apply delivered-net in SQL, so its code list is a
superset and a few codes land one batch off.

#### It is the SAME defect in `docs/bugs/0777`

0777 fixed the row-category fallback and left this open: *"Still UNKNOWN, and
deliberately out of this fix. Why `prodByCode` lacks those eight codes at all."*
Section 2 batches the SAME code list through the SAME `chunkIn`, so it forms the
same batches and loses the same codes. **All eight of 0777's codes are in the 38
above** — `LONG PILLOW`, `JM-CL JAC WP MP (S)`, `JM-CL JAC WP MP (SK)`,
`NTYR-ERGO LTX PIL`, `AERO-MP (S)`, `HB709NL`, `DL-HOTEL PILLOW(M)`, `DL-MP(K)`.
That is also what makes the cause certain rather than plausible: two DIFFERENT
tables lose the same codes off the same list, so the loss cannot be in either
table's data.

---

### Five causes RULED OUT, each with the run that refuted it

- **Not missing or mis-typed bindings.** `check-supplier-binding-visibility.mjs`,
  run **34447806315**: 17 `9058-*` products, **71 binding rows**, all
  `material_kind = 'mfg_product'`, all `company_id = 1`, exactly one main
  supplier per piece, no binding pointing at a deleted supplier.
- **Not two readers with different predicates.** Same run — the product page
  would return 71 and the shared reader would return 71.
- **Not a code-spelling mismatch.** `check-so-line-supplier-lookup.mjs`, run
  **34454717897**: every line of both documents matches a binding on its EXACT
  string — `9058-1NA` len=8, 5 bindings; `9058-1S` len=7, 5; `9058-L(LHF)`
  len=11, 5; `9058-1A(RHF)` len=12, 5; no odd bytes, no case twins. (`DISPOSE`
  legitimately has none — it is a service line.)
- **Not the ~1000-row PostgREST cap** that produced this symptom on 2026-08-16.
  Run 34457477642 measured 618 binding rows over 6 batches, the largest 148
  against a PAGE of 1000: **no batch needs a second page.** It could not produce
  this shape either — the read orders `is_main_supplier DESC` first, so a
  truncation drops ALTERNATES long before it drops a main, and the snapshot shows
  zero PARTIAL codes.
- **Not the sofa SET grouping on the frontend.** `sofaSetsToSkus` takes
  `suppliers` from the first set of a `(warehouse, SO, itemCode, variant)` group,
  and every set in such a group shares ONE `suppliersByCode` lookup, so the first
  cannot differ from a later one. The snapshot confirms it: 0 SPLIT codes.
  `mrpSofaSupplier.test.tsx` (2026-08-19) already pins the render.

---

### Fix

**`backend/src/scm/lib/pgrest-in-list.ts`** — one home for PostgREST's `in.(…)`
grammar: `pgrestInList` writes a list, quoting when a value holds `, ( ) " \` and
escaping `\` and `"` the way PostgREST documents; `parsePgrestInList` reads one
back, and deliberately reproduces the early close rather than repairing it, so a
fake built on it cannot pass against the bug.

Applied with `.filter(column, 'in', …)` at the two reads this bug proves are
short — `lib/supplier-bindings.ts` (which is the shared reader, so MRP, the SO→PO
picker, the convert body, `so-revision` and the AutoCount outbox all inherit it)
and `routes/mrp.ts` section 2's `mfg_products` read (0777's open half).

**Byte-identical where the library is correct.** `pgrest-in-list.test.ts` builds
the same filter through the REAL `@supabase/supabase-js` client both ways and
compares the query strings, over a list covering plain, parenthesised, spaced,
dotted and comma-bearing codes — so adopting it changed nothing for the reads
that already worked, and a library upgrade that alters the quoting rule fails
there instead of in production.

**Proof it was RED.** `supplier-bindings.test.ts` drives the real
`readMfgProductBindings` through a real client whose `fetch` reads the query
string the way PostgREST does. With `.in()` restored, the emitted filter parses
back to three values instead of six:

```
- Expected                          + Received
  "9058-1A(RHF)",                     "9058-1A(RHF)",
  "9058-L(LHF)",                      "9058-L(LHF)",
- "DUNLOPILLO GENERASI 5\" MATT (S)"  "DUNLOPILLO GENERASI 5 MATT (S"
- "9058-1NA", "9058-1S", "LONG PILLOW"
```

`9058-1NA`, `9058-1S` and `LONG PILLOW` never reach the database. Post-fix, all
three tests pass.

**Test fakes and the shim now speak the escaped form.** A fake that answered
`.filter()` with a naive `split(',')` would reproduce the bug and report a clean
run, so all of them parse with `parsePgrestInList`: the two shared fakes
(`backend/src/scm/lib/fake-postgrest.ts`, `backend/tests/fakePostgrest.ts`), the
six per-file fakes, and `backend/scripts/lib/pgrest-shim.mjs` — the last of these
because four AutoCount repair scripts drive `autocount-outbox.ts` through it and
that file reads supplier bindings.

### NOT fixed, deliberately, and what it would take

**67 `.in()` reads in `backend/src` still filter on an item-code column** and are
exposed to the same two product codes. They are not touched here because the
sweep is not free: several of them are on paths that scripts drive through
`pgrest-shim.mjs`, and a 67-site mechanical change to the money routes in the
same PR as the diagnosis is a diff nobody can review against the evidence. Three
ways to close it, cheapest first:

1. **Sweep them** to `.filter(col, 'in', pgrestInList(batch))`. Small per site
   and mechanical, but 67 of them plus the fakes they touch.
2. **Fix it once at the client** — override `in()` when the service client is
   built in `src/db/supabase.ts`. One place, covers everything including code
   nobody has written yet; the cost is that `.in()` then behaves differently from
   the library it came from, which is its own trap for the next reader.
3. **Rename the two products** so no item code carries a `"`. Rejected: an item
   code is the key documents, AutoCount and history are written against, and the
   owner's standing rule is that the ERP matches AutoCount exactly.

**Recommended: (1), as its own PR**, with `pgrest-in-list` already landed here so
that PR is a diff and not a design. (2) is tempting and is the wrong shape for a
codebase where the next person will read `.in()` and expect the library's
behaviour.

**Ref.** fix/mrp-supplier-hunt, 2026-09-10.
