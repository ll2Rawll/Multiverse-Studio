import { useStudio, set, openDialog } from '../state/store';
import { discardSharedDraft, exportRef, publishRef, saveShared, selectLine } from '../state/actions';
import { call } from '../lib/api';
import { Button, ColorDot, IconButton } from '../components/primitives';
import { Menu, MoreMenu } from '../components/Menu';
import { Icon } from '../components/Icon';
import { allLines, cx, lineRef, plural, relativeTime } from '../lib/util';
import { useInterval } from '../lib/hooks';
import { useState } from 'react';
import { SHARED_LINE_ID } from '../../shared/types';
import { CommandField } from '../assistant/CommandField';

function SaveStatus() {
  const save = useStudio((s) => s.save);
  const shared = useStudio((s) => s.project!.shared);
  const [, tick] = useState(0);
  useInterval(() => tick((n) => n + 1), 15000);
  let text = 'All changes saved';
  let tone = 'ok';
  if (save.status === 'saving') {
    text = 'Saving…';
    tone = 'busy';
  } else if (save.status === 'error') {
    text = 'Save failed';
    tone = 'error';
  } else if (shared.hasDraft) {
    text = 'Shared draft not saved yet';
    tone = 'draft';
  } else if (save.at) {
    text = `Saved ${relativeTime(new Date(save.at).toISOString())}`;
  }
  return (
    <span className={cx('save-status', `save-${tone}`)} role="status" aria-live="polite" title={save.message ?? text}>
      <Icon name={tone === 'error' ? 'error' : tone === 'draft' ? 'pencil' : 'check'} size={13} />
      <span>{text}</span>
    </span>
  );
}

export function Toolbar() {
  const project = useStudio((s) => s.project)!;
  const workspace = useStudio((s) => s.workspace);
  const selectedLineId = useStudio((s) => s.selectedLineId);
  const sidebarCollapsed = useStudio((s) => s.sidebarCollapsed);
  const inspectorCollapsed = useStudio((s) => s.inspectorCollapsed);
  const lines = allLines(project);
  const active = lines.find((l) => l.id === selectedLineId) ?? project.shared;
  const isShared = active.id === SHARED_LINE_ID;
  const followers = project.alternatives.filter((a) => a.following).length;

  return (
    <header className="toolbar-row drag-region">
      <div className="toolbar material-toolbar">
        <IconButton icon="sidebar" label={sidebarCollapsed ? 'Show sidebar (Ctrl+B)' : 'Hide sidebar (Ctrl+B)'} active={!sidebarCollapsed} onClick={() => set({ sidebarCollapsed: !sidebarCollapsed })} />
        <Menu
          label="Active version"
          align="start"
          items={lines.map((l) => ({ label: l.name, icon: l.kind === 'shared' ? 'shared' : 'branch', checked: l.id === active.id, onSelect: () => selectLine(l.id) }))}
          trigger={(props) => (
            <button type="button" className={cx('active-chip', isShared && 'is-shared')} style={{ ['--line-color' as string]: `var(--alt-${active.color})` }} title="Choose the active version" {...props}>
              <ColorDot color={active.color} shared={isShared} />
              <span>{active.name}</span>
              <Icon name="chevronDown" size={13} />
            </button>
          )}
        />
        <CommandField />
        <div className="toolbar-actions">
          {isShared && project.shared.hasDraft ? (
            <>
              <Button variant="shared" icon="check" size="sm" onClick={() => void saveShared()} title="Save the shared change (Ctrl+S)">
                Save shared change{followers > 0 ? ` · ${followers}` : ''}
              </Button>
              <IconButton
                icon="undo"
                size="sm"
                label="Discard shared draft"
                onClick={() =>
                  openDialog({
                    kind: 'confirm',
                    title: 'Discard the shared draft?',
                    body: `Unsaved edits to ${plural(project.shared.draftFiles.length, 'file')} in the Shared version will be removed. Alternatives are not affected.`,
                    confirmLabel: 'Discard draft',
                    destructive: true,
                    onConfirm: () => discardSharedDraft(),
                  })
                }
              />
            </>
          ) : workspace === 'explore' ? (
            <Button size="sm" icon="plus" onClick={() => openDialog({ kind: 'create-alternative', from: lineRef(active.id) })}>
              New alternative
            </Button>
          ) : null}
        </div>
        <SaveStatus />
        <MoreMenu
          label="More actions"
          items={[
            { label: 'Create checkpoint…', icon: 'checkpoint', onSelect: () => openDialog({ kind: 'checkpoint' }) },
            { label: `Export ${active.name}…`, icon: 'export', onSelect: () => exportRef(lineRef(active.id), active.name) },
            { label: `Publish ${active.name}…`, icon: 'globe', onSelect: () => publishRef(lineRef(active.id)) },
            { label: 'Compare with Shared version', icon: 'compare', disabled: isShared, onSelect: () => set({ workspace: 'compare', compare: { mode: 'compare', left: lineRef(SHARED_LINE_ID), right: lineRef(active.id), view: 'previews', file: null } }) },
            { kind: 'separator' },
            { label: 'Quick open file…', icon: 'search', hint: 'Ctrl+P', onSelect: () => openDialog({ kind: 'quick-open' }) },
            { label: 'Show working copy folder', icon: 'folder', onSelect: () => void call('projects.reveal', { projectId: project.id }).catch(() => openDialog({ kind: 'project-info' })) },
            { label: 'Project details', icon: 'info', onSelect: () => openDialog({ kind: 'project-info' }) },
            { label: 'Settings', icon: 'settings', onSelect: () => openDialog({ kind: 'settings' }) },
          ]}
        />
        <IconButton icon="inspector" label={inspectorCollapsed ? 'Show inspector (Ctrl+.)' : 'Hide inspector (Ctrl+.)'} active={!inspectorCollapsed} onClick={() => set({ inspectorCollapsed: !inspectorCollapsed })} />
      </div>
    </header>
  );
}
