import { MultiverseHeading } from './MultiverseSwitch';
import { useEffect, useMemo, useState } from 'react';
import { useStudio, set, get, toast, type CombineDraft } from '../state/store';
import { applyProject, selectLine, setWorkspace, undoOperation } from '../state/actions';
import { call, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { PreviewFrame } from '../components/PreviewFrame';
import { DiffEditor } from '../editor/DiffEditor';
import { SequenceDiff, TimelineDecisions } from '../components/TimelineViews';
import { CodeEditor } from '../editor/CodeEditor';
import { ConflictChunk } from '../components/ConflictChunk';
import { Button, ColorDot, EmptyState, FileStatusIcon, IconButton, InspectorSection, SegmentedControl, Toggle } from '../components/primitives';
import { Menu, type MenuItem } from '../components/Menu';
import { Icon } from '../components/Icon';
import { VIEWPORT_OPTIONS } from './PreviewCard';
import { OutcomesView } from './Outcomes';
import { allLines, cx, lineRef, plural, refKey, sameRef } from '../lib/util';
import {
  ALTERNATIVE_COLORS,
  SHARED_LINE_ID,
  type CombinePlan,
  type CombineProposal,
  type ContentRef,
  type FileAction,
  type ProjectView,
  type SectionAnalysis,
  type SectionTarget,
  type ConflictChunkView,
} from '../../shared/types';

/* ---------------------------------------------------------------- */
/* Ref labels and pickers                                            */
/* ---------------------------------------------------------------- */

function refName(project: ProjectView, ref: ContentRef): { name: string; color: string; detail: string } {
  if (ref.kind === 'line') {
    const line = allLines(project).find((l) => l.id === ref.lineId);
    return { name: line?.name ?? 'Deleted', color: line?.color ?? 'shared', detail: line?.kind === 'shared' ? (line.hasDraft ? 'Current, with unsaved draft' : 'Current') : 'Current' };
  }
  if (ref.kind === 'checkpoint') {
    const cp = project.checkpoints.find((c) => c.id === ref.checkpointId);
    const entry = cp?.lines.find((l) => l.lineId === ref.lineId);
    return { name: entry?.name ?? 'Checkpoint', color: entry?.color ?? 'shared', detail: cp ? `Checkpoint “${cp.name}”` : 'Checkpoint' };
  }
  if (ref.kind === 'proposal') return { name: 'Proposed result', color: 'shared', detail: 'Not applied yet' };
  return { name: 'Earlier revision', color: 'shared', detail: '' };
}

function RefPicker({ project, value, onChange, label, includeCheckpoints = true, onlyAlternatives = false }: { project: ProjectView; value: ContentRef; onChange: (r: ContentRef) => void; label: string; includeCheckpoints?: boolean; onlyAlternatives?: boolean }) {
  const info = refName(project, value);
  const items: MenuItem[] = [
    { kind: 'heading', label: 'Current versions' },
    ...allLines(project)
      .filter((l) => !onlyAlternatives || l.kind === 'alternative')
      .map((l) => ({ label: l.name, icon: l.kind === 'shared' ? 'shared' : 'branch', checked: sameRef(value, lineRef(l.id)), onSelect: () => onChange(lineRef(l.id)) })),
  ];
  if (includeCheckpoints && project.checkpoints.length > 0) {
    items.push({ kind: 'separator' }, { kind: 'heading', label: 'Checkpoints' });
    for (const cp of project.checkpoints.slice(0, 6)) {
      for (const l of cp.lines) {
        if (onlyAlternatives && l.kind === 'shared') continue;
        const ref: ContentRef = { kind: 'checkpoint', checkpointId: cp.id, lineId: l.lineId };
        items.push({ label: `${l.name} · ${cp.name}`, icon: 'checkpoint', checked: sameRef(value, ref), onSelect: () => onChange(ref) });
      }
    }
  }
  return (
    <Menu
      label={label}
      align="start"
      items={items}
      trigger={(props) => (
        <button type="button" className="ref-picker" style={{ ['--line-color' as string]: `var(--alt-${info.color})` }} aria-label={`${label}: ${info.name}`} {...props}>
          <ColorDot color={info.color as never} shared={info.color === 'shared'} />
          <span className="ref-text">
            <span className="ref-name">{info.name}</span>
            <span className="ref-detail">{info.detail}</span>
          </span>
          <Icon name="chevronDown" size={13} />
        </button>
      )}
    />
  );
}

/* ---------------------------------------------------------------- */
/* Compare                                                           */
/* ---------------------------------------------------------------- */

const isSequence = (p: string): boolean => /^sequences\/[^/]+\.mvseq\.json$/.test(p);

function SequenceCompare({ project, left, right, path }: { project: ProjectView; left: ContentRef; right: ContentRef; path: string }) {
  const diff = useAsync(() => call('compare.sequence', { projectId: project.id, left, right, path }), [project.id, refKey(left), refKey(right), path, project.updatedAt]);
  if (diff.error) return <p className="info-banner">{diff.error}</p>;
  if (!diff.data) return <div className="editor-loading" />;
  return (
    <div className="seq-compare">
      <SequenceDiff diff={diff.data} leftLabel={refName(project, left).name} rightLabel={refName(project, right).name} />
    </div>
  );
}

function SourceDiff({ project, left, right, path }: { project: ProjectView; left: ContentRef; right: ContentRef; path: string }) {
  if (isSequence(path)) return <SequenceCompare project={project} left={left} right={right} path={path} />;
  return <FileDiff project={project} left={left} right={right} path={path} />;
}

function FileDiff({ project, left, right, path }: { project: ProjectView; left: ContentRef; right: ContentRef; path: string }) {
  const files = useAsync(async () => {
    const read = (ref: ContentRef) => call('files.read', { projectId: project.id, ref, path }).catch(() => null);
    return Promise.all([read(left), read(right)]);
  }, [project.id, refKey(left), refKey(right), path, project.updatedAt]);
  if (!files.data) return <div className="editor-loading" />;
  const [a, b] = files.data;
  if ((a && a.text === null) || (b && b.text === null)) {
    return (
      <div className="binary-compare">
        {[a, b].map((f, i) => (
          <figure key={i}>
            {f?.dataUrl ? <img src={f.dataUrl} alt={`${path} ${i === 0 ? 'left' : 'right'}`} /> : <div className="binary-missing">{f ? 'Binary file' : 'Not present'}</div>}
            <figcaption className="muted small">{f ? `${f.size.toLocaleString()} bytes` : 'Missing on this side'}</figcaption>
          </figure>
        ))}
      </div>
    );
  }
  return <DiffEditor original={a?.text ?? ''} modified={b?.text ?? ''} language={a?.language ?? b?.language ?? 'plaintext'} label={`Changes to ${path}`} />;
}

function ComparePane() {
  const project = useStudio((s) => s.project)!;
  const compare = useStudio((s) => s.compare);
  const viewport = useStudio((s) => s.viewport);
  const syncScroll = useStudio((s) => s.syncScroll);
  const versions = useStudio((s) => s.previewVersions);
  const result = useAsync(() => call('compare.run', { projectId: project.id, left: compare.left, right: compare.right }), [project.id, refKey(compare.left), refKey(compare.right), project.updatedAt]);
  const changed = result.data?.files.filter((f) => f.status !== 'unchanged') ?? [];
  const file = compare.file && changed.some((f) => f.path === compare.file) ? compare.file : changed[0]?.path ?? null;
  const l = refName(project, compare.left);
  const r = refName(project, compare.right);
  const version = (ref: ContentRef): number => (ref.kind === 'line' ? versions[ref.lineId] ?? 0 : 0);

  return (
    <div className="compare-body">
      {compare.view === 'previews' ? (
        <div className="compare-previews">
          {[compare.left, compare.right].map((ref, i) => {
            const info = i === 0 ? l : r;
            return (
              <section key={i} className="compare-column" style={{ ['--line-color' as string]: `var(--alt-${info.color})` }} aria-label={`${i === 0 ? 'Left' : 'Right'}: ${info.name}`}>
                <header className="compare-label">
                  <span className="compare-side">{i === 0 ? 'Left' : 'Right'}</span>
                  <ColorDot color={info.color as never} shared={info.color === 'shared'} />
                  <strong>{info.name}</strong>
                  <span className="muted small">{info.detail}</span>
                </header>
                <div className="compare-frame">
                  <PreviewFrame projectId={project.id} contentRef={ref} version={version(ref)} viewport={viewport} interactive title={`${info.name} preview`} syncGroup={syncScroll ? `compare:${project.id}` : null} />
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="compare-source">
          <nav className="changed-list material-solid" aria-label="Changed files">
            {changed.length === 0 && <p className="muted small pad">No differences.</p>}
            {changed.map((f) => (
              <button key={f.path} type="button" className={cx('changed-row', f.path === file && 'is-selected')} onClick={() => set((s) => ({ compare: { ...s.compare, file: f.path } }))}>
                <FileStatusIcon status={f.status} />
                <span className="changed-path">{f.path}</span>
                {f.kind === 'text' && (f.linesAdded > 0 || f.linesRemoved > 0) && (
                  <span className="line-counts">
                    <span className="added">+{f.linesAdded}</span> <span className="removed">−{f.linesRemoved}</span>
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="diff-area material-solid">
            {file ? (
              <>
                <div className="diff-labels">
                  <span>
                    <ColorDot color={l.color as never} shared={l.color === 'shared'} /> {l.name}
                  </span>
                  <Icon name="arrowRight" size={14} />
                  <span>
                    <ColorDot color={r.color as never} shared={r.color === 'shared'} /> {r.name}
                  </span>
                  <span className="muted small">{file}</span>
                </div>
                <SourceDiff project={project} left={compare.left} right={compare.right} path={file} />
              </>
            ) : (
              <EmptyState icon="check" title="These versions are identical" />
            )}
          </div>
        </div>
      )}
      {result.data && (
        <div className="compare-summary" role="status">
          <span>
            <FileStatusIcon status="modified" /> {plural(result.data.counts.modified, 'file')} modified
          </span>
          <span>
            <FileStatusIcon status="added" /> {result.data.counts.added} added
          </span>
          <span>
            <FileStatusIcon status="deleted" /> {result.data.counts.deleted} deleted
          </span>
          {compare.view === 'previews' && changed.length > 0 && (
            <button type="button" className="link-btn" onClick={() => set((s) => ({ compare: { ...s.compare, view: 'source' } }))}>
              View source differences
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CompareInspector() {
  const project = useStudio((s) => s.project)!;
  const compare = useStudio((s) => s.compare);
  const combine = useStudio((s) => s.combine);
  const result = useAsync(() => call('compare.run', { projectId: project.id, left: compare.left, right: compare.right }), [project.id, refKey(compare.left), refKey(compare.right), project.updatedAt], compare.mode === 'compare');
  if (compare.mode === 'combine') {
    return (
      <>
        <div className="inspector-title">
          <Icon name="combine" size={18} />
          <div>
            <h2>Combine</h2>
            <p className="muted">Bring the best parts together.</p>
          </div>
        </div>
        <InspectorSection title="How combining works">
          <ol className="steps-list">
            <li>Choose where the result goes: an existing alternative or a new one.</li>
            <li>Pick sections or files from other versions.</li>
            <li>Review the proposed result and its preview.</li>
            <li>Apply. A checkpoint is created first, so you can undo.</li>
          </ol>
        </InspectorSection>
        {combine && (
          <InspectorSection title="Picked so far">
            <p className="inspector-text">
              {plural(Object.values(combine.files).filter((a) => a.kind !== 'keep').length, 'file action')}, {plural(combine.sections.length, 'section')}, {plural(Object.keys(combine.edits).length, 'manual edit')}.
            </p>
          </InspectorSection>
        )}
      </>
    );
  }
  const l = refName(project, compare.left);
  const r = refName(project, compare.right);
  return (
    <>
      <div className="inspector-title">
        <Icon name="compare" size={18} />
        <div>
          <h2>Comparison</h2>
          <p className="muted">
            {l.name} ↔ {r.name}
          </p>
        </div>
      </div>
      {result.data && (
        <InspectorSection title="Summary">
          <p className="inspector-text">
            {result.data.counts.modified + result.data.counts.added + result.data.counts.deleted === 0
              ? 'No differences.'
              : `${plural(result.data.counts.modified, 'file')} modified, ${result.data.counts.added} added and ${result.data.counts.deleted} deleted going from ${l.name} to ${r.name}.`}
          </p>
          {result.data.commonRevision && (
            <p className="inspector-text muted">
              <Icon name="branch" size={13} /> Both build on: {result.data.commonRevision.label}
            </p>
          )}
        </InspectorSection>
      )}
      <InspectorSection title="Next">
        <div className="inspector-action-list">
          <Button
            variant="quiet"
            icon="combine"
            onClick={() => {
              const dest = compare.left.kind === 'line' && compare.left.lineId !== SHARED_LINE_ID ? compare.left : project.alternatives[0] ? lineRef(project.alternatives[0].id) : compare.left;
              startCombine(project, dest, compare.right);
            }}
          >
            Combine parts of {r.name}…
          </Button>
        </div>
      </InspectorSection>
    </>
  );
}

/* ---------------------------------------------------------------- */
/* Combine                                                           */
/* ---------------------------------------------------------------- */

function newDraft(project: ProjectView, destination: ContentRef, source: ContentRef, mode: 'auto' | 'new' = 'auto'): CombineDraft {
  const destLine = mode === 'auto' && destination.kind === 'line' ? project.alternatives.find((a) => a.id === destination.lineId) : undefined;
  const srcName = refName(project, source).name;
  const used = new Set(project.alternatives.map((a) => a.color));
  return {
    destination: destLine
      ? { kind: 'existing', lineId: destLine.id }
      : { kind: 'new', base: destination, name: `${refName(project, destination).name} + ${srcName}`.slice(0, 60), color: ALTERNATIVE_COLORS.find((c) => !used.has(c)) ?? 'teal', description: '', following: true },
    source,
    files: {},
    sections: [],
    edits: {},
    description: '',
    stage: 'pick',
    tab: 'sections',
    result: null,
  };
}

export function startCombine(project: ProjectView, destination: ContentRef, source: ContentRef): void {
  set({ workspace: 'compare', compare: { ...get().compare, mode: 'combine' }, combine: newDraft(project, destination, source) });
}

function updateDraft(patch: Partial<CombineDraft> | ((d: CombineDraft) => Partial<CombineDraft>)): void {
  set((s) => (s.combine ? { combine: { ...s.combine, ...(typeof patch === 'function' ? patch(s.combine) : patch) } } : {}));
}

function planOf(d: CombineDraft): CombinePlan {
  return { destination: d.destination, files: d.files, sections: d.sections, edits: d.edits, description: d.description };
}

function destinationRef(d: CombineDraft): ContentRef {
  return d.destination.kind === 'existing' ? lineRef(d.destination.lineId) : d.destination.base;
}

function DestinationCard({ project, draft }: { project: ProjectView; draft: CombineDraft }) {
  const dest = draft.destination;
  return (
    <section className="combine-card" aria-labelledby="dest-title">
      <h3 id="dest-title">
        <span className="step-num">1</span> Destination
      </h3>
      <SegmentedControl
        size="sm"
        label="Destination kind"
        options={[
          { value: 'new', label: 'New alternative' },
          { value: 'existing', label: 'Existing alternative' },
        ]}
        value={dest.kind}
        onChange={(kind) => {
          if (kind === dest.kind) return;
          const baseRef = destinationRef(draft);
          if (kind === 'existing') {
            const target = baseRef.kind === 'line' && project.alternatives.some((a) => a.id === baseRef.lineId) ? baseRef.lineId : project.alternatives[0]?.id;
            if (target) updateDraft({ destination: { kind: 'existing', lineId: target }, edits: {} });
          } else {
            updateDraft({ destination: newDraft(project, baseRef, draft.source, 'new').destination, edits: {} });
          }
        }}
      />
      {dest.kind === 'existing' ? (
        <div className="field">
          <span className="field-label">Combine into</span>
          <RefPicker project={project} value={lineRef(dest.lineId)} onlyAlternatives includeCheckpoints={false} label="Destination alternative" onChange={(r) => r.kind === 'line' && updateDraft({ destination: { kind: 'existing', lineId: r.lineId }, edits: {} })} />
          <p className="field-hint">The alternative is updated in one step after you review it. Its previous state stays in History.</p>
        </div>
      ) : (
        <>
          <div className="field">
            <span className="field-label">Start from</span>
            <RefPicker project={project} value={dest.base} label="Starting point" onChange={(r) => updateDraft({ destination: { ...dest, base: r }, edits: {} })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="combine-name">
              Name
            </label>
            <input id="combine-name" className="input" value={dest.name} maxLength={80} onChange={(e) => updateDraft({ destination: { ...dest, name: e.target.value } })} />
          </div>
          <div className="swatches" role="radiogroup" aria-label="Colour">
            {ALTERNATIVE_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={dest.color === c} aria-label={c} className={cx('swatch', dest.color === c && 'is-selected')} style={{ background: `var(--alt-${c})` }} onClick={() => updateDraft({ destination: { ...dest, color: c } })} />
            ))}
          </div>
          <Toggle checked={dest.following} onChange={(v) => updateDraft({ destination: { ...dest, following: v } })} label="Follow shared changes" />
        </>
      )}
    </section>
  );
}

function FilesTab({ project, draft }: { project: ProjectView; draft: CombineDraft }) {
  const dest = destinationRef(draft);
  const candidates = useAsync(() => call('combine.candidates', { projectId: project.id, source: draft.source, destination: dest }), [project.id, refKey(draft.source), refKey(dest), project.updatedAt]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const changed = candidates.data?.files.filter((f) => f.status !== 'unchanged') ?? [];
  const actionOf = (p: string): FileAction['kind'] => draft.files[p]?.kind ?? 'keep';
  const setAction = (p: string, kind: FileAction['kind']): void =>
    updateDraft((d) => {
      const files = { ...d.files };
      if (kind === 'keep') delete files[p];
      else if (kind === 'hunks') files[p] = { kind: 'hunks', source: d.source, hunks: [] };
      else if (kind === 'timeline') files[p] = { kind: 'timeline', source: d.source, tracks: [], clips: [] };
      else files[p] = { kind, source: d.source } as FileAction;
      const edits = { ...d.edits };
      delete edits[p];
      return { files, edits };
    });
  return (
    <div className="files-tab">
      {candidates.data?.commonRevision && (
        <p className="muted small common-note">
          <Icon name="branch" size={13} /> Merges use the version both share: {candidates.data.commonRevision.label}
        </p>
      )}
      {changed.length === 0 && candidates.data && <EmptyState icon="check" title="Nothing differs" body="The source has no file differences from the destination." />}
      <ul className="candidate-list">
        {changed.map((f) => {
          const action = actionOf(f.path);
          return (
            <li key={f.path} className={cx('candidate', action !== 'keep' && 'is-picked')}>
              <div className="candidate-row">
                <FileStatusIcon status={f.status} />
                <span className="candidate-path" title={f.path}>
                  {f.path}
                </span>
                <span className="candidate-hint muted small">
                  {f.sourceChangedSinceCommon && f.destChangedSinceCommon ? 'changed in both' : f.sourceChangedSinceCommon ? 'changed in source' : 'changed in destination'}
                </span>
                <label className="sr-only" htmlFor={`act-${f.path}`}>
                  Action for {f.path}
                </label>
                <select id={`act-${f.path}`} className="input select-sm" value={action} onChange={(e) => setAction(f.path, e.target.value as FileAction['kind'])}>
                  <option value="keep">Keep destination</option>
                  <option value="take">{f.status === 'deleted' ? 'Delete (as in source)' : 'Take source file'}</option>
                  {f.timeline ? (
                    <>
                      {f.status === 'modified' && <option value="merge">Merge the timelines</option>}
                      <option value="timeline">Pick tracks and clips</option>
                    </>
                  ) : (
                    <>
                      {f.mergeable && <option value="merge">Merge changes</option>}
                      {f.mergeable && <option value="hunks">Pick individual changes</option>}
                    </>
                  )}
                </select>
                {(action === 'hunks' || action === 'timeline') && <IconButton icon={expanded === f.path ? 'chevronDown' : 'chevronRight'} size="sm" label="Show changes" onClick={() => setExpanded(expanded === f.path ? null : f.path)} />}
              </div>
              {action === 'hunks' && expanded === f.path && <HunkPicker project={project} draft={draft} path={f.path} />}
              {action === 'timeline' && expanded === f.path && <TimelinePicker project={project} draft={draft} path={f.path} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Choose whole tracks and single clips from the source timeline. They keep their times. */
function TimelinePicker({ project, draft, path }: { project: ProjectView; draft: CombineDraft; path: string }) {
  const info = useAsync(() => call('combine.timeline', { projectId: project.id, plan: planOf(draft), path, source: draft.source }), [project.id, refKey(draft.source), path, JSON.stringify(draft.destination)]);
  const action = draft.files[path];
  const tracks = new Set(action?.kind === 'timeline' ? action.tracks : []);
  const clips = new Set(action?.kind === 'timeline' ? action.clips : []);
  const save = (t: Set<string>, c: Set<string>): void => updateDraft((d) => ({ files: { ...d.files, [path]: { kind: 'timeline', source: d.source, tracks: [...t], clips: [...c] } } }));
  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  if (info.error) return <p className="info-banner">{info.error}</p>;
  if (!info.data) return <div className="editor-loading" />;
  const src = info.data.source;
  return (
    <div className="tl-picker">
      <p className="muted small">Picked clips keep their times. A clip that would overlap the destination’s clips goes onto a new track instead of moving.</p>
      {src.tracks.map((t) => {
        const own = src.clips.filter((c) => c.trackId === t.id);
        return (
          <fieldset key={t.id} className="tl-picker-track">
            <legend>
              <label className="check-row">
                <input type="checkbox" checked={tracks.has(t.id)} onChange={() => save(toggle(tracks, t.id), clips)} />
                <span>
                  Whole track: <strong>{t.name}</strong> <span className="muted small">({t.kind}, {own.length} clips)</span>
                </span>
              </label>
            </legend>
            {!tracks.has(t.id) &&
              own
                .filter((c) => c.changed)
                .map((c) => (
                  <label key={c.id} className="check-row tl-picker-clip">
                    <input type="checkbox" checked={clips.has(c.id)} onChange={() => save(tracks, toggle(clips, c.id))} />
                    <span>{c.label}</span>
                    <span className="muted small">
                      {c.start.toFixed(1)}–{c.end.toFixed(1)} s
                    </span>
                  </label>
                ))}
          </fieldset>
        );
      })}
    </div>
  );
}

function HunkPicker({ project, draft, path }: { project: ProjectView; draft: CombineDraft; path: string }) {
  const hunks = useAsync(() => call('combine.hunks', { projectId: project.id, source: draft.source, destination: destinationRef(draft), path }), [project.id, refKey(draft.source), refKey(destinationRef(draft)), path]);
  const action = draft.files[path];
  const chosen = new Set(action?.kind === 'hunks' ? action.hunks : []);
  const toggle = (i: number): void =>
    updateDraft((d) => {
      const current = d.files[path];
      const set2 = new Set(current?.kind === 'hunks' ? current.hunks : []);
      if (set2.has(i)) set2.delete(i);
      else set2.add(i);
      return { files: { ...d.files, [path]: { kind: 'hunks', source: d.source, hunks: [...set2].sort((a, b) => a - b) } } };
    });
  return (
    <div className="hunk-list">
      {hunks.data?.map((h) => (
        <label key={h.index} className={cx('hunk', chosen.has(h.index) && 'is-chosen')}>
          <input type="checkbox" checked={chosen.has(h.index)} onChange={() => toggle(h.index)} />
          <span className="hunk-meta muted small">Line {h.destStartLine}</span>
          <pre className="code-block hunk-diff">
            {h.removed && h.removed.split('\n').filter(Boolean).slice(0, 6).map((l, i) => <span key={`r${i}`} className="diff-del">− {l}{'\n'}</span>)}
            {h.added && h.added.split('\n').filter(Boolean).slice(0, 6).map((l, i) => <span key={`a${i}`} className="diff-add">+ {l}{'\n'}</span>)}
          </pre>
        </label>
      ))}
    </div>
  );
}

function SectionsTab({ project, draft }: { project: ProjectView; draft: CombineDraft }) {
  const destRef = destinationRef(draft);
  const sourcePath = 'index.html';
  const sections = useAsync(() => call('combine.sections', { projectId: project.id, ref: draft.source, path: sourcePath }), [project.id, refKey(draft.source)]);
  const [picking, setPicking] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [target, setTarget] = useState<SectionTarget | null>(null);
  const [analysis, setAnalysis] = useState<SectionAnalysis | null>(null);
  const [rules, setRules] = useState<Set<string>>(new Set());
  const [assets, setAssets] = useState<Record<string, 'copy' | 'skip'>>({});
  const [includeVars, setIncludeVars] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCss, setShowCss] = useState<string | null>(null);

  useEffect(() => {
    setKey(null);
    setAnalysis(null);
  }, [refKey(draft.source), refKey(destRef)]);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    setError(null);
    call('combine.analyzeSection', { projectId: project.id, source: draft.source, sourcePath, sectionKey: key, destination: destRef, destPath: 'index.html', target: target ?? undefined })
      .then((a) => {
        if (!alive) return;
        setAnalysis(a);
        if (!target) setTarget(a.suggestedTarget);
        setRules(new Set(a.cssRules.filter((r) => r.defaultSelected).map((r) => r.id)));
        setAssets(Object.fromEntries(a.assets.map((x) => [x.path, x.defaultAction])));
      })
      .catch((e) => alive && (setError(errorMessage(e)), setAnalysis(null)));
    return () => {
      alive = false;
    };
  }, [key, target ? JSON.stringify(target) : null]);

  const pickable = sections.data?.filter((s) => !s.ambiguous).map((s) => s.key) ?? [];
  const blocking = analysis?.warnings.find((w) => w.severity === 'blocking');
  const already = draft.sections.some((s) => s.sectionKey === key && sameRef(s.source, draft.source));

  const add = (): void => {
    if (!analysis || !key || !target) return;
    updateDraft((d) => ({
      sections: [
        ...d.sections.filter((s) => !(s.sectionKey === key && sameRef(s.source, d.source))),
        {
          source: d.source,
          sourcePath,
          sectionKey: key,
          destPath: 'index.html',
          target,
          cssRuleIds: [...rules],
          includeVariables: includeVars,
          assets: Object.entries(assets).map(([path, action]) => ({ path, action })),
          destCssPath: analysis.destCssPath,
        },
      ],
      edits: Object.fromEntries(Object.entries(d.edits).filter(([p]) => p !== 'index.html' && p !== analysis.destCssPath)),
    }));
    toast({ tone: 'success', title: `Added ${analysis.section.label}`, body: 'Review the combination when you have picked everything.' });
  };

  return (
    <div className="sections-tab">
      <div className="section-source">
        <div className="section-source-bar">
          <span className="muted small">{picking ? 'Click a highlighted section in the preview. Esc cancels.' : 'Choose a section from the list, or pick it in the preview.'}</span>
          <Button size="sm" variant={picking ? 'primary' : 'secondary'} icon="target" onClick={() => setPicking((v) => !v)} aria-pressed={picking}>
            {picking ? 'Picking…' : 'Pick in preview'}
          </Button>
        </div>
        <div className="section-preview">
          <PreviewFrame
            projectId={project.id}
            contentRef={draft.source}
            viewport="desktop"
            interactive={picking}
            title={`${refName(project, draft.source).name} — pick a section`}
            pickKeys={picking ? pickable : null}
            onPick={(k) => {
              setKey(k);
              setTarget(null);
              setPicking(false);
            }}
            onPickCancel={() => setPicking(false)}
          />
        </div>
        <ul className="section-outline" aria-label="Sections in the source">
          {sections.data?.map((s) => (
            <li key={s.key}>
              <button type="button" className={cx('section-row', key === s.key && 'is-selected', s.ambiguous && 'is-ambiguous')} style={{ paddingLeft: 10 + s.depth * 12 }} onClick={() => (setKey(s.key), setTarget(null))} disabled={s.ambiguous} title={s.reason ?? undefined}>
                <Icon name={s.ambiguous ? 'warning' : 'layers'} size={13} />
                <span>{s.label}</span>
                <span className="muted small">{s.key}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="section-analysis">
        {error && <p className="error-text">{error} You can still combine at file or text level in the Files tab.</p>}
        {!analysis && !error && <EmptyState icon="target" title="Choose a section" body="Supported sections have a stable id or are clear landmarks like header, nav, main or footer." />}
        {analysis && (
          <>
            <h4>
              {analysis.section.label} <span className="muted small">from {analysis.sourceLabel}</span>
            </h4>
            <div className="field">
              <span className="field-label">Place it in {analysis.destinationLabel}</span>
              <select
                className="input"
                aria-label="Replacement target or insertion point"
                value={JSON.stringify(target ?? analysis.suggestedTarget)}
                onChange={(e) => setTarget(JSON.parse(e.target.value) as SectionTarget)}
              >
                {analysis.destinationSections
                  .filter((s) => !s.ambiguous)
                  .map((s) => (
                    <option key={`r${s.key}`} value={JSON.stringify({ mode: 'replace', key: s.key })}>
                      Replace {s.label} ({s.key})
                    </option>
                  ))}
                {analysis.destinationSections
                  .filter((s) => !s.ambiguous && s.depth <= 1)
                  .flatMap((s) => [
                    <option key={`b${s.key}`} value={JSON.stringify({ mode: 'insert', anchorKey: s.key, position: 'before' })}>
                      Insert before {s.label}
                    </option>,
                    <option key={`a${s.key}`} value={JSON.stringify({ mode: 'insert', anchorKey: s.key, position: 'after' })}>
                      Insert after {s.label}
                    </option>,
                  ])}
                <option value={JSON.stringify({ mode: 'append' })}>Add at the natural place in the page</option>
              </select>
            </div>
            {analysis.warnings.length > 0 && (
              <ul className="warning-list">
                {analysis.warnings.map((w, i) => (
                  <li key={i} className={cx('warning-item', `sev-${w.severity}`)}>
                    <Icon name={w.severity === 'info' ? 'info' : 'warning'} size={14} />
                    <span>{w.message}</span>
                  </li>
                ))}
              </ul>
            )}
            <details open className="analysis-group">
              <summary>
                CSS rules · {rules.size} of {analysis.cssRules.length} selected
              </summary>
              <ul className="rule-list">
                {analysis.cssRules.map((r) => (
                  <li key={r.id} className="rule">
                    <label className="rule-row">
                      <input type="checkbox" checked={rules.has(r.id)} onChange={() => setRules((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} />
                      <code className="rule-selector">{r.selector}</code>
                      <span className={cx('rule-tag', `tag-${r.relation}`)}>{r.relation === 'specific' ? 'this section' : r.relation === 'shared' ? 'shared' : r.dependencyKind}</span>
                    </label>
                    {r.media && <span className="muted small rule-media">{r.media}</span>}
                    {r.warning && <span className="rule-warning small">{r.warning}</span>}
                    <button type="button" className="link-btn small" onClick={() => setShowCss(showCss === r.id ? null : r.id)} aria-expanded={showCss === r.id}>
                      {showCss === r.id ? 'Hide CSS' : 'Review CSS'}
                    </button>
                    {showCss === r.id && <pre className="code-block">{r.text}</pre>}
                  </li>
                ))}
              </ul>
            </details>
            {analysis.variables.length > 0 && (
              <details className="analysis-group">
                <summary>Design tokens · {analysis.variables.length}</summary>
                <Toggle checked={includeVars} onChange={setIncludeVars} label="Scope these values to the section" description="Keeps the section’s look without changing the rest of the destination." />
                <ul className="token-list">
                  {analysis.variables.map((v) => (
                    <li key={v.name}>
                      <code>{v.name}</code>: <code>{v.value}</code>
                      {v.destValue !== null && v.destValue !== v.value && <span className="muted small"> (destination: {v.destValue})</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {analysis.assets.length > 0 && (
              <details open className="analysis-group">
                <summary>Local assets · {analysis.assets.length}</summary>
                <ul className="asset-list">
                  {analysis.assets.map((a) => (
                    <li key={a.path}>
                      <code>{a.path}</code>
                      <span className={cx('asset-status', `as-${a.status}`)}>{a.status === 'present-identical' ? 'already there' : a.status === 'missing' ? 'missing in destination' : a.status === 'differs' ? 'different in destination' : 'missing in source'}</span>
                      {(a.status === 'missing' || a.status === 'differs') && (
                        <select className="input select-sm" aria-label={`Action for ${a.path}`} value={assets[a.path] ?? a.defaultAction} onChange={(e) => setAssets((s) => ({ ...s, [a.path]: e.target.value as 'copy' | 'skip' }))}>
                          <option value="copy">Copy</option>
                          <option value="skip">{a.status === 'differs' ? 'Keep destination’s' : 'Skip'}</option>
                        </select>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {analysis.scripts.length > 0 && (
              <details className="analysis-group">
                <summary>JavaScript that may depend on this section · {analysis.scripts.length}</summary>
                <ul className="token-list">
                  {analysis.scripts.map((s, i) => (
                    <li key={i}>
                      <code>
                        {s.path}:{s.line}
                      </code>{' '}
                      <span className="muted small">{s.detail}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="inline-actions">
              <Button variant="primary" icon="plus" disabled={Boolean(blocking)} onClick={add}>
                {already ? 'Update this pick' : 'Add to combination'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PickSummary({ project, draft }: { project: ProjectView; draft: CombineDraft }) {
  const fileActions = Object.entries(draft.files).filter(([, a]) => a.kind !== 'keep');
  const count = fileActions.length + draft.sections.length;
  return (
    <section className="combine-card pick-summary" aria-labelledby="picks-title">
      <h3 id="picks-title">
        <span className="step-num">3</span> Picked
      </h3>
      {count === 0 ? (
        <p className="muted small">Nothing yet. Add sections or file changes from the source.</p>
      ) : (
        <ul className="picks">
          {draft.sections.map((s, i) => (
            <li key={`s${i}`}>
              <Icon name="layers" size={13} />
              <span>
                {s.sectionKey} from {refName(project, s.source).name}
              </span>
              <IconButton icon="close" size="sm" label={`Remove ${s.sectionKey}`} onClick={() => updateDraft((d) => ({ sections: d.sections.filter((_, j) => j !== i) }))} />
            </li>
          ))}
          {fileActions.map(([path, a]) => (
            <li key={path}>
              <Icon name="file" size={13} />
              <span>
                {path}: {a.kind === 'take' ? 'take' : a.kind === 'merge' ? 'merge' : a.kind === 'timeline' ? `${a.tracks.length} tracks, ${a.clips.length} clips` : `${a.kind === 'hunks' ? a.hunks.length : 0} changes`} from {a.kind !== 'keep' ? refName(project, a.source).name : ''}
              </span>
              <IconButton icon="close" size="sm" label={`Remove ${path}`} onClick={() => updateDraft((d) => { const files = { ...d.files }; delete files[path]; return { files }; })} />
            </li>
          ))}
        </ul>
      )}
      <Button variant="primary" icon="arrowRight" disabled={count === 0 && draft.destination.kind === 'existing'} onClick={() => updateDraft({ stage: 'review' })}>
        Review combination
      </Button>
    </section>
  );
}

function ReviewStage({ project, draft }: { project: ProjectView; draft: CombineDraft }) {
  const [proposal, setProposal] = useState<CombineProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>('');
  const [mergeFile, setMergeFile] = useState<string | null>(null);
  const [timelineFile, setTimelineFile] = useState<string | null>(null);
  const plan = useMemo(() => planOf(draft), [draft.destination, draft.files, draft.sections, draft.edits, draft.description]);
  const destRef = destinationRef(draft);
  const viewport = useStudio((s) => s.viewport);

  useEffect(() => {
    let alive = true;
    setError(null);
    call('combine.preview', { projectId: project.id, plan })
      .then((p) => alive && setProposal(p))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [plan]);

  const apply = async (): Promise<void> => {
    setApplying(true);
    try {
      const result = await call('combine.apply', { projectId: project.id, plan });
      applyProject(result.project);
      updateDraft({ stage: 'done', result });
      selectLine(result.lineId);
    } catch (e) {
      toast({ tone: 'error', title: 'The combination was not applied', body: `${errorMessage(e)} Nothing was changed.` });
    } finally {
      setApplying(false);
    }
  };

  const openEdit = async (path: string): Promise<void> => {
    if (!proposal) return;
    try {
      const file = await call('files.read', { projectId: project.id, ref: { kind: 'proposal', proposalId: proposal.proposalId }, path });
      setEditText(file.text ?? '');
      setEditing(path);
    } catch (e) {
      toast({ tone: 'error', title: 'Could not open the proposed file', body: errorMessage(e) });
    }
  };

  const destName = draft.destination.kind === 'existing' ? refName(project, destRef).name : draft.destination.name;

  return (
    <div className="review-stage">
      <div className="review-main">
        <div className="review-previews">
          <section className="compare-column">
            <header className="compare-label">
              <span className="compare-side">Before</span>
              <strong>{refName(project, destRef).name}</strong>
            </header>
            <div className="compare-frame">
              <PreviewFrame projectId={project.id} contentRef={destRef} viewport={viewport} interactive title="Destination before combining" syncGroup={`review:${project.id}`} />
            </div>
          </section>
          <section className="compare-column is-proposal">
            <header className="compare-label">
              <span className="compare-side">Proposed</span>
              <strong>{destName}</strong>
              <span className="muted small">not applied yet</span>
            </header>
            <div className="compare-frame">
              {proposal ? (
                <PreviewFrame key={proposal.proposalId} projectId={project.id} contentRef={{ kind: 'proposal', proposalId: proposal.proposalId }} viewport={viewport} interactive title="Proposed result" syncGroup={`review:${project.id}`} />
              ) : (
                <div className="preview-loading" />
              )}
            </div>
          </section>
        </div>
        {editing && (
          <div className="review-editor material-solid">
            <div className="editor-head">
              <Icon name="pencil" size={14} /> Editing the proposed <strong>{editing}</strong>
              <span className="bar-spacer" />
              <Button size="sm" variant="primary" onClick={() => (updateDraft((d) => ({ edits: { ...d.edits, [editing]: editText } })), setEditing(null))}>
                Use these edits
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
            <div className="editor-surface">
              <CodeEditor uri={`proposal://${editing}`} text={editText} language={/\.css$/.test(editing) ? 'css' : /\.js$/.test(editing) ? 'javascript' : 'html'} readOnly={false} onChange={setEditText} onSave={() => undefined} diagnostics={[]} reveal={null} label={`Proposed ${editing}`} />
            </div>
          </div>
        )}
        {mergeFile && <MergeResolver project={project} draft={draft} path={mergeFile} onClose={() => setMergeFile(null)} />}
        {timelineFile && proposal && !mergeFile && (
          <div className="merge-resolver material-solid">
            <div className="editor-head">
              <Icon name="film" size={14} /> Proposed changes to <strong>{timelineFile}</strong>
              <span className="bar-spacer" />
              <Button size="sm" variant="quiet" onClick={() => setTimelineFile(null)}>
                Close
              </Button>
            </div>
            <div className="merge-scroll">
              <SequenceCompare project={project} left={destRef} right={{ kind: 'proposal', proposalId: proposal.proposalId }} path={timelineFile} />
            </div>
          </div>
        )}
      </div>
      <aside className="review-side material-solid" aria-label="Proposed changes">
        <h3>Proposed result</h3>
        {error && <p className="error-text">{error}</p>}
        {proposal && (
          <>
            <p className="muted small">
              {plural(proposal.changedCount, 'file')} will change in {destName}.
            </p>
            <ul className="proposed-files">
              {proposal.files.map((f) => (
                <li key={f.path} className={cx(f.hasConflicts && 'has-conflict')}>
                  <FileStatusIcon status={f.status} />
                  <span className="proposed-path">{f.path}</span>
                  <span className="muted small proposed-origin">{f.origin}</span>
                  <span className="proposed-actions">
                    {f.hasConflicts ? (
                      <Button size="sm" variant="primary" icon="conflict" onClick={() => setMergeFile(f.path)}>
                        Resolve
                      </Button>
                    ) : isSequence(f.path) ? (
                      f.status !== 'deleted' && (
                        <Button size="sm" variant="quiet" icon="film" onClick={() => setTimelineFile(f.path)}>
                          Timeline
                        </Button>
                      )
                    ) : (
                      f.kind === 'text' && f.status !== 'deleted' && (
                        <Button size="sm" variant="quiet" icon="pencil" onClick={() => void openEdit(f.path)}>
                          Edit
                        </Button>
                      )
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {proposal.warnings.length > 0 && (
              <ul className="warning-list">
                {proposal.warnings.map((w, i) => (
                  <li key={i} className={cx('warning-item', `sev-${w.severity}`)}>
                    <Icon name={w.severity === 'info' ? 'info' : 'warning'} size={14} />
                    <span>{w.message}</span>
                    {w.include && (
                      <Button size="sm" variant="quiet" icon="plus" onClick={() => updateDraft((d) => ({ files: { ...d.files, [w.include!.path]: { kind: 'take', source: w.include!.source } } }))}>
                        Include {w.include.path}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">Applying creates a checkpoint first, keeps every original version, and can be undone.</p>
          </>
        )}
        <div className="field">
          <label className="field-label" htmlFor="combine-desc">
            Note (optional)
          </label>
          <input id="combine-desc" className="input" maxLength={200} value={draft.description} onChange={(e) => updateDraft({ description: e.target.value })} placeholder="Why this combination?" />
        </div>
        <div className="review-actions">
          <Button variant="primary" icon="check" disabled={!proposal?.ready || applying} onClick={() => void apply()}>
            {applying ? 'Applying…' : 'Apply combination'}
          </Button>
          <Button variant="secondary" icon="chevronLeft" onClick={() => updateDraft({ stage: 'pick' })}>
            Revise picks
          </Button>
          <Button variant="quiet" onClick={() => set({ combine: null, compare: { ...get().compare, mode: 'compare' } })}>
            Cancel
          </Button>
        </div>
        {proposal && !proposal.ready && proposal.conflicts.length > 0 && <p className="muted small">Resolve {plural(proposal.conflicts.reduce((n, c) => n + c.count, 0), 'conflict')} to apply.</p>}
      </aside>
    </div>
  );
}

function TimelineMergeResolver({ project, draft, path, onClose }: { project: ProjectView; draft: CombineDraft; path: string; onClose: () => void }) {
  const action = draft.files[path];
  const source = action && action.kind !== 'keep' ? action.source : draft.source;
  const info = useAsync(() => call('combine.timeline', { projectId: project.id, plan: planOf(draft), path, source }), [path, JSON.stringify(draft.files[path])]);
  const destName = draft.destination.kind === 'existing' ? refName(project, lineRef(draft.destination.lineId)).name : refName(project, draft.destination.base).name;
  return (
    <div className="merge-resolver material-solid">
      <div className="editor-head">
        <Icon name="film" size={14} /> Merging the timeline <strong>{path}</strong>
        <span className="bar-spacer" />
        <Button size="sm" variant="quiet" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="merge-scroll">
        {info.data ? (
          <TimelineDecisions
            items={info.data.items}
            taken={info.data.taken}
            oursLabel={destName}
            theirsLabel={refName(project, source).name}
            onChoose={(key, choice) =>
              updateDraft((d) => {
                const current = d.files[path];
                if (!current || current.kind !== 'merge') return {};
                return { files: { ...d.files, [path]: { ...current, timelineChoices: { ...(current.timelineChoices ?? {}), [key]: choice } } } };
              })
            }
          />
        ) : (
          <div className="editor-loading" />
        )}
      </div>
    </div>
  );
}

function MergeResolver({ project, draft, path, onClose }: { project: ProjectView; draft: CombineDraft; path: string; onClose: () => void }) {
  if (isSequence(path)) return <TimelineMergeResolver project={project} draft={draft} path={path} onClose={onClose} />;
  return <TextMergeResolver project={project} draft={draft} path={path} onClose={onClose} />;
}

function TextMergeResolver({ project, draft, path, onClose }: { project: ProjectView; draft: CombineDraft; path: string; onClose: () => void }) {
  const action = draft.files[path];
  const source = action && action.kind !== 'keep' ? action.source : draft.source;
  const chunks = useAsync(() => call('combine.mergeChunks', { projectId: project.id, plan: planOf(draft), path, source }), [path, JSON.stringify(draft.files[path])]);
  const destName = draft.destination.kind === 'existing' ? refName(project, lineRef(draft.destination.lineId)).name : refName(project, draft.destination.base).name;
  const conflicts = (chunks.data ?? []).filter((c): c is Extract<ConflictChunkView, { kind: 'conflict' }> => c.kind === 'conflict');
  return (
    <div className="merge-resolver material-solid">
      <div className="editor-head">
        <Icon name="conflict" size={14} /> Merging <strong>{path}</strong>
        <span className="bar-spacer" />
        <Button size="sm" variant="quiet" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="merge-scroll">
        {conflicts.map((c, i) => (
          <ConflictChunk
            key={c.index}
            chunk={c}
            number={i + 1}
            oursLabel={destName}
            theirsLabel={refName(project, source).name}
            onResolve={(r) =>
              updateDraft((d) => {
                const current = d.files[path];
                if (!current || current.kind !== 'merge') return {};
                return { files: { ...d.files, [path]: { ...current, resolutions: { ...(current.resolutions ?? {}), [String(c.index)]: r } } } };
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

function DoneStage({ draft }: { draft: CombineDraft }) {
  const result = draft.result!;
  const project = useStudio((s) => s.project)!;
  const line = project.alternatives.find((a) => a.id === result.lineId);
  return (
    <div className="done-stage">
      <div className="done-card material-modal">
        <div className="done-icon">
          <Icon name="check" size={26} />
        </div>
        <h2>{result.createdLine ? `Created ${line?.name ?? 'the combined alternative'}` : `Updated ${line?.name ?? 'the alternative'}`}</h2>
        <p>{result.summary}</p>
        <ul className="proposed-files">
          {result.changedFiles.map((f) => (
            <li key={f.path}>
              <FileStatusIcon status={f.status} /> <span className="proposed-path">{f.path}</span>
            </li>
          ))}
        </ul>
        <p className="muted small">A checkpoint was saved before applying. The original versions are unchanged.</p>
        <div className="inline-actions">
          <Button variant="primary" icon="grid" onClick={() => (set({ combine: null, compare: { ...get().compare, mode: 'compare' } }), setWorkspace('explore'))}>
            See it in Explore
          </Button>
          <Button icon="undo" onClick={() => void undoOperation(result.operationId).then(() => set({ combine: null }))}>
            Undo combination
          </Button>
          <Button variant="quiet" onClick={() => set({ combine: null, compare: { ...get().compare, mode: 'compare' } })}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function CombineWorkbench() {
  const project = useStudio((s) => s.project)!;
  const draft = useStudio((s) => s.combine);
  useEffect(() => {
    if (!draft) {
      const dest = project.alternatives[0] ? lineRef(project.alternatives[0].id) : lineRef(SHARED_LINE_ID);
      const source = project.alternatives[1] ? lineRef(project.alternatives[1].id) : lineRef(SHARED_LINE_ID);
      set({ combine: newDraft(project, dest, source) });
    }
  }, [draft === null]);
  if (!draft) return null;
  if (draft.stage === 'done' && draft.result) return <DoneStage draft={draft} />;
  if (draft.stage === 'review') return <ReviewStage project={project} draft={draft} />;
  return (
    <div className="combine-pick">
      <div className="combine-left">
        <DestinationCard project={project} draft={draft} />
        <section className="combine-card">
          <h3>
            <span className="step-num">2</span> Take from
          </h3>
          <RefPicker project={project} value={draft.source} label="Source" onChange={(r) => updateDraft({ source: r })} />
        </section>
        <PickSummary project={project} draft={draft} />
      </div>
      <div className="combine-right material-solid">
        <div className="combine-tabs">
          <SegmentedControl
            size="sm"
            label="Combine by"
            options={[
              { value: 'sections', label: 'HTML sections', icon: 'layers' },
              { value: 'files', label: 'Files & changes', icon: 'file' },
            ]}
            value={draft.tab}
            onChange={(tab) => updateDraft({ tab })}
          />
          <span className="muted small">Copying markup and styles doesn’t guarantee identical behaviour — always review the result.</span>
        </div>
        {sameRef(draft.source, destinationRef(draft)) ? (
          <EmptyState icon="swap" title="Pick a different source" body="The source and the destination are the same version." />
        ) : draft.tab === 'sections' ? (
          <SectionsTab project={project} draft={draft} />
        ) : (
          <FilesTab project={project} draft={draft} />
        )}
      </div>
    </div>
  );
}

export function CompareCombine() {
  const project = useStudio((s) => s.project)!;
  const compare = useStudio((s) => s.compare);
  const viewport = useStudio((s) => s.viewport);
  const syncScroll = useStudio((s) => s.syncScroll);
  const setCompare = (patch: Partial<typeof compare>): void => set((s) => ({ compare: { ...s.compare, ...patch } }));
  return (
    <div className="compare-combine">
      <div className="workspace-bar">
        <MultiverseHeading />
        <SegmentedControl
          size="sm"
          label="Compare or combine"
          options={[
            { value: 'compare', label: 'Compare', icon: 'compare' },
            { value: 'combine', label: 'Combine', icon: 'combine' },
          ]}
          value={compare.mode}
          onChange={(mode) => setCompare({ mode })}
        />
        {compare.mode === 'compare' && (
          <div className="compare-toolbar material-toolbar">
            <RefPicker project={project} value={compare.left} label="Left" onChange={(left) => setCompare({ left, file: null })} />
            <IconButton icon="swap" size="sm" label="Swap sides" onClick={() => setCompare({ left: compare.right, right: compare.left })} />
            <RefPicker project={project} value={compare.right} label="Right" onChange={(right) => setCompare({ right, file: null })} />
            <span className="toolbar-divider" aria-hidden="true" />
            <SegmentedControl size="sm" label="Show" options={[{ value: 'previews', label: 'Previews' }, { value: 'source', label: 'Source' }, { value: 'outcomes', label: 'Outcomes' }]} value={compare.view} onChange={(view) => setCompare({ view })} />
            {compare.view === 'previews' && (
              <>
                <SegmentedControl size="sm" label="Matching preview size" options={VIEWPORT_OPTIONS} value={viewport} onChange={(v) => set({ viewport: v })} />
                <IconButton icon="sync" size="sm" label="Synchronize scrolling" active={syncScroll} onClick={() => set({ syncScroll: !syncScroll })} />
              </>
            )}
          </div>
        )}
      </div>
      {compare.mode === 'combine' ? <CombineWorkbench /> : compare.view === 'outcomes' ? <OutcomesView refs={[compare.left, compare.right]} /> : <ComparePane />}
    </div>
  );
}
