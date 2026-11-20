import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectEngine } from '../src/engine/project';
import { SHARED_LINE_ID } from '../src/shared/types';
import { edit, newProject, readText, tempDir } from './helpers';

const create = (engine: ProjectEngine, name: string, from: { kind: 'line'; lineId: string } = { kind: 'line', lineId: SHARED_LINE_ID }, following = true) =>
  engine.createAlternative({ from, name, color: 'sky', description: '', following });

test('creating alternatives preserves the source contents and records lineage', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'Minimal');
    assert.deepEqual(await engine.effectiveTree(a.id), await engine.effectiveTree(SHARED_LINE_ID));
    assert.equal(a.createdFrom.kind, 'shared');
    assert.equal(a.incorporatedShared, engine.shared.head);
    assert.equal(engine.data.order.length, 1);
  } finally {
    await cleanup();
  }
});

test('forking an alternative copies its effective contents but not a live link', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'Bold');
    await edit(engine, a.id, 'styles.css', 'margin: 0', 'margin: 0; background: black');
    const fork = await create(engine, 'Bold copy', { kind: 'line', lineId: a.id });
    assert.equal(await readText(engine, fork.id, 'styles.css'), await readText(engine, a.id, 'styles.css'));
    assert.equal(fork.createdFrom.kind, 'alternative');
    assert.equal(fork.createdFrom.lineId, a.id);
    // Later edits to the source do not flow into the fork.
    await edit(engine, a.id, 'styles.css', 'background: black', 'background: red');
    assert.match((await readText(engine, fork.id, 'styles.css'))!, /background: black/);
  } finally {
    await cleanup();
  }
});

test('shared changes propagate cleanly and preserve independent edits', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'Layout A');
    const b = await create(engine, 'Background B');
    await edit(engine, a.id, 'index.html', '  <main>', '  <main class="grid">');
    await edit(engine, b.id, 'styles.css', 'body { margin: 0; }', 'body { margin: 0; background: #fee; }');

    await edit(engine, SHARED_LINE_ID, 'index.html', '<footer class="site-footer">© Kiln</footer>', '<footer class="site-footer">© Kiln Studio</footer>');
    // Unsaved shared drafts do not propagate.
    assert.doesNotMatch((await readText(engine, a.id, 'index.html'))!, /Kiln Studio/);

    const report = await engine.saveShared('Rename company', undefined);
    assert.ok(report);
    assert.equal(report.appliedCount, 2);
    assert.equal(report.conflictedCount, 0);

    const aHtml = (await readText(engine, a.id, 'index.html'))!;
    assert.match(aHtml, /© Kiln Studio/);
    assert.match(aHtml, /<main class="grid">/);
    const bHtml = (await readText(engine, b.id, 'index.html'))!;
    assert.match(bHtml, /© Kiln Studio/);
    assert.match((await readText(engine, b.id, 'styles.css'))!, /background: #fee/);
    assert.equal(engine.line(a.id).incorporatedShared, engine.shared.head);
  } finally {
    await cleanup();
  }
});

test('conflicting edits are preserved on both sides and resolved explicitly', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'Editorial');
    await edit(engine, a.id, 'index.html', 'Plan work that ships', 'Built for independent makers');
    await edit(engine, a.id, 'styles.css', 'main { padding: 32px; }', 'main { padding: 64px; }');
    await edit(engine, SHARED_LINE_ID, 'index.html', 'Plan work that ships', 'Built for growing teams');
    await edit(engine, SHARED_LINE_ID, 'app.js', "'hello'", "'hello, teams'");
    const report = await engine.saveShared(undefined, undefined);
    assert.ok(report);
    assert.equal(report.conflictedCount, 1);
    assert.equal(report.totalConflicts, 1);

    const line = engine.line(a.id);
    assert.ok(line.pending);
    assert.deepEqual(Object.keys(line.pending.files), ['index.html']);
    // Compatible changes were applied, the conflicted file kept its coherent last version.
    assert.match((await readText(engine, a.id, 'app.js'))!, /hello, teams/);
    assert.match((await readText(engine, a.id, 'index.html'))!, /independent makers/);
    assert.doesNotMatch((await readText(engine, a.id, 'index.html'))!, /growing teams/);
    // Both sides are stored.
    const chunks = await engine.conflictChunks(line.pending.files['index.html']!);
    const conflict = chunks.find((c) => c.kind === 'conflict');
    assert.ok(conflict && conflict.kind === 'conflict');
    assert.match(conflict.ours.join(''), /independent makers/);
    assert.match(conflict.theirs.join(''), /growing teams/);

    // The conflicted file is locked; other files remain editable.
    await assert.rejects(engine.writeFile(a.id, 'index.html', 'x'), /unresolved conflict/);
    await edit(engine, a.id, 'styles.css', 'padding: 64px', 'padding: 72px');

    await assert.rejects(engine.completeResolution(a.id), /resolve every conflict/i);
    await engine.saveResolution(a.id, { path: 'index.html', type: 'chunks', resolutions: { 0: { choice: 'custom', text: '    <h1 class="hero-title">Built for makers and growing teams</h1>\n' } } });
    await engine.completeResolution(a.id);
    const html = (await readText(engine, a.id, 'index.html'))!;
    assert.match(html, /Built for makers and growing teams/);
    assert.equal(engine.line(a.id).pending, null);
    assert.equal(engine.line(a.id).incorporatedShared, engine.shared.head);
    assert.match((await readText(engine, a.id, 'styles.css'))!, /padding: 72px/);
  } finally {
    await cleanup();
  }
});

