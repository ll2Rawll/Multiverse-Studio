import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeProjectPath, projectPathFromUrlPath, resolveRelativeReference, isSafeProjectPath } from '../src/shared/paths';
import { PreviewRegistry, handlePreviewRequest, injectBridge, previewCsp } from '../src/preview/server';
import { parseChannelInput } from '../src/shared/ipc';
import { StudioService } from '../src/services/studio';
import { SHARED_LINE_ID } from '../src/shared/types';
import { newProject, tempDir } from './helpers';

test('project paths reject traversal, absolute paths and device names', () => {
  for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'C:\\Windows\\win.ini', 'c:/x', '\\\\server\\share', 'a//b', 'a/./b', 'CON', 'aux.txt', 'nul/x', 'a\u0000b', 'a:b', 'name.', 'name ', '']) {
    assert.equal(isSafeProjectPath(bad), false, bad);
  }
  assert.equal(normalizeProjectPath('css\\site.css'), 'css/site.css');
  assert.equal(normalizeProjectPath('images/photo 1.png'), 'images/photo 1.png');
});

test('preview URLs cannot escape the project, even when encoded', () => {
  for (const bad of ['/../secret', '/%2e%2e/secret', '/css/%2e%2e/%2e%2e/x', '/a%2fb', '/a%5c..%5cb', '/%E0%A4%A']) {
    assert.throws(() => projectPathFromUrlPath(bad), bad);
  }
  assert.equal(projectPathFromUrlPath('/'), 'index.html');
  assert.equal(projectPathFromUrlPath('/docs/'), 'docs/index.html');
  assert.equal(projectPathFromUrlPath('/images/photo%201.png'), 'images/photo 1.png');
});

test('relative references resolve inside the project only', () => {
  assert.equal(resolveRelativeReference('css/site.css', '../img/a.png'), 'img/a.png');
  assert.equal(resolveRelativeReference('index.html', 'img/a.png?v=2#x'), 'img/a.png');
  assert.equal(resolveRelativeReference('index.html', '../../outside.png'), null);
  assert.equal(resolveRelativeReference('a/b.html', '/root.css'), 'root.css');
});

test('the preview server serves only the token’s content with a restrictive policy', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const engine = await newProject(dir);
    const registry = new PreviewRegistry();
    const token = registry.open({ projectId: engine.id, ref: { kind: 'line', lineId: SHARED_LINE_ID } });
    const source = { tree: async () => engine.effectiveTree(SHARED_LINE_ID), blob: async (_p: string, h: string) => engine.readBlob(h) };
    const origin = `mvpreview://${token}`;

    const ok = await handlePreviewRequest(registry, source, token, '/', origin);
    assert.equal(ok.status, 200);
    assert.match(ok.headers['Content-Type']!, /text\/html/);
    const csp = ok.headers['Content-Security-Policy']!;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, new RegExp(`connect-src ${origin.replace(/[/:]/g, '\\$&')}(;|$)`));
    assert.doesNotMatch(csp, /https?:/);
    assert.match(csp, /form-action 'none'/);
    assert.match(ok.body.toString(), /__mvBridge/);

    const css = await handlePreviewRequest(registry, source, token, '/styles.css', origin);
    assert.equal(css.status, 200);
    assert.doesNotMatch(css.body.toString(), /__mvBridge/, 'only HTML gets the bridge script');

    assert.equal((await handlePreviewRequest(registry, source, token, '/%2e%2e/project.json', origin)).status, 403);
    assert.equal((await handlePreviewRequest(registry, source, token, '/project.json', origin)).status, 404);
    assert.equal((await handlePreviewRequest(registry, source, 't00000000000000000000', '/', origin)).status, 404);
    assert.equal((await handlePreviewRequest(registry, source, '../x', '/', origin)).status, 404);
    registry.release(token);
    assert.equal((await handlePreviewRequest(registry, source, token, '/', origin)).status, 404);
  } finally {
    await cleanup();
  }
});

test('the bridge is injected without changing the user’s markup elsewhere', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>';
  const out = injectBridge(html);
  assert.ok(out.startsWith('<!doctype html><html><head><script>'));
  assert.ok(out.endsWith('<title>x</title></head><body>hi</body></html>'));
  assert.match(previewCsp('mvpreview://t1'), /frame-src 'none'/);
});

test('IPC input is validated before it reaches the engine', async () => {
  assert.throws(() => parseChannelInput('files.read', { projectId: '../../x', ref: { kind: 'line', lineId: 'shared' }, path: 'index.html' }));
  assert.throws(() => parseChannelInput('files.read', { projectId: 'p', ref: { kind: 'evil' }, path: 'index.html' }));
  assert.throws(() => parseChannelInput('app.info', { extra: true }));
  const { dir, cleanup } = await tempDir();
  try {
    const service = new StudioService({ workspaceRoot: dir, sampleRoot: path.resolve('sample'), previewUrl: (t) => t, emit: () => undefined });
    const project = await service.call('projects.createSample', {});
    await assert.rejects(service.call('files.write', { projectId: project.id, lineId: SHARED_LINE_ID, path: '../escape.html', text: 'x' }), /Unsafe path|not allowed/);
    await assert.rejects(service.call('files.read', { projectId: project.id, ref: { kind: 'line', lineId: SHARED_LINE_ID }, path: 'C:/Windows/win.ini' }), /not allowed/);
    await assert.rejects(service.call('export.run', { projectId: project.id, ref: { kind: 'line', lineId: SHARED_LINE_ID }, format: 'folder', destination: path.join(dir, 'Projects', 'inside') }), /outside Multiverse Studio/);
  } finally {
    await cleanup();
  }
});

test('polling waits leave no abort listeners behind and stop at once when cancelled', async () => {
  const { abortableSleep } = await import('../src/shared/sleep');
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...a: Parameters<typeof add>) => (added++, add(...a))) as typeof add;
  controller.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (removed++, remove(...a))) as typeof remove;
  for (let i = 0; i < 20; i++) await abortableSleep(0, controller.signal, () => new Error('stopped'));
  assert.equal(added, 20);
  assert.equal(removed, 20, 'each finished wait removes its listener');
  const waiting = abortableSleep(60_000, controller.signal, () => new Error('stopped'));
  controller.abort();
  await assert.rejects(waiting, /stopped/);
  await assert.rejects(abortableSleep(10, controller.signal, () => new Error('already')), /already/);
});
