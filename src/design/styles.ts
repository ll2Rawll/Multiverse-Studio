/**
 * Per-element styles and theme tokens for visual editing.
 *
 * Element styles live in `design.css` as one rule per element and breakpoint:
 *
 *   [data-mv-id="hero-title"] { font-size: 56px; }
 *   @media (max-width: 900px) { [data-mv-id="hero-title"] { font-size: 40px; } }
 *
 * The file is regenerated in this canonical form from what it contains, so hand edits that keep the
 * same shape are picked up by the Design workspace, and other rules in the file are kept as written.
 * Theme tokens are the `--mv-*` custom properties declared in a `:root` rule.
 */
import { parseCss } from '../adapters/web/css';
import { CommandError } from '../commands/commands';

export const BREAKPOINTS = { desktop: null, tablet: '(max-width: 900px)', mobile: '(max-width: 600px)' } as const;
export type Breakpoint = keyof typeof BREAKPOINTS;

export const STYLE_PROPERTIES = [
  'color',
  'background-color',
  'background-image',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'padding',
  'padding-top',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'margin-top',
  'margin-bottom',
  'gap',
  'border-radius',
  'max-width',
  'width',
  'min-height',
  'display',
  'flex-direction',
  'grid-template-columns',
  'justify-content',
  'align-items',
  'opacity',
] as const;
export type StyleProperty = (typeof STYLE_PROPERTIES)[number];

export type ElementStyles = Record<string, Partial<Record<Breakpoint, Record<string, string>>>>;

const HEADER = '/* Managed by Multiverse Studio Design: one rule per element and breakpoint. Safe to edit by hand in this shape. */';
const RULE = /^\[data-mv-id="([A-Za-z0-9_-]+)"\]$/;

export function validValue(prop: string, value: string): boolean {
  if (!value.trim() || value.length > 300) return false;
  if (/[;{}<>]|\/\*|\\/.test(value)) return false;
  if (prop === 'background-image') return /^(none|url\("[^"()]+"\)|url\('[^'()]+'\)|url\([^"'()\s]+\)|(linear|radial)-gradient\([^;{}]*\))$/.test(value.trim()) && !/javascript:/i.test(value);
  if (/url\(/i.test(value)) return false;
  return true;
}

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

function breakpointOf(media: string[]): Breakpoint | null {
  if (media.length === 0) return 'desktop';
  if (media.length !== 1) return null;
  const m = media[0]!.replace(/^@media\s*/i, '').replace(/\s+/g, ' ').trim();
  for (const [bp, q] of Object.entries(BREAKPOINTS)) if (q && m === q) return bp as Breakpoint;
  return null;
}

/** Read managed element styles; anything else in the file is returned untouched as `other`. */
export function readDesignCss(css: string | null): { styles: ElementStyles; other: string[] } {
  const styles: ElementStyles = {};
  const other: string[] = [];
  if (!css) return { styles, other };
  const sheet = parseCss(css);
  for (const rule of sheet.rules) {
    const bp = rule.kind === 'style' ? breakpointOf(rule.media) : null;
    const m = rule.kind === 'style' ? RULE.exec(rule.prelude.trim()) : null;
    if (bp && m) {
      const entry = (styles[m[1]!] ??= {});
      entry[bp] = { ...(entry[bp] ?? {}), ...declarations(rule.body) };
    } else if (rule.media.length === 0) {
      other.push(rule.text.trim());
    } else {
      other.push(`@media ${rule.media.map((x) => x.replace(/^@media\s*/i, '')).join(' and ')} {\n  ${rule.text.trim()}\n}`);
    }
  }
  return { styles, other: other.filter((o) => o && !o.startsWith('/*')) };
}

export function writeDesignCss(styles: ElementStyles, other: string[]): string {
  const lines: string[] = [HEADER, ''];
  const rule = (id: string, decls: Record<string, string>, indent = ''): string =>
    `${indent}[data-mv-id="${id}"] {\n${Object.entries(decls)
      .map(([k, v]) => `${indent}  ${k}: ${v};`)
      .join('\n')}\n${indent}}`;
  const ids = Object.keys(styles).sort();
  for (const id of ids) {
    const d = styles[id]!.desktop;
    if (d && Object.keys(d).length) lines.push(rule(id, d), '');
  }
  for (const bp of ['tablet', 'mobile'] as const) {
    const rules = ids.filter((id) => styles[id]![bp] && Object.keys(styles[id]![bp]!).length).map((id) => rule(id, styles[id]![bp]!, '  '));
    if (rules.length) lines.push(`@media ${BREAKPOINTS[bp]} {\n${rules.join('\n\n')}\n}`, '');
  }
  if (other.length) lines.push('/* Other rules */', ...other.map((o) => `${o}\n`));
  return `${lines.join('\n').trimEnd()}\n`;
}

export function setElementStyles(css: string | null, id: string, breakpoint: Breakpoint, props: Record<string, string | null>): string {
  const { styles, other } = readDesignCss(css);
  const entry = (styles[id] ??= {});
  const decls = { ...(entry[breakpoint] ?? {}) };
  for (const [prop, value] of Object.entries(props)) {
    if (!(STYLE_PROPERTIES as readonly string[]).includes(prop)) throw new CommandError(`${prop} is not a visually editable property.`);
    if (value === null || value === '') delete decls[prop];
    else if (!validValue(prop, value)) throw new CommandError(`“${value}” is not a valid value for ${prop}.`);
    else decls[prop] = value.trim();
  }
  entry[breakpoint] = decls;
  return writeDesignCss(styles, other);
}

/* ---------------- theme tokens ---------------- */

export interface ThemeToken {
  name: string;
  value: string;
}

export function readTheme(css: string | null): ThemeToken[] {
  if (!css) return [];
  const sheet = parseCss(css);
  const root = sheet.rules.find((r) => r.kind === 'style' && r.media.length === 0 && r.prelude.trim() === ':root');
  if (!root) return [];
  return Object.entries(declarations(root.body))
    .filter(([k]) => k.startsWith('--mv-'))
    .map(([name, value]) => ({ name, value }));
}

/** Change `--mv-*` tokens in the stylesheet's :root rule, keeping everything else as written. */
export function setThemeTokens(css: string, tokens: Record<string, string>): string {
  const sheet = parseCss(css);
  const root = sheet.rules.find((r) => r.kind === 'style' && r.media.length === 0 && r.prelude.trim() === ':root');
  if (!root) throw new CommandError('This stylesheet has no :root rule with theme tokens.');
  let body = root.body;
  for (const [name, value] of Object.entries(tokens)) {
    if (!/^--mv-[a-z0-9-]+$/.test(name)) throw new CommandError(`${name} is not a theme token.`);
    if (!validValue(name, value)) throw new CommandError(`“${value}” is not a valid value for ${name}.`);
    const re = new RegExp(`(${name.replace(/[-]/g, '\\-')}\\s*:\\s*)([^;]*)(;?)`);
    body = re.test(body) ? body.replace(re, (_m, a: string, _v: string, c: string) => `${a}${value.trim()}${c || ';'}`) : `${body.replace(/\s*$/, '')}\n  ${name}: ${value.trim()};\n`;
  }
  const open = css.indexOf('{', root.start) + 1;
  const close = root.end - 1;
  return css.slice(0, open) + body + css.slice(close);
}
