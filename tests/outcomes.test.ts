/**
 * D5 whole-outcome universes: stories merge by step, combining warns about what picked parts rely
 * on (with a part to include), and universes compare by measured outcomes tied to their files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { SHARED_LINE_ID, type ContentRef } from '../src/shared/types';
import { mergeStoryTexts } from '../src/stories/merge';
import { serializeStory } from '../src/stories/model';
import type { Story } from '../src/shared/stories';
import { tempDir } from './helpers';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
const line = (lineId: string): ContentRef => ({ kind: 'line', lineId });

const story = (steps: Story['steps'], extra: Partial<Story> = {}): Story => ({
  format: 'multiverse-story',
  version: 1,
  id: 'first-task',
  name: 'Create a first task',
  description: '',
  page: 'index.html',
  viewport: { width: 1280, height: 800 },
  fixtures: {},
  steps,
  timing: { stepDelayMs: 600, typingMsPerChar: 45, endHoldMs: 1500 },
  dependsOn: null,
  ...extra,
});

test('stories merge by step: different edits combine, the same step edited twice does not', () => {
  const base = story([
    { id: 'a', kind: 'click', target: { by: 'text', text: 'New' } },
    { id: 'b', kind: 'verify', target: null, expect: { text: 'Saved' } },
  ]);
  const ours = story([...base.steps, { id: 'c', kind: 'annotate', text: 'Tasks save as you type', seconds: 2 }]);
  const theirs = story([{ id: 'z', kind: 'chapter', title: 'Getting started' }, base.steps[0]!, { ...base.steps[1]!, expect: { text: 'Saved!' } } as Story['steps'][number]], { fixtures: { task: 'Write the brief' } });
  const merged = JSON.parse(mergeStoryTexts(serializeStory(base), serializeStory(ours), serializeStory(theirs))!) as Story;
  assert.deepEqual(merged.steps.map((s) => s.id), ['z', 'a', 'b', 'c']);
  assert.deepEqual((merged.steps[2] as { expect: { text: string } }).expect, { text: 'Saved!' });
  assert.deepEqual(merged.fixtures, { task: 'Write the brief' });
  const clash = story([base.steps[0]!, { ...base.steps[1]!, expect: { text: 'Done' } } as Story['steps'][number]]);
  assert.equal(mergeStoryTexts(serializeStory(base), serializeStory(clash), serializeStory(theirs)), null);
});

async function setup() {
  const { dir, cleanup } = await tempDir('mv-outcomes-');
  const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => {}, cacheRoot: path.join(dir, 'cache'), agent: { cacheRoot: path.join(dir, 'cache') } });
  const project = await service.createFromTemplate('landing', 'Orbit');
  const projectId = project.id;
  const alt = async (name: string) => (await service.call('lines.create', { projectId, from: line(SHARED_LINE_ID), name, color: 'rose', description: '', following: true })).line.id;
  const run = (lineId: string, name: string, args: Record<string, unknown>) => service.call('commands.run', { projectId, lineId, name, args });
  const write = (lineId: string, p: string, text: string) => service.call('files.write', { projectId, lineId, path: p, text });
  return { service, projectId, alt, run, write, cleanup };
}

test('combining warns about the objects, stylesheet and story targets that picked parts rely on, and offers to include them', async () => {
  const h = await setup();
  try {
    const playful = await h.alt('Playful');
    await h.run(playful, 'objects.create', { object: 'pro-plan', type: 'pricing-card', name: 'Pro plan' });
    await h.run(playful, 'objects.place', { object: 'pro-plan', page: 'index.html', index: 1 });
    await h.write(playful, 'counter.html', '<!doctype html><title>Count</title><p data-testid="count">0 open</p>');
    await h.write(playful, 'stories/first-task.mvstory.json', serializeStory(story([{ id: 'v', kind: 'verify', target: { by: 'testid', value: 'count' }, expect: { text: '0 open' } }], { page: 'counter.html' })));
    const plan = (files: Record<string, { kind: 'take'; source: ContentRef }>) => ({ destination: { kind: 'new' as const, base: line(SHARED_LINE_ID), name: 'Combined', color: 'teal' as const, description: '', following: true }, files, sections: [], edits: {}, description: '' });
    const take = { kind: 'take' as const, source: line(playful) };
    const first = await h.service.call('combine.preview', { projectId: h.projectId, plan: plan({ 'index.html': take, 'stories/first-task.mvstory.json': take }) });
    const deps = first.warnings.filter((w) => w.kind === 'dependency');
    const includes = deps.map((w) => w.include?.path).filter(Boolean).sort();
    assert.deepEqual(includes, ['counter.html', 'objects.css', 'objects/pro-plan.mvobj.json'], JSON.stringify(deps, null, 1));
    assert.ok(deps.find((w) => w.path === 'objects/pro-plan.mvobj.json')!.message.includes('“Pro plan”'));
    assert.ok(deps.every((w) => w.severity === 'warning'), 'dependencies warn; they do not block');
    assert.ok(first.ready, 'the combination can still be applied as chosen');
    assert.ok(first.warnings.some((w) => w.kind === 'story' && /“Create a first task” will need checking/.test(w.message)));
    // Include what was suggested: nothing is missing any more.
    const all = Object.fromEntries(['index.html', 'stories/first-task.mvstory.json', ...includes].map((p) => [p, take]));
    const second = await h.service.call('combine.preview', { projectId: h.projectId, plan: plan(all as Record<string, typeof take>) });
    assert.deepEqual(second.warnings.filter((w) => w.kind === 'dependency'), []);
    const applied = await h.service.call('combine.apply', { projectId: h.projectId, plan: plan(all as Record<string, typeof take>) });
    assert.ok(applied.checkpointId, 'a checkpoint is created before the combination');
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('combining two universes that edited different story steps merges them by step', async () => {
  const h = await setup();
  try {
    const base = story([
      { id: 'a', kind: 'click', target: { by: 'text', text: 'Start' } },
      { id: 'b', kind: 'verify', target: null, expect: { text: 'Welcome' } },
    ]);
    await h.write(SHARED_LINE_ID, 'stories/first-task.mvstory.json', serializeStory(base));
    await h.service.call('shared.save', { projectId: h.projectId, message: 'Story' });
    const a = await h.alt('Calm');
    const b = await h.alt('Bold');
    await h.write(a, 'stories/first-task.mvstory.json', serializeStory(story([{ id: 'ch', kind: 'chapter', title: 'Start here' }, ...base.steps])));
    await h.write(b, 'stories/first-task.mvstory.json', serializeStory(story([...base.steps, { id: 'n', kind: 'narrate', text: 'That is all it takes.' }])));
    const plan = { destination: { kind: 'existing' as const, lineId: a }, files: { 'stories/first-task.mvstory.json': { kind: 'merge' as const, source: line(b) } }, sections: [], edits: {}, description: '' };
    const proposal = await h.service.call('combine.preview', { projectId: h.projectId, plan });
    assert.deepEqual(proposal.conflicts, []);
    assert.ok(proposal.ready);
    await h.service.call('combine.apply', { projectId: h.projectId, plan });
    const merged = JSON.parse((await h.service.call('files.read', { projectId: h.projectId, ref: line(a), path: 'stories/first-task.mvstory.json' })).text!) as Story;
    assert.deepEqual(merged.steps.map((s) => s.id), ['ch', 'a', 'b', 'n']);
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('outcomes compare universes by objects, pages, stories and measured tests tied to their files', async () => {
  const h = await setup();
  try {
    await h.write(SHARED_LINE_ID, 'package.json', JSON.stringify({ name: 'orbit', private: true, scripts: { test: 'node --test' } }, null, 2));
    await h.write(SHARED_LINE_ID, 'math.test.js', "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('adds', () => assert.equal(1 + 1, 2));\n");
    await h.run(SHARED_LINE_ID, 'objects.create', { object: 'pro-plan', type: 'pricing-card', name: 'Pro plan' });
    await h.service.call('shared.save', { projectId: h.projectId, message: 'Tests and pricing' });
    const cheap = await h.alt('Cheaper');
    await h.run(cheap, 'objects.update', { object: 'pro-plan', properties: { price: '$9' }, sync: [] });
    await h.write(cheap, 'stories/first-task.mvstory.json', serializeStory(story([{ id: 'v', kind: 'verify', target: null, expect: { text: 'Orbit' } }])));

    const run = await h.service.call('tests.run', { projectId: h.projectId, lineId: cheap });
    assert.equal(run.passed, true, run.output);
    assert.equal(run.lineId, cheap);
    let o = await h.service.call('outcomes.compare', { projectId: h.projectId, refs: [line(SHARED_LINE_ID), line(cheap)] });
    assert.deepEqual(o.sides.map((s) => s.label), ['Shared version', 'Cheaper']);
    assert.ok(o.sides[1]!.files!.modified + o.sides[1]!.files!.added > 0);
    const pro = o.objects.find((x) => x.id === 'pro-plan')!;
    assert.deepEqual(pro.differs, ['price']);
    assert.equal(pro.sides[1]!.properties.price, '$9');
    assert.ok(o.pages.some((p) => p.path === 'index.html' && p.sides.every(Boolean)));
    const st = o.stories.find((s) => s.id === 'first-task')!;
    assert.equal(st.sides[0], null, 'the story is only in Cheaper');
    assert.equal(st.sides[1]!.status, 'never-run', 'no run means no result, not a pass');
    assert.equal(o.tests.sides[0], null, 'Shared has no test run of its own');
    assert.deepEqual([o.tests.sides[1]!.passed, o.tests.sides[1]!.current], [true, true]);
    // A code change makes the earlier result stale rather than silently current.
    await h.write(cheap, 'math.test.js', "const { test } = require('node:test');\ntest('still adds', () => {});\n");
    o = await h.service.call('outcomes.compare', { projectId: h.projectId, refs: [line(SHARED_LINE_ID), line(cheap)] });
    assert.equal(o.tests.sides[1]!.current, false);
    // The activity log shows the run as a command of the user.
    const log = await h.service.call('ops.activity', { projectId: h.projectId });
    assert.ok(log.some((r) => r.type === 'code.runTests' && r.actor === 'user'));
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});
