/**
 * D4 executable stories, run in a real browser (Playwright Chromium) against real previews: tests,
 * recordings that exist only when the flow works, status when the product changes, and timelines
 * with editable overlays.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { StudioService } from '../src/services/studio';
import { PlaywrightProbe } from '../e2e/harness/playwrightProbe';
import { SHARED_LINE_ID } from '../src/shared/types';
import { storyDependencies, withFixtures } from '../src/stories/model';
import { commandCatalog } from '../src/director/director';
import type { Story, StoryStep } from '../src/shared/stories';
import { tempDir } from './helpers';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
const probe = new PlaywrightProbe();
after(() => probe.close());

export const TASK_APP: Record<string, string> = {
  'index.html': `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Tasks</title><link rel="stylesheet" href="styles.css"></head>
<body>
<main>
  <h1>Tasks</h1>
  <form id="new-task"><label for="title">Task title</label> <input id="title" placeholder="What needs doing?"> <button type="submit">Add task</button></form>
  <ul id="list" aria-label="Tasks"></ul>
  <p data-testid="count">0 open</p>
</main>
<script type="module" src="app.js"></script>
</body>
</html>
`,
  'styles.css': 'body { font-family: system-ui; margin: 40px; } li { padding: 4px 0; }\n',
  'tasks.js': `export function addTask(list, title) {
  const t = title.trim();
  if (!t) return list;
  return [...list, { id: list.length + 1, title: t, done: false }];
}
export function toggle(list, id) {
  return list.map((x) => (x.id === id ? { ...x, done: !x.done } : x));
}
export const openCount = (list) => list.filter((x) => !x.done).length;
`,
  'app.js': `import { addTask, toggle, openCount } from './tasks.js';
let tasks = [];
const list = document.getElementById('list');
const count = document.querySelector('[data-testid=count]');
function render() {
  list.innerHTML = '';
  for (const t of tasks) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = t.done;
    box.addEventListener('change', () => { tasks = toggle(tasks, t.id); render(); });
    label.append(box, ' ' + t.title);
    li.append(label);
    list.append(li);
  }
  count.textContent = openCount(tasks) + ' open';
}
document.getElementById('new-task').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('title');
  tasks = addTask(tasks, input.value);
  input.value = '';
  render();
});
render();
`,
};

export const FIRST_TASK_STEPS: StoryStep[] = [
  { id: 's1', kind: 'chapter', title: 'Your first task' },
  { id: 's2', kind: 'fill', target: { by: 'label', name: 'Task title' }, text: '{{task}}' },
  { id: 's3', kind: 'click', target: { by: 'role', role: 'button', name: 'Add task' } },
  { id: 's4', kind: 'verify', target: { by: 'role', role: 'listitem', name: '{{task}}' }, expect: { visible: true } },
  { id: 's5', kind: 'verify', target: { by: 'testid', value: 'count' }, expect: { text: '1 open' } },
  { id: 's6', kind: 'annotate', text: 'Added in one step', seconds: 1 },
  { id: 's7', kind: 'click', target: { by: 'role', role: 'checkbox', name: '{{task}}' } },
  { id: 's8', kind: 'verify', target: { by: 'testid', value: 'count' }, expect: { text: '0 open' } },
  { id: 's9', kind: 'narrate', text: 'Tick it off when it is done.' },
];

async function setup() {
  const { dir, cleanup } = await tempDir('mv-stories-');
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
  service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:${port}/`, emit: () => {}, cacheRoot: path.join(dir, 'cache'), agent: { cacheRoot: path.join(dir, 'cache'), probe } });
  const site = path.join(dir, 'site');
  await fs.mkdir(site);
  for (const [p, text] of Object.entries(TASK_APP)) await fs.writeFile(path.join(site, p), text);
  const projectId = (await service.call('projects.import', { folderPath: site }))!.project.id;
  const run = (name: string, args: Record<string, unknown>, lineId = SHARED_LINE_ID) => service.call('commands.run', { projectId, lineId, name, args });
  await run('stories.create', { story: 'first-task', name: 'Create and complete a first task', page: 'index.html', fixtures: { task: 'Write launch notes' }, steps: FIRST_TASK_STEPS, viewport: { width: 800, height: 600 }, timing: { stepDelayMs: 100, typingMsPerChar: 15, endHoldMs: 200 } });
  return {
    service,
    projectId,
    run,
    cleanup: async () => {
      await service.shutdown();
      previews.close();
      await cleanup();
    },
  };
}

test('a story runs as a browser test linked to the exact files, and notices when the product changes', async () => {
  const h = await setup();
  try {
    const pass = await h.service.call('stories.run', { projectId: h.projectId, lineId: SHARED_LINE_ID, storyId: 'first-task' });
    assert.equal(pass.ok, true, JSON.stringify(pass.steps.filter((s) => s.ok === false)));
    assert.equal(pass.mode, 'test');
    assert.deepEqual(pass.steps.map((s) => s.ok), [null, true, true, true, true, null, true, true, null], 'presentation steps are not part of the test');
    assert.deepEqual(Object.keys(pass.deps).sort(), ['app.js', 'index.html', 'styles.css', 'tasks.js']);
    assert.equal(pass.depsCertain, true);
    assert.match(pass.sourceHash, /^[0-9a-f]{16}$/);
    assert.ok(await h.service.call('stories.screenshot', { projectId: h.projectId, runId: pass.id }));
    let [view] = await h.service.call('stories.list', { projectId: h.projectId, lineId: SHARED_LINE_ID });
    assert.equal(view!.status, 'passing');

    // The product changes: the story needs a new run, and the new run fails with the reason.
    const app = (await h.service.call('files.read', { projectId: h.projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID }, path: 'tasks.js' })).text!;
    await h.service.call('files.write', { projectId: h.projectId, lineId: SHARED_LINE_ID, path: 'tasks.js', text: app.replace('!x.done).length', '!x.done).length + 1') });
    [view] = await h.service.call('stories.list', { projectId: h.projectId, lineId: SHARED_LINE_ID });
    assert.equal(view!.status, 'needs-check');
    assert.deepEqual(view!.changedDeps, ['tasks.js']);
    const fail = await h.service.call('stories.run', { projectId: h.projectId, lineId: SHARED_LINE_ID, storyId: 'first-task' });
    assert.equal(fail.ok, false);
    assert.match(fail.error!, /does not show "1 open"/);
    [view] = await h.service.call('stories.list', { projectId: h.projectId, lineId: SHARED_LINE_ID });
    assert.equal(view!.status, 'failing');
    assert.equal(view!.lastPassing?.id, pass.id, 'the previous successful run is kept');

    // A failing flow is never recorded as a success.
    const media = async () => (await h.service.video.store(h.projectId).then((s) => s.list())).length;
    const before = await media();
    const rec = await h.service.call('stories.record', { projectId: h.projectId, lineId: SHARED_LINE_ID, storyId: 'first-task', insert: { sequence: 'demo' } });
    assert.equal(rec.ok, false);
    assert.equal(rec.assetId, null);
    assert.equal(await media(), before);
    const seqs = await h.service.call('sequences.list', { projectId: h.projectId, lineId: SHARED_LINE_ID });
    assert.equal(seqs.length, 0, 'nothing was added to a timeline');
  } finally {
    await h.cleanup();
  }
});

test('a working flow is recorded, enters Assets with its run, and lands in a timeline with editable overlays', async () => {
  const h = await setup();
  try {
    const rec = await h.service.call('stories.record', { projectId: h.projectId, lineId: SHARED_LINE_ID, storyId: 'first-task', insert: { sequence: 'demo' } });
    assert.equal(rec.ok, true, rec.error ?? '');
    assert.ok(rec.assetId);
    const store = await h.service.video.store(h.projectId);
    const asset = await store.get(rec.assetId!);
    assert.equal(asset.provenance?.source, 'recording');
    assert.equal(asset.provenance?.settings.story, 'first-task');
    assert.equal(asset.provenance?.settings.run, rec.id);
    assert.ok((asset.probe.durationSeconds ?? 0) > 1);
    const { sequence } = await h.service.call('sequences.get', { projectId: h.projectId, lineId: SHARED_LINE_ID, sequenceId: 'demo' });
    assert.deepEqual(sequence.settings.width, 800);
    const clips = sequence.tracks.flatMap((t) => t.clips.map((c) => ({ track: t.name, c })));
    assert.ok(clips.some(({ c }) => c.type === 'media' && c.assetId === rec.assetId));
    const titles = clips.filter(({ c }) => c.type === 'text').map(({ track, c }) => [track, c.type === 'text' ? (c.template ?? 'plain') : '', c.type === 'text' ? c.text : '']);
    assert.deepEqual(titles, [
      ['Story titles', 'title-card', 'Your first task'],
      ['Story titles', 'lower-third', 'Added in one step'],
      ['Story narration', 'plain', 'Tick it off when it is done.'],
    ]);
    const log = await h.service.call('ops.activity', { projectId: h.projectId });
    assert.ok(log.some((r) => r.type === 'story.record' && r.ok && r.actor === 'user'));
    assert.ok(log.some((r) => r.type === 'stories.addToSequence'));
  } finally {
    await h.cleanup();
  }
});

test('fixtures fill in, unknown fixtures are refused, and dependencies are worked out honestly', () => {
  const steps = withFixtures([{ id: 'a', kind: 'fill', target: { by: 'label', name: 'Title' }, text: 'Hello {{name}}' }], { name: 'Ada' });
  assert.equal((steps[0] as { text: string }).text, 'Hello Ada');
  assert.throws(() => withFixtures([{ id: 'a', kind: 'fill', target: { by: 'label', name: 'Title' }, text: '{{nope}}' }], {}), /fixture “nope”/);

  const story = { page: 'index.html', steps: [], dependsOn: null } as unknown as Story;
  const files = new Map(Object.keys(TASK_APP).map((p) => [p, 'h']));
  const read = (p: string) => TASK_APP[p] ?? null;
  assert.deepEqual(storyDependencies(story, files, read), { deps: ['app.js', 'index.html', 'styles.css', 'tasks.js'], certain: true });
  const dynamic: Record<string, string> = { ...TASK_APP, 'app.js': `${TASK_APP['app.js']}\nconst f = 'x.json'; fetch(f);` };
  assert.equal(storyDependencies(story, files, (p) => dynamic[p] ?? null).certain, false);
  const app = new Map([...files, ['package.json', 'h']]);
  assert.equal(storyDependencies(story, app, (p) => (p === 'package.json' ? '{"scripts":{"dev":"vite"}}' : read(p))).certain, false);
});

test('an exported walkthrough performs the story step by step when served with the app', async () => {
  const h = await setup();
  const { createRequire } = await import('node:module');
  const { chromium } = createRequire('/opt/npm-tools/node_modules/')('playwright') as { chromium: { launch(o: unknown): Promise<{ newPage(): Promise<any>; close(): Promise<void> }> } };
  let server: http.Server | null = null;
  try {
    await h.run('stories.exportWalkthrough', { story: 'first-task' });
    const tree = await h.service.call('files.list', { projectId: h.projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID } });
    const files = new Map<string, string>();
    for (const f of tree) files.set(f.path, (await h.service.call('files.read', { projectId: h.projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID }, path: f.path })).text ?? '');
    assert.ok(files.has('walkthroughs/first-task.html') && files.has('walkthroughs/walkthrough.js'));
    // Serve the site normally (same origin for the walkthrough and the app), as a published site would be.
    server = http.createServer((req, res) => {
      const p = decodeURIComponent((req.url ?? '/').split('?')[0]!.replace(/^\/+/, '')) || 'index.html';
      const body = files.get(p);
      if (body === undefined) return void (res.writeHead(404), res.end());
      res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : p.endsWith('.css') ? 'text/css' : 'text/javascript' });
      res.end(body);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const browser = await chromium.launch({ args: ['--no-proxy-server'] });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/walkthroughs/first-task.html`);
      await page.frameLocator('#wt-frame').getByRole('heading', { name: 'Tasks' }).waitFor();
      for (let i = 0; i < 12 && !(await page.locator('#wt-next').isDisabled()); i++) {
        const before = await page.locator('#wt-count').innerText();
        await page.locator('#wt-next').click();
        await page.waitForFunction((b: string) => { const d = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document; return d.querySelector('#wt-count')?.textContent !== b || /did not work|can only control/.test(d.querySelector('#wt-note')?.textContent ?? ''); }, before, { timeout: 15000 });
        assert.doesNotMatch(await page.locator('#wt-note').innerText(), /did not work|can only control/);
      }
      assert.equal(await page.locator('#wt-count').innerText(), 'Done', await page.locator('#wt-note').innerText());
      assert.equal(await page.frameLocator('#wt-frame').getByTestId('count').innerText(), '0 open');
    } finally {
      await browser.close();
    }
  } finally {
    server?.close();
    await h.cleanup();
  }
});

test('the director can run and record stories through the same commands', async () => {
  const { dir, cleanup } = await tempDir('mv-stories-cat-');
  try {
    const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => {} });
    const names = commandCatalog(service).map((c) => c.name);
    for (const n of ['stories.create', 'stories.update', 'stories.addToSequence', 'story.run', 'story.record', 'story.addToTimeline']) assert.ok(names.includes(n), n);
  } finally {
    await cleanup();
  }
});

test('a run cut off by closing the app is reported as interrupted, never as passing', async () => {
  const h = await setup();
  try {
    const pass = await h.service.call('stories.run', { projectId: h.projectId, lineId: SHARED_LINE_ID, storyId: 'first-task' });
    const engine = await h.service.engine(h.projectId);
    const file = path.join(engine.dir, 'story-runs', 'runs.json');
    const list = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>[];
    await fs.writeFile(file, JSON.stringify([{ ...list[0], id: 'r-cut', ok: true, running: true, mode: 'recording', assetId: null }, ...list]));
    const runs = await h.service.call('stories.runs', { projectId: h.projectId });
    const cut = runs.find((r) => r.id === 'r-cut')!;
    assert.deepEqual([cut.ok, cut.interrupted], [false, true]);
    assert.match(cut.error ?? '', /Interrupted when the app closed/);
    const [view] = await h.service.call('stories.list', { projectId: h.projectId, lineId: SHARED_LINE_ID });
    assert.equal(view!.status, 'failing');
    assert.equal(view!.lastPassing?.id, pass.id, 'the earlier passing run is kept');
  } finally {
    await h.cleanup();
  }
});
