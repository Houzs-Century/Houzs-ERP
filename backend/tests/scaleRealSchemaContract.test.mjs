import assert from "node:assert/strict";
import { test } from 'vitest';
import { readFile } from "node:fs/promises";
import {
  PG_QUERY_SHAPES,
  PG_REAL_SCHEMA_DDL,
  SO_LIST_COLUMNS,
  pgSeedSql,
} from "../scripts/scale-pg-real-schema.mjs";

test("uses production relation names, payment view and hot indexes, never perf_* lookalikes", () => {
  assert.doesNotMatch(PG_REAL_SCHEMA_DDL, /\bperf_(users|skus|orders|order_lines)\b/);
  for (const relation of [
    "public.users",
    "public.user_companies",
    "scm.mfg_products",
    "scm.mfg_sales_orders",
    "scm.mfg_sales_order_items",
    "scm.mfg_sales_order_payments",
    "scm.mfg_sales_orders_with_payment_totals",
  ]) assert.match(PG_REAL_SCHEMA_DDL, new RegExp(relation.replaceAll(".", "\\.")));
  for (const index of [
    "idx_scm_mfg_so_company_so_date",
    "idx_scm_mfg_so_items_doc_no",
    "trgm_mfg_so_debtor_name",
    "trgm_mfg_prod_code",
    "trgm_users_name",
  ]) assert.match(PG_REAL_SCHEMA_DDL, new RegExp(index));
  assert.match(PG_REAL_SCHEMA_DDL, /sum\(amount_sen\).*paid_total/s);
});

/* The projection and the synthetic schema are edited by different hands, and
   only PostgreSQL ever compares them — in scale-postgres-contract, which since
   2026-08-18 runs POST-merge. Mig 0324 added the four hold columns to
   SO_LIST_COLUMNS here without adding them to the CREATE TABLE below it, and
   the first thing to say so was the Postsubmit run of the merge that landed it:
   `column "on_hold" does not exist`, red on every push from 2026-08-22 to
   2026-08-26. A projection name the DDL nowhere declares cannot survive the
   benchmark, so it is checkable as text, pre-merge, without a database. */
test("the SO list projection only names columns the synthetic schema declares", () => {
  const missing = SO_LIST_COLUMNS.split(", ").filter(
    (col) => !new RegExp(`\\b${col}\\b`).test(PG_REAL_SCHEMA_DDL),
  );
  assert.deepEqual(
    missing, [],
    `SO_LIST_COLUMNS names columns PG_REAL_SCHEMA_DDL never declares: ${missing.join(", ")}. ` +
      "The benchmark SELECTs this projection against the synthetic table, so the " +
      "post-merge 100k run dies on the first of these — declare them in the DDL too.",
  );
});

test("seeds requested cardinality for each of two tenants", () => {
  const seed = pgSeedSql({ orders: 100_000, lines: 100_000, skus: 10_000, users: 10_000 });
  assert.equal(seed.match(/generate_series\(1, 100000\) g/g)?.length, 3);
  assert.match(seed, /INSERT INTO scm\.mfg_sales_orders[\s\S]*generate_series\(1, 100000\) g/);
  assert.match(seed, /INSERT INTO scm\.mfg_sales_order_items[\s\S]*generate_series\(1, 100000\) g/);
  assert.equal(seed.match(/generate_series\(1, 10000\) g/g)?.length, 2);
  assert.ok((seed.match(/generate_series\(1, 2\) company_id/g)?.length ?? 0) >= 5);
  assert.match(seed, /ANALYZE scm\.mfg_sales_orders/);
});

