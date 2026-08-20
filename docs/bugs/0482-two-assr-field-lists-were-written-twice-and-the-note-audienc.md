## Two ASSR field lists were written twice and the note-audience labels had already drifted [medium]

<!-- area: Service cases (ASSR) -->

**白话.** 在服务单里加一条备注时，要先选这条备注是给谁看的。**只有「Customer」那一
格是客户在网页上真的会看到的**，其他三格是内部的。

问题是：电脑版写「Customer-visible（客户看得到）」，手机版只写「Customer（客户）」。
同一个按钮，电脑版告诉你「按下去客户就会看到」，手机版只告诉你「这格叫客户」。同事
在手机上写一句内部的话，很可能就这样送到客户眼前了。

两边的清单是各写各的，所以才会走样。现在两边读同一份，字眼统一用讲清楚後果的那种
写法。手机上的按钮因为字变长了，改成两行两个排（原本四个挤一行会爆出画面外，这点
是量出来的，不是猜的）。

**Symptom.** The note-audience picker offered `Service (internal)` /
`Customer-visible` / `Supplier (internal)` / `Sales (internal)` on desktop and
`Service` / `Customer` / `Supplier` / `Sales` on mobile. Same four stored
values, two different promises — and `customer` is the only bucket the customer
portal renders, so this is the control standing between an internal remark and
the customer reading it.

**Root cause.** Two hand-written copies of one list, with nothing refereeing
them. `ServiceCases.tsx` spelled its four as literal `<option>` children;
`MobileServiceCase.tsx` held `NOTE_AUDIENCE_OPTIONS`. Neither is wrong-looking
on its own; that is the whole failure mode. The issue-category fallback
(`ISSUE_CATEGORIES` / `ISSUE_CATEGORY_OPTIONS`) is the same pair of copies, still
in sync — which is what the audience labels looked like the day before they
were not.

**Fix.** `frontend/src/vendor/scm/lib/assr/case-fields.ts` owns both lists plus
`assrNoteIsCustomerVisible()`, which the helper line and the textarea
placeholder now call instead of re-testing `=== "customer"` in four places. The
wording kept is the explicit one: a label that names the CONSEQUENCE beats one
that names the bucket. The stored values are unchanged and still exactly the
four `NOTE_CATEGORIES` (`backend/src/routes/assr.ts`) accepts — anything else is
silently coerced to `service`, so a typo there would not have errored.

**Mobile layout, MEASURED not assumed.** The longer labels do not fit four
across a phone: `.sochip` is `white-space: nowrap`, and rendered at 375px with
the real stylesheet the four chips measure 110 + 109 + 116 + 100 px plus gaps
against a 349px content box — `scrollWidth > clientWidth`, i.e. the row runs off
the screen. The two pickers now carry `flexWrap: "wrap"` with `flex: "1 1 45%"`:
same measurement gives 171px per chip, two rows, `overflowsHost: false`, nothing
clipped.

**Guard proved RED before being trusted.**
`frontend/src/vendor/scm/lib/assr/case-fields.canonical.test.ts` — 10 of its
tests fail on the unfixed tree (`has re-grown its own audience list`, `no longer
reads the shared audience list`, `hand-types the audience label "Service
(internal)"`, `hand-types the issue category "Product defect"`, and both `no
longer renders the shared audience list`).

**A false positive caught in the guard itself, recorded because it is the
cheaper half of this lesson.** The first draft scanned each file tree-wide for
`>Customer<` / `>Supplier<` and reported mobile as drifted — the hit was the
supplier CARD's `<span>Supplier</span>` field label, which has nothing to do
with note audiences. A scan that matches a word rather than a role is a checker
that reports about a system we do not run (CLAUDE.md: *a checker that cannot
match reports a clean run* — this is its mirror image). The assertion is now
scoped to the block that maps the shared list.

**Ref.** `fix/assr-constant-drift`, 2026-08-21.
