/**
 * Generation jobs: image, video and speech generation, transcription and preview recording.
 *
 * Each job is a persisted state machine in `<project>/ai/media-jobs.json`:
 *   queued → submitting → running → downloading → completed | failed | cancelled
 * The state is written *before* each step that has side effects, so after a crash we know exactly
 * where a job stopped:
 * - queued (never sent) and local work (recording) → interrupted; retrying is safe.
 * - submitting/running/downloading with a provider job id we can poll (video) → reconnect and keep
 *   checking. This is not a resubmission.
 * - submitting/running for a request that has no checkable id (image, speech, transcription)
 *   → uncertain: the provider may have done the work and charged for it. It is never sent again
 *   automatically; the user decides after checking their provider's usage page.
 *
 * Results are copied into the project's media store with provenance (provider, model, prompt,
 * settings, time, request id). Sample media is never shown in place of a result.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeFileAtomic } from '../engine/store/atomic';
import { StudioError } from '../engine/errors';
import { ProviderError } from '../ai/errors';
import { redactor } from '../ai/redact';
import type { AiService, ResolvedRoute } from '../ai/service';
import type { AdapterContext } from '../ai/types';
import { geminiCancelInteraction, geminiGenerateImages, geminiInteraction, geminiMediaBytes, geminiSpeech, geminiVideoSubmit, interactionMedia, openaiGenerateImages, openaiTranscribe, transcriptionFormat, type Interaction } from '../ai/media/adapters';
import { heavyWork, runTool, tail } from './ffmpeg';
import type { VideoService } from './service';
import type { BrowserProbe, RecordRequest } from '../agent/browser';
import type { Job, MediaAdapterId } from '../shared/ai';
import type { ImageRequest, MediaJobKind, MediaJobPlan, MediaJobView, MediaProvenance, RecordingRequest, SpeechRequest, TranscriptionRequest, TranscriptSegment, TranscriptView, VideoRequest } from '../shared/media';
import type { StudioEvent } from '../shared/types';
import { abortableSleep } from '../shared/sleep';

type Request = ImageRequest | VideoRequest | SpeechRequest | TranscriptionRequest | RecordingRequest;

interface JobRecord extends MediaJobView {
  request: Request;
}

export interface GenerationHost {
  ai(): AiService | null;
  video: VideoService;
  probe: BrowserProbe | null;
  emit(event: StudioEvent): void;
  projectDir(projectId: string): Promise<string>;
  /** A URL a browser can load for a page of a version (the preview server), or the running dev server. */
  recordingUrl(projectId: string, lineId: string, page: string): Promise<string>;
  cacheRoot: string;
}

const JOB_FOR: Record<Exclude<MediaJobKind, 'recording'>, Job> = { image: 'image-generation', video: 'video-generation', speech: 'speech-generation', transcription: 'transcription' };
const ADAPTERS: Record<Exclude<MediaJobKind, 'recording'>, MediaAdapterId[]> = {
  image: ['openai-images', 'gemini-image'],
  video: ['gemini-omni-video'],
  speech: ['gemini-speech'],
  transcription: ['openai-transcriptions'],
};
const ADAPTER_LABEL: Record<MediaJobKind, string> = { image: 'an image endpoint', video: 'a video endpoint', speech: 'a speech endpoint', transcription: 'a transcription endpoint', recording: 'a browser' };
/** OpenAI's documented upload limit for transcription is 25 MB; stay under it with room to spare. */
const MAX_UPLOAD = 24 * 1024 * 1024;
const CHUNK_SECONDS = 20 * 60;
const MAX_RUNNING = 2;
const POLL_MS = 8000;

const view = (j: JobRecord): MediaJobView => {
  const { request: _r, ...rest } = j;
  return rest;
};

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'generated';

export class GenerationJobs {
  private readonly jobs = new Map<string, JobRecord[]>();
  private readonly loaded = new Map<string, Promise<void>>();
  private readonly running = new Map<string, AbortController>();
  private queue: { projectId: string; jobId: string }[] = [];
  private chain = new Map<string, Promise<unknown>>();
  private closing = false;

  constructor(private readonly host: GenerationHost) {}

