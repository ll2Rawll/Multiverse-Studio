/**
 * The browser-independent part of running a story: step order, timing, and what counts as passed.
 * Each browser (Electron's hidden window, Playwright in the harness) supplies a small driver.
 */
import type { StoryProbeRequest } from '../agent/browser';
import { STEP_GROUP, type StoryStep, type StoryStepResult } from '../shared/stories';
import { STORY_STEP_SCRIPT } from './script';

export interface StoryDriver {
  goto(url: string): Promise<void>;
  evaluate(script: string): Promise<{ ok: boolean; detail: string } | null>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const readingMs = (text: string): number => Math.max(1200, Math.min(8000, (text.split(/\s+/).length / 2.6) * 1000));

/** Runs the steps; stops at the first failed action or check. Returns per-step results. */
export async function runStorySteps(request: StoryProbeRequest, driver: StoryDriver, startedAt: number, onStep?: (index: number, result: StoryStepResult) => void): Promise<{ steps: StoryStepResult[]; ok: boolean }> {
  const record = request.mode === 'record';
  const out: StoryStepResult[] = [];
  let failed = false;
  const at = (): number => Date.now() - startedAt;
  for (const step of request.steps) {
    if (failed) {
      out.push({ id: step.id, kind: step.kind, ok: STEP_GROUP[step.kind] === 'action' || STEP_GROUP[step.kind] === 'assertion' ? false : null, detail: 'not run (an earlier step failed)', atMs: at() });
      continue;
    }
    const group = STEP_GROUP[step.kind];
    if (group !== 'action' && group !== 'assertion') {
      out.push({ id: step.id, kind: step.kind, ok: null, detail: record ? 'shown in the recording' : 'presentation only (not part of the test)', atMs: at() });
      if (record) await sleep(presentationMs(step));
      continue;
    }
    const started = at();
    let result: { ok: boolean; detail: string } | null;
    try {
      if (step.kind === 'open') {
        await driver.goto(new URL(step.path.replace(/^\/+/, ''), request.rootUrl).toString());
        result = { ok: true, detail: `opened ${step.path}` };
      } else result = await driver.evaluate(`${STORY_STEP_SCRIPT}(${JSON.stringify(step)}, ${JSON.stringify({ mode: request.mode, typingMsPerChar: request.timing.typingMsPerChar, aiPointer: request.mode === 'record' && Boolean(request.aiActivity) })})`);
    } catch (error) {
      result = { ok: false, detail: (error as Error).message };
    }
    const ok = Boolean(result?.ok);
    out.push({ id: step.id, kind: step.kind, ok, detail: String(result?.detail ?? 'no answer from the page'), atMs: started });
    onStep?.(out.length - 1, out[out.length - 1]!);
    if (!ok) failed = true;
    else if (record) await sleep(request.timing.stepDelayMs);
  }
  if (record && !failed) await sleep(request.timing.endHoldMs);
  return { steps: out, ok: !failed };
}

function presentationMs(step: StoryStep): number {
  switch (step.kind) {
    case 'hold':
      return Math.min(30_000, Math.max(0, step.ms));
    case 'chapter':
      return 1600;
    case 'annotate':
      return Math.round((step.seconds ?? readingMs(step.text) / 1000) * 1000);
    case 'narrate':
      return readingMs(step.text);
    default:
      return 0;
  }
}
