import { useEffect, useRef, useState } from 'react';
import { useStudio, set, openDialog, toast } from '../state/store';
import { confirmDeleteAlternative, duplicateAlternative, exportRef, publishRef, selectLine, setFollowing, setWorkspace, startCompare } from '../state/actions';
import { PreviewFrame, type RuntimeError } from '../components/PreviewFrame';
import { ColorDot, IconButton, SegmentedControl, StatusBadge, Button } from '../components/primitives';
import { MoreMenu } from '../components/Menu';
import { Icon } from '../components/Icon';
import { cx, lineRef, plural, type Viewport } from '../lib/util';
import { SHARED_LINE_ID, type LineView } from '../../shared/types';

export const VIEWPORT_OPTIONS = [
  { value: 'desktop' as Viewport, label: 'Desktop', icon: 'desktop', hideLabel: true },
  { value: 'tablet' as Viewport, label: 'Tablet', icon: 'tablet', hideLabel: true },
  { value: 'mobile' as Viewport, label: 'Mobile', icon: 'mobile', hideLabel: true },
];

export function PreviewCard({
  line,
  projectId,
  live,
  onRequestLive,
  onVisible,
  syncGroup,
}: {
  line: LineView;
  projectId: string;
  live: boolean;
  onRequestLive: () => void;
  onVisible: (visible: boolean) => void;
  syncGroup: string | null;
}) {
  const selected = useStudio((s) => s.selectedLineId === line.id);
  const viewport = useStudio((s) => s.cardViewports[line.id] ?? s.viewport);
  const version = useStudio((s) => s.previewVersions[line.id] ?? 0);
  const highlightAt = useStudio((s) => s.highlights[line.id] ?? 0);
  const comparing = useStudio((s) => s.compareSelection.includes(line.id));
  const followers = useStudio((s) => (line.id === SHARED_LINE_ID ? (s.project?.alternatives.filter((a) => a.following).length ?? 0) : 0));
  const [interacting, setInteracting] = useState(false);
  const [errors, setErrors] = useState<RuntimeError[]>([]);
  const ref = useRef<HTMLElement | null>(null);
  const isShared = line.id === SHARED_LINE_ID;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => onVisible(Boolean(entry?.isIntersecting)), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => setErrors([]), [version]);
  useEffect(() => {
    if (!interacting) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setInteracting(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interacting]);

  const toggleCompare = (): void =>
    set((s) => {
      const has = s.compareSelection.includes(line.id);
      const next = has ? s.compareSelection.filter((id) => id !== line.id) : [...s.compareSelection, line.id].slice(-2);
      return { compareSelection: next };
    });

  return (
    <article
      ref={ref}
      data-live={`universe:${line.id}`}
      className={cx('preview-card', selected && 'is-selected', isShared && 'is-shared', interacting && 'is-interacting')}
      style={{ ['--line-color' as string]: `var(--alt-${line.color})` }}
      aria-label={`${line.name} preview`}
    >
      {highlightAt > 0 && <span key={highlightAt} className="flash-ring" aria-hidden="true" />}
      <header className="card-head">
        <button type="button" className="card-title" onClick={() => selectLine(line.id)} aria-pressed={selected}>
          <ColorDot color={line.color} shared={isShared} />
          <span className="card-name">{line.name}</span>
        </button>
        <StatusBadge line={line} compact />
        {isShared && <span className="card-reach">Saved changes reach {plural(followers, 'following alternative')}</span>}
        <div className="card-tools">
          <SegmentedControl
            size="sm"
            label={`${line.name} preview size`}
            options={VIEWPORT_OPTIONS}
            value={viewport}
            onChange={(v) => set((s) => ({ cardViewports: { ...s.cardViewports, [line.id]: v } }))}
          />
          <IconButton
            icon="interact"
            size="sm"
            label={interacting ? 'Stop interacting (Esc)' : 'Interact with this preview'}
            active={interacting}
            disabled={!live}
            onClick={() => {
              selectLine(line.id);
              setInteracting((v) => !v);
            }}
          />
          <label className={cx('compare-check', comparing && 'is-checked')} title="Choose for comparison">
            <input type="checkbox" checked={comparing} onChange={toggleCompare} />
            <Icon name="compare" size={14} />
            <span className="sr-only">Choose {line.name} for comparison</span>
          </label>
          <MoreMenu
            size="sm"
            label={`${line.name} actions`}
            items={[
              { label: 'Open in Build', icon: 'pencil', onSelect: () => (selectLine(line.id), setWorkspace('build')) },
              ...(isShared
                ? []
                : [
                    { label: 'Rename…', icon: 'pencil', onSelect: () => openDialog({ kind: 'rename-alternative', lineId: line.id }) },
                    { label: 'Duplicate', icon: 'copy', onSelect: () => void duplicateAlternative(line.id) },
                  ]),
              { label: 'New alternative from this', icon: 'branch', onSelect: () => openDialog({ kind: 'create-alternative', from: lineRef(line.id), suggestedName: isShared ? undefined : `${line.name} variation` }) },
              ...(isShared ? [] : [{ label: 'Compare with Shared version', icon: 'compare', onSelect: () => startCompare(lineRef(SHARED_LINE_ID), lineRef(line.id)) }]),
              { label: 'Export…', icon: 'export', onSelect: () => exportRef(lineRef(line.id), line.name) },
              { label: 'Publish…', icon: 'globe', onSelect: () => publishRef(lineRef(line.id)) },
              ...(isShared
                ? []
                : [
                    { kind: 'separator' as const },
                    line.following
                      ? { label: 'Pause shared changes', icon: 'pause', onSelect: () => void setFollowing(line.id, false) }
                      : { label: 'Resume shared changes', icon: 'play', onSelect: () => void setFollowing(line.id, true) },
                    { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => confirmDeleteAlternative(line.id, line.name) },
                  ]),
            ]}
          />
        </div>
      </header>
      <div className={cx('card-preview', `vp-${viewport}`)}>
        {live ? (
          <>
            <PreviewFrame
              projectId={projectId}
              contentRef={lineRef(line.id)}
              version={version}
              viewport={viewport}
              interactive={interacting}
              title={`${line.name} — live preview`}
              syncGroup={syncGroup}
              onRuntimeError={(e) => setErrors((list) => [...list.slice(-9), e])}
              onBlockedNavigation={(url) => toast({ tone: 'info', title: 'External link blocked in preview', body: url })}
            />
            {!interacting && (
              <button
                type="button"
                className="preview-select-layer"
                aria-label={`Select ${line.name}. Double-click or use the hand button to interact with the page.`}
                onClick={() => selectLine(line.id)}
                onDoubleClick={() => {
                  selectLine(line.id);
                  setInteracting(true);
                }}
              />
            )}
            {interacting && (
              <div className="interact-banner" role="status">
                <Icon name="interact" size={14} /> Interacting with the page
                <Button size="sm" variant="quiet" onClick={() => setInteracting(false)}>
                  Done
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="preview-paused">
            <Icon name="pause" size={20} />
            <p>Live preview paused to keep things responsive.</p>
            <Button size="sm" onClick={onRequestLive}>
              Show live preview
            </Button>
          </div>
        )}
        {errors.length > 0 && (
          <button type="button" className="preview-error-badge" title={errors.map((e) => e.message).join('\n')} onClick={() => (selectLine(line.id), setWorkspace('build'))}>
            <Icon name="warning" size={13} /> {errors.length === 1 ? '1 preview error' : `${errors.length} preview errors`}
          </button>
        )}
      </div>
    </article>
  );
}
