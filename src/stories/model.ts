/** Stories: validation, fixtures, and which project files a story depends on. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { normalizeProjectPath } from '../shared/paths';
import type { Locator, Story, StoryStep } from '../shared/stories';

export const storyId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Use lowercase letters, numbers and dashes');
const stepId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const short = z.string().max(300);

export const locatorSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('testid'), value: z.string().min(1).max(200) }),
  z.object({ by: z.literal('mv-id'), value: z.string().min(1).max(200) }),
  z.object({ by: z.literal('role'), role: z.string().min(1).max(40), name: z.string().max(200) }),
  z.object({ by: z.literal('label'), name: z.string().min(1).max(200) }),
  z.object({ by: z.literal('placeholder'), value: z.string().min(1).max(200) }),
  z.object({ by: z.literal('text'), text: z.string().min(1).max(300) }),
  z.object({ by: z.literal('css'), value: z.string().min(1).max(300) }),
]);

export const stepSchema = z.discriminatedUnion('kind', [
  z.object({ id: stepId, kind: z.literal('open'), path: z.string().min(1).max(400) }),
  z.object({ id: stepId, kind: z.literal('click'), target: locatorSchema }),
  z.object({ id: stepId, kind: z.literal('fill'), target: locatorSchema, text: z.string().max(2000) }),
  z.object({ id: stepId, kind: z.literal('press'), target: locatorSchema, key: z.string().regex(/^(Enter|Escape|Tab|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Backspace|Delete)$/) }),
  z.object({ id: stepId, kind: z.literal('wait'), target: locatorSchema }),
  z.object({
    id: stepId,
    kind: z.literal('verify'),
    target: locatorSchema.nullable(),
    expect: z.object({ text: z.string().max(500).optional(), visible: z.boolean().optional(), count: z.number().int().min(0).max(10_000).optional(), checked: z.boolean().optional(), value: z.string().max(500).optional(), absent: z.boolean().optional() }),
  }),
  z.object({ id: stepId, kind: z.literal('chapter'), title: z.string().min(1).max(120), subtitle: short.optional() }),
  z.object({ id: stepId, kind: z.literal('annotate'), text: z.string().min(1).max(300), seconds: z.number().min(0.5).max(30).optional() }),
  z.object({ id: stepId, kind: z.literal('narrate'), text: z.string().min(1).max(1000) }),
  z.object({ id: stepId, kind: z.literal('hold'), ms: z.number().int().min(0).max(30_000) }),
]);

export const timingSchema = z.object({ stepDelayMs: z.number().int().min(0).max(5000), typingMsPerChar: z.number().int().min(10).max(400), endHoldMs: z.number().int().min(0).max(10_000) });
export const viewportSchema = z.object({ width: z.number().int().min(320).max(3840).multipleOf(2), height: z.number().int().min(240).max(2160).multipleOf(2) });
export const fixturesSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/), z.string().max(2000));

const storySchema = z.object({
  format: z.literal('multiverse-story'),
  version: z.literal(1),
  id: storyId,
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  page: z.string().min(1).max(400),
  viewport: viewportSchema,
  fixtures: fixturesSchema,
  steps: z.array(stepSchema).max(300),
  timing: timingSchema,
  dependsOn: z.array(z.string().min(1).max(400)).max(500).nullable(),
});

export const DEFAULT_TIMING: Story['timing'] = { stepDelayMs: 600, typingMsPerChar: 45, endHoldMs: 1500 };

export function parseStory(text: string, path = 'story'): Story {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  const r = storySchema.safeParse(raw);
  if (!r.success) throw new Error(`${path} is not a valid story: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
  const ids = new Set<string>();
  for (const s of r.data.steps) {
    if (ids.has(s.id)) throw new Error(`${path}: step id “${s.id}” is used twice.`);
    ids.add(s.id);
  }
  return r.data as Story;
}

export const serializeStory = (s: Story): string => `${JSON.stringify(s, null, 2)}\n`;
export const hashText = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Replace {{fixture}} references. An unknown name is an error, so a typo never types “{{x}}”. */
export function withFixtures(steps: StoryStep[], fixtures: Record<string, string>): StoryStep[] {
  const fill = (s: string): string =>
    s.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => {
      if (!(name in fixtures)) throw new Error(`The story uses the fixture “${name}”, which is not defined.`);
      return fixtures[name]!;
    });
  const loc = (t: Locator): Locator => {
    switch (t.by) {
      case 'text':
        return { ...t, text: fill(t.text) };
      case 'role':
        return { ...t, name: fill(t.name) };
      case 'label':
        return { ...t, name: fill(t.name) };
      case 'placeholder':
      case 'testid':
      case 'mv-id':
      case 'css':
        return { ...t, value: fill(t.value) };
    }
  };
  return steps.map((s) => {
    if (s.kind === 'fill') return { ...s, text: fill(s.text), target: loc(s.target) };
    if (s.kind === 'verify')
      return { ...s, target: s.target ? loc(s.target) : null, expect: { ...s.expect, ...(s.expect.text !== undefined ? { text: fill(s.expect.text) } : {}), ...(s.expect.value !== undefined ? { value: fill(s.expect.value) } : {}) } };
    if (s.kind === 'click' || s.kind === 'wait' || s.kind === 'press') return { ...s, target: loc(s.target) };
    if (s.kind === 'annotate' || s.kind === 'narrate') return { ...s, text: fill(s.text) };
    if (s.kind === 'chapter') return { ...s, title: fill(s.title), ...(s.subtitle ? { subtitle: fill(s.subtitle) } : {}) };
    return s;
  });
}

