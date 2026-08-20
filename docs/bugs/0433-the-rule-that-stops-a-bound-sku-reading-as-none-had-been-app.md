## The rule that stops a bound SKU reading as "— none —" had been applied at one of six call sites [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 老板 2026-08-19 报:MRP 沙发页,同一张销售单的三个沙发模块,规格一模一样,
三行都是 SHORT,可是其中两行的供应商栏显示「— none —」,只有中间那行有下拉。我先去
生产环境查了:三个料号的绑定完全一样(各 5 笔、同公司、同 kind、连字元逐字节相同),
所以不是资料缺。再把 MRP 的读取和画面两边都跑起来验证:两边都是「一行一料号各查各的」,
在生产规模下也不会掉资料。真正找到的问题是同一条规则只修了六处中的一处 —— 采购单那两
处(选单画面、转 PO)完全没有分批也没有翻页,操作员在 MRP 那行选了替代供应商,那笔绑定
一旦掉在第 1000 笔之后,系统会不吭一声改用主供应商下单。规则现在收进一个共用读取器,
六处全部走它。

**Symptom.** MRP / Stock Status, Sofa tab, one sales order expanding into three
module rows of the same model — same fabric, same seat height, same leg. All three
SHORT. Two showed `— none —` in the Supplier cell; the third offered the dropdown.

**What the report was NOT (measured on production, not inferred).** Probe run
`32264907247` (read-only) compared each SO line's `item_code` against
`scm.supplier_material_bindings` byte for byte: all three codes carry 5 bindings,
`material_kind = 'mfg_product'`, the same company, 0 orphaned, 1 main, and
`identical = true` on the spelling — no look-alike glyph, no stray space (the trap
that BUG-HISTORY's curly-quote entry documents for this same catalogue). Run
`32264907247` also shows every binding created 2026-08-08/09, ten days before the
screenshot. Production was serving `2cecfecf8` (= `origin/main`) at the time.

**And it is not the read the page uses, either.** `routes/mrp.ts` section 5 keys
`suppliersByCode` on `d.item_code` and section 8 attaches
`suppliersByCode.get(d.item_code)` — the SAME expression, so a set's own code is
what looks its suppliers up (`mrp.ts:925`, `mrp.ts:1312`). The Sofa tab folds each
set into a PER-MODULE `MrpSku` (`Mrp.tsx` `sofaSetsToSkus`) and the module row
renders `v.suppliers` (`Mrp.tsx` `SofaSoTable`), not the group's. Both halves were
driven at production scale — the engine over 531 demand codes / 13,918 demand lines
company-scoped, and the page over the reported three-row shape — and both keep
every module's suppliers. Probe run `31942066593` measured that read on production
at 887 rows in ONE request, so no cap is in play there. The reported rows are NOT
reproducible from `origin/main` plus the data that exists, and this entry does not
claim to have reproduced them.

**What IS wrong, and it is the same rule at the sites nobody fixed.** On 2026-08-16
that binding read was taught to chunk its IN-list, page its result and order it
TOTALLY, after 2,660 rows met PostgREST's 1,000-row cap and two thirds never
arrived. Six places ask the same question. ONE was fixed. Two of the other five are
the next thing the operator touches from that page:

  * `mfg-purchase-orders.ts` — the SO→PO picker's Main Supplier column, one
    un-chunked IN-list over EVERY code in the picker, its error not even read, so a
    refused URL blanks the column for every row in silence;
  * the same file's convert body, where the loss is not a blank cell. `is_main_supplier
    DESC` protects the MAINS while they fit in one page, so what falls off the end is
    the ALTERNATES — and the alternate is exactly what the MRP row's Supplier dropdown
    sends as a per-pick `supplierId`. `effectiveBindingFor` finds no `code|supplier`
    binding, falls back to the SKU's main, and the purchase order is raised against a
    supplier the operator did not choose, at that supplier's price, reporting nothing.

`so-revision.ts`, `autocount-outbox.ts` and `suppliers.ts` carried the same shape.
The last of those had no `.range()` at all, so a supplier's own detail page could
list a subset of its bindings.

**Fix.** `scm/lib/supplier-bindings.ts` — one home for the read: chunked by URL
bytes, paged, ordered `is_main_supplier DESC, item_code, id`. That third key is not
decoration: every caller takes the first row per code as the main supplier, and
without a tie-break the ties come back in planner order, so both "which alternate
wins" and "where a truncation cuts" were unowned. All six call sites now go through
it. `Mrp.tsx`'s three groupers no longer copy the first child's `suppliers` onto the
parent `ModelGroup` — a Sales Order does not have suppliers, each module SKU does;
nothing read the field, so it was a wrong value waiting for a reader.

**Proof.** `mfg-purchase-orders.binding-cap.test.ts` drives the REAL convert body
through a fake that enforces PostgREST's 1,000-row ceiling: 403 picked lines x 3
bindings = 1,209 rows, the operator picking an alternate. Pre-fix it fails naming
the supplier each module was actually ordered from
(`9028-1A(LHF) ordered from AC-… ` where `ALT-…` was chosen); post-fix, green.
`mrpSofaSupplier.test.tsx` renders the reported three-row shape and pins that each
module row names its OWN supplier. Two fakes (`so-revision.reviseBoundPo.test.ts`,
`autocount-writeback.contract.test.ts`) gained the `Range` window they lacked, so a
paged caller is exercised rather than silently handed the whole set.

**Left alone, deliberately.** The convert's own SO-line read is capped the same way
(a pick above 1,000 lines answers `item_not_found`); it is a different read with a
different blast radius and belongs in its own change. `probe-mrp-read-ceiling`'s
REST half has never once run — `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` arrive
empty in the Production environment (runs `31942066593` and `32264550057` both
print "SKIPPED"), so the page ceiling it exists to measure is still unmeasured at
the edge.

**Ref.** this PR, 2026-08-19.
