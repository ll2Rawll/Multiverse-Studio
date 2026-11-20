import { useEffect, useState } from 'react';
import { useStudio, set, openDialog } from '../state/store';
import { confirmDeleteAlternative, discardSharedDraft, duplicateAlternative, exportRef, publishRef, saveShared, setFollowing, setWorkspace, startCompare, undoOperation, updateAlternative, updateSettings } from '../state/actions';
import { Button, ColorDot, InspectorSection, StatusBadge, Toggle } from '../components/primitives';
import { Icon } from '../components/Icon';
import { Splitter } from '../components/Splitter';
import { HistoryInspector } from '../workspaces/History';
import { CompareInspector } from '../workspaces/CompareCombine';
import { cx, lineRef, plural, relativeTime, statusText } from '../lib/util';
import { ALTERNATIVE_COLORS, SHARED_LINE_ID, type LineView, type ProjectView } from '../../shared/types';
import { SegmentedControl } from '../components/primitives';
import { setPanel, useAi, type RightPanel } from '../state/ai';
import { AssistantPanel } from '../assistant/AssistantPanel';
import { TasksPanel } from '../assistant/TasksPanel';

const PANELS: { value: RightPanel; label: string }[] = [
  { value: 'assistant', label: 'Assistant' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'inspector', label: 'Inspector' },
];

function lineage(line: LineView): string {
  const c = line.createdFrom;
  switch (c.kind) {
    case 'shared':
      return 'Created from the Shared version';
    case 'alternative':
      return `Created from ${c.lineName ?? 'another alternative'}`;
    case 'checkpoint':
      return `Created from ${c.lineName ?? 'a version'} at checkpoint “${c.checkpointName ?? ''}”`;
    case 'combine':
      return `Created by combining${c.lineName ? ` (based on ${c.lineName})` : ''}`;
    default:
      return 'Imported';
  }
}

