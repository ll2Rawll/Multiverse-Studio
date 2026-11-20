import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cx } from '../lib/util';

/**
 * A draggable divider with a comfortable hit target. Also operable from the keyboard
 * (arrow keys, Home/End) so resizing never depends on dragging.
 */
export function Splitter({
  orientation = 'vertical',
  value,
  min,
  max,
  onChange,
  onCommit,
  label,
  invert = false,
  step = 16,
  className,
}: {
  orientation?: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  label: string;
  invert?: boolean;
  step?: number;
  className?: string;
}) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const clamp = (v: number): number => Math.min(max, Math.max(min, v));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { pos: orientation === 'vertical' ? e.clientX : e.clientY, value };
    document.body.classList.add('is-resizing', orientation === 'vertical' ? 'resize-x' : 'resize-y');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!start.current) return;
    const delta = (orientation === 'vertical' ? e.clientX : e.clientY) - start.current.pos;
    onChange(clamp(start.current.value + (invert ? -delta : delta)));
  };
  const onPointerUp = (): void => {
    if (!start.current) return;
    start.current = null;
    document.body.classList.remove('is-resizing', 'resize-x', 'resize-y');
    onCommit?.(latest.current);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const dec = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const inc = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    let next: number | null = null;
    if (e.key === dec) next = value + (invert ? step : -step);
    else if (e.key === inc) next = value + (invert ? -step : step);
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next !== null) {
      e.preventDefault();
      const v = clamp(next);
      onChange(v);
      onCommit?.(v);
    }
  };
  return (
    <div
      className={cx('splitter', `splitter-${orientation}`, className)}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKey}
    >
      <span className="splitter-grip" aria-hidden="true" />
    </div>
  );
}
