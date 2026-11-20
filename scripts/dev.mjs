// Development: Vite dev server for the UI, watched builds for main/worker/preload,
// and an Electron process that restarts when the main-side code changes.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { fileURLToPath } from 'node:url';
import { buildElectron } from './build-electron.mjs';

const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)) });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5183/';
console.log(`UI dev server: ${url}`);

let child = null;
let timer = null;
const launch = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (child) {
      child.removeAllListeners('exit');
      child.kill();
    }
    child = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
    child.on('exit', async () => {
      await server.close();
      process.exit(0);
    });
  }, 300);
};

await buildElectron({ watch: true, onBuilt: launch });
