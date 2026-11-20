/**
 * Three-way merge of whole project trees (path → content hash), including additions,
 * deletions, binary files and modify/delete conflicts.
 */
import { mergeText } from './diff3';
import { isTextFile } from './text';
import { mergeSequences } from '../../video/merge';
import { parseSequence, serializeSequence } from '../../video/sequence';
import type { Hash } from '../store/objects';
import { comparePaths } from '../../shared/paths';
import { canonicalizePage, canonicalizeSequence, isObjectPath, mergeObjectTexts, readObjects, renderPlacements } from '../../objects/merge';
import type { LivingObject } from '../../shared/objects';
import { isStoryPath, mergeStoryTexts } from '../../stories/merge';

export interface BlobAccess {
  getBlob(hash: Hash): Promise<Buffer>;
  putBlob(data: string | Uint8Array): Promise<Hash>;
}

export type TreeConflictType = 'text' | 'binary' | 'modify-delete' | 'timeline';

/** Sequence files are timelines: they merge by clips and tracks, never by lines of JSON. */
export const isSequencePath = (path: string): boolean => /^sequences\/[^/]+\.mvseq\.json$/.test(path);

export interface TreeConflict {
  path: string;
  type: TreeConflictType;
  base: Hash | null;
  ours: Hash | null;
  theirs: Hash | null;
  deletedBy: 'ours' | 'theirs' | null;
  conflictCount: number;
  /** Timelines: keys of the decisions needed. */
  items?: string[];
}

export interface TreeChange {
  path: string;
  status: 'added' | 'deleted' | 'modified';
}

export interface TreeMergeResult {
  /** Merged tree. Conflicted paths keep the "ours" version (or stay absent if ours deleted them). */
  tree: Map<string, Hash>;
  conflicts: TreeConflict[];
  /** Paths whose content in `tree` differs from `ours`. */
  applied: TreeChange[];
}

export function diffTrees(from: ReadonlyMap<string, Hash>, to: ReadonlyMap<string, Hash>): TreeChange[] {
  const out: TreeChange[] = [];
  for (const [path, hash] of to) {
    const before = from.get(path);
    if (before === undefined) out.push({ path, status: 'added' });
    else if (before !== hash) out.push({ path, status: 'modified' });
  }
  for (const path of from.keys()) if (!to.has(path)) out.push({ path, status: 'deleted' });
  return out.sort((a, b) => comparePaths(a.path, b.path));
}

export function treesEqual(a: ReadonlyMap<string, Hash>, b: ReadonlyMap<string, Hash>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, hash] of a) if (b.get(path) !== hash) return false;
  return true;
}

async function isText(blobs: BlobAccess, path: string, hashes: (Hash | null)[]): Promise<boolean> {
  for (const hash of hashes) {
    if (!hash) continue;
    const data = await blobs.getBlob(hash);
    if (!isTextFile(path, data)) return false;
  }
  return true;
}

