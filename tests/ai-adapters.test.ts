import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { adapterFor } from '../src/ai/adapters';
import { ProviderError } from '../src/ai/errors';
import { parseSse } from '../src/ai/sse';
import { redactor, Redactor } from '../src/ai/redact';
import { AiService } from '../src/ai/service';
import { EncryptedFileVault, MemoryVault, type Cipher } from '../src/ai/vault';
import type { AdapterContext, GenerateRequest, StreamEvent } from '../src/ai/types';
import { presetFor, type ConnectionConfig, type Protocol, type ProviderKind } from '../src/shared/ai';
import { tempDir } from './helpers';

/* ---------- helpers (all provider traffic in this file is mocked) ---------- */

function streamOf(text: string, pieces = 7, opts: { hang?: boolean } = {}): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const size = Math.max(1, Math.ceil(bytes.length / pieces));
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        if (!opts.hang) controller.close();
        return new Promise(() => undefined);
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
      return undefined;
    },
  });
}

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>, calls: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, headers });
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return handler(url, init);
  }) as typeof fetch;
}

function connection(provider: ProviderKind, protocol?: Protocol, baseUrl?: string): ConnectionConfig {
  const preset = presetFor(provider);
  return {
    id: `${provider}-test`,
    name: preset.label,
    provider,
    protocol: protocol ?? preset.protocol,
    baseUrl: baseUrl ?? (preset.baseUrl || 'https://gateway.example.test/v1'),
    authStyle: preset.authStyle,
    headers: {},
    timeoutMs: 5000,
    media: [],
    models: [],
    lastTest: null,
    createdAt: new Date().toISOString(),
  };
}

const KEY = 'sk-test-0123456789abcdefghijklmnop';

function ctx(config: ConnectionConfig, f: typeof fetch, signal?: AbortSignal): AdapterContext {
  return { config, apiKey: config.authStyle === 'none' ? null : KEY, fetch: f, signal };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<{ text: string; events: StreamEvent[] }> {
  const events: StreamEvent[] = [];
  let text = '';
  for await (const ev of gen) {
    events.push(ev);
    if (ev.type === 'text') text += ev.delta;
  }
  return { text, events };
}

const request: GenerateRequest = {
  model: 'model-under-test',
  system: 'Be brief.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }] },
    { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'file body', isError: false },
  ],
  tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }],
  maxOutputTokens: 256,
};

const sse = (events: unknown[], withDone = false): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (withDone ? 'data: [DONE]\n\n' : '');

/* ---------- SSE parsing ---------- */

test('the SSE parser handles split chunks, CRLF, comments, multi-line data and event names', async () => {
  const text = ': keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\n: OPENROUTER PROCESSING\n\ndata: {"x":1}\n\n';
  const events = [];
  for await (const ev of parseSse(streamOf(text, 13))) events.push(ev);
  assert.deepEqual(events.map((e) => [e.event, e.data]), [['a', 'one\ntwo'], [null, '{"x":1}']]);
});

/* ---------- OpenAI-compatible chat ---------- */

test('openai-chat streams text, assembles tool calls across chunks and reports usage', async () => {
  const calls: Captured[] = [];
  const body =
    ': OPENROUTER PROCESSING\n\n' +
    sse(
      [
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_', arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"x.md"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
      ],
      true,
    );
  const f = mockFetch(() => new Response(streamOf(body, 9), { status: 200 }), calls);
  const { text, events } = await collect(adapterFor('openai-chat').stream(ctx(connection('openrouter'), f), request));
  assert.equal(text, 'Hello');
  const call = events.find((e) => e.type === 'tool-call');
  assert.deepEqual(call, { type: 'tool-call', call: { id: 'call_a', name: 'read_file', args: { path: 'x.md' } } });
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 12, outputTokens: 7, cachedInputTokens: null });
  assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
  const sent = calls[0]!.body!;
  assert.equal((sent.messages as { role: string }[])[0]!.role, 'system');
  assert.deepEqual((sent.messages as Record<string, unknown>[])[2], { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] });
  assert.deepEqual((sent.messages as Record<string, unknown>[])[3], { role: 'tool', tool_call_id: 'call_1', content: 'file body' });
});

