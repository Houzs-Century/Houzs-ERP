## The debtor code was drawn past the column and landed on "SO No" [low]

**Symptom.** On a printed Delivery Order the customer's account code sat ON TOP
of the delivery-details column — `Evergreen Living Sdn Bhd C-0142` running into
`SO No`, two strings sharing the same millimetres. Seen 2026-08-26 while
printing a sheet for the owner; the owner asked for it fixed the same minute.

**Root cause.** `drawInfoPanel` wraps the customer NAME to the left column's
width with `splitTextToSize`, then draws the code at `leftX + nameW + 3` — a
position derived from the name, never checked against the column. The wrap
guarantees the name fits; it guarantees nothing about what follows it. jsPDF
does not clip, so when the last line ended near the column edge the code was
simply painted outside it, over whatever the right column had drawn there.

The band is narrow, which is why this survived: only a name whose LAST line
nearly fills 81mm collides. A shorter name leaves room; a longer one wraps and
the last line is short again.

**Fix.** Measure the code before placing it. It still rides on the name's last
line when `nameW + 3 + codeW` fits the column — the common case, and it costs no
height there. When it does not fit it takes its own line beneath the name, and
the MEASURE pass counts that line too, so the panel grows with it instead of the
code falling out of the bottom.

**The test is a sweep, not a fixture, and the first version of it was
decorative.** Written against one long name it passed with the fix REMOVED —
that name happened to wrap early and never entered the band. It now grows the
name one character at a time from 18 to 46 and asserts on every length, plus a
final assertion that the sweep actually reached the tight cases: a sweep that
never crosses the band proves nothing, and would silently become a no-op if the
panel were re-proportioned. RED at 24 characters (110.9mm against a column edge
at 109mm), GREEN with the fix.

**Ref.** fix/the-debtor-code-ran-into-the-next-column, 2026-08-26.
