/**
 * objects.* commands: create and edit living objects, place them on pages and in timelines, set
 * instance overrides, update placements and detach them. They are ordinary file commands (pure,
 * validated, revision-checked, undoable), run the same way by the interface and the director.
 */
import { z } from 'zod';
import { CommandError, type CommandDefinition, type CommandRegistry, type FileChanges, type FileTexts } from '../commands/commands';
import { ensureStylesheet } from '../design/commands';
import { indentBlock, insertSection, lineIndent } from '../design/markup';
import { OBJECTS_CSS, OBJECT_TYPES, OBJECT_TYPE_INFO, objectPath, type LivingObject, type ObjectProps } from '../shared/objects';
import { applyVideoCommand, parseSequence, sequencePath, serializeSequence } from '../video/sequence';
import { TEXT_TEMPLATES } from '../shared/video';
import { newObject, objectId, objectProps, pagePlacements, parseObject, placementState, renderVideo, renderWeb, scenePlacementState, serializeObject, videoHash } from './model';

const pagePath = z.string().min(1).max(400).regex(/\.html?$/i, 'Pages are .html files');
const seqId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const instanceId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const ticks = z.number().int().min(0);
const syncPaths = z.array(z.string().min(1).max(400)).max(500);

export const OBJECTS_STYLES = `/* Living objects (Multiverse Studio). Themed by the --mv-* tokens, like the section library. */
.mv-object { padding-block: var(--mv-section-space, 72px); }
.mv-object .mv-container { width: min(1120px, 100% - 2 * var(--mv-gutter, 24px)); margin-inline: auto; }
.mv-obj-card { max-width: 380px; margin-inline: auto; padding: 28px; border: 1px solid var(--mv-color-line, #e3e1ec); border-radius: var(--mv-radius, 12px); background: var(--mv-color-card, #fff); display: grid; gap: 14px; }
.mv-obj-plan { margin: 0; font-family: var(--mv-font-heading, inherit); font-size: 1.25rem; }
.mv-obj-price { margin: 0; color: var(--mv-color-muted, #5b5870); }
.mv-obj-amount { font-family: var(--mv-font-heading, inherit); font-size: 2.6rem; font-weight: 700; color: var(--mv-color-text, #111); }
.mv-obj-list { margin: 0; padding-left: 1.2em; display: grid; gap: 6px; }
.mv-obj-features { max-width: 60ch; }
.mv-obj-heading, .mv-obj-title { margin: 0 0 12px; font-family: var(--mv-font-heading, inherit); font-size: clamp(1.8rem, 3.5vw, 2.6rem); line-height: 1.1; }
.mv-obj-title { font-size: clamp(2.4rem, 5vw, 4rem); }
.mv-obj-subtitle, .mv-obj-body { margin: 0 0 20px; color: var(--mv-color-muted, #5b5870); font-size: 1.15rem; max-width: 60ch; }
.mv-obj-stat { margin: 0; display: grid; gap: 6px; }
.mv-obj-value { font-family: var(--mv-font-heading, inherit); font-size: clamp(3rem, 7vw, 5rem); font-weight: 700; line-height: 1; color: var(--mv-color-primary, #3b3bd6); }
.mv-obj-label { font-size: 1.15rem; }
.mv-obj-source { margin: 8px 0 0; font-size: 0.9rem; color: var(--mv-color-muted, #5b5870); }
`;

