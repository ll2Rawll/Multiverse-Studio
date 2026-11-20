/**
 * How living objects merge between universes.
 *
 * - Object files merge by property: a property changed on one side is taken; changed on both, the
 *   receiving universe keeps its own value (a universe-level override wins over a shared edit).
 * - Placements are derived content. Before a page or timeline is merged, every placement that was
 *   not edited by hand is reduced to a stub (object, instance and its own overrides); after the merge
 *   all placements are rendered again from the merged object. So a shared price change and a
 *   universe's own price never collide inside the page, and both pages stay correct.
 * - Placements edited by hand keep their content and merge as ordinary text, so real conflicts show.
 */
import { OBJECT_DIR, type LivingObject, type ObjectProps } from '../shared/objects';
import type { Sequence } from '../shared/video';
import { pagePlacements, parseObject, placementState, scenePlacementState, serializeObject } from './model';
import { syncFile } from './commands';
import { parseSequence, serializeSequence } from '../video/sequence';

export const isObjectPath = (path: string): boolean => path.startsWith(`${OBJECT_DIR}/`) && path.endsWith('.mvobj.json');

function mergeRecord(base: ObjectProps, ours: ObjectProps, theirs: ObjectProps): ObjectProps {
  const out: ObjectProps = { ...ours };
  const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  for (const k of keys) {
    const b = base[k];
    const o = ours[k];
    const t = theirs[k];
    if (same(o, t) || !same(b, o)) continue; // equal, or ours changed it (ours wins)
    if (t === undefined) delete out[k];
    else out[k] = t;
  }
  return out;
}

/** Returns null when a side cannot be read (then the file is chosen as a whole). */
export function mergeObjectTexts(base: string | null, ours: string, theirs: string): string | null {
  let b: LivingObject | null;
  let o: LivingObject;
  let t: LivingObject;
  try {
    o = parseObject(ours);
    t = parseObject(theirs);
    b = base ? parseObject(base) : null;
  } catch {
    return null;
  }
  const bb = b ?? { ...o, properties: {}, overrides: {}, name: o.name, assets: [], targets: o.targets, dependencies: [] };
  const pick = <T,>(bv: T, ov: T, tv: T): T => (JSON.stringify(bv) === JSON.stringify(ov) ? tv : ov);
  const merged: LivingObject = {
    ...o,
    name: pick(bb.name, o.name, t.name),
    properties: mergeRecord(bb.properties, o.properties, t.properties),
    overrides: {
      web: mergeRecord(bb.overrides.web ?? {}, o.overrides.web ?? {}, t.overrides.web ?? {}),
      video: mergeRecord(bb.overrides.video ?? {}, o.overrides.video ?? {}, t.overrides.video ?? {}),
    },
    assets: pick(bb.assets, o.assets, t.assets),
    targets: pick(bb.targets, o.targets, t.targets),
    dependencies: pick(bb.dependencies, o.dependencies, t.dependencies),
  };
  for (const k of ['web', 'video'] as const) if (Object.keys(merged.overrides[k] ?? {}).length === 0) delete merged.overrides[k];
  const content = (x: LivingObject): string => JSON.stringify([x.properties, x.overrides]);
  merged.revision = content(merged) === content(o) ? o.revision : Math.max(o.revision, t.revision) + (content(merged) === content(t) ? 0 : 1);
  return serializeObject(merged);
}

/** Replace placements that were not edited by hand with stubs (see the file comment). */
export function canonicalizePage(text: string, objects: Map<string, LivingObject>): string {
  let out = text;
  const list = pagePlacements(out).sort((a, b) => b.el.start - a.el.start);
  for (const p of list) {
    const o = objects.get(p.object);
    if (o && placementState(o, out.slice(p.el.start, p.el.end), p) === 'edited') continue;
    const props = Object.keys(p.overrides).length ? ` data-mv-props="${JSON.stringify(p.overrides).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : '';
    out = `${out.slice(0, p.el.start)}<section data-mv-object="${p.object}" data-mv-instance="${p.instance}"${props}></section>${out.slice(p.el.end)}`;
  }
  return out;
}

export function canonicalizeSequence(seq: Sequence, objects: Map<string, LivingObject>): Sequence {
  for (const t of seq.tracks)
    for (const c of t.clips) {
      if (c.type !== 'text' || !c.object) continue;
      const o = objects.get(c.object.id);
      if (o && scenePlacementState(o, c) === 'edited') continue;
      c.text = '·';
      delete c.subtitle;
      c.object = { id: c.object.id, instance: c.object.instance, revision: 0, ...(c.object.overrides ? { overrides: c.object.overrides } : {}) };
    }
  return seq;
}

export function readObjects(texts: Map<string, string>): Map<string, LivingObject> {
  const out = new Map<string, LivingObject>();
  for (const [p, text] of texts) {
    if (!isObjectPath(p)) continue;
    try {
      const o = parseObject(text);
      out.set(o.id, o);
    } catch {
      /* unreadable objects leave their placements as they are */
    }
  }
  return out;
}

/** Render every stale placement in a file from the given objects. Returns null when nothing changes. */
export function renderPlacements(path: string, text: string, objects: Map<string, LivingObject>): string | null {
  let out = text;
  let changed = false;
  const ids = /\.html?$/i.test(path) ? [...new Set(pagePlacements(out).map((p) => p.object))] : (() => {
    try {
      return [...new Set(parseSequence(out).tracks.flatMap((t) => t.clips.flatMap((c) => (c.type === 'text' && c.object ? [c.object.id] : []))))];
    } catch {
      return [];
    }
  })();
  for (const id of ids) {
    const o = objects.get(id);
    if (!o) continue;
    const next = syncFile(path, out, o, { overwriteEdited: false });
    if (next !== null) {
      out = next;
      changed = true;
    }
  }
  return changed ? out : null;
}

export { parseSequence, serializeSequence };
