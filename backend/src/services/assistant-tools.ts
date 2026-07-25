// ---------------------------------------------------------------------------
// assistant-tools.ts — the Assistant's tool catalog + the ONE governed dispatcher
// behind it. This is where the read-only "search / 查找" capability lives.
//
// The engine (askAgentBrainWithTools, agent-brain.ts) runs the tool_use handshake
// but knows NOTHING about policy. Everything that decides what a caller may see
// lives here:
//   • buildAssistantTools(scope) — which tools even exist for this caller. A tool
//     that is not in the returned array can never be called.
//   • dispatchAssistantTool(ctx, ...) — runs one governed read, COMPANY-SCOPED at
//     source and REDACTED before it becomes a tool_result the model can read.
//
// v1 ships ONE tool, search_erp, deliberately: it reuses the global-search reader
// (routes/search.ts runGlobalSearch), which is company-scoped and returns match
// METADATA ONLY — no record bodies, no money. That makes it the safest possible
// first tool (near-zero new disclosure surface) while still giving the model the
// look-it-up power the owner asked for. Richer entity-read tools that DO carry
// money (get_sales_order, get_receivables, ...) slot in behind buildAssistantTools'
// scope gate later, each with its own field-level review — NOT in this pass.
// ---------------------------------------------------------------------------

import type { Env } from "../types";
import type { AgentToolDef } from "./agent-brain";
import { redactFacts, type AssistantScope } from "./assistant-scope";
import type { CompanyScopeCtx } from "../scm/lib/companyScope";
import { runGlobalSearch } from "../routes/search";

/** What the dispatcher needs to run a governed read. `companyCtx` is the request's
 *  company context (Hono's `c` satisfies it structurally — companyScope helpers
 *  take a bare `{ get }`), so search scopes to exactly the caller's companies. */
export interface AssistantToolCtx {
  env: Env;
  scope: AssistantScope;
  companyCtx: CompanyScopeCtx;
  /** Appended to as the model calls tools, so the caller can render the same
   *  routing trace ("consulted: Search") the single-shot path shows. */
  consulted: Array<{ key: string; label: string }>;
}

/** A query longer than this is a paste, not a search term — cap it so one tool
 *  call cannot balloon the request. searchPattern already neutralises wildcards. */
const SEARCH_MAX_Q = 120;

export const SEARCH_TOOL: AgentToolDef = {
  name: "search_erp",
  description:
    "Look up a specific record by name or number across the ERP: sales orders, " +
    "products, purchase orders, GRNs, delivery orders, sales invoices, purchase " +
    "invoices, projects, service cases and people. Returns up to a few matches per " +
    "type as METADATA ONLY — document number, a short title, a date and a deep " +
    "link — never full record contents and never money. Use it to LOCATE the right " +
    "record when the user names something specific that the briefs do not already " +
    "cover, then point them to it. Results are limited to records this user's " +
    "company is allowed to see.",
  input_schema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description:
          "The name, code, document number or keyword to find — e.g. a customer " +
          "name, 'SO-2607-001', a product code, or a supplier name.",
      },
    },
    required: ["q"],
  },
};

/** Guidance appended to the answer system prompt when the tool-loop path runs. */
export const SEARCH_TOOL_GUIDANCE = [
  "You also have a search_erp tool. The payload already contains the specialist",
  "agents' latest briefs and open items — answer from those whenever they cover the",
  "question. ONLY when the user names a SPECIFIC record the briefs do not contain (a",
  "particular order, product, purchase order, invoice, delivery order, customer or",
  "person) call search_erp to locate it. It returns match metadata only (document",
  "number, title, date, link), scoped to this user's company — never record contents",
  "or money — so use it to point the user to the right record, not to quote figures.",
  "If it returns no match, say so plainly rather than guessing.",
].join(" ");

/**
 * The tools this caller may use. Kept a function of scope even though v1 returns a
 * constant: it is the gate where a money-bearing tool would be added behind a
 * `scope.canSeeMargin`-style check, so an ungated tool is never in the array a
 * caller without the entitlement receives.
 *
 * search_erp needs NO gate: it is company-scoped at source and metadata-only, so
 * every user who may open the Assistant at all may search.
 */
export function buildAssistantTools(_scope: AssistantScope): AgentToolDef[] {
  return [SEARCH_TOOL];
}

function recordConsulted(ctx: AssistantToolCtx, key: string, label: string): void {
  if (!ctx.consulted.some((a) => a.key === key)) ctx.consulted.push({ key, label });
}

/** Normalise the model-supplied search term: a non-string is no query, and a paste
 *  is capped so one tool call cannot balloon the request. Pure + exported so the
 *  cap is unit-testable without the Workers-pool DB. */
export function normalizeSearchQuery(input: Record<string, unknown>): string {
  return typeof input.q === "string" ? input.q.trim().slice(0, SEARCH_MAX_Q) : "";
}

/**
 * Shape raw search hits into the tool result — THE security-critical step. Records
 * the routing trace, then passes every hit through redactFacts(_, scope) so a value
 * the caller may not see never enters the model's context, the same rule the
 * single-shot gather path obeys. search_erp is metadata-only today, but redacting
 * anyway keeps the invariant true no matter what a source starts returning tomorrow.
 * Pure + exported so the redaction can be tested directly on arbitrary hit shapes
 * (the Workers test pool cannot module-mock the reader).
 */
export function shapeSearchResult(
  ctx: AssistantToolCtx,
  query: string,
  hits: unknown[],
): { query: string; count: number; hits: unknown } {
  recordConsulted(ctx, "search", "Search");
  return { query, count: hits.length, hits: redactFacts(hits, ctx.scope) };
}

/**
 * Run ONE tool call and return its result. NEVER throws (a throw here would abort
 * the whole answer); an unknown tool or a failed read returns a small object the
 * model can read and narrate around. Thin glue over the pure helpers above and the
 * company-scoped reader.
 */
export async function dispatchAssistantTool(
  ctx: AssistantToolCtx,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (name === "search_erp") {
    const raw = normalizeSearchQuery(input);
    if (!raw) return { query: "", count: 0, hits: [], note: "empty query" };
    let hits: unknown[];
    try {
      hits = await runGlobalSearch(ctx.companyCtx, ctx.env, raw);
    } catch {
      return { query: raw, count: 0, hits: [], note: "search is unavailable right now" };
    }
    return shapeSearchResult(ctx, raw, hits);
  }
  return { error: `unknown tool: ${name}` };
}
