/**
 * The project's media store. Imported files are copied into `<project>/media/<aa>/<sha256>.<ext>`
 * (content-addressed, outside the revision tree, shared by every version) and described in
 * `<project>/media/index.json` with a stable asset id that sequences refer to.
 *
 * Derived files (thumbnails, a thumbnail strip, waveform peaks, a playback proxy for formats
 * Chromium cannot play) live in the cache folder and can always be rebuilt.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { writeFileAtomic } from '../engine/store/atomic';
import { StudioError } from '../engine/errors';
import { heavyWork, runTool, tail } from './ffmpeg';
import type { MediaKind, MediaProbe, WaveformView } from '../shared/video';
import type { MediaProvenance, TranscriptView } from '../shared/media';

export interface MediaRecord {
  id: string;
  name: string;
  kind: MediaKind;
  sha256: string;
  ext: string;
  size: number;
  importedAt: string;
  probe: MediaProbe;
  proxy: 'none' | 'needed' | 'ready' | 'failed';
  /** Where the file came from; generated and recorded media say which provider, model and prompt. */
  provenance?: MediaProvenance;
  tags?: string[];
  /** The latest transcript (job id), stored next to the media index. */
  transcriptJobId?: string | null;
}

interface MediaIndex {
  version: 1;
  assets: MediaRecord[];
}

const MAX_IMPORT_BYTES = 50 * 1024 ** 3;
const STRIP_FRAMES = 10;
const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_f32le', 'pcm_u8']);
const IMAGE_CODECS = new Set(['png', 'mjpeg', 'webp', 'gif', 'bmp', 'tiff']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff']);
export const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2']);

/** Fonts are recognised by their signature, not only their name. */
async function fontProbe(file: string): Promise<MediaProbe | null> {
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    const sig = head.toString('latin1');
    const ok = sig === 'OTTO' || sig === 'wOFF' || sig === 'wOF2' || sig === 'true' || head.readUInt32BE(0) === 0x00010000;
    return ok ? { durationSeconds: null, width: null, height: null, fps: null, rotation: 0, hasVideo: false, hasAudio: false, videoCodec: null, audioCodec: null, sampleRate: null, channels: null, playable: false } : null;
  } finally {
    await handle.close();
  }
}

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
}

export async function probeFile(tools: Tools, file: string): Promise<{ probe: MediaProbe; kind: MediaKind }> {
  const r = await runTool(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new StudioError('unsupported-media', `This file could not be read as audio, video or an image. ${tail(r.stderr, 2)}`.trim());
  const json = JSON.parse(r.stdout.toString('utf8') || '{}') as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; sample_rate?: string; channels?: number; duration?: string; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[]; disposition?: { attached_pic?: number } }[];
  };
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const ext = path.extname(file).slice(1).toLowerCase();
  const isImage = Boolean(v && IMAGE_CODECS.has(v.codec_name ?? '') && !a && (IMAGE_EXT.has(ext) || !json.format?.duration || Number(json.format.duration) < 0.1 || v.codec_name === 'png'));
  if (!v && !a) throw new StudioError('unsupported-media', 'This file has no audio or video.');
  const rate = (s?: string): { num: number; den: number } | null => {
    const m = /^(\d+)\/(\d+)$/.exec(s ?? '');
    return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? { num: Number(m[1]), den: Number(m[2]) } : null;
  };
  const duration = Number(json.format?.duration ?? v?.duration ?? a?.duration ?? NaN);
  const rotation = Number(v?.tags?.rotate ?? v?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? 0) || 0;
  const kind: MediaKind = isImage ? 'image' : v ? 'video' : 'audio';
  const fmt = json.format?.format_name ?? '';
  const container = /mp4|mov|webm|matroska|mp3|ogg|wav|flac|aac|png|jpeg|webp|gif|image2/.test(fmt) || kind === 'image';
  const playable = kind === 'image' ? true : container && (!v || PLAYABLE_VIDEO.has(v.codec_name ?? '')) && (!a || PLAYABLE_AUDIO.has(a.codec_name ?? ''));
  return {
    kind,
    probe: {
      durationSeconds: kind === 'image' || !Number.isFinite(duration) ? null : duration,
      width: v?.width ?? null,
      height: v?.height ?? null,
      fps: kind === 'video' ? (rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate)) : null,
      rotation: ((Math.round(rotation) % 360) + 360) % 360,
      hasVideo: Boolean(v),
      hasAudio: Boolean(a),
      videoCodec: v?.codec_name ?? null,
      audioCodec: a?.codec_name ?? null,
      sampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
      channels: a?.channels ?? null,
      playable,
    },
  };
}

