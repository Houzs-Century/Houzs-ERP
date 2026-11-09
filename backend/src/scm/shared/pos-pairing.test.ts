import { describe, expect, test } from "vitest";
import { PAIRING_ALPHABET, formatPairingCode, isPairingCode, mintPairingCode, normalizePairingCode, pairingCodeFromUrl, pairingCodeHash, pairingCodeLive } from "./pos-pairing";

describe("pairing code", () => {
  test("a code is live until its expiry, whatever text form the database hands back", () => {
    const now = Date.parse("2026-11-09T02:09:00.000Z");
    expect(pairingCodeLive("2026-11-09 02:14:45.665+00", now)).toBe(true);
    expect(pairingCodeLive("2026-11-09T02:14:45.665Z", now)).toBe(true);
    expect(pairingCodeLive("2026-11-09 02:08:59+00", now)).toBe(false);
    expect(pairingCodeLive("2026-11-09T02:08:59.000Z", now)).toBe(false);
    expect(pairingCodeLive(null, now)).toBe(false);
    expect(pairingCodeLive("garbage", now)).toBe(false);
  });
  test("minted codes are 8 characters of the unambiguous alphabet and differ", () => {
    const a = mintPairingCode();
    const b = mintPairingCode();
    expect(a).toHaveLength(8);
    expect(a.split("").every((ch) => PAIRING_ALPHABET.includes(ch))).toBe(true);
    expect(a).not.toBe(b);
    expect(PAIRING_ALPHABET).not.toMatch(/[0O1I]/);
  });
  test("typing is forgiving: case, dash and spaces are ignored; the hash is over the normalized code", async () => {
    expect(normalizePairingCode(" h7k2-9qpd ")).toBe("H7K29QPD");
    expect(formatPairingCode("h7k29qpd")).toBe("H7K2-9QPD");
    expect(isPairingCode("H7K2-9QPD")).toBe(true);
    expect(isPairingCode("H7K2-9QP")).toBe(false);
    expect(await pairingCodeHash("h7k2-9qpd")).toBe(await pairingCodeHash("H7K29QPD"));
    expect(await pairingCodeHash("H7K29QPD")).not.toBe(await pairingCodeHash("H7K29QPE"));
  });
  test("the link carries the code", () => {
    expect(pairingCodeFromUrl("https://pos.houzscentury.com/?pair=H7K2-9QPD")).toBe("H7K29QPD");
    expect(pairingCodeFromUrl("https://pos.houzscentury.com/")).toBeNull();
    expect(pairingCodeFromUrl("https://pos.houzscentury.com/?pair=short")).toBeNull();
  });
});
