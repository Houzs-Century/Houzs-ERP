// ---------------------------------------------------------------------------
// agent-facts.ts — the typed AGENT-TO-AGENT (A2A) FACT registry.
//
// The owner's A2A rule (2026-07-24, verbatim intent): "Customer service ask
// delivery agent when can delivery and ask procurement agent when the items can
// be ready ... agent only focus in their tasks and their JD and their module."
// An agent must NOT reach into another module's data itself — it ASKS the agent
// that owns that judgment, through a TYPED hand-off. This registry is that typed
// contract.
//
// TWO HALVES OF A2A, and only the first is here:
//   • FACT  = "what is true" — a DETERMINISTIC, READ-ONLY tool call another agent
//             exposes (procurement.estimateReadyDate is the first). Safe to call
//             without approval, because it decides nothing and writes nothing.
//   • DECISION/ACTION = "please expedite / rush / re-slot" — an A2A REQUEST that
//             goes through an APPROVAL GATE. Deliberately NOT in this file yet;
//             it is the heavier half (operating-spec §2/§9.3), and folding it in
//             before the fact layer is proven would couple the safe path to the
//             gated one.
//
// NOT A MESH. Facts are called by name through callAgentFact — one governed entry
// point — which is exactly what the top-level orchestrator (GCOA, operating-spec
// §9.3) routes through, and what a consumer (an assistant tool, a sibling agent)
// calls. Adding the next fact (e.g. delivery.estimateDeliveryDate) is a single
// registration here, not a new wire between two agents.
// ---------------------------------------------------------------------------

import type { Env } from '../../types';
import type { AgentFamily } from '../agent-console';
import {
  estimateReadyDateForCompany,
  type ReadyDateItem,
  type ReadyDateEstimate,
} from './procurement-ready-date';

/**
 * A typed, deterministic, READ-ONLY capability one agent exposes for others to
 * call. The handler must not write a business row and must not make a judgment —
 * a fact answers "what is true", nothing more.
 */
export interface AgentFact<I = unknown, O = unknown> {
  /** Stable dotted name `<domain>.<fact>`, e.g. 'procurement.estimateReadyDate'. */
  name: string;
  /** The family that OWNS this fact — the module the caller defers to instead of
   *  reading its data directly. */
  owner: AgentFamily;
  /** One line for the orchestrator / a human reading the registry. */
  summary: string;
  /** Deterministic, read-only handler. */
  run: (env: Env, input: I) => Promise<O>;
}

// ── Facts ────────────────────────────────────────────────────────────────────

export interface EstimateReadyDateInput {
  items: ReadyDateItem[];
  asOfDate?: string;
}

/**
 * procurement.estimateReadyDate — "if I need these items, when can procurement
 * have them ready?" The A2A answer to the owner's rule that CS/delivery must ASK
 * procurement rather than read stock/ETA themselves. Deterministic + read-only:
 * lead-time model (owner base table + learned supplier/season buffers), the exact
 * inverse of MRP's order-by hint.
 */
export const PROCUREMENT_ESTIMATE_READY_DATE: AgentFact<EstimateReadyDateInput, ReadyDateEstimate> = {
  name: 'procurement.estimateReadyDate',
  owner: 'PROCUREMENT',
  summary:
    'When can the given items be ready? Lead-time based: owner base table + learned supplier + season buffers.',
  run: (env, input) =>
    estimateReadyDateForCompany(env, { items: input?.items ?? [], asOfDate: input?.asOfDate }),
};

/** The registry. One entry today; each addition is one line here, not a new wire
 *  between two agents. */
const FACTS: AgentFact[] = [PROCUREMENT_ESTIMATE_READY_DATE as AgentFact];

const byName = new Map(FACTS.map((f) => [f.name, f]));

// ── Lookup + governed dispatch ───────────────────────────────────────────────

/** The registry, as data — for the orchestrator or a human to see what facts
 *  exist and who owns each. Never exposes the handler. */
export function listAgentFacts(): Array<{ name: string; owner: AgentFamily; summary: string }> {
  return FACTS.map((f) => ({ name: f.name, owner: f.owner, summary: f.summary }));
}

export function getAgentFact(name: string): AgentFact | undefined {
  return byName.get(name);
}

export type FactCallResult<O = unknown> =
  | { ok: true; name: string; owner: AgentFamily; result: O }
  | { ok: false; error: string };

/**
 * Run a fact's handler, wrapping the outcome. Split from callAgentFact so the
 * run/catch behaviour is testable without the registry (and without the real
 * fact's DB dependencies). Never throws: a handler failure becomes a typed error
 * the caller narrates, exactly like the assistant tool dispatcher.
 */
export async function runAgentFact<O = unknown>(
  fact: AgentFact,
  env: Env,
  input: unknown,
): Promise<FactCallResult<O>> {
  try {
    const result = (await fact.run(env, input)) as O;
    return { ok: true, name: fact.name, owner: fact.owner, result };
  } catch (err) {
    return { ok: false, error: `fact ${fact.name} failed: ${String(err)}` };
  }
}

/**
 * Call one agent's fact by name — the governed entry point every A2A hand-off and
 * the orchestrator route through. Facts are deterministic + read-only, so there is
 * NO approval gate here; that belongs to the DECISION path (deferred). Never
 * throws: an unknown fact returns a typed error.
 */
export async function callAgentFact<O = unknown>(
  env: Env,
  name: string,
  input: unknown,
): Promise<FactCallResult<O>> {
  const fact = byName.get(name);
  if (!fact) return { ok: false, error: `unknown fact: ${name}` };
  return runAgentFact<O>(fact, env, input);
}
