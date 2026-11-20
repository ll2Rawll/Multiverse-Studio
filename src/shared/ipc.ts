/**
 * The typed IPC contract between the renderer and the privileged process.
 *
 * Every channel has a zod schema for its input. The privileged side validates input
 * before doing anything with it; the renderer gets compile-time types for both sides.
 * Results travel in an envelope so structured errors survive the IPC boundary.
 */
import { z } from 'zod';
import type {
  AppInfo,
  AppSettings,
  CheckpointDetails,
  CombineCandidates,
  CombineProposal,
  CombineResult,
  ComparisonView,
  ConflictSetView,
  ConflictChunkView,
  Diagnostic,
  DiffHunkView,
  ExportReport,
  FileContent,
  FileEntry,
  HistoryEntry,
  ImportReport,
  LineView,
  PreviewHandle,
  ProjectView,
  TemplateInfo,
  RecentProject,
  RestorePreview,
  SaveSharedResult,
  SearchMatch,
  SectionAnalysis,
  SectionInfo,
  WriteResult,
  PropagationReport,
} from './types';
import { ALTERNATIVE_COLORS } from './types';
import type { CommandRunResult, DesignPageView } from './design';
import type { BuildCollectView, BuildOutputView, BuildProcessView, BuildStateView } from './build';
import type { ExportJobView, MediaAssetView, Sequence, SequenceSummary, VideoToolsView, WaveformView } from './video';
import { CACHE_CATEGORIES, type StorageView } from './storage';
import { PUBLISH_PROVIDERS, type DeployJobView, type PublishPlanView, type PublishTargetView } from './publish';
import { TIMELINE_OPS, type SequenceDiffView, type TimelineConflictItemView, type AssetLinkView, type AssetUsageView, type BrandPlanView, type BrandSettingsView, type MediaJobPlan, type MediaJobView, type TimelineProposalView, type TranscriptView } from './media';
import { CAPABILITIES, JOBS, MEDIA_ADAPTERS, PROTOCOLS, PROVIDER_KINDS, TASK_MODES, type AiStateView, type CapabilityRecord, type ConnectionTestResult, type ProjectAiSettings, type TaskSummary, type TaskView } from './ai';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, 'Invalid identifier');
const projectPath = z.string().min(1).max(400);
const name = z.string().trim().min(1).max(80);
const color = z.enum(ALTERNATIVE_COLORS);

export const contentRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), lineId: id }),
  z.object({ kind: z.literal('checkpoint'), checkpointId: id, lineId: id }),
  z.object({ kind: z.literal('revision'), revisionId: id }),
  z.object({ kind: z.literal('proposal'), proposalId: id }),
]);

const chunkResolution = z.object({
  choice: z.enum(['ours', 'theirs', 'ours-then-theirs', 'theirs-then-ours', 'custom']),
  text: z.string().max(5_000_000).optional(),
});

const fileAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keep') }),
  z.object({ kind: z.literal('take'), source: contentRefSchema }),
  z.object({
    kind: z.literal('merge'),
    source: contentRefSchema,
    resolutions: z.record(z.string(), chunkResolution).optional(),
    timelineChoices: z.record(z.string().max(300), z.enum(['ours', 'theirs', 'both'])).optional(),
  }),
  z.object({ kind: z.literal('hunks'), source: contentRefSchema, hunks: z.array(z.number().int().min(0)).max(10_000) }),
  z.object({ kind: z.literal('timeline'), source: contentRefSchema, tracks: z.array(id).max(200), clips: z.array(id).max(5000) }),
]);

const sectionTarget = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('replace'), key: z.string().min(1).max(200) }),
  z.object({
    mode: z.literal('insert'),
    anchorKey: z.string().min(1).max(200),
    position: z.enum(['before', 'after']),
  }),
  z.object({ mode: z.literal('append') }),
]);

const sectionStep = z.object({
  source: contentRefSchema,
  sourcePath: projectPath,
  sectionKey: z.string().min(1).max(200),
  destPath: projectPath,
  target: sectionTarget,
  cssRuleIds: z.array(z.string().max(200)).max(2000),
  includeVariables: z.boolean(),
  assets: z.array(z.object({ path: projectPath, action: z.enum(['copy', 'skip']) })).max(2000),
  destCssPath: projectPath.nullable(),
});

const combineDestination = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), lineId: id }),
  z.object({
    kind: z.literal('new'),
    base: contentRefSchema,
    name,
    color,
    description: z.string().max(500),
    following: z.boolean(),
  }),
]);

