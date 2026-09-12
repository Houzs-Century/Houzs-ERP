## The remark written on a receipt line was stored and never shown again [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner, 2026-09-12: 「行备注（remark）应该也是要一样，因为它们会带
过去」 — the same line remark on every document, because it travels with the
line. The warehouse writes one at receipt ("outer carton dented, sofa OK"); the
person checking the supplier's invoice needs to see it. Neither the Goods
Receipt screen nor the Purchase Invoice screen rendered it, so the only place to
put a sentence was the document HEADER, where it belongs to every line at once.

**Root cause (traced) — and it corrects the parity plan.** The plan
(`交易流程补齐计划`, P4/P5) listed this as *"add a line-remark column to GR and
PI"*, i.e. a schema change. That is wrong, measured against the running system:

| | |
|---|---|
| `grn_items.notes` | **exists**, and `PATCH /grns/:id/items/:itemId` has always accepted `notes` (it is in the from→to map) |
| `purchase_invoice_items.notes` | **exists**, and the detail GET already selects it (`ITEM`) |

Read off a real staging document (2026-09-12), a GRN line carries
`notes` — and, while there, `delivery_date` AND `received_at`, which the same
plan said GRN lines did not have. So the gap was never the database. **Nothing
rendered the column.**

**Fix.** A `Remark` column on both line tables — `GoodsReceivedDetailV2` and
`PurchaseInvoiceDetailV2` — italic, truncated with the full text on hover, and
`—` when the line has none. `GrnItem` gains the `notes` field its API response
was already carrying (the type omitted it, which is why nothing could render it
without a compile error).

**Deliberately NOT in this change:** making the GR line remark editable in the
grid. The route accepts it, but that screen has no line-edit affordance at all
today and adding one is a bigger, separate piece of work. Written down here so
the next reader does not have to re-derive that the route half is already done.

**What this ALSO corrects for the plan.** `delivery_date` and `received_at`
exist on a GRN line, so P2 ("行交期 on GR") is a screen change too, not a
migration. The PURCHASE INVOICE line is the one that genuinely has no date
column.

**Ref.** feat/line-remark-on-gr-and-pi, 2026-09-12.
