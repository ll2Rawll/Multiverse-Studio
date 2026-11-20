/**
 * Where live AI activity can be drawn: open code editors and previews register here so the
 * overlay can turn a target identity (a file's lines, a page element) into screen geometry.
 * Nothing here can change content; previews answer only with rectangles.
 */
import type { Locator } from '../../shared/stories';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius of the target, when known. */
  r?: number;
}

export interface EditorEntry {
  /** `mv://<project>/<universe>/<path>` of the open file, or null. */
  uri(): string | null;
  /** Screen rectangle of lines start..end (1-based), clipped to the editor; null when not visible. */
  lineRect(start: number, end: number): Rect | null;
  reveal(line: number): void;
}

export type MeasureTarget = { kind: 'element'; id: string | null; path: string | null } | { kind: 'locator'; locator: Locator };

export interface PreviewEntry {
  projectId: string;
  /** `line:<id>` and so on (refKey of the content shown). */
  ref: string;
  /** Page shown, relative to the project root. */
  page(): string;
  /** Rectangle of the target in screen coordinates, or null when it is not on the page. */
  measure(target: MeasureTarget, reveal: boolean): Promise<Rect | null>;
}

export const editors = new Set<EditorEntry>();
export const previews = new Set<PreviewEntry>();

/** Something moved without a DOM scroll or resize (a virtual editor scroll, a preview scroll). */
export const GEOMETRY_EVENT = 'mv-geometry';
export function geometryChanged(): void {
  window.dispatchEvent(new Event(GEOMETRY_EVENT));
}

/** Clip a rectangle to a container; null when nothing of it is visible. */
export function clip(r: Rect, box: DOMRect): Rect | null {
  const x1 = Math.max(r.x, box.left);
  const y1 = Math.max(r.y, box.top);
  const x2 = Math.min(r.x + r.w, box.right);
  const y2 = Math.min(r.y + r.h, box.bottom);
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, r: r.r };
}
