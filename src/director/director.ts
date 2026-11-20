/**
 * The director's view of the studio and its access to the shared command layer.
 *
 * - `studioState` is a structured snapshot: project, universes (versions), the task's universe,
 *   the user's references and playhead, sequences with clip ids, assets, dependencies, running
 *   processes, conflicts, models and budgets. Objects are identified by stable ids.
 * - `commandCatalog` lists the registered commands with the JSON Schema of their arguments.
 * - `runStudioCommand` runs one through `CommandService` — the same validated, revision-checked,
 *   undoable path that buttons, menus and shortcuts use — with actor `ai-task`. A title the
 *   director adds is the same editable title object a user would create.
 */
import type { ProjectEngine } from '../engine/project';
import type { StudioService } from '../services/studio';
import type { TaskView } from '../shared/ai';
import { JOB_INFO } from '../shared/ai';
import { SHARED_LINE_ID } from '../shared/types';
import { TICKS_PER_SECOND } from '../shared/video';
import { normalizeProjectPath } from '../shared/paths';
import { toJsonSchema, type JsonSchema } from './schema';
import { listObjects } from '../objects/handlers';

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** One line per command, for the model. Commands without an entry use their name. */
const DESCRIPTIONS: Record<string, string> = {
  'video.createSequence': 'Create a timeline (sequence) file.',
  'video.setSequence': 'Rename a sequence or change its size, frame rate or background.',
  'video.addTrack': 'Add a video, audio or titles track.',
  'video.removeTrack': 'Remove a track.',
  'video.setTrack': 'Rename, mute, hide, lock or set the volume of a track.',
  'video.addClip': 'Place a media asset (by asset id) on a track at a time, with in/out points.',
  'video.addText': 'Add an editable title, title card, lower third or end card on a titles track.',
  'video.moveClip': 'Move a clip in time or to another track of the same kind.',
  'video.trimClip': 'Trim a clip’s start or end.',
  'video.splitClip': 'Split a clip at a time.',
  'video.deleteClips': 'Delete clips (optionally closing the gaps).',
  'video.setClip': 'Change clip properties: volume, speed, fades, transition, position, crop, scale, text and style.',
  'video.duplicateSequence': 'Copy a sequence, optionally with another size (reframing pictures).',
  'video.batch': 'Apply several timeline edits as one undoable step.',
  'design.setText': 'Replace the text of a page element (by data-mv-id or path).',
  'design.setAttribute': 'Set or remove an attribute (href, alt, …) of a page element.',
  'design.setStyle': 'Set a CSS property for an element, per breakpoint (written to design.css).',
  'design.setTheme': 'Change theme tokens (CSS custom properties).',
  'design.setTitle': 'Change a page’s <title>.',
  'design.insertSection': 'Insert a section from the section library into a page.',
  'design.moveSection': 'Move a section up or down.',
  'design.removeSection': 'Remove a section.',
  'design.duplicateSection': 'Duplicate a section.',
  'design.createPage': 'Create a page from the site’s layout.',
  'design.insertComponent': 'Insert a saved component.',
  'design.saveComponent': 'Save a section as a reusable component.',
  'design.syncComponent': 'Update a component’s instances from its saved source.',
  'design.applyBrand': 'Apply brand colours and fonts to the theme.',
  'design.setFontFaces': 'Declare @font-face rules for font assets.',
  'code.setDependencies': 'Set package.json dependency versions (keeps formatting).',
  'assets.place': 'Copy a library asset into the version at a project path.',
  'code.applyPatch': 'Apply a unified diff (--- a/path, +++ b/path, @@ hunks) to files in the task universe as one undoable step.',
  'code.writeFile': 'Create or replace a text file (the whole content) as one undoable step.',
  'code.editFile': 'Exact find-and-replace edits in one file as one undoable step; each find must match once unless all is set.',
  'objects.create': 'Create a living object (pricing card, feature list, statistic, call to action, title card) with its shared properties.',
  'objects.update': 'Change a living object’s shared properties or per-target overrides in this universe; pass `sync` (page and sequence paths) to update its placements in the same step.',
  'objects.place': 'Place a living object on a page as a section (it stays linked to the object).',
  'objects.addScene': 'Add a living object to a timeline as an editable title scene linked to the object.',
  'objects.setInstance': 'Override properties for one placement only (this instance).',
  'objects.sync': 'Re-render outdated placements of an object in the given files (hand-edited ones are kept unless overwriteEdited).',
  'objects.detach': 'Unlink one placement from its object; its content stays as ordinary HTML or a title.',
  'stories.create': 'Create an executable story: a start page, fixture data and steps (open, click, fill, press, wait, verify; chapter, annotate, narrate, hold). Locate elements by testid, mv-id, role and name, label, placeholder or text — never by coordinates.',
  'stories.exportWalkthrough': 'Write an interactive walkthrough page (walkthroughs/<story>.html) that performs the story step by step when served from the same site as the app.',
  'stories.update': 'Replace a story’s steps, fixtures, start page, viewport or timing.',
  'stories.addToSequence': 'Low level: put a recording and its markers into a sequence. Prefer story.record with insert, or story.addToTimeline.',
};

