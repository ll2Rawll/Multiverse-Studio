/**
 * Combining: build a proposed result from a destination plus picks from other
 * alternatives (whole files, individual diff hunks, three-way merges against the
 * correct common revision, and HTML sections), preview it, and apply it atomically
 * with an automatic checkpoint so it can be undone.
 */
import type { ProjectEngine, Mutation } from '../project';
import { isObjectPath, mergeObjectTexts } from '../../objects/merge';
import { isStoryPath, mergeStoryTexts } from '../../stories/merge';
import { dependencyWarnings, type DependencySource } from './dependencies';
import type { Hash } from '../store/objects';
import type { LineRecord, OperationRecord } from '../store/records';
import { diffTrees, type TreeChange } from '../merge/treeMerge';
import { applyResolutions, diff3Lines, lineHunks } from '../merge/diff3';
import { isTextFile, splitLines } from '../merge/text';
import { StudioError } from '../errors';
import type { ProjectAdapter, TreeReader } from '../../adapters/types';
import { normalizeProjectPath, comparePaths } from '../../shared/paths';
import { isSequencePath } from '../merge/treeMerge';
import { mergeSequences } from '../../video/merge';
import { parseSequence, serializeSequence } from '../../video/sequence';
import { clipEnd, type Sequence, type Track } from '../../shared/video';
import {
  SHARED_LINE_ID,
  type CombineCandidateFile,
  type CombinePlan,
  type CombineWarning,
  type ContentRef,
  type DiffHunkView,
  type FileAction,
  type ProposedFile,
} from '../../shared/types';

export interface RefInfo {
  tree: Map<string, Hash>;
  revision: Hash | null;
  label: string;
}

export function refLabel(engine: ProjectEngine, ref: ContentRef): string {
  switch (ref.kind) {
    case 'line':
      return engine.data.lines[ref.lineId]?.name ?? 'Deleted alternative';
    case 'checkpoint': {
      const cp = engine.data.checkpoints.find((c) => c.id === ref.checkpointId);
      const entry = cp?.lines[ref.lineId];
      return entry && cp ? `${entry.name} · ${cp.name}` : 'Checkpoint';
    }
    case 'revision':
      return 'Earlier revision';
    case 'proposal':
      return 'Proposed combination';
  }
}

/** Resolve a ref, using saved revisions only (the Shared draft is not part of combines). */
export async function refInfo(engine: ProjectEngine, ref: ContentRef): Promise<RefInfo> {
  if (ref.kind === 'line') {
    const line = engine.line(ref.lineId);
    return { tree: await engine.treeOfRevision(line.head), revision: line.head, label: line.name };
  }
  const resolved = await engine.resolveRef(ref);
  return { tree: resolved.tree, revision: resolved.revisionId, label: refLabel(engine, ref) };
}

export function treeReader(engine: ProjectEngine, tree: ReadonlyMap<string, Hash>, label: string): TreeReader {
  return {
    label,
    paths: () => [...tree.keys()],
    hash: (path) => tree.get(path),
    text: async (path) => {
      const hash = tree.get(path);
      if (!hash) return null;
      const data = await engine.readBlob(hash);
      return isTextFile(path, data) ? data.toString('utf8') : null;
    },
  };
}

async function textOf(engine: ProjectEngine, hash: Hash | undefined | null): Promise<string> {
  if (!hash) return '';
  return (await engine.readBlob(hash)).toString('utf8');
}

async function isTextHashes(engine: ProjectEngine, path: string, hashes: (Hash | undefined | null)[]): Promise<boolean> {
  for (const h of hashes) {
    if (!h) continue;
    if (!isTextFile(path, await engine.readBlob(h))) return false;
  }
  return true;
}

