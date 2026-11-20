import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent, type KeyboardEvent } from 'react';
import { useStudio, openDialog } from '../state/store';
import { selectLine, setWorkspace } from '../state/actions';
import { PreviewFrame } from '../components/PreviewFrame';
import { ColorDot, IconButton, StatusBadge } from '../components/primitives';
import { Icon } from '../components/Icon';
import { cx, lineRef } from '../lib/util';
import { SHARED_LINE_ID, type LineView, type ProjectView } from '../../shared/types';

const NODE_W = 236;
const NODE_H = 176;
const COL_W = 320;
const ROW_H = 212;

interface GraphNode {
  id: string;
  kind: 'shared' | 'alternative' | 'checkpoint';
  line?: LineView;
  label: string;
  parent: string | null;
  col: number;
  row: number;
}

function layout(project: ProjectView): GraphNode[] {
  const nodes = new Map<string, GraphNode>();
  nodes.set(SHARED_LINE_ID, { id: SHARED_LINE_ID, kind: 'shared', line: project.shared, label: 'Shared version', parent: null, col: 0, row: 0 });
  const altIds = new Set(project.alternatives.map((a) => a.id));
  for (const alt of project.alternatives) {
    const c = alt.createdFrom;
    let parent: string = SHARED_LINE_ID;
    if ((c.kind === 'alternative' || c.kind === 'combine') && c.lineId && altIds.has(c.lineId)) parent = c.lineId;
    if (c.kind === 'checkpoint' && c.checkpointId) {
      const cpId = `cp:${c.checkpointId}:${c.lineId ?? ''}`;
      if (!nodes.has(cpId)) {
        nodes.set(cpId, { id: cpId, kind: 'checkpoint', label: c.checkpointName ?? 'Checkpoint', parent: c.lineId && (altIds.has(c.lineId) || c.lineId === SHARED_LINE_ID) ? c.lineId : SHARED_LINE_ID, col: 0, row: 0 });
      }
      parent = cpId;
    }
    nodes.set(alt.id, { id: alt.id, kind: 'alternative', line: alt, label: alt.name, parent, col: 0, row: 0 });
  }
  const children = new Map<string, GraphNode[]>();
  for (const n of nodes.values()) {
    if (!n.parent) continue;
    const list = children.get(n.parent) ?? [];
    list.push(n);
    children.set(n.parent, list);
  }
  let nextRow = 0;
  const place = (node: GraphNode, col: number): void => {
    node.col = col;
    const kids = children.get(node.id) ?? [];
    if (kids.length === 0) {
      node.row = nextRow++;
      return;
    }
    for (const k of kids) place(k, col + 1);
    node.row = (kids[0]!.row + kids[kids.length - 1]!.row) / 2;
  };
  place(nodes.get(SHARED_LINE_ID)!, 0);
  return [...nodes.values()];
}

