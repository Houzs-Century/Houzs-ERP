export const LOCAL_SCALE_ACK = "I_UNDERSTAND_THIS_IS_A_DISPOSABLE_LOCAL_DATABASE";
export const LOCAL_SCALE_DATABASE = "houzs_scale_test";
export const LOCAL_SCALE_DATABASE_MARKER = "HOUZS_DISPOSABLE_LOCAL_SCALE_V1";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PROTECTED_RELATIONS = [
  "public.companies",
  "public.roles",
  "public.departments",
  "public.positions",
  "public.users",
  "public.user_brands",
  "public.user_departments",
  "public.user_companies",
  "public._pg_migrations",
  "scm.mfg_sales_orders",
  "scm.mfg_products",
];

/**
 * The scale harness is intentionally local-only. An allow-listed staging host
 * is still a live shared environment and is therefore not a safe load target.
 */
export function assertPgTarget(
  url,
  acknowledgement = process.env.PERF_LOCAL_ACK,
) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("PERF_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("PERF_DATABASE_URL must use postgres:// or postgresql://.");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      "Refusing every non-local PostgreSQL target, including staging and production.",
    );
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (database !== LOCAL_SCALE_DATABASE) {
    throw new Error(
      `Refusing local database ${database || "(empty)"}; use the dedicated ${LOCAL_SCALE_DATABASE} database.`,
    );
  }
  if (acknowledgement !== LOCAL_SCALE_ACK) {
    throw new Error(`Set PERF_LOCAL_ACK=${LOCAL_SCALE_ACK} to run the scale load.`);
  }
  return { database };
}

/**
 * Second, server-authoritative guard. This runs before BEGIN/DDL and refuses a
 * migrated/live-looking catalogue even if somebody tunnels it through localhost
 * or gives it the expected URL path.
 */
export function assertDisposableCatalog(snapshot) {
  if (snapshot.database_name !== LOCAL_SCALE_DATABASE) {
    throw new Error(`Connected database is ${snapshot.database_name}, not ${LOCAL_SCALE_DATABASE}.`);
  }
  if (snapshot.database_marker !== LOCAL_SCALE_DATABASE_MARKER) {
    throw new Error(
      `Database ${LOCAL_SCALE_DATABASE} is missing the required disposable-local marker.`,
    );
  }
  const present = PROTECTED_RELATIONS.filter((name) => snapshot.relations[name] === true);
  if (
    snapshot.scm_schema_exists || present.length > 0 ||
    Number(snapshot.user_relation_count) > 0 || Number(snapshot.custom_schema_count) > 0
  ) {
    throw new Error(
      `Refusing a non-empty, migrated or live-looking database (${present.join(", ") || "user schema/relation present"}).`,
    );
  }
}

export async function readCatalogSnapshot(sql) {
  const rows = await sql.unsafe(`
    SELECT current_database() AS database_name,
           (SELECT shobj_description(d.oid, 'pg_database')
              FROM pg_database d
             WHERE d.datname = current_database()) AS database_marker,
           EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'scm') AS scm_schema_exists,
           (SELECT count(*)::integer
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
               AND n.nspname <> 'information_schema'
               AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')) AS user_relation_count,
           (SELECT count(*)::integer
              FROM pg_namespace
             WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
               AND nspname NOT IN ('information_schema', 'public')) AS custom_schema_count,
           to_regclass('public.companies') IS NOT NULL AS public_companies,
           to_regclass('public.roles') IS NOT NULL AS public_roles,
           to_regclass('public.departments') IS NOT NULL AS public_departments,
           to_regclass('public.positions') IS NOT NULL AS public_positions,
           to_regclass('public.users') IS NOT NULL AS public_users,
           to_regclass('public.user_brands') IS NOT NULL AS public_user_brands,
           to_regclass('public.user_departments') IS NOT NULL AS public_user_departments,
           to_regclass('public.user_companies') IS NOT NULL AS public_user_companies,
           to_regclass('public._pg_migrations') IS NOT NULL AS public_migrations,
           to_regclass('scm.mfg_sales_orders') IS NOT NULL AS scm_orders,
           to_regclass('scm.mfg_products') IS NOT NULL AS scm_products
  `);
  const row = rows[0] ?? {};
  return {
    database_name: String(row.database_name ?? ""),
    database_marker: String(row.database_marker ?? ""),
    scm_schema_exists: row.scm_schema_exists === true,
    user_relation_count: Number(row.user_relation_count ?? 0),
    custom_schema_count: Number(row.custom_schema_count ?? 0),
    relations: {
      "public.companies": row.public_companies === true,
      "public.roles": row.public_roles === true,
      "public.departments": row.public_departments === true,
      "public.positions": row.public_positions === true,
      "public.users": row.public_users === true,
      "public.user_brands": row.public_user_brands === true,
      "public.user_departments": row.public_user_departments === true,
      "public.user_companies": row.public_user_companies === true,
      "public._pg_migrations": row.public_migrations === true,
      "scm.mfg_sales_orders": row.scm_orders === true,
      "scm.mfg_products": row.scm_products === true,
    },
  };
}