test('local OpenAI-compatible servers get no Authorization header and no OpenAI-only options', async () => {
  const calls: Captured[] = [];
  const f = mockFetch(() => new Response(streamOf(sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }], true)), { status: 200 }), calls);
  await collect(adapterFor('openai-chat').stream(ctx(connection('lmstudio'), f), { model: 'local', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }));
  assert.equal(calls[0]!.url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(calls[0]!.headers.authorization, undefined);
  assert.equal(calls[0]!.body!.stream_options, undefined);
});

/* ---------- OpenAI Responses ---------- */

test('openai-responses maps items, sets store:false and parses semantic events', async () => {
  const calls: Captured[] = [];
  const body = sse([
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_text.delta', delta: 'Hi ' },
    { type: 'response.output_text.delta', delta: 'there' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_z', name: 'read_file', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"b.md"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_z', name: 'read_file' } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 30, output_tokens: 9 } } },
  ]);
  const f = mockFetch(() => new Response(streamOf(body, 11)), calls);
  const { text, events } = await collect(adapterFor('openai-responses').stream(ctx(connection('openai'), f), request));
  assert.equal(text, 'Hi there');
  assert.deepEqual(events.find((e) => e.type === 'tool-call'), { type: 'tool-call', call: { id: 'call_z', name: 'read_file', args: { path: 'b.md' } } });
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 30, outputTokens: 9, cachedInputTokens: null, cacheWriteTokens: null });
  const sent = calls[0]!.body!;
  assert.equal(calls[0]!.url, 'https://api.openai.com/v1/responses');
  assert.equal(sent.store, false);
  assert.equal(sent.instructions, 'Be brief.');
  assert.deepEqual((sent.input as unknown[]).slice(1), [
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
  ]);
  assert.deepEqual((sent.tools as unknown[])[0], { type: 'function', name: 'read_file', description: 'Read a file', parameters: request.tools![0]!.parameters });
});

/* ---------- Anthropic ---------- */

test('anthropic-messages sends the documented headers, groups tool results and streams tool input JSON', async () => {
  const calls: Captured[] = [];
  const body = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":40,"output_tokens":1}}}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"c"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":".md\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":22}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  const f = mockFetch(() => new Response(streamOf(body, 17)), calls);
  const { text, events } = await collect(adapterFor('anthropic-messages').stream(ctx(connection('anthropic'), f), request));
  assert.equal(text, 'Looking');
  assert.deepEqual(events.find((e) => e.type === 'tool-call'), { type: 'tool-call', call: { id: 'toolu_1', name: 'read_file', args: { path: 'c.md' } } });
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 40, outputTokens: 22, cachedInputTokens: null, cacheWriteTokens: null });
  assert.equal(calls[0]!.headers['x-api-key'], KEY);
  assert.equal(calls[0]!.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0]!.headers.authorization, undefined);
  const sent = calls[0]!.body!;
  assert.equal(sent.max_tokens, 256);
  assert.equal(sent.system, 'Be brief.');
  assert.deepEqual(sent.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' }] },
  ]);
});

test('anthropic mid-stream errors are classified', async () => {
  const body = 'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}\n\n';
  const f = mockFetch(() => new Response(streamOf(body)));
  await assert.rejects(collect(adapterFor('anthropic-messages').stream(ctx(connection('anthropic'), f), request)), (e: unknown) => e instanceof ProviderError && e.kind === 'rate-limit');
});

/* ---------- Gemini ---------- */

test('gemini streams generateContent chunks, function calls and usage with x-goog-api-key', async () => {
  const calls: Captured[] = [];
  const body = sse([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Sure' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'd.md' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } },
  ]);
  const f = mockFetch(() => new Response(streamOf(body, 5)), calls);
  const { text, events } = await collect(adapterFor('gemini').stream(ctx(connection('gemini'), f), { ...request, model: 'models/gem-test' }));
  assert.equal(text, 'Sure');
  const call = events.find((e) => e.type === 'tool-call') as Extract<StreamEvent, { type: 'tool-call' }>;
  assert.equal(call.call.name, 'read_file');
  assert.deepEqual(call.call.args, { path: 'd.md' });
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 5, outputTokens: 3, cachedInputTokens: null });
  assert.equal(calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gem-test:streamGenerateContent?alt=sse');
  assert.equal(calls[0]!.headers['x-goog-api-key'], KEY);
  assert.ok(!calls[0]!.url.includes(KEY), 'the key is never put in the URL');
  const decl = ((calls[0]!.body!.tools as { functionDeclarations: { parameters: Record<string, unknown> }[] }[])[0]!).functionDeclarations[0]!;
  assert.equal(decl.parameters.additionalProperties, undefined, 'unsupported schema keywords are removed');
  assert.deepEqual((calls[0]!.body!.contents as unknown[])[2], { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { result: 'file body' } } }] });
});

