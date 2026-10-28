#!/usr/bin/env node
// Read-only report on the bind-shadow soak — the merge gate for PR-4 (the
// DO-time live-allocator flip, Decision 2026-08-06 "soft until DO, hard from
// DO", docs/modules/purchase-order.md §Decision).
//
// WHY THIS EXISTS. Stage 2 runs the live allocator in SHADOW inside
// resolveShipCommitments (backend/src/scm/routes/delivery-orders-mfg.ts): it
// computes the pick it WOULD bind beside the stored-link resolution and binds
// nothing. Its divergences originally went only to the Worker console —
// wrangler tail, ephemeral — so the flip gate had nothing reviewable. The
// evidence PR persists them as BIND_SHADOW rows in scm.entity_audit_log:
//
//   status_snapshot 'SUMMARY'    — one per ship-path resolution (the
//                                  denominator): field_changes carries
//                                  lines_compared / diverged (+ any sofa
//                                  whole-set picks).
//   status_snapshot 'DIVERGENCE' — one per diverging line: field_changes[0] is
//                                  { field: '<itemCode> [<variantKey>]',
//                                    from: stored-link PO, to: allocator PO }.
//
// This script reads those rows back and answers "what does the shadow soak
// look like?" without anyone opening a SQL console (CLAUDE.md: never ask the
// owner to run a query). NOTE the denominator counts ship-path RESOLUTIONS,
// not distinct DOs — a short-stock 409 followed by a confirmed retry is two
// resolutions, and that is fine: the question is how often the two engines
// disagree, per comparison.
//
// THE VERDICT IS NOT THE GATE. A clean report is NECESSARY for the flip, not
// sufficient: the flip PR stays DRAFT until (a) this picture is reviewed and
// (b) the owner signs off. Zero SUMMARY rows is its own outcome — either
// nothing shipped since the evidence PR deployed, or it is not deployed — and
// must never be read as "clean" (the check-soak-gate.mjs zero-rows lesson:
// missing evidence is a different answer from good evidence).
//
// Strictly read-only: single SELECT statements, no DDL, no writes, no
// transaction. Exits 0 for every legitimate answer — the ANSWER is the
// output; non-zero only for an unreachable database or a query error.
//
// Mirrors backend/scripts/check-soak-gate.mjs and its workflow
// .github/workflows/bind-shadow-check.yml.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs / check-soak-gate.mjs: env wins so
// CI needs no .dev.vars.
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

// `notice` surfaces the verdict on the workflow run's summary page, so the
// answer is readable without opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const windowDays = Math.max(1, Number(process.env.WINDOW_DAYS) || 30);

