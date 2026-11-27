import { describe, it, expect } from "vitest";
import { labelInFrontend, quotedLabels, routeExists } from "../../scripts/lib/frontend-honesty.mjs";
import fs from "node:fs";
import path from "node:path";
import { HOWTO_GUIDES } from "./mcp-howto-guides";
import { MODULES } from "./mcp-howto-modules";
import { GLOSSARY } from "./mcp-howto-glossary";
import { ONBOARDING } from "./mcp-howto-onboarding";
import { ERRORS } from "./mcp-howto-errors";

function backendCorpus(): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !e.name.startsWith("mcp-howto")) out.push(fs.readFileSync(p, "utf8"));
    }
  };
  walk(path.resolve(__dirname, ".."));
  return out.join("\n");
}

const ids = new Set(HOWTO_GUIDES.map((g) => g.id));

function labelsOf(g: (typeof HOWTO_GUIDES)[number]): string[] {
  const out: string[] = [];
  for (const s of g.steps) {
    out.push(...quotedLabels(s.text));
    if (s.highlight) out.push(s.highlight);
  }
  for (const f of g.fields) out.push(f.label);
  return out;
}

describe("how-to guides stay honest to the frontend", () => {
  it("has unique ids and a full SOP on every guide", () => {
    expect(ids.size).toBe(HOWTO_GUIDES.length);
    for (const g of HOWTO_GUIDES) {
      expect(g.steps.length, g.id).toBeGreaterThan(0);
      expect(g.purpose.length, g.id).toBeGreaterThan(0);
      expect(g.who.length, g.id).toBeGreaterThan(0);
      expect(g.contact.length, g.id).toBeGreaterThan(0);
      expect(g.workedExample.length, g.id).toBeGreaterThan(0);
      expect(g.keywords.length, g.id).toBeGreaterThan(0);
    }
  });

  it("every page path exists in the frontend router", () => {
    const bad: string[] = [];
    for (const g of HOWTO_GUIDES) {
      if (!routeExists(g.page)) bad.push(`${g.id}: ${g.page}`);
      for (const s of g.steps) if (s.page && !routeExists(s.page)) bad.push(`${g.id} step: ${s.page}`);
    }
    expect(bad).toEqual([]);
  });

  it("every quoted UI label, highlight and field label exists in frontend/src", () => {
    const bad: string[] = [];
    for (const g of HOWTO_GUIDES) for (const l of labelsOf(g)) if (!labelInFrontend(l)) bad.push(`${g.id}: "${l}"`);
    expect(bad).toEqual([]);
  }, 60_000);

  it("related and nextStep point at real guides", () => {
    const bad: string[] = [];
    for (const g of HOWTO_GUIDES) {
      for (const r of g.related) if (!ids.has(r)) bad.push(`${g.id} related ${r}`);
      if (g.nextStep && !ids.has(g.nextStep)) bad.push(`${g.id} nextStep ${g.nextStep}`);
    }
    expect(bad).toEqual([]);
  });

  it("guides are English only", () => {
    const bad = HOWTO_GUIDES.filter((g) => /[㐀-鿿]/.test(JSON.stringify({ ...g, keywords: [] }))).map((g) => g.id);
    expect(bad).toEqual([]);
  });
});

describe("reference data stays honest", () => {
  it("module overview: pages exist, sidebar and page labels exist in frontend/src", () => {
    const bad: string[] = [];
    for (const m of MODULES) {
      if (!labelInFrontend(m.sidebar)) bad.push(`${m.id}: sidebar "${m.sidebar}"`);
      for (const p of m.keyPages) {
        if (!routeExists(p.path)) bad.push(`${m.id}: ${p.path}`);
        if (!labelInFrontend(p.label)) bad.push(`${m.id}: "${p.label}"`);
      }
    }
    expect(bad).toEqual([]);
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length);
  });

  it("glossary: unique terms, pages exist, English definitions", () => {
    expect(new Set(GLOSSARY.map((t) => t.term.toLowerCase())).size).toBe(GLOSSARY.length);
    const bad = GLOSSARY.filter((t) => (t.page && !routeExists(t.page)) || /[㐀-鿿]/.test(t.definition)).map((t) => t.term);
    expect(bad).toEqual([]);
  });

  it("onboarding: every guide id and page exists", () => {
    const bad: string[] = [];
    for (const o of ONBOARDING)
      for (const d of o.days) {
        for (const g of d.guides) if (!ids.has(g)) bad.push(`${o.role}: ${g}`);
        for (const p of d.pages) if (!routeExists(p)) bad.push(`${o.role}: ${p}`);
      }
    expect(bad).toEqual([]);
  });

  it("explain_error: every match string is the backend's own text", () => {
    const backend = backendCorpus();
    const bad: string[] = [];
    for (const e of ERRORS) for (const m of e.match) if (!backend.includes(m)) bad.push(`${e.id}: "${m}"`);
    expect(bad).toEqual([]);
    expect(new Set(ERRORS.map((e) => e.id)).size).toBe(ERRORS.length);
  });
});
