/**
 * The AI director drives the studio through the same command layer as the user (MOCKED model:
 * a scripted OpenAI-compatible stream; commands, files and history are real).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { AiService } from '../src/ai/service';
import { MemoryVault } from '../src/ai/vault';
import { toJsonSchema } from '../src/director/schema';
import { commandCatalog } from '../src/director/director';
import { ACTIVE_TASK_STATES, type TaskView } from '../src/shared/ai';
import { SHARED_LINE_ID } from '../src/shared/types';
import { TICKS_PER_SECOND } from '../src/shared/video';
import { z } from 'zod';
import { tempDir } from './helpers';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
const S = TICKS_PER_SECOND;
type Step = { text?: string; calls?: { name: string; args: unknown }[] };

function scripted(steps: Step[], requests: Record<string, unknown>[]): typeof fetch {
  let n = 0;
  return (async (url: string | URL, init: RequestInit = {}) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'mock/director' }] });
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
  const { dir, cleanup } = await tempDir('mv-director-');
  const requests: Record<string, unknown>[] = [];
  const workspace = path.join(dir, 'workspace');
  const ai = new AiService(path.join(workspace, 'ai.json'), new MemoryVault(), scripted(steps, requests));
  const service = new StudioService({ workspaceRoot: workspace, sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:1/`, emit: () => {}, ai, agent: { cacheRoot: path.join(dir, 'cache') }, cacheRoot: path.join(dir, 'cache') });
  const project = await service.createFromTemplate('launch-video', 'Orbit launch');
  const saved = await service.call('ai.connections.save', { name: 'Mock', provider: 'openai-compatible', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1' });
  await service.call('ai.models.add', { connectionId: saved.savedId, modelId: 'mock/director' });
  for (const job of ['assistant', 'coding'] as const) await service.call('ai.routing.set', { job, assignment: { connectionId: saved.savedId, modelId: 'mock/director' } });
  return { service, requests, projectId: project.id, cleanup };
}

async function settle(service: StudioService, projectId: string, taskId: string): Promise<TaskView> {
  for (let i = 0; i < 1500; i++) {
    const t = await service.call('ai.tasks.get', { projectId, taskId });
    if (!ACTIVE_TASK_STATES.includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for the task');
}

const ctx = {
  workspace: 'video',
  lineId: SHARED_LINE_ID,
  path: null,
  selection: null,
  references: [{ kind: 'sequence' as const, id: 'launch', label: 'Launch video' }],
  playhead: { sequenceId: 'launch', seconds: 10 },
};
const toolOutputs = (req: Record<string, unknown>): string[] => ((req.messages as { role: string; content: unknown }[]) ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content));

test('the director reads structured state and adds a title through the same command a user runs', async () => {
  const lowerThird = { sequence: 'launch', start: 10 * S, duration: 3 * S, text: 'Plan, then ship', template: 'lower-third' };
  const h = await setup([
    { calls: [{ name: 'get_studio_state', args: { include_assets: false } }] },
    { calls: [{ name: 'run_studio_command', args: { name: 'video.addText', args: { sequence: 'launch' } } }] },
    { calls: [{ name: 'run_studio_command', args: { name: 'video.addText', args: lowerThird } }] },
    { text: 'Added a lower third at 10 s.' },
  ]);
  try {
    const created = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'build', prompt: 'Add a lower third at the playhead', context: ctx, attachments: [] });
    const task = await settle(h.service, h.projectId, created.id);
    assert.equal(task.state, 'completed', JSON.stringify(task.error));
    const universe = task.workingLineId!;
    assert.notEqual(universe, SHARED_LINE_ID);

    // The model was offered the studio tools, and told what "this" refers to.
    const first = h.requests[0]!;
    const tools = ((first.tools as { function: { name: string } }[]) ?? []).map((t) => t.function.name);
    for (const t of ['get_studio_state', 'list_studio_commands', 'run_studio_command']) assert.ok(tools.includes(t), `${t} offered`);
    const system = String((first.messages as { role: string; content: string }[]).find((m) => m.role === 'system')?.content);
    assert.doesNotMatch(system, /The user referenced/, 'task context stays out of the cacheable instructions');
    const firstUser = JSON.stringify((first.messages as { role: string; content: unknown }[]).find((m) => m.role === 'user')?.content);
    assert.match(firstUser, /The user referenced: sequence launch/);
    assert.match(firstUser, /Video playhead: 10\.00 s/);

    // State: stable ids for sequences, tracks and clips; the references come back as given.
    const state = JSON.parse(toolOutputs(h.requests[1]!)[0]!) as { taskUniverse: { id: string }; references: unknown[]; sequences: { id: string; tracks: { id: string; clips: { id: string; template?: string }[] }[] }[] };
    assert.equal(state.taskUniverse.id, universe);
    assert.deepEqual(state.references, ctx.references);
    const titles = state.sequences[0]!.tracks.find((t) => t.id === 't1')!;
    assert.deepEqual(titles.clips.map((c) => c.template), ['title-card', 'lower-third', 'end-card']);
    assert.ok(titles.clips.every((c) => /^\S+$/.test(c.id)));

    // A malformed command is rejected by the same validation, changes nothing, and the error goes back to the model.
    assert.match(toolOutputs(h.requests[2]!).at(-1)!, /Invalid arguments for video\.addText/);

    // The title is the same editable object a user would create with the same command.
    const mine = await h.service.call('sequences.get', { projectId: h.projectId, lineId: universe, sequenceId: 'launch' });
    const added = mine.sequence.tracks.find((t) => t.id === 't1')!.clips.find((c) => c.type === 'text' && c.text === 'Plan, then ship')!;
    await h.service.call('commands.run', { projectId: h.projectId, lineId: SHARED_LINE_ID, name: 'video.addText', args: { ...lowerThird, clipId: added.id } });
    const shared = await h.service.call('sequences.get', { projectId: h.projectId, lineId: SHARED_LINE_ID, sequenceId: 'launch' });
    const userClip = shared.sequence.tracks.find((t) => t.id === 't1')!.clips.find((c) => c.id === added.id)!;
    assert.deepEqual(added, userClip);

    // One undo removes the director's edit (the history is shared with manual edits).
    const undo = await h.service.call('commands.step', { projectId: h.projectId, lineId: universe, scope: 'video:launch', direction: 'undo' });
    assert.match(undo.label ?? '', /lower third/i);
    const after = await h.service.call('sequences.get', { projectId: h.projectId, lineId: universe, sequenceId: 'launch' });
    assert.equal(after.sequence.tracks.find((t) => t.id === 't1')!.clips.length, 3);
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('ask mode cannot edit; autopilot needs the project setting and then grants routine permissions', async () => {
  const h = await setup([{ text: 'Here is what I see.' }]);
  try {
    const asked = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'ask', prompt: 'What is in this video?', context: ctx, attachments: [] });
    await settle(h.service, h.projectId, asked.id);
    assert.ok(!('tools' in h.requests[0]!) || !((h.requests[0]!.tools as { function: { name: string } }[]) ?? []).some((t) => t.function.name === 'run_studio_command'));

    await assert.rejects(h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'autopilot', prompt: 'Tidy the titles', context: ctx, attachments: [] }), /Autopilot is off for this project/);
    assert.deepEqual(await h.service.call('ai.project.get', { projectId: h.projectId }), { autopilot: false });
    await h.service.call('ai.project.set', { projectId: h.projectId, autopilot: true });
    const auto = await h.service.call('ai.tasks.create', { projectId: h.projectId, mode: 'autopilot', prompt: 'Tidy the titles', context: ctx, attachments: [] });
    assert.notEqual(auto.workingLineId, SHARED_LINE_ID, 'autopilot also works in its own universe');
    assert.deepEqual(auto.permissions, { editAlternative: true, runBuildAndTests: true, installDependencies: true, operatePreview: true });
    await settle(h.service, h.projectId, auto.id);
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('command arguments are described to the model as JSON Schema', () => {
  const schema = toJsonSchema(z.object({ a: z.string().min(1).max(5), b: z.number().int().min(0).optional(), c: z.enum(['x', 'y']).nullable(), d: z.array(z.boolean()).max(3) }));
  assert.deepEqual(schema, {
    type: 'object',
    properties: { a: { type: 'string', minLength: 1, maxLength: 5 }, b: { type: 'integer', minimum: 0 }, c: { anyOf: [{ type: 'string', enum: ['x', 'y'] }, { type: 'null' }] }, d: { type: 'array', items: { type: 'boolean' }, maxItems: 3 } },
    required: ['a', 'c', 'd'],
    additionalProperties: false,
  });
});

test('the catalog lists every registered command with its argument schema', async () => {
  const { dir, cleanup } = await tempDir('mv-catalog-');
  try {
    const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => {} });
    const all = commandCatalog(service);
    assert.equal(all.length, service.commandRegistry.names().length + service.operations.registry.all().length);
    assert.equal(all.find((c) => c.name === 'project.createUniverse')?.kind, 'operation');
    const addText = all.find((c) => c.name === 'video.addText')!;
    assert.equal(addText.domain, 'video');
    assert.deepEqual((addText.args as { required: string[] }).required.sort(), ['duration', 'sequence', 'start', 'text']);
    assert.ok(commandCatalog(service, 'design').every((c) => c.name.startsWith('design.')));
  } finally {
    await cleanup();
  }
});
