import { randomBytes } from 'node:crypto';
import type { TreeChange } from './merge/treeMerge';

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug.length > 0 ? slug : 'project';
}

function listNames(paths: string[]): string {
  const names = paths.map((p) => p.split('/').pop() ?? p);
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} files`;
}

/** A short, factual description generated from the actual changes. */
export function describeChanges(verb: string, changes: readonly TreeChange[]): string {
  if (changes.length === 0) return `${verb} (no file changes)`;
  const added = changes.filter((c) => c.status === 'added').map((c) => c.path);
  const deleted = changes.filter((c) => c.status === 'deleted').map((c) => c.path);
  const modified = changes.filter((c) => c.status === 'modified').map((c) => c.path);
  const parts: string[] = [];
  if (modified.length) parts.push(`${verb} ${listNames(modified)}`);
  if (added.length) parts.push(`${parts.length ? 'added' : 'Added'} ${listNames(added)}`);
  if (deleted.length) parts.push(`${parts.length ? 'removed' : 'Removed'} ${listNames(deleted)}`);
  return parts.join(', ');
}

/** Run async work with bounded concurrency. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