export async function combineCandidates(
  engine: ProjectEngine,
  source: ContentRef,
  destination: ContentRef,
): Promise<{ files: CombineCandidateFile[]; common: Hash | null }> {
  const s = await refInfo(engine, source);
  const d = await refInfo(engine, destination);
  const common = s.revision && d.revision ? await engine.commonAncestor(d.revision, s.revision) : null;
  const base = common ? await engine.treeOfRevision(common) : new Map<string, Hash>();
  const paths = [...new Set([...s.tree.keys(), ...d.tree.keys()])].sort(comparePaths);
  const files: CombineCandidateFile[] = [];
  for (const path of paths) {
    const sh = s.tree.get(path);
    const dh = d.tree.get(path);
    const status = sh === dh ? 'unchanged' : !dh ? 'added' : !sh ? 'deleted' : 'modified';
    const text = await isTextHashes(engine, path, [sh, dh]);
    files.push({
      path,
      status,
      kind: text ? 'text' : 'binary',
      sourceChangedSinceCommon: base.get(path) !== sh,
      destChangedSinceCommon: base.get(path) !== dh,
      mergeable: text && Boolean(sh) && Boolean(dh),
      ...(isSequencePath(path) ? { timeline: true } : {}),
    });
  }
  return { files, common };
}

/** Diff hunks that turn the destination's file into the source's file. */
export async function fileHunks(engine: ProjectEngine, source: ContentRef, destination: ContentRef, rawPath: string): Promise<DiffHunkView[]> {
  const path = normalizeProjectPath(rawPath);
  const s = await refInfo(engine, source);
  const d = await refInfo(engine, destination);
  if (!(await isTextHashes(engine, path, [s.tree.get(path), d.tree.get(path)]))) return [];
  const destLines = splitLines(await textOf(engine, d.tree.get(path)));
  const sourceLines = splitLines(await textOf(engine, s.tree.get(path)));
  return lineHunks(destLines, sourceLines).map((h, index) => ({
    index,
    destStartLine: h.oStart + 1,
    destLineCount: h.oLength,
    sourceStartLine: h.sStart + 1,
    sourceLineCount: h.sLength,
    removed: destLines.slice(h.oStart, h.oStart + h.oLength).join(''),
    added: sourceLines.slice(h.sStart, h.sStart + h.sLength).join(''),
    contextBefore: destLines.slice(Math.max(0, h.oStart - 3), h.oStart).join(''),
    contextAfter: destLines.slice(h.oStart + h.oLength, h.oStart + h.oLength + 3).join(''),
  }));
}

export interface BuiltProposal {
  start: Map<string, Hash>;
  tree: Map<string, Hash>;
  destRevision: Hash;
  destLine: LineRecord | null;
  sourceRevisions: Hash[];
  files: ProposedFile[];
  changes: TreeChange[];
  conflicts: { path: string; count: number }[];
  warnings: CombineWarning[];
  ready: boolean;
  summaryParts: string[];
}

async function destinationStart(engine: ProjectEngine, plan: CombinePlan): Promise<{ tree: Map<string, Hash>; revision: Hash; line: LineRecord | null; label: string }> {
  if (plan.destination.kind === 'existing') {
    const line = engine.line(plan.destination.lineId);
    if (line.kind !== 'alternative') throw new StudioError('unsupported', 'Combine into an alternative or a new alternative. To change the Shared version, edit it directly.');
    if (line.pending) throw new StudioError('conflicts-pending', `Resolve ${line.name}’s shared-change conflicts before combining into it.`);
    return { tree: new Map(await engine.treeOfRevision(line.head)), revision: line.head, line, label: line.name };
  }
  const info = await refInfo(engine, plan.destination.base);
  if (!info.revision) throw new StudioError('unsupported', 'A new combined alternative must start from a saved version.');
  return { tree: new Map(info.tree), revision: info.revision, line: null, label: plan.destination.name };
}

