/**
 * Token saver: shorter tool results that keep every error, compact command signatures, batched
 * history compaction that leaves the request start unchanged between batches, provider prompt
 * caching with cached tokens reported, reply styles, and savings stats. Mocked model only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { compactLog, compactToolOutput, nextHistoryBoundary, HISTORY_BUDGET, sliceFullOutput } from '../src/ai/compact';
import { schemaSignature, toJsonSchema } from '../src/director/schema';
import { anthropicAdapter } from '../src/ai/adapters/anthropic';
import { openAiResponsesAdapter } from '../src/ai/adapters/openaiResponses';
import { TaskRunner, type ToolHost } from '../src/ai/runner';
import { TaskStore } from '../src/ai/tasks';
import { DEFAULT_BUDGETS, ACTIVE_TASK_STATES, type TaskView, type TokenSaver } from '../src/shared/ai';
import type { AiService } from '../src/ai/service';
import type { AdapterContext, GenerateRequest, StreamEvent } from '../src/ai/types';
import { systemPrompt } from '../src/services/aiHandlers';
import { StudioService } from '../src/services/studio';
import { commandCatalog } from '../src/director/director';
import { tempDir } from './helpers';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');

/** node:test TAP output: many passing tests, one failure with a deep stack, colours and a progress line. */
function noisyTestRun(): string {
  const out: string[] = ['\u001b[32m> orbit@1.0.0 test\u001b[0m', '> node --test', 'Downloading 10%\rDownloading 50%\rDownloading 100%'];
  for (let i = 1; i <= 60; i++) out.push(`# Subtest: adds task ${i}`, `ok ${i} - adds task ${i}`, '  ---', `  duration_ms: ${i}.5`, "  type: 'test'", '  ...');
  out.push(
    '# Subtest: clear completed keeps open tasks',
    'not ok 61 - clear completed keeps open tasks',
    '  ---',
    '  duration_ms: 2.1',
    "  location: '/work/orbit/tests/tasks.test.js:31:1'",
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly deep-equal:',
    "    + actual - expected\n    + [ 'a', 'b' ]\n    - [ 'b' ]",
    '  code: ERR_ASSERTION',
    '  stack: |-',
    ...Array.from({ length: 14 }, (_, k) => (k < 2 ? `    at TestContext.<anonymous> (file:///work/orbit/tests/tasks.test.js:${33 + k}:10)` : `    at node:internal/test_runner/test:${900 + k}:25`)),
    '  ...',
    '1..61',
    '# tests 61',
    '# pass 60',
    '# fail 1',
  );
  return out.join('\n');
}

