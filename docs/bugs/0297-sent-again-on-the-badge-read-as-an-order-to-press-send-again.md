## "SENT AGAIN" on the badge read as an order to press Send again [medium]

**Symptom.** Owner, 2026-08-16, same screen: 「你写 Send Again,明明都已经进去了,
为什么还要 Send Again？」 Seven of seventeen rows carried a badge reading **SENT
AGAIN** — the same two words as the **Send again** BUTTON beside it — on exactly
the rows where pressing it is the one thing a reader must not do. The row's own
body then contradicted the badge: *"Already sent again under a newer row · this
row is history"*.

**Root cause (traced, not guessed).** `STATE_WORDS.requeued` was `"Sent again"`,
spread into both `AC_STATE_LABEL` (the badge) and `AC_FILTER_STATE_LABEL` (the
chip), while `AC_SEND_AGAIN_LABEL` — the button — was `"Send again"`. The state
is passive (a newer send replaced this record) and was named with the imperative
belonging to the control next to it.

**Fix.** The state is **Replaced**, on the badge and the chip. `AC_REPLACED_LINE`
is *"Replaced by a newer send — nothing to do on this one"* and `acRowStatusLine`
is *"Replaced by a newer send"*, so the badge, the one-line status and the
headline all say one thing and say what to DO (nothing) rather than what the
record IS. A test asserts none of those strings contains the button's words, and
none contains `re-queue`, `supersede` or `row`. **Ref** PR #PLACEHOLDER, 2026-08-17.
