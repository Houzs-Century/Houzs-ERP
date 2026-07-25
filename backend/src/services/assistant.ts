// ---------------------------------------------------------------------------
// assistant.ts — the unified ERP Assistant + the GCOA routing behind it.
//
// docs/agents/operating-spec.md §2: "Users interact with one unified ERP
// Assistant. The router identifies intent and invokes the appropriate specialist
// Agent." Owner 2026-07-18: build it as an in-system chat first ("先像虎哥这样子"),
// WhatsApp later — the channel changes, this brain does not.
//
// WHAT IT IS: a front desk. It does NOT do the specialists' work. It
//   1. classifies the question → which specialist agent(s) hold the answer,
//   2. FETCHES those agents' own deterministic output (their latest brief + open
//      findings/proposals — already computed, already governed),
//   3. asks the LLM to word ONE answer strictly from those facts.
//
// THE GROUNDING RULE (§1.2: "The LLM interprets, plans, explains and coordinates;
// it does not invent missing operational facts"): the model only ever sees the
// fetched payload, and the system prompt forbids inventing a number that is not
// in it. If the agents hold nothing, the honest answer is "I don't have that",
// never a plausible figure.
//
// READ-ONLY. The assistant never writes a business row and never approves
// anything. A question that implies a write gets an explanation plus a pointer to
// the screen where a HUMAN does it — every write keeps its existing approval path
// (§1.2, and the procurement red line: the agent drafts, a person confirms).
// ---------------------------------------------------------------------------

import type { Env } from '../types';
import { askAgentBrain, type AgentBrainUsageSink } from './agent-brain';
import {
  allowedCapabilityKeys,
  redactFacts,
  scopeNote,
  type AssistantScope,
} from './assistant-scope';
import { AGENT_FAMILIES, type AgentFamily } from './agent-console';
import { agentLabel, parseRouterDecision } from './assistant-teach';
import type { ContentBlock } from './vision-blocks';

/** One specialist the router can consult. `briefTable`/`itemsTable` are module
 *  constants — never user input — so they are safe to interpolate. */
interface Capability {
  key: string;
  /** Shown to the router LLM so it can choose. */
  answers: string;
  briefTable: string;
  /** briefs are ordered by generated_at in some families, created_at in others. */
  briefOrderCol: 'generated_at' | 'created_at';
  itemsTable: string;
  /** findings tables filter on status='OPEN'; proposal tables on 'PENDING'. */
  itemsOpenStatus: 'OPEN' | 'PENDING';
  /** Human label for the routing trace the UI shows. */
  label: string;
}

const CAPABILITIES: Capability[] = [
  {
    key: 'order_fulfilment', label: 'Order fulfilment',
    answers: 'why an order is not ready to deliver, what is blocking it, who owns the fix, order readiness',
    briefTable: 'of_agent_briefs', briefOrderCol: 'generated_at',
    itemsTable: 'of_agent_findings', itemsOpenStatus: 'OPEN',
  },
  {
    key: 'delivery', label: 'Delivery planning',
    answers: 'delivery scheduling, trips, what is ready to deliver, overdue deliveries, POD',
    briefTable: 'delivery_agent_briefs', briefOrderCol: 'created_at',
    itemsTable: 'delivery_agent_proposals', itemsOpenStatus: 'PENDING',
  },
  {
    key: 'receivables', label: 'Receivables',
    answers: 'who owes money, overdue balances, collection, whether an order may be released for payment reasons',
    briefTable: 'collection_agent_briefs', briefOrderCol: 'created_at',
    itemsTable: 'collection_agent_proposals', itemsOpenStatus: 'PENDING',
  },
  {
    key: 'procurement', label: 'Procurement',
    answers: 'material shortages, reorders, purchase orders to raise, supplier lead times',
    briefTable: 'procurement_agent_briefs', briefOrderCol: 'created_at',
    itemsTable: 'procurement_agent_proposals', itemsOpenStatus: 'PENDING',
  },
  {
    key: 'sales_intel', label: 'Sales intelligence',
    answers: 'sales performance, margin, cancellation rates, which salesperson / venue / state is doing well, roadshow results',
    briefTable: 'si_agent_briefs', briefOrderCol: 'generated_at',
    itemsTable: 'si_agent_findings', itemsOpenStatus: 'OPEN',
  },
  {
    key: 'documents', label: 'Document flow',
    answers: 'stuck or missing documents, invoice gaps, stale drafts, unpaid invoices, document mismatches',
    briefTable: 'document_agent_briefs', briefOrderCol: 'generated_at',
    itemsTable: 'document_agent_findings', itemsOpenStatus: 'OPEN',
  },
];

const byKey = new Map(CAPABILITIES.map((c) => [c.key, c]));

const TEACHABLE_LIST = AGENT_FAMILIES.map((f) => `${f} (${agentLabel(f)})`).join(', ');
const ASK_KEYS_LIST = CAPABILITIES.map((c) => c.key).join(', ');

