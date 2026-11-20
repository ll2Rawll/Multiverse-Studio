/**
 * Electron main process: window, security policy, custom protocols and the typed IPC
 * bridge. Project work happens in the engine worker (see engineHost.ts).
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell, type IpcMainInvokeEvent } from 'electron';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { EngineHost } from './engineHost';
import { createKeyVault } from './keyVault';
import { ElectronBrowserProbe, probeContents } from './browserProbe';
import { SettingsStore } from './settings';
import { IPC_EVENT, IPC_INVOKE, isChannelName, parseChannelInput, type IpcResult } from '../shared/ipc';
import type { ProjectView, StudioEvent } from '../shared/types';

// Tests and portable setups can point the app at a separate data folder.
if (process.env.MULTIVERSE_USER_DATA) app.setPath('userData', process.env.MULTIVERSE_USER_DATA);

const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? null;
const APP_ORIGIN = 'app://bundle';
const PREVIEW_SCHEME = 'mvpreview';
const MEDIA_SCHEME = 'mvmedia';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// A second copy would write to the same workspace; hand focus to the first one instead.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

let mainWindow: BrowserWindow | null = null;
let engine: EngineHost | null = null;
const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
const workspaceRoot = path.join(app.getPath('userData'), 'Workspace');
const distDir = path.join(__dirname, '..', 'dist');
const sampleRoot = app.isPackaged ? path.join(process.resourcesPath, 'sample') : path.join(app.getAppPath(), 'sample');
const templateRoot = app.isPackaged ? path.join(process.resourcesPath, 'templates') : path.join(app.getAppPath(), 'templates');
const resourcesRoot = app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(app.getAppPath(), 'resources');

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${MEDIA_SCHEME}:`,
  `media-src 'self' blob: ${MEDIA_SCHEME}:`,
  `font-src 'self' data: ${MEDIA_SCHEME}:`,
  // Build previews show the project's own dev server, which listens on 127.0.0.1 (ports are checked in hardenSessions).
  `frame-src ${PREVIEW_SCHEME}: http://127.0.0.1:*`,
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

function isAppUrl(url: string): boolean {
  return url.startsWith(`${APP_ORIGIN}/`) || (DEV_URL !== null && url.startsWith(DEV_URL));
}

/** Ports of dev servers that the user started from Build; only these local addresses may load in a frame. */
const devServerPorts = new Set<number>();

function trackDevServer(event: StudioEvent): void {
  if (event.type !== 'build' || event.process.kind !== 'dev-server' || !event.process.port) return;
  if (event.process.status === 'ready') devServerPorts.add(event.process.port);
  else if (event.process.status === 'exited' || event.process.status === 'failed') devServerPorts.delete(event.process.port);
}

function isDevServerUrl(url: string): boolean {
  const m = /^(?:http|ws):\/\/127\.0\.0\.1:(\d+)\//.exec(url);
  return m !== null && devServerPorts.has(Number(m[1]));
}

function send(event: StudioEvent): void {
  trackDevServer(event);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENT, event);
  }
}

