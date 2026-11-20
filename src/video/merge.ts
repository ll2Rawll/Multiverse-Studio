/**
 * Three-way merge of timelines (sequence files), by structure rather than by lines of JSON.
 *
 * Clips and tracks are matched by id. A change made on one side is taken; when both sides changed
 * the same thing differently, the result is a conflict item the user decides, never a mix of
 * half-applied fields:
 * - Clip properties are merged in groups that belong together. Timing (track, start, in, out,
 *   duration, speed) is one group, so two different trims or moves of one clip conflict instead
 *   of producing a clip with one side's start and the other side's out point.
 * - Clips placed by one side that overlap clips placed by the other on the same track are an
 *   overlap conflict; "keep both" moves the incoming clip to a new track.
 * - Deleting a clip or track that the other side changed is a conflict.
 * - Sequence settings and track properties merge field by field.
 * Unresolved items take our side, so the merged result is always a valid timeline; whether every
 * item was decided is tracked separately.
 */
import { clipEnd, type Clip, type Sequence, type Track } from '../shared/video';
import type { SequenceDiffView, TimelineConflictItemView } from '../shared/media';

export type { SequenceDiffView };

export type TimelineChoice = 'ours' | 'theirs' | 'both';

/** A decision a timeline merge needs. `key` is stable, so decisions survive recomputing the merge. */
export type TimelineConflictItem = TimelineConflictItemView;

export interface TimelineMergeResult {
  sequence: Sequence;
  conflicts: TimelineConflictItem[];
  /** What was taken from the incoming side without conflict, in words. */
  taken: string[];
}

export interface MergeNames {
  asset(id: string): string;
  /** "the Shared change", "Bold" */
  ours: string;
  theirs: string;
}

const TPS = 240000;
const secs = (t: number): string => `${(Math.round((t / TPS) * 10) / 10).toFixed(1)} s`;

