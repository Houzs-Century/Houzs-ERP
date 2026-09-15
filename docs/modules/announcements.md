# Announcements

Office notices (composed, approved, published) and system notices (machine-
generated per-user alerts) sharing one `public.announcements` table. Every
signed-in user reads their own feed; managers / a Sales Director / approvers
compose, retarget and approve; field/crew and office staff all get the
pop-up, bell and inbox on desktop and mobile.

## Statuses and flow

- `announcements.source` is the core split: `NULL` = **human post** (desktop
  Reading/Manage inbox, mobile list, both pop-ups). `'scan'` /
  `'service_case'` / `'so_amendment'` / `'po_amendment'` = **system notice**,
  a private per-user notice riding the same table — bell only on both
  shells, **never** the pop-up. A new producer needs only to pick a
  non-NULL `source`; the bell slice is `source IS NOT NULL` with no
  whitelist.
- Human-notice approval: `DRAFT` → `PENDING_APPROVAL` → `APPROVED` (published
  and numbered) or `REJECTED` (reason required; submitter can resubmit).
  Only `APPROVED` is ever delivered — `deliverableNow()` is the single
  function every read path (list, both banner scopes, ack, escalation cron)
  calls to decide that.
- Void, not delete: a submitted (non-draft) notice is retired with `POST
  /:id/void {reason}` — row, receipts and reference number are kept and
  marked void, never removed. `DELETE /:id` only ever discards a `DRAFT`; a
  database `BEFORE DELETE` trigger refuses any other delete underneath the
  app.
- Document type (`doc_type`: `ANN` / `MEMO` / `SOP` / `WARN` / `NTC`) picks
  which per-department, per-month numbering series and which
  attachment-required policy applies; the reference number
  (`[DEPT]-[TYPE]-[YYMM]-[NNNN]`) is minted only on approval, optionally on a
  different department's series than the submitter's own
  (`number_dept_id`).
- Acknowledgement: `require_ack` (explicit, else category default —
  WARNING/SOP block, GENERAL/LEARNING don't) decides whether a notice can
  pop the mandatory modal. A reader gets exactly one session postpone; the
  next appearance drops every dismiss affordance until acked. `scheduled_at`
  holds a future notice back from every read path until it arrives.
- Overdue escalation: any active, human, ack-required, deliverable notice
  past 48h unacknowledged is escalated once (cron + manual button) — one
  system notice per pending person's supervisor chain (excluding the
  wildcard `*` holder and the top 2 upline levels) — then `escalated_at` is
  stamped so it is never rescanned.

## Permissions

- **Read** is authentication-only, audience- and company-filtered
  server-side (`userCanSee` / `companyCanSee`) — there is no permission gate
  on the list or banner reads. The `announcements.read` permission key
  exists but gates no route at this commit; do not assume it controls
  visibility.
- **Compose / manage** (`announcements.write` or `*`): create, edit, retarget,
  remind, escalate, void, delete-draft, upload media, read receipts. A
  **Sales Director** gets the same doors via `requirePermissionOrSalesDirector`
  but is restricted server-side to their own Sales department (whole dept or
  named people in it — no position or company targets) and to rows they
  themselves authored (`sdBlockedFromRow`, refused as 404, not 403).
- **Approve** (`announcements.approve`) is a separate permission from write —
  the approval desk (approve/reject a pending notice) does not require
  `announcements.write`, and a write holder cannot approve without also
  holding this key.
- **Acknowledge** (`POST /:id/ack`) is open to any signed-in user for any
  active, non-expired notice — it does not check `userCanSee`, so a user can
  technically ack a notice not addressed to them (harmless: nothing is
  returned).

## Rules that must not break

- `deliverableNow()` is the one gate for "may a reader see this now"
  (approval status, void, active, schedule, expiry) — every read path must
  call it rather than re-deriving its own condition.
- Sales Director audience restriction is enforced **server-side**
  (`enforceSalesDirectorScope`); the composer UI hiding position/company
  targets is cosmetic only, not the boundary.
- Rich body (`body_html`) is only ever written through the allow-list
  canonicaliser (`announcementRichText.ts`) — a fixed tag/attribute grammar,
  inline images checked against the notice's own attachment manifest
  (`img[data-att]` keys not in `attachments` are stripped). `body` (plain
  text) is always server-derived from `body_html`, never taken from the
  client, so the two columns cannot disagree.
- Translation runs **after** the response is sent (`waitUntil`), guarded by
  a text-match `UPDATE` so a stale reply after a later edit is dropped
  rather than overwriting newer text — never await the translation call
  inline in the create/patch path.
