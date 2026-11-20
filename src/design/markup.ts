/**
 * Visual editing for HTML pages, with the source as the single source of truth.
 *
 * Every visual operation is a precise text edit of the page's HTML (located with the web adapter's
 * offset-preserving parser), so code edits and visual edits always agree:
 *
 * - Elements are addressed by `data-mv-id` when present, otherwise by their child-index path from
 *   `<body>`. The first visual edit of an element adds a readable `data-mv-id`, a visible source change.
 * - Sections are the element children of `<main>` (or `<body>`), plus top-level header and footer.
 * - Text editing applies to elements that contain only text; elements with nested markup are
 *   reported as “edit in code” rather than flattened.
 * - Pages rendered by a JavaScript framework (a React root and a module script) are recognised and
 *   left to the code editor.
 */
import { attr, parseHtml, type HtmlDocument, type HtmlElement } from '../adapters/web/html';
import { CommandError } from '../commands/commands';

export type NodeKind = 'section' | 'text' | 'link' | 'button' | 'image' | 'container' | 'other';

export interface DesignNode {
  key: string;
  mvId: string | null;
  /** Index path under <body> (element children, skipping script/style/svg…). */
  path: string;
  tag: string;
  kind: NodeKind;
  label: string;
  text: string | null;
  editableText: boolean;
  attrs: { href?: string; src?: string; alt?: string; target?: string };
  component: string | null;
  /** The living object this section shows (data-mv-object), if any. */
  object: string | null;
  sectionType: string | null;
  children: DesignNode[];
}

export interface PageOutline {
  title: string;
  supported: boolean;
  reason: string | null;
  sections: DesignNode[];
}

export type Target = { id: string } | { path: string };

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'a', 'button', 'li', 'blockquote', 'figcaption', 'label', 'small', 'strong', 'em', 'td', 'th', 'dt', 'dd', 'cite', 'q', 'summary', 'legend', 'caption']);
const SECTION_TAGS = new Set(['section', 'header', 'footer', 'nav', 'article', 'aside', 'div', 'form', 'figure']);
const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'svg', 'head', 'meta', 'link', 'title']);

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function body(doc: HtmlDocument): HtmlElement {
  return doc.elements.find((e) => e.tag === 'body') ?? doc.root;
}

function elementChildren(el: HtmlElement): HtmlElement[] {
  return el.children.filter((c) => !SKIP_TAGS.has(c.tag));
}

/** Where sections live: `<main>` if the page has one, otherwise `<body>`. */
export function sectionContainer(doc: HtmlDocument): HtmlElement {
  const b = body(doc);
  return b.children.find((c) => c.tag === 'main') ?? b;
}

export function pathOf(doc: HtmlDocument, el: HtmlElement): string {
  const b = body(doc);
  const parts: number[] = [];
  let cur: HtmlElement | null = el;
  while (cur && cur !== b) {
    const parent: HtmlElement | null = cur.parent;
    if (!parent) break;
    parts.unshift(elementChildren(parent).indexOf(cur));
    cur = parent;
  }
  return parts.join('.');
}

export function resolve(doc: HtmlDocument, target: Target): HtmlElement {
  if ('id' in target) {
    const el = doc.elements.find((e) => attr(e, 'data-mv-id') === target.id);
    if (!el) throw new CommandError(`No element with data-mv-id="${target.id}" on this page. It may have been removed in code.`);
    return el;
  }
  let cur = body(doc);
  if (target.path === '') return cur;
  for (const part of target.path.split('.')) {
    const i = Number(part);
    const next = elementChildren(cur)[i];
    if (!Number.isInteger(i) || !next) throw new CommandError('That element is no longer on the page. Refresh the outline.');
    cur = next;
  }
  return cur;
}

function hasElementChildren(el: HtmlElement): boolean {
  return el.children.some((c) => c.tag !== 'br');
}

