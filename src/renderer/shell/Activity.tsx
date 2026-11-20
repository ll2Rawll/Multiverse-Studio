/**
 * The visible AI activity layer:
 * - the activity pill in a slot reserved under the toolbar (only while there is AI activity);
 * - one target highlight at a time, and the AI pointer only for real pointer interactions;
 * both are drawn from live events and resolved to geometry here, never invented.
 *
 * The overlay never takes pointer events or focus, and it lives in the studio window only: it is
 * never part of previews, exports, story recordings or validation screenshots.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LiveEvent, LivePhase } from '../../shared/live';
import { useStudio, set as setStudio } from '../state/store';
import { updateSettings } from '../state/actions';
import { openTask, setPanel } from '../state/ai';
import { useVideo } from '../state/video';
import { dismissTask, focusTask, forgetReturn, pauseTask, pillText, resumeTask, returnToView, revealEvent, setExpanded, stopTask, useLive, viewActivity, type LiveTask } from '../state/live';
import { editors, previews, GEOMETRY_EVENT, type Rect } from '../live/registry';
import { Icon } from '../components/Icon';
import { Toggle } from '../components/primitives';
import { cx } from '../lib/util';
import { SHARED_LINE_ID } from '../../shared/types';

const PHASE_ICON: Record<LivePhase, string> = {
  planning: 'wand',
  reading: 'search',
  editing: 'pencil',
  executing: 'terminal',
  testing: 'check',
  recording: 'interact',
  rendering: 'export',
  waiting: 'dot',
  paused: 'pause',
  failed: 'warning',
  completed: 'check',
  cancelled: 'stop',
};

const PHASE_WORD: Record<LivePhase, string> = {
  planning: 'Planning',
  reading: 'Reading',
  editing: 'Editing',
  executing: 'Running',
  testing: 'Testing',
  recording: 'Recording',
  rendering: 'Rendering',
  waiting: 'Waiting',
  paused: 'Paused',
  failed: 'Failed',
  completed: 'Done',
  cancelled: 'Stopped',
};

const ago = (iso: string): string => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 5 ? 'now' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
};

/* ---------------------------------------------------------------------------------------------- */
/* Pill                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

function useVisibleTasks(): { tasks: LiveTask[]; focused: LiveTask | null } {
  const projectId = useStudio((s) => s.project?.id ?? null);
  const all = useLive((s) => s.tasks);
  const order = useLive((s) => s.order);
  const focusedId = useLive((s) => s.focused);
  const tasks = order.map((id) => all[id]!).filter((t) => t && t.projectId === projectId);
  const focused = tasks.find((t) => t.id === focusedId) ?? tasks[0] ?? null;
  return { tasks, focused };
}

/** Reserves the row under the toolbar while there is AI activity; the workspace moves once, not per update. */
export function ActivitySlot() {
  const { tasks, focused } = useVisibleTasks();
  const returnTo = useLive((s) => s.returnTo);
  const shown = Boolean(focused) || Boolean(returnTo);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('has-activity', shown);
    return () => document.documentElement.classList.remove('has-activity');
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="activity-slot" role="region" aria-label="AI activity">
      {focused ? <ActivityPill task={focused} tasks={tasks} /> : null}
      {returnTo && (
        <button type="button" className="activity-aside" onClick={returnToView} title="Go back to the view you had before following the AI">
          <Icon name="undo" size={13} />
          <span>Back to your view</span>
          <span
            role="button"
            tabIndex={0}
            className="activity-aside-x"
            aria-label="Stay here"
            onClick={(e) => {
              e.stopPropagation();
              forgetReturn();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                forgetReturn();
              }
            }}
          >
            <Icon name="close" size={11} />
          </span>
        </button>
      )}
    </div>
  );
}

function reviewTask(t: LiveTask): void {
  if (t.id.startsWith('task:') && t.id !== 'task:ai') {
    void openTask(t.id.slice(5));
    setPanel('assistant');
  } else setStudio({ workspace: 'history' });
}

