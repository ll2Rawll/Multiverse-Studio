/**
 * A tolerant HTML scanner that keeps exact source offsets.
 *
 * Section combining must splice one document's markup into another without
 * re-serializing (which would reformat the user's code), so we need the precise
 * start/end of each element in the original text. The scanner follows the HTML rules
 * that matter for that: void elements, raw-text elements, comments, optional end tags,
 * and implied closing of paragraphs and list items. When markup is misnested the
 * affected elements are flagged so the UI can fall back to source-level selection.
 */

export interface HtmlAttribute {
  name: string;
  value: string | null;
  start: number;
  end: number;
}

export interface HtmlElement {
  tag: string;
  attrs: HtmlAttribute[];
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  explicitClose: boolean;
  misnested: boolean;
  children: HtmlElement[];
  parent: HtmlElement | null;
  depth: number;
}

export interface HtmlProblem {
  message: string;
  offset: number;
  severity: 'error' | 'warning';
}

export interface HtmlDocument {
  source: string;
  root: HtmlElement;
  elements: HtmlElement[];
  problems: HtmlProblem[];
  lineStarts: number[];
}

export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);
const OPTIONAL_END = new Set([
  'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'rt', 'rp',
  'html', 'head', 'body', 'caption',
]);
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'ul', 'search',
]);

function implicitlyClosedBy(open: string, incoming: string): boolean {
  switch (open) {
    case 'p':
      return CLOSES_P.has(incoming);
    case 'li':
      return incoming === 'li';
    case 'dt':
    case 'dd':
      return incoming === 'dt' || incoming === 'dd';
    case 'option':
      return incoming === 'option' || incoming === 'optgroup';
    case 'optgroup':
      return incoming === 'optgroup';
    case 'tr':
      return incoming === 'tr' || incoming === 'tbody' || incoming === 'tfoot';
    case 'td':
    case 'th':
      return incoming === 'td' || incoming === 'th' || incoming === 'tr' || incoming === 'tbody' || incoming === 'tfoot';
    case 'thead':
    case 'tbody':
      return incoming === 'tbody' || incoming === 'tfoot';
    default:
      return false;
  }
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function offsetToLine(lineStarts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
}

const NAME_CHAR = /[A-Za-z0-9:_.-]/;

function parseAttributes(source: string, from: number): { attrs: HtmlAttribute[]; end: number; selfClosing: boolean } {
  const attrs: HtmlAttribute[] = [];
  let i = from;
  const n = source.length;
  while (i < n) {
    while (i < n && /\s/.test(source[i]!)) i++;
    if (i >= n) break;
    const ch = source[i]!;
    if (ch === '>') return { attrs, end: i + 1, selfClosing: false };
    if (ch === '/' && source[i + 1] === '>') return { attrs, end: i + 2, selfClosing: true };
    if (ch === '/') {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < n && !/[\s=>/]/.test(source[i]!)) i++;
    if (i === nameStart) {
      i++;
      continue;
    }
    const name = source.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < n && /\s/.test(source[j]!)) j++;
    if (source[j] !== '=') {
      attrs.push({ name, value: null, start: nameStart, end: i });
      continue;
    }
    j++;
    while (j < n && /\s/.test(source[j]!)) j++;
    const quote = source[j];
    if (quote === '"' || quote === "'") {
      const close = source.indexOf(quote, j + 1);
      const end = close < 0 ? n : close;
      attrs.push({ name, value: source.slice(j + 1, end), start: nameStart, end: Math.min(n, end + 1) });
      i = Math.min(n, end + 1);
    } else {
      const valueStart = j;
      while (j < n && !/[\s>]/.test(source[j]!)) j++;
      attrs.push({ name, value: source.slice(valueStart, j), start: nameStart, end: j });
      i = j;
    }
  }
  return { attrs, end: n, selfClosing: false };
}