export function ProjectGraph() {
  const project = useStudio((s) => s.project)!;
  const selectedLineId = useStudio((s) => s.selectedLineId);
  const limit = useStudio((s) => s.settings.livePreviewLimit);
  const versions = useStudio((s) => s.previewVersions);
  const nodes = useMemo(() => layout(project), [project]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [animate, setAnimate] = useState(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const pos = (n: GraphNode): { x: number; y: number } => ({ x: n.col * COL_W, y: n.row * ROW_H + (n.kind === 'checkpoint' ? NODE_H / 2 - 22 : 0) });
  const size = (n: GraphNode): { w: number; h: number } => (n.kind === 'checkpoint' ? { w: 176, h: 44 } : { w: NODE_W, h: NODE_H });

  const fit = (): void => {
    const el = containerRef.current;
    if (!el || nodes.length === 0) return;
    const maxX = Math.max(...nodes.map((n) => pos(n).x + size(n).w));
    const maxY = Math.max(...nodes.map((n) => pos(n).y + size(n).h));
    const k = Math.min(1.2, Math.max(0.3, Math.min((el.clientWidth - 80) / maxX, (el.clientHeight - 80) / maxY)));
    setAnimate(true);
    setView({ k, x: (el.clientWidth - maxX * k) / 2, y: (el.clientHeight - maxY * k) / 2 });
  };

  useEffect(() => {
    fit();
  }, [nodes.length]);

  const zoomBy = (factor: number, cx?: number, cy?: number, smooth = true): void => {
    const el = containerRef.current;
    if (!el) return;
    const px = cx ?? el.clientWidth / 2;
    const py = cy ?? el.clientHeight / 2;
    setAnimate(smooth);
    setView((v) => {
      const k = Math.min(2, Math.max(0.25, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey) {
      const r = e.currentTarget.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, false);
    } else {
      setAnimate(false);
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('.graph-node')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    setAnimate(false);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    setView((v) => ({ ...v, x: drag.current!.vx + e.clientX - drag.current!.x, y: drag.current!.vy + e.clientY - drag.current!.y }));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('.graph-node')) return;
    const step = 60;
    if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-') zoomBy(1 / 1.2);
    else if (e.key === '0') fit();
    else if (e.key === 'ArrowLeft') setView((v) => ({ ...v, x: v.x + step }));
    else if (e.key === 'ArrowRight') setView((v) => ({ ...v, x: v.x - step }));
    else if (e.key === 'ArrowUp') setView((v) => ({ ...v, y: v.y + step }));
    else if (e.key === 'ArrowDown') setView((v) => ({ ...v, y: v.y - step }));
    else return;
    e.preventDefault();
  };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const liveIds = new Set([selectedLineId, ...nodes.filter((n) => n.line).map((n) => n.id)].filter((id, i, a) => a.indexOf(id) === i).slice(0, limit));

  return (
    <div className="graph-wrap">
      <div
        ref={containerRef}
        className="graph-canvas"
        tabIndex={0}
        aria-label="Project graph. Drag or use arrow keys to pan, plus and minus to zoom, 0 to fit."
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={onKey}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.k}px ${24 * view.k}px` }}
      >
        <div className={cx('graph-layer', animate && 'is-animated')} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="graph-edges" width={4000} height={4000} aria-hidden="true">
            {nodes
              .filter((n) => n.parent)
              .map((n) => {
                const p = byId.get(n.parent!)!;
                const a = pos(p);
                const b = pos(n);
                const sa = size(p);
                const sb = size(n);
                const x1 = a.x + sa.w;
                const y1 = a.y + sa.h / 2;
                const x2 = b.x;
                const y2 = b.y + sb.h / 2;
                const mx = (x1 + x2) / 2;
                return <path key={n.id} d={`M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} className={cx('graph-edge', n.line?.createdFrom.kind === 'combine' && 'is-combine')} style={n.line ? { ['--line-color' as string]: `var(--alt-${n.line.color})` } : undefined} />;
              })}
          </svg>
          {nodes.map((n) => {
            const { x, y } = pos(n);
            if (n.kind === 'checkpoint') {
              return (
                <div key={n.id} className="graph-node graph-checkpoint" style={{ left: x, top: y }} title="Checkpoint this alternative was created from">
                  <Icon name="checkpoint" size={14} />
                  <span>{n.label}</span>
                </div>
              );
            }
            const line = n.line!;
            return (
              <div key={n.id} data-live={`universe:${line.id}`} className={cx('graph-node', 'graph-line', line.id === selectedLineId && 'is-selected', line.kind === 'shared' && 'is-shared')} style={{ left: x, top: y, width: NODE_W, ['--line-color' as string]: `var(--alt-${line.color})` }}>
                <button
                  type="button"
                  className="graph-node-button"
                  onClick={() => selectLine(line.id)}
                  onDoubleClick={() => (selectLine(line.id), setWorkspace('build'))}
                  aria-label={`${line.name}. ${line.kind === 'alternative' && line.following ? 'Follows shared changes.' : ''} Press Enter to select.`}
                >
                  <div className="graph-thumb">
                    {liveIds.has(line.id) ? (
                      <PreviewFrame projectId={project.id} contentRef={lineRef(line.id)} version={versions[line.id] ?? 0} viewport="desktop" title={`${line.name} thumbnail`} />
                    ) : (
                      <div className="graph-thumb-placeholder">
                        <ColorDot color={line.color} shared={line.kind === 'shared'} size={16} />
                      </div>
                    )}
                  </div>
                  <div className="graph-label">
                    <ColorDot color={line.color} shared={line.kind === 'shared'} />
                    <span className="graph-name">{line.name}</span>
                  </div>
                </button>
                <div className="graph-meta">
                  <StatusBadge line={line} compact />
                  {line.kind === 'alternative' && line.following && (
                    <span className="follow-chip" title="Receives shared changes">
                      <Icon name="link" size={11} /> shared
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="graph-controls material-toolbar" role="toolbar" aria-label="Graph view">
        <IconButton icon="zoomOut" size="sm" label="Zoom out" onClick={() => zoomBy(1 / 1.2)} />
        <span className="graph-zoom" aria-live="polite">
          {Math.round(view.k * 100)}%
        </span>
        <IconButton icon="zoomIn" size="sm" label="Zoom in" onClick={() => zoomBy(1.2)} />
        <IconButton icon="fit" size="sm" label="Fit all" onClick={fit} />
      </div>
      <div className="graph-legend material-toolbar">
        <span>
          <span className="legend-line" /> created from
        </span>
        <span>
          <span className="legend-line is-combine" /> combined
        </span>
        <span>
          <Icon name="link" size={11} /> follows shared changes
        </span>
        <button type="button" className="link-btn" onClick={() => openDialog({ kind: 'create-alternative', from: lineRef(selectedLineId) })}>
          New alternative from selection
        </button>
      </div>
    </div>
  );
}
