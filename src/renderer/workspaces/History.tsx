import { useEffect, useMemo, useState } from 'react';
import { toast } from '../state/store';
import { useActivity } from '../state/activity';
import type { ActivityRecord } from '../../shared/activity';
import { useStudio, set, openDialog } from '../state/store';
import { startCompare, undoOperation } from '../state/actions';
import { call, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { PreviewFrame } from '../components/PreviewFrame';
import { Button, ColorDot, EmptyState, FileStatusIcon, InspectorSection } from '../components/primitives';
import { Icon } from '../components/Icon';
import { clockTime, cx, dayLabel, lineRef, plural, relativeTime } from '../lib/util';
import type { ContentRef, HistoryEntry } from '../../shared/types';

const KIND_ICONS: Record<string, string> = {
  import: 'layers',
  edit: 'pencil',
  'shared-save': 'shared',
  'shared-apply': 'sync',
  'shared-partial': 'conflict',
  resolution: 'check',
  create: 'branch',
  combine: 'combine',
  restore: 'restore',
  reset: 'restore',
  undo: 'undo',
};

function useHistory() {
  const project = useStudio((s) => s.project)!;
  const [filter, setFilter] = useState<string>('all');
  const entries = useAsync(() => call('history.list', { projectId: project.id, lineId: filter === 'all' ? undefined : filter, limit: 600 }), [project.id, filter, project.updatedAt]);
  return { project, filter, setFilter, entries };
}

function entryRef(entry: HistoryEntry, project: { checkpoints: { id: string; lines: { lineId: string }[] }[] }, preferredLine: string): ContentRef | null {
  if (entry.revisionId) return { kind: 'revision', revisionId: entry.revisionId };
  if (entry.checkpointId) {
    const cp = project.checkpoints.find((c) => c.id === entry.checkpointId);
    const lineId = cp?.lines.find((l) => l.lineId === preferredLine)?.lineId ?? cp?.lines[0]?.lineId;
    if (lineId) return { kind: 'checkpoint', checkpointId: entry.checkpointId, lineId };
  }
  return null;
}

export function History() {
  const { project, filter, setFilter, entries } = useHistory();
  const selection = useStudio((s) => s.historySelection);
  const selectedLineId = useStudio((s) => s.selectedLineId);
  const [previewLine, setPreviewLine] = useState<string | null>(null);
  const selected = entries.data?.find((e) => e.id === selection) ?? null;
  const groups = useMemo(() => {
    const map = new Map<string, HistoryEntry[]>();
    for (const e of entries.data ?? []) {
      const key = dayLabel(e.createdAt);
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return [...map.entries()];
  }, [entries.data]);
  const ref = selected ? entryRef(selected, project, previewLine ?? selectedLineId) : null;
  const cp = selected?.checkpointId ? project.checkpoints.find((c) => c.id === selected.checkpointId) : null;

  return (
    <div className="history">
      <div className="workspace-bar">
        <h1 className="workspace-title" data-text="History">History</h1>
        <label className="sr-only" htmlFor="history-filter">
          Show history for
        </label>
        <select id="history-filter" className="input select-sm" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All versions</option>
          <option value={project.shared.id}>Shared version</option>
          {project.alternatives.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="bar-spacer" />
        <Button size="sm" icon="checkpoint" onClick={() => openDialog({ kind: 'checkpoint' })}>
          Create checkpoint
        </Button>
      </div>
      <div className="history-body">
        <div className="timeline material-solid" role="list" aria-label="History timeline">
          {entries.loading && !entries.data && <div className="editor-loading" />}
          {groups.map(([day, list]) => (
            <div key={day} className="timeline-day" role="presentation">
              <h2 className="timeline-day-title">{day}</h2>
              {list.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="listitem"
                  className={cx('timeline-entry', e.type === 'checkpoint' && 'is-checkpoint', selection === e.id && 'is-selected')}
                  style={{ ['--line-color' as string]: `var(--alt-${e.color})` }}
                  onClick={() => set({ historySelection: e.id })}
                  aria-current={selection === e.id ? 'true' : undefined}
                >
                  <span className="timeline-dot">
                    <Icon name={e.type === 'checkpoint' ? 'checkpoint' : KIND_ICONS[e.kind] ?? 'dot'} size={14} />
                  </span>
                  <span className="timeline-text">
                    <span className="timeline-title">
                      {e.title}
                      {e.type === 'checkpoint' && e.kind !== 'manual' && <span className="auto-tag">automatic</span>}
                    </span>
                    <span className="timeline-detail">{e.type === 'revision' ? e.detail : e.detail || 'Snapshot of every version'}</span>
                    <span className="timeline-meta">
                      {e.type === 'revision' && (
                        <>
                          <ColorDot color={e.color} shared={e.color === 'shared'} size={8} /> {e.lineName} ·{' '}
                        </>
                      )}
                      {clockTime(e.createdAt)}
                      {e.files.length > 0 && ` · ${plural(e.files.length, 'file')}`}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))}
          {entries.data && entries.data.length === 0 && <EmptyState icon="history" title="No history yet" />}
        </div>
        <div className="history-preview">
          {selected && ref ? (
            <>
              <div className="preview-bar">
                <strong>{selected.title}</strong>
                <span className="muted small">{relativeTime(selected.createdAt)}</span>
                {cp && (
                  <select className="input select-sm" aria-label="Version to preview" value={ref.kind === 'checkpoint' ? ref.lineId : ''} onChange={(e) => setPreviewLine(e.target.value)}>
                    {cp.lines.map((l) => (
                      <option key={l.lineId} value={l.lineId}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                )}
                <span className="bar-spacer" />
                <span className="muted small">Read-only</span>
              </div>
              <div className="history-frame">
                <PreviewFrame projectId={project.id} contentRef={ref} viewport="desktop" interactive title={`${selected.title} preview`} />
              </div>
            </>
          ) : (
            <EmptyState icon="history" title="Choose a moment" body="Select a checkpoint or change to preview it, create an alternative from it, or restore it." />
          )}
        </div>
      </div>
    </div>
  );
}

export function HistoryInspector() {
  const project = useStudio((s) => s.project)!;
  const selection = useStudio((s) => s.historySelection);
  const entries = useAsync(() => call('history.list', { projectId: project.id, limit: 600 }), [project.id, project.updatedAt]);
  const selected = entries.data?.find((e) => e.id === selection) ?? null;
  const details = useAsync(() => call('history.checkpoint', { projectId: project.id, checkpointId: selected!.checkpointId! }), [project.id, selected?.checkpointId, project.updatedAt], Boolean(selected?.checkpointId));
  const undoable = project.operations.filter((o) => o.canUndo).slice(0, 4);

  return (
    <>
      <div className="inspector-title">
        <Icon name="history" size={18} />
        <div>
          <h2>History</h2>
          <p className="muted">Every change is kept. Restoring adds a new step; it never erases later work.</p>
        </div>
      </div>
      {!selected && (
        <InspectorSection title="Checkpoints">
          <p className="inspector-text">Checkpoints are named snapshots of every version. One is created automatically before each combination and restore.</p>
        </InspectorSection>
      )}
      {selected?.type === 'checkpoint' && details.data && (
        <>
          <InspectorSection title={selected.title}>
            <p className="inspector-text muted">
              {new Date(selected.createdAt).toLocaleString()}
              {details.data.checkpoint.description && ` · ${details.data.checkpoint.description}`}
            </p>
            <ul className="cp-lines">
              {details.data.lines.map((l) => (
                <li key={l.lineId}>
                  <div className="cp-line-head">
                    <ColorDot color={l.color} shared={l.kind === 'shared'} />
                    <strong>{l.name}</strong>
                    {!l.exists && <span className="muted small">deleted since</span>}
                  </div>
                  <p className="muted small">
                    {l.changedSincePrevious.length === 0 ? 'No changes since the previous checkpoint' : `${plural(l.changedSincePrevious.length, 'file')} changed since the previous checkpoint`}
                    {l.exists && ` · ${l.differsFromCurrent.length === 0 ? 'same as now' : `${plural(l.differsFromCurrent.length, 'file')} differ from now`}`}
                  </p>
                  {l.changedSincePrevious.length > 0 && (
                    <ul className="file-mini">
                      {l.changedSincePrevious.slice(0, 6).map((f) => (
                        <li key={f.path}>
                          <FileStatusIcon status={f.status} /> {f.path}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="inline-actions">
                    <Button size="sm" variant="quiet" icon="branch" onClick={() => openDialog({ kind: 'create-alternative', from: { kind: 'checkpoint', checkpointId: selected.checkpointId!, lineId: l.lineId }, suggestedName: `${l.name} from ${selected.title}`.slice(0, 60) })}>
                      New alternative
                    </Button>
                    {l.exists && l.differsFromCurrent.length > 0 && (
                      <Button size="sm" variant="quiet" icon="compare" onClick={() => startCompare({ kind: 'checkpoint', checkpointId: selected.checkpointId!, lineId: l.lineId }, lineRef(l.lineId))}>
                        Compare with now
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </InspectorSection>
          <InspectorSection title="Restore">
            <p className="inspector-text muted">Restoring brings back this content as a new step. You’ll see exactly what changes first.</p>
            <Button
              variant="danger"
              icon="restore"
              onClick={() => openDialog({ kind: 'restore', checkpointId: selected.checkpointId!, lineIds: details.data!.lines.filter((l) => l.exists && l.differsFromCurrent.length > 0).map((l) => l.lineId) })}
            >
              Restore…
            </Button>
          </InspectorSection>
        </>
      )}
      {selected?.type === 'revision' && (
        <InspectorSection title={selected.title}>
          <p className="inspector-text">{selected.detail}</p>
          <p className="muted small">
            {selected.lineName} · {new Date(selected.createdAt).toLocaleString()}
          </p>
          {selected.files.length > 0 && (
            <ul className="file-mini">
              {selected.files.slice(0, 20).map((f) => (
                <li key={f.path}>
                  <FileStatusIcon status={f.status} /> {f.path}
                </li>
              ))}
            </ul>
          )}
          {selected.lineId && project.alternatives.concat(project.shared).some((l) => l.id === selected.lineId) && (
            <Button size="sm" variant="quiet" icon="compare" onClick={() => startCompare({ kind: 'revision', revisionId: selected.revisionId! }, lineRef(selected.lineId!))}>
              Compare with now
            </Button>
          )}
        </InspectorSection>
      )}
      <ActivitySection projectId={project.id} />
      {undoable.length > 0 && (
        <InspectorSection title="Undo recent actions">
          <ul className="mini-ops">
            {undoable.map((op) => (
              <li key={op.id}>
                <span>{op.summary}</span>
                <Button size="sm" variant="quiet" icon="undo" onClick={() => void undoOperation(op.id)}>
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
    </>
  );
}

const ACTOR_LABEL = { user: 'You', 'ai-task': 'AI task', 'ai-app': 'AI app' } as const;

/** Every command run on the project — by you or an AI task — newest first. */
function ActivitySection({ projectId }: { projectId: string }) {
  const project = useStudio((s) => s.project);
  const [items, setItems] = useState<ActivityRecord[] | null>(null);
  const [all, setAll] = useState(false);
  const revision = useActivity((s) => s.revision);
  useEffect(() => {
    let live = true;
    void call('ops.activity', { projectId, limit: 60 }).then((r) => live && setItems(r), () => live && setItems([]));
    return () => {
      live = false;
    };
  }, [projectId, revision, project?.updatedAt]);
  if (!items || items.length === 0) return null;
  const names = new Map([[project?.shared.id ?? 'shared', project?.shared.name ?? 'Shared'], ...(project?.alternatives ?? []).map((a) => [a.id, a.name] as [string, string])]);
  const shown = all ? items : items.slice(0, 8);
  const undo = async (r: ActivityRecord): Promise<void> => {
    try {
      await call('ops.undo', { projectId, activityId: r.id });
      toast({ tone: 'info', title: 'Undone', body: r.summary });
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t undo', body: errorMessage(error) });
    }
  };
  return (
    <InspectorSection title="Activity">
      <ul className="activity-list">
        {shown.map((r) => (
          <li key={r.id} className={cx('activity-item', !r.ok && 'is-failed')}>
            <span className={cx('activity-actor', r.actor !== 'user' && 'is-ai')}>{r.actor === 'ai-app' ? (r.via ?? ACTOR_LABEL['ai-app']) : ACTOR_LABEL[r.actor]}</span>
            <span className="activity-text">
              <span>{r.summary}</span>
              <span className="muted small">
                <code>{r.type}</code>
                {r.universeId ? ` · ${names.get(r.universeId) ?? 'deleted universe'}` : ''} · {relativeTime(r.at)}
              </span>
            </span>
            {r.ok && r.undo && (r.undo.kind === 'operation' || r.undo.kind === 'inverse') && (
              <Button size="sm" variant="quiet" icon="undo" onClick={() => void undo(r)} aria-label={`${r.undo.label}: ${r.summary}`}>
                Undo
              </Button>
            )}
          </li>
        ))}
      </ul>
      {items.length > 8 && (
        <button type="button" className="link-button" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </InspectorSection>
  );
}
