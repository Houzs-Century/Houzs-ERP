#!/usr/bin/env node
// Deliberate violation, pushed to watch the gate turn the JOB red and then
// reverted in the next commit. A gate nobody has seen fail in CI is a gate
// nobody knows is wired up.
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
await sql`UPDATE scm.mfg_sales_order_items SET variants = '{}'::jsonb WHERE variants IS NULL`;
await sql.end();
