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
import { AGENT_BRAIN_MODEL, askAgentBrain, askAgentBrainWithTools, type AgentBrainUsageSink } from './agent-brain';
import type { AiUsageTag } from './aiUsage';
import {
  allowedCapabilityKeys,
  redactFacts,
  scopeNote,
  type AssistantScope,
} from './assistant-scope';
import { AGENT_FAMILIES, type AgentFamily } from './agent-console';
import { agentLabel, parseRouterDecision } from './assistant-teach';
import type { ContentBlock } from './vision-blocks';
import {
  buildAssistantTools,
  dispatchAssistantTool,
  ASSISTANT_TOOLS_GUIDANCE,
  type AssistantToolCtx,
} from './assistant-tools';
import { activeCompanyId, type CompanyScopeCtx } from '../scm/lib/companyScope';

interface Capability {
  key: string;
  answers: string;
  briefTable: string;
  briefOrderCol: 'generated_at' | 'created_at';
  itemsTable: string;
  itemsOpenStatus: 'OPEN' | 'PENDING';
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
    return null;
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
  agents: Array<{ key: string; label: string }>;
  degraded: boolean;
  teach?: { family: AgentFamily; label: string; instruction: string };
}

/**
 * Answer one question. Never throws; never writes.
 */
export async function askAssistant(
  env: Env,
  message: string,
  usageSink?: AgentBrainUsageSink,
  scope: AssistantScope = { canSeeMargin: false, canSeeCommission: false, orderScope: 'own' },
  contentBlocks?: ContentBlock[],
  companyCtx?: CompanyScopeCtx,
): Promise<AssistantAnswer> {
  const apiKey = env.ANTHROPIC_API_KEY;
  const text = (message ?? '').trim();
  const userId = (companyCtx?.get('user') as { id?: unknown } | undefined)?.id;
  const aiUsage: AiUsageTag = {
    env, feature: 'assistant', model: AGENT_BRAIN_MODEL, waitUntil: null,
    companyId: companyCtx ? activeCompanyId(companyCtx) ?? null : null,
    userId: typeof userId === 'number' ? userId : null,
  };
  const hasFiles = !!(contentBlocks && contentBlocks.length);
  if (!text && !hasFiles) {
    return { answer: 'Ask me something about your orders, deliveries, payments, stock or sales.', agents: [], degraded: false };
  }

  if (hasFiles) {
    if (!apiKey) {
      return { answer: 'The assistant needs an AI key to read a file. Please try again later.', agents: [], degraded: true };
    }
    const worded = await askAgentBrain(apiKey, {
      system: FILE_ANSWER_SYSTEM,
      payload: { question: text || 'Read the attached file and summarise what matters for our operations.' },
      maxTokens: 700,
      usageSink,
      aiUsage,
      contentBlocks: contentBlocks as Array<Record<string, unknown>>,
    });
    return { answer: worded?.trim() || 'I could not read that file just now. Please try again.', agents: [], degraded: !worded };
  }

  let keys: string[] = [];
  if (apiKey) {
    const routed = await askAgentBrain(apiKey, {
      system: ROUTER_SYSTEM,
      payload: { question: text, agents: CAPABILITIES.map((c) => ({ key: c.key, answers: c.answers })) },
      maxTokens: 200,
      usageSink,
      aiUsage,
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
  keys = allowedCapabilityKeys(keys, scope);
  const caps = keys.map((k) => byKey.get(k)).filter((c): c is Capability => !!c).slice(0, 4);

  const facts: Record<string, unknown> = {};
  for (const cap of caps) {
    facts[cap.key] = { brief: await latestBrief(env, cap), openItems: await openItems(env, cap) };
  }

  const agents = caps.map((c) => ({ key: c.key, label: c.label }));

  if (!apiKey) {
    return {
      answer:
        caps.length === 0
          ? 'The assistant needs an AI key to answer questions. Until then, the agent console has each agent\'s findings.'
          : `The assistant needs an AI key to word an answer. In the meantime, ${agents.map((a) => a.label).join(' and ')} ${agents.length === 1 ? 'has' : 'have'} the data on the agent console.`,
      agents, degraded: true,
    };
  }
  const note = scopeNote(scope);
  const baseSystem = note ? `${ANSWER_SYSTEM}

${note}` : ANSWER_SYSTEM;
  const payload = { question: text, agentData: redactFacts(facts, scope) };

  if (companyCtx) {
    const toolCtx: AssistantToolCtx = { env, scope, companyCtx, consulted: [] };
    const worded = await askAgentBrainWithTools(apiKey, {
      system: `${baseSystem}

${ASSISTANT_TOOLS_GUIDANCE}`,
      payload,
      tools: buildAssistantTools(scope),
      dispatch: (name, input) => dispatchAssistantTool(toolCtx, name, input),
      maxTokens: 600,
      maxTurns: 5,
      usageSink,
      aiUsage,
    });
    if (worded) {
      const merged = [...agents];
      for (const a of toolCtx.consulted) {
        if (!merged.some((x) => x.key === a.key)) merged.push(a);
      }
      return { answer: worded.trim(), agents: merged, degraded: false };
    }
  }

  const worded = await askAgentBrain(apiKey, {
    system: baseSystem,
    payload,
    maxTokens: 500,
    usageSink,
    aiUsage,
  });
  if (!worded) {
    return { answer: 'I could not reach the AI service just now. The agent console still has the underlying findings.', agents, degraded: true };
  }
  return { answer: worded.trim(), agents, degraded: false };
}
