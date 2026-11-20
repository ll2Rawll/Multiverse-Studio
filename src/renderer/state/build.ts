/** Build workspace state: run-folder status, processes and their output, panel layout. */
import { create } from 'zustand';
import { call, errorMessage } from '../lib/api';
import { toast } from './store';
import type { BuildProcessView, BuildStateView } from '../../shared/build';
import type { StudioEvent } from '../../shared/types';

const MAX_OUTPUT = 400_000;

export interface BuildUiState {
  /** Keyed by `${projectId}:${lineId}`. */
  states: Record<string, BuildStateView>;
  /** processId → output text received so far. */
  outputs: Record<string, string>;
  /** `${projectId}:${lineId}` → selected process id. */
  selected: Record<string, string | null>;
  panelOpen: boolean;
  panelHeight: number;
  history: string[];
}

export const useBuild = create<BuildUiState>(() => ({
  states: {},
  outputs: {},
  selected: {},
  panelOpen: true,
  panelHeight: 240,
  history: [],
}));

const setB = useBuild.setState;
const getB = useBuild.getState;

export const buildKey = (projectId: string, lineId: string): string => `${projectId}:${lineId}`;

export async function refreshBuild(projectId: string, lineId: string): Promise<BuildStateView | null> {
  try {
    const fetched = await call('build.state', { projectId, lineId });
    const key = buildKey(projectId, lineId);
    // Events may have arrived while this was loading (a process that exited meanwhile): never step a status back.
    const known = new Map([...(getB().states[key]?.processes ?? []), ...(early.get(key) ?? [])].map((p) => [p.id, p]));
    early.delete(key);
    const processes = fetched.processes.map((p) => {
      const k = known.get(p.id);
      return k && RANK[k.status] > RANK[p.status] ? k : p;
    });
    const state = { ...fetched, processes };
    setB((s) => ({ states: { ...s.states, [key]: state } }));
    // Fill in output for processes we have not seen (after a window reload).
    for (const p of state.processes) {
      if (getB().outputs[p.id] === undefined) {
        void call('build.output', { projectId, processId: p.id }).then(
          (o) => setB((s) => ({ outputs: { ...s.outputs, [p.id]: (o.truncated ? '…earlier output was trimmed…\n' : '') + o.output } })),
          () => undefined,
        );
      }
    }
    return state;
  } catch {
    return null;
  }
}

/** Status only moves forward; a late call result must not undo an exit event that arrived first. */
const RANK: Record<BuildProcessView['status'], number> = { starting: 0, running: 0, ready: 1, exited: 2, failed: 2 };

/** Process updates that arrived before the version's build state was loaded. */
const early = new Map<string, BuildProcessView[]>();

function upsertProcess(projectId: string, lineId: string, process: BuildProcessView): void {
  const key = buildKey(projectId, lineId);
  if (!getB().states[key]) {
    const list = early.get(key) ?? [];
    const prev = list.find((p) => p.id === process.id);
    early.set(key, [...list.filter((p) => p.id !== process.id), prev && RANK[prev.status] > RANK[process.status] ? prev : process]);
  }
  setB((s) => {
    const current = s.states[key];
    if (!current) return {};
    const list = current.processes.some((p) => p.id === process.id)
      ? current.processes.map((p) => (p.id === process.id && RANK[process.status] >= RANK[p.status] ? process : p))
      : [...current.processes, process];
    return { states: { ...s.states, [key]: { ...current, processes: list } } };
  });
}

export function handleBuildEvent(event: Extract<StudioEvent, { type: 'build' }>): void {
  upsertProcess(event.projectId, event.lineId, event.process);
  if (event.chunk) {
    setB((s) => {
      const next = (s.outputs[event.process.id] ?? '') + event.chunk;
      return { outputs: { ...s.outputs, [event.process.id]: next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next } };
    });
  }
  if (event.process.kind === 'command' && (event.process.status === 'exited' || event.process.status === 'failed')) {
    // A finished install changes whether the dev server can start.
    if (/^npm (install|i|ci)\b/.test(event.process.label)) void refreshBuild(event.projectId, event.lineId);
  }
  if (event.process.kind === 'dev-server' && event.process.status === 'failed') {
    toast({ tone: 'error', title: 'The dev server stopped', body: 'Its output is in the Build panel.' });
  }
}

