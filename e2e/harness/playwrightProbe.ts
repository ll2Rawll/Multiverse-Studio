/**
 * Browser probe for the harness and automated journeys: Playwright Chromium in a fresh context per
 * check (no shared cookies or storage). Development-only; the desktop app uses ElectronBrowserProbe.
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserProbe, BrowserProbeRequest, BrowserProbeResult, RecordRequest, StoryProbeRequest, StoryProbeResult } from '../../src/agent/browser';
import { runStorySteps } from '../../src/stories/runner';
import { RECORD_STEP_SCRIPT, STEP_SCRIPT } from '../../src/agent/remoteProbe';

type Browser = { newContext(o: unknown): Promise<Context>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Video = { path(): Promise<string> };
type Page = {
  on(event: string, cb: (arg: never) => void): void;
  goto(url: string, o: unknown): Promise<{ status(): number } | null>;
  title(): Promise<string>;
  url(): string;
  evaluate<T>(fn: string): Promise<T>;
  screenshot(o: unknown): Promise<Buffer>;
  video(): Video | null;
  waitForTimeout(ms: number): Promise<void>;
};

export class PlaywrightProbe implements BrowserProbe {
  readonly label = 'Playwright Chromium (harness)';
  private browser: Promise<Browser> | null = null;

  private launch(): Promise<Browser> {
    if (!this.browser) {
      const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_FROM ?? import.meta.url);
      const { chromium } = require('playwright') as { chromium: { launch(o: unknown): Promise<Browser> } };
      this.browser = chromium.launch({ args: ['--no-proxy-server'] });
    }
    return this.browser;
  }

  async check(request: BrowserProbeRequest): Promise<BrowserProbeResult> {
    const browser = await this.launch();
    const context = await browser.newContext({ viewport: { width: request.width, height: request.height } });
    const page = await context.newPage();
    const result: BrowserProbeResult = { status: null, title: '', finalUrl: request.url, console: [], errors: [], steps: [], screenshot: null };
    page.on('console', (m: never) => {
      const msg = m as { type(): string; text(): string };
      result.console.push({ level: msg.type() === 'warning' ? 'warning' : msg.type(), text: msg.text().slice(0, 2000) });
    });
    page.on('pageerror', (e: never) => result.errors.push(String((e as Error).message)));
    try {
      const response = await page.goto(request.url, { timeout: request.timeoutMs, waitUntil: 'load' });
      result.status = response?.status() ?? null;
      result.title = await page.title();
      result.finalUrl = page.url();
      for (const step of request.steps) {
        const r = await page.evaluate<{ ok: boolean; detail: string }>(`${STEP_SCRIPT}(${JSON.stringify(step)})`);
        result.steps.push({ action: step.action, ok: Boolean(r?.ok), detail: String(r?.detail ?? '') });
        if (!r?.ok) break;
      }
      if (request.screenshot) result.screenshot = (await page.screenshot({ type: 'png' })).toString('base64');
    } catch (error) {
      result.errors.push((error as Error).message);
    } finally {
      await context.close();
    }
    return result;
  }

  /** Run or record a story. A recording is kept only when every action and check passed. */
  async story(request: StoryProbeRequest, onStep?: (index: number, result: import('../../src/shared/stories').StoryStepResult) => void): Promise<StoryProbeResult> {
    const browser = await this.launch();
    const size = { width: request.width, height: request.height };
    const record = request.mode === 'record' && request.outputDir;
    const context = await browser.newContext({ viewport: size, ...(record ? { recordVideo: { dir: request.outputDir, size } } : {}) });
    const startedAt = Date.now();
    const page = await context.newPage();
    const result: StoryProbeResult = { steps: [], console: [], errors: [], screenshot: null, file: null, durationMs: 0 };
    page.on('console', (m: never) => {
      const msg = m as { type(): string; text(): string };
      if (msg.type() === 'error' || msg.type() === 'warning') result.console.push(`${msg.type()}: ${msg.text().slice(0, 500)}`);
    });
    page.on('pageerror', (e: never) => result.errors.push(String((e as Error).message)));
    let ok = false;
    try {
      await page.goto(request.startUrl, { timeout: request.timeoutMs, waitUntil: 'load' });
      const run = await runStorySteps(request, { goto: async (url) => void (await page.goto(url, { timeout: request.timeoutMs, waitUntil: 'load' })), evaluate: (script) => page.evaluate(script) }, startedAt, onStep);
      result.steps = run.steps;
      ok = run.ok;
      if (!record) result.screenshot = (await page.screenshot({ type: 'png' })).toString('base64');
    } catch (error) {
      result.errors.push((error as Error).message);
    } finally {
      result.durationMs = Date.now() - startedAt;
      await context.close();
    }
    if (record) {
      const video = page.video();
      const recorded = video ? await video.path() : null;
      if (ok && recorded) {
        const file = path.join(request.outputDir!, 'story.webm');
        if (recorded !== file) await fs.rename(recorded, file);
        result.file = file;
      } else if (recorded) await fs.rm(recorded, { force: true });
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.browser) await (await this.browser).close();
  }

  /** Record with Playwright's built-in video capture (WebM, VP8) at the requested size. */
  async record(request: RecordRequest): Promise<{ file: string }> {
    const browser = await this.launch();
    const size = { width: request.width, height: request.height };
    const context = await browser.newContext({ viewport: size, recordVideo: { dir: request.outputDir, size } });
    const page = await context.newPage();
    const started = Date.now();
    try {
      await page.goto(request.url, { timeout: 30000, waitUntil: 'load' });
      for (const step of request.steps) await page.evaluate(`${RECORD_STEP_SCRIPT}(${JSON.stringify(step)})`);
      const left = request.seconds * 1000 - (Date.now() - started);
      if (left > 0) await page.waitForTimeout(left);
    } finally {
      await context.close();
    }
    const video = page.video();
    if (!video) throw new Error('Playwright did not record a video.');
    const recorded = await video.path();
    const file = path.join(request.outputDir, 'recording.webm');
    if (recorded !== file) await fs.rename(recorded, file);
    return { file };
  }
}
