/** Settings: Tasks and permissions, Media tools and Storage. */
import { useCallback, useEffect, useState } from 'react';
import { useStudio, toast } from '../state/store';
import { useAi } from '../state/ai';
import { updateSettings } from '../state/actions';
import { call, errorMessage } from '../lib/api';
import { Button, SegmentedControl, Toggle } from '../components/primitives';
import { Icon } from '../components/Icon';
import { bytes, cx, plural, relativeTime } from '../lib/util';
import type { AppSettings } from '../../shared/types';
import type { VideoToolsView } from '../../shared/video';
import type { CacheCategory, StorageView } from '../../shared/storage';

const PERMISSIONS: { key: keyof AppSettings['taskPermissions']; label: string; description: string }[] = [
  { key: 'editAlternative', label: 'Edit files in the task’s alternative', description: 'Build tasks work in their own alternative, so the Shared draft and other versions are untouched until you combine.' },
  { key: 'runBuildAndTests', label: 'Run the project’s build and test scripts', description: 'Only scripts declared in package.json, run in a copy of the version.' },
  { key: 'installDependencies', label: 'Install dependencies', description: 'npm install downloads and runs package install scripts. Off means the task asks each time.' },
  { key: 'operatePreview', label: 'Use the preview (click, type, read the page)', description: 'Inside the task’s own preview only.' },
];

export function TasksSettings() {
  const settings = useStudio((s) => s.settings);
  const setDefaults = (patch: Partial<Pick<AppSettings, 'taskMode' | 'taskPermissions'>>): void => {
    void updateSettings(patch);
    useAi.setState((s) => ({ mode: patch.taskMode ?? s.mode, permissions: patch.taskPermissions ?? s.permissions }));
  };
  return (
    <div className="settings-grid">
      <div className="field">
        <span className="field-label">New tasks start in</span>
        <SegmentedControl
          label="Default task mode"
          options={[
            { value: 'ask', label: 'Ask' },
            { value: 'plan', label: 'Plan' },
            { value: 'build', label: 'Build' },
          ]}
          value={settings.taskMode}
          onChange={(v) => setDefaults({ taskMode: v })}
        />
        <p className="field-hint">Ask answers questions, Plan proposes changes for you to apply, Build edits an alternative and can run tools. You can change the mode for each task.</p>
      </div>
      <fieldset className="field">
        <legend className="field-label">Routine permissions for Build tasks</legend>
        {PERMISSIONS.map((p) => (
          <Toggle key={p.key} checked={settings.taskPermissions[p.key]} label={p.label} description={p.description} onChange={(v) => setDefaults({ taskPermissions: { ...settings.taskPermissions, [p.key]: v } })} />
        ))}
        <p className="field-hint">Always asked, whatever these say: publishing, purchases, anything outside the project, deleting outside the alternative, and new credentials or integrations.</p>
      </fieldset>
      <section className="field isolation-note" aria-labelledby="iso-h">
        <h3 id="iso-h" className="field-label">
          <Icon name="info" size={13} /> How commands run
        </h3>
        <p>
          Builds, dev servers and task commands run as your user account, in a copy of the version under the cache folder. Programs start directly with separate arguments (no shell), with a cleaned environment: variables whose names look like keys, tokens or passwords are removed, and AI and publishing credentials are never passed in.
        </p>
        <p>
          This is <strong>not a sandbox</strong>. A working folder is not a security boundary: a script can still read your files and use the network like any program you run. Run code you trust, and keep “Install dependencies” off for projects you have not reviewed.
        </p>
      </section>
    </div>
  );
}

export function MediaToolsSettings() {
  const [tools, setTools] = useState<VideoToolsView | null>(null);
  useEffect(() => {
    void call('video.tools', {}).then(setTools, () => setTools(null));
  }, []);
  return (
    <div className="settings-grid">
      <div className={cx('vault-banner', tools?.available ? 'is-secure' : 'is-session')} role="status">
        <Icon name={tools?.available ? 'check' : 'warning'} size={14} />
        {tools === null ? ' Checking…' : tools.available ? ` FFmpeg ${tools.version ?? ''} is ready.` : ` ${tools.message ?? 'FFmpeg is not available.'}`}
      </div>
      {tools && (
        <dl className="publish-facts">
          <dt>ffmpeg</dt>
          <dd className="mono">{tools.ffmpeg ?? 'not found'}</dd>
          <dt>ffprobe</dt>
          <dd className="mono">{tools.ffprobe ?? 'not found'}</dd>
        </dl>
      )}
      <div className="field">
        <span className="field-label">Where FFmpeg is looked for</span>
        <ol className="plain-list">
          <li>
            The <code>MV_FFMPEG</code> and <code>MV_FFPROBE</code> environment variables (full paths).
          </li>
          <li>
            A copy bundled with the app in <code>resources/bin</code>.
          </li>
          <li>Your system PATH (for example after installing FFmpeg with winget, Homebrew or your package manager).</li>
        </ol>
        <p className="field-hint">Restart the app after installing FFmpeg. Without it, websites and code work normally; importing, previewing and exporting video does not.</p>
      </div>
      <div className="field">
        <span className="field-label">Formats</span>
        <p className="field-hint">
          Import: MP4, MOV, M4V, WebM, MKV, AVI; MP3, M4A, AAC, WAV, OGG, Opus, FLAC; PNG, JPEG, WebP, GIF; TTF, OTF, WOFF, WOFF2 fonts. Media the preview can’t play directly (for example HEVC or ProRes) gets a playback proxy; the original is always used for export. Export: MP4 (H.264 + AAC) and WebM (VP9 + Opus).
        </p>
      </div>
    </div>
  );
}