export function parseHtml(source: string): HtmlDocument {
  const root: HtmlElement = {
    tag: '#document',
    attrs: [],
    start: 0,
    openEnd: 0,
    closeStart: source.length,
    end: source.length,
    explicitClose: true,
    misnested: false,
    children: [],
    parent: null,
    depth: -1,
  };
  const elements: HtmlElement[] = [];
  const problems: HtmlProblem[] = [];
  const stack: HtmlElement[] = [root];
  const n = source.length;
  let i = 0;
  let lower: string | null = null;

  const top = (): HtmlElement => stack[stack.length - 1]!;
  const closeImplicitly = (el: HtmlElement, at: number): void => {
    el.closeStart = at;
    el.end = at;
    el.explicitClose = false;
    if (!OPTIONAL_END.has(el.tag)) {
      el.misnested = true;
      problems.push({ message: `<${el.tag}> is not closed`, offset: el.start, severity: 'error' });
    }
  };

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end < 0) problems.push({ message: 'Comment is not closed', offset: lt, severity: 'error' });
      i = end < 0 ? n : end + 3;
      continue;
    }
    const next = source[lt + 1] ?? '';
    if (next === '!' || next === '?') {
      const end = source.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (next === '/') {
      let j = lt + 2;
      while (j < n && NAME_CHAR.test(source[j]!)) j++;
      const name = source.slice(lt + 2, j).toLowerCase();
      const gt = source.indexOf('>', j);
      const end = gt < 0 ? n : gt + 1;
      if (name.length === 0) {
        i = end;
        continue;
      }
      let k = stack.length - 1;
      while (k > 0 && stack[k]!.tag !== name) k--;
      if (k === 0) {
        if (name !== 'br' && name !== 'p') problems.push({ message: `Unexpected closing tag </${name}>`, offset: lt, severity: 'warning' });
        i = end;
        continue;
      }
      while (stack.length - 1 > k) closeImplicitly(stack.pop()!, lt);
      const el = stack.pop()!;
      el.closeStart = lt;
      el.end = end;
      el.explicitClose = true;
      i = end;
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && NAME_CHAR.test(source[j]!)) j++;
    const tag = source.slice(lt + 1, j).toLowerCase();
    const { attrs, end: openEnd, selfClosing } = parseAttributes(source, j);

    while (stack.length > 1 && implicitlyClosedBy(top().tag, tag)) {
      const closed = stack.pop()!;
      closed.closeStart = lt;
      closed.end = lt;
      closed.explicitClose = false;
    }

    const parent = top();
    const el: HtmlElement = {
      tag,
      attrs,
      start: lt,
      openEnd,
      closeStart: openEnd,
      end: openEnd,
      explicitClose: true,
      misnested: false,
      children: [],
      parent,
      depth: parent.depth + 1,
    };
    parent.children.push(el);
    elements.push(el);

    if (VOID_ELEMENTS.has(tag) || selfClosing) {
      i = openEnd;
      continue;
    }
    if (RAW_TEXT.has(tag)) {
      lower ??= source.toLowerCase();
      const close = lower.indexOf(`</${tag}`, openEnd);
      if (close < 0) {
        el.closeStart = n;
        el.end = n;
        el.explicitClose = false;
        el.misnested = true;
        problems.push({ message: `<${tag}> is not closed`, offset: lt, severity: 'error' });
        i = n;
      } else {
        const gt = source.indexOf('>', close);
        el.closeStart = close;
        el.end = gt < 0 ? n : gt + 1;
        i = el.end;
      }
      continue;
    }
    stack.push(el);
    i = openEnd;
  }
  while (stack.length > 1) closeImplicitly(stack.pop()!, n);

  // Mark ancestors of misnested elements so section boundaries can be trusted or not.
  for (const el of elements) {
    if (!el.misnested) continue;
    let p = el.parent;
    while (p && p !== root) {
      p.misnested = true;
      p = p.parent;
    }
  }
  return { source, root, elements, problems, lineStarts: computeLineStarts(source) };
}

export function attr(el: HtmlElement, name: string): string | null {
  const found = el.attrs.find((a) => a.name === name);
  return found ? (found.value ?? '') : null;
}

export function classList(el: HtmlElement): string[] {
  const value = attr(el, 'class');
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

export function descendants(el: HtmlElement): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (node: HtmlElement): void => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

export function isInside(el: HtmlElement, tag: string): boolean {
  let p = el.parent;
  while (p) {
    if (p.tag === tag) return true;
    p = p.parent;
  }
  return false;
}

export function textContent(source: string, el: HtmlElement): string {
  return source
    .slice(el.openEnd, el.closeStart)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findElement(doc: HtmlDocument, tag: string): HtmlElement | undefined {
  return doc.elements.find((e) => e.tag === tag);
}
