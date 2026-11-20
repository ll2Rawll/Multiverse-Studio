import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { AiService } from '../src/ai/service';
import { MemoryVault } from '../src/ai/vault';
import { ACTIVE_TASK_STATES, type TaskView } from '../src/shared/ai';
import type { StudioEvent } from '../src/shared/types';
import { tempDir } from './helpers';

/* Mocked provider: an OpenRouter-style endpoint. No real requests are made in this file. */

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

function sseStream(chunks: string[], hang = false): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]!));
      else if (!hang) c.close();
      else return new Promise(() => undefined);
      return undefined;
    },
  });
}

const delta = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

interface Harness {
  service: StudioService;
  ai: AiService;
  events: StudioEvent[];
  bodies: Record<string, unknown>[];
  projectId: string;
  workspace: string;
  cleanup(): Promise<void>;
  mode: { hang: boolean };
}

async function setup(): Promise<Harness> {
  const { dir, cleanup } = await tempDir('mv-tasks-');
  const site = path.join(dir, 'site');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><html><body><h1>Hi</h1></body></html>');
  await fs.writeFile(path.join(site, 'notes.txt'), 'The launch is on Friday.');
  const bodies: Record<string, unknown>[] = [];
  const mode = { hang: false };
  const fetchMock = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    if (u.endsWith('/models')) return Response.json({ data: [{ id: 'mock/chat', name: 'Mock chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } }] });
    bodies.push(JSON.parse(String(init.body)));
    if (mode.hang) return new Response(sseStream([delta('Thinking about it')], true));
    return new Response(sseStream([delta('The launch '), delta('is on Friday.'), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 500 } })}\n\n`, 'data: [DONE]\n\n']));
  }) as typeof fetch;
  const workspace = path.join(dir, 'workspace');
  const ai = new AiService(path.join(workspace, 'ai-settings.json'), new MemoryVault(), fetchMock);
  const events: StudioEvent[] = [];
  const service = new StudioService({ workspaceRoot: workspace, sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:1/`, emit: (e) => events.push(e), ai });
  const report = await service.call('projects.import', { folderPath: site });
  return { service, ai, events, bodies, projectId: report!.project.id, workspace, cleanup, mode };
}

async function connect(h: Harness): Promise<void> {
  const saved = await h.service.call('ai.connections.save', { name: 'Router', provider: 'openrouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1' });
  await h.service.call('ai.keys.set', { connectionId: saved.savedId, key: KEY, persistence: 'session' });
  const tested = await h.service.call('ai.connections.test', { connectionId: saved.savedId });
  assert.ok(tested.ok, tested.message);
  await h.service.call('ai.routing.set', { job: 'assistant', assignment: { connectionId: saved.savedId, modelId: 'mock/chat' } });
}

async function settle(h: Harness, taskId: string): Promise<TaskView> {
  for (let i = 0; i < 200; i++) {
    const task = await h.service.call('ai.tasks.get', { projectId: h.projectId, taskId });
    if (!ACTIVE_TASK_STATES.includes(task.state)) return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('task did not settle');
}

const context = { workspace: 'explore', lineId: null, path: null, selection: null };

test('an ask task streams an answer, records usage and an estimated cost, and persists', async () => {
  const h = await setup();
  try {
    await connect(h);
    const preview = await h.service.call('ai.tasks.preview', { projectId: h.projectId, mode: 'ask', attachments: ['notes.txt'] });
    assert.equal(preview.route?.connectionName, 'Router');
    assert.equal(preview.route?.local, false);
    assert.deepEqual(preview.items.map((i) => [i.label, i.sent]), [['notes.txt', true]]);

    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'ask', prompt: `When is the launch? (my key is ${KEY})`, context, attachments: ['notes.txt'] });
    const task = await settle(h, created.id);
    assert.equal(task.state, 'completed', JSON.stringify(task.error));
    assert.equal(task.result?.summary, 'The launch is on Friday.');
    assert.equal(task.route?.modelId, 'mock/chat');
    assert.equal(task.usage.inputTokens, 1000);
    assert.equal(task.usage.outputTokens, 500);
    assert.ok(Math.abs(task.usage.estimatedCostUsd! - 0.002) < 1e-9, String(task.usage.estimatedCostUsd));
    assert.ok(task.steps.some((s) => s.kind === 'model' && s.status === 'done'));

    // Only the attached file was sent; the other project file was not.
    const sent = JSON.stringify(h.bodies[0]);
    assert.ok(sent.includes('The launch is on Friday.'));
    assert.ok(!sent.includes('<h1>Hi</h1>'), 'unattached files are not uploaded');
    // A key pasted into the prompt is redacted before it is sent or stored.
    assert.ok(!sent.includes(KEY), 'keys never reach the model');
    const files = await fs.readdir(path.join(h.workspace, 'Projects'));
    const raw = await fs.readFile(path.join(h.workspace, 'Projects', files[0]!, 'ai', 'tasks', `${task.id}.json`), 'utf8');
    assert.ok(!raw.includes(KEY), 'keys never reach task files');

    assert.ok(h.events.some((e) => e.type === 'ai-task' && e.update.kind === 'delta'), 'deltas are streamed to the UI');
    const list = await h.service.call('ai.tasks.list', { projectId: h.projectId });
    assert.equal(list[0]!.id, task.id);

    // Continuing the conversation re-runs with history.
    await h.service.call('ai.tasks.send', { projectId: h.projectId, taskId: task.id, text: 'Thanks. And the venue?' });
    const continued = await settle(h, task.id);
    assert.equal(continued.state, 'completed');
    assert.equal(continued.messages.filter((m) => m.role === 'user').length, 2);
    assert.equal(continued.usage.requests, 2);
  } finally {
    await h.cleanup();
  }
});

