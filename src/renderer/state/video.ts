/** Video workspace state: tools, media library, the open sequence, playhead, selection and exports. */
import { create } from 'zustand';
import { call, errorMessage, ApiError } from '../lib/api';
import { toast } from './store';
import { TICKS_PER_SECOND, type ExportJobView, type ExportSettings, type MediaAssetView, type Sequence, type SequenceSummary, type VideoToolsView, type WaveformView } from '../../shared/video';
import type { StudioEvent } from '../../shared/types';

export interface VideoUiState {
  tools: VideoToolsView | null;
  projectId: string | null;
  lineId: string | null;
  media: MediaAssetView[];
  sequences: SequenceSummary[];
  sequenceId: string | null;
  sequence: Sequence | null;
  hash: string | null;
  loadError: string | null;
  playhead: number;
  playing: boolean;
  selection: string[];
  /** Pixels per second on the timeline. */
  zoom: number;
  snapping: boolean;
  jobs: ExportJobView[];
  waveforms: Record<string, WaveformView>;
  undo: string | null;
  redo: string | null;
  busy: boolean;
  /** The AI edit dialog is open. */
  aiDialog: boolean;
}

export const useVideo = create<VideoUiState>(() => ({
  tools: null,
  projectId: null,
  lineId: null,
  media: [],
  sequences: [],
  sequenceId: null,
  sequence: null,
  hash: null,
  loadError: null,
  playhead: 0,
  playing: false,
  selection: [],
  zoom: 80,
  snapping: true,
  jobs: [],
  waveforms: {},
  undo: null,
  redo: null,
  busy: false,
  aiDialog: false,
}));

const setV = useVideo.setState;
const getV = useVideo.getState;

const lastSequence = new Map<string, string>();
/** Each load (and each local change) takes a number; results of an older load are dropped, so a slow first load can't undo a sequence created meanwhile. */
let generation = 0;

export async function loadVideo(projectId: string, lineId: string): Promise<void> {
  const gen = ++generation;
  const switching = getV().projectId !== projectId || getV().lineId !== lineId;
  if (switching) setV({ projectId, lineId, sequence: null, hash: null, selection: [], playhead: 0, playing: false });
  try {
    const [tools, sequences, jobs] = await Promise.all([getV().tools ? Promise.resolve(getV().tools!) : call('video.tools', {}), call('sequences.list', { projectId, lineId }), call('video.export.list', { projectId })]);
    if (gen !== generation) return;
    setV({ tools, sequences, jobs, loadError: null });
    const key = `${projectId}:${lineId}`;
    const wanted = getV().sequenceId && sequences.some((s) => s.id === getV().sequenceId) && !switching ? getV().sequenceId : (lastSequence.get(key) ?? sequences[0]?.id ?? null);
    const id = wanted && sequences.some((s) => s.id === wanted) ? wanted : (sequences[0]?.id ?? null);
    setV({ sequenceId: id });
    await Promise.all([refreshMedia(), id ? loadSequence(id) : Promise.resolve(setV({ sequence: null, hash: null }))]);
  } catch (error) {
    setV({ loadError: errorMessage(error) });
  }
}

export async function refreshMedia(): Promise<void> {
  const { projectId, lineId } = getV();
  if (!projectId) return;
  try {
    setV({ media: await call('media.list', { projectId, lineId: lineId ?? undefined }) });
  } catch {
    // tools may be missing; the workspace explains that
  }
}

/** Open this sequence next time the universe's video loads, or now if it is loaded (Follow AI). */
export function preferSequence(projectId: string, lineId: string, sequenceId: string): void {
  lastSequence.set(`${projectId}:${lineId}`, sequenceId);
  const v = getV();
  if (v.projectId === projectId && v.lineId === lineId && v.sequenceId !== sequenceId && v.sequences.some((s) => s.id === sequenceId)) void loadSequence(sequenceId);
}