export async function buildProposal(engine: ProjectEngine, adapter: ProjectAdapter, plan: CombinePlan): Promise<BuiltProposal> {
  const dest = await destinationStart(engine, plan);
  const tree = new Map(dest.tree);
  const warnings: CombineWarning[] = [];
  const conflicts: { path: string; count: number }[] = [];
  const origins = new Map<string, string>();
  const sourceRevisions = new Set<Hash>();
  const summaryParts: string[] = [];
  const refCache = new Map<string, RefInfo>();
  const getRef = async (ref: ContentRef): Promise<RefInfo> => {
    const key = JSON.stringify(ref);
    let info = refCache.get(key);
    if (!info) {
      info = await refInfo(engine, ref);
      refCache.set(key, info);
    }
    return info;
  };

  // 1. File-level actions
  for (const [rawPath, action] of Object.entries(plan.files).sort(([a], [b]) => comparePaths(a, b))) {
    const path = normalizeProjectPath(rawPath);
    if (action.kind === 'keep') continue;
    const source = await getRef(action.source);
    if (source.revision) sourceRevisions.add(source.revision);
    const sourceHash = source.tree.get(path);
    const destHash = tree.get(path);
    await applyFileAction(engine, { path, action, source, sourceHash, destHash, destRevision: dest.revision, tree, origins, conflicts, warnings, summaryParts });
  }

  // 2. HTML sections
  if (plan.sections.length > 0 && !adapter.structural) {
    warnings.push({ severity: 'blocking', kind: 'ambiguous', message: 'This project type does not support section combining.' });
  }
  for (const step of plan.sections) {
    if (!adapter.structural) break;
    const source = await getRef(step.source);
    if (source.revision) sourceRevisions.add(source.revision);
    try {
      const out = await adapter.structural.transplant(
        treeReader(engine, source.tree, source.label),
        treeReader(engine, tree, dest.label),
        { ...step, sourcePath: normalizeProjectPath(step.sourcePath), destPath: normalizeProjectPath(step.destPath) },
      );
      for (const [path, text] of out.files) {
        tree.set(normalizeProjectPath(path), await engine.objects.putBlob(text));
        origins.set(path, origins.has(path) ? `${origins.get(path)}; section from ${source.label}` : `Section from ${source.label}`);
      }
      for (const asset of out.copyAssets) {
        const path = normalizeProjectPath(asset);
        const hash = source.tree.get(path);
        if (hash) {
          tree.set(path, hash);
          origins.set(path, `Asset copied from ${source.label}`);
        }
      }
      warnings.push(...out.warnings);
      summaryParts.push(`${step.sectionKey.replace(/^#/, '')} section from ${source.label}`);
    } catch (error) {
      warnings.push({ severity: 'blocking', kind: 'ambiguous', message: (error as Error).message });
    }
  }

  // 3. Manual edits of the proposed result
  for (const [rawPath, text] of Object.entries(plan.edits)) {
    const path = normalizeProjectPath(rawPath);
    tree.set(path, await engine.objects.putBlob(text));
    origins.set(path, 'Edited by you');
    const index = conflicts.findIndex((c) => c.path === path);
    if (index >= 0) conflicts.splice(index, 1);
  }
  if (Object.keys(plan.edits).length > 0) summaryParts.push(`manual edits to ${Object.keys(plan.edits).length === 1 ? Object.keys(plan.edits)[0] : `${Object.keys(plan.edits).length} files`}`);

  // 4. What the picked parts rely on, and which stories the result makes worth checking again.
  const sources: DependencySource[] = [];
  for (const [key, info] of refCache) sources.push({ ref: JSON.parse(key) as ContentRef, label: info.label, tree: info.tree });
  warnings.push(...(await dependencyWarnings(engine, { start: dest.tree, tree, sources, destLabel: dest.label })));

  const changes = diffTrees(dest.tree, tree);
  const files: ProposedFile[] = [];
  for (const c of changes) {
    files.push({
      path: c.path,
      status: c.status,
      kind: (await isTextHashes(engine, c.path, [tree.get(c.path), dest.tree.get(c.path)])) ? 'text' : 'binary',
      origin: origins.get(c.path) ?? 'Changed',
      hasConflicts: conflicts.some((x) => x.path === c.path),
    });
  }
  for (const conflict of conflicts) {
    if (!files.some((f) => f.path === conflict.path)) {
      files.push({ path: conflict.path, status: 'modified', kind: 'text', origin: origins.get(conflict.path) ?? 'Merge', hasConflicts: true });
    }
  }
  const ready = conflicts.length === 0 && !warnings.some((w) => w.severity === 'blocking') && (changes.length > 0 || plan.destination.kind === 'new');
  return {
    start: dest.tree,
    tree,
    destRevision: dest.revision,
    destLine: dest.line,
    sourceRevisions: [...sourceRevisions].filter((r) => r !== dest.revision),
    files,
    changes,
    conflicts,
    warnings,
    ready,
    summaryParts,
  };
}

