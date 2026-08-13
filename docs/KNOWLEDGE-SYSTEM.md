# How this codebase carries its own knowledge

Written 2026-07-21, after the owner asked the right question: *"surely a developer
doesn't grope through the whole system before building something?"*

No, they don't — not in any large ERP shop. What they have instead is a small set
of documents with **defined jobs**, so that arriving at an unfamiliar module costs
minutes instead of hours. This file describes that system: which layers exist, what
belongs in each, and the one rule that decides where a new fact goes.

Read this once. Then you will know where to look, and where to write.

---

## 1. The layers, and the job of each

| Layer | File | Its job | Rots? |
|---|---|---|---|
| Agent entry point | `CLAUDE.md` | Rules, conventions, traps. Auto-loaded into every session. | **Yes — keep it thin** |
| Navigation, judgement | `docs/CODEBASE-MAP.md` | What each area is FOR. Which trees are dead. What must change in pairs. | Yes — hand-written |
| Navigation, facts | `docs/generated/` | Route inventory, migration trees, largest files, desktop/mobile pairing. | **Yes, except `route-capability-matrix`** — only that one is CI-gated, see §6 |
| Per-module guide | `docs/modules/<module>.md` | Everything needed to work in ONE module without reading the others. | Yes — hand-written |
| Bug ledger | `BUG-HISTORY.md` | Symptom → root cause → fix, per bug. Mandatory, owner rule. | No — append-only |
| Incident post-mortem | `docs/*-coe.md` | A serious outage: what broke, why, what changed. | No — append-only |
| Human knowledge base | Obsidian vault (`Houzs ERP/`) | Architecture and business reasoning **for people**. | Outside this repo |

### Current state, honestly

Every layer above is in use. The module-guide layer, which this file once called
the largest remaining gap, has since been filled in across the SCM document flow,
Service Cases, Delivery/TMS, PMS, Announcements and the OCR scan flow.

**Which modules have a guide is not written here — run `ls docs/modules/`.** That
is not laziness, it is rule §2 applied to this file: the list changes whenever
someone writes a guide, and nothing would force this paragraph to keep up. It
did not keep up. Between 2026-07-21 and 2026-08-02 this section claimed a single
guide existed while the directory grew past fifteen, so the one document whose
job is to stop stale hand-written facts was itself the stalest thing in `docs/`.

The remaining gap is therefore not a count but a rule, and it already lives in
`CLAUDE.md`: **if the module you are about to touch has no guide, writing it is
the first task, not an optional one.** Follow the shape of an existing guide.

## 2. The rule that decides where a fact goes

> **A fact belongs in the layer that will be forced to update it when it changes.**

That is the whole doctrine. Everything below follows from it.

- A fact that changes on **every merge** (route counts, file sizes, module lists)
  must be **generated**, never typed. If it is typed, nothing forces the update and
  it will be wrong within weeks — and a confidently wrong doc costs more than a
  missing one, because the next reader trusts it.
- A fact that changes when **someone edits a specific file** belongs in a doc that
  lives beside that file, so the same PR touches both.
- A fact that only changes when a **decision** changes belongs in the map or a
  module guide, where a human will re-read it.
- If a fact is in **none** of those, it belongs nowhere. Delete it.

### What this cost us before it was written down

`CLAUDE.md` is loaded into every session, and it stated as fact that the data store
was "D1 SQLite" and that migrations live in `src/db/migrations/`. Both were wrong
for over a month after the Postgres cutover. The second one is expensive: a
migration written to that tree ships, passes CI, merges — and production never
changes, because `deploy.yml` runs `pg-migrate.mjs` against `migrations-pg/`.

`docs/CODEBASE-MAP.md` was a good map generated 2026-06-18 and never regenerated.
By July it claimed 82 route modules against a real 122, and its endpoint inventory
described modules deleted in the strip-to-core cutover. Worse, **nothing pointed at
it** — `CLAUDE.md` did not mention it once, so sessions never learned it existed and
explored from scratch every time.

Neither failure was carelessness. Both were structural: the facts were hand-typed in
places nothing forced anyone to revisit. Hence the rule above, and hence
`backend/scripts/gen-codebase-map.mjs`.

## 3. Where to write a new thing