  /** True while a generation, transcription or recording runs or waits. */
  get busy(): boolean {
    return this.running.size > 0 || this.queue.length > 0;
  }

  private async file(projectId: string): Promise<string> {
    return path.join(await this.host.projectDir(projectId), 'ai', 'media-jobs.json');
  }

  private load(projectId: string): Promise<void> {
    let p = this.loaded.get(projectId);
    if (!p) {
      p = (async () => {
        let list: JobRecord[] = [];
        try {
          list = JSON.parse(await fs.readFile(await this.file(projectId), 'utf8')) as JobRecord[];
        } catch {
          list = [];
        }
        this.jobs.set(projectId, list);
        const resume: JobRecord[] = [];
        for (const j of list) {
          if (!['queued', 'submitting', 'running', 'downloading', 'cancelling'].includes(j.state)) continue;
          const at = new Date().toISOString();
          if (j.kind === 'video' && j.remoteId) {
            j.state = 'running';
            j.detail = 'Checking with the provider after a restart…';
            resume.push(j);
          } else if (j.state === 'queued' || j.kind === 'recording' || !j.sent.length) {
            // `sent` is recorded just before a request goes out, so an empty list means nothing left this computer.
            const neverSent = j.kind !== 'recording';
            j.state = 'interrupted';
            j.detail = neverSent ? 'Never sent. Multiverse Studio closed first.' : 'The recording stopped when Multiverse Studio closed.';
            j.error = 'Interrupted before it finished. Retrying is safe: nothing was sent to a provider.';
            j.finishedAt = at;
          } else {
            j.state = 'uncertain';
            j.detail = 'Multiverse Studio closed while this request was with the provider.';
            j.error = `The provider may have finished this request and charged for it, but there is no job id to check. Look at your ${j.connectionName ?? 'provider'} usage page before trying again; it will not be sent again automatically.`;
            j.finishedAt = at;
          }
        }
        await this.persist(projectId);
        for (const j of resume) void this.followVideo(projectId, j, null);
      })();
      this.loaded.set(projectId, p);
    }
    return p;
  }

  private persist(projectId: string): Promise<void> {
    const run = (this.chain.get(projectId) ?? Promise.resolve()).then(async () => {
      const file = await this.file(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, JSON.stringify((this.jobs.get(projectId) ?? []).slice(-200), null, 1));
    });
    this.chain.set(projectId, run.catch(() => undefined));
    return run;
  }

  private async update(projectId: string, job: JobRecord, patch: Partial<JobRecord>): Promise<void> {
    if (this.closing) return;
    Object.assign(job, patch);
    await this.persist(projectId);
    this.host.emit({ type: 'media-job', projectId, job: view(job) });
  }

  async list(projectId: string): Promise<MediaJobView[]> {
    await this.load(projectId);
    return (this.jobs.get(projectId) ?? []).map(view).reverse();
  }

  private async find(projectId: string, jobId: string): Promise<JobRecord> {
    await this.load(projectId);
    const j = this.jobs.get(projectId)?.find((x) => x.id === jobId);
    if (!j) throw new StudioError('not-found', 'That job is no longer listed.');
    return j;
  }

  /* ---------------- routing ---------------- */

  private ai(): AiService {
    const ai = this.host.ai();
    if (!ai) throw new StudioError('unavailable', 'AI is not available in this window.');
    return ai;
  }

  private async route(kind: Exclude<MediaJobKind, 'recording'>): Promise<{ route: ResolvedRoute; adapter: MediaAdapterId }> {
    let route: ResolvedRoute;
    try {
      route = await this.ai().resolve(JOB_FOR[kind]);
    } catch (error) {
      if (error instanceof ProviderError) throw new StudioError('not-configured', error.message);
      throw error;
    }
    const adapter = ADAPTERS[kind].find((a) => route.connection.media.includes(a));
    if (!adapter) {
      throw new StudioError(
        'not-configured',
        `${route.connection.name} is not set up with ${ADAPTER_LABEL[kind]}. Turn it on for this connection in Settings → Providers (where the provider offers one), or assign a model on a connection that has it in Settings → Models.`,
      );
    }
    return { route, adapter };
  }

