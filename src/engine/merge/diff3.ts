/**
 * Line-based three-way merge (the diff3 algorithm used by GNU diff3, git's xdiff
 * merge and node-diff3), built on jsdiff's Myers implementation.
 *
 * Changes from both sides are aligned against the common base. Regions changed by one
 * side are taken automatically. Regions changed by both sides — overlapping or directly
 * adjacent — are conflicts, unless both sides made the identical change.
 */
import { diffArrays } from 'diff';
import { splitLines } from './text';

export interface LineHunk {
  oStart: number;
  oLength: number;
  sStart: number;
  sLength: number;
}

export type MergeChunk =
  | { kind: 'stable'; lines: string[] }
  | { kind: 'conflict'; base: string[]; ours: string[]; theirs: string[] };

interface SidedHunk extends LineHunk {
  side: 'ours' | 'theirs';
}

interface ChangeLike {
  value: string[];
  added?: boolean;
  removed?: boolean;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Compute the hunks that turn `o` into `s`. Common prefix/suffix are trimmed first for speed. */
export function lineHunks(o: readonly string[], s: readonly string[]): LineHunk[] {
  let prefix = 0;
  const maxPrefix = Math.min(o.length, s.length);
  while (prefix < maxPrefix && o[prefix] === s[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < o.length - prefix &&
    suffix < s.length - prefix &&
    o[o.length - 1 - suffix] === s[s.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oMid = o.slice(prefix, o.length - suffix);
  const sMid = s.slice(prefix, s.length - suffix);
  if (oMid.length === 0 && sMid.length === 0) return [];
  if (oMid.length === 0 || sMid.length === 0) {
    return [{ oStart: prefix, oLength: oMid.length, sStart: prefix, sLength: sMid.length }];
  }

  let changes: ChangeLike[] | undefined;
  try {
    changes = diffArrays(oMid, sMid, { timeout: 4000 } as never) as unknown as ChangeLike[] | undefined;
  } catch {
    changes = undefined;
  }
  if (!changes) {
    // The diff gave up (pathologically different inputs): treat the middle as one change.
    return [{ oStart: prefix, oLength: oMid.length, sStart: prefix, sLength: sMid.length }];
  }

  const hunks: LineHunk[] = [];
  let oi = prefix;
  let si = prefix;
  let current: LineHunk | null = null;
  for (const change of changes) {
    const n = change.value.length;
    if (change.added) {
      current ??= { oStart: oi, oLength: 0, sStart: si, sLength: 0 };
      current.sLength += n;
      si += n;
    } else if (change.removed) {
      current ??= { oStart: oi, oLength: 0, sStart: si, sLength: 0 };
      current.oLength += n;
      oi += n;
    } else {
      if (current) {
        hunks.push(current);
        current = null;
      }
      oi += n;
      si += n;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function sideRange(
  hunks: SidedHunk[],
  regionStart: number,
  regionEnd: number,
): { start: number; end: number } {
  let sMin = Number.POSITIVE_INFINITY;
  let sMax = Number.NEGATIVE_INFINITY;
  let oMin = Number.POSITIVE_INFINITY;
  let oMax = Number.NEGATIVE_INFINITY;
  for (const h of hunks) {
    sMin = Math.min(sMin, h.sStart);
    sMax = Math.max(sMax, h.sStart + h.sLength);
    oMin = Math.min(oMin, h.oStart);
    oMax = Math.max(oMax, h.oStart + h.oLength);
  }
  return { start: sMin + (regionStart - oMin), end: sMax + (regionEnd - oMax) };
}

/** Three-way merge of line arrays. */
export function diff3Lines(base: readonly string[], ours: readonly string[], theirs: readonly string[]): MergeChunk[] {
  const hunks: SidedHunk[] = [
    ...lineHunks(base, ours).map((h) => ({ ...h, side: 'ours' as const })),
    ...lineHunks(base, theirs).map((h) => ({ ...h, side: 'theirs' as const })),
  ];
  hunks.sort((a, b) => a.oStart - b.oStart || (a.side === b.side ? 0 : a.side === 'ours' ? -1 : 1));

  const chunks: MergeChunk[] = [];
  const pushStable = (lines: readonly string[]): void => {
    if (lines.length === 0) return;
    const last = chunks[chunks.length - 1];
    if (last && last.kind === 'stable') last.lines.push(...lines);
    else chunks.push({ kind: 'stable', lines: [...lines] });
  };

  let oPos = 0;
  let i = 0;
  while (i < hunks.length) {
    const first = hunks[i]!;
    const regionStart = first.oStart;
    let regionEnd = first.oStart + first.oLength;
    const group: SidedHunk[] = [first];
    while (i + 1 < hunks.length && hunks[i + 1]!.oStart <= regionEnd) {
      const next = hunks[i + 1]!;
      regionEnd = Math.max(regionEnd, next.oStart + next.oLength);
      group.push(next);
      i++;
    }
    i++;

    if (regionStart > oPos) pushStable(base.slice(oPos, regionStart));

    const oursHunks = group.filter((h) => h.side === 'ours');
    const theirsHunks = group.filter((h) => h.side === 'theirs');

    if (oursHunks.length === 0 || theirsHunks.length === 0) {
      const side = oursHunks.length > 0 ? 'ours' : 'theirs';
      const source = side === 'ours' ? ours : theirs;
      const range = sideRange(side === 'ours' ? oursHunks : theirsHunks, regionStart, regionEnd);
      pushStable(source.slice(range.start, range.end));
    } else {
      const o = sideRange(oursHunks, regionStart, regionEnd);
      const t = sideRange(theirsHunks, regionStart, regionEnd);
      const oursContent = ours.slice(o.start, o.end);
      const theirsContent = theirs.slice(t.start, t.end);
      if (arraysEqual(oursContent, theirsContent)) {
        pushStable(oursContent);
      } else {
        chunks.push({
          kind: 'conflict',
          base: base.slice(regionStart, regionEnd),
          ours: oursContent,
          theirs: theirsContent,
        });
      }
    }
    oPos = regionEnd;
  }
  if (oPos < base.length) pushStable(base.slice(oPos));
  return chunks;
}

export interface TextMergeResult {
  clean: boolean;
  text: string | null;
  chunks: MergeChunk[];
  conflictCount: number;
}

export function mergeText(base: string, ours: string, theirs: string): TextMergeResult {
  if (ours === theirs) return { clean: true, text: ours, chunks: [{ kind: 'stable', lines: splitLines(ours) }], conflictCount: 0 };
  if (base === ours) return { clean: true, text: theirs, chunks: [{ kind: 'stable', lines: splitLines(theirs) }], conflictCount: 0 };
  if (base === theirs) return { clean: true, text: ours, chunks: [{ kind: 'stable', lines: splitLines(ours) }], conflictCount: 0 };
  const chunks = diff3Lines(splitLines(base), splitLines(ours), splitLines(theirs));
  const conflictCount = chunks.filter((c) => c.kind === 'conflict').length;
  if (conflictCount > 0) return { clean: false, text: null, chunks, conflictCount };
  return { clean: true, text: chunks.map((c) => (c.kind === 'stable' ? c.lines.join('') : '')).join(''), chunks, conflictCount };
}

export type ResolutionChoice = 'ours' | 'theirs' | 'ours-then-theirs' | 'theirs-then-ours' | 'custom';

export interface ChunkResolutionInput {
  choice: ResolutionChoice;
  text?: string;
}

function ensureTrailingNewline(lines: string[]): string {
  const text = lines.join('');
  if (text.length === 0 || /[\r\n]$/.test(text)) return text;
  return `${text}\n`;
}

export function resolveChunkText(
  chunk: Extract<MergeChunk, { kind: 'conflict' }>,
  resolution: ChunkResolutionInput,
): string {
  switch (resolution.choice) {
    case 'ours':
      return chunk.ours.join('');
    case 'theirs':
      return chunk.theirs.join('');
    case 'ours-then-theirs':
      return ensureTrailingNewline(chunk.ours) + chunk.theirs.join('');
    case 'theirs-then-ours':
      return ensureTrailingNewline(chunk.theirs) + chunk.ours.join('');
    case 'custom':
      return resolution.text ?? '';
  }
}

/** Build the final text from merge chunks and per-conflict resolutions; null if any conflict is unresolved. */
export function applyResolutions(
  chunks: readonly MergeChunk[],
  resolutions: Readonly<Record<string, ChunkResolutionInput>>,
): string | null {
  let index = 0;
  let out = '';
  for (const chunk of chunks) {
    if (chunk.kind === 'stable') {
      out += chunk.lines.join('');
      continue;
    }
    const resolution = resolutions[String(index)];
    index++;
    if (!resolution) return null;
    out += resolveChunkText(chunk, resolution);
  }
  return out;
}
