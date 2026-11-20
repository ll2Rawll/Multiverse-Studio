/**
 * Live AI activity in the interface: tasks and their recent operations, built only from events
 * the engine sent (see src/shared/live.ts). Drives the activity pill, the target highlight and
 * the AI pointer, Follow AI, and pausing a task while the person edits what it is working on.
 */
import { create } from 'zustand';
import type { LiveEvent, LivePhase } from '../../shared/live';
import type { StudioEvent } from '../../shared/types';
import { call, callHooks, errorMessage } from '../lib/api';
import { get as getStudio, set as setStudio, toast, type Workspace } from './store';
import { useDesignUi } from './designUi';
import { preferSequence } from './video';
import { useStoryUi } from './stories';

export type LiveTaskState = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface LiveTask {
  id: string;
  label: string;
  actor: LiveEvent['actor'];
  projectId: string;
  universeId: string | null;
  universeName: string | null;
  state: LiveTaskState;
  phase: LivePhase;
  description: string;
  progress: number | null;
  canPause: boolean;
  startedAt: number;
  lastAt: number;
  current: LiveEvent | null;
  /** Finished operations, newest first (progress updates of one operation replace each other). */
  recent: LiveEvent[];
  /** Resources the task changed, newest first. */
  changed: { key: string; label: string; universeName: string | null; event: LiveEvent }[];
  /** Tests, checks and recordings. */
  validation: LiveEvent[];
  errors: LiveEvent[];
  /** Paused by the studio because the person started editing the same resource. */
  autoPaused: boolean;
}

export interface SavedView {
  workspace: Workspace;
  selectedLineId: string;
  selectedFile: Record<string, string>;
}

interface LiveState {
  tasks: Record<string, LiveTask>;
  /** Most recently active first. */
  order: string[];
  focused: string | null;
  expanded: boolean;
  /** The target being shown (coalesced: rapid events show the latest). */
  visual: { event: LiveEvent; seq: number } | null;
  /** Where the person was before Follow AI or “View activity” moved the view. */
  returnTo: SavedView | null;
}

export const useLive = create<LiveState>(() => ({ tasks: {}, order: [], focused: null, expanded: false, visual: null, returnTo: null }));
const setL = useLive.setState;
const getL = useLive.getState;

const MAX_RECENT = 40;
const COALESCE_MS = 180;
const APP_IDLE_MS = 45_000;
const APP_GONE_MS = 4 * 60_000;
const DONE_HIDE_MS = 12_000;

let visualSeq = 0;
let lastVisualAt = 0;
let pendingVisual: LiveEvent | null = null;
let visualTimer = 0;

function showVisual(event: LiveEvent): void {
  const now = performance.now();
  const apply = (e: LiveEvent): void => {
    lastVisualAt = performance.now();
    pendingVisual = null;
    setL({ visual: { event: e, seq: ++visualSeq } });
    maybeFollow(e);
  };
  if (now - lastVisualAt >= COALESCE_MS && !visualTimer) return apply(event);
  // Several actions in quick succession: show the newest once, keep all of them in the history.
  pendingVisual = event;
  if (!visualTimer)
    visualTimer = window.setTimeout(
      () => {
        visualTimer = 0;
        if (pendingVisual) apply(pendingVisual);
      },
      Math.max(0, COALESCE_MS - (now - lastVisualAt)),
    );
}

const stateFor = (e: LiveEvent, prev: LiveTaskState | undefined): LiveTaskState => {
  switch (e.kind) {
    case 'task.completed':
      return 'completed';
    case 'task.failed':
      return 'failed';
    case 'task.cancelled':
      return 'cancelled';
    case 'task.paused':
      return 'paused';
    case 'task.resumed':
    case 'task.started':
      return 'running';
    default:
      return prev === 'paused' && e.phase !== 'waiting' ? 'paused' : 'running';
  }
};

