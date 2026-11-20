/**
 * Video: media assets, sequences (timelines) and export jobs.
 *
 * Time on a timeline is an integer number of ticks (240,000 per second), which divides evenly
 * into every common frame rate (23.976, 24, 25, 29.97, 30, 50, 59.94, 60) and audio rate, so
 * edits never accumulate floating-point drift.
 */
export const TICKS_PER_SECOND = 240_000;

export const ticksToSeconds = (t: number): number => t / TICKS_PER_SECOND;
export const secondsToTicks = (s: number): number => Math.round(s * TICKS_PER_SECOND);

export interface Fps {
  num: number;
  den: number;
}
export const fpsValue = (f: Fps): number => f.num / f.den;
/** Ticks per frame, rounded to a whole tick. */
export const frameTicks = (f: Fps): number => Math.round((TICKS_PER_SECOND * f.den) / f.num);

/* ---------------- media ---------------- */

export type MediaKind = 'video' | 'audio' | 'image' | 'font';

export interface MediaProbe {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: Fps | null;
  rotation: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  /** Whether Chromium can play the original directly; otherwise a proxy is used for preview. */
  playable: boolean;
}

export interface MediaAssetView {
  id: string;
  name: string;
  kind: MediaKind;
  sha256: string;
  size: number;
  importedAt: string;
  probe: MediaProbe;
  status: 'ready' | 'missing';
  /** Preview URLs (app protocol); null when missing. */
  url: string | null;
  thumbUrl: string | null;
  /** Thumbnail strip (frames side by side) for timeline clips. */
  stripUrl: string | null;
  stripFrames: number;
  proxy: 'none' | 'needed' | 'ready' | 'failed';
  /** Sequences in this version that use the asset. */
  usedIn: string[];
  provenance: import('./media').MediaProvenance | null;
  tags: string[];
  hasTranscript: boolean;
}

export interface WaveformView {
  assetId: string;
  /** Peak amplitude 0..1 per bucket. */
  peaks: number[];
  bucketSeconds: number;
}

/* ---------------- sequences ---------------- */

export interface SequenceSettings {
  width: number;
  height: number;
  fps: Fps;
  sampleRate: number;
  background: string;
}

