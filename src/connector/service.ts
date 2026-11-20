/**
 * Connect AI apps: an MCP server inside Multiverse Studio so ChatGPT or Claude can use the studio
 * with the user's own subscription (no API key here, no screen control).
 *
 * - Local apps (Claude Desktop through the bundled extension, other local MCP clients) talk to
 *   http://127.0.0.1:<port>/mcp with a token from ~/.multiverse-studio/connector.json; each app is
 *   approved here once, by name.
 * - Remote apps (ChatGPT, claude.ai) reach it through a public HTTPS address (a tunnel) and sign
 *   in with OAuth; the person at this computer approves each new app in Multiverse Studio.
 * Off by default. Requests are checked for host and origin (DNS rebinding), tokens are bound to
 * this server's address, risky actions ask here, and every change is undoable and logged.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { StudioService } from '../services/studio';
import { StudioError } from '../engine/errors';
import { writeFileAtomic } from '../engine/store/atomic';
import type { BrowserProbe } from '../agent/browser';
import type { ConnectorApprovalView, ConnectorStateView } from '../shared/connector';
import { handleMcpRequest, type McpServerInfo } from './protocol';
import { CONNECTOR_INSTRUCTIONS, connectorTools, type ConnectorToolContext } from './tools';
import { OAuthError, OAuthServer } from './oauth';
import { QuickTunnel, findCloudflared } from './tunnel';

export const DEFAULT_CONNECTOR_PORT = 47615;
const MAX_BODY = 8 * 1024 * 1024;
const SESSION_GAP_MS = 30 * 60 * 1000;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

interface Settings {
  enabled: boolean;
  /** An HTTPS address the user set up that forwards to the local port. */
  publicUrl: string | null;
  port: number;
  cloudflared: string | null;
}

interface LocalApp {
  name: string;
  approvedAt: string;
  lastUsedAt: string | null;
}

export interface ConnectorOptions {
  /** Where settings, approved apps and OAuth grants are kept. */
  root: string;
  /** Home folder for the discovery file (~/.multiverse-studio/connector.json). */
  home?: string;
  probe: BrowserProbe | null;
  emit(event: { type: 'connector'; state: ConnectorStateView } | { type: 'connector-show'; projectId: string; lineId: string | null; app: string }): void;
  /** How a local bridge can start the desktop app when it is closed. */
  launch?: { command: string; args: string[] } | null;
  version: string;
  /** Port 0 picks a free port (tests). */
  port?: number;
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(res: http.ServerResponse, status: number, title: string, body: string, refresh: string | null = null): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // No scripts at all; the page cannot be framed.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="2;url=${esc(refresh)}">` : ''}<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#1d1d24;background:#f6f6fa}h1{font-size:1.35rem;margin:0 0 .5rem}p{margin:.5rem 0}.muted{color:#55556a;font-size:.92rem}</style></head><body>${body}</body></html>`);
}

export class ConnectorService {
  private server: http.Server | null = null;
  private port = 0;
  private localToken = '';
  private settings: Settings = { enabled: false, publicUrl: null, port: DEFAULT_CONNECTOR_PORT, cloudflared: null };
  private localApps: LocalApp[] = [];
  private approvals = new Map<string, { view: ConnectorApprovalView; resolve(ok: boolean): void; timer: NodeJS.Timeout }>();
  private sessions = new Map<string, number>();
  /** App names whose changes are paused from the activity pill. */
  private readonly held = new Set<string>();
  private pendingLocal = new Map<string, Promise<boolean>>();
  private active = new Map<string, ConnectorStateView['active'][number]>();
  private readonly tools = connectorTools();
  private readonly oauth: OAuthServer;
  private readonly tunnel: QuickTunnel;
  private cloudflaredPath: string | null = null;
  private error: string | null = null;

  constructor(
    private readonly studio: StudioService,
    private readonly options: ConnectorOptions,
  ) {
    this.oauth = new OAuthServer(path.join(options.root, 'oauth.json'), ({ appName, redirectHost, requestId }) =>
      this.ask({ id: requestId, kind: 'connect', appName, redirectHost, title: `${appName} wants to use Multiverse Studio`, detail: `It will be able to read and change your projects on this computer, using the same undoable commands as you. Signs in from ${redirectHost}. Only allow it if you just added Multiverse Studio in that app.` }),
    );
    this.tunnel = new QuickTunnel(() => void this.changed());
  }

