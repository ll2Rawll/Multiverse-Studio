import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StudioService } from '../src/services/studio';
import { CURRENT_PROJECT_VERSION, migrateManifest, UnsupportedProjectVersionError } from '../src/engine/store/migrations';
import { SHARED_LINE_ID } from '../src/shared/types';
import { tempDir } from './helpers';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'project-v1');
const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');

async function hashDir(dir: string): Promise<string> {
  const h = createHash('sha256');
  const walk = async (d: string): Promise<void> => {
    for (const e of (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else h.update(path.relative(dir, p)).update(await fs.readFile(p));
    }
  };
  await walk(dir);
  return h.digest('hex');
}

test('migrateManifest upgrades v1 step by step and rejects unknown versions', () => {
  const v1 = JSON.parse('{"format":"multiverse-studio/project","version":1,"id":"x","name":"X"}');
  const result = migrateManifest(v1);
  assert.equal(result.fromVersion, 1);
  assert.equal(result.manifest.version, CURRENT_PROJECT_VERSION);
  assert.equal(result.manifest.kind, 'website');
  assert.deepEqual(result.manifest.brand, { colors: [], fonts: [], textStyles: [], logoAssetId: null });
  assert.equal(v1.version, 1, 'input is not mutated');
  assert.throws(() => migrateManifest({ ...v1, version: 99 }), UnsupportedProjectVersionError);
  assert.throws(() => migrateManifest({ ...v1, version: 0 }), UnsupportedProjectVersionError);
  assert.throws(() => migrateManifest(null), UnsupportedProjectVersionError);
});

test('a project saved by v0.1 (format 1) opens, keeps its history and alternatives, and is upgraded once', async () => {
  const { dir, cleanup } = await tempDir('mv-migrate-');
  try {
    const fixtureHash = await hashDir(FIXTURE);
    const workspace = path.join(dir, 'workspace');
    const projectDir = path.join(workspace, 'Projects', 'fixture-src-344bdcd2');
    await fs.mkdir(path.dirname(projectDir), { recursive: true });
    await fs.cp(FIXTURE, projectDir, { recursive: true });
    const original = await fs.readFile(path.join(projectDir, 'project.json'), 'utf8');
    assert.equal(JSON.parse(original).version, 1);

    const service = new StudioService({ workspaceRoot: workspace, sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:1/`, emit: () => {} });
    const recent = await service.call('projects.recent', {});
    assert.equal(recent.length, 1, 'the v1 project is discovered in the workspace');
    const project = await service.call('projects.open', { projectId: recent[0]!.id });

    assert.equal(project.migratedFromVersion, 1);
    assert.equal(project.kind, 'website');
    assert.deepEqual(project.alternatives.map((a) => a.name), ['Warm']);
    const warm = project.alternatives[0]!;
    assert.equal(warm.status, 'up-to-date', 'the shared change applied before migration is still incorporated');

    // Content written in v1 is intact on every line.
    const read = (lineId: string, file: string) => service.call('files.read', { projectId: project.id, ref: { kind: 'line', lineId }, path: file });
    assert.match((await read(warm.id, 'styles.css')).text!, /#b5541c/);
    assert.match((await read(warm.id, 'index.html')).text!, /A version one project/);
    assert.match((await read(SHARED_LINE_ID, 'index.html')).text!, /A version one project/);
    assert.equal((await read(SHARED_LINE_ID, 'dot.png')).text, null, 'binary files stay binary');

    // History survives, including the named checkpoint.
    const history = await service.call('history.list', { projectId: project.id });
    assert.ok(history.some((e) => e.type === 'checkpoint' && e.title === 'Before migration'), JSON.stringify(history.map((e) => e.title)));
    assert.ok(history.some((e) => e.type === 'revision' && /Reword intro/.test(e.title + e.detail)));

    // The upgraded manifest is v2 on disk and the original is preserved byte for byte.
    const upgraded = JSON.parse(await fs.readFile(path.join(projectDir, 'project.json'), 'utf8'));
    assert.equal(upgraded.version, 2);
    assert.equal(await fs.readFile(path.join(projectDir, 'project.v1.json'), 'utf8'), original);

    // New work after the upgrade is saved normally, and reopening does not migrate again.
    await service.call('files.write', { projectId: project.id, lineId: warm.id, path: 'styles.css', text: 'body { margin: 0; }\n.title { color: #8a3a12; }\n' });
    await service.call('projects.close', { projectId: project.id });
    const fresh = new StudioService({ workspaceRoot: workspace, sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:1/`, emit: () => {} });
    const reopened = await fresh.call('projects.open', { projectId: project.id });
    assert.equal(reopened.migratedFromVersion, null);
    assert.match((await fresh.call('files.read', { projectId: project.id, ref: { kind: 'line', lineId: warm.id }, path: 'styles.css' })).text!, /#8a3a12/);

    assert.equal(await hashDir(FIXTURE), fixtureHash, 'the checked-in fixture itself is never modified');
  } finally {
    await cleanup();
  }
});

test('a project from a newer format is refused with a clear message instead of being damaged', async () => {
  const { dir, cleanup } = await tempDir('mv-migrate-new-');
  try {
    const projectDir = path.join(dir, 'workspace', 'Projects', 'future');
    await fs.cp(FIXTURE, projectDir, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(projectDir, 'project.json'), 'utf8'));
    manifest.version = 7;
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify(manifest));
    const before = await fs.readFile(path.join(projectDir, 'project.json'), 'utf8');
    const service = new StudioService({ workspaceRoot: path.join(dir, 'workspace'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => `http://${t}.localhost:1/`, emit: () => {} });
    await assert.rejects(service.call('projects.open', { projectId: manifest.id }), /newer version/);
    assert.equal(await fs.readFile(path.join(projectDir, 'project.json'), 'utf8'), before, 'nothing is rewritten');
  } finally {
    await cleanup();
  }
});
