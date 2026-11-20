/**
 * Export jobs: a persisted state machine per job (queued → running → completed | failed |
 * cancelled; running jobs found at startup become interrupted and are never restarted
 * automatically). One export runs at a time. A job is only completed after ffprobe reads the
 * finished file back and its streams and duration match what was asked for.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../engine/store/atomic';
import { StudioError } from '../engine/errors';
import { progressParser, runTool, tail } from './ffmpeg';
import { buildRenderPlan, RenderError, type RenderAsset } from './render';
import type { ExportJobView, ExportSettings, Sequence } from '../shared/video';
import type { Tools } from './media';

interface JobRecord extends ExportJobView {
  /** The sequence as it was when the export was requested. */
  snapshot: Sequence;
}

export interface ExportHost {
  tools(): Tools;
  fonts: { regular: string; semibold: string };
  assets(projectId: string): Promise<Map<string, RenderAsset>>;
  emit(job: ExportJobView): void;
}

const view = (j: JobRecord): ExportJobView => {
  const { snapshot: _s, ...rest } = j;
  return rest;
};

export class ExportManager {
  private readonly jobs = new Map<string, JobRecord[]>();
  private readonly loaded = new Set<string>();
  private queue: { projectId: string; jobId: string }[] = [];
  private running: { projectId: string; jobId: string; abort: AbortController } | null = null;

  constructor(
    private readonly host: ExportHost,
    private readonly projectDir: (projectId: string) => string,
    private readonly workRoot: string,
  ) {}

  /** True while an export renders or waits (its work folder is in use). */
  get busy(): boolean {
    return this.running !== null || this.queue.length > 0;
  }

  private file(projectId: string): string {
    return path.join(this.projectDir(projectId), 'exports', 'jobs.json');
  }

  private async load(projectId: string): Promise<JobRecord[]> {
    if (this.loaded.has(projectId)) return this.jobs.get(projectId)!;
    let list: JobRecord[] = [];
    try {
      list = JSON.parse(await fs.readFile(this.file(projectId), 'utf8')) as JobRecord[];
    } catch {
      list = [];
    }
    // Jobs that were queued or running when the app last closed are not resubmitted automatically.
    let changed = false;
    for (const j of list) {
      if (j.state === 'running' || j.state === 'queued') {
        j.state = 'interrupted';
        j.error = 'Multiverse Studio closed before this export finished. Start it again to export.';
        j.finishedAt = new Date().toISOString();
        changed = true;
      }
    }
    this.jobs.set(projectId, list);
    this.loaded.add(projectId);
    if (changed) await this.persist(projectId);
    return list;
  }

  private async persist(projectId: string): Promise<void> {
    const list = this.jobs.get(projectId) ?? [];
    await fs.mkdir(path.dirname(this.file(projectId)), { recursive: true });
    await writeFileAtomic(this.file(projectId), JSON.stringify(list.slice(-50), null, 1));
  }

  private async update(projectId: string, job: JobRecord, patch: Partial<JobRecord>): Promise<void> {
    Object.assign(job, patch);
    await this.persist(projectId);
    this.host.emit(view(job));
  }

  async list(projectId: string): Promise<ExportJobView[]> {
    return (await this.load(projectId)).map(view).reverse();
  }

  async start(projectId: string, lineId: string, sequence: Sequence, settings: ExportSettings, destination: string | null, sources: { sequenceHash: string; assetShas: Record<string, string>; revision?: string | null; draft?: boolean } | null = null): Promise<ExportJobView> {
    const list = await this.load(projectId);
    const id = `x-${randomUUID().slice(0, 8)}`;
    const ext = settings.format === 'mp4' ? 'mp4' : 'webm';
    const safe = sequence.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').slice(0, 80) || 'Export';
    let output = destination ?? path.join(this.workRoot, projectId, id, `${safe}.${ext}`);
    if (destination && path.extname(destination).toLowerCase() !== `.${ext}`) output = `${destination}.${ext}`;
    // Validate the plan now, so problems (an empty timeline, missing media) show before queuing.
    try {
      buildRenderPlan(sequence, await this.host.assets(projectId), settings, 'out');
    } catch (error) {
      if (error instanceof RenderError) throw new StudioError('export-invalid', error.message);
      throw error;
    }
    const job: JobRecord = { id, projectId, lineId, sequenceId: sequence.id, sequenceName: sequence.name, settings, state: 'queued', progress: 0, output, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, verified: null, ...(sources ? { sourceHash: sources.sequenceHash, assetShas: sources.assetShas, revision: sources.revision ?? null, draft: sources.draft ?? false } : {}), snapshot: structuredClone(sequence) };
    list.push(job);
    await this.persist(projectId);
    this.host.emit(view(job));
    this.queue.push({ projectId, jobId: id });
    void this.pump();
    return view(job);
  }

