## WITHDRAWN — "desktop auto-derives the Processing Date; mobile makes you work it out" was wrong [correction]

<!-- area: Sales orders + pricing -->

**This entry recorded an open question. There was no question, and the framing
was wrong in a way that would have cost the next reader real time.** Retracted
2026-08-15 after reading both surfaces end to end instead of the two call sites.

**What the entry claimed.** That desktop auto-fills the Processing Date from the
Delivery Date while mobile makes the salesperson compute "six weeks before
delivery, but not in the past" by hand, and that the owner had to decide whether
mobile should derive too.

**What the source actually does:**

| | scanned in | typed by hand |
|---|---|---|
| desktop `SalesOrderNew.tsx` | derives it — Delivery − 42, clamped | **does not derive.** The Delivery input's `onChange` is a bare `setDeliveryDate(e.target.value)` |
| mobile `MobileNewSO.tsx` | seeds it from the slip's own date | does not derive |

**Neither surface derives on manual entry.** Both `deriveProcessingDate` call
sites sit inside the scan-seeding `useEffect`. So the "salesperson does the
arithmetic in their head on a phone" sentence describes the desktop equally, and
describes neither accurately.

**And the mobile half is on a DEAD path.** `scanPrefill` is declared in
`MobileApp.tsx`'s screen union and passed straight through — and no
`setScreen({ t: "new-so", ... })` call site anywhere supplies it. The live mobile
scan path is `createDraftFromPrefill`, which sends `processingDate: null`. The
seeding I was reading cannot run today.

**All of which BOTH FILES ALREADY SAY**, in matching comments, naming the
conflation, naming the fix as a behaviour change rather than a rename, and
pointing at `docs/modules/scan-to-so.md` §2b. The codebase had decided this and
written it down; the entry re-opened it as an unknown.

**The lesson, and it is not a small one.** Two call sites and a grep are enough
to produce a confident, wrong, and *actionable-looking* finding. A ledger entry
that turns settled, documented behaviour back into an open question is worse than
no entry: it spends the owner's attention on a decision that was already made,
and it makes every other entry in the ledger less believable.

**The one real defect this pass found.** That mobile comment said the live path
sends `internalExpectedDd: null` — the pre-mig-0286 spelling of a key this file
no longer sends under that name. The backend still ACCEPTS the legacy key
(`SO_HEADER_LEGACY_PAYLOAD_KEYS`, pinned by `so-processing-date.test.ts`), so the
alias is live; what was stale was naming it as the thing WE send. Corrected.

**Ref.** 2026-08-15.
