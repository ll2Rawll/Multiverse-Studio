/**
 * A public HTTPS address for ChatGPT and claude.ai, which only reach servers on the internet.
 * Uses Cloudflare's `cloudflared` quick tunnel when it is installed (no account; the address
 * changes each time it starts), or an address the user set up themselves (a named Cloudflare
 * tunnel, ngrok, Tailscale Funnel) that forwards to the local port.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TunnelState } from '../shared/connector';

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export async function findCloudflared(configured: string | null): Promise<string | null> {
  const names = process.platform === 'win32' ? ['cloudflared.exe'] : ['cloudflared'];
  const candidates = [configured, ...(process.env.PATH ?? '').split(path.delimiter).flatMap((d) => names.map((n) => (d ? path.join(d, n) : '')))].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      const st = await fs.stat(c);
      if (st.isFile()) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

export class QuickTunnel {
  state: TunnelState = 'off';
  url: string | null = null;
  detail = '';
  private child: ChildProcess | null = null;

  constructor(private readonly onChange: () => void) {}

  /** Starts `cloudflared tunnel --url http://127.0.0.1:<port>` and waits for its public address. */
  async start(binary: string, port: number, timeoutMs = 30_000): Promise<string> {
    await this.stop();
    this.state = 'starting';
    this.detail = 'Starting a Cloudflare quick tunnel…';
    this.onChange();
    // Structured arguments; no shell.
    const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    return new Promise<string>((resolve, reject) => {
      let log = '';
      const timer = setTimeout(() => finish(new Error('cloudflared did not report an address within 30 seconds.')), timeoutMs);
      const finish = (error: Error | null, url?: string) => {
        clearTimeout(timer);
        if (error) {
          this.state = 'failed';
          this.detail = error.message;
          this.url = null;
          child.kill();
          this.onChange();
          reject(error);
        } else {
          this.state = 'on';
          this.url = url!;
          this.detail = 'Quick tunnel running. Its address changes each time it starts; add the connector again after a restart, or use your own tunnel for a fixed address.';
          this.onChange();
          resolve(url!);
        }
      };
      const read = (chunk: Buffer) => {
        log = (log + chunk.toString('utf8')).slice(-8000);
        const m = QUICK_URL.exec(log);
        if (m && this.state === 'starting') finish(null, m[0]);
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.on('error', (e) => this.state === 'starting' && finish(new Error(`cloudflared could not start: ${e.message}`)));
      child.on('exit', (code) => {
        if (this.child !== child) return;
        this.child = null;
        if (this.state === 'starting') finish(new Error(`cloudflared exited (code ${code}). ${log.split('\n').filter((l) => /ERR|error/i.test(l)).slice(-2).join(' ')}`.trim()));
        else if (this.state === 'on') {
          this.state = 'failed';
          this.url = null;
          this.detail = `The tunnel stopped (code ${code}). Start it again.`;
          this.onChange();
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise<void>((r) => {
        const t = setTimeout(r, 2000);
        child.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
    this.state = 'off';
    this.url = null;
    this.detail = '';
    this.onChange();
  }
}
