/**
 * StudioService: the application logic behind the IPC contract. It runs in the
 * engine worker thread under Electron (and in the browser harness's Node server), so
 * expensive diffing, merging and parsing never block the UI thread.
 */
import { ConnectorService } from '../connector/service';
import { createConnectorHandlers, APP_VERSION } from '../connector/handlers';
import type { AiService } from '../ai/service';
import { createAiRuntime, type AiRuntime } from './aiHandlers';
import { CodingAgent } from '../agent/agent';
import { createCommandHandlers, createCommandLayer } from './commandHandlers';
import { createBuildRuntime } from './buildHandlers';
import { createVideoRuntime } from './videoHandlers';
import { createMediaRuntime, type MediaRuntime } from './mediaHandlers';
import { createDependencyHandlers } from './dependencies';
import { createPublishRuntime } from './publishHandlers';
import { createStorageHandlers } from './storageHandlers';
import { createOperations, createStoryReadHandlers } from './operationHandlers';
import { createObjectHandlers } from '../objects/handlers';
import { StoryService } from '../stories/service';
import type { OperationService } from '../commands/operations';
import type { PublishService } from '../publish/service';
import type { VideoService, MediaVariant } from '../video/service';
import type { BuildService } from '../build/service';
import type { CommandRegistry, CommandService } from '../commands/commands';
import type { BrowserProbe } from '../agent/browser';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectEngine } from '../engine/project';
import { StudioError } from '../engine/errors';
import { newId, nowIso, slugify } from '../engine/util';
import { writeFileAtomic } from '../engine/store/atomic';
import { ProjectDamagedError } from '../engine/store/manifestFile';
import { diffTrees } from '../engine/merge/treeMerge';
import { isTextFile, languageForPath } from '../engine/merge/text';
import { compareTrees } from '../engine/compare';
import { historyEntries } from '../engine/history';
import { exportTree, scanFolder } from '../engine/io';
import { diffSequences } from '../video/merge';
import { parseSequence } from '../video/sequence';
import {
  applyCombination,
  buildProposal,
  combineTimeline,
  combineMergeChunks,
  combineCandidates,
  fileHunks,
  refInfo,
  refLabel,
  treeReader,
} from '../engine/combine/combine';
import { adapterFor } from '../adapters/web';
import { z } from 'zod';
import { PLACEHOLDER_SVG, SECTIONS_CSS } from '../design/library';
import { PLACEHOLDER_IMAGE, SECTIONS_CSS_FILE } from '../design/commands';
import { PreviewRegistry, handlePreviewRequest, type PreviewResponse } from '../preview/server';
import { buildLineView, buildProjectView } from './views';
import { normalizeProjectPath, fileExtension, comparePaths } from '../shared/paths';
import type { ChannelInput, ChannelName, ChannelOutput } from '../shared/ipc';
import { LiveHub } from '../live/hub';
import {
  SHARED_LINE_ID,
  ALTERNATIVE_COLORS,
  type AlternativeColor,
  type ConflictChunkView,
  type ConflictSetView,
  type ContentRef,
  type FileConflictView,
  type FileEntry,
  type ProjectView,
  type RecentProject,
  type RefLabel,
  type SearchMatch,
  type StudioEvent,
  type WriteResult,
  type LineColor,
  type PropagationReport,
  type TemplateInfo,
} from '../shared/types';

export interface StudioServiceOptions {
  workspaceRoot: string;
  sampleRoot: string;
  /** Folder holding templates.json and one folder per template. Defaults to `templates` next to the sample folder. */
  templateRoot?: string;
  previewUrl(token: string): string;
  emit(event: StudioEvent): void;
  /** AI connections and tasks. Without it, AI channels explain that AI is unavailable here. */
  ai?: AiService;
  /** Enables the coding agent (Plan and Build modes). */
  agent?: { cacheRoot: string; probe?: BrowserProbe | null };
  /** Derived files (thumbnails, proxies, export work folders). Defaults to the agent's cache, else <workspace>/.cache. */
  cacheRoot?: string;
  /** Bundled fonts and optional tools. Defaults to `resources` next to the sample folder. */
  resourcesRoot?: string;
  /** Publishing: where targets are saved, and the key vault for their tokens (separate ids from AI keys). */
  publish?: { vault: import('../ai/vault').SecretVault | null; settingsFile: string; fetch?: typeof fetch; pollMs?: number };
  /** URL the UI uses to play project media (desktop: mvmedia://). */
  mediaUrl?: (projectId: string, assetId: string, variant: MediaVariant, version: string) => string;
  /** Connect AI apps (MCP). Where its settings live, the home folder for the discovery file, and how a bridge can start the app. */
  connector?: { root: string; home?: string; launch?: { command: string; args: string[] } | null; port?: number };
}

interface RecentRecord {
  id: string;
  name: string;
  storagePath: string;
  originalPath: string | null;
  lastOpenedAt: string;
}

interface SampleManifest {
  name: string;
  alternatives: { dir: string; name: string; color: AlternativeColor; description: string; remove?: string[] }[];
  checkpoint: string;
}

/** A folder whose package.json has a dev or start script is an app; anything else is a website. */
function detectKind(files: ReadonlyMap<string, Uint8Array>): 'website' | 'app' {
  const pkg = files.get('package.json');
  if (!pkg) return 'website';
  try {
    const scripts = (JSON.parse(Buffer.from(pkg).toString('utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return typeof scripts.dev === 'string' || typeof scripts.start === 'string' ? 'app' : 'website';
  } catch {
    return 'website';
  }
}

const templateListSchema = z.array(
  z.object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    name: z.string().min(1),
    kind: z.enum(['website', 'app', 'video']),
    stack: z.string(),
    needsInstall: z.boolean(),
    description: z.string(),
  }),
);

const IMAGE_DATA_URL = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif']);

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };

