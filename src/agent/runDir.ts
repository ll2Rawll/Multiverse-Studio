/**
 * Run directories: a materialised copy of one version (alternative) on disk, so its build, tests
 * and dev server can run. The project's revision store stays the source of truth:
 *
 * - `prepare()` writes the version's files to disk, touching only files that changed since the
 *   last sync, and removes files that the version deleted (never untracked files such as
 *   `node_modules`).
 * - `collect()` brings back files that a command created or changed (for example a lockfile or
 *   generated code), as edits to the same version, merged against the version they started from.
 *
 * Dependency folders, build output, caches and `.env` files are never imported into the project.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectEngine } from '../engine/project';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.vite', '.cache', '.next', '.turbo', '.parcel-cache', '.svelte-kit', '.nuxt', '.output', '.multiverse-run']);
const MAX_COLLECT_BYTES = 8 * 1024 * 1024;

export function isIgnoredPath(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  const base = parts[parts.length - 1]!;
  if (/^\.env(\..*)?$/.test(base) && base !== '.env.example') return true; // app secrets stay out of history
  // Logs, editor swap files and local database files that running apps write (data, not source).
  if (/\.(log|tmp|swp|db|db-journal|db-wal|db-shm|sqlite|sqlite3|sqlite-wal|sqlite-shm)$/.test(base) || base === '.DS_Store') return true;
  return false;
}

const sha = (data: Buffer | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export interface CollectResult {
  changed: string[];
  added: string[];
  deleted: string[];
  skipped: { path: string; reason: string }[];
  conflicts: { path: string; reason: string }[];
}

export class RunDirectory {
  /** project path → content hash as last written to disk / read back. */
  private synced = new Map<string, string>();

  constructor(
    readonly dir: string,
    private readonly engine: ProjectEngine,
    readonly lineId: string,
  ) {}

  private abs(rel: string): string {
    const full = path.resolve(this.dir, ...rel.split('/'));
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) throw new Error(`Refusing to write outside the run directory: ${rel}`);
    return full;
  }

  /** Write the version's current files to disk. Returns the number of files written. */
  async prepare(): Promise<number> {
    await fs.mkdir(this.dir, { recursive: true });
    const tree = await this.engine.effectiveTree(this.lineId);
    let written = 0;
    for (const [rel, hash] of tree) {
      if (this.synced.get(rel) === hash && (await exists(this.abs(rel)))) continue;
      const file = this.abs(rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, await this.engine.readBlob(hash));
      this.synced.set(rel, hash);
      written += 1;
    }
    for (const rel of [...this.synced.keys()]) {
      if (!tree.has(rel)) {
        await fs.rm(this.abs(rel), { force: true });
        this.synced.delete(rel);
      }
    }
    return written;
  }

  /** Bring files created or changed on disk back into the version. */
  async collect(): Promise<CollectResult> {
    const result: CollectResult = { changed: [], added: [], deleted: [], skipped: [], conflicts: [] };
    const onDisk = new Map<string, string>();
    const walk = async (dirAbs: string, prefix: string): Promise<void> => {
      for (const entry of await fs.readdir(dirAbs, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (isIgnoredPath(rel)) continue;
        if (entry.isSymbolicLink()) {
          result.skipped.push({ path: rel, reason: 'symbolic link' });
          continue;
        }
        if (entry.isDirectory()) await walk(path.join(dirAbs, entry.name), rel);
        else if (entry.isFile()) onDisk.set(rel, path.join(dirAbs, entry.name));
      }
    };
    await walk(this.dir, '');
    for (const [rel, file] of onDisk) {
      const stat = await fs.stat(file);
      if (stat.size > MAX_COLLECT_BYTES) {
        if (!this.synced.has(rel)) result.skipped.push({ path: rel, reason: `larger than ${MAX_COLLECT_BYTES / 1024 / 1024} MB` });
        continue;
      }
      const data = await fs.readFile(file);
      const hash = sha(data);
      const base = this.synced.get(rel);
      if (base === hash) continue;
      try {
        const text = isText(data) ? data.toString('utf8') : null;
        const r = await this.engine.writeFile(this.lineId, rel, text ?? new Uint8Array(data), base ? { baseHash: base } : {});
        this.synced.set(rel, r.hash);
        (base ? result.changed : result.added).push(rel);
        if (r.mergedText !== null) await fs.writeFile(file, r.mergedText);
      } catch (error) {
        result.conflicts.push({ path: rel, reason: (error as Error).message });
      }
    }
    for (const rel of [...this.synced.keys()]) {
      if (onDisk.has(rel) || isIgnoredPath(rel)) continue;
      try {
        await this.engine.deleteFile(this.lineId, rel);
        result.deleted.push(rel);
      } catch {
        // already gone from the version
      }
      this.synced.delete(rel);
    }
    return result;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

function isText(data: Buffer): boolean {
  const sample = data.subarray(0, 8000);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}