export async function loadSequence(sequenceId: string): Promise<void> {
  const { projectId, lineId } = getV();
  if (!projectId || !lineId) return;
  try {
    const r = await call('sequences.get', { projectId, lineId, sequenceId });
    lastSequence.set(`${projectId}:${lineId}`, sequenceId);
    const ids = new Set(r.sequence.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    const stacks = await call('commands.state', { projectId, lineId, scope: `video:${sequenceId}` }).catch(() => ({ undo: null, redo: null }));
    setV((s) => ({ sequenceId, sequence: r.sequence, hash: r.hash, selection: s.selection.filter((id) => ids.has(id)), loadError: null, undo: stacks.undo, redo: stacks.redo }));
  } catch (error) {
    setV({ sequence: null, hash: null, loadError: errorMessage(error) });
  }
}

/** Run a timeline command against the open sequence (checked against the version it was built on). */
export async function runVideo(name: string, args: Record<string, unknown>): Promise<boolean> {
  const { projectId, lineId, sequenceId, hash } = getV();
  if (!projectId || !lineId || !sequenceId) return false;
  setV({ busy: true });
  try {
    const r = await call('commands.run', { projectId, lineId, name, args: { sequence: sequenceId, ...args }, expected: hash ? { [`sequences/${sequenceId}.mvseq.json`]: hash } : undefined });
    setV({ undo: r.undo, redo: r.redo });
    await loadSequence(sequenceId);
    return true;
  } catch (error) {
    const stale = error instanceof ApiError && error.code === 'stale-command';
    toast({ tone: stale ? 'warning' : 'error', title: stale ? 'The sequence changed elsewhere' : 'Could not change the timeline', body: stale ? 'It has been reloaded. Try again.' : errorMessage(error) });
    await loadSequence(sequenceId);
    return false;
  } finally {
    setV({ busy: false });
  }
}

export async function stepVideo(direction: 'undo' | 'redo'): Promise<void> {
  const { projectId, lineId, sequenceId } = getV();
  if (!projectId || !lineId || !sequenceId) return;
  try {
    const r = await call('commands.step', { projectId, lineId, scope: `video:${sequenceId}`, direction });
    setV({ undo: r.undo, redo: r.redo });
    if (r.label) toast({ tone: 'info', title: `${direction === 'undo' ? 'Undid' : 'Redid'}: ${r.label}` });
    await loadSequence(sequenceId);
  } catch (error) {
    toast({ tone: 'error', title: `Could not ${direction}`, body: errorMessage(error) });
  }
}

/** Takes the project and version from the caller, so it works even before the workspace finished loading. */
export async function createSequence(projectId: string, lineId: string, name: string, width: number, height: number, fps: number): Promise<void> {
  if (getV().projectId !== projectId || getV().lineId !== lineId) setV({ projectId, lineId });
  generation++;
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'sequence';
  let id = base;
  for (let i = 2; getV().sequences.some((s) => s.id === id); i++) id = `${base}-${i}`;
  try {
    const r = await call('commands.run', { projectId, lineId, name: 'video.createSequence', args: { sequence: id, name, settings: { width, height, fps: { num: fps, den: 1 }, sampleRate: 48000, background: '#000000' } } });
    setV({ sequenceId: id, undo: r.undo, redo: r.redo, playhead: 0, selection: [] });
    setV({ sequences: await call('sequences.list', { projectId, lineId }) });
    await loadSequence(id);
  } catch (error) {
    toast({ tone: 'error', title: 'Could not create the sequence', body: errorMessage(error) });
  }
}

export async function importMedia(paths?: string[]): Promise<void> {
  const { projectId } = getV();
  if (!projectId) return;
  try {
    const r = await call('media.import', { projectId, ...(paths ? { paths } : {}) });
    if (!r) return;
    if (r.imported.length) toast({ tone: 'success', title: `Imported ${r.imported.length} file${r.imported.length === 1 ? '' : 's'}`, body: 'Copied into the project. Thumbnails and waveforms are being prepared.' });
    for (const f of r.failed) toast({ tone: 'error', title: `Could not import ${f.name}`, body: f.reason });
    await refreshMedia();
  } catch (error) {
    toast({ tone: 'error', title: 'Could not import', body: errorMessage(error) });
  }
}

export async function relinkMedia(assetId: string): Promise<void> {
  const { projectId } = getV();
  if (!projectId) return;
  try {
    const r = await call('media.relink', { projectId, assetId });
    if (!r) return;
    toast({ tone: 'success', title: r.sameContent ? 'Media found again' : `Relinked to ${r.asset.name}`, body: r.sameContent ? undefined : 'Every clip that used the old file now uses this one.' });
    await refreshMedia();
  } catch (error) {
    toast({ tone: 'error', title: 'Could not relink', body: errorMessage(error) });
  }
}

export async function loadWaveform(assetId: string): Promise<void> {
  const { projectId, waveforms } = getV();
  if (!projectId || waveforms[assetId]) return;
  try {
    const w = await call('media.waveform', { projectId, assetId });
    setV((s) => ({ waveforms: { ...s.waveforms, [assetId]: w } }));
  } catch {
    // shown without a waveform
  }
}

export async function startExport(settings: ExportSettings): Promise<boolean> {
  const { projectId, lineId, sequenceId } = getV();
  if (!projectId || !lineId || !sequenceId) return false;
  try {
    const job = await call('video.export.start', { projectId, lineId, sequenceId, settings });
    if (!job) return false;
    upsertJob(job);
    return true;
  } catch (error) {
    toast({ tone: 'error', title: 'Could not export', body: errorMessage(error) });
    return false;
  }
}

export async function cancelExport(jobId: string): Promise<void> {
  const { projectId } = getV();
  if (projectId) upsertJob(await call('video.export.cancel', { projectId, jobId }));
}

export async function revealExport(jobId: string): Promise<void> {
  const { projectId } = getV();
  if (!projectId) return;
  try {
    await call('video.export.reveal', { projectId, jobId });
  } catch (error) {
    toast({ tone: 'error', title: 'Could not show the file', body: errorMessage(error) });
  }
}

function upsertJob(job: ExportJobView): void {
  setV((s) => ({ jobs: s.jobs.some((j) => j.id === job.id) ? s.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...s.jobs] }));
}

