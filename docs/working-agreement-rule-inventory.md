# Working agreement — rule inventory

Every rule `CLAUDE.md` carried on 2026-09-15 (commit `b41060523`, 1,368 lines), with where it lives
after the consolidation. A *rule* is an instruction a session must follow: a MUST / never / always, a
command to run, a gate, or a trap to avoid.

- **id** — the `[Rnn]` tag on the rule's bullet in `CLAUDE.md`. Every id below appears there exactly
  once, and no rule lives only in the history doc (checked by the script at the end of this file).
- **was** — line numbers in `CLAUDE.md` at `b41060523` (`git show b41060523:CLAUDE.md`). Several
  lines for one id means the old file stated the rule in more than one place; it is one bullet now.
- **now** — the `CLAUDE.md` section holding the bullet.
- **history** — the anchor in `docs/working-agreement-history.md` holding the verbatim story
  (incident, owner's words, CORRECTED box, worked example). `—` means the section had none.

When you add, merge or retire a rule, update this table in the same PR.

| id | rule | was (old lines) | now (CLAUDE.md section) | history |
| --- | --- | --- | --- | --- |
| R01 | Hypothesis + refuting observation, make the observation, name the tool, then fix | 15-24 | Do not guess | h-guess |
| R02 | Label claims PROVEN / LIKELY / UNKNOWN | 26-34 | Do not guess | h-guess |
| R03 | Reading code is not evidence about production | 35-50 | Do not guess | h-guess |
| R04 | Trap: the check that answers a different question | 52-57 | Do not guess | h-guess |
| R05 | Trap: the check that is not running | 58-62 | Do not guess | h-guess |
| R06 | Never make the evidence say what you want (missing marker row is the finding; fix the library, not the guard) | 64-66, 1092-1095 | Do not guess | h-guess |
| R07 | RE-RUN, never recall | 75-82 | Do not guess | h-guess |
| R08 | A contradiction is a finding — stop, do not bridge | 84-92 | Do not guess | h-guess |
| R09 | A remedy claim needs the run that proved it, or UNTESTED (enforced; fix every copy) | 94-135 | Do not guess | h-guess |
| R10 | AutoCount pull backlog: since-windows, not mode=all | 101-107 | Do not guess | h-guess |
| R11 | First sentence to the owner names the business effect | 147-160 | 用白话文跟老板讲 | h-plain |
| R12 | Identifiers are evidence and go last | 161-163 | 用白话文跟老板讲 | h-plain |
| R13 | A number carries its denominator in his terms | 164-166 | 用白话文跟老板讲 | h-plain |
| R14 | Define an unavoidable technical word once | 167-168 | 用白话文跟老板讲 | h-plain |
| R15 | Plain language does not license vagueness | 170-172 | 用白话文跟老板讲 | h-plain |
| R16 | Given a cause: read OUR code, say what changes in this system | 180-186 | A root cause is a request for OPTIONS | h-options |
| R17 | Say what a normal ERP does | 187-190, 227-230 | A root cause is a request for OPTIONS | h-options |
| R18 | 2-3 named options with consequences | 191-193 | A root cause is a request for OPTIONS | h-options |
| R19 | Recommend one and say why | 194-195 | A root cause is a request for OPTIONS | h-options |
| R20 | Never end a diagnosis without options | 196-197 | A root cause is a request for OPTIONS | h-options |
| R21 | Provable defect: fix without asking; judgement: options | 199-202 | A root cause is a request for OPTIONS | h-options |
| R22 | Trace the real mechanism to the line | 216-218 | 挖到真正的 ROOT CAUSE | h-root-cause |
| R23 | A workaround is a stopgap and must be named as one | 219-226 | 挖到真正的 ROOT CAUSE | h-root-cause |
| R24 | Options ranked stopgap to proper, effort/risk/benefit, recommend | 227-233 | 挖到真正的 ROOT CAUSE | h-root-cause |
| R25 | Chosen direction + clear steps: execute to the end without per-step approval | 240-247 | 任务清楚就一路做完 | h-execute |
| R26 | Interrupt only for the three cases | 249-253 | 任务清楚就一路做完 | h-execute |
| R27 | Absent secret reads as no-op; ship inert | 255-258 | 任务清楚就一路做完 | h-execute |
| R28 | Every fixed bug gets a docs/bugs entry in the same PR, fixed shape + severity | 262-270 | Log every bug in the ledger | h-bug-ledger |
| R29 | Scaffold with new-bug.mjs, never hand-pick the number | 269-274 | Log every bug in the ledger | h-bug-ledger |
| R30 | Read a subsystem's entries before touching it (gen:bug-index / gen:bug-history) | 265-266, 276-279, 1360-1362 | Log every bug in the ledger | h-bug-ledger |
| R31 | Cite a ledger entry by filename, never line number | 610-617 | Log every bug in the ledger | h-main-protected |
| R32 | Read the module guide before touching the module | 292-294 | Read the module guide | h-module-guide |
| R33 | Surface change updates the guide in the same PR | 294-297 | Read the module guide | h-module-guide |
| R34 | No guide: write it, shaped like sales-order.md | 299-301 | Read the module guide | h-module-guide |
| R35 | Coverage per area only up; no-test count only down; where each half runs | 305-330 | Coverage ratchets | h-coverage |
| R36 | coverage:update to raise; --allow-drop + reason to lower; slack; TESTING-RATCHET §6 | 332-337 | Coverage ratchets | h-coverage |
| R37 | A percentage is not the target; attack untested money/stock files | 339-341 | Coverage ratchets | h-coverage |
| R38 | Serious incident gets a COE with the canonical shape | 345-361 | A serious incident gets a COE | h-coe |
| R39 | working-agreement gate: what fails, labels, advisory, read the escapes test | 365-391 | …CHECKED on every PR | h-pr-checks |
| R40 | Missing guide warning: close the gap | 393-395 | …CHECKED on every PR | h-pr-checks |
| R41 | CLAUDE.md stays thin: rules and traps, no changing facts | 397-402 | …CHECKED on every PR | h-pr-checks |
| R42 | A written number is yours to keep true: generate + audit gate, or date it | 406-421, 1183-1184 | A number in a comment | h-numbers |
| R43 | Measure before optimising; before/after + tool in PR | 425-434 | Measure before you optimise | h-measure |
| R44 | Performance work must not destabilise; prove equivalence on the real runtime | 436-441 | Measure before you optimise | h-measure |
| R45 | Verify the ruleset with gh api; PR required, 0 approvals; no bypass | 445-458, 475-491 | main IS protected | h-main-protected |
| R46 | Auto-merge does not resolve conflicts; DIRTY needs a person | 457-463 | main IS protected | h-main-protected |
| R47 | Take a migration number at merge time by re-listing | 564-567, 987-990 | main IS protected | h-main-protected |
| R48 | Renumber freely; never edit an applied migration's body | 568-577 | main IS protected | h-main-protected |
| R49 | After merge, read the Deploy run conclusion beside the backend job (the pair table) | 578-597 | main IS protected | h-main-protected |
| R50 | A workflow_dispatch workflow ships only after one successful dispatch; copy a precedent that runs | 618-625 | main IS protected | h-main-protected |
| R51 | Never make backend-tests (N) / backend required; merge-blocking assertions go in backend-typecheck + MUST_GATE_MERGE | 538-544, 627-632 | main IS protected | h-main-protected |
| R52 | Never arm gh pr merge --auto on a migration / integration batch PR | 558-560 | main IS protected | h-main-protected |
| R53 | Check the tree before believing a remedy is outstanding | 553-557 | main IS protected | h-main-protected |
| R54 | Update a behind branch with a local git merge origin/main; never Update branch / gh pr update-branch | 636-657 | Update a behind branch… | h-merge-locally |
| R55 | Enable the merge.regen driver per clone | 659-666 | Update a behind branch… | h-merge-locally |
| R56 | Prefer a layout with no shared line over a merge driver | 668-674 | Update a behind branch… | h-merge-locally |
| R57 | statusCheckRollup lies: confirm against the newest run; the run list wins | 685-704 | statusCheckRollup LIES | h-rollup |
| R58 | Run the audit scripts; never quote their counts; output is evidence | 708-734 | Run the audit scripts | h-audit-scripts |
| R59 | check-docs-drift --strict and the five same-line markers; fences scanned; no silent exemptions | 736-766 | Run the audit scripts | h-audit-scripts |
| R60 | Frontend typecheck is tsc -b, never tsc --noEmit; prove a fast pass with a deliberate error | 598-605, 770-782 | CHECKS NOTHING on the frontend | h-tsc |
| R61 | A ledger entry with no test attached is unfixed | 606-608 | CHECKS NOTHING on the frontend | h-main-protected |
| R62 | Budget an error path per mutation | 793-796 | CHECKS NOTHING on the frontend | h-tsc |
| R63 | Checkers self-test; a verdict over nothing never reads as a pass | 798-803 | CHECKS NOTHING on the frontend | h-tsc |
| R64 | Read the DDL's words and the read path; 42501 is not scoping; the route predicate is the only boundary | 805-813 | CHECKS NOTHING on the frontend | h-tsc |
| R65 | Run build-local.ps1 before writing UNCOMPILED | 817-832 | The C# AutoCount service DOES compile | h-csharp |
| R66 | Compiling is not deploying; our half ships inert until the host rebuild | 834-838 | The C# AutoCount service DOES compile | h-csharp |
| R67 | npm run lint; CI job lint not required | 849-850 | There IS a linter | h-linter |
| R68 | ESLint missing locally means stale node_modules: npm ci in the app | 851-864 | There IS a linter | h-linter |
| R69 | Frontend leg enforces, backend CI leg --advisory until honest types make it green; hard errors never advisory; no continue-on-error | 865-881 | There IS a linter | h-linter |
| R70 | Keep eslint.js under process.execPath, not the .bin shim | 882-888 | There IS a linter | h-linter |
| R71 | Per-file lint ceilings only fall; never raise; disable with a reason; lint:update only down | 889-897 | There IS a linter | h-linter |
| R72 | Lint rules live in houzs-lint-rules.mjs and each cites a ledger entry | 898-902 | There IS a linter | h-linter |
| R73 | Lint scope is backend/src and frontend/src only | 903-906 | There IS a linter | h-linter |
| R74 | Read CODEBASE-MAP / module guide instead of exploring; the gated-in-CI table | 910-925, 938-940 | Read the map before exploring | h-map |
| R75 | Use route-locator to jump to a handler; never read a 10,000-line router whole | 941-948 | Read the map before exploring | h-map |
| R76 | A fact goes in the layer forced to update it; per-merge numbers are generated | 950-954 | Read the map before exploring | h-map |
| R77 | Never open a 5,000+ line file whole; grep then read the range | 956-960 | Read the map before exploring | h-map |
| R78 | File-size ceilings only fall; 2,000-line cap; new module, not a bigger number | 962-968 | Read the map before exploring | h-map |
| R79 | Correcting a doc paragraph: delete the one you replace | 935-937 | Read the map before exploring | h-map |
| R80 | Stack facts: Workers + Hono, React/Vite, R2; Supabase Postgres via Hyperdrive; D1 test-only | 972-976 | What this repo is | — |
| R81 | migrations-pg is live, migrations/ is D1-only; check the tree | 980-986 | Migrations — two trees | h-migrations |
| R82 | Gaps are safe, duplicate numbers break pg-migrate | 987-990 | Migrations — two trees | h-migrations |
| R83 | audit:release-discipline gate in backend-typecheck | 994-999 | Release discipline | h-release |
| R84 | Migration carries -- REVERSAL: or IRREVERSIBLE; DROP VIEW names the grants | 1001-1005 | Release discipline | h-release |
| R85 | A writing script carries the four: plan default, CONFIRM, fresh-connection shape check, RE-RUN line | 1007-1022 | Release discipline | h-release |
| R86 | Grandfathered list only shrinks; new scripts comply | 1024-1028 | Release discipline | h-release |
| R87 | Production-only fact: script + workflow_dispatch on DATABASE_URL, never ask the owner | 1032-1040 | Never ask the owner to run a query | h-no-query |
| R88 | DATABASE_URL is the only DB credential; pgrest-shim for the PostgREST shape | 1042-1051 | Never ask the owner to run a query | h-no-query |
| R89 | Supabase MCP: which of three projects is production; check the id | 1053-1062 | Never ask the owner to run a query | h-no-query |
| R90 | Service-role key is Worker-only, forbidden in Actions; ask the Worker for the REST edge; SOURCE_* is 2990 | 1064-1080 | Never ask the owner to run a query | h-no-query |
| R91 | Diagnostic workflow rules: read-only, manual, own concurrency group, exit 0, evidence not a setting | 1082-1095 | Never ask the owner to run a query | h-no-query |
| R92 | Never accept or print a credential; exposure: say so, record rotation, remind | 1097-1104 | Never ask the owner to run a query | h-no-query |
| R93 | Desktop and mobile change together through one shared logic layer | 1108-1113 | Desktop and mobile are one product | h-desktop-mobile |
| R94 | Obsidian wiki location; skip and say so when the MCP is absent | 1117-1125 | Obsidian wiki | h-wiki |
| R95 | When / when not / how to update the wiki | 1127-1145 | Obsidian wiki | h-wiki |
| R96 | No emoji anywhere | 1149 | Coding conventions | h-conventions |
| R97 | A deciding parameter is required (T or null), optional only when stricter | 786-791, 1150-1166 | Coding conventions | h-conventions |
| R98 | Prove "every call site" with an enumeration block, or reword / label | 1167-1192 | Coding conventions | h-conventions |
| R99 | Drizzle for new code; no mixed styles; hand-written SQL migrations | 1193-1202 | Coding conventions | h-conventions |
| R100 | No demo/seed data in numbered migrations | 1203-1216 | Coding conventions | h-conventions |
| R101 | Test-imported modules in scripts/lib with no shebang; the three exceptions | 1217-1240 | Coding conventions | h-conventions |
| R102 | Separate schema and large data migrations | 1241-1244 | Coding conventions | h-conventions |
| R103 | No WebSockets; polling | 1245-1246 | Coding conventions | h-conventions |
| R104 | URL is state | 1247-1248 | Coding conventions | h-conventions |
| R105 | Company scope predicate on writes too; rules a/b/c; helpers; maybeSingle; comment deliberate cross-company | 1249-1269 | Coding conventions | h-conventions |
| R106 | Permissions are flat strings; requireAnyPermission | 1270-1274 | Coding conventions | h-conventions |
| R107 | Project visibility is company-only; user_brands only for the director lane | 1275-1285 | Coding conventions | h-conventions |
| R108 | Task sections + attachments tables (mig 050) | 1286-1290 | Coding conventions | h-conventions |
| R109 | No features / refactors / abstractions beyond the task | 1294-1295 | Working agreement | — |
| R110 | Default to no comments; WHY only | 1296 | Working agreement | — |
| R111 | Test UI changes in the browser before claiming success | 1297 | Working agreement | — |
| R112 | Confirm before destructive ops; auto-mode is not consent | 1298-1299 | Working agreement | — |
| R113 | Write TODO when planning is confirmed | 1300 | Working agreement | — |
| R114 | Offer /sync-wiki after meaningful work | 1301-1302 | Working agreement | — |
| R115 | Auto-delete head branches is ON; re-verify with gh api; no manual delete | 1314-1327 | A merged PR's branch gets DELETED | h-branch-delete |
| R116 | Do not replace the setting with a workflow | 1329-1332 | A merged PR's branch gets DELETED | h-branch-delete |
| R117 | Never bulk-delete closed-unmerged or PR-less branches | 1334-1340 | A merged PR's branch gets DELETED | h-branch-delete |
| R118 | Prune only by PR merged; keep a sha manifest; restore command | 1342-1353 | A merged PR's branch gets DELETED | h-branch-delete |
| R119 | See-also pointers (knowledge system, map, bugs, hygiene, sync-wiki, memory, wiki home) | 1357-1368 | See also | — |
| R120 | Pointers to this inventory and the history doc | new | See also | — |
| R121 | A new rule is one bullet in CLAUDE.md; its story goes in the history doc; a row here | new (extends 397-402) | preamble | — |

## Classification calls worth a second look

- **R10, R80, R108** are facts rather than instructions. They stay in `CLAUDE.md` because a session
  acting without them does the wrong thing (runs `mode=all`; writes a D1 migration; surfaces the
  legacy attachment table).
- **R31 and R61** were stated inside the `main`-protection section (item 4 and its box); they moved
  next to the rules they belong with, and their story stays under `h-main-protected`.
- **R53** ("check the tree before believing a remedy is outstanding") was a lesson inside a CORRECTED
  box, promoted to a rule because it is phrased as one.
- **R110** ("default to no comments") is kept verbatim although much of the repo carries long WHY
  comments — it says WHY only, which those are.
- **R113** ("Write TODO when planning is confirmed") is kept verbatim; its intent is not stated
  anywhere else.
- **Not rules, history only:** the escape count and ESCAPE 3's closure, the incident table of
  migration collisions, the list of `docs/generated/` files carrying `merge=regen`, the `SUPABASE_URL`
  code citation, the counts inside the lint section, the 1,406-branch prune. All are in
  `docs/working-agreement-history.md`.
- **Removed as a duplicate:** old lines 465-474, which restated the ruleset's rule list and the
  `pull_request` rule's zero-approval parameter a second time (both remain in lines 453-458 and 475-491,
  now R45).

