## The 2990 mirror kept overwriting Houzs edits, and blanked the delivery links every time [high]

<!-- area: Cutover + migrated data -->

**白话.** 2990 的单现在是在 Houzs 开的、也只在 Houzs 改。可是旧的同步还开着：2990 那
边每传一次，系统就把这张单整组行删掉再放回去，等于把老板刚改的东西盖回旧的样子。更麻烦
的是，行一被删，送货单就不记得自己送的是销售单的哪一行，MRP 会以为还没出货，叫采购再买
一次 —— 现在有 10 条这样的行。改成「同一张单只收第一次」：这张单 Houzs 已经有了，就完
全不动它；2990 那边要删这张单，也不理它。那 10 条断掉的行，另外用修复程序接回去。

> **更正（同一天）。** 这段原本写「老板把运费 250 改成 125 又变回 250，就是这个同步害
> 的」—— **这句话是错的，收回。** 查过 2990 那边的传送记录：最后一次成功传过来是
> 2026-08-19 08:42（UTC），之后一次都没有，队列是空的。老板那个运费问题发生在这之后，
> 所以不可能是它。运费那件事是 Houzs 自己这边的三个毛病（#2490、#2514、#2516），已经
> 各自修好了。这个同步的问题是真的、也真的要修，但它害的是送货单那 10 条断掉的行，不是
> 运费。

**Symptom.** 10 delivery lines across 4 documents carrying `so_item_id IS NULL`
under a DO whose header still named the order, measured by the orphan sentinel
on 2026-08-20 (run 32321165432) against a committed baseline of 1. `so_item_id`
is the key MRP's delivered-netting and the CONFIRMED → DELIVERED flip resolve
on. Silent by then: #2225 and #2355 had already covered the MRP face of it
twice over.

> **CORRECTED, same day, before anyone acted on it.** This paragraph opened
> *"Two faces of one cause. The owner's: editing the delivery fee 250 → 125 on a
> 2990 Sales Order 'nuked the line to 0' … the edit simply came back as 2990
> last knew it."* **That attribution is wrong and is withdrawn.** The mirror's
> last successful delivery to Houzs was **2026-08-19T08:42:39Z** — read from
> 2990's own `public.sync_outbox` (`max(delivered_at)`) by
> `mirror-drift-sentinel.mjs`, run
> [32326411962](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/32326411962):
> `pending=0 sent=0 done=102 stuck=0`. The outbox has been drained and idle
> since. The vacuum only prunes `done` rows older than 30 days
> (`docs/2990-live-sync/03_reconcile_2990.sql:34`), so that timestamp is the
> real newest delivery, not an artefact of pruning.
>
> Every `SVC-DELIVERY` delete on `2990-SO-2608-033` in the forensic log
> (`2026-08-20 01:41` and `02:40`) postdates that and carries
> `application_name = PostgREST 14.5` — the Houzs fee rebuild, which reaches
> Postgres through the PostgREST-shaped client. The mirror reaches it through
> postgres.js and appears nowhere in that log.
>
> The 250 → 125 symptom is fully explained on the Houzs side and was fixed
> there: the line PATCH accepted a bounded discount, the rebuild wrote
> `discount_sen: 0` straight over it (#2490), the rebuild also replaced the
> `SVC-DELIVERY*` rows so they changed id (#2514 / mig 0310), and `SoLineCard`
> rendered the discount READ-ONLY, so no operator could type one at all —
> which is why typing over the unit price, and watching the re-derive undo it,
> is what actually happened (#2516).
>
> **What this does NOT withdraw.** The mirror was genuinely live and delivering
> until 2026-08-19T08:42Z, its delete-then-insert of the whole item set is
> real, and it remains the only known mechanism that orphans a whole document's
> DO lines at once — which is what the ten rows below look like. Import-once is
> a correct and necessary fix either way: the queue being empty today is a
> state, not a guarantee, and any 2990-side change or any failed row returning
> to `pending` would have replayed over Houzs edits again.
>
> Recorded here rather than quietly edited because the wrong sentence had
> already merged, and because two facts disagreeing is the finding, not
> something to reconcile into a smoother story.

**Root cause (traced in source, and the competing theory refuted by
measurement).** `routes/so-mirror.ts` was written before the cutover, as a live
one-way replica: on EVERY inbound message it upserted the header and then
replaced the whole item and payment set with a DELETE-then-INSERT. That was
correct while 2990 owned its own orders. It stopped being correct on 2026-07-21,
when `HOUZS_OWNS_2990="true"` made Houzs the writer — the POS creates `2990-`
orders here, Houzs mints their numbers, and the readonly wall in
`mfg-sales-orders.ts` lifts so staff can edit them. The receiver went on
replaying 2990's copy over those edits, and because
`delivery_order_items.so_item_id` is `ON DELETE SET NULL`, each replay also
blanked every DO line pointing at the SO lines it had just deleted and
re-inserted with the same ids. **The route's own header comment still described
the pre-cutover contract, which is how a live overwrite path stayed invisible
for a month.**

The leading alternative — that the `SVC-DELIVERY` fee rebuild did it — was
REFUTED by the same run: it predicts delivery-charge lines only, and the ten
orphans are sofas, a mattress and a pillow as well, with whole documents
orphaned together (2990-DO-2607-012, -015 and 2990-DO-2608-009 lost all three of
their lines at once). A per-line fee rebuild cannot do that; replacing an
order's entire item set can. That rebuild was a real mechanism and was closed
separately by #2514.

**Fix.** The receiver is IMPORT-ONCE. A `doc_no` company 2 does not hold is
imported exactly as before; a `doc_no` it already holds is not touched at all
(200 + `skipped_existing`); `deleted:true` on an order Houzs holds is refused
(200 + `refused_delete`), because Houzs owns these orders' lifecycle now. Every
refusal is a 2xx on purpose — 2990's pg_cron drainer keys on HTTP status, so a
non-2xx would keep the outbox row PENDING and wedge the queue behind it. The
first import writes the header LAST-CHANCE style: if any part of it throws, the
header it created is removed before the 500, so the retry redoes the whole
document instead of finding a header-only order and skipping it. The 10 broken
links are repaired separately by `repair-do-so-item-links.mjs` (workflow **Repair
DO->SO line links**), AFTER this shipped — repairing first only re-breaks on the
next sync. The NTYR pillow on 2990-DO-2607-013 stays unrepaired by design: its SO
line is already fully delivered by another document, so re-linking would report 2
delivered against 1 ordered.

**Ref.** so-mirror import-once, 2026-08-20. Pinned by
`backend/tests/soMirrorImportOnce.test.ts` (in `MUST_GATE_MERGE`, so a
regression stops a merge rather than a deploy). Sentinel:
`.github/workflows/do-link-sentinel.yml`.
