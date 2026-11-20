import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { call, errorMessage } from '../lib/api';
import { cx, refKey, VIEWPORTS, type Viewport } from '../lib/util';
import type { ContentRef } from '../../shared/types';
import type { Locator } from '../../shared/stories';
import { geometryChanged, previews, type MeasureTarget, type PreviewEntry, type Rect } from '../live/registry';

/** An element in Design mode: its data-mv-id when it has one, else its index path under <body>. */
export interface DesignTarget {
  id: string | null;
  path: string | null;
}

export interface RuntimeError {
  message: string;
  source: string;
  line: number;
  column: number;
  kind: 'script' | 'resource';
}

/** Scroll-sync groups: frames in a group follow each other's scroll ratio. */
type Listener = (from: string, ratio: number) => void;
const groups = new Map<string, Set<Listener>>();
function subscribe(group: string, listener: Listener): () => void {
  let set = groups.get(group);
  if (!set) groups.set(group, (set = new Set()));
  set.add(listener);
  return () => set!.delete(listener);
}
function publish(group: string, from: string, ratio: number): void {
  for (const l of groups.get(group) ?? []) l(from, ratio);
}

const handleCache = new Map<string, Promise<string>>();
function previewUrl(projectId: string, ref: ContentRef): Promise<string> {
  const key = `${projectId}|${refKey(ref)}`;
  let p = handleCache.get(key);
  if (!p) {
    p = call('preview.open', { projectId, ref }).then((h) => h.url);
    p.catch(() => handleCache.delete(key));
    handleCache.set(key, p);
  }
  return p;
}

export function forgetPreview(projectId: string, ref: ContentRef): void {
  handleCache.delete(`${projectId}|${refKey(ref)}`);
}

let frameSeq = 0;

/**
 * A live preview of project content in a sandboxed iframe with an opaque origin. The
 * page cannot reach the app, Node, IPC or other previews; it can only post messages,
 * which are validated here.
 */
/** A step reported by the preview while recording (untrusted until checked here and by the command). */
export type RecordedStep =
  | { kind: 'click'; target: Locator }
  | { kind: 'fill'; target: Locator; text: string }
  | { kind: 'press'; target: Locator; key: string };

const LOCATOR_KEYS: Record<string, string[]> = { testid: ['value'], 'mv-id': ['value'], role: ['role', 'name'], label: ['name'], placeholder: ['value'], text: ['text'], css: ['value'] };

function parseRecordedStep(raw: unknown): RecordedStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const t = r.target as Record<string, unknown> | undefined;
  if (!t || typeof t.by !== 'string' || !LOCATOR_KEYS[t.by]) return null;
  const target: Record<string, string> = { by: t.by };
  for (const k of LOCATOR_KEYS[t.by]!) {
    if (typeof t[k] !== 'string' || (t[k] as string).length > 300) return null;
    target[k] = t[k] as string;
  }
  if (r.kind === 'click') return { kind: 'click', target: target as unknown as Locator };
  if (r.kind === 'fill' && typeof r.text === 'string') return { kind: 'fill', target: target as unknown as Locator, text: r.text.slice(0, 2000) };
  if (r.kind === 'press' && r.key === 'Enter') return { kind: 'press', target: target as unknown as Locator, key: 'Enter' };
  return null;
}