async function applyFileAction(
  engine: ProjectEngine,
  ctx: {
    path: string;
    action: Exclude<FileAction, { kind: 'keep' }>;
    source: RefInfo;
    sourceHash: Hash | undefined;
    destHash: Hash | undefined;
    destRevision: Hash;
    tree: Map<string, Hash>;
    origins: Map<string, string>;
    conflicts: { path: string; count: number }[];
    warnings: CombineWarning[];
    summaryParts: string[];
  },
): Promise<void> {
  const { path, action, source, sourceHash, destHash, tree, origins } = ctx;
  if (action.kind === 'take') {
    if (sourceHash) tree.set(path, sourceHash);
    else tree.delete(path);
    origins.set(path, sourceHash ? `Taken from ${source.label}` : `Removed (as in ${source.label})`);
    ctx.summaryParts.push(`${path} from ${source.label}`);
    return;
  }
  if (action.kind === 'timeline') {
    await takeTimelineParts(engine, ctx, action);
    return;
  }
  if (action.kind === 'hunks') {
    if (isSequencePath(path)) {
      ctx.warnings.push({ severity: 'blocking', kind: 'ambiguous', path, message: `${path} is a timeline. Pick its tracks or clips (or merge it) instead of lines of text.` });
      return;
    }
    if (!(await isTextHashes(engine, path, [sourceHash, destHash]))) {
      ctx.warnings.push({ severity: 'blocking', kind: 'ambiguous', path, message: `${path} is not a text file, so individual changes can’t be picked. Take the whole file instead.` });
      return;
    }
    const destLines = splitLines(await textOf(engine, destHash));
    const sourceLines = splitLines(await textOf(engine, sourceHash));
    const hunks = lineHunks(destLines, sourceLines);
    const chosen = new Set(action.hunks.filter((i) => i >= 0 && i < hunks.length));
    if (chosen.size !== action.hunks.length) {
      ctx.warnings.push({ severity: 'warning', kind: 'conflict', path, message: `Some selected changes in ${path} no longer exist and were skipped.` });
    }
    const out: string[] = [];
    let pos = 0;
    hunks.forEach((h, i) => {
      out.push(...destLines.slice(pos, h.oStart));
      out.push(...(chosen.has(i) ? sourceLines.slice(h.sStart, h.sStart + h.sLength) : destLines.slice(h.oStart, h.oStart + h.oLength)));
      pos = h.oStart + h.oLength;
    });
    out.push(...destLines.slice(pos));
    if (chosen.size === 0) return;
    tree.set(path, await engine.objects.putBlob(out.join('')));
    origins.set(path, `${chosen.size} of ${hunks.length} ${hunks.length === 1 ? 'change' : 'changes'} from ${source.label}`);
    ctx.summaryParts.push(`${chosen.size} ${chosen.size === 1 ? 'change' : 'changes'} in ${path} from ${source.label}`);
    return;
  }

  // Three-way merge against the common revision of destination and source.
  const common = source.revision ? await engine.commonAncestor(ctx.destRevision, source.revision) : null;
  const baseTree = common ? await engine.treeOfRevision(common) : new Map<string, Hash>();
  const baseHash = baseTree.get(path);
  if (sourceHash === destHash) return;
  if (baseHash === sourceHash) {
    origins.set(path, `Unchanged in ${source.label} since you diverged — kept`);
    return;
  }
  if (baseHash === destHash) {
    if (sourceHash) tree.set(path, sourceHash);
    else tree.delete(path);
    origins.set(path, `Merged from ${source.label}`);
    ctx.summaryParts.push(`${path} merged from ${source.label}`);
    return;
  }
  if (sourceHash && destHash && isSequencePath(path)) {
    // Timelines merge by clips and tracks, with their own conflict decisions.
    const read = async (h: Hash | undefined): Promise<Sequence | null> => (h ? parseSequence(await textOf(engine, h)) : null);
    const merged = mergeSequences(await read(baseHash), (await read(destHash))!, (await read(sourceHash))!, action.timelineChoices ?? {});
    const open = merged.conflicts.filter((c) => !action.timelineChoices?.[c.key]);
    if (open.length) {
      ctx.conflicts.push({ path, count: open.length });
      origins.set(path, `Merging timeline with ${source.label} (${open.length} decision${open.length === 1 ? '' : 's'} needed)`);
      return;
    }
    tree.set(path, await engine.objects.putBlob(serializeSequence(merged.sequence)));
    origins.set(path, `Timeline merged with ${source.label}${merged.conflicts.length ? ` (${merged.conflicts.length} decided)` : ''}`);
    ctx.summaryParts.push(`${merged.sequence.name} merged with ${source.label}`);
    return;
  }
  if (sourceHash && destHash && (isObjectPath(path) || isStoryPath(path))) {
    // Living objects merge by property and stories by step, never by lines of JSON.
    const [b, d, s] = [baseHash ? await textOf(engine, baseHash) : null, await textOf(engine, destHash), await textOf(engine, sourceHash)];
    const merged = isObjectPath(path) ? mergeObjectTexts(b, d, s) : mergeStoryTexts(b, d, s);
    if (merged !== null) {
      tree.set(path, await engine.objects.putBlob(merged));
      origins.set(path, `${isObjectPath(path) ? 'Object properties' : 'Story steps'} merged with ${source.label}`);
      ctx.summaryParts.push(`${path} merged with ${source.label}`);
      return;
    }
    ctx.conflicts.push({ path, count: 1 });
    ctx.warnings.push({ severity: 'warning', kind: 'conflict', path, message: `${path} has the same ${isObjectPath(path) ? 'property' : 'step'} changed differently on both sides. Take one version instead.` });
    return;
  }
  if (!sourceHash || !destHash || !(await isTextHashes(engine, path, [baseHash, sourceHash, destHash]))) {
    ctx.conflicts.push({ path, count: 1 });
    ctx.warnings.push({ severity: 'warning', kind: 'conflict', path, message: `${path} changed on both sides and can’t be merged line by line. Take one version instead.` });
    return;
  }
  const chunks = diff3Lines(splitLines(await textOf(engine, baseHash)), splitLines(await textOf(engine, destHash)), splitLines(await textOf(engine, sourceHash)));
  const conflictCount = chunks.filter((c) => c.kind === 'conflict').length;
  const text = applyResolutions(chunks, action.resolutions ?? {});
  if (text === null) {
    ctx.conflicts.push({ path, count: conflictCount - Object.keys(action.resolutions ?? {}).length });
    origins.set(path, `Merging with ${source.label} (needs decisions)`);
    return;
  }
  tree.set(path, await engine.objects.putBlob(text));
  origins.set(path, conflictCount > 0 ? `Merged with ${source.label} (${conflictCount} resolved)` : `Merged with ${source.label}`);
  ctx.summaryParts.push(`${path} merged with ${source.label}`);
}

