/**
 * A small OAuth 2.1 authorization server for remote AI apps (ChatGPT, claude.ai):
 * dynamic client registration (RFC 7591), authorization code with PKCE S256 only, resource
 * indicators (RFC 8707) binding every token to this server's MCP URL, short-lived access tokens
 * and rotating refresh tokens. Nobody signs in with a password: the person at this computer
 * approves each new app in Multiverse Studio itself. Tokens are stored only as SHA-256 hashes.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 60 * 24 * 3600 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 50;

const token = (): string => randomBytes(32).toString('base64url');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

export interface OAuthGrant {
  id: string;
  clientId: string;
  resource: string;
  createdAt: string;
  lastUsedAt: string | null;
  accessHash: string | null;
  accessExpires: number;
  refreshHash: string;
  refreshExpires: number;
}

interface Stored {
  clients: OAuthClient[];
  grants: OAuthGrant[];
}

interface PendingAuth {
  id: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  challenge: string;
  resource: string;
  status: 'waiting' | 'approved' | 'denied' | 'expired';
  redirect: string | null;
  createdAt: number;
}

interface Code {
  hash: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  expires: number;
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Redirect URIs must be HTTPS, or loopback HTTP for apps on this computer. */
export function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export class OAuthServer {
  private data: Stored = { clients: [], grants: [] };
  private loaded = false;
  private pending = new Map<string, PendingAuth>();
  private codes = new Map<string, Code>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    /** Ask the person at this computer; resolves true when they allow it. */
    private readonly approve: (request: { appName: string; redirectHost: string; requestId: string }) => Promise<boolean>,
  ) {}

  private async load(): Promise<Stored> {
    if (!this.loaded) {
      try {
        const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Stored;
        this.data = { clients: Array.isArray(raw.clients) ? raw.clients : [], grants: Array.isArray(raw.grants) ? raw.grants : [] };
      } catch {
        this.data = { clients: [], grants: [] };
      }
      this.loaded = true;
    }
    return this.data;
  }

  private save(): Promise<void> {
    const next = this.chain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(`${this.file}.tmp`, JSON.stringify(this.data, null, 1), { mode: 0o600 });
      await fs.rename(`${this.file}.tmp`, this.file);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  metadata(issuer: string): Record<string, unknown> {
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['studio'],
      client_id_metadata_document_supported: false,
    };
  }

  async register(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || uris.length > 10 || !uris.every(redirectAllowed)) throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must be HTTPS (or loopback HTTP).');
    const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'An AI app';
    const data = await this.load();
    const client: OAuthClient = { id: `mvc_${token().slice(0, 22)}`, name, redirectUris: uris, createdAt: new Date().toISOString() };
    // Keep registrations bounded: drop the oldest that never completed approval.
    const granted = new Set(data.grants.map((g) => g.clientId));
    while (data.clients.length >= MAX_CLIENTS) {
      const idx = data.clients.findIndex((c) => !granted.has(c.id));
      if (idx < 0) throw new OAuthError('temporarily_unavailable', 'Too many connected apps. Disconnect one in Multiverse Studio first.', 429);
      data.clients.splice(idx, 1);
    }
    data.clients.push(client);
    await this.save();
    return { client_id: client.id, client_name: client.name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(Date.now() / 1000) };
  }

  /** Validates an authorization request and asks the user. Returns the id the waiting page polls. */
  async startAuthorization(q: URLSearchParams, resourceUrl: string): Promise<{ requestId: string; appName: string; redirectHost: string }> {
    const data = await this.load();
    const client = data.clients.find((c) => c.id === q.get('client_id'));
    const redirectUri = q.get('redirect_uri') ?? '';
    // Without a known client and an exact redirect match, never redirect anywhere.
    if (!client) throw new OAuthError('invalid_client', 'This app is not registered here. Add the connector again.');
    if (!client.redirectUris.includes(redirectUri)) throw new OAuthError('invalid_request', 'The redirect address does not match the one the app registered.');
    if (q.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type', 'Only the authorization code flow is supported.');
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new OAuthError('invalid_request', 'PKCE with S256 is required.');
    const resource = this.normalizeResource(q.get('resource'), resourceUrl);
    if ([...this.pending.values()].filter((p) => p.status === 'waiting').length >= 3) throw new OAuthError('temporarily_unavailable', 'Several apps are already waiting for approval in Multiverse Studio.', 429);
    const id = token();
    const redirectHost = new URL(redirectUri).host;
    const p: PendingAuth = { id, clientId: client.id, redirectUri, state: q.get('state'), challenge, resource, status: 'waiting', redirect: null, createdAt: Date.now() };
    this.pending.set(id, p);
    void this.approve({ appName: client.name, redirectHost, requestId: id })
      .then((allowed) => {
        if (p.status !== 'waiting') return;
        if (!allowed) {
          p.status = 'denied';
          p.redirect = this.redirectWith(p, { error: 'access_denied', error_description: 'The request was declined in Multiverse Studio.' });
          return;
        }
        const code = token();
        this.codes.set(sha(code), { hash: sha(code), clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, resource: p.resource, expires: Date.now() + CODE_TTL_MS });
        p.status = 'approved';
        p.redirect = this.redirectWith(p, { code });
      })
      .catch(() => {
        p.status = 'expired';
      });
    return { requestId: id, appName: client.name, redirectHost };
  }

  status(requestId: string): { state: PendingAuth['status']; redirect: string | null } {
    const p = this.pending.get(requestId);
    if (!p) return { state: 'expired', redirect: null };
    if (p.status === 'waiting' && Date.now() - p.createdAt > APPROVAL_TTL_MS) p.status = 'expired';
    if (p.status !== 'waiting') setTimeout(() => this.pending.delete(requestId), 60_000).unref?.();
    return { state: p.status, redirect: p.redirect };
  }

  private redirectWith(p: PendingAuth, params: Record<string, string>): string {
    const u = new URL(p.redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (p.state !== null) u.searchParams.set('state', p.state);
    return u.toString();
  }

  private normalizeResource(given: string | null, resourceUrl: string): string {
    if (!given) return resourceUrl;
    const trim = (s: string) => s.replace(/\/+$/, '').toLowerCase();
    const base = resourceUrl.replace(/\/mcp$/, '');
    if (trim(given) === trim(resourceUrl) || trim(given) === trim(base)) return resourceUrl;
    throw new OAuthError('invalid_target', 'Tokens can only be issued for this Multiverse Studio connector.');
  }

  async token(body: URLSearchParams, resourceUrl: string): Promise<Record<string, unknown>> {
    const data = await this.load();
    const grantType = body.get('grant_type');
    const client = data.clients.find((c) => c.id === body.get('client_id'));
    if (!client) throw new OAuthError('invalid_client', 'Unknown client.', 401);
    if (grantType === 'authorization_code') {
      const code = this.codes.get(sha(body.get('code') ?? ''));
      if (!code || code.expires < Date.now() || code.clientId !== client.id) throw new OAuthError('invalid_grant', 'The code is invalid or expired.');
      this.codes.delete(code.hash); // single use
      if (body.get('redirect_uri') !== code.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match.');
      const verifier = body.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(createHash('sha256').update(verifier).digest('base64url'), code.challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed.');
      const resource = this.normalizeResource(body.get('resource'), resourceUrl);
      if (resource !== code.resource) throw new OAuthError('invalid_target', 'The resource differs from the authorization request.');
      const grant: OAuthGrant = { id: `g_${token().slice(0, 16)}`, clientId: client.id, resource, createdAt: new Date().toISOString(), lastUsedAt: null, accessHash: null, accessExpires: 0, refreshHash: '', refreshExpires: 0 };
      data.grants.push(grant);
      return this.issue(grant);
    }
    if (grantType === 'refresh_token') {
      const hash = sha(body.get('refresh_token') ?? '');
      const grant = data.grants.find((g) => g.clientId === client.id && same(g.refreshHash, hash));
      if (!grant || grant.refreshExpires < Date.now()) throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired. Connect again.');
      if (body.get('resource') && this.normalizeResource(body.get('resource'), resourceUrl) !== grant.resource) throw new OAuthError('invalid_target', 'The resource differs from the original grant.');
      if (grant.resource !== resourceUrl) throw new OAuthError('invalid_grant', 'This connector’s address changed. Connect again.');
      return this.issue(grant); // rotates the refresh token
    }
    throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  private async issue(grant: OAuthGrant): Promise<Record<string, unknown>> {
    const access = token();
    const refresh = token();
    grant.accessHash = sha(access);
    grant.accessExpires = Date.now() + ACCESS_TTL_S * 1000;
    grant.refreshHash = sha(refresh);
    grant.refreshExpires = Date.now() + REFRESH_TTL_MS;
    await this.save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'studio' };
  }

  /** The app behind a bearer token, if the token is valid for this resource. */
  async verify(bearer: string, resourceUrl: string): Promise<{ client: OAuthClient; grant: OAuthGrant } | null> {
    const data = await this.load();
    const hash = sha(bearer);
    const grant = data.grants.find((g) => g.accessHash !== null && same(g.accessHash, hash));
    if (!grant || grant.accessExpires < Date.now() || grant.resource !== resourceUrl) return null;
    const client = data.clients.find((c) => c.id === grant.clientId);
    if (!client) return null;
    if (!grant.lastUsedAt || Date.now() - Date.parse(grant.lastUsedAt) > 60_000) {
      grant.lastUsedAt = new Date().toISOString();
      void this.save().catch(() => undefined);
    }
    return { client, grant };
  }

  async revokeToken(value: string): Promise<void> {
    const data = await this.load();
    const hash = sha(value);
    const before = data.grants.length;
    data.grants = data.grants.filter((g) => !(g.accessHash && same(g.accessHash, hash)) && !same(g.refreshHash, hash));
    if (data.grants.length !== before) await this.save();
  }

  /** Disconnect an app: its tokens stop working at once. */
  async revokeClient(clientId: string): Promise<void> {
    const data = await this.load();
    data.grants = data.grants.filter((g) => g.clientId !== clientId);
    data.clients = data.clients.filter((c) => c.id !== clientId);
    await this.save();
  }

  async connected(): Promise<{ client: OAuthClient; createdAt: string; lastUsedAt: string | null }[]> {
    const data = await this.load();
    const out: { client: OAuthClient; createdAt: string; lastUsedAt: string | null }[] = [];
    for (const c of data.clients) {
      const grants = data.grants.filter((g) => g.clientId === c.id);
      if (!grants.length) continue;
      const last = grants.map((g) => g.lastUsedAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
      out.push({ client: c, createdAt: grants[0]!.createdAt, lastUsedAt: last });
    }
    return out;
  }

  /** Abandon a pending request (declined in the app, or the app was turned off). */
  cancelPending(): void {
    for (const p of this.pending.values()) if (p.status === 'waiting') p.status = 'expired';
  }
}
