/**
 * Living objects: parsing, the web and video renderers, and finding placements.
 *
 * Renderers are explicit per object type (no arbitrary code becomes a scene): the web target
 * renders a themed HTML section; the video target renders an editable title clip (text, subtitle
 * and template), so the preview and the export draw it with the same title pipeline.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseHtml, type HtmlElement } from '../adapters/web/html';
import { OBJECT_TYPES, OBJECT_TYPE_INFO, objectPath, type LivingObject, type ObjectProps, type ObjectType, type PlacementView } from '../shared/objects';
import { parseSequence } from '../video/sequence';
import type { TextClip } from '../shared/video';

export const objectId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Use lowercase letters, numbers and dashes');
const propValue = z.union([z.string().max(2000), z.array(z.string().max(500)).max(40)]);
export const objectProps = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), propValue);

const objectSchema = z.object({
  format: z.literal('multiverse-object'),
  version: z.literal(1),
  id: objectId,
  type: z.enum(OBJECT_TYPES),
  name: z.string().min(1).max(120),
  revision: z.number().int().min(1),
  properties: objectProps,
  assets: z.array(z.string().max(128)).max(50),
  targets: z.array(z.enum(['web', 'video'])).max(2),
  dependencies: z.array(objectId).max(50),
  overrides: z.object({ web: objectProps.optional(), video: objectProps.optional() }),
});

export function parseObject(text: string, path = 'object'): LivingObject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  const r = objectSchema.safeParse(raw);
  if (!r.success) throw new Error(`${path} is not a valid living object: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
  return r.data as LivingObject;
}

/** One property per line (arrays one item per line), so objects merge well between universes. */
export function serializeObject(o: LivingObject): string {
  return `${JSON.stringify(o, null, 2)}\n`;
}

export function newObject(id: string, type: ObjectType, name: string, properties: ObjectProps = {}): LivingObject {
  return { format: 'multiverse-object', version: 1, id, type, name, revision: 1, properties: { ...OBJECT_TYPE_INFO[type].defaults, ...properties }, assets: [], targets: ['web', 'video'], dependencies: [], overrides: {} };
}

