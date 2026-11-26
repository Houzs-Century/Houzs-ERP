import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, redactUrl, summarize } from "./verify-probe.mjs";

test("parseArgs reads url, repeated clicks, out and wait", () => {
  assert.deepEqual(parseArgs(["http://localhost:5173/x", "--click", "#a", "--click", "text=Save", "--out", "d", "--wait-ms", "50"]), {
    url: "http://localhost:5173/x",
    out: "d",
    clicks: ["#a", "text=Save"],
    waitMs: 50,
  });
  assert.equal(parseArgs(["u"]).waitMs, 5000);
});

test("parseArgs rejects missing url, unknown flag, missing value, bad wait", () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["u", "--nope"]), /unknown flag/);
  assert.throws(() => parseArgs(["u", "--click"]), /missing its value/);
  assert.throws(() => parseArgs(["u", "--wait-ms", "x"]), /wait-ms/);
  assert.throws(() => parseArgs(["u", "v"]), /unexpected/);
});

test("redactUrl strips query string and fragment", () => {
  assert.equal(redactUrl("https://h.dev/api/x?token=abc&so=1#f"), "https://h.dev/api/x");
  assert.equal(redactUrl("file:///C:/tmp/p.html?q=1"), "file:///C:/tmp/p.html");
  assert.equal(redactUrl("data:text/html,<p>secret</p>"), "data:<redacted>");
  assert.equal(redactUrl("/rel?x=1"), "/rel");
});

test("summarize counts page errors, console errors, 5xx and failed requests, not warnings or 4xx", () => {
  const clean = summarize({ console: [{ type: "warning" }], network: [{ status: 404 }], pageErrors: [] });
  assert.equal(clean.verdict, "PROBE OK");
  assert.equal(clean.exitCode, 0);
  const bad = summarize({ console: [{ type: "error" }, { type: "warning" }], network: [], pageErrors: [{ message: "x" }] });
  assert.equal(bad.verdict, "PROBE ERRORS 2");
  const net = summarize({ console: [], network: [{ status: 500 }, { failure: "net::ERR_FAILED" }, { status: 404 }], pageErrors: [] });
  assert.equal(net.verdict, "PROBE ERRORS 2");
  assert.equal(bad.exitCode, 1);
  assert.match(bad.text, /console errors: 1, warnings: 1/);
});