function innerText(source: string, el: HtmlElement): string {
  return decode(source.slice(el.openEnd, el.closeStart).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function kindOf(el: HtmlElement, isSection: boolean): NodeKind {
  if (isSection) return 'section';
  if (el.tag === 'img' || el.tag === 'picture' || el.tag === 'video') return 'image';
  if (el.tag === 'a') return attr(el, 'class')?.includes('btn') || attr(el, 'class')?.includes('button') ? 'button' : 'link';
  if (el.tag === 'button') return 'button';
  if (TEXT_TAGS.has(el.tag)) return 'text';
  if (SECTION_TAGS.has(el.tag) || el.tag === 'ul' || el.tag === 'ol') return 'container';
  return 'other';
}

function labelFor(el: HtmlElement, source: string, kind: NodeKind): string {
  const type = attr(el, 'data-mv-section');
  const comp = attr(el, 'data-mv-component');
  if (comp) return `Component: ${comp}`;
  if (type) return type.replace(/(^|-)([a-z])/g, (_m, sep: string, c: string) => `${sep ? ' ' : ''}${c.toUpperCase()}`);
  if (kind === 'image') return `Image${attr(el, 'alt') ? `: ${attr(el, 'alt')}` : ''}`;
  const text = innerText(source, el);
  const id = attr(el, 'id');
  if (kind === 'section' || kind === 'container') return `${el.tag}${id ? ` #${id}` : attr(el, 'class') ? ` .${attr(el, 'class')!.split(/\s+/)[0]}` : ''}`;
  return text ? `${el.tag}: ${text.slice(0, 48)}${text.length > 48 ? '…' : ''}` : el.tag;
}

function describeNode(doc: HtmlDocument, el: HtmlElement, isSection: boolean, depth: number): DesignNode {
  const source = doc.source;
  const kind = kindOf(el, isSection);
  const mvId = attr(el, 'data-mv-id');
  const editableText = (kind === 'text' || kind === 'link' || kind === 'button') && !hasElementChildren(el);
  const node: DesignNode = {
    key: mvId ? `id:${mvId}` : `p:${pathOf(doc, el)}`,
    mvId,
    path: pathOf(doc, el),
    tag: el.tag,
    kind,
    label: labelFor(el, source, kind),
    text: kind === 'image' ? null : innerText(source, el) || null,
    editableText,
    attrs: {},
    component: attr(el, 'data-mv-component'),
    object: attr(el, 'data-mv-object'),
    sectionType: attr(el, 'data-mv-section'),
    children: [],
  };
  for (const name of ['href', 'src', 'alt', 'target'] as const) {
    const v = attr(el, name);
    if (v !== null) node.attrs[name] = v;
  }
  if (depth < 6 && kind !== 'image' && !editableText) {
    node.children = elementChildren(el)
      .filter((c) => !['br', 'source', 'path', 'use'].includes(c.tag))
      .map((c) => describeNode(doc, c, false, depth + 1))
      .filter((n) => n.kind !== 'other' || n.children.length > 0);
  }
  return node;
}

export function isFrameworkPage(doc: HtmlDocument): string | null {
  const b = body(doc);
  const kids = elementChildren(b);
  const rootDiv = kids.find((k) => k.tag === 'div' && ['root', 'app'].includes(attr(k, 'id') ?? '') && k.children.length === 0);
  const moduleScript = doc.elements.find((e) => e.tag === 'script' && attr(e, 'type') === 'module' && /\.(t|j)sx?$/.test(attr(e, 'src') ?? ''));
  if (rootDiv && moduleScript) return 'This page is rendered by JavaScript (it mounts an app into an empty root element). Visual editing works on HTML pages; edit this app’s components in Build.';
  return null;
}

export function outline(source: string): PageOutline {
  const doc = parseHtml(source);
  const titleEl = doc.elements.find((e) => e.tag === 'title');
  const title = titleEl ? innerText(source, titleEl) : '';
  const framework = isFrameworkPage(doc);
  if (framework) return { title, supported: false, reason: framework, sections: [] };
  const b = body(doc);
  const container = sectionContainer(doc);
  const sections: DesignNode[] = [];
  for (const el of elementChildren(b)) {
    if (el === container) {
      for (const s of elementChildren(container)) sections.push(describeNode(doc, s, true, 0));
    } else if (el.tag === 'header' || el.tag === 'footer' || el.tag === 'nav' || attr(el, 'data-mv-section')) {
      sections.push(describeNode(doc, el, true, 0));
    }
  }
  return { title, supported: true, reason: null, sections };
}

/* ---------------- edits (pure: source in, source out) ---------------- */

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'el'
  );
}

export function allIds(source: string): Set<string> {
  const ids = new Set<string>();
  for (const m of source.matchAll(/data-mv-id="([^"]+)"/g)) ids.add(m[1]!);
  return ids;
}

function uniqueId(source: string, base: string): string {
  const ids = allIds(source);
  let id = base;
  for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
  return id;
}

function setAttrIn(source: string, el: HtmlElement, name: string, value: string | null): string {
  const existing = el.attrs.find((a) => a.name.toLowerCase() === name);
  if (existing) {
    if (value === null) {
      const start = source.lastIndexOf(' ', existing.start) >= el.start ? source.lastIndexOf(' ', existing.start) : existing.start;
      return source.slice(0, start) + source.slice(existing.end);
    }
    return `${source.slice(0, existing.start)}${name}="${escapeAttr(value)}"${source.slice(existing.end)}`;
  }
  if (value === null) return source;
  const insertAt = el.start + 1 + el.tag.length;
  return `${source.slice(0, insertAt)} ${name}="${escapeAttr(value)}"${source.slice(insertAt)}`;
}

