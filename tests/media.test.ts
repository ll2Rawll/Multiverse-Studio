/**
 * AI media jobs with MOCKED provider endpoints (no real provider is called in this file, and no
 * real key is used): image generation, transcription with timed segments, background video jobs
 * that are followed again after a restart, uncertain paid requests that are never resent
 * automatically, cancellation semantics, provenance, and keys never written into the project.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { AiService } from '../src/ai/service';
import { MemoryVault } from '../src/ai/vault';
import type { StudioEvent } from '../src/shared/types';
import type { MediaJobView } from '../src/shared/media';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
// Obviously fake keys; never production keys in fixtures.
const OPENAI_KEY = 'sk-test-0000000000000000000000000000000000000000';
const GEMINI_KEY = 'AIzaTEST000000000000000000000000000000000';
let dir = '';
let png: Buffer;
let mp4: Buffer;
let speech = '';
let wav: Buffer;

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-media-'));
  ff(['-f', 'lavfi', '-i', 'color=c=orange:s=64x64', '-frames:v', '1', path.join(dir, 'gen.png')]);
  ff(['-f', 'lavfi', '-i', 'color=c=teal:s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'gen.mp4')]);
  speech = path.join(dir, 'talk.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=25:d=4', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', speech]);
  png = await fs.readFile(path.join(dir, 'gen.png'));
  ff(['-f', 'lavfi', '-i', 'sine=frequency=500:duration=1', path.join(dir, 'voice.wav')]);
  wav = await fs.readFile(path.join(dir, 'voice.wav'));
  mp4 = await fs.readFile(path.join(dir, 'gen.mp4'));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  form: Record<string, string> | null;
}

/** A mocked provider: OpenAI Images + transcriptions and Gemini Interactions. */
function provider() {
  const calls: Call[] = [];
  const mode = { imageHang: false, interaction: 'in_progress' as 'in_progress' | 'completed' | 'cancelled' };
  const fetchMock = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = null;
    let form: Record<string, string> | null = null;
    if (init.body instanceof FormData) {
      form = {};
      for (const [k, v] of init.body.entries()) form[k] = typeof v === 'string' ? v : `<file ${(v as File).name} ${(v as File).size} bytes>`;
    } else if (typeof init.body === 'string' && init.body) body = JSON.parse(init.body);
    const method = init.method ?? 'GET';
    calls.push({ method, url: u, headers, body, form });
    if (u.endsWith('/images/generations')) {
      if (mode.imageHang) return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      return Response.json({ data: [{ b64_json: png.toString('base64') }], output_format: 'png', usage: { input_tokens: 12, output_tokens: 300 } }, { headers: { 'x-request-id': 'req_img_1' } });
    }
    if (u.endsWith('/audio/transcriptions')) {
      return Response.json({ text: 'Hello there. Welcome to the launch.', language: 'english', duration: 4, segments: [{ start: 0.2, end: 1.6, text: ' Hello there.' }, { start: 2.0, end: 3.7, text: ' Welcome to the launch.' }], usage: { type: 'duration', seconds: 4 } }, { headers: { 'x-request-id': 'req_tr_1' } });
    }
    if (u.endsWith('/interactions') && method === 'POST' && (body as { response_format?: { type?: string } }).response_format?.type === 'audio') {
      return Response.json({ id: 'int-speech', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', data: wav.toString('base64'), mime_type: 'audio/wav' }] }] });
    }
    if (u.endsWith('/interactions') && method === 'POST') return Response.json({ id: 'int-1', status: 'in_progress' });
    if (u.endsWith('/interactions/int-1/cancel')) {
      mode.interaction = 'cancelled';
      return Response.json({ id: 'int-1', status: 'cancelled' });
    }
    if (u.endsWith('/interactions/int-1')) {
      if (mode.interaction === 'completed') return Response.json({ id: 'int-1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'https://generativelanguage.googleapis.com/v1beta/files/vid-1:download?alt=media', mime_type: 'video/mp4' }] }] });
      return Response.json({ id: 'int-1', status: mode.interaction });
    }
    if (u.endsWith('/files/vid-1')) return Response.json({ name: 'files/vid-1', state: 'ACTIVE' });
    if (u.includes('/files/vid-1:download')) return new Response(new Uint8Array(mp4), { headers: { 'content-type': 'video/mp4' } });
    return new Response('{"error":{"message":"not mocked"}}', { status: 404 });
  }) as typeof fetch;
  return { calls, mode, fetchMock };
}

async function setup(name: string, p = provider(), workspace?: string) {
  const ws = workspace ?? path.join(dir, name);
  const ai = new AiService(path.join(ws, 'ai-settings.json'), sharedVault, p.fetchMock);
  const events: StudioEvent[] = [];
  const service = new StudioService({ workspaceRoot: ws, sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:1/`, emit: (e) => events.push(e), ai, cacheRoot: path.join(ws, '.cache') });
  return { service, ai, events, provider: p, workspace: ws };
}
const sharedVault = new MemoryVault();

async function connect(service: StudioService): Promise<void> {
  const openai = await service.call('ai.connections.save', { name: 'OpenAI', provider: 'openai', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' });
  await service.call('ai.keys.set', { connectionId: openai.savedId, key: OPENAI_KEY, persistence: 'session' });
  for (const m of ['test-image-model', 'whisper-test']) await service.call('ai.models.add', { connectionId: openai.savedId, modelId: m });
  await service.call('ai.routing.set', { job: 'image-generation', assignment: { connectionId: openai.savedId, modelId: 'test-image-model' } });
  await service.call('ai.routing.set', { job: 'transcription', assignment: { connectionId: openai.savedId, modelId: 'whisper-test' } });
  const gemini = await service.call('ai.connections.save', { name: 'Gemini', provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
  await service.call('ai.keys.set', { connectionId: gemini.savedId, key: GEMINI_KEY, persistence: 'session' });
  await service.call('ai.models.add', { connectionId: gemini.savedId, modelId: 'test-video-model' });
  await service.call('ai.routing.set', { job: 'video-generation', assignment: { connectionId: gemini.savedId, modelId: 'test-video-model' } });
  await service.call('ai.models.add', { connectionId: gemini.savedId, modelId: 'test-tts-model' });
  await service.call('ai.routing.set', { job: 'speech-generation', assignment: { connectionId: gemini.savedId, modelId: 'test-tts-model' } });
}

async function project(service: StudioService): Promise<string> {
  const site = path.join(dir, `site-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><title>x</title><h1>x</h1>');
  return (await service.call('projects.import', { folderPath: site }))!.project.id;
}

async function settle(service: StudioService, projectId: string, jobId: string, until: (j: MediaJobView) => boolean = (j) => !['queued', 'submitting', 'running', 'downloading', 'cancelling'].includes(j.state), ms = 20000): Promise<MediaJobView> {
  const deadline = Date.now() + ms;
  for (;;) {
    const job = (await service.call('media.jobs.list', { projectId })).find((j) => j.id === jobId)!;
    if (until(job)) return job;
    if (Date.now() > deadline) throw new Error(`job still ${job.state}: ${job.detail}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function grepDir(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if ((await fs.readFile(p)).includes(needle)) hits.push(p);
    }
  };
  await walk(root);
  return hits;
}

test('missing configuration is explained before anything is sent', async () => {
  const h = await setup('unconfigured');
  const projectId = await project(h.service);
  await assert.rejects(h.service.call('media.jobs.plan', { projectId, job: { kind: 'image', request: { prompt: 'a kiln', size: '1024x1024', quality: 'auto', count: 1 } } }), /No model is assigned to “Image generation”/);
  await assert.rejects(h.service.call('media.jobs.start', { projectId, job: { kind: 'video', request: { prompt: 'a kiln', aspectRatio: '16:9', resolution: '720p', imageAssetId: null } } }), /No model is assigned to “Video generation”/);
  assert.equal(h.provider.calls.length, 0);
  await h.service.shutdown();
});

test('image generation: plan shows what is sent and an unknown cost; result enters Assets with provenance', async () => {
  const h = await setup('image');
  await connect(h.service);
  const projectId = await project(h.service);
  const plan = await h.service.call('media.jobs.plan', { projectId, job: { kind: 'image', request: { prompt: 'A warm kiln at dusk', size: '1024x1024', quality: 'low', count: 1 } } });
  assert.equal(plan.estimatedUsd, null);
  assert.ok(plan.notes.some((n) => /unknown/i.test(n)), 'cost is shown as unknown');
  assert.deepEqual(plan.sends.map((s) => s.name), ['Your prompt']);
  assert.equal(h.provider.calls.length, 0, 'planning sends nothing');

  const job = await h.service.call('media.jobs.start', { projectId, job: { kind: 'image', request: { prompt: 'A warm kiln at dusk', size: '1024x1024', quality: 'low', count: 1 } } });
  const done = await settle(h.service, projectId, job.id);
  assert.equal(done.state, 'completed', done.error ?? '');
  assert.equal(done.remoteId, 'req_img_1');
  assert.equal(done.usage.inputTokens, 12);
  const call = h.provider.calls.find((c) => c.url.endsWith('/images/generations'))!;
  assert.equal(call.headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.deepEqual(call.body, { model: 'test-image-model', prompt: 'A warm kiln at dusk', n: 1, output_format: 'png', size: '1024x1024', quality: 'low' });

  const media = await h.service.call('media.list', { projectId });
  const asset = media.find((m) => m.id === done.assetIds[0])!;
  assert.equal(asset.kind, 'image');
  assert.equal(asset.provenance?.source, 'generated');
  assert.equal(asset.provenance?.model, 'test-image-model');
  assert.equal(asset.provenance?.prompt, 'A warm kiln at dusk');
  assert.equal(asset.provenance?.requestId, 'req_img_1');
  assert.ok(asset.tags.includes('generated'));
  // The stored bytes are exactly what the provider returned (never sample media).
  const store = await h.service.video.store(projectId);
  const file = (await store.filePath(asset.id, 'original'))!.path;
  assert.ok((await fs.readFile(file)).equals(png));

  // Keys never land in the project, its job records or the media library.
  const engine = await h.service.engine(projectId);
  assert.deepEqual(await grepDir(engine.dir, OPENAI_KEY), []);
  assert.deepEqual(await grepDir(h.workspace, OPENAI_KEY), []);
  await h.service.shutdown();
});

test('transcription: only the audio is sent, segments are saved, captions come from them', async () => {
  const h = await setup('transcribe');
  await connect(h.service);
  const projectId = await project(h.service);
  const imported = await h.service.call('media.import', { projectId, paths: [speech] });
  const asset = imported!.imported[0]!;
  const plan = await h.service.call('media.jobs.plan', { projectId, job: { kind: 'transcription', request: { assetId: asset.id, language: 'en' } } });
  assert.match(plan.sends[0]!.note, /picture is not sent/);
  const job = await h.service.call('media.jobs.start', { projectId, job: { kind: 'transcription', request: { assetId: asset.id, language: 'en' } } });
  const done = await settle(h.service, projectId, job.id);
  assert.equal(done.state, 'completed', done.error ?? '');
  const call = h.provider.calls.find((c) => c.url.endsWith('/audio/transcriptions'))!;
  assert.equal(call.form?.model, 'whisper-test');
  assert.equal(call.form?.response_format, 'verbose_json');
  assert.equal(call.form?.['timestamp_granularities[]'], 'segment');
  assert.equal(call.form?.language, 'en');
  assert.match(call.form?.file ?? '', /\.mp3 \d+ bytes>/);
  assert.ok(done.sent[0]!.bytes < (await fs.stat(speech)).size, 'a small audio extract is sent, not the video');
  const transcript = await h.service.call('media.transcript', { projectId, assetId: asset.id });
  assert.deepEqual(transcript?.segments.map((s) => s.text), ['Hello there.', 'Welcome to the launch.']);
  assert.ok((await h.service.call('media.list', { projectId })).find((m) => m.id === asset.id)!.hasTranscript);
  await h.service.shutdown();
});

test('video jobs keep their provider id and are followed again after a restart, never resubmitted', async () => {
  const p = provider();
  const first = await setup('video', p);
  await connect(first.service);
  const projectId = await project(first.service);
  const job = await first.service.call('media.jobs.start', { projectId, job: { kind: 'video', request: { prompt: 'Clay spinning on a wheel', aspectRatio: '16:9', resolution: '720p', imageAssetId: null } } });
  const running = await settle(first.service, projectId, job.id, (j) => j.state === 'running' && j.remoteId === 'int-1');
  assert.equal(running.remoteCancel, true);
  const submitted = p.calls.filter((c) => c.url.endsWith('/interactions') && c.method === 'POST');
  assert.equal(submitted.length, 1);
  assert.equal((submitted[0]!.body as { background: boolean }).background, true);
  // The app closes while the provider is still working.
  await first.service.shutdown();
  const saved = JSON.parse(await fs.readFile(path.join((await first.service.engine(projectId)).dir, 'ai', 'media-jobs.json'), 'utf8')) as MediaJobView[];
  assert.equal(saved[0]!.state, 'running');
  assert.equal(saved[0]!.remoteId, 'int-1');

  // Restart: the job is checked with the provider (GET), not sent again (POST).
  p.mode.interaction = 'completed';
  const second = await setup('video', p, first.workspace);
  await second.service.call('projects.open', { projectId });
  const done = await settle(second.service, projectId, job.id);
  assert.equal(done.state, 'completed', done.error ?? '');
  assert.equal(p.calls.filter((c) => c.url.endsWith('/interactions') && c.method === 'POST').length, 1, 'never resubmitted');
  assert.ok(p.calls.some((c) => c.url.endsWith('/interactions/int-1') && c.method === 'GET'));
  // The hosted file was downloaded with the key only because it is on the provider's own host.
  const dl = p.calls.find((c) => c.url.includes('vid-1:download'))!;
  assert.equal(dl.headers['x-goog-api-key'], GEMINI_KEY);
  const asset = (await second.service.call('media.list', { projectId })).find((m) => m.id === done.assetIds[0])!;
  assert.equal(asset.kind, 'video');
  assert.equal(asset.provenance?.requestId, 'int-1');
  await second.service.shutdown();
});

test('cancelling: remote video jobs are cancelled at the provider; synchronous requests only stop waiting', async () => {
  const p = provider();
  const h = await setup('cancel', p);
  await connect(h.service);
  const projectId = await project(h.service);
  const video = await h.service.call('media.jobs.start', { projectId, job: { kind: 'video', request: { prompt: 'Glaze dripping', aspectRatio: '9:16', resolution: '720p', imageAssetId: null } } });
  await settle(h.service, projectId, video.id, (j) => j.state === 'running' && j.remoteId === 'int-1');
  await h.service.call('media.jobs.cancel', { projectId, jobId: video.id });
  const cancelled = await settle(h.service, projectId, video.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.match(cancelled.detail, /provider stopped/i);
  assert.ok(p.calls.some((c) => c.url.endsWith('/interactions/int-1/cancel') && c.method === 'POST'));

  p.mode.imageHang = true;
  const image = await h.service.call('media.jobs.start', { projectId, job: { kind: 'image', request: { prompt: 'Kiln', size: 'auto', quality: 'auto', count: 1 } } });
  await settle(h.service, projectId, image.id, (j) => j.state === 'running');
  assert.equal(image.remoteCancel, false);
  await h.service.call('media.jobs.cancel', { projectId, jobId: image.id });
  const stopped = await settle(h.service, projectId, image.id);
  assert.equal(stopped.state, 'cancelled');
  assert.match(stopped.error ?? '', /may still finish the request and charge/);
  await h.service.shutdown();
});

test('an in-flight paid request becomes uncertain after a restart and is only resent after confirmation', async () => {
  const p = provider();
  p.mode.imageHang = true;
  const first = await setup('uncertain', p);
  await connect(first.service);
  const projectId = await project(first.service);
  const job = await first.service.call('media.jobs.start', { projectId, job: { kind: 'image', request: { prompt: 'Raku bowl', size: '1024x1024', quality: 'auto', count: 2 } } });
  await settle(first.service, projectId, job.id, (j) => j.state === 'running');
  await first.service.shutdown();

  p.mode.imageHang = false;
  const second = await setup('uncertain', p, first.workspace);
  await second.service.call('projects.open', { projectId });
  const after = (await second.service.call('media.jobs.list', { projectId })).find((j) => j.id === job.id)!;
  assert.equal(after.state, 'uncertain');
  assert.match(after.error ?? '', /usage page/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(p.calls.filter((c) => c.url.endsWith('/images/generations')).length, 1, 'not sent again automatically');
  await assert.rejects(second.service.call('media.jobs.retry', { projectId, jobId: job.id, confirmUncertain: false }), /Confirm that you checked/);
  const retry = await second.service.call('media.jobs.retry', { projectId, jobId: job.id, confirmUncertain: true });
  assert.equal(retry.retryOf, job.id);
  const done = await settle(second.service, projectId, retry.id);
  assert.equal(done.state, 'completed');
  assert.equal(p.calls.filter((c) => c.url.endsWith('/images/generations')).length, 2);
  assert.equal((await second.service.call('media.jobs.list', { projectId })).find((j) => j.id === job.id)!.retriedAs, retry.id);
  await second.service.shutdown();
});

test('a job that never left the computer is interrupted, and retrying it is safe', async () => {
  const p = provider();
  const first = await setup('queued', p);
  await connect(first.service);
  const projectId = await project(first.service);
  const engine = await first.service.engine(projectId);
  // Simulate a crash with a queued job on disk.
  await fs.mkdir(path.join(engine.dir, 'ai'), { recursive: true });
  const queued = { id: 'g-queued01', projectId, kind: 'image', state: 'queued', detail: 'Waiting to start', title: 'Image: x', prompt: 'x', settings: {}, connectionId: null, connectionName: 'OpenAI', provider: 'openai', model: 'test-image-model', remoteId: null, sent: [], createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, assetIds: [], sourceAssetId: null, usage: { inputTokens: null, outputTokens: null, seconds: null, estimatedUsd: null }, remoteCancel: false, retriedAs: null, retryOf: null, request: { prompt: 'x', size: 'auto', quality: 'auto', count: 1 } };
  await fs.writeFile(path.join(engine.dir, 'ai', 'media-jobs.json'), JSON.stringify([queued]));
  const second = await setup('queued', p, first.workspace);
  await second.service.call('projects.open', { projectId });
  const job = (await second.service.call('media.jobs.list', { projectId }))[0]!;
  assert.equal(job.state, 'interrupted');
  assert.match(job.error ?? '', /nothing was sent/);
  const retry = await second.service.call('media.jobs.retry', { projectId, jobId: job.id, confirmUncertain: false });
  assert.equal((await settle(second.service, projectId, retry.id)).state, 'completed');
  await first.service.shutdown();
  await second.service.shutdown();
});

test('voice-over: Gemini speech output is saved as audio with provenance; the voice and delivery are sent', async () => {
  const h = await setup('speech');
  await connect(h.service);
  const projectId = await project(h.service);
  const job = await h.service.call('media.jobs.start', { projectId, job: { kind: 'speech', request: { text: 'Every piece is fired by hand.', voice: 'Kore', style: 'Warm and unhurried' } } });
  const done = await settle(h.service, projectId, job.id);
  assert.equal(done.state, 'completed', done.error ?? '');
  const call = h.provider.calls.find((c) => c.url.endsWith('/interactions') && (c.body as { response_format?: { type?: string } }).response_format?.type === 'audio')!;
  assert.equal(call.headers['x-goog-api-key'], GEMINI_KEY);
  const body = call.body as { model: string; generation_config: { speech_config: { voice: string }[] }; input: { content: { text: string; annotations?: { style: string }[] }[] }[] };
  assert.equal(body.model, 'test-tts-model');
  assert.equal(body.generation_config.speech_config[0]!.voice, 'Kore');
  assert.equal(body.input[0]!.content[0]!.annotations?.[0]?.style, 'Warm and unhurried');
  const asset = (await h.service.call('media.list', { projectId })).find((m) => m.id === done.assetIds[0])!;
  assert.equal(asset.kind, 'audio');
  assert.ok(asset.tags.includes('voice-over'));
  assert.equal(asset.provenance?.prompt, 'Every piece is fired by hand.');
  assert.equal(asset.provenance?.settings.voice, 'Kore');
  await h.service.shutdown();
});