| You learned… | Write it… |
|---|---|
| A bug's root cause | `BUG-HISTORY.md`, same PR as the fix. Mandatory. |
| Why an approach was rejected | The module guide, or the map's Traps section |
| A new module's shape | `docs/modules/<module>.md` |
| A rule every session must obey | `CLAUDE.md` — but only if it is short and stable |
| A number, count, or inventory | Nowhere. Teach the generator to emit it. |
| Business reasoning for people | Obsidian |

## 4. Why agent-facing knowledge lives in the repo, not Obsidian

Obsidian is the better tool for a person thinking. It is the wrong home for
knowledge an agent must act on, for three concrete reasons:

1. **It is outside the repo**, so a PR that changes the code is never asked to
   change it. Nothing forces the update — see the rule in §2.
2. **It cannot be generated or checked.** Counts and inventories there are typed by
   hand and go stale silently.
3. **It is not always reachable.** The Obsidian MCP is registered at user scope;
   sessions without it cannot read the vault at all. Repo docs always work.

So: **Obsidian for humans, `docs/` for agents.** They are counterparts, not rivals.
When something is true for both audiences, the repo version is the source of truth
and the vault paraphrases it.

## 5. The names for this, if you want to read more

None of this is invented here. The industry names, so you can search them:

- **Docs-as-code** — documentation lives in the repo, is reviewed in PRs, and is
  generated wherever it can be. The umbrella practice this file describes.
- **Module guide / service catalog** — one document per module so a developer can
  work in it without reading the rest. `docs/modules/` is this.
- **ADR (Architecture Decision Record)** — a short record of a decision and its
  reasoning, written when the decision is made. The map's Traps section and the
  module guides carry ours informally.
- **COE (Correction of Error)** — AWS's term for a blameless post-mortem.
  `docs/system-foundation-coe.md` already follows it; `BUG-HISTORY.md` is the
  lightweight per-bug version.
- **Internal Developer Portal** — the productised version of all of the above.
  Spotify's Backstage is the reference implementation.
- **Context engineering** — the AI-agent-specific discipline: deciding what an
  agent sees before it starts work. `CLAUDE.md` plus the map is our version of it.
- **Domain-Driven Design / bounded contexts** — the architectural half. The reason
  a developer only needs their own module is that the modules have real boundaries.
  Where ours are weak, a 12,000-line file is usually the symptom.

## 6. Keeping this true

- **`audit:*` CHECKS. `gen-*` WRITES.** Corrected 2026-08-13: this line said
  `audit:map` "regenerates `docs/generated/`", and it does neither of those
  things — `backend/package.json:19` is
  `node scripts/gen-codebase-map.mjs --check`, which writes nothing and covers
  one file. `docs/CODEBASE-MAP.md:21-22` had it right, so the two documents
  contradicted each other about the same command.

  Each artifact has a generate/check pair:

  ```bash
  node backend/scripts/gen-codebase-map.mjs          # writes codebase-map-facts.md
  npm --prefix backend run audit:map                 # checks it for drift
  npm --prefix backend run gen:route-locator         # writes route-locator.md
  npm --prefix backend run audit:route-locator       # checks it
  node backend/scripts/generate-route-capability-matrix.mjs
  npm --prefix backend run audit:routes              # checks it
  ```

  Run the `gen:*` half when you add routes, migrations or mobile screens.

- **`audit:routes` IS a gate; the other two are not.** Corrected 2026-08-13:
  this section used to say all three checks were "deliberately not CI merge
  gates". `audit:routes` is both — it runs inside the `backend-typecheck` job
  (`ci.yml:55`), which the `main-protection` ruleset lists as a REQUIRED
  status check, and again in the deploy job (`deploy.yml:197`), whose own
  comment says "this deploy job is its required backend gate ... so a direct
  main push cannot deploy an undeclared/stale authorization surface". The
  authorization surface is gated on purpose; only the NAVIGATION docs are not.

  `audit:map` and `audit:route-locator` appear in no workflow at all, so
  `codebase-map-facts.md` and `route-locator.md` drift silently and currently
  DO — as of 2026-08-13 the map facts record `consignment-returns.ts` at 957
  lines against an actual 1118. Generated is not the same as current: it means
  a generator exists, not that anything runs it.

  (The "jammed production twice" story that used to sit here is about why the
  three defect-class checks in `ci.yml:70-73` are PR-only. It was never a
  statement that `audit:routes` stopped being a gate.)
- The hand-written layers have no automation. They stay true only because the rule
  in §2 keeps them small enough to be worth re-reading. **If a hand-written doc
  starts filling up with numbers, that is the signal to teach the generator
  instead.**
