import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exists, writeFileAtomic } from './atomic';
import { manifestSchema, PROJECT_FORMAT, type ProjectManifest } from './records';
import { migrateManifest, UnsupportedProjectVersionError, type ManifestMigration } from './migrations';

export const MANIFEST_FILE = 'project.json';
export const MANIFEST_BACKUP = 'project.json.bak';

export class ProjectDamagedError extends Error {
  readonly code = 'project-damaged';
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(message);
    this.name = 'ProjectDamagedError';
  }
}

export function describeZodIssues(error: unknown): string[] {
  const issues = (error as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!Array.isArray(issues)) return [error instanceof Error ? error.message : String(error)];
  return issues.slice(0, 12).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

export interface LoadedManifest {
  manifest: ProjectManifest;
  /** The format version found on disk, before any migration. */
  fromVersion: number;
  applied: ManifestMigration[];
}

/** Read, migrate and validate a manifest. */
export async function readManifest(file: string): Promise<ProjectManifest> {
  return (await loadManifest(file)).manifest;
}

export async function loadManifest(file: string): Promise<LoadedManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new ProjectDamagedError('Project metadata is missing', [String((error as Error).message)]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ProjectDamagedError('Project metadata is not valid JSON', [String((error as Error).message)]);
  }
  if (typeof json !== 'object' || json === null || (json as { format?: unknown }).format !== PROJECT_FORMAT) {
    throw new ProjectDamagedError('This folder does not contain a Multiverse Studio project', ['project.json has an unexpected format']);
  }
  let migrated;
  try {
    migrated = migrateManifest(json);
  } catch (error) {
    if (error instanceof UnsupportedProjectVersionError) throw error;
    throw new ProjectDamagedError('Project metadata could not be upgraded', [String((error as Error).message)]);
  }
  const parsed = manifestSchema.safeParse(migrated.manifest);
  if (!parsed.success) throw new ProjectDamagedError('Project metadata failed validation', describeZodIssues(parsed.error));
  return { manifest: parsed.data, fromVersion: migrated.fromVersion, applied: migrated.applied };
}

/**
 * Commit a manifest. Content objects and revisions must already be on disk; this is
 * the single atomic step that makes them part of the project. The previous manifest
 * is kept as a backup for recovery.
 */
export async function writeManifest(dir: string, manifest: ProjectManifest, previousJson: string | null): Promise<string> {
  const target = path.join(dir, MANIFEST_FILE);
  const json = JSON.stringify(manifest);
  const previous = previousJson ?? ((await exists(target)) ? await fs.readFile(target, 'utf8') : null);
  if (previous !== null) await writeFileAtomic(path.join(dir, MANIFEST_BACKUP), previous);
  await writeFileAtomic(target, json);
  return json;
}
