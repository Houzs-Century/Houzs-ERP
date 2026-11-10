import { test } from "node:test";
import assert from "node:assert/strict";
import { scanWorkflow, selfTest } from "./check-workflow-dump-artifacts.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("every built-in probe gives its expected verdict", () => {
  assert.deepEqual(selfTest(), []);
});

test("the 2026-11-09 staging refresh shape is refused", () => {
  const wf = [
    "jobs:",
    "  dump:",
    "    steps:",
    "      - run: gzip -1 prod-data.sql",
    "      - uses: actions/upload-artifact@v4",
    "        with:",
    "          name: prod-data",
    "          path: |",
    "            prod-data.sql.gz",
    "            prod-switches.txt",
    "          retention-days: 1",
  ].join("\n");
  const r = scanWorkflow(wf);
  assert.equal(r.uploads, 1);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].why, /prod-data\.sql\.gz/);
});

test("a sealed upload in the same job passes, one in another job does not", () => {
  const sealed = (sameJob) => [
    "jobs:",
    "  a:",
    "    steps:",
    "      - uses: ./.github/actions/seal-artifact",
    "        with:",
    "          mode: seal",
    "          paths: golive-backup/",
    ...(sameJob ? [] : ["  b:", "    steps:"]),
    "      - uses: actions/upload-artifact@v4",
    "        with:",
    "          name: golive-hc-backup-1",
    "          path: sealed/",
  ].join("\n");
  assert.equal(scanWorkflow(sealed(true)).findings.length, 0);
  assert.equal(scanWorkflow(sealed(false)).findings.length, 1);
});

const backupWf = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "nightly-db-backup.yml"),
  "utf8",
);

test("the nightly backup passes, and fails the moment its encryption step is removed", () => {
  const ok = scanWorkflow(backupWf);
  assert.equal(ok.bucketUploads, 1);
  assert.deepEqual(ok.findings, []);
  const unsealed = backupWf.replace(/\n      - name: Encrypt the dump[\s\S]*?(?=\n      - name: Upload)/, "");
  assert.notEqual(unsealed, backupWf);
  const bad = scanWorkflow(unsealed);
  assert.equal(bad.findings.length, 1);
  assert.match(bad.findings[0].why, /no encryption step before it/);
});

function configStepScript() {
  const lines = backupWf.split("\n");
  const at = lines.findIndex((l) => /^\s*id: cfg\s*$/.test(l));
  let r = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  const indent = lines[r].length - lines[r].trimStart().length;
  const body = [];
  for (r++; r < lines.length && (lines[r].trim() === "" || lines[r].length - lines[r].trimStart().length > indent); r++) body.push(lines[r]);
  return body.join("\n");
}

function runConfigStep(env) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "backup-cfg-"));
  const out = path.join(dir, "out");
  fs.writeFileSync(out, "");
  const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", configStepScript()], {
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, output: fs.readFileSync(out, "utf8") };
}

const ALL = {
  DATABASE_URL: "x", BACKUP_R2_ACCOUNT_ID: "x", BACKUP_R2_ACCESS_KEY_ID: "x",
  BACKUP_R2_SECRET_ACCESS_KEY: "x", BACKUP_R2_BUCKET: "x", BACKUP_PUBKEY: "x",
};

test("no secrets set: one notice naming what is missing, exit 0, every later step skipped", { skip: process.platform === "win32" }, () => {
  const r = runConfigStep({ DATABASE_URL: "x" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "::notice::backup not configured: BACKUP_R2_ACCOUNT_ID BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY BACKUP_R2_BUCKET BACKUP_PUBKEY missing");
  assert.equal(r.output.trim(), "configured=false");
  const later = backupWf.split("\n      - ").slice(2);
  assert.ok(later.length >= 6);
  for (const step of later) assert.match(step, /if: steps\.cfg\.outputs\.configured == 'true'/);
});

test("all secrets set: configured, nothing printed", { skip: process.platform === "win32" }, () => {
  const r = runConfigStep(ALL);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
  assert.equal(r.output.trim(), "configured=true");
});
