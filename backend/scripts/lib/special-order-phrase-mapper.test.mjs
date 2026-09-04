/**
 * node --test backend/scripts/lib/special-order-phrase-mapper.test.mjs
 *
 * Zero dependencies, so it runs on a bare checkout.
 *
 * WHAT THIS PINS. The rules below used to live inside
 * `backfill-specials-into-variants.mjs`, which has already been APPLIED to
 * production (prod run 33517835461: 442 lines stamped, 338 held back). Moving
 * them into a module so a second script can share them is only safe if the
 * classification is unchanged — a family that stopped matching would move lines
 * silently between "stamped" and "held back", and neither script would notice.
 * These cases are taken from that run's own output.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  K, asArray, buildLiveIndex, classifyLine, loadPhraseMap, phrasesOf, variantsShape,
} from "./special-order-phrase-mapper.mjs";

const MAP = loadPhraseMap();

/** The live picker master, in the shape the script reads it, with the prices
 *  production carried on 2026-09-01 (run 33517835461's own dump). */
const ADDONS = [
  { code: "HB Fully Cover", label: null, categories: ["BEDFRAME"], selling_price_sen: 5000, cost_price_sen: 5000 },
  { code: "HB Straight", label: null, categories: ["BEDFRAME"], selling_price_sen: 0, cost_price_sen: 0 },
  { code: "Front Drawer", label: null, categories: ["BEDFRAME"], selling_price_sen: 13000, cost_price_sen: 13000 },
  { code: "No Side Panel", label: null, categories: ["BEDFRAME"], selling_price_sen: -4000, cost_price_sen: -4000 },
  { code: "Nylon Fabric", label: null, categories: ["SOFA"], selling_price_sen: 0, cost_price_sen: 0 },
  { code: "5540 Backrest", label: null, categories: ["SOFA"], selling_price_sen: 5000, cost_price_sen: 5000 },
];
const { liveByCat, isPriced } = buildLiveIndex(ADDONS);

const line = (over) => ({ grp: "bedframe", code: "TRION (A)-(K)", d2: "", variants: {}, ...over });

test("a slip phrase becomes the LIVE picker code", () => {
  const r = classifyLine(line({ d2: "HB DO STRAIGHT" }), MAP, liveByCat);
  assert.deepEqual(r.addedNow, ["HB Straight"]);
  assert.equal(r.cat, "BEDFRAME");
});

test("a code the line already carries is not added twice", () => {
  const r = classifyLine(
    line({ d2: "HB DO STRAIGHT", variants: { specials: ["HB Straight"] } }), MAP, liveByCat);
  assert.deepEqual(r.addedNow, []);
  assert.deepEqual(r.had, ["HB Straight"]);
});

test("MERGE ONLY — next is always a superset of had", () => {
  const r = classifyLine(
    line({ d2: "HB DO STRAIGHT", variants: { specials: ["Front Drawer"] } }), MAP, liveByCat);
  for (const c of r.had) assert.ok(r.next.includes(c), `${c} was dropped`);
  assert.ok(r.next.length > r.had.length);
});

test("the HOOKKA-compatible singular `special` counts as already carried", () => {
  const r = classifyLine(
    line({ d2: "HB DO STRAIGHT", variants: { special: "HB Straight" } }), MAP, liveByCat);
  assert.deepEqual(r.addedNow, []);
});

test("nylon and umbrella are one owner code, on the SOFA side", () => {
  const r = classifyLine(
    { grp: "sofa", code: "BOOQIT-1A(LHF)", d2: "BOTTOM USE UMBRELLA FABRIC", variants: {} },
    MAP, liveByCat);
  assert.deepEqual(r.addedNow, ["Nylon Fabric"]);
});

test("a family whose code is NOT live is never invented", () => {
  const { liveByCat: thin } = buildLiveIndex([
    { code: "HB Straight", label: null, categories: ["BEDFRAME"], selling_price_sen: 0, cost_price_sen: 0 },
  ]);
  const r = classifyLine(line({ d2: "FRONT DRAWER" }), MAP, thin);
  assert.deepEqual(r.addedNow, []);
  assert.ok(r.unmapped.length > 0, "the phrase is reported, not silently dropped");
});

test("an owner-excluded phrase is reported as excluded, never as unmapped", () => {
  const r = classifyLine(
    { grp: "sofa", code: "BOOQIT-1A(LHF)", d2: "LEG CHANGE ALTAY LEG GROSSY BLACK LEG", variants: {} },
    MAP, liveByCat);
  assert.deepEqual(r.addedNow, []);
  assert.equal(r.unmapped.length, 0);
  assert.ok(r.excludedHits.length > 0);
});

test("priced-ness comes from the live read, so it can change without a code change", () => {
  assert.equal(isPriced("HB Fully Cover"), true);
  assert.equal(isPriced("HB Straight"), false);
  // a NEGATIVE price is still priced — [No Side Panel] is -4000
  assert.equal(isPriced("No Side Panel"), true);
  const { isPriced: laterToday } = buildLiveIndex(
    ADDONS.map((a) => (a.code === "HB Fully Cover" ? { ...a, selling_price_sen: 0, cost_price_sen: 0 } : a)));
  assert.equal(laterToday("HB Fully Cover"), false);
});

test("variantsShape names the jsonb kinds jsonb_set cannot address", () => {
  assert.equal(variantsShape(null), "null");
  assert.equal(variantsShape({}), "object");
  assert.equal(variantsShape([]), "array");
  assert.equal(variantsShape("x"), "string");
});

test("phrasesOf collapses the parsers' containment duplicates", () => {
  assert.deepEqual(phrasesOf(["BACK REST CHANGE 8030", "BACKRESTCHANGE8030"]).length, 1);
});

test("K and asArray are the identities the script writes with", () => {
  assert.equal(K("  hb   straight "), "HB STRAIGHT");
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray("a"), ["a"]);
  assert.deepEqual(asArray(["a"]), ["a"]);
});
