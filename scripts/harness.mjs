// Browser harness: bundles the UI with esbuild (Monaco and zustand replaced by small
// stand-ins) and starts a Node server that runs the real StudioService.
// Used for automated UI tests in environments without Electron. Not part of the app.
import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, '.harness', 'dist');
const shim = (p) => path.join(root, 'e2e', 'harness', 'client', p);

await mkdir(out, { recursive: true });
await build({
  entryPoints: { app: path.join(root, 'src', 'renderer', 'main.tsx'), bridge: shim('bridge.ts') },
  bundle: true,
  outdir: out,
  format: 'esm',
  target: 'chrome120',
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
  loader: { '.otf': 'file', '.woff': 'file', '.woff2': 'file' },
  alias: { 'monaco-editor': shim('monaco-shim.ts'), zustand: shim('zustand-shim.ts') },
  plugins: [
    {
      name: 'no-monaco-workers',
      setup(b) {
        b.onResolve({ filter: /monacoEnv$/ }, () => ({ path: 'monacoEnv', namespace: 'empty' }));
        b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export {};', loader: 'js' }));
      },
    },
  ],
});
await writeFile(
  path.join(out, 'index.html'),
  `<!doctype html><html lang="en" data-theme="dystopia"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Multiverse Studio</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/bridge.js" type="module"></script><script src="/app.js" type="module"></script></body></html>`,
);
console.log('Harness UI bundled to .harness/dist');

if (!process.argv.includes('--build-only')) {
  const server = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'e2e', 'harness', 'server.ts')], { stdio: 'inherit', cwd: root, env: process.env });
  server.on('exit', (code) => process.exit(code ?? 0));
}
