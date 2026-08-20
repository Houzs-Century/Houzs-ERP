## The undated-demand count existed only while the rows were invisible — the banner spoke in one direction [medium]

<!-- area: Sales orders + pricing -->

**What changed.** The MRP page's undated-demand banner now renders whenever there
IS undated demand, in BOTH states, and only its wording depends on the flag. The
DEFAULT IS UNCHANGED — `GET /api/scm/mrp` still defaults `includeUndated` to
**false** and the **Show no-date** checkbox still starts unticked. When the rows
are shown they are tagged **No date** on the row and sorted last, and `useMrp`
now sends the flag in both directions instead of expressing "hide" by silence.

**The defect.** 2026-08-16 established that the default view carried 82 of 163
live 2990 SO-item ids and 8 of 68 short sofa sets, and said nothing about the
missing half. The response grew `undated{}` and the page grew a banner — but that
banner rendered **only while rows were withheld**, so it was a count that existed
exactly as long as the thing it counted was invisible. Flip the default and the
page went silent again in the other direction. A fact that is only stated in one
of two states is not a fact the screen reports; it is a side effect of the state.

**The default was flipped, and the owner reverted it.** This branch first read
the 2026-08-16 measurement as "the rows should be shown" and shipped
`includeUndated=true` as the default. Owner, 2026-08-18, ruling on that build:
*"这个应该是要把没有日期的藏起来的,不过我点 show no date 它才会出来."* The
measurement stands; the inference did not. What the operator could not see was
never the ROWS — it was that rows were being withheld at all, because the page
said nothing about them. This is the ordering worklist and an undated line is not
orderable, so hiding is the right default. **Hiding is legitimate. Hiding
SILENTLY is not.** The banner needed no change when the default went back: it had
been built to speak in both directions precisely so a flip could not restore the
silence, and its tests passed unmoved.

**The obvious fix was rejected, deliberately.** Making the delivery date REQUIRED
was considered first. 43% of 2990's sales orders carry no delivery date, and the
share is flat across June/July/August — a habit, not an import artefact. (HOUZS's
81.9% IS an import artefact: its AutoCount importer's INSERT carries neither
delivery nor processing date. The two numbers have different causes and must not
be quoted as one.) Forcing the field does not produce dates, it produces FAKE
dates — and a fake date is strictly worse than a null one here, because MRP
allocates supply BY DELIVERY DATE. A null sorts last and can only take what is
left over; a fake promise sorts wherever it was typed and can take supply from a
real one. So the null stays and the SILENCE goes.

**Why the default is a display decision at all.** `includeUndated` has been
DISPLAY-ONLY since audit D6 (2026-08-01): the allocation always ran over the full
active set with undated lines sorted LAST, because `byDateAsc`
(`backend/src/scm/routes/mrp.ts:342-347`) returns `1` for a null. Every dated
line's coverage is identical under both flag values, so this flag changes which
rows are RENDERED and cannot move a unit of supply — which is what made flipping
it, and unflipping it, safe to do on the owner's word. That is the load-bearing
claim, so it is pinned rather than asserted: `mrp.test.ts` — *"a dated line wins
the scarce bucket over an undated one — under either flag, whatever the row
order"* — feeds the undated row in FIRST against a PO that cannot cover both, and
requires the dated line to come out whole under both flag values. Inverting the
two null branches of `byDateAsc` fails it (the dated line drops to `shortage`),
which is the check that the test is measuring the sort and not the insertion
order.

**The count is now unconditional.** The banner renders whenever there IS undated
demand and only its wording depends on the flag: *"…are listed below, sorted last
and marked No date"* against *"…are hidden from this view"*, with **Hide them** /
**Show them** pointing whichever way the operator is not. `hidden` is read from
the RESPONSE rather than from the checkbox, so a flag the server did not honour is
described as it actually came back.

**One adjacent trap closed.** `useMrp` built its query string as
`if (includeUndated) q.set('includeUndated', 'true')` — it expressed "hide" by
SILENCE, which only works while the server default happens to agree with it. That
is the omitted-parameter no-op this repo keeps re-learning, and it is exactly what
would have bitten the flip: with the default true, unticking the box would have
sent nothing and changed nothing on screen. The default came back, but the latent
trap did not have to stay: the flag is now sent in both directions, so the client
states what it wants and the response states what it got.

**Files.** `backend/src/scm/routes/mrp.ts` (comments — the parser's default is
unchanged), `frontend/src/vendor/scm/lib/mrp-queries.ts` (always send the flag),
`frontend/src/pages/scm-v2/Mrp.tsx` (two-state banner, `DeliveryCell` No-date
tag), `backend/src/scm/routes/mrp.test.ts`,
`frontend/src/pages/scm-v2/mrpUndatedBanner.test.tsx`, `docs/modules/mrp.md`,
and four probe/audit scripts whose printed notices still described the old
default.
