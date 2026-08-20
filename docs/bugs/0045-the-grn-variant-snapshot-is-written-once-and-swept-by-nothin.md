## The GRN variant snapshot is written once and swept by nothing [med]

**Symptom** - a purchase-order line was repaired and the goods receipt taken
from it still showed the old value, with no check anywhere reporting the
disagreement.

**Root cause (traced, not guessed)** - `grn_items.variants` is copied from the
parent PO line at receipt and never written again. `refresh-so-variants.mjs`
writes `mfg_sales_order_items`, `refresh-po-variants.mjs` writes
`purchase_order_items`, and **neither touches `grn_items`** - an unswept third
arm that no parity check compared, so repairing a parent silently left its
receipt stale.

**Fix** - `diag-so-po-variant-divergence.mjs` Section E measures the arm:
442 lines carry variants, 331 agree with their parent, 110 differ plausibly, 1
holds an impossible figure. `repair-grn-variant-snapshot.mjs` restores only that
last class, gated on the figure being unable to be a measurement AND the parent
agreeing with its own AutoCount text. **A plausible difference is history and is
left alone** - a receipt is a snapshot, and rewriting one to match its order
today would destroy the record it exists to keep.

**Ref** - 2026-08-11, PR #1964. Prod evidence: diagnostic run 31431814091.
