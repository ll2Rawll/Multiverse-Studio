/**
 * The coding agent's typed tools. Every call is validated (zod), scoped to the task's project and
 * working version, checked against the task's permissions, and executed through the application
 * services: file edits go through the revision engine (with expected-revision merging), commands
 * through the ProcessManager in a run directory, browser checks through an isolated BrowserProbe.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectEngine } from '../engine/project';
import { normalizeProjectPath } from '../shared/paths';
import { EDITING_MODES, type TaskView } from '../shared/ai';
import { commandCatalog, runStudioCommand, studioState } from '../director/director';
import { schemaSignature } from '../director/schema';
import { changedRanges } from '../live/describe';
import type { StudioService } from '../services/studio';
import { ApprovalRequired, type ToolHost, type ToolResult } from '../ai/runner';
import type { ToolCall, ToolSpec, JsonSchema } from '../ai/types';
import { redactor } from '../ai/redact';
import { classifyCommand, type TaskPermissions } from './permissions';
import { freePort, type ProcessManager } from './processes';
import { RunDirectory, isIgnoredPath } from './runDir';
import type { BrowserProbe, BrowserStep } from './browser';

const MAX_READ = 60_000;
/** Command output is kept up to this size; the runner then shortens it (or, with the token saver off, keeps the last 8 000 characters). */
const OUTPUT_TAIL = 60_000;

export interface ToolContext {
  studio: StudioService;
  engine: ProjectEngine;
  task: TaskView;
  /** Version the task reads (and edits in Build mode). */
  lineId: string;
  /** Version the user started from, for comparisons. */
  originLineId: string;
  mode: TaskView['mode'];
  permissions: TaskPermissions;
  processes: ProcessManager;
  runDir: RunDirectory;
  probe: BrowserProbe | null;
  artifactsDir: string;
  /** Called after the working version changes so the UI refreshes. */
  onChanged(paths: string[]): Promise<void>;
  onArtifact(artifact: NonNullable<TaskView['artifacts']>[number]): Promise<void>;
}

const pathArg = z.string().min(1).max(400);
const S = {
  list_files: z.object({ dir: z.string().max(400).optional() }),
  read_file: z.object({ path: pathArg, start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() }),
  search_project: z.object({ query: z.string().min(1).max(300), case_sensitive: z.boolean().optional() }),
  edit_file: z.object({ path: pathArg, edits: z.array(z.object({ find: z.string().min(1).max(100_000), replace: z.string().max(200_000), replace_all: z.boolean().optional() })).min(1).max(50) }),
  write_file: z.object({ path: pathArg, content: z.string().max(2_000_000) }),
  move_file: z.object({ from: pathArg, to: pathArg }),
  delete_file: z.object({ path: pathArg }),
  run_command: z.object({ program: z.string().min(1).max(40), args: z.array(z.string().max(500)).max(40), timeout_seconds: z.number().int().min(1).max(1800).optional() }),
  run_tests: z.object({}),
  start_dev_server: z.object({ script: z.string().regex(/^[A-Za-z0-9:_.-]{1,60}$/).optional() }),
  read_process_output: z.object({ process_id: z.string().max(40) }),
  stop_process: z.object({ process_id: z.string().max(40) }),
  inspect_preview: z.object({ page: z.string().max(300).optional() }),
  capture_screenshot: z.object({ page: z.string().max(300).optional(), width: z.number().int().min(320).max(2560).optional(), height: z.number().int().min(320).max(2000).optional() }),
  run_browser_check: z.object({
    page: z.string().max(300).optional(),
    steps: z.array(z.object({ action: z.enum(['click', 'fill', 'press', 'wait-for', 'expect-text']), selector: z.string().max(300).optional(), text: z.string().max(2000).optional(), key: z.string().max(40).optional() })).min(1).max(30),
  }),
  create_checkpoint: z.object({ name: z.string().min(1).max(80) }),
  compare_revisions: z.object({}),
  look_at_page: z.object({ page: z.string().max(300).optional(), question: z.string().min(1).max(1000), width: z.number().int().min(320).max(2560).optional(), height: z.number().int().min(320).max(2000).optional() }),
  get_studio_state: z.object({ include_sequences: z.boolean().optional(), include_assets: z.boolean().optional() }),
  list_studio_commands: z.object({ domain: z.enum(['video', 'design', 'code', 'assets', 'project', 'universe', 'render', 'objects', 'stories', 'story', 'release']).optional() }),
  run_studio_command: z.object({ name: z.string().min(3).max(80), args: z.record(z.string(), z.unknown()), expected: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/).nullable()).optional(), expected_revision: z.string().max(80).optional() }),
} as const;
type ToolName = keyof typeof S;

