> **ARCHIVED 2026-08-13.** The port shipped. Superseded by `docs/modules/mail-center.md` (**2026-08-04**), which is the module guide for the surface this plan built. Kept for history; do not follow it as a current instruction.

# Mail Center — Hookka → Houzs port plan (file-by-file)

Port Hookka's in-ERP shared inbox (Cloudflare Email Routing / IMAP inbound + outbound
send + DB-backed threads/labels/star/trash + per-user mailbox scope) into the Houzs ERP.

This plan was written after reading the **full** Hookka source and verifying the **actual**
Houzs target. It reconciles against what Houzs already has, so we extend rather than
duplicate. Where my older notes assumed Hookka conventions (Brevo, Supabase Storage,
camelCase, org_id), the verified Houzs reality below **overrides** them.

---

## 0. The reconciliation that drives every decision

| Concern | Hookka (source) | Houzs (verified target) | Consequence for the port |
|---|---|---|---|
| DB driver | postgres.js with a **camelCase** result transform | postgres.js, **snake_case results, NO transform** (`backend/src/db/pg.ts` lines 4-10) | **DELETE all the `r.camelCase ?? r.snake_case` dual-reads.** Read plain snake_case. This removes ~60% of the route's defensive noise. |
| Query API | `c.var.DB.prepare().bind().first()/.all()/.run()` (D1-compat over PG) | **identical** — `env.DB.prepare().bind().first()/.all()/.run()` (`backend/src/db/d1-compat.ts`) | Route body ports almost verbatim. `c.var.DB` → `c.env.DB`. |
| `datetime('now')` | n/a (writes ISO via `new Date().toISOString()`) | d1-compat shim translates `datetime('now')` → `to_char(... 'YYYY-MM-DD HH24:MI:SS')` = **TEXT** | Keep timestamp cols **TEXT**; write either via `new Date().toISOString()` or `datetime('now')`. Never `timestamptz` for app-written times (the mig-0008 rule). |
| `ON CONFLICT` | supported (explicit target) | supported (explicit target) — shim note line 17 | `mail_user_scope` upsert ports as-is. |
| Email provider | **Brevo + Resend** (`sendMail` picks Brevo first) | **Resend only**, `sendEmail(env, opts)` (`backend/src/services/email.ts`) | Reply/compose call **Houzs `sendEmail`**, not Hookka `sendMail`. No Brevo. |
| Outbox | `outbox_emails` (+ GitHub Action cron) | **`email_outbox`** already exists (mig 0005) + `drainEmailOutbox` already wired in the Worker `scheduled()` `*/5` handler (`index.ts` line 204) | **Do NOT port `email-outbox.ts` or the GitHub Action.** Mail replies send **synchronously** (as in Hookka) and don't touch the outbox. |
| From-address / company | Hookka literals (`support@hookka.com`, "Hookka") | central **Branding** config: `getBranding(env)` → `{ companyName, email }` (`services/branding.ts`, seeded mig 0038 = "Houzs Century Sdn Bhd" / `hello@houzscentury.com`) | from-default + the inbound mailbox domain read Branding, never a Hookka literal. |
| Attachment storage | Supabase Storage (`putFile`, `signedDownloadUrl`, bucket `hookka-files`) | **R2** binding `POD_BUCKET` (`c.env.POD_BUCKET.put/get/delete`); **no signed-URL helper** | Inbound attachments → `POD_BUCKET.put(key, bytes)`; serve via an **authed streaming route** (`GET …/attachments/:id`) not a signed URL. |
| Tenancy | multi-tenant, `org_id` on every row, `getOrgId(c)` / `DEFAULT_ORG_ID` | **single-tenant — no `org_id` anywhere**, no `getOrgId` | **Drop `org_id` from every table, every WHERE, every INSERT.** |
| `users.id` | TEXT | **integer serial** (`schema.pg.ts`) | `assigned_user_id` / `assigned_to_user_id` / `sent_by_user_id` become **integer** FKs (or store as text consistently — pick integer to match `users.id`). |
| Auth user | `c.get("userRole")` / `c.get("userId")` (string) | `c.get("user")` = `AuthUser{ id:number, email, name, role_name, permissions, … }` + `c.get("userId")` (`middleware/auth.ts`, `services/auth.ts`) | `getMailScope` reads `c.get("user")`; super-admin test = `user.permissions.includes("*")` (the Houzs owner wildcard), not `role === "SUPER_ADMIN"`. |
| Super-admin gate | `requireSuperAdmin(c)` | `requirePermission` / `requireAnyPermission` (`services/permissions.ts`); owner has `"*"` | Admin endpoints gate on a **new `mail_center.manage`** permission (super-admin gets it via `"*"`). |
| Frontend stack | SAP UI5 / Fiori, hash router, `fetch(credentials:"include")` + `csrfHeaders()` | **React + Tailwind + custom components**, React Router v6, `api.get/post/patch/del` (bearer token in localStorage) + `useQuery` | Re-implement the 3 pages against Houzs primitives; **keep the component LOGIC + data shape**, not the imports. |
| Migrations | `migrations-postgres/NNNN_*.sql`, runtime self-apply via `ensureMailSchema` | `backend/src/db/migrations-pg/NNNN_*.sql`, applied by owner SQL paste **before** deploy (migrate-before-deploy). Highest = **0038**; two `0029_*` exist. | **Next free number = `0039`.** Ship a real migration (don't rely on lazy `CREATE TABLE` at runtime — Houzs convention is migrate-first). |

---

## 1. File-by-file actions

### Backend

| Hookka file | Houzs target path | Action |
|---|---|---|
| `src/api/routes/mail-center.ts` | `backend/src/routes/mail-center.ts` | **ADAPT (heavy)** — keep every handler + the ingest/thread/scope logic; (a) strip all `org_id` + `getOrgId`; (b) strip all `r.camelCase ?? r.snake_case` dual-reads → plain snake; (c) `c.var.DB` → `c.env.DB`; (d) `requireSuperAdmin` → `requirePermission("mail_center.manage")`; (e) reply/compose call Houzs `sendEmail` not `sendMail`; (f) attachments → R2 (`POD_BUCKET`) + authed stream route, not Supabase Storage signed URLs; (g) `getMailScope` reads `c.get("user")`, admin = `user.permissions.includes("*") \|\| can("mail_center.manage")`; (h) from-default + inbound domain read Branding. Export `ingestInboundEmail()` for the pre-auth route. |
| `src/api/lib/email.ts` | `backend/src/services/email.ts` (existing) | **SKIP / REUSE** — Houzs already has Resend send + outbox + templates. Mail Center calls the existing `sendEmail(env, {to,subject,html,text?,purpose:"generic",replyTo?})`. Do **not** port Hookka's Brevo path. |
| `src/api/lib/email-outbox.ts` | — | **SKIP** — Houzs `email_outbox` (mig 0005) + `drainEmailOutbox` cron already cover this. Mail replies send synchronously (Hookka does too); no outbox dependency. |
| `src/api/lib/mail-attachments.ts` | `backend/src/lib/mail-attachments.ts` | **COPY-AS-IS** — pure functions (count/extension/5 MB cap), zero deps. Used by reply + compose to validate outbound attachments. Mirror the same numbers on the frontend compose. |
| (Hookka uses `lib/supabase-storage.ts` `putFile`/`signedDownloadUrl`) | `c.env.POD_BUCKET` R2 binding | **NET-NEW glue** — replace storage calls: inbound store = `POD_BUCKET.put('mail/{msgId}/{n}-{file}', bytes, {httpMetadata:{contentType}})`; download = new authed route `GET /api/mail-center/attachments/:id` that looks up `email_attachments.storage_path`, scopes by `getMailScope`, and streams `POD_BUCKET.get(key).body`. No signed URL. |
| inbound entrypoint (Hookka wires `/api/mail-center/inbound` pre-auth in `worker.ts`) | `backend/src/routes/mail-inbound.ts` + mount in `index.ts` **before** `app.use("/api/*", auth)` | **NET-NEW (small)** — a pre-auth Hono route `POST /api/mail-center/inbound`: constant-time-compare `x-mail-secret` header vs `env.MAIL_INBOUND_SECRET` (≥16 chars, else 503), parse `InboundEmailPayload`, call `ingestInboundEmail(c.env.DB, payload, c.env)`. Same secret-guard pattern as Hookka. |

### Migrations (next free number = **0039**)

| Hookka file | Houzs target path | Action |
|---|---|---|
| `migrations-postgres/0081_email_outbox.sql` [renumbered] | — | **SKIP** — Houzs `email_outbox` already exists (mig 0005). |
| `migrations-postgres/0161_outbox_attachments.sql` [gone] | — | **SKIP** — Houzs outbox doesn't carry attachments and mail replies bypass the outbox; not needed. |
| `migrations-postgres/0171_email_labels.sql` [gone] | folded into the new `0039` | **ADAPT** — drop `org_id`; `email_labels(id text pk, name text not null, color text, created_at text, created_by integer)` + `ux_email_labels_name` unique. |
| all the lazy `CREATE TABLE` DDL inside Hookka `ensureMailSchema()` | **`backend/src/db/migrations-pg/0039_mail_center.sql`** (NET-NEW, one migration) | **ADAPT → real migration** — create the 8 tables below as Houzs convention (no `org_id`, TEXT timestamps, `users.id` integer FKs). Houzs migrates-before-deploy, so this is a real file, not runtime self-apply. |

`0039_mail_center.sql` tables (org_id removed, ids reconciled):

```
email_addresses(
  id text pk, address text not null, label text,
  assigned_user_id integer, assigned_user_name text,
  assigned_dept text, assigned_position text,
  active integer not null default 1, created_at text, created_by integer)
  + unique(lower(address))
email_address_access(            -- shared-mailbox grant matrix
  id text pk, address_id text not null, user_id integer not null,
  created_at text, created_by integer) + unique(address_id,user_id) + index(user_id)
mail_user_scope(                 -- per-user visibility: personal|department|company
  user_id integer pk, level text not null default 'personal', created_at text)
email_threads(
  id text pk, mailbox_address text, subject text, counterparty_email text,
  counterparty_name text, status text not null default 'open',
  assigned_to_user_id integer, assigned_to_name text,
  last_message_at text, last_direction text, last_snippet text,
  message_count integer not null default 0, unread integer not null default 1,
  starred integer not null default 0, labels text, trashed_at text, created_at text)
  + index(mailbox_address, last_message_at)
email_messages(
  id text pk, thread_id text not null, direction text not null,
  message_id text, in_reply_to text, reference_ids text,
  from_address text, from_name text, to_addresses text, cc_addresses text,
  subject text, text_body text, html_body text,
  sent_at text, received_at text,
  sent_by_user_id integer, sent_by_name text, provider_message_id text, created_at text)
  + index(thread_id, created_at) + index(message_id)
email_attachments(
  id text pk, message_id text not null, filename text, content_type text,
  size_bytes integer, storage_path text, content_id text, created_at text)
  + index(message_id)
email_labels(
  id text pk, name text not null, color text, created_at text, created_by integer)
  + unique(lower(name))
```

Keep `CREATE TABLE IF NOT EXISTS` / `CREATE … IF NOT EXISTS` so the migration is idempotent
(pg-migrate requirement) and a re-run is a no-op.

### Frontend

| Hookka file | Houzs target path | Action |
|---|---|---|
| `src/pages/mail-center/index.tsx` (inbox, 99 KB) | `frontend/src/pages/MailCenter/Inbox.tsx` | **ADAPT (re-implement)** — keep the logic (folders: Inbox/Sent/Drafts/Starred/Trash via `status`/`starred`/`trashed`; search; category tabs; label sidebar; bulk action bar). Swap UI5 → Houzs `PageHeader`/`DataTable`/`TabStrip`, `fetch+csrf` → `api.get`/`useQuery`, hash router → React-Router `useNavigate`, URL state → `useSearchParams`/`useStickyFilters`. |
| `src/pages/mail-center/detail.tsx` (reading pane + reply, 53 KB) | `frontend/src/pages/MailCenter/Thread.tsx` | **ADAPT (re-implement)** — render messages + attachment chips (point chips at the authed `…/attachments/:id` route), reply box with From-picker + attachment input, assign/resolve/star/label/trash actions via `api.patch`. |
| `src/pages/mail-center/compose.tsx` (new-email dialog, 24 KB) | `frontend/src/pages/MailCenter/Compose.tsx` | **ADAPT (re-implement)** — From-picker (`pickDefaultFromAddress`), to/subject/body, attachment input mirroring `mail-attachments.ts` caps, `api.post("/api/mail-center/compose", …)`, `useToast` on result. |
| `src/pages/mail-center/mail-actions.ts` | `frontend/src/pages/MailCenter/mail-actions.ts` | **ADAPT (light)** — same functions (`patchThreadStarred/Labels/Unread/Trashed/Status/Assignment`, bulk variants, label CRUD, `createDeptMailbox`); replace `fetch(credentials,csrf)`+`invalidateCache*` with `api.patch/post/del` + the Houzs cache/`useQuery` invalidation. |
| `src/pages/mail-center/mail-from-default.ts` | `frontend/src/pages/MailCenter/mail-from-default.ts` | **COPY-AS-IS** — pure helper `pickDefaultFromAddress(addresses, user)`; `user` = `{ id, email }` from `useAuth()`. (`user.id` is a number — compare as string or align the field type.) |
| `src/pages/mail-center/mail-labels.ts` | `frontend/src/pages/MailCenter/mail-labels.ts` | **COPY-AS-IS** — palette + `labelColorMap`/`colorForLabel`/`chipStyle`. Pure. |
| `src/pages/mail-center/mail-prefs.ts` | `frontend/src/pages/MailCenter/mail-prefs.ts` | **COPY-AS-IS** — localStorage view prefs + `classifyCategory` heuristic. Pure, framework-free. (Rename the `hookka-mail-prefs:v1` key → `houzs-mail-prefs:v1`.) |
| `src/pages/mail-center/mail-local.ts` | `frontend/src/pages/MailCenter/mail-local.ts` | **COPY-AS-IS** — localStorage compose drafts. (Rename key `hookka-mail-local:v1` → `houzs-mail-local:v1`.) |
| route + nav registration | `frontend/src/App.tsx` + `frontend/src/components/Sidebar.tsx` | **NET-NEW** — see §4. |

### Inbound worker + jobs

| Hookka file | Houzs target path | Action |
|---|---|---|
| `mail-inbound-worker/src/index.ts` | `mail-inbound-worker/src/index.ts` (new sibling dir at repo root) | **ADAPT (light)** — CF Email Worker; only env values change: `ERP_INBOUND_URL = https://erp.houzscentury.com/api/mail-center/inbound`, `account_id` = the Houzs CF account, comments hookka→houzs. Payload contract is **identical** to the new Houzs inbound route. |
| `mail-inbound-worker/wrangler.toml` | `mail-inbound-worker/wrangler.toml` | **ADAPT** — `name="houzs-mail-inbound"`, Houzs `account_id`, `ERP_INBOUND_URL` var. |
| `mail-inbound-worker/README.md` | `mail-inbound-worker/README.md` | **ADAPT** — houzscentury.com zone, Houzs CF account, MX-cutover wording. |
| `mail-sync/sync.mjs` | `mail-sync/sync.mjs` | **ADAPT** — Hostinger IMAP → ERP bridge **IF** the houzscentury.com mailboxes live on Hostinger/IMAP (owner to confirm). Change default `ERP_INBOUND_URL`, `MAILBOXES`, `HOSTINGER_PW_*` localparts. Same dedup-by-Message-ID guarantee. |
| `.github/workflows/mail-sync.yml` | `.github/workflows/mail-sync.yml` | **ADAPT** — only if the IMAP bridge is used; swap secrets/vars names. |
| `.github/workflows/process-email-outbox.yml` | — | **SKIP** — Houzs drains `email_outbox` inside the Worker `scheduled()` `*/5` handler; no Action needed. |

Pick **one** inbound path (CF Email Worker **or** the IMAP `mail-sync` cron), not both — both
feed the same idempotent ingest, so it's safe to start with whichever matches where the
houzscentury.com mailboxes actually live (see §5 owner-action).

---

## 2. Backend — routes, libs, auth/scope

**Mount points** in `backend/src/index.ts`:

- **Pre-auth** (BEFORE `app.use("/api/*", auth)`, alongside `/api/auth`, `/api/track`, `/api/portal`):
  `app.route("/api/mail-center/inbound", mailInbound)` — the secret-guarded machine-to-machine
  ingest. (Mount the inbound route at the **exact** sub-path so the authed router below doesn't
  shadow it; or expose it as `/api/mail-inbound` and have the worker POST there.)
- **After auth**: `app.route("/api/mail-center", mailCenter)` — every read/reply/compose/label/
  address/access/scope endpoint, all per-user-scoped.

**Endpoints ported (all under `/api/mail-center`)** — unchanged surface from Hookka:
`GET /threads`, `GET /threads/:id`, `POST /threads/:id/reply`, `PATCH /threads/:id`,
`POST /compose`, `GET /addresses`, `POST /addresses`, `PATCH /addresses/:id`,
`GET /access` `POST /access` `DELETE /access`, `GET /scope-levels` `PUT /scope-level`,
`GET /labels` `POST /labels` `PATCH /labels/:id` `DELETE /labels/:id`, `POST /test-inject`
(admin sample email, no infra — for verifying inbox+reply BEFORE the MX cutover),
**plus NET-NEW** `GET /attachments/:id` (authed R2 stream, replaces signed URLs).

**Libs**: add `backend/src/lib/mail-attachments.ts` (copy). **Reuse** `services/email.ts`
(`sendEmail`) and `services/branding.ts` (`getBranding`). **Do not** add an email lib or outbox.

**Auth / scope** (`getMailScope`, ported):
- super-admin = `user.permissions.includes("*")` OR `can("mail_center.manage")` → sees all.
- everyone else gets a per-user scope (`personal` own+granted / `department` +dept mailboxes /
  `company` all-active) from `mail_user_scope` + `email_addresses` + `email_address_access`.
- Reads/reply/compose/star/label/trash are gated by **scope ownership** (a non-owner gets 404),
  NOT a permission key — this is the whole point of the per-user mailbox model and sidesteps the
  "unseeded permission 403s the owner" class. Only the **admin** endpoints (create/patch address,
  access matrix, scope-level) gate on `mail_center.manage`.
- `c.get("userId")` is the integer id; `c.get("user")` the full `AuthUser`. Drop Hookka's
  `(c as …).get("userRole")` string reads.

**Permissions** (`backend/src/services/permissions.ts`): add **two** flat keys —
`mail_center.read` (nav/page gate; grant broadly) and `mail_center.manage` (alias/access/scope
admin; owner gets it via `"*"`). Seed onto the appropriate roles in `0039` (or a sibling
`0040_seed_mail_permissions.sql` [gone], per the repo rule "keep schema + data in separate migrations
when both are large").

---

## 3. Migrations — exactly what Houzs LACKS

Houzs already has: `email_outbox` (0005), `email_log`, the Resend sender, the `*/5` drain cron,
Branding (0038), `app_settings`, `sessions`, `users`. So the **only** new migration is:

- **`0039_mail_center.sql`** — the 8 tables in §1 (addresses, address_access, user_scope, threads,
  messages, attachments, labels). No outbox, no labels-as-separate-file, no org_id.
- **Email Alias column** (see §6): `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_alias text;`
  — fold into `0039` or a small `0040_users_email_alias.sql` [gone].
- **Permission seed**: `mail_center.read` / `mail_center.manage` into roles (`0040`/`0041`).

**Next free migration number is `0039`** (highest present = `0038`; note the two existing
`0029_*` files — that number is already taken twice, start at 0039). Apply via owner SQL-Editor
paste **before** deploying the route code (migrate-before-deploy; the lazy self-apply Hookka relied
on is NOT the Houzs convention).

Timestamp columns: **TEXT** (write `new Date().toISOString()` or the shim's `datetime('now')`),
never `timestamptz` — the mig-0008 rule.

---

## 4. Frontend — pages, hooks, route + nav

**Pages** under `frontend/src/pages/MailCenter/`: `Inbox.tsx`, `Thread.tsx`, `Compose.tsx`
(+ the 5 copied helper modules). Export named components.

**Routes** (`frontend/src/App.tsx`, React Router v6, lazy + `PageGuard`):
```tsx
const MailInbox  = lazy(() => import("./pages/MailCenter/Inbox").then(m => ({ default: m.MailInbox })));
const MailThread = lazy(() => import("./pages/MailCenter/Thread").then(m => ({ default: m.MailThread })));
<Route path="/mail-center"     element={<PageGuard page="mail_center"><MailInbox /></PageGuard>} />
<Route path="/mail-center/:id" element={<PageGuard page="mail_center"><MailThread /></PageGuard>} />
```
(Literal route before the `:id` route. Compose is a dialog opened from Inbox, not its own route,
matching Hookka — drafts/`?compose=new` can be a `useSearchParams` flag.)

**Nav** (`frontend/src/components/Sidebar.tsx`, `NAV_TABS`):
```tsx
{ label: "Mail Center", icon: Mail, groupId: "mail-center",
  anyPerm: ["mail_center.read"], pageAccess: "mail_center",
  children: [
    { to: "/mail-center",            label: "Inbox",  icon: Inbox,   pageAccess: "mail_center" },
    { to: "/mail-center?folder=sent",label: "Sent",   icon: Send,    pageAccess: "mail_center" },
  ] }
```
Nav is permission/page-access gated by `filterTab` — gate on `mail_center.read` (and/or a
`mail_center` page-access key if you wire it into the Positions page-access matrix).

**Data layer** (replace Hookka's `fetch(credentials:"include")+csrfHeaders()`):
- reads via `useQuery(() => api.get("/api/mail-center/threads?…"))`, `api.get("/api/mail-center/threads/"+id)`, `api.get("/api/mail-center/addresses")`, `api.get("/api/mail-center/labels")`.
- mutations via `api.post/patch/del`; invalidate with the Houzs `useQuery` cache (the `api.get`
  cached-fetch layer in `frontend/src/api/client.ts`), mirroring Hookka's `invalidateCachePrefix`.
- current user from `useAuth()` (`{ user:{ id,email,name,role_name }, can, pageAccess }`).
- dialogs/toasts from `useDialog()` / `useToast()` (no `window.confirm/alert/prompt` — repo rule).
- URL state via `useSearchParams` / `useStickyFilters("mail-center", [...])` (folder/status/q/label).

Attachment chips point at `api.fetchBlobUrl("/api/mail-center/attachments/"+id)` (the client's
authed blob helper) instead of a signed URL.

---

## 5. Inbound worker — bindings, secrets, MX (deploy-gated)

New sibling dir `mail-inbound-worker/` (NOT part of the Pages app). Deploys as its own CF Worker.

- **Bindings/vars**: `ERP_INBOUND_URL = https://erp.houzscentury.com/api/mail-center/inbound`
  (`[vars]`); `account_id` = the Houzs CF account (`816e4573…` per memory — verify with
  `wrangler whoami`). Dep: `postal-mime`.
- **Secrets** (`wrangler secret put …`): `MAIL_INBOUND_SECRET` (≥16 chars; **must equal** the
  same-named secret set on the Houzs Worker/Pages env), optional `FORWARD_TO` (a verified
  safety-net mailbox).
- **ERP side**: set `MAIL_INBOUND_SECRET` on the Houzs backend Worker; the pre-auth `/inbound`
  route returns 503 until it's set and ≥16 chars (Hookka semantics).
- **R2**: the *ingest* (attachment bytes → `POD_BUCKET`) happens in the **ERP** Worker, so the
  inbound Worker needs **no** R2/Supabase binding — it just base64s attachments into the JSON POST
  (≤8 MB/file, ≤15 MB/msg caps already in the worker).

**MX cutover — OWNER ACTION, deploy-gated** (do this LAST):
enabling Cloudflare Email Routing on the houzscentury.com zone **repoints the domain MX to
Cloudflare** (domain-wide). Recommend **per-address rules** (route only `support@`/`sales@`/… to
`houzs-mail-inbound`; keep human mailboxes forwarding to their current destination) rather than
catch-all. **Verify the whole inbox+reply loop first** via `POST /api/mail-center/test-inject`
(admin, zero infra) and a sample POST to `/inbound` with the secret — only flip MX once that's
green. If the mailboxes stay on Hostinger/IMAP, use the `mail-sync` cron path instead and skip MX
entirely.

---

## 6. Email Alias per member

**Migration**: `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_alias text;` (in `0039`/`0040`).
This is the member's assigned outward address (e.g. `lim@houzscentury.com`). It complements the
`email_addresses` table: `email_addresses.assigned_user_id` is the canonical mailbox↔person link;
`users.email_alias` is the convenience field surfaced in User Management. (Either can drive the
default-From; the alias column is the simpler owner-facing knob, the address table is what the
backend scopes on.)

**User Management UI** (`frontend/src/pages/Team.tsx`, Members tab):
- add an **"Email Alias"** column to `memberColumns` (render `u.email_alias || "—"`), following the
  existing column/render pattern, and an editable field in the member edit `Panel` that
  `api.patch("/api/users/"+id, { email_alias })`. Extend `TeamMember` in `types.ts` with
  `email_alias?: string | null`, and the `PATCH /api/users/:id` handler (`backend/src/routes/users.ts`)
  to accept it.
- Optionally, "claim/assign alias" can also POST `/api/mail-center/addresses` (creates the
  `email_addresses` row with `assigned_user_id`) — that's what makes the mailbox actually scoped &
  reply-from-able. Email **Access** matrix (shared mailboxes) + visibility **level** selector are the
  admin grids from the ported `/access` + `/scope-levels` endpoints; wire them into Team when ready
  (owner deferred the Email-Access permission — "之后再整理").

**`mail-from-default.ts`** consumes this: `pickDefaultFromAddress(addresses, user)` matches by
`assigned_user_id === user.id`, then `address === user.email`, then local-part. The alias just makes
the match deterministic. The compose/reply From-picker defaults to that and stays switchable.

---

## 7. From-address / company name → Branding (not a Hookka literal)

Every place Hookka hardcodes identity must read Houzs Branding:
- **Outbound send**: replies/compose call `sendEmail(env, …)`, whose `deliverViaResend` already
  derives the From from `getBranding(env)` (`companyName` + `email` domain) with `EMAIL_FROM`
  override. Nothing to hardcode — drop Hookka's `DEFAULT_REPLY_FROM = "Hookka <support@hookka.com>"`.
  If a per-mailbox display name is wanted, keep the `email_addresses.label` "label <addr>" form
  (already in the reply/compose handlers) but the **domain/company fallback is Branding**.
- **Inbound mailbox domain**: where Hookka tests `/@hookka\.com$/` and `address.endsWith("@hookka.com")`,
  read the domain from `getBranding(env).email` (split on `@`) → `@houzscentury.com`. Don't hardcode.
- **`test-inject`** default mailbox: derive from Branding domain, not `support@hookka.com`.

Branding lives at `backend/src/services/branding.ts` (`getBranding`/`setBranding`, single
`app_settings.branding` key, seeded mig 0038). The frontend Branding/Settings editor is the owner's
one place to change company name + email.

---

## 8. Risks / unknowns / owner-actions

- **MX cutover (owner)** — domain-wide; use per-address rules; verify via `test-inject` + sample
  POST before flipping. Deploy-gated. If mailboxes stay on Hostinger, use `mail-sync` IMAP instead.
- **Where do the houzscentury.com mailboxes live? (owner)** — decides CF-Email-Worker vs IMAP
  `mail-sync`. If Hostinger/IMAP: set `HOSTINGER_PW_*` + `MAIL_INBOUND_SECRET` GitHub secrets; if CF
  Email Routing: deploy `houzs-mail-inbound` + enable routing. Pick one path.
- **`MAIL_INBOUND_SECRET` (owner)** — generate (`openssl rand -hex 24`), set on BOTH the ERP Worker
  and the inbound side; `/inbound` 503s until present + ≥16 chars.
- **Mailbox password (owner)** — IMAP path needs per-mailbox passwords; CF path doesn't. Set with the
  owner manually (the existing note: "set the mailbox password together with the owner").
- **Send path = Resend, not Brevo** — Houzs has no Brevo; ensure `RESEND_API_KEY` + a verified
  `houzscentury.com` sender at Resend (or `EMAIL_FROM`) so replies actually send. (Hookka could send
  via Brevo before MX; Houzs sends via Resend — confirm the Resend domain is verified, else replies
  401/`sender not authenticated`.)
- **`users.id` is integer** — all `*_user_id` columns are integer FKs; the frontend `user.id` is a
  number — keep the `mail-from-default` comparison type-consistent (string-coerce or align).
- **Drafts are localStorage-only** (no draft table) — unchanged from Hookka; flag to owner (drafts
  don't sync across devices/users). Promoting needs an `email_drafts` table + CRUD.
- **RFC threading on send** — outbound replies aren't `In-Reply-To`/`References`-stamped (Hookka
  limitation: `sendEmail` has no custom-headers option). Local threading is correct; cross-client
  threading is a follow-up if/when the sender grows a headers arg.
- **No runtime self-apply** — Houzs migrates-before-deploy; if `0039` isn't applied before the route
  ships, the API 500s on the missing tables. Apply migration FIRST.
- **Deploy churn** — don't burst-deploy; apply mig, then one backend deploy, then the frontend.

## Suggested wave order

1. `0039` migration (+ alias col + perm seed) — apply via SQL Editor.
2. Backend: `mail-attachments.ts` (copy) → `routes/mail-center.ts` (adapt) → `routes/mail-inbound.ts`
   (new) → mount in `index.ts` (pre-auth inbound + post-auth router) → `GET /attachments/:id` R2
   stream → 2 permission keys. Deploy. Smoke `test-inject` + a real reply (Resend).
3. Frontend: 5 copied helpers → `Inbox`/`Thread`/`Compose` (adapt) → route + nav → Team alias column.
   Deploy.
4. Inbound: deploy `houzs-mail-inbound` (or wire `mail-sync`), set secrets, sample-POST test.
5. **Owner**: MX cutover (per-address) — last, only after the loop is verified.