/* ---------- Ollama ---------- */

test('ollama parses the NDJSON stream and requires a done line', async () => {
  const lines = [
    { message: { role: 'assistant', content: 'Lo' }, done: false },
    { message: { role: 'assistant', content: 'cal', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'e.md' } } }] }, done: false },
    { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 8, eval_count: 4 },
  ];
  const calls: Captured[] = [];
  const f = mockFetch(() => new Response(streamOf(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 6)), calls);
  const { text, events } = await collect(adapterFor('ollama').stream(ctx(connection('ollama'), f), request));
  assert.equal(text, 'Local');
  assert.equal((events.find((e) => e.type === 'tool-call') as Extract<StreamEvent, { type: 'tool-call' }>).call.name, 'read_file');
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 8, outputTokens: 4 });
  assert.equal(calls[0]!.url, 'http://localhost:11434/api/chat');
  const truncated = mockFetch(() => new Response(streamOf(JSON.stringify(lines[0]) + '\n')));
  await assert.rejects(collect(adapterFor('ollama').stream(ctx(connection('ollama'), truncated), request)), (e: unknown) => e instanceof ProviderError && e.kind === 'invalid-response');
});

/* ---------- errors, cancellation, redaction ---------- */

test('HTTP errors are classified and keys echoed by a provider are redacted', async () => {
  const echo = mockFetch(() => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), { status: 401 }));
  await assert.rejects(collect(adapterFor('openai-chat').stream(ctx(connection('openrouter'), echo), request)), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.kind, 'auth');
    assert.ok(!e.message.includes(KEY), e.message);
    return true;
  });
  redactor.setSecrets([]);
  const limited = mockFetch(() => new Response('{"error":{"message":"Too many"}}', { status: 429, headers: { 'retry-after': '12' } }));
  await assert.rejects(collect(adapterFor('openai-responses').stream(ctx(connection('openai'), limited), request)), (e: unknown) => e instanceof ProviderError && e.kind === 'rate-limit' && e.retryAfter === 12);
  const quota = mockFetch(() => new Response('{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}', { status: 429 }));
  await assert.rejects(collect(adapterFor('openai-chat').stream(ctx(connection('openrouter'), quota), request)), (e: unknown) => e instanceof ProviderError && e.kind === 'quota');
  const down = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(collect(adapterFor('anthropic-messages').stream(ctx(connection('anthropic'), down), request)), (e: unknown) => e instanceof ProviderError && e.kind === 'network');
});

test('aborting mid-stream stops promptly with a cancelled error', async () => {
  const controller = new AbortController();
  const body = sse([{ choices: [{ delta: { content: 'partial' } }] }]);
  const f = mockFetch(() => new Response(streamOf(body, 1, { hang: true })));
  const gen = adapterFor('openai-chat').stream(ctx(connection('openrouter'), f, controller.signal), request);
  const first = await gen.next();
  assert.deepEqual(first.value, { type: 'text', delta: 'partial' });
  controller.abort();
  const started = Date.now();
  await assert.rejects(gen.next(), (e: unknown) => e instanceof ProviderError && e.kind === 'cancelled');
  assert.ok(Date.now() - started < 1000);
});

test('the redactor removes known keys and common key formats, including in nested values', () => {
  const r = new Redactor();
  r.setSecrets(['my-custom-secret-value']);
  const out = r.redact('k=my-custom-secret-value sk-ant-api03-abcdefghijklmnopqrstuvwx AIzaSyA1234567890abcdefghijklmnopqrstu Authorization: Bearer abc.def.ghijklmnop https://x.test/?key=supersecretvalue1');
  assert.ok(!/my-custom-secret-value|sk-ant-api03|AIzaSy|abc\.def\.ghij|supersecretvalue1/.test(out), out);
  assert.deepEqual(r.redactValue({ apiKey: 'zzzz', nested: ['my-custom-secret-value'] }), { apiKey: '[redacted]', nested: ['[redacted]'] });
});

/* ---------- discovery and declared capabilities ---------- */

