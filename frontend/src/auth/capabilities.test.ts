// ----------------------------------------------------------------------------
// The cross-the-wire drift guard.
//
// auth/capabilities.ts declares a key union; backend/src/services/capabilities.ts
// declares the registry that produces those keys. Two lists, one meaning — which
// is the exact shape of every bug this whole change exists to remove. So the
// frontend list is not maintained by hand and hoped over: this test READS the
// backend source and pins the two equal.
//
// The frontend CI job runs with `working-directory: frontend`, but actions/checkout
// lays down the whole repo, so ../backend is present. If that ever stops being
// true this test fails loudly rather than silently passing on an empty read —
// see the explicit existence check below.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CAPABILITY_KEYS, capability, capabilitiesUnresolved } from "./capabilities";
import type { AuthUser } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_CAPABILITIES = resolve(HERE, "../../../backend/src/services/capabilities.ts");

/** Pull the registry's keys out of the backend source. The registry is an object
 *  literal whose keys are quoted string literals, so a targeted scan of the
 *  PREDICATES block is exact and does not need the file to be executable from
 *  here (it imports Workers-only modules). */
function backendCapabilityKeys(): string[] {
  const src = readFileSync(BACKEND_CAPABILITIES, "utf8");
  const start = src.indexOf("const PREDICATES = {");
  expect(start, "PREDICATES registry not found — did it get renamed?").toBeGreaterThan(-1);
  const end = src.indexOf("} as const satisfies", start);
  expect(end, "end of PREDICATES registry not found").toBeGreaterThan(start);
  const block = src.slice(start, end);
  // Registry entries are `"some.key": …` at the start of a line (allowing
  // indentation). Doc comments in between contain quoted words but never in
  // that position.
  const keys = [...block.matchAll(/^\s{2}"([a-zA-Z0-9._]+)":/gm)].map((m) => m[1]);
  return keys;
}

describe("capability keys — frontend and backend declare the same vocabulary", () => {
  test("the backend source is reachable from the frontend test run", () => {
    expect(
      existsSync(BACKEND_CAPABILITIES),
      `expected the backend registry at ${BACKEND_CAPABILITIES}`,
    ).toBe(true);
  });

  test("the key sets are identical", () => {
    const backend = backendCapabilityKeys().sort();
    // A parse that found nothing would make this test vacuously pass, so assert
    // the scan actually saw a registry before comparing.
    expect(backend.length).toBeGreaterThan(5);
    expect([...CAPABILITY_KEYS].sort()).toEqual(backend);
  });

  test("the frontend list has no duplicates", () => {
    expect(new Set(CAPABILITY_KEYS).size).toBe(CAPABILITY_KEYS.length);
  });
});

describe("capability() fails CLOSED", () => {
  const withCaps = (caps: Partial<Record<string, boolean>>): AuthUser =>
    ({ capabilities: caps }) as AuthUser;

  test("no user → false for every key", () => {
    for (const k of CAPABILITY_KEYS) {
      expect(capability(null, k)).toBe(false);
      expect(capability(undefined, k)).toBe(false);
    }
  });

  test("user with NO capability set → false for every key", () => {
    const u = {} as AuthUser;
    for (const k of CAPABILITY_KEYS) expect(capability(u, k)).toBe(false);
  });

  test("an EMPTY capability set denies — it is not read as 'no rules, so allowed'", () => {
    const u = withCaps({});
    for (const k of CAPABILITY_KEYS) expect(capability(u, k)).toBe(false);
  });

  test("an absent key denies even when siblings are granted", () => {
    const u = withCaps({ "org.director": true });
    expect(capability(u, "org.director")).toBe(true);
    expect(capability(u, "scm.money.move")).toBe(false);
  });

  test("only a literal true grants — truthy non-booleans are denials", () => {
    for (const bad of [1, "true", "yes", {}, []] as unknown[]) {
      const u = withCaps({ "org.director": bad as boolean });
      expect(capability(u, "org.director")).toBe(false);
    }
  });

  test("false stays false", () => {
    expect(capability(withCaps({ "org.director": false }), "org.director")).toBe(false);
  });
});

describe("capabilitiesUnresolved — a broken deploy is not a denial", () => {
  test("false when there is no signed-in user at all", () => {
    expect(capabilitiesUnresolved(null)).toBe(false);
    expect(capabilitiesUnresolved(undefined)).toBe(false);
  });

  test("true when a signed-in user carries no capability set", () => {
    expect(capabilitiesUnresolved({} as AuthUser)).toBe(true);
  });

  test("false when the set is present but empty — that is a real all-denied answer", () => {
    expect(capabilitiesUnresolved({ capabilities: {} } as AuthUser)).toBe(false);
  });
});
