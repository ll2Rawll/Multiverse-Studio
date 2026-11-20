import { useStudio, openDialog, type RailItem, type Workspace } from '../state/store';
import { setWorkspace } from '../state/actions';
import { Icon } from '../components/Icon';
import { LogoMark } from './Welcome';
import { cx } from '../lib/util';

export const RAIL: { id: RailItem; label: string; icon: string; key: string }[] = [
  { id: 'home', label: 'Home', icon: 'home', key: '1' },
  { id: 'build', label: 'Build', icon: 'code', key: '2' },
  { id: 'design', label: 'Design', icon: 'brush', key: '3' },
  { id: 'video', label: 'Video', icon: 'film', key: '4' },
  { id: 'assets', label: 'Assets', icon: 'stack', key: '5' },
  { id: 'multiverse', label: 'Multiverse', icon: 'multiverse', key: '6' },
  { id: 'history', label: 'History', icon: 'history', key: '7' },
  { id: 'stories', label: 'Stories', icon: 'interact', key: '8' },
];

let lastMultiverse: Workspace = 'explore';

export function railItemFor(workspace: Workspace): RailItem {
  return workspace === 'explore' || workspace === 'compare' ? 'multiverse' : workspace;
}

/** Opens a rail item; Multiverse returns to whichever of its two views was used last. */
export function openRailItem(item: RailItem): void {
  setWorkspace(item === 'multiverse' ? lastMultiverse : item);
}

export function rememberMultiverse(workspace: Workspace): void {
  if (workspace === 'explore' || workspace === 'compare') lastMultiverse = workspace;
}

/** The workspace rail: a floating glass column at the window's leading edge. */
export function Rail() {
  const workspace = useStudio((s) => s.workspace);
  const active = railItemFor(workspace);
  rememberMultiverse(workspace);
  return (
    <nav className="rail material-nav" aria-label="Workspaces">
      <div className="rail-mark" aria-hidden="true">
        <LogoMark size={30} />
      </div>
      <ul className="rail-list">
        {RAIL.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={cx('rail-item', item.id === active && 'is-active')}
              aria-current={item.id === active ? 'page' : undefined}
              title={`${item.label} (Ctrl+${item.key})`}
              onClick={() => openRailItem(item.id)}
            >
              <Icon name={item.icon} size={20} />
              <span>{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="rail-item rail-settings" aria-label="Settings" onClick={() => openDialog({ kind: 'settings' })}>
        <Icon name="settings" size={19} />
        <span>Settings</span>
      </button>
    </nav>
  );
}
