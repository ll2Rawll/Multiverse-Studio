/**
 * The project-level commands, and the IPC routing that sends buttons, menus, shortcuts and drag and
 * drop through them. Each wraps the existing implementation (`raw` handlers), so the user and the
 * director share one code path, one validation and one activity log.
 */
import { z } from 'zod';
import { channelSchemas, type ChannelInput, type ChannelName, type ChannelOutput } from '../shared/ipc';
import { SHARED_LINE_ID, type ProjectView } from '../shared/types';
import { OperationRegistry, OperationService, type ActivityRecord, type AiPolicy, type OperationDefinition, type OperationOutcome } from '../commands/operations';
import { StudioError } from '../engine/errors';
import type { StudioService } from './studio';
import { addTestRun, codeHash, readTestRuns } from '../outcomes/validation';
import { releaseDestinations, universeOutcomes } from '../outcomes/service';
import type { TestRunView } from '../shared/outcomes';

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };
type Raw = Handlers;

const allow: AiPolicy = { allow: true };
const ask = (approval: string): AiPolicy => ({ allow: false, approval });

/** Op args are the channel input without projectId. */
function argsOf<C extends ChannelName>(channel: C) {
  return (channelSchemas[channel] as unknown as z.AnyZodObject).omit({ projectId: true });
}

