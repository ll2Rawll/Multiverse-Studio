/**
 * ffmpeg and ffprobe: located once, always run with structured arguments (never a shell),
 * with progress parsing, cancellation and a scrubbed environment.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubbedEnv } from '../agent/processes';

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
  version: string | null;
}

function onPath(name: string): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Order: MV_FFMPEG / MV_FFPROBE environment variables, then a copy shipped with the app
 * (resources/bin), then the system PATH.
 */
export function locateTools(resourcesBin?: string | null): { ffmpeg: string | null; ffprobe: string | null } {
  const exe = (n: string): string => (process.platform === 'win32' ? `${n}.exe` : n);
  const pick = (name: 'ffmpeg' | 'ffprobe'): string | null => {
    const env = process.env[name === 'ffmpeg' ? 'MV_FFMPEG' : 'MV_FFPROBE'];
    if (env && existsSync(env)) return env;
    if (resourcesBin) {
      const p = path.join(resourcesBin, exe(name));
      if (existsSync(p)) return p;
    }
    return onPath(name);
  };
  return { ffmpeg: pick('ffmpeg'), ffprobe: pick('ffprobe') };
}

export class MediaToolsMissing extends Error {
  constructor() {
    super('Video features need FFmpeg. Install FFmpeg (ffmpeg.org) so that ffmpeg and ffprobe are on your PATH, or set MV_FFMPEG and MV_FFPROBE to their full paths, then restart Multiverse Studio.');
  }
}

export interface RunOutput {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  cancelled: boolean;
}

/** Run a tool to completion. Arguments are passed as an array; nothing goes through a shell. */
export function runTool(program: string, args: string[], options: { cwd?: string; signal?: AbortSignal; onStdout?: (chunk: Buffer) => void; maxStdout?: number } = {}): Promise<RunOutput> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd: options.cwd, env: scrubbedEnv(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let cancelled = false;
    child.stdout.on('data', (d: Buffer) => {
      if (options.onStdout) options.onStdout(d);
      else if (outBytes < (options.maxStdout ?? 64 * 1024 * 1024)) {
        out.push(d);
        outBytes += d.length;
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    const abort = (): void => {
      cancelled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on('error', (e) => {
      err += `\n${e.message}`;
    });
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', abort);
      resolve({ code, stdout: Buffer.concat(out), stderr: err, cancelled });
    });
  });
}

/** The last meaningful lines of ffmpeg's log, for error messages. */
export function tail(stderr: string, lines = 6): string {
  return stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame=|size=|Press \[q\]|\s*$)/.test(l))
    .slice(-lines)
    .join('\n');
}

/** Parses `-progress pipe:1` key=value blocks; calls back with seconds encoded so far. */
export function progressParser(onSeconds: (seconds: number) => void): (chunk: Buffer) => void {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const m = /^out_time_(us|ms)=(\d+)$/.exec(line);
      if (m) onSeconds(Number(m[2]) / 1_000_000);
    }
  };
}

/**
 * Limits how many expensive FFmpeg jobs (thumbnails, strips, proxies, waveforms, silence scans,
 * audio preparation) run at once, so importing a folder of clips does not start dozens of encoders.
 * Exports have their own one-at-a-time queue. Only acquire at top-level entry points (never nested).
 */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(readonly max: number) {}
  get running(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiting.length;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export const heavyWork = new Limiter(Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2))));
