#!/usr/bin/env node
// Fails when a workflow uploads a database dump, backup or row export as an
// artifact without encrypting it first.
//
// WHY: this repository is PUBLIC. An artifact is listed to anyone and
// downloadable by any signed-in GitHub account. On 2026-11-09 the staging
// refresh was found uploading an UNMASKED production dump (prod-data.sql.gz,
// customers, money, staff password hashes) as an artifact on every run
// (docs/staging-dump-artifact-exposure-coe.md).
//
// RULE, per upload-artifact step: if its artifact NAME or any PATH looks like a
// dump / backup / export, then
//   1. an encryption step must come EARLIER in the same job
//      (./.github/actions/seal-artifact with mode: seal, or openssl enc /
//      pkeyutl -encrypt, gpg --encrypt, age -r), AND
//   2. every uploaded path must be ciphertext: under sealed/, or ending
//      .enc / .gpg / .age.
// Any upload of sealed/ also needs the seal step before it, so plaintext cannot
// be copied into that folder and pass.
//
// The same holds for a BUCKET upload (aws s3 cp/sync, s3api put-object, rclone,
// wrangler r2 object put, s3cmd, mc) in a job that runs pg_dump/mysqldump, or
// whose command line names a dump-shaped file: an encryption step must come
// earlier in the job, and no dump-shaped token on the line may be plaintext.
// A bucket is outside this repo, but a leaked R2/S3 key is all it then takes
// (nightly-db-backup.yml). A source held in a shell variable cannot be read
// from here, so for that shape the check proves only that encryption ran
// first; the workflow itself refuses to upload anything not ending .enc.
//
// The only escape is a VISIBLE marker inside the step, with a reason:
//   # dump-artifact-ok: <why this holds no rows>
// e.g. a schema-only dump. A marker without a reason is refused.
//
// Self-tests its own patterns at startup and refuses to report from a dead
// matcher; a scan that finds zero upload steps is a failure, not a pass.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DUMP_SHAPE = [
  /\.(sql|dump|pgdump|bak|csv|tsv)(\.gz|\.zip|\.xz)?(\b|$)/i,
  /(^|[\/_.\-*])(backups?|dumps?|snapshots?|exports?)([\/_.\-*]|$)/i,
];
const CIPHERTEXT = /(^|\/)sealed(\/|$)|\.(enc|gpg|age)$/i;
const ENCRYPT_STEP = [
  /uses:\s*\.\/\.github\/actions\/seal-artifact[\s\S]*?mode:\s*seal\b/,
  /openssl\s+enc\b(?![^\n]*\s-d\b)/,
  /pkeyutl\s+-encrypt/,
  /gpg\s+[^\n]*(--encrypt|\s-e\b|--symmetric|\s-c\b)/,
  /\bage\s+[^\n]*(-r\b|--recipient|-p\b|--passphrase)/,
];
const BUCKET_UPLOAD = /\baws\s+s3\s+(cp|mv|sync)\b|\baws\s+s3api\s+(put-object|upload-part)\b|\brclone\s+(copy|copyto|move|moveto|sync|rcat)\b|\bwrangler\s+r2\s+object\s+put\b|\bs3cmd\s+(put|sync)\b|\bmc\s+(cp|mirror)\b/;
const DB_DUMP = /\b(pg_dump|pg_dumpall|mysqldump|mongodump)\b/;
const MARKER = /#[ \t]*dump-artifact-ok:[ \t]*(\S.*)?$/m;

const indentOf = (l) => l.length - l.trimStart().length;
export const looksLikeDump = (s) => DUMP_SHAPE.some((re) => re.test(s));