  /** Describe exactly what a job will send, before anything leaves the computer. */
  async plan(projectId: string, kind: MediaJobKind, request: Request): Promise<MediaJobPlan> {
    if (kind === 'recording') {
      if (!this.host.probe?.record) throw new StudioError('unavailable', 'Recording needs the desktop app’s browser, which is not available here.');
      const r = request as RecordingRequest;
      return { kind, connectionName: 'This computer', provider: 'local', model: this.host.probe.label, local: true, sends: [], estimatedUsd: null, notes: [`Records ${r.page === 'dev-server' ? 'the running app' : r.page} at ${r.width}×${r.height} for ${r.seconds} s in an isolated browser. Nothing is sent anywhere.`] };
    }
    const { route } = await this.route(kind);
    const sends: MediaJobPlan['sends'] = [];
    const notes: string[] = [];
    if (kind === 'image') {
      const r = request as ImageRequest;
      sends.push({ name: 'Your prompt', bytes: Buffer.byteLength(r.prompt), note: `${r.count} image${r.count === 1 ? '' : 's'}, ${r.size}` });
      if (r.count > 1) notes.push(`This makes ${r.count} images in one request; each is billed.`);
    } else if (kind === 'video') {
      const r = request as VideoRequest;
      sends.push({ name: 'Your prompt', bytes: Buffer.byteLength(r.prompt), note: `${r.aspectRatio}, ${r.resolution}` });
      if (r.imageAssetId) {
        const store = await this.host.video.store(projectId);
        const a = await store.get(r.imageAssetId);
        sends.push({ name: a.name, bytes: a.size, note: 'Starting image (uploaded)' });
      }
      notes.push('Video generation can take several minutes. You can close this panel; the job keeps its provider id and is checked again after a restart.');
    } else if (kind === 'speech') {
      const r = request as SpeechRequest;
      sends.push({ name: 'Narration text', bytes: Buffer.byteLength(r.text), note: `Voice ${r.voice || 'default'}` });
    } else {
      const r = request as TranscriptionRequest;
      const store = await this.host.video.store(projectId);
      const a = await store.get(r.assetId);
      const d = a.probe.durationSeconds ?? 0;
      const chunks = Math.max(1, Math.ceil(d / CHUNK_SECONDS));
      sends.push({ name: `Audio from ${a.name}`, bytes: Math.round(d * 4000), note: `${Math.round(d)} s as mono 32 kbps MP3${chunks > 1 ? ` in ${chunks} parts` : ''}; the picture is not sent` });
      if (!transcriptionFormat(route.model.id)) notes.push(`${route.model.label} returns text without timings, so it can’t make captions. Choose a model that returns segments.`);
    }
    const priced = route.model.pricing && (route.model.pricing.inputPerMTok !== null || route.model.pricing.outputPerMTok !== null);
    return { kind, connectionName: route.connection.name, provider: route.connection.provider, model: route.model.id, local: route.local, sends, estimatedUsd: null, notes: [...notes, priced ? 'Token prices are known for this model, but media charges are not, so the cost is shown as unknown.' : 'Cost: unknown (this provider does not publish a price this app can read).'] };
  }

  /* ---------------- starting and running ---------------- */

