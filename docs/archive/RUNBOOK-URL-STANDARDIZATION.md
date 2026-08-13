> **ARCHIVED 2026-08-13.** The dashboard steps were carried out: `erp.houzscentury.com` is the canonical domain and the `pages.dev` bounce ships in `frontend/src/main.tsx`. Superseded by `docs/CODEBASE-MAP.md` §3. Kept for history; do not follow it as a current instruction.

# Runbook — URL standardization on houzscentury.com

Owner goal: every URL a user sees is on the brand domain **houzscentury.com**.

This runbook covers the **infrastructure / dashboard** actions that the code in
this PR cannot do. The PR already handles the one browser-visible non-brand
host in code: production also answered on the Cloudflare Pages default host
`houzs-erp.pages.dev`, and a client + Pages-Function 302 now bounces it to
`https://erp.houzscentury.com` (path, query and hash preserved). Everything
below is a Cloudflare dashboard change; **do not** run any of it as part of
merging the PR.

Each step is one dashboard action. Do them in order. Steps 3 and 4 are gated —
read the hazard boxes before starting them.

---

## Current topology (verified from the code, 2026-07-19)

| Piece | Where it runs | Host today |
| --- | --- | --- |
| Prod frontend | Cloudflare Pages project `houzs-erp` | `erp.houzscentury.com` (custom domain) **and** `houzs-erp.pages.dev` |
| Prod backend | Worker `autocount-sync-api` | `autocount-sync-api.houzs-erp.workers.dev` |
| How the browser reaches the API | Pages Function `frontend/functions/api/[[path]].ts` proxies same-origin `/api/*` to the Worker | browser only ever talks to `erp.houzscentury.com` |
| Staging frontend | Cloudflare Pages project `houzs-erp-staging` | `houzs-erp-staging.pages.dev` |
| Staging backend | Worker `autocount-sync-api-staging` | `autocount-sync-api-staging.<subdomain>.workers.dev` |
| Email links (prod) | `backend/wrangler.toml` `PUBLIC_APP_URL` | already `https://erp.houzscentury.com` — correct, no change |

### Prerequisite fact that gates Steps 2, 3, 4

The `houzscentury.com` **DNS zone is not hosted in this Cloudflare account**
(documented in `frontend/functions/api/[[path]].ts`: attaching a Worker custom
domain fails with wrangler error `10082`). `erp.houzscentury.com` works today
because a Cloudflare **Pages** custom domain can be verified with an external
CNAME; a Cloudflare **Worker** custom domain cannot — it needs the zone in the
same account. So any step that needs a *new* brand hostname either:

- **(A)** adds it as a **Pages** custom domain (external CNAME is fine — this is
  how Step 2 works), or
- **(B)** requires **onboarding the `houzscentury.com` zone into this Cloudflare
  account first** (this is what gates Steps 3 and 4).

Decide with the owner whether to move the DNS zone into this account. If yes,
that single change unblocks Steps 3 and 4 cleanly. If no, Steps 3 and 4 stay
deferred and the pages.dev redirect already shipped in this PR is the practical
end state.

---

## Step 1 — Redirect the apex `houzscentury.com` to `erp.houzscentury.com`

The apex has no DNS record today, so typing `houzscentury.com` reaches nothing.
Send it to the app.

Do this in the Cloudflare account **that manages the `houzscentury.com` DNS
zone** (may be a different account than the one hosting the Pages/Worker
projects):

1. **DNS record so the rule has something to intercept.**
   Cloudflare Dashboard -> select the `houzscentury.com` zone -> **DNS** ->
   **Records** -> **Add record**: type `A`, name `@`, IPv4 `192.0.2.1`
   (RFC-5737 discard address), **Proxied (orange cloud) ON**. Repeat for name
   `www` if `www.houzscentury.com` should also redirect.
2. **Redirect rule.**
   Same zone -> **Rules** -> **Redirect Rules** -> **Create rule**.
   - Name: `apex-to-erp`
   - When incoming requests match: **Hostname** `equals` `houzscentury.com`
     (add `or` Hostname `equals` `www.houzscentury.com`)
   - Then: **Static redirect** -> URL `https://erp.houzscentury.com` ->
     **Preserve query string** ON -> Status **301** (use **302** for the first
     day if you want an easy rollback, then promote to 301).
   - Under expression, keep "preserve path" by choosing the "Dynamic" option
     `concat("https://erp.houzscentury.com", http.request.uri.path)` if you
     want deep paths carried; the static form above is fine for an apex people
     only ever hit bare.

Verify: `curl -sI https://houzscentury.com/` returns `301` (or `302`) with
`location: https://erp.houzscentury.com/`.

---

## Step 2 — Add `staging.houzscentury.com` as the staging custom domain

Gets staging testers off `houzs-erp-staging.pages.dev` and onto the brand
domain. Uses path **(A)** above (Pages custom domain, external CNAME OK).

1. Cloudflare Dashboard -> **Workers & Pages** -> **`houzs-erp-staging`** (the
   Pages project) -> **Custom domains** tab -> **Set up a custom domain** ->
   enter `staging.houzscentury.com` -> **Continue** -> **Activate domain**.
2. Cloudflare shows a **CNAME target** (e.g. `houzs-erp-staging.pages.dev`).
   Add that CNAME at whoever hosts `houzscentury.com` DNS:
   `staging` CNAME -> `<the target Cloudflare shows>`.
3. Wait for the custom-domain status to read **Active**.

