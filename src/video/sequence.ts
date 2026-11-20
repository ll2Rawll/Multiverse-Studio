/**
 * Sequences are JSON files in the project (`sequences/<id>.mvseq.json`), so timelines are part of
 * each version: alternatives can cut the same footage differently, and history, compare and
 * combine work on them like any other file. Media itself lives in the project's media store and is
 * referenced by stable asset ids.
 *
 * Every timeline edit is a command (video.*) with validated arguments, an expected revision and
 * undo/redo through the shared command layer. Clip ids are stable across edits.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CommandError, type CommandDefinition, type CommandRegistry, type FileTexts } from '../commands/commands';
import {
  DEFAULT_CROP,
  DEFAULT_TEXT_STYLE,
  DEFAULT_TRANSFORM,
  TICKS_PER_SECOND,
  clipDuration,
  clipEnd,
  type Clip,
  type MediaClip,
  type Sequence,
  type TextClip,
  type Track,
  TEXT_TEMPLATES,
} from '../shared/video';

export const SEQUENCE_DIR = 'sequences';
export const sequencePath = (id: string): string => `${SEQUENCE_DIR}/${id}.mvseq.json`;
const MAX_TICKS = TICKS_PER_SECOND * 60 * 60 * 6; // six hours

const ticks = z.number().int().min(0).max(MAX_TICKS);
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const fps = z.object({ num: z.number().int().min(1).max(240_000), den: z.number().int().min(1).max(10_000) });
const transition = z.object({ kind: z.enum(['crossfade', 'dip']), duration: ticks.max(TICKS_PER_SECOND * 10) }).nullable();
const transform = z.object({ x: z.number().min(-20000).max(20000), y: z.number().min(-20000).max(20000), scale: z.number().min(0.05).max(10), rotation: z.number().min(-360).max(360), opacity: z.number().min(0).max(1) });
const crop = z.object({ left: z.number().min(0).max(0.45), right: z.number().min(0).max(0.45), top: z.number().min(0).max(0.45), bottom: z.number().min(0).max(0.45) });
const textStyle = z.object({
  fontSize: z.number().min(8).max(600),
  color,
  weight: z.enum(['regular', 'semibold']),
  align: z.enum(['left', 'center', 'right']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  box: z.boolean(),
  boxColor: color,
  panelColor: color.optional(),
  fontAssetId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).nullable().optional(),
});
const base = { id: idSchema, start: ticks, fadeIn: ticks, fadeOut: ticks, transitionIn: transition };
const mediaClip = z.object({ ...base, type: z.literal('media'), assetId: idSchema, in: ticks, out: ticks, speed: z.number().min(0.25).max(4), volume: z.number().min(0).max(2), muted: z.boolean(), transform, crop });
const objectRef = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  instance: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  revision: z.number().int().min(0),
  overrides: z.record(z.string().max(41), z.union([z.string().max(2000), z.array(z.string().max(500)).max(40)])).optional(),
  hash: z.string().max(40).optional(),
});
const textClip = z.object({ ...base, type: z.literal('text'), duration: ticks.min(1), text: z.string().max(500), style: textStyle, template: z.enum(TEXT_TEMPLATES).optional(), subtitle: z.string().max(300).optional(), brandStyleId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(), object: objectRef.optional() });
const track = z.object({ id: idSchema, kind: z.enum(['video', 'audio', 'text']), name: z.string().min(1).max(60), muted: z.boolean(), hidden: z.boolean(), locked: z.boolean(), volume: z.number().min(0).max(2), clips: z.array(z.union([mediaClip, textClip])).max(2000) });
const settings = z.object({ width: z.number().int().min(16).max(7680).multipleOf(2), height: z.number().int().min(16).max(7680).multipleOf(2), fps, sampleRate: z.number().int().min(8000).max(192000), background: color });

export const sequenceSchema = z.object({
  format: z.literal('multiverse-sequence'),
  version: z.literal(1),
  id: idSchema,
  name: z.string().min(1).max(120),
  settings,
  tracks: z.array(track).max(64),
});

export function parseSequence(text: string): Sequence {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CommandError('The sequence file is not valid JSON. Fix it in Build or restore it from History.');
  }
  const parsed = sequenceSchema.safeParse(raw);
  if (!parsed.success) throw new CommandError(`The sequence file is not valid: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  const seq = parsed.data as Sequence;
  for (const t of seq.tracks) for (const c of t.clips) if (c.type === 'media' && c.out <= c.in) throw new CommandError(`Clip ${c.id} ends before it starts.`);
  return seq;
}

export function serializeSequence(seq: Sequence): string {
  return `${JSON.stringify(seq, null, 2)}\n`;
}

const newId = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`;

/** Default placement and look for each motion-graphics layout. */
export function templateStyle(t: (typeof TEXT_TEMPLATES)[number]): TextClip['style'] {
  switch (t) {
    case 'title-card':
      return { ...DEFAULT_TEXT_STYLE, fontSize: 96, x: 0.5, y: 0.46, align: 'center', panelColor: '#111014' };
    case 'end-card':
      return { ...DEFAULT_TEXT_STYLE, fontSize: 84, x: 0.5, y: 0.44, align: 'center', panelColor: '#111014' };
    case 'lower-third':
      return { ...DEFAULT_TEXT_STYLE, fontSize: 54, x: 0.08, y: 0.79, align: 'left', panelColor: '#111014' };
    default:
      return { ...DEFAULT_TEXT_STYLE };
  }
}

