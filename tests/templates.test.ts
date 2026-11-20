import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { SECTIONS_CSS } from '../src/design/library';

const ROOT = path.resolve(import.meta.dirname, '..');

async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-templates-'));
  const service = new StudioService({ workspaceRoot: dir, sampleRoot: path.join(ROOT, 'sample'), previewUrl: (t) => t, emit: () => undefined });
  return { dir, service, done: () => rm(dir, { recursive: true, force: true }) };
}

test('every listed template has an entry file and a README', async () => {
  const h = await harness();
  try {
    const templates = await h.service.listTemplates();
    assert.deepEqual(templates.map((t) => t.id), ['landing', 'portfolio', 'small-business', 'dashboard', 'sqlite-app', 'orbit', 'launch-video']);
    for (const t of templates) {
      const files = await h.service.readTreeDir(path.join(ROOT, 'templates', t.id));
      assert.ok(files.has('index.html'), `${t.id} has index.html`);
      assert.ok(files.has('README.md'), `${t.id} has README.md`);
      if (t.needsInstall) assert.ok(files.has('package.json'), `${t.id} has package.json`);
      else if (files.has('package.json')) assert.deepEqual(Object.keys(JSON.parse(files.get('package.json')!.toString()).dependencies ?? {}), [], `${t.id} needs no install`);
      for (const p of files.keys()) assert.ok(!/(^|\/)(\.env|node_modules|dist)(\/|$)/.test(p), `${t.id} ships no ${p}`);
    }
  } finally {
    await h.done();
  }
});

test('a website template becomes an editable project with section styles', async () => {
  const h = await harness();
  try {
    const project = await h.service.createFromTemplate('landing', 'Launch page');
    assert.equal(project.name, 'Launch page');
    assert.equal(project.sourceKind, 'template');
    assert.equal(project.templateId, 'landing');
    assert.equal(project.kind, 'website');
    const view = await h.service.call('design.describe', { projectId: project.id, lineId: 'shared', page: 'index.html' });
    assert.equal(view.supported, true);
    assert.ok(view.sections.length >= 4, 'the landing page has editable sections');
    const files = await h.service.call('files.list', { projectId: project.id, ref: { kind: 'line', lineId: 'shared' } });
    const paths = files.map((f) => f.path);
    for (const p of ['sections.css', 'images/placeholder.svg', 'theme.css', 'design.css']) assert.ok(paths.includes(p), `has ${p}`);
    const css = await h.service.call('files.read', { projectId: project.id, ref: { kind: 'line', lineId: 'shared' }, path: 'sections.css' });
    assert.equal(css.text, SECTIONS_CSS);
    // Reopening from disk keeps the template origin.
    const reopened = new StudioService({ workspaceRoot: h.dir, sampleRoot: path.join(ROOT, 'sample'), previewUrl: (t) => t, emit: () => undefined });
    const again = await reopened.call('projects.open', { projectId: project.id });
    assert.equal(again.templateId, 'landing');
  } finally {
    await h.done();
  }
});

test('app templates keep their own files and are marked as apps', async () => {
  const h = await harness();
  try {
    const project = await h.service.createFromTemplate('sqlite-app');
    assert.equal(project.kind, 'app');
    assert.equal(project.name, 'Database app');
    const paths = (await h.service.call('files.list', { projectId: project.id, ref: { kind: 'line', lineId: 'shared' } })).map((f) => f.path);
    for (const p of ['.env.example', 'migrations/001_init.sql', 'server/app.js', 'tests/api.test.js', 'package.json']) assert.ok(paths.includes(p), `has ${p}`);
    assert.ok(!paths.includes('sections.css'), 'apps do not get website section styles');
    await assert.rejects(h.service.createFromTemplate('nope'), /not available/);
  } finally {
    await h.done();
  }
});

test('the launch-video template opens in Video with a valid sequence of editable titles', async () => {
  const h = await harness();
  try {
    const project = await h.service.createFromTemplate('launch-video');
    assert.equal(project.kind, 'video');
    const seqs = await h.service.call('sequences.list', { projectId: project.id, lineId: project.alternatives[0]?.id ?? 'shared' });
    assert.equal(seqs.length, 1);
    const { sequence } = await h.service.call('sequences.get', { projectId: project.id, lineId: project.alternatives[0]?.id ?? 'shared', sequenceId: seqs[0]!.id });
    assert.deepEqual(sequence.tracks.find((t) => t.kind === 'text')!.clips.map((c) => (c.type === 'text' ? c.template : null)), ['title-card', 'lower-third', 'end-card']);
  } finally {
    await h.done();
  }
});