function registerProtocols(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'bundle') return new Response('Not found', { status: 404 });
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const file = path.normalize(path.join(distDir, relative === '/' ? 'index.html' : relative));
    if (!file.startsWith(distDir + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.readFile(file);
      return new Response(body, {
        headers: {
          'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
          'Content-Security-Policy': APP_CSP,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // Project media for the Video and Assets workspaces, with byte ranges so <video> can seek.
  // The renderer names an asset; the engine says which file that is, inside the project's media
  // store or cache. No path from the renderer is ever opened.
  protocol.handle(MEDIA_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const url = new URL(request.url);
    const [assetId, variant] = url.pathname.replace(/^\/+/, '').split('/');
    const file = await engine!.mediaFile(url.hostname, assetId ?? '', variant ?? 'play');
    if (!file) return new Response('Not found', { status: 404 });
    const stat = await fs.stat(file.path).catch(() => null);
    if (!stat?.isFile()) return new Response('Not found', { status: 404 });
    const headers: Record<string, string> = { 'Content-Type': file.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else start = Math.max(0, stat.size - Number(range[2]));
      if (start > end || start >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = String(end - start + 1);
    if (request.method === 'HEAD') return new Response(null, { status, headers });
    const stream = Readable.toWeb(createReadStream(file.path, { start, end })) as unknown as ReadableStream;
    return new Response(stream, { status, headers });
  });

  protocol.handle(PREVIEW_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const url = new URL(request.url);
    const token = url.hostname;
    const reply = await engine!.preview(token, url.pathname, `${PREVIEW_SCHEME}://${token}`);
    return new Response(reply.body as unknown as BodyInit, { status: reply.status, headers: reply.headers });
  });
}

function hardenSessions(): void {
  const ses = session.defaultSession;
  // No remote network: previews and the UI only reach app://, mvpreview:// and the dev server.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const allowed = (DEV_URL !== null && (details.url.startsWith(DEV_URL) || details.url.startsWith(DEV_URL.replace(/^http/, 'ws')))) || isDevServerUrl(details.url);
    callback({ cancel: !allowed });
  });
  // Only the app's own UI may write to the clipboard (editor copy); everything else is denied,
  // including every request from project previews.
  const allowed = (permission: string, origin: string): boolean => permission === 'clipboard-sanitized-write' && isAppUrl(`${origin.replace(/\/$/, '')}/`);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => callback(allowed(permission, details?.requestingUrl ? new URL(details.requestingUrl).origin : wc.getURL())));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed(permission, requestingOrigin));
  if (DEV_URL) {
    ses.webRequest.onHeadersReceived({ urls: [`${DEV_URL}*`] }, (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [APP_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'").replace("connect-src 'self'", "connect-src 'self' ws: http://127.0.0.1:*")],
        },
      });
    });
  }
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, url) => {
    // The agent's hidden probe windows may follow links within local dev servers and previews.
    if (probeContents.has(contents.id) && /^(http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/|mvpreview:)/.test(url)) return;
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-frame-navigate', (details) => {
    const url = details.url;
    if (details.isMainFrame) {
      if (!isAppUrl(url)) details.preventDefault();
      return;
    }
    // Preview frames may move between pages of the project (or its running dev server), never to the web or app pages.
    if (!url.startsWith(`${PREVIEW_SCHEME}://`) && url !== 'about:blank' && !isDevServerUrl(url)) {
      details.preventDefault();
      send({ type: 'notice', level: 'info', message: `Blocked a preview from opening ${url.slice(0, 120)}` });
    }
  });
});

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  return isAppUrl(frame.url);
}

async function projectView(projectId: string): Promise<ProjectView> {
  const result = (await engine!.call('projects.view', { projectId })) as IpcResult<ProjectView>;
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
}

const openDialog = (win: BrowserWindow | null, options: Electron.OpenDialogOptions) => (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
const saveDialog = (win: BrowserWindow | null, options: Electron.SaveDialogOptions) => (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options));
const messageBox = (win: BrowserWindow | null, options: Electron.MessageBoxOptions) => (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').slice(0, 120) || 'Export';
}

