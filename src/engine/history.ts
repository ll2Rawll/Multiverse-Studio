import type { ProjectEngine } from './project';
import type { RevisionRecord } from './store/records';
import { SHARED_LINE_ID, type HistoryEntry, type LineColor } from '../shared/types';

const TITLES: Record<RevisionRecord['kind'], string> = {
  import: 'Project started',
  edit: 'Edited',
  'shared-save': 'Shared change saved',
  'shared-apply': 'Shared change applied',
  'shared-partial': 'Shared change partly applied',
  resolution: 'Conflicts resolved',
  create: 'Alternative created',
  combine: 'Combination applied',
  restore: 'Restored from a checkpoint',
  reset: 'File reset',
  undo: 'Undone',
};

export async function historyEntries(engine: ProjectEngine, lineId: string | undefined, limit = 400): Promise<HistoryEntry[]> {
  const data = engine.data;
  const lineIds = lineId ? [lineId] : [SHARED_LINE_ID, ...data.order];
  const entries: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (const id of lineIds) {
    const line = data.lines[id];
    if (!line) continue;
    for (const rev of await engine.lineHistory(id, limit)) {
      const key = `${id}:${rev.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: key,
        type: 'revision',
        lineId: id,
        lineName: line.name,
        color: line.color,
        kind: rev.kind,
        title: TITLES[rev.kind],
        detail: rev.message,
        createdAt: rev.createdAt,
        files: rev.changes,
        checkpointId: null,
        revisionId: rev.id,
      });
    }
  }
  for (const cp of data.checkpoints) {
    if (lineId && !cp.lines[lineId]) continue;
    entries.push({
      id: `cp:${cp.id}`,
      type: 'checkpoint',
      lineId: null,
      lineName: cp.auto ? 'Automatic checkpoint' : 'Checkpoint',
      color: 'shared' as LineColor,
      kind: cp.reason,
      title: cp.name,
      detail: cp.description,
      createdAt: cp.createdAt,
      files: [],
      checkpointId: cp.id,
      revisionId: null,
    });
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.type === 'checkpoint' ? 1 : -1));
  return entries.slice(0, limit);
}