**Follow-up code change (one-line PR, AFTER the domain is Active — not before,
or staging emails point at a host that does not resolve yet):** in
`backend/wrangler.toml` set `[env.staging]` `PUBLIC_APP_URL =
"https://staging.houzscentury.com"` and redeploy the staging Worker. Until then
staging email links keep using `houzs-erp-staging.pages.dev`, which is correct.

Optional, after Step 2 is Active: extend the Step-1-style redirect logic to
also bounce `houzs-erp-staging.pages.dev` -> `staging.houzscentury.com`. Left
out of the code PR deliberately — the canonical-redirect module matches the
**prod** Pages host only, because redirecting staging before its custom domain
exists would strand testers.

---

## Step 3 — Disable the public `workers.dev` endpoint (GATED)

> **HAZARD — this can take production down. Read before touching.**
> The browser never calls `autocount-sync-api.houzs-erp.workers.dev` directly,
> but the **Pages Function proxy** (`frontend/functions/api/[[path]].ts`,
> `DEFAULT_API_ORIGIN`) does — every `/api/*` call is forwarded there.
> Disabling workers.dev kills that proxy target and every request 500s.
> On **2026-07-09** adding `routes` to `wrangler.toml` (which *implicitly*
> disables the workers.dev endpoint) took prod down for exactly this reason.
> A direct GET navigation to the workers.dev host only returns the JSON API
> (a `401`), not the app, so the user-facing exposure of leaving it enabled is
> low — this step is about tidiness, not a visible-domain fix.

Safe order (do **not** skip a) -> c) before d):

- **a) Onboard the zone** — path (B): move the `houzscentury.com` DNS zone into
  this Cloudflare account (Dashboard -> **Add a site**), or confirm it already
  lives here. Worker custom domains fail with `10082` until this is true.
- **b) Attach a Worker custom domain** for the API.
  Dashboard -> **Workers & Pages** -> **`autocount-sync-api`** -> **Settings**
  -> **Domains & Routes** -> **Add** -> **Custom domain** ->
  `api.houzscentury.com` -> **Add domain**. Wait for **Active**.
- **c) Repoint the proxy (code PR):** in `frontend/functions/api/[[path]].ts`
  set `DEFAULT_API_ORIGIN = "https://api.houzscentury.com"`, deploy Pages,
  and verify the app loads and `/api/*` returns data (not 502).
- **d) Disable workers.dev.**
  Dashboard -> **Workers & Pages** -> **`autocount-sync-api`** -> **Settings**
  -> **Domains & Routes** -> the **`workers.dev`** row -> **Disable**.
  Repeat for `autocount-sync-api-staging` once its own custom API domain (if
  any) is in place.

Verify after d): app loads, a document opens, a save succeeds, and
`curl -sI https://autocount-sync-api.houzs-erp.workers.dev/` no longer serves.

If any check fails: re-enable workers.dev (same menu, **Enable**) — it is the
instant rollback.

---

## Step 4 — Reserve `autocount.houzscentury.com` for the AutoCount tunnel (OPTIONAL)

The AutoCount .NET middleware is reached today at `https://it-houzs.dev/`
(`AUTOCOUNT_API_URL` in `backend/wrangler.toml`) — the departed developer's
domain, fronted by an ngrok/tunnel. Reserve a brand subdomain so the
integration stops depending on that domain. Needs path (B) (zone in this
account) for a Cloudflare Tunnel hostname.

1. Cloudflare Dashboard -> **Zero Trust** -> **Networks** -> **Tunnels** ->
   **Create a tunnel** -> **Cloudflared** -> name `autocount` -> install the
   connector on the machine that runs AutoCount.
2. In the tunnel's **Public Hostname** tab -> **Add a public hostname**:
   subdomain `autocount`, domain `houzscentury.com`, service
   `http://localhost:<AutoCount port>`.

**Follow-up code change (one-line PR, after the hostname resolves):** set
`AUTOCOUNT_API_URL = "https://autocount.houzscentury.com/"` in
`backend/wrangler.toml` (prod and staging blocks) and redeploy. Reserved and
optional — no action required now; documented so the subdomain is claimed and
the departed-dev domain can be retired later.

---

## What this PR already did in code (no dashboard action needed)

- `houzs-erp.pages.dev` -> `erp.houzscentury.com` 302 redirect (client guard in
  `frontend/src/main.tsx` + server 302 in `frontend/functions/[[path]].ts`,
  logic in `frontend/src/lib/canonicalHost.ts`). Exact-host match — staging,
  `erp.2990shome.com`, and preview hosts are deliberately left alone.
- ~30 additive route aliases so a reasonable path guess (mostly a missing
  `/scm` prefix) resolves instead of 404-ing (`frontend/src/lib/routeAliases.ts`).
- README example config corrected to the brand `PUBLIC_APP_URL`.

## Left as-is on purpose (not bugs)

- Prod email links already emit `erp.houzscentury.com` via `publicUrl()`
  (`backend/src/services/email.ts`), which also correctly routes 2990-identity
  mail to `erp.2990shome.com`.
- The `*.workers.dev` literals in the frontend are all dev-only fallbacks behind
  `import.meta.env.PROD ? "" : ...` (prod resolves to same-origin). The SCM
  vendored base keeps `|| worker` (not `??`) — an empty-string `VITE_API_URL`
  must fall back to the Worker.
- PWA `manifest.webmanifest` (`start_url`/`scope` = `/`) and `sw.js`
  (`url.origin !== self.location.origin`) are origin-relative and need no change.
- Backend CORS is wildcard (`app.use("*", cors())`) — no origin allow-list to
  update for the domain change.
