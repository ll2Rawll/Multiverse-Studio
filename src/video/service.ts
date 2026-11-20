import path from 'node:path';
import { StudioError } from '../engine/errors';
import type { ProjectEngine } from '../engine/project';
import { locateTools, MediaToolsMissing, runTool } from './ffmpeg';
import { MediaStore, type MediaRecord, type Tools } from './media';
import { ExportManager } from './exporter';
import { SEQUENCE_DIR, parseSequence } from './sequence';
import type { RenderAsset } from './render';
import { TICKS_PER_SECOND, sequenceDuration, type ExportJobView, type ExportSettings, type MediaAssetView, type Sequence, type SequenceSummary, type VideoToolsView, type WaveformView } from '../shared/video';
import type { StudioEvent } from '../shared/types';

export type MediaVariant = 'original' | 'play' | 'thumb' | 'strip';

/** Every library asset a sequence depends on: clip media and title fonts. */
export function usedAssets(seq: Sequence): string[] {
  const out = new Set<string>();
  for (const t of seq.tracks)
    for (const c of t.clips) {
      if (c.type === 'media') out.add(c.assetId);
      else if (c.style.fontAssetId) out.add(c.style.fontAssetId);
    }
  return [...out];
}

export interface VideoHost {
  engine(projectId: string): Promise<ProjectEngine>;
  emit(event: StudioEvent): void;
  mediaUrl(projectId: string, assetId: string, variant: MediaVariant, version: string): string;
}

export class VideoService {
  private located: { tools: Tools | null; view: VideoToolsView } | null = null;
  private readonly stores = new Map<string, MediaStore>();
  readonly exports: ExportManager;

  constructor(
    private readonly host: VideoHost,
    private readonly options: { cacheRoot: string; resourcesRoot: string },
  ) {
    this.exports = new ExportManager(
      {
        tools: () => this.requireTools(),
        fonts: { regular: path.join(options.resourcesRoot, 'fonts', 'Inter-Regular.otf'), semibold: path.join(options.resourcesRoot, 'fonts', 'Inter-SemiBold.otf') },
        assets: (projectId) => this.renderAssets(projectId),
        emit: (job) => host.emit({ type: 'video-job', projectId: job.projectId, job }),
      },
      (projectId) => this.projectDirCache.get(projectId) ?? '',
      path.join(options.cacheRoot, 'exports'),
    );
  }

  private readonly projectDirCache = new Map<string, string>();

  async toolsView(): Promise<VideoToolsView> {
    if (this.located) return this.located.view;
    const found = locateTools(path.join(this.options.resourcesRoot, 'bin'));
    if (!found.ffmpeg || !found.ffprobe) {
      this.located = { tools: null, view: { available: false, ffmpeg: found.ffmpeg, ffprobe: found.ffprobe, version: null, message: new MediaToolsMissing().message } };
      return this.located.view;
    }
    const v = await runTool(found.ffmpeg, ['-hide_banner', '-version']);
    const version = /ffmpeg version (\S+)/.exec(v.stdout.toString('utf8'))?.[1] ?? null;
    const tools = { ffmpeg: found.ffmpeg, ffprobe: found.ffprobe };
    this.located = { tools, view: { available: v.code === 0, ffmpeg: found.ffmpeg, ffprobe: found.ffprobe, version, message: v.code === 0 ? null : 'FFmpeg was found but could not run.' } };
    return this.located.view;
  }

  /** FFmpeg and ffprobe, or a clear error when they are not installed. */
  tools(): Tools {
    return this.requireTools();
  }

  private requireTools(): Tools {
    if (!this.located?.tools) throw new StudioError('ffmpeg-missing', new MediaToolsMissing().message);
    return this.located.tools;
  }

  /** Projects whose media library is loaded (their previews are re-made after a cache cleanup). */
  loadedProjects(): string[] {
    return [...this.stores.keys()];
  }

  async store(projectId: string): Promise<MediaStore> {
    await this.toolsView();
    let s = this.stores.get(projectId);
    if (!s) {
      const engine = await this.host.engine(projectId);
      this.projectDirCache.set(projectId, engine.dir);
      s = new MediaStore(engine.dir, path.join(this.options.cacheRoot, 'media'), () => this.requireTools(), () => this.host.emit({ type: 'media', projectId }));
      this.stores.set(projectId, s);
    }
    return s;
  }

