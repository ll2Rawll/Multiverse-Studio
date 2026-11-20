/**
 * AI and analysis-based timeline editing.
 *
 * Every edit is planned as a list of ordinary timeline commands (split, delete, add text, set
 * volume…), applied to an in-memory copy first so each step is validated, and shown as a proposal.
 * Applying it creates a checkpoint and runs the steps as one `video.batch` command, so the whole
 * edit undoes in one step and every cut, caption and volume change stays editable afterwards.
 *
 * Local analysis needs no model: pauses come from FFmpeg's silencedetect, captions from a saved
 * transcript, ducking from transcript timings (or detected speech). A language model is only used
 * for free-form instructions; it sees a text description of the timeline, never media files.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { StudioError } from '../engine/errors';
import { writeFileAtomic } from '../engine/store/atomic';
import { ProviderError } from '../ai/errors';
import type { AiService, ResolvedRoute } from '../ai/service';
import type { ChatMessage, JsonSchema, ToolSpec } from '../ai/types';
import { heavyWork, runTool } from './ffmpeg';
import { applyVideoCommand, parseSequence, sequencePath } from './sequence';
import type { VideoService } from './service';
import type { FileTexts } from '../commands/commands';
import { TICKS_PER_SECOND, clipDuration, clipEnd, sequenceDuration, type MediaAssetView, type MediaClip, type Sequence, type TextClip } from '../shared/video';
import type { TimelineProposalView, TranscriptView } from '../shared/media';

export type { TimelineProposalView };

export interface Step {
  name: string;
  args: Record<string, unknown>;
}

export interface Proposal extends TimelineProposalView {
  projectId: string;
  lineId: string;
  baseHash: string;
  stepList: Step[];
}

const T = TICKS_PER_SECOND;
const secs = (t: number): number => Math.round((t / T) * 100) / 100;
const ticks = (s: number): number => Math.max(0, Math.round(s * T));
let counter = 0;
const uid = (p: string): string => `${p}-${Date.now().toString(36).slice(-4)}${(counter++).toString(36)}${randomUUID().slice(0, 3)}`;

/* ---------------- local analysis ---------------- */

export async function detectSilences(ffmpeg: string, file: string, opts: { noiseDb: number; minSeconds: number }, signal?: AbortSignal): Promise<[number, number][]> {
  const r = await heavyWork.run(() => runTool(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', `silencedetect=noise=${opts.noiseDb}dB:d=${opts.minSeconds}`, '-f', 'null', '-'], { signal }));
  const out: [number, number][] = [];
  let start: number | null = null;
  for (const line of r.stderr.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push([start, Number(e[1])]);
      start = null;
    }
  }
  if (start !== null) out.push([start, Number.POSITIVE_INFINITY]);
  return out;
}

/* ---------------- planners (pure) ---------------- */

/** Cut silent stretches out of the clips on one track and close the gaps on that track. */
export function planRemovePauses(seq: Sequence, trackId: string, silences: Map<string, [number, number][]>, opts: { minPause: number; keep: number }): { steps: Step[]; removed: number; warnings: string[] } {
  const track = seq.tracks.find((t) => t.id === trackId);
  if (!track) throw new StudioError('not-found', 'That track no longer exists.');
  const steps: Step[] = [];
  let removed = 0;
  const clips = track.clips.filter((c): c is MediaClip => c.type === 'media').sort((a, b) => b.start - a.start);
  for (const clip of clips) {
    const ranges = (silences.get(clip.assetId) ?? [])
      .map(([s, e]) => [Math.max(s + opts.keep, clip.in / T + 0.05), Math.min(e - opts.keep, clip.out / T - 0.05)] as [number, number])
      .filter(([s, e]) => e - s >= opts.minPause)
      .sort((a, b) => b[0] - a[0]);
    let current = clip.id;
    for (const [s, e] of ranges) {
      const at = (src: number): number => clip.start + Math.round(((src * T - clip.in) / clip.speed) as number);
      const cutStart = at(s);
      const cutEnd = at(e);
      if (cutEnd - cutStart < T / 10) continue;
      const mid = uid('cut');
      const right = uid('c');
      // Process from the end of the clip so earlier positions stay valid.
      steps.push({ name: 'video.splitClip', args: { clipId: current, at: cutEnd, newClipId: right } });
      steps.push({ name: 'video.splitClip', args: { clipId: current, at: cutStart, newClipId: mid } });
      steps.push({ name: 'video.deleteClips', args: { clipIds: [mid], ripple: true } });
      removed += (cutEnd - cutStart) / T;
    }
    current = clip.id;
  }
  const warnings = seq.tracks.some((t) => t.id !== trackId && t.clips.length) ? [`Only ${track.name} moves to close the gaps; clips on other tracks keep their times.`] : [];
  return { steps, removed, warnings };
}

/** Words grouped into captions of at most `maxChars`, timed in proportion to their length. */
function chunkSegment(text: string, start: number, end: number, maxChars: number): { text: string; start: number; end: number }[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) {
      chunks.push(line);
      line = w;
    } else line = (line + ' ' + w).trim();
  }
  if (line) chunks.push(line);
  const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
  let t = start;
  return chunks.map((c) => {
    const d = ((end - start) * c.length) / total;
    const out = { text: c, start: t, end: t + d };
    t += d;
    return out;
  });
}

