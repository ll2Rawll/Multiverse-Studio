/**
 * Performance measurements on this machine: `npm run bench` (writes docs/BENCHMARKS.md).
 * Uses the real engine and services with generated content; no network and no providers.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import JSZip from 'jszip';
import { StudioService } from '../src/services/studio';
import { selectFiles } from '../src/publish/service';
import { heavyWork } from '../src/video/ffmpeg';
import { SHARED_LINE_ID } from '../src/shared/types';

const ROOT = path.resolve(import.meta.dirname, '..');
const rows: [string, string, string][] = [];
const time = async <T,>(label: string, detail: string, fn: () => Promise<T>): Promise<T> => {
  const t = performance.now();
  const r = await fn();
  const ms = performance.now() - t;
  rows.push([label, detail, ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`]);
  console.log(`${label.padEnd(44)} ${String(Math.round(ms)).padStart(6)} ms  ${detail}`);
  return r;
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-bench-'));
try {
  const site = path.join(dir, 'site');
  const FILES = 1000;
  await fs.mkdir(path.join(site, 'pages'), { recursive: true });
  await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><title>Bench</title><h1>Bench</h1>\n'.repeat(20));
  for (let i = 0; i < FILES - 1; i++) await fs.writeFile(path.join(site, 'pages', `p${i}.html`), `<!doctype html><title>Page ${i}</title>\n${'<p>Lorem ipsum dolor sit amet.</p>\n'.repeat(40)}`);

  const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: path.join(ROOT, 'sample'), templateRoot: path.join(ROOT, 'templates'), previewUrl: (t) => t, emit: () => {}, cacheRoot: path.join(dir, 'cache'), agent: { cacheRoot: path.join(dir, 'cache') } });
  const imported = await time('Import a folder', `${FILES} HTML files, about 1.4 MB`, () => service.call('projects.import', { folderPath: site }));
  const projectId = imported!.project.id;
  const ALTS = 8;
  await time('Create alternatives (following)', `${ALTS} alternatives`, async () => {
    for (let i = 0; i < ALTS; i++) await service.call('lines.create', { projectId, from: { kind: 'line', lineId: SHARED_LINE_ID }, name: `Alt ${i}`, color: 'sky', description: '', following: true });
  });
  const project = await service.call('projects.open', { projectId });
  // Give every alternative its own edit to a different line, so propagation is a real three-way merge.
  for (const [i, alt] of project.alternatives.entries()) {
    const f = await service.call('files.read', { projectId, ref: { kind: 'line', lineId: alt.id }, path: 'index.html' });
    await service.call('files.write', { projectId, lineId: alt.id, path: 'index.html', text: `${f.text ?? ''}<!-- alt ${i} -->\n` });
  }
  const shared = await service.call('files.read', { projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID }, path: 'index.html' });
  await service.call('files.write', { projectId, lineId: SHARED_LINE_ID, path: 'index.html', text: (shared.text ?? '').replace('<h1>Bench</h1>', '<h1>Bench, edited</h1>') });
  const saved = await time('Save a Shared change (propagation)', `merged into ${ALTS} alternatives with their own edits`, () => service.call('shared.save', { projectId, message: 'bench' }));
  const applied = saved.report?.lines.filter((l) => l.outcome === 'applied').length ?? 0;
  if (applied !== ALTS) throw new Error(`expected ${ALTS} clean merges, got ${applied}`);
  const alt = project.alternatives[0]!.id;
  await time('Compare two versions', `${FILES} files`, () => service.call('compare.run', { projectId, left: { kind: 'line', lineId: SHARED_LINE_ID }, right: { kind: 'line', lineId: alt } }));
  const engine = await service.engine(projectId);
  const tree = await engine.effectiveTree(alt);
  await time('Publish packaging (select + ZIP)', `${FILES} files`, async () => {
    const { files } = selectFiles(tree, '');
    const zip = new JSZip();
    for (const [p, h] of files) zip.file(p, await engine.readBlob(h));
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  });
  await time('Measure storage', 'cache categories + projects', () => service.call('storage.usage', {}));
  await time('Tidy history (garbage collection)', `${ALTS + 1} versions`, () => engine.collectGarbage());

  let ffmpeg: string | null = null;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    ffmpeg = 'ffmpeg';
  } catch {
    rows.push(['Media previews', 'skipped: FFmpeg is not installed', '—']);
  }
  if (ffmpeg) {
    const CLIPS = 8;
    const clips: string[] = [];
    for (let i = 0; i < CLIPS; i++) {
      const out = path.join(dir, `clip${i}.mp4`);
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=4`, '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 40}:duration=4`, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', out]);
      clips.push(out);
    }
    let peak = 0;
    const timer = setInterval(() => (peak = Math.max(peak, heavyWork.running)), 5);
    await time('Import clips and make previews', `${CLIPS} × 4 s 720p clips; at most ${heavyWork.max} FFmpeg job${heavyWork.max === 1 ? '' : 's'} at once`, async () => {
      await service.call('media.import', { projectId, paths: clips });
      for (;;) {
        const usage = await service.call('storage.usage', {});
        const media = usage.categories.find((c) => c.id === 'media')!;
        if (heavyWork.running === 0 && heavyWork.queued === 0 && media.files >= CLIPS * 3) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    clearInterval(timer);
    rows.push(['Peak concurrent FFmpeg preview jobs', `limit ${heavyWork.max} on ${os.cpus().length} CPUs`, String(peak)]);
  }
  await service.shutdown();

  const md = `# Benchmarks

Measured with \`npm run bench\` (scripts/bench.ts) on ${new Date().toISOString().slice(0, 10)}: ${os.cpus()[0]?.model.trim() ?? 'unknown CPU'} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.platform()} ${os.release()}, Node ${process.versions.node}.
Real engine and services, generated content, no network. Times are single runs; expect variation of ±30%.

| Operation | Size | Time |
| --- | --- | --- |
${rows.map((r) => `| ${r.join(' | ')} |`).join('\n')}
`;
  await fs.writeFile(path.join(ROOT, 'docs', 'BENCHMARKS.md'), md);
  console.log('\nWrote docs/BENCHMARKS.md');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