const str = (description: string): JsonSchema => ({ type: 'string', description });
export const SPECS: Record<ToolName, { description: string; parameters: JsonSchema; readOnly: boolean }> = {
  list_files: { readOnly: true, description: 'List the files of the working version (optionally under a folder).', parameters: { type: 'object', properties: { dir: str('Folder path, e.g. "src". Omit for all files.') } } },
  read_file: { readOnly: true, description: 'Read a text file. Lines are numbered. Use start_line/end_line for large files.', parameters: { type: 'object', properties: { path: str('Project path, e.g. "src/App.tsx"'), start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } },
  search_project: { readOnly: true, description: 'Search all text files for a string. Returns matching lines.', parameters: { type: 'object', properties: { query: str('Text to find'), case_sensitive: { type: 'boolean' } }, required: ['query'] } },
  edit_file: {
    readOnly: false,
    description: 'Edit a file by exact replacement; each `find` must match once unless replace_all. Read the file first.',
    parameters: { type: 'object', properties: { path: str('Project path'), edits: { type: 'array', items: { type: 'object', properties: { find: str('Exact text, unique in the file'), replace: str('New text'), replace_all: { type: 'boolean' } }, required: ['find', 'replace'] } } }, required: ['path', 'edits'] },
  },
  write_file: { readOnly: false, description: 'Create a file, or replace a whole file.', parameters: { type: 'object', properties: { path: str('Project path'), content: str('Full file content') }, required: ['path', 'content'] } },
  move_file: { readOnly: false, description: 'Move or rename a file.', parameters: { type: 'object', properties: { from: str('Current path'), to: str('New path') }, required: ['from', 'to'] } },
  delete_file: { readOnly: false, description: 'Delete a file.', parameters: { type: 'object', properties: { path: str('Project path') }, required: ['path'] } },
  run_command: {
    readOnly: false,
    description: 'Run a program in the project folder without a shell, e.g. npm with ["run","build"]. Scripts and installs follow the task permissions; other commands ask the user.',
    parameters: { type: 'object', properties: { program: str('Program, e.g. npm, node, pnpm'), args: { type: 'array', items: { type: 'string' } }, timeout_seconds: { type: 'integer' } }, required: ['program', 'args'] },
  },
  run_tests: { readOnly: false, description: 'Run the project tests (the package.json test script). For sites without tests, runs the built-in HTML/CSS/JS checks.', parameters: { type: 'object', properties: {} } },
  start_dev_server: { readOnly: false, description: 'Start the project dev server (package.json script, default "dev") on a free local port and wait until it is listening.', parameters: { type: 'object', properties: { script: str('Script name, e.g. dev or start') } } },
  read_process_output: { readOnly: false, description: 'Read the recent output of a process started by this task.', parameters: { type: 'object', properties: { process_id: str('Process id') }, required: ['process_id'] } },
  stop_process: { readOnly: false, description: 'Stop a process started by this task.', parameters: { type: 'object', properties: { process_id: str('Process id') }, required: ['process_id'] } },
  inspect_preview: { readOnly: true, description: 'Check a page of the running app (or the static site): HTTP status, title, console errors, and missing assets.', parameters: { type: 'object', properties: { page: str('Page path, e.g. "/" or "/about.html"') } } },
  capture_screenshot: { readOnly: true, description: 'Capture a screenshot of a page for the user to review.', parameters: { type: 'object', properties: { page: str('Page path'), width: { type: 'integer' }, height: { type: 'integer' } } } },
  run_browser_check: {
    readOnly: true,
    description: 'Browser interaction test on a page: click, fill, press, wait-for and expect-text steps with CSS selectors.',
    parameters: {
      type: 'object',
      properties: {
        page: str('Page path'),
        steps: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'fill', 'press', 'wait-for', 'expect-text'] }, selector: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' } }, required: ['action'] } },
      },
      required: ['steps'],
    },
  },
  create_checkpoint: { readOnly: false, description: 'Create a named checkpoint of the whole project.', parameters: { type: 'object', properties: { name: str('Checkpoint name') }, required: ['name'] } },
  compare_revisions: { readOnly: true, description: 'Summarise how the working version differs from the version the task started from.', parameters: { type: 'object', properties: {} } },
  look_at_page: {
    readOnly: true,
    description: 'Screenshot a page and ask the Visual inspection model about it (layout, contrast, what is visible). The screenshot is saved for the user.',
    parameters: { type: 'object', properties: { page: str('Page path, e.g. "/"'), question: str('What to look for'), width: { type: 'integer' }, height: { type: 'integer' } }, required: ['question'] },
  },
  get_studio_state: {
    readOnly: true,
    description:
      'Studio state by id: universes (and this task’s), referenced objects, playhead, sequences with track and clip ids, assets, living objects, stories, dependencies, processes, conflicts, models, budget. Use these ids; never guess from labels.',
    parameters: { type: 'object', properties: { include_sequences: { type: 'boolean' }, include_assets: { type: 'boolean' } } },
  },
  list_studio_commands: {
    readOnly: true,
    description: 'The studio’s commands (video, design, code, assets, objects, stories, project) with their argument signatures; the same commands as the user’s buttons.',
    parameters: { type: 'object', properties: { domain: { type: 'string', enum: ['video', 'design', 'code', 'assets', 'project', 'universe', 'render', 'objects', 'stories', 'story', 'release'] } } },
  },
  run_studio_command: {
    readOnly: false,
    description:
      'Run one studio command in this task’s universe (e.g. video.addText, video.trimClip), validated as for the user; one undoable step. `expected` (path → hash from an earlier result) refuses the change if the file changed since.',
    parameters: {
      type: 'object',
      properties: {
        name: str('From list_studio_commands'),
        args: { type: 'object', description: 'Matching the command’s signature' },
        expected: { type: 'object', description: 'File commands: path → content hash' },
        expected_revision: str('Project commands: the universe head from get_studio_state'),
      },
      required: ['name', 'args'],
    },
  },
};

function tail(text: string, n = OUTPUT_TAIL): string {
  return text.length > n ? `…(earlier output omitted)\n${text.slice(-n)}` : text;
}

function numbered(text: string, start: number, end: number): string {
  const lines = text.split('\n');
  const s = Math.max(1, start);
  const e = Math.min(lines.length, end);
  return lines
    .slice(s - 1, e)
    .map((l, i) => `${String(s + i).padStart(4)}| ${l}`)
    .join('\n');
}

export class AgentToolHost implements ToolHost {
  private readonly granted = new Set<string>();
  private readonly readHashes = new Map<string, string>();
  private devServer: { id: string; url: string } | null = null;
  private shots = 0;