## The completeness check

Run from the repo root. It fails unless (1) the ids tagged in `CLAUDE.md` and the ids in the table
above are the same set, each tagged once; (2) each id sits under the section the table names; (3) every
history anchor the table or `CLAUDE.md` names exists; and (4) every line of `CLAUDE.md` at `b41060523`,
apart from the old two-line intro and the removed duplicate, appears in the history doc in order.

```js
// node --input-type=module -e "$(sed -n '/^\/\/ node --input-type/,/^console.log(.OK/p' docs/working-agreement-rule-inventory.md)"
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const claude = fs.readFileSync("CLAUDE.md", "utf8").replace(/\r/g, "");
const inv = fs.readFileSync("docs/working-agreement-rule-inventory.md", "utf8").replace(/\r/g, "");
const hist = fs.readFileSync("docs/working-agreement-history.md", "utf8").replace(/\r/g, "");
const fail = [];
const tagged = new Map();
let section = "preamble";
for (const line of claude.split("\n")) {
  const h = /^#{2,3} (.*)$/.exec(line);
  if (h) section = h[1];
  for (const m of line.matchAll(/\[(R\d+)\]/g)) {
    if (tagged.has(m[1])) fail.push(`${m[1]} tagged twice in CLAUDE.md`);
    tagged.set(m[1], section);
  }
}
const rows = [...inv.matchAll(/^\| (R\d+) \| [^|]* \| [^|]* \| ([^|]*) \| ([^|]*) \|$/gm)];
if (rows.length < 100) fail.push(`only ${rows.length} inventory rows parsed`);
const norm = (s) => s.replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
for (const [, id, now, anchor] of rows) {
  if (!tagged.has(id)) fail.push(`${id} is in the inventory but not tagged in CLAUDE.md`);
  else if (!norm(tagged.get(id)).includes(norm(now))) fail.push(`${id}: inventory says "${now.trim()}", CLAUDE.md has it under "${tagged.get(id)}"`);
  const a = anchor.trim();
  if (a !== "—" && !hist.includes(`<a id="${a}"></a>`)) fail.push(`${id}: history anchor ${a} missing`);
}
const invIds = new Set(rows.map((r) => r[1]));
for (const id of tagged.keys()) if (!invIds.has(id)) fail.push(`${id} is tagged in CLAUDE.md but missing from the inventory`);
for (const m of claude.matchAll(/working-agreement-history\.md#(h-[a-z-]+)/g))
  if (!hist.includes(`<a id="${m[1]}"></a>`)) fail.push(`CLAUDE.md links to missing anchor ${m[1]}`);
const old = execFileSync("git", ["show", "b41060523:CLAUDE.md"], { encoding: "utf8" }).replace(/\r/g, "").split("\n");
const histLines = hist.split("\n");
let at = 0, kept = 0;
old.forEach((line, i) => {
  const n = i + 1;
  if (n <= 4 || (n >= 465 && n <= 474)) return;
  let j = at;
  while (j < histLines.length && histLines[j] !== line) j++;
  if (j === histLines.length) fail.push(`old CLAUDE.md line ${n} is not in the history doc (in order): ${line.slice(0, 80)}`);
  else { at = j + 1; kept++; }
});
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log(`OK ${tagged.size} rules tagged in CLAUDE.md = ${invIds.size} inventory rows; ${kept} of ${old.length} old CLAUDE.md lines present verbatim in the history doc`);
```
