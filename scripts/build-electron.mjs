// Builds the Electron main process, engine worker and preload as separate CommonJS
// bundles with Vite. They are built separately so the sandboxed preload never shares
// a chunk with Node-only code.
import { build } from 'vite';
import { builtinModules } from 'node:module';
import { rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const external = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const targets = [
  { name: 'main', entry: 'src/main/main.ts' },
  { name: 'engineWorker', entry: 'src/main/engineWorker.ts' },
  { name: 'preload', entry: 'src/preload/preload.ts' },
];

export async function buildElectron({ watch = false, onBuilt } = {}) {
  if (!watch) await rm(new URL('../dist-electron', import.meta.url), { recursive: true, force: true });
  for (const target of targets) {
    await build({
      root,
      configFile: false,
      logLevel: 'warn',
      mode: watch ? 'development' : 'production',
      build: {
        outDir: 'dist-electron',
        emptyOutDir: false,
        target: 'node20',
        sourcemap: true,
        minify: false,
        ssr: target.entry,
        watch: watch ? {} : null,
        rollupOptions: {
          external,
          output: { format: 'cjs', entryFileNames: `${target.name}.cjs`, inlineDynamicImports: true },
        },
      },
      ssr: { noExternal: true, target: 'node' },
      plugins: [{ name: 'notify-built', writeBundle: () => onBuilt?.(target.name) }],
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await buildElectron();
  console.log('Built dist-electron/{main,engineWorker,preload}.cjs');
}
