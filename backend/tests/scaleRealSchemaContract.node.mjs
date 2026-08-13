import assert from "node:assert/strict";
import test from "node:test";
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
  assert.match(PG_REAL_SCHEMA_DDL, /sum\(amount_centi\).*paid_total/s);
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

test("PR CI executes and retains the full 100k PostgreSQL evidence run", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  /* The job must be PR-gated. Asserted as a PROPERTY, not a format: the
     condition was a one-liner and became a folded `if: >-` block when a
     merge_group clause was added, which broke this assertion on origin/main
     itself without anything about the gate changing. Match the job header, then
     the expression anywhere in it. */
  assert.match(workflow, /scale-postgres-contract:[\s\S]*?if:[\s\S]{0,600}?github\.event_name == 'pull_request'/);
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

  /* Read WHICH script ci.yml shards, rather than hard-coding a name. The old
     guard asserted `npm test -- --shard=...` and ci.yml has since moved to
     `npm run test:workers -- --shard=...` — a better arrangement, since it
     targets the workerd project directly instead of relying on where an `&&`
     chain happens to end. A guard naming the script by hand fails on that
     improvement; a guard that FOLLOWS the workflow keeps checking the thing
     that matters. */
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
     lands on. It must be the bare workerd `vitest run`. A trailing `--config`
     would point the shard at a DIFFERENT project — silently unsharding the
     expensive half while four runners each ran the cheap one whole. */
  const last = script.split("&&").pop().trim();
  assert.equal(
    last,
    "vitest run",
    `ci.yml shards \`npm run ${scriptName}\`, whose last command is "${last}". ` +
      "npm appends --shard there, so it must be the bare workerd `vitest run`.",
  );

  assert.equal(pkg.scripts.pretest, "npm run test:scale-contract");
});
