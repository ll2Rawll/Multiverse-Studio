/**
 * Renderer state for AI: connection view, tasks of the open project, the open conversation and the
 * composer. Holds no secrets: keys are typed into a field, sent once to the privileged side and
 * cleared from the form.
 */
import { create } from 'zustand';
import type { AiStateView, ProjectAiSettings, StudioReference, TaskMode, TaskPermissionsView, TaskSummary, TaskView } from '../../shared/ai';
import { TICKS_PER_SECOND } from '../../shared/video';
import { useVideo } from './video';
import { useSelectionRefs } from './selection';
import { ACTIVE_TASK_STATES } from '../../shared/ai';
import type { TaskSendPreview } from '../../shared/ipc';
import type { StudioEvent } from '../../shared/types';
import { call, errorMessage as describeError } from '../lib/api';
import { get as getStudio, set as setStudio, toast } from './store';

export type RightPanel = 'assistant' | 'tasks' | 'inspector';

interface AiUiState {
  ai: AiStateView | null;
  panel: RightPanel;
  tasks: TaskSummary[];
  taskViews: Record<string, TaskView>;
  openTaskId: string | null;
  mode: TaskMode;
  draft: string;
  attachments: string[];
  preview: TaskSendPreview | null;
  sending: boolean;
  /** Routine permissions granted to new Build tasks. */
  permissions: TaskPermissionsView;
  artifactUrls: Record<string, string>;
  /** Per-project AI settings of the open project (Autopilot). */
  projectAi: ProjectAiSettings | null;
  /** Reference chips the user removed from the composer (`kind:id`). */
  removedRefs: string[];
}

export const useAi = create<AiUiState>(() => ({
  ai: null,
  panel: 'inspector',
  tasks: [],
  taskViews: {},
  openTaskId: null,
  mode: 'ask',
  draft: '',
  attachments: [],
  preview: null,
  sending: false,
  permissions: { editAlternative: true, runBuildAndTests: true, installDependencies: false, operatePreview: true },
  artifactUrls: {},
  projectAi: null,
  removedRefs: [],
}));

const setAi = useAi.setState;
const getAi = useAi.getState;

export function setPanel(panel: RightPanel): void {
  setAi({ panel });
  if (getStudio().inspectorCollapsed) setStudio({ inspectorCollapsed: false });
}

export async function loadAiState(): Promise<AiStateView | null> {
  try {
    const ai = await call('ai.state', {});
    setAi({ ai });
    return ai;
  } catch {
    return null;
  }
}

export function applyAiState(ai: AiStateView): void {
  setAi({ ai });
}

export async function refreshTasks(): Promise<void> {
  const project = getStudio().project;
  if (!project) return setAi({ tasks: [], taskViews: {}, openTaskId: null });
  try {
    const tasks = await call('ai.tasks.list', { projectId: project.id });
    setAi({ tasks });
  } catch {
    // AI unavailable in this environment
  }
}

export async function openTask(taskId: string | null): Promise<void> {
  setAi({ openTaskId: taskId, panel: 'assistant' });
  const project = getStudio().project;
  if (!taskId || !project) return;
  try {
    const task = await call('ai.tasks.get', { projectId: project.id, taskId });
    setAi((s) => ({ taskViews: { ...s.taskViews, [task.id]: task } }));
  } catch (error) {
    toast({ tone: 'error', title: 'Couldn’t open the task', body: describeError(error) });
  }
}

export function setMode(mode: TaskMode): void {
  setAi({ mode });
  void refreshPreview();
}

export function setDraft(draft: string): void {
  setAi({ draft });
}

export function toggleAttachment(path: string): void {
  setAi((s) => ({ attachments: s.attachments.includes(path) ? s.attachments.filter((p) => p !== path) : [...s.attachments, path].slice(0, 20) }));
  void refreshPreview();
}

export async function refreshPreview(): Promise<void> {
  const project = getStudio().project;
  if (!project) return;
  try {
    const preview = await call('ai.tasks.preview', { projectId: project.id, mode: getAi().mode, attachments: getAi().attachments });
    setAi({ preview });
  } catch {
    setAi({ preview: null });
  }
}

export const refKey = (r: StudioReference): string => `${r.kind}:${r.within ?? ''}:${r.id}`;

/** What the user is pointing at in the current workspace, by stable id (shown as removable chips). */
export function selectionReferences(): StudioReference[] {
  const s = getStudio();
  const refs: StudioReference[] = [];
  if (s.workspace === 'build') {
    const file = s.selectedFile[s.selectedLineId];
    if (file) refs.push({ kind: 'file', id: file, label: file });
  }
  if (s.workspace === 'video') {
    const v = useVideo.getState();
    if (v.sequence) {
      const clips = v.sequence.tracks.flatMap((t) => t.clips);
      for (const id of v.selection.slice(0, 20)) {
        const c = clips.find((x) => x.id === id);
        if (!c) continue;
        const label = c.type === 'text' ? `“${c.text.slice(0, 40)}”` : (v.media.find((m) => m.id === c.assetId)?.name ?? 'Clip');
        refs.push({ kind: 'clip', id, label, within: v.sequence.id });
      }
      if (!refs.length) refs.push({ kind: 'sequence', id: v.sequence.id, label: v.sequence.name });
    }
  }
  if (s.workspace === 'design') {
    const d = useSelectionRefs.getState().design;
    if (d) refs.push({ kind: 'element', id: d.id, label: d.label, within: d.page });
  }
  if (s.workspace === 'assets') {
    const a = useSelectionRefs.getState().asset;
    if (a) refs.push({ kind: 'asset', id: a.id, label: a.label });
  }
  const removed = new Set(getAi().removedRefs);
  return refs.filter((r) => !removed.has(refKey(r)));
}

