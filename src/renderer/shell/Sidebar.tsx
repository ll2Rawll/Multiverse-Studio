import { useState } from 'react';
import { useStudio, set, openDialog } from '../state/store';
import { closeProject, confirmDeleteAlternative, createSample, duplicateAlternative, importProject, openProject, selectLine, setFollowing, setWorkspace, startCompare, updateSettings } from '../state/actions';
import { Icon } from '../components/Icon';
import { ColorDot, IconButton, StatusBadge } from '../components/primitives';
import { Menu, MoreMenu } from '../components/Menu';
import { Splitter } from '../components/Splitter';
import { FileTree } from './FileTree';
import { LogoMark } from './Welcome';
import { call } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { cx, lineRef } from '../lib/util';
import { SHARED_LINE_ID, type LineView } from '../../shared/types';

function LineItem({ line, selected }: { line: LineView; selected: boolean }) {
  const highlightAt = useStudio((s) => s.highlights[line.id] ?? 0);
  const isShared = line.kind === 'shared';
  return (
    <li data-live={`universe:${line.id}`} className={cx('line-item', selected && 'is-selected', isShared && 'is-shared')} style={{ ['--line-color' as string]: `var(--alt-${line.color})` }}>
      {highlightAt > 0 && <span key={highlightAt} className="flash-ring" aria-hidden="true" />}
      <button type="button" className="line-main" aria-current={selected ? 'true' : undefined} onClick={() => selectLine(line.id)} onDoubleClick={() => setWorkspace('build')}>
        <ColorDot color={line.color} shared={isShared} />
        <span className="line-text">
          <span className="line-name">{line.name}</span>
          <StatusBadge line={line} compact />
        </span>
      </button>
      <span className="line-actions">
        {isShared ? (
          <MoreMenu
            size="sm"
            label="Shared version actions"
            items={[
              { label: 'Open in Build', icon: 'code', onSelect: () => (selectLine(line.id), setWorkspace('build')) },
              { label: 'New alternative from Shared version', icon: 'plus', onSelect: () => openDialog({ kind: 'create-alternative', from: lineRef(SHARED_LINE_ID) }) },
              { label: 'History', icon: 'history', onSelect: () => (selectLine(line.id), setWorkspace('history')) },
            ]}
          />
        ) : (
          <MoreMenu
            size="sm"
            label={`${line.name} actions`}
            items={[
              { label: 'Open in Build', icon: 'pencil', onSelect: () => (selectLine(line.id), setWorkspace('build')) },
              { label: 'Rename…', icon: 'pencil', onSelect: () => openDialog({ kind: 'rename-alternative', lineId: line.id }) },
              { label: 'Duplicate', icon: 'copy', onSelect: () => void duplicateAlternative(line.id) },
              { label: 'New alternative from this', icon: 'branch', onSelect: () => openDialog({ kind: 'create-alternative', from: lineRef(line.id), suggestedName: `${line.name} variation` }) },
              { label: 'Compare with Shared version', icon: 'compare', onSelect: () => startCompare(lineRef(SHARED_LINE_ID), lineRef(line.id)) },
              { kind: 'separator' },
              line.following
                ? { label: 'Pause shared changes', icon: 'pause', onSelect: () => void setFollowing(line.id, false) }
                : { label: 'Resume shared changes', icon: 'play', onSelect: () => void setFollowing(line.id, true) },
              ...(line.status === 'conflicted' ? [{ label: 'Resolve conflicts…', icon: 'conflict', onSelect: () => openDialog({ kind: 'conflicts', lineId: line.id }) }] : []),
              { kind: 'separator' },
              { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => confirmDeleteAlternative(line.id, line.name) },
            ]}
          />
        )}
      </span>
    </li>
  );
}

