/**
 * Browser harness: runs the real StudioService (the same code the Electron engine
 * worker runs) behind a small HTTP API, serves the bundled UI, and serves previews from
 * per-token origins (http://t<token>.localhost:<port>/) with the same headers and path
 * rules as the desktop app's mvpreview: protocol.
 *
 * Used for automated UI tests where Electron isn't available. Not part of the app.
 */
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { AiService } from '../../src/ai/service';
import { MemoryVault } from '../../src/ai/vault';
import { startMockProvider } from './mockProvider';
import { PlaywrightProbe } from './playwrightProbe';
import { StudioService } from '../../src/services/studio';
import { toIpcError } from '../../src/services/errors';
import { isChannelName, parseChannelInput, type IpcResult } from '../../src/shared/ipc';
import { DEFAULT_SETTINGS, type AppSettings, type StudioEvent } from '../../src/shared/types';

const root = path.resolve(import.meta.dirname, '..', '..');
const port = Number(process.env.HARNESS_PORT ?? 5199);
const previewPort = Number(process.env.HARNESS_PREVIEW_PORT ?? 5200);
const workspaceRoot = process.env.HARNESS_WORKSPACE ?? path.join(root, '.harness', 'workspace');
const staticDir = path.join(root, '.harness', 'dist');

const clients = new Set<http.ServerResponse>();
const emit = (event: StudioEvent): void => {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
};

// The harness has no OS key storage, so keys are session-only here (as the UI explains).
const probe = new PlaywrightProbe();
const mockProvider = await startMockProvider(Number(process.env.HARNESS_MOCK_PROVIDER_PORT ?? 0));
const ai = new AiService(path.join(workspaceRoot, 'ai-settings.json'), new MemoryVault('The browser harness has no OS key storage, so keys are kept for this session only.'));
const service = new StudioService({
  workspaceRoot,
  sampleRoot: path.join(root, 'sample'),
  templateRoot: path.join(root, 'templates'),
  previewUrl: (token) => `http://${token}.localhost:${previewPort}/`,
  emit,
  ai,
  agent: { cacheRoot: path.join(workspaceRoot, '..', 'harness-cache'), probe },
  publish: { vault: ai.vault, settingsFile: path.join(workspaceRoot, 'publish-targets.json'), pollMs: 300 },
  // Media is served by this server at /media/… (the desktop app uses the mvmedia: protocol).
  mediaUrl: (projectId, assetId, variant, version) => `http://127.0.0.1:${port}/media/${projectId}/${assetId}/${variant}?v=${version}`,
  // Connect AI apps, with its discovery file in a harness folder (never the real home folder).
  connector: { root: path.join(workspaceRoot, '..', 'harness-connector'), home: path.join(workspaceRoot, '..', 'harness-home'), port: 0 },
});

// Stop tasks, child processes, the probe browser and the mock provider on exit.
const shutdown = async (): Promise<void> => {
  await Promise.race([Promise.all([service.shutdown(), probe.close(), mockProvider.close()]), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

let settings: AppSettings = { ...DEFAULT_SETTINGS };
let nextImportPath: string | null = process.env.HARNESS_IMPORT_PATH ?? null;
/** Stand-in for the desktop file pickers: the next media import / relink uses these paths. */
let nextMediaPaths: string[] = [];
/** URLs the app asked to open in the system browser (the harness records them instead). */
const openedUrls: string[] = [];

async function invoke(channel: string, input: unknown): Promise<IpcResult<unknown>> {
  if (!isChannelName(channel)) return { ok: false, error: { code: 'unknown-channel', message: 'Unknown request.' } };
  let parsed: Record<string, unknown>;
  try {
    parsed = parseChannelInput(channel, input) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: toIpcError(error) };
  }
  try {
    switch (channel) {
      case 'app.info':
        return { ok: true, value: { version: '0.1.0', platform: process.platform, workspacePath: workspaceRoot, previewBase: `http://*.localhost:${previewPort}/`, host: 'browser-harness' } };
      case 'settings.get':
        return { ok: true, value: settings };
      case 'settings.set':
        settings = { ...settings, ...(parsed.patch as Partial<AppSettings>) };
        return { ok: true, value: settings };
      case 'app.setChrome':
      case 'projects.reveal':
        return { ok: true, value: true };
      case 'projects.import': {
        const folderPath = (parsed.folderPath as string | undefined) ?? nextImportPath;
        nextImportPath = null;
        if (!folderPath) return { ok: true, value: null };
        return { ok: true, value: await service.call('projects.import', { folderPath }) };
      }
      case 'media.import': {
        const paths = (parsed.paths as string[] | undefined) ?? nextMediaPaths;
        nextMediaPaths = [];
        if (!paths.length) return { ok: true, value: null };
        return { ok: true, value: await service.call('media.import', { projectId: parsed.projectId as string, paths }) };
      }
      case 'media.relink': {
        const file = (parsed.path as string | undefined) ?? nextMediaPaths[0];
        nextMediaPaths = [];
        if (!file) return { ok: true, value: null };
        return { ok: true, value: await service.call('media.relink', { projectId: parsed.projectId as string, assetId: parsed.assetId as string, path: file }) };
      }
      case 'video.export.reveal':
        return { ok: true, value: true };
      case 'shell.openUrl':
        openedUrls.push(parsed.url as string);
        return { ok: true, value: true };
      default:
        return { ok: true, value: await service.call(channel, parsed as never) };
    }
  } catch (error) {
    return { ok: false, error: toIpcError(error) };
  }
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (url.pathname === '/api/invoke' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { channel: string; input: unknown };
    const result = await invoke(body.channel, body.input);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/harness/mock-provider' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: mockProvider.url, requests: mockProvider.requests.length, netlifyDeploys: mockProvider.requests.filter((r) => r.endpoint === 'netlify-deploy'), openedUrls }));
    return;
  }
  if (url.pathname === '/api/harness/mock-script' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    mockProvider.script(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.end('ok');
    return;
  }
  if (url.pathname === '/api/harness/next-media' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    nextMediaPaths = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { paths: string[] }).paths;
    res.end('ok');
    return;
  }
  const media = /^\/media\/([A-Za-z0-9._-]+)\/([a-z0-9-]+)\/(original|play|thumb|strip)$/.exec(url.pathname);
  if (media && (req.method === 'GET' || req.method === 'HEAD')) {
    const file = await service.video.mediaFile(media[1]!, media[2]!, media[3] as 'play').catch(() => null);
    const stat = file ? await fs.stat(file.path).catch(() => null) : null;
    if (!file || !stat) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = stat.size - 1;
    const headers: Record<string, string | number> = { 'Content-Type': file.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    let status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else start = Math.max(0, stat.size - Number(range[2]));
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end();
    else createReadStream(file.path, { start, end }).pipe(res);
    return;
  }
  if (url.pathname === '/api/harness/next-import' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    nextImportPath = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { path: string }).path;
    res.end('ok');
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(staticDir, rel));
  if (!file.startsWith(staticDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

const previews = http.createServer(async (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0] ?? '';
  const token = host.split('.')[0] ?? '';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const reply = await service.servePreview(token, url.pathname, `http://${host}:${previewPort}`);
  res.writeHead(reply.status, reply.headers);
  res.end(reply.body);
});

app.listen(port, '127.0.0.1', () => console.log(`harness app http://127.0.0.1:${port} (mock provider ${mockProvider.url})`));
previews.listen(previewPort, '127.0.0.1', () => console.log(`harness previews http://*.localhost:${previewPort}`));
