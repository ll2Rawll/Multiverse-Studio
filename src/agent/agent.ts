/**
 * The coding agent: prepares tasks (Build mode works in a new task alternative so the user's
 * version is preserved), builds a tool host per task, and cleans up processes when tasks end.
 */
import path from 'node:path';
import { SHARED_LINE_ID, ALTERNATIVE_COLORS, type AlternativeColor } from '../shared/types';
import { EDITING_MODES, type TaskMode, type TaskView } from '../shared/ai';
import type { StudioService } from '../services/studio';
import type { ToolHost } from '../ai/runner';
import { AgentToolHost } from './tools';
import { AUTOPILOT_PERMISSIONS, DEFAULT_PERMISSIONS, READ_ONLY_PERMISSIONS, type TaskPermissions } from './permissions';
import { ProcessManager } from './processes';
import { RunDirectory } from './runDir';
import type { BrowserProbe } from './browser';

export interface AgentOptions {
  /** Folder for run directories (materialised versions with node_modules etc.). */
  cacheRoot: string;
  probe?: BrowserProbe | null;
}

export interface PreparedTask {
  workingLineId: string;
  workingLineName: string;
  originLineId: string;
  permissions: TaskPermissions;
  checkpointId: string | null;
}

export class CodingAgent {
  readonly processes = new ProcessManager();
  private readonly runDirs = new Map<string, RunDirectory>();

  /** After the run folders were deleted (Settings → Storage): start from fresh folders next time. */
  forgetRunFolders(): void {
    this.runDirs.clear();
  }

  constructor(
    private readonly studio: StudioService,
    private readonly options: AgentOptions,
  ) {}

  get probe(): BrowserProbe | null {
    return this.options.probe ?? null;
  }

  /** Build mode gets its own task alternative, created from the version the user is on. */
  async prepare(projectId: string, mode: TaskMode, title: string, lineId: string | null, requested?: Partial<Omit<TaskPermissions, 'readProject'>>): Promise<PreparedTask> {
    const origin = lineId ?? SHARED_LINE_ID;
    const engine = await this.studio.engine(projectId);
    const view = await this.studio.view(engine);
    const originName = origin === SHARED_LINE_ID ? view.shared.name : (view.alternatives.find((a) => a.id === origin)?.name ?? 'Alternative');
    if (!EDITING_MODES.includes(mode)) return { workingLineId: origin, workingLineName: originName, originLineId: origin, permissions: { ...READ_ONLY_PERMISSIONS }, checkpointId: null };
    const used = new Set(view.alternatives.map((a) => a.color));
    const color: AlternativeColor = ALTERNATIVE_COLORS.find((c) => !used.has(c)) ?? ALTERNATIVE_COLORS[view.alternatives.length % ALTERNATIVE_COLORS.length]!;
    const clean = title.replace(/\s+/g, ' ').replace(/[“”"]/g, '').trim();
    const short = clean.length <= 40 ? clean : `${clean.slice(0, 40).replace(/\s+\S*$/, '')}…`;
    // A checkpoint of every universe first, so the whole project can be put back as it was.
    const cp = await this.studio.operations.run(projectId, 'project.createCheckpoint', { name: `Before task: ${title.replace(/\s+/g, ' ').slice(0, 100)}`, description: `Created automatically before a ${mode === 'autopilot' ? 'Autopilot' : 'Build'} task started.` }, { actor: 'ai-task' });
    const checkpointId = (cp.resourceId as string | null) ?? null;
    const names = new Set(view.alternatives.map((a) => a.name));
    let name = `Task: ${short}`;
    for (let i = 2; names.has(name); i++) name = `Task: ${short} (${i})`;
    const created = await this.studio.call('lines.create', {
      projectId,
      from: { kind: 'line', lineId: origin },
      name: name.slice(0, 60),
      color,
      description: `Created by an AI task from ${originName}. Your ${originName} is unchanged; compare and combine when you are happy.`,
      following: false,
    });
    // Autopilot (allowed per project) grants every routine permission; anything else still asks.
    const permissions = mode === 'autopilot' ? { ...AUTOPILOT_PERMISSIONS } : { ...DEFAULT_PERMISSIONS, ...requested, readProject: true as const };
    return { workingLineId: created.line.id, workingLineName: created.line.name, originLineId: origin, permissions, checkpointId };
  }

  async toolsFor(task: TaskView): Promise<ToolHost> {
    const engine = await this.studio.engine(task.projectId);
    const lineId = task.workingLineId ?? task.context.lineId ?? SHARED_LINE_ID;
    const key = `${task.projectId}:${lineId}`;
    let runDir = this.runDirs.get(key);
    if (!runDir) {
      runDir = new RunDirectory(path.join(this.options.cacheRoot, 'runs', task.projectId, lineId), engine, lineId);
      this.runDirs.set(key, runDir);
    }
    const permissions: TaskPermissions = task.mode === 'autopilot' ? { ...AUTOPILOT_PERMISSIONS } : task.mode === 'build' ? { ...DEFAULT_PERMISSIONS, ...(task.permissions ?? {}), readProject: true } : { ...READ_ONLY_PERMISSIONS };
    return new AgentToolHost({
      studio: this.studio,
      engine,
      task,
      lineId,
      originLineId: task.originLineId ?? lineId,
      mode: task.mode,
      permissions,
      processes: this.processes,
      runDir,
      probe: this.options.probe ?? null,
      artifactsDir: path.join(engine.dir, 'ai', 'artifacts', task.id),
      onChanged: async () => {
        await this.studio.changed(engine, 'agent-edit', [lineId]);
      },
      onArtifact: async (artifact) => {
        task.artifacts = [...(task.artifacts ?? []), artifact];
      },
    });
  }

  async shutdown(): Promise<void> {
    await this.processes.stopAll();
  }
}