/** Make sure the element has a data-mv-id. Returns the new source and the id. */
export function ensureId(source: string, target: Target): { source: string; id: string } {
  const doc = parseHtml(source);
  const el = resolve(doc, target);
  const existing = attr(el, 'data-mv-id');
  if (existing) return { source, id: existing };
  const base = attr(el, 'data-mv-section') ?? attr(el, 'id') ?? `${el.tag}-${slug(innerText(source, el)) || el.tag}`;
  const id = uniqueId(source, slug(base));
  return { source: setAttrIn(source, el, 'data-mv-id', id), id };
}

export function setText(source: string, target: Target, text: string): string {
  const { source: withId, id } = ensureId(source, target);
  const doc = parseHtml(withId);
  const el = resolve(doc, { id });
  if (!el.explicitClose || el.closeStart < el.openEnd) throw new CommandError(`A <${el.tag}> element has no text content to edit.`);
  if (hasElementChildren(el)) throw new CommandError('This text contains other elements (links, emphasis or icons). Edit it in Build so that markup is not lost, or edit the inner elements one by one.');
  const html = escapeText(text).replace(/\n/g, '<br>');
  return withId.slice(0, el.openEnd) + html + withId.slice(el.closeStart);
}

const ATTRS = new Set(['href', 'src', 'alt', 'target', 'title', 'aria-label', 'rel']);

export function setAttribute(source: string, target: Target, name: string, value: string | null): string {
  if (!ATTRS.has(name)) throw new CommandError(`The ${name} attribute is not edited visually.`);
  if (value !== null && (name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) throw new CommandError('javascript: links are not allowed.');
  const { source: withId, id } = ensureId(source, target);
  const doc = parseHtml(withId);
  let out = setAttrIn(withId, resolve(doc, { id }), name, value);
  if (name === 'target' && value === '_blank') {
    const d2 = parseHtml(out);
    out = setAttrIn(out, resolve(d2, { id }), 'rel', 'noopener');
  }
  return out;
}

function sectionsOf(doc: HtmlDocument): HtmlElement[] {
  return elementChildren(sectionContainer(doc));
}

export function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart, offset))![0];
}

/** Re-indent a block of HTML to the given indentation. */
export function indentBlock(html: string, indent: string): string {
  const lines = html.trim().split('\n');
  const minIndent = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length), Infinity);
  return lines.map((l, i) => (i === 0 ? l.trim() : `${indent}${Number.isFinite(minIndent) ? l.slice(Math.min(minIndent, /^[ \t]*/.exec(l)![0].length)) : l.trim()}`)).join('\n');
}

/** Give every data-mv-id inside a block of HTML a fresh, unique id for this page. */
export function freshIds(source: string, block: string): string {
  const taken = allIds(source);
  return block.replace(/data-mv-id="([^"]+)"/g, (_m, id: string) => {
    let next = id;
    for (let i = 2; taken.has(next); i++) next = `${id}-${i}`;
    taken.add(next);
    return `data-mv-id="${next}"`;
  });
}

export function insertSection(source: string, html: string, index: number): string {
  const doc = parseHtml(source);
  const container = sectionContainer(doc);
  const list = sectionsOf(doc);
  const block = freshIds(source, html);
  if (list.length === 0) {
    const indent = `${lineIndent(source, container.start)}  `;
    return `${source.slice(0, container.openEnd)}\n${indent}${indentBlock(block, indent)}\n${lineIndent(source, container.start)}${source.slice(container.closeStart).replace(/^\s*/, '')}`;
  }
  const i = Math.max(0, Math.min(index, list.length));
  if (i < list.length) {
    const ref = list[i]!;
    const indent = lineIndent(source, ref.start);
    return `${source.slice(0, ref.start)}${indentBlock(block, indent)}\n\n${indent}${source.slice(ref.start)}`;
  }
  const last = list[list.length - 1]!;
  const indent = lineIndent(source, last.start);
  return `${source.slice(0, last.end)}\n\n${indent}${indentBlock(block, indent)}${source.slice(last.end)}`;
}

function outerWithLine(source: string, el: HtmlElement): { start: number; end: number } {
  // Include the element's leading indentation and one trailing newline so removal leaves no gap.
  let start = el.start;
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start--;
  let end = el.end;
  if (source[end] === '\n') end++;
  else if (source.slice(end, end + 2) === '\r\n') end += 2;
  if (source.slice(end).match(/^[ \t]*\r?\n/)) end += source.slice(end).match(/^[ \t]*\r?\n/)![0].length;
  return { start, end };
}

export function removeSection(source: string, target: Target): string {
  const doc = parseHtml(source);
  const el = resolve(doc, target);
  if (!sectionsOf(doc).includes(el) && !['header', 'footer', 'nav'].includes(el.tag)) throw new CommandError('Only whole sections can be removed here.');
  const { start, end } = outerWithLine(source, el);
  return source.slice(0, start) + source.slice(end);
}