test('shared updates queue behind unresolved conflicts and are reconciled afterwards', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    await edit(engine, a.id, 'index.html', 'Plan work that ships', 'Mine');
    await edit(engine, SHARED_LINE_ID, 'index.html', 'Plan work that ships', 'Theirs');
    await engine.saveShared('first', undefined);
    assert.ok(engine.line(a.id).pending);
    await edit(engine, SHARED_LINE_ID, 'styles.css', 'color: gray', 'color: black');
    const second = await engine.saveShared('second', undefined);
    assert.equal(second?.lines[0]?.outcome, 'queued');
    assert.doesNotMatch((await readText(engine, a.id, 'styles.css'))!, /color: black/);
    await engine.saveResolution(a.id, { path: 'index.html', type: 'chunks', resolutions: { 0: { choice: 'ours' } } });
    const followUp = await engine.completeResolution(a.id);
    assert.equal(followUp?.lines[0]?.outcome, 'applied');
    assert.match((await readText(engine, a.id, 'styles.css'))!, /color: black/);
    assert.match((await readText(engine, a.id, 'index.html'))!, /Mine/);
    assert.equal(engine.line(a.id).incorporatedShared, engine.shared.head);
  } finally {
    await cleanup();
  }
});

test('file addition and deletion conflicts are detected', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    // modify/delete: alternative edits app.js, shared deletes it
    await engine.writeFile(a.id, 'app.js', "console.log('changed');\n");
    await engine.deleteFile(SHARED_LINE_ID, 'app.js');
    // add/add: both add about.html with different content
    await engine.writeFile(a.id, 'about.html', '<h1>About A</h1>\n');
    await engine.writeFile(SHARED_LINE_ID, 'about.html', '<h1>About shared</h1>\n');
    // clean add: shared adds a new file
    await engine.writeFile(SHARED_LINE_ID, 'robots.txt', 'User-agent: *\n');
    const report = await engine.saveShared('Restructure', undefined);
    assert.equal(report?.conflictedCount, 1);
    const pending = engine.line(a.id).pending!;
    assert.equal(pending.files['app.js']?.type, 'modify-delete');
    assert.equal(pending.files['app.js']?.deletedBy, 'theirs');
    assert.equal(pending.files['about.html']?.type, 'text');
    assert.equal(await readText(engine, a.id, 'robots.txt'), 'User-agent: *\n');

    await engine.saveResolution(a.id, { path: 'app.js', type: 'choice', choice: 'theirs' });
    await engine.saveResolution(a.id, { path: 'about.html', type: 'manual', text: '<h1>About</h1>\n' });
    await engine.completeResolution(a.id);
    assert.equal(await readText(engine, a.id, 'app.js'), null);
    assert.equal(await readText(engine, a.id, 'about.html'), '<h1>About</h1>\n');
  } finally {
    await cleanup();
  }
});

test('deleting a file on one side merges when the other side left it alone', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    await engine.deleteFile(SHARED_LINE_ID, 'app.js');
    await engine.saveShared(undefined, undefined);
    assert.equal(await readText(engine, a.id, 'app.js'), null);
    await engine.deleteFile(a.id, 'styles.css');
    await edit(engine, SHARED_LINE_ID, 'index.html', '© Kiln', '© Kiln 2026');
    const report = await engine.saveShared(undefined, undefined);
    assert.equal(report?.conflictedCount, 0);
    assert.equal(await readText(engine, a.id, 'styles.css'), null);
  } finally {
    await cleanup();
  }
});

