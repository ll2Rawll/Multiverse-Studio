/**
 * Settings → Storage: what the caches hold, how big they are, and cleanup per category.
 * Caches live under the cache root and are rebuilt on demand; originals (imported media) and
 * history (objects and revisions) live in each project folder and are never touched by cleanup.
 * A category is refused while something uses it, so cleanup never pulls files from under a job.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChannelInput, ChannelName, ChannelOutput } from '../shared/ipc';
import type { CacheCategory, ProjectStorageView, StorageCategoryView, StorageView } from '../shared/storage';
import type { StudioService } from './studio';
import { StudioError } from '../engine/errors';
import { heavyWork } from '../video/ffmpeg';

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };

export async function folderSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const st = await fs.stat(full).catch(() => null);
        if (st) {
          bytes += st.size;
          files += 1;
        }
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

const TEMP_PREFIXES = ['mv-transcribe-'];

async function tempFolders(): Promise<string[]> {
  const root = os.tmpdir();
  const names = await fs.readdir(root).catch(() => [] as string[]);
  return names.filter((n) => TEMP_PREFIXES.some((p) => n.startsWith(p))).map((n) => path.join(root, n));
}

export function createStorageHandlers(studio: StudioService): Handlers {
  const location = (id: CacheCategory): string => (id === 'runs' ? (studio.runsRoot ?? path.join(studio.cacheRoot, 'runs')) : id === 'temp' ? os.tmpdir() : path.join(studio.cacheRoot, id));

  const blockedReason = (id: CacheCategory): string | null => {
    switch (id) {
      case 'media':
        return heavyWork.running + heavyWork.queued > 0 ? 'Previews are being made right now.' : null;
      case 'exports':
        return studio.video.exports.busy ? 'A video export is running.' : null;
      case 'runs': {
        const live = [...(studio.build?.processes.list() ?? []), ...(studio.agent?.processes.list() ?? [])].filter((p) => !p.exited).length;
        if (live) return `${live} build or app process${live === 1 ? ' is' : 'es are'} running. Stop them in Build first.`;
        return (studio.aiRuntime?.runner.activeCount ?? 0) > 0 ? 'An AI task is running.' : null;
      }
      case 'recordings':
      case 'temp':
        return studio.media.jobs.busy ? 'A media job is running.' : null;
    }
  };

  const LABELS: Record<CacheCategory, { label: string; detail: string }> = {
    media: { label: 'Media previews', detail: 'Thumbnails, filmstrips, waveforms and playback proxies. Made again from the originals when needed.' },
    exports: { label: 'Export work folders', detail: 'Temporary files from video exports. Exports saved to a location you chose are not affected.' },
    runs: { label: 'Build and task folders', detail: 'Copies of versions used to run builds, dev servers and coding tasks, including installed dependencies. Installs run again next time.' },
    recordings: { label: 'Recording work folders', detail: 'Temporary frames from preview recordings. Finished recordings are in Assets.' },
    temp: { label: 'Leftover temporary files', detail: 'Audio prepared for transcription that was left behind by an interrupted job.' },
  };

  const measureCategory = async (id: CacheCategory): Promise<StorageCategoryView> => {
    let size = { bytes: 0, files: 0 };
    if (id === 'temp') {
      for (const dir of await tempFolders()) {
        const s = await folderSize(dir);
        size = { bytes: size.bytes + s.bytes, files: size.files + s.files };
      }
    } else size = await folderSize(location(id));
    return { id, ...LABELS[id], path: id === 'temp' ? path.join(os.tmpdir(), `${TEMP_PREFIXES[0]}*`) : location(id), ...size, blocked: blockedReason(id) };
  };

  const measureProject = async (p: { id: string; name: string; storagePath: string; available: boolean }): Promise<ProjectStorageView> => {
    if (!p.available) return { id: p.id, name: p.name, path: p.storagePath, historyBytes: 0, mediaBytes: 0, otherBytes: 0, available: false };
    const total = await folderSize(p.storagePath);
    const objects = await folderSize(path.join(p.storagePath, 'objects'));
    const revisions = await folderSize(path.join(p.storagePath, 'revisions'));
    const media = await folderSize(path.join(p.storagePath, 'media'));
    const history = objects.bytes + revisions.bytes;
    return { id: p.id, name: p.name, path: p.storagePath, historyBytes: history, mediaBytes: media.bytes, otherBytes: Math.max(0, total.bytes - history - media.bytes), available: true };
  };

  const usage = async (): Promise<StorageView> => {
    const categories = await Promise.all((['media', 'exports', 'runs', 'recordings', 'temp'] as const).map(measureCategory));
    const recent = await studio.call('projects.recent', {});
    const projects = await Promise.all(recent.map(measureProject));
    return { cacheRoot: studio.cacheRoot, workspacePath: studio.projectsDir, categories, projects, measuredAt: new Date().toISOString() };
  };

  const clean = async (id: CacheCategory): Promise<number> => {
    const reason = blockedReason(id);
    if (reason) throw new StudioError('busy', `Not cleaned: ${reason}`);
    const before = await measureCategory(id);
    if (id === 'temp') {
      for (const dir of await tempFolders()) await fs.rm(dir, { recursive: true, force: true });
    } else {
      const dir = location(id);
      // Guard against a misconfigured root: only ever delete folders inside the cache roots.
      const roots = [studio.cacheRoot, studio.runsRoot].filter((r): r is string => Boolean(r)).map((r) => path.resolve(r) + path.sep);
      if (!roots.some((r) => path.resolve(dir).startsWith(r))) throw new StudioError('invalid', 'That folder is not inside the cache.');
      await fs.rm(dir, { recursive: true, force: true });
    }
    if (id === 'runs') {
      studio.build?.forgetRunFolders();
      studio.agent?.forgetRunFolders();
    }
    if (id === 'media') for (const projectId of studio.video.loadedProjects()) studio.emitEvent({ type: 'media', projectId });
    return before.bytes;
  };

  return {
    'storage.usage': async () => usage(),
    'storage.clean': async ({ category }) => {
      const freed = await clean(category);
      return { freed, view: await usage() };
    },
    'storage.compact': async ({ projectId }) => {
      const engine = await studio.engine(projectId);
      const before = (await folderSize(path.join(engine.dir, 'objects'))).bytes + (await folderSize(path.join(engine.dir, 'revisions'))).bytes;
      const removed = await engine.collectGarbage();
      const after = (await folderSize(path.join(engine.dir, 'objects'))).bytes + (await folderSize(path.join(engine.dir, 'revisions'))).bytes;
      return { ...removed, freed: Math.max(0, before - after), view: await usage() };
    },
  };
}
