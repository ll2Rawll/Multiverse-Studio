/**
 * Video: media store (import, probe, dedupe, derived files, missing and relink), timeline
 * commands with undo/redo, and real FFmpeg exports checked by reading pixels and streams back.
 * Test footage is generated with FFmpeg's lavfi sources, so no media files are checked in.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, unlink, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { buildRenderPlan } from '../src/video/render';
import { TICKS_PER_SECOND, type ExportJobView, type ExportSettings, type MediaAssetView, type Sequence } from '../src/shared/video';
import type { StudioEvent } from '../src/shared/types';

const ROOT = path.resolve(import.meta.dirname, '..');
const T = TICKS_PER_SECOND;
let dir = '';
let media = '';

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/** Average colour of a region of one frame, as [r, g, b]. */
function pixel(file: string, seconds: number, crop = 'iw:ih:0:0'): number[] {
  const out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', `crop=${crop},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [...out.subarray(0, 3)];
}

function probe(file: string): { format: { duration: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] } {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString('utf8'));
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'mv-video-'));
  media = path.join(dir, 'footage');
  await mkdir(media);
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(media, 'red.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(media, 'blue.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', path.join(media, 'tone.wav')]);
  ff(['-f', 'lavfi', '-i', 'color=c=lime:s=200x200', '-frames:v', '1', path.join(media, 'logo.png')]);
  // HEVC needs a proxy for preview in Chromium.
  ff(['-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=25:d=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', path.join(media, 'white-hevc.mp4')]);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness(name: string) {
  const events: StudioEvent[] = [];
  const service = new StudioService({
    workspaceRoot: path.join(dir, name),
    sampleRoot: path.join(ROOT, 'sample'),
    previewUrl: (t) => t,
    emit: (e) => events.push(e),
    cacheRoot: path.join(dir, `${name}-cache`),
  });
  return { service, events };
}

const SETTINGS: ExportSettings = { preset: 'sequence', resolution: 480, fps: 'sequence', quality: 'small', format: 'mp4', range: null };

async function waitForJob(service: StudioService, projectId: string, jobId: string, ms = 60000): Promise<ExportJobView> {
  const deadline = Date.now() + ms;
  for (;;) {
    const job = (await service.call('video.export.list', { projectId })).find((j) => j.id === jobId)!;
    if (!['queued', 'running'].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`export still ${job.state}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('render plan: handles for crossfades, chained atempo, text through files, no shell quoting', () => {
  const probeV = { durationSeconds: 3, width: 640, height: 360, fps: { num: 25, den: 1 }, rotation: 0, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', sampleRate: 48000, channels: 1, playable: true };
  const seq: Sequence = {
    format: 'multiverse-sequence',
    version: 1,
    id: 's1',
    name: 'Plan',
    settings: { width: 1280, height: 720, fps: { num: 25, den: 1 }, sampleRate: 48000, background: '#000000' },
    tracks: [
      {
        id: 'v1', kind: 'video', name: 'Video 1', muted: false, hidden: false, locked: false, volume: 1,
        clips: [
          { id: 'c1', type: 'media', assetId: 'm-a', start: 0, in: 0, out: 3 * T, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transitionIn: null, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, crop: { left: 0, right: 0, top: 0, bottom: 0 } },
          { id: 'c2', type: 'media', assetId: 'm-a', start: 3 * T, in: 0, out: 2 * T, speed: 4, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transitionIn: { kind: 'crossfade', duration: T }, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, crop: { left: 0, right: 0, top: 0, bottom: 0 } },
        ],
      },
      { id: 't1', kind: 'text', name: 'Titles', muted: false, hidden: false, locked: false, volume: 1, clips: [{ id: 't1c', type: 'text', start: 0, duration: T, text: "It's 100% \"quoted\": a, b", style: { fontSize: 72, color: '#ffffff', weight: 'semibold', align: 'center', x: 0.5, y: 0.8, box: false, boxColor: '#000000' }, fadeIn: 0, fadeOut: 0, transitionIn: null }] },
    ],
  };
  const plan = buildRenderPlan(seq, new Map([['m-a', { path: '/media/a b.mp4', kind: 'video', probe: probeV }]]), SETTINGS, '/out/x.mp4');
  assert.equal(plan.width, 854);
  assert.equal(plan.height, 480);
  // c1 is extended by half a second past the end of its 3 s media: frozen frames fill in.
  assert.match(plan.filter, /tpad=start_mode=clone:start_duration=0:stop_mode=clone:stop_duration=0\.5/);
  // c2 starts half a second early, before its in point 0: padded at the start, at 4x speed.
  assert.match(plan.filter, /setpts=\(PTS-STARTPTS\)\/4/);
  assert.match(plan.filter, /atempo=2,atempo=2/);
  assert.match(plan.filter, /fade=t=in:st=0:d=1:alpha=1/);
  // Text never appears in the graph itself.
  assert.doesNotMatch(plan.filter, /quoted/);
  assert.deepEqual(plan.files, [{ name: 'text-0.txt', content: "It's 100% \"quoted\": a, b" }]);
  assert.ok(plan.args.includes('/media/a b.mp4'), 'paths are separate arguments, unquoted');
  assert.equal(plan.durationSeconds, 3.5);
});

let projectId = '';
let assets: MediaAssetView[] = [];
let svc!: ReturnType<typeof harness>;

test('import probes, dedupes by content, and builds thumbnails, strips, waveforms and proxies', async () => {
  svc = harness('main');
  const project = await svc.service.createFromTemplate('landing', 'Video test');
  projectId = project.id;
  const tools = await svc.service.call('video.tools', {});
  assert.equal(tools.available, true, tools.message ?? '');
  const r = await svc.service.call('media.import', { projectId, paths: ['red.mp4', 'blue.mp4', 'tone.wav', 'logo.png', 'white-hevc.mp4', 'nope.mov'].map((f) => path.join(media, f)) });
  assert.ok(r);
  assert.deepEqual(r.imported.map((a) => [a.name, a.kind]), [['red.mp4', 'video'], ['blue.mp4', 'video'], ['tone.wav', 'audio'], ['logo.png', 'image'], ['white-hevc.mp4', 'video']]);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0]!.reason, /could not be found/);
  const red = r.imported[0]!;
  assert.ok(Math.abs(red.probe.durationSeconds! - 3) < 0.1);
  assert.equal(red.probe.width, 640);
  assert.equal(red.probe.hasAudio, true);
  assert.equal(red.probe.playable, true);
  assert.equal(r.imported[4]!.probe.playable, false, 'HEVC is not played directly');
  assert.match(red.url!, /^mvmedia:\/\//);
  assert.equal(r.imported[2]!.thumbUrl, null, 'audio has no thumbnail');
  // Same content again: the same asset.
  const again = await svc.service.call('media.import', { projectId, paths: [path.join(media, 'red.mp4')] });
  assert.equal(again!.imported[0]!.id, red.id);
  // Derived files appear (generated in the background).
  const deadline = Date.now() + 30000;
  for (;;) {
    assets = await svc.service.call('media.list', { projectId });
    const hevc = assets.find((a) => a.name === 'white-hevc.mp4')!;
    const strip = await svc.service.video.mediaFile(projectId, red.id, 'strip');
    if (hevc.proxy === 'ready' && strip) break;
    if (Date.now() > deadline) throw new Error(`derived files not ready (proxy ${hevc.proxy})`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const listedRed = assets.find((a) => a.id === red.id)!;
  assert.ok(listedRed.thumbUrl && listedRed.stripUrl, 'once made, the pictures have addresses');
  assert.ok(assets.find((a) => a.name === 'logo.png')!.thumbUrl, 'images get a thumbnail too');
  // A picture that is not there (yet) gets no address: requesting it would cache a broken image.
  const store = await svc.service.video.store(projectId);
  const thumbFile = (await svc.service.video.mediaFile(projectId, red.id, 'thumb'))!.path;
  await rm(thumbFile);
  assert.deepEqual(await store.previews(await store.get(red.id)), { thumb: false, strip: true });
  const proxy = await svc.service.video.mediaFile(projectId, assets.find((a) => a.name === 'white-hevc.mp4')!.id, 'play');
  assert.match(proxy!.path, /proxy\.mp4$/);
  assert.equal(probe(proxy!.path).streams.find((s) => s.codec_type === 'video')!.codec_name, 'h264');
  const wave = await svc.service.call('media.waveform', { projectId, assetId: assets.find((a) => a.name === 'tone.wav')!.id });
  assert.ok(wave.peaks.length > 20);
  // FFmpeg's sine source plays at 1/8 of full scale.
  assert.ok(Math.max(...wave.peaks) > 0.1, 'the sine wave has real peaks');
});

const asset = (name: string): MediaAssetView => assets.find((a) => a.name === name)!;
const media$ = (a: MediaAssetView) => ({ kind: a.kind, duration: a.probe.durationSeconds === null ? null : Math.round(a.probe.durationSeconds * T) });
const run = (name: string, args: Record<string, unknown>) => svc.service.call('commands.run', { projectId, lineId: 'shared', name, args });
const seq = async (): Promise<Sequence> => (await svc.service.call('sequences.get', { projectId, lineId: 'shared', sequenceId: 'edit' })).sequence;

test('timeline commands: add, move, trim, split, delete, with overlap checks and undo/redo', async () => {
  await run('video.createSequence', { sequence: 'edit', name: 'First cut', settings: { width: 1280, height: 720, fps: { num: 25, den: 1 }, sampleRate: 48000, background: '#000000' } });
  await run('video.addClip', { sequence: 'edit', assetId: asset('red.mp4').id, media: media$(asset('red.mp4')), clipId: 'red' });
  await run('video.addClip', { sequence: 'edit', assetId: asset('blue.mp4').id, media: media$(asset('blue.mp4')), clipId: 'blue' });
  let s = await seq();
  const v1 = s.tracks.find((t) => t.id === 'v1')!;
  assert.deepEqual(v1.clips.map((c) => [c.id, c.start]), [['red', 0], ['blue', 3 * T]], 'clips are appended in order');
  await assert.rejects(run('video.moveClip', { sequence: 'edit', clipId: 'blue', start: 2 * T }), /overlap/);
  // Split red at 1 s, delete the first part with ripple, then undo both.
  await run('video.splitClip', { sequence: 'edit', clipId: 'red', at: T, newClipId: 'red-b' });
  s = await seq();
  assert.deepEqual(s.tracks[0]!.clips.map((c) => (c.type === 'media' ? [c.id, c.start, c.in, c.out] : [])), [['red', 0, 0, T], ['red-b', T, T, 3 * T], ['blue', 3 * T, 0, 2 * T]]);
  await run('video.deleteClips', { sequence: 'edit', clipIds: ['red'], ripple: true });
  s = await seq();
  assert.deepEqual(s.tracks[0]!.clips.map((c) => [c.id, c.start]), [['red-b', 0], ['blue', 2 * T]]);
  const scope = 'video:edit';
  await svc.service.call('commands.step', { projectId, lineId: 'shared', scope, direction: 'undo' });
  await svc.service.call('commands.step', { projectId, lineId: 'shared', scope, direction: 'undo' });
  s = await seq();
  assert.deepEqual(s.tracks[0]!.clips.map((c) => [c.id, c.start]), [['red', 0], ['blue', 3 * T]]);
  await svc.service.call('commands.step', { projectId, lineId: 'shared', scope, direction: 'redo' });
  assert.deepEqual((await seq()).tracks[0]!.clips.map((c) => c.id), ['red', 'red-b', 'blue']);
  await svc.service.call('commands.step', { projectId, lineId: 'shared', scope, direction: 'undo' });
  // Trim blue's end to 1.5 s of media; clips cannot extend past their media.
  await run('video.trimClip', { sequence: 'edit', clipId: 'blue', edge: 'end', at: 4.5 * T, sourceDuration: 2 * T });
  await assert.rejects(run('video.trimClip', { sequence: 'edit', clipId: 'blue', edge: 'end', at: 6 * T, sourceDuration: 2 * T }), /end of its media/);
  s = await seq();
  const blue = s.tracks[0]!.clips.find((c) => c.id === 'blue')!;
  assert.equal(blue.type === 'media' && blue.out, 1.5 * T);
  // Pictures cannot go on audio tracks; locked tracks refuse edits.
  await assert.rejects(run('video.addClip', { sequence: 'edit', assetId: asset('logo.png').id, media: media$(asset('logo.png')), trackId: 'a1' }), /video track/);
  await run('video.setTrack', { sequence: 'edit', trackId: 'v1', patch: { locked: true } });
  await assert.rejects(run('video.moveClip', { sequence: 'edit', clipId: 'blue', start: 5 * T }), /locked/);
  await run('video.setTrack', { sequence: 'edit', trackId: 'v1', patch: { locked: false } });
  // The sequence is a plain file in the version.
  const files = (await svc.service.call('files.list', { projectId, ref: { kind: 'line', lineId: 'shared' } })).map((f) => f.path);
  assert.ok(files.includes('sequences/edit.mvseq.json'));
});

test('export: real H.264 file, verified by reading streams and pixels back', async () => {
  // Timeline: red 0–3 s, blue 3–4.5 s; a still logo over the red, a title at 0.5–1.5 s, a tone on the audio track.
  await run('video.addTrack', { sequence: 'edit', kind: 'video', trackId: 'v2' });
  await run('video.addClip', { sequence: 'edit', assetId: asset('logo.png').id, media: media$(asset('logo.png')), trackId: 'v2', start: 0, out: T, clipId: 'logo' });
  await run('video.setClip', { sequence: 'edit', clipId: 'logo', patch: { transform: { scale: 0.25, x: 400, y: -200 } } });
  await run('video.addText', { sequence: 'edit', start: T / 2, duration: T, text: 'Hello timeline', clipId: 'title' });
  await run('video.addClip', { sequence: 'edit', assetId: asset('tone.wav').id, media: media$(asset('tone.wav')), start: 0, clipId: 'tone' });
  await run('video.setClip', { sequence: 'edit', clipId: 'blue', patch: { transitionIn: { kind: 'crossfade', duration: T / 2 } } });
  const job = await svc.service.call('video.export.start', { projectId, lineId: 'shared', sequenceId: 'edit', settings: SETTINGS });
  assert.ok(job);
  const done = await waitForJob(svc.service, projectId, job.id);
  assert.equal(done.state, 'completed', done.error ?? '');
  assert.ok(done.verified);
  assert.equal(done.verified.width, 854);
  assert.equal(done.verified.height, 480);
  assert.equal(done.verified.audioCodec, 'aac');
  assert.ok(Math.abs(done.verified.durationSeconds - 4.5) < 0.15, `duration ${done.verified.durationSeconds}`);
  // Progress was reported along the way.
  assert.ok(svc.events.some((e) => e.type === 'video-job' && e.job.id === job.id && e.job.state === 'running'));
  // Pixels: red at 2 s (centre), blue at 4 s, the green logo top-right at 0.5 s, the white title over red at 1 s.
  const [r1, g1, b1] = pixel(done.output, 2, '100:100:377:190');
  assert.ok(r1! > 200 && g1! < 40 && b1! < 40, `red at 2 s: ${[r1, g1, b1]}`);
  const [r2, , b2] = pixel(done.output, 4, '100:100:377:190');
  assert.ok(b2! > 200 && r2! < 40, `blue at 4 s: ${[r2, b2]}`);
  // Logo: 200 px square fitted to 480 px high (×2.4), scaled 0.25 → 120 px at 854/1280 scale; centre offset (400,-200) → (267,-133).
  const [r3, g3] = pixel(done.output, 0.5, `20:20:${427 + 267 - 10}:${240 - 133 - 10}`);
  assert.ok(g3! > 200 && r3! < 60, `green logo at 0.5 s: ${[r3, g3]}`);
  const [, g4] = pixel(done.output, 2.5, `20:20:${427 + 267 - 10}:${240 - 133 - 10}`);
  assert.ok(g4! < 40, 'the logo is gone after its clip ends');
  const titleRegion = pixel(done.output, 1, '300:50:277:360');
  const plain = pixel(done.output, 2, '300:50:277:360');
  assert.ok(titleRegion[1]! > plain[1]! + 15, `title text adds light pixels: ${titleRegion} vs ${plain}`);
  // Crossfade: at the cut (3 s) red and blue are mixed.
  const [r5, , b5] = pixel(done.output, 3, '100:100:377:190');
  assert.ok(r5! > 60 && b5! > 60, `crossfade mixes red and blue at 3 s: ${[r5, b5]}`);
  // Audio is really there and audible.
  const detect = spawnSync('ffmpeg', ['-hide_banner', '-i', done.output, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const max = Number(/max_volume: (-?[\d.]+) dB/.exec(detect.stderr)?.[1]);
  assert.ok(max > -30, `audio peak ${max} dB`);
});

test('export: VP9/WebM of a range, cancel, and interrupted jobs are not restarted', async () => {
  const webm = await svc.service.call('video.export.start', { projectId, lineId: 'shared', sequenceId: 'edit', settings: { ...SETTINGS, format: 'webm', preset: 'square', range: { start: 3 * T, end: 4 * T } } });
  const done = await waitForJob(svc.service, projectId, webm!.id);
  assert.equal(done.state, 'completed', done.error ?? '');
  assert.equal(done.verified!.videoCodec, 'vp9');
  assert.equal(done.verified!.audioCodec, 'opus');
  assert.equal(done.verified!.width, 480);
  assert.equal(done.verified!.height, 480);
  assert.ok(Math.abs(done.verified!.durationSeconds - 1) < 0.15);
  const [r, , b] = pixel(done.output, 0.5, '50:50:215:215');
  assert.ok(b! > 200 && r! < 40, 'the range starts at 3 s (blue)');

  const slow = await svc.service.call('video.export.start', { projectId, lineId: 'shared', sequenceId: 'edit', settings: { ...SETTINGS, quality: 'high', resolution: 1080 } });
  await new Promise((r) => setTimeout(r, 150));
  await svc.service.call('video.export.cancel', { projectId, jobId: slow!.id });
  const cancelled = await waitForJob(svc.service, projectId, slow!.id);
  assert.equal(cancelled.state, 'cancelled');

  // A job left "running" by a crash comes back as interrupted, not resubmitted.
  const jobsFile = path.join(dir, 'main', 'Projects', projectId, 'exports', 'jobs.json');
  const list = JSON.parse(await readFile(jobsFile, 'utf8'));
  list.push({ ...list[0], id: 'x-crashed', state: 'running', progress: 0.4 });
  await writeFile(jobsFile, JSON.stringify(list));
  const fresh = harness('main');
  const after = await fresh.service.call('video.export.list', { projectId });
  const crashed = after.find((j) => j.id === 'x-crashed')!;
  assert.equal(crashed.state, 'interrupted');
  assert.match(crashed.error!, /Start it again/);
  await fresh.service.shutdown();
});

test('missing media is reported, blocks export with a clear message, and relinks', async () => {
  const red = asset('red.mp4');
  const stored = (await svc.service.video.mediaFile(projectId, red.id, 'original'))!.path;
  await unlink(stored);
  const listed = await svc.service.call('media.list', { projectId, lineId: 'shared' });
  const missing = listed.find((a) => a.id === red.id)!;
  assert.equal(missing.status, 'missing');
  assert.equal(missing.url, null);
  assert.deepEqual(missing.usedIn, ['First cut']);
  await assert.rejects(svc.service.call('video.export.start', { projectId, lineId: 'shared', sequenceId: 'edit', settings: SETTINGS }), /missing from the library/);
  // A file that is too short is refused; the original content restores it.
  await assert.rejects(svc.service.call('media.relink', { projectId, assetId: red.id, path: path.join(media, 'blue.mp4') }), /shorter/);
  const relinked = await svc.service.call('media.relink', { projectId, assetId: red.id, path: path.join(media, 'red.mp4') });
  assert.equal(relinked!.sameContent, true);
  assert.equal((await svc.service.call('media.list', { projectId })).find((a) => a.id === red.id)!.status, 'ready');
  await svc.service.shutdown();
});
