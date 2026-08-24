## Solo events said SOLO on the calendar while their organizer column said MALL MGMT [low]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner, on the Excel export (2026-08-17): three same-event rows at
IOI Mall Damansara — two named "… MALL MGMT @ IOI MALL DAMANSARA", one named
"… SOLO @ …", all three with organizer = MALL MGMT. "on calender show solo but
in excel mall mgt for name organizer."

**Root cause, two layers.**

1. `deriveProjectName` (and the frontend mirror `composeDefaultProjectName`)
   deliberately forced the name's organizer slot to the literal "SOLO" for
   solo-type events **even when an organizer was picked** — the comment said so
   in bold. The owner's own data disagreed: 38 solo projects carry
   "KAI HAO (KL, CHEN)" in their names.
2. Editing the organizer field later never touched the name, so a project
   created before the organizer was known kept "SOLO" forever.

Nine production projects had the mismatch (SOLO in the name; MALL MGMT /
KAI HAO / VINCENT in the organizer column).

**Fix.** Data: the nine names were rewritten live from the organizer column
(sweep now returns zero). Code: a picked organizer always fills the name slot —
"SOLO" is only the empty-organizer fallback — and a PATCH that changes the
organizer swaps the name's slot too, but ONLY when the current name still
carries the old organizer or the SOLO placeholder, so a hand-written custom
name is never clobbered. The project CODE keeps its SOLO segment: it is the
immutable identity and reads as the event type there.

**The class, for next time.** When a derived label disagrees with the field it
was derived from, check whether the derivation was ever re-run — a label
written once is a snapshot, not a view.

**Ref** — 2026-08-17, `fix/solo-name-organizer`.
