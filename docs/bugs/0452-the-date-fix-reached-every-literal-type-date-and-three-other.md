## The date fix reached every literal `type="date"`, and three other spellings of the same bug went straight through [medium]

<!-- area: Frontend + mobile -->

The owner, on two delivery orders side by side: "我又不是两套系统." The answer
given on 2026-08-18 was that a rule with no single home gets re-typed at each
surface. This is the same shape one layer down — inside the fix, and inside the
gate shipped to protect it.

`DateField` was built on 2026-06-18 because a native `<input type="date">`
renders its value in the OPERATING SYSTEM's locale — the "有时候 MMDDYYYY" bug.
It reached 14 of 189 inputs and sat there two months. #2390 finished it: all 175
native date inputs now go through `DateField`, and `check-date-formatting.mjs`
fails a new one. Verified here rather than trusted — `<DateField` is at 163
usages across 77 files, the 26 remaining `type="date"` lines are wrapper PROPS,
and all five wrappers were read to confirm each routes `type === 'date'` to
`DateField`: `components/InlineEdit.tsx:100`,
`mobile/MobileServiceCase.tsx:2864`, `scm-v2/LorryDetail.tsx:625`,
`scm-v2/DeliveryOrderNewV2.tsx:166`, `scm-v2/DeliveryRateCards.tsx:760`. That
half is genuinely done, and the allowlist entries covering it are true rather
than a doc labelling a live bug as intended.

**Both the sweep and the gate keyed on a LITERAL `type="date"`.** Two spellings
of the identical bug were therefore invisible to both.

**One — `<input type="datetime-local">`.** It renders its DATE half in the OS
locale by exactly the same mechanism. The `raw-date-input` pattern cannot see
it: `["']date["']` needs the closing quote immediately after `date`. Proven by
executing the rule against `<input type="datetime-local" value={x} />` — false.
Six were left. The sharpest pair is on one screen: in the delivery-planning
drawer, **Arrival** and **Departure** were native `datetime-local` while
**Shipout Date**, rendered directly beneath them in the same column, was already
a `DateField`. On any machine whose OS is not day-first that drawer spelled a
date two ways, one field apart — the owner's complaint reproduced inside the
component built to end it. The mobile twin had the same three fields in the same
order with the same split.

- `vendor/scm/components/DeliveryFieldsDrawer.tsx` — Arrival, Departure
- `mobile/MobileDeliveryPlanning.tsx` — Departure, Arrival
- `pages/Announcements.tsx` — "Hide automatically after"
- `pages/Projects.tsx` — the OUT/RETURN transfer timestamp

**Two — the input type decided in a VARIABLE.** `components/UdfCell.tsx` had
`const type = field.type === "number" ? "number" : field.type === "date" ? "date"
: "text";` and then `<input type={type} …>`. `"date"` is a first-class
`UdfFieldType`, so this one was USER REACHABLE with no code change at all: every
operator who added a date column to a table got a native OS-locale input in the
grid. It survived the June build, the sweep of all 175, and the gate — the type
never appears next to the input. Found only because the repo's own
completeness-claim gate refused the phrase "all five wrappers" without a
reproducible enumeration, and the enumeration listed two files I had not read.

**Three — a native date input written as an EXPRESSION.**
`mobile/MobileServiceCase.tsx`'s `EditableAcc` rendered
`<input type={f.type === "date" ? "date" : "text"} …>`. Every rule keyed on a
quote straight after `type=`; here the next character is `{`. So this one input
survived the June build, the August sweep of all 175, AND the gate that sweep
shipped — three passes over the same tree. Stated precisely because it changes
the severity: NO caller passes a date field today, so nothing was misreading on
screen. The `EditField` union offers `"date"` and handles it in three places, so
the first one added would have got the OS locale back with nothing failing.

**The fix.** `vendor/scm/components/DateTimeField.tsx`: the date half goes
through `DateField`, the time half stays a native `type="time"`. That split is
not invented here — `Projects.tsx` already used it, which is why the
`type="date"` sweep correctly found nothing to do in that file. Its local
component is now `LogisticsDateTimeField`, because it and the shared control
differ in CONTRACT (commit-on-blur with a label and a midnight normalisation,
versus a plain controlled value) and not in date rendering; a name collision is
a bad way to learn that.

THE WIRE CONTRACT IS BYTE-IDENTICAL, AND THAT IS THE WHOLE SAFETY ARGUMENT.
`value` is the same wall-clock `YYYY-MM-DDTHH:mm` a native `datetime-local`
reads and writes; `onChange` emits the same; nothing in the component parses
through `Date`. The callers that convert TIMESTAMPTZ to and from that shape
(`toDtLocal` in both delivery files, `new Date(expiresAt).toISOString()` in
Announcements) are untouched. A date input that stops CLEARING, or that shifts a
day across a timezone, is a worse bug than the one being fixed, so both are
pinned rather than argued: 20 tests in `DateTimeField.test.tsx` cover clearing
the date, clearing the time, refilling a cleared field, a date-only stored
value, both half-filled states, and an external reset — and the file passes
identically under `America/New_York`, `Pacific/Kiritimati`, `UTC` and
`Asia/Kuala_Lumpur` (−5, +14, 0, +8).

Half-filled emits `''`, which is native `datetime-local`'s own behaviour and is
deliberate. `LogisticsDateTimeField` normalises a date-only entry to midnight
instead; adopting that here would mean a field that used to save nothing starts
saving `00:00`, and a silently invented time is not a change to make inside a
display fix.

**The gate, so there is no third rediscovery.** Three new shapes —
`raw-datetime-input`, `computed-date-input-type` and
`date-input-type-in-a-variable` — in the script that already runs in the
required `backend-typecheck` job. The third was measured before it was added:
ZERO hits across `frontend/src` and `backend/src` once UdfCell was fixed, so it
buys its coverage at no false-positive cost. Both proven by planting in the
REAL source tree: exit 1 naming the file and the shape, exit 0 once removed
(1454 files, 53 hits, 0 unreviewed). The existing `raw-date-input` was
re-planted and still bites. Six new cases in `dateFormatGate.test.ts` make it
permanent, including the wrapper-prop spelling — the bug can arrive on a line
with no `<input` token on it, which is exactly how the 26 reviewed date entries
are written — and two NEGATIVE cases, because `computed-date-input-type` keys on
`type=` plus a brace and must stay silent on a `type:` annotation, an object
literal and an `f.type === "date"` comparison, all five of which live in the very
file that motivated the rule.

WHERE THE RULE DELIBERATELY STOPS, pinned by its own test so it reads as a
decision and not an oversight: `type="time"`, `type="month"` and `type="week"`
are also OS-locale rendered and are NOT gated. None puts a day number beside a
month number, which is the only way a date gets MISREAD — 14:30 and 2:30 PM are
the same minute. A gate that fires on cosmetic variation is a gate somebody
switches off, which is how the previous generation of checks here died. And one
hole is named rather than papered over: a date literal assigned to a variable
NOT named like a type is still invisible to any regex, and is not claimed.
