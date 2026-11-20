/**
 * Design commands: each visual edit is a command on real source files (the page HTML, design.css,
 * the theme stylesheet, component files). They run through the shared command layer, so they have
 * validated arguments, expected revisions, undo/redo and history, whoever performs them.
 */
import path from 'node:path';
import { z } from 'zod';
import { CommandError, type CommandDefinition, type CommandRegistry, type FileTexts } from '../commands/commands';
import { parseHtml } from '../adapters/web/html';
import { BREAKPOINTS, setElementStyles, setThemeTokens, type Breakpoint } from './styles';
import { duplicateSection, ensureId, insertSection, moveSection, newPageFrom, outerHtml, removeSection, replaceComponentInstances, setAttribute, setText, setTitle, type Target } from './markup';
import { PLACEHOLDER_SVG, SECTIONS_CSS, SECTION_LIBRARY } from './library';

export const DESIGN_CSS = 'design.css';
export const SECTIONS_CSS_FILE = 'sections.css';
export const PLACEHOLDER_IMAGE = 'images/placeholder.svg';

const pagePath = z.string().min(1).max(400).regex(/\.html?$/i, 'Pages are .html files');
const target = z.union([z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }), z.object({ path: z.string().regex(/^(\d+(\.\d+)*)?$/).max(200) })]);
const componentName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'Use lowercase letters, numbers and dashes');

function need(files: FileTexts, p: string): string {
  const text = files.get(p);
  if (text === null || text === undefined) throw new CommandError(`${p} does not exist.`);
  return text;
}

/** Relative href from a page to a root-level file. */
export function relHref(page: string, file: string): string {
  const rel = path.posix.relative(path.posix.dirname(page), file);
  return rel || file;
}

