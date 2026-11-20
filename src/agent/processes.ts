/**
 * Managed child processes for the coding agent and the Build workspace.
 *
 * - Programs are started with argument arrays and `shell: false`; nothing is interpolated into a
 *   shell command line.
 * - The environment is rebuilt from an allowlist; variables that look like credentials and the
 *   app's own variables are never passed to generated programs.
 * - Every process belongs to an owner (a task or the user); stopping the owner kills each process
 *   tree (process groups on macOS/Linux, `taskkill /T` on Windows).
 * - Output is kept in a bounded buffer so long-running dev servers cannot exhaust memory.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_OUTPUT = 256 * 1024;
const PASS_ENV = /^(PATH|Path|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|SystemRoot|SYSTEMROOT|windir|ComSpec|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|CommonProgramFiles|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LC_ALL|LC_CTYPE|TERM|SHELL|USER|USERNAME|LOGNAME|XDG_RUNTIME_DIR|NVM_DIR|NVM_BIN|VOLTA_HOME|FNM_DIR|npm_config_cache|NPM_CONFIG_CACHE|npm_config_registry|NODE_EXTRA_CA_CERTS|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|https_proxy|http_proxy|no_proxy|SSL_CERT_FILE)$/;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|AUTH)/i;

export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || !PASS_ENV.test(k) || SECRET_NAME.test(k)) continue;
    // Proxy URLs may embed credentials; drop them if they do.
    if (/proxy/i.test(k) && /:\/\/[^/]*@/.test(v)) continue;
    env[k] = v;
  }
  return { ...env, BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', ...extra };
}

export interface RunOptions {
  cwd: string;
  owner: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ManagedProcess {
  id: string;
  owner: string;
  label: string;
  program: string;
  args: string[];
  cwd: string;
  pid: number | null;
  startedAt: number;
  exitCode: number | null;
  exited: boolean;
  url: string | null;
  port: number | null;
}

class OutputBuffer {
  private text = '';
  truncated = false;
  total = 0;
  append(chunk: string): void {
    this.total += chunk.length;
    this.text += chunk;
    if (this.text.length > MAX_OUTPUT) {
      this.text = this.text.slice(this.text.length - MAX_OUTPUT);
      this.truncated = true;
    }
  }
  value(): string {
    return this.text;
  }
}

interface Entry {
  info: ManagedProcess;
  child: ChildProcess;
  buffer: OutputBuffer;
  done: Promise<void>;
}

/** Resolve npm-style tools so they can run without a shell on Windows (.cmd files need one). */
export function resolveProgram(program: string, env: Record<string, string>): { command: string; prefix: string[] } {
  if (process.platform !== 'win32') return { command: program, prefix: [] };
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = pathVar.split(';').filter(Boolean);
  const find = (name: string): string | null => {
    for (const d of dirs) {
      const p = path.join(d, name);
      if (existsSync(p)) return p;
    }
    return null;
  };
  if (program === 'node') return { command: find('node.exe') ?? 'node.exe', prefix: [] };
  const cli: Record<string, string> = { npm: 'node_modules/npm/bin/npm-cli.js', npx: 'node_modules/npm/bin/npx-cli.js', pnpm: 'node_modules/pnpm/bin/pnpm.cjs', yarn: 'node_modules/yarn/bin/yarn.js' };
  if (cli[program]) {
    const node = find('node.exe');
    if (node) {
      const script = path.join(path.dirname(node), cli[program]!);
      if (existsSync(script)) return { command: node, prefix: [script] };
    }
    throw new Error(`Could not find ${program}. Install Node.js (which includes npm) from nodejs.org, then restart Multiverse Studio.`);
  }
  return { command: program.endsWith('.exe') ? program : `${program}.exe`, prefix: [] };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export class ProcessManager {
  private readonly entries = new Map<string, Entry>();

  list(owner?: string): ManagedProcess[] {
    return [...this.entries.values()].filter((e) => !owner || e.info.owner === owner).map((e) => ({ ...e.info }));
  }

  private launch(program: string, args: string[], options: RunOptions & { label: string }): Entry {
    const env = scrubbedEnv(process.env, options.env);
    const { command, prefix } = resolveProgram(program, env);
    const child = spawn(command, [...prefix, ...args], {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const buffer = new OutputBuffer();
    const info: ManagedProcess = { id: `proc-${randomUUID().slice(0, 8)}`, owner: options.owner, label: options.label, program, args, cwd: options.cwd, pid: child.pid ?? null, startedAt: Date.now(), exitCode: null, exited: false, url: null, port: null };
    const onData = (d: Buffer): void => {
      const s = d.toString('utf8');
      buffer.append(s);
      options.onOutput?.(s);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const done = new Promise<void>((resolve) => {
      child.on('error', (error) => {
        buffer.append(`\n${(error as NodeJS.ErrnoException).code === 'ENOENT' ? `${program} was not found on this computer.` : error.message}\n`);
        info.exited = true;
        resolve();
      });
      child.on('close', (code) => {
        info.exitCode = code;
        info.exited = true;
        resolve();
      });
    });
    const entry: Entry = { info, child, buffer, done };
    this.entries.set(info.id, entry);
    return entry;
  }

  /**
   * Start a process the user asked for (a terminal command or a dev server) and keep its output
   * until `forget` is called. Returns immediately; `done` resolves when it exits.
   */
  spawnTracked(program: string, args: string[], options: RunOptions & { label: string }): { process: ManagedProcess; done: Promise<ManagedProcess> } {
    const entry = this.launch(program, args, options);
    return { process: { ...entry.info }, done: entry.done.then(() => ({ ...entry.info })) };
  }

  info(id: string): ManagedProcess | null {
    const e = this.entries.get(id);
    return e ? { ...e.info } : null;
  }

  setUrl(id: string, url: string | null, port: number | null): void {
    const e = this.entries.get(id);
    if (e) Object.assign(e.info, { url, port });
  }

  /** Drop a finished process and its output. */
  forget(id: string): void {
    const e = this.entries.get(id);
    if (e?.info.exited) this.entries.delete(id);
  }

  /** Run to completion with a timeout and cancellation. */
  async run(program: string, args: string[], options: RunOptions): Promise<RunResult> {
    const started = Date.now();
    const entry = this.launch(program, args, { ...options, label: [program, ...args].join(' ') });
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.kill(entry);
    }, options.timeoutMs ?? 10 * 60_000);
    const onAbort = (): void => {
      cancelled = true;
      void this.kill(entry);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    await entry.done;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    this.entries.delete(entry.info.id);
    return {
      exitCode: entry.info.exitCode,
      signal: entry.child.signalCode ?? null,
      output: entry.buffer.value(),
      truncated: entry.buffer.truncated,
      durationMs: Date.now() - started,
      timedOut,
      cancelled,
    };
  }

  /** Start a long-running process (a dev server). Resolves once it is listening or has failed. */
  async start(program: string, args: string[], options: RunOptions & { label: string; port: number; readyTimeoutMs?: number }): Promise<{ process: ManagedProcess; ready: boolean; output: string }> {
    const entry = this.launch(program, args, options);
    entry.info.port = options.port;
    const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
    while (Date.now() < deadline && !entry.info.exited && !options.signal?.aborted) {
      if (await isListening(options.port)) {
        entry.info.url = `http://127.0.0.1:${options.port}/`;
        return { process: { ...entry.info }, ready: true, output: entry.buffer.value() };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!entry.info.exited) await this.kill(entry);
    await entry.done;
    return { process: { ...entry.info }, ready: false, output: entry.buffer.value() };
  }

  output(id: string): { output: string; exited: boolean; exitCode: number | null; truncated: boolean } | null {
    const e = this.entries.get(id);
    return e ? { output: e.buffer.value(), exited: e.info.exited, exitCode: e.info.exitCode, truncated: e.buffer.truncated } : null;
  }

  /** Stop a process tree. With keep, the finished entry (and its output) stays until `forget`. */
  async stop(id: string, options: { keep?: boolean } = {}): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e) return false;
    await this.kill(e);
    await e.done;
    if (!options.keep) this.entries.delete(id);
    return true;
  }

  async stopOwner(owner: string): Promise<number> {
    const ids = [...this.entries.values()].filter((e) => e.info.owner === owner).map((e) => e.info.id);
    await Promise.all(ids.map((id) => this.stop(id)));
    return ids.length;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  private async kill(entry: Entry): Promise<void> {
    const pid = entry.child.pid;
    if (!pid || entry.info.exited) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        k.on('close', () => resolve());
        k.on('error', () => resolve());
      });
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        entry.child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    const exited = await Promise.race([entry.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    if (!exited) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        entry.child.kill('SIGKILL');
      }
    }
  }
}

export function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}
