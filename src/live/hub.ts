/**
 * Builds live-activity events from what the engine actually did and sends them to the interface.
 * Only AI actors produce events: a person's own edits never move an AI pointer or highlight.
 */
import type { Actor } from '../shared/activity';
import type { LiveEvent, LiveEventKind, LivePhase, LiveTarget } from '../shared/live';
import { describeCommand, operationPhase } from './describe';

export interface LiveInput {
  kind: LiveEventKind;
  projectId: string;
  actor: Actor;
  taskId?: string | null;
  via?: string | null;
  lineId?: string | null;
  operationId?: string | null;
  operation?: string | null;
  phase: LivePhase;
  description: string;
  target?: LiveTarget | null;
  resourceId?: string | null;
  scope?: number;
  progress?: number | null;
  pointer?: boolean;
  action?: string | null;
  canPause?: boolean;
  detail?: string | null;
}

export const liveTaskKey = (actor: Actor, taskId: string | null | undefined, via: string | null | undefined): string => (actor === 'ai-app' ? `app:${via ?? 'AI app'}` : `task:${taskId ?? 'ai'}`);

export class LiveHub {
  private readonly labels = new Map<string, string>();

  constructor(
    private readonly lineName: (projectId: string, lineId: string) => Promise<string | null>,
    private readonly sink: (event: LiveEvent) => void,
  ) {}

  /** The built-in AI names its tasks; connected apps are named by the app. */
  setLabel(taskId: string, label: string): void {
    this.labels.set(`task:${taskId}`, label.replace(/\s+/g, ' ').trim().slice(0, 80) || 'AI task');
    if (this.labels.size > 200) this.labels.delete(this.labels.keys().next().value!);
  }

  async emit(p: LiveInput): Promise<void> {
    if (p.actor === 'user') return;
    const taskId = liveTaskKey(p.actor, p.taskId, p.via);
    const universeName = p.lineId ? await this.lineName(p.projectId, p.lineId).catch(() => null) : null;
    this.sink({
      kind: p.kind,
      taskId,
      taskLabel: p.actor === 'ai-app' ? (p.via ?? 'AI app') : (this.labels.get(taskId) ?? 'AI task'),
      actor: p.actor,
      operationId: p.operationId ?? null,
      projectId: p.projectId,
      universeId: p.lineId ?? null,
      universeName,
      resourceId: p.resourceId ?? null,
      target: p.target ?? null,
      scope: p.scope ?? (p.target ? 1 : 0),
      operation: p.operation ?? null,
      phase: p.phase,
      at: new Date().toISOString(),
      description: p.description,
      progress: p.progress ?? null,
      pointer: Boolean(p.pointer),
      action: p.action ?? null,
      canPause: Boolean(p.canPause),
      detail: p.detail ?? null,
    });
  }

  /** A file command finished (or was refused). Targets come from the real before/after files. */
  async command(projectId: string, lineId: string, info: { id: string; name: string; args: unknown; label: string; actor: Actor; via?: string | null; taskId?: string | null; files: { path: string; before: string | null; after: string | null }[]; error?: string | null }): Promise<void> {
    if (info.actor === 'user') return;
    const d = describeCommand(info.name, (info.args ?? {}) as Record<string, unknown>, info.files, info.label);
    await this.emit({
      kind: info.error ? 'operation.failed' : 'operation.completed',
      projectId,
      lineId,
      actor: info.actor,
      via: info.via,
      taskId: info.taskId,
      operationId: info.id,
      operation: info.name,
      phase: info.error ? 'failed' : 'editing',
      description: info.error ? `Could not finish: ${d.description.charAt(0).toLowerCase()}${d.description.slice(1)}` : d.description,
      target: info.error ? null : d.target,
      resourceId: d.resourceId,
      scope: d.scope,
      detail: info.error ?? null,
    });
  }

  /** A project operation started, finished or failed. */
  async operation(projectId: string, info: { id: string; name: string; summary: string; actor: Actor; via?: string | null; taskId?: string | null; universeId: string | null; resourceId: string | null; stage: 'started' | 'completed' | 'failed'; error?: string | null }): Promise<void> {
    if (info.actor === 'user') return;
    const phase = info.stage === 'failed' ? 'failed' : operationPhase(info.name);
    const universeOp = /^universe\.|^project\.(create|duplicate)Universe|combine/i.test(info.name);
    await this.emit({
      kind: info.stage === 'started' ? 'operation.started' : info.stage === 'completed' ? 'operation.completed' : 'operation.failed',
      projectId,
      lineId: info.universeId,
      actor: info.actor,
      via: info.via,
      taskId: info.taskId,
      operationId: info.id,
      operation: info.name,
      phase,
      description: info.summary,
      target: universeOp && info.universeId ? { kind: 'universe', lineId: info.universeId } : null,
      resourceId: info.resourceId,
      detail: info.error ?? null,
    });
  }
}
