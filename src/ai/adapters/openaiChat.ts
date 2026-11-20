/**
 * OpenAI-compatible Chat Completions (`POST /chat/completions`, SSE). Used for OpenRouter, LM Studio,
 * Ollama's `/v1` layer and any custom endpoint that implements this wire format.
 */
import type { ProviderAdapter, AdapterContext, GenerateRequest, StreamEvent, DiscoveredModel, ChatMessage, ToolCall } from '../types';
import { providerFetch, requireBody, wrapStreamError, parseArgs } from '../http';
import { parseSse } from '../sse';
import { ProviderError } from '../errors';
import { caps, dataUrl, localCallId } from './common';

export function toChatMessages(system: string | undefined, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      const onlyText = m.content.every((p) => p.type === 'text');
      out.push({
        role: 'user',
        content: onlyText
          ? m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
          : m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: dataUrl(p.mimeType, p.dataBase64) } })),
      });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args ?? {}) } })) } : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

export async function listOpenAiModels(ctx: AdapterContext): Promise<{ id: string; raw: Record<string, unknown> }[]> {
  const res = await providerFetch(ctx, '/models');
  const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!json || !Array.isArray(json.data)) throw new ProviderError('invalid-response', 'The models list did not have the expected `data` array. This endpoint may not implement the OpenAI API.');
  return (json.data as Record<string, unknown>[]).filter((m) => typeof m.id === 'string').map((m) => ({ id: m.id as string, raw: m }));
}

function openRouterModel(raw: Record<string, unknown>): DiscoveredModel {
  const arch = (raw.architecture ?? {}) as { input_modalities?: string[]; output_modalities?: string[] };
  const params = Array.isArray(raw.supported_parameters) ? (raw.supported_parameters as string[]) : [];
  const pricing = (raw.pricing ?? {}) as { prompt?: string; completion?: string };
  const perM = (v: string | undefined): number | null => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) * 1_000_000 : null);
  const input = arch.input_modalities ?? [];
  const output = arch.output_modalities ?? [];
  const textOut = output.includes('text');
  const source = 'OpenRouter models API';
  return {
    id: raw.id as string,
    label: typeof raw.name === 'string' ? raw.name : (raw.id as string),
    capabilities: caps([
      ['text', textOut ? 'declared' : 'unavailable', `${source}: output modalities ${output.join(', ') || 'unknown'}`],
      ['code', textOut ? 'declared' : 'unavailable', `${source}: text output`],
      ['vision', input.includes('image') ? 'declared' : 'unavailable', `${source}: input modalities ${input.join(', ') || 'unknown'}`],
      ['tools', params.includes('tools') ? 'declared' : 'unavailable', `${source}: supported parameters`],
      ['structured-output', params.includes('structured_outputs') || params.includes('response_format') ? 'declared' : 'unknown', `${source}: supported parameters`],
      ['image-generation', output.includes('image') ? 'declared' : 'unavailable', `${source}: output modalities`],
      ['speech-recognition', input.includes('audio') ? 'declared' : 'unknown', `${source}: input modalities`],
      ['video-understanding', input.includes('video') ? 'declared' : 'unknown', `${source}: input modalities`],
    ]),
    contextTokens: typeof raw.context_length === 'number' ? raw.context_length : null,
    pricing: perM(pricing.prompt) !== null || perM(pricing.completion) !== null ? { inputPerMTok: perM(pricing.prompt), outputPerMTok: perM(pricing.completion), source: 'provider' } : null,
    lifecycle: null,
  };
}

export const openAiChatAdapter: ProviderAdapter = {
  protocol: 'openai-chat',

  async listModels(ctx) {
    const models = await listOpenAiModels(ctx);
    if (ctx.config.provider === 'openrouter') return models.map((m) => openRouterModel(m.raw));
    // The plain OpenAI-compatible list only proves the model exists; capabilities stay unknown until verified.
    return models.map((m) => ({ id: m.id, label: m.id, capabilities: {}, contextTokens: null, pricing: null, lifecycle: null }));
  },

  async *stream(ctx: AdapterContext, request: GenerateRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toChatMessages(request.system, request.messages),
      stream: true,
    };
    if (ctx.config.provider === 'openai' || ctx.config.provider === 'openrouter') body.stream_options = { include_usage: true };
    if (request.maxOutputTokens) body.max_tokens = request.maxOutputTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const res = await providerFetch(ctx, '/chat/completions', { body, headers: { Accept: 'text/event-stream' } });
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: string | null = null;
    try {
      for await (const ev of parseSse(requireBody(res), ctx.signal)) {
        if (ev.data === '[DONE]') break;
        const chunk = JSON.parse(ev.data) as {
          error?: { message?: string; code?: number };
          choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null;
        };
        if (chunk.error) throw new ProviderError(chunk.error.code === 429 ? 'rate-limit' : 'server', chunk.error.message ?? 'The provider reported an error mid-stream.');
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          if (delta.content) yield { type: 'text', delta: delta.content };
          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0;
            const entry = pending.get(index) ?? { id: tc.id ?? localCallId(), name: '', args: '' };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
            pending.set(index, entry);
          }
          if (choice.finish_reason) stopReason = choice.finish_reason;
        }
        if (chunk.usage) yield { type: 'usage', inputTokens: chunk.usage.prompt_tokens ?? null, outputTokens: chunk.usage.completion_tokens ?? null, cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? null };
      }
    } catch (error) {
      wrapStreamError(error, ctx.signal);
    }
    if (ctx.signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
    for (const [, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      const call: ToolCall = { id: entry.id, name: entry.name, ...parseArgs(entry.args) };
      yield { type: 'tool-call', call };
    }
    yield { type: 'done', stopReason };
  },
};
