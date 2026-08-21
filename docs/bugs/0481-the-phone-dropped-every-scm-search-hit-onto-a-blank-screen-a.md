## The phone dropped every SCM search hit onto a blank screen, and a notice posted from a phone could never be taken down [high]

<!-- area: Mail, search, notifications -->

**What staff saw.** Three complaints, one cause.

1. 在手机上搜一张交货单 / 收货单 / 发票的单号，**画面一片空白** —— 没有结果，也
   没有一句「找不到」。看起来像坏了。
2. 用手机发的公告，**没办法设定什么时候自动下架**，发出去之后也**没办法在手机上
   隐藏或删除**。要拿电脑才做得到。
3. 按了「提醒还没看的人」，按钮马上变成「已发送提醒」—— 但伺服器其实**拒绝了**，
   没有人收到任何提醒。

**One root cause, three symptoms: the phone was written beside the desktop
instead of sharing its rules.** Same class as
`docs/bugs/0463-the-phone-re-implemented-three-mail-center-rules-the-desktop.md`.

**1. Search: the render list and the empty-state gate answered two different
questions.** `frontend/src/mobile/MobileSearch.tsx` rendered a `TYPE_ORDER` array
holding **five** of the ten `SearchHitType`s — the five with a mobile detail
screen — while the "No matches" line was gated on `hits.length === 0`, the RAW
server count. An SCM-only result set satisfied both halves at once: hits came
back, the empty state was suppressed, every hit was filtered out, and the scroll
area rendered **nothing**. Proven by the test before the fix — the entire
rendered body was the string `‹ Back`.

The exclusion itself was reasoned and written down (no mobile screen, so a tap
would go nowhere) and it stays. What was wrong was answering "I cannot open it"
with "I will not show it". The five SCM documents now render as read-only cards
marked **Open on desktop**, and the display order is `Object.keys(TYPE_LABEL)`
where `TYPE_LABEL` is `Record<SearchHitType, string>` — so **tsc** now refuses a
hit type that is not listed, and no future type can be dropped by omission.
Whether a card is a `<button>` is decided by `navFor` alone, so there is no
second "openable" list to drift out of step with it.

**2. Announcements: the phone composed against the publisher API and then read
the reader API.** `MobileAnnouncements.tsx` had **zero** references to expiry
anywhere in the file — no control, no key in the POST body — while the backend
has accepted `expiresAt` on create and PATCH all along
(`backend/src/routes/announcements.ts`). It also had no PATCH and no DELETE. And
its list read `GET /api/announcements/banner?scope=human`, which the backend
filters to active **and** not-expired, so a publisher could not even SEE a notice
they had hidden.

That gap was **asymmetric**, which is part of why it went unreported: the banner
feed DOES return a Sales Director their own inactive/expired posts, so an SD saw
theirs on the phone while a full `announcements.write` manager saw none of
theirs. Publishers now read the ledger (`GET /api/announcements`, the endpoint
the desktop page already uses) with Live/Hidden/Expired badges, an expiry field
on the composer, and Hide/Show + Delete on the detail screen.

**3. Remind claimed a success it was never told about.** The whole handler was
`api.post(url).catch(() => {}); setReminded(true);` — no confirm, no body, and an
error path that threw away the server's own sentence. A 403 (a Sales Director
reminding on somebody else's notice, `sdBlockedFromRow`) or a 404 printed
"Reminder sent" on the button and left no trace anywhere: no toast, no console
line. The publisher walked away believing the roster had been re-popped.

The missing body was **safe** — the backend defaults `scope` to `unacked` — but
sending it explicitly is what makes the `scope: "all"` reset possible at all,
which is why the phone had no reset button. Both actions now confirm first and
report the server's own `pendingCount`, success or refusal.

**The fix.** No backend change — all three were client-side. Two rules were
lifted into shared modules rather than copied a second time:

| rule | now lives in | imported by |
|---|---|---|
| Live / Hidden / Expired, and that hidden outranks expired | `frontend/src/lib/announcementStatus.ts` | `frontend/src/pages/Announcements.tsx`, `frontend/src/mobile/MobileAnnouncements.tsx` |
| DD/MM/YYYY date + time entry for the expiry | `frontend/src/vendor/scm/components/DateTimeField.tsx` (already shared) | both composers |

`canManage` and `showStatus` are **required** props, not optional ones: an
omitted permission flag that defaults to permissive is this repo's
`optional-param-noop` class
(`docs/bugs/0098-bug-class-optional-param-noop-an-optional-argument-that-deci.md`).

**Why CI never caught any of it.** `MobileSearch.tsx` and
`MobileAnnouncements.tsx` had **no test file at all** — there was no assertion
anywhere that could have gone red. Twenty tests now cover them, each proven
failing against the unfixed tree first: the search body contained only `‹ Back`
where a document number was expected; the composer had no expiry control to
find; a hidden notice was absent from its own author's list; and Remind had
already flipped to "Reminder sent" without the confirm ever being asked.

**Ref.** branch `fix/mobile-search-announce-assr` (2026-08-21).