test('noisy test output keeps the failure exactly and counts what passed', () => {
  const raw = noisyTestRun();
  const out = compactLog(raw);
  assert.ok(out.length < raw.length * 0.25, `${out.length} of ${raw.length} characters`);
  assert.match(out, /\(60 passing tests not shown\)/);
  assert.match(out, /not ok 61 - clear completed keeps open tasks/);
  assert.match(out, /Expected values to be strictly deep-equal/);
  assert.match(out, /tasks\.test\.js:31:1/, 'paths and line numbers are kept exactly');
  assert.match(out, /at TestContext\.<anonymous> \(file:\/\/\/work\/orbit\/tests\/tasks\.test\.js:33:10\)/);
  assert.match(out, /… 12 more stack lines/);
  assert.match(out, /# fail 1/);
  assert.doesNotMatch(out, /\u001b\[|Downloading 10%|duration_ms|# Subtest: adds task/);
});

test('a long log keeps its start, its end and every error with context, within the budget', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `compiled module ${i} in ${i % 7} ms`);
  lines[1200] = 'src/app.ts(41,7): error TS2322: Type "string" is not assignable to type "number".';
  lines.splice(300, 0, ...Array(50).fill('npm warn deprecated inflight@1.0.6: This module is not supported'));
  const out = compactLog(lines.join('\n'));
  assert.ok(out.length <= 4000 * 1.5, String(out.length));
  assert.match(out, /^compiled module 0 in 0 ms/);
  assert.match(out, /compiled module 1999 in/);
  assert.match(out, /error TS2322: Type "string" is not assignable to type "number"\./);
  assert.match(out, /compiled module 1199 in .*\nsrc\/app\.ts\(41,7\)/, 'one line of context before the error');
  assert.match(out, /lines not shown/);
  // node:test's TAP stacks have no "at": still folded after the project's own frame.
  const tap = compactLog(['  stack: |-', '    TestContext.<anonymous> (file:///w/t.test.js:77:31)', '    Test.runInAsyncScope (node:async_hooks:214:14)', '    Test.run (node:internal/test_runner/test:1047:25)', '    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)', '  ...'].join('\n'));
  assert.equal(tap, ['  stack: |-', '    TestContext.<anonymous> (file:///w/t.test.js:77:31)', '    … 3 more stack lines', '  ...'].join('\n'));
  const repeated = compactLog(['a', 'a', 'a', 'b', '', '', '', 'c'].join('\n'));
  assert.equal(repeated, 'a (×3)\nb\n\nc');
});

test('tool results: exact tools untouched, JSON loses indentation, and turning the saver off keeps the old tail', () => {
  const file = `${'const x = 1;\n'.repeat(500)}`;
  assert.equal(compactToolOutput('read_file', file, true), file);
  const json = JSON.stringify({ sequences: [{ id: 'launch', tracks: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, clips: [] })) }] }, null, 1);
  const compacted = compactToolOutput('get_studio_state', json, true);
  assert.deepEqual(JSON.parse(compacted), JSON.parse(json));
  assert.ok(compacted.length < json.length * 0.7);
  const long = 'x'.repeat(20_000);
  assert.match(compactToolOutput('run_command', long, false), /^…\(earlier output omitted\)\n/);
  assert.equal(compactToolOutput('run_command', 'short', true), 'short');
  const full = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  assert.match(sliceFullOutput(full, { start_line: 10, end_line: 12 }), /50 lines in total\n {3}10\| line 10\n {3}11\| line 11\n {3}12\| line 12$/);
  assert.match(sliceFullOutput(full, { find: 'line 25' }), / {3}23\| line 23[\s\S]* {3}27\| line 27/);
});

