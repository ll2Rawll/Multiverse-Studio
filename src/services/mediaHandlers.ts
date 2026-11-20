/**
 * IPC handlers for AI media (generation jobs, transcription, preview recording), AI timeline
 * edits, shared brand settings and shared media placed into versions.
 */
import { randomUUID } from 'node:crypto';
import type { ChannelInput, ChannelName, ChannelOutput } from '../shared/ipc';
import { SHARED_LINE_ID, type StudioEvent } from '../shared/types';
import type { AssetLinkView, AssetUsageView, BrandPlanItemView, BrandPlanView, BrandSettingsView, MediaJobKind, RecordingRequest } from '../shared/media';
import type { StudioService } from './studio';
import type { AiService } from '../ai/service';
import type { BrowserProbe } from '../agent/browser';
import type { ProjectEngine } from '../engine/project';
import { StudioError } from '../engine/errors';
import { GenerationJobs } from '../video/generation';
import { TimelineAi } from '../video/aiEdit';
import { AssetLinkStore, defaultPlacement } from '../video/links';
import { planVideoTitles, planWebsiteTheme, tokenFor, type BrandPlanItem } from '../video/brand';
import { SEQUENCE_DIR, sequencePath } from '../video/sequence';
import { usedAssets } from '../video/service';
import { readTheme } from '../design/styles';
import { normalizeProjectPath } from '../shared/paths';
import { brandSchema } from '../engine/store/records';
import { promises as fs } from 'node:fs';

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };

export interface MediaRuntime {
  jobs: GenerationJobs;
  timeline: TimelineAi;
  shutdown(): Promise<void>;
}