function select(projectId: string, lineId: string, processId: string): void {
  setB((s) => ({ selected: { ...s.selected, [buildKey(projectId, lineId)]: processId }, panelOpen: true, outputs: { ...s.outputs, [processId]: s.outputs[processId] ?? '' } }));
}

async function start(projectId: string, lineId: string, run: () => Promise<BuildProcessView>, failTitle: string): Promise<BuildProcessView | null> {
  try {
    const process = await run();
    upsertProcess(projectId, lineId, process);
    select(projectId, lineId, process.id);
    return process;
  } catch (error) {
    toast({ tone: 'error', title: failTitle, body: errorMessage(error) });
    return null;
  }
}

export function runCommand(projectId: string, lineId: string, command: string): Promise<BuildProcessView | null> {
  setB((s) => ({ history: [command, ...s.history.filter((h) => h !== command)].slice(0, 50) }));
  return start(projectId, lineId, () => call('build.run', { projectId, lineId, command }), 'Could not run the command');
}

export function runScript(projectId: string, lineId: string, script: string): Promise<BuildProcessView | null> {
  return start(projectId, lineId, () => call('build.script', { projectId, lineId, script }), `Could not run ${script}`);
}

export function installDependencies(projectId: string, lineId: string): Promise<BuildProcessView | null> {
  return start(projectId, lineId, () => call('build.install', { projectId, lineId }), 'Could not install dependencies');
}

export function startDevServer(projectId: string, lineId: string): Promise<BuildProcessView | null> {
  return start(projectId, lineId, () => call('build.devServer', { projectId, lineId }), 'Could not start the dev server');
}

export async function stopProcess(projectId: string, lineId: string, processId: string): Promise<void> {
  try {
    await call('build.stop', { projectId, processId });
  } catch (error) {
    toast({ tone: 'error', title: 'Could not stop the process', body: errorMessage(error) });
  }
  await refreshBuild(projectId, lineId);
}

export async function bringChangesIn(projectId: string, lineId: string): Promise<void> {
  try {
    const r = await call('build.collect', { projectId, lineId });
    const n = r.changed.length + r.added.length + r.deleted.length;
    if (n === 0 && r.conflicts.length === 0) toast({ tone: 'info', title: 'No changed files in the run folder', body: 'Dependency folders, build output, logs, databases and .env files are never brought in.' });
    else
      toast({
        tone: r.conflicts.length ? 'warning' : 'success',
        title: n ? `Brought in ${n} file${n === 1 ? '' : 's'}` : 'Nothing brought in',
        body: [r.added.length ? `Added: ${r.added.slice(0, 4).join(', ')}${r.added.length > 4 ? '…' : ''}` : '', r.changed.length ? `Changed: ${r.changed.slice(0, 4).join(', ')}${r.changed.length > 4 ? '…' : ''}` : '', r.conflicts.length ? `${r.conflicts.length} could not be merged.` : ''].filter(Boolean).join(' · '),
      });
  } catch (error) {
    toast({ tone: 'error', title: 'Could not bring files in', body: errorMessage(error) });
  }
}

export function clearOutput(processId: string): void {
  setB((s) => ({ outputs: { ...s.outputs, [processId]: '' } }));
}

export function togglePanel(open?: boolean): void {
  setB((s) => ({ panelOpen: open ?? !s.panelOpen }));
}

export function setPanelHeight(height: number): void {
  setB({ panelHeight: Math.max(120, Math.min(640, Math.round(height))) });
}

export function selectProcess(projectId: string, lineId: string, processId: string): void {
  select(projectId, lineId, processId);
}
