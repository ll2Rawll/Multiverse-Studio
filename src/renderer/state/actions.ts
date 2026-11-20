/** UI actions: thin wrappers that call the engine and update the view state. */
import { call, errorMessage, onStudioEvent, ApiError } from '../lib/api';
import { handlePublishEvent } from './publish';
import { checkRecovery } from './recovery';
import { handleActivityEvent } from './activity';
import { handleStoryEvent } from './stories';
import { handleConnectorEvent, loadConnector } from './connector';
import { handleLiveEvent } from './live';
import { bumpPreviews, closeDialog, get, highlightLines, openDialog, set, toast, type Workspace } from './store';
import { SHARED_LINE_ID, type AlternativeColor, type AppSettings, type ContentRef, type ProjectView, type PropagationReport, type StudioEvent } from '../../shared/types';
import { plural } from '../lib/util';
import { pulseFracture } from '../design/fracture';
import { handleAiEvent, loadAiState, refreshTasks, useAi } from './ai';
import { handleBuildEvent } from './build';
import { handleVideoEvent } from './video';
import { handleMediaEvent } from './media';

export function applyProject(project: ProjectView): void {
  const s = get();
  const ids = new Set([project.shared.id, ...project.alternatives.map((a) => a.id)]);
  set({
    project,
    selectedLineId: ids.has(s.selectedLineId) ? s.selectedLineId : SHARED_LINE_ID,
    compareSelection: s.compareSelection.filter((id) => ids.has(id)),
  });
}

let subscribed = false;
const announced = new Set<string>();

export async function bootstrap(): Promise<void> {
  try {
    const [info, settings, recent] = await Promise.all([call('app.info', {}), call('settings.get', {}), call('projects.recent', {})]);
    set({ info, settings, recent, ready: true });
    useAi.setState({ mode: settings.taskMode, permissions: settings.taskPermissions });
    void loadAiState();
    void loadConnector();
    void call('templates.list', {}).then((templates) => set({ templates }), () => undefined);
  } catch (error) {
    set({ ready: true });
    toast({ tone: 'error', title: 'Could not start', body: errorMessage(error), sticky: true });
  }
  if (!subscribed) {
    subscribed = true;
    onStudioEvent(handleEvent);
  }
}

function handleEvent(event: StudioEvent): void {
  const s = get();
  if (event.type === 'project-changed') {
    if (s.project?.id === event.projectId) {
      applyProject(event.project);
      bumpPreviews(event.lineIds);
      handleMediaEvent(event);
    }
  } else if (event.type === 'propagation') {
    if (s.project?.id === event.projectId) announcePropagation(event.report);
  } else if (event.type === 'ai-task') {
    handleAiEvent(event);
  } else if (event.type === 'build') {
    handleBuildEvent(event);
  } else if (event.type === 'media' || event.type === 'video-job') {
    handleVideoEvent(event);
    handleMediaEvent(event);
  } else if (event.type === 'media-job') {
    handleMediaEvent(event);
  } else if (event.type === 'story-run') {
    handleStoryEvent(event);
  } else if (event.type === 'activity') {
    handleActivityEvent(event);
  } else if (event.type === 'publish-job') {
    handlePublishEvent(event);
  } else if (event.type === 'connector' || event.type === 'connector-show') {
    handleConnectorEvent(event, async (projectId, lineId) => {
      await openProject(projectId);
      if (lineId && get().project?.id === projectId) selectLine(lineId);
    });
  } else if (event.type === 'live') {
    handleLiveEvent(event);
  } else if (event.type === 'notice') {
    toast({ tone: event.level === 'error' ? 'error' : 'info', title: event.message });
  }
}

export function announcePropagation(report: PropagationReport): void {
  // The same report arrives as a call result and as an engine event; announce it once.
  const key = `${report.sharedRevisionId}|${report.lines.map((l) => `${l.lineId}:${l.outcome}`).join(',')}`;
  if (announced.has(key)) return;
  announced.add(key);
  set({ lastReport: report });
  const affected = report.lines.filter((l) => l.outcome === 'applied' || l.outcome === 'conflicted').map((l) => l.lineId);
  highlightLines(affected);
  bumpPreviews(affected);
  if (affected.length) pulseFracture();
  const applied = report.lines.filter((l) => l.outcome === 'applied').map((l) => l.name);
  const conflicted = report.lines.filter((l) => l.outcome === 'conflicted');
  const queued = report.lines.filter((l) => l.outcome === 'queued').map((l) => l.name);
  const paused = report.lines.filter((l) => l.outcome === 'paused').map((l) => l.name);
  const parts: string[] = [];
  if (applied.length) parts.push(`Applied to ${applied.join(', ')}.`);
  if (conflicted.length) parts.push(`${conflicted.map((c) => c.name).join(', ')} ${conflicted.length === 1 ? 'needs' : 'need'} a decision (${plural(report.totalConflicts, 'conflict')}).`);
  if (queued.length) parts.push(`Waiting for ${queued.join(', ')} to resolve earlier conflicts.`);
  if (paused.length) parts.push(`Not sent to ${paused.join(', ')} (paused).`);
  if (parts.length === 0) parts.push('No alternatives needed changes.');
  const first = conflicted[0];
  toast({
    tone: conflicted.length ? 'warning' : 'success',
    title: conflicted.length ? `Shared change saved · ${plural(report.totalConflicts, 'conflict')}` : 'Shared change saved',
    body: parts.join(' '),
    action: first ? { label: 'Review conflict', run: () => openDialog({ kind: 'conflicts', lineId: first.lineId }) } : undefined,
    sticky: conflicted.length > 0,
  });
}