function canon(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(',')}}`;
}
const eq = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

type Placed = { clip: Clip; trackId: string };

/** Field groups that change together. */
const GROUPS: { name: string; fields: string[] }[] = [
  { name: 'timing', fields: ['trackId', 'start', 'in', 'out', 'duration', 'speed'] },
  { name: 'sound', fields: ['volume', 'muted'] },
  { name: 'fades and transition', fields: ['fadeIn', 'fadeOut', 'transitionIn'] },
  { name: 'position and crop', fields: ['transform', 'crop'] },
  { name: 'text', fields: ['text', 'subtitle', 'template', 'object'] },
  { name: 'style', fields: ['style', 'brandStyleId'] },
  { name: 'media', fields: ['assetId', 'type'] },
];

const pick = (p: Placed | undefined, fields: string[]): Record<string, unknown> | undefined => {
  if (!p) return undefined;
  const all: Record<string, unknown> = { ...(p.clip as unknown as Record<string, unknown>), trackId: p.trackId };
  return Object.fromEntries(fields.map((f) => [f, all[f]]));
};

function placedMap(seq: Sequence | null): Map<string, Placed> {
  const m = new Map<string, Placed>();
  for (const t of seq?.tracks ?? []) for (const c of t.clips) m.set(c.id, { clip: c, trackId: t.id });
  return m;
}

const trackProps = (t: Track | undefined): Record<string, unknown> | undefined => (t ? { name: t.name, muted: t.muted, hidden: t.hidden, locked: t.locked, volume: t.volume, kind: t.kind } : undefined);

export function mergeSequences(base: Sequence | null, ours: Sequence, theirs: Sequence, choices: Record<string, TimelineChoice> = {}, names: MergeNames = { asset: (id) => id, ours: 'this version', theirs: 'the incoming change' }): TimelineMergeResult {
  const conflicts: TimelineConflictItem[] = [];
  const taken: string[] = [];
  const choose = (key: string): TimelineChoice => choices[key] ?? 'ours';
  const out: Sequence = structuredClone(ours);
  const clipName = (c: Clip): string => (c.type === 'text' ? `Title “${c.text.slice(0, 40)}”` : `Clip “${names.asset(c.assetId)}”`);
  const trackName = (id: string): string => out.tracks.find((t) => t.id === id)?.name ?? theirs.tracks.find((t) => t.id === id)?.name ?? ours.tracks.find((t) => t.id === id)?.name ?? id;

  /* ---- sequence name and settings ---- */
  const scalar = (key: string, label: string, b: unknown, o: unknown, t: unknown, set: (v: unknown) => void, show: (v: unknown) => string): void => {
    if (eq(o, t) || eq(b, t)) return;
    if (eq(b, o)) {
      set(t);
      taken.push(`${label}: ${show(t)}`);
      return;
    }
    conflicts.push({ key, kind: 'settings', label, ours: show(o), theirs: show(t), allowBoth: false, range: null });
    if (choose(key) === 'theirs') set(t);
  };
  scalar('settings:name', 'Sequence name', base?.name, ours.name, theirs.name, (v) => (out.name = v as string), (v) => `“${String(v)}”`);
  for (const f of ['width', 'height', 'fps', 'sampleRate', 'background'] as const) {
    scalar(`settings:${f}`, f === 'fps' ? 'Frame rate' : f === 'sampleRate' ? 'Sample rate' : f === 'background' ? 'Background colour' : f === 'width' ? 'Width' : 'Height', base?.settings[f], ours.settings[f], theirs.settings[f], (v) => ((out.settings as unknown as Record<string, unknown>)[f] = v), (v) => (f === 'fps' ? `${(v as { num: number; den: number }).num / (v as { num: number; den: number }).den} fps` : String(v)));
  }

  /* ---- tracks ---- */
  const bT = new Map((base?.tracks ?? []).map((t) => [t.id, t]));
  const oT = new Map(ours.tracks.map((t) => [t.id, t]));
  const tT = new Map(theirs.tracks.map((t) => [t.id, t]));
  const bC = placedMap(base);
  const oC = placedMap(ours);
  const tC = placedMap(theirs);
  const clipsOn = (m: Map<string, Placed>, trackId: string): string => canon([...m.values()].filter((p) => p.trackId === trackId).map((p) => p.clip).sort((a, b) => a.id.localeCompare(b.id)));
  const removedTracks = new Set<string>();
  // Tracks only theirs has: insert after the track that precedes them in theirs.
  theirs.tracks.forEach((t, i) => {
    if (oT.has(t.id)) return;
    if (bT.has(t.id)) {
      // We deleted a track they kept. Conflict if they changed it.
      const changed = !eq(trackProps(bT.get(t.id)), trackProps(t)) || clipsOn(bC, t.id) !== clipsOn(tC, t.id);
      if (!changed) {
        removedTracks.add(t.id);
        return;
      }
      const key = `track-delete:${t.id}`;
      conflicts.push({ key, kind: 'track-delete', label: `Track “${t.name}”`, ours: 'Deleted', theirs: 'Kept and changed', allowBoth: false, range: null });
      if (choose(key) !== 'theirs') {
        removedTracks.add(t.id);
        return;
      }
    } else taken.push(`New track “${t.name}”`);
    const prev = theirs.tracks[i - 1];
    const at = prev ? out.tracks.findIndex((x) => x.id === prev.id) : -1;
    const copy = { ...structuredClone(t), clips: [] };
    if (oT.has(t.id) || out.tracks.some((x) => x.id === t.id)) return;
    out.tracks.splice(at + 1, 0, copy);
  });
  for (const t of out.tracks) t.clips = [];
  for (const o of ours.tracks) {
    const b = bT.get(o.id);
    const t = tT.get(o.id);
    const ot = out.tracks.find((x) => x.id === o.id)!;
    if (!t) {
      if (!b) continue; // ours added it
      // They deleted a track we kept.
      const changed = !eq(trackProps(b), trackProps(o)) || clipsOn(bC, o.id) !== clipsOn(oC, o.id);
      if (!changed) {
        removedTracks.add(o.id);
        taken.push(`Deleted track “${o.name}”`);
        continue;
      }
      const key = `track-delete:${o.id}`;
      conflicts.push({ key, kind: 'track-delete', label: `Track “${o.name}”`, ours: 'Kept and changed', theirs: 'Deleted', allowBoth: false, range: null });
      if (choose(key) === 'theirs') removedTracks.add(o.id);
      continue;
    }
    if (o.kind !== t.kind) continue; // same id, different kinds: only possible when both added it; ours wins, theirs' clips are re-homed below
    for (const f of ['name', 'muted', 'hidden', 'locked', 'volume'] as const) {
      const bv = b?.[f];
      if (eq(o[f], t[f]) || eq(bv, t[f])) continue;
      if (eq(bv, o[f])) {
        (ot as unknown as Record<string, unknown>)[f] = t[f];
        taken.push(`Track “${o.name}”: ${f}`);
        continue;
      }
      const key = `track:${o.id}:${f}`;
      conflicts.push({ key, kind: 'track', label: `Track “${o.name}”: ${f}`, ours: String(o[f]), theirs: String(t[f]), allowBoth: false, range: null });
      if (choose(key) === 'theirs') (ot as unknown as Record<string, unknown>)[f] = t[f];
    }
  }
  out.tracks = out.tracks.filter((t) => !removedTracks.has(t.id));

  /* ---- clips ---- */
  /** Where each clip's final placement came from, for overlap decisions. */
  const origin = new Map<string, 'ours' | 'theirs'>();
  const final = new Map<string, Placed>();
  const ids = [...new Set([...bC.keys(), ...oC.keys(), ...tC.keys()])].sort();
  for (const id of ids) {
    const b = bC.get(id);
    const o = oC.get(id);
    const t = tC.get(id);
    const range = (p?: Placed): [number, number] | null => (p ? [p.clip.start / TPS, clipEnd(p.clip) / TPS] : null);
    if (eq(o, t)) {
      if (o) (final.set(id, o), origin.set(id, 'ours'));
      continue;
    }
    if (eq(b, o)) {
      if (t) {
        final.set(id, t);
        origin.set(id, 'theirs');
        taken.push(b ? `${clipName(t.clip)} changed` : `${clipName(t.clip)} added at ${secs(t.clip.start)}`);
      } else if (o) taken.push(`${clipName(o.clip)} deleted`);
      continue;
    }
    if (eq(b, t)) {
      if (o) (final.set(id, o), origin.set(id, 'ours'));
      continue;
    }
    // Both sides changed this clip.
    if (!o || !t) {
      const key = `clip-delete:${id}`;
      const kept = (o ?? t)!;
      conflicts.push({ key, kind: 'clip-delete', label: `${clipName(kept.clip)} on ${trackName(kept.trackId)}`, ours: o ? 'Changed' : 'Deleted', theirs: t ? 'Changed' : 'Deleted', allowBoth: false, range: range(kept) });
      const side = choose(key) === 'theirs' ? t : o;
      if (side) (final.set(id, side), origin.set(id, side === t ? 'theirs' : 'ours'));
      continue;
    }
    const merged: Record<string, unknown> = { ...(o.clip as unknown as Record<string, unknown>), trackId: o.trackId };
    const clashes: string[] = [];
    for (const g of GROUPS) {
      const bg = pick(b, g.fields);
      const og = pick(o, g.fields);
      const tg = pick(t, g.fields);
      if (eq(og, tg) || eq(bg, tg)) continue;
      if (b && eq(bg, og)) {
        for (const f of g.fields) merged[f] = tg![f];
        continue;
      }
      clashes.push(g.name);
    }
    if (clashes.length) {
      const key = `clip:${id}`;
      conflicts.push({ key, kind: 'clip', label: `${clipName(o.clip)} on ${trackName(o.trackId)}`, ours: describeClip(o, clashes), theirs: describeClip(t, clashes), allowBoth: true, range: range(o) });
      const c = choose(key);
      if (c === 'theirs') (final.set(id, t), origin.set(id, 'theirs'));
      else {
        final.set(id, o);
        origin.set(id, 'ours');
        if (c === 'both') {
          const copy = structuredClone(t.clip);
          // Ids must not depend on display names: decisions are stored by keys built from them.
          copy.id = `${id}-b`;
          final.set(copy.id, { clip: copy, trackId: t.trackId });
          origin.set(copy.id, 'theirs');
        }
      }
      continue;
    }
    const { trackId, ...clip } = merged;
    final.set(id, { clip: clip as unknown as Clip, trackId: trackId as string });
    origin.set(id, eq(merged, { ...(o.clip as unknown as Record<string, unknown>), trackId: o.trackId }) ? 'ours' : 'theirs');
    taken.push(`${clipName(o.clip)} changed`);
  }

  /* ---- place clips, re-home orphans, resolve overlaps ---- */
  const kindOf = (c: Clip): Track['kind'][] => (c.type === 'text' ? ['text'] : ['video', 'audio']);
  for (const [id, p] of final) {
    let track = out.tracks.find((t) => t.id === p.trackId);
    if (!track || !kindOf(p.clip).includes(track.kind)) {
      // Its track was deleted (decision above) — the clip goes with it.
      if (removedTracks.has(p.trackId)) {
        final.delete(id);
        continue;
      }
      track = out.tracks.find((t) => kindOf(p.clip).includes(t.kind));
      if (!track) {
        final.delete(id);
        continue;
      }
      final.set(id, { clip: p.clip, trackId: track.id });
    }
  }
  const extraTracks = new Map<string, Track>();
  const extraParent = new Map<string, string>();
  for (let round = 0; round < 2000; round++) {
    let changed = false;
    for (const track of [...out.tracks, ...extraTracks.values()]) {
      const on = [...final.values()].filter((p) => p.trackId === track.id).sort((a, b) => a.clip.start - b.clip.start || a.clip.id.localeCompare(b.clip.id));
      for (let i = 0; i < on.length && !changed; i++) {
        for (let j = i + 1; j < on.length && !changed; j++) {
          const x = on[i]!;
          const y = on[j]!;
          if (y.clip.start >= clipEnd(x.clip)) break;
          // One of the two was placed by them; the other by us (each side alone was valid).
          // (If neither came from them — a clip re-homed from a deleted track — the later one is treated as incoming.)
          const theirsP = origin.get(x.clip.id) === 'theirs' ? x : y;
          const oursP = theirsP === x ? y : x;
          const key = `overlap:${oursP.clip.id}|${theirsP.clip.id}`;
          if (!conflicts.some((c) => c.key === key)) {
            conflicts.push({ key, kind: 'overlap', label: `${clipName(theirsP.clip)} and ${clipName(oursP.clip)} on ${track.name}`, ours: `${clipName(oursP.clip)} at ${secs(oursP.clip.start)}–${secs(clipEnd(oursP.clip))}`, theirs: `${clipName(theirsP.clip)} at ${secs(theirsP.clip.start)}–${secs(clipEnd(theirsP.clip))}`, allowBoth: true, range: [Math.min(x.clip.start, y.clip.start) / TPS, Math.max(clipEnd(x.clip), clipEnd(y.clip)) / TPS] });
          }
          const c = choose(key);
          if (c === 'both') {
            const tid = `${track.id}-b`;
            if (!extraTracks.has(tid) && !out.tracks.some((t) => t.id === tid)) {
              extraTracks.set(tid, { id: tid, kind: track.kind, name: `${track.name} (${names.theirs})`.slice(0, 60), muted: false, hidden: false, locked: false, volume: 1, clips: [] });
              extraParent.set(tid, track.id);
            }
            final.set(theirsP.clip.id, { clip: theirsP.clip, trackId: tid });
          } else {
            const loser = c === 'theirs' ? oursP : theirsP;
            const revert = (c === 'theirs' ? tC : oC).get(loser.clip.id);
            if (revert && !eq(revert, loser)) {
              final.set(loser.clip.id, revert);
              origin.set(loser.clip.id, c === 'theirs' ? 'theirs' : 'ours');
            } else final.delete(loser.clip.id);
          }
          changed = true;
        }
      }
      if (changed) break;
    }
    if (!changed) break;
  }
  for (const t of extraTracks.values()) {
    const at = out.tracks.findIndex((x) => x.id === extraParent.get(t.id));
    out.tracks.splice(at + 1, 0, t);
  }
  for (const p of final.values()) out.tracks.find((t) => t.id === p.trackId)?.clips.push(p.clip);
  for (const t of out.tracks) t.clips.sort((a, b) => a.start - b.start);
  return { sequence: out, conflicts, taken };
}

function describeClip(p: Placed, groups: string[]): string {
  const c = p.clip;
  const parts: string[] = [];
  if (groups.includes('timing')) parts.push(`${secs(c.start)}–${secs(clipEnd(c))}${c.type === 'media' ? `, source ${secs(c.in)}–${secs(c.out)}${c.speed !== 1 ? `, ${c.speed}×` : ''}` : ''}`);
  if (groups.includes('sound') && c.type === 'media') parts.push(c.muted ? 'muted' : `volume ${Math.round(c.volume * 100)}%`);
  if (groups.includes('fades and transition')) parts.push(`fades ${secs(c.fadeIn)}/${secs(c.fadeOut)}${c.transitionIn ? `, ${c.transitionIn.kind}` : ''}`);
  if (groups.includes('position and crop') && c.type === 'media') parts.push(`at ${c.transform.x},${c.transform.y}, ${Math.round(c.transform.scale * 100)}%`);
  if (groups.includes('text') && c.type === 'text') parts.push(`“${c.text.slice(0, 50)}”${c.template ? ` (${c.template})` : ''}`);
  if (groups.includes('style') && c.type === 'text') parts.push(`${c.style.fontSize}px ${c.style.color}`);
  if (groups.includes('media') && c.type === 'media') parts.push(`media ${c.assetId}`);
  return parts.join('; ') || 'Changed';
}

export function diffSequences(left: Sequence | null, right: Sequence | null, asset: (id: string) => string = (id) => id): SequenceDiffView {
  const L = placedMap(left);
  const R = placedMap(right);
  const name = (c: Clip): string => (c.type === 'text' ? `Title “${c.text.slice(0, 40)}”` : names(c.assetId));
  const names = asset;
  const tn = (seq: Sequence | null, id: string): string => seq?.tracks.find((t) => t.id === id)?.name ?? id;
  const settings: SequenceDiffView['settings'] = [];
  for (const f of ['width', 'height', 'fps', 'sampleRate', 'background'] as const) {
    const a = left ? canon(left.settings[f]) : '—';
    const b = right ? canon(right.settings[f]) : '—';
    if (a !== b) settings.push({ field: f, left: a.replace(/"/g, ''), right: b.replace(/"/g, '') });
  }
  const tracks: SequenceDiffView['tracks'] = [];
  const tl = new Map((left?.tracks ?? []).map((t) => [t.id, t]));
  const tr = new Map((right?.tracks ?? []).map((t) => [t.id, t]));
  for (const id of new Set([...tl.keys(), ...tr.keys()])) {
    const a = tl.get(id);
    const b = tr.get(id);
    const t = (b ?? a)!;
    tracks.push({ id, name: t.name, kind: t.kind, status: !a ? 'added' : !b ? 'deleted' : eq(trackProps(a), trackProps(b)) && clipsEq(L, R, id) ? 'same' : 'changed' });
  }
  const clips: SequenceDiffView['clips'] = [];
  const range = (c: Clip): [number, number] => [c.start / TPS, clipEnd(c) / TPS];
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const a = L.get(id);
    const b = R.get(id);
    if (eq(a, b)) continue;
    const c = (b ?? a)!;
    let status: SequenceDiffView['clips'][number]['status'] = 'changed';
    if (!a) status = 'added';
    else if (!b) status = 'deleted';
    else if (a.trackId !== b.trackId || (a.clip.start !== b.clip.start && clipEnd(a.clip) - a.clip.start === clipEnd(b.clip) - b.clip.start)) status = 'moved';
    else if (a.clip.start !== b.clip.start || clipEnd(a.clip) !== clipEnd(b.clip)) status = 'trimmed';
    clips.push({ id, label: name(c.clip), trackName: tn(b ? right : left, c.trackId), status, left: a ? range(a.clip) : null, right: b ? range(b.clip) : null });
  }
  clips.sort((x, y) => (x.right ?? x.left)![0] - (y.right ?? y.left)![0]);
  const dur = (s: Sequence | null): number => (s ? Math.max(0, ...s.tracks.flatMap((t) => t.clips.map((c) => clipEnd(c)))) / TPS : 0);
  return { name: [left?.name ?? '—', right?.name ?? '—'], settings, tracks, clips, duration: [dur(left), dur(right)] };
}

function clipsEq(a: Map<string, Placed>, b: Map<string, Placed>, trackId: string): boolean {
  const pa = [...a.values()].filter((p) => p.trackId === trackId).map((p) => canon(p.clip)).sort();
  const pb = [...b.values()].filter((p) => p.trackId === trackId).map((p) => canon(p.clip)).sort();
  return pa.join() === pb.join();
}
