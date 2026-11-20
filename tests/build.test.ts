import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioService } from '../src/services/studio';
import { parseCommandLine } from '../src/build/commandLine';
import { ProjectEngine } from '../src/engine/project';
import type { StudioEvent } from '../src/shared/types';
import type { BuildProcessView } from '../src/shared/build';

const ROOT = path.resolve(import.meta.dirname, '..');

test('command lines are split without a shell; shell features are refused', () => {
  assert.deepEqual(parseCommandLine('npm run build'), { program: 'npm', args: ['run', 'build'] });
  assert.deepEqual(parseCommandLine(`node -e "console.log('a b')"`), { program: 'node', args: ['-e', "console.log('a b')"] });
  assert.deepEqual(parseCommandLine("git commit -m 'two words'"), { program: 'git', args: ['commit', '-m', 'two words'] });
  assert.deepEqual(parseCommandLine('npx vite --port 5173'), { program: 'npx', args: ['vite', '--port', '5173'] });
  for (const bad of ['ls | grep x', 'npm test && rm -rf /', 'echo hi > out.txt', 'echo $HOME', 'echo "$(whoami)"', 'echo `id`', 'FOO=1 npm test', 'npm test; ls', 'sudo npm i', '"unclosed', '']) {
    assert.throws(() => parseCommandLine(bad), Error, bad);
  }
});

async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-build-'));
  const events: StudioEvent[] = [];
  const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: path.join(ROOT, 'sample'), previewUrl: (t) => t, emit: (e) => events.push(e), agent: { cacheRoot: path.join(dir, 'cache') } });
  const waitFor = async (pred: (p: BuildProcessView) => boolean, ms = 20000): Promise<BuildProcessView> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = [...events].reverse().find((e): e is Extract<StudioEvent, { type: 'build' }> => e.type === 'build' && pred(e.process));
      if (hit) return hit.process;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out waiting for a build event');
  };
  return { dir, events, service, waitFor, done: async () => (await service.shutdown(), rm(dir, { recursive: true, force: true })) };
}

test('terminal commands stream output, run in the run folder, and bring files back only when asked', async () => {
  const h = await harness();
  try {
    const project = await h.service.createFromTemplate('dashboard');
    const state = await h.service.call('build.state', { projectId: project.id, lineId: 'shared' });
    assert.equal(state.hasPackageJson, true);
    assert.equal(state.devScript, 'dev');
    assert.equal(state.dependenciesInstalled, false);
    assert.ok(state.scripts.test);

    process.env.OPENAI_API_KEY = 'sk-test-must-not-reach-projects';
    const started = await h.service.call('build.run', { projectId: project.id, lineId: 'shared', command: `node -e "require('fs').writeFileSync('generated.txt', 'made by a command'); console.log('cwd', process.cwd()); console.log('key', process.env.OPENAI_API_KEY ?? 'none')"` });
    const finished = await h.waitFor((p) => p.id === started.id && (p.status === 'exited' || p.status === 'failed'));
    assert.equal(finished.exitCode, 0);
    const out = await h.service.call('build.output', { projectId: project.id, processId: started.id });
    assert.match(out.output, new RegExp(`cwd ${state.runFolder.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    delete process.env.OPENAI_API_KEY;
    assert.match(out.output, /key none/, 'app secrets are not passed to project programs');
    const streamed = h.events.filter((e) => e.type === 'build' && e.process.id === started.id && e.chunk).map((e) => (e as { chunk: string }).chunk).join('');
    assert.match(streamed, /cwd /);

    // The version is unchanged until the user brings files in.
    const before = (await h.service.call('files.list', { projectId: project.id, ref: { kind: 'line', lineId: 'shared' } })).map((f) => f.path);
    assert.ok(!before.includes('generated.txt'));
    const collected = await h.service.call('build.collect', { projectId: project.id, lineId: 'shared' });
    assert.deepEqual(collected.added, ['generated.txt']);
    const after = (await h.service.call('files.list', { projectId: project.id, ref: { kind: 'line', lineId: 'shared' } })).map((f) => f.path);
    assert.ok(after.includes('generated.txt'));

    await assert.rejects(h.service.call('build.run', { projectId: project.id, lineId: 'shared', command: 'node -v | cat' }), /Pipes/);
    await assert.rejects(h.service.call('build.devServer', { projectId: project.id, lineId: 'shared' }), /Install dependencies first/);
  } finally {
    await h.done();
  }
});

test('a dev server gets a free port, reports when it is listening, and stops', async () => {
  const h = await harness();
  try {
    // A tiny project whose dev script is a plain Node server (no install needed beyond an empty node_modules).
    const engineDir = path.join(h.dir, 'ws', 'Projects', 'tiny-dev');
    await mkdir(path.dirname(engineDir), { recursive: true });
    const files = new Map<string, string>([
      ['index.html', '<!doctype html><title>x</title>'],
      ['package.json', JSON.stringify({ name: 'tiny', private: true, scripts: { dev: 'node server.js' } })],
      ['server.js', "require('http').createServer((q, s) => s.end('hello from ' + process.env.HOST)).listen(Number(process.env.PORT), process.env.HOST);"],
    ]);
    const engine = await ProjectEngine.create(engineDir, { id: 'tiny-dev', name: 'Tiny', files, source: { kind: 'import', originalPath: null }, adapter: 'web', kind: 'app' });
    await writeFile(path.join(h.dir, 'ws', 'recent.json'), '[]').catch(() => undefined);
    (h.service as unknown as { engines: Map<string, ProjectEngine> }).engines.set('tiny-dev', engine);
    await mkdir(path.join(h.service.build!.runFolder('tiny-dev', 'shared'), 'node_modules'), { recursive: true });

    const started = await h.service.call('build.devServer', { projectId: 'tiny-dev', lineId: 'shared' });
    assert.equal(started.kind, 'dev-server');
    const ready = await h.waitFor((p) => p.id === started.id && p.status === 'ready');
    assert.match(ready.url!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const body = await (await fetch(ready.url!)).text();
    assert.equal(body, 'hello from 127.0.0.1');
    // Asking again returns the same server.
    const again = await h.service.call('build.devServer', { projectId: 'tiny-dev', lineId: 'shared' });
    assert.equal(again.id, started.id);

    assert.equal(await h.service.call('build.stop', { projectId: 'tiny-dev', processId: started.id }), true);
    const stopped = await h.service.call('build.output', { projectId: 'tiny-dev', processId: started.id });
    assert.notEqual(stopped.process.status, 'ready');
    await assert.rejects(fetch(ready.url!));
  } finally {
    await h.done();
  }
});
