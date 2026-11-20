/**
 * Brand settings with a propagation preview, shared media copied into versions (with outdated
 * copies after the library asset changes), font assets, and exports marked outdated when their
 * sequence or media change. Uses real FFmpeg for media; no AI provider is involved.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { setFontFaces, planWebsiteTheme } from '../src/video/brand';
import { buildRenderPlan } from '../src/video/render';
import { TICKS_PER_SECOND, type ExportJobView, type MediaAssetView } from '../src/shared/video';
import { SHARED_LINE_ID } from '../src/shared/types';

const ROOT = path.resolve(import.meta.dirname, '..');
const T = TICKS_PER_SECOND;
let dir = '';

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-brand-'));
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=120x80', '-frames:v', '1', path.join(dir, 'hero.png')]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=120x80', '-frames:v', '1', path.join(dir, 'hero-blue.png')]);
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'clip.mp4')]);
  await fs.copyFile(path.join(ROOT, 'resources', 'fonts', 'Inter-SemiBold.otf'), path.join(dir, 'Brand Sans.otf'));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function setup(name: string) {
  const ws = path.join(dir, name);
  const service = new StudioService({ workspaceRoot: ws, sampleRoot: path.join(ROOT, 'sample'), templateRoot: path.join(ROOT, 'templates'), previewUrl: (t) => `http://${t}.localhost:1/`, emit: () => {}, cacheRoot: path.join(ws, '.cache'), resourcesRoot: path.join(ROOT, 'resources') });
  const created = await service.call('projects.createFromTemplate', { templateId: 'landing', name: 'Kiln' });
  const projectId = created.id;
  const read = async (lineId: string, p: string) => (await service.call('files.read', { projectId, ref: { kind: 'line', lineId }, path: p })).text;
  return { service, projectId, read };
}

test('font faces are kept in one managed block; theme planning maps names to tokens', () => {
  const css = '@import url("x.css");\n:root { --mv-color-primary: #111111; --mv-font-heading: Georgia, serif; }\n';
  const once = setFontFaces(css, [{ family: 'Brand Sans', src: 'fonts/brand.otf', format: 'opentype' }]);
  assert.ok(once.startsWith('@import url("x.css");\n/* mv:brand-fonts'));
  const twice = setFontFaces(once, [{ family: 'Brand Serif', src: 'fonts/serif.woff2', format: 'woff2' }]);
  assert.equal(twice.match(/@font-face/g)?.length, 1);
  assert.match(twice, /Brand Serif/);
  assert.equal(setFontFaces(twice, []), css);

  const plan = planWebsiteTheme(
    { colors: [{ id: 'c1', name: 'Primary', value: '#C2410C' }, { id: 'c2', name: 'Accent', value: '#0F766E' }], fonts: [{ id: 'f1', name: 'Heading', family: 'Brand Sans', assetId: 'm-font' }], textStyles: [], logoAssetId: null },
    'theme.css',
    [{ name: '--mv-color-primary', value: '#111111' }, { name: '--mv-font-heading', value: 'Georgia, serif' }],
    new Map([['m-font', { name: 'Brand Sans.otf', ext: 'otf', sha256: 'ab12cd34ef' }]]),
  );
  assert.deepEqual(plan.tokens, { '--mv-color-primary': '#C2410C', '--mv-font-heading': '"Brand Sans", serif' });
  assert.deepEqual(plan.fontFiles, [{ path: 'fonts/brand-sans-ab12cd34.otf', assetId: 'm-font' }]);
  assert.deepEqual(plan.faces, [{ family: 'Brand Sans', src: 'fonts/brand-sans-ab12cd34.otf', format: 'opentype' }]);
});

test('brand update: preview per version, apply only what was ticked, with a checkpoint and undo', async () => {
  const h = await setup('brand');
  const { service, projectId } = h;
  const fontAsset = (await service.call('media.import', { projectId, paths: [path.join(dir, 'Brand Sans.otf')] }))!.imported[0]!;
  assert.equal(fontAsset.kind, 'font');
  assert.equal(fontAsset.thumbUrl, null);
  await assert.rejects(service.call('commands.run', { projectId, lineId: SHARED_LINE_ID, name: 'video.addClip', args: { sequence: 'x', assetId: fontAsset.id, media: { kind: 'font', duration: null } } }));

  // An alternative and a video with a title that follows a brand style.
  const alt = await service.call('lines.create', { projectId, from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Bold', color: 'violet', description: '', following: true });
  const run = (name: string, args: Record<string, unknown>) => service.call('commands.run', { projectId, lineId: alt.line.id, name, args });
  await run('video.createSequence', { sequence: 'promo', name: 'Promo', settings: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, sampleRate: 48000, background: '#000000' } });
  await run('video.addText', { sequence: 'promo', start: 0, duration: 2 * T, text: 'Kiln', template: 'title-card', brandStyleId: 'ts-head' });
  await run('video.addText', { sequence: 'promo', start: 2 * T, duration: T, text: 'Not branded' });

  const brand = await service.call('brand.set', {
    projectId,
    brand: {
      colors: [{ id: 'c-primary', name: 'Primary', value: '#C2410C' }, { id: 'c-ink', name: 'Ink', value: '#FAFAF9' }],
      fonts: [{ id: 'f-head', name: 'Heading', family: 'Brand Sans', assetId: fontAsset.id }],
      textStyles: [{ id: 'ts-head', name: 'Headline', fontId: 'f-head', size: 120, weight: 700, lineHeight: 1.1, colorId: 'c-ink' }, { id: 'ts-unused', name: 'Caption', fontId: null, size: 40, weight: 400, lineHeight: 1.3, colorId: null }],
      logoAssetId: null,
    },
  });
  assert.equal(brand.colors.length, 2);
  await assert.rejects(service.call('brand.set', { projectId, brand: { ...brand, colors: [{ id: 'x', name: 'Bad', value: 'red' }] } }), /Brand settings/);

  const themeBefore = await h.read(SHARED_LINE_ID, 'theme.css');
  const plan = await service.call('brand.plan', { projectId });
  assert.deepEqual(await h.read(SHARED_LINE_ID, 'theme.css'), themeBefore, 'previewing changes nothing');
  const ids = plan.items.map((i) => i.id).sort();
  assert.deepEqual(ids, [`${alt.line.id}:seq:promo`, `${alt.line.id}:theme`, `${SHARED_LINE_ID}:theme`].sort());
  const sharedTheme = plan.items.find((i) => i.id === `${SHARED_LINE_ID}:theme`)!;
  assert.ok(sharedTheme.changes.some((c) => c.startsWith('--mv-color-primary:') && c.endsWith('→ #C2410C')));
  assert.ok(sharedTheme.changes.some((c) => c.startsWith('--mv-font-heading:')));
  assert.equal(plan.items.find((i) => i.kind === 'video-titles')!.changes[0], '1 title using “Headline”');
  assert.ok(plan.notes.some((n) => /“Ink” doesn’t match a theme token/.test(n)));
  assert.ok(plan.notes.some((n) => /No title follows “Caption”/.test(n)));

  // Apply to Shared's site and the alternative's video, but not the alternative's site.
  const checkpoints = (await service.call('projects.view', { projectId })).checkpoints.length;
  const result = await service.call('brand.apply', { projectId, planId: plan.planId, itemIds: [`${SHARED_LINE_ID}:theme`, `${alt.line.id}:seq:promo`] });
  assert.deepEqual(result.failed, []);
  assert.equal((await service.call('projects.view', { projectId })).checkpoints.length, checkpoints + 1);
  const theme = (await h.read(SHARED_LINE_ID, 'theme.css'))!;
  assert.match(theme, /--mv-color-primary: #C2410C/);
  assert.match(theme, /--mv-font-heading: "Brand Sans", serif/);
  assert.match(theme, /@font-face \{\n {2}font-family: "Brand Sans";\n {2}src: url\("fonts\/brand-sans-[0-9a-f]{8}\.otf"\) format\("opentype"\)/);
  const fontPath = /url\("([^"]+)"\)/.exec(theme)![1]!;
  const files = await service.call('files.list', { projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID } });
  assert.ok(files.some((f) => f.path === fontPath), 'the font file was copied into the site');
  assert.doesNotMatch((await h.read(alt.line.id, 'theme.css'))!, /#C2410C/, 'unticked versions are left alone');
  const promo = (await service.call('sequences.get', { projectId, lineId: alt.line.id, sequenceId: 'promo' })).sequence;
  const [branded, plain] = promo.tracks.find((t) => t.kind === 'text')!.clips;
  assert.ok(branded?.type === 'text' && branded.style.color === '#FAFAF9' && branded.style.fontSize === 120 && branded.style.weight === 'semibold' && branded.style.fontAssetId === fontAsset.id);
  assert.ok(plain?.type === 'text' && plain.style.color === '#ffffff');
  await assert.rejects(service.call('brand.apply', { projectId, planId: plan.planId, itemIds: [`${alt.line.id}:theme`] }), /out of date/);

  // The brand font is used for the title in exports.
  const store = await service.video.store(projectId);
  const assets = new Map((await store.list()).map((a) => [a.id, { path: store.fileOf(a), kind: a.kind, probe: a.probe }]));
  const rplan = buildRenderPlan(promo, assets, { preset: 'sequence', resolution: 480, fps: 'sequence', quality: 'small', format: 'mp4', range: null }, 'out.mp4');
  const fontFile = store.fileOf(await store.get(fontAsset.id));
  assert.ok(rplan.fonts.some((f) => f.name.startsWith('lib-') && f.path === fontFile));
  assert.match(rplan.filter, /fontfile=lib-/);

  // Undo the theme change like any other command.
  const step = await service.call('commands.step', { projectId, lineId: SHARED_LINE_ID, scope: 'design:theme', direction: 'undo' });
  assert.equal(step.label, 'Apply brand');
  assert.equal(await h.read(SHARED_LINE_ID, 'theme.css'), themeBefore, 'tokens, font faces and the font file undo together');
  assert.ok(!(await service.call('files.list', { projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID } })).some((f) => f.path === fontPath));
  // Usage shows the brand font and the copy in the site.
  const usage = await service.call('media.usage', { projectId, assetId: fontAsset.id });
  assert.deepEqual(usage.brand, ['Brand font “Heading”']);
  assert.equal(usage.sequences[0]!.sequenceName, 'Promo');
  await service.shutdown();
});

test('shared media: copies placed into versions are tracked and reported outdated when the asset changes', async () => {
  const h = await setup('links');
  const { service, projectId } = h;
  const hero = (await service.call('media.import', { projectId, paths: [path.join(dir, 'hero.png')] }))!.imported[0]!;
  const placed = await service.call('assets.place', { projectId, lineId: SHARED_LINE_ID, assetId: hero.id });
  assert.equal(placed.path, 'images/hero.png');
  await assert.rejects(service.call('assets.place', { projectId, lineId: SHARED_LINE_ID, assetId: (await service.call('media.import', { projectId, paths: [path.join(dir, 'clip.mp4')] }))!.imported[0]!.id, path: 'images/hero.png' }), /already exists/);
  // An alternative created afterwards holds the same copy.
  await service.call('shared.save', { projectId, message: 'Hero image' });
  const alt = await service.call('lines.create', { projectId, from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'B', color: 'teal', description: '', following: true });
  let links = await service.call('assets.links', { projectId });
  assert.deepEqual(links.map((l) => [l.lineName, l.path, l.outdated]).sort(), [['B', 'images/hero.png', false], ['Shared', 'images/hero.png', false]]);

  // The library asset is relinked to different content: both copies are now outdated.
  await fs.rm((await service.video.mediaFile(projectId, hero.id, 'original'))!.path);
  await service.call('media.relink', { projectId, assetId: hero.id, path: path.join(dir, 'hero-blue.png') });
  links = await service.call('assets.links', { projectId });
  assert.ok(links.every((l) => l.outdated));
  const updated = await service.call('assets.updateLinks', { projectId, items: [{ lineId: alt.line.id, path: 'images/hero.png' }] });
  assert.deepEqual(updated.failed, []);
  links = await service.call('assets.links', { projectId });
  assert.deepEqual(links.map((l) => [l.lineName, l.outdated]).sort(), [['B', false], ['Shared', true]]);
  const copy = await service.call('files.read', { projectId, ref: { kind: 'line', lineId: alt.line.id }, path: 'images/hero.png' });
  assert.equal(copy.hash, (await service.call('files.read', { projectId, ref: { kind: 'line', lineId: alt.line.id }, path: 'images/hero.png' })).hash);
  assert.notEqual(copy.hash, (await service.call('files.read', { projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID }, path: 'images/hero.png' })).hash, 'only the chosen version was updated');

  // A copy the user replaced is no longer tracked.
  await service.call('files.write', { projectId, lineId: SHARED_LINE_ID, path: 'images/hero.png', text: 'replaced' });
  assert.deepEqual((await service.call('assets.links', { projectId })).map((l) => l.lineName), ['B']);
  await service.shutdown();
});

test('exports are marked outdated when their sequence or media change', async () => {
  const h = await setup('outdated');
  const { service, projectId } = h;
  const clip = (await service.call('media.import', { projectId, paths: [path.join(dir, 'clip.mp4')] }))!.imported[0]! as MediaAssetView;
  const run = (name: string, args: Record<string, unknown>) => service.call('commands.run', { projectId, lineId: SHARED_LINE_ID, name, args });
  await run('video.createSequence', { sequence: 'ad', name: 'Ad', settings: { width: 320, height: 180, fps: { num: 25, den: 1 }, sampleRate: 48000, background: '#000000' } });
  await run('video.addClip', { sequence: 'ad', assetId: clip.id, media: { kind: 'video', duration: Math.round(clip.probe.durationSeconds! * T) }, clipId: 'c' });
  const job = await service.call('video.export.start', { projectId, lineId: SHARED_LINE_ID, sequenceId: 'ad', settings: { preset: 'sequence', resolution: 480, fps: 'sequence', quality: 'small', format: 'mp4', range: null } });
  const wait = async (): Promise<ExportJobView> => {
    for (let i = 0; i < 600; i++) {
      const j = (await service.call('video.export.list', { projectId })).find((x) => x.id === job!.id)!;
      if (!['queued', 'running'].includes(j.state)) return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('export did not finish');
  };
  const done = await wait();
  assert.equal(done.state, 'completed', done.error ?? '');
  assert.equal(done.outdated, null);
  await run('video.addText', { sequence: 'ad', start: 0, duration: T, text: 'New title' });
  const after = (await service.call('video.export.list', { projectId })).find((x) => x.id === job!.id)!;
  assert.equal(after.outdated?.reason, 'sequence-changed');
  await service.shutdown();
});
