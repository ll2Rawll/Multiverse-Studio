/**
 * Hosting adapters, written from the hosts' API documentation (read Nov 2026):
 * - Netlify: `POST /api/v1/sites/{site_id}/deploys` with a ZIP body (Content-Type application/zip),
 *   then `GET /api/v1/deploys/{deploy_id}` until `state` is `ready` (live) or `error`.
 *   `POST /api/v1/sites` creates a site. Deploy objects carry `ssl_url`, `url`, `deploy_ssl_url`,
 *   `deploy_url`, `admin_url` and `error_message`.
 * - Vercel: `POST /v2/files` (raw body, `x-vercel-digest` = SHA1) per file, then
 *   `POST /v13/deployments` referencing files by `sha`/`size`, then `GET /v13/deployments/{id}`
 *   until `readyState` is `READY`, `ERROR` or `CANCELED`. `PATCH /v12/deployments/{id}/cancel`
 *   cancels a deployment in progress. Team scope is the `teamId` query parameter.
 * Tokens are sent only to the target's own API host, as `Authorization: Bearer`.
 */

export type HostErrorKind = 'auth' | 'not-found' | 'rate-limit' | 'invalid' | 'server' | 'network' | 'timeout' | 'cancelled';

export class HostError extends Error {
  constructor(
    readonly kind: HostErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface HostCtx {
  apiBase: string;
  token: string;
  teamId: string | null;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

export interface RemoteDeploy {
  id: string;
  /** live = the host confirmed it is serving; failed/cancelled are final; working otherwise. */
  status: 'working' | 'live' | 'failed' | 'cancelled';
  hostState: string;
  url: string | null;
  deployUrl: string | null;
  adminUrl: string | null;
  error: string | null;
}

async function request(ctx: HostCtx, pathAndQuery: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array<ArrayBuffer>; timeoutMs?: number }): Promise<Response> {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 30_000);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await ctx.fetch(`${ctx.apiBase.replace(/\/+$/, '')}${pathAndQuery}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${ctx.token}`, 'User-Agent': 'MultiverseStudio/0.2', ...(init.headers ?? {}) },
      body: init.body,
      signal,
    });
  } catch (error) {
    if (ctx.signal?.aborted) throw new HostError('cancelled', 'Stopped.');
    if (timeout.aborted) throw new HostError('timeout', 'The host did not answer in time.');
    throw new HostError('network', `Could not reach the host: ${(error as Error).message}`);
  }
  if (res.ok) return res;
  let detail = '';
  try {
    const text = await res.text();
    const j = JSON.parse(text) as { message?: string; error?: { message?: string; code?: string } | string; code?: string };
    detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message ?? '');
  } catch {
    // no JSON body
  }
  const kind: HostErrorKind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 404 ? 'not-found' : res.status === 429 ? 'rate-limit' : res.status >= 500 ? 'server' : 'invalid';
  const lead =
    kind === 'auth'
      ? 'The host refused the token. Check it in Settings → Publishing (and the team, for Vercel).'
      : kind === 'not-found'
        ? 'The host could not find that site or project.'
        : kind === 'rate-limit'
          ? 'The host is limiting requests. Wait a minute and try again.'
          : kind === 'server'
            ? 'The host had a problem.'
            : 'The host rejected the request.';
  throw new HostError(kind, `${lead}${detail ? ` (${res.status}: ${detail.slice(0, 300)})` : ` (${res.status})`}`, res.status);
}

const q = (ctx: HostCtx, extra: Record<string, string> = {}): string => {
  const p = new URLSearchParams({ ...(ctx.teamId ? { teamId: ctx.teamId } : {}), ...extra });
  const s = p.toString();
  return s ? `?${s}` : '';
};

