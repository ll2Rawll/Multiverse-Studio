import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml } from '../src/adapters/web/html';
import { parseCss, analyzeSelector } from '../src/adapters/web/css';
import { listSections } from '../src/adapters/web/sections';
import { diagnosticsFor } from '../src/adapters/web/diagnostics';
import { rewriteCssUrls, relativeReference } from '../src/adapters/web/refs';

test('the HTML scanner keeps exact offsets and handles raw text, voids and optional ends', () => {
  const src = '<body><header id="top"><img src="a.png"><p>One<p>Two</header><script>if (a < b) { "</div>" }</script><footer>x</footer></body>';
  const doc = parseHtml(src);
  const header = doc.elements.find((e) => e.tag === 'header')!;
  assert.equal(src.slice(header.start, header.end), '<header id="top"><img src="a.png"><p>One<p>Two</header>');
  assert.equal(header.misnested, false);
  const footer = doc.elements.find((e) => e.tag === 'footer')!;
  assert.equal(src.slice(footer.start, footer.end), '<footer>x</footer>');
  assert.equal(doc.problems.filter((p) => p.severity === 'error').length, 0);
});

test('sections: stable ids and unique landmarks are supported; broken nesting is flagged', () => {
  const html = '<body><header>h</header><nav id="menu">n</nav><main><section id="pricing"><h2>Plans</h2></section><section><h2>FAQ</h2></section></main><footer><div>unclosed</footer></body>';
  const sections = listSections(html);
  const keys = sections.map((s) => s.key);
  assert.ok(keys.includes('header'));
  assert.ok(keys.includes('#menu'));
  assert.ok(keys.includes('#pricing'));
  assert.ok(keys.includes('section:nth(2)'));
  const footer = sections.find((s) => s.key === 'footer')!;
  assert.equal(footer.ambiguous, true);
  assert.ok(footer.reason);
  assert.equal(sections.find((s) => s.key === '#pricing')!.label, 'Section · Pricing');
});

test('the CSS parser finds rules inside media queries and reports unbalanced blocks', () => {
  const sheet = parseCss('a{color:red}\n@media (max-width: 600px) {\n  .x, .y > p { margin: 0 }\n}\n@font-face { font-family: "A"; src: url(a.woff) }\n@keyframes spin { to { transform: rotate(1turn) } }');
  const kinds = sheet.rules.map((r) => r.kind);
  assert.deepEqual(kinds, ['style', 'style', 'font-face', 'keyframes']);
  assert.deepEqual(sheet.rules[1]!.media, ['@media (max-width: 600px)']);
  assert.equal(parseCss('a { color: red').problems.length, 1);
  const parts = analyzeSelector('.site-footer .links a:hover');
  assert.deepEqual(parts.classes, ['site-footer', 'links']);
  assert.equal(parts.compounds.at(-1)!.tag, 'a');
});

test('diagnostics separate HTML, CSS and JavaScript parse problems', () => {
  assert.equal(diagnosticsFor('a.js', 'const x = ;')[0]?.source, 'javascript');
  assert.equal(diagnosticsFor('a.js', 'export const x = 1;').length, 0);
  assert.equal(diagnosticsFor('a.css', 'a { color: red')[0]?.source, 'css');
  const html = diagnosticsFor('a.html', '<div><span></div>\n<script>let x = ;</script>');
  assert.ok(html.some((d) => d.source === 'javascript' && d.line === 2));
  assert.equal(diagnosticsFor('a.html', '<!doctype html><p>ok<p>fine').length, 0);
});

test('CSS urls are rewritten when rules move between folders', () => {
  assert.equal(relativeReference('css/site.css', 'fonts/a.woff'), '../fonts/a.woff');
  assert.equal(relativeReference('index.html', 'fonts/a.woff'), 'fonts/a.woff');
  assert.equal(rewriteCssUrls("src: url('../fonts/a.woff')", 'css/a.css', 'styles.css'), "src: url('fonts/a.woff')");
  assert.equal(rewriteCssUrls('background: url(https://x/y.png)', 'css/a.css', 'b.css'), 'background: url(https://x/y.png)');
});
