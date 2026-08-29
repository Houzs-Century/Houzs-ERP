## Seventeen mapping rows carried 30-char-truncated codes — four families merged onto the wrong Winter names [medium]

**Symptom.** The quiet-book export surfaced balance rows whose AutoCount codes
end mid-parenthesis — "DL-CS2 NN-WINTER SLEEP MATT (K" — and the mapping CSV
mapped them (and, worse, four OTHER real families: ARCTIC DREAM, NANO BREEZE,
WINTER FLOW, WINTER REST) onto those truncated Winter names. An apply would
have minted garbage-coded stock cells and merged distinct products into one.

**Root cause (traced).** AutoCount item codes cap at 30 characters; the new
Winter-series codes were created AT the cap, so the closing parenthesis never
existed in the book — "DL-CS2 NN-WINTER SLEEP MATT (K" is exactly 30 chars and
IS the book's real code. The mapping sheet then propagated the truncated
string as the ERP code, and four neighbouring families' rows were pointed at
the truncated Winter names instead of their own.

**Fix.** The 17 rows rebuilt: every truncated code maps to its own
paren-closed ERP name; the four mis-merged families get their own names back
(DL-CS2 ARCTIC DREAM MATT (K/Q), NANO BREEZE, WINTER FLOW, WINTER REST — kept
in the family's naming style; flagged to the owner as new-SKU namings he may
rename cosmetically). The importer now REFUSES any unbalanced-paren ERP code
loudly (see 0566's commit), so the next truncated code fails the run instead
of minting a cell.

**Ref.** fix/balance-aggregate-and-broken-rows, 2026-08-29.
