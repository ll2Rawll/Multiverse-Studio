/**
 * Versioned migrations for the project manifest (`project.json`).
 *
 * Each migration takes the raw JSON of version N and returns version N + 1. Migrations are
 * pure and never touch content objects or revisions: those formats have not changed.
 * When a project is migrated on open, the engine keeps the untouched original next to it as
 * `project.v<N>.json` so the previous format can always be inspected or restored by hand.
 */

export const CURRENT_PROJECT_VERSION = 2;

export interface ManifestMigration {
  from: number;
  to: number;
  summary: string;
  up(manifest: Record<string, unknown>): Record<string, unknown>;
}

export const DEFAULT_BRAND = Object.freeze({ colors: [], fonts: [], textStyles: [], logoAssetId: null });

export const MIGRATIONS: readonly ManifestMigration[] = [
  {
    from: 1,
    to: 2,
    summary: 'Adds the project kind and shared brand settings (colours, fonts, text styles, logo).',
    up: (m) => ({
      ...m,
      version: 2,
      kind: 'website',
      brand: { colors: [], fonts: [], textStyles: [], logoAssetId: null },
    }),
  },
];

export class UnsupportedProjectVersionError extends Error {
  readonly code = 'project-version';
  constructor(readonly version: unknown) {
    super(
      typeof version === 'number' && version > CURRENT_PROJECT_VERSION
        ? `This project was saved by a newer version of Multiverse Studio (format ${version}). Update the app to open it.`
        : `This project uses an unknown format version (${String(version)}).`,
    );
    this.name = 'UnsupportedProjectVersionError';
  }
}

export interface MigrationResult {
  manifest: Record<string, unknown>;
  fromVersion: number;
  applied: ManifestMigration[];
}

/** Bring raw manifest JSON up to the current version. Throws for unknown or newer versions. */
export function migrateManifest(raw: unknown): MigrationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new UnsupportedProjectVersionError(undefined);
  let manifest = raw as Record<string, unknown>;
  const fromVersion = manifest.version;
  if (typeof fromVersion !== 'number' || !Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion > CURRENT_PROJECT_VERSION) {
    throw new UnsupportedProjectVersionError(fromVersion);
  }
  const applied: ManifestMigration[] = [];
  let version = fromVersion;
  while (version < CURRENT_PROJECT_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === version);
    if (!step) throw new UnsupportedProjectVersionError(version);
    manifest = step.up(manifest);
    if (manifest.version !== step.to) throw new Error(`Migration ${step.from}→${step.to} did not set the version`);
    applied.push(step);
    version = step.to;
  }
  return { manifest, fromVersion, applied };
}
