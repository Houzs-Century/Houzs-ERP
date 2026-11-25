import { test } from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { deliveredToList } from "./envelope.mjs";

const mail = (headers) =>
  simpleParser(`${headers}\r\nFrom: a@gmail.com\r\nTo: zaim@houzscentury.com\r\nSubject: t\r\n\r\nbody\r\n`);

test("catch-all mail routes to the address the sender used, not hello@", async () => {
  const parsed = await mail(
    "Delivered-To: hello@houzscentury.com\r\nX-Gm-Original-To: zaim@houzscentury.com",
  );
  assert.deepEqual(deliveredToList(parsed), ["zaim@houzscentury.com", "hello@houzscentury.com"]);
});

test("alias mail without the catch-all header is unchanged", async () => {
  const parsed = await mail("Delivered-To: sales@houzscentury.com");
  assert.deepEqual(deliveredToList(parsed), ["sales@houzscentury.com"]);
});
