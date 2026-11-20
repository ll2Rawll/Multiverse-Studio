/**
 * Publishing a version of a site to a hosting service, as a persistent job.
 *
 * - Targets (host, site or project, team) are app settings; tokens live in the key vault under
 *   `publish:<target id>`, separate from AI keys and never in a project, export or log.
 * - Publishing is always started by the user, after a plan that shows the destination, the files
 *   (with what is left out on purpose) and anything that is still needed.
 * - A job is `completed` only after the host reports the deploy as live; the URL shown is the one
 *   the host returned.
 * - Jobs persist in `<project>/publish/jobs.json` with the host's deploy id. After a restart a deploy
 *   with an id is checked again; a request that may have created a deploy without returning its id
 *   is `uncertain` and is never sent again automatically.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { z } from 'zod';
import { writeFileAtomic } from '../engine/store/atomic';
import { StudioError } from '../engine/errors';
import { redactor } from '../ai/redact';
import type { SecretVault, KeyPersistence } from '../ai/vault';
import type { StudioEvent } from '../shared/types';
import { abortableSleep } from '../shared/sleep';
import { PUBLISH_PROVIDER_INFO, PUBLISH_PROVIDERS, type DeployJobView, type PublishPlanView, type PublishProvider, type PublishTargetView } from '../shared/publish';
import { HostError, netlifyCreateSite, netlifyDeployZip, netlifyGetDeploy, vercelCancelDeployment, vercelCreateDeployment, vercelGetDeployment, vercelUploadFile, type HostCtx, type RemoteDeploy } from './hosts';

const targetSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  provider: z.enum(PUBLISH_PROVIDERS),
  name: z.string().min(1).max(80),
  site: z.string().max(200),
  teamId: z.string().max(100).nullable(),
  apiBase: z.string().max(300),
  production: z.boolean(),
  createdAt: z.string(),
});
type TargetRecord = z.infer<typeof targetSchema>;

interface JobRecord extends DeployJobView {
  /** Which request was in flight, for recovery: a deploy-creating request may have succeeded. */
  step: 'none' | 'create-site' | 'create-deploy' | 'poll';
}

export interface PublishHost {
  settingsFile: string;
  vault: SecretVault | null;
  fetch?: typeof fetch;
  emit(event: StudioEvent): void;
  projectDir(projectId: string): Promise<string>;
  /** Files of a version (effective tree) and a way to read them. */
  files(projectId: string, lineId: string, revision?: string | null): Promise<{ tree: ReadonlyMap<string, string>; read(hash: string): Promise<Buffer>; lineName: string; revision: string | null; draft: boolean }>;
  pollMs?: number;
}

const ACTIVE = new Set(['queued', 'packaging', 'uploading', 'processing', 'cancelling']);
const EXCLUDE = [/^\.env($|\.)/, /(^|\/)\.env($|\.)/, /^node_modules\//, /(^|\/)node_modules\//, /^\.git\//, /^sequences\//, /\.mvseq\.json$/, /^objects\/.+\.mvobj\.json$/, /^stories\/.+\.mvstory\.json$/, /^\.multiverse\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/];
const BUILD_FOLDERS = ['dist', 'build', 'out', 'public', '_site', 'site', 'www'];
const MAX_FILES = 20_000;
const MAX_BYTES = 500 * 1024 * 1024;

/** Validate an API base: https, or http only for this computer (local mocks). */
export function checkApiBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new StudioError('invalid', 'The API address is not a URL.');
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new StudioError('invalid', 'Use an https:// API address (http:// is only allowed for this computer).');
  return url.replace(/\/+$/, '');
}

