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

/* ── docs/bugs/0824: a side drawer must NEVER decode as a front drawer ──────
   The parser was fixed on 2026-09-12 to emit `Side Drawer (side unknown)`
   instead of falling through to Front. This MAP went on filing that phrase as
   Front anyway, because the Front family's `yes` carries a bare `\bdrawer\b`
   and its `no` vetoed only left/right. Every wording below is transcribed from
   a real production line. */
const DRAWER_ADDONS = [
  ...ADDONS,
  { code: "Left Drawer", label: null, categories: ["BEDFRAME"], selling_price_sen: 16000, cost_price_sen: 16000 },
  { code: "Right Drawer", label: null, categories: ["BEDFRAME"], selling_price_sen: 16000, cost_price_sen: 16000 },
];
const drawerLive = buildLiveIndex(DRAWER_ADDONS).liveByCat;
const drawerCodes = (d2) => classifyLine(line({ d2 }), MAP, drawerLive)
  .gained.filter((c) => /drawer/i.test(c)).sort();

test("a side drawer with no hand stated decodes to NO drawer code at all", () => {
  for (const d2 of [
    "sidedrawer/PC151-01/divan10/gap12",
    "SideDrawer/Col:PC151-11/Divan:8\"+2\"leg/M'Gap:10\"",
    "HB FULL COVERED / COL:KIV/DIVAN8+0 with side drawer/GAP:12",
    "Divan 8 / 2SIDE DRAWER / gap 12",
    "divan 10 / drawer at the side",
  ]) {
    assert.deepEqual(drawerCodes(d2), [], `"${d2}" must not decode to a drawer code`);
  }
});

test("the side drawer still reaches a human as UNMAPPED, never silently dropped", () => {
  const r = classifyLine(line({ d2: "sidedrawer/PC151-01/divan10/gap12" }), MAP, drawerLive);
  assert.ok(r.unmapped.some((u) => /SIDE DRAWER/i.test(u)), `unmapped was ${JSON.stringify(r.unmapped)}`);
});

test("a hand written with no space, or after the word, is read", () => {
  assert.deepEqual(drawerCodes("Leftside Drawer/HeadBoard Straight/Divan:8\"+No Leg"), ["Left Drawer"]);
  assert.deepEqual(drawerCodes("Divan: 8\" no leg/Col: PC151-01/add on right side drawer"), ["Right Drawer"]);
  assert.deepEqual(drawerCodes("Add left hand side drawer"), ["Left Drawer"]);
  assert.deepEqual(drawerCodes("divan 10 / drawer at the right"), ["Right Drawer"]);
});

test("a genuine front drawer is STILL a front drawer", () => {
  assert.deepEqual(drawerCodes("div:10inch / gap:14inch / Front Drawer, HB Fully Cover"), ["Front Drawer"]);
  assert.deepEqual(drawerCodes("divan 8 / gap 12 / drawer"), ["Front Drawer"]);
  assert.deepEqual(drawerCodes("divan 8 / pull out"), ["Front Drawer"]);
});