export function handleLiveEvent(event: StudioEvent): void {
  if (event.type !== 'live') return;
  const e = event.event;
  if (getStudio().project?.id !== e.projectId) return;
  const now = Date.now();
  const prev = getL().tasks[e.taskId];
  const fresh = !prev || e.kind === 'task.started' || (prev.state !== 'running' && prev.state !== 'paused');
  const base: LiveTask = fresh
    ? { id: e.taskId, label: e.taskLabel, actor: e.actor, projectId: e.projectId, universeId: e.universeId, universeName: e.universeName, state: 'running', phase: e.phase, description: e.description, progress: null, canPause: e.canPause || e.actor === 'ai-app', startedAt: now, lastAt: now, current: null, recent: [], changed: [], validation: [], errors: [], autoPaused: false }
    : prev!;
  const state = stateFor(e, base.state);
  const task: LiveTask = {
    ...base,
    label: e.taskLabel || base.label,
    universeId: e.universeId ?? base.universeId,
    universeName: e.universeName ?? base.universeName,
    state,
    phase: e.phase,
    description: e.description,
    progress: e.progress,
    lastAt: now,
    current: e,
    autoPaused: state === 'paused' ? base.autoPaused : false,
  };
  const finished = e.kind === 'operation.completed' || e.kind === 'operation.failed' || e.kind === 'operation.progress';
  if (finished && e.operationId) task.recent = [e, ...task.recent.filter((r) => r.operationId !== e.operationId)].slice(0, MAX_RECENT);
  else if (finished || e.kind.startsWith('task.')) task.recent = [e, ...task.recent].slice(0, MAX_RECENT);
  if (e.kind === 'operation.completed' && e.phase === 'editing' && e.target) {
    const t = e.target;
    const label = t.kind === 'code' ? t.path : t.kind === 'element' ? t.page : t.kind === 'clip' || t.kind === 'track' ? `Sequence ${t.sequenceId}` : t.kind === 'universe' ? (e.universeName ?? 'A universe') : t.kind === 'asset' ? 'An asset' : t.kind === 'object' ? `Object ${t.objectId}` : (e.resourceId ?? e.description);
    const key = `${e.universeId ?? ''}|${label}`;
    task.changed = [{ key, label, universeName: e.universeName, event: e }, ...task.changed.filter((c) => c.key !== key)].slice(0, 30);
  }
  if ((e.phase === 'testing' || e.phase === 'recording' || e.phase === 'failed') && (e.kind === 'operation.completed' || e.kind === 'operation.failed') && (e.operation?.startsWith('story.') || e.operation === 'run_tests' || e.operation === 'run_browser_check' || e.operation === 'code.runTests')) {
    task.validation = [e, ...task.validation.filter((v) => v.operationId !== e.operationId)].slice(0, 20);
  }
  if (e.kind === 'operation.failed' || e.kind === 'task.failed') task.errors = [e, ...task.errors].slice(0, 20);
  setL((s) => {
    const order = [e.taskId, ...s.order.filter((id) => id !== e.taskId)];
    const focusedTask = s.focused ? s.tasks[s.focused] : null;
    const keepFocus = s.focused && s.focused !== e.taskId && focusedTask && (focusedTask.state === 'running' || focusedTask.state === 'paused');
    return { tasks: { ...s.tasks, [e.taskId]: task }, order, focused: keepFocus ? s.focused : e.taskId };
  });
  // Failed story steps stay visible (they point at what broke); other failures have no target.
  if (getL().focused === e.taskId && e.target && (e.kind !== 'operation.failed' || e.target.kind === 'story-step')) showVisual(e);
  schedule();
}

/* ---------- Housekeeping: idle connected apps, finished tasks (one timer, only while needed). ---------- */
let sweepTimer = 0;
function schedule(): void {
  if (sweepTimer) return;
  sweepTimer = window.setTimeout(sweep, 5000);
}
function sweep(): void {
  sweepTimer = 0;
  const now = Date.now();
  const s = getL();
  const tasks = { ...s.tasks };
  let changed = false;
  for (const t of Object.values(tasks)) {
    const idle = now - t.lastAt;
    if (t.actor === 'ai-app' && t.state === 'running' && idle > APP_IDLE_MS && t.phase !== 'waiting') {
      // A connected app has no “finished” signal: say honestly that it is not doing anything now.
      tasks[t.id] = { ...t, phase: 'waiting', description: `Waiting for ${t.label}`, progress: null };
      changed = true;
    }
    const gone = t.actor === 'ai-app' ? idle > APP_GONE_MS && t.state !== 'paused' : (t.state === 'completed' || t.state === 'cancelled') && idle > DONE_HIDE_MS && !s.expanded;
    if (gone) {
      delete tasks[t.id];
      changed = true;
    }
  }
  if (changed) {
    const order = s.order.filter((id) => tasks[id]);
    const focused = s.focused && tasks[s.focused] ? s.focused : (order[0] ?? null);
    setL({ tasks, order, focused, ...(focused ? {} : { expanded: false }) });
  }
  if (Object.keys(tasks).length > 0) schedule();
}

