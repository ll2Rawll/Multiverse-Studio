import { useEffect, useMemo, useState } from 'react';
import { useStudio, closeDialog, set, toast, type DialogState, type SettingsTab } from '../state/store';
import { ModelsTab, ProvidersTab, UsageTab } from '../assistant/AiSettings';
import { ConnectorSettings } from './ConnectorSettings';
import { TimelineDecisions } from '../components/TimelineViews';
import { PublishDialog, PublishingSettings } from './Publishing';
import { RecoveryDialog } from './Recovery';
import { MediaToolsSettings, StorageSettings, TasksSettings } from './SettingsTabs';
import { applyProject, announcePropagation, createAlternative, createCheckpoint, createFromTemplate, openProject, refreshRecent, run, setWorkspace, updateAlternative, updateSettings } from '../state/actions';
import { call, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Dialog } from '../components/Dialog';
import { Button, ColorDot, Field, FileStatusIcon, SegmentedControl, Toggle } from '../components/primitives';
import { ConflictChunk } from '../components/ConflictChunk';
import { Icon } from '../components/Icon';
import { allLines, bytes, cx, lineRef, plural } from '../lib/util';
import { ALTERNATIVE_COLORS, SHARED_LINE_ID, type AlternativeColor, type ConflictSetView, type ContentRef, type FileResolutionInput, type ProjectView } from '../../shared/types';

function sourceLabel(project: ProjectView, ref: ContentRef): string {
  if (ref.kind === 'line') return ref.lineId === SHARED_LINE_ID ? 'the Shared version' : allLines(project).find((l) => l.id === ref.lineId)?.name ?? 'an alternative';
  if (ref.kind === 'checkpoint') {
    const cp = project.checkpoints.find((c) => c.id === ref.checkpointId);
    const entry = cp?.lines.find((l) => l.lineId === ref.lineId);
    return `${entry?.name ?? 'a version'} at checkpoint “${cp?.name ?? ''}”`;
  }
  return 'an earlier version';
}