  /* ---------------- sequences ---------------- */

  async sequences(projectId: string, lineId: string): Promise<{ summary: SequenceSummary; sequence: Sequence | null }[]> {
    const engine = await this.host.engine(projectId);
    const tree = await engine.effectiveTree(lineId);
    const out: { summary: SequenceSummary; sequence: Sequence | null }[] = [];
    for (const [p, hash] of tree) {
      if (!p.startsWith(`${SEQUENCE_DIR}/`) || !p.endsWith('.mvseq.json')) continue;
      const id = p.slice(SEQUENCE_DIR.length + 1, -'.mvseq.json'.length);
      try {
        const seq = parseSequence(Buffer.from(await engine.readBlob(hash)).toString('utf8'));
        out.push({ sequence: seq, summary: { id: seq.id, name: seq.name, path: p, durationSeconds: sequenceDuration(seq) / TICKS_PER_SECOND, width: seq.settings.width, height: seq.settings.height } });
      } catch {
        out.push({ sequence: null, summary: { id, name: `${id} (cannot be read)`, path: p, durationSeconds: 0, width: 0, height: 0 } });
      }
    }
    return out.sort((a, b) => a.summary.name.localeCompare(b.summary.name));
  }

  async sequence(projectId: string, lineId: string, sequenceId: string): Promise<{ sequence: Sequence; hash: string }> {
    const engine = await this.host.engine(projectId);
    const tree = await engine.effectiveTree(lineId);
    const p = `${SEQUENCE_DIR}/${sequenceId}.mvseq.json`;
    const hash = tree.get(p);
    if (!hash) throw new StudioError('not-found', 'That sequence does not exist in this version.');
    return { sequence: parseSequence(Buffer.from(await engine.readBlob(hash)).toString('utf8')), hash };
  }

  /* ---------------- media ---------------- */

