/**
 * D6 the Orbit demonstration, manual path (no provider connected), through the same commands the
 * buttons use: extend the app, two universes, shared pricing, tests, a story that is run, recorded
 * and put on the timeline with titles, different pacing, outcomes, a dependency-checked combine,
 * exports of the app and the video, and a restart that reopens everything.
 * Real browser (Playwright Chromium) and real FFmpeg; no model and no network.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { StudioService } from '../src/services/studio';
import { PlaywrightProbe } from '../e2e/harness/playwrightProbe';
import { SHARED_LINE_ID, type ContentRef } from '../src/shared/types';
import type { StoryStep } from '../src/shared/stories';
import type { ExportJobView, ExportSettings, Sequence } from '../src/shared/video';
import { tempDir } from './helpers';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
const S = 240_000;
const probe = new PlaywrightProbe();
after(() => probe.close());
const line = (lineId: string): ContentRef => ({ kind: 'line', lineId });
const SETTINGS: ExportSettings = { preset: 'sequence', resolution: 480, fps: 'sequence', quality: 'small', format: 'mp4', range: null };

/** The story a user records in Stories: create a task, see it counted, complete it. */
const FIRST_TASK: StoryStep[] = [
  { id: 'c1', kind: 'chapter', title: 'Your first task' },
  { id: 'f1', kind: 'fill', target: { by: 'label', name: 'Task title' }, text: '{{task}}' },
  { id: 'k1', kind: 'click', target: { by: 'role', role: 'button', name: 'Add task' } },
  { id: 'v1', kind: 'verify', target: { by: 'role', role: 'listitem', name: '{{task}}' }, expect: { visible: true } },
  { id: 'v2', kind: 'verify', target: { by: 'testid', value: 'count' }, expect: { text: '1 open' } },
  { id: 'a1', kind: 'annotate', text: 'Added and counted', seconds: 1 },
  { id: 'k2', kind: 'click', target: { by: 'role', role: 'checkbox', name: '{{task}}' } },
  { id: 'v3', kind: 'verify', target: { by: 'testid', value: 'count' }, expect: { text: '0 open' } },
  { id: 'k3', kind: 'click', target: { by: 'role', role: 'button', name: 'Clear completed' } },
  { id: 'v4', kind: 'verify', target: { by: 'role', role: 'listitem', name: '{{task}}' }, expect: { absent: true } },
  { id: 'n1', kind: 'narrate', text: 'Tick a task off, then clear completed tasks in one click.' },
];

