/**
 * A CSS rule locator with source offsets: style rules, @font-face, @keyframes and
 * rules nested in conditional groups (@media, @supports, @container, @layer).
 */
import { offsetToLine } from './html';

export type CssRuleKind = 'style' | 'font-face' | 'keyframes' | 'at-statement' | 'other-block';

export interface CssRule {
  kind: CssRuleKind;
  prelude: string;
  body: string;
  start: number;
  end: number;
  media: string[];
  text: string;
}

export interface CssProblem {
  message: string;
  offset: number;
}

export interface CssSheet {
  source: string;
  rules: CssRule[];
  problems: CssProblem[];
}

const GROUP_RULES = /^@(media|supports|container|layer|document|-moz-document|scope|starting-style)\b/i;

function skipComment(s: string, i: number): number {
  const end = s.indexOf('*/', i + 2);
  return end < 0 ? s.length : end + 2;
}

function skipString(s: string, i: number): number {
  const quote = s[i];
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote || ch === '\n') return j + 1;
    j++;
  }
  return s.length;
}

/** Find the `}` matching the `{` at `open`, skipping strings, comments and nested blocks. */
function matchBrace(s: string, open: number, limit: number): number {
  let depth = 0;
  let i = open;
  while (i < limit) {
    const ch = s[i]!;
    if (ch === '/' && s[i + 1] === '*') {
      i = skipComment(s, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(s, i);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

export function parseCss(source: string): CssSheet {
  const rules: CssRule[] = [];
  const problems: CssProblem[] = [];

  const parseBlock = (from: number, to: number, media: string[]): void => {
    let i = from;
    while (i < to) {
      const ch = source[i]!;
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        const end = skipComment(source, i);
        if (end >= source.length && !source.endsWith('*/')) problems.push({ message: 'Comment is not closed', offset: i });
        i = end;
        continue;
      }
      const preludeStart = i;
      let j = i;
      let paren = 0;
      let stop = -1;
      while (j < to) {
        const c = source[j]!;
        if (c === '/' && source[j + 1] === '*') {
          j = skipComment(source, j);
          continue;
        }
        if (c === '"' || c === "'") {
          j = skipString(source, j);
          continue;
        }
        if (c === '(') paren++;
        else if (c === ')') paren = Math.max(0, paren - 1);
        else if (paren === 0 && (c === '{' || c === ';' || c === '}')) {
          stop = j;
          break;
        }
        j++;
      }
      if (stop < 0) {
        const tail = source.slice(preludeStart, to).trim();
        if (tail.length > 0) problems.push({ message: 'Unexpected end of stylesheet', offset: preludeStart });
        break;
      }
      const stopChar = source[stop];
      const prelude = source.slice(preludeStart, stop).trim();
      if (stopChar === ';') {
        if (prelude.startsWith('@')) {
          rules.push({ kind: 'at-statement', prelude, body: '', start: preludeStart, end: stop + 1, media, text: source.slice(preludeStart, stop + 1) });
        } else if (prelude.length > 0) {
          problems.push({ message: 'Declaration outside of a rule', offset: preludeStart });
        }
        i = stop + 1;
        continue;
      }
      if (stopChar === '}') {
        problems.push({ message: 'Unexpected }', offset: stop });
        i = stop + 1;
        continue;
      }
      let close = matchBrace(source, stop, to);
      if (close < 0) {
        problems.push({ message: `Block for “${prelude.slice(0, 40)}” is not closed`, offset: preludeStart });
        close = to - 1;
      }
      if (GROUP_RULES.test(prelude)) {
        parseBlock(stop + 1, close, [...media, prelude]);
      } else {
        let kind: CssRuleKind = 'style';
        if (/^@font-face\b/i.test(prelude)) kind = 'font-face';
        else if (/^@(-webkit-|-moz-|-o-)?keyframes\b/i.test(prelude)) kind = 'keyframes';
        else if (prelude.startsWith('@')) kind = 'other-block';
        rules.push({
          kind,
          prelude,
          body: source.slice(stop + 1, close),
          start: preludeStart,
          end: close + 1,
          media,
          text: source.slice(preludeStart, close + 1),
        });
      }
      i = close + 1;
    }
  };

  parseBlock(0, source.length, []);
  return { source, rules, problems };
}

/** Split a selector list on top-level commas. */
export function splitSelectorList(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export interface SelectorParts {
  ids: string[];
  classes: string[];
  tags: string[];
  compounds: { ids: string[]; classes: string[]; tag: string | null }[];
  hasUniversalOrGlobal: boolean;
}

/** Rough structural breakdown of one complex selector. */
export function analyzeSelector(selector: string): SelectorParts {
  // Drop attribute selectors and string contents; keep :not()/:is() arguments as references.
  const cleaned = selector
    .replace(/\[[^\]]*\]/g, '')
    .replace(/::?[a-zA-Z-]+(?=\s|$|[.#:>+~,)])/g, '')
    .replace(/[():]/g, ' ');
  const compounds = cleaned
    .split(/\s*[>+~]\s*|\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const ids = [...part.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
      const classes = [...part.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
      const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(part);
      const tag = tagMatch ? tagMatch[1]!.toLowerCase() : null;
      return { ids, classes, tag };
    });
  const ids = compounds.flatMap((c) => c.ids);
  const classes = compounds.flatMap((c) => c.classes);
  const tags = compounds.map((c) => c.tag).filter((t): t is string => Boolean(t) && !['not', 'is', 'where', 'has', 'nth', 'child', 'of', 'type'].includes(t!));
  const hasUniversalOrGlobal = /(^|\s)\*|:root|^html\b|^body\b/.test(selector);
  return { ids, classes, tags, compounds, hasUniversalOrGlobal };
}

export function cssUrls(text: string): { url: string; index: number }[] {
  const out: { url: string; index: number }[] = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi;
  for (const m of text.matchAll(re)) {
    const url = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (url) out.push({ url, index: m.index ?? 0 });
  }
  const importRe = /@import\s+(?:"([^"]+)"|'([^']+)')/gi;
  for (const m of text.matchAll(importRe)) {
    const url = (m[1] ?? m[2] ?? '').trim();
    if (url) out.push({ url, index: m.index ?? 0 });
  }
  return out;
}

export function usedVariables(text: string): string[] {
  return [...new Set([...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!))];
}

export function declaredVariables(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

export function fontFamiliesUsed(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/font(?:-family)?\s*:\s*([^;}]+)/gi)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^["']|["']$/g, '').trim();
      // the shorthand also contains sizes and weights; keep only plausible family names
      const last = name.split(/\s+(?=[A-Za-z"'])/).pop() ?? name;
      if (name) out.add(name.toLowerCase());
      if (last) out.add(last.replace(/^["']|["']$/g, '').toLowerCase());
    }
  }
  return [...out];
}

export function fontFaceFamily(body: string): string | null {
  const m = /font-family\s*:\s*([^;}]+)/i.exec(body);
  return m ? m[1]!.trim().replace(/^["']|["']$/g, '').toLowerCase() : null;
}

export function animationNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/gi)) {
    for (const token of m[1]!.split(/[\s,]+/)) {
      if (/^[a-zA-Z_][\w-]*$/.test(token) && !/^(ease|linear|infinite|alternate|forwards|backwards|both|none|normal|reverse|running|paused|step-start|step-end|ease-in|ease-out|ease-in-out)$/i.test(token)) {
        out.add(token);
      }
    }
  }
  return [...out];
}

export function keyframesName(prelude: string): string | null {
  const m = /^@(?:-webkit-|-moz-|-o-)?keyframes\s+["']?([\w-]+)/i.exec(prelude);
  return m ? m[1]! : null;
}

export function cssLine(source: string, offset: number): number {
  const starts = [0];
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return offsetToLine(starts, offset).line;
}