test("pins heavy route query shapes and wide SO list projection", () => {
  assert.ok(SO_LIST_COLUMNS.split(", ").length > 75);
  assert.match(PG_QUERY_SHAPES.so_list_page, /scm\.mfg_sales_orders_with_payment_totals/);
  assert.match(PG_QUERY_SHAPES.so_list_page, /company_id = \$1[\s\S]*ORDER BY so_date DESC, doc_no DESC[\s\S]*LIMIT \$2 OFFSET \$3/);
  assert.match(PG_QUERY_SHAPES.so_search_page, /debtor_name ILIKE \$2[\s\S]*phone ILIKE \$2/);
  assert.match(PG_QUERY_SHAPES.so_detail_lines, /scm\.mfg_sales_order_items/);
  assert.match(PG_QUERY_SHAPES.products_page, /scm\.mfg_products[\s\S]*product_models[\s\S]*LIMIT 1000 OFFSET \$2/);
  assert.match(PG_QUERY_SHAPES.users_typeahead, /FROM public\.users u/);
  assert.match(PG_QUERY_SHAPES.users_typeahead, /string_agg[\s\S]*array_agg[\s\S]*LIMIT 50/);
  assert.match(PG_QUERY_SHAPES.users_typeahead, /company_ids_arr/);
  assert.doesNotMatch(PG_QUERY_SHAPES.users_full_list, /LIMIT|WHERE EXISTS/);
  assert.match(PG_QUERY_SHAPES.users_full_list, /LEFT JOIN public\.users m[\s\S]*LEFT JOIN public\.users ib/);
});

test("pagination correctness uses the real SO doc_no key when the list has no id", async () => {
  const harness = await readFile(new URL("../scripts/scale-harness.mjs", import.meta.url), "utf8");
  assert.match(harness, /row\.id \?\? row\.doc_no/);
  assert.match(harness, /pagination row has no id or doc_no identity/);
});

test("CI executes and retains the full 100k PostgreSQL evidence run", async () => {
  /* THIS GUARD USED TO PIN `ci.yml` AND `github.event_name == 'pull_request'`,
     and this file's own lesson (see the next test) is why that was wrong: a
     guard that pins the SHAPE of a correct answer blocks every other correct
     answer. On 2026-08-18 the job moved to `postsubmit.yml` — it had gone 37
     runs without a single failure, so it was spending presubmit runner time
     against a 20-slot ceiling to restate a known result (docs/ci-capacity-coe.md).
     Nothing about the evidence changed, but the old regex failed.

     The PROPERTY this test exists to protect is not "runs on pull_request". It
     is: the 100k run EXECUTES once per change, in a workflow that actually
     triggers, and its report is RETAINED as an artifact that cannot silently be
     empty. That survives the job living in either workflow, so find it rather
     than assume it. */
  const workflows = Object.fromEntries(await Promise.all(
    ["ci.yml", "postsubmit.yml"].map(async (name) => [
      name,
      await readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"),
    ]),
  ));

  const owners = Object.entries(workflows).filter(([, yaml]) =>
    /^ {2}scale-postgres-contract:$/m.test(yaml));
  assert.equal(
    owners.length, 1,
    `scale-postgres-contract must be defined in exactly one workflow, found ${owners.length}: ` +
      `${owners.map(([n]) => n).join(", ") || "none"}. Two copies means it runs twice; ` +
      "zero means the 100k evidence run stopped happening and nothing said so.",
  );
  const [owner, workflow] = owners[0];

  /* It has to be in a workflow that fires on its own, per change — not one that
     only ever runs by hand. `pull_request` (pre-merge) and `push` (post-merge)
     both satisfy "once per change"; `workflow_dispatch` alone does not. */
  const triggers = workflow.slice(0, workflow.search(/^jobs:/m));
  assert.match(
    triggers, /^ {2}(pull_request|push):/m,
    `${owner} defines scale-postgres-contract but is not triggered by pull_request or push, ` +
      "so the evidence run would only happen when someone remembers to click it.",
  );

  assert.match(workflow, /--orders=100000 --lines=100000 --skus=10000 --users=10000 --runs=20/);
  assert.match(workflow, /--json=artifacts\/scale-pg-100k\.json/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4[\s\S]*if-no-files-found: error/);
});