export class MediaStore {
  private index: MediaIndex | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly derivations = new Map<string, Promise<void>>();

  /** Resolves when no preview is being made (used on shutdown, so caches are not written after). */
  async idle(): Promise<void> {
    while (this.derivations.size) await Promise.allSettled([...this.derivations.values()]);
  }

  readonly projectDir: string;
  readonly cacheDir: string;

  constructor(
    projectDir: string,
    cacheDir: string,
    private readonly tools: () => Tools,
    private readonly onChange: () => void,
  ) {
    // FFmpeg runs in job folders, so every path it sees must be absolute.
    this.projectDir = path.resolve(projectDir);
    this.cacheDir = path.resolve(cacheDir);
  }

  get dir(): string {
    return path.join(this.projectDir, 'media');
  }

  fileOf(r: Pick<MediaRecord, 'sha256' | 'ext'>): string {
    return path.join(this.dir, r.sha256.slice(0, 2), `${r.sha256}${r.ext ? `.${r.ext}` : ''}`);
  }

  derivedDir(r: Pick<MediaRecord, 'sha256'>): string {
    return path.join(this.cacheDir, r.sha256);
  }

  async load(): Promise<MediaIndex> {
    if (this.index) return this.index;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.dir, 'index.json'), 'utf8')) as MediaIndex;
      this.index = parsed.version === 1 && Array.isArray(parsed.assets) ? parsed : { version: 1, assets: [] };
    } catch {
      this.index = { version: 1, assets: [] };
    }
    return this.index;
  }

  private save(mutate: (idx: MediaIndex) => void): Promise<void> {
    const run = this.chain.then(async () => {
      const idx = await this.load();
      mutate(idx);
      await fs.mkdir(this.dir, { recursive: true });
      await writeFileAtomic(path.join(this.dir, 'index.json'), JSON.stringify(idx, null, 1));
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<(MediaRecord & { missing: boolean })[]> {
    const idx = await this.load();
    return Promise.all(
      idx.assets.map(async (r) => ({
        ...r,
        missing: !(await fs.stat(this.fileOf(r)).then(
          (s) => s.isFile(),
          () => false,
        )),
      })),
    );
  }

  async get(id: string): Promise<MediaRecord> {
    const r = (await this.load()).assets.find((a) => a.id === id);
    if (!r) throw new StudioError('not-found', 'That media is not in this project’s library.');
    return r;
  }

  /** Copy a file into the store while hashing it. */
  private async ingest(source: string): Promise<{ sha256: string; size: number; tmp: string }> {
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile()) throw new StudioError('not-found', `${path.basename(source)} could not be found.`);
    if (stat.size > MAX_IMPORT_BYTES) throw new StudioError('too-large', `${path.basename(source)} is larger than 50 GB.`);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.import-${randomUUID()}`);
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(
      createReadStream(source),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      }),
      createWriteStream(tmp),
    );
    return { sha256: hash.digest('hex'), size, tmp };
  }

  /** Import bytes produced in the app (generated media), with provenance. */
  async importBytes(bytes: Buffer, name: string, provenance: MediaProvenance, tags: string[] = []): Promise<MediaRecord> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.bytes-${randomUUID()}${path.extname(name)}`);
    await fs.writeFile(tmp, bytes);
    try {
      return await this.importFile(tmp, name, provenance, tags);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  /** Import a file under a chosen name, recording where it came from. */
  async importFile(source: string, name: string, provenance: MediaProvenance, tags: string[] = []): Promise<MediaRecord> {
    const rec = await this.import(source, name);
    await this.save((idx) => {
      const x = idx.assets.find((a) => a.id === rec.id);
      if (x) {
        x.provenance ??= provenance;
        x.tags = [...new Set([...(x.tags ?? []), ...tags])];
      }
    });
    return (await this.load()).assets.find((a) => a.id === rec.id)!;
  }

  async setTags(id: string, tags: string[]): Promise<MediaRecord> {
    await this.get(id);
    const clean = [...new Set(tags.map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 30);
    await this.save((idx) => {
      const x = idx.assets.find((a) => a.id === id);
      if (x) x.tags = clean;
    });
    this.onChange();
    return this.get(id);
  }

  private transcriptFile(assetId: string): string {
    return path.join(this.dir, 'transcripts', `${assetId}.json`);
  }

  async saveTranscript(t: TranscriptView): Promise<void> {
    await fs.mkdir(path.dirname(this.transcriptFile(t.assetId)), { recursive: true });
    await writeFileAtomic(this.transcriptFile(t.assetId), JSON.stringify(t, null, 1));
    await this.save((idx) => {
      const x = idx.assets.find((a) => a.id === t.assetId);
      if (x) x.transcriptJobId = t.jobId;
    });
    this.onChange();
  }

  async transcript(assetId: string): Promise<TranscriptView | null> {
    try {
      return JSON.parse(await fs.readFile(this.transcriptFile(assetId), 'utf8')) as TranscriptView;
    } catch {
      return null;
    }
  }

  /** Import a file. Importing the same content twice returns the existing asset. */
  async import(source: string, displayName?: string): Promise<MediaRecord> {
    const { sha256, size, tmp } = await this.ingest(source);
    try {
      const existing = (await this.load()).assets.find((a) => a.sha256 === sha256);
      if (existing) {
        // Restore the stored file if it had gone missing.
        await fs.mkdir(path.dirname(this.fileOf(existing)), { recursive: true });
        if (!(await exists(this.fileOf(existing)))) await fs.rename(tmp, this.fileOf(existing));
        return existing;
      }
      const ext = path.extname(displayName ?? source).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
      const asFont = FONT_EXT.has(ext) ? await fontProbe(tmp) : null;
      if (FONT_EXT.has(ext) && !asFont) throw new StudioError('unsupported-media', `${displayName ?? path.basename(source)} is not a font file this app can read.`);
      const { probe, kind } = asFont ? { probe: asFont, kind: 'font' as const } : await probeFile(this.tools(), tmp);
      const record: MediaRecord = {
        id: `m-${sha256.slice(0, 12)}`,
        name: (displayName ?? path.basename(source)).slice(0, 200),
        kind,
        sha256,
        ext,
        size,
        importedAt: new Date().toISOString(),
        probe,
        proxy: probe.playable || kind === 'font' ? 'none' : 'needed',
      };
      const final = this.fileOf(record);
      await fs.mkdir(path.dirname(final), { recursive: true });
      await fs.rename(tmp, final);
      await this.save((idx) => {
        if (!idx.assets.some((a) => a.id === record.id)) idx.assets.push(record);
      });
      void this.derive(record).catch(() => undefined);
      return record;
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  /**
   * Point a missing asset at a file again. The same content restores it as it was; a different
   * file is accepted if it is the same kind of media and about as long (so clip in and out points
   * still make sense), and replaces the asset for every clip that uses it.
   */
  async relink(id: string, source: string): Promise<{ record: MediaRecord; sameContent: boolean }> {
    const current = await this.get(id);
    const { sha256, size, tmp } = await this.ingest(source);
    try {
      if (sha256 === current.sha256) {
        await fs.mkdir(path.dirname(this.fileOf(current)), { recursive: true });
        await fs.rename(tmp, this.fileOf(current));
        this.onChange();
        return { record: current, sameContent: true };
      }
      const asFont = current.kind === 'font' ? await fontProbe(tmp) : null;
      if (current.kind === 'font' && !asFont) throw new StudioError('relink-mismatch', `That file is not a font, but ${current.name} was.`);
      const { probe, kind } = asFont ? { probe: asFont, kind: 'font' as const } : await probeFile(this.tools(), tmp);
      if (kind !== current.kind) throw new StudioError('relink-mismatch', `That file is ${kind === 'image' ? 'an image' : kind}, but ${current.name} was ${current.kind === 'image' ? 'an image' : current.kind === 'font' ? 'a font' : current.kind}.`);
      const a = current.probe.durationSeconds;
      const b = probe.durationSeconds;
      if (a !== null && b !== null && b + 0.5 < a) throw new StudioError('relink-mismatch', `That file is ${b.toFixed(1)} s long, shorter than ${current.name} (${a.toFixed(1)} s), so some clips would point past its end.`);
      const ext = path.extname(source).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
      const next: MediaRecord = { ...current, sha256, size, ext, probe, proxy: probe.playable || kind === 'font' ? 'none' : 'needed', name: path.basename(source).slice(0, 200) };
      await fs.mkdir(path.dirname(this.fileOf(next)), { recursive: true });
      await fs.rename(tmp, this.fileOf(next));
      await this.save((idx) => {
        const i = idx.assets.findIndex((x) => x.id === id);
        if (i >= 0) idx.assets[i] = next;
      });
      void this.derive(next).catch(() => undefined);
      this.onChange();
      return { record: next, sameContent: false };
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  /** Thumbnail, strip, waveform and (when needed) a proxy. Safe to call repeatedly. */
  derive(r: MediaRecord): Promise<void> {
    const key = r.sha256;
    const running = this.derivations.get(key);
    if (running) return running;
    const job = heavyWork.run(async () => {
      const dir = this.derivedDir(r);
      await fs.mkdir(dir, { recursive: true });
      const src = this.fileOf(r);
      const { ffmpeg } = this.tools();
      const d = r.probe.durationSeconds ?? 0;
      // Only announce a change when something new was made (listing media calls this too).
      let made = false;
      if (r.kind === 'font') return;
      if (r.kind !== 'audio' && !(await exists(path.join(dir, 'thumb.jpg')))) {
        made = true;
        const at = r.kind === 'video' ? Math.min(1, d / 3) : 0;
        await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...(r.kind === 'video' ? ['-ss', at.toFixed(3)] : []), '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', path.join(dir, 'thumb.jpg')]);
      }
      if (r.kind === 'video' && d > 0 && !(await exists(path.join(dir, 'strip.jpg')))) {
        made = true;
        const rate = Math.max(STRIP_FRAMES / d, 0.0001);
        await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', src, '-vf', `fps=${rate.toFixed(6)},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=${STRIP_FRAMES}x1`, '-frames:v', '1', '-q:v', '5', path.join(dir, 'strip.jpg')]);
      }
      if (r.probe.hasAudio && r.kind !== 'image' && !(await exists(path.join(dir, 'waveform.json')))) {
        made = true;
        await this.computeWaveform(r);
      }
      // A proxy marked ready whose file was removed (cache cleanup) is simply made again.
      if (r.proxy === 'needed' || (r.proxy === 'ready' && !(await exists(path.join(dir, 'proxy.mp4'))))) {
        made = true;
        const out = path.join(dir, 'proxy.mp4');
        const res = await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', src, ...(r.probe.hasVideo ? ['-vf', 'scale=-2:540', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p'] : ['-vn']), ...(r.probe.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']), '-movflags', '+faststart', out]);
        await this.save((idx) => {
          const x = idx.assets.find((a) => a.id === r.id);
          if (x) x.proxy = res.code === 0 ? 'ready' : 'failed';
        });
      }
      if (made) this.onChange();
    }).finally(() => this.derivations.delete(key));
    this.derivations.set(key, job);
    return job;
  }

  private async computeWaveform(r: MediaRecord): Promise<WaveformView> {
    const rate = 8000;
    const duration = r.probe.durationSeconds ?? 0;
    const bucketSeconds = Math.max(0.02, duration / 6000);
    const per = Math.max(1, Math.round(rate * bucketSeconds));
    const peaks: number[] = [];
    let current = 0;
    let count = 0;
    let carry: Buffer | null = null;
    await runTool(this.tools().ffmpeg, ['-hide_banner', '-nostdin', '-i', this.fileOf(r), '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', '-'], {
      onStdout: (chunk) => {
        const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
        const usable = buf.length - (buf.length % 2);
        for (let i = 0; i < usable; i += 2) {
          const v = Math.abs(buf.readInt16LE(i)) / 32768;
          if (v > current) current = v;
          if (++count >= per) {
            peaks.push(Math.round(current * 1000) / 1000);
            current = 0;
            count = 0;
          }
        }
        carry = usable < buf.length ? buf.subarray(usable) : null;
      },
    });
    if (count > 0) peaks.push(Math.round(current * 1000) / 1000);
    const view: WaveformView = { assetId: r.id, peaks, bucketSeconds: per / rate };
    await writeFileAtomic(path.join(this.derivedDir(r), 'waveform.json'), JSON.stringify(view));
    return view;
  }

  async waveform(id: string): Promise<WaveformView> {
    const r = await this.get(id);
    if (!r.probe.hasAudio) return { assetId: id, peaks: [], bucketSeconds: 1 };
    try {
      const v = JSON.parse(await fs.readFile(path.join(this.derivedDir(r), 'waveform.json'), 'utf8')) as WaveformView;
      return { ...v, assetId: id };
    } catch {
      await fs.mkdir(this.derivedDir(r), { recursive: true });
      return { ...(await heavyWork.run(() => this.computeWaveform(r))), assetId: id };
    }
  }

  /** Which preview pictures exist yet; until then the UI shows an icon instead of a broken image. */
  async previews(r: MediaRecord): Promise<{ thumb: boolean; strip: boolean }> {
    const dir = this.derivedDir(r);
    const [thumb, strip] = await Promise.all([r.kind === 'video' || r.kind === 'image' ? exists(path.join(dir, 'thumb.jpg')) : false, r.kind === 'video' ? exists(path.join(dir, 'strip.jpg')) : false]);
    return { thumb, strip };
  }

  /** Absolute path of a playable or derived file, or null if it does not exist (yet). */
  async filePath(id: string, variant: 'original' | 'play' | 'thumb' | 'strip'): Promise<{ path: string; mime: string } | null> {
    const r = await this.get(id);
    const candidates: [string, string][] = [];
    if (variant === 'thumb') candidates.push([path.join(this.derivedDir(r), 'thumb.jpg'), 'image/jpeg']);
    else if (variant === 'strip') candidates.push([path.join(this.derivedDir(r), 'strip.jpg'), 'image/jpeg']);
    else {
      if (variant === 'play' && r.proxy === 'ready') candidates.push([path.join(this.derivedDir(r), 'proxy.mp4'), 'video/mp4']);
      candidates.push([this.fileOf(r), mimeFor(r)]);
    }
    for (const [p, mime] of candidates) if (await exists(p)) return { path: p, mime };
    return null;
  }
}

export function mimeFor(r: Pick<MediaRecord, 'ext' | 'kind'>): string {
  const map: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
  return map[r.ext] ?? (r.kind === 'audio' ? 'audio/mpeg' : r.kind === 'image' ? 'image/png' : r.kind === 'font' ? 'font/ttf' : 'video/mp4');
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}