export const combinePlanSchema = z.object({
  destination: combineDestination,
  files: z.record(projectPath, fileAction),
  sections: z.array(sectionStep).max(50),
  edits: z.record(projectPath, z.string().max(20_000_000)),
  description: z.string().max(500),
});

const fileResolution = z.discriminatedUnion('type', [
  z.object({ path: projectPath, type: z.literal('chunks'), resolutions: z.record(z.string(), chunkResolution) }),
  z.object({ path: projectPath, type: z.literal('manual'), text: z.string().max(20_000_000) }),
  z.object({ path: projectPath, type: z.literal('choice'), choice: z.enum(['ours', 'theirs']) }),
  z.object({ path: projectPath, type: z.literal('timeline'), choices: z.record(z.string().max(300), z.enum(['ours', 'theirs', 'both'])) }),
]);

const settingsPatch = z
  .object({
    appearance: z.enum(['system', 'dystopia', 'dark', 'light']),
    transparency: z.enum(['system', 'reduced', 'full']),
    motion: z.enum(['system', 'reduced', 'full']),
    livePreviewLimit: z.number().int().min(1).max(12),
    sidebarWidth: z.number().min(180).max(420),
    inspectorWidth: z.number().min(240).max(480),
    editorSplit: z.number().min(0.2).max(0.8),
    taskMode: z.enum(['ask', 'plan', 'build']),
    taskPermissions: z.object({ editAlternative: z.boolean(), runBuildAndTests: z.boolean(), installDependencies: z.boolean(), operatePreview: z.boolean() }),
    activityVisuals: z.enum(['off', 'minimal', 'detailed']),
    followAi: z.boolean(),
    activityLabels: z.boolean(),
  })
  .partial();

const recordStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wait'), ms: z.number().int().min(0).max(60_000) }),
  z.object({ kind: z.literal('scroll'), y: z.number().min(-1_000_000).max(1_000_000), ms: z.number().int().min(0).max(20_000) }),
  z.object({ kind: z.literal('click'), selector: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('type'), selector: z.string().min(1).max(300), text: z.string().max(2000) }),
  z.object({ kind: z.literal('hover'), selector: z.string().min(1).max(300) }),
]);
const mediaJobInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), request: z.object({ prompt: z.string().trim().min(1).max(8000), size: z.string().regex(/^(auto|\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2})$/), quality: z.enum(['auto', 'low', 'medium', 'high']), count: z.number().int().min(1).max(4) }) }),
  z.object({ kind: z.literal('video'), request: z.object({ prompt: z.string().trim().min(1).max(4000), aspectRatio: z.enum(['16:9', '9:16']), resolution: z.enum(['360p', '720p', '1080p']), imageAssetId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).nullable() }) }),
  z.object({ kind: z.literal('speech'), request: z.object({ text: z.string().trim().min(1).max(5000), voice: z.string().max(60), style: z.string().max(500) }) }),
  z.object({ kind: z.literal('transcription'), request: z.object({ assetId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), language: z.string().regex(/^[a-z]{2,3}$/).nullable() }) }),
  z.object({
    kind: z.literal('recording'),
    request: z.object({
      lineId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
      page: z.union([z.literal('dev-server'), z.string().min(1).max(400).regex(/\.html?$/i)]),
      width: z.number().int().min(320).max(3840),
      height: z.number().int().min(240).max(2160),
      seconds: z.number().min(1).max(120),
      steps: z.array(recordStep).max(50),
    }),
  }),
]);
const brandInput = z.object({
  colors: z.array(z.object({ id: z.string(), name: z.string(), value: z.string() })).max(64),
  fonts: z.array(z.object({ id: z.string(), name: z.string(), family: z.string(), assetId: z.string().nullable() })).max(32),
  textStyles: z.array(z.object({ id: z.string(), name: z.string(), fontId: z.string().nullable(), size: z.number(), weight: z.number(), lineHeight: z.number(), colorId: z.string().nullable() })).max(64),
  logoAssetId: z.string().nullable(),
});

const empty = z.object({}).strict();
const projectOnly = z.object({ projectId: id });

