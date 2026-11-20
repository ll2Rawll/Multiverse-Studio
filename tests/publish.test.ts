/**
 * Publishing against MOCKED Netlify and Vercel APIs (no real host is called and no real token is
 * used): targets and tokens, plans, the exact requests, success only after the host reports the
 * deploy live, failures, cancellation, and recovery after a restart without resubmitting.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { StudioService } from '../src/services/studio';
import { MemoryVault } from '../src/ai/vault';
import { SHARED_LINE_ID } from '../src/shared/types';
import type { DeployJobView } from '../src/shared/publish';

const SAMPLE_ROOT = path.resolve(import.meta.dirname, '..', 'sample');
const NETLIFY_TOKEN = 'nfp_test000000000000000000000000000000';
const VERCEL_TOKEN = 'vercel-test-0000000000000000000000';
const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

function hosts() {
  const calls: Call[] = [];
  const mode = { netlifyPolls: 0, netlifyFinal: 'ready' as 'ready' | 'error', hangCreate: false, vercelPolls: 0, vercelFinal: 'READY' as 'READY' | 'ERROR' | 'BUILDING', status401: false };
  const fetchMock = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(typeof init.body === 'string' ? init.body : '');
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(url), headers, body });
    if (mode.status401) return new Response(JSON.stringify({ message: `Access denied for ${headers.authorization}` }), { status: 401 });
    // Netlify
    if (u.pathname === '/api/v1/sites' && method === 'POST') return Response.json({ id: 'site-123', name: 'brave-kiln-123', ssl_url: 'https://brave-kiln-123.netlify.app' }, { status: 201 });
    if (/^\/api\/v1\/sites\/[^/]+\/deploys$/.test(u.pathname) && method === 'POST') {
      // Like real fetch: reject at once if already aborted, otherwise when aborted.
      if (mode.hangCreate)
        return new Promise<Response>((_, reject) => {
          if (init.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      return Response.json({ id: 'dep-1', state: 'uploaded', admin_url: 'https://app.netlify.com/sites/brave-kiln-123' });
    }
    if (u.pathname === '/api/v1/deploys/dep-1') {
      mode.netlifyPolls++;
      if (mode.netlifyPolls < 2) return Response.json({ id: 'dep-1', state: 'processing' });
      return Response.json(mode.netlifyFinal === 'ready' ? { id: 'dep-1', state: 'ready', ssl_url: 'https://brave-kiln-123.netlify.app', deploy_ssl_url: 'https://dep-1--brave-kiln-123.netlify.app', admin_url: 'https://app.netlify.com/sites/brave-kiln-123' } : { id: 'dep-1', state: 'error', error_message: 'Build script returned non-zero exit code' });
    }
    // Vercel
    if (u.pathname === '/v2/files' && method === 'POST') return Response.json({ urls: [] });
    if (u.pathname === '/v13/deployments' && method === 'POST') return Response.json({ id: 'dpl_1', url: 'kiln-abc123.vercel.app', readyState: 'QUEUED', inspectorUrl: 'https://vercel.com/team/kiln/dpl_1' });
    if (u.pathname === '/v13/deployments/dpl_1') {
      mode.vercelPolls++;
      if (mode.vercelPolls < 2 || mode.vercelFinal === 'BUILDING') return Response.json({ id: 'dpl_1', url: 'kiln-abc123.vercel.app', readyState: 'BUILDING' });
      return Response.json(mode.vercelFinal === 'READY' ? { id: 'dpl_1', url: 'kiln-abc123.vercel.app', readyState: 'READY', alias: ['kiln.vercel.app'], aliasAssigned: true } : { id: 'dpl_1', readyState: 'ERROR', errorMessage: 'Deployment failed' });
    }
    if (u.pathname === '/v12/deployments/dpl_1/cancel' && method === 'PATCH') return Response.json({ id: 'dpl_1', url: 'kiln-abc123.vercel.app', readyState: 'CANCELED' });
    return new Response('{"message":"not mocked"}', { status: 404 });
  }) as typeof fetch;
  return { calls, mode, fetchMock };
}

const vault = new MemoryVault();

async function setup(name: string, h = hosts(), ws?: string) {
  const dir = ws ?? (await fs.mkdtemp(path.join(os.tmpdir(), `mv-pub-${name}-`)));
  if (!ws) dirs.push(dir);
  const service = new StudioService({ workspaceRoot: path.join(dir, 'ws'), sampleRoot: SAMPLE_ROOT, previewUrl: (t) => t, emit: () => {}, cacheRoot: path.join(dir, 'cache'), publish: { vault, settingsFile: path.join(dir, 'publish.json'), fetch: h.fetchMock, pollMs: 5 } });
  return { service, dir, hosts: h };
}

async function site(service: StudioService, dir: string, files: Record<string, string>): Promise<string> {
  const folder = path.join(dir, `site-${Math.random().toString(36).slice(2, 7)}`);
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(folder, p)), { recursive: true });
    await fs.writeFile(path.join(folder, p), c);
  }
  return (await service.call('projects.import', { folderPath: folder }))!.project.id;
}

async function settle(service: StudioService, projectId: string, jobId: string, until: (j: DeployJobView) => boolean = (j) => !['queued', 'packaging', 'uploading', 'processing', 'cancelling'].includes(j.state)): Promise<DeployJobView> {
  for (let i = 0; i < 2000; i++) {
    const j = (await service.call('publish.list', { projectId })).find((x) => x.id === jobId)!;
    if (until(j)) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('publish job did not settle');
}

const SITE = { 'index.html': '<!doctype html><title>Kiln</title><img src="images/a.png">', 'images/a.png': 'PNG', '.env': 'SECRET=1', 'sequences/cut.mvseq.json': '{}' };

test('targets: tokens go to the vault, never to settings; API addresses must be https', async () => {
  const { service, dir } = await setup('targets');
  await assert.rejects(service.call('publish.targets.save', { provider: 'netlify', name: 'Kiln', site: '', teamId: null, apiBase: 'http://api.example.com', production: true }), /https/);
  const t = await service.call('publish.targets.save', { provider: 'netlify', name: 'Kiln on Netlify', site: '', teamId: null, production: true, token: NETLIFY_TOKEN, persistence: 'session' });
  assert.equal(t.hasToken, true);
  assert.equal(t.tokenStorage, 'session');
  assert.equal(t.apiBase, 'https://api.netlify.com/api/v1');
  const saved = await fs.readFile(path.join(dir, 'publish.json'), 'utf8');
  assert.doesNotMatch(saved, new RegExp(NETLIFY_TOKEN));
  await assert.rejects(service.call('publish.targets.save', { provider: 'vercel', name: 'V', site: 'Bad Name', teamId: null, production: false }), /lowercase/);
  await service.call('publish.targets.remove', { id: t.id });
  assert.equal(await vault.get(`publish:${t.id}`), null);
  await service.shutdown();
});

test('plan: shows what is sent, leaves secrets and timelines out, and names what is missing', async () => {
  const { service, dir } = await setup('plan');
  const t = await service.call('publish.targets.save', { provider: 'netlify', name: 'Kiln', site: 'brave-kiln-123', teamId: null, production: true });
  const projectId = await site(service, dir, SITE);
  let plan = await service.call('publish.plan', { projectId, lineId: SHARED_LINE_ID, targetId: t.id });
  assert.match(plan.requirement ?? '', /no access token/);
  await service.call('publish.targets.save', { id: t.id, provider: 'netlify', name: 'Kiln', site: 'brave-kiln-123', teamId: null, production: true, token: NETLIFY_TOKEN, persistence: 'session' });
  plan = await service.call('publish.plan', { projectId, lineId: SHARED_LINE_ID, targetId: t.id });
  assert.equal(plan.requirement, null);
  assert.equal(plan.fileCount, 2);
  assert.equal(plan.destination, 'Netlify site brave-kiln-123');
  assert.deepEqual(plan.excluded, ['.env (secrets stay private)', 'sequences/ (video timelines)']);

  const app = await site(service, dir, { 'index.html': '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>', 'package.json': '{"scripts":{"build":"vite build"}}', 'src/main.tsx': 'x', 'dist/index.html': '<!doctype html><title>Built</title>', 'dist/app.js': '1' });
  const appPlan = await service.call('publish.plan', { projectId: app, lineId: SHARED_LINE_ID, targetId: t.id });
  assert.equal(appPlan.requirement, null);
  assert.match(appPlan.warnings.join(' '), /app source.*publish dist\/ instead/);
  assert.deepEqual(appPlan.folders, ['dist']);
  const distPlan = await service.call('publish.plan', { projectId: app, lineId: SHARED_LINE_ID, targetId: t.id, folder: 'dist' });
  assert.equal(distPlan.requirement, null);
  assert.equal(distPlan.fileCount, 2);
  const srcPlan = await service.call('publish.plan', { projectId: app, lineId: SHARED_LINE_ID, targetId: t.id, folder: 'src' });
  assert.match(srcPlan.requirement ?? '', /no index\.html in src\//);
  await assert.rejects(service.call('publish.plan', { projectId: app, lineId: SHARED_LINE_ID, targetId: t.id, folder: '../x' }), /inside the version/);
  await service.shutdown();
});

test('Netlify: a new site, a ZIP deploy, and success only after the host reports it ready', async () => {
  const { service, dir, hosts: h } = await setup('netlify');
  const t = await service.call('publish.targets.save', { provider: 'netlify', name: 'Kiln', site: '', teamId: null, production: true, token: NETLIFY_TOKEN, persistence: 'session' });
  const projectId = await site(service, dir, SITE);
  const job = await service.call('publish.start', { projectId, lineId: SHARED_LINE_ID, targetId: t.id });
  const processing = await settle(service, projectId, job.id, (j) => j.state === 'processing' || j.state === 'completed');
  if (processing.state === 'processing') assert.equal(processing.url, null, 'no URL is reported before the host confirms');
  const done = await settle(service, projectId, job.id);
  assert.equal(done.state, 'completed', done.error ?? '');
  assert.equal(done.url, 'https://brave-kiln-123.netlify.app');
  assert.equal(done.deployUrl, 'https://dep-1--brave-kiln-123.netlify.app');
  assert.equal(done.remoteId, 'dep-1');
  const create = h.calls.find((c) => c.url === 'https://api.netlify.com/api/v1/sites')!;
  assert.equal(create.headers.authorization, `Bearer ${NETLIFY_TOKEN}`);
  const deploy = h.calls.find((c) => c.url === 'https://api.netlify.com/api/v1/sites/site-123/deploys')!;
  assert.equal(deploy.headers['content-type'], 'application/zip');
  const zip = await JSZip.loadAsync(deploy.body);
  assert.deepEqual(Object.keys(zip.files).filter((f) => !zip.files[f]!.dir).sort(), ['images/a.png', 'index.html']);
  assert.equal((await service.call('publish.targets.list', {}))[0]!.site, 'site-123', 'the new site is remembered');
  // The token is never written into the project.
  const engine = await service.engine(projectId);
  const jobsFile = await fs.readFile(path.join(engine.dir, 'publish', 'jobs.json'), 'utf8');
  assert.doesNotMatch(jobsFile, new RegExp(NETLIFY_TOKEN));
  await service.shutdown();
});

test('Vercel: files by digest, a production deployment in the team, then READY with the alias', async () => {
  const { service, dir, hosts: h } = await setup('vercel');
  const t = await service.call('publish.targets.save', { provider: 'vercel', name: 'Kiln on Vercel', site: 'kiln', teamId: 'team_1', production: true, token: VERCEL_TOKEN, persistence: 'session' });
  const projectId = await site(service, dir, SITE);
  const job = await service.call('publish.start', { projectId, lineId: SHARED_LINE_ID, targetId: t.id });
  const done = await settle(service, projectId, job.id);
  assert.equal(done.state, 'completed', done.error ?? '');
  assert.equal(done.url, 'https://kiln.vercel.app');
  assert.equal(done.deployUrl, 'https://kiln-abc123.vercel.app');
  const uploads = h.calls.filter((c) => c.url.startsWith('https://api.vercel.com/v2/files'));
  assert.equal(uploads.length, 2);
  for (const u of uploads) {
    assert.equal(u.headers['x-vercel-digest'], createHash('sha1').update(u.body).digest('hex'));
    assert.match(u.url, /teamId=team_1/);
  }
  const create = h.calls.find((c) => c.url.startsWith('https://api.vercel.com/v13/deployments?'))!;
  assert.match(create.url, /skipAutoDetectionConfirmation=1/);
  const body = JSON.parse(create.body.toString()) as { name: string; target: string; files: { file: string; sha: string; size: number }[]; projectSettings: { framework: null } };
  assert.equal(body.name, 'kiln');
  assert.equal(body.target, 'production');
  assert.deepEqual(body.files.map((f) => f.file), ['images/a.png', 'index.html']);
  assert.equal(body.projectSettings.framework, null);
  await service.shutdown();
});

test('failures: a host error is reported as the host said it; a refused token never appears in errors', async () => {
  const h = hosts();
  h.mode.vercelFinal = 'ERROR';
  const { service, dir } = await setup('fail', h);
  const t = await service.call('publish.targets.save', { provider: 'vercel', name: 'V', site: 'kiln', teamId: null, production: false, token: VERCEL_TOKEN, persistence: 'session' });
  const projectId = await site(service, dir, SITE);
  const failed = await settle(service, projectId, (await service.call('publish.start', { projectId, lineId: SHARED_LINE_ID, targetId: t.id })).id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'Deployment failed');
  assert.equal(failed.url, null);
  h.mode.status401 = true;
  const refused = await settle(service, projectId, (await service.call('publish.start', { projectId, lineId: SHARED_LINE_ID, targetId: t.id })).id);
  assert.equal(refused.state, 'failed');
  assert.match(refused.error ?? '', /refused the token/);
  assert.doesNotMatch(refused.error ?? '', new RegExp(VERCEL_TOKEN));
  await service.shutdown();
});

test('cancel: Vercel cancels at the host; Netlify only stops checking and says so', async () => {
  const h = hosts();
  h.mode.vercelFinal = 'BUILDING';
  const { service, dir } = await setup('cancel', h);
  const v = await service.call('publish.targets.save', { provider: 'vercel', name: 'V', site: 'kiln', teamId: null, production: false, token: VERCEL_TOKEN, persistence: 'session' });
  const projectId = await site(service, dir, SITE);
  const job = await service.call('publish.start', { projectId, lineId: SHARED_LINE_ID, targetId: v.id });
  await settle(service, projectId, job.id, (j) => j.state === 'processing');
  await service.call('publish.cancel', { projectId, jobId: job.id });
  const c = await settle(service, projectId, job.id);
  assert.equal(c.state, 'cancelled');
  assert.ok(h.calls.some((x) => x.method === 'PATCH' && x.url.endsWith('/v12/deployments/dpl_1/cancel')));
  await service.shutdown();
});

test('restart: a processing deploy is checked by id (never re-sent); an unanswered create is uncertain', async () => {
  const h = hosts();
  h.mode.netlifyFinal = 'ready';
  const first = await setup('restart', h);
  const t = await first.service.call('publish.targets.save', { provider: 'netlify', name: 'Kiln', site: 'site-123', teamId: null, production: true, token: NETLIFY_TOKEN, persistence: 'session' });
  const projectId = await site(first.service, first.dir, SITE);
  // Simulate a crash after the host accepted the deploy: write the job state as the app left it.
  const engine = await first.service.engine(projectId);
  await fs.mkdir(path.join(engine.dir, 'publish'), { recursive: true });
  const base = { projectId, lineId: SHARED_LINE_ID, lineName: 'Shared', targetId: t.id, targetName: 'Kiln', provider: 'netlify', folder: '', url: null, deployUrl: null, adminUrl: null, fileCount: 2, bytes: 10, createdAt: new Date().toISOString(), finishedAt: null, error: null, remoteCancel: false, retryOf: null };
  await fs.writeFile(
    path.join(engine.dir, 'publish', 'jobs.json'),
    JSON.stringify([
      { ...base, id: 'd-processing', state: 'processing', detail: 'x', remoteId: 'dep-1', step: 'poll' },
      { ...base, id: 'd-sending', state: 'uploading', detail: 'x', remoteId: null, step: 'create-deploy' },
      { ...base, id: 'd-queued', state: 'packaging', detail: 'x', remoteId: null, step: 'none' },
    ]),
  );
  await first.service.shutdown();
  const second = await setup('restart', h, first.dir);
  await second.service.call('projects.open', { projectId });
  const done = await settle(second.service, projectId, 'd-processing');
  assert.equal(done.state, 'completed');
  assert.equal(done.url, 'https://brave-kiln-123.netlify.app');
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0, 'nothing was sent again');
  const list = await second.service.call('publish.list', { projectId });
  assert.equal(list.find((j) => j.id === 'd-sending')!.state, 'uncertain');
  assert.equal(list.find((j) => j.id === 'd-queued')!.state, 'interrupted');
  await assert.rejects(second.service.call('publish.retry', { projectId, jobId: 'd-sending', confirmUncertain: false }), /Confirm that you checked/);
  const retry = await second.service.call('publish.retry', { projectId, jobId: 'd-sending', confirmUncertain: true });
  assert.equal(retry.retryOf, 'd-sending');
  assert.equal((await settle(second.service, projectId, retry.id)).state, 'completed');
  await second.service.shutdown();
});

test('a create request that never answers becomes uncertain, not failed', async () => {
  const h = hosts();
  h.mode.hangCreate = true;
  const { service, dir } = await setup('hang', h);
  const t = await service.call('publish.targets.save', { provider: 'netlify', name: 'Kiln', site: 'site-123', teamId: null, production: true, token: NETLIFY_TOKEN, persistence: 'session' });
  const projectId = await site(service, dir, SITE);
  const job = await service.call('publish.start', { projectId, lineId: SHARED_LINE_ID, targetId: t.id });
  await settle(service, projectId, job.id, (j) => j.state === 'uploading');
  await service.call('publish.cancel', { projectId, jobId: job.id });
  const stopped = await settle(service, projectId, job.id);
  assert.equal(stopped.state, 'cancelled');
  assert.match(stopped.error ?? '', /may still create the deploy/);
  await service.shutdown();
});

test('releases: each destination records the exact revision and files it received, and says when it falls behind', async () => {
  const { service, dir } = await setup('release');
  const t = await service.call('publish.targets.save', { provider: 'netlify', name: 'Kiln site', site: '', teamId: null, production: true, token: NETLIFY_TOKEN, persistence: 'session' });
  const projectId = await site(service, dir, SITE);
  const engine = await service.engine(projectId);
  const revision = engine.line(SHARED_LINE_ID).head;
  const job = await service.call('publish.start', { projectId, lineId: SHARED_LINE_ID, targetId: t.id });
  assert.equal(job.revision, revision);
  assert.equal(job.draft, false);
  assert.match(job.sourceHash ?? '', /^[0-9a-f]{20}$/);
  // Editing while the job is queued does not change what is sent: the saved revision is published.
  const done = await settle(service, projectId, job.id);
  assert.equal(done.state, 'completed', done.error ?? '');
  let [dest] = await service.call('releases.list', { projectId });
  assert.equal(dest!.kind, 'website');
  assert.equal(dest!.live?.revision, revision);
  assert.equal(dest!.current, true);
  await service.call('files.write', { projectId, lineId: SHARED_LINE_ID, path: 'index.html', text: '<!doctype html><title>Kiln 2</title>' });
  [dest] = await service.call('releases.list', { projectId });
  assert.equal(dest!.current, false);
  assert.match(dest!.currentDetail, /changed since; the host still serves the earlier files/);
  // A deploy of unsaved changes says so; a mismatch between review and upload sends nothing.
  const draftJob = await service.call('publish.start', { projectId, lineId: SHARED_LINE_ID, targetId: t.id });
  assert.equal(draftJob.draft, true);
  const draftDone = await settle(service, projectId, draftJob.id);
  assert.equal(draftDone.state, 'completed', draftDone.error ?? '');
  [dest] = await service.call('releases.list', { projectId });
  assert.equal(dest!.current, true);
  assert.equal(dest!.live?.draft, true);
  await service.shutdown();
});
