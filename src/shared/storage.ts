/** Storage: caches (safe to delete, rebuilt on demand) kept apart from originals and history. */

export const CACHE_CATEGORIES = ['media', 'exports', 'runs', 'recordings', 'temp'] as const;
export type CacheCategory = (typeof CACHE_CATEGORIES)[number];

export interface StorageCategoryView {
  id: CacheCategory;
  label: string;
  detail: string;
  path: string;
  bytes: number;
  files: number;
  /** Why it cannot be cleaned right now (something is using it), or null. */
  blocked: string | null;
}

export interface ProjectStorageView {
  id: string;
  name: string;
  path: string;
  /** Content-addressed objects and revision records (all versions, checkpoints, undo). */
  historyBytes: number;
  /** Imported media originals (content-addressed, never changed). */
  mediaBytes: number;
  /** Task logs, job records, transcripts and settings. */
  otherBytes: number;
  available: boolean;
}

export interface StorageView {
  cacheRoot: string;
  workspacePath: string;
  categories: StorageCategoryView[];
  projects: ProjectStorageView[];
  measuredAt: string;
}
