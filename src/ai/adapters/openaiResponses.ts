/**
 * OpenAI Responses API (`POST /responses`, semantic SSE events). Requests set `store: false`
 * so conversations are not retained server-side for later retrieval.
 */
import type { ProviderAdapter, AdapterContext, GenerateRequest, StreamEvent, ChatMessage } from '../types';
import { providerFetch, requireBody, wrapStreamError, parseArgs } from '../http';
import { parseSse } from '../sse';
import { ProviderError } from '../errors';
import { listOpenAiModels } from './openaiChat';
import { dataUrl } from './common';

export function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      items.push({
        role: 'user',
        content: m.content.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: dataUrl(p.mimeType, p.dataBase64) })),
      });
    } else if (m.role === 'assistant') {
      if (m.text) items.push({ role: 'assistant', content: [{ type: 'output_text', text: m.text }] });
      for (const c of m.toolCalls) items.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args ?? {}) });
    } else {
      items.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
    }
  }
  return items;
}

export const openAiResponsesAdapter: ProviderAdapter = {
  protocol: 'openai-responses',

  async listModels(ctx) {
    // OpenAI's models list only proves that a model id exists for this key; it does not describe
    // capabilities, so they stay unknown until verified or declared by the user.
    return (await listOpenAiModels(ctx)).map((m) => ({ id: m.id, label: m.id, capabilities: {}, contextTokens: null, pricing: null, lifecycle: null }));
  },

  async *stream(ctx: AdapterContext, request: GenerateRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = { model: request.model, input: toResponsesInput(request.messages), stream: true, store: false };
    if (request.system) body.instructions = request.system;
    if (request.maxOutputTokens) body.max_output_tokens = request.maxOutputTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
    // OpenAI caches automatically; a stable key keeps one task's requests on the same cache (documented for the Responses API).
    if (request.cache && ctx.config.provider === 'openai') body.prompt_cache_key = request.cache.key;
    const res = await providerFetch(ctx, '/responses', { body, headers: { Accept: 'text/event-stream' } });
    const args = new Map<string, string>();
    let stopReason: string | null = null;
    try {
      for await (const ev of parseSse(requireBody(res), ctx.signal)) {
        if (ev.data === '[DONE]') break;
        const data = JSON.parse(ev.data) as {
          type?: string;
          delta?: string;
          item_id?: string;
          item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
          response?: { status?: string; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } }; error?: { message?: string; code?: string } | null; incomplete_details?: { reason?: string } | null };
          error?: { message?: string; code?: string };
          message?: string;
        };
        const type = data.type ?? ev.event ?? '';
        if (type === 'response.output_text.delta' && data.delta) yield { type: 'text', delta: data.delta };
        else if (type === 'response.function_call_arguments.delta' && data.item_id) args.set(data.item_id, (args.get(data.item_id) ?? '') + (data.delta ?? ''));
        else if (type === 'response.output_item.done' && data.item?.type === 'function_call') {
          const raw = data.item.arguments ?? args.get(data.item.id ?? '') ?? '';
          yield { type: 'tool-call', call: { id: data.item.call_id ?? data.item.id ?? '', name: data.item.name ?? '', ...parseArgs(raw) } };
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          const u = data.response?.usage;
          if (u) yield { type: 'usage', inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null, cachedInputTokens: u.input_tokens_details?.cached_tokens ?? null, cacheWriteTokens: u.input_tokens_details?.cache_write_tokens ?? null };
          stopReason = type === 'response.incomplete' ? (data.response?.incomplete_details?.reason ?? 'incomplete') : 'completed';
        } else if (type === 'response.failed') {
          throw new ProviderError('server', data.response?.error?.message ?? 'The response failed.');
        } else if (type === 'error') {
          const code = data.error?.code ?? '';
          throw new ProviderError(/rate/.test(code) ? 'rate-limit' : 'server', data.error?.message ?? data.message ?? 'The provider reported an error mid-stream.');
        }
      }
    } catch (error) {
      wrapStreamError(error, ctx.signal);
    }
    if (ctx.signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
    yield { type: 'done', stopReason };
  },
};
