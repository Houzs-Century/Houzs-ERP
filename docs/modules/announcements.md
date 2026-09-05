> ## Corrections — 2026-08-12 code-read sweep
>
> 1. Every backend cite past ~:590 drifted +28 (file is 1,403 lines; mount index.ts:366; permissions.ts:183) — behavior verified correct at the new locations. 38 claims clean.

# Module: Announcements

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Per-module technical doc — office notices and system per-user notices, from the
screen down to the database. Same structure as
[`sales-order.md`](./sales-order.md).

> Verified against `main` @ `8f8427ed`. Three commits landed on **2026-07-21**
> and changed the permission model; read §6 before you reason about who can see
> what. **2026-08-08 (system notices to the bell):** machine-generated notices
> no longer pop a banner on either shell — the `/banner` default is now the
> HUMAN slice, and the desktop bell (`NotificationBell`) gained a System-notices
> section. Sections 0-2 and 5-6 below are updated for that change.
> **2026-09-02 (amendment notices):** the SO / PO amendment workflow became the
> third and fourth system-notice producer (`'so_amendment'` / `'po_amendment'`),
> and the desktop bell's unread affordance went from the quiet dot back to the
> NUMBER — the owner routed approvals here, and a dot cannot say how many are
> waiting. §0 and §"System notices" below carry the detail.
> **2026-09-04 (rich body):** the composer gained bold / italic / underline,
> three extra text sizes and numbered + bulleted lists (owner ask). The
> formatted body lives in a new `body_html` column as a strictly
> canonicalised fragment; `body` is now its plain-text shadow. §1 "Rich
> body", §3 "Write path" and §4 carry the contract.

> Convention: the row is one table, `public.announcements`. Timestamps are
> stored as **ISO text**, `is_active` is an **integer 0/1** (not boolean), and
> every audience list is a **JSON string** holding an integer array.

---

## 0. The one distinction that explains the module

`announcements.source` splits the table in two, and almost every rule below
keys off it:

| `source` | Called | Written by | Where it surfaces |
|---|---|---|---|
| `NULL` | **human post** | the composer, `POST /api/announcements` | desktop page + list, mobile list, both pop-ups (`/banner` default = `?scope=human`) |
| `'scan'` / `'service_case'` / `'so_amendment'` / `'po_amendment'` | **system notice** | `services/personalNotice.ts` | `?scope=system` only — the BELL on both shells (desktop `NotificationBell` System-notices section, mobile Announcements bell) + the unread badge. **Never the pop-up** (owner 2026-08-08) |

The `source` values are not a whitelist anywhere: the bell slice asks only for
`source IS NOT NULL`, so a new producer starts surfacing the moment it picks a
tag. That is why adding the amendment notices (2026-09-02) needed no change to
this route, this table's schema, or either shell's reader.

A system notice is a *private* announcement (`target_type='USER_IDS'`,
`created_by NULL`) riding the announcements machinery so it inherits the unread
dot, the banner and the ack — there is no separate notification table
(`backend/src/services/personalNotice.ts:1-16`). `GET /api/announcements`
filters `source IS NULL` in SQL (`backend/src/routes/announcements.ts:545`) so
system notices never clutter the office composer list.

---

## 1. Frontend

### Screens

> **2026-09-05 — Announcements redesign (design handoff 2026-09-04).** The
> desktop page is now TWO MODES on one route — *Reading* (a two-pane inbox
> every signed-in user gets) and *Manage* (ack rates + a notice → department →
> person drill-down, behind `announcements.write`) — and the desktop pop-up is a
> **mandatory-acknowledgement modal** that pops only for a notice that requires
> acknowledgement. The rules that moved are listed in each section below; the
> shared rule files are `frontend/src/components/announcementCategory.ts` (one
> table of category colours / CTA wording / which categories block) and
> `frontend/src/pages/announcements/announcementModel.ts` (inbox grouping,
> archiving, ack-rate thresholds, manage status).