export async function refreshRecent(): Promise<void> {
  set({ recent: await call('projects.recent', {}) });
}

export async function openProject(projectId: string): Promise<void> {
  set({ busy: 'Opening project…' });
  try {
    const project = await call('projects.open', { projectId });
    enterProject(project);
    if (project.recoveredFromBackup) {
      toast({ tone: 'warning', title: 'Project recovered', body: 'Its metadata was damaged, so the last good copy was used. The most recent action may be missing.', sticky: true });
    }
    if (project.migratedFromVersion !== null) {
      toast({ tone: 'info', title: 'Project upgraded', body: `It was saved in an older format (version ${project.migratedFromVersion}). The original metadata is kept next to it as project.v${project.migratedFromVersion}.json.` });
    }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'project-damaged') {
      openDialog({ kind: 'damaged', projectId, message: error.message, details: Array.isArray(error.details) ? (error.details as string[]) : [] });
    } else {
      toast({ tone: 'error', title: 'Could not open the project', body: errorMessage(error) });
    }
    await refreshRecent();
  } finally {
    set({ busy: null });
  }
}

/** Where a project opens: websites from a template start in Design, apps in Build, everything else in Explore. */
function firstWorkspace(project: ProjectView): Workspace {
  if (project.sourceKind === 'template') return project.kind === 'app' ? 'build' : project.kind === 'video' ? 'video' : 'design';
  return 'explore';
}

function enterProject(project: ProjectView): void {
  const first = project.alternatives[0]?.id ?? SHARED_LINE_ID;
  set({
    project,
    workspace: firstWorkspace(project),
    selectedLineId: first,
    compareSelection: [],
    compare: { mode: 'compare', left: { kind: 'line', lineId: SHARED_LINE_ID }, right: { kind: 'line', lineId: first }, view: 'previews', file: null },
    previewVersions: {},
    highlights: {},
    lastReport: null,
  });
  void checkRecovery(project.id);
  void refreshRecent();
  void refreshTasks();
}

export async function createFromTemplate(templateId: string, name?: string): Promise<boolean> {
  const template = get().templates.find((t) => t.id === templateId);
  set({ busy: `Creating ${template?.name ?? 'the project'}…` });
  try {
    const p = get().project;
    if (p) await call('projects.close', { projectId: p.id }).catch(() => undefined);
    const project = await call('projects.createFromTemplate', { templateId, ...(name ? { name } : {}) });
    enterProject(project);
    if (template?.needsInstall) toast({ tone: 'info', title: `${project.name} is ready`, body: 'Install dependencies in the Build panel, then start the dev server to preview it.' });
    return true;
  } catch (error) {
    toast({ tone: 'error', title: 'Could not create the project', body: errorMessage(error) });
    return false;
  } finally {
    set({ busy: null });
  }
}

export async function createSample(): Promise<void> {
  set({ busy: 'Creating the sample project…' });
  try {
    const project = await call('projects.createSample', {});
    enterProject(project);
    set({ tour: { open: true, step: 0, done: [] } });
  } catch (error) {
    toast({ tone: 'error', title: 'Could not create the sample', body: errorMessage(error) });
  } finally {
    set({ busy: null });
  }
}

export async function importProject(): Promise<void> {
  try {
    set({ busy: 'Importing…' });
    const report = await call('projects.import', {});
    if (!report) return;
    enterProject(report.project);
    openDialog({ kind: 'import-report', skipped: report.skipped, storagePath: report.storagePath, originalPath: report.originalPath, fileCount: report.fileCount });
  } catch (error) {
    toast({ tone: 'error', title: 'Could not import that folder', body: errorMessage(error) });
  } finally {
    set({ busy: null });
  }
}

export async function closeProject(): Promise<void> {
  const p = get().project;
  if (p) await call('projects.close', { projectId: p.id }).catch(() => undefined);
  set({ project: null, tour: { open: false, step: 0, done: [] } });
  await refreshRecent();
}

export function setWorkspace(workspace: Workspace): void {
  set({ workspace });
}

export function selectLine(lineId: string): void {
  set({ selectedLineId: lineId });
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  set((s) => ({ settings: { ...s.settings, ...patch } }));
  try {
    set({ settings: await call('settings.set', { patch }) });
  } catch (error) {
    toast({ tone: 'error', title: 'Could not save settings', body: errorMessage(error) });
  }
}