export function scanWorkflow(text) {
  const lines = text.split("\n");
  const findings = [];
  let uploads = 0;
  for (let k = 0; k < lines.length; k++) {
    if (!/uses:\s*actions\/upload-artifact@/.test(lines[k])) continue;
    uploads++;
    let s = k;
    while (s > 0 && !/^\s*-\s/.test(lines[s])) s--;
    const dash = indentOf(lines[s]);
    let e = s + 1;
    while (e < lines.length && (lines[e].trim() === "" || indentOf(lines[e]) > dash)) e++;
    let j = s - 1;
    while (j >= 0 && !(/^\s*steps:\s*$/.test(lines[j]) && indentOf(lines[j]) < dash)) j--;
    const step = lines.slice(s, e).join("\n");
    const before = lines.slice(j + 1, s).join("\n");
    const paths = [];
    let name = "";
    let inWith = false;
    for (let i = s; i < e; i++) {
      const m = lines[i].match(/^(\s*)path:\s*(.*)$/);
      if (m) {
        const v = m[2].trim();
        if (v === "|" || v === ">") {
          let n = i + 1;
          while (n < e && (lines[n].trim() === "" || indentOf(lines[n]) > m[1].length)) {
            if (lines[n].trim()) paths.push(lines[n].trim());
            n++;
          }
        } else paths.push(v.replace(/^['"]|['"]$/g, ""));
      }
      if (/^\s*with:\s*$/.test(lines[i])) inWith = true;
      const nm = lines[i].match(/^\s*name:\s*(.*)$/);
      if (nm && inWith) name = nm[1].trim();
    }
    const marker = step.match(MARKER);
    if (marker) {
      if (!marker[1]) findings.push({ line: s + 1, why: "dump-artifact-ok marker has no reason" });
      continue;
    }
    const encrypted = ENCRYPT_STEP.some((re) => re.test(before));
    const dumpish = looksLikeDump(name) || paths.some(looksLikeDump);
    const sealedPath = paths.some((p) => /(^|\/)sealed(\/|$)/.test(p));
    if (sealedPath && !encrypted) {
      findings.push({ line: s + 1, why: `uploads sealed/ with no encryption step before it in the job` });
      continue;
    }
    if (!dumpish) continue;
    if (!encrypted) {
      findings.push({ line: s + 1, why: `uploads dump-shaped artifact (${[name, ...paths].filter(Boolean).join(", ")}) with no encryption step before it` });
      continue;
    }
    const plain = paths.filter((p) => !CIPHERTEXT.test(p));
    if (plain.length) findings.push({ line: s + 1, why: `encrypts, but still uploads plaintext path(s): ${plain.join(", ")}` });
  }
  let bucketUploads = 0;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (line.trim().startsWith("#") || !BUCKET_UPLOAD.test(line)) continue;
    bucketUploads++;
    let j = k - 1;
    while (j >= 0 && !(/^\s*steps:\s*$/.test(lines[j]) && indentOf(lines[j]) < indentOf(line))) j--;
    const stepsIndent = j >= 0 ? indentOf(lines[j]) : -1;
    let end = k + 1;
    while (end < lines.length && (lines[end].trim() === "" || indentOf(lines[end]) > stepsIndent)) end++;
    const job = lines.slice(j + 1, end).join("\n");
    const before = lines.slice(j + 1, k).join("\n");
    const tokens = line.trim().split(/\s+/).map((t) => t.replace(/^['"]+|['"]+$/g, ""));
    const dumpTokens = tokens.filter(looksLikeDump);
    if (!DB_DUMP.test(job) && !dumpTokens.length) continue;
    if (!ENCRYPT_STEP.some((re) => re.test(before))) {
      findings.push({ line: k + 1, why: `uploads to a bucket in a job that dumps a database, with no encryption step before it` });
      continue;
    }
    const plain = dumpTokens.filter((t) => !CIPHERTEXT.test(t));
    if (plain.length) findings.push({ line: k + 1, why: `encrypts, but the bucket upload names plaintext: ${plain.join(", ")}` });
  }
  return { uploads, bucketUploads, findings };
}

const PROBES = [
  ["the 2026-11-09 staging refresh upload", 1, `
jobs:
  dump:
    steps:
      - run: pg_dump "$DATABASE_URL" --file=prod-data.sql && gzip -1 prod-data.sql
      - uses: actions/upload-artifact@v4
        with:
          name: prod-data
          path: |
            prod-data.sql.gz
            prod-switches.txt
          retention-days: 1
`],
  ["a backup directory, no encryption", 1, `
jobs:
  wipe:
    steps:
      - run: node wipe.mjs
      - name: Upload backup
        uses: actions/upload-artifact@v4
        with:
          name: golive-hc-backup-1
          path: golive-backup/
`],
  ["a sealed backup", 0, `
jobs:
  wipe:
    steps:
      - name: Seal
        uses: ./.github/actions/seal-artifact
        with:
          mode: seal
          paths: golive-backup/
      - name: Upload backup
        uses: actions/upload-artifact@v4
        with:
          name: golive-hc-backup-1
          path: sealed/
`],
  ["sealed/ with no seal step", 1, `
jobs:
  x:
    steps:
      - run: cp -r golive-backup sealed
      - uses: actions/upload-artifact@v4
        with:
          name: out
          path: sealed/
`],
  ["encrypted, but plaintext also uploaded", 1, `
jobs:
  x:
    steps:
      - run: openssl enc -aes-256-cbc -pass file:k -in a.dump -out a.dump.enc
      - uses: actions/upload-artifact@v4
        with:
          name: snap
          path: |
            a.dump.enc
            a.dump
`],
  ["local-dev-snapshot shape", 0, `
jobs:
  snapshot:
    steps:
      - run: |
          openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:data.key -in masked.dump -out masked.dump.enc
      - uses: actions/upload-artifact@v4
        with:
          name: local-dev-snapshot
          path: |
            masked.dump.enc
            data.key.enc
`],
  ["a csv export", 1, `
jobs:
  x:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: report
          path: backend/out/customers.csv
`],
  ["a marker with a reason", 0, `
jobs:
  x:
    steps:
      - uses: actions/upload-artifact@v4
        # dump-artifact-ok: schema only, no rows
        with:
          name: scm-schema
          path: out/*.sql
`],
  ["a marker with no reason", 1, `
jobs:
  x:
    steps:
      - uses: actions/upload-artifact@v4
        # dump-artifact-ok:
        with:
          name: scm-schema
          path: out/*.sql
`],
  ["an ordinary test report", 0, `
jobs:
  x:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: frontend/e2e/playwright-report/
`],
  ["encryption in ANOTHER job does not count", 1, `
jobs:
  a:
    steps:
      - run: openssl enc -aes-256-cbc -in x -out x.enc
  b:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: po-dump-1
          path: po-dump/
`],
  ["bucket: pg_dump then a plaintext upload to R2", 1, `
jobs:
  backup:
    steps:
      - run: pg_dump "$DATABASE_URL" -Fc -f db.dump
      - run: aws s3 cp db.dump s3://bucket/db.dump --endpoint-url "$E"
`],
  ["bucket: pg_dump, seal, upload the ciphertext", 0, `
jobs:
  backup:
    steps:
      - run: pg_dump "$DATABASE_URL" -Fc -f backup/db.dump
      - uses: ./.github/actions/seal-artifact
        with:
          mode: seal
          paths: backup/
      - run: |
          for f in sealed/*.enc; do
            aws s3 cp "$f" "s3://$B/nightly/$(basename "$f")" --endpoint-url "$E"
          done
`],
  ["bucket: encrypted, but the plaintext is uploaded too", 1, `
jobs:
  backup:
    steps:
      - run: pg_dump "$DATABASE_URL" -Fc -f db.dump && openssl enc -aes-256-cbc -pass file:k -in db.dump -out db.dump.enc
      - run: rclone copy db.dump r2:bucket/
`],
  ["bucket: encryption AFTER the upload does not count", 1, `
jobs:
  backup:
    steps:
      - run: pg_dump "$DATABASE_URL" -Fc -f db.dump
      - run: aws s3api put-object --bucket b --key k --body "$F"
      - run: openssl enc -aes-256-cbc -pass file:k -in db.dump -out db.dump.enc
`],
  ["bucket: a dump-shaped file with no pg_dump in the job", 1, `
jobs:
  x:
    steps:
      - run: npx wrangler r2 object put files/prod.sql.gz --file prod.sql.gz
`],
  ["bucket: an ordinary static-asset upload", 0, `
jobs:
  site:
    steps:
      - run: aws s3 sync frontend/dist s3://site/ --delete
`],
];

export function selfTest() {
  const bad = [];
  for (const [label, want, text] of PROBES) {
    const { uploads, bucketUploads, findings } = scanWorkflow(text);
    if (uploads + bucketUploads !== 1 || findings.length !== want) bad.push(`${label}: expected ${want} finding(s), got ${findings.length} (uploads seen ${uploads + bucketUploads})`);
  }
  return bad;
}

function main() {
  const dead = selfTest();
  if (dead.length) {
    console.error("check-workflow-dump-artifacts: self-test FAILED, refusing to report from a broken matcher:");
    console.error(dead.map((d) => `  ${d}`).join("\n"));
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = path.join(root, ".github", "workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  let uploads = 0;
  let bucketUploads = 0;
  const out = [];
  for (const f of files) {
    const r = scanWorkflow(fs.readFileSync(path.join(dir, f), "utf8"));
    uploads += r.uploads;
    bucketUploads += r.bucketUploads;
    for (const x of r.findings) out.push(`  .github/workflows/${f}:${x.line}  ${x.why}`);
  }
  console.log(`check-workflow-dump-artifacts: ${files.length} workflows, ${uploads} upload-artifact steps, ${bucketUploads} bucket uploads, ${PROBES.length} self-test probes passed`);
  if (uploads === 0) {
    console.error("no upload-artifact step found at all - the scan matched nothing, refusing to call that a pass");
    process.exit(2);
  }
  if (out.length) {
    console.error(`\n${out.length} upload(s) would publish database rows. This repository is public: anyone can download an artifact.`);
    console.error(out.join("\n"));
    console.error("\nEncrypt with ./.github/actions/seal-artifact (mode: check early, mode: seal before upload) and upload sealed/ only.");
    process.exit(1);
  }
  console.log("no unencrypted dump, backup or export is uploaded as an artifact or to a bucket");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
