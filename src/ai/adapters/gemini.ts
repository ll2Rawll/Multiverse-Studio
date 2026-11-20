/**
 * Google Gemini API: `POST /models/{model}:streamGenerateContent?alt=sse` with `x-goog-api-key`.
 * Discovery reads `GET /models` (supportedGenerationMethods).
 */
import type { ProviderAdapter, AdapterContext, GenerateRequest, StreamEvent, ChatMessage, JsonSchema, DiscoveredModel } from '../types';
import { providerFetch, requireBody, wrapStreamError } from '../http';
import { parseSse } from '../sse';
import { ProviderError } from '../errors';
import { caps, localCallId } from './common';

export function modelPath(model: string): string {
  return `/models/${encodeURIComponent(model.replace(/^models\//, ''))}`;
}

/** Gemini accepts an OpenAPI subset; drop keywords it rejects. */
export function geminiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (schema.type) out.type = schema.type;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum.map(String);
  if (schema.required?.length) out.required = schema.required;
  if (schema.items) out.items = geminiSchema(schema.items);
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, geminiSchema(v)]));
  return out;
}

export function toGeminiContents(messages: ChatMessage[]): unknown[] {
  const out: { role: 'user' | 'model'; parts: unknown[] }[] = [];
  const push = (role: 'user' | 'model', part: unknown): void => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else out.push({ role, parts: [part] });
  };
  for (const m of messages) {
    if (m.role === 'user') for (const p of m.content) push('user', p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mimeType, data: p.dataBase64 } });
    else if (m.role === 'assistant') {
      if (m.text) push('model', { text: m.text });
      for (const c of m.toolCalls) push('model', { functionCall: { name: c.name, args: c.args ?? {}, ...(c.id.startsWith('call_') ? {} : { id: c.id }) } });
    } else {
      push('user', { functionResponse: { name: m.name, response: m.isError ? { error: m.content } : { result: m.content }, ...(m.toolCallId.startsWith('call_') ? {} : { id: m.toolCallId }) } });
    }
  }
  return out;
}

export const geminiAdapter: ProviderAdapter = {
  protocol: 'gemini',

  async listModels(ctx) {
    const out: DiscoveredModel[] = [];
    let token: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res = await providerFetch(ctx, `/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      const json = (await res.json().catch(() => null)) as { models?: Record<string, unknown>[]; nextPageToken?: string } | null;
      if (!json || !Array.isArray(json.models)) throw new ProviderError('invalid-response', 'The models list did not have the expected `models` array.');
      for (const m of json.models) {
        if (typeof m.name !== 'string') continue;
        const methods = Array.isArray(m.supportedGenerationMethods) ? (m.supportedGenerationMethods as string[]) : [];
        const generates = methods.includes('generateContent');
        const id = m.name.replace(/^models\//, '');
        const src = 'Gemini models API';
        out.push({
          id,
          label: typeof m.displayName === 'string' ? m.displayName : id,
          capabilities: caps([
            ['text', generates ? 'declared' : 'unavailable', `${src}: methods ${methods.join(', ') || 'none'}`],
            ['code', generates ? 'declared' : 'unavailable', `${src}: generateContent`],
            ...(methods.includes('predictLongRunning') ? ([['video-generation', 'declared', `${src}: predictLongRunning`]] as const) : []),
          ] as Parameters<typeof caps>[0]),
          contextTokens: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : null,
          pricing: null,
          lifecycle: null,
        });
      }
      if (!json.nextPageToken) break;
      token = json.nextPageToken;
    }
    return out;
  },

  async *stream(ctx: AdapterContext, request: GenerateRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = { contents: toGeminiContents(request.messages) };
    if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
    const generationConfig: Record<string, unknown> = {};
    if (request.maxOutputTokens) generationConfig.maxOutputTokens = request.maxOutputTokens;
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
    const res = await providerFetch(ctx, `${modelPath(request.model)}:streamGenerateContent?alt=sse`, { body, headers: { Accept: 'text/event-stream' } });
    let usage: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null } | null = null;
    let stopReason: string | null = null;
    try {
      for await (const ev of parseSse(requireBody(res), ctx.signal)) {
        const data = JSON.parse(ev.data) as {
          candidates?: { content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name: string; args?: unknown; id?: string } }[] }; finishReason?: string }[];
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
          promptFeedback?: { blockReason?: string };
          error?: { code?: number; message?: string; status?: string };
        };
        if (data.error) throw new ProviderError(data.error.code === 429 ? 'rate-limit' : 'server', data.error.message ?? 'The provider reported an error mid-stream.');
        if (data.promptFeedback?.blockReason) throw new ProviderError('bad-request', `The request was blocked by the provider (${data.promptFeedback.blockReason}).`);
        for (const cand of data.candidates ?? []) {
          for (const part of cand.content?.parts ?? []) {
            if (part.thought) continue;
            if (part.text) yield { type: 'text', delta: part.text };
            if (part.functionCall) yield { type: 'tool-call', call: { id: part.functionCall.id ?? localCallId(), name: part.functionCall.name, args: part.functionCall.args ?? {} } };
          }
          if (cand.finishReason) stopReason = cand.finishReason;
        }
        if (data.usageMetadata) usage = { inputTokens: data.usageMetadata.promptTokenCount ?? null, outputTokens: data.usageMetadata.candidatesTokenCount ?? null, cachedInputTokens: data.usageMetadata.cachedContentTokenCount ?? null };
      }
    } catch (error) {
      wrapStreamError(error, ctx.signal);
    }
    if (ctx.signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
    if (usage) yield { type: 'usage', ...usage };
    yield { type: 'done', stopReason };
  },
};
