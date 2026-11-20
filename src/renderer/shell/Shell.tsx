import { useStudio, set, get, openDialog } from '../state/store';
import { saveShared } from '../state/actions';
import { Sidebar } from './Sidebar';
import { Toolbar } from './Toolbar';
import { Inspector } from './Inspector';
import { Rail, RAIL, openRailItem } from './Rail';
import { Explore } from '../workspaces/Explore';
import { Home } from '../workspaces/Home';
import { Build } from '../workspaces/Build';
import { Design } from '../workspaces/Design';
import { Video } from '../workspaces/Video';
import { Assets } from '../workspaces/Assets';
import { togglePanel } from '../state/build';
import { CompareCombine } from '../workspaces/CompareCombine';
import { History } from '../workspaces/History';
import { Stories } from '../workspaces/Stories';
import { Tour } from './Tour';
import { ActivityOverlay, ActivitySlot } from './Activity';
import { useKeyboard } from '../lib/hooks';
import { cx } from '../lib/util';
import { SHARED_LINE_ID } from '../../shared/types';

export function Shell() {
  const workspace = useStudio((s) => s.workspace);
  const sidebarCollapsed = useStudio((s) => s.sidebarCollapsed);
  const inspectorCollapsed = useStudio((s) => s.inspectorCollapsed);
  const sidebarWidth = useStudio((s) => s.settings.sidebarWidth);
  const inspectorWidth = useStudio((s) => s.settings.inspectorWidth);
  const tourOpen = useStudio((s) => s.tour.open);

  useKeyboard((e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || get().dialog) return;
    const railItem = RAIL.find((r) => r.key === e.key);
    if (railItem && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      openRailItem(railItem.id);
    } else if (e.key.toLowerCase() === 'j' && !e.shiftKey && get().workspace === 'build') {
      e.preventDefault();
      togglePanel();
    } else if (e.key.toLowerCase() === 'b' && !e.shiftKey) {
      e.preventDefault();
      set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
    } else if (e.key === '.' && !e.shiftKey) {
      e.preventDefault();
      set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed }));
    } else if (e.key.toLowerCase() === 's' && !e.shiftKey) {
      const project = get().project;
      if (get().selectedLineId === SHARED_LINE_ID && project?.shared.hasDraft) {
        e.preventDefault();
        void saveShared();
      } else if (get().workspace !== 'build') {
        e.preventDefault();
      }
    } else if (e.key.toLowerCase() === 'p' && !e.shiftKey) {
      e.preventDefault();
      openDialog({ kind: 'quick-open' });
    } else if (e.key.toLowerCase() === 'k' && !e.shiftKey) {
      e.preventDefault();
      document.querySelector<HTMLInputElement>('.command-input')?.focus();
    }
  });

  return (
    <div
      className={cx('shell', sidebarCollapsed && 'sidebar-collapsed', inspectorCollapsed && 'inspector-collapsed')}
      style={{ ['--sidebar-w' as string]: `${sidebarWidth}px`, ['--inspector-w' as string]: `${inspectorWidth}px` }}
    >
      <Rail />
      <Sidebar />
      <Toolbar />
      <ActivitySlot />
      <main className={cx('workspace', `workspace-${workspace}`)} aria-label="Workspace" key={workspace}>
        {workspace === 'home' && <Home />}
        {workspace === 'build' && <Build />}
        {workspace === 'design' && <Design />}
        {workspace === 'video' && <Video />}
        {workspace === 'assets' && <Assets />}
        {workspace === 'explore' && <Explore />}
        {workspace === 'compare' && <CompareCombine />}
        {workspace === 'history' && <History />}
        {workspace === 'stories' && <Stories />}
      </main>
      <Inspector />
      {tourOpen && <Tour />}
      <ActivityOverlay />
    </div>
  );
}