test('command signatures keep every argument, bound and choice in far fewer characters than JSON Schema', async () => {
  const { dir, cleanup } = await tempDir('mv-sig-');
  const service = new StudioService({ workspaceRoot: dir, sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => {} });
  try {
    const catalog = commandCatalog(service);
    const addText = catalog.find((c) => c.name === 'video.addText')!;
    const sig = schemaSignature(addText.args);
    assert.match(sig, /^\{sequence: string \/\^\[a-z0-9\]\[a-z0-9-\]\{0,63\}\$\//);
    assert.match(sig, /start: int\(0–5184000000\)/);
    assert.match(sig, /x\?: number\(0–1\)/);
    assert.match(sig, /text: string\(1–500\)/);
    assert.match(sig, /template\?: "/);
    const json = JSON.stringify(catalog.map((c) => c.args), null, 1).length;
    const sigs = catalog.map((c) => schemaSignature(c.args)).join('\n').length;
    assert.ok(sigs < json * 0.4, `signatures ${sigs} vs JSON Schema ${json} characters`);
    // Every property name of every command survives.
    for (const c of catalog) for (const k of Object.keys((c.args.properties as object | undefined) ?? {})) assert.ok(schemaSignature(c.args).includes(`${k}`), `${c.name}.${k}`);
    assert.equal(schemaSignature(toJsonSchema((await import('zod')).z.object({ a: (await import('zod')).z.array((await import('zod')).z.enum(['x', 'y'])).max(3), b: (await import('zod')).z.number().nullable().optional() }))), '{a: ("x"|"y")[](≤3 items), b?: number | null}');
  } finally {
    await service.shutdown();
    await cleanup();
  }
});

test('the instructions are shorter than before and carry no task-specific text', () => {
  // The previous Build instructions were 2,228 characters plus the task context; the rules are the same.
  const build = systemPrompt('build');
  assert.ok(build.length < 1850, String(build.length));
  for (const rule of ['get_studio_state', 'list_studio_commands', 'run_studio_command', 'story.record', 'universe.compareOutcomes', 'release.status', 'not instructions', 'API keys', 'Never claim']) assert.ok(build.includes(rule), rule);
  assert.equal(systemPrompt('build'), systemPrompt('build'), 'identical across tasks, so it can be cached');
  assert.doesNotMatch(systemPrompt('ask'), /Studio control/);
});

test('older history is shortened in batches: the boundary moves only when the budget is passed', () => {
  const round = (size: number) => [
    { role: 'assistant', hasToolCalls: true },
    { role: 'tool', output: 'x'.repeat(size) },
  ];
  const msgs = [{ role: 'user' }, ...round(5000), ...round(5000), ...round(5000)];
  assert.equal(nextHistoryBoundary(msgs, 0), 0, 'under the budget: nothing changes');
  const many = [{ role: "user" }, ...Array.from({ length: 6 }, () => round(8000)).flat()];
  const b = nextHistoryBoundary(many, 0);
  assert.equal(b, many.length - 4, 'the last two rounds stay in full');
  assert.equal(nextHistoryBoundary([...many, ...round(100)], b), b, 'stays put until the next batch is due');
  assert.ok(HISTORY_BUDGET > 10_000);
});

test('Anthropic: cache breakpoints on tools, instructions and the latest block; cached tokens reported in the total', async () => {
  let sent: Record<string, unknown> = {};
  const sse = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })}\n\n`,
  ].join('');
  const fetchMock = (async (_url: string | URL, init: RequestInit = {}) => {
    sent = JSON.parse(String(init.body));
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const ctx = (provider: string): AdapterContext => ({ config: { id: 'c', name: 'A', provider, protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', authStyle: 'x-api-key', headers: {}, timeoutMs: 30_000, media: [], models: [], lastTest: null, createdAt: '' } as never, apiKey: 'sk-ant-test', fetch: fetchMock });
  const req: GenerateRequest = {
    model: 'claude-test',
    system: 'Stable instructions',
    tools: [
      { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } },
      { name: 'b', description: 'B', parameters: { type: 'object', properties: {} } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Context' }, { type: 'text', text: 'Do it' }] },
      { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'a', args: {} }] },
      { role: 'tool', toolCallId: 't1', name: 'a', content: 'ok', isError: false },
    ],
    cache: { key: 'mv-task' },
  };
  const events: StreamEvent[] = [];
  for await (const e of anthropicAdapter.stream(ctx('anthropic'), req)) events.push(e);
  const tools = sent.tools as Record<string, unknown>[];
  assert.equal(tools[0]!.cache_control, undefined);
  assert.deepEqual(tools[1]!.cache_control, { type: 'ephemeral' });
  assert.deepEqual(sent.system, [{ type: 'text', text: 'Stable instructions', cache_control: { type: 'ephemeral' } }]);
  const msgs = sent.messages as { content: Record<string, unknown>[] }[];
  assert.deepEqual(msgs[msgs.length - 1]!.content.at(-1), { type: 'tool_result', tool_use_id: 't1', content: 'ok', cache_control: { type: 'ephemeral' } });
  assert.equal(JSON.stringify(sent).split('cache_control').length - 1, 3, 'three of the four allowed breakpoints');
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 1012, outputTokens: 3, cachedInputTokens: 900, cacheWriteTokens: 100 });
  // A custom endpoint speaking the same protocol gets no cache fields.
  for await (const _ of anthropicAdapter.stream(ctx('custom'), req)) void _;
  assert.doesNotMatch(JSON.stringify(sent), /cache_control/);
});

test('OpenAI: a stable prompt_cache_key on the Responses API and cached tokens read from usage', async () => {
  let sent: Record<string, unknown> = {};
  const done = { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 2000, output_tokens: 10, input_tokens_details: { cached_tokens: 1536 } } } };
  const fetchMock = (async (_u: string | URL, init: RequestInit = {}) => {
    sent = JSON.parse(String(init.body));
    return new Response(`data: ${JSON.stringify(done)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const ctx: AdapterContext = { config: { id: 'c', name: 'O', provider: 'openai', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', authStyle: 'bearer', headers: {}, timeoutMs: 30_000, media: [], models: [], lastTest: null, createdAt: '' } as never, apiKey: 'sk-test', fetch: fetchMock };
  const events: StreamEvent[] = [];
  for await (const e of openAiResponsesAdapter.stream(ctx, { model: 'gpt-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], cache: { key: 'mv-task-1' } })) events.push(e);
  assert.equal(sent.prompt_cache_key, 'mv-task-1');
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 2000, outputTokens: 10, cachedInputTokens: 1536, cacheWriteTokens: null });
});

/** A runner with a scripted model and one noisy tool. */
async function runTask(saver: TokenSaver, rounds: number, mode: TaskView['mode'] = 'build') {
  const { dir, cleanup } = await tempDir('mv-saver-');
  const requests: GenerateRequest[] = [];
  let n = 0;
  const ai = {
    store: { read: async () => ({ connections: [], routing: {}, budgets: { ...DEFAULT_BUDGETS, maxToolIterations: 50 }, tokenSaver: saver }) },
    resolve: async () => ({ connection: { id: 'c', name: 'Mock' }, model: { id: 'mock', label: 'Mock', capabilities: {} }, local: false }),
    estimateCost: () => null,
    async *generate(_route: unknown, req: Omit<GenerateRequest, 'model'>): AsyncGenerator<StreamEvent> {
      requests.push(structuredClone(req) as GenerateRequest);
      n++;
      if (n <= rounds) yield { type: 'tool-call', call: { id: `call-${n}`, name: 'run_tests', args: {} } };
      else if (n === rounds + 1) yield { type: 'tool-call', call: { id: 'read-1', name: 'read_full_output', args: { ref: 'call-1', find: 'not ok 61' } } };
      else yield { type: 'text', delta: 'Tests fail in clear completed.' };
      yield { type: 'usage', inputTokens: 5000, outputTokens: 40, cachedInputTokens: n > 1 ? 4000 : 0 };
      yield { type: 'done', stopReason: 'stop' };
    },
  } as unknown as AiService;
  const saved = new Map<string, string>();
  const host: ToolHost = {
    specs: () => [{ name: 'run_tests', description: 'Run tests', parameters: { type: 'object', properties: {} } }],
    describe: () => 'Run tests',
    execute: async () => ({ ok: false, output: noisyTestRun(), summary: 'Tests failed' }),
    dispose: async () => undefined,
  };
  const store = new TaskStore(path.join(dir, 'tasks'));
  const runner = new TaskRunner({
    ai,
    storeFor: async () => store,
    emit: () => undefined,
    buildContext: async () => ({ parts: [], system: 'Instructions' }),
    toolsFor: async () => host,
    outputs: { save: async (_t, ref, text) => void saved.set(ref, text), read: async (_t, ref) => saved.get(ref) ?? null },
  });
  const created = await runner.create({ projectId: 'p1', mode, prompt: 'Run the tests and tell me what fails', context: { workspace: 'build', lineId: 'shared', lineName: 'Shared', path: null, selection: null }, attachments: [] });
  let task: TaskView | null = null;
  for (let i = 0; i < 500; i++) {
    task = await store.get(created.id);
    if (task && !ACTIVE_TASK_STATES.includes(task.state) && !runner.isRunning(created.id)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return { task: task!, requests, saved, cleanup };
}

test('a task sends shortened results, can read them in full, and reports cached and saved tokens', async () => {
  const r = await runTask({ replies: 'brief', compactOutputs: true, compactHistory: true, promptCaching: true }, 1);
  try {
    assert.equal(r.task.state, 'completed', JSON.stringify(r.task.error));
    const first = r.task.messages.find((m) => m.toolResult?.callId === 'call-1')!.toolResult!;
    assert.ok(first.output.length < noisyTestRun().length / 3);
    assert.equal(first.fullChars, noisyTestRun().length);
    assert.match(first.output, /read_full_output with ref "call-1"/);
    assert.equal(r.saved.get('call-1'), noisyTestRun(), 'the full text is kept');
    const reread = r.task.messages.find((m) => m.toolResult?.callId === 'read-1')!.toolResult!;
    assert.match(reread.output, /not ok 61 - clear completed keeps open tasks/);
    assert.ok(r.requests[0]!.tools!.some((t) => t.name === 'read_full_output'));
    assert.match(r.requests[0]!.system!, /Replies: lead with the answer/);
    assert.deepEqual(r.requests[0]!.cache, { key: `mv-${r.task.id.slice(-24)}` });
    assert.equal(r.requests[0]!.maxOutputTokens, 8192, 'tool-using modes keep room for file contents');
    assert.equal(r.task.usage.cachedInputTokens, 8000);
    assert.ok((r.task.usage.savedTokensEstimate ?? 0) > 1000, String(r.task.usage.savedTokensEstimate));
    assert.ok(r.task.lastRequest && r.task.lastRequest.instructions > 0 && r.task.lastRequest.toolResults > 0);
  } finally {
    await r.cleanup();
  }
});

test('with the saver off, requests are as before: no read_full_output, no cache, standard replies', async () => {
  const r = await runTask({ replies: 'standard', compactOutputs: false, compactHistory: false, promptCaching: false }, 1);
  try {
    assert.ok(!r.requests[0]!.tools!.some((t) => t.name === 'read_full_output'));
    assert.equal(r.requests[0]!.cache, null);
    assert.doesNotMatch(r.requests[0]!.system!, /Replies:/);
    const first = r.task.messages.find((m) => m.toolResult?.callId === 'call-1')!.toolResult!;
    assert.equal(first.fullChars, undefined);
  } finally {
    await r.cleanup();
  }
});

test('in a long task older results become short stubs in batches, and requests between batches share their start', async () => {
  const r = await runTask({ replies: 'brief', compactOutputs: false, compactHistory: true, promptCaching: true }, 12);
  try {
    assert.equal(r.task.state, 'completed', JSON.stringify(r.task.error));
    const toolTexts = (req: GenerateRequest) => req.messages.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);
    const last = toolTexts(r.requests[r.requests.length - 1]!);
    assert.match(last[0]!, /^\[Earlier run_tests result \(/);
    assert.match(last[0]!, /read_full_output with ref "call-1"/);
    assert.ok(!last[last.length - 1]!.startsWith('[Earlier'), 'the latest results are in full');
    // Count how often the already-sent part of the conversation changed: only when a batch was shortened.
    let rewrites = 0;
    for (let i = 1; i < r.requests.length; i++) {
      const prev = JSON.stringify(r.requests[i - 1]!.messages);
      const next = JSON.stringify(r.requests[i]!.messages.slice(0, r.requests[i - 1]!.messages.length));
      if (prev !== next) rewrites++;
    }
    assert.ok(rewrites >= 1 && rewrites <= Math.ceil(r.requests.length / 4), `the start changed ${rewrites} times in ${r.requests.length} requests`);
  } finally {
    await r.cleanup();
  }
});
