#!/usr/bin/env node
// probe-db-latency.mjs — READ ONLY. How long one round trip to the database takes
// from the script runner, sequential and pipelined, so a bulk import can be sized
// (Houzs 31/08 opening, 2026-10-28). Writes nothing. Env: DATABASE_URL.
import postgres from 'postgres';

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql`SELECT 1`;
    let t = Date.now();
    for (let i = 0; i < 50; i++) await sql`SELECT ${i}::int AS n`;
    console.log(`ROW|sequential: ${((Date.now() - t) / 50).toFixed(1)} ms per round trip`);
    t = Date.now();
    await sql.begin(async (tx) => { for (let i = 0; i < 50; i++) await tx`SELECT ${i}::int AS n`; });
    console.log(`ROW|sequential in a transaction: ${((Date.now() - t) / 50).toFixed(1)} ms per round trip`);
    t = Date.now();
    await sql.begin(async (tx) => Promise.all(Array.from({ length: 200 }, (_, i) => tx`SELECT ${i}::int AS n`)));
    console.log(`ROW|pipelined in a transaction: ${((Date.now() - t) / 200).toFixed(1)} ms per query (200)`);
    const r = await sql`SELECT inet_server_addr()::text AS host, current_setting('server_version') AS v`;
    console.log(`ROW|server ${r[0].v}`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
