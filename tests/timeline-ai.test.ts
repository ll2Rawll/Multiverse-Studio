/**
 * AI and analysis-based timeline edits. Pause detection runs real FFmpeg on generated audio; the
 * model in the free-form test is a scripted MOCK of the OpenAI-compatible protocol (no provider
 * is called). Every edit is a proposal first, then one undoable command with a checkpoint.
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
import { planCaptions, planDuck, planRemovePauses, planTrimTo } from '../src/video/aiEdit';
import { applyVideoCommand, newSequence, parseSequence, sequencePath, serializeSequence } from '../src/video/sequence';
import { TICKS_PER_SECOND, clipEnd, sequenceDuration, type MediaAssetView, type Sequence } from '../src/shared/video';
import { SHARED_LINE_ID } from '../src/shared/types';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
const T = TICKS_PER_SECOND;
let dir = '';
let talk = '';
let music = '';

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-tlai-'));
  talk = path.join(dir, 'talk.mp4');
  // 1 s tone, 2 s silence, 1.5 s tone: one long pause in the middle.
  ff(['-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=25:d=4.5', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1.5', '-filter_complex', '[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk]);
  music = path.join(dir, 'music.wav');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=520:duration=6', music]);
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const media$ = (a: MediaAssetView) => ({ kind: a.kind, duration: a.probe.durationSeconds === null ? null : Math.round(a.probe.durationSeconds * T) });

async function setup(name: string, fetchMock?: typeof fetch) {
  const ws = path.join(dir, name);
  const ai = fetchMock ? new AiService(path.join(ws, 'ai.json'), new MemoryVault(), fetchMock) : undefined;
  const service = new StudioService({ workspaceRoot: ws, sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:1/`, emit: () => {}, ai, cacheRoot: path.join(ws, '.cache') });
  const site = path.join(dir, `${name}-site`);
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><title>x</title>');
  const projectId = (await service.call('projects.import', { folderPath: site }))!.project.id;
  const imported = (await service.call('media.import', { projectId, paths: [talk, music] }))!.imported;
  const run = (name: string, args: Record<string, unknown>) => service.call('commands.run', { projectId, lineId: SHARED_LINE_ID, name, args });
  await run('video.createSequence', { sequence: 'cut', name: 'Interview', settings: { width: 1280, height: 720, fps: { num: 25, den: 1 }, sampleRate: 48000, background: '#000000' } });
  await run('video.addClip', { sequence: 'cut', assetId: imported[0]!.id, media: media$(imported[0]!), clipId: 'talk' });
  await run('video.addClip', { sequence: 'cut', assetId: imported[1]!.id, media: media$(imported[1]!), clipId: 'bed', trackId: 'a1', start: 0 });
  const seq = async (): Promise<Sequence> => (await service.call('sequences.get', { projectId, lineId: SHARED_LINE_ID, sequenceId: 'cut' })).sequence;
  return { service, projectId, imported, run, seq };
}

test('planners are pure and produce ordinary, validated timeline commands', () => {
  const seq = newSequence('s', 'S', { width: 1920, height: 1080, fps: { num: 30, den: 1 }, sampleRate: 48000, background: '#000000' });
  seq.tracks[0]!.clips.push({ id: 'c1', type: 'media', assetId: 'm-a', start: 0, in: 0, out: 10 * T, speed: 1, volume: 1, muted: false, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, crop: { left: 0, right: 0, top: 0, bottom: 0 }, fadeIn: 0, fadeOut: 0, transitionIn: null });
  seq.tracks[2]!.clips.push({ id: 'm1', type: 'media', assetId: 'm-music', start: 0, in: 0, out: 10 * T, speed: 1, volume: 0.8, muted: false, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, crop: { left: 0, right: 0, top: 0, bottom: 0 }, fadeIn: 0, fadeOut: 0, transitionIn: null });
  let files = new Map<string, string | null>([[sequencePath('s'), serializeSequence(seq)]]);
  const apply = (steps: { name: string; args: Record<string, unknown> }[]) => {
    for (const st of steps) files = applyVideoCommand(files, st.name, { sequence: 's', ...st.args }).files;
    return parseSequence(files.get(sequencePath('s'))!);
  };

  const pauses = planRemovePauses(seq, 'v1', new Map([['m-a', [[2, 4], [6, 6.3], [7, 9]]]]), { minPause: 0.7, keep: 0.1 });
  const cut = apply(pauses.steps);
  assert.equal(Math.round(pauses.removed * 10) / 10, 3.6);
  assert.equal(Math.round((sequenceDuration(cut) / T) * 10) / 10 >= 6.3, true, 'the audio track is not rippled, so the sequence keeps its music');
  assert.equal(Math.round((clipEnd(cut.tracks[0]!.clips.at(-1)!) / T) * 10) / 10, 6.4);
  assert.equal(cut.tracks[0]!.clips.length, 3);

  const duck = planDuck(cut, 'a1', [[0.5, 1.5], [3, 4]], 0.25);
  const ducked = apply(duck.steps);
  const vols = ducked.tracks[2]!.clips.map((c) => (c.type === 'media' ? [c.start / T, c.volume] : null));
  assert.deepEqual(vols, [[0, 0.8], [0.5, 0.2], [1.5, 0.8], [3, 0.2], [4, 0.8]]);

  const trimmed = apply(planTrimTo(ducked, 5).steps);
  assert.equal(sequenceDuration(trimmed), 5 * T);

  const caps = planCaptions(trimmed, new Map([['m-a', { assetId: 'm-a', jobId: 'j', language: 'en', model: 'm', createdAt: '', segments: [{ start: 0.2, end: 1.8, text: 'This is a fairly long sentence that should be split into two captions', speaker: null }] }]]), { maxChars: 42 });
  const captioned = apply(caps.steps);
  const capTrack = captioned.tracks.find((t) => t.name === 'Captions')!;
  assert.equal(capTrack.kind, 'text');
  assert.ok(capTrack.clips.length >= 2);
  assert.ok(capTrack.clips.every((c) => c.type === 'text' && c.text.length <= 42));
});

test('remove pauses: real silence detection, a proposal first, then one undoable command and a checkpoint', async () => {
  const h = await setup('pauses');
  const before = await h.seq();
  const proposal = await h.service.call('video.ai.analyze', { projectId: h.projectId, lineId: SHARED_LINE_ID, sequenceId: 'cut', op: 'remove-pauses', options: { trackId: 'v1' } });
  assert.match(proposal.summary, /Remove 1\.\d s of pauses/);
  assert.deepEqual(proposal.sent, [], 'local analysis sends nothing');
  assert.equal(proposal.before.clips, 2);
  assert.equal(proposal.after.clips, 3);
  assert.deepEqual(await h.seq(), before, 'nothing changes until the proposal is applied');

  const checkpoints = (await h.service.call('projects.view', { projectId: h.projectId })).checkpoints.length;
  const applied = await h.service.call('video.ai.apply', { projectId: h.projectId, proposalId: proposal.id });
  assert.equal(applied.lineId, SHARED_LINE_ID);
  const after = await h.seq();
  const talkEnd = clipEnd(after.tracks[0]!.clips.at(-1)!) / T;
  assert.ok(talkEnd > 2.4 && talkEnd < 3.2, `the talk track is now about 2.7 s (got ${talkEnd})`);
  assert.equal((await h.service.call('projects.view', { projectId: h.projectId })).checkpoints.length, checkpoints + 1);
  // The whole operation undoes in one step; the cut clips stayed ordinary, editable clips.
  const step = await h.service.call('commands.step', { projectId: h.projectId, lineId: SHARED_LINE_ID, scope: 'video:cut', direction: 'undo' });
  assert.match(step.label ?? '', /Remove .* pauses/);
  assert.deepEqual(await h.seq(), before);
  await assert.rejects(h.service.call('video.ai.apply', { projectId: h.projectId, proposalId: proposal.id }), /no longer available/);
  await h.service.shutdown();
});

test('a stale proposal is refused; a portrait version is created as a new sequence', async () => {
  const h = await setup('stale');
  const proposal = await h.service.call('video.ai.analyze', { projectId: h.projectId, lineId: SHARED_LINE_ID, sequenceId: 'cut', op: 'trim', options: { seconds: 3 } });
  await h.run('video.setClip', { sequence: 'cut', clipId: 'bed', patch: { volume: 0.5 } });
  await assert.rejects(h.service.call('video.ai.apply', { projectId: h.projectId, proposalId: proposal.id }), /changed after this edit was proposed/);

  const portrait = await h.service.call('video.ai.analyze', { projectId: h.projectId, lineId: SHARED_LINE_ID, sequenceId: 'cut', op: 'portrait', options: {} });
  assert.deepEqual(portrait.newSequences, ['Interview (portrait)']);
  const applied = await h.service.call('video.ai.apply', { projectId: h.projectId, proposalId: portrait.id, asAlternative: { name: 'Portrait cut' } });
  assert.notEqual(applied.lineId, SHARED_LINE_ID, 'applied as a new alternative');
  const list = await h.service.call('sequences.list', { projectId: h.projectId, lineId: applied.lineId });
  const p = list.find((s) => s.name === 'Interview (portrait)')!;
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  const ps = (await h.service.call('sequences.get', { projectId: h.projectId, lineId: applied.lineId, sequenceId: p.id })).sequence;
  const clip = ps.tracks[0]!.clips[0]!;
  assert.ok(clip.type === 'media' && clip.transform.scale > 1.5, 'the 16:9 picture is scaled to fill 9:16');
  assert.equal((await h.service.call('sequences.list', { projectId: h.projectId, lineId: SHARED_LINE_ID })).length, 1, 'Shared is untouched');
  await h.service.shutdown();
});

test('free-form instruction: a mocked model calls timeline tools; errors are fed back; only text is sent', async () => {
  const requests: Record<string, unknown>[] = [];
  const steps: { calls?: { name: string; args: unknown }[]; text?: string }[] = [
    { calls: [{ name: 'add_text', args: { text: 'Kiln Studio', subtitle: 'Spring collection', start_seconds: 0, duration_seconds: 2.5, template: 'lower-third' } }, { name: 'split_clip', args: { clip_id: 'nope', at_seconds: 1 } }] },
    { calls: [{ name: 'set_clip', args: { clip_id: 'bed', volume: 0.4 } }, { name: 'finish', args: { summary: 'Added the product name over the opening shot and lowered the music.' } }] },
  ];
  let n = 0;
  const fetchMock = (async (url: string | URL, init: RequestInit = {}) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'mock/editor' }] });
    requests.push(JSON.parse(String(init.body)));
    const step = steps.shift() ?? { text: 'Done.' };
    const events: string[] = [];
    if (step.text) events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: step.text } }] })}\n\n`);
    step.calls?.forEach((c, index) => {
      n += 1;
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call_${n}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] })}\n\n`);
    });
    events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 60 } })}\n\ndata: [DONE]\n\n`);
    return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const h = await setup('llm', fetchMock);
  await assert.rejects(h.service.call('video.ai.plan', { projectId: h.projectId, lineId: SHARED_LINE_ID, sequenceId: 'cut', instruction: 'Put the product name over the opening shot' }), /No model is assigned/);
  const saved = await h.service.call('ai.connections.save', { name: 'Mock', provider: 'openai-compatible', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1' });
  await h.service.call('ai.models.add', { connectionId: saved.savedId, modelId: 'mock/editor' });
  await h.service.call('ai.routing.set', { job: 'assistant', assignment: { connectionId: saved.savedId, modelId: 'mock/editor' } });

  const before = await h.seq();
  const proposal = await h.service.call('video.ai.plan', { projectId: h.projectId, lineId: SHARED_LINE_ID, sequenceId: 'cut', instruction: 'Put the product name over the opening shot and lower the music' });
  assert.equal(proposal.summary, 'Added the product name over the opening shot and lowered the music.');
  assert.equal(proposal.steps.length, 2, 'the failed split was not included');
  assert.deepEqual(proposal.usage, { inputTokens: 800, outputTokens: 120 });
  assert.match(proposal.sent[0]!, /No media files/);
  // The model saw the error for the bad clip id and could correct itself.
  const second = requests[1]!.messages as { role: string; content: string }[];
  assert.ok(second.some((m) => m.role === 'tool' && /error: .*nope/i.test(String(m.content))));
  // Only a text description was sent: no media bytes, file paths or keys.
  const sentText = JSON.stringify(requests);
  assert.match(sentText, /clip talk: 0–4\.5 s/);
  assert.doesNotMatch(sentText, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(await h.seq(), before);

  await h.service.call('video.ai.apply', { projectId: h.projectId, proposalId: proposal.id });
  const after = await h.seq();
  const title = after.tracks.find((t) => t.kind === 'text')!.clips[0]!;
  assert.ok(title.type === 'text' && title.template === 'lower-third' && title.subtitle === 'Spring collection');
  const bed = after.tracks.flatMap((t) => t.clips).find((c) => c.id === 'bed')!;
  assert.ok(bed.type === 'media' && bed.volume === 0.4);
  // The AI edit is one entry in the same undo history as manual edits, recorded as made by AI.
  const state = await h.service.call('commands.state', { projectId: h.projectId, lineId: SHARED_LINE_ID, scope: 'video:cut' });
  assert.equal(state.undo, proposal.summary);
  const stacks = JSON.parse(await fs.readFile(path.join((await h.service.engine(h.projectId)).dir, 'commands', `${SHARED_LINE_ID}.json`), 'utf8')) as Record<string, { undo: { actor: string; name: string }[] }>;
  assert.deepEqual(stacks['video:cut']!.undo.at(-1)!.actor, 'ai-task');
  assert.equal(stacks['video:cut']!.undo.at(-1)!.name, 'video.batch');
  await h.service.shutdown();
});

test('trims and splits keep fades and transitions inside the clip; ripple closes the hole exactly', () => {
  const seq = newSequence('s', 'S', { width: 1280, height: 720, fps: { num: 30, den: 1 }, sampleRate: 48000, background: '#000000' });
  let files = new Map<string, string | null>([[sequencePath('s'), serializeSequence(seq)]]);
  const run = (name: string, args: Record<string, unknown>) => {
    files = applyVideoCommand(files, name, { sequence: 's', ...args }).files;
    return parseSequence(files.get(sequencePath('s'))!);
  };
  const clip = (s: Sequence, id: string) => s.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  run('video.addClip', { clipId: 'a', assetId: 'm-a', media: { kind: 'video', duration: 6 * T } });
  run('video.setClip', { clipId: 'a', patch: { fadeIn: 2 * T, fadeOut: 2 * T, transitionIn: { kind: 'crossfade', duration: 3 * T } } });
  let s = run('video.trimClip', { clipId: 'a', edge: 'end', at: 2 * T });
  const a = clip(s, 'a');
  assert.ok(a.fadeIn + a.fadeOut <= 2 * T && a.transitionIn!.duration <= 2 * T, 'a shorter clip keeps valid fades');
  // The trimmed clip can still be edited (setClip validates fades against the length).
  run('video.setClip', { clipId: 'a', patch: { volume: 0.5 } });
  // Splits leave at least one frame on each side.
  assert.throws(() => run('video.splitClip', { clipId: 'a', at: 10 }), /at least one frame/);
  s = run('video.splitClip', { clipId: 'a', at: T, newClipId: 'b' });
  for (const c of [clip(s, 'a'), clip(s, 'b')]) assert.ok(c.fadeIn + c.fadeOut <= T && (c.transitionIn?.duration ?? 0) <= T);
  // A slowed clip split off-frame: ripple-deleting the left part puts the right part where it began.
  run('video.deleteClips', { clipIds: ['a', 'b'] });
  run('video.addClip', { clipId: 'p', assetId: 'm-a', media: { kind: 'video', duration: 6 * T }, start: 0, out: T });
  run('video.addClip', { clipId: 'slow', assetId: 'm-a', media: { kind: 'video', duration: 6 * T }, start: T, out: T });
  run('video.setClip', { clipId: 'slow', patch: { speed: 0.3 } });
  s = run('video.splitClip', { clipId: 'slow', at: T + 8002, newClipId: 'right' });
  s = run('video.deleteClips', { clipIds: ['slow'], ripple: true });
  assert.equal(clip(s, 'right').start, T, 'the right part moves to where the deleted part began');
  assert.ok(clip(s, 'right').start >= clipEnd(clip(s, 'p')), 'and never overlaps the clip before it');
});
