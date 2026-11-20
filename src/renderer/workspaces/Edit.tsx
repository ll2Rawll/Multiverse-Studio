import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStudio, set, get, openDialog, toast } from '../state/store';
import { saveShared } from '../state/actions';
import { call, errorMessage, ApiError } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { CodeEditor } from '../editor/CodeEditor';
import { PreviewFrame, type RuntimeError } from '../components/PreviewFrame';
import { Splitter } from '../components/Splitter';
import { Button, ColorDot, EmptyState, IconButton, SegmentedControl } from '../components/primitives';
import { Icon } from '../components/Icon';
import { VIEWPORT_OPTIONS } from './PreviewCard';
import { bytes, cx, debounce, lineRef, plural } from '../lib/util';
import { SHARED_LINE_ID, type Diagnostic, type FileContent, type SearchMatch } from '../../shared/types';
import { updateSettings } from '../state/actions';
import { noteUserEdit } from '../state/live';


function SearchPanel({ projectId, lineId, onOpen }: { projectId: string; lineId: string; onOpen: (m: SearchMatch) => void }) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const run = async (): Promise<void> => {
    if (!query.trim()) return;
    try {
      setResults(await call('files.search', { projectId, ref: lineRef(lineId), query, caseSensitive }));
    } catch (error) {
      toast({ tone: 'error', title: 'Search failed', body: errorMessage(error) });
    }
  };
  const grouped = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const r of results ?? []) map.set(r.path, [...(map.get(r.path) ?? []), r]);
    return [...map.entries()];
  }, [results]);
  return (
    <div className="search-panel" role="search">
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Icon name="search" size={15} />
        <label className="sr-only" htmlFor="search-files">
          Search in files
        </label>
        <input id="search-files" className="input" placeholder="Search in files…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        <button type="button" className={cx('chip-toggle', caseSensitive && 'is-on')} aria-pressed={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title="Match case">
          Aa
        </button>
        <Button size="sm" type="submit">
          Search
        </Button>
      </form>
      {results && (
        <div className="search-results" aria-live="polite">
          <p className="muted small">{results.length === 0 ? 'No matches.' : `${plural(results.length, 'match', 'matches')} in ${plural(grouped.length, 'file')}${results.length >= 500 ? ' (first 500)' : ''}`}</p>
          {grouped.map(([path, matches]) => (
            <div key={path} className="search-group">
              <div className="search-file">
                <Icon name="file" size={13} /> {path}
              </div>
              {matches.slice(0, 30).map((m, i) => (
                <button key={i} type="button" className="search-hit" onClick={() => onOpen(m)}>
                  <span className="search-line">{m.line}</span>
                  <span className="search-preview">{m.preview}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The code editor with a live preview. Apps pass their dev-server preview in place of the static one. */
export function Edit({ appPreview }: { appPreview?: ReactNode } = {}) {
  const project = useStudio((s) => s.project)!;
  const lineId = useStudio((s) => s.selectedLineId);
  const selectedFile = useStudio((s) => s.selectedFile[s.selectedLineId] ?? null);
  const version = useStudio((s) => s.previewVersions[s.selectedLineId] ?? 0);
  const split = useStudio((s) => s.settings.editorSplit);
  const viewport = useStudio((s) => s.cardViewports[`edit:${s.selectedLineId}`] ?? 'desktop');
  const reveal = useStudio((s) => s.editorReveal);
  const line = lineId === SHARED_LINE_ID ? project.shared : project.alternatives.find((a) => a.id === lineId) ?? project.shared;
  const isShared = line.id === SHARED_LINE_ID;
  const followers = project.alternatives.filter((a) => a.following).length;

  const files = useAsync(() => call('files.list', { projectId: project.id, ref: lineRef(line.id) }), [project.id, line.id, version]);
  const path = selectedFile ?? (files.data?.find((f) => f.path === 'index.html') ?? files.data?.find((f) => f.kind === 'text'))?.path ?? null;
  const entry = files.data?.find((f) => f.path === path) ?? null;
  const locked = Boolean(path && line.conflictFiles.includes(path));

  const [content, setContent] = useState<FileContent | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [runtimeErrors, setRuntimeErrors] = useState<RuntimeError[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [liveSplit, setLiveSplit] = useState<number | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const savedHash = useRef<string | null>(null);
  const pending = useRef<string | null>(null);
  const inFlight = useRef(false);
  const fileKey = `${line.id}:${path ?? ''}`;
  const keyRef = useRef(fileKey);
  keyRef.current = fileKey;

  // Load the file when the version or file changes, and adopt external changes when nothing is pending.
  useEffect(() => {
    if (!path) {
      setContent(null);
      return;
    }
    let alive = true;
    const requestKey = fileKey;
    call('files.read', { projectId: project.id, ref: lineRef(line.id), path })
      .then((c) => {
        if (!alive || keyRef.current !== requestKey) return;
        if (pending.current !== null || inFlight.current) return; // local edits win; the next save merges
        if (savedHash.current === c.hash) return;
        savedHash.current = c.hash;
        setContent(c);
        if (c.text !== null) void call('files.diagnostics', { projectId: project.id, ref: lineRef(line.id), path }).then((d) => alive && setDiagnostics(d)).catch(() => undefined);
        else setDiagnostics([]);
      })
      .catch((e) => alive && toast({ tone: 'error', title: `Could not open ${path}`, body: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [project.id, line.id, path, version]);

  useEffect(() => {
    savedHash.current = null;
    pending.current = null;
    setRuntimeErrors([]);
  }, [fileKey]);
  useEffect(() => setRuntimeErrors([]), [version]);

  const write = useMemo(
    () =>
      debounce(async (projectId: string, targetLine: string, targetPath: string) => {
        if (inFlight.current || pending.current === null) return;
        const text = pending.current;
        pending.current = null;
        inFlight.current = true;
        set({ save: { status: 'saving', message: null, at: Date.now() } });
        try {
          const result = await call('files.write', { projectId, lineId: targetLine, path: targetPath, text, baseHash: savedHash.current ?? undefined });
          savedHash.current = result.hash;
          if (keyRef.current === `${targetLine}:${targetPath}`) {
            setDiagnostics(result.diagnostics);
            if (result.mergedText !== null && pending.current === null) {
              setContent((c) => (c ? { ...c, text: result.mergedText, hash: result.hash } : c));
              toast({ tone: 'info', title: 'Merged with a change that arrived while you were typing', body: targetPath });
            }
          }
          set({ save: { status: 'saved', message: null, at: Date.now() } });
        } catch (error) {
          set({ save: { status: 'error', message: errorMessage(error), at: Date.now() } });
          if (error instanceof ApiError && error.code === 'stale-write') {
            toast({
              tone: 'warning',
              title: 'This file changed while you were editing',
              body: `${errorMessage(error)} Reload to see the latest version (your unsaved typing will be replaced).`,
              sticky: true,
              action: {
                label: 'Reload latest',
                run: () => {
                  savedHash.current = null;
                  pending.current = null;
                  set((s) => ({ previewVersions: { ...s.previewVersions, [targetLine]: (s.previewVersions[targetLine] ?? 0) + 1 } }));
                },
              },
            });
          } else {
            pending.current = pending.current ?? text;
            toast({ tone: 'error', title: 'Could not save', body: `${errorMessage(error)} Your text is still in the editor.` });
          }
        } finally {
          inFlight.current = false;
          if (pending.current !== null) write(projectId, targetLine, targetPath);
        }
      }, 450),
    [],
  );
  useEffect(() => () => write.flush(), [fileKey]);

  const onChange = (text: string): void => {
    if (!path) return;
    noteUserEdit(project.id, line.id, path);
    pending.current = text;
    set({ save: { status: 'saving', message: null, at: Date.now() } });
    write(project.id, line.id, path);
  };

  const onSave = (): void => {
    write.flush();
    if (isShared && get().project?.shared.hasDraft) setTimeout(() => void saveShared(), 120);
  };

  const resetFile = (): void => {
    if (!path) return;
    openDialog({
      kind: 'confirm',
      title: isShared ? `Discard draft changes to ${path}?` : `Reset ${path} to the shared version?`,
      body: isShared ? 'The file goes back to how it was at the last shared save.' : `${line.name}’s own changes to this file are replaced by the shared version. You can get them back from History.`,
      confirmLabel: isShared ? 'Discard changes' : 'Reset file',
      destructive: true,
      onConfirm: async () => {
        try {
          write.cancel();
          pending.current = null;
          await call('files.reset', { projectId: project.id, lineId: line.id, path, to: isShared ? 'saved' : 'shared' });
          savedHash.current = null;
          set((s) => ({ previewVersions: { ...s.previewVersions, [line.id]: (s.previewVersions[line.id] ?? 0) + 1 } }));
        } catch (error) {
          toast({ tone: 'error', title: 'Could not reset the file', body: errorMessage(error) });
        }
      },
    });
  };

  const openMatch = (m: SearchMatch): void => {
    set((s) => ({ selectedFile: { ...s.selectedFile, [line.id]: m.path }, editorReveal: { path: m.path, line: m.line, column: m.column, at: Date.now() } }));
  };

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const splitValue = liveSplit ?? split;
  const canReset = entry && (isShared ? entry.inDraft : entry.differsFromShared);

  return (
    <div className="edit">
      <div className={cx('edit-target', isShared && 'is-shared')} style={{ ['--line-color' as string]: `var(--alt-${line.color})` }} role="status">
        <ColorDot color={line.color} shared={isShared} />
        {isShared ? (
          <span>
            <strong>Editing the Shared version.</strong> Saved shared changes go to {plural(followers, 'following alternative')}. Edits are kept as a draft until you save.
          </span>
        ) : (
          <span>
            <strong>Editing {line.name}.</strong> Changes save automatically and stay in this alternative only.
          </span>
        )}
        <span className="bar-spacer" />
        {isShared && project.shared.hasDraft && (
          <Button variant="shared" size="sm" icon="check" onClick={() => void saveShared()}>
            Save shared change
          </Button>
        )}
      </div>

      <div ref={bodyRef} className="edit-body" style={{ gridTemplateColumns: `${splitValue}fr 12px ${1 - splitValue}fr` }}>
        <section className="editor-pane material-solid" aria-label="Source editor">
          <div className="editor-head">
            <button type="button" className="file-crumb" onClick={() => openDialog({ kind: 'quick-open' })} title="Quick open (Ctrl+P)">
              <Icon name="file" size={14} />
              <span>{path ?? 'No file'}</span>
              <Icon name="chevronDown" size={12} />
            </button>
            {entry && <span className="muted small file-meta">{content?.language ?? entry.language} · {bytes(entry.size)}</span>}
            <span className="bar-spacer" />
            <IconButton icon="search" size="sm" label="Search in files (Ctrl+Shift+F)" active={searchOpen} onClick={() => setSearchOpen((v) => !v)} />
            <IconButton icon="plus" size="sm" label="New file" onClick={() => openDialog({ kind: 'new-file', lineId: line.id })} />
            {canReset && (
              <Button size="sm" variant="quiet" icon="restore" onClick={resetFile}>
                {isShared ? 'Discard changes' : 'Reset to shared'}
              </Button>
            )}
          </div>
          {searchOpen && <SearchPanel projectId={project.id} lineId={line.id} onOpen={openMatch} />}
          {locked && (
            <div className="locked-banner" role="alert">
              <Icon name="conflict" size={15} />
              <span>This file has a conflict waiting for a decision, so it’s read-only for now.</span>
              <Button size="sm" variant="primary" onClick={() => openDialog({ kind: 'conflicts', lineId: line.id })}>
                Resolve conflict
              </Button>
            </div>
          )}
          <div className="editor-surface">
            {!path ? (
              <EmptyState icon="file" title="No file selected" body="Choose a file from the sidebar or press Ctrl+P." />
            ) : content && content.text !== null && content.path === path ? (
              <CodeEditor
                uri={`mv://${project.id}/${line.id}/${path}`}
                text={content.text}
                language={content.language}
                readOnly={locked}
                onChange={onChange}
                onSave={onSave}
                diagnostics={diagnostics}
                reveal={reveal && reveal.path === path ? reveal : null}
                label={`${path} in ${line.name}`}
              />
            ) : content && content.path === path ? (
              <div className="binary-view">
                {content.dataUrl ? <img src={content.dataUrl} alt={path} /> : <Icon name="file" size={32} />}
                <p className="muted">
                  {path} · {bytes(content.size)}. Binary files can’t be edited here; replace them in the source folder and re-import, or combine from another alternative.
                </p>
              </div>
            ) : (
              <div className="editor-loading" />
            )}
          </div>
          <footer className="editor-status">
            <span className={cx('status-item', errorCount > 0 && 'is-error')}>
              <button type="button" className="link-btn" onClick={() => setShowProblems((v) => !v)} aria-expanded={showProblems}>
                <Icon name={errorCount ? 'error' : 'check'} size={13} /> {diagnostics.length === 0 ? 'No parsing problems' : `${plural(diagnostics.length, 'parsing problem')}`}
              </button>
            </span>
            <span className={cx('status-item', runtimeErrors.length > 0 && 'is-warning')}>
              <Icon name={runtimeErrors.length ? 'warning' : 'play'} size={13} /> {runtimeErrors.length === 0 ? 'Preview running' : plural(runtimeErrors.length, 'preview error')}
            </span>
          </footer>
          {showProblems && (diagnostics.length > 0 || runtimeErrors.length > 0) && (
            <div className="problems-list">
              {diagnostics.map((d, i) => (
                <button key={`d${i}`} type="button" className="problem" onClick={() => path && set({ editorReveal: { path, line: d.line, column: d.column, at: Date.now() } })}>
                  <Icon name={d.severity === 'error' ? 'error' : 'warning'} size={13} />
                  <span className="problem-src">{d.source.toUpperCase()}</span>
                  <span>
                    {d.message} <span className="muted">· line {d.line}</span>
                  </span>
                </button>
              ))}
              {runtimeErrors.map((e, i) => (
                <div key={`r${i}`} className="problem">
                  <Icon name="warning" size={13} />
                  <span className="problem-src">PREVIEW</span>
                  <span>
                    {e.message}
                    {e.source && <span className="muted"> · {e.source}{e.line ? `:${e.line}` : ''}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
        <Splitter
          label="Resize editor and preview"
          value={splitValue * 1000}
          min={250}
          max={780}
          step={25}
          onChange={(v) => setLiveSplit(v / 1000)}
          onCommit={(v) => {
            setLiveSplit(null);
            void updateSettings({ editorSplit: Math.round(v) / 1000 });
          }}
        />
        {appPreview ? (
          <section className="edit-preview" aria-label="App preview">
            {appPreview}
          </section>
        ) : (
        <section className="edit-preview" aria-label="Live preview">
          <div className="preview-bar">
            <SegmentedControl size="sm" label="Preview size" options={VIEWPORT_OPTIONS} value={viewport} onChange={(v) => set((s) => ({ cardViewports: { ...s.cardViewports, [`edit:${line.id}`]: v } }))} />
            <span className="muted small">Live · refreshes as you type</span>
            <span className="bar-spacer" />
            <IconButton icon="restore" size="sm" label="Reload preview" onClick={() => set((s) => ({ previewVersions: { ...s.previewVersions, [line.id]: (s.previewVersions[line.id] ?? 0) + 1 } }))} />
          </div>
          <div className="edit-preview-frame">
            <PreviewFrame
              projectId={project.id}
              contentRef={lineRef(line.id)}
              version={version}
              viewport={viewport}
              interactive
              title={`${line.name} live preview`}
              onRuntimeError={(e) => setRuntimeErrors((list) => [...list.slice(-19), e])}
              onBlockedNavigation={(url) => toast({ tone: 'info', title: 'External link blocked in preview', body: url })}
            />
          </div>
        </section>
        )}
      </div>
    </div>
  );
}
