// ---------------------------------------------------------------------------
// assistant-teach.ts — the CHAT-side door to the agent teaching notebook.
//
// The store and the inject already exist: addAgentFeedback writes agent_feedback
// (services/agent-console.ts), and activeInstructions(db, FAMILY) injects the
// ACTIVE rows into that family's brain on its next run (agents/index.ts via
// maybeAiFocus). The only thing missing was a way to teach from the chat the
// owner already uses — the Agent Console form was the sole entry. This module is
// that chat door and nothing more:
//   - names the teachable families and their human labels,
//   - parses the router's teach/ask decision (pure, unit-tested, total),
//   - records a teaching against the SAME notebook the console form writes.
//
// The WRITE is performed by the route (routes/assistant.ts), never by
// services/assistant.ts, so the assistant answerer stays strictly read-only.
//
// WHO MAY TEACH: the owner only (wildcard scope), enforced at the route. A rule
// steers an agent's JUDGMENT for everyone; it is not a per-user preference. And
// it teaches JUDGMENT, not MATH — corrections to numbers go through config
// proposals so the deterministic engines stay deterministic (see the note on
// addAgentFeedback).
// ---------------------------------------------------------------------------

import type { Env } from '../types';
import { AGENT_FAMILIES, addAgentFeedback, type AgentFamily } from './agent-console';

/** Human label per family — shown in the teach confirmation and offered to the
 *  router so it can name the target in words the owner recognises. A family with
 *  no entry here falls back to its id via agentLabel; never throws. */
export const AGENT_LABELS: Record<AgentFamily, string> = {
  OF: 'Order fulfilment',
  DELIVERY: 'Delivery planning',
  COLLECTION: 'Receivables / collection',
  PROCUREMENT: 'Procurement / purchasing',
  SI: 'Sales intelligence',
  DOCUMENT: 'Document flow',
  CS: 'Customer service',
  PMS: 'Roadshow / Project',
};

export function agentLabel(family: string): string {
  return (AGENT_LABELS as Record<string, string>)[family] ?? family;
}

export type RouterDecision =
  | { kind: 'teach'; family: AgentFamily; instruction: string }
  | { kind: 'ask'; keys: string[] };

/**
 * Parse the router LLM's reply. Accepts the teach/ask OBJECT form
 *   {"teach":{"agent":"<FAMILY>","instruction":"..."}}  |  {"ask":["<key>",...]}
 * and, for back-compat with the previous array-only router, a BARE ARRAY of keys
 * (read as ask). Returns null when the reply is neither — the caller then falls
 * back to keyword routing.
 *
 * Pure and total: never throws, so it is exercised without a model. Unknown
 * families / keys are dropped here, so a hallucinated target can never reach the
 * write or the gather.
 */
export function parseRouterDecision(
  raw: string,
  validFamilies: readonly string[],
  validKeys: readonly string[],
): RouterDecision | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const asAsk = (arr: unknown): RouterDecision | null =>
    Array.isArray(arr)
      ? { kind: 'ask', keys: arr.filter((k): k is string => typeof k === 'string' && validKeys.includes(k)) }
      : null;

  const objStart = raw.indexOf('{');
  const objEnd = raw.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    try {
      const obj = JSON.parse(raw.slice(objStart, objEnd + 1)) as Record<string, unknown>;
      const teach = obj?.teach as Record<string, unknown> | undefined;
      if (teach && typeof teach === 'object') {
        const family = String(teach.agent ?? teach.family ?? '').trim().toUpperCase();
        const instruction = String(teach.instruction ?? '').trim();
        if (validFamilies.includes(family) && instruction) {
          return { kind: 'teach', family: family as AgentFamily, instruction };
        }
      }
      const ask = asAsk(obj?.ask);
      if (ask) return ask;
    } catch {
      /* fall through to the array form below */
    }
  }

  const arrStart = raw.indexOf('[');
  const arrEnd = raw.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return asAsk(JSON.parse(raw.slice(arrStart, arrEnd + 1)));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Record one teaching for a family into the notebook the brains already read.
 * Validates the family and a non-empty instruction (both BEFORE any DB call, so
 * the guard paths are unit-testable without a database). The caller owns auth
 * (owner-only) and audit.
 */
export async function recordTeaching(
  env: Env,
  p: { family: AgentFamily; instruction: string; actor: string | null },
): Promise<{ id: string; family: AgentFamily; label: string }> {
  if (!AGENT_FAMILIES.includes(p.family)) throw new Error(`unknown agent family: ${p.family}`);
  const instruction = (p.instruction ?? '').trim();
  if (!instruction) throw new Error('empty instruction');
  const id = await addAgentFeedback(env.DB, { agent: p.family, instruction, createdBy: p.actor });
  return { id, family: p.family, label: agentLabel(p.family) };
}