  constructor(private readonly ctx: ToolContext) {}

  specs(): ToolSpec[] {
    return (Object.keys(SPECS) as ToolName[])
      .filter((name) => this.available(name))
      .map((name) => ({ name, description: SPECS[name].description, parameters: SPECS[name].parameters }));
  }

  private available(name: ToolName): boolean {
    if (!EDITING_MODES.includes(this.ctx.mode)) return SPECS[name].readOnly && name !== 'capture_screenshot' && name !== 'run_browser_check' && name !== 'look_at_page';
    if (['capture_screenshot', 'run_browser_check', 'look_at_page'].includes(name)) return this.ctx.probe !== null && this.ctx.permissions.operatePreview;
    if (['start_dev_server', 'inspect_preview'].includes(name)) return this.ctx.permissions.operatePreview || name === 'inspect_preview';
    return true;
  }

  grant(approvalId: string): void {
    this.granted.add(approvalId);
  }

  describe(call: ToolCall): string {
    const a = (call.args ?? {}) as Record<string, unknown>;
    switch (call.name) {
      case 'list_files':
        return a.dir ? `List files in ${String(a.dir)}` : 'List project files';
      case 'read_file':
        return `Read ${String(a.path)}`;
      case 'search_project':
        return `Search for “${String(a.query).slice(0, 60)}”`;
      case 'edit_file':
        return `Edit ${String(a.path)}`;
      case 'write_file':
        return `Write ${String(a.path)}`;
      case 'move_file':
        return `Move ${String(a.from)} to ${String(a.to)}`;
      case 'delete_file':
        return `Delete ${String(a.path)}`;
      case 'run_command':
        return `Run ${[a.program, ...(Array.isArray(a.args) ? a.args : [])].join(' ')}`;
      case 'run_tests':
        return 'Run tests';
      case 'start_dev_server':
        return `Start dev server${a.script ? ` (${String(a.script)})` : ''}`;
      case 'inspect_preview':
        return `Inspect ${String(a.page ?? '/')}`;
      case 'capture_screenshot':
        return `Screenshot ${String(a.page ?? '/')}`;
      case 'run_browser_check':
        return `Browser check on ${String(a.page ?? '/')}`;
      case 'create_checkpoint':
        return `Create checkpoint “${String(a.name)}”`;
      case 'compare_revisions':
        return 'Compare with the starting version';
      case 'get_studio_state':
        return 'Read the studio state';
      case 'look_at_page':
        return `Look at ${String(a.page ?? '/')}`;
      case 'list_studio_commands':
        return a.domain ? `List ${String(a.domain)} commands` : 'List studio commands';
      case 'run_studio_command':
        return `Run ${String(a.name)}`;
      default:
        return call.name;
    }
  }

  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const name = call.name as ToolName;
    if (!(name in S) || !this.available(name)) {
      return { ok: false, output: `Unknown or unavailable tool “${call.name}” in ${this.ctx.mode} mode.`, summary: `Unavailable tool ${call.name}` };
    }
    const parsed = S[name].safeParse(call.args ?? {});
    if (!parsed.success) {
      return { ok: false, output: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, summary: 'Invalid arguments' };
    }
    const args = parsed.data as never;
    try {
      return await (this as unknown as Record<ToolName, (a: never, s: AbortSignal) => Promise<ToolResult>>)[name].call(this, args, signal);
    } catch (error) {
      if (error instanceof ApprovalRequired) throw error;
      const message = redactor.redact((error as Error).message);
      return { ok: false, output: message, summary: message.slice(0, 160) };
    }
  }

  async dispose(): Promise<void> {
    await this.ctx.processes.stopOwner(this.ctx.task.id);
    this.devServer = null;
  }

  /* ---------------- helpers ---------------- */

  private safe(p: string): string {
    const n = normalizeProjectPath(p.replace(/^\.\//, ''));
    if (isIgnoredPath(n) && /(^|\/)\.env(\.|$)/.test(n)) throw new Error('.env files hold app secrets and are kept out of the project. Use .env.example for documented variables.');
    return n;
  }

  private requireEdit(): void {
    if (!EDITING_MODES.includes(this.ctx.mode) || !this.ctx.permissions.editAlternative) throw new Error('This task may not edit files. Switch to Build mode and allow editing its task alternative.');
  }

  private async tree(): Promise<Map<string, string>> {
    return this.ctx.engine.effectiveTree(this.ctx.lineId);
  }

  private async readText(p: string): Promise<{ text: string; hash: string } | null> {
    const hash = (await this.tree()).get(p);
    if (!hash) return null;
    const data = await this.ctx.engine.readBlob(hash);
    if (data.subarray(0, 8000).includes(0)) throw new Error(`${p} is a binary file.`);
    return { text: data.toString('utf8'), hash };
  }

  private async packageScripts(): Promise<Record<string, string> | null> {
    const pkg = await this.readText('package.json').catch(() => null);
    if (!pkg) return null;
    try {
      const json = JSON.parse(pkg.text) as { scripts?: Record<string, string> };
      return json.scripts ?? {};
    } catch {
      return {};
    }
  }

  private async afterEdit(paths: string[]): Promise<void> {
    await this.ctx.onChanged(paths);
  }

  /* ---------------- read tools ---------------- */

  async list_files(a: z.infer<typeof S.list_files>): Promise<ToolResult> {
    const dir = a.dir ? this.safe(a.dir).replace(/\/$/, '') : '';
    const files = [...(await this.tree()).keys()].filter((p) => !dir || p === dir || p.startsWith(`${dir}/`)).sort();
    const shown = files.slice(0, 500);
    return { ok: true, output: `${files.length} file${files.length === 1 ? '' : 's'}:\n${shown.join('\n')}${files.length > shown.length ? `\n…and ${files.length - shown.length} more` : ''}`, summary: `Listed ${files.length} files` };
  }

  async read_file(a: z.infer<typeof S.read_file>): Promise<ToolResult> {
    const p = this.safe(a.path);
    const file = await this.readText(p);
    if (!file) return { ok: false, output: `${p} does not exist. Use list_files to see what exists.`, summary: `${p} not found` };
    this.readHashes.set(p, file.hash);
    const total = file.text.split('\n').length;
    const start = a.start_line ?? 1;
    let end = a.end_line ?? total;
    let body = numbered(file.text, start, end);
    if (body.length > MAX_READ) {
      body = body.slice(0, MAX_READ);
      end = start + body.split('\n').length - 1;
      body += `\n…(truncated; read from line ${end + 1} with start_line)`;
    }
    return { ok: true, output: `${p} (${total} lines)\n${body}`, summary: `Read ${p}` };
  }

  async search_project(a: z.infer<typeof S.search_project>): Promise<ToolResult> {
    const matches = await this.ctx.studio.call('files.search', { projectId: this.ctx.task.projectId, ref: { kind: 'line', lineId: this.ctx.lineId }, query: a.query, caseSensitive: a.case_sensitive ?? false });
    const lines = matches.slice(0, 100).map((m) => `${m.path}:${m.line}: ${m.preview.trim()}`);
    return { ok: true, output: matches.length ? `${matches.length} match${matches.length === 1 ? '' : 'es'}\n${lines.join('\n')}` : 'No matches.', summary: `${matches.length} match${matches.length === 1 ? '' : 'es'} for “${a.query.slice(0, 40)}”` };
  }

  async compare_revisions(): Promise<ToolResult> {
    if (this.ctx.lineId === this.ctx.originLineId) return { ok: true, output: 'The task works directly on the starting version; there is nothing to compare.', summary: 'Nothing to compare' };
    const c = await this.ctx.studio.call('compare.run', { projectId: this.ctx.task.projectId, left: { kind: 'line', lineId: this.ctx.originLineId }, right: { kind: 'line', lineId: this.ctx.lineId } });
    const changed = c.files.filter((f) => f.status !== 'unchanged');
    return {
      ok: true,
      output: `${c.counts.added} added, ${c.counts.modified} modified, ${c.counts.deleted} deleted\n${changed.map((f) => `${f.status}: ${f.path}`).join('\n')}`,
      summary: `${changed.length} file${changed.length === 1 ? '' : 's'} differ from the starting version`,
    };
  }

  /* ---------------- studio (director) tools ---------------- */

  async get_studio_state(a: z.infer<typeof S.get_studio_state>): Promise<ToolResult> {
    const state = await studioState(this.ctx.studio, this.ctx.engine, this.ctx.task, this.ctx.lineId, { sequences: a.include_sequences, assets: a.include_assets });
    // Compact JSON: indentation would add about a third to every request that carries it.
    const text = JSON.stringify(state);
    return { ok: true, output: text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n…(truncated; ask for less with include_assets or include_sequences: false)` : text, summary: 'Read the studio state' };
  }

  async list_studio_commands(a: z.infer<typeof S.list_studio_commands>): Promise<ToolResult> {
    const list = commandCatalog(this.ctx.studio, a.domain);
    // One line per command with a TypeScript-like signature: the same arguments, bounds and enums as the JSON Schema, in far fewer tokens.
    const lines = list.map((c) => `${c.name} [${c.kind === 'operation' ? 'project' : 'undoable edit'}] ${c.description}\n  args: ${schemaSignature(c.args)}`);
    return { ok: true, output: `${list.length} commands. “?” marks optional arguments; ranges are inclusive.\n${lines.join('\n')}`, summary: `${list.length} command${list.length === 1 ? '' : 's'}${a.domain ? ` (${a.domain})` : ''}` };
  }

  async run_studio_command(a: z.infer<typeof S.run_studio_command>): Promise<ToolResult> {
    const ops = this.ctx.studio.operations;
    if (ops.registry.has(a.name)) {
      const { def, args } = ops.parse(a.name, a.args);
      if (def.effect !== 'read') this.requireEdit();
      const policy = def.ai(args, { universeId: this.ctx.lineId, permissions: this.ctx.permissions });
      if (!policy.allow) {
        if ('deny' in policy) throw new Error(policy.deny);
        const approvalId = `op:${a.name}:${JSON.stringify(args).slice(0, 400)}`;
        if (!this.granted.has(approvalId)) throw new ApprovalRequired({ id: approvalId, title: policy.approval, detail: `${a.name} ${JSON.stringify(args).slice(0, 400)}` });
      }
      const r = await ops.run(this.ctx.task.projectId, a.name, args, { actor: 'ai-task', taskId: this.ctx.task.id, expectedRevision: a.expected_revision ?? null });
      if (def.effect === 'change') await this.ctx.onChanged([]);
      let result = '';
      try {
        result = JSON.stringify(r.result, (k, v) => (k === 'project' ? undefined : v)).slice(0, MAX_READ);
      } catch {
        result = '';
      }
      return { ok: true, output: JSON.stringify({ done: r.summary, undo: r.undo?.label ?? null, activityId: r.record?.id ?? null, result: result ? JSON.parse(result.length < MAX_READ ? result : '{}') : null }), summary: r.summary };
    }
    this.requireEdit();
    const r = await runStudioCommand(this.ctx.studio, this.ctx.engine, this.ctx.lineId, this.ctx.task, a.name, a.args, a.expected ?? undefined);
    for (const [p, h] of Object.entries(r.hashes)) if (h) this.readHashes.set(p, h);
    await this.afterEdit(r.files);
    return { ok: true, output: JSON.stringify({ done: r.label, files: r.files, hashes: r.hashes, undoable: true, undoScope: r.undoScope, commandId: r.commandId }), summary: r.label, filesChanged: r.files };
  }

  /* ---------------- edit tools ---------------- */

  async edit_file(a: z.infer<typeof S.edit_file>): Promise<ToolResult> {
    this.requireEdit();
    const p = this.safe(a.path);
    const file = await this.readText(p);
    if (!file) return { ok: false, output: `${p} does not exist. Create it with write_file.`, summary: `${p} not found` };
    let text = file.text;
    for (const [i, e] of a.edits.entries()) {
      const count = text.split(e.find).length - 1;
      if (count === 0) return { ok: false, output: `Edit ${i + 1}: the find text was not found in ${p}. Read the file again and copy the exact text, including whitespace.`, summary: `Edit did not match in ${p}` };
      if (count > 1 && !e.replace_all) return { ok: false, output: `Edit ${i + 1}: the find text appears ${count} times in ${p}. Include more surrounding text so it is unique, or set replace_all.`, summary: `Ambiguous edit in ${p}` };
      text = e.replace_all ? text.split(e.find).join(e.replace) : text.replace(e.find, () => e.replace);
    }
    // Expected revision: the version the agent read. Concurrent changes are merged, overlaps refused.
    const base = this.readHashes.get(p) ?? file.hash;
    const r = await this.ctx.engine.writeFile(this.ctx.lineId, p, text, { baseHash: base });
    this.readHashes.set(p, r.hash);
    await this.afterEdit([p]);
    const diag = await this.ctx.studio.call('files.diagnostics', { projectId: this.ctx.task.projectId, ref: { kind: 'line', lineId: this.ctx.lineId }, path: p }).catch(() => []);
    const problems = diag.filter((d) => d.severity === 'error');
    return {
      ok: true,
      output: `Edited ${p} (${a.edits.length} change${a.edits.length === 1 ? '' : 's'}).${r.mergedText !== null ? ' The file had changed meanwhile; the edits were merged.' : ''}${problems.length ? `\nSyntax problems now in the file:\n${problems.map((d) => `line ${d.line}: ${d.message}`).join('\n')}` : ''}`,
      summary: `Edited ${p}${problems.length ? ` (${problems.length} syntax problem${problems.length === 1 ? '' : 's'})` : ''}`,
      filesChanged: [p],
      targets: [{ kind: 'code', path: p, ranges: changedRanges(file.text, r.mergedText ?? text), created: false }],
    };
  }

  async write_file(a: z.infer<typeof S.write_file>): Promise<ToolResult> {
    this.requireEdit();
    const p = this.safe(a.path);
    const current = (await this.tree()).get(p);
    const before = current ? ((await this.readText(p).catch(() => null))?.text ?? null) : null;
    const base = current ? (this.readHashes.get(p) ?? current) : undefined;
    const r = await this.ctx.engine.writeFile(this.ctx.lineId, p, a.content, base ? { baseHash: base } : {});
    this.readHashes.set(p, r.hash);
    await this.afterEdit([p]);
    return { ok: true, output: `${current ? 'Replaced' : 'Created'} ${p} (${a.content.length} characters).`, summary: `${current ? 'Replaced' : 'Created'} ${p}`, filesChanged: [p], targets: [{ kind: 'code', path: p, ranges: changedRanges(before, r.mergedText ?? a.content), created: !current }] };
  }

  async move_file(a: z.infer<typeof S.move_file>): Promise<ToolResult> {
    this.requireEdit();
    const from = this.safe(a.from);
    const to = this.safe(a.to);
    const tree = await this.tree();
    const hash = tree.get(from);
    if (!hash) return { ok: false, output: `${from} does not exist.`, summary: `${from} not found` };
    if (tree.has(to)) return { ok: false, output: `${to} already exists.`, summary: `${to} exists` };
    await this.ctx.engine.writeFile(this.ctx.lineId, to, await this.ctx.engine.readBlob(hash), { mustNotExist: true });
    await this.ctx.engine.deleteFile(this.ctx.lineId, from);
    await this.afterEdit([from, to]);
    return { ok: true, output: `Moved ${from} to ${to}. Update any references to the old path.`, summary: `Moved ${from} → ${to}`, filesChanged: [from, to] };
  }

  async delete_file(a: z.infer<typeof S.delete_file>): Promise<ToolResult> {
    this.requireEdit();
    const p = this.safe(a.path);
    if (!(await this.tree()).has(p)) return { ok: false, output: `${p} does not exist.`, summary: `${p} not found` };
    await this.ctx.engine.deleteFile(this.ctx.lineId, p);
    await this.afterEdit([p]);
    return { ok: true, output: `Deleted ${p}. It can be restored from History.`, summary: `Deleted ${p}`, filesChanged: [p] };
  }

  async create_checkpoint(a: z.infer<typeof S.create_checkpoint>): Promise<ToolResult> {
    this.requireEdit();
    const view = await this.ctx.studio.call('history.createCheckpoint', { projectId: this.ctx.task.projectId, name: a.name, description: `Created by the task “${this.ctx.task.title}”` });
    void view;
    return { ok: true, output: `Checkpoint “${a.name}” created.`, summary: `Checkpoint “${a.name}”` };
  }

  /* ---------------- commands ---------------- */

  private async runInRunDir(program: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<ToolResult & { exitCode: number | null }> {
    if (!EDITING_MODES.includes(this.ctx.mode)) throw new Error('Commands run only in Build or Autopilot mode.');
    const scripts = (await this.packageScripts()) ?? {};
    const cls = classifyCommand(program, args, scripts);
    const approvalId = `cmd:${[program, ...args].join(' ')}`;
    const allowed = cls.permission !== 'approval' && this.ctx.permissions[cls.permission];
    if (!allowed && !this.granted.has(approvalId)) {
      const reason = cls.permission === 'approval' ? cls.reason : cls.permission === 'installDependencies' ? 'Installing dependencies was not allowed for this task.' : 'Running the project’s scripts was not allowed for this task.';
      throw new ApprovalRequired({ id: approvalId, title: `Run “${[program, ...args].join(' ')}”`, detail: `${reason} It runs on this computer in a copy of the task alternative, as you, with no access to Multiverse Studio’s keys. This is not a sandbox.` });
    }
    await this.ctx.runDir.prepare();
    const result = await this.ctx.processes.run(program, args, { cwd: this.ctx.runDir.dir, owner: this.ctx.task.id, timeoutMs, signal });
    const collected = await this.ctx.runDir.collect();
    const changed = [...collected.changed, ...collected.added, ...collected.deleted];
    if (changed.length) await this.afterEdit(changed);
    const status = result.cancelled ? 'cancelled' : result.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exit code ${result.exitCode}`;
    const notes = [
      changed.length ? `Files changed by the command: ${changed.join(', ')}` : '',
      collected.conflicts.length ? `Not brought back (overlapping edits): ${collected.conflicts.map((c) => c.path).join(', ')}` : '',
    ].filter(Boolean);
    return {
      ok: result.exitCode === 0 && !result.timedOut && !result.cancelled,
      exitCode: result.exitCode,
      output: `$ ${[program, ...args].join(' ')}\n${status} in ${(result.durationMs / 1000).toFixed(1)} s\n${notes.join('\n')}\n${tail(redactor.redact(result.output))}`.trim(),
      summary: `${[program, ...args].join(' ')}: ${status}`,
      filesChanged: changed,
    };
  }

  async run_command(a: z.infer<typeof S.run_command>, signal: AbortSignal): Promise<ToolResult> {
    return this.runInRunDir(a.program, a.args, (a.timeout_seconds ?? 300) * 1000, signal);
  }

  async run_tests(_a: unknown, signal: AbortSignal): Promise<ToolResult> {
    const scripts = await this.packageScripts();
    if (scripts?.test && !/no test specified/.test(scripts.test)) {
      const r = await this.runInRunDir('npm', ['test'], 600_000, signal);
      return { ...r, summary: r.ok ? 'Tests passed' : `Tests failed (${r.summary.split(': ').pop()})` };
    }
    // No test script: run the built-in static checks over the site's files instead, and say so.
    const files = [...(await this.tree()).keys()].filter((p) => /\.(html?|css|m?js)$/i.test(p));
    const problems: string[] = [];
    for (const p of files.slice(0, 200)) {
      const diags = await this.ctx.studio.call('files.diagnostics', { projectId: this.ctx.task.projectId, ref: { kind: 'line', lineId: this.ctx.lineId }, path: p }).catch(() => []);
      for (const d of diags) problems.push(`${d.severity} ${p}:${d.line}: ${d.message}`);
    }
    const missing = await this.missingAssets();
    problems.push(...missing.map((m) => `error ${m}`));
    const errors = problems.filter((p) => p.startsWith('error')).length;
    return {
      ok: errors === 0,
      output: `This project has no test script, so the built-in checks ran instead (syntax and missing local files) on ${files.length} files.\n${problems.length ? problems.join('\n') : 'No problems found.'}`,
      summary: errors ? `Static checks: ${errors} error${errors === 1 ? '' : 's'}` : 'Static checks passed (no test script)',
    };
  }

  async start_dev_server(a: z.infer<typeof S.start_dev_server>, signal: AbortSignal): Promise<ToolResult> {
    if (!this.ctx.permissions.operatePreview) throw new Error('Running the preview was not allowed for this task.');
    const scripts = await this.packageScripts();
    if (!scripts) {
      const handle = await this.ctx.studio.call('preview.open', { projectId: this.ctx.task.projectId, ref: { kind: 'line', lineId: this.ctx.lineId } });
      return { ok: true, output: `This is a static site, so it needs no dev server. Its built-in preview is at ${handle.url}. Use inspect_preview to check pages.`, summary: 'Static site: using the built-in preview' };
    }
    const script = a.script ?? (scripts.dev ? 'dev' : scripts.start ? 'start' : null);
    if (!script || !scripts[script]) return { ok: false, output: `package.json has no ${a.script ?? 'dev or start'} script. Scripts: ${Object.keys(scripts).join(', ') || 'none'}.`, summary: 'No dev script' };
    const cls = classifyCommand('npm', ['run', script], scripts);
    if (cls.permission !== 'runBuildAndTests' || !this.ctx.permissions.runBuildAndTests) {
      const id = `dev:${script}`;
      if (!this.granted.has(id)) throw new ApprovalRequired({ id, title: `Start the dev server (npm run ${script})`, detail: 'Running the project’s scripts was not allowed for this task.' });
    }
    if (this.devServer) await this.ctx.processes.stop(this.devServer.id);
    const port = await freePort();
    const vite = /\bvite\b/.test(scripts[script]!);
    const args = ['run', script, ...(vite ? ['--', '--port', String(port), '--strictPort', '--host', '127.0.0.1'] : [])];
    await this.ctx.runDir.prepare();
    const started = await this.ctx.processes.start('npm', args, { cwd: this.ctx.runDir.dir, owner: this.ctx.task.id, label: `npm ${args.join(' ')}`, port, env: { PORT: String(port), HOST: '127.0.0.1' }, signal });
    if (!started.ready) return { ok: false, output: `The dev server did not start listening on port ${port}.\n${tail(redactor.redact(started.output))}`, summary: 'Dev server failed to start' };
    this.devServer = { id: started.process.id, url: started.process.url! };
    return { ok: true, output: `Dev server running at ${started.process.url} (process ${started.process.id}). It stops when the task ends.\n${tail(redactor.redact(started.output), 2000)}`, summary: `Dev server at ${started.process.url}` };
  }

  async read_process_output(a: z.infer<typeof S.read_process_output>): Promise<ToolResult> {
    const owned = this.ctx.processes.list(this.ctx.task.id).some((p) => p.id === a.process_id);
    const out = owned ? this.ctx.processes.output(a.process_id) : null;
    if (!out) return { ok: false, output: `No process ${a.process_id} belongs to this task.`, summary: 'Unknown process' };
    return { ok: true, output: `${out.exited ? `Exited with code ${out.exitCode}` : 'Running'}\n${tail(redactor.redact(out.output))}`, summary: `Output of ${a.process_id}` };
  }

  async stop_process(a: z.infer<typeof S.stop_process>): Promise<ToolResult> {
    const owned = this.ctx.processes.list(this.ctx.task.id).some((p) => p.id === a.process_id);
    if (!owned) return { ok: false, output: `No process ${a.process_id} belongs to this task.`, summary: 'Unknown process' };
    await this.ctx.processes.stop(a.process_id);
    if (this.devServer?.id === a.process_id) {
      this.devServer = null;
      const collected = await this.ctx.runDir.collect();
      const changed = [...collected.changed, ...collected.added, ...collected.deleted];
      if (changed.length) await this.afterEdit(changed);
    }
    return { ok: true, output: `Stopped ${a.process_id}.`, summary: `Stopped ${a.process_id}` };
  }

  /* ---------------- preview and browser ---------------- */

  private async pageUrl(page: string | undefined): Promise<string> {
    const rel = (page ?? '/').replace(/^\/+/, '');
    if (this.devServer) return new URL(rel, this.devServer.url).toString();
    const handle = await this.ctx.studio.call('preview.open', { projectId: this.ctx.task.projectId, ref: { kind: 'line', lineId: this.ctx.lineId } });
    return new URL(rel, handle.url).toString();
  }

  /** Local files referenced from HTML that do not exist in the version. */
  private async missingAssets(): Promise<string[]> {
    const tree = await this.tree();
    const out: string[] = [];
    for (const p of [...tree.keys()].filter((f) => /\.html?$/i.test(f)).slice(0, 100)) {
      const file = await this.readText(p).catch(() => null);
      if (!file) continue;
      const re = /\s(?:src|href)\s*=\s*["']([^"'#?]+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(file.text))) {
        const ref = m[1]!;
        if (/^(?:[a-z]+:|\/\/|data:|mailto:)/i.test(ref)) continue;
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(p), ref.startsWith('/') ? `.${ref}` : ref)).replace(/^\.\//, '');
        if (!tree.has(resolved) && !tree.has(`${resolved.replace(/\/$/, '')}/index.html`)) out.push(`${p}: missing ${ref}`);
      }
    }
    return out;
  }

  async inspect_preview(a: z.infer<typeof S.inspect_preview>): Promise<ToolResult> {
    const missing = this.devServer ? [] : await this.missingAssets();
    if (this.ctx.probe && this.ctx.permissions.operatePreview && EDITING_MODES.includes(this.ctx.mode)) {
      const url = await this.pageUrl(a.page);
      const r = await this.ctx.probe.check({ url, width: 1280, height: 800, screenshot: false, steps: [], timeoutMs: 20_000 });
      const errs = [...r.errors, ...r.console.filter((c) => c.level === 'error').map((c) => c.text)];
      return {
        ok: (r.status === null || r.status < 400) && errs.length === 0 && missing.length === 0,
        output: `${url}\nStatus: ${r.status ?? 'n/a'} · Title: ${r.title || '(none)'}\nConsole errors: ${errs.length ? `\n${errs.join('\n')}` : 'none'}\nMissing local files: ${missing.length ? `\n${missing.join('\n')}` : 'none'}`,
        summary: `${a.page ?? '/'}: ${r.status ?? 'loaded'}, ${errs.length} console error${errs.length === 1 ? '' : 's'}${missing.length ? `, ${missing.length} missing file${missing.length === 1 ? '' : 's'}` : ''}`,
      };
    }
    if (this.devServer) {
      const url = await this.pageUrl(a.page);
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
      if (res instanceof Error) return { ok: false, output: `Could not load ${url}: ${res.message}`, summary: 'Page did not load' };
      const body = await res.text();
      const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1] ?? '';
      return { ok: res.status < 400, output: `${url}\nStatus: ${res.status} · Title: ${title || '(none)'}\nNo browser is available here, so console errors were not checked.\n${body.slice(0, 1500)}`, summary: `${a.page ?? '/'}: HTTP ${res.status}` };
    }
    const page = a.page && a.page !== '/' ? this.safe(a.page.replace(/^\//, '')) : 'index.html';
    const diags = await this.ctx.studio.call('files.diagnostics', { projectId: this.ctx.task.projectId, ref: { kind: 'line', lineId: this.ctx.lineId }, path: page }).catch((e: Error) => [{ severity: 'error' as const, message: e.message, line: 0, column: 0, source: 'html' as const }]);
    return {
      ok: missing.length === 0 && !diags.some((d) => d.severity === 'error'),
      output: `Static check of ${page} (no browser available for this task):\n${diags.map((d) => `${d.severity} line ${d.line}: ${d.message}`).join('\n') || 'No syntax problems.'}\nMissing local files: ${missing.length ? `\n${missing.join('\n')}` : 'none'}`,
      summary: `${page}: ${diags.length} problem${diags.length === 1 ? '' : 's'}, ${missing.length} missing file${missing.length === 1 ? '' : 's'}`,
    };
  }

  async capture_screenshot(a: z.infer<typeof S.capture_screenshot>): Promise<ToolResult> {
    if (!this.ctx.probe) throw new Error('No browser is available to capture screenshots here.');
    const url = await this.pageUrl(a.page);
    const r = await this.ctx.probe.check({ url, width: a.width ?? 1280, height: a.height ?? 800, screenshot: true, steps: [], timeoutMs: 20_000 });
    if (!r.screenshot) return { ok: false, output: `The page loaded with status ${r.status ?? 'n/a'} but no screenshot was produced.`, summary: 'No screenshot' };
    this.shots += 1;
    const file = `shot-${Date.now().toString(36)}-${this.shots}.png`;
    await fs.mkdir(this.ctx.artifactsDir, { recursive: true });
    await fs.writeFile(path.join(this.ctx.artifactsDir, file), Buffer.from(r.screenshot, 'base64'));
    const label = `${!a.page || a.page === '/' ? 'Home page' : a.page} at ${a.width ?? 1280}×${a.height ?? 800}`;
    await this.ctx.onArtifact({ id: file, kind: 'screenshot', label, file, at: new Date().toISOString() });
    return { ok: true, output: `Screenshot of ${url} saved for the user (${label}). Title: ${r.title || '(none)'}. Console errors: ${r.errors.length + r.console.filter((c) => c.level === 'error').length}.`, summary: `Screenshot of ${label}` };
  }

  async look_at_page(a: z.infer<typeof S.look_at_page>, signal: AbortSignal): Promise<ToolResult> {
    if (!this.ctx.probe) throw new Error('No browser is available to take screenshots here.');
    const ai = this.ctx.studio.aiService;
    if (!ai) throw new Error('AI is not configured here.');
    let route: Awaited<ReturnType<typeof ai.resolve>>;
    try {
      route = await ai.resolve('visual-inspection');
    } catch (error) {
      return { ok: false, output: `No model for Visual inspection: ${(error as Error).message} Assign a model with vision in Settings → Models → Visual inspection, or use capture_screenshot so the user can look.`, summary: 'No visual-inspection model' };
    }
    const width = a.width ?? 1280;
    const height = a.height ?? 800;
    const url = await this.pageUrl(a.page);
    const r = await this.ctx.probe.check({ url, width, height, screenshot: true, steps: [], timeoutMs: 20_000 });
    if (!r.screenshot) return { ok: false, output: `The page loaded with status ${r.status ?? 'n/a'} but no screenshot was produced.`, summary: 'No screenshot' };
    this.shots += 1;
    const file = `look-${Date.now().toString(36)}-${this.shots}.png`;
    await fs.mkdir(this.ctx.artifactsDir, { recursive: true });
    await fs.writeFile(path.join(this.ctx.artifactsDir, file), Buffer.from(r.screenshot, 'base64'));
    const label = `${!a.page || a.page === '/' ? 'Home page' : a.page} at ${width}×${height} (sent to ${route.local ? 'a local model' : route.connection.name})`;
    await this.ctx.onArtifact({ id: file, kind: 'screenshot', label, file, at: new Date().toISOString() });
    let text = '';
    let input: number | null = null;
    let output: number | null = null;
    for await (const ev of ai.generate(route, { system: 'You inspect screenshots of web pages for a design director. Describe only what is visible in the image. Be specific and brief.', messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', dataBase64: r.screenshot }, { type: 'text', text: a.question }] }], maxOutputTokens: 800 }, signal)) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'usage') {
        input = ev.inputTokens;
        output = ev.outputTokens;
      }
    }
    return { ok: true, output: `${route.model.label} looked at ${url}:\n${text.trim() || '(no answer)'}`, summary: `Looked at ${!a.page || a.page === '/' ? 'the home page' : a.page}`, usage: { input, output, cost: ai.estimateCost(route.model, input, output) } };
  }

  async run_browser_check(a: z.infer<typeof S.run_browser_check>): Promise<ToolResult> {
    if (!this.ctx.probe) throw new Error('No browser is available for interaction tests here.');
    const url = await this.pageUrl(a.page);
    const r = await this.ctx.probe.check({ url, width: 1280, height: 800, screenshot: false, steps: a.steps as BrowserStep[], timeoutMs: 30_000 });
    const failed = r.steps.filter((s) => !s.ok);
    const errs = [...r.errors, ...r.console.filter((c) => c.level === 'error').map((c) => c.text)];
    return {
      ok: failed.length === 0 && errs.length === 0,
      output: `${url}\n${r.steps.map((s, i) => `${s.ok ? 'PASS' : 'FAIL'} ${i + 1}. ${s.action}: ${s.detail}`).join('\n')}\nConsole errors: ${errs.length ? `\n${errs.join('\n')}` : 'none'}`,
      summary: failed.length ? `Browser check: ${failed.length} of ${r.steps.length} steps failed` : `Browser check passed (${r.steps.length} steps)`,
    };
  }
}
