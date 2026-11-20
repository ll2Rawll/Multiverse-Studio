/**
 * Project-level operations as commands. File edits are `CommandDefinition`s (pure transforms with
 * undo stacks); operations that act on the project as a whole — creating universes, checkpoints,
 * combining, rendering, importing, running tests — are `OperationDefinition`s. Both are run with:
 *
 * - a command type (name), project id, universe id and resource id;
 * - an expected revision when applicable (the universe head the action was prepared against);
 * - validated arguments (zod);
 * - an actor (`user` or `ai-task`, with the task id);
 * - a result, and undo or checkpoint information.
 *
 * Every state-changing run, from a button, a shortcut, drag and drop or an AI task, is appended to
 * the project's activity log (`commands/activity.jsonl`). Reads are not logged.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { CommandError } from './commands';

import type { ActivityRecord, Actor, UndoInfo } from '../shared/activity';
export type { ActivityRecord, Actor, UndoInfo };

export interface OperationContext {
  projectId: string;
  /** The universe (version) the action is about, when there is one. */
  universeId: string | null;
  actor: Actor;
  /** The connected AI app's name when actor is `ai-app`. */
  via?: string | null;
  taskId: string | null;
}

export interface OperationOutcome {
  result: unknown;
  /** One line for the activity log and the director. */
  summary: string;
  resourceId?: string | null;
  universeId?: string | null;
  undo?: UndoInfo | null;
}

/** What an AI task may do without asking, decided per call. */
export type AiPolicy = { allow: true } | { allow: false; approval: string } | { allow: false; deny: string };

export interface OperationDefinition<A = Record<string, unknown>> {
  name: string;
  domain: string;
  description: string;
  schema: z.ZodType<A>;
  /** `read` operations change nothing and are not logged. */
  effect: 'read' | 'change' | 'job';
  label(args: A): string;
  /** The universe and resource an invocation is about (for the log and expected-revision checks). */
  target(args: A): { universeId: string | null; resourceId: string | null };
  /** For AI actors: whether the call is routine for the task, needs the user's approval, or is not allowed. */
  ai(args: A, task: { universeId: string | null; permissions: { runBuildAndTests: boolean; operatePreview: boolean } }): AiPolicy;
  run(ctx: OperationContext, args: A): Promise<OperationOutcome>;
}

const MAX_LOG = 4000;

export class OperationRegistry {
  private readonly defs = new Map<string, OperationDefinition<unknown>>();
  register<A>(def: OperationDefinition<A>): void {
    this.defs.set(def.name, def as OperationDefinition<unknown>);
  }
  has(name: string): boolean {
    return this.defs.has(name);
  }
  get(name: string): OperationDefinition<unknown> {
    const def = this.defs.get(name);
    if (!def) throw new CommandError(`Unknown command “${name}”.`);
    return def;
  }
  all(): OperationDefinition<unknown>[] {
    return [...this.defs.values()];
  }
}

export interface OperationHost {
  projectDir(projectId: string): Promise<string>;
  /** Head revision of a universe, for expected-revision checks. */
  universeHead(projectId: string, universeId: string): Promise<string | null>;
  onLogged?(record: ActivityRecord): void;
  /** AI-started operations: started, completed or failed (live activity). */
  onLive?(projectId: string, info: { id: string; name: string; summary: string; actor: Actor; via?: string | null; taskId?: string | null; universeId: string | null; resourceId: string | null; stage: 'started' | 'completed' | 'failed'; error?: string | null }): void;
}