export interface CatalogEntry {
  name: string;
  domain: string;
  description: string;
  /** file: an undoable edit of files in the task universe; operation: a project-level action. */
  kind: 'file' | 'operation';
  args: JsonSchema;
}

export function commandCatalog(studio: StudioService, domain?: string): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const name of studio.commandRegistry.names().sort()) {
    const d = name.split('.')[0]!;
    if (domain && d !== domain) continue;
    const def = studio.commandRegistry.get(name);
    out.push({ name, domain: d, description: DESCRIPTIONS[name] ?? name, kind: 'file', args: toJsonSchema(def.schema as never) });
  }
  for (const op of studio.operations.registry.all()) {
    if (domain && op.domain !== domain) continue;
    out.push({ name: op.name, domain: op.domain, description: `${op.description}${op.effect === 'read' ? ' (read only)' : ''}`, kind: 'operation', args: toJsonSchema(op.schema as never) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function runStudioCommand(
  studio: StudioService,
  engine: ProjectEngine,
  lineId: string,
  task: Pick<TaskView, 'id'>,
  name: string,
  args: unknown,
  expected?: Record<string, string | null>,
): Promise<{ label: string; files: string[]; hashes: Record<string, string | null>; commandId: string; undoScope: string }> {
  const result = await studio.commands.run(engine, lineId, name, args, { actor: 'ai-task', taskId: task.id, expected });
  return { label: result.record.label, files: result.record.files.map((f) => f.path), hashes: result.hashes, commandId: result.record.id, undoScope: result.record.scope };
}

export async function studioState(studio: StudioService, engine: ProjectEngine, task: TaskView, lineId: string, include: { sequences?: boolean; assets?: boolean } = {}): Promise<Record<string, unknown>> {
  const view = await studio.view(engine);
  const lines = [view.shared, ...view.alternatives];
  const universe = lines.find((l) => l.id === lineId);
  const tree = await engine.effectiveTree(lineId);
  const state: Record<string, unknown> = {
    project: { id: view.id, name: view.name, kind: view.kind },
    workspace: task.context.workspace,
    taskUniverse: { id: lineId, name: universe?.name ?? null, startedFrom: task.originLineId ?? null, editable: lineId !== SHARED_LINE_ID },
    universes: lines.map((l) => ({ id: l.id, name: l.name, kind: l.kind, head: l.head, following: l.following, status: l.status, conflicts: l.conflictCount, filesDifferingFromShared: l.differsFromShared })),
    references: task.context.references ?? [],
    playhead: task.context.playhead ?? null,
    openFile: task.context.path,
    fileCount: tree.size,
    pages: [...tree.keys()].filter((p) => /\.html?$/.test(p)).slice(0, 50),
  };
  const conflicts = lines.filter((l) => l.conflictCount > 0).map((l) => ({ universe: l.name, files: l.conflictFiles }));
  const objects = await listObjects(engine, lineId).catch(() => []);
  const stories = await studio.stories.list(view.id, lineId).catch(() => []);
  state.stories = stories.map((s) => ({ id: s.id, name: s.name, page: s.page, status: s.status, statusDetail: s.statusDetail, steps: s.steps.length, lastRun: s.lastRun ? { ok: s.lastRun.ok, mode: s.lastRun.mode, at: s.lastRun.at, revision: s.lastRun.revision, error: s.lastRun.error, assetId: s.lastRun.assetId, runId: s.lastRun.id } : null, changedFiles: s.changedDeps.slice(0, 10) }));
  state.livingObjects = objects.map((o) => ({ id: o.id, type: o.type, name: o.name, revision: o.revision, properties: o.properties, overrides: o.overrides, placements: o.placements.map((p) => ({ kind: p.kind, path: p.path, instance: p.instance, clipId: p.clipId, state: p.state, overrides: p.overrides })) }));
  state.unresolvedConflicts = conflicts;

  if (include.sequences !== false) {
    const seqs = await studio.video.sequences(view.id, lineId).catch(() => []);
    state.sequences = seqs.map(({ summary, sequence }) => ({
      id: summary.id,
      name: summary.name,
      path: summary.path,
      seconds: round(summary.durationSeconds),
      size: `${summary.width}x${summary.height}`,
      tracks: (sequence?.tracks ?? []).map((t) => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        muted: t.muted,
        locked: t.locked,
        clips: t.clips.map((c) =>
          c.type === 'text'
            ? { id: c.id, type: 'text', start: round(c.start / TICKS_PER_SECOND), duration: round(c.duration / TICKS_PER_SECOND), text: c.text, template: c.template ?? 'plain' }
            : { id: c.id, type: c.type, asset: c.assetId, start: round(c.start / TICKS_PER_SECOND), duration: round((c.out - c.in) / c.speed / TICKS_PER_SECOND), in: round(c.in / TICKS_PER_SECOND), speed: c.speed },
        ),
      })),
    }));
    state.timeUnits = `Times above are in seconds. Commands take ticks: ${TICKS_PER_SECOND} ticks per second.`;
  }
  if (include.assets !== false) {
    const store = await studio.video.store(view.id).catch(() => null);
    const assets = store ? await store.list().catch(() => []) : [];
    state.assets = assets.slice(0, 150).map((a) => ({ id: a.id, name: a.name, kind: a.kind, seconds: a.probe.durationSeconds === null ? null : round(a.probe.durationSeconds), size: a.probe.width ? `${a.probe.width}x${a.probe.height}` : null, missing: a.missing, source: a.provenance?.source ?? 'imported' }));
    if (assets.length > 150) state.assetsOmitted = assets.length - 150;
  }
  const pkgHash = tree.get(normalizeProjectPath('package.json'));
  if (pkgHash) {
    try {
      const pkg = JSON.parse((await engine.readBlob(pkgHash)).toString('utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      state.dependencies = { scripts: Object.keys(pkg.scripts ?? {}), dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {} };
    } catch {
      state.dependencies = { error: 'package.json is not valid JSON' };
    }
  }
  if (studio.build) {
    const build = await studio.build.state(view.id, lineId).catch(() => null);
    if (build) state.processes = build.processes.slice(-8).map((p) => ({ id: p.id, label: p.label, status: p.status, exitCode: p.exitCode, url: p.url }));
  }
  const ai = studio.aiService;
  if (ai) {
    const s = await ai.state().catch(() => null);
    if (s) {
      state.models = Object.entries(s.routing).map(([job, r]) => {
        const conn = s.connections.find((c) => c.id === r?.connectionId);
        const model = conn?.models.find((m) => m.id === r?.modelId);
        const caps = Object.entries(model?.capabilities ?? {})
          .filter(([, c]) => c?.state === 'verified' || c?.state === 'declared')
          .map(([k, c]) => `${k}${c?.state === 'verified' ? '' : ' (declared)'}`);
        return { role: JOB_INFO[job as keyof typeof JOB_INFO]?.label ?? job, model: r?.modelId ?? null, provider: conn?.name ?? null, capabilities: caps };
      });
      state.budget = { perTaskUsd: s.budgets.perTaskUsd, maxRoundsOfActions: s.budgets.maxToolIterations, maxMinutes: s.budgets.maxMinutes, usedSoFar: task.usage };
    }
  }
  state.mode = task.mode;
  state.permissions = task.permissions ?? null;
  return state;
}