/** Channels that need the desktop shell (dialogs, OS integration) instead of the engine. */
async function handleShellChannel(channel: string, input: Record<string, unknown>, win: BrowserWindow | null): Promise<IpcResult<unknown> | null> {
  switch (channel) {
    case 'app.info':
      return { ok: true, value: { version: app.getVersion(), platform: process.platform, workspacePath: workspaceRoot, previewBase: `${PREVIEW_SCHEME}://`, host: 'electron' } };
    case 'settings.get':
      return { ok: true, value: await settings.get() };
    case 'settings.set':
      return { ok: true, value: await settings.set(input.patch as never) };
    case 'app.setChrome': {
      if (win && process.platform !== 'darwin') {
        try {
          win.setTitleBarOverlay({ color: String(input.background), symbolColor: String(input.symbols), height: 44 });
        } catch {
          // overlay not available on this platform
        }
      }
      return { ok: true, value: true };
    }
    case 'projects.import': {
      const picked = await openDialog(win, {
        title: 'Open a website folder',
        buttonLabel: 'Open project',
        properties: ['openDirectory'],
        message: 'Choose the folder that contains your site’s index.html. Multiverse Studio works on a copy; your folder is not changed.',
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: true, value: null };
      return engine!.call('projects.import', { folderPath: picked.filePaths[0] });
    }
    case 'media.import': {
      // Files dropped onto the window: confirm in a native dialog the page cannot fake, then import.
      const dropped = Array.isArray(input.paths) ? (input.paths as string[]).filter((p) => typeof p === 'string' && path.isAbsolute(p)) : [];
      if (dropped.length) {
        const names = dropped.slice(0, 8).map((p) => `• ${path.basename(p)}`);
        const answer = await messageBox(win, {
          type: 'question',
          buttons: ['Import', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          message: `Import ${dropped.length} dropped file${dropped.length === 1 ? '' : 's'} into this project?`,
          detail: `${names.join('\n')}${dropped.length > 8 ? `\n…and ${dropped.length - 8} more` : ''}\n\nFiles are copied into the project; the originals are not changed.`,
        });
        if (answer.response !== 0) return { ok: true, value: null };
        return engine!.call('media.import', { projectId: input.projectId, paths: dropped });
      }
      const picked = await openDialog(win, {
        title: 'Import media',
        buttonLabel: 'Import',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Video, audio, images and fonts', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'ttf', 'otf', 'woff', 'woff2'] },
          { name: 'All files', extensions: ['*'] },
        ],
        message: 'Files are copied into the project; the originals are not changed.',
      });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, value: null };
      return engine!.call('media.import', { projectId: input.projectId, paths: picked.filePaths });
    }
    case 'media.relink': {
      const picked = await openDialog(win, { title: 'Find the missing file', buttonLabel: 'Relink', properties: ['openFile'] });
      if (picked.canceled || !picked.filePaths[0]) return { ok: true, value: null };
      return engine!.call('media.relink', { projectId: input.projectId, assetId: input.assetId, path: picked.filePaths[0] });
    }
    case 'video.export.start': {
      const settings = input.settings as { format: 'mp4' | 'webm' };
      const ext = settings.format === 'webm' ? 'webm' : 'mp4';
      const list = (await engine!.call('sequences.list', { projectId: input.projectId, lineId: input.lineId })) as IpcResult<{ id: string; name: string }[]>;
      const name = list.ok ? (list.value.find((s) => s.id === input.sequenceId)?.name ?? 'Export') : 'Export';
      const picked = await saveDialog(win, {
        title: 'Export video',
        defaultPath: path.join(app.getPath('videos'), `${safeName(name)}.${ext}`),
        filters: [{ name: ext === 'mp4' ? 'MP4 video' : 'WebM video', extensions: [ext] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      });
      if (picked.canceled || !picked.filePath) return { ok: true, value: null };
      return engine!.call('video.export.start', { ...input, destination: picked.filePath });
    }
    case 'video.export.reveal': {
      const list = (await engine!.call('video.export.list', { projectId: input.projectId })) as IpcResult<{ id: string; output: string; state: string }[]>;
      const job = list.ok ? list.value.find((j) => j.id === input.jobId) : undefined;
      if (!job || job.state !== 'completed') return { ok: false, error: { code: 'not-found', message: 'That export has no finished file.' } };
      shell.showItemInFolder(job.output);
      return { ok: true, value: true };
    }
    case 'shell.openUrl': {
      // Only web addresses returned by a host (deploy URLs, dashboards) — never file: or custom schemes.
      const url = new URL(String(input.url));
      if (url.protocol !== 'https:') return { ok: false, error: { code: 'invalid-input', message: 'Only https:// addresses can be opened.' } };
      await shell.openExternal(url.toString());
      return { ok: true, value: true };
    }
    case 'projects.reveal': {
      const view = await projectView(String(input.projectId));
      const error = await shell.openPath(view.storagePath);
      return error ? { ok: false, error: { code: 'reveal-failed', message: error } } : { ok: true, value: true };
    }
    case 'connector.extension.save':
      // Always the default place (Downloads); the page never chooses where a file is written.
      return engine!.call('connector.extension.save', {});
    case 'export.run': {
      const suggested = safeName(String(input.suggestedName ?? 'Export'));
      if (input.format === 'zip') {
        const picked = await saveDialog(win, {
          title: 'Export as ZIP',
          defaultPath: path.join(app.getPath('documents'), `${suggested}.zip`),
          filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
          properties: ['showOverwriteConfirmation', 'createDirectory'],
        });
        if (picked.canceled || !picked.filePath) return { ok: true, value: null };
        // The save dialog already asked before replacing an existing file.
        return engine!.call('export.run', { ...input, destination: picked.filePath, overwrite: true });
      }
      const picked = await openDialog(win, {
        title: 'Choose where to export',
        buttonLabel: 'Export here',
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: true, value: null };
      const destination = path.join(picked.filePaths[0], suggested);
      let overwrite = false;
      const exists = await fs.stat(destination).then(() => true, () => false);
      if (exists) {
        const answer = await messageBox(win, {
          type: 'warning',
          buttons: ['Replace', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          message: `“${suggested}” already exists in that folder.`,
          detail: 'Replacing it deletes its current contents and writes the exported project in its place.',
        });
        if (answer.response !== 0) return { ok: true, value: null };
        overwrite = true;
      }
      return engine!.call('export.run', { ...input, destination, overwrite });
    }
    default:
      return null;
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC_INVOKE, async (event, channel: unknown, input: unknown): Promise<IpcResult<unknown>> => {
    if (!isTrustedSender(event)) return { ok: false, error: { code: 'forbidden', message: 'Request refused.' } };
    if (!isChannelName(channel)) return { ok: false, error: { code: 'unknown-channel', message: 'Unknown request.' } };
    let parsed: Record<string, unknown>;
    try {
      parsed = parseChannelInput(channel, input) as Record<string, unknown>;
    } catch (error) {
      const issues = (error as { issues?: { path: (string | number)[]; message: string }[] }).issues ?? [];
      return { ok: false, error: { code: 'invalid-input', message: 'The request was not valid.', details: issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`) } };
    }
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const shellResult = await handleShellChannel(channel, parsed, win);
      if (shellResult) return shellResult;
      if (channel === 'projects.import' || channel === 'export.run' || channel === 'media.import' || channel === 'media.relink' || channel === 'video.export.start') return { ok: true, value: null };
      return await engine!.call(channel, parsed);
    } catch (error) {
      return { ok: false, error: { code: (error as { code?: string }).code ?? 'internal', message: (error as Error).message } };
    }
  });
}

async function createWindow(): Promise<void> {
  const appearance = (await settings.get()).appearance;
  const dystopia = appearance === 'dystopia';
  const dark = dystopia || appearance === 'dark' || (appearance === 'system' && nativeTheme.shouldUseDarkColors);
  const chrome = dystopia ? { bg: '#120c1d', symbols: '#e9ddf3' } : dark ? { bg: '#10131b', symbols: '#c9cee0' } : { bg: '#eceef3', symbols: '#2a2f3d' };
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'Multiverse Studio',
    backgroundColor: chrome.bg,
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { color: chrome.bg, symbolColor: chrome.symbols, height: 44 } }
      : { trafficLightPosition: { x: 18, y: 16 } }),
    icon: path.join(app.getAppPath(), 'resources', 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  await win.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  if (app.isPackaged && process.platform !== 'darwin') Menu.setApplicationMenu(null);
  hardenSessions();
  const workerScript = path.join(__dirname, 'engineWorker.cjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  // safeStorage is only usable after app ready; keys never leave this process except per request.
  const vault = createKeyVault(app.getPath('userData'));
  const probe = new ElectronBrowserProbe((ses) => {
    ses.protocol.handle(PREVIEW_SCHEME, async (request) => {
      const url = new URL(request.url);
      const reply = await engine!.preview(url.hostname, url.pathname, `${PREVIEW_SCHEME}://${url.hostname}`);
      return new Response(reply.body as unknown as BodyInit, { status: reply.status, headers: reply.headers });
    });
  });
  engine = new EngineHost(
    workerScript,
    { workspaceRoot, sampleRoot, templateRoot, resourcesRoot, aiSettingsFile: path.join(app.getPath('userData'), 'ai', 'settings.json'), publishSettingsFile: path.join(app.getPath('userData'), 'publish', 'targets.json'), cacheRoot: path.join(app.getPath('userData'), 'Cache'), connectorRoot: path.join(app.getPath('userData'), 'connector'), launch: { command: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] } },
    send,
    vault,
    probe,
  );
  registerProtocols();
  registerIpc();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let disposed = false;
app.on('before-quit', (event) => {
  // Give the engine a moment to stop AI tasks and their child processes (dev servers, tests).
  if (!disposed && engine) {
    event.preventDefault();
    disposed = true;
    void engine.dispose().finally(() => app.quit());
    return;
  }
});