// Row ceiling on the raw read. PostgREST is not in this path (plain postgres),
// but an unbounded read of an append-only log is still the mistake nobody
// notices until the book is large. If the cap is hit the report says so — a
// clipped window is a different answer from a small one.
const ROW_CAP = 20000;

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const rows = await pg`
    SELECT status_snapshot, field_changes, note, entity_doc_no, company_id, created_at
    FROM scm.entity_audit_log
    WHERE action = 'BIND_SHADOW'
      AND created_at >= now() - make_interval(days => ${windowDays}::int)
    ORDER BY created_at DESC
    LIMIT ${ROW_CAP}`;

  const clipped = rows.length === ROW_CAP;
  const summaries = rows.filter((r) => r.status_snapshot === "SUMMARY");
  const divergences = rows.filter((r) => r.status_snapshot === "DIVERGENCE");

  if (rows.length === 0) {
    notice(`NO SHADOW EVIDENCE in the last ${windowDays} day(s) — zero BIND_SHADOW rows.`);
    notice(
      "Missing evidence is NOT a clean soak. Either no ship-path resolution has " +
        "run since the evidence PR deployed, or that PR is not deployed. The " +
        "flip gate cannot be evaluated; do not merge PR-4 on this reading.",
    );
  } else {
    // Per-day picture: resolutions, lines compared, diverged — from the
    // SUMMARY rows' structured field_changes.
    const fc = (row, name) => {
      const arr = Array.isArray(row.field_changes) ? row.field_changes : [];
      const hit = arr.find((f) => f && f.field === name);
      return hit ? Number(hit.to ?? 0) : 0;
    };
    const days = new Map(); // 'YYYY-MM-DD' -> { resolutions, compared, diverged }
    for (const s of summaries) {
      const day = new Date(s.created_at).toISOString().slice(0, 10);
      const cur = days.get(day) ?? { resolutions: 0, compared: 0, diverged: 0 };
      cur.resolutions += 1;
      cur.compared += fc(s, "lines_compared");
      cur.diverged += fc(s, "diverged");
      days.set(day, cur);
    }
    console.log(`Per-day shadow picture (last ${windowDays} day(s), newest first):`);
    console.log("  day         resolutions  lines_compared  diverged");
    for (const [day, d] of [...days.entries()].sort().reverse()) {
      console.log(
        `  ${day}  ${String(d.resolutions).padStart(11)}  ${String(d.compared).padStart(14)}  ${String(d.diverged).padStart(8)}`,
      );
    }

    // The specific diverging pairs, deduplicated with counts — this is the
    // list the flip review actually reads.
    const pairs = new Map(); // '<bucket> stored -> allocator' -> { count, lastSeen, doc }
    for (const d of divergences) {
      const arr = Array.isArray(d.field_changes) ? d.field_changes : [];
      const f = arr[0] ?? {};
      const key = `${f.field ?? "?"}  stored=${f.from ?? "none"} -> allocator=${f.to ?? "none"}`;
      const cur = pairs.get(key) ?? { count: 0, lastSeen: null, doc: null };
      cur.count += 1;
      if (!cur.lastSeen) {
        cur.lastSeen = new Date(d.created_at).toISOString();
        cur.doc = d.entity_doc_no ?? null;
      }
      pairs.set(key, cur);
    }
    if (pairs.size > 0) {
      console.log("");
      console.log("Diverging (itemCode [variantKey], stored vs allocator) pairs:");
      for (const [key, p] of [...pairs.entries()].sort((a, b) => b[1].count - a[1].count)) {
        console.log(
          `  x${String(p.count).padStart(3)}  ${key}  (last ${p.lastSeen}${p.doc ? `, DO ${p.doc}` : ""})`,
        );
      }
    }

    const totCompared = summaries.reduce((n, s) => n + fc(s, "lines_compared"), 0);
    const totDiverged = summaries.reduce((n, s) => n + fc(s, "diverged"), 0);

    if (clipped) {
      notice(
        `WINDOW CLIPPED at ${ROW_CAP} rows — the numbers below understate the window. ` +
          "Narrow WINDOW_DAYS and re-run before reading a verdict.",
      );
    }
    if (summaries.length === 0) {
      // Divergence rows without summaries should be impossible (the summary is
      // written in the same block) — say so rather than divide by zero.
      notice(
        `INCONSISTENT EVIDENCE — ${divergences.length} divergence row(s) but zero SUMMARY rows. ` +
          "Investigate the writer before reading a verdict.",
      );
    } else if (totDiverged === 0) {
      notice(
        `CLEAN SO FAR — ${summaries.length} resolution(s), ${totCompared} line(s) compared, ` +
          `0 divergences in ${windowDays} day(s). Whether that soak is LONG and BUSY enough ` +
          "is the reviewer's call, then the owner's sign-off — the flip PR (PR-4) stays DRAFT until both.",
      );
    } else {
      notice(
        `DIVERGENCES PRESENT — ${totDiverged} diverged of ${totCompared} line(s) compared ` +
          `across ${summaries.length} resolution(s) in ${windowDays} day(s). Review each pair above ` +
          "(the log lists them): an allocator pick that is RIGHT where the stored link is stale is " +
          "the expected shape; anything else blocks the flip. Do not merge PR-4 until reviewed and owner-signed.",
      );
    }
  }
} finally {
  await pg.end({ timeout: 5 });
}
