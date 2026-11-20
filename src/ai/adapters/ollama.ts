/**
 * Ollama native API: `POST /api/chat` (NDJSON stream), `GET /api/tags`, `POST /api/show`.
 * Runs on the user's computer; nothing leaves it.
 */
import type { ProviderAdapter, AdapterContext, GenerateRequest, StreamEvent, ChatMessage, DiscoveredModel } from '../types';
import { providerFetch, requireBody, wrapStreamError } from '../http';
import { parseNdjson } from '../sse';
import { ProviderError } from '../errors';
import { caps, localCallId } from './common';

export function toOllamaMessages(system: string | undefined, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      const images = m.content.filter((p) => p.type === 'image').map((p) => (p.type === 'image' ? p.dataBase64 : ''));
      out.push({ role: 'user', content: m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'), ...(images.length ? { images } : {}) });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.text, ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args ?? {} } })) } : {}) });
    } else {
      out.push({ role: 'tool', content: m.content, tool_name: m.name });
    }
  }
  return out;
}

export const ollamaAdapter: ProviderAdapter = {
  protocol: 'ollama',

  async listModels(ctx) {
    const res = await providerFetch(ctx, '/api/tags');
    const json = (await res.json().catch(() => null)) as { models?: { name?: string; model?: string; details?: { parameter_size?: string } }[] } | null;
    if (!json || !Array.isArray(json.models)) throw new ProviderError('invalid-response', 'Ollama did not return a model list. Is this the Ollama address?');
    const out: DiscoveredModel[] = [];
    for (const m of json.models) {
      const id = m.model ?? m.name;
      if (!id) continue;
      let modelCaps: string[] | null = null;
      try {
        const show = await providerFetch(ctx, '/api/show', { body: { model: id }, timeoutMs: 5000 });
        const info = (await show.json()) as { capabilities?: string[] };
        if (Array.isArray(info.capabilities)) modelCaps = info.capabilities;
      } catch {
        modelCaps = null; // older Ollama versions do not report capabilities
      }
      const has = (c: string): 'declared' | 'unavailable' | 'unknown' => (modelCaps ? (modelCaps.includes(c) ? 'declared' : 'unavailable') : 'unknown');
      const src = modelCaps ? `Ollama /api/show: ${modelCaps.join(', ')}` : 'Ollama did not report capabilities';
      out.push({
        id,
        label: `${id}${m.details?.parameter_size ? ` (${m.details.parameter_size})` : ''}`,
        capabilities: caps([
          ['text', modelCaps ? has('completion') : 'declared', src],
          ['code', modelCaps ? has('completion') : 'declared', src],
          ['vision', has('vision'), src],
          ['tools', has('tools'), src],
        ]),
        contextTokens: null,
        pricing: { inputPerMTok: 0, outputPerMTok: 0, source: 'provider' },
        lifecycle: null,
      });
    }
    return out;
  },

  async *stream(ctx: AdapterContext, request: GenerateRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = { model: request.model, messages: toOllamaMessages(request.system, request.messages), stream: true };
    const options: Record<string, unknown> = {};
    if (request.maxOutputTokens) options.num_predict = request.maxOutputTokens;
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (Object.keys(options).length) body.options = options;
    if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const res = await providerFetch(ctx, '/api/chat', { body });
    try {
      for await (const raw of parseNdjson(requireBody(res), ctx.signal)) {
        const line = raw as { message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string };
        if (line.error) throw new ProviderError(/not found/i.test(line.error) ? 'not-found' : 'server', line.error);
        if (line.message?.content) yield { type: 'text', delta: line.message.content };
        for (const tc of line.message?.tool_calls ?? []) yield { type: 'tool-call', call: { id: localCallId(), name: tc.function?.name ?? '', args: tc.function?.arguments ?? {} } };
        if (line.done) {
          yield { type: 'usage', inputTokens: line.prompt_eval_count ?? null, outputTokens: line.eval_count ?? null };
          yield { type: 'done', stopReason: line.done_reason ?? 'stop' };
          return;
        }
      }
    } catch (error) {
      wrapStreamError(error, ctx.signal);
    }
    if (ctx.signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
    throw new ProviderError('invalid-response', 'The stream ended before Ollama reported completion.');
  },
};