export function handleVideoEvent(event: StudioEvent): void {
  const s = getV();
  if (event.type === 'media' && event.projectId === s.projectId) void refreshMedia();
  if (event.type === 'video-job' && event.projectId === s.projectId) {
    const before = s.jobs.find((j) => j.id === event.job.id)?.state;
    upsertJob(event.job);
    if (before !== event.job.state && event.job.state === 'completed') toast({ tone: 'success', title: `Exported ${event.job.sequenceName}`, body: event.job.verified ? `${event.job.verified.width}×${event.job.verified.height}, ${event.job.verified.durationSeconds.toFixed(1)} s, checked by reading the file back.` : undefined });
    if (before !== event.job.state && event.job.state === 'failed') toast({ tone: 'error', title: `Export of ${event.job.sequenceName} failed`, body: event.job.error?.split('\n')[0] });
  }
}

export function setPlayhead(t: number): void {
  const seq = getV().sequence;
  const max = seq ? Math.max(0, ...seq.tracks.flatMap((tr) => tr.clips.map((c) => (c.type === 'text' ? c.start + c.duration : c.start + Math.round((c.out - c.in) / c.speed))))) : 0;
  setV({ playhead: Math.max(0, Math.min(Math.round(t), Math.max(max, 0))) });
}

export function setPlaying(playing: boolean): void {
  setV({ playing });
}

export function select(ids: string[]): void {
  setV({ selection: ids });
}

export function setZoom(zoom: number): void {
  setV({ zoom: Math.max(4, Math.min(600, zoom)) });
}

export const fmtTime = (ticks: number, fps = 30): string => {
  const total = ticks / TICKS_PER_SECOND;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total - Math.floor(total)) * fps);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
};

export const getVideo = getV;
export const setVideo = setV;