async function waitExport(service: StudioService, projectId: string, jobId: string): Promise<ExportJobView> {
  for (let i = 0; i < 1200; i++) {
    const job = (await service.call('video.export.list', { projectId })).find((j) => j.id === jobId)!;
    if (!['queued', 'running'].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('export did not finish');
}

test('the Orbit demonstration runs end to end without a provider, and reopens after a restart', { timeout: 600_000 }, async () => {
  const { dir, cleanup } = await tempDir('mv-orbit-');
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
  const make = () => new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:${port}/`, emit: () => {}, cacheRoot: path.join(dir, 'cache'), agent: { cacheRoot: path.join(dir, 'cache'), probe } });
  service = make();
  try {
    // 1. No provider: everything below uses commands directly.
    const project = await service.createFromTemplate('orbit', 'Orbit');
    const projectId = project.id;
    const run = (lineId: string, name: string, args: Record<string, unknown>) => service.call('commands.run', { projectId, lineId, name, args });
    const read = async (lineId: string, p: string) => (await service.call('files.read', { projectId, ref: line(lineId), path: p })).text ?? '';
    const seq = async (lineId: string) => JSON.parse(await read(lineId, 'sequences/launch.mvseq.json')) as Sequence;

    // 2. Extend the task interface: a "Clear completed" action, with a test, as a reviewable patch.
    const tasksJs = await read(SHARED_LINE_ID, 'js/tasks.js');
    await service.call('files.write', { projectId, lineId: SHARED_LINE_ID, path: 'js/tasks.js', text: `${tasksJs}\nexport function clearCompleted(tasks) {\n  return tasks.filter((t) => !t.done);\n}\n` });
    const appJs = await read(SHARED_LINE_ID, 'js/app.js');
    await service.call('files.write', {
      projectId,
      lineId: SHARED_LINE_ID,
      path: 'js/app.js',
      text: appJs.replace("import { addTask,", "import { addTask, clearCompleted,").replace('\nrender();\n', "\ndocument.getElementById('clear-done').addEventListener('click', () => commit(clearCompleted(tasks)));\n\nrender();\n"),
    });
    const appHtml = await read(SHARED_LINE_ID, 'app.html');
    await service.call('files.write', { projectId, lineId: SHARED_LINE_ID, path: 'app.html', text: appHtml.replace('<p id="saved-note"', '<button type="button" id="clear-done">Clear completed</button>\n    <p id="saved-note"') });
    const testJs = await read(SHARED_LINE_ID, 'tests/tasks.test.js');
    await service.call('files.write', {
      projectId,
      lineId: SHARED_LINE_ID,
      path: 'tests/tasks.test.js',
      text: `${testJs.replace("import { addTask,", "import { addTask, clearCompleted,")}\ntest('clear completed keeps open tasks', () => {\n  const tasks = toggleTask(addTask(addTask([], 'A', opts('a')), 'B', opts('b')), 'a');\n  assert.deepEqual(clearCompleted(tasks).map((t) => t.id), ['b']);\n});\n`,
    });
    await service.call('shared.save', { projectId, message: 'Clear completed tasks' });

    // 3. Professional and Playful universes, both following Shared.
    const pro = (await service.call('lines.create', { projectId, from: line(SHARED_LINE_ID), name: 'Professional', color: 'sky', description: 'Calm and precise', following: true })).line.id;
    const playful = (await service.call('lines.create', { projectId, from: line(SHARED_LINE_ID), name: 'Playful', color: 'rose', description: 'Bright and quick', following: true })).line.id;
    await service.call('files.write', { projectId, lineId: playful, path: 'theme.css', text: (await read(playful, 'theme.css')).replace('--mv-color-primary: #1d5f8a;', '--mv-color-primary: #c2410c;').replace('--mv-radius: 10px;', '--mv-radius: 22px;') });

    // 4. Shared product information: one pricing card on the page and in the video; Playful runs a lower price.
    await run(playful, 'objects.update', { object: 'pro-plan', properties: { price: '$6' }, sync: ['index.html', 'sequences/launch.mvseq.json'] });
    assert.match(await read(playful, 'index.html'), /<span class="mv-obj-amount">\$6<\/span>/);
    assert.match(await read(pro, 'index.html'), /<span class="mv-obj-amount">\$8<\/span>/);
    const priceScene = (s: Sequence) => s.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text' && c.object?.id === 'pro-plan') as { text: string; id: string; start: number } | undefined;
    assert.match(priceScene(await seq(playful))!.text, /\$6/);

    // 5. Run the tests in each universe (measured, tied to the files).
    for (const id of [pro, playful]) {
      const r = await service.call('tests.run', { projectId, lineId: id });
      assert.equal(r.passed, true, r.output);
      assert.match(r.output, /^[#ℹ] pass 4$/m);
    }

    // 6. An executable story with fixture data.
    await run(pro, 'stories.create', { story: 'first-task', name: 'Create and complete a first task', page: 'app.html', fixtures: { task: 'Draft the launch notes' }, steps: FIRST_TASK, viewport: { width: 960, height: 640 }, timing: { stepDelayMs: 150, typingMsPerChar: 15, endHoldMs: 300 } });
    const tested = await service.call('stories.run', { projectId, lineId: pro, storyId: 'first-task' });
    assert.equal(tested.ok, true, JSON.stringify(tested.steps.filter((s) => s.ok === false)));
    assert.ok(Object.keys(tested.deps).includes('js/tasks.js'), 'the story is linked to the code it exercised');

    // 7–8. Record the passing story and put it on the launch timeline after the headline.
    const recorded = await service.call('stories.record', { projectId, lineId: pro, storyId: 'first-task', insert: { sequence: 'launch', start: 3 * S } });
    assert.equal(recorded.ok, true, recorded.error ?? '');
    assert.ok(recorded.assetId);
    let launch = await seq(pro);
    const clip = launch.tracks.flatMap((t) => t.clips).find((c) => c.type === 'media' && c.assetId === recorded.assetId)!;
    assert.equal(clip.start, 3 * S);

    // 9. Matching editable titles: the story's chapter, caption and narration are text clips; add a branded title.
    const texts = launch.tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips.map((c) => (c.type === 'text' ? c.text : '')));
    for (const t of ['Your first task', 'Added and counted', 'Tick a task off, then clear completed tasks in one click.']) assert.ok(texts.includes(t), `has “${t}”`);
    await run(pro, 'video.addText', { sequence: 'launch', start: 19 * S, duration: 2 * S, text: 'Made for focused weeks', template: 'lower-third' });

    // The Playful universe gets the same story and recording through Shared, then its own pacing.
    await service.call('files.write', { projectId, lineId: SHARED_LINE_ID, path: 'stories/first-task.mvstory.json', text: await read(pro, 'stories/first-task.mvstory.json') });
    await service.call('shared.save', { projectId, message: 'Share the first-task story' });
    const playRec = await service.call('stories.record', { projectId, lineId: playful, storyId: 'first-task', insert: { sequence: 'launch', start: 3 * S } });
    assert.equal(playRec.ok, true, playRec.error ?? '');

    // 10. Different pacing: Playful plays the demo faster and brings the price in earlier.
    let fun = await seq(playful);
    const funClip = fun.tracks.flatMap((t) => t.clips).find((c) => c.type === 'media' && c.assetId === playRec.assetId)!;
    await run(playful, 'video.setClip', { sequence: 'launch', clipId: funClip.id, patch: { speed: 1.5 } });
    await run(playful, 'video.moveClip', { sequence: 'launch', clipId: priceScene(fun)!.id, start: 16 * S });
    fun = await seq(playful);
    assert.equal((fun.tracks.flatMap((t) => t.clips).find((c) => c.id === funClip.id) as { speed: number }).speed, 1.5);

    // 11. Compare by outcomes.
    const o = await service.call('outcomes.compare', { projectId, refs: [line(pro), line(playful)] });
    assert.deepEqual(o.objects.find((x) => x.id === 'pro-plan')!.differs, ['price']);
    assert.ok(o.timelines.find((t) => t.id === 'launch')!.sides.every(Boolean));
    assert.notEqual(o.timelines.find((t) => t.id === 'launch')!.sides[0]!.hash, o.timelines.find((t) => t.id === 'launch')!.sides[1]!.hash);
    assert.deepEqual(o.tests.sides.map((t) => [t?.passed, t?.current]), [[true, true], [true, true]], 'both passed on their current code (timeline and story edits do not affect tests)');
    const story = o.stories.find((s) => s.id === 'first-task')!;
    assert.equal(story.sides[0]!.status, 'passing');
    assert.equal(story.sides[1]!.status, 'passing', 'the Playful recording run passed on its own files');

    // 12. Combine Playful's look and pacing into a new universe based on Professional (checkpoint first).
    const plan = {
      destination: { kind: 'new' as const, base: line(pro), name: 'Launch', color: 'teal' as const, description: 'Professional site, Playful colours and pace', following: true },
      files: { 'theme.css': { kind: 'take' as const, source: line(playful) }, 'sequences/launch.mvseq.json': { kind: 'take' as const, source: line(playful) } },
      sections: [],
      edits: {},
      description: 'Playful colours and pacing on the Professional site',
    };
    const proposal = await service.call('combine.preview', { projectId, plan });
    assert.ok(proposal.ready, JSON.stringify(proposal.warnings));
    assert.ok(proposal.warnings.every((w) => w.severity !== 'blocking'));
    const combined = await service.call('combine.apply', { projectId, plan });
    assert.ok(combined.checkpointId);
    const launchLine = combined.lineId;

    // 13. Export the chosen app (a plain folder) and the video (checked with ffprobe).
    const out = path.join(dir, 'export', 'orbit');
    const report = await service.call('export.run', { projectId, ref: line(launchLine), format: 'folder', destination: out });
    assert.deepEqual(report!.missingReferences, []);
    assert.match(await fs.readFile(path.join(out, 'app.html'), 'utf8'), /Clear completed/);
    await assert.rejects(fs.access(path.join(out, 'project.json')));
    const job = await service.call('video.export.start', { projectId, lineId: launchLine, sequenceId: 'launch', settings: SETTINGS });
    const done = await waitExport(service, projectId, job!.id);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(done.verified && done.verified.durationSeconds >= 20, `exported ${done.verified?.durationSeconds} s`);
    assert.equal(done.revision, (await service.engine(projectId)).line(launchLine).head);
    const dests = await service.call('releases.list', { projectId });
    assert.deepEqual(dests.map((d) => [d.kind, d.current]), [['video', true]], 'the video is its own destination');

    // 14. Restart: the project, its universes, history, stories, runs and exports reopen.
    const activity = (await service.call('ops.activity', { projectId })).length;
    await service.shutdown();
    service = make();
    const reopened = await service.call('projects.open', { projectId });
    assert.deepEqual(reopened.alternatives.map((a) => a.name).sort(), ['Launch', 'Playful', 'Professional']);
    assert.ok(reopened.checkpoints.some((c) => c.id === combined.checkpointId), 'the checkpoint before combining is kept');
    assert.ok((await service.call('ops.activity', { projectId })).length >= activity);
    const stories = await service.call('stories.list', { projectId, lineId: pro });
    assert.equal(stories[0]!.status, 'passing');
    assert.ok((await service.call('video.export.list', { projectId })).some((j) => j.id === job!.id && j.state === 'completed'));
    assert.equal((await service.call('tests.list', { projectId })).length, 2);
    assert.match(await (async () => (await service.call('files.read', { projectId, ref: line(launchLine), path: 'theme.css' })).text ?? '')(), /#c2410c/);
  } finally {
    await service.shutdown();
    previews.close();
    await cleanup();
  }
});