export function PreviewFrame({
  projectId,
  contentRef,
  version = 0,
  viewport,
  interactive = false,
  title,
  syncGroup,
  pickKeys,
  onPick,
  onPickCancel,
  onRuntimeError,
  onBlockedNavigation,
  className,
  fit = 'width',
  design,
  onDesignSelect,
  onDesignText,
  path,
  record = false,
  onStoryStep,
}: {
  projectId: string;
  contentRef: ContentRef;
  version?: number;
  viewport: Viewport;
  interactive?: boolean;
  title: string;
  syncGroup?: string | null;
  pickKeys?: string[] | null;
  onPick?: (key: string) => void;
  onPickCancel?: () => void;
  onRuntimeError?: (error: RuntimeError) => void;
  onBlockedNavigation?: (url: string) => void;
  className?: string;
  fit?: 'width' | 'contain';
  /** Design mode: clicks select elements instead of following links; double-click edits text. */
  design?: { selected: DesignTarget | null } | null;
  onDesignSelect?: (target: DesignTarget | null, tag: string | null) => void;
  onDesignText?: (target: DesignTarget, text: string) => void;
  /** A page other than the entry page, relative to the project root. */
  path?: string;
  /** Story recording: actions in the page are reported as story steps. */
  record?: boolean;
  onStoryStep?: (step: RecordedStep) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const idRef = useRef(`frame-${++frameSeq}`);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const lastScrollTop = useRef(0);
  const callbacks = useRef({ onPick, onPickCancel, onRuntimeError, onBlockedNavigation, onDesignSelect, onDesignText, onStoryStep });
  callbacks.current = { onPick, onPickCancel, onRuntimeError, onBlockedNavigation, onDesignSelect, onDesignText, onStoryStep };
  const recordRef = useRef(record);
  recordRef.current = record;
  const designRef = useRef(design);
  designRef.current = design;
  const pickRef = useRef(pickKeys);
  pickRef.current = pickKeys;
  const syncRef = useRef(syncGroup);
  syncRef.current = syncGroup;
  const pathRef = useRef(path);
  pathRef.current = path;
  const readyRef = useRef(false);
  const measures = useRef(new Map<number, (r: Rect | null) => void>());
  const measureSeq = useRef(0);

  // Live AI activity: the overlay asks where a named element is; the page answers with a rectangle only.
  useEffect(() => {
    const entry: PreviewEntry = {
      projectId,
      ref: refKey(contentRef),
      page: () => pathRef.current ?? 'index.html',
      measure: (target: MeasureTarget, reveal: boolean) =>
        new Promise<Rect | null>((resolve) => {
          const frame = frameRef.current;
          if (!frame || !readyRef.current) return resolve(null);
          const id = ++measureSeq.current;
          const timer = window.setTimeout(() => {
            measures.current.delete(id);
            resolve(null);
          }, 400);
          measures.current.set(id, (r) => {
            window.clearTimeout(timer);
            measures.current.delete(id);
            const f = frameRef.current;
            if (!r || !f) return resolve(null);
            // The frame is drawn scaled; map its own coordinates to the window.
            const box = f.getBoundingClientRect();
            const k = f.offsetWidth > 0 ? box.width / f.offsetWidth : 1;
            const out = { x: box.left + r.x * k, y: box.top + r.y * k, w: r.w * k, h: r.h * k, r: (r.r ?? 0) * k };
            const host = containerRef.current?.getBoundingClientRect();
            if (!host) return resolve(null);
            const x1 = Math.max(out.x, host.left), y1 = Math.max(out.y, host.top), x2 = Math.min(out.x + out.w, host.right), y2 = Math.min(out.y + out.h, host.bottom);
            resolve(x2 - x1 > 1 && y2 - y1 > 1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1, r: out.r } : null);
          });
          post({ type: 'measure', id, target, reveal });
        }),
    };
    previews.add(entry);
    return () => {
      previews.delete(entry);
    };
  }, [projectId, refKey(contentRef)]);

  useEffect(() => {
    let alive = true;
    setError(null);
    previewUrl(projectId, contentRef)
      .then((u) => alive && setUrl(u))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [projectId, refKey(contentRef)]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const post = (message: Record<string, unknown>): void => {
    try {
      frameRef.current?.contentWindow?.postMessage({ __mv: 1, ...message }, '*');
    } catch {
      // frame not ready
    }
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const data = e.data as Record<string, unknown> | null;
      if (!data || data.__mv !== 1 || typeof data.type !== 'string') return;
      switch (data.type) {
        case 'measure-result': {
          const done = measures.current.get(Number(data.id));
          if (!done) break;
          const r = data.rect as Record<string, unknown> | null;
          const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6 ? v : null);
          const rect = r && typeof r === 'object' ? { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h), r: num(r.r) ?? 0 } : null;
          done(rect && rect.x !== null && rect.y !== null && rect.w !== null && rect.h !== null && rect.w > 0 && rect.h > 0 ? (rect as Rect) : null);
          break;
        }
        case 'ready':
          setReady(true);
          readyRef.current = true;
          geometryChanged();
          if (lastScrollTop.current > 0) post({ type: 'scroll-to', top: lastScrollTop.current });
          if (pickRef.current) post({ type: 'pick', keys: pickRef.current });
          if (designRef.current) post({ type: 'design', on: true, selected: designRef.current.selected });
          if (recordRef.current) post({ type: 'record', on: true });
          break;
        case 'story-step': {
          const step = parseRecordedStep(data.step);
          if (step) callbacks.current.onStoryStep?.(step);
          break;
        }
        case 'design-select': {
          const id = typeof data.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.id) ? data.id : null;
          const path = typeof data.path === 'string' && /^(\d{1,4}(\.\d{1,4}){0,40})?$/.test(data.path) ? data.path : null;
          const tag = typeof data.tag === 'string' ? data.tag.slice(0, 20) : null;
          callbacks.current.onDesignSelect?.(id || path !== null ? { id, path } : null, tag);
          break;
        }
        case 'design-text': {
          const id = typeof data.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.id) ? data.id : null;
          const path = typeof data.path === 'string' && /^(\d{1,4}(\.\d{1,4}){0,40})?$/.test(data.path) ? data.path : null;
          if ((id || path !== null) && typeof data.text === 'string') callbacks.current.onDesignText?.({ id, path }, data.text.slice(0, 5000));
          break;
        }
        case 'scroll': {
          const ratio = Number(data.ratio);
          lastScrollTop.current = Number(data.top) || 0;
          geometryChanged();
          if (syncRef.current && Number.isFinite(ratio)) publish(syncRef.current, idRef.current, Math.min(1, Math.max(0, ratio)));
          break;
        }
        case 'error':
          callbacks.current.onRuntimeError?.({
            message: String(data.message ?? 'Error').slice(0, 500),
            source: String(data.source ?? '').slice(0, 200),
            line: Number(data.line) || 0,
            column: Number(data.column) || 0,
            kind: data.kind === 'resource' ? 'resource' : 'script',
          });
          break;
        case 'picked':
          if (typeof data.key === 'string' && pickRef.current?.includes(data.key)) callbacks.current.onPick?.(data.key);
          break;
        case 'pick-cancel':
          callbacks.current.onPickCancel?.();
          break;
        case 'blocked-navigation':
          callbacks.current.onBlockedNavigation?.(String(data.url ?? '').slice(0, 300));
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!syncGroup) return;
    return subscribe(syncGroup, (from, ratio) => {
      if (from !== idRef.current) post({ type: 'scroll-to', ratio });
    });
  }, [syncGroup]);

  useEffect(() => {
    if (!ready) return;
    if (pickKeys && pickKeys.length > 0) post({ type: 'pick', keys: pickKeys });
    else post({ type: 'pick-stop' });
  }, [ready, pickKeys?.join('|')]);

  useEffect(() => {
    if (!ready) return;
    post(design ? { type: 'design', on: true, selected: design.selected } : { type: 'design', on: false, selected: null });
  }, [ready, design ? `${design.selected?.id ?? ''}|${design.selected?.path ?? ''}` : 'off']);

  useEffect(() => {
    if (ready) post({ type: 'record', on: record });
  }, [ready, record]);

  useEffect(() => {
    setReady(false);
    readyRef.current = false;
  }, [url, version]);

  const vp = VIEWPORTS[viewport];
  const scale = size.width > 0 ? Math.min(1, size.width / vp.width, fit === 'contain' && size.height > 0 ? size.height / vp.height : Infinity) : 1;
  const frameHeight = fit === 'contain' ? vp.height : Math.max(vp.height * 0.6, size.height / scale);
  const page = path && path !== 'index.html' ? path.split('/').map(encodeURIComponent).join('/') : '';
  const src = url ? `${url}${page}${url.includes('?') ? '&' : '?'}v=${version}` : undefined;

  return (
    <div ref={containerRef} className={cx('preview-viewport', interactive && 'is-interactive', className)} data-viewport={viewport}>
      {error && <div className="preview-message">Preview unavailable: {error}</div>}
      {src && size.width > 0 && (
        <iframe
          ref={frameRef}
          key={src}
          src={src}
          title={title}
          // allow-forms lets apps handle submit events; the preview CSP (form-action 'none') still blocks any real form submission.
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          className={cx('preview-iframe', ready && 'is-ready')}
          tabIndex={interactive ? 0 : -1}
          style={{
            width: vp.width,
            height: frameHeight,
            transform: `scale(${scale})`,
            left: fit === 'contain' ? Math.max(0, (size.width - vp.width * scale) / 2) : Math.max(0, (size.width - vp.width * scale) / 2),
          }}
        />
      )}
      {!ready && !error && <div className="preview-loading" aria-hidden="true" />}
    </div>
  );
}
