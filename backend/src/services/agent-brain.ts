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

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Same model as the scan-so OCR pipeline — one model, one bill, one behaviour. */
export const AGENT_BRAIN_MODEL = "claude-sonnet-4-6";

export interface AgentBrainUsageSink {
  tokensIn: number;
  tokensOut: number;
}

export interface AskAgentBrainOptions {
  /** System prompt — the agent's voice + task. */
  system: string;
  /** Pre-compacted JSON-serialisable data the brain reasons over. */
  payload: unknown;
  /** Response cap; briefs are one short paragraph, keep this tight. */
  maxTokens?: number;
  /** Accumulates Anthropic token usage for the Agent Console run log. */
  usageSink?: AgentBrainUsageSink;
  /** Optional non-text content blocks (image / document) appended AFTER the text
   *  payload in the user turn — the assistant uses this to let the model READ an
   *  uploaded image or PDF. Every existing caller omits it and is unchanged. */
  contentBlocks?: Array<Record<string, unknown>>;
}

export async function askAgentBrain(
  apiKey: string | undefined,
  opts: AskAgentBrainOptions,
): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch(ANTHROPIC_URL, {
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
    });
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