export function newSequence(id: string, name: string, s: Sequence['settings']): Sequence {
  return {
    format: 'multiverse-sequence',
    version: 1,
    id,
    name,
    settings: s,
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', muted: false, hidden: false, locked: false, volume: 1, clips: [] },
      { id: 't1', kind: 'text', name: 'Titles', muted: false, hidden: false, locked: false, volume: 1, clips: [] },
      { id: 'a1', kind: 'audio', name: 'Audio 1', muted: false, hidden: false, locked: false, volume: 1, clips: [] },
    ],
  };
}

/* ---------------- helpers ---------------- */

function findClip(seq: Sequence, clipId: string): { track: Track; clip: Clip; index: number } {
  for (const track of seq.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  throw new CommandError('That clip is no longer on the timeline.');
}

function findTrack(seq: Sequence, trackId: string): Track {
  const t = seq.tracks.find((x) => x.id === trackId);
  if (!t) throw new CommandError('That track no longer exists.');
  return t;
}

function assertUnlocked(track: Track): void {
  if (track.locked) throw new CommandError(`${track.name} is locked. Unlock it to edit its clips.`);
}

/** Clips on one track never overlap; transitions overlap only while rendering (using handles). */
function assertFree(track: Track, start: number, end: number, ignore: Set<string>): void {
  for (const c of track.clips) {
    if (ignore.has(c.id)) continue;
    if (start < clipEnd(c) && end > c.start) throw new CommandError(`That would overlap another clip on ${track.name}. Move it to a free spot or another track.`);
  }
}

/** After a clip gets shorter, its fades and transition shrink to fit it (setClip refuses ones that don't). */
function fitEffects(clip: Clip): void {
  const len = clipDuration(clip);
  if (clip.transitionIn && clip.transitionIn.duration > len) clip.transitionIn = { ...clip.transitionIn, duration: len };
  const fades = clip.fadeIn + clip.fadeOut;
  if (fades > len) {
    clip.fadeIn = Math.floor((clip.fadeIn * len) / fades);
    clip.fadeOut = Math.floor((clip.fadeOut * len) / fades);
  }
}

function sortClips(track: Track): void {
  track.clips.sort((a, b) => a.start - b.start);
}

function trackFits(kind: Track['kind'], clip: { type: 'media' | 'text'; mediaKind?: 'video' | 'audio' | 'image' }): boolean {
  if (clip.type === 'text') return kind === 'text';
  if (clip.mediaKind === 'audio') return kind === 'audio';
  return kind === 'video';
}

function edit<A extends { sequence: string }>(files: FileTexts, a: A, fn: (seq: Sequence) => void): FileTexts {
  const p = sequencePath(a.sequence);
  const text = files.get(p);
  if (text === null || text === undefined) throw new CommandError('That sequence does not exist in this version.');
  const seq = parseSequence(text);
  fn(seq);
  sequenceSchema.parse(seq); // never write an invalid sequence
  return new Map([[p, serializeSequence(seq)]]);
}

function def<A extends { sequence: string }>(d: Omit<CommandDefinition<A>, 'scope' | 'files'> & Partial<Pick<CommandDefinition<A>, 'files'>>): CommandDefinition<A> {
  return { scope: (a) => `video:${a.sequence}`, files: (a) => [sequencePath(a.sequence)], ...d };
}

/* ---------------- commands ---------------- */

const seqRef = { sequence: idSchema };

export const videoCommands = [
  def({
    name: 'video.createSequence',
    schema: z.object({ ...seqRef, name: z.string().min(1).max(120), settings }),
    label: (a) => `Create sequence “${a.name}”`,
    apply: (files, a) => {
      const p = sequencePath(a.sequence);
      if (files.get(p)) throw new CommandError('A sequence with that id already exists.');
      return new Map([[p, serializeSequence(newSequence(a.sequence, a.name, a.settings as Sequence['settings']))]]);
    },
  }),
  def({
    name: 'video.setSequence',
    schema: z.object({ ...seqRef, name: z.string().min(1).max(120).optional(), settings: settings.partial().optional() }),
    label: (a) => (a.name ? `Rename sequence to “${a.name}”` : 'Change sequence settings'),
    apply: (files, a) =>
      edit(files, a, (seq) => {
        if (a.name) seq.name = a.name;
        if (a.settings) seq.settings = { ...seq.settings, ...(a.settings as Partial<Sequence['settings']>) };
      }),
  }),
  def({
    name: 'video.addTrack',
    schema: z.object({ ...seqRef, kind: z.enum(['video', 'audio', 'text']), trackId: idSchema.optional() }),
    label: (a) => `Add ${a.kind} track`,
    apply: (files, a) =>
      edit(files, a, (seq) => {
        const n = seq.tracks.filter((t) => t.kind === a.kind).length + 1;
        const t: Track = { id: a.trackId ?? newId(a.kind[0]!), kind: a.kind, name: a.kind === 'text' ? `Titles ${n}` : `${a.kind === 'video' ? 'Video' : 'Audio'} ${n}`, muted: false, hidden: false, locked: false, volume: 1, clips: [] };
        if (seq.tracks.some((x) => x.id === t.id)) throw new CommandError('A track with that id already exists.');
        // New video and text tracks go above the existing ones of their kind; audio below.
        const lastOfKind = seq.tracks.map((x) => x.kind).lastIndexOf(a.kind);
        seq.tracks.splice(lastOfKind >= 0 ? lastOfKind + 1 : a.kind === 'audio' ? seq.tracks.length : 0, 0, t);
      }),
  }),
  def({
    name: 'video.removeTrack',
    schema: z.object({ ...seqRef, trackId: idSchema }),
    label: () => 'Remove track',
    apply: (files, a) =>
      edit(files, a, (seq) => {
        const t = findTrack(seq, a.trackId);
        if (t.clips.length) throw new CommandError(`${t.name} still has clips. Delete or move them first.`);
        seq.tracks = seq.tracks.filter((x) => x !== t);
      }),
  }),
  def({
    name: 'video.setTrack',
    schema: z.object({ ...seqRef, trackId: idSchema, patch: z.object({ name: z.string().min(1).max(60).optional(), muted: z.boolean().optional(), hidden: z.boolean().optional(), locked: z.boolean().optional(), volume: z.number().min(0).max(2).optional() }) }),
    label: (a) => (a.patch.muted !== undefined ? (a.patch.muted ? 'Mute track' : 'Unmute track') : a.patch.hidden !== undefined ? (a.patch.hidden ? 'Hide track' : 'Show track') : a.patch.locked !== undefined ? (a.patch.locked ? 'Lock track' : 'Unlock track') : 'Change track'),
    apply: (files, a) =>
      edit(files, a, (seq) => {
        Object.assign(findTrack(seq, a.trackId), a.patch);
      }),
  }),
  def({
    name: 'video.addClip',
    schema: z.object({
      ...seqRef,
      clipId: idSchema.optional(),
      assetId: idSchema,
      /** What the caller knows about the asset (from the media library). */
      media: z.object({ kind: z.enum(['video', 'audio', 'image']), duration: ticks.nullable() }),
      trackId: idSchema.optional(),
      start: ticks.optional(),
      in: ticks.optional(),
      out: ticks.optional(),
    }),
    label: () => 'Add clip',
    apply: (files, a) =>
      edit(files, a, (seq) => {
        const track = a.trackId ? findTrack(seq, a.trackId) : seq.tracks.find((t) => trackFits(t.kind, { type: 'media', mediaKind: a.media.kind }));
        if (!track) throw new CommandError(`Add a ${a.media.kind === 'audio' ? 'audio' : 'video'} track first.`);
        if (!trackFits(track.kind, { type: 'media', mediaKind: a.media.kind })) throw new CommandError(`${a.media.kind === 'audio' ? 'Audio' : 'Pictures'} go on ${a.media.kind === 'audio' ? 'an audio' : 'a video'} track.`);
        assertUnlocked(track);
        const full = a.media.duration ?? TICKS_PER_SECOND * 5; // stills default to five seconds
        const inT = a.in ?? 0;
        const outT = Math.min(a.out ?? full, a.media.kind === 'image' ? MAX_TICKS : full);
        if (outT <= inT) throw new CommandError('The clip would be empty.');
        const start = a.start ?? Math.max(0, ...track.clips.map(clipEnd));
        const clip: MediaClip = { id: a.clipId ?? newId('c'), type: 'media', assetId: a.assetId, start, in: inT, out: outT, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transitionIn: null, transform: { ...DEFAULT_TRANSFORM }, crop: { ...DEFAULT_CROP } };
        if (seq.tracks.some((t) => t.clips.some((c) => c.id === clip.id))) throw new CommandError('A clip with that id already exists.');
        assertFree(track, clip.start, clipEnd(clip), new Set());
        track.clips.push(clip);
        sortClips(track);
      }),
  }),
  def({
    name: 'video.addText',
    schema: z.object({ ...seqRef, clipId: idSchema.optional(), trackId: idSchema.optional(), start: ticks, duration: ticks.min(1), text: z.string().min(1).max(500), style: textStyle.partial().optional(), template: z.enum(TEXT_TEMPLATES).optional(), subtitle: z.string().max(300).optional(), brandStyleId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional() }),
    label: (a) => (a.template && a.template !== 'plain' ? `Add ${a.template.replace('-', ' ')}` : 'Add text'),
    apply: (files, a) =>
      edit(files, a, (seq) => {
        const track = a.trackId ? findTrack(seq, a.trackId) : seq.tracks.find((t) => t.kind === 'text');
        if (!track || track.kind !== 'text') throw new CommandError('Add a titles track first.');
        assertUnlocked(track);
        const clip: TextClip = { id: a.clipId ?? newId('t'), type: 'text', start: a.start, duration: a.duration, text: a.text, style: { ...templateStyle(a.template ?? 'plain'), ...(a.style ?? {}) }, fadeIn: 0, fadeOut: 0, transitionIn: null };
        if (a.template && a.template !== 'plain') clip.template = a.template;
        if (a.subtitle) clip.subtitle = a.subtitle;
        if (a.brandStyleId) clip.brandStyleId = a.brandStyleId;
        assertFree(track, clip.start, clipEnd(clip), new Set());
        track.clips.push(clip);
        sortClips(track);
      }),
  }),
  def({
    name: 'video.moveClip',
    schema: z.object({ ...seqRef, clipId: idSchema, start: ticks, trackId: idSchema.optional() }),
    label: () => 'Move clip',
    apply: (files, a) =>
      edit(files, a, (seq) => {
        const { track, clip, index } = findClip(seq, a.clipId);
        assertUnlocked(track);
        const to = a.trackId ? findTrack(seq, a.trackId) : track;
        assertUnlocked(to);
        const mediaKind = clip.type === 'media' ? (to.kind === 'audio' ? 'audio' : 'video') : undefined;
        if (to !== track && (to.kind !== track.kind || !trackFits(to.kind, { type: clip.type, mediaKind }))) throw new CommandError(`That clip cannot go on ${to.name}.`);
        const end = a.start + clipDuration(clip);
        assertFree(to, a.start, end, new Set([clip.id]));
        track.clips.splice(index, 1);
        clip.start = a.start;
        to.clips.push(clip);
        sortClips(to);
      }),
  }),
  def({
    name: 'video.trimClip',
    schema: z.object({ ...seqRef, clipId: idSchema, edge: z.enum(['start', 'end']), /** New timeline position of that edge. */ at: ticks, sourceDuration: ticks.nullable().optional() }),
    label: (a) => (a.edge === 'start' ? 'Trim clip start' : 'Trim clip end'),
    apply: (files, a) =>
      edit(files, a, (seq) => {
        const { track, clip } = findClip(seq, a.clipId);
        assertUnlocked(track);
        const minLen = Math.round(TICKS_PER_SECOND / 30);
        if (a.edge === 'start') {
          const end = clipEnd(clip);
          if (a.at > end - minLen) throw new CommandError('A clip needs at least one frame.');
          const delta = a.at - clip.start; // timeline ticks
          if (clip.type === 'media') {
            const nextIn = clip.in + Math.round(delta * clip.speed);
            if (nextIn < 0) throw new CommandError('The clip already starts at the beginning of its media.');
            clip.in = nextIn;
          } else clip.duration -= delta;
          assertFree(track, a.at, end, new Set([clip.id]));
          clip.start = a.at;
          fitEffects(clip);
        } else {
          if (a.at < clip.start + minLen) throw new CommandError('A clip needs at least one frame.');
          if (clip.type === 'media') {
            const nextOut = clip.in + Math.round((a.at - clip.start) * clip.speed);
            if (a.sourceDuration != null && nextOut > a.sourceDuration) throw new CommandError('The clip already ends at the end of its media.');
            clip.out = nextOut;
          } else clip.duration = a.at - clip.start;
          assertFree(track, clip.start, a.at, new Set([clip.id]));
          fitEffects(clip);
        }
      }),
  }),
  def({
    name: 'video.splitClip',
    schema: z.object({ ...seqRef, clipId: idSchema, at: ticks, newClipId: idSchema.optional() }),
    label: () => 'Split clip',
    apply: (files, a) =>
      edit(files, a, (seq) => {
        const { track, clip, index } = findClip(seq, a.clipId);
        assertUnlocked(track);
        if (a.at <= clip.start || a.at >= clipEnd(clip)) throw new CommandError('Move the playhead inside the clip to split it.');
        const minLen = Math.round(TICKS_PER_SECOND / 30);
        if (a.at - clip.start < minLen || clipEnd(clip) - a.at < minLen) throw new CommandError('Each part needs at least one frame. Move the playhead further from the clip’s edge.');
        const right: Clip = structuredClone(clip);
        right.id = a.newClipId ?? newId(clip.type === 'text' ? 't' : 'c');
        right.start = a.at;
        right.transitionIn = null;
        right.fadeIn = 0;
        clip.fadeOut = 0;
        if (clip.type === 'media' && right.type === 'media') {
          const cut = clip.in + Math.round((a.at - clip.start) * clip.speed);
          clip.out = cut;
          right.in = cut;
        } else if (clip.type === 'text' && right.type === 'text') {
          const left = a.at - clip.start;
          right.duration = clip.duration - left;
          clip.duration = left;
        }
        fitEffects(clip);
        fitEffects(right);
        track.clips.splice(index + 1, 0, right);
      }),
  }),
  def({
    name: 'video.deleteClips',
    schema: z.object({ ...seqRef, clipIds: z.array(idSchema).min(1).max(500), ripple: z.boolean().optional() }),
    label: (a) => (a.clipIds.length > 1 ? `Delete ${a.clipIds.length} clips` : 'Delete clip'),
    apply: (files, a) =>
      edit(files, a, (seq) => {
        for (const id of a.clipIds) {
          const { track, clip, index } = findClip(seq, id);
          assertUnlocked(track);
          track.clips.splice(index, 1);
          if (a.ripple) {
            // Close the hole: later clips move left by the clip's length, but never past where it began
            // (a split of a slowed clip can leave its halves overlapping by a tick of rounding).
            const later = track.clips.filter((c) => c.start > clip.start);
            const gap = Math.min(clipDuration(clip), ...later.map((c) => c.start - clip.start));
            for (const c of later) c.start -= gap;
          }
        }
      }),
  }),
  def({
    name: 'video.setClip',
    schema: z.object({
      ...seqRef,
      clipId: idSchema,
      patch: z.object({
        volume: z.number().min(0).max(2).optional(),
        muted: z.boolean().optional(),
        speed: z.number().min(0.25).max(4).optional(),
        fadeIn: ticks.optional(),
        fadeOut: ticks.optional(),
        transitionIn: transition.optional(),
        transform: transform.partial().optional(),
        crop: crop.partial().optional(),
        text: z.string().min(1).max(500).optional(),
        style: textStyle.partial().optional(),
        template: z.enum(TEXT_TEMPLATES).optional(),
        subtitle: z.string().max(300).optional(),
        /** '' detaches the title from its brand style. */
        brandStyleId: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)]).optional(),
      }),
    }),
    label: (a) => (a.patch.brandStyleId !== undefined ? 'Change brand style' : a.patch.speed !== undefined ? 'Change speed' : a.patch.text !== undefined || a.patch.style ? 'Edit text' : a.patch.transitionIn !== undefined ? 'Change transition' : a.patch.transform || a.patch.crop ? 'Change position and crop' : 'Change clip'),
    apply: (files, a) =>
      edit(files, a, (seq) => {
        const { track, clip } = findClip(seq, a.clipId);
        assertUnlocked(track);
        const p = a.patch;
        if (p.fadeIn !== undefined) clip.fadeIn = p.fadeIn;
        if (p.fadeOut !== undefined) clip.fadeOut = p.fadeOut;
        if (p.transitionIn !== undefined) clip.transitionIn = p.transitionIn;
        if (clip.type === 'media') {
          if (p.volume !== undefined) clip.volume = p.volume;
          if (p.muted !== undefined) clip.muted = p.muted;
          if (p.transform) clip.transform = { ...clip.transform, ...p.transform };
          if (p.crop) clip.crop = { ...clip.crop, ...p.crop };
          if (clip.crop.left + clip.crop.right > 0.9 || clip.crop.top + clip.crop.bottom > 0.9) throw new CommandError('That crop would leave almost nothing of the picture.');
          if (p.speed !== undefined && p.speed !== clip.speed) {
            // Keep the source range; the clip gets shorter or longer on the timeline.
            const before = clipEnd(clip);
            clip.speed = p.speed;
            if (clipEnd(clip) > before) assertFree(track, clip.start, clipEnd(clip), new Set([clip.id]));
          }
        } else {
          if (p.text !== undefined) clip.text = p.text;
          if (p.template !== undefined) {
            // Switching layout moves the text to that layout's place; colours and size are kept.
            const t = templateStyle(p.template);
            clip.style = { ...clip.style, x: t.x, y: t.y, align: t.align, panelColor: clip.style.panelColor ?? t.panelColor };
            if (p.template === 'plain') delete clip.template;
            else clip.template = p.template;
          }
          if (p.subtitle !== undefined) {
            if (p.subtitle) clip.subtitle = p.subtitle;
            else delete clip.subtitle;
          }
          if (p.style) clip.style = { ...clip.style, ...p.style };
          if (p.brandStyleId !== undefined) {
            if (p.brandStyleId) clip.brandStyleId = p.brandStyleId;
            else delete clip.brandStyleId;
          }
        }
        const len = clipDuration(clip);
        if (clip.fadeIn + clip.fadeOut > len) throw new CommandError('Fades are longer than the clip.');
        if (clip.transitionIn && clip.transitionIn.duration > len) throw new CommandError('The transition is longer than the clip.');
      }),
  }),
];

