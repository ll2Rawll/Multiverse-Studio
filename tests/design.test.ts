import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { duplicateSection, insertSection, moveSection, outline, removeSection, setAttribute, setText } from '../src/design/markup';
import { readDesignCss, setElementStyles, setThemeTokens, readTheme } from '../src/design/styles';
import { SECTION_LIBRARY } from '../src/design/library';
import { SHARED_LINE_ID } from '../src/shared/types';
import { tempDir } from './helpers';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Studio</title>
  <link rel="stylesheet" href="theme.css">
</head>
<body>
  <header data-mv-section="header"><a href="index.html">Studio</a></header>
  <main>
    <section class="hero" data-mv-section="hero">
      <h1>Hello world</h1>
      <p>Intro <em>text</em> here.</p>
      <a class="btn" href="#contact">Contact</a>
      <img src="images/a.png" alt="A">
    </section>
    <section data-mv-section="text"><h2>About</h2></section>
  </main>
  <footer data-mv-section="footer"><p>© Studio</p></footer>
</body>
</html>
`;

test('outline lists sections and editable elements; framework pages are recognised', () => {
  const o = outline(PAGE);
  assert.equal(o.title, 'Studio');
  assert.deepEqual(o.sections.map((s) => s.label), ['Header', 'Hero', 'Text', 'Footer']);
  const hero = o.sections[1]!;
  assert.deepEqual(hero.children.map((c) => [c.kind, c.editableText]), [['text', true], ['text', false], ['button', true], ['image', false]]);
  const react = outline('<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>');
  assert.equal(react.supported, false);
  assert.match(react.reason!, /Build/);
});

test('text and attribute edits are exact source edits that add a readable id once', () => {
  const o = outline(PAGE);
  const h1 = o.sections[1]!.children[0]!;
  const edited = setText(PAGE, { path: h1.key.slice(2) }, 'Make <better> things & ship');
  assert.match(edited, /<h1 data-mv-id="h1-hello-world">Make &lt;better&gt; things &amp; ship<\/h1>/);
  assert.equal(edited.replace(/ data-mv-id="h1-hello-world"/, '').replace('Make &lt;better&gt; things &amp; ship', 'Hello world'), PAGE, 'nothing else in the file changed');
  const again = setText(edited, { id: 'h1-hello-world' }, 'Second');
  assert.equal((again.match(/data-mv-id=/g) ?? []).length, 1, 'the id is added once');
  const p = o.sections[1]!.children[1]!;
  assert.throws(() => setText(PAGE, { path: p.key.slice(2) }, 'x'), /contains other elements/);
  const linked = setAttribute(PAGE, { path: o.sections[1]!.children[2]!.key.slice(2) }, 'href', 'https://example.com/"x"');
  assert.match(linked, /href="https:\/\/example.com\/&quot;x&quot;"/);
  assert.throws(() => setAttribute(PAGE, { path: '0' }, 'href', 'javascript:alert(1)'), /not allowed/);
  assert.throws(() => setAttribute(PAGE, { path: '0' }, 'onclick', 'x'), /not edited visually/);
});

test('sections can be inserted from the library, moved, duplicated and removed', () => {
  const hero = SECTION_LIBRARY.find((s) => s.kind === 'cta')!;
  const withCta = insertSection(PAGE, hero.html, 1);
  assert.deepEqual(outline(withCta).sections.map((s) => s.label), ['Header', 'Hero', 'Cta', 'Text', 'Footer']);
  const twice = insertSection(withCta, hero.html, 0);
  assert.equal((twice.match(/data-mv-id="cta"/g) ?? []).length, 1, 'inserted sections get fresh ids');
  assert.ok(twice.includes('data-mv-id="cta-2"'));
  const moved = moveSection(withCta, { id: 'cta' }, 2);
  assert.deepEqual(outline(moved).sections.map((s) => s.label), ['Header', 'Hero', 'Text', 'Cta', 'Footer']);
  const back = moveSection(moved, { id: 'cta' }, 0);
  assert.deepEqual(outline(back).sections.map((s) => s.label), ['Header', 'Cta', 'Hero', 'Text', 'Footer']);
  const dup = duplicateSection(withCta, { id: 'cta' });
  assert.equal(outline(dup).sections.filter((s) => s.label === 'Cta').length, 2);
  const removed = removeSection(withCta, { id: 'cta' });
  assert.equal(removed, PAGE, 'removing the inserted section restores the original text exactly');
});

test('per-breakpoint styles round-trip through design.css, including hand edits', () => {
  let css = setElementStyles(null, 'hero-title', 'desktop', { 'font-size': '56px', color: '#222222' });
  css = setElementStyles(css, 'hero-title', 'mobile', { 'font-size': '36px' });
  css = setElementStyles(css, 'hero', 'tablet', { padding: '40px 20px' });
  assert.match(css, /\[data-mv-id="hero-title"\] \{\n  font-size: 56px;\n  color: #222222;\n\}/);
  assert.match(css, /@media \(max-width: 600px\) \{\n  \[data-mv-id="hero-title"\] \{\n    font-size: 36px;/);
  // A hand edit in the same shape, plus an unrelated rule, is understood and kept.
  const hand = css.replace('56px', '60px') + '\n.custom { color: red; }\n';
  const read = readDesignCss(hand);
  assert.equal(read.styles['hero-title']!.desktop!['font-size'], '60px');
  assert.equal(read.styles['hero']!.tablet!.padding, '40px 20px');
  const next = setElementStyles(hand, 'hero-title', 'desktop', { color: null });
  assert.ok(next.includes('.custom { color: red; }'), 'other rules are kept');
  assert.ok(!/color: #222222/.test(next));
  assert.throws(() => setElementStyles(css, 'x', 'desktop', { color: 'red; } body { display:none' }), /not a valid value/);
  assert.throws(() => setElementStyles(css, 'x', 'desktop', { position: 'fixed' }), /not a visually editable/);
  assert.throws(() => setElementStyles(css, 'x', 'desktop', { 'background-image': 'url(javascript:alert(1))' }), /not a valid value/);
});

test('theme tokens are edited in place in :root', () => {
  const theme = '/* brand */\n:root {\n  --mv-color-primary: #3b3bd6;\n  --mv-radius: 10px;\n  --other: 1;\n}\nbody { color: var(--mv-color-text); }\n';
  const next = setThemeTokens(theme, { '--mv-color-primary': '#ff5500', '--mv-font-heading': 'Georgia, serif' });
  assert.ok(next.includes('--mv-color-primary: #ff5500;'));
  assert.ok(next.includes('--mv-font-heading: Georgia, serif;'));
  assert.ok(next.startsWith('/* brand */') && next.endsWith('body { color: var(--mv-color-text); }\n'));
  assert.deepEqual(readTheme(next).map((t) => t.name), ['--mv-color-primary', '--mv-radius', '--mv-font-heading']);
});

test('design commands write real files, refuse stale actions, and undo/redo survive a restart', async () => {
  const { dir, cleanup } = await tempDir('mv-design-');
  try {
    const site = path.join(dir, 'site');
    await fs.mkdir(site);
    await fs.writeFile(path.join(site, 'index.html'), PAGE);
    await fs.writeFile(path.join(site, 'theme.css'), ':root {\n  --mv-color-primary: #3b3bd6;\n}\n');
    const workspace = path.join(dir, 'ws');
    const opts = { workspaceRoot: workspace, sampleRoot: path.resolve(import.meta.dirname, '..', 'sample'), previewUrl: (t: string) => `http://${t}.localhost:1/`, emit: () => {} };
    const service = new StudioService(opts);
    const projectId = (await service.call('projects.import', { folderPath: site }))!.project.id;
    const lineId = SHARED_LINE_ID;
    const view = await service.call('design.describe', { projectId, lineId, page: 'index.html' });
    assert.equal(view.theme.stylesheet, 'theme.css');
    const h1 = view.sections[1]!.children[0]!;

    const r1 = await service.call('commands.run', { projectId, lineId, name: 'design.setText', args: { page: 'index.html', target: { path: h1.key.slice(2) }, text: 'Built with care' }, expected: { 'index.html': view.hashes['index.html']! } });
    assert.equal(r1.undo, 'Edit text');
    // A second action prepared against the old revision is refused and changes nothing.
    await assert.rejects(service.call('commands.run', { projectId, lineId, name: 'design.setText', args: { page: 'index.html', target: { path: h1.key.slice(2) }, text: 'Stale' }, expected: { 'index.html': view.hashes['index.html']! } }), /changed since/);

    await service.call('commands.run', { projectId, lineId, name: 'design.setStyle', args: { page: 'index.html', target: { id: 'h1-hello-world' }, breakpoint: 'mobile', props: { 'font-size': '32px' } } });
    await service.call('commands.run', { projectId, lineId, name: 'design.insertSection', args: { page: 'index.html', kind: 'gallery', index: 2 } });
    await service.call('commands.run', { projectId, lineId, name: 'design.setTheme', args: { stylesheet: 'theme.css', tokens: { '--mv-color-primary': '#0a7d5a' } } });
    const read = (p: string) => service.call('files.read', { projectId, ref: { kind: 'line', lineId }, path: p }).then((f) => f.text);
    const html = (await read('index.html'))!;
    assert.match(html, /Built with care/);
    assert.match(html, /<link rel="stylesheet" href="design.css">/);
    assert.match(html, /<link rel="stylesheet" href="sections.css">/);
    assert.match((await read('design.css'))!, /max-width: 600px[\s\S]*h1-hello-world[\s\S]*32px/);
    assert.ok((await read('images/placeholder.svg'))!.startsWith('<svg'));
    assert.match((await read('theme.css'))!, /#0a7d5a/);

    // Reusable component: save the header, change it on another page, update every instance.
    await service.call('commands.run', { projectId, lineId, name: 'design.createPage', args: { from: 'index.html', page: 'about.html', title: 'About us' } });
    const about = (await read('about.html'))!;
    assert.match(about, /<title>About us<\/title>/);
    assert.match(about, /<header data-mv-section="header">/);
    assert.match(about, /<footer/);
    const v2 = await service.call('design.describe', { projectId, lineId, page: 'index.html' });
    assert.deepEqual(v2.pages, ['index.html', 'about.html']);
    await service.call('commands.run', { projectId, lineId, name: 'design.saveComponent', args: { page: 'index.html', target: { path: v2.sections[0]!.key.slice(2) }, name: 'site-header' } });
    // Put an instance on about.html in place of its old header copy.
    const aboutView = await service.call('design.describe', { projectId, lineId, page: 'about.html' });
    await service.call('commands.run', { projectId, lineId, name: 'design.removeSection', args: { page: 'about.html', target: { path: aboutView.sections[0]!.key.slice(2) } } });
    await service.call('commands.run', { projectId, lineId, name: 'design.insertComponent', args: { page: 'about.html', name: 'site-header', index: 0 } });
    const comp = (await read('components/site-header.html'))!;
    await service.call('files.write', { projectId, lineId, path: 'components/site-header.html', text: comp.replace('>Studio</a>', '>Studio Co</a>') });
    await service.call('commands.run', { projectId, lineId, name: 'design.syncComponent', args: { name: 'site-header', pages: ['index.html', 'about.html'] } });
    assert.match((await read('index.html'))!, /Studio Co<\/a>/);
    assert.match((await read('about.html'))!, /Studio Co<\/a>/);

    // An earlier edit cannot be undone over a later change to the same file…
    await assert.rejects(service.call('commands.step', { projectId, lineId, scope: 'design:index.html', direction: 'undo' }), /can’t be undone here/);
    // …but the later one can; then a restart, then redo.
    const before = await read('index.html');
    const u = await service.call('commands.step', { projectId, lineId, scope: 'design:components', direction: 'undo' });
    assert.equal(u.label, 'Update every “site-header” instance');
    assert.doesNotMatch((await read('index.html'))!, /Studio Co/);
    const restarted = new StudioService(opts);
    const r = await restarted.call('commands.step', { projectId, lineId, scope: 'design:components', direction: 'redo' });
    assert.equal(r.label, 'Update every “site-header” instance');
    assert.equal(await restarted.call('files.read', { projectId, ref: { kind: 'line', lineId }, path: 'index.html' }).then((f) => f.text), before);
  } finally {
    await cleanup();
  }
});
