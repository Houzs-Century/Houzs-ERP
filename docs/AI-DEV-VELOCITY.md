# AI-assisted development is slow here — why, and the fix

Written 2026-07-23 after the owner asked the right question: AI-assisted work on
this codebase has gotten slow, search takes forever, and token usage is climbing.
This diagnoses the real cause (measured, not guessed) and lays out the fix, ordered
by impact. It does NOT change code — it is the plan to decide from.

## The owner's own metaphor, which is exactly right

> "You should find things like an address: country -> state -> city -> postcode ->
> the specific route. Not search the whole country every time."

That is precisely how code retrieval should work. The formal name is **Progressive
Disclosure** (give the overview, expand detail only as needed); the technique that
makes the last step possible is **Semantic Search / RAG** (retrieval-augmented
generation). The AI here is currently "searching the whole country" — that is the
slowness and the token cost.

## What we measured (2026-07-23)

> **⚠️ RE-MEASURED 2026-08-14, and the numbers below did not survive.** This
> section is kept as the record of what was believed on 2026-07-23; do not quote
> it as current. Two problems, and the second is the serious one:
>
> 1. **The sizes drifted**, as sizes do — but the doc never carried an "as of",
>    so nothing signalled it. Then: 938 files / 30 over 2,000 lines. Now: **1,279
>    files, 39 over 2,000 lines** (`docs/generated/codebase-map-facts.md`).
> 2. **The ENDPOINT counts were never reproducible.** They are the load-bearing
>    figure of this whole document, and two independent generated artifacts
>    disagree with all four of them:
>
>    | File | This doc claimed | `codebase-map-facts.md` | `route-capability-matrix.csv` |
>    |---|---|---|---|
>    | `mfg-sales-orders.ts` | 111 | **42** | **42** |
>    | `scan-so.ts` | 23 | **11** | **11** |
>    | `delivery-orders-mfg.ts` | 41 | **15** | **15** |
>    | `mfg-purchase-orders.ts` | 50 | **25** | **25** |
>
>    The `143,431 lines` figure is likewise not reproducible: the tree at the
>    nearest commit to this doc's date measured ~413,000 lines. The doc never
>    recorded its counting method, so neither number can be audited.
>
> **What this does NOT change: the argument still holds.** A 12,106-line file
> with 42 endpoints is still a file nobody should read whole, and "no cities or
> postcodes inside the state" is still the right diagnosis. The remedy that
> shipped — `docs/generated/route-locator.md`, every route's file AND line — is
> the postcode layer this document asked for. The counts were wrong; the shape
> of the problem was not.

- **938 source files, 143,431 lines** (backend + frontend).
- **30 files over 2,000 lines.** Reading one to change ten lines is the token sink.
- **The monsters:**

  | File | Lines | Endpoints / parts |
  |---|---|---|
  | `frontend/src/pages/Projects.tsx` | 12,859 | ~102 components/functions |
  | `backend/src/scm/routes/mfg-sales-orders.ts` | 10,873 | **111 endpoints** |
  | `frontend/src/pages/ServiceCases.tsx` | 8,165 | |
  | `frontend/src/pages/scm-v2/Products.tsx` | 5,499 | |
  | `frontend/src/pages/Team.tsx` | 5,197 | |
  | `backend/src/scm/routes/scan-so.ts` | 4,824 | 23 endpoints |
  | `backend/src/scm/routes/delivery-orders-mfg.ts` | 4,361 | 41 endpoints |
  | `backend/src/scm/routes/mfg-purchase-orders.ts` | 3,406 | 50 endpoints |

**The root cause, in the owner's terms:** the map gets the AI to the right "state"
(sales orders), but inside that state there are **no cities or postcodes** — dozens
of endpoints sit in one file of over ten thousand lines. So the AI arrives and
still has to walk the whole plain. That is what burns time and tokens.

## Where this codebase is already STRONG (do not rebuild these)

The map layer is better than most:
- `docs/CODEBASE-MAP.md` — the hand-written judgement layer. (This bullet used to
  read "350 lines, updated ~31h ago. Fresh." Both halves were unauditable by
  construction: a relative timestamp in a file with no re-measure date can never
  be checked, and the line count has since moved.)
- **Module guides** in `docs/modules/` — run `ls docs/modules/` for the list. (This
  said "11 module guides"; there are far more now. It also said *"the
  KNOWLEDGE-SYSTEM doc's claim of 'only one' is stale"* — that claim has since
  been deleted from `KNOWLEDGE-SYSTEM.md`, which now deliberately refuses to
  carry a count for exactly this reason.)
- Generators: `gen-codebase-map.mjs`, `generate-route-capability-matrix.mjs`,
  `gen-route-locator.mjs`. **Correction 2026-08-14: "the map is machine-regenerated,
  so it cannot rot" was wrong twice.** `docs/CODEBASE-MAP.md` is hand-written — only
  `docs/generated/` is emitted — and of the generated artifacts only
  `audit:routes` is a CI gate. `route-locator.md` and `codebase-map-facts.md` were
  both found STALE on `main` on 2026-08-14. They can rot, and they had.

So levels 1-2 of retrieval (map -> module) are healthy. **The failures are level 3
(inside the file) and the absence of a semantic index.** That narrows the fix.

## What is NOT the cause (so we do not waste effort there)

- **COE** (`docs/*-coe.md`) — these are incident post-mortems ("Correction of Error").
  Unrelated to retrieval speed. Do not touch them for this.
- **The Obsidian wiki** — human-facing, not in the AI's session, and not even present
  on this machine. Building it does NOTHING for AI velocity. Skip it entirely.
- **Opus itself** — not the root cause. A leaner model helps for *mechanical* work
  (see model tiering below), but the token sink is the monster-file reads, not the
  model. Splitting + an index helps far more than a model swap.