/**
 * A copy of a sequence with new frame settings. `reframe: 'fill'` scales each picture so it covers
 * the new frame (for example making a portrait version of a landscape edit); 'fit' keeps it whole.
 */
const duplicateSequence = {
  name: 'video.duplicateSequence',
  schema: z.object({
    ...seqRef,
    newSequence: idSchema,
    name: z.string().min(1).max(120),
    settings: settings.partial().optional(),
    reframe: z.enum(['fit', 'fill']).optional(),
    /** Picture sizes of the assets used (from the media library), needed to compute 'fill'. */
    assets: z.record(z.string(), z.object({ width: z.number().positive(), height: z.number().positive() })).optional(),
  }),
  scope: (a: { sequence: string }) => `video:${a.sequence}`,
  files: (a: { sequence: string; newSequence: string }) => [sequencePath(a.sequence), sequencePath(a.newSequence)],
  label: (a: { name: string }) => `Create “${a.name}”`,
  apply: (files: FileTexts, a: { sequence: string; newSequence: string; name: string; settings?: Partial<Sequence['settings']>; reframe?: 'fit' | 'fill'; assets?: Record<string, { width: number; height: number }> }): FileTexts => {
    const src = files.get(sequencePath(a.sequence));
    if (!src) throw new CommandError('That sequence does not exist in this version.');
    if (files.get(sequencePath(a.newSequence))) throw new CommandError('A sequence with that id already exists.');
    const seq = parseSequence(src);
    const next: Sequence = structuredClone(seq);
    next.id = a.newSequence;
    next.name = a.name;
    next.settings = { ...seq.settings, ...(a.settings ?? {}) };
    if (a.reframe === 'fill') {
      const W = next.settings.width;
      const H = next.settings.height;
      for (const t of next.tracks) {
        if (t.kind !== 'video') continue;
        for (const c of t.clips) {
          if (c.type !== 'media') continue;
          const size = a.assets?.[c.assetId];
          if (!size) continue;
          const cw = size.width * (1 - c.crop.left - c.crop.right);
          const ch = size.height * (1 - c.crop.top - c.crop.bottom);
          const contain = Math.min(W / cw, H / ch);
          const cover = Math.max(W / cw, H / ch);
          c.transform = { ...c.transform, scale: Math.min(10, Math.round((cover / contain) * c.transform.scale * 1000) / 1000), x: 0, y: 0 };
        }
      }
      // Titles keep their relative positions; scale the type with the shorter side.
      const k = Math.min(W, H) / Math.min(seq.settings.width, seq.settings.height);
      for (const t of next.tracks) for (const c of t.clips) if (c.type === 'text') c.style = { ...c.style, fontSize: Math.max(8, Math.round(c.style.fontSize * k)) };
    }
    sequenceSchema.parse(next);
    return new Map([[sequencePath(a.newSequence), serializeSequence(next)]]);
  },
};

