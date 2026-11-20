/**
 * Shared brand settings and how they reach websites and videos.
 *
 * Brand settings live in the project manifest (colours, fonts, text styles, logo). Nothing is
 * changed silently: a brand update is planned per version first (a propagation preview), and only
 * the items the user ticks are applied, each as an ordinary undoable command:
 * - Websites: a brand colour named "Primary" drives the theme token `--mv-color-primary`; fonts
 *   named "Heading"/"Body" drive `--mv-font-heading`/`--mv-font-body`. A library font is copied into
 *   the site (`fonts/…`) and declared with @font-face in a marked block of the theme stylesheet.
 *   Only tokens the site's theme already defines are changed.
 * - Videos: titles that follow a brand text style (`brandStyleId`) get its colour, font, weight and
 *   size (sizes are for a 1080-pixel-high frame and scale with the sequence).
 */
import path from 'node:path';
import { CommandError, type CommandRegistry, type FileTexts } from '../commands/commands';
import { z } from 'zod';
import { setThemeTokens } from '../design/styles';
import type { BrandSettings } from '../engine/store/records';
import type { Sequence, TextClip } from '../shared/video';
import { brandTitleStyle } from '../shared/brand';

export type { BrandSettings };

export interface BrandFontFile {
  /** Path in the version, e.g. fonts/brand-heading.woff2 */
  path: string;
  assetId: string;
}

export interface BrandPlanItem {
  id: string;
  lineId: string;
  lineName: string;
  kind: 'website-theme' | 'video-titles';
  /** Stylesheet path or sequence name. */
  target: string;
  changes: string[];
  /** Commands to run, in order, with the file hashes they were planned against. */
  commands: { name: string; args: Record<string, unknown> }[];
  expected: Record<string, string | null>;
  /** Library fonts to copy into the version first. */
  fontFiles: BrandFontFile[];
}


export const slugName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

const GENERIC: Record<string, string> = { heading: 'serif', body: 'sans-serif', mono: 'monospace', display: 'sans-serif' };

/** The token a brand colour or font drives. */
export function tokenFor(kind: 'color' | 'font', name: string): string {
  return `--mv-${kind}-${slugName(name)}`;
}