test('cancelling a streaming task stops it and keeps the partial answer', async () => {
  const h = await setup();
  try {
    await connect(h);
    h.mode.hang = true;
    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'ask', prompt: 'Write a long essay', context, attachments: [] });
    for (let i = 0; i < 100 && !h.events.some((e) => e.type === 'ai-task' && e.update.kind === 'delta'); i++) await new Promise((r) => setTimeout(r, 10));
    const started = Date.now();
    await h.service.call('ai.tasks.cancel', { projectId: h.projectId, taskId: created.id });
    assert.ok(Date.now() - started < 1500, 'cancellation is prompt');
    const task = await h.service.call('ai.tasks.get', { projectId: h.projectId, taskId: created.id });
    assert.equal(task.state, 'cancelled');
    assert.equal(task.messages.find((m) => m.role === 'assistant')?.text, 'Thinking about it');
    assert.ok(task.messages.every((m) => !m.partial));
  } finally {
    await h.cleanup();
  }
});

test('without a configured model a task is refused up front with the configuration it needs', async () => {
  const h = await setup();
  try {
    await assert.rejects(h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'ask', prompt: 'Hello', context, attachments: [] }), (e: unknown) => (e as { kind?: string }).kind === 'not-configured' && /Settings → Providers/.test((e as Error).message));
    await assert.rejects(h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'build', prompt: 'Hello', context, attachments: [] }), /Plan, Build and Autopilot need the coding agent|No model/);
    assert.equal(h.bodies.length, 0);
    assert.deepEqual(await h.service.call('ai.tasks.list', { projectId: h.projectId }), [], 'no task or alternative is left behind');
    assert.equal((await h.service.call('projects.view', { projectId: h.projectId })).alternatives.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('tasks that were running when the app stopped are marked interrupted, never resubmitted', async () => {
  const h = await setup();
  try {
    await connect(h);
    h.mode.hang = true;
    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'ask', prompt: 'Long job', context, attachments: [] });
    for (let i = 0; i < 100 && h.bodies.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const requestsBefore = h.bodies.length;
    // Simulate a restart: a new service over the same workspace, as after a crash.
    const restarted = new StudioService({ workspaceRoot: h.workspace, sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:1/`, emit: () => {}, ai: h.ai });
    await restarted.call('projects.open', { projectId: h.projectId });
    const task = await restarted.call('ai.tasks.get', { projectId: h.projectId, taskId: created.id });
    assert.equal(task.state, 'interrupted');
    assert.match(task.error!.message, /Nothing was resubmitted/);
    assert.equal(h.bodies.length, requestsBefore, 'no request was repeated');
    await h.service.call('ai.tasks.cancel', { projectId: h.projectId, taskId: created.id });
  } finally {
    await h.cleanup();
  }
});
