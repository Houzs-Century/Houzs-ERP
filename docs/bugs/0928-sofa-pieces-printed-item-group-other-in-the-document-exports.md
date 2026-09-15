## Sofa pieces printed Item Group OTHER in the document exports [medium]

**Symptom.** The Goods Received, Purchase Invoice and Sales Invoice exports, measured
against the live book (run 34953843236), matched AutoCount's Item Group on fewer lines
after the bindings option (#3945) than before: GR 719 vs 760, PI 414 vs 423, IV 209 vs
221. The lines that went wrong were sofa pieces. AutoCount lists them under group SOFA,
but the export printed OTHER.

**Root cause (traced).** The book records a sofa as ONE line under the model's set item
(e.g. `DSL-9028 SOFA`, group SOFA, UOM SET). Its own piece items, such as `5530-2A(LHF)`,
`9028-1A(RHF)` and `AMN-SF9050 SOFA 1A(LHF)`, are group OTHER. As of 2026-09-15, 34 of
the 37 piece-shaped items in the item master are group OTHER.

`bookLineItem` (backend/src/services/autocount-book-item.ts) read Description, Group and
UOM from whichever book item the bound code, or the unbound code, named. For a piece,
that item is one of the OTHER pieces or no book item at all.

This was measured read-only against the live book and production on GR-004037#128,
GR-004940#16, GR-005149#16, PI-007854#16, PI-007830#16, PI-007581#32,
HC-SI-2609-008#16, I-2605-0294#16 and HC-SI-2609-007#16:
- on every one, both the bound code and the unbound code were either not in the book or
  an OTHER item;
- neither ever named the SOFA set item.

So "always use the unbound code" would not have fixed them either.

**Fix.** Only lines whose code is a sofa piece (`splitSofaCode` is not null) are affected.
For those, `bookLineItem`:
- never reads Description, Group or UOM from a book item whose group is OTHER;
- reads them from the model's set item, `{model}-1S` resolved with the same supplier and
  bindings, when that item is group SOFA;
- otherwise falls back to the ERP's own values.

The Item Code stays the bound answer.

Result on the 9 lines: Item Group reads SOFA on all 18 ERP pieces behind them. UOM is SET
where the set item resolves and its base UOM is SET. It stays UNIT where the set does
not resolve: 9028 at supplier 400-O002 is ambiguous, and 9058-1S on invoices resolves
to an OTHER item.

Tests in backend/src/services/autocount-book-item.test.ts cover:
- a bound OTHER piece gets SOFA and SET;
- the fallback when the set item does not resolve;
- an unbound OTHER piece is not read;
- a non-piece OTHER item is still read.

Three of these failed on the unfixed tree.

**Ref.** fix/book-line-item-unbound-always, 2026-09-15.