/* ---------- Controls ---------- */
const appName = (taskId: string): string | null => (taskId.startsWith('app:') ? taskId.slice(4) : null);
const taskIdOf = (taskId: string): string | null => (taskId.startsWith('task:') && taskId !== 'task:ai' ? taskId.slice(5) : null);

export function focusTask(id: string): void {
  setL({ focused: id });
  const e = getL().tasks[id]?.current;
  if (e?.target) showVisual(e);
}

export function setExpanded(expanded: boolean): void {
  setL({ expanded });
}

export function dismissTask(id: string): void {
  setL((s) => {
    const tasks = { ...s.tasks };
    delete tasks[id];
    const order = s.order.filter((x) => x !== id);
    return { tasks, order, focused: s.focused === id ? (order[0] ?? null) : s.focused, expanded: order.length ? s.expanded : false };
  });
}

export async function pauseTask(id: string, reason: 'user-edit' | null = null): Promise<void> {
  const t = getL().tasks[id];
  if (!t) return;
  try {
    const app = appName(id);
    if (app) await call('connector.hold', { app, held: true, projectId: t.projectId });
    else {
      const taskId = taskIdOf(id);
      if (!taskId) return;
      await call('ai.tasks.pause', { projectId: t.projectId, taskId, reason });
    }
    setL((s) => (s.tasks[id] ? { tasks: { ...s.tasks, [id]: { ...s.tasks[id]!, autoPaused: reason === 'user-edit' } } } : {}));
  } catch (error) {
    if (!reason) toast({ tone: 'error', title: 'Could not pause', body: errorMessage(error) });
  }
}

export async function resumeTask(id: string): Promise<void> {
  const t = getL().tasks[id];
  if (!t) return;
  try {
    const app = appName(id);
    if (app) await call('connector.hold', { app, held: false, projectId: t.projectId });
    else {
      const taskId = taskIdOf(id);
      if (taskId) await call('ai.tasks.resume', { projectId: t.projectId, taskId });
    }
    setL((s) => (s.tasks[id] ? { tasks: { ...s.tasks, [id]: { ...s.tasks[id]!, autoPaused: false, ...(s.tasks[id]!.actor === 'ai-app' ? { state: 'running' as const } : {}) } } } : {}));
  } catch (error) {
    toast({ tone: 'error', title: 'Could not resume', body: errorMessage(error) });
  }
}

/** Stop: cancels a built-in task; for a connected app, refuses its further changes until allowed again. */
export async function stopTask(id: string): Promise<void> {
  const t = getL().tasks[id];
  if (!t) return;
  try {
    const app = appName(id);
    if (app) {
      await call('connector.hold', { app, held: true, projectId: t.projectId });
      setL((s) => (s.tasks[id] ? { tasks: { ...s.tasks, [id]: { ...s.tasks[id]!, state: 'paused', phase: 'paused', description: `Stopped changes from ${app}`, progress: null } } } : {}));
      return;
    }
    const taskId = taskIdOf(id);
    if (taskId) await call('ai.tasks.cancel', { projectId: t.projectId, taskId });
  } catch (error) {
    toast({ tone: 'error', title: 'Could not stop', body: errorMessage(error) });
  }
}

/* ---------- Revealing the work (Follow AI, “View activity”) ---------- */
const WORKSPACE_FOR: Record<string, Workspace> = { code: 'build', element: 'design', locator: 'stories', 'story-step': 'stories', clip: 'video', track: 'video', asset: 'assets', object: 'assets', universe: 'explore' };

function saveView(): void {
  if (getL().returnTo) return;
  const s = getStudio();
  setL({ returnTo: { workspace: s.workspace, selectedLineId: s.selectedLineId, selectedFile: { ...s.selectedFile } } });
}

/** Open the workspace, universe and resource an event is about. */
export function revealEvent(e: LiveEvent): void {
  const s = getStudio();
  const project = s.project;
  if (!project || project.id !== e.projectId) return;
  const lines = [project.shared, ...project.alternatives];
  const lineId = e.universeId && lines.some((l) => l.id === e.universeId) ? e.universeId : s.selectedLineId;
  const t = e.target;
  saveView();
  if (!t) {
    if (lineId !== s.selectedLineId) setStudio({ selectedLineId: lineId });
    return;
  }
  const workspace = WORKSPACE_FOR[t.kind] ?? s.workspace;
  if (t.kind === 'code') setStudio({ workspace, selectedLineId: lineId, selectedFile: { ...s.selectedFile, [lineId]: t.path } });
  else if (t.kind === 'element') {
    useDesignUi.setState((d) => ({ page: { ...d.page, [`${project.id}:${lineId}`]: t.page } }));
    setStudio({ workspace, selectedLineId: lineId });
  } else if (t.kind === 'clip' || t.kind === 'track') {
    preferSequence(project.id, lineId, t.sequenceId);
    setStudio({ workspace, selectedLineId: lineId });
  } else if (t.kind === 'story-step') {
    useStoryUi.setState({ want: { storyId: t.storyId, at: Date.now() } });
    setStudio({ workspace, selectedLineId: lineId });
  } else if (t.kind === 'universe') setStudio({ workspace });
  else setStudio({ workspace, selectedLineId: lineId });
}

