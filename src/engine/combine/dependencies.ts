/**
 * Dependency checks for a proposed combination: what the picked parts rely on (living objects,
 * the object stylesheet, story pages and the elements story steps look for) and which stories the
 * combination makes worth checking again. Each finding is evidence from the files; nothing is run.
 */
import type { ProjectEngine } from '../project';
import type { Hash } from '../store/objects';
import { diffTrees } from '../merge/treeMerge';
import { OBJECTS_CSS, objectPath } from '../../shared/objects';
import { STORY_DIR, describeStep, type Story } from '../../shared/stories';
import { parseStory, storyDependencies } from '../../stories/model';
import type { CombineWarning, ContentRef } from '../../shared/types';

export interface DependencySource {
  ref: ContentRef;
  label: string;
  tree: ReadonlyMap<string, Hash>;
}

const TEXT = /\.(html?|m?js|jsx|tsx?|css|json|vue|svelte)$/i;

export async function dependencyWarnings(engine: ProjectEngine, input: { start: ReadonlyMap<string, Hash>; tree: ReadonlyMap<string, Hash>; sources: DependencySource[]; destLabel: string }): Promise<CombineWarning[]> {
  const { start, tree, sources } = input;
  const changed = new Set(diffTrees(new Map(start), new Map(tree)).map((c) => c.path));
  if (changed.size === 0) return [];
  const cache = new Map<Hash, string>();
  const text = async (h: Hash | undefined): Promise<string | null> => {
    if (!h) return null;
    let t = cache.get(h);
    if (t === undefined) {
      t = (await engine.readBlob(h)).toString('utf8');
      cache.set(h, t);
    }
    return t;
  };
  const out: CombineWarning[] = [];
  const seen = new Set<string>();
  const add = (w: CombineWarning): void => {
    const key = `${w.kind}|${w.path ?? ''}|${w.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(w);
    }
  };
  const fromSource = (path: string): DependencySource | null => sources.find((s) => s.tree.has(path)) ?? null;
  const include = (path: string): { path: string; source: ContentRef } | undefined => {
    const s = fromSource(path);
    return s ? { path, source: s.ref } : undefined;
  };
  const objectName = async (id: string): Promise<string> => {
    const s = fromSource(objectPath(id));
    const raw = s ? await text(s.tree.get(objectPath(id))) : null;
    try {
      return raw ? (JSON.parse(raw) as { name?: string }).name ?? id : id;
    } catch {
      return id;
    }
  };

  // 1. Living objects used by changed pages and timelines.
  for (const path of changed) {
    const h = tree.get(path);
    if (!h) continue;
    const ids = new Set<string>();
    if (/\.html?$/i.test(path)) {
      const t = (await text(h)) ?? '';
      for (const m of t.matchAll(/data-mv-object\s*=\s*["']([a-z0-9-]+)["']/g)) ids.add(m[1]!);
      if (ids.size && !tree.has(OBJECTS_CSS) && !t.includes(OBJECTS_CSS)) {
        add({ severity: 'warning', kind: 'dependency', path: OBJECTS_CSS, message: `${path} shows living objects, but their stylesheet ${OBJECTS_CSS} is not in the result. They would appear unstyled.`, include: include(OBJECTS_CSS) });
      } else if (ids.size && !tree.has(OBJECTS_CSS)) {
        add({ severity: 'warning', kind: 'dependency', path: OBJECTS_CSS, message: `${path} links ${OBJECTS_CSS}, which is not in the result.`, include: include(OBJECTS_CSS) });
      }
    } else if (/^sequences\/.+\.mvseq\.json$/.test(path)) {
      try {
        const seq = JSON.parse((await text(h)) ?? '{}') as { tracks?: { clips?: { object?: { id?: string } }[] }[] };
        for (const t of seq.tracks ?? []) for (const c of t.clips ?? []) if (c.object?.id) ids.add(c.object.id);
      } catch {
        /* unreadable timelines are reported by the timeline checks */
      }
    }
    for (const id of ids) {
      const p = objectPath(id);
      if (tree.has(p)) continue;
      const name = await objectName(id);
      add({
        severity: 'warning',
        kind: 'dependency',
        path: p,
        message: `${path} uses the living object “${name}”, which is not in ${input.destLabel}. ${fromSource(p) ? 'Include it so later edits still reach this placement.' : 'No version being combined has it; the placement keeps its current content but will not update.'}`,
        include: include(p),
      });
    }
  }

  // 2. Stories: missing pages and step targets, and which ones the combination makes worth re-running.
  const all = [...tree.keys()];
  const texts = new Map<string, string>();
  for (const p of all) if (TEXT.test(p) && !p.startsWith('node_modules/')) texts.set(p, (await text(tree.get(p))) ?? '');
  for (const path of all) {
    if (!path.startsWith(`${STORY_DIR}/`) || !path.endsWith('.mvstory.json')) continue;
    let story: Story;
    try {
      story = parseStory((await text(tree.get(path))) ?? '', path);
    } catch {
      continue;
    }
    const pages = [story.page, ...story.steps.flatMap((s) => (s.kind === 'open' ? [s.path] : []))].filter((p) => p !== 'dev-server').map((p) => p.replace(/^\/+/, '').replace(/(^|\/)$/, '$1index.html'));
    for (const p of pages) {
      if (tree.has(p)) continue;
      add({ severity: 'warning', kind: 'dependency', path: p, message: `The story “${story.name}” opens ${p}, which is not in the result.`, include: include(p) });
    }
    for (const step of story.steps) {
      const target = 'target' in step ? step.target : null;
      if (!target || (target.by !== 'testid' && target.by !== 'mv-id')) continue;
      const attr = target.by === 'testid' ? 'data-testid' : 'data-mv-id';
      const needle = target.value;
      if ([...texts.values()].some((t) => t.includes(needle))) continue;
      let where: { path: string; source: DependencySource } | null = null;
      for (const s of sources) {
        for (const [p, h] of s.tree) {
          if (!TEXT.test(p) || p.startsWith('node_modules/')) continue;
          const t = await text(h);
          if (t?.includes(`${attr}="${needle}"`) || t?.includes(`'${needle}'`) || t?.includes(`"${needle}"`)) {
            where = { path: p, source: s };
            break;
          }
        }
        if (where) break;
      }
      add({
        severity: 'warning',
        kind: 'dependency',
        path: where?.path ?? path,
        message: `“${describeStep(step)}” in the story “${story.name}” looks for ${attr}="${needle}", which no file in the result contains.${where ? ` ${where.path} in ${where.source.label} has it.` : ''}`,
        include: where && where.path !== path ? { path: where.path, source: where.source.ref } : undefined,
      });
    }
    const read = (p: string): string | null => texts.get(p) ?? null;
    const { deps, certain } = storyDependencies(story, tree as ReadonlyMap<string, string>, read);
    const touched = [path, ...deps].filter((p) => changed.has(p));
    if (touched.length) {
      add({
        severity: 'info',
        kind: 'story',
        path,
        message: `“${story.name}” ${certain ? 'will need checking' : 'may need checking'} after this combination: ${touched.slice(0, 3).join(', ')}${touched.length > 3 ? '…' : ''} change${touched.length === 1 ? 's' : ''}. Its earlier result does not cover the combined files.`,
      });
    }
  }
  return out;
}
