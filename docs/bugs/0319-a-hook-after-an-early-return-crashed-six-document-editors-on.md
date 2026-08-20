## A hook after an early return crashed six document editors on refresh [high]

<!-- area: Frontend + mobile -->

**Symptom.** Opening a Purchase Order, Purchase Invoice or Goods Receipt edit
page by direct URL or browser refresh showed "Something went wrong loading this
page." every time. Arriving by clicking from the list did not.

**Root cause (traced).** `usePrintPreview` sat *after* `if (detail.isPending)
return …`. On a cold load the loading branch renders first with fewer hooks, then
the loaded branch renders more — React error #310. Clicking from the list works
because react-query already has the detail cached, so `isPending` is false on the
first render. Ten components carried it, all via the same pasted call:
PurchaseOrderDetail, PurchaseInvoiceDetail, GoodsReceivedDetail, the three
Consignment detail pages, the three Purchase-Consignment detail pages, and
ProjectGantt (whose two early returns precede two `useMemo`s).

**Fix.** Hooks hoisted above every conditional return in all ten. The reason it
reached ten: `frontend/eslint.config.mjs` registered `eslint-plugin-react-hooks`
with **every rule off** — including `rules-of-hooks`, which flags exactly this —
so the plugin existed only to stop 97 pre-existing disable comments erroring as
"rule not found". `rules-of-hooks` is now on at error level, and it reproduces 12
errors across 11 files against origin/main.

Ref: PR #2382, 2026-08-18.
