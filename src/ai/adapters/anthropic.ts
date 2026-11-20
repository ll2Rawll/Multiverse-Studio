/**
 * Anthropic Messages API (`POST /messages`, SSE: message_start, content_block_*, message_delta,
 * message_stop, ping, error). Model capabilities come from `GET /models`.
 */
import type { ProviderAdapter, AdapterContext, GenerateRequest, StreamEvent, ChatMessage, DiscoveredModel } from '../types';
import { providerFetch, requireBody, wrapStreamError, parseArgs } from '../http';
import { parseSse } from '../sse';
import { ProviderError } from '../errors';
import { caps } from './common';

export const ANTHROPIC_VERSION = '2023-06-01';

export function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  const push = (role: 'user' | 'assistant', block: unknown): void => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      for (const p of m.content) push('user', p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.dataBase64 } });
    } else if (m.role === 'assistant') {
      if (m.text) push('assistant', { type: 'text', text: m.text });
      for (const c of m.toolCalls) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
    } else {
      push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) });
    }
  }
  return out;
}

function headers(ctx: AdapterContext): Record<string, string> {
  return { 'anthropic-version': ctx.config.headers['anthropic-version'] ?? ANTHROPIC_VERSION };
}

export const anthropicAdapter: ProviderAdapter = {
  protocol: 'anthropic-messages',

  async listModels(ctx) {
    const out: DiscoveredModel[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res = await providerFetch(ctx, `/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { headers: headers(ctx) });
      const json = (await res.json().catch(() => null)) as { data?: Record<string, unknown>[]; has_more?: boolean; last_id?: string | null } | null;
      if (!json || !Array.isArray(json.data)) throw new ProviderError('invalid-response', 'The models list did not have the expected `data` array.');
      for (const m of json.data) {
        if (typeof m.id !== 'string') continue;
        const c = (m.capabilities ?? null) as Record<string, { supported?: boolean }> | null;
        const flag = (key: string): 'declared' | 'unavailable' | 'unknown' => (c && c[key] ? (c[key]!.supported ? 'declared' : 'unavailable') : 'unknown');
        const src = 'Anthropic models API';
        out.push({
          id: m.id,
          label: typeof m.display_name === 'string' ? m.display_name : m.id,
          capabilities: caps([
            ['text', 'declared', `${src}: Messages API model`],
            ['code', 'declared', `${src}: Messages API model`],
            ['tools', 'declared', 'Messages API models accept user-defined tools'],
            ['vision', flag('image_input'), `${src}: image_input`],
            ['structured-output', flag('structured_outputs'), `${src}: structured_outputs`],
            ['image-generation', 'unavailable', 'The Messages API returns text and tool calls only'],
            ['video-generation', 'unavailable', 'The Messages API returns text and tool calls only'],
          ]),
          contextTokens: typeof m.max_input_tokens === 'number' && m.max_input_tokens > 0 ? m.max_input_tokens : null,
          pricing: null,
          lifecycle: typeof m.lifecycle === 'string' ? m.lifecycle : null,
        });
      }
      if (!json.has_more || !json.last_id) break;
      after = json.last_id;
    }
    return out.filter((m) => m.lifecycle !== 'retired');
  },

  async *stream(ctx: AdapterContext, request: GenerateRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? 4096,
      messages: toAnthropicMessages(request.messages),
      stream: true,
    };
    if (request.system) body.system = request.system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) body.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (request.cache && ctx.config.provider === 'anthropic') applyCacheBreakpoints(body);
    const res = await providerFetch(ctx, '/messages', { body, headers: { ...headers(ctx), Accept: 'text/event-stream' } });
    const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cacheRead: number | null = null;
    let cacheWrite: number | null = null;
    let stopReason: string | null = null;
    try {
      for await (const ev of parseSse(requireBody(res), ctx.signal)) {
        const data = JSON.parse(ev.data) as {
          type: string;
          index?: number;
          message?: { usage?: AnthropicUsage };
          content_block?: { type: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
          usage?: AnthropicUsage;
          error?: { type?: string; message?: string };
        };
        switch (data.type) {
          case 'message_start':
            inputTokens = data.message?.usage?.input_tokens ?? null;
            outputTokens = data.message?.usage?.output_tokens ?? null;
            cacheRead = data.message?.usage?.cache_read_input_tokens ?? null;
            cacheWrite = data.message?.usage?.cache_creation_input_tokens ?? null;
            break;
          case 'content_block_start':
            if (data.content_block) blocks.set(data.index ?? 0, { type: data.content_block.type, id: data.content_block.id ?? '', name: data.content_block.name ?? '', json: '' });
            break;
          case 'content_block_delta':
            if (data.delta?.type === 'text_delta' && data.delta.text) yield { type: 'text', delta: data.delta.text };
            else if (data.delta?.type === 'input_json_delta') {
              const block = blocks.get(data.index ?? 0);
              if (block) block.json += data.delta.partial_json ?? '';
            }
            break;
          case 'content_block_stop': {
            const block = blocks.get(data.index ?? 0);
            if (block?.type === 'tool_use') yield { type: 'tool-call', call: { id: block.id, name: block.name, ...parseArgs(block.json) } };
            break;
          }
          case 'message_delta':
            if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
            if (data.usage?.output_tokens !== undefined) outputTokens = data.usage.output_tokens;
            if (data.usage?.input_tokens !== undefined) inputTokens = data.usage.input_tokens;
            if (data.usage?.cache_read_input_tokens !== undefined) cacheRead = data.usage.cache_read_input_tokens;
            if (data.usage?.cache_creation_input_tokens !== undefined) cacheWrite = data.usage.cache_creation_input_tokens;
            break;
          case 'error': {
            const t = data.error?.type ?? '';
            throw new ProviderError(t === 'rate_limit_error' ? 'rate-limit' : t === 'overloaded_error' || t === 'api_error' ? 'server' : t === 'authentication_error' ? 'auth' : 'bad-request', data.error?.message ?? 'The provider reported an error mid-stream.');
          }
          default:
            break; // ping, message_stop and future event types
        }
      }
    } catch (error) {
      wrapStreamError(error, ctx.signal);
    }
    if (ctx.signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
    // Anthropic's input_tokens excludes cached tokens; report the whole input and the cached part separately.
    const total = inputTokens === null && cacheRead === null && cacheWrite === null ? null : (inputTokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    yield { type: 'usage', inputTokens: total, outputTokens, cachedInputTokens: cacheRead, cacheWriteTokens: cacheWrite };
    yield { type: 'done', stopReason };
  },
};

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Explicit cache breakpoints (Anthropic prompt caching, 5-minute entries): the last tool, the system
 * prompt and the last block of the conversation. The prefix order is tools → system → messages, so a
 * task's later requests read everything up to the previous turn from the cache. Three of the four
 * allowed breakpoints; prompts under the model's minimum are simply not cached.
 */
export function applyCacheBreakpoints(body: Record<string, unknown>): void {
  const mark = { type: 'ephemeral' };
  const tools = body.tools as Record<string, unknown>[] | undefined;
  if (tools?.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: mark };
  if (typeof body.system === 'string' && body.system) body.system = [{ type: 'text', text: body.system, cache_control: mark }];
  const messages = body.messages as { content: Record<string, unknown>[] }[];
  const last = messages[messages.length - 1];
  if (!last) return;
  for (let i = last.content.length - 1; i >= 0; i--) {
    const block = last.content[i]!;
    if (block.type === 'text' && !String(block.text ?? '')) continue; // empty text can't carry a breakpoint
    last.content[i] = { ...block, cache_control: mark };
    break;
  }
}
