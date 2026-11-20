/**
 * Publishing UI: destinations in Settings, and the Publish dialog (plan → user-initiated publish → job status).
 * Success is shown only when the host confirmed the deploy; the URL is the one the host returned.
 */
import { useEffect, useState } from 'react';
import { closeDialog, openDialog, toast } from '../state/store';
import { useAi, loadAiState } from '../state/ai';
import { ACTIVE_DEPLOY, jobAction, loadJobs, loadTargets, openUrl, usePublish } from '../state/publish';
import { call, errorMessage } from '../lib/api';
import { Dialog } from '../components/Dialog';
import { Button, EmptyState, Toggle } from '../components/primitives';
import { Icon } from '../components/Icon';
import { allLines, bytes, cx, plural, relativeTime } from '../lib/util';
import { PUBLISH_PROVIDERS, PUBLISH_PROVIDER_INFO, type DeployJobView, type PublishPlanView, type PublishProvider, type PublishTargetView } from '../../shared/publish';
import type { ContentRef, ProjectView } from '../../shared/types';

interface TargetDraft {
  id?: string;
  provider: PublishProvider;
  name: string;
  site: string;
  teamId: string;
  apiBase: string;
  production: boolean;
  token: string;
  persistence: 'persistent' | 'session';
}

function TargetForm({ draft, onDone }: { draft: TargetDraft; onDone: () => void }) {
  const vault = useAi((s) => s.ai?.vault);
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const info = PUBLISH_PROVIDER_INFO[d.provider];
  const update = (patch: Partial<TargetDraft>): void => setD((x) => ({ ...x, ...patch }));
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await call('publish.targets.save', {
        id: d.id,
        provider: d.provider,
        name: d.name,
        site: d.site,
        teamId: d.provider === 'vercel' && d.teamId.trim() ? d.teamId.trim() : null,
        apiBase: d.apiBase.trim() || undefined,
        production: d.production,
        token: d.token.trim() || undefined,
        persistence: d.token.trim() ? d.persistence : undefined,
      });
      await loadTargets();
      toast({ tone: 'success', title: `${d.name} saved` });
      onDone();
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t save the destination', body: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="ai-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{d.id ? `Edit ${d.name}` : `Add ${info.label}`}</h3>
      <div className="field">
        <label className="field-label" htmlFor="pt-name">Display name</label>
        <input id="pt-name" className="input" value={d.name} maxLength={80} onChange={(e) => update({ name: e.target.value })} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="pt-site">{info.siteLabel}{d.provider === 'netlify' ? ' (optional)' : ''}</label>
        <input id="pt-site" className="input mono" value={d.site} spellCheck={false} onChange={(e) => update({ site: e.target.value })} />
        <p className="field-hint">{info.siteHelp}</p>
      </div>
      {d.provider === 'vercel' && (
        <>
          <div className="field">
            <label className="field-label" htmlFor="pt-team">Team id (optional)</label>
            <input id="pt-team" className="input mono" value={d.teamId} spellCheck={false} placeholder="team_…" onChange={(e) => update({ teamId: e.target.value })} />
            <p className="field-hint">Leave empty to publish to your personal account.</p>
          </div>
          <Toggle checked={d.production} onChange={(v) => update({ production: v })} label="Publish to production" description="Off creates a preview deployment with its own address." />
        </>
      )}
      <div className="field">
        <label className="field-label" htmlFor="pt-token">Access token</label>
        <input id="pt-token" className="input mono" type="password" autoComplete="off" spellCheck={false} value={d.token} placeholder={d.id ? 'Leave empty to keep the current token' : ''} onChange={(e) => update({ token: e.target.value })} />
        <div className="radio-row" role="radiogroup" aria-label="Token storage">
          <label className={cx(!vault?.persistent && 'is-disabled')}>
            <input type="radio" name="pt-persist" checked={d.persistence === 'persistent'} disabled={!vault?.persistent} onChange={() => update({ persistence: 'persistent' })} /> Save securely
          </label>
          <label>
            <input type="radio" name="pt-persist" checked={d.persistence === 'session'} onChange={() => update({ persistence: 'session' })} /> This session only
          </label>
        </div>
        <p className="field-hint">
          {info.tokenHelp} {vault?.detail ?? ''} Publishing tokens are kept apart from AI keys and are never written to projects, exports, generated apps or logs.
        </p>
      </div>
      <details className="ai-advanced">
        <summary>Advanced</summary>
        <div className="field">
          <label className="field-label" htmlFor="pt-api">API address</label>
          <input id="pt-api" className="input mono" value={d.apiBase} spellCheck={false} placeholder={info.apiBase} onChange={(e) => update({ apiBase: e.target.value })} />
          <p className="field-hint">Only change this for a compatible test server. https:// is required unless it runs on this computer.</p>
        </div>
      </details>
      <div className="dialog-actions">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !d.name.trim() || (d.provider === 'vercel' && !d.site.trim()) || (!d.id && !d.token.trim())}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

