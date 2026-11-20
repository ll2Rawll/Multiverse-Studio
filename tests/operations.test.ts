/**
 * D2: project-level operations as commands, the activity log, code.applyPatch, the automatic
 * checkpoint before tasks, the Director role, approvals for actions outside the task's scope, and
 * the structured-command protocol for models without tool calling (MOCKED model streams).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { AiService } from '../src/ai/service';
import { MemoryVault } from '../src/ai/vault';
import { parseStructuredCommand } from '../src/ai/runner';
import { ACTIVE_TASK_STATES, type TaskView } from '../src/shared/ai';
import { SHARED_LINE_ID } from '../src/shared/types';
import { tempDir } from './helpers';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
type Step = { text?: string; calls?: { name: string; args: unknown }[] };

function scripted(steps: Step[], requests: Record<string, unknown>[]): typeof fetch {
  let n = 0;
  return (async (url: string | URL, init: RequestInit = {}) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'mock/director' }, { id: 'mock/plain' }] });
    requests.push(JSON.parse(String(init.body)));
    const step = steps.shift() ?? { text: 'Done.' };
    const events: string[] = [];
    if (step.text) events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: step.text } }] })}\n\n`);
    step.calls?.forEach((c, index) => {
      n += 1;
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call_${n}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] })}\n\n`);
    });
    events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`);
    return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

async function setup(steps: Step[] = []) {
  const { dir, cleanup } = await tempDir('mv-ops-');
  const requests: Record<string, unknown>[] = [];
  const workspace = path.join(dir, 'workspace');
  const ai = new AiService(path.join(workspace, 'ai.json'), new MemoryVault(), scripted(steps, requests));
  const service = new StudioService({ workspaceRoot: workspace, sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:1/`, emit: () => {}, ai, agent: { cacheRoot: path.join(dir, 'cache') }, cacheRoot: path.join(dir, 'cache') });
  const site = path.join(dir, 'site');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><html><head><title>Orbit</title></head><body><h1 data-mv-id="hero-title">Orbit</h1>\n<p>Plan your week.</p>\n</body></html>\n');
  await fs.writeFile(path.join(site, 'app.js'), 'export function total(a, b) {\n  return a - b;\n}\n');
  const projectId = (await service.call('projects.import', { folderPath: site }))!.project.id;
  const saved = await service.call('ai.connections.save', { name: 'Mock', provider: 'openai-compatible', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1' });
  for (const m of ['mock/director', 'mock/plain']) await service.call('ai.models.add', { connectionId: saved.savedId, modelId: m });
  await service.call('ai.routing.set', { job: 'coding', assignment: { connectionId: saved.savedId, modelId: 'mock/director' } });
  return { service, requests, projectId, connectionId: saved.savedId, dir, cleanup };
}

async function settle(service: StudioService, projectId: string, taskId: string, until: (t: TaskView) => boolean = (t) => !ACTIVE_TASK_STATES.includes(t.state)): Promise<TaskView> {
  for (let i = 0; i < 1500; i++) {
    const t = await service.call('ai.tasks.get', { projectId, taskId });
    if (until(t)) return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for the task');
}

const ctx = { workspace: 'build', lineId: SHARED_LINE_ID, path: null, selection: null };

test('buttons go through commands: universes, checkpoints and file edits are logged with actor and undo', async () => {
  const h = await setup();
  try {
    const created = await h.service.call('lines.create', { projectId: h.projectId, from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Playful', color: 'rose', description: '', following: true });
    await h.service.call('history.createCheckpoint', { projectId: h.projectId, name: 'Before playing', description: '' });
    await h.service.call('commands.run', { projectId: h.projectId, lineId: created.line.id, name: 'design.setText', args: { page: 'index.html', target: { id: 'hero-title' }, text: 'Orbit, but fun' } });
    const log = await h.service.call('ops.activity', { projectId: h.projectId });
    assert.deepEqual(log.map((r) => r.type), ['design.setText', 'project.createCheckpoint', 'project.createUniverse']);
    assert.ok(log.every((r) => r.actor === 'user' && r.ok));
    assert.equal(log[2]!.universeId, created.line.id);
    assert.equal(log[2]!.undo?.kind, 'inverse');
    assert.equal(log[0]!.undo?.kind, 'command');

    // Undo from the log: the text edit, then the universe itself.
    await h.service.call('ops.undo', { projectId: h.projectId, activityId: log[0]!.id });
    const page = await h.service.call('files.read', { projectId: h.projectId, ref: { kind: 'line', lineId: created.line.id }, path: 'index.html' });
    assert.match(page.text!, />Orbit<\/h1>/);
    await h.service.call('ops.undo', { projectId: h.projectId, activityId: log[2]!.id });
    const project = await h.service.call('projects.open', { projectId: h.projectId });
    assert.equal(project.alternatives.length, 0);
    assert.equal((await h.service.call('ops.activity', { projectId: h.projectId }))[0]!.type, 'project.deleteUniverse');
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('an action prepared against an older revision is refused and changes nothing', async () => {
  const h = await setup();
  try {
    const project = await h.service.call('projects.open', { projectId: h.projectId });
    await assert.rejects(
      h.service.operations.run(h.projectId, 'project.createUniverse', { from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Late', color: 'sky', description: '', following: true }, { actor: 'user', expectedRevision: 'not-the-head' }),
      /changed since this action was prepared/,
    );
    assert.equal((await h.service.call('projects.open', { projectId: h.projectId })).alternatives.length, 0);
    await h.service.operations.run(h.projectId, 'project.createUniverse', { from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'On time', color: 'sky', description: '', following: true }, { actor: 'user', expectedRevision: project.shared.head });
    await assert.rejects(h.service.operations.run(h.projectId, 'project.createUniverse', { name: 'x' }, { actor: 'user' }), /Invalid arguments for project\.createUniverse/);
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('code.applyPatch applies a unified diff as one undoable command and refuses a stale one', async () => {
  const h = await setup();
  try {
    const patch = ['--- a/app.js', '+++ b/app.js', '@@ -1,3 +1,3 @@', ' export function total(a, b) {', '-  return a - b;', '+  return a + b;', ' }', '--- /dev/null', '+++ b/notes.md', '@@ -0,0 +1,2 @@', '+# Notes', '+Fixed total.', ''].join('\n');
    await h.service.call('commands.run', { projectId: h.projectId, lineId: SHARED_LINE_ID, name: 'code.applyPatch', args: { patch } });
    const read = (p: string) => h.service.call('files.read', { projectId: h.projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID }, path: p }).then((f) => f.text);
    assert.match((await read('app.js'))!, /return a \+ b;/);
    assert.equal(await read('notes.md'), '# Notes\nFixed total.\n');
    await assert.rejects(h.service.call('commands.run', { projectId: h.projectId, lineId: SHARED_LINE_ID, name: 'code.applyPatch', args: { patch } }), /Hunk 1 does not apply to app\.js|already exists/);
    await h.service.call('commands.step', { projectId: h.projectId, lineId: SHARED_LINE_ID, scope: 'code:patch', direction: 'undo' });
    assert.match((await read('app.js'))!, /return a - b;/);
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('a Build task starts with a checkpoint, uses the Director model, and asks before importing files from outside the project', async () => {
  const h = await setup([
    { calls: [{ name: 'run_studio_command', args: { name: 'project.createCheckpoint', args: { name: 'Mid-task', description: 'by the director' } } }] },
    { calls: [{ name: 'run_studio_command', args: { name: 'assets.import', args: { paths: ['/etc/hosts'] } } }] },
    { text: 'Checkpoint made; the import was declined.' },
  ]);
  try {
    await h.service.call('ai.routing.set', { job: 'director', assignment: { connectionId: h.connectionId, modelId: 'mock/plain' } });
    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'build', prompt: 'Tidy up', context: ctx, attachments: [] });
    assert.equal(created.job, 'director');
    assert.ok(created.checkpointId, 'checkpoint before the task');
    const waiting = await settle(h.service, h.projectId, created.id, (t) => t.state === 'waiting-input');
    assert.match(waiting.approval!.title, /Read files outside the project: \/etc\/hosts/);
    await h.service.call('ai.tasks.decide', { projectId: h.projectId, taskId: created.id, approve: false });
    const done = await settle(h.service, h.projectId, created.id);
    assert.equal(done.state, 'completed');
    assert.equal((h.requests[0] as { model: string }).model, 'mock/plain', 'the Director role’s model ran the task');
    const log = await h.service.call('ops.activity', { projectId: h.projectId });
    const types = log.map((r) => `${r.type}:${r.actor}`);
    assert.ok(types.includes('project.createCheckpoint:ai-task'));
    assert.ok(!types.some((t) => t.startsWith('assets.import')), 'nothing was imported');
    const engine = await h.service.engine(h.projectId);
    assert.ok(engine.data.checkpoints.some((c) => c.id === created.checkpointId && c.name.startsWith('Before task: Tidy up')));
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('a model without tool calling directs through validated JSON commands; malformed ones never run', async () => {
  const h = await setup([
    { text: 'I will make a checkpoint.\n```json\n{"tool": "run_studio_command", "args": {"name": "project.createCheckpoint", "args": {"name": "Structured", "description": ""}}}\n```' },
    { text: 'Now a broken one:\n```json\n{"tool": "run_studio_command", "args": {"name": "project.createCheckpoint"' },
    { text: 'Done: one checkpoint.' },
  ]);
  try {
    await h.service.call('ai.routing.set', { job: 'director', assignment: { connectionId: h.connectionId, modelId: 'mock/plain' } });
    await h.service.call('ai.models.setCapability', { connectionId: h.connectionId, modelId: 'mock/plain', capability: 'tools', state: 'unavailable' });
    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'build', prompt: 'Checkpoint please', context: ctx, attachments: [] });
    const done = await settle(h.service, h.projectId, created.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.error));
    assert.ok(!('tools' in h.requests[0]!), 'no native tools were sent');
    assert.match(String((h.requests[0]!.messages as { role: string; content: string }[])[0]!.content), /end your reply with exactly one fenced block/);
    const engine = await h.service.engine(h.projectId);
    assert.equal(engine.data.checkpoints.filter((c) => c.name === 'Structured').length, 1);
    assert.ok(done.messages.some((m) => m.toolResult?.name === 'structured-command' && /not closed/.test(m.toolResult.output)), 'the cut-off command was refused');

  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('two malformed commands in a row stop the task and say the model can’t reliably direct', async () => {
  const h = await setup([{ text: '```json\nnot json\n```' }, { text: '```json\n{"tool": "nope", "args": {}}\n```' }]);
  try {
    await h.service.call('ai.routing.set', { job: 'director', assignment: { connectionId: h.connectionId, modelId: 'mock/plain' } });
    await h.service.call('ai.models.setCapability', { connectionId: h.connectionId, modelId: 'mock/plain', capability: 'tools', state: 'unavailable' });
    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'build', prompt: 'Do something', context: ctx, attachments: [] });
    const done = await settle(h.service, h.projectId, created.id);
    assert.equal(done.state, 'failed');
    assert.match(done.error!.message, /did not produce a valid command twice in a row/);
    await h.service.call('ai.models.setCapability', { connectionId: h.connectionId, modelId: 'mock/plain', capability: 'structured-output', state: 'unavailable' });
    const refused = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'build', prompt: 'Again', context: ctx, attachments: [] });
    const r = await settle(h.service, h.projectId, refused.id);
    assert.match(r.error!.message, /neither tool calling nor structured output/);
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('structured commands are parsed only from complete, well-formed replies', () => {
  const specs = [{ name: 'read_file', description: '', parameters: { type: 'object' as const } }];
  assert.deepEqual(parseStructuredCommand('All done.', specs), { kind: 'none' });
  assert.equal(parseStructuredCommand('```json\n{"tool":"read_file","args":{"path":"a"}}\n```', specs).kind, 'call');
  assert.match((parseStructuredCommand('```json\n{"tool":"read_file","args":{}}\n```\n```json\n{"tool":"read_file","args":{}}\n```', specs) as { reason: string }).reason, /more than one/);
  assert.match((parseStructuredCommand('```json\n{"tool":"read_file","args":{}, "also": 1}\n```', specs) as { reason: string }).reason, /no other keys/);
  assert.match((parseStructuredCommand('```json\n{"tool":"rm","args":{}}\n```', specs) as { reason: string }).reason, /no tool named/);
  assert.match((parseStructuredCommand('```json\n{"tool":"read_file","args":{"path":"a"', specs) as { reason: string }).reason, /not closed/);
  assert.match((parseStructuredCommand('```json\n{tool: read_file}\n```', specs) as { reason: string }).reason, /not valid JSON/);
});