function SharedInspector({ project }: { project: ProjectView }) {
  const report = useStudio((s) => s.lastReport);
  const shared = project.shared;
  const followers = project.alternatives.filter((a) => a.following);
  const undoable = project.operations.filter((o) => o.canUndo).slice(0, 3);
  return (
    <>
      <div className="inspector-title">
        <ColorDot color="shared" shared size={14} />
        <div>
          <h2>Shared version</h2>
          <p className="muted">The common base for every alternative.</p>
        </div>
      </div>
      <InspectorSection title="How shared changes work">
        <p className="inspector-text">
          Edit here, then <strong>Save shared change</strong>. Alternatives that follow shared changes take it in automatically; their own differences are kept, and overlapping edits wait for your decision.
        </p>
      </InspectorSection>
      <InspectorSection title={shared.hasDraft ? 'Unsaved shared draft' : 'Draft'}>
        {shared.hasDraft ? (
          <>
            <ul className="plain-list">
              {shared.draftFiles.map((f) => (
                <li key={f}>
                  <Icon name="pencil" size={13} /> {f}
                </li>
              ))}
            </ul>
            <div className="inspector-actions">
              <Button variant="shared" icon="check" onClick={() => void saveShared()}>
                Save shared change
              </Button>
              <Button variant="quiet" onClick={() => openDialog({ kind: 'confirm', title: 'Discard the shared draft?', body: 'Unsaved shared edits will be removed.', confirmLabel: 'Discard', destructive: true, onConfirm: () => discardSharedDraft() })}>
                Discard
              </Button>
            </div>
          </>
        ) : (
          <p className="inspector-text muted">No unsaved edits. Your draft is kept even if you close the app.</p>
        )}
      </InspectorSection>
      <InspectorSection title={`Following · ${followers.length} of ${project.alternatives.length}`}>
        <ul className="mini-lines">
          {project.alternatives.map((a) => (
            <li key={a.id}>
              <ColorDot color={a.color} />
              <span className="mini-name">{a.name}</span>
              <StatusBadge line={a} compact />
            </li>
          ))}
        </ul>
      </InspectorSection>
      {report && (
        <InspectorSection title="Last shared change">
          <ul className="mini-lines">
            {report.lines.map((l) => (
              <li key={l.lineId}>
                <Icon name={l.outcome === 'applied' ? 'check' : l.outcome === 'conflicted' ? 'conflict' : l.outcome === 'paused' ? 'pause' : 'dot'} size={13} />
                <span className="mini-name">{l.name}</span>
                <span className="muted small">
                  {l.outcome === 'applied' ? `applied · ${plural(l.appliedFiles.length, 'file')}` : l.outcome === 'conflicted' ? plural(l.conflictCount, 'conflict') : l.outcome}
                </span>
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      {undoable.length > 0 && (
        <InspectorSection title="Recent actions">
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

function AlternativeInspector({ project, line }: { project: ProjectView; line: LineView }) {
  const [name, setName] = useState(line.name);
  const [description, setDescription] = useState(line.description);
  useEffect(() => {
    setName(line.name);
    setDescription(line.description);
  }, [line.id, line.name, line.description]);
  const undoable = project.operations.filter((o) => o.canUndo && o.lineId === line.id).slice(0, 2);
  return (
    <>
      <div className="inspector-title" style={{ ['--line-color' as string]: `var(--alt-${line.color})` }}>
        <ColorDot color={line.color} size={14} />
        <div className="inspector-name">
          <label className="sr-only" htmlFor="alt-name">
            Alternative name
          </label>
          <input
            id="alt-name"
            className="title-input"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== line.name && void updateAlternative(line.id, { name: name.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <p className="muted small">{lineage(line)} · {relativeTime(line.createdAt)}</p>
        </div>
      </div>

      <InspectorSection title="Status">
        <p className={cx('status-line', line.status === 'conflicted' && 'is-danger')}>
          <StatusBadge line={line} />
        </p>
        {line.status === 'conflicted' && (
          <>
            <p className="inspector-text">
              A shared change overlaps edits made here. The preview shows the last coherent version until you decide.
              {line.hasQueuedSharedChanges && ' Newer shared changes are waiting and will be applied after you finish.'}
            </p>
            <Button variant="primary" icon="conflict" onClick={() => openDialog({ kind: 'conflicts', lineId: line.id })}>
              Resolve {plural(line.conflictCount, 'conflict')}
            </Button>
          </>
        )}
        {line.status === 'behind' && (
          <Button icon="sync" onClick={() => void setFollowing(line.id, true)}>
            Apply {plural(line.sharedChangesBehind, 'shared change')}
          </Button>
        )}
        <p className="inspector-text muted">
          {line.differsFromShared === 0 ? 'Identical to the shared version it builds on.' : `Differs from the shared version in ${plural(line.differsFromShared, 'file')}.`}{' '}
          {line.differsFromShared > 0 && (
            <button type="button" className="link-btn" onClick={() => startCompare(lineRef(SHARED_LINE_ID), lineRef(line.id))}>
              Compare
            </button>
          )}
        </p>
      </InspectorSection>

      <InspectorSection title="Shared changes">
        <Toggle
          checked={line.following}
          onChange={(v) => void setFollowing(line.id, v)}
          label="Follow shared changes"
          description={
            line.following
              ? 'Saved shared changes are merged in automatically. Edits made here are kept.'
              : line.sharedChangesBehind > 0
                ? `Paused. ${plural(line.sharedChangesBehind, 'shared change')} will be reconciled when you resume.`
                : 'Paused. This alternative keeps its content as it is.'
          }
        />
      </InspectorSection>

      <InspectorSection title="Colour">
        <div className="swatches" role="radiogroup" aria-label="Alternative colour">
          {ALTERNATIVE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={line.color === c}
              aria-label={c}
              title={c}
              className={cx('swatch', line.color === c && 'is-selected')}
              style={{ background: `var(--alt-${c})` }}
              onClick={() => void updateAlternative(line.id, { color: c })}
            />
          ))}
        </div>
      </InspectorSection>

      <InspectorSection title="Description">
        <label className="sr-only" htmlFor="alt-desc">
          Description
        </label>
        <textarea
          id="alt-desc"
          className="input textarea"
          rows={3}
          maxLength={500}
          placeholder="What is this direction exploring?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== line.description && void updateAlternative(line.id, { description })}
        />
      </InspectorSection>

      {undoable.length > 0 && (
        <InspectorSection title="Recent actions">
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

      <InspectorSection title="Actions">
        <div className="inspector-action-list">
          <Button variant="quiet" icon="pencil" onClick={() => setWorkspace('build')}>
            Open in Build
          </Button>
          <Button variant="quiet" icon="copy" onClick={() => void duplicateAlternative(line.id)}>
            Duplicate
          </Button>
          <Button variant="quiet" icon="export" onClick={() => exportRef(lineRef(line.id), line.name)}>
            Export…
          </Button>
          <Button variant="quiet" icon="globe" onClick={() => publishRef(lineRef(line.id))}>
            Publish…
          </Button>
        </div>
        <div className="danger-zone">
          <Button variant="danger" size="sm" icon="trash" onClick={() => confirmDeleteAlternative(line.id, line.name)}>
            Delete alternative
          </Button>
        </div>
      </InspectorSection>
    </>
  );
}

export function Inspector() {
  const project = useStudio((s) => s.project)!;
  const workspace = useStudio((s) => s.workspace);
  const selectedLineId = useStudio((s) => s.selectedLineId);
  const width = useStudio((s) => s.settings.inspectorWidth);
  const collapsed = useStudio((s) => s.inspectorCollapsed);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const line = selectedLineId === SHARED_LINE_ID ? project.shared : project.alternatives.find((a) => a.id === selectedLineId);
  const panel = useAi((s) => s.panel);
  return (
    <aside className="inspector material-inspector" aria-label="Side panel" aria-hidden={collapsed} style={liveWidth ? { ['--inspector-w' as string]: `${liveWidth}px` } : undefined} inert={collapsed}>
      <Splitter
        className="inspector-splitter"
        label="Resize inspector"
        invert
        value={liveWidth ?? width}
        min={260}
        max={440}
        onChange={setLiveWidth}
        onCommit={(v) => {
          setLiveWidth(null);
          void updateSettings({ inspectorWidth: Math.round(v) });
        }}
      />
      <div className="panel-switch">
        <SegmentedControl label="Side panel" size="sm" options={PANELS} value={panel} onChange={setPanel} />
      </div>
      {panel === 'assistant' ? (
        <AssistantPanel />
      ) : panel === 'tasks' ? (
        <div className="inspector-scroll">
          <TasksPanel />
        </div>
      ) : (
      <div className="inspector-scroll" title={line ? statusText(line) : undefined}>
        {workspace === 'history' ? (
          <HistoryInspector />
        ) : workspace === 'compare' ? (
          <CompareInspector />
        ) : line?.kind === 'alternative' ? (
          <AlternativeInspector project={project} line={line} />
        ) : (
          <SharedInspector project={project} />
        )}
      </div>
      )}
      <button type="button" className="inspector-close sr-only-focusable" onClick={() => set({ inspectorCollapsed: true })}>
        Hide side panel
      </button>
    </aside>
  );
}
