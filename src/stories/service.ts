/**
 * Running and recording stories.
 *
 * - A test run executes the actions and checks in an isolated browser and records the result with
 *   the universe, its head revision, a hash of the exact files used, and the dependencies then.
 * - A recording runs the same steps with presentation timing. It is kept only when every action and
 *   check passed — a failing flow never becomes a “success” clip — and enters the media library with
 *   provenance pointing at the run. Optionally it is put into a timeline with editable overlays.
 * - Status compares the last run with the files now: passing, failing, needs a new run (a dependency
 *   changed), or may need a new run (dependencies could not be worked out exactly).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserProbe } from '../agent/browser';
import type { ProjectEngine } from '../engine/project';
import { StudioError } from '../engine/errors';
import { writeFileAtomic } from '../engine/store/atomic';
import { STORY_DIR, isFunctional, storyPath, type Story, type StoryRunView, type StoryStatus, type StoryView } from '../shared/stories';
import { SHARED_LINE_ID, type StudioEvent } from '../shared/types';
import { TICKS_PER_SECOND } from '../shared/video';
import { normalizeProjectPath } from '../shared/paths';
import type { StudioService } from '../services/studio';
import { hashText, parseStory, storyDependencies, withFixtures } from './model';

const MAX_RUNS = 300;

export interface StoryHost {
  probe: BrowserProbe | null;
  cacheRoot: string;
  emit(event: StudioEvent): void;
}

interface RunOptions {
  mode: 'test' | 'recording';
  actor: import('../shared/activity').Actor;
  via?: string | null;
  taskId?: string | null;
  /** Recordings: draw the AI activity pointer in the video (off by default). */
  includeActivity?: boolean;
  /** Recordings: put the clip into this sequence (created when missing) at `start` ticks, or at the end. */
  insert?: { sequence: string; start?: number | null } | null;
}

export class StoryService {
  private chain: Promise<unknown> = Promise.resolve();
  /** Runs in progress in this process: not results yet, and not “interrupted”. */
  private readonly inProgress = new Set<string>();

  constructor(
    private readonly studio: StudioService,
    private readonly host: StoryHost,
  ) {}

  private runsFile(engine: ProjectEngine): string {
    return path.join(engine.dir, 'story-runs', 'runs.json');
  }

  async runs(projectId: string): Promise<StoryRunView[]> {
    const engine = await this.studio.engine(projectId);
    try {
      const list = JSON.parse(await fs.readFile(this.runsFile(engine), 'utf8')) as (StoryRunView & { running?: boolean })[];
      // A run that was in progress when the app closed did not finish: it never counts as passing.
      return list.filter((r) => !(r.running && this.inProgress.has(r.id))).map((r) => (r.running ? { ...r, running: undefined, ok: false, interrupted: true, error: r.error ?? 'Interrupted when the app closed. Run it again.' } : r));
    } catch {
      return [];
    }
  }

  private async saveRun(engine: ProjectEngine, run: StoryRunView & { running?: boolean }): Promise<void> {
    let raw: (StoryRunView & { running?: boolean })[] = [];
    try {
      raw = JSON.parse(await fs.readFile(this.runsFile(engine), 'utf8'));
    } catch {
      raw = [];
    }
    // Runs still in progress here are kept as they are; ones left running by a closed app become interrupted.
    const list = raw.filter((r) => r.id !== run.id).map((r) => (r.running && !this.inProgress.has(r.id) ? { ...r, running: undefined, ok: false, interrupted: true, error: r.error ?? 'Interrupted when the app closed. Run it again.' } : r));
    list.unshift(run);
    await fs.mkdir(path.dirname(this.runsFile(engine)), { recursive: true });
    await writeFileAtomic(this.runsFile(engine), JSON.stringify(list.slice(0, MAX_RUNS), null, 1));
  }

  async screenshotPath(projectId: string, runId: string): Promise<string | null> {
    const engine = await this.studio.engine(projectId);
    const p = path.join(engine.dir, 'story-runs', `${runId.replace(/[^A-Za-z0-9-]/g, '')}.png`);
    try {
      await fs.access(p);
      return p;
    } catch {
      return null;
    }
  }

