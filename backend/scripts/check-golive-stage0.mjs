// Read-only answers to three go-live stage-0 questions that only production can
// answer. Nothing here writes, and nothing here touches app_config.
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW
//
// Two of these questions were previously answered by READING MIGRATION FILES,
// which this repo has already been burned by once: docs/system-foundation-coe.md
// records money corruption "proven" from a migration and then refuted against the
// live database, and the lesson written down there is verify schema claims
// against the live DB, not migration files. scm.inventory_movements predates the
// migrations that enumerate its indexes, so the migration tree cannot be trusted
// to list them. The third question (who can write through the freeze) depends on
// live role and position rows, not on code.
//
// Actions already holds secrets.DATABASE_URL for the deploy, so the check runs
// there and no human handles the credential.
//
// Q1  Does scm.inventory_movements carry ANY unique index?
//     delivery-orders-mfg.ts asserted in a comment that "the existence check +
//     UNIQUE index mean this never double-deducts". If there is no unique index,
//     the guard is a bare TOCTOU check with no backstop.
//
//     ANSWERED 2026-08-11, run 31417585775: it DOES. uq_inv_mov_do_source is
//     live, partial on source_doc_type='DO', keyed (source_doc_type,
//     source_doc_id, product_code, variant_key). Migration 0230's comment
//     enumerating this table's indexes lists only the four non-unique ones and
//     is what makes the tree read as if none existed. This block stays so the
//     answer is re-checkable rather than remembered.
//
// Q2  Would a unique index over the natural DO movement bucket be creatable at
//     all — i.e. does the live table already contain duplicate rows in that
//     bucket? A unique index cannot be built over duplicates. The answer also
//     has to separate genuine double-deductions from the DELIBERATE extra rows
//     resyncInventoryForDo writes (delta OUT/IN in the same bucket, by design).
//
// Q3  How many live people can write through the SCM write freeze? Bypass is
//     permissions '*' or 'scm.admin' (scm/lib/write-freeze.ts BYPASS_PERMS), and
//     '*' can arrive from the ROLE grant or be injected by a god POSITION
//     (services/positionPolicy.ts GOD_POSITIONS -> services/auth.ts). Names, not
//     just a count, because the owner has to recognise the list.
//
// Every statement below is a SELECT. No DDL, no writes, no transaction. Exits 0
// for every legitimate answer - the ANSWER is the output, and a red job would
// read as "the check broke". Only an unreachable DB or a query error exits
// non-zero. Emails are deliberately NOT selected: a name plus role plus position
// identifies the person for the owner without putting address lists in a CI log.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const line = (msg) => console.log(msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // ── Q1 — every index on scm.inventory_movements, verbatim from the catalog ──
  const indexes = await pg`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'scm' AND tablename = 'inventory_movements'
     ORDER BY indexname`;

  // A UNIQUE table CONSTRAINT also materialises as an index, so pg_indexes alone
  // would catch it - but list constraints too so the answer is not resting on
  // one catalog view.
  const constraints = await pg`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS condef
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cls.relnamespace
     WHERE ns.nspname = 'scm' AND cls.relname = 'inventory_movements'
       AND con.contype IN ('u', 'p', 'x')
     ORDER BY con.conname`;

  line("");
  line("== Q1  scm.inventory_movements indexes (live pg_indexes) ==");
  for (const r of indexes) line(`  ${r.indexname}\n      ${r.indexdef}`);
  if (indexes.length === 0) line("  (none)");
  line("");
  line("   unique/primary/exclusion CONSTRAINTS:");
  for (const r of constraints) line(`  ${r.conname}: ${r.condef}`);
  if (constraints.length === 0) line("  (none)");

  // The surrogate PRIMARY KEY on `id` is a unique index and is USELESS as a
  // double-deduct backstop - every re-insert mints a fresh uuid. Only a unique
  // index over the BUSINESS key could stop a duplicate movement, so count those
  // separately or the verdict flatters itself.
  const uniqueIdx = indexes.filter((r) => /CREATE UNIQUE INDEX/i.test(r.indexdef));
  const businessUnique = uniqueIdx.filter((r) => !/\(\s*id\s*\)\s*$/i.test(r.indexdef));
  notice(
    businessUnique.length === 0
      ? `Q1 VERDICT: scm.inventory_movements has NO unique index over any business key ` +
        `(${uniqueIdx.length} unique index(es) total, all on the surrogate id). The DO deduction guard is an unbacked TOCTOU check.`
      : `Q1 VERDICT: ${businessUnique.length} business-key unique index(es) exist: ${businessUnique.map((r) => r.indexname).join(", ")}`,
  );

  // ── Q2 — duplicates in the natural DO bucket ────────────────────────────────
  // The bucket key is exactly what deductInventoryForDo collapses lines into:
  // (source_doc_type, source_doc_id, movement_type, warehouse_id, product_code,
  //  variant_key, batch_no). Anything with count > 1 blocks a unique index there.
  const dupDo = await pg`
    SELECT source_doc_id, movement_type, warehouse_id, product_code,
           COALESCE(variant_key, '') AS variant_key,
           COALESCE(batch_no, '')    AS batch_no,
           count(*)                  AS rows_in_bucket,
           sum(qty)                  AS total_qty,
           count(*) FILTER (WHERE notes ILIKE 'Resync%') AS resync_rows,
           min(created_at)           AS first_at,
           max(created_at)           AS last_at
      FROM scm.inventory_movements
     WHERE source_doc_type = 'DO'
     GROUP BY 1, 2, 3, 4, 5, 6
    HAVING count(*) > 1
     ORDER BY count(*) DESC, max(created_at) DESC
     LIMIT 50`;

  const dupDoTotals = await pg`
    SELECT count(*) AS dup_buckets, COALESCE(sum(extra), 0) AS extra_rows
      FROM (
        SELECT count(*) - 1 AS extra
          FROM scm.inventory_movements
         WHERE source_doc_type = 'DO'
         GROUP BY source_doc_id, movement_type, warehouse_id, product_code,
                  COALESCE(variant_key, ''), COALESCE(batch_no, '')
        HAVING count(*) > 1
      ) q`;

  // Same question for EVERY source_doc_type, because a table-wide unique index
  // would have to survive GRN / adjustment / transfer history too.
  const dupAllTotals = await pg`
    SELECT count(*) AS dup_buckets, COALESCE(sum(extra), 0) AS extra_rows
      FROM (
        SELECT count(*) - 1 AS extra
          FROM scm.inventory_movements
         GROUP BY COALESCE(source_doc_type, ''), COALESCE(source_doc_id::text, ''),
                  movement_type, warehouse_id, product_code,
                  COALESCE(variant_key, ''), COALESCE(batch_no, '')
        HAVING count(*) > 1
      ) q`;

  const scale = await pg`
    SELECT count(*) AS total_movements,
           count(*) FILTER (WHERE source_doc_type = 'DO') AS do_movements
      FROM scm.inventory_movements`;

  line("");
  line("== Q2  duplicate rows in the natural movement bucket ==");
  line(`  total movements: ${scale[0].total_movements} (DO-sourced: ${scale[0].do_movements})`);
  line(`  DO buckets with >1 row: ${dupDoTotals[0].dup_buckets}  (extra rows: ${dupDoTotals[0].extra_rows})`);
  line(`  ALL-source buckets with >1 row: ${dupAllTotals[0].dup_buckets}  (extra rows: ${dupAllTotals[0].extra_rows})`);
  if (dupDo.length > 0) {
    line("  top DO buckets (resync_rows = rows explained by resyncInventoryForDo deltas):");
    for (const r of dupDo) {
      line(
        `    do=${r.source_doc_id} ${r.movement_type} wh=${r.warehouse_id} sku=${r.product_code} ` +
          `vk='${r.variant_key}' batch='${r.batch_no}' rows=${r.rows_in_bucket} resync=${r.resync_rows} ` +
          `qty=${r.total_qty} first=${r.first_at} last=${r.last_at}`,
      );
    }
  }
  notice(
    Number(dupDoTotals[0].dup_buckets) === 0
      ? "Q2 VERDICT: zero duplicate DO buckets. A unique index over that key would be creatable today - but see the resync-delta note in the PR before adding one."
      : `Q2 VERDICT: ${dupDoTotals[0].dup_buckets} DO buckets hold more than one movement row (${dupDoTotals[0].extra_rows} extra rows). A unique index over that key CANNOT be created without resolving them first.`,
  );

  // ── Q2b — did a DO resync delta EVER land? ──────────────────────────────────
  // The live index uq_inv_mov_do_source is keyed (source_doc_type, source_doc_id,
  // product_code, variant_key) and is partial on source_doc_type='DO' - it does
  // NOT include movement_type, warehouse_id or batch_no. So ANY second row for a
  // (DO, product, variant) bucket is rejected, which is precisely what
  // resyncInventoryForDo tries to write when an operator edits a line qty on an
  // already-shipped DO. delivery-orders-mfg.ts claims the opposite ("Migration
  // 0109 dropped the per-bucket UNIQUE so we can freely write multiple delta
  // rows over time"). Count the rows the resync path stamps with its own note:
  // if edit-after-ship deltas were landing, they would be here.
  const resyncLanded = await pg`
    SELECT source_doc_type, movement_type, count(*) AS rows, min(created_at) AS first_at, max(created_at) AS last_at
      FROM scm.inventory_movements
     WHERE notes ILIKE 'Resync%'
     GROUP BY 1, 2
     ORDER BY count(*) DESC`;

  line("");
  line("== Q2b  movements written by the resync delta path (notes ILIKE 'Resync%') ==");
  for (const r of resyncLanded) {
    line(`    ${r.source_doc_type}/${r.movement_type}: ${r.rows} rows  first=${r.first_at}  last=${r.last_at}`);
  }
  if (resyncLanded.length === 0) line("    (none — no resync delta movement has ever landed)");

  // ── Q3 — who can write through the freeze ───────────────────────────────────
  // roles.permissions is a JSON string array (services/permissions.parsePermissions),
  // so membership is tested on the serialised token, which cannot partial-match
  // another permission key: '"*"' and '"scm.admin"' are whole quoted elements.
  const bypass = await pg`
    SELECT u.id,
           u.name,
           u.status,
           r.name AS role_name,
           p.name AS position_name,
           (r.permissions LIKE '%"*"%')         AS role_wildcard,
           (r.permissions LIKE '%"scm.admin"%') AS role_scm_admin,
           (lower(regexp_replace(COALESCE(p.name, ''), '[[:space:]]+', ' ', 'g'))
              IN ('super admin', 'owner'))      AS god_position
      FROM public.users u
      JOIN public.roles r     ON r.id = u.role_id
      LEFT JOIN public.positions p ON p.id = u.position_id
     WHERE u.status = 'active'
       AND (
         r.permissions LIKE '%"*"%'
         OR r.permissions LIKE '%"scm.admin"%'
         OR lower(regexp_replace(COALESCE(p.name, ''), '[[:space:]]+', ' ', 'g')) IN ('super admin', 'owner')
       )
     ORDER BY role_wildcard DESC, god_position DESC, r.name, u.name`;

  const activeUsers = await pg`SELECT count(*) AS n FROM public.users WHERE status = 'active'`;

  line("");
  line("== Q3  active accounts that BYPASS the SCM write freeze ==");
  line(`  active users total: ${activeUsers[0].n}`);
  for (const r of bypass) {
    const how = [
      r.role_wildcard ? "role '*'" : null,
      r.god_position ? "god POSITION -> '*'" : null,
      r.role_scm_admin ? "role 'scm.admin'" : null,
    ].filter(Boolean).join(" + ");
    line(`    #${r.id}  ${r.name ?? "(no name)"}  role=${r.role_name}  position=${r.position_name ?? "-"}  via ${how}`);
  }
  if (bypass.length === 0) line("    (none)");
  notice(
    `Q3 VERDICT: ${bypass.length} of ${activeUsers[0].n} active accounts can write to a frozen company ` +
      `(plus the non-human DASHBOARD_API_KEY service user, which holds '*' in code and is not in this table).`,
  );

  // ── Context — the freeze row itself. READ ONLY. Never written from here. ────
  const freeze = await pg`
    SELECT value, description, updated_at
      FROM scm.app_config
     WHERE key = 'scm.write_freeze'`;
  line("");
  line("== Context  scm.app_config['scm.write_freeze'] (read only) ==");
  if (freeze.length === 0) {
    line("  row ABSENT -> freeze is OFF");
  } else {
    line(`  value='${freeze[0].value}'  updated_at=${freeze[0].updated_at}`);
    line(`  description (this is the sentence staff are shown): ${freeze[0].description ?? "(null -> backend default)"}`);
  }

  process.exit(0);
} catch (e) {
  console.error("check-golive-stage0 failed:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
