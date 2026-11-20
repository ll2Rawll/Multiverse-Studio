import { useMemo, useState, type ReactElement } from 'react';
import { Icon } from '../components/Icon';
import { cx } from '../lib/util';
import type { FileEntry } from '../../shared/types';

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: FileEntry[];
}

function buildTree(files: FileEntry[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let child = node.folders.get(name);
      if (!child) {
        child = { name, path: parts.slice(0, i + 1).join('/'), folders: new Map(), files: [] };
        node.folders.set(name, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  return root;
}

function fileIcon(path: string): string {
  if (/\.(png|jpe?g|gif|webp|svg|ico|avif)$/i.test(path)) return 'image';
  if (/\.(html?|css|m?js|json)$/i.test(path)) return 'code';
  return 'file';
}

/** Collapsible file tree with change, draft and conflict markers (text + icon, not colour alone). */
export function FileTree({ files, selected, onSelect, kind }: { files: FileEntry[]; selected: string | null; onSelect: (path: string) => void; kind: 'shared' | 'alternative' }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['fonts']));
  const toggle = (path: string): void =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderFolder = (folder: Folder, depth: number): ReactElement[] => {
    const rows: ReactElement[] = [];
    for (const child of [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const isOpen = !collapsed.has(child.path);
      rows.push(
        <li key={`d:${child.path}`} role="treeitem" aria-expanded={isOpen} aria-level={depth + 1}>
          <button type="button" className="tree-row tree-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(child.path)}>
            <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={13} />
            <Icon name="folder" size={15} />
            <span className="tree-name">{child.name}</span>
          </button>
          {isOpen && <ul role="group">{renderFolder(child, depth + 1)}</ul>}
        </li>,
      );
    }
    for (const file of folder.files) {
      const name = file.path.split('/').pop()!;
      const marker = file.conflicted ? 'conflict' : file.inDraft ? 'draft' : kind === 'alternative' && file.differsFromShared ? 'changed' : null;
      const markerLabel = marker === 'conflict' ? 'Has a conflict' : marker === 'draft' ? 'Unsaved shared edit' : marker === 'changed' ? 'Differs from the shared version' : '';
      rows.push(
        <li key={`f:${file.path}`} role="treeitem" aria-selected={selected === file.path} aria-level={depth + 1}>
          <button type="button" data-live={`file:${file.path}`} className={cx('tree-row', selected === file.path && 'is-selected')} style={{ paddingLeft: 22 + depth * 14 }} onClick={() => onSelect(file.path)} title={file.path}>
            <Icon name={fileIcon(file.path)} size={15} />
            <span className="tree-name">{name}</span>
            {marker && (
              <span className={cx('tree-marker', `marker-${marker}`)} title={markerLabel}>
                {marker === 'conflict' ? <Icon name="conflict" size={12} /> : marker === 'draft' ? 'D' : 'M'}
                <span className="sr-only">{markerLabel}</span>
              </span>
            )}
          </button>
        </li>,
      );
    }
    return rows;
  };

  return (
    <ul className="file-tree" role="tree" aria-label="Files">
      {renderFolder(tree, 0)}
    </ul>
  );
}