/** Captions from saved transcripts for every clip that uses transcribed media. */
export function planCaptions(seq: Sequence, transcripts: Map<string, TranscriptView>, opts: { maxChars: number }): { steps: Step[]; count: number; warnings: string[] } {
  const steps: Step[] = [];
  const warnings: string[] = [];
  let track = seq.tracks.find((t) => t.kind === 'text' && /caption/i.test(t.name));
  const trackId = track?.id ?? 'captions';
  if (!track) {
    if (seq.tracks.some((t) => t.id === 'captions')) throw new StudioError('invalid', 'A track named “captions” already exists but is not a titles track.');
    steps.push({ name: 'video.addTrack', args: { kind: 'text', trackId } });
    steps.push({ name: 'video.setTrack', args: { trackId, patch: { name: 'Captions' } } });
  }
  const H = seq.settings.height;
  const size = Math.max(24, Math.round(Math.min(seq.settings.width, H) * 0.05));
  const placed: [number, number][] = (track?.clips ?? []).map((c) => [c.start, clipEnd(c)]);
  let count = 0;
  for (const t of seq.tracks) {
    if (t.kind === 'text') continue;
    for (const clip of t.clips) {
      if (clip.type !== 'media') continue;
      const tr = transcripts.get(clip.assetId);
      if (!tr) continue;
      for (const seg of tr.segments) {
        const s = Math.max(seg.start, clip.in / T);
        const e = Math.min(seg.end, clip.out / T);
        if (e - s < 0.2) continue;
        const tl = (src: number): number => clip.start + Math.round(((src * T - clip.in) / clip.speed) as number);
        for (const c of chunkSegment(seg.text, tl(s), tl(e), opts.maxChars)) {
          let a = Math.round(c.start);
          const b = Math.round(c.end);
          for (const [ps, pe] of placed) if (a < pe && b > ps) a = Math.max(a, pe);
          if (b - a < T / 5) continue;
          placed.push([a, b]);
          steps.push({
            name: 'video.addText',
            args: { trackId, start: a, duration: b - a, text: c.text, clipId: uid('cap'), style: { fontSize: size, x: 0.5, y: 0.88, align: 'center', box: true, boxColor: '#000000', weight: 'semibold', color: '#ffffff' } },
          });
          count++;
        }
      }
    }
  }
  if (!count) warnings.push('No clip on this timeline uses media that has been transcribed. Transcribe a clip’s media first.');
  return { steps, count, warnings };
}

/** Lower the volume of clips on one track while someone is speaking. */
export function planDuck(seq: Sequence, musicTrackId: string, speech: [number, number][], level: number): { steps: Step[]; parts: number; warnings: string[] } {
  const track = seq.tracks.find((t) => t.id === musicTrackId);
  if (!track) throw new StudioError('not-found', 'That track no longer exists.');
  const steps: Step[] = [];
  let parts = 0;
  const ranges = mergeRanges(speech.map(([a, b]) => [ticks(a), ticks(b)] as [number, number]));
  for (const clip of [...track.clips].filter((c): c is MediaClip => c.type === 'media').sort((a, b) => b.start - a.start)) {
    const start = clip.start;
    const end = clipEnd(clip);
    const inside = ranges.map(([a, b]) => [Math.max(a, start), Math.min(b, end)] as [number, number]).filter(([a, b]) => b - a > T / 4);
    if (!inside.length) continue;
    // Cut points, latest first, so ids stay valid: each split leaves `clip.id` as the left part.
    const cuts = [...new Set(inside.flat().filter((t) => t > start + T / 20 && t < end - T / 20))].sort((a, b) => b - a);
    const pieces: { id: string; from: number }[] = [];
    for (const at of cuts) {
      const id = uid('duck');
      steps.push({ name: 'video.splitClip', args: { clipId: clip.id, at, newClipId: id } });
      pieces.push({ id, from: at });
    }
    pieces.push({ id: clip.id, from: start });
    for (const p of pieces) {
      if (inside.some(([a, b]) => p.from >= a - T / 20 && p.from < b)) {
        steps.push({ name: 'video.setClip', args: { clipId: p.id, patch: { volume: Math.round(clip.volume * level * 100) / 100 } } });
        parts++;
      }
    }
  }
  return { steps, parts, warnings: parts ? [] : ['There is no speech over the clips on that track.'] };
}

function mergeRanges(r: [number, number][]): [number, number][] {
  const s = [...r].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1] + T / 2) last[1] = Math.max(last[1], x[1]);
    else out.push([...x]);
  }
  return out;
}

