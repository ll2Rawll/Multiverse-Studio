/**
 * Live AI activity: events come only from what the engine did (commands, operations, task steps,
 * story steps), name targets by identity, never fire for the person's own edits, carry measured
 * progress only, and pausing says when it really takes effect. Mocked model; real browser for stories.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { changedRanges, describeCommand, describeTool } from '../src/live/describe';
import { StudioService } from '../src/services/studio';
import { SHARED_LINE_ID, type StudioEvent } from '../src/shared/types';
import type { LiveEvent } from '../src/shared/live';
import { PlaywrightProbe } from '../e2e/harness/playwrightProbe';
import { TaskRunner, type ToolHost } from '../src/ai/runner';
import { TaskStore } from '../src/ai/tasks';
import { DEFAULT_BUDGETS, ACTIVE_TASK_STATES, type TaskView } from '../src/shared/ai';
import type { AiService } from '../src/ai/service';
import type { StreamEvent } from '../src/ai/types';
import { tempDir } from './helpers';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
const probe = new PlaywrightProbe();
after(() => probe.close());

test('changed lines and command descriptions name the real target', () => {
  assert.deepEqual(changedRanges('a\nb\nc\nd', 'a\nB\nC\nd'), [{ start: 2, end: 3 }]);
  assert.deepEqual(changedRanges(null, 'x\ny'), [{ start: 1, end: 2 }]);
  assert.deepEqual(changedRanges('a\nb', 'a\nb\nc'), [{ start: 3, end: 3 }]);
  const seq = (clips: { id: string; in: number }[]) => JSON.stringify({ tracks: [{ id: 'v1', clips }] });
  const trim = describeCommand('video.trimClip', { sequence: 'main', clipId: 'c2' }, [{ path: 'sequences/main.mvseq.json', before: seq([{ id: 'c1', in: 0 }, { id: 'c2', in: 0 }]), after: seq([{ id: 'c1', in: 0 }, { id: 'c2', in: 5 }]) }], 'Trim');
  assert.deepEqual(trim.target, { kind: 'clip', sequenceId: 'main', clipId: 'c2' });
  assert.equal(trim.description, 'Trimming a clip');
  const many = describeCommand('video.batch', { sequence: 'main' }, [{ path: 'sequences/main.mvseq.json', before: seq([{ id: 'c1', in: 0 }, { id: 'c2', in: 0 }, { id: 'c3', in: 0 }]), after: seq([{ id: 'c1', in: 1 }, { id: 'c2', in: 1 }, { id: 'c3', in: 1 }]) }], 'Batch');
  assert.equal(many.scope, 3);
  assert.equal(many.description, 'Adjusting 3 clips');
  const style = describeCommand('design.setStyle', { page: 'index.html', target: { id: 'hero', path: null }, props: { color: '#123' } }, [{ path: 'design.css', before: '', after: '#hero{}' }], 'Style');
  assert.deepEqual(style.target, { kind: 'element', page: 'index.html', id: 'hero', path: null, property: 'color' });
  assert.equal(style.description, 'Adjusting style on the homepage');
  const code = describeCommand('code.editFile', { path: 'app.js' }, [{ path: 'app.js', before: 'a\nb\nc', after: 'a\nX\nc' }], 'Edit');
  assert.deepEqual(code.target, { kind: 'code', path: 'app.js', ranges: [{ start: 2, end: 2 }], created: false });
  assert.equal(describeTool('run_tests', {}).phase, 'testing');
  assert.equal(describeTool('read_file', { path: 'a.ts' }).description, 'Reading a.ts');
});

const PAGE = {
  'index.html': `<!doctype html><html><head><title>Tasks</title></head><body><form id="f"><label for="t">Task title</label><input id="t"><button>Add task</button></form><ul id="list"></ul><p data-testid="count">0 open</p>
<script>document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); const li = document.createElement('li'); li.textContent = document.getElementById('t').value; document.getElementById('list').append(li); document.querySelector('[data-testid=count]').textContent = document.querySelectorAll('#list li').length + ' open'; });</script></body></html>`,
};

async function setup() {
  const { dir, cleanup } = await tempDir('mv-live-');
  const events: StudioEvent[] = [];
  let service!: StudioService;
  const previews = http.createServer(async (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0] ?? '';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const reply = await service.servePreview(host.split('.')[0] ?? '', url.pathname, `http://${req.headers.host}`);
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  });
  await new Promise<void>((r) => previews.listen(0, '127.0.0.1', r));
  const port = (previews.address() as AddressInfo).port;
  service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:${port}/`, emit: (e) => events.push(e), cacheRoot: path.join(dir, 'cache'), agent: { cacheRoot: path.join(dir, 'cache'), probe } });
  const site = path.join(dir, 'site');
  await fs.mkdir(site);
  for (const [p, text] of Object.entries(PAGE)) await fs.writeFile(path.join(site, p), text);
  const projectId = (await service.call('projects.import', { folderPath: site }))!.project.id;
  const live = (): LiveEvent[] => events.filter((e): e is Extract<StudioEvent, { type: 'live' }> => e.type === 'live').map((e) => e.event);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  return {
    service,
    projectId,
    live,
    settle,
    cleanup: async () => {
      await service.shutdown();
      previews.close();
      await cleanup();
    },
  };
}

test('AI commands and operations report targets; the person’s own edits never do', async () => {
  const h = await setup();
  try {
    const engine = await h.service.engine(h.projectId);
    await h.service.commands.run(engine, SHARED_LINE_ID, 'code.writeFile', { path: 'notes.md', text: 'one\n' }, { actor: 'user' });
    await h.settle();
    assert.equal(h.live().length, 0, 'a person’s edit does not move AI visuals');

    h.service.live.setLabel('t1', 'Tidy the notes');
    await h.service.commands.run(engine, SHARED_LINE_ID, 'code.editFile', { path: 'notes.md', edits: [{ find: 'one', replace: 'one\ntwo\nthree' }] }, { actor: 'ai-task', taskId: 't1' });
    await h.settle();
    const done = h.live().find((e) => e.operation === 'code.editFile')!;
    assert.equal(done.kind, 'operation.completed');
    assert.equal(done.taskId, 'task:t1');
    assert.equal(done.taskLabel, 'Tidy the notes');
    assert.equal(done.universeName, 'Shared version');
    assert.deepEqual(done.target, { kind: 'code', path: 'notes.md', ranges: [{ start: 2, end: 3 }], created: false }, 'the two added lines');
    assert.equal(done.progress, null, 'no invented percentages');
    assert.equal(done.pointer, false, 'editing a file is not a pointer interaction');

    // A refused AI edit (the file moved on) is reported as failed with no target.
    await assert.rejects(h.service.commands.run(engine, SHARED_LINE_ID, 'code.editFile', { path: 'notes.md', edits: [{ find: 'two', replace: '2' }] }, { actor: 'ai-task', taskId: 't1', expected: { 'notes.md': 'f'.repeat(64) } }));
    await h.settle();
    const failed = h.live().find((e) => e.kind === 'operation.failed')!;
    assert.equal(failed.target, null);
    assert.match(failed.detail ?? '', /changed since this action was prepared/);

    // Connected apps: operations start and finish under the app's name; universe operations point at the universe.
    await h.service.operations.run(h.projectId, 'project.createUniverse', { from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Playful', color: 'rose', description: '', following: true }, { actor: 'ai-app', via: 'ChatGPT' });
    await h.settle();
    const app = h.live().filter((e) => e.taskId === 'app:ChatGPT');
    assert.deepEqual(app.map((e) => e.kind), ['operation.started', 'operation.completed']);
    assert.equal(app[0]!.taskLabel, 'ChatGPT');
    assert.equal(app[1]!.target?.kind, 'universe');
    assert.equal(app[1]!.universeName, 'Playful');
  } finally {
    await h.cleanup();
  }
});

test('an AI story run reports each step: browser actions with the pointer, checks as assertions, measured progress', async () => {
  const h = await setup();
  try {
    await h.service.call('commands.run', {
      projectId: h.projectId,
      lineId: SHARED_LINE_ID,
      name: 'stories.create',
      args: {
        story: 'add',
        name: 'Add a task',
        page: 'index.html',
        fixtures: {},
        steps: [
          { id: 'c', kind: 'chapter', title: 'Adding' },
          { id: 'f', kind: 'fill', target: { by: 'label', name: 'Task title' }, text: 'Ship it' },
          { id: 'b', kind: 'click', target: { by: 'role', role: 'button', name: 'Add task' } },
          { id: 'v', kind: 'verify', target: { by: 'testid', value: 'count' }, expect: { text: '1 open' } },
        ],
        viewport: { width: 640, height: 480 },
        timing: { stepDelayMs: 0, typingMsPerChar: 10, endHoldMs: 0 },
      },
    });
    const r = await h.service.operations.run(h.projectId, 'story.run', { lineId: SHARED_LINE_ID, storyId: 'add' }, { actor: 'ai-task', taskId: 't2' });
    assert.equal((r.result as { ok: boolean }).ok, true);
    await h.settle();
    const steps = h.live().filter((e) => e.target?.kind === 'story-step');
    assert.deepEqual(steps.map((e) => (e.target as { stepId: string }).stepId), ['f', 'b', 'v'], 'presentation steps are not browser activity');
    assert.deepEqual(steps.map((e) => e.pointer), [true, true, false]);
    assert.deepEqual(steps.map((e) => (e.target as { assertion: boolean }).assertion), [false, false, true]);
    assert.deepEqual(steps.map((e) => e.progress), [0.5, 0.75, 1], 'progress is steps finished out of steps');
    assert.ok(steps.every((e) => e.phase === 'testing' && e.taskId === 'task:t2'));
    const end = h.live().filter((e) => e.operation === 'story.run' && e.kind === 'operation.completed');
    assert.ok(end.some((e) => e.description === 'Passed: Add a task'));
  } finally {
    await h.cleanup();
  }
});

test('a task reports its steps; a pause says it takes effect after the current step, then “Paused while you edit”', async () => {
  const { dir, cleanup } = await tempDir('mv-live-run-');
  const live: LiveEvent[] = [];
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ai = {
    store: { read: async () => ({ connections: [], routing: {}, budgets: { ...DEFAULT_BUDGETS, maxToolIterations: 10 } }) },
    resolve: async () => ({ connection: { id: 'c', name: 'Mock' }, model: { id: 'mock', label: 'Mock', capabilities: {} }, local: false }),
    estimateCost: () => null,
    async *generate(): AsyncGenerator<StreamEvent> {
      n++;
      if (n === 1) yield { type: 'tool-call', call: { id: 'e1', name: 'edit_file', args: { path: 'app.js' } } };
      else if (n === 2) yield { type: 'tool-call', call: { id: 'e2', name: 'edit_file', args: { path: 'app.js' } } };
      else yield { type: 'text', delta: 'Done.' };
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      yield { type: 'done', stopReason: 'stop' };
    },
  } as unknown as AiService;
  const host: ToolHost = {
    specs: () => [{ name: 'edit_file', description: 'Edit', parameters: { type: 'object', properties: {} } }],
    describe: () => 'Edit app.js',
    execute: async (call) => {
      if (call.id === 'e1') await gate;
      return { ok: true, output: 'ok', summary: 'Edited app.js', filesChanged: ['app.js'], targets: [{ kind: 'code', path: 'app.js', ranges: [{ start: 4, end: 6 }], created: false }] };
    },
    dispose: async () => undefined,
  };
  const store = new TaskStore(path.join(dir, 'tasks'));
  const runner = new TaskRunner({ ai, storeFor: async () => store, emit: () => undefined, buildContext: async () => ({ parts: [], system: 'x' }), toolsFor: async () => host, live: (e) => live.push(e) });
  try {
    const created = await runner.create({ projectId: 'p1', mode: 'build', prompt: 'Fix app.js', context: { workspace: 'build', lineId: 'shared', lineName: 'Shared', path: null, selection: null }, attachments: [] });
    for (let i = 0; i < 200 && !live.some((e) => e.operation === 'edit_file'); i++) await new Promise((r) => setTimeout(r, 10));
    runner.pause(created.id, 'user-edit');
    assert.equal(live[live.length - 1]!.description, 'Pausing while you edit', 'the pause is not claimed before it happens');
    release();
    for (let i = 0; i < 200 && !live.some((e) => e.kind === 'task.paused'); i++) await new Promise((r) => setTimeout(r, 10));
    const paused = live.find((e) => e.kind === 'task.paused')!;
    assert.equal(paused.description, 'Paused while you edit');
    runner.resume(created.id);
    let task: TaskView | null = null;
    for (let i = 0; i < 300; i++) {
      task = await store.get(created.id);
      if (task && !ACTIVE_TASK_STATES.includes(task.state) && !runner.isRunning(created.id)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(task!.state, 'completed');
    const kinds = live.map((e) => e.kind);
    assert.equal(kinds[0], 'task.started');
    assert.equal(kinds[kinds.length - 1], 'task.completed');
    assert.ok(kinds.includes('task.resumed'));
    const edit = live.find((e) => e.kind === 'operation.completed' && e.operation === 'edit_file')!;
    assert.deepEqual(edit.target, { kind: 'code', path: 'app.js', ranges: [{ start: 4, end: 6 }], created: false });
    assert.equal(edit.taskLabel, task!.title);
    assert.ok(live.every((e) => e.taskId === `task:${created.id}` && e.pointer === false));
  } finally {
    await cleanup();
  }
});