test('pausing keeps content; resuming reconciles every missed change from the right base', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    await edit(engine, a.id, 'styles.css', 'main { padding: 32px; }', 'main { padding: 8px; }');
    const baseBefore = engine.line(a.id).incorporatedShared;
    await engine.setFollowing(a.id, false);

    await edit(engine, SHARED_LINE_ID, 'index.html', '© Kiln', '© Kiln Studio');
    const r1 = await engine.saveShared('one', undefined);
    assert.equal(r1?.lines[0]?.outcome, 'paused');
    await edit(engine, SHARED_LINE_ID, 'app.js', "'hello'", "'hi'");
    await engine.saveShared('two', undefined);
    assert.doesNotMatch((await readText(engine, a.id, 'index.html'))!, /Kiln Studio/);
    assert.equal(engine.line(a.id).incorporatedShared, baseBefore);
    assert.equal(engine.sharedChangesBetween(baseBefore, engine.shared.head), 2);

    const report = await engine.setFollowing(a.id, true);
    assert.equal(report?.lines[0]?.outcome, 'applied');
    assert.match((await readText(engine, a.id, 'index.html'))!, /Kiln Studio/);
    assert.match((await readText(engine, a.id, 'app.js'))!, /'hi'/);
    assert.match((await readText(engine, a.id, 'styles.css'))!, /padding: 8px/);
    assert.equal(engine.line(a.id).following, true);
  } finally {
    await cleanup();
  }
});

test('rapid alternative edits are coalesced into one revision', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    const createRev = engine.line(a.id).head;
    for (let i = 0; i < 5; i++) await engine.writeFile(a.id, 'app.js', `console.log(${i});\n`);
    const head = await engine.revision(engine.line(a.id).head);
    assert.equal(head.kind, 'edit');
    assert.deepEqual(head.parents, [createRev]);
    // Reverting the edits steps back to the creation revision.
    const original = (await engine.readBlob((await engine.treeOfRevision(createRev)).get('app.js')!)).toString('utf8');
    await engine.writeFile(a.id, 'app.js', original);
    assert.equal(engine.line(a.id).head, createRev);
  } finally {
    await cleanup();
  }
});

test('checkpoints restore older content without losing later history', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    await edit(engine, a.id, 'app.js', "'hello'", "'v1'");
    const cp = await engine.createCheckpoint('Version one', '');
    await edit(engine, a.id, 'app.js', "'v1'", "'v2'");
    const headBefore = engine.line(a.id).head;
    const result = await engine.restoreCheckpoint(cp.id, [a.id]);
    assert.match((await readText(engine, a.id, 'app.js'))!, /'v1'/);
    const restored = await engine.revision(engine.line(a.id).head);
    assert.equal(restored.kind, 'restore');
    assert.deepEqual(restored.parents[0], headBefore);
    // The later revision is still reachable from the new head.
    const history = await engine.lineHistory(a.id, 10);
    assert.ok(history.some((r) => r.id === headBefore));
    // A safety checkpoint was created and the restore can be undone.
    assert.ok(engine.data.checkpoints.some((c) => c.id === result.checkpointId));
    const op = engine.data.operations.at(-1)!;
    assert.equal(op.kind, 'restore');
    await engine.undoOperation(op.id);
    assert.match((await readText(engine, a.id, 'app.js'))!, /'v2'/);
    // New edits after restoring keep everything.
    await edit(engine, a.id, 'app.js', "'v2'", "'v3'");
    const all = await engine.lineHistory(a.id, 50);
    assert.ok(all.some((r) => r.id === headBefore));
  } finally {
    await cleanup();
  }
});

test('restoring the shared version is a shared change for following alternatives', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    const cp = await engine.createCheckpoint('Start', '');
    await edit(engine, SHARED_LINE_ID, 'index.html', '© Kiln', '© Kiln Studio');
    await engine.saveShared(undefined, undefined);
    assert.match((await readText(engine, a.id, 'index.html'))!, /Kiln Studio/);
    const { report } = await engine.restoreCheckpoint(cp.id, [SHARED_LINE_ID]);
    assert.equal(report?.appliedCount, 1);
    assert.doesNotMatch((await readText(engine, a.id, 'index.html'))!, /Kiln Studio/);
  } finally {
    await cleanup();
  }
});

