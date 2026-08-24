## Two audit scripts reported a clean run because their regex could not match [high]

**Symptom.** `check-company-scope.mjs` reported 34 findings. After a one-line
repair it reported 37 — and the extra was `POST /payment-vouchers/:id/post`,
which posts a journal entry into the voucher's company ledger with no company
predicate. The tool had been hiding it.

**Root cause.** Two escapes lost on the way into a JS string: `"\s"` is not the
whitespace class, it is the letter `s`; `"\b"` is not a word boundary, it is
BACKSPACE (0x08). The named-handler resolver could therefore never match a
declaration, `declAt` stayed -1, and the scan silently fell back to slicing
"this registration to the next" — reading a DIFFERENT function's body.
`POST /:id/cancel` was being reported against `reversePvAccounting`, three
functions away.

The same day, `check-shared-mirrors.mjs` extracted only `export function` and
missed `export const foo = () => {}`. Nine of thirteen pairs compared ZERO
functions and it printed "every shared function is identical" — about an empty
set.

**Fix.** Escapes doubled; arrow-function form parsed; NO-OVERLAP is its own
verdict, never folded into a pass. **Every checker now self-tests its patterns at
startup and exits non-zero rather than reporting from a dead one.**

**Lesson.** A regex that cannot match fails SILENTLY and looks exactly like
success. A verdict computed over nothing must never read as a pass.

**Ref** - `fix/company-scope-sweep`, 2026-08-13.