  async start(projectId: string, kind: MediaJobKind, request: Request, retryOf: string | null = null): Promise<MediaJobView> {
    await this.load(projectId);
    let connectionId: string | null = null;
    let connectionName: string | null = null;
    let provider: string | null = null;
    let model: string | null = null;
    if (kind !== 'recording') {
      const { route } = await this.route(kind);
      connectionId = route.connection.id;
      connectionName = route.connection.name;
      provider = route.connection.provider;
      model = route.model.id;
      if (kind === 'transcription' && !transcriptionFormat(model)) {
        throw new StudioError('unsupported', `${route.model.label} returns text without timings, so it can't make captions. Assign a model that returns segments (for example whisper-1 or a diarize model) to Transcription in Settings → Models.`);
      }
    } else if (!this.host.probe?.record) {
      throw new StudioError('unavailable', 'Recording needs the desktop app’s browser, which is not available here.');
    }
    const settings = settingsOf(kind, request);
    const job: JobRecord = {
      id: `g-${randomUUID().slice(0, 10)}`,
      projectId,
      kind,
      state: 'queued',
      detail: 'Waiting to start',
      title: titleOf(kind, request),
      prompt: promptOf(kind, request),
      settings,
      connectionId,
      connectionName,
      provider,
      model,
      remoteId: null,
      sent: [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      assetIds: [],
      sourceAssetId: kind === 'transcription' ? (request as TranscriptionRequest).assetId : null,
      usage: { inputTokens: null, outputTokens: null, seconds: null, estimatedUsd: null },
      remoteCancel: kind === 'video',
      retriedAs: null,
      retryOf,
      request,
    };
    this.jobs.get(projectId)!.push(job);
    await this.persist(projectId);
    this.host.emit({ type: 'media-job', projectId, job: view(job) });
    this.queue.push({ projectId, jobId: job.id });
    void this.pump();
    return view(job);
  }

  /** Start again from a job that failed, was interrupted, cancelled or is uncertain. Always an explicit user action. */
  async retry(projectId: string, jobId: string, confirmUncertain: boolean): Promise<MediaJobView> {
    const old = await this.find(projectId, jobId);
    if (!['failed', 'interrupted', 'cancelled', 'uncertain'].includes(old.state)) throw new StudioError('invalid', 'Only finished jobs that did not complete can be tried again.');
    if (old.state === 'uncertain' && !confirmUncertain) throw new StudioError('confirm-needed', 'This request may already have run and been charged. Confirm that you checked your provider’s usage before sending it again.');
    const next = await this.start(projectId, old.kind, old.request, old.id);
    await this.update(projectId, old, { retriedAs: next.id });
    return next;
  }

  async cancel(projectId: string, jobId: string): Promise<MediaJobView> {
    const job = await this.find(projectId, jobId);
    if (job.state === 'queued') {
      this.queue = this.queue.filter((q) => q.jobId !== jobId);
      await this.update(projectId, job, { state: 'cancelled', detail: 'Cancelled before it was sent.', finishedAt: new Date().toISOString() });
    } else if (job.kind === 'video' && job.remoteId && (job.state === 'running' || job.state === 'submitting')) {
      await this.update(projectId, job, { state: 'cancelling', detail: 'Asking the provider to stop…' });
      try {
        const ctx = await this.ctx(job, null);
        await geminiCancelInteraction(ctx, job.remoteId);
        await this.update(projectId, job, { state: 'cancelled', detail: 'The provider stopped the job.', finishedAt: new Date().toISOString() });
      } catch (error) {
        await this.update(projectId, job, { state: 'running', detail: `The provider did not accept the cancellation: ${(error as Error).message.slice(0, 200)}` });
      }
      this.running.get(jobId)?.abort();
    } else if (['submitting', 'running', 'downloading'].includes(job.state)) {
      this.running.get(jobId)?.abort();
      // The abort handler records the final state.
    }
    return view(job);
  }

  /**
   * The app is closing. Stop local work and waiting, but leave each job's saved state as it is, so
   * the next start knows where it stopped: remote video jobs are followed again, requests that
   * were in flight become uncertain, and nothing is cancelled at the provider.
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    this.queue = [];
    for (const c of this.running.values()) c.abort();
  }

  private async pump(): Promise<void> {
    while (this.running.size < MAX_RUNNING && this.queue.length) {
      const next = this.queue.shift()!;
      const job = this.jobs.get(next.projectId)?.find((j) => j.id === next.jobId);
      if (!job || job.state !== 'queued') continue;
      const abort = new AbortController();
      this.running.set(job.id, abort);
      void this.run(next.projectId, job, abort.signal).catch(() => undefined).finally(() => {
        this.running.delete(job.id);
        void this.pump();
      });
    }
  }

  private async ctx(job: JobRecord, signal: AbortSignal | null): Promise<AdapterContext> {
    const ai = this.ai();
    const route = await ai.routeFor(job.connectionId!, job.model!);
    return ai.mediaContext(route, signal ?? undefined);
  }

  private provenance(job: JobRecord, requestId: string | null): MediaProvenance {
    return { source: job.kind === 'recording' ? 'recording' : 'generated', provider: job.provider, connectionName: job.connectionName, model: job.model, prompt: job.prompt, settings: job.settings, createdAt: new Date().toISOString(), requestId, jobId: job.id };
  }

  private async run(projectId: string, job: JobRecord, signal: AbortSignal): Promise<void> {
    await this.update(projectId, job, { state: job.kind === 'recording' ? 'running' : 'submitting', startedAt: new Date().toISOString(), detail: job.kind === 'recording' ? 'Recording…' : 'Sending the request…' });
    try {
      if (job.kind === 'image') await this.runImage(projectId, job, signal);
      else if (job.kind === 'speech') await this.runSpeech(projectId, job, signal);
      else if (job.kind === 'transcription') await this.runTranscription(projectId, job, signal);
      else if (job.kind === 'recording') await this.runRecording(projectId, job, signal);
      else await this.runVideo(projectId, job, signal);
    } catch (error) {
      const at = new Date().toISOString();
      if (this.closing) return;
      if (signal.aborted || (error instanceof ProviderError && error.kind === 'cancelled')) {
        if (job.state === 'cancelled') return;
        const remote = job.kind === 'video' && job.remoteId;
        await this.update(projectId, job, {
          state: 'cancelled',
          finishedAt: at,
          detail: remote ? 'Stopped following the job.' : job.kind === 'recording' ? 'Recording stopped.' : 'Stopped waiting.',
          error: job.kind === 'recording' || !job.sent.length ? null : 'Stopping only stopped this app from waiting: the provider may still finish the request and charge for it.',
        });
        return;
      }
      const message = redactor.redact(error instanceof ProviderError ? `${error.message} ${error.help}`.trim() : (error as Error).message);
      // A paid request that was sent but whose answer never arrived may still have run. Do not
      // call that a plain failure: the user has to check before anything is sent again.
      const lostAnswer = job.kind !== 'recording' && job.kind !== 'video' && job.state === 'running' && error instanceof ProviderError && (error.kind === 'timeout' || error.kind === 'network');
      if (lostAnswer) {
        await this.update(projectId, job, {
          state: 'uncertain',
          finishedAt: at,
          detail: 'The answer never arrived',
          error: `${message.slice(0, 600)} The provider may have finished this request and charged for it. Check your ${job.connectionName ?? 'provider'} usage page before trying again; it will not be sent again automatically.`,
        });
        return;
      }
      await this.update(projectId, job, { state: 'failed', finishedAt: at, detail: 'Failed', error: message.slice(0, 2000) });
    }
  }

  private async finish(projectId: string, job: JobRecord, assetIds: string[], detail: string, usage: Partial<MediaJobView['usage']> = {}): Promise<void> {
    await this.update(projectId, job, { state: 'completed', finishedAt: new Date().toISOString(), detail, assetIds, usage: { ...job.usage, ...usage } });
    this.host.emit({ type: 'media', projectId });
  }

  private async runImage(projectId: string, job: JobRecord, signal: AbortSignal): Promise<void> {
    const r = job.request as ImageRequest;
    const { route, adapter } = await this.route('image');
    const ctx = await this.ai().mediaContext(route, signal);
    job.sent = [{ name: 'Prompt', bytes: Buffer.byteLength(r.prompt) }];
    await this.update(projectId, job, { state: 'running', detail: `Generating with ${route.model.label}…` });
    const out =
      adapter === 'openai-images'
        ? await openaiGenerateImages(ctx, { model: route.model.id, prompt: r.prompt, size: openaiSize(r.size), quality: r.quality, count: r.count })
        : { ...(await geminiGenerateImages(ctx, { model: route.model.id, prompt: r.prompt, aspectRatio: aspectOf(r.size), imageSize: null })) };
    await this.update(projectId, job, { state: 'downloading', remoteId: out.requestId, detail: 'Saving into the project…' });
    const store = await this.host.video.store(projectId);
    const ids: string[] = [];
    for (const [i, img] of out.images.entries()) {
      const rec = await store.importBytes(img.bytes, `${slug(r.prompt)}${out.images.length > 1 ? `-${i + 1}` : ''}.${img.ext}`, this.provenance(job, out.requestId), ['generated']);
      ids.push(rec.id);
    }
    await this.ai().markVerified(route, 'image-generation', 'Generated an image');
    await this.finish(projectId, job, ids, `${ids.length} image${ids.length === 1 ? '' : 's'} added to Assets`, out.usage);
  }

  private async runSpeech(projectId: string, job: JobRecord, signal: AbortSignal): Promise<void> {
    const r = job.request as SpeechRequest;
    const { route } = await this.route('speech');
    const ctx = await this.ai().mediaContext(route, signal);
    job.sent = [{ name: 'Narration text', bytes: Buffer.byteLength(r.text) }];
    await this.update(projectId, job, { state: 'running', detail: `Generating speech with ${route.model.label}…` });
    const out = await geminiSpeech(ctx, { model: route.model.id, text: r.text, voice: r.voice, style: r.style });
    await this.update(projectId, job, { state: 'downloading', remoteId: out.requestId, detail: 'Saving into the project…' });
    const store = await this.host.video.store(projectId);
    const rec = await store.importBytes(out.audio.bytes, `${slug(r.text)}.${out.audio.ext}`, this.provenance(job, out.requestId), ['generated', 'voice-over']);
    await this.ai().markVerified(route, 'speech-generation', 'Generated speech');
    await this.finish(projectId, job, [rec.id], 'Voice-over added to Assets');
  }

  private async runTranscription(projectId: string, job: JobRecord, signal: AbortSignal): Promise<void> {
    const r = job.request as TranscriptionRequest;
    const { route } = await this.route('transcription');
    const store = await this.host.video.store(projectId);
    const asset = await store.get(r.assetId);
    const source = (await store.filePath(asset.id, 'original'))?.path;
    if (!source) throw new StudioError('media-missing', `${asset.name} is missing. Relink it in Assets first.`);
    if (!asset.probe.hasAudio) throw new StudioError('no-audio', `${asset.name} has no sound to transcribe.`);
    const duration = asset.probe.durationSeconds ?? 0;
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-transcribe-'));
    try {
      // Extract only the sound, small and mono, in parts that stay under the upload limit.
      const parts: { file: string; offset: number }[] = [];
      const count = Math.max(1, Math.ceil(duration / CHUNK_SECONDS));
      await this.update(projectId, job, { state: 'submitting', detail: 'Preparing the audio…' });
      for (let i = 0; i < count; i++) {
        const file = path.join(work, `part-${i}.mp3`);
        const res = await heavyWork.run(() => runTool(this.host.video.tools().ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', String(i * CHUNK_SECONDS), '-t', String(CHUNK_SECONDS), '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', file], { signal }));
        if (res.cancelled) throw new ProviderError('cancelled', 'Stopped.');
        if (res.code !== 0) throw new Error(`The audio could not be prepared.\n${tail(res.stderr)}`);
        const size = (await fs.stat(file)).size;
        if (size > MAX_UPLOAD) throw new StudioError('too-large', 'A part of the audio is larger than the upload limit.');
        parts.push({ file, offset: i * CHUNK_SECONDS });
      }
      job.sent = await Promise.all(parts.map(async (p, i) => ({ name: `${asset.name} audio${parts.length > 1 ? ` part ${i + 1}` : ''} (mp3)`, bytes: (await fs.stat(p.file)).size })));
      await this.update(projectId, job, { state: 'running', detail: `Transcribing with ${route.model.label}…` });
      const ctx = await this.ai().mediaContext(route, signal);
      const segments: TranscriptSegment[] = [];
      let language: string | null = null;
      let requestId: string | null = null;
      let seconds = 0;
      for (const [i, p] of parts.entries()) {
        if (parts.length > 1) await this.update(projectId, job, { detail: `Transcribing part ${i + 1} of ${parts.length}…` });
        const out = await openaiTranscribe(ctx, { model: route.model.id, file: await fs.readFile(p.file), filename: path.basename(p.file), mime: 'audio/mpeg', language: r.language });
        segments.push(...out.segments.map((s) => ({ ...s, start: s.start + p.offset, end: s.end + p.offset })));
        language ??= out.language;
        requestId ??= out.requestId;
        seconds += out.usage.seconds ?? out.duration ?? 0;
      }
      const transcript: TranscriptView = { assetId: asset.id, jobId: job.id, language, model: route.model.id, createdAt: new Date().toISOString(), segments };
      await store.saveTranscript(transcript);
      await this.ai().markVerified(route, 'speech-recognition', 'Transcribed audio with timings');
      await this.update(projectId, job, { remoteId: requestId });
      await this.finish(projectId, job, [], `${segments.length} timed segment${segments.length === 1 ? '' : 's'} saved with ${asset.name}`, { seconds: seconds || null });
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  private async runRecording(projectId: string, job: JobRecord, signal: AbortSignal): Promise<void> {
    const r = job.request as RecordingRequest;
    const probe = this.host.probe;
    if (!probe?.record) throw new StudioError('unavailable', 'Recording needs the desktop app’s browser.');
    const url = await this.host.recordingUrl(projectId, r.lineId, r.page);
    const dir = path.join(this.host.cacheRoot, 'recordings', job.id);
    await fs.mkdir(dir, { recursive: true });
    try {
      const request: RecordRequest = { url, width: r.width, height: r.height, seconds: r.seconds, steps: r.steps, outputDir: dir, fps: 30 };
      const abortable = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new ProviderError('cancelled', 'Stopped.')), { once: true }));
      const out = await Promise.race([probe.record(request), abortable]);
      await this.update(projectId, job, { state: 'downloading', detail: 'Adding the recording to the project…' });
      const store = await this.host.video.store(projectId);
      const name = `${r.page === 'dev-server' ? 'app' : r.page.replace(/\.html?$/, '').replace(/[^a-z0-9]+/gi, '-')}-recording-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}${path.extname(out.file) || '.webm'}`;
      const rec = await store.importFile(out.file, name, this.provenance(job, null), ['screen recording']);
      await this.finish(projectId, job, [rec.id], `${r.seconds} s recording added to Assets`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private async runVideo(projectId: string, job: JobRecord, signal: AbortSignal): Promise<void> {
    const r = job.request as VideoRequest;
    const { route } = await this.route('video');
    const ctx = await this.ai().mediaContext(route, signal);
    let image: { data: Buffer; mime: string } | null = null;
    const sent = [{ name: 'Prompt', bytes: Buffer.byteLength(r.prompt) }];
    if (r.imageAssetId) {
      const store = await this.host.video.store(projectId);
      const a = await store.get(r.imageAssetId);
      const file = (await store.filePath(a.id, 'original'))?.path;
      if (!file) throw new StudioError('media-missing', `${a.name} is missing. Relink it first.`);
      image = { data: await fs.readFile(file), mime: a.ext === 'png' ? 'image/png' : a.ext === 'webp' ? 'image/webp' : 'image/jpeg' };
      sent.push({ name: a.name, bytes: image.data.length });
    }
    await this.update(projectId, job, { sent, state: 'submitting', detail: 'Sending the request…' });
    const first = await geminiVideoSubmit(ctx, { model: route.model.id, prompt: r.prompt, aspectRatio: r.aspectRatio, resolution: r.resolution, image });
    await this.update(projectId, job, { state: 'running', remoteId: first.id ?? null, detail: 'The provider is generating the video…' });
    await this.followVideo(projectId, job, first, signal);
  }

  /** Poll a background video interaction until it ends, then download the result. Used after restarts too. */
  private async followVideo(projectId: string, job: JobRecord, first: Interaction | null, outerSignal: AbortSignal | null = null): Promise<void> {
    const abort = new AbortController();
    if (!outerSignal) this.running.set(job.id, abort);
    const signal = outerSignal ?? abort.signal;
    try {
      const ctx = await this.ctx(job, signal);
      let current: Interaction | null = first;
      const started = Date.now();
      while (!current || !['completed', 'failed', 'cancelled', 'incomplete'].includes(current.status ?? '')) {
        if (current && !current.status && interactionMedia(current, 'video').length) break;
        await abortableSleep(current ? POLL_MS : 0, signal, () => new ProviderError('cancelled', 'Stopped.'));
        current = await geminiInteraction(ctx, job.remoteId!);
        const mins = Math.floor((Date.now() - started) / 60000);
        if (job.state === 'running') await this.update(projectId, job, { detail: `The provider is generating the video${mins ? ` (${mins} min so far)` : ''}…` });
      }
      if (current.status === 'cancelled') {
        await this.update(projectId, job, { state: 'cancelled', finishedAt: new Date().toISOString(), detail: 'The provider stopped the job.' });
        return;
      }
      if (current.status === 'failed' || current.status === 'incomplete') throw new ProviderError('invalid-response', `The provider reported the video as ${current.status}${current.error?.message ? `: ${current.error.message}` : '.'}`);
      const block = interactionMedia(current, 'video')[0];
      if (!block) throw new ProviderError('invalid-response', 'The finished interaction contains no video.');
      await this.update(projectId, job, { state: 'downloading', detail: 'Downloading the video…' });
      const media = await geminiMediaBytes(ctx, block, 'video/mp4');
      const store = await this.host.video.store(projectId);
      const r = job.request as VideoRequest;
      const rec = await store.importBytes(media.bytes, `${slug(r.prompt)}.${media.ext === 'bin' ? 'mp4' : media.ext}`, this.provenance(job, job.remoteId), ['generated']);
      const ai = this.ai();
      await ai.markVerified(await ai.routeFor(job.connectionId!, job.model!), 'video-generation', 'Generated a video');
      await this.finish(projectId, job, [rec.id], 'Video added to Assets');
    } catch (error) {
      if (outerSignal) throw error;
      if (signal.aborted) return;
      await this.update(projectId, job, { state: 'failed', finishedAt: new Date().toISOString(), detail: 'Failed', error: redactor.redact((error as Error).message).slice(0, 2000) });
    } finally {
      if (!outerSignal) this.running.delete(job.id);
    }
  }
}

function titleOf(kind: MediaJobKind, r: Request): string {
  if (kind === 'image') return `Image: ${(r as ImageRequest).prompt.slice(0, 60)}`;
  if (kind === 'video') return `Video: ${(r as VideoRequest).prompt.slice(0, 60)}`;
  if (kind === 'speech') return `Voice-over: ${(r as SpeechRequest).text.slice(0, 60)}`;
  if (kind === 'transcription') return 'Transcription';
  const rec = r as RecordingRequest;
  return `Recording of ${rec.page === 'dev-server' ? 'the running app' : rec.page}`;
}

function promptOf(kind: MediaJobKind, r: Request): string | null {
  if (kind === 'image') return (r as ImageRequest).prompt;
  if (kind === 'video') return (r as VideoRequest).prompt;
  if (kind === 'speech') return (r as SpeechRequest).text;
  return null;
}

function settingsOf(kind: MediaJobKind, r: Request): Record<string, string | number | boolean | null> {
  if (kind === 'image') {
    const x = r as ImageRequest;
    return { size: x.size, quality: x.quality, count: x.count };
  }
  if (kind === 'video') {
    const x = r as VideoRequest;
    return { aspectRatio: x.aspectRatio, resolution: x.resolution, imageAssetId: x.imageAssetId };
  }
  if (kind === 'speech') {
    const x = r as SpeechRequest;
    return { voice: x.voice, style: x.style };
  }
  if (kind === 'transcription') return { language: (r as TranscriptionRequest).language };
  const x = r as RecordingRequest;
  return { page: x.page, width: x.width, height: x.height, seconds: x.seconds, steps: x.steps.length };
}

/** The UI asks for a shape; each provider names sizes differently. */
export function openaiSize(size: string): string {
  const m = /^(\d+):(\d+)$/.exec(size);
  if (!m) return size;
  const r = Number(m[1]) / Number(m[2]);
  return r > 1.1 ? '1536x1024' : r < 0.9 ? '1024x1536' : '1024x1024';
}

export function aspectOf(size: string): string {
  if (size === 'auto') return '';
  if (/^\d+:\d+$/.test(size)) return size;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return '';
  const r = Number(m[1]) / Number(m[2]);
  const options: [string, number][] = [['1:1', 1], ['3:2', 1.5], ['2:3', 2 / 3], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 0.75]];
  return options.reduce((best, o) => (Math.abs(o[1] - r) < Math.abs(best[1] - r) ? o : best))[0];
}
