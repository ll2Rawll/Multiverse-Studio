/**
 * Constrained HTML section combining.
 *
 * Supported sections are elements with a stable, unique id, and landmark elements
 * (header, nav, main, section, article, aside, footer) that can be addressed by tag and
 * position. For a chosen section we report the related CSS rules, design tokens,
 * fonts, animations, local assets and scripts — with explicit uncertainty — and can
 * splice it into another document without reformatting the rest of that document.
 */
import { attr, classList, descendants, isInside, offsetToLine, parseHtml, textContent, type HtmlDocument, type HtmlElement } from './html';
import {
  analyzeSelector,
  animationNames,
  cssUrls,
  declaredVariables,
  fontFaceFamily,
  fontFamiliesUsed,
  keyframesName,
  parseCss,
  splitSelectorList,
  usedVariables,
  type CssRule,
} from './css';
import { elementReferences, isExternalReference, relativeReference, rewriteCssUrls, rewriteHtmlFragment } from './refs';
import { resolveRelativeReference } from '../../shared/paths';
import type {
  AssetDependency,
  CombineWarning,
  CssRuleCandidate,
  SectionAnalysis,
  SectionInfo,
  SectionStep,
  SectionTarget,
} from '../../shared/types';

export interface TreeReader {
  label: string;
  paths(): string[];
  hash(path: string): string | undefined;
  text(path: string): Promise<string | null>;
}

const LANDMARKS = new Set(['header', 'nav', 'main', 'section', 'article', 'aside', 'footer']);
const BLOCK_WITH_ID = new Set([
  ...LANDMARKS, 'div', 'form', 'figure', 'ul', 'ol', 'dl', 'table', 'blockquote', 'details', 'address', 'hgroup', 'search', 'menu',
]);
const TAG_LABELS: Record<string, string> = {
  header: 'Header',
  nav: 'Navigation',
  main: 'Main content',
  section: 'Section',
  article: 'Article',
  aside: 'Sidebar',
  footer: 'Footer',
  form: 'Form',
  figure: 'Figure',
  div: 'Block',
  ul: 'List',
  ol: 'List',
  dl: 'List',
  table: 'Table',
  blockquote: 'Quote',
  details: 'Details',
  address: 'Address',
  hgroup: 'Heading group',
  search: 'Search',
  menu: 'Menu',
};

