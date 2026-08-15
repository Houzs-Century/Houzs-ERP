/* SPENT PROBE — kept for the record, not as a tool.
   
   This was a throwaway email-delivery probe.
   It answered its question at the time and nothing reaches it now: no npm
   script, no workflow, no doc, no import.
   
   It is read-only, so running it is not dangerous — but it probes an
   environment that has since moved, so what it prints is unlikely to mean
   what its output says it means. */
﻿import { readFileSync } from "node:fs";
import postgres from "postgres";
const url = readFileSync(".dev.vars","utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url,{ssl:"require",prepare:false,max:1});
const cols = await pg`SELECT column_name FROM information_schema.columns WHERE table_name='email_log' ORDER BY ordinal_position`;
console.log("email_log columns:", cols.map(c=>c.column_name).join(", "));
const log = await pg`SELECT purpose, status, error, provider_id, created_at FROM email_log ORDER BY id DESC LIMIT 6`;
console.log("recent email_log:");
for (const r of log) console.log("  ", r.purpose, "|", r.status, "| err:", (r.error||"-").slice(0,100), "| pid:", r.provider_id||"-", "|", r.created_at);
await pg.end();
