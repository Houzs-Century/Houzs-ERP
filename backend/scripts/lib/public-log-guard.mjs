// ---------------------------------------------------------------------------
// public-log-guard.mjs — keep money out of GitHub Actions output.
//
// This repository is PUBLIC. Anyone can open an Actions run page and read its
// log, and an uploaded artifact is downloadable by anyone with read access to
// the repository, which on a public repository is every signed-in GitHub user
// (REST docs, "Download an artifact" / "List artifacts": "Anyone with read
// access to the repository can use this endpoint"). So neither the log nor an
// artifact is a private place for a unit cost or a document total.
//
// Found 2026-11-10: "Backfill FIFO ledger divergence (repair)" printed unit
// costs in RM and in sen on dry-run (runs 42654976164, 42655293840), and ~150
// other dispatchable scripts format money into their output.
//
// Importing this module FIRST in a script (`import "./lib/public-log-guard.mjs";`)
// wraps process.stdout/stderr, console.table and writes to the job summary
// ($GITHUB_STEP_SUMMARY) so that, when running inside
// GitHub Actions, every money-looking value is replaced before it is written.
// Run locally (no GITHUB_ACTIONS), output is untouched, so an operator with
// database access still sees the figures on their own machine.
//
// It changes OUTPUT only. Nothing a script writes to a database passes through
// here. `check-public-log-money.mjs` fails CI when a dispatched script formats
// money without importing this guard.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { redactMoney, redactRow, selfTest } from "./public-log-redact.mjs";

export function guardActive(env = process.env) {
  return env.GITHUB_ACTIONS === "true" || env.HOUZS_PUBLIC_LOG === "1";
}

let installed = false;
export function installPublicLogGuard() {
  if (installed) return;
  selfTest();
  installed = true;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, encoding, cb) => {
      if (typeof chunk === "string") return write(redactMoney(chunk), encoding, cb);
      if (chunk instanceof Uint8Array) return write(redactMoney(Buffer.from(chunk).toString("utf8")), encoding, cb);
      return write(chunk, encoding, cb);
    };
  }
  const table = console.table.bind(console);
  console.table = (data, columns) => table(redactRow(data), columns);
  // The job summary is rendered on the public run page too.
  const isSummary = (file) => typeof file === "string" && Boolean(process.env.GITHUB_STEP_SUMMARY) && resolve(file) === resolve(process.env.GITHUB_STEP_SUMMARY);
  for (const name of ["appendFileSync", "writeFileSync"]) {
    const original = fs[name];
    fs[name] = (file, data, ...rest) => original(file, isSummary(file) && (typeof data === "string" || data instanceof Uint8Array) ? redactMoney(typeof data === "string" ? data : Buffer.from(data).toString("utf8")) : data, ...rest);
  }
  syncBuiltinESMExports();
}

if (guardActive()) installPublicLogGuard();
