/* SPENT PROBE — kept for the record, not as a tool.
   
   This was the second throwaway email-delivery probe.
   It answered its question at the time and nothing reaches it now: no npm
   script, no workflow, no doc, no import.
   
   It is read-only, so running it is not dangerous — but it probes an
   environment that has since moved, so what it prints is unlikely to mean
   what its output says it means. */
﻿import { readFileSync } from "node:fs";
import postgres from "postgres";
const url = readFileSync(".dev.vars","utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url,{ssl:"require",prepare:false,max:1});
const log = await pg`SELECT purpose, status, error, provider_id, created_at FROM email_log WHERE purpose='password_reset' ORDER BY id DESC LIMIT 3`;
console.log("latest password_reset email_log:");
for (const r of log) console.log("  ", r.status, "| err:", (r.error||"-").slice(0,80), "| pid:", r.provider_id||"-", "|", r.created_at);
await pg.end();