export async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    toast({ tone: 'error', title: label, body: errorMessage(error) });
    return undefined;
  }
}

function projectId(): string {
  const p = get().project;
  if (!p) throw new Error('No project is open');
  return p.id;
}

export async function saveShared(message?: string): Promise<PropagationReport | null> {
  const id = projectId();
  const following = get().project?.alternatives.filter((a) => a.following).length ?? 0;
  set({ busy: following > 0 ? `Saving and updating ${plural(following, 'alternative')}…` : 'Saving…', save: { status: 'saving', message: null, at: Date.now() } });
  try {
    const result = await call('shared.save', { projectId: id, message });
    applyProject(result.project);
    set({ save: { status: 'saved', message: null, at: Date.now() } });
    bumpPreviews([SHARED_LINE_ID]);
    if (result.report) announcePropagation(result.report);
    return result.report;
  } catch (error) {
    set({ save: { status: 'error', message: errorMessage(error), at: Date.now() } });
    toast({ tone: 'error', title: 'The shared change was not saved', body: `${errorMessage(error)} Your draft is still kept.` });
    return null;
  } finally {
    set({ busy: null });
  }
}

export async function discardSharedDraft(): Promise<void> {
  const id = projectId();
  await run('Could not discard the draft', async () => applyProject(await call('shared.discardDraft', { projectId: id })));
  bumpPreviews([SHARED_LINE_ID]);
}

export async function createAlternative(input: { from: ContentRef; name: string; color: AlternativeColor; description: string; following: boolean }): Promise<string | null> {
  const id = projectId();
  const result = await run('Could not create the alternative', () => call('lines.create', { projectId: id, ...input }));
  if (!result) return null;
  applyProject(result.project);
  set({ selectedLineId: result.line.id });
  highlightLines([result.line.id]);
  toast({ tone: 'success', title: `Created ${result.line.name}`, body: result.line.status === 'behind' ? `${plural(result.line.sharedChangesBehind, 'newer shared change')} can be applied from the inspector.` : undefined });
  return result.line.id;
}

export async function duplicateAlternative(lineId: string): Promise<void> {
  const id = projectId();
  const result = await run('Could not duplicate', () => call('lines.duplicate', { projectId: id, lineId }));
  if (!result) return;
  applyProject(result.project);
  set({ selectedLineId: result.line.id });
  highlightLines([result.line.id]);
}

export async function updateAlternative(lineId: string, patch: { name?: string; color?: AlternativeColor; description?: string }): Promise<void> {
  const id = projectId();
  const project = await run('Could not update the alternative', () => call('lines.update', { projectId: id, lineId, ...patch }));
  if (project) applyProject(project);
}

export function confirmDeleteAlternative(lineId: string, name: string): void {
  openDialog({
    kind: 'confirm',
    title: `Delete ${name}?`,
    body: `${name} will be removed from this project. A checkpoint is created first, so you can bring it back from History.`,
    confirmLabel: 'Delete alternative',
    destructive: true,
    onConfirm: async () => {
      const id = projectId();
      const project = await run('Could not delete', () => call('lines.delete', { projectId: id, lineId }));
      if (project) {
        applyProject(project);
        toast({ tone: 'info', title: `Deleted ${name}`, body: 'A checkpoint was saved in History.' });
      }
    },
  });
}

export async function setFollowing(lineId: string, following: boolean): Promise<void> {
  const id = projectId();
  const result = await run('Could not change following', () => call('lines.setFollowing', { projectId: id, lineId, following }));
  if (!result) return;
  applyProject(result.project);
  if (result.report) announcePropagation(result.report);
  else toast({ tone: 'info', title: following ? 'Following shared changes' : 'Paused', body: following ? 'New shared changes will be applied automatically.' : 'This alternative keeps its content and won’t receive shared changes until you resume.' });
}

export async function createCheckpoint(name: string, description: string): Promise<void> {
  const id = projectId();
  const project = await run('Could not create the checkpoint', () => call('history.createCheckpoint', { projectId: id, name, description }));
  if (project) {
    applyProject(project);
    toast({ tone: 'success', title: 'Checkpoint created', body: name });
  }
}

export async function undoOperation(operationId: string): Promise<void> {
  const id = projectId();
  const project = await run('Could not undo', () => call('operations.undo', { projectId: id, operationId }));
  if (project) {
    applyProject(project);
    toast({ tone: 'info', title: 'Undone', body: 'A checkpoint of the state before undoing was saved in History.' });
  }
}

export function publishRef(ref: ContentRef): void {
  openDialog({ kind: 'publish', ref });
}

export function exportRef(ref: ContentRef, label: string): void {
  openDialog({ kind: 'export', ref, label });
}

export function startCompare(left: ContentRef, right: ContentRef, mode: 'compare' | 'combine' = 'compare'): void {
  set({ workspace: 'compare', compare: { ...get().compare, mode, left, right, file: null } });
}

export { closeDialog, openDialog };
