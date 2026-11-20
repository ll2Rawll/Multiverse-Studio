/**
 * The unified command layer. Every editing operation that manual controls, keyboard shortcuts,
 * AI tools and automations can perform is a command:
 *
 * - validated arguments (zod) and a target (the files it reads and writes);
 * - an expected revision: the content hash each target had when the action was prepared, so a
 *   stale action changes nothing;
 * - an actor (`user` or `ai-task`), a result, and undo information (file hashes before and after);
 * - one atomic edit in the revision history, so AI and manual changes share one history.
 *
 * Undo and redo stacks are kept per version and scope (a page, a sequence) and saved with the
 * project, so they survive restarts.
 */
import { promises as fs } from 'node:fs';
import type { Actor } from '../shared/activity';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { ProjectEngine } from '../engine/project';
import { writeFileAtomic } from '../engine/store/atomic';
import { normalizeProjectPath } from '../shared/paths';

export class CommandError extends Error {
  readonly code = 'command';
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

export type FileTexts = Map<string, string | null>;
/** What a command writes: text, bytes (for media copied into a version), or null to delete. */
export type FileChanges = Map<string, string | Uint8Array | null>;

export interface CommandDefinition<A = unknown> {
  name: string;
  schema: z.ZodType<A>;
  /** Undo/redo stack the command belongs to (e.g. a page or a sequence path). */
  scope(args: A): string;
  label(args: A): string;
  /** Files the command reads; it may write any of them (and create new ones it returns). */
  files(args: A): string[];
  /** Pure transformation. Return only files that change (null deletes a file). */
  apply(files: FileTexts, args: A): FileChanges;
}

export interface CommandRecord {
  id: string;
  name: string;
  label: string;
  scope: string;
  actor: Actor;
  via?: string | null;
  taskId: string | null;
  at: string;
  files: { path: string; before: string | null; after: string | null }[];
}

export interface CommandResult {
  record: CommandRecord;
  /** New content hashes, for the next expected revision. */
  hashes: Record<string, string | null>;
  /** The files' new text, so the caller can refresh without another read. */
  texts: Record<string, string | null>;
}

interface Stacks {
  undo: CommandRecord[];
  redo: CommandRecord[];
}

const MAX_STACK = 200;

export class CommandRegistry {
  private readonly defs = new Map<string, CommandDefinition<unknown>>();

  register<A>(def: CommandDefinition<A>): void {
    this.defs.set(def.name, def as CommandDefinition<unknown>);
  }

  get(name: string): CommandDefinition<unknown> {
    const def = this.defs.get(name);
    if (!def) throw new CommandError(`Unknown command “${name}”.`);
    return def;
  }

  names(): string[] {
    return [...this.defs.keys()];
  }
}

export class CommandService {
  /** Called after each command that changed files (the project activity log). */
  onRecord: ((engine: ProjectEngine, lineId: string, record: CommandRecord) => Promise<void>) | null = null;
  /** AI commands only: the applied change as text (for live activity targets). */
  onApplied: ((engine: ProjectEngine, lineId: string, info: { record: CommandRecord; args: unknown; files: { path: string; before: string | null; after: string | null }[] }) => Promise<void>) | null = null;
  /** AI commands only: refused or failed. */
  onFailed: ((engine: ProjectEngine, lineId: string, info: { name: string; args: unknown; actor: Actor; via: string | null; taskId: string | null; error: string }) => Promise<void>) | null = null;

  constructor(private readonly registry: CommandRegistry) {}

  private stackFile(engine: ProjectEngine, lineId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(lineId)) throw new CommandError('Invalid version id.');
    return path.join(engine.dir, 'commands', `${lineId}.json`);
  }

  private async stacks(engine: ProjectEngine, lineId: string): Promise<Record<string, Stacks>> {
    try {
      return JSON.parse(await fs.readFile(this.stackFile(engine, lineId), 'utf8')) as Record<string, Stacks>;
    } catch {
      return {};
    }
  }

  private async saveStacks(engine: ProjectEngine, lineId: string, all: Record<string, Stacks>): Promise<void> {
    await fs.mkdir(path.dirname(this.stackFile(engine, lineId)), { recursive: true });
    await writeFileAtomic(this.stackFile(engine, lineId), JSON.stringify(all));
  }

  private async read(engine: ProjectEngine, lineId: string, paths: string[]): Promise<{ texts: FileTexts; hashes: Map<string, string | null> }> {
    const tree = await engine.effectiveTree(lineId);
    const texts: FileTexts = new Map();
    const hashes = new Map<string, string | null>();
    for (const raw of paths) {
      const p = normalizeProjectPath(raw);
      const hash = tree.get(p) ?? null;
      hashes.set(p, hash);
      texts.set(p, hash ? (await engine.readBlob(hash)).toString('utf8') : null);
    }
    return { texts, hashes };
  }

