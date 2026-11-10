import { test } from "node:test";
import assert from "node:assert/strict";
import { scanWorkflow, selfTest } from "./check-workflow-dump-artifacts.mjs";

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