/** Add a stylesheet link before </head> if the page does not already load it. */
export function ensureStylesheet(html: string, page: string, file: string): string {
  const href = relHref(page, file);
  const doc = parseHtml(html);
  const has = doc.elements.some((e) => e.tag === 'link' && /stylesheet/i.test(e.attrs.find((a) => a.name === 'rel')?.value ?? '') && (e.attrs.find((a) => a.name === 'href')?.value ?? '').replace(/^\.\//, '') === href);
  if (has) return html;
  const head = doc.elements.find((e) => e.tag === 'head');
  if (!head || !head.explicitClose) throw new CommandError('This page has no <head>, so its styles cannot be linked.');
  const indent = '  ';
  return `${html.slice(0, head.closeStart).replace(/\s*$/, '')}\n${indent}<link rel="stylesheet" href="${href}">\n${html.slice(head.closeStart)}`;
}

function def<A>(d: CommandDefinition<A>): CommandDefinition<A> {
  return d;
}

export const designCommands = [
  def({
    name: 'design.setText',
    schema: z.object({ page: pagePath, target, text: z.string().max(5000) }),
    scope: (a) => `design:${a.page}`,
    label: () => 'Edit text',
    files: (a) => [a.page],
    apply: (files, a) => new Map([[a.page, setText(need(files, a.page), a.target as Target, a.text)]]),
  }),
  def({
    name: 'design.setAttribute',
    schema: z.object({ page: pagePath, target, name: z.enum(['href', 'src', 'alt', 'target', 'title', 'aria-label']), value: z.string().max(2000).nullable() }),
    scope: (a) => `design:${a.page}`,
    label: (a) => (a.name === 'href' ? 'Change link' : a.name === 'src' ? 'Change image' : a.name === 'alt' ? 'Change image description' : `Change ${a.name}`),
    files: (a) => [a.page],
    apply: (files, a) => new Map([[a.page, setAttribute(need(files, a.page), a.target as Target, a.name, a.value)]]),
  }),
  def({
    name: 'design.setTitle',
    schema: z.object({ page: pagePath, title: z.string().min(1).max(200) }),
    scope: (a) => `design:${a.page}`,
    label: () => 'Change page title',
    files: (a) => [a.page],
    apply: (files, a) => new Map([[a.page, setTitle(need(files, a.page), a.title)]]),
  }),
  def({
    name: 'design.setStyle',
    schema: z.object({ page: pagePath, target, breakpoint: z.enum(Object.keys(BREAKPOINTS) as [Breakpoint, ...Breakpoint[]]), props: z.record(z.string().max(40), z.string().max(300).nullable()) }),
    scope: (a) => `design:${a.page}`,
    label: (a) => `Change style${a.breakpoint === 'desktop' ? '' : ` (${a.breakpoint})`}`,
    files: (a) => [a.page, DESIGN_CSS],
    apply: (files, a) => {
      const { source, id } = ensureId(need(files, a.page), a.target as Target);
      const html = ensureStylesheet(source, a.page, DESIGN_CSS);
      return new Map([
        [a.page, html],
        [DESIGN_CSS, setElementStyles(files.get(DESIGN_CSS) ?? null, id, a.breakpoint, a.props)],
      ]);
    },
  }),
  def({
    name: 'design.insertSection',
    schema: z.object({ page: pagePath, kind: z.enum(SECTION_LIBRARY.map((s) => s.kind) as [string, ...string[]]), index: z.number().int().min(0).max(500) }),
    scope: (a) => `design:${a.page}`,
    label: (a) => `Add ${SECTION_LIBRARY.find((s) => s.kind === a.kind)!.label.toLowerCase()} section`,
    files: () => [SECTIONS_CSS_FILE, PLACEHOLDER_IMAGE],
    apply: (files, a) => {
      void files;
      throw new CommandError(`internal: ${a.kind}`); // replaced below (needs the page in files)
    },
  }),
  def({
    name: 'design.moveSection',
    schema: z.object({ page: pagePath, target, toIndex: z.number().int().min(0).max(500) }),
    scope: (a) => `design:${a.page}`,
    label: () => 'Move section',
    files: (a) => [a.page],
    apply: (files, a) => new Map([[a.page, moveSection(need(files, a.page), a.target as Target, a.toIndex)]]),
  }),
  def({
    name: 'design.removeSection',
    schema: z.object({ page: pagePath, target }),
    scope: (a) => `design:${a.page}`,
    label: () => 'Remove section',
    files: (a) => [a.page],
    apply: (files, a) => new Map([[a.page, removeSection(need(files, a.page), a.target as Target)]]),
  }),
  def({
    name: 'design.duplicateSection',
    schema: z.object({ page: pagePath, target }),
    scope: (a) => `design:${a.page}`,
    label: () => 'Duplicate section',
    files: (a) => [a.page],
    apply: (files, a) => new Map([[a.page, duplicateSection(need(files, a.page), a.target as Target)]]),
  }),
  def({
    name: 'design.setTheme',
    schema: z.object({ stylesheet: z.string().min(1).max(400).regex(/\.css$/), tokens: z.record(z.string().regex(/^--mv-[a-z0-9-]+$/), z.string().max(300)) }),
    scope: () => 'design:theme',
    label: () => 'Change theme',
    files: (a) => [a.stylesheet],
    apply: (files, a) => new Map([[a.stylesheet, setThemeTokens(need(files, a.stylesheet), a.tokens)]]),
  }),
  def({
    name: 'design.createPage',
    schema: z.object({ from: pagePath, page: pagePath, title: z.string().min(1).max(120) }),
    scope: (a) => `design:${a.page}`,
    label: (a) => `Create page ${a.page}`,
    files: (a) => [a.from, a.page],
    apply: (files, a) => {
      if (files.get(a.page) != null) throw new CommandError(`${a.page} already exists.`);
      if (path.posix.dirname(a.page) !== path.posix.dirname(a.from)) throw new CommandError('Create the new page in the same folder as the page it is based on, so its links and styles keep working.');
      return new Map([[a.page, newPageFrom(need(files, a.from), a.title, 'Introduce this page in a sentence or two.')]]);
    },
  }),
  def({
    name: 'design.saveComponent',
    schema: z.object({ page: pagePath, target, name: componentName }),
    scope: (a) => `design:${a.page}`,
    label: (a) => `Save “${a.name}” as a reusable component`,
    files: (a) => [a.page, `components/${a.name}.html`],
    apply: (files, a) => {
      if (files.get(`components/${a.name}.html`) != null) throw new CommandError(`A component named “${a.name}” already exists.`);
      const html = need(files, a.page);
      const doc = parseHtml(html);
      void doc;
      const marked = setAttributeRaw(html, a.target as Target, 'data-mv-component', a.name);
      const component = outerHtml(marked.source, { id: marked.id });
      return new Map([
        [a.page, marked.source],
        [`components/${a.name}.html`, `${component}\n`],
      ]);
    },
  }),
  def({
    name: 'design.insertComponent',
    schema: z.object({ page: pagePath, name: componentName, index: z.number().int().min(0).max(500) }),
    scope: (a) => `design:${a.page}`,
    label: (a) => `Insert component “${a.name}”`,
    files: (a) => [a.page, `components/${a.name}.html`],
    apply: (files, a) => new Map([[a.page, insertSection(need(files, a.page), need(files, `components/${a.name}.html`), a.index)]]),
  }),
  def({
    name: 'design.syncComponent',
    schema: z.object({ name: componentName, pages: z.array(pagePath).max(200), from: pagePath.optional() }),
    scope: () => 'design:components',
    label: (a) => `Update every “${a.name}” instance`,
    files: (a) => [`components/${a.name}.html`, ...a.pages, ...(a.from ? [a.from] : [])],
    apply: (files, a) => {
      const out: FileTexts = new Map();
      let component = need(files, `components/${a.name}.html`);
      if (a.from) {
        // Use the instance on this page as the new definition.
        const src = need(files, a.from);
        const docF = parseHtml(src);
        const inst = docF.elements.find((e) => e.attrs.some((x) => x.name === 'data-mv-component' && x.value === a.name));
        if (!inst) throw new CommandError(`${a.from} has no “${a.name}” instance.`);
        component = `${src.slice(inst.start, inst.end)}\n`;
        out.set(`components/${a.name}.html`, component);
      }
      for (const p of a.pages) {
        const r = replaceComponentInstances(need(files, p), a.name, component);
        if (r.count) out.set(p, r.source);
      }
      return out;
    },
  }),
];

function setAttributeRaw(source: string, t: Target, name: string, value: string): { source: string; id: string } {
  const withId = ensureId(source, t);
  const doc = parseHtml(withId.source);
  const el = doc.elements.find((e) => e.attrs.some((a) => a.name === 'data-mv-id' && a.value === withId.id))!;
  const existing = el.attrs.find((a) => a.name === name);
  const next = existing
    ? `${withId.source.slice(0, existing.start)}${name}="${value}"${withId.source.slice(existing.end)}`
    : `${withId.source.slice(0, el.start + 1 + el.tag.length)} ${name}="${value}"${withId.source.slice(el.start + 1 + el.tag.length)}`;
  return { source: next, id: withId.id };
}

// insertSection needs the page itself plus the shared library files; defined here with full access.
const insert = designCommands.find((d) => d.name === 'design.insertSection')! as CommandDefinition<{ page: string; kind: string; index: number }>;
insert.files = (a) => [a.page, SECTIONS_CSS_FILE, PLACEHOLDER_IMAGE];
insert.apply = (files, a) => {
  const section = SECTION_LIBRARY.find((s) => s.kind === a.kind)!;
  const out: FileTexts = new Map();
  let html = insertSection(need(files, a.page), section.html.split(PLACEHOLDER_IMAGE).join(relHref(a.page, PLACEHOLDER_IMAGE)), a.index);
  html = ensureStylesheet(html, a.page, SECTIONS_CSS_FILE);
  out.set(a.page, html);
  if (files.get(SECTIONS_CSS_FILE) == null) out.set(SECTIONS_CSS_FILE, SECTIONS_CSS);
  if (section.html.includes(PLACEHOLDER_IMAGE) && files.get(PLACEHOLDER_IMAGE) == null) out.set(PLACEHOLDER_IMAGE, PLACEHOLDER_SVG);
  return out;
};

export function registerDesignCommands(registry: CommandRegistry): void {
  for (const d of designCommands) registry.register(d as CommandDefinition<unknown>);
}