export function removeReference(r: StudioReference): void {
  setAi((s) => ({ removedRefs: [...s.removedRefs, refKey(r)] }));
}

function currentContext() {
  const s = getStudio();
  const lineId = s.selectedLineId;
  const path = s.workspace === 'build' ? (s.selectedFile[lineId] ?? null) : null;
  const selection = typeof window !== 'undefined' ? (window.getSelection?.()?.toString() ?? '') : '';
  const v = useVideo.getState();
  const playhead = s.workspace === 'video' && v.sequence ? { sequenceId: v.sequence.id, seconds: Math.round((v.playhead / TICKS_PER_SECOND) * 1000) / 1000 } : null;
  return { workspace: s.workspace, lineId, path, selection: selection.trim() ? selection.slice(0, 20_000) : null, references: selectionReferences(), playhead };
}

export async function loadProjectAi(projectId: string): Promise<void> {
  try {
    setAi({ projectAi: await call('ai.project.get', { projectId }) });
  } catch {
    setAi({ projectAi: null });
  }
}

export async function setAutopilot(on: boolean): Promise<void> {
  const project = getStudio().project;
  if (!project) return;
  try {
    const next = await call('ai.project.set', { projectId: project.id, autopilot: on });
    setAi((s) => ({ projectAi: next, mode: !on && s.mode === 'autopilot' ? 'build' : s.mode }));
  } catch (error) {
    toast({ tone: 'error', title: 'Couldn’t change Autopilot', body: describeError(error) });
  }
}

/** Send the composer text: continue the open task, or start a new one. */
export async function sendPrompt(textOverride?: string, opts: { newTask?: boolean } = {}): Promise<void> {
  const project = getStudio().project;
  const text = (textOverride ?? getAi().draft).trim();
  if (!project || !text || getAi().sending) return;
  setAi({ sending: true, panel: 'assistant' });
  if (getStudio().inspectorCollapsed) setStudio({ inspectorCollapsed: false });
  try {
    const open = getAi().openTaskId;
    const task =
      open && !opts.newTask
        ? await call('ai.tasks.send', { projectId: project.id, taskId: open, text })
        : await call('ai.tasks.create', { projectId: project.id, mode: getAi().mode, prompt: text, context: currentContext(), attachments: getAi().attachments, ...(getAi().mode === 'build' ? { permissions: getAi().permissions } : {}) });
    setAi({ removedRefs: [] });
    setAi((s) => ({ draft: textOverride ? s.draft : '', openTaskId: task.id, taskViews: { ...s.taskViews, [task.id]: task }, attachments: [] }));
    void refreshTasks();
  } catch (error) {
    toast({ tone: 'error', title: 'Couldn’t send', body: describeError(error) });
  } finally {
    setAi({ sending: false });
  }
}

export function newConversation(): void {
  setAi({ openTaskId: null, panel: 'assistant' });
  void refreshPreview();
}

export async function cancelTask(taskId: string): Promise<void> {
  const project = getStudio().project;
  if (!project) return;
  await call('ai.tasks.cancel', { projectId: project.id, taskId }).catch((e) => toast({ tone: 'error', title: 'Couldn’t cancel', body: describeError(e) }));
}

export async function pauseTask(taskId: string, pause: boolean): Promise<void> {
  const project = getStudio().project;
  if (!project) return;
  await call(pause ? 'ai.tasks.pause' : 'ai.tasks.resume', { projectId: project.id, taskId }).catch(() => undefined);
}

export function isActive(task: { state: TaskSummary['state'] }): boolean {
  return ACTIVE_TASK_STATES.includes(task.state);
}

/** Apply streamed task updates from the privileged side. */
export function handleAiEvent(event: StudioEvent): void {
  if (event.type !== 'ai-task') return;
  if (getStudio().project?.id !== event.projectId) return;
  const update = event.update;
  if (update.kind === 'snapshot') {
    const task = update.task;
    setAi((s) => {
      const summary: TaskSummary = { id: task.id, projectId: task.projectId, title: task.title, mode: task.mode, job: task.job, state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt, route: task.route, usage: task.usage, error: task.error };
      const tasks = [summary, ...s.tasks.filter((t) => t.id !== task.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { taskViews: { ...s.taskViews, [task.id]: task }, tasks };
    });
    return;
  }
  setAi((s) => {
    const task = s.taskViews[event.taskId];
    if (!task) return {};
    const messages = task.messages.map((m) => (m.id === update.messageId ? { ...m, text: m.text + update.text } : m));
    return { taskViews: { ...s.taskViews, [task.id]: { ...task, messages } } };
  });
}

export function setPermission(key: keyof TaskPermissionsView, value: boolean): void {
  setAi((s) => ({ permissions: { ...s.permissions, [key]: value } }));
}

export async function decideApproval(taskId: string, approve: boolean): Promise<void> {
  const project = getStudio().project;
  if (!project) return;
  await call('ai.tasks.decide', { projectId: project.id, taskId, approve }).catch((e) => toast({ tone: 'error', title: 'Couldn’t answer', body: describeError(e) }));
}

export async function loadArtifact(taskId: string, file: string): Promise<void> {
  const project = getStudio().project;
  const key = `${taskId}/${file}`;
  if (!project || getAi().artifactUrls[key]) return;
  try {
    const { dataUrl } = await call('ai.tasks.artifact', { projectId: project.id, taskId, file });
    setAi((s) => ({ artifactUrls: { ...s.artifactUrls, [key]: dataUrl } }));
  } catch {
    // shown as unavailable
  }
}
