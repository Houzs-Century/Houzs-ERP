import { describe, it, expect, vi, afterEach } from 'vitest';
import { askAgentBrainWithTools, type AgentToolDef } from './agent-brain';

const TOOL: AgentToolDef = {
  name: 'search_erp',
  description: 'find things',
  input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

/** An Anthropic-shaped OK response. */
function resp(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call: number): any {
  return JSON.parse((fetchMock.mock.calls[call][1] as { body: string }).body);
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('askAgentBrainWithTools', () => {
  it('returns null (and never calls out) without an api key', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const dispatch = vi.fn();
    const out = await askAgentBrainWithTools(undefined, { system: 's', payload: {}, tools: [TOOL], dispatch });
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('answers directly when the model does not call a tool', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi.' }] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const dispatch = vi.fn();
    const out = await askAgentBrainWithTools('key', { system: 's', payload: {}, tools: [TOOL], dispatch });
    expect(out).toBe('Hi.');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('runs the tool_use handshake, accumulates usage, and answers from the result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        resp({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'search_erp', input: { q: 'SO-1' } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      )
      .mockResolvedValueOnce(
        resp({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Found SO-1.' }],
          usage: { input_tokens: 8, output_tokens: 4 },
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const dispatch = vi.fn().mockResolvedValue({ count: 1 });
    const sink = { tokensIn: 0, tokensOut: 0 };

    const out = await askAgentBrainWithTools('key', {
      system: 's',
      payload: { q: 'SO-1' },
      tools: [TOOL],
      dispatch,
      usageSink: sink,
    });

    expect(out).toBe('Found SO-1.');
    expect(dispatch).toHaveBeenCalledWith('search_erp', { q: 'SO-1' });
    expect(sink.tokensIn).toBe(18);
    expect(sink.tokensOut).toBe(9);
    // The second turn must echo the assistant turn + a tool_result carrying tu_1.
    const second = bodyOf(fetchMock, 1);
    const lastMsg = second.messages[second.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
  });

  it('drops tools on the final turn so a tool-hungry model is forced to answer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        resp({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'search_erp', input: {} }] }),
      )
      .mockResolvedValueOnce(resp({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Final.' }] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await askAgentBrainWithTools('key', {
      system: 's',
      payload: {},
      tools: [TOOL],
      dispatch: vi.fn().mockResolvedValue({}),
      maxTurns: 2,
    });

    expect(out).toBe('Final.');
    expect(bodyOf(fetchMock, 0).tools).toBeDefined(); // first turn offers tools
    expect(bodyOf(fetchMock, 1).tools).toBeUndefined(); // last turn does not
  });

  it('is best-effort: a non-ok response yields null (caller falls back)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 529, json: async () => ({}) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await askAgentBrainWithTools('key', {
      system: 's',
      payload: {},
      tools: [TOOL],
      dispatch: vi.fn(),
    });
    expect(out).toBeNull();
  });

  it('hands a thrown dispatch back to the model as an error result, not a crash', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        resp({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'boom', input: {} }] }),
      )
      .mockResolvedValueOnce(resp({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Recovered.' }] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await askAgentBrainWithTools('key', {
      system: 's',
      payload: {},
      tools: [TOOL],
      dispatch: vi.fn().mockRejectedValue(new Error('kaboom')),
      maxTurns: 5,
    });

    expect(out).toBe('Recovered.');
    const second = bodyOf(fetchMock, 1);
    const toolResult = second.messages[second.messages.length - 1].content[0];
    expect(toolResult.content).toMatch(/failed/);
  });
});
