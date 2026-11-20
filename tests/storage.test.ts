/**
 * Settings → Storage: cache categories are measured apart from history and originals, cleanup is
 * refused while something uses a category, and cleaning never touches project data.
 * Also covers the heavy-work limiter.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { Limiter } from '../src/video/ffmpeg';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-storage-'));
  dirs.push(dir);
  const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => {}, cacheRoot: path.join(dir, 'cache'), agent: { cacheRoot: path.join(dir, 'cache') } });
  return { service, dir };
}

test('usage separates caches from history and media originals; cleaning a category leaves projects intact', async () => {
  const { service, dir } = await setup();
  const projectId = (await service.call('projects.createSample', {})).id;
  // Fake derived previews and a run folder.
  await fs.mkdir(path.join(dir, 'cache', 'media', 'abc'), { recursive: true });
  await fs.writeFile(path.join(dir, 'cache', 'media', 'abc', 'thumb.jpg'), Buffer.alloc(2048));
  await fs.mkdir(path.join(dir, 'cache', 'runs', projectId, 'build-x', 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(dir, 'cache', 'runs', projectId, 'build-x', 'node_modules', 'big.js'), Buffer.alloc(4096));

  const before = await service.call('storage.usage', {});
  const cat = (v: typeof before, id: string) => v.categories.find((c) => c.id === id)!;
  assert.equal(cat(before, 'media').bytes, 2048);
  assert.equal(cat(before, 'runs').bytes, 4096);
  assert.equal(cat(before, 'media').blocked, null);
  const p = before.projects.find((x) => x.id === projectId)!;
  assert.ok(p.historyBytes > 0, 'history is measured');

  const cleaned = await service.call('storage.clean', { category: 'media' });
  assert.equal(cleaned.freed, 2048);
  assert.equal(cat(cleaned.view, 'media').bytes, 0);
  assert.equal(cleaned.view.projects.find((x) => x.id === projectId)!.historyBytes, p.historyBytes, 'history untouched');
  const runs = await service.call('storage.clean', { category: 'runs' });
  assert.equal(runs.freed, 4096);
  // The project still opens and reads normally.
  const view = await service.call('projects.open', { projectId });
  assert.ok(view.alternatives.length > 0);

  const compact = await service.call('storage.compact', { projectId });
  assert.ok(compact.objects >= 0 && compact.revisions >= 0);
  await service.shutdown();
});

test('cleanup is refused while a category is in use', async () => {
  const { service } = await setup();
  const exportsBusy = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service.video.exports), 'busy')!;
  Object.defineProperty(service.video.exports, 'busy', { get: () => true, configurable: true });
  await assert.rejects(service.call('storage.clean', { category: 'exports' }), /Not cleaned: A video export is running/);
  assert.match((await service.call('storage.usage', {})).categories.find((c) => c.id === 'exports')!.blocked ?? '', /export is running/);
  Object.defineProperty(service.video.exports, 'busy', exportsBusy);
  await service.call('storage.clean', { category: 'exports' });
  await service.shutdown();
});

test('the heavy-work limiter never runs more than its limit at once', async () => {
  const limiter = new Limiter(2);
  let running = 0;
  let peak = 0;
  const job = () =>
    limiter.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
    });
  await Promise.all(Array.from({ length: 7 }, job));
  assert.equal(peak, 2);
  assert.equal(limiter.running, 0);
  assert.equal(limiter.queued, 0);
});