export async function mergeTrees(
  base: ReadonlyMap<string, Hash>,
  ours: ReadonlyMap<string, Hash>,
  theirs: ReadonlyMap<string, Hash>,
  blobs: BlobAccess,
): Promise<TreeMergeResult> {
  const result = new Map(ours);
  const conflicts: TreeConflict[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  // Living objects: placements are derived from objects, so they are merged as stubs and rendered after.
  const hasObjects = [...paths].some(isObjectPath);
  const objectsOf = async (tree: ReadonlyMap<string, Hash>): Promise<Map<string, LivingObject>> => {
    const texts = new Map<string, string>();
    for (const [p, h] of tree) if (isObjectPath(p)) texts.set(p, (await blobs.getBlob(h)).toString('utf8'));
    return readObjects(texts);
  };
  const sides = hasObjects ? await Promise.all([objectsOf(base), objectsOf(ours), objectsOf(theirs)]) : null;

  for (const path of [...paths].sort(comparePaths)) {
    const b = base.get(path) ?? null;
    const o = ours.get(path) ?? null;
    const t = theirs.get(path) ?? null;

    if (o === t) continue; // identical on both sides (including both deleted)
    if (b === o) {
      // Only the incoming side changed this path.
      if (t === null) result.delete(path);
      else result.set(path, t);
      continue;
    }
    if (b === t) continue; // only our side changed it — keep ours

    // Both sides changed the path in different ways.
    if (o === null || t === null) {
      conflicts.push({
        path,
        type: 'modify-delete',
        base: b,
        ours: o,
        theirs: t,
        deletedBy: o === null ? 'ours' : 'theirs',
        conflictCount: 1,
      });
      continue;
    }

    if (isObjectPath(path) || isStoryPath(path)) {
      const [bText, oText, tText] = await Promise.all([b ? blobs.getBlob(b).then((x) => x.toString('utf8')) : Promise.resolve(null), blobs.getBlob(o).then((x) => x.toString('utf8')), blobs.getBlob(t).then((x) => x.toString('utf8'))]);
      const merged = isObjectPath(path) ? mergeObjectTexts(bText, oText, tText) : mergeStoryTexts(bText, oText, tText);
      if (merged !== null) result.set(path, await blobs.putBlob(merged));
      else conflicts.push({ path, type: 'binary', base: b, ours: o, theirs: t, deletedBy: null, conflictCount: 1 });
      continue;
    }

    if (isSequencePath(path)) {
      const read = async (h: Hash | null, i: number) => (h ? (sides ? canonicalizeSequence(parseSequence((await blobs.getBlob(h)).toString('utf8')), sides[i]!) : parseSequence((await blobs.getBlob(h)).toString('utf8'))) : null);
      let seqs: Awaited<ReturnType<typeof read>>[] | null = null;
      try {
        seqs = await Promise.all([read(b, 0), read(o, 1), read(t, 2)]);
      } catch {
        seqs = null;
      }
      if (!seqs) {
        // A sequence file that cannot be read is chosen as a whole, never merged as text.
        conflicts.push({ path, type: 'binary', base: b, ours: o, theirs: t, deletedBy: null, conflictCount: 1 });
        continue;
      }
      const merged = mergeSequences(seqs[0]!, seqs[1]!, seqs[2]!);
      if (merged.conflicts.length === 0) result.set(path, await blobs.putBlob(serializeSequence(merged.sequence)));
      else conflicts.push({ path, type: 'timeline', base: b, ours: o, theirs: t, deletedBy: null, conflictCount: merged.conflicts.length, items: merged.conflicts.map((c) => c.key) });
      continue;
    }

    if (await isText(blobs, path, [b, o, t])) {
      const [bText, oText, tText] = await Promise.all([
        b ? blobs.getBlob(b).then((x) => x.toString('utf8')) : Promise.resolve(''),
        blobs.getBlob(o).then((x) => x.toString('utf8')),
        blobs.getBlob(t).then((x) => x.toString('utf8')),
      ]);
      const canon = (text: string, i: number): string => (sides && text.includes('data-mv-object=') ? canonicalizePage(text, sides[i]!) : text);
      const merged = sides ? mergeText(canon(bText, 0), canon(oText, 1), canon(tText, 2)) : mergeText(bText, oText, tText);
      if (merged.clean && merged.text !== null) {
        result.set(path, await blobs.putBlob(merged.text));
      } else {
        conflicts.push({ path, type: 'text', base: b, ours: o, theirs: t, deletedBy: null, conflictCount: merged.conflictCount });
      }
    } else {
      conflicts.push({ path, type: 'binary', base: b, ours: o, theirs: t, deletedBy: null, conflictCount: 1 });
    }
  }

  if (hasObjects) {
    // Render placements again from the merged objects (stubs, and placements of objects that changed).
    const mergedObjects = await objectsOf(result);
    const conflicted = new Set(conflicts.map((c) => c.path));
    for (const [path, hash] of [...result]) {
      if (conflicted.has(path) || !(/\.html?$/i.test(path) || isSequencePath(path))) continue;
      const text = (await blobs.getBlob(hash)).toString('utf8');
      if (!text.includes('data-mv-object=') && !text.includes('"object"')) continue;
      const rendered = renderPlacements(path, text, mergedObjects);
      if (rendered !== null) result.set(path, await blobs.putBlob(rendered));
    }
  }

  return { tree: result, conflicts, applied: diffTrees(ours, result) };
}
