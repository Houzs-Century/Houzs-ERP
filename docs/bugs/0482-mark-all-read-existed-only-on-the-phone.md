## Mark all read existed only on the phone [low]

<!-- area: Projects + PMS + fair report -->

**Symptom.** The same activity feed could be cleared from a handset and not from
a desk. `MobileInbox` had a "Mark all read" pill; `pages/Notifications.tsx` — the
screen the desktop bell's "view all" lands on — had no write of any kind, only a
Reload button. A desktop user's only way to clear the badge was to open every
project one at a time.

**Root cause (traced).** Not a missing endpoint. `POST /api/projects/:id/read`
already existed and the mobile screen already looped it. The action had simply
been implemented ON a screen rather than in the provider both screens consume,
so the desktop page had nothing to call and the capability stopped at the
surface it was written on.

**Fix.** `markAllRead` moved onto `useNotifications`, the context both surfaces
already use, and the desktop page grew the same control. Deliberately NOT a copy
of the mobile loop onto the desktop page — that would have been a second
implementation of one rule, which is the duplication class this whole audit is
about.

Two behaviour improvements came with the move:

  - It posts only for projects whose unread count is above zero. The old loop
    filtered the same way, but the filter now lives with the action rather than
    being something each caller must remember.
  - **It reports failures instead of eating them.** The mobile version ended
    each request with `.catch(() => {})`, so a bulk mark-read that failed for
    every project was indistinguishable from one that succeeded: the spinner
    stopped, the feed reloaded, the badge stayed up, and nothing was said.
    `markAllRead` returns `{ ok, failed }` and both surfaces render `failed > 0`.
    `Promise.allSettled` replaces `Promise.all` so one project refusing does not
    abandon the rest half-done.

That removal took `MobileInbox.tsx` from 1 bare `catch` to 0, and the
`audit:swallowed-reads` baseline was lowered to match rather than left slack.

Pinned by `frontend/src/hooks/useNotifications.markAllRead.test.tsx`, proved RED
on the unfixed tree — `TypeError: result.current.markAllRead is not a function`,
four failing cases.

**Ref.** fix/mark-all-read-and-self-staff, 2026-08-21.
