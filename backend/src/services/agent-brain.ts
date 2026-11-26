// ---------------------------------------------------------------------------
// agent-brain.ts — the ONE shared Claude caller for every agent family.
// Ported verbatim from HOOKKA (src/api/lib/agent-brain.ts, owner OK
// 2026-07-13 "照搬 verbatim").
//
// Iron rule 2 (AGENTS-BLUEPRINT): deterministic engines do the arithmetic,
// the LLM only does judgment / attribution / language. This helper is the
// "brain socket" each agent plugs its already-computed numbers into:
//
//   askAgentBrain(apiKey, { system, payload, usageSink }) → string | null
//
// Contract, shared by all callers:
//   - best-effort: any failure (no key, HTTP error, empty text) returns null
//     and the agent's deterministic output ships unchanged — the brain can
//     NEVER sink a brief or a cron run (staging has no ANTHROPIC_API_KEY:
//     everything still runs, just without AI paragraphs);
//   - token usage is reported into `usageSink` so recordAgentRun surfaces
//     real spend on the Agent Console;
//   - payload is JSON.stringify'd verbatim — callers pre-compact their data
//     (send the numbers that matter, not whole tables).
// ---------------------------------------------------------------------------

import { recordAi, type AiUsageTag } from "./aiUsage";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Same model as the scan-so OCR pipeline — one model, one bill, one behaviour. */
export const AGENT_BRAIN_MODEL = "claude-sonnet-4-6";

export interface AgentBrainUsageSink {
  tokensIn: number;
  tokensOut: number;
}

export interface AskAgentBrainOptions {
  system: string;
  payload: unknown;
  maxTokens?: number;
  usageSink?: AgentBrainUsageSink;
  aiUsage: AiUsageTag | null;
  contentBlocks?: Array<Record<string, unknown>>;
}

export async function askAgentBrain(
  apiKey: string | undefined,
  opts: AskAgentBrainOptions,
): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const res = await recordAi(opts.aiUsage, fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: AGENT_BRAIN_MODEL,
        max_tokens: opts.maxTokens ?? 700,
        system: opts.system,
        messages: [
          {
            role: "user",
            content:
              opts.contentBlocks && opts.contentBlocks.length
                ? [{ type: "text", text: JSON.stringify(opts.payload) }, ...opts.contentBlocks]
                : JSON.stringify(opts.payload),
          },
        ],
      }),
    }));
    if (!res.ok) {
      console.warn(`[agent-brain] Anthropic ${res.status}`);
      return null;
    }
    const j = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (opts.usageSink && j.usage) {
      opts.usageSink.tokensIn += Number(j.usage.input_tokens) || 0;
      opts.usageSink.tokensOut += Number(j.usage.output_tokens) || 0;
    }
    const text = (j.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  } catch (err) {
    console.warn("[agent-brain] failed:", err);
    return null;
  }
}


/** One tool offered to the model — Anthropic's tool schema shape. */
export interface AgentToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AskAgentBrainWithToolsOptions {
  system: string;
  payload: unknown;
  tools: AgentToolDef[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  maxTokens?: number;
  maxTurns?: number;
  usageSink?: AgentBrainUsageSink;
  aiUsage: AiUsageTag | null;
}

type AnthropicContentBlock =
  | { type: "text"; text?: string }
  | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

export async function askAgentBrainWithTools(
  apiKey: string | undefined,
  opts: AskAgentBrainWithToolsOptions,
): Promise<string | null> {
  if (!apiKey) return null;
  const maxTurns = Math.max(1, opts.maxTurns ?? 5);
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: JSON.stringify(opts.payload) },
  ];
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const offerTools = turn < maxTurns - 1 && opts.tools.length > 0;
      const res = await recordAi(opts.aiUsage, fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: AGENT_BRAIN_MODEL,
          max_tokens: opts.maxTokens ?? 700,
          system: opts.system,
          messages,
          ...(offerTools ? { tools: opts.tools } : {}),
        }),
      }));
      if (!res.ok) {
        console.warn(`[agent-brain] tools Anthropic ${res.status}`);
        return null;
      }
      const j = (await res.json()) as {
        content?: AnthropicContentBlock[];
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (opts.usageSink && j.usage) {
        opts.usageSink.tokensIn += Number(j.usage.input_tokens) || 0;
        opts.usageSink.tokensOut += Number(j.usage.output_tokens) || 0;
      }
      const content = j.content ?? [];
      const toolUses = content.filter(
        (b): b is { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> } =>
          b.type === "tool_use",
      );

      if (offerTools && j.stop_reason === "tool_use" && toolUses.length) {
        messages.push({ role: "assistant", content });
        const results: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
        for (const tu of toolUses) {
          let result: unknown;
          try {
            result = await opts.dispatch(tu.name, tu.input ?? {});
          } catch (err) {
            result = { error: `tool ${tu.name} failed`, detail: String(err) };
          }
          results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result ?? null) });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      const text = content
        .filter((b) => b.type === "text" && typeof (b as { text?: string }).text === "string")
        .map((b) => (b as { text?: string }).text)
        .join("")
        .trim();
      return text || null;
    }
    return null;
  } catch (err) {
    console.warn("[agent-brain] tools failed:", err);
    return null;
  }
}
