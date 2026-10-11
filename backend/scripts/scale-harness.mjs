#!/usr/bin/env node

import Database from "better-sqlite3";
import postgres from "postgres";
import { writeFile } from "node:fs/promises";
import {
  assertDisposableCatalog,
  assertPgTarget,
  readCatalogSnapshot,
} from "./scale-target-guard.mjs";
import {
  PG_QUERY_SHAPES,
  PG_REAL_SCHEMA_DDL,
  REAL_SCHEMA_CONTRACT_VERSION,
  pgSeedSql,
} from "./scale-pg-real-schema.mjs";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=", 2);
    return [key, value];
  }),
);

const integerArg = (name, fallback) => {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};

const config = {
  engine: args.get("engine") ?? "sqlite",
  orders: integerArg("orders", 100_000),
  lines: integerArg("lines", 100_000),
  skus: integerArg("skus", 10_000),
  users: integerArg("users", 10_000),
  runs: integerArg("runs", 20),
  json: args.get("json") ?? null,
};

if (!["sqlite", "pg", "both"].includes(config.engine)) {
  throw new Error("--engine must be sqlite, pg, or both");
}

const COMPANY_IDS = [1, 2];
const PAGE_SIZE = 50;
const DEEP_OFFSET = Math.max(0, Math.min(4_950, config.orders - PAGE_SIZE));

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
};

function validateRows(name, rows, expectedRows, validate) {
  if (!Array.isArray(rows)) throw new Error(`${name} did not return a row array`);
  if (rows.length !== expectedRows) {
    throw new Error(`${name} returned ${rows.length} rows; expected ${expectedRows}`);
  }
  validate?.(rows);
}

const validateTenant = (companyId) => (rows) => {
  if (rows.some((row) => Number(row.company_id) !== companyId)) {
    throw new Error(`result leaked outside company ${companyId}`);
  }
};

const validateTeamDirectoryAcrossTenants = (expectedPerTenant) => (rows) => {
  const counts = new Map([[1, 0], [2, 0]]);
  for (const row of rows) {
    const grants = Array.isArray(row.company_ids_arr) ? row.company_ids_arr.map(Number) : [];
    if (grants.length !== 1 || !counts.has(grants[0])) {
      throw new Error("Team directory row did not carry exactly one expected tenant grant");
    }
    counts.set(grants[0], counts.get(grants[0]) + 1);
  }
  for (const [companyId, count] of counts) {
    if (count !== expectedPerTenant) {
      throw new Error(`Team directory tenant ${companyId} returned ${count}; expected ${expectedPerTenant}`);
    }
  }
};

function validatePagination(first, second) {
  // The production SO list projection is keyed by doc_no and deliberately has
  // no synthetic `id`; the SQLite smoke uses id. Treat either canonical key as
  // valid and fail closed if a future query shape exposes neither.
  const identity = (row) => {
    const key = row.id ?? row.doc_no;
    if (key == null) throw new Error("pagination row has no id or doc_no identity");
    return `${row.company_id ?? ""}:${String(key)}`;
  };
  const firstIds = new Set(first.map(identity));
  if (second.some((row) => firstIds.has(identity(row)))) {
    throw new Error("pagination returned duplicate rows across adjacent pages");
  }
}

async function measure(name, fn, expectedRows, validate) {
  for (let i = 0; i < 3; i += 1) {
    validateRows(name, await fn(), expectedRows, validate);
  }
  const samples = [];
  for (let i = 0; i < config.runs; i += 1) {
    const started = performance.now();
    const rows = await fn();
    samples.push(performance.now() - started);
    validateRows(name, rows, expectedRows, validate);
  }
  return {
    name,
    rows: expectedRows,
    p50_ms: Number(percentile(samples, 0.5).toFixed(2)),
    p95_ms: Number(percentile(samples, 0.95).toFixed(2)),
    max_ms: Number(Math.max(...samples).toFixed(2)),
  };
}

