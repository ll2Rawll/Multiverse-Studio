/**
 * The agent's browser for page checks, screenshots and interaction tests in the desktop app.
 * Pages load in a hidden, sandboxed window with its own session partition and no preload, so they
 * cannot reach app APIs, the credential vault or the user's other sessions. Network access is
 * limited to this computer (dev servers) and the app's preview scheme.
 */
import { BrowserWindow, session, type Session } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { BrowserProbe, BrowserProbeRequest, BrowserProbeResult, RecordRequest, StoryProbeRequest, StoryProbeResult } from '../agent/browser';
import { runStorySteps } from '../stories/runner';
import { promises as fs } from 'node:fs';
import { RECORD_STEP_SCRIPT, STEP_SCRIPT } from '../agent/remoteProbe';
import { locateTools, MediaToolsMissing } from '../video/ffmpeg';
import { scrubbedEnv } from '../agent/processes';

export const probeContents = new Set<number>();

export class ElectronBrowserProbe implements BrowserProbe {
  readonly label = 'hidden browser window';
  private ses: Session | null = null;

  constructor(private readonly registerPreviewScheme: (ses: Session) => void) {}

  private session(): Session {
    if (this.ses) return this.ses;
    const ses = session.fromPartition('mv-agent-probe');
    this.registerPreviewScheme(ses);
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const host = new URL(details.url).hostname;
      callback({ cancel: !(host === '127.0.0.1' || host === 'localhost') });
    });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    this.ses = ses;
    return ses;
  }

  async check(request: BrowserProbeRequest): Promise<BrowserProbeResult> {
    const win = new BrowserWindow({
      show: false,
      width: request.width,
      height: request.height,
      webPreferences: { session: this.session(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    probeContents.add(win.webContents.id);
    const result: BrowserProbeResult = { status: null, title: '', finalUrl: request.url, console: [], errors: [], steps: [], screenshot: null };
    const wc = win.webContents;
    wc.on('console-message', (event: { level?: string; message?: string }) => {
      result.console.push({ level: String(event.level ?? 'info'), text: String(event.message ?? '').slice(0, 2000) });
    });
    wc.on('did-navigate', (_e: unknown, url: string, code: number) => {
      result.status = code;
      result.finalUrl = url;
    });
    wc.on('did-fail-load', (_e: unknown, code: number, description: string, url: string) => {
      result.errors.push(`Failed to load ${url}: ${description} (${code})`);
    });
    wc.on('render-process-gone', (_e: unknown, details: { reason: string }) => result.errors.push(`The page crashed (${details.reason})`));
    try {
      await Promise.race([win.loadURL(request.url), new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out loading ${request.url}`)), request.timeoutMs))]);
      result.title = wc.getTitle();
      for (const step of request.steps) {
        const r = (await wc.executeJavaScript(`${STEP_SCRIPT}(${JSON.stringify(step)})`, true)) as { ok: boolean; detail: string };
        result.steps.push({ action: step.action, ok: Boolean(r?.ok), detail: String(r?.detail ?? '') });
        if (!r?.ok) break;
      }
      if (request.screenshot) result.screenshot = (await wc.capturePage()).toPNG().toString('base64');
    } catch (error) {
      result.errors.push((error as Error).message);
    } finally {
      probeContents.delete(wc.id);
      win.destroy();
    }
    return result;
  }
  /**
   * Record a page: an offscreen window paints frames, a fixed clock writes the latest frame at
   * the target frame rate, and FFmpeg encodes them (structured arguments, no shell). The window
   * uses the same isolated session as browser checks.
   */
  async record(request: RecordRequest): Promise<{ file: string }> {
    const output = path.join(request.outputDir, 'recording.mp4');
    await this.recordWhile({ url: request.url, width: request.width, height: request.height, fps: request.fps, output }, async (wc) => {
      const started = Date.now();
      for (const step of request.steps) await wc.executeJavaScript(`${RECORD_STEP_SCRIPT}(${JSON.stringify(step)})`, true).catch(() => undefined);
      const left = request.seconds * 1000 - (Date.now() - started);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      return true;
    });
    return { file: output };
  }

  /** Run or record a story. A recording is kept only when every action and check passed. */
  async story(request: StoryProbeRequest, onStep?: (index: number, result: import('../shared/stories').StoryStepResult) => void): Promise<StoryProbeResult> {
    const result: StoryProbeResult = { steps: [], console: [], errors: [], screenshot: null, file: null, durationMs: 0 };
    // Every run starts from empty storage, so stories are repeatable (the probe session is reused).
    await this.session().clearStorageData();
    const startedAt = Date.now();
    const drive = async (wc: BrowserWindow['webContents'], started: number): Promise<boolean> => {
      wc.on('console-message', (event: { level?: string; message?: string }) => {
        const level = String(event.level ?? '');
        if (level === 'error' || level === 'warning' || level === '3' || level === '2') result.console.push(`${level}: ${String(event.message ?? '').slice(0, 500)}`);
      });
      const run = await runStorySteps(request, { goto: (url) => wc.loadURL(url), evaluate: (script) => wc.executeJavaScript(script, true) as Promise<{ ok: boolean; detail: string }> }, started, onStep);
      result.steps = run.steps;
      return run.ok;
    };
    try {
      if (request.mode === 'record' && request.outputDir) {
        const output = path.join(request.outputDir, 'story.mp4');
        const ok = await this.recordWhile({ url: request.startUrl, width: request.width, height: request.height, fps: request.fps, output }, drive);
        if (ok) result.file = output;
        else await fs.rm(output, { force: true });
      } else {
        const win = this.window(request.width, request.height, false);
        const wc = win.webContents;
        try {
          await Promise.race([win.loadURL(request.startUrl), new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out loading ${request.startUrl}`)), request.timeoutMs))]);
          await drive(wc, startedAt);
          result.screenshot = (await wc.capturePage()).toPNG().toString('base64');
        } finally {
          probeContents.delete(wc.id);
          win.destroy();
        }
      }
    } catch (error) {
      result.errors.push((error as Error).message);
    }
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  private window(width: number, height: number, offscreen: boolean): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      webPreferences: { session: this.session(), offscreen, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    probeContents.add(win.webContents.id);
    return win;
  }

  /** Paint frames from an offscreen window into FFmpeg while `run` drives the page. */
  private async recordWhile(o: { url: string; width: number; height: number; fps: number; output: string }, run: (wc: BrowserWindow['webContents'], startedAt: number) => Promise<boolean>): Promise<boolean> {
    const tools = locateTools(null);
    if (!tools.ffmpeg) throw new MediaToolsMissing();
    const width = Math.max(320, Math.min(3840, Math.round(o.width / 2) * 2));
    const height = Math.max(240, Math.min(2160, Math.round(o.height / 2) * 2));
    const fps = Math.max(10, Math.min(60, o.fps));
    const win = this.window(width, height, true);
    const wc = win.webContents;
    wc.setFrameRate(fps);
    let latest: Buffer | null = null;
    wc.on('paint', (_e: unknown, _dirty: unknown, image: PaintImage) => {
      const size = image.getSize();
      latest = (size.width === width && size.height === height ? image : image.resize({ width, height })).toBitmap();
    });
    const ffmpeg = spawn(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', o.output], { shell: false, env: scrubbedEnv(), stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    ffmpeg.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    const done = new Promise<number | null>((resolve) => ffmpeg.on('close', resolve));
    let timer: ReturnType<typeof setInterval> | null = null;
    let ok = false;
    try {
      await Promise.race([win.loadURL(o.url), new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out loading ${o.url}`)), 30000))]);
      const startedAt = Date.now();
      timer = setInterval(() => {
        if (latest && ffmpeg.stdin.writable) ffmpeg.stdin.write(latest);
      }, 1000 / fps);
      ok = await run(wc, startedAt);
    } finally {
      if (timer) clearInterval(timer);
      ffmpeg.stdin.end();
      probeContents.delete(wc.id);
      if (!win.isDestroyed()) win.destroy();
    }
    const code = await done;
    if (code !== 0) throw new Error(`FFmpeg could not encode the recording. ${stderr.split('\n').slice(-3).join(' ')}`);
    return ok;
  }
}

/** The parts of Electron's NativeImage the recorder uses. */
interface PaintImage {
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number }): { toBitmap(): Buffer };
  toBitmap(): Buffer;
}
