import { describe, expect, test } from "vitest";
import { isSealedTotpSecret, openTotpSecret, sealTotpSecret } from "../src/services/totpSecret";

/* Sealing two-step secrets at rest (sister-ERP gap review BE7, 2026-11-10).
   The key is optional by design: unset, everything behaves as it did before. */
const KEY = { TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") };
const OTHER_KEY = { TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64") };
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

describe("sealTotpSecret / openTotpSecret", () => {
  test("with the key, the stored value is sealed and opens back for the same user", async () => {
    const stored = await sealTotpSecret(KEY, 7, SECRET);
    expect(isSealedTotpSecret(stored)).toBe(true);
    expect(stored).not.toContain(SECRET);
    expect(await openTotpSecret(KEY, 7, stored)).toBe(SECRET);
  });

  test("two seals of one secret differ (fresh IV each time)", async () => {
    expect(await sealTotpSecret(KEY, 7, SECRET)).not.toBe(await sealTotpSecret(KEY, 7, SECRET));
  });

  test("a sealed value does not open for another user, under another key, or with no key", async () => {
    const stored = await sealTotpSecret(KEY, 7, SECRET);
    expect(await openTotpSecret(KEY, 8, stored)).toBeNull();
    expect(await openTotpSecret(OTHER_KEY, 7, stored)).toBeNull();
    expect(await openTotpSecret({}, 7, stored)).toBeNull();
  });

  test("without the key (or with a malformed one) nothing changes: plain in, plain out", async () => {
    expect(await sealTotpSecret({}, 7, SECRET)).toBe(SECRET);
    expect(await sealTotpSecret({ TOTP_ENCRYPTION_KEY: "too-short" }, 7, SECRET)).toBe(SECRET);
    expect(await openTotpSecret({}, 7, SECRET)).toBe(SECRET);
    expect(await openTotpSecret(KEY, 7, SECRET)).toBe(SECRET);
  });
});
