import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { StudioService } from '../src/services/studio';
import { DEMO, changeHeading, renameProduct } from '../src/shared/demo';
import { SHARED_LINE_ID, type CombinePlan, type StudioEvent } from '../src/shared/types';
import { tempDir } from './helpers';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');

async function setup() {
  const { dir, cleanup } = await tempDir('mv-service-');
  const events: StudioEvent[] = [];
  const service = new StudioService({
    workspaceRoot: path.join(dir, 'workspace'),
    sampleRoot: SAMPLE_ROOT,
    previewUrl: (token) => `http://${token}.localhost:1/`,
    emit: (e) => events.push(e),
  });
  return { dir, cleanup, service, events };
}

async function text(service: StudioService, projectId: string, lineId: string, file: string): Promise<string> {
  const f = await service.call('files.read', { projectId, ref: { kind: 'line', lineId }, path: file });
  assert.ok(f.text !== null);
  return f.text;
}

test('the full sample demo works end to end through the service', async () => {
  const { dir, cleanup, service, events } = await setup();
  try {
    const project = await service.call('projects.createSample', {});
    const id = project.id;
    assert.deepEqual(project.alternatives.map((a) => a.name), ['Minimal', 'Editorial', 'Bold']);
    const byName = (name: string) => project.alternatives.find((a) => a.name === name)!;
    const minimal = byName('Minimal');
    const editorial = byName('Editorial');
    const bold = byName('Bold');
    for (const alt of project.alternatives) assert.equal(alt.status, 'up-to-date');

    // 1. A shared wording update propagates cleanly.
    const sharedHtml = await text(service, id, SHARED_LINE_ID, 'index.html');
    await service.call('files.write', { projectId: id, lineId: SHARED_LINE_ID, path: 'index.html', text: renameProduct(sharedHtml) });
    const saved = await service.call('shared.save', { projectId: id, message: 'Rename Kiln to Kilnworks' });
    assert.ok(saved.report);
    assert.equal(saved.report.appliedCount, 3, JSON.stringify(saved.report.lines));
    assert.equal(saved.report.conflictedCount, 0);
    assert.ok(events.some((e) => e.type === 'propagation'));

    // 2. Independent layouts remain intact.
    for (const alt of [minimal, editorial, bold]) {
      const html = await text(service, id, alt.id, 'index.html');
      assert.match(html, /<span class="brand-name">Kilnworks<\/span>/);
      assert.match(html, /© 2026 Kilnworks Labs/);
    }
    assert.match(await text(service, id, minimal.id, 'index.html'), /hero-centered/);
    assert.match(await text(service, id, editorial.id, 'index.html'), /class="dateline"/);
    assert.match(await text(service, id, bold.id, 'index.html'), /class="nav-cta"/);
    assert.match(await text(service, id, bold.id, 'css/styles.css'), /--bold-lime/);

    // 3. A genuine conflict.
    const afterRename = await text(service, id, SHARED_LINE_ID, 'index.html');
    await service.call('files.write', { projectId: id, lineId: SHARED_LINE_ID, path: 'index.html', text: changeHeading(afterRename) });
    const second = await service.call('shared.save', { projectId: id });
    assert.equal(second.report?.conflictedCount, 1);
    assert.equal(second.report?.appliedCount, 2);
    const conflicted = second.project.alternatives.find((a) => a.id === editorial.id)!;
    assert.equal(conflicted.status, 'conflicted');
    assert.equal(conflicted.conflictCount, 1);
    assert.match(await text(service, id, minimal.id, 'index.html'), /Built for growing teams/);
    // Editorial keeps its coherent last version while the conflict is open.
    assert.match(await text(service, id, editorial.id, 'index.html'), /Built for independent makers/);

    // 4. Conflict resolution.
    const set = await service.call('conflicts.get', { projectId: id, lineId: editorial.id });
    assert.ok(set);
    const file = set.files[0]!;
    assert.equal(file.type, 'text');
    if (file.type === 'text') {
      const chunk = file.chunks.find((c) => c.kind === 'conflict');
      assert.ok(chunk && chunk.kind === 'conflict');
      assert.match(chunk.ours, /independent makers/);
      assert.match(chunk.theirs, /growing teams/);
      await service.call('conflicts.saveResolution', {
        projectId: id,
        lineId: editorial.id,
        resolution: { path: 'index.html', type: 'chunks', resolutions: { [String(chunk.index)]: { choice: 'custom', text: `          <h1 class="hero-title">${DEMO.heading.combined}</h1>\n` } } },
      });
    }
    const done = await service.call('conflicts.complete', { projectId: id, lineId: editorial.id });
    assert.equal(done.project.alternatives.find((a) => a.id === editorial.id)?.status, 'up-to-date');
    assert.match(await text(service, id, editorial.id, 'index.html'), /independent makers and growing teams/);

    // 5. Combine Bold's footer into a new alternative based on Minimal.
    const sections = await service.call('combine.sections', { projectId: id, ref: { kind: 'line', lineId: bold.id }, path: 'index.html' });
    assert.ok(sections.some((s) => s.key === DEMO.footerKey && !s.ambiguous));
    const analysis = await service.call('combine.analyzeSection', {
      projectId: id,
      source: { kind: 'line', lineId: bold.id },
      sourcePath: 'index.html',
      sectionKey: DEMO.footerKey,
      destination: { kind: 'line', lineId: minimal.id },
      destPath: 'index.html',
    });
    assert.deepEqual(analysis.suggestedTarget, { mode: 'replace', key: DEMO.footerKey });
    assert.ok(analysis.cssRules.some((r) => r.selector.startsWith('.footer-bold') && r.defaultSelected));
    assert.ok(analysis.cssRules.some((r) => r.dependencyKind === 'font-face' && r.selector.includes('poppins')));
    assert.ok(analysis.assets.some((a) => a.path === 'fonts/poppins-bold.woff' && a.status === 'missing'));
    assert.ok(analysis.variables.some((v) => v.name === '--bold-ink'));
    assert.ok(analysis.warnings.some((w) => w.kind === 'javascript'), 'newsletter script dependency is reported');
    assert.ok(analysis.warnings.some((w) => w.kind === 'behaviour'));

    const plan: CombinePlan = {
      destination: { kind: 'new', base: { kind: 'line', lineId: minimal.id }, name: DEMO.combinedName, color: 'teal', description: 'Minimal with Bold’s footer', following: true },
      files: {},
      sections: [
        {
          source: { kind: 'line', lineId: bold.id },
          sourcePath: 'index.html',
          sectionKey: DEMO.footerKey,
          destPath: 'index.html',
          target: analysis.suggestedTarget,
          cssRuleIds: analysis.cssRules.filter((r) => r.defaultSelected).map((r) => r.id),
          includeVariables: true,
          assets: analysis.assets.map((a) => ({ path: a.path, action: a.defaultAction })),
          destCssPath: analysis.destCssPath,
        },
      ],
      edits: {},
      description: '',
    };
    const proposal = await service.call('combine.preview', { projectId: id, plan });
    assert.equal(proposal.ready, true, JSON.stringify(proposal.warnings));
    assert.ok(proposal.files.some((f) => f.path === 'index.html'));
    assert.ok(proposal.files.some((f) => f.path === 'fonts/poppins-bold.woff' && f.status === 'added'));
    // The proposal can be previewed before applying.
    const proposalHtml = await service.call('files.read', { projectId: id, ref: { kind: 'proposal', proposalId: proposal.proposalId }, path: 'index.html' });
    assert.match(proposalHtml.text!, /footer-bold/);

    const applied = await service.call('combine.apply', { projectId: id, plan });
    assert.equal(applied.createdLine, true);
    const combinedHtml = await text(service, id, applied.lineId, 'index.html');
    assert.match(combinedHtml, /class="site-footer footer-bold"/);
    assert.match(combinedHtml, /hero-centered/, 'Minimal layout is kept');
    assert.doesNotMatch(combinedHtml, /footer-mini/);
    const combinedCss = await text(service, id, applied.lineId, 'css/styles.css');
    assert.match(combinedCss, /Combined from Bold/);
    assert.match(combinedCss, /#site-footer \{\n(?: {2}--[\w-]+: [^\n]+\n)*? {2}--bold-ink: #0e0e13;/);
    assert.match(combinedCss, /url\('\.\.\/fonts\/poppins-bold\.woff'\)/);
    // Original revisions are preserved.
    assert.doesNotMatch(await text(service, id, minimal.id, 'index.html'), /footer-bold/);
    assert.ok(applied.project.checkpoints.some((c) => c.id === applied.checkpointId));

    // 6. Export the final result and check it is an ordinary static site.
    const out = path.join(dir, 'export', 'site');
    const report = await service.call('export.run', { projectId: id, ref: { kind: 'line', lineId: applied.lineId }, format: 'folder', destination: out });
    assert.ok(report);
    assert.deepEqual(report.missingReferences, []);
    const exported = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    assert.equal(exported, combinedHtml);
    await fs.access(path.join(out, 'fonts', 'poppins-bold.woff'));
    await assert.rejects(fs.access(path.join(out, 'project.json')));
    await assert.rejects(service.call('export.run', { projectId: id, ref: { kind: 'line', lineId: applied.lineId }, format: 'folder', destination: out }), /already exists/);
    await service.call('export.run', { projectId: id, ref: { kind: 'line', lineId: applied.lineId }, format: 'folder', destination: out, overwrite: true });

    const zipPath = path.join(dir, 'export', 'site.zip');
    await service.call('export.run', { projectId: id, ref: { kind: 'line', lineId: bold.id }, format: 'zip', destination: zipPath });
    const zip = await JSZip.loadAsync(await fs.readFile(zipPath));
    assert.ok(zip.file('index.html'));
    assert.ok(zip.file('fonts/poppins-bold.woff'));
    assert.equal(Object.keys(zip.files).some((n) => n.includes('project.json') || n.startsWith('objects/')), false);

    // Undo the combination removes the created alternative (and keeps a checkpoint).
    const undone = await service.call('operations.undo', { projectId: id, operationId: applied.operationId });
    assert.equal(undone.alternatives.some((a) => a.id === applied.lineId), false);
  } finally {
    await cleanup();
  }
});

test('file-level combining: take, hunks, and three-way merge against the common revision', async () => {
  const { cleanup, service } = await setup();
  try {
    const project = await service.call('projects.createSample', {});
    const id = project.id;
    const [minimal, , bold] = project.alternatives;
    const js = await text(service, id, bold!.id, 'js/main.js');
    // Bold changed js/main.js; Minimal did not. Merge takes Bold's change cleanly.
    const candidates = await service.call('combine.candidates', { projectId: id, source: { kind: 'line', lineId: bold!.id }, destination: { kind: 'line', lineId: minimal!.id } });
    const jsFile = candidates.files.find((f) => f.path === 'js/main.js')!;
    assert.equal(jsFile.sourceChangedSinceCommon, true);
    assert.equal(jsFile.destChangedSinceCommon, false);
    assert.ok(candidates.commonRevision);

    const hunks = await service.call('combine.hunks', { projectId: id, source: { kind: 'line', lineId: bold!.id }, destination: { kind: 'line', lineId: minimal!.id }, path: 'css/styles.css' });
    assert.ok(hunks.length > 1);

    const plan: CombinePlan = {
      destination: { kind: 'existing', lineId: minimal!.id },
      files: {
        'js/main.js': { kind: 'merge', source: { kind: 'line', lineId: bold!.id } },
        'images/shapes.svg': { kind: 'take', source: { kind: 'line', lineId: bold!.id } },
        'css/styles.css': { kind: 'hunks', source: { kind: 'line', lineId: bold!.id }, hunks: [0] },
      },
      sections: [],
      edits: {},
      description: 'Try Bold’s script',
    };
    const proposal = await service.call('combine.preview', { projectId: id, plan });
    assert.equal(proposal.ready, true);
    assert.equal(proposal.changedCount, 3);
    const applied = await service.call('combine.apply', { projectId: id, plan });
    assert.equal(await text(service, id, minimal!.id, 'js/main.js'), js);
    assert.ok((await service.call('files.list', { projectId: id, ref: { kind: 'line', lineId: minimal!.id } })).some((f) => f.path === 'images/shapes.svg'));
    const undone = await service.call('operations.undo', { projectId: id, operationId: applied.operationId });
    assert.ok(undone.alternatives.some((a) => a.id === minimal!.id));
    assert.notEqual(await text(service, id, minimal!.id, 'js/main.js'), js);
  } finally {
    await cleanup();
  }
});

test('importing a folder copies it, leaves the original untouched, and rejects escaping links', async () => {
  const { dir, cleanup, service } = await setup();
  try {
    const site = path.join(dir, 'site');
    await fs.mkdir(path.join(site, 'img'), { recursive: true });
    await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css"><img src="img/a.png"><img src="img/missing.png">');
    await fs.writeFile(path.join(site, 'style.css'), 'body{background:url(img/a.png)}');
    await fs.writeFile(path.join(site, 'img', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    await fs.writeFile(path.join(dir, 'secret.txt'), 'outside');
    await fs.mkdir(path.join(site, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(site, 'node_modules', 'x', 'index.js'), '');
    let linked = true;
    try {
      await fs.symlink(path.join(dir, 'secret.txt'), path.join(site, 'escape.txt'));
      await fs.symlink(path.join(site, 'style.css'), path.join(site, 'inside-link.css'));
    } catch {
      linked = false; // symlinks need extra rights on Windows
    }
    const before = (await fs.readdir(site)).sort();
    const report = await service.call('projects.import', { folderPath: site });
    assert.ok(report);
    assert.equal(report.storagePath.startsWith(path.join(dir, 'workspace')), true);
    assert.deepEqual((await fs.readdir(site)).sort(), before, 'original folder is unchanged');
    const files = await service.call('files.list', { projectId: report.project.id, ref: { kind: 'line', lineId: SHARED_LINE_ID } });
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes('index.html') && paths.includes('img/a.png'));
    assert.ok(!paths.some((p) => p.startsWith('node_modules')));
    if (linked) {
      assert.ok(!paths.includes('escape.txt'));
      assert.ok(report.skipped.some((s) => s.path === 'escape.txt' && /outside/.test(s.reason)));
      assert.ok(paths.includes('inside-link.css'));
    }
    // Export reports the missing local reference.
    const exp = await service.call('export.run', { projectId: report.project.id, ref: { kind: 'line', lineId: SHARED_LINE_ID }, format: 'folder', destination: path.join(dir, 'out') });
    assert.deepEqual(exp?.missingReferences, [{ file: 'index.html', reference: 'img/missing.png' }]);

    await fs.rm(path.join(site, 'index.html'));
    await assert.rejects(service.call('projects.import', { folderPath: site }), /no index\.html/);
  } finally {
    await cleanup();
  }
});

test('reopening after a restart keeps projects, history and recent list', async () => {
  const { dir, cleanup, service } = await setup();
  try {
    const project = await service.call('projects.createSample', {});
    await service.call('history.createCheckpoint', { projectId: project.id, name: 'Before restart', description: '' });
    const fresh = new StudioService({ workspaceRoot: path.join(dir, 'workspace'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => undefined });
    const recent = await fresh.call('projects.recent', {});
    assert.equal(recent[0]?.id, project.id);
    assert.equal(recent[0]?.available, true);
    const reopened = await fresh.call('projects.open', { projectId: project.id });
    assert.equal(reopened.alternatives.length, 3);
    assert.ok(reopened.checkpoints.some((c) => c.name === 'Before restart'));
    const history = await fresh.call('history.list', { projectId: project.id });
    assert.ok(history.some((h) => h.title === 'Alternative created'));

    // A missing working copy is reported gracefully.
    await fs.rm(reopened.storagePath, { recursive: true, force: true });
    const third = new StudioService({ workspaceRoot: path.join(dir, 'workspace'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => undefined });
    const list = await third.call('projects.recent', {});
    assert.equal(list[0]?.available, false);
    assert.match(list[0]?.problem ?? '', /moved or deleted/);
    await assert.rejects(third.call('projects.open', { projectId: project.id }), /moved or deleted/);
  } finally {
    await cleanup();
  }
});