function ProjectSwitcher() {
  const project = useStudio((s) => s.project)!;
  const recent = useStudio((s) => s.recent);
  return (
    <Menu
      label="Projects"
      align="start"
      items={[
        { kind: 'heading', label: 'Recent projects' },
        ...recent.slice(0, 6).map((r) => ({ label: r.name, icon: r.available ? 'layers' : 'warning', checked: r.id === project.id, disabled: !r.available || r.id === project.id, onSelect: () => void openProject(r.id) })),
        { kind: 'separator' as const },
        { label: 'Open project…', icon: 'folder', onSelect: () => void importProject() },
        { label: 'Create sample project', icon: 'layers', onSelect: () => void createSample() },
        { label: 'Project details', icon: 'info', onSelect: () => openDialog({ kind: 'project-info' }) },
        { kind: 'separator' as const },
        { label: 'Close project', icon: 'close', onSelect: () => void closeProject() },
      ]}
      trigger={(props) => (
        <button type="button" className="project-switcher" {...props}>
          <LogoMark size={26} />
          <span className="project-switcher-text">
            <span className="project-name">{project.name}</span>
            <span className="project-kind">{project.sourceKind === 'sample' ? 'Sample project' : project.kind === 'app' ? 'App' : project.kind === 'video' ? 'Video project' : 'Website'}</span>
          </span>
          <Icon name="chevronDown" size={14} />
        </button>
      )}
    />
  );
}

export function Sidebar() {
  const project = useStudio((s) => s.project)!;
  const selectedLineId = useStudio((s) => s.selectedLineId);
  const width = useStudio((s) => s.settings.sidebarWidth);
  const selectedFile = useStudio((s) => s.selectedFile[s.selectedLineId] ?? null);
  const [filesOpen, setFilesOpen] = useState(true);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const selected = selectedLineId === SHARED_LINE_ID ? project.shared : project.alternatives.find((a) => a.id === selectedLineId) ?? project.shared;
  const files = useAsync(() => call('files.list', { projectId: project.id, ref: lineRef(selected.id) }), [project.id, selected.id, project.updatedAt], filesOpen);
  const sample = project.sourceKind === 'sample';

  return (
    <aside className="sidebar material-nav" aria-label="Project navigation" style={liveWidth ? { ['--sidebar-w' as string]: `${liveWidth}px` } : undefined}>
      <div className="sidebar-head drag-region">
        <ProjectSwitcher />
      </div>
      <div className="sidebar-scroll">
        <nav aria-label="Versions" className="sidebar-section">
          <ul className="line-list">
            <LineItem line={project.shared} selected={selectedLineId === SHARED_LINE_ID} />
          </ul>
          <div className="sidebar-subhead">
            <h2>Alternatives</h2>
            <IconButton icon="plus" size="sm" label="Create alternative" onClick={() => openDialog({ kind: 'create-alternative', from: lineRef(selectedLineId) })} />
          </div>
          {project.alternatives.length === 0 ? (
            <p className="sidebar-empty">No alternatives yet. Create one to explore a different direction.</p>
          ) : (
            <ul className="line-list">
              {project.alternatives.map((line) => (
                <LineItem key={line.id} line={line} selected={line.id === selectedLineId} />
              ))}
            </ul>
          )}
        </nav>
        <section className="sidebar-section sidebar-files" aria-labelledby="files-heading">
          <button type="button" className="sidebar-subhead sidebar-toggle" aria-expanded={filesOpen} onClick={() => setFilesOpen((o) => !o)}>
            <Icon name={filesOpen ? 'chevronDown' : 'chevronRight'} size={13} />
            <h2 id="files-heading">Files · {selected.name}</h2>
          </button>
          {filesOpen && files.data && (
            <FileTree
              files={files.data}
              kind={selected.kind}
              selected={selectedFile}
              onSelect={(path) => {
                set((s) => ({ selectedFile: { ...s.selectedFile, [selected.id]: path } }));
                setWorkspace('build');
              }}
            />
          )}
          {filesOpen && files.error && <p className="sidebar-empty">{files.error}</p>}
        </section>
      </div>
      {sample && (
        <footer className="sidebar-foot">
          <IconButton icon="tour" label="Sample tour" onClick={() => set((s) => ({ tour: { ...s.tour, open: true } }))} />
        </footer>
      )}
      <Splitter
        className="sidebar-splitter"
        label="Resize sidebar"
        value={liveWidth ?? width}
        min={200}
        max={380}
        onChange={setLiveWidth}
        onCommit={(v) => {
          setLiveWidth(null);
          void updateSettings({ sidebarWidth: Math.round(v) });
        }}
      />
    </aside>
  );
}