function sqliteHarness() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");
  db.pragma("temp_store = MEMORY");
  db.exec(`
    CREATE TABLE perf_users (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE perf_skus (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE perf_orders (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL,
      doc_no TEXT NOT NULL,
      doc_date TEXT NOT NULL,
      debtor_name TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE perf_order_lines (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL,
      doc_no TEXT NOT NULL,
      item_code TEXT NOT NULL,
      qty INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX perf_orders_doc_no ON perf_orders(company_id, doc_no);
    CREATE INDEX perf_orders_list ON perf_orders(company_id, doc_date DESC, doc_no DESC);
    CREATE INDEX perf_order_lines_doc ON perf_order_lines(company_id, doc_no);
    CREATE INDEX perf_users_name ON perf_users(company_id, name COLLATE NOCASE);
    CREATE INDEX perf_skus_code ON perf_skus(company_id, code COLLATE NOCASE);
  `);

  const insertUser = db.prepare(
    "INSERT INTO perf_users VALUES (?, ?, ?, ?, 'active')",
  );
  const insertSku = db.prepare(
    "INSERT INTO perf_skus VALUES (?, ?, ?, ?, 'ACTIVE')",
  );
  const insertOrder = db.prepare(
    "INSERT INTO perf_orders VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertLine = db.prepare(
    "INSERT INTO perf_order_lines VALUES (?, ?, ?, ?, ?)",
  );
  const seed = db.transaction(() => {
    for (const companyId of COMPANY_IDS) {
      const userBase = (companyId - 1) * config.users;
      const skuBase = (companyId - 1) * config.skus;
      const orderBase = (companyId - 1) * config.orders;
      const lineBase = (companyId - 1) * config.lines;
      for (let localId = 1; localId <= config.users; localId += 1) {
        insertUser.run(userBase + localId, companyId, `User ${String(localId).padStart(5, "0")}`, `user${localId}@c${companyId}.perf.invalid`);
      }
      for (let localId = 1; localId <= config.skus; localId += 1) {
        insertSku.run(skuBase + localId, companyId, `SKU-${String(localId).padStart(5, "0")}`, `Product ${localId}`);
      }
      for (let localId = 1; localId <= config.orders; localId += 1) {
        const day = String(1 + (localId % 28)).padStart(2, "0");
        const month = String(1 + (Math.floor(localId / 28) % 12)).padStart(2, "0");
        insertOrder.run(
          orderBase + localId,
          companyId,
          `SO-2607-${String(localId).padStart(6, "0")}`,
          `2026-${month}-${day}`,
          `Customer ${localId % 20_000}`,
          ["DRAFT", "CONFIRMED", "IN_PRODUCTION", "DELIVERED"][localId % 4],
          `2026-${month}-${day}T12:00:00Z`,
        );
      }
      for (let localId = 1; localId <= config.lines; localId += 1) {
        const orderId = 1 + ((localId - 1) % config.orders);
        insertLine.run(
          lineBase + localId,
          companyId,
          `SO-2607-${String(orderId).padStart(6, "0")}`,
          `SKU-${String(1 + (localId % config.skus)).padStart(5, "0")}`,
          1 + (localId % 5),
        );
      }
    }
  });
  seed();
  db.exec("ANALYZE");

  const queries = {
    firstPage: db.prepare(
      "SELECT id, company_id, doc_no, doc_date, debtor_name, status FROM perf_orders WHERE company_id = ? ORDER BY doc_date DESC, doc_no DESC LIMIT 50",
    ),
    deepPage: db.prepare(
      `SELECT id, company_id, doc_no, doc_date, debtor_name, status FROM perf_orders WHERE company_id = ? ORDER BY doc_date DESC, doc_no DESC LIMIT 50 OFFSET ${DEEP_OFFSET}`,
    ),
    oneCharPrefix: db.prepare(
      "SELECT id, company_id, doc_no FROM perf_orders WHERE company_id = ? AND doc_no LIKE ? ORDER BY doc_date DESC, doc_no DESC LIMIT 6",
    ),
    detailLines: db.prepare(
      "SELECT id, company_id, item_code, qty FROM perf_order_lines WHERE company_id = ? AND doc_no = ? ORDER BY id",
    ),
    userTypeahead: db.prepare(
      "SELECT id, company_id, name, email FROM perf_users WHERE company_id = ? AND name LIKE ? COLLATE NOCASE ORDER BY name LIMIT 20",
    ),
    skuTypeahead: db.prepare(
      "SELECT id, company_id, code, name FROM perf_skus WHERE company_id = ? AND code LIKE ? COLLATE NOCASE ORDER BY code LIMIT 20",
    ),
  };

  return {
    engine: "sqlite-query-shape",
    counts: {
      per_tenant: { orders: config.orders, lines: config.lines, skus: config.skus, users: config.users },
      total: { orders: config.orders * 2, lines: config.lines * 2, skus: config.skus * 2, users: config.users * 2 },
    },
    plans: {
      first_page: db.prepare("EXPLAIN QUERY PLAN SELECT id, doc_no FROM perf_orders WHERE company_id = 1 ORDER BY doc_date DESC, doc_no DESC LIMIT 50").all(),
      detail_lines: db.prepare("EXPLAIN QUERY PLAN SELECT id FROM perf_order_lines WHERE company_id = 1 AND doc_no = 'SO-2607-000001'").all(),
    },
    correctness() {
      const first = queries.firstPage.all(1);
      const second = db.prepare(
        "SELECT id, company_id, doc_no FROM perf_orders WHERE company_id = ? ORDER BY doc_date DESC, doc_no DESC LIMIT 50 OFFSET 50",
      ).all(1);
      const expectedFirst = Math.min(PAGE_SIZE, config.orders);
      const expectedSecond = Math.min(PAGE_SIZE, Math.max(0, config.orders - PAGE_SIZE));
      validateRows("correctness:first-page", first, expectedFirst, (rows) => {
        if (rows.some((row) => row.company_id !== 1)) throw new Error("first page leaked another tenant");
      });
      validateRows("correctness:second-page", second, expectedSecond, (rows) => {
        if (rows.some((row) => row.company_id !== 1)) throw new Error("second page leaked another tenant");
      });
      validatePagination(first, second);
      const broad = queries.oneCharPrefix.all(1, "S%");
      const narrow = queries.oneCharPrefix.all(1, "SO-2607-000001%");
      if (broad.length !== Math.min(6, config.orders) || broad.some((row) => !row.doc_no.startsWith("S"))) {
        throw new Error("one-character prefix returned an invalid result");
      }
      if (narrow.length !== 1 || narrow[0].doc_no !== "SO-2607-000001" || narrow[0].company_id !== 1) {
        throw new Error("narrow prefix did not retrieve the expected scoped order");
      }
      return { first_page_rows: first.length, second_page_rows: second.length, no_adjacent_duplicates: true, prefix_narrowing: true };
    },
    async benchmarks() {
      const cases = [
        ["orders:first-page", () => queries.firstPage.all(1), Math.min(PAGE_SIZE, config.orders), validateTenant(1)],
        ["orders:deep-offset-page", () => queries.deepPage.all(1), Math.min(PAGE_SIZE, config.orders - DEEP_OFFSET), validateTenant(1)],
        ["orders:one-char-prefix", () => queries.oneCharPrefix.all(1, "S%"), Math.min(6, config.orders), (rows) => {
          validateTenant(1)(rows);
          if (rows.some((row) => !row.doc_no.startsWith("S"))) throw new Error("bad prefix result");
        }],
        ["orders:detail-lines", () => queries.detailLines.all(1, "SO-2607-000001"), Math.floor((config.lines - 1) / config.orders) + 1, validateTenant(1)],
        ["users:typeahead", () => queries.userTypeahead.all(1, "User 0%"), Math.min(20, config.users, 9_999), validateTenant(1)],
        ["skus:typeahead", () => queries.skuTypeahead.all(1, "SKU-0%"), Math.min(20, config.skus, 9_999), validateTenant(1)],
      ];
      const results = [];
      for (const [name, query, expectedRows, validate] of cases) results.push(await measure(name, query, expectedRows, validate));
      return results;
    },
    close: () => db.close(),
  };
}