export function createOperations(studio: StudioService, raw: Raw): { service: OperationService; handlers: Handlers; routes: Partial<Record<ChannelName, string>> } {
  const registry = new OperationRegistry();
  const call = <C extends ChannelName>(c: C, input: ChannelInput<C>): Promise<ChannelOutput<C>> => {
    const h = raw[c] as ((i: ChannelInput<C>) => Promise<ChannelOutput<C>>) | undefined;
    if (!h) throw new StudioError('unsupported', `${c} is not available here.`);
    return h(input);
  };
  const lineName = (p: ProjectView, id: string): string => (id === SHARED_LINE_ID ? p.shared.name : (p.alternatives.find((a) => a.id === id)?.name ?? id));

  const def = <A>(d: OperationDefinition<A>): void => registry.register(d);

  def({
    name: 'project.createUniverse',
    domain: 'project',
    description: 'Create a universe (alternative) from a version or a checkpoint. Following universes receive saved Shared changes.',
    schema: argsOf('lines.create') as unknown as z.ZodType<Omit<ChannelInput<'lines.create'>, 'projectId'>>,
    effect: 'change',
    label: (a) => `Create universe “${a.name}”`,
    target: (a) => ({ universeId: a.from.kind === 'line' ? a.from.lineId : null, resourceId: null }),
    ai: () => allow,
    run: async (ctx, a) => {
      const r = await call('lines.create', { ...a, projectId: ctx.projectId });
      return { result: r, summary: `Created universe “${r.line.name}”`, universeId: r.line.id, resourceId: r.line.id, undo: { kind: 'inverse', name: 'project.deleteUniverse', args: { lineId: r.line.id }, label: `Delete “${r.line.name}”` } };
    },
  });
  def({
    name: 'project.duplicateUniverse',
    domain: 'project',
    description: 'Duplicate a universe with its files and settings.',
    schema: argsOf('lines.duplicate') as unknown as z.ZodType<{ lineId: string }>,
    effect: 'change',
    label: () => 'Duplicate universe',
    target: (a) => ({ universeId: a.lineId, resourceId: null }),
    ai: () => allow,
    run: async (ctx, a) => {
      const r = await call('lines.duplicate', { ...a, projectId: ctx.projectId });
      return { result: r, summary: `Duplicated as “${r.line.name}”`, universeId: r.line.id, resourceId: r.line.id, undo: { kind: 'inverse', name: 'project.deleteUniverse', args: { lineId: r.line.id }, label: `Delete “${r.line.name}”` } };
    },
  });
  def({
    name: 'project.deleteUniverse',
    domain: 'project',
    description: 'Delete a universe. A safety checkpoint is created first, so it can be restored from History.',
    schema: argsOf('lines.delete') as unknown as z.ZodType<{ lineId: string }>,
    effect: 'change',
    label: () => 'Delete universe',
    target: (a) => ({ universeId: a.lineId, resourceId: a.lineId }),
    ai: (a, t) => (a.lineId === t.universeId ? allow : ask('Delete a universe the task did not create')),
    run: async (ctx, a) => {
      const before = await studio.engine(ctx.projectId).then((e) => studio.view(e));
      const name = lineName(before, a.lineId);
      const r = await call('lines.delete', { ...a, projectId: ctx.projectId });
      const engine = await studio.engine(ctx.projectId);
      const safety = [...engine.data.checkpoints].reverse().find((c) => c.auto && c.name === `Before deleting ${name}`) ?? null;
      return { result: r, summary: `Deleted universe “${name}”`, undo: safety ? { kind: 'checkpoint', checkpointId: safety.id, label: `Restore from “${safety.name}”` } : { kind: 'none', label: 'Use History to restore' } };
    },
  });
  def({
    name: 'project.createCheckpoint',
    domain: 'project',
    description: 'Create a named checkpoint of every universe.',
    schema: argsOf('history.createCheckpoint') as unknown as z.ZodType<{ name: string; description: string }>,
    effect: 'change',
    label: (a) => `Create checkpoint “${a.name}”`,
    target: () => ({ universeId: null, resourceId: null }),
    ai: () => allow,
    run: async (ctx, a) => {
      const r = await call('history.createCheckpoint', { ...a, projectId: ctx.projectId });
      const engine = await studio.engine(ctx.projectId);
      const cp = engine.data.checkpoints[engine.data.checkpoints.length - 1];
      return { result: r, summary: `Checkpoint “${a.name}”`, resourceId: cp?.id ?? null, undo: { kind: 'none', label: 'Checkpoints are kept; rename or ignore it in History' } };
    },
  });
  def({
    name: 'universe.saveShared',
    domain: 'universe',
    description: 'Save the Shared version’s draft and propagate it to every following universe.',
    schema: argsOf('shared.save') as unknown as z.ZodType<{ message?: string }>,
    effect: 'change',
    label: () => 'Save the Shared version',
    target: () => ({ universeId: SHARED_LINE_ID, resourceId: null }),
    ai: () => ask('Save the Shared version (sends the change to every following universe)'),
    run: async (ctx, a) => {
      const r = await call('shared.save', { ...a, projectId: ctx.projectId });
      const n = r.report?.lines.filter((l) => l.outcome === 'applied').length ?? 0;
      return { result: r, summary: r.saved ? `Saved Shared; applied to ${n} universe${n === 1 ? '' : 's'}` : 'Nothing to save', undo: { kind: 'none', label: 'Restore an earlier checkpoint in History' } };
    },
  });
  def({
    name: 'universe.compare',
    domain: 'universe',
    description: 'Compare two universes, checkpoints or the Shared version: changed files with counts.',
    schema: argsOf('compare.run') as unknown as z.ZodType<Omit<ChannelInput<'compare.run'>, 'projectId'>>,
    effect: 'read',
    label: () => 'Compare',
    target: (a) => ({ universeId: a.right.kind === 'line' ? a.right.lineId : null, resourceId: null }),
    ai: () => allow,
    run: async (ctx, a) => {
      const r = await call('compare.run', { ...a, projectId: ctx.projectId });
      return { result: { counts: r.counts, files: r.files.filter((f) => f.status !== 'unchanged').map((f) => ({ path: f.path, status: f.status })) }, summary: `${r.counts.added} added, ${r.counts.modified} modified, ${r.counts.deleted} deleted` };
    },
  });
  def({
    name: 'universe.combine',
    domain: 'universe',
    description: 'Apply a combine plan (files, hunks, sections, timelines) into an existing or a new universe. A checkpoint is created first and the result can be undone.',
    schema: argsOf('combine.apply') as unknown as z.ZodType<Omit<ChannelInput<'combine.apply'>, 'projectId'>>,
    effect: 'change',
    label: () => 'Combine',
    target: (a) => ({ universeId: a.plan.destination.kind === 'existing' ? a.plan.destination.lineId : null, resourceId: null }),
    ai: (a, t) => (a.plan.destination.kind === 'new' || a.plan.destination.lineId === t.universeId ? allow : ask('Combine into a universe other than the task’s own')),
    run: async (ctx, a) => {
      const r = await call('combine.apply', { ...a, projectId: ctx.projectId });
      return { result: r, summary: `Combined into ${lineName(r.project, r.lineId)}`, universeId: r.lineId, undo: { kind: 'operation', operationId: r.operationId, label: 'Undo the combine' } };
    },
  });
  def({
    name: 'render.start',
    domain: 'render',
    description: 'Render (export) a sequence to MP4 or WebM. Without a destination the file goes to the app’s cache and is listed under Exports.',
    schema: argsOf('video.export.start') as unknown as z.ZodType<Omit<ChannelInput<'video.export.start'>, 'projectId'>>,
    effect: 'job',
    label: () => 'Render',
    target: (a) => ({ universeId: a.lineId, resourceId: a.sequenceId }),
    ai: (a) => (a.destination ? ask(`Write a video file outside the project: ${a.destination}`) : allow),
    run: async (ctx, a) => {
      const r = await call('video.export.start', { ...a, projectId: ctx.projectId });
      return { result: r, summary: r ? `Rendering ${r.sequenceName} (${a.settings.format.toUpperCase()})` : 'Render cancelled', resourceId: r?.id ?? a.sequenceId, undo: { kind: 'none', label: 'Exports never change the project' } };
    },
  });
  def({
    name: 'assets.import',
    domain: 'assets',
    description: 'Copy media files from this computer into the project library.',
    schema: argsOf('media.import') as unknown as z.ZodType<{ paths?: string[] }>,
    effect: 'change',
    label: (a) => `Import ${a.paths?.length ?? 0} file${a.paths?.length === 1 ? '' : 's'}`,
    target: () => ({ universeId: null, resourceId: null }),
    ai: (a) => ask(`Read files outside the project: ${(a.paths ?? []).slice(0, 5).join(', ')}${(a.paths?.length ?? 0) > 5 ? '…' : ''}`),
    run: async (ctx, a) => {
      const r = await call('media.import', { ...a, projectId: ctx.projectId });
      return { result: r, summary: r ? `Imported ${r.imported.length} file${r.imported.length === 1 ? '' : 's'}${r.failed.length ? `, ${r.failed.length} failed` : ''}` : 'Nothing imported', resourceId: r?.imported[0]?.id ?? null, undo: { kind: 'none', label: 'Library media is kept; remove it from Assets' } };
    },
  });
  def({
    name: 'code.runTests',
    domain: 'code',
    description: 'Run the universe’s test script (package.json "test") and report the exit code and output.',
    schema: z.object({ lineId: z.string().min(1).max(128), timeoutSeconds: z.number().int().min(5).max(1800).optional() }),
    effect: 'job',
    label: () => 'Run tests',
    target: (a) => ({ universeId: a.lineId, resourceId: null }),
    ai: (_a, t) => (t.permissions.runBuildAndTests ? allow : ask('Run the project’s tests')),
    run: async (ctx, a) => {
      if (!studio.build) throw new StudioError('unsupported', 'Running tests needs the Build service, which is not available here.');
      // Record which files the run used, so the result is shown as current only while they are unchanged.
      const engine = await studio.engine(ctx.projectId);
      const line = engine.line(a.lineId);
      const sourceHash = codeHash(await engine.effectiveTree(a.lineId));
      const record = async (passed: boolean, exitCode: number | null, output: string) => {
        const run: TestRunView = { id: `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, lineId: a.lineId, lineName: line.kind === 'shared' ? 'Shared' : line.name, revision: line.head, draft: Boolean(line.draftTree), sourceHash, at: new Date().toISOString(), passed, exitCode, output: output.slice(-6000), actor: ctx.actor };
        await addTestRun(engine.dir, run);
        return run;
      };
      const started = await studio.build.runScript(ctx.projectId, a.lineId, 'test');
      const deadline = Date.now() + (a.timeoutSeconds ?? 300) * 1000;
      for (;;) {
        const o = studio.build.output(ctx.projectId, started.id);
        if (o.process.status === 'exited' || o.process.status === 'failed') {
          const tail = o.output.length > 6000 ? `…\n${o.output.slice(-6000)}` : o.output;
          const run = await record(o.process.exitCode === 0, o.process.exitCode, tail);
          return { result: { exitCode: o.process.exitCode, passed: o.process.exitCode === 0, output: tail, run }, summary: o.process.exitCode === 0 ? 'Tests passed' : `Tests failed (exit ${o.process.exitCode})` };
        }
        if (Date.now() > deadline) {
          await studio.build.stop(ctx.projectId, started.id);
          const run = await record(false, null, `${o.output.slice(-5900)}\n(stopped after ${a.timeoutSeconds ?? 300} s)`);
          return { result: { exitCode: null, passed: false, output: o.output.slice(-6000), run }, summary: 'Tests timed out and were stopped' };
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    },
  });

  def({
    name: 'universe.compareOutcomes',
    domain: 'universe',
    description: 'Compare universes by what they produce: pages, living objects, stories (status of their runs), timelines, renders, deploys and test runs. Measured results say which files they ran on; there are no scores.',
    schema: z.object({ lineIds: z.array(z.string().min(1).max(128)).min(1).max(4) }),
    effect: 'read',
    label: () => 'Compare outcomes',
    target: () => ({ universeId: null, resourceId: null }),
    ai: () => allow,
    run: async (ctx, a) => {
      const o = await universeOutcomes(studio, ctx.projectId, a.lineIds.map((lineId) => ({ kind: 'line' as const, lineId })));
      return { result: o, summary: `Compared ${o.sides.map((s) => s.label).join(', ')}` };
    },
  });
  def({
    name: 'release.status',
    domain: 'release',
    description: 'Where each release destination stands (each website target and each exported video): the version and exact revision it has, and whether it still matches. Destinations are separate; none is updated together with another.',
    schema: z.object({}),
    effect: 'read',
    label: () => 'Release status',
    target: () => ({ universeId: null, resourceId: null }),
    ai: () => allow,
    run: async (ctx) => {
      const list = await releaseDestinations(studio, ctx.projectId);
      return { result: list, summary: `${list.length} destination${list.length === 1 ? '' : 's'}` };
    },
  });

  const storyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
  const seqIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
  def({
    name: 'story.run',
    domain: 'story',
    description: 'Run a story as a browser test in a universe: every action and check, with the result linked to the exact files used.',
    schema: z.object({ lineId: z.string().min(1).max(128), storyId: storyIdSchema }),
    effect: 'job',
    label: () => 'Run story',
    target: (a) => ({ universeId: a.lineId, resourceId: a.storyId }),
    ai: (_a, t) => (t.permissions.operatePreview ? allow : ask('Run a story in the browser')),
    run: async (ctx, a) => {
      const r = await studio.stories.run(ctx.projectId, a.lineId, a.storyId, { mode: 'test', actor: ctx.actor, via: ctx.via ?? null, taskId: ctx.taskId });
      const failed = r.steps.find((s) => s.ok === false);
      return { result: r, summary: r.ok ? `Story “${r.storyName}” passed (${r.steps.filter((s) => s.ok).length} steps)` : `Story “${r.storyName}” failed: ${failed?.detail ?? r.error}`, resourceId: r.id };
    },
  });
  def({
    name: 'story.record',
    domain: 'story',
    description: 'Record a story as video. The clip is kept only if every action and check passes; optionally it is added to a sequence with its chapters, captions and narration as editable titles.',
    schema: z.object({ lineId: z.string().min(1).max(128), storyId: storyIdSchema, insert: z.object({ sequence: seqIdSchema, start: z.number().int().min(0).nullable().optional() }).nullable().optional(), includeActivity: z.boolean().optional() }),
    effect: 'job',
    label: () => 'Record story',
    target: (a) => ({ universeId: a.lineId, resourceId: a.storyId }),
    ai: (a, t) => (!t.permissions.operatePreview ? ask('Record a story in the browser') : a.insert && a.lineId !== t.universeId ? ask('Add a recording to another universe’s timeline') : allow),
    run: async (ctx, a) => {
      const r = await studio.stories.run(ctx.projectId, a.lineId, a.storyId, { mode: 'recording', actor: ctx.actor, via: ctx.via ?? null, taskId: ctx.taskId, insert: a.insert ?? null, includeActivity: a.includeActivity === true });
      return { result: r, summary: r.ok ? `Recorded “${r.storyName}”${a.insert ? ` into ${a.insert.sequence}` : ''}` : `Not recorded: ${r.error}`, resourceId: r.assetId ?? r.id, undo: { kind: 'none', label: 'Recordings are kept in Assets; undo the timeline edit in Video' } };
    },
  });
  def({
    name: 'story.addToTimeline',
    domain: 'story',
    description: 'Put a successful recording into a sequence (created when missing) with its chapters, captions and narration as editable titles.',
    schema: z.object({ lineId: z.string().min(1).max(128), runId: z.string().min(1).max(64), sequence: seqIdSchema, start: z.number().int().min(0).nullable().optional() }),
    effect: 'change',
    label: () => 'Add story recording to the timeline',
    target: (a) => ({ universeId: a.lineId, resourceId: a.sequence }),
    ai: (a, t) => (a.lineId === t.universeId ? allow : ask('Change another universe’s timeline')),
    run: async (ctx, a) => {
      const run = (await studio.stories.runs(ctx.projectId)).find((r) => r.id === a.runId);
      if (!run) throw new StudioError('not-found', 'That run no longer exists.');
      const story = (await studio.stories.list(ctx.projectId, a.lineId)).find((s) => s.id === run.storyId);
      if (!story) throw new StudioError('not-found', `The story “${run.storyName}” is not in this universe.`);
      await studio.stories.insert(ctx.projectId, a.lineId, story, run, { sequence: a.sequence, start: a.start ?? null }, ctx.actor);
      return { result: true, summary: `Added “${run.storyName}” to ${a.sequence}`, undo: { kind: 'command', lineId: a.lineId, scope: `video:${a.sequence}`, label: 'Undo in Video' } };
    },
  });

  const service = new OperationService(registry, {
    projectDir: async (projectId) => (await studio.engine(projectId)).dir,
    universeHead: async (projectId, universeId) => {
      const engine = await studio.engine(projectId);
      const view = await studio.view(engine);
      return [view.shared, ...view.alternatives].find((l) => l.id === universeId)?.head ?? null;
    },
    onLogged: (record: ActivityRecord) => studio.emitEvent({ type: 'activity', projectId: record.projectId, record }),
    onLive: (projectId, info) => void studio.live.operation(projectId, info),
  });

  // Buttons, menus, shortcuts and drag and drop reach these channels; route them through the commands.
  const routes: Partial<Record<ChannelName, string>> = {
    'lines.create': 'project.createUniverse',
    'lines.duplicate': 'project.duplicateUniverse',
    'lines.delete': 'project.deleteUniverse',
    'history.createCheckpoint': 'project.createCheckpoint',
    'shared.save': 'universe.saveShared',
    'combine.apply': 'universe.combine',
    'video.export.start': 'render.start',
    'media.import': 'assets.import',
  };
  const handlers: Handlers = {};
  for (const [channel, op] of Object.entries(routes) as [ChannelName, string][]) {
    (handlers as Record<string, (i: { projectId: string }) => Promise<unknown>>)[channel] = async (input) => {
      const { projectId, ...args } = input;
      return (await service.run(projectId, op, args, { actor: 'user' })).result;
    };
  }
  handlers['stories.run'] = async ({ projectId, lineId, storyId }) => (await service.run(projectId, 'story.run', { lineId, storyId }, { actor: 'user' })).result as never;
  handlers['stories.record'] = async ({ projectId, lineId, storyId, insert, includeActivity }) => (await service.run(projectId, 'story.record', { lineId, storyId, insert: insert ?? null, includeActivity: includeActivity === true }, { actor: 'user' })).result as never;
  handlers['stories.insert'] = async ({ projectId, lineId, runId, sequence, start }) => {
    await service.run(projectId, 'story.addToTimeline', { lineId, runId, sequence, start: start ?? null }, { actor: 'user' });
    return true;
  };
  handlers['tests.run'] = async ({ projectId, lineId }) => ((await service.run(projectId, 'code.runTests', { lineId }, { actor: 'user' })).result as { run: TestRunView }).run;
  handlers['tests.list'] = async ({ projectId }) => readTestRuns((await studio.engine(projectId)).dir);
  handlers['outcomes.compare'] = async ({ projectId, refs }) => universeOutcomes(studio, projectId, refs);
  handlers['releases.list'] = async ({ projectId }) => releaseDestinations(studio, projectId);
  handlers['ops.activity'] = async ({ projectId, limit }) => service.activity(projectId, limit ?? 200);
  handlers['ops.undo'] = async ({ projectId, activityId }) => {
    const record = (await service.activity(projectId, 4000)).find((r) => r.id === activityId);
    if (!record?.undo) throw new StudioError('not-found', 'That action has no undo.');
    const u = record.undo;
    if (u.kind === 'operation') await call('operations.undo', { projectId, operationId: u.operationId });
    else if (u.kind === 'inverse') await service.run(projectId, u.name, u.args, { actor: 'user' });
    else if (u.kind === 'command') await call('commands.step', { projectId, lineId: u.lineId, scope: u.scope, direction: 'undo' });
    else throw new StudioError('invalid', u.label);
    return true;
  };
  return { service, handlers, routes };
}

export type { OperationOutcome };

/** Read-only story queries. */
export function createStoryReadHandlers(studio: StudioService): Handlers {
  return {
    'stories.list': async ({ projectId, lineId }) => studio.stories.list(projectId, lineId),
    'stories.runs': async ({ projectId }) => studio.stories.runs(projectId),
    'stories.screenshot': async ({ projectId, runId }) => {
      const p = await studio.stories.screenshotPath(projectId, runId);
      if (!p) return null;
      const { promises: fs } = await import('node:fs');
      return `data:image/png;base64,${(await fs.readFile(p)).toString('base64')}`;
    },
  };
}
