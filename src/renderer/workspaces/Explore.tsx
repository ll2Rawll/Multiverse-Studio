import { MultiverseHeading } from './MultiverseSwitch';
import { useCallback, useMemo, useState } from 'react';
import { useStudio, set, openDialog } from '../state/store';
import { startCompare, updateSettings } from '../state/actions';
import { Button, EmptyState, SegmentedControl, Toggle } from '../components/primitives';
import { PreviewCard, VIEWPORT_OPTIONS } from './PreviewCard';
import { ProjectGraph } from './ProjectGraph';
import { UpdatesPanel } from './UpdatesPanel';
import { lineRef, plural, type Viewport } from '../lib/util';
import { SHARED_LINE_ID } from '../../shared/types';

export function Explore() {
  const project = useStudio((s) => s.project)!;
  const view = useStudio((s) => s.exploreView);
  const viewport = useStudio((s) => s.viewport);
  const syncScroll = useStudio((s) => s.syncScroll);
  const selectedLineId = useStudio((s) => s.selectedLineId);
  const compareSelection = useStudio((s) => s.compareSelection);
  const limit = useStudio((s) => s.settings.livePreviewLimit);
  const livePriority = useStudio((s) => s.livePriority);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const lines = useMemo(() => [project.shared, ...project.alternatives], [project]);

  const onVisible = useCallback((id: string, isVisible: boolean) => {
    setVisible((prev) => {
      if (prev.has(id) === isVisible) return prev;
      const next = new Set(prev);
      if (isVisible) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Live previews: visible cards only, the selected one and explicitly requested ones first.
  const live = useMemo(() => {
    const ordered = [selectedLineId, ...livePriority, ...lines.map((l) => l.id)].filter((id, i, a) => a.indexOf(id) === i && visible.has(id));
    return new Set(ordered.slice(0, limit));
  }, [selectedLineId, livePriority, lines, visible, limit]);
  const pausedCount = lines.filter((l) => visible.has(l.id) && !live.has(l.id)).length;

  return (
    <div className="explore">
      <div className="workspace-bar">
        <MultiverseHeading />
        <SegmentedControl
          label="Explore view"
          options={[
            { value: 'grid', label: 'Previews', icon: 'grid' },
            { value: 'graph', label: 'Graph', icon: 'graph' },
            { value: 'updates', label: 'Updates', icon: 'sync' },
          ]}
          value={view}
          onChange={(v) => set({ exploreView: v })}
          size="sm"
        />
        {view === 'grid' && (
          <>
            <SegmentedControl<Viewport>
              size="sm"
              label="Preview size for all"
              options={VIEWPORT_OPTIONS.map((o) => ({ ...o, hideLabel: false }))}
              value={viewport}
              onChange={(v) => set({ viewport: v, cardViewports: {} })}
            />
            <div className="bar-toggle">
              <Toggle checked={syncScroll} onChange={(v) => set({ syncScroll: v })} label="Sync scrolling" />
            </div>
          </>
        )}
        <span className="bar-spacer" />
        {pausedCount > 0 && view === 'grid' && (
          <span className="bar-note" title="Each live preview runs a full page. Raise the limit in Settings if your computer handles more.">
            {plural(live.size, 'live preview')} · {pausedCount} paused
            <button type="button" className="link-btn" onClick={() => void updateSettings({ livePreviewLimit: Math.min(12, limit + 2) })}>
              Allow more
            </button>
          </span>
        )}
        {compareSelection.length === 2 && (
          <Button variant="primary" size="sm" icon="compare" onClick={() => startCompare(lineRef(compareSelection[0]!), lineRef(compareSelection[1]!))}>
            Compare selected
          </Button>
        )}
      </div>

      {view === 'graph' ? (
        <ProjectGraph />
      ) : view === 'updates' ? (
        <UpdatesPanel />
      ) : (
        <div className="preview-grid">
          {lines.map((line) => (
            <PreviewCard
              key={line.id}
              line={line}
              projectId={project.id}
              live={live.has(line.id)}
              onRequestLive={() => set((s) => ({ livePriority: [line.id, ...s.livePriority.filter((id) => id !== line.id)] }))}
              onVisible={(v) => onVisible(line.id, v)}
              syncGroup={syncScroll ? `explore:${project.id}` : null}
            />
          ))}
          {project.alternatives.length === 0 && (
            <div className="grid-empty">
              <EmptyState icon="branch" title="Create your first alternative" body="Alternatives start as copies of the Shared version. Change their layout, styling or copy freely — shared edits still reach them.">
                <Button variant="primary" icon="plus" onClick={() => openDialog({ kind: 'create-alternative', from: lineRef(SHARED_LINE_ID) })}>
                  New alternative
                </Button>
              </EmptyState>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