async function postgresHarness() {
  const url = process.env.PERF_DATABASE_URL;
  if (!url) throw new Error("PERF_DATABASE_URL is required for --engine=pg/both");
  assertPgTarget(url);
  const sql = postgres(url, { ssl: false, max: 1, prepare: false, connect_timeout: 10 });
  let transactionOpen = false;
  let sessionLockHeld = false;
  try {
    // Serialize peer harnesses before inspecting the catalogue. A session lock
    // is used here (rather than an xact lock after the probe) so two processes
    // cannot both approve the same empty database and race into DDL.
    const lock = await sql.unsafe(
      "SELECT pg_try_advisory_lock(hashtext('houzs-real-schema-scale-v1')) AS acquired",
    );
    if (lock[0]?.acquired !== true) {
      throw new Error("Another Houzs scale harness already owns this database.");
    }
    sessionLockHeld = true;
    await sql.unsafe("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionOpen = true;
    await sql.unsafe("SET LOCAL lock_timeout = '5s'");
    await sql.unsafe("SET LOCAL statement_timeout = '15min'");
    await sql.unsafe("SET LOCAL idle_in_transaction_session_timeout = '20min'");
    // URL checks alone cannot distinguish a local server from a localhost
    // tunnel. The database comment is provisioned out of band and the live
    // catalogue must still be empty before this transaction performs any DDL.
    assertDisposableCatalog(await readCatalogSnapshot(sql));
    await sql.unsafe(PG_REAL_SCHEMA_DDL);
    await sql.unsafe(pgSeedSql(config));

    const run = (name, params) => sql.unsafe(PG_QUERY_SHAPES[name], params);
    const first = await run("so_list_page", [1, PAGE_SIZE, 0]);
    const second = await run("so_list_page", [1, PAGE_SIZE, PAGE_SIZE]);
    const narrow = await run("so_search_page", [1, "%C1-SO-2607-000001%", 6]);
    validateRows("correctness:first-page", first, Math.min(PAGE_SIZE, config.orders), validateTenant(1));
    validateRows("correctness:second-page", second, Math.min(PAGE_SIZE, Math.max(0, config.orders - PAGE_SIZE)), validateTenant(1));
    validateRows("correctness:narrow-prefix", narrow, 1, (rows) => {
      validateTenant(1)(rows);
      if (rows[0].doc_no !== "C1-SO-2607-000001") throw new Error("narrow search returned the wrong order");
    });
    validatePagination(first, second);

    const counts = await sql.unsafe(`
      SELECT company_id,
             (SELECT count(*) FROM scm.mfg_sales_orders so2 WHERE so2.company_id = c.company_id)::integer AS orders,
             (SELECT count(*) FROM scm.mfg_sales_order_items li WHERE li.company_id = c.company_id)::integer AS lines,
             (SELECT count(*) FROM scm.mfg_products p WHERE p.company_id = c.company_id)::integer AS skus,
             (SELECT count(*) FROM public.user_companies uc WHERE uc.company_id = c.company_id)::integer AS users
        FROM (VALUES (1::bigint), (2::bigint)) c(company_id)
       ORDER BY company_id
    `);
    for (const row of counts) {
      if (
        Number(row.orders) !== config.orders || Number(row.lines) !== config.lines ||
        Number(row.skus) !== config.skus || Number(row.users) !== config.users
      ) {
        throw new Error(`fixture cardinality mismatch for tenant ${row.company_id}`);
      }
    }
    const paid = await sql.unsafe(`
      SELECT company_id, doc_no, local_total_centi, paid_total_centi, balance_centi_live
        FROM scm.mfg_sales_orders_with_payment_totals
       WHERE doc_no IN ('C1-SO-2607-000004', 'C2-SO-2607-000004')
       ORDER BY company_id
    `);
    validateRows("correctness:payment-view", paid, 2, (rows) => {
      if (rows.some((r) => Number(r.local_total_centi) !== 10_000 || Number(r.paid_total_centi) !== 1_000 || Number(r.balance_centi_live) !== 9_000)) {
        throw new Error("payment totals view produced incorrect values");
      }
    });

    const correctness = {
      first_page_rows: first.length,
      second_page_rows: second.length,
      no_adjacent_duplicates: true,
      search_narrowing: true,
      exact_per_tenant_cardinality: true,
      payment_view_totals: true,
      scm_tenant_scope: true,
      team_directory_cross_tenant_observed: true,
    };

    const expectedDetailRows = Math.floor((config.lines - 1) / config.orders) + 1;
    const expectedSummaryRows = Math.min(500, config.orders - Math.floor(config.orders / 5));
    const cases = [
      ["so:summary", () => run("so_summary", [1]), expectedSummaryRows, validateTenant(1)],
      ["so:list-first-page", () => run("so_list_page", [1, PAGE_SIZE, 0]), Math.min(PAGE_SIZE, config.orders), validateTenant(1)],
      ["so:list-deep-offset", () => run("so_list_page", [1, PAGE_SIZE, DEEP_OFFSET]), Math.min(PAGE_SIZE, config.orders - DEEP_OFFSET), validateTenant(1)],
      ["so:one-char-search", () => run("so_search_page", [1, "%C%", 6]), Math.min(6, config.orders), validateTenant(1)],
      ["so:money-page", () => run("so_money_page", [1, 0]), Math.min(1000, config.orders), validateTenant(1)],
      ["so:confirmed-count", () => run("so_status_count", [1, "CONFIRMED"]), 1, (rows) => {
        const expected = Math.floor((config.orders + 4) / 5);
        if (Number(rows[0]?.count) !== expected) throw new Error(`confirmed count mismatch; expected ${expected}`);
      }],
      ["so:detail-lines", () => run("so_detail_lines", [1, "C1-SO-2607-000001"]), expectedDetailRows, validateTenant(1)],
      ["products:first-page", () => run("products_page", [1, 0]), Math.min(1000, config.skus), validateTenant(1)],
      ["products:one-char-search", () => run("products_search", [1, "%C%"]), Math.min(1000, config.skus), validateTenant(1)],
      ["users:typeahead", () => run("users_typeahead", ["%User 00001%"]), 2, validateTeamDirectoryAcrossTenants(1)],
      // Deliberately mirrors GET /api/users with no q: the production route is
      // unbounded and not company-scoped, so this measures the full directory.
      ["users:full-list", () => run("users_full_list"), config.users * 2, validateTeamDirectoryAcrossTenants(config.users)],
    ];
    const benchmarks = [];
    for (const [name, query, expectedRows, validate] of cases) {
      benchmarks.push(await measure(name, query, expectedRows, validate));
    }
    const plans = {
      so_list_page: await sql.unsafe(`EXPLAIN (FORMAT JSON) ${PG_QUERY_SHAPES.so_list_page}`, [1, PAGE_SIZE, 0]),
      so_search_page: await sql.unsafe(`EXPLAIN (FORMAT JSON) ${PG_QUERY_SHAPES.so_search_page}`, [1, "%Customer 00001%", 6]),
      so_detail_lines: await sql.unsafe(`EXPLAIN (FORMAT JSON) ${PG_QUERY_SHAPES.so_detail_lines}`, [1, "C1-SO-2607-000001"]),
      products_search: await sql.unsafe(`EXPLAIN (FORMAT JSON) ${PG_QUERY_SHAPES.products_search}`, [1, "%SKU-00001%"]),
      users_typeahead: await sql.unsafe(`EXPLAIN (FORMAT JSON) ${PG_QUERY_SHAPES.users_typeahead}`, ["%User 00001%"]),
    };
    return {
      engine: "postgres-real-schema-contract",
      schema_contract: REAL_SCHEMA_CONTRACT_VERSION,
      isolation: "dedicated-local-empty-db + transaction rollback",
      counts: {
        per_tenant: { orders: config.orders, lines: config.lines, skus: config.skus, users: config.users },
        total: { orders: config.orders * 2, lines: config.lines * 2, skus: config.skus * 2, users: config.users * 2 },
      },
      plans,
      correctness,
      benchmarks,
    };
  } finally {
    let cleanupError;
    try {
      if (transactionOpen) {
        try {
          await sql.unsafe("ROLLBACK");
          transactionOpen = false;
        } catch (error) {
          cleanupError = error;
        }
      }
      // Deterministic teardown is part of the evidence, not an assumption.
      // Keep the peer lock until the clean-catalog assertion has completed.
      if (!cleanupError && sessionLockHeld) {
        assertDisposableCatalog(await readCatalogSnapshot(sql));
      }
    } finally {
      if (sessionLockHeld) {
        await sql.unsafe(
          "SELECT pg_advisory_unlock(hashtext('houzs-real-schema-scale-v1'))",
        ).catch(() => undefined);
      }
      await sql.end().catch(() => undefined);
    }
    if (cleanupError) throw cleanupError;
  }
}

const results = [];
if (config.engine === "sqlite" || config.engine === "both") {
  const harness = sqliteHarness();
  try {
    results.push({
      engine: harness.engine,
      counts: harness.counts,
      plans: harness.plans,
      correctness: harness.correctness(),
      benchmarks: await harness.benchmarks(),
    });
  } finally {
    harness.close();
  }
}
if (config.engine === "pg" || config.engine === "both") results.push(await postgresHarness());

const report = { generated_at: new Date().toISOString(), config, results };
console.log(JSON.stringify(report, null, 2));
if (config.json) await writeFile(config.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