/** End the edit at about `target` seconds: drop what starts after it, trim what crosses it. */
export function planTrimTo(seq: Sequence, target: number): { steps: Step[]; warnings: string[] } {
  const end = ticks(target);
  const steps: Step[] = [];
  const drop: string[] = [];
  for (const t of seq.tracks) {
    for (const c of t.clips) {
      if (c.start >= end) drop.push(c.id);
      else if (clipEnd(c) > end) steps.push({ name: 'video.trimClip', args: { clipId: c.id, edge: 'end', at: end } });
    }
  }
  if (drop.length) steps.unshift({ name: 'video.deleteClips', args: { clipIds: drop } });
  return { steps, warnings: sequenceDuration(seq) <= end ? ['The sequence is already that short.'] : [] };
}

/** Speech ranges on the timeline, from transcripts of the clips on one track. */
export function speechFromTranscripts(seq: Sequence, trackIds: string[], transcripts: Map<string, TranscriptView>): [number, number][] {
  const out: [number, number][] = [];
  for (const t of seq.tracks) {
    if (!trackIds.includes(t.id)) continue;
    for (const c of t.clips) {
      if (c.type !== 'media') continue;
      const tr = transcripts.get(c.assetId);
      for (const seg of tr?.segments ?? []) {
        const s = Math.max(seg.start, c.in / T);
        const e = Math.min(seg.end, c.out / T);
        if (e > s) out.push([(c.start + (s * T - c.in) / c.speed) / T, (c.start + (e * T - c.in) / c.speed) / T]);
      }
    }
  }
  return out;
}

/** Speech ranges from audio level when there is no transcript: everything that is not silence. */
export function speechFromSilences(seq: Sequence, trackIds: string[], silences: Map<string, [number, number][]>): [number, number][] {
  const out: [number, number][] = [];
  for (const t of seq.tracks) {
    if (!trackIds.includes(t.id)) continue;
    for (const c of t.clips) {
      if (c.type !== 'media') continue;
      let cursor = c.in / T;
      const ends = c.out / T;
      const toTl = (src: number): number => (c.start + (src * T - c.in) / c.speed) / T;
      for (const [s, e] of [...(silences.get(c.assetId) ?? [])].sort((a, b) => a[0] - b[0])) {
        if (e <= cursor || s >= ends) continue;
        if (s > cursor) out.push([toTl(cursor), toTl(Math.min(s, ends))]);
        cursor = Math.max(cursor, e);
      }
      if (cursor < ends) out.push([toTl(cursor), toTl(ends)]);
    }
  }
  return out;
}

/* ---------------- describing a timeline for a model ---------------- */

export function describeSequence(seq: Sequence, media: Map<string, MediaAssetView>, transcripts: Map<string, TranscriptView>): string {
  const lines: string[] = [];
  lines.push(`Sequence "${seq.name}" (id ${seq.id}), ${seq.settings.width}x${seq.settings.height}, ${secs(sequenceDuration(seq))} s long.`);
  for (const t of seq.tracks) {
    lines.push(`Track ${t.id} (${t.kind}, "${t.name}"${t.muted ? ', muted' : ''}${t.hidden ? ', hidden' : ''}${t.locked ? ', locked' : ''}):`);
    for (const c of t.clips) {
      if (c.type === 'text') lines.push(`  - text ${c.id}: ${secs(c.start)}–${secs(clipEnd(c))} s "${c.text.slice(0, 80)}"${c.template ? ` (${c.template})` : ''}`);
      else {
        const a = media.get(c.assetId);
        lines.push(`  - clip ${c.id}: ${secs(c.start)}–${secs(clipEnd(c))} s, ${a?.name ?? c.assetId} [${a?.kind ?? '?'}] source ${secs(c.in)}–${secs(c.out)} s${c.speed !== 1 ? `, ${c.speed}x` : ''}${c.volume !== 1 ? `, volume ${Math.round(c.volume * 100)}%` : ''}${c.muted ? ', muted' : ''}`);
      }
    }
  }
  const usable = [...media.values()].filter((m) => m.status === 'ready');
  if (usable.length) {
    lines.push('Media in the library (use these ids with add_clip):');
    for (const m of usable.slice(0, 60)) lines.push(`  - ${m.id}: ${m.name} [${m.kind}]${m.probe.durationSeconds ? ` ${secs(ticks(m.probe.durationSeconds))} s` : ''}${m.hasTranscript ? ', transcribed' : ''}`);
  }
  for (const [id, tr] of transcripts) {
    const text = tr.segments.map((s) => `[${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`).join(' ');
    lines.push(`Transcript of ${media.get(id)?.name ?? id} (source seconds): ${text.slice(0, 6000)}`);
  }
  return lines.join('\n');
}

const SYSTEM = `You edit a video timeline in Multiverse Studio by calling tools. Each tool is a validated timeline operation; you will get the result or an error after each call.
Times are in seconds on the timeline unless a tool says "source". Clips on one track never overlap.
Prefer the high-level tools (remove_pauses, add_captions, duck_music, trim_to_length, create_portrait_version) when they fit the request.
Use only clip, track and asset ids that appear in the timeline description. Never invent media.
When the edit is complete, call finish with a one-sentence summary of what you changed. Do not ask questions.`;

