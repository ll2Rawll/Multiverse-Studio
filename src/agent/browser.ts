/**
 * Browser checks for the coding agent: load a page in an isolated browser, collect console output
 * and errors, optionally run simple interaction steps, and capture a screenshot.
 *
 * Implementations:
 * - Electron: a hidden, sandboxed BrowserWindow in its own session partition with no preload, so
 *   pages cannot reach app APIs or credentials (`src/main/browserProbe.ts`).
 * - Browser harness and tests: Playwright Chromium (`e2e/harness/playwrightProbe.ts`).
 */
export interface BrowserStep {
  action: 'click' | 'fill' | 'press' | 'wait-for' | 'expect-text';
  selector?: string;
  text?: string;
  key?: string;
}

export interface BrowserProbeRequest {
  url: string;
  width: number;
  height: number;
  screenshot: boolean;
  steps: BrowserStep[];
  timeoutMs: number;
}

export interface BrowserProbeResult {
  status: number | null;
  title: string;
  finalUrl: string;
  console: { level: string; text: string }[];
  errors: string[];
  steps: { action: string; ok: boolean; detail: string }[];
  /** PNG bytes, base64. */
  screenshot: string | null;
}

/** Record a page as video (Website → Video). Steps run in order inside the recording. */
export interface RecordRequest {
  url: string;
  width: number;
  height: number;
  seconds: number;
  steps: import('../shared/media').RecordStep[];
  /** Folder (inside the app cache) to write the file into. */
  outputDir: string;
  fps: number;
}

/** Run (test) or record an executable story. Steps arrive with fixtures already filled in. */
export interface StoryProbeRequest {
  /** URL of the start page. */
  startUrl: string;
  /** Base URL that `open` step paths resolve against. */
  rootUrl: string;
  width: number;
  height: number;
  steps: import('../shared/stories').StoryStep[];
  mode: 'test' | 'record';
  timing: import('../shared/stories').Story['timing'];
  /** Recording only: folder (inside the app cache) for the file. */
  outputDir: string | null;
  fps: number;
  timeoutMs: number;
  /** Recording only: draw the AI activity pointer (“Include AI activity”) instead of the neutral demo pointer. */
  aiActivity?: boolean;
}

export interface StoryProbeResult {
  steps: import('../shared/stories').StoryStepResult[];
  console: string[];
  errors: string[];
  /** Final state, PNG base64 (test runs). */
  screenshot: string | null;
  /** The recording (only when every action and check passed). */
  file: string | null;
  durationMs: number;
}

export interface BrowserProbe {
  readonly label: string;
  check(request: BrowserProbeRequest): Promise<BrowserProbeResult>;
  /** Present when this browser can record video. */
  record?(request: RecordRequest): Promise<{ file: string }>;
  /** Present when this browser can run executable stories. */
  /** `onStep` reports each action or check as it finishes (for the live activity layer). */
  story?(request: StoryProbeRequest, onStep?: (index: number, result: import('../shared/stories').StoryStepResult) => void): Promise<StoryProbeResult>;
}
