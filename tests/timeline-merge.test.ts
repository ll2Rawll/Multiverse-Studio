/**
 * Timelines across versions: structured three-way merges (never line merges of JSON), timeline
 * conflicts during propagation with per-item decisions, combining tracks and clips while keeping
 * their times, and sequence comparison.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { mergeSequences, diffSequences } from '../src/video/merge';
import { newSequence } from '../src/video/sequence';
import { mergeText } from '../src/engine/merge/diff3';
import { TICKS_PER_SECOND, clipEnd, type MediaClip, type Sequence, type TextClip } from '../src/shared/video';
import { SHARED_LINE_ID } from '../src/shared/types';
import { tempDir } from './helpers';

const T = TICKS_PER_SECOND;
const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');

const media = (id: string, start: number, len: number, assetId = 'm-a'): MediaClip => ({ id, type: 'media', assetId, start: start * T, in: 0, out: len * T, speed: 1, volume: 1, muted: false, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, crop: { left: 0, right: 0, top: 0, bottom: 0 }, fadeIn: 0, fadeOut: 0, transitionIn: null });
const title = (id: string, start: number, len: number, text: string): TextClip => ({ id, type: 'text', start: start * T, duration: len * T, text, style: { fontSize: 72, color: '#ffffff', weight: 'semibold', align: 'center', x: 0.5, y: 0.8, box: false, boxColor: '#000000' }, fadeIn: 0, fadeOut: 0, transitionIn: null });

function base(): Sequence {
  const s = newSequence('s', 'Launch', { width: 1920, height: 1080, fps: { num: 30, den: 1 }, sampleRate: 48000, background: '#000000' });
  s.tracks[0]!.clips.push(media('a', 0, 5), media('b', 5, 5, 'm-b'));
  s.tracks[1]!.clips.push(title('t', 0, 2, 'Kiln'));
  return s;
}
const find = (s: Sequence, id: string) => s.tracks.flatMap((t) => t.clips.map((c) => ({ c, track: t.id }))).find((x) => x.c.id === id);

test('different kinds of change to one clip merge; the same kind conflicts as a whole', () => {
  const b = base();
  const ours = structuredClone(b);
  (ours.tracks[0]!.clips[0] as MediaClip).out = 4 * T; // trim a
  const theirs = structuredClone(b);
  (theirs.tracks[0]!.clips[0] as MediaClip).volume = 0.5; // a's sound
  (theirs.tracks[1]!.clips[0] as TextClip).text = 'Kiln Studio';
  const clean = mergeSequences(b, ours, theirs);
  assert.deepEqual(clean.conflicts, []);
  const a = find(clean.sequence, 'a')!.c as MediaClip;
  assert.equal(a.out, 4 * T);
  assert.equal(a.volume, 0.5);
  assert.equal((find(clean.sequence, 't')!.c as TextClip).text, 'Kiln Studio');

  // Both trimmed/moved the same clip: one conflict, never a clip with mixed in and out points.
  const theirs2 = structuredClone(b);
  const ta = theirs2.tracks[0]!.clips[0] as MediaClip;
  ta.in = 1 * T;
  const r = mergeSequences(b, ours, theirs2);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.key, 'clip:a');
  assert.match(r.conflicts[0]!.label, /timing|Clip/);
  const keptOurs = find(r.sequence, 'a')!.c as MediaClip;
  assert.deepEqual([keptOurs.in, keptOurs.out], [0, 4 * T], 'undecided items keep this version');
  const tookTheirs = find(mergeSequences(b, ours, theirs2, { 'clip:a': 'theirs' }).sequence, 'a')!.c as MediaClip;
  assert.deepEqual([tookTheirs.in, tookTheirs.out], [1 * T, 5 * T]);

  // A line-based merge of the same JSON would have silently combined both edits into one clip.
  const json = (s: Sequence) => JSON.stringify(s, null, 1);
  const text = mergeText(json(b), json(ours), json(theirs2));
  if (text.clean) {
    const mixed = (JSON.parse(text.text!) as Sequence).tracks[0]!.clips[0] as MediaClip;
    assert.deepEqual([mixed.in, mixed.out], [1 * T, 4 * T], 'this is the result the structured merge avoids');
  }
});

test('overlapping placements, deletions of changed clips, settings and tracks', () => {
  const b = base();
  const ours = structuredClone(b);
  ours.tracks[1]!.clips.push(title('o1', 3, 2, 'Ours'));
  ours.tracks[0]!.clips.splice(1, 1); // delete b
  ours.settings.width = 1080;
  const theirs = structuredClone(b);
  theirs.tracks[1]!.clips.push(title('t1', 4, 2, 'Theirs'));
  (theirs.tracks[0]!.clips[1] as MediaClip).volume = 0.2; // change b
  theirs.settings.width = 1280;
  theirs.tracks = theirs.tracks.filter((t) => t.id !== 'a1'); // unchanged track deleted by them
  const r = mergeSequences(b, ours, theirs, {}, { asset: (id) => (id === 'm-b' ? 'b-roll.mp4' : id), ours: 'Bold', theirs: 'Shared' });
  const keys = r.conflicts.map((c) => c.key).sort();
  assert.deepEqual(keys, ['clip-delete:b', 'overlap:o1|t1', 'settings:width']);
  assert.match(r.conflicts.find((c) => c.kind === 'clip-delete')!.label, /b-roll\.mp4/);
  assert.ok(!r.sequence.tracks.some((t) => t.id === 'a1'), 'the unchanged track they deleted is gone');
  // Undecided: ours wins, so the result is a valid timeline without overlaps.
  const titles = r.sequence.tracks.find((t) => t.id === 't1')!.clips;
  assert.deepEqual(titles.map((c) => c.id), ['t', 'o1']);
  // Keep both: their title moves to a new track at the same time.
  const both = mergeSequences(b, ours, theirs, { 'overlap:o1|t1': 'both', 'clip-delete:b': 'theirs', 'settings:width': 'theirs' }, { asset: (id) => id, ours: 'Bold', theirs: 'Shared' });
  const extra = both.sequence.tracks.find((t) => t.id === 't1-b')!;
  assert.equal(extra.kind, 'text');
  assert.equal(extra.name, 'Titles (Shared)');
  assert.deepEqual(extra.clips.map((c) => [c.id, c.start / T]), [['t1', 4]]);
  assert.equal(both.sequence.settings.width, 1280);
  assert.equal((find(both.sequence, 'b')!.c as MediaClip).volume, 0.2);
  for (const t of both.sequence.tracks) for (let i = 1; i < t.clips.length; i++) assert.ok(t.clips[i]!.start >= clipEnd(t.clips[i - 1]!));
});

test('compare: a readable diff of two timelines', () => {
  const b = base();
  const other = structuredClone(b);
  (other.tracks[0]!.clips[0] as MediaClip).out = 3 * T;
  other.tracks[0]!.clips[1]!.start = 3 * T;
  other.tracks[1]!.clips.push(title('n', 6, 1, 'New'));
  const d = diffSequences(b, other, (id) => `${id}.mp4`);
  assert.deepEqual(d.clips.map((c) => [c.id, c.status]), [['a', 'trimmed'], ['b', 'moved'], ['n', 'added']]);
  assert.deepEqual(d.duration, [10, 8]);
  assert.equal(d.clips[0]!.label, 'm-a.mp4');
});

async function project() {
  const { dir, cleanup } = await tempDir('mv-tlmerge-');
  const site = path.join(dir, 'site');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><title>x</title>');
  const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => {}, cacheRoot: path.join(dir, 'cache') });
  const projectId = (await service.call('projects.import', { folderPath: site }))!.project.id;
  const run = (lineId: string, name: string, args: Record<string, unknown>) => service.call('commands.run', { projectId, lineId, name, args });
  const seq = async (lineId: string): Promise<Sequence> => (await service.call('sequences.get', { projectId, lineId, sequenceId: 's' })).sequence;
  // A sequence in Shared with two clips (media ids need not exist for merging) and a title.
  await run(SHARED_LINE_ID, 'video.createSequence', { sequence: 's', name: 'Launch', settings: { width: 1280, height: 720, fps: { num: 25, den: 1 }, sampleRate: 48000, background: '#000000' } });
  await run(SHARED_LINE_ID, 'video.addClip', { sequence: 's', assetId: 'm-a', media: { kind: 'video', duration: 10 * T }, clipId: 'a', start: 0, out: 5 * T });
  await run(SHARED_LINE_ID, 'video.addClip', { sequence: 's', assetId: 'm-b', media: { kind: 'video', duration: 10 * T }, clipId: 'b', start: 5 * T, out: 5 * T });
  await run(SHARED_LINE_ID, 'video.addText', { sequence: 's', clipId: 't', start: 0, duration: 2 * T, text: 'Kiln' });
  await service.call('shared.save', { projectId, message: 'First cut' });
  const alt = await service.call('lines.create', { projectId, from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Short', color: 'teal', description: '', following: true });
  return { service, projectId, run, seq, alt: alt.line.id, cleanup };
}

test('propagation merges timelines structurally; conflicting edits become per-item decisions', async () => {
  const h = await project();
  try {
    // Non-overlapping changes merge without asking.
    await h.run(h.alt, 'video.setClip', { sequence: 's', clipId: 'b', patch: { volume: 0.3 } });
    await h.run(SHARED_LINE_ID, 'video.setClip', { sequence: 's', clipId: 't', patch: { text: 'Kiln Studio' } });
    const saved = await h.service.call('shared.save', { projectId: h.projectId, message: 'Rename title' });
    assert.equal(saved.report?.lines.find((l) => l.lineId === h.alt)?.outcome, 'applied');
    let s = await h.seq(h.alt);
    assert.equal((find(s, 't')!.c as TextClip).text, 'Kiln Studio');
    assert.equal((find(s, 'b')!.c as MediaClip).volume, 0.3);

    // Both trim clip a differently, and both put a title at overlapping times.
    await h.run(h.alt, 'video.trimClip', { sequence: 's', clipId: 'a', edge: 'end', at: 3 * T });
    await h.run(h.alt, 'video.addText', { sequence: 's', clipId: 'alt-title', start: 3 * T, duration: 2 * T, text: 'Short cut' });
    await h.run(SHARED_LINE_ID, 'video.trimClip', { sequence: 's', clipId: 'a', edge: 'end', at: 4 * T });
    await h.run(SHARED_LINE_ID, 'video.addText', { sequence: 's', clipId: 'shared-title', start: 4 * T, duration: 2 * T, text: 'Now shipping' });
    const second = await h.service.call('shared.save', { projectId: h.projectId, message: 'Trim and title' });
    assert.equal(second.report?.lines.find((l) => l.lineId === h.alt)?.outcome, 'conflicted');
    const set = (await h.service.call('conflicts.get', { projectId: h.projectId, lineId: h.alt }))!;
    const file = set.files[0]!;
    assert.equal(file.type, 'timeline');
    if (file.type !== 'timeline') return;
    assert.deepEqual(file.items.map((i) => i.key).sort(), ['clip:a', 'overlap:alt-title|shared-title']);
    assert.equal(set.unresolved, 2);
    // Until decided, the alternative keeps its own timeline.
    s = await h.seq(h.alt);
    assert.equal(clipEnd(find(s, 'a')!.c), 3 * T);
    await assert.rejects(h.service.call('conflicts.complete', { projectId: h.projectId, lineId: h.alt }), /resolve every conflict/);

    const after = await h.service.call('conflicts.saveResolution', { projectId: h.projectId, lineId: h.alt, resolution: { path: 'sequences/s.mvseq.json', type: 'timeline', choices: { 'clip:a': 'theirs', 'overlap:alt-title|shared-title': 'both' } } });
    assert.equal(after.unresolved, 0);
    const done = await h.service.call('conflicts.complete', { projectId: h.projectId, lineId: h.alt });
    assert.ok(done.project);
    s = await h.seq(h.alt);
    assert.equal(clipEnd(find(s, 'a')!.c), 4 * T, 'took Shared’s trim');
    assert.equal(find(s, 'alt-title')!.track, 't1');
    assert.equal(find(s, 'shared-title')!.track, 't1-b', 'Shared’s title kept its time on a new track');
    assert.equal(find(s, 'shared-title')!.c.start, 4 * T);
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('combining: take tracks and clips from another version without moving them; no line picks on timelines', async () => {
  const h = await project();
  try {
    const main = (await h.service.call('lines.create', { projectId: h.projectId, from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Main', color: 'violet', description: '', following: true })).line.id;
    await h.run(h.alt, 'video.addTrack', { sequence: 's', kind: 'audio', trackId: 'music' });
    await h.run(h.alt, 'video.addClip', { sequence: 's', assetId: 'm-music', media: { kind: 'audio', duration: 20 * T }, clipId: 'song', trackId: 'music', start: 0, out: 8 * T });
    await h.run(h.alt, 'video.addText', { sequence: 's', clipId: 'cta', start: 3 * T, duration: 2 * T, text: 'Order now' });
    await h.run(main, 'video.addText', { sequence: 's', clipId: 'promo', start: 2.5 * T, duration: 1.5 * T, text: 'Spring sale' });
    const source = { kind: 'line' as const, lineId: h.alt };
    const destination = { kind: 'line' as const, lineId: main };
    const candidates = await h.service.call('combine.candidates', { projectId: h.projectId, source, destination });
    assert.equal(candidates.files.find((f) => f.path === 'sequences/s.mvseq.json')?.timeline, true);

    const hunks = await h.service.call('combine.preview', { projectId: h.projectId, plan: { destination: { kind: 'existing', lineId: main }, files: { 'sequences/s.mvseq.json': { kind: 'hunks', source, hunks: [0] } }, sections: [], edits: {}, description: '' } });
    assert.ok(hunks.warnings.some((w) => w.severity === 'blocking' && /timeline/.test(w.message)));

    const plan = { destination: { kind: 'existing' as const, lineId: main }, files: { 'sequences/s.mvseq.json': { kind: 'timeline' as const, source, tracks: ['music'], clips: ['cta'] } }, sections: [], edits: {}, description: '' };
    const details = await h.service.call('combine.timeline', { projectId: h.projectId, plan, path: 'sequences/s.mvseq.json', source });
    assert.ok(details.source.clips.some((c) => c.id === 'cta' && c.changed));
    assert.ok(details.diff.clips.some((c) => c.id === 'song' && c.status === 'added'));
    const preview = await h.service.call('combine.preview', { projectId: h.projectId, plan });
    assert.ok(preview.ready, JSON.stringify(preview.warnings));
    await h.service.call('combine.apply', { projectId: h.projectId, plan });
    const s = await h.seq(main);
    assert.equal(find(s, 'song')!.track, 'music');
    assert.equal(find(s, 'song')!.c.start, 0);
    // The title overlapped Main's own title, so it went onto a new track at its original time.
    assert.equal(find(s, 'cta')!.c.start, 3 * T);
    assert.equal(find(s, 'cta')!.track, 't1-from');
    assert.equal(find(s, 't')!.track, 't1');

    const diff = await h.service.call('compare.sequence', { projectId: h.projectId, left: { kind: 'line', lineId: main }, right: { kind: 'line', lineId: h.alt }, path: 'sequences/s.mvseq.json' });
    assert.ok(diff.tracks.some((t) => t.id === 't1-from' && t.status === 'deleted'));
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});

test('shared dependency updates: version drift is listed per alternative and aligned as one undoable command', async () => {
  const { dir, cleanup } = await tempDir('mv-deps-');
  const app = path.join(dir, 'app');
  await fs.mkdir(app);
  await fs.writeFile(path.join(app, 'index.html'), '<!doctype html><div id="root"></div>');
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { dev: 'vite' }, dependencies: { react: '^19.1.0', zustand: '^5.0.0' }, devDependencies: { vite: '^7.0.0' } }, null, 2) + '\n');
  const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => {}, cacheRoot: path.join(dir, 'cache') });
  try {
    const projectId = (await service.call('projects.import', { folderPath: app }))!.project.id;
    const alt = (await service.call('lines.create', { projectId, from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Pinned', color: 'amber', description: '', following: false })).line.id;
    const read = async (lineId: string) => (await service.call('files.read', { projectId, ref: { kind: 'line', lineId }, path: 'package.json' })).text!;
    // Shared upgrades React and adds a package; the alternative is not following, so it keeps its versions.
    const updated = JSON.parse(await read(SHARED_LINE_ID));
    updated.dependencies.react = '^19.2.0';
    updated.dependencies.zod = '^4.1.0';
    await service.call('files.write', { projectId, lineId: SHARED_LINE_ID, path: 'package.json', text: JSON.stringify(updated, null, 2) + '\n' });
    await service.call('shared.save', { projectId, message: 'Upgrade React' });
    const status = await service.call('deps.status', { projectId });
    assert.equal(status.packages.length, 1);
    assert.deepEqual(status.packages[0]!.packages.map((p) => [p.name, p.shared, p.here]), [['react', '^19.2.0', '^19.1.0'], ['zod', '^4.1.0', null]]);
    const aligned = await service.call('deps.align', { projectId, lineId: alt, names: ['react'] });
    assert.equal(aligned.label, 'Use react ^19.2.0');
    const text = await read(alt);
    assert.match(text, /"react": "\^19\.2\.0"/);
    assert.doesNotMatch(text, /zod/, 'only the chosen package changed');
    assert.ok(text.startsWith('{\n  "name": "app"'), 'formatting and key order are kept');
    await service.call('commands.step', { projectId, lineId: alt, scope: 'code:package.json', direction: 'undo' });
    assert.match(await read(alt), /"react": "\^19\.1\.0"/);
  } finally {
    await service.shutdown();
    await cleanup();
  }
});

test('an alternative started from Shared’s unsaved draft merges later shared changes against that draft', async () => {
  const h = await project();
  try {
    // An unsaved Shared change, then an alternative started from it (as "apply as new alternative" does).
    await h.run(SHARED_LINE_ID, 'video.setClip', { sequence: 's', clipId: 't', patch: { text: 'Draft title' } });
    const engine = await h.service.engine(h.projectId);
    const alt = await engine.createAlternative({ from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'From draft', color: 'rose', description: '', following: true, includeDraft: true });
    let view = (await h.service.call('projects.view', { projectId: h.projectId })).alternatives.find((a) => a.id === alt.id)!;
    assert.equal(view.status, 'up-to-date');
    assert.equal(view.sharedChangesBehind, 0);
    assert.equal((find(await h.seq(alt.id), 't')!.c as TextClip).text, 'Draft title');
    // The alternative changes the clip's sound; Shared keeps editing the same title, then saves.
    await h.run(alt.id, 'video.setClip', { sequence: 's', clipId: 'a', patch: { volume: 0.4 } });
    await h.run(SHARED_LINE_ID, 'video.setClip', { sequence: 's', clipId: 't', patch: { text: 'Final title' } });
    const saved = await h.service.call('shared.save', { projectId: h.projectId, message: 'Title' });
    assert.equal(saved.report?.lines.find((l) => l.lineId === alt.id)?.outcome, 'applied', 'no artificial conflict');
    const s = await h.seq(alt.id);
    assert.equal((find(s, 't')!.c as TextClip).text, 'Final title');
    assert.equal((find(s, 'a')!.c as MediaClip).volume, 0.4);
    view = (await h.service.call('projects.view', { projectId: h.projectId })).alternatives.find((a) => a.id === alt.id)!;
    assert.equal(view.status, 'up-to-date');
  } finally {
    await h.service.shutdown();
    await h.cleanup();
  }
});