  async cancel(projectId: string, jobId: string): Promise<ExportJobView> {
    const job = (await this.load(projectId)).find((j) => j.id === jobId);
    if (!job) throw new StudioError('not-found', 'That export is no longer listed.');
    if (job.state === 'queued') {
      this.queue = this.queue.filter((q) => q.jobId !== jobId);
      await this.update(projectId, job, { state: 'cancelled', finishedAt: new Date().toISOString() });
    } else if (job.state === 'running' && this.running?.jobId === jobId) {
      this.running.abort.abort();
    }
    return view(job);
  }

  async shutdown(): Promise<void> {
    this.queue = [];
    this.running?.abort.abort();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const abort = new AbortController();
    this.running = { ...next, abort };
    try {
      await this.run(next.projectId, next.jobId, abort.signal);
    } catch {
      // run() records failures on the job; if even that fails (e.g. the disk is full), keep the queue going.
    } finally {
      this.running = null;
      void this.pump();
    }
  }

  private async run(projectId: string, jobId: string, signal: AbortSignal): Promise<void> {
    const job = (await this.load(projectId)).find((j) => j.id === jobId);
    if (!job || job.state !== 'queued') return;
    const work = path.join(this.workRoot, projectId, job.id, 'work');
    await this.update(projectId, job, { state: 'running', startedAt: new Date().toISOString(), progress: 0 });
    try {
      const plan = buildRenderPlan(job.snapshot, await this.host.assets(projectId), job.settings, job.output);
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(path.dirname(job.output), { recursive: true });
      await fs.writeFile(path.join(work, 'graph.txt'), plan.filter);
      for (const f of plan.files) await fs.writeFile(path.join(work, f.name), f.content);
      for (const f of plan.fonts) await fs.copyFile(f.path ?? (f.weight === 'semibold' ? this.host.fonts.semibold : this.host.fonts.regular), path.join(work, f.name));
      const partial = `${job.output}.partial${path.extname(job.output)}`;
      const args = [...plan.args.slice(0, -1), partial];
      let lastEmit = 0;
      const r = await runTool(this.host.tools().ffmpeg, args, {
        cwd: work,
        signal,
        onStdout: progressParser((s) => {
          const p = Math.max(0, Math.min(0.99, s / plan.durationSeconds));
          job.progress = p;
          if (Date.now() - lastEmit > 250) {
            lastEmit = Date.now();
            this.host.emit(view(job));
          }
        }),
      });
      if (r.cancelled) {
        await fs.rm(partial, { force: true });
        await this.update(projectId, job, { state: 'cancelled', finishedAt: new Date().toISOString() });
        return;
      }
      if (r.code !== 0) throw new Error(`FFmpeg could not finish the export.\n${tail(r.stderr)}`);
      const verified = await this.verify(partial, plan.durationSeconds, plan.width, plan.height, job.settings.format);
      await fs.rename(partial, job.output);
      await this.update(projectId, job, { state: 'completed', progress: 1, finishedAt: new Date().toISOString(), verified });
    } catch (error) {
      await this.update(projectId, job, { state: 'failed', finishedAt: new Date().toISOString(), error: (error as Error).message.slice(0, 2000) });
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  /** Read the file back; the export only counts if it has the streams and length that were asked for. */
  private async verify(file: string, duration: number, width: number, height: number, format: 'mp4' | 'webm'): Promise<NonNullable<ExportJobView['verified']>> {
    const r = await runTool(this.host.tools().ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    if (r.code !== 0) throw new Error(`The exported file could not be read back. ${tail(r.stderr, 2)}`);
    const json = JSON.parse(r.stdout.toString('utf8')) as { format?: { duration?: string; size?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[] };
    const v = json.streams?.find((s) => s.codec_type === 'video');
    const a = json.streams?.find((s) => s.codec_type === 'audio');
    const d = Number(json.format?.duration ?? 0);
    const expectedVideo = format === 'mp4' ? 'h264' : 'vp9';
    if (!v || v.codec_name !== expectedVideo) throw new Error(`The exported file has no ${expectedVideo} video stream.`);
    if (v.width !== width || v.height !== height) throw new Error(`The exported video is ${v.width}×${v.height}, not ${width}×${height}.`);
    if (Math.abs(d - duration) > Math.max(0.15, duration * 0.01)) throw new Error(`The exported file is ${d.toFixed(2)} s long, expected ${duration.toFixed(2)} s.`);
    return { durationSeconds: d, width: v.width, height: v.height, videoCodec: v.codec_name ?? '', audioCodec: a?.codec_name ?? null, size: Number(json.format?.size ?? 0) };
  }
}
