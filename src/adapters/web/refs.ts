/** Local file references in HTML and CSS: used for exports, section combining and diagnostics. */
import { parseHtml, attr, type HtmlDocument, type HtmlElement } from './html';
import { cssUrls } from './css';
import { fileExtension, resolveRelativeReference } from '../../shared/paths';

export interface LocalReference {
  /** The file that contains the reference. */
  from: string;
  /** The reference exactly as written. */
  raw: string;
  /** Resolved project path, or null if it escapes the project. */
  resolved: string | null;
  kind: 'asset' | 'stylesheet' | 'script' | 'page';
  offset: number;
}

export function isExternalReference(value: string): boolean {
  const v = value.trim();
  return v === '' || v.startsWith('#') || v.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('{{');
}

function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
}

export function elementReferences(fromFile: string, el: HtmlElement, source: string): LocalReference[] {
  const out: LocalReference[] = [];
  const push = (raw: string, kind: LocalReference['kind']): void => {
    if (isExternalReference(raw)) return;
    out.push({ from: fromFile, raw, resolved: resolveRelativeReference(fromFile, raw), kind, offset: el.start });
  };
  const rel = (attr(el, 'rel') ?? '').toLowerCase();
  for (const a of el.attrs) {
    const value = a.value;
    if (value === null || value === '') continue;
    switch (a.name) {
      case 'src':
        push(value, el.tag === 'script' ? 'script' : 'asset');
        break;
      case 'href':
      case 'xlink:href':
        if (el.tag === 'link') {
          if (rel.includes('stylesheet')) push(value, 'stylesheet');
          else if (/icon|preload|manifest|apple-touch/.test(rel)) push(value, 'asset');
        } else if (el.tag === 'a' || el.tag === 'area') {
          const ext = fileExtension(value.split(/[?#]/)[0] ?? '');
          push(value, ext === '' || ext === 'html' || ext === 'htm' ? 'page' : 'asset');
        } else if (el.tag === 'use' || el.tag === 'image') {
          push(value, 'asset');
        }
        break;
      case 'srcset':
        for (const url of srcsetUrls(value)) push(url, 'asset');
        break;
      case 'poster':
      case 'data':
        push(value, 'asset');
        break;
      case 'style':
        for (const { url } of cssUrls(value)) push(url, 'asset');
        break;
      default:
        break;
    }
  }
  if (el.tag === 'style') {
    for (const { url } of cssUrls(source.slice(el.openEnd, el.closeStart))) push(url, 'asset');
  }
  return out;
}

export function htmlReferences(fromFile: string, source: string, doc: HtmlDocument = parseHtml(source)): LocalReference[] {
  return doc.elements.flatMap((el) => elementReferences(fromFile, el, source));
}

export function cssReferences(fromFile: string, source: string): LocalReference[] {
  return cssUrls(source)
    .filter(({ url }) => !isExternalReference(url))
    .map(({ url, index }) => ({ from: fromFile, raw: url, resolved: resolveRelativeReference(fromFile, url), kind: 'asset' as const, offset: index }));
}

export function referencesInFile(path: string, text: string): LocalReference[] {
  const ext = fileExtension(path);
  if (ext === 'html' || ext === 'htm') return htmlReferences(path, text);
  if (ext === 'css') return cssReferences(path, text);
  return [];
}

/** Compute a relative reference from one project file to another (POSIX). */
export function relativeReference(fromFile: string, toPath: string): string {
  const fromDir = fromFile.split('/').slice(0, -1);
  const target = toPath.split('/');
  let common = 0;
  while (common < fromDir.length && common < target.length - 1 && fromDir[common] === target[common]) common++;
  const ups = fromDir.length - common;
  return [...Array<string>(ups).fill('..'), ...target.slice(common)].join('/');
}

/** Rewrite url(...) references in CSS copied from one file location to another. */
export function rewriteCssUrls(text: string, fromFile: string, toFile: string): string {
  if (fromFile.split('/').slice(0, -1).join('/') === toFile.split('/').slice(0, -1).join('/')) return text;
  return text.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (match, quote: string, url: string) => {
    if (isExternalReference(url)) return match;
    const resolved = resolveRelativeReference(fromFile, url.trim());
    if (!resolved) return match;
    const suffix = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    return `url(${quote}${relativeReference(toFile, resolved)}${suffix}${quote})`;
  });
}

/** Rewrite relative src/href/srcset/url() references in an HTML fragment moved between files. */
export function rewriteHtmlFragment(fragment: string, fromFile: string, toFile: string): string {
  const sameDir = fromFile.split('/').slice(0, -1).join('/') === toFile.split('/').slice(0, -1).join('/');
  if (sameDir) return fragment;
  const fix = (url: string): string => {
    if (isExternalReference(url)) return url;
    const resolved = resolveRelativeReference(fromFile, url);
    if (!resolved) return url;
    const suffix = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    return relativeReference(toFile, resolved) + suffix;
  };
  return fragment
    .replace(/\b(src|href|poster|data|xlink:href)=(["'])([^"']*)\2/gi, (_m, name: string, q: string, url: string) => `${name}=${q}${fix(url)}${q}`)
    .replace(/\bsrcset=(["'])([^"']*)\1/gi, (_m, q: string, value: string) =>
      `srcset=${q}${value
        .split(',')
        .map((part) => {
          const [url, ...rest] = part.trim().split(/\s+/);
          return [fix(url ?? ''), ...rest].join(' ');
        })
        .join(', ')}${q}`,
    )
    .replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (_m, q: string, url: string) => `url(${q}${fix(url.trim())}${q})`);
}