function CreateAlternativeDialog({ dialog, project }: { dialog: Extract<DialogState, { kind: 'create-alternative' }>; project: ProjectView }) {
  const used = new Set(project.alternatives.map((a) => a.color));
  const [name, setName] = useState(dialog.suggestedName ?? `Direction ${project.alternatives.length + 1}`);
  const [color, setColor] = useState<AlternativeColor>(ALTERNATIVE_COLORS.find((c) => !used.has(c)) ?? 'teal');
  const [description, setDescription] = useState('');
  const [following, setFollowing] = useState(true);
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    const id = await createAlternative({ from: dialog.from, name: name.trim(), color, description, following });
    setBusy(false);
    if (id) closeDialog();
  };
  return (
    <Dialog
      title="New alternative"
      description={<>Starts as an exact copy of {sourceLabel(project, dialog.from)}. Where it came from is recorded; later edits to the source don’t flow into it.</>}
      onClose={closeDialog}
      footer={
        <>
          <Button variant="quiet" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" icon="plus" disabled={!name.trim() || busy} onClick={() => void submit()}>
            Create alternative
          </Button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">{(id) => <input id={id} className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-autofocus />}</Field>
        <div className="field">
          <span className="field-label" id="color-label">
            Colour
          </span>
          <div className="swatches" role="radiogroup" aria-labelledby="color-label">
            {ALTERNATIVE_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} title={c} className={cx('swatch', color === c && 'is-selected')} style={{ background: `var(--alt-${c})` }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <Field label="Description (optional)">{(id) => <textarea id={id} className="input textarea" rows={2} maxLength={500} placeholder="What will this direction explore?" value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <Toggle checked={following} onChange={setFollowing} label="Follow shared changes" description="Saved changes to the Shared version are merged into this alternative automatically, keeping its own differences." />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function RenameDialog({ lineId, project }: { lineId: string; project: ProjectView }) {
  const line = project.alternatives.find((a) => a.id === lineId);
  const [name, setName] = useState(line?.name ?? '');
  if (!line) return null;
  const submit = async (): Promise<void> => {
    if (!name.trim()) return;
    await updateAlternative(lineId, { name: name.trim() });
    closeDialog();
  };
  return (
    <Dialog
      title={`Rename ${line.name}`}
      size="sm"
      onClose={closeDialog}
      footer={
        <>
          <Button variant="quiet" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void submit()}>
            Rename
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="Name">{(id) => <input id={id} className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-autofocus />}</Field>
      </form>
    </Dialog>
  );
}

const SETTINGS_TABS: { value: SettingsTab; label: string }[] = [
  { value: 'providers', label: 'Providers' },
  { value: 'models', label: 'Models' },
  { value: 'tasks', label: 'Tasks and permissions' },
  { value: 'usage', label: 'Usage and budgets' },
  { value: 'apps', label: 'AI apps' },
  { value: 'publishing', label: 'Publishing' },
  { value: 'appearance', label: 'Appearance' },
  { value: 'media', label: 'Media tools' },
  { value: 'storage', label: 'Storage' },
];

function GeneralSettings() {
  const settings = useStudio((s) => s.settings);
  const info = useStudio((s) => s.info);
  return (
    <div className="settings-grid">
      <div className="field">
        <span className="field-label">Appearance</span>
        <SegmentedControl label="Appearance" options={[{ value: 'dystopia', label: 'Dystopia' }, { value: 'dark', label: 'Graphite' }, { value: 'light', label: 'Pearl' }, { value: 'system', label: 'System' }]} value={settings.appearance} onChange={(v) => void updateSettings({ appearance: v })} />
      </div>
      <div className="field">
        <span className="field-label">Transparency</span>
        <SegmentedControl label="Transparency" options={[{ value: 'system', label: 'System' }, { value: 'full', label: 'Glass' }, { value: 'reduced', label: 'Solid' }]} value={settings.transparency} onChange={(v) => void updateSettings({ transparency: v })} />
        <p className="field-hint">Solid surfaces replace translucent glass everywhere.</p>
      </div>
      <div className="field">
        <span className="field-label">Motion</span>
        <SegmentedControl label="Motion" options={[{ value: 'system', label: 'System' }, { value: 'full', label: 'Full' }, { value: 'reduced', label: 'Reduced' }]} value={settings.motion} onChange={(v) => void updateSettings({ motion: v })} />
        <p className="field-hint">Also applies to the AI pointer and highlights: reduced motion shows them in place without moving.</p>
      </div>
      <div className="field">
        <span className="field-label">AI activity</span>
        <SegmentedControl label="AI activity visuals" options={[{ value: 'off', label: 'Off' }, { value: 'minimal', label: 'Minimal' }, { value: 'detailed', label: 'Detailed' }]} value={settings.activityVisuals} onChange={(v) => void updateSettings({ activityVisuals: v })} />
        <p className="field-hint">Minimal outlines what the AI is changing. Detailed also labels each change. The activity bar with Pause and Stop stays available either way.</p>
        <Toggle checked={settings.followAi} onChange={(v) => void updateSettings({ followAi: v })} label="Follow AI" description="Open the file, clip or page the AI is working on. Your previous view can be restored." />
        <Toggle checked={settings.activityLabels} onChange={(v) => void updateSettings({ activityLabels: v })} label="Label the AI pointer" description="Shows “AI” next to the pointer for browser interactions." />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="live-limit">
          Live previews at once: {settings.livePreviewLimit}
        </label>
        <input id="live-limit" type="range" min={1} max={12} value={settings.livePreviewLimit} onChange={(e) => void updateSettings({ livePreviewLimit: Number(e.target.value) })} />
        <p className="field-hint">Each live preview runs a full web page. Extra previews pause until you scroll to them or ask for them.</p>
      </div>
      {info && (
        <div className="field">
          <span className="field-label">Workspace</span>
          <code className="path-box">{info.workspacePath}</code>
          <p className="field-hint">Working copies and history are stored here. Your original folders are never changed.</p>
        </div>
      )}
    </div>
  );
}

function SettingsDialog({ initialTab }: { initialTab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'providers');
  return (
    <Dialog title="Settings" onClose={closeDialog} size="xl" className="settings-dialog">
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Settings sections">
          {SETTINGS_TABS.map((t) => (
            <button key={t.value} type="button" className={cx('settings-tab', tab === t.value && 'is-active')} aria-current={tab === t.value ? 'page' : undefined} onClick={() => setTab(t.value)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === 'appearance' ? (
            <GeneralSettings />
          ) : tab === 'providers' ? (
            <ProvidersTab />
          ) : tab === 'models' ? (
            <ModelsTab />
          ) : tab === 'tasks' ? (
            <TasksSettings />
          ) : tab === 'publishing' ? (
            <PublishingSettings />
          ) : tab === 'media' ? (
            <MediaToolsSettings />
          ) : tab === 'storage' ? (
            <StorageSettings />
          ) : tab === 'apps' ? (
            <ConnectorSettings />
          ) : (
            <UsageTab />
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ConflictsDialog({ lineId, project }: { lineId: string; project: ProjectView }) {
  const line = project.alternatives.find((a) => a.id === lineId);
  const [set_, setSet] = useState<ConflictSetView | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call('conflicts.get', { projectId: project.id, lineId }).then((s) => {
      setSet(s);
      setFile(s?.files.find((f) => (f.type === 'text' ? f.resolvedCount < f.conflictCount && !f.manualText : !f.choice))?.path ?? s?.files[0]?.path ?? null);
    });
  }, [lineId]);
  if (!line) return null;
  if (!set_) {
    return (
      <Dialog title={`Conflicts in ${line.name}`} onClose={closeDialog} size="xl">
        {set_ === null ? <p className="muted">Loading…</p> : null}
      </Dialog>
    );
  }
  const current = set_.files.find((f) => f.path === file) ?? null;
  const save = async (resolution: FileResolutionInput): Promise<void> => {
    try {
      setSet(await call('conflicts.saveResolution', { projectId: project.id, lineId, resolution }));
    } catch (error) {
      toast({ tone: 'error', title: 'Could not save that decision', body: errorMessage(error) });
    }
  };
  const finish = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await call('conflicts.complete', { projectId: project.id, lineId });
      applyProject(result.project);
      closeDialog();
      toast({ tone: 'success', title: `${line.name} is up to date`, body: 'Your decisions were applied and the shared change is now incorporated.' });
      if (result.report) announcePropagation(result.report);
    } catch (error) {
      toast({ tone: 'error', title: 'Could not finish', body: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Resolve conflicts in ${line.name}`}
      description={
        <>
          The shared change <strong>“{set_.sharedMessage}”</strong> changes the same {set_.files.every((f) => f.type === 'timeline') ? 'clips' : set_.files.some((f) => f.type === 'timeline') ? 'lines and clips' : 'lines'} {line.name} changed. Compatible parts were already applied. Decide each conflict below — your decisions are saved as you go.
          {set_.queuedSharedChanges && ' Newer shared changes are waiting and will be applied right after you finish.'}
        </>
      }
      onClose={closeDialog}
      size="xl"
      className="conflict-dialog"
      footer={
        <>
          <span className="muted small footer-note">{set_.unresolved === 0 ? 'Everything is decided.' : `${plural(set_.unresolved, 'decision')} left`}</span>
          <Button variant="quiet" onClick={closeDialog}>
            Continue later
          </Button>
          <Button variant="primary" icon="check" disabled={set_.unresolved > 0 || busy} onClick={() => void finish()}>
            Finish and apply
          </Button>
        </>
      }
    >
      <div className="conflict-layout">
        <nav className="conflict-files" aria-label="Files with conflicts">
          {set_.files.map((f) => {
            const done = f.type === 'text' ? f.manualText !== null || f.resolvedCount === f.conflictCount : f.type === 'timeline' ? f.choice !== null || f.resolvedCount === f.conflictCount : f.choice !== null;
            return (
              <button key={f.path} type="button" className={cx('conflict-file', f.path === file && 'is-selected', done && 'is-done')} onClick={() => (setFile(f.path), setManual(null))}>
                <Icon name={done ? 'check' : 'conflict'} size={14} />
                <span>{f.path}</span>
                <span className="muted small">{f.type === 'text' ? `${f.manualText !== null ? f.conflictCount : f.resolvedCount}/${f.conflictCount}` : f.type === 'timeline' ? `timeline ${f.resolvedCount}/${f.conflictCount}` : f.type === 'binary' ? 'binary' : 'deleted on one side'}</span>
              </button>
            );
          })}
        </nav>
        <div className="conflict-main">
          {current?.type === 'text' && manual === null && (
            <>
              <div className="conflict-file-head">
                <strong>{current.path}</strong>
                {current.addedOnBothSides && <span className="muted small">Added on both sides with different content.</span>}
                <span className="bar-spacer" />
                <Button size="sm" variant="quiet" icon="pencil" onClick={() => setManual(current.manualText ?? current.chunks.map((c) => (c.kind === 'stable' ? c.text : c.ours)).join(''))}>
                  Edit the whole file instead
                </Button>
              </div>
              {current.manualText !== null && <p className="info-banner">You wrote this file by hand. Choosing per conflict below replaces that.</p>}
              {current.chunks.map((c, i) =>
                c.kind === 'stable' ? (
                  <details key={`s${i}`} className="stable-chunk">
                    <summary className="muted small">
                      {plural(c.lineCount, 'unchanged line')} (lines {c.startLine}–{c.startLine + c.lineCount - 1})
                    </summary>
                    <pre className="code-block">{c.text}</pre>
                  </details>
                ) : (
                  <ConflictChunk key={`c${c.index}`} chunk={c} number={c.index + 1} oursLabel={line.name} theirsLabel="Shared" onResolve={(r) => void save({ path: current.path, type: 'chunks', resolutions: { [String(c.index)]: r } })} />
                ),
              )}
            </>
          )}
          {current?.type === 'text' && manual !== null && (
            <div className="conflict-custom">
              <label className="field-label" htmlFor="manual-file">
                {current.path} — final content
              </label>
              <textarea id="manual-file" className="input textarea code-textarea tall" value={manual} spellCheck={false} onChange={(e) => setManual(e.target.value)} />
              <div className="inline-actions">
                <Button variant="primary" onClick={() => void save({ path: current.path, type: 'manual', text: manual }).then(() => setManual(null))}>
                  Use this file
                </Button>
                <Button variant="quiet" onClick={() => setManual(null)}>
                  Back to conflicts
                </Button>
              </div>
            </div>
          )}
          {current?.type === 'timeline' && (
            <>
              <div className="conflict-file-head">
                <strong>
                  <Icon name="film" size={14} /> {current.sequenceName}
                </strong>
                <span className="muted small">{current.path}</span>
                <span className="bar-spacer" />
                <Button size="sm" variant="quiet" onClick={() => void save({ path: current.path, type: 'choice', choice: 'ours' })}>
                  Keep all of {line.name}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => void save({ path: current.path, type: 'choice', choice: 'theirs' })}>
                  Use all of Shared
                </Button>
              </div>
              {current.choice && <p className="info-banner">Using {current.choice === 'ours' ? `${line.name}’s` : 'the shared'} timeline as a whole. Choosing per item below replaces that.</p>}
              <TimelineDecisions items={current.items} taken={current.taken} oursLabel={line.name} theirsLabel="Shared" onChoose={(key, choice) => void save({ path: current.path, type: 'timeline', choices: { [key]: choice } })} />
            </>
          )}
          {current && current.type !== 'text' && current.type !== 'timeline' && (
            <div className="binary-choice">
              <p>
                {current.type === 'modify-delete'
                  ? current.deletedBy === 'theirs'
                    ? `The shared change deletes ${current.path}, but ${line.name} changed it.`
                    : `${line.name} deleted ${current.path}, but the shared change edits it.`
                  : `${current.path} changed on both sides and can’t be merged line by line.`}
              </p>
              <div className="conflict-sides">
                <button type="button" className={cx('choice-card', current.choice === 'ours' && 'is-chosen')} onClick={() => void save({ path: current.path, type: 'choice', choice: 'ours' })}>
                  <strong>Keep {line.name}’s version</strong>
                  <span className="muted small">{current.oursExists ? bytes(current.oursSize) : 'File stays deleted'}</span>
                </button>
                <button type="button" className={cx('choice-card', current.choice === 'theirs' && 'is-chosen')} onClick={() => void save({ path: current.path, type: 'choice', choice: 'theirs' })}>
                  <strong>Use the shared version</strong>
                  <span className="muted small">{current.theirsExists ? bytes(current.theirsSize) : 'File is deleted'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function RestoreDialog({ dialog, project }: { dialog: Extract<DialogState, { kind: 'restore' }>; project: ProjectView }) {
  const cp = project.checkpoints.find((c) => c.id === dialog.checkpointId);
  const [chosen, setChosen] = useState<Set<string>>(new Set(dialog.lineIds));
  const [busy, setBusy] = useState(false);
  const lines = cp?.lines.filter((l) => allLines(project).some((x) => x.id === l.lineId)) ?? [];
  const ids = [...chosen];
  const preview = useAsync(() => call('history.restorePreview', { projectId: project.id, checkpointId: dialog.checkpointId, lineIds: ids }), [ids.join(',')], ids.length > 0);
  if (!cp) return null;
  const blocked = preview.data?.lines.some((l) => l.blocked);
  const restore = async (): Promise<void> => {
    setBusy(true);
    const result = await run('Could not restore', () => call('history.restore', { projectId: project.id, checkpointId: dialog.checkpointId, lineIds: ids }));
    setBusy(false);
    if (!result) return;
    applyProject(result.project);
    closeDialog();
    toast({ tone: 'success', title: `Restored from “${cp.name}”`, body: 'The previous state was saved as a checkpoint, so this can be undone.' });
    if (result.report) announcePropagation(result.report);
  };
  return (
    <Dialog
      title={`Restore from “${cp.name}”`}
      description="Restoring adds a new step with the checkpoint’s content. Later history is kept, and a safety checkpoint is created first."
      onClose={closeDialog}
      size="lg"
      footer={
        <>
          <Button variant="quiet" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="danger" icon="restore" disabled={ids.length === 0 || blocked || busy} onClick={() => void restore()}>
            Restore {plural(ids.length, 'version')}
          </Button>
        </>
      }
    >
      <fieldset className="restore-lines">
        <legend className="field-label">Versions to restore</legend>
        {lines.map((l) => (
          <label key={l.lineId} className="check-row">
            <input type="checkbox" checked={chosen.has(l.lineId)} onChange={() => setChosen((s) => { const n = new Set(s); if (n.has(l.lineId)) n.delete(l.lineId); else n.add(l.lineId); return n; })} />
            <ColorDot color={l.color} shared={l.kind === 'shared'} /> {l.name}
          </label>
        ))}
      </fieldset>
      {preview.data?.lines.map((l) => (
        <div key={l.lineId} className="restore-preview">
          <h4>{l.name}</h4>
          {l.blocked && <p className="error-text">{l.blocked}</p>}
          {l.changes.length === 0 ? <p className="muted small">Already identical — nothing changes.</p> : (
            <ul className="file-mini">
              {l.changes.map((c) => (
                <li key={c.path}>
                  <FileStatusIcon status={c.status} /> {c.path}
                </li>
              ))}
            </ul>
          )}
          {l.note && <p className="info-banner">{l.note}</p>}
        </div>
      ))}
    </Dialog>
  );
}

function NewFromTemplateDialog({ templateId }: { templateId: string }) {
  const template = useStudio((s) => s.templates.find((t) => t.id === templateId));
  const [name, setName] = useState(template?.name ?? 'New project');
  const [busy, setBusy] = useState(false);
  if (!template) return null;
  const submit = async (): Promise<void> => {
    setBusy(true);
    const ok = await createFromTemplate(template.id, name.trim() || template.name);
    setBusy(false);
    if (ok) closeDialog();
  };
  return (
    <Dialog
      title={`New ${template.name.toLowerCase()}`}
      description={template.description}
      size="sm"
      onClose={closeDialog}
      footer={
        <>
          <Button variant="quiet" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" icon="plus" disabled={busy} onClick={() => void submit()}>
            Create project
          </Button>
        </>
      }
    >
      <form className="form-grid" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="Project name">{(id) => <input id={id} className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-autofocus />}</Field>
        <p className="muted small">
          {template.stack}.{' '}
          {template.needsInstall ? 'After creating it, install dependencies in Build (this downloads packages from the npm registry), then start the dev server.' : 'It previews right away; no installs needed.'}
        </p>
      </form>
    </Dialog>
  );
}

function CheckpointDialog() {
  const [name, setName] = useState(`Checkpoint ${new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
  const [description, setDescription] = useState('');
  const shared = useStudio((s) => s.project?.shared);
  const submit = async (): Promise<void> => {
    await createCheckpoint(name.trim() || 'Checkpoint', description);
    closeDialog();
  };
  return (
    <Dialog
      title="Create checkpoint"
      description="A named snapshot of the Shared version and every alternative."
      size="sm"
      onClose={closeDialog}
      footer={
        <>
          <Button variant="quiet" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" icon="checkpoint" onClick={() => void submit()}>
            Create checkpoint
          </Button>
        </>
      }
    >
      <form className="form-grid" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="Name">{(id) => <input id={id} className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-autofocus />}</Field>
        <Field label="Description (optional)">{(id) => <textarea id={id} className="input textarea" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        {shared?.hasDraft && <p className="info-banner">The unsaved Shared draft isn’t included until you save it.</p>}
      </form>
    </Dialog>
  );
}

function ExportDialog({ dialog, project }: { dialog: Extract<DialogState, { kind: 'export' }>; project: ProjectView }) {
  const [format, setFormat] = useState<'folder' | 'zip'>('folder');
  const [busy, setBusy] = useState(false);
  const host = useStudio((s) => s.info?.host);
  const [destination, setDestination] = useState('');
  const go = async (): Promise<void> => {
    setBusy(true);
    try {
      const report = await call('export.run', {
        projectId: project.id,
        ref: dialog.ref,
        format,
        suggestedName: `${project.name} - ${dialog.label}`,
        destination: host === 'browser-harness' ? destination : undefined,
      });
      if (!report) return;
      closeDialog();
      toast({
        tone: report.missingReferences.length ? 'warning' : 'success',
        title: `Exported ${dialog.label}`,
        body: `${plural(report.fileCount, 'file')} (${bytes(report.totalBytes)}) to ${report.destination}.${report.missingReferences.length ? ` ${plural(report.missingReferences.length, 'local reference')} point to missing files: ${report.missingReferences.slice(0, 3).map((m) => `${m.reference} in ${m.file}`).join('; ')}.` : ''}`,
        sticky: report.missingReferences.length > 0,
      });
    } catch (error) {
      toast({ tone: 'error', title: 'Export failed', body: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Export ${dialog.label}`}
      description="Writes the effective files as an ordinary static website. No history or app data is included."
      size="sm"
      onClose={closeDialog}
      footer={
        <>
          <Button variant="quiet" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" icon="export" disabled={busy || (host === 'browser-harness' && !destination)} onClick={() => void go()}>
            {busy ? 'Exporting…' : 'Export…'}
          </Button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Format</span>
        <SegmentedControl label="Export format" options={[{ value: 'folder', label: 'Folder', icon: 'folder' }, { value: 'zip', label: 'ZIP file', icon: 'file' }]} value={format} onChange={setFormat} />
      </div>
      {host === 'browser-harness' && (
        <Field label="Destination path (test harness)">{(id) => <input id={id} className="input" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="/tmp/export/site" />}</Field>
      )}
      <p className="field-hint">You’ll choose where to save it next. If a folder with that name exists, you’ll be asked before anything is replaced.</p>
    </Dialog>
  );
}

function QuickOpen({ project }: { project: ProjectView }) {
  const lineId = useStudio((s) => s.selectedLineId);
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const files = useAsync(() => call('files.list', { projectId: project.id, ref: lineRef(lineId) }), [project.id, lineId]);
  const matches = useMemo(() => {
    const needle = q.toLowerCase();
    const list = (files.data ?? []).map((f) => f.path);
    if (!needle) return list.slice(0, 50);
    const score = (p: string): number => {
      const lower = p.toLowerCase();
      if (lower.includes(needle)) return 100 - lower.indexOf(needle) - p.length / 100;
      let j = 0;
      for (const ch of lower) if (ch === needle[j]) j++;
      return j === needle.length ? 10 - p.length / 100 : -1;
    };
    return list.map((p) => [p, score(p)] as const).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 50);
  }, [q, files.data]);
  const open = (path: string): void => {
    set((s) => ({ selectedFile: { ...s.selectedFile, [lineId]: path } }));
    setWorkspace('build');
    closeDialog();
  };
  return (
    <Dialog title="Open file" size="md" onClose={closeDialog} className="quick-open">
      <input
        className="input"
        placeholder="Type to search files…"
        aria-label="File name"
        value={q}
        data-autofocus
        onChange={(e) => (setQ(e.target.value), setIndex(0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setIndex((i) => Math.min(matches.length - 1, i + 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
          if (e.key === 'Enter' && matches[index]) open(matches[index]!);
        }}
        role="combobox"
        aria-expanded="true"
        aria-controls="quick-open-list"
        aria-activedescendant={matches[index] ? `qo-${index}` : undefined}
      />
      <ul id="quick-open-list" className="quick-list" role="listbox">
        {matches.map((p, i) => (
          <li key={p} id={`qo-${i}`} role="option" aria-selected={i === index}>
            <button type="button" className={cx('quick-item', i === index && 'is-active')} onClick={() => open(p)} tabIndex={-1}>
              <Icon name="file" size={14} /> {p}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function NewFileDialog({ lineId, project }: { lineId: string; project: ProjectView }) {
  const [path, setPath] = useState('');
  const create = async (): Promise<void> => {
    const ext = path.split('.').pop()?.toLowerCase();
    const text = ext === 'html' ? '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title></title>\n</head>\n<body>\n\n</body>\n</html>\n' : '';
    const result = await run('Could not create the file', () => call('files.create', { projectId: project.id, lineId, path: path.trim(), text }));
    if (!result) return;
    set((s) => ({ selectedFile: { ...s.selectedFile, [lineId]: result.path } }));
    closeDialog();
  };
  return (
    <Dialog
      title="New file"
      size="sm"
      onClose={closeDialog}
      footer={
        <>
          <Button variant="quiet" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!path.trim()} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => (e.preventDefault(), void create())}>
        <Field label="Path" hint="For example about.html or css/extra.css">
          {(id) => <input id={id} className="input" value={path} onChange={(e) => setPath(e.target.value)} data-autofocus spellCheck={false} />}
        </Field>
      </form>
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useStudio((s) => s.dialog);
  const project = useStudio((s) => s.project);
  const info = useStudio((s) => s.info);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'create-alternative':
      return project ? <CreateAlternativeDialog dialog={dialog} project={project} /> : null;
    case 'rename-alternative':
      return project ? <RenameDialog lineId={dialog.lineId} project={project} /> : null;
    case 'settings':
      return <SettingsDialog initialTab={dialog.tab} />;
    case 'conflicts':
      return project ? <ConflictsDialog lineId={dialog.lineId} project={project} /> : null;
    case 'restore':
      return project ? <RestoreDialog dialog={dialog} project={project} /> : null;
    case 'checkpoint':
      return <CheckpointDialog />;
    case 'new-from-template':
      return <NewFromTemplateDialog templateId={dialog.templateId} />;
    case 'recovery':
      return <RecoveryDialog />;
    case 'publish':
      return project ? <PublishDialog from={dialog.ref} project={project} /> : null;
    case 'export':
      return project ? <ExportDialog dialog={dialog} project={project} /> : null;
    case 'quick-open':
      return project ? <QuickOpen project={project} /> : null;
    case 'new-file':
      return project ? <NewFileDialog lineId={dialog.lineId} project={project} /> : null;
    case 'confirm':
      return (
        <Dialog
          title={dialog.title}
          size="sm"
          onClose={closeDialog}
          footer={
            <>
              <Button variant="quiet" onClick={closeDialog} data-autofocus>
                Cancel
              </Button>
              <Button
                variant={dialog.destructive ? 'danger' : 'primary'}
                onClick={() => {
                  closeDialog();
                  void dialog.onConfirm();
                }}
              >
                {dialog.confirmLabel}
              </Button>
            </>
          }
        >
          <p>{dialog.body}</p>
        </Dialog>
      );
    case 'import-report':
      return (
        <Dialog title="Project imported" size="md" onClose={closeDialog} footer={<Button variant="primary" onClick={closeDialog}>Start exploring</Button>}>
          <p>
            {plural(dialog.fileCount, 'file')} were copied into Multiverse Studio’s workspace. <strong>Your original folder was not changed.</strong>
          </p>
          <div className="field">
            <span className="field-label">Working copy</span>
            <code className="path-box">{dialog.storagePath}</code>
          </div>
          <div className="field">
            <span className="field-label">Original folder</span>
            <code className="path-box">{dialog.originalPath}</code>
          </div>
          {dialog.skipped.length > 0 && (
            <details className="analysis-group">
              <summary>{plural(dialog.skipped.length, 'item')} not imported</summary>
              <ul className="file-mini">
                {dialog.skipped.slice(0, 50).map((s) => (
                  <li key={s.path}>
                    <code>{s.path}</code> — {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="muted small">Next: create alternatives from the Shared version to explore different directions.</p>
        </Dialog>
      );
    case 'project-info':
      return project ? (
        <Dialog title={project.name} size="md" onClose={closeDialog} footer={<Button onClick={() => void call('projects.reveal', { projectId: project.id }).catch(() => undefined)} icon="folder">Show working copy</Button>}>
          <div className="field">
            <span className="field-label">Working copy and history</span>
            <code className="path-box">{project.storagePath}</code>
          </div>
          {project.originalPath && (
            <div className="field">
              <span className="field-label">Imported from (never modified)</span>
              <code className="path-box">{project.originalPath}</code>
            </div>
          )}
          <p className="muted small">
            {plural(project.alternatives.length, 'alternative')} · {plural(project.checkpoints.length, 'checkpoint')} · {plural(project.sharedRevisionCount, 'shared revision')}
            {info ? ` · Workspace: ${info.workspacePath}` : ''}
          </p>
        </Dialog>
      ) : null;
    case 'damaged':
      return (
        <Dialog
          title="This project needs attention"
          size="md"
          onClose={closeDialog}
          footer={
            <>
              <Button
                variant="quiet"
                onClick={() =>
                  void call('projects.removeRecent', { projectId: dialog.projectId }).then(() => {
                    closeDialog();
                    void refreshRecent();
                  })
                }
              >
                Remove from Recent
              </Button>
              <Button variant="primary" onClick={() => (closeDialog(), void openProject(dialog.projectId))}>
                Try again
              </Button>
            </>
          }
        >
          <p>{dialog.message}</p>
          <p className="muted small">Nothing was deleted. File contents are stored separately from this metadata, so a backup or an earlier copy of the workspace folder can usually be recovered.</p>
          {dialog.details.length > 0 && (
            <details className="analysis-group" open>
              <summary>Details</summary>
              <ul className="file-mini">
                {dialog.details.map((d, i) => (
                  <li key={i}>
                    <code>{d}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Dialog>
      );
  }
}
