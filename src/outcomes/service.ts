/**
 * Outcomes of universes side by side: pages, living objects, stories, timelines, renders, deploys
 * and tests. Read from the files or from measured runs; each measured result is tied to the files
 * it ran on and reported as current only while those files are unchanged.
 */
import type { StudioService } from '../services/studio';
import type { ContentRef } from '../shared/types';
import type { ObjectOutcome, OutcomeSide, PageOutcome, ReleaseDestinationView, ReleaseOutcome, RenderOutcome, StoryOutcome, TimelineOutcome, UniverseOutcomes } from '../shared/outcomes';
import { refLabel } from '../engine/combine/combine';
import { diffTrees } from '../engine/merge/treeMerge';
import { parseSequence } from '../video/sequence';
import { sequenceDuration, ticksToSeconds } from '../shared/video';
import { fileSetHash, selectFiles } from '../publish/service';
import { codeHash, readTestRuns } from './validation';

const MAX_PAGES = 60;
const tag = (html: string, name: string): string => (new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(html)?.[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const flat = (v: unknown): string => (Array.isArray(v) ? v.join(' · ') : typeof v === 'string' ? v : JSON.stringify(v));

export async function universeOutcomes(studio: StudioService, projectId: string, refs: ContentRef[]): Promise<UniverseOutcomes> {
  const engine = await studio.engine(projectId);
  const resolved = await Promise.all(refs.map((r) => engine.resolveRef(r)));
  const text = async (h: string): Promise<string> => (await engine.readBlob(h)).toString('utf8');

  const sides: OutcomeSide[] = refs.map((ref, i) => {
    const r = resolved[i]!;
    const line = r.lineId ? engine.line(r.lineId) : null;
    const files = i === 0 ? null : diffTrees(resolved[0]!.tree, r.tree).reduce((acc, c) => (c.status === 'added' ? acc.added++ : c.status === 'deleted' ? acc.deleted++ : acc.modified++, acc), { added: 0, deleted: 0, modified: 0 });
    return { ref, label: refLabel(engine, ref), lineId: r.lineId, revision: r.revisionId ?? line?.head ?? null, draft: ref.kind === 'line' && Boolean(line?.draftTree), files };
  });
  const isCurrent = (i: number): boolean => refs[i]!.kind === 'line';

  // Pages
  const pagePaths = [...new Set(resolved.flatMap((r) => [...r.tree.keys()].filter((p) => /\.html?$/i.test(p) && !/^(node_modules|walkthroughs|dist|build)\//.test(p))))].sort().slice(0, MAX_PAGES);
  const pages: PageOutcome[] = [];
  for (const p of pagePaths) {
    pages.push({
      path: p,
      sides: await Promise.all(
        resolved.map(async (r) => {
          const h = r.tree.get(p);
          if (!h) return null;
          const t = await text(h);
          return { hash: h, title: tag(t, 'title'), heading: tag(t, 'h1') };
        }),
      ),
    });
  }

  // Living objects (with how many placements each side has)
  const objectIds = [...new Set(resolved.flatMap((r) => [...r.tree.keys()].filter((p) => /^objects\/.+\.mvobj\.json$/.test(p)).map((p) => p.slice(8, -11))))].sort();
  const placementCounts = await Promise.all(
    resolved.map(async (r) => {
      const counts = new Map<string, number>();
      for (const [p, h] of r.tree) {
        if (/\.html?$/i.test(p) && !p.startsWith('node_modules/')) for (const m of (await text(h)).matchAll(/data-mv-object\s*=\s*["']([a-z0-9-]+)["']/g)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
        else if (/^sequences\/.+\.mvseq\.json$/.test(p)) {
          try {
            for (const t of parseSequence(await text(h)).tracks) for (const c of t.clips) if (c.type === 'text' && c.object) counts.set(c.object.id, (counts.get(c.object.id) ?? 0) + 1);
          } catch {
            /* unreadable timeline */
          }
        }
      }
      return counts;
    }),
  );
  const objects: ObjectOutcome[] = [];
  for (const id of objectIds) {
    const s = await Promise.all(
      resolved.map(async (r, i) => {
        const h = r.tree.get(`objects/${id}.mvobj.json`);
        if (!h) return null;
        try {
          const o = JSON.parse(await text(h)) as { name: string; type: string; properties: Record<string, unknown> };
          return { name: o.name, type: o.type, properties: Object.fromEntries(Object.entries(o.properties ?? {}).map(([k, v]) => [k, flat(v)])), placements: placementCounts[i]!.get(id) ?? 0 };
        } catch {
          return null;
        }
      }),
    );
    const present = s.filter((x): x is NonNullable<typeof x> => x !== null);
    const keys = [...new Set(present.flatMap((x) => Object.keys(x.properties)))];
    objects.push({ id, sides: s, differs: keys.filter((k) => new Set(present.map((x) => x.properties[k] ?? '')).size > 1) });
  }

  // Stories (measured: status of the latest run of that universe against these exact files)
  const storyLists = await Promise.all(resolved.map((r, i) => (r.lineId ? studio.stories.list(projectId, r.lineId, isCurrent(i) ? undefined : new Map(r.tree)).catch(() => []) : Promise.resolve([]))));
  const storyIds = [...new Set(storyLists.flatMap((l) => l.map((s) => s.id)))].sort();
  const stories: StoryOutcome[] = storyIds.map((id) => {
    const any = storyLists.flat().find((s) => s.id === id)!;
    return {
      id,
      name: any.name,
      sides: storyLists.map((l) => {
        const s = l.find((x) => x.id === id);
        return s ? { status: s.status, detail: s.statusDetail, at: s.lastRun?.at ?? null, revision: s.lastRun?.revision ?? null, steps: s.steps.length } : null;
      }),
    };
  });

  // Timelines
  const seqIds = [...new Set(resolved.flatMap((r) => [...r.tree.keys()].filter((p) => /^sequences\/[^/]+\.mvseq\.json$/.test(p)).map((p) => p.slice(10, -11))))].sort();
  const timelines: TimelineOutcome[] = [];
  for (const id of seqIds) {
    timelines.push({
      id,
      sides: await Promise.all(
        resolved.map(async (r) => {
          const h = r.tree.get(`sequences/${id}.mvseq.json`);
          if (!h) return null;
          try {
            const seq = parseSequence(await text(h));
            return { name: seq.name, seconds: Math.round(ticksToSeconds(sequenceDuration(seq)) * 10) / 10, clips: seq.tracks.reduce((n, t) => n + t.clips.length, 0), tracks: seq.tracks.length, hash: h };
          } catch {
            return null;
          }
        }),
      ),
    });
  }

  // Renders: completed exports of each universe (for earlier versions, only exports made from that exact revision)
  const exports = (await studio.video.listExports(projectId).catch(() => [])).filter((x) => x.state === 'completed');
  const renderSeqs = [...new Set(exports.filter((x) => sides.some((s) => s.lineId === x.lineId)).map((x) => x.sequenceId))].sort();
  const renders: RenderOutcome[] = renderSeqs.map((sequenceId) => ({
    sequenceId,
    sides: sides.map((s, i) => {
      const x = exports
        .filter((e) => e.sequenceId === sequenceId && e.lineId === s.lineId && (isCurrent(i) || (e.revision && e.revision === s.revision && !e.draft)))
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
      if (!x) return null;
      return { sequenceName: x.sequenceName, at: x.finishedAt ?? x.createdAt, format: x.settings.format, seconds: x.verified?.durationSeconds ?? null, outdated: isCurrent(i) ? (x.outdated?.detail ?? null) : null, revision: x.revision ?? null };
    }),
  }));

  // Releases: confirmed deploys of each universe
  const deploys = (await studio.publish.list(projectId).catch(() => [])).filter((d) => d.state === 'completed');
  const targetIds = [...new Set(deploys.filter((d) => sides.some((s) => s.lineId === d.lineId)).map((d) => d.targetId))];
  const releases: ReleaseOutcome[] = [];
  for (const targetId of targetIds) {
    const name = deploys.find((d) => d.targetId === targetId)!.targetName;
    releases.push({
      targetId,
      targetName: name,
      sides: await Promise.all(
        sides.map(async (s, i) => {
          const d = deploys
            .filter((x) => x.targetId === targetId && x.lineId === s.lineId && (isCurrent(i) || (x.revision === s.revision && !x.draft)))
            .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
          if (!d) return null;
          const current = d.sourceHash ? fileSetHash(selectFiles(resolved[i]!.tree, d.folder).files) === d.sourceHash : null;
          return { at: d.finishedAt ?? d.createdAt, url: d.url, revision: d.revision ?? null, current, detail: current === null ? 'Published before exact sources were recorded.' : current ? 'The published files match these files.' : 'These files changed since this was published.' };
        }),
      ),
    });
  }

  // Tests: latest recorded run of each universe, current only on the same code files
  const runs = await readTestRuns(engine.dir);
  const tests = {
    sides: sides.map((s, i) => {
      if (!s.lineId) return null;
      const hash = codeHash(resolved[i]!.tree);
      const r = (isCurrent(i) ? runs.filter((x) => x.lineId === s.lineId) : runs.filter((x) => x.lineId === s.lineId && x.sourceHash === hash))[0];
      return r ? { at: r.at, passed: r.passed, exitCode: r.exitCode, current: r.sourceHash === hash, revision: r.revision } : null;
    }),
  };

  return { sides, pages, objects, stories, timelines, renders, releases, tests };
}

/** Each destination's own status. Destinations are released separately; nothing here is atomic. */
export async function releaseDestinations(studio: StudioService, projectId: string): Promise<ReleaseDestinationView[]> {
  const engine = await studio.engine(projectId);
  const out: ReleaseDestinationView[] = [];
  const deploys = await studio.publish.list(projectId).catch(() => []);
  const trees = new Map<string, Map<string, string> | null>();
  const treeOf = async (lineId: string): Promise<Map<string, string> | null> => {
    if (!trees.has(lineId)) trees.set(lineId, await engine.effectiveTree(lineId).catch(() => null));
    return trees.get(lineId) ?? null;
  };
  for (const targetId of [...new Set(deploys.map((d) => d.targetId))]) {
    const mine = deploys.filter((d) => d.targetId === targetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = mine[0]!;
    const live = mine.find((d) => d.state === 'completed') ?? null;
    let current: boolean | null = null;
    let currentDetail = 'Nothing has been published here yet.';
    if (live) {
      const tree = await treeOf(live.lineId);
      if (!tree) currentDetail = `${live.lineName} was deleted after it was published.`;
      else if (!live.sourceHash) currentDetail = 'Published before exact sources were recorded.';
      else {
        current = fileSetHash(selectFiles(tree, live.folder).files) === live.sourceHash;
        currentDetail = current ? `Serving ${live.lineName} as it is now.` : `${live.lineName} changed since; the host still serves the earlier files.`;
      }
    }
    out.push({
      key: `publish:${targetId}`,
      kind: 'website',
      name: latest.targetName,
      latest: { jobId: latest.id, state: latest.state, at: latest.finishedAt ?? latest.createdAt, lineId: latest.lineId, lineName: latest.lineName, revision: latest.revision ?? null, draft: latest.draft ?? false, detail: latest.error ?? latest.detail },
      live: live ? { jobId: live.id, at: live.finishedAt ?? live.createdAt, lineId: live.lineId, lineName: live.lineName, revision: live.revision ?? null, draft: live.draft ?? false, sourceHash: live.sourceHash ?? null, url: live.url, output: null } : null,
      current,
      currentDetail,
    });
  }
  const exports = await studio.video.listExports(projectId).catch(() => []);
  const names = new Map<string, string>();
  for (const l of Object.values(engine.data.lines)) names.set(l.id, l.kind === 'shared' ? 'Shared' : l.name);
  for (const key of [...new Set(exports.map((x) => `${x.lineId}/${x.sequenceId}/${x.settings.format}`))]) {
    const mine = exports.filter((x) => `${x.lineId}/${x.sequenceId}/${x.settings.format}` === key).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = mine[0]!;
    const live = mine.find((x) => x.state === 'completed' && x.verified) ?? null;
    const lineName = names.get(latest.lineId) ?? 'Deleted version';
    out.push({
      key: `export:${key}`,
      kind: 'video',
      name: `${latest.sequenceName} (${latest.settings.format.toUpperCase()})`,
      latest: { jobId: latest.id, state: latest.state, at: latest.finishedAt ?? latest.createdAt, lineId: latest.lineId, lineName, revision: latest.revision ?? null, draft: latest.draft ?? false, detail: latest.error ?? (latest.state === 'completed' ? 'Exported and checked' : `${Math.round(latest.progress * 100)}%`) },
      live: live ? { jobId: live.id, at: live.finishedAt ?? live.createdAt, lineId: live.lineId, lineName, revision: live.revision ?? null, draft: live.draft ?? false, sourceHash: live.sourceHash ?? null, url: null, output: live.output } : null,
      current: live ? !live.outdated : null,
      currentDetail: !live ? 'No checked export yet.' : live.outdated ? live.outdated.detail : `Matches ${lineName} as it is now.`,
    });
  }
  return out;
}