/* The router now also spots TEACHING — the owner giving an agent a standing rule
   in the same chat — and returns a teach/ask OBJECT (parseRouterDecision reads
   it, and still accepts the old bare array for safety). Teaching is a PROPOSAL
   here; the route performs the owner-gated write, so this file never writes. */
const ROUTER_SYSTEM = [
  'You are the router of an ERP assistant. Decide whether the user is TEACHING an agent a standing rule or ASKING a question, then reply with ONE JSON object only — no prose, no markdown.',
  'TEACH = the user gives a STANDING RULE for an agent to remember and apply from now on (imperative: "from now on...", "always...", "never...", "以后...", "记住...", "不要..."). A one-off question is NOT teaching.',
  'If TEACH: {"teach":{"agent":"<FAMILY>","instruction":"<the rule as one clear standing instruction>"}}.',
  'If ASK: {"ask":["<key>", ...]} — every specialist key whose data is needed (a late-order question usually needs several); [] if none covers it.',
  `Valid TEACH families: ${TEACHABLE_LIST}.`,
  `Valid ASK keys: ${ASK_KEYS_LIST}.`,
  'When unsure whether it is teach or ask, choose ask.',
].join(' ');

const ANSWER_SYSTEM = [
  'You are the ERP assistant for Houzs, a Malaysian furniture retailer. You are given',
  'the user question and the SPECIALIST AGENTS\' OWN DATA (their latest brief and open',
  'items). Answer in plain English, 2-6 short sentences, no markdown, no emoji.',
  'ABSOLUTE RULE: use ONLY numbers and facts present in the payload. Never invent,',
  'estimate or round a figure that is not there. If the payload does not answer the',
  'question, say plainly that you do not have that yet and name what is missing.',
  'Money values in the payload are in sen (RM x100) unless a field says otherwise —',
  'convert to RM when you state them.',
  'You cannot change anything: if the user asks you to create, approve, send or edit,',
  'explain what you found and tell them which screen does it — never claim you did it.',
].join(' ');

const FILE_ANSWER_SYSTEM = [
  'You are the ERP assistant for Houzs, a Malaysian furniture retailer. The user has',
  'attached a file (an image or a PDF). Read it and answer their question about it in',
  'plain English, no markdown, no emoji. Report ONLY what the file actually shows —',
  'never invent a figure, name or date that is not visible in it. If the file does not',
  'contain what they asked, say so plainly. You cannot change anything in the ERP: if',
  'they ask you to save, create or send, explain what the file shows and tell them which',
  'screen does it.',
].join(' ');

async function latestBrief(env: Env, cap: Capability): Promise<unknown> {
  try {
    const r = await env.DB.prepare(
      `SELECT brief FROM ${cap.briefTable} ORDER BY ${cap.briefOrderCol} DESC LIMIT 1`,
    ).first<{ brief?: unknown }>();
    const b = r?.brief;
    return typeof b === 'string' ? JSON.parse(b) : (b ?? null);
  } catch {
    return null; // a family whose table is absent must not sink the answer
  }
}