export class StudioService {
  readonly previews = new PreviewRegistry();
  private readonly engines = new Map<string, ProjectEngine>();
  private readonly opening = new Map<string, Promise<ProjectEngine>>();
  private readonly sizeCache = new Map<string, number>();
  private recentCache: RecentRecord[] | null = null;
  readonly handlers: Handlers;

  readonly aiRuntime: AiRuntime | null;
  readonly agent: CodingAgent | null;

  readonly commands: CommandService;
  readonly commandRegistry: CommandRegistry;
  /** Executable stories: runs, recordings and status. */
  readonly stories: StoryService;
  /** Project-level commands and the activity log. */
  readonly operations: OperationService;
  readonly build: BuildService | null;
  readonly video: VideoService;
  readonly media: MediaRuntime;
  readonly publish: PublishService;
  /** Connect AI apps through MCP (null when not configured). */
  readonly connector: ConnectorService | null;
  /** Live AI activity (pointer, highlight, activity pill) built from real engine events. */
  readonly live: LiveHub;
  /** Derived media, export work folders and recordings. Never holds originals or history. */
  readonly cacheRoot: string;
  /** Run folders for builds and coding tasks (null when processes are not available). */
  readonly runsRoot: string | null;

  constructor(private readonly options: StudioServiceOptions) {
    const layer = createCommandLayer();
    this.commands = layer.commands;
    this.live = new LiveHub(
      async (projectId, lineId) => {
        const view = await this.view(await this.engine(projectId));
        return [view.shared, ...view.alternatives].find((l) => l.id === lineId)?.name ?? null;
      },
      (event) => options.emit({ type: 'live', event }),
    );
    layer.commands.onApplied = async (engine, lineId, { record, args, files }) => this.live.command(engine.id, lineId, { id: record.id, name: record.name, args, label: record.label, actor: record.actor, via: record.via ?? null, taskId: record.taskId, files });
    layer.commands.onFailed = async (engine, lineId, info) => this.live.command(engine.id, lineId, { id: `cmd-failed-${Date.now().toString(36)}`, name: info.name, args: info.args, label: info.name, actor: info.actor, via: info.via, taskId: info.taskId, files: [], error: info.error });
    this.commandRegistry = layer.registry;
    const buildRuntime = createBuildRuntime(this, options.emit, options.agent?.cacheRoot ?? null);
    this.build = buildRuntime.build;
    const cacheRoot = options.cacheRoot ?? options.agent?.cacheRoot ?? path.join(options.workspaceRoot, '.cache');
    this.cacheRoot = cacheRoot;
    this.runsRoot = options.agent ? path.join(options.agent.cacheRoot, 'runs') : null;
    const videoRuntime = createVideoRuntime(this, options.emit, { cacheRoot, resourcesRoot: options.resourcesRoot ?? path.join(path.dirname(options.sampleRoot), 'resources'), mediaUrl: options.mediaUrl });
    this.video = videoRuntime.video;
    const mediaRuntime = createMediaRuntime(this, options.emit, { ai: options.ai ?? null, probe: options.agent?.probe ?? null, cacheRoot });
    this.media = mediaRuntime.runtime;
    const publishRuntime = createPublishRuntime(this, options.emit, options.publish ?? { vault: options.ai?.vault ?? null, settingsFile: path.join(options.workspaceRoot, 'publish-targets.json') });
    this.publish = publishRuntime.service;
    this.stories = new StoryService(this, { probe: options.agent?.probe ?? null, cacheRoot, emit: (e) => options.emit(e) });
    const resourcesRoot = options.resourcesRoot ?? path.join(path.dirname(options.sampleRoot), 'resources');
    this.connector = options.connector ? new ConnectorService(this, { ...options.connector, probe: options.agent?.probe ?? null, emit: (e) => options.emit(e), version: APP_VERSION }) : null;
    if (this.connector) void this.connector.init();
    const raw = { ...this.createHandlers(), ...createConnectorHandlers(this, resourcesRoot), ...createCommandHandlers(this, layer.commands), ...buildRuntime.handlers, ...videoRuntime.handlers, ...mediaRuntime.handlers, ...createDependencyHandlers(this), ...publishRuntime.handlers, ...createStorageHandlers(this), ...createObjectHandlers(this), ...createStoryReadHandlers(this) };
    // Project-level actions run as commands (validated, logged with their actor), whoever starts them.
    const ops = createOperations(this, raw);
    this.operations = ops.service;
    layer.commands.onRecord = async (engine, lineId, record) => this.operations.logCommand(engine.id, { name: record.name, lineId, label: record.label, scope: record.scope, actor: record.actor, via: record.via ?? null, taskId: record.taskId, files: record.files.map((f) => f.path) });
    const base = { ...raw, ...ops.handlers };
    this.agent = options.agent ? new CodingAgent(this, options.agent) : null;
    if (options.ai) {
      const { runtime, handlers } = createAiRuntime(this, options.emit, { ai: options.ai, agent: this.agent });
      this.aiRuntime = runtime;
      this.handlers = { ...base, ...handlers };
    } else {
      this.aiRuntime = null;
      this.handlers = base;
    }
  }

  /** The AI service (connections, routing, budgets), when AI is configured. */
  get aiService(): StudioServiceOptions['ai'] | null {
    return this.options.ai ?? null;
  }

  emitEvent(event: StudioEvent): void {
    this.options.emit(event);
  }

  get templateRoot(): string {
    return this.options.templateRoot ?? path.join(path.dirname(this.options.sampleRoot), 'templates');
  }

  get projectsDir(): string {
    return path.join(this.options.workspaceRoot, 'Projects');
  }

  /** Stop tasks and child processes before the app exits. */
  async shutdown(): Promise<void> {
    await this.aiRuntime?.runner.cancelAll();
    await this.agent?.shutdown();
    await this.build?.shutdown();
    await this.media.shutdown();
    await this.publish.shutdown();
    await this.connector?.shutdown();
    await this.video.shutdown();
  }