/** Merge chunks for a file in a combine plan (for the conflict editor). */
export async function combineMergeChunks(engine: ProjectEngine, plan: CombinePlan, rawPath: string, source: ContentRef) {
  const path = normalizeProjectPath(rawPath);
  const dest = await destinationStart(engine, plan);
  const s = await refInfo(engine, source);
  const common = s.revision ? await engine.commonAncestor(dest.revision, s.revision) : null;
  const baseTree = common ? await engine.treeOfRevision(common) : new Map<string, Hash>();
  return diff3Lines(
    splitLines(await textOf(engine, baseTree.get(path))),
    splitLines(await textOf(engine, dest.tree.get(path))),
    splitLines(await textOf(engine, s.tree.get(path))),
  );
}

export interface AppliedCombination {
  operation: OperationRecord;
  checkpointId: string;
  lineId: string;
  createdLine: boolean;
  changes: TreeChange[];
  summary: string;
}

export function summarize(destName: string, parts: string[], created: boolean, description: string): string {
  const head = created ? `Created ${destName}` : `Combined into ${destName}`;
  const body = parts.length > 0 ? `: ${parts.slice(0, 4).join('; ')}${parts.length > 4 ? `; and ${parts.length - 4} more` : ''}` : '';
  const note = description.trim() ? ` — ${description.trim()}` : '';
  return `${head}${body}${note}`;
}

