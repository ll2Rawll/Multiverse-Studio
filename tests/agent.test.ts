import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { AiService } from '../src/ai/service';
import { MemoryVault } from '../src/ai/vault';
import { classifyCommand } from '../src/agent/permissions';
import { scrubbedEnv, ProcessManager } from '../src/agent/processes';
import { RunDirectory, isIgnoredPath } from '../src/agent/runDir';
import { ACTIVE_TASK_STATES, type TaskView } from '../src/shared/ai';
import { SHARED_LINE_ID } from '../src/shared/types';
import { tempDir } from './helpers';

/* All model traffic here is a scripted mock of the OpenAI-compatible protocol. Commands are real. */

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
type Step = { text?: string; calls?: { name: string; args: unknown }[] };

function scripted(steps: Step[], requests: Record<string, unknown>[]): typeof fetch {
  let n = 0;
  return (async (url: string | URL, init: RequestInit = {}) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'mock/coder' }] });
    requests.push(JSON.parse(String(init.body)));
    const step = steps.shift() ?? { text: 'Done.' };
    const events: string[] = [];
    if (step.text) events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: step.text } }] })}\n\n`);
    step.calls?.forEach((c, index) => {
      n += 1;
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call_${n}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] })}\n\n`);
    });
    events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

async function setup(steps: Step[]) {
  const { dir, cleanup } = await tempDir('mv-agent-');
  const site = path.join(dir, 'calc');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'package.json'), JSON.stringify({ name: 'calc', private: true, scripts: { test: 'node test.js' } }, null, 2));
  await fs.writeFile(path.join(site, 'sum.js'), 'exports.sum = (a, b) => a - b;\n');
  await fs.writeFile(path.join(site, 'test.js'), "const assert = require('assert');\nconst { sum } = require('./sum');\nassert.strictEqual(sum(2, 3), 5);\nconsole.log('all tests passed');\n");
  await fs.writeFile(path.join(site, 'wait.js'), "console.log('waiting'); setInterval(() => {}, 1000);\n");
  await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><html><head><title>Calc</title></head><body><h1>Calc</h1></body></html>\n');
  const requests: Record<string, unknown>[] = [];
  const workspace = path.join(dir, 'workspace');
  const ai = new AiService(path.join(workspace, 'ai.json'), new MemoryVault(), scripted(steps, requests));
  const service = new StudioService({ workspaceRoot: workspace, sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:1/`, emit: () => {}, ai, agent: { cacheRoot: path.join(dir, 'cache') } });
  const report = await service.call('projects.import', { folderPath: site });
  const projectId = report!.project.id;
  const saved = await service.call('ai.connections.save', { name: 'Mock', provider: 'openai-compatible', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1' });
  await service.call('ai.models.add', { connectionId: saved.savedId, modelId: 'mock/coder' });
  await service.call('ai.routing.set', { job: 'coding', assignment: { connectionId: saved.savedId, modelId: 'mock/coder' } });
  return { service, requests, projectId, dir, cleanup, steps };
}

async function settle(service: StudioService, projectId: string, taskId: string, until: (t: TaskView) => boolean = (t) => !ACTIVE_TASK_STATES.includes(t.state)): Promise<TaskView> {
  for (let i = 0; i < 1500; i++) {
    const t = await service.call('ai.tasks.get', { projectId, taskId });
    if (until(t)) return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for the task');
}

const ctx = { workspace: 'edit', lineId: SHARED_LINE_ID, path: null, selection: null };
const read = (service: StudioService, projectId: string, lineId: string, p: string) => service.call('files.read', { projectId, ref: { kind: 'line', lineId }, path: p }).then((f) => f.text);

test('build mode fixes a bug in a task alternative, runs the real tests and leaves the user’s version untouched', async () => {
  const h = await setup([
    { text: 'I will look at sum.js.', calls: [{ name: 'read_file', args: { path: 'sum.js' } }] },
    { calls: [{ name: 'edit_file', args: { path: 'sum.js', edits: [{ find: 'a - b', replace: 'a + b' }] } }] },
    { calls: [{ name: 'run_tests', args: {} }] },
    { text: 'Fixed `sum` to add instead of subtract. `npm test` passes.' },
  ]);
  try {
    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'build', prompt: 'Fix the failing test', context: ctx, attachments: [] });
    assert.notEqual(created.workingLineId, SHARED_LINE_ID, 'build mode works in a task alternative');
    const task = await settle(h.service, h.projectId, created.id);
    assert.equal(task.state, 'completed', JSON.stringify(task.error));
    assert.match(task.workingLineName!, /^Task: Fix the failing test/);
    assert.deepEqual(task.filesChanged, ['sum.js']);
    assert.match((await read(h.service, h.projectId, task.workingLineId!, 'sum.js'))!, /a \+ b/);
    assert.match((await read(h.service, h.projectId, SHARED_LINE_ID, 'sum.js'))!, /a - b/, 'the user’s version is preserved');
    const testStep = task.steps.find((s) => s.title === 'Run tests');
    assert.equal(testStep?.status, 'done');
    assert.equal(testStep?.detail, 'Tests passed');
    const testResult = task.messages.find((m) => m.toolResult?.name === 'run_tests')!.toolResult!;
    assert.ok(testResult.ok && /all tests passed/.test(testResult.output), testResult.output);
    // The model saw real tool results.
    const last = JSON.stringify(h.requests[h.requests.length - 1]);
    assert.ok(last.includes('all tests passed'));
    // Changes are reviewable as a comparison against the starting version.
    const cmp = await h.service.call('compare.run', { projectId: h.projectId, left: { kind: 'line', lineId: SHARED_LINE_ID }, right: { kind: 'line', lineId: task.workingLineId! } });
    assert.deepEqual(cmp.files.filter((f) => f.status !== 'unchanged').map((f) => f.path), ['sum.js']);
  } finally {
    await h.cleanup();
  }
});

test('commands outside the granted permissions wait for the user, and a refusal is respected', async () => {
  const h = await setup([{ calls: [{ name: 'run_command', args: { program: 'git', args: ['status'] } }] }, { text: 'Skipped git status as you asked.' }]);
  try {
    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'build', prompt: 'Check git', context: ctx, attachments: [] });
    const waiting = await settle(h.service, h.projectId, created.id, (t) => t.state === 'waiting-input');
    assert.match(waiting.approval!.title, /git status/);
    assert.match(waiting.approval!.detail, /not a sandbox/);
    await h.service.call('ai.tasks.decide', { projectId: h.projectId, taskId: created.id, approve: false });
    const done = await settle(h.service, h.projectId, created.id);
    assert.equal(done.state, 'completed');
    const result = done.messages.find((m) => m.toolResult?.name === 'run_command')!.toolResult!;
    assert.equal(result.ok, false);
    assert.match(result.output, /declined/);
  } finally {
    await h.cleanup();
  }
});

test('tools validate paths and mode: no escaping the project, no edits outside Build mode', async () => {
  const h = await setup([
    { calls: [{ name: 'read_file', args: { path: '../../../etc/passwd' } }, { name: 'edit_file', args: { path: 'sum.js', edits: [{ find: 'a', replace: 'b' }] } }, { name: 'read_file', args: { path: 'C:/Windows/win.ini' } }] },
    { text: 'I could not do that.' },
  ]);
  try {
    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'plan', prompt: 'Look around', context: ctx, attachments: [] });
    assert.equal(created.workingLineId, SHARED_LINE_ID, 'plan mode does not create an alternative');
    const task = await settle(h.service, h.projectId, created.id);
    const results = task.messages.filter((m) => m.toolResult).map((m) => m.toolResult!);
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => !r.ok));
    assert.match(results[0]!.output, /Unsafe path|not allowed/i);
    assert.match(results[1]!.output, /Unknown or unavailable tool/);
    assert.match(results[2]!.output, /not allowed/i);
    const offered = (h.requests[0]!.tools as { function: { name: string } }[]).map((t) => t.function.name);
    assert.ok(!offered.includes('edit_file') && !offered.includes('run_command'), `plan mode offers read-only tools: ${offered.join(', ')}`);
  } finally {
    await h.cleanup();
  }
});

test('cancelling a task stops its running command and kills the child process', async () => {
  const h = await setup([{ calls: [{ name: 'run_command', args: { program: 'node', args: ['wait.js'], timeout_seconds: 120 } }] }]);
  try {
    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'build', prompt: 'Run the waiter', context: ctx, attachments: [] });
    let pid: number | null = null;
    for (let i = 0; i < 500 && !pid; i++) {
      pid = h.service.agent!.processes.list(created.id)[0]?.pid ?? null;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(pid, 'the command started');
    await h.service.call('ai.tasks.cancel', { projectId: h.projectId, taskId: created.id });
    const task = await settle(h.service, h.projectId, created.id);
    assert.equal(task.state, 'cancelled');
    assert.equal(h.service.agent!.processes.list(created.id).length, 0);
    assert.throws(() => process.kill(pid!, 0), /ESRCH/, 'the child process is gone');
  } finally {
    await h.cleanup();
  }
});

test('run directories bring back generated files but never dependencies, build output or .env secrets', async () => {
  const h = await setup([]);
  try {
    const engine = await h.service.engine(h.projectId);
    const created = await h.service.call('lines.create', { projectId: h.projectId, from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Run', color: 'teal', description: '', following: false });
    const runDir = new RunDirectory(path.join(h.dir, 'run'), engine, created.line.id);
    assert.ok((await runDir.prepare()) >= 5);
    assert.equal(await runDir.prepare(), 0, 'unchanged files are not rewritten');
    await fs.mkdir(path.join(h.dir, 'run', 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(h.dir, 'run', 'node_modules', 'x', 'index.js'), '');
    await fs.mkdir(path.join(h.dir, 'run', 'dist'));
    await fs.writeFile(path.join(h.dir, 'run', 'dist', 'out.js'), '');
    await fs.writeFile(path.join(h.dir, 'run', '.env'), 'API_KEY=supersecret');
    await fs.writeFile(path.join(h.dir, 'run', 'generated.txt'), 'made by a command');
    await fs.writeFile(path.join(h.dir, 'run', 'sum.js'), 'exports.sum = (a, b) => a + b;\n');
    await fs.rm(path.join(h.dir, 'run', 'wait.js'));
    const r = await runDir.collect();
    assert.deepEqual(r.added, ['generated.txt']);
    assert.deepEqual(r.changed, ['sum.js']);
    assert.deepEqual(r.deleted, ['wait.js']);
    const files = (await h.service.call('files.list', { projectId: h.projectId, ref: { kind: 'line', lineId: created.line.id } })).map((f) => f.path);
    assert.ok(!files.some((f) => f.startsWith('node_modules') || f.startsWith('dist') || f === '.env'));
    assert.ok(isIgnoredPath('.env.local') && !isIgnoredPath('.env.example'));
  } finally {
    await h.cleanup();
  }
});

test('command classification and environment scrubbing', async () => {
  const scripts = { test: 'node test.js', build: 'vite build', dev: 'vite' };
  assert.equal(classifyCommand('npm', ['test'], scripts).permission, 'runBuildAndTests');
  assert.equal(classifyCommand('npm', ['run', 'build'], scripts).permission, 'runBuildAndTests');
  assert.equal(classifyCommand('npm', ['run', 'deploy'], scripts).permission, 'approval');
  assert.equal(classifyCommand('npm', ['install', 'zod', '--save-dev'], scripts).permission, 'installDependencies');
  assert.equal(classifyCommand('npm', ['install', 'git+https://evil.example/x.git'], scripts).permission, 'approval');
  assert.equal(classifyCommand('npm', ['install', '--registry', 'https://x'], scripts).permission, 'approval');
  assert.equal(classifyCommand('node', ['scripts/seed.js'], scripts).permission, 'runBuildAndTests');
  assert.equal(classifyCommand('node', ['-e', 'process.exit()'], scripts).permission, 'approval');
  assert.equal(classifyCommand('node', ['../outside.js'], scripts).permission, 'approval');
  assert.equal(classifyCommand('curl', ['https://example.com'], scripts).permission, 'approval');

  const env = scrubbedEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'g', MULTIVERSE_USER_DATA: '/x', AWS_SECRET_ACCESS_KEY: 'a', HTTPS_PROXY: 'http://user:pw@proxy:1', LANG: 'en' });
  assert.deepEqual(Object.keys(env).sort(), ['BROWSER', 'CI', 'FORCE_COLOR', 'HOME', 'LANG', 'NO_COLOR', 'PATH']);

  const pm = new ProcessManager();
  const r = await pm.run('node', ['-e', 'console.log(Object.keys(process.env).filter(k => /KEY|TOKEN/.test(k)).length)'], { cwd: process.cwd(), owner: 't', env: {} });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.trim(), '0', 'child processes see no credential-like variables');
});