  async call<C extends ChannelName>(channel: C, input: ChannelInput<C>): Promise<ChannelOutput<C>> {
    const handler = this.handlers[channel] as ((i: ChannelInput<C>) => Promise<ChannelOutput<C>>) | undefined;
    if (!handler) throw new StudioError('unsupported', `${channel} is not available here.`);
    return handler(input);
  }

  /* ---------------- recent projects ---------------- */

  private get recentFile(): string {
    return path.join(this.options.workspaceRoot, 'recent.json');
  }

  private async readRecent(): Promise<RecentRecord[]> {
    if (this.recentCache) return this.recentCache;
    let list: RecentRecord[] = [];
    try {
      const parsed = JSON.parse(await fs.readFile(this.recentFile, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        list = parsed.filter(
          (r): r is RecentRecord =>
            typeof r === 'object' && r !== null && typeof (r as RecentRecord).id === 'string' && typeof (r as RecentRecord).storagePath === 'string',
        );
      }
    } catch {
      list = [];
    }
    // Rediscover projects in the workspace that are missing from the list.
    try {
      for (const entry of await fs.readdir(this.projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const storagePath = path.join(this.projectsDir, entry.name);
        if (list.some((r) => path.resolve(r.storagePath) === path.resolve(storagePath))) continue;
        try {
          const manifest = JSON.parse(await fs.readFile(path.join(storagePath, 'project.json'), 'utf8')) as { id?: string; name?: string; updatedAt?: string; source?: { originalPath?: string | null } };
          if (typeof manifest.id === 'string' && typeof manifest.name === 'string') {
            list.push({ id: manifest.id, name: manifest.name, storagePath, originalPath: manifest.source?.originalPath ?? null, lastOpenedAt: manifest.updatedAt ?? nowIso() });
          }
        } catch {
          // not a project folder
        }
      }
    } catch {
      // no projects yet
    }
    this.recentCache = list;
    return list;
  }

  private async writeRecent(list: RecentRecord[]): Promise<void> {
    this.recentCache = list;
    await writeFileAtomic(this.recentFile, JSON.stringify(list, null, 1));
  }

  private async touchRecent(engine: ProjectEngine): Promise<void> {
    const list = (await this.readRecent()).filter((r) => r.id !== engine.id);
    list.unshift({ id: engine.id, name: engine.data.name, storagePath: engine.dir, originalPath: engine.data.source.originalPath, lastOpenedAt: nowIso() });
    await this.writeRecent(list.slice(0, 30));
  }

  async listRecent(): Promise<RecentProject[]> {
    const out: RecentProject[] = [];
    for (const r of await this.readRecent()) {
      let available = true;
      let problem: string | null = null;
      let alternativeCount = 0;
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(r.storagePath, 'project.json'), 'utf8')) as { order?: unknown[] };
        alternativeCount = Array.isArray(manifest.order) ? manifest.order.length : 0;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          const folderExists = await fs.stat(r.storagePath).then(() => true, () => false);
          available = folderExists && (await fs.stat(path.join(r.storagePath, 'project.json.bak')).then(() => true, () => false));
          problem = folderExists ? 'Project metadata is missing; it may be recoverable.' : 'The project’s working copy was moved or deleted.';
        } else {
          problem = 'Project metadata looks damaged; opening will try to recover it.';
        }
      }
      out.push({ id: r.id, name: r.name, storagePath: r.storagePath, originalPath: r.originalPath, lastOpenedAt: r.lastOpenedAt, available, problem, alternativeCount });
    }
    return out.sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : -1));
  }

  /* ---------------- engines ---------------- */

  async engine(projectId: string): Promise<ProjectEngine> {
    const open = this.engines.get(projectId);
    if (open) return open;
    const inflight = this.opening.get(projectId);
    if (inflight) return inflight;
    const promise = (async () => {
      const record = (await this.readRecent()).find((r) => r.id === projectId);
      if (!record) throw new StudioError('not-found', 'That project is not in your workspace any more.');
      const exists = await fs.stat(record.storagePath).then(() => true, () => false);
      if (!exists) throw new StudioError('project-missing', `The working copy at ${record.storagePath} was moved or deleted. You can remove it from Recent projects.`);
      const engine = await ProjectEngine.open(record.storagePath);
      this.engines.set(projectId, engine);
      // Tidy up objects left behind by coalesced edits, without blocking the UI.
      void engine.collectGarbage().catch(() => undefined);
      return engine;
    })();
    this.opening.set(projectId, promise);
    try {
      return await promise;
    } finally {
      this.opening.delete(projectId);
    }
  }

  async view(engine: ProjectEngine): Promise<ProjectView> {
    return buildProjectView(engine, { originalPath: engine.data.source.originalPath });
  }

  async changed(engine: ProjectEngine, reason: string, lineIds: string[]): Promise<ProjectView> {
    const project = await this.view(engine);
    this.options.emit({ type: 'project-changed', projectId: engine.id, reason, lineIds, project });
    return project;
  }

  private async allocateDir(name: string): Promise<{ id: string; dir: string }> {
    await fs.mkdir(this.projectsDir, { recursive: true });
    const id = `${slugify(name)}-${newId('p').slice(2, 10)}`;
    return { id, dir: path.join(this.projectsDir, id) };
  }

  /* ---------------- project creation ---------------- */

  async importFolder(folderPath: string): Promise<ChannelOutput<'projects.import'>> {
    const scan = await scanFolder(folderPath);
    const adapter = adapterFor('web');
    const valid = adapter.validate([...scan.files.keys()]);
    if (!valid.ok) throw new StudioError('invalid-project', valid.message);
    const name = path.basename(path.resolve(folderPath)) || 'Imported site';
    const { id, dir } = await this.allocateDir(name);
    const engine = await ProjectEngine.create(dir, { id, name, files: scan.files, source: { kind: 'import', originalPath: path.resolve(folderPath) }, adapter: adapter.id, kind: detectKind(scan.files) });
    this.engines.set(id, engine);
    await this.touchRecent(engine);
    return {
      project: await this.view(engine),
      fileCount: scan.files.size,
      totalBytes: scan.totalBytes,
      skipped: scan.skipped,
      storagePath: dir,
      originalPath: path.resolve(folderPath),
    };
  }

  async readTreeDir(root: string): Promise<Map<string, Buffer>> {
    return (await scanFolder(root)).files;
  }

  async createSample(): Promise<ProjectView> {
    const manifest = JSON.parse(await fs.readFile(path.join(this.options.sampleRoot, 'sample.json'), 'utf8')) as SampleManifest;
    const sharedFiles = await this.readTreeDir(path.join(this.options.sampleRoot, 'shared'));
    const { id, dir } = await this.allocateDir(manifest.name);
    const engine = await ProjectEngine.create(dir, { id, name: manifest.name, files: sharedFiles, source: { kind: 'sample', originalPath: null }, adapter: 'web' });
    for (const alt of manifest.alternatives) {
      const line = await engine.createAlternative({ from: { kind: 'line', lineId: SHARED_LINE_ID }, name: alt.name, color: alt.color, description: alt.description, following: true });
      const files = new Map<string, Buffer | string>(sharedFiles);
      for (const removed of alt.remove ?? []) files.delete(removed);
      for (const [p, data] of await this.readTreeDir(path.join(this.options.sampleRoot, 'alternatives', alt.dir))) files.set(p, data);
      await engine.setAlternativeContent(line.id, files, `Designed the ${alt.name} direction`);
    }
    await engine.createCheckpoint(manifest.checkpoint, 'The sample project as it was created.');
    this.engines.set(id, engine);
    await this.touchRecent(engine);
    return this.view(engine);
  }

  async listTemplates(): Promise<TemplateInfo[]> {
    const raw = JSON.parse(await fs.readFile(path.join(this.templateRoot, 'templates.json'), 'utf8')) as unknown;
    return templateListSchema.parse(raw);
  }

  /** Copies a template into a new project. Website templates also get the section styles and placeholder image the Design workspace uses. */
  async createFromTemplate(templateId: string, name?: string): Promise<ProjectView> {
    const template = (await this.listTemplates()).find((t) => t.id === templateId);
    if (!template) throw new StudioError('not-found', 'That template is not available in this version of Multiverse Studio.');
    const files = new Map<string, Buffer | string>(await this.readTreeDir(path.join(this.templateRoot, template.id)));
    if (template.kind === 'website') {
      if (!files.has(SECTIONS_CSS_FILE)) files.set(SECTIONS_CSS_FILE, SECTIONS_CSS);
      if (!files.has(PLACEHOLDER_IMAGE)) files.set(PLACEHOLDER_IMAGE, PLACEHOLDER_SVG);
    }
    const projectName = name?.trim() || template.name;
    const { id, dir } = await this.allocateDir(projectName);
    const engine = await ProjectEngine.create(dir, {
      id,
      name: projectName,
      files,
      source: { kind: 'template', originalPath: null, templateId: template.id },
      adapter: 'web',
      kind: template.kind,
    });
    this.engines.set(id, engine);
    await this.touchRecent(engine);
    return this.view(engine);
  }

  /* ---------------- refs, labels, files ---------------- */

  private refLabelView(engine: ProjectEngine, ref: ContentRef): RefLabel {
    let color: LineColor = 'shared';
    let detail = '';
    if (ref.kind === 'line') {
      const line = engine.data.lines[ref.lineId];
      color = line?.color ?? 'shared';
      detail = line?.kind === 'shared' ? (line.draftTree ? 'Includes unsaved shared edits' : 'Current') : 'Current';
    } else if (ref.kind === 'checkpoint') {
      const cp = engine.data.checkpoints.find((c) => c.id === ref.checkpointId);
      color = cp?.lines[ref.lineId]?.color ?? 'shared';
      detail = cp ? `Checkpoint · ${new Date(cp.createdAt).toLocaleString()}` : 'Checkpoint';
    } else if (ref.kind === 'proposal') {
      detail = 'Not applied yet';
    }
    return { ref, label: refLabel(engine, ref), color, detail };
  }

  private async size(engine: ProjectEngine, hash: string): Promise<number> {
    const cached = this.sizeCache.get(hash);
    if (cached !== undefined) return cached;
    const size = await engine.objects.size(hash);
    if (this.sizeCache.size > 20000) this.sizeCache.clear();
    this.sizeCache.set(hash, size);
    return size;
  }

  async listFiles(engine: ProjectEngine, ref: ContentRef): Promise<FileEntry[]> {
    const { tree } = await engine.resolveRef(ref);
    let sharedTree: Map<string, string> | null = null;
    let savedTree: Map<string, string> | null = null;
    let pending: Record<string, unknown> = {};
    if (ref.kind === 'line') {
      const line = engine.line(ref.lineId);
      if (line.kind === 'alternative') sharedTree = await engine.treeOfRevision(line.incorporatedShared);
      if (line.draftTree) savedTree = await engine.treeOfRevision(line.head);
      pending = line.pending?.files ?? {};
    }
    const out: FileEntry[] = [];
    for (const [p, hash] of [...tree.entries()].sort((a, b) => comparePaths(a[0], b[0]))) {
      out.push({
        path: p,
        hash,
        size: await this.size(engine, hash),
        kind: isTextFile(p) ? 'text' : 'binary',
        language: languageForPath(p),
        differsFromShared: sharedTree ? sharedTree.get(p) !== hash : false,
        inDraft: savedTree ? savedTree.get(p) !== hash : false,
        conflicted: p in pending,
        locked: p in pending,
      });
    }
    return out;
  }

  async readFile(engine: ProjectEngine, ref: ContentRef, rawPath: string): Promise<ChannelOutput<'files.read'>> {
    const filePath = normalizeProjectPath(rawPath);
    const { tree } = await engine.resolveRef(ref);
    const hash = tree.get(filePath);
    if (!hash) throw new StudioError('not-found', `${filePath} is not part of this version.`);
    const data = await engine.readBlob(hash);
    const text = isTextFile(filePath, data) && data.length <= 20 * 1024 * 1024 ? data.toString('utf8') : null;
    const ext = fileExtension(filePath);
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : ext === 'ico' ? 'image/x-icon' : `image/${ext}`;
    const dataUrl = IMAGE_DATA_URL.has(ext) && data.length <= 4 * 1024 * 1024 ? `data:${mime};base64,${data.toString('base64')}` : null;
    return { path: filePath, hash, kind: text === null ? 'binary' : 'text', language: languageForPath(filePath), size: data.length, text, dataUrl };
  }

  private async writeResult(engine: ProjectEngine, lineId: string, filePath: string, hash: string, text: string, mergedText: string | null = null): Promise<WriteResult> {
    const adapter = adapterFor(engine.data.adapter);
    const line = await buildLineView(engine, engine.line(lineId));
    void this.changed(engine, 'edit', [lineId]).catch(() => undefined);
    return { path: filePath, hash, savedAt: nowIso(), diagnostics: adapter.diagnostics(filePath, mergedText ?? text), line, mergedText };
  }

  async search(engine: ProjectEngine, ref: ContentRef, query: string, caseSensitive: boolean): Promise<SearchMatch[]> {
    const { tree } = await engine.resolveRef(ref);
    const needle = caseSensitive ? query : query.toLowerCase();
    const out: SearchMatch[] = [];
    for (const [p, hash] of [...tree.entries()].sort((a, b) => comparePaths(a[0], b[0]))) {
      if (!isTextFile(p)) continue;
      const data = await engine.readBlob(hash);
      if (data.length > 5 * 1024 * 1024 || !isTextFile(p, data)) continue;
      const lines = data.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const hay = caseSensitive ? line : line.toLowerCase();
        let at = hay.indexOf(needle);
        while (at >= 0) {
          const start = Math.max(0, at - 40);
          out.push({ path: p, line: i + 1, column: at + 1, preview: (start > 0 ? '…' : '') + line.slice(start, at + needle.length + 60).replace(/\t/g, ' '), matchLength: needle.length });
          if (out.length >= 500) return out;
          at = hay.indexOf(needle, at + Math.max(1, needle.length));
        }
      }
    }
    return out;
  }

  /* ---------------- conflicts ---------------- */

  /** Media names for describing timelines (falls back to “missing media”). */
  async assetNames(projectId: string): Promise<(id: string) => string> {
    const store = await this.video.store(projectId).catch(() => null);
    const names = new Map(((await store?.load())?.assets ?? []).map((a) => [a.id, a.name]));
    return (id) => names.get(id) ?? 'missing media';
  }

  async conflictSet(engine: ProjectEngine, lineId: string): Promise<ConflictSetView | null> {
    const line = engine.line(lineId);
    const pending = line.pending;
    if (!pending) return null;
    const files: FileConflictView[] = [];
    let total = 0;
    let unresolved = 0;
    for (const [filePath, record] of Object.entries(pending.files).sort(([a], [b]) => comparePaths(a, b))) {
      if (record.type === 'text') {
        const chunks = await engine.conflictChunks(record);
        const views: ConflictChunkView[] = [];
        let index = 0;
        let lineNo = 1;
        for (const chunk of chunks) {
          if (chunk.kind === 'stable') {
            views.push({ kind: 'stable', text: chunk.lines.join(''), startLine: lineNo, lineCount: chunk.lines.length });
            lineNo += chunk.lines.length;
          } else {
            views.push({ kind: 'conflict', index, base: chunk.base.join(''), ours: chunk.ours.join(''), theirs: chunk.theirs.join(''), resolution: record.resolutions[String(index)] ?? null });
            lineNo += chunk.ours.length;
            index++;
          }
        }
        const manualText = record.manual ? (await engine.readBlob(record.manual)).toString('utf8') : null;
        const fileUnresolved = engine.unresolvedCount(record);
        total += record.conflictCount;
        unresolved += fileUnresolved;
        files.push({ type: 'text', path: filePath, chunks: views, conflictCount: record.conflictCount, resolvedCount: record.conflictCount - fileUnresolved, manualText, addedOnBothSides: record.base === null });
      } else if (record.type === 'timeline') {
        const merged = await engine.timelineMerge(record, record.timelineChoices ?? {}, { asset: await this.assetNames(engine.id), ours: line.name, theirs: 'Shared' });
        const chosen = record.timelineChoices ?? {};
        const fileUnresolved = engine.unresolvedCount(record);
        total += record.conflictCount;
        unresolved += fileUnresolved;
        files.push({
          type: 'timeline',
          path: filePath,
          sequenceName: merged.sequence.name,
          items: merged.conflicts.map((c) => ({ ...c, choice: chosen[c.key] ?? null })),
          taken: merged.taken,
          conflictCount: record.conflictCount,
          resolvedCount: record.conflictCount - fileUnresolved,
          choice: record.choice,
        });
      } else {
        total += 1;
        unresolved += record.choice ? 0 : 1;
        files.push({
          type: record.type,
          path: filePath,
          oursExists: record.ours !== null,
          theirsExists: record.theirs !== null,
          deletedBy: record.deletedBy,
          choice: record.choice,
          oursSize: record.ours ? await this.size(engine, record.ours) : 0,
          theirsSize: record.theirs ? await this.size(engine, record.theirs) : 0,
        });
      }
    }
    return {
      lineId,
      lineName: line.name,
      sharedFrom: pending.from,
      sharedTo: pending.to,
      sharedMessage: pending.sharedMessage,
      createdAt: pending.createdAt,
      files,
      totalConflicts: total,
      unresolved,
      queuedSharedChanges: pending.to !== engine.shared.head,
    };
  }

  /* ---------------- previews ---------------- */

  async servePreview(token: string, pathname: string, origin: string): Promise<PreviewResponse> {
    return handlePreviewRequest(
      this.previews,
      {
        tree: async (target) => (await (await this.engine(target.projectId)).resolveRef(target.ref)).tree,
        blob: async (projectId, hash) => (await this.engine(projectId)).readBlob(hash),
      },
      token,
      pathname,
      origin,
    );
  }

  nextColor(engine: ProjectEngine): AlternativeColor {
    const used = new Set(engine.alternatives().map((l) => l.color));
    return ALTERNATIVE_COLORS.find((c) => !used.has(c)) ?? ALTERNATIVE_COLORS[engine.alternatives().length % ALTERNATIVE_COLORS.length]!;
  }

  private emitPropagation(engine: ProjectEngine, report: PropagationReport | null): void {
    if (report) this.options.emit({ type: 'propagation', projectId: engine.id, report });
  }

  /* ---------------- handlers ---------------- */

  private createHandlers(): Handlers {
    return {
      'projects.recent': async () => this.listRecent(),
      'projects.removeRecent': async ({ projectId }) => {
        await this.writeRecent((await this.readRecent()).filter((r) => r.id !== projectId));
        this.engines.delete(projectId);
        return this.listRecent();
      },
      'projects.import': async ({ folderPath }) => {
        if (!folderPath) return null;
        return this.importFolder(folderPath);
      },
      'projects.createSample': async () => this.createSample(),
      'templates.list': async () => this.listTemplates(),
      'projects.createFromTemplate': async ({ templateId, name }) => this.createFromTemplate(templateId, name),
      'projects.open': async ({ projectId }) => {
        try {
          const engine = await this.engine(projectId);
          await this.touchRecent(engine);
          return this.view(engine);
        } catch (error) {
          if (error instanceof ProjectDamagedError) throw new StudioError('project-damaged', error.message, error.details);
          throw error;
        }
      },
      'projects.view': async ({ projectId }) => this.view(await this.engine(projectId)),
      'projects.close': async ({ projectId }) => {
        this.previews.releaseProject(projectId);
        await this.aiRuntime?.runner.cancelAll(projectId);
        await this.build?.stopProject(projectId);
        return true;
      },
      'projects.rename': async ({ projectId, name }) => {
        const engine = await this.engine(projectId);
        await engine.rename(name);
        await this.touchRecent(engine);
        return this.changed(engine, 'rename', []);
      },

      'lines.create': async ({ projectId, from, name, color, description, following }) => {
        const engine = await this.engine(projectId);
        const record = await engine.createAlternative({ from, name, color, description, following });
        const project = await this.changed(engine, 'create', [record.id]);
        return { line: project.alternatives.find((l) => l.id === record.id)!, project };
      },
      'lines.update': async ({ projectId, lineId, name, color, description }) => {
        const engine = await this.engine(projectId);
        await engine.updateAlternative(lineId, { name, color, description });
        return this.changed(engine, 'update', [lineId]);
      },
      'lines.duplicate': async ({ projectId, lineId }) => {
        const engine = await this.engine(projectId);
        const source = engine.line(lineId);
        const record = await engine.createAlternative({
          from: { kind: 'line', lineId },
          name: `${source.name} copy`.slice(0, 80),
          color: this.nextColor(engine),
          description: source.description,
          following: source.kind === 'shared' ? true : source.following,
        });
        const project = await this.changed(engine, 'create', [record.id]);
        return { line: project.alternatives.find((l) => l.id === record.id)!, project };
      },
      'lines.delete': async ({ projectId, lineId }) => {
        const engine = await this.engine(projectId);
        await engine.deleteAlternative(lineId);
        return this.changed(engine, 'delete', [lineId]);
      },
      'lines.setFollowing': async ({ projectId, lineId, following }) => {
        const engine = await this.engine(projectId);
        const report = await engine.setFollowing(lineId, following);
        this.emitPropagation(engine, report);
        return { project: await this.changed(engine, 'following', [lineId]), report };
      },
      'lines.commitDraft': async ({ projectId }) => this.view(await this.engine(projectId)),
      'shared.save': async ({ projectId, message }) => {
        const engine = await this.engine(projectId);
        const report = await engine.saveShared(message);
        this.emitPropagation(engine, report);
        const project = await this.changed(engine, 'shared-save', report ? [SHARED_LINE_ID, ...report.lines.filter((l) => l.outcome === 'applied' || l.outcome === 'conflicted').map((l) => l.lineId)] : [SHARED_LINE_ID]);
        return { saved: report !== null, report, project };
      },
      'shared.discardDraft': async ({ projectId }) => {
        const engine = await this.engine(projectId);
        await engine.discardSharedDraft();
        return this.changed(engine, 'discard', [SHARED_LINE_ID]);
      },

      'files.list': async ({ projectId, ref }) => this.listFiles(await this.engine(projectId), ref),
      'files.read': async ({ projectId, ref, path: p }) => this.readFile(await this.engine(projectId), ref, p),
      'files.write': async ({ projectId, lineId, path: p, text, baseHash }) => {
        const engine = await this.engine(projectId);
        const filePath = normalizeProjectPath(p);
        const { hash, mergedText } = await engine.writeFile(lineId, filePath, text, { baseHash });
        return this.writeResult(engine, lineId, filePath, hash, text, mergedText);
      },
      'files.create': async ({ projectId, lineId, path: p, text }) => {
        const engine = await this.engine(projectId);
        const filePath = normalizeProjectPath(p);
        const { hash } = await engine.writeFile(lineId, filePath, text, { mustNotExist: true });
        return this.writeResult(engine, lineId, filePath, hash, text);
      },
      'files.delete': async ({ projectId, lineId, path: p }) => {
        const engine = await this.engine(projectId);
        await engine.deleteFile(lineId, p);
        return this.changed(engine, 'delete-file', [lineId]);
      },
      'files.reset': async ({ projectId, lineId, path: p, to }) => {
        const engine = await this.engine(projectId);
        const filePath = normalizeProjectPath(p);
        const hash = await engine.resetFile(lineId, filePath, to);
        const text = hash ? (await engine.readBlob(hash)).toString('utf8') : '';
        return this.writeResult(engine, lineId, filePath, hash ?? '', text);
      },
      'files.search': async ({ projectId, ref, query, caseSensitive }) => this.search(await this.engine(projectId), ref, query, caseSensitive),
      'files.diagnostics': async ({ projectId, ref, path: p }) => {
        const engine = await this.engine(projectId);
        const file = await this.readFile(engine, ref, p);
        return file.text === null ? [] : adapterFor(engine.data.adapter).diagnostics(file.path, file.text);
      },

      'conflicts.get': async ({ projectId, lineId }) => this.conflictSet(await this.engine(projectId), lineId),
      'conflicts.saveResolution': async ({ projectId, lineId, resolution }) => {
        const engine = await this.engine(projectId);
        await engine.saveResolution(lineId, resolution);
        void this.changed(engine, 'resolution', [lineId]).catch(() => undefined);
        return (await this.conflictSet(engine, lineId))!;
      },
      'conflicts.complete': async ({ projectId, lineId }) => {
        const engine = await this.engine(projectId);
        const report = await engine.completeResolution(lineId);
        this.emitPropagation(engine, report);
        return { project: await this.changed(engine, 'resolved', [lineId]), report };
      },

      'compare.run': async ({ projectId, left, right }) => {
        const engine = await this.engine(projectId);
        const l = await engine.resolveRef(left);
        const r = await engine.resolveRef(right);
        const files = await compareTrees(engine, l.tree, r.tree);
        const common = l.revisionId && r.revisionId ? await engine.commonAncestor(l.revisionId, r.revisionId) : null;
        let commonRevision: { id: string; label: string } | null = null;
        if (common) {
          const rev = await engine.revision(common);
          const owner = engine.data.lines[rev.line]?.name ?? 'an earlier version';
          commonRevision = { id: common, label: `${owner} · ${new Date(rev.createdAt).toLocaleString()} — ${rev.message}` };
        }
        const counts = { added: 0, deleted: 0, modified: 0, unchanged: 0 };
        for (const f of files) counts[f.status]++;
        return { left: this.refLabelView(engine, left), right: this.refLabelView(engine, right), files, counts, commonRevision };
      },

      'compare.sequence': async ({ projectId, left, right, path: p }) => {
        const engine = await this.engine(projectId);
        const read = async (ref: ContentRef) => {
          const h = (await engine.resolveRef(ref)).tree.get(normalizeProjectPath(p));
          return h ? parseSequence((await engine.readBlob(h)).toString('utf8')) : null;
        };
        return diffSequences(await read(left), await read(right), await this.assetNames(projectId));
      },
      'combine.timeline': async ({ projectId, plan, path: p, source }) => {
        const engine = await this.engine(projectId);
        const r = await combineTimeline(engine, plan, p, source, await this.assetNames(projectId));
        return { items: r.items, taken: r.taken, source: r.source, diff: diffSequences(r.d, r.src, await this.assetNames(projectId)) };
      },

      'combine.candidates': async ({ projectId, source, destination }) => {
        const engine = await this.engine(projectId);
        const { files, common } = await combineCandidates(engine, source, destination);
        let commonRevision: { id: string; label: string } | null = null;
        if (common) {
          const rev = await engine.revision(common);
          commonRevision = { id: common, label: `${engine.data.lines[rev.line]?.name ?? 'Earlier version'} — ${rev.message}` };
        }
        return { source: this.refLabelView(engine, source), destination: this.refLabelView(engine, destination), commonRevision, files };
      },
      'combine.hunks': async ({ projectId, source, destination, path: p }) => fileHunks(await this.engine(projectId), source, destination, p),
      'combine.sections': async ({ projectId, ref, path: p }) => {
        const engine = await this.engine(projectId);
        const adapter = adapterFor(engine.data.adapter);
        if (!adapter.structural) return [];
        const file = await this.readFile(engine, ref, p);
        return file.text === null ? [] : adapter.structural.listSections(file.path, file.text);
      },
      'combine.analyzeSection': async ({ projectId, source, sourcePath, sectionKey, destination, destPath, target }) => {
        const engine = await this.engine(projectId);
        const adapter = adapterFor(engine.data.adapter);
        if (!adapter.structural) throw new StudioError('unsupported', 'This project type does not support section combining.');
        const s = await refInfo(engine, source);
        const d = await engine.resolveRef(destination);
        try {
          return await adapter.structural.analyze({
            source: treeReader(engine, s.tree, s.label),
            sourcePath: normalizeProjectPath(sourcePath),
            sectionKey,
            dest: treeReader(engine, d.tree, refLabel(engine, destination)),
            destPath: normalizeProjectPath(destPath),
            target,
          });
        } catch (error) {
          throw new StudioError('section-unsupported', (error as Error).message);
        }
      },
      'combine.preview': async ({ projectId, plan }) => {
        const engine = await this.engine(projectId);
        const adapter = adapterFor(engine.data.adapter);
        const built = await engine.run(() => buildProposal(engine, adapter, plan));
        const proposalId = engine.storeProposal(built.tree, 'Proposed combination');
        return { proposalId, files: built.files, changedCount: built.changes.length, conflicts: built.conflicts, warnings: built.warnings, ready: built.ready };
      },
      'combine.mergeChunks': async ({ projectId, plan, path: p, source }) => {
        const engine = await this.engine(projectId);
        const chunks = await combineMergeChunks(engine, plan, p, source);
        const resolutions = (plan.files[normalizeProjectPath(p)] as { resolutions?: Record<string, { choice: 'ours' | 'theirs' | 'ours-then-theirs' | 'theirs-then-ours' | 'custom'; text?: string }> } | undefined)?.resolutions ?? {};
        const out: ConflictChunkView[] = [];
        let index = 0;
        let lineNo = 1;
        for (const chunk of chunks) {
          if (chunk.kind === 'stable') {
            out.push({ kind: 'stable', text: chunk.lines.join(''), startLine: lineNo, lineCount: chunk.lines.length });
            lineNo += chunk.lines.length;
          } else {
            out.push({ kind: 'conflict', index, base: chunk.base.join(''), ours: chunk.ours.join(''), theirs: chunk.theirs.join(''), resolution: resolutions[String(index)] ?? null });
            lineNo += chunk.ours.length;
            index++;
          }
        }
        return out;
      },
      'combine.apply': async ({ projectId, plan }) => {
        const engine = await this.engine(projectId);
        const adapter = adapterFor(engine.data.adapter);
        const applied = await applyCombination(engine, adapter, plan);
        const project = await this.changed(engine, 'combine', [applied.lineId]);
        return {
          operationId: applied.operation.id,
          checkpointId: applied.checkpointId,
          lineId: applied.lineId,
          createdLine: applied.createdLine,
          changedFiles: applied.changes,
          summary: applied.summary,
          project,
        };
      },
      'operations.undo': async ({ projectId, operationId }) => {
        const engine = await this.engine(projectId);
        const op = engine.data.operations.find((o) => o.id === operationId);
        const report = await engine.undoOperation(operationId);
        this.emitPropagation(engine, report);
        return this.changed(engine, 'undo', op ? op.lineIds : []);
      },

      'history.list': async ({ projectId, lineId, limit }) => historyEntries(await this.engine(projectId), lineId, limit ?? 400),
      'history.createCheckpoint': async ({ projectId, name, description }) => {
        const engine = await this.engine(projectId);
        await engine.createCheckpoint(name, description);
        return this.changed(engine, 'checkpoint', []);
      },
      'history.checkpoint': async ({ projectId, checkpointId }) => {
        const engine = await this.engine(projectId);
        const cp = engine.checkpoint(checkpointId);
        const index = engine.data.checkpoints.findIndex((c) => c.id === checkpointId);
        const previous = index > 0 ? engine.data.checkpoints[index - 1] : undefined;
        const lines: ChannelOutput<'history.checkpoint'>['lines'] = [];
        for (const [lineId, entry] of Object.entries(cp.lines)) {
          const tree = await engine.treeOfRevision(entry.revision);
          const prevEntry = previous?.lines[lineId];
          const prevTree = prevEntry ? await engine.treeOfRevision(prevEntry.revision) : new Map<string, string>();
          const exists = Boolean(engine.data.lines[lineId]);
          lines.push({
            lineId,
            name: entry.name,
            color: entry.color,
            kind: entry.kind,
            revisionId: entry.revision,
            exists,
            changedSincePrevious: prevEntry || index === 0 ? diffTrees(prevTree, tree) : [],
            differsFromCurrent: exists ? diffTrees(tree, await engine.effectiveTree(lineId)) : [],
          });
        }
        const view = (await this.view(engine)).checkpoints.find((c) => c.id === checkpointId)!;
        return { checkpoint: view, lines };
      },
      'history.restorePreview': async ({ projectId, checkpointId, lineIds }) => {
        const engine = await this.engine(projectId);
        const cp = engine.checkpoint(checkpointId);
        const blocked = engine.restoreBlockers(checkpointId, lineIds);
        const restoringShared = lineIds.includes(SHARED_LINE_ID);
        const lines: ChannelOutput<'history.restorePreview'>['lines'] = [];
        for (const lineId of lineIds) {
          const entry = cp.lines[lineId];
          const line = engine.data.lines[lineId];
          let changes: { path: string; status: 'added' | 'deleted' | 'modified' }[] = [];
          let note: string | null = null;
          if (entry && line) {
            changes = diffTrees(await engine.effectiveTree(lineId), await engine.treeOfRevision(entry.revision));
            if (line.kind === 'shared') {
              const followers = engine.alternatives().filter((l) => l.following).length;
              note = `Restoring the Shared version is a shared change: ${followers} following ${followers === 1 ? 'alternative' : 'alternatives'} will be updated.`;
            } else if (line.following && !restoringShared && entry.incorporatedShared !== engine.shared.head) {
              const behind = engine.sharedChangesBetween(entry.incorporatedShared, engine.shared.head);
              note = `${line.name} will be ${behind} shared ${behind === 1 ? 'change' : 'changes'} behind afterwards; you can apply them from the sidebar.`;
            }
          }
          lines.push({ lineId, name: entry?.name ?? line?.name ?? lineId, changes, note, blocked: blocked.get(lineId) ?? null });
        }
        return { checkpointId, lines };
      },
      'history.restore': async ({ projectId, checkpointId, lineIds }) => {
        const engine = await this.engine(projectId);
        const result = await engine.restoreCheckpoint(checkpointId, lineIds);
        this.emitPropagation(engine, result.report);
        return { project: await this.changed(engine, 'restore', [...lineIds, ...(result.report?.lines.map((l) => l.lineId) ?? [])]), report: result.report, checkpointId: result.checkpointId };
      },
      'history.renameCheckpoint': async ({ projectId, checkpointId, name, description }) => {
        const engine = await this.engine(projectId);
        await engine.renameCheckpoint(checkpointId, name, description);
        return this.changed(engine, 'checkpoint', []);
      },

      'export.run': async ({ projectId, ref, format, destination, overwrite }) => {
        if (!destination) return null;
        const engine = await this.engine(projectId);
        const { tree } = await engine.resolveRef(ref);
        return exportTree({
          tree,
          read: (hash) => engine.readBlob(hash),
          adapter: adapterFor(engine.data.adapter),
          format,
          destination,
          overwrite: overwrite ?? false,
          workspaceRoot: this.options.workspaceRoot,
        });
      },

      'preview.open': async ({ projectId, ref }) => {
        const engine = await this.engine(projectId);
        await engine.resolveRef(ref);
        const token = this.previews.open({ projectId, ref });
        const entry = adapterFor(engine.data.adapter).entryFile((await engine.resolveRef(ref)).tree.keys()) ?? 'index.html';
        return { token, url: `${this.options.previewUrl(token)}${entry === 'index.html' ? '' : entry}` };
      },
      'preview.release': async ({ token }) => {
        this.previews.release(token);
        return true;
      },
    };
  }
}