export const channelSchemas = {
  'app.info': empty,
  'settings.get': empty,
  'settings.set': z.object({ patch: settingsPatch }),

  'projects.recent': empty,
  'projects.removeRecent': projectOnly,
  'projects.import': z.object({ folderPath: z.string().max(2000).optional() }),
  'projects.createSample': empty,
  'templates.list': empty,
  'projects.createFromTemplate': z.object({ templateId: z.string().regex(/^[a-z0-9-]{1,40}$/), name: name.optional() }),
  'projects.open': projectOnly,
  'projects.view': projectOnly,
  'projects.close': projectOnly,
  'projects.reveal': projectOnly,
  'shell.openUrl': z.object({ url: z.string().url().max(2000) }),
  'projects.rename': z.object({ projectId: id, name }),

  'lines.create': z.object({
    projectId: id,
    from: contentRefSchema,
    name,
    color,
    description: z.string().max(500),
    following: z.boolean(),
  }),
  'lines.update': z.object({
    projectId: id,
    lineId: id,
    name: name.optional(),
    color: color.optional(),
    description: z.string().max(500).optional(),
  }),
  'lines.duplicate': z.object({ projectId: id, lineId: id }),
  'lines.delete': z.object({ projectId: id, lineId: id }),
  'lines.setFollowing': z.object({ projectId: id, lineId: id, following: z.boolean() }),
  'lines.commitDraft': z.object({ projectId: id, lineId: id, message: z.string().max(300).optional() }),
  'shared.save': z.object({ projectId: id, message: z.string().max(300).optional() }),
  'shared.discardDraft': projectOnly,

  'files.list': z.object({ projectId: id, ref: contentRefSchema }),
  'files.read': z.object({ projectId: id, ref: contentRefSchema, path: projectPath }),
  'files.write': z.object({ projectId: id, lineId: id, path: projectPath, text: z.string().max(20_000_000), baseHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }),
  'files.create': z.object({ projectId: id, lineId: id, path: projectPath, text: z.string().max(20_000_000) }),
  'files.delete': z.object({ projectId: id, lineId: id, path: projectPath }),
  'files.reset': z.object({
    projectId: id,
    lineId: id,
    path: projectPath,
    to: z.enum(['shared', 'saved']),
  }),
  'files.search': z.object({
    projectId: id,
    ref: contentRefSchema,
    query: z.string().min(1).max(500),
    caseSensitive: z.boolean(),
  }),
  'files.diagnostics': z.object({ projectId: id, ref: contentRefSchema, path: projectPath }),

  'conflicts.get': z.object({ projectId: id, lineId: id }),
  'conflicts.saveResolution': z.object({ projectId: id, lineId: id, resolution: fileResolution }),
  'conflicts.complete': z.object({ projectId: id, lineId: id }),

  'compare.run': z.object({ projectId: id, left: contentRefSchema, right: contentRefSchema }),

  'combine.candidates': z.object({ projectId: id, source: contentRefSchema, destination: contentRefSchema }),
  'combine.hunks': z.object({ projectId: id, source: contentRefSchema, destination: contentRefSchema, path: projectPath }),
  'combine.sections': z.object({ projectId: id, ref: contentRefSchema, path: projectPath }),
  'combine.analyzeSection': z.object({
    projectId: id,
    source: contentRefSchema,
    sourcePath: projectPath,
    sectionKey: z.string().min(1).max(200),
    destination: contentRefSchema,
    destPath: projectPath,
    target: sectionTarget.optional(),
  }),
  'combine.preview': z.object({ projectId: id, plan: combinePlanSchema }),
  'combine.mergeChunks': z.object({ projectId: id, plan: combinePlanSchema, path: projectPath, source: contentRefSchema }),
  'combine.apply': z.object({ projectId: id, plan: combinePlanSchema }),
  'combine.timeline': z.object({ projectId: id, plan: combinePlanSchema, path: projectPath, source: contentRefSchema }),
  'compare.sequence': z.object({ projectId: id, left: contentRefSchema, right: contentRefSchema, path: projectPath }),
  'operations.undo': z.object({ projectId: id, operationId: id }),

  'history.list': z.object({ projectId: id, lineId: id.optional(), limit: z.number().int().min(1).max(2000).optional() }),
  'history.createCheckpoint': z.object({ projectId: id, name, description: z.string().max(500) }),
  'history.checkpoint': z.object({ projectId: id, checkpointId: id }),
  'history.restorePreview': z.object({ projectId: id, checkpointId: id, lineIds: z.array(id).min(1).max(100) }),
  'history.restore': z.object({ projectId: id, checkpointId: id, lineIds: z.array(id).min(1).max(100) }),
  'history.renameCheckpoint': z.object({ projectId: id, checkpointId: id, name, description: z.string().max(500) }),

  'export.run': z.object({
    projectId: id,
    ref: contentRefSchema,
    format: z.enum(['folder', 'zip']),
    suggestedName: z.string().max(160).optional(),
    /** Only honoured by test hosts; the desktop app always asks with a native dialog. */
    destination: z.string().max(2000).optional(),
    overwrite: z.boolean().optional(),
  }),
  'app.setChrome': z.object({ theme: z.enum(['dark', 'light']), background: z.string().regex(/^#[0-9a-fA-F]{6}$/), symbols: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),

  'preview.open': z.object({ projectId: id, ref: contentRefSchema }),
  'preview.release': z.object({ token: z.string().min(1).max(100) }),

  // Unified command layer and Design workspace.
  'commands.run': z.object({ projectId: id, lineId: id, name: z.string().regex(/^[a-z]+\.[A-Za-z]+$/), args: z.unknown(), expected: z.record(projectPath, z.string().regex(/^[0-9a-f]{64}$/).nullable()).optional() }),
  'commands.step': z.object({ projectId: id, lineId: id, scope: z.string().min(1).max(500), direction: z.enum(['undo', 'redo']) }),
  'build.state': z.object({ projectId: id, lineId: id }),
  'commands.state': z.object({ projectId: id, lineId: id, scope: z.string().min(1).max(500) }),
  'video.tools': empty,
  'media.list': z.object({ projectId: id, lineId: id.optional() }),
  'media.import': z.object({ projectId: id, paths: z.array(z.string().min(1).max(4000)).max(200).optional() }),
  'media.relink': z.object({ projectId: id, assetId: id, path: z.string().min(1).max(4000).optional() }),
  'media.waveform': z.object({ projectId: id, assetId: id }),
  'sequences.list': z.object({ projectId: id, lineId: id }),
  'sequences.get': z.object({ projectId: id, lineId: id, sequenceId: id }),
  'video.export.start': z.object({
    projectId: id,
    lineId: id,
    sequenceId: id,
    settings: z.object({
      preset: z.enum(['landscape', 'portrait', 'square', 'sequence']),
      resolution: z.union([z.literal(0), z.literal(2160), z.literal(1080), z.literal(720), z.literal(480)]),
      fps: z.union([z.literal('sequence'), z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
      quality: z.enum(['high', 'standard', 'small']),
      format: z.enum(['mp4', 'webm']),
      range: z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }).nullable(),
    }),
    /** Desktop: chosen in a save dialog by the main process. null = the user cancelled. */
    destination: z.string().min(1).max(4000).nullable().optional(),
  }),
  'video.export.list': z.object({ projectId: id }),
  'video.export.cancel': z.object({ projectId: id, jobId: id }),
  'video.export.reveal': z.object({ projectId: id, jobId: id }),

  // AI media, transcripts, AI timeline edits, brand and shared media.
  'media.jobs.list': projectOnly,
  'media.jobs.plan': z.object({ projectId: id, job: mediaJobInput }),
  'media.jobs.start': z.object({ projectId: id, job: mediaJobInput }),
  'media.jobs.cancel': z.object({ projectId: id, jobId: id }),
  'media.jobs.retry': z.object({ projectId: id, jobId: id, confirmUncertain: z.boolean() }),
  'media.transcript': z.object({ projectId: id, assetId: id }),
  'media.setTags': z.object({ projectId: id, assetId: id, tags: z.array(z.string().max(40)).max(30) }),
  'media.usage': z.object({ projectId: id, assetId: id }),
  'assets.links': projectOnly,
  'assets.place': z.object({ projectId: id, lineId: id, assetId: id, path: projectPath.optional(), replace: z.boolean().optional() }),
  'assets.updateLinks': z.object({ projectId: id, items: z.array(z.object({ lineId: id, path: projectPath })).min(1).max(500) }),
  'video.ai.analyze': z.object({ projectId: id, lineId: id, sequenceId: id, op: z.enum(TIMELINE_OPS), options: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).optional() }),
  'video.ai.plan': z.object({ projectId: id, lineId: id, sequenceId: id, instruction: z.string().trim().min(1).max(4000) }),
  'video.ai.cancel': projectOnly,
  'video.ai.discard': z.object({ projectId: id, proposalId: id }),
  'video.ai.apply': z.object({ projectId: id, proposalId: id, asAlternative: z.object({ name }).optional() }),
  'stories.list': z.object({ projectId: id, lineId: id }),
  'stories.runs': projectOnly,
  'stories.run': z.object({ projectId: id, lineId: id, storyId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) }),
  'stories.record': z.object({ projectId: id, lineId: id, storyId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), insert: z.object({ sequence: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), start: z.number().int().min(0).nullable().optional() }).nullable().optional(), includeActivity: z.boolean().optional() }),
  'stories.insert': z.object({ projectId: id, lineId: id, runId: id, sequence: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), start: z.number().int().min(0).nullable().optional() }),
  'stories.screenshot': z.object({ projectId: id, runId: id }),
  'objects.list': z.object({ projectId: id, lineId: id }),
  'objects.uses': z.object({ projectId: id, objectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) }),
  'outcomes.compare': z.object({ projectId: id, refs: z.array(contentRefSchema).min(1).max(4) }),
  'releases.list': projectOnly,
  'tests.run': z.object({ projectId: id, lineId: id }),
  'tests.list': projectOnly,
  'connector.state': z.object({}),
  'connector.setEnabled': z.object({ enabled: z.boolean() }),
  'connector.setPublicUrl': z.object({ url: z.string().min(1).max(500).nullable() }),
  'connector.tunnel.start': z.object({}),
  'connector.tunnel.stop': z.object({}),
  'connector.decide': z.object({ id: z.string().min(1).max(200), allow: z.boolean() }),
  'connector.revoke': z.object({ appId: z.string().min(1).max(200) }),
  'connector.hold': z.object({ app: z.string().min(1).max(200), held: z.boolean(), projectId: id.nullish() }),
  /** `destination` is only honoured by test hosts; the desktop app always saves to Downloads. */
  'connector.extension.save': z.object({ destination: z.string().min(1).max(2000).optional() }),
  'ops.activity': z.object({ projectId: id, limit: z.number().int().min(1).max(4000).optional() }),
  'ops.undo': z.object({ projectId: id, activityId: id }),
  'storage.usage': empty,
  'storage.clean': z.object({ category: z.enum(CACHE_CATEGORIES) }),
  'storage.compact': projectOnly,
  'publish.targets.list': empty,
  'publish.targets.save': z.object({
    id: id.optional(),
    provider: z.enum(PUBLISH_PROVIDERS),
    name: z.string().trim().min(1).max(80),
    site: z.string().trim().max(200),
    teamId: z.string().trim().max(100).nullable(),
    apiBase: z.string().trim().max(300).optional(),
    production: z.boolean(),
    token: z.string().min(1).max(4096).optional(),
    persistence: z.enum(['persistent', 'session']).optional(),
  }),
  'publish.targets.remove': z.object({ id }),
  'publish.plan': z.object({ projectId: id, lineId: id, targetId: id, folder: z.string().max(400).optional() }),
  'publish.start': z.object({ projectId: id, lineId: id, targetId: id, folder: z.string().max(400).optional() }),
  'publish.list': projectOnly,
  'publish.cancel': z.object({ projectId: id, jobId: id }),
  'publish.check': z.object({ projectId: id, jobId: id }),
  'publish.retry': z.object({ projectId: id, jobId: id, confirmUncertain: z.boolean() }),
  'deps.status': projectOnly,
  'deps.align': z.object({ projectId: id, lineId: id, names: z.array(z.string().min(1).max(214)).min(1).max(500) }),
  'brand.get': projectOnly,
  'brand.set': z.object({ projectId: id, brand: brandInput }),
  'brand.plan': projectOnly,
  'brand.apply': z.object({ projectId: id, planId: id, itemIds: z.array(z.string().min(1).max(300)).min(1).max(500) }),
  'build.run': z.object({ projectId: id, lineId: id, command: z.string().min(1).max(2000) }),
  'build.script': z.object({ projectId: id, lineId: id, script: z.string().regex(/^[A-Za-z0-9:._-]{1,64}$/) }),
  'build.install': z.object({ projectId: id, lineId: id }),
  'build.devServer': z.object({ projectId: id, lineId: id }),
  'build.stop': z.object({ projectId: id, processId: id }),
  'build.output': z.object({ projectId: id, processId: id }),
  'build.collect': z.object({ projectId: id, lineId: id }),
  'design.describe': z.object({ projectId: id, lineId: id, page: projectPath }),

  // AI connections. Keys go in, never out: no channel returns a key.
  'ai.state': empty,
  'ai.connections.save': z.object({
    id: z.string().regex(/^[a-z0-9-]{4,64}$/).optional(),
    name: z.string().max(80),
    provider: z.enum(PROVIDER_KINDS),
    protocol: z.enum(PROTOCOLS),
    baseUrl: z.string().min(1).max(500),
    headers: z.record(z.string().min(1).max(100), z.string().max(500)).optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    media: z.array(z.enum(MEDIA_ADAPTERS)).optional(),
  }),
  'ai.connections.delete': z.object({ connectionId: id }),
  'ai.connections.test': z.object({ connectionId: id }),
  'ai.keys.set': z.object({ connectionId: id, key: z.string().min(1).max(4096), persistence: z.enum(['persistent', 'session']) }),
  'ai.keys.clear': z.object({ connectionId: id }),
  'ai.models.add': z.object({ connectionId: id, modelId: z.string().min(1).max(300), label: z.string().max(300).optional() }),
  'ai.models.remove': z.object({ connectionId: id, modelId: z.string().min(1).max(300) }),
  'ai.models.setCapability': z.object({ connectionId: id, modelId: z.string().min(1).max(300), capability: z.enum(CAPABILITIES), state: z.enum(['declared', 'unavailable', 'unknown']) }),
  'ai.models.verify': z.object({ connectionId: id, modelId: z.string().min(1).max(300), capability: z.enum(['text', 'code', 'tools']) }),
  'ai.models.setPricing': z.object({ connectionId: id, modelId: z.string().min(1).max(300), inputPerMTok: z.number().min(0).max(100_000).nullable(), outputPerMTok: z.number().min(0).max(100_000).nullable() }),
  'ai.routing.set': z.object({ job: z.enum(JOBS), assignment: z.object({ connectionId: id, modelId: z.string().min(1).max(300) }).nullable() }),
  'ai.routing.candidates': z.object({ job: z.enum(JOBS) }),
  'ai.tokenSaver.set': z.object({ replies: z.enum(['standard', 'brief', 'minimal']), compactOutputs: z.boolean(), compactHistory: z.boolean(), promptCaching: z.boolean() }),
  'ai.budgets.set': z.object({ perTaskUsd: z.number().min(0).max(10_000).nullable(), maxToolIterations: z.number().int().min(1).max(200), maxMinutes: z.number().min(1).max(240) }),
  'ai.tasks.list': projectOnly,
  'ai.tasks.get': z.object({ projectId: id, taskId: id }),
  'ai.tasks.preview': z.object({ projectId: id, mode: z.enum(TASK_MODES), attachments: z.array(projectPath).max(20) }),
  'ai.tasks.create': z.object({
    projectId: id,
    mode: z.enum(TASK_MODES),
    prompt: z.string().min(1).max(20_000),
    context: z.object({
      workspace: z.string().max(40),
      lineId: id.nullable(),
      path: projectPath.nullable(),
      selection: z.string().max(20_000).nullable(),
      references: z
        .array(z.object({ kind: z.enum(['file', 'element', 'clip', 'sequence', 'asset']), id: z.string().min(1).max(400), label: z.string().max(200), within: z.string().max(400).nullable().optional() }))
        .max(40)
        .optional(),
      playhead: z.object({ sequenceId: z.string().max(128), seconds: z.number().min(0).max(86_400) }).nullable().optional(),
    }),
    attachments: z.array(projectPath).max(20),
    permissions: z.object({ editAlternative: z.boolean(), runBuildAndTests: z.boolean(), installDependencies: z.boolean(), operatePreview: z.boolean() }).optional(),
  }),
  'ai.tasks.decide': z.object({ projectId: id, taskId: id, approve: z.boolean() }),
  'ai.project.get': projectOnly,
  'ai.project.set': z.object({ projectId: id, autopilot: z.boolean() }),
  'ai.tasks.artifact': z.object({ projectId: id, taskId: id, file: z.string().regex(/^shot-[a-z0-9-]+\.png$/) }),
  'ai.tasks.send': z.object({ projectId: id, taskId: id, text: z.string().min(1).max(20_000) }),
  'ai.tasks.cancel': z.object({ projectId: id, taskId: id }),
  'ai.tasks.pause': z.object({ projectId: id, taskId: id, reason: z.enum(['user-edit']).nullish() }),
  'ai.tasks.resume': z.object({ projectId: id, taskId: id }),
} as const;

