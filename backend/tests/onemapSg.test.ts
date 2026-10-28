import { describe, test, expect, beforeEach } from "vitest";
import {
  isValidSgPostcode,
  normalizeSearchResult,
  parsePlanningArea,
  addressLine1,
  lookupSgPostcode,
  __resetOneMapTokenCacheForTest,
  type SgAddress,
} from "../src/scm/lib/onemap-sg";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

const addr = (o: Partial<SgAddress>): SgAddress => ({
  postcode: "", building: "", blockNo: "", road: "", address: "", lat: "", lng: "", planningArea: "", ...o,
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
      planningArea: "",
    });
  });

  test("OneMap's literal NIL becomes empty", () => {
    const b = normalizeSearchResult({ POSTAL: "123456", BUILDING: "NIL", BLK_NO: "10", ROAD_NAME: "SOME ROAD" });
    expect(b.building).toBe("");
    expect(b.address).toBe("");
    expect(b.blockNo).toBe("10");
  });
});

describe("parsePlanningArea", () => {
  test("takes pln_area_n from the first element, uppercased", () => {
    expect(parsePlanningArea([{ pln_area_n: "Orchard", pln_area_c: "OR" }])).toBe("ORCHARD");
    expect(parsePlanningArea([{ pln_area_n: "BUKIT MERAH" }])).toBe("BUKIT MERAH");
  });
  test("degrades to empty on any non-conforming shape", () => {
    expect(parsePlanningArea([])).toBe("");                                  // point outside all areas
    expect(parsePlanningArea([{ "error message": "no pln_area found" }])).toBe(""); // error object
    expect(parsePlanningArea([{ pln_area_n: "NIL" }])).toBe("");             // OneMap's literal NIL
    expect(parsePlanningArea({ message: "Unauthorized" })).toBe("");         // not an array
    expect(parsePlanningArea(null)).toBe("");
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

  test("happy path: token, search, then planning area — normalized, filtered, enriched", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes("getToken")) {
        return jsonResponse({ access_token: "TKN", expiry_timestamp: String(Math.floor(Date.now() / 1000) + 100000) });
      }
      expect((init?.headers as Record<string, string>)?.authorization).toBe("TKN");
      if (String(url).includes("getPlanningarea")) {
        // the coords enriched are the FIRST result's, not the filtered-out row's
        expect(String(url)).toContain("latitude=1.30");
        expect(String(url)).toContain("longitude=103.83");
        return jsonResponse([{ pln_area_n: "Orchard", pln_area_c: "OR" }]);
      }
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
    expect(out.results[0].planningArea).toBe("ORCHARD");
    expect(calls.some((u) => u.includes("getToken"))).toBe(true);
    expect(calls.some((u) => u.includes("elastic/search"))).toBe(true);
    expect(calls.some((u) => u.includes("getPlanningarea"))).toBe(true);
  });

  test("a getPlanningarea failure still returns the address, planningArea empty", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("getToken")) {
        return jsonResponse({ access_token: "TKN", expiry_timestamp: String(Math.floor(Date.now() / 1000) + 100000) });
      }
      if (String(url).includes("getPlanningarea")) return jsonResponse({ message: "Unauthorized" }, false);
      return jsonResponse({
        results: [{ POSTAL: "238801", BUILDING: "ION ORCHARD", BLK_NO: "2", ROAD_NAME: "ORCHARD TURN", ADDRESS: "2 ORCHARD TURN ION ORCHARD SINGAPORE 238801", LATITUDE: "1.30", LONGITUDE: "103.83" }],
      });
    }) as unknown as typeof fetch;

    const out = await lookupSgPostcode({ email: "e", password: "p", fetchImpl }, "238801");
    expect(out.error).toBeUndefined();       // the address lookup did NOT fail
    expect(out.results).toHaveLength(1);
    expect(out.results[0].building).toBe("ION ORCHARD");
    expect(out.results[0].planningArea).toBe(""); // enrichment degraded silently
  });
});
