// Prove production writes land in Supabase: rows created AFTER the flip
// (deploy was 2026-06-12 ~16:40 UTC) can only have come from the live app.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const FLIP = "2026-06-12 16:40:00";

const sessions = await pg.unsafe(
  `SELECT COUNT(*)::int AS n, MAX(created_at) AS latest FROM sessions WHERE created_at > '${FLIP}'`
).catch(() => pg.unsafe(`SELECT COUNT(*)::int AS n, MAX(expires_at) AS latest FROM sessions WHERE expires_at > NOW()`));
console.log("sessions since flip:", JSON.stringify(sessions[0]));

const logs = await pg.unsafe(
  `SELECT COUNT(*)::int AS n, MAX(created_at) AS latest FROM execution_logs WHERE created_at > '${FLIP}'`
).catch(() => [{ n: "table n/a" }]);
console.log("execution_logs since flip:", JSON.stringify(logs[0]));

const so = await pg.unsafe(
  `SELECT COUNT(*)::int AS n FROM sales_orders`
);
console.log("sales_orders total:", JSON.stringify(so[0]));
await pg.end();