test('projects persist and reopen with history intact', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    await edit(engine, a.id, 'app.js', "'hello'", "'persisted'");
    await edit(engine, SHARED_LINE_ID, 'styles.css', 'color: gray', 'color: navy');
    await engine.saveShared('Navy footer', undefined);
    await edit(engine, SHARED_LINE_ID, 'app.js', 'console', 'window.console');
    await engine.createCheckpoint('Saved', 'desc');

    const reopened = await ProjectEngine.open(engine.dir);
    assert.equal(reopened.recovered, false);
    assert.match((await readText(reopened, a.id, 'app.js'))!, /persisted/);
    assert.match((await readText(reopened, a.id, 'styles.css'))!, /navy/);
    // The unsaved shared draft survives a restart.
    assert.match((await readText(reopened, SHARED_LINE_ID, 'app.js'))!, /window.console/);
    assert.equal(reopened.data.checkpoints.at(-1)?.name, 'Saved');
    assert.ok((await reopened.lineHistory(a.id, 20)).length >= 3);
  } finally {
    await cleanup();
  }
});

test('damaged metadata is recovered from the backup; unrecoverable damage is reported', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    await edit(engine, a.id, 'app.js', "'hello'", "'x'");
    await fs.writeFile(path.join(engine.dir, 'project.json'), '{ "format": "multiverse-studio/project", truncated');
    const recovered = await ProjectEngine.open(engine.dir);
    assert.equal(recovered.recovered, true);
    assert.ok(recovered.data.lines[a.id]);

    await fs.writeFile(path.join(engine.dir, 'project.json'), 'garbage');
    await fs.writeFile(path.join(engine.dir, 'project.json.bak'), 'garbage');
    await assert.rejects(ProjectEngine.open(engine.dir), (error: Error & { code?: string; details?: string[] }) => {
      assert.equal(error.code, 'project-damaged');
      assert.ok(error.details && error.details.length >= 2);
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('missing content objects are detected when reopening', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const hash = (await engine.effectiveTree(SHARED_LINE_ID)).get('app.js')!;
    await fs.rm(engine.objects.objectPath(hash));
    await assert.rejects(ProjectEngine.open(engine.dir), /could not be recovered/);
  } finally {
    await cleanup();
  }
});

test('identical content is stored once', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    for (let i = 0; i < 4; i++) await create(engine, `Alt ${i}`);
    const objectsBefore = (await engine.objects.listAll()).length;
    await create(engine, 'One more');
    const objectsAfter = (await engine.objects.listAll()).length;
    assert.equal(objectsAfter, objectsBefore, 'creating an alternative copies no file content');
  } finally {
    await cleanup();
  }
});

test('common ancestor of two alternatives is the latest shared revision both incorporated', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    const b = await create(engine, 'B');
    await edit(engine, SHARED_LINE_ID, 'app.js', "'hello'", "'hi'");
    await engine.saveShared(undefined, undefined);
    await edit(engine, a.id, 'styles.css', 'body { margin: 0; }', 'body { margin: 1px; }');
    await edit(engine, b.id, 'styles.css', 'footer { color: gray; }', 'footer { color: red; }');
    const lca = await engine.commonAncestor(engine.line(a.id).head, engine.line(b.id).head);
    assert.equal(lca, engine.shared.head);
  } finally {
    await cleanup();
  }
});

test('an edit based on an older version is merged, not allowed to overwrite a newer change', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const a = await create(engine, 'A');
    const baseHash = (await engine.effectiveTree(a.id)).get('index.html')!;
    const editorText = (await readText(engine, a.id, 'index.html'))!.replace('<main>', '<main class="mine">');
    // A shared change lands in A while the editor still holds the old text.
    await edit(engine, SHARED_LINE_ID, 'index.html', '© Kiln', '© Kiln Studio');
    await engine.saveShared(undefined, undefined);
    const result = await engine.writeFile(a.id, 'index.html', editorText, { baseHash });
    assert.ok(result.mergedText);
    const html = (await readText(engine, a.id, 'index.html'))!;
    assert.match(html, /© Kiln Studio/);
    assert.match(html, /<main class="mine">/);
    // Overlapping edits are refused rather than silently overwritten.
    const base2 = (await engine.effectiveTree(a.id)).get('index.html')!;
    await edit(engine, a.id, 'index.html', 'Plan work that ships', 'Theirs');
    await assert.rejects(engine.writeFile(a.id, 'index.html', html.replace('Plan work that ships', 'Mine'), { baseHash: base2 }), /changed while you were editing/);
  } finally {
    await cleanup();
  }
});