/** Apply a combination atomically, with a checkpoint taken first. */
export async function applyCombination(engine: ProjectEngine, adapter: ProjectAdapter, plan: CombinePlan): Promise<AppliedCombination> {
  return engine.run(async () => {
    const built = await buildProposal(engine, adapter, plan);
    if (!built.ready) {
      const reason =
        built.conflicts.length > 0
          ? 'Resolve every conflict in the proposal first.'
          : built.warnings.find((w) => w.severity === 'blocking')?.message ?? 'There is nothing to combine yet.';
      throw new StudioError('combine-not-ready', reason);
    }
    const destName = plan.destination.kind === 'existing' ? engine.line(plan.destination.lineId).name : plan.destination.name;
    const summary = summarize(destName, built.summaryParts, plan.destination.kind === 'new', plan.description);
    const checkpoint = engine.checkpointRecord(engine.data, `Before combining into ${destName}`, 'Created automatically so this combination can be reversed.', true, 'before-combine');

    if (plan.destination.kind === 'existing') {
      const line = built.destLine!;
      const rev = await engine.makeRevision({
        tree: built.tree,
        parents: [line.head, ...built.sourceRevisions],
        line: line.id,
        kind: 'combine',
        message: summary,
        compareTo: built.start,
      });
      const operation = engine.operationRecord({
        kind: 'combine',
        summary,
        lineId: line.id,
        lineIds: [line.id],
        checkpointId: checkpoint.id,
        before: line.head,
        beforeIncorporated: line.incorporatedShared,
        after: rev.id,
        createdLine: false,
      });
      const mutations: Mutation[] = [
        (m) => {
          m.checkpoints.push(checkpoint);
          const l = m.lines[line.id]!;
          l.head = rev.id;
          l.updatedAt = new Date().toISOString();
          m.operations.push(operation);
          for (const r of built.sourceRevisions) if (!m.pins.includes(r)) m.pins.push(r);
        },
      ];
      await engine.commit(mutations);
      return { operation, checkpointId: checkpoint.id, lineId: line.id, createdLine: false, changes: built.changes, summary };
    }

    const destination = plan.destination;
    let incorporated: Hash;
    if (destination.base.kind === 'line') {
      const base = engine.line(destination.base.lineId);
      incorporated = base.kind === 'shared' ? base.head : base.incorporatedShared;
    } else if (destination.base.kind === 'checkpoint') {
      const entry = engine.checkpoint(destination.base.checkpointId).lines[destination.base.lineId];
      if (!entry) throw new StudioError('not-found', 'That checkpoint version could not be found.');
      incorporated = entry.kind === 'shared' ? entry.revision : entry.incorporatedShared;
    } else {
      incorporated = engine.line(SHARED_LINE_ID).head;
    }
    const holder: { operation: OperationRecord | null } = { operation: null };
    const { record } = await engine.createAlternativeFromTree({
      tree: built.tree,
      parents: [built.destRevision, ...built.sourceRevisions],
      name: destination.name,
      color: destination.color,
      description: destination.description,
      following: destination.following,
      incorporatedShared: incorporated,
      message: summary,
      createdFrom: {
        kind: 'combine',
        lineId: destination.base.kind === 'line' || destination.base.kind === 'checkpoint' ? destination.base.lineId : undefined,
        lineName: refLabel(engine, destination.base),
        checkpointId: destination.base.kind === 'checkpoint' ? destination.base.checkpointId : undefined,
        revisionId: built.destRevision,
      },
      extraMutations: (rec, rev) => {
        const op = engine.operationRecord({
          kind: 'combine',
          summary,
          lineId: rec.id,
          lineIds: [rec.id],
          checkpointId: checkpoint.id,
          before: null,
          beforeIncorporated: null,
          after: rev.id,
          createdLine: true,
        });
        holder.operation = op;
        return [
          (m) => {
            m.checkpoints.push(checkpoint);
            m.operations.push(op);
          },
        ];
      },
    });
    return {
      operation: holder.operation!,
      checkpointId: checkpoint.id,
      lineId: record.id,
      createdLine: true,
      changes: diffTrees(built.start, built.tree),
      summary,
    };
  });
}

