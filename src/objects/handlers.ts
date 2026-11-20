/** Read-only queries for living objects: the objects of a universe, and where each one is used. */
import type { ChannelInput, ChannelName, ChannelOutput } from '../shared/ipc';
import { OBJECT_DIR, type LivingObject, type ObjectUsesView, type ObjectView } from '../shared/objects';
import type { ProjectEngine } from '../engine/project';
import type { StudioService } from '../services/studio';
import { findPlacements, parseObject } from './model';

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };

async function universeObjects(engine: ProjectEngine, lineId: string): Promise<{ objects: Map<string, LivingObject>; files: Map<string, string>; broken: string[] }> {
  const tree = await engine.effectiveTree(lineId);
  const objects = new Map<string, LivingObject>();
  const files = new Map<string, string>();
  const broken: string[] = [];
  for (const [p, hash] of tree) {
    const isObject = p.startsWith(`${OBJECT_DIR}/`) && p.endsWith('.mvobj.json');
    const isPlacementHost = /\.html?$/i.test(p) || /^sequences\/.+\.mvseq\.json$/.test(p);
    if (!isObject && !isPlacementHost) continue;
    const text = (await engine.readBlob(hash)).toString('utf8');
    if (isObject) {
      try {
        const o = parseObject(text, p);
        objects.set(o.id, o);
      } catch {
        broken.push(p);
      }
    } else files.set(p, text);
  }
  return { objects, files, broken };
}

export async function listObjects(engine: ProjectEngine, lineId: string): Promise<ObjectView[]> {
  const { objects, files } = await universeObjects(engine, lineId);
  const placements = findPlacements(files, objects);
  return [...objects.values()].sort((a, b) => a.name.localeCompare(b.name)).map((o) => ({ ...o, path: `${OBJECT_DIR}/${o.id}.mvobj.json`, placements: placements.get(o.id) ?? [] }));
}

export function createObjectHandlers(studio: StudioService): Handlers {
  return {
    'objects.list': async ({ projectId, lineId }) => listObjects(await studio.engine(projectId), lineId),
    'objects.uses': async ({ projectId, objectId }) => {
      const engine = await studio.engine(projectId);
      const view = await studio.view(engine);
      const out: ObjectUsesView = { objectId, universes: [] };
      const shared = (await listObjects(engine, view.shared.id)).find((o) => o.id === objectId) ?? null;
      for (const line of [view.shared, ...view.alternatives]) {
        const o = line.id === view.shared.id ? shared : ((await listObjects(engine, line.id)).find((x) => x.id === objectId) ?? null);
        out.universes.push({
          lineId: line.id,
          name: line.name,
          revision: o?.revision ?? null,
          differsFromShared: Boolean(o && shared && JSON.stringify([o.properties, o.overrides]) !== JSON.stringify([shared.properties, shared.overrides])),
          placements: o?.placements ?? [],
        });
      }
      return out;
    },
  };
}