| Surface | File | Notes |
|---|---|---|
| Desktop page shell (mode toggle, fetches, composer) | `frontend/src/pages/Announcements.tsx` | `Announcements()`; `canWrite` gates the Reading/Manage toggle, the composer CTA, Export receipts and every manage action. Reads the SAME `useAnnouncementBanner` hook the modal reads, so "addressed to me / acked / pending" can never differ between the page and the pop-up |
| Reading mode (inbox) | `frontend/src/pages/announcements/InboxView.tsx` | 396px list — pinned *Needs your confirmation*, *Recent* with Confirmed/Unread pills, *SOP Library* grouped by department — beside the reading pane with the writer-only read-receipts card and the sticky acknowledge bar. Presentational; grouping is `bucketInbox()` in `announcementModel.ts` |
| Manage mode | `frontend/src/pages/announcements/ManageView.tsx` | 4-up stat strip, the ack-rate table (`GET /ack-summary`), the drawer's *By department* buckets and per-person state pills (`GET /:id/acks`), *Remind pending* and *Notify their supervisors* (`POST /:id/escalate`) |
| Desktop composer modal | `frontend/src/pages/announcements/ComposerModal.tsx` + `AudiencePicker.tsx` | 1060px card: category pills, **Require acknowledgement** (defaults on for WARNING / SOP), title, the shared `AnnouncementRichEditor`, attachment strip, **Schedule** (`scheduledAt`) and Hide after (hidden for SOP — it never expires), Preview, and the three-column audience (Company · Dept / Role · People). Audience maps 1:1 onto the existing targets: departments → `targetDeptIds`, people → `targetUserIds`, company → `targetCompanyIds`, **All staff** → no target (an explicit choice — an empty picker refuses to post, never broadcasts). Inclusion only: there is no exclusion list. Position targeting is no longer offered on desktop (owner 2026-09-05; the phone composer still has it). The draft autosaves per user to `localStorage["announcements:draft:u<id>"]` ("Draft saved HH:mm") and is cleared on post. `buildPostBody()` is the pure request builder, pinned by `ComposerModal.test.tsx` |
| **Desktop pop-up** | `frontend/src/components/AnnouncementBanner.tsx` | mounted **once**, at the app root: `frontend/src/App.tsx:353` |
| **Phone pop-up** | `frontend/src/mobile/MobileAnnouncementPopup.tsx` | mounted above the tab shell AND above any overlay: `frontend/src/mobile/MobileApp.tsx:600-604` |
| Shared pop-up logic | `frontend/src/components/useAnnouncementBanner.ts` | the feed read, the ack, the dismiss rules — **both** shells consume it |
| Mobile list + system bell | `frontend/src/mobile/MobileAnnouncements.tsx` | READER feed + system bell. **Publishers read the LEDGER instead** — see *The mobile list has two sources* below. **2026-09-05 (screen 7):** header pending pill, a **Needs you · All · SOP** filter row, and **inline acknowledgement** on a reader's pending card (44px category CTA + "Read full"); an acknowledged card reads "Confirmed". "Needs you" = mandatory + addressed to me + unacked — the same `requiresAcknowledgement()` rule the desktop inbox and both pop-ups apply |
| Shared status rule (Live / Hidden / Expired) | `frontend/src/lib/announcementStatus.ts` | imported by BOTH the desktop row and the phone card; neither re-derives it |
| **Desktop bell — one unread entry point** | `frontend/src/components/NotificationBell.tsx` | 404px popover with tabs **All · Announcements · System** (2026-09-05). Announcements = the human feed through the shared `useAnnouncementBanner` hook (unread = unacked; a mandatory row carries an inline **Acknowledge**, the others **Mark read**, both `POST /:id/ack`); System = `?scope=system` machine notices (tag from `source`: Scan / Service case / Amendment / Team) + the per-project activity feed. **Mark all read** sweeps unread system notices, non-mandatory announcements and the project feed — never a mandatory notice. Mounted in `TopNavbar.tsx` + the sidebar's mobile drawer; the badge is every unread across the three sources, capped `99+` |
| **Dashboard banner stack + supervisor card** | `frontend/src/components/AnnouncementDashboard.tsx` (mounted on `pages/Overview.tsx`) | `AnnouncementBannerStack`: up to three unacknowledged notices under the greeting — first expanded (category CTA + View details / Read SOP → `/announcements?id=…`), the rest collapsed, overflow behind "n more notices collapsed · Expand"; same hook as the modal, so an ack here settles everywhere. `TeamPendingCard`: `GET /team-pending` — renders only for a user with direct reports; lists each report's unacked mandatory notice with its state; **Remind all** (one `remind {scope:"unacked"}` per distinct notice) only for `announcements.write` holders, since the remind route is write-gated. The handoff's "Ack rate · last 30 days" chart has no endpoint yet and is not rendered |
| Media renderers | `frontend/src/components/AnnouncementMedia.tsx` (lazy) / `frontend/src/mobile/MobileAnnouncementMedia.tsx` | |
| Unread badge hook | `frontend/src/mobile/useAnnouncementUnread.ts` | |

### The mobile list has two sources, and which one you get is your permission

*Added 2026-08-21.* `MobileAnnouncements` renders **the publisher ledger**
(`GET /api/announcements`, query key `["mobile-ann-ledger"]`, `enabled: canCreate`)
for anyone who can compose, and **the reader feed**
(`GET /api/announcements/banner?scope=human`) for everyone else. The reader feed
is still fetched for both, because it is what supplies `ackedIds` and it is the
query the pop-up and the unread badge share — it must stay reader-scoped.

**Why it is not one source.** The backend filters `/banner` to active AND
not-expired. The phone read only that, so a publisher who hid or expired a notice
could not see it on their own phone — nothing to badge, nothing to press, no way
back. Worse, the gap was **asymmetric**: `announcements.ts` returns a Sales
Director their OWN inactive/expired posts on the banner feed, so an SD saw theirs
while a full `announcements.write` manager saw none of theirs.

Two consequences to keep in mind when editing this screen:

- **An unread dot may only be drawn for a row in the READER feed.** A publisher's
  ledger contains hidden, expired and other-audience notices; a dot on one of
  those can never be cleared by anybody. `readerIds` is the set that gates it.
- **Every write busts BOTH** — `refreshFeeds()` invalidates
  `ANNOUNCEMENT_FEED_KEY` and `["mobile-ann-ledger"]`. Invalidate one and the
  screen the operator is looking at goes stale.

### Publisher actions exist on the phone now

*Added 2026-08-21.* Desktop had these from the start; the phone had none of them,
so a notice posted from a phone was permanent and un-retractable from a phone.

| Action | Mobile | Desktop |
|---|---|---|
| Set an expiry at compose time (`expiresAt`) | composer field "Hide automatically after", shared `DateTimeField` | `Announcements.tsx` composer, same label, same control |
| Hide / show (`PATCH { isActive }`) | Detail > Publisher | row action |
| Delete (`DELETE /:id`) | Detail > Publisher, behind a confirm | row action, behind a confirm |
| Remind un-acked (`POST /:id/remind` `{ scope: "unacked" }`) | Receipts panel, behind a confirm, reports the server's `pendingCount` | same |
| Reset all receipts (`{ scope: "all" }`) | Receipts panel, danger confirm | same |
| Live / Hidden / Expired badge | `StatusChip`, from `lib/announcementStatus.ts` | same module |

