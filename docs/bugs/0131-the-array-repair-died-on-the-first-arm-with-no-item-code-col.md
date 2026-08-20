## The array repair died on the first arm with no item_code column [medium]

**Symptom** — the first production plan run of
`repair-array-shaped-variants.mjs` aborted whole, before printing anything about
any row.

**Root cause (traced, not guessed)** — the identity read was hard-coded
`SELECT i.id::text AS id, i.item_code, i.variants::text AS raw` and run once per
arm in the shared `ARMS` list. That list exists precisely because the colour
carriers are heterogeneous tables, and not all of them have that column —
`scm.inventory_movements` does not. One missing column takes the entire
diagnostic down, and a diagnostic that dies reads to whoever ran it as "the data
is broken".

**Fix** — the script asks `information_schema.columns` for schema `scm` once,
builds a table→columns map, and resolves the identity column per arm from
`['item_code','sku_code','product_code']`, degrading to `NULL AS item_code` when
an arm has none. Fifteen lines added, one changed.

**The class, and the check that should have caught it** — this is the class
already written down in this file on 2026-08-11, two days earlier, under *"Three
bugs in the AutoCount parity checkers, all in OUR queries, none in the data"*: a
diagnostic that dies on a schema fact it guessed is worse than no diagnostic. The
remedy recorded there is stronger than the one applied here — *"every one of
these checks now PRINTS the schema fact it depends on before using it"*. This
script now **asks** the catalog but still does not print which column it chose
per arm, so the next reader of its output cannot tell an arm with no identity
column from an arm with no damaged rows. The entry existed; it was not read
before working in a neighbouring script.

**Ref** — 2026-08-13, PR #2098 (`fix/array-repair-item-code`). Entry written
2026-08-14 from the merged diff. No module guide covers `backend/scripts/`.

---