export type ChannelName = keyof typeof channelSchemas;
export type ChannelInput<C extends ChannelName> = z.infer<(typeof channelSchemas)[C]>;

export interface ChannelOutputs {
  'app.info': AppInfo;
  'app.setChrome': true;
  'settings.get': AppSettings;
  'settings.set': AppSettings;
  'projects.recent': RecentProject[];
  'projects.removeRecent': RecentProject[];
  'projects.import': ImportReport | null;
  'projects.createSample': ProjectView;
  'templates.list': TemplateInfo[];
  'projects.createFromTemplate': ProjectView;
  'projects.open': ProjectView;
  'projects.view': ProjectView;
  'projects.close': true;
  'projects.reveal': true;
  'shell.openUrl': true;
  'projects.rename': ProjectView;
  'lines.create': { line: LineView; project: ProjectView };
  'lines.update': ProjectView;
  'lines.duplicate': { line: LineView; project: ProjectView };
  'lines.delete': ProjectView;
  'lines.setFollowing': { project: ProjectView; report: PropagationReport | null };
  'lines.commitDraft': ProjectView;
  'shared.save': SaveSharedResult;
  'shared.discardDraft': ProjectView;
  'files.list': FileEntry[];
  'files.read': FileContent;
  'files.write': WriteResult;
  'files.create': WriteResult;
  'files.delete': ProjectView;
  'files.reset': WriteResult;
  'files.search': SearchMatch[];
  'files.diagnostics': Diagnostic[];
  'conflicts.get': ConflictSetView | null;
  'conflicts.saveResolution': ConflictSetView;
  'conflicts.complete': { project: ProjectView; report: PropagationReport | null };
  'compare.run': ComparisonView;
  'combine.candidates': CombineCandidates;
  'combine.hunks': DiffHunkView[];
  'combine.sections': SectionInfo[];
  'combine.analyzeSection': SectionAnalysis;
  'combine.preview': CombineProposal;
  'combine.mergeChunks': ConflictChunkView[];
  'combine.apply': CombineResult;
  'operations.undo': ProjectView;
  'history.list': HistoryEntry[];
  'history.createCheckpoint': ProjectView;
  'history.checkpoint': CheckpointDetails;
  'history.restorePreview': RestorePreview;
  'history.restore': { project: ProjectView; report: PropagationReport | null; checkpointId: string };
  'history.renameCheckpoint': ProjectView;
  'export.run': ExportReport | null;
  'preview.open': PreviewHandle;
  'preview.release': true;
  'commands.run': CommandRunResult;
  'commands.step': { label: string | null; undo: string | null; redo: string | null };
  'build.state': BuildStateView;
  'commands.state': { undo: string | null; redo: string | null };
  'video.tools': VideoToolsView;
  'media.list': MediaAssetView[];
  'media.import': { imported: MediaAssetView[]; failed: { name: string; reason: string }[] } | null;
  'media.relink': { asset: MediaAssetView; sameContent: boolean } | null;
  'media.waveform': WaveformView;
  'sequences.list': SequenceSummary[];
  'sequences.get': { sequence: Sequence; hash: string };
  'video.export.start': ExportJobView | null;
  'video.export.list': ExportJobView[];
  'video.export.cancel': ExportJobView;
  'video.export.reveal': boolean;
  'media.jobs.list': MediaJobView[];
  'media.jobs.plan': MediaJobPlan;
  'media.jobs.start': MediaJobView;
  'media.jobs.cancel': MediaJobView;
  'media.jobs.retry': MediaJobView;
  'media.transcript': TranscriptView | null;
  'media.setTags': true;
  'media.usage': AssetUsageView;
  'assets.links': AssetLinkView[];
  'assets.place': { path: string; changed: boolean };
  'assets.updateLinks': { updated: { lineId: string; path: string }[]; failed: { lineId: string; path: string; reason: string }[] };
  'video.ai.analyze': TimelineProposalView;
  'video.ai.plan': TimelineProposalView;
  'video.ai.cancel': true;
  'video.ai.discard': true;
  'video.ai.apply': { lineId: string; label: string; checkpointId: string; hashes: Record<string, string | null> };
  'combine.timeline': { items: (TimelineConflictItemView & { choice: 'ours' | 'theirs' | 'both' | null })[]; taken: string[]; diff: SequenceDiffView; source: { tracks: { id: string; name: string; kind: string; clips: number }[]; clips: { id: string; label: string; trackId: string; start: number; end: number; changed: boolean }[] } };
  'compare.sequence': SequenceDiffView;
  'stories.list': import('./stories').StoryView[];
  'stories.runs': import('./stories').StoryRunView[];
  'stories.run': import('./stories').StoryRunView;
  'stories.record': import('./stories').StoryRunView;
  'stories.insert': true;
  'stories.screenshot': string | null;
  'objects.list': import('./objects').ObjectView[];
  'objects.uses': import('./objects').ObjectUsesView;
  'outcomes.compare': import('./outcomes').UniverseOutcomes;
  'releases.list': import('./outcomes').ReleaseDestinationView[];
  'tests.run': import('./outcomes').TestRunView;
  'tests.list': import('./outcomes').TestRunView[];
  'connector.state': import('./connector').ConnectorStateView;
  'connector.setEnabled': import('./connector').ConnectorStateView;
  'connector.setPublicUrl': import('./connector').ConnectorStateView;
  'connector.tunnel.start': import('./connector').ConnectorStateView;
  'connector.tunnel.stop': import('./connector').ConnectorStateView;
  'connector.decide': import('./connector').ConnectorStateView;
  'connector.revoke': import('./connector').ConnectorStateView;
  'connector.hold': import('./connector').ConnectorStateView;
  'connector.extension.save': { file: string; bridge: string; config: string };
  'ops.activity': import('./activity').ActivityRecord[];
  'ops.undo': true;
  'storage.usage': StorageView;
  'storage.clean': { freed: number; view: StorageView };
  'storage.compact': { revisions: number; objects: number; freed: number; view: StorageView };
  'publish.targets.list': PublishTargetView[];
  'publish.targets.save': PublishTargetView;
  'publish.targets.remove': true;
  'publish.plan': PublishPlanView;
  'publish.start': DeployJobView;
  'publish.list': DeployJobView[];
  'publish.cancel': DeployJobView;
  'publish.check': DeployJobView;
  'publish.retry': DeployJobView;
  'deps.status': {
    hasPackageJson: boolean;
    packages: { lineId: string; lineName: string; following: boolean; packages: { name: string; section: string; shared: string | null; here: string | null }[] }[];
    media: AssetLinkView[];
    exports: { jobId: string; lineId: string; sequenceId: string; sequenceName: string; reason: string; settings: import('./video').ExportSettings }[];
  };
  'deps.align': { label: string; lockfileNote: string };
  'brand.get': BrandSettingsView;
  'brand.set': BrandSettingsView;
  'brand.plan': BrandPlanView & { planId: string };
  'brand.apply': { applied: string[]; failed: { id: string; reason: string }[]; checkpointId: string };
  'build.run': BuildProcessView;
  'build.script': BuildProcessView;
  'build.install': BuildProcessView;
  'build.devServer': BuildProcessView;
  'build.stop': boolean;
  'build.output': BuildOutputView;
  'build.collect': BuildCollectView;
  'design.describe': DesignPageView;
  'ai.state': AiStateView;
  'ai.connections.save': AiStateView & { savedId: string };
  'ai.connections.delete': AiStateView;
  'ai.connections.test': ConnectionTestResult & { modelCount: number; state: AiStateView };
  'ai.keys.set': AiStateView;
  'ai.keys.clear': AiStateView;
  'ai.models.add': AiStateView;
  'ai.models.remove': AiStateView;
  'ai.models.setCapability': AiStateView;
  'ai.models.verify': { record: CapabilityRecord; state: AiStateView };
  'ai.models.setPricing': AiStateView;
  'ai.routing.set': AiStateView;
  'ai.routing.candidates': { connectionId: string; connectionName: string; modelId: string; label: string; verified: boolean; missing: string[]; local: boolean }[];
  'ai.tokenSaver.set': AiStateView;
  'ai.budgets.set': AiStateView;
  'ai.tasks.list': TaskSummary[];
  'ai.tasks.get': TaskView;
  'ai.tasks.preview': TaskSendPreview;
  'ai.tasks.create': TaskView;
  'ai.project.get': ProjectAiSettings;
  'ai.project.set': ProjectAiSettings;
  'ai.tasks.send': TaskView;
  'ai.tasks.decide': true;
  'ai.tasks.artifact': { dataUrl: string };
  'ai.tasks.cancel': true;
  'ai.tasks.pause': true;
  'ai.tasks.resume': true;
}

/** What a task will send, shown before the user sends it. */
export interface TaskSendPreview {
  route: { connectionName: string; modelLabel: string; local: boolean } | null;
  problem: string | null;
  items: { label: string; bytes: number; sent: boolean; note: string }[];
}

export type ChannelOutput<C extends ChannelName> = ChannelOutputs[C];

export interface IpcError {
  code: string;
  message: string;
  details?: unknown;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

export const IPC_INVOKE = 'mv:invoke';
export const IPC_EVENT = 'mv:event';

export function isChannelName(value: unknown): value is ChannelName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(channelSchemas, value);
}

/** Validate a call. Throws a zod error with details on invalid input. */
export function parseChannelInput<C extends ChannelName>(channel: C, input: unknown): ChannelInput<C> {
  return channelSchemas[channel].parse(input ?? {}) as ChannelInput<C>;
}