/** Which files a publish sends, and why others are left out. */
export function selectFiles(tree: ReadonlyMap<string, string>, folder: string): { files: [string, string][]; excluded: string[] } {
  const prefix = folder ? `${folder.replace(/^\/+|\/+$/g, '')}/` : '';
  const files: [string, string][] = [];
  const excluded = new Set<string>();
  for (const [p, h] of tree) {
    if (prefix && !p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (EXCLUDE.some((r) => r.test(rel))) {
      excluded.add(/\.env/.test(rel) ? `${rel} (secrets stay private)` : rel.startsWith('sequences/') || rel.endsWith('.mvseq.json') ? 'sequences/ (video timelines)' : rel.endsWith('.mvobj.json') ? 'objects/ (living object sources)' : rel.endsWith('.mvstory.json') ? 'stories/ (story sources)' : rel.split('/')[0] === 'node_modules' ? 'node_modules/' : rel);
      continue;
    }
    files.push([rel, h]);
  }
  files.sort((a, b) => a[0].localeCompare(b[0]));
  return { files, excluded: [...excluded].sort() };
}

/** Identifies an exact set of published files (path and content of each). */
export function fileSetHash(files: [string, string][]): string {
  const h = createHash('sha256');
  for (const [p, b] of files) h.update(`${p}\u0000${b}\n`);
  return h.digest('hex').slice(0, 20);
}

export class PublishService {
  private targetsCache: TargetRecord[] | null = null;
  private jobs = new Map<string, JobRecord[]>();
  private loaded = new Map<string, Promise<void>>();
  private running = new Map<string, AbortController>();
  private chain = new Map<string, Promise<unknown>>();
  private closing = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly host: PublishHost) {
    this.fetchImpl = host.fetch ?? fetch;
  }

  /* ---------------- targets ---------------- */

  private async readTargets(): Promise<TargetRecord[]> {
    if (this.targetsCache) return this.targetsCache;
    try {
      const raw = JSON.parse(await fs.readFile(this.host.settingsFile, 'utf8')) as { targets?: unknown[] };
      this.targetsCache = (raw.targets ?? []).flatMap((t) => {
        const r = targetSchema.safeParse(t);
        return r.success ? [r.data] : [];
      });
    } catch {
      this.targetsCache = [];
    }
    return this.targetsCache;
  }

  private async writeTargets(list: TargetRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.host.settingsFile), { recursive: true });
    await writeFileAtomic(this.host.settingsFile, JSON.stringify({ version: 1, targets: list }, null, 2));
    this.targetsCache = list;
  }

  private keyId = (targetId: string): string => `publish:${targetId}`;

  private async view(t: TargetRecord): Promise<PublishTargetView> {
    const d = this.host.vault ? await this.host.vault.describe(this.keyId(t.id)).catch(() => ({ present: false, storage: 'none' as const })) : { present: false, storage: 'none' as const };
    return { ...t, hasToken: d.present, tokenStorage: d.storage === 'os-encrypted' ? 'encrypted' : d.storage === 'session' ? 'session' : 'none' };
  }

  async listTargets(): Promise<PublishTargetView[]> {
    return Promise.all((await this.readTargets()).map((t) => this.view(t)));
  }

  async saveTarget(input: { id?: string; provider: PublishProvider; name: string; site: string; teamId: string | null; apiBase?: string; production: boolean; token?: string; persistence?: KeyPersistence }): Promise<PublishTargetView> {
    const list = [...(await this.readTargets())];
    const existing = input.id ? list.find((t) => t.id === input.id) : undefined;
    if (input.id && !existing) throw new StudioError('not-found', 'That publishing target no longer exists.');
    const site = input.site.trim();
    if (input.provider === 'vercel' && !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(site)) throw new StudioError('invalid', 'Vercel project names use lowercase letters, digits, dots, dashes and underscores.');
    if (input.provider === 'netlify' && site && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(site)) throw new StudioError('invalid', 'Use the Netlify site id or its name.netlify.app address.');
    const record: TargetRecord = {
      id: existing?.id ?? `pt-${randomUUID().slice(0, 8)}`,
      provider: input.provider,
      name: input.name.trim().slice(0, 80) || PUBLISH_PROVIDER_INFO[input.provider].label,
      site,
      teamId: input.teamId?.trim() || null,
      apiBase: checkApiBase(input.apiBase?.trim() || PUBLISH_PROVIDER_INFO[input.provider].apiBase),
      production: input.production,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    if (input.token) {
      if (!this.host.vault) throw new StudioError('unavailable', 'Tokens cannot be stored in this window.');
      const token = input.token.trim();
      if (token.length < 8 || /\s/.test(token)) throw new StudioError('invalid', 'That does not look like an access token.');
      redactor.addSecret(token);
      await this.host.vault.set(this.keyId(record.id), token, input.persistence ?? 'persistent');
    }
    await this.writeTargets(existing ? list.map((t) => (t.id === record.id ? record : t)) : [...list, record]);
    return this.view(record);
  }

  async removeTarget(id: string): Promise<void> {
    const list = await this.readTargets();
    await this.host.vault?.delete(this.keyId(id)).catch(() => undefined);
    await this.writeTargets(list.filter((t) => t.id !== id));
  }

  private async target(id: string): Promise<TargetRecord> {
    const t = (await this.readTargets()).find((x) => x.id === id);
    if (!t) throw new StudioError('not-found', 'That publishing target no longer exists. Add one in Settings → Publishing.');
    return t;
  }

  private async ctx(t: TargetRecord, signal?: AbortSignal): Promise<HostCtx> {
    const token = this.host.vault ? await this.host.vault.get(this.keyId(t.id)) : null;
    if (!token) throw new StudioError('not-configured', `${t.name} has no access token. Add one in Settings → Publishing.`);
    return { apiBase: t.apiBase, token, teamId: t.teamId, fetch: this.fetchImpl, signal };
  }

  /* ---------------- plan ---------------- */

  async plan(projectId: string, lineId: string, targetId: string, folder: string): Promise<PublishPlanView> {
    const t = await this.target(targetId);
    const { tree } = await this.host.files(projectId, lineId);
    const info = PUBLISH_PROVIDER_INFO[t.provider];
    const { files, excluded } = selectFiles(tree, folder);
    const folders = BUILD_FOLDERS.filter((f) => tree.has(`${f}/index.html`));
    const sizes = await this.sizes(projectId, lineId, files);
    const warnings: string[] = [];
    let requirement: string | null = null;
    const has = (p: string): boolean => files.some(([f]) => f === p);
    const pkg = has('package.json');
    if (!files.length) requirement = folder ? `${folder}/ has no files in this version.` : 'This version has no files to publish.';
    else if (!has('index.html')) {
      requirement = pkg
        ? `This version is an app without built files. Run its build in Build (for example npm run build), bring the output folder in with “Bring changes in”, then publish that folder${folders.length ? ` (found: ${folders.join(', ')})` : ''}.`
        : `There is no index.html${folder ? ` in ${folder}/` : ' at the top of this version'}. Hosts serve index.html as the home page.`;
    } else if (pkg && !folder) {
      warnings.push(`This looks like app source (package.json). The host receives these files as they are, without a build${folders.length ? `; publish ${folders[0]}/ instead if it holds the build` : ''}.`);
    }
    if (files.length > MAX_FILES) requirement = `That is ${files.length} files; publishing supports up to ${MAX_FILES}.`;
    if (sizes > MAX_BYTES) requirement = `That is ${Math.round(sizes / 1048576)} MB; publishing supports up to ${MAX_BYTES / 1048576} MB.`;
    if (t.provider === 'netlify' && !t.site) warnings.push('A new Netlify site is created on the first publish and remembered for this target.');
    if (t.provider === 'vercel' && t.production) warnings.push('Publishes to production: the project’s production domains will serve this version.');
    if (!(await this.host.vault?.describe(this.keyId(t.id)).catch(() => null))?.present) requirement = requirement ?? `${t.name} has no access token. Add one in Settings → Publishing.`;
    return {
      targetName: t.name,
      provider: t.provider,
      destination: t.provider === 'netlify' ? (t.site ? `Netlify site ${t.site}` : 'A new Netlify site') : `Vercel project ${t.site}${t.teamId ? ` (team ${t.teamId})` : ''}${t.production ? ', production' : ', preview'}`,
      folder,
      fileCount: files.length,
      bytes: sizes,
      excluded,
      warnings,
      requirement,
      folders,
    };
  }

  private async sizes(projectId: string, lineId: string, files: [string, string][]): Promise<number> {
    const { read } = await this.host.files(projectId, lineId);
    let n = 0;
    for (const [, h] of files.slice(0, MAX_FILES + 1)) n += (await read(h)).length;
    return n;
  }

  /* ---------------- jobs ---------------- */

  private async file(projectId: string): Promise<string> {
    return path.join(await this.host.projectDir(projectId), 'publish', 'jobs.json');
  }

  private async load(projectId: string): Promise<JobRecord[]> {
    let p = this.loaded.get(projectId);
    if (!p) {
      p = (async () => {
        let list: JobRecord[] = [];
        try {
          list = JSON.parse(await fs.readFile(await this.file(projectId), 'utf8')) as JobRecord[];
        } catch {
          list = [];
        }
        this.jobs.set(projectId, list);
        await this.recover(projectId, list);
      })();
      this.loaded.set(projectId, p);
    }
    await p;
    return this.jobs.get(projectId)!;
  }

  private persist(projectId: string): Promise<void> {
    const run = (this.chain.get(projectId) ?? Promise.resolve()).then(async () => {
      const f = await this.file(projectId);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await writeFileAtomic(f, JSON.stringify((this.jobs.get(projectId) ?? []).slice(0, 100), null, 1));
    });
    this.chain.set(projectId, run.catch(() => undefined));
    return run;
  }

  private viewOf(j: JobRecord): DeployJobView {
    const { step: _s, ...v } = j;
    return { ...v };
  }

  private async update(projectId: string, job: JobRecord, patch: Partial<JobRecord>): Promise<void> {
    if (this.closing) return;
    Object.assign(job, patch);
    await this.persist(projectId);
    this.host.emit({ type: 'publish-job', projectId, job: this.viewOf(job) });
  }

  private async recover(projectId: string, list: JobRecord[]): Promise<void> {
    let changed = false;
    for (const j of list) {
      if (!ACTIVE.has(j.state)) continue;
      changed = true;
      if (j.remoteId && (j.state === 'processing' || j.state === 'cancelling' || j.step === 'poll')) {
        j.detail = 'Checking with the host after a restart…';
        queueMicrotask(() => void this.follow(projectId, j));
      } else if (j.step === 'create-deploy' || j.step === 'create-site') {
        j.state = 'uncertain';
        j.detail = 'Unknown whether the host received it';
        j.error = `Multiverse Studio closed while sending this to ${j.targetName}. The host may have created ${j.step === 'create-site' ? 'a site' : 'a deploy'}. Check its dashboard before publishing again; it will not be sent again automatically.`;
        j.finishedAt = new Date().toISOString();
      } else {
        j.state = 'interrupted';
        j.detail = 'Interrupted';
        j.error = 'Multiverse Studio closed before anything was sent. Publishing again is safe.';
        j.finishedAt = new Date().toISOString();
      }
    }
    if (changed) await this.persist(projectId);
  }

  async list(projectId: string): Promise<DeployJobView[]> {
    return (await this.load(projectId)).map((j) => this.viewOf(j));
  }

  async start(projectId: string, lineId: string, targetId: string, folder: string, retryOf: string | null = null): Promise<DeployJobView> {
    const plan = await this.plan(projectId, lineId, targetId, folder);
    if (plan.requirement) throw new StudioError('not-ready', plan.requirement);
    const t = await this.target(targetId);
    const src = await this.host.files(projectId, lineId);
    const lineName = src.lineName;
    const sourceHash = fileSetHash(selectFiles(src.tree, folder).files);
    const list = await this.load(projectId);
    if (list.some((j) => ACTIVE.has(j.state) && j.targetId === targetId)) throw new StudioError('busy', `${t.name} is already publishing. Wait for it to finish or stop it.`);
    const job: JobRecord = {
      id: `d-${randomUUID().slice(0, 10)}`,
      projectId,
      lineId,
      lineName,
      targetId,
      targetName: t.name,
      provider: t.provider,
      folder,
      state: 'queued',
      detail: 'Waiting to start',
      remoteId: null,
      url: null,
      deployUrl: null,
      adminUrl: null,
      fileCount: plan.fileCount,
      bytes: plan.bytes,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      remoteCancel: PUBLISH_PROVIDER_INFO[t.provider].cancel,
      retryOf,
      revision: src.revision,
      draft: src.draft,
      sourceHash,
      step: 'none',
    };
    list.unshift(job);
    await this.update(projectId, job, {});
    void this.run(projectId, job);
    return this.viewOf(job);
  }

  private async run(projectId: string, job: JobRecord): Promise<void> {
    const abort = new AbortController();
    this.running.set(job.id, abort);
    try {
      const t = await this.target(job.targetId);
      const ctx = await this.ctx(t, abort.signal);
      await this.update(projectId, job, { state: 'packaging', detail: 'Collecting files' });
      // Publish exactly the files that were reviewed: the saved revision, or (for unsaved changes) the same set.
      const { tree, read } = await this.host.files(projectId, job.lineId, job.draft ? null : job.revision);
      const { files } = selectFiles(tree, job.folder);
      if (job.sourceHash && fileSetHash(files) !== job.sourceHash) throw new StudioError('changed', 'The files changed after you pressed Publish, so nothing was uploaded. Publish again to send the current files.');
      let remote: RemoteDeploy;
      if (t.provider === 'netlify') {
        const zip = new JSZip();
        for (const [p, h] of files) zip.file(p, await read(h));
        const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        let site = t.site;
        if (!site) {
          await this.update(projectId, job, { state: 'uploading', detail: 'Creating a Netlify site', step: 'create-site' });
          const created = await netlifyCreateSite(ctx, null);
          site = created.id;
          const list = await this.readTargets();
          await this.writeTargets(list.map((x) => (x.id === t.id ? { ...x, site: created.id } : x)));
        }
        await this.update(projectId, job, { state: 'uploading', detail: `Uploading ${files.length} files`, step: 'create-deploy' });
        remote = await netlifyDeployZip(ctx, site, data);
      } else {
        await this.update(projectId, job, { state: 'uploading', detail: `Uploading ${files.length} files` });
        const refs: { file: string; sha: string; size: number }[] = [];
        let done = 0;
        const queue = [...files];
        const worker = async (): Promise<void> => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            const data = await read(next[1]);
            const sha = createHash('sha1').update(data).digest('hex');
            // Uploading a file by its digest is idempotent, so a repeat after a restart is harmless.
            await vercelUploadFile(ctx, sha, data);
            refs.push({ file: next[0], sha, size: data.length });
            done++;
            if (done % 10 === 0) await this.update(projectId, job, { detail: `Uploaded ${done} of ${files.length} files` });
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
        refs.sort((a, b) => a.file.localeCompare(b.file));
        await this.update(projectId, job, { detail: 'Creating the deployment', step: 'create-deploy' });
        remote = await vercelCreateDeployment(ctx, { name: t.site, files: refs, production: t.production });
      }
      await this.update(projectId, job, { state: 'processing', remoteId: remote.id, step: 'poll', detail: `The host is processing it (${remote.hostState})`, adminUrl: remote.adminUrl });
      this.running.delete(job.id);
      await this.follow(projectId, job, remote);
    } catch (error) {
      this.running.delete(job.id);
      await this.fail(projectId, job, error, abort.signal.aborted);
    }
  }

  private async fail(projectId: string, job: JobRecord, error: unknown, aborted: boolean): Promise<void> {
    if (this.closing) return;
    const at = new Date().toISOString();
    const message = redactor.redact(error instanceof Error ? error.message : String(error));
    const sentCreate = job.step === 'create-deploy' || job.step === 'create-site';
    if (aborted || (error instanceof HostError && error.kind === 'cancelled')) {
      await this.update(projectId, job, {
        state: 'cancelled',
        finishedAt: at,
        detail: 'Stopped',
        error: sentCreate && !job.remoteId ? `Stopped while sending. ${job.targetName} may still create the deploy; check its dashboard.` : null,
      });
      return;
    }
    if (sentCreate && !job.remoteId && error instanceof HostError && (error.kind === 'timeout' || error.kind === 'network')) {
      await this.update(projectId, job, { state: 'uncertain', finishedAt: at, detail: 'The answer never arrived', error: `${message} The host may have created ${job.step === 'create-site' ? 'a site' : 'the deploy'}. Check ${job.targetName}’s dashboard before publishing again; it will not be sent again automatically.` });
      return;
    }
    await this.update(projectId, job, { state: 'failed', finishedAt: at, detail: 'Failed', error: message.slice(0, 2000) });
  }

  /** Poll the host until it reports the deploy live, failed or cancelled. */
  private async follow(projectId: string, job: JobRecord, first?: RemoteDeploy): Promise<void> {
    if (!job.remoteId || this.running.has(job.id)) return;
    const abort = new AbortController();
    this.running.set(job.id, abort);
    const pollMs = this.host.pollMs ?? 2000;
    try {
      const t = await this.target(job.targetId);
      const ctx = await this.ctx(t, abort.signal);
      let remote = first ?? null;
      const deadline = Date.now() + 15 * 60_000;
      for (;;) {
        if (remote) {
          if (remote.status === 'live') {
            await this.update(projectId, job, { state: 'completed', finishedAt: new Date().toISOString(), detail: `Live (${remote.hostState})`, url: remote.url, deployUrl: remote.deployUrl, adminUrl: remote.adminUrl ?? job.adminUrl, error: null });
            return;
          }
          if (remote.status === 'failed' || remote.status === 'cancelled') {
            await this.update(projectId, job, { state: remote.status === 'failed' ? 'failed' : 'cancelled', finishedAt: new Date().toISOString(), detail: `The host reports ${remote.hostState}`, error: remote.error ? redactor.redact(remote.error) : remote.status === 'failed' ? `${job.targetName} reported an error without details. See its dashboard.` : null, adminUrl: remote.adminUrl ?? job.adminUrl });
            return;
          }
          if (job.state !== 'cancelling') await this.update(projectId, job, { state: 'processing', detail: `The host is processing it (${remote.hostState})` });
        }
        if (Date.now() > deadline) {
          await this.update(projectId, job, { detail: 'Still processing after 15 minutes. Check again later; nothing was sent again.' });
          return;
        }
        await abortableSleep(remote ? pollMs : 0, abort.signal, () => new HostError('cancelled', 'Stopped.'));
        remote = t.provider === 'netlify' ? await netlifyGetDeploy(ctx, job.remoteId) : await vercelGetDeployment(ctx, job.remoteId);
      }
    } catch (error) {
      if (this.closing || abort.signal.aborted) return;
      // Checking failed (offline, token removed): the deploy may be fine; keep the id so it can be checked again.
      await this.update(projectId, job, { detail: `Could not check the deploy: ${redactor.redact((error as Error).message)} Use “Check again”.` });
    } finally {
      if (this.running.get(job.id) === abort) this.running.delete(job.id);
    }
  }

  async check(projectId: string, jobId: string): Promise<DeployJobView> {
    const job = (await this.load(projectId)).find((j) => j.id === jobId);
    if (!job) throw new StudioError('not-found', 'That publish job no longer exists.');
    if (!job.remoteId) throw new StudioError('invalid', 'This job has no deploy id to check.');
    if (!['processing', 'cancelling'].includes(job.state)) await this.update(projectId, job, { state: 'processing', detail: 'Checking with the host…', finishedAt: null });
    void this.follow(projectId, job);
    return this.viewOf(job);
  }

  async cancel(projectId: string, jobId: string): Promise<DeployJobView> {
    const job = (await this.load(projectId)).find((j) => j.id === jobId);
    if (!job) throw new StudioError('not-found', 'That publish job no longer exists.');
    if (!ACTIVE.has(job.state)) return this.viewOf(job);
    if (job.state === 'processing' && job.remoteId) {
      if (job.provider === 'vercel') {
        await this.update(projectId, job, { state: 'cancelling', detail: 'Asking Vercel to cancel' });
        const t = await this.target(job.targetId);
        try {
          const r = await vercelCancelDeployment(await this.ctx(t), job.remoteId);
          if (r.status === 'cancelled') {
            this.running.get(job.id)?.abort();
            await this.update(projectId, job, { state: 'cancelled', finishedAt: new Date().toISOString(), detail: 'Vercel cancelled the deployment.' });
          }
        } catch (error) {
          await this.update(projectId, job, { state: 'processing', detail: `Vercel did not cancel it: ${redactor.redact((error as Error).message)}` });
        }
        return this.viewOf(job);
      }
      // Netlify ZIP deploys are processed right away; this app does not cancel them at the host.
      this.running.get(job.id)?.abort();
      await this.update(projectId, job, { state: 'cancelled', finishedAt: new Date().toISOString(), detail: 'Stopped checking', error: 'Netlify keeps processing this deploy and may publish it. Check the site’s deploys on Netlify.' });
      return this.viewOf(job);
    }
    this.running.get(job.id)?.abort();
    return this.viewOf(job);
  }

  async retry(projectId: string, jobId: string, confirmUncertain: boolean): Promise<DeployJobView> {
    const job = (await this.load(projectId)).find((j) => j.id === jobId);
    if (!job) throw new StudioError('not-found', 'That publish job no longer exists.');
    if (ACTIVE.has(job.state) || job.state === 'completed') throw new StudioError('invalid', 'Only finished jobs that did not publish can be tried again.');
    if (job.state === 'uncertain' && !confirmUncertain) throw new StudioError('confirm-needed', `Confirm that you checked ${job.targetName} first: the earlier attempt may already have published.`);
    return this.start(projectId, job.lineId, job.targetId, job.folder, job.id);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const a of this.running.values()) a.abort();
  }
}
