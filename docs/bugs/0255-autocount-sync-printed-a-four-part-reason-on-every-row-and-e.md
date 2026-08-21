## AutoCount Sync printed a four-part reason on every row, and every row [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Same day the screen was rebuilt (#2323), the owner read it against
a real backlog: *「这一个东西下面的地方太复杂了，你尽量简单化一点。一个 sales order
那么宽，那如果我有一千个 sales order 的时候，我不是完蛋？」* Every document with a
problem printed a headline, a sentence, a **To fix** line and AutoCount's
verbatim reply, all at once, and the page opened on Everything.

**Root cause, traced.** Not a defect in any one rule — a density decision taken
against the wrong row count. #2323 was designed and reviewed on a 13-row mockup,
where four inline parts read well. Measured in `frontend/perf-lab` at 400 rows
on 2026-08-16, a desktop `not accepted` row was **311.3 px** and a `held back`
row **233.0 px**, against **79.8 px** for a document already in the account book
that had nothing to say; mobile at 375 px was **387.1 / 335.5 / 102.0 px**. The
list also rendered every row: **400 of 400** in the DOM on both surfaces, a page
scroll height of 66,431 px on desktop. The sales order list is 2,726 documents,
so the mockup's row count was two orders of magnitude under the real one.

**Fix.** Four changes, all keyed off one new shared helper so the two surfaces
cannot drift: `acRowDetail(row, reasonCleared)` splits a row into the line that
is ALWAYS visible and the part behind an opener.

1. The page opens on `AC_DEFAULT_STATE = 'attention'`, not on everything.
2. A problem row shows the plain-language headline only. The sentence, the
   **To fix** line and the quoted reply are behind opening that row —
   `acOpensItself` keeps `reason_kind === 'unrecognised'` open on arrival,
   because there the quoted note IS the answer.
3. A `sent` row is `expandable: false` even when it carries a note.
4. The strips are pinned (`var(--page-header-offset)`, `z-[5]`) and the list is
   windowed with `<MobileVirtualList>` on both surfaces — the component
   `DataTable` and eight mobile screens already use, not a second mechanism.

**Measured after, same harness:** desktop **36.5 / 64.3 / 69.8 px** (in
AutoCount / held back / not accepted, collapsed) with **25** rows in the DOM;
mobile 375 px **53.5 / 83.8 / 88.5 px** with **20** cards. The two things the
owner had explicitly asked for are kept, one layer down: the headline is never
hidden, and *AutoCount replied* / *AutoCount was not asked* stays a labelled
distinction rather than being flattened.

**One trap found on the way.** `<Button className="h-6">` does nothing.
`Button` hardcodes `h-9` and `lib/utils.ts`'s `cn` is a plain `join`, not a
Tailwind merge, so the override loses on stylesheet order — #2323's own
`className="h-8 …"` had been rendering at 36 px. The row uses the `!` important
prefix and says why at the site.

**Ref.** 2026-08-16, follow-up to #2323. Harness:
`frontend/perf-lab` `?scenario=autocount-sync&rows=400` (`&surface=mobile`).
