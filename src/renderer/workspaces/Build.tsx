import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStudio, set } from '../state/store';
import { Edit } from './Edit';
import { Splitter } from '../components/Splitter';
import { Button, IconButton, SegmentedControl } from '../components/primitives';
import { Menu } from '../components/Menu';
import { Icon } from '../components/Icon';
import { VIEWPORT_OPTIONS } from './PreviewCard';
import { VIEWPORTS, cx, type Viewport } from '../lib/util';
import {
  buildKey,
  bringChangesIn,
  clearOutput,
  installDependencies,
  refreshBuild,
  runCommand,
  runScript,
  selectProcess,
  setPanelHeight,
  startDevServer,
  stopProcess,
  togglePanel,
  useBuild,
} from '../state/build';
import type { BuildProcessView, BuildStateView } from '../../shared/build';

const STATUS_TEXT: Record<BuildProcessView['status'], string> = {
  running: 'Running',
  starting: 'Starting',
  ready: 'Running',
  exited: 'Finished',
  failed: 'Failed',
};

function StatusDot({ status }: { status: BuildProcessView['status'] }) {
  return <span className={cx('proc-dot', `is-${status}`)} aria-hidden="true" />;
}

/** The app's own dev server, shown in place of the static preview. */
function DevServerPreview({ projectId, lineId, state }: { projectId: string; lineId: string; state: BuildStateView }) {
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [reload, setReload] = useState(0);
  const server = [...state.processes].reverse().find((p) => p.kind === 'dev-server');
  const live = server && (server.status === 'ready' || server.status === 'starting') ? server : null;
  const width = viewport === 'desktop' ? '100%' : `${VIEWPORTS[viewport].width}px`;

  return (
    <>
      <div className="preview-bar">
        <SegmentedControl size="sm" label="Preview size" options={VIEWPORT_OPTIONS} value={viewport} onChange={setViewport} />
        <span className="muted small dev-url">{live?.status === 'ready' ? live.url : 'Dev server'}</span>
        <span className="bar-spacer" />
        {live?.status === 'ready' && <IconButton icon="restore" size="sm" label="Reload app preview" onClick={() => setReload((n) => n + 1)} />}
        {live && <IconButton icon="stop" size="sm" label="Stop the dev server" onClick={() => void stopProcess(projectId, lineId, live.id)} />}
      </div>
      <div className="edit-preview-frame dev-preview">
        {live?.status === 'ready' && live.url ? (
          <div className="dev-frame-wrap" style={{ width }}>
            <iframe
              key={`${live.id}:${reload}`}
              className="dev-frame"
              title="App preview from the dev server"
              src={live.url}
              sandbox="allow-scripts allow-forms allow-same-origin allow-modals"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : live?.status === 'starting' ? (
          <div className="dev-empty" role="status">
            <span className="spinner" aria-hidden="true" />
            <p>Starting the dev server…</p>
            <Button size="sm" variant="quiet" icon="terminal" onClick={() => (selectProcess(projectId, lineId, live.id), togglePanel(true))}>
              Show output
            </Button>
          </div>
        ) : !state.dependenciesInstalled ? (
          <div className="dev-empty">
            <Icon name="terminal" size={26} />
            <h3>Install dependencies to run this app</h3>
            <p className="muted">Runs <code>npm install</code> in this version’s run folder. Packages download from the npm registry.</p>
            <Button variant="primary" icon="play" onClick={() => void installDependencies(projectId, lineId)}>
              Install dependencies
            </Button>
          </div>
        ) : (
          <div className="dev-empty">
            <Icon name="play" size={26} />
            <h3>Preview the running app</h3>
            <p className="muted">
              Starts <code>npm run {state.devScript}</code> on a free local port. Only this window can open it.
            </p>
            <Button variant="primary" icon="play" onClick={() => void startDevServer(projectId, lineId)}>
              Start dev server
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function Output({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      className="build-output"
      tabIndex={0}
      aria-label="Command output"
      aria-live="off"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {text || <span className="muted">No output yet.</span>}
    </pre>
  );
}

function CommandInput({ projectId, lineId }: { projectId: string; lineId: string }) {
  const history = useBuild((s) => s.history);
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(-1);
  const submit = (): void => {
    const command = value.trim();
    if (!command) return;
    setValue('');
    setCursor(-1);
    void runCommand(projectId, lineId, command);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault();
      const next = Math.min(history.length - 1, cursor + 1);
      setCursor(next);
      setValue(history[next] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = cursor - 1;
      setCursor(Math.max(-1, next));
      setValue(next < 0 ? '' : (history[next] ?? ''));
    }
  };
  return (
    <form className="build-command" onSubmit={(e) => (e.preventDefault(), submit())}>
      <span className="build-prompt" aria-hidden="true">
        ›
      </span>
      <input
        className="build-command-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        placeholder="Run a command in this version’s folder, e.g. npm test"
        aria-label="Command"
        spellCheck={false}
        autoComplete="off"
      />
      <Button size="sm" type="submit" disabled={!value.trim()}>
        Run
      </Button>
    </form>
  );
}

function BuildPanel({ projectId, lineId, state }: { projectId: string; lineId: string; state: BuildStateView | undefined }) {
  const open = useBuild((s) => s.panelOpen);
  const selectedId = useBuild((s) => s.selected[buildKey(projectId, lineId)] ?? null);
  const outputs = useBuild((s) => s.outputs);
  const processes = state?.processes ?? [];
  const selected = processes.find((p) => p.id === selectedId) ?? processes[processes.length - 1] ?? null;
  const scripts = Object.keys(state?.scripts ?? {});

  return (
    <section className={cx('build-panel material-solid', !open && 'is-collapsed')} aria-label="Terminal and output">
      <header className="build-panel-head">
        <button type="button" className="build-panel-toggle" aria-expanded={open} onClick={() => togglePanel()} title="Show or hide (Ctrl+J)">
          <Icon name="terminal" size={15} />
          <span>Terminal</span>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        <div className="proc-tabs" role="tablist" aria-label="Processes">
          {processes.map((p) => (
            <div key={p.id} className={cx('proc-tab', p.id === selected?.id && 'is-selected')}>
              <button type="button" role="tab" aria-selected={p.id === selected?.id} onClick={() => selectProcess(projectId, lineId, p.id)} title={`${p.label} · ${STATUS_TEXT[p.status]}${p.exitCode !== null ? ` (exit ${p.exitCode})` : ''}`}>
                <StatusDot status={p.status} />
                <span>{p.kind === 'dev-server' ? 'Dev server' : p.label}</span>
              </button>
              {p.status === 'running' || p.status === 'starting' || p.status === 'ready' ? (
                <IconButton icon="stop" size="sm" label={`Stop ${p.label}`} onClick={() => void stopProcess(projectId, lineId, p.id)} />
              ) : (
                <IconButton icon="close" size="sm" label={`Close ${p.label}`} onClick={() => void stopProcess(projectId, lineId, p.id)} />
              )}
            </div>
          ))}
        </div>
        <span className="bar-spacer" />
        {state?.hasPackageJson && (
          <>
            <Button size="sm" variant="quiet" icon="play" onClick={() => void installDependencies(projectId, lineId)} title="npm install">
              Install
            </Button>
            {scripts.length > 0 && (
              <Menu
                label="Run a script"
                align="end"
                items={scripts.map((s) => ({ label: s, hint: state.scripts[s]!.slice(0, 40), icon: 'play', onSelect: () => void runScript(projectId, lineId, s) }))}
                trigger={(props) => (
                  <Button size="sm" variant="quiet" icon="chevronDown" {...props}>
                    Scripts
                  </Button>
                )}
              />
            )}
          </>
        )}
        <Button size="sm" variant="quiet" icon="upload" onClick={() => void bringChangesIn(projectId, lineId)} title="Copy files that commands created or changed (for example a lockfile) into this version">
          Bring changes in
        </Button>
        {selected && <IconButton icon="trash" size="sm" label="Clear output" onClick={() => clearOutput(selected.id)} />}
      </header>
      {open && (
        <div className="build-panel-body">
          {selected ? (
            <Output text={outputs[selected.id] ?? ''} />
          ) : (
            <div className="build-output build-hint">
              <p>
                Commands run in a copy of this version on your computer, without a shell, and with this app’s keys removed from their environment. Files they create stay in the run folder until you choose <strong>Bring changes in</strong>.
              </p>
              {state && <p className="muted small">Run folder: {state.runFolder}</p>}
            </div>
          )}
          <CommandInput projectId={projectId} lineId={lineId} />
        </div>
      )}
    </section>
  );
}

export function Build() {
  const project = useStudio((s) => s.project)!;
  const lineId = useStudio((s) => s.selectedLineId);
  const version = useStudio((s) => s.previewVersions[s.selectedLineId] ?? 0);
  const key = buildKey(project.id, lineId);
  const state = useBuild((s) => s.states[key]);
  const open = useBuild((s) => s.panelOpen);
  const height = useBuild((s) => s.panelHeight);
  const [liveHeight, setLiveHeight] = useState<number | null>(null);

  useEffect(() => {
    void refreshBuild(project.id, lineId);
  }, [project.id, lineId, version]);

  const isApp = Boolean(state?.devScript);
  const h = liveHeight ?? height;
  return (
    <div className="build" style={{ gridTemplateRows: open ? `minmax(0, 1fr) 12px ${h}px` : 'minmax(0, 1fr) 0 auto' }}>
      <div className="build-main">
        <Edit appPreview={isApp && state ? <DevServerPreview projectId={project.id} lineId={lineId} state={state} /> : undefined} />
      </div>
      {open ? (
        <Splitter
          orientation="horizontal"
          label="Resize terminal"
          value={h}
          min={120}
          max={640}
          invert
          onChange={(v) => setLiveHeight(v)}
          onCommit={(v) => {
            setLiveHeight(null);
            setPanelHeight(v);
          }}
        />
      ) : (
        <span />
      )}
      <BuildPanel projectId={project.id} lineId={lineId} state={state} />
    </div>
  );
}

/** Used by Home to open Build with the panel showing. */
export function openBuild(): void {
  set({ workspace: 'build' });
  togglePanel(true);
}