// The backend suite is sharded across four runners with
// `npm test -- --shard=i/n` (see ci.yml). npm appends run arguments to the LAST
// command in the script, so what `--shard` reaches is whatever ends the chain.
//
// THIS GUARD ASSERTED A LITERAL STRING AND THAT MADE IT WRONG. It required
// `test` to be exactly "vitest run". When the suite was split into a fast
// pure-logic project and a workerd one, `test` legitimately became
// "vitest run --config vitest.light.config.mts && vitest run" — and this
// assertion failed on origin/main itself, so `npm test` exited 1 there before a
// single vitest file ran. A guard that pins the SHAPE of a correct answer
// blocks every other correct answer; it has to pin the PROPERTY it exists to
// protect.
//
// The property is: the command that `--shard` lands on must be the WORKERD
// vitest run, because that is the 45-file project worth sharding. A chain is
// fine as long as it ENDS there. The light project runs once in the
// backend-typecheck job (`npm run test:light`), so a chain that also runs it
// per shard is wasteful but not wrong; a chain that ends on the LIGHT config
// would silently unshard the expensive half, which is the failure this exists
// to catch.
test("the sharded command reaches the workerd vitest project, not the light one", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

  /* Read WHICH script ci.yml shards, rather than hard-coding a name.
     THE CARRIER CHANGED, and that is the whole lesson: `test` is now
     `test:light && test:workers`, and CI deliberately shards `test:workers`
     instead — targeting the workerd project directly rather than relying on
     where an `&&` chain happens to end. The old guard named `npm test` by hand
     and so failed on that improvement.

     A second session fixed this same guard the same afternoon by hard-coding
     `test:workers` instead. Same verdict, and it works — but it pins the name
     in two places, so the NEXT rename breaks it again. Following the workflow
     is what stops that recurring. */
  const shardCmd = /npm (?:run )?([\w:-]+) -- --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/.exec(workflow);
  assert.ok(
    shardCmd,
    "ci.yml no longer shards with `npm [run] <script> -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}`. " +
      "If sharding moved, this guard has to move with it.",
  );

  const scriptName = shardCmd[1] === "test" ? "test" : shardCmd[1];
  const script = pkg.scripts[scriptName];
  assert.ok(script, `ci.yml shards \`${scriptName}\`, which is not a script in package.json.`);

  /* THE PROPERTY, and the only one worth pinning: npm appends run arguments to
     the LAST command of the script, so whatever ends the chain is what --shard
     lands on. It must resolve to the WORKERD project — a `vitest run` with no
     `--config`, which is how vitest picks up vitest.config.mts. A trailing
     `--config` would point the shard at a DIFFERENT project, silently
     unsharding the expensive half while every runner ran the cheap one whole.

     Asserted as a PROPERTY, not as the literal string "vitest run". This
     assertion WAS `assert.equal(last, "vitest run")`, and that is the very
     mistake the comment above it warns about: the coverage ratchet legitimately
     makes the shard target `vitest run --coverage` — same project, instrumented
     — and a literal match rejects it. Flags that do not change which project
     runs are none of this guard's business. */
  const last = script.split("&&").pop().trim();
  assert.match(
    last,
    /^vitest run\b/,
    `ci.yml shards \`npm run ${scriptName}\`, whose last command is "${last}". ` +
      "npm appends --shard there, so it has to be a `vitest run`.",
  );
  const cfg = /--config[= ]\s*(\S+)/.exec(last);
  assert.ok(
    !cfg || /vitest\.config\.mts$/.test(cfg[1]),
    `ci.yml shards \`npm run ${scriptName}\`, whose last command is "${last}". ` +
      `That points --shard at ${cfg?.[1]}, not the workerd project — the expensive ` +
      "half would run unsharded on every runner.",
  );

});

/* WHERE `pretest` WENT, and why its replacement is not in this file.
   The test above used to end with
     assert.equal(pkg.scripts.pretest, "npm run test:scale-contract")
   The hook it pinned existed for one reason: these contract suites were
   `node --test` files, collected by NEITHER vitest project, so without a
   lifecycle hook dragging them along nothing would have run them. They are vitest
   files now (BUG-HISTORY #2180 — a node:test file contributes nothing to the
   merged coverage report, so twelve tested modules read as untested), the
   projects collect them directly, and the hook went with the script it called.

   The hook's PROTECTION had to survive, so it was rewritten as "no suite is on
   disk yet claimed by nobody" — and put HERE first, which was wrong. Narrow the
   walk in scripts/lib/classify-tests.mjs back to `.test.ts` and vitest answers
   "No test files found" for this very file: the guard is itself one of the 18
   suites that stop being collected, so it would have disappeared alongside them
   and the run would have gone green with 267 files instead of 285.

   It lives in backend/scripts/audit-test-projects.mjs instead, as its own CI
   step, where no vitest include list can reach it. Both of its branches are
   proven red. Nothing is asserted here so that the two cannot drift. */
