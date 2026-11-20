import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileOnce } from './atomic';
import { comparePaths } from '../../shared/paths';

export type Hash = string;
/** A tree maps normalized project paths to blob hashes. */
export type Tree = ReadonlyMap<string, Hash>;

export function sha256(data: string | Uint8Array): Hash {
  return createHash('sha256').update(data).digest('hex');
}

export function isHash(value: unknown): value is Hash {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function treeToJson(tree: Tree): string {
  const entries = [...tree.entries()].sort((a, b) => comparePaths(a[0], b[0]));
  return JSON.stringify({ v: 1, entries });
}

export function treeFromJson(text: string): Map<string, Hash> {
  const parsed = JSON.parse(text) as { v?: number; entries?: unknown };
  if (parsed.v !== 1 || !Array.isArray(parsed.entries)) throw new Error('Unrecognized tree format');
  const tree = new Map<string, Hash>();
  for (const entry of parsed.entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !isHash(entry[1])) {
      throw new Error('Damaged tree entry');
    }
    tree.set(entry[0], entry[1]);
  }
  return tree;
}

class LruCache<V> {
  private map = new Map<string, { value: V; size: number }>();
  private total = 0;
  constructor(private readonly capacity: number) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: V, size: number): void {
    if (size > this.capacity / 4) return;
    const existing = this.map.get(key);
    if (existing) {
      this.total -= existing.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.total += size;
    while (this.total > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const victim = this.map.get(oldest.value);
      this.map.delete(oldest.value);
      this.total -= victim?.size ?? 0;
    }
  }
}

/**
 * Content-addressed storage for file contents and trees.
 * Identical content is stored once; objects are immutable once written.
 */
export class ObjectStore {
  private blobCache = new LruCache<Buffer>(64 * 1024 * 1024);
  private treeCache = new Map<Hash, Map<string, Hash>>();
  private known = new Set<Hash>();

  constructor(readonly root: string) {}

  objectPath(hash: Hash): string {
    if (!isHash(hash)) throw new Error(`Invalid object id: ${hash}`);
    return path.join(this.root, 'objects', hash.slice(0, 2), hash.slice(2));
  }

  async putBlob(data: Uint8Array | string): Promise<Hash> {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const hash = sha256(buffer);
    if (!this.known.has(hash)) {
      await writeFileOnce(this.objectPath(hash), buffer);
      this.known.add(hash);
    }
    this.blobCache.set(hash, buffer, buffer.length);
    return hash;
  }

  async getBlob(hash: Hash): Promise<Buffer> {
    const cached = this.blobCache.get(hash);
    if (cached) return cached;
    const buffer = await fs.readFile(this.objectPath(hash));
    this.blobCache.set(hash, buffer, buffer.length);
    this.known.add(hash);
    return buffer;
  }

  async getText(hash: Hash): Promise<string> {
    return (await this.getBlob(hash)).toString('utf8');
  }

  async has(hash: Hash): Promise<boolean> {
    if (this.known.has(hash)) return true;
    try {
      await fs.access(this.objectPath(hash));
      this.known.add(hash);
      return true;
    } catch {
      return false;
    }
  }

  async size(hash: Hash): Promise<number> {
    const cached = this.blobCache.get(hash);
    if (cached) return cached.length;
    const stat = await fs.stat(this.objectPath(hash));
    return stat.size;
  }

  async putTree(tree: Tree): Promise<Hash> {
    const json = treeToJson(tree);
    const hash = sha256(json);
    if (!this.known.has(hash)) {
      await writeFileOnce(this.objectPath(hash), json);
      this.known.add(hash);
    }
    if (!this.treeCache.has(hash)) this.treeCache.set(hash, new Map(tree));
    return hash;
  }

  async getTree(hash: Hash): Promise<Map<string, Hash>> {
    const cached = this.treeCache.get(hash);
    if (cached) return cached;
    const text = await fs.readFile(this.objectPath(hash), 'utf8');
    if (sha256(text) !== hash) throw new Error(`Tree ${hash.slice(0, 12)} is damaged`);
    const tree = treeFromJson(text);
    this.treeCache.set(hash, tree);
    this.known.add(hash);
    return tree;
  }

  /** Verify that an object exists and its bytes match its id. */
  async verify(hash: Hash): Promise<boolean> {
    try {
      const data = await fs.readFile(this.objectPath(hash));
      return sha256(data) === hash;
    } catch {
      return false;
    }
  }

  async listAll(): Promise<Hash[]> {
    const out: Hash[] = [];
    const base = path.join(this.root, 'objects');
    let prefixes: string[] = [];
    try {
      prefixes = await fs.readdir(base);
    } catch {
      return out;
    }
    for (const prefix of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const rest of await fs.readdir(path.join(base, prefix))) {
        const hash = prefix + rest;
        if (isHash(hash)) out.push(hash);
      }
    }
    return out;
  }

  async remove(hash: Hash): Promise<void> {
    await fs.rm(this.objectPath(hash), { force: true });
    this.known.delete(hash);
    this.treeCache.delete(hash);
  }
}
