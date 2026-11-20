import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileOnce } from './atomic';
import { sha256, type Hash } from './objects';
import { revisionRecordSchema, type RevisionRecord } from './records';

export type NewRevision = Omit<RevisionRecord, 'id'>;

function canonical(record: NewRevision): string {
  // Stable key order so identical records always produce the same id.
  return JSON.stringify({
    tree: record.tree,
    parents: record.parents,
    line: record.line,
    kind: record.kind,
    message: record.message,
    createdAt: record.createdAt,
    changes: record.changes,
    changesTruncated: record.changesTruncated,
    meta: Object.fromEntries(Object.entries(record.meta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  });
}

/** Immutable revision records, addressed by the hash of their content. */
export class RevisionStore {
  private cache = new Map<Hash, RevisionRecord>();

  constructor(readonly root: string) {}

  private file(id: Hash): string {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`Invalid revision id: ${id}`);
    return path.join(this.root, 'revisions', id.slice(0, 2), `${id.slice(2)}.json`);
  }

  async put(record: NewRevision): Promise<RevisionRecord> {
    const body = canonical(record);
    const id = sha256(body);
    const full: RevisionRecord = { id, ...record };
    if (!this.cache.has(id)) {
      await writeFileOnce(this.file(id), JSON.stringify(full));
      this.cache.set(id, full);
    }
    return full;
  }

  async get(id: Hash): Promise<RevisionRecord> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    let text: string;
    try {
      text = await fs.readFile(this.file(id), 'utf8');
    } catch {
      throw new Error(`Revision ${id.slice(0, 12)} is missing`);
    }
    const parsed = revisionRecordSchema.parse(JSON.parse(text));
    const { id: _ignored, ...rest } = parsed;
    if (parsed.id !== id || sha256(canonical(rest)) !== id) {
      throw new Error(`Revision ${id.slice(0, 12)} is damaged`);
    }
    this.cache.set(id, parsed);
    return parsed;
  }

  async has(id: Hash): Promise<boolean> {
    if (this.cache.has(id)) return true;
    try {
      await fs.access(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  async listAll(): Promise<Hash[]> {
    const base = path.join(this.root, 'revisions');
    const out: Hash[] = [];
    let prefixes: string[] = [];
    try {
      prefixes = await fs.readdir(base);
    } catch {
      return out;
    }
    for (const prefix of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const name of await fs.readdir(path.join(base, prefix))) {
        if (!name.endsWith('.json')) continue;
        const id = prefix + name.slice(0, -5);
        if (/^[0-9a-f]{64}$/.test(id)) out.push(id);
      }
    }
    return out;
  }

  async remove(id: Hash): Promise<void> {
    await fs.rm(this.file(id), { force: true });
    this.cache.delete(id);
  }
}
