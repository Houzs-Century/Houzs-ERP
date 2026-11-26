import postgres, { type Sql } from "postgres";

const bigintAsNumber = {
  to: 20,
  from: [20],
  parse: (x: string) => Number(x),
  serialize: (x: number | string) => String(x),
};

export function isHyperdriveUrl(databaseUrl: string): boolean {
  return /hyperdrive\.local|\.workers\.alt[:/]/i.test(databaseUrl);
}

/**
 * Returns a fresh postgres.js client for the given connection URL.
 *
 * Detects a Hyperdrive-backed URL by its host (see isHyperdriveUrl). In prod
 * the Worker reads `c.env.HYPERDRIVE.connectionString`; locally it reads the
 * direct Supabase pooler URL from `c.env.DATABASE_URL`.
 */
export function getSql(databaseUrl: string): Sql {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL / HYPERDRIVE.connectionString is empty. " +
        "Set DATABASE_URL in .dev.vars (local) or bind HYPERDRIVE (prod).",
    );
  }

  const isHyperdrive = isHyperdriveUrl(databaseUrl);

  return isHyperdrive
    ? postgres(databaseUrl, {
        max: 1,
        prepare: false,
        fetch_types: false,
        idle_timeout: 0,
        types: { bigint: bigintAsNumber },
      })
    : postgres(databaseUrl, {
        ssl: "verify-full",
        prepare: false,
        max: 1,
        idle_timeout: 20,
        connect_timeout: 10,
        fetch_types: false,
        types: { bigint: bigintAsNumber },
      });
}

/** Resolve the live connection string from the Worker env, prod or local.
 *  DATABASE_URL wins when present — an explicit empty string means "no
 *  Postgres" (vitest pins it to keep the suite on its isolated D1 even
 *  though the wrangler.toml hyperdrive binding exists). Prod sets neither
 *  var and falls through to the Hyperdrive binding. */
export function resolveDatabaseUrl(env: {
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
}): string {
  return env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? "";
}