  private async assetView(projectId: string, store: MediaStore, r: MediaRecord & { missing: boolean }, usedIn: string[]): Promise<MediaAssetView> {
    const ver = r.sha256.slice(0, 10);
    const url = (v: MediaVariant): string | null => (r.missing ? null : this.host.mediaUrl(projectId, r.id, v, ver));
    // A picture that is still being made has no address yet: a request now would cache a broken image.
    const ready = r.missing ? { thumb: false, strip: false } : await store.previews(r);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      sha256: r.sha256,
      size: r.size,
      importedAt: r.importedAt,
      probe: r.probe,
      status: r.missing ? 'missing' : 'ready',
      url: url('play'),
      thumbUrl: ready.thumb ? url('thumb') : null,
      stripUrl: ready.strip ? url('strip') : null,
      stripFrames: 10,
      proxy: r.proxy,
      usedIn,
      provenance: r.provenance ?? null,
      tags: r.tags ?? [],
      hasTranscript: Boolean(r.transcriptJobId),
    };
  }

  async listMedia(projectId: string, lineId: string | null): Promise<MediaAssetView[]> {
    const store = await this.store(projectId);
    const used = new Map<string, Set<string>>();
    if (lineId) {
      for (const { sequence } of await this.sequences(projectId, lineId)) {
        if (!sequence) continue;
        for (const t of sequence.tracks) for (const c of t.clips) if (c.type === 'media') (used.get(c.assetId) ?? used.set(c.assetId, new Set()).get(c.assetId)!).add(sequence.name);
      }
    }
    const list = await store.list();
    // Rebuild derived files that the cache lost (they are disposable).
    if (this.located?.tools) for (const r of list) if (!r.missing) void store.derive(r).catch(() => undefined);
    return Promise.all(list.map((r) => this.assetView(projectId, store, r, [...(used.get(r.id) ?? [])])));
  }

  async importMedia(projectId: string, paths: string[]): Promise<{ imported: MediaAssetView[]; failed: { name: string; reason: string }[] }> {
    const store = await this.store(projectId);
    this.requireTools();
    const imported: MediaRecord[] = [];
    const failed: { name: string; reason: string }[] = [];
    for (const p of paths) {
      try {
        imported.push(await store.import(p));
      } catch (error) {
        failed.push({ name: path.basename(p), reason: (error as Error).message });
      }
    }
    this.host.emit({ type: 'media', projectId });
    return { imported: await Promise.all(imported.map((r) => this.assetView(projectId, store, { ...r, missing: false }, []))), failed };
  }

  async relink(projectId: string, assetId: string, file: string): Promise<{ asset: MediaAssetView; sameContent: boolean }> {
    const store = await this.store(projectId);
    this.requireTools();
    const r = await store.relink(assetId, file);
    return { asset: await this.assetView(projectId, store, { ...r.record, missing: false }, []), sameContent: r.sameContent };
  }

  async waveform(projectId: string, assetId: string): Promise<WaveformView> {
    const store = await this.store(projectId);
    this.requireTools();
    return store.waveform(assetId);
  }

  async mediaFile(projectId: string, assetId: string, variant: MediaVariant): Promise<{ path: string; mime: string } | null> {
    const store = await this.store(projectId);
    return store.filePath(assetId, variant);
  }

  private async renderAssets(projectId: string): Promise<Map<string, RenderAsset>> {
    const store = await this.store(projectId);
    const map = new Map<string, RenderAsset>();
    for (const r of await store.list()) if (!r.missing) map.set(r.id, { path: store.fileOf(r), kind: r.kind, probe: r.probe });
    return map;
  }

  /* ---------------- export ---------------- */

  async startExport(projectId: string, lineId: string, sequenceId: string, settings: ExportSettings, destination: string | null): Promise<ExportJobView> {
    await this.store(projectId);
    this.requireTools();
    const { sequence, hash } = await this.sequence(projectId, lineId, sequenceId);
    const store = await this.store(projectId);
    const assetShas: Record<string, string> = {};
    for (const id of usedAssets(sequence)) assetShas[id] = (await store.get(id).catch(() => null))?.sha256 ?? '';
    const engine = await this.host.engine(projectId);
    const line = engine.line(lineId);
    return this.exports.start(projectId, lineId, sequence, settings, destination, { sequenceHash: hash, assetShas, revision: line.head, draft: Boolean(line.draftTree) });
  }

  /** Exports, each marked outdated when its sequence or media changed since it was made. */
  async listExports(projectId: string): Promise<ExportJobView[]> {
    const store = await this.store(projectId);
    const list = await this.exports.list(projectId);
    const engine = await this.host.engine(projectId);
    const media = new Map((await store.load()).assets.map((a) => [a.id, a.sha256]));
    const trees = new Map<string, Map<string, string> | null>();
    for (const job of list) {
      if (job.state !== 'completed' || !job.sourceHash) {
        job.outdated = null;
        continue;
      }
      if (!trees.has(job.lineId)) trees.set(job.lineId, await engine.effectiveTree(job.lineId).catch(() => null));
      const tree = trees.get(job.lineId);
      if (!tree) {
        job.outdated = { reason: 'version-deleted', detail: 'The version it was exported from was deleted.' };
        continue;
      }
      const current = tree.get(`${SEQUENCE_DIR}/${job.sequenceId}.mvseq.json`);
      if (!current) job.outdated = { reason: 'sequence-deleted', detail: `“${job.sequenceName}” was deleted.` };
      else if (current !== job.sourceHash) job.outdated = { reason: 'sequence-changed', detail: `“${job.sequenceName}” was edited after this export.` };
      else {
        const changed = Object.entries(job.assetShas ?? {}).filter(([id, sha]) => media.get(id) !== sha);
        job.outdated = changed.length ? { reason: 'media-changed', detail: `${changed.length} media file${changed.length === 1 ? '' : 's'} it uses changed after this export.` } : null;
      }
    }
    return list;
  }

  async cancelExport(projectId: string, jobId: string): Promise<ExportJobView> {
    await this.store(projectId);
    return this.exports.cancel(projectId, jobId);
  }

  async shutdown(): Promise<void> {
    await this.exports.shutdown();
    // Let queued preview work finish (bounded), so nothing writes into the cache after shutdown.
    const stores = await Promise.all([...this.stores.values()].map((p) => Promise.resolve(p).catch(() => null)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(stores.map((s) => s?.idle())),
      new Promise((r) => { timer = setTimeout(r, 15_000); }),
    ]);
    clearTimeout(timer);
  }
}
