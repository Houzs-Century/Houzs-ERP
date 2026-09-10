// ----------------------------------------------------------------------------
// The public share links' brute-force cap counts GUESSES, not visits.
//
// Owner 2026-09-09 ("CURRENTLY ALL LINK CANNOT ACCESS"): every request from one
// address — page load, the minute poll, an event tap, an export — counted
// toward 300 per 15 minutes, so an office with a few tabs open locked every
// link out of its own address for 15 minutes at a time. A valid token is not
// a guess. Pinned here, through the REAL routers, with a fake KV standing in
// for SESSION_CACHE:
//
//   · N requests with a valid link leave the counter at 0
//   · an unknown link is 404 AND counts
//   · once the counter is at the cap, even a valid link is 429 (the cap still
//     protects the token space from a guesser on the same address)
//
// Proved RED on the unfixed tree: the first test failed with the counter at 5.
// ----------------------------------------------------------------------------
import { describe, expect, test, beforeEach } from "vitest";
import { publicContractorCalendar } from "../src/routes/publicContractorCalendar";
import { publicBrandCalendar } from "../src/routes/publicBrandCalendar";
import type { Env } from "../src/types";

const C_TOKEN = "abcdefghijklmnopqrstuvwx012345_-";
const B_TOKEN = "AKEMIakemiAKEMIakemiAKEMIakemi01";
const WRONG = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

type Row = Record<string, unknown>;
let kv: Map<string, string>;

function run(sql: string, args: unknown[]): Row[] {
  const m = /(?:FROM|INTO)\s+([a-z_]+)/i.exec(sql);
  const table = m ? m[1] : "?";
  if (table === "contractor_share_tokens") return args[0] === C_TOKEN ? [{ contractor: "DREAM ART (M) SDN BHD", revoked_at: null }] : [];
  if (table === "brand_share_tokens") return args[0] === B_TOKEN ? [{ brand: "AKEMI", revoked_at: null }] : [];
  if (table === "projects") return [];
  if (table === "project_contractors") return [{ share_export_scope: "month" }];
  throw new Error(`unexpected table ${table}`);
}

function fakeEnv(): Env {
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => run(sql, args)[0] ?? null,
        all: async () => ({ results: run(sql, args) }),
      }),
    }),
  };
  const SESSION_CACHE = {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => {
      kv.set(k, v);
    },
    delete: async (k: string) => {
      kv.delete(k);
    },
  };
  return { DB, SESSION_CACHE } as unknown as Env;
}

const IP = "203.0.113.7";
const counter = (bucket: string) => Number(kv.get(`rl:${bucket}:${IP.replace(/[^a-zA-Z0-9._@:-]/g, "_")}`) ?? "0");
const hit = (app: typeof publicContractorCalendar, path: string) =>
  app.request(path, { headers: { "CF-Connecting-IP": IP } }, fakeEnv());

describe("public share links: the cap counts guesses, not visits", () => {
  beforeEach(() => {
    kv = new Map();
  });

  test("contractor: 5 valid loads leave the counter at 0; a wrong link is 404 and counts", async () => {
    for (let i = 0; i < 5; i++) expect((await hit(publicContractorCalendar, `/${C_TOKEN}`)).status).toBe(200);
    expect(counter("contractor_share_read")).toBe(0);
    expect((await hit(publicContractorCalendar, `/${WRONG}`)).status).toBe(404);
    expect(counter("contractor_share_read")).toBe(1);
  });

  test("brand: the same rule, its own bucket", async () => {
    for (let i = 0; i < 5; i++) expect((await hit(publicBrandCalendar, `/${B_TOKEN}`)).status).toBe(200);
    expect(counter("brand_share_read")).toBe(0);
    expect((await hit(publicBrandCalendar, `/${WRONG}`)).status).toBe(404);
    expect(counter("brand_share_read")).toBe(1);
    expect(counter("contractor_share_read")).toBe(0);
  });

  test("at the cap, even a valid link is 429 until the window expires", async () => {
    kv.set(`rl:contractor_share_read:${IP}`, "300");
    const res = await hit(publicContractorCalendar, `/${C_TOKEN}`);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { retryAfterSec: number }).retryAfterSec).toBe(900);
  });
});
