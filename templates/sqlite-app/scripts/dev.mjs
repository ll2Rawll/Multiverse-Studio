// Starts the API and the Vite dev server together, without a shell.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const children = [
  spawn(process.execPath, ['server/index.js'], { stdio: 'inherit' }),
  spawn(process.execPath, [require.resolve('vite/bin/vite.js'), ...process.argv.slice(2)], { stdio: 'inherit' }),
];
const stop = () => children.forEach((c) => c.exitCode === null && c.kill());
for (const c of children) c.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
