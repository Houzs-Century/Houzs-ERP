import assert from "node:assert/strict";
import { test } from 'vitest';
import {
  LOCAL_SCALE_ACK,
  LOCAL_SCALE_DATABASE,
  LOCAL_SCALE_DATABASE_MARKER,
  assertDisposableCatalog,
  assertPgTarget,
  readCatalogSnapshot,
} from "../scripts/scale-target-guard.mjs";

const emptyCatalog = () => ({
  database_name: LOCAL_SCALE_DATABASE,
  database_marker: LOCAL_SCALE_DATABASE_MARKER,
  scm_schema_exists: false,
  user_relation_count: 0,
  custom_schema_count: 0,
  relations: {},
});

for (const url of [
  `postgres://user:pass@localhost/${LOCAL_SCALE_DATABASE}`,
  `postgresql://user:pass@127.0.0.1/${LOCAL_SCALE_DATABASE}`,
  `postgres://user:pass@[::1]/${LOCAL_SCALE_DATABASE}`,
]) {
  test(`accepts only the dedicated loopback database with acknowledgement: ${url}`, () => {
    assert.deepEqual(assertPgTarget(url, LOCAL_SCALE_ACK), { database: LOCAL_SCALE_DATABASE });
    assert.throws(() => assertPgTarget(url), /PERF_LOCAL_ACK/);
  });
}

for (const url of [
  "postgres://postgres:pass@db.minnapsemfzjmtvnnvdd.supabase.co/postgres",
  "postgres://postgres.minnapsemfzjmtvnnvdd:pass@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
  "postgres://postgres:pass@db.anogrigyjbduyzclzjgn.supabase.co/postgres",
  "postgres://postgres.anogrigyjbduyzclzjgn:pass@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
  "postgres://review:pass@example.invalid/houzs_scale_test",
  "postgres://review:pass@localhost.evil/houzs_scale_test",
]) {
  test(`refuses every remote target, including staging and production: ${url}`, () => {
    assert.throws(() => assertPgTarget(url, LOCAL_SCALE_ACK), /non-local PostgreSQL target/);
  });
}

for (const url of [
  "postgres://user:pass@localhost/postgres",
  "postgres://user:pass@localhost/houzs",
  "postgres://user:pass@localhost/houzs_scale_test_copy",
]) {
  test(`refuses a loopback connection to any non-dedicated database: ${url}`, () => {
    assert.throws(() => assertPgTarget(url, LOCAL_SCALE_ACK), /dedicated houzs_scale_test/);
  });
}

test("rejects malformed and non-PostgreSQL URLs", () => {
  assert.throws(() => assertPgTarget("not a url", LOCAL_SCALE_ACK), /valid PostgreSQL URL/);
  assert.throws(() => assertPgTarget("https://localhost/houzs_scale_test", LOCAL_SCALE_ACK), /must use postgres/);
});

test("accepts an empty catalogue and rejects migrated/live-looking state", () => {
  assert.doesNotThrow(() => assertDisposableCatalog(emptyCatalog()));
  assert.throws(() => assertDisposableCatalog({ ...emptyCatalog(), database_name: "postgres" }), /Connected database/);
  assert.throws(() => assertDisposableCatalog({ ...emptyCatalog(), database_marker: "" }), /disposable-local marker/);
  assert.throws(() => assertDisposableCatalog({ ...emptyCatalog(), database_marker: "copied-production" }), /disposable-local marker/);
  assert.throws(() => assertDisposableCatalog({ ...emptyCatalog(), scm_schema_exists: true }), /live-looking/);
  assert.throws(() => assertDisposableCatalog({ ...emptyCatalog(), user_relation_count: 1 }), /non-empty/);
  assert.throws(() => assertDisposableCatalog({ ...emptyCatalog(), custom_schema_count: 1 }), /non-empty/);
  assert.throws(() => assertDisposableCatalog({
    ...emptyCatalog(),
    relations: { "public.users": true, "scm.mfg_sales_orders": true },
  }), /public\.users, scm\.mfg_sales_orders/);
});

test("normalizes the server-authoritative catalogue probe", async () => {
  const sql = {
    unsafe: async () => [{
      database_name: LOCAL_SCALE_DATABASE,
      database_marker: LOCAL_SCALE_DATABASE_MARKER,
      scm_schema_exists: false,
      user_relation_count: 1,
      custom_schema_count: 0,
      public_companies: false,
      public_roles: false,
      public_departments: false,
      public_positions: false,
      public_users: true,
      public_user_brands: false,
      public_user_departments: false,
      public_user_companies: false,
      public_migrations: false,
      scm_orders: false,
      scm_products: false,
    }],
  };
  const snapshot = await readCatalogSnapshot(sql);
  assert.equal(snapshot.database_name, LOCAL_SCALE_DATABASE);
  assert.equal(snapshot.database_marker, LOCAL_SCALE_DATABASE_MARKER);
  assert.equal(snapshot.user_relation_count, 1);
  assert.equal(snapshot.relations["public.users"], true);
  assert.throws(() => assertDisposableCatalog(snapshot), /public\.users/);
});