export function createMediaRuntime(
  studio: StudioService,
  emit: (event: StudioEvent) => void,
  options: { ai: AiService | null; probe: BrowserProbe | null; cacheRoot: string },
): { runtime: MediaRuntime; handlers: Handlers } {
  const video = studio.video;
  const linkStores = new Map<string, AssetLinkStore>();
  const links = async (projectId: string): Promise<AssetLinkStore> => {
    let s = linkStores.get(projectId);
    if (!s) {
      s = new AssetLinkStore((await studio.engine(projectId)).dir);
      linkStores.set(projectId, s);
    }
    return s;
  };

  const jobs = new GenerationJobs({
    ai: () => options.ai,
    video,
    probe: options.probe,
    emit,
    cacheRoot: options.cacheRoot,
    projectDir: async (projectId) => (await studio.engine(projectId)).dir,
    recordingUrl: async (projectId, lineId, page) => {
      if (page === 'dev-server') {
        const state = await studio.build?.state(projectId, lineId);
        const server = state?.processes.find((p) => p.kind === 'dev-server' && p.status === 'ready' && p.url);
        if (!server?.url) throw new StudioError('no-dev-server', 'Start the dev server for this version in Build first, then record it.');
        return server.url;
      }
      const handle = await studio.call('preview.open', { projectId, ref: { kind: 'line', lineId } });
      return new URL(normalizeProjectPath(page), handle.url.replace(/[^/]*$/, '')).toString();
    },
  });

  const timeline = new TimelineAi({
    ai: () => options.ai,
    video,
    readFiles: async (projectId, lineId, paths) => {
      const engine = await studio.engine(projectId);
      const tree = await engine.effectiveTree(lineId);
      const out = new Map<string, string | null>();
      for (const p of paths) {
        const h = tree.get(p);
        out.set(p, h ? (await engine.readBlob(h)).toString('utf8') : null);
      }
      return out;
    },
  });
  const planning = new Map<string, AbortController>();

  /* ---------------- shared media ---------------- */

  const lineName = (engine: ProjectEngine, lineId: string): string => (lineId === SHARED_LINE_ID ? 'Shared' : (engine.data.lines[lineId]?.name ?? lineId));
  const allLines = (engine: ProjectEngine): string[] => [SHARED_LINE_ID, ...engine.alternatives().map((l) => l.id)];

  async function linkViews(projectId: string): Promise<AssetLinkView[]> {
    const engine = await studio.engine(projectId);
    const store = await video.store(projectId);
    const assets = new Map((await store.load()).assets.map((a) => [a.id, a]));
    const records = await (await links(projectId)).list();
    const out: AssetLinkView[] = [];
    for (const lineId of allLines(engine)) {
      const tree = await engine.effectiveTree(lineId);
      const seen = new Set<string>();
      // Newest placement first, so a re-placed copy is judged against its latest record.
      for (const r of [...records].reverse()) {
        if (seen.has(r.path) || tree.get(r.path) !== r.blob) continue;
        seen.add(r.path);
        const asset = assets.get(r.assetId);
        if (!asset) continue;
        out.push({ lineId, lineName: lineName(engine, lineId), path: r.path, assetId: r.assetId, sha256: r.assetSha, outdated: asset.sha256 !== r.assetSha });
      }
    }
    return out;
  }

  async function place(projectId: string, lineId: string, assetId: string, rawPath: string | null, replace: boolean, label?: string): Promise<{ path: string; changed: boolean }> {
    const engine = await studio.engine(projectId);
    const store = await video.store(projectId);
    const asset = await store.get(assetId);
    const file = (await store.filePath(assetId, 'original'))?.path;
    if (!file) throw new StudioError('media-missing', `${asset.name} is missing. Relink it in Assets first.`);
    const target = normalizeProjectPath(rawPath ?? defaultPlacement(asset.kind, asset.name, asset.ext));
    const data = await fs.readFile(file);
    const tree = await engine.effectiveTree(lineId);
    const existing = tree.get(target);
    if (existing && !replace) {
      const same = (await engine.readBlob(existing)).equals(data);
      if (!same) throw new StudioError('file-exists', `${target} already exists in ${lineName(engine, lineId)}. Choose another name or replace it.`);
    }
    const result = await studio.commands.run(engine, lineId, 'assets.place', { path: target, data, label: label ?? `Place ${asset.name}` }, { actor: 'user', expected: { [target]: existing ?? null } });
    const blob = result.hashes[target];
    if (blob) await (await links(projectId)).add({ path: target, blob, assetId, assetSha: asset.sha256, placedAt: new Date().toISOString() });
    return { path: target, changed: blob !== existing };
  }

  /* ---------------- brand ---------------- */

  const plans = new Map<string, { projectId: string; items: BrandPlanItem[] }>();

  async function brandPlan(projectId: string): Promise<BrandPlanView & { planId: string }> {
    const engine = await studio.engine(projectId);
    const brand = engine.data.brand;
    const store = await video.store(projectId);
    const fontAssets = new Map((await store.load()).assets.filter((a) => a.kind === 'font').map((a) => [a.id, { name: a.name, ext: a.ext, sha256: a.sha256 }]));
    const items: BrandPlanItem[] = [];
    const tokensSeen = new Set<string>();
    const stylesUsed = new Set<string>();
    for (const lineId of allLines(engine)) {
      const tree = await engine.effectiveTree(lineId);
      const name = lineName(engine, lineId);
      const sheets = [...tree.keys()].filter((p) => p.endsWith('.css')).sort((a, b) => (a.endsWith('theme.css') ? -1 : b.endsWith('theme.css') ? 1 : a.localeCompare(b)));
      for (const sheet of sheets) {
        const css = (await engine.readBlob(tree.get(sheet)!)).toString('utf8');
        const tokens = readTheme(css);
        if (!tokens.length) continue;
        for (const t of tokens) tokensSeen.add(t.name);
        const plan = planWebsiteTheme(brand, sheet, tokens, fontAssets);
        const hasBlock = css.includes('mv:brand-fonts');
        let faces: typeof plan.faces | null = null;
        if (plan.faces.length || hasBlock) {
          const wanted = plan.faces.map((f) => `${f.family}|${f.src}`).sort().join(',');
          const present = [...css.matchAll(/font-family:\s*"([^"]+)";\s*src:\s*url\("([^"]+)"\)/g)].map((m) => `${m[1]}|${m[2]}`).sort().join(',');
          if (wanted !== present) faces = plan.faces;
        }
        const fontFiles = plan.fontFiles.filter((f) => !tree.has(f.path));
        if (Object.keys(plan.tokens).length || faces || fontFiles.length) {
          // One command per site, so the whole brand update of a site undoes in one step.
          items.push({ id: `${lineId}:theme`, lineId, lineName: name, kind: 'website-theme', target: sheet, changes: plan.changes.length ? plan.changes : ['Brand fonts'], commands: [{ name: 'design.applyBrand', args: { stylesheet: sheet, tokens: plan.tokens, faces } }], expected: { [sheet]: tree.get(sheet)! }, fontFiles });
        }
        break;
      }
      for (const { sequence } of await video.sequences(projectId, lineId)) {
        if (!sequence) continue;
        for (const t of sequence.tracks) for (const c of t.clips) if (c.type === 'text' && c.brandStyleId) stylesUsed.add(c.brandStyleId);
        const plan = planVideoTitles(brand, sequence);
        if (!plan.steps.length) continue;
        const p = sequencePath(sequence.id);
        items.push({ id: `${lineId}:seq:${sequence.id}`, lineId, lineName: name, kind: 'video-titles', target: sequence.name, changes: plan.changes, commands: [{ name: 'video.batch', args: { sequence: sequence.id, label: 'Apply brand styles', steps: plan.steps } }], expected: { [p]: tree.get(p) ?? null }, fontFiles: [] });
      }
    }
    const notes: string[] = [];
    for (const c of brand.colors) if (!tokensSeen.has(tokenFor('color', c.name)) && tokensSeen.size) notes.push(`“${c.name}” doesn’t match a theme token (${tokenFor('color', c.name)}) in any site, so it only applies to titles.`);
    for (const f of brand.fonts) if (!tokensSeen.has(tokenFor('font', f.name)) && tokensSeen.size) notes.push(`“${f.name}” doesn’t match a theme token (${tokenFor('font', f.name)}) in any site.`);
    for (const s of brand.textStyles) if (!stylesUsed.has(s.id)) notes.push(`No title follows “${s.name}” yet. Choose it for a title in the clip inspector.`);
    const planId = `bp-${randomUUID().slice(0, 10)}`;
    plans.set(planId, { projectId, items });
    for (const k of [...plans.keys()].slice(0, -20)) plans.delete(k);
    const view = (i: BrandPlanItem): BrandPlanItemView => ({ id: i.id, lineId: i.lineId, lineName: i.lineName, kind: i.kind, target: i.target, changes: i.changes, fontFiles: i.fontFiles });
    return { planId, items: items.map(view), notes };
  }

  async function usage(projectId: string, assetId: string): Promise<AssetUsageView> {
    const engine = await studio.engine(projectId);
    const sequences: AssetUsageView['sequences'] = [];
    for (const lineId of allLines(engine)) {
      for (const { sequence } of await video.sequences(projectId, lineId)) {
        if (!sequence || !usedAssets(sequence).includes(assetId)) continue;
        const clips = sequence.tracks.reduce((n, t) => n + t.clips.filter((c) => (c.type === 'media' ? c.assetId === assetId : c.style.fontAssetId === assetId)).length, 0);
        sequences.push({ lineId, lineName: lineName(engine, lineId), sequenceId: sequence.id, sequenceName: sequence.name, clips });
      }
    }
    const brand = engine.data.brand;
    const inBrand = [...brand.fonts.filter((f) => f.assetId === assetId).map((f) => `Brand font “${f.name}”`), ...(brand.logoAssetId === assetId ? ['Brand logo'] : [])];
    return { assetId, sequences, files: (await linkViews(projectId)).filter((l) => l.assetId === assetId), brand: inBrand };
  }

  const handlers: Handlers = {
    'media.jobs.list': async ({ projectId }) => jobs.list(projectId),
    'media.jobs.plan': async ({ projectId, job }) => jobs.plan(projectId, job.kind, job.request as never),
    'media.jobs.start': async ({ projectId, job }) => {
      if (job.kind === 'recording') await studio.engine(projectId).then((e) => e.line((job.request as RecordingRequest).lineId));
      return jobs.start(projectId, job.kind as MediaJobKind, job.request as never);
    },
    'media.jobs.cancel': async ({ projectId, jobId }) => jobs.cancel(projectId, jobId),
    'media.jobs.retry': async ({ projectId, jobId, confirmUncertain }) => jobs.retry(projectId, jobId, confirmUncertain),
    'media.transcript': async ({ projectId, assetId }) => (await video.store(projectId)).transcript(assetId),
    'media.setTags': async ({ projectId, assetId, tags }) => {
      await (await video.store(projectId)).setTags(assetId, tags);
      return true;
    },
    'media.usage': async ({ projectId, assetId }) => usage(projectId, assetId),

    'assets.links': async ({ projectId }) => linkViews(projectId),
    'assets.place': async ({ projectId, lineId, assetId, path, replace }) => {
      const engine = await studio.engine(projectId);
      const r = await place(projectId, lineId, assetId, path ?? null, replace ?? false);
      await studio.changed(engine, 'command', [lineId]);
      return r;
    },
    'assets.updateLinks': async ({ projectId, items }) => {
      const engine = await studio.engine(projectId);
      const current = await linkViews(projectId);
      const updated: { lineId: string; path: string }[] = [];
      const failed: { lineId: string; path: string; reason: string }[] = [];
      for (const it of items) {
        const link = current.find((l) => l.lineId === it.lineId && l.path === it.path && l.outdated);
        if (!link) {
          failed.push({ ...it, reason: 'This copy is no longer outdated or was changed by hand.' });
          continue;
        }
        try {
          await place(projectId, it.lineId, link.assetId, it.path, true, `Update ${it.path}`);
          updated.push(it);
        } catch (error) {
          failed.push({ ...it, reason: (error as Error).message });
        }
      }
      if (updated.length) await studio.changed(engine, 'command', [...new Set(updated.map((u) => u.lineId))]);
      return { updated, failed };
    },

    'video.ai.analyze': async ({ projectId, lineId, sequenceId, op, options: opts }) => timeline.analyze(projectId, lineId, sequenceId, op, opts ?? {}),
    'video.ai.plan': async ({ projectId, lineId, sequenceId, instruction }) => {
      planning.get(projectId)?.abort();
      const abort = new AbortController();
      planning.set(projectId, abort);
      try {
        return await timeline.plan(projectId, lineId, sequenceId, instruction, abort.signal);
      } finally {
        if (planning.get(projectId) === abort) planning.delete(projectId);
      }
    },
    'video.ai.cancel': async ({ projectId }) => {
      planning.get(projectId)?.abort();
      return true;
    },
    'video.ai.discard': async ({ proposalId }) => {
      timeline.discard(proposalId);
      return true;
    },
    'video.ai.apply': async ({ projectId, proposalId, asAlternative }) => {
      const engine = await studio.engine(projectId);
      const p = timeline.take(projectId, proposalId);
      const seqPath = sequencePath(p.sequenceId);
      const tree = await engine.effectiveTree(p.lineId);
      if (tree.get(seqPath) !== p.baseHash) throw new StudioError('stale-command', `“${p.sequenceName}” changed after this edit was proposed. Nothing was changed; ask again.`);
      if (!p.stepList.length) throw new StudioError('invalid', 'This proposal has no changes to apply.');
      const checkpoint = await engine.createCheckpoint(`Before: ${p.summary.slice(0, 60)}`, `Saved automatically before an ${p.model ? 'AI' : 'automatic'} timeline edit of “${p.sequenceName}”.`);
      let target = p.lineId;
      if (asAlternative) {
        const line = await engine.createAlternative({ from: { kind: 'line', lineId: p.lineId }, name: asAlternative.name, color: studio.nextColor(engine), description: `${p.summary} (from ${lineName(engine, p.lineId)})`.slice(0, 500), following: true, includeDraft: true });
        target = line.id;
      }
      const result = await studio.commands.run(engine, target, 'video.batch', { sequence: p.sequenceId, label: p.summary.slice(0, 200), steps: p.stepList }, { actor: p.model ? 'ai-task' : 'user', expected: { [seqPath]: p.baseHash } });
      timeline.discard(proposalId);
      const project = await studio.changed(engine, asAlternative ? 'create' : 'command', [target]);
      void project;
      return { lineId: target, label: result.record.label, checkpointId: checkpoint.id, hashes: result.hashes };
    },

    'brand.get': async ({ projectId }) => structuredClone((await studio.engine(projectId)).data.brand) as BrandSettingsView,
    'brand.set': async ({ projectId, brand }) => {
      const engine = await studio.engine(projectId);
      const parsed = brandSchema.safeParse(brand);
      if (!parsed.success) throw new StudioError('invalid', `Brand settings: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
      const ids = new Set<string>();
      for (const x of [...parsed.data.colors, ...parsed.data.fonts, ...parsed.data.textStyles]) {
        if (ids.has(x.id)) throw new StudioError('invalid', 'Two brand entries share an id.');
        ids.add(x.id);
      }
      await engine.setBrand(parsed.data);
      await studio.changed(engine, 'brand', []);
      return structuredClone(engine.data.brand) as BrandSettingsView;
    },
    'brand.plan': async ({ projectId }) => brandPlan(projectId),
    'brand.apply': async ({ projectId, planId, itemIds }) => {
      const plan = plans.get(planId);
      if (!plan || plan.projectId !== projectId) throw new StudioError('not-found', 'This preview is out of date. Preview the brand update again.');
      const engine = await studio.engine(projectId);
      const chosen = plan.items.filter((i) => itemIds.includes(i.id));
      if (!chosen.length) throw new StudioError('invalid', 'Choose at least one change to apply.');
      const checkpoint = await engine.createCheckpoint('Before brand update', `Saved automatically before applying brand settings to ${chosen.length} place${chosen.length === 1 ? '' : 's'}.`);
      const applied: string[] = [];
      const failed: { id: string; reason: string }[] = [];
      for (const item of chosen) {
        try {
          const store = await video.store(projectId);
          const fontData: { path: string; data: Buffer; assetId: string; assetSha: string }[] = [];
          for (const f of item.fontFiles) {
            const rec = await store.get(f.assetId);
            const file = (await store.filePath(f.assetId, 'original'))?.path;
            if (!file) throw new StudioError('media-missing', `${rec.name} is missing. Relink it in Assets first.`);
            fontData.push({ path: f.path, data: await fs.readFile(file), assetId: f.assetId, assetSha: rec.sha256 });
          }
          const expected: Record<string, string | null> = { ...item.expected };
          for (const f of fontData) expected[f.path] = null;
          for (const c of item.commands) {
            const args = c.name === 'design.applyBrand' ? { ...c.args, files: fontData.map((f) => ({ path: f.path, data: f.data })) } : c.args;
            const r = await studio.commands.run(engine, item.lineId, c.name, args, { actor: 'user', expected });
            for (const [p, h] of Object.entries(r.hashes)) if (p in expected) expected[p] = h;
            for (const f of fontData) {
              const blob = r.hashes[f.path];
              if (blob) await (await links(projectId)).add({ path: f.path, blob, assetId: f.assetId, assetSha: f.assetSha, placedAt: new Date().toISOString() });
            }
          }
          applied.push(item.id);
        } catch (error) {
          failed.push({ id: item.id, reason: (error as Error).message });
        }
      }
      plans.delete(planId);
      await studio.changed(engine, 'command', [...new Set(chosen.map((c) => c.lineId))]);
      return { applied, failed, checkpointId: checkpoint.id };
    },
  };

  return {
    runtime: {
      jobs,
      timeline,
      shutdown: async () => {
        for (const a of planning.values()) a.abort();
        await jobs.shutdown();
      },
    },
    handlers,
  };
}

export { SEQUENCE_DIR };