export interface ClipTransform {
  /** Offset of the clip's centre from the frame centre, in output pixels. */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export interface ClipCrop {
  /** Fractions of the source size removed from each edge (0..0.45). */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Transition {
  kind: 'crossfade' | 'dip';
  duration: number; // ticks
}

interface ClipBase {
  id: string;
  start: number; // ticks on the timeline
  fadeIn: number; // ticks
  fadeOut: number; // ticks
  transitionIn: Transition | null;
}

export interface MediaClip extends ClipBase {
  type: 'media';
  assetId: string;
  /** Source range in ticks (source time, before speed). */
  in: number;
  out: number;
  speed: number;
  volume: number;
  muted: boolean;
  transform: ClipTransform;
  crop: ClipCrop;
}

export interface TextStyle {
  fontSize: number; // output pixels
  color: string;
  weight: 'regular' | 'semibold';
  align: 'left' | 'center' | 'right';
  /** Anchor position as a fraction of the frame (0..1). */
  x: number;
  y: number;
  box: boolean;
  boxColor: string;
  /** Background panel colour for title cards, lower thirds and end cards. */
  panelColor?: string;
  /** A font from the asset library; the bundled Inter is used when unset or missing. */
  fontAssetId?: string | null;
}

/** Motion graphics: a plain title, or a layout with a panel and an optional second line. */
export const TEXT_TEMPLATES = ['plain', 'title-card', 'lower-third', 'end-card'] as const;
export type TextTemplate = (typeof TEXT_TEMPLATES)[number];
export const TEXT_TEMPLATE_LABELS: Record<TextTemplate, string> = { plain: 'Title', 'title-card': 'Title card', 'lower-third': 'Lower third', 'end-card': 'End card' };

export interface TextClip extends ClipBase {
  type: 'text';
  duration: number; // ticks
  text: string;
  style: TextStyle;
  template?: TextTemplate;
  /** Second line for cards and lower thirds. */
  subtitle?: string;
  /** A brand text style this title follows; brand updates restyle it (after a preview). */
  brandStyleId?: string;
  /** A living object this scene shows: text and subtitle are rendered from it (see src/objects). */
  object?: { id: string; instance: string; revision: number; overrides?: Record<string, string | string[]>; hash?: string };
}

export type Clip = MediaClip | TextClip;

export interface Track {
  id: string;
  kind: 'video' | 'audio' | 'text';
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  volume: number;
  clips: Clip[];
}

export interface Sequence {
  format: 'multiverse-sequence';
  version: 1;
  id: string;
  name: string;
  settings: SequenceSettings;
  /** Bottom to top: later video tracks are drawn over earlier ones. */
  tracks: Track[];
}

export const clipDuration = (c: Clip): number => (c.type === 'text' ? c.duration : Math.round((c.out - c.in) / c.speed));
export const clipEnd = (c: Clip): number => c.start + clipDuration(c);
export const sequenceDuration = (s: Sequence): number => Math.max(0, ...s.tracks.flatMap((t) => t.clips.map(clipEnd)));

export const DEFAULT_TRANSFORM: ClipTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
export const DEFAULT_CROP: ClipCrop = { left: 0, right: 0, top: 0, bottom: 0 };
export const DEFAULT_TEXT_STYLE: TextStyle = { fontSize: 72, color: '#ffffff', weight: 'semibold', align: 'center', x: 0.5, y: 0.82, box: false, boxColor: '#000000' };

export interface SequenceSummary {
  id: string;
  name: string;
  path: string;
  durationSeconds: number;
  width: number;
  height: number;
}

/* ---------------- export ---------------- */

export const EXPORT_PRESETS = {
  landscape: { label: 'Landscape 16:9', width: 1920, height: 1080 },
  portrait: { label: 'Portrait 9:16', width: 1080, height: 1920 },
  square: { label: 'Square 1:1', width: 1080, height: 1080 },
  sequence: { label: 'Same as the sequence', width: 0, height: 0 },
} as const;
export type ExportPreset = keyof typeof EXPORT_PRESETS;

export interface ExportSettings {
  preset: ExportPreset;
  /** Height of the shorter side: 2160, 1080, 720, 480; 0 = the preset's size. */
  resolution: 0 | 2160 | 1080 | 720 | 480;
  fps: 'sequence' | 24 | 25 | 30 | 60;
  quality: 'high' | 'standard' | 'small';
  format: 'mp4' | 'webm';
  /** Encode a short range only (ticks), e.g. for a quick check. */
  range: { start: number; end: number } | null;
}

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface ExportJobView {
  id: string;
  projectId: string;
  lineId: string;
  sequenceId: string;
  sequenceName: string;
  settings: ExportSettings;
  state: JobState;
  progress: number;
  /** Where the file is written. */
  output: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** What ffprobe read back from the finished file. */
  verified: { durationSeconds: number; width: number; height: number; videoCodec: string; audioCodec: string | null; size: number } | null;
  /** Content hash of the sequence file that was exported, and of each media file it used. */
  sourceHash?: string;
  assetShas?: Record<string, string>;
  /** The version's saved revision when the export started, and whether it had unsaved changes (the timeline itself is snapshotted). */
  revision?: string | null;
  draft?: boolean;
  /**
   * Whether the export still matches its sources (computed when listed): the sequence or its media
   * changed since, or the sequence was deleted. Null for exports that did not complete.
   */
  outdated?: { reason: 'sequence-changed' | 'media-changed' | 'sequence-deleted' | 'version-deleted'; detail: string } | null;
}

export interface VideoToolsView {
  available: boolean;
  ffmpeg: string | null;
  ffprobe: string | null;
  version: string | null;
  message: string | null;
}