/** Plan theme token and font changes for one stylesheet. */
export function planWebsiteTheme(
  brand: BrandSettings,
  stylesheet: string,
  tokens: { name: string; value: string }[],
  fontAssets: Map<string, { name: string; ext: string; sha256: string }>,
): { tokens: Record<string, string>; faces: { family: string; src: string; format: string }[]; fontFiles: BrandFontFile[]; changes: string[] } {
  const current = new Map(tokens.map((t) => [t.name, t.value.trim()]));
  const out: Record<string, string> = {};
  const changes: string[] = [];
  for (const c of brand.colors) {
    const token = tokenFor('color', c.name);
    const before = current.get(token);
    if (before === undefined || before.toLowerCase() === c.value.toLowerCase()) continue;
    out[token] = c.value;
    changes.push(`${token}: ${before} → ${c.value}`);
  }
  const faces: { family: string; src: string; format: string }[] = [];
  const fontFiles: BrandFontFile[] = [];
  for (const f of brand.fonts) {
    const token = tokenFor('font', f.name);
    const before = current.get(token);
    if (before === undefined) continue;
    const generic = GENERIC[slugName(f.name)] ?? 'sans-serif';
    const value = `"${f.family.replace(/"/g, '')}", ${generic}`;
    const asset = f.assetId ? fontAssets.get(f.assetId) : undefined;
    if (asset && f.assetId) {
      const file = `fonts/${slugName(f.family) || 'brand'}-${asset.sha256.slice(0, 8)}.${asset.ext}`;
      const rel = path.posix.relative(path.posix.dirname(stylesheet), file) || file;
      faces.push({ family: f.family, src: rel, format: { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[asset.ext] ?? 'truetype' });
      fontFiles.push({ path: file, assetId: f.assetId });
    }
    if (before.replace(/\s+/g, ' ') !== value) {
      out[token] = value;
      changes.push(`${token}: ${before} → ${value}`);
    }
    if (asset) changes.push(`Use ${asset.name} for “${f.family}”`);
  }
  return { tokens: out, faces, fontFiles, changes };
}

/** Restyle titles that follow a brand text style. */
export function planVideoTitles(brand: BrandSettings, seq: Sequence): { steps: { name: string; args: Record<string, unknown> }[]; changes: string[] } {
  const steps: { name: string; args: Record<string, unknown> }[] = [];
  const counts = new Map<string, number>();
  for (const t of seq.tracks) {
    for (const c of t.clips) {
      if (c.type !== 'text' || !c.brandStyleId) continue;
      const style = brand.textStyles.find((s) => s.id === c.brandStyleId);
      if (!style) continue;
      const patch = titlePatch(brand, style, seq.settings.height, c);
      if (!Object.keys(patch).length) continue;
      steps.push({ name: 'video.setClip', args: { clipId: c.id, patch: { style: patch } } });
      counts.set(style.name, (counts.get(style.name) ?? 0) + 1);
    }
  }
  return { steps, changes: [...counts].map(([n, k]) => `${k} title${k === 1 ? '' : 's'} using “${n}”`) };
}

export function titlePatch(brand: BrandSettings, style: BrandSettings['textStyles'][number], frameHeight: number, clip?: TextClip): Partial<TextClip['style']> {
  const want = brandTitleStyle(brand, style.id, frameHeight) ?? {};
  if (!clip) return want;
  const patch: Partial<TextClip['style']> = {};
  for (const [k, v] of Object.entries(want)) {
    const cur = (clip.style as unknown as Record<string, unknown>)[k] ?? null;
    if (cur !== v) (patch as Record<string, unknown>)[k] = v;
  }
  return patch;
}

/* ---------------- @font-face block ---------------- */

const START = '/* mv:brand-fonts (managed by Multiverse Studio brand settings) */';
const END = '/* /mv:brand-fonts */';

export function setFontFaces(css: string, faces: { family: string; src: string; format: string }[]): string {
  const block = faces.length
    ? `${START}\n${faces.map((f) => `@font-face {\n  font-family: "${f.family.replace(/["\\]/g, '')}";\n  src: url("${f.src.replace(/["\\]/g, '')}") format("${f.format}");\n  font-display: swap;\n}`).join('\n')}\n${END}\n`
    : '';
  const a = css.indexOf(START);
  const b = css.indexOf(END);
  if (a >= 0 && b > a) return css.slice(0, a) + block + css.slice(b + END.length).replace(/^\n/, '');
  // @import rules must stay first; put the block after them.
  const imports = /^(?:\s*@(?:import|charset)[^;]*;\s*)*/.exec(css)?.[0] ?? '';
  return imports + block + css.slice(imports.length);
}

export function registerBrandCommands(registry: CommandRegistry): void {
  const face = z.object({ family: z.string().min(1).max(200), src: z.string().min(1).max(400).regex(/^[A-Za-z0-9._/-]+$/), format: z.enum(['truetype', 'opentype', 'woff', 'woff2']) });
  registry.register({
    name: 'design.setFontFaces',
    schema: z.object({ stylesheet: z.string().min(1).max(400).regex(/\.css$/), faces: z.array(face).max(16) }),
    scope: () => 'design:theme',
    label: () => 'Change brand fonts',
    files: (a) => [a.stylesheet],
    apply: (files: FileTexts, a) => {
      const css = files.get(a.stylesheet);
      if (css == null) throw new CommandError(`${a.stylesheet} does not exist.`);
      return new Map([[a.stylesheet, setFontFaces(css, a.faces)]]);
    },
  });
  /** A brand update of one site as a single undoable step: theme tokens, @font-face rules and the font files. */
  registry.register({
    name: 'design.applyBrand',
    schema: z.object({
      stylesheet: z.string().min(1).max(400).regex(/\.css$/),
      tokens: z.record(z.string().regex(/^--mv-[a-z0-9-]+$/), z.string().max(300)),
      faces: z.array(face).max(16).nullable(),
      files: z.array(z.object({ path: z.string().min(1).max(400).regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/), data: z.instanceof(Uint8Array) })).max(16),
    }),
    scope: () => 'design:theme',
    label: () => 'Apply brand',
    files: (a) => [a.stylesheet, ...a.files.map((f) => f.path)],
    apply: (files: FileTexts, a) => {
      let css = files.get(a.stylesheet);
      if (css == null) throw new CommandError(`${a.stylesheet} does not exist.`);
      if (Object.keys(a.tokens).length) css = setThemeTokens(css, a.tokens);
      if (a.faces) css = setFontFaces(css, a.faces);
      const out = new Map<string, string | Uint8Array | null>([[a.stylesheet, css]]);
      for (const f of a.files) out.set(f.path, f.data);
      return out;
    },
  });
}