export class OperationService {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    readonly registry: OperationRegistry,
    private readonly host: OperationHost,
  ) {}

  parse(name: string, raw: unknown): { def: OperationDefinition<unknown>; args: unknown } {
    const def = this.registry.get(name);
    const parsed = def.schema.safeParse(raw ?? {});
    if (!parsed.success) throw new CommandError(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
    return { def, args: parsed.data };
  }

  async run(projectId: string, name: string, raw: unknown, options: { actor: Actor; via?: string | null; taskId?: string | null; expectedRevision?: string | null }): Promise<OperationOutcome & { record: ActivityRecord | null }> {
    const { def, args } = this.parse(name, raw);
    const target = def.target(args);
    if (options.expectedRevision && target.universeId) {
      const head = await this.host.universeHead(projectId, target.universeId);
      if (head !== options.expectedRevision) throw new CommandError(`That version changed since this action was prepared (expected ${options.expectedRevision.slice(0, 10)}, now ${String(head).slice(0, 10)}). Nothing was changed; look again and retry.`);
    }
    const ctx: OperationContext = { projectId, universeId: target.universeId, actor: options.actor, via: options.via ?? null, taskId: options.taskId ?? null };
    const live = options.actor !== 'user' && this.host.onLive ? { id: `op-${randomUUID().slice(0, 12)}`, name, actor: options.actor, via: options.via ?? null, taskId: options.taskId ?? null } : null;
    if (live) this.host.onLive!(projectId, { ...live, summary: def.label(args), universeId: target.universeId, resourceId: target.resourceId, stage: 'started' });
    let outcome: OperationOutcome;
    try {
      outcome = await def.run(ctx, args);
    } catch (error) {
      if (live) this.host.onLive!(projectId, { ...live, summary: def.label(args), universeId: target.universeId, resourceId: target.resourceId, stage: 'failed', error: (error as Error).message.slice(0, 300) });
      if (def.effect !== 'read') await this.log(projectId, { def, args, target, options, ok: false, summary: (error as Error).message.slice(0, 300), undo: null, resourceId: target.resourceId, universeId: target.universeId });
      throw error;
    }
    if (live) this.host.onLive!(projectId, { ...live, summary: outcome.summary, universeId: outcome.universeId ?? target.universeId, resourceId: outcome.resourceId ?? target.resourceId, stage: 'completed' });
    const record = def.effect === 'read' ? null : await this.log(projectId, { def, args, target, options, ok: true, summary: outcome.summary, undo: outcome.undo ?? null, resourceId: outcome.resourceId ?? target.resourceId, universeId: outcome.universeId ?? target.universeId });
    return { ...outcome, record };
  }

  /** File commands (CommandService) report here so the activity log covers every edit. */
  async logCommand(projectId: string, entry: { name: string; lineId: string; label: string; scope: string; actor: Actor; via?: string | null; taskId: string | null; files: string[] }): Promise<void> {
    const record: ActivityRecord = {
      id: `act-${randomUUID().slice(0, 12)}`,
      type: entry.name,
      projectId,
      universeId: entry.lineId,
      resourceId: entry.files[0] ?? null,
      expectedRevision: null,
      args: entry.files.join(', ').slice(0, 300),
      actor: entry.actor,
      via: entry.via ?? null,
      taskId: entry.taskId,
      at: new Date().toISOString(),
      ok: true,
      summary: entry.label,
      undo: { kind: 'command', lineId: entry.lineId, scope: entry.scope, label: 'Undo' },
    };
    await this.append(projectId, record);
  }

  async activity(projectId: string, limit = 200): Promise<ActivityRecord[]> {
    try {
      const text = await fs.readFile(await this.file(projectId), 'utf8');
      const lines = text.split('\n').filter(Boolean);
      const out: ActivityRecord[] = [];
      for (const l of lines.slice(-limit).reverse()) {
        try {
          out.push(JSON.parse(l) as ActivityRecord);
        } catch {
          /* a torn last line after a crash is skipped */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async file(projectId: string): Promise<string> {
    return path.join(await this.host.projectDir(projectId), 'commands', 'activity.jsonl');
  }

  private async log(
    projectId: string,
    e: { def: OperationDefinition<unknown>; args: unknown; target: { universeId: string | null; resourceId: string | null }; options: { actor: Actor; via?: string | null; taskId?: string | null; expectedRevision?: string | null }; ok: boolean; summary: string; undo: UndoInfo | null; resourceId: string | null; universeId: string | null },
  ): Promise<ActivityRecord> {
    let args = '';
    try {
      args = JSON.stringify(e.args).slice(0, 600);
    } catch {
      args = '(not serialisable)';
    }
    const record: ActivityRecord = {
      id: `act-${randomUUID().slice(0, 12)}`,
      type: e.def.name,
      projectId,
      universeId: e.universeId,
      resourceId: e.resourceId,
      expectedRevision: e.options.expectedRevision ?? null,
      args,
      actor: e.options.actor,
      via: e.options.via ?? null,
      taskId: e.options.taskId ?? null,
      at: new Date().toISOString(),
      ok: e.ok,
      summary: e.summary,
      undo: e.undo,
    };
    await this.append(projectId, record);
    return record;
  }

  private append(projectId: string, record: ActivityRecord): Promise<void> {
    const prev = this.chains.get(projectId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const file = await this.file(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(record)}\n`);
      const stat = await fs.stat(file);
      if (stat.size > MAX_LOG * 600) {
        const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
        await fs.writeFile(file, `${lines.slice(-MAX_LOG).join('\n')}\n`);
      }
      this.host.onLogged?.(record);
    });
    this.chains.set(projectId, next.catch(() => undefined));
    return next;
  }
}