test('discovery maps provider metadata to declared capabilities and prices', async () => {
  const anthropic = mockFetch(() =>
    Response.json({
      data: [
        { id: 'claude-a', display_name: 'A', capabilities: { image_input: { supported: true }, structured_outputs: { supported: false } }, lifecycle: 'active', max_input_tokens: 200000 },
        { id: 'claude-old', display_name: 'Old', capabilities: null, lifecycle: 'retired' },
      ],
      has_more: false,
    }),
  );
  const a = await adapterFor('anthropic-messages').listModels(ctx(connection('anthropic'), anthropic));
  assert.deepEqual(a.map((m) => m.id), ['claude-a']);
  assert.equal(a[0]!.capabilities.vision?.state, 'declared');
  assert.equal(a[0]!.capabilities['structured-output']?.state, 'unavailable');
  assert.equal(a[0]!.contextTokens, 200000);

  const openrouter = mockFetch(() =>
    Response.json({ data: [{ id: 'v/m', name: 'M', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools'], pricing: { prompt: '0.000002', completion: '0.00001' }, context_length: 128000 }] }),
  );
  const o = await adapterFor('openai-chat').listModels(ctx(connection('openrouter'), openrouter));
  assert.equal(o[0]!.capabilities.tools?.state, 'declared');
  assert.equal(o[0]!.capabilities.vision?.state, 'declared');
  assert.equal(o[0]!.capabilities['image-generation']?.state, 'unavailable');
  assert.ok(Math.abs(o[0]!.pricing!.inputPerMTok! - 2) < 1e-9 && Math.abs(o[0]!.pricing!.outputPerMTok! - 10) < 1e-9);

  const plain = mockFetch(() => Response.json({ data: [{ id: 'gpt-x' }] }));
  const p = await adapterFor('openai-responses').listModels(ctx(connection('openai'), plain));
  assert.deepEqual(p[0]!.capabilities, {}, 'a bare model list proves existence only');

  const notOpenAi = mockFetch(() => Response.json({ models: [] }));
  await assert.rejects(adapterFor('openai-chat').listModels(ctx(connection('openai-compatible', 'openai-chat', 'https://other.test/v1'), notOpenAi)), (e: unknown) => e instanceof ProviderError && e.kind === 'invalid-response');
});

/* ---------- service: connections, keys, routing ---------- */

test('the AI service keeps keys out of state and settings, validates connections and routes by capability', async () => {
  const { dir, cleanup } = await tempDir('mv-ai-');
  try {
    const settings = path.join(dir, 'ai-settings.json');
    const calls: Captured[] = [];
    const f = mockFetch((url) => (url.endsWith('/models') ? Response.json({ data: [{ id: 'm-tools', name: 'T', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'] }, { id: 'm-plain', name: 'P', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: [] }] }) : new Response('', { status: 404 })), calls);
    const service = new AiService(settings, new MemoryVault(), f);

    await assert.rejects(service.saveConnection({ name: 'x', provider: 'openai-compatible', protocol: 'openai-chat', baseUrl: 'http://remote.example.com/v1' }), /only allowed for servers on this computer/);
    await assert.rejects(service.saveConnection({ name: 'x', provider: 'openai-compatible', protocol: 'openai-chat', baseUrl: 'https://g.test/v1', headers: { Authorization: 'Bearer x' } }), /API key field/);
    // Credentials under other header names, or key-shaped values, are refused too; ordinary headers are kept.
    await assert.rejects(service.saveConnection({ name: 'x', provider: 'openai-compatible', protocol: 'openai-chat', baseUrl: 'https://g.test/v1', headers: { 'X-Portkey-Api-Key': 'abc' } }), /API key field/);
    await assert.rejects(service.saveConnection({ name: 'x', provider: 'openai-compatible', protocol: 'openai-chat', baseUrl: 'https://g.test/v1', headers: { 'X-Extra': 'sk-proj-abcdefghijklmnopqrstuvwxyz' } }), /API key field/);
    await new AiService(path.join(dir, 'other.json'), new MemoryVault(), f).saveConnection({ name: 'ok', provider: 'openai-compatible', protocol: 'openai-chat', baseUrl: 'https://g.test/v1', headers: { 'HTTP-Referer': 'https://studio.example', 'X-Title': 'Multiverse Studio' } });
    await assert.rejects(service.saveConnection({ name: 'x', provider: 'anthropic', protocol: 'openai-chat', baseUrl: 'https://api.anthropic.com/v1' }), /own adapter/);

    const id = await service.saveConnection({ name: 'Router', provider: 'openrouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1' });
    const untested = await service.test(id);
    assert.equal(untested.ok, false);
    assert.equal(untested.kind, 'not-configured');
    assert.equal(calls.length, 0, 'no request is sent without a key');

    await assert.rejects(service.setKey(id, KEY, 'persistent'), /session only/);
    await service.setKey(id, KEY, 'session');
    const tested = await service.test(id);
    assert.ok(tested.ok, tested.message);
    assert.equal(tested.modelCount, 2);

    const state = await service.state();
    assert.deepEqual(state.connections[0]!.key, { present: true, storage: 'session' });
    assert.equal(state.vault.persistent, false);
    assert.ok(!JSON.stringify(state).includes(KEY), 'the state view never contains the key');
    assert.ok(!(await fs.readFile(settings, 'utf8')).includes(KEY), 'the settings file never contains the key');

    await assert.rejects(service.setRoute('coding', { connectionId: id, modelId: 'm-plain' }), (e: unknown) => e instanceof ProviderError && /cannot do tool calling/.test(e.message) && /T on Router can/.test(e.message));
    await service.setRoute('coding', { connectionId: id, modelId: 'm-tools' });
    const route = await service.resolve('coding');
    assert.equal(route.model.id, 'm-tools');
    assert.equal(service.estimateCost(route.model, 1000, 1000), null, 'unknown prices give no estimate');
    await service.setPricing(id, 'm-tools', 3, 15);
    const priced = await service.resolve('coding');
    assert.ok(Math.abs(service.estimateCost(priced.model, 1_000_000, 100_000)! - 4.5) < 1e-9);
    await assert.rejects(service.resolve('image-generation'), (e: unknown) => e instanceof ProviderError && e.kind === 'not-configured');
    await assert.rejects(service.setRoute('private-text', { connectionId: id, modelId: 'm-tools' }), /computer/);

    await service.deleteConnection(id);
    assert.equal((await service.state()).connections.length, 0);
    assert.equal(await service.vault.get(id), null, 'deleting a connection deletes its key');
  } finally {
    await cleanup();
  }
});

test('the encrypted vault writes ciphertext only and refuses to persist without OS encryption', async () => {
  const { dir, cleanup } = await tempDir('mv-vault-');
  try {
    let available = true;
    const cipher: Cipher = {
      available: () => available,
      backend: () => 'test cipher',
      encrypt: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
      decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
    };
    const file = path.join(dir, 'credentials.json');
    const vault = new EncryptedFileVault(file, cipher);
    assert.equal(await vault.set('c1', KEY, 'persistent'), 'os-encrypted');
    const raw = await fs.readFile(file, 'utf8');
    assert.ok(!raw.includes(KEY) && !raw.includes('0123456789'), 'no plaintext on disk');
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o077, 0, 'only this user can read the key file');
    // Keys saved at the same moment are all kept.
    await Promise.all([vault.set('a', 'key-a', 'persistent'), vault.set('b', 'key-b', 'persistent'), vault.set('c', 'key-c', 'persistent')]);
    const reopened = new EncryptedFileVault(file, cipher);
    assert.deepEqual([await reopened.get('a'), await reopened.get('b'), await reopened.get('c')], ['key-a', 'key-b', 'key-c']);
    assert.equal(await reopened.get('c1'), KEY);
    assert.deepEqual(await reopened.describe('c1'), { present: true, storage: 'os-encrypted' });
    available = false;
    const noOs = new EncryptedFileVault(path.join(dir, 'other.json'), cipher);
    assert.equal((await noOs.status()).persistent, false);
    await assert.rejects(noOs.set('c2', KEY, 'persistent'), /cannot be saved/);
    assert.equal(await noOs.set('c2', KEY, 'session'), 'session');
    await assert.rejects(fs.stat(path.join(dir, 'other.json')), 'session keys never create a file');
  } finally {
    await cleanup();
  }
});

test('settings updates are serialized: concurrent changes are all kept', async () => {
  const { AiSettingsStore } = await import('../src/ai/store');
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'mv-store-'));
  try {
    const store = new AiSettingsStore(pathMod.join(dir, 'settings.json'));
    await Promise.all([
      store.update((s) => void (s.budgets.maxToolIterations = 7)),
      store.update((s) => void (s.budgets.maxMinutes = 3)),
    ]);
    const fresh = new AiSettingsStore(pathMod.join(dir, 'settings.json'));
    const b = (await fresh.read()).budgets;
    assert.equal(b.maxToolIterations, 7);
    assert.equal(b.maxMinutes, 3);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