Both surfaces gate these on the same rule the backend enforces
(`sdBlockedFromRow`): a full `announcements.write` manager may act on any human
notice; a Sales-Director-only publisher may act only on notices they authored.
Mobile passes it as a REQUIRED `canManage` prop rather than an optional one —
an omitted permission flag that defaults to permissive is this repo's
`optional-param-noop` bug class.

**The Remind button used to lie.** It was
`api.post(url).catch(() => {}); setReminded(true)` — no confirm, no body, no
error path — so a 403 or 404 produced the words "Reminder sent" and nothing
anywhere else. Every mutation on this screen now confirms first and reports the
server's own answer, success or refusal. Do not reintroduce a bare `catch {}`
here; `frontend/scripts/check-silent-mutations.mjs` is the standing check for
the same shape on `useMutation` sites.

### Both pop-ups are human-only (owner 2026-08-08)

Both shells pop `scope: "human"`. The phone has since owner 2026-07-20: a
`scan` notice is addressed to the person who scanned, so popping that scope
would throw a sheet at the operator every time their own upload finished. The
desktop caught up on 2026-08-08 ("为什么一直有这个"): it used to take the
unscoped full feed, so every "New service case ASSR/…" popped a modal card —
and under the two-skips-then-mandatory-ack rule (#1728) that modal eventually
refused to leave. Machine notices are bell material on both shells now: the
phone's bell inside the Announcements screen, and on desktop a System-notices
section inside `components/NotificationBell.tsx` (same `?scope=system` slice,
same ack; rows settle via a "Mark read" button — there is no navigation
target, since the desktop Announcements page lists human posts only).

### Pop-up trigger logic (all in `useAnnouncementBanner.ts`)

- **Only a notice that REQUIRES acknowledgement pops (2026-09-05).**
  `requiresAcknowledgement()` in `components/announcementCategory.ts`: the
  per-notice `requireAck` flag when the payload carries it, else the category
  rule — `WARNING` / `SOP` block, `GENERAL` / `LEARNING` never do (they are
  read and acknowledged inline: the inbox's Recent group, the dashboard stack,
  the bell). Both shells share this through the hook. The hook also returns
  `pendingCount` / `pendingIndex` (the modal's "n of m pending"),
  `canPostpone(a)`, and the page-facing sets `addressedIds` / `ackedIds`.
- **Current notice** = the first MANDATORY feed row that is neither
  session-dismissed nor locally acked — or that *is* locally acked but whose
  `remindedAt` is newer than the local ack stamp, i.e. the office pressed
  **Remind** since you acknowledged (`isRemindedSince`).
- **Sibling instances stay in step.** The root modal and the Announcements
  page each mount the hook; a same-tab write fires no `storage` event, so the
  writer pings a module-level listener set and every instance re-reads the ack
  memo, the skip counter and the dismiss set. The ack is written to storage
  synchronously (not inside a lazy state updater) for the same reason.
- **Local ack memo**: `localStorage["announcements:localAcks"]`, a
  `{ id: ackedAtMs }` map (`:76-96`). The server's `ackedIds` are merged into it
  additively (`:183-198`) so the pop-up stays down across a reload before the
  next poll lands.
- **Session dismiss**: a *module-level* `Set` (`:103`), not component state and
  not persisted — the phone unmounts the pop-up on every shell navigation, and a
  just-waved-away notice must not spring back on the next mount. It re-surfaces
  on the next visit.
- **Postponement (2026-09-05, superseding #1728's two skips): ONE, then
  acknowledge-only.** Each session-dismiss of a notice ("Remind later",
  backdrop tap, mobile sheet-x) counts one skip in
  `localStorage["announcements:localSkips"]` — identity-scoped and sanitised by
  the same `announcementLocalAcks.ts` module as the ack memo, stored as
  `{ id: { n, at } }`. When a notice's count reaches
  `MAX_ANNOUNCEMENT_SKIPS` (**1**), the hook returns `mustAcknowledge: true` and
  both shells drop every dismiss affordance; the note under the desktop modal
  goes from "You can postpone once" to "This notice requires acknowledgement"
  and only the ack button remains (`dismissSession` also refuses at the limit,
  so a missed call site cannot grant another skip). A postponed notice STAYS in
  the inbox's pinned group — postponing only stops the modal for the session.
  The mobile "View details"/"Read SOP" step-aside does **not** count (it
  navigates the reader TO the notice via the non-counting
  `hideForNavigation`). Acking clears the notice's count, so an office Remind
  re-pops with a fresh allowance. The count is local like the acks — the
  backend records acks, never dismissals — so the allowance is per
  browser+identity, not per account across devices.
- **Secondary button**: the desktop modal's secondary is always "Remind later"
  (postpone) — the reader is never navigated away, because the page behind the
  modal is where the notice is read anyway. `bannerSecondaryKind()` (`WARNING`/
  `SOP` → navigate, `GENERAL`/`LEARNING` → dismiss) is now consumed by the
  PHONE pop-up only.
- Backdrop tap **never** acks.

### The unread badge is computed client-side

There is no unread endpoint. The badge is `data` minus `ackedIds` from the same
`/banner` payload (`useAnnouncementUnread.ts:25-26`), summed over the **human**
and **system** scopes (`:43-47`). Before 2026-07-21 it counted `system` only, so
an ordinary office broadcast contributed nothing — no pop-up, no dot, no way to
learn it existed.

Render sites: the mobile Profile bottom tab (`MobileApp.tsx:440`, pill at
`:805-809`), the Profile > Announcements row (`MobileProfile.tsx:198`, `:345`),
and the in-screen bell (`MobileAnnouncements.tsx:343`). **The desktop sidebar
has no badge** at this commit (`Sidebar.tsx:666-672` carries only
`section/to/label/icon`); no comment says whether that is deliberate.

### Caching / polling

One React Query key namespace covers every `/banner` read, dimensioned by scope
(`useAnnouncementBanner.ts:67-70`):

```
ANNOUNCEMENT_FEED_KEY = ["announcements-feed"]
announcementFeedKey(scope) = ["announcements-feed", scope]
```

so each scope is fetched **once** no matter how many surfaces are mounted, and
the phone's pop-up costs no extra request over the badge it already feeds.

| Consumer | Key | staleTime | Poll | Cite |
|---|---|---|---|---|
| Desktop pop-up | `…"human"` | 60s | 60s, **including while the tab is hidden** | `useAnnouncementBanner.ts` |
| Desktop bell (system section) | `…"system"` | 30s | 30s | `NotificationBell.tsx` |
| Phone pop-up | `…"human"` | 30s | 30s | `MobileAnnouncementPopup.tsx:54-57` |
| Unread badge (×2) | `…"human"`, `…"system"` | 30s | 30s | `useAnnouncementUnread.ts:17-24` |
| Mobile list / bell | `…"human"` / `…"system"` | 30s | none (mount/focus) | `MobileAnnouncements.tsx:275-292` |
| Desktop page list | `["uq","/api/announcements"]` | app default | none | `Announcements.tsx:225` |

(There is no `…"all"` key any more — `BannerScope` is `human | system`.)

Acking anywhere invalidates the **bare prefix**
(`useAnnouncementBanner.ts:237`, `MobileAnnouncements.tsx:359`), so every scope
refreshes at once and the badge drops immediately instead of a poll later.

Note the desktop page uses the app's own `useQuery` wrapper
(`frontend/src/hooks/useQuery.ts`), a different key family from the banner — the
page does not refresh when the banner polls; it calls `listQ.reload()` after its
own writes (`Announcements.tsx:294`, `:325`).

---

## 2. API surface

Mounted at `backend/src/index.ts:275`, inside the authed `/api/*` wall.
For the machine-generated inventory (auth boundary, company boundary, gate,
source line) see
[`docs/generated/route-capability-matrix.csv`](../generated/route-capability-matrix.csv)
— its **gate** column is authoritative; its line numbers drift between regens.

| Method | Path | Line | Gate |
|---|---|---|---|
| GET | `/api/announcements` | `:530` | **none** — explicit 401 on missing session (`:535-538`) |
| GET | `/api/announcements/banner` | `:584` | **none** — explicit 401 (`:585-588`) |
| POST | `/api/announcements/:id/ack` | `:1194` | **none** — explicit 401 (`:1195-1198`) |
| GET | `/api/announcements/:id/attachments/:key{.+}` | `:1308` | none as middleware; audience checked in-handler (`:1325-1333`) |
| GET | `/api/announcements/:id/acks` | `:698` | `announcements.write` (or Sales Director) — since 2026-09-05 also `byDepartment[]`, each person's `departmentId/Name`, `positionName`, `managerId`, and each pending person's `state` (`pending` / `reminded` / `overdue`, window `overdueAfterHours` = 48) |
| GET | `/api/announcements/ack-summary` | — | `announcements.write` (or Sales Director) — `{ id → { total, acked } }` for every human post the caller may manage, ONE round trip for the Manage table (2026-09-05) |
| GET | `/api/announcements/team-pending` | — | **none** — explicit 401; scoped to the caller's DIRECT REPORTS (`users.manager_id = caller`): their unacked mandatory notices with the same `state` (2026-09-05, feeds the dashboard "My team's pending" card) |
| POST | `/api/announcements/:id/escalate` | — | `announcements.write` (or Sales Director) — body `{ departmentId? }`; posts ONE system notice (`source 'ack_escalation'`) per supervisor of the pending people, via `postPersonalNotice` (2026-09-05, the drawer's "Notify their supervisors") |
| POST | `/api/announcements` | `:785` | `announcements.write` (or Sales Director) |
| PATCH | `/api/announcements/:id` | `:920` | `announcements.write` (or Sales Director) |
| POST | `/api/announcements/:id/remind` | `:1104` | `announcements.write` (or Sales Director) |
| DELETE | `/api/announcements/:id` | `:1164` | `announcements.write` (or Sales Director) |
| PUT | `…/:id/attachments/upload` · `…/upload-thumb` | `:1231`, `:1274` | `announcements.write` (or Sales Director) |

`requirePermissionOrSalesDirector` is `backend/src/middleware/auth.ts:195-208`:
401 with no user, pass if the permission is held **or** `isSalesDirectorUser`,
else 403.

### `?scope=` on `/banner`

The endpoint serves exactly **two slices** (owner 2026-08-08 — the unscoped
full feed is gone; its only consumer was the desktop pop-up, which is exactly
where machine notices were badgering):

| `scope` | Returns |
|---|---|
| absent / `human` / anything else | `source` NULL — human-authored posts (the POP-UP slice) |
| `system` | `source` NOT NULL — the per-user `scan` / `service_case` notices (the BELL slice) |

Unknown scopes falling back to the *human* slice — not to "everything" — is
what silences the historical machine rows immediately on deploy: the split is
applied on read, and a stale cached bundle still requesting the unscoped feed
gets the human slice too.

Response is `{ success, data: Announcement[], ackedIds: string[] }`. `ackedIds`
spans only the returned slice, so the bell's acks appear under `scope=system`.
The human slice is one payload however it is asked for, so the default AND
`scope=human` are both served from ONE per-user KV snapshot; `scope=system` has
its OWN per-user snapshot, keyed on scope so the two slices never collide —
see §6.

---

## 3. Backend

`backend/src/routes/announcements.ts` (1,355 lines).

### Read path — two cohorts, one company gate

Both readers run through `companyCanSee` first (`:555`), then split:

1. **Manager** — holds `*` or `announcements.write` (`:550-551`). Gets
   everything, including inactive and expired rows and other people's audiences.
2. **Everyone else** (`:565-574`) — `is_active` AND not expired AND
   `userCanSee(row, userId, deptId, positionId)`. A Sales Director additionally
   always sees rows they authored, whatever their state (`:562-564`), so their
   page is not empty.

`userCanSee` (`:376-393`): `ALL_USERS` → true; otherwise the user's
`department_id` must be in `target_dept_ids`, or their `position_id` in
`target_position_ids`, or their `id` in `target_user_ids`.

`companyCanSee` (`:366-371`): empty `target_company_ids` → visible to all;
**unresolved** allow-list (`undefined`) → fail-open, which is what keeps
single-company Houzs and the D1 test mirror running unchanged; otherwise set
intersection. `allowed === []` is *not* the unresolved case — it means the
reader holds no active company and a company-targeted notice stays hidden.

`GET /banner` (`:631-643`) applies the same predicates **with no manager
bypass** — a manager's own banner is still only their own audience.

Both queries `SELECT *` with no `WHERE` beyond `source IS NULL` and no `LIMIT`;
all filtering happens in JS in the Worker (`:543-547`, `:628-630`).

### Write path

- **Create** `:785` — inserts at `:873`, auto-translates via
  `backend/src/lib/translate-announcement.ts`, then bumps the banner cache
  family version (`:908`).
- **Rich body (2026-09-04)** — `readBodyHtml()` next to `toPublic()`. A
  `bodyHtml` in the request is run through
  `backend/src/lib/announcementRichText.ts` (allow-list canonicaliser:
  `p br b i u s ol ul li` + `span[data-size=sm|lg|xl]`, hard cap 20k chars →
  400). If the result carries no formatting it is stored as **NULL** and the
  notice stays on the plain path. When it IS stored, `body` is **derived**
  from it server-side (`richTextToPlain`) — the client's `body` is ignored,
  so the two columns can never disagree. A request with only `body` is the
  pre-feature contract, untouched. On **PATCH**, whichever of `bodyHtml` /
  `body` was sent last defines the format: `bodyHtml` rewrites both columns,
  a plain `body` clears `body_html`. Translation is sent the HTML instead of
  the text when there is one; the reply is re-canonicalised and split into
  `{title, body, bodyHtml}` per language (`splitRichTranslations`), so a
  translated notice keeps its formatting and a translation that lost its tags
  degrades to plain rather than to garbage. Pinned by
  `tests/announcementsRichBody.test.ts`, `tests/announcementRichText.test.ts`
  and `tests/translateAnnouncementRich.test.ts`.
- **Sales Director restriction** — `salesDirectorScope()` `:412-425`,
  `enforceSalesDirectorScope()` `:431-497`. A Sales Director may address only
  their own Sales department as a whole, or named people inside it. Position
  targets are rejected (`:452-458`) and company targets are rejected
  (`:459-464`). This is enforced server-side; the composer's picker is UX only.
- **Row ownership** — `sdBlockedFromRow()` `:502-506`, applied to acks-readout
  `:705`, patch `:928`, remind `:1111`, delete `:1173`. A Sales Director can only
  manage notices they authored, and the refusal is a **404, not a 403** (it does
  not confirm the row exists).
- **Acknowledgement** `:1194` — `INSERT … ON CONFLICT (announcement_id, user_id)
  DO NOTHING` (`:1213-1219`), so a fire-and-forget double-POST is safe. Requires
  the notice to be active and not expired (`:1201-1207`). Busts only that user's
  banner snapshot (`:1222`).
- **Read receipts** `GET /:id/acks` `:698` — builds the roster from active users
  filtered through `userCanSee` (`:713-726`), so the denominator is the notice's
  real audience, not the whole company.
- **Redesign backend (2026-09-05)** — `mig 20260905T1125` adds `require_ack`
  and `scheduled_at`. On POST, `requireAck` is an explicit boolean or the
  category default (`categoryRequiresAck`: WARNING / SOP); `scheduledAt` in
  the future is stored and holds the notice back, a past instant stores NULL
  (posted at once). `deliverableNow()` is the ONE "may a reader have this now"
  answer used by the list's reader branch, `/banner` and the ack POST: active,
  past its schedule, and not expired — **except an SOP, which never expires**
  (the SOP Library is permanent; a stale `expires_at` on an SOP is ignored).
  Managers still list scheduled rows. `withNames()` resolves `createdByName`
  and `targetDeptNames` on the list and banner payloads because a plain reader
  cannot load `/api/users` or `/api/departments`. The roster helpers
  (`loadRoster`, `audienceOf`, `pendingState`, `announcementRequiresAck`) are
  shared by `/:id/acks`, `/ack-summary`, `/team-pending` and `/:id/escalate`
  so the drawer, the table, the dashboard card and the supervisor notice
  cannot disagree. Pinned by `tests/announcementsAckSummary.test.ts`. Still
  manual: reminders and escalation are the poster's click; the automatic
  overdue-escalation job is a separate follow-up.

### System notices — the producers

Single insert path: `postPersonalNotice()`,
`backend/src/services/personalNotice.ts:34-123` (insert `:94-111`). It never
throws — a notice failure must not fail the operation that triggered it — and
de-dupes an identical still-unread notice (`:68-87`).

| Producer | Call site | `source` | Expiry |
|---|---|---|---|
| Slip-scan completion | `backend/src/scm/routes/scan-so.ts:3581` (wrapper `postScanNotice`) | `'scan'` | 7 days |
| Service-case create / reassign | `backend/src/services/assrNotify.ts:148-155` | `'service_case'` | 14 days (default) |
| SO amendment raised / approved / rejected | `backend/src/services/amendmentNotify.ts` | `'so_amendment'` | 14 days (default) |
| PO amendment raised / approved / rejected | `backend/src/services/amendmentNotify.ts` | `'po_amendment'` | 14 days (default) |

Grep still confirms exactly **two** `INSERT INTO announcements` statements in the
whole tree: `personalNotice.ts` (the one helper every producer above calls) and
the human composer in `announcements.ts`. Four producers, one insert path.

**How the amendment producer picks its audience** (2026-09-02) is the part that
is not like the other two. `scan` and `service_case` are addressed at people a
row already NAMES; an amendment is addressed at whoever can SIGN it, which is a
permission, not a column. `services/permissionHolders.ts` answers the forward
gate question backwards — roles holding the lane's key, their active users,
narrowed by `user_companies` — with two rules worth knowing before you reuse it:

* **The `*` wildcard is excluded.** Owner and IT Admin can approve anything, so
  a literal reading would put them on every amendment ever raised. The helper
  answers "whose desk is this on", not "who is technically able".
* **A zero-grant user is kept, not dropped.** On a single-company install
  `user_companies` is empty and `companyContext` never consults it; filtering on
  an empty grant set would silence the channel entirely.

The audience then expands UP each approver's `manager_id` chain, the same
`uplineUserIds` rule `assrNotify` uses.

---

## 4. Database

`public.announcements` is **not** in `backend/src/db/schema.pg.ts` (grep:
zero hits) — this module is raw SQL, defined entirely in the migration tree.
There is also no announcements migration in the D1 tree.

| Migration | Effect |
|---|---|
| `0058_announcements.sql` | creates `announcements` + `announcement_acks` + 2 indexes |
| `0071_announcements_source.sql` | `+ source text` — the human/system split |
| `0093_native_tables_company_id.sql:76,79` | `+ company_id bigint NOT NULL DEFAULT <HOUZS>` + FK + index on both tables |
| `0113_announcement_target_company.sql` | `+ target_company_ids text` + one-time backfill from `company_id` |
| `0140_announcement_media_layout.sql` | `+ media_layout text` (no backfill; NULL = derive default) |
| `20260904T1700_announcement_body_html.sql` | `+ body_html text` (no backfill; NULL = plain notice, renders exactly as before) |
| `backend/src/db/migrations-pg/20260905T1125_announcement_require_ack_scheduled_at.sql` | `+ require_ack integer NOT NULL DEFAULT 0` (backfilled to 1 for human WARNING / SOP rows) and `+ scheduled_at text` (NULL = posted at once) |

Columns that matter:

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `'ann-' + 12 hex` |
| `is_active` | integer NOT NULL DEFAULT 1 | 0/1, **not** boolean |
| `expires_at` | text | ISO string, NULL = never |
| `reminded_at` | text | drives the "re-pop after Remind" rule |
| `created_by` | integer | `users.id`; **NULL** for system notices |
| `target_type` | text | CHECK ∈ `ALL_USERS`/`DEPARTMENT_IDS`/`POSITION_IDS`/`USER_IDS`/`MIXED` |
| `target_dept_ids`, `target_position_ids`, `target_user_ids` | text | JSON integer arrays |
| `target_company_ids` | text | JSON integer array; NULL/empty = all companies |
| `category` | text | CHECK ∈ `GENERAL`/`WARNING`/`SOP`/`LEARNING` — this is the closest thing to a priority; there is **no** `priority` column |
| `source` | text | NULL = human, `'scan'`/`'service_case'` = system |
| `company_id` | bigint NOT NULL | **authoring** company; no longer the visibility gate (that is `target_company_ids`) |
| `translations`, `attachments`, `media_layout` | text | JSON blobs; a translation pair is `{title, body, bodyHtml?}` since 2026-09-04 |
| `body_html` | text | canonical rich fragment (`lib/announcementRichText.ts` grammar only) or NULL; `body` is always its plain-text shadow, so plain-only readers (bell excerpt, search, old builds) need no branch |
| `require_ack` | integer NOT NULL DEFAULT 0 | 0/1; "this notice must be acknowledged". `toPublic` emits `requireAck: null` when the column is absent (D1 test mirror) and the client falls back to the category rule |
| `scheduled_at` | text | ISO string; NULL = posted at once. Not delivered (list / banner / ack) before it |

`announcement_acks`: `(announcement_id, user_id)` composite **primary key** — the
idempotency guard for the fire-and-forget ack — plus `acked_at` and
`company_id`. No FK back to `announcements`; deletes clean up in app code
(`announcements.ts:1179-1183`).

Indexes: `idx_announcements_active_created (is_active, created_at DESC)`,
`idx_announcement_acks_user (user_id)` (both `0058`), plus the two `company_id`
indexes from `0093`. Note neither read query uses the leading column of
`idx_announcements_active_created` — `GET /` filters on `source`, which has no
index, and `/banner` filters nothing in SQL at all.

---

## 5. Who can see / do what, and where it is enforced

This changed on **2026-07-21**. Three merged commits: `0f8be097` (#957) opened
the page and the list endpoint, `6ca71259` (#959) added the phone pop-up and
made the badge count human posts, `2060378b` (#960) opened the sidebar row.

**Reading is authentication-only and audience-filtered server-side. Composing is
`announcements.write`.**

| Actor | Can | Enforced at |
|---|---|---|
| Unauthenticated | nothing | `/api/*` auth wall + explicit 401s at `announcements.ts:536, 586, 1196, 1310` |
| Any signed-in user | open the desktop page | `frontend/src/App.tsx:481` — a bare `<Route>`, no `<Guard>` |
| Any signed-in user | see the desktop sidebar row | `frontend/src/components/Sidebar.tsx:666-672` — no `perm`/`anyPerm`/`pageAccess` |
| Any signed-in user | see the mobile menu row | `frontend/src/mobile/MobileApp.tsx:360` — `alwaysShow: true`, pinned by `frontend/src/mobile/mobileMenuGates.test.ts:78-83` |
| Any signed-in user | list live, non-expired, audience- and company-matching **human** posts | `announcements.ts:530` (no gate) + `:545` + `:555` + `:565-574` |
| Any signed-in user | read their own banner feed, any scope | `announcements.ts:584` + `:631-643` |
| Any signed-in user | ack, and stream an attachment of a notice targeted at them | `:1194`; attachment audience `:1325-1333`, key ownership `:1340-1344` |
| `announcements.write` / `*` | see every notice incl. drafts + expired (still company-gated); create, edit, retarget, remind, delete, read receipts, upload media | `:550-556`; `:698, 785, 920, 1104, 1164, 1231, 1274` |
| Sales Director (position-derived, holds no flat verb) | the same write doors, but may address only their own Sales dept or named people in it, and may manage only rows they authored | admittance `middleware/auth.ts:202`; scope `:412-425`, `:431-497`; ownership `:502-506` |
| `announcements.read` holder | **nothing extra** | the key is still declared at `backend/src/services/permissions.ts:138` but gates no route, guard or nav row at this commit |

`announcements.read` was the ADMIN list/composer verb. Positions get no
permission-matrix backfill, so no ordinary salesperson ever held it — which is
exactly why the ungated pop-up could offer a "Read SOP" button that landed the
reader on a 403. Opening the page leaks nothing, because the list a plain reader
gets is byte-for-byte the set `/banner` already showed them.

Regression coverage: `backend/tests/announcementsListAccess.test.ts` — a caller
with no `announcements.read` gets 200 and exactly the live rows addressed to
them (`:112`); a manager still gets drafts and other audiences (`:118`); a
missing user is 401 (`:130`); and create / patch / remind / delete / acks all
still 403 for that reader (`:146, 157, 164, 171, 180`).

> Asymmetry worth knowing: `POST /:id/ack` applies `companyCanSee` and the
> active/expiry check but **not** `userCanSee` (`:1201-1207`). A user can
> therefore ack a live notice they are not targeted by. Nothing is returned, so
> the practical impact is a stray `announcement_acks` row.

### Desktop and mobile files that must change together

| Change | Desktop | Mobile |
|---|---|---|
| Pop-up behaviour (feed, ack, dismiss, remind rule) | **`components/useAnnouncementBanner.ts`** — the shared file; editing it hits both shells, the badge hook AND the desktop Announcements page (it reads `addressedIds` / `ackedIds` from the same hook) | — |
| Category colours / CTA wording / which categories block | **`components/announcementCategory.ts`** — the one table; the modal, the inbox, Manage, the bell and the dashboard read it. The backend twin of the blocking rule is `categoryRequiresAck` in `routes/announcements.ts` | `MobileAnnouncements.tsx` / `MobileAnnouncementPopup.tsx` still carry their own `CAT_COLOR` hex map (phone shell CSS, not Tailwind) — keep the four labels in step |
| Pop-up markup / CTA wording | `components/AnnouncementBanner.tsx` | `mobile/MobileAnnouncementPopup.tsx` |
| Composer (audience picker, media layout, company target, **expiry**, **schedule**, **require ack**) | `pages/announcements/ComposerModal.tsx` + `AudiencePicker.tsx` | `mobile/MobileAnnouncements.tsx` `Compose` (still positions + plain expiry; requireAck / scheduledAt default server-side) |
| Live / Hidden / Expired badge | **`lib/announcementStatus.ts`** — the shared rule; both surfaces import it, neither re-derives it | — |
| Publisher actions (hide/show, delete, remind, escalate) | `pages/announcements/ManageView.tsx` drawer (+ the inbox's read-receipts card for remind / hide); the "reset all receipts" (`remind { scope: "all" }`) affordance is desktop-retired with the old row — the phone keeps it | `mobile/MobileAnnouncements.tsx` `Detail` + `Receipts` |
| Media rendering (mig 0140 layout hint) | `components/AnnouncementMedia.tsx` | `mobile/MobileAnnouncementMedia.tsx` |
| Rich body — editing | **`components/AnnouncementRichEditor.tsx`** — one editor, both composers mount it | (same file) |
| Rich body — rendering | **`components/AnnouncementRichBody.tsx`** — the only place `body_html` reaches `innerHTML`; list row + `AnnouncementBanner.tsx` use it | `MobileAnnouncements.tsx` `Detail` + `MobileAnnouncementPopup.tsx` use it; `mobileI18n.ts` `localizeAnnouncement()` picks the translated `bodyHtml` |
| Rich body — grammar | **`lib/announcementRichText.ts`** — byte-identical twin of `backend/src/lib/announcementRichText.ts`; the two test files pin the same fixtures | — |
| Nav visibility | `components/Sidebar.tsx:666-672` | `mobile/MobileApp.tsx:360` (test-pinned) |
| Read gate | `frontend/src/App.tsx:481` | — must agree with `backend/src/routes/announcements.ts:530`; the #957 bug was these two disagreeing |
| Badge | — (none today) | `mobile/MobileApp.tsx:440`+`:805`, `mobile/MobileProfile.tsx:198`+`:345` |

---

## 6. Performance summary

In place:
- **Per-user, per-scope KV snapshot** of `/banner` in `SESSION_CACHE`, key
  `banner:v{version}:u{userId}:s{scope}` where `scope` is `human | system`
  (`BannerScope`), TTL **300s**
  (`backend/src/services/configCache.ts`, `CONFIG_CACHE_TTL_SECONDS.banner`),
  applied in the `/banner` handler. Both slices take the cached path; the key
  carries the scope so the human and system payloads never answer each other.
  Response carries `x-config-cache: hit|miss|bypass` (`bypass` only when the KV
  version is unusable — unbound / erroring).
- **TTL MUST exceed the poll.** The frontend polls at 60s
  (`useAnnouncementBanner.ts` `POLL_MS`); a TTL == poll expires the entry exactly
  as the next poll arrives, so every poll misses and rebuilds the whole table
  (measured ~900ms/60s live 2026-08-18 even on the "cached" human slice). 300s =
  5 polls leaves each poll landing inside a valid entry. Pinned by
  `configCache.test.ts` ("banner TTL stays comfortably above the 60s poll").
- **A MISS is one round-trip, not two.** The announcements read and the acks
  read run in a `Promise.all` (independent reads of the same user), so a rebuild
  no longer pays ~2 sequential ~450ms awaits.
- **Family-version invalidation** on every broadcast-shaped write — create,
  patch, remind, delete; per-user busts (BOTH scopes) on ack and on a private
  notice (`personalNotice.ts`).
- **Targeting edits bust the banner** so the 300s TTL never serves a stale
  audience: `bustBannerForUser` (both scopes) is wired into the user PATCH
  (`bannerTargetingChanged` = department_id / position_id / role_id / status /
  department_ids / company_ids), PUT `/:id/companies`, and DELETE `/:id`; a
  department DELETE bumps the banner family version (bulk multi-user un-assign).
  The session bust alone did NOT cover this — it fires only on disable / role
  change, while a dept-only / position-only / company-only edit changes
  targeting without touching the session.
- **One query per scope** app-wide via `announcementFeedKey` — the phone's
  pop-up, list, bell and badge share four cache entries between them.
- **Windowed desktop list** past 40 rows (`Announcements.tsx:355-357`,
  rAF-throttled scroll `:383-419`). Known limitation stated at `:349-353`: row
  heights vary, so the scrollbar thumb drifts on tall rows and self-corrects.
- **Lazy media** so a text-only notice pulls no gallery bundle
  (`AnnouncementBanner.tsx:21-26`); the mobile pop-up chunk stays off the wire
  entirely while the unread count is 0 (`MobileApp.tsx:600`).
- Lookup queries on the desktop page are `enabled: canWrite`
  (`Announcements.tsx:236-249`) — an ordinary reader lacks `users.read`, so this
  avoids three guaranteed 403s (each retried) per page load.
- Upload caps: 25 MB per attachment (`:1253`), 1 MB per thumbnail (`:1287-1289`).

Watch as data grows:
- **Both slices are cached now** (2026-08-18, branch `perf/banner-scope-cache`):
  the system bell slice used to bypass the KV snapshot and rebuild the whole
  feed on every ~60s desktop poll (~874-1393ms live, 2026-08-18). The cache key
  is now dimensioned by scope (`…:s{scope}`), so the bell rides the same
  per-user snapshot the human slice does; the per-user bust clears both scopes.
  With the 300s TTL, any poll may serve up to TTL-stale (300s) — bounded for
  targeting by the bust wiring above, and the same trade the human slice makes.
- **No `LIMIT` on any read.** `GET /` and `/banner` both select the whole table
  and filter in JS. `Announcements.tsx:222-224` already acknowledges this
  ("Capping it server-side is a separate follow-up"). `GET /:id/acks` and
  `POST /:id/remind` likewise read the full active-user roster (`:713-716`,
  `:1124-1126`).
- The desktop pop-up polls with `refetchIntervalInBackground: true`
  (`useAnnouncementBanner.ts:173`) — deliberate, to preserve the pre-refactor
  `setInterval`, but it means a backgrounded tab keeps requesting every 60s.
- `docs/perf-optimization-plan.md` carries two open items for this module:
  **D5** (`Announcements.tsx:705` rebuilds the user/dept/position Maps inside
  every row) and **M2** (the read-only viewer's org-directory fetch — partly
  addressed by the `enabled: canWrite` above).

No load test, benchmark or measured latency exists for this module anywhere in
the tree; every figure above is structural, read from the code.