  private get discoveryFile(): string {
    return path.join(this.options.home ?? os.homedir(), '.multiverse-studio', 'connector.json');
  }

  private loading: Promise<void> | null = null;
  private starting: Promise<void> | null = null;

  private load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    try {
      const s = JSON.parse(await fs.readFile(path.join(this.options.root, 'settings.json'), 'utf8')) as Partial<Settings> & { localApps?: LocalApp[] };
      this.settings = { ...this.settings, ...s, port: typeof s.port === 'number' ? s.port : DEFAULT_CONNECTOR_PORT };
      this.localApps = Array.isArray(s.localApps) ? s.localApps : [];
    } catch {
      /* defaults: off */
    }
    if (this.options.port !== undefined) this.settings.port = this.options.port;
  }

  private saving: Promise<unknown> = Promise.resolve();
  /** Saves run one at a time (two apps approved together used to collide on the same temporary file). */
  private save(): Promise<void> {
    const run = this.saving.then(async () => {
      await fs.mkdir(this.options.root, { recursive: true });
      await writeFileAtomic(path.join(this.options.root, 'settings.json'), JSON.stringify({ ...this.settings, localApps: this.localApps }, null, 1), { mode: 0o600 });
    });
    this.saving = run.catch(() => undefined);
    return run;
  }

  /** Starts the server if it was left on. */
  async init(): Promise<void> {
    await this.load();
    this.cloudflaredPath = await findCloudflared(this.settings.cloudflared);
    // How the extension's bridge can start this app when it is closed.
    if (this.options.launch) {
      const dir = path.dirname(this.discoveryFile);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
      await fs.writeFile(path.join(dir, 'launch.json'), JSON.stringify(this.options.launch, null, 1), { mode: 0o600 }).catch(() => undefined);
    }
    if (this.settings.enabled) await this.startServer().catch((e) => (this.error = (e as Error).message));
  }

  get publicUrl(): string | null {
    return this.tunnel.url ?? this.settings.publicUrl;
  }

  get localUrl(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/mcp` : null;
  }

  async state(): Promise<ConnectorStateView> {
    await this.load();
    const remote = await this.oauth.connected();
    return {
      enabled: this.settings.enabled,
      localUrl: this.localUrl,
      publicUrl: this.publicUrl ? `${this.publicUrl}/mcp` : null,
      tunnel: {
        state: this.tunnel.state === 'off' && this.settings.publicUrl ? 'on' : this.tunnel.state,
        tool: this.tunnel.state !== 'off' ? 'cloudflared' : this.settings.publicUrl ? 'custom' : null,
        detail: this.tunnel.state !== 'off' ? this.tunnel.detail : this.settings.publicUrl ? 'Using your own address. It must forward to this computer’s port.' : '',
        found: this.cloudflaredPath !== null,
      },
      apps: [
        ...remote.map((r) => ({ id: r.client.id, name: r.client.name, redirectHost: (() => { try { return new URL(r.client.redirectUris[0]!).host; } catch { return null; } })(), kind: 'remote' as const, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt })),
        ...this.localApps.map((a) => ({ id: `local:${a.name}`, name: a.name, redirectHost: null, kind: 'local' as const, createdAt: a.approvedAt, lastUsedAt: a.lastUsedAt })),
      ],
      pending: [...this.approvals.values()].map((a) => a.view),
      active: [...this.active.values()].filter((a) => Date.now() - Date.parse(a.at) < 10 * 60 * 1000),
      held: [...this.held],
      error: this.error,
    };
  }

  private emitting: Promise<void> = Promise.resolve();
  /** State events go out one at a time, each read when it is sent, so a slower read can't overwrite a newer state. */
  private changed(): Promise<void> {
    this.emitting = this.emitting.then(async () => this.options.emit({ type: 'connector', state: await this.state() })).catch(() => undefined);
    return this.emitting;
  }

  async setEnabled(enabled: boolean): Promise<ConnectorStateView> {
    await this.load();
    this.settings.enabled = enabled;
    this.error = null;
    await this.save();
    if (enabled) await this.startServer().catch((e) => (this.error = (e as Error).message));
    else await this.stopServer();
    await this.changed();
    return this.state();
  }

  async setPublicUrl(url: string | null): Promise<ConnectorStateView> {
    await this.load();
    if (url !== null) {
      let u: URL;
      try {
        u = new URL(url.trim());
      } catch {
        throw new Error('Enter a full address, like https://studio.example.com.');
      }
      if (u.protocol !== 'https:') throw new Error('ChatGPT and claude.ai need an HTTPS address.');
      if (u.search || u.hash) throw new Error('Use the address without a query or fragment.');
      url = `${u.origin}${u.pathname.replace(/\/(mcp\/?)?$/, '')}`.replace(/\/+$/, '');
    }
    this.settings.publicUrl = url;
    await this.save();
    await this.changed();
    return this.state();
  }

  async startTunnel(): Promise<ConnectorStateView> {
    await this.load();
    if (!this.server) throw new Error('Turn on “Let AI apps use Multiverse Studio” first.');
    this.cloudflaredPath = await findCloudflared(this.settings.cloudflared);
    if (!this.cloudflaredPath) throw new Error('cloudflared is not installed. Install it from Cloudflare, or enter your own HTTPS address.');
    await this.tunnel.start(this.cloudflaredPath, this.port).catch((e) => (this.error = (e as Error).message));
    return this.state();
  }

  async stopTunnel(): Promise<ConnectorStateView> {
    await this.tunnel.stop();
    return this.state();
  }

  async decide(id: string, allow: boolean): Promise<ConnectorStateView> {
    const a = this.approvals.get(id);
    if (a) {
      clearTimeout(a.timer);
      this.approvals.delete(id);
      a.resolve(allow);
    }
    await this.changed();
    return this.state();
  }

  /** Disconnect an app: remote tokens stop working at once; a local app must be approved again. */
  /** Pause or resume changes from a connected app (Pause and Stop in the activity pill). */
  async hold(appName: string, held: boolean, projectId: string | null): Promise<ConnectorStateView> {
    if (held) this.held.add(appName);
    else this.held.delete(appName);
    if (projectId) void this.studio.live.emit({ kind: held ? 'task.paused' : 'task.resumed', projectId, actor: 'ai-app', via: appName, phase: held ? 'paused' : 'waiting', description: held ? `Changes from ${appName} are paused` : `Waiting for ${appName}`, canPause: true });
    await this.changed();
    return this.state();
  }

  async revoke(appId: string): Promise<ConnectorStateView> {
    await this.load();
    if (appId.startsWith('local:')) {
      this.localApps = this.localApps.filter((a) => `local:${a.name}` !== appId);
      await this.save();
    } else await this.oauth.revokeClient(appId);
    for (const k of [...this.active.keys()]) if (k.startsWith(`${appId}|`) || k === appId) this.active.delete(k);
    await this.changed();
    return this.state();
  }

  private ask(view: Omit<ConnectorApprovalView, 'createdAt'>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(view.id);
        resolve(false);
        void this.changed();
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.approvals.set(view.id, { view: { ...view, createdAt: new Date().toISOString() }, resolve, timer });
      void this.changed();
    });
  }

  private startServer(): Promise<void> {
    // A start in progress has a server but not yet its discovery file: wait for the whole start.
    if (this.starting) return this.starting;
    if (this.server) return Promise.resolve();
    this.starting = this.listen().finally(() => (this.starting = null));
    return this.starting;
  }

  private async listen(): Promise<void> {
    this.localToken = randomBytes(32).toString('base64url');
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) json(res, 500, { error: 'server_error', error_description: (e as Error).message });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only: remote apps arrive through the tunnel, which also connects locally.
      server.listen(this.settings.port, '127.0.0.1', () => resolve());
    }).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EADDRINUSE' || this.settings.port === 0) throw e;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    await this.writeDiscovery();
  }

  private async stopServer(): Promise<void> {
    await this.tunnel.stop();
    this.oauth.cancelPending();
    for (const [id] of this.approvals) await this.decide(id, false);
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
    await fs.rm(this.discoveryFile, { force: true });
  }

  /** Where local bridges find the server: address, token and how to start the app. Readable by this user only. */
  private async writeDiscovery(): Promise<void> {
    const dir = path.dirname(this.discoveryFile);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.discoveryFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ url: this.localUrl, token: this.localToken, pid: process.pid, launch: this.options.launch ?? null }, null, 1), { mode: 0o600 });
    await fs.rename(tmp, this.discoveryFile);
  }

  async shutdown(): Promise<void> {
    await this.stopServer().catch(() => undefined);
  }

  private info(): McpServerInfo {
    return { name: 'multiverse-studio', title: 'Multiverse Studio', version: this.options.version, instructions: CONNECTOR_INSTRUCTIONS };
  }

  private context(app: { id: string; name: string }): ConnectorToolContext {
    return {
      studio: this.studio,
      probe: this.options.probe,
      app,
      approve: (projectId, title, detail) => this.ask({ id: `act_${randomBytes(9).toString('base64url')}`, kind: 'action', appName: app.name, redirectHost: null, title: `${app.name}: ${title}`, detail }),
      assertActive: () => {
        if (this.held.has(app.name)) throw new StudioError('invalid', `The person paused changes from ${app.name} in Multiverse Studio. Nothing was changed. Ask them to resume (in the activity pill) before trying again.`);
      },
      beforeChange: async (projectId) => {
        if (this.held.has(app.name)) throw new StudioError('invalid', `The person paused changes from ${app.name} in Multiverse Studio. Nothing was changed. Ask them to resume (in the activity pill) before trying again.`);
        const key = `${app.id}|${projectId}`;
        const last = this.sessions.get(key) ?? 0;
        if (Date.now() - last > SESSION_GAP_MS) {
          // One checkpoint per working session, so everything the app did can be undone together.
          await this.studio.operations.run(projectId, 'project.createCheckpoint', { name: `Before ${app.name} changes`, description: `Created automatically before ${app.name} changed this project.` }, { actor: 'ai-app', via: app.name });
        }
        this.sessions.set(key, Date.now());
      },
      showProject: (projectId, lineId) => this.options.emit({ type: 'connector-show', projectId, lineId, app: app.name }),
      noteActivity: (projectId, action, read) => {
        this.active.set(`${app.id}|${projectId ?? ''}`, { appId: app.id, appName: app.name, projectId, lastAction: action.slice(0, 160), at: new Date().toISOString() });
        void this.changed();
        if (projectId && read) void this.studio.live.emit({ kind: 'operation.completed', projectId, lineId: read.lineId, actor: 'ai-app', via: app.name, phase: 'reading', description: action.slice(0, 120), resourceId: read.path ?? null, target: null });
      },
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const host = String(req.headers.host ?? '').toLowerCase();
    const pub = this.publicUrl;
    const pubHost = pub ? new URL(pub).host.toLowerCase() : null;
    const local = host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
    const viaPublic = pubHost !== null && (host === pubHost || String(req.headers['x-forwarded-host'] ?? '').toLowerCase() === pubHost);
    // DNS rebinding: only our own host names are served.
    if (!local && !viaPublic) return json(res, 421, { error: 'misdirected_request' });
    const origin = req.headers.origin;
    if (origin && !(pub && origin === new URL(pub).origin)) return json(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } });
    const base = viaPublic ? pub! : `http://${host}`;
    const resourceUrl = `${base}/mcp`;
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (route === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        return void res.end();
      }
      const app = await this.authenticate(req, local, viaPublic, resourceUrl);
      if ('denied' in app) {
        if (app.denied === 401) {
          const challenge = viaPublic ? `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="studio"` : 'Bearer';
          return json(res, 401, { error: 'invalid_token', error_description: app.message }, { 'www-authenticate': challenge });
        }
        return json(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32001, message: app.message } });
      }
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (e) {
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: (e as Error).message === 'too-large' ? 'Request too large' : 'Parse error' } });
      }
      const abort = new AbortController();
      res.on('close', () => !res.writableEnded && abort.abort());
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
      const out = await handleMcpRequest(headers, body, this.tools, this.info(), this.context(app), abort.signal);
      if (out.status === 499 || abort.signal.aborted) return;
      if (out.body === undefined) {
        res.writeHead(out.status);
        return void res.end();
      }
      return json(res, out.status, out.body);
    }

    if (route === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end(`Multiverse Studio connector. Add ${resourceUrl} in your AI app.\n`);
    }

    // OAuth and its metadata exist only on the public HTTPS address.
    if (!viaPublic) return json(res, 404, { error: 'not_found' });
    try {
      if (route === '/.well-known/oauth-protected-resource' || route === '/.well-known/oauth-protected-resource/mcp') {
        return json(res, 200, { resource: resourceUrl, authorization_servers: [base], scopes_supported: ['studio'], bearer_methods_supported: ['header'], resource_name: 'Multiverse Studio' });
      }
      if (route === '/.well-known/oauth-authorization-server') return json(res, 200, this.oauth.metadata(base));
      if (route === '/register' && req.method === 'POST') return json(res, 201, await this.oauth.register(JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>));
      if (route === '/authorize' && req.method === 'GET') {
        try {
          const r = await this.oauth.startAuthorization(url.searchParams, resourceUrl);
          res.writeHead(303, { location: `/authorize/wait?request=${encodeURIComponent(r.requestId)}`, 'cache-control': 'no-store' });
          return void res.end();
        } catch (e) {
          const m = e instanceof OAuthError ? e.message : 'The request could not be read.';
          return page(res, 400, 'Can’t connect', `<h1>Can’t connect to Multiverse Studio</h1><p>${esc(m)}</p>`);
        }
      }
      if (route === '/authorize/wait' && req.method === 'GET') {
        const id = url.searchParams.get('request') ?? '';
        const s = this.oauth.status(id);
        if ((s.state === 'approved' || s.state === 'denied') && s.redirect) {
          res.writeHead(302, { location: s.redirect, 'cache-control': 'no-store' });
          return void res.end();
        }
        if (s.state === 'waiting') return page(res, 200, 'Approve in Multiverse Studio', `<h1>Approve in Multiverse Studio</h1><p>Switch to Multiverse Studio on your computer and choose <strong>Allow</strong>. This page continues by itself.</p><p class="muted">If you did not just add Multiverse Studio to an AI app, choose Deny.</p>`, `/authorize/wait?request=${encodeURIComponent(id)}`);
        return page(res, 410, 'Request expired', '<h1>This request expired</h1><p>Go back to your AI app and connect again.</p>');
      }
      if (route === '/token' && req.method === 'POST') {
        const raw = (await readBody(req)).toString('utf8');
        const params = String(req.headers['content-type'] ?? '').includes('application/json') ? new URLSearchParams(Object.entries(JSON.parse(raw || '{}') as Record<string, string>)) : new URLSearchParams(raw);
        return json(res, 200, await this.oauth.token(params, resourceUrl));
      }
      if (route === '/revoke' && req.method === 'POST') {
        const params = new URLSearchParams((await readBody(req)).toString('utf8'));
        await this.oauth.revokeToken(params.get('token') ?? '');
        void this.changed();
        return json(res, 200, {});
      }
    } catch (e) {
      if (e instanceof OAuthError) return json(res, e.status, { error: e.error, error_description: e.message });
      if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid_request', error_description: 'The body is not valid JSON.' });
      throw e;
    }
    return json(res, 404, { error: 'not_found' });
  }

  private async authenticate(req: http.IncomingMessage, local: boolean, viaPublic: boolean, resourceUrl: string): Promise<{ id: string; name: string } | { denied: 401 | 403; message: string }> {
    const auth = String(req.headers.authorization ?? '');
    const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
    if (!bearer) return { denied: 401, message: 'Sign in required.' };
    if (local && !viaPublic && this.localToken && bearer.length === this.localToken.length && bearer === this.localToken) {
      // A local app (through the extension's bridge), approved once by name.
      const name = String(req.headers['x-mv-client'] ?? 'A local AI app').replace(/[^\w .()-]/g, '').slice(0, 60) || 'A local AI app';
      let app = this.localApps.find((a) => a.name === name);
      if (!app) {
        // One question per app, however many requests arrive while it waits.
        let pending = this.pendingLocal.get(name);
        if (!pending) {
          pending = this.ask({ id: `local_${randomBytes(9).toString('base64url')}`, kind: 'connect', appName: name, redirectHost: null, title: `${name} wants to use Multiverse Studio`, detail: 'An app on this computer (through the Multiverse Studio extension) wants to read and change your projects with the same undoable commands as you.' });
          this.pendingLocal.set(name, pending);
          void pending.finally(() => this.pendingLocal.delete(name));
        }
        if (!(await pending)) return { denied: 403, message: 'Declined in Multiverse Studio.' };
        app = this.localApps.find((a) => a.name === name);
        if (!app) {
          app = { name, approvedAt: new Date().toISOString(), lastUsedAt: null };
          this.localApps.push(app);
        }
      }
      if (!app.lastUsedAt || Date.now() - Date.parse(app.lastUsedAt) > 60_000) {
        app.lastUsedAt = new Date().toISOString();
        await this.save();
      }
      return { id: `local:${name}`, name };
    }
    if (viaPublic) {
      const v = await this.oauth.verify(bearer, resourceUrl);
      if (v) return { id: v.client.id, name: v.client.name };
    }
    return { denied: 401, message: 'The token is not valid for this connector.' };
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too-large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