function draftFor(provider: PublishProvider, persistent: boolean, t?: PublishTargetView): TargetDraft {
  return {
    id: t?.id,
    provider,
    name: t?.name ?? PUBLISH_PROVIDER_INFO[provider].label,
    site: t?.site ?? '',
    teamId: t?.teamId ?? '',
    apiBase: t && t.apiBase !== PUBLISH_PROVIDER_INFO[provider].apiBase ? t.apiBase : '',
    production: t?.production ?? true,
    token: '',
    persistence: persistent ? 'persistent' : 'session',
  };
}

const TOKEN_TEXT = { encrypted: 'Token saved securely', session: 'Token for this session only', none: 'No token' } as const;

export function PublishingSettings() {
  const targets = usePublish((s) => s.targets);
  const persistent = useAi((s) => s.ai?.vault.persistent ?? false);
  const [draft, setDraft] = useState<TargetDraft | null>(null);
  useEffect(() => {
    void loadTargets();
    void loadAiState();
  }, []);
  if (draft) return <TargetForm draft={draft} onDone={() => setDraft(null)} />;
  const remove = async (t: PublishTargetView): Promise<void> => {
    try {
      await call('publish.targets.remove', { id: t.id });
      await loadTargets();
      toast({ tone: 'info', title: `${t.name} removed`, body: 'Its token was deleted. Sites already published stay online.' });
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t remove it', body: errorMessage(error) });
    }
  };
  return (
    <div className="ai-settings">
      <p className="field-hint">Publishing sends one version’s files to a hosting service you choose. Nothing is published until you press Publish, and a publish counts as done only when the host confirms it.</p>
      {targets && targets.length > 0 && (
        <ul className="conn-list">
          {targets.map((t) => (
            <li key={t.id} className="conn-card">
              <div className="conn-main">
                <strong>{t.name}</strong>
                <span className="muted">
                  {PUBLISH_PROVIDER_INFO[t.provider].label} · {t.site || 'new site on first publish'}
                  {t.provider === 'vercel' ? (t.production ? ' · production' : ' · preview') : ''}
                </span>
                <span className={cx('muted', !t.hasToken && 'is-warning')}>{TOKEN_TEXT[t.tokenStorage]}</span>
              </div>
              <div className="conn-actions">
                <Button size="sm" onClick={() => setDraft(draftFor(t.provider, persistent, t))}>
                  Edit
                </Button>
                <Button size="sm" variant="danger" onClick={() => void remove(t)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <h3 className="ai-subhead">Add a destination</h3>
      <div className="preset-grid">
        {PUBLISH_PROVIDERS.map((p) => (
          <button key={p} type="button" className="preset-card" onClick={() => setDraft(draftFor(p, persistent))}>
            <strong>{PUBLISH_PROVIDER_INFO[p].label}</strong>
            <span>{p === 'netlify' ? 'Static site, ZIP deploy' : 'Static files, preview or production'}</span>
          </button>
        ))}
      </div>
      <p className="field-hint">Other hosts need an adapter in src/publish/hosts.ts. Until then, export the version as a folder or ZIP and upload it yourself.</p>
    </div>
  );
}

const STATE_TEXT: Record<DeployJobView['state'], string> = {
  queued: 'Waiting',
  packaging: 'Packaging',
  uploading: 'Uploading',
  processing: 'Host is processing',
  cancelling: 'Stopping',
  completed: 'Published',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
  uncertain: 'Result unknown',
};

function JobRow({ job, projectId }: { job: DeployJobView; projectId: string }) {
  const [confirm, setConfirm] = useState(false);
  const active = ACTIVE_DEPLOY.has(job.state);
  const tone = job.state === 'completed' ? 'is-ok' : job.state === 'failed' || job.state === 'uncertain' ? 'is-failed' : '';
  return (
    <li className="deploy-row" data-state={job.state}>
      <div className="deploy-main">
        <span className={cx('deploy-state', tone)}>
          {active ? <span className="spinner" aria-hidden /> : <Icon name={job.state === 'completed' ? 'check' : job.state === 'failed' || job.state === 'uncertain' ? 'warning' : 'info'} size={12} />}
          {STATE_TEXT[job.state]}
        </span>
        <span className="muted">
          {job.lineName}
          {job.folder ? ` · ${job.folder}/` : ''} → {job.targetName} · {plural(job.fileCount, 'file')}, {bytes(job.bytes)} · {relativeTime(job.createdAt)}
        </span>
        {job.url && job.state === 'completed' && (
          <button type="button" className="link-button mono" onClick={() => openUrl(job.url!)}>
            {job.url}
          </button>
        )}
        {job.state !== 'completed' && <span className="deploy-detail">{job.error ?? job.detail}</span>}
        {job.state === 'uncertain' && (
          <label className="check-row">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I checked {job.targetName} and this attempt did not publish
          </label>
        )}
      </div>
      <div className="conn-actions">
        {job.adminUrl && (
          <Button size="sm" variant="quiet" onClick={() => openUrl(job.adminUrl!)}>
            Host dashboard
          </Button>
        )}
        {job.remoteId && (job.state === 'interrupted' || job.state === 'uncertain' || job.state === 'processing') && (
          <Button size="sm" onClick={() => void jobAction(projectId, job.id, 'check')}>
            Check again
          </Button>
        )}
        {active && job.state !== 'cancelling' && (
          <Button size="sm" onClick={() => void jobAction(projectId, job.id, 'cancel')} title={job.remoteCancel ? 'Cancels the deploy at the host' : 'Stops waiting here; the host may still finish this deploy'}>
            {job.remoteCancel || !job.remoteId ? 'Stop' : 'Stop waiting'}
          </Button>
        )}
        {!active && job.state !== 'completed' && (
          <Button size="sm" disabled={job.state === 'uncertain' && !confirm} onClick={() => void jobAction(projectId, job.id, 'retry', confirm)}>
            Publish again
          </Button>
        )}
      </div>
    </li>
  );
}

export function PublishDialog({ from, project }: { from: ContentRef; project: ProjectView }) {
  const targets = usePublish((s) => s.targets);
  const jobs = usePublish((s) => s.jobs[project.id]) ?? [];
  const lines = allLines(project);
  const [lineId, setLineId] = useState(from.kind === 'line' ? from.lineId : (lines[0]?.id ?? ''));
  const [targetId, setTargetId] = useState('');
  const [folder, setFolder] = useState('');
  const [plan, setPlan] = useState<PublishPlanView | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void loadTargets();
    void loadJobs(project.id);
  }, [project.id]);
  useEffect(() => {
    if (!targetId && targets?.length) setTargetId(targets[0]!.id);
  }, [targets, targetId]);
  useEffect(() => {
    if (!targetId || !lineId) return;
    let live = true;
    setPlan(null);
    setPlanError(null);
    const timer = setTimeout(() => {
      call('publish.plan', { projectId: project.id, lineId, targetId, folder: folder.trim() || undefined }).then(
        (p) => live && setPlan(p),
        (e) => live && setPlanError(errorMessage(e)),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [project.id, lineId, targetId, folder]);
  const lineName = lines.find((l) => l.id === lineId)?.name ?? '';
  const publish = async (): Promise<void> => {
    setBusy(true);
    try {
      await call('publish.start', { projectId: project.id, lineId, targetId, folder: folder.trim() || undefined });
      await loadJobs(project.id);
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t start publishing', body: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  const running = jobs.some((j) => ACTIVE_DEPLOY.has(j.state) && j.lineId === lineId && j.targetId === targetId);
  if (targets && targets.length === 0) {
    return (
      <Dialog title="Publish" size="md" onClose={closeDialog}>
        <EmptyState icon="globe" title="No publishing destination yet" body="Add Netlify or Vercel with an access token. You choose what to publish and confirm each time.">
          <Button variant="primary" onClick={() => openDialog({ kind: 'settings', tab: 'publishing' })}>
            Add a destination
          </Button>
        </EmptyState>
      </Dialog>
    );
  }
  return (
    <Dialog
      title={`Publish ${lineName}`}
      description="Sends this version’s files to your hosting service. Project history, AI keys and app data are never included."
      size="lg"
      onClose={closeDialog}
      className="publish-dialog"
      footer={
        <>
          <Button variant="quiet" onClick={() => openDialog({ kind: 'settings', tab: 'publishing' })}>
            Destinations…
          </Button>
          <span className="spacer" />
          <Button variant="quiet" onClick={closeDialog}>
            Close
          </Button>
          <Button variant="primary" icon="globe" disabled={busy || running || !plan || !!plan.requirement} onClick={() => void publish()}>
            {busy ? 'Starting…' : running ? 'Publishing…' : 'Publish'}
          </Button>
        </>
      }
    >
      <div className="publish-grid">
        <div className="field">
          <label className="field-label" htmlFor="pub-line">Version</label>
          <select id="pub-line" className="input" value={lineId} onChange={(e) => setLineId(e.target.value)}>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pub-target">Destination</label>
          <select id="pub-target" className="input" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {(targets ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pub-folder">Folder to publish</label>
          <input id="pub-folder" className="input mono" list="pub-folders" value={folder} placeholder="Whole version" spellCheck={false} onChange={(e) => setFolder(e.target.value)} />
          <datalist id="pub-folders">
            {(plan?.folders ?? []).map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
      </div>
      <section className="publish-plan" aria-live="polite" aria-label="What will be published">
        {planError ? (
          <p className="publish-requirement" role="alert">
            <Icon name="warning" size={14} /> {planError}
          </p>
        ) : !plan ? (
          <p className="muted">Checking what would be published…</p>
        ) : (
          <>
            <dl className="publish-facts">
              <dt>Destination</dt>
              <dd>{plan.destination}</dd>
              <dt>Files</dt>
              <dd>
                {plural(plan.fileCount, 'file')}, {bytes(plan.bytes)}
              </dd>
            </dl>
            {plan.requirement && (
              <p className="publish-requirement" role="alert">
                <Icon name="warning" size={14} /> {plan.requirement}
                {plan.folders.length > 0 && !folder && (
                  <Button size="sm" onClick={() => setFolder(plan.folders[0]!)}>
                    Use {plan.folders[0]}/
                  </Button>
                )}
              </p>
            )}
            {plan.warnings.map((w) => (
              <p key={w} className="publish-warning">
                <Icon name="info" size={13} /> {w}
              </p>
            ))}
            {plan.excluded.length > 0 && (
              <details className="publish-excluded">
                <summary>{plural(plan.excluded.length, 'item')} left out on purpose</summary>
                <ul>
                  {plan.excluded.slice(0, 50).map((x) => (
                    <li key={x}>
                      <code>{x}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
      {jobs.length > 0 && (
        <section aria-label="Recent publishes">
          <h3 className="ai-subhead">Recent publishes</h3>
          <ul className="deploy-list">
            {jobs.slice(0, 8).map((j) => (
              <JobRow key={j.id} job={j} projectId={project.id} />
            ))}
          </ul>
        </section>
      )}
    </Dialog>
  );
}