const https = (host: unknown): string | null => (typeof host === 'string' && host ? (/^https?:\/\//.test(host) ? host : `https://${host}`) : null);

/* ---------------- Netlify ---------------- */

interface NetlifyDeploy {
  id: string;
  state?: string;
  url?: string;
  ssl_url?: string;
  deploy_url?: string;
  deploy_ssl_url?: string;
  admin_url?: string;
  error_message?: string | null;
  site_id?: string;
}

export function netlifyView(d: NetlifyDeploy): RemoteDeploy {
  const state = d.state ?? 'unknown';
  return {
    id: d.id,
    status: state === 'ready' ? 'live' : state === 'error' ? 'failed' : 'working',
    hostState: state,
    url: https(d.ssl_url) ?? https(d.url),
    deployUrl: https(d.deploy_ssl_url) ?? https(d.deploy_url),
    adminUrl: d.admin_url ?? null,
    error: d.error_message ?? null,
  };
}

export async function netlifyCreateSite(ctx: HostCtx, name: string | null): Promise<{ id: string; name: string; url: string | null }> {
  const res = await request(ctx, '/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(name ? { name } : {}) });
  const s = (await res.json()) as { id: string; name: string; ssl_url?: string; url?: string };
  if (!s.id) throw new HostError('invalid', 'Netlify did not return a site id.');
  return { id: s.id, name: s.name, url: https(s.ssl_url) ?? https(s.url) };
}

export async function netlifyDeployZip(ctx: HostCtx, site: string, zip: Uint8Array): Promise<RemoteDeploy> {
  const res = await request(ctx, `/sites/${encodeURIComponent(site)}/deploys`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(zip), timeoutMs: 300_000 });
  const d = (await res.json()) as NetlifyDeploy;
  if (!d.id) throw new HostError('invalid', 'Netlify did not return a deploy id.');
  return netlifyView(d);
}

export async function netlifyGetDeploy(ctx: HostCtx, id: string): Promise<RemoteDeploy> {
  const res = await request(ctx, `/deploys/${encodeURIComponent(id)}`, { method: 'GET' });
  return netlifyView((await res.json()) as NetlifyDeploy);
}

/* ---------------- Vercel ---------------- */

interface VercelDeployment {
  id: string;
  url?: string;
  readyState?: string;
  alias?: string[];
  aliasAssigned?: boolean | number | null;
  inspectorUrl?: string | null;
  errorMessage?: string | null;
}

export function vercelView(d: VercelDeployment): RemoteDeploy {
  const state = d.readyState ?? 'UNKNOWN';
  const alias = d.aliasAssigned && d.alias?.length ? https(d.alias[0]) : null;
  return {
    id: d.id,
    status: state === 'READY' ? 'live' : state === 'ERROR' ? 'failed' : state === 'CANCELED' ? 'cancelled' : 'working',
    hostState: state,
    url: alias ?? https(d.url),
    deployUrl: https(d.url),
    adminUrl: d.inspectorUrl ?? null,
    error: d.errorMessage ?? null,
  };
}

export async function vercelUploadFile(ctx: HostCtx, sha1: string, data: Uint8Array): Promise<void> {
  await request(ctx, `/v2/files${q(ctx)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-vercel-digest': sha1, 'x-now-size': String(data.byteLength) }, body: new Uint8Array(data), timeoutMs: 120_000 });
}

export async function vercelCreateDeployment(ctx: HostCtx, input: { name: string; files: { file: string; sha: string; size: number }[]; production: boolean }): Promise<RemoteDeploy> {
  const body = { name: input.name, files: input.files, projectSettings: { framework: null }, ...(input.production ? { target: 'production' } : {}) };
  const res = await request(ctx, `/v13/deployments${q(ctx, { skipAutoDetectionConfirmation: '1' })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 120_000 });
  const d = (await res.json()) as VercelDeployment;
  if (!d.id) throw new HostError('invalid', 'Vercel did not return a deployment id.');
  return vercelView(d);
}

export async function vercelGetDeployment(ctx: HostCtx, id: string): Promise<RemoteDeploy> {
  const res = await request(ctx, `/v13/deployments/${encodeURIComponent(id)}${q(ctx)}`, { method: 'GET' });
  return vercelView((await res.json()) as VercelDeployment);
}

export async function vercelCancelDeployment(ctx: HostCtx, id: string): Promise<RemoteDeploy> {
  const res = await request(ctx, `/v12/deployments/${encodeURIComponent(id)}/cancel${q(ctx)}`, { method: 'PATCH' });
  return vercelView((await res.json()) as VercelDeployment);
}
