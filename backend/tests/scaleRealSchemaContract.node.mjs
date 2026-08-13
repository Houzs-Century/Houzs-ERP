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
  // The gate must still fire on `pull_request`. It now ALSO fires on
  // `merge_group`, so the condition is a folded multi-line `if: >-` and the
  // single-line form this used to match no longer exists. Asserting on the
  // event name alone keeps the invariant (every PR gets one evidence run)
  // without pinning the YAML formatting that expresses it.
  assert.match(workflow, /scale-postgres-contract:[\s\S]*github\.event_name == 'pull_request'/);
  assert.match(workflow, /--orders=100000 --lines=100000 --skus=10000 --users=10000 --runs=20/);
  assert.match(workflow, /--json=artifacts\/scale-pg-100k\.json/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4[\s\S]*if-no-files-found: error/);
});

// npm appends run arguments to the LAST command in a script, so whatever CI
// shards MUST be a single command — an `&&` chain sends `--shard` to the wrong
// binary and leaves vitest unsharded: every runner executing the whole suite,
// green, at several times the wall time sharding exists to remove.
//
// The CARRIER KEEPS CHANGING and the invariant does not. It was `test`; #2131
// made that an `&&` chain and moved CI to `test:workers`; the coverage ratchet
// moved it again to `test:coverage:workers` (same single command, `--coverage`
// added). Each time, a guard naming the script failed on a change that
// satisfied the rule perfectly — and this one gates `pretest`, so a false
// failure takes `npm test`, and deploy.yml's backend suite, down with it.
//
// So: read the script name OUT OF ci.yml and assert THAT script is a single
// command. The next rename needs no edit here, and a real `&&` in any carrier
// still fails.
test("the sharded backend script stays a single command so CI sharding still reaches vitest", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const sharded = workflow.match(
    /npm run ([\w:-]+) -- --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/,
  );
  assert.ok(sharded, "ci.yml must shard the backend suite with `npm run <script> -- --shard=i/n`");
  const script = pkg.scripts[sharded[1]];
  assert.ok(script, `ci.yml shards \`${sharded[1]}\`, which backend/package.json does not define`);
  assert.ok(
    !script.includes("&&"),
    `ci.yml shards \`${sharded[1]}\` = "${script}". npm appends --shard to the LAST command, ` +
      `so an && chain leaves vitest unsharded and every runner executes the whole suite.`,
  );
});

// `pretest` only fires for `npm test`, and backend CI runs `test:light` and
// `test:workers` — never `npm test`. So this suite has to be invoked by name in
// the workflow, or it stops running and nobody finds out. It did, for one
// afternoon, and two checks in this very file were failing the whole time.
test("this contract suite is actually invoked by CI, not left to pretest", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /- run: npm run test:scale-contract/);
});