const LOCATION_LABEL: Record<CacheCategory, string> = { media: 'media', exports: 'exports', runs: 'runs', recordings: 'recordings', temp: 'temp' };

export function StorageSettings() {
  const [view, setView] = useState<StorageView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const project = useStudio((s) => s.project);
  const refresh = useCallback(async () => {
    try {
      setView(await call('storage.usage', {}));
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t measure storage', body: errorMessage(error) });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const [confirming, setConfirming] = useState<CacheCategory | null>(null);
  const clean = async (id: CacheCategory, label: string): Promise<void> => {
    setConfirming(null);
    setBusy(id);
    try {
      const r = await call('storage.clean', { category: id });
      toast({ tone: 'success', title: `Cleared ${label.toLowerCase()}`, body: `${bytes(r.freed)} freed.` });
      setView(r.view);
    } catch (error) {
      toast({ tone: 'error', title: 'Not cleared', body: errorMessage(error) });
      void refresh();
    } finally {
      setBusy(null);
    }
  };
  const compact = async (projectId: string): Promise<void> => {
    setBusy(projectId);
    try {
      const r = await call('storage.compact', { projectId });
      toast({ tone: 'success', title: 'History tidied', body: r.objects || r.revisions ? `Removed ${plural(r.objects, 'unused object')} and ${plural(r.revisions, 'unused revision')} (${bytes(r.freed)}).` : 'Nothing unused was found.' });
      setView(r.view);
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t tidy history', body: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };
  if (!view) return <p className="muted">Measuring…</p>;
  const cacheTotal = view.categories.reduce((n, c) => n + c.bytes, 0);
  return (
    <div className="settings-grid storage-settings">
      <section aria-labelledby="cache-h">
        <h3 id="cache-h" className="ai-subhead">
          Cache · {bytes(cacheTotal)}
        </h3>
        <p className="field-hint">
          In <code className="path-inline">{view.cacheRoot}</code>. Everything here can be deleted and is made again when needed.
        </p>
        <ul className="conn-list">
          {view.categories.map((c) => (
            <li key={c.id} className="conn-card" data-category={LOCATION_LABEL[c.id]}>
              <div className="conn-main">
                <strong>
                  {c.label} · {bytes(c.bytes)}
                </strong>
                <span className="muted">{c.detail}</span>
                {c.blocked && <span className="muted is-warning">{c.blocked}</span>}
              </div>
              <div className="conn-actions">
                {confirming === c.id ? (
                  <>
                    <Button size="sm" variant="quiet" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => void clean(c.id, c.label)} aria-label={`Clear ${c.label}, ${bytes(c.bytes)}`}>
                      Clear {bytes(c.bytes)}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" disabled={busy !== null || !!c.blocked || c.bytes === 0} onClick={() => setConfirming(c.id)}>
                    {busy === c.id ? 'Clearing…' : 'Clear'}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="proj-h">
        <h3 id="proj-h" className="ai-subhead">Projects</h3>
        <p className="field-hint">
          In <code className="path-inline">{view.workspacePath}</code>. History keeps every version, checkpoint and undo step; media originals are the files you imported, stored once by content. Neither is removed by clearing the cache.
        </p>
        <ul className="conn-list">
          {view.projects.map((p) => (
            <li key={p.id} className="conn-card">
              <div className="conn-main">
                <strong>{p.name}</strong>
                {p.available ? (
                  <span className="muted">
                    History {bytes(p.historyBytes)} · Media originals {bytes(p.mediaBytes)} · Other {bytes(p.otherBytes)}
                  </span>
                ) : (
                  <span className="muted is-warning">The working copy is missing.</span>
                )}
              </div>
              <div className="conn-actions">
                {p.available && (
                  <Button size="sm" disabled={busy !== null} onClick={() => void compact(p.id)} title="Removes objects no version, checkpoint or undo step refers to">
                    {busy === p.id ? 'Tidying…' : 'Tidy history'}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {project && <p className="field-hint">Missing media files can be relinked from Assets: select the item marked missing and choose Relink.</p>}
      </section>
      <p className="field-hint">
        Measured {relativeTime(view.measuredAt)}.{' '}
        <button type="button" className="link-button" onClick={() => void refresh()}>
          Measure again
        </button>
      </p>
    </div>
  );
}