export function effectiveProps(o: LivingObject, target: 'web' | 'video', instance: ObjectProps = {}): ObjectProps {
  return { ...o.properties, ...(o.overrides[target] ?? {}), ...instance };
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (p: ObjectProps, k: string): string => {
  const v = p[k];
  return Array.isArray(v) ? v.join(', ') : (v ?? '');
};
const list = (p: ObjectProps, k: string): string[] => {
  const v = p[k];
  return Array.isArray(v) ? v : v ? v.split('\n').filter(Boolean) : [];
};
const safeHref = (h: string): string => (/^(https?:|mailto:|#|\/|\.\/|[a-z0-9._-]+\.html?(#.*)?$)/i.test(h.trim()) ? h.trim() : '#');

export const shortHash = (s: string): string => createHash('sha256').update(s.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);

function webBody(type: ObjectType, p: ObjectProps): string {
  switch (type) {
    case 'pricing-card':
      return [
        `<div class="mv-obj-card">`,
        `  <h3 class="mv-obj-plan">${esc(str(p, 'plan'))}</h3>`,
        `  <p class="mv-obj-price"><span class="mv-obj-amount">${esc(str(p, 'price'))}</span> <span class="mv-obj-period">${esc(str(p, 'period'))}</span></p>`,
        `  <ul class="mv-obj-list">${list(p, 'features').map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`,
        `  <a class="mv-btn mv-btn-primary" href="${esc(safeHref(str(p, 'href')))}">${esc(str(p, 'cta'))}</a>`,
        `</div>`,
      ].join('\n');
    case 'feature-list':
      return [`<h2 class="mv-obj-heading">${esc(str(p, 'heading'))}</h2>`, `<ul class="mv-obj-list mv-obj-features">${list(p, 'items').map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`].join('\n');
    case 'statistic':
      return [`<p class="mv-obj-stat"><span class="mv-obj-value">${esc(str(p, 'value'))}</span> <span class="mv-obj-label">${esc(str(p, 'label'))}</span></p>`, ...(str(p, 'source') ? [`<p class="mv-obj-source">${esc(str(p, 'source'))}</p>`] : [])].join('\n');
    case 'call-to-action':
      return [`<h2 class="mv-obj-heading">${esc(str(p, 'headline'))}</h2>`, `<p class="mv-obj-body">${esc(str(p, 'body'))}</p>`, `<a class="mv-btn mv-btn-primary" href="${esc(safeHref(str(p, 'href')))}">${esc(str(p, 'button'))}</a>`].join('\n');
    case 'title-card':
      return [`<h1 class="mv-obj-title">${esc(str(p, 'title'))}</h1>`, `<p class="mv-obj-subtitle">${esc(str(p, 'subtitle'))}</p>`].join('\n');
  }
}

/** The section placed on a page. `data-mv-hash` lets later syncs tell hand edits from stale renders. */
export function renderWeb(o: LivingObject, instance: string, overrides: ObjectProps = {}): string {
  const props = effectiveProps(o, 'web', overrides);
  const attrs = `class="mv-object mv-obj-${o.type}" data-mv-section="object" data-mv-object="${o.id}" data-mv-instance="${instance}" data-mv-object-rev="${o.revision}"${Object.keys(overrides).length ? ` data-mv-props="${esc(JSON.stringify(overrides))}"` : ''}`;
  const inner = `<div class="mv-container">\n${webBody(o.type, props)
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')}\n</div>`;
  const body = `<section ${attrs}>\n${inner
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')}\n</section>`;
  return body.replace('<section ', `<section data-mv-hash="${shortHash(body)}" `);
}

/** The title clip fields for the video target. */
export function renderVideo(o: LivingObject, overrides: ObjectProps = {}): { text: string; subtitle: string; template: TextClip['template'] } {
  const p = effectiveProps(o, 'video', overrides);
  const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  switch (o.type) {
    case 'pricing-card':
      return { text: cut(`${str(p, 'plan')} — ${str(p, 'price')}`, 500), subtitle: cut([str(p, 'period'), ...list(p, 'features')].filter(Boolean).join(' · '), 300), template: 'title-card' };
    case 'feature-list':
      return { text: cut(str(p, 'heading'), 500), subtitle: cut(list(p, 'items').join(' · '), 300), template: 'title-card' };
    case 'statistic':
      return { text: cut(str(p, 'value'), 500), subtitle: cut(str(p, 'label'), 300), template: 'title-card' };
    case 'call-to-action':
      return { text: cut(str(p, 'headline'), 500), subtitle: cut([str(p, 'body'), str(p, 'button')].filter(Boolean).join(' — '), 300), template: 'end-card' };
    case 'title-card':
      return { text: cut(str(p, 'title'), 500), subtitle: cut(str(p, 'subtitle'), 300), template: 'title-card' };
  }
}

export const videoHash = (text: string, subtitle: string | undefined): string => shortHash(`${text}\u0000${subtitle ?? ''}`);

const attr = (e: HtmlElement, name: string): string | null => e.attrs.find((a) => a.name === name)?.value ?? null;
const unesc = (s: string): string => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function readOverrides(raw: string | null): ObjectProps {
  if (!raw) return {};
  try {
    const parsed = objectProps.safeParse(JSON.parse(unesc(raw)));
    return parsed.success ? (parsed.data as ObjectProps) : {};
  } catch {
    return {};
  }
}

/** Placements of objects in a page. */
export function pagePlacements(html: string): { el: HtmlElement; object: string; instance: string; revision: number; overrides: ObjectProps; hash: string | null }[] {
  const doc = parseHtml(html);
  return doc.elements
    .filter((e) => attr(e, 'data-mv-object') !== null && attr(e, 'data-mv-instance') !== null)
    .map((e) => ({ el: e, object: attr(e, 'data-mv-object')!, instance: attr(e, 'data-mv-instance')!, revision: Number(attr(e, 'data-mv-object-rev') ?? 0), overrides: readOverrides(attr(e, 'data-mv-props')), hash: attr(e, 'data-mv-hash') }));
}

export function placementState(o: LivingObject, current: string, recorded: { hash: string | null; revision: number; overrides: ObjectProps; instance: string }): PlacementView['state'] {
  const withoutHash = current.replace(/ data-mv-hash="[^"]*"/, '');
  if (recorded.hash && shortHash(withoutHash) !== recorded.hash) return 'edited';
  const fresh = renderWeb(o, recorded.instance, recorded.overrides).replace(/ data-mv-hash="[^"]*"/, '');
  return shortHash(fresh) === shortHash(withoutHash) ? 'current' : 'outdated';
}

export function scenePlacementState(o: LivingObject, clip: TextClip): PlacementView['state'] {
  const ref = clip.object!;
  if (ref.hash && videoHash(clip.text, clip.subtitle) !== ref.hash) return 'edited';
  const want = renderVideo(o, ref.overrides ?? {});
  return want.text === clip.text && (want.subtitle || undefined) === (clip.subtitle || undefined) ? 'current' : 'outdated';
}

/** Every placement of every object in a universe's files. */
export function findPlacements(files: Map<string, string>, objects: Map<string, LivingObject>): Map<string, PlacementView[]> {
  const out = new Map<string, PlacementView[]>();
  const add = (id: string, p: PlacementView): void => {
    out.set(id, [...(out.get(id) ?? []), p]);
  };
  for (const [path, text] of files) {
    if (/\.html?$/i.test(path)) {
      for (const p of pagePlacements(text)) {
        const o = objects.get(p.object);
        if (!o) continue;
        add(p.object, { kind: 'page', path, instance: p.instance, clipId: null, revision: p.revision, overrides: p.overrides, state: placementState(o, text.slice(p.el.start, p.el.end), p) });
      }
    } else if (/^sequences\/.+\.mvseq\.json$/.test(path)) {
      let seq;
      try {
        seq = parseSequence(text);
      } catch {
        continue;
      }
      for (const t of seq.tracks)
        for (const c of t.clips) {
          if (c.type !== 'text' || !c.object) continue;
          const o = objects.get(c.object.id);
          if (!o) continue;
          add(c.object.id, { kind: 'scene', path, instance: c.object.instance, clipId: c.id, revision: c.object.revision, overrides: c.object.overrides ?? {}, state: scenePlacementState(o, c) });
        }
    }
  }
  return out;
}

export { objectPath };
