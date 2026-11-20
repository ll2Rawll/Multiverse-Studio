/**
 * Build workspace backend: the user's own terminal commands, package scripts and dev servers.
 *
 * Commands run in a run folder (a copy of one version, synced from the revision store before
 * every command) with a scrubbed environment: the app's AI keys and other secrets of this app
 * are never passed to a project's programs. Programs are started without a shell.
 *
 * Files that commands create or change (a lockfile, generated code) only come back into the
 * version when the user chooses "Bring changes in" (`collect`).
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ProcessManager, freePort, isListening, type ManagedProcess } from '../agent/processes';
import { RunDirectory } from '../agent/runDir';
import type { ProjectEngine } from '../engine/project';
import { StudioError } from '../engine/errors';
import { parseCommandLine, CommandLineError } from './commandLine';
import type { BuildCollectView, BuildOutputView, BuildProcessView, BuildStateView } from '../shared/build';
import type { StudioEvent } from '../shared/types';

export interface BuildHost {
  engine(projectId: string): Promise<ProjectEngine>;
  emit(event: StudioEvent): void;
  changed(engine: ProjectEngine, reason: string, lineIds: string[]): Promise<unknown>;
}

interface Tracked {
  projectId: string;
  lineId: string;
  kind: BuildProcessView['kind'];
  status: BuildProcessView['status'];
}

const KEEP_FINISHED = 12;
const DEV_READY_TIMEOUT_MS = 120_000;

export class BuildService {
  readonly processes = new ProcessManager();
  private readonly runDirs = new Map<string, RunDirectory>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly pending = new Map<string, { chunks: string[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly host: BuildHost,
    private readonly cacheRoot: string,
  ) {}

  runFolder(projectId: string, lineId: string): string {
    return path.join(this.cacheRoot, 'runs', projectId, `build-${lineId}`);
  }

  /** After the run folders were deleted (Settings → Storage): start from fresh folders next time. */
  forgetRunFolders(): void {
    this.runDirs.clear();
  }

  private async runDir(projectId: string, lineId: string): Promise<RunDirectory> {
    const key = `${projectId}:${lineId}`;
    let dir = this.runDirs.get(key);
    if (!dir) {
      const engine = await this.host.engine(projectId);
      engine.line(lineId); // throws for an unknown version
      dir = new RunDirectory(this.runFolder(projectId, lineId), engine, lineId);
      this.runDirs.set(key, dir);
    }
    await dir.prepare();
    return dir;
  }

  private async packageJson(projectId: string, lineId: string): Promise<{ scripts: Record<string, string>; deps: Record<string, string> } | null> {
    const engine = await this.host.engine(projectId);
    const tree = await engine.effectiveTree(lineId);
    const hash = tree.get('package.json');
    if (!hash) return null;
    try {
      const pkg = JSON.parse(Buffer.from(await engine.readBlob(hash)).toString('utf8')) as { scripts?: unknown; dependencies?: unknown; devDependencies?: unknown };
      const strings = (o: unknown): Record<string, string> =>
        o && typeof o === 'object' ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
      return { scripts: strings(pkg.scripts), deps: { ...strings(pkg.dependencies), ...strings(pkg.devDependencies) } };
    } catch {
      throw new StudioError('invalid-package', 'package.json is not valid JSON. Fix it in Build, then try again.');
    }
  }

  private view(info: ManagedProcess): BuildProcessView {
    const t = this.tracked.get(info.id);
    const status: BuildProcessView['status'] = info.exited ? (t?.status === 'failed' || (info.exitCode !== 0 && info.exitCode !== null) ? 'failed' : 'exited') : (t?.status ?? 'running');
    return { id: info.id, kind: t?.kind ?? 'command', label: info.label, lineId: t?.lineId ?? '', startedAt: info.startedAt, status, exitCode: info.exitCode, url: info.url, port: info.port };
  }

  private publish(projectId: string, info: ManagedProcess, chunk?: string): void {
    const t = this.tracked.get(info.id);
    this.host.emit({ type: 'build', projectId, lineId: t?.lineId ?? '', process: this.view(info), ...(chunk ? { chunk } : {}) });
  }

  /** Output is batched so a chatty build doesn't flood the UI with messages. */
  private stream(projectId: string, id: string, chunk: string): void {
    const p = this.pending.get(id);
    if (p) {
      p.chunks.push(chunk);
      return;
    }
    const entry = {
      chunks: [chunk],
      timer: setTimeout(() => {
        this.pending.delete(id);
        const info = this.processes.info(id);
        if (info) this.publish(projectId, info, entry.chunks.join(''));
      }, 60),
    };
    this.pending.set(id, entry);
  }

  private flush(projectId: string, id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    const info = this.processes.info(id);
    if (info) this.publish(projectId, info, p.chunks.join(''));
  }

  private prune(projectId: string): void {
    const finished = this.processes
      .list(`build:${projectId}`)
      .filter((p) => p.exited)
      .sort((a, b) => b.startedAt - a.startedAt);
    for (const p of finished.slice(KEEP_FINISHED)) {
      this.processes.forget(p.id);
      this.tracked.delete(p.id);
    }
  }

  async state(projectId: string, lineId: string): Promise<BuildStateView> {
    const pkg = await this.packageJson(projectId, lineId);
    const folder = this.runFolder(projectId, lineId);
    // A package without dependencies has nothing to install.
    const installed =
      !pkg ||
      Object.keys(pkg.deps).length === 0 ||
      (await fs.stat(path.join(folder, 'node_modules')).then(
        (s) => s.isDirectory(),
        () => false,
      ));
    const devScript = pkg?.scripts.dev ? 'dev' : pkg?.scripts.start ? 'start' : null;
    return {
      projectId,
      lineId,
      runFolder: folder,
      hasPackageJson: pkg !== null,
      scripts: pkg?.scripts ?? {},
      dependenciesInstalled: installed,
      devScript,
      processes: this.processes
        .list(`build:${projectId}`)
        .filter((p) => this.tracked.get(p.id)?.lineId === lineId)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((p) => this.view(p)),
    };
  }

  private launch(projectId: string, lineId: string, dir: RunDirectory, program: string, args: string[], label: string, kind: BuildProcessView['kind'], env: Record<string, string> = {}): ManagedProcess {
    let id = '';
    const { process: info, done } = this.processes.spawnTracked(program, args, {
      cwd: dir.dir,
      owner: `build:${projectId}`,
      label,
      env: { FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      onOutput: (chunk) => {
        if (id) this.stream(projectId, id, chunk);
      },
    });
    id = info.id;
    this.tracked.set(id, { projectId, lineId, kind, status: kind === 'dev-server' ? 'starting' : 'running' });
    void done.then((finished) => {
      this.flush(projectId, id);
      const t = this.tracked.get(id);
      if (t && t.status === 'starting') t.status = 'failed';
      this.publish(projectId, finished);
      this.prune(projectId);
    });
    this.publish(projectId, info);
    return info;
  }

  /** Run a command typed in the terminal. */
  async run(projectId: string, lineId: string, commandLine: string): Promise<BuildProcessView> {
    let parsed: { program: string; args: string[] };
    try {
      parsed = parseCommandLine(commandLine);
    } catch (error) {
      if (error instanceof CommandLineError) throw new StudioError('invalid-command', error.message);
      throw error;
    }
    const dir = await this.runDir(projectId, lineId);
    return this.view(this.launch(projectId, lineId, dir, parsed.program, parsed.args, commandLine.trim(), 'command'));
  }

  async runScript(projectId: string, lineId: string, script: string): Promise<BuildProcessView> {
    const pkg = await this.packageJson(projectId, lineId);
    if (!pkg?.scripts[script]) throw new StudioError('not-found', `There is no “${script}” script in package.json.`);
    const dir = await this.runDir(projectId, lineId);
    const args = script === 'test' ? ['test'] : ['run', script];
    return this.view(this.launch(projectId, lineId, dir, 'npm', args, `npm ${args.join(' ')}`, 'command'));
  }

  async install(projectId: string, lineId: string): Promise<BuildProcessView> {
    if (!(await this.packageJson(projectId, lineId))) throw new StudioError('not-found', 'This version has no package.json, so there is nothing to install.');
    const dir = await this.runDir(projectId, lineId);
    return this.view(this.launch(projectId, lineId, dir, 'npm', ['install', '--no-audit', '--no-fund'], 'npm install', 'command'));
  }

  /** Start (or return the running) dev server for a version. Readiness is reported through events. */
  async startDevServer(projectId: string, lineId: string): Promise<BuildProcessView> {
    const running = this.processes
      .list(`build:${projectId}`)
      .find((p) => !p.exited && this.tracked.get(p.id)?.kind === 'dev-server' && this.tracked.get(p.id)?.lineId === lineId);
    if (running) return this.view(running);
    const pkg = await this.packageJson(projectId, lineId);
    const script = pkg?.scripts.dev ? 'dev' : pkg?.scripts.start ? 'start' : null;
    if (!pkg || !script) throw new StudioError('no-dev-script', 'This version has no “dev” or “start” script. Static sites use the built-in preview instead.');
    const dir = await this.runDir(projectId, lineId);
    const installed =
      Object.keys(pkg.deps).length === 0 ||
      (await fs.stat(path.join(dir.dir, 'node_modules')).then(
        () => true,
        () => false,
      ));
    if (!installed) throw new StudioError('needs-install', 'Install dependencies first (Install in the Build panel runs npm install).');
    const port = await freePort();
    const usesVite = 'vite' in pkg.deps;
    let args = ['run', script];
    let env: Record<string, string> = { BROWSER: 'none' };
    if (usesVite) {
      // Vite takes the port as arguments; PORT is left for an API server that the dev script may also start.
      args = [...args, '--', '--port', String(port), '--strictPort', '--host', '127.0.0.1'];
      // Neither port is taken yet, so make sure the two differ.
      let apiPort = await freePort();
      while (apiPort === port) apiPort = await freePort();
      env = { ...env, PORT: String(apiPort) };
    } else {
      env = { ...env, PORT: String(port), HOST: '127.0.0.1' };
    }
    const info = this.launch(projectId, lineId, dir, 'npm', args, `Dev server (npm run ${script})`, 'dev-server', env);
    void this.waitUntilListening(projectId, info.id, port);
    return this.view(info);
  }

  private async waitUntilListening(projectId: string, id: string, port: number): Promise<void> {
    const deadline = Date.now() + DEV_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const info = this.processes.info(id);
      if (!info || info.exited) return;
      if (await isListening(port)) {
        this.processes.setUrl(id, `http://127.0.0.1:${port}/`, port);
        const t = this.tracked.get(id);
        if (t) t.status = 'ready';
        this.publish(projectId, this.processes.info(id)!);
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    const t = this.tracked.get(id);
    if (t) t.status = 'failed';
    this.stream(projectId, id, `\nThe dev server did not start listening on port ${port} within ${DEV_READY_TIMEOUT_MS / 1000} seconds, so it was stopped.\n`);
    await this.processes.stop(id).catch(() => undefined);
  }

  async stop(projectId: string, processId: string): Promise<boolean> {
    if (this.tracked.get(processId)?.projectId !== projectId) return false;
    const info = this.processes.info(processId);
    if (!info) return false;
    if (info.exited) {
      this.processes.forget(processId);
      this.tracked.delete(processId);
      return true;
    }
    // Keep the finished entry so its output stays readable.
    await this.processes.stop(processId, { keep: true });
    return true;
  }

  output(projectId: string, processId: string): BuildOutputView {
    const info = this.processes.info(processId);
    const out = this.processes.output(processId);
    if (!info || !out || this.tracked.get(processId)?.projectId !== projectId) throw new StudioError('not-found', 'That process is no longer available.');
    return { output: out.output, truncated: out.truncated, process: this.view(info) };
  }

  /** Bring files that commands created or changed back into the version. */
  async collect(projectId: string, lineId: string): Promise<BuildCollectView> {
    const dir = this.runDirs.get(`${projectId}:${lineId}`);
    if (!dir) return { changed: [], added: [], deleted: [], skipped: [], conflicts: [] };
    const result = await dir.collect();
    if (result.changed.length + result.added.length + result.deleted.length > 0) {
      await this.host.changed(await this.host.engine(projectId), 'Brought in files from the run folder', [lineId]);
    }
    return result;
  }

  async stopProject(projectId: string): Promise<void> {
    await this.processes.stopOwner(`build:${projectId}`);
  }

  async shutdown(): Promise<void> {
    await this.processes.stopAll();
  }
}
