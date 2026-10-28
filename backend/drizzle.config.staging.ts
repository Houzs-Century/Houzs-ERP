import type { Config } from "drizzle-kit";
import { readFileSync } from "node:fs";
const url = readFileSync(".dev.vars.staging", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
if (!url.includes("minnapsemfzjmtvnnvdd")) throw new Error("SAFETY: not the staging DB url");
export default {
  schema: "./src/db/schema.pg.ts",
  out: "./src/db/migrations-pg",
  dialect: "postgresql",
  dbCredentials: { url },
} satisfies Config;