  private async universe(engine: ProjectEngine, lineId: string, at?: Map<string, string>): Promise<{ tree: Map<string, string>; read: (p: string) => string | null; head: string | null; name: string }> {
    const tree = at ?? (await engine.effectiveTree(lineId));
    const texts = new Map<string, string>();
    for (const [p, h] of tree) if (/\.(html?|m?js|css|json)$/i.test(p) && !p.startsWith('node_modules/')) texts.set(p, (await engine.readBlob(h)).toString('utf8'));
    const view = await this.studio.view(engine);
    const line = [view.shared, ...view.alternatives].find((l) => l.id === lineId);
    if (!line) throw new StudioError('not-found', 'That version does not exist.');
    return { tree, read: (p) => texts.get(p) ?? null, head: line.head ?? null, name: line.name };
  }

  /** Stories of a universe with their status; `at` gives an earlier file set of that universe (a checkpoint). */
  async list(projectId: string, lineId: string, at?: Map<string, string>): Promise<StoryView[]> {
    const engine = await this.studio.engine(projectId);
    const u = await this.universe(engine, lineId, at);
    const runs = (await this.runs(projectId)).filter((r) => r.lineId === lineId);
    const out: StoryView[] = [];
    for (const [p, h] of u.tree) {
      if (!p.startsWith(`${STORY_DIR}/`) || !p.endsWith('.mvstory.json')) continue;
      let story: Story;
      try {
        story = parseStory((await engine.readBlob(h)).toString('utf8'), p);
      } catch {
        continue;
      }
      const mine = runs.filter((r) => r.storyId === story.id);
      const lastRun = mine[0] ?? null;
      const lastPassing = mine.find((r) => r.ok) ?? null;
      const { status, detail, changed } = this.status(story, lastRun, u.tree, hashText((await engine.readBlob(h)).toString('utf8')));
      out.push({ ...story, path: p, status, statusDetail: detail, lastRun, lastPassing, changedDeps: changed });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private status(story: Story, last: StoryRunView | null, tree: Map<string, string>, storyHash: string): { status: StoryStatus; detail: string; changed: string[] } {
    if (!last) return { status: 'never-run', detail: 'Run it to check the flow works.', changed: [] };
    const changed = Object.entries(last.deps)
      .filter(([p, h]) => tree.get(p) !== h)
      .map(([p]) => p);
    if (last.storyHash !== storyHash) changed.unshift(storyPath(story.id));
    if (!last.ok) return { status: 'failing', detail: last.error ?? 'A step failed.', changed };
    if (changed.length) return { status: last.depsCertain ? 'needs-check' : 'may-need-check', detail: `${changed.length} file${changed.length === 1 ? '' : 's'} changed since the last run: ${changed.slice(0, 4).join(', ')}${changed.length > 4 ? '…' : ''}`, changed };
    if (!last.depsCertain) {
      // Uncertain analysis still tracks every source file, so unchanged means unchanged.
      return { status: 'passing', detail: 'Passed on these exact files.', changed };
    }
    return { status: 'passing', detail: 'Passed on these exact files.', changed };
  }

  /** Run (test) or record a story. Runs are serialised: one browser at a time. */
  run(projectId: string, lineId: string, storyId: string, options: RunOptions): Promise<StoryRunView> {
    const next = this.chain.then(() => this.runNow(projectId, lineId, storyId, options));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async runNow(projectId: string, lineId: string, storyIdArg: string, options: RunOptions): Promise<StoryRunView> {
    const probe = this.host.probe;
    if (!probe?.story) throw new StudioError('unavailable', 'Stories need a browser: the desktop app’s hidden window, or Playwright in the harness.');
    const engine = await this.studio.engine(projectId);
    const u = await this.universe(engine, lineId);
    const file = storyPath(storyIdArg);
    const text = u.tree.has(file) ? (await engine.readBlob(u.tree.get(file)!)).toString('utf8') : null;
    if (text === null) throw new StudioError('not-found', `There is no story “${storyIdArg}” in ${u.name}.`);
    const story = parseStory(text, file);
    const steps = withFixtures(story.steps, story.fixtures);
    if (!steps.some(isFunctional)) throw new StudioError('invalid', 'This story has no actions or checks yet.');
    const { deps, certain } = storyDependencies(story, u.tree, u.read);
    const sourceHash = hashText([...u.tree].map(([p, h]) => `${p}:${h}`).join('\n'));
    const startUrl = await this.url(projectId, lineId, story.page);
    const rootUrl = story.page === 'dev-server' ? startUrl : startUrl.replace(/[^/]*$/, '');
    const run: StoryRunView & { running?: boolean } = {
      id: `run-${randomUUID().slice(0, 12)}`,
      storyId: story.id,
      storyName: story.name,
      lineId,
      lineName: u.name,
      revision: u.head,
      sourceHash,
      storyHash: hashText(text),
      mode: options.mode,
      at: new Date().toISOString(),
      ok: false,
      durationMs: 0,
      steps: [],
      deps: Object.fromEntries(deps.map((p) => [p, u.tree.get(p)!])),
      depsCertain: certain,
      assetId: null,
      error: null,
      console: [],
      running: true,
    };
    this.inProgress.add(run.id);
    await this.saveRun(engine, run);
    this.host.emit({ type: 'story-run', projectId, run });
    const outDir = options.mode === 'recording' ? path.join(this.host.cacheRoot, 'stories', run.id) : null;
    if (outDir) await fs.mkdir(outDir, { recursive: true });
    const verb = options.mode === 'recording' ? 'Recording' : 'Testing';
    const liveBase = { projectId, lineId, actor: options.actor, via: options.via ?? null, taskId: options.taskId ?? null, operationId: run.id, operation: options.mode === 'recording' ? 'story.record' : 'story.run', resourceId: story.id } as const;
    const phase = options.mode === 'recording' ? ('recording' as const) : ('testing' as const);
    void this.studio.live.emit({ ...liveBase, kind: 'operation.started', phase, description: `${verb} ${story.name}`, progress: 0 });
    // Each action or check as it finishes in the isolated browser: the element it acted on, measured progress.
    const onStep = (index: number, r: import('../shared/stories').StoryStepResult): void => {
      const step = steps[index];
      if (!step || !isFunctional(step)) return;
      const locator = 'target' in step ? (step.target ?? null) : null;
      const what = step.kind === 'verify' ? 'Checking' : step.kind === 'open' ? 'Opening' : step.kind === 'fill' ? 'Typing into' : step.kind === 'press' ? 'Pressing a key in' : step.kind === 'wait' ? 'Waiting for' : 'Clicking';
      const label = locator ? ('name' in locator ? locator.name : 'text' in locator ? locator.text : locator.value) : step.kind === 'open' ? step.path : 'the page';
      void this.studio.live.emit({
        ...liveBase,
        kind: r.ok === false ? 'operation.failed' : 'operation.progress',
        phase: r.ok === false ? 'failed' : phase,
        description: r.ok === false ? `Step ${index + 1} failed` : `${verb} ${story.name} · ${what} ${String(label).slice(0, 40)}`,
        target: { kind: 'story-step', storyId: story.id, stepId: step.id, page: story.page, locator, assertion: step.kind === 'verify', ok: r.ok },
        progress: (index + 1) / steps.length,
        action: step.kind,
        pointer: step.kind === 'click' || step.kind === 'fill' || step.kind === 'press',
        detail: r.ok === false ? r.detail : null,
      });
    };
    try {
      const result = await probe.story({ startUrl, rootUrl, width: story.viewport.width, height: story.viewport.height, steps, mode: options.mode === 'recording' ? 'record' : 'test', timing: story.timing, outputDir: outDir, fps: 30, timeoutMs: 30_000, aiActivity: options.mode === 'recording' && Boolean(options.includeActivity) }, onStep);
      run.steps = result.steps;
      run.durationMs = result.durationMs;
      run.console = [...result.errors.map((e) => `error: ${e}`), ...result.console].slice(0, 50);
      const failed = result.steps.find((s) => s.ok === false);
      run.ok = !failed && result.errors.length === 0 && result.steps.filter((s) => s.ok === true).length === steps.filter(isFunctional).length;
      if (!run.ok) run.error = failed ? `Step failed: ${failed.detail}` : (result.errors[0] ?? 'The run did not complete.');
      if (result.screenshot) {
        await fs.mkdir(path.join(engine.dir, 'story-runs'), { recursive: true });
        await fs.writeFile(path.join(engine.dir, 'story-runs', `${run.id}.png`), Buffer.from(result.screenshot, 'base64'));
      }
      if (options.mode === 'recording') {
        if (run.ok && result.file) {
          const store = await this.studio.video.store(projectId);
          const rec = await store.importFile(
            result.file,
            `${story.id}-${u.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}${path.extname(result.file)}`,
            { source: 'recording', provider: null, connectionName: null, model: null, prompt: null, settings: { story: story.id, run: run.id, universe: u.name, revision: u.head }, createdAt: new Date().toISOString(), requestId: null, jobId: run.id },
            ['story', story.name],
          );
          run.assetId = rec.id;
        } else if (run.ok) {
          run.ok = false;
          run.error = 'The browser did not produce a recording.';
        }
      }
    } catch (error) {
      run.ok = false;
      run.error = (error as Error).message;
    } finally {
      delete run.running;
      this.inProgress.delete(run.id);
      if (outDir) await fs.rm(outDir, { recursive: true, force: true });
    }
    await this.saveRun(engine, run);
    this.host.emit({ type: 'story-run', projectId, run });
    void this.studio.live.emit({ ...liveBase, kind: run.ok ? 'operation.completed' : 'operation.failed', phase: run.ok ? 'completed' : 'failed', description: run.ok ? `${options.mode === 'recording' ? 'Recorded' : 'Passed'}: ${story.name}` : `${story.name} failed`, progress: run.ok ? 1 : null, target: run.assetId ? { kind: 'asset', assetId: run.assetId } : null, detail: run.error });
    if (run.ok && run.assetId && options.insert) await this.insert(projectId, lineId, story, run, options.insert, options.actor);
    return run;
  }

  /** Put a recorded run into a sequence with its chapters, captions and narration as editable titles. */
  async insert(projectId: string, lineId: string, story: Story, run: StoryRunView, where: { sequence: string; start?: number | null }, actor: import('../shared/activity').Actor): Promise<void> {
    if (!run.assetId) throw new StudioError('invalid', 'Only a successful recording can be added to a timeline.');
    const engine = await this.studio.engine(projectId);
    const store = await this.studio.video.store(projectId);
    const asset = await store.get(run.assetId);
    const seconds = asset.probe.durationSeconds ?? run.durationMs / 1000;
    const seqs = await this.studio.video.sequences(projectId, lineId).catch(() => []);
    let existing = seqs.find((s) => s.summary.id === where.sequence);
    if (!existing) {
      const w = Math.round(story.viewport.width / 2) * 2;
      const h = Math.round(story.viewport.height / 2) * 2;
      await this.studio.commands.run(engine, lineId, 'video.createSequence', { sequence: where.sequence, name: story.name, settings: { width: w, height: h, fps: { num: 30, den: 1 }, sampleRate: 48000, background: '#000000' } }, { actor });
      existing = (await this.studio.video.sequences(projectId, lineId)).find((s) => s.summary.id === where.sequence);
    }
    const start = where.start ?? Math.round((existing?.summary.durationSeconds ?? 0) * TICKS_PER_SECOND);
    const byId = new Map(story.steps.map((s) => [s.id, s]));
    type Marker = { kind: 'chapter' | 'annotate' | 'narrate'; atMs: number; text: string; subtitle?: string; seconds?: number };
    const markers = run.steps.flatMap((r): Marker[] => {
      const s = byId.get(r.id);
      if (!s) return [];
      if (s.kind === 'chapter') return [{ kind: 'chapter' as const, atMs: r.atMs, text: s.title, ...(s.subtitle ? { subtitle: s.subtitle } : {}) }];
      if (s.kind === 'annotate') return [{ kind: 'annotate' as const, atMs: r.atMs, text: s.text, ...(s.seconds ? { seconds: s.seconds } : {}) }];
      if (s.kind === 'narrate') return [{ kind: 'narrate' as const, atMs: r.atMs, text: s.text }];
      return [];
    });
    await this.studio.commands.run(engine, lineId, 'stories.addToSequence', { sequence: where.sequence, assetId: run.assetId, assetSeconds: seconds, start, markers }, { actor });
  }

  private async url(projectId: string, lineId: string, page: string): Promise<string> {
    if (page === 'dev-server') {
      const state = await this.studio.build?.state(projectId, lineId);
      const server = state?.processes.find((p) => p.kind === 'dev-server' && p.status === 'ready' && p.url);
      if (!server?.url) throw new StudioError('no-dev-server', 'Start the dev server for this version in Build first, then run the story.');
      return server.url;
    }
    const handle = await this.studio.call('preview.open', { projectId, ref: { kind: 'line', lineId } });
    return new URL(normalizeProjectPath(page.replace(/^\/+/, '') || 'index.html'), handle.url.replace(/[^/]*$/, '')).toString();
  }
}

export { SHARED_LINE_ID };