  async run(
    engine: ProjectEngine,
    lineId: string,
    name: string,
    rawArgs: unknown,
    options: { actor: Actor; via?: string | null; taskId?: string | null; expected?: Record<string, string | null> },
  ): Promise<CommandResult> {
    try {
      return await this.runInner(engine, lineId, name, rawArgs, options);
    } catch (error) {
      if (options.actor !== 'user') await this.onFailed?.(engine, lineId, { name, args: rawArgs, actor: options.actor, via: options.via ?? null, taskId: options.taskId ?? null, error: (error as Error).message }).catch(() => undefined);
      throw error;
    }
  }

  private async runInner(
    engine: ProjectEngine,
    lineId: string,
    name: string,
    rawArgs: unknown,
    options: { actor: Actor; via?: string | null; taskId?: string | null; expected?: Record<string, string | null> },
  ): Promise<CommandResult> {
    const def = this.registry.get(name);
    const parsed = def.schema.safeParse(rawArgs);
    if (!parsed.success) throw new CommandError(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
    const args = parsed.data;
    const { texts, hashes } = await this.read(engine, lineId, def.files(args));
    // Expected revision: what the caller saw. If it moved on, the command is refused, not merged.
    for (const [p, h] of Object.entries(options.expected ?? {})) {
      const key = normalizeProjectPath(p);
      if (hashes.has(key) && hashes.get(key) !== h) throw new CommandError(`${key} changed since this action was prepared. Nothing was changed; try again.`);
    }
    const changes = def.apply(new Map(texts), args);
    const expected = new Map<string, string | null>();
    for (const p of changes.keys()) expected.set(normalizeProjectPath(p), hashes.has(normalizeProjectPath(p)) ? hashes.get(normalizeProjectPath(p))! : null);
    const label = def.label(args);
    const written = await engine.writeFiles(lineId, changes, expected, `${label}${options.actor === 'ai-task' ? ' (AI task)' : options.actor === 'ai-app' ? ` (${options.via ?? 'AI app'})` : ''}`);
    const record: CommandRecord = {
      id: `cmd-${randomUUID().slice(0, 12)}`,
      name,
      label,
      scope: def.scope(args),
      actor: options.actor,
      via: options.via ?? null,
      taskId: options.taskId ?? null,
      at: new Date().toISOString(),
      files: [...written.entries()].map(([p, after]) => ({ path: p, before: expected.get(p) ?? null, after })),
    };
    if (record.files.some((f) => f.before !== f.after)) {
      const all = await this.stacks(engine, lineId);
      const s = all[record.scope] ?? { undo: [], redo: [] };
      s.undo = [...s.undo, record].slice(-MAX_STACK);
      s.redo = [];
      all[record.scope] = s;
      await this.saveStacks(engine, lineId, all);
      await this.onRecord?.(engine, lineId, record).catch(() => undefined);
      if (record.actor !== 'user' && this.onApplied) {
        const files = [...changes].map(([p, t]) => ({ path: normalizeProjectPath(p), before: texts.get(normalizeProjectPath(p)) ?? null, after: typeof t === 'string' ? t : t === null ? null : '(binary)' }));
        await this.onApplied(engine, lineId, { record, args, files }).catch(() => undefined);
      }
    }
    const outTexts: Record<string, string | null> = {};
    for (const [p, t] of changes) outTexts[normalizeProjectPath(p)] = typeof t === 'string' ? t : null;
    return { record, hashes: Object.fromEntries(written), texts: outTexts };
  }

  /** Undo or redo the latest command in a scope. Refused if the files changed since. */
  async step(engine: ProjectEngine, lineId: string, scope: string, direction: 'undo' | 'redo'): Promise<CommandRecord | null> {
    const all = await this.stacks(engine, lineId);
    const s = all[scope] ?? { undo: [], redo: [] };
    const from = direction === 'undo' ? s.undo : s.redo;
    const record = from[from.length - 1];
    if (!record) return null;
    const tree = await engine.effectiveTree(lineId);
    const changes = new Map<string, string | Uint8Array | null>();
    const expected = new Map<string, string | null>();
    for (const f of record.files) {
      const want = direction === 'undo' ? f.after : f.before;
      const target = direction === 'undo' ? f.before : f.after;
      if ((tree.get(f.path) ?? null) !== want) {
        throw new CommandError(`${f.path} has changed since “${record.label}”, so it can’t be ${direction === 'undo' ? 'undone' : 'redone'} here. Use History to restore an earlier version.`);
      }
      expected.set(f.path, want);
      changes.set(f.path, target ? await engine.readBlob(target) : null);
    }
    await engine.writeFiles(lineId, changes, expected, `${direction === 'undo' ? 'Undo' : 'Redo'}: ${record.label}`);
    from.pop();
    (direction === 'undo' ? s.redo : s.undo).push(record);
    all[scope] = s;
    await this.saveStacks(engine, lineId, all);
    return record;
  }

  async state(engine: ProjectEngine, lineId: string, scope: string): Promise<{ undo: string | null; redo: string | null }> {
    const s = (await this.stacks(engine, lineId))[scope];
    return { undo: s?.undo[s.undo.length - 1]?.label ?? null, redo: s?.redo[s.redo.length - 1]?.label ?? null };
  }
}
