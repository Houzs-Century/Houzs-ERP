# COE: the write-back service was one deleted file from an open account book

**Date:** 2026-08-11. **Severity:** high — data at risk, no data lost.

## Trigger

The owner asked, plainly: *"为什么我们要建立 Service Key 呢？"*

Answering it honestly meant reading the auth path instead of describing it. The
answer was worse than the question: the service that writes into the licensed
`AED_HOUZS` account book **failed OPEN**, and the key that guarded it was
**downloadable from the public internet** — on the same day the tunnel in front
of it was about to be repointed at that service.

Nothing was exploited. Every finding below was closed the same day.

## Root cause, traced

### 1. The auth check was skipped entirely when no key was configured

```csharp
if (!string.IsNullOrEmpty(ApiKey) && ctx.Request.Headers["X-API-KEY"] != ApiKey)
  { Json(ctx, 401, Err("bad key")); return; }
```

`ApiKey` is read from a file at startup. **No file means `null`, and `null`
short-circuits the whole condition** — every request accepted, including
`/create-so`, `/edit` and `/cancel`, straight into the live book.

The service was reachable only on loopback at the time, which is why this had
never mattered. The tunnel removes that boundary. One deleted file, or one
rebuild on a machine where nobody remembered to place it, and the account book
would have been writable by anyone who found the hostname.

### 2. The key was published on the internet

`https://autocount.houzscentury.com/ac-svc-key.txt` returned **200, 64 bytes**,
anonymously. So did the service binary, the previous binary, and the log.

Cause: the cutover file server publishes **any file under `C:\Temp`**, and the
key file lives there. It was set up to move files without a remote desktop, and
it worked — the service log read through it is how the `FK_SODTL_Location`
defect and the runbook 4.1-4.5 results were found the same day. The tool was
useful and the placement was wrong.

Blast radius was measured, not assumed: `../` traversal returns 404 and an
encoded traversal returns 400, so `C:\InistateConnector\setup.json` — which
holds the SQL credentials — was **not** reachable this way.

### 3. The log carried customer data into that directory

The request body was logged, truncated to 400 characters. A sales-order payload
carries the customer's name, address and phone. The log was among the files
being served.

### 4. `/health` answered before the key check

Anonymous callers could read which account book the service was connected to.

### 5. The port file path contained a control character

`C:\Temp` + `0x07` + `c-svc-port.txt` — an `\a` interpreted where it should not
have been, in a C# **verbatim** string. The service looked for a filename
containing a BEL and never found one, so "the port is a file, not a constant"
had never worked. Benign (it fell back to the intended 8900) and invisible: both
the deploy doc and the migration record had copied the corrupted path, so
anyone moving the port would have created the right file and watched it be
ignored.

## Fixes shipped

| PR | Effect |
|---|---|
| `#2025` | **Fails closed**: no key configured -> 503 on every request. `/health` moved behind the key. Key compared length-independently. 2 MB body cap. The log records the route and document number, never the payload. The BEL path corrected |
| `#2030` | `AC_SYNC_URL` set only after the tunnel was repointed **off** the file server — `GET /ac-svc-key.txt` now returns 405 from the service, so the published key is gone with the file server |

## What the audit RULED OUT

- **The SQL credentials were not exposed.** Traversal out of `C:\Temp` was tested
  and refused (404 / 400). `setup.json` sits in a different directory.
- **Nothing was written to the book by anyone else.** The service log accounts
  for every request it has ever served; the only writes are ours.
- **"Only the office host can compile this file", the reason recorded for an
  earlier uncompilable-handler defect reaching `main`, is FALSE.** The licensed
  assemblies ship with the ordinary AutoCount 2.2 desktop install, so
  `build-local.ps1` compiles it on an ordinary workstation. That check then
  immediately caught a real mistake — `LocationMaintenance` lives in
  `AutoCount.StockMaint.dll`, not `AutoCount.Stock.dll`.

## Deferred, with the decision owner

- **The file server stays.** Owner, 2026-08-11: *"这样子被公开也没关系的"* and
  *"全部都先公开都没关系"*. The exposure that mattered — the key — closed on its
  own when the hostname was repointed. Decision owner: the owner.
- **The key has not been rotated.** It was public for an unknown period. Owner:
  *"不需要换公网啊 就先这样啊"*. Decision owner: the owner.
- **Cloudflare Access in front of the hostname** would replace a shared secret in
  a file with a managed service token. Not built.

## Lessons

**Fail-open auth reads as auth.** The line looked like a check and behaved like
one in every environment where it had ever run. It only became a hole when the
network boundary it silently depended on was removed — and removing that
boundary was a planned, celebrated step. **Ask what a guard does when its input
is missing, not what it does when its input is present.**

**A convenience server inherits everything you put in its directory.** Nobody
decided to publish the key; the key was placed where a publisher was already
pointed. The question to ask of any served directory is not "what did I put
there" but "what else is there".

**Read the failing response before writing down a cause.** Recorded again
because it recurred: the earlier photo failure was written down twice with two
wrong causes before anyone read the actual body.

**Check the premise that excuses the missing test.** "This file cannot be built
in CI" was accepted for months and used to explain a defect. It was never
tested. When a reason for not verifying something sounds structural, verify the
reason.
