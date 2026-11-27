import { HOWTO_GUIDES } from "./mcp-howto-guides";
import { MODULES } from "./mcp-howto-modules";
import { GLOSSARY } from "./mcp-howto-glossary";
import { ONBOARDING } from "./mcp-howto-onboarding";
import { ERRORS } from "./mcp-howto-errors";

const cell = (s: string): string => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/** docs/modules/how-to-guides.md, generated from the guide data (test: mcp-howto-readme.test.ts; HOWTO_WRITE=1 rewrites it). */
export function howtoReadme(): string {
  const tasks = HOWTO_GUIDES.filter((g) => g.kind === "task");
  const flows = HOWTO_GUIDES.filter((g) => g.kind === "flow");
  const row = (g: (typeof HOWTO_GUIDES)[number]) => `| \`${g.id}\` | ${cell(g.title)} | ${cell(g.module)} | \`${g.page}\` | ${cell(g.sidebar)} | ${g.steps.length} |`;
  return [
    "# How-to guides (AI Connector)",
    "",
    "Generated from `backend/src/services/mcp-howto-guides*.ts` — do not edit by hand. Regenerate: `HOWTO_WRITE=1 npx vitest run --config vitest.light.config.mts src/services/mcp-howto-readme.test.ts` in `backend/`.",
    "",
    "Staff ask Claude \"how do I ...\"; the connector's `how_to` tool returns the full SOP (purpose, prerequisites, fields, click-by-click steps with `?highlight=` links, checks, warnings, undo, approvals, deadlines, common mistakes, worked example, contact) with `canDo` from the person's own ERP permissions. Every page path and every quoted UI label is checked against `frontend/src` by `mcp-howto-honesty.test.ts`.",
    "",
    `## Task guides (${tasks.length})`,
    "",
    "| id | Title | Module | Page | Sidebar | Steps |",
    "| --- | --- | --- | --- | --- | --- |",
    ...tasks.map(row),
    "",
    `## End-to-end flows (${flows.length})`,
    "",
    "| id | Title | Module | Page | Sidebar | Steps |",
    "| --- | --- | --- | --- | --- | --- |",
    ...flows.map(row),
    "",
    `## Modules (\`module_overview\`, ${MODULES.length})`,
    "",
    ...MODULES.map((m) => `- **${cell(m.name)}** (sidebar "${cell(m.sidebar)}"): ${cell(m.purpose.split(/(?<=\.)\s/)[0])}`),
    "",
    `## Glossary (\`glossary\`, ${GLOSSARY.length} terms)`,
    "",
    GLOSSARY.map((t) => t.term).join(", "),
    "",
    `## First-week paths (\`onboarding\`, ${ONBOARDING.length})`,
    "",
    ...ONBOARDING.map((o) => `- \`${o.role}\`: ${cell(o.title)}`),
    "",
    `## Error messages (\`explain_error\`, ${ERRORS.length})`,
    "",
    ...ERRORS.map((e) => `- \`${e.id}\` (${e.module}): ${cell(e.meaning)}`),
    "",
  ].join("\n");
}
