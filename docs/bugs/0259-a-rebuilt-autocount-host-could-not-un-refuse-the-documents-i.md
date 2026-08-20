## A rebuilt AutoCount host could not un-refuse the documents it fixed [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The shop-floor AutoCount host was rebuilt on 2026-08-16 and the new
build verified live (`/health` -> `{"ok":true,"book":"AED_HOUZS","builtAt":
"2026-08-16T14:35:08Z","mvid":"a6a91dd5-…"}`), which is what `Invalid transfer
item.` had been waiting for. Pressing **Send again** on the two delivery orders
that failure had stranded answered:

```
not re-queueable here: DO HC-DO-2608-002 (so_to_do) — a conversion refusal is not
re-queued here: a parentless DO / GR / IV / PI can never exist in AutoCount at
all, a merged conversion has no AutoCount shape, and a DtlKey-subset refusal is
fixed by the line-key backfill and then re-raising the document.
```

**Root cause (traced, not guessed).** `requeueOneRow` opened with
`if (raw.op !== 'create_so' && raw.op !== 'create_po') return not-recoverable`,
so the op name alone decided it and the row's state was never consulted. The
three cases the message names are all real and all permanent — but they are
properties of the **document**, and the guard applied them to a refusal that was
a property of the **service**. A service refusal stops being true when the
service is replaced, which is exactly what a host rebuild does, and rebuilds are
routine here. Every one of them would have needed the outbox edited by hand.

**Proven, not read.** The two states are written by different code and record
themselves differently, which is what makes them separable at all:
`recordConvertSkipped` — the single writer behind all three unrecoverable shapes,
reached directly for a merged conversion, through `recordParentlessCreate` for a
parentless one, and from `readConvertSourceKeys`'s refusal for a DtlKey subset —
hard-codes `status: 'skipped'` and `payload: { body: {} }`, and such a row never
reaches the drain. `failed` is written only by `dispatchOne`, reached only from a
`pending` row, which for a transfer op is only ever `enqueueConvert`'s success
path. Both branches were re-read in the source before the fix, and every guard
below is pinned by a test that FAILS when the guard is deleted (four mutations
run: drop the status gate -> 7 fail; drop the payload gate -> 1 fails; drop the
`sent` rung -> 8 fail).

**Fix.** A transfer op (`so_to_do`, `po_to_gr`, `do_to_iv`, `gr_to_pi`,
`so_to_po`) is re-sendable when — and only when — `status = 'failed'` **and** the
row carries a composed payload. Both are required: a `failed` row with `{}` has
nothing to send, a `skipped` row with a payload was still never dispatched. The
re-send queues the RECORDED payload rather than recomposing, which is what
retiring the third original objection ("the route logic copied into a script")
costs: nothing, because 0277 already stores the whole instruction. New outcome
code `requeued-as-recorded`, because the promise it makes differs from
`requeued`'s — a change made to the document since the refusal is NOT in it.
`already-sent` moved INTO the ladder, so a caller that forgets the check cannot
put a second copy of a document into a live licensed book.

**Also fixed in the same pass.** `requeueSkipped` was selecting its own copy of
the column list the constant `REQUEUE_ROW_COLS` exists to prevent (they agreed,
which is how that class survives); `reasonFor` answered every non-`edit` op with
the conversion sentence, so a `cancel` refusal was told about parentless delivery
orders.

**Measured after the fix, and it is a separate finding.** Both delivery orders
re-queued, the cron sent them to the rebuilt host, and it answered `Invalid
transfer item.` again — with the new build's own diagnostic attached, which
REFUTES the recorded cause for these two rows: `906306`/`906307` are both on
`HC-SO-2608-003` and `905348`/`905349` are both on `HC-SO-2608-002`, all
`Transferable=T` with full outstanding quantity. Each key array is single-source,
so the "two sales orders in one array" explanation cannot apply and
`KeysBySourceDoc` had nothing to group. The real cause is UNKNOWN and is not
guessed at; it is on the AutoCount side. This does not change the fix above —
the rows now retry, land back in `failed` carrying a far better message, and
stay re-queueable for whenever the cause is found, which is the property that was
missing. `docs/autocount-sync-reasons.md` §4 carries the measurement.

**Ref.** PR #2330, 2026-08-16. Rule in full, including why the host's `mvid` is
NOT the gate: `docs/autocount-sync-reasons.md` §6.