function humanize(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface LocatedSection {
  info: SectionInfo;
  element: HtmlElement;
}

function idCounts(doc: HtmlDocument): Map<string, number> {
  const counts = new Map<string, number>();
  for (const el of doc.elements) {
    const id = attr(el, 'id');
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export function locateSections(doc: HtmlDocument): LocatedSection[] {
  const counts = idCounts(doc);
  const byTag = new Map<string, HtmlElement[]>();
  // header/footer inside a quote or figure describe that quote, not the page.
  const isLandmark = (el: HtmlElement): boolean =>
    LANDMARKS.has(el.tag) && !((el.tag === 'footer' || el.tag === 'header') && (isInside(el, 'blockquote') || isInside(el, 'figure')));
  for (const el of doc.elements) {
    if (!isLandmark(el) || isInside(el, 'head')) continue;
    const list = byTag.get(el.tag) ?? [];
    list.push(el);
    byTag.set(el.tag, list);
  }
  const bodyDepth = doc.elements.find((e) => e.tag === 'body')?.depth ?? 0;
  const out: LocatedSection[] = [];
  for (const el of doc.elements) {
    if (isInside(el, 'head') || el.tag === 'html' || el.tag === 'body' || el.tag === 'head') continue;
    const id = attr(el, 'id');
    const uniqueId = id && counts.get(id) === 1 ? id : null;
    let key: string | null = null;
    if (uniqueId && BLOCK_WITH_ID.has(el.tag)) key = `#${uniqueId}`;
    else if (isLandmark(el)) {
      const peers = byTag.get(el.tag) ?? [];
      const index = peers.indexOf(el);
      key = peers.length === 1 ? el.tag : `${el.tag}:nth(${index + 1})`;
    }
    if (!key) continue;
    let reason: string | null = null;
    if (el.misnested) reason = 'The markup inside this element is not cleanly nested, so its boundaries are uncertain.';
    else if (!el.explicitClose) reason = 'This element has no closing tag, so its end is uncertain.';
    else if (id && counts.get(id)! > 1) reason = `The id “${id}” is used more than once.`;
    const heading = el.children.length > 0 ? descendants(el).find((d) => /^h[1-6]$/.test(d.tag)) : undefined;
    const name = attr(el, 'aria-label') ?? (uniqueId ? humanize(uniqueId) : heading ? textContent(doc.source, heading).slice(0, 40) : null);
    const base = TAG_LABELS[el.tag] ?? el.tag;
    const label = name && name.toLowerCase() !== base.toLowerCase() ? `${base} · ${name}` : base;
    out.push({
      element: el,
      info: {
        key,
        label,
        tag: el.tag,
        id: uniqueId,
        classes: classList(el),
        depth: Math.max(0, el.depth - bodyDepth - 1),
        startLine: offsetToLine(doc.lineStarts, el.start).line,
        endLine: offsetToLine(doc.lineStarts, Math.max(el.start, el.end - 1)).line,
        ambiguous: reason !== null,
        reason,
      },
    });
  }
  return out;
}

export function listSections(html: string): SectionInfo[] {
  return locateSections(parseHtml(html)).map((s) => s.info);
}

export function findSection(doc: HtmlDocument, key: string): LocatedSection | undefined {
  return locateSections(doc).find((s) => s.info.key === key);
}

/* ---------------------------------------------------------------------- */

interface SheetSource {
  path: string;
  /** Offset of the CSS text inside the file (inline <style> blocks). */
  offset: number;
  css: string;
  inline: boolean;
}

async function stylesheetsFor(reader: TreeReader, htmlPath: string, doc: HtmlDocument): Promise<SheetSource[]> {
  const sheets: SheetSource[] = [];
  for (const el of doc.elements) {
    if (el.tag === 'link' && (attr(el, 'rel') ?? '').toLowerCase().includes('stylesheet')) {
      const href = attr(el, 'href');
      if (!href || isExternalReference(href)) continue;
      const resolved = resolveRelativeReference(htmlPath, href);
      if (!resolved) continue;
      const css = await reader.text(resolved);
      if (css !== null) sheets.push({ path: resolved, offset: 0, css, inline: false });
    } else if (el.tag === 'style') {
      sheets.push({ path: htmlPath, offset: el.openEnd, css: doc.source.slice(el.openEnd, el.closeStart), inline: true });
    }
  }
  return sheets;
}

async function scriptsFor(reader: TreeReader, htmlPath: string, doc: HtmlDocument): Promise<{ path: string; text: string; lineOffset: number }[]> {
  const out: { path: string; text: string; lineOffset: number }[] = [];
  for (const el of doc.elements) {
    if (el.tag !== 'script') continue;
    const src = attr(el, 'src');
    if (src) {
      if (isExternalReference(src)) continue;
      const resolved = resolveRelativeReference(htmlPath, src);
      if (!resolved) continue;
      const text = await reader.text(resolved);
      if (text !== null) out.push({ path: resolved, text, lineOffset: 0 });
    } else {
      const type = (attr(el, 'type') ?? '').toLowerCase();
      if (type && !/javascript|module|ecmascript/.test(type)) continue;
      out.push({ path: htmlPath, text: doc.source.slice(el.openEnd, el.closeStart), lineOffset: offsetToLine(doc.lineStarts, el.openEnd).line - 1 });
    }
  }
  return out;
}

function ruleId(sheet: SheetSource, rule: CssRule): string {
  return `${sheet.path}@${sheet.offset + rule.start}`;
}

interface SectionProfile {
  root: HtmlElement;
  ids: Set<string>;
  classes: Set<string>;
  tags: Set<string>;
  rootIsLandmark: boolean;
}

function profile(root: HtmlElement): SectionProfile {
  const all = [root, ...descendants(root)];
  const ids = new Set<string>();
  const classes = new Set<string>();
  const tags = new Set<string>();
  for (const el of all) {
    const id = attr(el, 'id');
    if (id) ids.add(id);
    for (const c of classList(el)) classes.add(c);
    tags.add(el.tag);
  }
  return { root, ids, classes, tags, rootIsLandmark: LANDMARKS.has(root.tag) };
}

/** Classes and ids used by elements outside a given element (ignoring <head>). */
function usageOutside(doc: HtmlDocument, inside: HtmlElement | null): { ids: Set<string>; classes: Set<string> } {
  const excluded = new Set<HtmlElement>(inside ? [inside, ...descendants(inside)] : []);
  const ids = new Set<string>();
  const classes = new Set<string>();
  for (const el of doc.elements) {
    if (excluded.has(el) || isInside(el, 'head')) continue;
    const id = attr(el, 'id');
    if (id) ids.add(id);
    for (const c of classList(el)) classes.add(c);
  }
  return { ids, classes };
}

function selectorMatchesSection(selector: string, p: SectionProfile): boolean {
  const parts = analyzeSelector(selector);
  const subject = parts.compounds[parts.compounds.length - 1];
  if (!subject) return false;
  const subjectMatches =
    subject.ids.some((id) => p.ids.has(id)) ||
    (subject.classes.length > 0 && subject.classes.every((c) => p.classes.has(c))) ||
    (subject.ids.length === 0 && subject.classes.length === 0 && subject.tag !== null && p.tags.has(subject.tag));
  if (!subjectMatches) return false;
  if (parts.ids.some((id) => p.ids.has(id)) || parts.classes.some((c) => p.classes.has(c))) return true;
  // Anchored only by the landmark's tag (e.g. `footer a`): the tag must lead the selector,
  // otherwise `.testimonial blockquote footer` would wrongly count as this footer.
  if (!p.rootIsLandmark) return false;
  const leading = parts.compounds.findIndex((c) => c.tag === p.root.tag);
  return leading >= 0 && parts.compounds.slice(0, leading).every((c) => c.tag === 'html' || c.tag === 'body');
}

function selectorRefs(selector: string): { ids: string[]; classes: string[] } {
  const parts = analyzeSelector(selector);
  return { ids: parts.ids, classes: parts.classes };
}

function pickTarget(destDoc: HtmlDocument, section: SectionInfo): SectionTarget {
  const destSections = locateSections(destDoc);
  if (section.id && destSections.some((s) => s.info.key === `#${section.id}`)) return { mode: 'replace', key: `#${section.id}` };
  if (LANDMARKS.has(section.tag) && section.tag !== 'section' && section.tag !== 'article') {
    const sameTag = destSections.filter((s) => s.info.tag === section.tag && s.element.depth <= 3);
    if (sameTag.length === 1) return { mode: 'replace', key: sameTag[0]!.info.key };
  }
  return { mode: 'append' };
}

function targetRange(destDoc: HtmlDocument, target: SectionTarget, sectionTag: string): { start: number; end: number; replaced: HtmlElement | null; anchor: HtmlElement | null } {
  if (target.mode === 'replace') {
    const found = findSection(destDoc, target.key);
    if (!found) throw new Error(`The destination no longer has “${target.key}”.`);
    if (found.info.ambiguous) throw new Error(`The destination’s ${found.info.label} has uncertain boundaries.`);
    return { start: found.element.start, end: found.element.end, replaced: found.element, anchor: null };
  }
  if (target.mode === 'insert') {
    const found = findSection(destDoc, target.anchorKey);
    if (!found) throw new Error(`The destination no longer has “${target.anchorKey}”.`);
    const at = target.position === 'before' ? found.element.start : found.element.end;
    return { start: at, end: at, replaced: null, anchor: found.element };
  }
  const body = destDoc.elements.find((e) => e.tag === 'body');
  const main = destDoc.elements.find((e) => e.tag === 'main');
  if ((sectionTag === 'header' || sectionTag === 'nav') && body) return { start: body.openEnd, end: body.openEnd, replaced: null, anchor: null };
  if (sectionTag !== 'footer' && main && main.explicitClose) return { start: main.closeStart, end: main.closeStart, replaced: null, anchor: null };
  if (body && body.explicitClose) {
    // Before trailing scripts at the end of <body>, so the markup stays in reading order.
    const kids = body.children;
    let insertAt = body.closeStart;
    for (let k = kids.length - 1; k >= 0 && kids[k]!.tag === 'script'; k--) insertAt = kids[k]!.start;
    return { start: insertAt, end: insertAt, replaced: null, anchor: null };
  }
  return { start: destDoc.source.length, end: destDoc.source.length, replaced: null, anchor: null };
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const m = /^[ \t]*/.exec(source.slice(lineStart, offset));
  const indent = m ? m[0] : '';
  return source.slice(lineStart, offset).trim() === '' ? indent : '';
}

function reindent(fragment: string, from: string, to: string): string {
  if (from === to) return fragment;
  return fragment
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.startsWith(from) ? to + line.slice(from.length) : line))
    .join('\n');
}

interface CandidateRule {
  candidate: CssRuleCandidate;
  rule: CssRule;
  sheet: SheetSource;
}

interface Analysis {
  info: SectionAnalysis;
  rules: Map<string, CandidateRule>;
  sourceDoc: HtmlDocument;
  destDoc: HtmlDocument;
  element: HtmlElement;
  destSheetPath: string | null;
}

async function analyze(input: {
  source: TreeReader;
  sourcePath: string;
  sectionKey: string;
  dest: TreeReader;
  destPath: string;
  target?: SectionTarget;
}): Promise<Analysis> {
  const sourceHtml = await input.source.text(input.sourcePath);
  const destHtml = await input.dest.text(input.destPath);
  if (sourceHtml === null) throw new Error(`${input.sourcePath} was not found in ${input.source.label}.`);
  if (destHtml === null) throw new Error(`${input.destPath} was not found in ${input.dest.label}.`);
  const sourceDoc = parseHtml(sourceHtml);
  const destDoc = parseHtml(destHtml);
  const located = findSection(sourceDoc, input.sectionKey);
  if (!located) throw new Error(`“${input.sectionKey}” is not a supported section of ${input.sourcePath}.`);
  const section = located.info;
  const p = profile(located.element);
  const warnings: CombineWarning[] = [];

  if (section.ambiguous) {
    warnings.push({ severity: 'blocking', kind: 'ambiguous', message: `${section.reason} Use file or text combining for this part instead.` });
  }

  const target = input.target ?? pickTarget(destDoc, section);
  let replaced: HtmlElement | null = null;
  try {
    replaced = targetRange(destDoc, target, section.tag).replaced;
  } catch (error) {
    warnings.push({ severity: 'blocking', kind: 'ambiguous', message: (error as Error).message });
  }

  /* ---- CSS ---- */
  const sourceSheets = await stylesheetsFor(input.source, input.sourcePath, sourceDoc);
  const destSheets = await stylesheetsFor(input.dest, input.destPath, destDoc);
  const destSheetPath = destSheets.find((s) => !s.inline)?.path ?? null;
  const sourceOutside = usageOutside(sourceDoc, located.element);
  const destOutside = usageOutside(destDoc, replaced);
  const destRuleText = destSheets.map((s) => s.css).join('\n');
  const destParsed = destSheets.map((s) => parseCss(s.css));

  const rules = new Map<string, CandidateRule>();
  for (const sheet of sourceSheets) {
    const parsed = parseCss(sheet.css);
    for (const rule of parsed.rules) {
      if (rule.kind !== 'style') continue;
      const selectors = splitSelectorList(rule.prelude);
      const matching = selectors.filter((s) => selectorMatchesSection(s, p));
      if (matching.length === 0) continue;
      const refs = matching.map(selectorRefs);
      const sharedInSource = refs.some(
        (r) => r.classes.some((c) => sourceOutside.classes.has(c) && !p.root.attrs.some(() => false)) || r.ids.some((id) => sourceOutside.ids.has(id)),
      );
      const partial = matching.length < selectors.length;
      const affectsDest = refs
        .flatMap((r) => [...r.classes.filter((c) => destOutside.classes.has(c)).map((c) => `.${c}`), ...r.ids.filter((id) => destOutside.ids.has(id)).map((id) => `#${id}`)])
        .filter((v, i, a) => a.indexOf(v) === i);
      let warning: string | null = null;
      if (affectsDest.length > 0) warning = `May also restyle ${affectsDest.slice(0, 3).join(', ')} elsewhere in ${input.dest.label}.`;
      else if (partial) warning = `Also styles: ${selectors.filter((s) => !matching.includes(s)).slice(0, 2).join(', ')}.`;
      else if (sharedInSource) warning = `Also styles other parts of ${input.source.label}.`;
      const relation: CssRuleCandidate['relation'] = partial || sharedInSource ? 'shared' : 'specific';
      const candidate: CssRuleCandidate = {
        id: ruleId(sheet, rule),
        path: sheet.path,
        selector: rule.prelude,
        media: rule.media.length ? rule.media.join(' ') : null,
        text: rule.text,
        relation,
        dependencyKind: null,
        warning,
        defaultSelected: affectsDest.length === 0,
      };
      rules.set(candidate.id, { candidate, rule, sheet });
    }
  }

  // Existing destination styles for the replaced element.
  if (replaced) {
    const rp = profile(replaced);
    const overlapping = destParsed
      .flatMap((sheet) => sheet.rules)
      .filter((r) => r.kind === 'style' && splitSelectorList(r.prelude).some((s) => selectorMatchesSection(s, rp)))
      .filter((r) => analyzeSelector(r.prelude).classes.some((c) => p.classes.has(c)) || analyzeSelector(r.prelude).ids.some((id) => p.ids.has(id)));
    if (overlapping.length > 0) {
      const names = [...new Set(overlapping.map((r) => r.prelude.split(',')[0]!.trim()))].slice(0, 3).join(', ');
      warnings.push({
        severity: 'warning',
        kind: 'css-scope',
        message: `${input.dest.label} already styles ${names}. Both sets of rules will apply; the copied rules come later and win where they overlap.`,
      });
    }
  }

  // Dependencies: variables, fonts, keyframes.
  const candidateText = [...rules.values()].map((r) => r.rule.text).join('\n');
  const localVars = new Set([...rules.values()].flatMap((r) => [...declaredVariables(r.rule.body).keys()]));
  const sourceVarDefs = new Map<string, string>();
  for (const sheet of sourceSheets) {
    for (const rule of parseCss(sheet.css).rules) {
      if (rule.kind !== 'style' || !/(^|,)\s*(:root|html|body)\s*($|,)/.test(rule.prelude)) continue;
      for (const [k, v] of declaredVariables(rule.body)) if (!sourceVarDefs.has(k)) sourceVarDefs.set(k, v);
    }
  }
  const destVarDefs = new Map<string, string>();
  for (const sheet of destParsed) {
    for (const rule of sheet.rules) {
      if (rule.kind !== 'style' || !/(^|,)\s*(:root|html|body)\s*($|,)/.test(rule.prelude)) continue;
      for (const [k, v] of declaredVariables(rule.body)) if (!destVarDefs.has(k)) destVarDefs.set(k, v);
    }
  }
  const variables: SectionAnalysis['variables'] = [];
  const pendingVars = usedVariables(candidateText).filter((v) => !localVars.has(v));
  const seenVars = new Set<string>();
  while (pendingVars.length > 0) {
    const name = pendingVars.shift()!;
    if (seenVars.has(name)) continue;
    seenVars.add(name);
    const value = sourceVarDefs.get(name);
    if (value === undefined) continue;
    variables.push({ name, value, destValue: destVarDefs.get(name) ?? null });
    for (const nested of usedVariables(value)) if (!seenVars.has(nested)) pendingVars.push(nested);
  }
  const differing = variables.filter((v) => v.destValue !== v.value);
  if (differing.length > 0) {
    warnings.push({
      severity: 'info',
      kind: 'variables',
      message: `${differing.length} design ${differing.length === 1 ? 'token differs' : 'tokens differ'} (${differing.slice(0, 3).map((v) => v.name).join(', ')}). They can be scoped to this section so it keeps its look.`,
    });
  }

  const familyText = candidateText + '\n' + variables.map((v) => `font-family: ${v.value};`).join('\n');
  const families = new Set(fontFamiliesUsed(familyText));
  const animations = new Set(animationNames(candidateText));
  const destFamilies = new Set(destParsed.flatMap((s) => s.rules.filter((r) => r.kind === 'font-face').map((r) => fontFaceFamily(r.body))).filter(Boolean));
  const destKeyframes = new Set(destParsed.flatMap((s) => s.rules.filter((r) => r.kind === 'keyframes').map((r) => keyframesName(r.prelude))).filter(Boolean));
  for (const sheet of sourceSheets) {
    for (const rule of parseCss(sheet.css).rules) {
      if (rule.kind === 'font-face') {
        const family = fontFaceFamily(rule.body);
        if (!family || !families.has(family)) continue;
        const id = ruleId(sheet, rule);
        rules.set(id, {
          rule,
          sheet,
          candidate: {
            id,
            path: sheet.path,
            selector: `@font-face “${family}”`,
            media: null,
            text: rule.text,
            relation: 'dependency',
            dependencyKind: 'font-face',
            warning: destFamilies.has(family) ? `${input.dest.label} already defines this font.` : null,
            defaultSelected: !destFamilies.has(family),
          },
        });
      } else if (rule.kind === 'keyframes') {
        const name = keyframesName(rule.prelude);
        if (!name || !animations.has(name)) continue;
        const id = ruleId(sheet, rule);
        rules.set(id, {
          rule,
          sheet,
          candidate: {
            id,
            path: sheet.path,
            selector: `@keyframes ${name}`,
            media: null,
            text: rule.text,
            relation: 'dependency',
            dependencyKind: 'keyframes',
            warning: destKeyframes.has(name) ? `${input.dest.label} already has an animation with this name.` : null,
            defaultSelected: !destKeyframes.has(name),
          },
        });
      }
    }
  }

  const globalTags = [...p.tags].filter((t) => ['h1', 'h2', 'h3', 'p', 'a', 'button', 'ul', 'li', 'input'].includes(t));
  if (globalTags.length > 0 && destRuleText.length >= 0) {
    warnings.push({
      severity: 'info',
      kind: 'css-uncertain',
      message: `Base styles for elements like ${globalTags.slice(0, 4).join(', ')} come from each page’s global CSS and aren’t copied, so text may pick up ${input.dest.label}’s base styles.`,
    });
  }

  /* ---- Assets ---- */
  const assetSources = new Map<string, string>();
  for (const el of [located.element, ...descendants(located.element)]) {
    for (const ref of elementReferences(input.sourcePath, el, sourceDoc.source)) {
      if (ref.kind === 'page') continue;
      if (ref.resolved) assetSources.set(ref.resolved, `${input.sourcePath} (section markup)`);
    }
  }
  for (const { rule, sheet } of rules.values()) {
    for (const { url } of cssUrls(rule.text)) {
      if (isExternalReference(url)) continue;
      const resolved = resolveRelativeReference(sheet.path, url);
      if (resolved) assetSources.set(resolved, sheet.path);
    }
  }
  const assets: AssetDependency[] = [...assetSources.entries()].map(([path, from]) => {
    const sourceHash = input.source.hash(path);
    const destHash = input.dest.hash(path);
    let status: AssetDependency['status'];
    if (!sourceHash) status = 'unavailable';
    else if (!destHash) status = 'missing';
    else if (destHash === sourceHash) status = 'present-identical';
    else status = 'differs';
    return { path, referencedFrom: from, status, defaultAction: status === 'missing' ? 'copy' : 'skip' };
  });
  for (const a of assets) {
    if (a.status === 'unavailable') warnings.push({ severity: 'warning', kind: 'missing-asset', path: a.path, message: `${a.path} is referenced but missing in ${input.source.label}.` });
    if (a.status === 'differs') warnings.push({ severity: 'warning', kind: 'asset-differs', path: a.path, message: `${a.path} exists in both with different content. Keeping ${input.dest.label}’s version unless you choose to copy it.` });
  }

  /* ---- IDs and scripts ---- */
  const destIds = destOutside.ids;
  const duplicates = [...p.ids].filter((id) => destIds.has(id));
  if (duplicates.length > 0) {
    warnings.push({
      severity: 'warning',
      kind: 'duplicate-id',
      message: `${duplicates.slice(0, 3).map((d) => `#${d}`).join(', ')} already ${duplicates.length === 1 ? 'exists' : 'exist'} in ${input.dest.label}. Duplicate IDs can break links, labels and scripts.`,
    });
  }

  const scripts: SectionAnalysis['scripts'] = [];
  const sourceScripts = await scriptsFor(input.source, input.sourcePath, sourceDoc);
  const patterns: { re: RegExp; detail: string }[] = [];
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const id of p.ids) {
    patterns.push({ re: new RegExp(`getElementById\\(\\s*["'\`]${esc(id)}["'\`]|["'\`][^"'\`]*#${esc(id)}\\b`), detail: `refers to #${id}` });
  }
  for (const c of p.classes) {
    patterns.push({ re: new RegExp(`getElementsByClassName\\(\\s*["'\`]${esc(c)}["'\`]|["'\`][^"'\`]*\\.${esc(c)}\\b[^"'\`]*["'\`]`), detail: `refers to .${c}` });
  }
  const dataAttrs = new Set(
    [located.element, ...descendants(located.element)].flatMap((el) => el.attrs.filter((a) => a.name.startsWith('data-')).map((a) => a.name)),
  );
  for (const d of dataAttrs) patterns.push({ re: new RegExp(`\\[${esc(d)}|dataset\\.${esc(d.slice(5).replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase()))}`), detail: `uses ${d}` });
  for (const script of sourceScripts) {
    const lines = script.text.split('\n');
    lines.forEach((line, index) => {
      for (const { re, detail } of patterns) {
        if (re.test(line)) {
          scripts.push({ path: script.path, line: index + 1 + script.lineOffset, detail });
          break;
        }
      }
    });
  }
  const inlineHandlers = [located.element, ...descendants(located.element)].some((el) => el.attrs.some((a) => /^on[a-z]+$/.test(a.name)));
  const embeddedScripts = descendants(located.element).some((el) => el.tag === 'script');
  if (scripts.length > 0 || inlineHandlers || embeddedScripts) {
    const files = [...new Set(scripts.map((s) => s.path))];
    const reasons = [
      files.length ? `${files.join(', ')} ${files.length === 1 ? 'refers' : 'refer'} to this section` : null,
      inlineHandlers ? 'it has inline event handlers' : null,
      embeddedScripts ? 'it contains a script element' : null,
    ].filter(Boolean);
    warnings.push({
      severity: 'warning',
      kind: 'javascript',
      message: `This section may rely on JavaScript (${reasons.join('; ')}). Scripts are not copied automatically — take the script file with file combining if needed.`,
    });
  }
  warnings.push({
    severity: 'info',
    kind: 'behaviour',
    message: 'Copying markup and styles does not guarantee identical behaviour. Review the proposed result in the preview before applying.',
  });

  const info: SectionAnalysis = {
    section,
    sourceLabel: input.source.label,
    destinationLabel: input.dest.label,
    sourcePath: input.sourcePath,
    destPath: input.destPath,
    html: sourceDoc.source.slice(located.element.start, located.element.end),
    suggestedTarget: target,
    destinationSections: locateSections(destDoc).map((s) => s.info),
    cssRules: [...rules.values()].map((r) => r.candidate),
    variables,
    assets,
    scripts: scripts.slice(0, 50),
    warnings,
    destCssPath: destSheetPath,
  };
  return { info, rules, sourceDoc, destDoc, element: located.element, destSheetPath };
}