- **Writing MORE prose docs** — the map/guides are already good; the gap is code shape
  and search, not documentation.

---

## The fix — two levers, in priority order

### Lever A — Semantic index (the "smart map"): do this FIRST, today, zero risk

A semantic index lets the AI ask "where is the sofa discount computed?" and jump
straight to those 30 lines, instead of reading a 10,873-line file to find them. It
treats the symptom without touching code, so it is safe and immediate.

- **`gbrain` is NOT installed** (no `~/.gbrain/config.json`, not on PATH).
  Installing + indexing it would replace whole-file reads with `gbrain search` /
  `gbrain code-def` / `gbrain code-refs`.
  *(Corrected 2026-08-14: this bullet opened "referenced in this repo's
  `CLAUDE.md`". It is not — `grep -in gbrain CLAUDE.md` returns zero hits, and
  has for as long as the file has been checked. The only two references to
  gbrain in this repo are this document and `docs/SECURITY-DX-ROADMAP.md`.)*
- Alternatives if not gbrain: Cursor's built-in codebase index, Sourcegraph, or any
  embeddings-based code search. The point is RAG, not the specific tool.
- ~~Add ONE rule to `CLAUDE.md`~~ — **DONE.** `CLAUDE.md` now carries it in the
  *Read the map before exploring* section: *"Do NOT read a 10,000-line route file
  whole to find one handler"* and *"Do not open a 5,000+ line file whole … Locate
  with grep, then read the line range."* It also points at
  `docs/generated/route-locator.md`, which did not exist when this was written and
  is the file-and-line index this section was asking for.

**Effort:** install + index once (minutes). **Risk:** none (read-only tooling).

### Lever B — Split the monster files (build real districts): the cure, bigger effort

This is the actual fix for the owner's "no cities/postcodes inside the state"
problem. A 10,873-line route file becomes a directory of small, named files, so the
AI (and humans) land directly in the relevant few hundred lines.

**How to split a ROUTE file** (e.g. `mfg-sales-orders.ts`, 111 endpoints):
- Create `scm/routes/mfg-sales-orders/` and split by sub-resource / concern:
  `list.ts`, `detail.ts`, `create.ts`, `convert.ts`, `finance.ts`, `customers.ts`,
  `search.ts`, ... Each mounts its own routes onto a shared sub-router.
- A thin `index.ts` re-exports the combined router, so the mount point in `scm/index.ts`
  does not change. **Zero behavior change** — pure mechanical extraction.
- Target: no file over ~800 lines; each file one clear responsibility.

**How to split a PAGE** (e.g. `Projects.tsx`, 12,859 lines):
- Extract each tab/panel into its own component file, and each data-fetch into a hook
  (`useProjectX`). The page file becomes a thin shell that composes them.

**Order — most-touched first** (split the ones you edit most; leave rarely-touched
monsters alone until you need them):
1. `mfg-sales-orders.ts` (core SO flow, edited constantly)
2. `Projects.tsx` (largest, heavily worked)
3. Then `ServiceCases.tsx`, `Products.tsx`, `scan-so.ts` as you touch them.

**Method / safety:** one file per PR; `tsc` + tests are the gate; no logic changes,
only moves. Update the module guide + `CODEBASE-MAP` in the same PR. This is exactly
the worktree->PR->verify flow already used here.

**Effort:** real (each monster is a focused day). **Risk:** low if done as pure
extraction with tests green — but it IS touching core files, so one PR at a time,
reviewed, not a big-bang.

---

## How large-ERP teams actually run AI-assisted dev

Not by writing more docs. By these, in roughly this order of impact:
1. **Small files.** 100-400 lines, one responsibility. No 10k-line files exist to read.
2. **Semantic code search** (Sourcegraph / embeddings / Cursor index / gbrain) so the
   AI retrieves the relevant span instead of reading files.
3. **A generated, always-fresh map** + per-module guides (this repo already does this).
4. **Model tiering** — a fast/cheap model for mechanical work (renames, moves, boilerplate),
   the strong model (Opus) reserved for real reasoning. Cuts both cost and latency.
5. **Sub-agent fan-out for search** — dispatch a read-only agent to "find X across the
   codebase" so its whole-file reads happen in a throwaway context and never bloat the
   main conversation. (This audit used exactly that pattern.)

## On token usage specifically

The token climb is mostly **re-reading monster files every session** (context does not
persist between sessions, so each new task re-reads the same 10k-line file). The fix is
the same two levers: an index means the AI reads 300 lines not 10,000; splitting means
the file it reads is 300 lines to begin with; sub-agents keep whole-file reads out of
the main thread. Model tiering trims what is left.

---

## Recommended batched plan

| Phase | What | Effort | Risk |
|---|---|---|---|
| 0 | This doc (decide from it) | done | none |
| 1 | Install + index **gbrain** (or Cursor index) — still open. ~~add the "don't read monster files whole" rule to CLAUDE.md~~ — **shipped**, see above | minutes | none |
| 2 | Split `mfg-sales-orders.ts` (42 endpoints, 12,106 lines) into a directory — one PR, tests green. **Not started** | ~1 focused session | low |
| 3 | Split `Projects.tsx` into components + hooks | ~1 session | low |
| 4 | Opportunistic: split the next monster whenever you next work in it, not all at once | ongoing | low |
| 5 | Adopt model tiering + sub-agent-for-search as a working habit | habit | none |

**Biggest bang for least effort: Phase 1 (index) today, then Phase 2 (split the SO
router) — those two alone will noticeably cut both the slowness and the token bill.**

## What this is NOT

This is a plan, not a promise. Splitting core route files is real surgery on a live
ERP; do it incrementally, behind tests, one PR at a time — never as a big-bang rewrite.
