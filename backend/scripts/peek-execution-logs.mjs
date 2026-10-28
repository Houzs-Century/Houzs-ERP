import { readFileSync } from "node:fs";
import postgres from "postgres";
const url = readFileSync(".dev.vars","utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url,{ssl:"require",prepare:false,max:1});
const cols = await pg.unsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='execution_logs' ORDER BY ordinal_position`);
console.log("columns:", cols.map(c=>c.column_name).join(", "));
const latest = await pg.unsafe(`SELECT * FROM execution_logs ORDER BY id DESC LIMIT 3`);
console.log("latest rows:", JSON.stringify(latest, null, 1).slice(0, 1200));
await pg.end();
