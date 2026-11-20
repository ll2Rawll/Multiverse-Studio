import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Renderer (React UI). Electron main/preload/worker are built by scripts/build-electron.mjs.
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
  worker: { format: 'es' },
  server: { port: 5183, strictPort: true, host: '127.0.0.1' },
  optimizeDeps: { include: ['monaco-editor'] },
});
