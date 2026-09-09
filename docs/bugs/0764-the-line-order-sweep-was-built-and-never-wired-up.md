## The line-order sweep was built and never wired up [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-SO-010741`'s ERP lines carry AutoCount keys `927780..927783`.
The account book's own `SO-010741` holds `751034..751037`. Those `927xxx` keys
appear **nowhere** in the committed cutover snapshot (60,939 SO lines), so only a
live read of the book can say which side is stale — and there was no way to make
one.

**Root cause.** `POST /scm/autocount-outbox/line-order-sweep` answers exactly
that question, over the whole population, read-only on both sides. It was
written after the owner found three such documents by opening them one at a time
and said 「之后有问题吗？我不要每次都来 fix 啊」.

Measured 2026-09-09: **no workflow calls it and no screen calls it.**

```
grep -rln "line-order-sweep" .github/workflows/ backend/scripts/   -> nothing
grep -rn  "line-order-sweep" frontend/src                          -> nothing
```

So it has never run. A tool that measures a population, built because somebody
was tired of finding members of it by hand, and then reachable by nobody.

**Why it could not be a workflow, which is the part that decides the fix.** It
reads the LIVE account book through the host, and the host's credentials are
WORKER secrets. CLAUDE.md forbids putting them in Actions — this repository is
public and the service-role key bypasses RLS on the one database both tenants
share. The Worker already holds them, and the browser already holds a session.
**A button is the only place this can live.**

**Fix.** `LineOrderSweepPanel` on the AutoCount Sync page, beside the host log
and modelled on it.

* **On demand, never on page load.** `enabled` is required, not optional: this is
  a round trip through a Cloudflare tunnel to a desktop PC in the office, and a
  panel that swept whenever the page opened would put that machine on the
  critical path of a page every staff member loads. Heavy reads there also starve
  the write-back — a wide scan makes `SalesOrder.InternalSave` time out, and the
  500 looks exactly like a permissions refusal.
* **A TRUNCATED read says so FIRST, in its own words.** A partial sweep reporting
  "12 need looking at" reads exactly like a complete one that found 12, and the
  difference is whether the rest were checked at all.

**Verified.**

* `acLineOrderSweep.test.ts` — **4 tests**: the all-clear line; the count of
  documents needing attention; a truncated read leads with `PARTIAL` and the
  words "floor, not a total"; and nothing at all before the sweep has run.
* `npm --prefix frontend run typecheck -- --force` clean; lint at ceiling.

**UNTESTED against the live book** — the button has not been pressed against
production, and it cannot be from CI. That is the whole reason it is a button.

**Ref.** feat/the-line-sweep-gets-a-button, 2026-09-09.
