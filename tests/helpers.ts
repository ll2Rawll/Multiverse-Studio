import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectEngine } from '../src/engine/project';

export async function tempDir(prefix = 'mv-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const SITE: Record<string, string> = {
  'index.html': [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <title>Kiln</title>',
    '  <link rel="stylesheet" href="styles.css">',
    '</head>',
    '<body>',
    '  <header id="top"><span class="brand">Kiln</span></header>',
    '  <main>',
    '    <h1 class="hero-title">Plan work that ships</h1>',
    '    <p>Kiln keeps small studios moving.</p>',
    '  </main>',
    '  <footer class="site-footer">© Kiln</footer>',
    '</body>',
    '</html>',
    '',
  ].join('\n'),
  'styles.css': ['body { margin: 0; }', 'header { padding: 16px; }', 'main { padding: 32px; }', 'footer { color: gray; }', ''].join('\n'),
  'app.js': "console.log('hello');\n",
};

export async function newProject(dir: string, files: Record<string, string> = SITE): Promise<ProjectEngine> {
  return ProjectEngine.create(path.join(dir, 'project'), {
    id: 'test-project',
    name: 'Test',
    files: new Map(Object.entries(files)),
    source: { kind: 'import', originalPath: null },
    adapter: 'web',
  });
}

export async function readText(engine: ProjectEngine, lineId: string, file: string): Promise<string | null> {
  const tree = await engine.effectiveTree(lineId);
  const hash = tree.get(file);
  return hash ? (await engine.readBlob(hash)).toString('utf8') : null;
}

export async function edit(engine: ProjectEngine, lineId: string, file: string, from: string, to: string): Promise<void> {
  const text = await readText(engine, lineId, file);
  if (text === null) throw new Error(`${file} missing`);
  if (!text.includes(from)) throw new Error(`"${from}" not found in ${file}`);
  await engine.writeFile(lineId, file, text.replace(from, to));
}