function ActivityPill({ task, tasks }: { task: LiveTask; tasks: LiveTask[] }) {
  const expanded = useLive((s) => s.expanded);
  const selectedLineId = useStudio((s) => s.selectedLineId);
  const follow = useStudio((s) => s.settings.followAi);
  const [chooser, setChooser] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const others = tasks.filter((t) => t.id !== task.id && (t.state === 'running' || t.state === 'paused')).length;
  const done = task.state === 'completed' || task.state === 'cancelled' || task.state === 'failed';
  const elsewhere = Boolean(task.universeId && task.universeId !== selectedLineId);
  const lastTarget = [task.current, ...task.recent].find((e) => e?.target) ?? null;
  const text = pillText(task, selectedLineId);
  const phase: LivePhase = task.state === 'paused' ? 'paused' : task.phase;

  useEffect(() => {
    if (!expanded && !chooser) return;
    const onDown = (e: PointerEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) {
        setExpanded(false);
        setChooser(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setExpanded(false);
        setChooser(false);
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded, chooser]);

  return (
    <div ref={root} className="activity-anchor">
      <div className={cx('activity-pill', `is-${task.state}`, `phase-${phase}`)} data-testid="activity-pill">
        <span className="activity-icon" aria-hidden="true">
          <Icon name={PHASE_ICON[phase]} size={14} />
        </span>
        <button type="button" className="activity-label" onClick={() => reviewTask(task)} title={`${task.label}: ${text}. Open the task details.`}>
          <span className="activity-who">{task.label}</span>
          <span className="activity-what" aria-live="polite">
            {task.state === 'paused' && task.autoPaused ? 'Paused while you edit' : text}
          </span>
        </button>
        {others > 0 && (
          <button type="button" className="activity-count" aria-label={`${others + 1} AI tasks. Choose which one to show.`} aria-expanded={chooser} onClick={() => setChooser((v) => !v)}>
            {others + 1}
          </button>
        )}
        {!done && elsewhere && !follow && lastTarget && (
          <button type="button" className="activity-btn activity-text-btn" onClick={() => viewActivity(task.id)}>
            View activity
          </button>
        )}
        {done ? (
          <DoneActions task={task} />
        ) : (
          <>
            {task.canPause &&
              (task.state === 'paused' ? (
                <button type="button" className="activity-btn" aria-label="Resume" title="Resume" onClick={() => void resumeTask(task.id)}>
                  <Icon name="play" size={13} />
                </button>
              ) : (
                <button type="button" className="activity-btn" aria-label="Pause" title={task.actor === 'ai-app' ? `Pause changes from ${task.label}` : 'Pause after the current step'} onClick={() => void pauseTask(task.id)}>
                  <Icon name="pause" size={13} />
                </button>
              ))}
            <button type="button" className="activity-btn activity-stop" aria-label="Stop" title={task.actor === 'ai-app' ? `Stop changes from ${task.label}` : 'Stop the task (changes so far are kept)'} onClick={() => void stopTask(task.id)}>
              <Icon name="stop" size={13} />
            </button>
          </>
        )}
        <button type="button" className="activity-btn" aria-label={expanded ? 'Hide activity details' : 'Show activity details'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <Icon name="chevronDown" size={13} className={cx('activity-chevron', expanded && 'is-open')} />
        </button>
        {task.progress !== null && !done && (
          <span className="activity-progress" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(task.progress * 100)}>
            <span style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, task.progress))})` }} />
          </span>
        )}
      </div>
      {chooser && (
        <ul className="activity-menu" role="listbox" aria-label="AI tasks">
          {tasks.map((t) => (
            <li key={t.id} role="option" aria-selected={t.id === task.id}>
              <button
                type="button"
                onClick={() => {
                  focusTask(t.id);
                  setChooser(false);
                }}
              >
                <Icon name={PHASE_ICON[t.state === 'paused' ? 'paused' : t.phase]} size={13} />
                <span className="activity-menu-who">{t.label}</span>
                <span className="activity-menu-what">{pillText(t, selectedLineId)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {expanded && <ActivityDetails task={task} tasks={tasks} />}
    </div>
  );
}

function DoneActions({ task }: { task: LiveTask }) {
  const project = useStudio((s) => s.project);
  const recording = task.validation.find((v) => v.target?.kind === 'asset' && v.kind === 'operation.completed');
  const otherUniverse = task.universeId && task.universeId !== SHARED_LINE_ID && project?.alternatives.some((a) => a.id === task.universeId);
  return (
    <span className="activity-done">
      {task.state === 'failed' && task.id.startsWith('task:') && task.id !== 'task:ai' && (
        <button type="button" className="activity-btn activity-text-btn" onClick={() => reviewTask(task)}>
          Retry
        </button>
      )}
      <button type="button" className="activity-btn activity-text-btn" onClick={() => reviewTask(task)}>
        Review
      </button>
      {recording && (
        <button type="button" className="activity-btn activity-text-btn" onClick={() => setStudio({ workspace: 'assets' })}>
          Play
        </button>
      )}
      {task.state === 'completed' && otherUniverse && (
        <button type="button" className="activity-btn activity-text-btn" onClick={() => setStudio((s) => ({ workspace: 'compare', compare: { ...s.compare, mode: 'compare', left: { kind: 'line', lineId: SHARED_LINE_ID }, right: { kind: 'line', lineId: task.universeId! } } }))}>
          Compare
        </button>
      )}
      <button type="button" className="activity-btn" aria-label="Dismiss" title="Dismiss" onClick={() => dismissTask(task.id)}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

function ActivityDetails({ task, tasks }: { task: LiveTask; tasks: LiveTask[] }) {
  const follow = useStudio((s) => s.settings.followAi);
  const background = tasks.filter((t) => t.id !== task.id);
  const current = task.current;
  return (
    <div className="activity-details" role="dialog" aria-label={`${task.label} activity`}>
      <div className="activity-details-head">
        <div>
          <strong>{task.label}</strong>
          <span className="muted small">
            {PHASE_WORD[task.state === 'paused' ? 'paused' : task.phase]}
            {task.universeName ? ` in ${task.universeName}` : ''}
          </span>
        </div>
        <Toggle checked={follow} onChange={(v) => void updateSettings({ followAi: v })} label="Follow AI" />
      </div>
      {current && (
        <section>
          <h3>Now</h3>
          <p className="activity-now">
            {task.state === 'paused' && task.autoPaused ? 'Paused while you edit. It continues when you stop editing.' : current.description}
            {current.scope > 1 ? ` (${current.scope} items)` : ''}
          </p>
          {current.detail && current.kind !== 'operation.completed' && <p className="muted small">{current.detail}</p>}
        </section>
      )}
      {task.errors.length > 0 && (
        <section>
          <h3>Needs attention</h3>
          <ul className="activity-list">
            {task.errors.slice(0, 4).map((e, i) => (
              <li key={`${e.operationId ?? ''}${i}`} className="is-error">
                <Icon name="warning" size={12} />
                <span>
                  {e.description}
                  {e.detail ? ` — ${e.detail.slice(0, 160)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {task.validation.length > 0 && (
        <section>
          <h3>Checks</h3>
          <ul className="activity-list">
            {task.validation.slice(0, 5).map((e, i) => (
              <li key={`${e.operationId ?? ''}${i}`} className={e.kind === 'operation.failed' ? 'is-error' : 'is-ok'}>
                <Icon name={e.kind === 'operation.failed' ? 'warning' : 'check'} size={12} />
                <span>{e.description}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {task.changed.length > 0 && (
        <section>
          <h3>Changed</h3>
          <ul className="activity-list">
            {task.changed.slice(0, 6).map((c) => (
              <li key={c.key}>
                <button type="button" className="activity-link" onClick={() => viewActivityFor(c.event)}>
                  {c.label}
                </button>
                {c.universeName && c.universeName !== c.label && <span className="muted small"> · {c.universeName}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {task.recent.length > 0 && (
        <section>
          <h3>Recent</h3>
          <ul className="activity-list activity-recent">
            {task.recent.slice(0, 8).map((e, i) => (
              <li key={`${e.operationId ?? e.kind}${i}`} className={cx(e.kind === 'operation.failed' && 'is-error')}>
                <span>{e.description}</span>
                <time className="muted small">{ago(e.at)}</time>
              </li>
            ))}
          </ul>
        </section>
      )}
      {background.length > 0 && (
        <section>
          <h3>Other tasks</h3>
          <ul className="activity-list">
            {background.map((t) => (
              <li key={t.id}>
                <button type="button" className="activity-link" onClick={() => focusTask(t.id)}>
                  {t.label}
                </button>
                <span className="muted small"> · {PHASE_WORD[t.state === 'paused' ? 'paused' : t.phase]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function viewActivityFor(e: LiveEvent): void {
  revealEvent(e);
}

/* ---------------------------------------------------------------------------------------------- */
/* Overlay: one highlight, one pointer                                                             */
/* ---------------------------------------------------------------------------------------------- */

interface Shown {
  rect: Rect;
  point: { x: number; y: number } | null;
  variant: 'action' | 'assertion' | 'failed' | 'created';
  tag: string;
  el: Element | null;
  /** What is outlined (for tests): the target kind and id. */
  target: string;
}

const css = (v: string): string => (window.CSS?.escape ? window.CSS.escape(v) : v.replace(/["\\]/g, '\\$&'));

function visibleRect(el: Element): Rect | null {
  // Hidden panels (a collapsed sidebar fades to opacity 0) never get a highlight.
  const check = (el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
  if (check && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return null;
  if (el.closest('[inert], [aria-hidden="true"]')) return null;
  // Panels being hidden (a collapsing sidebar) stop taking pointer events before they finish fading.
  if (getComputedStyle(el).pointerEvents === 'none') return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return null;
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  return { x: r.left, y: r.top, w: r.width, h: r.height, r: radius };
}

function firstVisible(selector: string): { el: Element; rect: Rect } | null {
  const list = Array.from(document.querySelectorAll(selector));
  // Prefer the workspace over side panels when the same object appears in both.
  list.sort((a, b) => Number(Boolean(b.closest('.workspace'))) - Number(Boolean(a.closest('.workspace'))));
  for (const el of list) {
    const rect = visibleRect(el);
    if (rect) return { el, rect };
  }
  return null;
}

const samePage = (a: string, b: string): boolean => a.replace(/^\/+/, '') === b.replace(/^\/+/, '') || (/(^|\/)index\.html?$/i.test(a) && /(^|\/)index\.html?$/i.test(b) && !a.includes('/') && !b.includes('/'));

/** Turn an event's target identity into geometry on screen, or null when it is not visible. */
async function resolve(e: LiveEvent, projectId: string, follow: boolean): Promise<Shown | null> {
  const t = e.target;
  if (!t) return null;
  const key = `${t.kind}:${'path' in t && t.path ? t.path : 'clipId' in t ? t.clipId : 'trackId' in t ? t.trackId : 'assetId' in t ? t.assetId : 'objectId' in t ? t.objectId : 'lineId' in t ? t.lineId : 'stepId' in t ? t.stepId : 'id' in t ? (t.id ?? '') : ''}`;
  const variantFor = (assertion = false): Shown['variant'] => (e.kind === 'operation.failed' || (t.kind === 'story-step' && t.ok === false) ? 'failed' : assertion ? 'assertion' : 'action');
  switch (t.kind) {
    case 'code': {
      const uri = `mv://${projectId}/${e.universeId}/${t.path}`;
      const start = t.ranges[0]?.start ?? 1;
      const end = t.ranges[t.ranges.length - 1]?.end ?? start;
      for (const ed of editors) {
        if (ed.uri() !== uri) continue;
        if (follow) ed.reveal(start);
        const rect = ed.lineRect(start, Math.min(end, start + 60));
        if (rect) return { rect, point: null, variant: t.created ? 'created' : 'action', tag: t.created ? `Created ${t.path}` : e.description, el: null, target: key };
      }
      // Not open in an editor: the file in the tree, briefly (only for the universe whose files are shown).
      if (e.universeId && useStudio.getState().selectedLineId !== e.universeId) return null;
      const row = firstVisible(`[data-live="file:${css(t.path)}"]`);
      return row ? { rect: row.rect, point: null, variant: t.created ? 'created' : 'action', tag: t.created ? `Created ${t.path}` : e.description, el: row.el, target: key } : null;
    }
    case 'element':
    case 'story-step':
    case 'locator': {
      const page = t.page;
      const target = t.kind === 'element' ? ({ kind: 'element', id: t.id, path: t.path } as const) : t.locator ? ({ kind: 'locator', locator: t.locator } as const) : null;
      if (!target || page === 'dev-server') return null;
      const candidates = [...previews].filter((p) => p.projectId === projectId && p.ref === `line:${e.universeId}` && samePage(p.page(), page));
      for (const p of candidates) {
        const rect = await p.measure(target, follow);
        if (!rect) continue;
        const assertion = t.kind !== 'element' && t.assertion;
        const tag = t.kind === 'element' ? (t.property ? `${e.description} · ${t.property}` : e.description) : assertion ? 'Checked in the test browser' : `${e.action === 'fill' ? 'Typed' : e.action === 'press' ? 'Pressed a key' : 'Clicked'} in the test browser`;
        const point = e.pointer ? { x: rect.x + Math.min(rect.w * 0.55, 28), y: rect.y + Math.min(rect.h * 0.6, 22) } : null;
        return { rect, point, variant: variantFor(assertion), tag, el: null, target: key };
      }
      return null;
    }
    case 'clip':
    case 'track': {
      const v = useVideo.getState();
      if (v.lineId !== e.universeId || v.sequenceId !== t.sequenceId) return null;
      const hit = t.kind === 'clip' ? firstVisible(`[data-clip-id="${css(t.clipId)}"]`) : firstVisible(`[data-track-id="${css(t.trackId)}"]`);
      return hit ? { rect: hit.rect, point: null, variant: variantFor(), tag: e.description, el: hit.el, target: key } : null;
    }
    case 'asset':
    case 'object': {
      const hit = firstVisible(`[data-live="${t.kind}:${css(t.kind === 'asset' ? t.assetId : t.objectId)}"]`);
      return hit ? { rect: hit.rect, point: null, variant: variantFor(), tag: e.description, el: hit.el, target: key } : null;
    }
    case 'universe': {
      const hit = firstVisible(`[data-live="universe:${css(t.lineId)}"]`);
      return hit ? { rect: hit.rect, point: null, variant: variantFor(), tag: e.universeName ? `${e.description} · ${e.universeName}` : e.description, el: hit.el, target: key } : null;
    }
  }
}

const HOLD_DONE_MS = 1600;
const HOLD_ACTIVE_MS = 4000;
const POINTER_MS = 1400;

export function ActivityOverlay() {
  const visual = useLive((s) => s.visual);
  const projectId = useStudio((s) => s.project?.id ?? null);
  const mode = useStudio((s) => s.settings.activityVisuals);
  const labels = useStudio((s) => s.settings.activityLabels);
  const follow = useStudio((s) => s.settings.followAi);
  const workspace = useStudio((s) => s.workspace);
  const selectedLineId = useStudio((s) => s.selectedLineId);
  const [shown, setShown] = useState<Shown | null>(null);
  const [on, setOn] = useState(false);
  // The pointer keeps its own short moment: a check that follows a click 60 ms later doesn't erase the click.
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [pointerOn, setPointerOn] = useState(false);
  const pointerTimer = useRef(0);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const [pointerMs, setPointerMs] = useState(180);
  const seqRef = useRef(0);
  const onRef = useRef(false);
  onRef.current = on;
  /** The visual the person has already moved past (by typing or clicking): it is not shown again. */
  const dismissed = useRef(0);

  // Resolve (and re-resolve on geometry changes) the current target.
  useEffect(() => {
    if (!visual || !projectId || mode === 'off' || dismissed.current === visual.seq) {
      setOn(false);
      if (mode === 'off' || dismissed.current === visual?.seq) setPointerOn(false);
      return;
    }
    const e = visual.event;
    let alive = true;
    let frame = 0;
    let observed: Element | null = null;
    const ro = new ResizeObserver(() => schedule());
    const mo = new MutationObserver(() => schedule());
    const reduced = document.documentElement.dataset.motion === 'reduced';
    const startedAt = Date.now();
    let pointerShown = false;
    const measure = async (first: boolean): Promise<void> => {
      const seq = ++seqRef.current;
      const next = await resolve(e, projectId, first && follow);
      if (!alive || seq !== seqRef.current) return;
      if (!next) {
        setOn(false);
        return;
      }
      if (first && onRef.current && !reduced) {
        // A different target: fade out, then fade in at the new place (no sliding boxes across surfaces).
        setOn(false);
        await new Promise((r) => setTimeout(r, 110));
        if (!alive || seq !== seqRef.current) return;
      }
      setShown(next);
      setOn(true);
      if (next.el !== observed) {
        if (observed) ro.unobserve(observed);
        observed = next.el;
        if (observed) ro.observe(observed);
      }
      if (next.point) {
        const prev = lastPoint.current;
        const d = prev ? Math.hypot(next.point.x - prev.x, next.point.y - prev.y) : 0;
        // Small moves 140–220 ms, larger ones 220–350 ms.
        setPointerMs(d < 240 ? 140 + Math.round((d / 240) * 80) : Math.min(350, 220 + Math.round(((d - 240) / 900) * 130)));
        lastPoint.current = next.point;
        // Once per event, when its target is first found (a preview may still be loading at first).
        if (!pointerShown && Date.now() - startedAt < POINTER_MS) {
          pointerShown = true;
          setPoint(next.point);
          setPointerOn(true);
          window.clearTimeout(pointerTimer.current);
          pointerTimer.current = window.setTimeout(() => setPointerOn(false), POINTER_MS);
        } else if (pointerShown) setPoint(next.point);
      }
    };
    function schedule(): void {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        void measure(false);
      });
    }
    void measure(true);
    // A page inside a preview can still be settling (its own entrance animations): look again shortly.
    const settle = [260, 720].map((ms) => window.setTimeout(schedule, ms));
    const done = e.kind === 'operation.completed' || e.kind === 'operation.failed' || e.kind.startsWith('task.');
    const hide = window.setTimeout(() => alive && setOn(false), done ? HOLD_DONE_MS : HOLD_ACTIVE_MS);
    // The person comes first: typing or pressing anywhere clears the AI visuals at once.
    const yieldToUser = (ev: Event): void => {
      if (ev.type === 'keydown' && ((ev as KeyboardEvent).key === 'Shift' || (ev as KeyboardEvent).key === 'Control' || (ev as KeyboardEvent).key === 'Meta' || (ev as KeyboardEvent).key === 'Alt')) return;
      alive = false;
      dismissed.current = visual.seq;
      setOn(false);
      window.clearTimeout(pointerTimer.current);
      setPointerOn(false);
    };
    window.addEventListener('keydown', yieldToUser, true);
    window.addEventListener('pointerdown', yieldToUser, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    // Panels that animate into place (a workspace opening, a canvas fitting itself) move the target without a resize or scroll.
    window.addEventListener('transitionend', schedule, true);
    window.addEventListener('animationend', schedule, true);
    window.addEventListener(GEOMETRY_EVENT, schedule);
    const ws = document.querySelector('.shell') ?? document.body;
    mo.observe(ws, { childList: true, subtree: true });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(hide);
      settle.forEach((id) => window.clearTimeout(id));
      window.removeEventListener('keydown', yieldToUser, true);
      window.removeEventListener('pointerdown', yieldToUser, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('transitionend', schedule, true);
      window.removeEventListener('animationend', schedule, true);
      window.removeEventListener(GEOMETRY_EVENT, schedule);
      ro.disconnect();
      mo.disconnect();
    };
    // The person opening the matching resource (workspace, universe) re-resolves the target.
  }, [visual?.seq, projectId, mode, workspace, selectedLineId]);

  useEffect(() => () => window.clearTimeout(pointerTimer.current), []);
  // A pointer belongs to the view it was drawn in.
  useEffect(() => setPointerOn(false), [workspace, selectedLineId]);

  if (mode === 'off' || (!shown && !point)) return null;
  const pad = 3;
  const r = shown?.rect ?? null;
  return (
    <div className="ai-overlay" aria-hidden="true">
      {shown && r && (
        <div
          className={cx('ai-highlight', `is-${shown.variant}`, on && 'is-on')}
          data-target={shown.target}
          style={{ transform: `translate3d(${Math.round(r.x - pad)}px, ${Math.round(r.y - pad)}px, 0)`, width: Math.round(r.w + pad * 2), height: Math.round(r.h + pad * 2), borderRadius: Math.min(14, (r.r ?? 6) + pad) }}
        >
          {mode === 'detailed' && shown.tag && <span className="ai-highlight-tag">{shown.tag}</span>}
        </div>
      )}
      {point && (
        <div className={cx('ai-pointer', pointerOn && 'is-on')} style={{ transform: `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0)`, transitionDuration: `${pointerMs}ms, 160ms` }}>
          <svg width="20" height="24" viewBox="0 0 20 24" aria-hidden="true">
            <path d="M3 2 L3 19 L7.6 15 L10.6 21.6 L13.4 20.4 L10.5 13.9 L16.6 13.6 Z" />
          </svg>
          {labels && <span className="ai-pointer-label">AI</span>}
        </div>
      )}
    </div>
  );
}