/** “View activity”: jump to where the focused task is working. */
export function viewActivity(id?: string): void {
  const t = getL().tasks[id ?? getL().focused ?? ''];
  const e = t && ([t.current, ...t.recent].find((x) => x?.target) ?? t.current);
  if (!e) return;
  revealEvent(e);
  if (e.target) showVisual(e);
}

export function returnToView(): void {
  const r = getL().returnTo;
  setL({ returnTo: null });
  if (!r) return;
  const project = getStudio().project;
  const exists = project && [project.shared, ...project.alternatives].some((l) => l.id === r.selectedLineId);
  setStudio({ workspace: r.workspace, selectedLineId: exists ? r.selectedLineId : getStudio().selectedLineId, selectedFile: r.selectedFile });
}

export function forgetReturn(): void {
  setL({ returnTo: null });
}

/* ---------- The person comes first ---------- */
let lastUserInput = 0;
if (typeof window !== 'undefined') {
  const mark = (): void => {
    lastUserInput = Date.now();
  };
  window.addEventListener('pointerdown', mark, { capture: true, passive: true });
  window.addEventListener('keydown', mark, { capture: true, passive: true });
  window.addEventListener('wheel', mark, { capture: true, passive: true });
}

let followAt = 0;
function maybeFollow(e: LiveEvent): void {
  const s = getStudio();
  if (!s.settings.followAi || !e.target || getL().focused !== e.taskId) return;
  // Never yank the view while the person is in the middle of something.
  if (Date.now() - lastUserInput < 2500 || Date.now() - followAt < 600 || s.dialog) return;
  followAt = Date.now();
  revealEvent(e);
}

const AUTO_RESUME_MS = 2500;
let resumeTimer = 0;

/**
 * The person edited a resource. If a running AI task is working on the same resource in the same
 * universe, pause it (“Paused while you edit”) and resume shortly after they stop. The revision
 * checks still refuse any stale AI write, so nothing the person typed is overwritten.
 */
export function noteUserEdit(projectId: string, lineId: string, resource: string | null): void {
  if (!resource) return;
  const { tasks } = getL();
  for (const t of Object.values(tasks)) {
    if (t.projectId !== projectId || t.state !== 'running' || !t.canPause) continue;
    const touching = t.recent.slice(0, 6).some((e) => e.universeId === lineId && (e.resourceId === resource || (e.target?.kind === 'code' && e.target.path === resource) || (e.target && 'page' in e.target && e.target.page === resource) || (e.target && 'sequenceId' in e.target && e.target.sequenceId === resource)));
    if (touching) void pauseTask(t.id, 'user-edit');
  }
  window.clearTimeout(resumeTimer);
  resumeTimer = window.setTimeout(() => {
    for (const t of Object.values(getL().tasks)) if (t.autoPaused && t.state === 'paused') void resumeTask(t.id);
  }, AUTO_RESUME_MS);
}

// Every edit the person makes reaches the engine through these channels.
callHooks.push((channel, input) => {
  const i = input as { projectId?: string; lineId?: string; path?: string; name?: string; args?: Record<string, unknown> };
  if (!i.projectId || !i.lineId) return;
  if (channel === 'files.write' || channel === 'files.save') noteUserEdit(i.projectId, i.lineId, i.path ?? null);
  else if (channel === 'commands.run') {
    const a = i.args ?? {};
    const resource = typeof a.sequence === 'string' ? a.sequence : typeof a.page === 'string' ? a.page : typeof a.object === 'string' ? a.object : typeof a.path === 'string' ? a.path : null;
    noteUserEdit(i.projectId, i.lineId, resource);
  }
});

/** Text for the pill: what is happening, and where when it is not the universe on screen. */
export function pillText(t: LiveTask, selectedLineId: string): string {
  const where = t.universeId && t.universeId !== selectedLineId && t.universeName ? ` · ${t.universeName}` : '';
  return `${t.description}${where}`;
}