- Create is idempotent by client-supplied `client_key`
  (`(created_by, client_key)` unique) — a retried submit after a timeout or
  reload must reuse the same key and get the original row back, not a
  duplicate.
- KV banner cache TTL (300s) must stay comfortably above the poll interval
  (60s), and any write that changes targeting (user's department/position/
  role/company, or a department delete) must bust the banner family version
  for the affected users — a session-only bust is not enough.
- Attachment policy (`attachment_required` per document type) gates both
  `POST` (non-draft) and `POST /:id/submit` — a draft can always be saved
  without a file, but submission/approval cannot proceed while the type
  demands one and none is attached.
- The three sibling routers (`announcements.ts`, `announcementReceipts.ts`,
  `announcementApproval.ts`) share one set of row-visibility helpers
  (`companyCanSee`, `getScopedAnnouncement`, `salesDirectorScope`,
  `sdBlockedFromRow`) imported from the main router — never re-implement
  these in a sibling file, or the three can disagree about who sees what.

## Gotchas

- Do not write a mutation with a bare `catch(() => {})` — a refused Remind
  used to report "Reminder sent" on a 403; every mutation must confirm and
  surface the server's actual answer (`frontend/scripts/check-silent-mutations.mjs`
  checks for this shape).
- Do not make a permission/capability prop like `canManage` optional on a
  shared component — an omitted prop must not default to permissive
  (`optional-param-noop` class).
- Do not await a translation (or similar slow AI) call inside the
  create/patch request — it previously blocked the response for 40-100s,
  and a user's repeated click during that hang inserted duplicate rows.
- Do not treat the mobile publisher ledger and the mobile reader feed as one
  cache — they are two different queries (`mobile-ann-ledger` vs the banner
  `human` scope) and a write must invalidate **both**, or the screen a
  publisher is looking at goes stale.
- Do not draw an unread dot from the publisher ledger — a publisher's own
  hidden/expired/other-audience rows live there and can never be cleared;
  only the reader feed's ids may drive the unread indicator.
- Do not assume `is_active` or `expires_at` is a boolean/date type in code —
  `is_active` is integer 0/1 and timestamps are ISO text, per this table's
  long-standing convention.
- Do not add a category color/label without updating both the shared
  desktop table (`announcementCategory.ts`) and mobile's separate hex map
  (`MobileAnnouncements.tsx` / `MobileAnnouncementPopup.tsx`) — mobile does
  not import the shared table for its CSS colors.

## Where the code is

- Backend routes: `backend/src/routes/announcements.ts` (main: create, patch,
  list, banner, ack, remind, attachments, delete-draft, void),
  `announcementReceipts.ts` (acks/ack-summary/ack-trend/team-pending/escalate),
  `announcementApproval.ts` (submit/approve/reject/files) — all three mounted
  on the same `/api/announcements` prefix and must be mounted together in
  tests.
- Backend services: `backend/src/services/announcementApproval.ts`
  (approval-state transitions), `announcementFiles.ts` (attachment policy +
  log), `announcementEscalation.ts` (overdue escalation, cron + manual),
  `personalNotice.ts` (the single system-notice insert path),
  `documentRefs.ts` (reference-number minting/voiding),
  `permissionHolders.ts` (audience-by-permission resolution for amendment
  notices), `amendmentNotify.ts`, `assrNotify.ts`.
- Backend libs: `backend/src/lib/announcementAudience.ts` (row
  visibility/audience/roster helpers shared by all three routers and the
  cron), `announcementRichText.ts` (rich-body grammar), `translate-announcement.ts`.
- Desktop: `frontend/src/pages/Announcements.tsx` (shell) +
  `frontend/src/pages/announcements/` (`InboxView.tsx`, `ManageView.tsx`,
  `RegisterView.tsx`, `ComposerModal.tsx`, `AudiencePicker.tsx`,
  `announcementModel.ts`); shared components
  `frontend/src/components/AnnouncementBanner.tsx`,
  `useAnnouncementBanner.ts`, `announcementCategory.ts`,
  `NotificationBell.tsx`, `AnnouncementDashboard.tsx`,
  `AnnouncementRichEditor.tsx`, `AnnouncementRichBody.tsx`;
  `frontend/src/lib/announcementStatus.ts`.
- Mobile: `frontend/src/mobile/MobileAnnouncements.tsx`,
  `MobileAnnouncementPopup.tsx`, `useAnnouncementUnread.ts`.