const num: JsonSchema = { type: 'number' };
const str: JsonSchema = { type: 'string' };
const TOOLS: ToolSpec[] = [
  { name: 'split_clip', description: 'Split a clip at a timeline time.', parameters: { type: 'object', properties: { clip_id: str, at_seconds: num }, required: ['clip_id', 'at_seconds'] } },
  { name: 'delete_clips', description: 'Delete clips. close_gap moves later clips on the same track left.', parameters: { type: 'object', properties: { clip_ids: { type: 'array', items: str }, close_gap: { type: 'boolean' } }, required: ['clip_ids'] } },
  { name: 'move_clip', description: 'Move a clip to a new start time, optionally to another track of the same kind.', parameters: { type: 'object', properties: { clip_id: str, start_seconds: num, track_id: str }, required: ['clip_id', 'start_seconds'] } },
  { name: 'trim_clip', description: 'Move the start or end edge of a clip to a timeline time.', parameters: { type: 'object', properties: { clip_id: str, edge: { type: 'string', enum: ['start', 'end'] }, at_seconds: num }, required: ['clip_id', 'edge', 'at_seconds'] } },
  {
    name: 'set_clip',
    description: 'Change a clip: volume (0–2), muted, speed (0.25–4), fades, transition into it, position (pixels from centre), scale, rotation, opacity; for titles also text, subtitle, colour, size and layout.',
    parameters: {
      type: 'object',
      properties: {
        clip_id: str,
        volume: num,
        muted: { type: 'boolean' },
        speed: num,
        fade_in_seconds: num,
        fade_out_seconds: num,
        transition_in: { type: 'string', enum: ['none', 'crossfade', 'dip'] },
        transition_seconds: num,
        x: num,
        y: num,
        scale: num,
        rotation: num,
        opacity: num,
        text: str,
        subtitle: str,
        color: str,
        font_size: num,
        template: { type: 'string', enum: ['plain', 'title-card', 'lower-third', 'end-card'] },
      },
      required: ['clip_id'],
    },
  },
  {
    name: 'add_text',
    description: 'Add a title. template: plain title, title-card (full-frame card), lower-third (name bar), end-card.',
    parameters: { type: 'object', properties: { text: str, subtitle: str, start_seconds: num, duration_seconds: num, template: { type: 'string', enum: ['plain', 'title-card', 'lower-third', 'end-card'] }, track_id: str }, required: ['text', 'start_seconds', 'duration_seconds'] },
  },
  { name: 'add_clip', description: 'Put library media on the timeline (appends to the end of a matching track when start is omitted).', parameters: { type: 'object', properties: { asset_id: str, start_seconds: num, track_id: str, source_in_seconds: num, source_out_seconds: num }, required: ['asset_id'] } },
  { name: 'add_track', description: 'Add a video, audio or titles track.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['video', 'audio', 'text'] } }, required: ['kind'] } },
  { name: 'set_track', description: 'Mute, hide or change the volume of a track.', parameters: { type: 'object', properties: { track_id: str, muted: { type: 'boolean' }, hidden: { type: 'boolean' }, volume: num }, required: ['track_id'] } },
  { name: 'remove_pauses', description: 'Cut silent pauses out of the clips on one track (by audio level) and close the gaps.', parameters: { type: 'object', properties: { track_id: str, min_pause_seconds: num }, required: ['track_id'] } },
  { name: 'add_captions', description: 'Add captions from the transcripts of transcribed media.', parameters: { type: 'object', properties: {} } },
  { name: 'duck_music', description: 'Lower the volume of a music track while people speak on other tracks.', parameters: { type: 'object', properties: { music_track_id: str, level: num }, required: ['music_track_id'] } },
  { name: 'trim_to_length', description: 'End the edit at about this length by dropping and trimming the end.', parameters: { type: 'object', properties: { seconds: num }, required: ['seconds'] } },
  { name: 'create_portrait_version', description: 'Make a 9:16 copy of this sequence with pictures reframed to fill the frame.', parameters: { type: 'object', properties: { name: str }, required: [] } },
  { name: 'finish', description: 'The edit is complete.', parameters: { type: 'object', properties: { summary: str }, required: ['summary'] } },
];

/* ---------------- service ---------------- */

export interface TimelineAiHost {
  ai(): AiService | null;
  video: VideoService;
  readFiles(projectId: string, lineId: string, paths: string[]): Promise<FileTexts>;
}

export class TimelineAi {
  private readonly proposals = new Map<string, Proposal>();

  constructor(private readonly host: TimelineAiHost) {}

  private async context(projectId: string, lineId: string, sequenceId: string): Promise<{ seq: Sequence; hash: string; media: Map<string, MediaAssetView>; transcripts: Map<string, TranscriptView> }> {
    const { sequence, hash } = await this.host.video.sequence(projectId, lineId, sequenceId);
    const list = await this.host.video.listMedia(projectId, lineId);
    const media = new Map(list.map((m) => [m.id, m]));
    const store = await this.host.video.store(projectId);
    const transcripts = new Map<string, TranscriptView>();
    const used = new Set(sequence.tracks.flatMap((t) => t.clips.filter((c): c is MediaClip => c.type === 'media').map((c) => c.assetId)));
    for (const id of used) {
      const tr = await store.transcript(id);
      if (tr) transcripts.set(id, tr);
    }
    return { seq: sequence, hash, media, transcripts };
  }

  private async silences(projectId: string, assetIds: string[], minSeconds: number): Promise<Map<string, [number, number][]>> {
    const store = await this.host.video.store(projectId);
    const out = new Map<string, [number, number][]>();
    for (const id of new Set(assetIds)) {
      const rec = await store.get(id);
      if (!rec.probe.hasAudio) continue;
      const cache = path.join(store.derivedDir(rec), `silence-35-${minSeconds}.json`);
      let ranges: [number, number][] | null = null;
      try {
        ranges = JSON.parse(await fs.readFile(cache, 'utf8')) as [number, number][];
      } catch {
        const file = (await store.filePath(id, 'original'))?.path;
        if (!file) continue;
        ranges = (await detectSilences(this.host.video.tools().ffmpeg, file, { noiseDb: -35, minSeconds })).map(([s, e]) => [s, Number.isFinite(e) ? e : (rec.probe.durationSeconds ?? s)] as [number, number]);
        await fs.mkdir(path.dirname(cache), { recursive: true });
        await writeFileAtomic(cache, JSON.stringify(ranges));
      }
      out.set(id, ranges);
    }
    return out;
  }

  /** Turn a high-level request into concrete steps, using local analysis. */
  private async expand(projectId: string, seq: Sequence, media: Map<string, MediaAssetView>, transcripts: Map<string, TranscriptView>, op: string, opts: Record<string, unknown>): Promise<{ steps: Step[]; note: string; warnings: string[] }> {
    if (op === 'remove-pauses') {
      const trackId = String(opts.trackId ?? seq.tracks.find((t) => t.kind !== 'text' && t.clips.some((c) => c.type === 'media' && media.get(c.assetId)?.probe.hasAudio))?.id ?? '');
      if (!trackId) throw new StudioError('invalid', 'No track has clips with sound.');
      const track = seq.tracks.find((t) => t.id === trackId);
      const minPause = Math.max(0.3, Math.min(10, Number(opts.minPause ?? 0.7)));
      const sil = await this.silences(projectId, (track?.clips ?? []).filter((c): c is MediaClip => c.type === 'media').map((c) => c.assetId), Math.max(0.25, minPause - 0.2));
      const r = planRemovePauses(seq, trackId, sil, { minPause, keep: 0.12 });
      return { steps: r.steps, note: r.removed ? `Remove ${Math.round(r.removed * 10) / 10} s of pauses from ${track?.name}` : `No pauses longer than ${minPause} s on ${track?.name}`, warnings: r.warnings };
    }
    if (op === 'captions') {
      const r = planCaptions(seq, transcripts, { maxChars: Number(opts.maxChars ?? 42) });
      return { steps: r.steps, note: `Add ${r.count} caption${r.count === 1 ? '' : 's'} from the transcript`, warnings: r.warnings };
    }
    if (op === 'duck') {
      const musicTrackId = String(opts.musicTrackId ?? seq.tracks.filter((t) => t.kind === 'audio').slice(-1)[0]?.id ?? '');
      if (!musicTrackId) throw new StudioError('invalid', 'There is no audio track to lower.');
      const speechTracks = seq.tracks.filter((t) => t.kind !== 'text' && t.id !== musicTrackId).map((t) => t.id);
      let speech = speechFromTranscripts(seq, speechTracks, transcripts);
      let how = 'transcript timings';
      if (!speech.length) {
        const ids = seq.tracks.filter((t) => speechTracks.includes(t.id)).flatMap((t) => t.clips.filter((c): c is MediaClip => c.type === 'media').map((c) => c.assetId));
        speech = speechFromSilences(seq, speechTracks, await this.silences(projectId, ids, 0.5));
        how = 'detected speech';
      }
      const level = Math.max(0.05, Math.min(0.9, Number(opts.level ?? 0.3)));
      const r = planDuck(seq, musicTrackId, speech, level);
      return { steps: r.steps, note: `Lower ${seq.tracks.find((t) => t.id === musicTrackId)?.name} to ${Math.round(level * 100)}% during speech (${how}, ${r.parts} part${r.parts === 1 ? '' : 's'})`, warnings: r.warnings };
    }
    if (op === 'trim') {
      const r = planTrimTo(seq, Math.max(1, Number(opts.seconds ?? 30)));
      return { steps: r.steps, note: `End the edit at ${Number(opts.seconds ?? 30)} s`, warnings: r.warnings };
    }
    if (op === 'portrait') {
      const id = `${seq.id.slice(0, 50)}-portrait${opts.suffix ?? ''}`;
      const assets: Record<string, { width: number; height: number }> = {};
      for (const m of media.values()) if (m.probe.width && m.probe.height) assets[m.id] = Math.abs(m.probe.rotation) % 180 === 90 ? { width: m.probe.height, height: m.probe.width } : { width: m.probe.width, height: m.probe.height };
      const name = String(opts.name ?? `${seq.name} (portrait)`);
      return { steps: [{ name: 'video.duplicateSequence', args: { newSequence: id, name, settings: { width: 1080, height: 1920 }, reframe: 'fill', assets } }], note: `Create “${name}”, 1080×1920, pictures reframed to fill`, warnings: [] };
    }
    throw new StudioError('invalid', 'Unknown operation.');
  }

  private finalize(projectId: string, lineId: string, seq: Sequence, hash: string, files: FileTexts, steps: Step[], labels: string[], extra: Partial<TimelineProposalView>): TimelineProposalView {
    const after = parseSequence(files.get(sequencePath(seq.id))!);
    const newSequences = [...files.keys()].filter((p) => p !== sequencePath(seq.id) && files.get(p)).map((p) => parseSequence(files.get(p)!).name);
    const count = (s: Sequence): number => s.tracks.reduce((n, t) => n + t.clips.length, 0);
    const proposal: Proposal = {
      id: `p-${randomUUID().slice(0, 10)}`,
      projectId,
      lineId,
      baseHash: hash,
      stepList: steps,
      sequenceId: seq.id,
      sequenceName: seq.name,
      instruction: extra.instruction ?? '',
      summary: extra.summary ?? labels[0] ?? 'No changes',
      steps: labels,
      warnings: extra.warnings ?? [],
      before: { seconds: secs(sequenceDuration(seq)), clips: count(seq) },
      after: { seconds: secs(sequenceDuration(after)), clips: count(after) },
      newSequences,
      model: extra.model ?? null,
      usage: extra.usage ?? null,
      sent: extra.sent ?? [],
    };
    this.proposals.set(proposal.id, proposal);
    const { projectId: _p, lineId: _l, baseHash: _b, stepList: _s, ...view } = proposal;
    return view;
  }

  private simulate(start: FileTexts, steps: Step[], sequenceId: string): { files: FileTexts; labels: string[] } {
    let files = start;
    const labels: string[] = [];
    for (const s of steps) {
      const r = applyVideoCommand(files, s.name, { sequence: sequenceId, ...s.args });
      files = r.files;
      labels.push(r.label);
    }
    return { files, labels };
  }

  /** Analysis-based edits that need no model. */
  async analyze(projectId: string, lineId: string, sequenceId: string, op: string, opts: Record<string, unknown>): Promise<TimelineProposalView> {
    const { seq, hash, media, transcripts } = await this.context(projectId, lineId, sequenceId);
    const plan = await this.expand(projectId, seq, media, transcripts, op, opts);
    const start = await this.host.readFiles(projectId, lineId, [sequencePath(seq.id)]);
    const { files } = this.simulate(start, plan.steps, seq.id);
    return this.finalize(projectId, lineId, seq, hash, files, plan.steps, plan.steps.length ? [plan.note] : [], { instruction: plan.note, summary: plan.steps.length ? plan.note : `Nothing to change: ${plan.note.toLowerCase()}`, warnings: plan.warnings });
  }

  /** Free-form instruction: a model proposes tool calls; each is validated on a copy of the timeline. */
  async plan(projectId: string, lineId: string, sequenceId: string, instruction: string, signal: AbortSignal): Promise<TimelineProposalView> {
    const ai = this.host.ai();
    if (!ai) throw new StudioError('unavailable', 'AI is not available in this window.');
    let route: ResolvedRoute;
    try {
      // Timeline edits need tool calling: use the coding route (it falls back to the assistant's model).
      route = await ai.resolve('coding');
    } catch (error) {
      throw new StudioError('not-configured', (error as Error).message);
    }
    const { seq, hash, media, transcripts } = await this.context(projectId, lineId, sequenceId);
    let files = await this.host.readFiles(projectId, lineId, [sequencePath(seq.id)]);
    const steps: Step[] = [];
    const labels: string[] = [];
    const warnings: string[] = [];
    const description = describeSequence(seq, media, transcripts);
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: `${description}\n\nRequest: ${instruction}` }] }];
    let summary = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    for (let round = 0; round < 12 && !summary; round++) {
      const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
      let text = '';
      try {
        for await (const ev of ai.generate(route, { system: SYSTEM, messages, tools: TOOLS, maxOutputTokens: 4000 }, signal)) {
          if (ev.type === 'text') text += ev.delta;
          else if (ev.type === 'tool-call') calls.push({ id: ev.call.id, name: ev.call.name, args: (ev.call.args && typeof ev.call.args === 'object' ? ev.call.args : {}) as Record<string, unknown> });
          else if (ev.type === 'usage') {
            sawUsage = true;
            inputTokens += ev.inputTokens ?? 0;
            outputTokens += ev.outputTokens ?? 0;
          }
        }
      } catch (error) {
        if (error instanceof ProviderError) throw new StudioError('provider', `${error.message} ${error.help}`.trim());
        throw error;
      }
      if (!calls.length) {
        summary = text.trim().slice(0, 300) || 'The model made no changes.';
        break;
      }
      messages.push({ role: 'assistant', text, toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })) });
      for (const call of calls) {
        let result: string;
        if (call.name === 'finish') {
          summary = String(call.args.summary ?? 'Done').slice(0, 300);
          result = 'ok';
        } else {
          try {
            const cur = parseSequence(files.get(sequencePath(seq.id))!);
            const planned = await this.toSteps(projectId, cur, media, transcripts, call.name, call.args);
            const sim = this.simulate(files, planned.steps, seq.id);
            files = sim.files;
            steps.push(...planned.steps);
            labels.push(planned.label ?? sim.labels.join(', '));
            warnings.push(...planned.warnings);
            result = `ok: ${planned.label ?? sim.labels.join(', ')}. Timeline now ${secs(sequenceDuration(parseSequence(files.get(sequencePath(seq.id))!)))} s.`;
          } catch (error) {
            result = `error: ${(error as Error).message}`;
          }
        }
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result, isError: result.startsWith('error') });
      }
    }
    return this.finalize(projectId, lineId, seq, hash, files, steps, labels, {
      instruction,
      summary: summary || (steps.length ? 'Proposed edit' : 'No changes'),
      warnings: [...new Set(warnings)],
      model: route.model.label,
      usage: sawUsage ? { inputTokens, outputTokens } : { inputTokens: null, outputTokens: null },
      sent: [`A text description of “${seq.name}” (clip names, times, titles${transcripts.size ? ', transcript text' : ''}) and your request, to ${route.model.label} on ${route.connection.name}. No media files.`],
    });
  }

  /** Translate one model tool call into validated steps. */
  private async toSteps(projectId: string, seq: Sequence, media: Map<string, MediaAssetView>, transcripts: Map<string, TranscriptView>, name: string, a: Record<string, unknown>): Promise<{ steps: Step[]; label?: string; warnings: string[] }> {
    const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    // Name unknown ids plainly, so the model can correct itself from the description.
    const clipIds = new Set(seq.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    const trackIds = new Set(seq.tracks.map((t) => t.id));
    for (const id of [a.clip_id, ...(Array.isArray(a.clip_ids) ? a.clip_ids : [])]) if (id !== undefined && !clipIds.has(String(id))) throw new StudioError('not-found', `There is no clip with id “${String(id)}”. Use an id from the timeline description.`);
    for (const id of [a.track_id, a.music_track_id]) if (id !== undefined && !trackIds.has(String(id))) throw new StudioError('not-found', `There is no track with id “${String(id)}”.`);
    switch (name) {
      case 'split_clip':
        return { steps: [{ name: 'video.splitClip', args: { clipId: s(a.clip_id), at: ticks(n(a.at_seconds) ?? -1), newClipId: uid('c') } }], warnings: [] };
      case 'delete_clips':
        return { steps: [{ name: 'video.deleteClips', args: { clipIds: Array.isArray(a.clip_ids) ? a.clip_ids : [], ripple: Boolean(a.close_gap) } }], warnings: [] };
      case 'move_clip':
        return { steps: [{ name: 'video.moveClip', args: { clipId: s(a.clip_id), start: ticks(n(a.start_seconds) ?? 0), ...(s(a.track_id) ? { trackId: s(a.track_id) } : {}) } }], warnings: [] };
      case 'trim_clip': {
        const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === a.clip_id);
        const asset = clip?.type === 'media' ? media.get(clip.assetId) : undefined;
        return { steps: [{ name: 'video.trimClip', args: { clipId: s(a.clip_id), edge: a.edge === 'start' ? 'start' : 'end', at: ticks(n(a.at_seconds) ?? 0), sourceDuration: asset?.probe.durationSeconds ? ticks(asset.probe.durationSeconds) : null } }], warnings: [] };
      }
      case 'set_clip': {
        const patch: Record<string, unknown> = {};
        if (n(a.volume) !== undefined) patch.volume = n(a.volume);
        if (typeof a.muted === 'boolean') patch.muted = a.muted;
        if (n(a.speed) !== undefined) patch.speed = n(a.speed);
        if (n(a.fade_in_seconds) !== undefined) patch.fadeIn = ticks(n(a.fade_in_seconds)!);
        if (n(a.fade_out_seconds) !== undefined) patch.fadeOut = ticks(n(a.fade_out_seconds)!);
        if (a.transition_in === 'none') patch.transitionIn = null;
        else if (a.transition_in === 'crossfade' || a.transition_in === 'dip') patch.transitionIn = { kind: a.transition_in, duration: ticks(n(a.transition_seconds) ?? 0.5) };
        const tr: Record<string, number> = {};
        for (const k of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) if (n(a[k]) !== undefined) tr[k] = n(a[k])!;
        if (Object.keys(tr).length) patch.transform = tr;
        if (s(a.text)) patch.text = s(a.text);
        if (typeof a.subtitle === 'string') patch.subtitle = a.subtitle;
        if (s(a.template)) patch.template = s(a.template);
        const style: Record<string, unknown> = {};
        if (s(a.color)) style.color = s(a.color);
        if (n(a.font_size) !== undefined) style.fontSize = n(a.font_size);
        if (Object.keys(style).length) patch.style = style;
        return { steps: [{ name: 'video.setClip', args: { clipId: s(a.clip_id), patch } }], warnings: [] };
      }
      case 'add_text': {
        const textTrack = s(a.track_id) ?? seq.tracks.find((t) => t.kind === 'text' && !/caption/i.test(t.name))?.id;
        const steps: Step[] = [];
        let trackId = textTrack;
        if (!trackId) {
          trackId = uid('t');
          steps.push({ name: 'video.addTrack', args: { kind: 'text', trackId } });
        }
        steps.push({ name: 'video.addText', args: { trackId, start: ticks(n(a.start_seconds) ?? 0), duration: ticks(n(a.duration_seconds) ?? 3), text: String(a.text ?? '').slice(0, 500), clipId: uid('t'), ...(s(a.template) ? { template: s(a.template) } : {}), ...(s(a.subtitle) ? { subtitle: s(a.subtitle) } : {}) } });
        return { steps, warnings: [] };
      }
      case 'add_clip': {
        const asset = media.get(String(a.asset_id ?? ''));
        if (!asset || asset.status !== 'ready') throw new StudioError('not-found', `There is no usable media with id ${String(a.asset_id)}.`);
        const args: Record<string, unknown> = { assetId: asset.id, clipId: uid('c'), media: { kind: asset.kind, duration: asset.probe.durationSeconds === null ? null : ticks(asset.probe.durationSeconds) } };
        if (n(a.start_seconds) !== undefined) args.start = ticks(n(a.start_seconds)!);
        if (s(a.track_id)) args.trackId = s(a.track_id);
        if (n(a.source_in_seconds) !== undefined) args.in = ticks(n(a.source_in_seconds)!);
        if (n(a.source_out_seconds) !== undefined) args.out = ticks(n(a.source_out_seconds)!);
        return { steps: [{ name: 'video.addClip', args }], warnings: [] };
      }
      case 'add_track':
        return { steps: [{ name: 'video.addTrack', args: { kind: a.kind, trackId: uid(String(a.kind ?? 'v')[0]!) } }], warnings: [] };
      case 'set_track': {
        const patch: Record<string, unknown> = {};
        if (typeof a.muted === 'boolean') patch.muted = a.muted;
        if (typeof a.hidden === 'boolean') patch.hidden = a.hidden;
        if (n(a.volume) !== undefined) patch.volume = n(a.volume);
        return { steps: [{ name: 'video.setTrack', args: { trackId: s(a.track_id), patch } }], warnings: [] };
      }
      case 'remove_pauses': {
        const r = await this.expand(projectId, seq, media, transcripts, 'remove-pauses', { trackId: a.track_id, minPause: a.min_pause_seconds });
        return { steps: r.steps, label: r.note, warnings: r.warnings };
      }
      case 'add_captions': {
        const r = await this.expand(projectId, seq, media, transcripts, 'captions', {});
        if (!r.steps.length) throw new StudioError('invalid', r.warnings[0] ?? 'No captions to add.');
        return { steps: r.steps, label: r.note, warnings: r.warnings };
      }
      case 'duck_music': {
        const r = await this.expand(projectId, seq, media, transcripts, 'duck', { musicTrackId: a.music_track_id, level: a.level });
        return { steps: r.steps, label: r.note, warnings: r.warnings };
      }
      case 'trim_to_length': {
        const r = await this.expand(projectId, seq, media, transcripts, 'trim', { seconds: a.seconds });
        return { steps: r.steps, label: r.note, warnings: r.warnings };
      }
      case 'create_portrait_version': {
        const r = await this.expand(projectId, seq, media, transcripts, 'portrait', { name: a.name, suffix: `-${Date.now().toString(36).slice(-3)}` });
        return { steps: r.steps, label: r.note, warnings: r.warnings };
      }
      default:
        throw new StudioError('invalid', `Unknown tool ${name}.`);
    }
  }

  take(projectId: string, proposalId: string): Proposal {
    const p = this.proposals.get(proposalId);
    if (!p || p.projectId !== projectId) throw new StudioError('not-found', 'That proposal is no longer available. Ask again.');
    return p;
  }

  discard(proposalId: string): void {
    this.proposals.delete(proposalId);
  }
}

export type { TextClip };
export { clipDuration };
