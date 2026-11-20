import type { ContentRef, LineColor, LineView, ProjectView } from '../../shared/types';
import { SHARED_LINE_ID } from '../../shared/types';

export type Viewport = 'desktop' | 'tablet' | 'mobile';
export const VIEWPORTS: Record<Viewport, { width: number; height: number; label: string }> = {
  desktop: { width: 1280, height: 800, label: 'Desktop' },
  tablet: { width: 820, height: 1100, label: 'Tablet' },
  mobile: { width: 390, height: 780, label: 'Mobile' },
};

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function allLines(project: ProjectView | null): LineView[] {
  return project ? [project.shared, ...project.alternatives] : [];
}

export function findLine(project: ProjectView | null, lineId: string): LineView | undefined {
  return allLines(project).find((l) => l.id === lineId);
}

export function lineColorVar(color: LineColor): string {
  return `var(--alt-${color})`;
}

export function refKey(ref: ContentRef): string {
  switch (ref.kind) {
    case 'line':
      return `line:${ref.lineId}`;
    case 'checkpoint':
      return `cp:${ref.checkpointId}:${ref.lineId}`;
    case 'revision':
      return `rev:${ref.revisionId}`;
    case 'proposal':
      return `prop:${ref.proposalId}`;
  }
}

export function sameRef(a: ContentRef | null | undefined, b: ContentRef | null | undefined): boolean {
  return Boolean(a && b && refKey(a) === refKey(b));
}

export function lineRef(lineId: string): ContentRef {
  return { kind: 'line', lineId };
}

export const SHARED = SHARED_LINE_ID;

export function statusText(line: LineView): string {
  if (line.kind === 'shared') return line.hasDraft ? `Unsaved changes in ${plural(line.draftFiles.length, 'file')}` : 'Saved';
  switch (line.status) {
    case 'conflicted':
      return `${plural(line.conflictCount, 'conflict')} to resolve`;
    case 'paused':
      return line.sharedChangesBehind > 0 ? `Paused · ${plural(line.sharedChangesBehind, 'shared change')} waiting` : 'Not following shared changes';
    case 'behind':
      return `${plural(line.sharedChangesBehind, 'shared change')} not applied`;
    case 'updating':
      return 'Updating…';
    default:
      return 'Following shared changes';
  }
}

export function shortStatus(line: LineView): string {
  if (line.kind === 'shared') return line.hasDraft ? 'Unsaved' : 'Shared';
  switch (line.status) {
    case 'conflicted':
      return plural(line.conflictCount, 'conflict');
    case 'paused':
      return 'Paused';
    case 'behind':
      return `${line.sharedChangesBehind} behind`;
    default:
      return 'Following';
  }
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  const wrapped = (...args: A): void => {
    last = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = last;
      last = null;
      if (a) fn(...a);
    }, ms);
  };
  wrapped.flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    const a = last;
    last = null;
    if (a) fn(...a);
  };
  wrapped.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    last = null;
  };
  return wrapped;
}
