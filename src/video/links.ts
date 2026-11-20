/**
 * Shared media: copies of library assets placed into versions (an image on a webpage, a font in a
 * site, a generated clip in an app's public folder).
 *
 * A placement is an ordinary undoable command that writes the asset's bytes into the version. We
 * remember (path, content hash written, asset, asset content) in `<project>/media/links.json`, so
 * any version whose file at that path still has exactly those bytes is known to hold a copy of the
 * asset — including alternatives created afterwards. When the asset's content changes (relinked to
 * a new file), those copies are reported as outdated and can be updated, one command per version.
 * A copy the user edited or replaced is no longer tracked: it is theirs.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../engine/store/atomic';
import type { CommandRegistry } from '../commands/commands';

export interface AssetLinkRecord {
  path: string;
  /** Content hash of the bytes written into the version. */
  blob: string;
  assetId: string;
  /** The asset's content when it was placed. */
  assetSha: string;
  placedAt: string;
}

export class AssetLinkStore {
  private cache: AssetLinkRecord[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly projectDir: string) {}

  private get file(): string {
    return path.join(this.projectDir, 'media', 'links.json');
  }

  async list(): Promise<AssetLinkRecord[]> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as { version: 1; links: AssetLinkRecord[] };
      this.cache = Array.isArray(parsed.links) ? parsed.links : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  add(record: AssetLinkRecord): Promise<void> {
    const run = this.chain.then(async () => {
      const list = await this.list();
      const next = [...list.filter((l) => !(l.path === record.path && l.blob === record.blob)), record].slice(-5000);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeFileAtomic(this.file, JSON.stringify({ version: 1, links: next }, null, 1));
      this.cache = next;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

const MAX_PLACE_BYTES = 200 * 1024 * 1024;

export function registerAssetCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'assets.place',
    schema: z.object({
      path: z.string().min(1).max(400).regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9 ._/-]+$/, 'Use a relative path inside the version'),
      data: z.instanceof(Uint8Array).refine((d) => d.byteLength <= MAX_PLACE_BYTES, 'Files larger than 200 MB cannot be copied into a version'),
      label: z.string().max(200).optional(),
    }),
    scope: (a) => `assets:${a.path}`,
    label: (a) => a.label ?? `Place ${path.posix.basename(a.path)}`,
    files: (a) => [a.path],
    apply: (_files, a) => new Map([[a.path, a.data]]),
  });
}

/** Where a placed asset goes by default. */
export function defaultPlacement(kind: 'video' | 'audio' | 'image' | 'font', name: string, ext: string): string {
  const base =
    name
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'asset';
  const dir = kind === 'image' ? 'images' : kind === 'font' ? 'fonts' : 'media';
  return `${dir}/${base}${ext ? `.${ext}` : ''}`;
}
