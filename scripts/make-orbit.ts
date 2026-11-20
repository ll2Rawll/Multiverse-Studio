/**
 * Regenerates the Orbit template's living objects, their page placement and the launch sequence
 * through the studio's own commands, so the template's files are exactly what the app produces.
 *   node --import tsx scripts/make-orbit.ts
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { SHARED_LINE_ID } from '../src/shared/types';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'templates', 'orbit');
const S = 240_000;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-orbit-'));
const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: path.join(ROOT, 'sample'), previewUrl: (t) => t, emit: () => {}, cacheRoot: path.join(dir, 'cache') });
try {
  // Start from the hand-written files only.
  for (const p of ['objects', 'sequences']) await fs.rm(path.join(OUT, p), { recursive: true, force: true });
  await fs.rm(path.join(OUT, 'objects.css'), { force: true });
  const page = path.join(OUT, 'index.html');
  await fs.writeFile(page, (await fs.readFile(page, 'utf8')).replace(/\n\s*<section[^>]*data-mv-object="[^"]+"[\s\S]*?<\/section>\n/g, '\n').replace(/\s*<link rel="stylesheet" href="objects\.css">/g, ''));
  const project = await service.createFromTemplate('orbit', 'Orbit');
  const run = (name: string, args: Record<string, unknown>) => service.call('commands.run', { projectId: project.id, lineId: SHARED_LINE_ID, name, args });
  await run('objects.create', {
    object: 'pro-plan',
    type: 'pricing-card',
    name: 'Pro plan',
    properties: { plan: 'Orbit Pro', price: '$8', period: 'per month', features: ['Unlimited tasks', 'Open and done filters', 'Works in any modern browser'], cta: 'Try the demo app', href: 'app.html' },
  });
  await run('objects.create', { object: 'orbit-headline', type: 'title-card', name: 'Orbit headline', properties: { title: 'Orbit', subtitle: 'Plan the week. Ship the work.' } });
  await run('objects.place', { object: 'pro-plan', page: 'index.html', index: 3 });
  await run('video.createSequence', { sequence: 'launch', name: 'Orbit launch', settings: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, sampleRate: 48000, background: '#0f2433' } });
  await run('objects.addScene', { object: 'orbit-headline', sequence: 'launch', start: 0, duration: 3 * S, template: 'title-card' });
  await run('objects.addScene', { object: 'pro-plan', sequence: 'launch', start: 22 * S, duration: 4 * S });
  await run('video.addText', { sequence: 'launch', start: 26 * S, duration: 4 * S, text: 'Try the Orbit demo', subtitle: 'A fictional product, made with Multiverse Studio', template: 'title-card' });
  const files = await service.call('files.list', { projectId: project.id, ref: { kind: 'line', lineId: SHARED_LINE_ID } });
  for (const f of files) {
    if (!/^(index\.html|objects\.css|objects\/|sequences\/)/.test(f.path)) continue;
    const r = await service.call('files.read', { projectId: project.id, ref: { kind: 'line', lineId: SHARED_LINE_ID }, path: f.path });
    await fs.mkdir(path.dirname(path.join(OUT, f.path)), { recursive: true });
    await fs.writeFile(path.join(OUT, f.path), r.text ?? '');
    console.log(`wrote ${f.path}`);
  }
} finally {
  await service.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
}
