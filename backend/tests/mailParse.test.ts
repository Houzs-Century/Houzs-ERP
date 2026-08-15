/* The five inbound-email parsing helpers, which had NO test while they sat
   inline in routes/mail-center.ts.

   They were lifted out to shrink that file under its size ceiling, and this file
   is what makes "moved verbatim, behaviour unchanged" a checked claim instead of
   an assurance. Each case below is a property the mail ingest already depended
   on; if a future edit to mail-parse.ts breaks one, the ingest breaks with it.

   Every input here is ATTACKER-CONTROLLED — these run on whatever arrives at the
   inbound webhook — so the cases lean on the malformed side. */
import { test } from "vitest";
import assert from "node:assert/strict";

import { toArray, stripHtml, safeIso, base64ToBytes, safeFilename } from "../src/services/mail-parse";

test("toArray: absent, array, and the two header delimiters", () => {
  assert.deepEqual(toArray(undefined), []);
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray(""), []);
  assert.deepEqual(toArray(["  a@x.my ", "", "b@x.my"]), ["a@x.my", "b@x.my"]);
  // RFC address headers use commas; References uses whitespace. Both, and mixed.
  assert.deepEqual(toArray("a@x.my, b@x.my"), ["a@x.my", "b@x.my"]);
  assert.deepEqual(toArray("<id1@x> <id2@x>"), ["<id1@x>", "<id2@x>"]);
  assert.deepEqual(toArray("a@x.my,\n  b@x.my"), ["a@x.my", "b@x.my"]);
});

test("stripHtml: style blocks go entirely, tags become spaces, entities collapse", () => {
  assert.equal(stripHtml("<p>Hello</p>"), "Hello");
  // A <style> body must not survive as text — this is why it is stripped whole
  // rather than tag-by-tag.
  assert.equal(stripHtml("<style>p{color:red}</style><p>Hi</p>"), "Hi");
  assert.equal(stripHtml("a&nbsp;&nbsp;b"), "a b");
  assert.equal(stripHtml("<div>  a  </div>\n<div>b</div>"), "a b");
  assert.equal(stripHtml(""), "");
});

test("safeIso: a malformed date header falls back rather than becoming Invalid Date", () => {
  const fb = "2026-01-01T00:00:00.000Z";
  assert.equal(safeIso(undefined, fb), fb);
  assert.equal(safeIso("", fb), fb);
  assert.equal(safeIso("not a date", fb), fb);
  assert.equal(safeIso("2026-08-15T10:20:30.000Z", fb), "2026-08-15T10:20:30.000Z");
  // An RFC-2822 header, which is what actually arrives.
  assert.equal(safeIso("Fri, 15 Aug 2026 10:20:30 +0000", fb), "2026-08-15T10:20:30.000Z");
});

test("base64ToBytes: standard, base64url, wrapped — and null rather than a throw", () => {
  const bytes = (s: string) => Array.from(base64ToBytes(s) ?? []);
  assert.deepEqual(bytes("SGk="), [72, 105]);            // "Hi"
  assert.deepEqual(bytes("SGk=\r\n"), [72, 105]);        // wrapped by the sender
  assert.deepEqual(bytes("S G k ="), [72, 105]);         // stray whitespace
  // base64url: - and _ stand in for + and /
  assert.deepEqual(bytes("-_8="), Array.from(base64ToBytes("+/8=") ?? []));
  assert.deepEqual(bytes(""), []);
  /* Returning null — not throwing — is the property the ingest relies on: one
     bad attachment must never abort the whole email. */
  assert.equal(base64ToBytes("!!!not base64!!!"), null);
});

test("safeFilename: no path traversal reaches the R2 key, and the length is bounded", () => {
  assert.equal(safeFilename("invoice.pdf"), "invoice.pdf");
  // Path segments are stripped, both separators — this is the traversal guard.
  assert.equal(safeFilename("../../etc/passwd"), "passwd");
  assert.equal(safeFilename("C:\\Users\\x\\report.xlsx"), "report.xlsx");
  assert.equal(safeFilename("发票 2026.pdf"), "2026.pdf");
  assert.equal(safeFilename(undefined), "file");
  assert.equal(safeFilename(""), "file");
  // Nothing usable left after cleaning still yields a key, never an empty one.
  assert.equal(safeFilename("///"), "file");
  assert.equal(safeFilename("!!!"), "file");
  assert.equal(safeFilename("a".repeat(200)).length, 120);
});
