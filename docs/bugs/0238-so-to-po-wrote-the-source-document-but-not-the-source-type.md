## SO-to-PO wrote the source document but not the source TYPE [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner asked whether SO-to-PO was working. Read off the live
book on 2026-08-16, every purchase line this route has ever written:

```
DocNo                    Seq  Qty  UnitPrice  FromDocType  FromDocNo
ZZQA-PO-20260816-124548  16   4.0  0.00       NULL         ZZQA-SO-20260816-124548
ZZQA-PO-20260816-095955  16   4.0  0.00       NULL         ZZQA-SO-20260816-095955
ZZQA-PO-20260816-014157  16   4.0  5.00       NULL         ZZQA-SO-20260816-014157
```

`FromDocNo` present, **`FromDocType` NULL** — against every `DODTL` row from
`Convert_`, which carries both. AutoCount's own transfer relationship reads that
column, so the link is one-sided and the PO does not show its Transfer From.

**Root cause, and it is visible in the two signatures.**

```
AddPartialTransferDetail(String fromDocType, Int64[] keys, Boolean transferMaster)
AddSOToPOTransferDetail(Int64)
```

The four conversions use the first and are TOLD the type, so they record it.
SO-to-PO used the second, which has nowhere to take one from. Nothing was
dropped or mis-set; the type was never available to be written.

`sdk-api-reference.txt` says the detail classes expose no settable `From*`
fields, so it cannot be patched in afterwards either — the primitive has to
carry it.

**Fix.** Call the typed primitive first, keeping the untyped one as a fallback.
`transferMaster` is FALSE here, unlike the purchase-side conversions: that flag
copies the SOURCE document's master and this source is a SALES order, so true
would put a debtor onto a purchase document. `PurchaseHeader` sets the creditor
explicitly, which is what `/po-to-gr` needed `transferMaster` for and this route
does not.

**Why a fallback rather than a straight swap.** A sales `fromDocType` on a
purchase document is not listed in the SDK dump as a supported pairing, and this
file compiles nowhere but the office host. If the typed call throws, the old one
runs and the document is written exactly as it is today — one-sided link and
all — with the refusal in `ac-sync-service.log`. The worst case is what we
already have.

`UnitPrice 0.00` on those rows is NOT part of this: those probes were raised
from sources priced at zero, which `#2259` made the route carry deliberately.

**Ref.** 2026-08-16, PR #2300.