export function moveSection(source: string, target: Target, toIndex: number): string {
  const doc = parseHtml(source);
  const el = resolve(doc, target);
  const list = sectionsOf(doc);
  const from = list.indexOf(el);
  if (from === -1) throw new CommandError('Only sections inside the main content can be reordered.');
  if (toIndex === from) return source;
  const html = source.slice(el.start, el.end);
  const removed = removeSection(source, target);
  // Re-insert without fresh ids (it is the same section) so it ends up at index `toIndex`.
  const list2 = sectionsOf(parseHtml(removed));
  const i = Math.max(0, Math.min(toIndex, list2.length));
  if (i < list2.length) {
    const ref = list2[i]!;
    const indent = lineIndent(removed, ref.start);
    return `${removed.slice(0, ref.start)}${indentBlock(html, indent)}\n\n${indent}${removed.slice(ref.start)}`;
  }
  const last = list2[list2.length - 1]!;
  const indent = lineIndent(removed, last.start);
  return `${removed.slice(0, last.end)}\n\n${indent}${indentBlock(html, indent)}${removed.slice(last.end)}`;
}

export function duplicateSection(source: string, target: Target): string {
  const doc = parseHtml(source);
  const el = resolve(doc, target);
  const list = sectionsOf(doc);
  const index = list.indexOf(el);
  if (index === -1) throw new CommandError('Only sections inside the main content can be duplicated.');
  return insertSection(source, source.slice(el.start, el.end), index + 1);
}

export function outerHtml(source: string, target: Target): string {
  const doc = parseHtml(source);
  const el = resolve(doc, target);
  return source.slice(el.start, el.end);
}

/** Replace every instance of a reusable component (elements with data-mv-component=name). */
export function replaceComponentInstances(source: string, name: string, componentHtml: string): { source: string; count: number } {
  let out = source;
  let count = 0;
  for (let guard = 0; guard < 200; guard++) {
    const doc = parseHtml(out);
    const instances = doc.elements.filter((e) => attr(e, 'data-mv-component') === name);
    const stale = instances.find((e) => out.slice(e.start, e.end).trim() !== componentHtml.trim() && !out.slice(e.start, e.end).includes('data-mv-synced'));
    if (!stale) break;
    const indent = lineIndent(out, stale.start);
    out = `${out.slice(0, stale.start)}${indentBlock(componentHtml, indent).replace(`data-mv-component="${name}"`, `data-mv-component="${name}" data-mv-synced`)}${out.slice(stale.end)}`;
    count += 1;
  }
  return { source: out.replace(/ data-mv-synced/g, ''), count };
}

export function pageTitle(source: string): string {
  const doc = parseHtml(source);
  const t = doc.elements.find((e) => e.tag === 'title');
  return t ? innerText(source, t) : '';
}

export function setTitle(source: string, title: string): string {
  const doc = parseHtml(source);
  const t = doc.elements.find((e) => e.tag === 'title');
  if (!t) return source;
  return source.slice(0, t.openEnd) + escapeText(title) + source.slice(t.closeStart);
}

/**
 * A new page that shares the source page's head (styles, fonts), header and footer, with an empty
 * main containing one text section.
 */
export function newPageFrom(source: string, title: string, intro: string): string {
  const doc = parseHtml(source);
  const container = sectionContainer(doc);
  const textSection = `<section class="mv-text" data-mv-section="text" data-mv-id="intro">\n  <div class="mv-container">\n    <h1 data-mv-id="page-title">${escapeText(title)}</h1>\n    <p data-mv-id="page-intro">${escapeText(intro)}</p>\n  </div>\n</section>`;
  let out = setTitle(source, title);
  const d2 = parseHtml(out);
  const c2 = sectionContainer(d2);
  const indent = `${lineIndent(out, c2.start)}  `;
  if (c2.tag === 'main') {
    out = `${out.slice(0, c2.openEnd)}\n${indent}${indentBlock(textSection, indent)}\n${lineIndent(out, c2.start)}${out.slice(c2.closeStart)}`;
  } else {
    // No <main>: keep header/footer, replace the rest of the body.
    const keep = elementChildren(c2).filter((e) => e.tag === 'header' || e.tag === 'footer' || e.tag === 'nav' || e.tag === 'script');
    const head = keep.filter((e) => e.tag !== 'footer' && e.tag !== 'script').map((e) => out.slice(e.start, e.end));
    const tail = keep.filter((e) => e.tag === 'footer' || e.tag === 'script').map((e) => out.slice(e.start, e.end));
    out = `${out.slice(0, c2.openEnd)}\n${[...head, `<main>\n${indentBlock(textSection, '  ')}\n</main>`, ...tail].map((h) => `  ${h}`).join('\n')}\n${out.slice(c2.closeStart)}`;
  }
  void container;
  return out;
}
