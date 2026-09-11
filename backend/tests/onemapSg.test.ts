import { describe, test, expect, beforeEach } from "vitest";
import {
  isValidSgPostcode,
  normalizeSearchResult,
  addressLine1,
  lookupSgPostcode,
  __resetOneMapTokenCacheForTest,
  type SgAddress,
} from "../src/scm/lib/onemap-sg";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

const addr = (o: Partial<SgAddress>): SgAddress => ({
  postcode: "", building: "", blockNo: "", road: "", address: "", lat: "", lng: "", ...o,
});

beforeEach(() => __resetOneMapTokenCacheForTest());

describe("isValidSgPostcode", () => {
  test("exactly six digits, trimmed", () => {
    expect(isValidSgPostcode("238801")).toBe(true);
    expect(isValidSgPostcode(" 018956 ")).toBe(true);
    expect(isValidSgPostcode("23880")).toBe(false);
    expect(isValidSgPostcode("2388011")).toBe(false);
    expect(isValidSgPostcode("23880A")).toBe(false);
    expect(isValidSgPostcode("")).toBe(false);
  });
});

describe("normalizeSearchResult", () => {
  test("maps the OneMap columns", () => {
    const a = normalizeSearchResult({
      POSTAL: "238801", BUILDING: "ION ORCHARD", BLK_NO: "2",
      ROAD_NAME: "ORCHARD TURN", ADDRESS: "2 ORCHARD TURN ION ORCHARD SINGAPORE 238801",
      LATITUDE: "1.3039", LONGITUDE: "103.8320",
    });
    expect(a).toEqual({
      postcode: "238801", building: "ION ORCHARD", blockNo: "2", road: "ORCHARD TURN",
      address: "2 ORCHARD TURN ION ORCHARD SINGAPORE 238801", lat: "1.3039", lng: "103.8320",
    });
  });

  test("OneMap's literal NIL becomes empty", () => {
    const b = normalizeSearchResult({ POSTAL: "123456", BUILDING: "NIL", BLK_NO: "10", ROAD_NAME: "SOME ROAD" });
    expect(b.building).toBe("");
    expect(b.address).toBe("");
    expect(b.blockNo).toBe("10");
  });
});

describe("addressLine1", () => {
  test("block+road, then building, then formatted address", () => {
    expect(addressLine1(addr({ blockNo: "2", road: "ORCHARD TURN", building: "ION" }))).toBe("2 ORCHARD TURN");
    expect(addressLine1(addr({ building: "ION ORCHARD" }))).toBe("ION ORCHARD");
    expect(addressLine1(addr({ address: "10 BAYFRONT AVENUE" }))).toBe("10 BAYFRONT AVENUE");
  });
});

describe("lookupSgPostcode", () => {
  test("inert (configured:false) when credentials are absent — no fetch", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return jsonResponse({}); }) as unknown as typeof fetch;
    const out = await lookupSgPostcode({ fetchImpl }, "238801");
    expect(out).toEqual({ configured: false, results: [] });
    expect(called).toBe(false);
  });

  test("invalid postcode never reaches the network", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return jsonResponse({}); }) as unknown as typeof fetch;
    const out = await lookupSgPostcode({ email: "e", password: "p", fetchImpl }, "23");
    expect(out).toEqual({ configured: true, results: [], error: "invalid_postcode" });
    expect(called).toBe(false);
  });

  test("a token failure surfaces as auth_failed", async () => {
    const fetchImpl = (async (url: string) =>
      String(url).includes("getToken") ? jsonResponse({}, false) : jsonResponse({})
    ) as unknown as typeof fetch;
    const out = await lookupSgPostcode({ email: "e", password: "p", fetchImpl }, "238801");
    expect(out.error).toBe("auth_failed");
    expect(out.results).toEqual([]);
  });

  test("happy path: token then search, normalized + filtered to the exact postcode", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes("getToken")) {
        return jsonResponse({ access_token: "TKN", expiry_timestamp: String(Math.floor(Date.now() / 1000) + 100000) });
      }
      expect((init?.headers as Record<string, string>)?.authorization).toBe("TKN");
      return jsonResponse({
        results: [
          { POSTAL: "238801", BUILDING: "ION ORCHARD", BLK_NO: "2", ROAD_NAME: "ORCHARD TURN", ADDRESS: "2 ORCHARD TURN ION ORCHARD SINGAPORE 238801", LATITUDE: "1.30", LONGITUDE: "103.83" },
          { POSTAL: "999999", BUILDING: "SOMEWHERE ELSE" },
        ],
      });
    }) as unknown as typeof fetch;

    const out = await lookupSgPostcode({ email: "e", password: "p", fetchImpl }, "238801");
    expect(out.configured).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.results).toHaveLength(1);
    expect(out.results[0].building).toBe("ION ORCHARD");
    expect(addressLine1(out.results[0])).toBe("2 ORCHARD TURN");
    expect(calls.some((u) => u.includes("getToken"))).toBe(true);
    expect(calls.some((u) => u.includes("elastic/search"))).toBe(true);
  });
});