async function openItems(env: Env, cap: Capability, limit = 8): Promise<unknown[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT summary FROM ${cap.itemsTable} WHERE status = ? ORDER BY created_at DESC LIMIT ${limit}`,
    ).bind(cap.itemsOpenStatus).all<{ summary?: string }>();
    return (r.results ?? []).map((x) => x.summary).filter(Boolean);
  } catch {
    return [];
  }
}

/** Keyword fallback when the LLM is unavailable or returns nothing usable — the
 *  assistant still routes rather than shrugging. Deliberately generous: consulting
 *  one agent too many costs a read, missing the right one costs the answer. */
function keywordRoute(message: string): string[] {
  const m = message.toLowerCase();
  const hits: string[] = [];
  const add = (k: string) => { if (!hits.includes(k)) hits.push(k); };
  if (/(ready|block|fulfil|fulfill|not sent|why.*(late|delay)|就绪|卡)/.test(m)) add('order_fulfilment');
  if (/(deliver|trip|lorry|route|送|车)/.test(m)) add('delivery');
  if (/(owe|payment|paid|balance|collect|overdue|欠|收款|付)/.test(m)) add('receivables');
  if (/(stock|shortage|purchase|po\b|supplier|reorder|采购|缺)/.test(m)) add('procurement');
  if (/(sales|margin|revenue|cancel|venue|roadshow|perform|销售|毛利|业绩)/.test(m)) add('sales_intel');
  if (/(invoice|document|draft|stuck|单据|发票)/.test(m)) add('documents');
  return hits;
}

export interface AssistantAnswer {
  answer: string;
  /** Which specialists were consulted — the UI shows this as the routing trace. */
  agents: Array<{ key: string; label: string }>;
  /** True when the LLM was unavailable and this is the deterministic fallback. */
  degraded: boolean;
  /** Set when the router read the message as TEACHING an agent a standing rule.
   *  A PROPOSAL only — this file never writes; the route performs the owner-gated
   *  write to the teaching notebook and composes the final confirmation. */
  teach?: { family: AgentFamily; label: string; instruction: string };
}

/**
 * Answer one question. Never throws; never writes.
 */
export async function askAssistant(
  env: Env,
  message: string,
  usageSink?: AgentBrainUsageSink,
  /* The caller's visibility. The default is the MOST RESTRICTIVE scope, not the
     most permissive: the route is now open to any authenticated staff member, so
     a future caller that forgets to pass a scope must under-disclose, never
     over-disclose. (This default WAS wildcard, correct only while the route was
     owner-only — the two were documented as having to change together, and this
     is that change.) */
  scope: AssistantScope = { canSeeMargin: false, canSeeCommission: false, orderScope: 'own' },
  /* Image / PDF blocks from an upload. When present, the assistant READS the file
     directly (no routing, no agent gather) — it is the user's OWN upload, not
     agent data, so the money-redaction path does not apply to it. */
  contentBlocks?: ContentBlock[],
): Promise<AssistantAnswer> {
  const apiKey = env.ANTHROPIC_API_KEY;
  const text = (message ?? '').trim();
  const hasFiles = !!(contentBlocks && contentBlocks.length);
  if (!text && !hasFiles) {
    return { answer: 'Ask me something about your orders, deliveries, payments, stock or sales.', agents: [], degraded: false };
  }

  // FILE path — the user attached an image / PDF. Answer strictly from the file
  // (plus their question). No specialist routing; no business data joins in.
  if (hasFiles) {
    if (!apiKey) {
      return { answer: 'The assistant needs an AI key to read a file. Please try again later.', agents: [], degraded: true };
    }
    const worded = await askAgentBrain(apiKey, {
      system: FILE_ANSWER_SYSTEM,
      payload: { question: text || 'Read the attached file and summarise what matters for our operations.' },
      maxTokens: 700,
      usageSink,
      contentBlocks: contentBlocks as Array<Record<string, unknown>>,
    });
    return { answer: worded?.trim() || 'I could not read that file just now. Please try again.', agents: [], degraded: !worded };
  }

  // 1. ROUTE — the LLM decides teach-vs-ask and, for ask, picks the specialists;
  //    keywords are the ask fallback. A teach decision returns here as a PROPOSAL:
  //    the owner-gated write is the route's job, so this function stays read-only.
  let keys: string[] = [];
  if (apiKey) {
    const routed = await askAgentBrain(apiKey, {
      system: ROUTER_SYSTEM,
      payload: { question: text, agents: CAPABILITIES.map((c) => ({ key: c.key, answers: c.answers })) },
      maxTokens: 200,
      usageSink,
    });
    if (routed) {
      const decision = parseRouterDecision(routed, AGENT_FAMILIES, CAPABILITIES.map((c) => c.key));
      if (decision?.kind === 'teach') {
        const label = agentLabel(decision.family);
        return {
          answer: `That reads as a standing rule for ${label}: "${decision.instruction}".`,
          agents: [],
          degraded: false,
          teach: { family: decision.family, label, instruction: decision.instruction },
        };
      }
      if (decision?.kind === 'ask') keys = decision.keys;
    }
  }
  if (keys.length === 0) keys = keywordRoute(text);
  /* Gate BEFORE gathering: a specialist the caller may not consult is never even
     queried, so its rows do not exist to leak. */
  keys = allowedCapabilityKeys(keys, scope);
  const caps = keys.map((k) => byKey.get(k)).filter((c): c is Capability => !!c).slice(0, 4);

  // 2. GATHER — each specialist's OWN deterministic output. No new arithmetic here.
  const facts: Record<string, unknown> = {};
  for (const cap of caps) {
    facts[cap.key] = { brief: await latestBrief(env, cap), openItems: await openItems(env, cap) };
  }

  const agents = caps.map((c) => ({ key: c.key, label: c.label }));

  // 3. ANSWER — worded by the LLM, STRICTLY from the gathered facts.
  if (!apiKey) {
    return {
      answer:
        caps.length === 0
          ? 'The assistant needs an AI key to answer questions. Until then, the agent console has each agent\'s findings.'
          : `The assistant needs an AI key to word an answer. In the meantime, ${agents.map((a) => a.label).join(' and ')} ${agents.length === 1 ? 'has' : 'have'} the data on the agent console.`,
      agents, degraded: true,
    };
  }
  /* Redact BEFORE the model call, not in the instructions to it. A figure inside
     the context window is disclosed no matter what the system prompt asks. */
  const note = scopeNote(scope);
  const worded = await askAgentBrain(apiKey, {
    system: note ? `${ANSWER_SYSTEM}

${note}` : ANSWER_SYSTEM,
    payload: { question: text, agentData: redactFacts(facts, scope) },
    maxTokens: 500,
    usageSink,
  });
  if (!worded) {
    return { answer: 'I could not reach the AI service just now. The agent console still has the underlying findings.', agents, degraded: true };
  }
  return { answer: worded.trim(), agents, degraded: false };
}