function need(files: FileTexts, p: string): string {
  const t = files.get(p);
  if (t === null || t === undefined) throw new CommandError(`${p} does not exist in this version.`);
  return t;
}
function loadObject(files: FileTexts, id: string): LivingObject {
  try {
    return parseObject(need(files, objectPath(id)), objectPath(id));
  } catch (error) {
    throw new CommandError((error as Error).message);
  }
}
const newInstance = (): string => `i${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;

/** Re-render an object's placements in one file. Hand-edited placements are kept unless asked. */
export function syncFile(path: string, text: string, o: LivingObject, opts: { overwriteEdited: boolean; only?: string }): string | null {
  if (/\.html?$/i.test(path)) {
    let out = text;
    let changed = false;
    for (let guard = 0; guard < 200; guard++) {
      const p = pagePlacements(out).find((x) => x.object === o.id && (!opts.only || x.instance === opts.only) && (() => {
        const state = placementState(o, out.slice(x.el.start, x.el.end), x);
        return state === 'outdated' || (state === 'edited' && opts.overwriteEdited);
      })());
      if (!p) break;
      const indent = lineIndent(out, p.el.start);
      out = `${out.slice(0, p.el.start)}${indentBlock(renderWeb(o, p.instance, p.overrides), indent)}${out.slice(p.el.end)}`;
      changed = true;
    }
    return changed ? out : null;
  }
  if (/^sequences\/.+\.mvseq\.json$/.test(path)) {
    const seq = parseSequence(text);
    let changed = false;
    for (const t of seq.tracks)
      for (const c of t.clips) {
        if (c.type !== 'text' || c.object?.id !== o.id || (opts.only && c.object.instance !== opts.only)) continue;
        const state = scenePlacementState(o, c);
        if (state === 'current' && c.object.revision === o.revision) continue;
        if (state === 'edited' && !opts.overwriteEdited) continue;
        const r = renderVideo(o, c.object.overrides ?? {});
        c.text = r.text;
        if (r.subtitle) c.subtitle = r.subtitle;
        else delete c.subtitle;
        c.object = { ...c.object, revision: o.revision, hash: videoHash(r.text, r.subtitle || undefined) };
        changed = true;
      }
    return changed ? serializeSequence(seq) : null;
  }
  return null;
}

const def = <A>(d: CommandDefinition<A>): CommandDefinition<A> => d;

export const objectCommands = [
  def({
    name: 'objects.create',
    schema: z.object({ object: objectId, type: z.enum(OBJECT_TYPES), name: z.string().min(1).max(120), properties: objectProps.optional() }),
    scope: (a) => `object:${a.object}`,
    label: (a) => `Create ${OBJECT_TYPE_INFO[a.type].label.toLowerCase()} “${a.name}”`,
    files: (a) => [objectPath(a.object)],
    apply: (files, a) => {
      if (files.get(objectPath(a.object)) != null) throw new CommandError(`An object with the id “${a.object}” already exists.`);
      return new Map([[objectPath(a.object), serializeObject(newObject(a.object, a.type, a.name, (a.properties ?? {}) as ObjectProps))]]);
    },
  }),
  def({
    name: 'objects.update',
    schema: z.object({
      object: objectId,
      name: z.string().min(1).max(120).optional(),
      properties: objectProps.optional(),
      webOverrides: objectProps.optional(),
      videoOverrides: objectProps.optional(),
      /** Pages and sequences whose placements should be re-rendered in the same step. */
      sync: syncPaths.optional(),
      overwriteEdited: z.boolean().optional(),
    }),
    scope: (a) => `object:${a.object}`,
    label: () => 'Edit living object',
    files: (a) => [objectPath(a.object), ...(a.sync ?? [])],
    apply: (files, a) => {
      const o = loadObject(files, a.object);
      const next: LivingObject = {
        ...o,
        name: a.name ?? o.name,
        properties: { ...o.properties, ...((a.properties ?? {}) as ObjectProps) },
        overrides: { web: { ...(o.overrides.web ?? {}), ...((a.webOverrides ?? {}) as ObjectProps) }, video: { ...(o.overrides.video ?? {}), ...((a.videoOverrides ?? {}) as ObjectProps) } },
      };
      for (const t of ['web', 'video'] as const) if (next.overrides[t] && Object.keys(next.overrides[t]!).length === 0) delete next.overrides[t];
      const changedContent = JSON.stringify([next.properties, next.overrides]) !== JSON.stringify([o.properties, o.overrides]);
      if (changedContent) next.revision = o.revision + 1;
      const out: FileChanges = new Map([[objectPath(a.object), serializeObject(next)]]);
      for (const p of a.sync ?? []) {
        const text = files.get(p);
        if (text == null) continue;
        const synced = syncFile(p, text, next, { overwriteEdited: a.overwriteEdited ?? false });
        if (synced !== null) out.set(p, synced);
      }
      return out;
    },
  }),
  def({
    name: 'objects.place',
    schema: z.object({ object: objectId, page: pagePath, index: z.number().int().min(0).max(500), instance: instanceId.optional(), overrides: objectProps.optional() }),
    scope: (a) => `design:${a.page}`,
    label: () => 'Place living object on the page',
    files: (a) => [objectPath(a.object), a.page, OBJECTS_CSS],
    apply: (files, a) => {
      const o = loadObject(files, a.object);
      if (!o.targets.includes('web')) throw new CommandError(`${o.name} has no web target.`);
      const source = need(files, a.page);
      const section = renderWeb(o, a.instance ?? newInstance(), (a.overrides ?? {}) as ObjectProps);
      const hasHead = /<head[\s>]/i.test(source);
      // Pages without a <head> (app shells) get the stylesheet link next to the section instead.
      let html = insertSection(source, hasHead || source.includes(`href="${OBJECTS_CSS}"`) ? section : `<link rel="stylesheet" href="${OBJECTS_CSS}">\n${section}`, a.index);
      if (hasHead) html = ensureStylesheet(html, a.page, OBJECTS_CSS);
      const out: FileChanges = new Map([[a.page, html]]);
      if (files.get(OBJECTS_CSS) == null) out.set(OBJECTS_CSS, OBJECTS_STYLES);
      return out;
    },
  }),
  def({
    name: 'objects.addScene',
    schema: z.object({ object: objectId, sequence: seqId, start: ticks, duration: ticks.min(1).optional(), trackId: seqId.optional(), template: z.enum(TEXT_TEMPLATES).optional(), clipId: seqId.optional(), instance: instanceId.optional(), overrides: objectProps.optional() }),
    scope: (a) => `video:${a.sequence}`,
    label: () => 'Add living object as a scene',
    files: (a) => [objectPath(a.object), sequencePath(a.sequence)],
    apply: (files, a) => {
      const o = loadObject(files, a.object);
      if (!o.targets.includes('video')) throw new CommandError(`${o.name} has no video target.`);
      const overrides = (a.overrides ?? {}) as ObjectProps;
      const r = renderVideo(o, overrides);
      const clipId = a.clipId ?? `obj-${newInstance()}`;
      const added = applyVideoCommand(new Map([[sequencePath(a.sequence), need(files, sequencePath(a.sequence))]]), 'video.addText', {
        sequence: a.sequence,
        clipId,
        trackId: a.trackId,
        start: a.start,
        duration: a.duration ?? 4 * 240_000,
        text: r.text,
        ...(r.subtitle ? { subtitle: r.subtitle } : {}),
        template: a.template ?? r.template,
      });
      const seq = parseSequence(added.files.get(sequencePath(a.sequence))!);
      for (const t of seq.tracks)
        for (const c of t.clips) if (c.id === clipId && c.type === 'text') c.object = { id: o.id, instance: a.instance ?? newInstance(), revision: o.revision, ...(Object.keys(overrides).length ? { overrides } : {}), hash: videoHash(c.text, c.subtitle) };
      return new Map([[sequencePath(a.sequence), serializeSequence(seq)]]);
    },
  }),
  def({
    name: 'objects.setInstance',
    schema: z.object({ object: objectId, path: z.string().min(1).max(400), instance: instanceId, overrides: objectProps }),
    scope: (a) => (/\.html?$/i.test(a.path) ? `design:${a.path}` : `video:${a.path.replace(/^sequences\//, '').replace(/\.mvseq\.json$/, '')}`),
    label: () => 'Override a living object here',
    files: (a) => [objectPath(a.object), a.path],
    apply: (files, a) => {
      const o = loadObject(files, a.object);
      const text = need(files, a.path);
      const overrides = Object.fromEntries(Object.entries(a.overrides as ObjectProps).filter(([, v]) => (Array.isArray(v) ? v.length : v !== ''))) as ObjectProps;
      if (/\.html?$/i.test(a.path)) {
        const p = pagePlacements(text).find((x) => x.object === o.id && x.instance === a.instance);
        if (!p) throw new CommandError(`${a.path} has no placement ${a.instance} of ${o.name}.`);
        const indent = lineIndent(text, p.el.start);
        return new Map([[a.path, `${text.slice(0, p.el.start)}${indentBlock(renderWeb(o, a.instance, overrides), indent)}${text.slice(p.el.end)}`]]);
      }
      const seq = parseSequence(text);
      const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text' && c.object?.id === o.id && c.object.instance === a.instance);
      if (!clip || clip.type !== 'text' || !clip.object) throw new CommandError(`${a.path} has no scene ${a.instance} of ${o.name}.`);
      const r = renderVideo(o, overrides);
      clip.text = r.text;
      if (r.subtitle) clip.subtitle = r.subtitle;
      else delete clip.subtitle;
      clip.object = { id: o.id, instance: a.instance, revision: o.revision, ...(Object.keys(overrides).length ? { overrides } : {}), hash: videoHash(r.text, r.subtitle || undefined) };
      return new Map([[a.path, serializeSequence(seq)]]);
    },
  }),
  def({
    name: 'objects.sync',
    schema: z.object({ object: objectId, paths: syncPaths.min(1), overwriteEdited: z.boolean().optional(), instance: instanceId.optional() }),
    scope: (a) => `object:${a.object}`,
    label: () => 'Update uses of a living object',
    files: (a) => [objectPath(a.object), ...a.paths],
    apply: (files, a) => {
      const o = loadObject(files, a.object);
      const out: FileChanges = new Map();
      for (const p of a.paths) {
        const text = files.get(p);
        if (text == null) continue;
        const synced = syncFile(p, text, o, { overwriteEdited: a.overwriteEdited ?? false, only: a.instance });
        if (synced !== null) out.set(p, synced);
      }
      return out;
    },
  }),
  def({
    name: 'objects.detach',
    schema: z.object({ object: objectId, path: z.string().min(1).max(400), instance: instanceId }),
    scope: (a) => `object:${a.object}`,
    label: () => 'Detach from living object',
    files: (a) => [a.path],
    apply: (files, a) => {
      const text = need(files, a.path);
      if (/\.html?$/i.test(a.path)) {
        const p = pagePlacements(text).find((x) => x.object === a.object && x.instance === a.instance);
        if (!p) throw new CommandError('That placement is not on this page.');
        const open = text.slice(p.el.start, p.el.openEnd).replace(/ data-mv-(object|instance|object-rev|props|hash)="[^"]*"/g, '');
        return new Map([[a.path, `${text.slice(0, p.el.start)}${open}${text.slice(p.el.openEnd)}`]]);
      }
      const seq = parseSequence(text);
      let found = false;
      for (const t of seq.tracks)
        for (const c of t.clips)
          if (c.type === 'text' && c.object?.id === a.object && c.object.instance === a.instance) {
            delete c.object;
            found = true;
          }
      if (!found) throw new CommandError('That scene is not in this sequence.');
      return new Map([[a.path, serializeSequence(seq)]]);
    },
  }),
];

export function registerObjectCommands(registry: CommandRegistry): void {
  for (const d of objectCommands) registry.register(d as CommandDefinition<unknown>);
}