const pageFile = (p: string): string => {
  const clean = p.split(/[?#]/)[0]!.replace(/^\/+/, '');
  if (!clean || clean.endsWith('/')) return normalizeProjectPath(`${clean}index.html`);
  return normalizeProjectPath(clean);
};

const MEDIA = /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|m4a|ogg|woff2?|ttf|otf)$/i;

/**
 * The files a story depends on. A static site is followed from its pages through stylesheets,
 * scripts and module imports (certain unless the code loads things dynamically); an app with a
 * build or a dev server is uncertain, so every source file counts and changes mean “may need a run”.
 */
export function storyDependencies(story: Story, files: ReadonlyMap<string, string>, read: (path: string) => string | null): { deps: string[]; certain: boolean } {
  const exists = (p: string): boolean => files.has(p);
  if (story.dependsOn) {
    const out = new Set<string>();
    for (const d of story.dependsOn) for (const p of files.keys()) if (d.endsWith('/') ? p.startsWith(d) : p === normalizeProjectPath(d)) out.add(p);
    return { deps: [...out].sort(), certain: true };
  }
  const pkg = read('package.json');
  const isApp = story.page === 'dev-server' || (pkg !== null && /"(dev|build|start)"\s*:/.test(pkg));
  if (isApp) {
    const deps = [...files.keys()].filter((p) => !MEDIA.test(p) && !/^(node_modules|stories|sequences|objects)\//.test(p) && !p.startsWith('.'));
    return { deps: deps.sort(), certain: false };
  }
  const out = new Set<string>();
  let certain = true;
  const queue = [pageFile(story.page), ...story.steps.filter((s) => s.kind === 'open').map((s) => pageFile((s as { path: string }).path))];
  while (queue.length) {
    const p = queue.shift()!;
    if (out.has(p) || !exists(p)) continue;
    out.add(p);
    const text = read(p);
    if (text === null) continue;
    const base = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
    const resolve = (ref: string): string | null => {
      if (/^(https?:|data:|mailto:|#|\/\/)/i.test(ref)) return null;
      const clean = ref.split(/[?#]/)[0]!;
      try {
        return normalizeProjectPath(clean.startsWith('/') ? clean.slice(1) : new URL(clean, `http://x/${base}`).pathname.slice(1));
      } catch {
        return null;
      }
    };
    const refs: string[] = [];
    if (/\.html?$/i.test(p)) {
      for (const m of text.matchAll(/<(?:link|script)\b[^>]*?\s(?:href|src)\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]!);
      for (const m of text.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"'#]+\.html?)["']/gi)) refs.push(m[1]!);
      if (/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?\b(fetch|import)\s*\(/i.test(text)) certain = false;
    } else if (/\.(m?js|css)$/i.test(p)) {
      for (const m of text.matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(\s*|import\s+|new\s+Worker\(\s*|fetch\(\s*|url\(\s*)["']([^"']+)["']/g)) refs.push(m[1]!);
      if (/\b(fetch|import)\s*\(\s*[^'"\s)]/.test(text)) certain = false;
    }
    for (const r of refs) {
      const target = resolve(r);
      if (target && !MEDIA.test(target)) queue.push(target);
    }
  }
  return { deps: [...out].sort(), certain };
}