/**
 * Take whole tracks and single clips from another version's timeline. Clips keep their times; a
 * clip that would overlap the destination's clips goes onto a new track instead of moving.
 */
async function takeTimelineParts(
  engine: ProjectEngine,
  ctx: { path: string; source: RefInfo; sourceHash: Hash | undefined; destHash: Hash | undefined; tree: Map<string, Hash>; origins: Map<string, string>; warnings: CombineWarning[]; summaryParts: string[] },
  action: { tracks: string[]; clips: string[] },
): Promise<void> {
  const { path, source } = ctx;
  if (!isSequencePath(path) || !ctx.sourceHash) {
    ctx.warnings.push({ severity: 'blocking', kind: 'ambiguous', path, message: `${path} is not a timeline in ${source.label}.` });
    return;
  }
  const from = parseSequence(await textOf(engine, ctx.sourceHash));
  const dest: Sequence = ctx.destHash ? parseSequence(await textOf(engine, ctx.destHash)) : { ...structuredClone(from), tracks: from.tracks.map((t) => ({ ...t, clips: [] })) };
  let moved = 0;
  const fits = (track: Track, start: number, end: number, except: string): boolean => track.clips.every((c) => c.id === except || clipEnd(c) <= start || c.start >= end);
  const ensureTrack = (src: Track): Track => {
    let t = dest.tracks.find((x) => x.id === src.id);
    if (!t) {
      t = { ...structuredClone(src), clips: [] };
      const at = from.tracks.findIndex((x) => x.id === src.id);
      const before = from.tracks.slice(0, at).reverse().find((x) => dest.tracks.some((d) => d.id === x.id));
      dest.tracks.splice(before ? dest.tracks.findIndex((d) => d.id === before.id) + 1 : dest.tracks.length, 0, t);
    }
    return t;
  };
  const place = (clipId: string): void => {
    const srcTrack = from.tracks.find((t) => t.clips.some((c) => c.id === clipId));
    const clip = srcTrack?.clips.find((c) => c.id === clipId);
    if (!srcTrack || !clip) {
      ctx.warnings.push({ severity: 'warning', kind: 'conflict', path, message: `A chosen clip no longer exists in ${source.label} and was skipped.` });
      return;
    }
    for (const t of dest.tracks) t.clips = t.clips.filter((c) => c.id !== clipId);
    let target = ensureTrack(srcTrack);
    if (!fits(target, clip.start, clipEnd(clip), clip.id)) {
      const id = `${srcTrack.id}-from`.slice(0, 60);
      let extra = dest.tracks.find((t) => t.id === id);
      if (!extra) {
        extra = { ...structuredClone(srcTrack), id, name: `${srcTrack.name} (${source.label})`.slice(0, 60), clips: [] };
        dest.tracks.splice(dest.tracks.indexOf(target) + 1, 0, extra);
      }
      if (!fits(extra, clip.start, clipEnd(clip), clip.id)) {
        ctx.warnings.push({ severity: 'blocking', kind: 'conflict', path, message: `“${clip.type === 'text' ? clip.text.slice(0, 40) : clip.id}” overlaps other clips here and on ${extra.name}. Take fewer clips at that time.` });
        return;
      }
      target = extra;
      moved++;
    }
    target.clips.push(structuredClone(clip));
    target.clips.sort((a, b) => a.start - b.start);
  };
  for (const tid of action.tracks) {
    const src = from.tracks.find((t) => t.id === tid);
    if (!src) continue;
    const t = ensureTrack(src);
    Object.assign(t, { name: src.name, muted: src.muted, hidden: src.hidden, locked: src.locked, volume: src.volume });
    for (const d of dest.tracks) d.clips = d.clips.filter((c) => !src.clips.some((s) => s.id === c.id));
    t.clips = [];
    for (const c of src.clips) place(c.id);
  }
  for (const cid of action.clips) if (!action.tracks.some((tid) => from.tracks.find((t) => t.id === tid)?.clips.some((c) => c.id === cid))) place(cid);
  ctx.tree.set(path, await engine.objects.putBlob(serializeSequence(dest)));
  const parts = [action.tracks.length ? `${action.tracks.length} track${action.tracks.length === 1 ? '' : 's'}` : '', action.clips.length ? `${action.clips.length} clip${action.clips.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  ctx.origins.set(path, `${parts} from ${source.label}${moved ? ` (${moved} on a new track to keep their times)` : ''}`);
  ctx.summaryParts.push(`${parts} of ${from.name} from ${source.label}`);
}

/** Timeline merge details for one file in a combine plan (the timeline conflict editor). */
export async function combineTimeline(engine: ProjectEngine, plan: CombinePlan, rawPath: string, source: ContentRef, assetName: (id: string) => string) {
  const path = normalizeProjectPath(rawPath);
  const dest = await destinationStart(engine, plan);
  const s = await refInfo(engine, source);
  const common = s.revision ? await engine.commonAncestor(dest.revision, s.revision) : null;
  const baseTree = common ? await engine.treeOfRevision(common) : new Map<string, Hash>();
  const read = async (h: Hash | undefined): Promise<Sequence | null> => (h ? parseSequence(await textOf(engine, h)) : null);
  const [b, d, src] = await Promise.all([read(baseTree.get(path)), read(dest.tree.get(path)), read(s.tree.get(path))]);
  if (!src) throw new StudioError('not-found', `${path} does not exist in ${s.label}.`);
  const action = plan.files[path];
  const choices = action?.kind === 'merge' ? (action.timelineChoices ?? {}) : {};
  const merged = d ? mergeSequences(b, d, src, choices, { asset: assetName, ours: dest.label, theirs: s.label }) : { conflicts: [], taken: [] };
  const destClips = new Map(d?.tracks.flatMap((t) => t.clips.map((c) => [c.id, JSON.stringify(c)] as const)) ?? []);
  return {
    items: merged.conflicts.map((c) => ({ ...c, choice: choices[c.key] ?? null })),
    taken: merged.taken,
    source: {
      tracks: src.tracks.map((t) => ({ id: t.id, name: t.name, kind: t.kind, clips: t.clips.length })),
      clips: src.tracks.flatMap((t) => t.clips.map((c) => ({ id: c.id, label: c.type === 'text' ? `Title “${c.text.slice(0, 40)}”` : assetName(c.assetId), trackId: t.id, start: c.start / 240000, end: clipEnd(c) / 240000, changed: destClips.get(c.id) !== JSON.stringify(c) }))),
    },
    d,
    src,
  };
}