const BATCHABLE = new Map<string, CommandDefinition<never>>([...videoCommands, duplicateSequence].filter((c) => c.name !== 'video.createSequence').map((c) => [c.name, c as unknown as CommandDefinition<never>]));

/**
 * Several timeline commands applied as one change: one undo step and one entry in history. Used for
 * AI edits and analysis-based edits (remove pauses, captions, ducking), so each is still made of the
 * same validated operations as manual edits, and stays editable afterwards.
 */
const batch = {
  name: 'video.batch',
  schema: z.object({ ...seqRef, label: z.string().min(1).max(200), steps: z.array(z.object({ name: z.string().regex(/^video\.[A-Za-z]+$/), args: z.record(z.string(), z.unknown()) })).min(1).max(3000) }),
  scope: (a: { sequence: string }) => `video:${a.sequence}`,
  files: (a: { sequence: string; steps: { name: string; args: Record<string, unknown> }[] }) => {
    const out = new Set<string>([sequencePath(a.sequence)]);
    for (const s of a.steps) {
      const def = BATCHABLE.get(s.name);
      if (!def) continue;
      const parsed = def.schema.safeParse({ ...s.args, sequence: (s.args.sequence as string | undefined) ?? a.sequence });
      if (parsed.success) for (const f of def.files(parsed.data as never)) out.add(f);
    }
    return [...out];
  },
  label: (a: { label: string }) => a.label,
  apply: (files: FileTexts, a: { sequence: string; steps: { name: string; args: Record<string, unknown> }[] }): FileTexts => {
    const current = new Map(files);
    for (const [i, s] of a.steps.entries()) {
      const def = BATCHABLE.get(s.name);
      if (!def) throw new CommandError(`Step ${i + 1}: ${s.name} cannot be part of a combined edit.`);
      const parsed = def.schema.safeParse({ ...s.args, sequence: (s.args.sequence as string | undefined) ?? a.sequence });
      if (!parsed.success) throw new CommandError(`Step ${i + 1} (${s.name}): ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
      let out: FileTexts;
      try {
        out = def.apply(current, parsed.data as never) as FileTexts;
      } catch (error) {
        throw new CommandError(`Step ${i + 1} (${def.label(parsed.data as never)}): ${(error as Error).message}`);
      }
      for (const [p, t] of out) current.set(p, t);
    }
    const changed = new Map<string, string | null>();
    for (const [p, t] of current) if (files.get(p) !== t) changed.set(p, t);
    return changed as FileTexts;
  },
};

export const allVideoCommands = [...videoCommands, duplicateSequence, batch];

/** Apply one timeline command to in-memory files (for previews of AI edits). */
export function applyVideoCommand(files: FileTexts, name: string, args: Record<string, unknown>): { files: FileTexts; label: string } {
  const def = allVideoCommands.find((c) => c.name === name) as unknown as CommandDefinition<never> | undefined;
  if (!def) throw new CommandError(`Unknown timeline operation ${name}.`);
  const parsed = def.schema.safeParse(args);
  if (!parsed.success) throw new CommandError(`${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  // Timeline commands only ever write text.
  const out = def.apply(files, parsed.data as never) as FileTexts;
  const next = new Map(files);
  for (const [p, t] of out) next.set(p, t);
  return { files: next, label: def.label(parsed.data as never) };
}

export function registerVideoCommands(registry: CommandRegistry): void {
  for (const c of allVideoCommands) registry.register(c as unknown as CommandDefinition<unknown>);
}