export async function analyzeSection(input: {
  source: TreeReader;
  sourcePath: string;
  sectionKey: string;
  dest: TreeReader;
  destPath: string;
  target?: SectionTarget;
}): Promise<SectionAnalysis> {
  return (await analyze(input)).info;
}

export interface TransplantOutput {
  files: Map<string, string>;
  copyAssets: string[];
  warnings: CombineWarning[];
}

/** Splice a section (and the selected CSS, tokens and assets) into the destination. */
export async function transplantSection(source: TreeReader, dest: TreeReader, step: SectionStep): Promise<TransplantOutput> {
  const result = await analyze({
    source,
    sourcePath: step.sourcePath,
    sectionKey: step.sectionKey,
    dest,
    destPath: step.destPath,
    target: step.target,
  });
  const blocking = result.info.warnings.find((w) => w.severity === 'blocking');
  if (blocking) throw new Error(blocking.message);
  const warnings = result.info.warnings.filter((w) => w.kind !== 'behaviour');
  const files = new Map<string, string>();

  // 1. HTML
  const destSource = result.destDoc.source;
  const range = targetRange(result.destDoc, step.target, result.info.section.tag);
  const sourceIndent = lineIndent(result.sourceDoc.source, result.element.start);
  let fragment = rewriteHtmlFragment(result.info.html, step.sourcePath, step.destPath);
  let html: string;
  if (step.target.mode === 'replace') {
    const destIndent = lineIndent(destSource, range.start);
    fragment = reindent(fragment, sourceIndent, destIndent);
    html = destSource.slice(0, range.start) + fragment + destSource.slice(range.end);
  } else {
    const anchorIndent = range.anchor ? lineIndent(destSource, range.anchor.start) : '  ';
    fragment = reindent(fragment, sourceIndent, anchorIndent);
    const before = destSource.slice(0, range.start);
    const after = destSource.slice(range.end);
    if (step.target.mode === 'insert' && step.target.position === 'before') {
      html = `${before}${fragment}\n${anchorIndent}${after}`;
    } else {
      const needsBreak = !before.endsWith('\n');
      html = `${before}${needsBreak ? '\n' : ''}${anchorIndent}${fragment}\n${after.startsWith('\n') ? after.slice(1) : after}`;
    }
  }

  // 2. CSS
  const selected = step.cssRuleIds.map((id) => result.rules.get(id)).filter((r): r is CandidateRule => Boolean(r));
  const missingRules = step.cssRuleIds.length - selected.length;
  if (missingRules > 0) {
    warnings.push({ severity: 'warning', kind: 'css-uncertain', message: `${missingRules} selected CSS ${missingRules === 1 ? 'rule' : 'rules'} changed since review and ${missingRules === 1 ? 'was' : 'were'} skipped.` });
  }
  let cssPath = step.destCssPath ?? result.destSheetPath;
  if (selected.length > 0 || (step.includeVariables && result.info.variables.length > 0)) {
    if (!cssPath) {
      cssPath = 'combined.css';
      const href = relativeReference(step.destPath, cssPath);
      const headClose = html.search(/<\/head>/i);
      const link = `  <link rel="stylesheet" href="${href}">\n`;
      html = headClose >= 0 ? html.slice(0, headClose) + link + html.slice(headClose) : link + html;
    }
    const existing = files.get(cssPath) ?? (await dest.text(cssPath)) ?? '';
    const rootSelector = result.info.section.id ? `#${result.info.section.id}` : result.info.section.key.includes(':nth(') ? null : result.info.section.tag;
    const blocks: string[] = [];
    blocks.push(`/* ── Combined from ${source.label} · ${result.info.section.label} ── */`);
    if (step.includeVariables && rootSelector) {
      const vars = result.info.variables.filter((v) => v.destValue !== v.value);
      if (vars.length > 0) blocks.push(`${rootSelector} {\n${vars.map((v) => `  ${v.name}: ${v.value};`).join('\n')}\n}`);
    }
    const order = (r: CandidateRule): number => (r.candidate.dependencyKind === 'font-face' ? 0 : r.candidate.dependencyKind === 'keyframes' ? 2 : 1);
    for (const r of [...selected].sort((a, b) => order(a) - order(b))) {
      const text = rewriteCssUrls(r.rule.text, r.sheet.path, cssPath);
      if (r.rule.media.length === 0) blocks.push(text);
      else {
        let wrapped = text.split('\n').map((l) => `  ${l}`).join('\n');
        for (const media of [...r.rule.media].reverse()) wrapped = `${media} {\n${wrapped}\n}`;
        blocks.push(wrapped);
      }
    }
    const separator = existing.length === 0 || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    files.set(cssPath, `${existing}${separator}${blocks.join('\n\n')}\n`);
  }
  files.set(step.destPath, html);

  // 3. Post-checks on the result
  const after = parseHtml(html);
  const counts = new Map<string, number>();
  for (const el of after.elements) {
    const id = attr(el, 'id');
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => `#${id}`);
  if (dupes.length > 0 && !warnings.some((w) => w.kind === 'duplicate-id')) {
    warnings.push({ severity: 'warning', kind: 'duplicate-id', message: `The result has duplicate IDs: ${dupes.slice(0, 4).join(', ')}.` });
  }
  const copyAssets = step.assets.filter((a) => a.action === 'copy').map((a) => a.path);
  for (const a of result.info.assets) {
    if (a.status === 'missing' && !copyAssets.includes(a.path)) {
      warnings.push({ severity: 'warning', kind: 'missing-asset', path: a.path, message: `${a.path} will be missing in the result.` });
    }
  }
  return { files, copyAssets, warnings };
}
