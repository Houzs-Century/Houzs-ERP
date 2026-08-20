## /so-to-po sent no supplier, because the transfer branch threw the whole master away [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Measured on the live host 2026-08-17 09:15, and again at 09:20 when
the cron tried again:

```
2026-08-17 09:15:12 /so-to-po   HC-SO-2608-001
2026-08-17 09:15:13 ERROR /so-to-po: System.Exception: CreditorCode required for /so-to-po -
    AutoCount defaults the payment term from the supplier, and without one the save dies on
    FK_PO_DisplayTerm, which names the term and not the supplier
      at AcSyncService.SoToPo(Dictionary`2 p)
```

Book state at that moment: no `HC-` purchase order exists; the six newest POs
are all `ZZQA-PO-*` and all `Cancelled=T`.

**Root cause (traced).** `enqueuePoCreate` builds `body = composeCreatePo(...)`,
which carries `CreditorCode` — and then throws it away when the shape is a
transfer:

```ts
body: (shape.kind === 'transfer' ? composeSoToPo(shape.dtlKeys, details) : body)
```

`composeSoToPo` returns `{ DtlKeys, Details }` **and nothing else**. So the
create arm has always named the supplier and the transfer arm has never named
anything: no creditor, no `DocNo`, no `DocDate`, no `Description`, no UDF. It is
the same defect as the debtor on the sales side (#2340, #2341) — *the target
document has no account when the SDK is asked to build it* — in the one place
those two did not reach.

**This one read clearly instead of as `Invalid transfer item.`** only because
`SoToPo` already carries a guard that names it, added 2026-08-15 after
`FK_PO_DisplayTerm` was chased as a mystery. The guard was right and the payload
never caught up.

**Fix, two halves, because one of them cannot reach the row that is stuck.**

1. `enqueuePoCreate` puts `CreditorCode` / `CreditorName` on the transfer body.
   **No join is needed here**, unlike the GRN and purchase-invoice arms:
   `readPoHeader` has already resolved `suppliers.code` for the binding lookup
   two lines above, so the value is in hand.
2. `dispatchOne` backfills it at drain when the stored body has none. The drain
   **replays** the stored payload and never recomposes, so fixing the enqueue
   alone would leave every already-queued row failing for ever — and there is at
   least one, retrying every five minutes.

**THE ACCOUNT BOOK CANNOT ANSWER THIS ONE**, which is where the analogy with
#2340's debtor fallback stops and why the backfill reads the ERP instead. For the
four conversions the source document in the book HAS the account. `/so-to-po`'s
source is a SALES order: it carries a `DebtorCode` and no creditor, and the
supplier is a purchase decision that exists nowhere in AutoCount until we send
it. The authority is the ERP's own purchase order, and the row already points at
it: `enqueuePoCreate` sets `payload.writeback` to `{ purchase_orders, id,
<poId> }` unconditionally, outside the transfer/create branch, so it is there
whichever shape the row took.

**Unchanged, and deliberately: `po_to_gr` and `gr_to_pi`.** This finding says
nothing about them. `PurchaseHeader` still runs after the transfer there for the
`transferMaster: true` reason recorded in #2340, and neither arm has ever
succeeded. Divergence **D15** keeps its purchase half open.

**Test.** `autocount-writeback.contract.test.ts`, four tests, and each of the two
fixes was verified to FAIL when reverted (`expected undefined to be '400-T001'`,
separately for the enqueue and for the drain). One of the four is a **positive
control** — it asserts the fixture really takes the `so_to_po` branch — and it
earned its place immediately: the first run showed the seeded purchase order was
refusing with `MissingLocationError` because nothing had ever seeded a
`warehouses` row for `wh-kl`, so all three assertions would have been passing
over the `create_po` path. No live test had ever exercised `enqueuePoCreate` end
to end; the only one that tried is `test.skip`.

**Not fixed here, and worth a decision.** The transfer arm still sends no
`DocNo`, so the first `/so-to-po` that succeeds will take an AutoCount
auto-number rather than the ERP's — divergence **D5**, which `enqueueConvert`
closed for the four conversions and this path never did. Left alone on purpose:
this route has never once succeeded, and one variable at a time is what let the
debtor be isolated on the sales side.

**Ref.** PR for `fix/so-to-po-names-the-supplier`, 2026-08-17. Follows #2340 and
#2341.
