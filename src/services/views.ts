/** Build the JSON view models the renderer sees from engine state. */
import type { ProjectEngine } from '../engine/project';
import type { LineRecord } from '../engine/store/records';
import { diffTrees } from '../engine/merge/treeMerge';
import { SHARED_LINE_ID, type CheckpointView, type LineView, type OperationView, type ProjectView } from '../shared/types';

export async function buildLineView(engine: ProjectEngine, line: LineRecord): Promise<LineView> {
  const sharedHead = engine.shared.head;
  const tree = await engine.effectiveTree(line.id);
  let differsFromShared = 0;
  let draftFiles: string[] = [];
  if (line.kind === 'alternative') {
    differsFromShared = diffTrees(await engine.treeOfRevision(line.incorporatedShared), tree).length;
  } else if (line.draftTree) {
    draftFiles = diffTrees(await engine.treeOfRevision(line.head), tree).map((c) => c.path);
  }
  const pending = line.pending;
  let conflictCount = 0;
  if (pending) for (const record of Object.values(pending.files)) conflictCount += engine.unresolvedCount(record);
  const status: LineView['status'] =
    line.kind === 'shared'
      ? 'up-to-date'
      : pending
        ? 'conflicted'
        : !line.following
          ? 'paused'
          : engine.sharedBaseOf(line) !== sharedHead
            ? 'behind'
            : 'up-to-date';
  return {
    id: line.id,
    kind: line.kind,
    name: line.name,
    color: line.color,
    description: line.description,
    following: line.following,
    status,
    conflictCount,
    conflictFiles: pending ? Object.keys(pending.files) : [],
    sharedChangesBehind: line.kind === 'shared' ? 0 : engine.sharedChangesBetween(engine.sharedBaseOf(line), sharedHead),
    hasQueuedSharedChanges: Boolean(pending && pending.to !== sharedHead),
    differsFromShared,
    hasDraft: Boolean(line.draftTree),
    draftFiles,
    head: line.head,
    incorporatedShared: line.incorporatedShared,
    createdAt: line.createdAt,
    updatedAt: line.updatedAt,
    createdFrom: { ...line.createdFrom },
    fileCount: tree.size,
  };
}

export async function buildProjectView(engine: ProjectEngine, meta: { originalPath: string | null }): Promise<ProjectView> {
  const data = engine.data;
  const shared = await buildLineView(engine, engine.shared);
  const alternatives: LineView[] = [];
  for (const line of engine.alternatives()) alternatives.push(await buildLineView(engine, line));
  const checkpoints: CheckpointView[] = data.checkpoints
    .map((cp) => ({
      id: cp.id,
      name: cp.name,
      description: cp.description,
      auto: cp.auto,
      reason: cp.reason,
      createdAt: cp.createdAt,
      lines: Object.entries(cp.lines).map(([lineId, e]) => ({ lineId, name: e.name, color: e.color, kind: e.kind, revisionId: e.revision })),
    }))
    .reverse();
  const operations: OperationView[] = data.operations
    .map((op) => ({
      id: op.id,
      kind: op.kind,
      createdAt: op.createdAt,
      summary: op.summary,
      checkpointId: op.checkpointId,
      lineId: op.lineId,
      undone: op.undone,
      canUndo: engine.canUndo(op),
    }))
    .reverse()
    .slice(0, 50);
  return {
    id: data.id,
    name: data.name,
    storagePath: engine.dir,
    originalPath: meta.originalPath ?? data.source.originalPath,
    sourceKind: data.source.kind,
    templateId: data.source.templateId ?? null,
    adapter: data.adapter,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    shared,
    alternatives,
    checkpoints,
    operations,
    sharedRevisionCount: data.sharedLog.length,
    recoveredFromBackup: engine.recovered,
    migratedFromVersion: engine.migratedFrom,
    kind: data.kind,
  };
}

export { SHARED_LINE_ID };
