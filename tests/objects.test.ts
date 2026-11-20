/**
 * D3 living objects: create once, place on a page and in a timeline, edit at three scopes
 * (shared object, this universe, this instance), propagate without conflicts, keep hand edits,
 * and let the director see and edit them through the same commands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { SHARED_LINE_ID } from '../src/shared/types';
import { mergeObjectTexts } from '../src/objects/merge';
import { newObject, renderWeb, serializeObject } from '../src/objects/model';
import { commandCatalog } from '../src/director/director';
import { tempDir } from './helpers';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
const S = 240_000;
const SEQ = 'sequences/launch.mvseq.json';

async function setup() {
  const { dir, cleanup } = await tempDir('mv-objects-');
  const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => {}, cacheRoot: path.join(dir, 'cache') });
  const project = await service.createFromTemplate('landing', 'Orbit');
  const projectId = project.id;
  const playful = (await service.call('lines.create', { projectId, from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Playful', color: 'rose', description: '', following: true })).line.id;
  const run = (lineId: string, name: string, args: Record<string, unknown>) => service.call('commands.run', { projectId, lineId, name, args });
  const read = async (lineId: string, p: string) => (await service.call('files.read', { projectId, ref: { kind: 'line', lineId }, path: p })).text ?? '';
  const scene = async (lineId: string) => {
    const seq = JSON.parse(await read(lineId, SEQ)) as { tracks: { clips: { text?: string; subtitle?: string; object?: { instance: string } }[] }[] };
    return seq.tracks.flatMap((t) => t.clips).find((c) => c.object)!;
  };
  return { service, projectId, playful, run, read, scene, cleanup };
}

test('a pricing object placed on a page and in a video keeps both linked across universes and scopes', async () => {
  const h = await setup();
  try {
    // Manual workflow, in the Shared version: create, place on the page, add as a scene.
    await h.run(SHARED_LINE_ID, 'video.createSequence', { sequence: 'launch', name: 'Launch', settings: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, sampleRate: 48000, background: '#000000' } });
    await h.run(SHARED_LINE_ID, 'objects.create', { object: 'pro-plan', type: 'pricing-card', name: 'Pro plan' });
    await h.run(SHARED_LINE_ID, 'objects.place', { object: 'pro-plan', page: 'index.html', index: 1 });
    await h.run(SHARED_LINE_ID, 'objects.addScene', { object: 'pro-plan', sequence: 'launch', start: 2 * S, duration: 3 * S });
    const page = await h.read(SHARED_LINE_ID, 'index.html');
    assert.match(page, /data-mv-object="pro-plan"/);
    assert.match(page, /<link rel="stylesheet" href="objects\.css">/);
    assert.match(await h.read(SHARED_LINE_ID, 'objects.css'), /\.mv-obj-card/);
    assert.equal((await h.scene(SHARED_LINE_ID)).text, 'Pro — $12');
    const saved = await h.service.call('shared.save', { projectId: h.projectId, message: 'Pricing object' });
    assert.ok(saved.report?.lines.every((l) => l.outcome === 'applied'));
    assert.match(await h.read(h.playful, 'index.html'), /<span class="mv-obj-amount">\$12<\/span>/);

    // This universe: Playful charges less.
    await h.run(h.playful, 'objects.update', { object: 'pro-plan', properties: { price: '$9' }, sync: ['index.html', SEQ] });
    assert.match(await h.read(h.playful, 'index.html'), /<span class="mv-obj-amount">\$9<\/span>/);
    assert.match(await h.read(SHARED_LINE_ID, 'index.html'), /<span class="mv-obj-amount">\$12<\/span>/);
    assert.equal((await h.scene(h.playful)).text, 'Pro — $9');

    // Shared object: rename the plan. Playful gets the new name and keeps its own price, with no conflict.
    await h.run(SHARED_LINE_ID, 'objects.update', { object: 'pro-plan', properties: { plan: 'Pro+' }, sync: ['index.html', SEQ] });
    const report = (await h.service.call('shared.save', { projectId: h.projectId, message: 'Rename plan' })).report!;
    assert.deepEqual(report.lines.map((l) => l.outcome), ['applied']);
    const playfulPage = await h.read(h.playful, 'index.html');
    assert.match(playfulPage, /<h3 class="mv-obj-plan">Pro\+<\/h3>/);
    assert.match(playfulPage, /<span class="mv-obj-amount">\$9<\/span>/);
    assert.doesNotMatch(playfulPage, /<span class="mv-obj-amount">\$12<\/span>/);
    assert.equal((await h.scene(h.playful)).text, 'Pro+ — $9');
    assert.equal((await h.scene(SHARED_LINE_ID)).text, 'Pro+ — $12');

    // This instance: the video says “Free trial”; the page keeps $9.
    const inst = (await h.scene(h.playful)).object!.instance;
    await h.run(h.playful, 'objects.setInstance', { object: 'pro-plan', path: SEQ, instance: inst, overrides: { price: 'Free trial' } });
    assert.equal((await h.scene(h.playful)).text, 'Pro+ — Free trial');
    assert.match(await h.read(h.playful, 'index.html'), /<span class="mv-obj-amount">\$9<\/span>/);

    // Where is it used? Every universe, every placement, all current.
    const uses = await h.service.call('objects.uses', { projectId: h.projectId, objectId: 'pro-plan' });
    assert.deepEqual(uses.universes.map((u) => [u.name, u.placements.map((p) => `${p.kind}:${p.state}`).sort(), u.differsFromShared]), [
      ['Shared version', ['page:current', 'scene:current'], false],
      ['Playful', ['page:current', 'scene:current'], true],
    ]);
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('hand-edited placements are kept unless you choose to replace them; edits undo in one step', async () => {
  const h = await setup();
  try {
    await h.run(SHARED_LINE_ID, 'objects.create', { object: 'cta', type: 'call-to-action', name: 'Sign-up' });
    await h.run(SHARED_LINE_ID, 'objects.place', { object: 'cta', page: 'index.html', index: 0 });
    const page = await h.read(SHARED_LINE_ID, 'index.html');
    await h.service.call('files.write', { projectId: h.projectId, lineId: SHARED_LINE_ID, path: 'index.html', text: page.replace('Ready when you are', 'Ready when you are!!') });
    const before = (await h.service.call('objects.list', { projectId: h.projectId, lineId: SHARED_LINE_ID }))[0]!;
    assert.equal(before.placements[0]!.state, 'edited');

    await h.run(SHARED_LINE_ID, 'objects.update', { object: 'cta', properties: { button: 'Join now' }, sync: ['index.html'] });
    assert.match(await h.read(SHARED_LINE_ID, 'index.html'), /Ready when you are!!/);
    assert.doesNotMatch(await h.read(SHARED_LINE_ID, 'index.html'), /Join now/);
    await h.run(SHARED_LINE_ID, 'objects.sync', { object: 'cta', paths: ['index.html'], overwriteEdited: true });
    assert.match(await h.read(SHARED_LINE_ID, 'index.html'), /Join now/);
    assert.equal((await h.service.call('objects.list', { projectId: h.projectId, lineId: SHARED_LINE_ID }))[0]!.revision, 2);

    await h.service.call('commands.step', { projectId: h.projectId, lineId: SHARED_LINE_ID, scope: 'object:cta', direction: 'undo' });
    assert.match(await h.read(SHARED_LINE_ID, 'index.html'), /Ready when you are!!/);

    await h.run(SHARED_LINE_ID, 'objects.detach', { object: 'cta', path: 'index.html', instance: before.placements[0]!.instance });
    assert.doesNotMatch(await h.read(SHARED_LINE_ID, 'index.html'), /data-mv-object="cta"/);
    assert.equal((await h.service.call('objects.list', { projectId: h.projectId, lineId: SHARED_LINE_ID }))[0]!.placements.length, 0);
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('object files merge by property: one-sided changes flow in, the receiving universe keeps its own values', () => {
  const base = newObject('stat', 'statistic', 'Time saved');
  const ours = { ...base, properties: { ...base.properties, value: '50%' }, revision: 2 };
  const theirs = { ...base, properties: { ...base.properties, label: 'less time planning', value: '45%' }, revision: 2 };
  const merged = JSON.parse(mergeObjectTexts(serializeObject(base), serializeObject(ours), serializeObject(theirs))!);
  assert.equal(merged.properties.value, '50%');
  assert.equal(merged.properties.label, 'less time planning');
  assert.equal(merged.revision, 3);
  assert.equal(mergeObjectTexts(null, 'not json', serializeObject(theirs)), null);
});

test('rendering escapes content and never emits unsafe links', () => {
  const o = newObject('cta', 'call-to-action', 'x', { headline: '<script>alert(1)</script>', href: 'javascript:alert(1)' });
  const html = renderWeb(o, 'i1');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="#"/);
});

test('the director sees living objects and their commands', async () => {
  const { dir, cleanup } = await tempDir('mv-objects-dir-');
  try {
    const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => {} });
    const names = commandCatalog(service, 'objects').map((c) => c.name);
    assert.deepEqual(names, ['objects.addScene', 'objects.create', 'objects.detach', 'objects.place', 'objects.setInstance', 'objects.sync', 'objects.update']);
  } finally {
    await cleanup();
  }
});
