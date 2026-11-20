/**
 * Shared dependency updates across versions.
 *
 * One view of everything a version depends on that Shared (or the media library) has moved past:
 * - npm dependencies whose version differs from Shared's package.json (code and app templates);
 * - copies of library media that are older than the library asset (websites);
 * - exports made from a sequence that has changed since (video).
 * Each can be brought up to date per version, as an ordinary undoable command or a new export;
 * nothing is updated without the user choosing it.
 */
import { z } from 'zod';
import { CommandError, type CommandRegistry, type FileTexts } from '../commands/commands';
import { SHARED_LINE_ID } from '../shared/types';
import type { ChannelInput, ChannelName, ChannelOutput } from '../shared/ipc';
import type { StudioService } from './studio';

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };

export const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
type Section = (typeof DEP_SECTIONS)[number];

export interface DependencyDriftView {
  lineId: string;
  lineName: string;
  following: boolean;
  packages: { name: string; section: Section; shared: string | null; here: string | null }[];
}

type Pkg = Partial<Record<Section, Record<string, string>>>;

function parsePkg(text: string | null): Pkg | null {
  if (!text) return null;
  try {
    const json = JSON.parse(text) as Pkg;
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/** Packages whose versions differ between Shared and a version. */
export function dependencyDrift(shared: Pkg | null, here: Pkg | null): DependencyDriftView['packages'] {
  const out: DependencyDriftView['packages'] = [];
  if (!shared || !here) return out;
  for (const section of DEP_SECTIONS) {
    const a = shared[section] ?? {};
    const b = here[section] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[name] !== b[name]) out.push({ name, section, shared: a[name] ?? null, here: b[name] ?? null });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/** Change dependency versions in package.json text, keeping its indentation and key order. */
export function setDependencies(text: string, changes: { name: string; section: Section; version: string | null }[]): string {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CommandError('package.json is not valid JSON, so its dependencies can’t be changed safely.');
  }
  const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  for (const c of changes) {
    const deps = { ...((json[c.section] as Record<string, string> | undefined) ?? {}) };
    if (c.version === null) delete deps[c.name];
    else deps[c.name] = c.version;
    if (Object.keys(deps).length) json[c.section] = deps;
    else delete json[c.section];
  }
  return `${JSON.stringify(json, null, indent)}${text.endsWith('\n') ? '\n' : ''}`;
}

const VERSION = /^[\w.^~<>=*|@:/+ -]{0,200}$/;

export function registerDependencyCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'code.setDependencies',
    schema: z.object({
      changes: z
        .array(z.object({ name: z.string().min(1).max(214).regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/), section: z.enum(DEP_SECTIONS), version: z.string().regex(VERSION).nullable() }))
        .min(1)
        .max(500),
    }),
    scope: () => 'code:package.json',
    label: (a) => (a.changes.length === 1 ? `Use ${a.changes[0]!.name} ${a.changes[0]!.version ?? '(removed)'}` : `Update ${a.changes.length} dependencies`),
    files: () => ['package.json'],
    apply: (files: FileTexts, a) => {
      const text = files.get('package.json');
      if (text == null) throw new CommandError('This version has no package.json.');
      return new Map([['package.json', setDependencies(text, a.changes)]]);
    },
  });
}

export function createDependencyHandlers(studio: StudioService): Handlers {
  const read = async (projectId: string, lineId: string): Promise<{ text: string | null; hash: string | null }> => {
    const engine = await studio.engine(projectId);
    const h = (await engine.effectiveTree(lineId)).get('package.json') ?? null;
    return { text: h ? (await engine.readBlob(h)).toString('utf8') : null, hash: h };
  };
  return {
    'deps.status': async ({ projectId }) => {
      const engine = await studio.engine(projectId);
      const shared = parsePkg((await read(projectId, SHARED_LINE_ID)).text);
      const lines: DependencyDriftView[] = [];
      for (const line of engine.alternatives()) {
        const packages = dependencyDrift(shared, parsePkg((await read(projectId, line.id)).text));
        if (packages.length) lines.push({ lineId: line.id, lineName: line.name, following: line.following, packages });
      }
      const [links, exports] = await Promise.all([studio.call('assets.links', { projectId }), studio.call('video.export.list', { projectId })]);
      return {
        hasPackageJson: shared !== null,
        packages: lines,
        media: links.filter((l) => l.outdated),
        exports: exports.filter((e) => e.outdated).map((e) => ({ jobId: e.id, lineId: e.lineId, sequenceId: e.sequenceId, sequenceName: e.sequenceName, reason: e.outdated!.detail, settings: e.settings })),
      };
    },
    'deps.align': async ({ projectId, lineId, names }) => {
      if (lineId === SHARED_LINE_ID) throw new CommandError('Shared is the reference; choose an alternative.');
      const engine = await studio.engine(projectId);
      const shared = parsePkg((await read(projectId, SHARED_LINE_ID)).text);
      const here = await read(projectId, lineId);
      const drift = dependencyDrift(shared, parsePkg(here.text)).filter((d) => names.includes(d.name));
      if (!drift.length) throw new CommandError('These packages already match Shared.');
      const result = await studio.commands.run(engine, lineId, 'code.setDependencies', { changes: drift.map((d) => ({ name: d.name, section: d.section, version: d.shared })) }, { actor: 'user', expected: { 'package.json': here.hash } });
      await studio.changed(engine, 'command', [lineId]);
      return { label: result.record.label, lockfileNote: 'Run Install in Build for this version to update its lockfile and node_modules.' };
    },
  };
}
