/**
 * Import from a folder and export to a folder or ZIP.
 *
 * Import copies files into the managed workspace (the original folder is never
 * modified) and refuses links that point outside the project. Export writes only the
 * effective project files, never history or metadata, and reports local references that
 * point at files the export does not contain.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { normalizeProjectPath, segmentProblem, comparePaths } from '../shared/paths';
import type { Hash } from './store/objects';
import { writeFileAtomic, renameWithRetry } from './store/atomic';
import { StudioError } from './errors';
import { isTextFile } from './merge/text';
import type { ProjectAdapter } from '../adapters/types';
import type { ExportReport } from '../shared/types';

export interface ScanLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: ScanLimits = { maxFiles: 5000, maxFileBytes: 100 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 };

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.multiverse', '__MACOSX']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export interface ScanResult {
  files: Map<string, Buffer>;
  skipped: { path: string; reason: string }[];
  totalBytes: number;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function scanFolder(folder: string, limits: ScanLimits = DEFAULT_LIMITS): Promise<ScanResult> {
  const root = await fs.realpath(folder);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new StudioError('not-a-folder', 'Choose a folder to import.');
  const files = new Map<string, Buffer>();
  const skipped: { path: string; reason: string }[] = [];
  let totalBytes = 0;

  const walk = async (dir: string, rel: string[]): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => comparePaths(a.name, b.name));
    for (const entry of entries) {
      const relPath = [...rel, entry.name].join('/');
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
        skipped.push({ path: relPath, reason: 'Tool folder (not part of the site)' });
        continue;
      }
      if (SKIP_FILES.has(entry.name)) continue;
      const problem = segmentProblem(entry.name);
      if (problem) {
        skipped.push({ path: relPath, reason: `Unsupported name (${problem})` });
        continue;
      }
      let isFile = entry.isFile();
      let isDir = entry.isDirectory();
      let readFrom = full;
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await fs.realpath(full);
        } catch {
          skipped.push({ path: relPath, reason: 'Broken link' });
          continue;
        }
        if (!isInside(root, target)) {
          skipped.push({ path: relPath, reason: 'Link points outside the project, so it was not imported' });
          continue;
        }
        const targetStat = await fs.stat(target);
        if (targetStat.isDirectory()) {
          skipped.push({ path: relPath, reason: 'Linked folders are not followed' });
          continue;
        }
        isFile = targetStat.isFile();
        isDir = false;
        readFrom = target;
      }
      if (isDir) {
        await walk(full, [...rel, entry.name]);
        continue;
      }
      if (!isFile) {
        skipped.push({ path: relPath, reason: 'Not a regular file' });
        continue;
      }
      const size = (await fs.stat(readFrom)).size;
      if (size > limits.maxFileBytes) {
        skipped.push({ path: relPath, reason: `Larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB` });
        continue;
      }
      if (files.size >= limits.maxFiles) {
        skipped.push({ path: relPath, reason: `The project has more than ${limits.maxFiles} files` });
        continue;
      }
      if (totalBytes + size > limits.maxTotalBytes) {
        skipped.push({ path: relPath, reason: 'The project is larger than the import limit' });
        continue;
      }
      files.set(normalizeProjectPath(relPath), await fs.readFile(readFrom));
      totalBytes += size;
    }
  };
  await walk(root, []);
  return { files, skipped, totalBytes };
}

export async function missingReferences(
  tree: ReadonlyMap<string, Hash>,
  read: (hash: Hash) => Promise<Buffer>,
  adapter: ProjectAdapter,
): Promise<{ file: string; reference: string }[]> {
  const out: { file: string; reference: string }[] = [];
  for (const [file, hash] of tree) {
    if (!/\.(html?|css)$/i.test(file)) continue;
    const data = await read(hash);
    if (!isTextFile(file, data)) continue;
    for (const ref of adapter.references(file, data.toString('utf8'))) {
      if (ref.resolved === null) out.push({ file, reference: `${ref.raw} (points outside the project)` });
      else if (!tree.has(ref.resolved)) out.push({ file, reference: ref.raw });
    }
  }
  return out.slice(0, 500);
}

function assertSafeExportTarget(target: string, workspaceRoot: string): void {
  const resolved = path.resolve(target);
  const { root } = path.parse(resolved);
  if (resolved === root) throw new StudioError('unsafe-destination', 'Choose a folder rather than the root of a drive.');
  if (resolved === path.resolve(os.homedir())) throw new StudioError('unsafe-destination', 'Choose a folder inside your home folder rather than the home folder itself.');
  if (isInside(path.resolve(workspaceRoot), resolved) || isInside(resolved, path.resolve(workspaceRoot))) {
    throw new StudioError('unsafe-destination', 'Choose a folder outside Multiverse Studio’s workspace.');
  }
}

export async function exportTree(input: {
  tree: ReadonlyMap<string, Hash>;
  read: (hash: Hash) => Promise<Buffer>;
  adapter: ProjectAdapter;
  format: 'folder' | 'zip';
  destination: string;
  overwrite: boolean;
  workspaceRoot: string;
}): Promise<ExportReport> {
  const { tree, read, format, destination } = input;
  assertSafeExportTarget(destination, input.workspaceRoot);
  const exists = await fs
    .stat(destination)
    .then((s) => s)
    .catch(() => null);
  if (exists && !input.overwrite) {
    throw new StudioError('destination-exists', `${destination} already exists.`, { destination });
  }
  let totalBytes = 0;
  const entries = [...tree.entries()].sort((a, b) => comparePaths(a[0], b[0]));

  if (format === 'zip') {
    if (exists && !exists.isFile()) throw new StudioError('unsafe-destination', 'A folder already exists with that name.');
    const zip = new JSZip();
    for (const [file, hash] of entries) {
      const data = await read(hash);
      totalBytes += data.length;
      zip.file(normalizeProjectPath(file), data);
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await writeFileAtomic(destination, buffer);
  } else {
    if (exists) {
      if (!exists.isDirectory()) throw new StudioError('unsafe-destination', 'A file already exists with that name.');
      const gitDir = await fs.stat(path.join(destination, '.git')).catch(() => null);
      if (gitDir) throw new StudioError('unsafe-destination', 'That folder contains a Git repository. Choose an empty or new folder so nothing is replaced by accident.');
    }
    const parent = path.dirname(path.resolve(destination));
    await fs.mkdir(parent, { recursive: true });
    const staging = await fs.mkdtemp(path.join(parent, `.${path.basename(destination)}.export-`));
    try {
      for (const [file, hash] of entries) {
        const rel = normalizeProjectPath(file);
        const target = path.join(staging, ...rel.split('/'));
        if (!isInside(staging, target)) throw new StudioError('unsafe-path', `Refused to write ${file}.`);
        const data = await read(hash);
        totalBytes += data.length;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, data);
      }
      if (exists) {
        const old = `${destination}.replaced-${Date.now()}`;
        await renameWithRetry(destination, old);
        await renameWithRetry(staging, destination);
        await fs.rm(old, { recursive: true, force: true });
      } else {
        await renameWithRetry(staging, destination);
      }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  return {
    destination,
    format,
    fileCount: entries.length,
    totalBytes,
    missingReferences: await missingReferences(tree, read, input.adapter),
  };
}
