import type { ProjectEngine } from './project';
import type { Hash } from './store/objects';
import { lineHunks } from './merge/diff3';
import { isTextFile, splitLines } from './merge/text';
import { comparePaths } from '../shared/paths';
import type { FileComparison } from '../shared/types';

const MAX_DIFF_BYTES = 1_000_000;

export async function compareTrees(engine: ProjectEngine, left: ReadonlyMap<string, Hash>, right: ReadonlyMap<string, Hash>): Promise<FileComparison[]> {
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort(comparePaths);
  const out: FileComparison[] = [];
  for (const path of paths) {
    const l = left.get(path) ?? null;
    const r = right.get(path) ?? null;
    const status = l === r ? 'unchanged' : !l ? 'added' : !r ? 'deleted' : 'modified';
    let kind: FileComparison['kind'] = 'text';
    let linesAdded = 0;
    let linesRemoved = 0;
    const ld = l ? await engine.readBlob(l) : null;
    const rd = r ? await engine.readBlob(r) : null;
    if ((ld && !isTextFile(path, ld)) || (rd && !isTextFile(path, rd))) kind = 'binary';
    if (kind === 'text' && status !== 'unchanged' && (ld?.length ?? 0) <= MAX_DIFF_BYTES && (rd?.length ?? 0) <= MAX_DIFF_BYTES) {
      const a = splitLines(ld ? ld.toString('utf8') : '');
      const b = splitLines(rd ? rd.toString('utf8') : '');
      for (const h of lineHunks(a, b)) {
        linesRemoved += h.oLength;
        linesAdded += h.sLength;
      }
    }
    out.push({ path, status, kind, leftHash: l, rightHash: r, linesAdded, linesRemoved });
  }
  return out;
}
